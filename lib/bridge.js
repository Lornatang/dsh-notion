import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { AsyncLocalStorage } from 'node:async_hooks';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport, StreamableHTTPError } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { UnauthorizedError, auth } from '@modelcontextprotocol/sdk/client/auth.js';
import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';
import { NotionOAuthProvider, CallbackServer, createCloudFetch } from './oauth.js';
import { openInBrowser } from './open-url.js';
import { deferredOutputValidation, validateOutput } from './output-validator.js';
const packageVersion = createRequire(import.meta.url)('../package.json').version;
const MAX_DISCOVERY_BYTES = 8 * 1024 * 1024;
const MAX_SERVER_RESPONSES = 32;
const RATE_WINDOW_MS = 10_000;
const MAX_SSE_EVENTS_PER_WINDOW = 1000;
const MAX_SSE_OPENS_PER_WINDOW = 8;
async function waitForFlight(flight, signal) {
    if (signal.aborted)
        throw new Error('notion: connection cancelled');
    await new Promise((resolve, reject) => {
        const abort = () => { signal.removeEventListener('abort', abort); reject(new Error('notion: connection cancelled')); };
        signal.addEventListener('abort', abort, { once: true });
        void flight.then(() => { signal.removeEventListener('abort', abort); resolve(); }, reject);
        if (signal.aborted)
            abort();
    });
}
export function publicToolName(server, tool) {
    const raw = `mcp__${server}__${tool}`;
    const clean = raw.replace(/[^A-Za-z0-9_-]/g, '_');
    if (raw === clean && clean.length <= 64)
        return clean;
    const suffix = createHash('sha256').update(`${server}\0${tool}`).digest('hex').slice(0, 12);
    return `${clean.slice(0, 51)}_${suffix}`;
}
function display(content) {
    if (!Array.isArray(content))
        return '';
    return content.map((part) => {
        if (!part || typeof part !== 'object')
            return '';
        const block = part;
        return block['type'] === 'text' && typeof block['text'] === 'string' ? block['text'] : `[${String(block['type'] ?? 'unknown')} content]`;
    }).filter(Boolean).join('\n\n');
}
export class NotionBridge {
    #host;
    #options;
    #callback = new CallbackServer();
    #operation = new AsyncLocalStorage();
    #client;
    #tools = new Map();
    #status = 'idle';
    #url;
    #error;
    #work;
    #boot;
    #disconnect;
    #generation = 0;
    #disposed = false;
    #controller = new AbortController();
    #waiters = new Set();
    constructor(host, options) {
        this.#host = host;
        this.#options = options;
        createCloudFetch(new URL(options.url));
    }
    snapshot() {
        return { status: this.#status, authorizationUrl: this.#url, toolCount: this.#tools.size, error: this.#error };
    }
    #setStatus(status) { this.#status = status; this.#notify(); }
    #setUrl(url) { this.#url = url; this.#notify(); }
    #notify() { for (const wake of [...this.#waiters])
        wake(); }
    // Event-driven replacement for fixed-interval polling: resolves as soon as
    // the predicate holds, or when the deadline passes, whichever comes first.
    async #waitState(predicate, timeoutMs) {
        const deadline = Date.now() + timeoutMs;
        while (!predicate()) {
            const remaining = deadline - Date.now();
            if (remaining <= 0)
                return;
            await new Promise((resolve) => {
                const finish = () => { clearTimeout(timer); this.#waiters.delete(finish); resolve(); };
                const timer = setTimeout(finish, remaining);
                this.#waiters.add(finish);
            });
        }
    }
    async start() {
        if (this.#disconnect)
            await this.#disconnect;
        if (this.#disposed)
            return;
        if (this.#boot)
            return this.#boot;
        const generation = this.#generation;
        const boot = (async () => {
            this.#setStatus('connecting');
            await this.#options.store.load();
            if (this.#disposed || generation !== this.#generation)
                return;
            await this.#callback.listen(this.#options.redirectPort);
            if (this.#disposed || generation !== this.#generation)
                return;
            const previous = this.#options.store.current.redirectUri;
            const actual = this.#callback.redirectUri;
            if (previous && previous !== actual)
                await this.#options.store.clear('clientInformation', 'tokens', 'codeVerifier');
            await this.#options.store.patch({ redirectUri: actual });
            if (this.#disposed || generation !== this.#generation)
                return;
            this.#launch(false, generation);
            await this.#waitState(() => this.#status !== 'connecting', 15_000);
        })();
        this.#boot = boot;
        try {
            await boot;
        }
        catch (error) {
            if (!this.#disposed && generation === this.#generation) {
                this.#setStatus('error');
                this.#error = error instanceof Error ? error.message : String(error);
            }
            throw error;
        }
        finally {
            if (this.#boot === boot)
                this.#boot = undefined;
        }
    }
    async authorize() {
        const generation = this.#generation;
        if (this.#disconnect)
            await this.#disconnect;
        if (this.#boot)
            await this.#boot;
        if (generation !== this.#generation || this.#disconnect)
            return this.snapshot();
        if (this.#disposed || this.#status === 'ready')
            return this.snapshot();
        // A failed initial bind must be retried before the SDK registers a redirect URI.
        if (!this.#callback.listening)
            await this.start();
        if (generation !== this.#generation || this.#disposed || this.#disconnect || this.snapshot().status === 'ready')
            return this.snapshot();
        if (this.#status === 'authorizing' && this.#url) {
            if (this.#options.autoOpenBrowser)
                await openInBrowser(this.#url);
            return this.snapshot();
        }
        if (!this.#work) {
            this.#setStatus('connecting');
            this.#error = undefined;
            this.#setUrl(undefined);
            this.#launch(true, this.#generation, true);
        }
        // Wait for a reportable state: the authorization URL is published while
        // the status is still 'connecting', so waking on the URL alone would
        // return a mid-transition snapshot to concurrent callers.
        await this.#waitState(() => this.#status !== 'connecting', 20_000);
        return this.snapshot();
    }
    #launch(open, generation, reset = false) {
        const work = (async () => {
            if (reset) {
                await this.#closeClient();
                if (this.#disposed || generation !== this.#generation)
                    return;
                this.#clearTools();
            }
            await this.#operation.run({}, () => this.#connect(open, generation));
        })().catch(async (error) => {
            try {
                if (!this.#disposed && generation === this.#generation) {
                    this.#setStatus('error');
                    this.#setUrl(undefined);
                    this.#error = error instanceof Error ? error.message : String(error);
                    this.#host.logger.error(`notion: ${this.#error}`);
                    await this.#closeClient();
                    this.#clearTools();
                }
            }
            catch (cleanupError) {
                // A throwing host hook must never become an unhandled rejection that
                // crashes the DSH process, nor break disconnect/dispose awaiting #work.
                try {
                    this.#host.logger.error(`notion: connection cleanup failed: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`);
                }
                catch { /* logger unavailable */ }
            }
        });
        this.#work = work;
        void work.finally(() => { if (this.#work === work)
            this.#work = undefined; }).catch(() => undefined);
    }
    async #connect(open, generation) {
        const check = () => { if (this.#disposed || generation !== this.#generation)
            throw new Error('connection cancelled'); };
        const active = () => !this.#disposed && generation === this.#generation;
        const signal = this.#controller.signal;
        const serverUrl = new URL(this.#options.url);
        const allowLoopbackHttp = createCloudFetch(serverUrl).allowLoopbackHttp;
        let flight;
        const eventTimes = [];
        const sseOpenTimes = [];
        const rateLimit = (times, maximum, message) => {
            const now = Date.now();
            while (times.length && now - times[0] >= RATE_WINDOW_MS)
                times.shift();
            if (times.length >= maximum) {
                const error = new Error(message);
                this.#breakGeneration(generation, error);
                throw error;
            }
            times.push(now);
        };
        const fetch = async (value, init) => {
            const accept = new Headers(init?.headers).get('accept') ?? '';
            const eventStream = (init?.method?.toUpperCase() ?? 'GET') === 'GET' && accept.includes('text/event-stream');
            // A server event stream lives for the connection, not a single tool call.
            const signals = [signal];
            if (!eventStream)
                signals.push(AbortSignal.timeout(this.#options.toolCallTimeoutMs));
            if (init?.signal)
                signals.push(init.signal);
            const combined = AbortSignal.any(signals);
            const operation = this.#operation.getStore();
            if (eventStream) {
                rateLimit(sseOpenTimes, MAX_SSE_OPENS_PER_WINDOW, 'MCP server reopened the event stream too frequently');
            }
            if (operation && accept.includes('text/event-stream')) {
                const authorization = new Headers(init?.headers).get('authorization');
                const tokens = this.#options.store.current.tokens;
                const previous = operation.observedTokens;
                operation.observedTokens = previous && authorization === `Bearer ${previous.access_token}` ? previous
                    : tokens && authorization === `Bearer ${tokens.access_token}` ? tokens : undefined;
            }
            const network = createCloudFetch(serverUrl, {
                onLimit: () => this.#breakGeneration(generation, new Error('MCP response exceeds the byte limit')),
                onEvent: () => rateLimit(eventTimes, MAX_SSE_EVENTS_PER_WINDOW, 'MCP server sent too many events'),
                onStreamEnd: () => {
                    if (operation && init?.method?.toUpperCase() === 'POST' && accept.includes('text/event-stream') && !combined.aborted)
                        operation.responseStreamEnded = true;
                },
            });
            const refresh = init?.body instanceof URLSearchParams && init.body.get('grant_type') === 'refresh_token';
            if (refresh && operation) {
                const target = new URL(value);
                if (target.origin !== serverUrl.origin || target.username || target.password)
                    throw new Error('MCP and OAuth endpoints must use the configured server origin');
                const expected = operation.observedTokens;
                while (flight && flight.owner !== operation)
                    await waitForFlight(flight.done, combined);
                if (!active() || combined.aborted)
                    throw new Error('notion: connection cancelled');
                operation.refreshExpected = expected;
                const current = this.#options.store.current.tokens;
                if (expected && current !== expected) {
                    return new Response(JSON.stringify(current ?? { error: 'invalid_grant' }), { status: current ? 200 : 400, headers: { 'content-type': 'application/json' } });
                }
                if (!flight) {
                    let complete;
                    const done = new Promise((resolve) => { complete = resolve; });
                    const release = () => {
                        if (flight?.owner === operation) {
                            flight = undefined;
                            combined.removeEventListener('abort', release);
                            complete();
                        }
                        if (operation.releaseRefresh === release)
                            operation.releaseRefresh = undefined;
                    };
                    flight = { owner: operation, done };
                    operation.releaseRefresh = release;
                    combined.addEventListener('abort', release, { once: true });
                    if (combined.aborted)
                        release();
                }
                try {
                    return await network.fetch(value, { ...init, signal: combined });
                }
                catch (error) {
                    operation.releaseRefresh?.();
                    throw error;
                }
            }
            return network.fetch(value, { ...init, signal: combined });
        };
        const provider = new NotionOAuthProvider({
            store: this.#options.store, redirectUri: () => this.#callback.redirectUri, allowLoopbackHttp, serverOrigin: serverUrl.origin,
            logger: this.#host.logger, active, onAuthorizationUrl: (url) => { if (active())
                this.#setUrl(url); },
            tokenRead: (tokens) => { const operation = this.#operation.getStore(); if (operation && !operation.observedTokens)
                operation.observedTokens = tokens; },
            refreshExpected: () => this.#operation.getStore()?.refreshExpected,
            authFinished: () => { const operation = this.#operation.getStore(); operation?.releaseRefresh?.(); if (operation)
                operation.refreshExpected = undefined; },
        });
        for (let attempt = 0; attempt < 2; attempt++) {
            check();
            this.#setStatus('connecting');
            this.#error = undefined;
            const client = new Client({ name: 'dsh-notion', version: packageVersion }, { jsonSchemaValidator: deferredOutputValidation });
            client.onclose = () => { if (this.#client === client)
                this.#breakGeneration(generation, new Error('MCP connection closed')); };
            client.onerror = (error) => { if (this.#client === client && this.#status === 'ready' && this.#isConnectionFailure(error))
                this.#breakGeneration(generation, error); };
            const transport = new StreamableHTTPClientTransport(new URL(this.#options.url), { authProvider: provider, fetch });
            const send = transport.send.bind(transport);
            let pendingResponses = 0;
            transport.send = async (message, options) => {
                if (!('id' in message) || 'method' in message)
                    return send(message, options);
                if (pendingResponses >= MAX_SERVER_RESPONSES) {
                    const error = new Error('MCP server sent too many concurrent requests');
                    this.#breakGeneration(generation, error);
                    throw error;
                }
                pendingResponses++;
                try {
                    await send(message, options);
                }
                finally {
                    pendingResponses--;
                }
            };
            try {
                await client.connect(transport, { signal, timeout: this.#options.toolCallTimeoutMs });
                check();
            }
            catch (error) {
                await transport.close().catch(() => undefined);
                check();
                if (!(error instanceof UnauthorizedError) || attempt !== 0)
                    throw error;
                const state = this.#url ? new URL(this.#url).searchParams.get('state') ?? undefined : undefined;
                const waiting = this.#callback.waitForCode(this.#options.authorizationTimeoutMs, state, signal);
                this.#setStatus('authorizing');
                if (open && this.#url && this.#options.autoOpenBrowser)
                    void openInBrowser(this.#url);
                const callback = await waiting;
                check();
                await auth(provider, { serverUrl: this.#options.url, authorizationCode: callback.code, fetchFn: fetch });
                check();
                await this.#options.store.clearIf(active, 'codeVerifier');
                continue;
            }
            this.#client = client;
            await this.#registerTools(client, signal);
            check();
            this.#setUrl(undefined);
            this.#setStatus('ready');
            return;
        }
        throw new Error('Notion authorization did not establish a connection');
    }
    async #registerTools(client, signal) {
        const found = [];
        const seen = new Set();
        let cursor;
        let discoveryBytes = 0;
        do {
            if (seen.size >= 100)
                throw new Error('MCP server returned too many tool pages');
            const page = await client.listTools(cursor ? { cursor } : {}, { signal, timeout: this.#options.toolCallTimeoutMs });
            discoveryBytes += Buffer.byteLength(JSON.stringify(page), 'utf8');
            if (discoveryBytes > MAX_DISCOVERY_BYTES)
                throw new Error('MCP tool discovery exceeds the byte limit');
            if (found.length + page.tools.length > 1000)
                throw new Error('MCP server returned too many tools');
            found.push(...page.tools);
            cursor = page.nextCursor;
            if (cursor && seen.has(cursor))
                throw new Error('MCP server repeated a continuation cursor');
            if (cursor)
                seen.add(cursor);
        } while (cursor);
        const names = new Set();
        for (const tool of found) {
            const name = publicToolName(this.#options.serverName, tool.name);
            if (names.has(name))
                throw new Error('MCP server returned duplicate tool names');
            names.add(name);
        }
        this.#clearTools();
        try {
            for (const tool of found) {
                const name = publicToolName(this.#options.serverName, tool.name);
                const definition = {
                    name, description: tool.description ?? '', parameters: tool.inputSchema,
                    output: {
                        schema: { type: 'object', properties: { content: { type: 'array', items: {} } }, required: ['content'], additionalProperties: false },
                        render: (_args, result) => [{ type: 'text', text: display(result?.content) }],
                    },
                    execute: async (args, context) => {
                        const combined = context.signal ? AbortSignal.any([signal, context.signal]) : signal;
                        const result = await this.#request(client, combined, () => client.callTool({ name: tool.name, arguments: (typeof args === 'object' && args !== null ? args : {}) }, undefined, { timeout: this.#options.toolCallTimeoutMs, signal: combined }));
                        if (result.isError)
                            throw new Error(display(result.content) || 'Notion MCP tool failed');
                        if (tool.outputSchema) {
                            if (result.structuredContent === undefined)
                                throw new Error(`notion: tool ${tool.name} did not return structured output`);
                            await validateOutput(tool.outputSchema, result.structuredContent, this.#options.toolCallTimeoutMs, combined);
                        }
                        const content = Array.isArray(result.content) && result.content.length ? result.content : result.structuredContent === undefined ? [] : [{ type: 'text', text: JSON.stringify(result.structuredContent) }];
                        return { content };
                    },
                };
                this.#tools.set(name, { raw: tool.name, dispose: this.#host.register(definition) });
            }
            if (client.getServerCapabilities()?.resources)
                this.#registerResourceTools(client, signal);
        }
        catch (error) {
            this.#clearTools();
            throw error;
        }
    }
    #registerResourceTools(client, connectionSignal) {
        const schema = { type: 'object', properties: { cursor: { type: 'string', description: 'Continuation cursor from a previous response' } }, additionalProperties: false };
        const define = (raw, description, parameters, action) => {
            const name = publicToolName(this.#options.serverName, raw);
            if (this.#tools.has(name))
                throw new Error(`MCP resource tool name conflicts with a server tool: ${name}`);
            const definition = {
                name, description, parameters,
                output: {
                    schema: { type: 'object', properties: { content: { type: 'array', items: {} } }, required: ['content'], additionalProperties: false },
                    render: (_args, result) => [{ type: 'text', text: display(result?.content) }],
                },
                execute: async (args, context) => {
                    const signal = context.signal ? AbortSignal.any([connectionSignal, context.signal]) : connectionSignal;
                    const value = await this.#request(client, signal, () => action(args ?? {}, signal));
                    return { content: [{ type: 'text', text: JSON.stringify(value) }] };
                },
            };
            this.#tools.set(name, { raw, dispose: this.#host.register(definition) });
        };
        const options = (signal) => ({ timeout: this.#options.toolCallTimeoutMs, signal });
        const cursor = (args) => typeof args['cursor'] === 'string' ? { cursor: args['cursor'] } : {};
        define('dsh_list_resources', 'List available Notion MCP resources. Use the returned cursor to fetch the next page.', schema, async (args, signal) => client.listResources(cursor(args), options(signal)));
        define('dsh_list_resource_templates', 'List available Notion MCP resource URI templates.', schema, async (args, signal) => client.listResourceTemplates(cursor(args), options(signal)));
        define('dsh_read_resource', 'Read a Notion MCP resource by URI, including documentation referenced by Notion tools.', { type: 'object', properties: { uri: { type: 'string', description: 'The exact MCP resource URI' } }, required: ['uri'], additionalProperties: false }, async (args, signal) => {
            if (typeof args['uri'] !== 'string' || !args['uri'])
                throw new Error('A resource URI is required');
            return client.readResource({ uri: args['uri'] }, options(signal));
        });
    }
    async disconnect() {
        if (!this.#disconnect) {
            const work = this.#disconnectNow();
            this.#disconnect = work;
            void work.finally(() => { if (this.#disconnect === work)
                this.#disconnect = undefined; }).catch(() => undefined);
        }
        await this.#disconnect;
        return this.snapshot();
    }
    async #disconnectNow() {
        this.#generation++;
        this.#setStatus('idle');
        this.#controller.abort();
        this.#callback.cancelWait();
        await this.#boot?.catch(() => undefined);
        this.#callback.cancelWait();
        await this.#work;
        await this.#closeClient();
        this.#clearTools();
        try {
            await this.#options.store.destroy();
        }
        finally {
            this.#controller = new AbortController();
            this.#setUrl(undefined);
            this.#error = undefined;
        }
    }
    async dispose() {
        if (this.#disposed)
            return;
        this.#disposed = true;
        await this.#disconnect;
        this.#generation++;
        this.#setStatus('idle');
        this.#controller.abort();
        this.#callback.cancelWait();
        await this.#boot?.catch(() => undefined);
        this.#callback.cancelWait();
        await this.#work;
        await this.#closeClient();
        this.#clearTools();
        await this.#callback.close();
    }
    async #closeClient() {
        const client = this.#client;
        this.#client = undefined;
        await client?.close().catch(() => undefined);
    }
    #clearTools() {
        let failure;
        for (const value of this.#tools.values()) {
            try {
                value.dispose();
            }
            catch (error) {
                failure ??= error;
            }
        }
        this.#tools.clear();
        if (failure !== undefined) {
            try {
                this.#host.logger.error(`notion: tool cleanup failed: ${failure instanceof Error ? failure.message : String(failure)}`);
            }
            catch { /* logger unavailable */ }
        }
    }
    #isConnectionFailure(error) {
        return error instanceof TypeError || error instanceof UnauthorizedError || error instanceof StreamableHTTPError ||
            (error instanceof McpError && error.code === ErrorCode.ConnectionClosed) ||
            error.message.startsWith('Maximum reconnection attempts (');
    }
    async #request(client, signal, action) {
        const operation = {};
        try {
            return await this.#operation.run(operation, action);
        }
        catch (error) {
            if (!signal.aborted && operation.responseStreamEnded && this.#client === client && error instanceof McpError && error.code === ErrorCode.RequestTimeout) {
                this.#breakGeneration(this.#generation, new Error('MCP request timed out; reconnect to try again'));
            }
            throw error;
        }
    }
    #breakGeneration(generation, error) {
        if (this.#disposed || generation !== this.#generation)
            return;
        this.#generation++;
        this.#controller.abort();
        this.#controller = new AbortController();
        this.#callback.cancelWait();
        this.#setStatus('error');
        this.#error = error.message;
        this.#setUrl(undefined);
        this.#clearTools();
        void this.#closeClient();
    }
}

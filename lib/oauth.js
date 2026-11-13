import { randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
function isLoopback(url) {
    return ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
}
function secureUrl(url, allowLoopbackHttp) {
    if (url.username || url.password || (url.protocol !== 'https:' && !(allowLoopbackHttp && url.protocol === 'http:' && isLoopback(url)))) {
        throw new Error('Cloud and OAuth endpoints must use HTTPS without embedded credentials');
    }
}
/** Restrict every discovered OAuth and MCP endpoint, including redirect targets. */
export function createCloudFetch(serverUrl) {
    const allowLoopbackHttp = serverUrl.protocol === 'http:' && isLoopback(serverUrl);
    secureUrl(serverUrl, allowLoopbackHttp);
    return {
        allowLoopbackHttp,
        fetch: async (value, init) => {
            const target = new URL(value);
            secureUrl(target, allowLoopbackHttp);
            if (target.origin !== serverUrl.origin)
                throw new Error('MCP and OAuth endpoints must use the configured server origin');
            // The SDK performs its own same-origin redirect handling. Never let fetch
            // follow a redirect before its next target has passed the check above.
            return await globalThis.fetch(value, { ...init, redirect: init?.redirect === 'error' ? 'error' : 'manual' });
        },
    };
}
export class CallbackServer {
    #server;
    #port = 0;
    #pending;
    get redirectUri() { return `http://127.0.0.1:${this.#port}/callback`; }
    async listen(preferredPort) {
        if (this.#server)
            return this.#port;
        const server = createServer((req, res) => {
            let url;
            try {
                url = new URL(req.url ?? '/', 'http://127.0.0.1');
            }
            catch {
                res.writeHead(400).end();
                return;
            }
            if (req.method !== 'GET' || url.pathname !== '/callback') {
                res.writeHead(404).end();
                return;
            }
            const pending = this.#pending;
            const state = url.searchParams.get('state');
            if (!pending || state !== pending.state) {
                this.#reply(res, false, 'Authorization state is invalid or expired.');
                return;
            }
            const error = url.searchParams.get('error');
            if (error) {
                const detail = url.searchParams.get('error_description') || error;
                this.#reply(res, false, `Authorization failed: ${detail}`);
                pending.complete(new Error(`authorization failed: ${detail}`));
                return;
            }
            const code = url.searchParams.get('code');
            if (!code) {
                this.#reply(res, false, 'Authorization code is missing.');
                pending.complete(new Error('authorization callback carried no code'));
                return;
            }
            this.#reply(res, true, 'Authorization complete. Return to DSH.');
            pending.complete({ code, state });
        });
        const bind = (port) => new Promise((resolve, reject) => {
            const failed = (error) => reject(error);
            server.once('error', failed);
            server.listen(port, '127.0.0.1', () => { server.off('error', failed); resolve(server.address().port); });
        });
        try {
            this.#port = await bind(preferredPort);
        }
        catch (error) {
            if (error.code !== 'EADDRINUSE' || preferredPort === 0)
                throw error;
            this.#port = await bind(0);
        }
        server.on('error', () => this.cancelWait());
        this.#server = server;
        return this.#port;
    }
    waitForCode(timeoutMs, state, signal) {
        if (!state)
            return Promise.reject(new Error('authorization URL did not contain state'));
        this.cancelWait();
        return new Promise((resolve, reject) => {
            let timer;
            const done = (value) => {
                clearTimeout(timer);
                signal?.removeEventListener('abort', abort);
                this.#pending = undefined;
                if (value instanceof Error)
                    reject(value);
                else
                    resolve(value);
            };
            const abort = () => done(new Error('authorization cancelled'));
            this.#pending = { state, complete: done };
            timer = setTimeout(() => done(new Error('authorization timed out')), timeoutMs);
            timer.unref();
            if (signal?.aborted)
                abort();
            else
                signal?.addEventListener('abort', abort, { once: true });
        });
    }
    cancelWait() { this.#pending?.complete(new Error('authorization cancelled')); }
    async close() {
        this.cancelWait();
        const server = this.#server;
        this.#server = undefined;
        if (!server)
            return;
        await new Promise((resolve) => { server.close(() => resolve()); server.closeAllConnections?.(); });
    }
    #reply(res, ok, text) {
        const safe = text.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c);
        res.writeHead(ok ? 200 : 400, {
            'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store',
            'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'",
            'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer',
        });
        res.end(`<!doctype html><meta charset="utf-8"><title>DSH Notion</title><p>${safe}</p>`);
    }
}
export class NotionOAuthProvider {
    #store;
    #redirect;
    #onUrl;
    #allowLoopbackHttp;
    #serverOrigin;
    constructor(options) {
        this.#store = options.store;
        this.#redirect = options.redirectUri;
        this.#onUrl = options.onAuthorizationUrl;
        this.#allowLoopbackHttp = options.allowLoopbackHttp;
        this.#serverOrigin = options.serverOrigin;
    }
    get redirectUrl() { return this.#redirect(); }
    get clientMetadata() {
        return { client_name: 'DSH Notion', redirect_uris: [this.redirectUrl], grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], token_endpoint_auth_method: 'none' };
    }
    state() { return randomBytes(16).toString('hex'); }
    clientInformation() { return this.#store.current.clientInformation; }
    async saveClientInformation(value) { await this.#store.patch({ clientInformation: value }); }
    tokens() { return this.#store.current.tokens; }
    async saveTokens(value) { await this.#store.patch({ tokens: value }); }
    redirectToAuthorization(url) {
        secureUrl(url, this.#allowLoopbackHttp);
        if (url.origin !== this.#serverOrigin)
            throw new Error('MCP and OAuth endpoints must use the configured server origin');
        this.#onUrl(url.href);
    }
    async saveCodeVerifier(value) { await this.#store.patch({ codeVerifier: value }); }
    codeVerifier() {
        const value = this.#store.current.codeVerifier;
        if (!value)
            throw new Error('missing PKCE verifier');
        return value;
    }
    async invalidateCredentials(scope) {
        if (scope === 'all')
            await this.#store.clear('tokens', 'clientInformation', 'codeVerifier');
        else if (scope === 'client')
            await this.#store.clear('clientInformation');
        else if (scope === 'tokens')
            await this.#store.clear('tokens');
        else if (scope === 'verifier')
            await this.#store.clear('codeVerifier');
    }
}

import { createHash } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { UnauthorizedError, auth } from '@modelcontextprotocol/sdk/client/auth.js'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import { NotionOAuthProvider, CallbackServer, createCloudFetch, type Logger } from './oauth.js'
import type { FetchLike } from '@modelcontextprotocol/sdk/shared/transport.js'
import { openInBrowser } from './open-url.js'
import type { SessionStore } from './store.js'

export interface BridgeHost { register(definition: ToolDefinition): () => void; logger: Logger }
export interface BridgeOptions {
  serverName: string; url: string; redirectPort: number; toolCallTimeoutMs: number
  authorizationTimeoutMs: number; autoOpenBrowser: boolean; store: SessionStore
}
export type BridgeStatus = 'idle' | 'connecting' | 'authorizing' | 'ready' | 'error'
export interface BridgeSnapshot {
  status: BridgeStatus
  authorizationUrl: string | undefined
  toolCount: number
  error: string | undefined
}

export function publicToolName(server: string, tool: string): string {
  const raw = `mcp__${server}__${tool}`
  const clean = raw.replace(/[^A-Za-z0-9_-]/g, '_')
  if (raw === clean && clean.length <= 64) return clean
  const suffix = createHash('sha256').update(`${server}\0${tool}`).digest('hex').slice(0, 12)
  return `${clean.slice(0, 51)}_${suffix}`
}

function display(content: unknown): string {
  if (!Array.isArray(content)) return ''
  return content.map((part: unknown) => {
    if (!part || typeof part !== 'object') return ''
    const block = part as Record<string, unknown>
    return block['type'] === 'text' && typeof block['text'] === 'string' ? block['text'] : `[${String(block['type'] ?? 'unknown')} content]`
  }).filter(Boolean).join('\n\n')
}

export class NotionBridge {
  readonly #host: BridgeHost
  readonly #options: BridgeOptions
  readonly #callback = new CallbackServer()
  readonly #provider: NotionOAuthProvider
  readonly #fetch: FetchLike
  #client?: Client
  #tools = new Map<string, { raw: string; dispose: () => void }>()
  #status: BridgeStatus = 'idle'
  #url?: string
  #error?: string
  #work?: Promise<void>
  #boot?: Promise<void>
  #generation = 0
  #disposed = false
  #controller = new AbortController()

  constructor(host: BridgeHost, options: BridgeOptions) {
    this.#host = host
    this.#options = options
    const network = createCloudFetch(new URL(options.url))
    this.#fetch = (value, init) => {
      const signals = [this.#controller.signal, AbortSignal.timeout(options.toolCallTimeoutMs)]
      if (init?.signal) signals.push(init.signal)
      return network.fetch(value, { ...init, signal: AbortSignal.any(signals) })
    }
    this.#provider = new NotionOAuthProvider({ store: options.store, redirectUri: () => this.#callback.redirectUri, allowLoopbackHttp: network.allowLoopbackHttp, serverOrigin: new URL(options.url).origin, logger: host.logger, onAuthorizationUrl: (url) => { this.#url = url } })
  }

  snapshot(): BridgeSnapshot {
    return { status: this.#status, authorizationUrl: this.#url, toolCount: this.#tools.size, error: this.#error }
  }

  async start(): Promise<void> {
    if (this.#boot) return this.#boot
    const generation = this.#generation
    const boot = (async () => {
      this.#status = 'connecting'
      await this.#options.store.load()
      if (this.#disposed || generation !== this.#generation) return
      await this.#callback.listen(this.#options.redirectPort)
      if (this.#disposed || generation !== this.#generation) return
      const previous = this.#options.store.current.redirectUri
      const actual = this.#callback.redirectUri
      if (previous && previous !== actual) await this.#options.store.clear('clientInformation', 'tokens', 'codeVerifier')
      await this.#options.store.patch({ redirectUri: actual })
      if (this.#disposed || generation !== this.#generation) return
      this.#launch(false, generation)
      for (let i = 0; i < 600 && this.#status === 'connecting'; i++) await delay(25)
    })()
    this.#boot = boot
    try { await boot } catch (error) {
      if (!this.#disposed && generation === this.#generation) {
        this.#status = 'error'
        this.#error = error instanceof Error ? error.message : String(error)
      }
      throw error
    } finally { if (this.#boot === boot) this.#boot = undefined }
  }

  async authorize(): Promise<BridgeSnapshot> {
    await this.#boot
    if (this.#disposed || this.#status === 'ready') return this.snapshot()
    if (this.#status === 'authorizing' && this.#url) {
      if (this.#options.autoOpenBrowser) await openInBrowser(this.#url)
      return this.snapshot()
    }
    if (!this.#work) {
      await this.#closeClient()
      this.#clearTools()
      this.#url = undefined
      this.#launch(true, this.#generation)
    }
    for (let i = 0; i < 800 && this.#status === 'connecting' && !this.#url; i++) await delay(25)
    return this.snapshot()
  }

  #launch(open: boolean, generation: number): void {
    const work = this.#connect(open, generation).catch((error: unknown) => {
      if (!this.#disposed && generation === this.#generation) {
        this.#status = 'error'
        this.#error = error instanceof Error ? error.message : String(error)
        this.#host.logger.error(`notion: ${this.#error}`)
      }
    })
    this.#work = work
    void work.finally(() => { if (this.#work === work) this.#work = undefined })
  }

  async #connect(open: boolean, generation: number): Promise<void> {
    const check = (): void => { if (this.#disposed || generation !== this.#generation) throw new Error('connection cancelled') }
    for (let attempt = 0; attempt < 2; attempt++) {
      check()
      this.#status = 'connecting'
      this.#error = undefined
      const client = new Client({ name: 'dsh-notion', version: '0.1.0' })
      const transport = new StreamableHTTPClientTransport(new URL(this.#options.url), { authProvider: this.#provider, fetch: this.#fetch })
      try { await client.connect(transport); check() }
      catch (error) {
        await transport.close().catch(() => undefined)
        check()
        if (!(error instanceof UnauthorizedError) || attempt !== 0) throw error
        const state = this.#url ? new URL(this.#url).searchParams.get('state') ?? undefined : undefined
        const waiting = this.#callback.waitForCode(this.#options.authorizationTimeoutMs, state)
        this.#status = 'authorizing'
        if (open && this.#url && this.#options.autoOpenBrowser) void openInBrowser(this.#url)
        const callback = await waiting
        check()
        await auth(this.#provider, { serverUrl: this.#options.url, authorizationCode: callback.code, fetchFn: this.#fetch })
        check()
        await this.#options.store.clear('codeVerifier')
        continue
      }
      this.#client = client
      await this.#registerTools(client)
      check()
      this.#url = undefined
      this.#status = 'ready'
      return
    }
    throw new Error('Notion authorization did not establish a connection')
  }

  async #registerTools(client: Client): Promise<void> {
    const found: Array<{ name: string; description?: string; inputSchema: unknown }> = []
    const seen = new Set<string>()
    let cursor: string | undefined
    do {
      if (seen.size >= 100) throw new Error('MCP server returned too many tool pages')
      const page = await client.listTools(cursor ? { cursor } : {})
      found.push(...page.tools)
      if (found.length > 1000) throw new Error('MCP server returned too many tools')
      cursor = page.nextCursor
      if (cursor && seen.has(cursor)) throw new Error('MCP server repeated a continuation cursor')
      if (cursor) seen.add(cursor)
    } while (cursor)
    const names = new Set<string>()
    for (const tool of found) {
      const name = publicToolName(this.#options.serverName, tool.name)
      if (names.has(name)) throw new Error('MCP server returned duplicate tool names')
      names.add(name)
    }
    this.#clearTools()
    try {
      for (const tool of found) {
        const name = publicToolName(this.#options.serverName, tool.name)
        const definition = {
          name, description: tool.description ?? '', parameters: tool.inputSchema,
          output: {
            schema: { type: 'object', properties: { content: { type: 'array', items: {} } }, required: ['content'], additionalProperties: false },
            render: (_args: unknown, result: unknown) => [{ type: 'text', text: display((result as { content?: unknown })?.content) }],
          },
          execute: async (args: unknown, context: { signal?: AbortSignal }) => {
            const result = await client.callTool({ name: tool.name, arguments: (typeof args === 'object' && args !== null ? args : {}) as Record<string, unknown> }, undefined, { timeout: this.#options.toolCallTimeoutMs, signal: context.signal })
            if (result.isError) throw new Error(display(result.content) || 'Notion MCP tool failed')
            const content = Array.isArray(result.content) && result.content.length ? result.content : result.structuredContent === undefined ? [] : [{ type: 'text', text: JSON.stringify(result.structuredContent) }]
            return { content }
          },
        } as ToolDefinition
        this.#tools.set(name, { raw: tool.name, dispose: this.#host.register(definition) })
      }
      if (client.getServerCapabilities()?.resources) this.#registerResourceTools(client)
    } catch (error) { this.#clearTools(); throw error }
  }

  #registerResourceTools(client: Client): void {
    const schema = { type: 'object', properties: { cursor: { type: 'string', description: 'Continuation cursor from a previous response' } }, additionalProperties: false }
    const define = (raw: string, description: string, parameters: unknown, action: (args: Record<string, unknown>, signal?: AbortSignal) => Promise<unknown>): void => {
      const name = publicToolName(this.#options.serverName, raw)
      if (this.#tools.has(name)) throw new Error(`MCP resource tool name conflicts with a server tool: ${name}`)
      const definition = {
        name, description, parameters,
        output: {
          schema: { type: 'object', properties: { content: { type: 'array', items: {} } }, required: ['content'], additionalProperties: false },
          render: (_args: unknown, result: unknown) => [{ type: 'text', text: display((result as { content?: unknown })?.content) }],
        },
        execute: async (args: Record<string, unknown>, context: { signal?: AbortSignal }) => {
          const value = await action(args ?? {}, context.signal)
          return { content: [{ type: 'text', text: JSON.stringify(value) }] }
        },
      } as ToolDefinition
      this.#tools.set(name, { raw, dispose: this.#host.register(definition) })
    }
    const options = (signal?: AbortSignal) => ({ timeout: this.#options.toolCallTimeoutMs, signal })
    const cursor = (args: Record<string, unknown>) => typeof args['cursor'] === 'string' ? { cursor: args['cursor'] } : {}
    define('dsh_list_resources', 'List available Notion MCP resources. Use the returned cursor to fetch the next page.', schema,
      async (args, signal) => client.listResources(cursor(args), options(signal)))
    define('dsh_list_resource_templates', 'List available Notion MCP resource URI templates.', schema,
      async (args, signal) => client.listResourceTemplates(cursor(args), options(signal)))
    define('dsh_read_resource', 'Read a Notion MCP resource by URI, including documentation referenced by Notion tools.',
      { type: 'object', properties: { uri: { type: 'string', description: 'The exact MCP resource URI' } }, required: ['uri'], additionalProperties: false },
      async (args, signal) => {
        if (typeof args['uri'] !== 'string' || !args['uri']) throw new Error('A resource URI is required')
        return client.readResource({ uri: args['uri'] }, options(signal))
      })
  }

  async disconnect(): Promise<BridgeSnapshot> {
    this.#generation++
    this.#status = 'idle'
    this.#controller.abort()
    this.#callback.cancelWait()
    await this.#boot?.catch(() => undefined)
    this.#callback.cancelWait()
    await this.#work
    await this.#closeClient()
    this.#clearTools()
    try { await this.#options.store.destroy() }
    finally {
      this.#controller = new AbortController()
      this.#url = undefined
      this.#error = undefined
    }
    return this.snapshot()
  }
  async dispose(): Promise<void> {
    if (this.#disposed) return
    this.#disposed = true
    this.#generation++
    this.#status = 'idle'
    this.#controller.abort()
    this.#callback.cancelWait()
    await this.#boot?.catch(() => undefined)
    this.#callback.cancelWait()
    await this.#work
    await this.#closeClient()
    this.#clearTools()
    await this.#callback.close()
  }
  async #closeClient(): Promise<void> {
    const client = this.#client
    this.#client = undefined
    await client?.close().catch(() => undefined)
  }
  #clearTools(): void {
    for (const value of this.#tools.values()) value.dispose()
    this.#tools.clear()
  }
}

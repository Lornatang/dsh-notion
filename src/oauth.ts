import { randomBytes } from 'node:crypto'
import { createServer, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js'
import type { FetchLike } from '@modelcontextprotocol/sdk/shared/transport.js'
import type { OAuthClientInformationMixed, OAuthClientMetadata, OAuthTokens } from '@modelcontextprotocol/sdk/shared/auth.js'
import type { SessionStore } from './store.js'

export interface Logger { info(message: string): void; warn(message: string): void; error(message: string): void }
export interface AuthorizationCallback { code: string; state: string | undefined }

function isLoopback(url: URL): boolean {
  return ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
}

function secureUrl(url: URL, allowLoopbackHttp: boolean): void {
  if (url.username || url.password || (url.protocol !== 'https:' && !(allowLoopbackHttp && url.protocol === 'http:' && isLoopback(url)))) {
    throw new Error('Cloud and OAuth endpoints must use HTTPS without embedded credentials')
  }
}

/** Restrict every discovered OAuth and MCP endpoint, including redirect targets. */
export function createCloudFetch(serverUrl: URL): { fetch: FetchLike; allowLoopbackHttp: boolean } {
  const allowLoopbackHttp = serverUrl.protocol === 'http:' && isLoopback(serverUrl)
  secureUrl(serverUrl, allowLoopbackHttp)
  return {
    allowLoopbackHttp,
    fetch: async (value, init) => {
      const target = new URL(value)
      secureUrl(target, allowLoopbackHttp)
      if (target.origin !== serverUrl.origin) throw new Error('MCP and OAuth endpoints must use the configured server origin')
      // The SDK performs its own same-origin redirect handling. Never let fetch
      // follow a redirect before its next target has passed the check above.
      return await globalThis.fetch(value, { ...init, redirect: init?.redirect === 'error' ? 'error' : 'manual' })
    },
  }
}

type Pending = { state: string; complete: (value: AuthorizationCallback | Error) => void }

export class CallbackServer {
  #server?: Server
  #port = 0
  #pending?: Pending

  get redirectUri(): string { return `http://127.0.0.1:${this.#port}/callback` }

  async listen(preferredPort: number): Promise<number> {
    if (this.#server) return this.#port
    const server = createServer((req, res) => {
      let url: URL
      try { url = new URL(req.url ?? '/', 'http://127.0.0.1') } catch { res.writeHead(400).end(); return }
      if (req.method !== 'GET' || url.pathname !== '/callback') { res.writeHead(404).end(); return }
      const pending = this.#pending
      const state = url.searchParams.get('state')
      if (!pending || state !== pending.state) { this.#reply(res, false, 'Authorization state is invalid or expired.'); return }
      const error = url.searchParams.get('error')
      if (error) {
        const detail = url.searchParams.get('error_description') || error
        this.#reply(res, false, `Authorization failed: ${detail}`)
        pending.complete(new Error(`authorization failed: ${detail}`))
        return
      }
      const code = url.searchParams.get('code')
      if (!code) { this.#reply(res, false, 'Authorization code is missing.'); pending.complete(new Error('authorization callback carried no code')); return }
      this.#reply(res, true, 'Authorization complete. Return to DSH.')
      pending.complete({ code, state })
    })
    const bind = (port: number): Promise<number> => new Promise((resolve, reject) => {
      const failed = (error: Error): void => reject(error)
      server.once('error', failed)
      server.listen(port, '127.0.0.1', () => { server.off('error', failed); resolve((server.address() as AddressInfo).port) })
    })
    try { this.#port = await bind(preferredPort) }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EADDRINUSE' || preferredPort === 0) throw error
      this.#port = await bind(0)
    }
    server.on('error', () => this.cancelWait())
    this.#server = server
    return this.#port
  }

  waitForCode(timeoutMs: number, state: string | undefined, signal?: AbortSignal): Promise<AuthorizationCallback> {
    if (!state) return Promise.reject(new Error('authorization URL did not contain state'))
    this.cancelWait()
    return new Promise((resolve, reject) => {
      let timer: NodeJS.Timeout
      const done = (value: AuthorizationCallback | Error): void => {
        clearTimeout(timer)
        signal?.removeEventListener('abort', abort)
        this.#pending = undefined
        if (value instanceof Error) reject(value)
        else resolve(value)
      }
      const abort = (): void => done(new Error('authorization cancelled'))
      this.#pending = { state, complete: done }
      timer = setTimeout(() => done(new Error('authorization timed out')), timeoutMs)
      timer.unref()
      if (signal?.aborted) abort()
      else signal?.addEventListener('abort', abort, { once: true })
    })
  }

  cancelWait(): void { this.#pending?.complete(new Error('authorization cancelled')) }

  async close(): Promise<void> {
    this.cancelWait()
    const server = this.#server
    this.#server = undefined
    if (!server) return
    await new Promise<void>((resolve) => { server.close(() => resolve()); server.closeAllConnections?.() })
  }

  #reply(res: ServerResponse, ok: boolean, text: string): void {
    const safe = text.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c)
    res.writeHead(ok ? 200 : 400, {
      'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store',
      'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'",
      'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer',
    })
    res.end(`<!doctype html><meta charset="utf-8"><title>DSH Notion</title><p>${safe}</p>`)
  }
}

export class NotionOAuthProvider implements OAuthClientProvider {
  readonly #store: SessionStore
  readonly #redirect: () => string
  readonly #onUrl: (url: string) => void
  readonly #allowLoopbackHttp: boolean
  readonly #serverOrigin: string

  constructor(options: { store: SessionStore; redirectUri: () => string; onAuthorizationUrl: (url: string) => void; allowLoopbackHttp: boolean; serverOrigin: string; logger: Logger }) {
    this.#store = options.store
    this.#redirect = options.redirectUri
    this.#onUrl = options.onAuthorizationUrl
    this.#allowLoopbackHttp = options.allowLoopbackHttp
    this.#serverOrigin = options.serverOrigin
  }
  get redirectUrl(): string { return this.#redirect() }
  get clientMetadata(): OAuthClientMetadata {
    return { client_name: 'DSH Notion', redirect_uris: [this.redirectUrl], grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], token_endpoint_auth_method: 'none' }
  }
  state(): string { return randomBytes(16).toString('hex') }
  clientInformation(): OAuthClientInformationMixed | undefined { return this.#store.current.clientInformation }
  async saveClientInformation(value: OAuthClientInformationMixed): Promise<void> { await this.#store.patch({ clientInformation: value }) }
  tokens(): OAuthTokens | undefined { return this.#store.current.tokens }
  async saveTokens(value: OAuthTokens): Promise<void> { await this.#store.patch({ tokens: value }) }
  redirectToAuthorization(url: URL): void {
    secureUrl(url, this.#allowLoopbackHttp)
    if (url.origin !== this.#serverOrigin) throw new Error('MCP and OAuth endpoints must use the configured server origin')
    this.#onUrl(url.href)
  }
  async saveCodeVerifier(value: string): Promise<void> { await this.#store.patch({ codeVerifier: value }) }
  codeVerifier(): string {
    const value = this.#store.current.codeVerifier
    if (!value) throw new Error('missing PKCE verifier')
    return value
  }
  async invalidateCredentials(scope: 'all' | 'client' | 'tokens' | 'verifier' | 'discovery'): Promise<void> {
    if (scope === 'all') await this.#store.clear('tokens', 'clientInformation', 'codeVerifier')
    else if (scope === 'client') await this.#store.clear('clientInformation')
    else if (scope === 'tokens') await this.#store.clear('tokens')
    else if (scope === 'verifier') await this.#store.clear('codeVerifier')
  }
}

import type { Context } from '@deepseek-ai/cordis'
import { NotionBridge } from './bridge.js'
import { Config, type Config as Settings } from './config.js'
import { registerRoutes, type RequestFence, type RouteRegistrar } from './routes.js'
import { SessionStore, sessionFileFor } from './store.js'

export const name = 'notion'
export const inject = ['tools']
export { Config }

interface Scope {
  get(name: string): unknown
  profileContext?: { patchPath?: string }
  on?(event: string, callback: () => void): (() => void) | undefined
}

export function apply(ctx: Context, config: Settings): void {
  const scope = ctx as unknown as Scope
  const store = new SessionStore(sessionFileFor(config.serverName, config.url, scope.profileContext?.patchPath))
  const host = { register: (definition: Parameters<typeof ctx.tools.register>[0]) => ctx.tools.register(definition), logger: ctx.logger }
  const bridge = new NotionBridge(host, { ...config, store })
  ctx.effect(() => () => bridge.dispose(), 'notion:connection')
  ctx.effect(() => {
    let dispose: (() => void) | undefined
    let secured = false
    const bind = (): void => {
      const web = (scope.get('webServer') ?? scope.get('httpServer')) as RouteRegistrar | undefined
      if (!web) return
      const fence = scope.get('connection') as RequestFence | undefined
      if (dispose && (secured || !fence)) return
      dispose?.()
      dispose = registerRoutes(web, bridge, fence)
      secured = !!fence
    }
    bind()
    const off = scope.on?.('internal/service', bind)
    return () => { off?.(); dispose?.() }
  }, 'notion:routes')
  void bridge.start().catch((error: unknown) => ctx.logger.error(`notion: ${String(error)}`))
}

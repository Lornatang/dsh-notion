import { NotionBridge } from './bridge.js';
import { Config } from './config.js';
import { registerRoutes } from './routes.js';
import { SessionStore, sessionFileFor } from './store.js';
export const name = 'notion';
export const inject = ['tools'];
export { Config };
export function apply(ctx, config) {
    const scope = ctx;
    const store = new SessionStore(sessionFileFor(config.serverName, config.url, scope.profileContext?.patchPath));
    const host = { register: (definition) => ctx.tools.register(definition), logger: ctx.logger };
    const bridge = new NotionBridge(host, { ...config, store });
    ctx.effect(() => () => bridge.dispose(), 'notion:connection');
    ctx.effect(() => {
        let dispose;
        let secured = false;
        const bind = () => {
            const web = (scope.get('webServer') ?? scope.get('httpServer'));
            if (!web)
                return;
            const fence = scope.get('connection');
            if (dispose && (secured || !fence))
                return;
            dispose?.();
            dispose = registerRoutes(web, bridge, fence);
            secured = !!fence;
        };
        bind();
        const off = scope.on?.('internal/service', bind);
        return () => { off?.(); dispose?.(); };
    }, 'notion:routes');
    void bridge.start().catch((error) => ctx.logger.error(`notion: ${String(error)}`));
}

import { NotionBridge } from './bridge.js';
import { Config } from './config.js';
import { registerRoutes } from './routes.js';
import { SessionStore, sessionFileFor } from './store.js';
export const name = 'notion';
export const inject = ['tools'];
export { Config };
function serviceIdentity(value) {
    if ((typeof value !== 'object' || value === null) && typeof value !== 'function')
        return value;
    return value[Symbol.for('cordis.original')] ?? value;
}
export function apply(ctx, config) {
    const scope = ctx;
    const store = new SessionStore(sessionFileFor(config.serverName, config.url, scope.profileContext?.patchPath));
    const host = { register: (definition) => ctx.tools.register(definition), logger: ctx.logger };
    const bridge = new NotionBridge(host, { ...config, store });
    ctx.effect(() => () => bridge.dispose(), 'notion:connection');
    ctx.effect(() => {
        let dispose;
        let boundWeb;
        let boundFence;
        const bind = () => {
            const web = (scope.get('webServer') ?? scope.get('httpServer'));
            const fence = scope.get('connection');
            const webIdentity = serviceIdentity(web);
            const fenceIdentity = serviceIdentity(fence);
            if (dispose && webIdentity === boundWeb && fenceIdentity === boundFence)
                return;
            dispose?.();
            dispose = undefined;
            boundWeb = webIdentity;
            boundFence = fenceIdentity;
            if (!web)
                return;
            dispose = registerRoutes(web, bridge, fence);
        };
        bind();
        const off = scope.on?.('internal/service', (name) => {
            if (!name || name === 'connection' || name === 'webServer' || name === 'httpServer')
                bind();
        });
        return () => { off?.(); dispose?.(); };
    }, 'notion:routes');
    void bridge.start().catch((error) => ctx.logger.error(`notion: ${String(error)}`));
}

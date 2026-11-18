export const ROUTE_PREFIX = '/plugins/notion';
function respond(res, status, value) {
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
    res.end(JSON.stringify(value));
}
export function registerRoutes(web, bridge, fence) {
    return web.register({ kind: 'prefix', path: ROUTE_PREFIX, handler: async (req, res) => {
            try {
                if (!fence) {
                    respond(res, 503, { ok: false, error: 'DSH connection service is unavailable' });
                    return;
                }
                const rejection = fence.requestRejection(req);
                if (rejection !== undefined) {
                    res.writeHead(rejection).end();
                    return;
                }
                let path;
                try {
                    path = new URL(req.url ?? '/', 'http://localhost').pathname;
                }
                catch {
                    respond(res, 400, { ok: false, error: 'invalid request target' });
                    return;
                }
                if (req.method === 'GET' && path === `${ROUTE_PREFIX}/status`) {
                    respond(res, 200, { ...bridge.snapshot(), ok: true });
                    return;
                }
                if (req.method === 'POST' && path === `${ROUTE_PREFIX}/connect`) {
                    respond(res, 200, { ...await bridge.authorize(), ok: true });
                    return;
                }
                if (req.method === 'POST' && path === `${ROUTE_PREFIX}/disconnect`) {
                    respond(res, 200, { ...await bridge.disconnect(), ok: true });
                    return;
                }
                respond(res, 404, { ok: false, error: 'unknown endpoint' });
            }
            catch {
                // Never echo upstream error text here: it can carry OAuth response bodies.
                respond(res, 500, { ok: false, error: 'Notion operation failed; check the connection status' });
            }
        } });
}

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { BridgeSnapshot } from './bridge.js';
export declare const ROUTE_PREFIX = "/plugins/notion";
export interface RouteRegistrar {
    register(route: {
        kind: 'prefix';
        path: string;
        handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>;
    }): () => void;
}
export interface RequestFence {
    requestRejection(req: IncomingMessage): number | undefined;
}
export interface PluginBridge {
    snapshot(): BridgeSnapshot;
    authorize(): Promise<BridgeSnapshot>;
    disconnect(): Promise<BridgeSnapshot>;
}
export declare function registerRoutes(web: RouteRegistrar, bridge: PluginBridge, fence: RequestFence | undefined): () => void;

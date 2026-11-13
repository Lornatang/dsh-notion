import type { ToolDefinition } from '@deepseek-ai/dsh-tools';
import { type Logger } from './oauth.js';
import type { SessionStore } from './store.js';
export interface BridgeHost {
    register(definition: ToolDefinition): () => void;
    logger: Logger;
}
export interface BridgeOptions {
    serverName: string;
    url: string;
    redirectPort: number;
    toolCallTimeoutMs: number;
    authorizationTimeoutMs: number;
    autoOpenBrowser: boolean;
    store: SessionStore;
}
export type BridgeStatus = 'idle' | 'connecting' | 'authorizing' | 'ready' | 'error';
export interface BridgeSnapshot {
    status: BridgeStatus;
    authorizationUrl: string | undefined;
    toolCount: number;
    error: string | undefined;
}
export declare function publicToolName(server: string, tool: string): string;
export declare class NotionBridge {
    #private;
    constructor(host: BridgeHost, options: BridgeOptions);
    snapshot(): BridgeSnapshot;
    start(): Promise<void>;
    authorize(): Promise<BridgeSnapshot>;
    disconnect(): Promise<BridgeSnapshot>;
    dispose(): Promise<void>;
}

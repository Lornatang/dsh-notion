import type { OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js';
import type { FetchLike } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { OAuthClientInformationMixed, OAuthClientMetadata, OAuthTokens } from '@modelcontextprotocol/sdk/shared/auth.js';
import type { SessionStore } from './store.js';
export interface Logger {
    info(message: string): void;
    warn(message: string): void;
    error(message: string): void;
}
export interface AuthorizationCallback {
    code: string;
    state: string | undefined;
}
/** Restrict every discovered OAuth and MCP endpoint, including redirect targets. */
export declare function createCloudFetch(serverUrl: URL, options?: {
    maxResponseBytes?: number;
    onLimit?: () => void;
    onStreamEnd?: () => void;
}): {
    fetch: FetchLike;
    allowLoopbackHttp: boolean;
};
export declare class CallbackServer {
    #private;
    get redirectUri(): string;
    listen(preferredPort: number): Promise<number>;
    waitForCode(timeoutMs: number, state: string | undefined, signal?: AbortSignal): Promise<AuthorizationCallback>;
    cancelWait(): void;
    close(): Promise<void>;
}
export declare class NotionOAuthProvider implements OAuthClientProvider {
    #private;
    constructor(options: {
        store: SessionStore;
        redirectUri: () => string;
        onAuthorizationUrl: (url: string) => void;
        allowLoopbackHttp: boolean;
        serverOrigin: string;
        logger: Logger;
        active?: () => boolean;
        tokenRead?: (value: OAuthTokens | undefined) => void;
        refreshExpected?: () => OAuthTokens | undefined;
        authFinished?: () => void;
    });
    get redirectUrl(): string;
    get clientMetadata(): OAuthClientMetadata;
    state(): string;
    clientInformation(): OAuthClientInformationMixed | undefined;
    saveClientInformation(value: OAuthClientInformationMixed): Promise<void>;
    tokens(): OAuthTokens | undefined;
    saveTokens(value: OAuthTokens): Promise<void>;
    redirectToAuthorization(url: URL): void;
    saveCodeVerifier(value: string): Promise<void>;
    codeVerifier(): string;
    invalidateCredentials(scope: 'all' | 'client' | 'tokens' | 'verifier' | 'discovery'): Promise<void>;
}

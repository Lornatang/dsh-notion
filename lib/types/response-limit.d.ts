/** Limit decoded response bytes before the MCP SDK buffers or parses them. */
export declare const MAX_RESPONSE_BYTES: number;
type LimitExceeded = () => void;
export declare function limitResponse(source: Response, maxBytes: number, onLimit: LimitExceeded, onStreamEnd?: () => void): Promise<Response>;
export {};

import type { jsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/types';
export declare const deferredOutputValidation: jsonSchemaValidator;
/** Internal counters so tests can prove workers are reused, not respawned. */
export declare function outputValidatorStats(): {
    spawned: number;
    reused: number;
    idle: number;
};
export declare function validateOutput(schema: unknown, value: unknown, timeoutMs: number, signal?: AbortSignal): Promise<void>;

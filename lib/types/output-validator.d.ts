import type { jsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/types';
export declare const deferredOutputValidation: jsonSchemaValidator;
export declare function validateOutput(schema: unknown, value: unknown, timeoutMs: number, signal?: AbortSignal): Promise<void>;

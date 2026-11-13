import { parentPort, workerData } from 'node:worker_threads';
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/ajv';
const { schema, value } = workerData;
try {
    // The SDK's validator contract is synchronous; AJV returns a Promise for
    // asynchronous schemas, which that contract would incorrectly treat as true.
    if (schema && typeof schema === 'object' && '$async' in schema && schema.$async) {
        throw new Error('asynchronous output schemas are not supported');
    }
    const result = new AjvJsonSchemaValidator().getValidator(schema)(value);
    parentPort?.postMessage({ valid: result.valid, error: result.valid ? undefined : result.errorMessage.slice(0, 1000) });
}
catch (error) {
    parentPort?.postMessage({ valid: false, error: error instanceof Error ? error.message.slice(0, 1000) : 'invalid output schema' });
}

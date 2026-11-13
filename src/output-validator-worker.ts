import { parentPort, workerData } from 'node:worker_threads'
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/ajv'

const { schema, value } = workerData as { schema: Parameters<AjvJsonSchemaValidator['getValidator']>[0]; value: unknown }
try {
  const result = new AjvJsonSchemaValidator().getValidator(schema)(value)
  parentPort?.postMessage({ valid: result.valid, error: result.valid ? undefined : result.errorMessage.slice(0, 1000) })
} catch (error) {
  parentPort?.postMessage({ valid: false, error: error instanceof Error ? error.message.slice(0, 1000) : 'invalid output schema' })
}

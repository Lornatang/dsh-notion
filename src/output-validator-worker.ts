import { parentPort } from 'node:worker_threads'
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/ajv'

type Schema = Parameters<AjvJsonSchemaValidator['getValidator']>[0]
type Validator = ReturnType<AjvJsonSchemaValidator['getValidator']>

// Compiled validators are cached per exact schema so repeated tool calls do
// not recompile. Every cache miss uses a FRESH AjvJsonSchemaValidator: the
// SDK caches compiled schemas by $id on the instance, so one shared instance
// could let a server-supplied $id shadow another tool's schema.
const MAX_CACHED = 32
const MAX_CACHE_KEY = 256 * 1024
const cache = new Map<string, Validator>()

function validatorFor(schema: Schema): Validator {
  let serialized: string | undefined
  try { serialized = JSON.stringify(schema) } catch { serialized = undefined }
  const key = serialized
  if (key !== undefined && key.length <= MAX_CACHE_KEY) {
    const hit = cache.get(key)
    if (hit) return hit
    const validate = new AjvJsonSchemaValidator().getValidator(schema)
    if (cache.size >= MAX_CACHED) {
      const oldest = cache.keys().next().value
      if (oldest !== undefined) cache.delete(oldest)
    }
    cache.set(key, validate)
    return validate
  }
  return new AjvJsonSchemaValidator().getValidator(schema)
}

parentPort?.on('message', (message: { type?: string; id?: number; schema?: Schema; value?: unknown }) => {
  if (message?.type !== 'validate' || typeof message.id !== 'number') return
  const { id, schema, value } = message
  try {
    // The SDK's validator contract is synchronous; AJV returns a Promise for
    // asynchronous schemas, which that contract would incorrectly treat as true.
    if (schema && typeof schema === 'object' && '$async' in schema && schema.$async) {
      throw new Error('asynchronous output schemas are not supported')
    }
    const result = validatorFor(schema as Schema)(value)
    if (result && typeof (result as { then?: unknown }).then === 'function') {
      throw new Error('asynchronous output schemas are not supported')
    }
    parentPort?.postMessage({ type: 'result', id, valid: result.valid, error: result.valid ? undefined : result.errorMessage.slice(0, 1000) })
  } catch (error) {
    parentPort?.postMessage({ type: 'result', id, valid: false, error: error instanceof Error ? error.message.slice(0, 1000) : 'invalid output schema' })
  }
})
parentPort?.postMessage({ type: 'ready' })

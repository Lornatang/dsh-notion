import { parentPort } from 'node:worker_threads'
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/ajv'

type Schema = Parameters<AjvJsonSchemaValidator['getValidator']>[0]
type Validator = ReturnType<AjvJsonSchemaValidator['getValidator']>

// Compiled validators are cached per stable host-assigned schema id so repeated
// tool calls do not recompile or re-clone the schema. Every cache miss uses a
// FRESH AjvJsonSchemaValidator: the SDK caches compiled schemas by $id on the
// instance, so one shared instance could let a server-supplied $id shadow
// another tool's schema.
const MAX_CACHED = 32
const cache = new Map<number, Validator>()
let overflow = false
let cached = false

function validatorFor(schema: Schema, schemaId: number | undefined): Validator {
  if (schemaId !== undefined) {
    const hit = cache.get(schemaId)
    if (hit) { cached = true; return hit }
  }
  cached = false
  const validate = new AjvJsonSchemaValidator().getValidator(schema)
  if (schemaId !== undefined) {
    // Never evict: the host omits a schema only when it believes this worker
    // still has it. Ask the host to recycle this worker instead.
    if (cache.size >= MAX_CACHED) overflow = true
    cache.set(schemaId, validate)
    cached = true
  }
  return validate
}

parentPort?.on('message', (message: { type?: string; id?: number; schemaId?: number; schema?: Schema; value?: unknown }) => {
  if (message?.type !== 'validate' || typeof message.id !== 'number') return
  const { id, schemaId, schema, value } = message
  overflow = false
  cached = false
  try {
    // The SDK's validator contract is synchronous; AJV returns a Promise for
    // asynchronous schemas, which that contract would incorrectly treat as true.
    if (schema && typeof schema === 'object' && '$async' in schema && schema.$async) {
      throw new Error('asynchronous output schemas are not supported')
    }
    if (schema === undefined && (schemaId === undefined || !cache.has(schemaId))) {
      throw new Error('output schema was not provided')
    }
    const result = validatorFor(schema as Schema, schemaId)(value)
    if (result && typeof (result as { then?: unknown }).then === 'function') {
      throw new Error('asynchronous output schemas are not supported')
    }
    parentPort?.postMessage({ type: 'result', id, valid: result.valid, error: result.valid ? undefined : (result.errorMessage ?? 'invalid output').slice(0, 1000), retire: overflow, cached })
  } catch (error) {
    parentPort?.postMessage({ type: 'result', id, valid: false, error: error instanceof Error ? error.message.slice(0, 1000) : 'invalid output schema', retire: overflow, cached: false })
  }
})
parentPort?.postMessage({ type: 'ready' })

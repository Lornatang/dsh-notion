import { Worker } from 'node:worker_threads'
import type { jsonSchemaValidator, JsonSchemaType, JsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/types'

// The SDK validator API is synchronous. Defer its schema validation to our
// worker, which is invoked for every tool page before a result reaches DSH.
export const deferredOutputValidation: jsonSchemaValidator = {
  getValidator<T>(_schema: JsonSchemaType): JsonSchemaValidator<T> {
    return (data: unknown) => ({ valid: true, data: data as T, errorMessage: undefined })
  },
}

const MAX_WORKERS = 4
const MAX_WAITERS = 32
const IDLE_TTL_MS = 60_000
let active = 0
type Waiter = { signal: AbortSignal; resolve: () => void; reject: (error: Error) => void; abort: () => void }
const waiting: Waiter[] = []

async function acquire(signal: AbortSignal): Promise<void> {
  if (signal.aborted) throw new Error('notion: output validation timed out or was cancelled')
  if (active < MAX_WORKERS) { active++; return }
  if (waiting.length >= MAX_WAITERS) throw new Error('notion: too many pending output validations')
  await new Promise<void>((resolve, reject) => {
    const waiter: Waiter = { signal, resolve, reject, abort: () => {
      const index = waiting.indexOf(waiter)
      if (index !== -1) waiting.splice(index, 1)
      reject(new Error('notion: output validation timed out or was cancelled'))
    } }
    waiting.push(waiter)
    signal.addEventListener('abort', waiter.abort, { once: true })
    if (signal.aborted) waiter.abort()
  })
}

function release(): void {
  const next = waiting.shift()
  if (!next) { active--; return }
  next.signal.removeEventListener('abort', next.abort)
  next.resolve()
}

// Validation workers are pooled: spawning a worker per tool call made every
// structured result pay the full SDK + AJV module-load cost again. Idle
// workers are unref'd and reaped so they never keep the host process alive.
type Job = { id: number; settle: (result: { valid: boolean; error?: string }) => void; fail: (error: Error) => void }
type PooledWorker = { worker: Worker; ready: Promise<void>; job?: Job; dead: boolean; idleTimer?: ReturnType<typeof setTimeout> }
const idle: PooledWorker[] = []
let spawned = 0
let reused = 0
let nextJobId = 1

/** Internal counters so tests can prove workers are reused, not respawned. */
export function outputValidatorStats(): { spawned: number; reused: number; idle: number } {
  return { spawned, reused, idle: idle.length }
}

function retire(entry: PooledWorker): void {
  if (entry.dead) return
  entry.dead = true
  if (entry.idleTimer) clearTimeout(entry.idleTimer)
  const index = idle.indexOf(entry)
  if (index !== -1) idle.splice(index, 1)
  void entry.worker.terminate()
}

function spawn(): PooledWorker {
  const worker = new Worker(new URL('./output-validator-worker.js', import.meta.url), {
    execArgv: [],
    resourceLimits: { maxOldGenerationSizeMb: 64, maxYoungGenerationSizeMb: 16, stackSizeMb: 4 },
  })
  let readyResolve!: () => void
  let readyReject!: (error: Error) => void
  const ready = new Promise<void>((resolve, reject) => { readyResolve = resolve; readyReject = reject })
  // A worker can die while idle, before anyone awaits readiness again.
  ready.catch(() => {})
  const entry: PooledWorker = { worker, ready, dead: false }
  worker.on('message', (message: { type?: string; id?: number; valid?: boolean; error?: string }) => {
    if (message?.type === 'ready') { readyResolve(); return }
    if (message?.type === 'result' && entry.job && message.id === entry.job.id) {
      const job = entry.job
      entry.job = undefined
      job.settle({ valid: message.valid === true, error: message.error })
    }
  })
  const die = (error: Error): void => {
    if (entry.dead) return
    const job = entry.job
    entry.job = undefined
    retire(entry)
    readyReject(error)
    job?.fail(error)
  }
  worker.on('error', (error) => die(new Error('notion: output validation worker failed', { cause: error })))
  worker.on('exit', () => die(new Error('notion: output validation worker exited unexpectedly')))
  spawned++
  return entry
}

function take(): PooledWorker {
  const entry = idle.pop()
  if (entry) {
    if (entry.idleTimer) { clearTimeout(entry.idleTimer); entry.idleTimer = undefined }
    entry.worker.ref()
    reused++
    return entry
  }
  return spawn()
}

function park(entry: PooledWorker): void {
  if (entry.dead) return
  entry.worker.unref()
  entry.idleTimer = setTimeout(() => retire(entry), IDLE_TTL_MS)
  entry.idleTimer.unref()
  idle.push(entry)
}

export async function validateOutput(schema: unknown, value: unknown, timeoutMs: number, signal?: AbortSignal): Promise<void> {
  const timeout = AbortSignal.timeout(Math.min(timeoutMs, 5000))
  const combined = signal ? AbortSignal.any([signal, timeout]) : timeout
  await acquire(combined)
  try {
    if (combined.aborted) throw new Error('notion: output validation timed out or was cancelled')
    const entry = take()
    let result: { valid: boolean; error?: string }
    try {
      await entry.ready
      if (combined.aborted) throw new Error('notion: output validation timed out or was cancelled')
      result = await new Promise<{ valid: boolean; error?: string }>((resolve, reject) => {
        let settled = false
        const id = nextJobId++
        const settle = (value: { valid: boolean; error?: string }): void => {
          if (settled) return
          settled = true
          combined.removeEventListener('abort', abort)
          resolve(value)
        }
        const fail = (error: Error): void => {
          if (settled) return
          settled = true
          combined.removeEventListener('abort', abort)
          // A stuck or crashed worker must never validate another schema.
          retire(entry)
          reject(error)
        }
        const abort = (): void => fail(new Error('notion: output validation timed out or was cancelled'))
        entry.job = { id, settle, fail }
        combined.addEventListener('abort', abort, { once: true })
        if (combined.aborted) { abort(); return }
        entry.worker.postMessage({ type: 'validate', id, schema, value })
      })
    } catch (error) {
      retire(entry)
      throw error
    }
    // Normal results — including validation failures — keep the worker warm.
    park(entry)
    if (!result.valid) throw new Error(`notion: structured output does not match its schema: ${result.error ?? 'invalid output'}`)
  } finally { release() }
}

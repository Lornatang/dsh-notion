import { Worker } from 'node:worker_threads';
// The SDK validator API is synchronous. Defer its schema validation to our
// worker, which is invoked for every tool page before a result reaches DSH.
export const deferredOutputValidation = {
    getValidator(_schema) {
        return (data) => ({ valid: true, data: data, errorMessage: undefined });
    },
};
const MAX_WORKERS = 4;
const MAX_WAITERS = 32;
const IDLE_TTL_MS = 60_000;
let active = 0;
const waiting = [];
async function acquire(signal) {
    if (signal.aborted)
        throw new Error('notion: output validation timed out or was cancelled');
    if (active < MAX_WORKERS) {
        active++;
        return;
    }
    if (waiting.length >= MAX_WAITERS)
        throw new Error('notion: too many pending output validations');
    await new Promise((resolve, reject) => {
        const waiter = { signal, resolve, reject, abort: () => {
                const index = waiting.indexOf(waiter);
                if (index !== -1)
                    waiting.splice(index, 1);
                reject(new Error('notion: output validation timed out or was cancelled'));
            } };
        waiting.push(waiter);
        signal.addEventListener('abort', waiter.abort, { once: true });
        if (signal.aborted)
            waiter.abort();
    });
}
function release() {
    const next = waiting.shift();
    if (!next) {
        active--;
        return;
    }
    next.signal.removeEventListener('abort', next.abort);
    next.resolve();
}
// Validation workers are pooled: spawning a worker per tool call made every
// structured result pay the full SDK + AJV module-load cost again. Idle
// workers are unref'd and reaped so they never keep the host process alive.
// Schema objects are stable for the lifetime of a discovered tool. A numeric id
// lets a warm worker reuse the compiled validator without re-sending (and
// structured-cloning) the schema on every call.
const schemaIds = new WeakMap();
let nextSchemaId = 1;
function schemaIdOf(schema) {
    if (typeof schema !== 'object' || schema === null)
        return undefined;
    const known = schemaIds.get(schema);
    if (known !== undefined)
        return known;
    const id = nextSchemaId++;
    schemaIds.set(schema, id);
    return id;
}
const idle = [];
let spawned = 0;
let reused = 0;
let nextJobId = 1;
/** Internal counters so tests can prove workers are reused, not respawned. */
export function outputValidatorStats() {
    return { spawned, reused, idle: idle.length };
}
function retire(entry) {
    if (entry.dead)
        return;
    entry.dead = true;
    if (entry.idleTimer)
        clearTimeout(entry.idleTimer);
    const index = idle.indexOf(entry);
    if (index !== -1)
        idle.splice(index, 1);
    void entry.worker.terminate();
}
function spawn() {
    const worker = new Worker(new URL('./output-validator-worker.js', import.meta.url), {
        execArgv: [],
        resourceLimits: { maxOldGenerationSizeMb: 64, maxYoungGenerationSizeMb: 16, stackSizeMb: 4 },
    });
    let readyResolve;
    let readyReject;
    const ready = new Promise((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
    // A worker can die while idle, before anyone awaits readiness again.
    ready.catch(() => { });
    const entry = { worker, ready, dead: false, schemas: new Set() };
    worker.on('message', (message) => {
        if (message?.type === 'ready') {
            readyResolve();
            return;
        }
        if (message?.type === 'result' && entry.job && message.id === entry.job.id) {
            const job = entry.job;
            entry.job = undefined;
            // Only acknowledge the schema after the worker reports it compiled it;
            // a malformed schema must stay a cache miss, not turn into a lost schema.
            if (message.cached === true && entry.pendingSchema !== undefined)
                entry.schemas.add(entry.pendingSchema);
            entry.pendingSchema = undefined;
            job.settle({ valid: message.valid === true, error: message.error });
            // A worker that filled its schema cache must not receive an uncached
            // schema later; recycling it keeps the host's per-worker cache view exact.
            if (message.retire === true)
                retire(entry);
        }
    });
    const die = (error) => {
        if (entry.dead)
            return;
        const job = entry.job;
        entry.job = undefined;
        retire(entry);
        readyReject(error);
        job?.fail(error);
    };
    worker.on('error', (error) => die(new Error('notion: output validation worker failed', { cause: error })));
    worker.on('exit', () => die(new Error('notion: output validation worker exited unexpectedly')));
    spawned++;
    return entry;
}
function take() {
    const entry = idle.pop();
    if (entry) {
        if (entry.idleTimer) {
            clearTimeout(entry.idleTimer);
            entry.idleTimer = undefined;
        }
        entry.worker.ref();
        reused++;
        return entry;
    }
    return spawn();
}
function park(entry) {
    if (entry.dead)
        return;
    entry.worker.unref();
    entry.idleTimer = setTimeout(() => retire(entry), IDLE_TTL_MS);
    entry.idleTimer.unref();
    idle.push(entry);
}
export async function validateOutput(schema, value, timeoutMs, signal) {
    // Queue wait is bounded separately, so the validation timeout measures only
    // worker work; a queued caller is still released by its cancellation signal.
    const queueTimeout = AbortSignal.timeout(Math.min(timeoutMs, 5000));
    const queueSignal = signal ? AbortSignal.any([signal, queueTimeout]) : queueTimeout;
    await acquire(queueSignal);
    const timeout = AbortSignal.timeout(Math.min(timeoutMs, 5000));
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
    try {
        if (combined.aborted)
            throw new Error('notion: output validation timed out or was cancelled');
        const entry = take();
        let result;
        try {
            await entry.ready;
            if (combined.aborted)
                throw new Error('notion: output validation timed out or was cancelled');
            result = await new Promise((resolve, reject) => {
                let settled = false;
                const id = nextJobId++;
                const settle = (value) => {
                    if (settled)
                        return;
                    settled = true;
                    combined.removeEventListener('abort', abort);
                    resolve(value);
                };
                const fail = (error) => {
                    if (settled)
                        return;
                    settled = true;
                    combined.removeEventListener('abort', abort);
                    // A stuck or crashed worker must never validate another schema.
                    retire(entry);
                    reject(error);
                };
                const abort = () => fail(new Error('notion: output validation timed out or was cancelled'));
                entry.job = { id, settle, fail };
                combined.addEventListener('abort', abort, { once: true });
                if (combined.aborted) {
                    abort();
                    return;
                }
                // Send the schema only when this worker has not compiled it yet.
                const schemaId = schemaIdOf(schema);
                const cached = schemaId !== undefined && entry.schemas.has(schemaId);
                entry.pendingSchema = schemaId;
                entry.worker.postMessage(cached
                    ? { type: 'validate', id, schemaId, value }
                    : { type: 'validate', id, schemaId, schema, value });
            });
        }
        catch (error) {
            retire(entry);
            throw error;
        }
        // Normal results — including validation failures — keep the worker warm.
        park(entry);
        if (!result.valid)
            throw new Error(`notion: structured output does not match its schema: ${result.error ?? 'invalid output'}`);
    }
    finally {
        release();
    }
}

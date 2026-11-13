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
let workers = 0;
const waiting = [];
async function acquire(signal) {
    if (signal.aborted)
        throw new Error('notion: output validation timed out or was cancelled');
    if (workers < MAX_WORKERS) {
        workers++;
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
        workers--;
        return;
    }
    next.signal.removeEventListener('abort', next.abort);
    next.resolve();
}
export async function validateOutput(schema, value, timeoutMs, signal) {
    const timeout = AbortSignal.timeout(Math.min(timeoutMs, 5000));
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
    await acquire(combined);
    try {
        if (combined.aborted)
            throw new Error('notion: output validation timed out or was cancelled');
        await new Promise((resolve, reject) => {
            let settled = false;
            const worker = new Worker(new URL('./output-validator-worker.js', import.meta.url), {
                workerData: { schema, value },
                execArgv: [],
                resourceLimits: { maxOldGenerationSizeMb: 64, maxYoungGenerationSizeMb: 16, stackSizeMb: 4 },
            });
            const finish = (error) => {
                if (settled)
                    return;
                settled = true;
                combined.removeEventListener('abort', abort);
                const complete = () => { if (error)
                    reject(error);
                else
                    resolve(); };
                void worker.terminate().then(complete, complete);
            };
            const abort = () => finish(new Error('notion: output validation timed out or was cancelled'));
            worker.once('message', (result) => {
                finish(result.valid ? undefined : new Error(`notion: structured output does not match its schema: ${result.error ?? 'invalid output'}`));
            });
            worker.once('error', (error) => finish(new Error('notion: output validation worker failed', { cause: error })));
            worker.once('exit', () => finish(new Error('notion: output validation worker exited unexpectedly')));
            combined.addEventListener('abort', abort, { once: true });
            if (combined.aborted)
                abort();
        });
    }
    finally {
        release();
    }
}

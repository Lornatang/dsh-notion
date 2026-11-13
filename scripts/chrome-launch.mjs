import { spawn } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

const LOG_LIMIT = 8192

function safeStartupLog(text) {
  const lines = text.split(/\r?\n/)
    .filter((line) => /error|fatal|fail|cannot|unable|denied|not found|no such/i.test(line))
    .map((line) => line
      .replace(/\b(?:https?|wss?):\/\/\S+/gi, '[url]')
      .replace(/\b(token|authorization|cookie|password|secret)\s*[:=].*/gi, '$1=[redacted]'))
  return lines.slice(-8).join('\n').slice(-4000)
}

async function waitForExit(exited, timeoutMs) {
  let timer
  try {
    return await Promise.race([
      exited.then(() => true),
      new Promise((resolve) => { timer = setTimeout(() => resolve(false), timeoutMs) }),
    ])
  } finally { clearTimeout(timer) }
}

/** Start an isolated browser; retry only startup failures, never test failures. */
export async function launchChrome(executable, temp, options = {}) {
  const { attempts = 2, startupTimeoutMs = 45000, pollIntervalMs = 100, onRetry = (message) => console.warn(message) } = options
  if (!Number.isInteger(attempts) || attempts < 1 || startupTimeoutMs <= 0 || pollIntervalMs <= 0) {
    throw new Error('Invalid Chrome startup options')
  }
  const failures = []
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const profile = await mkdtemp(join(temp, 'chrome-'))
    const child = spawn(executable, [
      '--headless=new', '--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--no-proxy-server',
      '--no-first-run', '--no-default-browser-check', '--remote-debugging-port=0',
      `--user-data-dir=${profile}`, 'about:blank',
    ], { stdio: ['ignore', 'ignore', 'pipe'] })
    let stderr = ''
    let capture = true
    let outcome
    child.stderr.on('data', (data) => {
      if (capture) stderr = (stderr + data.toString('utf8')).slice(-LOG_LIMIT)
    })
    const exited = new Promise((resolve) => {
      child.once('error', (error) => { outcome = { error }; resolve(outcome) })
      child.once('exit', (code, signal) => { outcome = { code, signal }; resolve(outcome) })
    })
    let closed = false
    const close = async () => {
      if (closed) return
      closed = true
      if (!outcome) child.kill('SIGTERM')
      if (!await waitForExit(exited, 3000)) {
        child.kill('SIGKILL')
        if (!await waitForExit(exited, 3000)) throw new Error('Chrome did not exit after being terminated')
      }
      await rm(profile, { recursive: true, force: true, maxRetries: 3 })
    }
    try {
      const deadline = Date.now() + startupTimeoutMs
      while (Date.now() < deadline && !outcome) {
        let port
        try { port = Number((await readFile(join(profile, 'DevToolsActivePort'), 'utf8')).split('\n')[0]) } catch {}
        if (Number.isInteger(port) && port > 0 && port <= 65535) {
          try {
            const response = await fetch(`http://127.0.0.1:${port}/json/version`, {
              signal: AbortSignal.timeout(Math.max(1, Math.min(1000, deadline - Date.now()))),
            })
            await response.body?.cancel()
            if (response.ok && !outcome) {
              capture = false
              return { port, close }
            }
          } catch { /* Chrome may have written the port before accepting requests. */ }
        }
        if (!outcome) await delay(Math.min(pollIntervalMs, Math.max(1, deadline - Date.now())))
      }
      const reason = outcome?.error
        ? `could not start (${outcome.error.code ?? outcome.error.message})`
        : outcome ? `exited during startup (code ${String(outcome.code)}, signal ${String(outcome.signal)})`
          : `debugging endpoint was not ready within ${startupTimeoutMs} ms`
      const diagnostic = safeStartupLog(stderr)
      const failure = `Chrome startup attempt ${attempt}/${attempts}: ${reason}${diagnostic ? `\n${diagnostic}` : ''}`
      failures.push(failure)
      const permanent = ['ENOENT', 'EACCES'].includes(outcome?.error?.code)
      await close()
      if (permanent || attempt === attempts) throw new Error(failures.join('\n'))
      onRetry(`${failure}\nRetrying with a fresh browser profile.`)
    } catch (error) {
      await close()
      throw error
    }
  }
  throw new Error(failures.join('\n'))
}

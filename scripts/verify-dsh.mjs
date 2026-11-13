import assert from 'node:assert/strict'
import { execFile, spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { startMockMcp } from '../tests/mock-mcp.mjs'
import { verifyBrowser } from './browser-smoke.mjs'

const run = promisify(execFile)
const root = fileURLToPath(new URL('..', import.meta.url))
const temp = await mkdtemp(join(tmpdir(), 'notion-dsh-integration-'))
const home = join(temp, 'home')
const dshHome = join(temp, 'dsh-home')
const dsh = process.env.DSH_TEST_BINARY || 'dsh'
const env = { ...process.env, HOME: home, DSH_HOME: dshHome, DSH_NOTION_ENCRYPTION_KEY: randomBytes(32).toString('base64') }
delete env.DSH_PROFILE
const mock = await startMockMcp({ oauth: true })
let server
let output = ''
try {
  await mkdir(home, { recursive: true })
  const version = (await run(dsh, ['--version'], { env, timeout: 30000 })).stdout.trim()
  assert.equal(version, '0.2.2-rc.2', 'this integration test targets DSH 0.2.2-rc.2')
  await run(dsh, ['--profile', 'notion-test', '--from-default-profile', 'web', '--dump-config'], { env, cwd: temp, timeout: 60000, maxBuffer: 1024 * 1024 })
  const profile = join(dshHome, 'profiles', 'notion-test')
  const packed = JSON.parse((await run('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', temp], { cwd: root, env, timeout: 30000 })).stdout)[0]
  await run(dsh, ['plugin', '--profile', 'notion-test', 'add', join(temp, packed.filename), '--registry=https://registry.npmjs.org/'], { env, cwd: temp, timeout: 240000, maxBuffer: 1024 * 1024 })
  const installed = JSON.parse(await readFile(join(profile, 'node_modules', '@lornatang', 'dsh-notion', 'package.json'), 'utf8'))
  const expected = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
  assert.equal(installed.version, expected.version)
  await writeFile(join(profile, 'cordis.patch.yml'), `- id: notion\n  config:\n    serverName: notion\n    url: '${mock.url}'\n    redirectPort: 0\n    autoOpenBrowser: false\n`)
  server = spawn(dsh, ['--profile', 'notion-test', '--no-open', '--port', '0'], { env, cwd: temp, stdio: ['ignore', 'pipe', 'pipe'] })
  server.stdout.on('data', (chunk) => { output += chunk })
  server.stderr.on('data', (chunk) => { output += chunk })
  let launch
  for (let i = 0; i < 900; i++) {
    launch = output.match(/https?:\/\/127\.0\.0\.1:\d+\/\?token=[^\s]+/)?.[0]
    if (launch) break
    if (server.exitCode !== null) throw new Error('DSH exited during startup')
    await delay(100)
  }
  assert.ok(launch, 'DSH did not print an authenticated launch URL')
  const origin = new URL(launch).origin
  assert.equal((await fetch(origin + '/plugins/notion/status')).status, 401)
  assert.ok([401, 403].includes((await fetch(origin + '/plugins/notion/disconnect', { method: 'POST' })).status))
  const entry = await fetch(launch, { redirect: 'manual' })
  const cookie = entry.headers.getSetCookie().map((value) => value.split(';')[0]).join('; ')
  assert.ok(cookie, 'DSH did not issue a login cookie')
  assert.ok([401, 403].includes((await fetch(origin + '/plugins/notion/disconnect', { method: 'POST', headers: { cookie, origin: 'https://example.invalid' } })).status), 'cross-origin requests must be rejected')
  let status
  for (let i = 0; i < 300; i++) {
    const response = await fetch(origin + '/plugins/notion/status', { headers: { cookie }, signal: AbortSignal.timeout(10000) })
    if (response.status === 200) { status = await response.json(); if (status.status === 'authorizing') break }
    await delay(100)
  }
  assert.equal(status?.status, 'authorizing', `mock OAuth did not start: ${status?.error || 'no status'}`)
  assert.ok(status.authorizationUrl)
  await verifyBrowser(launch, temp)
  assert.equal((await fetch(status.authorizationUrl)).status, 200)
  for (let i = 0; i < 300; i++) {
    const response = await fetch(origin + '/plugins/notion/status', { headers: { cookie }, signal: AbortSignal.timeout(10000) })
    if (response.status === 200) { status = await response.json(); if (status.status === 'ready') break }
    await delay(100)
  }
  assert.equal(status?.status, 'ready', `MCP bridge did not become ready: ${status?.error || 'no status'}`)
  assert.equal(status.toolCount, 5)
  const file = (await readdir(join(profile, 'data'))).find((name) => name.startsWith('dsh-notion-notion-'))
  assert.ok(file, 'encrypted credentials must be in the active profile')
  assert.doesNotMatch(await readFile(join(profile, 'data', file), 'utf8'), /first-access-token|mock-refresh/)
  const disconnected = await fetch(origin + '/plugins/notion/disconnect', { method: 'POST', headers: { cookie, origin } })
  assert.equal(disconnected.status, 200)
  assert.equal((await disconnected.json()).toolCount, 0)
  console.log('DSH 0.2.2-rc.2: installation, request fence, mock OAuth, tools and encrypted credentials passed.')
} catch (error) {
  const diagnostics = output.split('\n').filter((line) => /notion|warning|error/i.test(line) && !/token|https?:\/\//i.test(line)).slice(-20)
  if (diagnostics.length) process.stderr.write(diagnostics.join('\n') + '\n')
  throw error
} finally {
  if (server && server.exitCode === null && server.signalCode === null) {
    const exited = new Promise((resolve) => server.once('exit', resolve))
    server.kill('SIGTERM')
    await Promise.race([exited, delay(5000)])
    if (server.exitCode === null && server.signalCode === null) { server.kill('SIGKILL'); await exited }
  }
  await mock.close()
  await rm(temp, { recursive: true, force: true, maxRetries: 3 })
}

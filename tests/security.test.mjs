import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { execFile } from 'node:child_process'
import { chmod, link, mkdtemp, mkdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { test } from 'node:test'
import { gzipSync } from 'node:zlib'
import { CallbackServer, createCloudFetch } from '../lib/oauth.js'
import { limitResponse } from '../lib/response-limit.js'
import { validateOutput } from '../lib/output-validator.js'
import { registerRoutes } from '../lib/routes.js'
import { SessionStore, sessionFileFor } from '../lib/store.js'

process.env.DSH_NOTION_ENCRYPTION_KEY = Buffer.alloc(32, 29).toString('base64')

test('OAuth callback validates state, rejects replays and escapes error text', async () => {
  const server = new CallbackServer()
  await server.listen(0)
  try {
    await assert.rejects(server.waitForCode(1000, undefined), /state/)
    const waiting = server.waitForCode(3000, 'correct')
    assert.equal((await fetch(`${server.redirectUri}?code=abc&state=wrong`)).status, 400)
    const valid = await fetch(`${server.redirectUri}?code=abc&state=correct`)
    assert.equal(valid.status, 200)
    assert.equal(valid.headers.get('referrer-policy'), 'no-referrer')
    assert.deepEqual(await waiting, { code: 'abc', state: 'correct' })
    assert.equal((await fetch(`${server.redirectUri}?code=abc&state=correct`)).status, 400)
    const errorWait = server.waitForCode(3000, 'next')
    const rejected = assert.rejects(errorWait, /authorization failed/)
    const response = await fetch(`${server.redirectUri}?state=next&error=invalid&error_description=%3Cscript%3Ealert(1)%3C%2Fscript%3E`)
    const body = await response.text()
    assert.equal(response.status, 400)
    assert.ok(body.includes('&lt;script&gt;'))
    assert.ok(!body.includes('<script>'))
    assert.match(response.headers.get('content-security-policy'), /default-src 'none'/)
    await rejected
  } finally { await server.close() }
})

test('OAuth traffic rejects insecure and cross-origin destinations before sending secrets', async () => {
  assert.throws(() => createCloudFetch(new URL('http://example.com/mcp')), /HTTPS/)
  assert.throws(() => createCloudFetch(new URL('https://name:secret@example.com/mcp')), /HTTPS/)
  const { fetch: secureFetch } = createCloudFetch(new URL('https://mcp.notion.com/mcp'))
  await assert.rejects(secureFetch('http://mcp.notion.com/token', { method: 'POST', body: 'secret' }), /HTTPS/)
  await assert.rejects(secureFetch('https://other.example/token', { method: 'POST', body: 'secret' }), /origin/)
})

test('credentials are encrypted, profile-isolated, owner-only, and reject tampering and symlinks', async () => {
  const root = await mkdtemp(join(tmpdir(), 'notion-store-'))
  try {
    const file = sessionFileFor('notion', 'https://example.test/mcp', join(root, 'profiles', 'one', 'cordis.patch.yml'))
    const other = sessionFileFor('notion', 'https://example.test/mcp', join(root, 'profiles', 'two', 'cordis.patch.yml'))
    assert.notEqual(file, other)
    assert.throws(() => sessionFileFor('../bad', 'https://example.test'), /serverName/)
    const store = new SessionStore(file)
    await store.load()
    await Promise.all([store.patch({ codeVerifier: 'secret-verifier' }), store.patch({ tokens: { access_token: 'secret-token', token_type: 'Bearer' } })])
    const encrypted = await readFile(file, 'utf8')
    assert.doesNotMatch(encrypted, /secret-token|secret-verifier/)
    assert.equal((await new SessionStore(file).load()).tokens.access_token, 'secret-token')
    if (process.platform !== 'win32') assert.equal((await stat(file)).mode & 0o077, 0)
    await mkdir(join(root, 'profiles', 'two', 'data'), { recursive: true })
    await writeFile(other, encrypted, { mode: 0o600 })
    await assert.rejects(new SessionStore(other).load(), /cannot decrypt/)
    const altered = JSON.parse(encrypted)
    altered.ciphertext = (altered.ciphertext[0] === 'A' ? 'B' : 'A') + altered.ciphertext.slice(1)
    await writeFile(file, JSON.stringify(altered))
    await assert.rejects(new SessionStore(file).load(), /cannot decrypt/)
    assert.equal(await readFile(file, 'utf8'), JSON.stringify(altered))
    await rm(file)
    const target = join(root, 'target')
    await writeFile(target, 'do not modify')
    await symlink(target, file)
    await assert.rejects(new SessionStore(file).load(), /regular file/)
    assert.equal(await readFile(target, 'utf8'), 'do not modify')
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('credential storage rejects substituted directories and hard-linked files', { skip: process.platform === 'win32' }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'notion-store-links-'))
  try {
    const a = sessionFileFor('notion', 'https://example.test/mcp', join(root, 'a', 'cordis.patch.yml'))
    const b = sessionFileFor('notion', 'https://example.test/mcp', join(root, 'b', 'cordis.patch.yml'))
    const first = new SessionStore(a)
    await first.patch({ tokens: { access_token: 'a', token_type: 'Bearer' } })
    await new SessionStore(b).patch({ tokens: { access_token: 'b', token_type: 'Bearer' } })
    const original = await readFile(b, 'utf8')
    await rm(join(root, 'a', 'data'), { recursive: true })
    await symlink(join(root, 'b', 'data'), join(root, 'a', 'data'))
    await assert.rejects(first.destroy(), /directory must not be a symlink/)
    await assert.rejects(first.patch({ codeVerifier: 'replacement' }), /directory must not be a symlink/)
    assert.equal(await readFile(b, 'utf8'), original)

    const victim = join(root, 'victim')
    const planted = join(root, 'hardlinked-session')
    await writeFile(victim, 'do not chmod', { mode: 0o644 })
    await chmod(victim, 0o644)
    await link(victim, planted)
    await assert.rejects(new SessionStore(planted).load(), /multiple hard links/)
    assert.equal((await stat(victim)).mode & 0o777, 0o644)

    await mkdir(join(root, 'unsafe'), { mode: 0o700 })
    await chmod(join(root, 'unsafe'), 0o777)
    await assert.rejects(new SessionStore(join(root, 'unsafe', 'session')).patch({ codeVerifier: 'x' }), /not protected from other users/)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('credential guards run inside the store queue and preserve newer tokens', async () => {
  const root = await mkdtemp(join(tmpdir(), 'notion-store-guard-'))
  const file = join(root, 'session.json')
  const store = new SessionStore(file)
  try {
    let active = true
    const stale = store.patch({ tokens: { access_token: 'old', token_type: 'Bearer' } }, () => active)
    active = false
    await assert.rejects(stale, /cancelled/)
    await assert.rejects(stat(file), { code: 'ENOENT' })
    await store.patch({ tokens: { access_token: 'old', token_type: 'Bearer' } })
    const expected = store.current.tokens
    await store.patch({ tokens: { access_token: 'new', token_type: 'Bearer' } })
    await store.saveTokens({ access_token: 'older', token_type: 'Bearer' }, () => true, expected)
    await store.clearCredentialsIf(() => true, expected, 'tokens')
    assert.equal((await new SessionStore(file).load()).tokens.access_token, 'new')
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('web routes require the DSH connection fence for reading and changing state', async () => {
  let handler
  let calls = 0
  const web = { register(route) { handler = route.handler; return () => {} } }
  const bridge = { snapshot: () => ({ status: 'idle', toolCount: 0 }), authorize: async () => { calls++; return { status: 'authorizing' } }, disconnect: async () => { calls++; return { status: 'idle' } } }
  const server = createServer((req, res) => void handler(req, res))
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const origin = `http://127.0.0.1:${server.address().port}`
  try {
    registerRoutes(web, bridge, undefined)
    assert.equal((await fetch(origin + '/plugins/notion/status')).status, 503)
    registerRoutes(web, bridge, { requestRejection: () => 401 })
    assert.equal((await fetch(origin + '/plugins/notion/status')).status, 401)
    assert.equal((await fetch(origin + '/plugins/notion/connect', { method: 'POST' })).status, 401)
    assert.equal(calls, 0)
    registerRoutes(web, bridge, { requestRejection: () => undefined })
    const status = await fetch(origin + '/plugins/notion/status')
    assert.equal(status.status, 200)
    assert.match(status.headers.get('cache-control'), /no-store/)
    assert.equal((await fetch(origin + '/plugins/notion/connect', { method: 'POST' })).status, 200)
    assert.equal(calls, 1)
    assert.equal((await fetch(origin + '/plugins/notionary/status')).status, 404)
  } finally { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)) }
})

test('response limits cover decoded, chunked, error and misleading SSE bodies', async () => {
  let limits = 0
  const server = createServer((req, res) => {
    if (req.url === '/compressed') {
      const body = gzipSync(Buffer.alloc(4096, 'a'))
      res.writeHead(200, { 'content-type': 'application/json', 'content-encoding': 'gzip' }).end(body)
    } else if (req.url === '/error') {
      res.writeHead(401, { 'content-type': 'text/plain' })
      res.write('x'.repeat(80))
      res.end('y'.repeat(80))
    } else if (req.url === '/redirect') {
      res.writeHead(302, { location: '/target' })
      res.write('redirect still streaming')
    } else res.writeHead(404).end()
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const origin = `http://127.0.0.1:${server.address().port}`
  const { fetch: bounded } = createCloudFetch(new URL(origin + '/mcp'), { maxResponseBytes: 128, onLimit: () => { limits++ } })
  try {
    const compressed = await bounded(origin + '/compressed')
    await assert.rejects(compressed.text(), /byte limit/)
    await assert.rejects(bounded(origin + '/error'), /byte limit/)
    const redirect = await Promise.race([bounded(origin + '/redirect'), new Promise((_, reject) => setTimeout(() => reject(new Error('redirect body was buffered')), 1000))])
    assert.equal(redirect.status, 302)
    assert.equal(redirect.url, origin + '/redirect')
    await redirect.body.cancel()

    const fakeLength = new Response('x'.repeat(129), { headers: { 'content-length': '1' } })
    await assert.rejects((await limitResponse(fakeLength, 128, () => { limits++ })).text(), /byte limit/)

    const deceptive = new Response('data: a\n\n'.repeat(30), { headers: { 'content-type': 'text/event-stream' } })
    await assert.rejects((await limitResponse(deceptive, 128, () => { limits++ })).json(), /byte limit/)
    assert.equal(limits, 4)
  } finally { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)) }
})

test('SSE limit applies per event and handles split delimiters and heartbeats', async () => {
  const encoder = new TextEncoder()
  const stream = (chunks) => new ReadableStream({ start(controller) { for (const chunk of chunks) controller.enqueue(encoder.encode(chunk)); controller.close() } })
  const chunks = [...Array.from({ length: 80 }, () => [': keepalive\r', '\n']).flat(), ...Array.from({ length: 80 }, () => [': keepalive\n', 'data: ok\r', '\n\r', '\n']).flat()]
  const source = new Response(stream(chunks), { headers: { 'content-type': 'text/event-stream; charset=utf-8' } })
  const response = await limitResponse(source, 32, () => { throw new Error('legitimate SSE was limited') })
  assert.equal(await new Response(response.body).text(), chunks.join(''))
  let limited = false
  const tooLarge = new Response(stream(['data: ', 'a'.repeat(32), '\r\n\r\n']), { headers: { 'content-type': 'text/event-stream' } })
  const bounded = await limitResponse(tooLarge, 32, () => { limited = true })
  await assert.rejects(new Response(bounded.body).text(), /byte limit/)
  assert.equal(limited, true)
})

test('structured output validation retains normal schema and format checks', async () => {
  const schema = { type: 'object', properties: { email: { type: 'string', format: 'email' }, code: { type: 'string', pattern: '^[A-Z]{2}$' } }, required: ['email', 'code'] }
  await validateOutput(schema, { email: 'person@example.com', code: 'AB' }, 5000)
  await assert.rejects(validateOutput(schema, { email: 'not-an-email', code: 'AB' }, 5000), /does not match/)
  await assert.rejects(validateOutput(schema, { email: 'person@example.com', code: 'bad' }, 5000), /does not match/)
  await assert.rejects(validateOutput({ $async: true, type: 'object', required: ['missing'] }, {}, 5000), /asynchronous output schemas are not supported/)
})

test('pathological output regexes cannot block the host event loop', async () => {
  const validator = new URL('../lib/output-validator.js', import.meta.url).href
  const script = `
    import { validateOutput } from ${JSON.stringify(validator)};
    let ticks = 0;
    const timer = setInterval(() => { ticks++ }, 20);
    const text = 'a'.repeat(38) + '!';
    const cases = [
      [{ type: 'object', $defs: { v: { type: 'string', pattern: '^(a+)+$' } }, properties: { v: { $ref: '#/$defs/v' } } }, { v: text }],
      [{ type: 'object', patternProperties: { '^(a+)+$': { type: 'number' } }, additionalProperties: false }, { [text]: 1 }],
    ];
    for (const [schema, value] of cases) {
      try { await validateOutput(schema, value, 1200); throw new Error('dangerous validation unexpectedly passed') }
      catch (error) { if (!/timed out/.test(error.message)) throw error }
    }
    clearInterval(timer);
    if (ticks < 3) throw new Error('host event loop was blocked');
    console.log('isolated');
  `
  const { stdout } = await promisify(execFile)(process.execPath, ['--input-type=module', '-e', script], { timeout: 8000 })
  assert.match(stdout, /isolated/)
})

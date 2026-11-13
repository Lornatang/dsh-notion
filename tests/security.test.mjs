import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtemp, mkdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { CallbackServer, createCloudFetch } from '../lib/oauth.js'
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

import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { test } from 'node:test'
import { NotionBridge } from '../lib/bridge.js'
import { SessionStore } from '../lib/store.js'
import { startMockMcp } from './mock-mcp.mjs'

process.env.DSH_NOTION_ENCRYPTION_KEY = Buffer.alloc(32, 13).toString('base64')
const logger = { info() {}, warn() {}, error() {} }
async function waitFor(predicate) {
  for (let i = 0; i < 200; i++) { if (predicate()) return; await delay(25) }
  throw new Error('bridge did not reach the expected state')
}
function makeHost() {
  const tools = new Map()
  return { tools, logger, register(definition) { if (tools.has(definition.name)) throw new Error('duplicate tool'); tools.set(definition.name, definition); return () => tools.delete(definition.name) } }
}
function options(mock, file) { return { serverName: 'notion', url: mock.url, redirectPort: 0, toolCallTimeoutMs: 5000, authorizationTimeoutMs: 5000, autoOpenBrowser: false, store: new SessionStore(file) } }

test('registers Notion tools and MCP resources, then removes all on disconnect', async () => {
  const mock = await startMockMcp()
  const root = await mkdtemp(join(tmpdir(), 'notion-bridge-'))
  const file = join(root, 'session.json')
  const host = makeHost()
  const bridge = new NotionBridge(host, options(mock, file))
  try {
    await bridge.start()
    await waitFor(() => bridge.snapshot().status === 'ready')
    assert.equal(bridge.snapshot().toolCount, 5)
    const result = await host.tools.get('mcp__notion__notion-search').execute({ query: 'plans' }, {})
    assert.match(result.content[0].text, /Mock Notion page/)
    assert.ok(mock.calls.some((call) => call.method === 'tools/call' && call.params.arguments.query === 'plans'))
    await assert.rejects(host.tools.get('mcp__notion__notion-search').execute({ query: 'fail' }, {}), /Permission denied/)
    const list = await host.tools.get('mcp__notion__dsh_list_resources').execute({}, {})
    assert.match(list.content[0].text, /notion:\/\/docs\/example/)
    const read = await host.tools.get('mcp__notion__dsh_read_resource').execute({ uri: 'notion://docs/example' }, {})
    assert.match(read.content[0].text, /Mock Notion format documentation/)
    const templates = await host.tools.get('mcp__notion__dsh_list_resource_templates').execute({}, {})
    assert.match(templates.content[0].text, /uriTemplate/)
    await bridge.disconnect()
    assert.equal(host.tools.size, 0)
    assert.equal(bridge.snapshot().status, 'idle')
    await assert.rejects(stat(file), { code: 'ENOENT' })
  } finally { await bridge.dispose(); await mock.close(); await rm(root, { recursive: true, force: true }) }
})

test('OAuth uses state and S256 PKCE, encrypts saved tokens, and refreshes after restart', async () => {
  const mock = await startMockMcp({ oauth: true })
  const root = await mkdtemp(join(tmpdir(), 'notion-oauth-'))
  const file = join(root, 'session.json')
  const host = makeHost()
  let bridge = new NotionBridge(host, options(mock, file))
  try {
    await bridge.start()
    await waitFor(() => bridge.snapshot().status === 'authorizing')
    const url = new URL(bridge.snapshot().authorizationUrl)
    assert.ok(url.searchParams.get('state'))
    assert.equal(url.searchParams.get('code_challenge_method'), 'S256')
    assert.ok(url.searchParams.get('code_challenge'))
    assert.equal((await fetch(url)).status, 200)
    await waitFor(() => bridge.snapshot().status === 'ready')
    assert.equal(host.tools.size, 5)
    const raw = await readFile(file, 'utf8')
    assert.doesNotMatch(raw, /first-access-token|mock-refresh|mock-client|codeVerifier/)
    assert.equal(JSON.parse(raw).algorithm, 'aes-256-gcm')
    const saved = await new SessionStore(file).load()
    assert.equal(saved.tokens.access_token, 'first-access-token')
    assert.equal(saved.codeVerifier, undefined)
    const port = Number(new URL(saved.redirectUri).port)
    await bridge.dispose()
    mock.expire()
    bridge = new NotionBridge(host, { ...options(mock, file), redirectPort: port })
    await bridge.start()
    await waitFor(() => bridge.snapshot().status === 'ready')
    assert.equal(mock.refreshes(), 1)
    assert.equal((await new SessionStore(file).load()).tokens.access_token, 'refreshed-access-token')
    assert.equal(host.tools.size, 5)
  } finally { await bridge.dispose(); await mock.close(); await rm(root, { recursive: true, force: true }) }
})

test('disconnect during startup cannot restore credentials or tools afterward', async () => {
  const mock = await startMockMcp({ initializeDelay: 2000 })
  const root = await mkdtemp(join(tmpdir(), 'notion-cancel-'))
  const file = join(root, 'session.json')
  const host = makeHost()
  const bridge = new NotionBridge(host, options(mock, file))
  try {
    const start = bridge.start()
    await waitFor(() => mock.calls.some((call) => call.method === 'initialize'))
    const disconnected = bridge.disconnect()
    await Promise.race([disconnected, delay(1000).then(() => { throw new Error('disconnect did not cancel the active request') })])
    await start
    assert.equal(bridge.snapshot().status, 'idle')
    assert.equal(host.tools.size, 0)
    await assert.rejects(stat(file), { code: 'ENOENT' })
  } finally { await bridge.dispose(); await mock.close(); await rm(root, { recursive: true, force: true }) }
})

test('conflicting resource tool names fail without leaving partial tools registered', async () => {
  const mock = await startMockMcp({ conflict: true })
  const root = await mkdtemp(join(tmpdir(), 'notion-conflict-'))
  const host = makeHost()
  const bridge = new NotionBridge(host, options(mock, join(root, 'session.json')))
  try {
    await bridge.start()
    await waitFor(() => bridge.snapshot().status === 'error')
    assert.match(bridge.snapshot().error, /conflicts/)
    assert.equal(host.tools.size, 0)
  } finally { await bridge.dispose(); await mock.close(); await rm(root, { recursive: true, force: true }) }
})

test('rejects an insecure discovered OAuth token endpoint', async () => {
  const mock = await startMockMcp({ oauth: true, tokenEndpoint: 'http://example.invalid/token' })
  const root = await mkdtemp(join(tmpdir(), 'notion-insecure-'))
  const file = join(root, 'session.json')
  const bridge = new NotionBridge(makeHost(), options(mock, file))
  try {
    await bridge.start()
    await waitFor(() => bridge.snapshot().status === 'authorizing')
    assert.equal((await fetch(bridge.snapshot().authorizationUrl)).status, 200)
    await waitFor(() => bridge.snapshot().status === 'error')
    assert.match(bridge.snapshot().error, /must use HTTPS|configured server origin/)
    assert.equal((await new SessionStore(file).load()).tokens, undefined)
  } finally { await bridge.dispose(); await mock.close(); await rm(root, { recursive: true, force: true }) }
})

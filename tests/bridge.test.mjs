import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { createServer } from 'node:http'
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

test('tool discovery bounds the aggregate size of pages and cursors', async () => {
  const large = 'x'.repeat(4 * 1024 * 1024 + 1024)
  const definition = (name) => ({ name, description: large, inputSchema: { type: 'object' } })
  const cases = [
    { toolPages: [[definition('first')], [definition('second')]] },
    { toolPages: [[], []], pageCursors: ['x'.repeat(8 * 1024 * 1024 + 1)] },
  ]
  for (const config of cases) {
    const mock = await startMockMcp(config)
    const root = await mkdtemp(join(tmpdir(), 'notion-discovery-budget-'))
    const host = makeHost()
    const bridge = new NotionBridge(host, options(mock, join(root, 'session.json')))
    try {
      await bridge.start()
      await waitFor(() => bridge.snapshot().status === 'error')
      assert.match(bridge.snapshot().error, /discovery exceeds the byte limit/)
      assert.equal(host.tools.size, 0)
    } finally { await bridge.dispose(); await mock.close(); await rm(root, { recursive: true, force: true }) }
  }
})

for (const stalled of ['initialize', 'tools/list']) {
  test(`disconnect cancels a stalled ${stalled} SSE request`, async () => {
    const mock = await startMockMcp({ stallOn: stalled })
    const root = await mkdtemp(join(tmpdir(), 'notion-stalled-'))
    const file = join(root, 'session.json')
    const bridge = new NotionBridge(makeHost(), options(mock, file))
    try {
      const starting = bridge.start()
      await waitFor(() => mock.calls.some((call) => call.method === stalled))
      await Promise.race([bridge.disconnect(), delay(1000).then(() => { throw new Error('disconnect was not cancelled') })])
      await starting
      await assert.rejects(stat(file), { code: 'ENOENT' })
    } finally { await bridge.dispose(); await mock.close(); await rm(root, { recursive: true, force: true }) }
  })
}

test('server-initiated request floods and reconnect storms terminate the connection', async () => {
  for (const streamMode of ['flood', 'reconnect', 'events']) {
    const mock = await startMockMcp({ streamMode })
    const root = await mkdtemp(join(tmpdir(), 'notion-stream-budget-'))
    const bridge = new NotionBridge(makeHost(), options(mock, join(root, 'session.json')))
    try {
      await bridge.start()
      await waitFor(() => bridge.snapshot().status === 'error')
      const expected = streamMode === 'flood' ? /too many concurrent requests/ : streamMode === 'reconnect' ? /reopened the event stream too frequently/ : /sent too many events/
      assert.match(bridge.snapshot().error, expected)
      if (streamMode === 'reconnect') assert.ok(mock.streams() <= 8)
    } finally { await bridge.dispose(); await mock.close(); await rm(root, { recursive: true, force: true }) }
  }
})

test('a busy configured callback port preserves existing credentials', async () => {
  const blocker = createServer()
  await new Promise((resolve) => blocker.listen(0, '127.0.0.1', resolve))
  const port = blocker.address().port
  const mock = await startMockMcp()
  const root = await mkdtemp(join(tmpdir(), 'notion-port-busy-'))
  const file = join(root, 'session.json')
  const store = new SessionStore(file)
  const bridge = new NotionBridge(makeHost(), { ...options(mock, file), store, redirectPort: port })
  try {
    await store.patch({ redirectUri: `http://127.0.0.1:${port}/callback`, tokens: { access_token: 'saved', token_type: 'Bearer' } })
    const before = await readFile(file, 'utf8')
    await assert.rejects(bridge.start(), { code: 'EADDRINUSE' })
    assert.equal(await readFile(file, 'utf8'), before)
    assert.equal((await new SessionStore(file).load()).tokens.access_token, 'saved')
  } finally {
    await bridge.dispose(); await mock.close(); await new Promise((resolve) => blocker.close(resolve)); await rm(root, { recursive: true, force: true })
  }
})

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

test('oversized discovery cannot fall back to another authorization path', async () => {
  const mock = await startMockMcp({ oauth: true, oversizedDiscovery: true })
  const root = await mkdtemp(join(tmpdir(), 'notion-large-discovery-'))
  const file = join(root, 'session.json')
  const host = makeHost()
  const bridge = new NotionBridge(host, options(mock, file))
  try {
    await bridge.start()
    await waitFor(() => bridge.snapshot().status === 'error')
    assert.match(bridge.snapshot().error, /byte limit/)
    await delay(100)
    assert.ok(!mock.requests.includes('/register'))
    assert.ok(!mock.requests.includes('/token'))
    assert.equal((await new SessionStore(file).load()).tokens, undefined)
    assert.equal(host.tools.size, 0)
  } finally { await bridge.dispose(); await mock.close(); await rm(root, { recursive: true, force: true }) }
})

test('concurrent authorization requests share one OAuth flow', async () => {
  const mock = await startMockMcp({ oauth: true })
  const root = await mkdtemp(join(tmpdir(), 'notion-concurrent-'))
  const host = makeHost()
  const bridge = new NotionBridge(host, options(mock, join(root, 'session.json')))
  try {
    await bridge.start()
    await waitFor(() => bridge.snapshot().status === 'authorizing')
    await bridge.disconnect()
    const attempts = await Promise.all(Array.from({ length: 4 }, () => bridge.authorize()))
    assert.ok(attempts.every((snapshot) => snapshot.status === 'authorizing'))
    const authorization = bridge.snapshot().authorizationUrl
    assert.ok(authorization)
    assert.equal((await fetch(authorization)).status, 200)
    await waitFor(() => bridge.snapshot().status === 'ready')
    assert.equal(host.tools.size, 5)
  } finally { await bridge.dispose(); await mock.close(); await rm(root, { recursive: true, force: true }) }
})

test('connection failure clears stale tools and permits reconnect without deleting credentials', async () => {
  const mock = await startMockMcp({ oauth: true })
  const root = await mkdtemp(join(tmpdir(), 'notion-reconnect-'))
  const file = join(root, 'session.json')
  const host = makeHost()
  const bridge = new NotionBridge(host, options(mock, file))
  try {
    await bridge.start()
    await waitFor(() => bridge.snapshot().status === 'authorizing')
    await fetch(bridge.snapshot().authorizationUrl)
    await waitFor(() => bridge.snapshot().status === 'ready')
    mock.setUnavailable(true)
    await assert.rejects(host.tools.get('mcp__notion__notion-search').execute({ query: 'plans' }, {}))
    await waitFor(() => bridge.snapshot().status === 'error')
    assert.equal(host.tools.size, 0)
    assert.ok((await new SessionStore(file).load()).tokens)
    mock.setUnavailable(false)
    await bridge.authorize()
    await waitFor(() => bridge.snapshot().status === 'ready')
    assert.equal(host.tools.size, 5)
    assert.match((await host.tools.get('mcp__notion__notion-search').execute({ query: 'plans' }, {})).content[0].text, /Mock Notion page/)
  } finally { await bridge.dispose(); await mock.close(); await rm(root, { recursive: true, force: true }) }
})

test('a broken tool response stream eventually exposes a reconnect path', async () => {
  const mock = await startMockMcp()
  const root = await mkdtemp(join(tmpdir(), 'notion-stream-reconnect-'))
  const host = makeHost()
  const bridge = new NotionBridge(host, { ...options(mock, join(root, 'session.json')), toolCallTimeoutMs: 500 })
  try {
    await bridge.start()
    await waitFor(() => bridge.snapshot().status === 'ready')
    mock.setBrokenStream(true)
    await assert.rejects(host.tools.get('mcp__notion__notion-search').execute({ query: 'plans' }, {}))
    assert.equal(bridge.snapshot().status, 'error')
    assert.match(bridge.snapshot().error, /timed out/)
    assert.equal(host.tools.size, 0)
    mock.setBrokenStream(false)
    await bridge.authorize()
    await waitFor(() => bridge.snapshot().status === 'ready')
    assert.equal(host.tools.size, 5)
  } finally { await bridge.dispose(); await mock.close(); await rm(root, { recursive: true, force: true }) }
})

test('a slow tool timeout does not break other tools or the connection', async () => {
  const mock = await startMockMcp({ toolDelay: 900 })
  const root = await mkdtemp(join(tmpdir(), 'notion-slow-tool-'))
  const host = makeHost()
  const bridge = new NotionBridge(host, { ...options(mock, join(root, 'session.json')), toolCallTimeoutMs: 300 })
  try {
    await bridge.start()
    await waitFor(() => bridge.snapshot().status === 'ready')
    const search = host.tools.get('mcp__notion__notion-search')
    const slow = assert.rejects(search.execute({ query: 'slow' }, {}), /timed out/i)
    assert.match((await search.execute({ query: 'fast' }, {})).content[0].text, /Mock Notion page/)
    await slow
    assert.equal(bridge.snapshot().status, 'ready')
    assert.equal(host.tools.size, 5)
    assert.match((await search.execute({ query: 'again' }, {})).content[0].text, /Mock Notion page/)
  } finally { await bridge.dispose(); await mock.close(); await rm(root, { recursive: true, force: true }) }
})

test('concurrent requests share a rotating token refresh', async () => {
  const mock = await startMockMcp({ oauth: true, rotateRefresh: true, refreshDelay: 80 })
  const root = await mkdtemp(join(tmpdir(), 'notion-refresh-single-flight-'))
  const file = join(root, 'session.json')
  const host = makeHost()
  const bridge = new NotionBridge(host, options(mock, file))
  try {
    await bridge.start()
    await waitFor(() => bridge.snapshot().status === 'authorizing')
    await fetch(bridge.snapshot().authorizationUrl)
    await waitFor(() => bridge.snapshot().status === 'ready')
    mock.expire()
    const [search, resources] = await Promise.all([
      host.tools.get('mcp__notion__notion-search').execute({ query: 'plans' }, {}),
      host.tools.get('mcp__notion__dsh_list_resources').execute({}, {}),
    ])
    assert.match(search.content[0].text, /Mock Notion page/)
    assert.match(resources.content[0].text, /notion:\/\/docs\/example/)
    assert.equal(mock.refreshes(), 1)
    assert.equal((await new SessionStore(file).load()).tokens.refresh_token, 'rotated-refresh-1')
    assert.equal(bridge.snapshot().status, 'ready')
    mock.expire('second-refreshed-access-token')
    mock.delaySecondDiscovery()
    const [again, listed] = await Promise.all([
      host.tools.get('mcp__notion__notion-search').execute({ query: 'again' }, {}),
      host.tools.get('mcp__notion__dsh_list_resources').execute({}, {}),
    ])
    assert.match(again.content[0].text, /Mock Notion page/)
    assert.match(listed.content[0].text, /notion:\/\/docs\/example/)
    assert.equal(mock.refreshes(), 2)
    assert.equal((await new SessionStore(file).load()).tokens.refresh_token, 'rotated-refresh-2')
  } finally { await bridge.dispose(); await mock.close(); await rm(root, { recursive: true, force: true }) }
})

test('disconnect cancels both the refreshing request and a waiting request', async () => {
  const mock = await startMockMcp({ oauth: true, rotateRefresh: true, refreshDelay: 1000 })
  const root = await mkdtemp(join(tmpdir(), 'notion-refresh-cancel-'))
  const file = join(root, 'session.json')
  const host = makeHost()
  const bridge = new NotionBridge(host, options(mock, file))
  try {
    await bridge.start()
    await waitFor(() => bridge.snapshot().status === 'authorizing')
    await fetch(bridge.snapshot().authorizationUrl)
    await waitFor(() => bridge.snapshot().status === 'ready')
    mock.expire()
    const calls = [
      host.tools.get('mcp__notion__notion-search').execute({ query: 'plans' }, {}).catch((error) => error),
      host.tools.get('mcp__notion__dsh_list_resources').execute({}, {}).catch((error) => error),
    ]
    await waitFor(() => mock.refreshes() === 1)
    await Promise.race([bridge.disconnect(), delay(1000).then(() => { throw new Error('disconnect did not cancel refresh') })])
    assert.ok((await Promise.all(calls)).every((error) => error instanceof Error))
    await assert.rejects(stat(file), { code: 'ENOENT' })
    assert.equal(host.tools.size, 0)
    assert.equal(bridge.snapshot().status, 'idle')
  } finally { await bridge.dispose(); await mock.close(); await rm(root, { recursive: true, force: true }) }
})

test('disconnect fences an in-flight refresh even when issuer binding resumes late', async () => {
  const mock = await startMockMcp({ oauth: true })
  const root = await mkdtemp(join(tmpdir(), 'notion-refresh-race-'))
  const file = join(root, 'session.json')
  let entered
  let release
  const bindingStarted = new Promise((resolve) => { entered = resolve })
  const resumeBinding = new Promise((resolve) => { release = resolve })
  class PausingStore extends SessionStore {
    pause = false
    async patch(value, active) {
      if (this.pause && value.clientInformation?.issuer) {
        this.pause = false
        entered()
        await resumeBinding
      }
      return super.patch(value, active)
    }
  }
  const store = new PausingStore(file)
  const host = makeHost()
  const bridge = new NotionBridge(host, { ...options(mock, file), store })
  try {
    await bridge.start()
    await waitFor(() => bridge.snapshot().status === 'authorizing')
    await fetch(bridge.snapshot().authorizationUrl)
    await waitFor(() => bridge.snapshot().status === 'ready')
    const { issuer, ...unstamped } = store.current.clientInformation
    assert.ok(issuer)
    await store.patch({ clientInformation: unstamped })
    store.pause = true
    mock.expire()
    const call = host.tools.get('mcp__notion__notion-search').execute({ query: 'plans' }, {}).catch((error) => error)
    await Promise.race([bindingStarted, delay(3000).then(() => { throw new Error('refresh did not reach issuer binding') })])
    await bridge.disconnect()
    release()
    assert.ok(await call instanceof Error)
    await assert.rejects(stat(file), { code: 'ENOENT' })
    assert.equal((await new SessionStore(file).load()).tokens, undefined)
    assert.equal(host.tools.size, 0)
    assert.equal(bridge.snapshot().status, 'idle')
    await bridge.authorize()
    await waitFor(() => bridge.snapshot().status === 'authorizing')
    await fetch(bridge.snapshot().authorizationUrl)
    await waitFor(() => bridge.snapshot().status === 'ready')
    assert.equal(host.tools.size, 5)
  } finally { release(); await bridge.dispose(); await mock.close(); await rm(root, { recursive: true, force: true }) }
})

test('validates structured results from every tool page and preserves tool errors', async () => {
  const schema = { type: 'object', properties: { count: { type: 'integer', minimum: 1 } }, required: ['count'], additionalProperties: false }
  const definition = (name) => ({ name, inputSchema: { type: 'object' }, outputSchema: schema })
  const mock = await startMockMcp({
    toolPages: [[definition('first')], [definition('last')]],
    toolResult: (message) => {
      const mode = message.params.arguments?.mode
      if (mode === 'error') return { isError: true, content: [{ type: 'text', text: 'Permission denied' }] }
      if (mode === 'missing') return { content: [] }
      return { content: [], structuredContent: { count: mode === 'invalid' ? 0 : 2 } }
    },
  })
  const root = await mkdtemp(join(tmpdir(), 'notion-schema-'))
  const host = makeHost()
  const bridge = new NotionBridge(host, options(mock, join(root, 'session.json')))
  try {
    await bridge.start()
    await waitFor(() => bridge.snapshot().status === 'ready')
    for (const name of ['first', 'last']) {
      const tool = host.tools.get(`mcp__notion__${name}`)
      assert.match((await tool.execute({}, {})).content[0].text, /"count":2/)
      await assert.rejects(tool.execute({ mode: 'invalid' }, {}), /does not match/)
      await assert.rejects(tool.execute({ mode: 'missing' }, {}), /structured (content|output)/i)
      await assert.rejects(tool.execute({ mode: 'error' }, {}), /Permission denied/)
    }
  } finally { await bridge.dispose(); await mock.close(); await rm(root, { recursive: true, force: true }) }
})

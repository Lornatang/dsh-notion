import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { Context, Service } from '@deepseek-ai/cordis'
import { apply } from '../lib/index.js'
import { startMockMcp } from './mock-mcp.mjs'

process.env.DSH_NOTION_ENCRYPTION_KEY = Buffer.alloc(32, 31).toString('base64')

test('rebinds routes when the host connection or web service changes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'notion-route-rebind-'))
  const mock = await startMockMcp()
  const web = () => ({ route: undefined, register(route) { this.route = route; return () => { if (this.route === route) this.route = undefined } } })
  const firstWeb = web()
  const secondWeb = web()
  let currentWeb = firstWeb
  let fence = { requestRejection: () => 401 }
  let changed
  const cleanup = []
  const ctx = {
    tools: { register: () => () => {} },
    logger: { info() {}, warn() {}, error() {} },
    profileContext: { patchPath: join(root, 'cordis.patch.yml') },
    get: (name) => name === 'webServer' ? currentWeb : name === 'connection' ? fence : undefined,
    on: (_name, listener) => { changed = listener; return () => {} },
    effect: (setup) => { cleanup.push(setup()) },
  }
  const server = createServer((req, res) => {
    if (!currentWeb?.route) { res.writeHead(404).end(); return }
    void currentWeb.route.handler(req, res)
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const url = `http://127.0.0.1:${server.address().port}/plugins/notion/status`
  try {
    apply(ctx, { serverName: 'notion', url: mock.url, redirectPort: 0, toolCallTimeoutMs: 5000, authorizationTimeoutMs: 5000, autoOpenBrowser: false })
    assert.equal((await fetch(url)).status, 401)
    fence = { requestRejection: () => undefined }
    changed()
    assert.equal((await fetch(url)).status, 200)
    fence = undefined
    changed()
    assert.equal((await fetch(url)).status, 503)
    fence = { requestRejection: () => undefined }
    currentWeb = secondWeb
    changed()
    assert.equal(firstWeb.route, undefined)
    assert.equal((await fetch(url)).status, 200)
  } finally {
    for (const dispose of cleanup.reverse()) await dispose?.()
    server.closeAllConnections()
    await new Promise((resolve) => server.close(resolve))
    await mock.close()
    await rm(root, { recursive: true, force: true })
  }
})

test('Cordis service proxies do not cause route churn on unrelated events', async () => {
  const root = await mkdtemp(join(tmpdir(), 'notion-cordis-services-'))
  const mock = await startMockMcp()
  const services = new Context()
  let registrations = 0
  let disposals = 0
  class Web extends Service {
    constructor(ctx) { super(ctx, 'webServer') }
    register() { registrations++; return () => { disposals++ } }
  }
  class Fence extends Service {
    constructor(ctx) { super(ctx, 'connection') }
    requestRejection() { return undefined }
  }
  new Web(services)
  new Fence(services)
  let changed
  const cleanup = []
  const ctx = {
    tools: { register: () => () => {} },
    logger: { info() {}, warn() {}, error() {} },
    profileContext: { patchPath: join(root, 'cordis.patch.yml') },
    get: (name) => services.get(name),
    on: (_name, listener) => { changed = listener; return () => {} },
    effect: (setup) => { cleanup.push(setup()) },
  }
  try {
    assert.notEqual(services.get('webServer'), services.get('webServer'))
    assert.notEqual(services.get('connection'), services.get('connection'))
    apply(ctx, { serverName: 'notion', url: mock.url, redirectPort: 0, toolCallTimeoutMs: 5000, authorizationTimeoutMs: 5000, autoOpenBrowser: false })
    for (let i = 0; i < 5; i++) changed('other-service')
    changed('connection')
    assert.equal(registrations, 1)
    assert.equal(disposals, 0)
  } finally {
    for (const dispose of cleanup.reverse()) await dispose?.()
    await mock.close()
    await rm(root, { recursive: true, force: true })
  }
})

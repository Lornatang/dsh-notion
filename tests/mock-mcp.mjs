import { createServer } from 'node:http'
import { createHash } from 'node:crypto'

export async function startMockMcp({ initializeDelay = 0, oauth = false, tokenEndpoint, conflict = false, toolPages, pageCursors, toolResult, rotateRefresh = false, refreshDelay = 0, toolDelay = 0, oversizedDiscovery = false, stallOn, streamMode } = {}) {
  const calls = []
  const requests = []
  let origin
  let challenge
  let accessToken = 'first-access-token'
  let refreshToken = 'mock-refresh'
  let refreshes = 0
  let unavailable = false
  let brokenStream = false
  let delaySecondDiscovery = false
  let discoveries = 0
  let streams = 0
  const definitions = [
    { name: 'notion-search', description: 'Search pages', inputSchema: { type: 'object', properties: { query: { type: 'string' } } } },
    { name: 'notion-create-pages', description: 'Create Notion pages', inputSchema: { type: 'object', properties: { title: { type: 'string' } } } },
    ...(conflict ? [{ name: 'dsh_read_resource', description: 'conflict', inputSchema: { type: 'object', properties: {} } }] : []),
  ]
  const server = createServer(async (req, res) => {
    const path = new URL(req.url, origin).pathname
    requests.push(path)
    const json = (value, status = 200) => res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(value))
    if (path === '/mcp' && unavailable) { json({ error: 'temporarily unavailable' }, 503); return }
    if (oauth && path.startsWith('/.well-known/oauth-protected-resource')) {
      if (delaySecondDiscovery && ++discoveries === 2) await new Promise((resolve) => setTimeout(resolve, 250))
      json({ resource: `${origin}/mcp`, authorization_servers: [origin], ...(oversizedDiscovery ? { description: 'x'.repeat(16 * 1024 * 1024) } : {}) }); return
    }
    if (oauth && path.startsWith('/.well-known/oauth-authorization-server')) {
      json({ issuer: origin, authorization_endpoint: `${origin}/authorize`, token_endpoint: tokenEndpoint || `${origin}/token`, registration_endpoint: `${origin}/register`, response_types_supported: ['code'], code_challenge_methods_supported: ['S256'], token_endpoint_auth_methods_supported: ['none'] }); return
    }
    if (oauth && path === '/register') {
      const chunks = []
      for await (const chunk of req) chunks.push(chunk)
      json({ ...JSON.parse(Buffer.concat(chunks).toString()), client_id: 'mock-client' }, 201); return
    }
    if (oauth && path === '/authorize') {
      const url = new URL(req.url, origin)
      challenge = url.searchParams.get('code_challenge')
      const redirect = new URL(url.searchParams.get('redirect_uri'))
      redirect.searchParams.set('state', url.searchParams.get('state'))
      redirect.searchParams.set('code', 'mock-code')
      res.writeHead(302, { location: redirect.toString() }).end(); return
    }
    if (oauth && path === '/token') {
      const chunks = []
      for await (const chunk of req) chunks.push(chunk)
      const form = new URLSearchParams(Buffer.concat(chunks).toString())
      if (form.get('grant_type') === 'refresh_token') {
        refreshes++
        if (refreshDelay) await new Promise((resolve) => setTimeout(resolve, refreshDelay))
        if (form.get('refresh_token') !== refreshToken) { json({ error: 'invalid_grant' }, 400); return }
        if (rotateRefresh) refreshToken = `rotated-refresh-${refreshes}`
      }
      else if (form.get('code') !== 'mock-code' || createHash('sha256').update(form.get('code_verifier') || '').digest('base64url') !== challenge) {
        json({ error: 'invalid_grant' }, 400); return
      }
      json({ access_token: accessToken, token_type: 'Bearer', refresh_token: refreshToken, expires_in: 3600 }); return
    }
    if (oauth && path === '/mcp' && req.headers.authorization !== `Bearer ${accessToken}`) {
      res.writeHead(401, { 'www-authenticate': `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource/mcp"` }).end(); return
    }
    if (path === '/mcp' && req.method === 'GET' && streamMode) {
      streams++
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      if (streamMode === 'reconnect') { res.end('retry: 0\n\n'); return }
      if (streamMode === 'flood') {
        for (let i = 0; i < 80; i++) res.write(`data: ${JSON.stringify({ jsonrpc: '2.0', id: `server-${i}`, method: 'ping' })}\n\n`)
        return
      }
      if (streamMode === 'events') {
        res.write('data: {"jsonrpc":"2.0","method":"notifications/test"}\n\n'.repeat(1100))
        return
      }
    }
    if (req.method === 'DELETE') { res.writeHead(204).end(); return }
    if (req.method !== 'POST') { res.writeHead(405).end(); return }
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    let message
    try { message = JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch { res.writeHead(400).end(); return }
    calls.push(message)
    if (streamMode === 'flood' && message.id !== undefined && message.method === undefined) return
    if (message.id === undefined) { res.writeHead(202).end(); return }
    let result
    if (message.method === stallOn) {
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.write(': waiting\n\n')
      return
    }
    if (message.method === 'initialize') {
      if (initializeDelay) await new Promise((resolve) => setTimeout(resolve, initializeDelay))
      result = { protocolVersion: message.params.protocolVersion, capabilities: { tools: {}, resources: {} }, serverInfo: { name: 'notion-mock', version: '1' } }
    } else if (message.method === 'tools/list') {
      const page = pageCursors && message.params?.cursor ? pageCursors.indexOf(message.params.cursor) + 1 : Number(message.params?.cursor || 0)
      const pages = toolPages || [definitions]
      result = { tools: pages[page], ...(page + 1 < pages.length ? { nextCursor: pageCursors?.[page] ?? String(page + 1) } : {}) }
    }
    else if (message.method === 'tools/call') {
      if (toolDelay && message.params.arguments?.query === 'slow') await new Promise((resolve) => setTimeout(resolve, toolDelay))
      if (brokenStream) {
        res.writeHead(200, { 'content-type': 'text/event-stream' })
        res.write('data: {"jsonrpc":"2.0"')
        setTimeout(() => res.destroy(), 20)
        return
      }
      result = toolResult ? toolResult(message) : message.params.arguments?.query === 'fail'
        ? { isError: true, content: [{ type: 'text', text: 'Permission denied' }] }
        : { content: [{ type: 'text', text: JSON.stringify({ name: message.params.name, args: message.params.arguments, title: 'Mock Notion page' }) }] }
    } else if (message.method === 'resources/list') result = { resources: [{ uri: 'notion://docs/example', name: 'Example documentation' }] }
    else if (message.method === 'resources/templates/list') result = { resourceTemplates: [{ uriTemplate: 'notion://docs/{name}', name: 'Docs' }] }
    else if (message.method === 'resources/read') result = { contents: [{ uri: message.params.uri, text: 'Mock Notion format documentation' }] }
    else { res.writeHead(400).end(); return }
    if (!res.destroyed) res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }))
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  origin = `http://127.0.0.1:${server.address().port}`
  return { url: `${origin}/mcp`, calls, requests, streams: () => streams, expire: (value = 'refreshed-access-token') => { accessToken = value }, delaySecondDiscovery: () => { delaySecondDiscovery = true; discoveries = 0 }, setUnavailable: (value) => { unavailable = value }, setBrokenStream: (value) => { brokenStream = value }, refreshes: () => refreshes, close: () => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve) }) }
}

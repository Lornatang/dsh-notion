import assert from 'node:assert/strict'
import { test } from 'node:test'
import { limitResponse } from '../lib/response-limit.js'

// Byte-by-byte reference of the SSE accounting, including comment lines as
// events. Compare limits, event counts and output with the production scanner.
function referenceLimit(chunks, maxBytes) {
  let size = 0
  let lineSize = 0
  let lineStartSize = 0
  let comment = false
  let previousCR = false
  let discardFollowingLF = false
  let events = 0
  let limited = false
  const out = []
  const fail = () => { limited = true; throw new Error('limit') }
  try {
    for (const chunk of chunks) {
      for (let index = 0; index < chunk.length; index++) {
        const byte = chunk[index]
        if (byte === 10 && previousCR) {
          previousCR = false
          if (!discardFollowingLF && ++size > maxBytes) fail()
          lineStartSize = size
          continue
        }
        if (++size > maxBytes) fail()
        if (byte === 13) {
          discardFollowingLF = lineSize === 0 || comment
          if (lineSize === 0) { events++; size = 0 }
          else if (comment) { size = lineStartSize; events++ }
          lineSize = 0
          comment = false
          lineStartSize = size
          previousCR = true
        } else if (byte === 10) {
          if (lineSize === 0) { events++; size = 0 }
          else if (comment) { size = lineStartSize; events++ }
          lineSize = 0
          comment = false
          lineStartSize = size
          previousCR = false
        } else {
          if (lineSize === 0) comment = byte === 58
          lineSize++
          previousCR = false
        }
      }
      out.push(chunk)
    }
  } catch { /* limited */ }
  return { limited, events, out: Buffer.concat(out) }
}

async function actualLimit(chunks, maxBytes, contentType = 'text/event-stream') {
  let events = 0
  let limits = 0
  const body = new ReadableStream({ start(controller) { for (const chunk of chunks) controller.enqueue(chunk); controller.close() } })
  const source = new Response(body, { headers: { 'content-type': contentType } })
  const response = await limitResponse(source, maxBytes, () => { limits++ }, undefined, () => { events++ })
  const reader = response.body.getReader()
  const out = []
  let limited = false
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      out.push(Buffer.from(value))
    }
  } catch { limited = true }
  return { limited, events, limits, out: Buffer.concat(out) }
}

const encoder = new TextEncoder()
const chunksOf = (text) => [encoder.encode(text)]

test('comment lines count as SSE events without consuming the byte budget', async () => {
  const bare = await actualLimit(chunksOf(': ping\n'.repeat(5)), 1024)
  assert.equal(bare.limited, false)
  assert.equal(bare.events, 5)
  const blank = await actualLimit(chunksOf(': ping\n\n'), 1024)
  assert.equal(blank.events, 2)
  const crlf = await actualLimit(chunksOf(': ping\r\n\r\n'), 1024)
  assert.equal(crlf.events, 2)
  const repeated = await actualLimit(chunksOf((': ' + 'x'.repeat(10) + '\n').repeat(5)), 16)
  assert.equal(repeated.limited, false)
  assert.equal(repeated.events, 5)
  // A single comment line must still fit the budget: rollback happens at the
  // line end, so an oversized line cannot be buffered without a limit.
  const huge = await actualLimit(chunksOf(': ' + 'x'.repeat(500) + '\n'), 16)
  assert.equal(huge.limited, true)
  assert.equal(huge.events, 0)
})

test('counts decoded bytes at exact SSE boundaries, including split CRLF', async () => {
  const cases = [
    { chunks: ['data: ok\n', '\n'], exact: 10, events: 1 },
    { chunks: ['data: ok\r', '', '\n\r', '\n'], exact: 11, events: 1 },
    { chunks: ['data: ok\r', '\r'], exact: 10, events: 1 },
    { chunks: ['data: 字😀\r', '\n\r', '\n'], exact: 16, events: 1 },
    { chunks: ['data: a\r\n', ': b\r', '\n\r', '\n'], exact: 13, events: 2 },
  ]
  for (const { chunks, exact, events } of cases) {
    const bytes = chunks.map((chunk) => encoder.encode(chunk))
    const accepted = await actualLimit(bytes, exact)
    assert.equal(accepted.limited, false, JSON.stringify(chunks))
    assert.equal(accepted.events, events)
    assert.deepEqual(accepted.out, Buffer.concat(bytes))
    const rejected = await actualLimit(bytes, exact - 1)
    assert.equal(rejected.limited, true, JSON.stringify(chunks))
    assert.equal(rejected.limits, 1)
    assert.equal(rejected.events, 0)
  }
})

test('non-SSE responses keep the total byte limit', async () => {
  const over = await actualLimit(chunksOf('x'.repeat(100)), 64, 'application/json')
  assert.equal(over.limited, true)
  assert.equal(over.events, 0)
  const under = await actualLimit(chunksOf('x'.repeat(64)), 64, 'application/json')
  assert.equal(under.limited, false)
})

test('SSE limiting matches the byte-by-byte reference on random streams', async () => {
  let seed = 42
  const rand = () => { seed = (Math.imul(seed, 1103515245) + 12345) >>> 0; return seed / 4294967296 }
  const pick = (items) => items[Math.floor(rand() * items.length)]
  const tokens = ['data: hello', 'data: {"a":1}', ': keepalive', ':', 'event: x', 'id: 7', 'retry: 100', 'a', '字😀', '\r', '\n', '\r\n', ' ', 'x'.repeat(50), 'data: ' + 'y'.repeat(120)]
  const budgets = [8, 16, 32, 128, 1024, 100000]
  for (let iteration = 0; iteration < 400; iteration++) {
    let text = ''
    const count = 1 + Math.floor(rand() * 150)
    for (let index = 0; index < count; index++) text += pick(tokens)
    const bytes = encoder.encode(text)
    const chunks = []
    for (let offset = 0; offset < bytes.length;) {
      const length = Math.min(bytes.length - offset, 1 + Math.floor(rand() * 64))
      chunks.push(bytes.subarray(offset, offset + length))
      offset += length
    }
    const maxBytes = pick(budgets)
    const expected = referenceLimit(chunks, maxBytes)
    const actual = await actualLimit(chunks, maxBytes)
    const context = `iteration ${iteration} maxBytes ${maxBytes} input ${Buffer.from(bytes).toString('hex').slice(0, 200)}`
    assert.equal(actual.limited, expected.limited, `limited: ${context}`)
    assert.equal(actual.events, expected.events, `events: ${context}`)
    assert.equal(actual.limits, expected.limited ? 1 : 0, `limits: ${context}`)
    assert.ok(actual.out.equals(expected.out), `output: ${context}`)
  }
})

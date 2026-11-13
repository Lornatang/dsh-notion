/** Limit decoded response bytes before the MCP SDK buffers or parses them. */
export const MAX_RESPONSE_BYTES = 16 * 1024 * 1024

type LimitExceeded = () => void

function limitStream(body: ReadableStream<Uint8Array>, maxBytes: number, events: boolean, onLimit: LimitExceeded, onEvent?: () => void): ReadableStream<Uint8Array> {
  let size = 0
  let lineSize = 0
  let lineStartSize = 0
  let comment = false
  let previousCR = false
  let discardFollowingLF = false
  return body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      if (events) {
        // SSE events end at a blank line. Handle CR, LF and CRLF, including
        // separators split across network chunks, without buffering an event.
        for (const byte of chunk) {
          if (byte === 10 && previousCR) {
            previousCR = false
            if (!discardFollowingLF && ++size > maxBytes) { onLimit(); throw new Error('notion: MCP response exceeds the byte limit') }
            lineStartSize = size
            continue
          }
          if (++size > maxBytes) { onLimit(); throw new Error('notion: MCP response exceeds the byte limit') }
          if (byte === 13) {
            discardFollowingLF = lineSize === 0 || comment
            if (lineSize === 0) { onEvent?.(); size = 0 }
            else if (comment) size = lineStartSize
            lineSize = 0
            comment = false
            lineStartSize = size
            previousCR = true
          } else if (byte === 10) {
            if (lineSize === 0) { onEvent?.(); size = 0 }
            else if (comment) size = lineStartSize
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
      } else {
        size += chunk.byteLength
        if (size > maxBytes) { onLimit(); throw new Error('notion: MCP response exceeds the byte limit') }
      }
      controller.enqueue(chunk)
    },
  }))
}

function copyResponse(source: Response, body: ConstructorParameters<typeof Response>[0]): Response {
  const response = new Response(body, { status: source.status, statusText: source.statusText, headers: source.headers })
  // OAuth discovery uses response.url to resolve relative redirect locations.
  Object.defineProperties(response, {
    url: { value: source.url },
    redirected: { value: source.redirected },
    type: { value: source.type },
  })
  return response
}

function observeEnd(body: ReadableStream<Uint8Array>, onEnd: () => void): ReadableStream<Uint8Array> {
  const reader = body.getReader()
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const result = await reader.read()
        if (result.done) { onEnd(); controller.close() }
        else controller.enqueue(result.value)
      } catch (error) { onEnd(); controller.error(error) }
    },
    cancel(reason) { return reader.cancel(reason) },
  })
}

export async function limitResponse(source: Response, maxBytes: number, onLimit: LimitExceeded, onStreamEnd?: () => void, onEvent?: () => void): Promise<Response> {
  if (!source.body) return source
  // The SDK catches errors from response.text() on some authorization paths.
  // Read error responses here so an oversized body cannot be swallowed there.
  const redirect = source.status >= 300 && source.status < 400 && source.headers.has('location')
  if (!source.ok && !redirect) {
    const response = copyResponse(source, limitStream(source.body, maxBytes, false, onLimit))
    const bytes = await response.arrayBuffer()
    return copyResponse(source, bytes.byteLength ? bytes : null)
  }
  const events = source.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase() === 'text/event-stream'
  const body = events && onStreamEnd ? observeEnd(source.body, onStreamEnd) : source.body
  const response = copyResponse(source, limitStream(body, maxBytes, events, onLimit, onEvent))
  if (events) {
    // OAuth endpoints are parsed as a whole even if they claim to be SSE.
    // Whole-body consumers need a total limit in addition to the event limit.
    const wholeBody = (): Response => {
      if (!response.body || response.bodyUsed) throw new TypeError('Response body is already used')
      return copyResponse(source, limitStream(response.body, maxBytes, false, onLimit))
    }
    Object.defineProperties(response, {
      json: { value: () => wholeBody().json() },
      text: { value: () => wholeBody().text() },
      arrayBuffer: { value: () => wholeBody().arrayBuffer() },
      bytes: { value: async () => new Uint8Array(await wholeBody().arrayBuffer()) },
      blob: { value: () => wholeBody().blob() },
      formData: { value: () => wholeBody().formData() },
    })
  }
  return response
}

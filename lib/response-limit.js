/** Limit decoded response bytes before the MCP SDK buffers or parses them. */
export const MAX_RESPONSE_BYTES = 16 * 1024 * 1024;
function limitStream(body, maxBytes, events, onLimit, onEvent) {
    let size = 0;
    let lineSize = 0;
    let lineStartSize = 0;
    let comment = false;
    let previousCR = false;
    let discardFollowingLF = false;
    return body.pipeThrough(new TransformStream({
        transform(chunk, controller) {
            if (events) {
                // SSE events end at a blank line. Handle CR, LF and CRLF, including
                // separators split across network chunks, without buffering an event.
                // Comment (keepalive) lines do not count toward the per-event byte
                // budget, but they DO count as events: otherwise a server could flood
                // bare ": ..." lines forever, bypassing both the byte and rate limits.
                let index = 0;
                while (index < chunk.length) {
                    const byte = chunk[index];
                    if (byte === 10 && previousCR) {
                        previousCR = false;
                        if (!discardFollowingLF && ++size > maxBytes) {
                            onLimit();
                            throw new Error('notion: MCP response exceeds the byte limit');
                        }
                        lineStartSize = size;
                        index++;
                        continue;
                    }
                    if (byte !== 13 && byte !== 10) {
                        // Fast path: skip whole runs of ordinary bytes with native scans
                        // instead of a per-byte loop, preserving the exact accounting.
                        let next = chunk.indexOf(13, index + 1);
                        const lf = chunk.indexOf(10, index + 1);
                        if (lf !== -1 && (next === -1 || lf < next))
                            next = lf;
                        const end = next === -1 ? chunk.length : next;
                        const run = end - index;
                        if (lineSize === 0)
                            comment = byte === 58;
                        lineSize += run;
                        size += run;
                        if (size > maxBytes) {
                            onLimit();
                            throw new Error('notion: MCP response exceeds the byte limit');
                        }
                        previousCR = false;
                        index = end;
                        continue;
                    }
                    if (++size > maxBytes) {
                        onLimit();
                        throw new Error('notion: MCP response exceeds the byte limit');
                    }
                    if (byte === 13) {
                        discardFollowingLF = lineSize === 0 || comment;
                        if (lineSize === 0) {
                            onEvent?.();
                            size = 0;
                        }
                        else if (comment) {
                            size = lineStartSize;
                            onEvent?.();
                        }
                        lineSize = 0;
                        comment = false;
                        lineStartSize = size;
                        previousCR = true;
                    }
                    else {
                        if (lineSize === 0) {
                            onEvent?.();
                            size = 0;
                        }
                        else if (comment) {
                            size = lineStartSize;
                            onEvent?.();
                        }
                        lineSize = 0;
                        comment = false;
                        lineStartSize = size;
                        previousCR = false;
                    }
                    index++;
                }
            }
            else {
                size += chunk.byteLength;
                if (size > maxBytes) {
                    onLimit();
                    throw new Error('notion: MCP response exceeds the byte limit');
                }
            }
            controller.enqueue(chunk);
        },
    }));
}
function copyResponse(source, body) {
    const response = new Response(body, { status: source.status, statusText: source.statusText, headers: source.headers });
    // OAuth discovery uses response.url to resolve relative redirect locations.
    Object.defineProperties(response, {
        url: { value: source.url },
        redirected: { value: source.redirected },
        type: { value: source.type },
    });
    return response;
}
function observeEnd(body, onEnd) {
    const reader = body.getReader();
    return new ReadableStream({
        async pull(controller) {
            try {
                const result = await reader.read();
                if (result.done) {
                    onEnd();
                    controller.close();
                }
                else
                    controller.enqueue(result.value);
            }
            catch (error) {
                onEnd();
                controller.error(error);
            }
        },
        cancel(reason) { return reader.cancel(reason); },
    });
}
export async function limitResponse(source, maxBytes, onLimit, onStreamEnd, onEvent) {
    if (!source.body)
        return source;
    // The SDK catches errors from response.text() on some authorization paths.
    // Read error responses here so an oversized body cannot be swallowed there.
    const redirect = source.status >= 300 && source.status < 400 && source.headers.has('location');
    if (!source.ok && !redirect) {
        const response = copyResponse(source, limitStream(source.body, maxBytes, false, onLimit));
        const bytes = await response.arrayBuffer();
        return copyResponse(source, bytes.byteLength ? bytes : null);
    }
    const events = source.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase() === 'text/event-stream';
    const body = events && onStreamEnd ? observeEnd(source.body, onStreamEnd) : source.body;
    const response = copyResponse(source, limitStream(body, maxBytes, events, onLimit, onEvent));
    if (events) {
        // OAuth endpoints are parsed as a whole even if they claim to be SSE.
        // Whole-body consumers need a total limit in addition to the event limit.
        const wholeBody = () => {
            if (!response.body || response.bodyUsed)
                throw new TypeError('Response body is already used');
            return copyResponse(source, limitStream(response.body, maxBytes, false, onLimit));
        };
        Object.defineProperties(response, {
            json: { value: () => wholeBody().json() },
            text: { value: () => wholeBody().text() },
            arrayBuffer: { value: () => wholeBody().arrayBuffer() },
            bytes: { value: async () => new Uint8Array(await wholeBody().arrayBuffer()) },
            blob: { value: () => wholeBody().blob() },
            formData: { value: () => wholeBody().formData() },
        });
    }
    return response;
}

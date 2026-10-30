import { Readable } from 'node:stream'
import { setFlagsFromString } from 'node:v8'
import { runInNewContext } from 'node:vm'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { EsploraClient, MempoolQbitClient, QbitApiError, type RequestOptions } from '../src/index'
import { redactBaseUrl, responseBodyPreview } from '../src/errors'

// maxResponseBytes holds on every read path: a Node stream body (node-fetch's)
// is counted as it arrives and destroyed at the limit, a body read whole is
// measured in wire bytes, de-duplicated waiters share one copy of the body,
// and an error keeps only a bounded, detached preview of it.

const BASE = 'https://esplora.example/regtest/api'
const TXID = 'ab'.repeat(32)
const LIMIT = 64 * 1024
const CHUNK = 4 * 1024
/** The error-preview cases build and redact multi-megabyte bodies, which takes seconds on a slow CI runner. */
const SCALE_TIMEOUT_MS = 60_000
const noSleep = () => Promise.resolve()

function client(fetchFn: typeof fetch, options: { timeoutMs?: number; retries?: number } = {}): EsploraClient {
  return new EsploraClient({ baseUrl: BASE, fetchFn, sleepFn: noSleep, maxResponseBytes: LIMIT, ...options })
}

/** A client that exposes the raw text of a GET. */
class RawClient extends EsploraClient {
  raw(path: string, options?: RequestOptions): Promise<string> {
    return this.getText(path, options)
  }
}

async function rejection(promise: Promise<unknown>): Promise<QbitApiError> {
  const error = await promise.then(
    () => undefined,
    (caught: unknown) => caught
  )
  expect(QbitApiError.is(error)).toBe(true)
  return error as QbitApiError
}

/**
 * A Response-like reply as node-fetch v2 and v3 return it: `body` is a Node
 * `Readable` (without `getReader`), and `text()` and `arrayBuffer()` buffer
 * the whole stream. They give up past `bufferCap` bytes, so a client that
 * buffers an endless body fails here instead of exhausting the test's memory.
 */
function nodeFetchReply(stream: Readable, status = 200, bufferCap = 16 * LIMIT): Response {
  const buffer = async (): Promise<Buffer> => {
    const chunks: Buffer[] = []
    let length = 0
    for await (const chunk of stream) {
      chunks.push(chunk as Buffer)
      length += (chunk as Buffer).length
      if (length > bufferCap) {
        stream.destroy()
        throw new Error(`buffered ${length} bytes of a body that does not end`)
      }
    }
    return Buffer.concat(chunks)
  }
  return {
    status,
    statusText: '',
    ok: status >= 200 && status <= 299,
    url: '',
    headers: new Headers(),
    body: stream,
    bodyUsed: false,
    text: async () => (await buffer()).toString('utf8'),
    arrayBuffer: async () => {
      const bytes = await buffer()
      return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length)
    },
  } as unknown as Response
}

/** A Node stream that never ends, producing a chunk whenever it is read. */
function endlessReadable(): { stream: Readable; readonly produced: number } {
  let produced = 0
  const stream = new Readable({
    highWaterMark: CHUNK,
    read() {
      produced += CHUNK
      this.push(Buffer.alloc(CHUNK, 0x61))
    },
  })
  return {
    stream,
    get produced() {
      return produced
    },
  }
}

describe('a Node stream body (node-fetch)', () => {
  it('is counted as it arrives and destroyed at the limit, for a read and a submission', async () => {
    for (const [status, call, kind] of [
      [200, (c: EsploraClient) => c.getTx(TXID), 'response_too_large'],
      [500, (c: EsploraClient) => c.broadcastTx('00'), 'unknown_outcome'],
    ] as const) {
      const bodies: ReturnType<typeof endlessReadable>[] = []
      const fetchFn = (async () => {
        const body = endlessReadable()
        bodies.push(body)
        return nodeFetchReply(body.stream, status)
      }) as typeof fetch

      const started = performance.now()
      const error = await rejection(call(client(fetchFn, { timeoutMs: 10_000 })))
      expect(error.kind).toBe(kind)
      if (kind === 'unknown_outcome') expect(error.cause).toMatchObject({ kind: 'response_too_large', status })
      expect(bodies).toHaveLength(1)
      // Stopped at the first chunk past the limit (the stream may read one ahead), long before timeoutMs.
      expect(bodies[0]!.produced).toBeGreaterThan(LIMIT)
      expect(bodies[0]!.produced).toBeLessThanOrEqual(LIMIT + 2 * CHUNK)
      expect(performance.now() - started).toBeLessThan(5_000)
      await new Promise(resolve => setImmediate(resolve))
      expect(bodies[0]!.stream.destroyed).toBe(true)
    }

    // Under the limit it is read whole, a character split between chunks included.
    const text = JSON.stringify({ txid: TXID, note: 'é😀'.repeat(1_000) })
    const bytes = Buffer.from(text)
    // Chunks of 7 bytes split the 2- and 4-byte characters.
    const chunks = Array.from({ length: Math.ceil(bytes.length / 7) }, (_, i) => bytes.subarray(7 * i, 7 * i + 7))
    const chunked = (async () => nodeFetchReply(Readable.from(chunks))) as typeof fetch
    await expect(client(chunked).getTx(TXID)).resolves.toEqual(JSON.parse(text))

    // Exactly maxResponseBytes passes, counting bytes and not characters.
    const atLimit = JSON.stringify('é'.repeat((LIMIT - 2) / 2))
    const overLimit = JSON.stringify('é'.repeat(LIMIT / 2 - 1) + 'e')
    let body = atLimit
    const whole = (async () => nodeFetchReply(Readable.from([Buffer.from(body)]))) as typeof fetch
    const c = client(whole)
    await expect(c.getTx(TXID)).resolves.toBe(JSON.parse(atLimit))
    body = overLimit
    await expect(c.getTx(TXID)).rejects.toMatchObject({ kind: 'response_too_large' })
  })

  it('reads any async iterable of bytes, and returns its iterator at the limit', async () => {
    let produced = 0
    let returned = false
    const body = {
      [Symbol.asyncIterator]() {
        return {
          next: async () => {
            produced += CHUNK
            return { done: false, value: new Uint8Array(CHUNK).fill(0x61) }
          },
          return: async () => {
            returned = true
            return { done: true, value: undefined }
          },
        }
      },
    }
    const fetchFn = (async () =>
      ({ status: 200, statusText: '', url: '', headers: new Headers(), body }) as unknown as Response) as typeof fetch

    await expect(client(fetchFn).getTx(TXID)).rejects.toMatchObject({ kind: 'response_too_large' })
    expect(produced).toBe(LIMIT + CHUNK)
    expect(returned).toBe(true)
  })
})

describe('a body without a stream, read whole', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  /** A response with no `body` stream to read, as React Native's fetch returns. */
  function withoutStream(bytes: Uint8Array<ArrayBuffer>, extra: Record<string, unknown> = {}): Response {
    return Object.defineProperties(new Response(bytes), {
      body: { value: null },
      ...Object.fromEntries(Object.entries(extra).map(([key, value]) => [key, { value }])),
    })
  }

  function raw(fetchFn: typeof fetch): RawClient {
    return new RawClient({ baseUrl: BASE, fetchFn, sleepFn: noSleep, maxResponseBytes: LIMIT })
  }

  it('is measured in wire bytes through blob(), before its text is read', async () => {
    // Latin-1 'é' is one byte on the wire, which decodes to U+FFFD, three bytes in UTF-8.
    let bytes = new Uint8Array(LIMIT).fill(0xe9)
    const text = vi.spyOn(Blob.prototype, 'text')
    const c = raw((async () => withoutStream(bytes)) as typeof fetch)
    await expect(c.raw('/blocks/tip/hash')).resolves.toBe('\ufffd'.repeat(LIMIT))
    expect(text).toHaveBeenCalledTimes(1)

    bytes = new Uint8Array(LIMIT + 1).fill(0xe9)
    await expect(c.raw('/blocks/tip/hash')).rejects.toMatchObject({ kind: 'response_too_large' })
    expect(text).toHaveBeenCalledTimes(1)

    // A binary body, stray UTF-8 lead bytes included.
    bytes = new Uint8Array(LIMIT).map((_, i) => (i * 37) & 0xff)
    await expect(c.raw('/blocks/tip/hash')).resolves.toBe(new TextDecoder().decode(bytes))
  })

  it("reads React Native's Blob, which has no text(), without arrayBuffer(), which RN 0.71 and earlier lack", async () => {
    let bytes = new Uint8Array(LIMIT).fill(0xe9)
    const arrayBuffer = vi.fn(() => Promise.reject(new Error('FileReader.readAsArrayBuffer is not implemented')))
    const reply = () =>
      withoutStream(bytes, {
        arrayBuffer,
        // A Blob without text() or arrayBuffer(): it is read through a Response.
        blob: async () =>
          Object.defineProperties(new Blob([bytes]), { text: { value: undefined }, arrayBuffer: { value: undefined } }),
      })
    const c = raw((async () => reply()) as typeof fetch)
    await expect(c.raw('/blocks/tip/hash')).resolves.toBe('\ufffd'.repeat(LIMIT))
    bytes = new Uint8Array(LIMIT + 1).fill(0xe9)
    await expect(c.raw('/blocks/tip/hash')).rejects.toMatchObject({ kind: 'response_too_large' })
    expect(arrayBuffer).not.toHaveBeenCalled()
  })

  it('measures a blob without a size as its text', async () => {
    let body = 'é'.repeat(LIMIT / 2)
    const reply = () => withoutStream(new Uint8Array(0), { blob: async () => ({ text: async () => body }) })
    const c = raw((async () => reply()) as typeof fetch)
    await expect(c.raw('/blocks/tip/hash')).resolves.toBe(body)
    body += 'e'
    await expect(c.raw('/blocks/tip/hash')).rejects.toMatchObject({ kind: 'response_too_large' })
  })

  it('is measured in wire bytes through arrayBuffer() where there is no blob()', async () => {
    let bytes = new Uint8Array(LIMIT).fill(0xe9)
    const fetchFn = (async () =>
      ({
        status: 200,
        statusText: 'OK',
        url: '',
        headers: new Headers(),
        body: null,
        arrayBuffer: async () => bytes.buffer,
        text: async () => new TextDecoder().decode(bytes),
      }) as unknown as Response) as typeof fetch
    const c = raw(fetchFn)
    await expect(c.raw('/blocks/tip/hash')).resolves.toBe('\ufffd'.repeat(LIMIT))
    bytes = new Uint8Array(LIMIT + 1).fill(0xe9)
    await expect(c.raw('/blocks/tip/hash')).rejects.toMatchObject({ kind: 'response_too_large' })
  })
})

describe('without a global TextDecoder', () => {
  const saved = Object.getOwnPropertyDescriptor(globalThis, 'TextDecoder')!
  const Decoder = TextDecoder
  afterEach(() => {
    Object.defineProperty(globalThis, 'TextDecoder', saved)
  })

  it('still stops a web stream at the limit, instead of buffering it through text()', async () => {
    let produced = 0
    const fetchFn = (async () =>
      new Response(
        new ReadableStream<Uint8Array>(
          {
            pull(controller) {
              produced += CHUNK
              controller.enqueue(new Uint8Array(CHUNK).fill(0x61))
              // Ends far past the limit, so a client that buffers it all fails here, not out of memory.
              if (produced >= 16 * LIMIT) controller.close()
            },
          },
          { highWaterMark: 0 }
        )
      )) as typeof fetch
    Reflect.deleteProperty(globalThis, 'TextDecoder')

    const error = await rejection(client(fetchFn, { timeoutMs: 10_000 }).getTx(TXID))
    expect(error).toMatchObject({ kind: 'response_too_large' })
    expect(produced).toBe(LIMIT + CHUNK)
  })

  it('decodes UTF-8 as TextDecoder does, in any chunking', async () => {
    // Valid and invalid sequences: overlongs, surrogates, out-of-range and
    // truncated sequences, stray continuation bytes and a leading BOM.
    const cases: number[][] = [
      [0xef, 0xbb, 0xbf, 0x61],
      [0x61, 0xef, 0xbb, 0xbf],
      [0xc0, 0x80, 0xc1, 0xbf, 0xc2, 0x80, 0xdf, 0xbf],
      [0xe0, 0x80, 0x80, 0xe0, 0xa0, 0x80, 0xed, 0x9f, 0xbf, 0xed, 0xa0, 0x80, 0xef, 0xbf, 0xbf],
      [0xf0, 0x80, 0x80, 0x80, 0xf0, 0x90, 0x80, 0x80, 0xf4, 0x8f, 0xbf, 0xbf, 0xf4, 0x90, 0x80, 0x80],
      [0xf5, 0x80, 0xff, 0xfe, 0x80, 0xbf, 0xe2, 0x82, 0x41, 0xf0, 0x9f, 0x98, 0xe2, 0x82, 0xac],
      [0xf0, 0x9f, 0x98],
    ]
    let seed = 7
    const random = () => {
      seed = (seed * 1_103_515_245 + 12_345) % 2 ** 31
      return seed / 2 ** 31
    }
    for (let i = 0; i < 200; i += 1) {
      // Random bytes, biased toward the bytes multi-byte sequences use.
      const pool = [
        0x00, 0x41, 0x7f, 0x80, 0x9f, 0xa0, 0xbf, 0xc0, 0xc2, 0xdf, 0xe0, 0xed, 0xef, 0xf0, 0xf4, 0xf5, 0xff,
      ]
      cases.push(
        Array.from({ length: 1 + Math.floor(random() * 40) }, () =>
          random() < 0.6 ? pool[Math.floor(random() * pool.length)]! : Math.floor(random() * 256)
        )
      )
    }
    const expected = cases.map(bytes => new Decoder().decode(Uint8Array.from(bytes)))
    let body: number[] = []
    let split = 1
    // A Response-like object with only a body stream, which the client must decode itself.
    const fetchFn = (async () =>
      ({
        status: 200,
        statusText: 'OK',
        url: '',
        headers: new Headers(),
        body: new ReadableStream<Uint8Array>({
          start(controller) {
            for (let at = 0; at < body.length; at += split)
              controller.enqueue(Uint8Array.from(body.slice(at, at + split)))
            controller.close()
          },
        }),
      }) as unknown as Response) as typeof fetch
    const c = new RawClient({ baseUrl: BASE, fetchFn, sleepFn: noSleep })
    Reflect.deleteProperty(globalThis, 'TextDecoder')

    for (const [index, bytes] of cases.entries()) {
      body = bytes
      for (split of [1, 2, 3, bytes.length]) {
        await expect(c.raw('/blocks/tip/hash'), `case ${index}, chunks of ${split}`).resolves.toBe(expected[index])
      }
    }
  })
})

describe('de-duplicated waiters', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('share one copy of the body: it is decoded once and never encoded again, whatever the number of waiters', async () => {
    const reply = JSON.stringify({ txid: TXID, pad: 'x'.repeat(LIMIT - 100) })
    // The backend's bytes, as fetch hands them over, encoded before the spies count.
    const bytes = new TextEncoder().encode(reply)
    const decode = vi.spyOn(TextDecoder.prototype, 'decode')
    const encode = vi.spyOn(TextEncoder.prototype, 'encode')
    const counts: { waiters: number; decodes: number; encodes: number }[] = []

    for (const waiters of [1, 8]) {
      let calls = 0
      const fetchFn = (async () => {
        calls += 1
        return new Response(bytes)
      }) as typeof fetch
      const c = client(fetchFn)
      decode.mockClear()
      encode.mockClear()

      const replies = await Promise.all(Array.from({ length: waiters }, () => c.getTx(TXID)))
      counts.push({ waiters, decodes: decode.mock.calls.length, encodes: encode.mock.calls.length })
      expect(calls).toBe(1)
      for (const value of replies) expect(value).toEqual(JSON.parse(reply))
      // Each waiter parses its own value, so one caller's changes reach no other.
      ;(replies[0] as unknown as { txid: string }).txid = 'changed'
      if (waiters > 1) expect(replies[1]).toMatchObject({ txid: TXID })
    }

    expect(counts[1]!.decodes).toBe(counts[0]!.decodes)
    expect(counts.map(count => count.encodes)).toEqual([0, 0])

    // A subclass reading request()'s replies itself still gets a whole Response each.
    class Requesting extends EsploraClient {
      fetchRaw(): Promise<Response> {
        return this.request('/blocks/tip/hash', { method: 'GET', dedup: true })
      }
    }
    const tip = (async () => new Response('tip-hash')) as typeof fetch
    const requesting = new Requesting({ baseUrl: BASE, fetchFn: tip, sleepFn: noSleep })

    const responses = await Promise.all([requesting.fetchRaw(), requesting.fetchRaw(), requesting.fetchRaw()])
    expect(new Set(responses).size).toBe(3)
    expect(await Promise.all(responses.map(response => response.text()))).toEqual(['tip-hash', 'tip-hash', 'tip-hash'])
    const [first] = await Promise.all([requesting.fetchRaw(), requesting.fetchRaw()])
    expect(new TextDecoder().decode(await first!.arrayBuffer())).toBe('tip-hash')
  })
})

describe('error previews', { timeout: SCALE_TIMEOUT_MS }, () => {
  const gc = (() => {
    setFlagsFromString('--expose-gc')
    return runInNewContext('gc') as () => void
  })()

  /** Memory held by JavaScript values: Node keeps a large decoded string outside the heap, as `external`. */
  function heapUsed(): number {
    // V8 keeps the last string a regex ran on (the legacy RegExp.input), which
    // can be the last body read; one more match replaces it.
    ;/x/.exec('x')
    gc()
    gc()
    const { heapUsed, external } = process.memoryUsage()
    return heapUsed + external
  }

  it('keep only a bounded, detached preview of a body, the one redacting the whole body would give', async () => {
    const BODY = 4 * 1024 * 1024
    const ERRORS = 8
    const options = { baseUrl: BASE, retries: 0, sleepFn: noSleep, maxResponseBytes: 2 * BODY }
    const calls: [string, number, (fetchFn: typeof fetch) => Promise<unknown>, string?][] = [
      ['http', 500, fetchFn => new EsploraClient({ ...options, fetchFn }).getTx(TXID)],
      ['rate_limit', 429, fetchFn => new EsploraClient({ ...options, fetchFn }).getTx(TXID)],
      // JSON.parse's own SyntaxError, kept as the unredacted cause, holds the text it failed on.
      ['parse', 200, fetchFn => new EsploraClient({ ...options, fetchFn }).getTx(TXID)],
      // Here V8's message quotes the start of the body.
      ['parse', 200, fetchFn => new EsploraClient({ ...options, fetchFn }).getTx(TXID), 'x'],
      ['http', 400, fetchFn => new EsploraClient({ ...options, fetchFn }).getTipHash()],
      ['unknown_outcome', 503, fetchFn => new EsploraClient({ ...options, fetchFn }).broadcastTx('00')],
      // Its raw preview is kept for the /tx/push decision too.
      ['http', 400, fetchFn => new MempoolQbitClient({ ...options, fetchFn }).broadcastTx('00')],
    ]
    for (const [kind, status, call, prefix = ''] of calls) {
      let n = 0
      const fetchFn = (async () => {
        n += 1
        // A distinct body each time, which is neither JSON nor a txid.
        return new Response(`${prefix}${n} ${'q'.repeat(BODY)}`, { status })
      }) as typeof fetch

      const before = heapUsed()
      const errors: QbitApiError[] = []
      for (let i = 0; i < ERRORS; i += 1) errors.push(await rejection(call(fetchFn)))
      const retained = heapUsed() - before

      for (const error of errors) {
        expect(error.kind).toBe(kind)
        expect((error.responseBody ?? '').length).toBeLessThanOrEqual(200)
        if (kind === 'parse') {
          const original = QbitApiError.unredactedCause(error) as SyntaxError
          expect(original).toBeInstanceOf(SyntaxError)
          expect(original.message).toMatch(/JSON/)
          expect(original.stack).toContain(original.message)
        }
      }
      // ERRORS bodies of BODY bytes would be 32 MiB; their previews are a few kB.
      // Up to two bodies' worth is allowed for buffers the runtime has not yet freed.
      expect(retained, `${kind} ${status}`).toBeLessThan(2 * BODY)
      errors.length = 0
    }

    // Built from a bounded prefix, a preview is still the one redacted from the whole body.
    const baseUrls = [
      BASE,
      'https://user:secretpassword@indexer.example/key-0123456789abcdef/api?token=abcdefgh12345678',
      'https://indexer.example/' + 'k'.repeat(300) + '/api',
      'https://indexer.example',
    ]
    let seed = 11
    const random = (n: number) => {
      seed = (seed * 1_103_515_245 + 12_345) % 2 ** 31
      return Math.floor((seed / 2 ** 31) * n)
    }
    for (const baseUrl of baseUrls) {
      const url = new URL(baseUrl)
      const pieces = [
        baseUrl,
        url.href,
        url.pathname,
        ...url.pathname.split('/'),
        url.password,
        url.searchParams.get('token') ?? '',
        ' ',
        '\n',
        'x',
        'é',
        '😀',
        'plain text ',
      ].filter(piece => piece !== '')
      const bodies = [
        // Runs of one base-URL part shrink most when redacted, so the window must cover them.
        ...pieces.map(piece => `${piece.repeat(2_000)} tail`),
        ...Array.from({ length: 300 }, () =>
          Array.from({ length: random(400) }, () => pieces[random(pieces.length)]).join('')
        ),
      ]
      for (const body of bodies) {
        expect(responseBodyPreview(body, baseUrl)).toBe(redactBaseUrl(body.trim(), baseUrl).slice(0, 200))
      }
    }
  })
})

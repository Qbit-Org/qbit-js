import { describe, expect, it } from 'vitest'

import { DEFAULT_MAX_RESPONSE_BYTES, EsploraClient, MempoolQbitClient, QbitApiError, txidFromRawTx } from '../src/index'

const BASE = 'https://esplora.example/regtest/api'
/** BASE as errors show it: the origin, with the base path redacted. */
const SAFE_BASE = 'https://esplora.example/...'
const TXID = 'ab'.repeat(32)
const LIMIT = 64 * 1024
const CHUNK = 4 * 1024
const noSleep = () => Promise.resolve()

interface EndlessBody {
  stream: ReadableStream<Uint8Array>
  /** Bytes the body has handed to its reader. */
  readonly produced: number
  readonly cancelled: boolean
}

/** A body that never ends, producing a chunk only when its reader asks for one. */
function endlessBody(): EndlessBody {
  let produced = 0
  let cancelled = false
  const stream = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        produced += CHUNK
        controller.enqueue(new Uint8Array(CHUNK).fill(0x61))
      },
      cancel() {
        cancelled = true
      },
    },
    { highWaterMark: 0 }
  )
  return {
    stream,
    get produced() {
      return produced
    },
    get cancelled() {
      return cancelled
    },
  }
}

interface Reply {
  status?: number
  headers?: Record<string, string>
  body?: string | ReadableStream<Uint8Array>
}

function makeFetch(handler: (url: string, init: RequestInit | undefined) => Reply | Response) {
  const calls: { url: string; method: string }[] = []
  const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    calls.push({ url, method: init?.method ?? 'GET' })
    const reply = handler(url, init)
    if (reply instanceof Response) return reply
    return new Response(reply.body ?? '', { status: reply.status ?? 200, headers: reply.headers ?? {} })
  }) as typeof fetch
  return { fetchFn, calls }
}

function client(fetchFn: typeof fetch, maxResponseBytes?: number): EsploraClient {
  return new EsploraClient({ baseUrl: BASE, fetchFn, sleepFn: noSleep, maxResponseBytes: maxResponseBytes ?? LIMIT })
}

/** A client with every option at its default. */
function defaultClient(fetchFn: typeof fetch): EsploraClient {
  return new EsploraClient({ baseUrl: BASE, fetchFn, sleepFn: noSleep })
}

async function rejection(promise: Promise<unknown>): Promise<QbitApiError> {
  const error = await promise.then(
    () => undefined,
    (caught: unknown) => caught
  )
  expect(QbitApiError.is(error)).toBe(true)
  return error as QbitApiError
}

describe('maxResponseBytes option', () => {
  it('is validated like the other integer options', () => {
    const { fetchFn } = makeFetch(() => ({}))
    for (const bad of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 53, null, '1024']) {
      for (const Client of [EsploraClient, MempoolQbitClient]) {
        expect(() => new Client({ baseUrl: BASE, fetchFn, maxResponseBytes: bad as number })).toThrow(
          expect.objectContaining({
            kind: 'http',
            message: 'maxResponseBytes must be an integer from 1 to 9007199254740991',
          })
        )
      }
    }
    for (const good of [1, LIMIT, Number.MAX_SAFE_INTEGER, undefined]) {
      for (const Client of [EsploraClient, MempoolQbitClient]) {
        // An explicit undefined, as a JS caller can pass, takes the default.
        expect(() => new Client({ baseUrl: BASE, fetchFn, maxResponseBytes: good as number })).not.toThrow()
      }
    }
  })
})

describe('EsploraClient reads over maxResponseBytes', () => {
  it.each([
    ['getJson (getTx)', 200, (c: EsploraClient) => c.getTx(TXID)],
    ['getText (getTxHex)', 200, (c: EsploraClient) => c.getTxHex(TXID)],
    ['a transient 503', 503, (c: EsploraClient) => c.getTx(TXID)],
    ['a 429 with Retry-After', 429, (c: EsploraClient) => c.getTipHeight()],
  ])(
    'fail %s at once as response_too_large, stop reading near the limit, and do not retry',
    async (_name, status, call) => {
      const bodies: EndlessBody[] = []
      const { fetchFn, calls } = makeFetch(() => {
        const body = endlessBody()
        bodies.push(body)
        return { status, headers: { 'retry-after': '0' }, body: body.stream }
      })

      const started = performance.now()
      const error = await rejection(call(client(fetchFn)))
      expect(error).toMatchObject({
        kind: 'response_too_large',
        status,
        url: expect.stringContaining(SAFE_BASE),
        message: expect.stringContaining(`exceeded maxResponseBytes (${LIMIT} bytes)`),
      })
      // One attempt, never the timeoutMs it would take a body that never ends to time out.
      expect(calls).toHaveLength(1)
      expect(performance.now() - started).toBeLessThan(5_000)
      // Reading stopped at the first chunk past the limit, and the body was cancelled.
      expect(bodies[0]!.produced).toBe(LIMIT + CHUNK)
      expect(bodies[0]!.cancelled).toBe(true)
    }
  )

  it('accepts a body of exactly maxResponseBytes, counting bytes and not characters', async () => {
    // 'é' is two bytes in UTF-8.
    const atLimit = JSON.stringify('é'.repeat((LIMIT - 2) / 2))
    expect(new TextEncoder().encode(atLimit)).toHaveLength(LIMIT)
    const overLimit = JSON.stringify('é'.repeat(LIMIT / 2 - 1) + 'e')
    expect(overLimit).toHaveLength(LIMIT / 2 + 2)
    expect(new TextEncoder().encode(overLimit)).toHaveLength(LIMIT + 1)

    let body = atLimit
    const { fetchFn } = makeFetch(() => ({ body }))
    const c = client(fetchFn)
    await expect(c.getTx(TXID)).resolves.toBe(JSON.parse(atLimit))
    body = overLimit
    await expect(c.getTx(TXID)).rejects.toMatchObject({ kind: 'response_too_large' })
  })

  it('measures a body without a readable stream after text(), in UTF-8 bytes', async () => {
    // React Native's fetch: a Response-like object whose body is only text().
    let text = ''
    const fetchFn = (async () =>
      ({
        status: 200,
        statusText: 'OK',
        ok: true,
        url: '',
        headers: new Headers(),
        body: null,
        bodyUsed: false,
        text: async () => text,
      }) as unknown as Response) as typeof fetch
    const c = client(fetchFn)

    text = JSON.stringify('é'.repeat((LIMIT - 2) / 2))
    await expect(c.getTx(TXID)).resolves.toBe(JSON.parse(text))
    text = JSON.stringify('é'.repeat(LIMIT / 2 - 1) + 'e')
    await expect(c.getTx(TXID)).rejects.toMatchObject({ kind: 'response_too_large', status: 200 })
    // Four bytes for a surrogate pair, three for a lone surrogate.
    text = '😀'.repeat(LIMIT / 4)
    await expect(c.getTipHash()).resolves.toBe(text)
    text = `${'😀'.repeat(LIMIT / 4 - 1)}\ud800\ud800`
    await expect(c.getTipHash()).rejects.toMatchObject({ kind: 'response_too_large' })
  })

  it('shares one limit between de-duplicated waiters', async () => {
    const bodies: EndlessBody[] = []
    const { fetchFn, calls } = makeFetch(() => {
      const body = endlessBody()
      bodies.push(body)
      return { body: body.stream }
    })
    const c = client(fetchFn)

    const errors = await Promise.all([c.getTx(TXID), c.getTx(TXID), c.getTx(TXID)].map(rejection))
    expect(calls).toHaveLength(1)
    expect(bodies[0]!.produced).toBe(LIMIT + CHUNK)
    // Every waiter gets the one request's error.
    expect(errors[0]).toMatchObject({ kind: 'response_too_large' })
    expect(errors[1]).toBe(errors[0])
    expect(errors[2]).toBe(errors[0])

    // Under the limit, every waiter reads the one reply.
    const reply = JSON.stringify({ txid: TXID, pad: 'x'.repeat(LIMIT - 100) })
    const shared = makeFetch(() => ({ body: reply }))
    const d = client(shared.fetchFn)
    const replies = await Promise.all([d.getTx(TXID), d.getTx(TXID), d.getTx(TXID)])
    expect(shared.calls).toHaveLength(1)
    expect(replies).toEqual([JSON.parse(reply), JSON.parse(reply), JSON.parse(reply)])
  })

  it('passes a custom fetchFn’s own response_too_large through without retrying a read', async () => {
    let attempts = 0
    const thrown = new QbitApiError('response_too_large', 'proxy refused a large body')
    const fetchFn = (async () => {
      attempts += 1
      throw thrown
    }) as typeof fetch
    await expect(client(fetchFn).getTx(TXID)).rejects.toBe(thrown)
    expect(attempts).toBe(1)
  })
})

describe('broadcastTx replies over maxResponseBytes', () => {
  // Version 2, one input, one output, no witness: its txid is derived from the hex.
  const RAW_TX = `02000000 01 ${'11'.repeat(32)} 00000000 00 ffffffff 01 e803000000000000 01 51 00000000`.replace(
    / /g,
    ''
  )

  it.each([200, 400, 500])('end a %i reply as unknown_outcome, sent once', async status => {
    const bodies: EndlessBody[] = []
    const { fetchFn, calls } = makeFetch(() => {
      const body = endlessBody()
      bodies.push(body)
      return { status, body: body.stream }
    })

    const error = await rejection(client(fetchFn).broadcastTx(RAW_TX))
    expect(error).toMatchObject({
      kind: 'unknown_outcome',
      status,
      url: `${SAFE_BASE}/tx`,
      txid: expect.stringMatching(/^[0-9a-f]{64}$/),
      message: expect.stringContaining(`HTTP ${status} reply body exceeded maxResponseBytes (${LIMIT} bytes)`),
    })
    expect(error.cause).toMatchObject({ kind: 'response_too_large', status })
    expect(calls).toEqual([{ url: `${BASE}/tx`, method: 'POST' }])
    expect(bodies[0]!.produced).toBe(LIMIT + CHUNK)
    expect(bodies[0]!.cancelled).toBe(true)
  })

  it('ends a 429 over the limit as unknown_outcome without re-sending it, whatever its Retry-After', async () => {
    // Its body could have said the node already has the transaction, or that
    // the backend lost its node connection; the client stopped before reading it.
    for (const retryAfter of ['1', '3600']) {
      const bodies: EndlessBody[] = []
      const { fetchFn, calls } = makeFetch(() => {
        const body = endlessBody()
        bodies.push(body)
        return { status: 429, headers: { 'retry-after': retryAfter }, body: body.stream }
      })

      const error = await rejection(client(fetchFn).broadcastTx(RAW_TX))
      expect(error).toMatchObject({
        kind: 'unknown_outcome',
        status: 429,
        url: `${SAFE_BASE}/tx`,
        txid: expect.stringMatching(/^[0-9a-f]{64}$/),
        message: expect.stringContaining(`HTTP 429 reply body exceeded maxResponseBytes (${LIMIT} bytes)`),
      })
      expect(error.retryAfterMs).toBeUndefined()
      expect(error.cause).toMatchObject({ kind: 'response_too_large', status: 429 })
      expect(calls).toHaveLength(1)
      expect(bodies[0]!.produced).toBe(LIMIT + CHUNK)
      expect(bodies[0]!.cancelled).toBe(true)
    }
  })

  it('ends a custom fetchFn’s own response_too_large as unknown_outcome', async () => {
    let attempts = 0
    const thrown = new QbitApiError('response_too_large', 'proxy refused a large body')
    const fetchFn = (async () => {
      attempts += 1
      throw thrown
    }) as typeof fetch

    const error = await rejection(client(fetchFn).broadcastTx(RAW_TX))
    expect(error).toMatchObject({ kind: 'unknown_outcome', message: expect.stringContaining('proxy refused') })
    expect(error.cause).toBe(thrown)
    expect(attempts).toBe(1)
  })

  it('does not fall back to /tx/push on MempoolQbitClient', async () => {
    // A 404 over the limit would fall back if its body could be judged.
    const { fetchFn, calls } = makeFetch(() => ({ status: 404, body: endlessBody().stream }))
    const mempool = new MempoolQbitClient({ baseUrl: BASE, fetchFn, sleepFn: noSleep, maxResponseBytes: LIMIT })

    await expect(mempool.broadcastTx(RAW_TX)).rejects.toMatchObject({ kind: 'unknown_outcome', status: 404 })
    expect(calls).toEqual([{ url: `${BASE}/tx`, method: 'POST' }])
  })
})

describe('DEFAULT_MAX_RESPONSE_BYTES', { timeout: 60_000 }, () => {
  const ADDR = 'qbrt1zqqqsyqcyq5rqwzqfpg9scrgwpugpzysnzs23v9ccrydpk8qarc0s8kqqny'

  it('is the default: 64 MiB passes, one byte more does not', async () => {
    expect(DEFAULT_MAX_RESPONSE_BYTES).toBe(64 * 1024 * 1024)
    let body = 'a'.repeat(DEFAULT_MAX_RESPONSE_BYTES)
    const { fetchFn } = makeFetch(() => ({ body }))
    const c = defaultClient(fetchFn)
    await expect(c.getTipHash()).resolves.toHaveLength(DEFAULT_MAX_RESPONSE_BYTES)
    body += 'a'
    await expect(c.getTipHash()).rejects.toMatchObject({
      kind: 'response_too_large',
      message: expect.stringContaining('exceeded maxResponseBytes (67108864 bytes)'),
    })
  })

  it('accepts the hex of a transaction as large as a block can hold', async () => {
    // 1,999,783 bytes: MAX_BLOCK_SERIALIZED_SIZE (2,000,000) less an 80-byte
    // header, the transaction count and a coinbase with a witness commitment.
    // One input, one P2MR output and one witness item make up the rest.
    const item = 1_999_783 - 102
    const hex =
      `02000000 0001 01 ${'11'.repeat(32)} 00000000 00 ffffffff ` +
      `01 e803000000000000 22 5220${'22'.repeat(32)} ` +
      `01 fe${[0, 8, 16, 24].map(shift => ((item >>> shift) & 0xff).toString(16).padStart(2, '0')).join('')} ` +
      `${'5a'.repeat(item)} 00000000`
    const rawTx = hex.replace(/ /g, '')
    expect(rawTx).toHaveLength(2 * 1_999_783)
    const txid = txidFromRawTx(rawTx)
    const { fetchFn } = makeFetch(() => ({ body: rawTx }))
    await expect(defaultClient(fetchFn).getTxHex(txid)).resolves.toBe(rawTx)
  })

  it('accepts a full 50-row history page of the largest standard spends', async () => {
    // The largest standard spend: 106 single-key P2MR inputs of 3,763 bytes
    // (qbit Core P2MR_V1_SINGLE_KEY_SPEND_SIZE), 400,000 bytes in all, as
    // qbit-electrs renders it: every input with its prevout, its witness as hex
    // and its leaf script as asm.
    const p2mr = `5220${'33'.repeat(32)}`
    const leaf = `20${'07'.repeat(32)}b3`
    const output = {
      scriptpubkey: p2mr,
      scriptpubkey_asm: `OP_PUSHNUM_2 OP_PUSHBYTES_32 ${'33'.repeat(32)}`,
      scriptpubkey_type: 'v2_p2mr',
      scriptpubkey_address: ADDR,
      value: 2_099_999_997_690_000,
    }
    const spend = (n: number) => ({
      txid: n.toString(16).padStart(64, 'c'),
      version: 2,
      locktime: 0,
      vin: Array.from({ length: 106 }, (_, i) => ({
        txid: i.toString(16).padStart(64, 'd'),
        vout: 4_294_967_295,
        prevout: output,
        scriptsig: '',
        scriptsig_asm: '',
        witness: ['5a'.repeat(3_680), leaf, `c1${'00'.repeat(32)}`],
        is_coinbase: false,
        sequence: 4_294_967_293,
        inner_witnessscript_asm: `OP_PUSHBYTES_32 ${'07'.repeat(32)} OP_CHECKSIGPQC`,
      })),
      vout: [output],
      size: 398_976,
      weight: 398_976,
      sigops: 0,
      fee: 2_099_999_997_690_000,
      status: { confirmed: false },
    })
    expect(JSON.stringify(spend(0)).length).toBeGreaterThan(850_000)
    const page = JSON.stringify(Array.from({ length: 50 }, (_, n) => spend(n)))
    expect(page.length).toBeGreaterThan(42_500_000)
    expect(page.length).toBeLessThan(DEFAULT_MAX_RESPONSE_BYTES)

    // The page after the last row is empty.
    const { fetchFn } = makeFetch(url => ({ body: url.includes('after_txid=') ? '[]' : page }))
    await expect(defaultClient(fetchFn).getAddressMempoolTxs(ADDR)).resolves.toHaveLength(50)
    const mempool = new MempoolQbitClient({ baseUrl: BASE, fetchFn, sleepFn: noSleep })
    await expect(mempool.getAddressMempoolTxs(ADDR)).resolves.toHaveLength(50)
  })
})

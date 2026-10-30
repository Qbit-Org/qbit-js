import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { EsploraClient, QbitApiError, type RequestOptions } from '../src/index'
import { createMockEsplora, type MockFault } from '../src/testing'

const BASE = 'https://esplora.example/regtest/api'
/** BASE as errors show it: the origin, with the base path redacted. */
const SAFE_BASE = 'https://esplora.example/...'
const ADDR = 'qbrt1zqqqsyqcyq5rqwzqfpg9scrgwpugpzysnzs23v9ccrydpk8qarc0s8kqqny'
const STATS = {
  address: ADDR,
  chain_stats: { funded_txo_count: 1, funded_txo_sum: 10, spent_txo_count: 0, spent_txo_sum: 0, tx_count: 1 },
  mempool_stats: { funded_txo_count: 0, funded_txo_sum: 0, spent_txo_count: 0, spent_txo_sum: 0, tx_count: 0 },
}
const TXID = 'ab'.repeat(32)

/**
 * A testing-kit backend whose address stats are STATS. Most tests here keep
 * `makeFetch` instead: they control a body's chunks and watch its cancellation
 * and each attempt's signal, which the kit's stall fault does not expose.
 */
function statsBackend(faults: MockFault[] = []) {
  return createMockEsplora({
    backend: 'esplora',
    baseUrl: BASE,
    txs: [{ txid: TXID, vout: [{ address: ADDR, value: 10 }], block: { height: 1 } }],
    faults,
  })
}

const encoder = new TextEncoder()
const noSleep = () => Promise.resolve()

interface ControlledBody {
  stream: ReadableStream<Uint8Array>
  push: (chunk: string) => void
  close: () => void
  readonly cancelled: boolean
}

/** A response body that only advances when the test pushes or closes it. */
function controlledBody(initialChunks: string[] = []): ControlledBody {
  let controller!: ReadableStreamDefaultController<Uint8Array>
  let cancelled = false
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c
      for (const chunk of initialChunks) c.enqueue(encoder.encode(chunk))
    },
    cancel() {
      cancelled = true
    },
  })
  return {
    stream,
    push: chunk => controller.enqueue(encoder.encode(chunk)),
    close: () => controller.close(),
    get cancelled() {
      return cancelled
    },
  }
}

/** A response body whose first read fails, like a connection reset mid-body. */
function erroringBody(): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(c) {
      c.error(Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }))
    },
  })
}

interface Reply {
  status?: number
  headers?: Record<string, string>
  /** A string body, or a stream the fetch implementation does not tie to the abort signal. */
  body?: string | ReadableStream<Uint8Array> | null
  /** Fetched URL to expose on the response (constructed responses default to ''). */
  url?: string
}

function makeFetch(handler: (callIndex: number) => Reply | Promise<Reply>) {
  const signals: AbortSignal[] = []
  const fetchFn = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    const index = signals.length
    signals.push(init!.signal!)
    const reply = await handler(index)
    const response = new Response(reply.body === undefined ? '' : reply.body, {
      status: reply.status ?? 200,
      ...(reply.headers ? { headers: reply.headers } : {}),
    })
    if (reply.url !== undefined) Object.defineProperty(response, 'url', { value: reply.url })
    return response
  }) as typeof fetch
  return { fetchFn, signals }
}

/** Settle `promise` or report it still pending after `ms` real milliseconds. */
async function settleWithin<T>(promise: Promise<T>, ms: number) {
  let timer: ReturnType<typeof setTimeout> | undefined
  const pending = new Promise<{ state: 'pending' }>(resolve => {
    timer = setTimeout(() => resolve({ state: 'pending' }), ms)
  })
  try {
    return await Promise.race([
      promise.then(
        value => ({ state: 'resolved' as const, value }),
        error => ({ state: 'rejected' as const, error: error as unknown })
      ),
      pending,
    ])
  } finally {
    clearTimeout(timer)
  }
}

describe('EsploraClient response body timeout', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  const timedOut = { kind: 'timeout', url: expect.stringContaining(SAFE_BASE) }
  const readPaths: {
    name: string
    call: (client: EsploraClient) => Promise<unknown>
    partial: string
    expected: Record<string, unknown>
  }[] = [
    {
      name: 'getJson (getAddressStats)',
      call: client => client.getAddressStats(ADDR),
      partial: '{"address":',
      expected: timedOut,
    },
    { name: 'getText (getTipHash)', call: client => client.getTipHash(), partial: '00000000', expected: timedOut },
    // A submission whose reply stalls may already have been accepted, so the
    // attempt's timeout is reported as an unknown outcome, not a retryable timeout.
    {
      name: 'broadcastTx',
      call: client => client.broadcastTx('00'),
      partial: TXID.slice(0, 10),
      expected: { kind: 'unknown_outcome', url: `${SAFE_BASE}/tx`, cause: timedOut },
    },
  ]

  it.each(readPaths)(
    'ends the attempt at the timeout when the $name body stalls after the headers',
    async ({ call, partial, expected }) => {
      const body = controlledBody([partial])
      const { fetchFn, signals } = makeFetch(() => ({ body: body.stream }))
      const client = new EsploraClient({ baseUrl: BASE, fetchFn, timeoutMs: 20, retries: 0, sleepFn: noSleep })

      const started = Date.now()
      const outcome = await settleWithin(call(client), 2_000)

      expect(outcome.state).toBe('rejected')
      const error = (outcome as { error: unknown }).error
      expect(error).toBeInstanceOf(QbitApiError)
      expect(error).toMatchObject(expected)
      expect(Date.now() - started).toBeLessThan(1_000)
      expect(signals[0]!.aborted).toBe(true)
      expect(body.cancelled).toBe(true)
    }
  )

  // A submission reply that stalls or cannot be read may follow an accepted POST.
  it.each([
    {
      name: 'a 200 whose body stalls',
      reply: () => ({ body: controlledBody([TXID.slice(0, 10)]).stream }),
      cause: 'timeout',
    },
    { name: 'a 400 whose body errors', reply: () => ({ status: 400, body: erroringBody() }), cause: 'parse' },
  ])('never re-sends a broadcastTx after $name', async ({ reply, cause }) => {
    const sleep = vi.fn(noSleep)
    const { fetchFn, signals } = makeFetch(reply)
    const client = new EsploraClient({ baseUrl: BASE, fetchFn, timeoutMs: 20, retries: 2, sleepFn: sleep })

    const outcome = await settleWithin(client.broadcastTx('00'), 2_000)

    expect(outcome).toMatchObject({
      state: 'rejected',
      error: { kind: 'unknown_outcome', url: `${SAFE_BASE}/tx`, cause: { kind: cause } },
    })
    expect(signals).toHaveLength(1)
    expect(sleep).not.toHaveBeenCalled()
  })

  // A 429 proves the submission was not processed only through its body,
  // which could instead have said the node has it (already known) or may have
  // it (a relayed transport failure). One whose body is lost is uncertain.
  const lost429Bodies = [
    { name: 'stalls', body: () => controlledBody(['slow down']).stream, cause: 'timeout' },
    { name: 'cannot be read', body: erroringBody, cause: 'parse' },
  ]

  it.each(lost429Bodies)(
    'ends a broadcastTx 429 whose body $name as unknown_outcome, without a re-send',
    async ({ body, cause }) => {
      const sleep = vi.fn(noSleep)
      const { fetchFn, signals } = makeFetch(i => (i === 0 ? { status: 429, body: body() } : { body: TXID }))
      const client = new EsploraClient({ baseUrl: BASE, fetchFn, timeoutMs: 20, retries: 2, sleepFn: sleep })

      const outcome = await settleWithin(client.broadcastTx('00'), 2_000)

      expect(outcome).toMatchObject({
        state: 'rejected',
        error: {
          kind: 'unknown_outcome',
          status: 429,
          url: `${SAFE_BASE}/tx`,
          message: expect.stringContaining('HTTP 429 reply body could not be read'),
          cause: { kind: cause, status: 429 },
        },
      })
      expect(signals).toHaveLength(1)
      expect(sleep).not.toHaveBeenCalled()
    }
  )

  it('times out a stalled error body on the final attempt instead of hanging', async () => {
    const body = controlledBody(['bus'])
    const { fetchFn } = makeFetch(() => ({ status: 503, body: body.stream }))
    const client = new EsploraClient({ baseUrl: BASE, fetchFn, timeoutMs: 20, retries: 0, sleepFn: noSleep })

    const outcome = await settleWithin(client.getAddressStats(ADDR), 2_000)

    expect(outcome).toMatchObject({ state: 'rejected', error: { kind: 'timeout' } })
    expect(body.cancelled).toBe(true)
  })

  it('retries a GET whose body timed out, then succeeds', async () => {
    const stalled = controlledBody(['{"addr'])
    const sleep = vi.fn(noSleep)
    const { fetchFn, signals } = makeFetch(i => (i === 0 ? { body: stalled.stream } : { body: JSON.stringify(STATS) }))
    const client = new EsploraClient({
      baseUrl: BASE,
      fetchFn,
      timeoutMs: 20,
      retries: 2,
      retryBaseDelayMs: 7,
      sleepFn: sleep,
    })

    const outcome = await settleWithin(client.getAddressStats(ADDR), 2_000)

    expect(outcome).toMatchObject({ state: 'resolved', value: STATS })
    expect(signals).toHaveLength(2)
    expect(sleep).toHaveBeenCalledTimes(1)
    expect(sleep).toHaveBeenCalledWith(7, expect.any(AbortSignal))
    expect(stalled.cancelled).toBe(true)
  })

  it('surfaces a timeout once every attempt has stalled', async () => {
    const bodies: ControlledBody[] = []
    const { fetchFn, signals } = makeFetch(() => {
      const body = controlledBody()
      bodies.push(body)
      return { body: body.stream }
    })
    const client = new EsploraClient({ baseUrl: BASE, fetchFn, timeoutMs: 10, retries: 2, sleepFn: noSleep })

    const outcome = await settleWithin(client.getTipHash(), 2_000)

    expect(outcome).toMatchObject({ state: 'rejected', error: { kind: 'timeout' } })
    expect(signals).toHaveLength(3)
    expect(bodies.every(body => body.cancelled)).toBe(true)
  })

  it('shares one bounded attempt across de-duplicated GETs', async () => {
    const stalled = controlledBody()
    const { fetchFn, signals } = makeFetch(i => (i === 0 ? { body: stalled.stream } : { body: JSON.stringify(STATS) }))
    const client = new EsploraClient({ baseUrl: BASE, fetchFn, timeoutMs: 20, retries: 0, sleepFn: noSleep })

    const outcomes = await settleWithin(
      Promise.all([
        client.getAddressStats(ADDR).catch((error: unknown) => error),
        client.getAddressStats(ADDR).catch((error: unknown) => error),
      ]),
      2_000
    )

    expect(outcomes).toMatchObject({ state: 'resolved', value: [{ kind: 'timeout' }, { kind: 'timeout' }] })
    expect(signals).toHaveLength(1)
    // The failed in-flight entry is released, so the next poll fetches afresh.
    expect(await client.getAddressStats(ADDR)).toEqual(STATS)
    expect(signals).toHaveLength(2)
  })

  it('applies one deadline across the headers and the body', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const body = controlledBody()
    const { fetchFn, signals } = makeFetch(
      () => new Promise<Reply>(resolve => setTimeout(() => resolve({ body: body.stream }), 60))
    )
    const client = new EsploraClient({ baseUrl: BASE, fetchFn, timeoutMs: 100, retries: 0, sleepFn: noSleep })

    let settled: unknown
    const call = client.getAddressStats(ADDR).then(
      value => (settled = { value }),
      error => (settled = { error })
    )

    await vi.advanceTimersByTimeAsync(60) // headers arrive
    body.push('{"address":')
    await vi.advanceTimersByTimeAsync(39) // still inside the original 100 ms
    expect(settled).toBeUndefined()
    expect(signals[0]!.aborted).toBe(false)

    await vi.advanceTimersByTimeAsync(1)
    await call
    expect(settled).toMatchObject({ error: { kind: 'timeout' } })
    expect(body.cancelled).toBe(true)
  })

  it('reads a slow body that completes in time and clears the attempt timer', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const body = controlledBody()
    const { fetchFn, signals } = makeFetch(() => ({ body: body.stream }))
    const client = new EsploraClient({ baseUrl: BASE, fetchFn, timeoutMs: 100, retries: 0, sleepFn: noSleep })

    const call = client.getAddressStats(ADDR)
    const json = JSON.stringify(STATS)
    await vi.advanceTimersByTimeAsync(40)
    body.push(json.slice(0, 20))
    await vi.advanceTimersByTimeAsync(50)
    body.push(json.slice(20))
    body.close()

    expect(await call).toEqual(STATS)
    expect(vi.getTimerCount()).toBe(0)
    await vi.advanceTimersByTimeAsync(1_000)
    expect(signals[0]!.aborted).toBe(false)
  })

  it('reads a retryable transient body under the attempt timer, then retries', async () => {
    const stalled = controlledBody(['busy'])
    const sleep = vi.fn(noSleep)
    const { fetchFn, signals } = makeFetch(i =>
      i === 0 ? { status: 503, headers: { 'retry-after': '3' }, body: stalled.stream } : { body: JSON.stringify(STATS) }
    )
    const client = new EsploraClient({
      baseUrl: BASE,
      fetchFn,
      timeoutMs: 20,
      retries: 1,
      retryBaseDelayMs: 7,
      sleepFn: sleep,
    })

    const outcome = await settleWithin(client.getAddressStats(ADDR), 2_000)

    expect(outcome).toMatchObject({ state: 'resolved', value: STATS })
    expect(signals).toHaveLength(2)
    // The stalled 503 body was read under the deadline, so the attempt failed as a
    // timeout (backoff) rather than being handed on unread with its Retry-After.
    expect(signals[0]!.aborted).toBe(true)
    expect(stalled.cancelled).toBe(true)
    expect(sleep).toHaveBeenCalledTimes(1)
    expect(sleep).toHaveBeenCalledWith(7, expect.any(AbortSignal))
  })

  it('still honours Retry-After when a transient body arrives in time', async () => {
    const sleep = vi.fn(noSleep)
    const mock = statsBackend([
      { route: 'GET /address/:address', kind: 'status', status: 503, retryAfter: 3, body: 'busy' },
    ])
    const client = new EsploraClient({
      baseUrl: BASE,
      fetchFn: mock.fetchFn,
      timeoutMs: 1_000,
      retries: 1,
      sleepFn: sleep,
    })

    await expect(client.getAddressStats(ADDR)).resolves.toEqual(STATS)
    expect(mock.requests).toHaveLength(2)
    expect(sleep).toHaveBeenCalledWith(3000, expect.any(AbortSignal))
  })

  it.each([429, 503])('ends a stalled %i with a huge Retry-After as a timeout within the budget', async status => {
    const bodies: ControlledBody[] = []
    const { fetchFn, signals } = makeFetch(() => {
      const body = controlledBody(['slow down'])
      bodies.push(body)
      return { status, headers: { 'retry-after': '99999' }, body: body.stream }
    })
    // The real sleep: honouring the Retry-After of an unread response would park the call for a day.
    const client = new EsploraClient({ baseUrl: BASE, fetchFn, timeoutMs: 50, retries: 1, retryBaseDelayMs: 1 })

    const started = Date.now()
    const outcome = await settleWithin(client.getAddressStats(ADDR), 2_000)

    expect(outcome).toMatchObject({ state: 'rejected', error: { kind: 'timeout' } })
    // Two attempts of 50 ms plus a 1 ms backoff, with slack for a loaded runner.
    expect(Date.now() - started).toBeLessThan(1_000)
    expect(signals).toHaveLength(2)
    expect(signals.every(signal => signal.aborted)).toBe(true)
    expect(bodies.every(body => body.cancelled)).toBe(true)
  })

  it('keeps status, headers, and the fetched URL on the buffered response', async () => {
    const fetched = `${BASE}/tx`
    const { fetchFn } = makeFetch(i =>
      i === 0
        ? { status: 400, body: 'sendrawtransaction RPC error: bad-txns', url: fetched }
        : { status: 204, body: null }
    )
    const client = new EsploraClient({ baseUrl: BASE, fetchFn, retries: 0, sleepFn: noSleep })

    await expect(client.broadcastTx('00')).rejects.toMatchObject({
      kind: 'http',
      status: 400,
      url: fetched.replace(BASE, SAFE_BASE),
      responseBody: 'sendrawtransaction RPC error: bad-txns',
    })
    // Null-body statuses survive buffering instead of failing Response construction:
    // the 204 reaches the submission policy with its status, which reports an
    // empty 2xx that carries no txid as an unknown outcome.
    await expect(client.broadcastTx('00')).rejects.toMatchObject({
      kind: 'unknown_outcome',
      status: 204,
      responseBody: '',
      message: expect.stringContaining('reply is not a txid'),
    })
  })

  it('keeps the fetched URL for every de-duplicated waiter', async () => {
    const fetched = `${BASE}/tx/${TXID}/hex`
    const { fetchFn, signals } = makeFetch(() => ({ status: 404, body: 'Transaction not found', url: fetched }))
    const client = new EsploraClient({ baseUrl: BASE, fetchFn, retries: 0, sleepFn: noSleep })

    const errors = await Promise.all([
      client.getTxHex(TXID).catch((error: unknown) => error),
      client.getTxHex(TXID).catch((error: unknown) => error),
    ])

    expect(signals).toHaveLength(1)
    expect(errors).toMatchObject([
      { kind: 'not_found', url: fetched.replace(BASE, SAFE_BASE), responseBody: 'Transaction not found' },
      { kind: 'not_found', url: fetched.replace(BASE, SAFE_BASE), responseBody: 'Transaction not found' },
    ])
  })
})

describe('EsploraClient body phase under a call signal', () => {
  const tick = () => new Promise(resolve => setTimeout(resolve, 5))

  it('rejects a GET aborted mid-body as aborted, not as the attempt timeout', async () => {
    const controller = new AbortController()
    const body = controlledBody(['00000000'])
    const { fetchFn, signals } = makeFetch(() => ({ body: body.stream }))
    const client = new RawClient({ baseUrl: BASE, fetchFn, timeoutMs: 1_000, retries: 2, sleepFn: noSleep })

    const call = client.raw('/blocks/tip/hash', { signal: controller.signal })
    await tick()
    controller.abort(new Error('user left'))
    const outcome = await settleWithin(call, 2_000)

    expect(outcome).toMatchObject({
      state: 'rejected',
      error: { kind: 'aborted', message: expect.stringContaining('request aborted by caller') },
    })
    expect(signals).toHaveLength(1)
    expect(body.cancelled).toBe(true)
  })

  it('rejects a GET whose deadline expires mid-body with the deadline timeout', async () => {
    const body = controlledBody(['00000000'])
    const { fetchFn, signals } = makeFetch(() => ({ body: body.stream }))
    const client = new RawClient({ baseUrl: BASE, fetchFn, timeoutMs: 1_000, retries: 2, sleepFn: noSleep })

    const outcome = await settleWithin(client.raw('/blocks/tip/hash', { deadlineMs: 20 }), 2_000)

    expect(outcome).toMatchObject({
      state: 'rejected',
      error: { kind: 'timeout', message: 'operation exceeded its 20ms deadline' },
    })
    expect(signals).toHaveLength(1)
    expect(body.cancelled).toBe(true)
  })

  it('reports a broadcastTx aborted mid-body as unknown_outcome with the reply status', async () => {
    const controller = new AbortController()
    const body = controlledBody([TXID.slice(0, 10)])
    const { fetchFn, signals } = makeFetch(() => ({ body: body.stream }))
    const client = new EsploraClient({ baseUrl: BASE, fetchFn, timeoutMs: 1_000, retries: 2, sleepFn: noSleep })

    const call = client.broadcastTx('00', { signal: controller.signal })
    await tick()
    controller.abort()
    const outcome = await settleWithin(call, 2_000)

    expect(outcome).toMatchObject({
      state: 'rejected',
      error: { kind: 'unknown_outcome', status: 200, url: `${SAFE_BASE}/tx`, cause: { kind: 'aborted' } },
    })
    expect(signals).toHaveLength(1)
    expect(body.cancelled).toBe(true)
  })

  // Only a 429's whole body can prove the submission was not processed, so
  // cutting it short leaves the outcome unknown.
  it.each([
    { name: 'an abort', options: (controller: AbortController) => ({ signal: controller.signal }), kind: 'aborted' },
    { name: 'the deadline', options: () => ({ deadlineMs: 20 }), kind: 'timeout' },
  ])(
    'ends a broadcastTx whose 429 body $name cuts short as unknown_outcome, without a re-send',
    async ({ options, kind }) => {
      const controller = new AbortController()
      const body = controlledBody(['slow down'])
      const { fetchFn, signals } = makeFetch(() => ({ status: 429, body: body.stream }))
      const client = new EsploraClient({ baseUrl: BASE, fetchFn, timeoutMs: 1_000, retries: 0, sleepFn: noSleep })

      const call = client.broadcastTx('00', options(controller))
      await tick()
      controller.abort()
      const outcome = await settleWithin(call, 2_000)

      expect(outcome).toMatchObject({
        state: 'rejected',
        error: { kind: 'unknown_outcome', status: 429, cause: { kind } },
      })
      expect((outcome as { error: QbitApiError }).error.txid).toBeUndefined()
      expect(signals).toHaveLength(1)
      expect(body.cancelled).toBe(true)
    }
  )
})

interface PlainReply {
  status?: number
  headers?: Record<string, string>
  body?: string
  url?: string
}

/**
 * A fetch whose responses are plain Response-like objects (node-fetch on old
 * Node, React Native polyfills): no stream, only `text()` and `headers.get`.
 */
function makePlainFetch(handler: (callIndex: number) => PlainReply) {
  const calls: { url: string; init: RequestInit }[] = []
  const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const index = calls.length
    calls.push({ url: String(input), init: init! })
    const reply = handler(index)
    const status = reply.status ?? 200
    const headers = Object.fromEntries(
      Object.entries(reply.headers ?? {}).map(([name, value]) => [name.toLowerCase(), value])
    )
    return {
      status,
      statusText: '',
      ok: status >= 200 && status < 300,
      url: reply.url ?? String(input),
      headers: { get: (name: string) => headers[name.toLowerCase()] ?? null },
      text: async () => reply.body ?? '',
    } as unknown as Response
  }) as typeof fetch
  return { fetchFn, calls }
}

class RawClient extends EsploraClient {
  raw(path: string, options?: RequestOptions) {
    return this.request(path, { method: 'GET', dedup: false }, options)
  }
}

describe('EsploraClient without a global Response', () => {
  let saved: PropertyDescriptor | undefined

  beforeEach(() => {
    saved = Object.getOwnPropertyDescriptor(globalThis, 'Response')
    Reflect.deleteProperty(globalThis, 'Response')
  })

  afterEach(() => {
    if (saved) Object.defineProperty(globalThis, 'Response', saved)
  })

  it('runs with no global Response', () => {
    expect(typeof (globalThis as { Response?: unknown }).Response).toBe('undefined')
  })

  it('reads a GET', async () => {
    const { fetchFn, calls } = makePlainFetch(() => ({ body: JSON.stringify(STATS) }))
    const client = new EsploraClient({ baseUrl: BASE, fetchFn, sleepFn: noSleep })

    await expect(client.getAddressStats(ADDR)).resolves.toEqual(STATS)
    expect(calls).toHaveLength(1)
  })

  it('posts a transaction and maps an HTTP error without retrying it as a network error', async () => {
    const fetched = `${BASE}/tx`
    const { fetchFn, calls } = makePlainFetch(i =>
      i === 0 ? { body: `${TXID}\n` } : { status: 400, body: 'bad-txns', url: fetched }
    )
    const client = new EsploraClient({ baseUrl: BASE, fetchFn, sleepFn: noSleep })

    await expect(client.broadcastTx('00')).resolves.toBe(TXID)
    expect(calls[0]).toMatchObject({ url: fetched, init: { method: 'POST', body: '00' } })
    await expect(client.broadcastTx('00')).rejects.toMatchObject({
      kind: 'http',
      status: 400,
      url: fetched.replace(BASE, SAFE_BASE),
      responseBody: 'bad-txns',
    })
    expect(calls).toHaveLength(2)
  })

  it('shares one fetch across de-duplicated GETs', async () => {
    // A legacy transaction and its txid: getTxHex checks the reply.
    const hex =
      '020000000111111111111111111111111111111111111111111111111111111111111111110000000000ffffffff0100000000000000000000000000'
    const id = '992393c6db57a325f48e3097a50c45349c3eb27df5160a68cbb7a022f98c2dc2'
    const fetched = `${BASE}/tx/${id}/hex`
    const { fetchFn, calls } = makePlainFetch(i =>
      i === 0 ? { body: hex } : { status: 404, body: 'Transaction not found', url: fetched }
    )
    const client = new EsploraClient({ baseUrl: BASE, fetchFn, retries: 0, sleepFn: noSleep })

    await expect(Promise.all([client.getTxHex(id), client.getTxHex(id), client.getTxHex(id)])).resolves.toEqual([
      hex,
      hex,
      hex,
    ])
    expect(calls).toHaveLength(1)

    const errors = await Promise.all([
      client.getTxHex(id).catch((error: unknown) => error),
      client.getTxHex(id).catch((error: unknown) => error),
    ])
    expect(calls).toHaveLength(2)
    expect(errors).toMatchObject([
      { kind: 'not_found', url: fetched.replace(BASE, SAFE_BASE), responseBody: 'Transaction not found' },
      { kind: 'not_found', url: fetched.replace(BASE, SAFE_BASE), responseBody: 'Transaction not found' },
    ])
  })

  it('honours Retry-After from the fetched headers', async () => {
    const { fetchFn, calls } = makePlainFetch(i =>
      i === 0 ? { status: 503, headers: { 'Retry-After': '7' } } : { body: JSON.stringify(STATS) }
    )
    const sleeps: number[] = []
    const client = new EsploraClient({
      baseUrl: BASE,
      fetchFn,
      sleepFn: async ms => {
        sleeps.push(ms)
      },
    })

    await expect(client.getAddressStats(ADDR)).resolves.toEqual(STATS)
    expect(calls).toHaveLength(2)
    expect(sleeps).toEqual([7000])
  })

  it('hands request() callers a buffered Response-like object', async () => {
    const fetched = `${BASE}/blocks/tip/height`
    const { fetchFn } = makePlainFetch(i =>
      i === 0
        ? { body: '{"height":42}', headers: { 'Content-Type': 'application/json' }, url: fetched }
        : { status: 204 }
    )
    const client = new RawClient({ baseUrl: BASE, fetchFn, sleepFn: noSleep })

    const response = await client.raw('/blocks/tip/height')
    expect(response).toMatchObject({ status: 200, ok: true, url: fetched, body: null, bodyUsed: false })
    expect(response.headers.get('content-type')).toBe('application/json')
    const copy = response.clone()
    await expect(response.json()).resolves.toEqual({ height: 42 })
    expect(response.bodyUsed).toBe(true)
    await expect(response.text()).rejects.toThrow(TypeError)
    expect(copy.url).toBe(fetched)
    await expect(copy.text()).resolves.toBe('{"height":42}')

    const empty = await client.raw('/blocks/tip/height')
    expect(empty).toMatchObject({ status: 204, ok: true })
    await expect(empty.text()).resolves.toBe('')
  })
})

describe('EsploraClient with a Response the runtime cannot construct', () => {
  it('falls back to the buffered Response-like object instead of failing as a network error', async () => {
    // The global constructor rejects statuses outside 200-599; a custom fetch need not.
    const { fetchFn, calls } = makePlainFetch(() => ({ status: 600, body: 'odd' }))
    const client = new EsploraClient({ baseUrl: BASE, fetchFn, sleepFn: noSleep })

    await expect(client.getTipHash()).rejects.toMatchObject({ kind: 'http', status: 600, responseBody: 'odd' })
    expect(calls).toHaveLength(1)
  })
})

describe('EsploraClient without a global TextDecoder', () => {
  it('reads a streamed body through text() instead of failing as a parse error', async () => {
    const saved = Object.getOwnPropertyDescriptor(globalThis, 'TextDecoder')
    Reflect.deleteProperty(globalThis, 'TextDecoder')
    try {
      const mock = statsBackend()
      const client = new EsploraClient({ baseUrl: BASE, fetchFn: mock.fetchFn, sleepFn: noSleep })

      await expect(client.getAddressStats(ADDR)).resolves.toEqual(STATS)
      expect(mock.requests).toHaveLength(1)
    } finally {
      if (saved) Object.defineProperty(globalThis, 'TextDecoder', saved)
    }
  })
})

/**
 * A fetch that ignores the abort signal once the headers have arrived and
 * returns a Response-like object read through `text()`, which never settles
 * unless `textResult` says otherwise.
 */
function makeStalledTextFetch(body: unknown, textResult: () => Promise<string> = () => new Promise<string>(() => {})) {
  const signals: AbortSignal[] = []
  const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    signals.push(init!.signal!)
    return {
      status: 200,
      statusText: 'OK',
      ok: true,
      url: String(input),
      headers: { get: () => null },
      body,
      text: textResult,
    } as unknown as Response
  }) as typeof fetch
  return { fetchFn, signals }
}

describe('EsploraClient releasing a stalled body read through text()', () => {
  async function expectTimeoutWithinBudget(fetchFn: typeof fetch) {
    const client = new EsploraClient({ baseUrl: BASE, fetchFn, timeoutMs: 20, retries: 0, sleepFn: noSleep })
    const started = Date.now()
    const outcome = await settleWithin(client.getTipHash(), 2_000)
    expect(outcome.state).toBe('rejected')
    expect((outcome as { error: unknown }).error).toMatchObject({ kind: 'timeout' })
    expect(Date.now() - started).toBeLessThan(1_000)
  }

  it('cancels a web-style body with the abort reason when the deadline wins', async () => {
    const cancel = vi.fn(() => Promise.resolve())
    const { fetchFn, signals } = makeStalledTextFetch({ cancel })

    await expectTimeoutWithinBudget(fetchFn)

    expect(cancel).toHaveBeenCalledTimes(1)
    expect(cancel).toHaveBeenCalledWith(signals[0]!.reason)
  })

  it('destroys a Node-style body with the abort reason when text() listens for errors', async () => {
    const destroy = vi.fn()
    const listenerCount = vi.fn((event: string) => (event === 'error' ? 1 : 0))
    const { fetchFn, signals } = makeStalledTextFetch({ destroy, listenerCount })

    await expectTimeoutWithinBudget(fetchFn)

    expect(destroy).toHaveBeenCalledTimes(1)
    expect(destroy).toHaveBeenCalledWith(signals[0]!.reason)
  })

  it('destroys a Node-style body without an error when nothing listens for one', async () => {
    const withoutListeners = vi.fn()
    await expectTimeoutWithinBudget(makeStalledTextFetch({ destroy: withoutListeners, listenerCount: () => 0 }).fetchFn)
    expect(withoutListeners).toHaveBeenCalledTimes(1)
    expect(withoutListeners).toHaveBeenCalledWith()

    const withoutListenerCount = vi.fn()
    await expectTimeoutWithinBudget(makeStalledTextFetch({ destroy: withoutListenerCount }).fetchFn)
    expect(withoutListenerCount).toHaveBeenCalledWith()
  })

  it('reads a real Node stream itself, rather than through text(), and destroys it without an unhandled error', async () => {
    // node-fetch's body: the client iterates it, counting bytes as they arrive.
    const { PassThrough } = await import('node:stream')
    const stream = new PassThrough()
    stream.write('00000000')
    const text = vi.fn(() => new Promise<string>(() => {}))
    await expectTimeoutWithinBudget(makeStalledTextFetch(stream, text).fetchFn)
    await new Promise(resolve => setImmediate(resolve))
    expect(stream.destroyed).toBe(true)
    expect(text).not.toHaveBeenCalled()
  })

  it('prefers cancel() when a body exposes both', async () => {
    const cancel = vi.fn(() => Promise.resolve())
    const destroy = vi.fn()
    const { fetchFn } = makeStalledTextFetch({ cancel, destroy })

    await expectTimeoutWithinBudget(fetchFn)

    expect(cancel).toHaveBeenCalledTimes(1)
    expect(destroy).not.toHaveBeenCalled()
  })

  it.each([
    { name: 'no body', body: undefined },
    { name: 'a null body', body: null },
    { name: 'a body with neither cancel() nor destroy()', body: {} },
    { name: 'a non-object body', body: 'stream' },
  ])('still times out with $name', async ({ body }) => {
    const { fetchFn } = makeStalledTextFetch(body)
    await expectTimeoutWithinBudget(fetchFn)
  })

  it('swallows a cancel() that throws or rejects', async () => {
    const throwing = vi.fn(() => {
      throw new Error('cancel threw')
    })
    await expectTimeoutWithinBudget(makeStalledTextFetch({ cancel: throwing }).fetchFn)
    expect(throwing).toHaveBeenCalledTimes(1)

    const rejecting = vi.fn(() => Promise.reject(new Error('cancel rejected')))
    await expectTimeoutWithinBudget(makeStalledTextFetch({ cancel: rejecting }).fetchFn)
    expect(rejecting).toHaveBeenCalledTimes(1)
  })

  it('swallows a destroy() that throws', async () => {
    const destroy = vi.fn(() => {
      throw new Error('destroy threw')
    })
    await expectTimeoutWithinBudget(makeStalledTextFetch({ destroy }).fetchFn)
    expect(destroy).toHaveBeenCalledTimes(1)
  })

  it('leaves the body alone when text() fails before the deadline', async () => {
    const cancel = vi.fn(() => Promise.resolve())
    const { fetchFn } = makeStalledTextFetch({ cancel }, () => Promise.reject(new Error('socket hang up')))
    const client = new EsploraClient({ baseUrl: BASE, fetchFn, timeoutMs: 1_000, retries: 0, sleepFn: noSleep })

    await expect(client.getTipHash()).rejects.toMatchObject({ kind: 'parse' })
    expect(cancel).not.toHaveBeenCalled()
  })

  it('times out a stalled web stream without a global TextDecoder', async () => {
    const saved = Object.getOwnPropertyDescriptor(globalThis, 'TextDecoder')
    Reflect.deleteProperty(globalThis, 'TextDecoder')
    try {
      const body = controlledBody(['00000000'])
      const { fetchFn, signals } = makeFetch(() => ({ body: body.stream }))
      await expectTimeoutWithinBudget(fetchFn)
      expect(signals[0]!.aborted).toBe(true)
    } finally {
      if (saved) Object.defineProperty(globalThis, 'TextDecoder', saved)
    }
  })
})

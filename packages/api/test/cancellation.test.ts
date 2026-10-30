import { getEventListeners } from 'node:events'
import { readFileSync } from 'node:fs'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { EsploraClient, MempoolQbitClient, QbitApiError, type RequestOptions } from '../src/index'
import { createMockEsplora, type MockBackend, type MockEsplora, type MockFault } from '../src/testing'

// Tests whose backend just has to answer use the testing kit, wrapping its
// fetchFn to abort or delay at a given request, or to hide each request's
// signal from it: the kit's fetchFn rejects a request whose signal has
// aborted, as fetch does, so a test of the client's own abort checks answers
// regardless (`abortingAt`). `makeFetch` stays for what the kit does not
// model: a request with no reply until it is aborted, or ever, a body that
// ignores its signal (the kit's stalled body errors on abort, as undici's
// does), a body whose chunks or cancels the test controls, and checks on the
// RequestInit the client passes.

interface MockReply {
  status?: number
  body?: string | ReadableStream<Uint8Array>
  headers?: Record<string, string>
}

type Handler = (callIndex: number, url: string, init: RequestInit | undefined) => MockReply | Promise<MockReply>

function makeFetch(handler: Handler): {
  fetchFn: typeof fetch
  calls: { url: string; init?: RequestInit | undefined }[]
} {
  const calls: { url: string; init?: RequestInit | undefined }[] = []
  const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    const index = calls.length
    calls.push({ url, init })
    const reply = await handler(index, url, init)
    return new Response(reply.body ?? '', {
      status: reply.status ?? 200,
      ...(reply.headers ? { headers: reply.headers } : {}),
    })
  }) as typeof fetch
  return { fetchFn, calls }
}

/** A fetch that never answers but, like real fetch, rejects with the signal's reason. */
function hangUntilAborted(init: RequestInit | undefined): Promise<never> {
  return new Promise((_, reject) => {
    const signal = init?.signal
    signal?.addEventListener('abort', () => reject(signal.reason), { once: true })
  })
}

/** A fetch that never answers and ignores its signal entirely. */
function hangForever(): Promise<never> {
  return new Promise(() => {})
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve = () => {}
  const promise = new Promise<void>(r => {
    resolve = r
  })
  return { promise, resolve }
}

function track<T>(promise: Promise<T>): { settled: boolean; value?: T; error?: unknown } {
  const state: { settled: boolean; value?: T; error?: unknown } = { settled: false }
  promise.then(
    value => {
      state.settled = true
      state.value = value
    },
    (error: unknown) => {
      state.settled = true
      state.error = error
    }
  )
  return state
}

async function flush(): Promise<void> {
  for (let i = 0; i < 5; i += 1) await new Promise(resolve => setImmediate(resolve))
}

const BASE = 'https://esplora.example/regtest/api'
const ADDR = 'qbrt1zqqqsyqcyq5rqwzqfpg9scrgwpugpzysnzs23v9ccrydpk8qarc0s8kqqny'
const STATS = {
  address: ADDR,
  chain_stats: { funded_txo_count: 1, funded_txo_sum: 1, spent_txo_count: 0, spent_txo_sum: 0, tx_count: 1 },
  mempool_stats: { funded_txo_count: 0, funded_txo_sum: 0, spent_txo_count: 0, spent_txo_sum: 0, tx_count: 0 },
}

/** A real P2MR transaction whose txid the client derives from the hex (see broadcast.test.ts). */
const P2MR_TX = JSON.parse(readFileSync(new URL('./fixtures/p2mr-witness-tx.json', import.meta.url), 'utf8')) as {
  rawTxHex: string
  txid: string
}

function txid(n: number): string {
  return n.toString(16).padStart(64, '0')
}

function historyPage(n: number, confirmed = true): string {
  return JSON.stringify([
    {
      txid: txid(n + 1),
      version: 2,
      locktime: 0,
      vin: [],
      vout: [
        {
          scriptpubkey: '51',
          scriptpubkey_asm: 'OP_1',
          scriptpubkey_type: 'unknown',
          scriptpubkey_address: ADDR,
          value: 1,
        },
      ],
      size: 100,
      weight: 100,
      fee: 10,
      status: confirmed ? { confirmed: true, block_height: 8, block_time: 123 } : { confirmed: false },
    },
  ])
}

/** A testing-kit backend whose history for ADDR is 100 confirmed transactions: four full chain pages. */
function longHistory(backend: MockBackend, faults: MockFault[] = []) {
  return createMockEsplora({
    backend,
    baseUrl: BASE,
    txs: Array.from({ length: 100 }, (_, n) => ({
      txid: txid(n + 1),
      vout: [{ address: ADDR, value: 1 }],
      block: { height: n + 1 },
    })),
    faults,
  })
}

/**
 * `mock`'s fetchFn, ignoring each request's signal, that aborts `controller`
 * as request `index` (from 0) arrives and answers it anyway, so that only the
 * client's own checks of the signal can stop a scan.
 */
function abortingAt(mock: MockEsplora, index: number, controller: AbortController): typeof fetch {
  return (input, init) => {
    if (mock.requests.length === index) controller.abort()
    return mock.fetchFn(input, { ...init, signal: null })
  }
}

/** `mock`'s fetchFn, with every reply arriving `ms` after its request. */
function delayed(mock: { fetchFn: typeof fetch }, ms: number): typeof fetch {
  return (input, init) => {
    const reply = mock.fetchFn(input, init)
    return new Promise(resolve => setTimeout(() => resolve(reply), ms))
  }
}

/** Esplora history whose confirmed chain never ends: every page has one new tx. */
function endlessEsploraHistory(i: number, url: string): MockReply {
  if (url === `${BASE}/address/${ADDR}`) return { body: JSON.stringify(STATS) }
  return { body: url.endsWith('/txs/mempool') ? '[]' : historyPage(i) }
}

afterEach(() => {
  vi.useRealTimers()
})

describe('caller cancellation (AbortSignal)', () => {
  it('stops an address-history scan mid-pagination and rejects promptly', async () => {
    const controller = new AbortController()
    const reachedThirdFetch = deferred()
    const { fetchFn, calls } = makeFetch((i, url) => {
      if (i === 2) {
        reachedThirdFetch.resolve()
        return hangForever()
      }
      return endlessEsploraHistory(i, url)
    })
    const client = new EsploraClient({ baseUrl: BASE, fetchFn })

    const outcome = track(client.getAddressHistory(ADDR, { signal: controller.signal }))
    await reachedThirdFetch.promise
    controller.abort()
    await flush()

    expect(outcome.settled).toBe(true)
    expect(outcome.error).toBeInstanceOf(QbitApiError)
    expect(outcome.error).toMatchObject({ kind: 'aborted' })
    expect(calls).toHaveLength(3)
  })

  it('issues no further page fetches once aborted between pages', async () => {
    const controller = new AbortController()
    const mock = longHistory('esplora')
    const client = new EsploraClient({ baseUrl: BASE, fetchFn: abortingAt(mock, 2, controller) })

    await expect(client.getAddressHistory(ADDR, { signal: controller.signal })).rejects.toMatchObject({
      kind: 'aborted',
    })
    await flush()
    expect(mock.requests).toHaveLength(3)
  })

  it('stops a mempool-qbit combined-history scan mid-pagination', async () => {
    const controller = new AbortController()
    const mock = longHistory('mempool-qbit')
    const client = new MempoolQbitClient({ baseUrl: BASE, fetchFn: abortingAt(mock, 1, controller) })

    await expect(client.getAddressHistory(ADDR, { signal: controller.signal })).rejects.toMatchObject({
      kind: 'aborted',
    })
    await flush()
    expect(mock.requests).toHaveLength(2)
  })

  it('maps an abort to `aborted` (not timeout/network) and does not retry it', async () => {
    const controller = new AbortController()
    const { fetchFn, calls } = makeFetch((_, __, init) => hangUntilAborted(init))
    const client = new EsploraClient({ baseUrl: BASE, fetchFn, retries: 2 })

    const pending = client.getAddressStats(ADDR, { signal: controller.signal })
    await flush()
    const reason = new Error('user navigated away')
    controller.abort(reason)

    const error = await pending.catch((e: unknown) => e)
    expect(error).toBeInstanceOf(QbitApiError)
    expect(error).toMatchObject({ kind: 'aborted', cause: reason })
    expect(calls).toHaveLength(1)
    expect(calls[0]!.init!.signal!.aborted).toBe(true)
  })

  it('wraps a reused earlier operation error as a fresh `aborted`, not as that error', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const { fetchFn } = makeFetch((_, __, init) => hangUntilAborted(init))
    const client = new EsploraClient({ baseUrl: BASE, fetchFn, retries: 0 })

    const first = track(client.getAddressStats(ADDR, { deadlineMs: 100 }))
    await vi.advanceTimersByTimeAsync(100)
    const earlier = first.error
    expect(earlier).toMatchObject({ kind: 'timeout' })

    // In flight: the caller aborts with the error an earlier call returned.
    const controller = new AbortController()
    const second = track(client.getAddressStats(ADDR, { signal: controller.signal }))
    await vi.advanceTimersByTimeAsync(0)
    controller.abort(earlier)
    await vi.advanceTimersByTimeAsync(0)
    expect(second.error).toBeInstanceOf(QbitApiError)
    expect(second.error).not.toBe(earlier)
    expect(second.error).toMatchObject({ kind: 'aborted', cause: earlier })

    // Already aborted before the call starts: same mapping.
    const third = await client.getAddressHistory(ADDR, { signal: AbortSignal.abort(earlier) }).catch((e: unknown) => e)
    expect(third).not.toBe(earlier)
    expect(third).toMatchObject({ kind: 'aborted', cause: earlier })

    // Same for the client-wide signal.
    const clientController = new AbortController()
    const scoped = new EsploraClient({ baseUrl: BASE, fetchFn, signal: clientController.signal })
    const fourth = track(scoped.getTipHeight())
    await vi.advanceTimersByTimeAsync(0)
    clientController.abort(earlier)
    await vi.advanceTimersByTimeAsync(0)
    expect(fourth.error).not.toBe(earlier)
    expect(fourth.error).toMatchObject({ kind: 'aborted', cause: earlier })
  })

  it('keeps a deadline as `timeout` through nested page fetches even when a caller signal is also given', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const controller = new AbortController()
    const { fetchFn } = makeFetch((_, __, init) => hangUntilAborted(init))
    const client = new MempoolQbitClient({ baseUrl: BASE, fetchFn, retries: 0 })

    const outcome = track(client.getAddressHistory(ADDR, { signal: controller.signal, deadlineMs: 100 }))
    await vi.advanceTimersByTimeAsync(100)
    expect(outcome.error).toMatchObject({ kind: 'timeout', message: 'operation exceeded its 100ms deadline' })
  })

  it('releases a late response from a fetch that ignores the abort', async () => {
    const controller = new AbortController()
    const gate = deferred()
    const { fetchFn, responses } = (() => {
      const responses: Response[] = []
      const fetchFn = (async () => {
        await gate.promise
        const response = new Response(JSON.stringify(STATS))
        responses.push(response)
        return response
      }) as typeof fetch
      return { fetchFn, responses }
    })()
    const client = new EsploraClient({ baseUrl: BASE, fetchFn })

    const pending = client.getAddressStats(ADDR, { signal: controller.signal })
    controller.abort()
    await expect(pending).rejects.toMatchObject({ kind: 'aborted' })

    gate.resolve()
    await flush()
    expect(responses).toHaveLength(1)
    expect(responses[0]!.bodyUsed).toBe(true)
  })

  it('rejects an already-aborted signal without making a request', async () => {
    const mock = longHistory('esplora')
    const calls = mock.requests
    const client = new EsploraClient({ baseUrl: BASE, fetchFn: mock.fetchFn })

    await expect(client.getAddressStats(ADDR, { signal: AbortSignal.abort() })).rejects.toMatchObject({
      kind: 'aborted',
    })
    await expect(client.getAddressHistory(ADDR, { signal: AbortSignal.abort() })).rejects.toMatchObject({
      kind: 'aborted',
    })
    expect(calls).toHaveLength(0)
  })

  it('rejects promptly when aborted while the response body is still streaming', async () => {
    const controller = new AbortController()
    // A body that never ends and ignores the abort, so only the client's own race against the signal ends the read.
    const stalledBody = new ReadableStream<Uint8Array>({ start() {} })
    const { fetchFn } = makeFetch(() => ({ body: stalledBody }))
    const client = new EsploraClient({ baseUrl: BASE, fetchFn })

    const outcome = track(client.getTipHash({ signal: controller.signal }))
    await flush()
    expect(outcome.settled).toBe(false)
    controller.abort()
    await flush()
    expect(outcome.error).toMatchObject({ kind: 'aborted' })
  })

  it('cancels every call on the client when the constructor signal aborts', async () => {
    const clientController = new AbortController()
    const { fetchFn, calls } = makeFetch((_, __, init) => hangUntilAborted(init))
    const client = new EsploraClient({ baseUrl: BASE, fetchFn, signal: clientController.signal })

    const pending = client.getTipHeight()
    await flush()
    clientController.abort()
    await expect(pending).rejects.toMatchObject({ kind: 'aborted' })
    await expect(client.getTipHash()).rejects.toMatchObject({ kind: 'aborted' })
    expect(calls).toHaveLength(1)
  })

  it('does not send the /tx/push fallback after the caller aborts the first broadcast', async () => {
    const controller = new AbortController()
    const { fetchFn, calls } = makeFetch((_, __, init) => hangUntilAborted(init))
    const client = new MempoolQbitClient({ baseUrl: BASE, fetchFn, retries: 2 })

    const pending = client.broadcastTx('00', { signal: controller.signal })
    await flush()
    controller.abort()
    await expect(pending).rejects.toMatchObject({ kind: 'unknown_outcome', cause: { kind: 'aborted' } })
    await flush()
    // The POST may have reached the node: it is neither retried nor re-sent via the fallback.
    expect(calls.map(call => call.url)).toEqual([`${BASE}/tx`])
  })

  it('rejects a broadcast with an already-aborted signal as aborted without sending it', async () => {
    const electrs = createMockEsplora({ backend: 'esplora', baseUrl: BASE })
    const hosted = createMockEsplora({ backend: 'mempool-qbit', baseUrl: BASE })
    const esplora = new EsploraClient({ baseUrl: BASE, fetchFn: electrs.fetchFn })
    const mempool = new MempoolQbitClient({ baseUrl: BASE, fetchFn: hosted.fetchFn })

    for (const client of [esplora, mempool]) {
      const error = await client.broadcastTx(P2MR_TX.rawTxHex, { signal: AbortSignal.abort() }).catch(e => e)
      // Nothing was sent, so this is a definite cancellation, not an unknown outcome.
      expect(error).toMatchObject({ kind: 'aborted' })
    }
    expect([...electrs.requests, ...hosted.requests]).toHaveLength(0)
  })

  it.each([
    ['an abort', { kind: 'aborted' }],
    ['an expired deadline', { kind: 'timeout' }],
  ])('reports %s while the POST is in flight as unknown_outcome with the txid', async (_label, cause) => {
    const controller = new AbortController()
    const { fetchFn, calls } = makeFetch((_, __, init) => hangUntilAborted(init))
    const client = new EsploraClient({ baseUrl: BASE, fetchFn, retries: 2 })

    const options = cause.kind === 'aborted' ? { signal: controller.signal } : { deadlineMs: 50 }
    const pending = client.broadcastTx(P2MR_TX.rawTxHex, options)
    await flush()
    controller.abort()
    const error = await pending.catch(e => e)
    expect(error).toBeInstanceOf(QbitApiError)
    expect(error).toMatchObject({ kind: 'unknown_outcome', txid: P2MR_TX.txid, cause })
    // The attempt may have reached the node, so it is never re-sent.
    expect(calls).toHaveLength(1)
  })
})

describe('abortable backoff', () => {
  /**
   * A 429 whose body never arrives and never finishes cancelling; records each
   * cancel request. A submission only retries a 429, which proves it was not
   * processed. The body is read under the attempt timer, so a short
   * `timeoutMs` ends the read and requests the cancel.
   */
  function unsettlingCancelFetch(): { fetchFn: typeof fetch; calls: unknown[]; cancels: number[] } {
    const cancels: number[] = []
    const { fetchFn, calls } = makeFetch(i => ({
      status: 429,
      body: new ReadableStream<Uint8Array>({
        cancel: () => {
          cancels.push(i)
          return new Promise<void>(() => {})
        },
      }),
    }))
    return { fetchFn, calls, cancels }
  }

  it('does not let a retryable response whose body cancel never settles block an abort', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const controller = new AbortController()
    const { fetchFn, calls, cancels } = unsettlingCancelFetch()
    const client = new EsploraClient({ baseUrl: BASE, fetchFn, timeoutMs: 5, retries: 2, retryBaseDelayMs: 60_000 })

    const outcome = track(client.broadcastTx('00', { signal: controller.signal }))
    await vi.advanceTimersByTimeAsync(10)
    expect(calls).toHaveLength(1)
    // Cleanup was still requested, just not awaited.
    expect(cancels).toEqual([0])

    controller.abort()
    await vi.advanceTimersByTimeAsync(0)
    expect(outcome.error).toMatchObject({ kind: 'aborted' })
    expect(vi.getTimerCount()).toBe(0)
    expect(calls).toHaveLength(1)
  })

  it('does not let a retryable response whose body cancel never settles outlive the deadline', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const { fetchFn, calls, cancels } = unsettlingCancelFetch()
    const client = new EsploraClient({ baseUrl: BASE, fetchFn, retries: 2, retryBaseDelayMs: 60_000 })

    const outcome = track(client.broadcastTx('00', { deadlineMs: 500 }))
    await vi.advanceTimersByTimeAsync(499)
    expect(outcome.settled).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    expect(outcome.error).toMatchObject({ kind: 'timeout' })
    expect(cancels).toEqual([0])
    expect(vi.getTimerCount()).toBe(0)
    expect(calls).toHaveLength(1)
  })

  it('still retries after a retryable response whose body cancel never settles', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const cancels: number[] = []
    const { fetchFn, calls } = makeFetch(i =>
      i === 0
        ? {
            status: 429,
            // Never arrives; read under the 5 ms attempt timer, then cancelled.
            body: new ReadableStream<Uint8Array>({
              cancel: () => {
                cancels.push(i)
                return new Promise<void>(() => {})
              },
            }),
          }
        : { body: 'ab'.repeat(32) }
    )
    const client = new EsploraClient({ baseUrl: BASE, fetchFn, timeoutMs: 5, retries: 2, retryBaseDelayMs: 100 })

    const outcome = track(client.broadcastTx('00'))
    await vi.advanceTimersByTimeAsync(105)
    expect(outcome.value).toBe('ab'.repeat(32))
    expect(cancels).toEqual([0])
    expect(calls).toHaveLength(2)
  })

  it('aborting during the default backoff rejects without waiting out the sleep', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const controller = new AbortController()
    const mock = createMockEsplora({
      backend: 'esplora',
      baseUrl: BASE,
      faults: [{ route: 'GET /address/:address', kind: 'status', status: 503, body: 'busy', times: Infinity }],
    })
    const { fetchFn, requests: calls } = mock
    const client = new EsploraClient({ baseUrl: BASE, fetchFn, retries: 2, retryBaseDelayMs: 60_000 })

    const outcome = track(client.getAddressStats(ADDR, { signal: controller.signal }))
    await vi.advanceTimersByTimeAsync(10)
    expect(calls).toHaveLength(1)
    expect(outcome.settled).toBe(false)

    controller.abort()
    await vi.advanceTimersByTimeAsync(0)
    expect(outcome.error).toMatchObject({ kind: 'aborted' })
    // The 60 s backoff timer was released, not left pending.
    expect(vi.getTimerCount()).toBe(0)
    expect(calls).toHaveLength(1)
  })

  it('passes the signal to a custom sleepFn and stops waiting even if it ignores it', async () => {
    const controller = new AbortController()
    const sleepFn = vi.fn((_ms: number, _signal?: AbortSignal) => new Promise<void>(() => {}))
    const mock = createMockEsplora({
      backend: 'esplora',
      baseUrl: BASE,
      faults: [{ route: 'GET /address/:address', kind: 'status', status: 503, body: 'busy', times: Infinity }],
    })
    const { fetchFn, requests: calls } = mock
    const client = new EsploraClient({ baseUrl: BASE, fetchFn, retries: 2, sleepFn })

    const outcome = track(client.getAddressStats(ADDR, { signal: controller.signal }))
    await flush()
    expect(sleepFn).toHaveBeenCalledTimes(1)
    const passedSignal = sleepFn.mock.calls[0]![1]!
    expect(passedSignal).toBeInstanceOf(AbortSignal)
    expect(passedSignal.aborted).toBe(false)

    controller.abort()
    await flush()
    expect(passedSignal.aborted).toBe(true)
    expect(outcome.error).toMatchObject({ kind: 'aborted' })
    expect(calls).toHaveLength(1)
  })
})

describe('per-call deadline (deadlineMs)', () => {
  it('rejects a full history scan at the deadline and stops fetching', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    // Each page takes 100 ms, and the confirmed chain outlasts the deadline.
    const mock = longHistory('esplora')
    const calls = mock.requests
    const client = new EsploraClient({ baseUrl: BASE, fetchFn: delayed(mock, 100) })

    const outcome = track(client.getAddressHistory(ADDR, { deadlineMs: 350 }))
    await vi.advanceTimersByTimeAsync(349)
    expect(outcome.settled).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    expect(outcome.error).toBeInstanceOf(QbitApiError)
    expect(outcome.error).toMatchObject({ kind: 'timeout' })
    expect((outcome.error as Error).message).toContain('350ms deadline')

    const fetchesAtDeadline = calls.length
    expect(fetchesAtDeadline).toBe(4)
    await vi.advanceTimersByTimeAsync(10_000)
    expect(calls).toHaveLength(fetchesAtDeadline)
  })

  it('bounds each attempt by the time left, not the full per-request timeout', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const { fetchFn, calls } = makeFetch((_, __, init) => hangUntilAborted(init))
    const client = new EsploraClient({ baseUrl: BASE, fetchFn, timeoutMs: 15_000, retries: 2 })

    const outcome = track(client.getTipHeight({ deadlineMs: 1_000 }))
    await vi.advanceTimersByTimeAsync(999)
    expect(outcome.settled).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    expect(outcome.error).toMatchObject({ kind: 'timeout' })
    // The deadline is final: the expired attempt is not retried.
    expect(calls).toHaveLength(1)
    expect(calls[0]!.init!.signal!.aborted).toBe(true)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('covers backoff: a deadline shorter than the backoff rejects at the deadline', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const mock = createMockEsplora({
      backend: 'esplora',
      baseUrl: BASE,
      faults: [{ route: 'GET /address/:address', kind: 'status', status: 503, body: 'busy', times: Infinity }],
    })
    const { fetchFn, requests: calls } = mock
    const client = new EsploraClient({ baseUrl: BASE, fetchFn, retries: 2, retryBaseDelayMs: 1_000 })

    const outcome = track(client.getAddressStats(ADDR, { deadlineMs: 500 }))
    await vi.advanceTimersByTimeAsync(499)
    expect(outcome.settled).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    expect(outcome.error).toMatchObject({ kind: 'timeout' })
    expect(calls).toHaveLength(1)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('still retries transient failures that fit inside the deadline', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const mock = longHistory('esplora', [{ route: 'GET /address/:address', kind: 'status', status: 503, body: 'busy' }])
    const calls = mock.requests
    const client = new EsploraClient({ baseUrl: BASE, fetchFn: mock.fetchFn, retries: 2, retryBaseDelayMs: 100 })

    const outcome = track(client.getAddressStats(ADDR, { deadlineMs: 1_000 }))
    await vi.advanceTimersByTimeAsync(100)
    expect(outcome.value).toMatchObject({ address: ADDR })
    expect(calls).toHaveLength(2)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('covers the mempool-qbit /tx/push broadcast fallback with the same deadline', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    // Each reply takes 600 ms: /tx declines with a 404, and the deadline fires during /tx/push.
    const mock = createMockEsplora({
      backend: 'mempool-qbit',
      baseUrl: BASE,
      faults: [{ route: 'POST /tx', kind: 'status', status: 404, body: 'Not Found' }],
    })
    const calls = mock.requests
    const client = new MempoolQbitClient({ baseUrl: BASE, fetchFn: delayed(mock, 600) })

    const outcome = track(client.broadcastTx('00', { deadlineMs: 1_000 }))
    await vi.advanceTimersByTimeAsync(999)
    expect(outcome.settled).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    // The deadline fired while the fallback POST was in flight.
    expect(outcome.error).toMatchObject({ kind: 'unknown_outcome', cause: { kind: 'timeout' } })
    expect(calls.map(call => call.url)).toEqual([`${BASE}/tx`, `${BASE}/tx/push`])
  })

  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 31])(
    'rejects an invalid deadlineMs (%s) before any request',
    async deadlineMs => {
      const mock = longHistory('esplora')
      const calls = mock.requests
      const client = new EsploraClient({ baseUrl: BASE, fetchFn: mock.fetchFn })

      await expect(client.getAddressStats(ADDR, { deadlineMs })).rejects.toMatchObject({ kind: 'http' })
      await expect(client.getAddressHistory(ADDR, { deadlineMs })).rejects.toMatchObject({ kind: 'http' })
      expect(calls).toHaveLength(0)
    }
  )
})

describe('shared (de-duplicated) GETs', () => {
  it('one caller aborting does not cancel the request another caller is waiting on', async () => {
    const gate = deferred()
    const { fetchFn, calls } = makeFetch(async () => {
      await gate.promise
      return { body: JSON.stringify(STATS) }
    })
    const client = new EsploraClient({ baseUrl: BASE, fetchFn })
    const controller = new AbortController()

    const aborted = client.getAddressStats(ADDR, { signal: controller.signal })
    const survivor = client.getAddressStats(ADDR)
    controller.abort()
    await expect(aborted).rejects.toMatchObject({ kind: 'aborted' })

    gate.resolve()
    expect((await survivor).address).toBe(ADDR)
    expect(calls).toHaveLength(1)
    expect(calls[0]!.init!.signal!.aborted).toBe(false)
  })

  it('aborts the shared request once every caller has abandoned it', async () => {
    const { fetchFn, calls } = makeFetch((i, _, init) =>
      i === 0 ? hangUntilAborted(init) : { body: JSON.stringify(STATS) }
    )
    const client = new EsploraClient({ baseUrl: BASE, fetchFn, retries: 2 })
    const first = new AbortController()
    const second = new AbortController()

    const a = client.getAddressStats(ADDR, { signal: first.signal })
    const b = client.getAddressStats(ADDR, { signal: second.signal })
    first.abort()
    second.abort()
    await expect(a).rejects.toMatchObject({ kind: 'aborted' })
    await expect(b).rejects.toMatchObject({ kind: 'aborted' })
    await flush()
    expect(calls).toHaveLength(1)
    expect(calls[0]!.init!.signal!.aborted).toBe(true)

    // The abandoned entry is gone: a new caller starts a fresh request.
    expect((await client.getAddressStats(ADDR)).address).toBe(ADDR)
    expect(calls).toHaveLength(2)
  })
})

describe('body release on abort or deadline', () => {
  /** A body that sends nothing until `push`/`end` are called; records every cancel. */
  function controllableBody(): {
    body: ReadableStream<Uint8Array>
    cancels: unknown[]
    push: (text: string) => void
    end: () => void
  } {
    const cancels: unknown[] = []
    let source!: ReadableStreamDefaultController<Uint8Array>
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        source = controller
      },
      cancel(reason) {
        cancels.push(reason)
      },
    })
    return {
      body,
      cancels,
      push: text => source.enqueue(new TextEncoder().encode(text)),
      end: () => source.close(),
    }
  }

  it('cancels a stalled body when the caller aborts during the read', async () => {
    const controller = new AbortController()
    const { body, cancels } = controllableBody()
    const { fetchFn } = makeFetch(() => ({ body }))
    const client = new EsploraClient({ baseUrl: BASE, fetchFn })

    const outcome = track(client.getAddressStats(ADDR, { signal: controller.signal }))
    await flush()
    expect(outcome.settled).toBe(false)
    controller.abort(new Error('user left'))
    await flush()
    expect(outcome.error).toMatchObject({ kind: 'aborted' })
    expect(cancels).toHaveLength(1)
    // The shared attempt reads the body, so it is cancelled with that request's
    // own `aborted` reason once its only caller has left.
    expect(cancels[0]).toBeInstanceOf(QbitApiError)
    expect(cancels[0]).toMatchObject({ kind: 'aborted', message: expect.stringContaining('request abandoned') })
    expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0)
  })

  it('cancels a stalled body when the deadline expires during the read', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const { body, cancels } = controllableBody()
    const { fetchFn } = makeFetch(() => ({ body }))
    const client = new EsploraClient({ baseUrl: BASE, fetchFn })

    const outcome = track(client.getTipHash({ deadlineMs: 500 }))
    await vi.advanceTimersByTimeAsync(499)
    expect(outcome.settled).toBe(false)
    expect(cancels).toHaveLength(0)
    await vi.advanceTimersByTimeAsync(1)
    expect(outcome.error).toMatchObject({ kind: 'timeout' })
    expect(cancels).toHaveLength(1)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('cancels a stalled broadcast response body on abort', async () => {
    const controller = new AbortController()
    const { body, cancels } = controllableBody()
    const { fetchFn, calls } = makeFetch(() => ({ body }))
    const client = new MempoolQbitClient({ baseUrl: BASE, fetchFn })

    const outcome = track(client.broadcastTx('00', { signal: controller.signal }))
    await flush()
    controller.abort()
    await flush()
    // The reply had started arriving, so the submission's outcome is unknown.
    expect(outcome.error).toMatchObject({ kind: 'unknown_outcome', cause: { kind: 'aborted' } })
    expect(cancels).toHaveLength(1)
    expect(calls).toHaveLength(1)
  })

  it('does not cancel a shared body while another de-duplicated caller still reads it', async () => {
    const controller = new AbortController()
    const { body, cancels, push, end } = controllableBody()
    const { fetchFn, calls } = makeFetch(() => ({ body }))
    const client = new EsploraClient({ baseUrl: BASE, fetchFn })

    const aborted = track(client.getAddressStats(ADDR, { signal: controller.signal }))
    const survivor = client.getAddressStats(ADDR)
    await flush()
    controller.abort()
    await flush()
    expect(aborted.error).toMatchObject({ kind: 'aborted' })
    expect(cancels).toHaveLength(0)

    push(JSON.stringify(STATS))
    end()
    expect((await survivor).address).toBe(ADDR)
    expect(calls).toHaveLength(1)
    expect(cancels).toHaveLength(0)
  })

  it('cancels a shared body once every de-duplicated caller abandons the read', async () => {
    const first = new AbortController()
    const second = new AbortController()
    const { body, cancels } = controllableBody()
    const { fetchFn } = makeFetch(() => ({ body }))
    const client = new EsploraClient({ baseUrl: BASE, fetchFn })

    const a = track(client.getAddressStats(ADDR, { signal: first.signal }))
    const b = track(client.getAddressStats(ADDR, { signal: second.signal }))
    await flush()
    first.abort()
    await flush()
    expect(cancels).toHaveLength(0)
    second.abort()
    await flush()
    expect(a.error).toMatchObject({ kind: 'aborted' })
    expect(b.error).toMatchObject({ kind: 'aborted' })
    expect(cancels).toHaveLength(1)
    expect(getEventListeners(first.signal, 'abort')).toHaveLength(0)
    expect(getEventListeners(second.signal, 'abort')).toHaveLength(0)
  })

  it('decodes a body split mid-character across chunks and leaves no listeners', async () => {
    const controller = new AbortController()
    const bytes = new TextEncoder().encode('\uFEFFtip-hash-\u00e9\u20ac')
    const body = new ReadableStream<Uint8Array>({
      start(source) {
        // Split inside the multi-byte characters.
        source.enqueue(bytes.slice(0, 13))
        source.enqueue(bytes.slice(13, 15))
        source.enqueue(bytes.slice(15))
        source.close()
      },
    })
    const { fetchFn } = makeFetch(() => ({ body }))
    class TextClient extends EsploraClient {
      text(path: string, options?: RequestOptions) {
        return this.getText(path, options)
      }
    }
    const client = new TextClient({ baseUrl: BASE, fetchFn })

    // getText does not trim, so this also checks the BOM is stripped like `Response.text()`.
    expect(await client.text('/blocks/tip/hash', { signal: controller.signal })).toBe('tip-hash-\u00e9\u20ac')
    expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0)
  })
})

describe('resource cleanup', () => {
  it('removes its listeners from the caller signal on success, failure, and abort', async () => {
    const mock = longHistory('esplora', [{ route: 'GET /tx/:txid', kind: 'status', status: 404, body: 'Not Found' }])
    const client = new EsploraClient({ baseUrl: BASE, fetchFn: mock.fetchFn, retries: 0 })
    const controller = new AbortController()
    const { signal } = controller

    await client.getAddressStats(ADDR, { signal, deadlineMs: 5_000 }).catch(() => undefined)
    expect(getEventListeners(signal, 'abort')).toHaveLength(0)

    await expect(client.getTx('missing', { signal })).rejects.toMatchObject({ kind: 'not_found' })
    expect(getEventListeners(signal, 'abort')).toHaveLength(0)

    await expect(client.getAddressHistory(ADDR, { signal, maxPages: 3 })).rejects.toMatchObject({
      kind: 'pagination_limit',
    })
    expect(getEventListeners(signal, 'abort')).toHaveLength(0)
  })

  it('clears the deadline timer once the call settles', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const client = new EsploraClient({ baseUrl: BASE, fetchFn: longHistory('esplora').fetchFn })

    const outcome = track(client.getAddressStats(ADDR, { deadlineMs: 60_000 }))
    await vi.advanceTimersByTimeAsync(0)
    expect(outcome.value).toMatchObject({ address: ADDR })
    expect(vi.getTimerCount()).toBe(0)
  })
})

import { readFileSync } from 'node:fs'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { EsploraClient, MempoolQbitClient, QbitApiError, type RequestOptions } from '../src/index'

// Pins the points where a broadcast abort or deadline switches between a
// definite `aborted` / `timeout` (nothing may have been sent) and
// `unknown_outcome` (a POST may have reached the node).

interface MockReply {
  status?: number
  body?: string
}

type Handler = (callIndex: number, url: string, init: RequestInit | undefined) => MockReply | Promise<MockReply>

function makeFetch(handler: Handler): {
  fetchFn: typeof fetch
  calls: { url: string; init?: RequestInit }[]
} {
  const calls: { url: string; init?: RequestInit }[] = []
  const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    const index = calls.length
    calls.push({ url, init })
    const reply = await handler(index, url, init)
    return new Response(reply.body ?? '', { status: reply.status ?? 200 })
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

/** Undici's failure for a refused connection: nothing was sent. */
function connectionRefused(): TypeError {
  const cause = Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:3000'), {
    code: 'ECONNREFUSED',
    syscall: 'connect',
  })
  return Object.assign(new TypeError('fetch failed'), { cause })
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

const BASE = 'https://esplora.example/regtest/api'

/** A real P2MR transaction whose txid the client derives from the hex (see broadcast.test.ts). */
const P2MR_TX = JSON.parse(readFileSync(new URL('./fixtures/p2mr-witness-tx.json', import.meta.url), 'utf8')) as {
  rawTxHex: string
  txid: string
}

const CLIENTS = [
  ['EsploraClient', EsploraClient],
  ['MempoolQbitClient', MempoolQbitClient],
] as const

const STOPS = [
  ['an abort', 'aborted'],
  ['an expired deadline', 'timeout'],
] as const

/** Start a broadcast that `stop` ends: by aborting at 10ms, or by a 500ms deadline. */
function startBroadcast(client: EsploraClient, stop: 'aborted' | 'timeout') {
  const controller = new AbortController()
  const reason = new Error('caller gave up')
  const options = stop === 'aborted' ? { signal: controller.signal } : { deadlineMs: 500 }
  const outcome = track(client.broadcastTx(P2MR_TX.rawTxHex, options))
  return {
    outcome,
    reason,
    /** Run the clock to 500ms, aborting at 10ms when `stop` is an abort. */
    async stopAfter10ms(): Promise<void> {
      await vi.advanceTimersByTimeAsync(10)
      expect(outcome.settled).toBe(false)
      if (stop === 'aborted') controller.abort(reason)
      await vi.advanceTimersByTimeAsync(490)
    },
  }
}

afterEach(() => {
  vi.useRealTimers()
})

describe('broadcast abort and deadline boundaries', () => {
  it.each(CLIENTS.flatMap(([name, Client]) => STOPS.map(([label, kind]) => [name, label, kind, Client] as const)))(
    '%s: %s during the backoff after a pre-connection failure is a definite %s',
    async (_name, _label, kind, Client) => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
      const { fetchFn, calls } = makeFetch(() => {
        throw connectionRefused()
      })
      const client = new Client({ baseUrl: BASE, fetchFn, retries: 2, retryBaseDelayMs: 60_000 })

      const { outcome, reason, stopAfter10ms } = startBroadcast(client, kind)
      await stopAfter10ms()

      // The only attempt never connected, so nothing reached the node.
      expect(outcome.error).toBeInstanceOf(QbitApiError)
      expect(outcome.error).toMatchObject({ kind })
      expect((outcome.error as QbitApiError).txid).toBeUndefined()
      if (kind === 'aborted') expect((outcome.error as QbitApiError).cause).toBe(reason)
      expect(calls.map(call => call.url)).toEqual([`${BASE}/tx`])
      expect(vi.getTimerCount()).toBe(0)
    }
  )

  it.each(
    CLIENTS.flatMap(([name, Client]) =>
      (['a 429', 'a pre-connection failure'] as const).flatMap(first =>
        STOPS.map(([label, kind]) => [name, label, first, kind, Client] as const)
      )
    )
  )(
    '%s: %s while the attempt re-sent after %s is in flight is unknown_outcome (%s)',
    async (_name, _label, first, kind, Client) => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
      const { fetchFn, calls } = makeFetch((i, _, init) => {
        if (i > 0) return hangUntilAborted(init)
        if (first === 'a 429') return { status: 429, body: 'slow down' }
        throw connectionRefused()
      })
      // The re-sent attempt starts after the 5ms backoff, before the stop at 10ms.
      const client = new Client({ baseUrl: BASE, fetchFn, retries: 2, retryBaseDelayMs: 5 })

      const { outcome, reason, stopAfter10ms } = startBroadcast(client, kind)
      await stopAfter10ms()

      // The second POST may have reached the node, whatever happened to the first.
      expect(outcome.error).toBeInstanceOf(QbitApiError)
      expect(outcome.error).toMatchObject({
        kind: 'unknown_outcome',
        txid: P2MR_TX.txid,
        // Error URLs redact the base path, so match either spelling.
        url: expect.stringMatching(/^https:\/\/esplora\.example\/.*\/tx$/),
        cause: { kind },
      })
      if (kind === 'aborted') expect(((outcome.error as QbitApiError).cause as QbitApiError).cause).toBe(reason)
      expect(calls.map(call => call.url)).toEqual([`${BASE}/tx`, `${BASE}/tx`])
      expect(vi.getTimerCount()).toBe(0)
    }
  )

  it('MempoolQbitClient: an abort after /tx rejects definitively, before /tx/push starts, is a definite aborted', async () => {
    const controller = new AbortController()
    const reason = new Error('caller gave up')
    const { fetchFn, calls } = makeFetch(() => ({ status: 404, body: 'Not Found' }))
    // Abort exactly between the two submissions: once /tx has settled, before the fallback is called.
    class AbortAfterTx extends MempoolQbitClient {
      protected override async submitTx(
        path: string,
        body: string,
        txid: string | undefined,
        options?: RequestOptions
      ): Promise<string> {
        try {
          return await super.submitTx(path, body, txid, options)
        } catch (error) {
          if (path === '/tx') controller.abort(reason)
          throw error
        }
      }
    }
    const client = new AbortAfterTx({ baseUrl: BASE, fetchFn })

    const error = await client.broadcastTx(P2MR_TX.rawTxHex, { signal: controller.signal }).catch(e => e)

    // /tx was rejected outright and /tx/push was never sent.
    expect(error).toBeInstanceOf(QbitApiError)
    expect(error).toMatchObject({ kind: 'aborted', cause: reason })
    expect(calls.map(call => call.url)).toEqual([`${BASE}/tx`])
  })
})

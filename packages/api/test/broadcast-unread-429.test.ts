import { describe, expect, it } from 'vitest'

import { EsploraClient, MempoolQbitClient, QbitApiError, txidFromRawTx } from '../src/index'

// A submission's 429 proves nothing was processed only through its body, read
// in full: the outcome table lets an already-known body resolve, and a relayed
// transport failure is unknown_outcome. So a 429 whose body never arrives is
// unknown_outcome at once, a 429 whose body carries such a verdict is judged
// rather than re-sent, and only one whose whole body carries none is re-sent
// (or, once cut short by an abort after it was read, a definite `aborted`).

interface MockReply {
  status?: number
  body?: string | ReadableStream<Uint8Array>
  headers?: Record<string, string>
}

// Not the testing kit: its stalled body errors once the request's signal
// aborts, as undici's does, so a client that never timed out its own body read
// would pass. These bodies ignore the signal, so only the client's
// `timeoutMs` race ends the read.
function makeFetch(handler: (callIndex: number) => MockReply) {
  const calls: string[] = []
  const fetchFn = (async (input: RequestInfo | URL) => {
    calls.push(String(input))
    const reply = handler(calls.length - 1)
    return new Response(reply.body ?? '', {
      status: reply.status ?? 200,
      ...(reply.headers ? { headers: reply.headers } : {}),
    })
  }) as typeof fetch
  return { fetchFn, calls }
}

const BASE = 'https://esplora.example/regtest/api'
// Bitcoin's genesis coinbase: a well-formed legacy transaction.
const TX =
  '01000000010000000000000000000000000000000000000000000000000000000000000000ffffffff4d04ffff001d0104455468652054696d65732030332f4a616e2f32303039204368616e63656c6c6f72206f6e206272696e6b206f66207365636f6e64206261696c6f757420666f722062616e6b73ffffffff0100f2052a01000000434104678afdb0fe5548271967f1a67130b7105cd6a828e03909a67962e0ea1f61deb649f6bc3f4cef38c4f35504e51ec112de5c384df7ba0b8d578a4c702b6bf11d5fac00000000'

const TXID = txidFromRawTx(TX)

async function rejection(promise: Promise<unknown>): Promise<QbitApiError> {
  const error = await promise.then(
    () => undefined,
    (caught: unknown) => caught
  )
  expect(QbitApiError.is(error)).toBe(true)
  return error as QbitApiError
}

describe('broadcastTx with a 429 whose body never arrives', () => {
  it.each(['3600', '5'])('is unknown_outcome at once, without re-sending, with Retry-After %s', async retryAfter => {
    const sleeps: number[] = []
    const { fetchFn, calls } = makeFetch(i =>
      i === 0
        ? { status: 429, headers: { 'retry-after': retryAfter }, body: new ReadableStream<Uint8Array>({}) }
        : { body: TXID }
    )
    const client = new EsploraClient({
      baseUrl: BASE,
      fetchFn,
      timeoutMs: 20,
      retries: 2,
      sleepFn: async ms => {
        sleeps.push(ms)
      },
    })

    const error = await rejection(client.broadcastTx(TX))
    expect(error).toMatchObject({ kind: 'unknown_outcome', status: 429, txid: TXID, cause: { kind: 'timeout' } })
    expect(error.retryAfterMs).toBeUndefined()
    expect(calls).toHaveLength(1)
    expect(sleeps).toEqual([])
  })
})

describe('broadcastTx with a 429 whose body carries a verdict', () => {
  const ALREADY_KNOWN = JSON.stringify({ error: { code: -27, message: 'Transaction already in block chain' } })
  const TRANSPORT_FAILURE = JSON.stringify({ code: 'ETIMEDOUT', message: 'socket hang up' })

  it.each([
    ['EsploraClient', EsploraClient],
    ['MempoolQbitClient', MempoolQbitClient],
  ] as const)(
    '%s: resolves an already-known 429 with the known txid instead of re-sending it',
    async (_name, Client) => {
      const sleeps: number[] = []
      const { fetchFn, calls } = makeFetch(() => ({ status: 429, body: ALREADY_KNOWN }))
      const client = new Client({ baseUrl: BASE, fetchFn, retries: 2, sleepFn: async ms => void sleeps.push(ms) })

      await expect(client.broadcastTx(TX)).resolves.toBe(TXID)
      expect(calls).toEqual([`${BASE}/tx`])
      expect(sleeps).toEqual([])

      // Without a known txid, it is unknown_outcome, still not re-sent.
      const unknown = await rejection(client.broadcastTx('00'))
      expect(unknown).toMatchObject({ kind: 'unknown_outcome', status: 429 })
      expect(unknown.message).toContain('node already knows the transaction')
      expect(calls).toEqual([`${BASE}/tx`, `${BASE}/tx`])
    }
  )

  it.each([
    ['EsploraClient', EsploraClient],
    ['MempoolQbitClient', MempoolQbitClient],
  ] as const)(
    '%s: ends a 429 relaying a transport failure as unknown_outcome, never re-sent, unlike one without a verdict',
    async (_name, Client) => {
      const sleeps: number[] = []
      let first = TRANSPORT_FAILURE
      const { fetchFn, calls } = makeFetch(i =>
        i === 0 || first === '' ? { status: 429, body: first } : { body: TXID }
      )
      const client = new Client({ baseUrl: BASE, fetchFn, retries: 2, sleepFn: async ms => void sleeps.push(ms) })

      const error = await rejection(client.broadcastTx(TX))
      expect(error).toMatchObject({ kind: 'unknown_outcome', status: 429, txid: TXID })
      expect(error.message).toContain('backend lost its node connection')
      expect(calls).toEqual([`${BASE}/tx`])
      expect(sleeps).toEqual([])

      // A 429 whose whole body carries no verdict proves nothing was processed:
      // it is re-sent, and an abort while waiting to re-send it is a definite aborted.
      first = ''
      const controller = new AbortController()
      const waiting = new Client({
        baseUrl: BASE,
        fetchFn,
        retries: 2,
        sleepFn: async ms => {
          sleeps.push(ms)
          if (sleeps.length === 2) controller.abort(new Error('user'))
        },
      })
      const aborted = await rejection(waiting.broadcastTx(TX, { signal: controller.signal }))
      expect(aborted).toMatchObject({ kind: 'aborted' })
      expect(aborted.txid).toBeUndefined()
      expect(calls).toHaveLength(3)
    }
  )
})

/** A 429 whose `statusText` aborts `controller`: read only to build the buffered copy, once the whole body is in. */
function abortingOnceRead(body: string, controller: AbortController, calls: string[]): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    calls.push(String(input))
    return {
      status: 429,
      // Lands the abort between the buffered read and the reply check.
      get statusText() {
        controller.abort(new Error('user'))
        return 'Too Many Requests'
      },
      headers: new Headers(),
      url: String(input),
      body: new Response(body).body,
    } as unknown as Response
  }) as typeof fetch
}

describe('broadcastTx aborted after the final 429 is read', () => {
  it('is a definite aborted when its whole body carries no verdict, not an unknown outcome', async () => {
    const controller = new AbortController()
    const calls: string[] = []
    const client = new EsploraClient({
      baseUrl: BASE,
      fetchFn: abortingOnceRead('slow down', controller, calls),
      retries: 0,
    })

    await expect(client.broadcastTx(TX, { signal: controller.signal })).rejects.toMatchObject({ kind: 'aborted' })
    expect(calls).toHaveLength(1)
  })

  it.each([
    ['says the node already has it', JSON.stringify({ code: -27, message: 'already in block chain' })],
    ['relays a transport failure', JSON.stringify({ code: 'ECONNRESET' })],
  ])('is unknown_outcome when its whole body %s', async (_label, body) => {
    const controller = new AbortController()
    const calls: string[] = []
    const client = new EsploraClient({ baseUrl: BASE, fetchFn: abortingOnceRead(body, controller, calls), retries: 0 })

    const error = await rejection(client.broadcastTx(TX, { signal: controller.signal }))
    expect(error).toMatchObject({ kind: 'unknown_outcome', status: 429, txid: TXID, cause: { kind: 'aborted' } })
    expect(calls).toHaveLength(1)
  })
})

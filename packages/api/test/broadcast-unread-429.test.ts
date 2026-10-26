import { describe, expect, it } from 'vitest'

import { EsploraClient } from '../src/index'

// A 429 proves the submission was not processed, even when its body can't be
// read, so its Retry-After (and the maxRetryAfterMs cap) still apply and an
// abort after it is read is a definite `aborted`.

interface MockReply {
  status?: number
  body?: string | ReadableStream<Uint8Array>
  headers?: Record<string, string>
}

function makeFetch(handler: (callIndex: number) => MockReply) {
  const calls: string[] = []
  const fetchFn = (async (input: RequestInfo | URL) => {
    calls.push(String(input))
    const reply = handler(calls.length - 1)
    return new Response(reply.body ?? '', { status: reply.status ?? 200, headers: reply.headers })
  }) as typeof fetch
  return { fetchFn, calls }
}

const BASE = 'https://esplora.example/regtest/api'
// Bitcoin's genesis coinbase: a well-formed legacy transaction.
const TX =
  '01000000010000000000000000000000000000000000000000000000000000000000000000ffffffff4d04ffff001d0104455468652054696d65732030332f4a616e2f32303039204368616e63656c6c6f72206f6e206272696e6b206f66207365636f6e64206261696c6f757420666f722062616e6b73ffffffff0100f2052a01000000434104678afdb0fe5548271967f1a67130b7105cd6a828e03909a67962e0ea1f61deb649f6bc3f4cef38c4f35504e51ec112de5c384df7ba0b8d578a4c702b6bf11d5fac00000000'

describe('broadcastTx with a 429 whose body never arrives', () => {
  it('rejects at once as rate_limit when Retry-After is over the cap, without re-sending', async () => {
    const sleeps: number[] = []
    const { fetchFn, calls } = makeFetch(() => ({
      status: 429,
      headers: { 'retry-after': '3600' },
      body: new ReadableStream<Uint8Array>({}),
    }))
    const client = new EsploraClient({
      baseUrl: BASE,
      fetchFn,
      timeoutMs: 20,
      retries: 2,
      sleepFn: async ms => {
        sleeps.push(ms)
      },
    })

    await expect(client.broadcastTx(TX)).rejects.toMatchObject({ kind: 'rate_limit', retryAfterMs: 3_600_000 })
    expect(calls).toHaveLength(1)
    expect(sleeps).toEqual([])
  })

  it('waits for a Retry-After within the cap before retrying', async () => {
    const sleeps: number[] = []
    const { fetchFn } = makeFetch(i =>
      i === 0
        ? { status: 429, headers: { 'retry-after': '5' }, body: new ReadableStream<Uint8Array>({}) }
        : { body: 'ab'.repeat(32) }
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

    await expect(client.broadcastTx('00')).resolves.toBe('ab'.repeat(32))
    expect(sleeps).toEqual([5_000])
  })
})

describe('broadcastTx aborted after the final 429 is read', () => {
  it('is a definite aborted, not an unknown outcome', async () => {
    const controller = new AbortController()
    const calls: string[] = []
    const fetchFn = (async (input: RequestInfo | URL) => {
      calls.push(String(input))
      return {
        status: 429,
        statusText: 'Too Many Requests',
        headers: new Headers(),
        // Read once the body is buffered: lands the abort between the buffered
        // read and the reply check.
        get url() {
          controller.abort(new Error('user'))
          return String(input)
        },
        body: new Response('slow down').body,
      } as unknown as Response
    }) as typeof fetch
    const client = new EsploraClient({ baseUrl: BASE, fetchFn, retries: 0 })

    await expect(client.broadcastTx(TX, { signal: controller.signal })).rejects.toMatchObject({ kind: 'aborted' })
    expect(calls).toHaveLength(1)
  })
})

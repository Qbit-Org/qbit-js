import { describe, expect, it } from 'vitest'

import { EsploraClient } from '../src/index'

// A GET whose transient reply (429/5xx) fails or stalls mid-body is retried
// like the status itself; only the final attempt's failure surfaces.

const BASE = 'https://esplora.example/regtest/api'

function resetBody(): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('Service Unav'))
      controller.error(new Error('read ECONNRESET'))
    },
  })
}

// Not the testing kit: these bodies fail mid-read, which the kit does not model
// (its stall fault never ends a body; it does not break one).
function makeFetch(replies: Array<() => Response>) {
  let calls = 0
  const fetchFn = (async () => {
    const reply = replies[Math.min(calls, replies.length - 1)]!
    calls += 1
    return reply()
  }) as typeof fetch
  return { fetchFn, calls: () => calls }
}

function client(fetchFn: typeof fetch, sleeps: number[], retries = 2) {
  return new EsploraClient({
    baseUrl: BASE,
    fetchFn,
    retries,
    timeoutMs: 50,
    sleepFn: async ms => {
      sleeps.push(ms)
    },
  })
}

describe('reads retry a transient reply whose body fails', () => {
  it.each([503, 429])('retries a %i whose body resets mid-read', async status => {
    const sleeps: number[] = []
    const { fetchFn, calls } = makeFetch([
      () => new Response(resetBody(), { status }),
      () => new Response('123', { status: 200 }),
    ])
    await expect(client(fetchFn, sleeps).getTipHeight()).resolves.toBe(123)
    expect(calls()).toBe(2)
    expect(sleeps).toHaveLength(1)
  })

  it('waits for a Retry-After within the cap', async () => {
    const sleeps: number[] = []
    const { fetchFn } = makeFetch([
      () => new Response(resetBody(), { status: 503, headers: { 'retry-after': '2' } }),
      () => new Response('123', { status: 200 }),
    ])
    await expect(client(fetchFn, sleeps).getTipHeight()).resolves.toBe(123)
    expect(sleeps).toEqual([2_000])
  })

  it('surfaces the body failure once retries run out', async () => {
    const sleeps: number[] = []
    const { fetchFn, calls } = makeFetch([() => new Response(resetBody(), { status: 503 })])
    await expect(client(fetchFn, sleeps).getTipHeight()).rejects.toMatchObject({ kind: 'parse' })
    expect(calls()).toBe(3)
  })

  it('does not wait when Retry-After is over the cap', async () => {
    const sleeps: number[] = []
    const { fetchFn, calls } = makeFetch([
      () => new Response(resetBody(), { status: 429, headers: { 'retry-after': '3600' } }),
    ])
    await expect(client(fetchFn, sleeps).getTipHeight()).rejects.toMatchObject({ kind: 'parse' })
    expect(calls()).toBe(1)
    expect(sleeps).toEqual([])
  })
})

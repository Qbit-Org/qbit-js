import { describe, expect, it } from 'vitest'

import { EsploraClient, QbitApiError } from '../src/index'

// Whether a failed submission may be re-sent is judged on the original fetch
// error. The `cause` callers see is a depth-limited redacted copy, which can
// drop a nested failure that means the POST may have reached the server.

const BASE = 'https://esplora.example/regtest/api'
const LEGACY_TX_HEX =
  '01000000010000000000000000000000000000000000000000000000000000000000000000ffffffff4d04ffff001d0104455468652054696d65732030332f4a616e2f32303039204368616e63656c6c6f72206f6e206272696e6b206f66207365636f6e64206261696c6f757420666f722062616e6b73ffffffff0100f2052a01000000434104678afdb0fe5548271967f1a67130b7105cd6a828e03909a67962e0ea1f61deb649f6bc3f4cef38c4f35504e51ec112de5c384df7ba0b8d578a4c702b6bf11d5fac00000000'
const TXID = '4a5e1e4baab89f3a32518a88c31bc87f618f76673e2cc77ab2127b7afdeda33b'

function withCode(message: string, code: string, syscall?: string): Error {
  return Object.assign(new Error(message), syscall === undefined ? { code } : { code, syscall })
}

function fetchFailed(cause: unknown): TypeError {
  return Object.assign(new TypeError('fetch failed'), { cause })
}

function nest(error: unknown, levels: number): unknown {
  let value = error
  for (let i = 0; i < levels; i += 1) value = new AggregateError([value], 'nested')
  return value
}

async function broadcastFailing(cause: () => unknown) {
  let calls = 0
  const client = new EsploraClient({
    baseUrl: BASE,
    retries: 2,
    sleepFn: () => Promise.resolve(),
    fetchFn: (async () => {
      calls += 1
      throw fetchFailed(cause())
    }) as typeof fetch,
  })
  const error = await client.broadcastTx(LEGACY_TX_HEX).then(
    () => undefined,
    (reason: unknown) => reason
  )
  expect(error).toBeInstanceOf(QbitApiError)
  return { error: error as QbitApiError, calls }
}

describe('submission retry classification uses the original fetch error', () => {
  it('does not re-send when a nested member reset after connecting', async () => {
    const { error, calls } = await broadcastFailing(
      () =>
        new AggregateError([
          withCode('connect ECONNREFUSED', 'ECONNREFUSED', 'connect'),
          nest(withCode('read ECONNRESET', 'ECONNRESET', 'read'), 4),
        ])
    )
    expect(error).toMatchObject({ kind: 'unknown_outcome', txid: TXID })
    expect(calls).toBe(1)
  })

  it('does not re-send when part of the error is nested too deep to judge', async () => {
    const { error, calls } = await broadcastFailing(
      () =>
        new AggregateError([
          withCode('connect ECONNREFUSED', 'ECONNREFUSED', 'connect'),
          nest(withCode('read ECONNRESET', 'ECONNRESET', 'read'), 10),
        ])
    )
    expect(error).toMatchObject({ kind: 'unknown_outcome', txid: TXID })
    expect(calls).toBe(1)
  })

  it('still retries a plain pre-connection failure', async () => {
    const { error, calls } = await broadcastFailing(() => withCode('connect ECONNREFUSED', 'ECONNREFUSED', 'connect'))
    expect(error.kind).toBe('network')
    expect(calls).toBe(3)
  })
})

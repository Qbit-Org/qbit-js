import { describe, expect, it, vi } from 'vitest'

import {
  EsploraClient,
  MempoolQbitClient,
  QbitApiError,
  type QbitApiErrorKind,
  type QbitApiErrorOptions,
} from '../src/index'

// The client used to recognize a `QbitApiError` thrown by a custom
// fetchFn with `instanceof`, so one from the other build (an ESM-loaded fetch
// wrapper feeding a client from the CommonJS build) was re-wrapped as
// `network`: a read retried it and its kind was lost. The client now uses
// `QbitApiError.is`. What it decides from state only the creating copy holds
// (the unredacted cause, the raw response body) stays fail-closed for an
// error from another copy: a submission is never re-sent on its account.
//
// A second module instance stands in for the other build, with its own class
// and private state; scripts/check-packed-consumer.mjs runs the packed pair.

const BASE = 'https://esplora.example/api'

/** A one-input, one-output legacy transaction and its txid, computed independently. */
const LEGACY_TX_HEX =
  '020000000111111111111111111111111111111111111111111111111111111111111111110000000000ffffffff0100000000000000000000000000'
const LEGACY_TXID = '992393c6db57a325f48e3097a50c45349c3eb27df5160a68cbb7a022f98c2dc2'

const BRAND = Symbol.for('qbit-js.QbitApiError')
const RETRIES = 2

type ErrorClass = typeof QbitApiError

async function otherCopyClass(): Promise<ErrorClass> {
  vi.resetModules()
  const other = await import('../src/index')
  expect(other.QbitApiError).not.toBe(QbitApiError)
  return other.QbitApiError
}

/** This copy's class and another copy's, to build the same error from each. */
async function copies(): Promise<[string, ErrorClass][]> {
  return [
    ['this copy', QbitApiError],
    ['another copy', await otherCopyClass()],
  ]
}

/** A client whose fetchFn throws `error` on every call, recording each request. */
function throwing(Client: typeof EsploraClient, error: unknown): { client: EsploraClient; calls: string[] } {
  const calls: string[] = []
  const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push(`${init?.method ?? 'GET'} ${String(input).slice(BASE.length)}`)
    throw error
  }) as typeof fetch
  return { client: new Client({ baseUrl: BASE, fetchFn, retries: RETRIES, sleepFn: async () => {} }), calls }
}

async function settle(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => {
      throw new Error('expected a rejection')
    },
    (error: unknown) => error
  )
}

const CONNECT_REFUSED = { code: 'ECONNREFUSED', syscall: 'connect', message: 'connect ECONNREFUSED' }
/** Happy eyeballs: one address refused, the other reset after the request was written. */
const REFUSED_THEN_RESET = {
  errors: [CONNECT_REFUSED, { code: 'ECONNRESET', syscall: 'read', message: 'read ECONNRESET' }],
}

describe('a QbitApiError from another copy, thrown by a custom fetchFn, on a read', () => {
  it.each<[QbitApiErrorKind, QbitApiErrorOptions]>([
    ['rate_limit', { status: 429, retryAfterMs: 1500 }],
    ['not_found', { status: 404 }],
    ['http', { status: 503 }],
    ['payload_too_large', { status: 413 }],
    ['parse', {}],
    ['aborted', {}],
  ])('passes %s through as it is, without a retry', async (kind, options) => {
    const Other = await otherCopyClass()
    const thrown = new Other(kind, `from a fetch wrapper: ${kind}`, options)
    const { client, calls } = throwing(EsploraClient, thrown)

    const error = await settle(client.getTx(LEGACY_TXID))

    expect(error).toBe(thrown)
    expect(error).toMatchObject({ kind, ...options })
    expect(calls).toEqual([`GET /tx/${LEGACY_TXID}`])
  })

  it.each<QbitApiErrorKind>(['network', 'timeout'])(
    'retries %s as for this copy, then passes it through',
    async kind => {
      for (const [, ErrorCopy] of await copies()) {
        const thrown = new ErrorCopy(kind, `from a fetch wrapper: ${kind}`)
        const { client, calls } = throwing(EsploraClient, thrown)

        expect(await settle(client.getTxStatus(LEGACY_TXID))).toBe(thrown)
        expect(calls).toHaveLength(RETRIES + 1)
      }
    }
  )

  it('passes a brand-carrying object through with its kind', async () => {
    const thrown = { [BRAND]: true, name: 'QbitApiError', kind: 'rate_limit', message: 'slow down', retryAfterMs: 10 }
    const { client, calls } = throwing(MempoolQbitClient, thrown)

    expect(await settle(client.getTipHeight())).toBe(thrown)
    expect(calls).toHaveLength(1)
  })
})

describe.each([
  ['EsploraClient', EsploraClient],
  ['MempoolQbitClient', MempoolQbitClient],
] as const)('%s.broadcastTx: a QbitApiError from another copy, thrown by a custom fetchFn', (_name, Client) => {
  it('never treats its network error as proof that nothing was sent', async () => {
    const Other = await otherCopyClass()
    const thrown = new Other('network', 'connect ECONNREFUSED', {
      cause: CONNECT_REFUSED,
      unredactedCause: CONNECT_REFUSED,
    })
    const { client, calls } = throwing(Client, thrown)

    const error = await settle(client.broadcastTx(LEGACY_TX_HEX))

    expect(error).toBeInstanceOf(QbitApiError)
    expect(error).toMatchObject({ kind: 'unknown_outcome', txid: LEGACY_TXID, cause: thrown })
    expect(calls).toEqual(['POST /tx'])
  })

  it('is no less safe than this copy when the public cause dropped the failure that proves the POST was sent', async () => {
    // The public `cause` of a client-made error is a redacted, depth-limited
    // copy; only the creating copy can read the original behind it.
    const outcomes = []
    for (const [, ErrorCopy] of await copies()) {
      const thrown = new ErrorCopy('network', 'fetch failed', {
        cause: CONNECT_REFUSED,
        unredactedCause: REFUSED_THEN_RESET,
      })
      const { client, calls } = throwing(Client, thrown)
      const error = await settle(client.broadcastTx(LEGACY_TX_HEX))
      outcomes.push({ kind: (error as QbitApiError).kind, cause: (error as QbitApiError).cause === thrown, calls })
    }

    expect(outcomes).toEqual([
      { kind: 'unknown_outcome', cause: true, calls: ['POST /tx'] },
      { kind: 'unknown_outcome', cause: true, calls: ['POST /tx'] },
    ])
  })

  it.each<[QbitApiErrorKind, QbitApiErrorOptions, string | undefined]>([
    ['timeout', {}, 'unknown_outcome'],
    ['aborted', {}, 'unknown_outcome'],
    ['unknown_outcome', { txid: LEGACY_TXID }, undefined],
    ['rate_limit', { status: 429, retryAfterMs: 1500 }, undefined],
    ['http', { status: 500 }, undefined],
  ])('handles %s exactly as one from this copy', async (kind, options, wrappedAs) => {
    const outcomes = []
    for (const [, ErrorCopy] of await copies()) {
      const thrown = new ErrorCopy(kind, `from a fetch wrapper: ${kind}`, options)
      const { client, calls } = throwing(Client, thrown)
      const error = await settle(client.broadcastTx(LEGACY_TX_HEX))
      if (wrappedAs === undefined) {
        expect(error).toBe(thrown)
      } else {
        expect(error).toMatchObject({ kind: wrappedAs, txid: LEGACY_TXID, cause: thrown })
      }
      outcomes.push({ kind: (error as QbitApiError).kind, calls })
    }

    expect(outcomes[1]).toEqual(outcomes[0])
    expect(outcomes[0]!.calls).toEqual(['POST /tx'])
  })

  it.each([
    ['without a message', { [BRAND]: true, kind: 'network', cause: CONNECT_REFUSED }],
    [
      'with pre-connection codes',
      { [BRAND]: true, kind: 'network', message: 'connect ECONNREFUSED', cause: CONNECT_REFUSED },
    ],
  ])('turns a brand-carrying network object %s into unknown_outcome without a re-send', async (_label, thrown) => {
    const { client, calls } = throwing(Client, thrown)

    const error = await settle(client.broadcastTx(LEGACY_TX_HEX))

    expect(error).toBeInstanceOf(QbitApiError)
    expect(error).toMatchObject({ kind: 'unknown_outcome', txid: LEGACY_TXID, cause: thrown })
    expect(calls).toEqual(['POST /tx'])
  })
})

describe('MempoolQbitClient /tx/push fallback on a QbitApiError from another copy', () => {
  it('falls back on a missing /tx route exactly as for this copy', async () => {
    for (const [, ErrorCopy] of await copies()) {
      const thrown = new ErrorCopy('not_found', 'HTTP 404', { status: 404 })
      const { client, calls } = throwing(MempoolQbitClient, thrown)

      expect(await settle(client.broadcastTx(LEGACY_TX_HEX))).toBe(thrown)
      expect(calls).toEqual(['POST /tx', 'POST /tx/push'])
    }
  })

  it("never falls back on another copy's response body", async () => {
    // Its raw body is private to that copy, and `responseBody` may be the
    // redacted preview, which can differ from the reply in the words this reads.
    const options = { status: 400, responseBody: 'Failed to send transaction' }
    const results = []
    for (const [label, ErrorCopy] of await copies()) {
      const thrown = new ErrorCopy('http', 'HTTP 400: Failed to send transaction', options)
      const { client, calls } = throwing(MempoolQbitClient, thrown)
      expect(await settle(client.broadcastTx(LEGACY_TX_HEX))).toBe(thrown)
      results.push([label, calls])
    }

    expect(results).toEqual([
      ['this copy', ['POST /tx', 'POST /tx/push']],
      ['another copy', ['POST /tx']],
    ])
  })
})

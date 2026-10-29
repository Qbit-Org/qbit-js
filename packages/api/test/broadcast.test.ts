import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'

import { describe, expect, it, vi } from 'vitest'

import { EsploraClient, MempoolQbitClient, QbitApiError, txidFromRawTx } from '../src/index'

interface MockReply {
  status?: number
  body?: BodyInit
  headers?: Record<string, string>
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
    return new Response(reply.body ?? '', { status: reply.status ?? 200, headers: reply.headers })
  }) as typeof fetch
  return { fetchFn, calls }
}

const BASE = 'https://esplora.example/regtest/api'
/** BASE as errors show it: the origin, with the base path redacted. */
const SAFE_BASE = 'https://esplora.example/...'
const noSleep = () => Promise.resolve()

// The genesis coinbase transaction (legacy encoding) and its well-known txid.
const LEGACY_TX_HEX =
  '01000000010000000000000000000000000000000000000000000000000000000000000000ffffffff4d04ffff001d0104455468652054696d65732030332f4a616e2f32303039204368616e63656c6c6f72206f6e206272696e6b206f66207365636f6e64206261696c6f757420666f722062616e6b73ffffffff0100f2052a01000000434104678afdb0fe5548271967f1a67130b7105cd6a828e03909a67962e0ea1f61deb649f6bc3f4cef38c4f35504e51ec112de5c384df7ba0b8d578a4c702b6bf11d5fac00000000'
const TXID = '4a5e1e4baab89f3a32518a88c31bc87f618f76673e2cc77ab2127b7afdeda33b'
// The same transaction in BIP144 encoding: marker, flag, and a one-item witness stack.
const WITNESS_TX_HEX = `${LEGACY_TX_HEX.slice(0, 8)}0001${LEGACY_TX_HEX.slice(8, -8)}0101ab${LEGACY_TX_HEX.slice(-8)}`
const OTHER_TXID = 'ab'.repeat(32)

const ALREADY_IN_CHAIN = 'sendrawtransaction RPC error: {"code":-27,"message":"Transaction already in block chain"}'
const GENERIC_BACKEND_FAILURE = 'Failed to send raw transaction'
/** mempool-qbit relays its own RPC transport failure as `{"code":"<node error code>"}` (backend/src/rpc-api/jsonrpc.ts, bitcoin.routes.ts). */
const RELAYED_RPC_TIMEOUT = 'sendrawtransaction RPC error: {"code":"ETIMEDOUT"}'
/** A node message the English phrase matcher does not recognise, so only the code can classify the reply. */
const LOCALIZED_MESSAGE = 'Transaktion bereits in der Blockkette'
type RpcErrorShape = (code: number | string, message: string) => string
const RPC_ERROR_TEXT: RpcErrorShape = (code, message) =>
  `sendrawtransaction RPC error: ${JSON.stringify({ code, message })}`
/** Every body shape a backend or gateway uses to relay a coded node error. */
const RPC_ERROR_SHAPES: [string, RpcErrorShape][] = [
  ['esplora plain text', RPC_ERROR_TEXT],
  ['flat JSON object', (code, message) => JSON.stringify({ code, message })],
  ['JSON-RPC envelope', (code, message) => JSON.stringify({ result: null, error: { code, message }, id: 'qbit-js' })],
  ['nested error without a message', code => JSON.stringify({ error: { code } })],
  [
    'HTTP status beside the nested error',
    (code, message) => JSON.stringify({ code: 400, message: 'Bad Request', error: { code, message } }),
  ],
  ['JSON string around the plain text', (code, message) => JSON.stringify(RPC_ERROR_TEXT(code, message))],
  [
    'JSON error string around the plain text',
    (code, message) => JSON.stringify({ error: RPC_ERROR_TEXT(code, message) }),
  ],
  ['JSON message around the plain text', (code, message) => JSON.stringify({ message: RPC_ERROR_TEXT(code, message) })],
]
/** Codes that fail closed as `http`: the backend never connected, or the node rejected the transaction. */
const DEFINITE_REJECTION_CODES: (number | string)[] = ['ECONNREFUSED', -26]
const CODED_REJECTION_SHAPES = RPC_ERROR_SHAPES.flatMap(([shape, build]) =>
  DEFINITE_REJECTION_CODES.map(code => [shape, code, build] as [string, number | string, RpcErrorShape])
)

interface P2mrWitnessTxFixture {
  source: { fixture: string; repository: string; commit: string }
  unsignedTxHex: string
  rawTxHex: string
  txid: string
}

const P2MR_TX = JSON.parse(
  readFileSync(new URL('./fixtures/p2mr-witness-tx.json', import.meta.url), 'utf8')
) as P2mrWitnessTxFixture

function sha256d(bytes: Buffer): Buffer {
  return createHash('sha256').update(createHash('sha256').update(bytes).digest()).digest()
}

function abortError(): Error {
  const error = new Error('This operation was aborted')
  error.name = 'AbortError'
  return error
}

function withCode(message: string, code: string, syscall?: string): Error {
  return Object.assign(new Error(message), syscall === undefined ? { code } : { code, syscall })
}

function fetchFailed(cause: unknown): TypeError {
  return Object.assign(new TypeError('fetch failed'), { cause })
}

function unreadableBody(): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.error(new Error('connection reset while reading the body'))
    },
  })
}

async function rejection(promise: Promise<unknown>): Promise<QbitApiError> {
  try {
    await promise
  } catch (error) {
    expect(error).toBeInstanceOf(QbitApiError)
    return error as QbitApiError
  }
  throw new Error('expected the promise to reject')
}

describe('txidFromRawTx', () => {
  it('hashes the legacy encoding', () => {
    expect(
      Buffer.from(sha256d(Buffer.from(LEGACY_TX_HEX, 'hex')))
        .reverse()
        .toString('hex')
    ).toBe(TXID)
    expect(txidFromRawTx(LEGACY_TX_HEX)).toBe(TXID)
    expect(txidFromRawTx(LEGACY_TX_HEX.toUpperCase())).toBe(TXID)
  })

  it('strips the witness from a BIP144 encoding', () => {
    expect(txidFromRawTx(WITNESS_TX_HEX)).toBe(TXID)
  })

  it('strips a real qbit P2MR witness with a 3.7 KB PQC signature stack', () => {
    // Two-input P2MR transaction from the qbit Core test framework
    // (packages/protocol/fixtures/p2mr-psbt.json, Qbit-Org/qbit @ 7ebcddb6);
    // see test/fixtures/p2mr-witness-tx.json for the derivation.
    expect(P2MR_TX.source.repository).toBe('Qbit-Org/qbit')
    expect(P2MR_TX.source.commit).toBe('7ebcddb622d6e639041f005a189b048ec2a221fe')
    expect(P2MR_TX.txid).toBe('49d7493c4a5c9690713879e066f0a41ce1523b64870dfdcebed40c6ca09f5c84')
    expect(P2MR_TX.rawTxHex.slice(8, 12)).toBe('0001')
    expect(P2MR_TX.rawTxHex.length).toBeGreaterThan(P2MR_TX.unsignedTxHex.length + 7000)
    expect(
      Buffer.from(sha256d(Buffer.from(P2MR_TX.unsignedTxHex, 'hex')))
        .reverse()
        .toString('hex')
    ).toBe(P2MR_TX.txid)

    expect(txidFromRawTx(P2MR_TX.rawTxHex)).toBe(P2MR_TX.txid)
    expect(txidFromRawTx(P2MR_TX.unsignedTxHex)).toBe(P2MR_TX.txid)
    expect(() => txidFromRawTx(P2MR_TX.rawTxHex.slice(0, -2))).toThrow(/well-formed/)
  })

  it.each([
    ['truncated', LEGACY_TX_HEX.slice(0, -2)],
    ['trailing bytes', `${LEGACY_TX_HEX}00`],
    ['truncated witness', WITNESS_TX_HEX.slice(0, -10)],
    ['unknown flag', `${LEGACY_TX_HEX.slice(0, 8)}0002${LEGACY_TX_HEX.slice(8)}`],
    ['odd length', LEGACY_TX_HEX.slice(0, -1)],
    ['not hex', `zz${LEGACY_TX_HEX.slice(2)}`],
    ['empty', ''],
  ])('rejects a %s transaction', (_case, hex) => {
    expect(() => txidFromRawTx(hex)).toThrow(QbitApiError)
    expect(() => txidFromRawTx(hex)).toThrow(/well-formed/)
  })
})

describe('EsploraClient.broadcastTx submission policy', () => {
  it('sends exactly one POST and reports an unknown outcome when the gateway times out after the node accepted', async () => {
    const sleep = vi.fn(noSleep)
    const { fetchFn, calls } = makeFetch(i =>
      i === 0 ? { status: 504, body: 'upstream request timeout' } : { status: 400, body: ALREADY_IN_CHAIN }
    )
    const client = new EsploraClient({ baseUrl: BASE, fetchFn, retries: 2, sleepFn: sleep })

    const error = await rejection(client.broadcastTx(LEGACY_TX_HEX))
    expect(error).toMatchObject({
      kind: 'unknown_outcome',
      status: 504,
      txid: TXID,
      responseBody: 'upstream request timeout',
      url: `${SAFE_BASE}/tx`,
    })
    expect(error.message).toContain(TXID)
    expect(calls).toHaveLength(1)
    expect(calls[0]!.init?.method).toBe('POST')
    expect(sleep).not.toHaveBeenCalled()
  })

  it.each([500, 502, 503, 599])('does not resend after a %i reply', async status => {
    const { fetchFn, calls } = makeFetch(() => ({ status, body: 'server error' }))
    const client = new EsploraClient({ baseUrl: BASE, fetchFn, retries: 2, sleepFn: noSleep })

    await expect(client.broadcastTx(LEGACY_TX_HEX)).rejects.toMatchObject({
      kind: 'unknown_outcome',
      status,
      txid: TXID,
    })
    expect(calls).toHaveLength(1)
  })

  it.each([501, 505])('fails closed on a %i reply that the server never processed', async status => {
    const { fetchFn, calls } = makeFetch(() => ({ status, body: 'nope' }))
    const client = new EsploraClient({ baseUrl: BASE, fetchFn, retries: 2, sleepFn: noSleep })

    await expect(client.broadcastTx(LEGACY_TX_HEX)).rejects.toMatchObject({ kind: 'http', status })
    expect(calls).toHaveLength(1)
  })

  it('does not resend after a request timeout', async () => {
    let n = 0
    const client = new EsploraClient({
      baseUrl: BASE,
      retries: 2,
      sleepFn: noSleep,
      fetchFn: (async () => {
        n += 1
        throw abortError()
      }) as typeof fetch,
    })

    const error = await rejection(client.broadcastTx(LEGACY_TX_HEX))
    expect(error).toMatchObject({ kind: 'unknown_outcome', txid: TXID })
    expect(error.cause).toMatchObject({ kind: 'timeout' })
    expect(n).toBe(1)
  })

  it.each([
    ['browser-style failure without a cause', new TypeError('Failed to fetch')],
    ['connection reset', fetchFailed(withCode('read ECONNRESET', 'ECONNRESET'))],
    ['socket closed mid-response', fetchFailed(withCode('other side closed', 'UND_ERR_SOCKET'))],
    [
      'mixed connect and reset errors',
      fetchFailed(
        Object.assign(new AggregateError([withCode('x', 'ECONNREFUSED'), withCode('y', 'ECONNRESET')]), {
          code: 'ECONNREFUSED',
        })
      ),
    ],
    ['host unreachable without a connect syscall', fetchFailed(withCode('EHOSTUNREACH', 'EHOSTUNREACH'))],
    ['host unreachable while writing', fetchFailed(withCode('write EHOSTUNREACH', 'EHOSTUNREACH', 'write'))],
    ['network unreachable while reading', fetchFailed(withCode('read ENETUNREACH', 'ENETUNREACH', 'read'))],
    [
      'aggregate whose members lost the route after connecting',
      fetchFailed(
        Object.assign(
          new AggregateError([withCode('x', 'EHOSTUNREACH', 'connect'), withCode('y', 'EHOSTUNREACH', 'write')]),
          { code: 'EHOSTUNREACH' }
        )
      ),
    ],
  ])('does not resend after an ambiguous network error (%s)', async (_case, failure) => {
    let n = 0
    const client = new EsploraClient({
      baseUrl: BASE,
      retries: 2,
      sleepFn: noSleep,
      fetchFn: (async () => {
        n += 1
        throw failure
      }) as typeof fetch,
    })

    const error = await rejection(client.broadcastTx(LEGACY_TX_HEX))
    expect(error).toMatchObject({ kind: 'unknown_outcome', txid: TXID })
    expect(error.cause).toMatchObject({ kind: 'network' })
    expect(n).toBe(1)
  })

  it.each([
    ['connection refused', fetchFailed(withCode('connect ECONNREFUSED 127.0.0.1:3000', 'ECONNREFUSED'))],
    ['DNS failure', fetchFailed(withCode('getaddrinfo ENOTFOUND esplora.example', 'ENOTFOUND'))],
    ['connect timeout', fetchFailed(withCode('Connect Timeout Error', 'UND_ERR_CONNECT_TIMEOUT'))],
    [
      'happy-eyeballs aggregate of refused connections',
      fetchFailed(
        Object.assign(new AggregateError([withCode('x', 'ECONNREFUSED'), withCode('y', 'ECONNREFUSED')]), {
          code: 'ECONNREFUSED',
        })
      ),
    ],
    [
      'host unreachable at connect',
      fetchFailed(withCode('connect EHOSTUNREACH 10.0.0.1:443', 'EHOSTUNREACH', 'connect')),
    ],
    [
      'network unreachable at connect',
      fetchFailed(withCode('connect ENETUNREACH 10.0.0.1:443', 'ENETUNREACH', 'connect')),
    ],
    [
      'happy-eyeballs aggregate of unreachable connects',
      fetchFailed(
        Object.assign(
          new AggregateError([withCode('x', 'EHOSTUNREACH', 'connect'), withCode('y', 'ENETUNREACH', 'connect')]),
          { code: 'EHOSTUNREACH' }
        )
      ),
    ],
  ])('retries a %s because nothing was sent', async (_case, failure) => {
    const sleep = vi.fn(noSleep)
    let n = 0
    const client = new EsploraClient({
      baseUrl: BASE,
      retries: 2,
      sleepFn: sleep,
      fetchFn: (async () => {
        n += 1
        if (n === 1) throw failure
        return new Response(TXID, { status: 200 })
      }) as typeof fetch,
    })

    await expect(client.broadcastTx(LEGACY_TX_HEX)).resolves.toBe(TXID)
    expect(n).toBe(2)
    expect(sleep).toHaveBeenCalledTimes(1)
  })

  it('reports an exhausted pre-connection failure as a plain network error', async () => {
    let n = 0
    const client = new EsploraClient({
      baseUrl: BASE,
      retries: 1,
      sleepFn: noSleep,
      fetchFn: (async () => {
        n += 1
        throw fetchFailed(withCode('connect ECONNREFUSED', 'ECONNREFUSED'))
      }) as typeof fetch,
    })

    const error = await rejection(client.broadcastTx(LEGACY_TX_HEX))
    expect(error.kind).toBe('network')
    expect(error.txid).toBeUndefined()
    expect(n).toBe(2)
  })

  it('retries 429 honoring Retry-After because the server did not process the submission', async () => {
    const sleep = vi.fn(noSleep)
    const { fetchFn, calls } = makeFetch(i =>
      i === 0 ? { status: 429, body: 'slow down', headers: { 'retry-after': '2' } } : { body: TXID }
    )
    const client = new EsploraClient({ baseUrl: BASE, fetchFn, retries: 1, sleepFn: sleep })

    await expect(client.broadcastTx(LEGACY_TX_HEX)).resolves.toBe(TXID)
    expect(calls).toHaveLength(2)
    expect(sleep).toHaveBeenCalledWith(2000, expect.any(AbortSignal))
  })

  it.each([
    ['EsploraClient', EsploraClient],
    ['MempoolQbitClient', MempoolQbitClient],
  ] as const)(
    'rejects at once as rate_limit when a 429 asks to wait past maxRetryAfterMs (%s)',
    async (_name, Client) => {
      const sleep = vi.fn(noSleep)
      const { fetchFn, calls } = makeFetch(() => ({
        status: 429,
        body: 'slow down',
        headers: { 'retry-after': '3600' },
      }))
      const client = new Client({ baseUrl: BASE, fetchFn, retries: 2, sleepFn: sleep })

      await expect(client.broadcastTx(LEGACY_TX_HEX)).rejects.toMatchObject({
        kind: 'rate_limit',
        status: 429,
        retryAfterMs: 3_600_000,
      })
      expect(calls).toHaveLength(1)
      expect(sleep).not.toHaveBeenCalled()
    }
  )

  it.each([
    ['plain text', 'slow down'],
    ['gateway JSON code', JSON.stringify({ code: 'RATE_LIMITED', message: 'slow down' })],
  ])('surfaces an exhausted 429 as rate_limit rather than an unknown outcome (%s)', async (_case, body) => {
    const { fetchFn, calls } = makeFetch(() => ({ status: 429, body }))
    const client = new EsploraClient({ baseUrl: BASE, fetchFn, retries: 0, sleepFn: noSleep })

    await expect(client.broadcastTx(LEGACY_TX_HEX)).rejects.toMatchObject({ kind: 'rate_limit', status: 429 })
    expect(calls).toHaveLength(1)
  })

  it('stops at the first uncertain attempt after a safe retry', async () => {
    const { fetchFn, calls } = makeFetch(i =>
      i === 0 ? { status: 429, body: 'slow down' } : { status: 504, body: 'gateway timeout' }
    )
    const client = new EsploraClient({ baseUrl: BASE, fetchFn, retries: 5, sleepFn: noSleep })

    await expect(client.broadcastTx(LEGACY_TX_HEX)).rejects.toMatchObject({
      kind: 'unknown_outcome',
      status: 504,
      txid: TXID,
    })
    expect(calls).toHaveLength(2)
  })

  it.each([
    ['esplora already in block chain', ALREADY_IN_CHAIN],
    [
      'esplora outputs already in utxo set',
      'sendrawtransaction RPC error: {"code":-27,"message":"Transaction outputs already in utxo set"}',
    ],
    ['esplora already in mempool', 'sendrawtransaction RPC error: {"code":-26,"message":"txn-already-in-mempool"}'],
    ['bare txn-already-known', 'txn-already-known'],
    ['bare txn-already-in-mempool', 'txn-already-in-mempool'],
    ['same txid with a different witness', 'txn-same-nonwitness-data-in-mempool'],
    ['structured error string', JSON.stringify({ error: 'Transaction already in block chain' })],
    ['structured error object', JSON.stringify({ error: { message: 'txn-already-in-mempool' } })],
    ['structured message', JSON.stringify({ message: 'Transaction already in blockchain.' })],
    ['RPC code only', 'sendrawtransaction RPC error: {"code":-27,"message":"localized text"}'],
    [
      'JSON-RPC envelope with -26 and an already-known message',
      JSON.stringify({ error: { code: -26, message: 'txn-already-in-mempool' } }),
    ],
  ])('resolves with the txid when the node already has the transaction (%s)', async (_case, body) => {
    const { fetchFn, calls } = makeFetch(() => ({ status: 400, body }))
    const client = new EsploraClient({ baseUrl: BASE, fetchFn, retries: 2, sleepFn: noSleep })

    await expect(client.broadcastTx(LEGACY_TX_HEX)).resolves.toBe(TXID)
    expect(calls).toHaveLength(1)
  })

  it.each([
    [
      'missing or spent inputs',
      'sendrawtransaction RPC error: {"code":-26,"message":"bad-txns-inputs-missingorspent"}',
    ],
    ['mempool conflict', 'sendrawtransaction RPC error: {"code":-26,"message":"txn-mempool-conflict"}'],
    [
      'rejected replacement',
      'sendrawtransaction RPC error: {"code":-26,"message":"insufficient fee, rejecting replacement"}',
    ],
    ['missing inputs', 'sendrawtransaction RPC error: {"code":-25,"message":"Missing inputs"}'],
    ['decode failure', 'sendrawtransaction RPC error: {"code":-22,"message":"TX decode failed"}'],
    ['bare validity rejection', 'bad-txns-inputs-missingorspent'],
    ['generic backend failure', GENERIC_BACKEND_FAILURE],
  ])('fails closed on a coded rejection (%s)', async (_case, body) => {
    const { fetchFn, calls } = makeFetch(() => ({ status: 400, body }))
    const client = new EsploraClient({ baseUrl: BASE, fetchFn, retries: 2, sleepFn: noSleep })

    const error = await rejection(client.broadcastTx(LEGACY_TX_HEX))
    expect(error).toMatchObject({ kind: 'http', status: 400, responseBody: body })
    expect(error.txid).toBeUndefined()
    expect(calls).toHaveLength(1)
  })

  it.each([
    ['mempool-qbit request timeout', RELAYED_RPC_TIMEOUT],
    ['mempool-qbit socket timeout', 'sendrawtransaction RPC error: {"code":"ESOCKETTIMEDOUT"}'],
    ['mempool-qbit connection reset', 'sendrawtransaction RPC error: {"code":"ECONNRESET"}'],
    ['mempool-qbit broken pipe', 'sendrawtransaction RPC error: {"code":"EPIPE"}'],
    ['mempool-qbit unreadable node reply', 'sendrawtransaction RPC error: {"code":-32603}'],
    ['mempool-qbit unreadable non-200 node reply', 'sendrawtransaction RPC error: {"code":-32602}'],
    ['mempool-qbit JSON envelope', JSON.stringify({ error: RELAYED_RPC_TIMEOUT })],
    [
      'mempool-qbit node reply stream closed early',
      'sendrawtransaction RPC error: {"code":"ERR_STREAM_PREMATURE_CLOSE"}',
    ],
    ['mempool-qbit malformed node reply', 'sendrawtransaction RPC error: {"code":"HPE_INVALID_CONSTANT"}'],
    ['lower-case transport code in a JSON-RPC envelope', JSON.stringify({ error: { code: 'econnreset' } })],
    ['qbit-electrs daemon connection loss', 'Connection error'],
  ])('reports an unknown outcome when the backend relays its own transport failure (%s)', async (_case, body) => {
    const { fetchFn, calls } = makeFetch(() => ({ status: 400, body }))
    const client = new EsploraClient({ baseUrl: BASE, fetchFn, retries: 2, sleepFn: noSleep })

    const error = await rejection(client.broadcastTx(LEGACY_TX_HEX))
    expect(error).toMatchObject({ kind: 'unknown_outcome', status: 400, txid: TXID, responseBody: body })
    expect(calls).toHaveLength(1)
  })

  it.each([
    ['connection refused', 'sendrawtransaction RPC error: {"code":"ECONNREFUSED"}'],
    ['DNS failure', 'sendrawtransaction RPC error: {"code":"ENOTFOUND"}'],
    ['DNS retry', 'sendrawtransaction RPC error: {"code":"EAI_AGAIN"}'],
    ['gateway application code', JSON.stringify({ code: 'BAD_REQUEST', message: 'invalid transaction hex' })],
    [
      'gateway HTTP status echo',
      JSON.stringify({ code: 400, error: { code: 'INVALID_ARGUMENT', message: 'invalid transaction hex' } }),
    ],
  ])('fails closed when the backend never reached the node (%s)', async (_case, body) => {
    const { fetchFn, calls } = makeFetch(() => ({ status: 400, body }))
    const client = new EsploraClient({ baseUrl: BASE, fetchFn, retries: 2, sleepFn: noSleep })

    const error = await rejection(client.broadcastTx(LEGACY_TX_HEX))
    expect(error).toMatchObject({ kind: 'http', status: 400, responseBody: body })
    expect(error.txid).toBeUndefined()
    expect(calls).toHaveLength(1)
  })

  it.each(RPC_ERROR_SHAPES)('resolves on RPC error -27 whatever the message says (%s)', async (_shape, build) => {
    const body = build(-27, LOCALIZED_MESSAGE)
    const { fetchFn, calls } = makeFetch(() => ({ status: 400, body }))
    const client = new EsploraClient({ baseUrl: BASE, fetchFn, retries: 2, sleepFn: noSleep })

    await expect(client.broadcastTx(LEGACY_TX_HEX)).resolves.toBe(TXID)
    expect(calls).toHaveLength(1)
  })

  it.each(RPC_ERROR_SHAPES)('reports an unknown outcome on a relayed ETIMEDOUT (%s)', async (_shape, build) => {
    const body = build('ETIMEDOUT', LOCALIZED_MESSAGE)
    const { fetchFn, calls } = makeFetch(() => ({ status: 400, body }))
    const client = new EsploraClient({ baseUrl: BASE, fetchFn, retries: 2, sleepFn: noSleep })

    const error = await rejection(client.broadcastTx(LEGACY_TX_HEX))
    expect(error).toMatchObject({ kind: 'unknown_outcome', status: 400, txid: TXID, responseBody: body })
    expect(calls).toHaveLength(1)
  })

  it.each(CODED_REJECTION_SHAPES)('fails closed on a %s reply with code %s', async (_shape, code, build) => {
    const body = build(code, LOCALIZED_MESSAGE)
    const { fetchFn, calls } = makeFetch(() => ({ status: 400, body }))
    const client = new EsploraClient({ baseUrl: BASE, fetchFn, retries: 2, sleepFn: noSleep })

    const error = await rejection(client.broadcastTx(LEGACY_TX_HEX))
    expect(error).toMatchObject({ kind: 'http', status: 400, responseBody: body })
    expect(error.txid).toBeUndefined()
    expect(calls).toHaveLength(1)
  })

  it.each([
    ['empty body', ''],
    ['HTML page', '<!doctype html><title>Login</title>'],
    ['a different txid', OTHER_TXID],
    ['JSON-wrapped txid', JSON.stringify(TXID)],
  ])('reports an unknown outcome when a 2xx reply does not echo the txid (%s)', async (_case, body) => {
    const { fetchFn, calls } = makeFetch(() => ({ status: 200, body }))
    const client = new EsploraClient({ baseUrl: BASE, fetchFn, retries: 2, sleepFn: noSleep })

    const error = await rejection(client.broadcastTx(WITNESS_TX_HEX))
    expect(error).toMatchObject({ kind: 'unknown_outcome', status: 200, txid: TXID })
    expect(error.responseBody).toBe(body.slice(0, 200))
    expect(calls).toHaveLength(1)
  })

  it('accepts a 2xx reply that echoes the txid in any case or with surrounding whitespace', async () => {
    const { fetchFn } = makeFetch(() => ({ status: 200, body: `  ${TXID.toUpperCase()}\n` }))
    const client = new EsploraClient({ baseUrl: BASE, fetchFn, sleepFn: noSleep })

    await expect(client.broadcastTx(LEGACY_TX_HEX)).resolves.toBe(TXID)
  })

  it('returns a bare txid from a 2xx reply, lowercased and trimmed, when no txid is available to check it against', async () => {
    const { fetchFn, calls } = makeFetch(() => ({ status: 200, body: `  ${OTHER_TXID.toUpperCase()}\n` }))
    const client = new EsploraClient({ baseUrl: BASE, fetchFn, sleepFn: noSleep })

    await expect(client.broadcastTx('0200000000ffff')).resolves.toBe(OTHER_TXID)
    expect(calls).toHaveLength(1)
  })

  it.each([
    ['empty body', ''],
    ['HTML page', '<!doctype html><title>Login</title>'],
    ['non-hex text', 'broadcasttxid'],
    ['63-character hex', OTHER_TXID.slice(1)],
    ['65-character hex', `${OTHER_TXID}a`],
    ['JSON-wrapped txid', JSON.stringify(OTHER_TXID)],
  ])(
    'reports an unknown outcome when a 2xx reply is not a txid and none is available to check it against (%s)',
    async (_case, body) => {
      const { fetchFn, calls } = makeFetch(() => ({ status: 200, body }))
      const client = new EsploraClient({ baseUrl: BASE, fetchFn, retries: 2, sleepFn: noSleep })

      const error = await rejection(client.broadcastTx('0200000000ffff'))
      expect(error).toMatchObject({ kind: 'unknown_outcome', status: 200 })
      expect(error.txid).toBeUndefined()
      expect(error.responseBody).toBe(body.slice(0, 200))
      expect(calls).toHaveLength(1)
    }
  )

  it.each([
    ['success reply without a derivable txid', 200, '00', undefined],
    ['success reply', 200, LEGACY_TX_HEX, TXID],
    ['rejection reply', 400, LEGACY_TX_HEX, TXID],
  ])('reports an unknown outcome when a %s cannot be read', async (_case, status, hex, txid) => {
    const { fetchFn } = makeFetch(() => ({ status, body: unreadableBody() }))
    const client = new EsploraClient({ baseUrl: BASE, fetchFn, sleepFn: noSleep })

    const error = await rejection(client.broadcastTx(hex))
    expect(error).toMatchObject({ kind: 'unknown_outcome', status })
    expect(error.txid).toBe(txid)
  })

  it('carries the caller-supplied txid when the hex cannot be parsed', async () => {
    const { fetchFn, calls } = makeFetch(i =>
      i === 0 ? { status: 502, body: 'bad gateway' } : { status: 400, body: 'txn-already-known' }
    )
    const client = new EsploraClient({ baseUrl: BASE, fetchFn, retries: 2, sleepFn: noSleep })

    await expect(client.broadcastTx('0200000000ffff', { txid: OTHER_TXID.toUpperCase() })).rejects.toMatchObject({
      kind: 'unknown_outcome',
      status: 502,
      txid: OTHER_TXID,
    })
    expect(calls).toHaveLength(1)
    expect(calls[0]!.init?.body).toBe('0200000000ffff')

    await expect(client.broadcastTx('0200000000ffff', { txid: OTHER_TXID })).resolves.toBe(OTHER_TXID)
  })

  it('reports an already-known reply as an unknown outcome when no txid is available', async () => {
    const { fetchFn } = makeFetch(() => ({ status: 400, body: 'txn-already-in-mempool' }))
    const client = new EsploraClient({ baseUrl: BASE, fetchFn, sleepFn: noSleep })

    const error = await rejection(client.broadcastTx('0200000000ffff'))
    expect(error).toMatchObject({ kind: 'unknown_outcome', status: 400 })
    expect(error.txid).toBeUndefined()
  })

  it.each([
    ['mismatched', OTHER_TXID, /options\.txid .* does not match the transaction hex/],
    ['too short', TXID.slice(0, 63), /options\.txid must be a 64-character hex/],
    ['non-hex', `g${TXID.slice(1)}`, /options\.txid must be a 64-character hex/],
    ['non-string', 123 as unknown as string, /options\.txid must be a 64-character hex/],
  ])('rejects a %s txid option with a TypeError before sending anything', async (_case, txid, message) => {
    const { fetchFn, calls } = makeFetch(() => ({ body: TXID }))
    const client = new EsploraClient({ baseUrl: BASE, fetchFn, sleepFn: noSleep })

    const promise = client.broadcastTx(LEGACY_TX_HEX, { txid })
    await expect(promise).rejects.toThrow(TypeError)
    await expect(promise).rejects.toThrow(message)
    expect(calls).toHaveLength(0)
  })

  it.each([
    ['null', null],
    ['undefined', undefined],
  ])('treats %s options like no options', async (_case, options) => {
    const { fetchFn } = makeFetch(() => ({ body: TXID }))
    const client = new EsploraClient({ baseUrl: BASE, fetchFn, sleepFn: noSleep })

    await expect(client.broadcastTx(LEGACY_TX_HEX, options as undefined)).resolves.toBe(TXID)
  })

  it('rejects a non-string rawTxHex with a TypeError before sending anything', async () => {
    const { fetchFn, calls } = makeFetch(() => ({ body: TXID }))
    const client = new EsploraClient({ baseUrl: BASE, fetchFn, sleepFn: noSleep })

    await expect(client.broadcastTx(undefined as unknown as string)).rejects.toThrow(TypeError)
    await expect(client.broadcastTx(Buffer.from(LEGACY_TX_HEX, 'hex') as unknown as string)).rejects.toThrow(
      /rawTxHex must be a hex string/
    )
    expect(calls).toHaveLength(0)
  })

  it('accepts a matching txid option in either case', async () => {
    const { fetchFn } = makeFetch(() => ({ body: TXID }))
    const client = new EsploraClient({ baseUrl: BASE, fetchFn, sleepFn: noSleep })

    await expect(client.broadcastTx(LEGACY_TX_HEX, { txid: TXID.toUpperCase() })).resolves.toBe(TXID)
  })

  it('keeps retrying transient failures for reads', async () => {
    const { fetchFn, calls } = makeFetch(i => (i < 2 ? { status: 504, body: 'busy' } : { body: '10' }))
    const client = new EsploraClient({ baseUrl: BASE, fetchFn, retries: 2, sleepFn: noSleep })

    await expect(client.getTipHeight()).resolves.toBe(10)
    expect(calls).toHaveLength(3)
  })

  it('applies the submission policy to any non-idempotent request', async () => {
    class PostingClient extends EsploraClient {
      post(): Promise<Response> {
        return this.request('/custom', { method: 'POST', body: 'x', dedup: false })
      }
    }
    let n = 0
    const client = new PostingClient({
      baseUrl: BASE,
      retries: 2,
      sleepFn: noSleep,
      fetchFn: (async () => {
        n += 1
        throw abortError()
      }) as typeof fetch,
    })

    const error = await rejection(client.post())
    expect(error.kind).toBe('unknown_outcome')
    expect(error.txid).toBeUndefined()
    expect(n).toBe(1)
  })
})

describe('MempoolQbitClient.broadcastTx submission policy', () => {
  it('does not fall back to /tx/push after an uncertain /tx attempt', async () => {
    const { fetchFn, calls } = makeFetch(() => ({ status: 504, body: 'gateway timeout' }))
    const client = new MempoolQbitClient({ baseUrl: BASE, fetchFn, retries: 2, sleepFn: noSleep })

    await expect(client.broadcastTx(LEGACY_TX_HEX)).rejects.toMatchObject({
      kind: 'unknown_outcome',
      status: 504,
      txid: TXID,
    })
    expect(calls).toHaveLength(1)
    expect(calls[0]!.url).toBe(`${BASE}/tx`)
  })

  it('does not fall back to /tx/push after a /tx timeout', async () => {
    let n = 0
    const client = new MempoolQbitClient({
      baseUrl: BASE,
      retries: 2,
      sleepFn: noSleep,
      fetchFn: (async () => {
        n += 1
        throw abortError()
      }) as typeof fetch,
    })

    await expect(client.broadcastTx(LEGACY_TX_HEX)).rejects.toMatchObject({ kind: 'unknown_outcome', txid: TXID })
    expect(n).toBe(1)
  })

  it('treats an already-known reply from /tx/push as success', async () => {
    const { fetchFn, calls } = makeFetch(i =>
      i === 0 ? { status: 400, body: GENERIC_BACKEND_FAILURE } : { status: 400, body: 'txn-already-in-mempool' }
    )
    const client = new MempoolQbitClient({ baseUrl: BASE, fetchFn, retries: 2, sleepFn: noSleep })

    await expect(client.broadcastTx(WITNESS_TX_HEX)).resolves.toBe(TXID)
    expect(calls.map(call => call.url)).toEqual([`${BASE}/tx`, `${BASE}/tx/push`])
    expect(calls[1]!.init?.body).toBe(`txHash=${WITNESS_TX_HEX}`)
  })

  it.each([
    ['504 reply', () => ({ status: 504, body: 'gateway timeout' }), 504],
    [
      'timeout',
      () => {
        throw abortError()
      },
      undefined,
    ],
  ])('reports an unknown outcome with the txid when /tx/push hits a %s', async (_case, pushReply, status) => {
    const { fetchFn, calls } = makeFetch(i => (i === 0 ? { status: 404, body: 'not found' } : pushReply()))
    const client = new MempoolQbitClient({ baseUrl: BASE, fetchFn, retries: 2, sleepFn: noSleep })

    const error = await rejection(client.broadcastTx(LEGACY_TX_HEX))
    expect(error).toMatchObject({ kind: 'unknown_outcome', txid: TXID, url: `${SAFE_BASE}/tx/push` })
    expect(error.status).toBe(status)
    expect(calls).toHaveLength(2)
  })

  it('does not fall back to /tx/push when /tx relays a node transport failure', async () => {
    const { fetchFn, calls } = makeFetch(() => ({ status: 400, body: RELAYED_RPC_TIMEOUT }))
    const client = new MempoolQbitClient({ baseUrl: BASE, fetchFn, retries: 2, sleepFn: noSleep })

    await expect(client.broadcastTx(LEGACY_TX_HEX)).rejects.toMatchObject({
      kind: 'unknown_outcome',
      status: 400,
      txid: TXID,
      responseBody: RELAYED_RPC_TIMEOUT,
    })
    expect(calls).toHaveLength(1)
  })

  it('reports an unknown outcome when /tx/push relays a node transport failure', async () => {
    const { fetchFn, calls } = makeFetch(i =>
      i === 0
        ? { status: 400, body: GENERIC_BACKEND_FAILURE }
        : { status: 400, body: JSON.stringify({ error: RELAYED_RPC_TIMEOUT }) }
    )
    const client = new MempoolQbitClient({ baseUrl: BASE, fetchFn, retries: 2, sleepFn: noSleep })

    await expect(client.broadcastTx(P2MR_TX.rawTxHex)).rejects.toMatchObject({
      kind: 'unknown_outcome',
      status: 400,
      txid: P2MR_TX.txid,
      url: `${SAFE_BASE}/tx/push`,
    })
    expect(calls).toHaveLength(2)
  })

  it('fails closed without falling back when /tx reports the node refused the connection', async () => {
    const body = 'sendrawtransaction RPC error: {"code":"ECONNREFUSED"}'
    const { fetchFn, calls } = makeFetch(() => ({ status: 400, body }))
    const client = new MempoolQbitClient({ baseUrl: BASE, fetchFn, retries: 2, sleepFn: noSleep })

    await expect(client.broadcastTx(LEGACY_TX_HEX)).rejects.toMatchObject({
      kind: 'http',
      status: 400,
      responseBody: body,
    })
    expect(calls).toHaveLength(1)
  })

  it('retries 429 on /tx/push and then succeeds', async () => {
    const { fetchFn, calls } = makeFetch(i => {
      if (i === 0) return { status: 405, body: 'method not allowed' }
      if (i === 1) return { status: 429, body: 'slow down' }
      return { body: TXID }
    })
    const client = new MempoolQbitClient({ baseUrl: BASE, fetchFn, retries: 1, sleepFn: noSleep })

    await expect(client.broadcastTx(LEGACY_TX_HEX)).resolves.toBe(TXID)
    expect(calls.map(call => call.url)).toEqual([`${BASE}/tx`, `${BASE}/tx/push`, `${BASE}/tx/push`])
  })

  it('reports an unknown outcome when /tx/push answers a 2xx that is not a txid and none is available', async () => {
    const { fetchFn, calls } = makeFetch(i =>
      i === 0 ? { status: 404, body: 'Not Found' } : { status: 200, body: '<!doctype html><title>Login</title>' }
    )
    const client = new MempoolQbitClient({ baseUrl: BASE, fetchFn, retries: 2, sleepFn: noSleep })

    const error = await rejection(client.broadcastTx('0200000000ffff'))
    expect(error).toMatchObject({ kind: 'unknown_outcome', status: 200 })
    expect(error.txid).toBeUndefined()
    expect(calls).toHaveLength(2)
    expect(calls[1]!.url).toBe(`${BASE}/tx/push`)
  })

  it('still fails closed when /tx/push rejects the transaction', async () => {
    const body = 'sendrawtransaction RPC error: {"code":-26,"message":"bad-txns-inputs-missingorspent"}'
    const { fetchFn, calls } = makeFetch(i =>
      i === 0 ? { status: 400, body: GENERIC_BACKEND_FAILURE } : { status: 400, body }
    )
    const client = new MempoolQbitClient({ baseUrl: BASE, fetchFn, retries: 2, sleepFn: noSleep })

    await expect(client.broadcastTx(LEGACY_TX_HEX)).rejects.toMatchObject({
      kind: 'http',
      status: 400,
      responseBody: body,
    })
    expect(calls).toHaveLength(2)
  })

  it.each(RPC_ERROR_SHAPES)(
    'does not fall back after a structured relayed ETIMEDOUT from /tx (%s)',
    async (_shape, build) => {
      const body = build('ETIMEDOUT', LOCALIZED_MESSAGE)
      const { fetchFn, calls } = makeFetch(() => ({ status: 400, body }))
      const client = new MempoolQbitClient({ baseUrl: BASE, fetchFn, retries: 2, sleepFn: noSleep })

      await expect(client.broadcastTx(LEGACY_TX_HEX)).rejects.toMatchObject({
        kind: 'unknown_outcome',
        status: 400,
        txid: TXID,
      })
      expect(calls.map(call => call.url)).toEqual([`${BASE}/tx`])
    }
  )

  it.each(CODED_REJECTION_SHAPES)(
    'fails closed without falling back on a %s /tx reply with code %s',
    async (_shape, code, build) => {
      const body = build(code, LOCALIZED_MESSAGE)
      const { fetchFn, calls } = makeFetch(() => ({ status: 400, body }))
      const client = new MempoolQbitClient({ baseUrl: BASE, fetchFn, retries: 2, sleepFn: noSleep })

      await expect(client.broadcastTx(LEGACY_TX_HEX)).rejects.toMatchObject({
        kind: 'http',
        status: 400,
        responseBody: body,
      })
      expect(calls.map(call => call.url)).toEqual([`${BASE}/tx`])
    }
  )

  it.each(RPC_ERROR_SHAPES)('resolves a structured -27 from /tx/push (%s)', async (_shape, build) => {
    const body = build(-27, LOCALIZED_MESSAGE)
    const { fetchFn, calls } = makeFetch(i =>
      i === 0 ? { status: 400, body: GENERIC_BACKEND_FAILURE } : { status: 400, body }
    )
    const client = new MempoolQbitClient({ baseUrl: BASE, fetchFn, retries: 2, sleepFn: noSleep })

    await expect(client.broadcastTx(LEGACY_TX_HEX)).resolves.toBe(TXID)
    expect(calls.map(call => call.url)).toEqual([`${BASE}/tx`, `${BASE}/tx/push`])
  })

  it.each([
    ['RPC code', JSON.stringify({ error: { code: -26, message: GENERIC_BACKEND_FAILURE } })],
    ['transport code', JSON.stringify({ code: 'ECONNREFUSED', message: GENERIC_BACKEND_FAILURE })],
  ])('does not fall back when a node-coded rejection carries the generic failure text (%s)', async (_case, body) => {
    const { fetchFn, calls } = makeFetch(() => ({ status: 400, body }))
    const client = new MempoolQbitClient({ baseUrl: BASE, fetchFn, retries: 2, sleepFn: noSleep })

    await expect(client.broadcastTx(LEGACY_TX_HEX)).rejects.toMatchObject({
      kind: 'http',
      status: 400,
      responseBody: body,
    })
    expect(calls.map(call => call.url)).toEqual([`${BASE}/tx`])
  })

  it.each([
    ['HTTP status echo', 400, JSON.stringify({ code: 400, message: GENERIC_BACKEND_FAILURE })],
    ['gateway application code', 400, JSON.stringify({ code: 'BROADCAST_FAILED', message: GENERIC_BACKEND_FAILURE })],
    ['gateway 404 code', 404, JSON.stringify({ code: 'NOT_FOUND', message: 'no such route' })],
  ])(
    'still falls back to /tx/push when only a gateway code accompanies a no-submit reply (%s)',
    async (_case, status, body) => {
      const { fetchFn, calls } = makeFetch(i => (i === 0 ? { status, body } : { status: 200, body: TXID }))
      const client = new MempoolQbitClient({ baseUrl: BASE, fetchFn, retries: 2, sleepFn: noSleep })

      await expect(client.broadcastTx(LEGACY_TX_HEX)).resolves.toBe(TXID)
      expect(calls.map(call => call.url)).toEqual([`${BASE}/tx`, `${BASE}/tx/push`])
    }
  )
})

// ---------------------------------------------------------------------------
// 5xx replies carrying the node's own verdict
//
// qbit Core's JSON-RPC server answers HTTP 500 for every RPC error except
// -32600 (400) and -32601 (404) (src/httprpc.cpp, JSONErrorReply), so a proxy
// or backend that relays the envelope with its status delivers an authoritative
// -27 / -26 / -25 / -22 as a 5xx. qbit-electrs (src/rest.rs) and mempool-qbit
// (backend/src/api/bitcoin/bitcoin.routes.ts) rewrite it to 400, but a gateway
// in front of either may answer 502/503/504 with the same body.
// ---------------------------------------------------------------------------

/** 5xx statuses the server may have processed (501/505/511 are never processed). */
const PROCESSED_SERVER_ERROR_STATUSES = [500, 502, 503, 504]
const JSON_RPC_ENVELOPE: RpcErrorShape = (code, message) =>
  JSON.stringify({ result: null, error: { code, message }, id: 'qbit-js' })
const SCRIPT_FAILURE_REASON =
  'mempool-script-verify-flag-failed (Signature must be zero for failed CHECK(MULTI)SIG operation)'
/** An nginx-style gateway page that contains reject-reason words off the start of the text. */
const GATEWAY_HTML =
  '<html><head><title>502 Bad Gateway</title></head><body><center>nginx version 1.24 dust</center></body></html>'

type ServerErrorOutcome = 'accepted' | 'rejected' | 'unknown'
/** Every body a 5xx may carry, with the outcome the node's verdict (or its absence) dictates. */
const SERVER_ERROR_BODIES: [string, string, ServerErrorOutcome][] = [
  ['JSON-RPC envelope -27', JSON_RPC_ENVELOPE(-27, 'Transaction outputs already in utxo set'), 'accepted'],
  ['esplora text -27 with a localised message', RPC_ERROR_TEXT(-27, LOCALIZED_MESSAGE), 'accepted'],
  ['mempool-qbit code-only -27', 'sendrawtransaction RPC error: {"code":-27}', 'accepted'],
  ['bare txn-already-in-mempool', 'txn-already-in-mempool', 'accepted'],
  ['JSON-RPC envelope -26 with an already-known reason', JSON_RPC_ENVELOPE(-26, 'txn-already-known'), 'accepted'],
  ['JSON-RPC envelope -26', JSON_RPC_ENVELOPE(-26, 'bad-txns-inputs-missingorspent'), 'rejected'],
  ['esplora text -26 with a localised message', RPC_ERROR_TEXT(-26, LOCALIZED_MESSAGE), 'rejected'],
  ['mempool-qbit code-only -26', 'sendrawtransaction RPC error: {"code":-26}', 'rejected'],
  ['JSON-RPC envelope -25', JSON_RPC_ENVELOPE(-25, 'Missing inputs'), 'rejected'],
  [
    'JSON-RPC envelope -22',
    JSON_RPC_ENVELOPE(-22, 'TX decode failed. Make sure the tx has at least one input.'),
    'rejected',
  ],
  ['JSON-RPC envelope -28 warming up', JSON_RPC_ENVELOPE(-28, 'Loading block index...'), 'rejected'],
  ['JSON-RPC envelope -8 parameter error', JSON_RPC_ENVELOPE(-8, 'Invalid amount'), 'rejected'],
  ['JSON-RPC envelope -32700 unparsed request', JSON_RPC_ENVELOPE(-32700, 'Parse error'), 'rejected'],
  ['mempool-qbit -32602 unreadable non-200 node reply', 'sendrawtransaction RPC error: {"code":-32602}', 'unknown'],
  ['relayed connection refused', 'sendrawtransaction RPC error: {"code":"ECONNREFUSED"}', 'rejected'],
  ['bare reject reason', 'bad-txns-inputs-missingorspent', 'rejected'],
  ['bare conflict reason', 'txn-mempool-conflict', 'rejected'],
  ['bare script failure with detail', SCRIPT_FAILURE_REASON, 'rejected'],
  ['bare fee reason with detail', 'min relay fee not met, 0 < 141', 'rejected'],
  ['JSON error string with a reject reason', JSON.stringify({ error: 'tx-output-not-p2mr' }), 'rejected'],
  ['JSON-RPC envelope -32603', JSON_RPC_ENVELOPE(-32603, 'Internal error'), 'unknown'],
  ['mempool-qbit unreadable node reply', 'sendrawtransaction RPC error: {"code":-32603}', 'unknown'],
  ['relayed ETIMEDOUT', RELAYED_RPC_TIMEOUT, 'unknown'],
  ['relayed ETIMEDOUT in a JSON envelope', JSON.stringify({ error: RELAYED_RPC_TIMEOUT }), 'unknown'],
  ['relayed ECONNRESET', 'sendrawtransaction RPC error: {"code":"ECONNRESET"}', 'unknown'],
  ['qbit-electrs daemon connection loss', 'Connection error', 'unknown'],
  ['reserved server-error code', JSON_RPC_ENVELOPE(-32000, 'upstream request timed out'), 'unknown'],
  ['negative code outside the node range', JSON.stringify({ code: -500, message: 'Internal Server Error' }), 'unknown'],
  ['positive status echo', JSON.stringify({ code: 503, message: 'Service Unavailable' }), 'unknown'],
  ['gateway application code', JSON.stringify({ code: 'UPSTREAM_TIMEOUT', message: 'Gateway Timeout' }), 'unknown'],
  ['no code', 'server error', 'unknown'],
  ['empty body', '', 'unknown'],
  ['HTML gateway page', GATEWAY_HTML, 'unknown'],
  ['generic backend failure', GENERIC_BACKEND_FAILURE, 'unknown'],
  ['reject-reason words off the start', 'The transaction was dust and non-final', 'unknown'],
]

function serverErrorCases(outcome: ServerErrorOutcome): [number, string, string][] {
  return PROCESSED_SERVER_ERROR_STATUSES.flatMap(status =>
    SERVER_ERROR_BODIES.filter(([, , o]) => o === outcome).map(
      ([name, body]) => [status, name, body] as [number, string, string]
    )
  )
}

interface SubmissionPath {
  name: string
  make: (fetchFn: typeof fetch) => EsploraClient
  /** Replies before the one under test: `/tx` must decline before `/tx/push` is tried. */
  prelude: MockReply[]
  urls: string[]
}
const SUBMISSION_PATHS: SubmissionPath[] = [
  {
    name: 'EsploraClient /tx',
    make: fetchFn => new EsploraClient({ baseUrl: BASE, fetchFn, retries: 2, sleepFn: noSleep }),
    prelude: [],
    urls: [`${BASE}/tx`],
  },
  {
    name: 'MempoolQbitClient /tx',
    make: fetchFn => new MempoolQbitClient({ baseUrl: BASE, fetchFn, retries: 2, sleepFn: noSleep }),
    prelude: [],
    urls: [`${BASE}/tx`],
  },
  {
    name: 'MempoolQbitClient /tx/push',
    make: fetchFn => new MempoolQbitClient({ baseUrl: BASE, fetchFn, retries: 2, sleepFn: noSleep }),
    prelude: [{ status: 404, body: 'Not Found' }],
    urls: [`${BASE}/tx`, `${BASE}/tx/push`],
  },
]

for (const { name, make, prelude, urls } of SUBMISSION_PATHS) {
  describe(`${name} on a 5xx reply`, () => {
    function submit(status: number, body: BodyInit, rawTxHex = LEGACY_TX_HEX) {
      const { fetchFn, calls } = makeFetch(i => prelude[i] ?? { status, body })
      return { calls, result: make(fetchFn).broadcastTx(rawTxHex) }
    }

    it.each(serverErrorCases('accepted'))(
      'resolves with the txid on HTTP %i carrying %s',
      async (status, _case, body) => {
        const { calls, result } = submit(status, body)
        await expect(result).resolves.toBe(TXID)
        expect(calls.map(call => call.url)).toEqual(urls)
      }
    )

    it.each(serverErrorCases('rejected'))('fails closed on HTTP %i carrying %s', async (status, _case, body) => {
      const { calls, result } = submit(status, body)
      const error = await rejection(result)
      expect(error).toMatchObject({ kind: 'http', status, responseBody: body.slice(0, 200) })
      expect(error.txid).toBeUndefined()
      expect(calls.map(call => call.url)).toEqual(urls)
    })

    it.each(serverErrorCases('unknown'))(
      'reports an unknown outcome on HTTP %i carrying %s',
      async (status, _case, body) => {
        const { calls, result } = submit(status, body)
        const error = await rejection(result)
        expect(error).toMatchObject({
          kind: 'unknown_outcome',
          status,
          txid: TXID,
          responseBody: body.slice(0, 200),
          url: urls.at(-1)!.replace(BASE, SAFE_BASE),
        })
        expect(error.message).toContain(TXID)
        expect(calls.map(call => call.url)).toEqual(urls)
      }
    )

    it('reports an already-known 5xx reply as an unknown outcome when no txid is available', async () => {
      const { calls, result } = submit(
        500,
        JSON_RPC_ENVELOPE(-27, 'Transaction outputs already in utxo set'),
        '0200000000ffff'
      )
      const error = await rejection(result)
      expect(error).toMatchObject({ kind: 'unknown_outcome', status: 500, url: urls.at(-1)!.replace(BASE, SAFE_BASE) })
      expect(error.txid).toBeUndefined()
      expect(error.message).toContain('already knows')
      expect(calls.map(call => call.url)).toEqual(urls)
    })

    it('reports an unknown outcome when a 5xx body cannot be read', async () => {
      const { calls, result } = submit(500, unreadableBody())
      const error = await rejection(result)
      expect(error).toMatchObject({
        kind: 'unknown_outcome',
        status: 500,
        txid: TXID,
        url: urls.at(-1)!.replace(BASE, SAFE_BASE),
      })
      expect(calls.map(call => call.url)).toEqual(urls)
    })

    it.each(RPC_ERROR_SHAPES)(
      'classifies a 500 by its structured code before its status (%s)',
      async (_shape, build) => {
        await expect(submit(500, build(-27, LOCALIZED_MESSAGE)).result).resolves.toBe(TXID)
        await expect(submit(500, build(-26, LOCALIZED_MESSAGE)).result).rejects.toMatchObject({
          kind: 'http',
          status: 500,
        })
        await expect(submit(500, build('ETIMEDOUT', LOCALIZED_MESSAGE)).result).rejects.toMatchObject({
          kind: 'unknown_outcome',
          status: 500,
          txid: TXID,
        })
      }
    )
  })
}

describe('5xx replies the server never processed', () => {
  it.each([501, 505, 511])('keeps a %i reply an http error even when its body carries a node code', async status => {
    const body = JSON_RPC_ENVELOPE(-26, 'bad-txns-inputs-missingorspent')
    const { fetchFn, calls } = makeFetch(() => ({ status, body }))
    const client = new EsploraClient({ baseUrl: BASE, fetchFn, retries: 2, sleepFn: noSleep })

    await expect(client.broadcastTx(LEGACY_TX_HEX)).rejects.toMatchObject({ kind: 'http', status, responseBody: body })
    expect(calls).toHaveLength(1)
  })

  it('still falls back to /tx/push after a 501 whose body carries a node code', async () => {
    const { fetchFn, calls } = makeFetch(i =>
      i === 0
        ? { status: 501, body: JSON_RPC_ENVELOPE(-26, 'bad-txns-inputs-missingorspent') }
        : { status: 200, body: TXID }
    )
    const client = new MempoolQbitClient({ baseUrl: BASE, fetchFn, retries: 2, sleepFn: noSleep })

    await expect(client.broadcastTx(LEGACY_TX_HEX)).resolves.toBe(TXID)
    expect(calls.map(call => call.url)).toEqual([`${BASE}/tx`, `${BASE}/tx/push`])
  })

  it('does not fall back to /tx/push after a definite 5xx rejection from /tx', async () => {
    const body = JSON_RPC_ENVELOPE(-26, 'bad-txns-inputs-missingorspent')
    const { fetchFn, calls } = makeFetch(() => ({ status: 500, body }))
    const client = new MempoolQbitClient({ baseUrl: BASE, fetchFn, retries: 2, sleepFn: noSleep })

    await expect(client.broadcastTx(LEGACY_TX_HEX)).rejects.toMatchObject({
      kind: 'http',
      status: 500,
      responseBody: body,
    })
    expect(calls.map(call => call.url)).toEqual([`${BASE}/tx`])
  })
})

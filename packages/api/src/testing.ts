/**
 * An offline mock of the qbit-electrs (esplora) and mempool-qbit backends, for
 * the unit tests of code that uses `EsploraClient` or `MempoolQbitClient`. It
 * is for tests only: never use it, or this entry point, in production code.
 *
 * Start with {@link createMockEsplora}; the
 * [Testing](https://github.com/Qbit-Org/qbit-js/blob/main/packages/api/docs/testing.md)
 * page walks through it.
 *
 * @packageDocumentation
 */

// @qbit-oss/api/testing. Only types may be imported from ./index: the build
// bundles each entry point on its own (tsup `splitting: false`), so a runtime
// import would ship a second copy of the client and of QbitApiError in
// lib/testing.*. The mock talks to a client only through `fetchFn`, whose
// contract is structural, so a mock from one version works with a client from
// another.

import { sha256 } from '@noble/hashes/sha2'

import type {
  EsploraAddressStats,
  EsploraChainStats,
  EsploraFeeEstimates,
  EsploraTx,
  EsploraTxStatus,
  EsploraUtxo,
  EsploraVin,
  EsploraVout,
  MempoolRecommendedFees,
} from './index'

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * The backend a mock answers as. They differ where the real ones do:
 *
 * - `esplora` is qbit-electrs. It answers `GET /tx/:txid/status` for a txid it
 *   has never seen with `200 {"confirmed":false}`, the same reply as for a
 *   transaction in its mempool, and answers a combined-history cursor it finds
 *   nowhere with `422`. It does not serve `GET /fees/recommended` or
 *   `POST /tx/push` (`404`).
 * - `mempool-qbit` is the mempool-qbit hosts (`mempool.qbit.org`). They answer
 *   an unknown txid's status with `404`, and a lost combined-history cursor
 *   with `500`. They do not serve `GET /address/:address/txs/chain`,
 *   `GET /address/:address/txs/mempool` or `GET /fee-estimates` (`404`).
 */
export type MockBackend = 'esplora' | 'mempool-qbit'

/**
 * A route the clients call, as `METHOD /path`, naming where a
 * {@link MockFault} applies. `GET /address/:address/txs/chain` covers the
 * route with and without its `/:after_txid` cursor, and
 * `GET /address/:address/txs` the combined route with and without its
 * `?after_txid=` query.
 */
export type MockRoute =
  | 'GET /address/:address'
  | 'GET /address/:address/utxo'
  | 'GET /address/:address/txs'
  | 'GET /address/:address/txs/chain'
  | 'GET /address/:address/txs/mempool'
  | 'GET /tx/:txid'
  | 'GET /tx/:txid/hex'
  | 'GET /tx/:txid/status'
  | 'GET /fee-estimates'
  | 'GET /fees/recommended'
  | 'GET /blocks/tip/height'
  | 'GET /blocks/tip/hash'
  | 'POST /tx'
  | 'POST /tx/push'

/** An output of a {@link MockTx}. */
export interface MockOutput {
  /** The address the output pays to. Without one, the output counts for no address. */
  address?: string
  /** Value in satoshis, a non-negative safe integer. */
  value: number
  /**
   * The output's scriptPubKey as hex, reported as `scriptpubkey` (default
   * empty). The mock does not derive it from the address.
   */
  scriptPubKey?: string
}

/** An input of a {@link MockTx}: the output it spends. */
export interface MockInput {
  /** Id of the transaction whose output the input spends. */
  txid: string
  /** Index of that output. */
  vout: number
  /**
   * The spent output's address, for an output outside the fixture. An
   * output in the fixture brings its own; if given, it must match.
   */
  address?: string
  /**
   * The spent output's value in satoshis, required for an output outside the
   * fixture. An output in the fixture brings its own; if given, it must match.
   */
  value?: number
}

/** The block that holds a confirmed {@link MockTx}. */
export interface MockBlock {
  /** Block height, a non-negative safe integer. */
  height: number
  /**
   * Block hash as 64 hex characters (default: the height in hex, zero-padded).
   * Fixture transactions at one height must agree on it.
   */
  hash?: string
  /**
   * Block time in Unix seconds (default `1700000000 + 600 * height`).
   * Fixture transactions at one height must agree on it.
   */
  time?: number
}

/**
 * A transaction in the fixture. The mock derives every address view from the
 * fixture's transactions and the submissions the node took: the address
 * stats, unspent outputs and history.
 */
export interface MockTx {
  /** Transaction id, 64 hex characters. Required unless `hex` is given. */
  txid?: string
  /**
   * The raw transaction as hex. It is what `GET /tx/:txid/hex` serves, and its
   * txid is derived from it; a `txid` given too must match. The mock does not
   * check it against `vin` and `vout`. Without it, `GET /tx/:txid/hex`
   * answers `501`, and the transaction's `size` and `weight` are 0.
   */
  hex?: string
  /**
   * Inputs (default none). An input spends an output of a transaction listed
   * before this one, or one outside the fixture. No output is spent twice,
   * and none that is unspendable (an `OP_RETURN` scriptPubKey, or one over
   * 10,000 bytes).
   */
  vin?: MockInput[]
  /**
   * Outputs, at least one. The outputs, and the outputs the inputs spend, are
   * each worth at most `MAX_MONEY`, 21,000,000,000,000,000 sats, in total.
   */
  vout: MockOutput[]
  /**
   * Fee in satoshis (default: inputs minus outputs, or 0 without inputs). It
   * must equal inputs minus outputs when there are inputs, and be 0 for a
   * coinbase.
   */
  fee?: number
  /** The block that holds it; omit it for a transaction in the mempool. */
  block?: MockBlock
  /**
   * Whether it is a block's coinbase transaction (default `false`). A
   * coinbase has a `block` and no `vin`, its `hex`, if given, is a coinbase
   * transaction, whose input the mock serves, and its outputs mature 1,000 blocks
   * after it: a transaction spends one only in a block at least 1,000 higher,
   * or in the mempool once the tip is at least 999 higher.
   */
  coinbase?: boolean
}

/** The chain tip a mock reports. */
export interface MockTip {
  /**
   * Tip height, a non-negative safe integer no lower than any fixture block
   * (default: the highest fixture block, or 0).
   */
  height: number
  /**
   * Tip hash as 64 hex characters (default: the hash of the fixture block at
   * the tip height, or the height in hex, zero-padded). With a fixture block
   * at the tip height, it must be that block's hash.
   */
  hash?: string
}

/**
 * A reply with an HTTP status in place of the route's own: a `429` with a
 * `Retry-After`, a `5xx`, a `404`, or any reply body a test needs. On a
 * broadcast route the node does not see the transaction.
 */
export interface MockStatusFault {
  /** The route it answers. */
  route: MockRoute
  /** Discriminant. */
  kind: 'status'
  /** HTTP status, an integer from 200 to 599. */
  status: number
  /**
   * `Retry-After` header: delta-seconds as a non-negative safe integer, or the
   * raw header value (an HTTP date, say): any string `Headers` accepts as a
   * header value, which it trims of leading and trailing whitespace.
   */
  retryAfter?: number | string
  /** Reply body (default empty; none for 204, 205 and 304). */
  body?: string
  /** How many matching requests it answers (default 1; `Infinity` for every one). */
  times?: number
}

/**
 * A connection refused before anything was sent: `fetchFn` rejects as undici
 * does, with a `TypeError` whose `cause` has the code `ECONNREFUSED` from the
 * `connect` syscall. Since nothing was sent, the client retries it, a
 * submission included, and fails with `network` once its retries run out.
 */
export interface MockNetworkErrorFault {
  /** The route it answers. */
  route: MockRoute
  /** Discriminant. */
  kind: 'network-error'
  /** How many matching requests it answers (default 1; `Infinity` for every one). */
  times?: number
}

/**
 * A reply whose headers arrive and whose body never ends, until the request's
 * signal aborts it. The client's `timeoutMs` or `deadlineMs` ends the wait. On
 * a broadcast route the node does not see the transaction, whatever the
 * status; use a `lost-reply` {@link MockBroadcastFault} for one it took.
 */
export interface MockStallFault {
  /** The route it answers. */
  route: MockRoute
  /** Discriminant. */
  kind: 'stall'
  /** HTTP status of the stalled reply, an integer from 200 to 599 other than 204, 205 and 304 (default 200). */
  status?: number
  /** `Retry-After` header, as for {@link MockStatusFault.retryAfter}. */
  retryAfter?: number | string
  /** How many matching requests it answers (default 1; `Infinity` for every one). */
  times?: number
}

/**
 * The node's verdict on one submission, on `POST /tx` or `POST /tx/push`, in
 * place of the one it reaches without a fault (see {@link createMockEsplora}):
 *
 * - `accepted`: the node takes the transaction into its mempool and the reply
 *   is its txid, whatever it would answer without the fault: even for a
 *   transaction it has in a block, one that spends outputs it does not have,
 *   or one that conflicts with a mempool transaction, which stays.
 * - `rejected`: the node refuses it with RPC error `code` and `message`,
 *   relayed as a `400` reply in qbit-electrs's and mempool-qbit's
 *   `sendrawtransaction RPC error: {...}` form. `-27` is the node's
 *   already-known reply, which the client resolves when it knows the txid.
 * - `lost-reply`: the node takes the transaction, as for `accepted`, then the
 *   connection resets before the reply arrives. `fetchFn` rejects with a
 *   `TypeError` whose `cause` has the code `ECONNRESET`, so the client rejects
 *   with `unknown_outcome`, and later lookups find the transaction.
 *
 * Hex the node cannot decode is never taken: `accepted` and `lost-reply` then
 * answer, or lose, RPC error `-22`.
 */
export interface MockBroadcastFault {
  /** The submission route it answers. */
  route: 'POST /tx' | 'POST /tx/push'
  /** Discriminant. */
  kind: 'broadcast'
  /** The node's verdict. */
  outcome: 'accepted' | 'rejected' | 'lost-reply'
  /** RPC error code for `rejected`, a negative integer such as `-26`; only for `rejected`. */
  code?: number
  /** RPC error message for `rejected` (default `'transaction rejected'`); only for `rejected`. */
  message?: string
  /** How many matching requests it answers (default 1; `Infinity` for every one). */
  times?: number
}

/**
 * A fault for a mock to inject on one route. Each request takes the first
 * fault left for its route, in the order given, and the route's own reply
 * returns once every fault for it is used up.
 */
export type MockFault = MockStatusFault | MockNetworkErrorFault | MockStallFault | MockBroadcastFault

/**
 * Options for {@link createMockEsplora}. Each value is checked: an invalid
 * one, `null` included, throws a `TypeError`. Only an option left out or
 * `undefined` takes its default.
 */
export interface MockEsploraOptions {
  /** The backend to answer as; see {@link MockBackend}. Required: the two differ. */
  backend: MockBackend
  /**
   * The base URL the client is given, an absolute `http(s)` URL without a
   * query or fragment; trailing slashes are dropped. Default
   * `https://esplora.example/api`, or `https://mempool.example/api/v1` for
   * `mempool-qbit`.
   */
  baseUrl?: string
  /** The transactions the node and its indexer have, confirmed or in the mempool. */
  txs?: MockTx[]
  /**
   * `GET /fee-estimates` reply: sat/vB by confirmation target, each key a
   * decimal block count and each rate a finite number above 0 (default
   * `{ "1": 20, "3": 10, "6": 5, "144": 1 }`).
   */
  feeEstimates?: EsploraFeeEstimates
  /**
   * `GET /fees/recommended` reply, each rate a finite number above 0 (default
   * 20, 15, 10, 5 and 1 sat/vB).
   */
  recommendedFees?: MempoolRecommendedFees
  /** The chain tip; see {@link MockTip}. */
  tip?: MockTip
  /** Faults to inject; see {@link MockFault}. */
  faults?: MockFault[]
}

/** One call to a mock's `fetchFn`. */
export interface MockRequest {
  /** The request method, upper-cased. */
  method: string
  /** The requested URL. */
  url: string
  /** The URL after the base URL, with any query, such as `/address/qb1.../txs?after_txid=...`. */
  path: string
  /** The request body, when it was a string. */
  body?: string
}

/** A mock backend, from {@link createMockEsplora}. */
export interface MockEsplora {
  /** Pass it to the client as `fetchFn`. It answers only URLs under {@link MockEsplora.baseUrl}. */
  readonly fetchFn: typeof fetch
  /** Every call to `fetchFn`, in order, including those a fault answered or that failed before anything was sent. */
  readonly requests: readonly MockRequest[]
  /** The base URL to give the client. */
  readonly baseUrl: string
  /**
   * Whether the node has a transaction, from the fixture or a submission it
   * took, confirmed or not.
   *
   * @param txid - The transaction id, 64 hex characters.
   */
  hasTx(txid: string): boolean
  /**
   * Mine a block on the tip: every mempool transaction, from the fixture or a
   * submission, confirms in it, and the tip moves to it.
   *
   * @returns The new block.
   */
  mine(): Required<MockBlock>
}

// ---------------------------------------------------------------------------
// createMockEsplora
// ---------------------------------------------------------------------------

/**
 * Create an offline mock of a qbit-electrs (esplora) or mempool-qbit backend,
 * to pass to `EsploraClient` or `MempoolQbitClient` as `fetchFn`. For tests
 * only, never production.
 *
 * It serves every route the two clients call, from one fixture and the
 * submissions the node takes, so the views agree: address stats, unspent
 * outputs and history pages are derived from them as qbit-electrs derives
 * them, as are `GET /tx/:txid`, its `/hex` and its `/status`.
 *
 * Without a fault, the node judges a submission as qbit Core v1.0.0's
 * `sendrawtransaction` does, from the outputs the fixture and the submissions
 * it took create and spend, and the first answer that applies, in Core's
 * order, is its reply: RPC error `-22` for hex it cannot decode; `-25` for an
 * unspendable output with a value (its `maxburnamount` check); `-27` for a
 * transaction in a block while one of its outputs is unspent; the txid for
 * one in its mempool; `-26` for one that breaks a `CheckTransaction` rule (no
 * inputs or no outputs, oversized, an output value or the output total out of
 * range, an output spent twice, a malformed coinbase input) and for a
 * coinbase; `-25 bad-txns-inputs-missingorspent` for one that spends an
 * output that is not a coin; `-26` for one that breaks a `CheckTxInputs` rule
 * (an immature coinbase output, input values out of range, outputs worth more
 * than its inputs); `-26 bad-txns-spends-conflicting-tx` for one that spends
 * an output of a mempool transaction it conflicts with;
 * `-26 insufficient fee` for any other conflict with a mempool transaction,
 * since the mock never replaces one; and `-25` for a fee above
 * `sendrawtransaction`'s default `maxfeerate`, 0.1 coin per kvB. It takes any
 * other transaction: the mock models no relay policy or standardness rule,
 * fee floor, script or signature, lock time or sequence lock, qbit's
 * P2MR-only output rule, mempool limit or replacement.
 *
 * A submission the node takes joins the mempool, the address views and those
 * lookups, and {@link MockEsplora.mine} confirms it. Faults replace a route's
 * reply; see {@link MockFault}.
 *
 * @remarks
 * See [Testing](https://github.com/Qbit-Org/qbit-js/blob/main/packages/api/docs/testing.md).
 *
 * @param options - The backend, its fixture and the faults to inject.
 * @returns The mock, with its `fetchFn` and the requests it received.
 * @throws TypeError when an option is missing, unknown or malformed (a txid,
 *   address or hex string, a negative or non-finite number, a `Retry-After`
 *   value `Headers` refuses, an unknown route or fault kind, `null`), or the
 *   fixture is inconsistent (a spend of a missing, already-spent or
 *   unspendable output, a confirmed spend of an unconfirmed output, a spend of
 *   an immature coinbase output, a coinbase with inputs, a fee or no block, or
 *   with hex that is not a coinbase's, a fee that does not balance, outputs or
 *   inputs worth more than `MAX_MONEY` in total, two hashes or times for one
 *   block height, a tip hash that is not the fixture block's at its height).
 *
 * @example
 * ```ts
 * import { EsploraClient, QbitApiError } from '@qbit-oss/api'
 * import { createMockEsplora } from '@qbit-oss/api/testing'
 *
 * const address = 'qbrt1zzasx2u2z7v9kn4q8e66r57mfw08xvrvdcqfcq6xfte0eau9dgdgqz42zd5'
 * const mock = createMockEsplora({
 *   backend: 'esplora',
 *   txs: [{ txid: 'a1'.repeat(32), vout: [{ address, value: 150_000 }], block: { height: 120 } }],
 *   faults: [{ route: 'POST /tx', kind: 'broadcast', outcome: 'lost-reply' }],
 * })
 * const client = new EsploraClient({ baseUrl: mock.baseUrl, fetchFn: mock.fetchFn })
 *
 * await client.getAddressBalance(address) // { address, confirmedSats: 150000, mempoolSats: 0, totalSats: 150000 }
 * try {
 *   await client.broadcastTx(signedTxHex)
 * } catch (error) {
 *   // The node took it, but the reply was lost: unknown_outcome, and getTx(error.txid) finds it.
 *   if (!QbitApiError.is(error) || error.kind !== 'unknown_outcome') throw error
 * }
 * ```
 */
export function createMockEsplora(options: MockEsploraOptions): MockEsplora {
  const state = createState(options)
  const requests: MockRequest[] = []
  const fetchFn = (async (input: unknown, init?: RequestInit) => {
    const url = requestUrl(input)
    const method = (init?.method ?? 'GET').toUpperCase()
    const body = typeof init?.body === 'string' ? init.body : undefined
    const path = url.startsWith(`${state.baseUrl}/`) ? url.slice(state.baseUrl.length) : undefined
    requests.push({ method, url, path: path ?? url, ...(body === undefined ? {} : { body }) })
    const signal = init?.signal ?? undefined
    // As fetch does, an aborted signal rejects before anything is sent.
    if (signal?.aborted) throw signal.reason
    if (path === undefined) {
      throw new TypeError(`createMockEsplora: ${url} is not under the mock's baseUrl ${state.baseUrl}`)
    }
    return answer(state, method, path, body, signal)
  }) as typeof fetch
  return {
    fetchFn,
    requests,
    baseUrl: state.baseUrl,
    hasTx: txid => state.txs.has(checkTxid(txid, 'hasTx: txid')),
    mine: () => mineBlock(state),
  }
}

// ---------------------------------------------------------------------------
// State and validation
// ---------------------------------------------------------------------------

/** A known transaction with its prevouts resolved. */
interface TxRecord {
  txid: string
  hex: string | undefined
  version: number
  locktime: number
  vin: InputRecord[]
  vout: OutputRecord[]
  fee: number
  size: number
  weight: number
  block: Required<MockBlock> | undefined
  /** A coinbase has no inputs in `vin`; its coinbase input is `coinbaseInput`. */
  coinbase: boolean
  coinbaseInput: { scriptsig: string; sequence: number } | undefined
}

interface InputRecord {
  txid: string
  vout: number
  /** The spent output, when known. */
  prevout: OutputRecord | undefined
  scriptsig: string
  witness: string[]
  sequence: number
}

interface OutputRecord {
  address: string | undefined
  /** Satoshis, exact: a submission's output can exceed `Number.MAX_SAFE_INTEGER`. */
  value: bigint
  scriptPubKey: string
}

interface PendingFault {
  fault: MockFault
  remaining: number
}

interface State {
  backend: MockBackend
  baseUrl: string
  /** Known transactions in arrival order: the fixture's, then submissions the node took. */
  txs: Map<string, TxRecord>
  feeEstimates: EsploraFeeEstimates
  recommendedFees: MempoolRecommendedFees
  tipHeight: number
  tipHash: string
  faults: PendingFault[]
}

const TXID_PATTERN = /^[0-9a-fA-F]{64}$/
const HEX_PATTERN = /^(?:[0-9a-fA-F]{2})*$/
/** Bech32 and base58 addresses are alphanumeric, and none is longer than 90 characters. */
const ADDRESS_PATTERN = /^[0-9A-Za-z]{1,90}$/
/** Rows per `/txs/chain` page (qbit-electrs `CHAIN_TXS_PER_PAGE`). */
const CHAIN_PAGE_SIZE = 25
/** Rows `/txs/mempool` lists, and rows per combined `/txs` page (`--rest-default-max-mempool-txs`). */
const MEMPOOL_PAGE_SIZE = 50
const MAX_UINT32 = 0xffff_ffff
// qbit Core's consensus constants (qbit 7ebcddb): COIN and MAX_MONEY,
// 210,000,000 coins (src/consensus/amount.h:15, :26), which is above
// Number.MAX_SAFE_INTEGER; MAX_BLOCK_WEIGHT, COINBASE_MATURITY and
// WITNESS_SCALE_FACTOR (src/consensus/consensus.h:15, :19, :22).
const COIN = 100_000_000n
const MAX_MONEY = 210_000_000n * COIN
const MAX_BLOCK_WEIGHT = 2_000_000
const COINBASE_MATURITY = 1_000
const WITNESS_SCALE_FACTOR = 1
/** `sendrawtransaction`'s default `maxfeerate`, 0.1 coin per kvB, per byte (src/node/transaction.h:27). */
const MAX_RAW_TX_FEE_PER_BYTE = COIN / 10n / 1_000n
/** A null prevout, which only a coinbase input has (src/primitives/transaction.h:34, :42). */
const NULL_TXID = '0'.repeat(64)
const NULL_INDEX = MAX_UINT32
const NULL_BODY_STATUSES = new Set([204, 205, 304])
const BACKENDS: readonly MockBackend[] = ['esplora', 'mempool-qbit']
const ROUTES: readonly MockRoute[] = [
  'GET /address/:address',
  'GET /address/:address/utxo',
  'GET /address/:address/txs',
  'GET /address/:address/txs/chain',
  'GET /address/:address/txs/mempool',
  'GET /tx/:txid',
  'GET /tx/:txid/hex',
  'GET /tx/:txid/status',
  'GET /fee-estimates',
  'GET /fees/recommended',
  'GET /blocks/tip/height',
  'GET /blocks/tip/hash',
  'POST /tx',
  'POST /tx/push',
]
/** Routes each backend answers with 404. */
const UNSERVED_ROUTES: Record<MockBackend, ReadonlySet<MockRoute>> = {
  esplora: new Set(['GET /fees/recommended', 'POST /tx/push']),
  'mempool-qbit': new Set([
    'GET /address/:address/txs/chain',
    'GET /address/:address/txs/mempool',
    'GET /fee-estimates',
  ]),
}
const DEFAULT_BASE_URLS: Record<MockBackend, string> = {
  esplora: 'https://esplora.example/api',
  'mempool-qbit': 'https://mempool.example/api/v1',
}
const DEFAULT_FEE_ESTIMATES: EsploraFeeEstimates = { '1': 20, '3': 10, '6': 5, '144': 1 }
const DEFAULT_RECOMMENDED_FEES: MempoolRecommendedFees = {
  fastestFee: 20,
  halfHourFee: 15,
  hourFee: 10,
  economyFee: 5,
  minimumFee: 1,
}
const RECOMMENDED_FEE_FIELDS = ['fastestFee', 'halfHourFee', 'hourFee', 'economyFee', 'minimumFee'] as const

function createState(options: MockEsploraOptions): State {
  const opts = record(options, 'options', [
    'backend',
    'baseUrl',
    'txs',
    'feeEstimates',
    'recommendedFees',
    'tip',
    'faults',
  ])
  const backend = opts['backend']
  if (!BACKENDS.includes(backend as MockBackend)) {
    throw new TypeError(`createMockEsplora: options.backend must be 'esplora' or 'mempool-qbit', not ${show(backend)}`)
  }
  // An option left undefined takes its default; any other value, null included, is checked.
  const given = (key: string, fallback: unknown): unknown => (opts[key] === undefined ? fallback : opts[key])
  const state: State = {
    backend: backend as MockBackend,
    baseUrl: checkBaseUrl(given('baseUrl', DEFAULT_BASE_URLS[backend as MockBackend])),
    txs: new Map(),
    feeEstimates: checkFeeEstimates(given('feeEstimates', DEFAULT_FEE_ESTIMATES)),
    recommendedFees: checkRecommendedFees(given('recommendedFees', DEFAULT_RECOMMENDED_FEES)),
    tipHeight: 0,
    tipHash: '',
    faults: list(opts['faults'], 'options.faults').map((fault, i) => checkFault(fault, `options.faults[${i}]`)),
  }
  const blocks = new Map<number, Required<MockBlock>>()
  list(opts['txs'], 'options.txs').forEach((tx, i) => addFixtureTx(state, tx, `options.txs[${i}]`, blocks))
  const highest = Math.max(0, ...[...state.txs.values()].map(tx => tx.block?.height ?? 0))
  const tip = opts['tip'] === undefined ? { height: highest } : record(opts['tip'], 'options.tip', ['height', 'hash'])
  const height = nonNegativeInteger(tip['height'], 'options.tip.height')
  if (height < highest) {
    throw new TypeError(`createMockEsplora: options.tip.height ${height} is below fixture block ${highest}`)
  }
  const tipBlock = blocks.get(height)
  state.tipHeight = height
  state.tipHash =
    tip['hash'] === undefined
      ? (tipBlock?.hash ?? defaultBlockHash(height))
      : checkTxid(tip['hash'], 'options.tip.hash')
  if (tipBlock !== undefined && tipBlock.hash !== state.tipHash) {
    throw new TypeError(
      `createMockEsplora: options.tip.hash ${state.tipHash} is not the hash of fixture block ${height} (${tipBlock.hash})`
    )
  }
  // The mempool holds a spend of a coinbase output only once the output is
  // mature in the next block (src/validation.cpp:939-940).
  for (const [i, tx] of [...state.txs.values()].entries()) {
    if (tx.block !== undefined) continue
    for (const [n, input] of tx.vin.entries()) {
      const depth = coinbaseDepth(state, input, height + 1)
      if (depth !== undefined && depth < COINBASE_MATURITY) {
        throw new TypeError(
          `createMockEsplora: options.txs[${i}].vin[${n}] spends coinbase output ${input.txid}:${input.vout} in the mempool at depth ${depth}, below ${COINBASE_MATURITY}`
        )
      }
    }
  }
  return state
}

/**
 * How deep a spend at `spendHeight` finds the coinbase output `input` spends,
 * as `CheckTxInputs` measures it (src/consensus/tx_verify.cpp:178-182), or
 * undefined when the output is not a known coinbase's.
 */
function coinbaseDepth(state: State, input: { txid: string }, spendHeight: number): number | undefined {
  const funding = state.txs.get(input.txid)
  return funding?.coinbase === true ? spendHeight - funding.block!.height : undefined
}

function addFixtureTx(state: State, value: unknown, where: string, blocks: Map<number, Required<MockBlock>>): void {
  const tx = record(value, where, ['txid', 'hex', 'vin', 'vout', 'fee', 'block', 'coinbase'])
  const coinbase = tx['coinbase'] === undefined ? false : tx['coinbase']
  if (typeof coinbase !== 'boolean') {
    throw new TypeError(`createMockEsplora: ${where}.coinbase must be a boolean, not ${show(coinbase)}`)
  }
  const hex = tx['hex'] === undefined ? undefined : hexString(tx['hex'], `${where}.hex`)
  const parsed = hex === undefined ? undefined : parseRawTx(hex)
  if (hex !== undefined && parsed === undefined) {
    throw new TypeError(`createMockEsplora: ${where}.hex is not a well-formed transaction`)
  }
  // Core's decoder takes one with no inputs, which CheckTransaction then refuses (src/consensus/tx_check.cpp:14-15).
  if (parsed !== undefined && parsed.vin.length === 0) {
    throw new TypeError(`createMockEsplora: ${where}.hex is a transaction with no inputs, which qbit Core never holds`)
  }
  let txid = parsed?.txid
  if (tx['txid'] !== undefined) {
    const given = checkTxid(tx['txid'], `${where}.txid`)
    if (txid !== undefined && given !== txid) {
      throw new TypeError(`createMockEsplora: ${where}.txid ${given} is not the txid of its hex (${txid})`)
    }
    txid = given
  }
  if (txid === undefined) throw new TypeError(`createMockEsplora: ${where} needs a txid or hex`)
  if (state.txs.has(txid)) throw new TypeError(`createMockEsplora: ${where} repeats transaction ${txid}`)
  for (const other of state.txs.values()) {
    if (other.vin.some(input => input.txid === txid)) {
      throw new TypeError(`createMockEsplora: ${where} must come before ${other.txid}, which spends its outputs`)
    }
  }

  const block = tx['block'] === undefined ? undefined : checkBlock(tx['block'], `${where}.block`)
  if (block !== undefined) {
    const known = blocks.get(block.height)
    if (known !== undefined && known.hash !== block.hash) {
      throw new TypeError(`createMockEsplora: ${where}.block gives height ${block.height} a second hash`)
    }
    if (known !== undefined && known.time !== block.time) {
      throw new TypeError(
        `createMockEsplora: ${where}.block gives height ${block.height} a second time (${block.time}, not ${known.time})`
      )
    }
    blocks.set(block.height, block)
  }
  const outputs = list(tx['vout'], `${where}.vout`)
  if (outputs.length === 0) throw new TypeError(`createMockEsplora: ${where}.vout needs at least one output`)
  const vout = outputs.map((output, i) => checkOutput(output, `${where}.vout[${i}]`))
  const vin = list(tx['vin'], `${where}.vin`).map((input, i) => checkInput(state, input, `${where}.vin[${i}]`, block))
  const outpoints = new Set(vin.map(input => `${input.txid}:${input.vout}`))
  if (outpoints.size !== vin.length) throw new TypeError(`createMockEsplora: ${where} spends one output twice`)
  if (coinbase && (block === undefined || vin.length > 0)) {
    throw new TypeError(`createMockEsplora: ${where} is a coinbase, so it needs a block and no vin`)
  }
  if (coinbase && parsed !== undefined && !isCoinbase(parsed)) {
    throw new TypeError(`createMockEsplora: ${where} is a coinbase, but its hex is not a coinbase transaction`)
  }

  // qbit Core refuses outputs or inputs worth more than MAX_MONEY in total
  // (src/consensus/tx_check.cpp:31-33, src/consensus/tx_verify.cpp:185-188).
  const outSum = vout.reduce((sum, output) => sum + output.value, 0n)
  const inSum = vin.reduce((sum, input) => sum + input.prevout!.value, 0n)
  if (outSum > MAX_MONEY || inSum > MAX_MONEY) {
    throw new TypeError(`createMockEsplora: ${where} moves more than MAX_MONEY (${MAX_MONEY} sats)`)
  }
  const balance = inSum - outSum
  if (vin.length > 0 && balance < 0n) {
    throw new TypeError(`createMockEsplora: ${where} pays out ${outSum} sats but spends only ${inSum}`)
  }
  let fee = vin.length > 0 ? Number(balance) : 0
  if (tx['fee'] !== undefined) {
    const given = nonNegativeInteger(tx['fee'], `${where}.fee`)
    if (vin.length > 0 && BigInt(given) !== balance) {
      throw new TypeError(`createMockEsplora: ${where}.fee ${given} is not inputs minus outputs (${balance})`)
    }
    // qbit-electrs reports a coinbase's fee as 0 (src/util/fees.rs:53-55).
    if (coinbase && given !== 0) throw new TypeError(`createMockEsplora: ${where} is a coinbase, so its fee is 0`)
    fee = given
  }
  state.txs.set(txid, {
    txid,
    hex: hex?.toLowerCase(),
    version: parsed?.version ?? 2,
    locktime: parsed?.locktime ?? 0,
    vin,
    vout,
    fee,
    size: parsed?.size ?? 0,
    weight: parsed?.weight ?? 0,
    block,
    coinbase,
    coinbaseInput: coinbase
      ? { scriptsig: parsed?.vin[0]?.scriptsig ?? '', sequence: parsed?.vin[0]?.sequence ?? MAX_UINT32 }
      : undefined,
  })
}

function checkOutput(value: unknown, where: string): OutputRecord {
  const output = record(value, where, ['address', 'value', 'scriptPubKey'])
  return {
    address: output['address'] === undefined ? undefined : checkAddress(output['address'], `${where}.address`),
    value: BigInt(nonNegativeInteger(output['value'], `${where}.value`)),
    scriptPubKey:
      output['scriptPubKey'] === undefined
        ? ''
        : hexString(output['scriptPubKey'], `${where}.scriptPubKey`).toLowerCase(),
  }
}

function checkInput(state: State, value: unknown, where: string, block: Required<MockBlock> | undefined): InputRecord {
  const input = record(value, where, ['txid', 'vout', 'address', 'value'])
  const txid = checkTxid(input['txid'], `${where}.txid`)
  const vout = input['vout']
  if (!Number.isInteger(vout) || (vout as number) < 0 || (vout as number) > MAX_UINT32) {
    throw new TypeError(
      `createMockEsplora: ${where}.vout must be an integer from 0 to ${MAX_UINT32}, not ${show(vout)}`
    )
  }
  const address = input['address'] === undefined ? undefined : checkAddress(input['address'], `${where}.address`)
  const given = input['value'] === undefined ? undefined : BigInt(nonNegativeInteger(input['value'], `${where}.value`))
  const funding = state.txs.get(txid)
  let prevout: OutputRecord
  if (funding === undefined) {
    if (given === undefined) {
      throw new TypeError(`createMockEsplora: ${where} spends an output outside the fixture, so it needs a value`)
    }
    prevout = { address, value: given, scriptPubKey: '' }
  } else {
    const output = funding.vout[vout as number]
    if (output === undefined)
      throw new TypeError(`createMockEsplora: ${where} spends ${txid}:${vout}, which does not exist`)
    if ((address !== undefined && address !== output.address) || (given !== undefined && given !== output.value)) {
      throw new TypeError(`createMockEsplora: ${where} disagrees with the output ${txid}:${vout} it spends`)
    }
    // No valid transaction spends an unspendable output: qbit Core never adds one to the UTXO set
    // (src/coins.cpp:74), and its script fails every spend (src/script/interpreter.cpp:516-517, :789-791, :2445).
    if (isUnspendable(output)) {
      throw new TypeError(
        `createMockEsplora: ${where} spends ${txid}:${vout}, which is unspendable (an OP_RETURN scriptPubKey or one over ${MAX_SCRIPT_SIZE} bytes)`
      )
    }
    if (block !== undefined && funding.block === undefined) {
      throw new TypeError(`createMockEsplora: ${where} is confirmed but spends ${txid}:${vout}, which is not`)
    }
    if (block !== undefined && funding.block!.height > block.height) {
      throw new TypeError(
        `createMockEsplora: ${where} spends ${txid}:${vout} in a block below the one that confirms it`
      )
    }
    // A block spends a coinbase output only once it is mature at the block's height (src/validation.cpp:2867).
    const depth = block === undefined ? undefined : coinbaseDepth(state, { txid }, block.height)
    if (depth !== undefined && depth < COINBASE_MATURITY) {
      throw new TypeError(
        `createMockEsplora: ${where} spends coinbase output ${txid}:${vout} at depth ${depth}, below ${COINBASE_MATURITY}`
      )
    }
    prevout = output
  }
  for (const other of state.txs.values()) {
    if (other.vin.some(spent => spent.txid === txid && spent.vout === vout)) {
      throw new TypeError(`createMockEsplora: ${where} spends ${txid}:${vout}, which ${other.txid} already spends`)
    }
  }
  return { txid, vout: vout as number, prevout, scriptsig: '', witness: [], sequence: 0xffff_fffd }
}

function checkBlock(value: unknown, where: string): Required<MockBlock> {
  const block = record(value, where, ['height', 'hash', 'time'])
  const height = nonNegativeInteger(block['height'], `${where}.height`)
  return {
    height,
    hash: block['hash'] === undefined ? defaultBlockHash(height) : checkTxid(block['hash'], `${where}.hash`),
    time: block['time'] === undefined ? defaultBlockTime(height) : nonNegativeInteger(block['time'], `${where}.time`),
  }
}

function checkFault(value: unknown, where: string): PendingFault {
  const kind = record(value, where)['kind']
  const keys: Record<string, string[]> = {
    status: ['status', 'retryAfter', 'body'],
    'network-error': [],
    stall: ['status', 'retryAfter'],
    broadcast: ['outcome', 'code', 'message'],
  }
  if (typeof kind !== 'string' || !Object.prototype.hasOwnProperty.call(keys, kind)) {
    throw new TypeError(
      `createMockEsplora: ${where}.kind must be 'status', 'network-error', 'stall' or 'broadcast', not ${show(kind)}`
    )
  }
  const fault = record(value, where, ['route', 'kind', 'times', ...keys[kind]!])
  const route = fault['route']
  if (!ROUTES.includes(route as MockRoute)) {
    throw new TypeError(`createMockEsplora: ${where}.route must be one of ${ROUTES.join(', ')}, not ${show(route)}`)
  }
  const times = fault['times'] === undefined ? 1 : fault['times']
  if (times !== Infinity && (!Number.isSafeInteger(times) || (times as number) < 1)) {
    throw new TypeError(`createMockEsplora: ${where}.times must be a positive integer or Infinity, not ${show(times)}`)
  }
  if (fault['retryAfter'] !== undefined) checkRetryAfter(fault['retryAfter'], `${where}.retryAfter`)
  if (kind === 'status') {
    const status = checkStatus(fault['status'], `${where}.status`)
    if (fault['body'] !== undefined && typeof fault['body'] !== 'string') {
      throw new TypeError(`createMockEsplora: ${where}.body must be a string, not ${show(fault['body'])}`)
    }
    if (NULL_BODY_STATUSES.has(status) && fault['body']) {
      throw new TypeError(`createMockEsplora: ${where} gives a ${status} reply a body`)
    }
  }
  if (kind === 'stall' && fault['status'] !== undefined) {
    const status = checkStatus(fault['status'], `${where}.status`)
    if (NULL_BODY_STATUSES.has(status))
      throw new TypeError(`createMockEsplora: ${where} stalls a ${status} reply, which has no body`)
  }
  if (kind === 'broadcast') {
    if (route !== 'POST /tx' && route !== 'POST /tx/push') {
      throw new TypeError(
        `createMockEsplora: ${where} is a broadcast fault on ${String(route)}, not a submission route`
      )
    }
    const outcome = fault['outcome']
    if (outcome !== 'accepted' && outcome !== 'rejected' && outcome !== 'lost-reply') {
      throw new TypeError(
        `createMockEsplora: ${where}.outcome must be 'accepted', 'rejected' or 'lost-reply', not ${show(outcome)}`
      )
    }
    const code = fault['code']
    if (outcome === 'rejected') {
      if (!Number.isSafeInteger(code) || (code as number) >= 0) {
        throw new TypeError(
          `createMockEsplora: ${where}.code must be a negative integer RPC error code, not ${show(code)}`
        )
      }
      if (fault['message'] !== undefined && typeof fault['message'] !== 'string') {
        throw new TypeError(`createMockEsplora: ${where}.message must be a string, not ${show(fault['message'])}`)
      }
    } else if (code !== undefined || fault['message'] !== undefined) {
      throw new TypeError(`createMockEsplora: ${where} gives a code or message to a '${outcome}' outcome`)
    }
  }
  return { fault: { ...fault } as unknown as MockFault, remaining: times as number }
}

function checkStatus(value: unknown, where: string): number {
  if (!Number.isInteger(value) || (value as number) < 200 || (value as number) > 599) {
    throw new TypeError(`createMockEsplora: ${where} must be an integer from 200 to 599, not ${show(value)}`)
  }
  return value as number
}

/**
 * A `Retry-After` the mock can send: non-negative integer seconds, or a string
 * that `Headers`, which builds every reply's headers, accepts as a header
 * value. Asking `Headers` itself applies its rules exactly: a value with a
 * NUL, CR or LF inside it, or a character above U+00FF, is refused.
 */
function checkRetryAfter(value: unknown, where: string): void {
  let valid = typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
  if (typeof value === 'string') {
    try {
      new Headers([['retry-after', value]])
      valid = true
    } catch {
      valid = false
    }
  }
  if (!valid) {
    throw new TypeError(
      `createMockEsplora: ${where} must be non-negative integer seconds or a header value Headers accepts, not ${show(value)}`
    )
  }
}

function checkBaseUrl(value: unknown): string {
  const url = typeof value === 'string' ? value.replace(/\/+$/, '') : ''
  if (!/^https?:\/\/[^\s/?#]+(?:\/[^\s?#]*)?$/i.test(url)) {
    throw new TypeError(
      `createMockEsplora: options.baseUrl must be an absolute http(s) URL without a query or fragment, not ${show(value)}`
    )
  }
  return url
}

function checkFeeEstimates(value: unknown): EsploraFeeEstimates {
  const estimates = record(value, 'options.feeEstimates')
  for (const [target, rate] of Object.entries(estimates)) {
    if (!/^[1-9]\d*$/.test(target)) {
      throw new TypeError(
        `createMockEsplora: options.feeEstimates has a target that is not a block count: ${show(target)}`
      )
    }
    feeRate(rate, `options.feeEstimates[${target}]`)
  }
  return { ...(estimates as EsploraFeeEstimates) }
}

function checkRecommendedFees(value: unknown): MempoolRecommendedFees {
  const fees = record(value, 'options.recommendedFees', [...RECOMMENDED_FEE_FIELDS])
  for (const field of RECOMMENDED_FEE_FIELDS) feeRate(fees[field], `options.recommendedFees.${field}`)
  return { ...(fees as unknown as MempoolRecommendedFees) }
}

function feeRate(value: unknown, where: string): void {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw new TypeError(`createMockEsplora: ${where} must be a finite fee rate above 0, not ${show(value)}`)
  }
}

function checkTxid(value: unknown, where: string): string {
  if (typeof value !== 'string' || !TXID_PATTERN.test(value)) {
    throw new TypeError(`createMockEsplora: ${where} must be 64 hex characters, not ${show(value)}`)
  }
  return value.toLowerCase()
}

function checkAddress(value: unknown, where: string): string {
  if (typeof value !== 'string' || !ADDRESS_PATTERN.test(value)) {
    throw new TypeError(`createMockEsplora: ${where} must be an address (letters and digits), not ${show(value)}`)
  }
  return value
}

function hexString(value: unknown, where: string): string {
  if (typeof value !== 'string' || !HEX_PATTERN.test(value)) {
    throw new TypeError(`createMockEsplora: ${where} must be even-length hex, not ${show(value)}`)
  }
  return value
}

/** A satoshi amount, height or time: a non-negative safe integer. */
function nonNegativeInteger(value: unknown, where: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new TypeError(`createMockEsplora: ${where} must be a non-negative safe integer, not ${show(value)}`)
  }
  return value as number
}

function record(value: unknown, where: string, allowed?: string[]): Record<string, unknown> {
  if (!isRecord(value)) throw new TypeError(`createMockEsplora: ${where} must be an object, not ${show(value)}`)
  if (allowed !== undefined) {
    const unknown = Object.keys(value).filter(key => !allowed.includes(key))
    if (unknown.length > 0) throw new TypeError(`createMockEsplora: ${where} has unknown option ${unknown.join(', ')}`)
  }
  return value
}

function list(value: unknown, where: string): unknown[] {
  if (value === undefined) return []
  if (!Array.isArray(value)) throw new TypeError(`createMockEsplora: ${where} must be an array, not ${show(value)}`)
  return value
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function show(value: unknown): string {
  if (typeof value === 'string') return JSON.stringify(value)
  if (typeof value === 'number' || typeof value === 'bigint' || typeof value === 'boolean') return String(value)
  if (value === undefined || value === null) return String(value)
  return Array.isArray(value) ? 'an array' : `a ${typeof value}`
}

function defaultBlockHash(height: number): string {
  return height.toString(16).padStart(64, '0')
}

function defaultBlockTime(height: number): number {
  return 1_700_000_000 + 600 * height
}

function mineBlock(state: State): Required<MockBlock> {
  const height = state.tipHeight + 1
  const block = { height, hash: defaultBlockHash(height), time: defaultBlockTime(height) }
  for (const tx of state.txs.values()) tx.block ??= block
  state.tipHeight = height
  state.tipHash = block.hash
  return { ...block }
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

interface RouteMatch {
  route: MockRoute
  /** The decoded `:address` or `:txid` segment. */
  param: string
  /** The `/txs/chain/:after_txid` segment or `?after_txid=` value. */
  cursor: string | undefined
}

function matchRoute(method: string, path: string): RouteMatch | undefined {
  const queryStart = path.indexOf('?')
  const pathname = queryStart === -1 ? path : path.slice(0, queryStart)
  const query = new URLSearchParams(queryStart === -1 ? '' : path.slice(queryStart + 1))
  let segments: string[]
  try {
    segments = pathname.slice(1).split('/').map(decodeURIComponent)
  } catch {
    return undefined
  }
  const [first, param = '', third, fourth, fifth] = segments
  const shape = segments.length
  const match = (route: MockRoute, cursor?: string): RouteMatch => ({ route, param, cursor })
  if (method === 'POST') {
    if (pathname === '/tx') return match('POST /tx')
    if (pathname === '/tx/push') return match('POST /tx/push')
    return undefined
  }
  if (method !== 'GET') return undefined
  if (first === 'address' && shape === 2) return match('GET /address/:address')
  if (first === 'address' && shape === 3 && third === 'utxo') return match('GET /address/:address/utxo')
  if (first === 'address' && shape === 3 && third === 'txs') {
    return match('GET /address/:address/txs', query.get('after_txid') ?? undefined)
  }
  if (first === 'address' && third === 'txs' && fourth === 'chain' && (shape === 4 || shape === 5)) {
    return match('GET /address/:address/txs/chain', fifth)
  }
  if (first === 'address' && shape === 4 && third === 'txs' && fourth === 'mempool') {
    return match('GET /address/:address/txs/mempool')
  }
  if (first === 'tx' && shape === 2) return match('GET /tx/:txid')
  if (first === 'tx' && shape === 3 && third === 'hex') return match('GET /tx/:txid/hex')
  if (first === 'tx' && shape === 3 && third === 'status') return match('GET /tx/:txid/status')
  if (pathname === '/fee-estimates') return match('GET /fee-estimates')
  if (pathname === '/fees/recommended') return match('GET /fees/recommended')
  if (pathname === '/blocks/tip/height') return match('GET /blocks/tip/height')
  if (pathname === '/blocks/tip/hash') return match('GET /blocks/tip/hash')
  return undefined
}

function answer(
  state: State,
  method: string,
  path: string,
  body: string | undefined,
  signal: AbortSignal | undefined
): Response {
  const match = matchRoute(method, path)
  if (match === undefined) return text(404, 'Not Found')
  const pending = state.faults.find(entry => entry.fault.route === match.route)
  if (pending !== undefined) {
    pending.remaining -= 1
    if (pending.remaining === 0) state.faults.splice(state.faults.indexOf(pending), 1)
    return applyFault(state, pending.fault, body, signal)
  }
  if (UNSERVED_ROUTES[state.backend].has(match.route)) return text(404, 'Not Found')
  return routeReply(state, match, body)
}

function applyFault(
  state: State,
  fault: MockFault,
  body: string | undefined,
  signal: AbortSignal | undefined
): Response {
  switch (fault.kind) {
    case 'status':
      return text(fault.status, fault.body ?? '', retryAfterHeaders(fault.retryAfter))
    case 'network-error':
      throw fetchFailed('connect ECONNREFUSED', { code: 'ECONNREFUSED', errno: -111, syscall: 'connect' })
    case 'stall':
      return stalled(fault.status ?? 200, retryAfterHeaders(fault.retryAfter), signal)
    case 'broadcast':
      return broadcast(state, fault.route, body, fault)
  }
}

function routeReply(state: State, match: RouteMatch, body: string | undefined): Response {
  switch (match.route) {
    case 'GET /address/:address':
    case 'GET /address/:address/utxo':
    case 'GET /address/:address/txs':
    case 'GET /address/:address/txs/chain':
    case 'GET /address/:address/txs/mempool':
      return addressReply(state, match)
    case 'GET /tx/:txid':
    case 'GET /tx/:txid/hex':
    case 'GET /tx/:txid/status':
      return txReply(state, match)
    case 'GET /fee-estimates':
      return json(state.feeEstimates)
    case 'GET /fees/recommended':
      return json(state.recommendedFees)
    case 'GET /blocks/tip/height':
      return text(200, String(state.tipHeight))
    case 'GET /blocks/tip/hash':
      return text(200, state.tipHash)
    case 'POST /tx':
    case 'POST /tx/push':
      return broadcast(state, match.route, body, undefined)
  }
}

// The address views, from the fixture and the submissions the node took, as
// qbit-electrs 53102e9 builds them from its chain index and its mempool
// (src/new_index/query.rs, src/new_index/mempool.rs, src/rest.rs). Faults
// aside, mempool-qbit passes these routes through from it.

function addressReply(state: State, { route, param: address, cursor }: RouteMatch): Response {
  if (!ADDRESS_PATTERN.test(address)) return text(400, 'Invalid address')
  const { chain, mempool } = addressHistory(state, address)
  switch (route) {
    case 'GET /address/:address':
      return json(addressStats(address, chain, mempool))
    case 'GET /address/:address/utxo':
      return json(unspentOutputs(state, address))
    case 'GET /address/:address/txs/mempool':
      return json(mempool.slice(0, MEMPOOL_PAGE_SIZE).map(txJson))
    case 'GET /address/:address/txs/chain': {
      // An unparseable cursor is ignored (src/rest.rs:1154), and one qbit-electrs cannot find yields `[]`.
      const lastSeen = cursor !== undefined && TXID_PATTERN.test(cursor) ? cursor.toLowerCase() : undefined
      return json(after(chain, lastSeen, CHAIN_PAGE_SIZE).map(txJson))
    }
    default:
      return combinedHistory(state, chain, mempool, cursor)
  }
}

/**
 * The transactions that touch `address`. The chain is newest first: by block
 * height, then by position in the block, last first (src/rest.rs:1165-1171);
 * a block's transactions are in the order the mock learned them. The mempool
 * is in arrival order, oldest first, since qbit-electrs appends each
 * transaction's rows to the address's list and reads it from the front
 * (src/new_index/mempool.rs:155-177, :569-571).
 */
function addressHistory(state: State, address: string): { chain: TxRecord[]; mempool: TxRecord[] } {
  const chain = [...state.txs.values()]
    .map((tx, index) => ({ tx, index }))
    .filter(({ tx }) => tx.block !== undefined && touches(tx, address))
    .sort((a, b) => b.tx.block!.height - a.tx.block!.height || b.index - a.index)
    .map(({ tx }) => tx)
  return { chain, mempool: indexedMempool(state).filter(tx => touches(tx, address)) }
}

/**
 * The mempool transactions qbit-electrs indexes: it skips one whose spent
 * outputs it cannot all find, which then has no rows and no spend edges
 * (src/new_index/mempool.rs:508-517). Only an `accepted` or `lost-reply`
 * fault can put such a transaction in the mock's mempool.
 */
function indexedMempool(state: State): TxRecord[] {
  return [...state.txs.values()].filter(
    tx => tx.block === undefined && tx.vin.every(input => input.prevout !== undefined)
  )
}

/**
 * qbit-electrs's combined route, which mempool-qbit passes through: a page of
 * up to 50 rows by default, which the clients keep, mempool rows first
 * (src/rest.rs:954-1027). An unparseable cursor is ignored (:959-961). A
 * cursor is looked up among every transaction, not only the address's
 * (:601-613): one in a block pages the chain history after it, and one in
 * the mempool pages the mempool rows after it, then the chain from the top;
 * when no mempool rows follow it, the cursor is passed on to the chain
 * history, where it is not found, so the page is empty. A cursor found
 * nowhere is an error.
 */
function combinedHistory(state: State, chain: TxRecord[], mempool: TxRecord[], cursor: string | undefined): Response {
  const id = cursor !== undefined && TXID_PATTERN.test(cursor) ? cursor.toLowerCase() : undefined
  const located = id === undefined ? undefined : state.txs.get(id)
  if (id !== undefined && located === undefined) {
    return state.backend === 'esplora'
      ? text(422, 'after_txid not found')
      : text(500, JSON.stringify({ error: 'Failed to get address transactions' }), {
          'content-type': 'application/json',
        })
  }
  if (located?.block !== undefined) return json(after(chain, id, MEMPOOL_PAGE_SIZE).map(txJson))
  const rows = after(mempool, id, MEMPOOL_PAGE_SIZE)
  if (rows.length < MEMPOOL_PAGE_SIZE) {
    rows.push(...after(chain, rows.length > 0 ? undefined : id, MEMPOOL_PAGE_SIZE - rows.length))
  }
  return json(rows.map(txJson))
}

/** Up to `limit` rows after `lastSeen` (from the start when it is undefined); none when it is not in `txs`. */
function after(txs: TxRecord[], lastSeen: string | undefined, limit: number): TxRecord[] {
  if (lastSeen === undefined) return txs.slice(0, limit)
  const index = txs.findIndex(tx => tx.txid === lastSeen)
  return index === -1 ? [] : txs.slice(index + 1, index + 1 + limit)
}

function touches(tx: TxRecord, address: string): boolean {
  return tx.vout.some(output => output.address === address) || tx.vin.some(input => input.prevout?.address === address)
}

/**
 * `chain_stats` counts confirmed transactions only, and `mempool_stats`
 * mempool ones only (src/new_index/query.rs:152-157): every output paying the
 * address, even one a later mempool transaction spends, every input spending
 * from it, whether the output it spends is confirmed or not, and the distinct
 * transactions (src/new_index/mempool.rs:280-326, :535-571). So a mempool
 * spend of a confirmed output leaves it funded in `chain_stats` and counts
 * it spent in `mempool_stats`.
 */
function addressStats(address: string, chain: TxRecord[], mempool: TxRecord[]): EsploraAddressStats {
  const part = (txs: TxRecord[]): EsploraChainStats => {
    const funded = txs.flatMap(tx => tx.vout.filter(output => output.address === address))
    const spent = txs.flatMap(tx => tx.vin.filter(input => input.prevout?.address === address))
    return {
      funded_txo_count: funded.length,
      funded_txo_sum: Number(funded.reduce((sum, output) => sum + output.value, 0n)),
      spent_txo_count: spent.length,
      spent_txo_sum: Number(spent.reduce((sum, input) => sum + input.prevout!.value, 0n)),
      tx_count: txs.length,
    }
  }
  return { address, chain_stats: part(chain), mempool_stats: part(mempool) }
}

/**
 * The address's unspent outputs, as qbit-electrs lists them
 * (src/new_index/query.rs:126-136): the confirmed ones no confirmed or mempool
 * transaction spends, then the mempool ones no mempool transaction spends
 * (src/new_index/mempool.rs:239-277), each part in the order the mock learned
 * the transactions. qbit-electrs lists the confirmed part in no fixed order
 * (src/new_index/schema.rs:314).
 */
function unspentOutputs(state: State, address: string): EsploraUtxo[] {
  const outpoints = (txs: TxRecord[]) => txs.flatMap(tx => tx.vin.map(input => `${input.txid}:${input.vout}`))
  const confirmed = [...state.txs.values()].filter(tx => tx.block !== undefined)
  const mempool = indexedMempool(state)
  const mempoolSpent = new Set(outpoints(mempool))
  const chainSpent = new Set([...outpoints(confirmed), ...mempoolSpent])
  const unspent = (txs: TxRecord[], spent: Set<string>): EsploraUtxo[] =>
    txs.flatMap(tx =>
      tx.vout.flatMap((output, vout) =>
        output.address === address && !spent.has(`${tx.txid}:${vout}`)
          ? [{ txid: tx.txid, vout, value: Number(output.value), status: txStatus(tx) }]
          : []
      )
    )
  return [...unspent(confirmed, chainSpent), ...unspent(mempool, mempoolSpent)]
}

function txReply(state: State, { route, param }: RouteMatch): Response {
  if (!TXID_PATTERN.test(param)) return text(400, 'Invalid hex string')
  const tx = state.txs.get(param.toLowerCase())
  if (tx === undefined) {
    // qbit-electrs reports a txid it has never seen as unconfirmed; the mempool-qbit hosts answer 404.
    if (route === 'GET /tx/:txid/status' && state.backend === 'esplora') return json({ confirmed: false })
    return text(404, 'Transaction not found')
  }
  if (route === 'GET /tx/:txid/status') return json(txStatus(tx))
  if (route === 'GET /tx/:txid') return json(txJson(tx))
  if (tx.hex === undefined) {
    return text(501, `createMockEsplora: fixture transaction ${tx.txid} has no hex; declare it to serve this route`)
  }
  return text(200, tx.hex)
}

function txStatus(tx: TxRecord): EsploraTxStatus {
  return tx.block === undefined
    ? { confirmed: false }
    : { confirmed: true, block_height: tx.block.height, block_hash: tx.block.hash, block_time: tx.block.time }
}

/** A coinbase's input, as qbit-electrs serves it (src/rest.rs:260-305). */
function coinbaseVinJson({ scriptsig, sequence }: { scriptsig: string; sequence: number }): EsploraVin {
  return {
    txid: NULL_TXID,
    vout: NULL_INDEX,
    prevout: null,
    scriptsig,
    scriptsig_asm: '',
    is_coinbase: true,
    sequence,
  }
}

function txJson(tx: TxRecord): EsploraTx {
  if (tx.coinbaseInput !== undefined) return { ...spendJson(tx), vin: [coinbaseVinJson(tx.coinbaseInput)] }
  return spendJson(tx)
}

function spendJson(tx: TxRecord): EsploraTx {
  return {
    txid: tx.txid,
    version: tx.version,
    locktime: tx.locktime,
    vin: tx.vin.map((input): EsploraVin => ({
      txid: input.txid,
      vout: input.vout,
      prevout: input.prevout === undefined ? null : voutJson(input.prevout),
      scriptsig: input.scriptsig,
      scriptsig_asm: '',
      ...(input.witness.length > 0 ? { witness: input.witness } : {}),
      is_coinbase: false,
      sequence: input.sequence,
    })),
    vout: tx.vout.map(voutJson),
    size: tx.size,
    weight: tx.weight,
    fee: tx.fee,
    status: txStatus(tx),
  }
}

function voutJson(output: OutputRecord): EsploraVout {
  return {
    scriptpubkey: output.scriptPubKey,
    scriptpubkey_asm: '',
    scriptpubkey_type: 'unknown',
    ...(output.address === undefined ? {} : { scriptpubkey_address: output.address }),
    value: Number(output.value),
  }
}

// ---------------------------------------------------------------------------
// Broadcast
// ---------------------------------------------------------------------------

/**
 * One submission, as the node and qbit-electrs or mempool-qbit answer it.
 * qbit-electrs hands the body to `sendrawtransaction` as it is
 * (src/rest.rs:1512-1526, src/daemon.rs:775-776) and relays a refusal as a
 * `400` whose body is `sendrawtransaction RPC error: ` and the RPC error
 * object (src/daemon.rs:136, src/rest.rs:2117-2121). Hex the node cannot
 * decode is RPC error -22, with Core's message (src/rpc/mempool.cpp:80-82).
 * Without a fault, the node then judges the transaction as
 * {@link nodeVerdict} says, and takes any it does not refuse into its
 * mempool, which qbit-electrs adds to its own mempool index at once
 * (src/new_index/query.rs:91-103). `POST /tx/push` reads the hex from a
 * `txHash=` form body.
 */
function broadcast(
  state: State,
  route: 'POST /tx' | 'POST /tx/push',
  body: string | undefined,
  fault: MockBroadcastFault | undefined
): Response {
  const raw = body ?? ''
  const hex = route === 'POST /tx/push' ? (/^txHash=([0-9a-fA-F]*)$/.exec(raw)?.[1] ?? '') : raw
  const outcome = fault?.outcome
  if (outcome === 'rejected') return rpcError(fault!.code!, fault!.message ?? 'transaction rejected')
  const parsed = parseRawTx(hex)
  if (parsed === undefined) {
    if (outcome === 'lost-reply') throw connectionReset()
    return rpcError(-22, 'TX decode failed. Make sure the tx has at least one input.')
  }
  if (outcome === undefined) {
    const refusal = nodeVerdict(state, parsed)
    if (refusal !== undefined) return refusal
  }
  if (!state.txs.has(parsed.txid)) state.txs.set(parsed.txid, submittedTx(state, parsed, hex))
  if (outcome === 'lost-reply') throw connectionReset()
  return text(200, parsed.txid)
}

/**
 * qbit Core v1.0.0's verdict on a decoded submission (qbit 7ebcddb), in the
 * order `sendrawtransaction` reaches it, or undefined when the node takes it
 * or already has it in its mempool. The node's coins are the outputs of the
 * transactions it knows, the fixture's and the submissions it took, less
 * those a confirmed transaction spends and the unspendable outputs of
 * confirmed transactions, which never join the UTXO set (src/coins.cpp:74).
 * The mempool's view of the coins adds every output of a mempool
 * transaction, an unspendable one included (src/txmempool.cpp:1020-1029,
 * src/validation.cpp:893-916); Core refuses a spend of that later, in checks
 * the mock does not model, such as the script check.
 *
 * A refusal carries the code `sendrawtransaction` returns for it: a mempool
 * rejection is `TransactionError::MISSING_INPUTS` for missing inputs and
 * `MEMPOOL_REJECTED` otherwise (src/node/transaction.cpp:21-32), which are
 * RPC errors -25 and -26 (src/rpc/util.cpp:502-511, src/rpc/protocol.h:46-55).
 * Its message is the reject reason, then `, ` and the debug message when
 * there is one (src/consensus/validation.h:111-121).
 *
 * 1. -25 for an output that is unspendable or holds an invalid opcode and
 *    has a value above `maxburnamount` (src/rpc/mempool.cpp:84-88), which is
 *    0 because qbit-electrs passes only the hex (src/rpc/mempool.cpp:77,
 *    qbit-electrs src/daemon.rs:776).
 * 2. `BroadcastTransaction` (src/node/transaction.cpp:51-70): -27 while an
 *    output of the transaction itself is a coin, which only a confirmed
 *    transaction's can be; then the txid for one in the mempool.
 * 3. `CheckTransaction` (src/consensus/tx_check.cpp:11-60, called first by
 *    `PreChecks`, src/validation.cpp:839-841), in its order: -26 for no
 *    inputs, no outputs, a size without the witness above MAX_BLOCK_WEIGHT,
 *    an output value below 0 or above MAX_MONEY, an output total above
 *    MAX_MONEY, an output spent twice, and a coinbase input script under 2 or
 *    over 100 bytes or a null prevout in any other transaction.
 * 4. -26 `coinbase` for a coinbase (src/validation.cpp:843-845). The checks
 *    that follow (:847-869), qbit's P2MR-only outputs, standardness, the
 *    minimum size and finality, are not modeled.
 * 5. -25 `bad-txns-inputs-missingorspent` for a spend of an output that is
 *    not a coin (:893-916): unknown, spent in a block, or an unspendable
 *    output of a confirmed transaction. A confirmed transaction whose outputs
 *    are all spent gets it too, since its own inputs are spent. Core's
 *    `txn-already-known` there needs an output of the transaction itself to
 *    be a coin, which step 2 answers first.
 * 6. `CheckTxInputs` (src/consensus/tx_verify.cpp:164-205, called at
 *    src/validation.cpp:939-942), in its order: -26 for a coinbase output
 *    below COINBASE_MATURITY deep in the next block, an input value or the
 *    input total out of range, and inputs worth less than the outputs. Its
 *    last check, a fee out of range, cannot fail once those pass. The
 *    sequence locks before it (:929-937) are not modeled, nor are the policy
 *    checks after it (:944-1114).
 * 7. -26 `bad-txns-spends-conflicting-tx` for one that spends an output of a
 *    mempool transaction it conflicts with (:1116-1124,
 *    src/policy/rbf.cpp:118-131), naming the first such transaction in
 *    txid byte order, as the mempool's sets hold them
 *    (src/txmempool.h:373, src/kernel/mempool_entry.h:46-50,
 *    src/uint256.h:64-68).
 * 8. -26 `insufficient fee` for any other spend of an output a mempool
 *    transaction spends. Core takes such a conflict as a replacement when it
 *    passes `ReplacementChecks` (src/validation.cpp:1131-1190); a conflict
 *    that fails them gets `insufficient fee, rejecting replacement <txid>`
 *    and the feerates or fees compared, or a limit's reason
 *    (src/policy/rbf.cpp:73, :110, :150, :169, :178). The mock never
 *    replaces, and its message stops before the numbers, which it does not
 *    compute.
 * 9. -25 for a fee above `maxfeerate` times the size
 *    (src/node/transaction.cpp:72-81), which `BroadcastTransaction` checks
 *    once the mempool would take the transaction. qbit-electrs names no
 *    `maxfeerate`, so it is 0.1 coin per kvB (src/node/transaction.h:27,
 *    src/rpc/mempool.cpp:54-56, :92-95), and with WITNESS_SCALE_FACTOR 1 the
 *    size is the serialized size, sigops aside (src/policy/policy.h:189-192,
 *    src/policy/policy.cpp:424-427).
 *
 * Not modeled, so the mock takes what Core refuses for them, unless a
 * modeled check refuses it (src/validation.cpp unless named): qbit's
 * P2MR-only outputs (`tx-output-not-p2mr`, :849-852,
 * src/consensus/restricted_outputs.h:18-46), which mainnet, testnet,
 * testnet4 and signet enforce (src/kernel/chainparams.cpp:159, :267, :360,
 * :482), and regtest unless the node runs with `-p2mronly=0`
 * (src/kernel/chainparams.cpp:571, src/kernel/chainparams.h:153,
 * src/chainparams.cpp:49, src/init.cpp:494-496); standardness (:854-858) and the 65-byte minimum
 * size without the witness (:860-862, src/policy/policy.h:39); lock times
 * (`non-final`, :864-869) and sequence locks (`non-BIP68-final`, :929-937);
 * standard inputs and witnesses, the sigop limit, dust, the minimum relay
 * feerate and the mempool's minimum fee (:944-1005, :746); mempool chain
 * limits (`too-long-mempool-chain`, :1049-1086) and TRUC rules (:1091-1114);
 * scripts and signatures (:1291, :1314); and a full mempool (:1534).
 */
function nodeVerdict(state: State, parsed: ParsedTx): Response | undefined {
  const reject = (reason: string): Response => rpcError(-26, reason)
  if (parsed.vout.some(output => output.value > 0n && (isUnspendable(output) || !hasValidOps(output.scriptPubKey)))) {
    return rpcError(-25, 'Unspendable output exceeds maximum configured by user (maxburnamount)')
  }

  const spenders = new Map<string, TxRecord[]>()
  for (const tx of state.txs.values()) {
    for (const input of tx.vin) {
      const outpoint = `${input.txid}:${input.vout}`
      spenders.set(outpoint, [...(spenders.get(outpoint) ?? []), tx])
    }
  }
  // A coin in the chain's UTXO set: an output of a confirmed transaction that
  // is spendable and that no confirmed transaction spends.
  const isChainCoin = (txid: string, vout: number): boolean => {
    const funding = state.txs.get(txid)
    const output = funding?.vout[vout]
    if (funding?.block === undefined || output === undefined || isUnspendable(output)) return false
    return !(spenders.get(`${txid}:${vout}`) ?? []).some(tx => tx.block !== undefined)
  }
  // A coin in the mempool's view of it, which adds every output of a mempool
  // transaction, unspendable or spent in the mempool included
  // (src/txmempool.cpp:1020-1029).
  const isCoin = (txid: string, vout: number): boolean => {
    const funding = state.txs.get(txid)
    if (funding === undefined) return false
    return funding.block === undefined ? vout < funding.vout.length : isChainCoin(txid, vout)
  }
  const known = state.txs.get(parsed.txid)
  if (parsed.vout.some((_, vout) => isChainCoin(parsed.txid, vout))) {
    return rpcError(-27, 'Transaction outputs already in utxo set')
  }
  if (known !== undefined && known.block === undefined) return undefined

  if (parsed.vin.length === 0) return reject('bad-txns-vin-empty')
  if (parsed.vout.length === 0) return reject('bad-txns-vout-empty')
  if (parsed.strippedSize * WITNESS_SCALE_FACTOR > MAX_BLOCK_WEIGHT) return reject('bad-txns-oversize')
  let valueOut = 0n
  for (const { value } of parsed.vout) {
    if (value < 0n) return reject('bad-txns-vout-negative')
    if (value > MAX_MONEY) return reject('bad-txns-vout-toolarge')
    valueOut += value
    if (!moneyRange(valueOut)) return reject('bad-txns-txouttotal-toolarge')
  }
  const outpoints = parsed.vin.map(input => `${input.txid}:${input.vout}`)
  if (new Set(outpoints).size !== outpoints.length) return reject('bad-txns-inputs-duplicate')
  const coinbase = isCoinbase(parsed)
  if (coinbase) {
    const length = parsed.vin[0]!.scriptsig.length / 2
    if (length < 2 || length > 100) return reject('bad-cb-length')
  } else if (parsed.vin.some(isNullPrevout)) {
    return reject('bad-txns-prevout-null')
  }
  if (coinbase) return reject('coinbase')

  if (!parsed.vin.every(input => isCoin(input.txid, input.vout))) {
    return rpcError(-25, 'bad-txns-inputs-missingorspent')
  }

  let valueIn = 0n
  for (const input of parsed.vin) {
    const depth = coinbaseDepth(state, input, state.tipHeight + 1)
    if (depth !== undefined && depth < COINBASE_MATURITY) {
      return reject(`bad-txns-premature-spend-of-coinbase, tried to spend coinbase at depth ${depth}`)
    }
    const { value } = state.txs.get(input.txid)!.vout[input.vout]!
    valueIn += value
    if (!moneyRange(value) || !moneyRange(valueIn)) return reject('bad-txns-inputvalues-outofrange')
  }
  if (valueIn < valueOut) {
    return reject(`bad-txns-in-belowout, value in (${formatMoney(valueIn)}) < value out (${formatMoney(valueOut)})`)
  }

  const conflicts = new Set(
    outpoints
      .flatMap(outpoint => (spenders.get(outpoint) ?? []).filter(tx => tx.block === undefined))
      .map(tx => tx.txid)
  )
  if (conflicts.size > 0) {
    const spendsConflict = mempoolAncestors(state, parsed)
      .filter(txid => conflicts.has(txid))
      .sort((a, b) => compareTxidBytes(a, b))[0]
    if (spendsConflict !== undefined) {
      return reject(`bad-txns-spends-conflicting-tx, ${parsed.txid} spends conflicting transaction ${spendsConflict}`)
    }
    return reject(`insufficient fee, rejecting replacement ${parsed.txid}`)
  }

  if (valueIn - valueOut > MAX_RAW_TX_FEE_PER_BYTE * BigInt(parsed.size)) {
    return rpcError(-25, 'Fee exceeds maximum configured by user (e.g. -maxtxfee, maxfeerate)')
  }
  return undefined
}

/** The mempool transactions `parsed` spends from, and theirs, recursively. */
function mempoolAncestors(state: State, parsed: ParsedTx): string[] {
  const found = new Set<string>()
  const pending = parsed.vin.map(input => input.txid)
  while (pending.length > 0) {
    const tx = state.txs.get(pending.pop()!)
    if (tx === undefined || tx.block !== undefined || found.has(tx.txid)) continue
    found.add(tx.txid)
    pending.push(...tx.vin.map(input => input.txid))
  }
  return [...found]
}

/** Order txids as qbit Core's `uint256` compares them: by their bytes in hash order, the reverse of the hex. */
function compareTxidBytes(a: string, b: string): number {
  const internal = (txid: string) => txid.match(/../g)!.reverse().join('')
  return internal(a) < internal(b) ? -1 : internal(a) > internal(b) ? 1 : 0
}

/** qbit Core `MoneyRange` (src/consensus/amount.h:27). */
function moneyRange(value: bigint): boolean {
  return value >= 0n && value <= MAX_MONEY
}

/**
 * qbit Core `FormatMoney` (src/util/moneystr.cpp:19-42): coins with eight
 * decimals, trailing zeros trimmed down to two, as in `0.0015` or `1.00`.
 */
function formatMoney(sats: bigint): string {
  const text = `${sats / COIN}.${(sats % COIN).toString().padStart(8, '0')}`
  return text.replace(/(\.\d\d\d*?)0+$/, '$1')
}

/**
 * qbit Core `CScript::IsUnspendable` (src/script/script.h:682-685): an
 * `OP_RETURN` script, or one over MAX_SCRIPT_SIZE, which nothing can spend.
 */
function isUnspendable(output: { scriptPubKey: string }): boolean {
  return output.scriptPubKey.startsWith('6a') || output.scriptPubKey.length > 2 * MAX_SCRIPT_SIZE
}

/** A submission the node took, decoded from its hex; prevouts and addresses come from the fixture where it has them. */
function submittedTx(state: State, parsed: ParsedTx, hex: string): TxRecord {
  const outputs = new Map<string, OutputRecord>()
  const addresses = new Map<string, string>()
  for (const tx of state.txs.values()) {
    tx.vout.forEach((output, vout) => {
      outputs.set(`${tx.txid}:${vout}`, output)
      if (output.address !== undefined && output.scriptPubKey !== '') addresses.set(output.scriptPubKey, output.address)
    })
  }
  const vin = parsed.vin.map(input => ({ ...input, prevout: outputs.get(`${input.txid}:${input.vout}`) }))
  const vout = parsed.vout.map(output => ({ ...output, address: addresses.get(output.scriptPubKey) }))
  const inSum = vin.every(input => input.prevout !== undefined)
    ? vin.reduce((sum, input) => sum + input.prevout!.value, 0n)
    : undefined
  const outSum = vout.reduce((sum, output) => sum + output.value, 0n)
  return {
    txid: parsed.txid,
    hex: hex.toLowerCase(),
    version: parsed.version,
    locktime: parsed.locktime,
    vin,
    vout,
    fee: inSum === undefined || inSum < outSum ? 0 : Number(inSum - outSum),
    size: parsed.size,
    weight: parsed.weight,
    block: undefined,
    coinbase: false,
    coinbaseInput: undefined,
  }
}

function rpcError(code: number, message: string): Response {
  return text(400, `sendrawtransaction RPC error: ${JSON.stringify({ code, message })}`)
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

function requestUrl(input: unknown): string {
  if (isRecord(input) && typeof input['url'] === 'string') return input['url']
  return String(input)
}

function text(status: number, body: string, headers: Record<string, string> = {}): Response {
  return new Response(NULL_BODY_STATUSES.has(status) ? null : body, {
    status,
    headers: { 'content-type': 'text/plain', ...headers },
  })
}

function json(value: unknown): Response {
  return text(200, JSON.stringify(value), { 'content-type': 'application/json' })
}

function retryAfterHeaders(retryAfter: number | string | undefined): Record<string, string> {
  return retryAfter === undefined ? {} : { 'retry-after': String(retryAfter) }
}

/** A reply whose body never ends; aborting the request's signal errors it, as fetch does. */
function stalled(status: number, headers: Record<string, string>, signal: AbortSignal | undefined): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      signal?.addEventListener('abort', () => controller.error(signal.reason), { once: true })
    },
  })
  return new Response(body, { status, headers: { 'content-type': 'text/plain', ...headers } })
}

/** undici's rejection for a failed request: `TypeError('fetch failed')` with the system error as `cause`. */
function fetchFailed(message: string, fields: { code: string; errno: number; syscall: string }): TypeError {
  return Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error(message), fields) })
}

function connectionReset(): TypeError {
  return fetchFailed('read ECONNRESET', { code: 'ECONNRESET', errno: -104, syscall: 'read' })
}

// ---------------------------------------------------------------------------
// Raw transactions
// ---------------------------------------------------------------------------

interface ParsedTx {
  txid: string
  version: number
  locktime: number
  vin: { txid: string; vout: number; scriptsig: string; witness: string[]; sequence: number }[]
  vout: { value: bigint; scriptPubKey: string }[]
  /** Serialized size in bytes, with the witness. */
  size: number
  /** Serialized size in bytes without the witness: the bytes the txid hashes. */
  strippedSize: number
  /**
   * The weight qbit-electrs reports: with qbit's WITNESS_SCALE_FACTOR of 1,
   * the serialized size (src/qbit_codec.rs:139-145, src/util/fees.rs:34-41).
   */
  weight: number
}

/** qbit Core `serialize.h` MAX_SIZE: the largest CompactSize `ReadCompactSize` accepts (src/serialize.h:32). */
const COMPACT_SIZE_MAX = 0x02000000
/** qbit Core `script.h` limits (src/script/script.h:28, :40, :327): MAX_SCRIPT_ELEMENT_SIZE, MAX_SCRIPT_SIZE and MAX_OPCODE (OP_NOP10). */
const MAX_SCRIPT_ELEMENT_SIZE = 520
const MAX_SCRIPT_SIZE = 10_000
const MAX_OPCODE = 0xb9
const OP_PUSHDATA1 = 0x4c
const OP_PUSHDATA2 = 0x4d
const OP_PUSHDATA4 = 0x4e

/**
 * Decode a raw transaction as qbit Core's `DecodeHexTx` does for
 * `sendrawtransaction`, or return undefined where it fails
 * (src/core_read.cpp:125-204). The hex must be non-empty
 * (src/util/strencodings.cpp:41-47). Core decodes it with the witness
 * serialization and, unless that result passes `CheckTxScriptsSanity`,
 * without it, and keeps the one that passes, else the witness one, else the
 * legacy one. The witness serialization reads an input count of 0 as its
 * marker and the next byte as flags, and flags of 0 as a transaction with no
 * inputs and no outputs (src/primitives/transaction.h:216-253), so a
 * transaction with no inputs can decode either way. A decoding fails on
 * truncated or trailing bytes, a CompactSize that is non-canonical or above
 * MAX_SIZE (src/serialize.h:335-358), a witness flag with every witness
 * stack empty, or an unknown flag. The txid is the double SHA-256 of the
 * encoding without the witness, as the client's `txidFromRawTx` derives it
 * for every transaction that one can read, which excludes those with no
 * inputs.
 */
function parseRawTx(hex: string): ParsedTx | undefined {
  if (hex === '' || !HEX_PATTERN.test(hex)) return undefined
  const bytes = new Uint8Array(hex.length / 2)
  for (let i = 0; i < bytes.length; i += 1) bytes[i] = parseInt(hex.slice(2 * i, 2 * i + 2), 16)
  const extended = decodeTx(bytes, true)
  if (extended !== undefined && scriptsSane(extended)) return extended
  const legacy = decodeTx(bytes, false)
  if (legacy !== undefined && scriptsSane(legacy)) return legacy
  return extended ?? legacy
}

/** `UnserializeTransaction` with or without the witness serialization, or undefined where it throws or leaves bytes over. */
function decodeTx(bytes: Uint8Array, allowWitness: boolean): ParsedTx | undefined {
  let offset = 0
  const take = (length: number): Uint8Array => {
    if (length > bytes.length - offset) throw new RangeError('truncated')
    offset += length
    return bytes.subarray(offset - length, offset)
  }
  const uint32 = (): number => take(4).reduce((sum, byte, i) => sum + byte * 2 ** (8 * i), 0)
  const int64 = (): bigint =>
    BigInt.asIntN(
      64,
      take(8).reduceRight((sum, byte) => (sum << 8n) | BigInt(byte), 0n)
    )
  const compactSize = (): number => {
    const first = take(1)[0]!
    if (first < 0xfd) return first
    const width = first === 0xfd ? 2 : first === 0xfe ? 4 : 8
    const value = take(width).reduce((sum, byte, i) => sum + byte * 2 ** (8 * i), 0)
    const minimum = first === 0xfd ? 0xfd : first === 0xfe ? 0x10000 : 2 ** 32
    if (value < minimum || value > COMPACT_SIZE_MAX) throw new RangeError('bad CompactSize')
    return value
  }
  const varBytes = (): string => toHex(take(compactSize()))
  const inputs = () =>
    Array.from({ length: compactSize() }, () => {
      const txid = toHex(take(32).slice().reverse())
      const vout = uint32()
      const scriptsig = varBytes()
      return { txid, vout, scriptsig, witness: [] as string[], sequence: uint32() }
    })
  const outputs = () => Array.from({ length: compactSize() }, () => ({ value: int64(), scriptPubKey: varBytes() }))
  try {
    const version = uint32()
    // The bytes after the version that the txid hashes with it and the lock time.
    let bodyStart = offset
    let flags = 0
    let vin = inputs()
    let vout: ParsedTx['vout'] = []
    if (vin.length === 0 && allowWitness) {
      flags = take(1)[0]!
      if (flags !== 0) {
        bodyStart = offset
        vin = inputs()
        vout = outputs()
      }
    } else {
      vout = outputs()
    }
    const bodyEnd = offset
    if (flags & 1) {
      flags ^= 1
      for (const input of vin) input.witness = Array.from({ length: compactSize() }, varBytes)
      if (vin.every(input => input.witness.length === 0)) return undefined
    }
    if (flags !== 0) return undefined
    const locktime = uint32()
    if (offset !== bytes.length) return undefined
    const stripped = new Uint8Array(bodyEnd - bodyStart + 8)
    stripped.set(bytes.subarray(0, 4))
    stripped.set(bytes.subarray(bodyStart, bodyEnd), 4)
    stripped.set(bytes.subarray(-4), stripped.length - 4)
    return {
      txid: toHex(sha256(sha256(stripped)).reverse()),
      version,
      locktime,
      vin,
      vout,
      size: bytes.length,
      strippedSize: stripped.length,
      weight: bytes.length,
    }
  } catch {
    return undefined
  }
}

/**
 * qbit Core `CheckTxScriptsSanity` (src/core_read.cpp:105-123): every
 * scriptSig, except a coinbase's, and every scriptPubKey parses into valid
 * opcodes and is at most MAX_SCRIPT_SIZE bytes.
 */
function scriptsSane(tx: ParsedTx): boolean {
  const sane = (script: string) => script.length <= 2 * MAX_SCRIPT_SIZE && hasValidOps(script)
  return (
    (isCoinbase(tx) || tx.vin.every(input => sane(input.scriptsig))) &&
    tx.vout.every(output => sane(output.scriptPubKey))
  )
}

/**
 * qbit Core `CScript::HasValidOps` (src/script/script.cpp:306-317): the script
 * parses as `GetScriptOp` reads it (:319-365), with no opcode above
 * MAX_OPCODE and no push above MAX_SCRIPT_ELEMENT_SIZE bytes.
 */
function hasValidOps(script: string): boolean {
  const byte = (at: number) => parseInt(script.slice(2 * at, 2 * at + 2), 16)
  const length = script.length / 2
  let pc = 0
  while (pc < length) {
    const opcode = byte(pc)
    pc += 1
    let size = 0
    if (opcode <= OP_PUSHDATA4) {
      const width = opcode < OP_PUSHDATA1 ? 0 : opcode === OP_PUSHDATA1 ? 1 : opcode === OP_PUSHDATA2 ? 2 : 4
      if (length - pc < width) return false
      size =
        width === 0
          ? opcode
          : Array.from({ length: width }, (_, i) => byte(pc + i) * 2 ** (8 * i)).reduce((a, b) => a + b, 0)
      pc += width
      if (length - pc < size) return false
      pc += size
    }
    if (opcode > MAX_OPCODE || size > MAX_SCRIPT_ELEMENT_SIZE) return false
  }
  return true
}

function isNullPrevout(input: { txid: string; vout: number }): boolean {
  return input.txid === NULL_TXID && input.vout === NULL_INDEX
}

/** qbit Core `CTransaction::IsCoinBase` (src/primitives/transaction.h:356-359): one input, whose prevout is null. */
function isCoinbase(tx: ParsedTx): boolean {
  return tx.vin.length === 1 && isNullPrevout(tx.vin[0]!)
}

function toHex(bytes: Uint8Array): string {
  let hex = ''
  for (const byte of bytes) hex += byte.toString(16).padStart(2, '0')
  return hex
}

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
 * fixture's transactions: the address stats, unspent outputs and history.
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
   * before this one, or one outside the fixture. No output is spent twice.
   */
  vin?: MockInput[]
  /** Outputs, at least one. */
  vout: MockOutput[]
  /**
   * Fee in satoshis (default: inputs minus outputs, or 0 without inputs). It
   * must equal inputs minus outputs when there are inputs.
   */
  fee?: number
  /** The block that holds it; omit it for a transaction in the mempool. */
  block?: MockBlock
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
   * `Retry-After` header: delta-seconds as a non-negative integer, or the raw
   * header value (an HTTP date, say).
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
 * It serves every route the two clients call, from one fixture, so the views
 * agree: address stats, unspent outputs and history pages are derived from
 * `txs`, as are `GET /tx/:txid`, its `/hex` and its `/status`.
 *
 * Without a fault, the node judges a submission as qbit Core v1.0.0 does,
 * from the outputs the fixture and the submissions it took create and spend,
 * and the first answer that applies is its reply: RPC error `-22` for hex it
 * cannot decode; `-27` for a transaction in a block while the chain holds
 * one of its outputs unspent (a mempool spend does not count); the txid for
 * one in its mempool; `-26 bad-txns-inputs-duplicate` for one that spends an
 * output twice; `-25 bad-txns-inputs-missingorspent` for one that spends an
 * output that is unknown, spent in a block, or unspendable (an `OP_RETURN` or
 * oversized script); and `-26 insufficient fee` for one that spends an output
 * a mempool transaction spends. qbit Core takes such a conflict as a
 * replacement (full RBF) when it passes its replacement checks, which ask for
 * a higher feerate and more fees among other things; the mock never replaces.
 * The node takes any other transaction: the mock checks no script,
 * signature, amount, fee or relay policy.
 *
 * A submission the node takes joins the mempool and is found by those
 * lookups, and {@link MockEsplora.mine} confirms it; only fixture
 * transactions count in the address views. Faults replace a route's reply;
 * see {@link MockFault}.
 *
 * @remarks
 * See [Testing](https://github.com/Qbit-Org/qbit-js/blob/main/packages/api/docs/testing.md).
 *
 * @param options - The backend, its fixture and the faults to inject.
 * @returns The mock, with its `fetchFn` and the requests it received.
 * @throws TypeError when an option is missing, unknown or malformed (a txid,
 *   address or hex string, a negative or non-finite number, an unknown route
 *   or fault kind, `null`), or the fixture is inconsistent (a spend of a
 *   missing or already-spent output, a confirmed spend of an unconfirmed
 *   output, a fee that does not balance, two hashes or times for one block
 *   height, a tip hash that is not the fixture block's at its height).
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
  /** Fixture transactions count in the address views; submissions do not. */
  inAddressViews: boolean
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
  value: number
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
  return state
}

function addFixtureTx(state: State, value: unknown, where: string, blocks: Map<number, Required<MockBlock>>): void {
  const tx = record(value, where, ['txid', 'hex', 'vin', 'vout', 'fee', 'block'])
  const hex = tx['hex'] === undefined ? undefined : hexString(tx['hex'], `${where}.hex`)
  const parsed = hex === undefined ? undefined : parseRawTx(hex)
  if (hex !== undefined && parsed === undefined) {
    throw new TypeError(`createMockEsplora: ${where}.hex is not a well-formed transaction`)
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

  const outSum = vout.reduce((sum, output) => sum + output.value, 0)
  const inSum = vin.reduce((sum, input) => sum + input.prevout!.value, 0)
  if (!Number.isSafeInteger(outSum) || !Number.isSafeInteger(inSum)) {
    throw new TypeError(`createMockEsplora: ${where} moves more than ${Number.MAX_SAFE_INTEGER} sats`)
  }
  const balance = inSum - outSum
  if (vin.length > 0 && balance < 0) {
    throw new TypeError(`createMockEsplora: ${where} pays out ${outSum} sats but spends only ${inSum}`)
  }
  let fee = vin.length > 0 ? balance : 0
  if (tx['fee'] !== undefined) {
    const given = nonNegativeInteger(tx['fee'], `${where}.fee`)
    if (vin.length > 0 && given !== balance) {
      throw new TypeError(`createMockEsplora: ${where}.fee ${given} is not inputs minus outputs (${balance})`)
    }
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
    inAddressViews: true,
  })
}

function checkOutput(value: unknown, where: string): OutputRecord {
  const output = record(value, where, ['address', 'value', 'scriptPubKey'])
  return {
    address: output['address'] === undefined ? undefined : checkAddress(output['address'], `${where}.address`),
    value: nonNegativeInteger(output['value'], `${where}.value`),
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
  const given = input['value'] === undefined ? undefined : nonNegativeInteger(input['value'], `${where}.value`)
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
    if (block !== undefined && funding.block === undefined) {
      throw new TypeError(`createMockEsplora: ${where} is confirmed but spends ${txid}:${vout}, which is not`)
    }
    if (block !== undefined && funding.block!.height > block.height) {
      throw new TypeError(
        `createMockEsplora: ${where} spends ${txid}:${vout} in a block below the one that confirms it`
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

function checkRetryAfter(value: unknown, where: string): void {
  const valid =
    typeof value === 'number'
      ? Number.isSafeInteger(value) && value >= 0
      : typeof value === 'string' && value !== '' && !/[\r\n]/.test(value)
  if (!valid) {
    throw new TypeError(
      `createMockEsplora: ${where} must be non-negative integer seconds or a header value, not ${show(value)}`
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

function addressReply(state: State, { route, param: address, cursor }: RouteMatch): Response {
  if (!ADDRESS_PATTERN.test(address)) return text(400, 'Invalid address')
  const txs = [...state.txs.values()].filter(tx => tx.inAddressViews && touches(tx, address))
  // Newest first: the mempool in reverse arrival order, the chain by height and then reverse arrival order.
  const mempool = txs.filter(tx => tx.block === undefined).reverse()
  const chain = txs
    .filter(tx => tx.block !== undefined)
    .map((tx, index) => ({ tx, index }))
    .sort((a, b) => b.tx.block!.height - a.tx.block!.height || b.index - a.index)
    .map(({ tx }) => tx)
  switch (route) {
    case 'GET /address/:address':
      return json(addressStats(address, chain, mempool))
    case 'GET /address/:address/utxo':
      return json(unspentOutputs(state, address))
    case 'GET /address/:address/txs/mempool':
      return json(mempool.slice(0, MEMPOOL_PAGE_SIZE).map(txJson))
    case 'GET /address/:address/txs/chain': {
      // An unparseable cursor is ignored, and one qbit-electrs cannot find yields `[]`.
      const lastSeen = cursor !== undefined && TXID_PATTERN.test(cursor) ? cursor.toLowerCase() : undefined
      return json(after(chain, lastSeen, CHAIN_PAGE_SIZE).map(txJson))
    }
    default:
      return combinedHistory(state, chain, mempool, cursor)
  }
}

/**
 * qbit-electrs's combined route, which mempool-qbit passes through: a page of
 * up to 50 rows, mempool rows first. A cursor that is the last mempool row is
 * passed on to the chain history, where it is not found, so the page is
 * empty; a cursor found nowhere is an error.
 */
function combinedHistory(state: State, chain: TxRecord[], mempool: TxRecord[], cursor: string | undefined): Response {
  const id = cursor?.toLowerCase()
  if (id !== undefined && !mempool.some(tx => tx.txid === id)) {
    if (!chain.some(tx => tx.txid === id)) {
      return state.backend === 'esplora'
        ? text(422, 'after_txid not found')
        : text(500, JSON.stringify({ error: 'Failed to get address transactions' }), {
            'content-type': 'application/json',
          })
    }
    return json(after(chain, id, MEMPOOL_PAGE_SIZE).map(txJson))
  }
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

function addressStats(address: string, chain: TxRecord[], mempool: TxRecord[]): EsploraAddressStats {
  const part = (txs: TxRecord[]): EsploraChainStats => {
    const funded = txs.flatMap(tx => tx.vout.filter(output => output.address === address))
    const spent = txs.flatMap(tx => tx.vin.filter(input => input.prevout?.address === address))
    return {
      funded_txo_count: funded.length,
      funded_txo_sum: funded.reduce((sum, output) => sum + output.value, 0),
      spent_txo_count: spent.length,
      spent_txo_sum: spent.reduce((sum, input) => sum + input.prevout!.value, 0),
      tx_count: txs.length,
    }
  }
  return { address, chain_stats: part(chain), mempool_stats: part(mempool) }
}

/** The address's outputs that no fixture transaction spends, confirmed or not, in fixture order. */
function unspentOutputs(state: State, address: string): EsploraUtxo[] {
  const fixture = [...state.txs.values()].filter(tx => tx.inAddressViews)
  const spent = new Set(fixture.flatMap(tx => tx.vin.map(input => `${input.txid}:${input.vout}`)))
  return fixture.flatMap(tx =>
    tx.vout.flatMap((output, vout) =>
      output.address === address && !spent.has(`${tx.txid}:${vout}`)
        ? [{ txid: tx.txid, vout, value: output.value, status: txStatus(tx) }]
        : []
    )
  )
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

function txJson(tx: TxRecord): EsploraTx {
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
    value: output.value,
  }
}

// ---------------------------------------------------------------------------
// Broadcast
// ---------------------------------------------------------------------------

/**
 * One submission, as the node and qbit-electrs or mempool-qbit answer it.
 * Hex the node cannot decode is RPC error -22. Without a fault, the node
 * then judges the transaction as {@link nodeVerdict} says, and takes any it
 * does not refuse into its mempool. `POST /tx/push` reads the hex from a
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
    return rpcError(-22, 'TX decode failed')
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
 * qbit Core v1.0.0's verdict on a decoded submission, in the order
 * `sendrawtransaction` reaches it, or undefined when the node takes it or
 * already has it in its mempool. The node's coins are the outputs of the
 * transactions it knows, the fixture's and the submissions it took, less those
 * a confirmed transaction spends and those no transaction can spend.
 *
 * 1. `-27` while an output of the transaction itself is a coin and the
 *    transaction is in a block (`BroadcastTransaction` asks the chain's UTXO
 *    set, which a mempool spend does not change).
 * 2. A transaction in the mempool is answered with its txid.
 * 3. `-26 bad-txns-inputs-duplicate` for one that spends an output twice
 *    (`CheckTransaction`).
 * 4. `-25 bad-txns-inputs-missingorspent` for one that spends an output that
 *    is not a coin: unknown, spent in a block, or unspendable. A confirmed
 *    transaction whose outputs are all spent gets it too, since its own
 *    inputs are spent.
 * 5. `-26 insufficient fee` for one that spends an output a mempool
 *    transaction spends. Core takes such a conflict as a replacement when it
 *    passes `ReplacementChecks` (a higher feerate and more fees, among other
 *    things), and otherwise refuses it so, with the feerates or fees it
 *    compared appended; the mock never replaces.
 *
 * Scripts, signatures, amounts, fees and relay policy are not checked.
 */
function nodeVerdict(state: State, parsed: ParsedTx): Response | undefined {
  const spenders = new Map<string, TxRecord[]>()
  for (const tx of state.txs.values()) {
    for (const input of tx.vin) {
      const outpoint = `${input.txid}:${input.vout}`
      spenders.set(outpoint, [...(spenders.get(outpoint) ?? []), tx])
    }
  }
  const isCoin = (txid: string, vout: number): boolean => {
    const output = state.txs.get(txid)?.vout[vout]
    if (output === undefined || isUnspendable(output)) return false
    return !(spenders.get(`${txid}:${vout}`) ?? []).some(tx => tx.block !== undefined)
  }
  const known = state.txs.get(parsed.txid)
  if (known?.block !== undefined && parsed.vout.some((_, vout) => isCoin(parsed.txid, vout))) {
    return rpcError(-27, 'Transaction outputs already in utxo set')
  }
  if (known !== undefined && known.block === undefined) return undefined
  const outpoints = parsed.vin.map(input => `${input.txid}:${input.vout}`)
  if (new Set(outpoints).size !== outpoints.length) return rpcError(-26, 'bad-txns-inputs-duplicate')
  if (!parsed.vin.every(input => isCoin(input.txid, input.vout))) {
    return rpcError(-25, 'bad-txns-inputs-missingorspent')
  }
  if (outpoints.some(outpoint => (spenders.get(outpoint) ?? []).some(tx => tx.block === undefined))) {
    return rpcError(-26, `insufficient fee, rejecting replacement ${parsed.txid}`)
  }
  return undefined
}

/** qbit Core `CScript::IsUnspendable`: an `OP_RETURN` script, or one over MAX_SCRIPT_SIZE, which nothing can spend. */
function isUnspendable(output: OutputRecord): boolean {
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
    ? vin.reduce((sum, input) => sum + input.prevout!.value, 0)
    : undefined
  const outSum = vout.reduce((sum, output) => sum + output.value, 0)
  return {
    txid: parsed.txid,
    hex: hex.toLowerCase(),
    version: parsed.version,
    locktime: parsed.locktime,
    vin,
    vout,
    fee: inSum === undefined ? 0 : Math.max(0, inSum - outSum),
    size: parsed.size,
    weight: parsed.weight,
    block: undefined,
    inAddressViews: false,
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
  vout: { value: number; scriptPubKey: string }[]
  size: number
  weight: number
}

/** qbit Core `serialize.h` MAX_SIZE: the largest CompactSize `ReadCompactSize` accepts. */
const COMPACT_SIZE_MAX = 0x02000000
/** qbit Core `script.h` MAX_SCRIPT_SIZE, in bytes. */
const MAX_SCRIPT_SIZE = 10_000

/**
 * Decode a legacy or BIP144 transaction as qbit Core does, or return
 * undefined where Core's decoder fails: truncated or trailing bytes, an
 * unknown flag, a CompactSize that is non-canonical or above MAX_SIZE, or a
 * witness flag with every witness stack empty. The txid is the double SHA-256
 * of the witness-stripped encoding, as the client's `txidFromRawTx` computes
 * it.
 */
function parseRawTx(hex: string): ParsedTx | undefined {
  if (!HEX_PATTERN.test(hex)) return undefined
  const bytes = new Uint8Array(hex.length / 2)
  for (let i = 0; i < bytes.length; i += 1) bytes[i] = parseInt(hex.slice(2 * i, 2 * i + 2), 16)
  let offset = 0
  const take = (length: number): Uint8Array => {
    if (length > bytes.length - offset) throw new RangeError('truncated')
    offset += length
    return bytes.subarray(offset - length, offset)
  }
  const uint32 = (): number => take(4).reduce((sum, byte, i) => sum + byte * 2 ** (8 * i), 0)
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
  try {
    const version = uint32() | 0
    const witness = bytes.length - offset >= 2 && bytes[4] === 0x00
    if (witness) {
      if (bytes[5] !== 0x01) return undefined
      take(2)
    }
    const bodyStart = offset
    const vin = Array.from({ length: compactSize() }, () => {
      const txid = toHex(take(32).slice().reverse())
      const vout = uint32()
      const scriptsig = varBytes()
      return { txid, vout, scriptsig, witness: [] as string[], sequence: uint32() }
    })
    const vout = Array.from({ length: compactSize() }, () => {
      const value = uint32() + uint32() * 2 ** 32
      return { value, scriptPubKey: varBytes() }
    })
    const bodyEnd = offset
    if (witness) {
      for (const input of vin) input.witness = Array.from({ length: compactSize() }, varBytes)
      if (vin.every(input => input.witness.length === 0)) return undefined
    }
    const locktime = uint32()
    if (offset !== bytes.length) return undefined
    const stripped = witness
      ? Uint8Array.from([...bytes.subarray(0, 4), ...bytes.subarray(bodyStart, bodyEnd), ...bytes.subarray(-4)])
      : bytes
    return {
      txid: toHex(sha256(sha256(stripped)).reverse()),
      version,
      locktime,
      vin,
      vout,
      size: bytes.length,
      weight: stripped.length * 3 + bytes.length,
    }
  } catch {
    return undefined
  }
}

function toHex(bytes: Uint8Array): string {
  let hex = ''
  for (const byte of bytes) hex += byte.toString(16).padStart(2, '0')
  return hex
}

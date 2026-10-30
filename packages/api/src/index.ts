// @qbit-oss/api — typed esplora (electrs) REST client for qbit.
//
// Speaks the standard esplora REST surface directly (no facade), against a
// configurable per-chain base URL. Deliberately carries NONE of the legacy
// centralized surface: no asset/token endpoints, no remote wallet config, and
// no device-id / channel / client telemetry headers. The test suite enforces
// this by construction (see the guard in test/).

export { QbitApiError } from './errors'
export type { QbitApiErrorKind, QbitApiErrorOptions } from './errors'
export {
  addressBalanceFromStats,
  DEFAULT_MAX_FEE_RATE_SAT_VB,
  feeEstimatesFromMempoolRecommendedFees,
  feeTiersFromEstimates,
  txidFromRawTx,
} from './adapters'
export type { AddressBalance, FeeRateTier } from './adapters'
export { EsploraClient } from './esplora-client'
export type { EsploraClientOptions, QbitFetchCredentials } from './esplora-client'
export { MempoolQbitClient } from './mempool-qbit-client'
export type { MempoolQbitClientOptions } from './mempool-qbit-client'

// The response types stay declared in this entry module, not in a module of
// their own: src/testing.ts imports some of them from ./index, and the tsup DTS
// build would put a module both entry points use into a shared
// lib/types-<hash>.d.ts chunk instead of lib/index.d.ts.

// ---------------------------------------------------------------------------
// Esplora response types
// ---------------------------------------------------------------------------

/**
 * An address's totals over one part of its history, as esplora reports them:
 * its confirmed transactions (`chain_stats`) or its mempool transactions
 * (`mempool_stats`).
 *
 * @category Addresses
 */
export interface EsploraChainStats {
  /** Number of transaction outputs that pay to the address. */
  funded_txo_count: number
  /**
   * Total value of those outputs in satoshis. A total of everything received,
   * not a balance: see {@link addressBalanceFromStats}.
   */
  funded_txo_sum: number
  /** Number of the address's outputs that transactions spend. */
  spent_txo_count: number
  /**
   * Total value of those spent outputs in satoshis. A total of everything
   * spent, not a balance: see {@link addressBalanceFromStats}.
   */
  spent_txo_sum: number
  /** Number of distinct transactions that touch the address. */
  tx_count: number
}

/**
 * An address's confirmed and mempool totals, esplora's
 * `GET /address/:address` reply.
 *
 * @category Addresses
 */
export interface EsploraAddressStats {
  /** The address the totals are for, as the backend returned it. */
  address: string
  /** Totals over the address's confirmed transactions. */
  chain_stats: EsploraChainStats
  /** Totals over the address's unconfirmed (mempool) transactions. */
  mempool_stats: EsploraChainStats
}

/**
 * Whether a transaction is confirmed, and in which block, as esplora reports
 * it: the `GET /tx/:txid/status` reply and the `status` of transactions and
 * unspent outputs.
 *
 * @category Transactions
 */
export interface EsploraTxStatus {
  /** Whether the transaction is in a block. */
  confirmed: boolean
  /** Height of the block that contains the transaction, when it is confirmed. */
  block_height?: number
  /** Hash of that block, as hex, when the transaction is confirmed. */
  block_hash?: string
  /** Timestamp of that block in Unix seconds, when the transaction is confirmed. */
  block_time?: number
}

/**
 * An unspent output of an address, an entry of esplora's
 * `GET /address/:address/utxo` reply.
 *
 * @category Addresses
 */
export interface EsploraUtxo {
  /** Id of the transaction that created the output. */
  txid: string
  /** Index of the output in that transaction. */
  vout: number
  /**
   * Value of the output in satoshis, as the backend sent it.
   * {@link EsploraClient.getAddressUtxos} does not validate it: check that it
   * is a non-negative safe integer before using it.
   */
  value: number
  /** Whether the transaction that created the output is confirmed. */
  status: EsploraTxStatus
}

/**
 * A transaction input, as esplora reports it.
 *
 * @category Transactions
 */
export interface EsploraVin {
  /** Id of the transaction whose output the input spends. */
  txid: string
  /** Index of that output in its transaction. */
  vout: number
  /** The output the input spends, or `null` for a coinbase input. */
  prevout: EsploraVout | null
  /** The input's scriptSig, as hex. */
  scriptsig: string
  /** The input's scriptSig in assembly form. */
  scriptsig_asm: string
  /** The input's witness stack, each item as hex, when it has one. */
  witness?: string[]
  /** Whether this is a coinbase input. */
  is_coinbase: boolean
  /** The input's sequence number. */
  sequence: number
}

/**
 * A transaction output, as esplora reports it.
 *
 * @category Transactions
 */
export interface EsploraVout {
  /** The output's scriptPubKey, as hex. */
  scriptpubkey: string
  /** The output's scriptPubKey in assembly form. */
  scriptpubkey_asm: string
  /** The scriptPubKey's type, as the backend names it. */
  scriptpubkey_type: string
  /** The address the scriptPubKey pays to, when the backend gives one. */
  scriptpubkey_address?: string
  /** Value of the output in satoshis. */
  value: number
}

/**
 * A transaction, as esplora reports it.
 *
 * @category Transactions
 */
export interface EsploraTx {
  /** Transaction id, as hex. */
  txid: string
  /** Transaction version. */
  version: number
  /** The transaction's lock time. */
  locktime: number
  /** The transaction's inputs, in order. */
  vin: EsploraVin[]
  /** The transaction's outputs, in order. */
  vout: EsploraVout[]
  /** Serialized size in bytes. */
  size: number
  /** Weight in weight units. */
  weight: number
  /** Fee in satoshis. */
  fee: number
  /** Whether the transaction is confirmed, and in which block. */
  status: EsploraTxStatus
}

/**
 * Fee-rate estimates by confirmation target: esplora returns
 * `{ "<target_blocks>": <sat/vB> }`, e.g. `{ "1": 12.3, "6": 4.1 }`.
 * {@link feeTiersFromEstimates} validates them and sorts them into
 * {@link FeeRateTier}s.
 *
 * @category Fees
 */
export type EsploraFeeEstimates = Record<string, number>

/**
 * mempool-qbit retains mempool's field names, but the first three values come
 * from projected blocks 1, 2, and 3. Economy and minimum are policy floors,
 * not confirmation-target estimates.
 *
 * @remarks
 * {@link MempoolQbitClient.getFeeEstimates} maps the first three to targets
 * 1, 2 and 3; see
 * [Endpoints and clients](https://github.com/Qbit-Org/qbit-js/blob/main/packages/api/docs/endpoints.md).
 *
 * @category Fees
 */
export interface MempoolRecommendedFees {
  /** Fee rate in sat/vB from projected block 1. */
  fastestFee: number
  /** Fee rate in sat/vB from projected block 2. */
  halfHourFee: number
  /** Fee rate in sat/vB from projected block 3. */
  hourFee: number
  /** A policy floor in sat/vB, not a confirmation-target estimate. */
  economyFee: number
  /** A policy floor in sat/vB, not a confirmation-target estimate. */
  minimumFee: number
}

/**
 * An address's complete history, as `getAddressHistory` returns it, split by
 * confirmation status.
 *
 * @category Addresses
 */
export interface AddressHistory {
  /** Confirmed transactions, in the order the backend listed them. */
  confirmed: EsploraTx[]
  /** Unconfirmed (mempool) transactions, in the order the backend listed them. */
  mempool: EsploraTx[]
}

/**
 * Per-call cancellation and time budget. Both cover every dependent request of
 * the call — pagination, retries, backoff, and response-body reads.
 *
 * @remarks
 * See [Resilience](https://github.com/Qbit-Org/qbit-js/blob/main/packages/api/docs/resilience.md).
 *
 * @category Configuration
 */
export interface RequestOptions {
  /**
   * Aborting rejects the call with an `aborted` `QbitApiError` and stops further
   * requests; the
   * [outcome table](https://github.com/Qbit-Org/qbit-js/blob/main/packages/api/docs/broadcasting.md#outcomes) says when
   * `broadcastTx` rejects with `unknown_outcome` instead. An `aborted` error's
   * `cause` is the signal's reason; such an `unknown_outcome` carries the
   * `aborted` error as its `cause`.
   */
  signal?: AbortSignal
  /**
   * Overall budget for the call in ms; exceeding it rejects with a `timeout`
   * `QbitApiError`. The
   * [outcome table](https://github.com/Qbit-Org/qbit-js/blob/main/packages/api/docs/broadcasting.md#outcomes) says
   * when `broadcastTx` rejects with `unknown_outcome` instead.
   * It must be a positive number no greater than 2147483647; any other value
   * rejects the call with an `http` `QbitApiError` before a request is sent.
   */
  deadlineMs?: number
}

/**
 * Options for `getAddressHistory`: the call's cancellation and deadline, and
 * bounds on its scan.
 *
 * @remarks
 * See [Address history](https://github.com/Qbit-Org/qbit-js/blob/main/packages/api/docs/address-history.md).
 *
 * @category Addresses
 */
export interface AddressHistoryOptions extends RequestOptions {
  /**
   * Maximum history page fetches for the whole call, including the terminal
   * empty response and a rescan (default 256 on `EsploraClient`). The
   * address-stats reads are not page fetches, nor is `EsploraClient`'s
   * `/txs/mempool` fetch. On `MempoolQbitClient` it defaults to, and can lower
   * but not raise, the constructor's `maxAddressHistoryPages`. Omitted or
   * `null`, it takes the default; any other value that is not a positive safe
   * integer rejects with an `http` `QbitApiError`.
   */
  maxPages?: number
  /**
   * Maximum raw transaction rows accepted for the whole call, a rescan
   * included, before failing closed (default 6,400). Omitted or `null`, it
   * takes the default; any other value that is not a positive safe integer
   * rejects with an `http` `QbitApiError`.
   */
  maxTransactions?: number
}

/**
 * Options for `broadcastTx`: the call's cancellation and deadline, and the
 * transaction id.
 *
 * @remarks
 * See [Broadcasting](https://github.com/Qbit-Org/qbit-js/blob/main/packages/api/docs/broadcasting.md).
 *
 * @category Transactions
 */
export interface BroadcastTxOptions extends RequestOptions {
  /**
   * Transaction id (64 hex characters) of `rawTxHex`. Derived from the hex when
   * omitted; when both are available they must agree. A value that is not 64
   * hex characters, or that disagrees with the hex, rejects the call with a
   * `TypeError` before anything is sent.
   */
  txid?: string
}

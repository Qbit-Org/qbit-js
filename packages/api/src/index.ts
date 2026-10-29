// @qbit-oss/api — typed esplora (electrs) REST client for qbit.
//
// Speaks the standard esplora REST surface directly (no facade), against a
// configurable per-chain base URL. Deliberately carries NONE of the legacy
// centralized surface: no asset/token endpoints, no remote wallet config, and
// no device-id / channel / client telemetry headers. The test suite enforces
// this by construction (see the guard in test/).

import { sha256 } from '@noble/hashes/sha2'

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

// ---------------------------------------------------------------------------
// Error taxonomy (user-presentable)
// ---------------------------------------------------------------------------

/**
 * What went wrong, as {@link QbitApiError.kind} reports it:
 *
 * - `rate_limit`: an HTTP 429 reply the client stopped retrying.
 * - `payload_too_large`: an HTTP 413 reply.
 * - `not_found`: an HTTP 404 reply.
 * - `http`: any other non-2xx reply, a refused redirect, a submission the node
 *   rejected, an invalid `baseUrl` or numeric constructor option, or an
 *   invalid `deadlineMs`, `maxPages` or `maxTransactions`. An invalid
 *   `fetchFn` is `network` instead, and invalid `broadcastTx` and
 *   `feeTiersFromEstimates` arguments are `TypeError`s.
 * - `network`: fetch threw (offline, DNS, CORS), or no fetch implementation
 *   was available.
 * - `timeout`: an attempt exceeded `timeoutMs`, or the call's `deadlineMs`
 *   expired.
 * - `aborted`: the call's or the client's `AbortSignal` fired.
 * - `parse`: a body was not the expected JSON or text, could not be read, or
 *   failed the client's validation.
 * - `pagination_limit`: a history scan exceeded its page or transaction bound.
 * - `invalid_cursor`: an address-history scan could not be shown complete
 *   (retry it later), or a `MempoolQbitClient.getAddressTxs` cursor is stale,
 *   unrelated or unconfirmed.
 * - `unknown_outcome`: a submission may have reached the node. Resubmitting
 *   the same hex is harmless; never rebuild the payment with different inputs.
 *   See
 *   [Broadcasting](https://github.com/Qbit-Org/qbit-js/blob/main/packages/api/docs/broadcasting.md#recovering-from-an-unknown-outcome).
 *
 * An error from another version of this package can carry a kind this version
 * does not list, so keep a default branch when switching on it.
 *
 * @remarks
 * See [Resilience](https://github.com/Qbit-Org/qbit-js/blob/main/packages/api/docs/resilience.md).
 *
 * @category Errors
 */
export type QbitApiErrorKind =
  | 'rate_limit' // HTTP 429
  | 'payload_too_large' // HTTP 413
  | 'not_found' // HTTP 404
  | 'http' // other non-2xx
  | 'network' // fetch threw (offline / DNS / CORS)
  | 'timeout' // request or call deadline expired
  | 'aborted' // caller's AbortSignal fired
  | 'parse' // body was not the expected JSON/text
  | 'pagination_limit' // history scan exceeded its configured page or transaction bound
  | 'invalid_cursor' // an address-history scan could not be shown complete; retry it
  | 'unknown_outcome' // a submission may have reached the node; see docs/broadcasting.md

/**
 * Optional fields of a new {@link QbitApiError}. Each one given is copied to the
 * error's property of the same name, except `unredactedCause`.
 *
 * @category Errors
 */
export interface QbitApiErrorOptions {
  /** The error's {@link QbitApiError.status}. */
  status?: number
  /** The error's {@link QbitApiError.url}. */
  url?: string
  /** The error's {@link QbitApiError.cause}. */
  cause?: unknown
  /**
   * The underlying error before redaction. It is kept off the error object:
   * read it with `QbitApiError.unredactedCause(error)`.
   */
  unredactedCause?: unknown
  /** The error's {@link QbitApiError.retryAfterMs}. */
  retryAfterMs?: number
  /**
   * Trimmed response body preview, capped at 200 characters. Errors the client
   * creates redact the base URL from it as they do in `message`.
   */
  responseBody?: string
  /** Transaction id of the submission an `unknown_outcome` error refers to, when known. */
  txid?: string
}

/** Underlying errors before redaction, by the `QbitApiError` that carries their redacted copy. */
const unredactedCauses = new WeakMap<object, unknown>()

/** Brand shared by every copy of this class: `Symbol.for` keys are global across builds and realms. */
const QBIT_API_ERROR_BRAND = Symbol.for('qbit-js.QbitApiError')

/**
 * The error the clients and adapters throw for a failed request, a reply they
 * reject, or an invalid constructor option, `deadlineMs`, `maxPages` or
 * `maxTransactions`, classified by {@link QbitApiError.kind}. Its `name` is
 * `'QbitApiError'`.
 *
 * Recognize it with {@link QbitApiError.is} rather than `instanceof`, which is
 * false for an error from another copy of this package (the other build, or
 * another version).
 *
 * @remarks
 * Errors the client creates redact the base URL from `url`, `message` and
 * `responseBody`, and attach underlying errors as a redacted `cause`, with the
 * exceptions {@link QbitApiError.cause} lists; see
 * [Logging errors](https://github.com/Qbit-Org/qbit-js/blob/main/packages/api/docs/logging-and-redaction.md).
 * The kinds, and which failures are retried, are in
 * [Resilience](https://github.com/Qbit-Org/qbit-js/blob/main/packages/api/docs/resilience.md).
 *
 * @category Errors
 */
export class QbitApiError extends Error {
  /**
   * What went wrong; see {@link QbitApiErrorKind}. An error from another
   * version of this package can carry a kind this version does not list.
   */
  readonly kind: QbitApiErrorKind
  /** HTTP status of the reply the error is about, when there was one. */
  readonly status?: number
  /**
   * URL of the request the error is about, when the error names one. Errors
   * the client creates show the base URL as its origin, followed by `/...` in
   * place of any path, then the endpoint path, e.g.
   * `https://host/.../blocks/tip/height`.
   */
  readonly url?: string
  /**
   * The reply's `Retry-After` header in ms, as the client parsed it
   * (delta-seconds or an HTTP date), on the errors the client builds from a
   * reply's status, such as `rate_limit`, when the reply carried one.
   */
  readonly retryAfterMs?: number
  /**
   * The underlying error. Errors the client creates attach a redacted copy,
   * safe to log: see `QbitApiError.unredactedCause`. A JSON `parse` error's
   * cause is a generic `SyntaxError` instead. Two causes are passed through
   * unchanged: an `aborted` error's, which is the signal's reason, and a
   * `QbitApiError`, such as one a custom `fetchFn` threw.
   */
  readonly cause?: unknown
  /**
   * Trimmed response body preview, capped at 200 characters. Errors the client
   * creates redact the base URL from it as they do in `message`, but do not
   * escape control characters in it.
   */
  readonly responseBody?: string
  /**
   * On an `unknown_outcome` error, the transaction id of the submission, when
   * known: one was supplied or could be derived from the hex. See
   * [Recovering from an unknown outcome](https://github.com/Qbit-Org/qbit-js/blob/main/packages/api/docs/broadcasting.md#recovering-from-an-unknown-outcome).
   */
  readonly txid?: string

  /**
   * The underlying error of `error` as the fetch implementation threw it, or
   * undefined. Its message, stack and properties can contain the full request
   * URL, base-URL secrets included, so it is kept off the error object, where
   * no logger, error reporter or serializer can reach it. Do not log it where
   * the base URL is secret. It is only found for an error from this copy of
   * the package.
   *
   * @param error - Any value; an error from this copy of the package that has
   *   an unredacted cause yields it.
   * @returns The unredacted underlying error, or undefined.
   */
  static unredactedCause(error: unknown): unknown {
    return typeof error === 'object' && error !== null ? unredactedCauses.get(error) : undefined
  }

  /**
   * Whether `value` is a `QbitApiError` (or a subclass instance) from any copy
   * of `@qbit-oss/api`. `instanceof` only recognizes errors from the same copy,
   * so it is false when an app loads both the CommonJS and the ESM build (or
   * two installed versions) and the error comes from the other one. This checks
   * a brand, `Symbol.for('qbit-js.QbitApiError')`, set on the class prototype
   * instead. It identifies the class, not where the error came from: any code
   * can set the brand. An error from another version can carry a `kind` this
   * version does not list, so keep a default branch when switching on it.
   *
   * @param value - Any value, typically a caught error.
   * @returns True when `value` carries the `QbitApiError` brand.
   *
   * @example
   * ```ts
   * try {
   *   await client.getAddressBalance(address)
   * } catch (error) {
   *   if (!QbitApiError.is(error)) throw error
   *   switch (error.kind) {
   *     case 'parse':
   *       // The backend's reply failed validation; see the Response validation page.
   *       break
   *     case 'rate_limit':
   *       // error.retryAfterMs is the server's Retry-After, when it sent one.
   *       break
   *     default:
   *       // Every other kind, including any a newer version adds.
   *       throw error
   *   }
   * }
   * ```
   */
  static is(value: unknown): value is QbitApiError {
    return (
      typeof value === 'object' && value !== null && (value as Record<symbol, unknown>)[QBIT_API_ERROR_BRAND] === true
    )
  }

  /**
   * Creates an error of `kind`. A custom `fetchFn` can throw one; how the
   * client passes it on is described under {@link EsploraClientOptions.fetchFn}.
   *
   * @param kind - What went wrong.
   * @param message - The error message, used as given.
   * @param options - Optional fields, copied to the properties of the same
   *   name; `unredactedCause` is kept off the error object.
   */
  constructor(kind: QbitApiErrorKind, message: string, options: QbitApiErrorOptions = {}) {
    super(message)
    this.name = 'QbitApiError'
    this.kind = kind
    if (options.status !== undefined) this.status = options.status
    if (options.url !== undefined) this.url = options.url
    if (options.retryAfterMs !== undefined) this.retryAfterMs = options.retryAfterMs
    if (options.cause !== undefined) this.cause = options.cause
    if (options.unredactedCause !== undefined) unredactedCauses.set(this, options.unredactedCause)
    if (options.responseBody !== undefined) this.responseBody = options.responseBody
    if (options.txid !== undefined) this.txid = options.txid
  }
}

Object.defineProperty(QbitApiError.prototype, QBIT_API_ERROR_BRAND, { value: true })

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

/**
 * Fetch credential policy, the values of the DOM's `RequestCredentials`.
 * Declared here so the published types compile without the DOM lib, which
 * `@types/node` does not provide this name from.
 *
 * @category Configuration
 */
export type QbitFetchCredentials = 'omit' | 'same-origin' | 'include'

/**
 * Options for the {@link EsploraClient} and {@link MempoolQbitClient}
 * constructors. The constructor throws an `http` {@link QbitApiError} for an
 * invalid `baseUrl` or an out-of-range option instead of storing it.
 * `timeoutMs`, `retries`, `retryBaseDelayMs` and `maxRetryAfterMs` reject
 * `null`; only an omitted option takes its default.
 *
 * @remarks
 * See [Configuration](https://github.com/Qbit-Org/qbit-js/blob/main/packages/api/docs/configuration.md) and
 * [Redirects and transport security](https://github.com/Qbit-Org/qbit-js/blob/main/packages/api/docs/transport-security.md).
 *
 * @category Configuration
 */
export interface EsploraClientOptions {
  /**
   * Base URL for the esplora endpoint, e.g. `https://blockstream.info/testnet/api`.
   * It must be an absolute `http(s)` URL without whitespace, control or format
   * characters, backslashes, credentials, a query or a fragment, since
   * endpoint paths are appended to it; trailing slashes are dropped. A plain
   * `http` URL also needs a loopback host or `allowInsecureHttp`.
   */
  baseUrl: string
  /**
   * Accept a plain `http:` baseUrl on a non-loopback host (default false).
   * Without TLS, request headers such as API keys and every response are
   * exposed to the network. `localhost`, `127.0.0.0/8` and `[::1]` are always
   * accepted.
   */
  allowInsecureHttp?: boolean
  /**
   * Custom fetch (defaults to global fetch). It should honour
   * `redirect: 'manual'`; a reply it reports as `redirected`, or whose `url`
   * is not the requested URL (another scheme, host, port, path or query), is
   * refused, but only after the redirected request was sent. A `QbitApiError`
   * it throws, from any copy of this package (see `QbitApiError.is`),
   * propagates as it is, or as the `cause` of an `unknown_outcome` from a
   * submission that may have been sent. One from another copy is judged by its
   * public fields only, since that copy keeps the original cause and response
   * body to itself: on a submission, its `network` error never proves that
   * nothing was sent, and its response body never triggers the `/tx/push`
   * fallback.
   *
   * The client cannot tell whether a submission's POST was sent before such
   * an error was thrown, so it takes the error at its word. A kind other than
   * `network`, `timeout` or `aborted` propagates as it is: an `http`,
   * `not_found`, `payload_too_large` or `rate_limit` then reads as a submission
   * that was not accepted, and one that matches a `/tx/push` row of the
   * [outcome table](https://github.com/Qbit-Org/qbit-js/blob/main/packages/api/docs/broadcasting.md#outcomes)
   * makes `MempoolQbitClient` submit again. A `network` error from this copy
   * whose original cause is a connection failure before anything was sent is
   * retried, which re-sends the POST. So throw a `QbitApiError` only when
   * nothing was sent; once the request may have been sent, return the reply
   * or throw the underlying error, and let the client classify the failure.
   */
  fetchFn?: typeof fetch
  /** Fetch credential policy (default `omit`). */
  credentials?: QbitFetchCredentials
  /**
   * Per-request timeout in ms (default 15000; an integer from 1 to
   * 2147483647). It covers each attempt's response headers and its whole body.
   */
  timeoutMs?: number
  /**
   * Retry attempts after the first (default 2; an integer from 0 to 10).
   * Reads retry only network errors, attempts that timed out, and HTTP 429,
   * 500, 502, 503 and 504 replies; every other non-2xx status, 501, 505, 507
   * and 511 included, fails at once. Submissions repeat only attempts that
   * provably were not processed (a 429 within `maxRetryAfterMs`, or a
   * connection failure before anything was sent); see the
   * [outcome table](https://github.com/Qbit-Org/qbit-js/blob/main/packages/api/docs/broadcasting.md#outcomes).
   */
  retries?: number
  /**
   * Base backoff in ms (default 300; a finite number from 0 to 2147483647).
   * It doubles with each attempt, up to 2147483647 ms. When a reply's status
   * is what is retried, its `Retry-After`, if accepted, replaces it.
   */
  retryBaseDelayMs?: number
  /**
   * Longest server-requested `Retry-After` delay the client will sleep before
   * retrying, in ms (default 30000; an integer from 0 to 2147483647). A longer
   * request is not slept on: a read's 429 (`rate_limit`) or its 500, 502, 503
   * or 504 (`http`) is thrown at once with `retryAfterMs` set, unless its body
   * could not be read, which throws `parse` without `retryAfterMs`. A submission's
   * 429 is not re-sent then, and is judged by its body first, as the
   * [outcome table](https://github.com/Qbit-Org/qbit-js/blob/main/packages/api/docs/broadcasting.md#outcomes) says.
   */
  maxRetryAfterMs?: number
  /**
   * Extra request headers, copied when the client is constructed and sent with
   * every request. UDID/telemetry headers are intentionally unsupported.
   */
  headers?: Record<string, string>
  /**
   * Sleep function (injectable for tests); defaults to an abortable setTimeout.
   * Receives the call's signal; the client stops waiting on abort either way.
   */
  sleepFn?: (ms: number, signal?: AbortSignal) => Promise<void>
  /** Cancels every in-flight and future call on this client when aborted. */
  signal?: AbortSignal
}

/**
 * Options for the {@link MempoolQbitClient} constructor: those of
 * {@link EsploraClientOptions}, and a bound on its combined-history requests.
 *
 * @category Configuration
 */
export interface MempoolQbitClientOptions extends EsploraClientOptions {
  /**
   * Maximum combined-history requests fetched per call (default 256), by
   * `getAddressHistory`, `getAddressTxs` and `getAddressMempoolTxs`. Unless it
   * is omitted or `null`, it must be a positive safe integer, or the
   * constructor throws an `http` `QbitApiError`.
   */
  maxAddressHistoryPages?: number
}

const TRANSIENT_STATUSES = new Set([429, 500, 502, 503, 504])
const IDEMPOTENT_METHODS = new Set(['GET', 'HEAD'])
/** 5xx replies that mean the server did not process the request at all. */
const UNPROCESSED_SERVER_ERROR_STATUSES = new Set([501, 505, 511])
/** Error codes that only occur before a connection exists, so nothing was sent. */
const PRE_CONNECTION_ERROR_CODES = new Set(['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'UND_ERR_CONNECT_TIMEOUT'])
/** Route errors that are pre-send only from the connect syscall; later ones can follow a written request. */
const CONNECT_STAGE_ERROR_CODES = new Set(['EHOSTUNREACH', 'ENETUNREACH'])
/**
 * String codes a backend relays when its own node call fails: Node system and
 * internal errors (`ETIMEDOUT`, `ECONNRESET`, `ERR_STREAM_PREMATURE_CLOSE`),
 * undici (`UND_ERR_*`) and http-parser (`HPE_*`) errors. Other strings are
 * gateway or application codes that say nothing about the node call.
 */
const TRANSPORT_ERROR_CODE_PATTERN = /^(?:E[A-Z0-9_]+|UND_ERR_[A-Z0-9_]+|HPE_[A-Z0-9_]+)$/
const TXID_PATTERN = /^[0-9a-f]{64}$/
const DEFAULT_MAX_ADDRESS_HISTORY_PAGES = 256
const DEFAULT_MAX_ADDRESS_HISTORY_TRANSACTIONS = 6_400
const DEFAULT_MAX_RETRY_AFTER_MS = 30_000
/** setTimeout stores its delay as a signed 32-bit int; larger values fire after ~1 ms. */
const MAX_TIMER_DELAY_MS = 2_147_483_647
const MAX_RETRIES = 10

const UNSAFE_BASE_URL_CHAR = /[\s\p{Cc}\\?#]|(?![\u200c\u200d])[\p{Cf}\p{Default_Ignorable_Code_Point}]/u

function validBaseUrl(value: unknown, allowInsecureHttp: boolean | undefined): string {
  // Paths are appended to the raw string, so a query or fragment would swallow
  // them. new URL() silently strips whitespace and C0 controls, turns
  // backslashes into slashes (`/api\` would request `/api//...`), and
  // percent-encodes C1 controls (U+0080-U+009F), format characters and other
  // default-ignorable code points (e.g. U+00AD, U+200B, U+FE0F, U+034F) into a
  // different path, or drops them from the host.
  // fetch rejects credentials. Other non-ASCII stays valid: IDN hosts map to
  // punycode and path characters get their standard UTF-8 percent-encoding.
  // ZWNJ/ZWJ (U+200C/U+200D) are exempt in the host because they are
  // significant in some IDN labels (new URL() rejects them where IDNA does not
  // allow them); in the path they are invisible and rejected like the rest.
  // The parts are read with `schemeAndHost`, as React Native's URL getters
  // throw before 0.80 and misread the host from 0.80; where the runtime's URL
  // parser follows the URL Standard, it must also accept the URL.
  const invalid = () =>
    new QbitApiError(
      'http',
      'baseUrl must be an absolute http(s) URL without whitespace, control or format characters, backslashes, credentials, query or fragment'
    )
  if (typeof value !== 'string' || UNSAFE_BASE_URL_CHAR.test(value)) throw invalid()
  if (followsUrlStandard() && standardHref(value) === undefined) throw invalid()
  const url = schemeAndHost(value)
  if (
    !url ||
    (url.protocol !== 'http:' && url.protocol !== 'https:') ||
    !url.hostname ||
    url.userinfo ||
    !/^\d*$/.test(url.port) ||
    Number(url.port) > 65535 ||
    /%E2%80%8[CD]|[\u200c\u200d]/i.test(url.path)
  ) {
    throw invalid()
  }
  // Plain http exposes request headers (API keys) and every response to the
  // network; loopback is exempt for local and regtest backends.
  if (url.protocol === 'http:' && allowInsecureHttp !== true && !isLoopbackHostname(url.hostname)) {
    throw new QbitApiError(
      'http',
      'baseUrl must use https unless its host is loopback; pass allowInsecureHttp: true to allow plain http'
    )
  }
  return value.replace(/\/+$/, '')
}

function integerOption(
  value: number | undefined,
  defaultValue: number,
  name: keyof EsploraClientOptions,
  min: number,
  max: number
): number {
  // Only an omitted option takes the default; an explicit null is invalid.
  const option = value === undefined ? defaultValue : value
  if (!Number.isInteger(option) || option < min || option > max) {
    throw new QbitApiError('http', `${name} must be an integer from ${min} to ${max}`)
  }
  return option
}

function retryBaseDelayOption(value: number | undefined): number {
  const delay = value === undefined ? 300 : value
  if (typeof delay !== 'number' || !Number.isFinite(delay) || delay < 0 || delay > MAX_TIMER_DELAY_MS) {
    throw new QbitApiError('http', `retryBaseDelayMs must be a finite number from 0 to ${MAX_TIMER_DELAY_MS}`)
  }
  return delay
}

function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortErrorFor(signal))
      return
    }
    const onAbort = () => {
      clearTimeout(timer)
      reject(abortErrorFor(signal!))
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

// ---------------------------------------------------------------------------
// Operation scope: one signal per public call, carried through every
// dependent request, retry, and backoff.
// ---------------------------------------------------------------------------

/**
 * Signals created by this module, always aborted with the `QbitApiError` the
 * call rejects with. Any other signal belongs to a caller, whose reason is
 * only ever a cause, even when it is an error this module returned earlier.
 */
const internalSignals = new WeakSet<AbortSignal>()

function internalAbortController(): AbortController {
  const controller = new AbortController()
  internalSignals.add(controller.signal)
  return controller
}

/** The `QbitApiError` an aborted signal stands for: a deadline or caller cancellation. */
function abortErrorFor(signal: AbortSignal): QbitApiError {
  const reason: unknown = signal.reason
  // `instanceof`, not `QbitApiError.is`: only this module aborts its internal
  // signals, always with its own errors.
  if (internalSignals.has(signal) && reason instanceof QbitApiError) return reason
  return new QbitApiError('aborted', `request aborted by caller${formatErrorCause(reason)}`, {
    cause: reason,
  })
}

interface OperationScope {
  signal: AbortSignal
  dispose(): void
}

function openOperationScope(sources: (AbortSignal | undefined)[], deadlineMs: number | undefined): OperationScope {
  if (
    deadlineMs !== undefined &&
    !(Number.isFinite(deadlineMs) && deadlineMs > 0 && deadlineMs <= MAX_TIMER_DELAY_MS)
  ) {
    throw new QbitApiError('http', `deadlineMs must be a positive number no greater than ${MAX_TIMER_DELAY_MS}`)
  }

  const controller = internalAbortController()
  const cleanups: (() => void)[] = []
  const dispose = () => {
    for (const cleanup of cleanups) cleanup()
    cleanups.length = 0
  }
  const abort = (error: QbitApiError) => {
    if (controller.signal.aborted) return
    controller.abort(error)
    dispose()
  }

  for (const source of sources) {
    if (source === undefined) continue
    if (source.aborted) {
      abort(abortErrorFor(source))
      break
    }
    const onAbort = () => abort(abortErrorFor(source))
    source.addEventListener('abort', onAbort, { once: true })
    cleanups.push(() => source.removeEventListener('abort', onAbort))
  }
  if (deadlineMs !== undefined && !controller.signal.aborted) {
    const timer = setTimeout(
      () => abort(new QbitApiError('timeout', `operation exceeded its ${deadlineMs}ms deadline`)),
      deadlineMs
    )
    cleanups.push(() => clearTimeout(timer))
  }

  if (controller.signal.aborted) {
    dispose()
    throw abortErrorFor(controller.signal)
  }
  return { signal: controller.signal, dispose }
}

/** Settle with `promise`, or reject as soon as `signal` aborts, whichever is first. */
function raceAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(abortErrorFor(signal))
    if (signal.aborted) onAbort()
    else signal.addEventListener('abort', onAbort, { once: true })
    promise.then(
      value => {
        signal.removeEventListener('abort', onAbort)
        resolve(value)
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort)
        reject(error)
      }
    )
  })
}

interface InflightRequest {
  response: Promise<Response>
  consumers: number
  /** Aborts the shared request once every consumer has abandoned it. */
  controller: AbortController
}

/**
 * Typed client for an esplora (electrs) REST backend, at a configurable base
 * URL.
 *
 * Every method takes a final {@link RequestOptions} argument, `{ signal,
 * deadlineMs }`, that cancels the call or bounds its duration across every
 * request it makes. Reads are retried on transient failures, and concurrent
 * identical reads share one request; a submission (`broadcastTx`) is never
 * re-sent once it may have reached the node. A failed request, or a reply a
 * method rejects, rejects the call with a {@link QbitApiError}, and so does an
 * invalid `deadlineMs` (as `http`), before any request is sent.
 *
 * The raw endpoint methods (`getAddressStats`, `getAddressUtxos`,
 * `getAddressTxs`, `getAddressMempoolTxs`, `getTx`, `getTxStatus`,
 * `getFeeEstimates`) return the backend's JSON without checking its shape or
 * values. `getAddressBalance`, `getAddressHistory`, `getFeeTiers` and
 * `getTxHex` validate what they return.
 *
 * For a mempool-qbit backend, use {@link MempoolQbitClient}.
 *
 * @remarks
 * See [Endpoints and clients](https://github.com/Qbit-Org/qbit-js/blob/main/packages/api/docs/endpoints.md),
 * [Configuration](https://github.com/Qbit-Org/qbit-js/blob/main/packages/api/docs/configuration.md) and
 * [Resilience](https://github.com/Qbit-Org/qbit-js/blob/main/packages/api/docs/resilience.md).
 *
 * @category Clients
 */
export class EsploraClient {
  /** As configured, without trailing slashes. It can carry secrets: errors show `errorUrl(path)`. */
  protected readonly baseUrl: string
  private readonly fetchFn: typeof fetch
  private readonly timeoutMs: number
  private readonly retries: number
  private readonly retryBaseDelayMs: number
  private readonly maxRetryAfterMs: number
  private readonly headers: Record<string, string>
  private readonly credentials: QbitFetchCredentials
  private readonly sleepFn: (ms: number, signal?: AbortSignal) => Promise<void>
  private readonly signal: AbortSignal | undefined
  /** In-flight GET de-dup: concurrent identical GETs share one request. */
  private readonly inflight = new Map<string, InflightRequest>()

  /**
   * Creates a client for the esplora backend at `options.baseUrl`. It sends no
   * request until a method is called.
   *
   * @param options - The backend's base URL, and transport, timeout and retry
   *   settings.
   * @throws {@link QbitApiError} `http` when `baseUrl` is missing or not an
   *   accepted URL, or `timeoutMs`, `retries`, `retryBaseDelayMs` or
   *   `maxRetryAfterMs` is out of range; `network` when `fetchFn` is given and
   *   is not a function, or when it is omitted (`undefined` or `null`) and the
   *   global `fetch` is not one.
   *
   * @example
   * ```ts
   * import { EsploraClient } from '@qbit-oss/api'
   *
   * const client = new EsploraClient({
   *   baseUrl: 'https://esplora.example/regtest/api',
   *   timeoutMs: 10_000, // per attempt, headers and body
   * })
   * ```
   */
  constructor(options: EsploraClientOptions) {
    if (!options.baseUrl) {
      throw new QbitApiError('http', 'EsploraClient requires a baseUrl')
    }
    const baseUrl = validBaseUrl(options.baseUrl, options.allowInsecureHttp)
    const timeoutMs = integerOption(options.timeoutMs, 15000, 'timeoutMs', 1, MAX_TIMER_DELAY_MS)
    const retries = integerOption(options.retries, 2, 'retries', 0, MAX_RETRIES)
    const retryBaseDelayMs = retryBaseDelayOption(options.retryBaseDelayMs)
    const maxRetryAfterMs = integerOption(
      options.maxRetryAfterMs,
      DEFAULT_MAX_RETRY_AFTER_MS,
      'maxRetryAfterMs',
      0,
      MAX_TIMER_DELAY_MS
    )
    const fetchImpl = options.fetchFn ?? globalThis.fetch
    if (typeof fetchImpl !== 'function') {
      throw new QbitApiError('network', 'no fetch implementation available; pass options.fetchFn')
    }
    this.baseUrl = baseUrl
    this.fetchFn = options.fetchFn ? fetchImpl : fetchImpl.bind(globalThis)
    this.timeoutMs = timeoutMs
    this.retries = retries
    this.retryBaseDelayMs = retryBaseDelayMs
    this.maxRetryAfterMs = maxRetryAfterMs
    this.headers = { ...(options.headers ?? {}) }
    this.credentials = options.credentials ?? 'omit'
    this.sleepFn = options.sleepFn ?? defaultSleep
    this.signal = options.signal
  }

  // --- esplora endpoints -------------------------------------------------

  /**
   * An address's confirmed and mempool totals, from `GET /address/:address`.
   * The reply is returned as parsed, without checking its shape or values;
   * {@link EsploraClient.getAddressBalance} validates them.
   *
   * @param address - The address, URL-encoded into the path.
   * @param options - Cancellation and deadline for the call.
   * @returns The parsed reply.
   * @throws {@link QbitApiError} when the request fails (`not_found`,
   *   `rate_limit`, `payload_too_large` or `http` for a non-2xx reply or a
   *   refused redirect; `network`; `timeout`; `aborted`), or `parse` when the
   *   reply is not JSON or cannot be read.
   */
  getAddressStats(address: string, options?: RequestOptions): Promise<EsploraAddressStats> {
    return this.getJson<EsploraAddressStats>(`/address/${encodeURIComponent(address)}`, options)
  }

  /**
   * An address's unspent outputs, from `GET /address/:address/utxo`. The reply
   * is returned as parsed, without checking its shape or values: check that
   * each `value` is a non-negative safe integer before summing them.
   *
   * @param address - The address, URL-encoded into the path.
   * @param options - Cancellation and deadline for the call.
   * @returns The parsed reply.
   * @throws {@link QbitApiError} when the request fails (`not_found`,
   *   `rate_limit`, `payload_too_large` or `http` for a non-2xx reply or a
   *   refused redirect; `network`; `timeout`; `aborted`), or `parse` when the
   *   reply is not JSON or cannot be read.
   */
  getAddressUtxos(address: string, options?: RequestOptions): Promise<EsploraUtxo[]> {
    return this.getJson<EsploraUtxo[]>(`/address/${encodeURIComponent(address)}/utxo`, options)
  }

  /**
   * Confirmed transaction history for an address, newest first, 25 per page.
   * Pass the last txid of the previous page as `afterTxid` to paginate.
   *
   * One request to `GET /address/:address/txs/chain[/:afterTxid]`, whose reply
   * is returned as parsed, without checking its shape or values. An empty page
   * does not prove the history complete: electrs answers a cursor it does not
   * know with `[]`. {@link EsploraClient.getAddressHistory} returns a history
   * checked against the address stats.
   *
   * @param address - The address, URL-encoded into the path.
   * @param afterTxid - The last txid of the previous page; omit it for the
   *   first page.
   * @param options - Cancellation and deadline for the call.
   * @returns The parsed page.
   * @throws {@link QbitApiError} when the request fails (`not_found`,
   *   `rate_limit`, `payload_too_large` or `http` for a non-2xx reply or a
   *   refused redirect; `network`; `timeout`; `aborted`), or `parse` when the
   *   reply is not JSON or cannot be read.
   */
  getAddressTxs(address: string, afterTxid?: string, options?: RequestOptions): Promise<EsploraTx[]> {
    const suffix = afterTxid ? `/${encodeURIComponent(afterTxid)}` : ''
    return this.getJson<EsploraTx[]>(`/address/${encodeURIComponent(address)}/txs/chain${suffix}`, options)
  }

  /**
   * Unconfirmed (mempool) transactions touching an address. electrs lists at
   * most `--rest-default-max-mempool-txs` (default 50) of them, with no way to
   * page further; `getAddressHistory` detects that cap.
   *
   * One request to `GET /address/:address/txs/mempool`, whose reply is
   * returned as parsed, without checking its shape or values.
   *
   * @param address - The address, URL-encoded into the path.
   * @param options - Cancellation and deadline for the call.
   * @returns The parsed reply.
   * @throws {@link QbitApiError} when the request fails (`not_found`,
   *   `rate_limit`, `payload_too_large` or `http` for a non-2xx reply or a
   *   refused redirect; `network`; `timeout`; `aborted`), or `parse` when the
   *   reply is not JSON or cannot be read.
   */
  getAddressMempoolTxs(address: string, options?: RequestOptions): Promise<EsploraTx[]> {
    return this.getJson<EsploraTx[]>(`/address/${encodeURIComponent(address)}/txs/mempool`, options)
  }

  /**
   * Complete address history from a bounded, page-one scan. The confirmed
   * chain route is exhausted explicitly; short pages are not assumed final.
   *
   * electrs answers a chain cursor it does not know (a lagging node behind a
   * load balancer, or a reorg between pages) with HTTP 200 and `[]`, and
   * `/txs/mempool` stops at 50 rows, so the scan alone cannot tell a short
   * history from a complete one. The address stats are therefore read before
   * and after the scan, each in a request of its own, and the history is
   * returned only if both reads agree and it holds exactly
   * `chain_stats.tx_count` confirmed and `mempool_stats.tx_count` mempool
   * transactions. If the stats changed during the scan, the address is scanned
   * once more; if they change again, or the counts differ, the call rejects
   * with `invalid_cursor`. Stats without a non-negative safe-integer
   * `tx_count` reject with `parse`. `maxPages` and `maxTransactions` cover
   * both scans.
   *
   * @remarks
   * Some causes of `invalid_cursor` last until the backend changes: an address
   * with more than 50 mempool transactions fails until enough confirm. See
   * [Address history](https://github.com/Qbit-Org/qbit-js/blob/main/packages/api/docs/address-history.md).
   *
   * @param address - The address, URL-encoded into the paths.
   * @param options - Cancellation and deadline for the whole scan, and its
   *   page and transaction bounds.
   * @returns The confirmed and mempool transactions.
   * @throws {@link QbitApiError} `invalid_cursor` when the history cannot be
   *   shown complete (the stats changed during both scans, the counts differ, a
   *   txid repeats or a cursor stops advancing); retry it later.
   *   `pagination_limit` when the scan exceeds `maxPages` or `maxTransactions`.
   *   `parse` when a reply is not JSON or cannot be read, the stats lack a
   *   valid `tx_count`, a page is not an array of transactions that each have
   *   a 64-hex `txid`, a boolean `status.confirmed`, and `vin` and `vout`
   *   arrays of objects, and spend from or pay to the address, or a page lists
   *   a transaction under the wrong confirmation status. `http` for an invalid
   *   `maxPages` or `maxTransactions`. Any kind a
   *   failed request has (`not_found`, `rate_limit`, `payload_too_large`,
   *   `http`, `network`, `timeout`, `aborted`).
   *
   * @example
   * ```ts
   * const controller = new AbortController() // e.g. aborted when the user switches address
   * const { confirmed, mempool } = await client.getAddressHistory(address, {
   *   signal: controller.signal,
   *   deadlineMs: 30_000, // the whole scan, retries and backoff included
   * })
   * ```
   */
  getAddressHistory(address: string, options: AddressHistoryOptions = {}): Promise<AddressHistory> {
    return this.runOperation(options, signal => this.scanAddressHistory(address, options, signal))
  }

  private async scanAddressHistory(
    address: string,
    options: AddressHistoryOptions,
    signal: AbortSignal
  ): Promise<AddressHistory> {
    const maxPages = positiveAddressHistoryLimit(options.maxPages, DEFAULT_MAX_ADDRESS_HISTORY_PAGES, 'maxPages')
    const maxTransactions = positiveAddressHistoryLimit(
      options.maxTransactions,
      DEFAULT_MAX_ADDRESS_HISTORY_TRANSACTIONS,
      'maxTransactions'
    )
    const budget = createAddressHistoryBudget()
    return verifiedAddressHistory(
      address,
      'esplora',
      () => this.getJson<unknown>(`/address/${encodeURIComponent(address)}`, { signal }, false),
      () => this.scanAddressHistoryOnce(address, maxPages, maxTransactions, budget, signal)
    )
  }

  private async scanAddressHistoryOnce(
    address: string,
    maxPages: number,
    maxTransactions: number,
    budget: AddressHistoryBudget,
    signal: AbortSignal
  ): Promise<AddressHistory> {
    // A rescan only gets the page fetches the first scan left.
    if (budget.pageRequests >= maxPages) {
      throw addressHistoryPageLimitError(address, maxPages, 'esplora')
    }
    const state = createAddressHistoryScanState()

    const mempoolRows = reserveAddressHistoryTransactions(
      budget,
      await this.getAddressMempoolTxs(address, { signal }),
      maxTransactions,
      address,
      'esplora',
      'esplora mempool'
    )
    const mempoolTxs = assertAddressHistoryPage(mempoolRows, address, 'esplora mempool')
    appendAddressHistoryTransactions(state, mempoolTxs, 'mempool', address, 'esplora')

    let cursor: string | undefined
    const seenCursors = new Set<string>()

    while (true) {
      budget.pageRequests += 1
      const rows = reserveAddressHistoryTransactions(
        budget,
        await this.getAddressTxs(address, cursor, { signal }),
        maxTransactions,
        address,
        'esplora',
        'esplora confirmed'
      )
      if (rows.length === 0) break

      if (budget.pageRequests === maxPages) {
        throw addressHistoryPageLimitError(address, maxPages, 'esplora')
      }
      const txs = assertAddressHistoryPage(rows, address, 'esplora confirmed')
      cursor = nextAddressHistoryCursor(txs, cursor, seenCursors, address, 'esplora')
      appendAddressHistoryTransactions(state, txs, 'confirmed', address, 'esplora')
    }

    return { confirmed: state.confirmed, mempool: state.mempool }
  }

  /**
   * A transaction, from `GET /tx/:txid`. The reply is returned as parsed,
   * without checking its shape or values, nor that it is the transaction
   * requested; {@link EsploraClient.getTxHex} checks the latter.
   *
   * @param txid - The transaction id, URL-encoded into the path.
   * @param options - Cancellation and deadline for the call.
   * @returns The parsed reply.
   * @throws {@link QbitApiError} when the request fails (`not_found`,
   *   `rate_limit`, `payload_too_large` or `http` for a non-2xx reply or a
   *   refused redirect; `network`; `timeout`; `aborted`), or `parse` when the
   *   reply is not JSON or cannot be read.
   */
  getTx(txid: string, options?: RequestOptions): Promise<EsploraTx> {
    return this.getJson<EsploraTx>(`/tx/${encodeURIComponent(txid)}`, options)
  }

  /**
   * Raw transaction hex as the backend serializes it (with witness data when
   * the transaction has any), in lowercase. The reply is checked before it is
   * returned: it must be non-empty, even-length hex that decodes to one
   * complete transaction whose txid (the double SHA-256 of its
   * witness-stripped serialization, as qbit Core computes it) is `txid`,
   * compared case-insensitively. The transaction must be encoded as qbit
   * Core's decoder requires: every count and length in its shortest
   * CompactSize form and at most 0x02000000, and no witness flag when every
   * witness stack is empty. Anything else, an empty `200` reply included,
   * throws a `parse` `QbitApiError`, so a backend cannot hand back an empty
   * string or another transaction. Spaces, tabs and line breaks around the
   * hex are ignored. The txid does not commit
   * to witness data, so a reply with altered or stripped witnesses still
   * passes; compare the wtxid if you need them.
   *
   * @remarks
   * See
   * [Response validation](https://github.com/Qbit-Org/qbit-js/blob/main/packages/api/docs/response-validation.md), and
   * [Endpoints and clients](https://github.com/Qbit-Org/qbit-js/blob/main/packages/api/docs/endpoints.md) for the backends.
   *
   * @param txid - The transaction id (not the wtxid), URL-encoded into the
   *   path of `GET /tx/:txid/hex`.
   * @param options - Cancellation and deadline for the call.
   * @returns The transaction's hex, in lowercase.
   * @throws {@link QbitApiError} `parse` when the reply is not that
   *   transaction's hex, as above, or its body cannot be read; any kind a
   *   failed request has (`not_found`, `rate_limit`, `payload_too_large`,
   *   `http`, `network`, `timeout`, `aborted`).
   */
  async getTxHex(txid: string, options?: RequestOptions): Promise<string> {
    const path = `/tx/${encodeURIComponent(txid)}/hex`
    const text = await this.getText(path, options)
    const hex = trimAsciiWhitespace(text).toLowerCase()
    const invalid = (reason: string) =>
      new QbitApiError('parse', `transaction hex reply ${reason}`, {
        url: this.errorUrl(path),
        responseBody: responseBodyPreview(text, this.baseUrl),
      })
    if (hex === '') throw invalid('was empty')
    if (hex.length % 2 !== 0 || !/^[0-9a-f]+$/.test(hex)) {
      throw invalid(`was not even-length hex: ${quotedResponseText(text, this.baseUrl)}`)
    }
    const actual = tryTxidFromRawTx(hex)
    if (actual === undefined) throw invalid('is not a well-formed transaction')
    if (actual !== String(txid).toLowerCase()) throw invalid(`is transaction ${actual}, not the one requested`)
    return hex
  }

  /**
   * Whether a transaction is confirmed, and in which block, from
   * `GET /tx/:txid/status`. The reply is returned as parsed, without checking
   * its shape or values.
   *
   * @param txid - The transaction id, URL-encoded into the path.
   * @param options - Cancellation and deadline for the call.
   * @returns The parsed reply.
   * @throws {@link QbitApiError} when the request fails (`not_found`,
   *   `rate_limit`, `payload_too_large` or `http` for a non-2xx reply or a
   *   refused redirect; `network`; `timeout`; `aborted`), or `parse` when the
   *   reply is not JSON or cannot be read.
   */
  getTxStatus(txid: string, options?: RequestOptions): Promise<EsploraTxStatus> {
    return this.getJson<EsploraTxStatus>(`/tx/${encodeURIComponent(txid)}/status`, options)
  }

  /**
   * Fee-rate estimates by confirmation target, from `GET /fee-estimates`. The
   * reply is returned as parsed, without checking its shape or values: pass it
   * to {@link feeTiersFromEstimates}, as {@link EsploraClient.getFeeTiers}
   * does, to validate it. For a mempool-qbit backend, use
   * {@link MempoolQbitClient}; see
   * [Endpoints and clients](https://github.com/Qbit-Org/qbit-js/blob/main/packages/api/docs/endpoints.md).
   *
   * @param options - Cancellation and deadline for the call.
   * @returns The parsed reply.
   * @throws {@link QbitApiError} when the request fails (`not_found`,
   *   `rate_limit`, `payload_too_large` or `http` for a non-2xx reply or a
   *   refused redirect; `network`; `timeout`; `aborted`), or `parse` when the
   *   reply is not JSON or cannot be read.
   */
  getFeeEstimates(options?: RequestOptions): Promise<EsploraFeeEstimates> {
    return this.getJson<EsploraFeeEstimates>('/fee-estimates', options)
  }

  /**
   * Height of the chain tip, from `GET /blocks/tip/height`: the reply, trimmed,
   * converted with `Number()`. The result must be an integer; it is not
   * otherwise checked. `Number()` also accepts signed, hex and exponent forms,
   * and converts an empty reply to 0, which is returned.
   *
   * @param options - Cancellation and deadline for the call.
   * @returns The tip height.
   * @throws {@link QbitApiError} `parse` when the converted reply is not an
   *   integer, or its body cannot be read; any kind a failed request has
   *   (`not_found`, `rate_limit`, `payload_too_large`, `http`, `network`,
   *   `timeout`, `aborted`).
   */
  async getTipHeight(options?: RequestOptions): Promise<number> {
    const text = await this.getText('/blocks/tip/height', options)
    const height = Number(text.trim())
    if (!Number.isInteger(height)) {
      throw new QbitApiError('parse', `tip height was not an integer: ${quotedResponseText(text, this.baseUrl)}`, {
        url: this.errorUrl('/blocks/tip/height'),
        responseBody: responseBodyPreview(text, this.baseUrl),
      })
    }
    return height
  }

  /**
   * Hash of the chain tip's block, from `GET /blocks/tip/hash`: the reply,
   * trimmed. It is not checked to be a block hash.
   *
   * @param options - Cancellation and deadline for the call.
   * @returns The trimmed reply.
   * @throws {@link QbitApiError} `parse` when the body cannot be read; any kind
   *   a failed request has (`not_found`, `rate_limit`, `payload_too_large`,
   *   `http`, `network`, `timeout`, `aborted`).
   */
  async getTipHash(options?: RequestOptions): Promise<string> {
    return (await this.getText('/blocks/tip/hash', options)).trim()
  }

  /**
   * Broadcast a signed transaction with `POST /tx`. Resolves with its txid
   * only when a 2xx reply echoes the txid, or a non-2xx reply reports the
   * transaction already known and the txid is known (derived from the hex or
   * passed as `options.txid`). The POST is never re-sent once it may have
   * reached the node; when the outcome cannot be told, the call rejects with
   * `unknown_outcome`.
   *
   * @remarks
   * Which replies resolve, reject or are `unknown_outcome` is in the
   * [outcome table](https://github.com/Qbit-Org/qbit-js/blob/main/packages/api/docs/broadcasting.md#outcomes); see also
   * [Recovering from an unknown outcome](https://github.com/Qbit-Org/qbit-js/blob/main/packages/api/docs/broadcasting.md#recovering-from-an-unknown-outcome)
   * and [The txid](https://github.com/Qbit-Org/qbit-js/blob/main/packages/api/docs/broadcasting.md#the-txid).
   *
   * @param rawTxHex - The signed transaction, as hex, sent as the request body
   *   of `POST /tx`.
   * @param options - Cancellation and deadline for the call, and the txid.
   * @returns The txid in lowercase: the one supplied or derived from the hex,
   *   or, when there is neither, the 64-hex txid the reply carried.
   * @throws `TypeError` (as a rejection) when `rawTxHex` is not a string, or
   *   `options.txid` is not a 64-hex transaction id matching the hex.
   * @throws {@link QbitApiError} `unknown_outcome` when the submission may have
   *   reached the node. `http`, `not_found`, `payload_too_large` or
   *   `rate_limit` when this submission was not accepted; for a resubmission,
   *   that proves nothing about the original. `network` for a connection
   *   failure before anything was sent, once retries run out. `aborted` or
   *   `timeout` when the call was cancelled or its deadline expired before the
   *   POST was sent or re-sent, or while a 429 body was read. A custom
   *   `fetchFn`'s own `QbitApiError` propagates as it is, even if the POST was
   *   already sent, unless its kind is `network`, `timeout` or `aborted`, so
   *   its `http`, `not_found`, `payload_too_large` or `rate_limit` proves that
   *   this submission was not accepted only if that `fetchFn` throws one only
   *   when nothing was sent; see {@link EsploraClientOptions.fetchFn}.
   *
   * @example
   * ```ts
   * try {
   *   const txid = await client.broadcastTx(rawTxHex)
   * } catch (error) {
   *   if (QbitApiError.is(error) && error.kind === 'unknown_outcome') {
   *     // The node may already have it, and lookups such as getTx(txid) cannot
   *     // rule that out. Resubmitting the same rawTxHex is harmless (error.txid
   *     // is set unless no txid was supplied and none could be derived from the
   *     // hex). Never rebuild the payment with different inputs: that can
   *     // double-spend or pay twice.
   *   } else {
   *     // This submission was not accepted, provided that any custom fetchFn
   *     // throws a QbitApiError only when nothing was sent.
   *     throw error
   *   }
   * }
   * ```
   */
  async broadcastTx(rawTxHex: string, options?: BroadcastTxOptions): Promise<string> {
    return this.submitTx('/tx', rawTxHex, resolveBroadcastTxid(rawTxHex, options), options)
  }

  // --- adapters (clean, wallet-friendly shapes) --------------------------

  /**
   * Confirmed + mempool balance for an address, in satoshis.
   *
   * Reads the address stats with {@link EsploraClient.getAddressStats} and
   * validates them with {@link addressBalanceFromStats}.
   *
   * @remarks
   * On electrs, a `parse` error for a negative total can be transient right
   * after a block; retry it on the next poll. See
   * [Response validation](https://github.com/Qbit-Org/qbit-js/blob/main/packages/api/docs/response-validation.md).
   *
   * @param address - The address, URL-encoded into the path of
   *   `GET /address/:address`.
   * @param options - Cancellation and deadline for the call.
   * @returns The confirmed, mempool and total balance.
   * @throws {@link QbitApiError} `parse` when the reply is not JSON, cannot be
   *   read, or fails {@link addressBalanceFromStats}'s checks; any kind a failed
   *   request has (`not_found`, `rate_limit`, `payload_too_large`, `http`,
   *   `network`, `timeout`, `aborted`).
   *
   * @example
   * ```ts
   * const { confirmedSats, mempoolSats, totalSats } = await client.getAddressBalance(address)
   * // mempoolSats can be negative while mempool transactions spend confirmed outputs.
   * ```
   */
  async getAddressBalance(address: string, options?: RequestOptions): Promise<AddressBalance> {
    return addressBalanceFromStats(await this.getAddressStats(address, options))
  }

  /**
   * Fee-rate tiers (sat/vB), ascending by confirmation target.
   *
   * Reads the estimates with `getFeeEstimates` and validates them with
   * {@link feeTiersFromEstimates} under its default ceiling,
   * {@link DEFAULT_MAX_FEE_RATE_SAT_VB}. For a lower ceiling, call
   * `feeTiersFromEstimates(await client.getFeeEstimates(), { maxFeeRate })`.
   *
   * @remarks
   * See [Response validation](https://github.com/Qbit-Org/qbit-js/blob/main/packages/api/docs/response-validation.md).
   *
   * @param options - Cancellation and deadline for the call.
   * @returns The tiers; `[]` when the backend returned no estimates.
   * @throws {@link QbitApiError} `parse` when the reply is not JSON, cannot be
   *   read, or fails {@link feeTiersFromEstimates}'s checks; any kind a failed
   *   request has (`not_found`, `rate_limit`, `payload_too_large`, `http`,
   *   `network`, `timeout`, `aborted`).
   */
  async getFeeTiers(options?: RequestOptions): Promise<FeeRateTier[]> {
    return feeTiersFromEstimates(await this.getFeeEstimates(options))
  }

  // --- internals ---------------------------------------------------------

  /**
   * Run one public call under a single signal that combines the client's
   * signal, the caller's signal, and the caller's deadline. Pass `{ signal }`
   * to dependent calls so they share the same cancellation and budget.
   */
  protected async runOperation<T>(
    options: RequestOptions | undefined,
    run: (signal: AbortSignal) => Promise<T>
  ): Promise<T> {
    const scope = openOperationScope([this.signal, options?.signal], options?.deadlineMs)
    try {
      return await run(scope.signal)
    } finally {
      scope.dispose()
    }
  }

  /**
   * GET and parse JSON. With `dedup` false the request is sent on its own
   * instead of joining an identical one already in flight, whose reply may
   * predate requests this call has made since.
   */
  protected getJson<T>(path: string, options?: RequestOptions, dedup = true): Promise<T> {
    return this.runOperation(options, async signal => {
      const response = await this.request(path, { method: 'GET', dedup }, { signal })
      const url = this.errorUrl(path)
      const text = await readBody(response, url, this.baseUrl, signal)
      if (!response.ok) throw httpError(response, text, url, this.baseUrl)
      try {
        return JSON.parse(text) as T
      } catch (cause) {
        // V8's JSON.parse error quotes the first characters of the body, and a
        // token cut short there escapes redaction, so the cause is a generic
        // SyntaxError; the original stays behind QbitApiError.unredactedCause().
        throw new QbitApiError('parse', `failed to parse JSON from ${path}`, {
          url,
          responseBody: responseBodyPreview(text, this.baseUrl),
          cause: new SyntaxError('response body is not valid JSON'),
          unredactedCause: cause,
        })
      }
    })
  }

  /**
   * GET the body as text. It joins an identical GET already in flight, and a
   * non-2xx reply throws the same errors as `getJson`.
   */
  protected getText(path: string, options?: RequestOptions): Promise<string> {
    return this.runOperation(options, async signal => {
      const response = await this.request(path, { method: 'GET', dedup: true }, { signal })
      const url = this.errorUrl(path)
      const text = await readBody(response, url, this.baseUrl, signal)
      if (!response.ok) throw httpError(response, text, url, this.baseUrl)
      return text
    })
  }

  /**
   * POST a transaction submission under the submission retry policy and
   * classify the reply as the outcome table in `docs/broadcasting.md` says.
   * `txid` identifies the submission in `unknown_outcome` errors and, when
   * known, is the result for already-known non-2xx replies. An abort or
   * deadline once the POST may have been sent, including while the reply body
   * is read, is an `unknown_outcome` too, unless the reply is a 429.
   */
  protected submitTx(path: string, body: string, txid: string | undefined, options?: RequestOptions): Promise<string> {
    return this.runOperation(options, async signal => {
      const url = `${this.baseUrl}${path}`
      const errorUrl = this.errorUrl(path)
      const response = await this.requestWithRetry(
        url,
        { method: 'POST', body, headers: { 'content-type': 'text/plain' } },
        signal,
        txid
      )
      let text: string
      try {
        text = (await readBody(response, errorUrl, this.baseUrl, signal)).trim()
      } catch (cause) {
        // A 429 proves nothing was submitted, even when the call is cut short here.
        if (response.status === 429 && signal.aborted) throw abortErrorFor(signal)
        throw unknownOutcomeError(errorUrl, txid, `HTTP ${response.status} reply body could not be read`, {
          status: response.status,
          cause,
        })
      }
      const detail = responseBodyPreview(text, this.baseUrl)
      const reply = httpReplyMessage(response.status, errorUrl, detail)
      if (response.ok) {
        // Only a reply that echoes the txid proves the node took this transaction.
        // Without a txid to compare against, the body must itself be a txid: a
        // gateway may answer 2xx with an HTML page or an empty body after the
        // node accepted the submission, so anything else is an unknown outcome.
        const echoed = text.toLowerCase()
        if (txid === undefined) {
          if (TXID_PATTERN.test(echoed)) return echoed
        } else if (echoed === txid) {
          return txid
        }
        const reason = txid === undefined ? 'reply is not a txid' : 'reply did not echo the txid'
        throw unknownOutcomeError(errorUrl, txid, `${reason} (${reply})`, {
          status: response.status,
          responseBody: detail,
        })
      }
      if (UNPROCESSED_SERVER_ERROR_STATUSES.has(response.status))
        throw httpError(response, text, errorUrl, this.baseUrl)
      // The body is read before the status is judged: qbit Core's JSON-RPC server
      // answers HTTP 500 for every RPC error (src/httprpc.cpp, JSONErrorReply),
      // so a relayed envelope carrying the node's verdict can arrive as a 5xx.
      const rejection = parseBroadcastReply(text)
      if (isAlreadyKnownBroadcastReply(rejection)) {
        if (txid !== undefined) return txid
        throw unknownOutcomeError(errorUrl, undefined, `node already knows the transaction: ${reply}`, {
          status: response.status,
          responseBody: detail,
        })
      }
      if (response.status >= 500) {
        // A 5xx alone says the server failed, not whether the node saw the
        // transaction; only the node's own rejection in the body settles it.
        if (isDefiniteNodeRejection(rejection)) throw httpError(response, text, errorUrl, this.baseUrl)
        throw unknownOutcomeError(errorUrl, txid, reply, { status: response.status, responseBody: detail })
      }
      if (isRelayedTransportFailure(rejection)) {
        throw unknownOutcomeError(errorUrl, txid, `backend lost its node connection (${reply})`, {
          status: response.status,
          responseBody: detail,
        })
      }
      throw httpError(response, text, errorUrl, this.baseUrl)
    })
  }

  /**
   * Send a request to `path` under the client's retry policy (a GET or HEAD is
   * a read; any other method is a submission) and resolve with the reply,
   * fully buffered, whatever its status; a redirect is refused with an error
   * instead. With `dedup`, it joins a request to
   * the same URL already in flight, whatever its method. Where the runtime has
   * no usable `Response` constructor, the reply is a buffered stand-in with
   * the status fields, `headers`, `url`, `text()`, `json()` and `clone()`, and
   * `body: null`.
   */
  protected request(
    path: string,
    init: { method: string; body?: string; headers?: Record<string, string>; dedup: boolean },
    options?: RequestOptions
  ): Promise<Response> {
    return this.runOperation(options, signal => {
      const url = `${this.baseUrl}${path}`
      return init.dedup ? this.requestShared(url, init, signal) : this.requestWithRetry(url, init, signal)
    })
  }

  /**
   * Concurrent identical GETs share one request. One caller giving up only
   * stops waiting; the shared request is aborted once every caller has left.
   */
  private async requestShared(
    url: string,
    init: { method: string; headers?: Record<string, string> },
    signal: AbortSignal
  ): Promise<Response> {
    let pending = this.inflight.get(url)
    if (pending === undefined) {
      const controller = internalAbortController()
      pending = {
        response: this.requestWithRetry(url, init, controller.signal),
        consumers: 0,
        controller,
      }
      this.inflight.set(url, pending)
    }
    pending.consumers += 1

    let response: Response
    try {
      response = await raceAbort(pending.response, signal)
    } catch (error) {
      pending.consumers -= 1
      if (pending.consumers === 0) {
        if (this.inflight.get(url) === pending) this.inflight.delete(url)
        if (signal.aborted) {
          const errorUrl = redactBaseUrl(url, this.baseUrl)
          pending.controller.abort(new QbitApiError('aborted', `request abandoned: ${errorUrl}`, { url: errorUrl }))
          // If the response already arrived, nobody will read its body.
          pending.response.then(discardResponseBody, () => undefined)
        }
      }
      throw error
    }

    pending.consumers -= 1
    // The last waiter consumes the original body; earlier waiters receive clones.
    if (pending.consumers === 0) {
      if (this.inflight.get(url) === pending) this.inflight.delete(url)
      return response
    }
    return response.clone()
  }

  /**
   * Idempotent requests (GET/HEAD) retry on network errors, timeouts, and
   * transient statuses. Any other method is a submission: an attempt is only
   * repeated when it provably was not processed (a 429 within the retry and
   * `Retry-After` limits, or a connection failure before anything was sent;
   * see `docs/broadcasting.md`). Any other attempt is never re-sent: a reply
   * that arrives whole is returned for the caller to judge, and one that may
   * have been processed without such a reply (a transport failure, an abort or
   * deadline in flight unless the reply is a 429, or a refused redirect) fails
   * with `unknown_outcome`. `txid` labels that error when the submission is a
   * transaction. A custom fetchFn's own QbitApiError is taken at its word,
   * whether or not the POST was sent; see `EsploraClientOptions.fetchFn`.
   */
  private async requestWithRetry(
    url: string,
    init: { method: string; body?: string; headers?: Record<string, string> },
    signal: AbortSignal,
    txid?: string
  ): Promise<Response> {
    const idempotent = IDEMPOTENT_METHODS.has(init.method.toUpperCase())
    const errorUrl = redactBaseUrl(url, this.baseUrl)
    let lastError: QbitApiError | undefined
    for (let attempt = 0; attempt <= this.retries; attempt += 1) {
      // Every earlier attempt was provably unprocessed (or a read), so an abort
      // or deadline before this one starts is a definite `aborted` / `timeout`.
      if (signal.aborted) throw abortErrorFor(signal)
      const reply: { status?: number; retryAfterMs?: number; refusedRedirect?: true } = {}
      let response: Response
      try {
        response = await this.fetchOnce(url, init, signal, reply)
      } catch (error) {
        // Another copy's QbitApiError (from a custom fetchFn) passes through too.
        lastError = QbitApiError.is(error)
          ? error
          : new QbitApiError('network', redactBaseUrl(String(error), this.baseUrl), {
              url: errorUrl,
              ...causeOptions(error, this.baseUrl),
            })
        // A refused redirect is never followed or retried. A submission's POST
        // still reached the origin, which may have accepted it before
        // redirecting (303), and a runtime that followed the redirect itself
        // may have re-sent it to the target (307/308).
        if (!idempotent && reply.refusedRedirect) {
          throw unknownOutcomeError(errorUrl, txid, lastError.message, {
            ...(lastError.status === undefined ? {} : { status: lastError.status }),
            cause: lastError,
          })
        }
        // fetchOnce reads the body, so a submission reply can arrive and then stall,
        // fail mid-read, or be cut short by an abort or the deadline. A 429 still
        // proves the submission was not processed; any other reply may follow an
        // accepted POST.
        if (!idempotent && reply.status === 429) {
          if (signal.aborted) throw abortErrorFor(signal)
          const { retryAfterMs } = reply
          if (attempt < this.retries && (retryAfterMs === undefined || retryAfterMs <= this.maxRetryAfterMs)) {
            await this.sleep(retryAfterMs ?? this.backoffMs(attempt), signal)
            continue
          }
          throw new QbitApiError('rate_limit', `HTTP 429 from ${errorUrl} (reply body could not be read)`, {
            status: 429,
            url: errorUrl,
            cause: lastError,
            ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
          })
        }
        if (!idempotent && reply.status !== undefined) {
          throw unknownOutcomeError(errorUrl, txid, `HTTP ${reply.status} reply body could not be read`, {
            status: reply.status,
            cause: lastError,
          })
        }
        // A read whose transient reply (429, 500, 502, 503 or 504) fails
        // mid-body is retried like the status itself, honouring Retry-After
        // within the cap; the final attempt's failure surfaces as before. A
        // stalled body is a timeout and takes the timeout path below.
        if (
          idempotent &&
          lastError.kind === 'parse' &&
          reply.status !== undefined &&
          TRANSIENT_STATUSES.has(reply.status)
        ) {
          const { retryAfterMs } = reply
          const overCap = retryAfterMs !== undefined && retryAfterMs > this.maxRetryAfterMs
          if (attempt < this.retries && !overCap && !signal.aborted) {
            await this.sleep(retryAfterMs ?? this.backoffMs(attempt), signal)
            continue
          }
          throw lastError
        }
        // On a submission, any other kind here is a custom fetchFn's own
        // QbitApiError, passed on by its kind although the POST may already
        // have been sent: its `http`, `not_found` or `rate_limit` proves the
        // submission was not accepted only if the fetchFn throws one only when
        // nothing was sent (see EsploraClientOptions.fetchFn).
        if (lastError.kind !== 'network' && lastError.kind !== 'timeout' && lastError.kind !== 'aborted') {
          throw lastError
        }
        // An abort or deadline here fired while the attempt was in flight, so a
        // submission may already have reached the server, like a timeout.
        // Judge the original fetch error: the public `cause` is a depth-limited
        // redacted copy that can drop a nested failure meaning the POST was sent.
        // Another copy of this package keeps that original where this one cannot
        // read it, so a `network` error from that copy never counts as unsent.
        const unsent =
          idempotent ||
          (lastError.kind === 'network' &&
            lastError instanceof QbitApiError &&
            isPreConnectionFailure(QbitApiError.unredactedCause(lastError) ?? lastError))
        if (!unsent) {
          // A custom fetchFn's own QbitApiError is not redacted; its message is, where quoted here.
          const reason = redactBaseUrl(String(lastError.message), this.baseUrl)
          throw unknownOutcomeError(errorUrl, txid, reason, { cause: lastError })
        }
        if (lastError.kind !== 'aborted' && attempt < this.retries && !signal.aborted) {
          await this.sleep(this.backoffMs(attempt), signal)
          continue
        }
        throw lastError
      }

      const retryable = idempotent ? TRANSIENT_STATUSES.has(response.status) : response.status === 429
      if (retryable && attempt < this.retries) {
        const retryAfterMs = parseRetryAfter(response.headers.get('retry-after'))
        // Never park the request (and every de-duplicated waiter) on an
        // unbounded server-chosen delay: return the reply. A read throws it with
        // retryAfterMs; a submission judges its body first (submitTx).
        if (retryAfterMs !== undefined && retryAfterMs > this.maxRetryAfterMs) return response
        // Never wait on cleanup: a body whose cancel never settles must not
        // hold the call past an abort or deadline.
        void discardResponseBody(response)
        await this.sleep(retryAfterMs ?? this.backoffMs(attempt), signal)
        continue
      }
      return response
    }
    // Unreachable in practice, but satisfies the type checker.
    throw lastError ?? new QbitApiError('network', `request failed: ${errorUrl}`, { url: errorUrl })
  }

  /** Backoff that rejects as soon as `signal` aborts, even if `sleepFn` ignores it. */
  private async sleep(ms: number, signal: AbortSignal): Promise<void> {
    if (signal.aborted) throw abortErrorFor(signal)
    await raceAbort(
      Promise.resolve().then(() => this.sleepFn(ms, signal)),
      signal
    )
  }

  /**
   * One attempt under one timeout that spans the headers and the whole body,
   * also bounded by the call's signal until the body is buffered. Every
   * response it returns is fully buffered, whatever its status, so no caller
   * (retry loop, de-duplicated clone, or error path) can block on the network
   * after the timer is cleared. A body that misses the attempt timeout fails
   * the attempt as `timeout`, even for a status that would otherwise be
   * retried; an abort or call deadline, before or after the headers, rejects
   * with the call's `aborted` / `timeout` error. `reply.status` is set once
   * the headers arrive. A redirect is refused before its body is read, which
   * is cancelled instead, and `reply.refusedRedirect` is set; see
   * `refuseRedirect`.
   */
  private async fetchOnce(
    url: string,
    init: { method: string; body?: string; headers?: Record<string, string> },
    signal: AbortSignal,
    reply: { status?: number; retryAfterMs?: number; refusedRedirect?: true }
  ): Promise<Response> {
    if (signal.aborted) throw abortErrorFor(signal)
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.timeoutMs)
    // The operation signal bounds each attempt: its timeout is effectively
    // min(timeoutMs, time left before the call's deadline).
    const onAbort = () => controller.abort(signal.reason)
    signal.addEventListener('abort', onAbort, { once: true })
    const requestInit: RequestInit = {
      method: init.method,
      headers: { ...this.headers, ...(init.headers ?? {}) },
      mode: 'cors',
      redirect: 'manual',
      credentials: this.credentials,
      signal: controller.signal,
    }
    if (init.body !== undefined) requestInit.body = init.body
    let pending: Promise<Response> | undefined
    try {
      let response: Response
      try {
        pending = this.fetchFn(url, requestInit)
        response = await raceAbort(pending, signal)
      } catch (cause) {
        if (signal.aborted) {
          // A fetch that ignores its signal may still deliver a response nobody reads.
          pending?.then(discardResponseBody, () => undefined)
          throw abortErrorFor(signal)
        }
        if (QbitApiError.is(cause)) throw cause // from a custom fetchFn, built by any copy of this package
        if (isAbortError(cause)) throw this.timeoutError(url, cause)
        // fetch implementations may quote the request URL in their own messages.
        const errorUrl = redactBaseUrl(url, this.baseUrl)
        throw new QbitApiError(
          'network',
          `network error: ${errorUrl}${redactBaseUrl(formatErrorCause(cause), this.baseUrl)}`,
          {
            url: errorUrl,
            ...causeOptions(cause, this.baseUrl),
          }
        )
      }
      // Checked on the raw reply, since a buffered copy loses `type` and
      // `redirected`, and before `reply.status` is set, so the retry loop
      // never retries the refusal.
      try {
        refuseRedirect(response, url, this.baseUrl)
      } catch (refusal) {
        reply.refusedRedirect = true
        throw refusal
      }
      reply.status = response.status
      const retryAfterMs = parseRetryAfter(response.headers.get('retry-after'))
      if (retryAfterMs !== undefined) reply.retryAfterMs = retryAfterMs

      let text: string
      try {
        text = await readBodyUntilAborted(response, controller.signal)
      } catch (cause) {
        // The call signal also aborts `controller`, so only an abort it did not
        // cause is this attempt's own timeout.
        if (signal.aborted) throw abortErrorFor(signal)
        if (controller.signal.aborted) throw this.timeoutError(url, cause, response.status)
        throw bodyReadError(response, cause, redactBaseUrl(url, this.baseUrl), this.baseUrl)
      }
      return bufferedResponse(response, text)
    } finally {
      clearTimeout(timer)
      signal.removeEventListener('abort', onAbort)
    }
  }

  /** `status` is set when the headers arrived and the body missed the deadline. */
  private timeoutError(url: string, cause: unknown, status?: number): QbitApiError {
    // fetch implementations may quote the request URL in their own messages.
    const errorUrl = redactBaseUrl(url, this.baseUrl)
    return new QbitApiError(
      'timeout',
      `request timed out after ${this.timeoutMs}ms: ${errorUrl}${redactBaseUrl(formatErrorCause(cause), this.baseUrl)}`,
      { url: errorUrl, ...causeOptions(cause, this.baseUrl), ...(status === undefined ? {} : { status }) }
    )
  }

  private backoffMs(attempt: number): number {
    return Math.min(this.retryBaseDelayMs * 2 ** attempt, MAX_TIMER_DELAY_MS)
  }

  /** The request URL for `path` as errors show it: see `redactedBaseUrl`. */
  protected errorUrl(path: string): string {
    return `${redactedBaseUrl(this.baseUrl)}${path}`
  }
}

const MEMPOOL_QBIT_ADDRESS_PAGE_SIZE = 10

/**
 * Adapter for mempool-qbit's public Node API (`/api/v1` prefix). Most routes
 * match Esplora, but address pagination and fees use mempool-style shapes.
 *
 * It takes the same options as {@link EsploraClient}, plus
 * `maxAddressHistoryPages`. Its address-history methods page through the
 * combined `/address/:address/txs` route instead of `/txs/chain` and
 * `/txs/mempool`; `getFeeEstimates` maps
 * `/fees/recommended` to targets 1, 2 and 3; and `broadcastTx` falls back to
 * the `/tx/push` form route when `/tx` reports that it did not submit the
 * transaction.
 *
 * @remarks
 * See [Endpoints and clients](https://github.com/Qbit-Org/qbit-js/blob/main/packages/api/docs/endpoints.md).
 *
 * @category Clients
 */
export class MempoolQbitClient extends EsploraClient {
  private readonly maxAddressHistoryPages: number

  /**
   * Creates a client for the mempool-qbit backend at `options.baseUrl`. It
   * sends no request until a method is called.
   *
   * @param options - The {@link EsploraClient} options, and
   *   `maxAddressHistoryPages`.
   * @throws {@link QbitApiError} the errors of the {@link EsploraClient}
   *   constructor, or `http` when `maxAddressHistoryPages` (omitted or `null`
   *   takes the default) is not a positive
   *   safe integer.
   */
  constructor(options: MempoolQbitClientOptions) {
    super(options)
    const maxAddressHistoryPages = options.maxAddressHistoryPages ?? DEFAULT_MAX_ADDRESS_HISTORY_PAGES
    if (!Number.isSafeInteger(maxAddressHistoryPages) || maxAddressHistoryPages < 1) {
      throw new QbitApiError('http', 'maxAddressHistoryPages must be a positive integer')
    }
    this.maxAddressHistoryPages = maxAddressHistoryPages
  }

  /**
   * Complete address history from one bounded traversal of mempool-qbit's
   * combined endpoint. Page size is intentionally not assumed.
   *
   * The result is checked against the address stats, read before and after
   * the traversal, as `EsploraClient.getAddressHistory` describes, and a
   * traversal during which they changed is repeated once. qbit-electrs
   * answers a cursor that is the last mempool row with `[]` instead of the
   * confirmed rows that follow, so an address whose mempool rows fill whole
   * pages (50 each by default) rejects with `invalid_cursor` while it has
   * confirmed history, rather than returning none.
   *
   * @remarks
   * qbit-electrs answers a cursor it finds nowhere with `422`, which rejects
   * as an `http` `QbitApiError`. See
   * [Address history](https://github.com/Qbit-Org/qbit-js/blob/main/packages/api/docs/address-history.md).
   *
   * @param address - The address, URL-encoded into the paths.
   * @param options - Cancellation and deadline for the whole traversal, and
   *   its page and transaction bounds; `maxPages` cannot exceed the
   *   constructor's `maxAddressHistoryPages`.
   * @returns The confirmed and mempool transactions.
   * @throws {@link QbitApiError} as {@link EsploraClient.getAddressHistory}
   *   does, except that no page is checked for a confirmation status, since
   *   the combined route lists both.
   */
  override getAddressHistory(address: string, options: AddressHistoryOptions = {}): Promise<AddressHistory> {
    return this.runOperation(options, signal => this.scanCombinedAddressHistory(address, options, signal))
  }

  private async scanCombinedAddressHistory(
    address: string,
    options: AddressHistoryOptions,
    signal: AbortSignal
  ): Promise<AddressHistory> {
    const requestedMaxPages = positiveAddressHistoryLimit(options.maxPages, this.maxAddressHistoryPages, 'maxPages')
    const maxPages = Math.min(requestedMaxPages, this.maxAddressHistoryPages)
    const maxTransactions = positiveAddressHistoryLimit(
      options.maxTransactions,
      DEFAULT_MAX_ADDRESS_HISTORY_TRANSACTIONS,
      'maxTransactions'
    )
    const budget = createAddressHistoryBudget()
    return verifiedAddressHistory(
      address,
      'mempool-qbit',
      () => this.getJson<unknown>(`/address/${encodeURIComponent(address)}`, { signal }, false),
      () => this.scanCombinedAddressHistoryOnce(address, maxPages, maxTransactions, budget, signal)
    )
  }

  private async scanCombinedAddressHistoryOnce(
    address: string,
    maxPages: number,
    maxTransactions: number,
    budget: AddressHistoryBudget,
    signal: AbortSignal
  ): Promise<AddressHistory> {
    // A rescan only gets the page fetches the first scan left.
    if (budget.pageRequests >= maxPages) {
      throw this.addressHistoryPaginationLimitError(address, maxPages)
    }
    const state = createAddressHistoryScanState()
    let cursor: string | undefined
    const seenCursors = new Set<string>()

    while (true) {
      budget.pageRequests += 1
      const suffix = cursor ? `?after_txid=${encodeURIComponent(cursor)}` : ''
      const rows = reserveAddressHistoryTransactions(
        budget,
        await this.getJson<unknown>(`/address/${encodeURIComponent(address)}/txs${suffix}`, {
          signal,
        }),
        maxTransactions,
        address,
        'mempool-qbit',
        'mempool-qbit combined'
      )
      if (rows.length === 0) break

      if (budget.pageRequests === maxPages) {
        throw this.addressHistoryPaginationLimitError(address, maxPages)
      }
      const txs = assertAddressHistoryPage(rows, address, 'mempool-qbit combined')
      cursor = nextAddressHistoryCursor(txs, cursor, seenCursors, address, 'mempool-qbit')
      appendAddressHistoryTransactions(state, txs, 'combined', address, 'mempool-qbit')
    }

    return { confirmed: state.confirmed, mempool: state.mempool }
  }

  /**
   * Confirmed transaction history for an address, newest first.
   * mempool-qbit paginates combined history with `?after_txid=...` and sorts
   * mempool entries first, so full mempool-only pages must still advance.
   * Without `afterTxid`, an empty page right after a mempool row is checked
   * against the address stats: qbit-electrs answers that cursor with `[]`
   * instead of the confirmed rows that follow, so the call rejects with
   * `invalid_cursor` if the stats count more confirmed transactions than it
   * found.
   *
   * Each call scans from the first page of the combined route, and returns
   * at most 25 confirmed transactions, those after `afterTxid` when it is
   * given. The rows are not validated: only those whose `status.confirmed` is
   * `true` are kept, and their `txid`s are compared with the cursor and with
   * each other. A reply that is not an array of objects can reject with a
   * `TypeError` instead of a `QbitApiError`.
   *
   * @remarks
   * See [Endpoints and clients](https://github.com/Qbit-Org/qbit-js/blob/main/packages/api/docs/endpoints.md).
   *
   * @param address - The address, URL-encoded into the path.
   * @param afterTxid - The last txid of the previous page, which must be a
   *   confirmed transaction in the address's history; omit it for the first
   *   page.
   * @param options - Cancellation and deadline for the call.
   * @returns Up to 25 confirmed transactions.
   * @throws {@link QbitApiError} `invalid_cursor` when `afterTxid` is stale,
   *   unrelated or unconfirmed, a cursor stops advancing, or the stats check
   *   above fails. `pagination_limit` when the scan needs more than
   *   `maxAddressHistoryPages` requests. `parse` when a reply is not JSON or
   *   cannot be read, or the stats lack a valid `tx_count`. Any kind a failed
   *   request has (`not_found`, `rate_limit`, `payload_too_large`, `http`,
   *   `network`, `timeout`, `aborted`); qbit-electrs answers a cursor it finds
   *   nowhere with `422` (`http`).
   */
  override getAddressTxs(address: string, afterTxid?: string, options?: RequestOptions): Promise<EsploraTx[]> {
    return this.runOperation(options, signal => this.scanAddressTxs(address, afterTxid, signal))
  }

  private async scanAddressTxs(
    address: string,
    afterTxid: string | undefined,
    signal: AbortSignal
  ): Promise<EsploraTx[]> {
    const confirmedTxs: EsploraTx[] = []
    let cursor: string | undefined
    let continuationFound = afterTxid === undefined
    let cursorIsMempoolTx = false
    const seenCursors = new Set<string>()
    const seenTxids = new Set<string>()
    let pageCount = 0

    while (confirmedTxs.length < 25) {
      if (pageCount >= this.maxAddressHistoryPages) {
        throw this.addressHistoryPaginationLimitError(address)
      }
      pageCount += 1
      const suffix = cursor ? `?after_txid=${encodeURIComponent(cursor)}` : ''
      const txs = await this.getJson<EsploraTx[]>(`/address/${encodeURIComponent(address)}/txs${suffix}`, { signal })
      if (txs.length === 0) {
        if (!continuationFound) throw this.invalidAddressHistoryCursorError(address, afterTxid!)
        if (afterTxid === undefined && cursorIsMempoolTx) {
          await this.assertConfirmedHistoryReached(address, confirmedTxs.length, signal)
        }
        break
      }

      for (const tx of txs) {
        if (!continuationFound) {
          if (isConfirmedTx(tx)) seenTxids.add(tx.txid)
          if (tx.txid !== afterTxid) continue
          if (!isConfirmedTx(tx)) {
            throw this.invalidAddressHistoryCursorError(address, afterTxid)
          }
          continuationFound = true
          continue
        }
        if (isConfirmedTx(tx) && !seenTxids.has(tx.txid)) {
          confirmedTxs.push(tx)
          seenTxids.add(tx.txid)
        }
      }

      const nextCursor = txs[txs.length - 1]?.txid
      if (confirmedTxs.length >= 25) break
      if (txs.length < MEMPOOL_QBIT_ADDRESS_PAGE_SIZE) {
        if (!continuationFound) throw this.invalidAddressHistoryCursorError(address, afterTxid!)
        break
      }
      if (!nextCursor || nextCursor === cursor || seenCursors.has(nextCursor)) {
        if (!continuationFound) throw this.invalidAddressHistoryCursorError(address, afterTxid!)
        throw this.nonAdvancingAddressHistoryCursorError(address, nextCursor ?? cursor)
      }

      seenCursors.add(nextCursor)
      cursor = nextCursor
      cursorIsMempoolTx = !isConfirmedTx(txs[txs.length - 1]!)
    }

    return confirmedTxs.slice(0, 25)
  }

  /**
   * qbit-electrs's combined route answers an `after_txid` that is the last
   * mempool row with `[]`, not the confirmed rows that follow: it passes the
   * mempool txid on as the chain cursor, which `history()` never finds
   * (`src/rest.rs:992-998` in Qbit-Org/qbit-electrs@53102e9). Reject that
   * empty page when the address stats count confirmed transactions the scan
   * has not seen.
   */
  private async assertConfirmedHistoryReached(
    address: string,
    confirmedSeen: number,
    signal: AbortSignal
  ): Promise<void> {
    const stats = addressHistoryStats(
      await this.getJson<unknown>(`/address/${encodeURIComponent(address)}`, { signal }, false),
      address,
      'mempool-qbit'
    )
    if (stats.chain_stats.tx_count > confirmedSeen) {
      throw new QbitApiError(
        'invalid_cursor',
        `mempool-qbit combined history ended after a mempool transaction with ${confirmedSeen} of ${stats.chain_stats.tx_count} confirmed transactions: ${address}`
      )
    }
  }

  /**
   * mempool-qbit does not expose `/txs/mempool`. Page through the combined
   * history until confirmed entries begin, collecting the leading mempool set.
   *
   * The rows are not validated: those whose `status.confirmed` is not `true`
   * are kept, deduplicated by `txid`, and a page holding a confirmed row, or
   * an empty or short page, is taken as the end. A reply that is not an array
   * of objects can reject with a `TypeError` instead of a `QbitApiError`. Use
   * `getAddressHistory` for a history checked against the address stats.
   *
   * @param address - The address, URL-encoded into the path.
   * @param options - Cancellation and deadline for the call.
   * @returns The address's unconfirmed transactions.
   * @throws {@link QbitApiError} `pagination_limit` when the scan needs more
   *   than `maxAddressHistoryPages` requests. `invalid_cursor` when a cursor
   *   stops advancing. `parse` when a reply is not JSON or cannot be read. Any
   *   kind a failed request has (`not_found`, `rate_limit`,
   *   `payload_too_large`, `http`, `network`, `timeout`, `aborted`).
   */
  override getAddressMempoolTxs(address: string, options?: RequestOptions): Promise<EsploraTx[]> {
    return this.runOperation(options, signal => this.scanAddressMempoolTxs(address, signal))
  }

  private async scanAddressMempoolTxs(address: string, signal: AbortSignal): Promise<EsploraTx[]> {
    const mempoolTxs: EsploraTx[] = []
    let cursor: string | undefined
    const seenCursors = new Set<string>()
    const seenTxids = new Set<string>()
    let pageCount = 0

    while (true) {
      if (pageCount >= this.maxAddressHistoryPages) {
        throw this.addressHistoryPaginationLimitError(address)
      }
      pageCount += 1
      const suffix = cursor ? `?after_txid=${encodeURIComponent(cursor)}` : ''
      const txs = await this.getJson<EsploraTx[]>(`/address/${encodeURIComponent(address)}/txs${suffix}`, { signal })
      if (txs.length === 0) break

      for (const tx of txs) {
        if (!isConfirmedTx(tx) && !seenTxids.has(tx.txid)) {
          mempoolTxs.push(tx)
          seenTxids.add(tx.txid)
        }
      }

      const nextCursor = txs[txs.length - 1]?.txid
      if (txs.some(isConfirmedTx) || txs.length < MEMPOOL_QBIT_ADDRESS_PAGE_SIZE) break
      if (!nextCursor || nextCursor === cursor || seenCursors.has(nextCursor)) {
        throw this.nonAdvancingAddressHistoryCursorError(address, nextCursor ?? cursor)
      }

      seenCursors.add(nextCursor)
      cursor = nextCursor
    }

    return mempoolTxs
  }

  /**
   * mempool-qbit's named fee rates, from `GET /fees/recommended`, including
   * the `economyFee` and `minimumFee` policy floors. The reply is returned as
   * parsed, without checking its shape or values.
   *
   * @param options - Cancellation and deadline for the call.
   * @returns The parsed reply.
   * @throws {@link QbitApiError} when the request fails (`not_found`,
   *   `rate_limit`, `payload_too_large` or `http` for a non-2xx reply or a
   *   refused redirect; `network`; `timeout`; `aborted`), or `parse` when the
   *   reply is not JSON or cannot be read.
   */
  getMempoolRecommendedFees(options?: RequestOptions): Promise<MempoolRecommendedFees> {
    return this.getJson<MempoolRecommendedFees>('/fees/recommended', options)
  }

  /**
   * Fee-rate estimates for confirmation targets 1, 2 and 3, from mempool-qbit's
   * projected blocks: {@link MempoolQbitClient.getMempoolRecommendedFees}
   * mapped by {@link feeEstimatesFromMempoolRecommendedFees}, which checks
   * the three rates it uses. The fee-rate ceiling is applied by
   * {@link feeTiersFromEstimates}, as `getFeeTiers` does.
   *
   * @param options - Cancellation and deadline for the call.
   * @returns `{ "1": fastestFee, "2": halfHourFee, "3": hourFee }`.
   * @throws {@link QbitApiError} `parse` when the reply is not JSON, cannot be
   *   read, or is not an object whose `fastestFee`, `halfHourFee` and `hourFee`
   *   are finite numbers above 0; any kind a failed request has (`not_found`,
   *   `rate_limit`, `payload_too_large`, `http`, `network`, `timeout`,
   *   `aborted`).
   */
  override async getFeeEstimates(options?: RequestOptions): Promise<EsploraFeeEstimates> {
    return feeEstimatesFromMempoolRecommendedFees(await this.getMempoolRecommendedFees(options))
  }

  /**
   * Broadcast via `/tx`, falling back to the `/tx/push` form route only when
   * `/tx` reported that it did not submit the transaction. The fallback is a
   * second submission; its result is the call's, judged as
   * `EsploraClient.broadcastTx` judges a reply. One signal and deadline cover
   * both requests.
   *
   * @remarks
   * The `/tx/push` rows of the
   * [outcome table](https://github.com/Qbit-Org/qbit-js/blob/main/packages/api/docs/broadcasting.md#outcomes)
   * say when the fallback is sent. An uncertain `/tx` attempt never falls back,
   * and neither does an abort or expired deadline during `/tx`. The exception
   * is a `QbitApiError` that a custom `fetchFn` throws, which is judged by its
   * kind, status and body alone: a `not_found` 404, an `http` 405 or 501, or,
   * from this copy of the package, an `http` 400 whose `responseBody` is the
   * generic failure falls back even when the `fetchFn` threw it after the
   * `/tx` POST was sent. The same hex can then reach the backend twice, which
   * is harmless, but a rejection of the fallback proves nothing about `/tx`.
   *
   * @param rawTxHex - The signed transaction, as hex: the body of `POST /tx`,
   *   and sent as `txHash=<rawTxHex>` to the `/tx/push` fallback.
   * @param options - Cancellation and deadline for both requests, and the txid.
   * @returns The txid, as {@link EsploraClient.broadcastTx} returns it.
   * @throws `TypeError` as {@link EsploraClient.broadcastTx} does.
   * @throws {@link QbitApiError} as {@link EsploraClient.broadcastTx} does, for
   *   `/tx`, or for the fallback when it is sent.
   */
  override async broadcastTx(rawTxHex: string, options?: BroadcastTxOptions): Promise<string> {
    const txid = resolveBroadcastTxid(rawTxHex, options)
    return this.runOperation(options, async signal => {
      try {
        return await this.submitTx('/tx', rawTxHex, txid, { signal })
      } catch (error) {
        if (!shouldRetryBroadcastViaTxPush(error)) {
          throw error
        }
        // The backend's form route parses the literal `txHash=<hex>` text itself.
        return this.submitTx('/tx/push', `txHash=${rawTxHex}`, txid, { signal })
      }
    })
  }

  private addressHistoryPaginationLimitError(address: string, maxPages = this.maxAddressHistoryPages): QbitApiError {
    return new QbitApiError('pagination_limit', `mempool-qbit address history exceeded ${maxPages} pages: ${address}`)
  }

  private invalidAddressHistoryCursorError(address: string, afterTxid: string): QbitApiError {
    return new QbitApiError(
      'invalid_cursor',
      `mempool-qbit address history cursor is stale or not confirmed: ${afterTxid} (${address})`
    )
  }

  private nonAdvancingAddressHistoryCursorError(address: string, cursor?: string): QbitApiError {
    return new QbitApiError(
      'invalid_cursor',
      `mempool-qbit address history cursor stopped advancing: ${quotedResponseText(String(cursor ?? '(missing)'), this.baseUrl)} (${address})`
    )
  }
}

// ---------------------------------------------------------------------------
// Adapters & helpers
// ---------------------------------------------------------------------------

/**
 * An address's balance in satoshis, from {@link addressBalanceFromStats}.
 *
 * @category Addresses
 */
export interface AddressBalance {
  /** The address, as the stats reply named it. */
  address: string
  /** Confirmed balance: confirmed funded minus spent sums. Never negative. */
  confirmedSats: number
  /**
   * Net change from mempool transactions: mempool funded minus spent sums.
   * It can be negative while mempool transactions spend confirmed outputs.
   */
  mempoolSats: number
  /** `confirmedSats + mempoolSats`, a non-negative safe integer. */
  totalSats: number
}

/**
 * Confirmed, mempool and total balance in satoshis from esplora address stats.
 *
 * Throws a `parse` {@link QbitApiError} unless `stats` has a string `address`
 * and `chain_stats` / `mempool_stats` objects whose `funded_txo_sum` and
 * `spent_txo_sum` are non-negative safe integers, the confirmed balance is not
 * negative, and `totalSats` is a non-negative safe integer. `mempoolSats` may
 * be negative while mempool transactions spend confirmed outputs.
 *
 * `funded_txo_sum` and `spent_txo_sum` are lifetime totals of everything the
 * address has received and spent, not balances, and `MAX_MONEY` does not
 * bound them. `JSON.parse` cannot represent integers above
 * `Number.MAX_SAFE_INTEGER` (2^53 - 1 sats, about 90M QBT) exactly, so it
 * rounds them, and they fail closed rather than yield a plausible but wrong
 * balance. A reused address that has received more than that over its life
 * therefore fails on every call, however little it holds now. For such an
 * address, sum the `value` of each output from
 * {@link EsploraClient.getAddressUtxos} instead; that raw endpoint is not
 * validated, so check that each value is a non-negative safe integer.
 *
 * The `parse` error for a negative total, here and from
 * {@link EsploraClient.getAddressBalance}, can be transient right after a
 * block on electrs: it applies the block's headers before indexing it and
 * does not deduplicate mempool stats against the chain, so a spend that was
 * just confirmed can count in both `chain_stats` and `mempool_stats` for a
 * moment. Retry it on the next poll.
 *
 * @remarks
 * See [Response validation](https://github.com/Qbit-Org/qbit-js/blob/main/packages/api/docs/response-validation.md).
 *
 * @param stats - Address stats, such as {@link EsploraClient.getAddressStats}
 *   returns; any value is accepted and checked.
 * @returns The confirmed, mempool and total balance.
 * @throws {@link QbitApiError} `parse` when `stats` fails the checks above.
 * @category Addresses
 */
export function addressBalanceFromStats(stats: EsploraAddressStats): AddressBalance {
  if (
    !isRecord(stats) ||
    typeof stats.address !== 'string' ||
    !hasSafeTxoSums(stats.chain_stats) ||
    !hasSafeTxoSums(stats.mempool_stats)
  ) {
    throw new QbitApiError(
      'parse',
      'address stats lacked a string address or non-negative safe-integer funded/spent sums'
    )
  }
  const confirmedSats = stats.chain_stats.funded_txo_sum - stats.chain_stats.spent_txo_sum
  const mempoolSats = stats.mempool_stats.funded_txo_sum - stats.mempool_stats.spent_txo_sum
  const totalSats = confirmedSats + mempoolSats
  if (confirmedSats < 0 || !isSafeSatAmount(totalSats)) {
    throw new QbitApiError('parse', 'address stats implied a negative or unsafe balance')
  }
  return {
    address: stats.address,
    confirmedSats,
    mempoolSats,
    totalSats,
  }
}

/**
 * Default `maxFeeRate` for {@link feeTiersFromEstimates}, in sat/vB. qbit Core's
 * `sendrawtransaction` refuses fee rates above `DEFAULT_MAX_RAW_TX_FEE_RATE{COIN / 10}`
 * per kvB by default (`src/node/transaction.h:27`), which is 10,000 sat/vB.
 *
 * @category Fees
 */
export const DEFAULT_MAX_FEE_RATE_SAT_VB = 10_000

/** Core's longest fee-estimate horizon: 42 periods of 24 blocks (`src/policy/fees.h:158-159`). */
const MAX_FEE_ESTIMATE_TARGET = 1008

function isPositiveFeeRate(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
}

/**
 * Only non-negative safe integers are exact satoshi amounts after `JSON.parse`.
 * Core's `MAX_MONEY` (`src/consensus/amount.h:26`) is 2.1e16, above 2^53, and
 * lifetime `funded_txo_sum` / `spent_txo_sum` totals are not bounded even by
 * that, so larger values are valid but cannot be represented and fail closed.
 */
function isSafeSatAmount(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0
}

function hasSafeTxoSums(value: unknown): boolean {
  return isRecord(value) && isSafeSatAmount(value['funded_txo_sum']) && isSafeSatAmount(value['spent_txo_sum'])
}

/**
 * A fee rate for one confirmation target, from {@link feeTiersFromEstimates}.
 *
 * @category Fees
 */
export interface FeeRateTier {
  /** Confirmation target in blocks. */
  target: number
  /** Fee rate in sat/vB. */
  feeRate: number
}

/**
 * Map mempool-qbit's projected blocks, leaving named policy floors unlabelled.
 *
 * Throws a `parse` {@link QbitApiError} unless `fees` is an object whose
 * `fastestFee`, `halfHourFee` and `hourFee` are finite numbers above 0. The
 * fee-rate ceiling is applied downstream by {@link feeTiersFromEstimates}.
 *
 * @param fees - mempool-qbit's recommended fees, such as
 *   {@link MempoolQbitClient.getMempoolRecommendedFees} returns; any value is
 *   accepted and checked.
 * @returns `{ "1": fastestFee, "2": halfHourFee, "3": hourFee }`.
 * @throws {@link QbitApiError} `parse` when `fees` fails the checks above.
 * @category Fees
 */
export function feeEstimatesFromMempoolRecommendedFees(fees: MempoolRecommendedFees): EsploraFeeEstimates {
  if (!isRecord(fees)) {
    throw new QbitApiError('parse', 'mempool-qbit recommended fees were not a JSON object')
  }
  for (const field of ['fastestFee', 'halfHourFee', 'hourFee'] as const) {
    if (!isPositiveFeeRate(fees[field])) {
      throw new QbitApiError('parse', `mempool-qbit recommended fees had an invalid ${field}`)
    }
  }
  return {
    '1': fees.fastestFee,
    '2': fees.halfHourFee,
    '3': fees.hourFee,
  }
}

/**
 * Fee-rate tiers (sat/vB) from an esplora fee-estimate map, ascending by
 * confirmation target. `{}` yields `[]`.
 *
 * Fails closed with a `parse` {@link QbitApiError} unless `estimates` is an
 * object whose every key is a canonical decimal target from 1 to 1008 blocks
 * and whose every value is a finite fee rate above 0 and at most `maxFeeRate`
 * (default {@link DEFAULT_MAX_FEE_RATE_SAT_VB}). The default is a ceiling, not
 * a sanity check: it only rejects rates above Core's default broadcast limit,
 * so a hostile or broken backend can still return 9,999 sat/vB. Set a lower
 * ceiling with `feeTiersFromEstimates(await client.getFeeEstimates(), { maxFeeRate })`,
 * cap the total fee before signing, or both.
 * Previously, malformed entries were silently dropped and no ceiling applied.
 *
 * @remarks
 * See [Response validation](https://github.com/Qbit-Org/qbit-js/blob/main/packages/api/docs/response-validation.md).
 *
 * @param estimates - Fee estimates, such as `getFeeEstimates` returns; any
 *   value is accepted and checked.
 * @param options - `maxFeeRate`, the highest accepted rate in sat/vB.
 * @returns The tiers, ascending by `target`.
 * @throws TypeError when `options.maxFeeRate` is not a finite number above 0.
 * @throws {@link QbitApiError} `parse` when `estimates` fails the checks above.
 *
 * @example
 * ```ts
 * // 500 sat/vB leaves room for fee spikes and is 1/20 of the default worst case.
 * const tiers = feeTiersFromEstimates(await client.getFeeEstimates(), { maxFeeRate: 500 })
 * ```
 * @category Fees
 */
export function feeTiersFromEstimates(
  estimates: EsploraFeeEstimates,
  options: { maxFeeRate?: number } = {}
): FeeRateTier[] {
  const maxFeeRate = options.maxFeeRate ?? DEFAULT_MAX_FEE_RATE_SAT_VB
  if (!isPositiveFeeRate(maxFeeRate)) {
    throw new TypeError('maxFeeRate must be a finite number above 0')
  }
  if (!isRecord(estimates)) {
    throw new QbitApiError('parse', 'fee estimates were not a JSON object')
  }
  return Object.entries(estimates)
    .map(([key, feeRate]) => {
      const target = Number(key)
      if (!/^[1-9]\d*$/.test(key) || target > MAX_FEE_ESTIMATE_TARGET) {
        throw new QbitApiError(
          'parse',
          `fee estimates had a confirmation target that is not a decimal block count from 1 to ${MAX_FEE_ESTIMATE_TARGET}`
        )
      }
      if (!isPositiveFeeRate(feeRate) || feeRate > maxFeeRate) {
        throw new QbitApiError(
          'parse',
          `fee estimate for target ${target} was not a finite rate above 0 and at most ${maxFeeRate} sat/vB`
        )
      }
      return { target, feeRate }
    })
    .sort((a, b) => a.target - b.target)
}

/**
 * Transaction id of a raw transaction hex in legacy or BIP144 (witness)
 * encoding: the double SHA-256 of the witness-stripped serialization,
 * displayed byte-reversed. Throws a `parse` `QbitApiError` when the hex is not
 * a structurally complete transaction, or uses an encoding qbit Core refuses
 * to decode even where the txid would not change: a count or length (witness
 * section included) in a longer CompactSize form than its value needs or above
 * 0x02000000 (Core's MAX_SIZE), or a witness flag with every witness stack
 * empty.
 *
 * Only the structure is read: scripts, values and signatures are not checked.
 *
 * @remarks
 * See [Broadcasting](https://github.com/Qbit-Org/qbit-js/blob/main/packages/api/docs/broadcasting.md) and
 * [Response validation](https://github.com/Qbit-Org/qbit-js/blob/main/packages/api/docs/response-validation.md).
 *
 * @param rawTxHex - The transaction as hex, in either case.
 * @returns The txid as 64 lowercase hex characters.
 * @throws {@link QbitApiError} `parse` when the hex is not such a transaction.
 * @category Transactions
 */
export function txidFromRawTx(rawTxHex: string): string {
  const txid = tryTxidFromRawTx(rawTxHex)
  if (txid === undefined) {
    throw new QbitApiError('parse', 'raw transaction hex is not a well-formed transaction')
  }
  return txid
}

/**
 * `text` without the spaces, tabs, CRs and LFs around it. An index scan, since
 * a regex trim backtracks quadratically over a long whitespace run inside the
 * text, and a reply body is unbounded. Other whitespace (NBSP, ...) is kept.
 */
function trimAsciiWhitespace(text: string): string {
  let start = 0
  let end = text.length
  while (start < end && isAsciiWhitespace(text.charCodeAt(start))) start += 1
  while (end > start && isAsciiWhitespace(text.charCodeAt(end - 1))) end -= 1
  return text.slice(start, end)
}

function isAsciiWhitespace(code: number): boolean {
  return code === 0x20 || code === 0x09 || code === 0x0a || code === 0x0d
}

function tryTxidFromRawTx(rawTxHex: string): string | undefined {
  const bytes = hexToBytes(rawTxHex)
  const stripped = bytes === undefined ? undefined : witnessStrippedTx(bytes)
  if (stripped === undefined) return undefined
  return bytesToHex(sha256(sha256(stripped)).reverse())
}

/**
 * The txid a submission is tracked by: `options.txid` when given (it must be a
 * 64-hex id and agree with the hex), else the id derived from the hex, else
 * undefined when the hex is not a parseable transaction. Argument errors are
 * `TypeError`s thrown before any request is made.
 */
function resolveBroadcastTxid(rawTxHex: string, options: BroadcastTxOptions | null | undefined): string | undefined {
  if (typeof rawTxHex !== 'string') {
    throw new TypeError('broadcastTx: rawTxHex must be a hex string')
  }
  const requested = (options ?? {}).txid
  const derived = tryTxidFromRawTx(rawTxHex)
  if (requested === undefined) return derived
  const provided = typeof requested === 'string' ? requested.toLowerCase() : ''
  if (!TXID_PATTERN.test(provided)) {
    throw new TypeError('broadcastTx: options.txid must be a 64-character hex transaction id')
  }
  if (derived !== undefined && derived !== provided) {
    throw new TypeError(`broadcastTx: options.txid ${provided} does not match the transaction hex (${derived})`)
  }
  return provided
}

/** qbit Core `serialize.h` MAX_SIZE: the largest CompactSize `ReadCompactSize` accepts. */
const COMPACT_SIZE_MAX = 0x02000000

class RawTxReader {
  private offset = 0

  constructor(private readonly bytes: Uint8Array) {}

  get position(): number {
    return this.offset
  }

  get remaining(): number {
    return this.bytes.length - this.offset
  }

  skip(length: number): void {
    if (length > this.remaining) throw new RangeError('raw transaction is truncated')
    this.offset += length
  }

  readUint8(): number {
    this.skip(1)
    return this.bytes[this.offset - 1]!
  }

  /**
   * qbit Core `ReadCompactSize` with its default range check (serialize.h:330
   * at v1.0.0). Only the shortest encoding of a value is valid: a `fd` prefix
   * must carry at least 0xfd, `fe` at least 0x10000 and `ff` at least
   * 0x100000000, or Core throws `non-canonical ReadCompactSize()`. A value
   * above MAX_SIZE (serialize.h:32) fails `size too large`, so every `ff`
   * encoding fails one check or the other. Core reads every count and length
   * in a transaction this way, witness stacks included.
   */
  readCompactSize(): number {
    const first = this.readUint8()
    if (first < 0xfd) return first
    const width = first === 0xfd ? 2 : first === 0xfe ? 4 : 8
    let value = 0
    for (let i = 0; i < width; i += 1) value += this.readUint8() * 2 ** (8 * i)
    const minimum = first === 0xfd ? 0xfd : first === 0xfe ? 0x10000 : 2 ** 32
    if (value < minimum) throw new RangeError('raw transaction has a non-canonical CompactSize')
    if (value > COMPACT_SIZE_MAX) throw new RangeError('raw transaction length is too large')
    return value
  }

  skipVarBytes(): void {
    this.skip(this.readCompactSize())
  }
}

/**
 * The witness-stripped encoding of a complete transaction, or undefined when
 * the bytes are truncated, carry trailing data, use an unknown marker, encode
 * a count or length non-canonically or above MAX_SIZE, or set the witness flag
 * with every witness stack empty. qbit Core refuses the last two even though
 * the witness section does not change the txid (`non-canonical
 * ReadCompactSize()` / `size too large`, serialize.h:330-359, and
 * `Superfluous witness record`, primitives/transaction.h:237-246, at v1.0.0;
 * a stack holding one empty item is not empty, per `ComputeHasWitness`,
 * primitives/transaction.cpp:74). Structure only: script contents and counts
 * are not validated further, so any transaction a node could decode yields
 * its txid.
 */
function witnessStrippedTx(bytes: Uint8Array): Uint8Array | undefined {
  const reader = new RawTxReader(bytes)
  try {
    reader.skip(4) // version
    const witness = reader.remaining >= 2 && bytes[4] === 0x00
    if (witness) {
      if (bytes[5] !== 0x01) return undefined
      reader.skip(2) // marker + flag
    }
    const bodyStart = reader.position
    const inputCount = reader.readCompactSize()
    for (let i = 0; i < inputCount; i += 1) {
      reader.skip(36) // outpoint
      reader.skipVarBytes() // scriptSig
      reader.skip(4) // sequence
    }
    const outputCount = reader.readCompactSize()
    for (let i = 0; i < outputCount; i += 1) {
      reader.skip(8) // value
      reader.skipVarBytes() // scriptPubKey
    }
    const bodyEnd = reader.position
    if (witness) {
      let hasWitness = false
      for (let i = 0; i < inputCount; i += 1) {
        const items = reader.readCompactSize()
        if (items > 0) hasWitness = true
        for (let j = 0; j < items; j += 1) reader.skipVarBytes()
      }
      if (!hasWitness) return undefined
    }
    reader.skip(4) // locktime
    if (reader.remaining !== 0) return undefined
    if (!witness) return bytes
    const stripped = new Uint8Array(4 + (bodyEnd - bodyStart) + 4)
    stripped.set(bytes.subarray(0, 4), 0)
    stripped.set(bytes.subarray(bodyStart, bodyEnd), 4)
    stripped.set(bytes.subarray(bytes.length - 4), stripped.length - 4)
    return stripped
  } catch {
    return undefined
  }
}

function hexToBytes(hex: string): Uint8Array | undefined {
  if (hex.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(hex)) return undefined
  const bytes = new Uint8Array(hex.length / 2)
  for (let i = 0; i < bytes.length; i += 1) {
    bytes[i] = parseInt(hex.slice(2 * i, 2 * i + 2), 16)
  }
  return bytes
}

function bytesToHex(bytes: Uint8Array): string {
  let hex = ''
  for (const byte of bytes) hex += byte.toString(16).padStart(2, '0')
  return hex
}

type AddressHistoryBackend = 'esplora' | 'mempool-qbit'
type AddressHistorySource = 'confirmed' | 'mempool' | 'combined'

interface AddressHistoryScanState extends AddressHistory {
  seenTxids: Set<string>
}

function createAddressHistoryScanState(): AddressHistoryScanState {
  return {
    confirmed: [],
    mempool: [],
    seenTxids: new Set<string>(),
  }
}

/** Page fetches and raw rows one `getAddressHistory` call has used, across its scans. */
interface AddressHistoryBudget {
  pageRequests: number
  rawTransactions: number
}

function createAddressHistoryBudget(): AddressHistoryBudget {
  return { pageRequests: 0, rawTransactions: 0 }
}

/** Scans repeated because the address stats changed during the previous one. */
const MAX_ADDRESS_HISTORY_RESCANS = 1

type AddressHistoryStats = Pick<EsploraAddressStats, 'chain_stats' | 'mempool_stats'>

const ADDRESS_STATS_FIELDS = [
  'funded_txo_count',
  'funded_txo_sum',
  'spent_txo_count',
  'spent_txo_sum',
  'tx_count',
] as const

/**
 * Run `scan` between two reads of the address stats and return its history
 * only if the reads agree and it holds exactly `chain_stats.tx_count`
 * confirmed and `mempool_stats.tx_count` mempool transactions. electrs
 * returns HTTP 200 and `[]` for a cursor it cannot find (`skip_while` in
 * `ChainQuery::_history`, `src/new_index/schema.rs:1031-1060` in
 * Qbit-Org/qbit-electrs@53102e9), and both counts are of distinct txids, as
 * the history routes list them (`stats_delta`, `schema.rs:1277-1305`;
 * `Mempool::stats`, `src/new_index/mempool.rs:280-292`). A scan during which
 * the stats changed is repeated, starting from the later read.
 */
async function verifiedAddressHistory(
  address: string,
  backend: AddressHistoryBackend,
  readStats: () => Promise<unknown>,
  scan: () => Promise<AddressHistory>
): Promise<AddressHistory> {
  let before = addressHistoryStats(await readStats(), address, backend)
  for (let scans = 1; ; scans += 1) {
    const history = await scan()
    const after = addressHistoryStats(await readStats(), address, backend)
    if (!sameAddressHistoryStats(before, after)) {
      if (scans > MAX_ADDRESS_HISTORY_RESCANS) {
        throw new QbitApiError(
          'invalid_cursor',
          `${backend} address stats changed during each of ${scans} history scans: ${address}`
        )
      }
      before = after
      continue
    }
    const confirmed = after.chain_stats.tx_count
    const mempool = after.mempool_stats.tx_count
    if (history.confirmed.length !== confirmed || history.mempool.length !== mempool) {
      throw new QbitApiError(
        'invalid_cursor',
        `${backend} address history returned ${history.confirmed.length} confirmed and ${history.mempool.length} mempool transactions, but the address stats count ${confirmed} and ${mempool}: ${address}`
      )
    }
    return history
  }
}

function addressHistoryStats(value: unknown, address: string, backend: AddressHistoryBackend): AddressHistoryStats {
  if (!isRecord(value) || !hasTxCount(value['chain_stats']) || !hasTxCount(value['mempool_stats'])) {
    throw new QbitApiError(
      'parse',
      `${backend} address stats lacked a non-negative safe-integer chain or mempool tx_count: ${address}`
    )
  }
  return value as unknown as AddressHistoryStats
}

function hasTxCount(value: unknown): boolean {
  return isRecord(value) && Number.isSafeInteger(value['tx_count']) && (value['tx_count'] as number) >= 0
}

function sameAddressHistoryStats(a: AddressHistoryStats, b: AddressHistoryStats): boolean {
  return ADDRESS_STATS_FIELDS.every(
    field => a.chain_stats[field] === b.chain_stats[field] && a.mempool_stats[field] === b.mempool_stats[field]
  )
}

function positiveAddressHistoryLimit(
  value: number | undefined,
  defaultValue: number,
  name: keyof AddressHistoryOptions
): number {
  const limit = value ?? defaultValue
  if (!Number.isSafeInteger(limit) || limit < 1) {
    throw new QbitApiError('http', `${name} must be a positive integer`)
  }
  return limit
}

function assertAddressHistoryPage(value: unknown[], address: string, source: string): EsploraTx[] {
  value.forEach((tx, index) => {
    const status = isRecord(tx) ? tx['status'] : undefined
    const vin = isRecord(tx) ? tx['vin'] : undefined
    const vout = isRecord(tx) ? tx['vout'] : undefined
    if (
      !isRecord(tx) ||
      typeof tx['txid'] !== 'string' ||
      !/^[0-9a-f]{64}$/i.test(tx['txid']) ||
      !isRecord(status) ||
      typeof status['confirmed'] !== 'boolean' ||
      !Array.isArray(vin) ||
      !vin.every(isRecord) ||
      !Array.isArray(vout) ||
      !vout.every(isRecord)
    ) {
      throw new QbitApiError(
        'parse',
        `${source} address history transaction ${index} had an invalid txid, status, vin, or vout: ${address}`
      )
    }
    const spendsFromAddress = vin.some(
      input =>
        isRecord(input) &&
        isRecord(input['prevout']) &&
        addressHistoryAddressMatches(input['prevout']['scriptpubkey_address'], address)
    )
    const paysToAddress = vout.some(
      output => isRecord(output) && addressHistoryAddressMatches(output['scriptpubkey_address'], address)
    )
    if (!spendsFromAddress && !paysToAddress) {
      throw new QbitApiError('parse', `${source} address history transaction ${index} did not touch ${address}`)
    }
  })
  return value as EsploraTx[]
}

function reserveAddressHistoryTransactions(
  budget: AddressHistoryBudget,
  value: unknown,
  maxTransactions: number,
  address: string,
  backend: AddressHistoryBackend,
  source: string
): unknown[] {
  if (!Array.isArray(value)) {
    throw new QbitApiError('parse', `${source} address history was not an array: ${address}`)
  }
  budget.rawTransactions += value.length
  if (budget.rawTransactions > maxTransactions) {
    throw new QbitApiError(
      'pagination_limit',
      `${backend} address history exceeded ${maxTransactions} transactions: ${address}`
    )
  }
  return value
}

function addressHistoryAddressMatches(value: unknown, address: string): boolean {
  if (typeof value !== 'string') return false
  if (value === address) return true
  if (!isUniformCaseQbitBech32(value) || !isUniformCaseQbitBech32(address)) return false
  return value.toLowerCase() === address.toLowerCase()
}

const QBIT_BECH32_HRPS = new Set(['qb', 'tq', 'qbrt'])

function isUniformCaseQbitBech32(value: string): boolean {
  const normalized = value.toLowerCase()
  const separator = value.lastIndexOf('1')
  const hrp = normalized.slice(0, separator)
  const data = value.slice(separator + 1)
  const hasUniformCase = value === value.toLowerCase() || value === value.toUpperCase()
  return (
    separator > 0 &&
    QBIT_BECH32_HRPS.has(hrp) &&
    data.length >= 6 &&
    hasUniformCase &&
    /^[qpzry9x8gf2tvdw0s3jn54khce6mua7l]+$/i.test(data)
  )
}

function nextAddressHistoryCursor(
  txs: EsploraTx[],
  cursor: string | undefined,
  seenCursors: Set<string>,
  address: string,
  backend: AddressHistoryBackend
): string {
  const nextCursor = txs[txs.length - 1]?.txid
  if (!nextCursor) {
    throw new QbitApiError(
      'invalid_cursor',
      `${backend} address history cursor stopped advancing: (missing) (${address})`
    )
  }
  const normalizedNextCursor = nextCursor.toLowerCase()
  if (normalizedNextCursor === cursor?.toLowerCase() || seenCursors.has(normalizedNextCursor)) {
    throw new QbitApiError(
      'invalid_cursor',
      `${backend} address history cursor stopped advancing: ${nextCursor} (${address})`
    )
  }
  seenCursors.add(normalizedNextCursor)
  return nextCursor
}

function appendAddressHistoryTransactions(
  state: AddressHistoryScanState,
  txs: EsploraTx[],
  source: AddressHistorySource,
  address: string,
  backend: AddressHistoryBackend
): void {
  for (const tx of txs) {
    const normalizedTxid = tx.txid.toLowerCase()
    if (state.seenTxids.has(normalizedTxid)) {
      throw new QbitApiError('invalid_cursor', `${backend} address history repeated transaction ${tx.txid}: ${address}`)
    }
    state.seenTxids.add(normalizedTxid)

    const confirmed = isConfirmedTx(tx)
    if (source === 'confirmed' && !confirmed) {
      throw new QbitApiError(
        'parse',
        `esplora confirmed history returned an unconfirmed transaction ${tx.txid}: ${address}`
      )
    }
    if (source === 'mempool' && confirmed) {
      throw new QbitApiError('parse', `esplora mempool history returned a confirmed transaction ${tx.txid}: ${address}`)
    }

    if (confirmed) state.confirmed.push(tx)
    else state.mempool.push(tx)
  }
}

function addressHistoryPageLimitError(address: string, maxPages: number, backend: AddressHistoryBackend): QbitApiError {
  return new QbitApiError(
    'pagination_limit',
    `${backend} address history exceeded ${maxPages} page fetches: ${address}`
  )
}

function isConfirmedTx(tx: EsploraTx): boolean {
  return tx.status?.confirmed === true
}

function unknownOutcomeError(
  url: string,
  txid: string | undefined,
  reason: string,
  options: Omit<QbitApiErrorOptions, 'url' | 'txid'> = {}
): QbitApiError {
  const subject = txid === undefined ? 'the transaction' : `txid ${txid}`
  // Without a known txid an already-known reply cannot resolve, so say how to supply one.
  const resubmit = txid === undefined ? 'resubmit the same hex with its { txid }' : 'resubmit the same hex'
  return new QbitApiError(
    'unknown_outcome',
    `transaction submission outcome unknown (${reason}); ${subject} may have been accepted; ${resubmit}, and never rebuild the payment with different inputs`,
    { ...options, url, ...(txid === undefined ? {} : { txid }) }
  )
}

interface ErrorCodeEntry {
  code: string
  syscall: string | undefined
}

/**
 * True when every coded error in the chain says no connection was
 * established. `EHOSTUNREACH`/`ENETUNREACH` count only from the connect
 * syscall, since a route can also vanish after the request was written.
 */
function isPreConnectionFailure(error: unknown): boolean {
  const entries = collectErrorCodes(error, 0, [])
  return (
    entries.length > 0 &&
    entries.every(
      entry =>
        PRE_CONNECTION_ERROR_CODES.has(entry.code) ||
        (CONNECT_STAGE_ERROR_CODES.has(entry.code) && entry.syscall === 'connect')
    )
  )
}

function collectErrorCodes(error: unknown, depth: number, entries: ErrorCodeEntry[]): ErrorCodeEntry[] {
  if (!isRecord(error)) return entries
  // Too deep to judge: count it as a failure that may have reached the server,
  // so a cut-off member can't leave only pre-connection codes behind.
  if (depth > 5) {
    entries.push({ code: 'UNJUDGED', syscall: undefined })
    return entries
  }
  const nested = error['errors']
  if (Array.isArray(nested) && nested.length > 0) {
    // An AggregateError (happy eyeballs) summarises its members; judge each member.
    for (const entry of nested) collectErrorCodes(entry, depth + 1, entries)
  } else if (typeof error['code'] === 'string') {
    const syscall = error['syscall']
    entries.push({ code: error['code'], syscall: typeof syscall === 'string' ? syscall : undefined })
  }
  collectErrorCodes(error['cause'], depth + 1, entries)
  return entries
}

/**
 * Node replies meaning this exact transaction is already in the mempool or
 * chain: qbit Core's `txn-already-in-mempool`, `txn-already-known`,
 * `txn-same-nonwitness-data-in-mempool`, and RPC error -27 (already in block
 * chain / outputs already in utxo set), as relayed by esplora and mempool.
 * Conflicts with a different transaction (`txn-mempool-conflict`,
 * `bad-txns-inputs-missingorspent`) are not matched.
 */
const ALREADY_KNOWN_BROADCAST_REPLY =
  /\b(?:txn already in mempool|txn already known|txn same nonwitness data in mempool|transaction already in block ?chain|transaction outputs already in utxo set)\b/

function isAlreadyKnownBroadcastReply(reply: BroadcastReply): boolean {
  if (reply.code === -27) return true
  return ALREADY_KNOWN_BROADCAST_REPLY.test(normalizeReplyText(reply.message))
}

/**
 * A reply in which the backend reports that its own call to the node failed
 * in transit or came back unreadable, so the node may still have processed
 * it. mempool-qbit serialises the transport error code (`{"code":"ETIMEDOUT"}`,
 * `ESOCKETTIMEDOUT`, `ECONNRESET`; backend/src/rpc-api/jsonrpc.ts via
 * bitcoin.routes.ts), `-32603` when the node answered 200 with an unreadable
 * body, or `-32602` when it answered non-200 with one: qbit Core answers 500
 * for every RPC error, so that reply may have been a -27 (already confirmed)
 * as well as a rejection or an auth failure, and `sendrawtransaction` itself
 * never raises -32602. qbit-electrs answers `Connection error` once it cannot
 * reconnect to the daemon (src/daemon.rs). Codes proving the backend never
 * connected (`PRE_CONNECTION_ERROR_CODES`: `ECONNREFUSED`, `ENOTFOUND`,
 * `EAI_AGAIN`, `UND_ERR_CONNECT_TIMEOUT`) stay definite failures.
 */
function isRelayedTransportFailure(reply: BroadcastReply): boolean {
  if (typeof reply.code === 'string') return !PRE_CONNECTION_ERROR_CODES.has(reply.code)
  if (reply.code === -32603 || reply.code === -32602) return true
  return /^connection error\b/.test(normalizeReplyText(reply.message))
}

/**
 * JSON-RPC request-level codes: the server refused the request before running
 * any method (qbit Core src/rpc/protocol.h). `-32602` is left out because a
 * relaying backend reuses it for an unreadable non-200 node reply; see
 * `isRelayedTransportFailure`.
 */
const RPC_REQUEST_ERROR_CODES = new Set([-32700, -32600, -32601])

/**
 * True for an RPC error code that is the node's verdict on the request: one of
 * qbit Core's application codes (src/rpc/protocol.h defines -1 … -36; for
 * `sendrawtransaction` that is -22 `TX decode failed`, -25 verify error /
 * missing inputs, -26 rejected by network rules, -28 warming up, and the
 * parameter errors -1/-3/-8, all raised before the mempool is touched —
 * src/rpc/mempool.cpp, src/rpc/util.cpp `RPCErrorFromTransactionError`), or
 * a request-level code. `-32603` and `-32602` (mempool-qbit's markers for an
 * unreadable node reply) and the implementation-defined server-error range
 * `-32099 … -32000`, which Core never emits and proxies use for upstream
 * failures, describe the server or its transport, not the transaction.
 */
function isNodeVerdictCode(code: number): boolean {
  return (code >= -99 && code <= -1) || RPC_REQUEST_ERROR_CODES.has(code)
}

/**
 * qbit Core's literal transaction reject reasons (src/validation.cpp,
 * src/policy/policy.cpp, src/consensus/tx_check.cpp, src/rpc/mempool.cpp),
 * recognised only at the start of an uncoded reply. Reasons that are ordinary
 * words (`coinbase`, `version`) are left out so a gateway page cannot match.
 */
const DEFINITE_REJECTION_REPLY =
  /^(?:bad txns |bad witness nonstandard|bad cb length|txn mempool conflict|tx decode failed|tx size\b|tx output not p2mr|scriptsig (?:size|not pushonly)|scriptpubkey\b|bare multisig|datacarrier|dust\b|non (?:bip68 )?final|(?:mempool |block |(?:non )?mandatory )script verify flag|min relay fee not met|mempool min fee not met|insufficient fee|max feerate exceeded|mempool full|too long mempool chain|truc violation|missing ephemeral spends|bip125 replacement disallowed|too many potential replacements|replacement adds unconfirmed|missing inputs|no mempool\b)/

/**
 * A reply in which the node itself refused or rejected this submission: a
 * node verdict code, a relayed code proving the backend never connected to
 * the node, or, when the body carries no code at all, one of Core's reject
 * reasons. It is consulted only for a 5xx other than 501, 505 and 511, where
 * a match makes the reply a definite `http` error instead of an
 * `unknown_outcome`; see the outcome table in `docs/broadcasting.md`.
 * Already-known replies are resolved before this is consulted.
 */
function isDefiniteNodeRejection(reply: BroadcastReply): boolean {
  if (typeof reply.code === 'number') return isNodeVerdictCode(reply.code)
  if (typeof reply.code === 'string') return PRE_CONNECTION_ERROR_CODES.has(reply.code)
  return DEFINITE_REJECTION_REPLY.test(normalizeReplyText(reply.message))
}

/**
 * Fallback only after `/tx` reported that it did not submit: a missing route
 * or the backend's generic no-RPC-code failure. `unknown_outcome` never
 * qualifies, since the transaction may already be with the node.
 */
function shouldRetryBroadcastViaTxPush(error: unknown): boolean {
  if (!QbitApiError.is(error)) return false
  // A custom fetchFn's own QbitApiError is judged the same way, although it may
  // have been thrown after the `/tx` POST was sent; the fallback then sends the
  // same hex a second time, which is harmless.
  if (
    (error.kind === 'not_found' && error.status === 404) ||
    (error.kind === 'http' && (error.status === 405 || error.status === 501))
  ) {
    return true
  }
  // Another copy's error keeps its raw body where this copy cannot read it, and
  // its `responseBody` may be a redacted preview, so its body never qualifies.
  const body = error instanceof QbitApiError ? (rawResponseBodies.get(error) ?? error.responseBody) : undefined
  if (error.kind !== 'http' || error.status !== 400 || body === undefined) {
    return false
  }

  // mempool-qbit reserves this generic response for failures without an RPC
  // error code; a reply carrying a node RPC or transport code is never that
  // generic failure, whatever its message says.
  const reply = parseBroadcastReply(body)
  if (reply.code !== undefined) return false
  return /^(?:(?:failed|unable) to|could not) (?:send|submit|broadcast)(?: raw)? transaction$/.test(
    normalizeReplyText(reply.message)
  )
}

interface BroadcastReply {
  /**
   * Node RPC error code (a negative integer, as all of qbit Core's are) or
   * relayed transport code (upper-cased, see `TRANSPORT_ERROR_CODE_PATTERN`)
   * from a structured body. A positive number is an HTTP status echo and
   * any other string a gateway code; neither describes the node call, so
   * both are left out.
   */
  code: number | string | undefined
  /** Human-readable detail: the structured body's message, or the body itself. */
  message: string
}

/**
 * Read a rejection body into its error code and message. Backends answer in
 * several shapes: plain text, optionally with an embedded
 * `sendrawtransaction RPC error: {"code":...,"message":...}` object (esplora,
 * mempool-qbit); the node's JSON-RPC envelope `{"error":{"code","message"}}`;
 * a flat `{"code","message"}` object; or a JSON string / `{"error":"..."}` /
 * `{"message":"..."}` wrapper around the plain-text form. The code is taken
 * from the structured object before the body is reduced to its message, since
 * the code is authoritative while the message may be localised or reworded.
 * A nested `error.code` wins over a top-level `code`.
 */
function parseBroadcastReply(body: string): BroadcastReply {
  let text = body
  try {
    const parsed = JSON.parse(body) as unknown
    if (typeof parsed === 'string') {
      text = parsed
    } else if (isRecord(parsed)) {
      const nested = parsed['error']
      const code = errorCodeOf(nested) ?? errorCodeOf(parsed)
      let message = body
      if (typeof nested === 'string') message = nested
      else if (isRecord(nested) && typeof nested['message'] === 'string') message = nested['message']
      else if (typeof parsed['message'] === 'string') message = parsed['message']
      // A JSON wrapper around the plain-text form still carries the code in that text.
      return { code: code ?? embeddedErrorCode(message), message }
    }
  } catch {
    // Plain-text backend errors are expected here.
  }
  return { code: embeddedErrorCode(text), message: text }
}

function errorCodeOf(value: unknown): number | string | undefined {
  if (!isRecord(value)) return undefined
  const code = value['code']
  if (typeof code === 'number') return Number.isInteger(code) && code < 0 ? code : undefined
  if (typeof code !== 'string') return undefined
  const transportCode = code.toUpperCase()
  return TRANSPORT_ERROR_CODE_PATTERN.test(transportCode) ? transportCode : undefined
}

/**
 * Code from an esplora/mempool `sendrawtransaction RPC error: {"code":...}`
 * object embedded in plain text: a number for node RPC errors, or a string
 * when mempool-qbit relays its own transport failure (`{"code":"ETIMEDOUT"}`).
 */
function embeddedErrorCode(text: string): number | string | undefined {
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start === -1 || end <= start) return undefined
  try {
    const parsed = JSON.parse(text.slice(start, end + 1)) as unknown
    if (isRecord(parsed)) return errorCodeOf(parsed['error']) ?? errorCodeOf(parsed)
  } catch {
    // Not an RPC error object; the caller falls back to message matching.
  }
  return undefined
}

function normalizeReplyText(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** `Retry-After` (delta-seconds or HTTP-date) as a non-negative, finite whole number of ms. */
function parseRetryAfter(value: string | null): number | undefined {
  if (!value) return undefined
  let ms: number
  const seconds = Number(value)
  // Overlong delta-seconds overflow to Infinity; keep them as "too long", not unparseable.
  if (!Number.isNaN(seconds)) {
    ms = seconds * 1000
  } else {
    const date = Date.parse(value)
    if (!Number.isFinite(date)) return undefined
    ms = date - Date.now()
  }
  return Math.min(Math.max(0, Math.ceil(ms)), Number.MAX_SAFE_INTEGER)
}

function isAbortError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { name?: string }).name === 'AbortError'
}

/** `localhost`, `127.0.0.0/8` or `[::1]`, as normalized by the URL parser (`127.1` is `127.0.0.1`). */
function isLoopbackHostname(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '[::1]' || /^127\.\d+\.\d+\.\d+$/.test(hostname)
}

/** Ports a URL parser drops from a URL with this scheme. */
const DEFAULT_PORTS: Record<string, string> = {
  'http:': '80',
  'https:': '443',
  'ws:': '80',
  'wss:': '443',
  'ftp:': '21',
}

/**
 * The lowercased scheme and host of a URL with a scheme, without userinfo or
 * one trailing dot, whether it has userinfo (an `@` in the authority), its
 * port (empty for the scheme's default) and its path with the query (`/` for
 * an empty path, without the fragment); undefined for a relative URL that
 * `base` does not resolve. A runtime URL parser that
 * follows the URL Standard canonicalizes first (`127.1`, IDN, `[0::1]`, dot
 * segments, percent-encoding), but the parts are read by hand: React Native's
 * global URL throws from `protocol` and `hostname` before 0.80, and from 0.80
 * reads them with regexes that neither lowercase nor end the authority at the
 * first `/`, so `https://evil.example/@host` would have the hostname `host`.
 * There the configured spelling is read, since its `href` appends a `/`.
 */
function schemeAndHost(
  url: string,
  base?: string
): { protocol: string; hostname: string; userinfo: boolean; port: string; path: string } | undefined {
  const match = /^([a-z][a-z\d+.-]*:)[/\\]*([^/?#\\]*)([^#]*)/i.exec(standardHref(url, base) ?? url)
  if (!match) return undefined
  const protocol = match[1]!.toLowerCase()
  const at = match[2]!.lastIndexOf('@')
  const authority = match[2]!.slice(at + 1)
  const [, hostname, port] = /^(\[[^\]]*\]|[^:]*):?(.*)$/s.exec(authority)!
  return {
    protocol,
    hostname: hostname!.toLowerCase().replace(/\.$/, ''),
    userinfo: at !== -1,
    port: port === DEFAULT_PORTS[protocol] ? '' : port!,
    path: match[3]!.startsWith('/') ? match[3]! : `/${match[3]!}`,
  }
}

/**
 * `new URL(url, base).href` where the runtime's URL parser follows the URL
 * Standard; undefined where it does not parse `url`, and on React Native.
 */
function standardHref(url: string, base?: string): string | undefined {
  if (!followsUrlStandard()) return undefined
  try {
    return new URL(url, base).href
  } catch {
    return undefined
  }
}

/**
 * Whether the runtime's URL parser follows the URL Standard (Node, browsers,
 * Deno, Bun). React Native's does not: its `href` is the input with a `/`
 * appended, and its other getters throw before 0.80.
 */
function followsUrlStandard(): boolean {
  try {
    return new URL('HTTP://Q.EXAMPLE:80/a/../b').href === 'http://q.example/b'
  } catch {
    return false
  }
}

/**
 * True when `response.url` is not the requested URL: another scheme, host,
 * port, or path and query. React Native's fetch ignores `redirect: 'manual'`:
 * the platform follows the redirect and the reply arrives with the final URL
 * in `url` but without `redirected`. A redirect within the backend is refused
 * too, since its reply answers another request (another transaction's status,
 * say). Both URLs are read with `schemeAndHost`, so the case of the scheme and
 * host, a default port and a trailing dot on the host do not count. When
 * either URL cannot be read, the reply counts as from another URL.
 */
function fromAnotherUrl(response: Response, url: string): boolean {
  if (typeof response.url !== 'string' || response.url === '') return false
  const requested = schemeAndHost(url)
  const replied = schemeAndHost(response.url)
  if (!requested || !replied) return true
  return (
    replied.protocol !== requested.protocol ||
    replied.hostname !== requested.hostname ||
    replied.port !== requested.port ||
    replied.path !== requested.path
  )
}

/**
 * Requests use `redirect: 'manual'`, so a redirect arrives here as a 3xx, or in
 * browsers as an `opaqueredirect` with status 0. Following it would send the
 * configured headers wherever `Location` points and accept that server's reply
 * as backend data. A fetch that ignores `redirect` and follows anyway reports
 * `redirected`, or a `url` other than the request's; its reply is refused too.
 */
function refuseRedirect(response: Response, url: string, baseUrl: string): Response {
  const opaque = response.type === 'opaqueredirect'
  const redirectStatus = response.status >= 300 && response.status <= 399
  if (!opaque && !redirectStatus && response.redirected !== true && !fromAnotherUrl(response, url)) {
    return response
  }
  void discardResponseBody(response)
  const errorUrl = redactBaseUrl(url, baseUrl)
  if (opaque) {
    throw new QbitApiError('http', `redirect refused (target hidden by the browser): ${errorUrl}`, { url: errorUrl })
  }
  if (redirectStatus) {
    const target = redactRedirectTarget(redirectTargetOrigin(response.headers.get('location'), url), baseUrl)
    throw new QbitApiError('http', `HTTP ${response.status} redirect to ${target} refused: ${errorUrl}`, {
      status: response.status,
      url: errorUrl,
    })
  }
  const target = redactRedirectTarget(redirectTargetOrigin(response.url, url), baseUrl)
  throw new QbitApiError('http', `fetch followed a redirect to ${target}; reply discarded: ${errorUrl}`, {
    url: errorUrl,
  })
}

/**
 * A redirect target as its origin only; its path and query may carry tokens.
 * Read with `schemeAndHost`, not the runtime's `origin`: React Native's throws
 * before 0.80 and from 0.80 keeps userinfo and a query. Where the runtime
 * cannot resolve a relative location, a scheme-relative one keeps the
 * request's scheme and any other keeps its origin.
 */
function redirectTargetOrigin(location: string | null, url: string): string {
  if (!location) return 'an unspecified location'
  const target =
    schemeAndHost(location, url) ??
    schemeAndHost(/^[/\\]{2}/.test(location) ? `${schemeAndHost(url)?.protocol ?? ''}${location}` : url)
  if (!target) return 'an invalid location'
  if (!/^(?:https?|wss?|ftp):$/.test(target.protocol)) return `a ${target.protocol} URL`
  if (!/^(?:[a-z\d._~-]+|\[[a-f\d:.]+\])$/.test(target.hostname) || !/^\d*$/.test(target.port)) {
    return 'an invalid location'
  }
  return `${target.protocol}//${target.hostname}${target.port ? `:${target.port}` : ''}`
}

/**
 * The base URL as errors show it: its origin, with `/...` in place of any path
 * or query, where hosted indexers often put an API token
 * (`https://host/<token>/api`). Errors get logged and reported. Read by hand
 * after the runtime's URL parser has normalized it, as in `schemeAndHost`:
 * React Native's `origin` throws before 0.80 and keeps credentials from 0.80.
 * `...` alone when the host cannot be read reliably.
 */
function redactedBaseUrl(baseUrl: string): string {
  let href = baseUrl
  try {
    href = new URL(baseUrl).href
  } catch {
    // Not parsable here: read the configured spelling.
  }
  const match = /^(https?:)[/\\]*([^/?#\\]*)/i.exec(href)
  if (!match) return '...' // Not an http(s) URL: show none of it.
  const host = match[2]!.slice(match[2]!.lastIndexOf('@') + 1).toLowerCase()
  // A password with a raw `/`, `?`, `#` or `\` ends the authority early, so
  // the host read can be `user:password-prefix`, or (`apikey:8443/x@host`) a
  // username and a numeric password the URL parser takes for host and port.
  // Show only a plain host[:port] with no `@` after it.
  if (!/^(?:[a-z\d._~-]+|\[[a-f\d:.]+\])(?::\d*)?$/.test(host) || href.slice(match[0].length).includes('@')) {
    return '...'
  }
  const origin = `${match[1]!.toLowerCase()}//${host}`
  return basePath(href) ? `${origin}/...` : origin
}

/**
 * `text` with the base URL replaced by `redactedBaseUrl`, both as configured
 * and as the URL parser normalizes it: fetch implementations quote either form
 * in their own error messages. The base URL's path and query become `/...`
 * where they appear on their own, as servers quote the request path (Express:
 * `Cannot GET /<token>/api/blocks/tip/height`), and each of `baseUrlParts`
 * becomes `...`, as a server may quote a token alone. One pass, longest match
 * first, so replaced text is not matched again.
 */
function redactBaseUrl(text: string, baseUrl: string): string {
  const spellings = [baseUrl]
  try {
    spellings.push(new URL(baseUrl).href.replace(/\/+$/, ''))
  } catch {
    // Unparsable: only the configured spelling can appear.
  }
  const redacted = redactedBaseUrl(baseUrl)
  const replacements = new Map<string, string>()
  for (const part of spellings.flatMap(baseUrlParts)) replacements.set(part, '...')
  for (const path of spellings.map(basePath)) if (path) replacements.set(path, '/...')
  for (const spelling of spellings) if (spelling) replacements.set(spelling, redacted)
  if (replacements.size === 0) return text
  const pattern = [...replacements.keys()]
    .sort((a, b) => b.length - a.length)
    .map(needle => needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('|')
  return text.replace(new RegExp(pattern, 'g'), match => replacements.get(match)!)
}

/**
 * Parts of a base URL that a server may quote on their own (`invalid api key
 * <token>`, a JSON-escaped `\/<token>\/` or `%2F`-joined path): each path
 * segment, query value and userinfo part of at least 8 characters, also
 * percent-decoded. Userinfo runs to the last `@` before the query, so a
 * password with a raw `/` is found whole, and path segments are read both
 * after the authority and after that `@`.
 */
function baseUrlParts(url: string): string[] {
  const match = /^(?:[a-z][a-z\d+.-]*:[/\\]*)?([^?#]*)(?:\?([^#]*))?/i.exec(url)!
  const beforeQuery = match[1]!
  const at = beforeQuery.lastIndexOf('@')
  const userinfo = at === -1 ? '' : beforeQuery.slice(0, at)
  const colon = userinfo.indexOf(':')
  const parts = [
    ...(colon === -1 ? [userinfo] : [userinfo.slice(0, colon), userinfo.slice(colon + 1)]),
    ...beforeQuery.split(/[/\\]/).slice(1),
    ...beforeQuery
      .slice(at + 1)
      .split(/[/\\]/)
      .slice(1),
    ...(match[2] ?? '').split('&').map(pair => pair.slice(pair.indexOf('=') + 1)),
  ]
  return parts.flatMap(part => [part, percentDecoded(part)]).filter(part => part.length >= 8)
}

function percentDecoded(text: string): string {
  try {
    return decodeURIComponent(text)
  } catch {
    return text
  }
}

/** What follows the origin of an absolute URL; empty for a bare origin or a relative URL. */
function basePath(url: string): string {
  const path = /^[a-z][a-z\d+.-]*:[/\\]*[^/?#\\]*(.*)$/i.exec(url)?.[1] ?? ''
  return path === '/' ? '' : path
}

/**
 * A redirect target's origin with the base URL's parts redacted. The server
 * chose it, and a provider that moves a key from the path into a subdomain
 * would put the key in the message. Hosts are lowercased, so parts are matched
 * case-insensitively.
 */
function redactRedirectTarget(target: string, baseUrl: string): string {
  const redacted = redactBaseUrl(target, baseUrl)
  const parts = [...new Set(baseUrlParts(baseUrl))].sort((a, b) => b.length - a.length)
  if (parts.length === 0) return redacted
  const pattern = parts.map(part => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')
  return redacted.replace(new RegExp(pattern, 'gi'), '...')
}

/** A response body preview: trimmed, the base URL redacted, capped at 200 characters. */
function responseBodyPreview(text: string, baseUrl: string): string {
  return redactBaseUrl(text.trim(), baseUrl).slice(0, 200)
}

/** Response text quoted in an error message: `responseBodyPreview` with control characters escaped. */
function quotedResponseText(text: string, baseUrl: string): string {
  return escapeControlChars(responseBodyPreview(text, baseUrl))
}

/** How many levels of nested errors and objects a redacted cause keeps. */
const REDACTED_CAUSE_DEPTH = 5

/** Built-in error classes a redacted cause keeps, so `cause instanceof TypeError` still holds. */
const NATIVE_ERRORS: (new (message?: string) => Error)[] = [
  Error,
  TypeError,
  RangeError,
  SyntaxError,
  ReferenceError,
  EvalError,
  URIError,
]

/** `QbitApiError` options for an underlying error: a redacted `cause`, the original kept off the error. */
function causeOptions(cause: unknown, baseUrl: string): { cause: unknown; unredactedCause: unknown } {
  return { cause: redactedCause(cause, baseUrl, REDACTED_CAUSE_DEPTH), unredactedCause: cause }
}

/**
 * A copy of an underlying error that is safe to log. Fetch implementations put
 * the full request URL in their errors (Bun's `path`, Node's messages for a
 * credentialed or relative URL, node-fetch's), and loggers print `cause`
 * (`console.error`, `util.inspect`, Sentry, pino). Strings pass through
 * `redactBaseUrl`: the message, the stack and every string property. Errors
 * (a nested `cause` included), arrays and plain objects are copied the same
 * way, `depth` levels deep, keeping each property's enumerability; deeper
 * values, accessors and other objects are left out. An error keeps its
 * `name`, and its class when that is a built-in one.
 */
function redactedCause(value: unknown, baseUrl: string, depth: number): unknown {
  if (typeof value === 'string') return redactBaseUrl(value, baseUrl)
  if (typeof value === 'function') return undefined
  if (typeof value !== 'object' || value === null) return value
  if (depth === 0) return undefined
  if (Array.isArray(value)) return value.map(item => redactedCause(item, baseUrl, depth - 1))
  try {
    let copy: object
    const prototype: unknown = Object.getPrototypeOf(value)
    if (value instanceof Error) {
      const ErrorClass = NATIVE_ERRORS.find(errorClass => errorClass === value.constructor) ?? Error
      const error = new ErrorClass(redactBaseUrl(String(value.message), baseUrl))
      if (error.name !== value.name) {
        Object.defineProperty(error, 'name', { value: String(value.name), writable: true, configurable: true })
      }
      error.stack =
        typeof value.stack === 'string' ? redactBaseUrl(value.stack, baseUrl) : `${error.name}: ${error.message}`
      copy = error
    } else if (prototype === Object.prototype || prototype === null) {
      copy = {}
    } else {
      return undefined
    }
    for (const key of Object.getOwnPropertyNames(value)) {
      if (value instanceof Error && (key === 'message' || key === 'stack')) continue
      const descriptor = Object.getOwnPropertyDescriptor(value, key)
      if (descriptor === undefined || !('value' in descriptor)) continue
      const redacted = redactedCause(descriptor.value, baseUrl, depth - 1)
      if (redacted === undefined && descriptor.value !== undefined) continue
      Object.defineProperty(copy, key, {
        value: redacted,
        enumerable: descriptor.enumerable ?? false,
        writable: true,
        configurable: true,
      })
    }
    return copy
  } catch {
    return undefined
  }
}

/**
 * Response text for an error message, with control characters (CR and LF
 * included), Unicode line separators and bidi controls escaped so a hostile
 * body cannot forge or reorder log lines. `responseBody` keeps them unescaped.
 */
function escapeControlChars(text: string): string {
  return text.replace(/[\p{Cc}\p{Zl}\p{Zp}\p{Bidi_Control}]/gu, char => {
    if (char === '\n') return '\\n'
    if (char === '\r') return '\\r'
    if (char === '\t') return '\\t'
    return `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`
  })
}

function formatErrorCause(error: unknown): string {
  if (error instanceof Error) {
    return ` (${error.name}: ${error.message})`
  }
  if (typeof error === 'string') {
    return ` (${error})`
  }
  return ''
}

/**
 * Read a call's response body as text through `readBodyUntilAborted`, the one
 * body reader. If `signal` aborts first, reject at once with the call's
 * `aborted` / `timeout` error and cancel the body (best-effort, never
 * awaited); a failed read is `parse`. fetchOnce has already buffered the
 * response, so a de-duplicated GET's clone reads from memory. `url` is the
 * request URL as errors show it.
 */
async function readBody(response: Response, url: string, baseUrl: string, signal: AbortSignal): Promise<string> {
  if (signal.aborted) {
    const error = abortErrorFor(signal)
    void discardResponseBody(response, error)
    throw error
  }
  try {
    return await readBodyUntilAborted(response, signal)
  } catch (cause) {
    if (signal.aborted) throw abortErrorFor(signal)
    throw bodyReadError(response, cause, url, baseUrl)
  }
}

function bodyReadError(response: Response, cause: unknown, url: string, baseUrl: string): QbitApiError {
  return new QbitApiError('parse', `failed to read response body from ${url}`, {
    url,
    status: response.status,
    ...causeOptions(cause, baseUrl),
  })
}

/**
 * Read the whole body as text, giving up as soon as `signal` aborts. The
 * stream is cancelled on failure, so a body that stalls after the headers
 * releases its connection even if the fetch implementation ignores the signal.
 */
async function readBodyUntilAborted(response: Response, signal: AbortSignal): Promise<string> {
  let rejectAborted: (reason: unknown) => void = () => {}
  const aborted = new Promise<never>((_, reject) => {
    rejectAborted = reject
  })
  // Every path below races `aborted`; this only guards an early synchronous throw.
  aborted.catch(() => {})
  const onAbort = () => rejectAborted(signal.reason)
  if (signal.aborted) onAbort()
  else signal.addEventListener('abort', onAbort, { once: true })

  try {
    const body = response.body
    if (!body || typeof body.getReader !== 'function' || typeof TextDecoder !== 'function') {
      try {
        return await Promise.race([response.text(), aborted])
      } catch (error) {
        if (signal.aborted) releaseBody(body, signal.reason)
        throw error
      }
    }
    const reader = body.getReader()
    const decoder = new TextDecoder()
    let text = ''
    try {
      while (true) {
        const chunk = await Promise.race([reader.read(), aborted])
        if (chunk.done) return text + decoder.decode()
        text += decoder.decode(chunk.value, { stream: true })
      }
    } catch (error) {
      reader.cancel(error).catch(() => {
        // Cancellation is best-effort; the read failure remains authoritative.
      })
      throw error
    }
  } finally {
    signal.removeEventListener('abort', onAbort)
  }
}

/**
 * Best-effort, non-blocking release of a body whose `text()` lost the race to
 * the deadline, for a fetch implementation that ignores the signal once the
 * headers have arrived. A web stream is cancelled (a no-op if `text()` holds
 * its lock). A Node-style stream is destroyed with the reason, which settles
 * a consumer such as `text()` that listens for `'error'`; with no `'error'`
 * listener it is destroyed without one, since an unhandled `'error'` event
 * would crash the process.
 */
function releaseBody(body: unknown, reason: unknown): void {
  if (body === null || typeof body !== 'object') return
  const stream = body as { cancel?: unknown; destroy?: unknown; listenerCount?: unknown }
  try {
    if (typeof stream.cancel === 'function') {
      const result = stream.cancel(reason) as { then?: unknown } | null | undefined
      if (result && typeof result.then === 'function') (result as PromiseLike<unknown>).then(undefined, () => {})
    } else if (typeof stream.destroy === 'function') {
      const handled = typeof stream.listenerCount === 'function' && Number(stream.listenerCount('error')) > 0
      if (handled) stream.destroy(reason)
      else stream.destroy()
    }
  } catch {
    // Cleanup is best-effort; the timeout remains authoritative.
  }
}

/** Statuses whose responses carry no body; `new Response` rejects one for them. */
const NULL_BODY_STATUSES = new Set([204, 205, 304])

/**
 * A fully buffered copy of `response`. A custom `fetchFn` (node-fetch on old
 * Node, React Native polyfills) may run where there is no global `Response`,
 * or one that rejects the fetched status, so this falls back to a minimal
 * Response-like object instead of failing the attempt.
 */
function bufferedResponse(response: Response, text: string): Response {
  const body = NULL_BODY_STATUSES.has(response.status) ? null : text
  const buffered = constructedResponse(response, body) ?? plainBufferedResponse(response, body ?? '')
  // Constructed responses (and their clones) have an empty `url`; keep the
  // fetched one for errors, including on clones handed to de-duplicated GETs.
  // `headers` stays the fetched object, which may be a foreign or minimal
  // `Headers`, so it is never handed to the constructor to re-parse.
  Object.defineProperties(buffered, {
    url: { value: response.url },
    headers: { value: response.headers },
    clone: { value: () => bufferedResponse(response, text) },
  })
  return buffered
}

function constructedResponse(response: Response, body: string | null): Response | undefined {
  if (typeof Response !== 'function') return undefined
  try {
    return new Response(body, { status: response.status, statusText: response.statusText })
  } catch {
    return undefined
  }
}

/**
 * The subset of `Response` the client and `request()` callers rely on:
 * status fields, `text()`/`json()` with single-use `bodyUsed` semantics, and
 * (added by the caller) `url`, `headers` and `clone()`. `body` is `null`, as
 * there is no stream to read or cancel.
 */
function plainBufferedResponse(response: Response, text: string): Response {
  let bodyUsed = false
  const consume = async (): Promise<string> => {
    if (bodyUsed) throw new TypeError('Body has already been consumed')
    bodyUsed = true
    return text
  }
  return {
    status: response.status,
    statusText: response.statusText,
    ok: response.status >= 200 && response.status <= 299,
    redirected: response.redirected ?? false,
    type: response.type ?? 'default',
    body: null,
    get bodyUsed() {
      return bodyUsed
    },
    text: consume,
    json: async () => JSON.parse(await consume()) as unknown,
  } as unknown as Response
}

async function discardResponseBody(response: Response, reason?: unknown): Promise<void> {
  if (response.body === null || response.bodyUsed) return
  try {
    await response.body.cancel(reason)
  } catch {
    // Cleanup is best-effort; the retry result remains authoritative.
  }
}

/** A reply as error messages quote it: `url` redacted, `detail` a `responseBodyPreview`. */
function httpReplyMessage(status: number, url: string, detail: string): string {
  return `HTTP ${status} from ${url}${detail ? `: ${escapeControlChars(detail)}` : ''}`
}

/**
 * Unredacted response previews, keyed by error. Only the SDK's own decisions
 * read them (the `/tx/push` fallback): redaction can rewrite words of a reply
 * when a base-URL part matches them.
 */
const rawResponseBodies = new WeakMap<QbitApiError, string>()

function httpError(response: Response, body: string, url: string, baseUrl: string): QbitApiError {
  const status = response.status
  const detail = responseBodyPreview(body, baseUrl)
  const message = httpReplyMessage(status, url, detail)
  const options: QbitApiErrorOptions = { status, url, responseBody: detail }
  const retryAfterMs = parseRetryAfter(response.headers.get('retry-after'))
  if (retryAfterMs !== undefined) options.retryAfterMs = retryAfterMs
  const error =
    status === 429
      ? new QbitApiError('rate_limit', message, options)
      : status === 413
        ? new QbitApiError('payload_too_large', message, options)
        : status === 404
          ? new QbitApiError('not_found', message, options)
          : new QbitApiError('http', message, options)
  rawResponseBodies.set(error, body.trim().slice(0, 200))
  return error
}

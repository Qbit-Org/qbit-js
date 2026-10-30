import type {
  AddressHistory,
  AddressHistoryOptions,
  BroadcastTxOptions,
  EsploraAddressStats,
  EsploraFeeEstimates,
  EsploraTx,
  EsploraTxStatus,
  EsploraUtxo,
  RequestOptions,
} from './index'
import {
  causeOptions,
  detachedParseError,
  formatErrorCause,
  QbitApiError,
  quotedResponseText,
  redactBaseUrl,
  redactedBaseUrl,
  responseBodyPreview,
} from './errors'
import { tryTxidFromRawTx } from './raw-tx'
import {
  type AddressHistoryBudget,
  addressHistoryPageLimitError,
  appendAddressHistoryTransactions,
  assertAddressHistoryPage,
  createAddressHistoryBudget,
  createAddressHistoryScanState,
  DEFAULT_MAX_ADDRESS_HISTORY_PAGES,
  DEFAULT_MAX_ADDRESS_HISTORY_TRANSACTIONS,
  nextAddressHistoryCursor,
  positiveAddressHistoryLimit,
  reserveAddressHistoryTransactions,
  TXID_PATTERN,
  verifiedAddressHistory,
} from './validation'
import {
  type AddressBalance,
  addressBalanceFromStats,
  type DEFAULT_MAX_FEE_RATE_SAT_VB,
  type FeeRateTier,
  feeTiersFromEstimates,
  resolveBroadcastTxid,
  trimAsciiWhitespace,
} from './adapters'
import {
  abortErrorFor,
  BodyLimitExceeded,
  bodyReadError,
  bufferedResponse,
  bufferedText,
  defaultSleep,
  discardResponseBody,
  httpError,
  httpReplyMessage,
  internalAbortController,
  isAbortError,
  isUnshared,
  MAX_TIMER_DELAY_MS,
  openOperationScope,
  parseRetryAfter,
  raceAbort,
  readBody,
  readBodyUntilAborted,
  refuseRedirect,
  sendUnshared,
  validBaseUrl,
} from './transport'
import {
  isAlreadyKnownBroadcastReply,
  isBroadcastVerdictReply,
  isDefiniteNodeRejection,
  isPreConnectionFailure,
  isRelayedTransportFailure,
  parseBroadcastReply,
  unknownOutcomeError,
} from './broadcast'
import type { MempoolQbitClient } from './mempool-qbit-client'

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
 * `timeoutMs`, `retries`, `retryBaseDelayMs`, `maxRetryAfterMs` and
 * `maxResponseBytes` reject `null`; only an omitted option takes its default.
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
   * `http` URL also needs a loopback host or `allowInsecureHttp`. Where the
   * runtime's URL parser does not follow the URL Standard (React Native), the
   * whole URL must be ASCII and encoded: give an internationalized host in
   * its punycode (`xn--`) form, and write every other character RFC 3986
   * allows only percent-encoded as the `%XX` escapes of its UTF-8 bytes.
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
   * an error was thrown, so it takes the error at its word. A
   * `response_too_large` says a reply arrived, so on a submission it becomes
   * an `unknown_outcome`, as `network`, `timeout` and `aborted` do. A kind
   * other than those four propagates as it is: an `http`,
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
   * and 511 included, and a reply over `maxResponseBytes`, fails at once.
   * Submissions repeat only attempts that provably were not processed (a 429
   * within `maxRetryAfterMs` whose body was read in full and is neither an
   * already-known reply nor a relayed transport failure, or a connection
   * failure before anything was sent); see the
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
   * could not be read, which throws `parse`, or exceeded `maxResponseBytes`,
   * which throws `response_too_large`, both without `retryAfterMs`. A submission's
   * 429 is not re-sent then, and is judged by its body first, as the
   * [outcome table](https://github.com/Qbit-Org/qbit-js/blob/main/packages/api/docs/broadcasting.md#outcomes) says.
   */
  maxRetryAfterMs?: number
  /**
   * Largest response body the client reads, in bytes (default
   * {@link DEFAULT_MAX_RESPONSE_BYTES}; an integer from 1 to
   * 9007199254740991). Every reply's body is counted as it arrives, after any
   * content decoding, error replies included; once it passes the limit the
   * client cancels the body and stops reading. A read then fails with
   * `response_too_large` and is not retried, since the backend would send the
   * same body again. Concurrent identical reads share one request, and so one
   * limit and one copy of the body. A submission's reply over the limit, a
   * `429` included, is `unknown_outcome` and is not re-sent, since the node
   * may have accepted the transaction; see the
   * [outcome table](https://github.com/Qbit-Org/qbit-js/blob/main/packages/api/docs/broadcasting.md#outcomes).
   * The limit stops the download of a body that is a WHATWG `ReadableStream`
   * or an async iterable of bytes, such as node-fetch's Node `Readable`. Where
   * the response has neither (React Native's fetch), the whole body is read
   * with `blob()`, whose `size` is checked before its text is read, or else
   * `arrayBuffer()`, so the limit fails the call but cannot stop the download;
   * `timeoutMs` still bounds it. A Response-like object with only `text()` is
   * measured as its text's UTF-8 encoding.
   */
  maxResponseBytes?: number
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

const TRANSIENT_STATUSES = new Set([429, 500, 502, 503, 504])
const IDEMPOTENT_METHODS = new Set(['GET', 'HEAD'])
/** 5xx replies that mean the server did not process the request at all. */
const UNPROCESSED_SERVER_ERROR_STATUSES = new Set([501, 505, 511])
const DEFAULT_MAX_RETRY_AFTER_MS = 30_000
const MAX_RETRIES = 10

// Derived from the largest legitimate replies, in qbit Core at
// 7ebcddb622d6e639041f005a189b048ec2a221fe and Qbit-Org/qbit-electrs@53102e9:
// - `/tx/:txid/hex` is the transaction's hex (qbit-electrs src/rest.rs:1432).
//   A block holds at most MAX_BLOCK_SERIALIZED_SIZE = 2,000,000 bytes (Core
//   src/consensus/consensus.h:13), so a mined transaction's hex is under
//   4,000,000 characters, and a relayed one's at most 800,000: 2 per byte of
//   MAX_STANDARD_TX_WEIGHT = 400,000 (src/policy/policy.h:37), which is its
//   size, as qbit has no witness discount (consensus.h:22). The stats, a
//   status, the fee estimates, the tip and a submission's reply are under
//   1 kB, and `/address/:a/utxo` about 137 kB for the 500 confirmed outputs
//   `--utxos-limit` allows (qbit-electrs src/config.rs:361-365), plus about
//   150 bytes per mempool output.
// - Transaction JSON (TransactionValue, qbit-electrs src/rest.rs:158-320)
//   repeats each input's prevout, writes every script and witness item as
//   hex, and every script again as asm, up to 23 characters a byte
//   (OP_CHECKTEMPLATEVERIFY, src/util/script.rs:26): about 25 characters per
//   byte of the transaction at worst. Prevouts stay small, as outputs can only
//   be P2MR, OP_RETURN or anchors (fRestrictedOutputMode, Core
//   src/consensus/restricted_outputs.h:33-39). So a 2 MB mined transaction is
//   at most about 50 MB of JSON (one OP_RETURN output of 0xbb bytes). The
//   largest standard spend, 106 single-key P2MR inputs of 3,763 bytes
//   (P2MR_V1_SINGLE_KEY_SPEND_SIZE, Core src/script/p2mr_sizing.h:40), is
//   about 0.86 MB of JSON, and a standard transaction paying 9,214 P2MR
//   outputs about 3.2 MB.
// - Pages: `/txs/chain` lists 25 transactions and `/txs/mempool` 50
//   (qbit-electrs src/config.rs:385-395, src/rest.rs:1158,1336), and the
//   combined `/txs` route, which mempool-qbit passes through
//   (backend/src/api/bitcoin/esplora-api.ts `$getAddressTransactions`), 50
//   rows (src/rest.rs:958). 50 of the largest standard spends are about 43 MB.
// 64 MiB (67,108,864 bytes) holds the largest of these, the 50 MB transaction
// and the 43 MB page, with at least a third to spare. A page of 50 large batch
// payouts (about 160 MB), or of transactions built to inflate their asm, does
// not fit; a client for such an address must raise maxResponseBytes.

/**
 * The default {@link EsploraClientOptions.maxResponseBytes}: 64 MiB
 * (67,108,864 bytes). It holds every reply qbit-electrs and mempool-qbit
 * serve about one transaction, for any transaction a block can hold, and a
 * full page of address history (25 or 50 transactions) of the largest
 * standard spends. A page of large batch payouts or of transactions built to
 * inflate qbit-electrs's JSON can exceed it; pass a larger
 * `maxResponseBytes` for such addresses, or a smaller one on a device with
 * little memory.
 *
 * @remarks
 * See [Configuration](https://github.com/Qbit-Org/qbit-js/blob/main/packages/api/docs/configuration.md#response-size-limit).
 *
 * @category Configuration
 */
export const DEFAULT_MAX_RESPONSE_BYTES = 64 * 1024 * 1024

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
  private readonly maxResponseBytes: number
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
   *   accepted URL, or `timeoutMs`, `retries`, `retryBaseDelayMs`,
   *   `maxRetryAfterMs` or `maxResponseBytes` is out of range; `network` when
   *   `fetchFn` is given and is not a function, or when it is omitted
   *   (`undefined` or `null`) and the global `fetch` is not one.
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
    const maxResponseBytes = integerOption(
      options.maxResponseBytes,
      DEFAULT_MAX_RESPONSE_BYTES,
      'maxResponseBytes',
      1,
      Number.MAX_SAFE_INTEGER
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
    this.maxResponseBytes = maxResponseBytes
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
   *   refused redirect; `network`; `timeout`; `aborted`; `response_too_large`
   *   for a reply over `maxResponseBytes`), or `parse` when the reply is not
   *   JSON or cannot be read.
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
   *   refused redirect; `network`; `timeout`; `aborted`; `response_too_large`
   *   for a reply over `maxResponseBytes`), or `parse` when the reply is not
   *   JSON or cannot be read.
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
   *   refused redirect; `network`; `timeout`; `aborted`; `response_too_large`
   *   for a reply over `maxResponseBytes`), or `parse` when the reply is not
   *   JSON or cannot be read.
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
   *   refused redirect; `network`; `timeout`; `aborted`; `response_too_large`
   *   for a reply over `maxResponseBytes`), or `parse` when the reply is not
   *   JSON or cannot be read.
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
   * and after the scan, and the history is returned only if both reads agree
   * and it holds exactly `chain_stats.tx_count` confirmed and
   * `mempool_stats.tx_count` mempool transactions. If the stats changed during
   * the scan, the address is scanned once more; if they change again, or the
   * counts differ, the call rejects with `invalid_cursor`. Stats without a
   * non-negative safe-integer `tx_count` reject with `parse`. `maxPages` and
   * `maxTransactions` cover both scans. The pages are read with
   * `getAddressMempoolTxs` and `getAddressTxs`, so a subclass's overrides of
   * them are used. The stats reads and the pages are each fetched in a
   * request of their own, never joined to an identical GET already in flight,
   * whose reply could predate the first stats read and so miss a replacement
   * (RBF) that leaves the stats unchanged; so is every other GET made under
   * the scan's signal.
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
   *   `http`, `network`, `timeout`, `aborted`, `response_too_large`).
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
    // The stats and the pages are fetched in requests of their own: a joined
    // GET's reply can predate the first stats read, and so miss a replacement
    // (RBF) that leaves the stats unchanged. The mark reaches the pages through
    // getAddressMempoolTxs and getAddressTxs, overridden or not.
    sendUnshared(signal)
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
   *   refused redirect; `network`; `timeout`; `aborted`; `response_too_large`
   *   for a reply over `maxResponseBytes`), or `parse` when the reply is not
   *   JSON or cannot be read.
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
   *   `http`, `network`, `timeout`, `aborted`, `response_too_large`).
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
   *   refused redirect; `network`; `timeout`; `aborted`; `response_too_large`
   *   for a reply over `maxResponseBytes`), or `parse` when the reply is not
   *   JSON or cannot be read.
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
   *   refused redirect; `network`; `timeout`; `aborted`; `response_too_large`
   *   for a reply over `maxResponseBytes`), or `parse` when the reply is not
   *   JSON or cannot be read.
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
   *   `timeout`, `aborted`, `response_too_large`).
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
   *   `http`, `network`, `timeout`, `aborted`, `response_too_large`).
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
   *   reached the node, including a reply, a 429 included, whose body failed,
   *   stalled or passed `maxResponseBytes`. `http`, `not_found`,
   *   `payload_too_large` or
   *   `rate_limit` when this submission was not accepted; for a resubmission,
   *   that proves nothing about the original. `network` for a connection
   *   failure before anything was sent, once retries run out. `aborted` or
   *   `timeout` when the call was cancelled or its deadline expired before the
   *   POST was sent or re-sent, or after a 429 whose body proves nothing was
   *   processed. A custom
   *   `fetchFn`'s own `QbitApiError` propagates as it is, even if the POST was
   *   already sent, unless its kind is `network`, `timeout`, `aborted` or
   *   `response_too_large`, so
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
   *   `network`, `timeout`, `aborted`, `response_too_large`).
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
   *   `network`, `timeout`, `aborted`, `response_too_large`).
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
        // SyntaxError. A copy of the original's message and stack stays behind
        // QbitApiError.unredactedCause(): the original keeps the body alive.
        throw new QbitApiError('parse', `failed to parse JSON from ${path}`, {
          url,
          responseBody: responseBodyPreview(text, this.baseUrl),
          cause: new SyntaxError('response body is not valid JSON'),
          unredactedCause: detachedParseError(cause),
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
   * classify the reply as the [outcome table](https://github.com/Qbit-Org/qbit-js/blob/main/packages/api/docs/broadcasting.md#outcomes) says.
   * `txid` identifies the submission in `unknown_outcome` errors and, when
   * known, is the result for already-known non-2xx replies. An abort or
   * deadline once the POST may have been sent, including while the reply body
   * is read, is an `unknown_outcome` too, unless the reply is a 429 whose body
   * was read in full and carries no verdict, which proves nothing was
   * processed.
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
        // A 429 whose whole body carries no verdict proves nothing was
        // submitted, even when the call is cut short here.
        if (response.status === 429 && signal.aborted && !isBroadcastVerdictReply(bufferedText(response))) {
          throw abortErrorFor(signal)
        }
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
      return init.dedup && !isUnshared(signal)
        ? this.requestShared(url, init, signal)
        : this.requestWithRetry(url, init, signal)
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
    // The last waiter consumes the original body; earlier waiters receive
    // clones. Every one shares the buffered text, which readBody hands out
    // without copying, so the clones hold no copy of the body.
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
   * `Retry-After` limits whose body was read in full and carries no verdict, or
   * a connection failure before anything was sent; see
   * [Broadcasting](https://github.com/Qbit-Org/qbit-js/blob/main/packages/api/docs/broadcasting.md)).
   * Any other attempt is never re-sent: a reply that arrives whole is returned
   * for the caller to judge, and one that may have been processed without such
   * a reply (a transport failure, an abort or deadline in flight, a body that
   * fails, stalls or passes `maxResponseBytes`, a 429's included, or a refused
   * redirect) fails with `unknown_outcome`. A reply over `maxResponseBytes` is
   * never retried. `txid` labels that error when the submission is a
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
        // A reply over maxResponseBytes is never retried: the same backend would
        // send the same body. A submission's reply arrived, so the node may have
        // accepted it, a 429 included, whose unread body could have said so. A
        // custom fetchFn's own `response_too_large` also means a reply arrived,
        // and is judged alike.
        if (lastError.kind === 'response_too_large') {
          if (idempotent) throw lastError
          const reason =
            reply.status === undefined
              ? redactBaseUrl(String(lastError.message), this.baseUrl)
              : `HTTP ${reply.status} reply body exceeded maxResponseBytes (${this.maxResponseBytes} bytes)`
          throw unknownOutcomeError(errorUrl, txid, reason, {
            ...(reply.status === undefined ? {} : { status: reply.status }),
            cause: lastError,
          })
        }
        // fetchOnce reads the body, so a submission reply can arrive and then stall,
        // fail mid-read, or be cut short by an abort or the deadline. Any such
        // reply may follow an accepted POST, a 429 included: only its body can
        // show that nothing was processed, as it may instead say the node
        // already has the transaction, or that the backend's call to the node
        // failed in transit.
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

      // A submission's 429 proves nothing was processed only when its body,
      // fully read, carries no verdict of its own; one that says the node
      // already has the transaction, or that the backend's call to the node
      // failed in transit, goes to submitTx to be judged instead.
      const retryable = idempotent
        ? TRANSIENT_STATUSES.has(response.status)
        : response.status === 429 && !isBroadcastVerdictReply(bufferedText(response))
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
   * with the call's `aborted` / `timeout` error. A body that passes
   * `maxResponseBytes` is cancelled and fails the attempt as
   * `response_too_large`. `reply.status` is set once the headers arrive. A redirect is refused before its body is read, which
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
        text = await readBodyUntilAborted(response, controller.signal, this.maxResponseBytes)
      } catch (cause) {
        // The call signal also aborts `controller`, so only an abort it did not
        // cause is this attempt's own timeout.
        if (signal.aborted) throw abortErrorFor(signal)
        if (cause instanceof BodyLimitExceeded) throw this.responseTooLargeError(url, response.status)
        if (controller.signal.aborted) throw this.timeoutError(url, cause, response.status)
        throw bodyReadError(response, cause, redactBaseUrl(url, this.baseUrl), this.baseUrl)
      }
      return bufferedResponse(response, text)
    } finally {
      clearTimeout(timer)
      signal.removeEventListener('abort', onAbort)
    }
  }

  /** A reply whose body passed `maxResponseBytes`, which readBodyUntilAborted has cancelled. */
  private responseTooLargeError(url: string, status: number): QbitApiError {
    const errorUrl = redactBaseUrl(url, this.baseUrl)
    return new QbitApiError(
      'response_too_large',
      `HTTP ${status} reply from ${errorUrl} exceeded maxResponseBytes (${this.maxResponseBytes} bytes); its body was discarded`,
      { status, url: errorUrl }
    )
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

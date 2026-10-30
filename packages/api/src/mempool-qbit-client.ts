import type {
  AddressHistory,
  AddressHistoryOptions,
  BroadcastTxOptions,
  EsploraFeeEstimates,
  EsploraTx,
  MempoolRecommendedFees,
  RequestOptions,
} from './index'
import { QbitApiError, quotedResponseText } from './errors'
import {
  type AddressHistoryBudget,
  addressHistoryStats,
  appendAddressHistoryTransactions,
  assertAddressHistoryPage,
  createAddressHistoryBudget,
  createAddressHistoryScanState,
  DEFAULT_MAX_ADDRESS_HISTORY_PAGES,
  DEFAULT_MAX_ADDRESS_HISTORY_TRANSACTIONS,
  isConfirmedTx,
  nextAddressHistoryCursor,
  positiveAddressHistoryLimit,
  reserveAddressHistoryTransactions,
  verifiedAddressHistory,
} from './validation'
import { feeEstimatesFromMempoolRecommendedFees, resolveBroadcastTxid, type feeTiersFromEstimates } from './adapters'
import { shouldRetryBroadcastViaTxPush } from './broadcast'
import { EsploraClient, type EsploraClientOptions } from './esplora-client'

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
        // Not joined to a GET in flight, whose reply can predate the stats read.
        await this.getJson<unknown>(`/address/${encodeURIComponent(address)}/txs${suffix}`, { signal }, false),
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
   *   confirmed transaction in the address's history, in either case, as
   *   {@link EsploraClient.getAddressTxs} takes it; omit it for the first
   *   page.
   * @param options - Cancellation and deadline for the call.
   * @returns Up to 25 confirmed transactions.
   * @throws {@link QbitApiError} `invalid_cursor` when `afterTxid` is not a
   *   string (before any request), is stale, unrelated or unconfirmed, a
   *   cursor stops advancing, or the stats check above fails.
   *   `pagination_limit` when the scan needs more than
   *   `maxAddressHistoryPages` requests. `parse` when a reply is not JSON or
   *   cannot be read, or the stats lack a valid `tx_count`. Any kind a failed
   *   request has (`not_found`, `rate_limit`, `payload_too_large`, `http`,
   *   `network`, `timeout`, `aborted`, `response_too_large`); qbit-electrs
   *   answers a cursor it finds nowhere with `422` (`http`).
   */
  override getAddressTxs(address: string, afterTxid?: string, options?: RequestOptions): Promise<EsploraTx[]> {
    return this.runOperation(options, signal => this.scanAddressTxs(address, afterTxid, signal))
  }

  private async scanAddressTxs(
    address: string,
    afterTxid: string | undefined,
    signal: AbortSignal
  ): Promise<EsploraTx[]> {
    // A caller without types can pass anything, and no other value names a
    // transaction: it could never match, so the scan would end in this error.
    if (afterTxid !== undefined && typeof afterTxid !== 'string') {
      throw new QbitApiError(
        'invalid_cursor',
        `mempool-qbit address history cursor is not a txid string but ${afterTxid === null ? 'null' : typeof afterTxid} (${address})`
      )
    }
    const confirmedTxs: EsploraTx[] = []
    // Txids compare case-insensitively, as qbit-electrs parses the parent's
    // `/txs/chain/:afterTxid` cursor in either case; its txids are lowercase.
    const afterTxidLower = afterTxid?.toLowerCase()
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
          if (typeof tx.txid !== 'string' || tx.txid.toLowerCase() !== afterTxidLower) continue
          if (!isConfirmedTx(tx)) {
            throw this.invalidAddressHistoryCursorError(address, afterTxid!)
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
   *   `payload_too_large`, `http`, `network`, `timeout`, `aborted`,
   *   `response_too_large`).
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
   *   refused redirect; `network`; `timeout`; `aborted`; `response_too_large`
   *   for a reply over `maxResponseBytes`), or `parse` when the reply is not
   *   JSON or cannot be read.
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
   *   `aborted`, `response_too_large`).
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

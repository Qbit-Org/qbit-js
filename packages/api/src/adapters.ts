import type { BroadcastTxOptions, EsploraAddressStats, EsploraFeeEstimates, MempoolRecommendedFees } from './index'
import { QbitApiError } from './errors'
import { tryTxidFromRawTx } from './raw-tx'
import { isRecord, TXID_PATTERN } from './validation'

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

export { resolveBroadcastTxid, trimAsciiWhitespace }

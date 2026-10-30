import type { AddressHistory, AddressHistoryOptions, EsploraAddressStats, EsploraTx } from './index'
import { QbitApiError } from './errors'

const TXID_PATTERN = /^[0-9a-f]{64}$/
const DEFAULT_MAX_ADDRESS_HISTORY_PAGES = 256
const DEFAULT_MAX_ADDRESS_HISTORY_TRANSACTIONS = 6_400

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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export {
  addressHistoryPageLimitError,
  addressHistoryStats,
  appendAddressHistoryTransactions,
  assertAddressHistoryPage,
  createAddressHistoryBudget,
  createAddressHistoryScanState,
  DEFAULT_MAX_ADDRESS_HISTORY_PAGES,
  DEFAULT_MAX_ADDRESS_HISTORY_TRANSACTIONS,
  isConfirmedTx,
  isRecord,
  nextAddressHistoryCursor,
  positiveAddressHistoryLimit,
  reserveAddressHistoryTransactions,
  TXID_PATTERN,
  verifiedAddressHistory,
}
export type { AddressHistoryBudget }

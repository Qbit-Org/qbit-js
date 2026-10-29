// An in-memory esplora backend, passed to EsploraClient as `fetchFn`, so the
// examples run offline. It answers only the routes the examples use, the way
// qbit-electrs does.

import { txidFromRawTx, type EsploraUtxo } from '@qbit-oss/api'

export const BASE_URL = 'https://esplora.example/regtest/api'

/**
 * How the stub answers one `POST /tx`:
 * - `accept`: the node takes the transaction and the reply arrives.
 * - `accept, reply lost`: the node takes it, but a gateway answers 504.
 * - `lost`: the request never reaches the node, and a gateway answers 504.
 * - `already known`: the node already has the transaction in a block, and
 *   answers RPC error -27.
 * - `reject`: the node refuses it with a mempool conflict.
 * - `reject, already confirmed`: the transaction confirmed meanwhile, so the
 *   node reports its inputs as spent.
 * - `reject, fee too low`: the node's mempool is full and asks a higher fee
 *   rate than the transaction pays.
 * - `stall`: the request never reaches the node, and no reply arrives until
 *   the client aborts it.
 */
export type BroadcastReply =
  | 'accept'
  | 'accept, reply lost'
  | 'lost'
  | 'already known'
  | 'reject'
  | 'reject, already confirmed'
  | 'reject, fee too low'
  | 'stall'

export interface StubEsploraOptions {
  address: string
  /** Confirmed and mempool totals the address stats report. */
  confirmedSats?: number
  mempoolSats?: number
  utxos?: EsploraUtxo[]
  /** Height of the chain tip (default 2,000). */
  tipHeight?: number
  /**
   * Txids of the `utxos` rows' funding transactions that are coinbase
   * transactions. `GET /tx/:txid` answers each funding transaction the rows
   * name, with `is_coinbase` on its first input.
   */
  coinbase?: string[]
  /** The address's transactions, in one page each; the address stats count them. */
  history?: { confirmed: unknown[]; mempool: unknown[] }
  feeEstimates?: Record<string, number>
  /** One reply per `POST /tx`, in order; later posts are accepted. */
  broadcastReplies?: BroadcastReply[]
  /** Called on each `POST /tx` before it is answered. */
  onBroadcast?: () => void
  /**
   * How many `GET /tx/:txid` lookups answer 404 for a transaction the node
   * has, as an indexer that has not caught up with its node does.
   */
  indexerLag?: number
  /**
   * Answer every `GET /tx/:txid` with 200 and this JSON instead, whatever the
   * node has, as a broken backend or proxy might.
   */
  lookupReply?: (txid: string) => unknown
  /** Leave every GET unanswered until the client aborts it. */
  stallReads?: boolean
  /** Leave every `GET /tx/:txid` unanswered until the client aborts it. */
  stallLookups?: boolean
}

export interface StubEsplora {
  fetchFn: typeof fetch
  /** Every request, as `METHOD /path`. */
  requests: string[]
  /** Raw transaction hex of each `POST /tx`, in order. */
  broadcasts: string[]
  /** Transactions the node has, by txid. */
  known: Map<string, { confirmed: boolean }>
}

export function stubEsplora(options: StubEsploraOptions): StubEsplora {
  const replies = [...(options.broadcastReplies ?? [])]
  let indexerLag = options.indexerLag ?? 0
  const requests: string[] = []
  const broadcasts: string[] = []
  const known = new Map<string, { confirmed: boolean }>()
  const json = (body: unknown) =>
    new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } })
  const txNotFound = () => new Response('Transaction not found', { status: 404 })
  const gatewayTimeout = () => new Response('<html><body>504 Gateway Time-out</body></html>', { status: 504 })
  const rpcError = (code: number, message: string) =>
    new Response(`sendrawtransaction RPC error: ${JSON.stringify({ code, message })}`, { status: 400 })

  const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const method = init?.method ?? 'GET'
    const path = String(input).slice(BASE_URL.length)
    requests.push(`${method} ${path}`)
    const address = encodeURIComponent(options.address)
    const history = options.history ?? { confirmed: [], mempool: [] }
    const signal = init?.signal
    const stalls = options.stallReads || (options.stallLookups && /^\/tx\/[0-9a-f]{64}$/.test(path))
    if (method === 'GET' && stalls && signal) return unanswered(signal)

    if (method === 'GET' && path === `/address/${address}`) {
      const stats = (fundedSum: number, txCount: number) => ({
        funded_txo_count: 1,
        funded_txo_sum: fundedSum,
        spent_txo_count: 0,
        spent_txo_sum: 0,
        tx_count: txCount,
      })
      return json({
        address: options.address,
        chain_stats: stats(options.confirmedSats ?? 0, history.confirmed.length),
        mempool_stats: stats(options.mempoolSats ?? 0, history.mempool.length),
      })
    }
    if (method === 'GET' && path === `/address/${address}/utxo`) return json(options.utxos ?? [])
    if (method === 'GET' && path === `/address/${address}/txs/mempool`) return json(history.mempool)
    if (method === 'GET' && path === `/address/${address}/txs/chain`) return json(history.confirmed)
    if (method === 'GET' && path.startsWith(`/address/${address}/txs/chain/`)) return json([]) // after the one page
    if (method === 'GET' && path === '/fee-estimates') return json(options.feeEstimates ?? {})
    if (method === 'GET' && path === '/blocks/tip/height') return new Response(String(options.tipHeight ?? 2_000))

    const status = /^\/tx\/([0-9a-f]{64})\/status$/.exec(path)
    if (method === 'GET' && status) {
      // qbit-electrs never answers 404 here: a txid it has never seen gets
      // 200 {"confirmed":false}, the same as a transaction in its mempool.
      return json(known.get(status[1]!) ?? { confirmed: false })
    }
    const lookup = /^\/tx\/([0-9a-f]{64})$/.exec(path)
    if (method === 'GET' && lookup) {
      if (options.lookupReply) return json(options.lookupReply(lookup[1]!))
      const tx = known.get(lookup[1]!)
      if (tx === undefined) return fundingTx(lookup[1]!) ?? txNotFound()
      if (indexerLag > 0) {
        indexerLag -= 1
        return txNotFound()
      }
      return json({ txid: lookup[1], status: tx })
    }

    if (method === 'POST' && path === '/tx') {
      const hex = String(init?.body)
      broadcasts.push(hex)
      options.onBroadcast?.()
      const txid = txidFromRawTx(hex)
      switch (replies.shift() ?? 'accept') {
        case 'accept':
          if (!known.has(txid)) known.set(txid, { confirmed: false })
          return new Response(txid)
        case 'accept, reply lost':
          known.set(txid, { confirmed: false })
          return gatewayTimeout()
        case 'lost':
          return gatewayTimeout()
        case 'already known':
          known.set(txid, { confirmed: true })
          return rpcError(-27, 'Transaction outputs already in utxo set')
        case 'reject':
          return rpcError(-26, 'txn-mempool-conflict')
        case 'reject, already confirmed':
          known.set(txid, { confirmed: true })
          return rpcError(-25, 'bad-txns-inputs-missingorspent')
        case 'reject, fee too low':
          return rpcError(-26, 'mempool min fee not met')
        case 'stall':
          if (signal) return unanswered(signal) // EsploraClient always passes one
      }
    }
    return new Response('not found', { status: 404 })
  }) as typeof fetch

  /** The funding transaction of the `utxos` rows with txid `txid`, if any, with the fields the examples read. */
  function fundingTx(txid: string) {
    const row = (options.utxos ?? []).find(row => row.txid === txid)
    if (row === undefined) return undefined
    const vin = options.coinbase?.includes(txid)
      ? { txid: '00'.repeat(32), vout: 0xffff_ffff, prevout: null, is_coinbase: true }
      : { txid: 'ff'.repeat(32), vout: 0, is_coinbase: false }
    return json({ txid, vin: [vin], status: row.status })
  }

  return { fetchFn, requests, broadcasts, known }
}

/** A reply that never comes: the request fails only when `signal` aborts. */
function unanswered(signal: AbortSignal): Promise<Response> {
  return new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason)))
}

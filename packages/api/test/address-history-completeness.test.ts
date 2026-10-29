import { describe, expect, it } from 'vitest'

import { EsploraClient, MempoolQbitClient, QbitApiError } from '../src/index'
import { createMockEsplora, type MockBackend, type MockFault, type MockTx } from '../src/testing'

// getAddressHistory must not return a history the backend cut short as if it
// were complete. The backend below follows Qbit-Org/qbit-electrs@53102e9:
//   - `/txs/chain/:last_seen` skips rows until `last_seen`, so an unknown
//     cursor yields 200 `[]` (`src/new_index/schema.rs:1031-1060`), and an
//     unparseable one is ignored (`src/rest.rs:1154`);
//   - `/txs/mempool` lists at most 50 rows and cannot be paged
//     (`src/rest.rs:1316-1343`, `src/config.rs:391-394`);
//   - the combined `/txs?after_txid=` route passes a mempool cursor on to the
//     chain history when no mempool rows follow it (`src/rest.rs:992-998`), and
//     answers a cursor found nowhere with 422 (`:982-987`);
//   - `/address/:a` counts distinct txids in each part (`schema.rs:1277-1305`,
//     `src/new_index/mempool.rs:280-292`).
// mempool-qbit in esplora mode, as mempool.qbit.org runs it, passes the combined
// route and the stats through from that backend unchanged.
//
// The testing kit (`createMockEsplora`) serves this model from a fixture that
// stays the same for the mock's life. Tests whose backend changes between
// requests (a reorg, an arrival during the scan, a lagging or failover node)
// keep the hand-written `electrs` model below, which they mutate as they go.

interface MockReply {
  status?: number
  body?: string
}

type Handler = (callIndex: number, url: string, init: RequestInit | undefined) => MockReply | Promise<MockReply>

function makeFetch(handler: Handler): { fetchFn: typeof fetch; calls: string[] } {
  const calls: string[] = []
  const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    const index = calls.length
    calls.push(url)
    const reply = await handler(index, url, init)
    return new Response(reply.body ?? '', { status: reply.status ?? 200 })
  }) as typeof fetch
  return { fetchFn, calls }
}

const BASE = 'https://esplora.example/regtest/api'
const ADDR = 'qbrt1zqqqsyqcyq5rqwzqfpg9scrgwpugpzysnzs23v9ccrydpk8qarc0s8kqqny'
const STATS_URL = `${BASE}/address/${ADDR}`
const noSleep = () => Promise.resolve()

const CHAIN_PAGE = 25
const MEMPOOL_PAGE = 50

/** Txids held by one node, newest first. */
interface Node {
  chain: string[]
  mempool: string[]
}

function txid(tag: number, n: number): string {
  return tag.toString(16).padStart(2, '0') + n.toString(16).padStart(62, '0')
}

function node(confirmed: number, mempool: number): Node {
  return {
    chain: Array.from({ length: confirmed }, (_, n) => txid(0xcc, n)),
    mempool: Array.from({ length: mempool }, (_, n) => txid(0xaa, n)),
  }
}

function tx(id: string, confirmed: boolean) {
  return {
    txid: id,
    version: 2,
    locktime: 0,
    vin: [],
    vout: [
      {
        scriptpubkey: '51',
        scriptpubkey_asm: 'OP_1',
        scriptpubkey_type: 'unknown',
        scriptpubkey_address: ADDR,
        value: 1,
      },
    ],
    size: 100,
    weight: 100,
    fee: 10,
    status: confirmed ? { confirmed: true, block_height: 8, block_time: 123 } : { confirmed: false },
  }
}

function render(state: Node, ids: string[]) {
  return ids.map(id => tx(id, state.chain.includes(id)))
}

/** Rows after `lastSeen` (all rows when it is undefined); none when it is not in `ids`. */
function after(ids: string[], lastSeen: string | undefined, limit: number): string[] {
  if (lastSeen === undefined) return ids.slice(0, limit)
  const index = ids.indexOf(lastSeen)
  return index === -1 ? [] : ids.slice(index + 1, index + 1 + limit)
}

function stats(state: Node): string {
  const part = (count: number) => ({
    funded_txo_count: count,
    funded_txo_sum: count,
    spent_txo_count: 0,
    spent_txo_sum: 0,
    tx_count: count,
  })
  return JSON.stringify({
    address: ADDR,
    chain_stats: part(state.chain.length),
    mempool_stats: part(state.mempool.length),
  })
}

/** One request against `state`, answered as qbit-electrs (or mempool-qbit, which proxies it) would. */
function electrs(state: Node, url: string): MockReply {
  const parsed = new URL(url)
  const path = parsed.pathname.slice(new URL(BASE).pathname.length)
  const prefix = `/address/${ADDR}`
  if (path === prefix) return { body: stats(state) }
  if (path === `${prefix}/txs/mempool`) {
    return { body: JSON.stringify(render(state, state.mempool.slice(0, MEMPOOL_PAGE))) }
  }
  if (path === `${prefix}/txs/chain` || path.startsWith(`${prefix}/txs/chain/`)) {
    const cursor = path.slice(`${prefix}/txs/chain/`.length)
    const lastSeen = /^[0-9a-f]{64}$/.test(cursor) ? cursor : undefined
    return { body: JSON.stringify(render(state, after(state.chain, lastSeen, CHAIN_PAGE))) }
  }
  if (path === `${prefix}/txs`) {
    const cursor = parsed.searchParams.get('after_txid') ?? undefined
    if (cursor !== undefined && !state.mempool.includes(cursor)) {
      if (!state.chain.includes(cursor)) return { status: 422, body: 'after_txid not found' }
      return { body: JSON.stringify(render(state, after(state.chain, cursor, MEMPOOL_PAGE))) }
    }
    const rows = after(state.mempool, cursor, MEMPOOL_PAGE)
    if (rows.length < MEMPOOL_PAGE) {
      const chainCursor = rows.length > 0 ? undefined : cursor
      rows.push(...after(state.chain, chainCursor, MEMPOOL_PAGE - rows.length))
    }
    return { body: JSON.stringify(render(state, rows)) }
  }
  throw new Error(`unexpected url ${url}`)
}

/** `node(confirmed, mempool)` as a testing-kit fixture: the kit lists the chain by height and the mempool in reverse order, newest first. */
function fixture(confirmed: number, mempool: number): { state: Node; txs: MockTx[] } {
  const state = node(confirmed, mempool)
  const pays = [{ address: ADDR, value: 1 }]
  const txs: MockTx[] = [
    ...state.chain.map((id, n) => ({ txid: id, vout: pays, block: { height: confirmed - n } })),
    ...[...state.mempool].reverse().map(id => ({ txid: id, vout: pays })),
  ]
  return { state, txs }
}

function kit(backend: MockBackend, txs: MockTx[], faults: MockFault[] = []) {
  const mock = createMockEsplora({ backend, baseUrl: BASE, txs, faults })
  return { mock, fetchFn: mock.fetchFn, calls: () => mock.requests.map(request => request.url) }
}

/** What the history of `state` must hold: the rows a mock over `txs` serves for its txids. */
async function expectedRows(txs: MockTx[], state: Node) {
  const reference = createMockEsplora({ backend: 'esplora', baseUrl: BASE, txs })
  const rows = (ids: string[]) =>
    Promise.all(ids.map(async id => (await reference.fetchFn(`${BASE}/tx/${id}`)).json() as Promise<unknown>))
  return { confirmed: await rows(state.chain), mempool: await rows(state.mempool) }
}

function esplora(fetchFn: typeof fetch): EsploraClient {
  return new EsploraClient({ baseUrl: BASE, fetchFn, sleepFn: noSleep, retries: 0 })
}

function mempoolQbit(fetchFn: typeof fetch, maxAddressHistoryPages?: number): MempoolQbitClient {
  return new MempoolQbitClient({
    baseUrl: BASE,
    fetchFn,
    sleepFn: noSleep,
    retries: 0,
    ...(maxAddressHistoryPages === undefined ? {} : { maxAddressHistoryPages }),
  })
}

function expected(state: Node) {
  return { confirmed: render(state, state.chain), mempool: render(state, state.mempool) }
}

function statsReads(calls: string[]): number {
  return calls.filter(url => url === STATS_URL).length
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve = () => {}
  const promise = new Promise<void>(r => {
    resolve = r
  })
  return { promise, resolve }
}

describe('EsploraClient.getAddressHistory against the address stats', () => {
  it('returns a history whose counts match unchanged stats, read before and after the scan', async () => {
    const { state, txs } = fixture(60, 50)
    const { fetchFn, calls } = kit('esplora', txs)

    await expect(esplora(fetchFn).getAddressHistory(ADDR)).resolves.toEqual(await expectedRows(txs, state))
    expect(calls()[0]).toBe(STATS_URL)
    expect(calls()[calls().length - 1]).toBe(STATS_URL)
    expect(statsReads(calls())).toBe(2)
  })

  it('rejects a mempool list cut at the 50-row cap of /txs/mempool', async () => {
    const { fetchFn } = kit('esplora', fixture(30, 60).txs)

    const error = await esplora(fetchFn)
      .getAddressHistory(ADDR)
      .catch((e: unknown) => e)
    expect(error).toBeInstanceOf(QbitApiError)
    expect(error).toMatchObject({
      kind: 'invalid_cursor',
      message: `esplora address history returned 30 confirmed and 50 mempool transactions, but the address stats count 30 and 60: ${ADDR}`,
    })
  })

  it('rejects confirmed history cut short by a node that does not know the cursor', async () => {
    // Behind a load balancer, page 2 is served by an indexer that lags the
    // node that served page 1, so the cursor is unknown there: 200 `[]`.
    const current = node(60, 0)
    const lagging: Node = { chain: current.chain.slice(30), mempool: [] }
    let chainPages = 0
    const { fetchFn } = makeFetch((_i, url) => {
      if (!url.includes('/txs/chain')) return electrs(current, url)
      chainPages += 1
      return electrs(chainPages === 2 ? lagging : current, url)
    })

    await expect(esplora(fetchFn).getAddressHistory(ADDR)).rejects.toMatchObject({
      kind: 'invalid_cursor',
      message: `esplora address history returned 25 confirmed and 0 mempool transactions, but the address stats count 60 and 0: ${ADDR}`,
    })
  })

  it('rescans when a reorg sends the cursor transaction back to the mempool between pages', async () => {
    const state = node(30, 0)
    const cursor = state.chain[CHAIN_PAGE - 1]!
    let reorged = false
    const { fetchFn, calls } = makeFetch((_i, url) => {
      const reply = electrs(state, url)
      if (!reorged && url === `${BASE}/address/${ADDR}/txs/chain`) {
        reorged = true
        state.chain = state.chain.filter(id => id !== cursor)
        state.mempool = [cursor]
      }
      return reply
    })

    const history = await esplora(fetchFn).getAddressHistory(ADDR)
    expect(history).toEqual({ confirmed: render(state, state.chain), mempool: [tx(cursor, false)] })
    expect(history.confirmed).toHaveLength(29)
    expect(statsReads(calls)).toBe(3)
    // The first scan ended on the vanished cursor's empty page.
    expect(calls.slice(0, 5)).toEqual([
      STATS_URL,
      `${BASE}/address/${ADDR}/txs/mempool`,
      `${BASE}/address/${ADDR}/txs/chain`,
      `${BASE}/address/${ADDR}/txs/chain/${cursor}`,
      STATS_URL,
    ])
  })

  it('rejects when the stats change during the rescan too', async () => {
    const state = node(3, 0)
    let arrivals = 0
    const { fetchFn, calls } = makeFetch((_i, url) => {
      const reply = electrs(state, url)
      // A new mempool transaction arrives after every stats read.
      if (url === STATS_URL) state.mempool.unshift(txid(0xee, arrivals++))
      return reply
    })

    await expect(esplora(fetchFn).getAddressHistory(ADDR)).rejects.toMatchObject({
      kind: 'invalid_cursor',
      message: `esplora address stats changed during each of 2 history scans: ${ADDR}`,
    })
    expect(statsReads(calls)).toBe(3)
    expect(calls).toHaveLength(9)
  })

  it('replays the first page for an unparseable cursor, which still fails closed', async () => {
    const { mock } = kit('esplora', fixture(30, 0).txs)
    // A backend that receives every cursor mangled ignores it, as qbit-electrs ignores an unparseable one.
    const fetchFn: typeof fetch = (input, init) =>
      mock.fetchFn(String(input).replace(/\/txs\/chain\/[0-9a-f]{64}$/, '/txs/chain/not-a-txid'), init)

    await expect(esplora(fetchFn).getAddressHistory(ADDR)).rejects.toMatchObject({
      kind: 'invalid_cursor',
      message: expect.stringContaining('cursor stopped advancing'),
    })
  })

  it('counts the rescan against maxPages and maxTransactions, and not the stats reads', async () => {
    // 30 confirmed rows take 3 page fetches (25, 5, then the empty page); a
    // mempool arrival right after the first scan forces a second one.
    const scenario = () => {
      const state = node(30, 0)
      let chainFetches = 0
      const handler: Handler = (_i, url) => {
        if (url.includes('/txs/chain')) chainFetches += 1
        if (url === STATS_URL && chainFetches === 3 && state.mempool.length === 0) {
          state.mempool = [txid(0xee, 0)]
        }
        return electrs(state, url)
      }
      return { state, ...makeFetch(handler), chainFetches: () => chainFetches }
    }

    const short = scenario()
    await expect(esplora(short.fetchFn).getAddressHistory(ADDR, { maxPages: 5 })).rejects.toMatchObject({
      kind: 'pagination_limit',
      message: `esplora address history exceeded 5 page fetches: ${ADDR}`,
    })
    expect(short.chainFetches()).toBe(5)

    const enough = scenario()
    const history = await esplora(enough.fetchFn).getAddressHistory(ADDR, { maxPages: 6 })
    expect(history).toEqual(expected(enough.state))
    expect(history.mempool).toHaveLength(1)
    expect(enough.chainFetches()).toBe(6)
    expect(statsReads(enough.calls)).toBe(3)

    // 30 rows in the first scan, 31 in the rescan.
    const fewRows = scenario()
    await expect(esplora(fewRows.fetchFn).getAddressHistory(ADDR, { maxTransactions: 60 })).rejects.toMatchObject({
      kind: 'pagination_limit',
      message: `esplora address history exceeded 60 transactions: ${ADDR}`,
    })
    const enoughRows = scenario()
    const rows = await esplora(enoughRows.fetchFn).getAddressHistory(ADDR, { maxTransactions: 61 })
    expect(rows).toEqual(expected(enoughRows.state))
  })

  it('does not start a rescan once the first scan used every page fetch', async () => {
    const state = node(30, 0)
    let arrived = false
    const { fetchFn, calls } = makeFetch((_i, url) => {
      const reply = electrs(state, url)
      if (url === STATS_URL && !arrived) {
        arrived = true
        state.mempool = [txid(0xee, 0)]
      }
      return reply
    })

    await expect(esplora(fetchFn).getAddressHistory(ADDR, { maxPages: 3 })).rejects.toMatchObject({
      kind: 'pagination_limit',
      message: `esplora address history exceeded 3 page fetches: ${ADDR}`,
    })
    expect(calls[calls.length - 1]).toBe(STATS_URL)
    expect(calls).toHaveLength(6)
  })

  it.each([
    ['null', null],
    ['an array', []],
    ['no chain_stats', { mempool_stats: { tx_count: 0 } }],
    ['a missing tx_count', { chain_stats: {}, mempool_stats: { tx_count: 0 } }],
    ['a string tx_count', { chain_stats: { tx_count: '3' }, mempool_stats: { tx_count: 0 } }],
    ['a negative tx_count', { chain_stats: { tx_count: 0 }, mempool_stats: { tx_count: -1 } }],
    ['a fractional tx_count', { chain_stats: { tx_count: 1.5 }, mempool_stats: { tx_count: 0 } }],
    ['an unsafe tx_count', { chain_stats: { tx_count: 2 ** 53 }, mempool_stats: { tx_count: 0 } }],
  ])('rejects stats with %s as parse before scanning', async (_name, body) => {
    const { fetchFn, calls } = kit(
      'esplora',
      [],
      [{ route: 'GET /address/:address', kind: 'status', status: 200, body: JSON.stringify(body), times: Infinity }]
    )

    await expect(esplora(fetchFn).getAddressHistory(ADDR)).rejects.toMatchObject({
      kind: 'parse',
      message: `esplora address stats lacked a non-negative safe-integer chain or mempool tx_count: ${ADDR}`,
    })
    expect(calls()).toEqual([STATS_URL])
  })

  it('reads the stats in requests of their own, not joined to one already in flight', async () => {
    const { state, txs } = fixture(2, 1)
    const { mock, calls } = kit('esplora', txs)
    const held = deferred()
    // The first reply is held back until the test releases it.
    const fetchFn: typeof fetch = async (input, init) => {
      const first = mock.requests.length === 0
      const reply = await mock.fetchFn(input, init)
      if (first) await held.promise
      return reply
    }
    const client = esplora(fetchFn)

    // A poller's stats request is still waiting for its reply.
    const polled = client.getAddressStats(ADDR)
    await expect(client.getAddressHistory(ADDR)).resolves.toEqual(await expectedRows(txs, state))
    expect(statsReads(calls())).toBe(3)

    held.resolve()
    await expect(polled).resolves.toMatchObject({ chain_stats: { tx_count: 2 } })
  })

  it('stops at an abort during the final stats read', async () => {
    const state = node(2, 0)
    const controller = new AbortController()
    let statsRequests = 0
    const { fetchFn, calls } = makeFetch((_i, url, init) => {
      if (url === STATS_URL && ++statsRequests === 2) {
        return new Promise((_, reject) => {
          init?.signal?.addEventListener('abort', () => reject(init.signal!.reason), { once: true })
          controller.abort()
        })
      }
      return electrs(state, url)
    })

    await expect(esplora(fetchFn).getAddressHistory(ADDR, { signal: controller.signal })).rejects.toMatchObject({
      kind: 'aborted',
    })
    expect(calls).toHaveLength(5)
  })
})

describe('MempoolQbitClient.getAddressHistory against the address stats', () => {
  it.each([
    [49, 30],
    [0, 75],
    [50, 0],
  ])('returns %i mempool and %i confirmed transactions when the counts match', async (mempool, confirmed) => {
    const { state, txs } = fixture(confirmed, mempool)
    const { fetchFn, calls } = kit('mempool-qbit', txs)

    await expect(mempoolQbit(fetchFn).getAddressHistory(ADDR)).resolves.toEqual(await expectedRows(txs, state))
    expect(statsReads(calls())).toBe(2)
  })

  it.each([50, 100])('rejects losing all confirmed history after %i mempool transactions', async mempool => {
    const { state, txs } = fixture(30, mempool)
    const { fetchFn, calls } = kit('mempool-qbit', txs)

    await expect(mempoolQbit(fetchFn).getAddressHistory(ADDR)).rejects.toMatchObject({
      kind: 'invalid_cursor',
      message: `mempool-qbit address history returned 0 confirmed and ${mempool} mempool transactions, but the address stats count 30 and ${mempool}: ${ADDR}`,
    })
    // The page after the last mempool row came back empty.
    expect(calls()[calls().length - 2]).toBe(`${BASE}/address/${ADDR}/txs?after_txid=${state.mempool[mempool - 1]}`)
  })

  it('rejects history cut short by a failover node that still has the cursor in its mempool', async () => {
    // Page 1 comes from a node that has mined the cursor; page 2 from one a
    // block behind, which still holds it in its mempool.
    const current = node(80, 0)
    const cursor = current.chain[MEMPOOL_PAGE - 1]!
    const behind: Node = { chain: current.chain.slice(MEMPOOL_PAGE), mempool: [cursor] }
    let pages = 0
    const { fetchFn } = makeFetch((_i, url) => {
      if (!url.includes('/txs')) return electrs(current, url)
      pages += 1
      return electrs(pages === 2 ? behind : current, url)
    })

    await expect(mempoolQbit(fetchFn).getAddressHistory(ADDR)).rejects.toMatchObject({
      kind: 'invalid_cursor',
      message: `mempool-qbit address history returned 50 confirmed and 0 mempool transactions, but the address stats count 80 and 0: ${ADDR}`,
    })
  })

  it('rescans when a transaction arrives during the traversal', async () => {
    const state = node(60, 0)
    const arrival = txid(0xee, 0)
    let pages = 0
    const { fetchFn, calls } = makeFetch((_i, url) => {
      const reply = electrs(state, url)
      if (url.includes('/txs') && ++pages === 1) state.mempool = [arrival]
      return reply
    })

    const history = await mempoolQbit(fetchFn).getAddressHistory(ADDR)
    expect(history).toEqual(expected(state))
    expect(history.mempool).toEqual([tx(arrival, false)])
    expect(statsReads(calls)).toBe(3)
  })

  it('counts the rescan against the per-call page ceiling', async () => {
    // 60 confirmed rows take 3 combined requests (50, 10, then the empty page).
    const scenario = () => {
      const state = node(60, 0)
      let pages = 0
      const handler: Handler = (_i, url) => {
        if (url.includes('/txs')) pages += 1
        if (url === STATS_URL && pages === 3 && state.mempool.length === 0) {
          state.mempool = [txid(0xee, 0)]
        }
        return electrs(state, url)
      }
      return { state, ...makeFetch(handler), pages: () => pages }
    }

    const capped = scenario()
    await expect(mempoolQbit(capped.fetchFn, 5).getAddressHistory(ADDR)).rejects.toMatchObject({
      kind: 'pagination_limit',
      message: `mempool-qbit address history exceeded 5 pages: ${ADDR}`,
    })
    expect(capped.pages()).toBe(5)

    const lowered = scenario()
    await expect(mempoolQbit(lowered.fetchFn).getAddressHistory(ADDR, { maxPages: 5 })).rejects.toMatchObject({
      kind: 'pagination_limit',
    })
    expect(lowered.pages()).toBe(5)

    const enough = scenario()
    const history = await mempoolQbit(enough.fetchFn, 6).getAddressHistory(ADDR)
    expect(history).toEqual(expected(enough.state))
    expect(history.mempool).toHaveLength(1)
    expect(enough.pages()).toBe(6)
  })
})

describe('MempoolQbitClient.getAddressTxs after a page of mempool rows', () => {
  it('rejects an empty page after the last mempool row while confirmed history exists', async () => {
    const { state, txs } = fixture(30, 50)
    const { fetchFn, calls } = kit('mempool-qbit', txs)

    await expect(mempoolQbit(fetchFn).getAddressTxs(ADDR)).rejects.toMatchObject({
      kind: 'invalid_cursor',
      message: `mempool-qbit combined history ended after a mempool transaction with 0 of 30 confirmed transactions: ${ADDR}`,
    })
    expect(calls()).toEqual([
      `${BASE}/address/${ADDR}/txs`,
      `${BASE}/address/${ADDR}/txs?after_txid=${state.mempool[49]}`,
      STATS_URL,
    ])
  })

  it('returns no confirmed transactions when the stats count none', async () => {
    const { fetchFn, calls } = kit('mempool-qbit', fixture(0, 50).txs)

    await expect(mempoolQbit(fetchFn).getAddressTxs(ADDR)).resolves.toEqual([])
    expect(statsReads(calls())).toBe(1)
  })

  it('reads no stats when the confirmed rows follow the mempool rows', async () => {
    const { state, txs } = fixture(30, 49)
    const { fetchFn, calls } = kit('mempool-qbit', txs)

    const { confirmed } = await expectedRows(txs, state)
    await expect(mempoolQbit(fetchFn).getAddressTxs(ADDR)).resolves.toEqual(confirmed.slice(0, 25))
    expect(statsReads(calls())).toBe(0)
  })

  it('rejects malformed stats as parse', async () => {
    const { fetchFn } = kit('mempool-qbit', fixture(30, 50).txs, [
      { route: 'GET /address/:address', kind: 'status', status: 200, body: '{"chain_stats":{},"mempool_stats":{}}' },
    ])

    await expect(mempoolQbit(fetchFn).getAddressTxs(ADDR)).rejects.toMatchObject({
      kind: 'parse',
      message: `mempool-qbit address stats lacked a non-negative safe-integer chain or mempool tx_count: ${ADDR}`,
    })
  })
})

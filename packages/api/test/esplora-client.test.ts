import { readFileSync } from 'node:fs'

import { describe, expect, it, vi } from 'vitest'

import {
  EsploraClient,
  type EsploraClientOptions,
  MempoolQbitClient,
  QbitApiError,
  addressBalanceFromStats,
  feeEstimatesFromMempoolRecommendedFees,
  feeTiersFromEstimates,
} from '../src/index'
import { createMockEsplora, type MockBackend, type MockFault, type MockRoute } from '../src/testing'

interface MockReply {
  status?: number
  body?: string
  headers?: Record<string, string>
}

type Handler = (callIndex: number, url: string, init: RequestInit | undefined) => MockReply | Promise<MockReply>

function makeFetch(handler: Handler): {
  fetchFn: typeof fetch
  calls: { url: string; init?: RequestInit | undefined }[]
  responses: Response[]
} {
  const calls: { url: string; init?: RequestInit | undefined }[] = []
  const responses: Response[] = []
  const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    const index = calls.length
    calls.push({ url, init })
    const reply = await handler(index, url, init)
    const response = new Response(reply.body ?? '', {
      status: reply.status ?? 200,
      ...(reply.headers ? { headers: reply.headers } : {}),
    })
    responses.push(response)
    return response
  }) as typeof fetch
  return { fetchFn, calls, responses }
}

const BASE = 'https://esplora.example/regtest/api'
const ADDR = 'qbrt1zqqqsyqcyq5rqwzqfpg9scrgwpugpzysnzs23v9ccrydpk8qarc0s8kqqny'

const STATS = {
  address: ADDR,
  chain_stats: { funded_txo_count: 3, funded_txo_sum: 150_000, spent_txo_count: 1, spent_txo_sum: 50_000, tx_count: 3 },
  mempool_stats: { funded_txo_count: 1, funded_txo_sum: 20_000, spent_txo_count: 0, spent_txo_sum: 0, tx_count: 1 },
}

/** Address stats counting `confirmed` and `mempool` transactions, which a complete history must match. */
function historyStats(confirmed: number, mempool: number): string {
  return JSON.stringify({
    ...STATS,
    chain_stats: { ...STATS.chain_stats, tx_count: confirmed },
    mempool_stats: { ...STATS.mempool_stats, tx_count: mempool },
  })
}

/** Answer the address-stats route with `historyStats` and every other request with `handler`. */
function withStats(handler: Handler, confirmed: number, mempool: number, address = ADDR): Handler {
  return (i, url, init) =>
    url === `${BASE}/address/${address}` ? { body: historyStats(confirmed, mempool) } : handler(i, url, init)
}

/**
 * A testing-kit backend with no transactions, and `faults`. Tests of how the
 * client takes a reply use it; those that hand-craft history pages (variable
 * page sizes, repeated or malformed rows), or check the RequestInit the client
 * sends or the Response objects it consumes, keep `makeFetch`.
 */
function kit(faults: MockFault[] = [], backend: MockBackend = 'esplora', options: { tipHeight?: number } = {}) {
  const mock = createMockEsplora({
    backend,
    baseUrl: BASE,
    faults,
    ...(options.tipHeight === undefined ? {} : { tip: { height: options.tipHeight } }),
  })
  return { mock, fetchFn: mock.fetchFn, calls: mock.requests }
}

/** A status fault on `route` for every request. */
function always(route: MockRoute, status: number, body?: string): MockFault {
  return { route, kind: 'status', status, times: Infinity, ...(body === undefined ? {} : { body }) }
}

const noSleep = () => Promise.resolve()
/** A one-input, one-output legacy transaction and its txid (getTxHex checks the reply). */
const LEGACY_TX_HEX =
  '020000000111111111111111111111111111111111111111111111111111111111111111110000000000ffffffff0100000000000000000000000000'
const LEGACY_TXID = '992393c6db57a325f48e3097a50c45349c3eb27df5160a68cbb7a022f98c2dc2'
// A node reply to a submission whose hex the client cannot parse into a txid itself.
const BROADCAST_TXID = 'cd'.repeat(32)

function historyTx(txid: string, confirmed: boolean) {
  return {
    txid,
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

describe('EsploraClient endpoints', () => {
  it('hits the right URLs and parses responses', async () => {
    const mock = createMockEsplora({
      backend: 'esplora',
      baseUrl: BASE,
      // 150,000 sats received in two outputs, one of them still unspent.
      txs: [
        { hex: LEGACY_TX_HEX, vout: [{ address: ADDR, value: 100_000 }], block: { height: 4000 } },
        { txid: 'aa'.repeat(32), vout: [{ address: ADDR, value: 50_000 }], block: { height: 4001 } },
        { txid: 'bb'.repeat(32), vin: [{ txid: 'aa'.repeat(32), vout: 0 }], vout: [{ value: 49_000 }] },
      ],
      feeEstimates: { '1': 12.5, '6': 4, '144': 1.1 },
      tip: { height: 4321 },
    })
    const calls = mock.requests
    const client = new EsploraClient({ baseUrl: BASE, fetchFn: mock.fetchFn, sleepFn: noSleep })

    const stats = await client.getAddressStats(ADDR)
    expect(stats.chain_stats.funded_txo_sum).toBe(150_000)

    const utxos = await client.getAddressUtxos(ADDR)
    expect(utxos[0]!.value).toBe(100_000)

    expect(await client.getTipHeight()).toBe(4321)
    expect(await client.getTxHex(LEGACY_TXID)).toBe(LEGACY_TX_HEX)

    const fees = await client.getFeeTiers()
    expect(fees.map(f => f.target)).toEqual([1, 6, 144]) // ascending
    expect(calls[0]!.url).toBe(`${BASE}/address/${ADDR}`)
  })

  it('binds the default global fetch receiver for service-worker fetch implementations', async () => {
    const originalFetch = globalThis.fetch
    const calls: string[] = []
    async function fetchWithReceiver(this: typeof globalThis, input: RequestInfo | URL, _init?: RequestInit) {
      expect(this).toBe(globalThis)
      calls.push(String(input))
      return new Response(JSON.stringify(STATS), { status: 200 })
    }

    try {
      globalThis.fetch = fetchWithReceiver as typeof fetch
      const client = new EsploraClient({ baseUrl: BASE, sleepFn: noSleep })
      await expect(client.getAddressStats(ADDR)).resolves.toEqual(STATS)
      expect(calls).toEqual([`${BASE}/address/${ADDR}`])
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it.each([
    ['default', undefined, 'omit'],
    ['same-origin', 'same-origin', 'same-origin'],
    ['include', 'include', 'include'],
  ] as const)('uses %s fetch credentials', async (_case, credentials, expected) => {
    const { fetchFn, calls } = makeFetch(() => ({ body: JSON.stringify(STATS) }))
    const client = new EsploraClient({
      baseUrl: BASE,
      fetchFn,
      sleepFn: noSleep,
      ...(credentials === undefined ? {} : { credentials }),
    })

    await client.getAddressStats(ADDR)

    expect(calls[0]!.init?.credentials).toBe(expected)
  })

  it('uses the confirmed-only chain route for the first address-history page', async () => {
    const { fetchFn, calls } = kit()
    const client = new EsploraClient({ baseUrl: BASE, fetchFn, sleepFn: noSleep })

    await client.getAddressTxs(ADDR)

    expect(calls[0]!.url).toBe(`${BASE}/address/${ADDR}/txs/chain`)
  })

  it('appends an encoded cursor to the confirmed-only chain route', async () => {
    const { fetchFn, calls } = kit()
    const client = new EsploraClient({ baseUrl: BASE, fetchFn, sleepFn: noSleep })

    await client.getAddressTxs(ADDR, 'last/txid')

    expect(calls[0]!.url).toBe(`${BASE}/address/${ADDR}/txs/chain/last%2Ftxid`)
  })

  it('exhausts complete address history without assuming a page size', async () => {
    const mempoolTx = historyTx('11'.repeat(32), false)
    const confirmedA = historyTx('22'.repeat(32), true)
    const confirmedB = historyTx('33'.repeat(32), true)
    const confirmedC = historyTx('44'.repeat(32), true)
    const { fetchFn, calls } = makeFetch(
      withStats(
        (_i, url) => {
          if (url.endsWith(`/address/${ADDR}/txs/mempool`)) {
            return { body: JSON.stringify([mempoolTx]) }
          }
          if (url.endsWith(`/address/${ADDR}/txs/chain`)) {
            return { body: JSON.stringify([confirmedA]) }
          }
          if (url.endsWith(`/address/${ADDR}/txs/chain/${confirmedA.txid}`)) {
            return { body: JSON.stringify([confirmedB, confirmedC]) }
          }
          if (url.endsWith(`/address/${ADDR}/txs/chain/${confirmedC.txid}`)) {
            return { body: '[]' }
          }
          throw new Error(`unexpected url ${url}`)
        },
        3,
        1
      )
    )
    const client = new EsploraClient({ baseUrl: BASE, fetchFn, sleepFn: noSleep })

    await expect(client.getAddressHistory(ADDR, { maxPages: 3, maxTransactions: 4 })).resolves.toEqual({
      confirmed: [confirmedA, confirmedB, confirmedC],
      mempool: [mempoolTx],
    })
    expect(calls.map(call => call.url)).toEqual([
      `${BASE}/address/${ADDR}`,
      `${BASE}/address/${ADDR}/txs/mempool`,
      `${BASE}/address/${ADDR}/txs/chain`,
      `${BASE}/address/${ADDR}/txs/chain/${confirmedA.txid}`,
      `${BASE}/address/${ADDR}/txs/chain/${confirmedC.txid}`,
      `${BASE}/address/${ADDR}`,
    ])
  })

  it('requires the terminal empty response within the page-request budget', async () => {
    const confirmedA = historyTx('55'.repeat(32), true)
    const confirmedB = historyTx('66'.repeat(32), true)
    const { fetchFn, calls } = makeFetch(
      withStats(
        (_i, url) => {
          if (url.endsWith(`/address/${ADDR}/txs/mempool`)) return { body: '[]' }
          if (url.endsWith(`/address/${ADDR}/txs/chain`)) {
            return { body: JSON.stringify([confirmedA]) }
          }
          return { body: JSON.stringify([confirmedB]) }
        },
        2,
        0
      )
    )
    const client = new EsploraClient({ baseUrl: BASE, fetchFn, sleepFn: noSleep })

    await expect(client.getAddressHistory(ADDR, { maxPages: 2 })).rejects.toMatchObject({
      kind: 'pagination_limit',
      message: `esplora address history exceeded 2 page fetches: ${ADDR}`,
    })
    expect(calls).toHaveLength(4)
  })

  it('bounds raw history rows independently of page count', async () => {
    const mempoolTx = historyTx('77'.repeat(32), false)
    const confirmedTx = historyTx('88'.repeat(32), true)
    const { fetchFn, calls } = makeFetch(
      withStats(
        (_i, url) =>
          url.endsWith(`/txs/mempool`)
            ? { body: JSON.stringify([mempoolTx]) }
            : { body: JSON.stringify([confirmedTx]) },
        1,
        1
      )
    )
    const client = new EsploraClient({ baseUrl: BASE, fetchFn, sleepFn: noSleep })

    await expect(client.getAddressHistory(ADDR, { maxTransactions: 1 })).rejects.toMatchObject({
      kind: 'pagination_limit',
      message: `esplora address history exceeded 1 transactions: ${ADDR}`,
    })
    expect(calls).toHaveLength(3)
  })

  it('rejects transactions returned from the wrong Esplora history route', async () => {
    const confirmedTx = historyTx('99'.repeat(32), true)
    const unconfirmedTx = historyTx('aa'.repeat(32), false)
    const confirmedOnMempool = makeFetch(
      withStats(
        (_i, url) => (url.endsWith(`/txs/mempool`) ? { body: JSON.stringify([confirmedTx]) } : { body: '[]' }),
        1,
        0
      )
    )
    const mempoolClient = new EsploraClient({
      baseUrl: BASE,
      fetchFn: confirmedOnMempool.fetchFn,
      sleepFn: noSleep,
    })
    await expect(mempoolClient.getAddressHistory(ADDR)).rejects.toMatchObject({
      kind: 'parse',
      message: expect.stringContaining('esplora mempool history returned a confirmed transaction'),
    })

    const unconfirmedOnChain = makeFetch(
      withStats(
        (_i, url) => (url.endsWith(`/txs/mempool`) ? { body: '[]' } : { body: JSON.stringify([unconfirmedTx]) }),
        0,
        1
      )
    )
    const chainClient = new EsploraClient({
      baseUrl: BASE,
      fetchFn: unconfirmedOnChain.fetchFn,
      sleepFn: noSleep,
    })
    await expect(chainClient.getAddressHistory(ADDR)).rejects.toMatchObject({
      kind: 'parse',
      message: expect.stringContaining('esplora confirmed history returned an unconfirmed transaction'),
    })
  })

  it('broadcasts a raw tx via POST /tx and returns the txid', async () => {
    const { fetchFn, calls } = kit([{ route: 'POST /tx', kind: 'status', status: 200, body: BROADCAST_TXID }])
    const client = new EsploraClient({ baseUrl: BASE, fetchFn, sleepFn: noSleep })
    const txid = await client.broadcastTx('0200000000ffff')
    expect(txid).toBe(BROADCAST_TXID)
    expect(calls[0]!.method).toBe('POST')
    expect(calls[0]!.body).toBe('0200000000ffff')
  })

  it('surfaces a broadcast rejection as an http error with the node message', async () => {
    const { fetchFn } = kit([always('POST /tx', 400, 'sendrawtransaction RPC error: bad-txns')])
    const client = new EsploraClient({ baseUrl: BASE, fetchFn, sleepFn: noSleep })
    await expect(client.broadcastTx('00')).rejects.toMatchObject({ kind: 'http', status: 400 })
    await expect(client.broadcastTx('00')).rejects.toThrow(/bad-txns/)
  })
})

describe('MempoolQbitClient endpoints', () => {
  const mempoolTx = {
    txid: '11'.repeat(32),
    version: 2,
    locktime: 0,
    vin: [],
    vout: [],
    size: 100,
    weight: 100,
    fee: 10,
    status: { confirmed: false },
  }
  const confirmedTx = {
    ...mempoolTx,
    txid: '22'.repeat(32),
    status: { confirmed: true, block_height: 8, block_time: 123 },
  }

  it('preserves confirmed and mempool address-history contracts', async () => {
    const { fetchFn, calls } = makeFetch(() => ({
      body: JSON.stringify([mempoolTx, confirmedTx]),
    }))
    const client = new MempoolQbitClient({ baseUrl: BASE, fetchFn, sleepFn: noSleep })

    await expect(client.getAddressMempoolTxs(ADDR)).resolves.toEqual([mempoolTx])
    await expect(client.getAddressTxs(ADDR)).resolves.toEqual([confirmedTx])
    expect(calls).toHaveLength(2)
    expect(calls.every(call => call.url === `${BASE}/address/${ADDR}/txs`)).toBe(true)
  })

  it('collects variable-sized combined history in one page-one traversal', async () => {
    const mempoolA = historyTx('a1'.repeat(32), false)
    const mempoolB = historyTx('a2'.repeat(32), false)
    const mempoolC = historyTx('a3'.repeat(32), false)
    const confirmedB = historyTx('a4'.repeat(32), true)
    const confirmedC = historyTx('a5'.repeat(32), true)
    const confirmedD = historyTx('a6'.repeat(32), true)
    const firstPage = [mempoolA, mempoolB]
    const secondPage = [mempoolC, confirmedB, confirmedC, confirmedD]
    const { fetchFn, calls } = makeFetch(
      withStats(
        (_i, url) => {
          if (url.endsWith(`/address/${ADDR}/txs`)) {
            return { body: JSON.stringify(firstPage) }
          }
          if (url.endsWith(`/address/${ADDR}/txs?after_txid=${mempoolB.txid}`)) {
            return { body: JSON.stringify(secondPage) }
          }
          if (url.endsWith(`/address/${ADDR}/txs?after_txid=${confirmedD.txid}`)) {
            return { body: '[]' }
          }
          throw new Error(`unexpected url ${url}`)
        },
        3,
        3
      )
    )
    const client = new MempoolQbitClient({ baseUrl: BASE, fetchFn, sleepFn: noSleep })

    await expect(client.getAddressHistory(ADDR, { maxPages: 3, maxTransactions: 6 })).resolves.toEqual({
      confirmed: [confirmedB, confirmedC, confirmedD],
      mempool: [mempoolA, mempoolB, mempoolC],
    })
    expect(calls.map(call => call.url)).toEqual([
      `${BASE}/address/${ADDR}`,
      `${BASE}/address/${ADDR}/txs`,
      `${BASE}/address/${ADDR}/txs?after_txid=${mempoolB.txid}`,
      `${BASE}/address/${ADDR}/txs?after_txid=${confirmedD.txid}`,
      `${BASE}/address/${ADDR}`,
    ])
  })

  it('accepts a live-shaped 32-row page followed by explicit exhaustion', async () => {
    const page = Array.from({ length: 32 }, (_, index) => historyTx((index + 1).toString(16).padStart(64, '0'), true))
    const { fetchFn, calls } = makeFetch(
      withStats(
        (_i, url) => (url.endsWith(`/address/${ADDR}/txs`) ? { body: JSON.stringify(page) } : { body: '[]' }),
        32,
        0
      )
    )
    const client = new MempoolQbitClient({ baseUrl: BASE, fetchFn, sleepFn: noSleep })

    await expect(client.getAddressHistory(ADDR, { maxPages: 2 })).resolves.toEqual({
      confirmed: page,
      mempool: [],
    })
    expect(calls).toHaveLength(4)
    expect(calls[2]!.url).toBe(`${BASE}/address/${ADDR}/txs?after_txid=${page[page.length - 1]!.txid}`)
  })

  it('accepts spending history through an input prevout address', async () => {
    const addressPrevout = historyTx('b1'.repeat(32), true).vout[0]!
    const spendingTx = {
      ...historyTx('b2'.repeat(32), true),
      vin: [
        {
          txid: 'b3'.repeat(32),
          vout: 0,
          prevout: addressPrevout,
          scriptsig: '',
          scriptsig_asm: '',
          is_coinbase: false,
          sequence: 0xffffffff,
        },
      ],
      vout: [],
    }
    const { fetchFn } = makeFetch(
      withStats(
        (_i, url) => (url.endsWith(`/address/${ADDR}/txs`) ? { body: JSON.stringify([spendingTx]) } : { body: '[]' }),
        1,
        0
      )
    )
    const client = new MempoolQbitClient({ baseUrl: BASE, fetchFn, sleepFn: noSleep })

    await expect(client.getAddressHistory(ADDR, { maxPages: 2 })).resolves.toEqual({
      confirmed: [spendingTx],
      mempool: [],
    })
  })

  it('matches uniformly uppercase Bech32m requests to normalized row addresses', async () => {
    const uppercaseAddress = ADDR.toUpperCase()
    const tx = historyTx('b4'.repeat(32), true)
    const { fetchFn, calls } = makeFetch(
      withStats(
        (_i, url) =>
          url.endsWith(`/address/${uppercaseAddress}/txs`) ? { body: JSON.stringify([tx]) } : { body: '[]' },
        1,
        0,
        uppercaseAddress
      )
    )
    const client = new MempoolQbitClient({ baseUrl: BASE, fetchFn, sleepFn: noSleep })

    await expect(client.getAddressHistory(uppercaseAddress, { maxPages: 2 })).resolves.toEqual({
      confirmed: [tx],
      mempool: [],
    })
    expect(calls).toHaveLength(4)
  })

  it('does not case-fold addresses outside the qbit Bech32 HRPs', async () => {
    const requestedAddress = 'ABC1QPZRY9X8'
    const tx = {
      ...historyTx('b5'.repeat(32), true),
      vout: [
        {
          ...historyTx('b6'.repeat(32), true).vout[0]!,
          scriptpubkey_address: requestedAddress.toLowerCase(),
        },
      ],
    }
    const { fetchFn, calls } = makeFetch(withStats(() => ({ body: JSON.stringify([tx]) }), 1, 0, requestedAddress))
    const client = new MempoolQbitClient({ baseUrl: BASE, fetchFn, sleepFn: noSleep })

    await expect(client.getAddressHistory(requestedAddress)).rejects.toMatchObject({
      kind: 'parse',
      message: expect.stringContaining(`did not touch ${requestedAddress}`),
    })
    expect(calls).toHaveLength(2)
  })

  it('keeps the configured page ceiling as a per-call hard maximum', async () => {
    const confirmedA = historyTx('c1'.repeat(32), true)
    const confirmedB = historyTx('c2'.repeat(32), true)
    const { fetchFn, calls } = makeFetch(
      withStats(
        (_i, url) =>
          url.endsWith(`/address/${ADDR}/txs`)
            ? { body: JSON.stringify([confirmedA]) }
            : { body: JSON.stringify([confirmedB]) },
        2,
        0
      )
    )
    const client = new MempoolQbitClient({
      baseUrl: BASE,
      fetchFn,
      sleepFn: noSleep,
      maxAddressHistoryPages: 2,
    })

    await expect(client.getAddressHistory(ADDR, { maxPages: 10 })).rejects.toMatchObject({
      kind: 'pagination_limit',
      message: `mempool-qbit address history exceeded 2 pages: ${ADDR}`,
    })
    expect(calls).toHaveLength(3)
  })

  it('bounds raw combined-history rows before classification', async () => {
    const page = [
      { ...historyTx('d1'.repeat(32), false), status: {} },
      { ...historyTx('d2'.repeat(32), true), vin: [null] },
    ]
    const { fetchFn, calls } = makeFetch(withStats(() => ({ body: JSON.stringify(page) }), 1, 1))
    const client = new MempoolQbitClient({ baseUrl: BASE, fetchFn, sleepFn: noSleep })

    await expect(client.getAddressHistory(ADDR, { maxPages: 2, maxTransactions: 1 })).rejects.toMatchObject({
      kind: 'pagination_limit',
      message: `mempool-qbit address history exceeded 1 transactions: ${ADDR}`,
    })
    expect(calls).toHaveLength(2)
  })

  it('rejects duplicate transaction ids within one combined-history page', async () => {
    const tx = historyTx('e1'.repeat(32), true)
    const duplicate = { ...tx, txid: tx.txid.toUpperCase() }
    const { fetchFn, calls } = makeFetch(withStats(() => ({ body: JSON.stringify([tx, duplicate]) }), 1, 0))
    const client = new MempoolQbitClient({ baseUrl: BASE, fetchFn, sleepFn: noSleep })

    await expect(client.getAddressHistory(ADDR)).rejects.toMatchObject({
      kind: 'invalid_cursor',
      message: expect.stringContaining(`repeated transaction ${duplicate.txid}`),
    })
    expect(calls).toHaveLength(2)
  })

  it('rejects duplicate transaction ids across advancing pages', async () => {
    const firstTx = historyTx('e2'.repeat(32), true)
    const nextTx = historyTx('e3'.repeat(32), true)
    const { fetchFn, calls } = makeFetch(
      withStats(
        (_i, url) =>
          url.endsWith(`/address/${ADDR}/txs`)
            ? { body: JSON.stringify([firstTx]) }
            : { body: JSON.stringify([firstTx, nextTx]) },
        2,
        0
      )
    )
    const client = new MempoolQbitClient({ baseUrl: BASE, fetchFn, sleepFn: noSleep })

    await expect(client.getAddressHistory(ADDR)).rejects.toMatchObject({
      kind: 'invalid_cursor',
      message: expect.stringContaining(`repeated transaction ${firstTx.txid}`),
    })
    expect(calls).toHaveLength(3)
  })

  it('fails closed when a combined-history cursor stops advancing', async () => {
    const tx = historyTx('e4'.repeat(32), true)
    const { fetchFn, calls } = makeFetch(withStats(() => ({ body: JSON.stringify([tx]) }), 1, 0))
    const client = new MempoolQbitClient({ baseUrl: BASE, fetchFn, sleepFn: noSleep })

    await expect(client.getAddressHistory(ADDR)).rejects.toMatchObject({
      kind: 'invalid_cursor',
      message: expect.stringContaining('cursor stopped advancing'),
    })
    expect(calls).toHaveLength(3)
  })

  it('propagates a backend failure while exhausting combined history', async () => {
    const tx = historyTx('e5'.repeat(32), true)
    const { fetchFn, calls } = makeFetch(
      withStats(
        (_i, url) =>
          url.endsWith(`/address/${ADDR}/txs`)
            ? { body: JSON.stringify([tx]) }
            : { status: 500, body: 'history unavailable' },
        2,
        0
      )
    )
    const client = new MempoolQbitClient({
      baseUrl: BASE,
      fetchFn,
      sleepFn: noSleep,
      retries: 0,
    })

    await expect(client.getAddressHistory(ADDR)).rejects.toMatchObject({
      kind: 'http',
      status: 500,
      responseBody: 'history unavailable',
    })
    expect(calls).toHaveLength(3)
  })

  it('rejects malformed or unrelated combined-history rows', async () => {
    const unrelatedTx = { ...historyTx('f1'.repeat(32), true), vin: [], vout: [] }
    const unrelated = makeFetch(withStats(() => ({ body: JSON.stringify([unrelatedTx]) }), 1, 0))
    const unrelatedClient = new MempoolQbitClient({
      baseUrl: BASE,
      fetchFn: unrelated.fetchFn,
      sleepFn: noSleep,
    })
    await expect(unrelatedClient.getAddressHistory(ADDR)).rejects.toMatchObject({
      kind: 'parse',
      message: expect.stringContaining(`did not touch ${ADDR}`),
    })

    const malformedTx = { ...historyTx('f2'.repeat(32), true), status: {} }
    const malformed = makeFetch(withStats(() => ({ body: JSON.stringify([malformedTx]) }), 1, 0))
    const malformedClient = new MempoolQbitClient({
      baseUrl: BASE,
      fetchFn: malformed.fetchFn,
      sleepFn: noSleep,
    })
    await expect(malformedClient.getAddressHistory(ADDR)).rejects.toMatchObject({
      kind: 'parse',
      message: expect.stringContaining('invalid txid, status, vin, or vout'),
    })

    const missingTxid = { ...historyTx('f3'.repeat(32), true), txid: '' }
    const missing = makeFetch(withStats(() => ({ body: JSON.stringify([missingTxid]) }), 1, 0))
    const missingClient = new MempoolQbitClient({
      baseUrl: BASE,
      fetchFn: missing.fetchFn,
      sleepFn: noSleep,
    })
    await expect(missingClient.getAddressHistory(ADDR)).rejects.toMatchObject({
      kind: 'parse',
      message: expect.stringContaining('invalid txid, status, vin, or vout'),
    })
  })

  it.each([
    [{ maxPages: 0 }, 'maxPages'],
    [{ maxPages: 1.5 }, 'maxPages'],
    [{ maxTransactions: -1 }, 'maxTransactions'],
    [{ maxTransactions: Number.MAX_SAFE_INTEGER + 1 }, 'maxTransactions'],
  ])('rejects invalid complete-history limits %o', async (options, name) => {
    const { fetchFn, calls } = kit([], 'mempool-qbit')
    const client = new MempoolQbitClient({ baseUrl: BASE, fetchFn, sleepFn: noSleep })

    await expect(client.getAddressHistory(ADDR, options)).rejects.toThrow(`${name} must be a positive integer`)
    expect(calls).toHaveLength(0)
  })

  it('scans combined history to validate a confirmed continuation cursor', async () => {
    const cursorTx = { ...confirmedTx, txid: '44'.repeat(32) }
    const nextTx = { ...confirmedTx, txid: '55'.repeat(32) }
    const firstPage = [
      mempoolTx,
      ...Array.from({ length: 8 }, (_, index) => ({
        ...confirmedTx,
        txid: String(index + 1).padStart(64, 'a'),
      })),
      cursorTx,
    ]
    const { fetchFn, calls } = makeFetch((_i, url) => {
      if (url.endsWith(`/address/${ADDR}/txs`)) return { body: JSON.stringify(firstPage) }
      if (url.endsWith(`/address/${ADDR}/txs?after_txid=${cursorTx.txid}`)) {
        return { body: JSON.stringify([nextTx]) }
      }
      throw new Error(`unexpected url ${url}`)
    })
    const client = new MempoolQbitClient({ baseUrl: BASE, fetchFn, sleepFn: noSleep })

    await expect(client.getAddressTxs(ADDR, cursorTx.txid)).resolves.toEqual([nextTx])
    expect(calls.map(call => call.url)).toEqual([
      `${BASE}/address/${ADDR}/txs`,
      `${BASE}/address/${ADDR}/txs?after_txid=${cursorTx.txid}`,
    ])
  })

  it('fails closed when a continuation cursor is stale or unconfirmed', async () => {
    const { fetchFn, calls } = makeFetch(() => ({
      body: JSON.stringify([mempoolTx, confirmedTx]),
    }))
    const client = new MempoolQbitClient({ baseUrl: BASE, fetchFn, sleepFn: noSleep })
    const staleTxid = 'ff'.repeat(32)

    await expect(client.getAddressTxs(ADDR, staleTxid)).rejects.toMatchObject({
      kind: 'invalid_cursor',
    })
    await expect(client.getAddressTxs(ADDR, mempoolTx.txid)).rejects.toMatchObject({
      kind: 'invalid_cursor',
    })
    expect(calls).toHaveLength(2)
    expect(calls.every(call => !call.url.includes('after_txid='))).toBe(true)
  })

  it('propagates qbit-electrs rejection when an internal cursor disappears', async () => {
    const firstPage = Array.from({ length: 10 }, (_, index) => ({
      ...mempoolTx,
      txid: String(index + 1).padStart(64, '0'),
    }))
    const { fetchFn, calls } = makeFetch((_i, url) =>
      url.endsWith(`/address/${ADDR}/txs`)
        ? { body: JSON.stringify(firstPage) }
        : { status: 422, body: 'after_txid not found' }
    )
    const client = new MempoolQbitClient({ baseUrl: BASE, fetchFn, sleepFn: noSleep })

    await expect(client.getAddressTxs(ADDR)).rejects.toMatchObject({
      kind: 'http',
      status: 422,
      responseBody: 'after_txid not found',
    })
    expect(calls).toHaveLength(2)
  })

  it('counts continuation validation against the configured page limit', async () => {
    const firstPage = Array.from({ length: 10 }, (_, index) => ({
      ...confirmedTx,
      txid: String(index + 1).padStart(64, '0'),
    }))
    const cursorTx = { ...confirmedTx, txid: '66'.repeat(32) }
    const nextTx = { ...confirmedTx, txid: '77'.repeat(32) }
    const makeContinuationFetch = () =>
      makeFetch((_i, url) =>
        url.endsWith(`/address/${ADDR}/txs`)
          ? { body: JSON.stringify(firstPage) }
          : { body: JSON.stringify([cursorTx, nextTx]) }
      )

    const limited = makeContinuationFetch()
    const limitedClient = new MempoolQbitClient({
      baseUrl: BASE,
      fetchFn: limited.fetchFn,
      sleepFn: noSleep,
      maxAddressHistoryPages: 1,
    })
    await expect(limitedClient.getAddressTxs(ADDR, cursorTx.txid)).rejects.toMatchObject({
      kind: 'pagination_limit',
    })
    expect(limited.calls).toHaveLength(1)

    const raised = makeContinuationFetch()
    const raisedClient = new MempoolQbitClient({
      baseUrl: BASE,
      fetchFn: raised.fetchFn,
      sleepFn: noSleep,
      maxAddressHistoryPages: 2,
    })
    await expect(raisedClient.getAddressTxs(ADDR, cursorTx.txid)).resolves.toEqual([nextTx])
    expect(raised.calls).toHaveLength(2)
  })

  it('finishes both history views on the final allowed page', async () => {
    const firstPage = Array.from({ length: 10 }, (_, index) => ({
      ...mempoolTx,
      txid: String(index + 1).padStart(64, '0'),
    }))
    const secondPage = [
      { ...mempoolTx, txid: '11'.padStart(64, '0') },
      { ...mempoolTx, txid: '12'.padStart(64, '0') },
      confirmedTx,
    ]
    const { fetchFn, calls } = makeFetch((_i, url) => {
      if (url.endsWith(`/address/${ADDR}/txs`)) return { body: JSON.stringify(firstPage) }
      if (url.endsWith(`/address/${ADDR}/txs?after_txid=${firstPage[9]!.txid}`))
        return { body: JSON.stringify(secondPage) }
      throw new Error(`unexpected url ${url}`)
    })
    const client = new MempoolQbitClient({
      baseUrl: BASE,
      fetchFn,
      sleepFn: noSleep,
      maxAddressHistoryPages: 2,
    })

    await expect(client.getAddressTxs(ADDR)).resolves.toEqual([confirmedTx])
    await expect(client.getAddressMempoolTxs(ADDR)).resolves.toEqual([...firstPage, ...secondPage.slice(0, 2)])
    expect(calls).toHaveLength(4)
  })

  it('throws before fetching beyond the configured history page limit', async () => {
    const { fetchFn, calls } = makeFetch(callIndex => ({
      body: JSON.stringify(
        Array.from({ length: 10 }, (_, index) => ({
          ...mempoolTx,
          txid: String(callIndex * 10 + index + 1).padStart(64, '0'),
        }))
      ),
    }))
    const client = new MempoolQbitClient({
      baseUrl: BASE,
      fetchFn,
      sleepFn: noSleep,
      maxAddressHistoryPages: 2,
    })

    await expect(client.getAddressTxs(ADDR)).rejects.toMatchObject({
      kind: 'pagination_limit',
      message: `mempool-qbit address history exceeded 2 pages: ${ADDR}`,
    })
    expect(calls).toHaveLength(2)

    await expect(client.getAddressMempoolTxs(ADDR)).rejects.toMatchObject({
      kind: 'pagination_limit',
      message: `mempool-qbit address history exceeded 2 pages: ${ADDR}`,
    })
    expect(calls).toHaveLength(4)
  })

  it.each([0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1])(
    'rejects invalid maxAddressHistoryPages value %s',
    maxAddressHistoryPages => {
      expect(
        () =>
          new MempoolQbitClient({
            baseUrl: BASE,
            fetchFn: vi.fn() as typeof fetch,
            maxAddressHistoryPages,
          })
      ).toThrow(/positive integer/)
    }
  )

  it('fails closed when a volatile internal cursor restarts confirmed history', async () => {
    const firstPage = Array.from({ length: 10 }, (_, index) => ({
      ...mempoolTx,
      txid: String(index + 1).padStart(64, '0'),
    }))
    const { fetchFn, calls } = makeFetch(() => ({ body: JSON.stringify(firstPage) }))
    const client = new MempoolQbitClient({ baseUrl: BASE, fetchFn, sleepFn: noSleep })

    await expect(client.getAddressTxs(ADDR)).rejects.toMatchObject({
      kind: 'invalid_cursor',
      message: expect.stringContaining('cursor stopped advancing'),
    })
    expect(calls).toHaveLength(2)
    expect(calls[1]!.url).toContain(`after_txid=${firstPage[9]!.txid}`)
  })

  it('fails closed when a volatile internal cursor restarts mempool history', async () => {
    const firstPage = Array.from({ length: 10 }, (_, index) => ({
      ...mempoolTx,
      txid: String(index + 1).padStart(64, '0'),
    }))
    const { fetchFn, calls } = makeFetch(() => ({ body: JSON.stringify(firstPage) }))
    const client = new MempoolQbitClient({ baseUrl: BASE, fetchFn, sleepFn: noSleep })

    await expect(client.getAddressMempoolTxs(ADDR)).rejects.toMatchObject({
      kind: 'invalid_cursor',
      message: expect.stringContaining('cursor stopped advancing'),
    })
    expect(calls).toHaveLength(2)
    expect(calls[1]!.url).toContain(`after_txid=${firstPage[9]!.txid}`)
  })

  it('maps projected mempool fees while preserving named policy floors', async () => {
    const fees = {
      fastestFee: 9,
      halfHourFee: 6,
      hourFee: 3,
      economyFee: 2,
      minimumFee: 1,
    }
    const mock = createMockEsplora({ backend: 'mempool-qbit', baseUrl: BASE, recommendedFees: fees })
    const calls = mock.requests
    const client = new MempoolQbitClient({ baseUrl: BASE, fetchFn: mock.fetchFn, sleepFn: noSleep })

    await expect(client.getFeeEstimates()).resolves.toEqual({
      '1': 9,
      '2': 6,
      '3': 3,
    })
    await expect(client.getFeeTiers()).resolves.toEqual([
      { target: 1, feeRate: 9 },
      { target: 2, feeRate: 6 },
      { target: 3, feeRate: 3 },
    ])
    await expect(client.getMempoolRecommendedFees()).resolves.toEqual(fees)
    expect(calls.every(call => call.url === `${BASE}/fees/recommended`)).toBe(true)
  })

  it.each([
    ['plain backend failure', 400, 'Failed to send raw transaction'],
    ['structured case variant', 400, JSON.stringify({ error: 'FAILED to send raw transaction.' })],
    ['wording variant', 400, JSON.stringify({ error: { message: 'Unable to broadcast transaction' } })],
    ['alternate wording', 400, JSON.stringify({ message: 'Could not submit raw transaction!' })],
    ['missing endpoint', 404, 'not found'],
    ['unsupported method', 405, 'method not allowed'],
    ['unimplemented endpoint', 501, 'not implemented'],
  ])('falls back to /tx/push for %s', async (_case, status, body) => {
    const { fetchFn, calls } = makeFetch(i => (i === 0 ? { status, body } : { body: BROADCAST_TXID }))
    const client = new MempoolQbitClient({ baseUrl: BASE, fetchFn, sleepFn: noSleep })

    await expect(client.broadcastTx('0200000000ffff')).resolves.toBe(BROADCAST_TXID)
    expect(calls[0]!.url).toBe(`${BASE}/tx`)
    expect(calls[1]!.url).toBe(`${BASE}/tx/push`)
    expect(calls[1]!.init?.body).toBe('txHash=0200000000ffff')
    expect(calls[1]!.init?.headers).toMatchObject({ 'content-type': 'text/plain' })
  })

  it.each([
    ['plain RPC rejection', 'sendrawtransaction RPC error: {"code":-26}'],
    ['structured RPC rejection', JSON.stringify({ error: 'sendrawtransaction RPC error: {"code":-26}' })],
    ['transaction validity rejection', 'bad-txns-inputs-missingorspent'],
  ])('does not mask %s with the /tx/push fallback', async (_case, body) => {
    const { fetchFn, calls } = kit([always('POST /tx', 400, body), always('POST /tx/push', 400, body)], 'mempool-qbit')
    const client = new MempoolQbitClient({ baseUrl: BASE, fetchFn, sleepFn: noSleep })

    await expect(client.broadcastTx('0200000000ffff')).rejects.toMatchObject({
      kind: 'http',
      status: 400,
      responseBody: body,
    })
    expect(calls).toHaveLength(1)
  })
})

describe('EsploraClient error taxonomy', () => {
  const cases: { status: number; kind: string }[] = [
    { status: 429, kind: 'rate_limit' },
    { status: 413, kind: 'payload_too_large' },
    { status: 404, kind: 'not_found' },
    { status: 400, kind: 'http' },
  ]
  it.each(cases)('maps HTTP $status to $kind', async ({ status, kind }) => {
    const { fetchFn } = kit([always('GET /address/:address', status, 'x')])
    // retries=0 so 429 is not retried away
    const client = new EsploraClient({ baseUrl: BASE, fetchFn, retries: 0, sleepFn: noSleep })
    await expect(client.getAddressStats(ADDR)).rejects.toMatchObject({ kind })
  })

  it('classifies network errors and timeouts', async () => {
    const netClient = new EsploraClient({
      baseUrl: BASE,
      retries: 0,
      sleepFn: noSleep,
      fetchFn: (async () => {
        throw new TypeError('Failed to fetch')
      }) as typeof fetch,
    })
    await expect(netClient.getTipHash()).rejects.toMatchObject({ kind: 'network' })

    const timeoutClient = new EsploraClient({
      baseUrl: BASE,
      retries: 0,
      sleepFn: noSleep,
      fetchFn: (async () => {
        const err = new Error('aborted')
        err.name = 'AbortError'
        throw err
      }) as typeof fetch,
    })
    await expect(timeoutClient.getTipHash()).rejects.toMatchObject({ kind: 'timeout' })
  })

  it('raises a parse error on malformed JSON', async () => {
    const { fetchFn } = kit([always('GET /address/:address', 200, 'not json')])
    const client = new EsploraClient({ baseUrl: BASE, fetchFn, sleepFn: noSleep })
    await expect(client.getAddressStats(ADDR)).rejects.toMatchObject({ kind: 'parse' })
  })
})

describe('EsploraClient resilience', () => {
  it('retries transient 503 then succeeds, with backoff', async () => {
    const sleep = vi.fn(noSleep)
    const { fetchFn, calls, responses } = makeFetch(i =>
      i === 0 ? { status: 503, body: 'busy' } : { body: JSON.stringify(STATS) }
    )
    const client = new EsploraClient({ baseUrl: BASE, fetchFn, retries: 2, sleepFn: sleep })
    const stats = await client.getAddressStats(ADDR)
    expect(stats.address).toBe(ADDR)
    expect(calls.length).toBe(2)
    expect(sleep).toHaveBeenCalledTimes(1)
    expect(responses[0]!.bodyUsed).toBe(true)
  })

  it('retries network errors then succeeds', async () => {
    let n = 0
    const client = new EsploraClient({
      baseUrl: BASE,
      retries: 2,
      sleepFn: noSleep,
      fetchFn: (async () => {
        if (n++ === 0) throw new TypeError('Failed to fetch')
        return new Response(JSON.stringify(STATS), { status: 200 })
      }) as typeof fetch,
    })
    expect((await client.getAddressStats(ADDR)).address).toBe(ADDR)
    expect(n).toBe(2)
  })

  it('honors Retry-After on 429', async () => {
    const sleep = vi.fn(noSleep)
    const { fetchFn } = kit([
      { route: 'GET /address/:address', kind: 'status', status: 429, body: 'slow down', retryAfter: '2' },
    ])
    const client = new EsploraClient({ baseUrl: BASE, fetchFn, retries: 1, sleepFn: sleep })
    await client.getAddressStats(ADDR)
    expect(sleep).toHaveBeenCalledWith(2000, expect.any(AbortSignal))
  })

  describe('Retry-After cap', () => {
    const ONE_YEAR_S = 31_536_000

    /** The first request to `route` answers `status` with `Retry-After: retryAfter`; the rest succeed. */
    function rateLimited(retryAfter: string, status = 429, route: MockRoute = 'GET /address/:address') {
      return kit([{ route, kind: 'status', status, body: 'slow down', retryAfter }])
    }

    it('honours a Retry-After up to and including the 30 s default cap', async () => {
      for (const [header, ms] of [
        ['0', 0],
        ['1.5', 1500],
        ['30', 30_000],
      ] as const) {
        const sleep = vi.fn(noSleep)
        const { fetchFn, calls } = rateLimited(header)
        const client = new EsploraClient({ baseUrl: BASE, fetchFn, retries: 1, sleepFn: sleep })
        expect((await client.getAddressStats(ADDR)).address).toBe(ADDR)
        expect(sleep.mock.calls).toEqual([[ms, expect.any(AbortSignal)]])
        expect(calls).toHaveLength(2)
      }
    })

    it('throws rate_limit at once with retryAfterMs when the server asks for longer than the cap', async () => {
      const sleep = vi.fn(noSleep)
      // makeFetch, to check that the reply's own body was consumed.
      const { fetchFn, calls, responses } = makeFetch(i =>
        i === 0
          ? { status: 429, body: 'slow down', headers: { 'retry-after': String(ONE_YEAR_S) } }
          : { body: JSON.stringify(STATS) }
      )
      const client = new EsploraClient({ baseUrl: BASE, fetchFn, retries: 2, sleepFn: sleep })
      await expect(client.getAddressStats(ADDR)).rejects.toMatchObject({
        name: 'QbitApiError',
        kind: 'rate_limit',
        status: 429,
        retryAfterMs: ONE_YEAR_S * 1000,
      })
      expect(sleep).not.toHaveBeenCalled()
      expect(calls).toHaveLength(1)
      expect(responses[0]!.bodyUsed).toBe(true)
    })

    it('does not retry an over-cap Retry-After through the default timer sleep', async () => {
      // 31 536 000 000 ms overflows setTimeout, which then fires immediately.
      const { fetchFn, calls } = rateLimited(String(ONE_YEAR_S))
      const client = new EsploraClient({ baseUrl: BASE, fetchFn, retries: 2 })
      await expect(client.getAddressStats(ADDR)).rejects.toMatchObject({
        kind: 'rate_limit',
        retryAfterMs: ONE_YEAR_S * 1000,
      })
      expect(calls).toHaveLength(1)
    })

    it('applies a custom maxRetryAfterMs at its exact boundary', async () => {
      const atCapSleep = vi.fn(noSleep)
      const atCap = rateLimited('2')
      const atCapClient = new EsploraClient({
        baseUrl: BASE,
        fetchFn: atCap.fetchFn,
        retries: 1,
        maxRetryAfterMs: 2000,
        sleepFn: atCapSleep,
      })
      expect((await atCapClient.getAddressStats(ADDR)).address).toBe(ADDR)
      expect(atCapSleep.mock.calls).toEqual([[2000, expect.any(AbortSignal)]])

      const overCapSleep = vi.fn(noSleep)
      const overCap = rateLimited('2')
      const overCapClient = new EsploraClient({
        baseUrl: BASE,
        fetchFn: overCap.fetchFn,
        retries: 1,
        maxRetryAfterMs: 1999,
        sleepFn: overCapSleep,
      })
      await expect(overCapClient.getAddressStats(ADDR)).rejects.toMatchObject({
        kind: 'rate_limit',
        retryAfterMs: 2000,
      })
      expect(overCapSleep).not.toHaveBeenCalled()
      expect(overCap.calls).toHaveLength(1)
    })

    it('fails fast on every Retry-After when maxRetryAfterMs is 0, except an immediate retry', async () => {
      const sleep = vi.fn(noSleep)
      const now = rateLimited('0')
      const nowClient = new EsploraClient({
        baseUrl: BASE,
        fetchFn: now.fetchFn,
        retries: 1,
        maxRetryAfterMs: 0,
        sleepFn: sleep,
      })
      expect((await nowClient.getAddressStats(ADDR)).address).toBe(ADDR)
      expect(sleep.mock.calls).toEqual([[0, expect.any(AbortSignal)]])

      const later = rateLimited('1')
      const laterClient = new EsploraClient({
        baseUrl: BASE,
        fetchFn: later.fetchFn,
        retries: 1,
        maxRetryAfterMs: 0,
        sleepFn: sleep,
      })
      await expect(laterClient.getAddressStats(ADDR)).rejects.toMatchObject({ kind: 'rate_limit', retryAfterMs: 1000 })
      expect(later.calls).toHaveLength(1)
    })

    it('treats an HTTP-date Retry-After the same way', async () => {
      vi.useFakeTimers({ toFake: ['Date'] })
      try {
        vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'))

        const nearSleep = vi.fn(noSleep)
        const near = rateLimited('Thu, 01 Jan 2026 00:00:10 GMT')
        const nearClient = new EsploraClient({ baseUrl: BASE, fetchFn: near.fetchFn, retries: 1, sleepFn: nearSleep })
        expect((await nearClient.getAddressStats(ADDR)).address).toBe(ADDR)
        expect(nearSleep.mock.calls).toEqual([[10_000, expect.any(AbortSignal)]])

        const pastSleep = vi.fn(noSleep)
        const past = rateLimited('Wed, 31 Dec 2025 23:00:00 GMT')
        const pastClient = new EsploraClient({ baseUrl: BASE, fetchFn: past.fetchFn, retries: 1, sleepFn: pastSleep })
        expect((await pastClient.getAddressStats(ADDR)).address).toBe(ADDR)
        expect(pastSleep.mock.calls).toEqual([[0, expect.any(AbortSignal)]])

        const farSleep = vi.fn(noSleep)
        const far = rateLimited('Fri, 01 Jan 2027 00:00:00 GMT')
        const farClient = new EsploraClient({ baseUrl: BASE, fetchFn: far.fetchFn, retries: 2, sleepFn: farSleep })
        await expect(farClient.getAddressStats(ADDR)).rejects.toMatchObject({
          kind: 'rate_limit',
          retryAfterMs: ONE_YEAR_S * 1000,
        })
        expect(farSleep).not.toHaveBeenCalled()
        expect(far.calls).toHaveLength(1)
      } finally {
        vi.useRealTimers()
      }
    })

    it('fails fast with a finite retryAfterMs for values too large to represent', async () => {
      for (const header of ['1e300', '9'.repeat(400)]) {
        const sleep = vi.fn(noSleep)
        const { fetchFn, calls } = rateLimited(header)
        const client = new EsploraClient({ baseUrl: BASE, fetchFn, retries: 2, sleepFn: sleep })
        await expect(client.getAddressStats(ADDR)).rejects.toMatchObject({
          kind: 'rate_limit',
          retryAfterMs: Number.MAX_SAFE_INTEGER,
        })
        expect(sleep).not.toHaveBeenCalled()
        expect(calls).toHaveLength(1)
      }
    })

    it('throws a transient http error with retryAfterMs for an over-cap 503', async () => {
      const sleep = vi.fn(noSleep)
      const { fetchFn, calls } = rateLimited('3600', 503, 'GET /blocks/tip/hash')
      const client = new EsploraClient({ baseUrl: BASE, fetchFn, retries: 2, sleepFn: sleep })
      await expect(client.getTipHash()).rejects.toMatchObject({ kind: 'http', status: 503, retryAfterMs: 3_600_000 })
      expect(sleep).not.toHaveBeenCalled()
      expect(calls).toHaveLength(1)
    })

    it('releases every de-duplicated waiter when the server asks for longer than the cap', async () => {
      const sleep = vi.fn(noSleep)
      const { fetchFn, calls } = rateLimited(String(ONE_YEAR_S))
      const client = new EsploraClient({ baseUrl: BASE, fetchFn, retries: 2, sleepFn: sleep })
      const results = await Promise.allSettled([client.getAddressStats(ADDR), client.getAddressStats(ADDR)])
      for (const result of results) {
        expect(result.status).toBe('rejected')
        expect((result as PromiseRejectedResult).reason).toMatchObject({
          kind: 'rate_limit',
          retryAfterMs: ONE_YEAR_S * 1000,
        })
      }
      expect(sleep).not.toHaveBeenCalled()
      expect(calls).toHaveLength(1)
    })

    it('reports retryAfterMs once retries are exhausted, and falls back to backoff for malformed values', async () => {
      const exhausted = rateLimited('5')
      const exhaustedClient = new EsploraClient({
        baseUrl: BASE,
        fetchFn: exhausted.fetchFn,
        retries: 0,
        sleepFn: noSleep,
      })
      await expect(exhaustedClient.getAddressStats(ADDR)).rejects.toMatchObject({
        kind: 'rate_limit',
        retryAfterMs: 5000,
      })

      const sleep = vi.fn(noSleep)
      const malformed = rateLimited('soon')
      const malformedClient = new EsploraClient({
        baseUrl: BASE,
        fetchFn: malformed.fetchFn,
        retries: 1,
        retryBaseDelayMs: 300,
        sleepFn: sleep,
      })
      expect((await malformedClient.getAddressStats(ADDR)).address).toBe(ADDR)
      expect(sleep.mock.calls).toEqual([[300, expect.any(AbortSignal)]])

      const { fetchFn } = kit([
        { route: 'GET /address/:address', kind: 'status', status: 429, body: 'x', retryAfter: 'soon', times: Infinity },
      ])
      const error = await new EsploraClient({ baseUrl: BASE, fetchFn, retries: 0, sleepFn: noSleep })
        .getAddressStats(ADDR)
        .catch((e: unknown) => e)
      expect(error).toBeInstanceOf(QbitApiError)
      expect((error as QbitApiError).retryAfterMs).toBeUndefined()
    })

    it('validates maxRetryAfterMs at construction', () => {
      for (const maxRetryAfterMs of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 2_147_483_648, '1000', null]) {
        expect(
          () => new EsploraClient({ baseUrl: BASE, maxRetryAfterMs: maxRetryAfterMs as number }),
          String(maxRetryAfterMs)
        ).toThrow(/maxRetryAfterMs must be an integer from 0 to 2147483647/)
      }
      for (const maxRetryAfterMs of [0, 2_147_483_647, undefined]) {
        expect(() => new EsploraClient({ baseUrl: BASE, maxRetryAfterMs: maxRetryAfterMs as number })).not.toThrow()
      }
      expect(() => new MempoolQbitClient({ baseUrl: BASE, maxRetryAfterMs: -1 })).toThrow(QbitApiError)
    })
  })

  it('de-dups concurrent identical GETs into one request', async () => {
    let resolveReply: (reply: MockReply) => void = () => {}
    const gate = new Promise<MockReply>(resolve => {
      resolveReply = resolve
    })
    const { fetchFn, calls, responses } = makeFetch(() => gate)
    const client = new EsploraClient({ baseUrl: BASE, fetchFn, sleepFn: noSleep })

    const a = client.getAddressStats(ADDR)
    const b = client.getAddressStats(ADDR)
    resolveReply({ body: JSON.stringify(STATS) })
    const [ra, rb] = await Promise.all([a, b])

    expect(calls.length).toBe(1)
    expect(ra.address).toBe(ADDR)
    expect(rb.address).toBe(ADDR)
    expect(responses).toHaveLength(1)
    expect(responses[0]!.bodyUsed).toBe(true)
  })
})

describe('EsploraClient constructor options', () => {
  const MAX_TIMER_DELAY_MS = 2_147_483_647

  function expectInvalidOption(options: Partial<EsploraClientOptions>, message: RegExp) {
    const fetchFn = vi.fn() as unknown as typeof fetch
    let error: unknown
    try {
      new EsploraClient({ baseUrl: BASE, fetchFn, ...options })
    } catch (caught) {
      error = caught
    }
    expect(error).toBeInstanceOf(QbitApiError)
    expect(error).toMatchObject({ kind: 'http', message: expect.stringMatching(message) })
    expect(fetchFn).not.toHaveBeenCalled()
  }

  /** A fetch that never settles on its own and rejects like fetch does when aborted. */
  function hangingFetch(): typeof fetch {
    return ((_input: RequestInfo | URL, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          reject(new DOMException('The operation was aborted.', 'AbortError'))
        })
      })) as typeof fetch
  }

  it.each([
    Infinity,
    -Infinity,
    NaN,
    0,
    -1,
    1.5,
    MAX_TIMER_DELAY_MS + 1,
    '1000' as unknown as number,
    null as unknown as number,
  ])('rejects timeoutMs %s', timeoutMs => {
    expectInvalidOption({ timeoutMs }, /^timeoutMs must be an integer from 1 to 2147483647$/)
  })

  it.each([
    Infinity,
    NaN,
    -1,
    0.5,
    11,
    Number.MAX_SAFE_INTEGER + 1,
    '2' as unknown as number,
    null as unknown as number,
  ])('rejects retries %s', retries => {
    expectInvalidOption({ retries }, /^retries must be an integer from 0 to 10$/)
  })

  it.each([
    Infinity,
    -Infinity,
    NaN,
    -1,
    -0.5,
    MAX_TIMER_DELAY_MS + 1,
    '300' as unknown as number,
    null as unknown as number,
  ])('rejects retryBaseDelayMs %s', retryBaseDelayMs => {
    expectInvalidOption({ retryBaseDelayMs }, /^retryBaseDelayMs must be a finite number from 0 to 2147483647$/)
  })

  it.each([
    'ftp://esplora.example/api',
    'file:///etc/passwd',
    'javascript:alert(1)',
    'ws://esplora.example/api',
    'esplora.example/api',
    '/regtest/api',
    'https://',
    ' https://esplora.example/api',
    'https://esplora.example/api ',
    'https://esplora.example/api\n',
    'https://esplora .example/api',
    'https://esplora.example/api?x=1',
    'https://esplora.example/api?',
    'https://esplora.example/api#tip',
    'https://esplora.example/api\\',
    'https://esplora.example\\api',
    'https://esplora.example/api\u0001',
    '\u0000https://esplora.example/api',
    'https://esplora.example/api\u007f',
    'https://esplora.example/api\u0080',
    'https://esplora.example/api\u0085',
    'https://esplora.example/a\u0085pi',
    'https://esplora.example/api\u009f',
    'https://esplora.example/api\u00a0',
    'https://esplora.example/a\u00adpi',
    'https://esplora\u00ad.example/api',
    'https://esplora\u200b.example/api',
    'https://esplora.example/api\u200e',
    'https://esplora.example/api\u202e',
    'https://esplora.example/api\u2060',
    'https://esplora\ufe0f.example/api',
    'https://esplora.example/a\ufe0fpi',
    'https://esplora\u034f.example/api',
    'https://esplora\u180b.example/api',
    'https://esplora\u3164.example/api',
    'https://esplora\u{e0100}.example/api',
    'https://esplora\u200d.example/api',
    'https://esplora.example/a\u200dpi',
    'https://esplora.example/api\u200c',
    'https://\u0645\u06cc\u200c\u0631\u0648\u062f.example/a\u200cpi',
    'https://user:secret@esplora.example/api',
    'https://user@esplora.example/api',
    123 as unknown as string,
  ])('rejects baseUrl %j', baseUrl => {
    expectInvalidOption(
      { baseUrl },
      /^baseUrl must be an absolute http\(s\) URL without whitespace, control or format characters, backslashes, credentials, query or fragment$/
    )
  })

  it('treats explicitly undefined numeric options as omitted', async () => {
    const sleep = vi.fn((_ms: number) => noSleep())
    const { fetchFn, calls } = kit([always('GET /blocks/tip/height', 503, 'busy')])
    // exactOptionalPropertyTypes rejects the explicit undefined a JavaScript caller can pass.
    const unset = undefined as unknown as number
    const client = new EsploraClient({
      baseUrl: BASE,
      fetchFn,
      sleepFn: sleep,
      timeoutMs: unset,
      retries: unset,
      retryBaseDelayMs: unset,
    })
    await expect(client.getTipHeight()).rejects.toMatchObject({ kind: 'http', status: 503 })
    expect(calls).toHaveLength(3)
    expect(sleep.mock.calls.map(call => call[0])).toEqual([300, 600])
  })

  it('does not echo a rejected baseUrl, which may embed credentials', () => {
    expect(
      () =>
        new EsploraClient({
          baseUrl: 'https://user:hunter2@esplora.example/api',
          fetchFn: vi.fn() as unknown as typeof fetch,
        })
    ).toThrow(/^(?!.*hunter2)/)
  })

  it('still reports a missing baseUrl as required', () => {
    expectInvalidOption({ baseUrl: '' }, /^EsploraClient requires a baseUrl$/)
  })

  it('applies the same validation to MempoolQbitClient', () => {
    expect(
      () =>
        new MempoolQbitClient({
          baseUrl: 'https://mempool.example/api?x=1',
          fetchFn: vi.fn() as unknown as typeof fetch,
        })
    ).toThrow(/baseUrl must be an absolute http\(s\) URL/)
    expect(
      () => new MempoolQbitClient({ baseUrl: BASE, fetchFn: vi.fn() as unknown as typeof fetch, timeoutMs: Infinity })
    ).toThrow(/timeoutMs must be an integer/)
  })

  it.each([
    ['https://esplora.example/regtest/api', 'https://esplora.example/regtest/api/blocks/tip/height'],
    ['https://esplora.example/regtest/api///', 'https://esplora.example/regtest/api/blocks/tip/height'],
    ['http://127.0.0.1:3002', 'http://127.0.0.1:3002/blocks/tip/height'],
    ['HTTPS://Esplora.Example/api', 'HTTPS://Esplora.Example/api/blocks/tip/height'],
    ['https://b\u00fccher.example/api', 'https://b\u00fccher.example/api/blocks/tip/height'],
    ['https://exa\u0301mple.example/api', 'https://exa\u0301mple.example/api/blocks/tip/height'],
    ['https://esplora.example/\u00e9t\u00e9', 'https://esplora.example/\u00e9t\u00e9/blocks/tip/height'],
    [
      'https://\u0645\u06cc\u200c\u0631\u0648\u062f.example/api',
      'https://\u0645\u06cc\u200c\u0631\u0648\u062f.example/api/blocks/tip/height',
    ],
  ])('accepts baseUrl %s', async (baseUrl, expectedUrl) => {
    const mock = createMockEsplora({ backend: 'esplora', baseUrl, tip: { height: 7 } })
    const calls = mock.requests
    const client = new EsploraClient({ baseUrl, fetchFn: mock.fetchFn })
    expect(await client.getTipHeight()).toBe(7)
    expect(calls.map(call => call.url)).toEqual([expectedUrl])
  })

  it('accepts retries: 0 and makes exactly one attempt', async () => {
    const sleep = vi.fn(noSleep)
    const { fetchFn, calls } = kit([always('GET /blocks/tip/height', 503, 'busy')])
    const client = new EsploraClient({ baseUrl: BASE, fetchFn, retries: 0, sleepFn: sleep })
    await expect(client.getTipHeight()).rejects.toMatchObject({ kind: 'http', status: 503 })
    expect(calls).toHaveLength(1)
    expect(sleep).not.toHaveBeenCalled()
  })

  it('accepts retries: 10 and makes eleven attempts', async () => {
    const { fetchFn, calls } = kit([always('GET /blocks/tip/height', 503, 'busy')])
    const client = new EsploraClient({ baseUrl: BASE, fetchFn, retries: 10, sleepFn: noSleep })
    await expect(client.getTipHeight()).rejects.toMatchObject({ kind: 'http', status: 503 })
    expect(calls).toHaveLength(11)
  })

  it('accepts timeoutMs: 1 and times out after it', async () => {
    const client = new EsploraClient({ baseUrl: BASE, fetchFn: hangingFetch(), timeoutMs: 1, retries: 0 })
    await expect(client.getTipHeight()).rejects.toMatchObject({
      kind: 'timeout',
      message: expect.stringContaining('after 1ms'),
    })
  })

  it('arms the request timer with the configured timeoutMs, up to the setTimeout maximum', async () => {
    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout')
    try {
      for (const timeoutMs of [1, 25_000, MAX_TIMER_DELAY_MS]) {
        setTimeoutSpy.mockClear()
        const { fetchFn } = kit([], 'esplora', { tipHeight: 7 })
        const client = new EsploraClient({ baseUrl: BASE, fetchFn, timeoutMs })
        expect(await client.getTipHeight()).toBe(7)
        expect(setTimeoutSpy).toHaveBeenCalledWith(expect.any(Function), timeoutMs)
      }
    } finally {
      setTimeoutSpy.mockRestore()
    }
  })

  it('accepts fractional and zero retryBaseDelayMs', async () => {
    for (const retryBaseDelayMs of [0, 0.5]) {
      const sleep = vi.fn(noSleep)
      const { fetchFn } = kit([{ route: 'GET /blocks/tip/height', kind: 'status', status: 503 }], 'esplora', {
        tipHeight: 7,
      })
      const client = new EsploraClient({ baseUrl: BASE, fetchFn, retries: 1, retryBaseDelayMs, sleepFn: sleep })
      expect(await client.getTipHeight()).toBe(7)
      expect(sleep).toHaveBeenCalledWith(retryBaseDelayMs, expect.any(AbortSignal))
    }
  })

  it('keeps exponential backoff unchanged below the cap', async () => {
    const sleep = vi.fn((_ms: number) => noSleep())
    const { fetchFn } = kit([always('GET /blocks/tip/height', 503)])
    const client = new EsploraClient({ baseUrl: BASE, fetchFn, retries: 3, sleepFn: sleep })
    await expect(client.getTipHeight()).rejects.toMatchObject({ status: 503 })
    expect(sleep.mock.calls.map(([ms]) => ms)).toEqual([300, 600, 1200])
  })

  it('caps the computed backoff at the setTimeout maximum', async () => {
    const sleep = vi.fn((_ms: number) => noSleep())
    const { fetchFn } = kit([always('GET /blocks/tip/height', 503)])
    const client = new EsploraClient({
      baseUrl: BASE,
      fetchFn,
      retries: 10,
      retryBaseDelayMs: 100_000_000,
      sleepFn: sleep,
    })
    await expect(client.getTipHeight()).rejects.toMatchObject({ status: 503 })
    expect(sleep.mock.calls.map(([ms]) => ms)).toEqual([
      100_000_000,
      200_000_000,
      400_000_000,
      800_000_000,
      1_600_000_000,
      ...Array(5).fill(MAX_TIMER_DELAY_MS),
    ])
  })
})

describe('adapters', () => {
  it('computes confirmed/mempool/total balance from stats', () => {
    const balance = addressBalanceFromStats(STATS)
    expect(balance.confirmedSats).toBe(100_000) // 150k funded - 50k spent
    expect(balance.mempoolSats).toBe(20_000)
    expect(balance.totalSats).toBe(120_000)
  })

  it('sorts fee tiers by confirmation target', () => {
    const tiers = feeTiersFromEstimates({ '6': 4, '1': 12.5, '144': 1.1 })
    expect(tiers).toEqual([
      { target: 1, feeRate: 12.5 },
      { target: 6, feeRate: 4 },
      { target: 144, feeRate: 1.1 },
    ])
  })

  it('maps only mempool-qbit projected blocks to confirmation targets', () => {
    expect(
      feeEstimatesFromMempoolRecommendedFees({
        fastestFee: 8,
        halfHourFee: 5,
        hourFee: 3,
        economyFee: 2,
        minimumFee: 1,
      })
    ).toEqual({
      '1': 8,
      '2': 5,
      '3': 3,
    })
  })
})

describe('no legacy UniSat surface (guard)', () => {
  const source = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8').toLowerCase()
  it.each([
    'unisat.space',
    'inscription',
    'brc20',
    'runes',
    'alkanes',
    'getwalletconfig',
    'x-udid',
    'x-channel',
    'x-client',
  ])('does not reference %s', token => {
    expect(source.includes(token)).toBe(false)
  })
  it('exposes QbitApiError for typed handling', () => {
    expect(new QbitApiError('network', 'x').kind).toBe('network')
  })
})

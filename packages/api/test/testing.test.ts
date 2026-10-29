import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

import { EsploraClient, MempoolQbitClient, QbitApiError, txidFromRawTx } from '../src/index'
import {
  createMockEsplora,
  type MockEsplora,
  type MockEsploraOptions,
  type MockFault,
  type MockTx,
} from '../src/testing'

// The kit's own contract: one fixture behind every route both clients call,
// the two backends' differences, and fault injection producing exactly the
// outcomes docs/broadcasting.md lists.

const ADDR = 'qbrt1zqqqsyqcyq5rqwzqfpg9scrgwpugpzysnzs23v9ccrydpk8qarc0s8kqqny'
const OTHER = 'qbrt1zzasx2u2z7v9kn4q8e66r57mfw08xvrvdcqfcq6xfte0eau9dgdgqz42zd5'
const noSleep = () => Promise.resolve()

// The genesis coinbase transaction (legacy encoding) and its well-known txid.
const LEGACY_TX_HEX =
  '01000000010000000000000000000000000000000000000000000000000000000000000000ffffffff4d04ffff001d0104455468652054696d65732030332f4a616e2f32303039204368616e63656c6c6f72206f6e206272696e6b206f66207365636f6e64206261696c6f757420666f722062616e6b73ffffffff0100f2052a01000000434104678afdb0fe5548271967f1a67130b7105cd6a828e03909a67962e0ea1f61deb649f6bc3f4cef38c4f35504e51ec112de5c384df7ba0b8d578a4c702b6bf11d5fac00000000'
const LEGACY_TXID = '4a5e1e4baab89f3a32518a88c31bc87f618f76673e2cc77ab2127b7afdeda33b'
/** A real P2MR witness transaction whose txid the client derives from the hex. */
const P2MR_TX = JSON.parse(readFileSync(new URL('./fixtures/p2mr-witness-tx.json', import.meta.url), 'utf8')) as {
  rawTxHex: string
  txid: string
}
/** The outputs P2MR_TX spends (its outpoints, whose txids the hex holds byte-reversed), so the node takes it. */
const P2MR_FUNDING: MockTx[] = [
  {
    txid: '2221201f1e1d1c1b1a191817161514131211100f0e0d0c0b0a09080706050403',
    vout: [{ value: 0 }, { value: 0 }, { value: 0 }, { value: 100_000 }],
    block: { height: 0 },
  },
  {
    txid: '47464544434241403f3e3d3c3b3a393837363534333231302f2e2d2c2b2a2928',
    vout: [{ value: 100_000 }],
    block: { height: 0 },
  },
]

/**
 * An unsigned legacy transaction spending `inputs`, with one output per entry
 * of `outputs`, each paying `OP_TRUE` unless given a script. The mock checks
 * no script or signature.
 */
function legacyTx(inputs: { txid: string; vout: number }[], outputs: { value: number; script?: string }[]): string {
  const uint = (value: number, bytes: number): string =>
    Array.from({ length: bytes }, (_, i) => (Math.floor(value / 256 ** i) % 256).toString(16).padStart(2, '0')).join('')
  const reversed = (hex: string): string => hex.match(/../g)!.reverse().join('')
  return [
    uint(2, 4),
    uint(inputs.length, 1),
    ...inputs.map(input => `${reversed(input.txid)}${uint(input.vout, 4)}00fdffffff`),
    uint(outputs.length, 1),
    ...outputs.map(({ value, script = '51' }) => `${uint(value, 8)}${uint(script.length / 2, 1)}${script}`),
    uint(0, 4),
  ].join('')
}

/** A submission's raw reply, as `[status, body]`, for a verdict the client resolves either way. */
async function submit(mock: MockEsplora, hex: string): Promise<[number, string]> {
  const reply = await mock.fetchFn(`${mock.baseUrl}/tx`, { method: 'POST', body: hex })
  return [reply.status, await reply.text()]
}

const rpcError = (code: number, message: string): string =>
  `sendrawtransaction RPC error: ${JSON.stringify({ code, message })}`

function txid(tag: number, n: number): string {
  return tag.toString(16).padStart(2, '0') + n.toString(16).padStart(62, '0')
}

/** `confirmed` funding transactions in blocks 1, 2, ... and `mempool` ones, each paying ADDR 1,000 sats. */
function history(confirmed: number, mempool: number): MockTx[] {
  return [
    ...Array.from({ length: confirmed }, (_, n) => ({
      txid: txid(0xcc, n),
      vout: [{ address: ADDR, value: 1_000 }],
      block: { height: n + 1 },
    })),
    ...Array.from({ length: mempool }, (_, n) => ({ txid: txid(0xaa, n), vout: [{ address: ADDR, value: 1_000 }] })),
  ]
}

function esplora(options: Omit<MockEsploraOptions, 'backend'> = {}) {
  const mock = createMockEsplora({ backend: 'esplora', ...options })
  const client = new EsploraClient({ baseUrl: mock.baseUrl, fetchFn: mock.fetchFn, sleepFn: noSleep })
  return { mock, client }
}

function mempoolQbit(options: Omit<MockEsploraOptions, 'backend'> = {}) {
  const mock = createMockEsplora({ backend: 'mempool-qbit', ...options })
  const client = new MempoolQbitClient({ baseUrl: mock.baseUrl, fetchFn: mock.fetchFn, sleepFn: noSleep })
  return { mock, client }
}

function rejection(promise: Promise<unknown>): Promise<QbitApiError> {
  return promise.then(
    () => {
      throw new Error('expected a rejection')
    },
    (error: unknown) => {
      if (!QbitApiError.is(error)) throw error
      return error
    }
  )
}

const paths = (mock: { requests: readonly { method: string; path: string }[] }) =>
  mock.requests.map(request => `${request.method} ${request.path}`)

describe('createMockEsplora fixture views', () => {
  // A confirmed funding, a confirmed spend of half of it with change, and a mempool spend of the change.
  const FUND = txid(0x01, 0)
  const SPEND = txid(0x02, 0)
  const PENDING = txid(0x03, 0)
  const txs: MockTx[] = [
    {
      txid: FUND,
      vout: [
        { address: ADDR, value: 100_000 },
        { address: ADDR, value: 50_000 },
      ],
      block: { height: 10 },
    },
    {
      txid: SPEND,
      vin: [{ txid: FUND, vout: 0 }],
      vout: [
        { address: OTHER, value: 60_000 },
        { address: ADDR, value: 39_000 },
      ],
      block: { height: 11, hash: 'bb'.repeat(32), time: 1_234 },
    },
    { txid: PENDING, vin: [{ txid: SPEND, vout: 1 }], vout: [{ address: OTHER, value: 38_500 }] },
  ]

  it('derives the address stats, balance and unspent outputs from the transactions', async () => {
    const { client } = esplora({ txs })

    await expect(client.getAddressStats(ADDR)).resolves.toEqual({
      address: ADDR,
      chain_stats: {
        funded_txo_count: 3,
        funded_txo_sum: 189_000,
        spent_txo_count: 1,
        spent_txo_sum: 100_000,
        tx_count: 2,
      },
      mempool_stats: { funded_txo_count: 0, funded_txo_sum: 0, spent_txo_count: 1, spent_txo_sum: 39_000, tx_count: 1 },
    })
    await expect(client.getAddressBalance(ADDR)).resolves.toEqual({
      address: ADDR,
      confirmedSats: 89_000,
      mempoolSats: -39_000,
      totalSats: 50_000,
    })
    await expect(client.getAddressUtxos(ADDR)).resolves.toEqual([
      {
        txid: FUND,
        vout: 1,
        value: 50_000,
        status: { confirmed: true, block_height: 10, block_hash: '0a'.padStart(64, '0'), block_time: 1_700_006_000 },
      },
    ])
    await expect(client.getAddressUtxos(OTHER)).resolves.toEqual([
      {
        txid: SPEND,
        vout: 0,
        value: 60_000,
        status: { confirmed: true, block_height: 11, block_hash: 'bb'.repeat(32), block_time: 1_234 },
      },
      { txid: PENDING, vout: 0, value: 38_500, status: { confirmed: false } },
    ])
  })

  it('serves each transaction, its status and the fee its inputs and outputs imply', async () => {
    const { client } = esplora({ txs })

    const tx = await client.getTx(SPEND)
    expect(tx).toMatchObject({
      txid: SPEND,
      fee: 1_000,
      status: { confirmed: true, block_height: 11, block_hash: 'bb'.repeat(32), block_time: 1_234 },
    })
    expect(tx.vin).toEqual([
      expect.objectContaining({
        txid: FUND,
        vout: 0,
        prevout: expect.objectContaining({ scriptpubkey_address: ADDR, value: 100_000 }),
        is_coinbase: false,
      }),
    ])
    expect(tx.vout.map(output => [output.scriptpubkey_address, output.value])).toEqual([
      [OTHER, 60_000],
      [ADDR, 39_000],
    ])
    await expect(client.getTxStatus(PENDING)).resolves.toEqual({ confirmed: false })
    await expect(client.getTx(PENDING)).resolves.toMatchObject({ fee: 500, status: { confirmed: false } })
  })

  it('serves a declared hex, and answers 501 for a transaction declared without one', async () => {
    const { client } = esplora({
      txs: [{ hex: P2MR_TX.rawTxHex, vout: [{ address: ADDR, value: 1 }], block: { height: 1 } }, ...txs],
    })

    await expect(client.getTxHex(P2MR_TX.txid)).resolves.toBe(P2MR_TX.rawTxHex)
    await expect(client.getTx(P2MR_TX.txid)).resolves.toMatchObject({
      txid: P2MR_TX.txid,
      size: P2MR_TX.rawTxHex.length / 2,
    })
    const error = await rejection(client.getTxHex(FUND))
    expect(error).toMatchObject({ kind: 'http', status: 501 })
    expect(error.responseBody).toContain('has no hex')
  })

  it('serves the fee estimates, recommended fees and tip it is given, or defaults', async () => {
    const { client } = esplora({ feeEstimates: { '2': 8, '1': 12.5 }, tip: { height: 900, hash: 'cd'.repeat(32) } })
    await expect(client.getFeeTiers()).resolves.toEqual([
      { target: 1, feeRate: 12.5 },
      { target: 2, feeRate: 8 },
    ])
    await expect(client.getTipHeight()).resolves.toBe(900)
    await expect(client.getTipHash()).resolves.toBe('cd'.repeat(32))

    const fees = { fastestFee: 9, halfHourFee: 7, hourFee: 4, economyFee: 2, minimumFee: 1 }
    const mempool = mempoolQbit({ recommendedFees: fees, txs })
    await expect(mempool.client.getMempoolRecommendedFees()).resolves.toEqual(fees)
    await expect(mempool.client.getFeeEstimates()).resolves.toEqual({ '1': 9, '2': 7, '3': 4 })
    // The tip defaults to the highest fixture block.
    await expect(mempool.client.getTipHeight()).resolves.toBe(11)
    await expect(mempool.client.getTipHash()).resolves.toBe('bb'.repeat(32))

    await expect(esplora().client.getFeeEstimates()).resolves.toEqual({ '1': 20, '3': 10, '6': 5, '144': 1 })
    await expect(esplora().client.getTipHeight()).resolves.toBe(0)
  })

  it('answers an address the fixture does not name with empty views', async () => {
    const { client } = esplora({ txs })
    const unknown = 'qbrt1zqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq'
    await expect(client.getAddressBalance(unknown)).resolves.toMatchObject({ totalSats: 0 })
    await expect(client.getAddressUtxos(unknown)).resolves.toEqual([])
    await expect(client.getAddressHistory(unknown)).resolves.toEqual({ confirmed: [], mempool: [] })
  })
})

describe('createMockEsplora history pages', () => {
  it('pages /txs/chain 25 at a time, newest first, and caps /txs/mempool at 50', async () => {
    const { mock, client } = esplora({ txs: history(60, 3) })

    const first = await client.getAddressTxs(ADDR)
    expect(first.map(tx => tx.txid)).toEqual(Array.from({ length: 25 }, (_, n) => txid(0xcc, 59 - n)))
    const third = await client.getAddressTxs(ADDR, txid(0xcc, 10))
    expect(third.map(tx => tx.txid)).toEqual(Array.from({ length: 10 }, (_, n) => txid(0xcc, 9 - n)))
    await expect(client.getAddressTxs(ADDR, 'ff'.repeat(32))).resolves.toEqual([]) // unknown cursor: 200 []
    const mempool = await client.getAddressMempoolTxs(ADDR)
    expect(mempool.map(tx => tx.txid)).toEqual([txid(0xaa, 2), txid(0xaa, 1), txid(0xaa, 0)])
    expect(paths(mock)).toEqual([
      `GET /address/${ADDR}/txs/chain`,
      `GET /address/${ADDR}/txs/chain/${txid(0xcc, 10)}`,
      `GET /address/${ADDR}/txs/chain/${'ff'.repeat(32)}`,
      `GET /address/${ADDR}/txs/mempool`,
    ])

    const capped = esplora({ txs: history(0, 60) })
    await expect(capped.client.getAddressMempoolTxs(ADDR)).resolves.toHaveLength(50)
    await expect(rejection(capped.client.getAddressHistory(ADDR))).resolves.toMatchObject({ kind: 'invalid_cursor' })
  })

  it.each([
    ['EsploraClient', esplora],
    ['MempoolQbitClient', mempoolQbit],
  ])('returns a complete history to %s', async (_name, setUp) => {
    const txs = history(80, 12)
    const { client } = setUp({ txs })

    const { confirmed, mempool } = await client.getAddressHistory(ADDR)
    expect(confirmed.map(tx => tx.txid)).toEqual(Array.from({ length: 80 }, (_, n) => txid(0xcc, 79 - n)))
    expect(mempool.map(tx => tx.txid)).toEqual(Array.from({ length: 12 }, (_, n) => txid(0xaa, 11 - n)))
  })

  it("pages mempool-qbit's combined route and its confirmed history", async () => {
    const { mock, client } = mempoolQbit({ txs: history(40, 55) })

    const mempool = await client.getAddressMempoolTxs(ADDR)
    expect(mempool).toHaveLength(55)
    const confirmed = await client.getAddressTxs(ADDR)
    expect(confirmed.map(tx => tx.txid)).toEqual(Array.from({ length: 25 }, (_, n) => txid(0xcc, 39 - n)))
    const older = await client.getAddressTxs(ADDR, txid(0xcc, 15))
    expect(older.map(tx => tx.txid)).toEqual(Array.from({ length: 15 }, (_, n) => txid(0xcc, 14 - n)))
    expect(mock.requests.every(request => request.path.startsWith(`/address/${ADDR}/txs`))).toBe(true)
  })

  it('answers a combined-history cursor found nowhere as each backend does', async () => {
    const cursor = `/address/${ADDR}/txs?after_txid=${'ff'.repeat(32)}`
    const electrs = esplora({ txs: history(3, 0) })
    const hosted = mempoolQbit({ txs: history(3, 0) })

    const electrsReply = await electrs.mock.fetchFn(`${electrs.mock.baseUrl}${cursor}`)
    expect([electrsReply.status, await electrsReply.text()]).toEqual([422, 'after_txid not found'])
    const hostedReply = await hosted.mock.fetchFn(`${hosted.mock.baseUrl}${cursor}`)
    expect([hostedReply.status, await hostedReply.json()]).toEqual([
      500,
      { error: 'Failed to get address transactions' },
    ])
  })

  it('passes a cursor that is the last mempool row on to the chain, which yields [], as qbit-electrs does', async () => {
    const { mock, client } = mempoolQbit({ txs: history(5, 50) })

    const reply = await mock.fetchFn(`${mock.baseUrl}/address/${ADDR}/txs?after_txid=${txid(0xaa, 0)}`)
    await expect(reply.json()).resolves.toEqual([])
    await expect(rejection(client.getAddressTxs(ADDR))).resolves.toMatchObject({ kind: 'invalid_cursor' })
  })
})

describe('createMockEsplora backends', () => {
  const UNKNOWN = 'ef'.repeat(32)

  it('answers an unknown txid status 200 {"confirmed":false} on esplora and 404 on mempool-qbit', async () => {
    await expect(esplora().client.getTxStatus(UNKNOWN)).resolves.toEqual({ confirmed: false })
    await expect(rejection(mempoolQbit().client.getTxStatus(UNKNOWN))).resolves.toMatchObject({
      kind: 'not_found',
      status: 404,
    })
    for (const { client } of [esplora(), mempoolQbit()]) {
      await expect(rejection(client.getTx(UNKNOWN))).resolves.toMatchObject({ kind: 'not_found' })
      await expect(rejection(client.getTxHex(UNKNOWN))).resolves.toMatchObject({ kind: 'not_found' })
    }
  })

  it('answers 404 for the routes each backend does not serve', async () => {
    const hosted = mempoolQbit()
    const asEsplora = new EsploraClient({ baseUrl: hosted.mock.baseUrl, fetchFn: hosted.mock.fetchFn })
    for (const call of [
      () => asEsplora.getFeeEstimates(),
      () => asEsplora.getAddressTxs(ADDR),
      () => asEsplora.getAddressMempoolTxs(ADDR),
    ]) {
      await expect(rejection(call())).resolves.toMatchObject({ kind: 'not_found', status: 404 })
    }

    const electrs = esplora()
    const asMempool = new MempoolQbitClient({ baseUrl: electrs.mock.baseUrl, fetchFn: electrs.mock.fetchFn })
    await expect(rejection(asMempool.getMempoolRecommendedFees())).resolves.toMatchObject({ kind: 'not_found' })
    const push = await electrs.mock.fetchFn(`${electrs.mock.baseUrl}/tx/push`, {
      method: 'POST',
      body: `txHash=${LEGACY_TX_HEX}`,
    })
    expect(push.status).toBe(404)
    expect(electrs.mock.hasTx(LEGACY_TXID)).toBe(false)
  })

  it('records each request, and rejects one outside its baseUrl or with an aborted signal', async () => {
    // The scheme is case-insensitive, as the client takes it; trailing slashes are dropped.
    expect(createMockEsplora({ backend: 'esplora', baseUrl: 'HTTPS://Esplora.Example/api' }).baseUrl).toBe(
      'HTTPS://Esplora.Example/api'
    )
    const mock = createMockEsplora({
      backend: 'esplora',
      baseUrl: 'https://esplora.example/regtest/api/',
      txs: P2MR_FUNDING,
    })
    expect(mock.baseUrl).toBe('https://esplora.example/regtest/api')
    const client = new EsploraClient({ baseUrl: mock.baseUrl, fetchFn: mock.fetchFn, retries: 0 })

    await client.broadcastTx(P2MR_TX.rawTxHex)
    expect(mock.requests).toEqual([{ method: 'POST', url: `${mock.baseUrl}/tx`, path: '/tx', body: P2MR_TX.rawTxHex }])

    await expect(mock.fetchFn('https://elsewhere.example/api/blocks/tip/height')).rejects.toThrow(
      /not under the mock's baseUrl/
    )
    const controller = new AbortController()
    controller.abort(new Error('stop'))
    await expect(mock.fetchFn(`${mock.baseUrl}/blocks/tip/height`, { signal: controller.signal })).rejects.toThrow(
      'stop'
    )
    expect(mock.requests).toHaveLength(3)
  })
})

describe('createMockEsplora broadcast', () => {
  it.each([
    ['esplora', esplora],
    ['mempool-qbit', mempoolQbit],
  ])('takes a submission on %s, and finds it until and after it is mined', async (_backend, setUp) => {
    const { mock, client } = setUp({ txs: P2MR_FUNDING })

    await expect(client.broadcastTx(P2MR_TX.rawTxHex)).resolves.toBe(P2MR_TX.txid)
    expect(mock.hasTx(P2MR_TX.txid)).toBe(true)
    await expect(client.getTxStatus(P2MR_TX.txid)).resolves.toEqual({ confirmed: false })
    await expect(client.getTxHex(P2MR_TX.txid)).resolves.toBe(P2MR_TX.rawTxHex)
    await expect(client.getTx(P2MR_TX.txid)).resolves.toMatchObject({ txid: P2MR_TX.txid, version: 2 })
    // Resubmitting a transaction in the mempool is answered with its txid.
    await expect(client.broadcastTx(P2MR_TX.rawTxHex)).resolves.toBe(P2MR_TX.txid)

    expect(mock.mine()).toEqual({ height: 1, hash: '01'.padStart(64, '0'), time: 1_700_000_600 })
    await expect(client.getTxStatus(P2MR_TX.txid)).resolves.toEqual({
      confirmed: true,
      block_height: 1,
      block_hash: '01'.padStart(64, '0'),
      block_time: 1_700_000_600,
    })
    await expect(client.getTipHeight()).resolves.toBe(1)
    // Once mined, a resubmission gets the node's already-known reply (-27), which resolves with the known txid.
    await expect(client.broadcastTx(P2MR_TX.rawTxHex)).resolves.toBe(P2MR_TX.txid)
    expect(paths(mock).filter(path => path.startsWith('POST'))).toEqual(['POST /tx', 'POST /tx', 'POST /tx'])
  })

  it('answers hex the node cannot decode with RPC error -22, a definite rejection', async () => {
    const { mock, client } = esplora()
    const error = await rejection(client.broadcastTx('0200'))
    expect(error).toMatchObject({ kind: 'http', status: 400 })
    expect(error.responseBody).toBe('sendrawtransaction RPC error: {"code":-22,"message":"TX decode failed"}')
    expect(mock.requests).toHaveLength(1)
  })

  it.each([
    ['esplora', esplora],
    ['mempool-qbit', mempoolQbit],
  ])('rejects a submission with the node code it is given on %s, without a fallback', async (_backend, setUp) => {
    const { mock, client } = setUp({
      faults: [
        { route: 'POST /tx', kind: 'broadcast', outcome: 'rejected', code: -26, message: 'txn-mempool-conflict' },
      ],
    })

    const error = await rejection(client.broadcastTx(LEGACY_TX_HEX))
    expect(error).toMatchObject({
      kind: 'http',
      status: 400,
      responseBody: 'sendrawtransaction RPC error: {"code":-26,"message":"txn-mempool-conflict"}',
    })
    expect(mock.hasTx(LEGACY_TXID)).toBe(false)
    expect(paths(mock)).toEqual(['POST /tx'])
  })

  it('resolves a rejected outcome that carries the already-known code -27, given a txid', async () => {
    const { client } = esplora({
      faults: [{ route: 'POST /tx', kind: 'broadcast', outcome: 'rejected', code: -27 }],
    })
    await expect(client.broadcastTx(LEGACY_TX_HEX)).resolves.toBe(LEGACY_TXID)
  })

  it.each([
    ['esplora', esplora],
    ['mempool-qbit', mempoolQbit],
  ])(
    'reports a lost reply on %s as unknown_outcome, and later lookups find the transaction',
    async (backend, setUp) => {
      const { mock, client } = setUp({ faults: [{ route: 'POST /tx', kind: 'broadcast', outcome: 'lost-reply' }] })
      if (backend === 'mempool-qbit') {
        // There, getTxStatus can tell: 404 before, 200 once the node has it.
        await expect(rejection(client.getTxStatus(P2MR_TX.txid))).resolves.toMatchObject({ kind: 'not_found' })
      }
      await expect(rejection(client.getTx(P2MR_TX.txid))).resolves.toMatchObject({ kind: 'not_found' })

      const error = await rejection(client.broadcastTx(P2MR_TX.rawTxHex))
      expect(error).toMatchObject({ kind: 'unknown_outcome', txid: P2MR_TX.txid })
      expect(error.cause).toMatchObject({ kind: 'network' })

      expect(mock.hasTx(P2MR_TX.txid)).toBe(true)
      await expect(client.getTxStatus(P2MR_TX.txid)).resolves.toEqual({ confirmed: false })
      await expect(client.getTx(P2MR_TX.txid)).resolves.toMatchObject({ txid: P2MR_TX.txid })
      // Never re-sent; resubmitting the same hex settles it.
      expect(paths(mock).filter(path => path.startsWith('POST'))).toEqual(['POST /tx'])
      await expect(client.broadcastTx(P2MR_TX.rawTxHex)).resolves.toBe(P2MR_TX.txid)
    }
  )

  it('takes an accepted outcome even for a transaction already in a block', async () => {
    const { client } = esplora({
      txs: [{ hex: LEGACY_TX_HEX, vout: [{ value: 5_000_000_000 }], block: { height: 0 } }],
      faults: [{ route: 'POST /tx', kind: 'broadcast', outcome: 'accepted' }],
    })
    await expect(client.broadcastTx(LEGACY_TX_HEX)).resolves.toBe(LEGACY_TXID)
  })

  it.each([
    [404, 'not_found'],
    [405, 'http'],
    [501, 'http'],
  ])(
    "falls back to mempool-qbit's /tx/push after a %i from /tx, which EsploraClient reports as %s",
    async (status, kind) => {
      const fault: MockFault = { route: 'POST /tx', kind: 'status', status }
      const hosted = mempoolQbit({ txs: P2MR_FUNDING, faults: [fault] })

      await expect(hosted.client.broadcastTx(P2MR_TX.rawTxHex)).resolves.toBe(P2MR_TX.txid)
      expect(hosted.mock.requests.map(request => [request.path, request.body])).toEqual([
        ['/tx', P2MR_TX.rawTxHex],
        ['/tx/push', `txHash=${P2MR_TX.rawTxHex}`],
      ])
      expect(hosted.mock.hasTx(P2MR_TX.txid)).toBe(true)

      const electrs = esplora({ txs: P2MR_FUNDING, faults: [fault] })
      await expect(rejection(electrs.client.broadcastTx(P2MR_TX.rawTxHex))).resolves.toMatchObject({ kind, status })
      expect(electrs.mock.hasTx(P2MR_TX.txid)).toBe(false)
    }
  )

  it("falls back to /tx/push after mempool-qbit's generic 400 failure", async () => {
    const { mock, client } = mempoolQbit({
      txs: P2MR_FUNDING,
      faults: [{ route: 'POST /tx', kind: 'status', status: 400, body: 'Failed to send transaction' }],
    })
    await expect(client.broadcastTx(P2MR_TX.rawTxHex)).resolves.toBe(P2MR_TX.txid)
    expect(paths(mock)).toEqual(['POST /tx', 'POST /tx/push'])
  })
})

describe('createMockEsplora node verdicts', () => {
  // FUND:0 is unspent, FUND:1 spent in the mempool, FUND:2 spent in a block,
  // and FUND:3 an OP_RETURN output, which never enters the UTXO set.
  const FUND = txid(0xf1, 0)
  const MEMPOOL_SPEND = txid(0xf2, 0)
  const txs: MockTx[] = [
    {
      txid: FUND,
      vout: [
        { address: ADDR, value: 100_000 },
        { address: ADDR, value: 50_000 },
        { address: ADDR, value: 20_000 },
        { value: 0, scriptPubKey: '6a0474657374' },
      ],
      block: { height: 5 },
    },
    { txid: MEMPOOL_SPEND, vin: [{ txid: FUND, vout: 1 }], vout: [{ address: OTHER, value: 49_000 }] },
    { txid: txid(0xf3, 0), vin: [{ txid: FUND, vout: 2 }], vout: [{ value: 19_000 }], block: { height: 6 } },
  ]
  const MISSING_INPUTS = rpcError(-25, 'bad-txns-inputs-missingorspent')
  const conflict = (hex: string) => rpcError(-26, `insufficient fee, rejecting replacement ${txidFromRawTx(hex)}`)

  it('answers a resubmitted confirmed transaction with -27 while an output is unspent, and -25 once none is', async () => {
    const { mock, client } = esplora({ txs })
    // Its second output is OP_RETURN, which never counts as unspent.
    const payment = legacyTx([{ txid: FUND, vout: 0 }], [{ value: 99_000 }, { value: 0, script: '6a0474657374' }])
    const id = txidFromRawTx(payment)
    await expect(client.broadcastTx(payment)).resolves.toBe(id)
    expect(await submit(mock, payment)).toEqual([200, id])
    mock.mine()

    const alreadyKnown = rpcError(-27, 'Transaction outputs already in utxo set')
    expect(await submit(mock, payment)).toEqual([400, alreadyKnown])
    await expect(client.broadcastTx(payment)).resolves.toBe(id)
    const sweep = legacyTx([{ txid: id, vout: 0 }], [{ value: 98_000 }])
    await expect(client.broadcastTx(sweep)).resolves.toBe(txidFromRawTx(sweep))
    // A spend in the mempool leaves the output in the chain's UTXO set.
    expect(await submit(mock, payment)).toEqual([400, alreadyKnown])
    mock.mine()

    // Every output is spent or unspendable, so the payment's own inputs are spent: a definite rejection of the
    // resubmission that proves nothing about the original, as docs/broadcasting.md says.
    const error = await rejection(client.broadcastTx(payment))
    expect(error).toMatchObject({ kind: 'http', status: 400, responseBody: MISSING_INPUTS })
    await expect(client.getTxStatus(id)).resolves.toMatchObject({ confirmed: true, block_height: 7 })
  })

  it('refuses a payment rebuilt with the same input after unknown_outcome, and takes the same hex again', async () => {
    const { mock, client } = esplora({ txs, faults: [{ route: 'POST /tx', kind: 'broadcast', outcome: 'lost-reply' }] })
    const original = legacyTx([{ txid: FUND, vout: 0 }], [{ value: 99_000 }])
    await expect(rejection(client.broadcastTx(original))).resolves.toMatchObject({
      kind: 'unknown_outcome',
      txid: txidFromRawTx(original),
    })

    // The mistake docs/broadcasting.md warns about: treating the payment as failed and rebuilding it. This one
    // pays another script the same fee, so qbit Core would refuse it as a replacement too.
    const rebuilt = legacyTx([{ txid: FUND, vout: 0 }], [{ value: 99_000, script: '52' }])
    await expect(rejection(client.broadcastTx(rebuilt))).resolves.toMatchObject({
      kind: 'http',
      status: 400,
      responseBody: conflict(rebuilt),
    })
    expect(mock.hasTx(txidFromRawTx(rebuilt))).toBe(false)

    // The recovery it gives: resubmit the same hex, which the node answers with the txid.
    await expect(client.broadcastTx(original)).resolves.toBe(txidFromRawTx(original))
    mock.mine()
    expect(await submit(mock, rebuilt)).toEqual([400, MISSING_INPUTS])
  })

  it.each<[string, { txid: string; vout: number }[], (hex: string) => string]>([
    ['an output a mempool transaction spends', [{ txid: FUND, vout: 1 }], conflict],
    ['an output a confirmed transaction spends', [{ txid: FUND, vout: 2 }], () => MISSING_INPUTS],
    ['an OP_RETURN output', [{ txid: FUND, vout: 3 }], () => MISSING_INPUTS],
    ['an output past the last of a known transaction', [{ txid: FUND, vout: 4 }], () => MISSING_INPUTS],
    ['an output of a transaction the node does not know', [{ txid: 'ee'.repeat(32), vout: 0 }], () => MISSING_INPUTS],
    [
      'a conflicting output beside a spent one: Core checks for missing inputs first',
      [
        { txid: FUND, vout: 1 },
        { txid: FUND, vout: 2 },
      ],
      () => MISSING_INPUTS,
    ],
    [
      'one output twice',
      [
        { txid: FUND, vout: 0 },
        { txid: FUND, vout: 0 },
      ],
      () => rpcError(-26, 'bad-txns-inputs-duplicate'),
    ],
  ])('refuses a submission that spends %s', async (_case, inputs, reply) => {
    const { mock, client } = esplora({ txs })
    const hex = legacyTx(inputs, [{ value: 1_000 }])

    expect(await submit(mock, hex)).toEqual([400, reply(hex)])
    await expect(rejection(client.broadcastTx(hex))).resolves.toMatchObject({ kind: 'http', status: 400 })
    expect(mock.hasTx(txidFromRawTx(hex))).toBe(false)
  })

  it('takes a chain of mempool spends, and refuses a conflicting spend before and after it is mined', async () => {
    const { mock, client } = esplora({ txs })
    const child = legacyTx([{ txid: MEMPOOL_SPEND, vout: 0 }], [{ value: 48_000 }])
    const sibling = legacyTx([{ txid: MEMPOOL_SPEND, vout: 0 }], [{ value: 47_000 }])
    await expect(client.broadcastTx(child)).resolves.toBe(txidFromRawTx(child))
    const grandchild = legacyTx([{ txid: txidFromRawTx(child), vout: 0 }], [{ value: 47_000 }])
    await expect(client.broadcastTx(grandchild)).resolves.toBe(txidFromRawTx(grandchild))

    expect(await submit(mock, sibling)).toEqual([400, conflict(sibling)])
    mock.mine()
    expect(await submit(mock, sibling)).toEqual([400, MISSING_INPUTS])
    await expect(client.getTxStatus(txidFromRawTx(grandchild))).resolves.toMatchObject({ confirmed: true })
  })

  it.each(['accepted', 'lost-reply'] as const)(
    'takes whatever a %s fault forces: a conflict, and a spend of outputs the node does not have',
    async outcome => {
      const { mock, client } = esplora({
        txs,
        faults: [{ route: 'POST /tx', kind: 'broadcast', outcome, times: 2 }],
      })
      const conflicting = legacyTx([{ txid: FUND, vout: 1 }], [{ value: 1_000 }])
      const unfunded = legacyTx([{ txid: 'ee'.repeat(32), vout: 0 }], [{ value: 1_000 }])
      for (const hex of [conflicting, unfunded]) {
        const settled = client.broadcastTx(hex)
        if (outcome === 'accepted') await expect(settled).resolves.toBe(txidFromRawTx(hex))
        else await expect(rejection(settled)).resolves.toMatchObject({ kind: 'unknown_outcome' })
        expect(mock.hasTx(txidFromRawTx(hex))).toBe(true)
      }
      // The conflicting mempool transaction stays.
      expect(mock.hasTx(MEMPOOL_SPEND)).toBe(true)
    }
  )
})

describe('createMockEsplora faults', () => {
  it('re-sends a 429 whose Retry-After is within the cap, and reports one over it as rate_limit', async () => {
    const sleeps: number[] = []
    const within = createMockEsplora({
      backend: 'esplora',
      txs: P2MR_FUNDING,
      faults: [{ route: 'POST /tx', kind: 'status', status: 429, retryAfter: 2, times: 2 }],
    })
    const client = new EsploraClient({
      baseUrl: within.baseUrl,
      fetchFn: within.fetchFn,
      sleepFn: async ms => void sleeps.push(ms),
    })
    await expect(client.broadcastTx(P2MR_TX.rawTxHex)).resolves.toBe(P2MR_TX.txid)
    expect(sleeps).toEqual([2_000, 2_000])
    expect(within.requests).toHaveLength(3)

    const over = esplora({
      faults: [{ route: 'GET /blocks/tip/height', kind: 'status', status: 429, retryAfter: 3_600 }],
    })
    await expect(rejection(over.client.getTipHeight())).resolves.toMatchObject({
      kind: 'rate_limit',
      retryAfterMs: 3_600_000,
    })
    const date = esplora({
      faults: [{ route: 'POST /tx', kind: 'status', status: 429, retryAfter: 'Wed, 21 Oct 2099 07:28:00 GMT' }],
    })
    await expect(rejection(date.client.broadcastTx(LEGACY_TX_HEX))).resolves.toMatchObject({ kind: 'rate_limit' })
    expect(date.mock.hasTx(LEGACY_TXID)).toBe(false)
  })

  it('reports a 5xx submission reply without a node verdict as unknown_outcome, and the node never saw it', async () => {
    const { mock, client } = esplora({
      faults: [{ route: 'POST /tx', kind: 'status', status: 504, body: '<html>504 Gateway Time-out</html>' }],
    })
    await expect(rejection(client.broadcastTx(LEGACY_TX_HEX))).resolves.toMatchObject({
      kind: 'unknown_outcome',
      status: 504,
      txid: LEGACY_TXID,
    })
    expect(mock.hasTx(LEGACY_TXID)).toBe(false)
    expect(mock.requests).toHaveLength(1)
  })

  it('retries a read through 5xx replies and a refused connection', async () => {
    const { mock, client } = esplora({
      faults: [
        { route: 'GET /blocks/tip/height', kind: 'status', status: 503 },
        { route: 'GET /blocks/tip/height', kind: 'network-error' },
      ],
    })
    await expect(client.getTipHeight()).resolves.toBe(0)
    expect(mock.requests).toHaveLength(3)
  })

  it('retries a submission whose connection was refused, which sent nothing, and fails as network once retries run out', async () => {
    const retried = esplora({ txs: P2MR_FUNDING, faults: [{ route: 'POST /tx', kind: 'network-error', times: 2 }] })
    await expect(retried.client.broadcastTx(P2MR_TX.rawTxHex)).resolves.toBe(P2MR_TX.txid)
    expect(retried.mock.requests).toHaveLength(3)

    const refused = esplora({ faults: [{ route: 'POST /tx', kind: 'network-error', times: Infinity }] })
    await expect(rejection(refused.client.broadcastTx(LEGACY_TX_HEX))).resolves.toMatchObject({ kind: 'network' })
    expect(refused.mock.requests).toHaveLength(3)
    expect(refused.mock.hasTx(LEGACY_TXID)).toBe(false)
  })

  it('stalls a body until the attempt times out: a read is retried, a submission is unknown_outcome', async () => {
    const mock = createMockEsplora({
      backend: 'esplora',
      faults: [
        { route: 'GET /tx/:txid/status', kind: 'stall' },
        { route: 'POST /tx', kind: 'stall' },
      ],
    })
    const client = new EsploraClient({ baseUrl: mock.baseUrl, fetchFn: mock.fetchFn, timeoutMs: 20, sleepFn: noSleep })

    await expect(client.getTxStatus(LEGACY_TXID)).resolves.toEqual({ confirmed: false })
    const error = await rejection(client.broadcastTx(LEGACY_TX_HEX))
    expect(error).toMatchObject({ kind: 'unknown_outcome', txid: LEGACY_TXID })
    expect(error.cause).toMatchObject({ kind: 'timeout' })
    expect(mock.hasTx(LEGACY_TXID)).toBe(false)
  })

  it('re-sends a submission after a stalled 429, which proves nothing was processed', async () => {
    const mock = createMockEsplora({
      backend: 'esplora',
      txs: P2MR_FUNDING,
      faults: [{ route: 'POST /tx', kind: 'stall', status: 429, retryAfter: 1 }],
    })
    const sleeps: number[] = []
    const client = new EsploraClient({
      baseUrl: mock.baseUrl,
      fetchFn: mock.fetchFn,
      timeoutMs: 20,
      sleepFn: async ms => void sleeps.push(ms),
    })
    await expect(client.broadcastTx(P2MR_TX.rawTxHex)).resolves.toBe(P2MR_TX.txid)
    expect(sleeps).toEqual([1_000])
  })

  it('ends a stalled read at the call deadline', async () => {
    const { client } = esplora({ faults: [{ route: 'GET /address/:address', kind: 'stall', times: Infinity }] })
    await expect(rejection(client.getAddressBalance(ADDR, { deadlineMs: 30 }))).resolves.toMatchObject({
      kind: 'timeout',
    })
  })

  it('applies faults per route, in order, each for its number of requests', async () => {
    const { mock, client } = esplora({
      faults: [
        { route: 'GET /tx/:txid', kind: 'status', status: 404, body: 'Transaction not found', times: 2 },
        { route: 'POST /tx', kind: 'broadcast', outcome: 'lost-reply' },
        { route: 'POST /tx', kind: 'broadcast', outcome: 'rejected', code: -25 },
      ],
    })
    await expect(rejection(client.broadcastTx(LEGACY_TX_HEX))).resolves.toMatchObject({ kind: 'unknown_outcome' })
    // An indexer that lags its node: two lookups miss, the third finds it.
    await expect(rejection(client.getTx(LEGACY_TXID))).resolves.toMatchObject({ kind: 'not_found' })
    await expect(rejection(client.getTx(LEGACY_TXID))).resolves.toMatchObject({ kind: 'not_found' })
    await expect(client.getTx(LEGACY_TXID)).resolves.toMatchObject({ txid: LEGACY_TXID })
    await expect(rejection(client.broadcastTx(LEGACY_TX_HEX))).resolves.toMatchObject({ kind: 'http' })
    await expect(client.broadcastTx(LEGACY_TX_HEX)).resolves.toBe(LEGACY_TXID)
    expect(mock.requests).toHaveLength(6)
  })
})

describe('createMockEsplora option validation', () => {
  const tx = (overrides: Partial<MockTx> = {}): MockTx => ({
    txid: txid(0x01, 0),
    vout: [{ address: ADDR, value: 1 }],
    ...overrides,
  })
  const bad = (options: unknown) => () => createMockEsplora(options as MockEsploraOptions)

  it.each<[string, unknown]>([
    ['no options', undefined],
    ['no backend', {}],
    ['an unknown backend', { backend: 'electrum' }],
    ['an unknown option', { backend: 'esplora', fault: [] }],
    ['a baseUrl with a query', { backend: 'esplora', baseUrl: 'https://esplora.example/api?key=1' }],
    ['a relative baseUrl', { backend: 'esplora', baseUrl: '/api' }],
    ['a null baseUrl', { backend: 'esplora', baseUrl: null }],
    ['a null txs', { backend: 'esplora', txs: null }],
    ['a null feeEstimates', { backend: 'esplora', feeEstimates: null }],
    ['a null recommendedFees', { backend: 'mempool-qbit', recommendedFees: null }],
    ['a null tip', { backend: 'esplora', tip: null }],
    ['a null faults', { backend: 'esplora', faults: null }],
    ['a txs that is not an array', { backend: 'esplora', txs: {} }],
    ['a malformed txid', { backend: 'esplora', txs: [tx({ txid: 'zz'.repeat(32) })] }],
    ['a short txid', { backend: 'esplora', txs: [tx({ txid: 'ab' })] }],
    ['a transaction without txid or hex', { backend: 'esplora', txs: [{ vout: [{ value: 1 }] }] }],
    ['hex that is not a transaction', { backend: 'esplora', txs: [{ hex: '0200', vout: [{ value: 1 }] }] }],
    ['hex that is not hex', { backend: 'esplora', txs: [{ hex: 'zz', vout: [{ value: 1 }] }] }],
    [
      'a txid that is not its hex',
      { backend: 'esplora', txs: [{ txid: txid(1, 1), hex: LEGACY_TX_HEX, vout: [{ value: 1 }] }] },
    ],
    ['a repeated txid', { backend: 'esplora', txs: [tx(), tx()] }],
    ['no outputs', { backend: 'esplora', txs: [tx({ vout: [] })] }],
    ['a malformed address', { backend: 'esplora', txs: [tx({ vout: [{ address: 'qb1 bad', value: 1 }] })] }],
    ['an empty address', { backend: 'esplora', txs: [tx({ vout: [{ address: '', value: 1 }] })] }],
    ['a negative value', { backend: 'esplora', txs: [tx({ vout: [{ value: -1 }] })] }],
    ['a NaN value', { backend: 'esplora', txs: [tx({ vout: [{ value: Number.NaN }] })] }],
    ['an infinite value', { backend: 'esplora', txs: [tx({ vout: [{ value: Infinity }] })] }],
    ['a fractional value', { backend: 'esplora', txs: [tx({ vout: [{ value: 0.5 }] })] }],
    [
      'outputs whose total is not a safe integer',
      { backend: 'esplora', txs: [tx({ vout: [{ value: Number.MAX_SAFE_INTEGER }, { value: 1 }] })] },
    ],
    ['an odd-length scriptPubKey', { backend: 'esplora', txs: [tx({ vout: [{ value: 1, scriptPubKey: '5' }] })] }],
    ['a negative block height', { backend: 'esplora', txs: [tx({ block: { height: -1 } })] }],
    ['a malformed block hash', { backend: 'esplora', txs: [tx({ block: { height: 1, hash: 'x' } })] }],
    ['an unknown transaction field', { backend: 'esplora', txs: [{ ...tx(), confirmed: true }] }],
    [
      'an input outside the fixture without a value',
      { backend: 'esplora', txs: [tx({ vin: [{ txid: txid(9, 9), vout: 0 }] })] },
    ],
    [
      'an input with a negative vout',
      { backend: 'esplora', txs: [tx({ vin: [{ txid: txid(9, 9), vout: -1, value: 1 }] })] },
    ],
    [
      'an input of a missing output',
      {
        backend: 'esplora',
        txs: [tx(), { txid: txid(2, 0), vin: [{ txid: txid(1, 0), vout: 1 }], vout: [{ value: 0 }] }],
      },
    ],
    [
      'two spends of one output',
      {
        backend: 'esplora',
        txs: [
          tx(),
          { txid: txid(2, 0), vin: [{ txid: txid(1, 0), vout: 0 }], vout: [{ value: 1 }] },
          { txid: txid(3, 0), vin: [{ txid: txid(1, 0), vout: 0 }], vout: [{ value: 1 }] },
        ],
      },
    ],
    [
      'one output spent twice by one transaction',
      {
        backend: 'esplora',
        txs: [
          tx(),
          {
            txid: txid(2, 0),
            vin: [
              { txid: txid(1, 0), vout: 0 },
              { txid: txid(1, 0), vout: 0 },
            ],
            vout: [{ value: 1 }],
          },
        ],
      },
    ],
    [
      'a spend listed before its funding',
      {
        backend: 'esplora',
        txs: [{ txid: txid(2, 0), vin: [{ txid: txid(1, 0), vout: 0, value: 1 }], vout: [{ value: 1 }] }, tx()],
      },
    ],
    [
      'a confirmed spend of a mempool output',
      {
        backend: 'esplora',
        txs: [
          tx(),
          { txid: txid(2, 0), vin: [{ txid: txid(1, 0), vout: 0 }], vout: [{ value: 1 }], block: { height: 1 } },
        ],
      },
    ],
    [
      'a spend whose value disagrees',
      {
        backend: 'esplora',
        txs: [tx(), { txid: txid(2, 0), vin: [{ txid: txid(1, 0), vout: 0, value: 2 }], vout: [{ value: 1 }] }],
      },
    ],
    [
      'outputs above the inputs',
      {
        backend: 'esplora',
        txs: [tx(), { txid: txid(2, 0), vin: [{ txid: txid(1, 0), vout: 0 }], vout: [{ value: 2 }] }],
      },
    ],
    [
      'a fee that does not balance',
      {
        backend: 'esplora',
        txs: [tx(), { txid: txid(2, 0), vin: [{ txid: txid(1, 0), vout: 0 }], vout: [{ value: 1 }], fee: 5 }],
      },
    ],
    [
      'two hashes for one height',
      {
        backend: 'esplora',
        txs: [
          tx({ block: { height: 1, hash: 'aa'.repeat(32) } }),
          tx({ txid: txid(2, 0), block: { height: 1, hash: 'bb'.repeat(32) } }),
        ],
      },
    ],
    [
      'two times for one height',
      {
        backend: 'esplora',
        txs: [tx({ block: { height: 1 } }), tx({ txid: txid(2, 0), block: { height: 1, time: 1_700_000_601 } })],
      },
    ],
    ['a tip below a fixture block', { backend: 'esplora', txs: [tx({ block: { height: 5 } })], tip: { height: 4 } }],
    [
      "a tip hash that is not the fixture block's",
      { backend: 'esplora', txs: [tx({ block: { height: 5 } })], tip: { height: 5, hash: 'cd'.repeat(32) } },
    ],
    ['a non-finite tip height', { backend: 'esplora', tip: { height: Infinity } }],
    ['a zero fee estimate', { backend: 'esplora', feeEstimates: { '1': 0 } }],
    ['a NaN fee estimate', { backend: 'esplora', feeEstimates: { '1': Number.NaN } }],
    ['an infinite fee estimate', { backend: 'esplora', feeEstimates: { '1': Infinity } }],
    ['a fee estimate target that is not a block count', { backend: 'esplora', feeEstimates: { '01': 2 } }],
    [
      'a negative recommended fee',
      {
        backend: 'mempool-qbit',
        recommendedFees: { fastestFee: -1, halfHourFee: 1, hourFee: 1, economyFee: 1, minimumFee: 1 },
      },
    ],
    ['a missing recommended fee', { backend: 'mempool-qbit', recommendedFees: { fastestFee: 1 } }],
    ['an unknown fault kind', { backend: 'esplora', faults: [{ route: 'POST /tx', kind: 'timeout' }] }],
    ['an unknown route', { backend: 'esplora', faults: [{ route: 'GET /mempool', kind: 'network-error' }] }],
    ['a fault that is not an object', { backend: 'esplora', faults: ['stall'] }],
    ['a status below 200', { backend: 'esplora', faults: [{ route: 'POST /tx', kind: 'status', status: 101 }] }],
    [
      'a status that is not an integer',
      { backend: 'esplora', faults: [{ route: 'POST /tx', kind: 'status', status: 500.5 }] },
    ],
    [
      'a body on a 204',
      { backend: 'esplora', faults: [{ route: 'POST /tx', kind: 'status', status: 204, body: 'x' }] },
    ],
    ['a stalled 304', { backend: 'esplora', faults: [{ route: 'POST /tx', kind: 'stall', status: 304 }] }],
    [
      'a negative Retry-After',
      { backend: 'esplora', faults: [{ route: 'POST /tx', kind: 'status', status: 429, retryAfter: -1 }] },
    ],
    [
      'a NaN Retry-After',
      { backend: 'esplora', faults: [{ route: 'POST /tx', kind: 'status', status: 429, retryAfter: Number.NaN }] },
    ],
    [
      'a Retry-After with a line break',
      { backend: 'esplora', faults: [{ route: 'POST /tx', kind: 'status', status: 429, retryAfter: '1\r\nx: y' }] },
    ],
    ['zero times', { backend: 'esplora', faults: [{ route: 'POST /tx', kind: 'network-error', times: 0 }] }],
    ['NaN times', { backend: 'esplora', faults: [{ route: 'POST /tx', kind: 'network-error', times: Number.NaN }] }],
    ['null times', { backend: 'esplora', faults: [{ route: 'POST /tx', kind: 'network-error', times: null }] }],
    [
      'a broadcast fault on a read route',
      { backend: 'esplora', faults: [{ route: 'GET /tx/:txid', kind: 'broadcast', outcome: 'accepted' }] },
    ],
    [
      'an unknown broadcast outcome',
      { backend: 'esplora', faults: [{ route: 'POST /tx', kind: 'broadcast', outcome: 'lost' }] },
    ],
    [
      'a rejection without a code',
      { backend: 'esplora', faults: [{ route: 'POST /tx', kind: 'broadcast', outcome: 'rejected' }] },
    ],
    [
      'a rejection with a positive code',
      { backend: 'esplora', faults: [{ route: 'POST /tx', kind: 'broadcast', outcome: 'rejected', code: 26 }] },
    ],
    [
      'a code on an accepted outcome',
      { backend: 'esplora', faults: [{ route: 'POST /tx', kind: 'broadcast', outcome: 'accepted', code: -26 }] },
    ],
    [
      'an option of another fault kind',
      { backend: 'esplora', faults: [{ route: 'POST /tx', kind: 'network-error', status: 500 }] },
    ],
  ])('throws a TypeError for %s', (_case, options) => {
    expect(bad(options)).toThrow(TypeError)
  })

  it('takes the default for an option given as undefined', async () => {
    const options = { backend: 'esplora', baseUrl: undefined, feeEstimates: undefined, tip: undefined }
    const mock = createMockEsplora(options as unknown as MockEsploraOptions)
    expect(mock.baseUrl).toBe('https://esplora.example/api')
    const client = new EsploraClient({ baseUrl: mock.baseUrl, fetchFn: mock.fetchFn })
    await expect(client.getFeeEstimates()).resolves.toEqual({ '1': 20, '3': 10, '6': 5, '144': 1 })
    const fees = createMockEsplora({
      backend: 'mempool-qbit',
      recommendedFees: undefined,
    } as unknown as MockEsploraOptions)
    const mempool = new MempoolQbitClient({ baseUrl: fees.baseUrl, fetchFn: fees.fetchFn })
    await expect(mempool.getMempoolRecommendedFees()).resolves.toMatchObject({ fastestFee: 20, minimumFee: 1 })
  })

  it('throws a TypeError from hasTx for a malformed txid', () => {
    const mock = createMockEsplora({ backend: 'esplora' })
    expect(() => mock.hasTx('nope')).toThrow(TypeError)
  })

  it('accepts the edge values', () => {
    expect(() =>
      createMockEsplora({
        backend: 'mempool-qbit',
        baseUrl: 'http://127.0.0.1:3000',
        txs: [
          {
            txid: txid(1, 0),
            vout: [{ value: 0 }, { value: Number.MAX_SAFE_INTEGER - 1 }],
            block: { height: 0, time: 0 },
          },
          { txid: txid(2, 0), vin: [{ txid: txid(1, 0), vout: 1 }], vout: [{ value: 0 }] },
          // The same block, given in full: the default hash for height 0, and the same time.
          { txid: txid(3, 0), vout: [{ value: 0 }], block: { height: 0, hash: '00'.repeat(32), time: 0 } },
        ],
        tip: { height: 0, hash: '00'.repeat(32) },
        feeEstimates: {},
        faults: [
          { route: 'POST /tx/push', kind: 'status', status: 204, times: Infinity },
          { route: 'GET /tx/:txid', kind: 'stall', status: 599, retryAfter: 0 },
          { route: 'POST /tx', kind: 'broadcast', outcome: 'rejected', code: -1, message: '' },
        ],
      })
    ).not.toThrow()
  })
})

describe('the testing entry point', () => {
  it('imports nothing at runtime from the client, so its build carries no second QbitApiError', () => {
    const source = readFileSync(new URL('../src/testing.ts', import.meta.url), 'utf8')
    const imports = [...source.matchAll(/^import\s+(type\s+)?[^;]*?from\s+'([^']+)'/gms)]
    expect(imports.map(match => [match[2], Boolean(match[1])])).toEqual([
      ['@noble/hashes/sha2', false],
      ['./index', true],
    ])
  })
})

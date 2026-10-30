import { readFileSync } from 'node:fs'

import { sha256 } from '@noble/hashes/sha2'
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
 * An unsigned legacy transaction spending `inputs`, each with an empty
 * scriptSig unless given one, with one output per entry of `outputs`, each
 * paying `OP_TRUE` unless given a script. A value is a signed 64-bit integer.
 * The mock checks no script or signature.
 */
function legacyTx(
  inputs: { txid: string; vout: number; scriptSig?: string }[],
  outputs: { value: number | bigint; script?: string }[],
  version = 2
): string {
  const uint = (value: number | bigint, bytes: number): string => {
    const le = BigInt.asUintN(8 * bytes, BigInt(value))
    return Array.from({ length: bytes }, (_, i) => ((le >> BigInt(8 * i)) & 0xffn).toString(16).padStart(2, '0')).join(
      ''
    )
  }
  const compactSize = (n: number): string =>
    n < 0xfd ? uint(n, 1) : n <= 0xffff ? `fd${uint(n, 2)}` : `fe${uint(n, 4)}`
  const varBytes = (hex: string): string => `${compactSize(hex.length / 2)}${hex}`
  const reversed = (hex: string): string => hex.match(/../g)!.reverse().join('')
  return [
    uint(version, 4),
    compactSize(inputs.length),
    ...inputs.map(input => `${reversed(input.txid)}${uint(input.vout, 4)}${varBytes(input.scriptSig ?? '')}fdffffff`),
    compactSize(outputs.length),
    ...outputs.map(({ value, script = '51' }) => `${uint(value, 8)}${varBytes(script)}`),
    uint(0, 4),
  ].join('')
}

/**
 * `hex`, a legacy transaction from {@link legacyTx}, in the witness
 * serialization with each input's `witnesses` entry as its stack, of items
 * under 253 bytes.
 */
function withWitness(hex: string, witnesses: string[][]): string {
  const varBytes = (item: string): string => `${(item.length / 2).toString(16).padStart(2, '0')}${item}`
  const stacks = witnesses.map(stack => `${stack.length.toString(16).padStart(2, '0')}${stack.map(varBytes).join('')}`)
  return `${hex.slice(0, 8)}0001${hex.slice(8, -8)}${stacks.join('')}${hex.slice(-8)}`
}

/** A txid or wtxid: the double SHA-256 of the bytes, byte-reversed. */
function hashId(hex: string): string {
  const bytes = Uint8Array.from(hex.match(/../g)!, byte => parseInt(byte, 16))
  return Array.from(sha256(sha256(bytes)).reverse(), byte => byte.toString(16).padStart(2, '0')).join('')
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

  it("leaves out of the address views the outputs qbit-electrs's default configuration does not index", async () => {
    // qbit-electrs indexes an output only when rust-bitcoin's is_provably_unspendable is false, unless it runs with
    // --index-unspendables (src/new_index/mempool.rs:556, src/new_index/schema.rs:1779, src/util/transaction.rs:71-73).
    const MIXED = txid(0x0d, 0)
    const { client } = esplora({
      txs: [
        {
          txid: MIXED,
          vout: [
            { address: ADDR, value: 1_000 },
            { address: ADDR, value: 2_000, scriptPubKey: '6a0474657374' },
            // A legacy script treats OP_RESERVED as OP_RETURN, so rust-bitcoin takes it as provably unspendable.
            { address: ADDR, value: 3_000, scriptPubKey: '50' },
            // qbit Core never makes a script over 10,000 bytes a coin, but rust-bitcoin does not look at the size.
            { address: ADDR, value: 4_000, scriptPubKey: '51'.repeat(10_001) },
          ],
          block: { height: 3 },
        },
        { txid: txid(0x0d, 1), vout: [{ address: ADDR, value: 5_000, scriptPubKey: '6a' }], block: { height: 4 } },
        { txid: txid(0x0d, 2), vout: [{ address: ADDR, value: 6_000, scriptPubKey: '6a' }] },
      ],
    })

    await expect(client.getAddressStats(ADDR)).resolves.toEqual({
      address: ADDR,
      chain_stats: { funded_txo_count: 2, funded_txo_sum: 5_000, spent_txo_count: 0, spent_txo_sum: 0, tx_count: 1 },
      mempool_stats: { funded_txo_count: 0, funded_txo_sum: 0, spent_txo_count: 0, spent_txo_sum: 0, tx_count: 0 },
    })
    const status = { confirmed: true, block_height: 3, block_hash: '03'.padStart(64, '0'), block_time: 1_700_001_800 }
    await expect(client.getAddressUtxos(ADDR)).resolves.toEqual([
      { txid: MIXED, vout: 0, value: 1_000, status },
      { txid: MIXED, vout: 3, value: 4_000, status },
    ])
    const { confirmed, mempool } = await client.getAddressHistory(ADDR)
    expect(confirmed.map(tx => tx.txid)).toEqual([MIXED])
    expect(mempool).toEqual([])
  })

  it('matches a qbit bech32 address in lowercase or uppercase, as qbit-electrs does, and any other exactly', async () => {
    // qbit-electrs looks an address up by the script it decodes it to, and its bech32 decoder takes one in either
    // case, never mixed (src/rest.rs:2054-2059, src/qbit_address.rs:103-108, :138-150).
    const { client } = esplora({ txs })
    const upper = ADDR.toUpperCase()
    // It names the address as it was asked for.
    await expect(client.getAddressStats(upper)).resolves.toEqual({
      ...(await client.getAddressStats(ADDR)),
      address: upper,
    })
    await expect(client.getAddressBalance(upper)).resolves.toMatchObject({ confirmedSats: 89_000, totalSats: 50_000 })
    await expect(client.getAddressUtxos(upper)).resolves.toEqual(await client.getAddressUtxos(ADDR))
    const history = await client.getAddressHistory(ADDR)
    expect(history.confirmed.map(tx => tx.txid)).toEqual([SPEND, FUND])
    await expect(client.getAddressHistory(upper)).resolves.toEqual(history)
    const mixed = `${ADDR.slice(0, 12)}${ADDR.slice(12).toUpperCase()}`
    await expect(rejection(client.getAddressStats(mixed))).resolves.toMatchObject({ kind: 'http', status: 400 })

    // A fixture address in uppercase is the same address, served lowercase, as qbit-electrs encodes it from the
    // script (src/util/script.rs:39-42, src/qbit_address.rs:91-101); an input may name it in either case.
    const shouted = esplora({
      txs: [
        { txid: FUND, vout: [{ address: OTHER.toUpperCase(), value: 7 }], block: { height: 1 } },
        {
          txid: SPEND,
          vin: [{ txid: FUND, vout: 0, address: OTHER }],
          vout: [{ address: ADDR.toUpperCase(), value: 7 }],
        },
      ],
    })
    await expect(shouted.client.getTx(SPEND)).resolves.toMatchObject({
      vin: [{ prevout: { scriptpubkey_address: OTHER } }],
      vout: [{ scriptpubkey_address: ADDR }],
    })
    await expect(shouted.client.getAddressStats(OTHER)).resolves.toMatchObject({
      chain_stats: { funded_txo_count: 1, funded_txo_sum: 7 },
      mempool_stats: { spent_txo_count: 1, spent_txo_sum: 7 },
    })
    await expect(shouted.client.getAddressUtxos(ADDR)).resolves.toMatchObject([{ txid: SPEND, vout: 0, value: 7 }])

    // A base58 address is case-sensitive, so it is matched exactly.
    const base58 = 'mipcBbFg9gMiCh81Kj8tqqdgoZub1ZJRfn'
    const legacy = esplora({ txs: [{ txid: FUND, vout: [{ address: base58, value: 5 }], block: { height: 1 } }] })
    await expect(legacy.client.getAddressUtxos(base58)).resolves.toMatchObject([{ txid: FUND, value: 5 }])
    await expect(legacy.client.getAddressUtxos(base58.toLowerCase())).resolves.toEqual([])
    await expect(legacy.client.getAddressUtxos(base58.toUpperCase())).resolves.toEqual([])
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
  it('pages /txs/chain 25 at a time, newest first, and lists /txs/mempool oldest first, capped at 50', async () => {
    const { mock, client } = esplora({ txs: history(60, 3) })

    const first = await client.getAddressTxs(ADDR)
    expect(first.map(tx => tx.txid)).toEqual(Array.from({ length: 25 }, (_, n) => txid(0xcc, 59 - n)))
    const third = await client.getAddressTxs(ADDR, txid(0xcc, 10))
    expect(third.map(tx => tx.txid)).toEqual(Array.from({ length: 10 }, (_, n) => txid(0xcc, 9 - n)))
    await expect(client.getAddressTxs(ADDR, 'ff'.repeat(32))).resolves.toEqual([]) // unknown cursor: 200 []
    const mempool = await client.getAddressMempoolTxs(ADDR)
    // qbit-electrs lists its mempool in arrival order (src/new_index/mempool.rs:155-177, :569-571).
    expect(mempool.map(tx => tx.txid)).toEqual([txid(0xaa, 0), txid(0xaa, 1), txid(0xaa, 2)])
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
    expect(mempool.map(tx => tx.txid)).toEqual(Array.from({ length: 12 }, (_, n) => txid(0xaa, n)))
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

    const reply = await mock.fetchFn(`${mock.baseUrl}/address/${ADDR}/txs?after_txid=${txid(0xaa, 49)}`)
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
    // qbit Core's text (src/rpc/mempool.cpp:81).
    expect(error.responseBody).toBe(rpcError(-22, 'TX decode failed. Make sure the tx has at least one input.'))
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

  it('answers an accepted outcome for a transaction already in a block with its txid, and leaves it confirmed', async () => {
    const { mock, client } = esplora({
      txs: [{ hex: LEGACY_TX_HEX, vout: [{ address: ADDR, value: 5_000_000_000 }], block: { height: 0 } }],
      faults: [{ route: 'POST /tx', kind: 'broadcast', outcome: 'accepted' }],
    })
    const genesis = { confirmed: true, block_height: 0, block_hash: '00'.repeat(32), block_time: 1_700_000_000 }
    await expect(client.broadcastTx(LEGACY_TX_HEX)).resolves.toBe(LEGACY_TXID)

    // qbit Core never takes a transaction it has in a block into its mempool, and neither does the mock.
    await expect(client.getTxStatus(LEGACY_TXID)).resolves.toEqual(genesis)
    await expect(client.getAddressBalance(ADDR)).resolves.toMatchObject({
      confirmedSats: 5_000_000_000,
      mempoolSats: 0,
    })
    await expect(client.getAddressHistory(ADDR)).resolves.toMatchObject({
      confirmed: [{ txid: LEGACY_TXID }],
      mempool: [],
    })
    mock.mine()
    await expect(client.getTxStatus(LEGACY_TXID)).resolves.toEqual(genesis)
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

  describe("a spend of a mempool transaction's unspendable output", () => {
    // CCoinsViewMemPool hands out every output of a mempool transaction (src/txmempool.cpp:1020-1029), so the spend
    // passes the missing-inputs check, and Core refuses it at its script check (src/validation.cpp:1291-1302, :2156,
    // :2255), after ReplacementChecks and before the maxfeerate check.
    const COINS = txid(0xf4, 0)
    const DATA = txid(0xf5, 0)
    const OVERSIZED = '51'.repeat(10_001)
    const funding: MockTx[] = [
      { txid: COINS, vout: [{ value: 100_000_000 }], block: { height: 5 } },
      {
        txid: DATA,
        vin: [{ txid: COINS, vout: 0 }],
        vout: [
          { value: 1_000_000, scriptPubKey: '6a0474657374' },
          { value: 98_000_000 },
          { value: 1, scriptPubKey: OVERSIZED },
        ],
      },
    ]
    const scriptFailure = (hex: string, error: string, n: number, vout: number, wtxid = txidFromRawTx(hex)) =>
      rpcError(
        -26,
        `mempool-script-verify-flag-failed (${error}), input ${n} of ${txidFromRawTx(hex)} (wtxid ${wtxid}), spending ${DATA}:${vout}`
      )

    it('refuses it with the script error of an OP_RETURN output, and never takes it', async () => {
      const { mock, client } = esplora({ txs: funding })
      const spend = legacyTx([{ txid: DATA, vout: 0 }], [{ value: 990_000 }])
      expect(await submit(mock, spend)).toEqual([400, scriptFailure(spend, 'OP_RETURN was encountered', 0, 0)])
      await expect(rejection(client.broadcastTx(spend))).resolves.toMatchObject({ kind: 'http', status: 400 })
      expect(mock.hasTx(txidFromRawTx(spend))).toBe(false)

      // Once a block holds DATA, its OP_RETURN output never enters the UTXO set (src/coins.cpp:74).
      mock.mine()
      expect(await submit(mock, spend)).toEqual([400, MISSING_INPUTS])
      expect(await submit(mock, legacyTx([{ txid: DATA, vout: 3 }], [{ value: 0 }]))).toEqual([400, MISSING_INPUTS])
    })

    it('names the input that spends it, and the wtxid, for a script over 10,000 bytes', async () => {
      const { mock } = esplora({ txs: funding })
      const unsigned = legacyTx(
        [
          { txid: DATA, vout: 1 },
          { txid: DATA, vout: 2 },
        ],
        [{ value: 97_990_000 }]
      )
      const spend = withWitness(unsigned, [['aa'.repeat(64)], []])
      const wtxid = hashId(spend)
      expect(wtxid).not.toBe(txidFromRawTx(spend))
      expect(await submit(mock, spend)).toEqual([400, scriptFailure(spend, 'Script is too big', 1, 2, wtxid)])
    })

    it('refuses it after the checks Core runs first, and before the maxfeerate check', async () => {
      const { mock } = esplora({
        txs: funding,
        faults: [{ route: 'POST /tx', kind: 'broadcast', outcome: 'accepted' }],
      })
      // An accepted fault forces a first spend in; a second conflicts with it.
      const forced = legacyTx([{ txid: DATA, vout: 0 }], [{ value: 990_000 }])
      expect(await submit(mock, forced)).toEqual([200, txidFromRawTx(forced)])
      const conflicting = legacyTx([{ txid: DATA, vout: 0 }], [{ value: 980_000 }])
      expect(await submit(mock, conflicting)).toEqual([
        400,
        rpcError(-26, `insufficient fee, rejecting replacement ${txidFromRawTx(conflicting)}`),
      ])

      const { mock: fresh } = esplora({ txs: funding })
      const overspent = legacyTx([{ txid: DATA, vout: 0 }], [{ value: 1_000_001 }])
      expect(await submit(fresh, overspent)).toEqual([
        400,
        rpcError(-26, 'bad-txns-in-belowout, value in (0.01) < value out (0.01000001)'),
      ])
      // A fee of 1,000,000 sats is above the 610,000 the maxfeerate allows these 61 bytes.
      const overpaid = legacyTx([{ txid: DATA, vout: 0 }], [{ value: 0 }])
      expect(overpaid.length / 2).toBe(61)
      expect(await submit(fresh, overpaid)).toEqual([400, scriptFailure(overpaid, 'OP_RETURN was encountered', 0, 0)])
    })
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

// A case builds and decodes a transaction of over 2 MB, which can take seconds on a shared CI runner.
const SCALE_TIMEOUT_MS = 60_000

describe("createMockEsplora qbit Core's transaction checks", { timeout: SCALE_TIMEOUT_MS }, () => {
  // qbit Core 7ebcddb: CheckTransaction (src/consensus/tx_check.cpp), then CheckTxInputs
  // (src/consensus/tx_verify.cpp), as sendrawtransaction reaches them (src/validation.cpp:839-942).
  const FUND = txid(0xd1, 0)
  const ONE_COIN = txid(0xd2, 0)
  const MEMPOOL_SPEND = txid(0xd3, 0)
  const LARGE = [txid(0xd4, 0), txid(0xd4, 1), txid(0xd4, 2)]
  const MAX_MONEY = 21_000_000_000_000_000n
  const NULL_PREVOUT = { txid: '00'.repeat(32), vout: 0xffff_ffff }
  const txs: MockTx[] = [
    {
      txid: FUND,
      vout: [
        { address: ADDR, value: 100_000 },
        { address: ADDR, value: 50_000 },
      ],
      block: { height: 5 },
    },
    { txid: ONE_COIN, vout: [{ value: 100_000_000 }], block: { height: 5 } },
    { txid: MEMPOOL_SPEND, vin: [{ txid: FUND, vout: 1 }], vout: [{ address: OTHER, value: 49_000 }] },
    // Each a safe integer, together above MAX_MONEY (2.1e16).
    ...LARGE.map(id => ({ txid: id, vout: [{ value: 9_000_000_000_000_000 }], block: { height: 5 } })),
  ]
  const rejected = (reason: string) => rpcError(-26, reason)
  const BURN = rpcError(-25, 'Unspendable output exceeds maximum configured by user (maxburnamount)')

  it.each<[string, string, (hex: string) => string]>([
    // The witness serialization reads `00 00` as no inputs and no outputs (src/primitives/transaction.h:224-232).
    ['no inputs, in the empty witness form', '02000000000000000000', () => rejected('bad-txns-vin-empty')],
    // It fails to decode with the witness serialization, so Core keeps the legacy decoding (src/core_read.cpp:162-190).
    ['no inputs', legacyTx([], [{ value: 1_000 }]), () => rejected('bad-txns-vin-empty')],
    ['no outputs', legacyTx([{ txid: FUND, vout: 0 }], []), () => rejected('bad-txns-vout-empty')],
    [
      'no outputs and an unknown input: CheckTransaction comes first',
      legacyTx([{ txid: 'ee'.repeat(32), vout: 0 }], []),
      () => rejected('bad-txns-vout-empty'),
    ],
    [
      'more than MAX_BLOCK_WEIGHT bytes without the witness',
      legacyTx([{ txid: FUND, vout: 0 }], [{ value: 0, script: '00'.repeat(2_000_000) }]),
      () => rejected('bad-txns-oversize'),
    ],
    [
      'an output below 0',
      legacyTx([{ txid: FUND, vout: 0 }], [{ value: -1n }]),
      () => rejected('bad-txns-vout-negative'),
    ],
    [
      'an output above MAX_MONEY',
      legacyTx([{ txid: FUND, vout: 0 }], [{ value: MAX_MONEY + 1n }]),
      () => rejected('bad-txns-vout-toolarge'),
    ],
    [
      'outputs whose total is above MAX_MONEY',
      legacyTx([{ txid: FUND, vout: 0 }], [{ value: MAX_MONEY }, { value: 1 }]),
      () => rejected('bad-txns-txouttotal-toolarge'),
    ],
    [
      'a null prevout beside another input',
      legacyTx([NULL_PREVOUT, { txid: FUND, vout: 0 }], [{ value: 1_000 }]),
      () => rejected('bad-txns-prevout-null'),
    ],
    [
      'a coinbase whose script is under 2 bytes',
      legacyTx([{ ...NULL_PREVOUT, scriptSig: '51' }], [{ value: 1_000 }]),
      () => rejected('bad-cb-length'),
    ],
    [
      'a coinbase, which only a block holds',
      legacyTx([{ ...NULL_PREVOUT, scriptSig: '0151' }], [{ value: 1_000 }]),
      () => rejected('coinbase'),
    ],
    [
      'outputs worth more than its inputs',
      legacyTx([{ txid: FUND, vout: 0 }], [{ value: 100_001 }]),
      () => rejected('bad-txns-in-belowout, value in (0.001) < value out (0.00100001)'),
    ],
    [
      'outputs worth more than a whole coin',
      legacyTx([{ txid: ONE_COIN, vout: 0 }], [{ value: 100_000_001 }]),
      () => rejected('bad-txns-in-belowout, value in (1.00) < value out (1.00000001)'),
    ],
    [
      'outputs worth more than its inputs, in conflict with a mempool spend: CheckTxInputs comes first',
      legacyTx([{ txid: FUND, vout: 1 }], [{ value: 50_001 }]),
      () => rejected('bad-txns-in-belowout, value in (0.0005) < value out (0.00050001)'),
    ],
    [
      'inputs whose total is above MAX_MONEY',
      legacyTx(
        LARGE.map(id => ({ txid: id, vout: 0 })),
        [{ value: 1_000 }]
      ),
      () => rejected('bad-txns-inputvalues-outofrange'),
    ],
    [
      'an OP_RETURN output with a value: the maxburnamount check comes before any other',
      legacyTx([{ txid: 'ee'.repeat(32), vout: 0 }], [{ value: 1, script: '6a' }]),
      () => BURN,
    ],
    [
      'an output with an opcode above MAX_OPCODE and a value',
      legacyTx([{ txid: FUND, vout: 0 }], [{ value: 1_000, script: 'ba' }]),
      () => BURN,
    ],
    [
      'an output of a mempool transaction it conflicts with',
      legacyTx(
        [
          { txid: FUND, vout: 1 },
          { txid: MEMPOOL_SPEND, vout: 0 },
        ],
        [{ value: 1_000 }]
      ),
      hex =>
        rejected(
          `bad-txns-spends-conflicting-tx, ${txidFromRawTx(hex)} spends conflicting transaction ${MEMPOOL_SPEND}`
        ),
    ],
  ])('refuses a submission with %s', async (_case, hex, reply) => {
    const { mock, client } = esplora({ txs })

    expect(await submit(mock, hex)).toEqual([400, reply(hex)])
    await expect(rejection(client.broadcastTx(hex))).resolves.toMatchObject({ kind: 'http', status: 400 })
    // The node did not take it: a transaction in its mempool would be answered with its txid.
    expect(await submit(mock, hex)).toEqual([400, reply(hex)])
  })

  it('draws the lines where Core does: outputs worth the inputs, an OP_RETURN output of 0, the maxfeerate', async () => {
    const { mock, client } = esplora({ txs })
    const over = legacyTx([{ txid: FUND, vout: 0 }], [{ value: 99_001 }, { value: 1_000, script: '52' }])
    expect((await submit(mock, over))[0]).toBe(400)
    const exact = legacyTx([{ txid: FUND, vout: 0 }], [{ value: 99_000 }, { value: 1_000, script: '52' }])
    await expect(client.broadcastTx(exact)).resolves.toBe(txidFromRawTx(exact))

    const burn = legacyTx([{ txid: ONE_COIN, vout: 0 }], [{ value: 99_999_999 }, { value: 1, script: '6a0101' }])
    expect(await submit(mock, burn)).toEqual([400, BURN])

    // sendrawtransaction's default maxfeerate, 0.1 coin per kvB, allows 10,000 sats per byte: 610,000 for these 61.
    const MAX_FEE = rpcError(-25, 'Fee exceeds maximum configured by user (e.g. -maxtxfee, maxfeerate)')
    const overpaid = legacyTx([{ txid: ONE_COIN, vout: 0 }], [{ value: 99_389_999 }])
    expect(overpaid.length / 2).toBe(61)
    expect(await submit(mock, overpaid)).toEqual([400, MAX_FEE])
    const highest = legacyTx([{ txid: ONE_COIN, vout: 0 }], [{ value: 99_390_000 }])
    await expect(client.broadcastTx(highest)).resolves.toBe(txidFromRawTx(highest))
    mock.mine()
    const data = legacyTx(
      [{ txid: txidFromRawTx(highest), vout: 0 }],
      [{ value: 99_390_000 }, { value: 0, script: '6a0101' }]
    )
    await expect(client.broadcastTx(data)).resolves.toBe(txidFromRawTx(data))
  })

  it('refuses a spend of a coinbase output until it is 1,000 blocks deep in the next block', async () => {
    const COINBASE = txid(0xcb, 0)
    const { mock, client } = esplora({
      txs: [{ txid: COINBASE, coinbase: true, vout: [{ address: ADDR, value: 5_000_000_000 }], block: { height: 10 } }],
      tip: { height: 1_008 },
    })
    const spend = legacyTx([{ txid: COINBASE, vout: 0 }], [{ value: 4_999_900_000 }])

    expect(await submit(mock, spend)).toEqual([
      400,
      rejected('bad-txns-premature-spend-of-coinbase, tried to spend coinbase at depth 999'),
    ])
    mock.mine()
    await expect(client.broadcastTx(spend)).resolves.toBe(txidFromRawTx(spend))
    // qbit-electrs serves a coinbase with its null input (src/rest.rs:260-305) and a fee of 0 (src/util/fees.rs:53-55).
    await expect(client.getTx(COINBASE)).resolves.toMatchObject({
      fee: 0,
      vin: [{ txid: '00'.repeat(32), vout: 0xffff_ffff, prevout: null, is_coinbase: true, sequence: 0xffff_ffff }],
    })
  })

  it("reports a submission's version as an unsigned integer and its weight as qbit-electrs does: its size", async () => {
    const { mock, client } = esplora({ txs: [...txs, ...P2MR_FUNDING] })
    const legacy = legacyTx([{ txid: FUND, vout: 0 }], [{ value: 99_000 }], 0xffff_ffff)
    await expect(client.broadcastTx(legacy)).resolves.toBe(txidFromRawTx(legacy))
    // qbit-electrs reports `tx.version as u32` (src/rest.rs:205-209) and, with qbit's WITNESS_SCALE_FACTOR of 1,
    // the serialized size as the weight (src/qbit_codec.rs:139-145, src/util/fees.rs:34-41).
    await expect(client.getTx(txidFromRawTx(legacy))).resolves.toMatchObject({
      version: 0xffff_ffff,
      size: legacy.length / 2,
      weight: legacy.length / 2,
    })
    await expect(client.broadcastTx(P2MR_TX.rawTxHex)).resolves.toBe(P2MR_TX.txid)
    await expect(client.getTx(P2MR_TX.txid)).resolves.toMatchObject({
      size: P2MR_TX.rawTxHex.length / 2,
      weight: P2MR_TX.rawTxHex.length / 2,
    })
    expect(mock.hasTx(P2MR_TX.txid)).toBe(true)
  })
})

describe('createMockEsplora address views after a submission', () => {
  // qbit-electrs 53102e9 builds each view from its chain index and its mempool
  // (src/new_index/query.rs:126-157, src/new_index/mempool.rs:239-326).
  const FUND = txid(0xe1, 0)
  const ADDR_SCRIPT = `5220${'aa'.repeat(32)}`
  const OTHER_SCRIPT = `5220${'bb'.repeat(32)}`
  // The mock learns which address a submission's output pays from a fixture output with the same scriptPubKey.
  const txs: MockTx[] = [
    {
      txid: FUND,
      vout: [
        { address: ADDR, value: 100_000, scriptPubKey: ADDR_SCRIPT },
        { address: OTHER, value: 1, scriptPubKey: OTHER_SCRIPT },
      ],
      block: { height: 5 },
    },
  ]
  const spend = legacyTx(
    [{ txid: FUND, vout: 0 }],
    [
      { value: 60_000, script: OTHER_SCRIPT },
      { value: 39_000, script: ADDR_SCRIPT },
    ]
  )
  const SPEND = txidFromRawTx(spend)
  const block = (height: number) => ({
    confirmed: true,
    block_height: height,
    block_hash: height.toString(16).padStart(64, '0'),
    block_time: 1_700_000_000 + 600 * height,
  })
  const get = async (mock: MockEsplora, path: string) => (await mock.fetchFn(`${mock.baseUrl}${path}`)).json()
  const ids = (rows: unknown) => (rows as { txid: string }[]).map(row => row.txid)

  it('counts a submission in every view, in the mempool before mine() and confirmed after', async () => {
    const { mock, client } = esplora({ txs })
    await expect(client.broadcastTx(spend)).resolves.toBe(SPEND)

    // A mempool spend of a confirmed output: chain_stats still count it funded, mempool_stats count it spent.
    await expect(client.getAddressStats(ADDR)).resolves.toEqual({
      address: ADDR,
      chain_stats: { funded_txo_count: 1, funded_txo_sum: 100_000, spent_txo_count: 0, spent_txo_sum: 0, tx_count: 1 },
      mempool_stats: {
        funded_txo_count: 1,
        funded_txo_sum: 39_000,
        spent_txo_count: 1,
        spent_txo_sum: 100_000,
        tx_count: 1,
      },
    })
    await expect(client.getAddressBalance(ADDR)).resolves.toEqual({
      address: ADDR,
      confirmedSats: 100_000,
      mempoolSats: -61_000,
      totalSats: 39_000,
    })
    await expect(client.getAddressBalance(OTHER)).resolves.toMatchObject({ confirmedSats: 1, mempoolSats: 60_000 })
    // The output the mempool spends is gone; the unconfirmed change is listed.
    await expect(client.getAddressUtxos(ADDR)).resolves.toEqual([
      { txid: SPEND, vout: 1, value: 39_000, status: { confirmed: false } },
    ])
    // Confirmed outputs first, then mempool ones (src/new_index/query.rs:126-136).
    await expect(client.getAddressUtxos(OTHER)).resolves.toEqual([
      { txid: FUND, vout: 1, value: 1, status: block(5) },
      { txid: SPEND, vout: 0, value: 60_000, status: { confirmed: false } },
    ])
    expect(ids(await get(mock, `/address/${ADDR}/txs/chain`))).toEqual([FUND])
    expect(ids(await get(mock, `/address/${ADDR}/txs/mempool`))).toEqual([SPEND])
    expect(ids(await get(mock, `/address/${ADDR}/txs`))).toEqual([SPEND, FUND])
    await expect(client.getAddressHistory(ADDR)).resolves.toMatchObject({
      confirmed: [{ txid: FUND }],
      mempool: [{ txid: SPEND, vin: [{ prevout: { scriptpubkey_address: ADDR } }] }],
    })

    mock.mine()
    await expect(client.getAddressStats(ADDR)).resolves.toEqual({
      address: ADDR,
      chain_stats: {
        funded_txo_count: 2,
        funded_txo_sum: 139_000,
        spent_txo_count: 1,
        spent_txo_sum: 100_000,
        tx_count: 2,
      },
      mempool_stats: { funded_txo_count: 0, funded_txo_sum: 0, spent_txo_count: 0, spent_txo_sum: 0, tx_count: 0 },
    })
    await expect(client.getAddressUtxos(ADDR)).resolves.toEqual([
      { txid: SPEND, vout: 1, value: 39_000, status: block(6) },
    ])
    expect(ids(await get(mock, `/address/${ADDR}/txs/chain`))).toEqual([SPEND, FUND])
    expect(ids(await get(mock, `/address/${ADDR}/txs/mempool`))).toEqual([])
    expect(ids(await get(mock, `/address/${ADDR}/txs`))).toEqual([SPEND, FUND])
  })

  it('counts a mempool output a later mempool spend takes as funded, and lists neither', async () => {
    const { client } = mempoolQbit({ txs })
    await expect(client.broadcastTx(spend)).resolves.toBe(SPEND)
    const child = legacyTx([{ txid: SPEND, vout: 1 }], [{ value: 38_000, script: OTHER_SCRIPT }])
    await expect(client.broadcastTx(child)).resolves.toBe(txidFromRawTx(child))

    await expect(client.getAddressStats(ADDR)).resolves.toMatchObject({
      mempool_stats: {
        funded_txo_count: 1,
        funded_txo_sum: 39_000,
        spent_txo_count: 2,
        spent_txo_sum: 139_000,
        tx_count: 2,
      },
    })
    await expect(client.getAddressUtxos(ADDR)).resolves.toEqual([])
    // Arrival order, oldest first.
    await expect(client.getAddressHistory(ADDR)).resolves.toMatchObject({
      confirmed: [{ txid: FUND }],
      mempool: [{ txid: SPEND }, { txid: txidFromRawTx(child) }],
    })
  })

  it('leaves a mempool transaction whose spent outputs it does not all know out of the address views', async () => {
    const { mock, client } = esplora({ txs, faults: [{ route: 'POST /tx', kind: 'broadcast', outcome: 'accepted' }] })
    const unfunded = legacyTx(
      [
        { txid: FUND, vout: 1 },
        { txid: 'ee'.repeat(32), vout: 0 },
      ],
      [{ value: 1_000, script: ADDR_SCRIPT }]
    )
    await expect(client.broadcastTx(unfunded)).resolves.toBe(txidFromRawTx(unfunded))
    await expect(client.broadcastTx(spend)).resolves.toBe(SPEND)
    expect(mock.hasTx(txidFromRawTx(unfunded))).toBe(true)

    // qbit-electrs skips indexing it (src/new_index/mempool.rs:508-517): it neither funds ADDR nor spends FUND:1.
    await expect(client.getAddressStats(ADDR)).resolves.toMatchObject({
      mempool_stats: { funded_txo_count: 1, funded_txo_sum: 39_000, tx_count: 1 },
    })
    expect(ids(await get(mock, `/address/${ADDR}/txs/mempool`))).toEqual([SPEND])
    await expect(client.getAddressUtxos(OTHER)).resolves.toEqual([
      { txid: FUND, vout: 1, value: 1, status: block(5) },
      { txid: SPEND, vout: 0, value: 60_000, status: { confirmed: false } },
    ])
  })

  it('gives a fault-taken spend the output it spends once that arrives, and counts the spend in every view once mined', async () => {
    // A fault takes CHILD, which spends SPEND:1, before the node has SPEND.
    const { mock, client } = esplora({ txs, faults: [{ route: 'POST /tx', kind: 'broadcast', outcome: 'accepted' }] })
    const child = legacyTx([{ txid: SPEND, vout: 1 }], [{ value: 38_000, script: OTHER_SCRIPT }])
    const CHILD = txidFromRawTx(child)
    await expect(client.broadcastTx(child)).resolves.toBe(CHILD)
    await expect(client.broadcastTx(spend)).resolves.toBe(SPEND)

    // qbit-electrs looks a transaction's prevouts up each time it serves it (src/rest.rs:618-637).
    await expect(client.getTx(CHILD)).resolves.toMatchObject({
      vin: [{ txid: SPEND, vout: 1, prevout: { scriptpubkey_address: ADDR, value: 39_000 } }],
      fee: 1_000,
    })
    // But its mempool index skipped CHILD when it arrived, and never adds it (src/new_index/mempool.rs:389-410, :482-517).
    await expect(client.getAddressStats(ADDR)).resolves.toMatchObject({
      mempool_stats: { funded_txo_count: 1, spent_txo_count: 1, spent_txo_sum: 100_000, tx_count: 1 },
    })
    await expect(client.getAddressUtxos(ADDR)).resolves.toEqual([
      { txid: SPEND, vout: 1, value: 39_000, status: { confirmed: false } },
    ])

    // Its block is indexed with every output its transactions spend (src/new_index/schema.rs:576-587, :651-658).
    mock.mine()
    await expect(client.getAddressStats(ADDR)).resolves.toEqual({
      address: ADDR,
      chain_stats: {
        funded_txo_count: 2,
        funded_txo_sum: 139_000,
        spent_txo_count: 2,
        spent_txo_sum: 139_000,
        tx_count: 3,
      },
      mempool_stats: { funded_txo_count: 0, funded_txo_sum: 0, spent_txo_count: 0, spent_txo_sum: 0, tx_count: 0 },
    })
    await expect(client.getAddressBalance(ADDR)).resolves.toMatchObject({ confirmedSats: 0, totalSats: 0 })
    await expect(client.getAddressUtxos(ADDR)).resolves.toEqual([])
    await expect(client.getTx(CHILD)).resolves.toMatchObject({ fee: 1_000, status: block(6) })
    // The block holds SPEND before CHILD, which spends from it, so the history, last in a block first, ends with SPEND.
    const { confirmed } = await client.getAddressHistory(ADDR)
    expect(confirmed.map(tx => tx.txid)).toEqual([CHILD, SPEND, FUND])
    await expect(client.getAddressUtxos(OTHER)).resolves.toEqual([
      { txid: FUND, vout: 1, value: 1, status: block(5) },
      { txid: SPEND, vout: 0, value: 60_000, status: block(6) },
      { txid: CHILD, vout: 0, value: 38_000, status: block(6) },
    ])
  })

  it('mines a fault-taken spend only once the output it spends arrives, so no block spends from the mempool', async () => {
    // A fault takes CHILD, which spends SPEND:0, before the node has SPEND, and the node takes GRANDCHILD, which
    // spends CHILD's output, without one.
    const { mock, client } = esplora({ txs, faults: [{ route: 'POST /tx', kind: 'broadcast', outcome: 'accepted' }] })
    const child = legacyTx([{ txid: SPEND, vout: 0 }], [{ value: 59_000 }])
    const CHILD = txidFromRawTx(child)
    const grandchild = legacyTx([{ txid: CHILD, vout: 0 }], [{ value: 58_000 }])
    const GRANDCHILD = txidFromRawTx(grandchild)
    await expect(client.broadcastTx(child)).resolves.toBe(CHILD)
    await expect(client.broadcastTx(grandchild)).resolves.toBe(GRANDCHILD)

    // No block holds a transaction whose inputs are missing (src/node/miner.cpp:189-191), nor one spending from it.
    expect(mock.mine()).toMatchObject({ height: 6 })
    await expect(client.getTxStatus(CHILD)).resolves.toEqual({ confirmed: false })
    await expect(client.getTxStatus(GRANDCHILD)).resolves.toEqual({ confirmed: false })

    // No block spends from SPEND, so the node takes it, and the next block confirms the three, parents first.
    await expect(client.broadcastTx(spend)).resolves.toBe(SPEND)
    await expect(client.getAddressBalance(OTHER)).resolves.toEqual({
      address: OTHER,
      confirmedSats: 1,
      mempoolSats: 60_000,
      totalSats: 60_001,
    })
    expect(mock.mine()).toMatchObject({ height: 7 })
    await expect(client.getAddressStats(OTHER)).resolves.toEqual({
      address: OTHER,
      chain_stats: {
        funded_txo_count: 2,
        funded_txo_sum: 60_001,
        spent_txo_count: 1,
        spent_txo_sum: 60_000,
        tx_count: 3,
      },
      mempool_stats: { funded_txo_count: 0, funded_txo_sum: 0, spent_txo_count: 0, spent_txo_sum: 0, tx_count: 0 },
    })
    await expect(client.getAddressUtxos(OTHER)).resolves.toEqual([{ txid: FUND, vout: 1, value: 1, status: block(5) }])
    const { confirmed } = await client.getAddressHistory(OTHER)
    expect(confirmed.map(tx => tx.txid)).toEqual([CHILD, SPEND, FUND])
    await expect(client.getTxStatus(GRANDCHILD)).resolves.toEqual(block(7))
  })

  describe('a transaction that a fixture transaction in a block spends from', () => {
    // S, in block 6, spends X:0, an output outside the fixture; X spends FUND:0.
    const x = legacyTx(
      [{ txid: FUND, vout: 0 }],
      [
        { value: 60_000, script: ADDR_SCRIPT },
        { value: 39_000, script: OTHER_SCRIPT },
      ]
    )
    const X = txidFromRawTx(x)
    const S = txid(0xe2, 0)
    const spender = (funding: string, value: number): MockTx => ({
      txid: S,
      vin: [{ txid: funding, vout: 0, address: ADDR, value }],
      vout: [{ value: value - 1_000 }],
      block: { height: 6 },
    })
    const respend = legacyTx([{ txid: X, vout: 0 }], [{ value: 59_000 }])

    it('is in the chain, so the node refuses it, and the output S spends is never a coin', async () => {
      const { mock, client } = esplora({ txs: [...txs, spender(X, 60_000)] })
      // Its own inputs are spent in the chain: Core's missing-inputs reply (src/validation.cpp:893-916). The mock
      // holds no output of it, so BroadcastTransaction's check for one in the UTXO set (-27) finds none
      // (src/node/transaction.cpp:51-58).
      expect(await submit(mock, x)).toEqual([400, rpcError(-25, 'bad-txns-inputs-missingorspent')])
      expect(mock.hasTx(X)).toBe(false)
      expect((await client.getAddressUtxos(ADDR)).map(utxo => utxo.txid)).not.toContain(X)
      expect(await submit(mock, respend)).toEqual([400, rpcError(-25, 'bad-txns-inputs-missingorspent')])
    })

    it('joins that block when a fault takes it, so S spends it there in every view', async () => {
      const { mock, client } = esplora({
        txs: [...txs, spender(X, 60_000)],
        faults: [{ route: 'POST /tx', kind: 'broadcast', outcome: 'accepted' }],
      })
      await expect(client.broadcastTx(x)).resolves.toBe(X)
      await expect(client.getTxStatus(X)).resolves.toEqual(block(6))
      await expect(client.getAddressStats(ADDR)).resolves.toEqual({
        address: ADDR,
        chain_stats: {
          funded_txo_count: 2,
          funded_txo_sum: 160_000,
          spent_txo_count: 2,
          spent_txo_sum: 160_000,
          tx_count: 3,
        },
        mempool_stats: { funded_txo_count: 0, funded_txo_sum: 0, spent_txo_count: 0, spent_txo_sum: 0, tx_count: 0 },
      })
      await expect(client.getAddressUtxos(ADDR)).resolves.toEqual([])
      await expect(client.getAddressUtxos(OTHER)).resolves.toEqual([
        { txid: FUND, vout: 1, value: 1, status: block(5) },
        { txid: X, vout: 1, value: 39_000, status: block(6) },
      ])
      // Just before S in its block, so the history, last in a block first, lists S first.
      const { confirmed } = await client.getAddressHistory(ADDR)
      expect(confirmed.map(tx => tx.txid)).toEqual([S, X, FUND])
      // X:0 is spent in the chain, and X:1 is a coin, which makes a resubmission of X the already-known -27.
      expect(await submit(mock, respend)).toEqual([400, rpcError(-25, 'bad-txns-inputs-missingorspent')])
      expect(await submit(mock, x)).toEqual([400, rpcError(-27, 'Transaction outputs already in utxo set')])
    })

    it('brings the mempool transactions it spends from into that block with it', async () => {
      // X2 spends SPEND:1, and S spends X2:0. Both submissions take the fault.
      const x2 = legacyTx([{ txid: SPEND, vout: 1 }], [{ value: 38_000, script: ADDR_SCRIPT }])
      const X2 = txidFromRawTx(x2)
      const { client } = esplora({
        txs: [...txs, spender(X2, 38_000)],
        faults: [{ route: 'POST /tx', kind: 'broadcast', outcome: 'accepted', times: 2 }],
      })
      await expect(client.broadcastTx(spend)).resolves.toBe(SPEND)
      await expect(client.getTxStatus(SPEND)).resolves.toEqual({ confirmed: false })
      await expect(client.broadcastTx(x2)).resolves.toBe(X2)
      await expect(client.getTxStatus(SPEND)).resolves.toEqual(block(6))
      await expect(client.getTxStatus(X2)).resolves.toEqual(block(6))
      await expect(client.getAddressBalance(ADDR)).resolves.toEqual({
        address: ADDR,
        confirmedSats: 0,
        mempoolSats: 0,
        totalSats: 0,
      })
      await expect(client.getAddressUtxos(OTHER)).resolves.toEqual([
        { txid: FUND, vout: 1, value: 1, status: block(5) },
        { txid: SPEND, vout: 0, value: 60_000, status: block(6) },
      ])
      const { confirmed } = await client.getAddressHistory(ADDR)
      expect(confirmed.map(tx => tx.txid)).toEqual([S, X2, SPEND, FUND])
    })
  })

  it('looks a combined-history cursor up among every transaction, and ignores an unparseable one', async () => {
    const { mock } = esplora({
      txs: [...history(3, 2), { txid: txid(0xbb, 0), vout: [{ address: OTHER, value: 1 }], block: { height: 9 } }],
    })
    // A confirmed transaction of another address: the chain history does not hold it, so the page is empty.
    expect(await get(mock, `/address/${ADDR}/txs?after_txid=${txid(0xbb, 0)}`)).toEqual([])
    expect(ids(await get(mock, `/address/${ADDR}/txs?after_txid=not-a-txid`))).toEqual([
      txid(0xaa, 0),
      txid(0xaa, 1),
      txid(0xcc, 2),
      txid(0xcc, 1),
      txid(0xcc, 0),
    ])
  })
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

  it('ends a submission whose 429 stalls as unknown_outcome, never re-sent: its body could have said the node has it', async () => {
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
    const error = await rejection(client.broadcastTx(P2MR_TX.rawTxHex))
    expect(error).toMatchObject({
      kind: 'unknown_outcome',
      status: 429,
      txid: P2MR_TX.txid,
      cause: { kind: 'timeout' },
    })
    expect(sleeps).toEqual([])
    expect(mock.requests.filter(request => request.method === 'POST')).toHaveLength(1)
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
    // qbit-electrs's bech32 decoder refuses mixed case.
    [
      'a bech32 address in mixed case',
      { backend: 'esplora', txs: [tx({ vout: [{ address: `qbrt1Z${ADDR.slice(6)}`, value: 1 }] })] },
    ],
    [
      'an input address in mixed case',
      {
        backend: 'esplora',
        txs: [tx({ vin: [{ txid: txid(9, 9), vout: 0, address: `QBRT1z${ADDR.slice(6)}`, value: 1 }] })],
      },
    ],
    ['a negative value', { backend: 'esplora', txs: [tx({ vout: [{ value: -1 }] })] }],
    ['a NaN value', { backend: 'esplora', txs: [tx({ vout: [{ value: Number.NaN }] })] }],
    ['an infinite value', { backend: 'esplora', txs: [tx({ vout: [{ value: Infinity }] })] }],
    ['a fractional value', { backend: 'esplora', txs: [tx({ vout: [{ value: 0.5 }] })] }],
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
    // qbit Core never makes an unspendable output a coin (src/coins.cpp:74).
    [
      'a spend of an OP_RETURN output',
      {
        backend: 'esplora',
        txs: [
          tx({ vout: [{ value: 0, scriptPubKey: '6a0474657374' }] }),
          { txid: txid(2, 0), vin: [{ txid: txid(1, 0), vout: 0 }], vout: [{ value: 0 }] },
        ],
      },
    ],
    [
      'a spend of an output over 10,000 bytes',
      {
        backend: 'esplora',
        txs: [
          tx({ vout: [{ value: 1, scriptPubKey: '51'.repeat(10_001) }] }),
          { txid: txid(2, 0), vin: [{ txid: txid(1, 0), vout: 0 }], vout: [{ value: 1 }] },
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
    // Headers refuses a NUL, CR or LF inside a value, and any character above U+00FF.
    ...['a\u0000b', '\u20ac', '\u0100'].flatMap((retryAfter): [string, unknown][] => [
      [
        `a Retry-After ${JSON.stringify(retryAfter)} that Headers refuses`,
        { backend: 'esplora', faults: [{ route: 'POST /tx', kind: 'status', status: 429, retryAfter }] },
      ],
      [
        `a stalled Retry-After ${JSON.stringify(retryAfter)} that Headers refuses`,
        { backend: 'esplora', faults: [{ route: 'GET /tx/:txid', kind: 'stall', status: 429, retryAfter }] },
      ],
    ]),
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

  it('types a rejected broadcast fault with its code, and the other outcomes without a code or message', () => {
    // The compiler refuses what createMockEsplora refuses; `tsc -p test` checks that each directive is needed.
    // @ts-expect-error: a rejected outcome needs its RPC error code.
    const uncoded: MockFault = { route: 'POST /tx', kind: 'broadcast', outcome: 'rejected', message: 'refused' }
    // @ts-expect-error: only a rejected outcome has an RPC error code.
    const coded: MockFault = { route: 'POST /tx', kind: 'broadcast', outcome: 'lost-reply', code: -26 }
    // @ts-expect-error: only a rejected outcome has an RPC error message.
    const messaged: MockFault = { route: 'POST /tx/push', kind: 'broadcast', outcome: 'accepted', message: 'ok' }
    for (const fault of [uncoded, coded, messaged])
      expect(bad({ backend: 'esplora', faults: [fault] })).toThrow(TypeError)

    const faults: MockFault[] = [
      { route: 'POST /tx', kind: 'broadcast', outcome: 'rejected', code: -26 },
      { route: 'POST /tx', kind: 'broadcast', outcome: 'lost-reply' },
    ]
    expect(() => createMockEsplora({ backend: 'esplora', faults })).not.toThrow()
  })

  it('sends any Retry-After Headers accepts, as Headers normalizes it', async () => {
    for (const [retryAfter, sent] of [
      [' 7 ', '7'],
      ['', ''],
      ['a\u0001b', 'a\u0001b'],
      ['\u00e9', '\u00e9'],
    ]) {
      const mock = createMockEsplora({
        backend: 'esplora',
        faults: [{ route: 'GET /blocks/tip/height', kind: 'status', status: 429, retryAfter: retryAfter! }],
      })
      const reply = await mock.fetchFn(`${mock.baseUrl}/blocks/tip/height`)
      expect(reply.headers.get('retry-after')).toBe(sent)
    }
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

  it('refuses a fixture transaction whose outputs or inputs are worth more than MAX_MONEY, and takes MAX_MONEY', async () => {
    // qbit Core's MAX_MONEY, 210,000,000 coins (src/consensus/amount.h:26), is above Number.MAX_SAFE_INTEGER.
    const NINE = 9_000_000_000_000_000
    const THREE = 3_000_000_000_000_000
    const funding = (last: number): MockTx => ({
      txid: txid(1, 0),
      vout: [{ value: NINE }, { value: NINE }, { value: last }],
    })
    expect(() => createMockEsplora({ backend: 'esplora', txs: [funding(THREE + 1)] })).toThrow(
      /moves more than MAX_MONEY \(21000000000000000 sats\)/
    )
    const inputs = [0, 1].map(vout => ({ txid: txid(1, 0), vout }))
    const overspend: MockTx[] = [
      { txid: txid(1, 0), vout: [{ value: NINE }, { value: NINE }] },
      { txid: txid(2, 0), vout: [{ value: THREE + 1 }] },
      { txid: txid(3, 0), vin: [...inputs, { txid: txid(2, 0), vout: 0 }], vout: [{ value: 1 }] },
    ]
    expect(() => createMockEsplora({ backend: 'esplora', txs: overspend })).toThrow(/moves more than MAX_MONEY/)

    const { client } = esplora({
      txs: [
        funding(THREE),
        {
          txid: txid(2, 0),
          vin: [0, 1, 2].map(vout => ({ txid: txid(1, 0), vout })),
          vout: [{ value: NINE }, { value: NINE }, { value: THREE - 1_000 }],
          fee: 1_000,
        },
      ],
    })
    await expect(client.getTx(txid(2, 0))).resolves.toMatchObject({ fee: 1_000 })
  })

  it('refuses hex of a transaction with no inputs, which Core decodes but never holds', () => {
    const hex = legacyTx([], [{ value: 1 }])
    expect(() => createMockEsplora({ backend: 'esplora', txs: [{ hex, vout: [{ value: 1 }] }] })).toThrow(
      /is a transaction with no inputs, which qbit Core never holds/
    )
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

describe('createMockEsplora coinbase fixtures', () => {
  const tx = (overrides: Partial<MockTx> = {}): MockTx => ({
    txid: txid(0x01, 0),
    vout: [{ address: ADDR, value: 1 }],
    ...overrides,
  })

  it.each<[string, unknown, RegExp]>([
    [
      'a coinbase that is not a boolean',
      { backend: 'esplora', txs: [tx({ coinbase: 'yes' as never })] },
      /coinbase must be a boolean/,
    ],
    ['a null coinbase', { backend: 'esplora', txs: [tx({ coinbase: null as never })] }, /coinbase must be a boolean/],
    [
      'a coinbase in the mempool',
      { backend: 'esplora', txs: [tx({ coinbase: true })] },
      /is a coinbase, so it needs a block and no vin/,
    ],
    [
      'a coinbase with inputs',
      {
        backend: 'esplora',
        txs: [
          tx({ block: { height: 1 } }),
          {
            txid: txid(2, 0),
            coinbase: true,
            vin: [{ txid: txid(1, 0), vout: 0 }],
            vout: [{ value: 1 }],
            block: { height: 2 },
          },
        ],
      },
      /is a coinbase, so it needs a block and no vin/,
    ],
    [
      'a coinbase whose hex is not a coinbase transaction',
      {
        backend: 'esplora',
        txs: [
          {
            hex: legacyTx([{ txid: txid(9, 0), vout: 0 }], [{ value: 1 }]),
            coinbase: true,
            vout: [{ value: 1 }],
            block: { height: 1 },
          },
        ],
      },
      /is a coinbase, but its hex is not a coinbase transaction/,
    ],
    [
      'coinbase: false with the hex of a coinbase transaction',
      {
        backend: 'esplora',
        txs: [{ hex: LEGACY_TX_HEX, coinbase: false, vout: [{ value: 1 }], block: { height: 0 } }],
      },
      /coinbase is false, but its hex is a coinbase transaction/,
    ],
    [
      'the hex of a coinbase transaction in the mempool',
      { backend: 'esplora', txs: [{ hex: LEGACY_TX_HEX, vout: [{ value: 1 }] }] },
      /is a coinbase, so it needs a block and no vin/,
    ],
    [
      'two coinbases in one block',
      {
        backend: 'esplora',
        txs: [
          tx({ coinbase: true, block: { height: 10 } }),
          tx({ txid: txid(2, 0), block: { height: 9 } }),
          { hex: LEGACY_TX_HEX, vout: [{ value: 1 }], block: { height: 10 } },
        ],
      },
      /is a second coinbase in block 10, after 01/,
    ],
    [
      'a coinbase listed after another transaction of its block',
      {
        backend: 'esplora',
        txs: [tx({ block: { height: 10 } }), tx({ txid: txid(2, 0), coinbase: true, block: { height: 10 } })],
      },
      /is a coinbase, so it must be listed before 01.*, another transaction of block 10/,
    ],
    [
      'a coinbase with a fee',
      { backend: 'esplora', txs: [tx({ coinbase: true, fee: 1, block: { height: 1 } })] },
      /is a coinbase, so its fee is 0/,
    ],
    [
      'a confirmed spend of a coinbase output below 1,000 blocks deep',
      {
        backend: 'esplora',
        txs: [
          tx({ coinbase: true, block: { height: 10 } }),
          { txid: txid(2, 0), vin: [{ txid: txid(1, 0), vout: 0 }], vout: [{ value: 1 }], block: { height: 1_009 } },
        ],
      },
      /spends coinbase output .* at depth 999, below 1000/,
    ],
    [
      'a mempool spend of a coinbase output below 1,000 blocks deep in the next block',
      {
        backend: 'esplora',
        txs: [
          tx({ coinbase: true, block: { height: 10 } }),
          { txid: txid(2, 0), vin: [{ txid: txid(1, 0), vout: 0 }], vout: [{ value: 1 }] },
        ],
        tip: { height: 1_008 },
      },
      /spends coinbase output .* in the mempool at depth 999, below 1000/,
    ],
  ])('throws a TypeError for %s', (_case, options, message) => {
    expect(() => createMockEsplora(options as MockEsploraOptions)).toThrow(TypeError)
    expect(() => createMockEsplora(options as MockEsploraOptions)).toThrow(message)
  })

  it.each([
    ['declared with coinbase: true', true],
    ['whose hex alone makes it one', undefined],
  ])("serves a coinbase %s with its hex's coinbase input, and applies maturity to its outputs", async (_case, flag) => {
    const { mock, client } = esplora({
      txs: [
        {
          hex: LEGACY_TX_HEX,
          ...(flag === undefined ? {} : { coinbase: flag }),
          vout: [{ value: 5_000_000_000 }],
          block: { height: 0 },
        },
      ],
    })
    const scriptsig = LEGACY_TX_HEX.slice(84, 84 + 2 * 0x4d)
    expect(scriptsig).toMatch(/^04ffff001d01/)
    const tx = await client.getTx(LEGACY_TXID)
    expect(tx).toMatchObject({
      fee: 0,
      vin: [
        {
          txid: '00'.repeat(32),
          vout: 0xffff_ffff,
          prevout: null,
          scriptsig,
          is_coinbase: true,
          sequence: 0xffff_ffff,
        },
      ],
    })
    // A legacy coinbase has no witness, which qbit-electrs then leaves out (src/rest.rs:266-270).
    expect(tx.vin[0]).not.toHaveProperty('witness')
    expect(await submit(mock, legacyTx([{ txid: LEGACY_TXID, vout: 0 }], [{ value: 4_999_000_000 }]))).toEqual([
      400,
      rpcError(-26, 'bad-txns-premature-spend-of-coinbase, tried to spend coinbase at depth 1'),
    ])
  })

  it("serves a coinbase input's witness from the hex, as qbit-electrs does", async () => {
    const legacy = legacyTx(
      [{ txid: '00'.repeat(32), vout: 0xffff_ffff, scriptSig: '0151' }],
      [{ value: 5_000_000_000 }]
    )
    // A segwit coinbase's witness: its 32-byte reserved value.
    const hex = withWitness(legacy, [['00'.repeat(32)]])
    const { client } = esplora({ txs: [{ hex, vout: [{ value: 5_000_000_000 }], block: { height: 1 } }] })
    await expect(client.getTx(txidFromRawTx(hex))).resolves.toMatchObject({
      vin: [{ scriptsig: '0151', witness: ['00'.repeat(32)], is_coinbase: true }],
    })
    await expect(client.getTxHex(txidFromRawTx(hex))).resolves.toBe(hex)
  })

  it('places a coinbase first in its block, so the chain history lists it after the rest of the block', async () => {
    const { client } = esplora({
      txs: [
        tx({ txid: txid(0xcb, 0), coinbase: true, block: { height: 10 } }),
        tx({ txid: txid(2, 0), block: { height: 10 } }),
        tx({ txid: txid(3, 0), block: { height: 9 } }),
        tx({ txid: txid(4, 0), block: { height: 10 } }),
      ],
    })
    // Newest first: by height, then by position in the block, last first (qbit-electrs src/rest.rs:1165-1171).
    const { confirmed } = await client.getAddressHistory(ADDR)
    expect(confirmed.map(row => row.txid)).toEqual([txid(4, 0), txid(2, 0), txid(0xcb, 0), txid(3, 0)])
  })

  it('takes spends of a coinbase output exactly 1,000 blocks deep, in a block and in the mempool', () => {
    // One coinbase per block: at heights 10 and 11.
    const coinbase = (n: number): MockTx => ({
      txid: txid(0xcb, n),
      coinbase: true,
      vout: [{ value: 5_000_000_000 }],
      block: { height: 10 + n },
      fee: 0,
    })
    const spend = (n: number, block?: MockTx['block']): MockTx => ({
      txid: txid(0x5e, n),
      vin: [{ txid: txid(0xcb, n), vout: 0 }],
      vout: [{ value: 4_999_000_000 }],
      ...(block === undefined ? {} : { block }),
    })
    expect(() =>
      createMockEsplora({
        backend: 'esplora',
        txs: [coinbase(0), coinbase(1), spend(0, { height: 1_010 }), spend(1)],
        tip: { height: 1_010 },
      })
    ).not.toThrow()
  })
})

describe('createMockEsplora coinbase submissions', () => {
  // The genesis coinbase's only output script, which the fixture pairs with ADDR.
  const GENESIS_SCRIPT = LEGACY_TX_HEX.slice(-8 - 2 * 0x43, -8)
  const spendGenesis = legacyTx([{ txid: LEGACY_TXID, vout: 0 }], [{ value: 4_999_000_000 }])
  const block = (height: number) => ({
    confirmed: true,
    block_height: height,
    block_hash: height.toString(16).padStart(64, '0'),
    block_time: 1_700_000_000 + 600 * height,
  })

  it.each(['accepted', 'lost-reply'] as const)(
    'serves a coinbase a fault takes (%s) as one, puts it first in the block mine() makes, and matures it from there',
    async outcome => {
      // A mempool transaction that arrived before the coinbase, paying ADDR as the coinbase does.
      const earlier: MockTx = {
        txid: txid(0xa0, 0),
        vin: [{ txid: txid(0xee, 0), vout: 0, value: 2_000 }],
        vout: [{ address: ADDR, value: 1_000, scriptPubKey: GENESIS_SCRIPT }],
      }
      const { mock, client } = esplora({ txs: [earlier], faults: [{ route: 'POST /tx', kind: 'broadcast', outcome }] })
      if (outcome === 'accepted') {
        await expect(client.broadcastTx(LEGACY_TX_HEX)).resolves.toBe(LEGACY_TXID)
      } else {
        await expect(rejection(client.broadcastTx(LEGACY_TX_HEX))).resolves.toMatchObject({
          kind: 'unknown_outcome',
          txid: LEGACY_TXID,
        })
      }
      await expect(client.getTx(LEGACY_TXID)).resolves.toMatchObject({
        fee: 0,
        vin: [{ txid: '00'.repeat(32), vout: 0xffff_ffff, prevout: null, is_coinbase: true, sequence: 0xffff_ffff }],
        status: { confirmed: false },
      })
      await expect(client.getAddressBalance(ADDR)).resolves.toMatchObject({ mempoolSats: 5_000_001_000 })
      // In the mempool it counts as the coinbase of the next block, where mine() confirms it.
      expect(await submit(mock, spendGenesis)).toEqual([
        400,
        rpcError(-26, 'bad-txns-premature-spend-of-coinbase, tried to spend coinbase at depth 0'),
      ])

      expect(mock.mine()).toMatchObject({ height: 1 })
      await expect(client.getTxStatus(LEGACY_TXID)).resolves.toEqual(block(1))
      // First in its block, so the chain history, last in a block first, lists it after the earlier transaction.
      const { confirmed } = await client.getAddressHistory(ADDR)
      expect(confirmed.map(tx => tx.txid)).toEqual([txid(0xa0, 0), LEGACY_TXID])
      expect(await submit(mock, spendGenesis)).toEqual([
        400,
        rpcError(-26, 'bad-txns-premature-spend-of-coinbase, tried to spend coinbase at depth 1'),
      ])
      expect(await submit(mock, LEGACY_TX_HEX)).toEqual([400, rpcError(-27, 'Transaction outputs already in utxo set')])
    }
  )

  it('puts a fault-taken coinbase that a block spends from first in that block', async () => {
    const { client } = esplora({
      txs: [
        {
          txid: txid(0x07, 0),
          vout: [{ address: ADDR, value: 1, scriptPubKey: GENESIS_SCRIPT }],
          block: { height: 1_500 },
        },
        {
          txid: txid(0x5e, 0),
          vin: [{ txid: LEGACY_TXID, vout: 0, address: ADDR, value: 5_000_000_000 }],
          vout: [{ address: OTHER, value: 4_999_000_000 }],
          block: { height: 1_500 },
        },
      ],
      faults: [{ route: 'POST /tx', kind: 'broadcast', outcome: 'accepted' }],
    })
    await expect(client.broadcastTx(LEGACY_TX_HEX)).resolves.toBe(LEGACY_TXID)
    await expect(client.getTx(LEGACY_TXID)).resolves.toMatchObject({
      vin: [{ is_coinbase: true }],
      status: block(1_500),
    })
    await expect(client.getAddressBalance(ADDR)).resolves.toEqual({
      address: ADDR,
      confirmedSats: 1,
      mempoolSats: 0,
      totalSats: 1,
    })
    const { confirmed } = await client.getAddressHistory(ADDR)
    expect(confirmed.map(tx => tx.txid)).toEqual([txid(0x5e, 0), txid(0x07, 0), LEGACY_TXID])
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

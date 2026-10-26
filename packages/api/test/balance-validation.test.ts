import { describe, expect, it } from 'vitest'

import { EsploraClient, QbitApiError } from '../src/index'

const BASE = 'https://esplora.example/regtest/api'
const ADDR = 'qbrt1zqqqsyqcyq5rqwzqfpg9scrgwpugpzysnzs23v9ccrydpk8qarc0s8kqqny'
const noSleep = () => Promise.resolve()

/** Serve `body` verbatim as the address stats, so tests control the exact JSON text. */
function balanceFrom(body: string): Promise<unknown> {
  const fetchFn = (async (input: RequestInfo | URL) => {
    const url = String(input)
    if (url !== `${BASE}/address/${ADDR}`) throw new Error(`unexpected url ${url}`)
    return new Response(body, { status: 200 })
  }) as typeof fetch
  return new EsploraClient({ baseUrl: BASE, fetchFn, sleepFn: noSleep }).getAddressBalance(ADDR)
}

function sums(funded: unknown, spent: unknown): Record<string, unknown> {
  return { funded_txo_count: 1, funded_txo_sum: funded, spent_txo_count: 1, spent_txo_sum: spent, tx_count: 1 }
}

function stats(chain: Record<string, unknown>, mempool: Record<string, unknown> = sums(0, 0)): string {
  return JSON.stringify({ address: ADDR, chain_stats: chain, mempool_stats: mempool })
}

async function expectParseError(promise: Promise<unknown>): Promise<void> {
  const error = await promise.then(
    value => {
      throw new Error(`expected rejection, got ${JSON.stringify(value)}`)
    },
    (error: unknown) => error
  )
  expect(error).toBeInstanceOf(QbitApiError)
  expect(error).toMatchObject({ kind: 'parse' })
}

describe('address balance validation', () => {
  it.each([
    ['null body', 'null'],
    ['array body', '[]'],
    ['empty stats objects', '{"chain_stats":{},"mempool_stats":{}}'],
    ['missing address', JSON.stringify({ chain_stats: sums(10, 0), mempool_stats: sums(0, 0) })],
    ['non-string address', JSON.stringify({ address: 7, chain_stats: sums(10, 0), mempool_stats: sums(0, 0) })],
    ['missing mempool_stats', JSON.stringify({ address: ADDR, chain_stats: sums(10, 0) })],
    ['array mempool_stats', JSON.stringify({ address: ADDR, chain_stats: sums(10, 0), mempool_stats: [] })],
    ['string funded_txo_sum', stats(sums('10', 0))],
    ['null spent_txo_sum', stats(sums(10, null))],
    ['fractional funded_txo_sum', stats(sums(10.5, 0))],
    ['negative mempool funded_txo_sum', stats(sums(10, 0), sums(-1, 0))],
    ['confirmed spent above funded', stats(sums(10, 11))],
    ['mempool spend above the confirmed balance', stats(sums(10, 0), sums(0, 11))],
    ['total above Number.MAX_SAFE_INTEGER', stats(sums(Number.MAX_SAFE_INTEGER, 0), sums(1, 0))],
  ])('rejects %s as a parse error', async (_name, body) => {
    await expectParseError(balanceFrom(body))
  })

  it('rejects a raw JSON sum that JSON.parse would round', async () => {
    // 2^53 + 1 parses to 2^53, so the rounded value must not become a balance.
    const body = `{"address":"${ADDR}","chain_stats":{"funded_txo_count":1,"funded_txo_sum":9007199254740993,"spent_txo_count":0,"spent_txo_sum":0,"tx_count":1},"mempool_stats":{"funded_txo_count":0,"funded_txo_sum":0,"spent_txo_count":0,"spent_txo_sum":0,"tx_count":0}}`
    await expectParseError(balanceFrom(body))
  })

  it('accepts Number.MAX_SAFE_INTEGER exactly', async () => {
    await expect(balanceFrom(stats(sums(Number.MAX_SAFE_INTEGER, 0)))).resolves.toEqual({
      address: ADDR,
      confirmedSats: Number.MAX_SAFE_INTEGER,
      mempoolSats: 0,
      totalSats: Number.MAX_SAFE_INTEGER,
    })
  })

  it('keeps a negative mempool balance that spends confirmed outputs', async () => {
    await expect(balanceFrom(stats(sums(150_000, 50_000), sums(20_000, 70_000)))).resolves.toEqual({
      address: ADDR,
      confirmedSats: 100_000,
      mempoolSats: -50_000,
      totalSats: 50_000,
    })
  })

  it('accepts a zero total when the mempool spends the whole confirmed balance', async () => {
    await expect(balanceFrom(stats(sums(150_000, 50_000), sums(0, 100_000)))).resolves.toEqual({
      address: ADDR,
      confirmedSats: 100_000,
      mempoolSats: -100_000,
      totalSats: 0,
    })
  })
})

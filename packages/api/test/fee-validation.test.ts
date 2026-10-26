import { describe, expect, it } from 'vitest'

import {
  DEFAULT_MAX_FEE_RATE_SAT_VB,
  EsploraClient,
  MempoolQbitClient,
  QbitApiError,
  feeTiersFromEstimates,
} from '../src/index'

const BASE = 'https://esplora.example/regtest/api'
const noSleep = () => Promise.resolve()

/** Serve `body` verbatim for `path`, so tests control the exact JSON text. */
function fetchServing(path: string, body: string): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    const url = String(input)
    if (!url.endsWith(path)) throw new Error(`unexpected url ${url}`)
    return new Response(body, { status: 200 })
  }) as typeof fetch
}

function esploraFees(body: string): EsploraClient {
  return new EsploraClient({ baseUrl: BASE, fetchFn: fetchServing('/fee-estimates', body), sleepFn: noSleep })
}

function mempoolFees(body: string): MempoolQbitClient {
  return new MempoolQbitClient({
    baseUrl: BASE,
    fetchFn: fetchServing('/fees/recommended', body),
    sleepFn: noSleep,
  })
}

function recommended(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    fastestFee: 9,
    halfHourFee: 6,
    hourFee: 3,
    economyFee: 2,
    minimumFee: 1,
    ...overrides,
  })
}

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    value => {
      throw new Error(`expected rejection, got ${JSON.stringify(value)}`)
    },
    (error: unknown) => error
  )
}

async function expectParseError(promise: Promise<unknown>): Promise<void> {
  const error = await rejection(promise)
  expect(error).toBeInstanceOf(QbitApiError)
  expect(error).toMatchObject({ kind: 'parse' })
}

describe('fee-rate ceiling', () => {
  it('rejects an inflated esplora estimate instead of paying it', async () => {
    await expectParseError(esploraFees('{"1":100000,"6":100000}').getFeeTiers())
  })

  it('rejects an inflated mempool-qbit fastestFee', async () => {
    await expectParseError(mempoolFees(recommended({ fastestFee: 100000 })).getFeeTiers())
  })

  it('defaults to Core sendrawtransaction maxfeerate, 10,000 sat/vB', async () => {
    expect(DEFAULT_MAX_FEE_RATE_SAT_VB).toBe(10_000)
    await expect(esploraFees('{"1":10000,"6":4}').getFeeTiers()).resolves.toEqual([
      { target: 1, feeRate: 10_000 },
      { target: 6, feeRate: 4 },
    ])
    await expectParseError(esploraFees('{"1":10000.5,"6":4}').getFeeTiers())
  })

  it('accepts a caller-raised ceiling', () => {
    expect(feeTiersFromEstimates({ '1': 100_000 }, { maxFeeRate: 200_000 })).toEqual([
      { target: 1, feeRate: 100_000 },
    ])
    expect(() => feeTiersFromEstimates({ '1': 200_001 }, { maxFeeRate: 200_000 })).toThrow(QbitApiError)
  })

  it('accepts a caller-raised ceiling on the mempool-qbit path', async () => {
    const client = mempoolFees(recommended({ fastestFee: 15_000 }))
    await expectParseError(client.getFeeTiers())
    expect(feeTiersFromEstimates(await client.getFeeEstimates(), { maxFeeRate: 20_000 })).toEqual([
      { target: 1, feeRate: 15_000 },
      { target: 2, feeRate: 6 },
      { target: 3, feeRate: 3 },
    ])
  })

  it('applies a caller-lowered ceiling', () => {
    expect(() => feeTiersFromEstimates({ '1': 51 }, { maxFeeRate: 50 })).toThrow(QbitApiError)
    expect(feeTiersFromEstimates({ '1': 50 }, { maxFeeRate: 50 })).toEqual([{ target: 1, feeRate: 50 }])
  })

  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY, '10' as unknown as number])(
    'throws TypeError for maxFeeRate %s',
    maxFeeRate => {
      expect(() => feeTiersFromEstimates({ '1': 5 }, { maxFeeRate })).toThrow(TypeError)
    }
  )
})

describe('fee estimate shape', () => {
  it.each([
    ['target 0', '{"0":9}'],
    ['negative target', '{"-1":7}'],
    ['fractional target', '{"1.5":3}'],
    ['hex target', '{"0x10":1}'],
    ['empty target', '{"":2}'],
    ['leading-zero target', '{"06":4}'],
    ['exponent target', '{"1e3":4}'],
    ['padded target', '{" 6":4}'],
    ['target beyond Core horizon', '{"1009":1}'],
    ['zero rate', '{"1":0}'],
    ['negative rate', '{"1":-2}'],
    ['string rate', '{"1":"5"}'],
    ['null rate', '{"1":null}'],
    ['one bad entry among good ones', '{"1":12,"6":4,"0":9}'],
    ['array body', '[5,3]'],
    ['null body', 'null'],
    ['number body', '5'],
  ])('rejects %s as a parse error', async (_name, body) => {
    await expectParseError(esploraFees(body).getFeeTiers())
  })

  it.each([
    ['a 5,000-character key', '9'.repeat(5000)],
    ['a key with U+2028, U+202E and C1 controls', '1\u2028\u202e\u0085\u009b'],
  ])('keeps %s out of the parse error message', async (_name, key) => {
    const error = await rejection(esploraFees(`{"${key}":1}`).getFeeTiers())
    expect(error).toBeInstanceOf(QbitApiError)
    expect(error).toMatchObject({ kind: 'parse' })
    const { message } = error as QbitApiError
    expect(message).not.toContain(key)
    expect(message).not.toMatch(/[\u2028\u202e\u0080-\u009f]/)
    expect(message.length).toBeLessThan(200)
  })

  it('accepts targets 1 through 1008 and keeps ascending order', async () => {
    await expect(esploraFees('{"1008":1,"144":1.1,"1":12.5,"6":4}').getFeeTiers()).resolves.toEqual([
      { target: 1, feeRate: 12.5 },
      { target: 6, feeRate: 4 },
      { target: 144, feeRate: 1.1 },
      { target: 1008, feeRate: 1 },
    ])
  })

  it('still sorts valid estimates and returns [] for no estimates', () => {
    expect(feeTiersFromEstimates({ '6': 4, '1': 12.5, '144': 1.1 })).toEqual([
      { target: 1, feeRate: 12.5 },
      { target: 6, feeRate: 4 },
      { target: 144, feeRate: 1.1 },
    ])
    expect(feeTiersFromEstimates({})).toEqual([])
  })
})

describe('mempool-qbit recommended fees shape', () => {
  it.each([
    ['null body', 'null'],
    ['array body', '[9,6,3]'],
    ['zero fastestFee', recommended({ fastestFee: 0 })],
    ['string halfHourFee', recommended({ halfHourFee: '6' })],
    ['missing hourFee', recommended({ hourFee: undefined })],
  ])('rejects %s as a parse error', async (_name, body) => {
    const client = mempoolFees(body)
    await expectParseError(client.getFeeEstimates())
    await expectParseError(client.getFeeTiers())
  })

  it('does not require the unlabelled policy floors', async () => {
    const body = JSON.stringify({ fastestFee: 9.5, halfHourFee: 6, hourFee: 3 })
    await expect(mempoolFees(body).getFeeTiers()).resolves.toEqual([
      { target: 1, feeRate: 9.5 },
      { target: 2, feeRate: 6 },
      { target: 3, feeRate: 3 },
    ])
  })
})

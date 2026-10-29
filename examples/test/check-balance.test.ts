import { EsploraClient, QbitApiError } from '@qbit-oss/api'
import { describe, expect, it } from 'vitest'

import { checkBalance, walletFeeTiers, WALLET_MAX_FEE_RATE } from '../src/check-balance'
import { BASE_URL, stubEsplora } from './stub-esplora'

const ADDRESS = 'qbrt1zzasx2u2z7v9kn4q8e66r57mfw08xvrvdcqfcq6xfte0eau9dgdgqz42zd5'

describe('check-balance example', () => {
  it('reads the balance and the fee tiers', async () => {
    const esplora = stubEsplora({
      address: ADDRESS,
      confirmedSats: 150_000,
      mempoolSats: 2_500,
      feeEstimates: { '6': 2, '1': 12.5, '3': 5 },
    })

    const { balance, feeTiers } = await checkBalance(ADDRESS, esplora.fetchFn)

    expect(balance).toEqual({ address: ADDRESS, confirmedSats: 150_000, mempoolSats: 2_500, totalSats: 152_500 })
    expect(feeTiers).toEqual([
      { target: 1, feeRate: 12.5 },
      { target: 3, feeRate: 5 },
      { target: 6, feeRate: 2 },
    ])
    expect(esplora.requests).toEqual([`GET /address/${ADDRESS}`, 'GET /fee-estimates'])
  })

  it("refuses a rate above the wallet's ceiling that getFeeTiers lets through", async () => {
    const quote = { '1': 2_000, '6': 3 } // below Core's 10,000 sat/vB limit, above the wallet's own
    expect(quote['1']).toBeGreaterThan(WALLET_MAX_FEE_RATE)
    const { fetchFn } = stubEsplora({ address: ADDRESS, feeEstimates: quote })
    const client = new EsploraClient({ baseUrl: BASE_URL, fetchFn })

    await expect(client.getFeeTiers()).resolves.toEqual([
      { target: 1, feeRate: 2_000 },
      { target: 6, feeRate: 3 },
    ])
    const error = await walletFeeTiers(client).catch((caught: unknown) => caught)
    expect(QbitApiError.is(error) && error.kind).toBe('parse')
  })

  it('returns the tiers when every rate is under the ceiling', async () => {
    const { fetchFn } = stubEsplora({ address: ADDRESS, feeEstimates: { '2': 8, '1': 10 } })
    const client = new EsploraClient({ baseUrl: BASE_URL, fetchFn })

    await expect(walletFeeTiers(client)).resolves.toEqual([
      { target: 1, feeRate: 10 },
      { target: 2, feeRate: 8 },
    ])
  })
})

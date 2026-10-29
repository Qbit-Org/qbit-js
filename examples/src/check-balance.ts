// Read an address's balance and the fee rates to pay, with @qbit-oss/api.
//
// `fetchFn` exists so the tests can answer offline. In an app, leave it out
// and the client uses the global fetch.

import { EsploraClient, feeTiersFromEstimates, type AddressBalance, type FeeRateTier } from '@qbit-oss/api'

/** The highest fee rate this wallet will ever pay, in sat/vB. */
export const WALLET_MAX_FEE_RATE = 500

export async function checkBalance(
  address: string,
  fetchFn: typeof fetch
): Promise<{ balance: AddressBalance; feeTiers: FeeRateTier[] }> {
  const client = new EsploraClient({ baseUrl: 'https://esplora.example/regtest/api', fetchFn }) // fetchFn is optional
  const balance = await client.getAddressBalance(address) // { address, confirmedSats, mempoolSats, totalSats }
  const feeTiers = await client.getFeeTiers() // [{ target, feeRate }], ascending by confirmation target
  return { balance, feeTiers }
}

/**
 * Fee tiers capped at the wallet's own ceiling.
 *
 * `getFeeTiers` refuses only rates above qbit Core's default broadcast limit,
 * 10,000 sat/vB, so a broken or hostile backend can still quote 9,999. Passing
 * the estimates through `feeTiersFromEstimates` with a lower `maxFeeRate`
 * makes the call fail with a `parse` error instead of returning such a rate.
 */
export async function walletFeeTiers(client: EsploraClient): Promise<FeeRateTier[]> {
  return feeTiersFromEstimates(await client.getFeeEstimates(), { maxFeeRate: WALLET_MAX_FEE_RATE })
}

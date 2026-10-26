import { describe, expect, it } from 'vitest'

import { QBIT_COINBASE_MATURITY, QBIT_MAX_MONEY } from '../src/index'

describe('consensus constants', () => {
  it('pins coinbase maturity to the qbit Core consensus value', () => {
    // Drift alarm: must match src/consensus/consensus.h COINBASE_MATURITY in
    // the pinned qbit Core release. Wallets use this to exclude immature
    // coinbase outputs from spendable balances and coin selection.
    expect(QBIT_COINBASE_MATURITY).toBe(1000)
  })

  it('pins MAX_MONEY to the qbit Core consensus value', () => {
    // Drift alarm: must match src/consensus/amount.h MAX_MONEY = 210000000 * COIN
    // in the pinned qbit Core release. Every amount this package serializes,
    // parses, hashes or signs must satisfy MoneyRange (0 <= v <= MAX_MONEY).
    expect(QBIT_MAX_MONEY).toBe(210_000_000n * 100_000_000n)
    expect(QBIT_MAX_MONEY).toBe(21_000_000_000_000_000n)
  })
})

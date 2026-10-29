import { describe, expect, it } from 'vitest'

import fixture from '../fixtures/p2mr-sighash.json'
import {
  type P2mrSpentOutput,
  type P2mrTransaction,
  QbitProtocolError,
  SIGHASH_SINGLE,
  bytesToHex,
  hexToBytes,
  p2mrLeafHash,
  p2mrSighash,
  precomputeSighashMidstates,
  schnorrSignatureHash,
  singleKeyLeafScript,
} from '../src/index'

interface FixtureTx {
  version: number
  locktime: number
  inputs: { txid: string; vout: number; sequence: number }[]
  outputs: { valueSats: string; scriptPubKey: string }[]
  spentOutputs: { valueSats: string; scriptPubKey: string }[]
}

function toTransaction(tx: FixtureTx): P2mrTransaction {
  return {
    version: tx.version,
    locktime: tx.locktime,
    inputs: tx.inputs.map(input => ({
      prevout: { txid: hexToBytes(input.txid), vout: input.vout },
      sequence: input.sequence,
    })),
    outputs: tx.outputs.map(output => ({
      value: BigInt(output.valueSats),
      scriptPubKey: hexToBytes(output.scriptPubKey),
    })),
  }
}

function toSpentOutputs(tx: FixtureTx): P2mrSpentOutput[] {
  return tx.spentOutputs.map(output => ({
    value: BigInt(output.valueSats),
    scriptPubKey: hexToBytes(output.scriptPubKey),
  }))
}

// Provenance is asserted at fixture-generation time (see scripts/gen-sighash-fixtures.py):
// the framework reproduces Core's committed bip341 vectors, and our message copy
// reproduces the framework — so these vectors are byte-exact vs qbit consensus.
describe('schnorrSignatureHash vs Core bip341_wallet_vectors (shared machinery)', () => {
  const kp = fixture.bip341KeyPath as FixtureTx & {
    midstates: Record<'prevouts' | 'amounts' | 'scriptPubKeys' | 'sequences' | 'outputs', string>
    cases: { inputIndex: number; hashType: number; sigHash: string }[]
  }
  const tx = toTransaction(kp)
  const spent = toSpentOutputs(kp)

  it('precomputed midstates match Core intermediary values', () => {
    const m = precomputeSighashMidstates(tx, spent)
    expect(bytesToHex(m.prevouts)).toBe(kp.midstates.prevouts)
    expect(bytesToHex(m.amounts)).toBe(kp.midstates.amounts)
    expect(bytesToHex(m.scriptPubKeys)).toBe(kp.midstates.scriptPubKeys)
    expect(bytesToHex(m.sequences)).toBe(kp.midstates.sequences)
    expect(bytesToHex(m.outputs)).toBe(kp.midstates.outputs)
  })

  it.each(kp.cases)('TapSighash key-path input $inputIndex hashType $hashType matches Core', testCase => {
    const digest = schnorrSignatureHash({
      tx,
      inputIndex: testCase.inputIndex,
      spentOutputs: spent,
      hashType: testCase.hashType,
      sigVersion: 'taproot',
    })
    expect(bytesToHex(digest)).toBe(testCase.sigHash)
  })
})

describe('p2mrSighash vs P2MR-tag vectors', () => {
  const vectors = fixture.p2mr as {
    label: string
    tx: FixtureTx
    inputIndex: number
    hashType: number
    leaf: { pubkey: string; leafScript: string; leafVersion: number; leafHash: string }
    sigHash: string
  }[]

  it('covers single- and multi-input txs across all hash types', () => {
    expect(vectors.length).toBeGreaterThanOrEqual(13)
    expect(new Set(vectors.map(v => v.hashType)).size).toBe(7)
    expect(vectors.some(v => v.label.startsWith('two-input'))).toBe(true)
  })

  it('covers uint32 field extremes and amounts above 2^53', () => {
    const extremes = vectors.filter(v => v.label.startsWith('field-extremes'))
    expect(extremes).toHaveLength(14)
    const { tx } = extremes[0]!
    expect([tx.version, tx.locktime]).toEqual([0xffffffff, 0xffffffff])
    expect(tx.inputs.map(input => input.sequence)).toEqual(expect.arrayContaining([0, 0xffffffff]))
    expect(tx.inputs.some(input => input.vout === 0xffffffff)).toBe(true)
    expect([...tx.outputs, ...tx.spentOutputs].every(output => BigInt(output.valueSats) > 2n ** 53n)).toBe(true)
  })

  it.each(vectors)('$label hashType $hashType', vector => {
    const tx = toTransaction(vector.tx)
    const spent = toSpentOutputs(vector.tx)

    // The package reconstructs the same leaf script + leaf hash the fixture used.
    const leafScript = singleKeyLeafScript(hexToBytes(vector.leaf.pubkey))
    expect(bytesToHex(leafScript)).toBe(vector.leaf.leafScript)
    const leafHash = p2mrLeafHash(vector.leaf.leafVersion, leafScript)
    expect(bytesToHex(leafHash)).toBe(vector.leaf.leafHash)

    const digest = p2mrSighash({
      tx,
      inputIndex: vector.inputIndex,
      spentOutputs: spent,
      leafHash,
      hashType: vector.hashType,
    })
    expect(bytesToHex(digest)).toBe(vector.sigHash)
  })

  it('precomputed midstates produce identical digests to the per-call path', () => {
    const vector = vectors.find(v => v.label.startsWith('two-input'))!
    const tx = toTransaction(vector.tx)
    const spent = toSpentOutputs(vector.tx)
    const leafHash = hexToBytes(vector.leaf.leafHash)
    const midstates = precomputeSighashMidstates(tx, spent)

    const direct = p2mrSighash({
      tx,
      inputIndex: vector.inputIndex,
      spentOutputs: spent,
      leafHash,
      hashType: vector.hashType,
    })
    const cached = p2mrSighash({
      tx,
      inputIndex: vector.inputIndex,
      spentOutputs: spent,
      leafHash,
      hashType: vector.hashType,
      midstates,
    })
    expect(bytesToHex(cached)).toBe(bytesToHex(direct))
    expect(bytesToHex(direct)).toBe(vector.sigHash)
  })
})

describe('p2mrSighash edge cases', () => {
  const base = (fixture.p2mr as { tx: FixtureTx; leaf: { leafHash: string } }[])[0]!
  const tx = toTransaction(base.tx)
  const spent = toSpentOutputs(base.tx)
  const leafHash = hexToBytes(base.leaf.leafHash)

  it('rejects invalid sighash types', () => {
    expect(() => p2mrSighash({ tx, inputIndex: 0, spentOutputs: spent, leafHash, hashType: 0x04 })).toThrow(
      QbitProtocolError
    )
    expect(() => p2mrSighash({ tx, inputIndex: 0, spentOutputs: spent, leafHash, hashType: 0x80 })).toThrow(
      /invalid sighash type/
    )
  })

  it('rejects inputIndex out of range', () => {
    expect(() => p2mrSighash({ tx, inputIndex: 5, spentOutputs: spent, leafHash })).toThrow(/inputIndex/)
  })

  it('rejects spentOutputs length mismatch', () => {
    expect(() => p2mrSighash({ tx, inputIndex: 0, spentOutputs: [], leafHash })).toThrow(/length/)
  })

  it('requires a 32-byte leafHash', () => {
    expect(() => p2mrSighash({ tx, inputIndex: 0, spentOutputs: spent, leafHash: new Uint8Array(31) })).toThrow(
      /leafHash/
    )
  })

  it('rejects SIGHASH_SINGLE without a matching output', () => {
    const twoInOneOut: P2mrTransaction = {
      version: 2,
      locktime: 0,
      inputs: [
        { prevout: { txid: new Uint8Array(32), vout: 0 }, sequence: 0xffffffff },
        { prevout: { txid: new Uint8Array(32).fill(1), vout: 0 }, sequence: 0xffffffff },
      ],
      outputs: [{ value: 1000n, scriptPubKey: hexToBytes(`5220${'00'.repeat(32)}`) }],
    }
    const spentTwo: P2mrSpentOutput[] = [
      { value: 2000n, scriptPubKey: hexToBytes(`5220${'11'.repeat(32)}`) },
      { value: 3000n, scriptPubKey: hexToBytes(`5220${'22'.repeat(32)}`) },
    ]
    expect(() =>
      p2mrSighash({ tx: twoInOneOut, inputIndex: 1, spentOutputs: spentTwo, leafHash, hashType: SIGHASH_SINGLE })
    ).toThrow(/SINGLE/)
  })
})

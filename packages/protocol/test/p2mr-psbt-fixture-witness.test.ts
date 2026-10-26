import { describe, expect, it } from 'vitest'

import fixture from '../fixtures/p2mr-psbt.json'
import {
  P2MR_LEAF_VERSION_V1,
  PQC_SIGNATURE_BYTES,
  PSBT_IN_FINAL_SCRIPTWITNESS,
  bytesToHex,
  decodePsbt,
  extractP2mrTransaction,
  hexToBytes,
  p2mrLeafHash,
  p2mrScriptPubKey,
  parsePsbt,
  type PsbtKeyValue,
} from '../src/index'

// Regression test: input 1's final scriptwitness (0x08) in the
// Core-framework fixture must be a count-prefixed witness stack, which is how
// qbit Core v1.0.0 reads it (UnserializeFromVector, src/psbt.h:647-655).

/** Reads CompactSize-prefixed witness stacks, the encoding of a transaction's witness section. */
class WitnessReader {
  private offset = 0

  constructor(private readonly bytes: Uint8Array) {}

  get remaining(): number {
    return this.bytes.length - this.offset
  }

  private take(length: number): Uint8Array {
    if (length > this.remaining) throw new Error('witness section ends early')
    const out = this.bytes.subarray(this.offset, this.offset + length)
    this.offset += length
    return out
  }

  private compactSize(): number {
    const first = this.take(1)[0]!
    if (first < 0xfd) return first
    if (first === 0xfd) {
      const [lo, hi] = this.take(2)
      return lo! | (hi! << 8)
    }
    throw new Error('witness test reader handles CompactSize values up to 0xffff only')
  }

  stack(): Uint8Array[] {
    const count = this.compactSize()
    return Array.from({ length: count }, () => this.take(this.compactSize()))
  }
}

function isFinalWitness(entry: PsbtKeyValue): boolean {
  return entry.key.length === 1 && entry.key[0] === PSBT_IN_FINAL_SCRIPTWITNESS
}

describe('p2mr-psbt.json final scriptwitness', () => {
  it("extracts input 1's witness as [signature, leaf script, control block]", () => {
    const psbt = parsePsbt(hexToBytes(fixture.psbtHex))
    const finalWitness = psbt.inputs[1]!.find(isFinalWitness)
    expect(finalWitness).toBeDefined()
    // Input 0 is not finalized; give it input 1's witness so the transaction can be extracted.
    psbt.inputs[0] = [...psbt.inputs[0]!, finalWitness!]

    const rawTx = extractP2mrTransaction(psbt)

    // version || 00 01 || unsigned body || witnesses || locktime
    const unsigned = hexToBytes(fixture.unsignedTx.hex)
    const body = unsigned.subarray(4, unsigned.length - 4)
    expect(bytesToHex(rawTx.subarray(0, 4))).toBe(bytesToHex(unsigned.subarray(0, 4)))
    expect(bytesToHex(rawTx.subarray(4, 6))).toBe('0001')
    expect(bytesToHex(rawTx.subarray(6, 6 + body.length))).toBe(bytesToHex(body))
    expect(bytesToHex(rawTx.subarray(rawTx.length - 4))).toBe(bytesToHex(unsigned.subarray(unsigned.length - 4)))

    const reader = new WitnessReader(rawTx.subarray(6 + body.length, rawTx.length - 4))
    const witnesses = [reader.stack(), reader.stack()]
    expect(reader.remaining).toBe(0)

    // The generator's input-1 values (packages/protocol/scripts/gen-psbt-fixtures.py).
    const signature = new Uint8Array(PQC_SIGNATURE_BYTES).map((_, i) => i & 0xff)
    const pk1 = Uint8Array.from({ length: 32 }, (_, i) => (i * 5 + 9) & 0xff)
    const leafScript = Uint8Array.of(0x20, ...pk1, 0xb3) // push32 pk1, OP_CHECKSIGPQC
    const controlBlock = Uint8Array.of(P2MR_LEAF_VERSION_V1 | 1)
    const expected = [signature, leafScript, controlBlock].map(bytesToHex)
    expect(witnesses[0]!.map(bytesToHex)).toEqual(expected)
    expect(witnesses[1]!.map(bytesToHex)).toEqual(expected)

    // The witness spends input 1's UTXO: a single-leaf tree whose root is that leaf.
    const witnessUtxo = decodePsbt(psbt).inputs[1]!.witnessUtxo!
    expect(bytesToHex(witnessUtxo.scriptPubKey)).toBe(
      bytesToHex(p2mrScriptPubKey(p2mrLeafHash(P2MR_LEAF_VERSION_V1, leafScript)))
    )
  })
})

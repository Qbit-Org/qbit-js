import { describe, expect, it } from 'vitest'

import fixture from '../fixtures/p2mr-psbt.json'
import {
  PSBT_IN_P2MR_SCRIPT_SIG,
  PSBT_IN_WITNESS_UTXO,
  QbitProtocolError,
  bytesToHex,
  combinePsbts,
  decodePsbt,
  hexToBytes,
  parsePsbt,
  psbtUnsignedTransaction,
  serializePsbt,
} from '../src/index'

const PSBT_BYTES = hexToBytes(fixture.psbtHex)
const expected = fixture.expected

describe('PSBT container (BIP174 v0, qbit-aware)', () => {
  it('round-trips a framework-generated qbit PSBT byte-for-byte', () => {
    const reserialized = serializePsbt(parsePsbt(PSBT_BYTES))
    expect(bytesToHex(reserialized)).toBe(fixture.psbtHex)
  })

  it('preserves unknown and qbit fields across the round-trip', () => {
    const psbt = parsePsbt(PSBT_BYTES)
    // input 1 carries an unknown 0x77 field that must survive serialization.
    expect(psbt.inputs[1]!.some(entry => entry.key.length === 1 && entry.key[0] === 0x77)).toBe(true)
    // input 0 carries the 0x19 P2MR script sig.
    expect(psbt.inputs[0]!.some(entry => entry.key[0] === PSBT_IN_P2MR_SCRIPT_SIG)).toBe(true)
  })

  it('reads the unsigned transaction', () => {
    const tx = psbtUnsignedTransaction(parsePsbt(PSBT_BYTES))
    expect(tx.version).toBe(expected.version)
    expect(tx.locktime).toBe(expected.locktime)
    expect(tx.inputs.length).toBe(expected.inputCount)
    expect(tx.outputs.length).toBe(expected.outputCount)
  })

  it('decodes a human-readable summary with the qbit fields and fee', () => {
    const summary = decodePsbt(parsePsbt(PSBT_BYTES))
    expect(summary.version).toBe(expected.version)
    expect(summary.fee).toBe(BigInt(expected.fee))

    const [in0, in1] = summary.inputs
    expect(in0!.witnessUtxo?.value).toBe(BigInt(expected.inputs[0]!.witnessValue))
    expect(in0!.leafScripts.length).toBe(expected.inputs[0]!.leafScripts)
    expect(in0!.scriptSigs.length).toBe(expected.inputs[0]!.scriptSigs)
    expect(bytesToHex(in0!.merkleRoot!)).toBe(expected.inputs[0]!.merkleRoot)
    expect(bytesToHex(in0!.scriptSigs[0]!.pubkey)).toBe(expected.inputs[0]!.scriptSigPubkey)
    expect(bytesToHex(in0!.scriptSigs[0]!.leafHash)).toBe(expected.inputs[0]!.scriptSigLeafHash)
    expect(in0!.finalized).toBe(false)

    expect(in1!.witnessUtxo?.value).toBe(BigInt(expected.inputs[1]!.witnessValue))
    expect(in1!.finalized).toBe(true)
  })
})

describe('combinePsbts', () => {
  it('merges a partial PSBT (missing a script sig) with a complete one', () => {
    const complete = parsePsbt(PSBT_BYTES)
    const partial = parsePsbt(PSBT_BYTES)
    partial.inputs[0] = partial.inputs[0]!.filter(entry => entry.key[0] !== PSBT_IN_P2MR_SCRIPT_SIG)
    expect(decodePsbt(partial).inputs[0]!.scriptSigs.length).toBe(0)

    const combined = combinePsbts([partial, complete])
    expect(decodePsbt(combined).inputs[0]!.scriptSigs.length).toBe(1)
    // combining is order-independent and idempotent on identical inputs
    expect(bytesToHex(serializePsbt(combinePsbts([complete, complete])))).toBe(fixture.psbtHex)
  })

  it('rejects conflicting values for the same key', () => {
    const a = parsePsbt(PSBT_BYTES)
    const b = parsePsbt(PSBT_BYTES)
    const witnessEntry = b.inputs[0]!.find(entry => entry.key.length === 1 && entry.key[0] === PSBT_IN_WITNESS_UTXO)!
    witnessEntry.value = witnessEntry.value.slice()
    witnessEntry.value[0]! ^= 0xff
    expect(() => combinePsbts([a, b])).toThrow(/conflicting/)
  })

  it('rejects combining PSBTs with different unsigned transactions', () => {
    const a = parsePsbt(PSBT_BYTES)
    const b = parsePsbt(PSBT_BYTES)
    const txEntry = b.global.find(entry => entry.key.length === 1 && entry.key[0] === 0x00)!
    txEntry.value = txEntry.value.slice()
    txEntry.value[4]! ^= 0xff // perturb the unsigned tx bytes
    expect(() => combinePsbts([a, b])).toThrow(/different unsigned transactions/)
  })
})

describe('PSBT parsing rejects malformed input', () => {
  it('rejects bad magic', () => {
    expect(() => parsePsbt(Uint8Array.of(1, 2, 3, 4, 5))).toThrow(/magic/)
  })

  it('rejects trailing data', () => {
    expect(() => parsePsbt(hexToBytes(`${fixture.psbtHex}ff`))).toThrow(QbitProtocolError)
  })

  it('rejects a PSBT with no unsigned transaction', () => {
    // magic + empty global map (single 0x00 terminator) + nothing else
    expect(() => parsePsbt(Uint8Array.of(0x70, 0x73, 0x62, 0x74, 0xff, 0x00))).toThrow(/unsigned transaction/)
  })
})

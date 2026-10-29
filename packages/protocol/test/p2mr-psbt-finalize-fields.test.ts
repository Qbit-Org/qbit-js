import { sha256 } from '@noble/hashes/sha2'
import { describe, expect, it } from 'vitest'

import {
  P2MR_LEAF_VERSION_V1,
  PQC_SIGNATURE_BYTES,
  PSBT_GLOBAL_UNSIGNED_TX,
  PSBT_IN_FINAL_SCRIPTWITNESS,
  PSBT_IN_P2MR_LEAF_SCRIPT,
  PSBT_IN_P2MR_SCRIPT_SIG,
  PSBT_IN_PROPRIETARY,
  PSBT_IN_WITNESS_UTXO,
  buildControlBlock,
  bytesToHex,
  createP2mrPsbt,
  decodePsbt,
  encodeQbitProprietaryP2mrLeafScriptField,
  encodeQbitProprietaryP2mrScriptSigField,
  extractP2mrTransaction,
  finalizeP2mrPsbt,
  p2mrLeafHash,
  p2mrScriptPubKey,
  parsePsbt,
  serializePsbt,
  signP2mrPsbt,
  singleKeyLeafScript,
  type EncodedQbitProprietaryP2mrField,
  type Psbt,
  type PsbtKeyValue,
} from '../src/index'

const pubkey = Uint8Array.from({ length: 32 }, (_, i) => (i * 7 + 1) & 0xff)
const leafScript = singleKeyLeafScript(pubkey)
const leafHash = p2mrLeafHash(P2MR_LEAF_VERSION_V1, leafScript)
const controlBlock = buildControlBlock(P2MR_LEAF_VERSION_V1, [])
const scriptPubKey = p2mrScriptPubKey(leafHash)
const keys = [{ inputIndex: 0, pubkey, leafHash }]

function unsignedTxBytes(psbt: Psbt): Uint8Array {
  return psbt.global.find(entry => entry.key.length === 1 && entry.key[0] === PSBT_GLOBAL_UNSIGNED_TX)!.value
}

// The previous transaction, so the 0x00 non-witness UTXO is one Core would accept:
// a no-witness serialization whose txid (sha256d) is the spending input's prevout.
const previousTx = unsignedTxBytes(
  createP2mrPsbt({
    inputs: [
      {
        prevout: { txid: new Uint8Array(32).fill(7), vout: 0 },
        witnessUtxo: { value: 200_000n, scriptPubKey },
        leafScript,
        controlBlock,
      },
    ],
    outputs: [{ value: 100_000n, scriptPubKey }],
  })
)

function unsignedPsbt(): Psbt {
  return createP2mrPsbt({
    inputs: [
      {
        prevout: { txid: sha256(sha256(previousTx)), vout: 0 },
        witnessUtxo: { value: 100_000n, scriptPubKey },
        leafScript,
        controlBlock,
        merkleRoot: leafHash,
      },
    ],
    outputs: [{ value: 90_000n, scriptPubKey }],
  })
}

function signAndFinalize(psbt: Psbt): Psbt {
  const { psbt: signed } = signP2mrPsbt({
    psbt,
    keys,
    sign: () => Uint8Array.from({ length: PQC_SIGNATURE_BYTES }, (_, i) => (i * 5) & 0xff),
  })
  return finalizeP2mrPsbt(signed)
}

const keyHexes = (map: readonly PsbtKeyValue[]): string[] => map.map(entry => bytesToHex(entry.key))
const nonWitnessUtxo: PsbtKeyValue = { key: Uint8Array.of(0x00), value: previousTx }
const foreignProprietary: PsbtKeyValue = {
  key: Uint8Array.of(PSBT_IN_PROPRIETARY, 0x03, 0x61, 0x62, 0x63, 0x01), // fc 03 'abc' 01
  value: Uint8Array.of(0xde, 0xad),
}
const unknownField: PsbtKeyValue = { key: Uint8Array.of(0xf0), value: Uint8Array.of(0xbe, 0xef) }

describe('finalizeP2mrPsbt keeps the input fields Core keeps', () => {
  it('keeps the UTXOs, proprietary and unknown records and drops the partial P2MR fields', () => {
    const psbt = unsignedPsbt()
    psbt.inputs[0]!.unshift(nonWitnessUtxo)
    psbt.inputs[0]!.push(foreignProprietary, unknownField)
    // createP2mrPsbt's merkle root is the qbit proprietary subtype 01: fc 04 'qbit' 01.
    expect(keyHexes(psbt.inputs[0]!)).toContain('fc047162697401')

    const { psbt: signed } = signP2mrPsbt({
      psbt,
      keys,
      sign: () => Uint8Array.from({ length: PQC_SIGNATURE_BYTES }, (_, i) => (i * 5) & 0xff),
    })
    expect(keyHexes(signed.inputs[0]!).map(key => key.slice(0, 2))).toEqual(['00', '01', '1d', 'fc', 'fc', 'f0', '19'])

    const finalized = finalizeP2mrPsbt(signed)
    const [utxo, witnessUtxo, proprietary, unknown, finalWitness] = finalized.inputs[0]!
    expect(keyHexes(finalized.inputs[0]!)).toEqual(['00', '01', 'fc0361626301', 'f0', '08'])
    expect(bytesToHex(utxo!.value)).toBe(bytesToHex(previousTx))
    expect(witnessUtxo!.key[0]).toBe(PSBT_IN_WITNESS_UTXO)
    expect(bytesToHex(proprietary!.value)).toBe('dead')
    expect(bytesToHex(unknown!.value)).toBe('beef')
    expect(finalWitness!.key[0]).toBe(PSBT_IN_FINAL_SCRIPTWITNESS)

    const bytes = serializePsbt(finalized)
    const reparsed = parsePsbt(bytes)
    expect(bytesToHex(serializePsbt(reparsed))).toBe(bytesToHex(bytes))
    const input = decodePsbt(reparsed).inputs[0]!
    expect(input.finalized).toBe(true)
    expect(input.witnessUtxo?.value).toBe(100_000n)
    expect(input.merkleRoot).toBeUndefined()
    expect(input.leafScripts).toHaveLength(0)
    expect(input.scriptSigs).toHaveLength(0)
    expect(bytesToHex(extractP2mrTransaction(reparsed))).toBe(bytesToHex(extractP2mrTransaction(finalized)))
  })

  it('drops the leaf script and signature carried as qbit subtypes 02 and 03', () => {
    const signature = Uint8Array.from({ length: PQC_SIGNATURE_BYTES }, (_, i) => (i * 5) & 0xff)
    const qbitEntry = (field: EncodedQbitProprietaryP2mrField): PsbtKeyValue => ({
      // fc 04 'qbit' <subtype> <key data>
      key: Uint8Array.of(PSBT_IN_PROPRIETARY, 0x04, 0x71, 0x62, 0x69, 0x74, field.subtype, ...field.keyData),
      value: field.value,
    })
    const psbt = unsignedPsbt()
    psbt.inputs[0] = [
      ...psbt.inputs[0]!.filter(entry => entry.key[0] !== PSBT_IN_P2MR_LEAF_SCRIPT),
      qbitEntry(encodeQbitProprietaryP2mrLeafScriptField(controlBlock, leafScript)),
      qbitEntry(encodeQbitProprietaryP2mrScriptSigField(pubkey, leafHash, signature)),
    ]
    expect(keyHexes(psbt.inputs[0]!).map(key => key.slice(0, 14))).toEqual([
      '01',
      'fc047162697401',
      'fc047162697402',
      'fc047162697403',
    ])

    const finalized = finalizeP2mrPsbt(psbt)
    expect(keyHexes(finalized.inputs[0]!)).toEqual(['01', '08'])
    expect(bytesToHex(extractP2mrTransaction(finalized))).toBe(
      bytesToHex(extractP2mrTransaction(signAndFinalize(unsignedPsbt())))
    )
  })

  it('drops exactly the key types Core omits from a finalized input', () => {
    // 0x19 and 0x1d (and qbit subtypes 01-03) are covered by the tests above. 0x07 is an empty
    // final scriptSig, which Core omits (psbt.h:503-507); a non-empty one throws (tested below).
    const dropped = [
      0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x0a, 0x0b, 0x0c, 0x0d, 0x13, 0x14, 0x15, 0x16, 0x17, 0x18, 0x1a, 0x1b, 0x1c,
    ]
    const kept = [0x09, 0x0e, 0x0f, 0x10, 0x11, 0x12, 0x1e, 0x1f, 0x20, 0xfb]
    // Core requires a bare type byte for these keys; the others carry key data.
    const singleByteKeyTypes = new Set([0x03, 0x04, 0x05, 0x07, 0x13, 0x17, 0x18])
    const field = (keyType: number): PsbtKeyValue => ({
      key: singleByteKeyTypes.has(keyType) ? Uint8Array.of(keyType) : Uint8Array.of(keyType, 0xaa),
      // 0x03 holds a 4-byte SIGHASH_DEFAULT, matching the signature below.
      value: keyType === 0x03 ? new Uint8Array(4) : keyType === 0x07 ? new Uint8Array() : Uint8Array.of(keyType),
    })
    const psbt = unsignedPsbt()
    psbt.inputs[0]!.push(...dropped.map(field), ...kept.map(field))

    const finalized = signAndFinalize(psbt)
    const finalKeys = keyHexes(finalized.inputs[0]!)
    expect(finalKeys).toEqual([
      bytesToHex(Uint8Array.of(PSBT_IN_WITNESS_UTXO)),
      ...kept.map(keyType => bytesToHex(field(keyType).key)),
      bytesToHex(Uint8Array.of(PSBT_IN_FINAL_SCRIPTWITNESS)),
    ])
    for (const keyType of [...dropped, PSBT_IN_P2MR_SCRIPT_SIG, PSBT_IN_P2MR_LEAF_SCRIPT]) {
      expect(finalKeys.some(key => key.startsWith(bytesToHex(Uint8Array.of(keyType))))).toBe(false)
    }
  })

  it('refuses to finalize an input that carries a non-empty final scriptSig', () => {
    // Core would treat the input as already final (psbt.cpp:345-348), and a P2MR spend with a
    // scriptSig fails verification (interpreter.cpp:2459-2461).
    const psbt = unsignedPsbt()
    psbt.inputs[0]!.push({ key: Uint8Array.of(0x07), value: Uint8Array.of(0x51) })
    expect(() => signAndFinalize(psbt)).toThrow(
      expect.objectContaining({
        code: 'INVALID_PSBT',
        message: 'input 0: a P2MR input cannot carry a final scriptSig',
      })
    )
  })

  it('leaves an already-finalized input untouched', () => {
    const finalized = signAndFinalize(unsignedPsbt())
    finalized.inputs[0]!.push(unknownField)
    const again = finalizeP2mrPsbt(finalized)
    expect(bytesToHex(serializePsbt(again))).toBe(bytesToHex(serializePsbt(finalized)))
  })
})

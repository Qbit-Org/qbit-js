import { describe, expect, it } from 'vitest'

import {
  P2MR_LEAF_VERSION_V1,
  PQC_SIGNATURE_BYTES,
  PSBT_IN_P2MR_LEAF_SCRIPT,
  PSBT_IN_P2MR_SCRIPT_SIG,
  PSBT_QBIT_IN_P2MR_LEAF_SCRIPT,
  PSBT_QBIT_IN_P2MR_MERKLE_ROOT,
  PSBT_QBIT_IN_P2MR_SCRIPT_SIG,
  QbitProtocolError,
  SIGHASH_ALL,
  SIGHASH_ANYONECANPAY,
  SIGHASH_DEFAULT,
  decodeP2mrPsbtLeafScriptField,
  decodeP2mrPsbtScriptSigField,
  decodeP2mrWitnessSignature,
  decodeQbitProprietaryP2mrInputField,
  encodeQbitProprietaryP2mrLeafScriptField,
  encodeQbitProprietaryP2mrMerkleRootField,
  encodeQbitProprietaryP2mrScriptSigField,
  encodeP2mrPsbtLeafScriptField,
  encodeP2mrPsbtScriptSigField,
  encodeP2mrWitnessSignature,
  hexToBytes,
  isValidP2mrSighashType,
  singleKeyLeafScript,
} from '../src/index'

const PUBKEY = hexToBytes('11'.repeat(32))
const LEAF_HASH = hexToBytes('22'.repeat(32))
const CONTROL_BLOCK = Uint8Array.of(P2MR_LEAF_VERSION_V1 | 1)
const SIGNATURE = new Uint8Array(PQC_SIGNATURE_BYTES).fill(0x33)

describe('P2MR PSBT field codecs', () => {
  it('encodes and decodes witness signatures with default and explicit sighash types', () => {
    const defaultItem = encodeP2mrWitnessSignature(SIGNATURE)
    const explicitItem = encodeP2mrWitnessSignature(SIGNATURE, SIGHASH_ANYONECANPAY | SIGHASH_ALL)

    expect(defaultItem).toHaveLength(PQC_SIGNATURE_BYTES)
    expect(decodeP2mrWitnessSignature(defaultItem)).toMatchObject({
      hashType: SIGHASH_DEFAULT,
      explicitHashType: false,
    })
    expect(explicitItem).toHaveLength(PQC_SIGNATURE_BYTES + 1)
    expect(decodeP2mrWitnessSignature(explicitItem)).toMatchObject({
      hashType: SIGHASH_ANYONECANPAY | SIGHASH_ALL,
      explicitHashType: true,
    })
    expect(isValidP2mrSighashType(0x04)).toBe(false)
    expect(() => decodeP2mrWitnessSignature(Uint8Array.of(...SIGNATURE, 0))).toThrow(QbitProtocolError)
  })

  it('encodes and decodes standard P2MR script signature fields', () => {
    const field = encodeP2mrPsbtScriptSigField(PUBKEY, LEAF_HASH, SIGNATURE, SIGHASH_ALL)
    const decoded = decodeP2mrPsbtScriptSigField(field.key, field.value)

    expect(field.key[0]).toBe(PSBT_IN_P2MR_SCRIPT_SIG)
    expect(field.key).toHaveLength(65)
    expect(decoded.type).toBe('p2mrScriptSig')
    expect(decoded.pubkey).toEqual(PUBKEY)
    expect(decoded.leafHash).toEqual(LEAF_HASH)
    expect(decoded.signature.hashType).toBe(SIGHASH_ALL)
  })

  it('encodes and decodes standard P2MR leaf script fields', () => {
    const script = singleKeyLeafScript(PUBKEY)
    const field = encodeP2mrPsbtLeafScriptField(CONTROL_BLOCK, script)
    const decoded = decodeP2mrPsbtLeafScriptField(field.key, field.value)

    expect(field.key[0]).toBe(PSBT_IN_P2MR_LEAF_SCRIPT)
    expect(decoded.type).toBe('p2mrLeafScript')
    expect(decoded.controlBlock).toEqual(CONTROL_BLOCK)
    expect(decoded.script).toEqual(script)
    expect(decoded.leafVersion).toBe(P2MR_LEAF_VERSION_V1)
  })

  it('allows Core-compatible empty P2MR leaf script values', () => {
    const field = encodeP2mrPsbtLeafScriptField(CONTROL_BLOCK, new Uint8Array())
    const decoded = decodeP2mrPsbtLeafScriptField(field.key, field.value)

    expect(field.value).toEqual(Uint8Array.of(P2MR_LEAF_VERSION_V1))
    expect(decoded.script).toEqual(new Uint8Array())
    expect(decoded.leafVersion).toBe(P2MR_LEAF_VERSION_V1)
  })

  it('decodes qbit proprietary P2MR fields with the same validation rules', () => {
    const script = singleKeyLeafScript(PUBKEY)
    const rootField = encodeQbitProprietaryP2mrMerkleRootField(LEAF_HASH)
    const scriptSig = encodeQbitProprietaryP2mrScriptSigField(PUBKEY, LEAF_HASH, SIGNATURE)
    const leafScript = encodeQbitProprietaryP2mrLeafScriptField(CONTROL_BLOCK, script)

    expect(decodeQbitProprietaryP2mrInputField(rootField.subtype, rootField.keyData, rootField.value)).toMatchObject({
      type: 'qbitP2mrMerkleRoot',
    })
    expect(decodeQbitProprietaryP2mrInputField(scriptSig.subtype, scriptSig.keyData, scriptSig.value)).toMatchObject({
      type: 'p2mrScriptSig',
    })
    expect(decodeQbitProprietaryP2mrInputField(leafScript.subtype, leafScript.keyData, leafScript.value)).toMatchObject(
      { type: 'p2mrLeafScript' }
    )
  })

  it('rejects malformed Core P2MR PSBT field shapes', () => {
    expect(() => decodeP2mrPsbtScriptSigField(Uint8Array.of(PSBT_IN_P2MR_SCRIPT_SIG, ...PUBKEY), SIGNATURE)).toThrow(
      QbitProtocolError
    )
    expect(() =>
      decodeP2mrPsbtLeafScriptField(Uint8Array.of(PSBT_IN_P2MR_LEAF_SCRIPT, P2MR_LEAF_VERSION_V1), Uint8Array.of(0xc0))
    ).toThrow(QbitProtocolError)
    expect(() =>
      decodeQbitProprietaryP2mrInputField(PSBT_QBIT_IN_P2MR_MERKLE_ROOT, Uint8Array.of(0), LEAF_HASH)
    ).toThrow(QbitProtocolError)
  })
})

import { describe, expect, it, vi } from 'vitest'

import fixture from '../fixtures/p2mr-psbt.json'
import {
  P2MR_LEAF_VERSION_V1,
  PQC_SIGNATURE_BYTES,
  PSBT_IN_PROPRIETARY,
  PSBT_IN_WITNESS_UTXO,
  PSBT_QBIT_IN_P2MR_MERKLE_ROOT,
  QbitProtocolError,
  buildControlBlock,
  bytesToHex,
  createP2mrPsbt,
  decodePsbt,
  decodeQbitProprietaryP2mrInputField,
  finalizeP2mrPsbt,
  hexToBytes,
  p2mrLeafHash,
  p2mrScriptPubKey,
  parsePsbt,
  serializePsbt,
  signP2mrPsbt,
  singleKeyLeafScript,
  validateP2mrSigningPlans,
  type Psbt,
  type PsbtKeyValue,
} from '../src/index'

const pubkey = Uint8Array.from({ length: 32 }, (_, i) => (i * 7 + 1) & 0xff)
const leafScript = singleKeyLeafScript(pubkey)
const leafHash = p2mrLeafHash(P2MR_LEAF_VERSION_V1, leafScript)
const controlBlock = buildControlBlock(P2MR_LEAF_VERSION_V1, [])
const scriptPubKey = p2mrScriptPubKey(leafHash)
const keys = [{ inputIndex: 0, pubkey, leafHash }]

function makePsbt(witnessValue: bigint, inputCount = 1): Psbt {
  return createP2mrPsbt({
    inputs: Array.from({ length: inputCount }, (_, vout) => ({
      prevout: { txid: new Uint8Array(32).fill(9), vout },
      witnessUtxo: { value: witnessValue, scriptPubKey },
      leafScript,
      controlBlock,
      merkleRoot: leafHash,
    })),
    outputs: [{ value: 90_000n, scriptPubKey }],
  })
}

function witnessUtxoEntry(psbt: Psbt): PsbtKeyValue {
  return psbt.inputs[0]!.find(entry => entry.key.length === 1 && entry.key[0] === PSBT_IN_WITNESS_UTXO)!
}

/** `fc 04 'qbit' <subtype> <keyData>`. */
function qbitKey(subtype: number, keyData: Uint8Array = new Uint8Array()): Uint8Array {
  return Uint8Array.of(PSBT_IN_PROPRIETARY, 0x04, 0x71, 0x62, 0x69, 0x74, subtype, ...keyData)
}

function expectInvalidPsbt(run: () => unknown, message: RegExp): void {
  try {
    run()
  } catch (error) {
    expect(error).toBeInstanceOf(QbitProtocolError)
    expect((error as QbitProtocolError).code).toBe('INVALID_PSBT')
    expect((error as Error).message).toMatch(message)
    return
  }
  throw new Error('expected an INVALID_PSBT error')
}

describe('decodePsbt rejects in-memory maps that parsePsbt would refuse', () => {
  // The sighash commits to the first 0x01 entry; before the shape check,
  // decodePsbt (and so the approval UI and fee) showed the last one.
  function duplicateWitnessUtxoPsbt(): Psbt {
    const psbt = makePsbt(5_000_000n)
    psbt.inputs[0]!.push(witnessUtxoEntry(makePsbt(100_000n)))
    return psbt
  }

  it('rejects two witness-UTXO entries on one input in decode, validate and sign', () => {
    const psbt = duplicateWitnessUtxoPsbt()
    expectInvalidPsbt(() => decodePsbt(psbt), /duplicate key in PSBT map/)
    expectInvalidPsbt(() => validateP2mrSigningPlans({ psbt, keys }), /duplicate key in PSBT map/)

    const signer = vi.fn(() => new Uint8Array(PQC_SIGNATURE_BYTES))
    expectInvalidPsbt(() => signP2mrPsbt({ psbt, keys, sign: signer }), /duplicate key in PSBT map/)
    expect(signer).not.toHaveBeenCalled()
  })

  it('rejects a duplicate witness UTXO added after signing in finalize', () => {
    const { psbt: signed } = signP2mrPsbt({
      psbt: makePsbt(5_000_000n),
      keys,
      sign: () => new Uint8Array(PQC_SIGNATURE_BYTES),
    })
    signed.inputs[0]!.push(witnessUtxoEntry(makePsbt(100_000n)))
    expectInvalidPsbt(() => finalizeP2mrPsbt(signed), /duplicate key in PSBT map/)
  })

  it('rejects a repeated key even when both values are identical', () => {
    const psbt = makePsbt(100_000n)
    psbt.inputs[0]!.push(witnessUtxoEntry(psbt))
    expectInvalidPsbt(() => decodePsbt(psbt), /duplicate key in PSBT map/)
  })

  it('rejects a repeated key in the global and output maps', () => {
    const unknown = { key: Uint8Array.of(0xf0), value: Uint8Array.of(1) }

    const global = makePsbt(100_000n)
    global.global.push(unknown, { ...unknown, value: Uint8Array.of(2) })
    expectInvalidPsbt(() => decodePsbt(global), /duplicate key in PSBT map/)

    const output = makePsbt(100_000n)
    output.outputs[0]!.push(unknown, unknown)
    expectInvalidPsbt(() => decodePsbt(output), /duplicate key in PSBT map/)
  })

  it('rejects input or output map counts that do not match the unsigned transaction', () => {
    const tooFewInputs = makePsbt(100_000n, 2)
    tooFewInputs.inputs.pop()
    expectInvalidPsbt(() => decodePsbt(tooFewInputs), /input map count/)

    const tooManyInputs = makePsbt(100_000n)
    tooManyInputs.inputs.push([])
    expectInvalidPsbt(() => decodePsbt(tooManyInputs), /input map count/)
    // Reported ahead of the extra map's missing witness UTXO.
    expectInvalidPsbt(() => validateP2mrSigningPlans({ psbt: tooManyInputs, keys }), /input map count/)

    const tooFewOutputs = makePsbt(100_000n)
    tooFewOutputs.outputs.pop()
    expectInvalidPsbt(() => decodePsbt(tooFewOutputs), /output map count/)

    const tooManyOutputs = makePsbt(100_000n)
    tooManyOutputs.outputs.push([])
    expectInvalidPsbt(() => decodePsbt(tooManyOutputs), /output map count/)
  })

  it('rejects an empty key, which serializePsbt would write as a map separator', () => {
    const empty: PsbtKeyValue = { key: new Uint8Array(), value: Uint8Array.of(1) }
    const addEmptyKey = [
      (psbt: Psbt) => psbt.global.push(empty),
      (psbt: Psbt) => psbt.inputs[0]!.push(empty),
      (psbt: Psbt) => psbt.outputs[0]!.push(empty),
    ]
    for (const add of addEmptyKey) {
      const psbt = makePsbt(100_000n)
      add(psbt)
      expectInvalidPsbt(() => decodePsbt(psbt), /empty key in PSBT map/)
      expectInvalidPsbt(() => validateP2mrSigningPlans({ psbt, keys }), /empty key in PSBT map/)

      const signer = vi.fn(() => new Uint8Array(PQC_SIGNATURE_BYTES))
      expectInvalidPsbt(() => signP2mrPsbt({ psbt, keys, sign: signer }), /empty key in PSBT map/)
      expect(signer).not.toHaveBeenCalled()
      expectInvalidPsbt(() => serializePsbt(psbt), /empty key in PSBT map/)
    }
  })
})

describe('decodePsbt keeps unknown qbit proprietary subtypes, as Core does', () => {
  it('decodes, validates, signs and round-trips an input with an unknown qbit subtype', () => {
    const psbt = makePsbt(100_000n)
    const unknownSubtypes: PsbtKeyValue[] = [
      { key: qbitKey(0x04), value: Uint8Array.of(0x01, 0x02, 0x03) },
      { key: qbitKey(0x00, Uint8Array.of(0xaa)), value: Uint8Array.of(0x04) },
    ]
    psbt.inputs[0]!.push(...unknownSubtypes)

    const input = decodePsbt(psbt).inputs[0]!
    expect(input.leafScripts).toHaveLength(1)
    expect(input.scriptSigs).toHaveLength(0)
    expect(bytesToHex(input.merkleRoot!)).toBe(bytesToHex(leafHash))

    expect(() => validateP2mrSigningPlans({ psbt, keys })).not.toThrow()

    const signer = vi.fn(() => new Uint8Array(PQC_SIGNATURE_BYTES))
    const { psbt: signed } = signP2mrPsbt({ psbt, keys, sign: signer })
    expect(signer).toHaveBeenCalledTimes(1)
    expect(decodePsbt(signed).inputs[0]!.scriptSigs).toHaveLength(1)

    const bytes = serializePsbt(signed)
    const reparsed = parsePsbt(bytes)
    expect(bytesToHex(serializePsbt(reparsed))).toBe(bytesToHex(bytes))
    for (const field of unknownSubtypes) {
      const kept = reparsed.inputs[0]!.find(entry => bytesToHex(entry.key) === bytesToHex(field.key))
      expect(kept && bytesToHex(kept.value)).toBe(bytesToHex(field.value))
    }

    expect(() => finalizeP2mrPsbt(signed)).not.toThrow()
  })

  it('still rejects a malformed known qbit subtype', () => {
    const psbt = makePsbt(100_000n)
    psbt.inputs[0] = psbt.inputs[0]!.filter(entry => entry.key[0] !== PSBT_IN_PROPRIETARY)
    psbt.inputs[0]!.push({ key: qbitKey(PSBT_QBIT_IN_P2MR_MERKLE_ROOT), value: new Uint8Array(31) })
    expect(() => decodePsbt(psbt)).toThrow(/qbit P2MR merkle root must be 32 bytes/)
  })

  it('leaves decodeQbitProprietaryP2mrInputField strict about unknown subtypes', () => {
    expectInvalidPsbt(
      () => decodeQbitProprietaryP2mrInputField(0x04, new Uint8Array(), Uint8Array.of(1, 2, 3)),
      /unsupported qbit proprietary P2MR subtype/
    )
  })
})

describe('Core-generated PSBT fixture', () => {
  it('still decodes', () => {
    const summary = decodePsbt(parsePsbt(hexToBytes(fixture.psbtHex)))
    expect(summary.inputs).toHaveLength(fixture.expected.inputCount)
    expect(summary.outputs).toHaveLength(fixture.expected.outputCount)
    expect(summary.fee).toBe(BigInt(fixture.expected.fee))
    expect(summary.inputs[0]!.scriptSigs).toHaveLength(fixture.expected.inputs[0]!.scriptSigs)
    expect(summary.inputs[1]!.finalized).toBe(true)
  })
})

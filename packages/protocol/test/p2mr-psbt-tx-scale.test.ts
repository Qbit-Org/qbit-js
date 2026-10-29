import { createHash } from 'node:crypto'

import { describe, expect, it } from 'vitest'

import {
  P2MR_LEAF_VERSION_V1,
  PQC_SIGNATURE_BYTES,
  PSBT_DEFAULT_MAX_OBJECTS,
  PSBT_IN_FINAL_SCRIPTWITNESS,
  QbitProtocolError,
  buildControlBlock,
  bytesToHex,
  createP2mrPsbt,
  extractP2mrTransaction,
  finalizeP2mrPsbt,
  p2mrLeafHash,
  p2mrScriptPubKey,
  p2mrSighash,
  parsePsbt,
  precomputeSighashMidstates,
  psbtUnsignedTransaction,
  serializePsbt,
  signP2mrPsbt,
  singleKeyLeafScript,
  validateP2mrSigningPlans,
  type P2mrTransaction,
  type Psbt,
} from '../src/index'

// Regression tests for transactions with many inputs and outputs. The sighash
// midstates and the transaction serializers passed one call argument per
// input, output or witness item to `concatBytes(...parts)`, which threw a bare
// `RangeError: Maximum call stack size exceeded` at about 120k arguments on
// Node's default stack. Signing failed before the signer was called, so no
// key use was spent, but such a transaction could not be created, signed or
// extracted at all, though `parsePsbt` accepts it at the default limits.
// Expected bytes are built by hand here, not with the serializers under test.

// One input with a witness UTXO and a leaf script, plus this many outputs, is
// exactly PSBT_DEFAULT_MAX_OBJECTS objects: the unsigned-transaction entry, the
// input, its two map entries and the outputs. The finalized PSBT (witness UTXO
// and final witness) and the extracted transaction (the input, the outputs and
// three witness items) are exactly at the limit too.
const OUTPUTS = PSBT_DEFAULT_MAX_OBJECTS - 4
// Each input carries a one-item final witness, so with two outputs this is
// exactly PSBT_DEFAULT_MAX_OBJECTS objects for `extractP2mrTransaction`.
const INPUTS = (PSBT_DEFAULT_MAX_OBJECTS - 2) / 2

function concat(chunks: readonly Uint8Array[]): Uint8Array {
  let length = 0
  for (const chunk of chunks) length += chunk.length
  const out = new Uint8Array(length)
  let offset = 0
  for (const chunk of chunks) {
    out.set(chunk, offset)
    offset += chunk.length
  }
  return out
}

function compactSize(value: number): Uint8Array {
  if (value < 0xfd) return Uint8Array.of(value)
  if (value <= 0xffff) return Uint8Array.of(0xfd, value & 0xff, value >> 8)
  return Uint8Array.of(0xfe, value & 0xff, (value >> 8) & 0xff, (value >> 16) & 0xff, value >>> 24)
}

function varBytes(bytes: Uint8Array): Uint8Array {
  return concat([compactSize(bytes.length), bytes])
}

function uint32LE(value: number): Uint8Array {
  const out = new Uint8Array(4)
  new DataView(out.buffer).setUint32(0, value, true)
  return out
}

function amount(value: bigint): Uint8Array {
  const out = new Uint8Array(8)
  new DataView(out.buffer).setBigInt64(0, value, true)
  return out
}

/** `chunk` repeated `count` times. */
function repeat(chunk: Uint8Array, count: number): Uint8Array {
  const out = new Uint8Array(chunk.length * count)
  for (let i = 0; i < count; i += 1) out.set(chunk, i * chunk.length)
  return out
}

function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

function expectInvalidPsbt(run: () => unknown, message: RegExp): void {
  let caught: unknown
  try {
    run()
  } catch (error) {
    caught = error
  }
  expect(caught).toBeInstanceOf(QbitProtocolError)
  expect((caught as QbitProtocolError).code).toBe('INVALID_PSBT')
  expect((caught as Error).message).toMatch(message)
}

const pubkey = Uint8Array.from({ length: 32 }, (_, i) => (i * 7 + 1) & 0xff)
const leafScript = singleKeyLeafScript(pubkey)
const leafHash = p2mrLeafHash(P2MR_LEAF_VERSION_V1, leafScript)
const controlBlock = buildControlBlock(P2MR_LEAF_VERSION_V1, [])
const scriptPubKey = p2mrScriptPubKey(leafHash)
const witnessUtxo = { value: 100_000n, scriptPubKey }
const prevout = { txid: new Uint8Array(32).fill(9), vout: 0 }
const SEQUENCE = 0xfffffffd
// OP_RETURN, the smallest output restricted-output mode allows: 10 bytes.
const opReturn = { value: 0n, scriptPubKey: Uint8Array.of(0x6a) }
const opReturnBytes = concat([amount(opReturn.value), varBytes(opReturn.scriptPubKey)])
const signature = Uint8Array.from({ length: PQC_SIGNATURE_BYTES }, (_, i) => (i * 13 + 5) & 0xff)

/** The one-input, OUTPUTS-output transaction, with `witness` when given. */
function payoutTx(witness?: Uint8Array): Uint8Array {
  return concat([
    uint32LE(2),
    witness === undefined ? new Uint8Array() : Uint8Array.of(0x00, 0x01),
    compactSize(1),
    prevout.txid,
    uint32LE(prevout.vout),
    compactSize(0),
    uint32LE(SEQUENCE),
    compactSize(OUTPUTS),
    repeat(opReturnBytes, OUTPUTS),
    witness ?? new Uint8Array(),
    uint32LE(0),
  ])
}

/** What `createP2mrPsbt` must produce for the payout: the input map holds the witness UTXO and leaf script. */
function payoutPsbtBytes(): Uint8Array {
  return concat([
    Uint8Array.of(0x70, 0x73, 0x62, 0x74, 0xff),
    varBytes(Uint8Array.of(0x00)),
    varBytes(payoutTx()),
    Uint8Array.of(0x00),
    varBytes(Uint8Array.of(0x01)),
    varBytes(concat([amount(witnessUtxo.value), varBytes(scriptPubKey)])),
    varBytes(concat([Uint8Array.of(0x1d), controlBlock])),
    varBytes(concat([leafScript, Uint8Array.of(P2MR_LEAF_VERSION_V1)])),
    Uint8Array.of(0x00),
    new Uint8Array(OUTPUTS), // an empty map per output
  ])
}

// Each case builds and walks a transaction near the default maxObjects, which can
// take several seconds on a shared CI runner.
const SCALE_TIMEOUT_MS = 60_000

describe(`a transaction with ${OUTPUTS} outputs, exactly the default maxObjects`, { timeout: SCALE_TIMEOUT_MS }, () => {
  const keys = [{ inputIndex: 0, pubkey, leafHash }]

  it('is created by createP2mrPsbt', () => {
    const psbt = createP2mrPsbt({
      inputs: [{ prevout, witnessUtxo, leafScript, controlBlock }],
      outputs: Array.from({ length: OUTPUTS }, () => opReturn),
    })
    expect(Buffer.from(serializePsbt(psbt)).equals(Buffer.from(payoutPsbtBytes()))).toBe(true)
  })

  it('is validated, signed with one signer call, finalized and extracted', () => {
    const psbt = parsePsbt(payoutPsbtBytes())
    expect(psbt.outputs).toHaveLength(OUTPUTS)
    expect(() => validateP2mrSigningPlans({ psbt, keys })).not.toThrow()

    const tx = psbtUnsignedTransaction(psbt)
    const midstates = precomputeSighashMidstates(tx, [witnessUtxo])
    expect(bytesToHex(midstates.outputs)).toBe(sha256Hex(repeat(opReturnBytes, OUTPUTS)))

    const sighashes: Uint8Array[] = []
    const { psbt: signed, signed: plans } = signP2mrPsbt({
      psbt,
      keys,
      sign: sighash => {
        sighashes.push(sighash)
        return signature
      },
    })
    expect(plans).toHaveLength(1)
    expect(sighashes).toHaveLength(1)
    expect(bytesToHex(sighashes[0]!)).toBe(
      bytesToHex(p2mrSighash({ tx, inputIndex: 0, spentOutputs: [witnessUtxo], leafHash, midstates }))
    )

    // The signature is one object more than the default limit admits.
    expectInvalidPsbt(() => parsePsbt(serializePsbt(signed)), /raise maxObjects/)
    const reparsed = parsePsbt(serializePsbt(signed), { maxObjects: PSBT_DEFAULT_MAX_OBJECTS + 1 })

    // Finalizing drops the leaf script and signature records, so the finalized
    // PSBT and the transaction are back at exactly the limit.
    const finalized = parsePsbt(serializePsbt(finalizeP2mrPsbt(reparsed)))
    const witness = concat([compactSize(3), varBytes(signature), varBytes(leafScript), varBytes(controlBlock)])
    const expected = payoutTx(witness)
    expect(Buffer.from(extractP2mrTransaction(finalized)).equals(Buffer.from(expected))).toBe(true)
    // The size bound is unchanged.
    expectInvalidPsbt(
      () => extractP2mrTransaction(finalized, { maxBytes: expected.length - 1 }),
      /larger than maxBytes/
    )
  })
})

describe(`a transaction with ${INPUTS} inputs, exactly the default maxObjects`, { timeout: SCALE_TIMEOUT_MS }, () => {
  it('is extracted', () => {
    const outpoint = (i: number) => {
      const txid = new Uint8Array(32)
      new DataView(txid.buffer).setUint32(0, i, true)
      return { txid, vout: i }
    }
    const inputBytes: Uint8Array[] = []
    for (let i = 0; i < INPUTS; i += 1) {
      const { txid, vout } = outpoint(i)
      inputBytes.push(txid, uint32LE(vout), compactSize(0), uint32LE(SEQUENCE))
    }
    const unsignedTx = concat([
      uint32LE(2),
      compactSize(INPUTS),
      ...inputBytes,
      compactSize(2),
      opReturnBytes,
      opReturnBytes,
      uint32LE(0),
    ])
    // One empty witness item per input.
    const finalWitness = Uint8Array.of(0x01, 0x00)
    const psbt: Psbt = {
      global: [{ key: Uint8Array.of(0x00), value: unsignedTx }],
      inputs: Array.from({ length: INPUTS }, () => [
        { key: Uint8Array.of(PSBT_IN_FINAL_SCRIPTWITNESS), value: finalWitness },
      ]),
      outputs: [[], []],
    }
    const expected = concat([
      uint32LE(2),
      Uint8Array.of(0x00, 0x01),
      compactSize(INPUTS),
      ...inputBytes,
      compactSize(2),
      opReturnBytes,
      opReturnBytes,
      repeat(finalWitness, INPUTS),
      uint32LE(0),
    ])
    expect(Buffer.from(extractP2mrTransaction(psbt)).equals(Buffer.from(expected))).toBe(true)
    // One more witness item is over the limit.
    psbt.inputs[0] = [{ key: Uint8Array.of(PSBT_IN_FINAL_SCRIPTWITNESS), value: Uint8Array.of(0x02, 0x00, 0x00) }]
    expectInvalidPsbt(() => extractP2mrTransaction(psbt), /raise maxObjects/)
  })
})

describe('sighash midstates over many inputs and outputs', { timeout: SCALE_TIMEOUT_MS }, () => {
  it('hash every input, spent output and output, past the default maxObjects', () => {
    // A caller that raised maxObjects can sign such a transaction. The entries
    // are shared objects, which keeps the test's memory down.
    const count = 150_000
    const input = { prevout, sequence: SEQUENCE }
    const output = { value: 1_000n, scriptPubKey }
    const tx: P2mrTransaction = {
      version: 2,
      locktime: 0,
      inputs: Array.from({ length: count }, () => input),
      outputs: Array.from({ length: count }, () => output),
    }
    const midstates = precomputeSighashMidstates(
      tx,
      Array.from({ length: count }, () => witnessUtxo)
    )
    const outpointBytes = concat([prevout.txid, uint32LE(prevout.vout)])
    expect(bytesToHex(midstates.prevouts)).toBe(sha256Hex(repeat(outpointBytes, count)))
    expect(bytesToHex(midstates.amounts)).toBe(sha256Hex(repeat(amount(witnessUtxo.value), count)))
    expect(bytesToHex(midstates.scriptPubKeys)).toBe(sha256Hex(repeat(varBytes(scriptPubKey), count)))
    expect(bytesToHex(midstates.sequences)).toBe(sha256Hex(repeat(uint32LE(SEQUENCE), count)))
    const outputBytes = concat([amount(output.value), varBytes(scriptPubKey)])
    expect(bytesToHex(midstates.outputs)).toBe(sha256Hex(repeat(outputBytes, count)))
  })
})

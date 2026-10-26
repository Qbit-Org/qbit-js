import { describe, expect, it } from 'vitest'

import fixture from '../fixtures/p2mr-psbt.json'
import {
  P2MR_LEAF_VERSION_V1,
  PQC_SIGNATURE_BYTES,
  PSBT_IN_P2MR_LEAF_SCRIPT,
  PSBT_IN_P2MR_SCRIPT_SIG,
  PSBT_QBIT_IN_P2MR_MERKLE_ROOT,
  SIGHASH_ALL,
  buildControlBlock,
  bytesToHex,
  combinePsbts,
  createP2mrPsbt,
  decodeP2mrPsbtLeafScriptField,
  decodeP2mrPsbtScriptSigField,
  decodeP2mrWitnessSignature,
  decodePsbt,
  decodeQbitProprietaryP2mrInputField,
  encodeP2mrWitnessSignature,
  finalizeP2mrPsbt,
  merkleRootFromPath,
  p2mrLeafHash,
  p2mrScriptPubKey,
  p2mrSighash,
  parsePsbt,
  psbtUnsignedTransaction,
  serializePsbt,
  signP2mrPsbt,
  singleKeyLeafScript,
  verifyControlBlock,
  type Psbt,
} from '../src/index'

// Node's Buffer#slice returns a view of the same memory, unlike
// Uint8Array#slice. These tests feed Buffers (what Node integrators actually
// pass) and check that nothing returned keeps pointing into caller memory.

/** Stable, deep snapshot of a value: bytes as hex, bigints as decimal strings. */
function snapshot(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) => {
    if (item instanceof Uint8Array) return `0x${bytesToHex(item)}`
    if (typeof item === 'bigint') return `${item}n`
    return item
  })
}

function forEachBytes(psbt: Psbt, visit: (bytes: Uint8Array) => void): void {
  for (const map of [psbt.global, ...psbt.inputs, ...psbt.outputs]) {
    for (const entry of map) {
      visit(entry.key)
      visit(entry.value)
    }
  }
}

function toBufferPsbt(psbt: Psbt): Psbt {
  const toBuffers = (map: Psbt['global']) =>
    map.map(entry => ({ key: Buffer.from(entry.key), value: Buffer.from(entry.value) }))
  return {
    global: toBuffers(psbt.global),
    inputs: psbt.inputs.map(toBuffers),
    outputs: psbt.outputs.map(toBuffers),
  }
}

function expectOwnedPlainBytes(bytes: Uint8Array, source?: Uint8Array): void {
  expect(Buffer.isBuffer(bytes)).toBe(false)
  expect(Object.getPrototypeOf(bytes)).toBe(Uint8Array.prototype)
  if (source !== undefined) expect(bytes.buffer).not.toBe(source.buffer)
}

const pubkey = Uint8Array.from({ length: 32 }, (_, i) => (i * 7 + 1) & 0xff)
const leafScript = singleKeyLeafScript(pubkey)
const leafHash = p2mrLeafHash(P2MR_LEAF_VERSION_V1, leafScript)
const controlBlock = buildControlBlock(P2MR_LEAF_VERSION_V1, [])
const scriptPubKey = p2mrScriptPubKey(leafHash)
const APPROVED_AMOUNT = 90_000n

function singleKeyPsbtBytes(): Uint8Array {
  return serializePsbt(
    createP2mrPsbt({
      inputs: [
        {
          prevout: { txid: new Uint8Array(32).fill(9), vout: 0 },
          witnessUtxo: { value: 100_000n, scriptPubKey },
          leafScript,
          controlBlock,
          merkleRoot: leafHash,
        },
      ],
      outputs: [{ value: APPROVED_AMOUNT, scriptPubKey }],
    })
  )
}

function amountOffset(bytes: Buffer, amount: bigint): number {
  const encoded = Buffer.alloc(8)
  encoded.writeBigInt64LE(amount)
  const offset = bytes.indexOf(encoded)
  expect(offset).toBeGreaterThan(0)
  expect(bytes.indexOf(encoded, offset + 1)).toBe(-1)
  return offset
}

describe('parsePsbt does not alias Node Buffer input', () => {
  it('keeps a parsed fixture PSBT intact after the source Buffer is wiped', () => {
    const source = Buffer.from(fixture.psbtHex, 'hex')
    const psbt = parsePsbt(source)
    const pristine = parsePsbt(Buffer.from(fixture.psbtHex, 'hex'))
    const pristineDecoded = snapshot(decodePsbt(pristine))

    source.fill(0)

    expect(bytesToHex(serializePsbt(psbt))).toBe(fixture.psbtHex)
    expect(snapshot(decodePsbt(psbt))).toBe(pristineDecoded)
    expect(snapshot(psbtUnsignedTransaction(psbt))).toBe(snapshot(psbtUnsignedTransaction(pristine)))
    forEachBytes(psbt, bytes => expectOwnedPlainBytes(bytes, source))
  })

  it('does not let a policy-approved output amount change after the Buffer is reused', () => {
    const source = Buffer.from(singleKeyPsbtBytes())
    const psbt = parsePsbt(source)
    expect(decodePsbt(psbt).outputs[0]!.value).toBe(APPROVED_AMOUNT)
    const tx = psbtUnsignedTransaction(psbt)
    const approvedSighash = p2mrSighash({
      tx,
      inputIndex: 0,
      spentOutputs: [{ value: 100_000n, scriptPubKey }],
      leafHash,
      hashType: 0,
    })

    // The caller reuses its read buffer: the amount bytes now say 1 118 481 sat.
    source.writeBigInt64LE(0x111111n, amountOffset(source, APPROVED_AMOUNT))

    expect(decodePsbt(psbt).outputs[0]!.value).toBe(APPROVED_AMOUNT)
    let signedSighash: Uint8Array | undefined
    const { psbt: signed } = signP2mrPsbt({
      psbt,
      keys: [{ inputIndex: 0, pubkey, leafHash }],
      sign: sighash => {
        signedSighash = sighash
        return new Uint8Array(PQC_SIGNATURE_BYTES).fill(0x5a)
      },
    })
    expect(bytesToHex(signedSighash!)).toBe(bytesToHex(approvedSighash))
    expect(decodePsbt(signed).outputs[0]!.value).toBe(APPROVED_AMOUNT)
  })

  it('does not write through to the source when the parsed PSBT is mutated', () => {
    const source = Buffer.from(fixture.psbtHex, 'hex')
    const psbt = parsePsbt(source)
    forEachBytes(psbt, bytes => bytes.fill(0xee))
    expect(source.toString('hex')).toBe(fixture.psbtHex)
  })

  it('copies out of a Buffer view at a non-zero offset into a larger allocation', () => {
    const bytes = Buffer.from(fixture.psbtHex, 'hex')
    const backing = new ArrayBuffer(bytes.length + 64)
    const view = Buffer.from(backing, 7, bytes.length)
    view.set(bytes)
    new Uint8Array(backing, 0, 7).fill(0xaa)

    const fromView = parsePsbt(view)
    const fromSubarray = parsePsbt(new Uint8Array(backing).subarray(7, 7 + bytes.length))
    expect(bytesToHex(serializePsbt(fromView))).toBe(fixture.psbtHex)
    expect(bytesToHex(serializePsbt(fromSubarray))).toBe(fixture.psbtHex)

    new Uint8Array(backing).fill(0)
    expect(bytesToHex(serializePsbt(fromView))).toBe(fixture.psbtHex)
    expect(bytesToHex(serializePsbt(fromSubarray))).toBe(fixture.psbtHex)
    // Each field owns exactly its own bytes, not the caller's whole allocation.
    forEachBytes(fromView, field => {
      expectOwnedPlainBytes(field, view)
      expect(field.byteOffset).toBe(0)
      expect(field.buffer.byteLength).toBe(field.length)
    })
  })
})

describe('field decoders do not alias Node Buffer input', () => {
  const signature = Uint8Array.from({ length: PQC_SIGNATURE_BYTES }, (_, i) => (i * 13) & 0xff)

  it('decodeP2mrWitnessSignature copies both the default and explicit-hash-type forms', () => {
    for (const hashType of [0, SIGHASH_ALL]) {
      const source = Buffer.from(encodeP2mrWitnessSignature(signature, hashType))
      const decoded = decodeP2mrWitnessSignature(source)
      source.fill(0)
      expect(bytesToHex(decoded.signature)).toBe(bytesToHex(signature))
      expect(decoded.hashType).toBe(hashType)
      expectOwnedPlainBytes(decoded.signature, source)
    }
  })

  it('decodeP2mrPsbtScriptSigField copies pubkey, leaf hash, and signature', () => {
    const key = Buffer.concat([Buffer.of(PSBT_IN_P2MR_SCRIPT_SIG), pubkey, leafHash])
    const value = Buffer.from(encodeP2mrWitnessSignature(signature, SIGHASH_ALL))
    const decoded = decodeP2mrPsbtScriptSigField(key, value)
    key.fill(0)
    value.fill(0)
    expect(bytesToHex(decoded.pubkey)).toBe(bytesToHex(pubkey))
    expect(bytesToHex(decoded.leafHash)).toBe(bytesToHex(leafHash))
    expect(bytesToHex(decoded.signature.signature)).toBe(bytesToHex(signature))
    for (const bytes of [decoded.pubkey, decoded.leafHash]) expectOwnedPlainBytes(bytes, key)
    expectOwnedPlainBytes(decoded.signature.signature, value)
  })

  it('decodeP2mrPsbtLeafScriptField copies the control block and script', () => {
    const siblingControlBlock = buildControlBlock(P2MR_LEAF_VERSION_V1, [new Uint8Array(32).fill(3)])
    const key = Buffer.concat([Buffer.of(PSBT_IN_P2MR_LEAF_SCRIPT), siblingControlBlock])
    const value = Buffer.concat([leafScript, Buffer.of(P2MR_LEAF_VERSION_V1)])
    const decoded = decodeP2mrPsbtLeafScriptField(key, value)
    key.fill(0)
    value.fill(0)
    expect(bytesToHex(decoded.controlBlock)).toBe(bytesToHex(siblingControlBlock))
    expect(bytesToHex(decoded.script)).toBe(bytesToHex(leafScript))
    expectOwnedPlainBytes(decoded.controlBlock, key)
    expectOwnedPlainBytes(decoded.script, value)
  })

  it('decodeQbitProprietaryP2mrInputField copies the merkle root', () => {
    const value = Buffer.from(leafHash)
    const decoded = decodeQbitProprietaryP2mrInputField(PSBT_QBIT_IN_P2MR_MERKLE_ROOT, Buffer.alloc(0), value)
    value.fill(0)
    expect(decoded.type).toBe('qbitP2mrMerkleRoot')
    if (decoded.type !== 'qbitP2mrMerkleRoot') return
    expect(bytesToHex(decoded.merkleRoot)).toBe(bytesToHex(leafHash))
  })

  it('verifyControlBlock and merkleRootFromPath never return the caller leaf hash', () => {
    for (const siblings of [[], [new Uint8Array(32).fill(3)]]) {
      const expectedRoot = merkleRootFromPath(leafHash, siblings)
      const source = Buffer.from(leafHash)
      const block = Buffer.from(buildControlBlock(P2MR_LEAF_VERSION_V1, siblings))
      const fromBlock = verifyControlBlock(block, source, P2MR_LEAF_VERSION_V1)
      const fromPath = merkleRootFromPath(source, siblings)
      source.fill(0)
      block.fill(0)
      expect(bytesToHex(fromBlock)).toBe(bytesToHex(expectedRoot))
      expect(bytesToHex(fromPath)).toBe(bytesToHex(expectedRoot))
      expect(fromBlock).not.toBe(source)
      expect(fromPath).not.toBe(source)
    }
  })
})

describe('PSBT operations do not alias Buffer-backed PSBTs or signing keys', () => {
  it('snapshots signing-plan keys so later writes to the caller key cannot retarget the signature', () => {
    const psbt = parsePsbt(singleKeyPsbtBytes())
    const callerPubkey = Buffer.from(pubkey)
    const callerLeafHash = Buffer.from(leafHash)
    const { psbt: signed, signed: signers } = signP2mrPsbt({
      psbt,
      keys: [{ inputIndex: 0, pubkey: callerPubkey, leafHash: callerLeafHash }],
      sign: (_sighash, context) => {
        // Both the caller's key material and the callback context are wiped.
        callerPubkey.fill(0)
        callerLeafHash.fill(0)
        context.pubkey.fill(0)
        context.leafHash.fill(0)
        return new Uint8Array(PQC_SIGNATURE_BYTES).fill(0x5a)
      },
    })
    const scriptSigs = decodePsbt(signed).inputs[0]!.scriptSigs
    expect(scriptSigs).toHaveLength(1)
    expect(bytesToHex(scriptSigs[0]!.pubkey)).toBe(bytesToHex(pubkey))
    expect(bytesToHex(scriptSigs[0]!.leafHash)).toBe(bytesToHex(leafHash))
    expect(bytesToHex(signers[0]!.pubkey)).toBe(bytesToHex(pubkey))
    expectOwnedPlainBytes(signers[0]!.pubkey, callerPubkey)
  })

  it('returns independent copies from signP2mrPsbt, combinePsbts, and finalizeP2mrPsbt', () => {
    const unsigned = parsePsbt(singleKeyPsbtBytes())
    const signedOnce = signP2mrPsbt({
      psbt: unsigned,
      keys: [{ inputIndex: 0, pubkey, leafHash }],
      sign: () => new Uint8Array(PQC_SIGNATURE_BYTES).fill(0x5a),
    }).psbt
    const operations: [string, (psbt: Psbt) => Psbt, Psbt][] = [
      [
        'signP2mrPsbt',
        psbt =>
          signP2mrPsbt({
            psbt,
            keys: [{ inputIndex: 0, pubkey, leafHash }],
            sign: () => new Uint8Array(PQC_SIGNATURE_BYTES).fill(0x5a),
          }).psbt,
        unsigned,
      ],
      ['combinePsbts', psbt => combinePsbts([psbt, psbt]), signedOnce],
      ['finalizeP2mrPsbt', finalizeP2mrPsbt, signedOnce],
    ]

    for (const [name, operation, template] of operations) {
      const input = toBufferPsbt(template)
      const inputHex = bytesToHex(serializePsbt(input))
      const output = operation(input)
      const outputHex = bytesToHex(serializePsbt(output))

      forEachBytes(input, bytes => bytes.fill(0x11))
      expect(bytesToHex(serializePsbt(output)), `${name}: input mutation leaked`).toBe(outputHex)

      const fresh = toBufferPsbt(template)
      const freshOutput = operation(fresh)
      forEachBytes(freshOutput, bytes => bytes.fill(0x22))
      expect(bytesToHex(serializePsbt(fresh)), `${name}: output mutation leaked`).toBe(inputHex)
      forEachBytes(output, bytes => expectOwnedPlainBytes(bytes))
    }
  })
})

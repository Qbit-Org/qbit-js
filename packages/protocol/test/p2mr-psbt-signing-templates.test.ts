import { describe, expect, it, vi } from 'vitest'

import {
  OP_1,
  OP_CHECKSIGPQC,
  OP_NUMEQUAL,
  P2MR_LEAF_VERSION_V1,
  PQC_SIGNATURE_BYTES,
  buildControlBlock,
  bytesToHex,
  createP2mrPsbt,
  decodePsbt,
  multiALeafScript,
  p2mrLeafHash,
  p2mrScriptPubKey,
  p2mrSighash,
  psbtUnsignedTransaction,
  signP2mrPsbt,
  singleKeyLeafScript,
  validateP2mrSigningPlans,
  type Psbt,
} from '../src/index'

// qbit Core v1.0.0 signs only v1 pk(K) and multi_a leaves with a threshold of
// at most 35 (src/script/sign.cpp:503-511, src/script/p2mr.h:40-70). The
// signing preflight must refuse every other leaf before the signer runs.

const OP_PUSHDATA1 = 0x4c
const OP_DROP = 0x75
const OP_CODESEPARATOR = 0xab
const NOT_A_TEMPLATE = /signing leaf is not a v1 pk\/multi_a template containing this key/

const pubkey = Uint8Array.from({ length: 32 }, (_, i) => (i * 7 + 1) & 0xff)
const secondPubkey = new Uint8Array(32).fill(0x42)
const txid = new Uint8Array(32).fill(9)

function keyAt(index: number): Uint8Array {
  return Uint8Array.from({ length: 32 }, (_, i) => (index * 31 + i * 7 + 3) & 0xff)
}

function concat(...chunks: readonly (Uint8Array | readonly number[])[]): Uint8Array {
  return Uint8Array.from(chunks.flatMap(chunk => Array.from(chunk)))
}

// A multi_a key list followed by raw threshold bytes and OP_NUMEQUAL, built by
// hand so the test does not depend on multiALeafScript accepting the threshold.
function multiAWithThresholdBytes(keys: readonly Uint8Array[], threshold: readonly number[]): Uint8Array {
  const oneOfN = multiALeafScript(1, keys)
  return concat(oneOfN.subarray(0, oneOfN.length - 2), threshold, [OP_NUMEQUAL])
}

// Copied from the setup in p2mr-psbt-signing.test.ts, parameterised by leaf.
function p2mrPsbtForLeaf(
  leafScript: Uint8Array,
  leafVersion: number = P2MR_LEAF_VERSION_V1
): { psbt: Psbt; leafHash: Uint8Array; scriptPubKey: Uint8Array } {
  const leafHash = p2mrLeafHash(leafVersion, leafScript)
  const controlBlock = buildControlBlock(leafVersion, [])
  const scriptPubKey = p2mrScriptPubKey(leafHash)
  const psbt = createP2mrPsbt({
    inputs: [
      {
        prevout: { txid, vout: 0 },
        witnessUtxo: { value: 100_000n, scriptPubKey },
        leafScript,
        controlBlock,
        leafVersion,
        merkleRoot: leafHash,
      },
    ],
    outputs: [{ value: 90_000n, scriptPubKey }],
  })
  return { psbt, leafHash, scriptPubKey }
}

function expectRejectedBeforeSigning(
  leafScript: Uint8Array,
  signingPubkey: Uint8Array,
  leafVersion: number = P2MR_LEAF_VERSION_V1
): void {
  const { psbt, leafHash } = p2mrPsbtForLeaf(leafScript, leafVersion)
  const keys = [{ inputIndex: 0, pubkey: signingPubkey, leafHash }]
  const signer = vi.fn(() => new Uint8Array(PQC_SIGNATURE_BYTES))
  const notATemplate = expect.objectContaining({
    code: 'INVALID_PSBT',
    message: expect.stringMatching(NOT_A_TEMPLATE),
  })

  expect(() => validateP2mrSigningPlans({ psbt, keys })).toThrow(notATemplate)
  expect(() => signP2mrPsbt({ psbt, keys, sign: signer })).toThrow(notATemplate)
  expect(signer).not.toHaveBeenCalled()
}

function signAll(
  leafScript: Uint8Array,
  signingPubkeys: readonly Uint8Array[]
): { signer: ReturnType<typeof vi.fn>; signedPsbt: Psbt; expectedSighash: Uint8Array } {
  const { psbt, leafHash, scriptPubKey } = p2mrPsbtForLeaf(leafScript)
  const expectedSighash = p2mrSighash({
    tx: psbtUnsignedTransaction(psbt),
    inputIndex: 0,
    spentOutputs: [{ value: 100_000n, scriptPubKey }],
    leafHash,
    hashType: 0,
  })
  const signer = vi.fn(() => new Uint8Array(PQC_SIGNATURE_BYTES).fill(1))
  const { psbt: signedPsbt, signed } = signP2mrPsbt({
    psbt,
    keys: signingPubkeys.map(key => ({ inputIndex: 0, pubkey: key, leafHash })),
    sign: signer,
  })
  expect(signed.map(entry => bytesToHex(entry.pubkey))).toEqual(signingPubkeys.map(bytesToHex))
  return { signer, signedPsbt, expectedSighash }
}

describe('P2MR signing preflight accepts only Core v1 pk/multi_a templates', () => {
  it('rejects a key that appears only inside an OP_PUSHDATA1 payload', () => {
    // OP_PUSHDATA1 <80-byte payload starting `0x20 K OP_CHECKSIGPQC`> OP_DROP OP_1:
    // the payload is data, so the script never checks K.
    const payload = concat([0x20], pubkey, [OP_CHECKSIGPQC], new Uint8Array(80 - 34))
    expectRejectedBeforeSigning(concat([OP_PUSHDATA1, payload.length], payload, [OP_DROP, OP_1]), pubkey)
  })

  it('rejects a non-minimal OP_PUSHDATA1 key push', () => {
    expectRejectedBeforeSigning(concat([OP_PUSHDATA1, 0x20], pubkey, [OP_CHECKSIGPQC]), pubkey)
  })

  it('rejects a pk(K) leaf whose leaf version is not 0xc0', () => {
    expectRejectedBeforeSigning(singleKeyLeafScript(pubkey), pubkey, 0xc2)
  })

  it('rejects a pk(K) leaf preceded by OP_CODESEPARATOR', () => {
    // Signing uses codeSeparatorPos 0xffffffff; Core's interpreter would commit
    // to position 0, so the signature could never verify.
    expectRejectedBeforeSigning(concat([OP_CODESEPARATOR], singleKeyLeafScript(pubkey)), pubkey)
  })

  it('rejects a multi_a threshold above 35', () => {
    const keys = Array.from({ length: 36 }, (_, i) => keyAt(i))
    expectRejectedBeforeSigning(multiAWithThresholdBytes(keys, [0x01, 36]), keys[0]!)
  })

  it('rejects a multi_a leaf with a trailing opcode', () => {
    expectRejectedBeforeSigning(concat(multiALeafScript(1, [pubkey, secondPubkey]), [OP_1]), pubkey)
  })

  it('rejects a multi_a threshold pushed non-minimally', () => {
    // `0x01 0x01` instead of OP_1: Core's GetScriptNumber requires a minimal push.
    expectRejectedBeforeSigning(multiAWithThresholdBytes([pubkey, secondPubkey], [0x01, 0x01]), pubkey)
  })

  it('keeps the existing error for a template that does not contain the key', () => {
    const { psbt, leafHash } = p2mrPsbtForLeaf(multiALeafScript(1, [pubkey, secondPubkey]))
    const signer = vi.fn(() => new Uint8Array(PQC_SIGNATURE_BYTES))
    expect(() =>
      signP2mrPsbt({
        psbt,
        keys: [{ inputIndex: 0, pubkey: new Uint8Array(32).fill(0x7f), leafHash }],
        sign: signer,
      })
    ).toThrow(/signing pubkey is not used by the selected P2MR leaf script/)
    expect(signer).not.toHaveBeenCalled()
  })

  it('signs a pk(K) leaf', () => {
    const { signer, signedPsbt, expectedSighash } = signAll(singleKeyLeafScript(pubkey), [pubkey])
    expect(signer).toHaveBeenCalledTimes(1)
    expect(bytesToHex(signer.mock.calls[0]![0] as Uint8Array)).toBe(bytesToHex(expectedSighash))
    expect(decodePsbt(signedPsbt).inputs[0]!.scriptSigs).toHaveLength(1)
  })

  it('signs the first key of multi_a(1, A, B)', () => {
    const { signer, signedPsbt } = signAll(multiALeafScript(1, [pubkey, secondPubkey]), [pubkey])
    expect(signer).toHaveBeenCalledTimes(1)
    expect(decodePsbt(signedPsbt).inputs[0]!.scriptSigs).toHaveLength(1)
  })

  it('signs both keys of multi_a(2, A, B)', () => {
    const { signer, signedPsbt } = signAll(multiALeafScript(2, [pubkey, secondPubkey]), [pubkey, secondPubkey])
    expect(signer).toHaveBeenCalledTimes(2)
    expect(decodePsbt(signedPsbt).inputs[0]!.scriptSigs).toHaveLength(2)
  })

  it('signs multi_a at the 35-signature threshold limit', () => {
    const keys = Array.from({ length: 35 }, (_, i) => keyAt(i))
    const { signer } = signAll(multiALeafScript(35, keys), [keys[34]!])
    expect(signer).toHaveBeenCalledTimes(1)
  })
})

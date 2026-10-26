import { describe, expect, it, vi } from 'vitest'

import {
  OP_1,
  P2MR_LEAF_VERSION_V1,
  PQC_SIGNATURE_BYTES,
  PSBT_IN_FINAL_SCRIPTWITNESS,
  PSBT_IN_P2MR_SCRIPT_SIG,
  PSBT_IN_PROPRIETARY,
  QbitProtocolError,
  SIGHASH_ALL,
  buildControlBlock,
  bytesToHex,
  createP2mrPsbt,
  decodePsbt,
  encodeP2mrPsbtLeafScriptField,
  encodeP2mrPsbtScriptSigField,
  encodeQbitProprietaryP2mrLeafScriptField,
  encodeQbitProprietaryP2mrScriptSigField,
  extractP2mrTransaction,
  finalizeP2mrPsbt,
  multiALeafScript,
  p2mrBranchHash,
  p2mrLeafHash,
  p2mrScriptPubKey,
  signP2mrPsbt,
  singleKeyLeafScript,
  validateP2mrSigningPlans,
  type EncodedQbitProprietaryP2mrField,
  type P2mrSigningKey,
  type Psbt,
  type PsbtKeyValue,
} from '../src/index'

// The signing preflight used to accept inputs that finalizeP2mrPsbt then always
// rejected, so a bounded SLH-DSA signature was spent for nothing. Finalize now
// builds the witness qbit Core v1.0.0's FinalizePSBT builds: leaves deduped by
// (script, leaf version) and signatures by (pubkey, leaf hash) (psbt.h:298,
// :318-328, :850, :996), unrelated leaves and signatures ignored, and the
// smallest complete committed v1 pk / multi_a leaf chosen (sign.cpp:503-631,
// :699-741). Each shape is signed and finalized, or refused before the signer.

const keyA = Uint8Array.from({ length: 32 }, (_, i) => (i * 7 + 1) & 0xff)
const keyB = new Uint8Array(32).fill(0x42)
const keyC = new Uint8Array(32).fill(0x07)
const leafA = singleKeyLeafScript(keyA)
const leafB = singleKeyLeafScript(keyB)
const leafC = singleKeyLeafScript(keyC)
const hashA = p2mrLeafHash(P2MR_LEAF_VERSION_V1, leafA)
const hashB = p2mrLeafHash(P2MR_LEAF_VERSION_V1, leafB)
const hashC = p2mrLeafHash(P2MR_LEAF_VERSION_V1, leafC)
const rootControlBlock = buildControlBlock(P2MR_LEAF_VERSION_V1, [])
const txid = new Uint8Array(32).fill(9)

const hex = bytesToHex
const signatureOf = (pubkey: Uint8Array): Uint8Array =>
  Uint8Array.from({ length: PQC_SIGNATURE_BYTES }, (_, i) => (pubkey[0]! + i * 3) & 0xff)

interface LeafRecord {
  script: Uint8Array
  controlBlock: Uint8Array
  /** Carry the leaf as a qbit proprietary subtype 0x02 record instead of 0x1d. */
  proprietary?: boolean
}

function qbitEntry(field: EncodedQbitProprietaryP2mrField): PsbtKeyValue {
  // fc 04 'qbit' <subtype> <key data>
  return {
    key: Uint8Array.of(PSBT_IN_PROPRIETARY, 0x04, 0x71, 0x62, 0x69, 0x74, field.subtype, ...field.keyData),
    value: field.value,
  }
}

function leafEntry(leaf: LeafRecord): PsbtKeyValue {
  return leaf.proprietary === true
    ? qbitEntry(encodeQbitProprietaryP2mrLeafScriptField(leaf.controlBlock, leaf.script))
    : encodeP2mrPsbtLeafScriptField(leaf.controlBlock, leaf.script)
}

/** A one-input PSBT spending the P2MR output with `root`, carrying exactly `leaves` and then `extra`. */
function psbtFor(root: Uint8Array, leaves: readonly LeafRecord[], extra: readonly PsbtKeyValue[] = []): Psbt {
  const psbt = createP2mrPsbt({
    inputs: [
      {
        prevout: { txid, vout: 0 },
        witnessUtxo: { value: 100_000n, scriptPubKey: p2mrScriptPubKey(root) },
        leafScript: leaves[0]!.script,
        controlBlock: leaves[0]!.controlBlock,
      },
    ],
    outputs: [{ value: 90_000n, scriptPubKey: p2mrScriptPubKey(root) }],
  })
  psbt.inputs[0] = [psbt.inputs[0]![0]!, ...leaves.map(leafEntry), ...extra]
  return psbt
}

/** Preflight, then sign: the signer must run once per key and return Core-shaped signatures. */
function sign(psbt: Psbt, keys: readonly { pubkey: Uint8Array; leafHash: Uint8Array }[]): Psbt {
  const plans: P2mrSigningKey[] = keys.map(key => ({ inputIndex: 0, ...key }))
  validateP2mrSigningPlans({ psbt, keys: plans })
  const signer = vi.fn((_sighash: Uint8Array, context: { pubkey: Uint8Array }) => signatureOf(context.pubkey))
  const { psbt: signed, signed: refs } = signP2mrPsbt({ psbt, keys: plans, sign: signer })
  expect(signer).toHaveBeenCalledTimes(keys.length)
  expect(refs).toHaveLength(keys.length)
  return signed
}

function readCompactSize(bytes: Uint8Array, offset: number): [number, number] {
  const first = bytes[offset]!
  if (first < 0xfd) return [first, offset + 1]
  if (first === 0xfd) return [bytes[offset + 1]! | (bytes[offset + 2]! << 8), offset + 3]
  throw new Error('test witness parser handles items below 64 KiB only')
}

/** The final witness stack of input 0, as hex items. */
function finalWitness(psbt: Psbt): string[] {
  const entry = psbt.inputs[0]!.find(item => item.key.length === 1 && item.key[0] === PSBT_IN_FINAL_SCRIPTWITNESS)
  expect(entry).toBeDefined()
  const bytes = entry!.value
  let [count, offset] = readCompactSize(bytes, 0)
  const items: string[] = []
  while (count-- > 0) {
    const [length, start] = readCompactSize(bytes, offset)
    items.push(hex(bytes.subarray(start, start + length)))
    offset = start + length
  }
  expect(offset).toBe(bytes.length)
  return items
}

/**
 * Run `multi_a` the way the interpreter does: CHECKSIGPQC / CHECKSIGADD pop one
 * stack item per key, first key first, from the top (the last witness item
 * before the script). A non-empty item must be that key's signature, and the
 * count must equal the threshold with the stack left empty.
 */
function satisfiesMultiA(witness: readonly string[], keys: readonly Uint8Array[], threshold: number): boolean {
  const stack = witness.slice(0, -2)
  let count = 0
  for (const key of keys) {
    const item = stack.pop()
    if (item === undefined) return false
    if (item === '') continue
    if (item !== hex(signatureOf(key))) return false
    count += 1
  }
  return stack.length === 0 && count === threshold
}

function expectProtocolError(fn: () => unknown, code: string, message: RegExp): void {
  try {
    fn()
  } catch (error) {
    expect(error).toBeInstanceOf(QbitProtocolError)
    expect((error as QbitProtocolError).code).toBe(code)
    expect((error as Error).message).toMatch(message)
    return
  }
  throw new Error('expected a QbitProtocolError')
}

describe('shape 1: extra leaf records', () => {
  it('ignores a leaf record whose control block does not commit to the output', () => {
    const psbt = psbtFor(hashA, [
      { script: leafA, controlBlock: rootControlBlock },
      { script: leafB, controlBlock: buildControlBlock(P2MR_LEAF_VERSION_V1, [hashC]) },
    ])
    const finalized = finalizeP2mrPsbt(sign(psbt, [{ pubkey: keyA, leafHash: hashA }]))
    expect(finalWitness(finalized)).toEqual([hex(signatureOf(keyA)), hex(leafA), hex(rootControlBlock)])
    expect(() => extractP2mrTransaction(finalized)).not.toThrow()
  })

  it('ignores a committed leaf that is not a pk or multi_a template', () => {
    const opTrue = Uint8Array.of(OP_1)
    const hashTrue = p2mrLeafHash(P2MR_LEAF_VERSION_V1, opTrue)
    const psbt = psbtFor(p2mrBranchHash(hashA, hashTrue), [
      { script: opTrue, controlBlock: buildControlBlock(P2MR_LEAF_VERSION_V1, [hashA]) },
      { script: leafA, controlBlock: buildControlBlock(P2MR_LEAF_VERSION_V1, [hashTrue]) },
    ])
    const finalized = finalizeP2mrPsbt(sign(psbt, [{ pubkey: keyA, leafHash: hashA }]))
    expect(finalWitness(finalized)).toEqual([
      hex(signatureOf(keyA)),
      hex(leafA),
      hex(buildControlBlock(P2MR_LEAF_VERSION_V1, [hashTrue])),
    ])
  })
})

describe('shape 2: signatures for other (pubkey, leaf hash) pairs', () => {
  it('ignores and drops them, whether 0x19 or qbit 0x03', () => {
    const psbt = psbtFor(hashA, [{ script: leafA, controlBlock: rootControlBlock }], [
      encodeP2mrPsbtScriptSigField(keyB, hashB, signatureOf(keyB)),
      qbitEntry(encodeQbitProprietaryP2mrScriptSigField(keyC, hashA, signatureOf(keyC))),
    ])
    const finalized = finalizeP2mrPsbt(sign(psbt, [{ pubkey: keyA, leafHash: hashA }]))
    expect(finalWitness(finalized)).toEqual([hex(signatureOf(keyA)), hex(leafA), hex(rootControlBlock)])
    expect(finalized.inputs[0]!.some(entry => entry.key[0] === PSBT_IN_P2MR_SCRIPT_SIG)).toBe(false)
    expect(finalized.inputs[0]!.some(entry => entry.key[0] === PSBT_IN_PROPRIETARY)).toBe(false)
  })

  it('still requires every signature on the input to carry its sighash type, as Core does', () => {
    const psbt = psbtFor(hashA, [{ script: leafA, controlBlock: rootControlBlock }], [
      encodeP2mrPsbtScriptSigField(keyA, hashA, signatureOf(keyA)),
      encodeP2mrPsbtScriptSigField(keyB, hashB, signatureOf(keyB), SIGHASH_ALL),
    ])
    expectProtocolError(() => finalizeP2mrPsbt(psbt), 'INVALID_SIGHASH', /sighash type 0x01 does not match/)
  })
})

describe('shape 3: one leaf or signature carried in both namespaces', () => {
  it('counts a leaf carried as both 0x1d and qbit 0x02 once', () => {
    const psbt = psbtFor(hashA, [
      { script: leafA, controlBlock: rootControlBlock },
      { script: leafA, controlBlock: rootControlBlock, proprietary: true },
    ])
    expect(decodePsbt(psbt).inputs[0]!.leafScripts).toHaveLength(1)
    const finalized = finalizeP2mrPsbt(sign(psbt, [{ pubkey: keyA, leafHash: hashA }]))
    expect(finalWitness(finalized)).toEqual([hex(signatureOf(keyA)), hex(leafA), hex(rootControlBlock)])
  })

  it('keeps the first record of a repeated leaf, in map order', () => {
    const otherControlBlock = buildControlBlock(P2MR_LEAF_VERSION_V1, [hashC])
    const psbt = psbtFor(hashA, [
      { script: leafB, controlBlock: otherControlBlock, proprietary: true },
      { script: leafA, controlBlock: rootControlBlock, proprietary: true },
      { script: leafC, controlBlock: otherControlBlock },
      { script: leafA, controlBlock: rootControlBlock },
    ])
    const leaves = decodePsbt(psbt).inputs[0]!.leafScripts
    expect(leaves.map(leaf => hex(leaf.script))).toEqual([hex(leafB), hex(leafA), hex(leafC)])
    expect(leaves.map(leaf => hex(leaf.controlBlock))).toEqual(
      [otherControlBlock, rootControlBlock, otherControlBlock].map(hex)
    )
  })

  it('keeps distinct leaves that share a control block across the namespaces', () => {
    const psbt = psbtFor(hashA, [
      { script: leafA, controlBlock: rootControlBlock },
      { script: leafB, controlBlock: rootControlBlock, proprietary: true },
    ])
    expect(decodePsbt(psbt).inputs[0]!.leafScripts.map(leaf => hex(leaf.script))).toEqual([hex(leafA), hex(leafB)])
  })

  it('counts a signature carried as both 0x19 and qbit 0x03 once', () => {
    const psbt = psbtFor(hashA, [{ script: leafA, controlBlock: rootControlBlock }], [
      encodeP2mrPsbtScriptSigField(keyA, hashA, signatureOf(keyA)),
      qbitEntry(encodeQbitProprietaryP2mrScriptSigField(keyA, hashA, signatureOf(keyA))),
    ])
    expect(decodePsbt(psbt).inputs[0]!.scriptSigs).toHaveLength(1)
    expect(finalWitness(finalizeP2mrPsbt(psbt))).toEqual([hex(signatureOf(keyA)), hex(leafA), hex(rootControlBlock)])
  })

  it('rejects conflicting copies of one signature before any signer call', () => {
    const root = p2mrBranchHash(hashA, hashB)
    const psbt = psbtFor(
      root,
      [
        { script: leafA, controlBlock: buildControlBlock(P2MR_LEAF_VERSION_V1, [hashB]) },
        { script: leafB, controlBlock: buildControlBlock(P2MR_LEAF_VERSION_V1, [hashA]) },
      ],
      [
        encodeP2mrPsbtScriptSigField(keyB, hashB, signatureOf(keyB)),
        qbitEntry(encodeQbitProprietaryP2mrScriptSigField(keyB, hashB, signatureOf(keyC))),
      ]
    )
    const conflicting = /input 0: conflicting P2MR script signatures for one pubkey and leaf hash/
    const keys = [{ inputIndex: 0, pubkey: keyA, leafHash: hashA }]
    const signer = vi.fn(() => signatureOf(keyA))
    expectProtocolError(() => decodePsbt(psbt), 'INVALID_PSBT', conflicting)
    expectProtocolError(() => validateP2mrSigningPlans({ psbt, keys }), 'INVALID_PSBT', conflicting)
    expectProtocolError(() => signP2mrPsbt({ psbt, keys, sign: signer }), 'INVALID_PSBT', conflicting)
    expect(signer).not.toHaveBeenCalled()
    expectProtocolError(() => finalizeP2mrPsbt(psbt), 'INVALID_PSBT', conflicting)
  })
})

describe('shape 4: a tree with several leaves present', () => {
  const root = p2mrBranchHash(hashA, hashB)
  const controlA = buildControlBlock(P2MR_LEAF_VERSION_V1, [hashB])
  const controlB = buildControlBlock(P2MR_LEAF_VERSION_V1, [hashA])
  const twoLeaf = (): Psbt =>
    psbtFor(root, [
      { script: leafA, controlBlock: controlA },
      { script: leafB, controlBlock: controlB },
    ])

  it.each([
    ['A', keyA, hashA, leafA, controlA],
    ['B', keyB, hashB, leafB, controlB],
  ])('finalizes the leaf of key %s when only it signs', (_name, pubkey, leafHash, script, controlBlock) => {
    const finalized = finalizeP2mrPsbt(sign(twoLeaf(), [{ pubkey, leafHash }]))
    expect(finalWitness(finalized)).toEqual([hex(signatureOf(pubkey)), hex(script), hex(controlBlock)])
  })

  it('breaks a witness-size tie toward the bytewise-smaller script, whatever the order', () => {
    // Both witnesses are the same size; pk(A) (20 01 ...) sorts before pk(B) (20 42 ...).
    const psbt = psbtFor(
      root,
      [
        { script: leafB, controlBlock: controlB },
        { script: leafA, controlBlock: controlA },
      ],
      [encodeP2mrPsbtScriptSigField(keyB, hashB, signatureOf(keyB))]
    )
    const finalized = finalizeP2mrPsbt(sign(psbt, [{ pubkey: keyA, leafHash: hashA }]))
    expect(finalWitness(finalized)).toEqual([hex(signatureOf(keyA)), hex(leafA), hex(controlA)])
  })

  it('prefers the complete leaf with the smaller witness', () => {
    // mr({pk(C), {pk(A), pk(B)}}): pk(C) has a 33-byte path, pk(A) a 65-byte one.
    const inner = p2mrBranchHash(hashA, hashB)
    const deepA = buildControlBlock(P2MR_LEAF_VERSION_V1, [hashB, hashC])
    const shallowC = buildControlBlock(P2MR_LEAF_VERSION_V1, [inner])
    const psbt = psbtFor(
      p2mrBranchHash(hashC, inner),
      [
        { script: leafA, controlBlock: deepA },
        { script: leafC, controlBlock: shallowC },
      ],
      [encodeP2mrPsbtScriptSigField(keyA, hashA, signatureOf(keyA))]
    )
    const finalized = finalizeP2mrPsbt(sign(psbt, [{ pubkey: keyC, leafHash: hashC }]))
    expect(finalWitness(finalized)).toEqual([hex(signatureOf(keyC)), hex(leafC), hex(shallowC)])
  })

  it('uses the shortest committing control block of a leaf, skipping ones that do not commit', () => {
    // mr({pk(A), {pk(A), pk(C)}}): pk(A) sits at depths 1 and 2.
    const inner = p2mrBranchHash(hashA, hashC)
    const shallow = buildControlBlock(P2MR_LEAF_VERSION_V1, [inner])
    const deep = buildControlBlock(P2MR_LEAF_VERSION_V1, [hashC, hashA])
    // Same path as `shallow` and sorts before it, but its control byte says leaf version 0x40.
    const wrongVersion = Uint8Array.of(0x41, ...inner)
    const unrelated = buildControlBlock(P2MR_LEAF_VERSION_V1, [new Uint8Array(32)])
    const psbt = psbtFor(p2mrBranchHash(hashA, inner), [
      { script: leafA, controlBlock: deep },
      { script: leafA, controlBlock: wrongVersion },
      { script: leafA, controlBlock: shallow, proprietary: true },
      { script: leafA, controlBlock: rootControlBlock },
      { script: leafA, controlBlock: unrelated, proprietary: true },
    ])
    const finalized = finalizeP2mrPsbt(sign(psbt, [{ pubkey: keyA, leafHash: hashA }]))
    expect(finalWitness(finalized)).toEqual([hex(signatureOf(keyA)), hex(leafA), hex(shallow)])
  })
})

describe('shape 5: multi_a leaves', () => {
  it.each([
    ['A', keyA, ['', hex(signatureOf(keyA))]],
    ['B', keyB, [hex(signatureOf(keyB)), '']],
  ])('finalizes multi_a(1, A, B) signed by key %s', (_name, pubkey, stack) => {
    const script = multiALeafScript(1, [keyA, keyB])
    const leafHash = p2mrLeafHash(P2MR_LEAF_VERSION_V1, script)
    const finalized = finalizeP2mrPsbt(sign(psbtFor(leafHash, [{ script, controlBlock: rootControlBlock }]), [{ pubkey, leafHash }]))
    const witness = finalWitness(finalized)
    expect(witness).toEqual([...stack, hex(script), hex(rootControlBlock)])
    expect(satisfiesMultiA(witness, [keyA, keyB], 1)).toBe(true)
    expect(() => extractP2mrTransaction(finalized)).not.toThrow()
  })

  it.each([
    [1, [keyA, keyB]],
    [2, [keyA, keyB, keyC]],
  ])('places signatures from the last key until %i are placed, as Core SignP2MRScript does', (threshold, keys) => {
    const script = multiALeafScript(threshold, keys)
    const leafHash = p2mrLeafHash(P2MR_LEAF_VERSION_V1, script)
    // Every key has a signature: the first keys' are on the PSBT already, and the
    // last `threshold` keys sign now (the preflight refuses a plan finalize leaves out).
    const unplaced = keys.slice(0, keys.length - threshold)
    const psbt = psbtFor(
      leafHash,
      [{ script, controlBlock: rootControlBlock }],
      unplaced.map(pubkey => encodeP2mrPsbtScriptSigField(pubkey, leafHash, signatureOf(pubkey)))
    )
    const placed = keys.slice(keys.length - threshold)
    const witness = finalWitness(finalizeP2mrPsbt(sign(psbt, placed.map(pubkey => ({ pubkey, leafHash })))))
    const expected = keys.map((key, index) => (index >= keys.length - threshold ? hex(signatureOf(key)) : ''))
    expect(witness.slice(0, -2)).toEqual(expected.reverse())
    expect(satisfiesMultiA(witness, keys, threshold)).toBe(true)
  })

  it('leaves a partly signed multi_a leaf for the co-signer, then finalizes it', () => {
    const script = multiALeafScript(2, [keyA, keyB])
    const leafHash = p2mrLeafHash(P2MR_LEAF_VERSION_V1, script)
    const halfSigned = sign(psbtFor(leafHash, [{ script, controlBlock: rootControlBlock }]), [{ pubkey: keyA, leafHash }])
    expectProtocolError(
      () => finalizeP2mrPsbt(halfSigned),
      'INVALID_PSBT',
      /no committed P2MR leaf has enough signatures to finalize/
    )
    const witness = finalWitness(finalizeP2mrPsbt(sign(halfSigned, [{ pubkey: keyB, leafHash }])))
    expect(witness).toEqual([hex(signatureOf(keyB)), hex(signatureOf(keyA)), hex(script), hex(rootControlBlock)])
    expect(satisfiesMultiA(witness, [keyA, keyB], 2)).toBe(true)
  })
})

describe('inputs finalize always rejects are refused before the signer runs', () => {
  it('refuses an input carrying a non-empty final scriptSig', () => {
    const psbt = psbtFor(hashA, [{ script: leafA, controlBlock: rootControlBlock }], [
      { key: Uint8Array.of(0x07), value: Uint8Array.of(0x51) },
    ])
    const keys = [{ inputIndex: 0, pubkey: keyA, leafHash: hashA }]
    const signer = vi.fn(() => signatureOf(keyA))
    const message = /input 0: a P2MR input cannot carry a final scriptSig/
    expectProtocolError(() => validateP2mrSigningPlans({ psbt, keys }), 'INVALID_PSBT', message)
    expectProtocolError(() => signP2mrPsbt({ psbt, keys, sign: signer }), 'INVALID_PSBT', message)
    expect(signer).not.toHaveBeenCalled()
    expectProtocolError(() => finalizeP2mrPsbt(psbt), 'INVALID_PSBT', message)
  })

  it('refuses a leaf whose only control blocks do not commit, with INVALID_PSBT', () => {
    const wrongVersion = Uint8Array.of(0x41)
    const psbt = psbtFor(hashA, [{ script: leafA, controlBlock: wrongVersion }])
    const keys = [{ inputIndex: 0, pubkey: keyA, leafHash: hashA }]
    const signer = vi.fn(() => signatureOf(keyA))
    const message = /input 0: P2MR control block does not commit to the witness UTXO program/
    expectProtocolError(() => signP2mrPsbt({ psbt, keys, sign: signer }), 'INVALID_PSBT', message)
    expect(signer).not.toHaveBeenCalled()
    psbt.inputs[0]!.push(encodeP2mrPsbtScriptSigField(keyA, hashA, signatureOf(keyA)))
    expectProtocolError(() => finalizeP2mrPsbt(psbt), 'INVALID_PSBT', message)
  })
})

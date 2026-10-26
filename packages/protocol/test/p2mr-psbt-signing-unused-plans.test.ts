import { describe, expect, it, vi } from 'vitest'

import {
  P2MR_LEAF_VERSION_V1,
  PQC_SIGNATURE_BYTES,
  PSBT_IN_FINAL_SCRIPTWITNESS,
  QbitProtocolError,
  SIGHASH_ALL,
  SIGHASH_DEFAULT,
  buildControlBlock,
  bytesToHex,
  createP2mrPsbt,
  encodeP2mrPsbtLeafScriptField,
  encodeP2mrPsbtScriptSigField,
  finalizeP2mrPsbt,
  multiALeafScript,
  p2mrBranchHash,
  p2mrLeafHash,
  p2mrScriptPubKey,
  signP2mrPsbt,
  singleKeyLeafScript,
  validateP2mrSigningPlans,
  type P2mrSigningKey,
  type Psbt,
  type PsbtKeyValue,
} from '../src/index'

// Unused plans: the preflight checked each plan on its own, so it passed
// plans whose signatures finalizeP2mrPsbt then left out of the witness, and a
// stateful signer spent a key use for nothing. qbit Core signs only the leaf it
// finalizes and stops at the threshold (sign.cpp:592-613, :729-741). The
// preflight now runs finalize's own selection over the input's signatures plus
// this call's plans and refuses the whole call, before the first signer call,
// when the chosen witness leaves a plan out.

const userKey = new Uint8Array(32).fill(0x90)
/** A counterparty or recovery key; pk(otherKey) sorts before pk(userKey). */
const otherKey = new Uint8Array(32).fill(0x10)
/** Sorts after pk(userKey). */
const lateKey = new Uint8Array(32).fill(0xa0)
const key1 = new Uint8Array(32).fill(0x31)
const key2 = new Uint8Array(32).fill(0x32)
const key3 = new Uint8Array(32).fill(0x33)

const hex = bytesToHex
const leafHashOf = (script: Uint8Array): Uint8Array => p2mrLeafHash(P2MR_LEAF_VERSION_V1, script)
const controlBlock = (path: readonly Uint8Array[]): Uint8Array => buildControlBlock(P2MR_LEAF_VERSION_V1, path)

/** A distinct signature per (pubkey, leaf hash), so the witness shows which were placed. */
const signatureOf = (pubkey: Uint8Array, leafHash: Uint8Array): Uint8Array =>
  Uint8Array.from({ length: PQC_SIGNATURE_BYTES }, (_, i) => (pubkey[i % 32]! ^ leafHash[(i * 7) % 32]! ^ i) & 0xff)
const sigEntry = (pubkey: Uint8Array, leafHash: Uint8Array, hashType: number = SIGHASH_DEFAULT): PsbtKeyValue =>
  encodeP2mrPsbtScriptSigField(pubkey, leafHash, signatureOf(pubkey, leafHash), hashType)

interface InputSpec {
  root: Uint8Array
  leaves: readonly { script: Uint8Array; controlBlock: Uint8Array }[]
  extra?: readonly PsbtKeyValue[]
}

/** A PSBT spending one P2MR output per spec, each input carrying exactly its leaves and then `extra`. */
function psbtFor(...specs: readonly InputSpec[]): Psbt {
  const psbt = createP2mrPsbt({
    inputs: specs.map((spec, vout) => ({
      prevout: { txid: new Uint8Array(32).fill(0x5c), vout },
      witnessUtxo: { value: 100_000n, scriptPubKey: p2mrScriptPubKey(spec.root) },
      leafScript: spec.leaves[0]!.script,
      controlBlock: spec.leaves[0]!.controlBlock,
    })),
    outputs: [{ value: 90_000n, scriptPubKey: p2mrScriptPubKey(specs[0]!.root) }],
  })
  specs.forEach((spec, index) => {
    psbt.inputs[index] = [
      psbt.inputs[index]![0]!,
      ...spec.leaves.map(leaf => encodeP2mrPsbtLeafScriptField(leaf.controlBlock, leaf.script)),
      ...(spec.extra ?? []),
    ]
  })
  return psbt
}

const plan = (pubkey: Uint8Array, leafHash: Uint8Array, inputIndex = 0): P2mrSigningKey => ({
  inputIndex,
  pubkey,
  leafHash,
})

function signerSpy() {
  return vi.fn((_sighash: Uint8Array, context: { pubkey: Uint8Array; leafHash: Uint8Array }) =>
    signatureOf(context.pubkey, context.leafHash)
  )
}

/** Preflight, then sign: every plan must reach the signer once. */
function sign(psbt: Psbt, keys: readonly P2mrSigningKey[], hashType?: number): Psbt {
  const plans = keys.map(key => (hashType === undefined ? key : { ...key, hashType }))
  const options = hashType === undefined ? {} : { allowNonDefaultSighash: true }
  validateP2mrSigningPlans({ psbt, keys: plans, ...options })
  const signer = signerSpy()
  const result = signP2mrPsbt({ psbt, keys: plans, sign: signer, ...options })
  expect(signer).toHaveBeenCalledTimes(plans.length)
  return result.psbt
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

function unusedPlanMessage(inputIndex: number, pubkey: Uint8Array, leafHash: Uint8Array): RegExp {
  return new RegExp(
    `^input ${inputIndex}: finalizeP2mrPsbt would not use the signature planned for pubkey ${hex(pubkey)} ` +
      `and leaf hash ${hex(leafHash)}: `
  )
}

function severalLeavesMessage(inputIndex: number, leaves: number): RegExp {
  return new RegExp(
    `^input ${inputIndex}: this call plans signatures on ${leaves} leaves and completes none; ` +
      'finalizeP2mrPsbt uses one leaf$'
  )
}

/** Both entry points refuse with `message`, and the signer is never called. */
function expectRefused(psbt: Psbt, keys: readonly P2mrSigningKey[], message: RegExp, hashType?: number): void {
  const plans = keys.map(key => (hashType === undefined ? key : { ...key, hashType }))
  const options = hashType === undefined ? {} : { allowNonDefaultSighash: true }
  const signer = signerSpy()
  expectProtocolError(() => validateP2mrSigningPlans({ psbt, keys: plans, ...options }), 'INVALID_PSBT', message)
  expectProtocolError(() => signP2mrPsbt({ psbt, keys: plans, sign: signer, ...options }), 'INVALID_PSBT', message)
  expect(signer).not.toHaveBeenCalled()
}

function readCompactSize(bytes: Uint8Array, offset: number): [number, number] {
  const first = bytes[offset]!
  if (first < 0xfd) return [first, offset + 1]
  if (first === 0xfd) return [bytes[offset + 1]! | (bytes[offset + 2]! << 8), offset + 3]
  throw new Error('test witness parser handles items below 64 KiB only')
}

/** The final witness stack of an input, as hex items. */
function finalWitness(psbt: Psbt, inputIndex = 0): string[] {
  const entry = psbt.inputs[inputIndex]!.find(
    item => item.key.length === 1 && item.key[0] === PSBT_IN_FINAL_SCRIPTWITNESS
  )
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

describe('(a) a two-leaf wallet address carrying a signature for the other leaf', () => {
  const leafUser = singleKeyLeafScript(userKey)
  const hashUser = leafHashOf(leafUser)
  // A dApp-supplied signature: finalize does not verify it, so its bytes do not matter.
  const garbage = new Uint8Array(PQC_SIGNATURE_BYTES).fill(0xee)

  it.each([
    ['ties with it and sorts first', otherKey, false],
    ['is shallower, though it sorts later', lateKey, true],
  ])('refuses the user plan when the other leaf %s, before any signer call', (_case, counterKey, counterShallower) => {
    const leafOther = singleKeyLeafScript(counterKey)
    const hashOther = leafHashOf(leafOther)
    const otherSig = encodeP2mrPsbtScriptSigField(counterKey, hashOther, garbage)
    let spec: InputSpec
    if (counterShallower) {
      // mr({pk(other), {pk(user), pk(key3)}})
      const hash3 = leafHashOf(singleKeyLeafScript(key3))
      const inner = p2mrBranchHash(hashUser, hash3)
      spec = {
        root: p2mrBranchHash(hashOther, inner),
        leaves: [
          { script: leafUser, controlBlock: controlBlock([hash3, hashOther]) },
          { script: leafOther, controlBlock: controlBlock([inner]) },
        ],
        extra: [otherSig],
      }
    } else {
      // mr({pk(user), pk(other)})
      spec = {
        root: p2mrBranchHash(hashUser, hashOther),
        leaves: [
          { script: leafUser, controlBlock: controlBlock([hashOther]) },
          { script: leafOther, controlBlock: controlBlock([hashUser]) },
        ],
        extra: [otherSig],
      }
    }
    const psbt = psbtFor(spec)
    expectRefused(psbt, [plan(userKey, hashUser)], unusedPlanMessage(0, userKey, hashUser))
    // This is the witness finalize would build, so the user's signature would be dropped.
    expect(finalWitness(finalizeP2mrPsbt(psbt))[0]).toBe(hex(garbage))
  })

  it('signs when the user leaf is the one finalize chooses, dropping the other signature', () => {
    // mr({pk(user), {pk(other), pk(key3)}}): the user leaf is shallower.
    const leafOther = singleKeyLeafScript(otherKey)
    const hashOther = leafHashOf(leafOther)
    const hash3 = leafHashOf(singleKeyLeafScript(key3))
    const inner = p2mrBranchHash(hashOther, hash3)
    const userControl = controlBlock([inner])
    const psbt = psbtFor({
      root: p2mrBranchHash(hashUser, inner),
      leaves: [
        { script: leafOther, controlBlock: controlBlock([hash3, hashUser]) },
        { script: leafUser, controlBlock: userControl },
      ],
      extra: [encodeP2mrPsbtScriptSigField(otherKey, hashOther, garbage)],
    })
    const finalized = finalizeP2mrPsbt(sign(psbt, [plan(userKey, hashUser)]))
    expect(finalWitness(finalized)).toEqual([hex(signatureOf(userKey, hashUser)), hex(leafUser), hex(userControl)])
  })
})

describe('(b) a multi_a leaf whose threshold the PSBT already meets', () => {
  const script = multiALeafScript(2, [key1, key2, key3])
  const leafHash = leafHashOf(script)
  const leaves = [{ script, controlBlock: controlBlock([]) }]

  it('refuses a key the witness has no room for', () => {
    // Core places signatures from the last key: key3 and key2 fill the threshold.
    const psbt = psbtFor({ root: leafHash, leaves, extra: [sigEntry(key2, leafHash), sigEntry(key3, leafHash)] })
    expectRefused(psbt, [plan(key1, leafHash)], unusedPlanMessage(0, key1, leafHash))
  })

  it('signs a later key, which Core also places first, even though an earlier signature is then dropped', () => {
    // The guarantee covers this call's signatures: key1's is already on the PSBT.
    const psbt = psbtFor({ root: leafHash, leaves, extra: [sigEntry(key1, leafHash), sigEntry(key2, leafHash)] })
    const witness = finalWitness(finalizeP2mrPsbt(sign(psbt, [plan(key3, leafHash)])))
    expect(witness.slice(0, 3)).toEqual([hex(signatureOf(key3, leafHash)), hex(signatureOf(key2, leafHash)), ''])
  })
})

describe('(c) more plans in one call than the witness places', () => {
  it('refuses two plans on a 1-of-2 leaf, naming the one left out', () => {
    const script = multiALeafScript(1, [key1, key2])
    const leafHash = leafHashOf(script)
    const psbt = psbtFor({ root: leafHash, leaves: [{ script, controlBlock: controlBlock([]) }] })
    expectRefused(psbt, [plan(key1, leafHash), plan(key2, leafHash)], unusedPlanMessage(0, key1, leafHash))
    expectRefused(psbt, [plan(key2, leafHash), plan(key1, leafHash)], unusedPlanMessage(0, key1, leafHash))
    const witness = finalWitness(finalizeP2mrPsbt(sign(psbt, [plan(key2, leafHash)])))
    expect(witness.slice(0, 2)).toEqual([hex(signatureOf(key2, leafHash)), ''])
  })

  it('refuses plans on both leaves of a two-leaf tree', () => {
    const leafOther = singleKeyLeafScript(otherKey)
    const leafUser = singleKeyLeafScript(userKey)
    const hashOther = leafHashOf(leafOther)
    const hashUser = leafHashOf(leafUser)
    const psbt = psbtFor({
      root: p2mrBranchHash(hashOther, hashUser),
      leaves: [
        { script: leafUser, controlBlock: controlBlock([hashOther]) },
        { script: leafOther, controlBlock: controlBlock([hashUser]) },
      ],
    })
    expectRefused(psbt, [plan(userKey, hashUser), plan(otherKey, hashOther)], unusedPlanMessage(0, userKey, hashUser))
  })

  it('refuses a plan that completes a 2-of-3 leaf only alongside one finalize does not need', () => {
    const script = multiALeafScript(2, [key1, key2, key3])
    const leafHash = leafHashOf(script)
    const psbt = psbtFor({
      root: leafHash,
      leaves: [{ script, controlBlock: controlBlock([]) }],
      extra: [sigEntry(key3, leafHash)],
    })
    expectRefused(psbt, [plan(key1, leafHash), plan(key2, leafHash)], unusedPlanMessage(0, key1, leafHash))
  })

  it('refuses with a non-default sighash type too', () => {
    const script = multiALeafScript(1, [key1, key2])
    const leafHash = leafHashOf(script)
    const psbt = psbtFor({ root: leafHash, leaves: [{ script, controlBlock: controlBlock([]) }] })
    expectRefused(
      psbt,
      [plan(key1, leafHash), plan(key2, leafHash)],
      unusedPlanMessage(0, key1, leafHash),
      SIGHASH_ALL
    )
    const witness = finalWitness(finalizeP2mrPsbt(sign(psbt, [plan(key2, leafHash)], SIGHASH_ALL)))
    expect(witness[0]).toBe(hex(signatureOf(key2, leafHash)) + '01')
  })
})

// Plans on several leaves: with no leaf complete, the preflight accepted plans on
// several leaves of one input. A witness reveals one leaf and a signature
// commits to its leaf hash, so at least one of those key uses is wasted. Core
// signs only its best partial plan for this reason (sign.cpp:743-756).
describe('(d) plans on several leaves of one input that complete none', () => {
  // mr({multi_a(2, user, key1), {multi_a(2, user, key2), pk(key3)}}): a dApp PSBT listing every leaf.
  const leafA = multiALeafScript(2, [userKey, key1])
  const leafB = multiALeafScript(2, [userKey, key2])
  const leaf3 = singleKeyLeafScript(key3)
  const hashA = leafHashOf(leafA)
  const hashB = leafHashOf(leafB)
  const hash3 = leafHashOf(leaf3)
  const inner = p2mrBranchHash(hashB, hash3)
  const spec: InputSpec = {
    root: p2mrBranchHash(hashA, inner),
    leaves: [
      { script: leafA, controlBlock: controlBlock([inner]) },
      { script: leafB, controlBlock: controlBlock([hash3, hashA]) },
      { script: leaf3, controlBlock: controlBlock([hashB, hashA]) },
    ],
  }

  it("refuses the user's key on every leaf that holds it", () => {
    expectRefused(psbtFor(spec), [plan(userKey, hashA), plan(userKey, hashB)], severalLeavesMessage(0, 2))
  })

  it('refuses different keys on different leaves, and on the second input of several', () => {
    const single = singleKeyLeafScript(otherKey)
    const singleHash = leafHashOf(single)
    const psbt = psbtFor({ root: singleHash, leaves: [{ script: single, controlBlock: controlBlock([]) }] }, spec)
    expectRefused(
      psbt,
      [plan(otherKey, singleHash, 0), plan(userKey, hashA, 1), plan(key2, hashB, 1)],
      severalLeavesMessage(1, 2)
    )
  })

  it('accepts a partial plan on one leaf, and a separate call for another leaf', () => {
    const half = sign(psbtFor(spec), [plan(userKey, hashA)])
    expectProtocolError(() => finalizeP2mrPsbt(half), 'INVALID_PSBT', /no committed P2MR leaf has enough signatures/)
    // Hedging across calls is the caller's choice; each call spends one key use on one leaf.
    const both = sign(half, [plan(userKey, hashB)])
    const witness = finalWitness(finalizeP2mrPsbt(sign(both, [plan(key2, hashB)])))
    expect(witness.slice(0, 2)).toEqual([hex(signatureOf(key2, hashB)), hex(signatureOf(userKey, hashB))])
  })

  it("counts only this call's leaves, not a partial signature already on another leaf", () => {
    const psbt = psbtFor({ ...spec, extra: [sigEntry(key1, hashA)] })
    const half = sign(psbt, [plan(userKey, hashB)])
    const witness = finalWitness(finalizeP2mrPsbt(sign(half, [plan(key2, hashB)])))
    expect(witness.slice(0, 2)).toEqual([hex(signatureOf(key2, hashB)), hex(signatureOf(userKey, hashB))])
  })

  it('accepts one leaf committed at two tree positions as one leaf', () => {
    // mr({multi_a(2, user, key1), {multi_a(2, user, key1), pk(key3)}}): one leaf hash, two control blocks.
    const twice = p2mrBranchHash(hashA, hash3)
    const psbt = psbtFor({
      root: p2mrBranchHash(hashA, twice),
      leaves: [
        { script: leafA, controlBlock: controlBlock([twice]) },
        { script: leafA, controlBlock: controlBlock([hash3, hashA]) },
        { script: leaf3, controlBlock: controlBlock([hashA, hashA]) },
      ],
    })
    const half = sign(psbt, [plan(userKey, hashA)])
    const witness = finalWitness(finalizeP2mrPsbt(sign(half, [plan(key1, hashA)])))
    expect(witness.slice(0, 3)).toEqual([hex(signatureOf(key1, hashA)), hex(signatureOf(userKey, hashA)), hex(leafA)])
  })
})

describe('plans the witness places', () => {
  it('accepts a partial multi_a signature, and the co-signer completes the leaf', () => {
    const script = multiALeafScript(2, [key1, key2, key3])
    const leafHash = leafHashOf(script)
    const psbt = psbtFor({ root: leafHash, leaves: [{ script, controlBlock: controlBlock([]) }] })
    const half = sign(psbt, [plan(key1, leafHash)])
    expectProtocolError(
      () => finalizeP2mrPsbt(half),
      'INVALID_PSBT',
      /no committed P2MR leaf has enough signatures to finalize/
    )
    const witness = finalWitness(finalizeP2mrPsbt(sign(half, [plan(key3, leafHash)])))
    expect(witness.slice(0, 3)).toEqual([hex(signatureOf(key3, leafHash)), '', hex(signatureOf(key1, leafHash))])
  })

  it('accepts plans that complete a leaf together', () => {
    const script = multiALeafScript(2, [key1, key2])
    const leafHash = leafHashOf(script)
    const psbt = psbtFor({ root: leafHash, leaves: [{ script, controlBlock: controlBlock([]) }] })
    const witness = finalWitness(finalizeP2mrPsbt(sign(psbt, [plan(key1, leafHash), plan(key2, leafHash)])))
    expect(witness.slice(0, 2)).toEqual([hex(signatureOf(key2, leafHash)), hex(signatureOf(key1, leafHash))])
  })

  it('accepts a single-key spend with an unrelated signature on another leaf that does not commit', () => {
    const leafUser = singleKeyLeafScript(userKey)
    const leafOther = singleKeyLeafScript(otherKey)
    const hashUser = leafHashOf(leafUser)
    const hashOther = leafHashOf(leafOther)
    const psbt = psbtFor({
      root: hashUser,
      leaves: [
        { script: leafUser, controlBlock: controlBlock([]) },
        { script: leafOther, controlBlock: controlBlock([new Uint8Array(32)]) },
      ],
      extra: [sigEntry(otherKey, hashOther)],
    })
    const witness = finalWitness(finalizeP2mrPsbt(sign(psbt, [plan(userKey, hashUser)])))
    expect(witness[0]).toBe(hex(signatureOf(userKey, hashUser)))
  })
})

describe('the whole call is refused', () => {
  it('signs nothing when one input of several would leave a plan out', () => {
    const leafUser = singleKeyLeafScript(userKey)
    const hashUser = leafHashOf(leafUser)
    const script = multiALeafScript(1, [key1, key2])
    const leafHash = leafHashOf(script)
    const psbt = psbtFor(
      { root: hashUser, leaves: [{ script: leafUser, controlBlock: controlBlock([]) }] },
      { root: leafHash, leaves: [{ script, controlBlock: controlBlock([]) }], extra: [sigEntry(key2, leafHash)] }
    )
    expectRefused(psbt, [plan(userKey, hashUser, 0), plan(key1, leafHash, 1)], unusedPlanMessage(1, key1, leafHash))
  })
})

// Random trees of pk / multi_a leaves over four keys, with random existing
// signatures and one to three plans. A plan set the preflight accepts must,
// once signed, either leave every leaf incomplete or be placed in full in the
// witness finalize builds; a refusal for an unused plan must be one finalize
// would indeed leave out.
describe('the preflight agrees with finalize on random PSBTs', () => {
  const keys = [key1, key2, key3, userKey]
  let seed = 0x2f6b49a1
  const random = (): number => {
    seed ^= seed << 13
    seed >>>= 0
    seed ^= seed >>> 17
    seed ^= seed << 5
    seed >>>= 0
    return seed / 0x100000000
  }
  const below = (n: number): number => Math.floor(random() * n)
  const shuffled = <T,>(items: readonly T[]): T[] => {
    const out = [...items]
    for (let i = out.length - 1; i > 0; i -= 1) {
      const j = below(i + 1)
      ;[out[i], out[j]] = [out[j]!, out[i]!]
    }
    return out
  }

  interface TreeLeaf {
    script: Uint8Array
    keys: Uint8Array[]
  }
  interface Placed {
    leaf: TreeLeaf
    path: Uint8Array[]
  }

  function randomLeaf(): TreeLeaf {
    if (random() < 0.4) {
      const key = keys[below(keys.length)]!
      return { script: singleKeyLeafScript(key), keys: [key] }
    }
    const leafKeys = shuffled(keys).slice(0, 1 + below(3))
    return { script: multiALeafScript(1 + below(leafKeys.length), leafKeys), keys: leafKeys }
  }

  function buildTree(leaves: readonly TreeLeaf[]): { hash: Uint8Array; placed: Placed[] } {
    if (leaves.length === 1) return { hash: leafHashOf(leaves[0]!.script), placed: [{ leaf: leaves[0]!, path: [] }] }
    const cut = 1 + below(leaves.length - 1)
    const left = buildTree(leaves.slice(0, cut))
    const right = buildTree(leaves.slice(cut))
    return {
      hash: p2mrBranchHash(left.hash, right.hash),
      placed: [
        ...left.placed.map(({ leaf, path }) => ({ leaf, path: [...path, right.hash] })),
        ...right.placed.map(({ leaf, path }) => ({ leaf, path: [...path, left.hash] })),
      ],
    }
  }

  it('on 600 shapes', () => {
    const outcomes = { accepted: 0, completed: 0, refused: 0, severalLeaves: 0 }
    for (let round = 0; round < 600; round += 1) {
      const tree = buildTree(Array.from({ length: 1 + below(4) }, randomLeaf))
      // A leaf repeated as its own sibling has one control block for both places: keep one record.
      const records = new Set<string>()
      const placed = tree.placed.filter((position, index) => {
        const id = hex(controlBlock(position.path)) + hex(position.leaf.script)
        if (records.has(id) || (index > 0 && random() >= 0.85)) return false
        records.add(id)
        return true
      })
      const existing = new Set<string>()
      const extra: PsbtKeyValue[] = []
      const candidates: { pubkey: Uint8Array; leafHash: Uint8Array }[] = []
      for (const { leaf } of placed) {
        const leafHash = leafHashOf(leaf.script)
        for (const pubkey of leaf.keys) {
          const id = hex(pubkey) + hex(leafHash)
          if (existing.has(id) || candidates.some(c => hex(c.pubkey) + hex(c.leafHash) === id)) continue
          if (random() < 0.3) {
            existing.add(id)
            extra.push(sigEntry(pubkey, leafHash))
          } else {
            candidates.push({ pubkey, leafHash })
          }
        }
      }
      if (candidates.length === 0) continue
      const psbt = psbtFor({
        root: tree.hash,
        leaves: placed.map(({ leaf, path }) => ({ script: leaf.script, controlBlock: controlBlock(path) })),
        extra,
      })
      const plans = shuffled(candidates)
        .slice(0, 1 + below(Math.min(3, candidates.length)))
        .map(({ pubkey, leafHash }) => plan(pubkey, leafHash))
      const describeShape = `round ${round}`

      let refusal: Error | undefined
      try {
        validateP2mrSigningPlans({ psbt, keys: plans })
      } catch (error) {
        refusal = error as Error
      }

      if (refusal === undefined) {
        outcomes.accepted += 1
        const signed = sign(psbt, plans)
        let witness: string[]
        try {
          witness = finalWitness(finalizeP2mrPsbt(signed))
        } catch (error) {
          expect((error as Error).message, describeShape).toMatch(/no committed P2MR leaf has enough signatures/)
          // A call that completes no leaf spends key uses on one leaf only.
          expect(new Set(plans.map(p => hex(p.leafHash))).size, describeShape).toBe(1)
          continue
        }
        outcomes.completed += 1
        for (const { pubkey, leafHash } of plans) {
          expect(witness, describeShape).toContain(hex(signatureOf(pubkey, leafHash)))
        }
        continue
      }

      outcomes.refused += 1
      expect(refusal, describeShape).toBeInstanceOf(QbitProtocolError)
      const allSigned = psbtFor({
        root: tree.hash,
        leaves: placed.map(({ leaf, path }) => ({ script: leaf.script, controlBlock: controlBlock(path) })),
        extra: [...extra, ...plans.map(({ pubkey, leafHash }) => sigEntry(pubkey, leafHash))],
      })
      const leafCount = new Set(plans.map(p => hex(p.leafHash))).size
      if (severalLeavesMessage(0, leafCount).test(refusal.message)) {
        // With every planned signature on the PSBT, finalize still completes no leaf.
        outcomes.severalLeaves += 1
        expect(leafCount, describeShape).toBeGreaterThan(1)
        expect(() => finalizeP2mrPsbt(allSigned), describeShape).toThrow(/no committed P2MR leaf has enough signatures/)
        continue
      }
      const named = /pubkey ([0-9a-f]{64}) and leaf hash ([0-9a-f]{64})/.exec(refusal.message)
      expect(named, `${describeShape}: ${refusal.message}`).not.toBeNull()
      // With every planned signature on the PSBT, finalize completes a witness without the named one.
      const namedPlan = plans.find(p => hex(p.pubkey) === named![1] && hex(p.leafHash) === named![2])
      expect(namedPlan, describeShape).toBeDefined()
      expect(finalWitness(finalizeP2mrPsbt(allSigned)), describeShape).not.toContain(
        hex(signatureOf(namedPlan!.pubkey, namedPlan!.leafHash))
      )
    }
    expect(outcomes.accepted).toBeGreaterThan(50)
    expect(outcomes.completed).toBeGreaterThan(50)
    expect(outcomes.refused).toBeGreaterThan(50)
    expect(outcomes.severalLeaves).toBeGreaterThan(0)
  })
})

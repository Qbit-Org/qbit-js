import { QbitProtocolError } from './errors'
import {
  P2MR_PROGRAM_BYTES,
  P2MR_LEAF_VERSION_MASK,
  P2MR_LEAF_VERSION_V1,
  P2MR_CONTROL_BASE_BYTES,
  P2MR_CONTROL_NODE_BYTES,
  P2MR_CONTROL_MAX_NODE_COUNT,
  OP_0,
  OP_1,
  OP_CHECKSIGPQC,
  OP_CHECKSIGADD,
  OP_NUMEQUAL,
} from './constants'
import { P2MR_V1_MAX_MULTI_A_THRESHOLD, P2MR_MAX_MULTI_A_PUBKEYS } from './consensus'
import {
  concatByteList,
  taggedHash,
  compactSize,
  copyBytes,
  concatBytes,
  compareBytes,
  assertBytes,
  assertByteLength,
} from './bytes'

/**
 * Build a P2MR single-key (`pk`) leaf script: `PUSH32 <pk32> OP_CHECKSIGPQC`.
 *
 * @param pk32 - The 32-byte PQC public key.
 * @returns The 34-byte leaf script.
 * @throws {QbitProtocolError} `INVALID_BYTES` if `pk32` is not a 32-byte
 * `Uint8Array`.
 *
 * @remarks
 * See [Features](https://github.com/Qbit-Org/qbit-js/blob/main/packages/protocol/docs/features.md).
 *
 * @category Scripts and Merkle
 */
export function singleKeyLeafScript(pk32: Uint8Array): Uint8Array {
  assertByteLength(pk32, P2MR_PROGRAM_BYTES, 'P2MR pubkey')
  return concatBytes(Uint8Array.of(P2MR_PROGRAM_BYTES), pk32, Uint8Array.of(OP_CHECKSIGPQC))
}

/**
 * Build a P2MR v1 `multi_a` leaf script: `<pk0> OP_CHECKSIGPQC <pk1> OP_CHECKSIGADD
 * ... <threshold> OP_NUMEQUAL`. Pubkeys are used in the order given (sort them
 * first for `sortedmulti_a`).
 *
 * Throws a `RangeError` unless `1 <= threshold <= pubkeys.length <= 999` and
 * `threshold <= P2MR_V1_MAX_MULTI_A_THRESHOLD` (35). A leaf needing 36 or more
 * signatures can never be spent: its initial witness stack always exceeds
 * qbit Core's 128 KiB consensus limit, so coins sent to it are lost.
 * Thresholds up to 999 were previously accepted.
 *
 * @param threshold - Signatures required, from 1 to 35.
 * @param pubkeys - The 32-byte public keys, 1 to 999 of them, in script order.
 * @returns The leaf script.
 * @throws {RangeError} if `threshold` is not an integer from 1 to
 * `min(pubkeys.length, 35)`, or `pubkeys` does not hold 1 to 999 keys.
 * @throws {QbitProtocolError} `INVALID_BYTES` if a key is not a 32-byte
 * `Uint8Array`.
 *
 * @remarks
 * See [P2MR Descriptors](https://github.com/Qbit-Org/qbit-js/blob/main/packages/protocol/docs/p2mr-descriptors.md).
 *
 * @category Scripts and Merkle
 */
export function multiALeafScript(threshold: number, pubkeys: readonly Uint8Array[]): Uint8Array {
  return buildMultiALeafScript(threshold, pubkeys, true)
}

// Descriptor expansion passes capThreshold = false: it still needs a k > 35
// leaf's hash so that a tree with another spendable leaf commits to the same
// root as qbit Core.
function buildMultiALeafScript(threshold: number, pubkeys: readonly Uint8Array[], capThreshold: boolean): Uint8Array {
  if (!Number.isInteger(threshold) || threshold < 1) {
    throw new RangeError('threshold must be a positive integer')
  }
  if (pubkeys.length < 1 || pubkeys.length > P2MR_MAX_MULTI_A_PUBKEYS) {
    throw new RangeError(`multi_a requires 1..${P2MR_MAX_MULTI_A_PUBKEYS} pubkeys`)
  }
  if (threshold > pubkeys.length) {
    throw new RangeError('threshold cannot exceed pubkey count')
  }
  // Mirrors qbit Core's builders and signer (src/script/p2mr_sizing.h:18-24,
  // src/script/sign.cpp:511), which never produce a k > 35 multi_a spend.
  if (capThreshold && threshold > P2MR_V1_MAX_MULTI_A_THRESHOLD) {
    throw new RangeError(
      `multi_a threshold must not exceed ${P2MR_V1_MAX_MULTI_A_THRESHOLD} (P2MR v1 initial-stack consensus limit)`
    )
  }

  const chunks: Uint8Array[] = []
  for (const [index, pubkey] of pubkeys.entries()) {
    assertByteLength(pubkey, P2MR_PROGRAM_BYTES, `P2MR pubkey ${index}`)
    chunks.push(Uint8Array.of(P2MR_PROGRAM_BYTES), pubkey)
    chunks.push(Uint8Array.of(index === 0 ? OP_CHECKSIGPQC : OP_CHECKSIGADD))
  }
  chunks.push(scriptNumber(threshold), Uint8Array.of(OP_NUMEQUAL))
  return concatByteList(chunks)
}

/**
 * Hash a P2MR leaf: the tagged SHA-256, tag `P2MRLeaf`, of the leaf version
 * byte, the script's compact-size length and the script.
 *
 * @param leafVersion - The leaf version, an even uint8; normally
 * {@link P2MR_LEAF_VERSION_V1}.
 * @param script - The leaf script. Default empty.
 * @returns The 32-byte leaf hash.
 * @throws {RangeError} if `leafVersion` is not an integer from 0 to 255.
 * @throws {QbitProtocolError} `INVALID_SCRIPT` if `leafVersion` is odd, or
 * `INVALID_BYTES` if `script` is not a `Uint8Array`.
 *
 * @remarks
 * It hashes any script, including a `multi_a` leaf that can never be spent.
 * See [P2MR Descriptors](https://github.com/Qbit-Org/qbit-js/blob/main/packages/protocol/docs/p2mr-descriptors.md).
 *
 * @category Scripts and Merkle
 */
export function p2mrLeafHash(leafVersion: number, script: Uint8Array = new Uint8Array()): Uint8Array {
  assertLeafVersion(leafVersion)
  assertBytes(script, 'P2MR leaf script')
  return taggedHash('P2MRLeaf', Uint8Array.of(leafVersion), compactSize(script.length), script)
}

/**
 * Hash two sibling nodes into their parent: the tagged SHA-256, tag
 * `P2MRBranch`, of the two hashes in bytewise order, so the argument order
 * does not matter.
 *
 * @param a - One child's 32-byte hash.
 * @param b - The other child's 32-byte hash.
 * @returns The 32-byte branch hash.
 * @throws {QbitProtocolError} `INVALID_BYTES` if either hash is not a 32-byte
 * `Uint8Array`.
 *
 * @category Scripts and Merkle
 */
export function p2mrBranchHash(a: Uint8Array, b: Uint8Array): Uint8Array {
  assertByteLength(a, P2MR_PROGRAM_BYTES, 'left P2MR branch')
  assertByteLength(b, P2MR_PROGRAM_BYTES, 'right P2MR branch')
  const [first, second] = compareBytes(a, b) < 0 ? [a, b] : [b, a]
  return taggedHash('P2MRBranch', first, second)
}

/**
 * Compute the Merkle root a leaf hash reaches through its path of sibling
 * hashes, combining them with {@link p2mrBranchHash}.
 *
 * @param leafHash - The 32-byte leaf hash.
 * @param siblings - The 32-byte sibling hashes, nearest the leaf first, at
 * most 128.
 * @returns The 32-byte root: a copy of `leafHash` when `siblings` is empty.
 * @throws {RangeError} if there are more than 128 siblings.
 * @throws {QbitProtocolError} `INVALID_BYTES` if `leafHash` or a sibling is
 * not a 32-byte `Uint8Array`.
 *
 * @category Scripts and Merkle
 */
export function merkleRootFromPath(leafHash: Uint8Array, siblings: readonly Uint8Array[]): Uint8Array {
  assertByteLength(leafHash, P2MR_PROGRAM_BYTES, 'P2MR leaf hash')
  if (siblings.length > P2MR_CONTROL_MAX_NODE_COUNT) {
    throw new RangeError('P2MR path exceeds maximum depth')
  }
  let root = copyBytes(leafHash)
  for (const [index, sibling] of siblings.entries()) {
    assertByteLength(sibling, P2MR_CONTROL_NODE_BYTES, `P2MR sibling ${index}`)
    root = p2mrBranchHash(root, sibling)
  }
  return root
}

/**
 * Build a P2MR control block: the byte `leafVersion | 1`, then the sibling
 * hashes of the leaf's Merkle path.
 *
 * @param leafVersion - The leaf version, an even uint8. Default
 * {@link P2MR_LEAF_VERSION_V1}, which gives a first byte of `0xc1`.
 * @param siblings - The 32-byte sibling hashes, nearest the leaf first, at
 * most 128. Default none, for a tree whose only leaf is this one.
 * @returns The control block, `1 + 32 * siblings.length` bytes.
 * @throws {RangeError} if `leafVersion` is not an integer from 0 to 255, or
 * there are more than 128 siblings.
 * @throws {QbitProtocolError} `INVALID_SCRIPT` if `leafVersion` is odd, or
 * `INVALID_BYTES` if a sibling is not a 32-byte `Uint8Array`.
 *
 * @remarks
 * See [Features](https://github.com/Qbit-Org/qbit-js/blob/main/packages/protocol/docs/features.md).
 *
 * @category Scripts and Merkle
 */
export function buildControlBlock(
  leafVersion: number = P2MR_LEAF_VERSION_V1,
  siblings: readonly Uint8Array[] = []
): Uint8Array {
  assertLeafVersion(leafVersion)
  if (siblings.length > P2MR_CONTROL_MAX_NODE_COUNT) {
    throw new RangeError('P2MR control block exceeds maximum depth')
  }
  const chunks: Uint8Array[] = [Uint8Array.of(leafVersion | 1)]
  for (const [index, sibling] of siblings.entries()) {
    assertByteLength(sibling, P2MR_CONTROL_NODE_BYTES, `P2MR sibling ${index}`)
    chunks.push(sibling)
  }
  return concatByteList(chunks)
}

/**
 * Check a control block's shape and compute the Merkle root it places a leaf
 * under.
 *
 * It does not compare that root with anything: the leaf is in an output's tree
 * only if the result equals the output's witness program.
 *
 * @param controlBlock - One byte with the leaf version and a set low bit, then
 * 0 to 128 sibling hashes of 32 bytes.
 * @param leafHash - The 32-byte hash of the leaf.
 * @param expectedLeafVersion - If given, the leaf version in the control block
 * (its first byte `& 0xfe`) must equal it.
 * @returns The 32-byte Merkle root.
 * @throws {QbitProtocolError} `INVALID_SCRIPT` if the control block has the
 * wrong length, a clear low bit, or a leaf version other than
 * `expectedLeafVersion`.
 * @throws {QbitProtocolError} `INVALID_BYTES` if `controlBlock` is not a
 * `Uint8Array` or `leafHash` is not a 32-byte one.
 *
 * @category Scripts and Merkle
 */
export function verifyControlBlock(
  controlBlock: Uint8Array,
  leafHash: Uint8Array,
  expectedLeafVersion?: number
): Uint8Array {
  assertBytes(controlBlock, 'P2MR control block')
  if (
    controlBlock.length < P2MR_CONTROL_BASE_BYTES ||
    controlBlock.length > P2MR_CONTROL_BASE_BYTES + P2MR_CONTROL_NODE_BYTES * P2MR_CONTROL_MAX_NODE_COUNT ||
    (controlBlock.length - P2MR_CONTROL_BASE_BYTES) % P2MR_CONTROL_NODE_BYTES !== 0
  ) {
    throw new QbitProtocolError('INVALID_SCRIPT', 'invalid P2MR control block size')
  }
  const controlByte = controlBlock[0]
  if (controlByte === undefined || (controlByte & 1) !== 1) {
    throw new QbitProtocolError('INVALID_SCRIPT', 'P2MR control block bit 0 must be set')
  }
  const leafVersion = controlByte & P2MR_LEAF_VERSION_MASK
  assertLeafVersion(leafVersion)
  if (expectedLeafVersion !== undefined && leafVersion !== expectedLeafVersion) {
    throw new QbitProtocolError('INVALID_SCRIPT', 'P2MR control block leaf version mismatch')
  }

  const siblings: Uint8Array[] = []
  for (let offset = P2MR_CONTROL_BASE_BYTES; offset < controlBlock.length; offset += P2MR_CONTROL_NODE_BYTES) {
    siblings.push(copyBytes(controlBlock, offset, offset + P2MR_CONTROL_NODE_BYTES))
  }
  return merkleRootFromPath(leafHash, siblings)
}

function scriptNumber(value: number): Uint8Array {
  if (!Number.isInteger(value) || value < 0) {
    throw new RangeError('script number must be a non-negative integer')
  }
  if (value === 0) return Uint8Array.of(OP_0)
  if (value <= 16) return Uint8Array.of(OP_1 + value - 1)

  const bytes: number[] = []
  let remaining = value
  while (remaining > 0) {
    bytes.push(remaining & 0xff)
    remaining >>= 8
  }
  const last = bytes[bytes.length - 1]
  if (last === undefined) {
    throw new RangeError('script number encoding failed')
  }
  if ((last & 0x80) !== 0) bytes.push(0)
  if (bytes.length > 75) {
    throw new RangeError('script number too large for direct push')
  }
  return Uint8Array.of(bytes.length, ...bytes)
}

function assertLeafVersion(leafVersion: number): void {
  if (!Number.isInteger(leafVersion) || leafVersion < 0 || leafVersion > 0xff) {
    throw new RangeError('P2MR leaf version must be a uint8')
  }
  if ((leafVersion & 1) !== 0) {
    throw new QbitProtocolError('INVALID_SCRIPT', 'P2MR committed leaf version must be even')
  }
}

function assertP2mrControlBlockShape(controlBlock: Uint8Array): void {
  assertBytes(controlBlock, 'P2MR control block')
  if (
    controlBlock.length < P2MR_CONTROL_BASE_BYTES ||
    controlBlock.length > P2MR_CONTROL_BASE_BYTES + P2MR_CONTROL_NODE_BYTES * P2MR_CONTROL_MAX_NODE_COUNT ||
    (controlBlock.length - P2MR_CONTROL_BASE_BYTES) % P2MR_CONTROL_NODE_BYTES !== 0
  ) {
    throw new QbitProtocolError('INVALID_PSBT', 'P2MR control block has invalid size')
  }
  const controlByte = controlBlock[0]
  if (controlByte === undefined || (controlByte & 1) !== 1) {
    throw new QbitProtocolError('INVALID_PSBT', 'P2MR control byte bit 0 must be set')
  }
}

export { buildMultiALeafScript, assertLeafVersion, assertP2mrControlBlockShape }

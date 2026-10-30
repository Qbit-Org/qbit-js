import { QbitProtocolError } from './errors'
import { type QbitNetworkName, type QbitNetworkParams, qbitNetworks } from './networks'
import { P2MR_PROGRAM_BYTES, P2MR_LEAF_VERSION_V1, P2MR_CONTROL_MAX_NODE_COUNT } from './constants'
import { P2MR_V1_MAX_MULTI_A_THRESHOLD, P2MR_MAX_MULTI_A_PUBKEYS } from './consensus'
import { bytesToHex, hexToBytes, isBytesOfLength, readUint32Be, compareBytes, isRecord } from './bytes'
import { decodeBase58Check, Base58LengthError } from './base58'
import { p2mrAddressFromRoot } from './addresses'
import { singleKeyLeafScript, buildMultiALeafScript, p2mrLeafHash, p2mrBranchHash } from './scripts'

const BIP32_EXTENDED_KEY_PAYLOAD_LENGTH = 78
const EXTENDED_KEY_VERSION_PREFIXES = new Map<number, string>([
  [0x0488b21e, 'xpub'],
  [0x0488ade4, 'xprv'],
  [0x043587cf, 'tpub'],
  [0x04358394, 'tprv'],
  [0x03f72815, 'qpub'],
  [0x03f723db, 'qprv'],
  [0x0435dbad, 'tqpb'],
  [0x0435dc31, 'tqpv'],
  [0x03f7d7b5, 'qrpb'],
  [0x03f7d83a, 'qrpv'],
])
// Grouped as Core's INPUT_CHARSET is; the order of every character matters.
// prettier-ignore
const DESCRIPTOR_INPUT_CHARSET =
  "0123456789()[],'/*abcdefgh@:$%{}" +
  'IJKLMNOPQRSTUVWXYZ&+-.;<=>?!^_|~' +
  'ijklmnopqrstuvwxyzABCDEFGH`#"\\ '
const DESCRIPTOR_CHECKSUM_CHARSET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l'

/**
 * A descriptor split at its last `#`, as {@link splitDescriptorChecksum}
 * returns it.
 *
 * @category Descriptors
 */
export interface DescriptorChecksumParts {
  /** The text before the last `#`, or the whole input when it has no `#`. */
  descriptor: string
  /** The 8-character checksum after the `#`, when there is one. */
  checksum?: string
}

/**
 * The key expression inside `pk(pqc(...))`: an optional `[fingerprint/path]`
 * origin, a BIP32 extended key and a derivation path that may end in `*`.
 *
 * @remarks
 * It is parsed only: deriving its PQC key needs private BIP32/PQC derivation,
 * which this package does not do. See
 * [P2MR descriptor support](https://github.com/Qbit-Org/qbit-js/blob/main/packages/protocol/docs/p2mr-descriptor-support.md).
 *
 * @category Descriptors
 */
export interface P2mrPqcKeyExpression {
  /** The expression as written inside `pqc(...)`. */
  expression: string
  /** The key origin, when the expression starts with `[...]`. */
  origin?: {
    /** The master key fingerprint, as 8 lowercase hex digits. */
    fingerprint: string
    /** The origin's path segments as written, such as `87h` or `0'`. */
    path: string[]
  }
  /**
   * The Base58Check extended key as written: a qbit `qpub`/`qprv`,
   * `tqpb`/`tqpv` or `qrpb`/`qrpv` key, or a Bitcoin `xpub`/`xprv` or
   * `tpub`/`tprv` key.
   */
  key: string
  /** The path segments after the key, as written; a final `*` is the wildcard. */
  path: string[]
  /** Whether the path ends in the unhardened wildcard `*`, which makes the descriptor ranged. */
  wildcard: boolean
}

/**
 * A leaf of an `mr(...)` script tree:
 *
 * - `pk`: `pk(<key hex>)`, a single-key leaf ({@link singleKeyLeafScript});
 * - `pqc`: `pk(pqc(<key expression>))`, whose key is not derived, so it has no
 *   leaf script or hash here;
 * - `multi_a` / `sortedmulti_a`: `multi_a(<k>,<key hex>,...)`, a k-of-n leaf
 *   built like {@link multiALeafScript}; `sortedmulti_a` sorts its keys
 *   bytewise first.
 *
 * @category Descriptors
 */
export type P2mrDescriptorLeaf =
  | {
      /** A single-key leaf. */
      type: 'pk'
      /** The 32-byte public key. */
      pubkey: Uint8Array
    }
  | {
      /** A single-key leaf whose key is a key expression. */
      type: 'pqc'
      /** The parsed key expression. */
      key: P2mrPqcKeyExpression
    }
  | {
      /** A k-of-n leaf; `sortedmulti_a` sorts its keys. */
      type: 'multi_a' | 'sortedmulti_a'
      /** Signatures required, from 1 to `pubkeys.length`. A leaf above 35 can never be spent. */
      threshold: number
      /** The 32-byte public keys in descriptor order, 1 to 999 of them. */
      pubkeys: Uint8Array[]
    }

/**
 * An `mr(...)` script tree: a leaf, or a `{left,right}` branch. No leaf is
 * more than 128 branches deep.
 *
 * @category Descriptors
 */
export type P2mrDescriptorTree =
  | P2mrDescriptorLeaf
  | {
      /** A `{left,right}` branch. */
      type: 'branch'
      /** The left subtree. */
      left: P2mrDescriptorTree
      /** The right subtree. */
      right: P2mrDescriptorTree
    }

/**
 * A parsed P2MR descriptor: `rawmr(<root hex>)` or `mr(<tree>)`.
 *
 * @remarks
 * Functions that take a descriptor object check its node types, byte
 * lengths, `multi_a` bounds and tree depth, and for a `pqc` key that the
 * expression formatted from `origin`, `key` and `path` parses as
 * {@link parseP2mrDescriptor} parses a string. They do not compare the key's
 * `expression`, `wildcard` or `fingerprint` case with those fields. See
 * [P2MR Descriptors](https://github.com/Qbit-Org/qbit-js/blob/main/packages/protocol/docs/p2mr-descriptors.md) and
 * [P2MR descriptor support](https://github.com/Qbit-Org/qbit-js/blob/main/packages/protocol/docs/p2mr-descriptor-support.md).
 *
 * @category Descriptors
 */
export type ParsedP2mrDescriptor =
  | {
      /** A bare Merkle root, which commits to no known leaves. */
      type: 'rawmr'
      /** The checksum the parsed string carried, if any. {@link serializeP2mrDescriptor} recomputes it. */
      checksum?: string
      /** The 32-byte Merkle root. */
      root: Uint8Array
    }
  | {
      /** A script tree. */
      type: 'mr'
      /** The checksum the parsed string carried, if any. {@link serializeP2mrDescriptor} recomputes it. */
      checksum?: string
      /** The script tree. */
      tree: P2mrDescriptorTree
    }

/**
 * Options for {@link parseP2mrDescriptor}.
 *
 * @category Descriptors
 */
export interface ParseP2mrDescriptorOptions {
  /** Throw `INVALID_DESCRIPTOR` for a descriptor without a `#checksum`. Default `false`. */
  requireChecksum?: boolean
  /**
   * Check a present checksum against the descriptor. Default `true`; `false`
   * keeps an unchecked checksum, which must still be 8 checksum characters.
   */
  verifyChecksum?: boolean
}

/**
 * The receive and change descriptors for {@link formatP2mrImportDescriptors}.
 *
 * @category Descriptors
 */
export interface P2mrImportDescriptorPair {
  /** The receive descriptor: a ranged `mr(...)` descriptor, with or without a checksum. */
  external: string
  /** The change descriptor, under the same rules as `external`. */
  internal: string
}

/**
 * One request object for qbit Core's `importdescriptors` RPC, as
 * {@link formatP2mrImportDescriptors} returns it.
 *
 * @category Descriptors
 */
export interface P2mrImportDescriptorEntry {
  /** The descriptor, with its checksum. */
  desc: string
  /** `'now'` or a non-negative number of seconds since the Unix epoch. */
  timestamp: 'now' | number
  /** Always `true`. */
  active: boolean
  /** `false` for the receive descriptor, `true` for the change descriptor. */
  internal: boolean
  /** The `[start, end]` range of derivation indexes. */
  range: [number, number]
}

/**
 * Split a descriptor at its last `#` into the descriptor and its checksum,
 * without verifying the checksum.
 *
 * @param input - The descriptor, with or without a `#checksum` suffix.
 * @returns The descriptor text and, when there is a `#`, the checksum.
 * @throws {QbitProtocolError} `INVALID_DESCRIPTOR` if the text after the last
 * `#` is not 8 checksum characters.
 *
 * @category Descriptors
 */
export function splitDescriptorChecksum(input: string): DescriptorChecksumParts {
  const hash = input.lastIndexOf('#')
  if (hash === -1) {
    return { descriptor: input }
  }
  const descriptor = input.slice(0, hash)
  const checksum = input.slice(hash + 1)
  if (!/^[qpzry9x8gf2tvdw0s3jn54khce6mua7l]{8}$/.test(checksum)) {
    throw new QbitProtocolError('INVALID_DESCRIPTOR', 'invalid descriptor checksum suffix')
  }
  return { descriptor, checksum }
}

/**
 * Check that a descriptor carries a correct checksum.
 *
 * @param input - The descriptor with its `#checksum` suffix.
 * @returns The descriptor text and checksum.
 * @throws {QbitProtocolError} `INVALID_DESCRIPTOR` if the checksum is missing,
 * malformed or wrong, or the descriptor has a character the checksum does not
 * cover.
 *
 * @category Descriptors
 */
export function verifyDescriptorChecksum(input: string): DescriptorChecksumParts {
  const parts = splitDescriptorChecksum(input)
  if (parts.checksum === undefined) {
    throw new QbitProtocolError('INVALID_DESCRIPTOR', 'descriptor is missing checksum')
  }
  const expected = descriptorChecksum(parts.descriptor)
  if (parts.checksum !== expected) {
    throw new QbitProtocolError('INVALID_DESCRIPTOR', 'descriptor checksum mismatch')
  }
  return parts
}

/**
 * Parse an `mr(...)` or `rawmr(...)` descriptor, with or without a
 * `#checksum`.
 *
 * Leading and trailing whitespace is trimmed. A checksum, when present, is
 * verified unless `verifyChecksum: false` is passed. Keys are 32-byte hex,
 * upper- or lowercase, or `pqc(...)` key expressions; `multi_a` and `sortedmulti_a`
 * take 1 to 999 keys and a threshold from 1 to the key count, as qbit Core's
 * parser does, so a threshold above 35 parses.
 *
 * @param input - The descriptor.
 * @param options - Whether a checksum is required and whether it is verified.
 * @returns The parsed descriptor, with the checksum it carried.
 * @throws {QbitProtocolError} `INVALID_DESCRIPTOR` for anything else: a
 * missing required checksum, a wrong checksum, another descriptor type, bad
 * syntax or hex, a tree deeper than 128, an invalid threshold or key count,
 * or a key path or key expression this package does not support.
 *
 * @remarks
 * See
 * [P2MR descriptor support](https://github.com/Qbit-Org/qbit-js/blob/main/packages/protocol/docs/p2mr-descriptor-support.md) and
 * [P2MR Descriptors](https://github.com/Qbit-Org/qbit-js/blob/main/packages/protocol/docs/p2mr-descriptors.md).
 *
 * @example
 * ```ts
 * import { p2mrAddressFromDescriptor, parseP2mrDescriptor } from '@qbit-oss/protocol'
 *
 * const descriptor = parseP2mrDescriptor(
 *   'mr(pk(0202020202020202020202020202020202020202020202020202020202020202))#vugajuwd',
 *   { requireChecksum: true }
 * )
 * // { type: 'mr', tree: { type: 'pk', pubkey: Uint8Array(32) }, checksum: 'vugajuwd' }
 * p2mrAddressFromDescriptor(descriptor, 'regtest')
 * // 'qbrt1zzasx2u2z7v9kn4q8e66r57mfw08xvrvdcqfcq6xfte0eau9dgdgqz42zd5'
 * ```
 *
 * @category Descriptors
 */
export function parseP2mrDescriptor(input: string, options: ParseP2mrDescriptorOptions = {}): ParsedP2mrDescriptor {
  const parts = splitDescriptorChecksum(input.trim())
  if (options.requireChecksum && parts.checksum === undefined) {
    throw new QbitProtocolError('INVALID_DESCRIPTOR', 'descriptor is missing checksum')
  }
  if (parts.checksum !== undefined && options.verifyChecksum !== false) {
    const expected = descriptorChecksum(parts.descriptor)
    if (parts.checksum !== expected) {
      throw new QbitProtocolError('INVALID_DESCRIPTOR', 'descriptor checksum mismatch')
    }
  }

  const descriptor = parts.descriptor
  const rawRoot = unwrapFunction(descriptor, 'rawmr')
  if (rawRoot !== undefined) {
    const parsed = {
      type: 'rawmr' as const,
      root: parseHex32(rawRoot, 'rawmr root'),
    }
    return parts.checksum === undefined ? parsed : { ...parsed, checksum: parts.checksum }
  }

  const mrInner = unwrapFunction(descriptor, 'mr')
  if (mrInner === undefined) {
    throw new QbitProtocolError('INVALID_DESCRIPTOR', 'expected mr(...) or rawmr(...) descriptor')
  }
  if (mrInner.length === 0) {
    throw new QbitProtocolError('INVALID_DESCRIPTOR', 'mr descriptor is missing a script tree')
  }

  const parsed = {
    type: 'mr' as const,
    tree: parseP2mrTree(mrInner),
  }
  return parts.checksum === undefined ? parsed : { ...parsed, checksum: parts.checksum }
}

/**
 * Serialize a descriptor object to its `mr(...)` / `rawmr(...)` string, with a
 * `#checksum` suffix when `includeChecksum` is true (by default, when the
 * object has a `checksum`).
 *
 * Throws `INVALID_DESCRIPTOR` for an object `parseP2mrDescriptor` could not
 * have returned: `null`, `undefined` or another non-object; a `type` other than
 * `mr`/`rawmr` or an unknown tree node type; a `rawmr` root or `pk`/`multi_a`
 * pubkey that is not a 32-byte `Uint8Array`; a threshold outside
 * `1 <= k <= n <= 999`; a malformed `pqc()` key; or a tree deeper than 128.
 * Such objects were previously serialized as given (for example
 * `multi_a(0,...)` or a 31-byte root) or failed with a `TypeError`, or a
 * `RangeError` stack overflow for very deep or cyclic trees. Thresholds above
 * 35 still serialize, as qbit Core's parser accepts them.
 *
 * @param descriptor - The descriptor object.
 * @param includeChecksum - Whether to append a checksum. Default: whether
 * `descriptor.checksum` is set.
 * @returns The descriptor string. Public keys and roots are written as
 * lowercase hex, and the checksum is computed afresh, not copied from
 * `descriptor.checksum`.
 * @throws {QbitProtocolError} `INVALID_DESCRIPTOR` for a malformed object, as
 * listed above.
 *
 * @remarks
 * See [P2MR Descriptors](https://github.com/Qbit-Org/qbit-js/blob/main/packages/protocol/docs/p2mr-descriptors.md).
 *
 * @category Descriptors
 */
export function serializeP2mrDescriptor(
  descriptor: ParsedP2mrDescriptor,
  // `?.` so that a null descriptor reaches the INVALID_DESCRIPTOR check below.
  includeChecksum = descriptor?.checksum !== undefined
): string {
  assertParsedP2mrDescriptor(descriptor)
  let out: string
  if (descriptor.type === 'rawmr') {
    out = `rawmr(${bytesToHex(descriptor.root)})`
  } else {
    out = `mr(${formatP2mrTree(descriptor.tree)})`
  }
  return includeChecksum ? addDescriptorChecksum(out) : out
}

/**
 * Compute the P2MR merkle root a descriptor commits to.
 *
 * Like qbit Core's `deriveaddresses` (src/rpc/output_script.cpp:339-341), an
 * `mr()` descriptor must have at least one leaf a wallet can satisfy: a `pk()`
 * leaf, or a `multi_a`/`sortedmulti_a` leaf with threshold <= 35. Otherwise this
 * throws `INVALID_DESCRIPTOR`, since no coins sent to the root could be spent.
 * A tree with one such leaf still commits to its unspendable leaves, as in
 * Core. `rawmr()` is exempt. Such `mr()` descriptors previously returned a root.
 *
 * Descriptor objects get the same checks as `serializeP2mrDescriptor` and
 * throw `INVALID_DESCRIPTOR`. Previously a 31-byte `rawmr` root was returned,
 * an unknown `type` was treated as `mr`, trees deeper than 128 and keys given
 * as `number[]` were hashed, and other malformed objects failed with a
 * different error: `RangeError` (threshold 0 or above n, unknown leaf type,
 * stack overflow on very deep or cyclic trees), `INVALID_BYTES` (wrong-length
 * key) or `TypeError` (`null` and other non-objects).
 *
 * @param descriptor - A descriptor string, parsed with
 * {@link parseP2mrDescriptor} and its default options, or a descriptor object.
 * @returns The 32-byte Merkle root. For a `rawmr` descriptor object this is
 * its own `root` array, not a copy.
 * @throws {QbitProtocolError} `INVALID_DESCRIPTOR` for a descriptor
 * `parseP2mrDescriptor` rejects, a malformed object, an `mr()` descriptor with
 * no leaf a wallet can satisfy, or a tree with a `pk(pqc(...))` leaf, whose
 * key needs derivation this package does not do.
 *
 * @remarks
 * See [P2MR Descriptors](https://github.com/Qbit-Org/qbit-js/blob/main/packages/protocol/docs/p2mr-descriptors.md).
 *
 * @category Descriptors
 */
export function p2mrRootFromDescriptor(descriptor: string | ParsedP2mrDescriptor): Uint8Array {
  if (typeof descriptor !== 'string') {
    assertParsedP2mrDescriptor(descriptor)
  }
  const parsed = typeof descriptor === 'string' ? parseP2mrDescriptor(descriptor) : descriptor
  if (parsed.type === 'rawmr') {
    return parsed.root
  }
  if (!p2mrTreeHasStandardSatisfaction(parsed.tree)) {
    throw new QbitProtocolError(
      'INVALID_DESCRIPTOR',
      'P2MR descriptor has no wallet-constructible satisfaction: ' +
        `multi_a thresholds must not exceed ${P2MR_V1_MAX_MULTI_A_THRESHOLD}`
    )
  }
  return p2mrRootFromTree(parsed.tree)
}

function p2mrRootFromTree(tree: P2mrDescriptorTree): Uint8Array {
  if (tree.type === 'branch') {
    return p2mrBranchHash(p2mrRootFromTree(tree.left), p2mrRootFromTree(tree.right))
  }
  return p2mrLeafHash(P2MR_LEAF_VERSION_V1, p2mrLeafScript(tree))
}

function p2mrLeafScript(leaf: P2mrDescriptorLeaf): Uint8Array {
  if (leaf.type === 'pqc') {
    throw new QbitProtocolError(
      'INVALID_DESCRIPTOR',
      'pqc descriptors require private BIP32/PQC derivation before expansion'
    )
  }

  if (leaf.type === 'pk') {
    return singleKeyLeafScript(leaf.pubkey)
  }

  const pubkeys = leaf.type === 'sortedmulti_a' ? [...leaf.pubkeys].sort(compareBytes) : leaf.pubkeys
  return buildMultiALeafScript(leaf.threshold, pubkeys, false)
}

/**
 * Encode the P2MR address a descriptor commits to. Throws `INVALID_DESCRIPTOR`
 * for an `mr()` descriptor whose every leaf is a `multi_a`/`sortedmulti_a` with
 * threshold > 35, which no one could ever spend; see `p2mrRootFromDescriptor`.
 *
 * @param descriptor - A descriptor string or object, as
 * {@link p2mrRootFromDescriptor} takes it.
 * @param network - The network whose HRP the address uses.
 * @returns The lowercase address.
 * @throws {QbitProtocolError} `INVALID_DESCRIPTOR` as
 * {@link p2mrRootFromDescriptor} throws it, including for a `pk(pqc(...))`
 * leaf, or `UNKNOWN_NETWORK` or `WRONG_HRP` for the network, as
 * {@link encodeP2mrAddress} throws them (it throws a `TypeError` instead for a
 * name `Object.prototype` defines).
 *
 * @remarks
 * See [P2MR Descriptors](https://github.com/Qbit-Org/qbit-js/blob/main/packages/protocol/docs/p2mr-descriptors.md).
 *
 * @category Descriptors
 */
export function p2mrAddressFromDescriptor(
  descriptor: string | ParsedP2mrDescriptor,
  network: QbitNetworkName | QbitNetworkParams
): string {
  return p2mrAddressFromRoot(p2mrRootFromDescriptor(descriptor), network)
}

/**
 * Formats a receive (external) and change (internal) descriptor pair as the
 * request array for qbit Core's `importdescriptors` RPC: two active entries whose
 * descriptors carry checksums.
 *
 * Throws `INVALID_DESCRIPTOR` for requests that break these rules, which qbit Core
 * v1.0.0 rejects or misapplies, so they fail here instead of at import time:
 * - Each descriptor must be a ranged `mr(...)` descriptor with no leading or
 *   trailing whitespace. Core parses `desc` verbatim (`script/descriptor.cpp:3529-3544`).
 *   `parseP2mrDescriptor` trims its input, but this helper does not.
 * - `range` must be `[start, end]` with `0 <= start <= end <= 2^31-1` and
 *   `end - start < 1_000_000`; a larger span fails with "Range is too large"
 *   (`rpc/util.cpp:1502-1530`).
 * - `timestamp` must be `'now'` or a non-negative safe integer number of seconds
 *   (`wallet/rpc/backup.cpp:805-818`). Core clamps negative numbers to 1
 *   (`backup.cpp:1093,1107`), but this helper rejects them.
 * - The two descriptors must differ once any checksum is removed. Core accepts an
 *   identical pair, but activating it as internal deactivates it as external
 *   (`wallet/wallet.cpp:4828-4836`), so the wallet ends up with no active receive
 *   descriptor. The comparison is textual: spellings Core treats as one descriptor,
 *   such as `87h` and `87'`, `0` and `00`, or fingerprints that differ only in case,
 *   aren't detected.
 * - One network must be able to decode every `pqc()` key in the pair.
 *   Core decodes extended keys with the active network's version bytes, plus
 *   Bitcoin's xpub/xprv on mainnet and tpub/tprv elsewhere
 *   (`key_io.cpp:62-87,336-377`). For example, qpub/qprv with qrpb/qrpv is
 *   rejected.
 *
 * Not checked:
 * - `pqc()` keys given as extended public keys, which Core rejects
 *   (`wallet/rpc/backup.cpp:932-947`);
 * - keys for a network other than the node's;
 * - wallet state.
 *
 * Behaviour change: earlier versions passed surrounding whitespace, ranges of
 * more than 1,000,000 indices, ranges other than a two-element array, NaN, negative,
 * fractional or string timestamps, identical pairs and mixed-network pairs through
 * to Core, which rejected or misapplied them, or failed with a `TypeError`.
 *
 * @param pair - The receive (`external`) and change (`internal`) descriptors.
 * @param range - The `[start, end]` derivation index range. Default
 * `[0, 999]`.
 * @param timestamp - `'now'` (the default) or seconds since the Unix epoch.
 * @returns The receive entry, then the change entry, each with its checksum
 * (verified when given, added otherwise), the same `timestamp` and `range`,
 * and `active: true`.
 * @throws {QbitProtocolError} `INVALID_DESCRIPTOR` for a request that breaks
 * the rules above, or a descriptor that {@link parseP2mrDescriptor} rejects.
 *
 * @remarks
 * See
 * [P2MR descriptor support](https://github.com/Qbit-Org/qbit-js/blob/main/packages/protocol/docs/p2mr-descriptor-support.md#formatp2mrimportdescriptors).
 *
 * @category Descriptors
 */
export function formatP2mrImportDescriptors(
  pair: P2mrImportDescriptorPair,
  range: [number, number] = [0, 999],
  timestamp: 'now' | number = 'now'
): P2mrImportDescriptorEntry[] {
  assertDescriptorRange(range)
  assertImportTimestamp(timestamp)
  assertImportDescriptorText(pair.external, 'external')
  assertImportDescriptorText(pair.internal, 'internal')
  assertRangedP2mrImportDescriptor(pair.external, 'external')
  assertRangedP2mrImportDescriptor(pair.internal, 'internal')
  if (splitDescriptorChecksum(pair.external).descriptor === splitDescriptorChecksum(pair.internal).descriptor) {
    throw new QbitProtocolError('INVALID_DESCRIPTOR', 'external and internal import descriptors must differ')
  }
  assertSingleNetworkImportDescriptors(pair)
  return [
    {
      desc: ensureDescriptorChecksum(pair.external),
      timestamp,
      active: true,
      internal: false,
      range,
    },
    {
      desc: ensureDescriptorChecksum(pair.internal),
      timestamp,
      active: true,
      internal: true,
      range,
    },
  ]
}

// Mirrors GetImportTimestamp (wallet/rpc/backup.cpp:805-818), which takes "now" or
// a JSON integer. NaN and Infinity would serialize as null, and fractions or
// unsafe integers aren't valid int64 seconds.
function assertImportTimestamp(timestamp: unknown): void {
  if (timestamp !== 'now' && !(Number.isSafeInteger(timestamp) && (timestamp as number) >= 0)) {
    throw new QbitProtocolError(
      'INVALID_DESCRIPTOR',
      "import timestamp must be 'now' or a non-negative integer number of seconds"
    )
  }
}

function assertImportDescriptorText(descriptor: unknown, name: string): void {
  if (typeof descriptor !== 'string') {
    throw new QbitProtocolError('INVALID_DESCRIPTOR', `${name} import descriptor must be a string`)
  }
  if (descriptor !== descriptor.trim()) {
    throw new QbitProtocolError(
      'INVALID_DESCRIPTOR',
      `${name} import descriptor must not have leading or trailing whitespace`
    )
  }
}

function assertSingleNetworkImportDescriptors(pair: P2mrImportDescriptorPair): void {
  const prefixes = new Set<string>()
  for (const descriptor of [pair.external, pair.internal]) {
    const parsed = parseP2mrDescriptor(descriptor)
    if (parsed.type === 'mr') collectPqcKeyPrefixes(parsed.tree, prefixes)
  }
  const networks = Object.values(qbitNetworks).filter(params =>
    [...prefixes].every(prefix => extendedKeyDecodePrefixes(params).includes(prefix))
  )
  if (networks.length === 0) {
    throw new QbitProtocolError(
      'INVALID_DESCRIPTOR',
      `import descriptors mix extended keys from different networks (${[...prefixes].join(', ')})`
    )
  }
}

function collectPqcKeyPrefixes(tree: P2mrDescriptorTree, prefixes: Set<string>): void {
  if (tree.type === 'branch') {
    collectPqcKeyPrefixes(tree.left, prefixes)
    collectPqcKeyPrefixes(tree.right, prefixes)
  } else if (tree.type === 'pqc') {
    prefixes.add(tree.key.key.slice(0, 4))
  }
}

// Mirrors KeyDecodePrefixes (key_io.cpp:62-87): a node decodes its own extended-key
// version bytes plus Bitcoin's, xpub/xprv on mainnet and tpub/tprv on other chains.
function extendedKeyDecodePrefixes(params: QbitNetworkParams): string[] {
  const legacy = params.name === 'mainnet' ? ['xpub', 'xprv'] : ['tpub', 'tprv']
  return [params.bip32.publicPrefix, params.bip32.privatePrefix, ...legacy]
}

function assertRangedP2mrImportDescriptor(descriptor: string, name: string): void {
  const parsed = parseP2mrDescriptor(descriptor)
  if (parsed.type !== 'mr' || !p2mrTreeHasWildcard(parsed.tree)) {
    throw new QbitProtocolError('INVALID_DESCRIPTOR', `${name} import descriptor must be ranged`)
  }
}

function p2mrTreeHasWildcard(tree: P2mrDescriptorTree): boolean {
  if (tree.type === 'branch') {
    return p2mrTreeHasWildcard(tree.left) || p2mrTreeHasWildcard(tree.right)
  }
  return tree.type === 'pqc' && tree.key.wildcard
}

/**
 * Whether a wallet can build a valid spend for at least one leaf of a P2MR
 * descriptor, mirroring qbit Core's `HasP2MRStandardSatisfaction` (reported by
 * `getdescriptorinfo` as `has_p2mr_standard_satisfaction`). `rawmr()` is
 * always false. `mr()` is true when any leaf is `pk()` (including
 * `pk(pqc(...))`) or a `multi_a`/`sortedmulti_a` with threshold <= 35
 * (`P2MR_V1_MAX_MULTI_A_THRESHOLD`). `p2mrRootFromDescriptor` and
 * `p2mrAddressFromDescriptor` refuse `mr()` descriptors for which this is false.
 *
 * Parsing still accepts thresholds up to 999, as Core does. Strings go through
 * `parseP2mrDescriptor` and objects get the same checks; both throw
 * `INVALID_DESCRIPTOR` when malformed.
 *
 * @param descriptor - A descriptor string or object.
 * @returns Whether some leaf can be satisfied: always `false` for `rawmr()`.
 * @throws {QbitProtocolError} `INVALID_DESCRIPTOR` for a malformed descriptor.
 *
 * @remarks
 * See [P2MR Descriptors](https://github.com/Qbit-Org/qbit-js/blob/main/packages/protocol/docs/p2mr-descriptors.md).
 *
 * @category Descriptors
 */
export function hasP2mrStandardSatisfaction(descriptor: string | ParsedP2mrDescriptor): boolean {
  if (typeof descriptor !== 'string') {
    assertParsedP2mrDescriptor(descriptor)
  }
  const parsed = typeof descriptor === 'string' ? parseP2mrDescriptor(descriptor) : descriptor
  return parsed.type === 'mr' && p2mrTreeHasStandardSatisfaction(parsed.tree)
}

// qbit Core src/script/descriptor.cpp: mr() is satisfiable if any leaf is
// (:1864-1868); a leaf defaults to IsSolvable() (descriptor.h:132), multi_a
// needs k <= 35 (:1785), and rawmr() never is (:1925).
function p2mrTreeHasStandardSatisfaction(tree: P2mrDescriptorTree): boolean {
  const pending: P2mrDescriptorTree[] = [tree]
  for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
    if (node.type === 'branch') {
      pending.push(node.left, node.right)
    } else if (node.type === 'pk' || node.type === 'pqc' || node.threshold <= P2MR_V1_MAX_MULTI_A_THRESHOLD) {
      return true
    }
  }
  return false
}

// Descriptor objects skip parseP2mrDescriptor, so re-check what it guarantees.
// Iterative, so a deep or cyclic object fails on depth instead of overflowing
// the call stack.
function assertParsedP2mrDescriptor(descriptor: unknown): asserts descriptor is ParsedP2mrDescriptor {
  if (!isRecord(descriptor)) {
    throw new QbitProtocolError('INVALID_DESCRIPTOR', 'descriptor must be an object')
  }
  if (descriptor['type'] === 'rawmr') {
    if (!isBytesOfLength(descriptor['root'], P2MR_PROGRAM_BYTES)) {
      throw new QbitProtocolError('INVALID_DESCRIPTOR', 'rawmr root must be 32 bytes')
    }
    return
  }
  if (descriptor['type'] !== 'mr') {
    throw new QbitProtocolError('INVALID_DESCRIPTOR', 'descriptor type must be mr or rawmr')
  }

  const pending: Array<{ node: unknown; depth: number }> = [{ node: descriptor['tree'], depth: 0 }]
  for (let item = pending.pop(); item !== undefined; item = pending.pop()) {
    const { node, depth } = item
    // Same bound as parseP2mrTree and qbit Core's mr() nesting limit
    // (src/script/descriptor.cpp:3052).
    if (depth > P2MR_CONTROL_MAX_NODE_COUNT) {
      throw new QbitProtocolError('INVALID_DESCRIPTOR', 'mr descriptor exceeds maximum tree depth')
    }
    if (!isRecord(node)) {
      throw new QbitProtocolError('INVALID_DESCRIPTOR', 'mr descriptor tree node must be an object')
    }
    const type = node['type']
    if (type === 'branch') {
      pending.push({ node: node['left'], depth: depth + 1 }, { node: node['right'], depth: depth + 1 })
    } else if (type === 'pk') {
      if (!isBytesOfLength(node['pubkey'], P2MR_PROGRAM_BYTES)) {
        throw new QbitProtocolError('INVALID_DESCRIPTOR', 'P2MR pubkey must be 32 bytes')
      }
    } else if (type === 'pqc') {
      assertParsedPqcKeyExpression(node['key'])
    } else if (type === 'multi_a' || type === 'sortedmulti_a') {
      assertParsedMultiALeaf(type, node['threshold'], node['pubkeys'])
    } else {
      throw new QbitProtocolError('INVALID_DESCRIPTOR', 'unsupported mr(...) descriptor node type')
    }
  }
}

function assertParsedPqcKeyExpression(key: unknown): void {
  const origin = isRecord(key) ? key['origin'] : undefined
  if (
    !isRecord(key) ||
    typeof key['key'] !== 'string' ||
    !isStringArray(key['path']) ||
    (origin !== undefined &&
      (!isRecord(origin) || typeof origin['fingerprint'] !== 'string' || !isStringArray(origin['path'])))
  ) {
    throw new QbitProtocolError('INVALID_DESCRIPTOR', 'pqc descriptor key is malformed')
  }
  // Check the expression serializeP2mrDescriptor would emit with the string parser.
  parsePqcKeyExpression(formatPqcKeyExpression(key as unknown as P2mrPqcKeyExpression))
}

// Same bounds as parseMultiADescriptor and qbit Core's multi_a() parser
// (src/script/descriptor.cpp:2775-2786).
function assertParsedMultiALeaf(name: 'multi_a' | 'sortedmulti_a', threshold: unknown, pubkeys: unknown): void {
  if (!Array.isArray(pubkeys) || pubkeys.length < 1 || pubkeys.length > P2MR_MAX_MULTI_A_PUBKEYS) {
    throw new QbitProtocolError('INVALID_DESCRIPTOR', `${name} requires 1..${P2MR_MAX_MULTI_A_PUBKEYS} pubkeys`)
  }
  if (typeof threshold !== 'number' || !Number.isInteger(threshold) || threshold < 1 || threshold > pubkeys.length) {
    throw new QbitProtocolError('INVALID_DESCRIPTOR', `${name} threshold is out of range`)
  }
  for (const [index, pubkey] of pubkeys.entries()) {
    if (!isBytesOfLength(pubkey, P2MR_PROGRAM_BYTES)) {
      throw new QbitProtocolError('INVALID_DESCRIPTOR', `${name} pubkey ${index} must be 32 bytes`)
    }
  }
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(item => typeof item === 'string')
}

/**
 * Compute a descriptor's 8-character checksum, as qbit Core's descriptor
 * checksum does.
 *
 * @param descriptor - The descriptor text, without a `#checksum` suffix.
 * @returns The checksum, 8 characters from the bech32 character set.
 * @throws {QbitProtocolError} `INVALID_DESCRIPTOR` if `descriptor` has a
 * character outside the checksum's input character set.
 *
 * @category Descriptors
 */
export function descriptorChecksum(descriptor: string): string {
  let checksum = 1n
  let cls = 0
  let clsCount = 0

  for (const char of descriptor) {
    const position = DESCRIPTOR_INPUT_CHARSET.indexOf(char)
    if (position === -1) {
      throw new QbitProtocolError('INVALID_DESCRIPTOR', `descriptor contains invalid checksum character: ${char}`)
    }

    checksum = descriptorPolyMod(checksum, position & 31)
    cls = cls * 3 + (position >> 5)
    clsCount += 1
    if (clsCount === 3) {
      checksum = descriptorPolyMod(checksum, cls)
      cls = 0
      clsCount = 0
    }
  }

  if (clsCount > 0) {
    checksum = descriptorPolyMod(checksum, cls)
  }
  for (let i = 0; i < 8; i += 1) {
    checksum = descriptorPolyMod(checksum, 0)
  }
  checksum ^= 1n

  let out = ''
  for (let i = 0; i < 8; i += 1) {
    const index = Number((checksum >> BigInt(5 * (7 - i))) & 31n)
    out += DESCRIPTOR_CHECKSUM_CHARSET[index]
  }
  return out
}

/**
 * Append `#` and the checksum to a descriptor.
 *
 * @param descriptor - The descriptor text, without a `#`.
 * @returns `descriptor#checksum`.
 * @throws {QbitProtocolError} `INVALID_DESCRIPTOR` if `descriptor` already has
 * a `#`, or has a character outside the checksum's input character set.
 *
 * @category Descriptors
 */
export function addDescriptorChecksum(descriptor: string): string {
  if (descriptor.includes('#')) {
    throw new QbitProtocolError('INVALID_DESCRIPTOR', 'descriptor must not already include a checksum')
  }
  return `${descriptor}#${descriptorChecksum(descriptor)}`
}

function ensureDescriptorChecksum(descriptor: string): string {
  const parts = splitDescriptorChecksum(descriptor)
  if (parts.checksum !== undefined) {
    verifyDescriptorChecksum(descriptor)
    return descriptor
  }
  return addDescriptorChecksum(descriptor)
}

function unwrapFunction(input: string, name: string): string | undefined {
  const prefix = `${name}(`
  if (!input.startsWith(prefix) || !input.endsWith(')')) {
    return undefined
  }
  const inner = input.slice(prefix.length, -1)
  if (findMatchingClose(input, name.length) !== input.length - 1) {
    return undefined
  }
  return inner
}

function findMatchingClose(input: string, openIndex: number): number {
  let depth = 0
  for (let i = openIndex; i < input.length; i += 1) {
    const char = input[i]
    if (char === '(') depth += 1
    if (char === ')') {
      depth -= 1
      if (depth === 0) return i
      if (depth < 0) break
    }
  }
  return -1
}

function splitTopLevel(input: string): string[] {
  const parts: string[] = []
  let depth = 0
  let bracketDepth = 0
  let braceDepth = 0
  let start = 0
  for (let i = 0; i < input.length; i += 1) {
    const char = input[i]
    if (char === '(') depth += 1
    else if (char === ')') depth -= 1
    else if (char === '[') bracketDepth += 1
    else if (char === ']') bracketDepth -= 1
    else if (char === '{') braceDepth += 1
    else if (char === '}') braceDepth -= 1
    else if (char === ',' && depth === 0 && bracketDepth === 0 && braceDepth === 0) {
      parts.push(input.slice(start, i))
      start = i + 1
    }
    if (depth < 0 || bracketDepth < 0 || braceDepth < 0) {
      throw new QbitProtocolError('INVALID_DESCRIPTOR', 'unbalanced descriptor expression')
    }
  }
  if (depth !== 0 || bracketDepth !== 0 || braceDepth !== 0) {
    throw new QbitProtocolError('INVALID_DESCRIPTOR', 'unbalanced descriptor expression')
  }
  parts.push(input.slice(start))
  return parts
}

function parseP2mrTree(input: string, depth = 0): P2mrDescriptorTree {
  if (depth > P2MR_CONTROL_MAX_NODE_COUNT) {
    throw new QbitProtocolError('INVALID_DESCRIPTOR', 'mr descriptor exceeds maximum tree depth')
  }

  const branchInner = unwrapBranch(input)
  if (branchInner !== undefined) {
    const parts = splitTopLevel(branchInner)
    if (parts.length !== 2) {
      throw new QbitProtocolError('INVALID_DESCRIPTOR', 'mr descriptor branches must have two children')
    }
    const [left, right] = parts
    if (left === undefined || right === undefined || left.length === 0 || right.length === 0) {
      throw new QbitProtocolError('INVALID_DESCRIPTOR', 'mr descriptor branch is missing a child')
    }
    return {
      type: 'branch',
      left: parseP2mrTree(left, depth + 1),
      right: parseP2mrTree(right, depth + 1),
    }
  }

  return parseP2mrLeaf(input)
}

function unwrapBranch(input: string): string | undefined {
  if (!input.startsWith('{') || !input.endsWith('}')) {
    return undefined
  }
  if (findMatchingBrace(input, 0) !== input.length - 1) {
    return undefined
  }
  return input.slice(1, -1)
}

function findMatchingBrace(input: string, openIndex: number): number {
  let depth = 0
  for (let i = openIndex; i < input.length; i += 1) {
    const char = input[i]
    if (char === '{') depth += 1
    if (char === '}') {
      depth -= 1
      if (depth === 0) return i
      if (depth < 0) break
    }
  }
  return -1
}

function parseP2mrLeaf(input: string): P2mrDescriptorLeaf {
  const pkInner = unwrapFunction(input, 'pk')
  if (pkInner !== undefined) {
    const pqcInner = unwrapFunction(pkInner, 'pqc')
    return pqcInner === undefined
      ? {
          type: 'pk',
          pubkey: parseHex32(pkInner, 'P2MR pubkey'),
        }
      : {
          type: 'pqc',
          key: parsePqcKeyExpression(pqcInner),
        }
  }

  const multi = parseMultiADescriptor(input, 'multi_a') ?? parseMultiADescriptor(input, 'sortedmulti_a')
  if (multi !== undefined) return multi

  throw new QbitProtocolError('INVALID_DESCRIPTOR', 'unsupported mr(...) descriptor body')
}

function formatP2mrTree(tree: P2mrDescriptorTree): string {
  if (tree.type === 'branch') {
    return `{${formatP2mrTree(tree.left)},${formatP2mrTree(tree.right)}}`
  }
  if (tree.type === 'pk') {
    return `pk(${bytesToHex(tree.pubkey)})`
  }
  if (tree.type === 'pqc') {
    return `pk(pqc(${formatPqcKeyExpression(tree.key)}))`
  }
  const pubkeys = tree.pubkeys.map(pubkey => bytesToHex(pubkey)).join(',')
  return `${tree.type}(${tree.threshold},${pubkeys})`
}

function parseHex32(value: string, name: string): Uint8Array {
  if (!/^[0-9a-fA-F]{64}$/.test(value)) {
    throw new QbitProtocolError('INVALID_DESCRIPTOR', `${name} must be 32-byte hex`)
  }
  return hexToBytes(value)
}

function parsePqcKeyExpression(expression: string): P2mrPqcKeyExpression {
  let rest = expression
  let origin: P2mrPqcKeyExpression['origin']
  if (rest.startsWith('[')) {
    const close = rest.indexOf(']')
    if (close === -1) {
      throw new QbitProtocolError('INVALID_DESCRIPTOR', 'unterminated descriptor origin')
    }
    const originText = rest.slice(1, close)
    const [fingerprint, ...path] = originText.split('/')
    if (fingerprint === undefined || !/^[0-9a-fA-F]{8}$/.test(fingerprint)) {
      throw new QbitProtocolError('INVALID_DESCRIPTOR', 'descriptor origin must start with a fingerprint')
    }
    validateDescriptorPath(path, true)
    origin = {
      fingerprint: fingerprint.toLowerCase(),
      path,
    }
    rest = rest.slice(close + 1)
  }

  const [key, ...path] = rest.split('/')
  if (key === undefined || key.length === 0) {
    throw new QbitProtocolError('INVALID_DESCRIPTOR', 'pqc descriptor is missing a key')
  }
  if (!isBip32ExtendedKeyExpression(key)) {
    throw new QbitProtocolError('INVALID_DESCRIPTOR', 'pqc descriptor key must be a BIP32 extended key')
  }
  validateDescriptorPath(path, false)
  const wildcard = path[path.length - 1] === '*'
  const parsed = {
    expression,
    key,
    path,
    wildcard,
  }
  return origin === undefined ? parsed : { ...parsed, origin }
}

function formatPqcKeyExpression(key: P2mrPqcKeyExpression): string {
  const origin = key.origin === undefined ? '' : `[${[key.origin.fingerprint, ...key.origin.path].join('/')}]`
  const path = key.path.length === 0 ? '' : `/${key.path.join('/')}`
  return `${origin}${key.key}${path}`
}

/**
 * Validates the BIP32 path segments after a `pqc()` key (`origin` false) or inside
 * its `[fingerprint/...]` key origin (`origin` true).
 *
 * Mirrors qbit Core's `ParseKeyPathNum` (`src/script/descriptor.cpp:2114-2136`):
 * each segment matches `^[0-9]+(['h])?$`, so `'` and `h` are the only hardened
 * markers (`H` is rejected). Leading zeros are allowed. The value must fit a uint32
 * and be at most 0x7FFFFFFF, because the hardened bit comes only from the marker.
 * Error messages use Core's wording (`descriptor.cpp:2127-2131`).
 *
 * A key path may end in an unhardened `*` wildcard; an origin path may not. Core
 * also accepts hardened wildcards (`*'`, `*h`; `descriptor.cpp:2220-2232`) and
 * multipath segments (`<a;b>`; `descriptor.cpp:2162-2193`) after the key, though
 * not inside an origin (`descriptor.cpp:2543`). This parser supports neither and
 * rejects them.
 */
function validateDescriptorPath(path: readonly string[], origin: boolean): void {
  for (const [index, segment] of path.entries()) {
    const final = index === path.length - 1
    if (segment === '*' && !origin && final) continue
    if (segment === '*') {
      throw new QbitProtocolError('INVALID_DESCRIPTOR', 'descriptor wildcard must be the final path segment')
    }
    if ((segment === "*'" || segment === '*h') && !origin && final) {
      throw new QbitProtocolError('INVALID_DESCRIPTOR', 'hardened descriptor wildcards are not supported')
    }
    if (segment.startsWith('<') && segment.endsWith('>')) {
      throw new QbitProtocolError('INVALID_DESCRIPTOR', 'multipath descriptor key paths are not supported')
    }

    const digits = segment.endsWith("'") || segment.endsWith('h') ? segment.slice(0, -1) : segment
    // Compare significant digits, not a parsed Number, so a huge value never
    // becomes an imprecise float. Ten digits or fewer is exact as a Number.
    const significant = /^[0-9]+$/.test(digits) ? digits.replace(/^0+(?=[0-9])/, '') : undefined
    if (significant === undefined || significant.length > 10 || Number(significant) > 0xffffffff) {
      // Core echoes the value verbatim; cap it so hostile input can't bloat the error.
      const shown = (digits.length > 32 ? `${digits.slice(0, 32)}...` : digits).replace(/[^\x20-\x7e]/g, '?')
      throw new QbitProtocolError('INVALID_DESCRIPTOR', `Key path value '${shown}' is not a valid uint32`)
    }
    if (Number(significant) > 0x7fffffff) {
      throw new QbitProtocolError('INVALID_DESCRIPTOR', `Key path value ${significant} is out of range`)
    }
  }
}

function isBip32ExtendedKeyExpression(key: string): boolean {
  if (!/^[1-9A-HJ-NP-Za-km-z]+$/.test(key)) {
    return false
  }
  try {
    const payload = decodeBase58Check(key, BIP32_EXTENDED_KEY_PAYLOAD_LENGTH)
    if (payload.length !== BIP32_EXTENDED_KEY_PAYLOAD_LENGTH) return false
    const expectedPrefix = EXTENDED_KEY_VERSION_PREFIXES.get(readUint32Be(payload, 0))
    return expectedPrefix !== undefined && key.startsWith(expectedPrefix)
  } catch (error) {
    // `instanceof` suffices: only this package's own decodeBase58Check throws it.
    if (error instanceof Base58LengthError) throw error
    return false
  }
}

function parseMultiADescriptor(
  input: string,
  name: 'multi_a' | 'sortedmulti_a'
):
  | {
      type: 'multi_a' | 'sortedmulti_a'
      threshold: number
      pubkeys: Uint8Array[]
    }
  | undefined {
  const inner = unwrapFunction(input, name)
  if (inner === undefined) {
    return undefined
  }
  const parts = splitTopLevel(inner)
  if (parts.length < 2) {
    throw new QbitProtocolError('INVALID_DESCRIPTOR', `${name} requires a threshold and pubkeys`)
  }
  const thresholdText = parts[0]
  if (thresholdText === undefined || !/^[0-9]+$/.test(thresholdText)) {
    throw new QbitProtocolError('INVALID_DESCRIPTOR', `${name} threshold must be an integer`)
  }
  const threshold = Number.parseInt(thresholdText, 10)
  const pubkeys = parts.slice(1).map((part, index) => parseHex32(part, `${name} pubkey ${index}`))
  if (pubkeys.length > P2MR_MAX_MULTI_A_PUBKEYS) {
    throw new QbitProtocolError('INVALID_DESCRIPTOR', `${name} supports at most ${P2MR_MAX_MULTI_A_PUBKEYS} pubkeys`)
  }
  if (threshold < 1 || threshold > pubkeys.length) {
    throw new QbitProtocolError('INVALID_DESCRIPTOR', `${name} threshold is out of range`)
  }
  return {
    type: name,
    threshold,
    pubkeys,
  }
}

// Mirrors ParseRange and ParseDescriptorRange (rpc/util.cpp:1502-1530).
function assertDescriptorRange(range: [number, number]): void {
  if (!Array.isArray(range) || range.length !== 2) {
    throw new QbitProtocolError('INVALID_DESCRIPTOR', 'descriptor range must be [start, end]')
  }
  const [start, end] = range
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start || end > 0x7fffffff) {
    throw new QbitProtocolError('INVALID_DESCRIPTOR', 'descriptor range must be within 0..2^31-1')
  }
  // Core: `high >= low + 1000000` is "Range is too large" (rpc/util.cpp:1526-1527).
  if (end - start >= 1_000_000) {
    throw new QbitProtocolError('INVALID_DESCRIPTOR', 'Range is too large')
  }
}

function descriptorPolyMod(checksum: bigint, value: number): bigint {
  const top = checksum >> 35n
  let result = ((checksum & 0x7ffffffffn) << 5n) ^ BigInt(value)
  if ((top & 1n) !== 0n) result ^= 0xf5dee51989n
  if ((top & 2n) !== 0n) result ^= 0xa9fdca3312n
  if ((top & 4n) !== 0n) result ^= 0x1bab10e32dn
  if ((top & 8n) !== 0n) result ^= 0x3706b1677an
  if ((top & 16n) !== 0n) result ^= 0x644d626ffdn
  return result
}

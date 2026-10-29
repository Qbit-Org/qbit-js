import { sha256 } from '@noble/hashes/sha256'

export type QbitNetworkName = 'mainnet' | 'testnet4' | 'signet' | 'regtest'

export interface QbitNetworkParams {
  name: QbitNetworkName
  bech32Hrp: string
  p2pPort: number
  rpcPort: number
  /**
   * `true` when these SDK parameters match qbit Core v1.0.0 chainparams
   * (src/kernel/chainparams.cpp, src/chainparamsbase.cpp:46-54) and are
   * supported for production use.
   *
   * This does NOT mean "is mainnet": it is `true` for all four networks. To
   * identify mainnet, check `name === 'mainnet'` or `bech32Hrp === 'qb'`.
   */
  mainnetReady: boolean
  bip32: {
    public: number
    private: number
    publicPrefix: string
    privatePrefix: string
  }
}

export const qbitNetworks = {
  mainnet: {
    name: 'mainnet',
    bech32Hrp: 'qb',
    p2pPort: 8355,
    rpcPort: 8352,
    /** Not a mainnet flag: `true` on every network. See {@link QbitNetworkParams.mainnetReady}. */
    mainnetReady: true,
    bip32: {
      public: 0x03f72815,
      private: 0x03f723db,
      publicPrefix: 'qpub',
      privatePrefix: 'qprv',
    },
  },
  testnet4: {
    name: 'testnet4',
    bech32Hrp: 'tq',
    p2pPort: 48355,
    rpcPort: 48352,
    /** Not a mainnet flag: `true` on every network. See {@link QbitNetworkParams.mainnetReady}. */
    mainnetReady: true,
    bip32: {
      public: 0x0435dbad,
      private: 0x0435dc31,
      publicPrefix: 'tqpb',
      privatePrefix: 'tqpv',
    },
  },
  signet: {
    name: 'signet',
    bech32Hrp: 'tq',
    p2pPort: 38355,
    rpcPort: 38352,
    /** Not a mainnet flag: `true` on every network. See {@link QbitNetworkParams.mainnetReady}. */
    mainnetReady: true,
    bip32: {
      public: 0x0435dbad,
      private: 0x0435dc31,
      publicPrefix: 'tqpb',
      privatePrefix: 'tqpv',
    },
  },
  regtest: {
    name: 'regtest',
    bech32Hrp: 'qbrt',
    p2pPort: 18460,
    rpcPort: 18452,
    /** Not a mainnet flag: `true` on every network. See {@link QbitNetworkParams.mainnetReady}. */
    mainnetReady: true,
    bip32: {
      public: 0x03f7d7b5,
      private: 0x03f7d83a,
      publicPrefix: 'qrpb',
      privatePrefix: 'qrpv',
    },
  },
} as const satisfies Record<QbitNetworkName, QbitNetworkParams>

export const P2MR_WITNESS_VERSION = 2
export const P2MR_PROGRAM_BYTES = 32
export const P2MR_LEAF_VERSION_MASK = 0xfe
export const P2MR_LEAF_VERSION_V1 = 0xc0
export const P2MR_CONTROL_BASE_BYTES = 1
export const P2MR_CONTROL_NODE_BYTES = 32
export const P2MR_CONTROL_MAX_NODE_COUNT = 128
// Coinbase outputs are spendable only after this many confirmations on every
// qbit network (qbit Core src/consensus/consensus.h COINBASE_MATURITY).
export const QBIT_COINBASE_MATURITY = 1000
// No amount larger than this (in satoshis) is valid on any qbit network
// (qbit Core src/consensus/amount.h: MAX_MONEY = 210000000 * COIN, COIN = 1e8).
// It is a consensus-critical sanity bound, not the total money supply.
export const QBIT_MAX_MONEY = 21_000_000_000_000_000n
export const OP_0 = 0x00
export const OP_1 = 0x51
export const OP_2 = 0x52
export const OP_16 = 0x60
export const OP_CHECKSIGPQC = 0xb3
export const OP_CHECKSIGADD = 0xba
export const OP_NUMEQUAL = 0x9c
const OP_RETURN = 0x6a
// qbit Core CScript::IsPayToAnchor (src/script/script.cpp:213-220): OP_1 PUSH2 0x4e73.
const PAY_TO_ANCHOR_SCRIPT = Uint8Array.of(OP_1, 0x02, 0x4e, 0x73)
export const PQC_SIGNATURE_BYTES = 3680
// qbit Core MAX_P2MR_V1_STACK_ITEM_SIZE and MAX_P2MR_V1_TOTAL_INITIAL_STACK_BYTES
// (src/script/script.h:46, :49): consensus caps on each item and on the whole
// initial P2MR v1 witness stack (src/script/interpreter.cpp:37-47, :2395).
const P2MR_V1_MAX_INITIAL_STACK_ITEM_BYTES = 16384
const P2MR_V1_MAX_TOTAL_INITIAL_STACK_BYTES = 131072
// qbit Core P2MR_V1_MAX_SIGNATURE_ITEM_SIZE (src/script/p2mr_sizing.h:16): a PQC
// signature plus an explicit sighash byte.
const P2MR_V1_MAX_SIGNATURE_ITEM_BYTES = PQC_SIGNATURE_BYTES + 1
/**
 * Highest `multi_a`/`sortedmulti_a` threshold a P2MR v1 leaf can ever be spent
 * with: qbit Core P2MR_V1_MAX_STANDARD_SIGNATURES (src/script/p2mr_sizing.h:16-24),
 * which is P2MR_V1_MAX_TOTAL_INITIAL_STACK_BYTES (131072) divided by the largest
 * signature item (PQC_SIGNATURE_BYTES + 1 sighash byte = 3681), i.e. 35. Each
 * signature item is at least PQC_SIGNATURE_BYTES, so 36 of them (132480 bytes)
 * always exceed the consensus initial-stack limit.
 */
export const P2MR_V1_MAX_MULTI_A_THRESHOLD =
  // Core static_asserts that a signature item fits one stack item
  // (p2mr_sizing.h:21); if it did not, no multi_a leaf could be spent.
  P2MR_V1_MAX_SIGNATURE_ITEM_BYTES <= P2MR_V1_MAX_INITIAL_STACK_ITEM_BYTES
    ? Math.floor(P2MR_V1_MAX_TOTAL_INITIAL_STACK_BYTES / P2MR_V1_MAX_SIGNATURE_ITEM_BYTES)
    : 0
// qbit Core MAX_PUBKEYS_PER_MULTI_A (src/script/script.h:37).
const P2MR_MAX_MULTI_A_PUBKEYS = 999
export const QBIT_WALLET_MESSAGE_DOMAIN = 'QbitWalletSignedMessage'
export const QBIT_DATA_SIG_PQC_DOMAIN = 'QbitDataSigPQC'
export const P2MR_MESSAGE_PROOF_TYPE = 'p2mr-message'
export const P2MR_MESSAGE_PROOF_VERSION = 1
export const P2MR_MESSAGE_PROOF_MODE = 'p2mr-pubkey'
export const P2MR_MESSAGE_ALGORITHM = 'SLH-DSA-SHA2-128s-bounded30'
export const SIGHASH_DEFAULT = 0x00
export const SIGHASH_ALL = 0x01
export const SIGHASH_NONE = 0x02
export const SIGHASH_SINGLE = 0x03
export const SIGHASH_ANYONECANPAY = 0x80
export const SIGHASH_OUTPUT_MASK = 0x03
export const SIGHASH_INPUT_MASK = 0x80
export const PSBT_MAGIC_BYTES = 0x70736274 // "psbt"
export const PSBT_GLOBAL_UNSIGNED_TX = 0x00
export const PSBT_IN_WITNESS_UTXO = 0x01
export const PSBT_IN_SIGHASH_TYPE = 0x03
export const PSBT_IN_FINAL_SCRIPTWITNESS = 0x08
export const PSBT_IN_P2MR_SCRIPT_SIG = 0x19
export const PSBT_IN_P2MR_LEAF_SCRIPT = 0x1d
export const PSBT_IN_PROPRIETARY = 0xfc
export const PSBT_QBIT_IDENTIFIER = 'qbit'
export const PSBT_QBIT_IN_P2MR_MERKLE_ROOT = 0x01
export const PSBT_QBIT_IN_P2MR_LEAF_SCRIPT = 0x02
export const PSBT_QBIT_IN_P2MR_SCRIPT_SIG = 0x03
/**
 * Default `maxBytes` (see `PsbtLimitOptions`): 16 MiB. qbit has no witness
 * discount, so no transaction can exceed qbit Core v1.0.0's MAX_BLOCK_WEIGHT of
 * 2,000,000 bytes (src/consensus/consensus.h:15, :22), and a standard one stays
 * under MAX_STANDARD_TX_WEIGHT = 400,000 bytes, about 100 single-key P2MR
 * inputs of 3,763 bytes each (src/policy/policy.h:34-37,
 * src/script/p2mr_sizing.h:31-41). A PSBT adds a witness UTXO and leaf script
 * per input, so 16 MiB is 8x a block-sized transaction, leaving room for extra
 * signatures, unknown fields and non-witness UTXOs.
 */
export const PSBT_DEFAULT_MAX_BYTES = 16 * 1024 * 1024
/**
 * Default `maxObjects` (see `PsbtLimitOptions`): 131,072. A standard
 * transaction is at most MAX_STANDARD_TX_WEIGHT = 400,000 bytes
 * (src/policy/policy.h:37), and each input takes at least 41 bytes and each
 * output at least 9, so it has fewer than 44,500 inputs and outputs, leaving
 * over 86,000 objects for map entries. At the defaults, the densest hostile
 * PSBTs measured (Node 24) needed at most 96 MB of V8 heap in `parsePsbt`,
 * 144 MB in `parsePsbt` plus `decodePsbt`, and 36 MB in
 * `extractP2mrTransaction` (the smallest passing `--max-old-space-size`). That
 * heap grows with this limit, not with `maxBytes`; see `PsbtLimitOptions`.
 */
export const PSBT_DEFAULT_MAX_OBJECTS = 131_072

const BECH32_CHARSET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l'
const BASE58_CHARSET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'
const BECH32M_CONST = 0x2bc830a3
const BECH32_CONST = 1
// BIP173/BIP350 character limit, mirrored from qbit Core's bech32::CharLimit::BECH32.
const BECH32_MAX_LENGTH = 90
const BECH32_GENERATORS = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3] as const
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
const textEncoder = new TextEncoder()

const bech32CharValues = new Map<string, number>(Array.from(BECH32_CHARSET, (char, index) => [char, index]))
const base58CharValues = new Map<string, number>(Array.from(BASE58_CHARSET, (char, index) => [char, index]))

export type QbitProtocolErrorCode =
  | 'UNKNOWN_NETWORK'
  | 'INVALID_BECH32'
  | 'WRONG_HRP'
  | 'WRONG_ENCODING'
  | 'WRONG_WITNESS_VERSION'
  | 'WRONG_PROGRAM_LENGTH'
  | 'INVALID_BYTES'
  | 'INVALID_SCRIPT'
  | 'INVALID_URI'
  | 'WRONG_URI_SCHEME'
  | 'INVALID_DESCRIPTOR'
  | 'INVALID_PSBT'
  | 'INVALID_SIGHASH'
  | 'INVALID_AMOUNT'
  | 'INVALID_INTEGER'
  | 'SIGNING_FAILED'
  | 'INVALID_SIGNER'

/** Brands shared by every copy of these classes: `Symbol.for` keys are global across builds and realms. */
const QBIT_PROTOCOL_ERROR_BRAND = Symbol.for('qbit-js.QbitProtocolError')
const P2MR_PSBT_SIGNING_ERROR_BRAND = Symbol.for('qbit-js.P2mrPsbtSigningError')

function hasBrand(value: unknown, brand: symbol): boolean {
  return typeof value === 'object' && value !== null && (value as Record<symbol, unknown>)[brand] === true
}

export class QbitProtocolError extends Error {
  readonly code: QbitProtocolErrorCode

  /**
   * Whether `value` is a `QbitProtocolError` (or a subclass instance, such as
   * `P2mrPsbtSigningError`) from any copy of `@qbit-oss/protocol`.
   * `instanceof` only recognizes errors from the same copy, so it is false
   * when an app loads both the CommonJS and the ESM build (or two installed
   * versions) and the error comes from the other one. This checks a brand,
   * `Symbol.for('qbit-js.QbitProtocolError')`, set on the class prototype
   * instead. It identifies the class, not where the error came from: any code
   * can set the brand. An error from another version can carry a `code` this
   * version does not list, so keep a default branch when switching on it.
   */
  static is(value: unknown): value is QbitProtocolError {
    return hasBrand(value, QBIT_PROTOCOL_ERROR_BRAND)
  }

  constructor(code: QbitProtocolErrorCode, message: string) {
    super(message)
    this.name = 'QbitProtocolError'
    this.code = code
  }
}

Object.defineProperty(QbitProtocolError.prototype, QBIT_PROTOCOL_ERROR_BRAND, { value: true })

/**
 * qbit Core `MoneyRange`: an amount is a bigint satoshi count in
 * `[0, QBIT_MAX_MONEY]`. Throws `INVALID_AMOUNT` for anything else (including
 * non-bigint values), so an out-of-range amount is never serialized, hashed or
 * signed in int64-wrapped form.
 */
export function assertMoneyRange(value: bigint, name = 'amount'): void {
  if (typeof value !== 'bigint') {
    throw new QbitProtocolError('INVALID_AMOUNT', `${name} must be a bigint amount in satoshis`)
  }
  if (value < 0n || value > QBIT_MAX_MONEY) {
    throw new QbitProtocolError('INVALID_AMOUNT', `${name} ${value} is outside MoneyRange [0, ${QBIT_MAX_MONEY}]`)
  }
}

/**
 * Transaction integer fields (`version`, `locktime`, `vout`, `sequence`,
 * `codeSeparatorPos`) are uint32. Throws `INVALID_INTEGER` for non-integers,
 * non-finite values and anything outside `[0, 0xffffffff]` instead of the
 * silent modulo-2^32 wrap of `>>> 0`. `version` is included because qbit Core
 * stores `CTransaction::version` as `uint32_t` (Bitcoin Core 28.0+); the legacy
 * int32 spelling `-1` is `0xffffffff` here, not a second accepted encoding.
 */
export function assertUint32(value: number, name: string): void {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > 0xffffffff) {
    throw new QbitProtocolError('INVALID_INTEGER', `${name} ${String(value)} must be an integer in [0, 4294967295]`)
  }
}

export interface DecodedP2mrAddress {
  network: QbitNetworkName
  hrp: string
  program: Uint8Array
}

export interface P2mrMessageProof {
  type: typeof P2MR_MESSAGE_PROOF_TYPE
  version: typeof P2MR_MESSAGE_PROOF_VERSION
  address: string
  message_hash: string
  datasig_hash: string
  domain: typeof QBIT_DATA_SIG_PQC_DOMAIN
  message_domain: typeof QBIT_WALLET_MESSAGE_DOMAIN
  algorithm: typeof P2MR_MESSAGE_ALGORITHM
  proof_mode: typeof P2MR_MESSAGE_PROOF_MODE
  pubkey: string
  signature: string
  leaf_version: number
  leaf_script: string
  control_block: string
  p2mr_merkle_root: string
}

export interface CreateP2mrMessageProofParams {
  message: string
  address: string
  pubkey: Uint8Array
  signature: Uint8Array
  leafVersion?: number
  leafScript?: Uint8Array
  controlBlock?: Uint8Array
}

export type P2mrPqcVerifyFn = (pubkey: Uint8Array, digest: Uint8Array, signature: Uint8Array) => boolean

/**
 * What a relying party expects a P2MR message proof to be bound to. At least one
 * of `expectedAddress` or `expectedNetwork` is required.
 *
 * - `expectedAddress`: the address the proof must be for. It is decoded and
 *   compared to `proof.address` by HRP and witness program, so any valid bech32m
 *   spelling (lowercase or uppercase) is accepted here. Use it to pin an exact
 *   address.
 * - `expectedNetwork`: the network `proof.address` (and `expectedAddress`, when
 *   given) must belong to, checked by HRP. Signet and Testnet4 share the `tq`
 *   HRP, so `expectedNetwork` cannot tell them apart: a `tq` proof verifies
 *   under either name.
 */
export type VerifyP2mrMessageProofOptions =
  | {
      expectedAddress: string
      expectedNetwork?: QbitNetworkName | QbitNetworkParams
    }
  | {
      expectedAddress?: string
      expectedNetwork: QbitNetworkName | QbitNetworkParams
    }

export interface ParsedQbitUri {
  address: string
  network: QbitNetworkName
  amount?: string
  label?: string
  message?: string
  params: URLSearchParams
}

export interface QbitUriFields {
  address: string
  amount?: string
  label?: string
  message?: string
}

export interface DescriptorChecksumParts {
  descriptor: string
  checksum?: string
}

export interface P2mrPqcKeyExpression {
  expression: string
  origin?: {
    fingerprint: string
    path: string[]
  }
  key: string
  path: string[]
  wildcard: boolean
}

export type P2mrDescriptorLeaf =
  | {
      type: 'pk'
      pubkey: Uint8Array
    }
  | {
      type: 'pqc'
      key: P2mrPqcKeyExpression
    }
  | {
      type: 'multi_a' | 'sortedmulti_a'
      threshold: number
      pubkeys: Uint8Array[]
    }

export type P2mrDescriptorTree =
  | P2mrDescriptorLeaf
  | {
      type: 'branch'
      left: P2mrDescriptorTree
      right: P2mrDescriptorTree
    }

export type ParsedP2mrDescriptor =
  | {
      type: 'rawmr'
      checksum?: string
      root: Uint8Array
    }
  | {
      type: 'mr'
      checksum?: string
      tree: P2mrDescriptorTree
    }

export interface ParseP2mrDescriptorOptions {
  requireChecksum?: boolean
  verifyChecksum?: boolean
}

export interface P2mrImportDescriptorPair {
  external: string
  internal: string
}

export interface P2mrImportDescriptorEntry {
  desc: string
  timestamp: 'now' | number
  active: boolean
  internal: boolean
  range: [number, number]
}

export interface P2mrWitnessSignature {
  signature: Uint8Array
  hashType: number
  explicitHashType: boolean
}

export interface P2mrPsbtScriptSigField {
  type: 'p2mrScriptSig'
  pubkey: Uint8Array
  leafHash: Uint8Array
  signature: P2mrWitnessSignature
}

export interface P2mrPsbtLeafScriptField {
  type: 'p2mrLeafScript'
  controlBlock: Uint8Array
  script: Uint8Array
  leafVersion: number
}

export interface QbitProprietaryP2mrMerkleRootField {
  type: 'qbitP2mrMerkleRoot'
  merkleRoot: Uint8Array
}

export type QbitProprietaryP2mrField =
  QbitProprietaryP2mrMerkleRootField | P2mrPsbtLeafScriptField | P2mrPsbtScriptSigField

export interface EncodedQbitProprietaryP2mrField {
  identifier: typeof PSBT_QBIT_IDENTIFIER
  subtype: number
  keyData: Uint8Array
  value: Uint8Array
}

export function getQbitNetwork(network: QbitNetworkName | QbitNetworkParams): QbitNetworkParams {
  if (typeof network !== 'string') return network
  const params = qbitNetworks[network]
  if (params === undefined) {
    throw new QbitProtocolError('UNKNOWN_NETWORK', `unknown qbit network: ${network}`)
  }
  return params
}

/** Each byte's two lowercase hex digits. */
const HEX_BYTE_PAIRS = Array.from({ length: 256 }, (_, byte) => byte.toString(16).padStart(2, '0'))
/** ASCII codes of the lowercase hex digits, indexed by nibble. */
const HEX_DIGIT_CODES = Uint8Array.from('0123456789abcdef', digit => digit.charCodeAt(0))
/** Up to this many bytes, concatenating digit pairs stays flat: V8 makes a rope from 13 characters on. */
const HEX_CONCAT_MAX_BYTES = 6
/** Up to this many bytes, one `String.fromCharCode` call on an array of digit codes beats a `TextDecoder` call. */
const HEX_CHAR_CODES_MAX_BYTES = 128
const hexTextDecoder = typeof TextDecoder === 'function' ? new TextDecoder() : undefined
/** Bytes per `String.fromCharCode` call when `TextDecoder` is absent; far below engine argument limits. */
const HEX_FALLBACK_CHUNK_BYTES = 8192

/**
 * Lowercase hex, two digits per byte, always as a flat string. Linear in time
 * and memory: from 7 bytes on, the digits' ASCII codes are collected and
 * turned into a string in one call (past 128 bytes, one buffer decoded once),
 * so the result costs about two bytes of heap per byte however many are kept.
 * Repeated `+=` concatenation built a rope costing about 30 to 57 bytes of
 * heap per byte, which could exhaust the heap on a 10 MiB key or on many
 * distinct 128-byte PSBT keys.
 */
export function bytesToHex(bytes: Uint8Array): string {
  if (bytes.length <= HEX_CONCAT_MAX_BYTES) {
    let out = ''
    for (let i = 0; i < bytes.length; i += 1) out += HEX_BYTE_PAIRS[bytes[i]!]!
    return out
  }
  if (bytes.length <= HEX_CHAR_CODES_MAX_BYTES) {
    const small = new Array<number>(bytes.length * 2)
    for (let i = 0; i < bytes.length; i += 1) {
      const byte = bytes[i]!
      small[2 * i] = HEX_DIGIT_CODES[byte >> 4]!
      small[2 * i + 1] = HEX_DIGIT_CODES[byte & 0x0f]!
    }
    return String.fromCharCode.apply(null, small)
  }
  const codes = new Uint8Array(bytes.length * 2)
  for (let i = 0; i < bytes.length; i += 1) {
    const byte = bytes[i]!
    codes[2 * i] = HEX_DIGIT_CODES[byte >> 4]!
    codes[2 * i + 1] = HEX_DIGIT_CODES[byte & 0x0f]!
  }
  if (hexTextDecoder !== undefined) return hexTextDecoder.decode(codes)
  const chunks: string[] = []
  for (let offset = 0; offset < codes.length; offset += HEX_FALLBACK_CHUNK_BYTES) {
    chunks.push(String.fromCharCode(...codes.subarray(offset, offset + HEX_FALLBACK_CHUNK_BYTES)))
  }
  return chunks.join('')
}

export function hexToBytes(hex: string): Uint8Array {
  if (hex.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(hex)) {
    throw new QbitProtocolError('INVALID_BYTES', 'expected even-length hex')
  }
  const out = new Uint8Array(hex.length / 2)
  for (let i = 0; i < out.length; i += 1) {
    out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16)
  }
  return out
}

/**
 * Hash a wallet message as strict UTF-8 under the Qbit wallet message domain.
 *
 * The message must be well-formed UTF-16. A lone surrogate throws
 * `QbitProtocolError('INVALID_BYTES')` rather than being encoded as U+FFFD, so
 * two distinct strings never share a hash. Core only signs the resulting
 * 32-byte hash; this text-to-hash step is the SDK's own domain
 * (qbit Core v1.0.0 doc/design/p2mr-datapqchash.md:25-28).
 */
export function qbitWalletMessageHash(message: string): Uint8Array {
  if (typeof message !== 'string') {
    throw new TypeError('Qbit wallet message must be a string')
  }
  if (!isWellFormedUtf16(message)) {
    throw new QbitProtocolError('INVALID_BYTES', 'Qbit wallet message must be well-formed UTF-16 (no lone surrogates)')
  }
  return taggedHash(QBIT_WALLET_MESSAGE_DOMAIN, textEncoder.encode(message))
}

// String.prototype.isWellFormed is ES2024; the lib target here is ES2020.
function isWellFormedUtf16(value: string): boolean {
  for (let i = 0; i < value.length; i += 1) {
    const unit = value.charCodeAt(i)
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(i + 1)
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false
      i += 1
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      return false
    }
  }
  return true
}

/** Wrap a 32-byte wallet message hash in qbit's PQC data-signature domain. */
export function qbitDataSigPqcHash(messageHash: Uint8Array): Uint8Array {
  assertByteLength(messageHash, 32, 'Qbit wallet message hash')
  return taggedHash(QBIT_DATA_SIG_PQC_DOMAIN, messageHash)
}

export function encodeP2mrAddress(program: Uint8Array, network: QbitNetworkName | QbitNetworkParams): string {
  assertByteLength(program, P2MR_PROGRAM_BYTES, 'P2MR program')
  const params = getQbitNetwork(network)
  const data = [P2MR_WITNESS_VERSION, ...convertBits([...program], 8, 5, true)]
  return bech32Encode('bech32m', params.bech32Hrp, data)
}

export function decodeP2mrAddress(
  address: string,
  expectedNetwork?: QbitNetworkName | QbitNetworkParams
): DecodedP2mrAddress {
  const decoded = bech32Decode(address)
  if (decoded.encoding !== 'bech32m') {
    throw new QbitProtocolError('WRONG_ENCODING', 'P2MR addresses must use bech32m')
  }

  const decodedNetwork = networkNameForHrp(decoded.hrp)
  if (decodedNetwork === undefined) {
    throw new QbitProtocolError('WRONG_HRP', `unsupported qbit address HRP: ${decoded.hrp}`)
  }

  let network = decodedNetwork
  if (expectedNetwork !== undefined) {
    const expected = getQbitNetwork(expectedNetwork)
    if (decoded.hrp !== expected.bech32Hrp) {
      throw new QbitProtocolError('WRONG_HRP', `expected ${expected.bech32Hrp} HRP, got ${decoded.hrp}`)
    }
    network = expected.name
  }

  const [version, ...programWords] = decoded.data
  if (version !== P2MR_WITNESS_VERSION) {
    throw new QbitProtocolError('WRONG_WITNESS_VERSION', 'P2MR witness version must be 2')
  }

  const program = new Uint8Array(convertBits(programWords, 5, 8, false))
  if (program.length !== P2MR_PROGRAM_BYTES) {
    throw new QbitProtocolError('WRONG_PROGRAM_LENGTH', 'P2MR witness program must be 32 bytes')
  }

  return {
    network,
    hrp: decoded.hrp,
    program,
  }
}

export function p2mrScriptPubKey(root: Uint8Array): Uint8Array {
  assertByteLength(root, P2MR_PROGRAM_BYTES, 'P2MR merkle root')
  return concatBytes(Uint8Array.of(OP_2, P2MR_PROGRAM_BYTES), root)
}

export function addressToScriptPubKey(
  address: string,
  expectedNetwork?: QbitNetworkName | QbitNetworkParams
): Uint8Array {
  return p2mrScriptPubKey(decodeP2mrAddress(address, expectedNetwork).program)
}

/**
 * Encode a P2MR `scriptPubKey` as an address. The script must be a
 * `Uint8Array` (a Node `Buffer` or one from another realm passes); anything
 * else throws `INVALID_BYTES`.
 */
export function outputScriptToAddress(scriptPubKey: Uint8Array, network: QbitNetworkName | QbitNetworkParams): string {
  assertBytes(scriptPubKey, 'scriptPubKey')
  if (scriptPubKey.length !== 34 || scriptPubKey[0] !== OP_2 || scriptPubKey[1] !== P2MR_PROGRAM_BYTES) {
    throw new QbitProtocolError('INVALID_SCRIPT', 'expected OP_2 PUSH32 P2MR scriptPubKey')
  }
  return encodeP2mrAddress(copyBytes(scriptPubKey, 2), network)
}

export interface RestrictedOutputModeOptions {
  /**
   * Also allow qbit Core's reserved future witness outputs (witness v3..v16
   * with a 2..40-byte program), as Core does once
   * `OuterReservedWitnessActiveAtHeight` holds: at every height on mainnet,
   * testnet4 and signet (`nOuterReservedWitnessHeight = 0`,
   * src/kernel/chainparams.cpp:146,347,471), and on regtest only after
   * `-testactivationheight=outerwitness@<height>` (:557). Pass `true` for
   * Core's exact consensus answer on those networks.
   *
   * Default `false`. Such outputs are non-standard on every network
   * (src/policy/policy.cpp:156), so a default node never relays a transaction
   * that creates one, and until a soft fork gives them meaning anyone can
   * spend them.
   */
  reservedWitnessActive?: boolean
}

/**
 * Whether qbit Core's restricted-output mode allows an output with this
 * scriptPubKey (`Consensus::IsRestrictedOutputModeConsensusOutput`,
 * src/consensus/restricted_outputs.h:18-39 @ v1.0.0). Consensus allows only:
 *
 * - P2MR: witness v2 with a 32-byte program (`OP_2 <32 bytes>`);
 * - any script that starts with `OP_RETURN`, whatever follows and however long;
 * - P2A, the pay-to-anchor script `OP_1 <0x4e73>` (`51024e73`);
 * - with `reservedWitnessActive: true`, witness v3..v16 with a 2..40-byte
 *   program.
 *
 * Any other output, including P2PKH, P2SH, P2WPKH, P2WSH, P2TR, any other
 * witness v0, v1 or v2 program, a bare script and the empty script, makes the
 * transaction consensus-invalid. Core rejects it from the mempool with
 * `tx-output-not-p2mr` (src/validation.cpp:849) and in a block with
 * `bad-txns-output-not-p2mr` (:2855-2859). The mode is on for mainnet,
 * testnet4 and signet, and on regtest unless the node runs with
 * `-p2mronly=0` (src/kernel/chainparams.cpp:159,360,482,571,
 * src/chainparams.cpp:49).
 *
 * This is the consensus rule, not relay policy. An `OP_RETURN` output whose
 * data is not push-only, or `OP_RETURN` data beyond the node's
 * `-datacarriersize` (default 200,000 bytes over the whole transaction), is
 * allowed here but non-standard (src/script/solver.cpp:164,
 * src/policy/policy.cpp:161-167).
 *
 * @throws {QbitProtocolError} `INVALID_BYTES` if `scriptPubKey` is not a `Uint8Array`.
 */
export function isRestrictedOutputModeOutput(
  scriptPubKey: Uint8Array,
  options: RestrictedOutputModeOptions = {}
): boolean {
  assertBytes(scriptPubKey, 'scriptPubKey')
  if (scriptPubKey[0] === OP_RETURN || bytesEqual(scriptPubKey, PAY_TO_ANCHOR_SCRIPT)) return true
  const version = witnessProgramVersion(scriptPubKey)
  if (version === P2MR_WITNESS_VERSION) return scriptPubKey.length === 2 + P2MR_PROGRAM_BYTES
  return version !== undefined && version >= 3 && options.reservedWitnessActive === true
}

/** qbit Core `CScript::IsWitnessProgram` (src/script/script.cpp:256-270): the witness version, if any. */
function witnessProgramVersion(script: Uint8Array): number | undefined {
  if (script.length < 4 || script.length > 42 || script[1]! + 2 !== script.length) return undefined
  const opcode = script[0]!
  if (opcode === OP_0) return 0
  return opcode >= OP_1 && opcode <= OP_16 ? opcode - OP_1 + 1 : undefined
}

/**
 * Refuse outputs that qbit Core's restricted-output mode rejects, so no
 * signature is spent on a transaction that can never confirm. Only a literal
 * `false` (Core's regtest `-p2mronly=0`) turns the check off.
 */
function assertRestrictedOutputModeOutputs(
  outputs: readonly { scriptPubKey: Uint8Array }[],
  restrictedOutputMode: boolean | undefined
): void {
  if (restrictedOutputMode === false) return
  outputs.forEach((output, index) => {
    assertBytes(output.scriptPubKey, `output ${index} scriptPubKey`)
    if (!isRestrictedOutputModeOutput(output.scriptPubKey)) {
      throw new QbitProtocolError(
        'INVALID_SCRIPT',
        `output ${index}: qbit restricted-output mode allows only P2MR, OP_RETURN and P2A outputs ` +
          '(Core rejects the transaction with tx-output-not-p2mr)'
      )
    }
  })
}

export function p2mrAddressFromRoot(root: Uint8Array, network: QbitNetworkName | QbitNetworkParams): string {
  return encodeP2mrAddress(root, network)
}

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
  return concatBytes(...chunks)
}

export function p2mrLeafHash(leafVersion: number, script: Uint8Array = new Uint8Array()): Uint8Array {
  assertLeafVersion(leafVersion)
  assertBytes(script, 'P2MR leaf script')
  return taggedHash('P2MRLeaf', Uint8Array.of(leafVersion), compactSize(script.length), script)
}

export function p2mrBranchHash(a: Uint8Array, b: Uint8Array): Uint8Array {
  assertByteLength(a, P2MR_PROGRAM_BYTES, 'left P2MR branch')
  assertByteLength(b, P2MR_PROGRAM_BYTES, 'right P2MR branch')
  const [first, second] = compareBytes(a, b) < 0 ? [a, b] : [b, a]
  return taggedHash('P2MRBranch', first, second)
}

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
  return concatBytes(...chunks)
}

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

/**
 * Construct a structured wallet-level data-hash proof for a P2MR message signature.
 * The caller supplies signature bytes; private-key operations deliberately live
 * outside this protocol package.
 *
 * `pubkey`, `signature`, `leafScript` and `controlBlock` must each be a
 * `Uint8Array` (a Node `Buffer` or one from another realm passes). A string,
 * array or other view throws `INVALID_BYTES`, whatever its length.
 */
export function createP2mrMessageProof(params: CreateP2mrMessageProofParams): P2mrMessageProof {
  const {
    message,
    address,
    pubkey,
    signature,
    leafVersion = P2MR_LEAF_VERSION_V1,
    leafScript = singleKeyLeafScript(pubkey),
    controlBlock = buildControlBlock(leafVersion),
  } = params
  assertByteLength(pubkey, P2MR_PROGRAM_BYTES, 'P2MR message pubkey')
  assertByteLength(signature, PQC_SIGNATURE_BYTES, 'P2MR message signature')
  assertBytes(leafScript, 'P2MR message leaf script')
  assertBytes(controlBlock, 'P2MR message control block')
  if (leafVersion !== P2MR_LEAF_VERSION_V1) {
    throw new QbitProtocolError('INVALID_SCRIPT', 'unsupported P2MR message leaf version')
  }

  const expectedLeafScript = singleKeyLeafScript(pubkey)
  if (compareBytes(leafScript, expectedLeafScript) !== 0) {
    throw new QbitProtocolError('INVALID_SCRIPT', 'P2MR message leaf script does not match its public key')
  }
  const leafHash = p2mrLeafHash(leafVersion, leafScript)
  const merkleRoot = verifyControlBlock(controlBlock, leafHash, leafVersion)
  const decodedAddress = decodeP2mrAddress(address)
  if (compareBytes(decodedAddress.program, merkleRoot) !== 0) {
    throw new QbitProtocolError('INVALID_SCRIPT', 'P2MR message control block does not commit to its address')
  }

  const messageHash = qbitWalletMessageHash(message)
  const datasigHash = qbitDataSigPqcHash(messageHash)
  return {
    type: P2MR_MESSAGE_PROOF_TYPE,
    version: P2MR_MESSAGE_PROOF_VERSION,
    // Always emit the canonical lowercase spelling so verifiers can compare strings.
    address: canonicalP2mrAddress(decodedAddress),
    message_hash: bytesToHex(messageHash),
    datasig_hash: bytesToHex(datasigHash),
    domain: QBIT_DATA_SIG_PQC_DOMAIN,
    message_domain: QBIT_WALLET_MESSAGE_DOMAIN,
    algorithm: P2MR_MESSAGE_ALGORITHM,
    proof_mode: P2MR_MESSAGE_PROOF_MODE,
    pubkey: bytesToHex(pubkey),
    signature: bytesToHex(signature),
    leaf_version: leafVersion,
    leaf_script: bytesToHex(leafScript),
    control_block: bytesToHex(controlBlock),
    p2mr_merkle_root: bytesToHex(merkleRoot),
  }
}

/**
 * Verify a structured wallet-level P2MR message proof and bind it to the address
 * and/or network the relying party expects. Pass `@qbit-oss/pqc.verify` as
 * `verifyPqc` after initializing that package's client.
 *
 * Never trust `proof.address` from the proof object alone. `proof.address` must
 * be the canonical lowercase bech32m spelling and must decode to the same HRP and
 * witness program as `expectedAddress` (when given) on `expectedNetwork` (when
 * given). Any other spelling, including uppercase or Unicode look-alikes, and any
 * other network's HRP are rejected; an uppercase `proof.address` returns `false`,
 * so re-create such a proof with `createP2mrMessageProof`, which emits the
 * canonical spelling. A proof that verifies with `expectedAddress` is a proof for
 * that address; one that verifies with only `expectedNetwork` is a proof for the
 * canonical address string in `proof.address` on that network (signet and
 * Testnet4 are indistinguishable, see {@link VerifyP2mrMessageProofOptions}).
 *
 * A proof that fails verification returns `false`.
 *
 * @throws {TypeError} if `options` is missing, `null` or not an object, or sets
 * neither `expectedAddress` nor `expectedNetwork`. This is a programming error,
 * not an invalid proof, so it is never reported as `false`.
 */
export function verifyP2mrMessageProof(
  message: string,
  proof: unknown,
  verifyPqc: P2mrPqcVerifyFn,
  options: VerifyP2mrMessageProofOptions
): boolean {
  // Checked outside the `try` so that untyped callers omitting the expectation
  // (or passing a missing config field) fail loudly instead of reading `false`.
  if (!isRecord(options)) {
    throw new TypeError('verifyP2mrMessageProof requires options with { expectedAddress } and/or { expectedNetwork }')
  }
  // Read each field once: a getter or Proxy must not pass this check and then
  // read as unset when the binding is applied.
  const rawExpectedAddress: unknown = options.expectedAddress
  const rawExpectedNetwork: unknown = options.expectedNetwork
  if (rawExpectedAddress === undefined && rawExpectedNetwork === undefined) {
    throw new TypeError('verifyP2mrMessageProof requires options with { expectedAddress } and/or { expectedNetwork }')
  }
  try {
    if (typeof message !== 'string' || typeof verifyPqc !== 'function' || !isRecord(proof)) {
      return false
    }
    let expectedAddress: string | undefined
    let expectedNetwork: QbitNetworkName | QbitNetworkParams | undefined
    if (rawExpectedAddress !== undefined) {
      if (typeof rawExpectedAddress !== 'string') return false
      expectedAddress = rawExpectedAddress
    }
    if (rawExpectedNetwork !== undefined) {
      if (typeof rawExpectedNetwork !== 'string' && !isRecord(rawExpectedNetwork)) {
        return false
      }
      expectedNetwork = rawExpectedNetwork as QbitNetworkName | QbitNetworkParams
    }
    const candidate = proof as Partial<P2mrMessageProof>
    if (
      candidate.type !== P2MR_MESSAGE_PROOF_TYPE ||
      candidate.version !== P2MR_MESSAGE_PROOF_VERSION ||
      candidate.domain !== QBIT_DATA_SIG_PQC_DOMAIN ||
      candidate.message_domain !== QBIT_WALLET_MESSAGE_DOMAIN ||
      candidate.algorithm !== P2MR_MESSAGE_ALGORITHM ||
      candidate.proof_mode !== P2MR_MESSAGE_PROOF_MODE ||
      candidate.leaf_version !== P2MR_LEAF_VERSION_V1 ||
      typeof candidate.address !== 'string' ||
      !isCanonicalHex(candidate.message_hash, 32) ||
      !isCanonicalHex(candidate.datasig_hash, 32) ||
      !isCanonicalHex(candidate.pubkey, P2MR_PROGRAM_BYTES) ||
      !isCanonicalHex(candidate.signature, PQC_SIGNATURE_BYTES) ||
      !isCanonicalHex(candidate.leaf_script, 34) ||
      !isCanonicalControlBlockHex(candidate.control_block) ||
      !isCanonicalHex(candidate.p2mr_merkle_root, P2MR_PROGRAM_BYTES)
    ) {
      return false
    }

    const messageHash = qbitWalletMessageHash(message)
    const datasigHash = qbitDataSigPqcHash(messageHash)
    if (candidate.message_hash !== bytesToHex(messageHash) || candidate.datasig_hash !== bytesToHex(datasigHash)) {
      return false
    }

    const pubkey = hexToBytes(candidate.pubkey)
    const leafScript = hexToBytes(candidate.leaf_script)
    if (compareBytes(leafScript, singleKeyLeafScript(pubkey)) !== 0) {
      return false
    }
    const leafHash = p2mrLeafHash(candidate.leaf_version, leafScript)
    const merkleRoot = verifyControlBlock(hexToBytes(candidate.control_block), leafHash, candidate.leaf_version)
    // Decoding with `expectedNetwork` rejects a proof address with any other
    // network's HRP (signet and Testnet4 share `tq`), and the decoder rejects
    // non-ASCII look-alikes such as U+212A. The canonical-spelling check rejects
    // an uppercase spelling of the same program.
    const proofAddress = decodeP2mrAddress(candidate.address, expectedNetwork)
    if (
      candidate.p2mr_merkle_root !== bytesToHex(merkleRoot) ||
      compareBytes(proofAddress.program, merkleRoot) !== 0 ||
      canonicalP2mrAddress(proofAddress) !== candidate.address
    ) {
      return false
    }
    if (expectedAddress !== undefined) {
      const expected = decodeP2mrAddress(expectedAddress, expectedNetwork)
      if (expected.hrp !== proofAddress.hrp || compareBytes(expected.program, proofAddress.program) !== 0) {
        return false
      }
    }

    return verifyPqc(pubkey, datasigHash, hexToBytes(candidate.signature)) === true
  } catch (error) {
    return false
  }
}

/** Canonical lowercase bech32m spelling of a decoded P2MR address. */
function canonicalP2mrAddress(decoded: DecodedP2mrAddress): string {
  return bech32Encode('bech32m', decoded.hrp, [P2MR_WITNESS_VERSION, ...convertBits([...decoded.program], 8, 5, true)])
}

export function isValidP2mrSighashType(hashType: number): boolean {
  return (
    Number.isInteger(hashType) &&
    hashType >= 0 &&
    hashType <= 0xff &&
    (hashType <= SIGHASH_SINGLE ||
      (hashType >= (SIGHASH_ANYONECANPAY | SIGHASH_ALL) && hashType <= (SIGHASH_ANYONECANPAY | SIGHASH_SINGLE)))
  )
}

/**
 * Encode a P2MR witness signature item: the 3680-byte signature, followed by
 * `hashType` unless it is `SIGHASH_DEFAULT`. `signature` must be a `Uint8Array`
 * (a Node `Buffer` or one from another realm passes); a string, array or other
 * view throws `INVALID_BYTES`, whatever its length.
 */
export function encodeP2mrWitnessSignature(signature: Uint8Array, hashType: number = SIGHASH_DEFAULT): Uint8Array {
  assertByteLength(signature, PQC_SIGNATURE_BYTES, 'PQC signature')
  if (!isValidP2mrSighashType(hashType)) {
    throw new QbitProtocolError('INVALID_SCRIPT', 'invalid P2MR sighash type')
  }
  if (hashType === SIGHASH_DEFAULT) {
    return new Uint8Array(signature)
  }
  return concatBytes(signature, Uint8Array.of(hashType))
}

/**
 * Split a P2MR witness signature into the PQC signature and its sighash type.
 * `value` must be a `Uint8Array`; anything else throws `INVALID_BYTES`.
 */
export function decodeP2mrWitnessSignature(value: Uint8Array): P2mrWitnessSignature {
  assertBytes(value, 'P2MR witness signature')
  if (value.length !== PQC_SIGNATURE_BYTES && value.length !== PQC_SIGNATURE_BYTES + 1) {
    throw new QbitProtocolError('INVALID_SCRIPT', 'P2MR witness signature has invalid length')
  }
  if (value.length === PQC_SIGNATURE_BYTES) {
    return {
      signature: new Uint8Array(value),
      hashType: SIGHASH_DEFAULT,
      explicitHashType: false,
    }
  }

  const hashType = value[value.length - 1]!
  if (hashType === SIGHASH_DEFAULT || !isValidP2mrSighashType(hashType)) {
    throw new QbitProtocolError('INVALID_SCRIPT', 'P2MR witness signature has invalid sighash type')
  }
  return {
    signature: copyBytes(value, 0, PQC_SIGNATURE_BYTES),
    hashType,
    explicitHashType: true,
  }
}

// ---------------------------------------------------------------------------
// P2MR signature hash (P2MRSighash)
//
// Byte-exact port of qbit Core's SignatureHashSchnorrCommon (SigVersion::P2MR)
// from src/script/interpreter.cpp @ Qbit-Org/qbit v1.0.0 (7ebcddb6). P2MR reuses
// the Tapscript message (ext_flag=1, key_version=0); it differs only by the
// hash tag (P2MRSighash) and the committed leaf hash (a P2MRLeaf hash). See
// docs/p2mr-sighash.md.
// ---------------------------------------------------------------------------

export interface P2mrOutpoint {
  /**
   * Transaction id in serialization (internal) byte order — the reverse of the
   * big-endian txid shown by explorers and RPC. Exactly 32 bytes.
   */
  txid: Uint8Array
  /** Output index within the funding transaction (uint32). */
  vout: number
}

export interface P2mrTransactionInput {
  prevout: P2mrOutpoint
  /** nSequence (uint32). */
  sequence: number
}

export interface P2mrTransactionOutput {
  /** Amount in satoshis; must satisfy `MoneyRange` (0 ≤ value ≤ `QBIT_MAX_MONEY`). */
  value: bigint
  scriptPubKey: Uint8Array
}

export interface P2mrTransaction {
  /** nVersion (uint32, as qbit Core's `CTransaction::version`; a legacy int32 `-1` is `0xffffffff`). */
  version: number
  /** nLockTime (uint32). */
  locktime: number
  inputs: readonly P2mrTransactionInput[]
  outputs: readonly P2mrTransactionOutput[]
}

/** A previous output being spent (amount + scriptPubKey), one per input in input order. */
export interface P2mrSpentOutput {
  /** Amount in satoshis; must satisfy `MoneyRange` (0 ≤ value ≤ `QBIT_MAX_MONEY`). */
  value: bigint
  scriptPubKey: Uint8Array
}

/**
 * Precomputed transaction midstates — the qbit Core `PrecomputedTransactionData`
 * equivalent. Each is a single SHA-256 commitment, computed once per transaction
 * and reused across inputs.
 */
export interface SighashMidstates {
  prevouts: Uint8Array
  amounts: Uint8Array
  scriptPubKeys: Uint8Array
  sequences: Uint8Array
  outputs: Uint8Array
}

export type SchnorrSigVersion = 'taproot' | 'tapscript' | 'p2mr'

export interface SchnorrSighashParams {
  tx: P2mrTransaction
  inputIndex: number
  /** Previous outputs spent by each input, in input order. */
  spentOutputs: readonly P2mrSpentOutput[]
  /** Sighash type; defaults to SIGHASH_DEFAULT (0x00, ≡ ALL). */
  hashType?: number
  sigVersion: SchnorrSigVersion
  /** Committed leaf hash (32 bytes). Required for 'tapscript' and 'p2mr'. */
  leafHash?: Uint8Array
  /** Key version committed for script-path spends (uint8). Default 0. */
  keyVersion?: number
  /** Code-separator position (uint32). Default 0xffffffff (none executed). */
  codeSeparatorPos?: number
  /** Raw annex bytes. If present, committed as SHA256(compactSize(len)||annex). */
  annex?: Uint8Array
  /**
   * Optional precomputed midstates; computed from tx + spentOutputs when
   * omitted. Each field must be a 32-byte `Uint8Array` (`INVALID_BYTES`).
   */
  midstates?: SighashMidstates
}

/**
 * Check every field a signature hash commits to and that the serializers would
 * otherwise validate (uint32 fields, amounts, the 32-byte prevout txid, the
 * output and spent-output scripts), so a
 * caller-supplied cached `midstates` can never stand in for unchecked fields.
 */
function assertSighashRanges(tx: P2mrTransaction, spentOutputs: readonly P2mrSpentOutput[]): void {
  assertUint32(tx.version, 'version')
  assertUint32(tx.locktime, 'locktime')
  tx.inputs.forEach((input, i) => {
    assertByteLength(input.prevout.txid, P2MR_PROGRAM_BYTES, `input ${i} outpoint txid`)
    assertUint32(input.prevout.vout, `input ${i} vout`)
    assertUint32(input.sequence, `input ${i} sequence`)
  })
  tx.outputs.forEach((output, i) => {
    assertMoneyRange(output.value, `output ${i} value`)
    assertBytes(output.scriptPubKey, `output ${i} scriptPubKey`)
  })
  spentOutputs.forEach((output, i) => {
    assertMoneyRange(output.value, `spent output ${i} value`)
    assertBytes(output.scriptPubKey, `spent output ${i} scriptPubKey`)
  })
}

/**
 * A caller's cached midstates are hashed into the digest as given, so each must
 * be a 32-byte `Uint8Array`: a hex string or a short field would otherwise give
 * a digest qbit Core never computes, and a signature spent on it is lost.
 */
function assertSighashMidstates(midstates: SighashMidstates): void {
  for (const field of ['prevouts', 'amounts', 'scriptPubKeys', 'sequences', 'outputs'] as const) {
    assertByteLength(midstates[field], 32, `midstates.${field}`)
  }
}

/**
 * Compute the five precomputed sighash midstates for a transaction. Pass the
 * result as `midstates` to `p2mrSighash`/`schnorrSignatureHash` to avoid
 * recomputing them when signing multiple inputs. Every txid and
 * `scriptPubKey` must be a `Uint8Array`; anything else throws `INVALID_BYTES`.
 */
export function precomputeSighashMidstates(
  tx: P2mrTransaction,
  spentOutputs: readonly P2mrSpentOutput[]
): SighashMidstates {
  if (spentOutputs.length !== tx.inputs.length) {
    throw new QbitProtocolError('INVALID_SIGHASH', 'spentOutputs length must equal inputs length')
  }
  return {
    prevouts: sha256(concatBytes(...tx.inputs.map(input => serializeOutpoint(input.prevout)))),
    amounts: sha256(
      concatBytes(...spentOutputs.map((output, i) => serializeAmount(output.value, `spent output ${i} value`)))
    ),
    scriptPubKeys: sha256(
      concatBytes(
        ...spentOutputs.map((output, i) => serializeVarBytes(output.scriptPubKey, `spent output ${i} scriptPubKey`))
      )
    ),
    sequences: sha256(concatBytes(...tx.inputs.map(input => uint32LE(input.sequence, 'sequence')))),
    outputs: sha256(concatBytes(...tx.outputs.map((output, i) => serializeTxOut(output, `output ${i}`)))),
  }
}

/**
 * BIP341-style Schnorr signature hash, parameterized by signature version.
 * `p2mr` is the qbit P2MR variant; `taproot`/`tapscript` follow BIP341 and are
 * used to validate this implementation against Core's committed BIP341 vectors.
 */
export function schnorrSignatureHash(params: SchnorrSighashParams): Uint8Array {
  const {
    tx,
    inputIndex,
    spentOutputs,
    sigVersion,
    hashType = SIGHASH_DEFAULT,
    keyVersion = 0,
    codeSeparatorPos = 0xffffffff,
    annex,
  } = params

  if (!Number.isInteger(inputIndex) || inputIndex < 0 || inputIndex >= tx.inputs.length) {
    throw new QbitProtocolError('INVALID_SIGHASH', 'inputIndex out of range')
  }
  if (spentOutputs.length !== tx.inputs.length) {
    throw new QbitProtocolError('INVALID_SIGHASH', 'spentOutputs length must equal inputs length')
  }
  if (!isValidP2mrSighashType(hashType)) {
    throw new QbitProtocolError('INVALID_SIGHASH', `invalid sighash type 0x${hashType.toString(16)}`)
  }
  assertUint8(keyVersion, 'keyVersion')
  assertUint32(codeSeparatorPos, 'codeSeparatorPos')
  assertSighashRanges(tx, spentOutputs)
  const scriptPath = sigVersion === 'tapscript' || sigVersion === 'p2mr'
  if (scriptPath && !isBytesOfLength(params.leafHash, P2MR_PROGRAM_BYTES)) {
    throw new QbitProtocolError('INVALID_SIGHASH', `${sigVersion} sighash requires a 32-byte leafHash`)
  }

  const tag = sigVersion === 'p2mr' ? 'P2MRSighash' : 'TapSighash'
  const extFlag = sigVersion === 'taproot' ? 0 : 1
  const midstates = params.midstates ?? precomputeSighashMidstates(tx, spentOutputs)
  assertSighashMidstates(midstates)
  const outputType = hashType === SIGHASH_DEFAULT ? SIGHASH_ALL : hashType & SIGHASH_OUTPUT_MASK
  const inputType = hashType & SIGHASH_INPUT_MASK

  const parts: Uint8Array[] = [Uint8Array.of(0x00 /* epoch */), Uint8Array.of(hashType)]
  parts.push(uint32LE(tx.version, 'version'), uint32LE(tx.locktime, 'locktime'))
  if (inputType !== SIGHASH_ANYONECANPAY) {
    parts.push(midstates.prevouts, midstates.amounts, midstates.scriptPubKeys, midstates.sequences)
  }
  if (outputType === SIGHASH_ALL) {
    parts.push(midstates.outputs)
  }
  const haveAnnex = annex !== undefined
  parts.push(Uint8Array.of((extFlag << 1) + (haveAnnex ? 1 : 0)))
  if (inputType === SIGHASH_ANYONECANPAY) {
    const input = tx.inputs[inputIndex]!
    const spent = spentOutputs[inputIndex]!
    parts.push(
      serializeOutpoint(input.prevout),
      serializeAmount(spent.value, `spent output ${inputIndex} value`),
      serializeVarBytes(spent.scriptPubKey, `spent output ${inputIndex} scriptPubKey`),
      uint32LE(input.sequence, 'sequence')
    )
  } else {
    parts.push(uint32LE(inputIndex, 'inputIndex'))
  }
  if (haveAnnex) {
    parts.push(sha256(serializeVarBytes(annex, 'annex')))
  }
  if (outputType === SIGHASH_SINGLE) {
    if (inputIndex >= tx.outputs.length) {
      throw new QbitProtocolError('INVALID_SIGHASH', 'SIGHASH_SINGLE without a matching output')
    }
    parts.push(sha256(serializeTxOut(tx.outputs[inputIndex]!, `output ${inputIndex}`)))
  }
  if (scriptPath) {
    parts.push(params.leafHash!, Uint8Array.of(keyVersion), uint32LE(codeSeparatorPos, 'codeSeparatorPos'))
  }
  return taggedHash(tag, concatBytes(...parts))
}

export interface P2mrSighashParams {
  tx: P2mrTransaction
  inputIndex: number
  /** Previous outputs spent by each input, in input order. */
  spentOutputs: readonly P2mrSpentOutput[]
  /** Committed P2MR leaf hash for the input being signed (32 bytes). */
  leafHash: Uint8Array
  /** Sighash type; defaults to SIGHASH_DEFAULT (0x00, ≡ ALL). */
  hashType?: number
  /** Code-separator position (uint32). Default 0xffffffff (none executed). */
  codeSeparatorPos?: number
  /** Raw annex bytes, if any. */
  annex?: Uint8Array
  /**
   * Optional precomputed midstates; computed from tx + spentOutputs when
   * omitted. Each field must be a 32-byte `Uint8Array` (`INVALID_BYTES`).
   */
  midstates?: SighashMidstates
}

/**
 * Compute the qbit P2MR signature hash for one input. Byte-exact with qbit
 * Core `SignatureHashP2MR`. See docs/p2mr-sighash.md. Every txid, output and
 * spent-output `scriptPubKey` and the `annex` must be a `Uint8Array`, even
 * when `midstates` is given, and each `midstates` field a 32-byte one;
 * anything else throws `INVALID_BYTES` instead of returning a digest over
 * different bytes.
 */
export function p2mrSighash(params: P2mrSighashParams): Uint8Array {
  return schnorrSignatureHash({ ...params, sigVersion: 'p2mr' })
}

/**
 * Encode a PSBT_IN_P2MR_SCRIPT_SIG (0x19) record keyed by (pubkey, leafHash).
 * Every byte argument must be a `Uint8Array` of the right length (a Node
 * `Buffer` or one from another realm passes); anything else throws
 * `INVALID_BYTES`.
 */
export function encodeP2mrPsbtScriptSigField(
  pubkey: Uint8Array,
  leafHash: Uint8Array,
  signature: Uint8Array,
  hashType: number = SIGHASH_DEFAULT
): { key: Uint8Array; value: Uint8Array } {
  assertByteLength(pubkey, P2MR_PROGRAM_BYTES, 'P2MR pubkey')
  assertByteLength(leafHash, P2MR_PROGRAM_BYTES, 'P2MR leaf hash')
  return {
    key: concatBytes(Uint8Array.of(PSBT_IN_P2MR_SCRIPT_SIG), pubkey, leafHash),
    value: encodeP2mrWitnessSignature(signature, hashType),
  }
}

/**
 * Decode a PSBT_IN_P2MR_SCRIPT_SIG (0x19) record. `key` and `value` must be
 * `Uint8Array`s; anything else throws `INVALID_BYTES`.
 */
export function decodeP2mrPsbtScriptSigField(key: Uint8Array, value: Uint8Array): P2mrPsbtScriptSigField {
  assertBytes(key, 'P2MR script signature key')
  if (key.length !== 1 + P2MR_PROGRAM_BYTES + P2MR_PROGRAM_BYTES || key[0] !== PSBT_IN_P2MR_SCRIPT_SIG) {
    throw new QbitProtocolError('INVALID_PSBT', 'input P2MR script signature key must be type||pubkey32||leafhash32')
  }
  return {
    type: 'p2mrScriptSig',
    pubkey: copyBytes(key, 1, 1 + P2MR_PROGRAM_BYTES),
    leafHash: copyBytes(key, 1 + P2MR_PROGRAM_BYTES),
    signature: decodeP2mrWitnessSignature(value),
  }
}

export function encodeP2mrPsbtLeafScriptField(
  controlBlock: Uint8Array,
  script: Uint8Array,
  leafVersion: number = P2MR_LEAF_VERSION_V1
): { key: Uint8Array; value: Uint8Array } {
  assertP2mrControlBlockShape(controlBlock)
  assertBytes(script, 'P2MR leaf script')
  assertLeafVersion(leafVersion)
  return {
    key: concatBytes(Uint8Array.of(PSBT_IN_P2MR_LEAF_SCRIPT), controlBlock),
    value: concatBytes(script, Uint8Array.of(leafVersion)),
  }
}

export function decodeP2mrPsbtLeafScriptField(key: Uint8Array, value: Uint8Array): P2mrPsbtLeafScriptField {
  if (key.length < 1 || key[0] !== PSBT_IN_P2MR_LEAF_SCRIPT) {
    throw new QbitProtocolError('INVALID_PSBT', 'input P2MR leaf script key has wrong type')
  }
  const controlBlock = copyBytes(key, 1)
  assertP2mrControlBlockShape(controlBlock)
  if (value.length === 0) {
    throw new QbitProtocolError('INVALID_PSBT', 'P2MR leaf script value must include script and leaf version')
  }
  const leafVersion = value[value.length - 1]!
  assertLeafVersion(leafVersion)
  return {
    type: 'p2mrLeafScript',
    controlBlock,
    script: copyBytes(value, 0, -1),
    leafVersion,
  }
}

/**
 * Decode a `qbit` proprietary P2MR input record. `keyData` must be a
 * `Uint8Array`, for every subtype; anything else throws `INVALID_BYTES`.
 */
export function decodeQbitProprietaryP2mrInputField(
  subtype: number,
  keyData: Uint8Array,
  value: Uint8Array
): QbitProprietaryP2mrField {
  // Checked before it is copied: concatBytes would turn a string into zeros.
  assertBytes(keyData, 'qbit P2MR key data')
  if (subtype === PSBT_QBIT_IN_P2MR_MERKLE_ROOT) {
    if (keyData.length !== 0) {
      throw new QbitProtocolError('INVALID_PSBT', 'qbit P2MR merkle root key data must be empty')
    }
    assertByteLength(value, P2MR_PROGRAM_BYTES, 'qbit P2MR merkle root')
    return {
      type: 'qbitP2mrMerkleRoot',
      merkleRoot: new Uint8Array(value),
    }
  }

  if (subtype === PSBT_QBIT_IN_P2MR_LEAF_SCRIPT) {
    return {
      ...decodeP2mrPsbtLeafScriptField(concatBytes(Uint8Array.of(PSBT_IN_P2MR_LEAF_SCRIPT), keyData), value),
      type: 'p2mrLeafScript',
    }
  }

  if (subtype === PSBT_QBIT_IN_P2MR_SCRIPT_SIG) {
    return {
      ...decodeP2mrPsbtScriptSigField(concatBytes(Uint8Array.of(PSBT_IN_P2MR_SCRIPT_SIG), keyData), value),
      type: 'p2mrScriptSig',
    }
  }

  throw new QbitProtocolError('INVALID_PSBT', 'unsupported qbit proprietary P2MR subtype')
}

export function encodeQbitProprietaryP2mrMerkleRootField(merkleRoot: Uint8Array): EncodedQbitProprietaryP2mrField {
  assertByteLength(merkleRoot, P2MR_PROGRAM_BYTES, 'qbit P2MR merkle root')
  return {
    identifier: PSBT_QBIT_IDENTIFIER,
    subtype: PSBT_QBIT_IN_P2MR_MERKLE_ROOT,
    keyData: new Uint8Array(),
    value: new Uint8Array(merkleRoot),
  }
}

export function encodeQbitProprietaryP2mrLeafScriptField(
  controlBlock: Uint8Array,
  script: Uint8Array,
  leafVersion: number = P2MR_LEAF_VERSION_V1
): EncodedQbitProprietaryP2mrField {
  const field = encodeP2mrPsbtLeafScriptField(controlBlock, script, leafVersion)
  return {
    identifier: PSBT_QBIT_IDENTIFIER,
    subtype: PSBT_QBIT_IN_P2MR_LEAF_SCRIPT,
    keyData: field.key.slice(1),
    value: field.value,
  }
}

export function encodeQbitProprietaryP2mrScriptSigField(
  pubkey: Uint8Array,
  leafHash: Uint8Array,
  signature: Uint8Array,
  hashType: number = SIGHASH_DEFAULT
): EncodedQbitProprietaryP2mrField {
  const field = encodeP2mrPsbtScriptSigField(pubkey, leafHash, signature, hashType)
  return {
    identifier: PSBT_QBIT_IDENTIFIER,
    subtype: PSBT_QBIT_IN_P2MR_SCRIPT_SIG,
    keyData: field.key.slice(1),
    value: field.value,
  }
}

// ---------------------------------------------------------------------------
// PSBT container (BIP174 v0, qbit-aware)
//
// A qbit-aware PSBT codec. Generic Bitcoin PSBT tooling silently drops qbit's
// P2MR fields (0x19 / 0x1d / the "qbit" proprietary namespace); this container
// preserves every field, including unknown ones, byte-for-byte.
// ---------------------------------------------------------------------------

/** One key/value record in a PSBT map. `key` includes the leading key type byte. */
export interface PsbtKeyValue {
  key: Uint8Array
  value: Uint8Array
}

/** A parsed PSBT, with each map preserved as an ordered key/value list. */
export interface Psbt {
  global: PsbtKeyValue[]
  inputs: PsbtKeyValue[][]
  outputs: PsbtKeyValue[][]
}

/** Resource limits for decoding untrusted PSBT bytes. */
export interface PsbtLimitOptions {
  /**
   * Largest PSBT `parsePsbt` accepts, and largest transaction
   * `extractP2mrTransaction` builds, in bytes. Default `PSBT_DEFAULT_MAX_BYTES`
   * (16 MiB).
   */
  maxBytes?: number
  /**
   * Most objects one `parsePsbt` or `extractP2mrTransaction` call decodes:
   * PSBT map entries, unsigned-transaction inputs and outputs, and final-witness
   * items, counted together. Default `PSBT_DEFAULT_MAX_OBJECTS` (131,072). Each
   * costs about 0.5 KB of V8 heap however few bytes encode it (a map entry can
   * take 3). A map entry's key and value add up to about 0.25 KB more, because
   * V8 keeps byte arrays of up to 64 bytes on its heap and the duplicate-key
   * check holds the hex of keys of up to 64 bytes (longer keys by SHA-256), and
   * `decodePsbt` adds about 0.4 KB per P2MR leaf script. Longer keys and values
   * live outside the heap, bounded by `maxBytes`. So this, not `maxBytes`,
   * bounds the heap a small, dense PSBT can claim (see
   * `PSBT_DEFAULT_MAX_OBJECTS` for measurements at the defaults).
   * It does not scale with `maxBytes`: a PSBT within `maxBytes` with at most
   * this many objects is accepted however dense it is. Lower both to tighten
   * the memory bound; raise this for a transaction with more than about 131,000
   * inputs and outputs. Each limit must be a positive safe integer, or the call
   * throws `RangeError`.
   */
  maxObjects?: number
}

export interface PsbtInputSummary {
  prevout: P2mrOutpoint
  sequence: number
  witnessUtxo?: P2mrTransactionOutput
  /**
   * `PSBT_IN_SIGHASH_TYPE` (0x03) when present: the sighash type the PSBT
   * creator requires every signature on this input to use. Anything other than
   * `SIGHASH_DEFAULT` must be surfaced by an approval UI before signing.
   */
  sighashType?: number
  merkleRoot?: Uint8Array
  /**
   * The input's P2MR leaf records, `0x1d` and `qbit` subtype `0x02`, in map
   * order. A (control block, script, leaf version) carried in both is listed
   * once.
   */
  leafScripts: P2mrPsbtLeafScriptField[]
  /**
   * The input's P2MR script signatures, `0x19` and `qbit` subtype `0x03`, one
   * per (pubkey, leaf hash) in map order.
   */
  scriptSigs: P2mrPsbtScriptSigField[]
  finalized: boolean
}

export interface PsbtSummary {
  version: number
  locktime: number
  inputs: PsbtInputSummary[]
  outputs: readonly P2mrTransactionOutput[]
  /**
   * Sum of spent amounts minus output amounts; undefined unless every input has
   * a witness UTXO. `decodePsbt` throws `INVALID_AMOUNT` rather than report a
   * fee when the totals leave `MoneyRange` or the outputs exceed the inputs.
   */
  fee?: bigint
}

/**
 * Parse a binary PSBT, preserving all fields (including unknown) in order.
 * Mirrors qbit Core's deserializer: CompactSizes (including each key's type)
 * must be canonical and at most MAX_SIZE, proprietary keys are unserialized
 * eagerly in every map, and `qbit` proprietary P2MR keys in input maps must have
 * the key-data shape Core expects, so such malformed input is rejected with
 * `INVALID_PSBT`.
 *
 * Input larger than `options.maxBytes` is rejected before parsing, and at most
 * `options.maxObjects` objects are decoded (see `PsbtLimitOptions`). Unlike qbit
 * Core, final scriptwitness (`0x08`) values are not decoded here yet;
 * `finalizeP2mrPsbt` and `extractP2mrTransaction` decode and bound them.
 */
export function parsePsbt(bytes: Uint8Array, options: PsbtLimitOptions = {}): Psbt {
  const maxBytes = resolvePsbtLimit(options.maxBytes, PSBT_DEFAULT_MAX_BYTES, 'maxBytes')
  const budget = new PsbtObjectBudget(resolvePsbtLimit(options.maxObjects, PSBT_DEFAULT_MAX_OBJECTS, 'maxObjects'))
  if (bytes.length > maxBytes) {
    throw new QbitProtocolError('INVALID_PSBT', `PSBT is larger than maxBytes (${maxBytes})`)
  }
  const reader = new ByteReader(bytes)
  const magic = reader.readBytes(5)
  if (magic[0] !== 0x70 || magic[1] !== 0x73 || magic[2] !== 0x62 || magic[3] !== 0x74 || magic[4] !== 0xff) {
    throw new QbitProtocolError('INVALID_PSBT', 'invalid PSBT magic bytes')
  }
  const global = readPsbtMap(reader, 'global', budget)
  const txEntry = global.find(entry => entry.key.length === 1 && entry.key[0] === PSBT_GLOBAL_UNSIGNED_TX)
  if (txEntry === undefined) {
    throw new QbitProtocolError('INVALID_PSBT', 'PSBT is missing the unsigned transaction')
  }
  const tx = parseUnsignedTransaction(txEntry.value, budget)
  const inputs = tx.inputs.map(() => readPsbtMap(reader, 'input', budget))
  const outputs = tx.outputs.map(() => readPsbtMap(reader, 'output', budget))
  if (reader.remaining !== 0) {
    throw new QbitProtocolError('INVALID_PSBT', 'trailing data after PSBT maps')
  }
  return { global, inputs, outputs }
}

/**
 * Serialize a PSBT back to bytes. Round-trips `parsePsbt` byte-for-byte. Every
 * map key and value must be a `Uint8Array` (a Node `Buffer` passes); anything
 * else, such as a `number[]` in a hand-built `Psbt`, throws `INVALID_BYTES`.
 */
export function serializePsbt(psbt: Psbt): Uint8Array {
  const parts: Uint8Array[] = [Uint8Array.of(0x70, 0x73, 0x62, 0x74, 0xff), serializePsbtMap(psbt.global)]
  for (const map of psbt.inputs) parts.push(serializePsbtMap(map))
  for (const map of psbt.outputs) parts.push(serializePsbtMap(map))
  return concatByteList(parts)
}

/**
 * Concatenate a list of chunks without spreading it into call arguments.
 * `concatBytes(...parts)` passes one argument per chunk, so a PSBT map with
 * about 63k entries overflows the call stack with a bare `RangeError`.
 */
function concatByteList(chunks: readonly Uint8Array[]): Uint8Array {
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

/** The unsigned transaction carried by a PSBT's global map. */
export function psbtUnsignedTransaction(psbt: Psbt): P2mrTransaction {
  const txEntry = psbt.global.find(entry => entry.key.length === 1 && entry.key[0] === PSBT_GLOBAL_UNSIGNED_TX)
  if (txEntry === undefined) {
    throw new QbitProtocolError('INVALID_PSBT', 'PSBT is missing the unsigned transaction')
  }
  return parseUnsignedTransaction(txEntry.value)
}

/**
 * Combine partial PSBTs into one. All must share the same unsigned transaction.
 * Fields present in multiple inputs are merged; identical duplicates are fine,
 * but the same key with conflicting values is rejected with `INVALID_PSBT`.
 * This is stricter than qbit Core, whose global, input and output `Merge`
 * functions keep the first value they saw (`src/psbt.cpp:50, 244-275, 336`).
 *
 * Each map keeps first-seen order: the first PSBT's entries in their order,
 * then every key a later PSBT adds, in that PSBT's order. Every key is merged,
 * including proprietary (`0xfc`) records. Core's combine drops proprietary
 * records that only a later PSBT carries (its `Merge` functions never copy
 * `m_proprietary`, `src/psbt.cpp:30-53, 244-275, 333-343`), apart from the
 * `qbit` P2MR input fields it decodes; qbit-js keeps them.
 *
 * Combining takes time linear in the total number of map entries.
 */
export function combinePsbts(psbts: readonly Psbt[]): Psbt {
  if (psbts.length === 0) {
    throw new QbitProtocolError('INVALID_PSBT', 'combinePsbts requires at least one PSBT')
  }
  for (const psbt of psbts) validatePsbtKeys(psbt)
  const base = psbts[0]!
  const baseTx = bytesToHex(requireUnsignedTxBytes(base))
  const combined: Psbt = {
    global: base.global.map(cloneEntry),
    inputs: base.inputs.map(map => map.map(cloneEntry)),
    outputs: base.outputs.map(map => map.map(cloneEntry)),
  }
  // One key index per combined map, kept across merges, so combining stays
  // linear in the total entry count however many PSBTs are passed.
  const globalIndex = indexPsbtMap(combined.global)
  const inputIndexes = combined.inputs.map(map => indexPsbtMap(map))
  const outputIndexes = combined.outputs.map(map => indexPsbtMap(map))
  for (let i = 1; i < psbts.length; i += 1) {
    const other = psbts[i]!
    if (bytesToHex(requireUnsignedTxBytes(other)) !== baseTx) {
      throw new QbitProtocolError('INVALID_PSBT', 'cannot combine PSBTs with different unsigned transactions')
    }
    if (other.inputs.length !== combined.inputs.length || other.outputs.length !== combined.outputs.length) {
      throw new QbitProtocolError('INVALID_PSBT', 'cannot combine PSBTs with mismatched map counts')
    }
    mergeIndexedMap(combined.global, globalIndex, other.global)
    other.inputs.forEach((map, index) => mergeIndexedMap(combined.inputs[index]!, inputIndexes[index]!, map))
    other.outputs.forEach((map, index) => mergeIndexedMap(combined.outputs[index]!, outputIndexes[index]!, map))
  }
  return combined
}

/**
 * Decode a PSBT into a human-readable summary for approval/inspection UIs.
 * Throws `INVALID_AMOUNT` instead of returning a misleading summary when an
 * amount or total is outside `MoneyRange` or the outputs exceed the inputs.
 *
 * `psbt` need not come from `parsePsbt`, so right after reading the unsigned
 * transaction this checks the shape `parsePsbt` guarantees for wire bytes, as
 * qbit Core checks it when deserializing (psbt.h:1544-1578, the separator rule
 * at psbt.h:542-547 and the per-map "Duplicate Key" checks): exactly one input
 * map per transaction input and one output map per output, no empty key (on
 * the wire a zero-length key ends the map), and no raw key repeated within a
 * map. A violation throws `INVALID_PSBT`. As a result, the summary can never
 * show one witness UTXO while the signature hash commits to another.
 * `validateP2mrSigningPlans` and `signP2mrPsbt` run this check before computing
 * any signature hash or calling the signer, and `finalizeP2mrPsbt` before
 * assembling any witness.
 *
 * Only `qbit` proprietary input subtypes 1-3 (P2MR merkle root, leaf script,
 * script signature) are decoded, and a malformed one throws. Records with any
 * other `qbit` subtype stay in the map undecoded and are not reported here, as
 * Core keeps them (psbt.h:1029-1031).
 *
 * P2MR fields are reported as Core stores them. A leaf carried as both a `0x1d`
 * and a `qbit` `0x02` record with the same control block, script and leaf
 * version is one entry of `leafScripts` (psbt.h:298, :850, :996). A signature
 * carried as both `0x19` and `qbit` `0x03` for the same (pubkey, leaf hash) is
 * one entry of `scriptSigs`; if the two values differ, `decodePsbt` throws
 * `INVALID_PSBT`, as Core's `AddP2MRScriptSig` rejects the PSBT
 * (psbt.h:318-328).
 */
export function decodePsbt(psbt: Psbt): PsbtSummary {
  const tx = psbtUnsignedTransaction(psbt)
  assertPsbtMapShape(psbt, tx)
  const inputs: PsbtInputSummary[] = tx.inputs.map((input, index) => {
    const summary: PsbtInputSummary = {
      prevout: input.prevout,
      sequence: input.sequence,
      leafScripts: [],
      scriptSigs: [],
      finalized: false,
    }
    const scriptSigs = new Map<string, P2mrPsbtScriptSigField>()
    let proprietaryLeafScripts = 0
    for (const { key, value } of psbt.inputs[index] ?? []) {
      const keyType = readPsbtKeyType(key)
      if (key.length === 1 && keyType === PSBT_IN_WITNESS_UTXO) {
        summary.witnessUtxo = parseTxOut(value, `input ${index} witness UTXO value`)
      } else if (keyType === PSBT_IN_SIGHASH_TYPE) {
        summary.sighashType = decodePsbtSighashTypeField(key, value, index)
      } else if (keyType === PSBT_IN_P2MR_LEAF_SCRIPT) {
        summary.leafScripts.push(decodeP2mrPsbtLeafScriptField(key, value))
      } else if (keyType === PSBT_IN_P2MR_SCRIPT_SIG) {
        addP2mrScriptSig(scriptSigs, decodeP2mrPsbtScriptSigField(key, value), index)
      } else if (key.length === 1 && keyType === PSBT_IN_FINAL_SCRIPTWITNESS) {
        summary.finalized = true
      } else if (keyType === PSBT_IN_PROPRIETARY) {
        const proprietary = parseProprietaryKey(key)
        // Core decodes only the known qbit subtypes and keeps any other subtype
        // as an opaque proprietary record (psbt.h:1029-1031, `default:
        // store_proprietary`). It stays in the map untouched for round-tripping.
        if (
          bytesEqual(proprietary.identifier, asciiBytes(PSBT_QBIT_IDENTIFIER)) &&
          proprietary.subtype >= PSBT_QBIT_IN_P2MR_MERKLE_ROOT &&
          proprietary.subtype <= PSBT_QBIT_IN_P2MR_SCRIPT_SIG
        ) {
          const field = decodeQbitProprietaryP2mrInputField(proprietary.subtype, proprietary.keyData, value)
          if (field.type === 'qbitP2mrMerkleRoot') {
            summary.merkleRoot = field.merkleRoot
          } else if (field.type === 'p2mrLeafScript') {
            summary.leafScripts.push(field)
            proprietaryLeafScripts += 1
          } else {
            addP2mrScriptSig(scriptSigs, field, index)
          }
        }
      }
    }
    // Only a 0x1d record and a qbit 0x02 record can repeat a leaf: raw keys are
    // unique per map, and both key on the control block alone.
    if (proprietaryLeafScripts > 0 && proprietaryLeafScripts < summary.leafScripts.length) {
      summary.leafScripts = dedupeP2mrLeafScripts(summary.leafScripts)
    }
    summary.scriptSigs = [...scriptSigs.values()]
    return summary
  })

  const summary: PsbtSummary = { version: tx.version, locktime: tx.locktime, inputs, outputs: tx.outputs }
  // Every amount passed MoneyRange when parsed; the totals must too (Core's
  // CheckTransaction / CheckTxInputs), and a fee below zero means the outputs
  // overspend the inputs. Throw rather than show an approval UI a bogus fee.
  const sent = tx.outputs.reduce((sum, output) => sum + output.value, 0n)
  assertMoneyRange(sent, 'total output value')
  if (inputs.every(input => input.witnessUtxo !== undefined)) {
    const spent = inputs.reduce((sum, input) => sum + input.witnessUtxo!.value, 0n)
    assertMoneyRange(spent, 'total input value')
    if (sent > spent) {
      throw new QbitProtocolError('INVALID_AMOUNT', `total output value ${sent} exceeds total input value ${spent}`)
    }
    summary.fee = spent - sent
  }
  return summary
}

/**
 * Reject a `Psbt` object whose maps do not have the shape `parsePsbt` guarantees
 * for wire bytes: exactly one map per unsigned-transaction input and output
 * (Core psbt.h:1563-1578), no empty key (a zero-length key is the map
 * separator on the wire, psbt.h:542-547, so `serializePsbt` would end the map
 * there and the bytes would parse as a different PSBT, or not at all), and no
 * raw key repeated within any map (the
 * `readPsbtMap` rule; Core's per-map "Duplicate Key" checks, e.g. the input
 * map's `key_lookup` at psbt.h:533). `Psbt` is a plain object, so callers can build or merge one without
 * `parsePsbt`. Without this check, a map with two witness-UTXO (0x01) entries
 * would decode the last one for display and fee, while the sighash commits to
 * the first, so a signer would approve an amount it never saw.
 */
function assertPsbtMapShape(psbt: Psbt, tx: P2mrTransaction): void {
  if (psbt.inputs.length !== tx.inputs.length) {
    throw new QbitProtocolError('INVALID_PSBT', 'PSBT input map count does not match the unsigned transaction')
  }
  if (psbt.outputs.length !== tx.outputs.length) {
    throw new QbitProtocolError('INVALID_PSBT', 'PSBT output map count does not match the unsigned transaction')
  }
  for (const map of [psbt.global, ...psbt.inputs, ...psbt.outputs]) {
    const seen = new Set<string>()
    for (const { key } of map) {
      if (key.length === 0) {
        throw new QbitProtocolError('INVALID_PSBT', 'empty key in PSBT map')
      }
      const keyHex = bytesToHex(key)
      if (seen.has(keyHex)) {
        throw new QbitProtocolError('INVALID_PSBT', 'duplicate key in PSBT map')
      }
      seen.add(keyHex)
    }
  }
}

/**
 * Record one P2MR script signature in `sigs`, keyed by (pubkey, leaf hash) as
 * Core's `m_qbit_p2mr_script_sigs` is. A `0x19` record and a `qbit` `0x03`
 * record with the same key and value are one signature; with different values
 * the PSBT is invalid, as Core's `AddP2MRScriptSig` rules (psbt.h:318-328).
 */
function addP2mrScriptSig(
  sigs: Map<string, P2mrPsbtScriptSigField>,
  sig: P2mrPsbtScriptSigField,
  inputIndex: number
): void {
  const id = bytesToHex(sig.pubkey) + bytesToHex(sig.leafHash)
  const existing = sigs.get(id)
  if (existing === undefined) {
    sigs.set(id, sig)
    return
  }
  if (
    existing.signature.hashType !== sig.signature.hashType ||
    !bytesEqual(existing.signature.signature, sig.signature.signature)
  ) {
    throw new QbitProtocolError(
      'INVALID_PSBT',
      `input ${inputIndex}: conflicting P2MR script signatures for one pubkey and leaf hash`
    )
  }
}

/**
 * Drop repeated (control block, script, leaf version) leaf records, keeping the
 * first. Core stores each leaf once, as a (script, leaf version) entry with a
 * set of control blocks (psbt.h:298, filled at :850 and :996). Records are
 * sorted by control block rather than indexed by its hex, so a PSBT with
 * `maxObjects` leaf records needs no per-record string on the heap.
 */
function dedupeP2mrLeafScripts(leaves: readonly P2mrPsbtLeafScriptField[]): P2mrPsbtLeafScriptField[] {
  const order = leaves.map((_, index) => index)
  order.sort((a, b) => compareBytes(leaves[a]!.controlBlock, leaves[b]!.controlBlock) || a - b)
  const repeated = new Uint8Array(leaves.length)
  // Keys are unique and canonical, so a run of records with one control block
  // is at most a 0x1d record and a qbit 0x02 record. A record in a run repeats
  // an earlier one with the same script and leaf version.
  for (let runStart = 0; runStart < order.length;) {
    const controlBlock = leaves[order[runStart]!]!.controlBlock
    let runEnd = runStart + 1
    while (runEnd < order.length && bytesEqual(leaves[order[runEnd]!]!.controlBlock, controlBlock)) runEnd += 1
    for (let i = runStart + 1; i < runEnd; i += 1) {
      const leaf = leaves[order[i]!]!
      for (let j = runStart; j < i; j += 1) {
        const earlier = leaves[order[j]!]!
        if (earlier.leafVersion === leaf.leafVersion && bytesEqual(earlier.script, leaf.script)) {
          repeated[order[i]!] = 1
          break
        }
      }
    }
    runStart = runEnd
  }
  return leaves.filter((_, index) => repeated[index] === 0)
}

/** One input spec for `createP2mrPsbt`. */
export interface P2mrPsbtInput {
  prevout: P2mrOutpoint
  sequence?: number
  /** The output being spent: amount + P2MR scriptPubKey. */
  witnessUtxo: P2mrTransactionOutput
  leafScript: Uint8Array
  controlBlock: Uint8Array
  leafVersion?: number
  /** Optional merkle root, emitted as the qbit proprietary field. */
  merkleRoot?: Uint8Array
}

/**
 * Build an unsigned, update-complete P2MR PSBT: the unsigned transaction plus,
 * per input, the witness UTXO, leaf script, and (optionally) merkle root needed
 * to sign. Coin selection / fee estimation is the caller's responsibility.
 *
 * Every output must be one qbit Core's restricted-output mode allows (see
 * {@link isRestrictedOutputModeOutput}, with reserved witness outputs refused):
 * any other output throws `INVALID_SCRIPT`, because Core would reject the
 * transaction. Pass `restrictedOutputMode: false` only for a regtest node
 * started with `-p2mronly=0`. Every txid, script and control block, including
 * the witness UTXO `scriptPubKey`, must be a `Uint8Array` in either mode;
 * anything else throws `INVALID_BYTES`.
 */
export function createP2mrPsbt(params: {
  /** nVersion (uint32, as qbit Core's `CTransaction::version`). Default 2. */
  version?: number
  /** nLockTime (uint32). Default 0. */
  locktime?: number
  inputs: readonly P2mrPsbtInput[]
  outputs: readonly P2mrTransactionOutput[]
  /**
   * `false` skips the restricted-output check, matching qbit Core's regtest
   * `-p2mronly=0`. The mode is on for every other network and for regtest by
   * default, so leave this unset unless the node turned it off. Every output
   * script must still be a `Uint8Array` (`INVALID_BYTES` otherwise).
   */
  restrictedOutputMode?: boolean
}): Psbt {
  assertRestrictedOutputModeOutputs(params.outputs, params.restrictedOutputMode)
  // Default only on `undefined`: a JS caller's `null` is rejected downstream
  // rather than silently becoming the default.
  const tx: P2mrTransaction = {
    version: params.version === undefined ? 2 : params.version,
    locktime: params.locktime === undefined ? 0 : params.locktime,
    inputs: params.inputs.map(input => ({
      prevout: input.prevout,
      sequence: input.sequence === undefined ? 0xfffffffd : input.sequence,
    })),
    outputs: params.outputs.map(output => ({ value: output.value, scriptPubKey: output.scriptPubKey })),
  }
  const global: PsbtKeyValue[] = [
    { key: Uint8Array.of(PSBT_GLOBAL_UNSIGNED_TX), value: serializeUnsignedTransaction(tx) },
  ]
  const inputs: PsbtKeyValue[][] = params.inputs.map((spec, index) => {
    const entries: PsbtKeyValue[] = [
      {
        key: Uint8Array.of(PSBT_IN_WITNESS_UTXO),
        value: serializeTxOut(spec.witnessUtxo, `input ${index} witness UTXO`),
      },
    ]
    const leaf = encodeP2mrPsbtLeafScriptField(spec.controlBlock, spec.leafScript, spec.leafVersion)
    entries.push({ key: leaf.key, value: leaf.value })
    if (spec.merkleRoot !== undefined) {
      const field = encodeQbitProprietaryP2mrMerkleRootField(spec.merkleRoot)
      entries.push({ key: proprietaryKeyBytes(field), value: field.value })
    }
    return entries
  })
  const outputs: PsbtKeyValue[][] = params.outputs.map(() => [])
  return { global, inputs, outputs }
}

/**
 * What a `P2mrPsbtSignFn` is asked to commit to. A signing device can render
 * `tx` / `spentOutputs` and must show or refuse any `hashType` other than
 * `SIGHASH_DEFAULT`: `NONE`, `SINGLE` and the `ANYONECANPAY` variants leave
 * outputs and/or other inputs uncommitted, so the same digest (and therefore
 * the same signature) is valid in transactions the user never saw.
 */
export interface P2mrPsbtSignContext {
  inputIndex: number
  pubkey: Uint8Array
  leafHash: Uint8Array
  /** Sighash type the digest was computed with (and the type byte appended to the witness signature when not `SIGHASH_DEFAULT`). */
  hashType: number
  /** The unsigned transaction being signed. */
  tx: P2mrTransaction
  /** The outputs being spent, one per transaction input in input order. */
  spentOutputs: readonly P2mrSpentOutput[]
}

/**
 * Signer callback: returns a 3680-byte SLH-DSA signature, or `undefined` (not
 * `null`) to skip the plan.
 *
 * Must be synchronous: `signP2mrPsbt` stores each signature before the next
 * plan is attempted, so it cannot wait for a promise. A returned promise or
 * other thenable fails that plan with a `P2mrPsbtSigningError` in phase
 * `'sign'` (its eventual settlement is ignored, and the key use still counts
 * as consumed). Any `Uint8Array`, including one created in another realm
 * (vm context, iframe, worker) or a Node `Buffer`, is accepted and copied; other
 * views such as `DataView` or `Int8Array` are rejected.
 */
export type P2mrPsbtSignFn = (sighash: Uint8Array, context: P2mrPsbtSignContext) => Uint8Array | undefined

export interface P2mrSigningKey {
  inputIndex: number
  /** 32-byte `Uint8Array`; any other value throws `INVALID_BYTES` before any signer call. */
  pubkey: Uint8Array
  /** 32-byte `Uint8Array`; any other value throws `INVALID_BYTES` before any signer call. */
  leafHash: Uint8Array
  /**
   * Sighash type; defaults to `SIGHASH_DEFAULT`. Any other type requires
   * `allowNonDefaultSighash: true`, must equal the input's
   * `PSBT_IN_SIGHASH_TYPE` field when that field is present, and must equal the
   * type of every P2MR signature already on the input (qbit Core's
   * `SIGHASH_MISMATCH` rules).
   */
  hashType?: number
}

/** Identifies one signing plan: the (input, pubkey, leaf hash) triple a signature is keyed by. */
export interface P2mrSigningPlanRef {
  inputIndex: number
  pubkey: Uint8Array
  leafHash: Uint8Array
}

/**
 * Called by `signP2mrPsbt` right after each signature has been validated and
 * stored, before the next plan's `sign` call. `field` is the stored 0x19
 * script-sig record (`key` = type||pubkey||leafHash, `value` = signature with
 * any explicit sighash type appended). Stateful keyrings persist and advance
 * counters here, so a later failure can never lose the record of a signature
 * that was already produced. For a non-default sighash type the input's
 * `PSBT_IN_SIGHASH_TYPE` (0x03) record is stored in the same step; it is not
 * part of `field`.
 *
 * Must be synchronous: signing cannot wait for a promise, so persistence has
 * to complete before the callback returns. A returned promise or other
 * thenable is treated as a failure of that plan and signing stops with a
 * `P2mrPsbtSigningError` in phase `'onSigned'` before the next plan's `sign`
 * call. Its eventual settlement is ignored, so the signature is stored but
 * whether the persistence it started completed is unknown to the caller.
 */
export type P2mrPsbtOnSignedFn = (event: P2mrSigningPlanRef & { field: { key: Uint8Array; value: Uint8Array } }) => void

export interface P2mrSigningOptions {
  /**
   * Permit sighash types other than `SIGHASH_DEFAULT`. Off by default because
   * `NONE`, `SINGLE` and the `ANYONECANPAY` variants do not commit to every
   * input and output, so a signature made with them can be lifted into a
   * transaction the user never approved. Only set this after the application's
   * approval flow has shown the requested type to the user.
   */
  allowNonDefaultSighash?: boolean
  /**
   * `false` skips the restricted-output check, matching qbit Core's regtest
   * `-p2mronly=0`. By default every output of the unsigned transaction must be
   * one Core's restricted-output mode allows (see
   * {@link isRestrictedOutputModeOutput}, with reserved witness outputs
   * refused), or signing throws `INVALID_SCRIPT` before any signer call.
   */
  restrictedOutputMode?: boolean
}

export interface SignP2mrPsbtResult {
  psbt: Psbt
  /** Plans that produced a signature, so the caller's key management can advance its counters. */
  signed: P2mrSigningPlanRef[]
}

/** Which step of a signing plan raised a `P2mrPsbtSigningError`. */
export type P2mrPsbtSigningPhase = 'sign' | 'onSigned'

/**
 * Thrown by `signP2mrPsbt` when a plan's `sign` call throws, returns a
 * thenable, or returns an invalid signature, or when `onSigned` throws or
 * returns a thenable. Nothing produced before the failure is lost: `psbt`
 * holds every signature made so far and `signed` lists them. `failed` is the
 * plan being processed when `cause` was raised, and `phase` says how far it
 * got:
 *
 * - `'sign'`: the signer was invoked for `failed` but no signature was stored,
 *   so `failed` is not in `signed`. A stateful signer must still treat that
 *   key use as consumed.
 * - `'onSigned'`: the signature for `failed` was validated and stored, so
 *   `failed` is the last entry of `signed` and its field is in `psbt`; only
 *   the callback failed.
 *
 * Retry contract: call `signP2mrPsbt` again with `psbt` and only the keys that
 * are not listed in `signed`. A key whose signature is already present is
 * refused before any signer call, so a plan is never signed twice.
 */
export class P2mrPsbtSigningError extends QbitProtocolError {
  readonly psbt: Psbt
  readonly signed: P2mrSigningPlanRef[]
  readonly failed: P2mrSigningPlanRef
  readonly phase: P2mrPsbtSigningPhase
  readonly cause: unknown

  /**
   * Whether `value` is a `P2mrPsbtSigningError` from any copy of
   * `@qbit-oss/protocol`, by its brand
   * `Symbol.for('qbit-js.P2mrPsbtSigningError')`; see `QbitProtocolError.is`.
   */
  static override is(value: unknown): value is P2mrPsbtSigningError {
    return hasBrand(value, P2MR_PSBT_SIGNING_ERROR_BRAND)
  }

  constructor(params: {
    psbt: Psbt
    signed: P2mrSigningPlanRef[]
    failed: P2mrSigningPlanRef
    phase: P2mrPsbtSigningPhase
    cause: unknown
  }) {
    super(
      'SIGNING_FAILED',
      `input ${params.failed.inputIndex}: P2MR signing failed in ${params.phase} after ` +
        `${params.signed.length} signature(s): ${describeThrown(params.cause)}`
    )
    this.name = 'P2mrPsbtSigningError'
    this.psbt = params.psbt
    this.signed = params.signed
    this.failed = params.failed
    this.phase = params.phase
    this.cause = params.cause
  }
}

Object.defineProperty(P2mrPsbtSigningError.prototype, P2MR_PSBT_SIGNING_ERROR_BRAND, { value: true })

interface PreparedP2mrSigningPlan {
  inputIndex: number
  pubkey: Uint8Array
  leafHash: Uint8Array
  hashType: number
  sighash: Uint8Array
}

/**
 * Validate every signing plan without invoking a signer or mutating the PSBT.
 * Stateful signers can call this before reserving counters or keys. It also
 * checks every output against qbit Core's restricted-output mode unless
 * `restrictedOutputMode: false` is passed (see {@link P2mrSigningOptions}).
 *
 * Each plan's leaf must be a committed v1 `pk` or `multi_a` leaf containing
 * the key, with no signature yet for that (pubkey, leaf hash); its input must
 * have no final scriptwitness (`0x08`) or non-empty final scriptSig (`0x07`);
 * and the sighash types must agree. The plans are then checked together
 * against the signatures already on each input: `finalizeP2mrPsbt`'s own leaf
 * selection runs over those signatures plus this call's, and when it completes
 * a witness, that witness must place every plan's signature. A witness
 * reveals one leaf, so the call is refused when it plans signatures on two or
 * more leaves of one input, whether or not any completes. A plan is also
 * refused when another leaf finalize prefers is already complete, or when its
 * `multi_a` leaf reaches its threshold, with existing signatures or the call's
 * other plans, on keys finalize places first: it places from the last key, so
 * for a 1-of-2 `[K1, K2]` leaf with K2 signed a K1 plan is refused, but with
 * K1 signed a K2 plan is accepted and finalize uses K2. qbit Core signs only
 * the leaf it finalizes and stops at its threshold, and with no leaf complete
 * signs only its best partial leaf (`src/script/sign.cpp:592-613`, `:729-756`
 * @ v1.0.0). Plans on one leaf that do not complete it pass, so co-signers can
 * sign a `multi_a` leaf in turn.
 *
 * Once every accepted plan is signed, finalize either uses each of the call's
 * signatures or, with no leaf complete yet, waits for more. Signatures added
 * later, or a plan the signer skips, can make it choose another leaf. Neither
 * this check nor finalize verifies signatures, so an invalid signature already
 * on the PSBT counts as a valid one: on a leaf finalize prefers, it gets the
 * plan refused before a key use is spent, but on the leaf finalize uses,
 * including the plan's own `multi_a` leaf, it makes finalize produce a
 * transaction that does not verify. A failure throws `INVALID_PSBT`,
 * `INVALID_SCRIPT` for an output restricted-output mode rejects, or
 * `INVALID_SIGHASH` for a sighash rule.
 */
export function validateP2mrSigningPlans(
  params: {
    psbt: Psbt
    keys: readonly P2mrSigningKey[]
  } & P2mrSigningOptions
): void {
  prepareP2mrSigningPlans(params.psbt, params.keys, params)
}

/**
 * Sign P2MR inputs. For each key, computes the P2MRSighash from the
 * PSBT's witness UTXOs and calls `sign`; a returned signature is inserted as a
 * 0x19 script-sig field keyed by (pubkey, leafHash). The actual SLH-DSA signing
 * lives outside this package (in the caller's PQC signer), passed in via `sign`.
 *
 * `sign` and `onSigned` are checked to be functions, every output is checked
 * against qbit Core's restricted-output mode (see {@link P2mrSigningOptions}),
 * and the plans are validated as `validateP2mrSigningPlans` validates them
 * before the first signer call, so no key is used for a plan whose signature
 * `finalizeP2mrPsbt` would leave out of the witness it builds from the PSBT's
 * signatures and this call's (`validateP2mrSigningPlans` says what this does
 * not cover); those failures throw a plain `QbitProtocolError` with nothing
 * signed. Both callbacks must be synchronous. Each signature is then checked
 * to be a `Uint8Array` (from any realm) of the expected length and stored as
 * soon as `sign` returns, and reported through `onSigned` before the next plan
 * is attempted. If any plan fails, the `P2mrPsbtSigningError` carries the
 * partially signed PSBT and the plans signed so far; see that class for the
 * retry contract.
 */
export function signP2mrPsbt(
  params: {
    psbt: Psbt
    keys: readonly P2mrSigningKey[]
    sign: P2mrPsbtSignFn
    onSigned?: P2mrPsbtOnSignedFn
  } & P2mrSigningOptions
): SignP2mrPsbtResult {
  const { psbt, keys, sign, onSigned } = params
  if (typeof sign !== 'function') {
    throw new QbitProtocolError('INVALID_SIGNER', 'signP2mrPsbt sign must be a function')
  }
  if (onSigned !== undefined && typeof onSigned !== 'function') {
    throw new QbitProtocolError('INVALID_SIGNER', 'signP2mrPsbt onSigned must be a function when provided')
  }
  const { tx, spentOutputs, plans } = prepareP2mrSigningPlans(psbt, keys, params)
  const result: Psbt = {
    global: psbt.global.map(cloneEntry),
    inputs: psbt.inputs.map(map => map.map(cloneEntry)),
    outputs: psbt.outputs.map(map => map.map(cloneEntry)),
  }
  const signed: P2mrSigningPlanRef[] = []
  for (const plan of plans) {
    let field: PsbtKeyValue | undefined
    try {
      const signature: unknown = sign(plan.sighash, {
        ...signingPlanRef(plan),
        hashType: plan.hashType,
        // Fresh copies per call: one callback cannot alter what later ones see.
        tx: cloneP2mrTransaction(tx),
        spentOutputs: spentOutputs.map(cloneTxOut),
      })
      if (isThenable(signature)) {
        // The signer may still be talking to the device, so the key use counts
        // as consumed even though nothing can be stored.
        throw thenableFromSynchronousCallback('sign', signature, 'so no signature can be stored for this plan')
      }
      if (signature !== undefined) {
        if (!isUint8Array(signature)) {
          throw new QbitProtocolError('INVALID_SIGNER', 'sign must return a Uint8Array signature or undefined')
        }
        // The encoder copies the bytes, so the stored field never aliases the
        // signer's buffer, whichever realm it came from. Storing inside the
        // guarded region keeps every earlier signature in the error if it fails.
        field = encodeP2mrPsbtScriptSigField(plan.pubkey, plan.leafHash, signature, plan.hashType)
        const entries: PsbtKeyValue[] = [field]
        if (plan.hashType !== SIGHASH_DEFAULT) {
          // Mirror Core: record a non-default type in PSBT_IN_SIGHASH_TYPE so later
          // signers (this library or Core) must use the same type for this input.
          entries.push(encodePsbtSighashTypeField(plan.hashType))
        }
        mergeMap(result.inputs[plan.inputIndex]!, entries)
      }
    } catch (cause) {
      throw new P2mrPsbtSigningError({
        psbt: result,
        signed,
        failed: signingPlanRef(plan),
        phase: 'sign',
        cause,
      })
    }
    if (field === undefined) continue
    signed.push(signingPlanRef(plan))
    if (onSigned === undefined) continue
    try {
      const returned: unknown = onSigned({ ...signingPlanRef(plan), field })
      if (isThenable(returned)) {
        // Persistence is still pending, so the next signer call would race it.
        throw thenableFromSynchronousCallback('onSigned', returned, 'so signing cannot continue safely')
      }
    } catch (cause) {
      throw new P2mrPsbtSigningError({
        psbt: result,
        signed,
        failed: signingPlanRef(plan),
        phase: 'onSigned',
        cause,
      })
    }
  }
  return { psbt: result, signed }
}

function signingPlanRef(plan: PreparedP2mrSigningPlan): P2mrSigningPlanRef {
  return { inputIndex: plan.inputIndex, pubkey: copyBytes(plan.pubkey), leafHash: copyBytes(plan.leafHash) }
}

/**
 * A callback that must be synchronous returned a thenable. Whatever it settles
 * to is never used, so silence it (a rejection must not surface as unhandled)
 * and report the misuse through the typed error instead.
 */
function thenableFromSynchronousCallback(
  callback: 'sign' | 'onSigned',
  returned: PromiseLike<unknown>,
  consequence: string
): QbitProtocolError {
  void Promise.resolve(returned).catch(() => {})
  return new QbitProtocolError(
    'INVALID_SIGNER',
    `${callback} must be synchronous: it returned a promise, ${consequence}`
  )
}

function isThenable(value: unknown): value is PromiseLike<unknown> {
  return (
    (typeof value === 'object' || typeof value === 'function') &&
    value !== null &&
    typeof (value as { then?: unknown }).then === 'function'
  )
}

function describeThrown(cause: unknown): string {
  if (cause instanceof Error) return cause.message
  try {
    return String(cause)
  } catch {
    return 'non-Error value thrown'
  }
}

/**
 * Finalize P2MR inputs: build the witness qbit Core's `FinalizePSBT` builds
 * (`src/psbt.cpp:697` and `src/script/sign.cpp:699-741` @ v1.0.0, `7ebcddb6`),
 * store it as the final scriptwitness (0x08), and drop the now-redundant
 * partial fields and an empty final scriptSig (0x07). A non-empty 0x07 throws
 * `INVALID_PSBT`: a P2MR spend's scriptSig must be empty. Already-finalized
 * inputs are left untouched once their final witness passes the limits
 * `extractP2mrTransaction` enforces.
 *
 * Leaves and signatures are read as `decodePsbt` reports them: one leaf per
 * (control block, script, leaf version) and one signature per (pubkey, leaf
 * hash), whether carried as `0x1d`/`0x19` or `qbit` `0x02`/`0x03`. Of the
 * leaves whose control block commits to the witness UTXO's program, each v1
 * `pk(K)` or `multi_a` leaf with signatures for `threshold` of its keys can be
 * finalized; the one with the smallest witness is used, ties going to the
 * bytewise-smallest script. Its witness is `[signature, leaf_script,
 * control_block]` for `pk`, and for `multi_a` one item per key, last key
 * first, each a signature until `threshold` are placed and empty otherwise,
 * then the script and control block. The shortest committing control block of
 * the leaf is used. Other leaves and signatures are ignored and dropped. If no
 * leaf qualifies, the input throws `INVALID_PSBT`. Signatures are not
 * verified.
 *
 * The signature's sighash type is enforced exactly as qbit Core's `FinalizePSBT`
 * enforces it: `FinalizePSBT` (`:697`) re-runs `SignPSBTInput` with the input's
 * `sighash_type`, which treats an absent `PSBT_IN_SIGHASH_TYPE` as
 * `SIGHASH_DEFAULT` for P2MR (`:530`) and returns `SIGHASH_MISMATCH` when any
 * P2MR signature on the input, used or not, carries any other type
 * (`:548-568` for the absent/DEFAULT case, `:589-596` when the field is
 * present and differs). Such an input throws `INVALID_SIGHASH` here instead of
 * being assembled into a witness. A non-default signature made by a signer
 * that omitted the field needs a matching `PSBT_IN_SIGHASH_TYPE` record (which
 * Core's own signer always writes, `:542-545`) before Core or this function
 * will finalize it.
 */
export function finalizeP2mrPsbt(psbt: Psbt): Psbt {
  const summary = decodePsbt(psbt)
  const result: Psbt = {
    global: psbt.global.map(cloneEntry),
    inputs: psbt.inputs.map(map => map.map(cloneEntry)),
    outputs: psbt.outputs.map(map => map.map(cloneEntry)),
  }
  result.inputs.forEach((map, index) => {
    const existing = map.find(entry => entry.key.length === 1 && entry.key[0] === PSBT_IN_FINAL_SCRIPTWITNESS)
    if (existing !== undefined) {
      parseWitnessStack(existing.value)
      return
    }
    assertNoP2mrFinalScriptSig(map, index)
    const finalWitness = p2mrFinalWitness(summary.inputs[index]!, index)
    // Core omits an empty final scriptSig (psbt.h:503-507), so it is dropped too.
    const kept = map.filter(entry => !isCoreNonFinalInputField(entry) && !isFinalScriptSig(entry))
    kept.push({ key: Uint8Array.of(PSBT_IN_FINAL_SCRIPTWITNESS), value: finalWitness })
    result.inputs[index] = kept
  })
  return result
}

/**
 * Extract the network-ready transaction (with witnesses) from a finalized PSBT.
 * Each final scriptwitness must fit qbit Core's P2MR witness stack limits, the
 * transaction must fit `options.maxBytes`, which is checked before any witness
 * is decoded, and at most `options.maxObjects` transaction inputs, outputs and
 * witness items are decoded (see `PsbtLimitOptions`).
 */
export function extractP2mrTransaction(psbt: Psbt, options: PsbtLimitOptions = {}): Uint8Array {
  const maxBytes = resolvePsbtLimit(options.maxBytes, PSBT_DEFAULT_MAX_BYTES, 'maxBytes')
  const budget = new PsbtObjectBudget(resolvePsbtLimit(options.maxObjects, PSBT_DEFAULT_MAX_OBJECTS, 'maxObjects'))
  const txBytes = requireUnsignedTxBytes(psbt)
  const tx = parseUnsignedTransaction(txBytes, budget)
  const finalWitnesses = psbt.inputs.map((map, index) => {
    const entry = map.find(item => item.key.length === 1 && item.key[0] === PSBT_IN_FINAL_SCRIPTWITNESS)
    if (entry === undefined) {
      throw new QbitProtocolError('INVALID_PSBT', `input ${index} is not finalized`)
    }
    return entry.value
  })
  // An upper bound: re-encoding never lengthens the unsigned transaction or a witness.
  const size = finalWitnesses.reduce((sum, witness) => sum + witness.length, txBytes.length + 2)
  if (size > maxBytes) {
    throw new QbitProtocolError('INVALID_PSBT', `extracted transaction would be larger than maxBytes (${maxBytes})`)
  }
  const witnesses = finalWitnesses.map(witness => parseWitnessStack(witness, budget))
  return serializeWitnessTransaction(tx, witnesses)
}

export function p2mrAddressFromPubkey(pk32: Uint8Array, network: QbitNetworkName | QbitNetworkParams): string {
  const script = singleKeyLeafScript(pk32)
  const root = p2mrLeafHash(P2MR_LEAF_VERSION_V1, script)
  return p2mrAddressFromRoot(root, network)
}

/**
 * Parse a BIP21 `qbit:` payment URI.
 *
 * Follows qbit Core's GUI parser (`src/qt/guiutil.cpp` `parseBitcoinURI`, v1.0.0
 * `:156-221`) except where noted, and fails closed where Core is lenient:
 *
 * - The `qbit:` scheme matches case-insensitively, so the QR alphanumeric form
 *   `QBIT:QB1…` is accepted. `bitcoin:` and `qbit://` are rejected in any case with
 *   `WRONG_URI_SCHEME`.
 * - One trailing `/` after the address is dropped. Otherwise `address` is returned
 *   as written, so an uppercase address stays uppercase.
 * - A `#` anywhere throws `INVALID_URI`. Core's `QUrl` treats it as the start of a
 *   fragment and never reads the parameters after it, so `?label=x#&amount=1000`
 *   has no amount in Core.
 * - The query is split on `&` (empty segments are skipped) and each segment on its
 *   first `=`. Keys and values are percent-decoded per RFC 3986: `+` is a literal
 *   plus, not a space. A malformed escape (`%ZZ`, a truncated or invalid UTF-8
 *   sequence) throws `INVALID_URI`.
 * - `req-amount`, `req-label` and `req-message` are read as `amount`, `label` and
 *   `message`. Any other `req-` parameter throws `INVALID_URI`, as BIP21 requires.
 * - `amount`, `label` or `message` given more than once, counting its `req-` form,
 *   throws `INVALID_URI`. Core keeps the last value and `URLSearchParams.get` the
 *   first; rejecting means qbit-js never has to pick one of two amounts.
 * - `amount` must be a QBT decimal with at most 8 fractional digits and at most
 *   `QBIT_MAX_MONEY` (210,000,000 QBT), the cap Core's amount field enforces
 *   (`bitcoinamountfield.cpp:171`), so `210000000.00000001` throws `INVALID_URI`.
 *   An empty `amount=` throws `INVALID_URI`, although Core reads it as no amount.
 * - Parameter names are case-sensitive, as in Core and BIP21. BIP321 makes them
 *   case-insensitive, so a name that case-folds to `amount`, `label`, `message` or
 *   `req-…` but is not written in lowercase ASCII (`AMOUNT=5`, `Label`,
 *   `REQ-expires`, `meſſage`) throws `INVALID_URI`. Core ignores it, but a BIP321
 *   reader would use it. Other parameters without `req-` are ignored.
 *
 * `params` holds every decoded key/value pair in URI order, with keys as written
 * (`req-amount` stays `req-amount`). Read the payment fields from `amount`, `label`
 * and `message`.
 *
 * Behaviour change in 0.1.0: `+` used to decode as a space, `%ZZ` was
 * kept as literal text, a `req-` parameter was ignored, a duplicate used its
 * first value, text after `#` was read as part of the last parameter, a case
 * variant such as `AMOUNT` or `REQ-expires` was ignored, an amount above
 * `QBIT_MAX_MONEY` was accepted, and `QBIT:` or a trailing `/` was rejected.
 */
export function parseQbitUri(uri: string, expectedNetwork?: QbitNetworkName): ParsedQbitUri {
  // Schemes compare case-insensitively (guiutil.cpp:160,216).
  if (/^bitcoin:/i.test(uri)) {
    throw new QbitProtocolError('WRONG_URI_SCHEME', 'bitcoin: URIs are not valid qbit URIs')
  }
  if (/^qbit:\/\//i.test(uri)) {
    throw new QbitProtocolError('WRONG_URI_SCHEME', 'qbit URI scheme is qbit:, not qbit://')
  }
  if (!/^qbit:/i.test(uri)) {
    throw new QbitProtocolError('WRONG_URI_SCHEME', 'qbit URI must start with qbit:')
  }
  // Core's QUrl ends the query at the first '#', so Core never reads parameters
  // after it (guiutil.cpp:172-173); BIP21 and BIP321 define no fragment. Reject
  // it rather than read an amount that Core does not see.
  if (uri.includes('#')) {
    throw new QbitProtocolError('INVALID_URI', 'qbit URI must not contain a # fragment')
  }

  const body = uri.slice('qbit:'.length)
  const separator = body.indexOf('?')
  let address = separator === -1 ? body : body.slice(0, separator)
  const query = separator === -1 ? '' : body.slice(separator + 1)
  // Trim one trailing slash the OS may have added (guiutil.cpp:166-169).
  if (address.endsWith('/')) address = address.slice(0, -1)
  if (address.length === 0) {
    throw new QbitProtocolError('INVALID_URI', 'qbit URI is missing an address')
  }

  const decoded = decodeP2mrAddress(address, expectedNetwork)
  const params = new URLSearchParams()
  const fields: Pick<ParsedQbitUri, QbitUriFieldName> = {}
  for (const segment of query.split('&')) {
    if (segment.length === 0) continue
    const equals = segment.indexOf('=')
    const key = decodeQbitUriComponent(equals === -1 ? segment : segment.slice(0, equals))
    const value = decodeQbitUriComponent(equals === -1 ? '' : segment.slice(equals + 1))
    params.append(key, value)
    const field = qbitUriFieldName(key)
    if (field === undefined) continue
    if (fields[field] !== undefined) {
      throw new QbitProtocolError('INVALID_URI', `qbit URI repeats the ${field} parameter`)
    }
    fields[field] = value
  }
  if (fields.amount !== undefined && !isValidQbtAmount(fields.amount)) {
    throw new QbitProtocolError('INVALID_URI', 'invalid qbit URI amount')
  }

  return { address, network: decoded.network, params, ...fields }
}

/**
 * Format a BIP21 `qbit:` payment URI with parameters in the order amount, label,
 * message.
 *
 * `label` and `message` are percent-encoded like Core's `QUrl::toPercentEncoding`
 * (`src/qt/guiutil.cpp:238,245`): every character except the RFC 3986 unreserved set
 * `A-Z a-z 0-9 - . _ ~` is escaped, so a space becomes `%20`. Text that is not
 * well-formed Unicode (a lone surrogate) throws `INVALID_URI`. Unlike Core, the
 * address is emitted as given, and an empty label or message is still emitted.
 * `amount` must be a QBT decimal with at most 8 fractional digits and at most
 * `QBIT_MAX_MONEY` (210,000,000 QBT), or it throws `INVALID_URI`.
 *
 * Behaviour change in 0.1.0: a space used to be emitted as `+`, which Core
 * shows as a literal plus, a lone surrogate was replaced with U+FFFD, and an
 * amount above `QBIT_MAX_MONEY` was emitted.
 */
export function formatQbitUri(fields: QbitUriFields): string {
  decodeP2mrAddress(fields.address)
  const query: string[] = []
  if (fields.amount !== undefined) {
    if (!isValidQbtAmount(fields.amount)) {
      throw new QbitProtocolError('INVALID_URI', 'invalid qbit URI amount')
    }
    query.push(`amount=${fields.amount}`)
  }
  if (fields.label !== undefined) query.push(`label=${encodeQbitUriComponent(fields.label)}`)
  if (fields.message !== undefined) query.push(`message=${encodeQbitUriComponent(fields.message)}`)
  return `qbit:${fields.address}${query.length > 0 ? `?${query.join('&')}` : ''}`
}

type QbitUriFieldName = 'amount' | 'label' | 'message'

function qbitUriFieldName(key: string): QbitUriFieldName | undefined {
  // Core and BIP21 match names case-sensitively, so Core ignores AMOUNT=5, but
  // BIP321 readers match case-insensitively and would pay it. Reject the variant.
  // Fold through uppercase as well: ſ and ß are already lowercase, but meſſage
  // and meßage uppercase to MESSAGE. Capital ẞ (U+1E9E) folds only to ß that way,
  // so map ß to ss as Unicode casefolding does.
  const lower = key.toUpperCase().toLowerCase().replace(/ß/g, 'ss')
  if (key !== lower && (lower === 'amount' || lower === 'label' || lower === 'message' || lower.startsWith('req-'))) {
    throw new QbitProtocolError('INVALID_URI', 'qbit URI amount, label, message and req- names must be lowercase ASCII')
  }
  // Core strips req- and accepts it only on amount, label and message
  // (guiutil.cpp:176-206); BIP21 requires rejecting any other req- parameter.
  const required = key.startsWith('req-')
  const name = required ? key.slice('req-'.length) : key
  if (name === 'amount' || name === 'label' || name === 'message') return name
  if (required) {
    throw new QbitProtocolError('INVALID_URI', 'qbit URI has an unsupported req- parameter')
  }
  return undefined
}

function decodeQbitUriComponent(component: string): string {
  try {
    return decodeURIComponent(component)
  } catch {
    throw new QbitProtocolError('INVALID_URI', 'qbit URI has a malformed percent-escape')
  }
}

function encodeQbitUriComponent(text: string): string {
  let encoded: string
  try {
    encoded = encodeURIComponent(text)
  } catch {
    throw new QbitProtocolError('INVALID_URI', 'qbit URI text must be well-formed Unicode')
  }
  // encodeURIComponent leaves !'()* bare; QUrl::toPercentEncoding escapes them.
  return encoded.replace(/[!'()*]/g, char => `%${char.charCodeAt(0).toString(16).toUpperCase()}`)
}

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

function isBytesOfLength(value: unknown, length: number): value is Uint8Array {
  return isUint8Array(value) && value.length === length
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(item => typeof item === 'string')
}

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
    // `instanceof` suffices: only this module's own decodeBase58Check throws it.
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

function bech32Encode(encoding: 'bech32m', hrp: string, data: readonly number[]): string {
  if (!/^[!-~]+$/.test(hrp) || hrp !== hrp.toLowerCase()) {
    throw new QbitProtocolError('WRONG_HRP', 'bech32 HRP must be printable lowercase ASCII')
  }
  const combined = [...data, ...bech32CreateChecksum(encoding, hrp, data)]
  return `${hrp}1${combined
    .map(value => {
      const char = BECH32_CHARSET[value]
      if (char === undefined) {
        throw new QbitProtocolError('INVALID_BECH32', 'invalid bech32 data value')
      }
      return char
    })
    .join('')}`
}

function bech32Decode(address: string): {
  encoding: 'bech32' | 'bech32m'
  hrp: string
  data: number[]
} {
  // Mirror qbit Core bech32::Decode: bound the length and reject every code unit
  // outside printable ASCII (0x21..0x7e) before case detection and lowercasing.
  // Unicode case folding would otherwise map look-alikes such as U+212A KELVIN
  // SIGN onto charset letters and let two spellings decode to one program.
  if (address.length > BECH32_MAX_LENGTH) {
    throw new QbitProtocolError('INVALID_BECH32', `bech32 strings cannot exceed ${BECH32_MAX_LENGTH} characters`)
  }
  let hasLower = false
  let hasUpper = false
  for (let i = 0; i < address.length; i += 1) {
    const code = address.charCodeAt(i)
    if (code >= 0x61 && code <= 0x7a) {
      hasLower = true
    } else if (code >= 0x41 && code <= 0x5a) {
      hasUpper = true
    } else if (code < 0x21 || code > 0x7e) {
      throw new QbitProtocolError('INVALID_BECH32', 'bech32 strings must be printable ASCII')
    }
  }
  if (hasLower && hasUpper) {
    throw new QbitProtocolError('INVALID_BECH32', 'bech32 strings cannot mix case')
  }

  const normalized = address.toLowerCase()
  const separator = normalized.lastIndexOf('1')
  if (separator < 1 || separator + 7 > normalized.length) {
    throw new QbitProtocolError('INVALID_BECH32', 'invalid bech32 separator or checksum')
  }

  const hrp = normalized.slice(0, separator)
  const dataPart = normalized.slice(separator + 1)
  const values: number[] = []
  for (const char of dataPart) {
    const value = bech32CharValues.get(char)
    if (value === undefined) {
      throw new QbitProtocolError('INVALID_BECH32', 'invalid bech32 character')
    }
    values.push(value)
  }

  const polymod = bech32Polymod([...bech32HrpExpand(hrp), ...values])
  const encoding = polymod === BECH32_CONST ? 'bech32' : polymod === BECH32M_CONST ? 'bech32m' : undefined
  if (encoding === undefined) {
    throw new QbitProtocolError('INVALID_BECH32', 'invalid bech32 checksum')
  }
  return {
    encoding,
    hrp,
    data: values.slice(0, -6),
  }
}

function bech32CreateChecksum(encoding: 'bech32m', hrp: string, data: readonly number[]): number[] {
  const constValue = encoding === 'bech32m' ? BECH32M_CONST : BECH32_CONST
  const values = [...bech32HrpExpand(hrp), ...data]
  const polymod = bech32Polymod([...values, 0, 0, 0, 0, 0, 0]) ^ constValue
  const checksum: number[] = []
  for (let i = 0; i < 6; i += 1) {
    checksum.push((polymod >> (5 * (5 - i))) & 31)
  }
  return checksum
}

function bech32HrpExpand(hrp: string): number[] {
  const out: number[] = []
  for (let i = 0; i < hrp.length; i += 1) {
    out.push(hrp.charCodeAt(i) >> 5)
  }
  out.push(0)
  for (let i = 0; i < hrp.length; i += 1) {
    out.push(hrp.charCodeAt(i) & 31)
  }
  return out
}

function bech32Polymod(values: readonly number[]): number {
  let chk = 1
  for (const value of values) {
    const top = chk >> 25
    chk = ((chk & 0x1ffffff) << 5) ^ value
    for (let i = 0; i < BECH32_GENERATORS.length; i += 1) {
      if (((top >> i) & 1) !== 0) {
        chk ^= BECH32_GENERATORS[i]!
      }
    }
  }
  return chk >>> 0
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

function decodeBase58Check(input: string, maxPayloadBytes: number): Uint8Array {
  const decoded = decodeBase58(input, maxPayloadBytes + 4)
  if (decoded.length < 4) {
    throw new QbitProtocolError('INVALID_DESCRIPTOR', 'base58check payload is too short')
  }
  const payload = decoded.slice(0, -4)
  const checksum = decoded.slice(-4)
  const expected = sha256(sha256(payload)).slice(0, 4)
  if (compareBytes(checksum, expected) !== 0) {
    throw new QbitProtocolError('INVALID_DESCRIPTOR', 'base58check checksum mismatch')
  }
  return payload
}

class Base58LengthError extends QbitProtocolError {
  constructor(maxBytes: number) {
    super('INVALID_DESCRIPTOR', `base58 payload exceeds ${maxBytes} bytes`)
  }
}

// Mirrors qbit Core's DecodeBase58(str, vch, max_ret_len): decoding stops as soon
// as the output would exceed maxBytes, so oversized input costs O(maxBytes) work
// per character instead of a BigInt that grows with the whole string.
function decodeBase58(input: string, maxBytes: number): Uint8Array {
  if (input.length === 0) {
    throw new QbitProtocolError('INVALID_DESCRIPTOR', 'base58 string is empty')
  }

  let leadingZeroes = 0
  while (input[leadingZeroes] === '1') {
    leadingZeroes += 1
    if (leadingZeroes > maxBytes) {
      throw new Base58LengthError(maxBytes)
    }
  }

  const limit = 1n << BigInt(8 * (maxBytes - leadingZeroes))
  let value = 0n
  for (const char of input.slice(leadingZeroes)) {
    const digit = base58CharValues.get(char)
    if (digit === undefined) {
      throw new QbitProtocolError('INVALID_DESCRIPTOR', 'invalid base58 character')
    }
    value = value * 58n + BigInt(digit)
    if (value >= limit) {
      throw new Base58LengthError(maxBytes)
    }
  }

  const bytes: number[] = []
  while (value > 0n) {
    bytes.push(Number(value & 0xffn))
    value >>= 8n
  }
  bytes.reverse()

  const out = new Uint8Array(leadingZeroes + bytes.length)
  out.set(bytes, leadingZeroes)
  return out
}

function readUint32Be(bytes: Uint8Array, offset: number): number {
  if (offset < 0 || offset + 4 > bytes.length) {
    throw new QbitProtocolError('INVALID_BYTES', 'cannot read uint32 from bytes')
  }
  return (
    (bytes[offset]! * 0x1000000 +
      ((bytes[offset + 1]! << 16) >>> 0) +
      ((bytes[offset + 2]! << 8) >>> 0) +
      bytes[offset + 3]!) >>>
    0
  )
}

function convertBits(data: readonly number[], fromBits: number, toBits: number, pad: boolean): number[] {
  let acc = 0
  let bits = 0
  const ret: number[] = []
  const maxv = (1 << toBits) - 1
  const maxAcc = (1 << (fromBits + toBits - 1)) - 1

  for (const value of data) {
    if (value < 0 || value >> fromBits !== 0) {
      throw new QbitProtocolError('INVALID_BECH32', 'invalid convertbits value')
    }
    acc = ((acc << fromBits) | value) & maxAcc
    bits += fromBits
    while (bits >= toBits) {
      bits -= toBits
      ret.push((acc >> bits) & maxv)
    }
  }

  if (pad) {
    if (bits > 0) ret.push((acc << (toBits - bits)) & maxv)
  } else if (bits >= fromBits || ((acc << (toBits - bits)) & maxv) !== 0) {
    throw new QbitProtocolError('INVALID_BECH32', 'invalid padding in bech32 data')
  }

  return ret
}

function networkNameForHrp(hrp: string): QbitNetworkName | undefined {
  for (const params of Object.values(qbitNetworks)) {
    if (params.bech32Hrp === hrp) return params.name
  }
  return undefined
}

function taggedHash(tag: string, ...messages: readonly Uint8Array[]): Uint8Array {
  const tagHash = sha256(asciiBytes(tag))
  return sha256(concatBytes(tagHash, tagHash, ...messages))
}

function compactSize(value: number): Uint8Array {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError('CompactSize value must be a non-negative safe integer')
  }
  if (value < 253) return Uint8Array.of(value)
  if (value <= 0xffff) return Uint8Array.of(253, value & 0xff, (value >> 8) & 0xff)
  if (value <= 0xffffffff) {
    return Uint8Array.of(254, value & 0xff, (value >> 8) & 0xff, (value >> 16) & 0xff, (value >> 24) & 0xff)
  }

  let remaining = BigInt(value)
  const out = new Uint8Array(9)
  out[0] = 255
  for (let i = 1; i < out.length; i += 1) {
    out[i] = Number(remaining & 0xffn)
    remaining >>= 8n
  }
  return out
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

/**
 * Copy `bytes[start, end)` (negative indices count from the end) into a fresh,
 * unshared plain `Uint8Array`. Use this instead of `.slice()` for byte inputs:
 * Node's `Buffer` overrides `slice` to return a view of the caller's memory, so
 * a "copy" made with `.slice()` would track later writes to the input buffer.
 */
function copyBytes(bytes: Uint8Array, start = 0, end = bytes.length): Uint8Array {
  return new Uint8Array(bytes.subarray(start, end))
}

function concatBytes(...chunks: readonly Uint8Array[]): Uint8Array {
  const length = chunks.reduce((sum, chunk) => sum + chunk.length, 0)
  const out = new Uint8Array(length)
  let offset = 0
  for (const chunk of chunks) {
    out.set(chunk, offset)
    offset += chunk.length
  }
  return out
}

/** uint32 LE. Only a genuine uint32 is serializable; nothing is wrapped or truncated. */
function uint32LE(value: number, name: string): Uint8Array {
  assertUint32(value, name)
  const out = new Uint8Array(4)
  new DataView(out.buffer).setUint32(0, value, true)
  return out
}

/** CAmount (int64 LE). Only a MoneyRange amount is serializable; nothing wraps modulo 2^64. */
function serializeAmount(value: bigint, name: string): Uint8Array {
  assertMoneyRange(value, name)
  const out = new Uint8Array(8)
  new DataView(out.buffer).setBigInt64(0, value, true)
  return out
}

/**
 * qbit Core CScript / `ser_string`: a compactSize length prefix then the bytes.
 * Every caller-supplied script, annex and witness item reaches the wire and the
 * sighash through here, so this is where a look-alike is refused.
 */
function serializeVarBytes(bytes: Uint8Array, name: string): Uint8Array {
  assertBytes(bytes, name)
  return concatBytes(compactSize(bytes.length), bytes)
}

/** COutPoint: 32-byte txid (serialization order) followed by a uint32 LE index. */
function serializeOutpoint(outpoint: P2mrOutpoint): Uint8Array {
  assertByteLength(outpoint.txid, P2MR_PROGRAM_BYTES, 'outpoint txid')
  return concatBytes(outpoint.txid, uint32LE(outpoint.vout, 'vout'))
}

/** CTxOut: int64 LE amount followed by the var-bytes scriptPubKey. */
function serializeTxOut(output: P2mrTransactionOutput, name: string): Uint8Array {
  return concatBytes(
    serializeAmount(output.value, `${name} value`),
    serializeVarBytes(output.scriptPubKey, `${name} scriptPubKey`)
  )
}

/** qbit Core `serialize.h` MAX_SIZE: the largest CompactSize `ReadCompactSize` accepts. */
const COMPACT_SIZE_MAX = 0x02000000

function nonCanonicalCompactSize(): QbitProtocolError {
  return new QbitProtocolError('INVALID_PSBT', 'non-canonical compact size encoding')
}

function compactSizeTooLarge(): QbitProtocolError {
  return new QbitProtocolError('INVALID_PSBT', 'compact size too large')
}

class ByteReader {
  private offset = 0

  constructor(private readonly bytes: Uint8Array) {}

  get remaining(): number {
    return this.bytes.length - this.offset
  }

  readBytes(length: number): Uint8Array {
    if (length < 0 || this.offset + length > this.bytes.length) {
      throw new QbitProtocolError('INVALID_PSBT', 'unexpected end of data')
    }
    const out = copyBytes(this.bytes, this.offset, this.offset + length)
    this.offset += length
    return out
  }

  readUint8(): number {
    return this.readBytes(1)[0]!
  }

  readUint32LE(): number {
    const b = this.readBytes(4)
    return new DataView(b.buffer, b.byteOffset, 4).getUint32(0, true)
  }

  readInt64LE(): bigint {
    const b = this.readBytes(8)
    return new DataView(b.buffer, b.byteOffset, 8).getBigInt64(0, true)
  }

  /**
   * qbit Core `ReadCompactSize` with its default range check. Only the shortest
   * encoding of a value is valid: a `fd` prefix must carry at least 0xfd, `fe`
   * at least 0x10000 and `ff` at least 0x100000000, or Core throws
   * `non-canonical ReadCompactSize()`. A canonical value above MAX_SIZE
   * (0x02000000) then fails Core's `size too large` check. Every path that
   * reaches this reader (PSBT maps and key types, the unsigned transaction,
   * witness stacks and proprietary keys) is range-checked in Core as well.
   */
  readCompactSize(): number {
    const first = this.readUint8()
    if (first < 0xfd) return first
    let value: number
    if (first === 0xfd) {
      const b = this.readBytes(2)
      value = b[0]! | (b[1]! << 8)
      if (value < 0xfd) throw nonCanonicalCompactSize()
    } else if (first === 0xfe) {
      value = this.readUint32LE()
      if (value < 0x10000) throw nonCanonicalCompactSize()
    } else {
      if (BigInt.asUintN(64, this.readInt64LE()) < 0x100000000n) throw nonCanonicalCompactSize()
      // Every canonical 9-byte value is at least 2^32 and therefore above MAX_SIZE.
      throw compactSizeTooLarge()
    }
    if (value > COMPACT_SIZE_MAX) throw compactSizeTooLarge()
    return value
  }

  readVarBytes(): Uint8Array {
    return this.readBytes(this.readCompactSize())
  }
}

function parseUnsignedTransaction(bytes: Uint8Array, budget?: PsbtObjectBudget): P2mrTransaction {
  const reader = new ByteReader(bytes)
  const version = reader.readUint32LE()
  const inputCount = reader.readCompactSize()
  if (inputCount === 0) {
    throw new QbitProtocolError('INVALID_PSBT', 'unsigned transaction must not be witness-serialized')
  }
  // An input is at least an outpoint, an empty scriptSig and a sequence: 41 bytes.
  assertCountFits(inputCount, reader.remaining, 41, 'unsigned transaction input')
  budget?.spend(inputCount)
  const inputs: P2mrTransactionInput[] = []
  for (let i = 0; i < inputCount; i += 1) {
    const txid = reader.readBytes(32)
    const vout = reader.readUint32LE()
    const scriptSig = reader.readVarBytes()
    if (scriptSig.length !== 0) {
      throw new QbitProtocolError('INVALID_PSBT', 'unsigned transaction inputs must have empty scriptSigs')
    }
    const sequence = reader.readUint32LE()
    inputs.push({ prevout: { txid, vout }, sequence })
  }
  const outputCount = reader.readCompactSize()
  // An output is at least an amount and an empty scriptPubKey: 9 bytes.
  assertCountFits(outputCount, reader.remaining, 9, 'unsigned transaction output')
  budget?.spend(outputCount)
  const outputs: P2mrTransactionOutput[] = []
  for (let i = 0; i < outputCount; i += 1) {
    outputs.push(parseTxOutFromReader(reader, `output ${i} value`))
  }
  const locktime = reader.readUint32LE()
  if (reader.remaining !== 0) {
    throw new QbitProtocolError('INVALID_PSBT', 'invalid unsigned transaction encoding')
  }
  return { version, locktime, inputs, outputs }
}

function parseTxOutFromReader(reader: ByteReader, name: string): P2mrTransactionOutput {
  const value = reader.readInt64LE()
  assertMoneyRange(value, name)
  const scriptPubKey = reader.readVarBytes()
  return { value, scriptPubKey }
}

/** Parse a standalone CTxOut (a PSBT witness UTXO). */
function parseTxOut(bytes: Uint8Array, name: string): P2mrTransactionOutput {
  const reader = new ByteReader(bytes)
  const output = parseTxOutFromReader(reader, name)
  if (reader.remaining !== 0) {
    throw new QbitProtocolError('INVALID_PSBT', 'invalid witness UTXO encoding')
  }
  return output
}

/** Which PSBT map a key sits in; Core deserializes the three maps with different rules. */
type PsbtMapKind = 'global' | 'input' | 'output'

function readPsbtMap(reader: ByteReader, kind: PsbtMapKind, budget: PsbtObjectBudget): PsbtKeyValue[] {
  const entries: PsbtKeyValue[] = []
  const seen = new Set<string>()
  for (;;) {
    const keyLength = reader.readCompactSize()
    if (keyLength === 0) break
    budget.spend(1)
    const key = reader.readBytes(keyLength)
    validatePsbtKey(key, kind)
    const value = reader.readVarBytes()
    const keyHex = psbtKeyIndexId(key)
    if (seen.has(keyHex)) {
      throw new QbitProtocolError('INVALID_PSBT', 'duplicate key in PSBT map')
    }
    seen.add(keyHex)
    entries.push({ key, value })
  }
  return entries
}

function serializePsbtMap(entries: readonly PsbtKeyValue[]): Uint8Array {
  const parts: Uint8Array[] = []
  for (const { key, value } of entries) {
    const serializedKey = serializeVarBytes(key, 'PSBT key')
    // An empty key would be written as the map separator, ending the map early,
    // so the bytes would parse back as a different PSBT.
    if (key.length === 0) throw new QbitProtocolError('INVALID_PSBT', 'empty key in PSBT map')
    parts.push(serializedKey, serializeVarBytes(value, 'PSBT value'))
  }
  parts.push(Uint8Array.of(0x00))
  return concatByteList(parts)
}

/** qbit Core `psbt.h`: a map key starts with its type as a CompactSize, not a raw byte. */
function readPsbtKeyType(key: Uint8Array): number {
  return new ByteReader(key).readCompactSize()
}

/**
 * Core reads every key's type with `ReadCompactSize` and unserializes every
 * `0xfc` proprietary key (the same type byte in the global, input and output
 * maps) as `<identifier><subtype>` while deserializing a PSBT. Only
 * `PSBTInput::Unserialize` then dispatches on the `qbit` identifier's
 * `PSBT_QBIT_IN_*` subtypes and rejects known keys whose key data has the wrong
 * shape ("more than one byte type"); the global and output maps store every
 * proprietary record opaquely. Apply the same per-map checks so malformed keys
 * fail at parse time, not when a field is first decoded.
 */
function validatePsbtKey(key: Uint8Array, kind: PsbtMapKind): void {
  if (readPsbtKeyType(key) !== PSBT_IN_PROPRIETARY) return
  const { identifier, subtype, keyData } = parseProprietaryKey(key)
  if (kind === 'input' && bytesEqual(identifier, asciiBytes(PSBT_QBIT_IDENTIFIER))) {
    assertQbitProprietaryP2mrKeyData(subtype, keyData)
  }
}

/** Key-data shape of the qbit proprietary P2MR fields; matches the field decoders. */
function assertQbitProprietaryP2mrKeyData(subtype: number, keyData: Uint8Array): void {
  if (subtype === PSBT_QBIT_IN_P2MR_MERKLE_ROOT && keyData.length !== 0) {
    throw new QbitProtocolError('INVALID_PSBT', 'qbit P2MR merkle root key data must be empty')
  }
  if (subtype === PSBT_QBIT_IN_P2MR_LEAF_SCRIPT) {
    assertP2mrControlBlockShape(keyData)
  }
  if (subtype === PSBT_QBIT_IN_P2MR_SCRIPT_SIG && keyData.length !== 2 * P2MR_PROGRAM_BYTES) {
    throw new QbitProtocolError('INVALID_PSBT', 'input P2MR script signature key must be type||pubkey32||leafhash32')
  }
}

function validatePsbtKeys(psbt: Psbt): void {
  for (const entry of psbt.global) validatePsbtKey(entry.key, 'global')
  for (const map of psbt.inputs) for (const entry of map) validatePsbtKey(entry.key, 'input')
  for (const map of psbt.outputs) for (const entry of map) validatePsbtKey(entry.key, 'output')
}

function parseProprietaryKey(key: Uint8Array): { identifier: Uint8Array; subtype: number; keyData: Uint8Array } {
  const reader = new ByteReader(key)
  if (reader.readCompactSize() !== PSBT_IN_PROPRIETARY) {
    throw new QbitProtocolError('INVALID_PSBT', 'not a proprietary PSBT key')
  }
  const identifier = reader.readVarBytes()
  const subtype = reader.readCompactSize()
  const keyData = reader.readBytes(reader.remaining)
  return { identifier, subtype, keyData }
}

function cloneEntry(entry: PsbtKeyValue): PsbtKeyValue {
  return { key: copyBytes(entry.key), value: copyBytes(entry.value) }
}

function cloneTxOut(output: P2mrTransactionOutput): P2mrTransactionOutput {
  return { value: output.value, scriptPubKey: copyBytes(output.scriptPubKey) }
}

function cloneP2mrTransaction(tx: P2mrTransaction): P2mrTransaction {
  return {
    version: tx.version,
    locktime: tx.locktime,
    inputs: tx.inputs.map(input => ({
      prevout: { txid: copyBytes(input.prevout.txid), vout: input.prevout.vout },
      sequence: input.sequence,
    })),
    outputs: tx.outputs.map(cloneTxOut),
  }
}

function mergeMap(target: PsbtKeyValue[], source: readonly PsbtKeyValue[]): void {
  for (const entry of source) {
    const existing = target.find(candidate => bytesEqual(candidate.key, entry.key))
    if (existing === undefined) {
      target.push(cloneEntry(entry))
    } else if (!bytesEqual(existing.value, entry.value)) {
      throw new QbitProtocolError('INVALID_PSBT', 'conflicting values for the same PSBT key')
    }
  }
}

/**
 * Index id for a PSBT key. V8 hashes a string longer than 16,383 characters by
 * its length alone, so the hex of equal-length keys of 8 KiB or more would all
 * share one hash bucket and make the index quadratic again. Keys over 64 bytes
 * are indexed by their SHA-256; the `#` prefix keeps that id space apart from
 * hex.
 */
function psbtKeyIndexId(key: Uint8Array): string {
  return key.length <= 64 ? bytesToHex(key) : `#${bytesToHex(sha256(key))}`
}

/** Index a map by key. A repeated key maps to its first entry, as `mergeMap`'s `find` does. */
function indexPsbtMap(map: readonly PsbtKeyValue[]): Map<string, PsbtKeyValue> {
  const index = new Map<string, PsbtKeyValue>()
  for (const entry of map) {
    const keyHex = psbtKeyIndexId(entry.key)
    if (!index.has(keyHex)) index.set(keyHex, entry)
  }
  return index
}

/**
 * `mergeMap` for combinePsbts: look keys up in `index` (`indexPsbtMap(target)`,
 * kept up to date here) instead of scanning `target` for every source entry,
 * which made combinePsbts quadratic.
 */
function mergeIndexedMap(
  target: PsbtKeyValue[],
  index: Map<string, PsbtKeyValue>,
  source: readonly PsbtKeyValue[]
): void {
  for (const entry of source) {
    const keyHex = psbtKeyIndexId(entry.key)
    const existing = index.get(keyHex)
    if (existing === undefined) {
      const added = cloneEntry(entry)
      target.push(added)
      index.set(keyHex, added)
    } else if (!bytesEqual(existing.value, entry.value)) {
      throw new QbitProtocolError('INVALID_PSBT', 'conflicting values for the same PSBT key')
    }
  }
}

function requireUnsignedTxBytes(psbt: Psbt): Uint8Array {
  const entry = psbt.global.find(item => item.key.length === 1 && item.key[0] === PSBT_GLOBAL_UNSIGNED_TX)
  if (entry === undefined) {
    throw new QbitProtocolError('INVALID_PSBT', 'PSBT is missing the unsigned transaction')
  }
  return entry.value
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && compareBytes(a, b) === 0
}

function serializeUnsignedTransaction(tx: P2mrTransaction): Uint8Array {
  const parts: Uint8Array[] = [uint32LE(tx.version, 'version'), compactSize(tx.inputs.length)]
  for (const input of tx.inputs) {
    parts.push(serializeOutpoint(input.prevout), compactSize(0), uint32LE(input.sequence, 'sequence'))
  }
  parts.push(compactSize(tx.outputs.length))
  tx.outputs.forEach((output, i) => parts.push(serializeTxOut(output, `output ${i}`)))
  parts.push(uint32LE(tx.locktime, 'locktime'))
  return concatBytes(...parts)
}

function serializeWitnessTransaction(tx: P2mrTransaction, witnesses: readonly (readonly Uint8Array[])[]): Uint8Array {
  const parts: Uint8Array[] = [
    uint32LE(tx.version, 'version'),
    Uint8Array.of(0x00, 0x01),
    compactSize(tx.inputs.length),
  ]
  for (const input of tx.inputs) {
    parts.push(serializeOutpoint(input.prevout), compactSize(0), uint32LE(input.sequence, 'sequence'))
  }
  parts.push(compactSize(tx.outputs.length))
  tx.outputs.forEach((output, i) => parts.push(serializeTxOut(output, `output ${i}`)))
  for (const stack of witnesses) parts.push(serializeWitnessStack(stack))
  parts.push(uint32LE(tx.locktime, 'locktime'))
  return concatBytes(...parts)
}

function serializeWitnessStack(stack: readonly Uint8Array[]): Uint8Array {
  const parts: Uint8Array[] = [compactSize(stack.length)]
  stack.forEach((item, i) => parts.push(serializeVarBytes(item, `witness item ${i}`)))
  return concatBytes(...parts)
}

/**
 * qbit Core MAX_STACK_SIZE (src/script/script.h:43), which also caps a P2MR v1
 * spend's initial stack: the witness minus an optional annex, the control
 * block and the leaf script (src/script/interpreter.cpp:39, :2355-2370).
 */
const P2MR_MAX_STACK_ITEMS = 1000
/** The most items a valid P2MR final witness has: the stack, script, control block and annex. */
const P2MR_MAX_FINAL_WITNESS_ITEMS = P2MR_MAX_STACK_ITEMS + 3
/** Core MAX_P2MR_V1_STACK_ITEM_SIZE and MAX_P2MR_V1_TOTAL_INITIAL_STACK_BYTES (src/script/script.h:46, :49). */
const P2MR_V1_MAX_STACK_ITEM_BYTES = 16 * 1024
const P2MR_V1_MAX_STACK_BYTES = 128 * 1024
/** BIP174 PSBT_IN_FINAL_SCRIPTSIG. */
const PSBT_IN_FINAL_SCRIPTSIG = 0x07
/** Core ANNEX_TAG (src/script/script.h:66). */
const ANNEX_TAG = 0x50
/** Counts the objects one `parsePsbt` or `extractP2mrTransaction` call decodes, up to `maxObjects`. */
class PsbtObjectBudget {
  private remaining: number

  constructor(private readonly limit: number) {
    this.remaining = limit
  }

  spend(count: number): void {
    if (count > this.remaining) {
      throw new QbitProtocolError(
        'INVALID_PSBT',
        `PSBT has more than ${this.limit} map entries, transaction inputs and outputs, ` +
          'and witness items; raise maxObjects to allow more'
      )
    }
    this.remaining -= count
  }
}

/** A `PsbtLimitOptions` value: the default when undefined, else a positive safe integer. */
function resolvePsbtLimit(value: number | undefined, fallback: number, name: string): number {
  const limit = value === undefined ? fallback : value
  if (!Number.isSafeInteger(limit) || limit <= 0) {
    throw new RangeError(`${name} must be a positive safe integer`)
  }
  return limit
}

/** Reject a count of records, each at least `minBytes` long, that cannot fit in the bytes left. */
function assertCountFits(count: number, remaining: number, minBytes: number, name: string): void {
  if (count > Math.floor(remaining / minBytes)) {
    throw new QbitProtocolError('INVALID_PSBT', `${name} count exceeds the remaining data`)
  }
}

/**
 * qbit Core's P2MR v1 initial-stack limits (src/script/interpreter.cpp:37-47),
 * found the way Core finds them (:2355-2395): drop an annex, then the control
 * block and leaf script, and check what is left when the control byte selects
 * leaf version 0xc0. Other stacks are left alone.
 */
function assertP2mrV1WitnessLimits(stack: readonly Uint8Array[]): void {
  let end = stack.length
  if (end >= 2 && stack[end - 1]![0] === ANNEX_TAG) end -= 1
  if (end < 2) return
  const controlByte = stack[end - 1]![0]
  if (controlByte === undefined || (controlByte & P2MR_LEAF_VERSION_MASK) !== P2MR_LEAF_VERSION_V1) return
  const initialItems = end - 2
  if (initialItems > P2MR_MAX_STACK_ITEMS) {
    throw new QbitProtocolError(
      'INVALID_PSBT',
      `P2MR final scriptwitness has more than ${P2MR_MAX_STACK_ITEMS} stack items`
    )
  }
  let total = 0
  for (let i = 0; i < initialItems; i += 1) {
    const size = stack[i]!.length
    if (size > P2MR_V1_MAX_STACK_ITEM_BYTES) {
      throw new QbitProtocolError(
        'INVALID_PSBT',
        `P2MR final scriptwitness item exceeds ${P2MR_V1_MAX_STACK_ITEM_BYTES} bytes`
      )
    }
    total += size
    if (total > P2MR_V1_MAX_STACK_BYTES) {
      throw new QbitProtocolError(
        'INVALID_PSBT',
        `P2MR final scriptwitness stack exceeds ${P2MR_V1_MAX_STACK_BYTES} bytes`
      )
    }
  }
}

function parseWitnessStack(bytes: Uint8Array, budget?: PsbtObjectBudget): Uint8Array[] {
  const reader = new ByteReader(bytes)
  const count = reader.readCompactSize()
  if (count > P2MR_MAX_FINAL_WITNESS_ITEMS) {
    throw new QbitProtocolError(
      'INVALID_PSBT',
      `final scriptwitness has more than ${P2MR_MAX_FINAL_WITNESS_ITEMS} items`
    )
  }
  // Each item needs at least its length byte.
  assertCountFits(count, reader.remaining, 1, 'final scriptwitness item')
  budget?.spend(count)
  const items: Uint8Array[] = []
  for (let i = 0; i < count; i += 1) items.push(reader.readVarBytes())
  if (reader.remaining !== 0) {
    throw new QbitProtocolError('INVALID_PSBT', 'invalid final scriptwitness encoding')
  }
  assertP2mrV1WitnessLimits(items)
  return items
}

interface PreparedP2mrSigning {
  tx: P2mrTransaction
  spentOutputs: readonly P2mrSpentOutput[]
  plans: PreparedP2mrSigningPlan[]
}

function prepareP2mrSigningPlans(
  psbt: Psbt,
  keys: readonly P2mrSigningKey[],
  options: P2mrSigningOptions = {}
): PreparedP2mrSigning {
  const tx = psbtUnsignedTransaction(psbt)
  const summary = decodePsbt(psbt)
  assertRestrictedOutputModeOutputs(tx.outputs, options.restrictedOutputMode)
  const spentOutputs = extractSpentOutputs(psbt)
  const midstates = precomputeSighashMidstates(tx, spentOutputs)
  const targets = new Set<string>()
  const inputHashTypes = new Map<number, number>()
  const plans: PreparedP2mrSigningPlan[] = []

  for (const key of keys) {
    if (!Number.isInteger(key.inputIndex) || key.inputIndex < 0 || key.inputIndex >= tx.inputs.length) {
      throw new QbitProtocolError('INVALID_PSBT', 'signing key inputIndex out of range')
    }

    // Check before copying: copying another view would convert it first.
    const { pubkey: pubkeyInput, leafHash: leafHashInput } = key
    assertByteLength(pubkeyInput, P2MR_PROGRAM_BYTES, 'P2MR signing pubkey')
    assertByteLength(leafHashInput, P2MR_PROGRAM_BYTES, 'P2MR signing leaf hash')
    const pubkey = copyBytes(pubkeyInput)
    const leafHash = copyBytes(leafHashInput)

    const hashType = key.hashType ?? SIGHASH_DEFAULT
    if (!isValidP2mrSighashType(hashType)) {
      throw new QbitProtocolError('INVALID_SIGHASH', 'invalid P2MR signing plan sighash type')
    }
    // Only a literal `true` opts in: the gate protects users from signatures
    // that do not commit to the transaction an approval UI showed them.
    if (hashType !== SIGHASH_DEFAULT && options.allowNonDefaultSighash !== true) {
      throw new QbitProtocolError(
        'INVALID_SIGHASH',
        `input ${key.inputIndex}: sighash type ${formatSighashType(hashType)} requires allowNonDefaultSighash: true; ` +
          'only SIGHASH_DEFAULT is accepted without an explicit opt-in'
      )
    }

    const target = `${key.inputIndex}:${bytesToHex(pubkey)}:${bytesToHex(leafHash)}`
    if (targets.has(target)) {
      throw new QbitProtocolError('INVALID_PSBT', `input ${key.inputIndex}: duplicate P2MR signing plan`)
    }
    targets.add(target)

    const input = summary.inputs[key.inputIndex]!
    if (input.finalized) {
      throw new QbitProtocolError('INVALID_PSBT', `input ${key.inputIndex}: input is already finalized`)
    }
    // finalizeP2mrPsbt would refuse this input whatever is signed.
    assertNoP2mrFinalScriptSig(psbt.inputs[key.inputIndex]!, key.inputIndex)
    if (input.scriptSigs.some(sig => bytesEqual(sig.pubkey, pubkey) && bytesEqual(sig.leafHash, leafHash))) {
      throw new QbitProtocolError('INVALID_PSBT', `input ${key.inputIndex}: signing plan already has a P2MR signature`)
    }
    // Core's SignPSBTInput SIGHASH_MISMATCH rules: the plan's type must equal the
    // input's PSBT_IN_SIGHASH_TYPE (if present) and the type of every P2MR
    // signature already on the input. Plans made in one call for the same input
    // are held to the same rule so an input never ends up with mixed types.
    if (input.sighashType !== undefined && input.sighashType !== hashType) {
      throw new QbitProtocolError(
        'INVALID_SIGHASH',
        `input ${key.inputIndex}: PSBT_IN_SIGHASH_TYPE ${formatSighashType(input.sighashType)} ` +
          `does not match the signing plan sighash type ${formatSighashType(hashType)}`
      )
    }
    const plannedHashType = inputHashTypes.get(key.inputIndex)
    if (plannedHashType !== undefined && plannedHashType !== hashType) {
      throw new QbitProtocolError(
        'INVALID_SIGHASH',
        `input ${key.inputIndex}: signing plans for one input must share a sighash type ` +
          `(${formatSighashType(plannedHashType)} and ${formatSighashType(hashType)})`
      )
    }
    inputHashTypes.set(key.inputIndex, hashType)
    for (const sig of input.scriptSigs) {
      if (sig.signature.hashType !== hashType) {
        throw new QbitProtocolError(
          'INVALID_SIGHASH',
          `input ${key.inputIndex}: existing P2MR signature uses sighash type ` +
            `${formatSighashType(sig.signature.hashType)} but the signing plan uses ${formatSighashType(hashType)}`
        )
      }
    }
    validateP2mrSigningPlan(input, key.inputIndex, pubkey, leafHash)

    plans.push({
      inputIndex: key.inputIndex,
      pubkey,
      leafHash,
      hashType,
      sighash: p2mrSighash({
        tx,
        inputIndex: key.inputIndex,
        spentOutputs,
        leafHash,
        hashType,
        midstates,
      }),
    })
  }

  assertFinalizeUsesP2mrPlans(summary, plans)
  return { tx, spentOutputs, plans }
}

/**
 * Refuse plans whose signatures `finalizeP2mrPsbt` would leave out. For each
 * input, finalize's own selection ({@link selectP2mrWitness}) runs over the
 * input's signatures plus a placeholder for each of the input's plans; a real
 * signature has the placeholder's length, so the witness sizes are exact. When
 * a witness is complete, it must place every plan, as qbit Core signs only the
 * leaf it finalizes and stops at its threshold (sign.cpp:592-613, :729-741).
 * When no leaf is complete, the plans must share one leaf hash, as a witness
 * reveals one leaf and Core signs only its best partial plan (sign.cpp:743-756);
 * plans on one leaf pass, so co-signers can complete a `multi_a` leaf in turn.
 */
function assertFinalizeUsesP2mrPlans(summary: PsbtSummary, plans: readonly PreparedP2mrSigningPlan[]): void {
  const placeholder = new Uint8Array(PQC_SIGNATURE_BYTES)
  const planned = new Map<number, P2mrPsbtScriptSigField[]>()
  for (const { inputIndex, pubkey, leafHash, hashType } of plans) {
    const sig: P2mrPsbtScriptSigField = {
      type: 'p2mrScriptSig',
      pubkey,
      leafHash,
      signature: { signature: placeholder, hashType, explicitHashType: hashType !== SIGHASH_DEFAULT },
    }
    const sigs = planned.get(inputIndex)
    if (sigs === undefined) planned.set(inputIndex, [sig])
    else sigs.push(sig)
  }
  for (const [inputIndex, sigs] of planned) {
    const input = summary.inputs[inputIndex]!
    const root = requireP2mrInputRoot(input, inputIndex)
    // The preflight refused a plan that repeats an existing signature, so no placeholder replaces one.
    const { witness } = selectP2mrWitness(input, [...input.scriptSigs, ...sigs], root)
    if (witness === undefined) {
      // A witness reveals one leaf and a signature commits to its leaf hash, so plans on two leaves
      // that complete neither spend a key use that finalize can never place (sign.cpp:743-756).
      const leafHashes = new Set(sigs.map(sig => bytesToHex(sig.leafHash)))
      if (leafHashes.size > 1) {
        throw new QbitProtocolError(
          'INVALID_PSBT',
          `input ${inputIndex}: this call plans signatures on ${leafHashes.size} leaves and completes none; ` +
            'finalizeP2mrPsbt uses one leaf'
        )
      }
      continue
    }
    const unused = sigs.find(sig => !witness.stack.includes(sig))
    if (unused !== undefined) {
      throw new QbitProtocolError(
        'INVALID_PSBT',
        `input ${inputIndex}: finalizeP2mrPsbt would not use the signature planned for pubkey ` +
          `${bytesToHex(unused.pubkey)} and leaf hash ${bytesToHex(unused.leafHash)}: the input's signatures ` +
          "and this call's other plans complete a witness without it"
      )
    }
  }
}

function formatSighashType(hashType: number): string {
  return `0x${hashType.toString(16).padStart(2, '0')}`
}

function encodePsbtSighashTypeField(hashType: number): PsbtKeyValue {
  return { key: Uint8Array.of(PSBT_IN_SIGHASH_TYPE), value: uint32LE(hashType, 'hashType') }
}

function decodePsbtSighashTypeField(key: Uint8Array, value: Uint8Array, inputIndex: number): number {
  if (key.length !== 1) {
    throw new QbitProtocolError(
      'INVALID_PSBT',
      `input ${inputIndex}: PSBT_IN_SIGHASH_TYPE key must be the single type byte`
    )
  }
  if (value.length !== 4) {
    throw new QbitProtocolError(
      'INVALID_PSBT',
      `input ${inputIndex}: PSBT_IN_SIGHASH_TYPE value must be a 4-byte little-endian uint32`
    )
  }
  const sighashType = new DataView(value.buffer, value.byteOffset, 4).getUint32(0, true)
  if (!isValidP2mrSighashType(sighashType)) {
    throw new QbitProtocolError(
      'INVALID_PSBT',
      `input ${inputIndex}: PSBT_IN_SIGHASH_TYPE ${formatSighashType(sighashType)} is not a valid P2MR sighash type`
    )
  }
  return sighashType
}

function validateP2mrSigningPlan(
  input: PsbtInputSummary,
  inputIndex: number,
  pubkey: Uint8Array,
  leafHash: Uint8Array
): void {
  const root = requireP2mrInputRoot(input, inputIndex)
  const leafHashHex = bytesToHex(leafHash)
  const leaf = groupP2mrInputLeaves(input.leafScripts, new Set([leafHashHex])).get(leafHashHex)
  if (leaf === undefined) {
    throw new QbitProtocolError(
      'INVALID_PSBT',
      `input ${inputIndex}: signing leaf hash does not match a PSBT leaf script`
    )
  }
  const { leafVersion, script } = leaf
  if (!p2mrSigningTemplateHasKey(leafVersion, script, pubkey)) {
    if (p2mrSigningTemplate(leafVersion, script) === undefined) {
      throw new QbitProtocolError(
        'INVALID_PSBT',
        `input ${inputIndex}: signing leaf is not a v1 pk/multi_a template containing this key`
      )
    }
    throw new QbitProtocolError(
      'INVALID_PSBT',
      `input ${inputIndex}: signing pubkey is not used by the selected P2MR leaf script`
    )
  }
  // The rule finalizeP2mrPsbt applies, so a leaf signed here is one it can put in the witness.
  if (committedP2mrControlBlock(leaf.controlBlocks, leafVersion, leafHash, root) === undefined) {
    throw new QbitProtocolError(
      'INVALID_PSBT',
      `input ${inputIndex}: P2MR control block does not commit to the witness UTXO program`
    )
  }
}

/**
 * The control block qbit Core puts in the witness for a leaf: of the leaf's
 * control blocks whose control byte carries the leaf's version and whose path
 * reaches `root`, the shortest, then the bytewise smallest. Core keeps a leaf's
 * control blocks in a shortest-first set (psbt.h:298) and takes the first that
 * commits (`FindValidP2MRControlBlock`, sign.cpp:616-631); a control block that
 * does not is skipped rather than rejected. `undefined` when none commits.
 */
function committedP2mrControlBlock(
  controlBlocks: readonly Uint8Array[],
  leafVersion: number,
  leafHash: Uint8Array,
  root: Uint8Array
): Uint8Array | undefined {
  const ordered = [...controlBlocks].sort((a, b) => a.length - b.length || compareBytes(a, b))
  return ordered.find(
    controlBlock =>
      (controlBlock[0]! & P2MR_LEAF_VERSION_MASK) === leafVersion &&
      bytesEqual(verifyControlBlock(controlBlock, leafHash), root)
  )
}

interface P2mrSigningTemplate {
  /** The keys in script order. */
  keys: Uint8Array[]
  threshold: number
}

/**
 * The pubkeys (in script order) and threshold of a P2MR leaf that qbit Core
 * would sign and finalize, or `undefined` when Core builds no signing plan for
 * the leaf. Mirrors qbit Core v1.0.0
 * `BuildP2MRScriptSigningPlan` (src/script/sign.cpp:503-511):
 *
 * - the leaf version is `P2MR_LEAF_VERSION_V1` (0xc0) (sign.cpp:506);
 * - the script is exactly `pk(K)`: `0x20 K OP_CHECKSIGPQC` (sign.cpp:313-320);
 * - or a `multi_a` matched by `p2mr::MatchMultiA` (src/script/p2mr.h:40-70,
 *   called at sign.cpp:323): n >= 1 groups of `0x20 K`, each followed by
 *   OP_CHECKSIGPQC for the first key and OP_CHECKSIGADD for the rest, with
 *   n <= MAX_PUBKEYS_PER_MULTI_A = 999 (src/script/script.h:37); then the
 *   threshold as a minimal script number in 1..n
 *   (src/script/scriptnum_parsing.h:22-39); then OP_NUMEQUAL as the last byte;
 * - the threshold is at most P2MR_V1_MAX_STANDARD_SIGNATURES = 35
 *   (sign.cpp:511, src/script/p2mr_sizing.h:18-24).
 *
 * Because the threshold is at most 35, its only minimal encodings are OP_1..OP_16
 * and a one-byte direct push of 17..35.
 */
function p2mrSigningTemplate(leafVersion: number, script: Uint8Array): P2mrSigningTemplate | undefined {
  const maxPubkeysPerMultiA = 999
  const maxStandardSignatures = 35
  const keyGroupBytes = 1 + P2MR_PROGRAM_BYTES + 1

  if (leafVersion !== P2MR_LEAF_VERSION_V1) return undefined
  if (
    script.length === keyGroupBytes &&
    script[0] === P2MR_PROGRAM_BYTES &&
    script[keyGroupBytes - 1] === OP_CHECKSIGPQC
  ) {
    return { keys: [script.subarray(1, keyGroupBytes - 1)], threshold: 1 }
  }

  const keys: Uint8Array[] = []
  let offset = 0
  while (script.length - offset >= keyGroupBytes) {
    if (script[offset] !== P2MR_PROGRAM_BYTES) return undefined
    const checksigOpcode = keys.length === 0 ? OP_CHECKSIGPQC : OP_CHECKSIGADD
    if (script[offset + keyGroupBytes - 1] !== checksigOpcode) return undefined
    keys.push(script.subarray(offset + 1, offset + keyGroupBytes - 1))
    offset += keyGroupBytes
  }
  if (keys.length === 0 || keys.length > maxPubkeysPerMultiA) return undefined
  if (script[script.length - 1] !== OP_NUMEQUAL) return undefined

  const thresholdOp = script.subarray(offset, script.length - 1)
  let threshold: number
  if (thresholdOp.length === 1 && thresholdOp[0]! >= OP_1 && thresholdOp[0]! <= OP_16) {
    threshold = thresholdOp[0]! - OP_1 + 1
  } else if (thresholdOp.length === 2 && thresholdOp[0] === 1 && thresholdOp[1]! > 16) {
    threshold = thresholdOp[1]!
  } else {
    return undefined
  }
  if (threshold > keys.length || threshold > maxStandardSignatures) return undefined
  return { keys, threshold }
}

/**
 * Whether qbit Core would sign `pubkey` in this leaf: the leaf is a v1 `pk(K)`
 * or Core-shaped `multi_a` (threshold <= 35) template, as accepted by
 * {@link p2mrSigningTemplate}, and `pubkey` is one of its keys.
 *
 * The signing preflight uses this instead of scanning the script for
 * `<pubkey> OP_CHECKSIGPQC|OP_CHECKSIGADD`, which also matched leaves that
 * Core never signs: a non-v1 leaf version (whose script consensus does not
 * execute), the key inside an OP_PUSHDATA payload, a non-minimal key push,
 * extra opcodes, or a threshold above 35. Core's wallet does not sign these
 * leaves: such a signature is never checked, can never verify, or sits in an
 * invalid or nonstandard witness.
 *
 * It also keeps OP_CODESEPARATOR out of signed leaves. The sighash is computed
 * with codeSeparatorPos 0xffffffff, as Core's signer hard-codes
 * (sign.cpp:118), while Core's interpreter commits to the position of the last
 * executed OP_CODESEPARATOR (src/script/interpreter.cpp:1170-1177), so a
 * signature checked after one would not verify. Neither template contains
 * OP_CODESEPARATOR, so the fixed position is right for every accepted leaf.
 */
function p2mrSigningTemplateHasKey(leafVersion: number, script: Uint8Array, pubkey: Uint8Array): boolean {
  const template = p2mrSigningTemplate(leafVersion, script)
  return template !== undefined && template.keys.some(key => bytesEqual(key, pubkey))
}

/**
 * One leaf of an input as Core stores it: a (script, leaf version) entry with
 * every control block it is carried with (psbt.h:298).
 */
interface P2mrInputLeaf {
  script: Uint8Array
  leafVersion: number
  leafHash: Uint8Array
  controlBlocks: Uint8Array[]
}

/**
 * Group an input's leaf records, as `decodePsbt` reports them, into Core's
 * (script, leaf version) entries, keyed by the leaf hash's hex, which commits
 * to both. Only leaves whose hash is in `wanted` are kept, so a PSBT dense
 * with leaf records costs no retained heap per record. The signing preflight
 * and `finalizeP2mrPsbt` read leaves only through this, so they agree on the
 * control blocks of each leaf.
 */
function groupP2mrInputLeaves(
  leafScripts: readonly P2mrPsbtLeafScriptField[],
  wanted: ReadonlySet<string>
): Map<string, P2mrInputLeaf> {
  const leaves = new Map<string, P2mrInputLeaf>()
  for (const { script, leafVersion, controlBlock } of leafScripts) {
    const leafHash = p2mrLeafHash(leafVersion, script)
    const leafHashHex = bytesToHex(leafHash)
    if (!wanted.has(leafHashHex)) continue
    const existing = leaves.get(leafHashHex)
    if (existing !== undefined) {
      existing.controlBlocks.push(controlBlock)
    } else {
      leaves.set(leafHashHex, { script, leafVersion, leafHash, controlBlocks: [controlBlock] })
    }
  }
  return leaves
}

/** The witness `finalizeP2mrPsbt` chooses for an input, before it is encoded. */
interface P2mrWitnessChoice {
  /** One entry per key of the leaf, last key first: the signature placed there, or `undefined` for an empty item. */
  stack: (P2mrPsbtScriptSigField | undefined)[]
  script: Uint8Array
  controlBlock: Uint8Array
}

interface P2mrWitnessSelection {
  /** `undefined` when no committed leaf has enough signatures. */
  witness: P2mrWitnessChoice | undefined
  /** Some v1 `pk` or `multi_a` leaf has a signature for one of its keys. */
  signedLeaf: boolean
  /** Some such leaf also has a control block that commits to the root. */
  committedLeaf: boolean
}

/**
 * The witness qbit Core's `FinalizePSBT` chooses for a P2MR input from its
 * leaves and `sigs`, one per (pubkey, leaf hash). It runs `SignPSBTInput` with
 * no keys (psbt.cpp:697), so only these signatures count:
 *
 * - each leaf is a (script, leaf version) entry with its committing control
 *   block ({@link committedP2mrControlBlock}). Only a v1 `pk` or `multi_a`
 *   leaf ({@link p2mrSigningTemplate}) with at least one signature gets a plan,
 *   and the plan is complete when signatures for `threshold` of its keys are
 *   present (`BuildP2MRScriptSigningPlan`, sign.cpp:503-590). Signatures and
 *   leaves for anything else are ignored;
 * - of the complete plans, the one with the smallest witness wins, ties going
 *   to the bytewise-smallest script (sign.cpp:716-741). Its stack holds, from
 *   the last key to the first, a signature while fewer than `threshold` are
 *   placed and an empty item otherwise, then the script and control block
 *   (`SignP2MRScript`, sign.cpp:592-614).
 *
 * `finalizeP2mrPsbt` runs this on the input's signatures, and the signing
 * preflight on those plus a placeholder for each planned signature, so a plan
 * passes only when the witness finalize will choose places it.
 *
 * The stack-size and weight checks of `BuildP2MRScriptSigningPlan`
 * (sign.cpp:565-577) always pass for these templates: at most 999 keys and 35
 * signatures of at most 3,681 bytes, and each signature adds at least as many
 * witness bytes as the 3,683 weight it costs. Signatures are not verified, so
 * one that does not verify is chosen where Core would report
 * `INVALID_P2MR_SIGNATURE`.
 */
function selectP2mrWitness(
  input: PsbtInputSummary,
  sigs: readonly P2mrPsbtScriptSigField[],
  root: Uint8Array
): P2mrWitnessSelection {
  const sigsById = new Map<string, P2mrPsbtScriptSigField>()
  const signedLeafHashes = new Set<string>()
  for (const sig of sigs) {
    const leafHashHex = bytesToHex(sig.leafHash)
    sigsById.set(bytesToHex(sig.pubkey) + leafHashHex, sig)
    signedLeafHashes.add(leafHashHex)
  }

  let best: (P2mrWitnessChoice & { size: number }) | undefined
  let signedLeaf = false
  let committedLeaf = false
  for (const [leafHashHex, leaf] of groupP2mrInputLeaves(input.leafScripts, signedLeafHashes)) {
    const template = p2mrSigningTemplate(leaf.leafVersion, leaf.script)
    if (template === undefined) continue
    const { keys, threshold } = template
    const stack: (P2mrPsbtScriptSigField | undefined)[] = []
    let placed = 0
    for (let i = keys.length - 1; i >= 0; i -= 1) {
      const sig = placed < threshold ? sigsById.get(bytesToHex(keys[i]!) + leafHashHex) : undefined
      if (sig !== undefined) placed += 1
      stack.push(sig)
    }
    if (placed === 0) continue
    signedLeaf = true
    const controlBlock = committedP2mrControlBlock(leaf.controlBlocks, leaf.leafVersion, leaf.leafHash, root)
    if (controlBlock === undefined) continue
    committedLeaf = true
    if (placed < threshold) continue
    // The serialized witness size, as Core's GetSerializeSize(estimated_stack).
    const itemLengths = stack.map(sig =>
      sig === undefined ? 0 : sig.signature.signature.length + (sig.signature.hashType === SIGHASH_DEFAULT ? 0 : 1)
    )
    itemLengths.push(leaf.script.length, controlBlock.length)
    let size = compactSize(itemLengths.length).length
    for (const length of itemLengths) size += compactSize(length).length + length
    if (best === undefined || size < best.size || (size === best.size && compareBytes(leaf.script, best.script) < 0)) {
      best = { stack, script: leaf.script, controlBlock, size }
    }
  }
  return { witness: best, signedLeaf, committedLeaf }
}

/**
 * The final witness qbit Core's `FinalizePSBT` builds for a P2MR input. Every
 * P2MR signature on the input must carry the input's sighash type,
 * `SIGHASH_DEFAULT` when `PSBT_IN_SIGHASH_TYPE` is absent (psbt.cpp:530,
 * :548-568, :589-596), or the input fails with `SIGHASH_MISMATCH`, even when
 * the signature is not used. The witness is then the one
 * {@link selectP2mrWitness} chooses.
 */
function p2mrFinalWitness(input: PsbtInputSummary, inputIndex: number): Uint8Array {
  const root = requireP2mrInputRoot(input, inputIndex)
  const requiredHashType = input.sighashType ?? SIGHASH_DEFAULT
  for (const sig of input.scriptSigs) {
    if (sig.signature.hashType !== requiredHashType) {
      const required =
        input.sighashType === undefined
          ? 'SIGHASH_DEFAULT implied by the absent PSBT_IN_SIGHASH_TYPE field'
          : `PSBT_IN_SIGHASH_TYPE ${formatSighashType(input.sighashType)}`
      throw new QbitProtocolError(
        'INVALID_SIGHASH',
        `input ${inputIndex}: P2MR signature sighash type ${formatSighashType(sig.signature.hashType)} ` +
          `does not match the input's ${required}`
      )
    }
  }
  if (input.scriptSigs.length === 0) {
    throw new QbitProtocolError('INVALID_PSBT', `input ${inputIndex}: no P2MR script signature to finalize`)
  }

  const { witness, signedLeaf, committedLeaf } = selectP2mrWitness(input, input.scriptSigs, root)
  if (witness === undefined) {
    if (!signedLeaf) {
      throw new QbitProtocolError(
        'INVALID_PSBT',
        `input ${inputIndex}: no P2MR script signature is for a key of a v1 pk or multi_a leaf script on the input`
      )
    }
    if (!committedLeaf) {
      throw new QbitProtocolError(
        'INVALID_PSBT',
        `input ${inputIndex}: P2MR control block does not commit to the witness UTXO program`
      )
    }
    throw new QbitProtocolError(
      'INVALID_PSBT',
      `input ${inputIndex}: no committed P2MR leaf has enough signatures to finalize`
    )
  }
  const items = witness.stack.map(sig =>
    sig === undefined ? new Uint8Array() : encodeP2mrWitnessSignature(sig.signature.signature, sig.signature.hashType)
  )
  return serializeWitnessStack([...items, witness.script, witness.controlBlock])
}

function isFinalScriptSig(entry: PsbtKeyValue): boolean {
  return entry.key.length === 1 && entry.key[0] === PSBT_IN_FINAL_SCRIPTSIG
}

/**
 * Core treats an input with a non-empty final scriptSig (0x07) as already final
 * (psbt.cpp:345-348), so it neither signs nor finalizes it (psbt.cpp:110-119,
 * sign.cpp:1315), and a P2MR spend must have an empty scriptSig
 * (interpreter.cpp:2459-2461).
 */
function assertNoP2mrFinalScriptSig(map: readonly PsbtKeyValue[], inputIndex: number): void {
  if (map.some(entry => isFinalScriptSig(entry) && entry.value.length > 0)) {
    throw new QbitProtocolError('INVALID_PSBT', `input ${inputIndex}: a P2MR input cannot carry a final scriptSig`)
  }
}

function requireP2mrInputRoot(input: PsbtInputSummary, inputIndex: number): Uint8Array {
  const scriptPubKey = input.witnessUtxo?.scriptPubKey
  if (scriptPubKey === undefined) {
    throw new QbitProtocolError('INVALID_PSBT', `input ${inputIndex}: missing witness UTXO`)
  }
  if (
    scriptPubKey.length !== 2 + P2MR_PROGRAM_BYTES ||
    scriptPubKey[0] !== OP_2 ||
    scriptPubKey[1] !== P2MR_PROGRAM_BYTES
  ) {
    throw new QbitProtocolError('INVALID_PSBT', `input ${inputIndex}: witness UTXO is not an OP_2 PUSH32 P2MR output`)
  }

  const root = copyBytes(scriptPubKey, 2)
  if (input.merkleRoot !== undefined && !bytesEqual(input.merkleRoot, root)) {
    throw new QbitProtocolError(
      'INVALID_PSBT',
      `input ${inputIndex}: P2MR merkle root does not match the witness UTXO program`
    )
  }
  return root
}

function p2mrLeafScriptUsesPubkey(script: Uint8Array, pubkey: Uint8Array): boolean {
  let offset = 0
  let pushedValue: Uint8Array | undefined
  while (offset < script.length) {
    const opcode = script[offset++]!
    if (opcode >= 1 && opcode <= 75) {
      if (offset + opcode > script.length) return false
      pushedValue = script.subarray(offset, offset + opcode)
      offset += opcode
      continue
    }
    if (
      (opcode === OP_CHECKSIGPQC || opcode === OP_CHECKSIGADD) &&
      pushedValue !== undefined &&
      bytesEqual(pushedValue, pubkey)
    ) {
      return true
    }
    pushedValue = undefined
  }
  return false
}

function extractSpentOutputs(psbt: Psbt): P2mrSpentOutput[] {
  return psbt.inputs.map((map, index) => {
    const entry = map.find(item => item.key.length === 1 && item.key[0] === PSBT_IN_WITNESS_UTXO)
    if (entry === undefined) {
      throw new QbitProtocolError('INVALID_PSBT', `input ${index} is missing a witness UTXO`)
    }
    return parseTxOut(entry.value, `input ${index} witness UTXO value`)
  })
}

/**
 * Whether an input-map entry is a field Core drops once the input is finalized,
 * so `finalizeP2mrPsbt` drops it too. Core writes these fields only while the
 * input has no final scriptSig or scriptWitness (psbt.h:342-501): partial
 * signatures (0x02), sighash type (0x03), redeem and witness scripts (0x04,
 * 0x05), BIP32 derivations (0x06), hash preimages (0x0a-0x0d), the Taproot,
 * P2MR and MuSig2 fields (0x13-0x1d), and the `qbit` proprietary P2MR merkle
 * root, leaf script and script sig (subtypes 1-3). Core keeps every other field
 * on a finalized input: the UTXOs (0x00, 0x01; psbt.h:331-340), the final
 * scriptSig and scriptWitness (0x07, 0x08; psbt.h:503-512), other proprietary
 * records, including unknown `qbit` subtypes, and unknown key types
 * (psbt.h:514-524).
 */
function isCoreNonFinalInputField(entry: PsbtKeyValue): boolean {
  const keyType = entry.key[0]
  if (keyType === undefined) return false
  if (keyType === PSBT_IN_PROPRIETARY) {
    const proprietary = parseProprietaryKey(entry.key)
    return (
      bytesEqual(proprietary.identifier, asciiBytes(PSBT_QBIT_IDENTIFIER)) &&
      proprietary.subtype >= PSBT_QBIT_IN_P2MR_MERKLE_ROOT &&
      proprietary.subtype <= PSBT_QBIT_IN_P2MR_SCRIPT_SIG
    )
  }
  return (
    (keyType >= 0x02 && keyType <= 0x06) || (keyType >= 0x0a && keyType <= 0x0d) || (keyType >= 0x13 && keyType <= 0x1d)
  )
}

function proprietaryKeyBytes(field: EncodedQbitProprietaryP2mrField): Uint8Array {
  return concatBytes(
    Uint8Array.of(PSBT_IN_PROPRIETARY),
    serializeVarBytes(asciiBytes(field.identifier), 'proprietary identifier'),
    compactSize(field.subtype),
    field.keyData
  )
}

function compareBytes(a: Uint8Array, b: Uint8Array): number {
  const length = Math.min(a.length, b.length)
  for (let i = 0; i < length; i += 1) {
    const av = a[i]!
    const bv = b[i]!
    if (av !== bv) return av - bv
  }
  return a.length - b.length
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isCanonicalHex(value: unknown, byteLength: number): value is string {
  return typeof value === 'string' && value.length === byteLength * 2 && /^[0-9a-f]+$/.test(value)
}

function isCanonicalControlBlockHex(value: unknown): value is string {
  if (typeof value !== 'string' || !/^[0-9a-f]+$/.test(value) || value.length % 2 !== 0) {
    return false
  }
  const byteLength = value.length / 2
  return (
    byteLength >= P2MR_CONTROL_BASE_BYTES &&
    byteLength <= P2MR_CONTROL_BASE_BYTES + P2MR_CONTROL_NODE_BYTES * P2MR_CONTROL_MAX_NODE_COUNT &&
    (byteLength - P2MR_CONTROL_BASE_BYTES) % P2MR_CONTROL_NODE_BYTES === 0
  )
}

function assertUint8(value: number, name: string): void {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > 0xff) {
    throw new QbitProtocolError('INVALID_INTEGER', `${name} ${String(value)} must be an integer in [0, 255]`)
  }
}

/** The intrinsic `%TypedArray%.prototype[Symbol.toStringTag]` getter. */
const typedArrayTag = Object.getOwnPropertyDescriptor(
  Object.getPrototypeOf(Uint8Array.prototype) as object,
  Symbol.toStringTag
)!.get!

/**
 * Realm-independent `Uint8Array` check; a Node `Buffer`, a subarray and a
 * subclass pass. `instanceof` fails for bytes created in another realm (vm
 * context, iframe, worker), and rejecting a signer's signature for that would
 * waste a key use that was already spent. The intrinsic getter reads the
 * typed array's internal element type, so it returns `undefined` for anything
 * that is not a typed array (a `DataView`, a plain object claiming the tag)
 * and `'Uint16Array'` for a `Uint16Array` whose own `Symbol.toStringTag` was
 * redefined. It runs per input and per output on the signing path, and costs
 * a fraction of `Object.prototype.toString`.
 */
function isUint8Array(value: unknown): value is Uint8Array {
  return typedArrayTag.call(value) === 'Uint8Array'
}

/**
 * A caller's byte input must be a real `Uint8Array`. Strings, arrays and other
 * views have a `length` too: a string is copied or hashed as different bytes
 * (zeros; hex-encoded, every character gave `00` except a decimal digit `d`,
 * which gave `0d`), an element above 255 is truncated, and arrays of byte
 * values only happened to work. Callers wrap those with `Uint8Array.from(...)`.
 */
function assertBytes(bytes: unknown, name: string): asserts bytes is Uint8Array {
  if (!isUint8Array(bytes)) {
    throw new QbitProtocolError('INVALID_BYTES', `${name} must be a Uint8Array`)
  }
}

function assertByteLength(bytes: unknown, expected: number, name: string): asserts bytes is Uint8Array {
  assertBytes(bytes, name)
  if (bytes.length !== expected) {
    throw new QbitProtocolError('INVALID_BYTES', `${name} must be ${expected} bytes`)
  }
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

function asciiBytes(value: string): Uint8Array {
  return textEncoder.encode(value)
}

// A QBT decimal with at most 8 fractional digits and at most QBIT_MAX_MONEY, which
// Core's amount field enforces (bitcoinamountfield.cpp:171). The whole part has at
// most 10 digits, as in QbitUnits::parse (qbitunits.cpp:193-196), so BigInt only
// ever reads a short string. Compared in base units, so nothing wraps or rounds.
function isValidQbtAmount(amount: string): boolean {
  const match = /^(0|[1-9][0-9]{0,9})(?:\.([0-9]{1,8}))?$/.exec(amount)
  return match !== null && BigInt(match[1]! + (match[2] ?? '').padEnd(8, '0')) <= QBIT_MAX_MONEY
}

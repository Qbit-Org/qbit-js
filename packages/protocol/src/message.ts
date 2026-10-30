import { QbitProtocolError } from './errors'
import type { QbitNetworkName, QbitNetworkParams } from './networks'
import {
  P2MR_PROGRAM_BYTES,
  P2MR_LEAF_VERSION_V1,
  P2MR_CONTROL_BASE_BYTES,
  P2MR_CONTROL_NODE_BYTES,
  P2MR_CONTROL_MAX_NODE_COUNT,
  PQC_SIGNATURE_BYTES,
} from './constants'
import {
  textEncoder,
  bytesToHex,
  hexToBytes,
  taggedHash,
  compareBytes,
  isRecord,
  isCanonicalHex,
  assertBytes,
  assertByteLength,
} from './bytes'
import { decodeP2mrAddress, canonicalP2mrAddress, type p2mrAddressFromPubkey } from './addresses'
import { singleKeyLeafScript, p2mrLeafHash, buildControlBlock, verifyControlBlock } from './scripts'

/**
 * Tag of the tagged SHA-256 that {@link qbitWalletMessageHash} applies to a
 * wallet message's UTF-8 bytes.
 *
 * @category Message proofs
 */
export const QBIT_WALLET_MESSAGE_DOMAIN = 'QbitWalletSignedMessage'
/**
 * Tag of the tagged SHA-256 that {@link qbitDataSigPqcHash} applies to a
 * wallet message hash. Its result is the digest a message proof's PQC
 * signature signs.
 *
 * @category Message proofs
 */
export const QBIT_DATA_SIG_PQC_DOMAIN = 'QbitDataSigPQC'
/**
 * The `type` of every {@link P2mrMessageProof}.
 *
 * @category Message proofs
 */
export const P2MR_MESSAGE_PROOF_TYPE = 'p2mr-message'
/**
 * The `version` of every {@link P2mrMessageProof}. No other version verifies.
 *
 * @category Message proofs
 */
export const P2MR_MESSAGE_PROOF_VERSION = 1
/**
 * The `proof_mode` of every {@link P2mrMessageProof}: a signature by the key
 * of a single-key P2MR leaf.
 *
 * @category Message proofs
 */
export const P2MR_MESSAGE_PROOF_MODE = 'p2mr-pubkey'
/**
 * The `algorithm` of every {@link P2mrMessageProof}: the PQC signature scheme.
 *
 * @category Message proofs
 */
export const P2MR_MESSAGE_ALGORITHM = 'SLH-DSA-SHA2-128s-bounded30'

/**
 * A structured P2MR wallet message proof: a PQC signature over a message by the
 * key of a single-key P2MR leaf, with the leaf and control block that tie the
 * key to an address. Byte fields are lowercase hex. Create one with
 * {@link createP2mrMessageProof} and check one with
 * {@link verifyP2mrMessageProof}.
 *
 * @remarks
 * See [Message proofs](https://github.com/Qbit-Org/qbit-js/blob/main/packages/protocol/docs/message-proofs.md).
 *
 * @category Message proofs
 */
export interface P2mrMessageProof {
  /** Always {@link P2MR_MESSAGE_PROOF_TYPE}. */
  type: typeof P2MR_MESSAGE_PROOF_TYPE
  /** Always {@link P2MR_MESSAGE_PROOF_VERSION}. */
  version: typeof P2MR_MESSAGE_PROOF_VERSION
  /**
   * The P2MR address the proof claims, in its canonical lowercase spelling.
   * Attacker-controlled until verified against an expected address or network.
   */
  address: string
  /** {@link qbitWalletMessageHash} of the message (32 bytes). */
  message_hash: string
  /** {@link qbitDataSigPqcHash} of the message hash (32 bytes): the digest that was signed. */
  datasig_hash: string
  /** Always {@link QBIT_DATA_SIG_PQC_DOMAIN}. */
  domain: typeof QBIT_DATA_SIG_PQC_DOMAIN
  /** Always {@link QBIT_WALLET_MESSAGE_DOMAIN}. */
  message_domain: typeof QBIT_WALLET_MESSAGE_DOMAIN
  /** Always {@link P2MR_MESSAGE_ALGORITHM}. */
  algorithm: typeof P2MR_MESSAGE_ALGORITHM
  /** Always {@link P2MR_MESSAGE_PROOF_MODE}. */
  proof_mode: typeof P2MR_MESSAGE_PROOF_MODE
  /** The signing key's 32-byte public key. */
  pubkey: string
  /** The 3680-byte PQC signature over `datasig_hash`. */
  signature: string
  /** The leaf version, {@link P2MR_LEAF_VERSION_V1} (`0xc0`). */
  leaf_version: number
  /** `pubkey`'s 34-byte single-key leaf script ({@link singleKeyLeafScript}). */
  leaf_script: string
  /** A control block that commits the leaf to `p2mr_merkle_root`. */
  control_block: string
  /** The 32-byte Merkle root the control block commits to, which is `address`'s witness program. */
  p2mr_merkle_root: string
}

/**
 * Input to {@link createP2mrMessageProof}.
 *
 * @category Message proofs
 */
export interface CreateP2mrMessageProofParams {
  /** The message. It must be well-formed UTF-16, with no lone surrogate. */
  message: string
  /** The P2MR address the proof is for, on any qbit network, in either case. */
  address: string
  /** The signing key's 32-byte public key. */
  pubkey: Uint8Array
  /**
   * The 3680-byte PQC signature by `pubkey` over
   * `qbitDataSigPqcHash(qbitWalletMessageHash(message))`. It is not verified
   * here.
   */
  signature: Uint8Array
  /** The leaf version. Default {@link P2MR_LEAF_VERSION_V1}, the only one accepted. */
  leafVersion?: number
  /** The leaf script. Default `singleKeyLeafScript(pubkey)`, the only one accepted. */
  leafScript?: Uint8Array
  /**
   * A control block that commits the leaf to `address`'s witness program.
   * Default `buildControlBlock(leafVersion)`, which commits only when the leaf
   * is the tree's single leaf, as for {@link p2mrAddressFromPubkey}.
   */
  controlBlock?: Uint8Array
}

/**
 * PQC signature verifier for {@link verifyP2mrMessageProof}. It is called with
 * the proof's 32-byte public key, the 32-byte digest `datasig_hash` and the
 * 3680-byte signature, and must return `true`, synchronously, only for a valid
 * signature.
 *
 * @remarks
 * Only `true` counts: any other return value, including a promise or another
 * truthy value, and a thrown error make the proof fail verification.
 *
 * @category Message proofs
 */
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
 *
 * @remarks
 * See [Message proofs](https://github.com/Qbit-Org/qbit-js/blob/main/packages/protocol/docs/message-proofs.md).
 *
 * @category Message proofs
 */
export type VerifyP2mrMessageProofOptions =
  | {
      /** The address the proof must be for. */
      expectedAddress: string
      /** The network the proof's address must belong to. */
      expectedNetwork?: QbitNetworkName | QbitNetworkParams
    }
  | {
      /** The address the proof must be for. */
      expectedAddress?: string
      /** The network the proof's address must belong to. */
      expectedNetwork: QbitNetworkName | QbitNetworkParams
    }

/**
 * Hash a wallet message as strict UTF-8 under the Qbit wallet message domain.
 *
 * The message must be well-formed UTF-16. A lone surrogate throws
 * `QbitProtocolError('INVALID_BYTES')` rather than being encoded as U+FFFD, so
 * two distinct strings never share a hash. Core only signs the resulting
 * 32-byte hash; this text-to-hash step is the SDK's own domain
 * (qbit Core v1.0.0 doc/design/p2mr-datapqchash.md:25-28).
 *
 * @param message - The message text.
 * @returns The 32-byte tagged SHA-256, tag {@link QBIT_WALLET_MESSAGE_DOMAIN},
 * of the message's UTF-8 bytes.
 * @throws {TypeError} if `message` is not a string.
 * @throws {QbitProtocolError} `INVALID_BYTES` if `message` has a lone
 * surrogate.
 *
 * @remarks
 * See [Message proofs](https://github.com/Qbit-Org/qbit-js/blob/main/packages/protocol/docs/message-proofs.md).
 *
 * @category Message proofs
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

/**
 * Wrap a 32-byte wallet message hash in qbit's PQC data-signature domain.
 *
 * @param messageHash - A 32-byte hash, normally from
 * {@link qbitWalletMessageHash}.
 * @returns The 32-byte tagged SHA-256, tag {@link QBIT_DATA_SIG_PQC_DOMAIN}, of
 * `messageHash`: the digest a message proof's PQC signature signs.
 * @throws {QbitProtocolError} `INVALID_BYTES` if `messageHash` is not a 32-byte
 * `Uint8Array`.
 *
 * @remarks
 * See [Message proofs](https://github.com/Qbit-Org/qbit-js/blob/main/packages/protocol/docs/message-proofs.md).
 *
 * @category Message proofs
 */
export function qbitDataSigPqcHash(messageHash: Uint8Array): Uint8Array {
  assertByteLength(messageHash, 32, 'Qbit wallet message hash')
  return taggedHash(QBIT_DATA_SIG_PQC_DOMAIN, messageHash)
}

/**
 * Construct a structured wallet-level data-hash proof for a P2MR message signature.
 * The caller supplies signature bytes; private-key operations deliberately live
 * outside this protocol package.
 *
 * `pubkey`, `signature`, `leafScript` and `controlBlock` must each be a
 * `Uint8Array` (a Node `Buffer` or one from another realm passes). A string,
 * array or other view throws `INVALID_BYTES`, whatever its length.
 *
 * @param params - The message, address, key, signature and, for a key that is
 * not the address's only leaf, the control block.
 * @returns The proof, with the address in its canonical lowercase spelling.
 * The signature is not verified.
 * @throws {TypeError} if `message` is not a string.
 * @throws {QbitProtocolError} `INVALID_BYTES` for a byte field that is not a
 * `Uint8Array`, a `pubkey` that is not 32 bytes or a `signature` that is not
 * 3680 bytes, or a `message` with a lone surrogate.
 * @throws {QbitProtocolError} `INVALID_SCRIPT` for a `leafVersion` other than
 * `0xc0`, a `leafScript` other than `pubkey`'s single-key script, or a control
 * block that is malformed or does not commit the leaf to `address`.
 * @throws {RangeError} if `leafVersion` is not an integer from 0 to 255 and
 * `controlBlock` is omitted.
 * @throws {QbitProtocolError} Any code {@link decodeP2mrAddress} throws for
 * `address`.
 *
 * @remarks
 * See [Message proofs](https://github.com/Qbit-Org/qbit-js/blob/main/packages/protocol/docs/message-proofs.md).
 *
 * @category Message proofs
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
 * @param message - The message the proof should sign.
 * @param proof - The untrusted proof, such as parsed JSON. Any value is
 * accepted; one that is not a well-formed {@link P2mrMessageProof} returns
 * `false`.
 * @param verifyPqc - The PQC signature verifier; see {@link P2mrPqcVerifyFn}.
 * @param options - The address and/or network the proof must be bound to.
 * @returns `true` only if the proof is well formed, commits to `message`,
 * binds `pubkey` to `proof.address`, matches `options`, and `verifyPqc`
 * returns `true`.
 * @throws {TypeError} if `options` is missing, `null` or not an object, or sets
 * neither `expectedAddress` nor `expectedNetwork`. This is a programming error,
 * not an invalid proof, so it is never reported as `false`.
 *
 * @remarks
 * See [Message proofs](https://github.com/Qbit-Org/qbit-js/blob/main/packages/protocol/docs/message-proofs.md).
 *
 * @example
 * ```ts
 * import { verifyP2mrMessageProof } from '@qbit-oss/protocol'
 *
 * // proofJson: the proof as the user submitted it
 * // verifyPqc: (pubkey, digest, signature) => boolean, from your PQC library
 * // storedAddress: the address this user registered
 * const ok = verifyP2mrMessageProof('Sign in to example.com', JSON.parse(proofJson), verifyPqc, {
 *   expectedAddress: storedAddress,
 * })
 * if (!ok) throw new Error('message proof rejected')
 * ```
 *
 * @category Message proofs
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

import { QbitProtocolError } from './errors'
import {
  P2MR_PROGRAM_BYTES,
  P2MR_LEAF_VERSION_V1,
  PQC_SIGNATURE_BYTES,
  SIGHASH_DEFAULT,
  PSBT_IN_P2MR_SCRIPT_SIG,
  PSBT_IN_P2MR_LEAF_SCRIPT,
  PSBT_QBIT_IDENTIFIER,
  PSBT_QBIT_IN_P2MR_MERKLE_ROOT,
  PSBT_QBIT_IN_P2MR_LEAF_SCRIPT,
  PSBT_QBIT_IN_P2MR_SCRIPT_SIG,
} from './constants'
import { copyBytes, concatBytes, assertBytes, assertByteLength } from './bytes'
import { assertLeafVersion, assertP2mrControlBlockShape } from './scripts'
import { isValidP2mrSighashType } from './sighash'

/**
 * A decoded P2MR witness signature item.
 *
 * @remarks
 * See [P2MR Signature Hash](https://github.com/Qbit-Org/qbit-js/blob/main/packages/protocol/docs/p2mr-sighash.md).
 *
 * @category Encoding
 */
export interface P2mrWitnessSignature {
  /** The 3680-byte PQC signature. */
  signature: Uint8Array
  /** The sighash type: the explicit type byte, or `SIGHASH_DEFAULT` when there is none. */
  hashType: number
  /** Whether the item has an explicit type byte, which makes it 3681 bytes. */
  explicitHashType: boolean
}

/**
 * A decoded P2MR script-signature record: PSBT input key type `0x19`, or
 * `qbit` proprietary subtype `0x03`.
 *
 * @category Encoding
 */
export interface P2mrPsbtScriptSigField {
  /** Record kind. */
  type: 'p2mrScriptSig'
  /** The signing key's 32-byte public key. */
  pubkey: Uint8Array
  /** The 32-byte hash of the leaf the signature is for. */
  leafHash: Uint8Array
  /** The decoded witness signature item. */
  signature: P2mrWitnessSignature
}

/**
 * A decoded P2MR leaf-script record: PSBT input key type `0x1d`, or `qbit`
 * proprietary subtype `0x02`.
 *
 * @category Encoding
 */
export interface P2mrPsbtLeafScriptField {
  /** Record kind. */
  type: 'p2mrLeafScript'
  /** The control block from the record's key. Its shape is checked, not what it commits to. */
  controlBlock: Uint8Array
  /** The leaf script. */
  script: Uint8Array
  /** The leaf version, the value's last byte. */
  leafVersion: number
}

/**
 * A decoded `qbit` proprietary P2MR Merkle-root record (subtype `0x01`).
 *
 * @category Encoding
 */
export interface QbitProprietaryP2mrMerkleRootField {
  /** Record kind. */
  type: 'qbitP2mrMerkleRoot'
  /** The 32-byte Merkle root of the spent output's script tree. */
  merkleRoot: Uint8Array
}

/**
 * A decoded `qbit` proprietary P2MR input record, as
 * {@link decodeQbitProprietaryP2mrInputField} returns it.
 *
 * @category Encoding
 */
export type QbitProprietaryP2mrField =
  QbitProprietaryP2mrMerkleRootField | P2mrPsbtLeafScriptField | P2mrPsbtScriptSigField

/**
 * A `qbit` proprietary P2MR input record to write into a PSBT input map. Its
 * key is `0xfc`, the identifier's length `0x04`, the identifier `qbit`, the
 * subtype as a compact size (one byte for subtypes 1 to 3), then `keyData`.
 *
 * @category Encoding
 */
export interface EncodedQbitProprietaryP2mrField {
  /** Always {@link PSBT_QBIT_IDENTIFIER}. */
  identifier: typeof PSBT_QBIT_IDENTIFIER
  /** `PSBT_QBIT_IN_P2MR_MERKLE_ROOT`, `PSBT_QBIT_IN_P2MR_LEAF_SCRIPT` or `PSBT_QBIT_IN_P2MR_SCRIPT_SIG`. */
  subtype: number
  /** The key data after the subtype. */
  keyData: Uint8Array
  /** The record's value. */
  value: Uint8Array
}

/**
 * Encode a P2MR witness signature item: the 3680-byte signature, followed by
 * `hashType` unless it is `SIGHASH_DEFAULT`. `signature` must be a `Uint8Array`
 * (a Node `Buffer` or one from another realm passes); a string, array or other
 * view throws `INVALID_BYTES`, whatever its length.
 *
 * @param signature - The 3680-byte PQC signature.
 * @param hashType - The sighash type. Default `SIGHASH_DEFAULT`.
 * @returns A new array: the 3680-byte signature for `SIGHASH_DEFAULT`, or 3681
 * bytes with the type byte appended.
 * @throws {QbitProtocolError} `INVALID_BYTES` if `signature` is not a 3680-byte
 * `Uint8Array`, or `INVALID_SCRIPT` if `hashType` is not a valid P2MR sighash
 * type.
 *
 * @remarks
 * See [P2MR Signature Hash](https://github.com/Qbit-Org/qbit-js/blob/main/packages/protocol/docs/p2mr-sighash.md).
 *
 * @category Encoding
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
 *
 * @param value - The witness signature item: 3680 bytes, or 3681 with a type
 * byte.
 * @returns The signature (a copy) and its sighash type.
 * @throws {QbitProtocolError} `INVALID_BYTES` if `value` is not a `Uint8Array`.
 * @throws {QbitProtocolError} `INVALID_SCRIPT` if `value` is not 3680 or 3681
 * bytes, or its type byte is `0x00` or not a valid P2MR sighash type.
 *
 * @remarks
 * See [P2MR Signature Hash](https://github.com/Qbit-Org/qbit-js/blob/main/packages/protocol/docs/p2mr-sighash.md).
 *
 * @category Encoding
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

/**
 * Encode a PSBT_IN_P2MR_SCRIPT_SIG (0x19) record keyed by (pubkey, leafHash).
 * Every byte argument must be a `Uint8Array` of the right length (a Node
 * `Buffer` or one from another realm passes); anything else throws
 * `INVALID_BYTES`.
 *
 * @param pubkey - The signing key's 32-byte public key.
 * @param leafHash - The 32-byte hash of the leaf the signature is for.
 * @param signature - The 3680-byte PQC signature.
 * @param hashType - The sighash type. Default `SIGHASH_DEFAULT`.
 * @returns The record's key and value.
 * @throws {QbitProtocolError} `INVALID_BYTES` if `pubkey` or `leafHash` is not
 * a 32-byte `Uint8Array` or `signature` is not a 3680-byte one, or
 * `INVALID_SCRIPT` if `hashType` is not a valid P2MR sighash type.
 *
 * @category Encoding
 */
export function encodeP2mrPsbtScriptSigField(
  pubkey: Uint8Array,
  leafHash: Uint8Array,
  signature: Uint8Array,
  hashType: number = SIGHASH_DEFAULT
): {
  /** `0x19`, the public key and the leaf hash: 65 bytes. */
  key: Uint8Array
  /** The witness signature item, as {@link encodeP2mrWitnessSignature} encodes it. */
  value: Uint8Array
} {
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
 *
 * @param key - The record's key: `0x19`, a 32-byte public key and a 32-byte
 * leaf hash.
 * @param value - The record's value, a witness signature item.
 * @returns The decoded record; its byte fields are copies.
 * @throws {QbitProtocolError} `INVALID_BYTES` if `key` or `value` is not a
 * `Uint8Array`, or `INVALID_PSBT` if `key` does not have that shape.
 * @throws {QbitProtocolError} `INVALID_SCRIPT` if `value` is not a valid
 * witness signature item (see {@link decodeP2mrWitnessSignature}).
 *
 * @category Encoding
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

/**
 * Encode a PSBT_IN_P2MR_LEAF_SCRIPT (0x1d) record, keyed by the leaf's
 * control block.
 *
 * @param controlBlock - The leaf's control block. Its shape is checked; its
 * leaf version is not compared with `leafVersion`.
 * @param script - The leaf script.
 * @param leafVersion - The leaf version. Default {@link P2MR_LEAF_VERSION_V1}.
 * @returns The record's key and value.
 * @throws {QbitProtocolError} `INVALID_BYTES` if `controlBlock` or `script` is
 * not a `Uint8Array`.
 * @throws {QbitProtocolError} `INVALID_PSBT` if the control block has the
 * wrong length or a clear low bit in its first byte.
 * @throws {RangeError} if `leafVersion` is not an integer from 0 to 255.
 * @throws {QbitProtocolError} `INVALID_SCRIPT` if `leafVersion` is odd.
 *
 * @category Encoding
 */
export function encodeP2mrPsbtLeafScriptField(
  controlBlock: Uint8Array,
  script: Uint8Array,
  leafVersion: number = P2MR_LEAF_VERSION_V1
): {
  /** `0x1d`, then the control block. */
  key: Uint8Array
  /** The leaf script, then the leaf version byte. */
  value: Uint8Array
} {
  assertP2mrControlBlockShape(controlBlock)
  assertBytes(script, 'P2MR leaf script')
  assertLeafVersion(leafVersion)
  return {
    key: concatBytes(Uint8Array.of(PSBT_IN_P2MR_LEAF_SCRIPT), controlBlock),
    value: concatBytes(script, Uint8Array.of(leafVersion)),
  }
}

/**
 * Decode a PSBT_IN_P2MR_LEAF_SCRIPT (0x1d) record.
 *
 * @param key - The record's key: `0x1d`, then the control block.
 * @param value - The record's value: the leaf script, then its leaf version
 * byte.
 * @returns The decoded record; its byte fields are copies.
 * @throws {QbitProtocolError} `INVALID_PSBT` if `key` does not start with
 * `0x1d`, the control block has the wrong length or a clear low bit in its
 * first byte, or `value` is empty.
 * @throws {QbitProtocolError} `INVALID_SCRIPT` if the leaf version is odd.
 *
 * @remarks
 * Unlike the other record decoders, it does not check that `key` and `value`
 * are `Uint8Array`s, so pass only `Uint8Array`s.
 *
 * @category Encoding
 */
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
 *
 * @param subtype - The record's subtype: `0x01` Merkle root, `0x02` leaf
 * script or `0x03` script signature.
 * @param keyData - The key data after the subtype: empty for `0x01`, the
 * control block for `0x02`, the public key and leaf hash for `0x03`.
 * @param value - The record's value: the 32-byte root for `0x01`, otherwise
 * laid out as the `0x1d` or `0x19` record's value.
 * @returns The decoded record. Subtypes `0x02` and `0x03` decode to the same
 * shapes as `0x1d` and `0x19` records.
 * @throws {QbitProtocolError} `INVALID_BYTES` if `keyData` is not a
 * `Uint8Array`, or a subtype `0x01` value is not a 32-byte one.
 * @throws {QbitProtocolError} `INVALID_PSBT` for another subtype, or for
 * subtype `0x01` with non-empty key data.
 * @throws {QbitProtocolError} For subtypes `0x02` and `0x03`, what
 * {@link decodeP2mrPsbtLeafScriptField} or {@link decodeP2mrPsbtScriptSigField}
 * throws for the equivalent `0x1d` or `0x19` record.
 *
 * @category Encoding
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

/**
 * Encode a `qbit` proprietary P2MR Merkle-root record (subtype `0x01`).
 *
 * @param merkleRoot - The 32-byte Merkle root of the spent output's script
 * tree.
 * @returns The record, with empty key data and a copy of `merkleRoot` as its
 * value.
 * @throws {QbitProtocolError} `INVALID_BYTES` if `merkleRoot` is not a 32-byte
 * `Uint8Array`.
 *
 * @category Encoding
 */
export function encodeQbitProprietaryP2mrMerkleRootField(merkleRoot: Uint8Array): EncodedQbitProprietaryP2mrField {
  assertByteLength(merkleRoot, P2MR_PROGRAM_BYTES, 'qbit P2MR merkle root')
  return {
    identifier: PSBT_QBIT_IDENTIFIER,
    subtype: PSBT_QBIT_IN_P2MR_MERKLE_ROOT,
    keyData: new Uint8Array(),
    value: new Uint8Array(merkleRoot),
  }
}

/**
 * Encode a `qbit` proprietary P2MR leaf-script record (subtype `0x02`), the
 * proprietary form of {@link encodeP2mrPsbtLeafScriptField}'s `0x1d` record.
 *
 * @param controlBlock - The leaf's control block, which becomes the key data.
 * @param script - The leaf script.
 * @param leafVersion - The leaf version. Default {@link P2MR_LEAF_VERSION_V1}.
 * @returns The record; its value is the script, then the leaf version byte.
 * @throws {QbitProtocolError} As {@link encodeP2mrPsbtLeafScriptField} throws:
 * `INVALID_BYTES`, `INVALID_PSBT` or `INVALID_SCRIPT`.
 * @throws {RangeError} if `leafVersion` is not an integer from 0 to 255.
 *
 * @category Encoding
 */
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

/**
 * Encode a `qbit` proprietary P2MR script-signature record (subtype `0x03`),
 * the proprietary form of {@link encodeP2mrPsbtScriptSigField}'s `0x19`
 * record.
 *
 * @param pubkey - The signing key's 32-byte public key.
 * @param leafHash - The 32-byte hash of the leaf the signature is for.
 * @param signature - The 3680-byte PQC signature.
 * @param hashType - The sighash type. Default `SIGHASH_DEFAULT`.
 * @returns The record; its key data is `pubkey` then `leafHash`, and its value
 * the witness signature item.
 * @throws {QbitProtocolError} As {@link encodeP2mrPsbtScriptSigField} throws:
 * `INVALID_BYTES` or `INVALID_SCRIPT`.
 *
 * @category Encoding
 */
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

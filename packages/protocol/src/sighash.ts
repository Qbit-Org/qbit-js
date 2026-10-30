import { sha256 } from '@noble/hashes/sha2'
import { QbitProtocolError } from './errors'
import {
  P2MR_PROGRAM_BYTES,
  SIGHASH_DEFAULT,
  SIGHASH_ALL,
  SIGHASH_SINGLE,
  SIGHASH_ANYONECANPAY,
  SIGHASH_OUTPUT_MASK,
  SIGHASH_INPUT_MASK,
} from './constants'
import { assertMoneyRange, assertUint32 } from './consensus'
import { concatByteList, isBytesOfLength, taggedHash, serializeVarBytes, assertBytes, assertByteLength } from './bytes'
import { type P2mrTransaction, uint32LE, serializeAmount, serializeOutpoint, serializeTxOut } from './transaction'

// ---------------------------------------------------------------------------
// P2MR signature hash (P2MRSighash)
//
// Byte-exact port of qbit Core's SignatureHashSchnorrCommon (SigVersion::P2MR)
// from src/script/interpreter.cpp @ Qbit-Org/qbit v1.0.0 (7ebcddb6). P2MR reuses
// the Tapscript message (ext_flag=1, key_version=0); it differs only by the
// hash tag (P2MRSighash) and the committed leaf hash (a P2MRLeaf hash). See
// docs/p2mr-sighash.md.
// ---------------------------------------------------------------------------

/**
 * Whether `hashType` is a sighash type P2MR accepts: `0x00` to `0x03`, or
 * `0x81` to `0x83`.
 *
 * @param hashType - The value to check.
 * @returns `true` for an accepted type, `false` for anything else, including a
 * non-integer.
 *
 * @remarks
 * `SIGHASH_DEFAULT` (`0x00`) is accepted here but is never written as an
 * explicit type byte. See
 * [P2MR Signature Hash](https://github.com/Qbit-Org/qbit-js/blob/main/packages/protocol/docs/p2mr-sighash.md).
 *
 * @category Sighash
 */
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
 * A previous output being spent (amount + scriptPubKey), one per input in input order.
 *
 * @category Sighash
 */
export interface P2mrSpentOutput {
  /** Amount in satoshis; must satisfy `MoneyRange` (0 ≤ value ≤ `QBIT_MAX_MONEY`). */
  value: bigint
  /** The spent output's script. */
  scriptPubKey: Uint8Array
}

/**
 * Precomputed transaction midstates — the qbit Core `PrecomputedTransactionData`
 * equivalent. Each is a single SHA-256 commitment, computed once per transaction
 * and reused across inputs.
 *
 * @remarks
 * See [P2MR Signature Hash](https://github.com/Qbit-Org/qbit-js/blob/main/packages/protocol/docs/p2mr-sighash.md).
 *
 * @category Sighash
 */
export interface SighashMidstates {
  /** SHA-256 of every input's outpoint: 32-byte txid, then uint32 LE index. */
  prevouts: Uint8Array
  /** SHA-256 of every spent output's amount, as int64 LE. */
  amounts: Uint8Array
  /** SHA-256 of every spent output's scriptPubKey, each with its compact-size length. */
  scriptPubKeys: Uint8Array
  /** SHA-256 of every input's nSequence, as uint32 LE. */
  sequences: Uint8Array
  /** SHA-256 of every serialized output: int64 LE amount, then length-prefixed scriptPubKey. */
  outputs: Uint8Array
}

/**
 * Which signature hash {@link schnorrSignatureHash} computes:
 *
 * - `'p2mr'`: qbit P2MR, tag `P2MRSighash`, committing to a P2MR leaf hash;
 * - `'tapscript'`: BIP341 script path, tag `TapSighash`, committing to a leaf
 *   hash;
 * - `'taproot'`: BIP341 key path, tag `TapSighash`, with no leaf hash.
 *
 * @remarks
 * See [P2MR Signature Hash](https://github.com/Qbit-Org/qbit-js/blob/main/packages/protocol/docs/p2mr-sighash.md).
 *
 * @category Sighash
 */
export type SchnorrSigVersion = 'taproot' | 'tapscript' | 'p2mr'

/**
 * Input to {@link schnorrSignatureHash}.
 *
 * @category Sighash
 */
export interface SchnorrSighashParams {
  /** The transaction being signed. */
  tx: P2mrTransaction
  /** Index of the input being signed. */
  inputIndex: number
  /** Previous outputs spent by each input, in input order. */
  spentOutputs: readonly P2mrSpentOutput[]
  /** Sighash type; defaults to SIGHASH_DEFAULT (0x00, ≡ ALL). */
  hashType?: number
  /** Which signature hash to compute. */
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
 *
 * @param tx - The transaction being signed.
 * @param spentOutputs - The outputs its inputs spend, one per input, in input
 * order.
 * @returns The five 32-byte midstates.
 * @throws {QbitProtocolError} `INVALID_SIGHASH` if `spentOutputs` and
 * `tx.inputs` differ in length.
 * @throws {QbitProtocolError} `INVALID_BYTES` for a txid that is not a 32-byte
 * `Uint8Array` or a script that is not a `Uint8Array`, `INVALID_AMOUNT` for an
 * amount outside `MoneyRange`, or `INVALID_INTEGER` for a `vout` or `sequence`
 * that is not a uint32.
 *
 * @remarks
 * See [P2MR Signature Hash](https://github.com/Qbit-Org/qbit-js/blob/main/packages/protocol/docs/p2mr-sighash.md).
 *
 * @category Sighash
 */
export function precomputeSighashMidstates(
  tx: P2mrTransaction,
  spentOutputs: readonly P2mrSpentOutput[]
): SighashMidstates {
  if (spentOutputs.length !== tx.inputs.length) {
    throw new QbitProtocolError('INVALID_SIGHASH', 'spentOutputs length must equal inputs length')
  }
  return {
    prevouts: sha256(concatByteList(tx.inputs.map(input => serializeOutpoint(input.prevout)))),
    amounts: sha256(
      concatByteList(spentOutputs.map((output, i) => serializeAmount(output.value, `spent output ${i} value`)))
    ),
    scriptPubKeys: sha256(
      concatByteList(
        spentOutputs.map((output, i) => serializeVarBytes(output.scriptPubKey, `spent output ${i} scriptPubKey`))
      )
    ),
    sequences: sha256(concatByteList(tx.inputs.map(input => uint32LE(input.sequence, 'sequence')))),
    outputs: sha256(concatByteList(tx.outputs.map((output, i) => serializeTxOut(output, `output ${i}`)))),
  }
}

/**
 * BIP341-style Schnorr signature hash, parameterized by signature version.
 * `p2mr` is the qbit P2MR variant; `taproot`/`tapscript` follow BIP341 and are
 * used to validate this implementation against Core's committed BIP341 vectors.
 *
 * @param params - The transaction, input, spent outputs, sighash type and
 * variant, and for `'tapscript'` and `'p2mr'` the leaf hash.
 * @returns The 32-byte signature hash.
 * @throws {QbitProtocolError} `INVALID_SIGHASH` for an `inputIndex` that is not
 * an index of `tx.inputs`, a `spentOutputs` of another length, an invalid
 * `hashType`, a missing or non-32-byte `leafHash` for `'tapscript'` or
 * `'p2mr'`, or `SIGHASH_SINGLE` without an output at `inputIndex`.
 * @throws {QbitProtocolError} `INVALID_INTEGER` for a uint32 field or
 * `keyVersion` out of range, or `INVALID_AMOUNT` for an amount outside
 * `MoneyRange`, even when `midstates` is given.
 * @throws {QbitProtocolError} `INVALID_BYTES` for a txid, script, `annex` or
 * `midstates` field that is not a `Uint8Array` of the right length.
 *
 * @remarks
 * See [P2MR Signature Hash](https://github.com/Qbit-Org/qbit-js/blob/main/packages/protocol/docs/p2mr-sighash.md).
 *
 * @category Sighash
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
  return taggedHash(tag, concatByteList(parts))
}

/**
 * Input to {@link p2mrSighash}.
 *
 * @category Sighash
 */
export interface P2mrSighashParams {
  /** The transaction being signed. */
  tx: P2mrTransaction
  /** Index of the input being signed. */
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
 * Core `SignatureHashP2MR`. See
 * [P2MR Signature Hash](https://github.com/Qbit-Org/qbit-js/blob/main/packages/protocol/docs/p2mr-sighash.md).
 * Every txid, output and spent-output `scriptPubKey` and the `annex` must be
 * a `Uint8Array`, even when `midstates` is given, and each `midstates` field
 * a 32-byte one; anything else throws `INVALID_BYTES` instead of returning a
 * digest over different bytes.
 *
 * @param params - The transaction, input index, spent outputs and leaf hash,
 * and optionally the sighash type, code-separator position, annex and cached
 * midstates.
 * @returns The 32-byte digest the input's PQC signature signs.
 * @throws {QbitProtocolError} `INVALID_SIGHASH`, `INVALID_INTEGER`,
 * `INVALID_AMOUNT` or `INVALID_BYTES`, as {@link schnorrSignatureHash} throws
 * them.
 *
 * @remarks
 * See [P2MR Signature Hash](https://github.com/Qbit-Org/qbit-js/blob/main/packages/protocol/docs/p2mr-sighash.md).
 *
 * @category Sighash
 */
export function p2mrSighash(params: P2mrSighashParams): Uint8Array {
  return schnorrSignatureHash({ ...params, sigVersion: 'p2mr' })
}

function formatSighashType(hashType: number): string {
  return `0x${hashType.toString(16).padStart(2, '0')}`
}

function assertUint8(value: number, name: string): void {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > 0xff) {
    throw new QbitProtocolError('INVALID_INTEGER', `${name} ${String(value)} must be an integer in [0, 255]`)
  }
}

export { formatSighashType }

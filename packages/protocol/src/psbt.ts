import { sha256 } from '@noble/hashes/sha2'
import { QbitProtocolError } from './errors'
import {
  P2MR_PROGRAM_BYTES,
  P2MR_LEAF_VERSION_MASK,
  P2MR_LEAF_VERSION_V1,
  PSBT_GLOBAL_UNSIGNED_TX,
  PSBT_IN_WITNESS_UTXO,
  PSBT_IN_SIGHASH_TYPE,
  PSBT_IN_FINAL_SCRIPTWITNESS,
  PSBT_IN_P2MR_SCRIPT_SIG,
  PSBT_IN_P2MR_LEAF_SCRIPT,
  PSBT_IN_PROPRIETARY,
  PSBT_QBIT_IDENTIFIER,
  PSBT_QBIT_IN_P2MR_MERKLE_ROOT,
  PSBT_QBIT_IN_P2MR_LEAF_SCRIPT,
  PSBT_QBIT_IN_P2MR_SCRIPT_SIG,
} from './constants'
import { assertMoneyRange, assertRestrictedOutputModeOutputs } from './consensus'
import {
  bytesToHex,
  concatByteList,
  compactSize,
  copyBytes,
  concatBytes,
  serializeVarBytes,
  ByteReader,
  bytesEqual,
  compareBytes,
  isUint8Array,
  asciiBytes,
} from './bytes'
import { assertP2mrControlBlockShape } from './scripts'
import {
  type P2mrOutpoint,
  type P2mrTransactionInput,
  type P2mrTransactionOutput,
  type P2mrTransaction,
  uint32LE,
  serializeTxOut,
  serializeUnsignedTransaction,
  serializeWitnessTransaction,
} from './transaction'
import { isValidP2mrSighashType, formatSighashType } from './sighash'
import {
  type P2mrPsbtScriptSigField,
  type P2mrPsbtLeafScriptField,
  type EncodedQbitProprietaryP2mrField,
  decodeP2mrPsbtScriptSigField,
  encodeP2mrPsbtLeafScriptField,
  decodeP2mrPsbtLeafScriptField,
  decodeQbitProprietaryP2mrInputField,
  encodeQbitProprietaryP2mrMerkleRootField,
} from './psbt-fields'

/**
 * Default `maxBytes` (see `PsbtLimitOptions`): 16 MiB. qbit has no witness
 * discount, so no transaction can exceed qbit Core v1.0.0's MAX_BLOCK_WEIGHT of
 * 2,000,000 bytes (src/consensus/consensus.h:15, :22), and a standard one stays
 * under MAX_STANDARD_TX_WEIGHT = 400,000 bytes, about 100 single-key P2MR
 * inputs of 3,763 bytes each (src/policy/policy.h:34-37,
 * src/script/p2mr_sizing.h:31-41). A PSBT adds a witness UTXO and leaf script
 * per input, so 16 MiB is 8x a block-sized transaction, leaving room for extra
 * signatures, unknown fields and non-witness UTXOs.
 *
 * @remarks
 * See [Untrusted PSBT input](https://github.com/Qbit-Org/qbit-js/blob/main/packages/protocol/docs/untrusted-psbt.md).
 *
 * @category PSBT
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
 *
 * @remarks
 * See [Untrusted PSBT input](https://github.com/Qbit-Org/qbit-js/blob/main/packages/protocol/docs/untrusted-psbt.md).
 *
 * @category PSBT
 */
export const PSBT_DEFAULT_MAX_OBJECTS = 131_072

// ---------------------------------------------------------------------------
// PSBT container (BIP174 v0, qbit-aware)
//
// A qbit-aware PSBT codec. Generic Bitcoin PSBT tooling silently drops qbit's
// P2MR fields (0x19 / 0x1d / the "qbit" proprietary namespace); this container
// preserves every field, including unknown ones, byte-for-byte.
// ---------------------------------------------------------------------------

/**
 * One key/value record in a PSBT map. `key` includes the leading key type byte.
 *
 * @category PSBT
 */
export interface PsbtKeyValue {
  /** The whole key, starting with its key type. An empty key is invalid. */
  key: Uint8Array
  /** The value. */
  value: Uint8Array
}

/**
 * A parsed PSBT, with each map preserved as an ordered key/value list.
 *
 * @remarks
 * A `Psbt` is a plain object that can be built or edited without
 * {@link parsePsbt}; {@link decodePsbt}, the signing helpers and
 * {@link finalizeP2mrPsbt} check that its maps have the shape `parsePsbt`
 * guarantees. See
 * [Byte inputs and outputs](https://github.com/Qbit-Org/qbit-js/blob/main/packages/protocol/docs/byte-inputs.md).
 *
 * @category PSBT
 */
export interface Psbt {
  /** The global map, which holds the unsigned transaction (`0x00`). */
  global: PsbtKeyValue[]
  /** One map per unsigned-transaction input, in input order. */
  inputs: PsbtKeyValue[][]
  /** One map per unsigned-transaction output, in output order. */
  outputs: PsbtKeyValue[][]
}

/**
 * Resource limits for decoding untrusted PSBT bytes.
 *
 * @remarks
 * See [Untrusted PSBT input](https://github.com/Qbit-Org/qbit-js/blob/main/packages/protocol/docs/untrusted-psbt.md).
 *
 * @category PSBT
 */
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

/**
 * One input of a {@link PsbtSummary}.
 *
 * @category PSBT
 */
export interface PsbtInputSummary {
  /** The output the input spends, from the unsigned transaction. */
  prevout: P2mrOutpoint
  /** The input's nSequence, from the unsigned transaction. */
  sequence: number
  /** The decoded witness UTXO (`0x01`): the spent output's amount and script, when present. */
  witnessUtxo?: P2mrTransactionOutput
  /**
   * `PSBT_IN_SIGHASH_TYPE` (0x03) when present: the sighash type the PSBT
   * creator requires every signature on this input to use. Anything other than
   * `SIGHASH_DEFAULT` must be surfaced by an approval UI before signing.
   */
  sighashType?: number
  /** The `qbit` proprietary P2MR Merkle root (subtype `0x01`), when present. */
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
  /** Whether the input has a final script witness (`0x08`). */
  finalized: boolean
}

/**
 * A summary of a PSBT for approval and inspection UIs, as {@link decodePsbt}
 * returns it.
 *
 * @category PSBT
 */
export interface PsbtSummary {
  /** The unsigned transaction's nVersion. */
  version: number
  /** The unsigned transaction's nLockTime. */
  locktime: number
  /** One summary per input, in input order. */
  inputs: PsbtInputSummary[]
  /** The unsigned transaction's outputs. */
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
 *
 * @param bytes - The binary PSBT (not base64).
 * @param options - Decoding limits; see {@link PsbtLimitOptions}.
 * @returns The PSBT's maps. Every key and value is a fresh copy of the input.
 * @throws {RangeError} if `maxBytes` or `maxObjects` is not a positive safe
 * integer.
 * @throws {QbitProtocolError} `INVALID_PSBT` for input that is malformed or
 * over the limits, or `INVALID_AMOUNT` for an unsigned-transaction output
 * outside `MoneyRange`.
 *
 * @remarks
 * Witness UTXOs and P2MR fields are decoded and checked by {@link decodePsbt}.
 * See [Untrusted PSBT input](https://github.com/Qbit-Org/qbit-js/blob/main/packages/protocol/docs/untrusted-psbt.md).
 *
 * @category PSBT
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
 *
 * @param psbt - The PSBT. Its maps are written in order, as given.
 * @returns The binary PSBT.
 * @throws {QbitProtocolError} `INVALID_BYTES` for a key or value that is not a
 * `Uint8Array`, or `INVALID_PSBT` for an empty key.
 *
 * @remarks
 * See [Byte inputs and outputs](https://github.com/Qbit-Org/qbit-js/blob/main/packages/protocol/docs/byte-inputs.md).
 *
 * @category PSBT
 */
export function serializePsbt(psbt: Psbt): Uint8Array {
  const parts: Uint8Array[] = [Uint8Array.of(0x70, 0x73, 0x62, 0x74, 0xff), serializePsbtMap(psbt.global)]
  for (const map of psbt.inputs) parts.push(serializePsbtMap(map))
  for (const map of psbt.outputs) parts.push(serializePsbtMap(map))
  return concatByteList(parts)
}

/**
 * The unsigned transaction carried by a PSBT's global map.
 *
 * @param psbt - The PSBT.
 * @returns The decoded transaction.
 * @throws {QbitProtocolError} `INVALID_PSBT` if the global map has no
 * unsigned transaction (`0x00`) or it is malformed, or `INVALID_AMOUNT` for an
 * output outside `MoneyRange`.
 *
 * @remarks
 * It applies no `maxObjects` limit, so decode untrusted bytes with
 * {@link parsePsbt} first.
 *
 * @category PSBT
 */
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
 *
 * @param psbts - The PSBTs to combine, at least one.
 * @returns A new PSBT; the inputs are not modified.
 * @throws {QbitProtocolError} `INVALID_PSBT` for an empty list, a PSBT without
 * an unsigned transaction, unsigned transactions that differ, different
 * numbers of input or output maps, a key with conflicting values, or a
 * malformed proprietary key.
 *
 * @category PSBT
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
 *
 * @param psbt - The PSBT, from {@link parsePsbt} or built by hand.
 * @returns The transaction's fields, each input's decoded fields, and the fee
 * when every input has a witness UTXO.
 * @throws {QbitProtocolError} `INVALID_PSBT` for a malformed PSBT or record,
 * a map shape `parsePsbt` would not produce, or conflicting P2MR signatures.
 * @throws {QbitProtocolError} `INVALID_AMOUNT` for an amount or total outside
 * `MoneyRange`, or outputs that exceed the inputs.
 * @throws {QbitProtocolError} `INVALID_SCRIPT` for a malformed P2MR signature
 * item or an odd leaf version, or `INVALID_BYTES` for a `qbit` Merkle root
 * that is not 32 bytes.
 *
 * @remarks
 * See
 * [Signing and finalization](https://github.com/Qbit-Org/qbit-js/blob/main/packages/protocol/docs/signing-and-finalization.md).
 *
 * @category PSBT
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
      // The parser's key id, so a long key costs a SHA-256 rather than its hex.
      const keyId = psbtKeyIndexId(key)
      if (seen.has(keyId)) {
        throw new QbitProtocolError('INVALID_PSBT', 'duplicate key in PSBT map')
      }
      seen.add(keyId)
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

/**
 * One input spec for `createP2mrPsbt`.
 *
 * @category PSBT
 */
export interface P2mrPsbtInput {
  /** The output being spent. */
  prevout: P2mrOutpoint
  /** nSequence (uint32). Default `0xfffffffd`. */
  sequence?: number
  /** The output being spent: amount + P2MR scriptPubKey. */
  witnessUtxo: P2mrTransactionOutput
  /** The script of the leaf the input will be spent through, written as a `0x1d` record. */
  leafScript: Uint8Array
  /**
   * The leaf's control block, the `0x1d` record's key. Only its shape is
   * checked here; signing refuses a leaf whose control block does not commit
   * to the witness UTXO's program.
   */
  controlBlock: Uint8Array
  /** The leaf version. Default {@link P2MR_LEAF_VERSION_V1}. */
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
 *
 * @param params - The transaction's inputs, outputs, version and locktime.
 * Amounts are satoshis, as `bigint`s; the fee is the inputs' total minus the
 * outputs'.
 * @returns A new PSBT: the unsigned transaction, and per input the witness
 * UTXO, the `0x1d` leaf-script record and, when given, the `qbit` Merkle-root
 * record. Output maps are empty.
 * @throws {QbitProtocolError} `INVALID_SCRIPT` for an output restricted-output
 * mode rejects, or an odd leaf version.
 * @throws {QbitProtocolError} `INVALID_BYTES` for a byte field that is not a
 * `Uint8Array` or a txid or Merkle root that is not 32 bytes.
 * @throws {QbitProtocolError} `INVALID_AMOUNT` for an amount outside
 * `MoneyRange`, or `INVALID_INTEGER` for a version, locktime, vout or sequence
 * that is not a uint32.
 * @throws {QbitProtocolError} `INVALID_PSBT` for a control block with the
 * wrong length or a clear low bit in its first byte.
 * @throws {RangeError} if a leaf version is not an integer from 0 to 255.
 *
 * @remarks
 * It does not check that the inputs cover the outputs ({@link decodePsbt}
 * does) or that each leaf is in its witness UTXO's tree (the signing helpers
 * do). See
 * [Consensus checks](https://github.com/Qbit-Org/qbit-js/blob/main/packages/protocol/docs/consensus-checks.md).
 *
 * @example
 * ```ts
 * import {
 *   addressToScriptPubKey,
 *   buildControlBlock,
 *   createP2mrPsbt,
 *   hexToBytes,
 *   p2mrAddressFromPubkey,
 *   serializePsbt,
 *   singleKeyLeafScript,
 * } from '@qbit-oss/protocol'
 *
 * const pubkey = hexToBytes('02'.repeat(32)) // the 32-byte public key from your PQC signer
 * const scriptPubKey = addressToScriptPubKey(p2mrAddressFromPubkey(pubkey, 'regtest'), 'regtest')
 * // fundingTxid: the funding transaction's id as an explorer shows it
 * const txid = hexToBytes(fundingTxid).reverse()
 * const psbt = createP2mrPsbt({
 *   inputs: [
 *     {
 *       prevout: { txid, vout: 0 },
 *       witnessUtxo: { value: 100_000n, scriptPubKey },
 *       leafScript: singleKeyLeafScript(pubkey),
 *       controlBlock: buildControlBlock(), // the key is the address's only leaf
 *     },
 *   ],
 *   outputs: [{ value: 99_000n, scriptPubKey }], // a 1,000-satoshi fee
 * })
 * const bytes = serializePsbt(psbt)
 * ```
 *
 * @category PSBT
 */
export function createP2mrPsbt(params: {
  /** nVersion (uint32, as qbit Core's `CTransaction::version`). Default 2. */
  version?: number
  /** nLockTime (uint32). Default 0. */
  locktime?: number
  /** What each input spends and the leaf it will be signed through. */
  inputs: readonly P2mrPsbtInput[]
  /** The outputs, with amounts in satoshis. */
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
 * Extract the network-ready transaction (with witnesses) from a finalized PSBT.
 * Each final scriptwitness must fit qbit Core's P2MR witness stack limits, the
 * transaction must fit `options.maxBytes`, which is checked before any witness
 * is decoded, and at most `options.maxObjects` transaction inputs, outputs and
 * witness items are decoded (see `PsbtLimitOptions`).
 *
 * @param psbt - A PSBT from {@link finalizeP2mrPsbt} or {@link parsePsbt}
 * in which every input has a final scriptwitness (`0x08`).
 * @param options - Decoding limits; see {@link PsbtLimitOptions}.
 * @returns The witness-serialized transaction, ready to broadcast.
 * @throws {RangeError} if `maxBytes` or `maxObjects` is not a positive safe
 * integer.
 * @throws {QbitProtocolError} `INVALID_PSBT` if the PSBT has no unsigned
 * transaction or one that does not parse, an input map has no final
 * scriptwitness, a final scriptwitness is malformed or over qbit Core's P2MR
 * limits, or the transaction is over the limits.
 * @throws {QbitProtocolError} `INVALID_AMOUNT` for an output outside
 * `MoneyRange`.
 *
 * @remarks
 * It checks only what is listed above, not {@link decodePsbt}'s rules. It
 * takes one witness from each map in `psbt.inputs` without checking that
 * there is one map per transaction input, so a hand-built `Psbt` with too few
 * or too many input maps gives a malformed transaction instead of an error.
 * {@link finalizeP2mrPsbt} and {@link parsePsbt} both return one input map per
 * input, so pass a PSBT from one of them. See
 * [Untrusted PSBT input](https://github.com/Qbit-Org/qbit-js/blob/main/packages/protocol/docs/untrusted-psbt.md).
 *
 * @example
 * ```ts
 * import { bytesToHex, extractP2mrTransaction, parsePsbt } from '@qbit-oss/protocol'
 *
 * // finalizedBytes: a finalized PSBT received from another wallet
 * const psbt = parsePsbt(finalizedBytes, { maxBytes: 1_000_000 })
 * const rawTx = bytesToHex(extractP2mrTransaction(psbt, { maxBytes: 400_000 }))
 * ```
 *
 * @category PSBT
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
  // A hand-built map can hold a key that is not a Uint8Array; it keeps its hex id.
  if (key.length <= 64 || !isUint8Array(key)) return bytesToHex(key)
  // @noble/hashes rejects a Uint8Array subclass from another realm (and, before
  // 1.3.3, any Uint8Array from another realm), so hash a copy of such a key.
  return `#${bytesToHex(sha256(key instanceof Uint8Array ? key : copyBytes(key)))}`
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

function proprietaryKeyBytes(field: EncodedQbitProprietaryP2mrField): Uint8Array {
  return concatBytes(
    Uint8Array.of(PSBT_IN_PROPRIETARY),
    serializeVarBytes(asciiBytes(field.identifier), 'proprietary identifier'),
    compactSize(field.subtype),
    field.keyData
  )
}

export { parseTxOut, parseProprietaryKey, cloneEntry, mergeMap, parseWitnessStack, encodePsbtSighashTypeField }

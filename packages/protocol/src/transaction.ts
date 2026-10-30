import type { addressToScriptPubKey } from './addresses'
import { P2MR_PROGRAM_BYTES } from './constants'
import { assertMoneyRange, assertUint32 } from './consensus'
import { concatByteList, compactSize, copyBytes, concatBytes, serializeVarBytes, assertByteLength } from './bytes'

// ---------------------------------------------------------------------------
// Transactions: the outpoint, input, output and transaction types, and the
// serialization the sighash, PSBT and signing code share.
// ---------------------------------------------------------------------------

/**
 * The output a transaction input spends: its funding transaction's id and
 * output index.
 *
 * @category PSBT
 */
export interface P2mrOutpoint {
  /**
   * Transaction id in serialization (internal) byte order — the reverse of the
   * big-endian txid shown by explorers and RPC. Exactly 32 bytes.
   */
  txid: Uint8Array
  /** Output index within the funding transaction (uint32). */
  vout: number
}

/**
 * An input of an unsigned transaction.
 *
 * @category PSBT
 */
export interface P2mrTransactionInput {
  /** The output this input spends. */
  prevout: P2mrOutpoint
  /** nSequence (uint32). */
  sequence: number
}

/**
 * A transaction output.
 *
 * @category PSBT
 */
export interface P2mrTransactionOutput {
  /** Amount in satoshis; must satisfy `MoneyRange` (0 ≤ value ≤ `QBIT_MAX_MONEY`). */
  value: bigint
  /** The output script, such as a P2MR scriptPubKey from {@link addressToScriptPubKey}. */
  scriptPubKey: Uint8Array
}

/**
 * An unsigned transaction: inputs without scriptSigs or witnesses, as a PSBT
 * carries it.
 *
 * @category PSBT
 */
export interface P2mrTransaction {
  /** nVersion (uint32, as qbit Core's `CTransaction::version`; a legacy int32 `-1` is `0xffffffff`). */
  version: number
  /** nLockTime (uint32). */
  locktime: number
  /** The inputs, in order. */
  inputs: readonly P2mrTransactionInput[]
  /** The outputs, in order. */
  outputs: readonly P2mrTransactionOutput[]
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

function serializeUnsignedTransaction(tx: P2mrTransaction): Uint8Array {
  const parts: Uint8Array[] = [uint32LE(tx.version, 'version'), compactSize(tx.inputs.length)]
  for (const input of tx.inputs) {
    parts.push(serializeOutpoint(input.prevout), compactSize(0), uint32LE(input.sequence, 'sequence'))
  }
  parts.push(compactSize(tx.outputs.length))
  tx.outputs.forEach((output, i) => parts.push(serializeTxOut(output, `output ${i}`)))
  parts.push(uint32LE(tx.locktime, 'locktime'))
  return concatByteList(parts)
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
  return concatByteList(parts)
}

function serializeWitnessStack(stack: readonly Uint8Array[]): Uint8Array {
  const parts: Uint8Array[] = [compactSize(stack.length)]
  stack.forEach((item, i) => parts.push(serializeVarBytes(item, `witness item ${i}`)))
  return concatByteList(parts)
}

export {
  uint32LE,
  serializeAmount,
  serializeOutpoint,
  serializeTxOut,
  cloneTxOut,
  cloneP2mrTransaction,
  serializeUnsignedTransaction,
  serializeWitnessTransaction,
  serializeWitnessStack,
}

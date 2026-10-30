import { sha256 } from '@noble/hashes/sha2'

function tryTxidFromRawTx(rawTxHex: string): string | undefined {
  const bytes = hexToBytes(rawTxHex)
  const stripped = bytes === undefined ? undefined : witnessStrippedTx(bytes)
  if (stripped === undefined) return undefined
  return bytesToHex(sha256(sha256(stripped)).reverse())
}

/** qbit Core `serialize.h` MAX_SIZE: the largest CompactSize `ReadCompactSize` accepts. */
const COMPACT_SIZE_MAX = 0x02000000

class RawTxReader {
  private offset = 0

  constructor(private readonly bytes: Uint8Array) {}

  get position(): number {
    return this.offset
  }

  get remaining(): number {
    return this.bytes.length - this.offset
  }

  skip(length: number): void {
    if (length > this.remaining) throw new RangeError('raw transaction is truncated')
    this.offset += length
  }

  readUint8(): number {
    this.skip(1)
    return this.bytes[this.offset - 1]!
  }

  /**
   * qbit Core `ReadCompactSize` with its default range check (serialize.h:330
   * at v1.0.0). Only the shortest encoding of a value is valid: a `fd` prefix
   * must carry at least 0xfd, `fe` at least 0x10000 and `ff` at least
   * 0x100000000, or Core throws `non-canonical ReadCompactSize()`. A value
   * above MAX_SIZE (serialize.h:32) fails `size too large`, so every `ff`
   * encoding fails one check or the other. Core reads every count and length
   * in a transaction this way, witness stacks included.
   */
  readCompactSize(): number {
    const first = this.readUint8()
    if (first < 0xfd) return first
    const width = first === 0xfd ? 2 : first === 0xfe ? 4 : 8
    let value = 0
    for (let i = 0; i < width; i += 1) value += this.readUint8() * 2 ** (8 * i)
    const minimum = first === 0xfd ? 0xfd : first === 0xfe ? 0x10000 : 2 ** 32
    if (value < minimum) throw new RangeError('raw transaction has a non-canonical CompactSize')
    if (value > COMPACT_SIZE_MAX) throw new RangeError('raw transaction length is too large')
    return value
  }

  skipVarBytes(): void {
    this.skip(this.readCompactSize())
  }
}

/**
 * The witness-stripped encoding of a complete transaction, or undefined when
 * the bytes are truncated, carry trailing data, use an unknown marker, encode
 * a count or length non-canonically or above MAX_SIZE, or set the witness flag
 * with every witness stack empty. qbit Core refuses the last two even though
 * the witness section does not change the txid (`non-canonical
 * ReadCompactSize()` / `size too large`, serialize.h:330-359, and
 * `Superfluous witness record`, primitives/transaction.h:237-246, at v1.0.0;
 * a stack holding one empty item is not empty, per `ComputeHasWitness`,
 * primitives/transaction.cpp:74). Structure only: script contents and counts
 * are not validated further, so any transaction a node could decode yields
 * its txid.
 */
function witnessStrippedTx(bytes: Uint8Array): Uint8Array | undefined {
  const reader = new RawTxReader(bytes)
  try {
    reader.skip(4) // version
    const witness = reader.remaining >= 2 && bytes[4] === 0x00
    if (witness) {
      if (bytes[5] !== 0x01) return undefined
      reader.skip(2) // marker + flag
    }
    const bodyStart = reader.position
    const inputCount = reader.readCompactSize()
    for (let i = 0; i < inputCount; i += 1) {
      reader.skip(36) // outpoint
      reader.skipVarBytes() // scriptSig
      reader.skip(4) // sequence
    }
    const outputCount = reader.readCompactSize()
    for (let i = 0; i < outputCount; i += 1) {
      reader.skip(8) // value
      reader.skipVarBytes() // scriptPubKey
    }
    const bodyEnd = reader.position
    if (witness) {
      let hasWitness = false
      for (let i = 0; i < inputCount; i += 1) {
        const items = reader.readCompactSize()
        if (items > 0) hasWitness = true
        for (let j = 0; j < items; j += 1) reader.skipVarBytes()
      }
      if (!hasWitness) return undefined
    }
    reader.skip(4) // locktime
    if (reader.remaining !== 0) return undefined
    if (!witness) return bytes
    const stripped = new Uint8Array(4 + (bodyEnd - bodyStart) + 4)
    stripped.set(bytes.subarray(0, 4), 0)
    stripped.set(bytes.subarray(bodyStart, bodyEnd), 4)
    stripped.set(bytes.subarray(bytes.length - 4), stripped.length - 4)
    return stripped
  } catch {
    return undefined
  }
}

function hexToBytes(hex: string): Uint8Array | undefined {
  if (hex.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(hex)) return undefined
  const bytes = new Uint8Array(hex.length / 2)
  for (let i = 0; i < bytes.length; i += 1) {
    bytes[i] = parseInt(hex.slice(2 * i, 2 * i + 2), 16)
  }
  return bytes
}

function bytesToHex(bytes: Uint8Array): string {
  let hex = ''
  for (const byte of bytes) hex += byte.toString(16).padStart(2, '0')
  return hex
}

export { tryTxidFromRawTx }

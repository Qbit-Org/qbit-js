import { sha256 } from '@noble/hashes/sha2'
import { QbitProtocolError } from './errors'

const textEncoder = new TextEncoder()

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
 *
 * @param bytes - The bytes to encode.
 * @returns Two lowercase hex digits per byte, in order.
 *
 * @category Encoding
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

/**
 * Decode hex into bytes. Upper- and lowercase digits are both accepted.
 *
 * @param hex - An even number of hex digits; `''` gives empty bytes.
 * @returns A new `Uint8Array`.
 * @throws {QbitProtocolError} `INVALID_BYTES` if `hex` has an odd length or a
 * character that is not a hex digit.
 *
 * @remarks
 * Explorers and RPC show txids in reverse byte order, so reverse the result
 * to get the order a {@link P2mrOutpoint} `txid` uses.
 *
 * @category Encoding
 */
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
 * Concatenate a list of chunks without spreading it into call arguments.
 * `concatBytes(...parts)` passes one argument per chunk, so a list as long as a
 * large PSBT map, or a transaction's inputs, outputs or witness items,
 * overflows the call stack with a bare `RangeError` (at about 120k chunks on
 * Node's default stack).
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

function isBytesOfLength(value: unknown, length: number): value is Uint8Array {
  return isUint8Array(value) && value.length === length
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

function taggedHash(tag: string, ...messages: readonly Uint8Array[]): Uint8Array {
  const tagHash = sha256(asciiBytes(tag))
  return sha256(concatByteList([tagHash, tagHash, ...messages]))
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

/**
 * Copy `bytes[start, end)` (negative indices count from the end) into a fresh,
 * unshared plain `Uint8Array`. Use this instead of `.slice()` for byte inputs:
 * Node's `Buffer` overrides `slice` to return a view of the caller's memory, so
 * a "copy" made with `.slice()` would track later writes to the input buffer.
 */
function copyBytes(bytes: Uint8Array, start = 0, end = bytes.length): Uint8Array {
  return new Uint8Array(bytes.subarray(start, end))
}

/** Concatenate a fixed argument list. Pass an array of chunks to `concatByteList` instead of spreading it here. */
function concatBytes(...chunks: readonly Uint8Array[]): Uint8Array {
  return concatByteList(chunks)
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

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && compareBytes(a, b) === 0
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

function asciiBytes(value: string): Uint8Array {
  return textEncoder.encode(value)
}

export {
  textEncoder,
  concatByteList,
  isBytesOfLength,
  readUint32Be,
  taggedHash,
  compactSize,
  copyBytes,
  concatBytes,
  serializeVarBytes,
  ByteReader,
  bytesEqual,
  compareBytes,
  isRecord,
  isCanonicalHex,
  isUint8Array,
  assertBytes,
  assertByteLength,
  asciiBytes,
}

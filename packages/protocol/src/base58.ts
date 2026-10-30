import { sha256 } from '@noble/hashes/sha2'
import { QbitProtocolError } from './errors'
import { compareBytes } from './bytes'

const BASE58_CHARSET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'

const base58CharValues = new Map<string, number>(Array.from(BASE58_CHARSET, (char, index) => [char, index]))

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

export { decodeBase58Check, Base58LengthError }

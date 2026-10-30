import { QbitProtocolError } from './errors'

const BECH32_CHARSET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l'

const BECH32M_CONST = 0x2bc830a3
const BECH32_CONST = 1
// BIP173/BIP350 character limit, mirrored from qbit Core's bech32::CharLimit::BECH32.
const BECH32_MAX_LENGTH = 90
const BECH32_GENERATORS = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3] as const

const bech32CharValues = new Map<string, number>(Array.from(BECH32_CHARSET, (char, index) => [char, index]))

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

export { bech32Encode, bech32Decode, convertBits }

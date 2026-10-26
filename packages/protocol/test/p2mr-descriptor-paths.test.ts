import { describe, expect, it } from 'vitest'

import {
  QbitProtocolError,
  formatP2mrImportDescriptors,
  parseP2mrDescriptor,
  serializeP2mrDescriptor,
} from '../src/index'

const QRPV =
  'qrpvV1brS3WRoVwgS5xyXiUp3mtpwpSs8xy5BoE1RoSfwu8zY4kXL4vZTUdqw7UNivGw3rwtcfiKLVwGRWQWPJYRN4SMAPuBHYSFy1sd1VtMk8j'

function keyPathDescriptor(segment: string): string {
  return `mr(pk(pqc(${QRPV}/87h/${segment}/0/*)))`
}

function originDescriptor(segment: string): string {
  return `mr(pk(pqc([deadbeef/87h/${segment}]${QRPV}/0/*)))`
}

function descriptorError(fn: () => unknown): QbitProtocolError {
  try {
    fn()
  } catch (error) {
    expect(error).toBeInstanceOf(QbitProtocolError)
    expect((error as QbitProtocolError).code).toBe('INVALID_DESCRIPTOR')
    return error as QbitProtocolError
  }
  throw new Error('expected parseP2mrDescriptor to throw')
}

// Oracle: qbit Core v1.0.0 ParseKeyPathNum (src/script/descriptor.cpp:2114-2136).
// The '%s' form echoes the segment without its hardened marker; the %u form prints
// the parsed uint32, so leading zeros are dropped.
const REJECTED: ReadonlyArray<readonly [string, string]> = [
  ['87H', "Key path value '87H' is not a valid uint32"],
  ['2147483648', 'Key path value 2147483648 is out of range'],
  ["2147483648'", 'Key path value 2147483648 is out of range'],
  ['02147483648h', 'Key path value 2147483648 is out of range'],
  ['4294967295', 'Key path value 4294967295 is out of range'],
  ['4294967296', "Key path value '4294967296' is not a valid uint32"],
  ['99999999999999999999', "Key path value '99999999999999999999' is not a valid uint32"],
  ["99999999999999999999'", "Key path value '99999999999999999999' is not a valid uint32"],
  ['', "Key path value '' is not a valid uint32"],
  ["'", "Key path value '' is not a valid uint32"],
  ['+1', "Key path value '+1' is not a valid uint32"],
  ['-1', "Key path value '-1' is not a valid uint32"],
  ["1h'", "Key path value '1h' is not a valid uint32"],
]

const ACCEPTED = ['2147483647', "2147483647'", '0h', '00', "00'", '0002147483647h']

describe('P2MR descriptor key-path grammar', () => {
  it.each(REJECTED)('rejects key path segment %j like Core', (segment, message) => {
    expect(descriptorError(() => parseP2mrDescriptor(keyPathDescriptor(segment))).message).toBe(message)
  })

  it.each(REJECTED)('rejects origin path segment %j like Core', (segment, message) => {
    expect(descriptorError(() => parseP2mrDescriptor(originDescriptor(segment))).message).toBe(message)
  })

  it('rejects an origin with an `H` marker and an out-of-range index', () => {
    expect(
      descriptorError(() => parseP2mrDescriptor(`mr(pk(pqc([deadbeef/87H/4294967296]${QRPV}/0/*)))`))
        .message
    ).toBe("Key path value '87H' is not a valid uint32")
  })

  it('refuses to format importdescriptors requests with paths Core rejects', () => {
    expect(() =>
      formatP2mrImportDescriptors({
        external: `mr(pk(pqc(${QRPV}/87H/1H/0H/4294967296/*)))`,
        internal: `mr(pk(pqc(${QRPV}/87h/1h/0h/1/*)))`,
      })
    ).toThrow("Key path value '87H' is not a valid uint32")
  })

  it.each(ACCEPTED)('accepts key path segment %j and keeps its spelling', segment => {
    const descriptor = keyPathDescriptor(segment)
    const parsed = parseP2mrDescriptor(descriptor)
    if (parsed.type !== 'mr' || parsed.tree.type !== 'pqc') {
      throw new Error('expected pqc descriptor')
    }
    expect(parsed.tree.key.path).toEqual(['87h', segment, '0', '*'])
    expect(serializeP2mrDescriptor(parsed, false)).toBe(descriptor)
  })

  it.each(ACCEPTED)('accepts origin path segment %j and keeps its spelling', segment => {
    const descriptor = originDescriptor(segment)
    const parsed = parseP2mrDescriptor(descriptor)
    if (parsed.type !== 'mr' || parsed.tree.type !== 'pqc') {
      throw new Error('expected pqc descriptor')
    }
    expect(parsed.tree.key.origin).toEqual({ fingerprint: 'deadbeef', path: ['87h', segment] })
    expect(serializeP2mrDescriptor(parsed, false)).toBe(descriptor)
  })

  it('reports multipath and hardened wildcards as unsupported', () => {
    expect(
      descriptorError(() => parseP2mrDescriptor(`mr(pk(pqc(${QRPV}/87h/<0;1>/*)))`)).message
    ).toBe('multipath descriptor key paths are not supported')
    expect(descriptorError(() => parseP2mrDescriptor(`mr(pk(pqc(${QRPV}/0/*')))`)).message).toBe(
      'hardened descriptor wildcards are not supported'
    )
    expect(descriptorError(() => parseP2mrDescriptor(`mr(pk(pqc(${QRPV}/0/*h)))`)).message).toBe(
      'hardened descriptor wildcards are not supported'
    )
  })

  it('rejects wildcards that are not the final key path segment', () => {
    expect(() => parseP2mrDescriptor(`mr(pk(pqc(${QRPV}/*/0)))`)).toThrow(
      'descriptor wildcard must be the final path segment'
    )
    expect(() => parseP2mrDescriptor(originDescriptor('*'))).toThrow(
      'descriptor wildcard must be the final path segment'
    )
    // Core treats a hardened wildcard outside the final key position as a bad number.
    expect(() => parseP2mrDescriptor(originDescriptor("*'"))).toThrow(
      "Key path value '*' is not a valid uint32"
    )
  })

  it('caps and sanitizes the echoed segment in error messages', () => {
    const message = descriptorError(() =>
      parseP2mrDescriptor(keyPathDescriptor(`${'9'.repeat(10_000)}\n`))
    ).message
    expect(message).toBe(`Key path value '${'9'.repeat(32)}...' is not a valid uint32`)

    expect(descriptorError(() => parseP2mrDescriptor(keyPathDescriptor('1\n2'))).message).toBe(
      "Key path value '1?2' is not a valid uint32"
    )
  })
})

import { sha256 } from '@noble/hashes/sha2'
import { describe, expect, it } from 'vitest'

import {
  QbitProtocolError,
  addDescriptorChecksum,
  bytesToHex,
  formatP2mrImportDescriptors,
  hexToBytes,
  multiALeafScript,
  p2mrAddressFromDescriptor,
  p2mrAddressFromPubkey,
  p2mrBranchHash,
  p2mrLeafHash,
  p2mrRootFromDescriptor,
  parseP2mrDescriptor,
  serializeP2mrDescriptor,
  singleKeyLeafScript,
  verifyDescriptorChecksum,
  P2MR_LEAF_VERSION_V1,
} from '../src/index'

const RAW_ROOT = '000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f'
const PK_A = '101112131415161718191a1b1c1d1e1f202122232425262728292a2b2c2d2e2f'
const PK_B = 'f0e1d2c3b4a5968778695a4b3c2d1e0f00112233445566778899aabbccddeeff'
const QRPV =
  'qrpvV1brS3WRoVwgS5xyXiUp3mtpwpSs8xy5BoE1RoSfwu8zY4kXL4vZTUdqw7UNivGw3rwtcfiKLVwGRWQWPJYRN4SMAPuBHYSFy1sd1VtMk8j'
const RANGED_EXTERNAL = `mr(pk(pqc(${QRPV}/87h/1h/0h/0/*)))`
const RANGED_INTERNAL = `mr(pk(pqc(${QRPV}/87h/1h/0h/1/*)))`

describe('P2MR descriptors', () => {
  it('parses, verifies, and serializes rawmr descriptors', () => {
    const descriptor = addDescriptorChecksum(`rawmr(${RAW_ROOT})`)
    const parsed = parseP2mrDescriptor(descriptor, { requireChecksum: true })

    expect(parsed.type).toBe('rawmr')
    expect(serializeP2mrDescriptor(parsed, false)).toBe(`rawmr(${RAW_ROOT})`)
    expect(serializeP2mrDescriptor(parsed, true)).toBe(descriptor)
    expect(bytesToHex(p2mrRootFromDescriptor(parsed))).toBe(RAW_ROOT)
    expect(p2mrAddressFromDescriptor(parsed, 'regtest')).toBe(
      'qbrt1zqqqsyqcyq5rqwzqfpg9scrgwpugpzysnzs23v9ccrydpk8qarc0s8kqqny'
    )
  })

  it('expands single-key pk descriptors through the P2MR leaf hash', () => {
    const descriptor = `mr(pk(${PK_A}))`
    const expectedRoot = p2mrLeafHash(P2MR_LEAF_VERSION_V1, singleKeyLeafScript(hexToBytes(PK_A)))

    expect(bytesToHex(p2mrRootFromDescriptor(descriptor))).toBe(bytesToHex(expectedRoot))
    expect(p2mrAddressFromDescriptor(descriptor, 'regtest')).toBe(p2mrAddressFromPubkey(hexToBytes(PK_A), 'regtest'))
    expect(serializeP2mrDescriptor(parseP2mrDescriptor(addDescriptorChecksum(descriptor)), false)).toBe(descriptor)
  })

  it('parses multi_a and sortedmulti_a descriptors', () => {
    const multi = parseP2mrDescriptor(`mr(multi_a(2,${PK_A},${PK_B}))`)
    const sorted = parseP2mrDescriptor(`mr(sortedmulti_a(2,${PK_B},${PK_A}))`)
    const expectedMultiRoot = p2mrLeafHash(
      P2MR_LEAF_VERSION_V1,
      multiALeafScript(2, [hexToBytes(PK_A), hexToBytes(PK_B)])
    )
    const expectedSortedRoot = p2mrLeafHash(
      P2MR_LEAF_VERSION_V1,
      multiALeafScript(2, [hexToBytes(PK_A), hexToBytes(PK_B)])
    )

    expect(bytesToHex(p2mrRootFromDescriptor(multi))).toBe(bytesToHex(expectedMultiRoot))
    expect(bytesToHex(p2mrRootFromDescriptor(sorted))).toBe(bytesToHex(expectedSortedRoot))
    expect(serializeP2mrDescriptor(sorted, false)).toBe(`mr(sortedmulti_a(2,${PK_B},${PK_A}))`)
  })

  it('parses and expands Core-style binary P2MR script trees', () => {
    const twoLeaf = `mr({pk(${PK_A}),pk(${PK_B})})`
    const nested = `mr({pk(${PK_A}),{pk(${PK_B}),multi_a(1,${PK_A})}})`
    const leafA = p2mrLeafHash(P2MR_LEAF_VERSION_V1, singleKeyLeafScript(hexToBytes(PK_A)))
    const leafB = p2mrLeafHash(P2MR_LEAF_VERSION_V1, singleKeyLeafScript(hexToBytes(PK_B)))
    const multiLeaf = p2mrLeafHash(P2MR_LEAF_VERSION_V1, multiALeafScript(1, [hexToBytes(PK_A)]))

    expect(serializeP2mrDescriptor(parseP2mrDescriptor(twoLeaf), false)).toBe(twoLeaf)
    expect(bytesToHex(p2mrRootFromDescriptor(twoLeaf))).toBe(bytesToHex(p2mrBranchHash(leafA, leafB)))
    expect(serializeP2mrDescriptor(parseP2mrDescriptor(nested), false)).toBe(nested)
    expect(bytesToHex(p2mrRootFromDescriptor(nested))).toBe(
      bytesToHex(p2mrBranchHash(leafA, p2mrBranchHash(leafB, multiLeaf)))
    )
  })

  it('parses pqc ranged descriptors without trying to derive private keys', () => {
    const descriptor = `mr(pk(pqc([00000000/87h/1h]${QRPV}/87h/1h/0h/0/*)))`
    const parsed = parseP2mrDescriptor(descriptor)

    expect(parsed.type).toBe('mr')
    if (parsed.type !== 'mr' || parsed.tree.type !== 'pqc') {
      throw new Error('expected pqc descriptor')
    }
    expect(parsed.tree.key.origin).toEqual({
      fingerprint: '00000000',
      path: ['87h', '1h'],
    })
    expect(parsed.tree.key.key).toBe(QRPV)
    expect(parsed.tree.key.path).toEqual(['87h', '1h', '0h', '0', '*'])
    expect(parsed.tree.key.wildcard).toBe(true)
    expect(serializeP2mrDescriptor(parsed, false)).toBe(descriptor)
    expect(() => p2mrRootFromDescriptor(parsed)).toThrow(QbitProtocolError)
  })

  it('rejects bad checksums and invalid descriptor ranges', () => {
    const descriptor = addDescriptorChecksum(`rawmr(${RAW_ROOT})`)

    expect(() => verifyDescriptorChecksum(`${descriptor.slice(0, -1)}x`)).toThrow(QbitProtocolError)
    expect(() => parseP2mrDescriptor(`rawmr(${RAW_ROOT})`, { requireChecksum: true })).toThrow(QbitProtocolError)
    expect(() =>
      formatP2mrImportDescriptors({ external: RANGED_EXTERNAL, internal: RANGED_INTERNAL }, [0, 0x80000000])
    ).toThrow(QbitProtocolError)
    expect(() => formatP2mrImportDescriptors({ external: descriptor, internal: `mr(pk(${PK_A}))` }, [0, 20])).toThrow(
      QbitProtocolError
    )
    expect(() => parseP2mrDescriptor(`mr({pk(${PK_A}),pk(${PK_B}),pk(${PK_A})})`)).toThrow(QbitProtocolError)
    expect(() => parseP2mrDescriptor(`mr(pk(pqc(not-a-bip32-key/0)))`)).toThrow(QbitProtocolError)
    expect(() => parseP2mrDescriptor(`mr(pk(pqc(qrpvV1brS3WRoVwg/0)))`)).toThrow(QbitProtocolError)
    expect(() => parseP2mrDescriptor(`mr(pk(pqc(${QRPV}/*/0)))`)).toThrow(QbitProtocolError)
  })

  it('formats Core importdescriptors entries for receive and change descriptors', () => {
    const entries = formatP2mrImportDescriptors({ external: RANGED_EXTERNAL, internal: RANGED_INTERNAL }, [0, 20], 1234)

    expect(entries).toHaveLength(2)
    expect(entries[0]).toMatchObject({
      desc: addDescriptorChecksum(RANGED_EXTERNAL),
      timestamp: 1234,
      active: true,
      internal: false,
      range: [0, 20],
    })
    expect(entries[1]).toMatchObject({
      desc: addDescriptorChecksum(RANGED_INTERNAL),
      timestamp: 1234,
      active: true,
      internal: true,
      range: [0, 20],
    })
  })
})

const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'
const ONE_MIB = 1024 * 1024

function encodeBase58Check(payload: Uint8Array): string {
  const bytes = new Uint8Array([...payload, ...sha256(sha256(payload)).slice(0, 4)])
  let value = BigInt(`0x${bytesToHex(bytes)}`)
  let out = ''
  while (value > 0n) {
    out = BASE58_ALPHABET[Number(value % 58n)]! + out
    value /= 58n
  }
  for (const byte of bytes) {
    if (byte !== 0) break
    out = `1${out}`
  }
  return out
}

function extendedPubkey(version: number): string {
  const payload = new Uint8Array(78)
  new DataView(payload.buffer).setUint32(0, version)
  payload[4] = 3
  payload.fill(0x5a, 13, 45)
  payload[45] = 0x02
  payload.fill(0x11, 46)
  return encodeBase58Check(payload)
}

// The bounded decoder is the only path that reports this message, so asserting it
// proves an oversized key was cut off by the 78 + 4 byte limit rather than decoded.
const OVER_BOUND = 'base58 payload exceeds 82 bytes'
const NOT_EXTENDED_KEY = 'pqc descriptor key must be a BIP32 extended key'
const TWENTY_K = 20_000

function expectDescriptorError(run: () => unknown, message: string): void {
  let error: unknown
  try {
    run()
  } catch (caught) {
    error = caught
  }
  expect(error).toBeInstanceOf(QbitProtocolError)
  expect((error as QbitProtocolError).code).toBe('INVALID_DESCRIPTOR')
  expect((error as QbitProtocolError).message).toBe(message)
}

describe('P2MR descriptor pqc() key bounds', () => {
  it('parses valid qpub, tqpb, and qrpb keys at the 82-byte base58check bound', () => {
    for (const [version, prefix] of [
      [0x03f72815, 'qpub'],
      [0x0435dbad, 'tqpb'],
      [0x03f7d7b5, 'qrpb'],
    ] as const) {
      const key = extendedPubkey(version)
      expect(key.startsWith(prefix)).toBe(true)
      const descriptor = `mr(pk(pqc([0badf00d/87h/1h/0h]${key}/0/*)))`
      const parsed = parseP2mrDescriptor(addDescriptorChecksum(descriptor))
      if (parsed.type !== 'mr' || parsed.tree.type !== 'pqc') {
        throw new Error('expected pqc descriptor')
      }
      expect(parsed.tree.key.key).toBe(key)
      expect(serializeP2mrDescriptor(parsed, false)).toBe(descriptor)
    }
  })

  it('rejects a 1 MiB pqc() key at the base58 bound instead of decoding it', () => {
    const started = performance.now()
    expectDescriptorError(() => parseP2mrDescriptor(`mr(pk(pqc(${'z'.repeat(ONE_MIB)})))`), OVER_BOUND)
    expectDescriptorError(
      () =>
        formatP2mrImportDescriptors(
          { external: `mr(pk(pqc(${'z'.repeat(ONE_MIB)}/0/*)))`, internal: RANGED_INTERNAL },
          [0, 20]
        ),
      OVER_BOUND
    )
    // Generous backstop only; the unbounded decode took minutes per key.
    expect(performance.now() - started).toBeLessThan(5_000)
  })

  it('rejects a valid key followed by extra base58 digits at the bound', () => {
    expectDescriptorError(
      () => parseP2mrDescriptor(`mr(pk(pqc(${extendedPubkey(0x03f72815)}${'z'.repeat(TWENTY_K)}/0/*)))`),
      OVER_BOUND
    )
  })

  it('rejects pqc() keys whose leading zero bytes exceed the bound', () => {
    expectDescriptorError(() => parseP2mrDescriptor(`mr(pk(pqc(${'1'.repeat(TWENTY_K)})))`), OVER_BOUND)
    expectDescriptorError(
      () => parseP2mrDescriptor(`mr(pk(pqc(${'1'.repeat(82)}${'z'.repeat(TWENTY_K)})))`),
      OVER_BOUND
    )
  })

  it('applies the bound exactly at 82 decoded bytes', () => {
    // 58^112 > 2^656, so 112 'z' digits need 83 bytes: one past the 78 + 4 bound.
    expectDescriptorError(() => parseP2mrDescriptor(`mr(pk(pqc(${'z'.repeat(112)})))`), OVER_BOUND)
    expectDescriptorError(() => parseP2mrDescriptor(`mr(pk(pqc(${'1'.repeat(83)})))`), OVER_BOUND)
    // Exactly 82 bytes is within the bound and fails later, on the checksum.
    expectDescriptorError(() => parseP2mrDescriptor(`mr(pk(pqc(${'1'.repeat(82)})))`), NOT_EXTENDED_KEY)
    const key = extendedPubkey(0x03f72815)
    const corrupted = `${key.slice(0, -1)}${key.endsWith('2') ? '3' : '2'}`
    expectDescriptorError(() => parseP2mrDescriptor(`mr(pk(pqc(${corrupted})))`), NOT_EXTENDED_KEY)
  })
})

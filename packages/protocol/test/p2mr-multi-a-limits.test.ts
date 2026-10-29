import { runInNewContext } from 'node:vm'

import { sha256 } from '@noble/hashes/sha256'
import { describe, expect, it } from 'vitest'

import {
  OP_CHECKSIGADD,
  OP_CHECKSIGPQC,
  OP_NUMEQUAL,
  P2MR_LEAF_VERSION_V1,
  P2MR_V1_MAX_MULTI_A_THRESHOLD,
  PQC_SIGNATURE_BYTES,
  QbitProtocolError,
  addDescriptorChecksum,
  bytesToHex,
  formatP2mrImportDescriptors,
  hasP2mrStandardSatisfaction,
  hexToBytes,
  multiALeafScript,
  p2mrAddressFromDescriptor,
  p2mrAddressFromRoot,
  p2mrBranchHash,
  p2mrLeafHash,
  p2mrRootFromDescriptor,
  parseP2mrDescriptor,
  qbitNetworks,
  serializeP2mrDescriptor,
  singleKeyLeafScript,
  type P2mrDescriptorTree,
  type ParsedP2mrDescriptor,
} from '../src/index'

// qbit Core v1.0.0 src/script/script.h:49 MAX_P2MR_V1_TOTAL_INITIAL_STACK_BYTES.
const MAX_TOTAL_INITIAL_STACK_BYTES = 131072
const NO_SATISFACTION =
  'P2MR descriptor has no wallet-constructible satisfaction: multi_a thresholds must not exceed 35'
const TOO_DEEP = 'mr descriptor exceeds maximum tree depth'
const RAW_ROOT = '000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f'

// Same keys as qbit Core's descriptor_p2mr_tests.cpp HexPubkey(i + 1).
function hexPubkey(byte: number): string {
  return byte.toString(16).padStart(2, '0').repeat(32)
}
const KEYS_36 = Array.from({ length: 36 }, (_, index) => hexPubkey(index + 1))
const PUBKEYS_36 = KEYS_36.map(hexToBytes)
const PK_F0 = hexPubkey(0xf0)

function multiA(threshold: number, keys: readonly string[] = KEYS_36, name = 'multi_a'): string {
  return `${name}(${threshold},${keys.join(',')})`
}

// Built byte by byte so the expected k = 36 leaf does not depend on multiALeafScript.
function handBuiltMultiAScript(threshold: number, pubkeys: readonly Uint8Array[]): Uint8Array {
  if (threshold <= 16 || threshold > 0x7f) throw new Error('fixture expects a one-byte push')
  const bytes: number[] = []
  for (const [index, pubkey] of pubkeys.entries()) {
    bytes.push(0x20, ...pubkey, index === 0 ? OP_CHECKSIGPQC : OP_CHECKSIGADD)
  }
  bytes.push(0x01, threshold, OP_NUMEQUAL)
  return Uint8Array.from(bytes)
}

const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'

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

function expectDescriptorError(run: () => unknown, message?: string): void {
  let error: unknown
  try {
    run()
  } catch (caught) {
    error = caught
  }
  expect(error).toBeInstanceOf(QbitProtocolError)
  expect((error as QbitProtocolError).code).toBe('INVALID_DESCRIPTOR')
  if (message !== undefined) {
    expect((error as QbitProtocolError).message).toBe(message)
  }
}

function pkLeaf(byte: number): P2mrDescriptorTree {
  return { type: 'pk', pubkey: hexToBytes(hexPubkey(byte)) }
}

// A tree whose deepest leaf sits `depth` branches below the root.
function treeOfDepth(depth: number): ParsedP2mrDescriptor {
  let tree: P2mrDescriptorTree = pkLeaf(1)
  for (let level = 0; level < depth; level += 1) {
    tree = { type: 'branch', left: tree, right: pkLeaf(2) }
  }
  return { type: 'mr', tree }
}

function multiAObject(threshold: number, pubkeys: unknown[] = PUBKEYS_36): ParsedP2mrDescriptor {
  return {
    type: 'mr',
    tree: { type: 'multi_a', threshold, pubkeys: pubkeys as Uint8Array[] },
  }
}

describe('P2MR multi_a threshold cap', () => {
  it('pins the cap to the qbit Core v1 initial-stack consensus limit', () => {
    // Drift alarm for qbit Core src/script/p2mr_sizing.h:16-24
    // (P2MR_V1_MAX_STANDARD_SIGNATURES, static_assert == 35).
    expect(P2MR_V1_MAX_MULTI_A_THRESHOLD).toBe(35)
    expect(Math.floor(MAX_TOTAL_INITIAL_STACK_BYTES / (PQC_SIGNATURE_BYTES + 1))).toBe(35)
    // 35 signatures fit even with explicit sighash bytes; 36 never fit, even without.
    expect(35 * 3681).toBeLessThanOrEqual(MAX_TOTAL_INITIAL_STACK_BYTES)
    expect(36 * 3680).toBeGreaterThan(MAX_TOTAL_INITIAL_STACK_BYTES)
    expect(PQC_SIGNATURE_BYTES + 1).toBe(3681)
  })

  it('builds multi_a leaf scripts up to threshold 35 and rejects 36', () => {
    expect(bytesToHex(multiALeafScript(35, PUBKEYS_36))).toBe(bytesToHex(handBuiltMultiAScript(35, PUBKEYS_36)))
    expect(() => multiALeafScript(36, PUBKEYS_36)).toThrow(RangeError)
    expect(() => multiALeafScript(36, PUBKEYS_36)).toThrow(
      'multi_a threshold must not exceed 35 (P2MR v1 initial-stack consensus limit)'
    )
    // A threshold above the key count is reported as such, not as the cap.
    expect(() => multiALeafScript(40, PUBKEYS_36.slice(0, 3))).toThrow('threshold cannot exceed pubkey count')
    const pubkeys999 = Array.from({ length: 999 }, (_, index) => PUBKEYS_36[index % 36]!)
    expect(() => multiALeafScript(999, pubkeys999)).toThrow(RangeError)
    // Only the threshold is capped: P2MR has no script size limit, so n stays 999.
    expect(multiALeafScript(35, pubkeys999)).toHaveLength(999 * 34 + 3)
  })

  it('refuses addresses for mr() descriptors whose only leaves need 36+ signatures', () => {
    for (const name of ['multi_a', 'sortedmulti_a']) {
      const descriptor = `mr(${multiA(36, KEYS_36, name)})`
      expectDescriptorError(() => p2mrAddressFromDescriptor(descriptor, 'mainnet'), NO_SATISFACTION)
      expectDescriptorError(
        () => p2mrAddressFromDescriptor(addDescriptorChecksum(descriptor), 'regtest'),
        NO_SATISFACTION
      )
      expectDescriptorError(() => p2mrRootFromDescriptor(descriptor), NO_SATISFACTION)
    }
    const twoUnspendable = `mr({${multiA(36)},${multiA(36, KEYS_36, 'sortedmulti_a')}})`
    expectDescriptorError(() => p2mrAddressFromDescriptor(twoUnspendable, 'mainnet'), NO_SATISFACTION)
  })

  it('keeps 35-of-36 addresses unchanged', () => {
    // Recorded before the threshold cap was added.
    const golden = 'qb1zhwgjxu7rapus7jsg9hhg7nm0s5ckha70u59lnzqgrvnwkhk9palsv6fcta'
    expect(p2mrAddressFromDescriptor(`mr(${multiA(35)})`, 'mainnet')).toBe(golden)
    expect(p2mrAddressFromDescriptor(`mr(${multiA(35, [...KEYS_36].reverse(), 'sortedmulti_a')})`, 'mainnet')).toBe(
      golden
    )
    expect(p2mrAddressFromRoot(p2mrLeafHash(P2MR_LEAF_VERSION_V1, multiALeafScript(35, PUBKEYS_36)), 'mainnet')).toBe(
      golden
    )
  })

  it('still expands a tree with a spendable leaf, committing to its k = 36 leaf as Core does', () => {
    const descriptor = `mr({pk(${PK_F0}),${multiA(36)}})`
    const expectedRoot = p2mrBranchHash(
      p2mrLeafHash(P2MR_LEAF_VERSION_V1, singleKeyLeafScript(hexToBytes(PK_F0))),
      p2mrLeafHash(P2MR_LEAF_VERSION_V1, handBuiltMultiAScript(36, PUBKEYS_36))
    )

    expect(bytesToHex(p2mrRootFromDescriptor(descriptor))).toBe(bytesToHex(expectedRoot))
    // Recorded before the threshold cap was added.
    expect(p2mrAddressFromDescriptor(descriptor, 'regtest')).toBe(
      'qbrt1z7z9m0f5sa6p2rs58q7jj23akn48cjjngajdtfm7xe4vv9xluz8nssup054'
    )
    const sorted = `mr({pk(${PK_F0}),${multiA(36, [...KEYS_36].reverse(), 'sortedmulti_a')}})`
    expect(bytesToHex(p2mrRootFromDescriptor(sorted))).toBe(bytesToHex(expectedRoot))
  })

  it('parses thresholds above 35 and reports satisfaction like Core', () => {
    const parsed = parseP2mrDescriptor(`mr(${multiA(36)})`)
    expect(parsed).toMatchObject({ type: 'mr', tree: { type: 'multi_a', threshold: 36 } })
    expect(serializeP2mrDescriptor(parsed, false)).toBe(`mr(${multiA(36)})`)
    expect(parseP2mrDescriptor(`mr(${multiA(999, Array(999).fill(KEYS_36[0]))})`).type).toBe('mr')

    // qbit Core src/test/descriptor_p2mr_tests.cpp:555-577.
    expect(hasP2mrStandardSatisfaction(`mr(${multiA(35, KEYS_36.slice(0, 35))})`)).toBe(true)
    expect(hasP2mrStandardSatisfaction(`mr(${multiA(36)})`)).toBe(false)
    expect(hasP2mrStandardSatisfaction(`mr({pk(${PK_F0}),${multiA(36)}})`)).toBe(true)

    expect(hasP2mrStandardSatisfaction(`mr(${multiA(35)})`)).toBe(true)
    expect(hasP2mrStandardSatisfaction(`mr(${multiA(36, KEYS_36, 'sortedmulti_a')})`)).toBe(false)
    expect(hasP2mrStandardSatisfaction(`mr({${multiA(36)},${multiA(35)}})`)).toBe(true)
    expect(hasP2mrStandardSatisfaction(`mr(pk(${PK_F0}))`)).toBe(true)
    const qpub = extendedPubkey(qbitNetworks.mainnet.bip32.public)
    expect(hasP2mrStandardSatisfaction(`mr({${multiA(36)},pk(pqc(${qpub}/0/*))})`)).toBe(true)
    expect(hasP2mrStandardSatisfaction(`rawmr(${RAW_ROOT})`)).toBe(false)
    expect(hasP2mrStandardSatisfaction(addDescriptorChecksum(`rawmr(${RAW_ROOT})`))).toBe(false)
    expect(hasP2mrStandardSatisfaction(parsed)).toBe(false)
    expect(hasP2mrStandardSatisfaction(multiAObject(35))).toBe(true)
    expectDescriptorError(() => hasP2mrStandardSatisfaction(`mr(${multiA(0)})`))
    expectDescriptorError(() => hasP2mrStandardSatisfaction(multiAObject(0)))
  })

  it('validates descriptor objects like parsed strings', () => {
    const threshold36 = multiAObject(36)
    expect(serializeP2mrDescriptor(threshold36, false)).toBe(`mr(${multiA(36)})`)
    expectDescriptorError(() => p2mrAddressFromDescriptor(threshold36, 'mainnet'), NO_SATISFACTION)
    expectDescriptorError(() => p2mrRootFromDescriptor(threshold36), NO_SATISFACTION)
    expect(p2mrAddressFromDescriptor(multiAObject(35), 'mainnet')).toBe(
      p2mrAddressFromDescriptor(`mr(${multiA(35)})`, 'mainnet')
    )

    for (const bad of [
      multiAObject(0),
      multiAObject(1.5),
      multiAObject(37, PUBKEYS_36),
      multiAObject(1, []),
      multiAObject(1, Array(1000).fill(PUBKEYS_36[0])),
      multiAObject(1, [PUBKEYS_36[0]!.slice(1)]),
      multiAObject(1, [Array.from(PUBKEYS_36[0]!)]),
      { type: 'mr', tree: { type: 'pk', pubkey: new Uint8Array(33) } },
      { type: 'mr', tree: { type: 'pkh', pubkey: PUBKEYS_36[0] } },
      { type: 'mr', tree: { type: 'branch', left: pkLeaf(1) } },
      { type: 'tr', tree: pkLeaf(1) },
      { type: 'rawmr', root: new Uint8Array(31) },
      { type: 'rawmr', root: RAW_ROOT },
      null,
      undefined,
    ] as unknown as ParsedP2mrDescriptor[]) {
      expectDescriptorError(() => serializeP2mrDescriptor(bad))
      expectDescriptorError(() => p2mrRootFromDescriptor(bad))
      expectDescriptorError(() => p2mrAddressFromDescriptor(bad, 'regtest'))
      expectDescriptorError(() => hasP2mrStandardSatisfaction(bad))
    }
  })

  it('accepts key and root bytes from another realm', () => {
    const otherRealm = (): Uint8Array => runInNewContext('new Uint8Array(32).fill(2)') as Uint8Array
    expect(otherRealm()).not.toBeInstanceOf(Uint8Array)
    const local = new Uint8Array(32).fill(2)

    const pk = { type: 'mr', tree: { type: 'pk', pubkey: otherRealm() } } as ParsedP2mrDescriptor
    expect(p2mrAddressFromDescriptor(pk, 'regtest')).toBe(
      p2mrAddressFromDescriptor({ type: 'mr', tree: { type: 'pk', pubkey: local } }, 'regtest')
    )
    expect(serializeP2mrDescriptor(pk, false)).toBe(`mr(pk(${hexPubkey(2)}))`)
    expect(hasP2mrStandardSatisfaction(pk)).toBe(true)

    const multi = multiAObject(1, [otherRealm(), PUBKEYS_36[0]!])
    expect(p2mrAddressFromDescriptor(multi, 'regtest')).toBe(
      p2mrAddressFromDescriptor(multiAObject(1, [local, PUBKEYS_36[0]!]), 'regtest')
    )

    const raw = { type: 'rawmr', root: otherRealm() } as ParsedP2mrDescriptor
    expect(serializeP2mrDescriptor(raw, false)).toBe(`rawmr(${hexPubkey(2)})`)
    expect(p2mrAddressFromDescriptor(raw, 'regtest')).toBe(p2mrAddressFromRoot(local, 'regtest'))
  })

  it('bounds descriptor object depth at 128 without recursing', () => {
    const depth128 = treeOfDepth(128)
    const serialized = serializeP2mrDescriptor(depth128, false)
    expect(serializeP2mrDescriptor(parseP2mrDescriptor(serialized), false)).toBe(serialized)
    expect(p2mrRootFromDescriptor(depth128)).toEqual(p2mrRootFromDescriptor(serialized))

    // The string parser draws the line at the same depth.
    const leaf = `pk(${hexPubkey(1)})`
    const depth129String = `mr(${'{'.repeat(129)}${leaf}${`,${leaf}}`.repeat(129)})`
    expectDescriptorError(() => parseP2mrDescriptor(depth129String), TOO_DEEP)

    const depth129 = treeOfDepth(129)
    expectDescriptorError(() => serializeP2mrDescriptor(depth129), TOO_DEEP)
    expectDescriptorError(() => p2mrAddressFromDescriptor(depth129, 'regtest'), TOO_DEEP)
    expectDescriptorError(() => hasP2mrStandardSatisfaction(depth129), TOO_DEEP)

    // Recursion overflowed the stack here with a bare RangeError.
    const depth50000 = treeOfDepth(50_000)
    expectDescriptorError(() => p2mrRootFromDescriptor(depth50000), TOO_DEEP)
    expectDescriptorError(() => serializeP2mrDescriptor(depth50000), TOO_DEEP)

    const cyclic: Record<string, unknown> = { type: 'branch', right: pkLeaf(1) }
    cyclic['left'] = cyclic
    const cyclicDescriptor = { type: 'mr', tree: cyclic } as unknown as ParsedP2mrDescriptor
    expectDescriptorError(() => p2mrRootFromDescriptor(cyclicDescriptor), TOO_DEEP)
  })

  it('re-validates pqc() keys in descriptor objects with the string parser', () => {
    const qpub = extendedPubkey(qbitNetworks.mainnet.bip32.public)
    const descriptor = `mr(pk(pqc([0badf00d/87h/0h/0h]${qpub}/0/*)))`
    const parsed = parseP2mrDescriptor(descriptor)
    expect(serializeP2mrDescriptor(parsed, false)).toBe(descriptor)
    if (parsed.type !== 'mr' || parsed.tree.type !== 'pqc') throw new Error('expected pqc descriptor')
    const key = parsed.tree.key

    for (const badKey of [
      { ...key, key: 'not-a-bip32-key' },
      { ...key, key: `${qpub})` },
      { ...key, path: ['0', 'x'] },
      { ...key, path: ['*', '0'] },
      { ...key, path: '0/*' },
      { ...key, origin: { fingerprint: 'xyz', path: [] } },
      { ...key, origin: { fingerprint: '0badf00d', path: ['*'] } },
      { ...key, origin: 'deadbeef' },
      undefined,
    ]) {
      const bad = { type: 'mr', tree: { type: 'pqc', key: badKey } } as unknown as ParsedP2mrDescriptor
      expectDescriptorError(() => serializeP2mrDescriptor(bad))
      expectDescriptorError(() => hasP2mrStandardSatisfaction(bad))
    }
  })

  it('still formats importdescriptors entries for ranged trees with a k > 35 leaf', () => {
    const qpub = extendedPubkey(qbitNetworks.mainnet.bip32.public)
    expect(qpub.startsWith('qpub')).toBe(true)
    const external = `mr({pk(pqc(${qpub}/0/*)),${multiA(36)}})`
    const internal = `mr({pk(pqc(${qpub}/1/*)),${multiA(36)}})`
    const entries = formatP2mrImportDescriptors({ external, internal }, [0, 20])

    expect(entries).toHaveLength(2)
    expect(entries[0]).toMatchObject({ desc: addDescriptorChecksum(external), internal: false })
    expect(entries[1]).toMatchObject({ desc: addDescriptorChecksum(internal), internal: true })
  })
})

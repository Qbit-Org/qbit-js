import { describe, expect, it } from 'vitest'

import {
  OP_CHECKSIGPQC,
  OP_NUMEQUAL,
  P2MR_LEAF_VERSION_V1,
  buildControlBlock,
  bytesToHex,
  hexToBytes,
  merkleRootFromPath,
  multiALeafScript,
  p2mrAddressFromPubkey,
  p2mrBranchHash,
  p2mrLeafHash,
  singleKeyLeafScript,
  verifyControlBlock,
} from '../src/index'

const PK_A = hexToBytes('000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f')
const PK_B = hexToBytes('f0e1d2c3b4a5968778695a4b3c2d1e0f00112233445566778899aabbccddeeff')
const SIBLING = hexToBytes('202122232425262728292a2b2c2d2e2f303132333435363738393a3b3c3d3e3f')

describe('P2MR script and tree primitives', () => {
  it('builds the Core single-key leaf script shape', () => {
    const script = singleKeyLeafScript(PK_A)

    expect(script).toHaveLength(34)
    expect(script[0]).toBe(32)
    expect(script[33]).toBe(OP_CHECKSIGPQC)
    expect(bytesToHex(script)).toBe(`${bytesToHex(Uint8Array.of(32))}${bytesToHex(PK_A)}b3`)
  })

  it('computes single-key P2MR addresses deterministically', () => {
    expect(p2mrAddressFromPubkey(PK_A, 'regtest')).toMatch(/^qbrt1z/)
    expect(p2mrAddressFromPubkey(PK_A, 'regtest')).toBe(p2mrAddressFromPubkey(PK_A, 'regtest'))
    expect(p2mrAddressFromPubkey(PK_A, 'regtest')).not.toBe(p2mrAddressFromPubkey(PK_B, 'regtest'))
  })

  it('hashes branches lexicographically independent of input order', () => {
    const hashA = p2mrLeafHash(P2MR_LEAF_VERSION_V1, singleKeyLeafScript(PK_A))
    const hashB = p2mrLeafHash(P2MR_LEAF_VERSION_V1, singleKeyLeafScript(PK_B))

    expect(bytesToHex(p2mrBranchHash(hashA, hashB))).toBe(bytesToHex(p2mrBranchHash(hashB, hashA)))
  })

  it('builds and verifies one-byte and sibling control blocks', () => {
    const leafHash = p2mrLeafHash(P2MR_LEAF_VERSION_V1, singleKeyLeafScript(PK_A))
    const singleControl = buildControlBlock(P2MR_LEAF_VERSION_V1)

    expect(bytesToHex(singleControl)).toBe('c1')
    expect(bytesToHex(verifyControlBlock(singleControl, leafHash, P2MR_LEAF_VERSION_V1))).toBe(
      bytesToHex(leafHash)
    )

    const siblingControl = buildControlBlock(P2MR_LEAF_VERSION_V1, [SIBLING])
    expect(bytesToHex(verifyControlBlock(siblingControl, leafHash))).toBe(
      bytesToHex(merkleRootFromPath(leafHash, [SIBLING]))
    )
  })

  it('builds multi_a leaf scripts with CHECKSIGPQC/CHECKSIGADD and NUMEQUAL', () => {
    const script = multiALeafScript(2, [PK_A, PK_B])

    expect(script[0]).toBe(32)
    expect(script[33]).toBe(OP_CHECKSIGPQC)
    expect(script[34]).toBe(32)
    expect(script[67]).toBe(0xba)
    expect(script[68]).toBe(0x52)
    expect(script[69]).toBe(OP_NUMEQUAL)
  })
})

import { describe, expect, it, vi } from 'vitest'

import {
  PQC_SIGNATURE_BYTES,
  QbitProtocolError,
  bytesToHex,
  createP2mrMessageProof,
  hexToBytes,
  p2mrAddressFromPubkey,
  qbitWalletMessageHash,
  verifyP2mrMessageProof,
} from '../src/index'

const PUBKEY = hexToBytes('11'.repeat(32))
const SIGNATURE = new Uint8Array(PQC_SIGNATURE_BYTES).fill(0x5a)
const ADDRESS = p2mrAddressFromPubkey(PUBKEY, 'regtest')

function expectInvalidBytes(fn: () => unknown): void {
  let thrown: unknown
  try {
    fn()
  } catch (error) {
    thrown = error
  }
  expect(thrown).toBeInstanceOf(QbitProtocolError)
  expect((thrown as QbitProtocolError).code).toBe('INVALID_BYTES')
}

describe('P2MR message hash UTF-16 well-formedness', () => {
  it.each([
    ['a lone high surrogate mid-string', 'pay \uD800 to bob'],
    ['a lone low surrogate', '\uDFFF'],
    ['a trailing high surrogate', 'hi \uD83D'],
    ['a reversed surrogate pair', '\uDE00\uD83D'],
  ])('rejects %s', (_case, message) => {
    expectInvalidBytes(() => qbitWalletMessageHash(message))
  })

  it('rejects a lone surrogate parsed from JSON', () => {
    expectInvalidBytes(() => qbitWalletMessageHash(JSON.parse('"\\ud800"') as string))
  })

  it.each([
    [
      'a surrogate pair',
      '\u{1F600}',
      '220d20e8cb7a5965d4f23f44e32c806fa45fa48d9697fc4e3f9288aa1a47fc58',
    ],
    ['U+FFFD', '�', 'ccb5d2a228c2d17a8cd14c810b0650e279e8d8ffd736fb4c8c736ebfea1d2b85'],
    [
      'U+FFFD mid-string',
      'pay � to bob',
      'e19e8eec2f1cb4ce66c1070e00176620fbc389d6558468e9ecfa4161e89d20ff',
    ],
  ])('still hashes %s to its UTF-8 digest', (_case, message, digest) => {
    expect(bytesToHex(qbitWalletMessageHash(message))).toBe(digest)
  })

  it('does not verify a U+FFFD proof for a lone-surrogate message', () => {
    const proofForFffd = createP2mrMessageProof({
      message: 'pay � to bob',
      address: ADDRESS,
      pubkey: PUBKEY,
      signature: SIGNATURE,
    })
    const verifyPqc = vi.fn(() => true)

    expect(verifyP2mrMessageProof('pay � to bob', proofForFffd, verifyPqc, { expectedAddress: ADDRESS })).toBe(true)
    verifyPqc.mockClear()
    expect(verifyP2mrMessageProof('pay \uD800 to bob', proofForFffd, verifyPqc, { expectedAddress: ADDRESS })).toBe(false)
    expect(verifyPqc).not.toHaveBeenCalled()
  })

  it('refuses to create a proof for a lone-surrogate message', () => {
    expectInvalidBytes(() =>
      createP2mrMessageProof({
        message: 'pay \uD800 to bob',
        address: ADDRESS,
        pubkey: PUBKEY,
        signature: SIGNATURE,
      })
    )
  })
})

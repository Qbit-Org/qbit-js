import { describe, expect, it, vi } from 'vitest'

import {
  PQC_SIGNATURE_BYTES,
  bytesToHex,
  createP2mrMessageProof,
  hexToBytes,
  p2mrAddressFromPubkey,
  qbitDataSigPqcHash,
  qbitNetworks,
  qbitWalletMessageHash,
  verifyP2mrMessageProof,
  type P2mrMessageProof,
  type P2mrPqcVerifyFn,
  type VerifyP2mrMessageProofOptions,
} from '../src/index'

const MESSAGE = 'hello p2mr'
const PUBKEY = hexToBytes('11'.repeat(32))
const OTHER_PUBKEY = hexToBytes('22'.repeat(32))
const SIGNATURE = new Uint8Array(PQC_SIGNATURE_BYTES).fill(0x5a)

function validProof(): P2mrMessageProof {
  return createP2mrMessageProof({
    message: MESSAGE,
    address: p2mrAddressFromPubkey(PUBKEY, 'regtest'),
    pubkey: PUBKEY,
    signature: SIGNATURE,
  })
}

function fixtureVerifier(): P2mrPqcVerifyFn {
  const expectedDigest = bytesToHex(qbitDataSigPqcHash(qbitWalletMessageHash(MESSAGE)))
  return (pubkey, digest, signature) =>
    bytesToHex(pubkey) === bytesToHex(PUBKEY) &&
    bytesToHex(digest) === expectedDigest &&
    bytesToHex(signature) === bytesToHex(SIGNATURE)
}

describe('P2MR message proofs', () => {
  it('matches the wallet and data-signature tagged-hash vectors', () => {
    const messageHash = qbitWalletMessageHash(MESSAGE)

    expect(bytesToHex(messageHash)).toBe(
      '07987083bbf212a3d5e2956bc6454958a3b6992b1fa86ffe828a212f773da47e'
    )
    expect(bytesToHex(qbitDataSigPqcHash(messageHash))).toBe(
      '74acdbd7c47e61f31d09c5e9092a251f14cadbe23c4dba168aea1868d72ff87e'
    )
  })

  it('matches the qbit Core QbitDataSigPQC vector', () => {
    const messageHash = hexToBytes(
      '000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f'
    )

    expect(bytesToHex(qbitDataSigPqcHash(messageHash))).toBe(
      '892da4f0deede06b7aa1721ae45968148b1e7d88e164dcf73dfac5be497d410f'
    )
  })

  it('constructs and verifies a structured single-key proof', () => {
    const verifyPqc = vi.fn(fixtureVerifier())
    const proof = validProof()

    expect(proof).toMatchObject({
      type: 'p2mr-message',
      version: 1,
      address: p2mrAddressFromPubkey(PUBKEY, 'regtest'),
      domain: 'QbitDataSigPQC',
      message_domain: 'QbitWalletSignedMessage',
      algorithm: 'SLH-DSA-SHA2-128s-bounded30',
      proof_mode: 'p2mr-pubkey',
      pubkey: bytesToHex(PUBKEY),
      signature: bytesToHex(SIGNATURE),
      leaf_version: 0xc0,
      control_block: 'c1',
    })
    expect(verifyP2mrMessageProof(MESSAGE, proof, verifyPqc, { expectedNetwork: 'regtest' })).toBe(
      true
    )
    expect(verifyPqc).toHaveBeenCalledOnce()
  })

  it.each([
    ['unsupported version', { ...validProof(), version: 2 }],
    [
      'truncated signature',
      { ...validProof(), signature: validProof().signature.slice(0, -2) },
    ],
    [
      'uppercase hex',
      { ...validProof(), signature: validProof().signature.toUpperCase() },
    ],
  ])('rejects %s before PQC verification', (_case, proof) => {
    const verifyPqc = vi.fn(fixtureVerifier())

    expect(verifyP2mrMessageProof(MESSAGE, proof, verifyPqc, { expectedNetwork: 'regtest' })).toBe(
      false
    )
    expect(verifyPqc).not.toHaveBeenCalled()
  })

  it.each([
    ['message', 'different message', validProof()],
    [
      'address',
      MESSAGE,
      { ...validProof(), address: p2mrAddressFromPubkey(OTHER_PUBKEY, 'regtest') },
    ],
    ['pubkey', MESSAGE, { ...validProof(), pubkey: bytesToHex(OTHER_PUBKEY) }],
    ['signature', MESSAGE, { ...validProof(), signature: `00${validProof().signature.slice(2)}` }],
    ['leaf script', MESSAGE, { ...validProof(), leaf_script: `20${bytesToHex(OTHER_PUBKEY)}b3` }],
    ['control block', MESSAGE, { ...validProof(), control_block: 'c3' }],
    [
      'merkle root',
      MESSAGE,
      { ...validProof(), p2mr_merkle_root: `00${validProof().p2mr_merkle_root.slice(2)}` },
    ],
  ])('rejects a tampered %s', (_field, message, proof) => {
    expect(
      verifyP2mrMessageProof(message, proof, fixtureVerifier(), { expectedNetwork: 'regtest' })
    ).toBe(false)
  })

  it('rejects proof construction when the control commitment and address differ', () => {
    expect(() =>
      createP2mrMessageProof({
        message: MESSAGE,
        address: p2mrAddressFromPubkey(OTHER_PUBKEY, 'regtest'),
        pubkey: PUBKEY,
        signature: SIGNATURE,
      })
    ).toThrow(/does not commit/)
  })
})

describe('P2MR message proof address binding', () => {
  const REGTEST_ADDRESS = p2mrAddressFromPubkey(PUBKEY, 'regtest')
  const MAINNET_ADDRESS = p2mrAddressFromPubkey(PUBKEY, 'mainnet')
  const TQ_ADDRESS = p2mrAddressFromPubkey(PUBKEY, 'testnet4')
  const OTHER_REGTEST_ADDRESS = p2mrAddressFromPubkey(OTHER_PUBKEY, 'regtest')
  // U+212A KELVIN SIGN lowercases to ASCII `k`. The bech32 decoder
  // rejects it as non-ASCII; these cases pin that it never verifies.
  const KELVIN_ADDRESS = REGTEST_ADDRESS.replace('k', '\u212a')
  const OPTIONS_REQUIRED = /requires options with \{ expectedAddress \} and\/or \{ expectedNetwork \}/

  function proofFor(address: string): P2mrMessageProof {
    return createP2mrMessageProof({ message: MESSAGE, address, pubkey: PUBKEY, signature: SIGNATURE })
  }

  it('uses an address that can carry a Kelvin-sign look-alike', () => {
    expect(REGTEST_ADDRESS).toContain('k')
    expect(KELVIN_ADDRESS).not.toBe(REGTEST_ADDRESS)
    expect(KELVIN_ADDRESS.toLowerCase()).toBe(REGTEST_ADDRESS)
  })

  it('verifies a proof for its own address', () => {
    const proof = validProof()

    expect(
      verifyP2mrMessageProof(MESSAGE, proof, fixtureVerifier(), {
        expectedAddress: REGTEST_ADDRESS,
      })
    ).toBe(true)
    expect(
      verifyP2mrMessageProof(MESSAGE, proof, fixtureVerifier(), {
        expectedAddress: REGTEST_ADDRESS,
        expectedNetwork: 'regtest',
      })
    ).toBe(true)
    expect(
      verifyP2mrMessageProof(MESSAGE, proof, fixtureVerifier(), {
        expectedAddress: REGTEST_ADDRESS,
        expectedNetwork: qbitNetworks.regtest,
      })
    ).toBe(true)
    expect(
      verifyP2mrMessageProof(MESSAGE, proof, fixtureVerifier(), { expectedNetwork: 'regtest' })
    ).toBe(true)
  })

  it('accepts any valid spelling of the expected address supplied by the relying party', () => {
    const proof = validProof()

    expect(
      verifyP2mrMessageProof(MESSAGE, proof, fixtureVerifier(), {
        expectedAddress: REGTEST_ADDRESS.toUpperCase(),
      })
    ).toBe(true)
  })

  it.each([
    ['the mainnet spelling of the same root', MAINNET_ADDRESS],
    ['the testnet4 spelling of the same root', TQ_ADDRESS],
    ['the uppercase spelling', REGTEST_ADDRESS.toUpperCase()],
    ['a Kelvin-sign look-alike spelling', KELVIN_ADDRESS],
    ['a different address', OTHER_REGTEST_ADDRESS],
  ])('rejects a proof whose address was swapped to %s before PQC verification', (_case, address) => {
    const proof = { ...validProof(), address }
    const verifyPqc = vi.fn(fixtureVerifier())

    expect(
      verifyP2mrMessageProof(MESSAGE, proof, verifyPqc, { expectedAddress: REGTEST_ADDRESS })
    ).toBe(false)
    expect(
      verifyP2mrMessageProof(MESSAGE, proof, verifyPqc, { expectedNetwork: 'regtest' })
    ).toBe(false)
    expect(verifyPqc).not.toHaveBeenCalled()
  })

  it.each([
    ['the same root on another network', MAINNET_ADDRESS],
    ['a different address', OTHER_REGTEST_ADDRESS],
    ['an address on another network', p2mrAddressFromPubkey(OTHER_PUBKEY, 'mainnet')],
  ])('rejects a valid proof when the relying party expects %s', (_case, expectedAddress) => {
    const verifyPqc = vi.fn(fixtureVerifier())

    expect(verifyP2mrMessageProof(MESSAGE, validProof(), verifyPqc, { expectedAddress })).toBe(false)
    expect(verifyPqc).not.toHaveBeenCalled()
  })

  it('rejects a valid proof when the relying party expects another network', () => {
    const verifyPqc = vi.fn(fixtureVerifier())

    for (const expectedNetwork of ['mainnet', 'testnet4', 'signet'] as const) {
      expect(
        verifyP2mrMessageProof(MESSAGE, validProof(), verifyPqc, { expectedNetwork })
      ).toBe(false)
      expect(
        verifyP2mrMessageProof(MESSAGE, validProof(), verifyPqc, {
          expectedAddress: REGTEST_ADDRESS,
          expectedNetwork,
        })
      ).toBe(false)
    }
    expect(verifyPqc).not.toHaveBeenCalled()
  })

  it('binds a proof to its network across all networks', () => {
    for (const network of ['mainnet', 'testnet4', 'signet', 'regtest'] as const) {
      const address = p2mrAddressFromPubkey(PUBKEY, network)
      const proof = proofFor(address)

      expect(
        verifyP2mrMessageProof(MESSAGE, proof, fixtureVerifier(), {
          expectedAddress: address,
          expectedNetwork: network,
        })
      ).toBe(true)
      expect(verifyP2mrMessageProof(MESSAGE, proof, fixtureVerifier(), { expectedNetwork: network })).toBe(
        true
      )
      expect(
        verifyP2mrMessageProof(MESSAGE, proof, fixtureVerifier(), {
          expectedAddress: p2mrAddressFromPubkey(PUBKEY, network === 'regtest' ? 'mainnet' : 'regtest'),
        })
      ).toBe(false)
    }
  })

  it('follows decodeP2mrAddress for the shared signet/testnet4 HRP', () => {
    const proof = proofFor(TQ_ADDRESS)

    // Signet and Testnet4 share `tq`, so `expectedNetwork` cannot tell them apart.
    expect(
      verifyP2mrMessageProof(MESSAGE, proof, fixtureVerifier(), {
        expectedAddress: TQ_ADDRESS,
        expectedNetwork: 'signet',
      })
    ).toBe(true)
    expect(
      verifyP2mrMessageProof(MESSAGE, proof, fixtureVerifier(), { expectedNetwork: 'signet' })
    ).toBe(true)
    expect(
      verifyP2mrMessageProof(MESSAGE, proof, fixtureVerifier(), { expectedNetwork: 'testnet4' })
    ).toBe(true)
    expect(
      verifyP2mrMessageProof(MESSAGE, proof, fixtureVerifier(), { expectedNetwork: 'regtest' })
    ).toBe(false)
  })

  it('fails closed when the expectation itself is inconsistent with the expected network', () => {
    const verifyPqc = vi.fn(fixtureVerifier())

    expect(
      verifyP2mrMessageProof(MESSAGE, validProof(), verifyPqc, {
        expectedAddress: MAINNET_ADDRESS,
        expectedNetwork: 'regtest',
      })
    ).toBe(false)
    expect(verifyPqc).not.toHaveBeenCalled()
  })

  it.each([
    ['an empty expected address', { expectedAddress: '' }],
    ['a malformed expected address', { expectedAddress: 'not-an-address' }],
    ['a non-string expected address', { expectedAddress: 42 }],
    ['an unknown expected network', { expectedNetwork: 'bogus' }],
    ['a null expected network', { expectedNetwork: null }],
    ['a numeric expected network', { expectedNetwork: 1 }],
    ['network params with a foreign HRP', { expectedNetwork: { ...qbitNetworks.regtest, bech32Hrp: 'bc' } }],
  ])('fails closed for %s', (_case, options) => {
    const verifyPqc = vi.fn(fixtureVerifier())

    expect(
      verifyP2mrMessageProof(
        MESSAGE,
        validProof(),
        verifyPqc,
        options as unknown as VerifyP2mrMessageProofOptions
      )
    ).toBe(false)
    expect(verifyPqc).not.toHaveBeenCalled()
  })

  it('throws TypeError for a three-argument call', () => {
    const verifyPqc = vi.fn(fixtureVerifier())

    // @ts-expect-error `options` is required
    const call = () => verifyP2mrMessageProof(MESSAGE, validProof(), verifyPqc)
    expect(call).toThrow(TypeError)
    expect(call).toThrow(OPTIONS_REQUIRED)
    // Misuse is reported even when the proof itself would fail verification.
    // @ts-expect-error `options` is required
    expect(() => verifyP2mrMessageProof(MESSAGE, {}, verifyPqc)).toThrow(TypeError)
    expect(verifyPqc).not.toHaveBeenCalled()
  })

  it.each([
    ['explicitly undefined options', undefined],
    ['null options', null],
    ['an empty options object', {}],
    ['options with both expectations undefined', { expectedAddress: undefined, expectedNetwork: undefined }],
    ['string options', REGTEST_ADDRESS],
    ['numeric options', 1],
    ['array options', [REGTEST_ADDRESS]],
  ])('throws TypeError for %s', (_case, options) => {
    const verifyPqc = vi.fn(fixtureVerifier())
    const call = () =>
      verifyP2mrMessageProof(
        MESSAGE,
        validProof(),
        verifyPqc,
        options as unknown as VerifyP2mrMessageProofOptions
      )

    expect(call).toThrow(TypeError)
    expect(call).toThrow(OPTIONS_REQUIRED)
    expect(verifyPqc).not.toHaveBeenCalled()
  })

  it('throws TypeError when the fourth argument is passed but undefined (untyped JS)', () => {
    const verifyPqc = vi.fn(fixtureVerifier())
    const config = {} as { expect?: VerifyP2mrMessageProofOptions }
    const reSpelledOnMainnet = { ...validProof(), address: MAINNET_ADDRESS }

    // `verifyP2mrMessageProof(m, p, v, cfg.expect)` with `cfg.expect` missing must not
    // fall through to an unbound check and accept the re-spelled address.
    expect(() =>
      verifyP2mrMessageProof(
        MESSAGE,
        reSpelledOnMainnet,
        verifyPqc,
        config.expect as VerifyP2mrMessageProofOptions
      )
    ).toThrow(TypeError)
    expect(verifyPqc).not.toHaveBeenCalled()
  })

  it('reads the expectation once, so a getter cannot pass the check and then unbind it', () => {
    const verifyPqc = vi.fn(fixtureVerifier())
    const reSpelledOnMainnet = { ...validProof(), address: MAINNET_ADDRESS }
    let reads = 0
    const flaky = {
      get expectedAddress() {
        reads += 1
        return reads === 1 ? REGTEST_ADDRESS : undefined
      },
    } as VerifyP2mrMessageProofOptions

    expect(verifyP2mrMessageProof(MESSAGE, reSpelledOnMainnet, verifyPqc, flaky)).toBe(false)
    expect(reads).toBe(1)
    expect(verifyPqc).not.toHaveBeenCalled()
  })

  it('rejects a proof carrying an uppercase address, as createP2mrMessageProof emitted before this fix', () => {
    // Before this fix, createP2mrMessageProof copied the caller's address verbatim, so a proof
    // created from an uppercase address carried `QBRT1...` and verified. It is now
    // rejected and must be re-created.
    const legacyProof: P2mrMessageProof = { ...validProof(), address: REGTEST_ADDRESS.toUpperCase() }
    const verifyPqc = vi.fn(fixtureVerifier())

    expect(
      verifyP2mrMessageProof(MESSAGE, legacyProof, verifyPqc, { expectedAddress: REGTEST_ADDRESS })
    ).toBe(false)
    expect(
      verifyP2mrMessageProof(MESSAGE, legacyProof, verifyPqc, {
        expectedAddress: REGTEST_ADDRESS.toUpperCase(),
      })
    ).toBe(false)
    expect(
      verifyP2mrMessageProof(MESSAGE, legacyProof, verifyPqc, { expectedNetwork: 'regtest' })
    ).toBe(false)
    expect(verifyPqc).not.toHaveBeenCalled()

    const recreated = proofFor(legacyProof.address)
    expect(recreated.address).toBe(REGTEST_ADDRESS)
    expect(
      verifyP2mrMessageProof(MESSAGE, recreated, fixtureVerifier(), {
        expectedAddress: legacyProof.address,
        expectedNetwork: 'regtest',
      })
    ).toBe(true)
  })

  it('emits the canonical lowercase address when constructing a proof', () => {
    const proof = proofFor(REGTEST_ADDRESS.toUpperCase())

    expect(proof.address).toBe(REGTEST_ADDRESS)
    expect(
      verifyP2mrMessageProof(MESSAGE, proof, fixtureVerifier(), { expectedAddress: REGTEST_ADDRESS })
    ).toBe(true)
    expect(
      verifyP2mrMessageProof(MESSAGE, proof, fixtureVerifier(), { expectedNetwork: 'regtest' })
    ).toBe(true)
  })

  it('round-trips a JSON-serialized proof through address-bound verification', () => {
    const proof = JSON.parse(JSON.stringify(validProof())) as unknown

    expect(
      verifyP2mrMessageProof(MESSAGE, proof, fixtureVerifier(), {
        expectedAddress: REGTEST_ADDRESS,
        expectedNetwork: 'regtest',
      })
    ).toBe(true)
  })
})

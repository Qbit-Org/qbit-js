import { describe, expect, it } from 'vitest'

import {
  PQC_SIGNATURE_BYTES,
  QbitProtocolError,
  addressToScriptPubKey,
  bytesToHex,
  createP2mrMessageProof,
  decodeP2mrAddress,
  encodeP2mrAddress,
  formatQbitUri,
  hexToBytes,
  p2mrAddressFromPubkey,
  p2mrAddressFromRoot,
  parseQbitUri,
  qbitDataSigPqcHash,
  qbitNetworks,
  qbitWalletMessageHash,
  verifyP2mrMessageProof,
  type P2mrPqcVerifyFn,
  type QbitNetworkName,
} from '../src/index'

const RAW_ROOT = hexToBytes('000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f')
const MAINNET_ADDRESS = 'qb1zqqqsyqcyq5rqwzqfpg9scrgwpugpzysnzs23v9ccrydpk8qarc0sjq57mw'
// U+212A KELVIN SIGN renders like "K" and case-folds to ASCII "k", a bech32 charset letter.
const KELVIN_SIGN = 'K'
const NETWORKS: readonly QbitNetworkName[] = ['mainnet', 'testnet4', 'signet', 'regtest']

function thrownCode(fn: () => unknown): string | undefined {
  try {
    fn()
  } catch (error) {
    if (error instanceof QbitProtocolError) return error.code
    throw error
  }
  return undefined
}

function kelvinSpelling(address: string): string {
  expect(address).toContain('k')
  const spoofed = address.replace('k', KELVIN_SIGN)
  // The look-alike is a different string that Unicode-lowercases back to the real address.
  expect(spoofed).not.toBe(address)
  expect(spoofed.toLowerCase()).toBe(address)
  return spoofed
}

/** Encode RAW_ROOT as a bech32m string under an arbitrary HRP to probe the bech32 layer. */
function addressWithHrp(bech32Hrp: string): string {
  return encodeP2mrAddress(RAW_ROOT, { ...qbitNetworks.mainnet, bech32Hrp })
}

describe('bech32 decoder input boundaries', () => {
  it('rejects the Kelvin-sign look-alike spelling at every address entry point', () => {
    const spoofed = kelvinSpelling(MAINNET_ADDRESS)

    expect(thrownCode(() => decodeP2mrAddress(spoofed))).toBe('INVALID_BECH32')
    expect(thrownCode(() => decodeP2mrAddress(spoofed, 'mainnet'))).toBe('INVALID_BECH32')
    expect(thrownCode(() => addressToScriptPubKey(spoofed, 'mainnet'))).toBe('INVALID_BECH32')
    expect(thrownCode(() => parseQbitUri(`qbit:${spoofed}`, 'mainnet'))).toBe('INVALID_BECH32')
    expect(thrownCode(() => parseQbitUri(`qbit:${spoofed}?amount=1`))).toBe('INVALID_BECH32')
    expect(thrownCode(() => formatQbitUri({ address: spoofed }))).toBe('INVALID_BECH32')
  })

  it('rejects the Kelvin sign combined with uppercase ASCII', () => {
    const upper = MAINNET_ADDRESS.toUpperCase()
    expect(upper).toContain('K')
    const spoofed = upper.replace('K', KELVIN_SIGN)
    expect(spoofed.toLowerCase()).toBe(MAINNET_ADDRESS)

    expect(thrownCode(() => decodeP2mrAddress(spoofed))).toBe('INVALID_BECH32')
    expect(thrownCode(() => decodeP2mrAddress(spoofed, 'mainnet'))).toBe('INVALID_BECH32')
  })

  it('rejects a message proof whose address uses the look-alike spelling', () => {
    const message = 'hello p2mr'
    const pubkey = hexToBytes('11'.repeat(32))
    const signature = new Uint8Array(PQC_SIGNATURE_BYTES).fill(0x5a)
    const address = p2mrAddressFromPubkey(pubkey, 'regtest')
    const proof = createP2mrMessageProof({ message, address, pubkey, signature })
    const expectedDigest = bytesToHex(qbitDataSigPqcHash(qbitWalletMessageHash(message)))
    const verifyPqc: P2mrPqcVerifyFn = (candidatePubkey, digest, candidateSig) =>
      bytesToHex(candidatePubkey) === bytesToHex(pubkey) &&
      bytesToHex(digest) === expectedDigest &&
      bytesToHex(candidateSig) === bytesToHex(signature)

    expect(verifyP2mrMessageProof(message, proof, verifyPqc, { expectedAddress: address })).toBe(true)
    expect(
      verifyP2mrMessageProof(message, { ...proof, address: kelvinSpelling(address) }, verifyPqc, {
        expectedAddress: address,
      })
    ).toBe(false)
  })

  it('rejects non-ASCII, whitespace, and control characters anywhere in the string', () => {
    const samples = [
      'İ', // LATIN CAPITAL LETTER I WITH DOT ABOVE
      '​', // ZERO WIDTH SPACE
      '‍', // ZERO WIDTH JOINER
      '﻿', // ZERO WIDTH NO-BREAK SPACE / BOM
      ' ', // NO-BREAK SPACE
      '\u{1f600}', // astral code point (surrogate pair)
      ' ',
      '\t',
      '\n',
      '\u0000',
      '\u007f', // DEL, first code unit above the printable range
    ]
    const upper = MAINNET_ADDRESS.toUpperCase()

    for (const sample of samples) {
      const variants = [
        `${sample}${MAINNET_ADDRESS}`,
        `${MAINNET_ADDRESS}${sample}`,
        `${MAINNET_ADDRESS.slice(0, 1)}${sample}${MAINNET_ADDRESS.slice(1)}`,
        `${MAINNET_ADDRESS.slice(0, 10)}${sample}${MAINNET_ADDRESS.slice(10)}`,
        `${upper.slice(0, 10)}${sample}${upper.slice(10)}`,
      ]
      for (const variant of variants) {
        expect(
          thrownCode(() => decodeP2mrAddress(variant)),
          JSON.stringify(variant)
        ).toBe('INVALID_BECH32')
      }
    }
  })

  it('accepts the printable-ASCII boundary bytes and rejects their neighbours', () => {
    // "!" (0x21) and "~" (0x7e) are valid bech32 HRP characters; the bech32 layer accepts
    // them and only the P2MR HRP check fails.
    const boundaryHrp = addressWithHrp('!~')
    expect(thrownCode(() => decodeP2mrAddress(boundaryHrp))).toBe('WRONG_HRP')

    expect(thrownCode(() => decodeP2mrAddress(boundaryHrp.replace('!', ' ')))).toBe('INVALID_BECH32')
    expect(thrownCode(() => decodeP2mrAddress(boundaryHrp.replace('~', '\u007f')))).toBe('INVALID_BECH32')
  })

  it('rejects mixed-case ASCII spellings', () => {
    const upper = MAINNET_ADDRESS.toUpperCase()

    expect(thrownCode(() => decodeP2mrAddress(`Q${MAINNET_ADDRESS.slice(1)}`))).toBe('INVALID_BECH32')
    expect(thrownCode(() => decodeP2mrAddress(`${upper.slice(0, -1)}w`))).toBe('INVALID_BECH32')
    const innerUpper = `${MAINNET_ADDRESS.slice(0, 3)}Z${MAINNET_ADDRESS.slice(4)}`
    expect(thrownCode(() => decodeP2mrAddress(innerUpper))).toBe('INVALID_BECH32')
  })

  it('enforces the 90-character BIP173 limit before checksum validation', () => {
    // 30-character HRP + "1" + 1 version + 52 program + 6 checksum characters = 90.
    const ninety = addressWithHrp('q'.repeat(30))
    const ninetyOne = addressWithHrp('q'.repeat(31))
    expect(ninety).toHaveLength(90)
    expect(ninetyOne).toHaveLength(91)

    // Exactly 90 characters clears the bech32 layer; only the P2MR HRP check fails.
    expect(thrownCode(() => decodeP2mrAddress(ninety))).toBe('WRONG_HRP')
    // 91 characters is rejected even though its bech32m checksum is valid.
    expect(thrownCode(() => decodeP2mrAddress(ninetyOne))).toBe('INVALID_BECH32')
    expect(thrownCode(() => decodeP2mrAddress(ninetyOne.toUpperCase()))).toBe('INVALID_BECH32')
    expect(thrownCode(() => parseQbitUri(`qbit:${ninetyOne}`))).toBe('INVALID_BECH32')

    expect(thrownCode(() => decodeP2mrAddress(`${MAINNET_ADDRESS}${'q'.repeat(30)}`))).toBe('INVALID_BECH32')
    expect(thrownCode(() => decodeP2mrAddress('q'.repeat(4096)))).toBe('INVALID_BECH32')
  })

  it('rejects empty and separator-less input', () => {
    expect(thrownCode(() => decodeP2mrAddress(''))).toBe('INVALID_BECH32')
    expect(thrownCode(() => decodeP2mrAddress('qb'))).toBe('INVALID_BECH32')
    expect(thrownCode(() => decodeP2mrAddress(MAINNET_ADDRESS.replace('1', '')))).toBe('INVALID_BECH32')
    expect(thrownCode(() => decodeP2mrAddress(`1${MAINNET_ADDRESS.slice(3)}`))).toBe('INVALID_BECH32')
  })

  it('still decodes canonical lowercase and all-uppercase spellings on every network', () => {
    for (const network of NETWORKS) {
      const address = p2mrAddressFromRoot(RAW_ROOT, network)
      const upper = address.toUpperCase()
      expect(upper).not.toBe(address)

      for (const spelling of [address, upper]) {
        const decoded = decodeP2mrAddress(spelling, network)
        expect(decoded.hrp).toBe(qbitNetworks[network].bech32Hrp)
        expect(decoded.network).toBe(network)
        expect(bytesToHex(decoded.program)).toBe(bytesToHex(RAW_ROOT))
        expect(bytesToHex(addressToScriptPubKey(spelling, network))).toBe(
          bytesToHex(addressToScriptPubKey(address, network))
        )
        expect(parseQbitUri(`qbit:${spelling}`, network).network).toBe(network)
      }
    }

    expect(decodeP2mrAddress(MAINNET_ADDRESS.toUpperCase()).hrp).toBe('qb')
  })
})

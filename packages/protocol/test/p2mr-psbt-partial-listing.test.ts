import { describe, expect, it, vi } from 'vitest'

import listing from '../fixtures/p2mr-partial-listing.json'
import {
  PQC_SIGNATURE_BYTES,
  PSBT_IN_WITNESS_UTXO,
  p2mrSighash,
  psbtUnsignedTransaction,
  PSBT_IN_P2MR_SCRIPT_SIG,
  PSBT_IN_SIGHASH_TYPE,
  QbitProtocolError,
  SIGHASH_ALL,
  SIGHASH_ANYONECANPAY,
  SIGHASH_DEFAULT,
  SIGHASH_NONE,
  SIGHASH_SINGLE,
  bytesToHex,
  decodePsbt,
  extractP2mrTransaction,
  finalizeP2mrPsbt,
  hexToBytes,
  parsePsbt,
  signP2mrPsbt,
  validateP2mrSigningPlans,
  type Psbt,
} from '../src/index'

// A PSBT that is still being built can have outputs above its inputs: a seller
// signs one input and the output at its index with SIGHASH_SINGLE|ANYONECANPAY
// (0x83), and the buyer adds the other inputs and outputs. The vectors come from
// a qbit Core v1.0.1 regtest run in which the completed transaction was accepted
// by `testmempoolaccept`, sent and mined (see `source.method` in the fixture).

const SINGLE_ANYONECANPAY = SIGHASH_SINGLE | SIGHASH_ANYONECANPAY

const inspect = { allowOutputsAboveInputs: true }
const signingOptions = { ...inspect, allowNonDefaultSighash: true }
// Generated independently using Qbit Core's P2MR functional-test framework.
const sellerDigest = listing.coreInputDigests.listingPsbtHex[0]!
const buyerDigest = listing.coreInputDigests.completionSignedPsbtHex[1]!

const signedListing = parsePsbt(hexToBytes(listing.listingPsbtHex))
const completion = parsePsbt(hexToBytes(listing.completionPsbtHex))
const completionSigned = parsePsbt(hexToBytes(listing.completionSignedPsbtHex))

const sellerSignature = decodePsbt(signedListing, inspect).inputs[0]!.scriptSigs[0]!
const { pubkey, leafHash } = sellerSignature

/**
 * The listing before the seller signed: every P2MR signature field removed, and
 * the PSBT_IN_SIGHASH_TYPE field too when `keepType` is false.
 */
function unsignedListing(keepType = true): Psbt {
  const copy = parsePsbt(hexToBytes(listing.listingPsbtHex))
  copy.inputs[0] = copy.inputs[0]!.filter(
    entry => entry.key[0] !== PSBT_IN_P2MR_SCRIPT_SIG && (keepType || entry.key[0] !== PSBT_IN_SIGHASH_TYPE)
  )
  return copy
}

function expectProtocolError(fn: () => unknown, code: QbitProtocolError['code'], message: RegExp): void {
  let caught: unknown
  try {
    fn()
  } catch (error) {
    caught = error
  }
  expect(caught).toBeInstanceOf(QbitProtocolError)
  expect((caught as QbitProtocolError).code).toBe(code)
  expect((caught as QbitProtocolError).message).toMatch(message)
}

const dummySignature = () => new Uint8Array(PQC_SIGNATURE_BYTES).fill(0x5a)

describe('decodePsbt on a one-input listing (outputs above inputs)', () => {
  it('reports the exact funding shortfall when inspecting a partial listing', () => {
    const summary = decodePsbt(signedListing, inspect)
    const spent = summary.inputs.reduce((sum, input) => sum + input.witnessUtxo!.value, 0n)
    const sent = summary.outputs.reduce((sum, output) => sum + output.value, 0n)
    expect(spent).toBe(BigInt(listing.expected.listing.inputValue))
    expect(sent).toBe(BigInt(listing.expected.listing.outputValue))
    expect(sent).toBeGreaterThan(spent)
    expect(summary.inputs).toHaveLength(1)
    expect(summary.outputs).toHaveLength(1)
    expect(summary.fee).toBeUndefined()
    expect(summary.shortfall).toBe(50_000n)
    expect(summary.inputs[0]!.sighashType).toBe(listing.sighashType)
    expect(sellerSignature.signature.hashType).toBe(SINGLE_ANYONECANPAY)
  })

  it('still reports the fee once the buyer has completed the transaction', () => {
    const [funded] = [completion].map(decodePsbt)
    expect(funded!.fee).toBe(BigInt(listing.expected.completion.fee))
    expect(decodePsbt(completionSigned).fee).toBe(BigInt(listing.expected.completion.fee))
  })

  it('verifies both funded digests and retains the seller signature', () => {
    const tx = psbtUnsignedTransaction(completionSigned)
    const { inputs, shortfall } = decodePsbt(completionSigned, inspect)
    expect(shortfall).toBeUndefined()
    const spentOutputs = inputs.map(input => input.witnessUtxo!)
    const digests = inputs.map((input, inputIndex) => {
      const sig = input.scriptSigs[0]!
      return bytesToHex(
        p2mrSighash({ tx, inputIndex, spentOutputs, leafHash: sig.leafHash, hashType: sig.signature.hashType })
      )
    })
    expect(digests).toEqual([sellerDigest, buyerDigest])
    expect(inputs[0]!.scriptSigs[0]).toEqual(sellerSignature)
  })

  it('requires opt-in and distinguishes a missing prevout from a known shortfall', () => {
    expectProtocolError(() => decodePsbt(signedListing), 'INVALID_AMOUNT', /exceeds total input value/)
    const partial = unsignedListing()
    partial.inputs[0] = partial.inputs[0]!.filter(entry => entry.key[0] !== PSBT_IN_WITNESS_UTXO)
    const summary = decodePsbt(partial, inspect)
    expect(summary).not.toHaveProperty('shortfall')
    expect(summary).not.toHaveProperty('fee')
  })

  it('finalizes and extracts the completed transaction that qbit Core mined', () => {
    const raw = bytesToHex(extractP2mrTransaction(finalizeP2mrPsbt(completionSigned)))
    expect(raw).toBe(listing.rawTxHex)
  })
})

describe('signing a listing whose outputs exceed its inputs', () => {
  it('signs SIGHASH_SINGLE|ANYONECANPAY with the sighash qbit Core checks', () => {
    const psbt = unsignedListing()
    expect(decodePsbt(psbt, inspect).fee).toBeUndefined()
    const sign = vi.fn((_digest: Uint8Array) => sellerSignature.signature.signature)
    const { psbt: signed } = signP2mrPsbt({
      psbt,
      keys: [{ inputIndex: 0, pubkey, leafHash, hashType: SINGLE_ANYONECANPAY }],
      sign,
      ...signingOptions,
    })
    expect(sign).toHaveBeenCalledTimes(1)
    expect(bytesToHex(sign.mock.calls[0]![0])).toBe(sellerDigest)
    expect(decodePsbt(signed, inspect).inputs[0]!.scriptSigs[0]!.signature.hashType).toBe(SINGLE_ANYONECANPAY)
  })

  it('reads the requested hash type once for both approval and signing', () => {
    const readType = vi.fn(() => SINGLE_ANYONECANPAY)
    const key = {
      inputIndex: 0,
      pubkey,
      leafHash,
      get hashType() {
        return readType()
      },
    }
    const sign = vi.fn(dummySignature)
    signP2mrPsbt({ psbt: unsignedListing(), keys: [key], sign, ...signingOptions })
    expect(readType).toHaveBeenCalledTimes(1)
    expect(sign).toHaveBeenCalledOnce()
  })

  it('also allows the other ANYONECANPAY types, which do not cover every input', () => {
    for (const hashType of [SIGHASH_ALL | SIGHASH_ANYONECANPAY, SIGHASH_NONE | SIGHASH_ANYONECANPAY]) {
      expect(() =>
        validateP2mrSigningPlans({
          psbt: unsignedListing(false),
          keys: [{ inputIndex: 0, pubkey, leafHash, hashType }],
          ...signingOptions,
        })
      ).not.toThrow()
    }
  })

  it.each([SIGHASH_DEFAULT, SIGHASH_ALL, SIGHASH_NONE, SIGHASH_SINGLE])(
    'refuses sighash type %d under partial-funding policy before the signer is called',
    hashType => {
      const sign = vi.fn(() => dummySignature())
      expectProtocolError(
        () =>
          signP2mrPsbt({
            psbt: unsignedListing(false),
            keys: [{ inputIndex: 0, pubkey, leafHash, hashType }],
            sign,
            ...signingOptions,
          }),
        'INVALID_AMOUNT',
        /total output value 60000 exceeds total input value 10000/
      )
      expect(sign).not.toHaveBeenCalled()
    }
  )

  it('keeps strict error precedence and consumes no signer use on ineligible requests', () => {
    const psbt = unsignedListing(false)
    const key = { inputIndex: 0, pubkey, leafHash, hashType: SINGLE_ANYONECANPAY }
    const sign = vi.fn(dummySignature)
    for (const params of [
      { keys: [key] },
      { keys: [key], allowNonDefaultSighash: true },
      { keys: [key], ...inspect },
      { keys: [], ...signingOptions },
      { keys: [key, { ...key, hashType: SIGHASH_ALL }], ...signingOptions },
      { keys: [{ ...key, hashType: 0x84 }], ...signingOptions },
      { keys: [{ ...key, pubkey: new Uint8Array() }] },
    ]) {
      expectProtocolError(() => signP2mrPsbt({ psbt, sign, ...params }), 'INVALID_AMOUNT', /exceeds total input value/)
      expectProtocolError(
        () => validateP2mrSigningPlans({ psbt, ...params }),
        'INVALID_AMOUNT',
        /exceeds total input value/
      )
    }
    expectProtocolError(
      () => signP2mrPsbt({ psbt, keys: [{ ...key, pubkey: new Uint8Array() }], sign, ...signingOptions }),
      'INVALID_BYTES',
      /pubkey/
    )
    expect(sign).not.toHaveBeenCalled()
  })

  it('refuses to finalize a PSBT whose outputs exceed its inputs', () => {
    expectProtocolError(() => finalizeP2mrPsbt(signedListing), 'INVALID_AMOUNT', /exceeds total input value/)
  })
})

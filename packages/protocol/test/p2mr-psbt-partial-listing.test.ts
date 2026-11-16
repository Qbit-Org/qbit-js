import { describe, expect, it, vi } from 'vitest'

import listing from '../fixtures/p2mr-partial-listing.json'
import {
  PQC_SIGNATURE_BYTES,
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
  p2mrSighash,
  parsePsbt,
  psbtUnsignedTransaction,
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

const signedListing = parsePsbt(hexToBytes(listing.listingPsbtHex))
const completion = parsePsbt(hexToBytes(listing.completionPsbtHex))
const completionSigned = parsePsbt(hexToBytes(listing.completionSignedPsbtHex))

const sellerSignature = decodePsbt(signedListing).inputs[0]!.scriptSigs[0]!
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
  it('decodes the regtest listing without a fee', () => {
    const summary = decodePsbt(signedListing)
    const spent = summary.inputs.reduce((sum, input) => sum + input.witnessUtxo!.value, 0n)
    const sent = summary.outputs.reduce((sum, output) => sum + output.value, 0n)
    expect(spent).toBe(BigInt(listing.expected.listing.inputValue))
    expect(sent).toBe(BigInt(listing.expected.listing.outputValue))
    expect(sent).toBeGreaterThan(spent)
    expect(summary.inputs).toHaveLength(1)
    expect(summary.outputs).toHaveLength(1)
    expect(summary.fee).toBeUndefined()
    expect(summary.inputs[0]!.sighashType).toBe(listing.sighashType)
    expect(sellerSignature.signature.hashType).toBe(SINGLE_ANYONECANPAY)
  })

  it('still reports the fee once the buyer has completed the transaction', () => {
    expect(decodePsbt(completion).fee).toBe(BigInt(listing.expected.completion.fee))
    expect(decodePsbt(completionSigned).fee).toBe(BigInt(listing.expected.completion.fee))
  })

  it('finalizes and extracts the completed transaction that qbit Core mined', () => {
    const raw = bytesToHex(extractP2mrTransaction(finalizeP2mrPsbt(completionSigned)))
    expect(raw).toBe(listing.rawTxHex)
    expect(listing.confirmations).toBeGreaterThanOrEqual(1)
  })
})

describe('signing a listing whose outputs exceed its inputs', () => {
  it('signs SIGHASH_SINGLE|ANYONECANPAY with the sighash qbit Core checks', () => {
    const psbt = unsignedListing()
    expect(decodePsbt(psbt).fee).toBeUndefined()
    const sign = vi.fn(() => dummySignature())
    const { psbt: signed } = signP2mrPsbt({
      psbt,
      keys: [{ inputIndex: 0, pubkey, leafHash, hashType: SINGLE_ANYONECANPAY }],
      sign,
      allowNonDefaultSighash: true,
    })
    const expected = p2mrSighash({
      tx: psbtUnsignedTransaction(psbt),
      inputIndex: 0,
      spentOutputs: decodePsbt(psbt).inputs.map(input => input.witnessUtxo!),
      leafHash,
      hashType: SINGLE_ANYONECANPAY,
    })
    expect(sign).toHaveBeenCalledTimes(1)
    expect(bytesToHex((sign.mock.calls[0] as unknown as [Uint8Array])[0])).toBe(bytesToHex(expected))
    expect(decodePsbt(signed).inputs[0]!.scriptSigs[0]!.signature.hashType).toBe(SINGLE_ANYONECANPAY)
  })

  it('also allows the other ANYONECANPAY types, which do not cover every input', () => {
    for (const hashType of [SIGHASH_ALL | SIGHASH_ANYONECANPAY, SIGHASH_NONE | SIGHASH_ANYONECANPAY]) {
      expect(() =>
        validateP2mrSigningPlans({
          psbt: unsignedListing(false),
          keys: [{ inputIndex: 0, pubkey, leafHash, hashType }],
          allowNonDefaultSighash: true,
        })
      ).not.toThrow()
    }
  })

  it.each([SIGHASH_DEFAULT, SIGHASH_ALL, SIGHASH_NONE, SIGHASH_SINGLE])(
    'refuses sighash type %d before the signer is called, as no transaction with it could be valid',
    hashType => {
      const sign = vi.fn(() => dummySignature())
      expectProtocolError(
        () =>
          signP2mrPsbt({
            psbt: unsignedListing(false),
            keys: [{ inputIndex: 0, pubkey, leafHash, hashType }],
            sign,
            allowNonDefaultSighash: true,
          }),
        'INVALID_AMOUNT',
        /total output value 60000 exceeds total input value 10000/
      )
      expect(sign).not.toHaveBeenCalled()
    }
  )

  it('refuses to finalize a PSBT whose outputs exceed its inputs', () => {
    expectProtocolError(() => finalizeP2mrPsbt(signedListing), 'INVALID_AMOUNT', /exceeds total input value/)
  })
})

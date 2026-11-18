import { init } from '@qbit-oss/pqc'
import { decodePsbt, hexToBytes, p2mrSighash, parsePsbt, psbtUnsignedTransaction } from '@qbit-oss/protocol'
import { expect, it } from 'vitest'

import fixture from '../../packages/protocol/fixtures/p2mr-partial-listing.json'

it('verifies the seller signature before and after funding and the buyer signature on completion', async () => {
  const pqc = await init()
  const seller = parsePsbt(hexToBytes(fixture.listingPsbtHex))
  const funded = parsePsbt(hexToBytes(fixture.completionSignedPsbtHex))
  const inspect = { allowOutputsAboveInputs: true }
  const sellerSignature = decodePsbt(seller, inspect).inputs[0]!.scriptSigs[0]!
  expect(decodePsbt(funded).inputs[0]!.scriptSigs[0]).toEqual(sellerSignature)

  for (const psbt of [seller, funded]) {
    const tx = psbtUnsignedTransaction(psbt)
    const inputs = decodePsbt(psbt, inspect).inputs
    const spentOutputs = inputs.map(input => input.witnessUtxo!)
    for (const [inputIndex, input] of inputs.entries()) {
      const { pubkey, leafHash, signature } = input.scriptSigs[0]!
      const digest = p2mrSighash({ tx, inputIndex, spentOutputs, leafHash, hashType: signature.hashType })
      expect(pqc.verify(pubkey, digest, signature.signature)).toBe(true)
    }
  }
})

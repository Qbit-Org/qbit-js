import { init } from '@qbit-oss/pqc'
import {
  decodePsbt,
  hexToBytes,
  p2mrLeafHash,
  p2mrSighash,
  parsePsbt,
  psbtUnsignedTransaction,
} from '@qbit-oss/protocol'
import { expect, it } from 'vitest'

import fixture from '../../packages/protocol/fixtures/p2mr-pk-leaf-data-branch.json'

it('verifies the reveal signature against the entire data-bearing leaf', async () => {
  const pqc = await init()
  const psbt = parsePsbt(hexToBytes(fixture.signedPsbtHex))
  const input = decodePsbt(psbt).inputs[0]!
  const leaf = input.leafScripts[0]!
  const { pubkey, signature } = input.scriptSigs[0]!
  const digest = p2mrSighash({
    tx: psbtUnsignedTransaction(psbt),
    inputIndex: 0,
    spentOutputs: [input.witnessUtxo!],
    leafHash: p2mrLeafHash(leaf.leafVersion, leaf.script),
    hashType: signature.hashType,
  })
  expect(pqc.verify(pubkey, digest, signature.signature)).toBe(true)
})

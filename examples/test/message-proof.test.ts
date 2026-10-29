import { init } from '@qbit-oss/pqc'
import { hexToBytes, p2mrAddressFromPubkey, PQC_SIGNATURE_BYTES } from '@qbit-oss/protocol'
import { beforeAll, describe, expect, it } from 'vitest'

import { checkMessageProof, signMessage } from '../src/message-proof'
import { testOnlyKey } from './test-only-keys'

const MESSAGE = 'I control this address. Nonce: 7f3a'

describe('message-proof example', () => {
  let address: string
  let otherAddress: string
  let proof: Awaited<ReturnType<typeof signMessage>>

  beforeAll(async () => {
    const key = await testOnlyKey(0)
    address = p2mrAddressFromPubkey(key.pk32, 'regtest')
    otherAddress = p2mrAddressFromPubkey((await testOnlyKey(1)).pk32, 'regtest')
    proof = await signMessage(key, MESSAGE)
  })

  it('creates a proof whose SLH-DSA signature is real', async () => {
    expect(proof.address).toBe(address)
    const signature = hexToBytes(proof.signature)
    expect(signature).toHaveLength(PQC_SIGNATURE_BYTES)
    // The signature verifies on its own, over the digest the proof records.
    const pqc = await init()
    expect(pqc.verify(hexToBytes(proof.pubkey), hexToBytes(proof.datasig_hash), signature)).toBe(true)
  })

  it('verifies for the expected address', async () => {
    await expect(checkMessageProof(MESSAGE, proof, address)).resolves.toBe(true)
  })

  it('fails for another address', async () => {
    await expect(checkMessageProof(MESSAGE, proof, otherAddress)).resolves.toBe(false)
  })

  it('fails for another message', async () => {
    await expect(checkMessageProof(`${MESSAGE}!`, proof, address)).resolves.toBe(false)
  })

  it('fails when the proof claims another address', async () => {
    await expect(checkMessageProof(MESSAGE, { ...proof, address: otherAddress }, otherAddress)).resolves.toBe(false)
  })
})

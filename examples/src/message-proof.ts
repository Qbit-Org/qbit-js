// Prove control of a P2MR address by signing a message, and check such a proof,
// with @qbit-oss/protocol and the SLH-DSA signer in @qbit-oss/pqc.
// See packages/protocol/docs/message-proofs.md.

import { init, type PqcDerivedKey } from '@qbit-oss/pqc'
import {
  createP2mrMessageProof,
  p2mrAddressFromPubkey,
  qbitDataSigPqcHash,
  qbitWalletMessageHash,
  verifyP2mrMessageProof,
  type P2mrMessageProof,
} from '@qbit-oss/protocol'

/**
 * Sign `message` with `key`, a wallet key from `deriveP2mrDescriptorKey`
 * (`{ pk32, sk64 }`), and wrap the signature in a proof for its address.
 */
export async function signMessage(key: PqcDerivedKey, message: string): Promise<P2mrMessageProof> {
  // init() loads the WASM module once; later calls share that load.
  const pqc = await init()
  const address = p2mrAddressFromPubkey(key.pk32, 'regtest')
  // The signature covers a 32-byte digest of the message under qbit's wallet
  // message and data-signature domains, not the message text itself.
  const digest = qbitDataSigPqcHash(qbitWalletMessageHash(message))
  // A wallet counts this signature against the key's 2^30 budget first, as
  // send-payment.ts does with `reserveSignature`.
  const signature = pqc.sign(key.sk64, digest)
  return createP2mrMessageProof({ message, address, pubkey: key.pk32, signature })
}

/**
 * Check that `proof` signs `message` for `expectedAddress`, the address the
 * user claims to control. `proof.address` comes from whoever sent the proof,
 * so never trust it on its own: `verifyP2mrMessageProof` requires the address
 * (or network) you expect.
 */
export async function checkMessageProof(message: string, proof: unknown, expectedAddress: string): Promise<boolean> {
  // Verify with the client init() returns. verifyP2mrMessageProof reports any
  // error from the verifier as `false`, so the named `verify` export, which
  // throws until an init() call has succeeded, would make every proof look invalid.
  const pqc = await init()
  return verifyP2mrMessageProof(message, proof, pqc.verify, { expectedAddress })
}

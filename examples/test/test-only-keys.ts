// TEST ONLY. Never copy this into a wallet or fund these addresses.
//
// The keys below come from fixed bytes published in this file, so anyone can
// recompute them and spend whatever their addresses hold. The tests use them
// only so that every run signs the same bytes. A wallet derives each leaf from
// the user's own seed instead: the BIP32 private key at
// m/87h/{coin_type}h/0h/{change}/{index}, passed to `deriveP2mrDescriptorKey`
// with that index (see @qbit-oss/pqc's docs/derivation.md).

import { init, type PqcDerivedKey } from '@qbit-oss/pqc'

/** Test key `index`, from a fixed, public stand-in for its BIP32 leaf private key. */
export async function testOnlyKey(index: number): Promise<PqcDerivedKey> {
  const pqc = await init()
  const insecureTestLeaf = new Uint8Array(32).fill(index + 1) // TEST ONLY: public bytes, not a secret
  return pqc.deriveP2mrDescriptorKey(insecureTestLeaf, index)
}

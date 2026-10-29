// The quick start of @qbit-oss/protocol's README, which shows the region below
// as it is. So the region must stand alone: its imports, and every placeholder
// declared and labelled. Like the @qbit-oss/api quick start, it must also run
// as pasted in a CommonJS project, so it has no top-level await; the test runs
// the README's copy as CommonJS too. send-payment.ts builds, signs and
// broadcasts a whole payment.

// #region quick-start
import {
  addressToScriptPubKey,
  buildControlBlock,
  createP2mrPsbt,
  hexToBytes,
  p2mrAddressFromPubkey,
  p2mrLeafHash,
  P2MR_LEAF_VERSION_V1,
  singleKeyLeafScript,
  validateP2mrSigningPlans,
} from '@qbit-oss/protocol'

const fundingTxid = '0123456789abcdef'.repeat(4) // placeholder: the txid of the output you spend
const pubkey = hexToBytes('02'.repeat(32)) // placeholder: 32-byte public key from your PQC signer
const address = p2mrAddressFromPubkey(pubkey, 'regtest') // 'qbrt1zzasx2u2z7v9kn4q8e66r57mfw08xvrvdcqfcq6xfte0eau9dgdgqz42zd5'
const scriptPubKey = addressToScriptPubKey(address, 'regtest')
const leafScript = singleKeyLeafScript(pubkey)
const txid = hexToBytes(fundingTxid).reverse() // fundingTxid as an explorer shows it, reversed to internal order
const psbt = createP2mrPsbt({
  inputs: [
    {
      prevout: { txid, vout: 0 },
      witnessUtxo: { value: 100_000n, scriptPubKey },
      leafScript,
      controlBlock: buildControlBlock(),
    },
  ],
  outputs: [{ value: 99_000n, scriptPubKey }], // pays back to the same address
})
const keys = [{ inputIndex: 0, pubkey, leafHash: p2mrLeafHash(P2MR_LEAF_VERSION_V1, leafScript) }]
validateP2mrSigningPlans({ psbt, keys }) // the plan checks signP2mrPsbt runs before its first signer call
// #endregion quick-start

export { address, fundingTxid, keys, psbt }

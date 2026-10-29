// The quick start of @qbit-oss/api's README, which shows the region below as
// it is. So the region must stand alone: its imports, and every placeholder
// declared and labelled. It must also run as pasted in a CommonJS project, so
// it has no top-level await, and type-check in a browser project without
// @types/node, so it uses no Node global such as `process`. The test runs this
// file, and the README's copy as CommonJS, with an in-memory backend in place
// of the global fetch, and type-checks the README's copy as a browser project.

// #region quick-start
import { EsploraClient } from '@qbit-oss/api'

async function main() {
  const client = new EsploraClient({ baseUrl: 'https://esplora.example/regtest/api' }) // placeholder: your esplora endpoint
  const address = 'qbrt1zzasx2u2z7v9kn4q8e66r57mfw08xvrvdcqfcq6xfte0eau9dgdgqz42zd5' // placeholder: the address to read
  const balance = await client.getAddressBalance(address) // { address, confirmedSats, mempoolSats, totalSats }
  const utxos = await client.getAddressUtxos(address)
  const history = await client.getAddressHistory(address) // { confirmed, mempool }
  const fees = await client.getFeeTiers() // [{ target, feeRate }] ascending
  console.log({ balance, utxos, history, fees })
  // Once you have a signed transaction (built with @qbit-oss/protocol):
  // const txid = await client.broadcastTx(signedTxHex) // see "Errors you must handle"
}

main().catch(error => console.error(error))
// #endregion quick-start

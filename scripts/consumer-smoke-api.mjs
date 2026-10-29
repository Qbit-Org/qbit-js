// Consumer smoke for @qbit-oss/api. Run by scripts/run-consumer-smoke.mjs
// from inside a clean temp project that has installed the packed tarball.
// Imports the package BY NAME through both builds (ESM and CJS) and exercises
// it without network access: a client reading through a stub fetch, a txid
// computed through the runtime dep (@noble/hashes), and the
// `@qbit-oss/api/testing` mock driving a client from each build.
import { strict as assert } from 'node:assert'
import { createRequire } from 'node:module'

const m = await import('@qbit-oss/api')
const cjs = createRequire(import.meta.url)('@qbit-oss/api')

const log = (...a) => console.log('[api-consumer]', ...a)

const BASE = 'https://esplora.example/regtest/api'

// (1) EsploraClient from each entry point, reading through a stub fetch
for (const [entry, { EsploraClient }] of [
  ['ESM', m],
  ['CJS', cjs],
]) {
  const urls = []
  const fetchFn = async url => {
    urls.push(String(url))
    return new Response('123456\n', { status: 200 })
  }
  const client = new EsploraClient({ baseUrl: BASE, fetchFn })
  assert.equal(await client.getTipHeight(), 123456, `${entry} getTipHeight through a stub fetch`)
  assert.deepEqual(urls, [`${BASE}/blocks/tip/height`], `${entry} request URL`)
}

// (2) txid vector: the double SHA-256 goes through @noble/hashes. The
// transaction is unsignedTxHex from packages/api/test/fixtures/p2mr-witness-tx.json,
// inlined because fixtures are not in the tarball.
const UNSIGNED_TX_HEX =
  '0200000002030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f2021220300000000fdffffff' +
  '28292a2b2c2d2e2f303132333435363738393a3b3c3d3e3f40414243444546470000000000feffffff' +
  '0120bf0200000000002252205a5b58595e5f5c5d52535051565754554a4b48494e4f4c4d424340414647444500000000'
const txid = m.txidFromRawTx(UNSIGNED_TX_HEX)
assert.equal(txid, '49d7493c4a5c9690713879e066f0a41ce1523b64870dfdcebed40c6ca09f5c84', 'txidFromRawTx vector')

// (3) @qbit-oss/api/testing from each build: the mock answers the client's
// reads, and takes a submission, whose txid it derives through @noble/hashes,
// since the fixture holds the two outputs it spends.
const testing = await import('@qbit-oss/api/testing')
const testingCjs = createRequire(import.meta.url)('@qbit-oss/api/testing')
const funding = [
  {
    txid: '2221201f1e1d1c1b1a191817161514131211100f0e0d0c0b0a09080706050403',
    vout: [{ value: 0 }, { value: 0 }, { value: 0 }, { value: 100_000 }],
    block: { height: 41 },
  },
  {
    txid: '47464544434241403f3e3d3c3b3a393837363534333231302f2e2d2c2b2a2928',
    vout: [{ value: 100_000 }],
    block: { height: 41 },
  },
]
for (const [entry, { createMockEsplora }, { EsploraClient }] of [
  ['ESM', testing, m],
  ['CJS', testingCjs, cjs],
]) {
  const mock = createMockEsplora({ backend: 'esplora', txs: funding, tip: { height: 42 } })
  const client = new EsploraClient({ baseUrl: mock.baseUrl, fetchFn: mock.fetchFn })
  assert.equal(await client.getTipHeight(), 42, `${entry} getTipHeight through the testing mock`)
  assert.equal(await client.broadcastTx(UNSIGNED_TX_HEX), txid, `${entry} broadcastTx through the testing mock`)
  assert.equal(mock.hasTx(txid), true, `${entry} mock took the submission`)
}

log('ALL CHECKS PASSED')
console.log(JSON.stringify({ ok: true, pkg: '@qbit-oss/api', txid }))

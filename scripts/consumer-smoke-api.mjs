// Consumer smoke for @qbit-oss/api. Run by scripts/run-consumer-smoke.mjs
// from inside a clean temp project that has installed the packed tarball.
// Imports the package BY NAME through both entry points (ESM and CJS) and
// exercises it without network access: a client reading through a stub fetch,
// and a txid computed through the runtime dep (@noble/hashes).
import { strict as assert } from 'node:assert'
import { createRequire } from 'node:module'

const m = await import('@qbit-oss/api')
const cjs = createRequire(import.meta.url)('@qbit-oss/api')

const log = (...a) => console.log('[api-consumer]', ...a)

const BASE = 'https://esplora.example/regtest/api'

// (1) EsploraClient from each entry point, reading through a stub fetch
for (const [entry, { EsploraClient }] of [['ESM', m], ['CJS', cjs]]) {
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
const txid = m.txidFromRawTx(
  '0200000002030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f2021220300000000fdffffff' +
    '28292a2b2c2d2e2f303132333435363738393a3b3c3d3e3f40414243444546470000000000feffffff' +
    '0120bf0200000000002252205a5b58595e5f5c5d52535051565754554a4b48494e4f4c4d424340414647444500000000'
)
assert.equal(txid, '49d7493c4a5c9690713879e066f0a41ce1523b64870dfdcebed40c6ca09f5c84', 'txidFromRawTx vector')

log('ALL CHECKS PASSED')
console.log(JSON.stringify({ ok: true, pkg: '@qbit-oss/api', txid }))

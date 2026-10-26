// Consumer smoke for @qbit-oss/protocol. Run by scripts/run-consumer-smoke.mjs
// from inside a clean temp project that has installed the packed tarball.
// Imports the package BY NAME and checks it against qbit Core conformance
// vectors, so this validates correctness of the packed artifact (not just
// self-consistent roundtrips) and that the runtime dep (@noble/hashes)
// installs and works from a fresh consumer.
import { strict as assert } from 'node:assert'
import { createRequire } from 'node:module'

const m = await import('@qbit-oss/protocol')
const cjs = createRequire(import.meta.url)('@qbit-oss/protocol')
const {
  hexToBytes,
  bytesToHex,
  p2mrAddressFromRoot,
  encodeP2mrAddress,
  decodeP2mrAddress,
  p2mrScriptPubKey,
  addressToScriptPubKey,
  outputScriptToAddress,
  getQbitNetwork,
  qbitNetworks,
  singleKeyLeafScript,
  p2mrLeafHash,
  p2mrAddressFromPubkey,
  p2mrSighash,
  P2MR_LEAF_VERSION_V1,
  addDescriptorChecksum,
  descriptorChecksum,
} = m

const log = (...a) => console.log('[protocol-consumer]', ...a)

const RAW_ROOT = hexToBytes('000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f')

// (1) qbit Core conformance address vectors
assert.equal(
  p2mrAddressFromRoot(RAW_ROOT, 'mainnet'),
  'qb1zqqqsyqcyq5rqwzqfpg9scrgwpugpzysnzs23v9ccrydpk8qarc0sjq57mw',
  'mainnet address vector'
)
assert.equal(
  p2mrAddressFromRoot(RAW_ROOT, 'regtest'),
  'qbrt1zqqqsyqcyq5rqwzqfpg9scrgwpugpzysnzs23v9ccrydpk8qarc0s8kqqny',
  'regtest address vector'
)

// (2) scriptPubKey vector + full address<->script roundtrip
assert.equal(
  bytesToHex(p2mrScriptPubKey(RAW_ROOT)),
  '5220000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f',
  'scriptPubKey vector'
)
const addr = encodeP2mrAddress(RAW_ROOT, qbitNetworks.regtest)
assert.equal(
  bytesToHex(addressToScriptPubKey(addr, 'regtest')),
  bytesToHex(p2mrScriptPubKey(RAW_ROOT)),
  'address -> scriptPubKey'
)
assert.equal(outputScriptToAddress(p2mrScriptPubKey(RAW_ROOT), 'regtest'), addr, 'scriptPubKey -> address')
assert.equal(decodeP2mrAddress(addr, 'regtest').network, 'regtest', 'decode network')

// (3) network params lookup by name + by object, through both published entry points
assert.equal(getQbitNetwork('regtest').bech32Hrp, 'qbrt', 'network lookup by name')
assert.equal(getQbitNetwork(qbitNetworks.mainnet).bech32Hrp, 'qb', 'network lookup by object')
assert.equal(getQbitNetwork('mainnet').mainnetReady, true, 'ESM mainnet readiness')
assert.equal(cjs.getQbitNetwork('mainnet').mainnetReady, true, 'CJS mainnet readiness')
assert.equal(cjs.qbitNetworks.mainnet.mainnetReady, true, 'CJS mainnet network export')

// (4) descriptor checksum helpers
const desc = 'rawmr(000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f)'
assert.equal(descriptorChecksum(desc), 'ua20u6r5', 'descriptor checksum vector')
assert.equal(addDescriptorChecksum(desc), `${desc}#ua20u6r5`, 'checksum appended with #')

// (5) The runtime dep (@noble/hashes) computes the right digests, not just
// 32-byte ones. Every leaf hash, root, address-from-pubkey and sighash goes
// through its sha256, so a broken or substituted release must fail here.
const pk32 = new Uint8Array(32).fill(2)
const leaf = singleKeyLeafScript(pk32)
assert.equal(bytesToHex(leaf), `20${'02'.repeat(32)}b3`, 'singleKeyLeafScript vector')
assert.equal(
  bytesToHex(p2mrLeafHash(P2MR_LEAF_VERSION_V1, leaf)),
  '1760657142f30b69d407ceb43a7b6973ce660d8dc0138068c95e5f9ef0ad4350',
  'p2mrLeafHash vector (sha256 via @noble/hashes)'
)
assert.equal(
  p2mrAddressFromPubkey(pk32, 'regtest'),
  'qbrt1zzasx2u2z7v9kn4q8e66r57mfw08xvrvdcqfcq6xfte0eau9dgdgqz42zd5',
  'p2mrAddressFromPubkey vector'
)

// (6) One P2MR sighash vector, inlined from
// packages/protocol/fixtures/p2mr-sighash.json (p2mr[0], "single-input#0",
// SIGHASH_DEFAULT) because fixtures are not in the tarball.
const sighashLeafHash = p2mrLeafHash(
  P2MR_LEAF_VERSION_V1,
  singleKeyLeafScript(hexToBytes('01080f161d242b323940474e555c636a71787f868d949ba2a9b0b7bec5ccd3da'))
)
assert.equal(
  bytesToHex(sighashLeafHash),
  'afb1c56c80c30a5fab4723194d55cd51dc3671aab200356de84d4deefa3d7e38',
  'sighash vector leaf hash'
)
const sighash = p2mrSighash({
  tx: {
    version: 2,
    locktime: 0,
    inputs: [
      {
        prevout: { txid: hexToBytes('0102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f20'), vout: 1 },
        sequence: 4294967293,
      },
    ],
    outputs: [
      { value: 50000n, scriptPubKey: hexToBytes('52205a5b58595e5f5c5d52535051565754554a4b48494e4f4c4d4243404146474445') },
      { value: 49000n, scriptPubKey: hexToBytes('522033323130373635343b3a39383f3e3d3c23222120272625242b2a29282f2e2d2c') },
    ],
  },
  inputIndex: 0,
  spentOutputs: [
    { value: 100000n, scriptPubKey: hexToBytes('5220afb1c56c80c30a5fab4723194d55cd51dc3671aab200356de84d4deefa3d7e38') },
  ],
  leafHash: sighashLeafHash,
  hashType: 0,
})
assert.equal(
  bytesToHex(sighash),
  'a22877d685013f9c72c0120b13a4e79d9f60c7e50151c318ddd9488f6e1e6cd8',
  'p2mrSighash vector'
)

log('ALL CHECKS PASSED')
console.log(JSON.stringify({ ok: true, pkg: '@qbit-oss/protocol', addr }))

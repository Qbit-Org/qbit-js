import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

import psbtFixture from '../fixtures/p2mr-psbt.json'
import sighashFixture from '../fixtures/p2mr-sighash.json'
import {
  type P2mrSighashParams,
  type P2mrSpentOutput,
  type P2mrTransaction,
  type P2mrTransactionInput,
  type P2mrTransactionOutput,
  P2MR_CONTROL_MAX_NODE_COUNT,
  P2MR_CONTROL_NODE_BYTES,
  P2MR_LEAF_VERSION_MASK,
  P2MR_LEAF_VERSION_V1,
  QbitProtocolError,
  SIGHASH_DEFAULT,
  addressToScriptPubKey,
  buildControlBlock,
  bytesToHex,
  decodeP2mrAddress,
  decodeP2mrWitnessSignature,
  hexToBytes,
  merkleRootFromPath,
  multiALeafScript,
  outputScriptToAddress,
  p2mrAddressFromPubkey,
  p2mrAddressFromRoot,
  p2mrBranchHash,
  p2mrLeafHash,
  p2mrRootFromDescriptor,
  p2mrScriptPubKey,
  p2mrSighash,
  qbitDataSigPqcHash,
  schnorrSignatureHash,
  singleKeyLeafScript,
  verifyControlBlock,
} from '../src/index'

// qbit Core's own committed P2MR v1 vectors, vendored verbatim from
// Qbit-Org/qbit v1.0.0 into fixtures/core/ (see fixtures/core/README.md). They
// are generated and C++-validated in Core, independently of this SDK, so they
// catch a bug that this SDK's self-consistency tests would share with itself.

const CORE_COMMIT = '7ebcddb622d6e639041f005a189b048ec2a221fe'
// The manifest's digest is pinned here so the vectors and the manifest cannot
// be swapped together.
const CORE_MANIFEST_SHA256 = 'd30f2fb354ee9b55bc72ba2d9b250aefd96656f0eac61b0f2cdb77001aacdad4'
const CORE_PROFILE = 'qbit-p2mr-v1'

function readCoreFixture(name: string): Buffer {
  return readFileSync(new URL(`../fixtures/core/${name}`, import.meta.url))
}

function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

/**
 * Tagged hash computed with node:crypto, independent of the SDK's @noble/hashes
 * path. Used only to check the SDK against preimages Core publishes.
 */
function nodeTaggedHash(tag: string, message: Uint8Array): string {
  const tagHash = createHash('sha256').update(tag, 'ascii').digest()
  return createHash('sha256').update(tagHash).update(tagHash).update(message).digest('hex')
}

/** Core ComputeP2MRBranchHash (src/script/interpreter.cpp:2210-2219), via node:crypto. */
function nodeBranchHash(a: Uint8Array, b: Uint8Array): Uint8Array {
  const [first, second] = Buffer.compare(a, b) < 0 ? [a, b] : [b, a]
  return hexToBytes(nodeTaggedHash('P2MRBranch', Buffer.concat([first, second])))
}

/** Core ComputeP2MRLeafHash (src/script/interpreter.cpp:2199-2202), via node:crypto. */
function nodeLeafHash(leafVersion: number, script: Uint8Array): Uint8Array {
  if (script.length > 0xffff) throw new RangeError('nodeLeafHash handles leaves up to 0xffff bytes')
  // CompactSize: one byte below 0xfd, otherwise 0xfd then a little-endian uint16.
  const size = script.length < 0xfd ? [script.length] : [0xfd, script.length & 0xff, script.length >> 8]
  return hexToBytes(nodeTaggedHash('P2MRLeaf', Buffer.concat([Uint8Array.of(leafVersion, ...size), script])))
}

interface Manifest {
  schema_version: number
  profile: string
  reference_implementation: { repository: string; commit: string }
  case_count: number
  case_counts: Record<string, number>
  files: { path: string; case_count: number; sha256: string }[]
}

interface Expectation {
  accepted: boolean
  stage: string
  error: string
}

interface CommitmentValidVector {
  id: string
  expected: Expectation
  leaf_script: string
  leaf_version: number
  leaf_hash: string
  siblings: string[]
  branch_preimages: string[]
  control_block: string
  merkle_root: string
  scriptPubKey: string
  mainnet_address: string
  regtest_address: string
}

interface CommitmentInvalidVector {
  id: string
  expected: Expectation
  leaf_script: string
  leaf_version: number
  control_block: string
  merkle_root: string
  expected_error: string
}

interface CommitmentVectors {
  schema_version: number
  profile: string
  valid: CommitmentValidVector[]
  invalid: CommitmentInvalidVector[]
}

interface CoreSpentOutput {
  amount: number
  scriptPubKey: string
}

interface CheckSigAddVector {
  inputIndex: number
  spentOutputs: CoreSpentOutput[]
  spendTx: string
  leafVersion: string
  leafScript: string
  controlBlock: string
  leafHash: string
  scriptPubKey: string
  signature: string
  p2mrSighash: string
}

interface DataSigAddVector {
  messageHash: string
  dataSigHash: string
  controlBlock: string
  nOfNLeafScript: string
  nOfNScriptPubKey: string
  mOfNLeafScript: string
  mOfNScriptPubKey: string
  wrongMessageHashLeafScript: string
  wrongMessageHashScriptPubKey: string
  wrongPubkeyLeafScript: string
  wrongPubkeyScriptPubKey: string
}

interface WitnessVector {
  id: string
  expected: Expectation
  digest_defined: boolean
  annex: string
  inputIndex: number
  hashType: string
  epoch: string
  spendType: string
  keyVersion: string
  codeSeparatorPosition: string
  prevoutAmount: number
  prevoutScriptPubKey: string
  spentOutputs: CoreSpentOutput[]
  spendTx: string
  leafVersion: string
  leafScript: string
  controlBlock: string
  leafHash: string
  pubkey: string
  signature: string
  witness: string[]
  p2mrSighash?: string
  wrongDomainSighash?: string
  noAnnexSighash?: string
  wrongCodeSeparatorPosition?: string
  wrongCodeseparatorSighash?: string
  wrongPubkeyLeafScript?: string
  wrongPubkeyScriptPubKey?: string
  dataSigMessageHash?: string
  dataSigHash?: string
  dataSigLeafScript?: string
  dataSigControlBlock?: string
  dataSigScriptPubKey?: string
  dataSigWrongPubkeyLeafScript?: string
  dataSigWrongPubkeyScriptPubKey?: string
  dataSigAdd?: DataSigAddVector
  checkSigAdd?: CheckSigAddVector
}

interface WitnessVectors {
  schema_version: number
  profile: string
  vectors: WitnessVector[]
}

interface BoundaryCase {
  id: string
  category: string
  scenario: string
  parameters: Record<string, unknown>
  consensus: Expectation
  policy: Expectation
}

interface BoundaryVectors {
  schema_version: number
  profile: string
  limits: { control_path_max_nodes: number }
  cases: BoundaryCase[]
}

const VENDORED_VECTOR_FILES = [
  'p2mr_vectors.json',
  'p2mr_pqc_witness_vectors.json',
  'p2mr_script_boundary_vectors.json',
] as const

const manifestBytes = readCoreFixture('p2mr_v1_manifest.json')
const manifest = JSON.parse(manifestBytes.toString('utf8')) as Manifest
const commitmentVectors = JSON.parse(readCoreFixture('p2mr_vectors.json').toString('utf8')) as CommitmentVectors
const witnessVectors = JSON.parse(readCoreFixture('p2mr_pqc_witness_vectors.json').toString('utf8')) as WitnessVectors
const boundaryVectors = JSON.parse(
  readCoreFixture('p2mr_script_boundary_vectors.json').toString('utf8')
) as BoundaryVectors

// ---------------------------------------------------------------------------
// Core's P2MR witness-program checks, in Core's order
// (src/script/interpreter.cpp:2373-2390): control size, then the bit-0 marker,
// then the leaf hash under the control byte's masked leaf version, then the
// Merkle commitment. Any later stage means the commitment itself passed.
// ---------------------------------------------------------------------------

type CommitmentStage = 'ok' | 'control-size' | 'control-marker' | 'commitment'

const PRE_EXECUTION_STAGES: ReadonlySet<string> = new Set(['control-size', 'control-marker', 'commitment'])

// Core stages reached only after the commitment check passed. An unknown stage
// throws, so a re-vendored file with a new stage name can't silently map to 'ok'.
const POST_COMMITMENT_STAGES: ReadonlySet<string> = new Set(['script', 'script-complete', 'upgrade-success'])

function expectedCommitmentStage(coreStage: string): CommitmentStage {
  if (PRE_EXECUTION_STAGES.has(coreStage)) return coreStage as CommitmentStage
  if (POST_COMMITMENT_STAGES.has(coreStage)) return 'ok'
  throw new Error(`unknown Core consensus stage ${JSON.stringify(coreStage)}`)
}

function evaluateCommitment(control: Uint8Array, leafScript: Uint8Array, program: Uint8Array): CommitmentStage {
  const leafHash = p2mrLeafHash((control[0] ?? 0) & P2MR_LEAF_VERSION_MASK, leafScript)
  let root: Uint8Array
  try {
    root = verifyControlBlock(control, leafHash)
  } catch (error) {
    if (!(error instanceof QbitProtocolError)) throw error
    if (/control block size/.test(error.message)) return 'control-size'
    if (/bit 0/.test(error.message)) return 'control-marker'
    throw error
  }
  return bytesToHex(root) === bytesToHex(program) ? 'ok' : 'commitment'
}

/** scriptPubKey committed by a single-leaf tree with the given control block. */
function singleLeafScriptPubKey(controlBlockHex: string, leafScriptHex: string): string {
  const control = hexToBytes(controlBlockHex)
  const leafHash = p2mrLeafHash((control[0] ?? 0) & P2MR_LEAF_VERSION_MASK, hexToBytes(leafScriptHex))
  return bytesToHex(p2mrScriptPubKey(verifyControlBlock(control, leafHash)))
}

// ---------------------------------------------------------------------------
// Minimal witness-transaction reader for the vectors' spendTx (BIP144 layout).
// ---------------------------------------------------------------------------

interface ParsedSpendTx {
  tx: P2mrTransaction
  witnesses: Uint8Array[][]
}

function parseSpendTx(hex: string): ParsedSpendTx {
  const bytes = hexToBytes(hex)
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  let offset = 0
  const take = (length: number): Uint8Array => {
    if (offset + length > bytes.length) throw new Error('spendTx truncated')
    const out = bytes.slice(offset, offset + length)
    offset += length
    return out
  }
  const u8 = (): number => take(1)[0]!
  const u32 = (): number => {
    take(4)
    return view.getUint32(offset - 4, true)
  }
  const u64 = (): bigint => {
    take(8)
    return view.getBigUint64(offset - 8, true)
  }
  const compact = (): number => {
    const first = u8()
    if (first < 0xfd) return first
    if (first === 0xfd) {
      take(2)
      return view.getUint16(offset - 2, true)
    }
    if (first === 0xfe) return u32()
    throw new Error('spendTx compact size too large')
  }

  const version = u32()
  expect(bytesToHex(take(2))).toBe('0001') // segwit marker and flag
  const inputs: P2mrTransactionInput[] = []
  for (let i = compact(); i > 0; i -= 1) {
    const txid = take(32)
    const vout = u32()
    expect(take(compact())).toHaveLength(0) // P2MR spends carry an empty scriptSig
    inputs.push({ prevout: { txid, vout }, sequence: u32() })
  }
  const outputs: P2mrTransactionOutput[] = []
  for (let i = compact(); i > 0; i -= 1) {
    const value = u64()
    outputs.push({ value, scriptPubKey: take(compact()) })
  }
  const witnesses = inputs.map(() => {
    const stack: Uint8Array[] = []
    for (let i = compact(); i > 0; i -= 1) stack.push(take(compact()))
    return stack
  })
  const locktime = u32()
  expect(offset).toBe(bytes.length)
  return { tx: { version, locktime, inputs, outputs }, witnesses }
}

function toSpentOutputs(outputs: readonly CoreSpentOutput[]): P2mrSpentOutput[] {
  return outputs.map(output => ({
    value: BigInt(output.amount),
    scriptPubKey: hexToBytes(output.scriptPubKey),
  }))
}

/** Core serializes the code-separator position as a little-endian uint32. */
function uint32FromLEHex(hex: string): number {
  const bytes = hexToBytes(hex)
  expect(bytes).toHaveLength(4)
  return new DataView(bytes.buffer, bytes.byteOffset, 4).getUint32(0, true)
}

function sighashParams(vector: WitnessVector, parsed: ParsedSpendTx): P2mrSighashParams {
  const params: P2mrSighashParams = {
    tx: parsed.tx,
    inputIndex: vector.inputIndex,
    spentOutputs: toSpentOutputs(vector.spentOutputs),
    leafHash: hexToBytes(vector.leafHash),
    hashType: Number.parseInt(vector.hashType, 16),
    codeSeparatorPos: uint32FromLEHex(vector.codeSeparatorPosition),
  }
  if (vector.annex !== 'none') params.annex = hexToBytes(vector.annex)
  return params
}

function expectThrowsCode(fn: () => unknown, code: QbitProtocolError['code']): void {
  let thrown: unknown
  try {
    fn()
  } catch (error) {
    thrown = error
  }
  expect(thrown).toBeInstanceOf(QbitProtocolError)
  expect((thrown as QbitProtocolError).code).toBe(code)
}

// ---------------------------------------------------------------------------

describe('vendored Core P2MR vectors: provenance', () => {
  it('pins the manifest digest and profile', () => {
    expect(sha256Hex(manifestBytes)).toBe(CORE_MANIFEST_SHA256)
    expect(manifest.schema_version).toBe(1)
    expect(manifest.profile).toBe(CORE_PROFILE)
    expect(manifest.reference_implementation.repository).toBe('Qbit-Org/qbit')
  })

  it.each(VENDORED_VECTOR_FILES)('%s matches its sha256 in the manifest', name => {
    const entry = manifest.files.find(file => file.path === `src/test/data/${name}`)
    expect(entry).toBeDefined()
    expect(sha256Hex(readCoreFixture(name))).toBe(entry!.sha256)
  })

  it('vector files carry the manifest case counts and profile', () => {
    const counts: Record<(typeof VENDORED_VECTOR_FILES)[number], number> = {
      'p2mr_vectors.json': commitmentVectors.valid.length + commitmentVectors.invalid.length,
      'p2mr_pqc_witness_vectors.json': witnessVectors.vectors.length,
      'p2mr_script_boundary_vectors.json': boundaryVectors.cases.length,
    }
    for (const name of VENDORED_VECTOR_FILES) {
      const entry = manifest.files.find(file => file.path === `src/test/data/${name}`)
      expect(counts[name], name).toBe(entry!.case_count)
    }
    expect(commitmentVectors.valid).toHaveLength(manifest.case_counts['commitment_valid']!)
    expect(commitmentVectors.invalid).toHaveLength(manifest.case_counts['commitment_invalid']!)
    for (const file of [commitmentVectors, witnessVectors, boundaryVectors]) {
      expect(file.schema_version).toBe(1)
      expect(file.profile).toBe(CORE_PROFILE)
    }
  })

  it('the generated fixtures are pinned to the same Core commit', () => {
    expect(sighashFixture.source.repository).toBe('Qbit-Org/qbit')
    expect(sighashFixture.source.commit).toBe(CORE_COMMIT)
    expect(psbtFixture.source.repository).toBe('Qbit-Org/qbit')
    expect(psbtFixture.source.commit).toBe(CORE_COMMIT)
  })
})

describe('Core p2mr_vectors.json: valid commitments', () => {
  it.each(commitmentVectors.valid)('$id', vector => {
    const leafScript = hexToBytes(vector.leaf_script)
    const siblings = vector.siblings.map(hexToBytes)
    expect(vector.expected.accepted).toBe(true)

    const leafHash = p2mrLeafHash(vector.leaf_version, leafScript)
    expect(bytesToHex(leafHash)).toBe(vector.leaf_hash)

    // Each level's branch hash equals Core's published (sorted) preimage, so
    // branch ordering is pinned per level and not only through the root.
    expect(vector.branch_preimages).toHaveLength(siblings.length)
    let node = leafHash
    for (const [level, sibling] of siblings.entries()) {
      node = p2mrBranchHash(node, sibling)
      expect(bytesToHex(node), `level ${level}`).toBe(
        nodeTaggedHash('P2MRBranch', hexToBytes(vector.branch_preimages[level]!))
      )
    }

    expect(bytesToHex(buildControlBlock(vector.leaf_version, siblings))).toBe(vector.control_block)
    expect(bytesToHex(merkleRootFromPath(leafHash, siblings))).toBe(vector.merkle_root)
    const root = verifyControlBlock(hexToBytes(vector.control_block), leafHash, vector.leaf_version)
    expect(bytesToHex(root)).toBe(vector.merkle_root)
    expect(evaluateCommitment(hexToBytes(vector.control_block), leafScript, hexToBytes(vector.merkle_root))).toBe('ok')

    expect(bytesToHex(p2mrScriptPubKey(root))).toBe(vector.scriptPubKey)
    expect(p2mrAddressFromRoot(root, 'mainnet')).toBe(vector.mainnet_address)
    expect(p2mrAddressFromRoot(root, 'regtest')).toBe(vector.regtest_address)
  })

  it.each(commitmentVectors.valid)('$id: addresses decode back to the Core root and script', vector => {
    for (const [network, address] of [
      ['mainnet', vector.mainnet_address],
      ['regtest', vector.regtest_address],
    ] as const) {
      const decoded = decodeP2mrAddress(address, network)
      expect(decoded.network).toBe(network)
      expect(bytesToHex(decoded.program)).toBe(vector.merkle_root)
      expect(bytesToHex(addressToScriptPubKey(address, network))).toBe(vector.scriptPubKey)
      expect(outputScriptToAddress(hexToBytes(vector.scriptPubKey), network)).toBe(address)
    }
  })
})

describe('Core p2mr_vectors.json: invalid commitments', () => {
  it.each(commitmentVectors.invalid)('$id is rejected at stage $expected.stage', vector => {
    expect(vector.expected.accepted).toBe(false)
    const control = hexToBytes(vector.control_block)
    expect((control[0] ?? 0) & P2MR_LEAF_VERSION_MASK).toBe(vector.leaf_version)
    const stage = evaluateCommitment(control, hexToBytes(vector.leaf_script), hexToBytes(vector.merkle_root))
    expect(stage).toBe(expectedCommitmentStage(vector.expected.stage))
    expect(stage).not.toBe('ok')
  })
})

describe('Core p2mr_pqc_witness_vectors.json', () => {
  const vectors = witnessVectors.vectors.map(vector => ({
    ...vector,
    parsed: parseSpendTx(vector.spendTx),
  }))

  it.each(vectors)('$id: witness, leaf and scriptPubKey commitments', vector => {
    const witness = vector.parsed.witnesses[vector.inputIndex]
    expect(witness?.map(bytesToHex)).toEqual(vector.witness)
    expect(vector.witness[0]).toBe(vector.signature)
    // Core pops the annex, then the control block, then the leaf script
    // (src/script/interpreter.cpp:2355-2371).
    const tail = vector.annex === 'none' ? [] : [vector.annex]
    expect(vector.witness.slice(-2 - tail.length)).toEqual([vector.leafScript, vector.controlBlock, ...tail])

    const spent = vector.spentOutputs[vector.inputIndex]!
    expect(spent.amount).toBe(vector.prevoutAmount)
    expect(spent.scriptPubKey).toBe(vector.prevoutScriptPubKey)

    const leafVersion = Number.parseInt(vector.leafVersion, 16)
    expect(leafVersion).toBe(P2MR_LEAF_VERSION_V1)
    const leafHash = p2mrLeafHash(leafVersion, hexToBytes(vector.leafScript))
    expect(bytesToHex(leafHash)).toBe(vector.leafHash)
    const root = verifyControlBlock(hexToBytes(vector.controlBlock), leafHash, leafVersion)
    expect(bytesToHex(p2mrScriptPubKey(root))).toBe(vector.prevoutScriptPubKey)

    if (vector.leafScript === `20${vector.pubkey}b3`) {
      const pubkey = hexToBytes(vector.pubkey)
      expect(bytesToHex(singleKeyLeafScript(pubkey))).toBe(vector.leafScript)
      expect(bytesToHex(addressToScriptPubKey(p2mrAddressFromPubkey(pubkey, 'regtest'), 'regtest'))).toBe(
        vector.prevoutScriptPubKey
      )
    }
  })

  it.each(vectors)('$id: sighash type byte and message framing', vector => {
    const hashType = Number.parseInt(vector.hashType, 16)
    const decoded = decodeP2mrWitnessSignature(hexToBytes(vector.signature))
    expect(decoded.hashType).toBe(hashType)
    expect(decoded.explicitHashType).toBe(hashType !== SIGHASH_DEFAULT)
    // The SDK hard-codes epoch 0 and key_version 0 for P2MR, and commits
    // spend_type = (ext_flag << 1) | annex_present with ext_flag = 1.
    expect(vector.epoch).toBe('00')
    expect(vector.keyVersion).toBe('00')
    expect(Number.parseInt(vector.spendType, 16)).toBe(2 | (vector.annex === 'none' ? 0 : 1))
  })

  const defined = vectors.filter(vector => vector.digest_defined)
  const undefinedDigest = vectors.filter(vector => !vector.digest_defined)

  it('covers the default, explicit, annex, codesep and SINGLE-missing shapes', () => {
    expect(defined).toHaveLength(10)
    expect(undefinedDigest.map(vector => vector.id)).toEqual([
      'single_key_sighash_single_missing_first',
      'single_key_sighash_single_missing_beyond',
      'single_key_sighash_single_anyonecanpay_missing_first',
      'single_key_sighash_single_anyonecanpay_missing_beyond',
    ])
    expect(defined.filter(vector => vector.noAnnexSighash !== undefined)).toHaveLength(1)
    expect(defined.filter(vector => vector.wrongCodeseparatorSighash !== undefined)).toHaveLength(3)
  })

  it.each(defined)('$id: p2mrSighash matches Core', vector => {
    expect(vector.expected.accepted).toBe(true)
    const params = sighashParams(vector, vector.parsed)
    expect(bytesToHex(p2mrSighash(params))).toBe(vector.p2mrSighash)
    // Same message under the TapSighash tag: proves the domain separation and
    // that P2MR reuses the tapscript message unchanged.
    expect(bytesToHex(schnorrSignatureHash({ ...params, sigVersion: 'tapscript' }))).toBe(vector.wrongDomainSighash)
  })

  it.each(defined.filter(vector => vector.noAnnexSighash !== undefined))(
    '$id: dropping the annex gives Core noAnnexSighash',
    vector => {
      const params = sighashParams(vector, vector.parsed)
      expect(params.annex).toBeDefined()
      const { annex: _annex, ...withoutAnnex } = params
      expect(bytesToHex(p2mrSighash(withoutAnnex))).toBe(vector.noAnnexSighash)
    }
  )

  it.each(defined.filter(vector => vector.wrongCodeseparatorSighash !== undefined))(
    '$id: the wrong code-separator position gives Core wrongCodeseparatorSighash',
    vector => {
      const params = sighashParams(vector, vector.parsed)
      const wrongPos = uint32FromLEHex(vector.wrongCodeSeparatorPosition!)
      expect(wrongPos).not.toBe(params.codeSeparatorPos)
      expect(bytesToHex(p2mrSighash({ ...params, codeSeparatorPos: wrongPos }))).toBe(vector.wrongCodeseparatorSighash)
    }
  )

  // Core returns false from SignatureHashSchnorrCommon when SIGHASH_SINGLE has
  // no matching output (src/script/interpreter.cpp:1780), which CheckPQCSignature
  // maps to SCRIPT_ERR_P2MR_SIG_HASHTYPE (:2022-2023).
  it.each(undefinedDigest)('$id: p2mrSighash throws like Core', vector => {
    expect(vector.expected).toEqual({
      accepted: false,
      stage: 'sighash',
      error: 'SCRIPT_ERR_P2MR_SIG_HASHTYPE',
    })
    expect(vector.inputIndex).toBeGreaterThanOrEqual(vector.parsed.tx.outputs.length)
    expectThrowsCode(() => p2mrSighash(sighashParams(vector, vector.parsed)), 'INVALID_SIGHASH')
  })

  it('checkSigAdd: CHECKSIGADD leaf commitment and sighash match Core', () => {
    const withCheckSigAdd = vectors.filter(vector => vector.checkSigAdd !== undefined)
    expect(withCheckSigAdd).toHaveLength(1)
    const vector = withCheckSigAdd[0]!.checkSigAdd!
    const parsed = parseSpendTx(vector.spendTx)
    const witness = parsed.witnesses[vector.inputIndex]!.map(bytesToHex)
    expect(witness).toEqual([vector.signature, vector.leafScript, vector.controlBlock])

    const leafHash = p2mrLeafHash(Number.parseInt(vector.leafVersion, 16), hexToBytes(vector.leafScript))
    expect(bytesToHex(leafHash)).toBe(vector.leafHash)
    expect(singleLeafScriptPubKey(vector.controlBlock, vector.leafScript)).toBe(vector.scriptPubKey)
    expect(vector.spentOutputs[vector.inputIndex]!.scriptPubKey).toBe(vector.scriptPubKey)

    const digest = p2mrSighash({
      tx: parsed.tx,
      inputIndex: vector.inputIndex,
      spentOutputs: toSpentOutputs(vector.spentOutputs),
      leafHash,
    })
    expect(bytesToHex(digest)).toBe(vector.p2mrSighash)
  })

  it('dataSig: QbitDataSigPQC hash and data-signature leaf commitments match Core', () => {
    const withDataSig = vectors.filter(vector => vector.dataSigHash !== undefined)
    expect(withDataSig).toHaveLength(1)
    const vector = withDataSig[0]!
    expect(bytesToHex(qbitDataSigPqcHash(hexToBytes(vector.dataSigMessageHash!)))).toBe(vector.dataSigHash)

    const add = vector.dataSigAdd!
    expect(bytesToHex(qbitDataSigPqcHash(hexToBytes(add.messageHash)))).toBe(add.dataSigHash)

    const pairs: [string, string, string][] = [
      [vector.dataSigControlBlock!, vector.dataSigLeafScript!, vector.dataSigScriptPubKey!],
      [vector.dataSigControlBlock!, vector.dataSigWrongPubkeyLeafScript!, vector.dataSigWrongPubkeyScriptPubKey!],
      [add.controlBlock, add.nOfNLeafScript, add.nOfNScriptPubKey],
      [add.controlBlock, add.mOfNLeafScript, add.mOfNScriptPubKey],
      [add.controlBlock, add.wrongMessageHashLeafScript, add.wrongMessageHashScriptPubKey],
      [add.controlBlock, add.wrongPubkeyLeafScript, add.wrongPubkeyScriptPubKey],
    ]
    for (const [control, leafScript, scriptPubKey] of pairs) {
      expect(singleLeafScriptPubKey(control, leafScript)).toBe(scriptPubKey)
    }
  })

  it.each(vectors.filter(vector => vector.wrongPubkeyLeafScript !== undefined))(
    '$id: wrong-pubkey leaf commits to Core wrongPubkeyScriptPubKey',
    vector => {
      expect(singleLeafScriptPubKey(vector.controlBlock, vector.wrongPubkeyLeafScript!)).toBe(
        vector.wrongPubkeyScriptPubKey
      )
    }
  )
})

describe('Core p2mr_script_boundary_vectors.json', () => {
  const cases = boundaryVectors.cases

  it('uses Core control-path depth limit', () => {
    expect(boundaryVectors.limits.control_path_max_nodes).toBe(P2MR_CONTROL_MAX_NODE_COUNT)
    expect(P2MR_CONTROL_MAX_NODE_COUNT).toBe(128)
  })

  // Built exactly as Core's boundary harness does
  // (src/test/script_p2mr_tests.cpp:1311-1337): an OP_TRUE leaf, a control
  // block of `nodes` all-zero path nodes, and the root of that path (or the
  // leaf hash when the path is over the limit), then the named mutation.
  const controlPath = cases.filter(testCase => testCase.scenario === 'control-path')

  it.each(controlPath)('$id: $consensus.stage', testCase => {
    const nodes = testCase.parameters['nodes'] as number
    const mutation = testCase.parameters['mutation'] as string
    const leafScript = Uint8Array.of(0x51)
    const leafHash = p2mrLeafHash(P2MR_LEAF_VERSION_V1, leafScript)
    const siblings = Array.from({ length: nodes }, () => new Uint8Array(P2MR_CONTROL_NODE_BYTES))
    const control = new Uint8Array(1 + nodes * P2MR_CONTROL_NODE_BYTES)
    control[0] = P2MR_LEAF_VERSION_V1 | 1

    let root = leafHash
    if (nodes <= P2MR_CONTROL_MAX_NODE_COUNT) {
      root = siblings.reduce((acc, sibling) => nodeBranchHash(acc, sibling), leafHash)
      expect(bytesToHex(buildControlBlock(P2MR_LEAF_VERSION_V1, siblings))).toBe(bytesToHex(control))
      expect(bytesToHex(merkleRootFromPath(leafHash, siblings))).toBe(bytesToHex(root))
    } else {
      expect(() => buildControlBlock(P2MR_LEAF_VERSION_V1, siblings)).toThrow(RangeError)
      expect(() => merkleRootFromPath(leafHash, siblings)).toThrow(RangeError)
    }

    let spendControl = control
    if (mutation === 'append-byte') {
      spendControl = Uint8Array.of(...control, 0x00)
    } else if (mutation === 'clear-marker') {
      spendControl[0] = spendControl[0]! & 0xfe
    } else if (mutation === 'path-node') {
      expect(nodes).toBe(1)
      spendControl[spendControl.length - 1] = spendControl[spendControl.length - 1]! ^ 0x01
    } else if (mutation === 'program-root') {
      root = Uint8Array.from(root)
      root[0] = root[0]! ^ 0x01
    } else {
      expect(mutation).toBe('none')
    }

    expect(evaluateCommitment(spendControl, leafScript, root)).toBe(expectedCommitmentStage(testCase.consensus.stage))
  })

  it('control path depth 128 verifies and depth 129 is rejected', () => {
    expect(controlPath.map(testCase => testCase.id)).toEqual(
      expect.arrayContaining(['control-depth-128', 'control-depth-129'])
    )
    const leafHash = p2mrLeafHash(P2MR_LEAF_VERSION_V1, Uint8Array.of(0x51))
    const path128 = Array.from({ length: 128 }, (_, i) => new Uint8Array(32).fill(i))
    const control128 = buildControlBlock(P2MR_LEAF_VERSION_V1, path128)
    expect(control128).toHaveLength(1 + 128 * 32)
    expect(bytesToHex(verifyControlBlock(control128, leafHash))).toBe(
      bytesToHex(path128.reduce((acc, sibling) => nodeBranchHash(acc, sibling), leafHash))
    )

    const path129 = [...path128, new Uint8Array(32)]
    expect(() => buildControlBlock(P2MR_LEAF_VERSION_V1, path129)).toThrow(RangeError)
    expect(() => merkleRootFromPath(leafHash, path129)).toThrow(RangeError)
    expect(() => verifyControlBlock(Uint8Array.of(...control128, ...new Uint8Array(32)), leafHash)).toThrow(
      QbitProtocolError
    )
  })

  // Every leaf-version case passes the commitment in consensus: v1 (0xc0)
  // executes, and reserved even versions succeed as upgrades
  // (src/script/interpreter.cpp:2383-2390, 2406-2410). The SDK must not reject them.
  it.each(cases.filter(testCase => testCase.scenario === 'leaf-version'))(
    '$id: control byte commits under its masked leaf version',
    testCase => {
      const controlByte = testCase.parameters['control_byte'] as number
      const script = testCase.parameters['script'] === 'true' ? Uint8Array.of(0x51) : Uint8Array.of(0x00)
      const leafVersion = controlByte & P2MR_LEAF_VERSION_MASK
      const root = nodeLeafHash(leafVersion, script)
      expect(expectedCommitmentStage(testCase.consensus.stage)).toBe('ok')
      expect(bytesToHex(buildControlBlock(leafVersion))).toBe(bytesToHex(Uint8Array.of(controlByte)))
      expect(evaluateCommitment(Uint8Array.of(controlByte), script, root)).toBe('ok')
    }
  )

  it.each(cases.filter(testCase => typeof testCase.parameters['leaf_script'] === 'string'))(
    '$id: leaf script commits to Core script_pubkey',
    testCase => {
      expect(
        singleLeafScriptPubKey(
          testCase.parameters['control_block'] as string,
          testCase.parameters['leaf_script'] as string
        )
      ).toBe(testCase.parameters['script_pubkey'])
    }
  )

  it('cross-file references resolve to vendored witness vectors', () => {
    const ids = new Set(witnessVectors.vectors.map(vector => vector.id))
    const referencing = cases.filter(testCase => testCase.parameters['fixture_file'] !== undefined)
    expect(referencing.length).toBeGreaterThan(0)
    for (const testCase of referencing) {
      expect(testCase.parameters['fixture_file']).toBe('src/test/data/p2mr_pqc_witness_vectors.json')
      expect(ids.has(testCase.parameters['fixture_id'] as string), testCase.id).toBe(true)
    }
  })

  // The SDK has no script interpreter, so witness-shape, opcode-execution and
  // resource cases (stack limits, validation weight, clean stack) cannot be
  // expressed. This pins the split so a re-vendored file with a new scenario
  // fails here instead of going silently untested.
  it('every case is either checked above or needs a script interpreter', () => {
    const checked = cases.filter(
      testCase =>
        testCase.scenario === 'control-path' ||
        testCase.scenario === 'leaf-version' ||
        typeof testCase.parameters['leaf_script'] === 'string'
    )
    const skipped = cases.filter(testCase => !checked.includes(testCase))
    expect(checked).toHaveLength(16)
    expect([...new Set(skipped.map(testCase => testCase.scenario))].sort()).toEqual([
      'opcode',
      'resource',
      'witness-shape',
    ])
    expect(skipped).toHaveLength(35)
  })
})

// Core builds multi_a leaves as <pk_0> OP_CHECKSIGPQC <pk_i> OP_CHECKSIGADD ...
// <k> OP_NUMEQUAL (src/script/descriptor.cpp:1744-1757), where `<< k` is
// CScript::push_int64 (src/script/script.h:552-567): OP_1..OP_16 for 1..16,
// otherwise a minimal CScriptNum push (script.h:460-491).
describe('multi_a leaf scripts vs Core CScript() << k', () => {
  const CORE_THRESHOLD_PUSH: Record<number, string> = {
    1: '51',
    16: '60',
    17: '0111',
    35: '0123',
    127: '017f',
    128: '028000',
    255: '02ff00',
    256: '020001',
  }
  // Core P2MR_V1_MAX_STANDARD_SIGNATURES (src/script/p2mr_sizing.h:18-24): a
  // leaf that needs more signatures can never be spent, so multiALeafScript may
  // refuse it and is called directly only up to this threshold.
  const MAX_SPENDABLE_THRESHOLD = 35
  const key = (index: number): Uint8Array => {
    const pubkey = new Uint8Array(32).fill(0x02)
    pubkey[0] = index & 0xff
    pubkey[1] = index >> 8
    return pubkey
  }
  /** Core's leaf for a threshold push over keys 0..n-1, written out by hand. */
  const coreLeafScript = (n: number, push: string): Uint8Array =>
    hexToBytes(
      Array.from({ length: n }, (_, i) => `20${bytesToHex(key(i))}${i === 0 ? 'b3' : 'ba'}`).join('') + `${push}9c`
    )
  const cases = Object.entries(CORE_THRESHOLD_PUSH).flatMap(([k, push]) =>
    [Number(k), Number(k) + 1].map(n => ({ k: Number(k), n, push }))
  )

  it.each(cases.filter(({ k }) => k <= MAX_SPENDABLE_THRESHOLD))(
    'multiALeafScript k=$k of n=$n encodes the threshold as $push',
    ({ k, n, push }) => {
      const pubkeys = Array.from({ length: n }, (_, i) => key(i))
      expect(bytesToHex(multiALeafScript(k, pubkeys))).toBe(bytesToHex(coreLeafScript(n, push)))
    }
  )

  // Larger thresholds go through descriptor expansion, which still hashes such
  // a leaf when a pk() sibling keeps the tree spendable, as in Core
  // (HasP2MRStandardSatisfaction, src/script/descriptor.cpp:1785, :1864-1868).
  // The expected root is hashed with node:crypto, so this also pins the 0xfd
  // CompactSize length of these long leaves.
  it.each(cases.filter(({ k }) => k > MAX_SPENDABLE_THRESHOLD))(
    'mr() leaf k=$k of n=$n beside a pk() sibling encodes the threshold as $push',
    ({ k, n, push }) => {
      const sibling = new Uint8Array(32).fill(0x03)
      const pubkeys = Array.from({ length: n }, (_, i) => bytesToHex(key(i)))
      const descriptor = `mr({pk(${bytesToHex(sibling)}),multi_a(${k},${pubkeys.join(',')})})`
      const expectedRoot = nodeBranchHash(
        nodeLeafHash(P2MR_LEAF_VERSION_V1, Uint8Array.of(0x20, ...sibling, 0xb3)),
        nodeLeafHash(P2MR_LEAF_VERSION_V1, coreLeafScript(n, push))
      )
      expect(bytesToHex(p2mrRootFromDescriptor(descriptor))).toBe(bytesToHex(expectedRoot))
    }
  )
})

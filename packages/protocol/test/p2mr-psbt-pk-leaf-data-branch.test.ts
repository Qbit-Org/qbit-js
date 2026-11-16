import { describe, expect, it, vi } from 'vitest'

import vector from '../fixtures/p2mr-pk-leaf-data-branch.json'
import {
  P2MR_LEAF_VERSION_V1,
  PQC_SIGNATURE_BYTES,
  QbitProtocolError,
  buildControlBlock,
  bytesToHex,
  createP2mrPsbt,
  decodePsbt,
  extractP2mrTransaction,
  finalizeP2mrPsbt,
  hexToBytes,
  multiALeafScript,
  p2mrLeafHash,
  p2mrScriptPubKey,
  parsePsbt,
  signP2mrPsbt,
  singleKeyLeafScript,
  validateP2mrSigningPlans,
} from '../src/index'

// A leaf `pk(K)` followed by unexecuted push-only branches, `OP_0 OP_IF <push>*
// OP_ENDIF`, is satisfied by the same single signature as `pk(K)`: the branches
// carry data and change nothing the leaf computes. The vector comes from a qbit
// Core v1.0.1 regtest run in which a spend through such a leaf, signed and
// finalized here, was accepted by `testmempoolaccept`, sent and mined (see
// `source.method` in the fixture).

const pubkey = hexToBytes(vector.pubkeyHex)
const pkLeaf = singleKeyLeafScript(pubkey)
const OP_IF = 0x63
const OP_ENDIF = 0x68

const cat = (...parts: Uint8Array[]): Uint8Array => {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0))
  let offset = 0
  for (const part of parts) {
    out.set(part, offset)
    offset += part.length
  }
  return out
}
const bytes = (...values: number[]) => Uint8Array.from(values)
const branch = (...body: Uint8Array[]) => cat(bytes(0x00, OP_IF), ...body, bytes(OP_ENDIF))
const push = (data: Uint8Array) => cat(bytes(data.length), data)

const dummySignature = () => new Uint8Array(PQC_SIGNATURE_BYTES).fill(0x5a)

/** A one-input PSBT that spends `script` as its only leaf. */
function psbtFor(script: Uint8Array) {
  const leafHash = p2mrLeafHash(P2MR_LEAF_VERSION_V1, script)
  const controlBlock = buildControlBlock(P2MR_LEAF_VERSION_V1, [])
  const scriptPubKey = p2mrScriptPubKey(leafHash)
  return {
    leafHash,
    psbt: createP2mrPsbt({
      inputs: [
        {
          prevout: { txid: new Uint8Array(32).fill(7), vout: 0 },
          witnessUtxo: { value: 100_000n, scriptPubKey },
          leafScript: script,
          controlBlock,
          merkleRoot: leafHash,
        },
      ],
      outputs: [{ value: 90_000n, scriptPubKey }],
    }),
  }
}

function expectProtocolError(fn: () => unknown, code: QbitProtocolError['code'], message: RegExp): void {
  let caught: unknown
  try {
    fn()
  } catch (error) {
    caught = error
  }
  expect(caught).toBeInstanceOf(QbitProtocolError)
  expect((caught as QbitProtocolError).code).toBe(code)
  expect((caught as QbitProtocolError).message).toMatch(message)
}

function plan(script: Uint8Array, key = pubkey) {
  const { psbt, leafHash } = psbtFor(script)
  return () => validateP2mrSigningPlans({ psbt, keys: [{ inputIndex: 0, pubkey: key, leafHash }] })
}

describe('a pk(K) leaf followed by unexecuted data branches (qbit Core regtest vector)', () => {
  const unsigned = parsePsbt(hexToBytes(vector.unsignedPsbtHex))
  const signed = parsePsbt(hexToBytes(vector.signedPsbtHex))
  const leafHash = p2mrLeafHash(P2MR_LEAF_VERSION_V1, hexToBytes(vector.leafScriptHex))

  it('has a leaf that is pk(K) plus one branch', () => {
    const leaf = hexToBytes(vector.leafScriptHex)
    expect(bytesToHex(leaf.subarray(0, pkLeaf.length))).toBe(bytesToHex(pkLeaf))
    expect(leaf.length).toBeGreaterThan(pkLeaf.length)
    expect(decodePsbt(unsigned).inputs[0]!.leafScripts[0]!.script).toEqual(leaf)
  })

  it('accepts a signing plan for the key of the leaf', () => {
    expect(() =>
      validateP2mrSigningPlans({ psbt: unsigned, keys: [{ inputIndex: 0, pubkey, leafHash }] })
    ).not.toThrow()
  })

  it('signs the leaf with SIGHASH_DEFAULT and stores one signature', () => {
    const sign = vi.fn(() => dummySignature())
    const { psbt } = signP2mrPsbt({ psbt: unsigned, keys: [{ inputIndex: 0, pubkey, leafHash }], sign })
    expect(sign).toHaveBeenCalledTimes(1)
    expect(decodePsbt(psbt).inputs[0]!.scriptSigs).toHaveLength(1)
  })

  it('finalizes to the transaction qbit Core mined', () => {
    expect(bytesToHex(extractP2mrTransaction(finalizeP2mrPsbt(signed)))).toBe(vector.rawTxHex)
    expect(vector.confirmations).toBeGreaterThanOrEqual(1)
  })

  it('puts the leaf script and its control block in the witness, after the signature', () => {
    const [witness] = decodePsbt(finalizeP2mrPsbt(signed)).inputs
    expect(witness!.finalized).toBe(true)
    expect(vector.rawTxHex).toContain(vector.leafScriptHex)
    expect(vector.rawTxHex).toContain(vector.controlBlockHex)
  })
})

describe('which leaves are a pk(K) template with data branches', () => {
  const data = (text: string) => push(new TextEncoder().encode(text))

  it('accepts one branch, several branches, an empty branch and every push opcode', () => {
    const pushdata1 = cat(bytes(0x4c, 80), new Uint8Array(80).fill(1))
    const pushdata2 = cat(bytes(0x4d, 0x08, 0x02), new Uint8Array(520).fill(2))
    const pushdata4 = cat(bytes(0x4e, 3, 0, 0, 0), bytes(1, 2, 3))
    for (const script of [
      cat(pkLeaf, branch(data('pins'), data('x'))),
      cat(pkLeaf, branch(data('pins')), branch(data('pins'), bytes(0x00), data('y'))),
      cat(pkLeaf, branch()),
      cat(pkLeaf, branch(bytes(0x00, 0x4f, 0x51, 0x60), pushdata1, pushdata2, pushdata4)),
    ]) {
      expect(plan(script)).not.toThrow()
    }
  })

  it.each([
    ['an executed opcode after the branch', cat(pkLeaf, branch(data('pins')), bytes(0x75))],
    ['trailing bytes after the branch', cat(pkLeaf, branch(data('pins')), bytes(0x00))],
    ['an OP_IF that OP_0 does not guard', cat(pkLeaf, bytes(0x51, OP_IF), data('pins'), bytes(OP_ENDIF))],
    ['an opcode inside the branch', cat(pkLeaf, branch(data('pins'), bytes(0x76)))],
    ['OP_RESERVED (0x50, an OP_SUCCESS) inside the branch', cat(pkLeaf, branch(bytes(0x50)))],
    ['a nested OP_IF', cat(pkLeaf, branch(bytes(0x00, OP_IF, OP_ENDIF)))],
    ['a branch with no OP_ENDIF', cat(pkLeaf, bytes(0x00, OP_IF), data('pins'))],
    ['a push that runs past the end', cat(pkLeaf, bytes(0x00, OP_IF, 0x05, 1, 2, OP_ENDIF))],
    ['an OP_PUSHDATA1 whose length byte is missing', cat(pkLeaf, bytes(0x00, OP_IF, 0x4c))],
    ['an OP_PUSHDATA2 with a missing length', cat(pkLeaf, bytes(0x00, OP_IF, 0x4d, 0x01))],
    ['a push of 521 bytes', cat(pkLeaf, branch(cat(bytes(0x4d, 0x09, 0x02), new Uint8Array(521))))],
    ['a lone OP_0 OP_IF', cat(pkLeaf, bytes(0x00, OP_IF))],
    ['the branch before the key', cat(branch(data('pins')), pkLeaf)],
  ])('refuses %s', (_name, script) => {
    expectProtocolError(plan(script), 'INVALID_PSBT', /not a v1 pk\/multi_a template/)
  })

  it('does not count a key pushed inside a branch as a key of the leaf', () => {
    const other = new Uint8Array(32).fill(0x42)
    expectProtocolError(
      plan(cat(pkLeaf, branch(push(other))), other),
      'INVALID_PSBT',
      /signing pubkey is not used by the selected P2MR leaf script/
    )
  })

  it('does not extend a multi_a leaf', () => {
    const second = new Uint8Array(32).fill(0x43)
    const script = cat(multiALeafScript(2, [pubkey, second]), branch(data('pins')))
    expectProtocolError(plan(script), 'INVALID_PSBT', /not a v1 pk\/multi_a template/)
  })

  it('does not extend a leaf of another version', () => {
    const script = cat(pkLeaf, branch(data('pins')))
    const leafHash = p2mrLeafHash(0xc2, script)
    const controlBlock = buildControlBlock(0xc2, [])
    const psbt = createP2mrPsbt({
      inputs: [
        {
          prevout: { txid: new Uint8Array(32).fill(7), vout: 0 },
          witnessUtxo: { value: 100_000n, scriptPubKey: p2mrScriptPubKey(leafHash) },
          leafScript: script,
          controlBlock,
          leafVersion: 0xc2,
        },
      ],
      outputs: [{ value: 90_000n, scriptPubKey: p2mrScriptPubKey(leafHash) }],
    })
    expectProtocolError(
      () => validateP2mrSigningPlans({ psbt, keys: [{ inputIndex: 0, pubkey, leafHash }] }),
      'INVALID_PSBT',
      /not a v1 pk\/multi_a template/
    )
  })
})

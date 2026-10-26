import { runInNewContext } from 'node:vm'

import { describe, expect, it, vi } from 'vitest'

import {
  P2MR_LEAF_VERSION_V1,
  PQC_SIGNATURE_BYTES,
  SIGHASH_ALL,
  buildControlBlock,
  bytesToHex,
  createP2mrMessageProof,
  createP2mrPsbt,
  encodeP2mrAddress,
  encodeP2mrPsbtLeafScriptField,
  encodeP2mrPsbtScriptSigField,
  encodeP2mrWitnessSignature,
  encodeQbitProprietaryP2mrLeafScriptField,
  encodeQbitProprietaryP2mrMerkleRootField,
  encodeQbitProprietaryP2mrScriptSigField,
  merkleRootFromPath,
  p2mrAddressFromPubkey,
  p2mrBranchHash,
  p2mrLeafHash,
  p2mrScriptPubKey,
  p2mrSighash,
  qbitDataSigPqcHash,
  signP2mrPsbt,
  singleKeyLeafScript,
  validateP2mrSigningPlans,
  verifyControlBlock,
} from '../src/index'

// Byte inputs used to be checked by `.length` alone, so a string, a plain array or
// another typed-array view of the right length was copied, hashed or hex-encoded
// as if it were bytes. A 3680-character string signature became 3680 bytes of
// garbage hex in a message proof, and a `Uint16Array` pubkey was truncated mod
// 256. Every such input now has to be a `Uint8Array` (a Node `Buffer`, or one
// from another realm, still passes).

const PUBKEY = Uint8Array.from({ length: 32 }, (_, i) => i + 1)
const LEAF_SCRIPT = singleKeyLeafScript(PUBKEY)
const LEAF_HASH = p2mrLeafHash(P2MR_LEAF_VERSION_V1, LEAF_SCRIPT)
const CONTROL_BLOCK = buildControlBlock(P2MR_LEAF_VERSION_V1)
const SIGNATURE = new Uint8Array(PQC_SIGNATURE_BYTES).fill(0xab)

/** Values with the right `length` that are not a `Uint8Array`. */
function lookAlikes(bytes: Uint8Array): [string, unknown][] {
  return [
    ['hex string', 'ab'.repeat(bytes.length / 2) + (bytes.length % 2 === 1 ? 'a' : '')],
    ['number[]', [...bytes]],
    ['Uint16Array', Uint16Array.from(bytes)],
    ['Int8Array', new Int8Array(bytes.length)],
    ['Uint8ClampedArray', Uint8ClampedArray.from(bytes)],
    ['DataView', new DataView(new ArrayBuffer(bytes.length))],
    ['array-like object', { length: bytes.length }],
  ]
}

/** Values that must keep working. */
function genuineCopies(bytes: Uint8Array): [string, Uint8Array][] {
  return [
    ['Uint8Array', new Uint8Array(bytes)],
    ['Buffer', Buffer.from(bytes)],
    ['Uint8Array from another realm', runInNewContext(`new Uint8Array([${[...bytes].join(',')}])`) as Uint8Array],
  ]
}

const invalidBytes = (name: string) =>
  expect.objectContaining({ code: 'INVALID_BYTES', message: `${name} must be a Uint8Array` })

describe('byte inputs must be a Uint8Array', () => {
  describe('encodeP2mrWitnessSignature', () => {
    it.each(lookAlikes(SIGNATURE))('rejects a %s signature', (_, signature) => {
      expect(() => encodeP2mrWitnessSignature(signature as Uint8Array)).toThrow(invalidBytes('PQC signature'))
      expect(() => encodeP2mrWitnessSignature(signature as Uint8Array, SIGHASH_ALL)).toThrow(
        invalidBytes('PQC signature')
      )
    })

    it.each(genuineCopies(SIGNATURE))('accepts a %s signature', (_, signature) => {
      expect(bytesToHex(encodeP2mrWitnessSignature(signature))).toBe(bytesToHex(SIGNATURE))
      expect(bytesToHex(encodeP2mrWitnessSignature(signature, SIGHASH_ALL))).toBe(bytesToHex(SIGNATURE) + '01')
    })
  })

  describe('script-signature field encoders', () => {
    const encoders = [
      ['encodeP2mrPsbtScriptSigField', encodeP2mrPsbtScriptSigField],
      ['encodeQbitProprietaryP2mrScriptSigField', encodeQbitProprietaryP2mrScriptSigField],
    ] as const

    describe.each(encoders)('%s', (_, encode) => {
      it.each(lookAlikes(PUBKEY))('rejects a %s pubkey', (_, pubkey) => {
        expect(() => encode(pubkey as Uint8Array, LEAF_HASH, SIGNATURE)).toThrow(invalidBytes('P2MR pubkey'))
      })

      it.each(lookAlikes(LEAF_HASH))('rejects a %s leaf hash', (_, leafHash) => {
        expect(() => encode(PUBKEY, leafHash as Uint8Array, SIGNATURE)).toThrow(invalidBytes('P2MR leaf hash'))
      })

      it.each(lookAlikes(SIGNATURE))('rejects a %s signature', (_, signature) => {
        expect(() => encode(PUBKEY, LEAF_HASH, signature as Uint8Array)).toThrow(invalidBytes('PQC signature'))
      })

      it.each(genuineCopies(SIGNATURE))('accepts a %s signature', (_, signature) => {
        expect(bytesToHex(encode(PUBKEY, LEAF_HASH, signature).value)).toBe(bytesToHex(SIGNATURE))
      })
    })
  })

  describe('leaf-script field encoders', () => {
    const encoders = [
      ['encodeP2mrPsbtLeafScriptField', encodeP2mrPsbtLeafScriptField],
      ['encodeQbitProprietaryP2mrLeafScriptField', encodeQbitProprietaryP2mrLeafScriptField],
    ] as const

    describe.each(encoders)('%s', (_, encode) => {
      it.each(lookAlikes(CONTROL_BLOCK))('rejects a %s control block', (_, controlBlock) => {
        expect(() => encode(controlBlock as Uint8Array, LEAF_SCRIPT)).toThrow(invalidBytes('P2MR control block'))
      })

      it.each(lookAlikes(LEAF_SCRIPT))('rejects a %s script', (_, script) => {
        expect(() => encode(CONTROL_BLOCK, script as Uint8Array)).toThrow(invalidBytes('P2MR leaf script'))
      })

      it.each(genuineCopies(LEAF_SCRIPT))('accepts a %s script', (_, script) => {
        expect(bytesToHex(encode(CONTROL_BLOCK, script).value)).toBe(bytesToHex(LEAF_SCRIPT) + 'c0')
      })
    })
  })

  describe('createP2mrMessageProof', () => {
    const address = p2mrAddressFromPubkey(PUBKEY, 'regtest')
    const proof = (overrides: Record<string, unknown>) =>
      createP2mrMessageProof({ message: 'hello', address, pubkey: PUBKEY, signature: SIGNATURE, ...overrides })

    it('rejects a 3680-character string signature instead of hex-encoding its characters', () => {
      // Before the type check this returned a proof whose `signature` was 7360 hex digits
      // of character codes ('0a0b0a0b...' for 'abab...').
      expect(() => proof({ signature: 'ab'.repeat(PQC_SIGNATURE_BYTES / 2) })).toThrow(
        invalidBytes('P2MR message signature')
      )
    })

    it.each(lookAlikes(SIGNATURE))('rejects a %s signature', (_, signature) => {
      expect(() => proof({ signature })).toThrow(invalidBytes('P2MR message signature'))
    })

    it.each(lookAlikes(PUBKEY))('rejects a %s pubkey', (_, pubkey) => {
      // The default leaf script is built from the pubkey first, so the
      // default's name is reported; with explicit leaf fields it is the proof's.
      expect(() => proof({ pubkey })).toThrow(invalidBytes('P2MR pubkey'))
      expect(() => proof({ pubkey, leafScript: LEAF_SCRIPT, controlBlock: CONTROL_BLOCK })).toThrow(
        invalidBytes('P2MR message pubkey')
      )
    })

    it.each(lookAlikes(LEAF_SCRIPT))('rejects a %s leaf script', (_, leafScript) => {
      expect(() => proof({ leafScript })).toThrow(invalidBytes('P2MR message leaf script'))
    })

    it.each(lookAlikes(CONTROL_BLOCK))('rejects a %s control block', (_, controlBlock) => {
      expect(() => proof({ controlBlock })).toThrow(invalidBytes('P2MR message control block'))
    })

    it.each(genuineCopies(SIGNATURE))('accepts a %s for every byte field', (name, signature) => {
      const copy = (bytes: Uint8Array) => genuineCopies(bytes).find(([kind]) => kind === name)![1]
      const result = proof({
        pubkey: copy(PUBKEY),
        signature,
        leafScript: copy(LEAF_SCRIPT),
        controlBlock: copy(CONTROL_BLOCK),
      })
      expect(result.signature).toBe(bytesToHex(SIGNATURE))
      expect(result.pubkey).toBe(bytesToHex(PUBKEY))
      expect(result.leaf_script).toBe(bytesToHex(LEAF_SCRIPT))
      expect(result.control_block).toBe(bytesToHex(CONTROL_BLOCK))
    })
  })

  describe('signing keys', () => {
    const psbt = createP2mrPsbt({
      inputs: [
        {
          prevout: { txid: new Uint8Array(32).fill(7), vout: 0 },
          witnessUtxo: { value: 10_000n, scriptPubKey: p2mrScriptPubKey(LEAF_HASH) },
          leafScript: LEAF_SCRIPT,
          controlBlock: CONTROL_BLOCK,
        },
      ],
      outputs: [{ value: 9_000n, scriptPubKey: p2mrScriptPubKey(LEAF_HASH) }],
    })

    it.each([
      ['pubkey', 'P2MR signing pubkey', { pubkey: Uint16Array.from(PUBKEY), leafHash: LEAF_HASH }],
      ['leaf hash', 'P2MR signing leaf hash', { pubkey: PUBKEY, leafHash: Uint16Array.from(LEAF_HASH) }],
    ])('refuses a Uint16Array %s before any signer call instead of truncating it', (_, name, key) => {
      // Before the type check the plan copied the view into a Uint8Array first, which
      // truncated each element mod 256, then checked only the copy's length.
      const keys = [{ inputIndex: 0, ...key } as never]
      const sign = vi.fn(() => SIGNATURE)
      expect(() => validateP2mrSigningPlans({ psbt, keys })).toThrow(invalidBytes(name))
      expect(() => signP2mrPsbt({ psbt, keys, sign })).toThrow(invalidBytes(name))
      expect(sign).not.toHaveBeenCalled()
    })

    it.each(lookAlikes(PUBKEY))('rejects a %s pubkey with INVALID_BYTES', (_, pubkey) => {
      const keys = [{ inputIndex: 0, pubkey, leafHash: LEAF_HASH } as never]
      expect(() => validateP2mrSigningPlans({ psbt, keys })).toThrow(invalidBytes('P2MR signing pubkey'))
    })

    it.each(genuineCopies(PUBKEY))('signs with a %s pubkey and leaf hash', (name, pubkey) => {
      const leafHash = genuineCopies(LEAF_HASH).find(([kind]) => kind === name)![1]
      const { signed } = signP2mrPsbt({ psbt, keys: [{ inputIndex: 0, pubkey, leafHash }], sign: () => SIGNATURE })
      expect(signed).toHaveLength(1)
    })
  })

  describe('fixed-length helpers', () => {
    const sibling = new Uint8Array(32).fill(9)
    const cases: [string, Uint8Array, string, (bytes: never) => unknown][] = [
      ['encodeP2mrAddress', PUBKEY, 'P2MR program', bytes => encodeP2mrAddress(bytes, 'regtest')],
      ['p2mrScriptPubKey', PUBKEY, 'P2MR merkle root', bytes => p2mrScriptPubKey(bytes)],
      ['singleKeyLeafScript', PUBKEY, 'P2MR pubkey', bytes => singleKeyLeafScript(bytes)],
      ['p2mrBranchHash', PUBKEY, 'left P2MR branch', bytes => p2mrBranchHash(bytes, sibling)],
      ['merkleRootFromPath', sibling, 'P2MR sibling 0', bytes => merkleRootFromPath(LEAF_HASH, [bytes])],
      ['buildControlBlock', sibling, 'P2MR sibling 0', bytes => buildControlBlock(P2MR_LEAF_VERSION_V1, [bytes])],
      ['qbitDataSigPqcHash', PUBKEY, 'Qbit wallet message hash', bytes => qbitDataSigPqcHash(bytes)],
      [
        'encodeQbitProprietaryP2mrMerkleRootField',
        PUBKEY,
        'qbit P2MR merkle root',
        bytes => encodeQbitProprietaryP2mrMerkleRootField(bytes),
      ],
    ]

    describe.each(cases)('%s', (_, valid, name, call) => {
      it.each(lookAlikes(valid))('rejects a %s', (_, bytes) => {
        expect(() => call(bytes as never)).toThrow(invalidBytes(name))
      })

      it('gives a Buffer the same result as a Uint8Array', () => {
        const fromBuffer = call(Buffer.from(valid) as never)
        const fromBytes = call(new Uint8Array(valid) as never)
        expect(fromBuffer).toEqual(fromBytes)
      })
    })
  })

  describe('variable-length hashing inputs', () => {
    it('p2mrLeafHash rejects a string script instead of hashing zeros', () => {
      const asString = 'x'.repeat(LEAF_SCRIPT.length)
      expect(() => p2mrLeafHash(P2MR_LEAF_VERSION_V1, asString as never)).toThrow(invalidBytes('P2MR leaf script'))
      expect(bytesToHex(p2mrLeafHash(P2MR_LEAF_VERSION_V1, Buffer.from(LEAF_SCRIPT)))).toBe(bytesToHex(LEAF_HASH))
    })

    it('verifyControlBlock rejects a number[] control block', () => {
      expect(() => verifyControlBlock([...CONTROL_BLOCK] as never, LEAF_HASH)).toThrow(
        invalidBytes('P2MR control block')
      )
      expect(bytesToHex(verifyControlBlock(Buffer.from(CONTROL_BLOCK), LEAF_HASH))).toBe(bytesToHex(LEAF_HASH))
    })

    it('p2mrSighash rejects a 32-character string leaf hash instead of committing to zeros', () => {
      const params = {
        tx: {
          version: 2,
          locktime: 0,
          inputs: [{ prevout: { txid: new Uint8Array(32), vout: 0 }, sequence: 0 }],
          outputs: [{ value: 1n, scriptPubKey: p2mrScriptPubKey(LEAF_HASH) }],
        },
        inputIndex: 0,
        spentOutputs: [{ value: 2n, scriptPubKey: p2mrScriptPubKey(LEAF_HASH) }],
      }
      expect(() => p2mrSighash({ ...params, leafHash: 'h'.repeat(32) as never })).toThrow(
        expect.objectContaining({ code: 'INVALID_SIGHASH' })
      )
      expect(bytesToHex(p2mrSighash({ ...params, leafHash: Buffer.from(LEAF_HASH) }))).toBe(
        bytesToHex(p2mrSighash({ ...params, leafHash: LEAF_HASH }))
      )
    })
  })
})

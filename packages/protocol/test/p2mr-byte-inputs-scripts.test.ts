import { runInNewContext } from 'node:vm'

import { describe, expect, it, vi } from 'vitest'

import {
  P2MR_LEAF_VERSION_V1,
  PQC_SIGNATURE_BYTES,
  PSBT_IN_P2MR_SCRIPT_SIG,
  SIGHASH_ALL,
  SIGHASH_ANYONECANPAY,
  SIGHASH_SINGLE,
  buildControlBlock,
  createP2mrPsbt,
  decodeP2mrPsbtScriptSigField,
  decodeP2mrWitnessSignature,
  outputScriptToAddress,
  p2mrLeafHash,
  p2mrScriptPubKey,
  p2mrSighash,
  precomputeSighashMidstates,
  psbtUnsignedTransaction,
  singleKeyLeafScript,
  type P2mrSighashParams,
} from '../src/index'

// Byte inputs, continued: the variable-length byte inputs (scripts, the annex, witness
// signatures) were never type-checked. A hex-string scriptPubKey in
// `spentOutputs` was hashed as different bytes, so the digest a signer was
// handed was one Core never computes; with `restrictedOutputMode: false` a string
// output script was serialized into the PSBT as garbage; a 3680-character
// string decoded as a 0-byte signature; and `outputScriptToAddress` truncated a
// `Uint16Array` into a different address. Each now throws INVALID_BYTES.

const PUBKEY = Uint8Array.from({ length: 32 }, (_, i) => i + 1)
const LEAF_SCRIPT = singleKeyLeafScript(PUBKEY)
const LEAF_HASH = p2mrLeafHash(P2MR_LEAF_VERSION_V1, LEAF_SCRIPT)
const SPK = p2mrScriptPubKey(LEAF_HASH)
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
  ]
}

/** Values that must keep working. */
function genuineCopies(bytes: Uint8Array): [string, Uint8Array][] {
  return [
    ['Buffer', Buffer.from(bytes)],
    ['Uint8Array from another realm', runInNewContext(`new Uint8Array([${[...bytes].join(',')}])`) as Uint8Array],
  ]
}

const invalidBytes = (name: string) =>
  expect.objectContaining({ code: 'INVALID_BYTES', message: `${name} must be a Uint8Array` })

function sighashParams(overrides: { spentScript?: unknown; outputScript?: unknown } = {}): P2mrSighashParams {
  return {
    tx: {
      version: 2,
      locktime: 0,
      inputs: [{ prevout: { txid: new Uint8Array(32).fill(1), vout: 0 }, sequence: 0 }],
      outputs: [{ value: 1000n, scriptPubKey: (overrides.outputScript ?? SPK) as Uint8Array }],
    },
    inputIndex: 0,
    spentOutputs: [{ value: 2000n, scriptPubKey: (overrides.spentScript ?? SPK) as Uint8Array }],
    leafHash: LEAF_HASH,
  }
}

function psbtInput(witnessScript: unknown = SPK) {
  return {
    prevout: { txid: new Uint8Array(32).fill(1), vout: 0 },
    witnessUtxo: { value: 100_000n, scriptPubKey: witnessScript as Uint8Array },
    leafScript: LEAF_SCRIPT,
    controlBlock: CONTROL_BLOCK,
  }
}

describe('script, annex and witness-signature byte inputs must be a Uint8Array', () => {
  describe('p2mrSighash', () => {
    const genuine = p2mrSighash(sighashParams())

    it.each(lookAlikes(SPK))('rejects a %s spent-output scriptPubKey before any signer call', (_, script) => {
      const sign = vi.fn()
      const params = sighashParams({ spentScript: script })
      for (const hashType of [undefined, SIGHASH_ALL, SIGHASH_ANYONECANPAY | SIGHASH_ALL]) {
        expect(() => sign(p2mrSighash({ ...params, hashType }))).toThrow(invalidBytes('spent output 0 scriptPubKey'))
      }
      // A cached midstate cannot stand in for the unchecked script.
      const midstates = precomputeSighashMidstates(sighashParams().tx, sighashParams().spentOutputs)
      expect(() => sign(p2mrSighash({ ...params, midstates }))).toThrow(invalidBytes('spent output 0 scriptPubKey'))
      expect(() => precomputeSighashMidstates(params.tx, params.spentOutputs)).toThrow(
        invalidBytes('spent output 0 scriptPubKey')
      )
      expect(sign).not.toHaveBeenCalled()
    })

    it.each(lookAlikes(SPK))('rejects a %s output scriptPubKey', (_, script) => {
      const params = sighashParams({ outputScript: script })
      for (const hashType of [undefined, SIGHASH_SINGLE]) {
        expect(() => p2mrSighash({ ...params, hashType })).toThrow(invalidBytes('output 0 scriptPubKey'))
      }
    })

    it.each(lookAlikes(new Uint8Array([0x50, 1, 2, 3])))('rejects a %s annex', (_, annex) => {
      expect(() => p2mrSighash({ ...sighashParams(), annex: annex as Uint8Array })).toThrow(invalidBytes('annex'))
    })

    it.each(genuineCopies(SPK))('hashes a %s scriptPubKey to the same digest', (_, script) => {
      expect(p2mrSighash(sighashParams({ spentScript: script, outputScript: script }))).toEqual(genuine)
    })
  })

  describe('createP2mrPsbt', () => {
    it.each(lookAlikes(SPK))('rejects a %s output script with restrictedOutputMode: false', (_, script) => {
      expect(() =>
        createP2mrPsbt({
          inputs: [psbtInput()],
          outputs: [{ value: 1000n, scriptPubKey: script as Uint8Array }],
          restrictedOutputMode: false,
        })
      ).toThrow(invalidBytes('output 0 scriptPubKey'))
    })

    it.each(lookAlikes(SPK))('rejects a %s witness UTXO scriptPubKey', (_, script) => {
      for (const restrictedOutputMode of [undefined, false]) {
        expect(() =>
          createP2mrPsbt({
            inputs: [psbtInput(script)],
            outputs: [{ value: 1000n, scriptPubKey: SPK }],
            restrictedOutputMode,
          })
        ).toThrow(invalidBytes('input 0 witness UTXO scriptPubKey'))
      }
    })

    it.each(genuineCopies(SPK))('accepts a %s output and witness UTXO script', (_, script) => {
      const psbt = createP2mrPsbt({
        inputs: [psbtInput(script)],
        outputs: [{ value: 1000n, scriptPubKey: script }],
        restrictedOutputMode: false,
      })
      expect(psbtUnsignedTransaction(psbt).outputs[0]!.scriptPubKey).toEqual(SPK)
    })
  })

  describe('decodeP2mrWitnessSignature', () => {
    it.each([...lookAlikes(SIGNATURE), ...lookAlikes(new Uint8Array([...SIGNATURE, SIGHASH_ALL]))])(
      'rejects a %s signature',
      (_, value) => {
        expect(() => decodeP2mrWitnessSignature(value as Uint8Array)).toThrow(invalidBytes('P2MR witness signature'))
      }
    )

    it.each(genuineCopies(SIGNATURE))('decodes a %s signature', (_, value) => {
      expect(decodeP2mrWitnessSignature(value).signature).toEqual(SIGNATURE)
    })
  })

  describe('decodeP2mrPsbtScriptSigField', () => {
    const key = Uint8Array.from([PSBT_IN_P2MR_SCRIPT_SIG, ...PUBKEY, ...LEAF_HASH])

    it.each(lookAlikes(SIGNATURE))('rejects a %s value', (_, value) => {
      expect(() => decodeP2mrPsbtScriptSigField(key, value as Uint8Array)).toThrow(
        invalidBytes('P2MR witness signature')
      )
    })

    it.each(lookAlikes(key))('rejects a %s key', (_, badKey) => {
      expect(() => decodeP2mrPsbtScriptSigField(badKey as Uint8Array, SIGNATURE)).toThrow(
        invalidBytes('P2MR script signature key')
      )
    })
  })

  describe('outputScriptToAddress', () => {
    const genuine = outputScriptToAddress(SPK, 'mainnet')

    it.each(lookAlikes(SPK))('rejects a %s scriptPubKey', (_, script) => {
      expect(() => outputScriptToAddress(script as Uint8Array, 'mainnet')).toThrow(invalidBytes('scriptPubKey'))
    })

    it('rejects a Uint16Array whose values truncate to a valid script', () => {
      const wide = Uint16Array.from(SPK, (b, i) => (i < 2 ? b : b + 0x100))
      expect(() => outputScriptToAddress(wide as unknown as Uint8Array, 'mainnet')).toThrow(
        invalidBytes('scriptPubKey')
      )
    })

    it.each(genuineCopies(SPK))('encodes a %s scriptPubKey', (_, script) => {
      expect(outputScriptToAddress(script, 'mainnet')).toBe(genuine)
    })
  })
})

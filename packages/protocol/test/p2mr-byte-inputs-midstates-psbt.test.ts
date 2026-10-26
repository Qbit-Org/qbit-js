import { runInNewContext } from 'node:vm'

import { describe, expect, it, vi } from 'vitest'

import {
  P2MR_LEAF_VERSION_V1,
  PQC_SIGNATURE_BYTES,
  PSBT_QBIT_IN_P2MR_LEAF_SCRIPT,
  PSBT_QBIT_IN_P2MR_MERKLE_ROOT,
  PSBT_QBIT_IN_P2MR_SCRIPT_SIG,
  SIGHASH_ALL,
  SIGHASH_ANYONECANPAY,
  buildControlBlock,
  createP2mrPsbt,
  decodeQbitProprietaryP2mrInputField,
  encodeP2mrWitnessSignature,
  outputScriptToAddress,
  p2mrLeafHash,
  p2mrScriptPubKey,
  p2mrSighash,
  parsePsbt,
  precomputeSighashMidstates,
  schnorrSignatureHash,
  serializePsbt,
  singleKeyLeafScript,
  type P2mrSighashParams,
  type Psbt,
  type SighashMidstates,
} from '../src/index'

// Byte inputs, continued. Cached sighash `midstates` were hashed into the
// digest unchecked, so a hex-string field gave a digest Core never computes and
// a signature spent on it was lost. `decodeQbitProprietaryP2mrInputField`
// copied a string `keyData` as zeros before any check. `serializePsbt` threw a
// raw TypeError for an `undefined` map key. And `isUint8Array` trusted an own
// `Symbol.toStringTag`, so a Uint16Array claiming 'Uint8Array' was accepted
// and truncated. Each now throws INVALID_BYTES.

const PUBKEY = Uint8Array.from({ length: 32 }, (_, i) => i + 1)
const LEAF_SCRIPT = singleKeyLeafScript(PUBKEY)
const LEAF_HASH = p2mrLeafHash(P2MR_LEAF_VERSION_V1, LEAF_SCRIPT)
const SPK = p2mrScriptPubKey(LEAF_HASH)
const CONTROL_BLOCK = buildControlBlock(P2MR_LEAF_VERSION_V1)
const SIGNATURE = new Uint8Array(PQC_SIGNATURE_BYTES).fill(0xab)

/** A Uint16Array whose own `Symbol.toStringTag` claims to be a Uint8Array. */
function fakeTag(bytes: Uint8Array): Uint16Array {
  const wide = Uint16Array.from(bytes, b => b + 0x100)
  Object.defineProperty(wide, Symbol.toStringTag, { value: 'Uint8Array' })
  return wide
}

/** Values with the right `length` that are not a `Uint8Array`. */
function lookAlikes(bytes: Uint8Array): [string, unknown][] {
  return [
    ['hex string', 'ab'.repeat(bytes.length / 2) + (bytes.length % 2 === 1 ? 'a' : '')],
    ['number[]', [...bytes]],
    ['Uint16Array', Uint16Array.from(bytes)],
    ['Uint8ClampedArray', Uint8ClampedArray.from(bytes)],
    ['DataView', new DataView(new ArrayBuffer(bytes.length))],
    ['fake-tag Uint16Array', fakeTag(bytes)],
    ['prototype-swapped Uint16Array', Object.setPrototypeOf(Uint16Array.from(bytes), Uint8Array.prototype)],
    ['undefined', undefined],
  ]
}

class Bytes extends Uint8Array {}

/** Values that must keep working. */
function genuineCopies(bytes: Uint8Array): [string, Uint8Array][] {
  const padded = new Uint8Array(bytes.length + 5)
  padded.set(bytes, 3)
  return [
    ['Buffer', Buffer.from(bytes)],
    ['subarray', padded.subarray(3, 3 + bytes.length)],
    ['subclass', Bytes.from(bytes)],
    ['Uint8Array from another realm', runInNewContext(`new Uint8Array([${[...bytes].join(',')}])`) as Uint8Array],
    [
      'subclass from another realm',
      runInNewContext(`class B extends Uint8Array {}; B.from([${[...bytes].join(',')}])`) as Uint8Array,
    ],
  ]
}

const invalidBytes = (name: string) =>
  expect.objectContaining({ code: 'INVALID_BYTES', message: `${name} must be a Uint8Array` })

function sighashParams(): P2mrSighashParams {
  return {
    tx: {
      version: 2,
      locktime: 0,
      inputs: [{ prevout: { txid: new Uint8Array(32).fill(1), vout: 0 }, sequence: 0 }],
      outputs: [{ value: 1000n, scriptPubKey: SPK }],
    },
    inputIndex: 0,
    spentOutputs: [{ value: 2000n, scriptPubKey: SPK }],
    leafHash: LEAF_HASH,
  }
}

describe('byte inputs: cached midstates, proprietary key data, PSBT maps', () => {
  describe('a typed array whose own Symbol.toStringTag claims Uint8Array', () => {
    const cases: [string, Uint8Array, (value: Uint8Array) => unknown][] = [
      ['p2mrScriptPubKey', LEAF_HASH, value => p2mrScriptPubKey(value)],
      ['encodeP2mrWitnessSignature', SIGNATURE, value => encodeP2mrWitnessSignature(value)],
      ['p2mrLeafHash', LEAF_SCRIPT, value => p2mrLeafHash(P2MR_LEAF_VERSION_V1, value)],
      ['outputScriptToAddress', SPK, value => outputScriptToAddress(value, 'mainnet')],
    ]

    it.each(cases)('%s rejects it instead of truncating each element mod 256', (_, bytes, call) => {
      expect(() => call(fakeTag(bytes) as unknown as Uint8Array)).toThrow(
        expect.objectContaining({ code: 'INVALID_BYTES' })
      )
    })

    it.each(cases)('%s still accepts a subclass and a cross-realm Uint8Array', (_, bytes, call) => {
      const expected = call(bytes)
      for (const [, copy] of genuineCopies(bytes)) expect(call(copy)).toEqual(expected)
    })
  })

  describe('cached sighash midstates', () => {
    const params = sighashParams()
    const midstates = precomputeSighashMidstates(params.tx, params.spentOutputs)
    const fields = ['prevouts', 'amounts', 'scriptPubKeys', 'sequences', 'outputs'] as const
    const genuine = p2mrSighash(params)
    const withField = (field: (typeof fields)[number], value: unknown): SighashMidstates => ({
      ...midstates,
      [field]: value,
    })

    describe.each(fields)('%s', field => {
      it.each(lookAlikes(midstates[field]))('rejects a %s before any signer call', (_, value) => {
        const sign = vi.fn()
        for (const hashType of [undefined, SIGHASH_ALL, SIGHASH_ANYONECANPAY | SIGHASH_ALL]) {
          expect(() => sign(p2mrSighash({ ...params, hashType, midstates: withField(field, value) }))).toThrow(
            invalidBytes(`midstates.${field}`)
          )
          expect(() =>
            sign(
              schnorrSignatureHash({ ...params, hashType, sigVersion: 'taproot', midstates: withField(field, value) })
            )
          ).toThrow(invalidBytes(`midstates.${field}`))
        }
        expect(sign).not.toHaveBeenCalled()
      })

      it('rejects a 31-byte field instead of hashing it short', () => {
        expect(() => p2mrSighash({ ...params, midstates: withField(field, midstates[field].subarray(0, 31)) })).toThrow(
          expect.objectContaining({ code: 'INVALID_BYTES', message: `midstates.${field} must be 32 bytes` })
        )
      })

      it.each(genuineCopies(midstates[field]))('gives a %s field the same digest', (_, value) => {
        expect(p2mrSighash({ ...params, midstates: withField(field, value) })).toEqual(genuine)
      })
    })

    it('still computes the midstates when none are given', () => {
      expect(p2mrSighash({ ...params, midstates })).toEqual(genuine)
      expect(p2mrSighash({ ...params, midstates: undefined })).toEqual(genuine)
    })
  })

  describe('decodeQbitProprietaryP2mrInputField key data', () => {
    const scriptSigKey = Uint8Array.from([...PUBKEY, ...LEAF_HASH])
    const leafScriptValue = Uint8Array.from([...LEAF_SCRIPT, P2MR_LEAF_VERSION_V1])
    const subtypes: [string, number, Uint8Array, Uint8Array][] = [
      ['script signature', PSBT_QBIT_IN_P2MR_SCRIPT_SIG, scriptSigKey, SIGNATURE],
      ['leaf script', PSBT_QBIT_IN_P2MR_LEAF_SCRIPT, CONTROL_BLOCK, leafScriptValue],
      ['merkle root', PSBT_QBIT_IN_P2MR_MERKLE_ROOT, new Uint8Array(), LEAF_HASH],
    ]

    describe.each(subtypes)('%s', (_, subtype, keyData, value) => {
      const genuine = decodeQbitProprietaryP2mrInputField(subtype, keyData, value)

      it.each(lookAlikes(keyData))('rejects a %s instead of decoding it as different bytes', (_, bad) => {
        expect(() => decodeQbitProprietaryP2mrInputField(subtype, bad as Uint8Array, value)).toThrow(
          invalidBytes('qbit P2MR key data')
        )
      })

      it.each(genuineCopies(keyData))('decodes a %s the same way', (_, copy) => {
        expect(decodeQbitProprietaryP2mrInputField(subtype, copy, value)).toEqual(genuine)
      })
    })

    it("no longer decodes 'ab' x32 as an all-zero pubkey and leaf hash", () => {
      expect(() =>
        decodeQbitProprietaryP2mrInputField(
          PSBT_QBIT_IN_P2MR_SCRIPT_SIG,
          'ab'.repeat(32) as unknown as Uint8Array,
          encodeP2mrWitnessSignature(SIGNATURE)
        )
      ).toThrow(invalidBytes('qbit P2MR key data'))
    })
  })

  describe('serializePsbt map entries', () => {
    const psbt = createP2mrPsbt({
      inputs: [
        {
          prevout: { txid: new Uint8Array(32).fill(1), vout: 0 },
          witnessUtxo: { value: 100_000n, scriptPubKey: SPK },
          leafScript: LEAF_SCRIPT,
          controlBlock: CONTROL_BLOCK,
        },
      ],
      outputs: [{ value: 1000n, scriptPubKey: SPK }],
    })
    const bytes = serializePsbt(psbt)
    const withInputEntry = (index: number, entry: { key?: unknown; value?: unknown }): Psbt => ({
      ...psbt,
      inputs: [psbt.inputs[0]!.map((e, i) => (i === index ? ({ ...e, ...entry } as typeof e) : e))],
    })

    it.each(lookAlikes(psbt.inputs[0]![0]!.key))('rejects a %s key', (_, key) => {
      expect(() => serializePsbt(withInputEntry(0, { key }))).toThrow(invalidBytes('PSBT key'))
    })

    it.each(lookAlikes(psbt.inputs[0]![0]!.value))('rejects a %s value', (_, value) => {
      expect(() => serializePsbt(withInputEntry(0, { value }))).toThrow(invalidBytes('PSBT value'))
    })

    it('still rejects an empty key as INVALID_PSBT', () => {
      expect(() => serializePsbt(withInputEntry(0, { key: new Uint8Array() }))).toThrow(
        expect.objectContaining({ code: 'INVALID_PSBT', message: 'empty key in PSBT map' })
      )
    })

    it.each(genuineCopies(psbt.inputs[0]![0]!.value))('serializes a %s value to the same bytes', (_, value) => {
      expect(serializePsbt(withInputEntry(0, { value }))).toEqual(bytes)
      expect(parsePsbt(bytes)).toEqual(psbt)
    })
  })
})

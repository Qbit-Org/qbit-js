import { describe, expect, it } from 'vitest'

import {
  PSBT_GLOBAL_UNSIGNED_TX,
  PSBT_IN_FINAL_SCRIPTWITNESS,
  PSBT_IN_PROPRIETARY,
  PSBT_IN_WITNESS_UTXO,
  PSBT_QBIT_IN_P2MR_LEAF_SCRIPT,
  PSBT_QBIT_IN_P2MR_MERKLE_ROOT,
  PSBT_QBIT_IN_P2MR_SCRIPT_SIG,
  QbitProtocolError,
  bytesToHex,
  combinePsbts,
  decodePsbt,
  extractP2mrTransaction,
  parsePsbt,
  psbtUnsignedTransaction,
  serializePsbt,
  type Psbt,
} from '../src/index'

// qbit Core `ReadCompactSize` accepts only the shortest encoding of a value,
// throws `non-canonical ReadCompactSize()` otherwise and `size too large` above
// MAX_SIZE (0x02000000). Core's PSBT deserializer also reads each map key's type
// as a CompactSize and unserializes proprietary keys eagerly. These tests build
// PSBTs by hand so each CompactSize can be forced into a longer-than-necessary form.
const MAX_SIZE = 0x02000000

type CompactSizeWidth = 1 | 3 | 5 | 9

/** Encode `value` as a CompactSize; `width` forces a (possibly non-canonical) prefix. */
function compactSize(value: number, width?: CompactSizeWidth): Uint8Array {
  const chosen = width ?? (value < 0xfd ? 1 : value <= 0xffff ? 3 : value <= 0xffffffff ? 5 : 9)
  if (chosen === 1) return Uint8Array.of(value)
  const out = new Uint8Array(chosen)
  out[0] = chosen === 3 ? 0xfd : chosen === 5 ? 0xfe : 0xff
  let remaining = BigInt(value)
  for (let i = 1; i < chosen; i += 1) {
    out[i] = Number(remaining & 0xffn)
    remaining >>= 8n
  }
  return out
}

function concat(...parts: readonly Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0))
  let offset = 0
  for (const part of parts) {
    out.set(part, offset)
    offset += part.length
  }
  return out
}

function uint32LE(value: number): Uint8Array {
  const out = new Uint8Array(4)
  new DataView(out.buffer).setUint32(0, value, true)
  return out
}

function int64LE(value: bigint): Uint8Array {
  const out = new Uint8Array(8)
  new DataView(out.buffer).setBigInt64(0, value, true)
  return out
}

function varBytes(bytes: Uint8Array, width?: CompactSizeWidth): Uint8Array {
  return concat(compactSize(bytes.length, width), bytes)
}

function fill(length: number, byte: number): Uint8Array {
  return new Uint8Array(length).fill(byte)
}

const MAGIC = Uint8Array.of(0x70, 0x73, 0x62, 0x74, 0xff)
const TXID = Uint8Array.from({ length: 32 }, (_, i) => i + 1)
const SCRIPT_PUBKEY = concat(Uint8Array.of(0x51, 0x20), fill(32, 0x22))
const MERKLE_ROOT_A = fill(32, 0xaa)
const MERKLE_ROOT_B = fill(32, 0xbb)

/** One input, one output; each CompactSize inside can be overridden. */
function unsignedTx(
  overrides: {
    inputCount?: Uint8Array
    scriptSig?: Uint8Array
    outputCount?: Uint8Array
    scriptPubKey?: Uint8Array
  } = {}
): Uint8Array {
  return concat(
    uint32LE(2),
    overrides.inputCount ?? compactSize(1),
    TXID,
    uint32LE(0),
    overrides.scriptSig ?? compactSize(0),
    uint32LE(0xfffffffd),
    overrides.outputCount ?? compactSize(1),
    int64LE(50_000n),
    overrides.scriptPubKey ?? varBytes(SCRIPT_PUBKEY),
    uint32LE(0)
  )
}

/** A serialized map entry whose key / value length prefixes can be widened. */
function entry(
  key: Uint8Array,
  value: Uint8Array,
  widths: { key?: CompactSizeWidth; value?: CompactSizeWidth } = {}
): Uint8Array {
  return concat(varBytes(key, widths.key), varBytes(value, widths.value))
}

function map(...entries: readonly Uint8Array[]): Uint8Array {
  return concat(...entries, Uint8Array.of(0x00))
}

function unsignedTxEntry(
  tx: Uint8Array = unsignedTx(),
  widths: { key?: CompactSizeWidth; value?: CompactSizeWidth } = {}
): Uint8Array {
  return entry(Uint8Array.of(PSBT_GLOBAL_UNSIGNED_TX), tx, widths)
}

/** magic + global map + one input map + one output map. */
function psbtBytes(
  global: Uint8Array = map(unsignedTxEntry()),
  input: Uint8Array = map(),
  output: Uint8Array = map()
): Uint8Array {
  return concat(MAGIC, global, input, output)
}

/** `fc <identifier-length> 'qbit' <subtype> [key data]`; type and identifier length can be widened. */
function qbitProprietaryKey(
  subtype: number,
  options: { identifierWidth?: CompactSizeWidth; typeWidth?: CompactSizeWidth; keyData?: Uint8Array } = {}
): Uint8Array {
  return concat(
    compactSize(PSBT_IN_PROPRIETARY, options.typeWidth),
    varBytes(Uint8Array.of(0x71, 0x62, 0x69, 0x74), options.identifierWidth),
    compactSize(subtype),
    options.keyData ?? new Uint8Array()
  )
}

function psbtObject(global: Uint8Array = unsignedTx(), input: Psbt['inputs'][number] = []): Psbt {
  return {
    global: [{ key: Uint8Array.of(PSBT_GLOBAL_UNSIGNED_TX), value: global }],
    inputs: [input],
    outputs: [[]],
  }
}

function expectNonCanonical(fn: () => unknown): void {
  let caught: unknown
  try {
    fn()
  } catch (error) {
    caught = error
  }
  expect(caught).toBeInstanceOf(QbitProtocolError)
  expect((caught as QbitProtocolError).code).toBe('INVALID_PSBT')
  expect((caught as QbitProtocolError).message).toMatch(/non-canonical compact size/)
}

const WIDER_THAN_ONE_BYTE: readonly CompactSizeWidth[] = [3, 5, 9]

describe('CompactSize canonical encoding (qbit Core ReadCompactSize)', () => {
  it('parses the hand-built baseline PSBT', () => {
    const psbt = parsePsbt(psbtBytes())
    expect(psbtUnsignedTransaction(psbt).inputs.length).toBe(1)
    expect(bytesToHex(serializePsbt(psbt))).toBe(bytesToHex(psbtBytes()))
  })

  describe('PSBT map key and value lengths', () => {
    it.each(WIDER_THAN_ONE_BYTE)('rejects a %i-byte encoding of a 1-byte key length', width => {
      expectNonCanonical(() => parsePsbt(psbtBytes(map(unsignedTxEntry(unsignedTx(), { key: width })))))
    })

    it.each(WIDER_THAN_ONE_BYTE)('rejects a %i-byte encoding of a short value length', width => {
      expectNonCanonical(() => parsePsbt(psbtBytes(map(unsignedTxEntry(unsignedTx(), { value: width })))))
    })

    it('rejects a non-canonical key length in an input map', () => {
      const input = map(entry(Uint8Array.of(0x77), fill(4, 0x01), { key: 3 }))
      expectNonCanonical(() => parsePsbt(psbtBytes(undefined, input)))
    })

    it('rejects a non-canonical zero (fd 00 00) where the map terminator is expected', () => {
      // A non-canonical zero must not be accepted as the end-of-map marker.
      const bytes = concat(MAGIC, unsignedTxEntry(), Uint8Array.of(0xfd, 0x00, 0x00), map(), map())
      expectNonCanonical(() => parsePsbt(bytes))
    })
  })

  describe('unsigned transaction', () => {
    it('rejects a non-canonical input count (fd 01 00)', () => {
      const tx = unsignedTx({ inputCount: compactSize(1, 3) })
      expectNonCanonical(() => parsePsbt(psbtBytes(map(unsignedTxEntry(tx)))))
      expectNonCanonical(() => psbtUnsignedTransaction(psbtObject(tx)))
    })

    it('rejects a non-canonical output count (fe 01 00 00 00)', () => {
      const tx = unsignedTx({ outputCount: compactSize(1, 5) })
      expectNonCanonical(() => parsePsbt(psbtBytes(map(unsignedTxEntry(tx)))))
    })

    it('rejects a non-canonical empty scriptSig length (fd 00 00)', () => {
      const tx = unsignedTx({ scriptSig: compactSize(0, 3) })
      expectNonCanonical(() => parsePsbt(psbtBytes(map(unsignedTxEntry(tx)))))
    })

    it('rejects a non-canonical scriptPubKey length (ff …) in an output', () => {
      const tx = unsignedTx({ scriptPubKey: varBytes(SCRIPT_PUBKEY, 9) })
      expectNonCanonical(() => parsePsbt(psbtBytes(map(unsignedTxEntry(tx)))))
    })
  })

  describe('witness UTXO and final scriptwitness', () => {
    it('rejects a non-canonical scriptPubKey length in a witness UTXO when decoding', () => {
      const witnessUtxo = concat(int64LE(60_000n), varBytes(SCRIPT_PUBKEY, 3))
      const psbt = parsePsbt(psbtBytes(undefined, map(entry(Uint8Array.of(PSBT_IN_WITNESS_UTXO), witnessUtxo))))
      expectNonCanonical(() => decodePsbt(psbt))
    })

    it('rejects a non-canonical item count in a final scriptwitness when extracting', () => {
      const item = fill(8, 0x33)
      const canonical = concat(compactSize(1), varBytes(item))
      const nonCanonical = concat(compactSize(1, 3), varBytes(item))
      const build = (witness: Uint8Array) =>
        parsePsbt(psbtBytes(undefined, map(entry(Uint8Array.of(PSBT_IN_FINAL_SCRIPTWITNESS), witness))))

      expect(extractP2mrTransaction(build(canonical))).toBeInstanceOf(Uint8Array)
      expectNonCanonical(() => extractP2mrTransaction(build(nonCanonical)))
      expectNonCanonical(() =>
        extractP2mrTransaction(build(concat(compactSize(1), varBytes(item, 5))))
      )
    })
  })

  describe('proprietary keys', () => {
    const rootEntry = (root: Uint8Array, identifierWidth?: CompactSizeWidth) =>
      entry(qbitProprietaryKey(PSBT_QBIT_IN_P2MR_MERKLE_ROOT, { identifierWidth }), root)

    it('accepts the canonical qbit merkle-root key', () => {
      const psbt = parsePsbt(psbtBytes(undefined, map(rootEntry(MERKLE_ROOT_A))))
      expect(bytesToHex(decodePsbt(psbt).inputs[0]!.merkleRoot!)).toBe(bytesToHex(MERKLE_ROOT_A))
    })

    it.each(WIDER_THAN_ONE_BYTE)('rejects a %i-byte identifier length inside a proprietary key', width => {
      expectNonCanonical(() => parsePsbt(psbtBytes(undefined, map(rootEntry(MERKLE_ROOT_A, width)))))
    })

    it('rejects a non-canonical proprietary key when decoding an in-memory PSBT', () => {
      const psbt = psbtObject(unsignedTx(), [
        { key: qbitProprietaryKey(PSBT_QBIT_IN_P2MR_MERKLE_ROOT, { identifierWidth: 3 }), value: MERKLE_ROOT_A },
      ])
      expectNonCanonical(() => decodePsbt(psbt))
    })

    it('cannot smuggle a second, conflicting merkle root under a differently encoded key', () => {
      // Raw-key comparison treats `fc 04 'qbit' 01` and `fc fd0400 'qbit' 01` as
      // distinct keys; rejecting the non-canonical form keeps one root per input.
      const input = map(rootEntry(MERKLE_ROOT_A), rootEntry(MERKLE_ROOT_B, 3))
      expectNonCanonical(() => parsePsbt(psbtBytes(undefined, input)))
    })

    it('rejects a truncated proprietary key at parse time', () => {
      const truncated = Uint8Array.of(PSBT_IN_PROPRIETARY, 0x04, 0x71, 0x62)
      expect(() => parsePsbt(psbtBytes(undefined, map(entry(truncated, MERKLE_ROOT_A))))).toThrow(
        /unexpected end of data/
      )
    })
  })

  describe('canonical boundaries and MAX_SIZE', () => {
    // Prefix the global map with the encoding under test. An accepted prefix is
    // consumed and the parser then runs out of data; a rejected one fails before
    // any length is applied.
    const parseWithKeyLength = (encoding: Uint8Array) => () => parsePsbt(concat(MAGIC, encoding))

    it.each([
      ['fd fc 00 (0xfc via fd)', Uint8Array.of(0xfd, 0xfc, 0x00)],
      ['fe ff ff 00 00 (0xffff via fe)', Uint8Array.of(0xfe, 0xff, 0xff, 0x00, 0x00)],
      ['ff ff ff ff ff 00 00 00 00 (0xffffffff via ff)', Uint8Array.of(0xff, 0xff, 0xff, 0xff, 0xff, 0, 0, 0, 0)],
    ])('rejects the largest non-canonical value for each prefix: %s', (_label, encoding) => {
      expectNonCanonical(parseWithKeyLength(encoding))
    })

    it.each([
      ['fd fd 00 (0xfd)', Uint8Array.of(0xfd, 0xfd, 0x00)],
      ['fe 00 00 01 00 (0x10000)', Uint8Array.of(0xfe, 0x00, 0x00, 0x01, 0x00)],
      ['fe 00 00 00 02 (MAX_SIZE)', Uint8Array.of(0xfe, 0x00, 0x00, 0x00, 0x02)],
    ])('accepts canonical values up to MAX_SIZE: %s', (_label, encoding) => {
      expect(parseWithKeyLength(encoding)).toThrow(/unexpected end of data/)
    })

    it.each([
      ['fe 01 00 00 02 (MAX_SIZE + 1)', Uint8Array.of(0xfe, 0x01, 0x00, 0x00, 0x02)],
      ['fe ff ff ff ff (0xffffffff)', Uint8Array.of(0xfe, 0xff, 0xff, 0xff, 0xff)],
      ['ff 00 00 00 00 01 00 00 00 (0x100000000)', Uint8Array.of(0xff, 0, 0, 0, 0, 0x01, 0, 0, 0)],
      [
        'ff ff ff ff ff ff ff 1f 00 (MAX_SAFE_INTEGER)',
        Uint8Array.of(0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x1f, 0x00),
      ],
      ['ff 00 00 00 00 00 00 20 00 (2^53)', Uint8Array.of(0xff, 0, 0, 0, 0, 0, 0, 0x20, 0)],
      ['ff ff ff ff ff ff ff ff ff (2^64 - 1)', fill(9, 0xff)],
    ])('rejects canonical values above MAX_SIZE as too large: %s', (_label, encoding) => {
      const parse = parseWithKeyLength(encoding)
      expect(parse).toThrow(QbitProtocolError)
      expect(parse).toThrow(/compact size too large/)
    })

    it('rejects an oversized unsigned transaction input count as too large, not as end of data', () => {
      const tx = unsignedTx({ inputCount: Uint8Array.of(0xfe, 0x01, 0x00, 0x00, 0x02) })
      expect(() => parsePsbt(psbtBytes(map(unsignedTxEntry(tx))))).toThrow(/compact size too large/)
    })

    it.each([0xfc, 0xfd, 0xffff, 0x10000])('round-trips canonical key and value lengths of %i', length => {
      const key = concat(Uint8Array.of(0x77), fill(length - 1, 0x4b))
      const value = fill(length, 0x56)
      const bytes = psbtBytes(undefined, map(entry(key, value)))

      const psbt = parsePsbt(bytes)
      const [field] = psbt.inputs[0]!
      expect(field!.key.length).toBe(length)
      expect(field!.value.length).toBe(length)
      expect(bytesToHex(serializePsbt(psbt))).toBe(bytesToHex(bytes))
    })
  })

  describe('key types (Core reads the type as a CompactSize)', () => {
    const rootKey = (typeWidth?: CompactSizeWidth) =>
      qbitProprietaryKey(PSBT_QBIT_IN_P2MR_MERKLE_ROOT, { typeWidth })

    it('rejects a proprietary key whose type is encoded as fd fc 00', () => {
      expectNonCanonical(() => parsePsbt(psbtBytes(undefined, map(entry(rootKey(3), MERKLE_ROOT_A)))))
    })

    it('cannot smuggle a second merkle root behind a non-canonical key type', () => {
      // Raw-key comparison sees two different keys; Core rejects the second one.
      const input = map(entry(rootKey(), MERKLE_ROOT_A), entry(rootKey(3), MERKLE_ROOT_B))
      expectNonCanonical(() => parsePsbt(psbtBytes(undefined, input)))
    })

    it.each([
      ['fd 00 00', Uint8Array.of(0xfd, 0x00, 0x00), /non-canonical compact size/],
      ['fe 01 00 00 00', Uint8Array.of(0xfe, 0x01, 0x00, 0x00, 0x00), /non-canonical compact size/],
      ['a lone ff', Uint8Array.of(0xff), /unexpected end of data/],
      ['fd', Uint8Array.of(0xfd), /unexpected end of data/],
      ['ff 00 00 00 00 01 00 00 00 (2^32)', Uint8Array.of(0xff, 0, 0, 0, 0, 0x01, 0, 0, 0), /compact size too large/],
    ])('rejects an unknown key with a malformed type: %s', (_label, key, message) => {
      const parse = () => parsePsbt(psbtBytes(undefined, map(entry(key, fill(4, 0x01)))))
      expect(parse).toThrow(QbitProtocolError)
      expect(parse).toThrow(message)
    })

    it('accepts a canonical multi-byte unknown key type and round-trips it', () => {
      const key = Uint8Array.of(0xfd, 0xfd, 0x00) // type 0xfd, canonical
      const bytes = psbtBytes(undefined, map(entry(key, fill(4, 0x01))))
      const psbt = parsePsbt(bytes)
      expect(bytesToHex(psbt.inputs[0]![0]!.key)).toBe(bytesToHex(key))
      expect(bytesToHex(serializePsbt(psbt))).toBe(bytesToHex(bytes))
      // decodePsbt treats it as an unknown field rather than mis-dispatching on key[0].
      expect(decodePsbt(psbt).inputs[0]!.merkleRoot).toBeUndefined()
    })

    it('decodePsbt dispatches on the CompactSize type for in-memory PSBTs', () => {
      const psbt = psbtObject(unsignedTx(), [
        { key: rootKey(), value: MERKLE_ROOT_A },
        { key: rootKey(3), value: MERKLE_ROOT_B },
      ])
      expectNonCanonical(() => decodePsbt(psbt))
    })
  })

  describe('qbit proprietary key data (validated at parse time like Core)', () => {
    const rootKeyWith = (keyData: Uint8Array) =>
      qbitProprietaryKey(PSBT_QBIT_IN_P2MR_MERKLE_ROOT, { keyData })

    it('rejects a merkle-root key with trailing key data (fc 04 qbit 01 00)', () => {
      const parse = () => parsePsbt(psbtBytes(undefined, map(entry(rootKeyWith(Uint8Array.of(0x00)), MERKLE_ROOT_A))))
      expect(parse).toThrow(QbitProtocolError)
      expect(parse).toThrow(/merkle root key data must be empty/)
    })

    it('rejects a leaf-script key whose control block has the wrong shape', () => {
      const key = qbitProprietaryKey(PSBT_QBIT_IN_P2MR_LEAF_SCRIPT, { keyData: fill(3, 0x01) })
      expect(() => parsePsbt(psbtBytes(undefined, map(entry(key, fill(4, 0x51)))))).toThrow(/control block/)
    })

    it('rejects a script-sig key whose key data is not pubkey32||leafhash32', () => {
      const key = qbitProprietaryKey(PSBT_QBIT_IN_P2MR_SCRIPT_SIG, { keyData: fill(63, 0x01) })
      expect(() => parsePsbt(psbtBytes(undefined, map(entry(key, fill(4, 0x51)))))).toThrow(
        /pubkey32\|\|leafhash32/
      )
    })

    it('leaves proprietary keys of other identifiers opaque', () => {
      const key = concat(
        Uint8Array.of(PSBT_IN_PROPRIETARY),
        varBytes(Uint8Array.of(0x6f, 0x74, 0x68, 0x72)), // 'othr'
        compactSize(PSBT_QBIT_IN_P2MR_MERKLE_ROOT),
        Uint8Array.of(0x00)
      )
      const bytes = psbtBytes(undefined, map(entry(key, fill(4, 0x01))))
      expect(bytesToHex(serializePsbt(parsePsbt(bytes)))).toBe(bytesToHex(bytes))
    })

    it('combinePsbts rejects a conflicting merkle root hidden behind trailing key data', () => {
      const a = psbtObject(unsignedTx(), [{ key: rootKeyWith(new Uint8Array()), value: MERKLE_ROOT_A }])
      const b = psbtObject(unsignedTx(), [{ key: rootKeyWith(Uint8Array.of(0x00)), value: MERKLE_ROOT_B }])
      expect(() => combinePsbts([a, b])).toThrow(/merkle root key data must be empty/)
      expect(() => combinePsbts([b, a])).toThrow(/merkle root key data must be empty/)

      // The same conflict under identical canonical keys is reported as a conflict.
      const c = psbtObject(unsignedTx(), [{ key: rootKeyWith(new Uint8Array()), value: MERKLE_ROOT_B }])
      expect(() => combinePsbts([a, c])).toThrow(/conflicting values/)
      expect(bytesToHex(decodePsbt(combinePsbts([a, a])).inputs[0]!.merkleRoot!)).toBe(bytesToHex(MERKLE_ROOT_A))
    })
  })

  describe('qbit proprietary keys outside input maps (Core stores them opaquely)', () => {
    // Core's `PSBTInput::Unserialize` is the only map deserializer that dispatches
    // on the `qbit` identifier and the PSBT_QBIT_IN_* subtypes. The global and
    // output maps (`PSBT_GLOBAL_PROPRIETARY` / `PSBT_OUT_PROPRIETARY`) keep every
    // `0xfc` record as an opaque PSBTProprietary, whatever its key data looks like.
    const keyWith = (subtype: number, keyData: Uint8Array) => qbitProprietaryKey(subtype, { keyData })
    const keysWithArbitraryKeyData: [string, Uint8Array][] = [
      ['subtype 0x01 with trailing key data', keyWith(PSBT_QBIT_IN_P2MR_MERKLE_ROOT, Uint8Array.of(0x00))],
      ['subtype 0x02 with a 3-byte key', keyWith(PSBT_QBIT_IN_P2MR_LEAF_SCRIPT, fill(3, 0x01))],
      ['subtype 0x03 with 63-byte key data', keyWith(PSBT_QBIT_IN_P2MR_SCRIPT_SIG, fill(63, 0x01))],
    ]
    const VALUE = fill(4, 0x01)

    it.each(keysWithArbitraryKeyData)('global map: %s parses, decodes and round-trips', (_, key) => {
      const bytes = psbtBytes(map(unsignedTxEntry(), entry(key, VALUE)))
      const psbt = parsePsbt(bytes)
      expect(psbt.global).toHaveLength(2)
      expect(() => decodePsbt(psbt)).not.toThrow()
      expect(bytesToHex(serializePsbt(psbt))).toBe(bytesToHex(bytes))
    })

    it.each(keysWithArbitraryKeyData)('output map: %s parses, decodes and round-trips', (_, key) => {
      const bytes = psbtBytes(undefined, undefined, map(entry(key, VALUE)))
      const psbt = parsePsbt(bytes)
      expect(psbt.outputs[0]).toHaveLength(1)
      expect(() => decodePsbt(psbt)).not.toThrow()
      expect(bytesToHex(serializePsbt(psbt))).toBe(bytesToHex(bytes))
    })

    it.each(keysWithArbitraryKeyData)('input map: %s is still rejected at parse time', (_, key) => {
      expect(() => parsePsbt(psbtBytes(undefined, map(entry(key, VALUE))))).toThrow(QbitProtocolError)
    })

    it('still rejects a malformed proprietary encoding in the global and output maps', () => {
      const nonCanonical = qbitProprietaryKey(PSBT_QBIT_IN_P2MR_MERKLE_ROOT, { identifierWidth: 3 })
      expectNonCanonical(() => parsePsbt(psbtBytes(map(unsignedTxEntry(), entry(nonCanonical, MERKLE_ROOT_A)))))
      expectNonCanonical(() => parsePsbt(psbtBytes(undefined, undefined, map(entry(nonCanonical, MERKLE_ROOT_A)))))

      const truncated = Uint8Array.of(PSBT_IN_PROPRIETARY, 0x04, 0x71, 0x62)
      expect(() => parsePsbt(psbtBytes(map(unsignedTxEntry(), entry(truncated, VALUE))))).toThrow(
        /unexpected end of data/
      )
      expect(() => parsePsbt(psbtBytes(undefined, undefined, map(entry(truncated, VALUE))))).toThrow(
        /unexpected end of data/
      )
    })

    it('combinePsbts merges such global and output records and shape-checks only input ones', () => {
      const key = qbitProprietaryKey(PSBT_QBIT_IN_P2MR_MERKLE_ROOT, { keyData: Uint8Array.of(0x00) })
      const withGlobalAndOutput = (value: Uint8Array): Psbt => ({
        global: [{ key: Uint8Array.of(PSBT_GLOBAL_UNSIGNED_TX), value: unsignedTx() }, { key, value }],
        inputs: [[]],
        outputs: [[{ key, value }]],
      })
      const combined = combinePsbts([withGlobalAndOutput(MERKLE_ROOT_A), withGlobalAndOutput(MERKLE_ROOT_A)])
      expect(combined.global).toHaveLength(2)
      expect(combined.outputs[0]).toHaveLength(1)
      expect(() => combinePsbts([withGlobalAndOutput(MERKLE_ROOT_A), withGlobalAndOutput(MERKLE_ROOT_B)])).toThrow(
        /conflicting values/
      )
      expect(() => combinePsbts([psbtObject(unsignedTx(), [{ key, value: MERKLE_ROOT_A }])])).toThrow(
        /merkle root key data must be empty/
      )
    })
  })
})

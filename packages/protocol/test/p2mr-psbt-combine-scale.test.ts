import { describe, expect, it } from 'vitest'

import fixture from '../fixtures/p2mr-psbt.json'
import { QbitProtocolError, bytesToHex, combinePsbts, hexToBytes, parsePsbt, serializePsbt } from '../src/index'
import type { Psbt, PsbtKeyValue } from '../src/index'

const PSBT_BYTES = hexToBytes(fixture.psbtHex)
// 0xf0 is not a key type qbit Core decodes, so these land in its `unknown` map.
const UNKNOWN_KEY_TYPE = 0xf0
const SCALE_ENTRIES = 100_000
const SCALE_TIMEOUT_MS = 5_000

function unknownEntry(index: number, value: Uint8Array = Uint8Array.of(index & 0xff)): PsbtKeyValue {
  const key = new Uint8Array(5)
  key[0] = UNKNOWN_KEY_TYPE
  new DataView(key.buffer).setUint32(1, index, false)
  return { key, value }
}

/** The fixture with `count` distinct unknown keys appended to input 0, as a hostile co-signer could send. */
function withUnknownEntries(count: number): Psbt {
  const psbt = parsePsbt(PSBT_BYTES)
  const input0 = psbt.inputs[0]!
  for (let i = 0; i < count; i += 1) input0.push(unknownEntry(i))
  return psbt
}

function keysOf(map: readonly PsbtKeyValue[]): string[] {
  return map.map(entry => bytesToHex(entry.key))
}

describe('combinePsbts on large maps', () => {
  it(
    `merges ${SCALE_ENTRIES} unknown keys in one input map well inside ${SCALE_TIMEOUT_MS} ms`,
    () => {
      const honest = parsePsbt(PSBT_BYTES)
      const hostile = withUnknownEntries(SCALE_ENTRIES)
      const honestInput0 = keysOf(honest.inputs[0]!)

      // Before the key index, every source entry scanned the whole target map: ~50 s here.
      // A synchronous test cannot be interrupted by the vitest timeout, so the
      // elapsed time is asserted as well.
      const start = performance.now()
      const combined = combinePsbts([honest, hostile])
      const elapsed = performance.now() - start
      expect(elapsed).toBeLessThan(SCALE_TIMEOUT_MS)

      const input0 = combined.inputs[0]!
      expect(input0.length).toBe(honestInput0.length + SCALE_ENTRIES)
      // First-seen order: the honest PSBT's entries, then the new keys in the order the hostile one carried them.
      expect(keysOf(input0.slice(0, honestInput0.length))).toEqual(honestInput0)
      expect(bytesToHex(input0[honestInput0.length]!.key)).toBe(bytesToHex(unknownEntry(0).key))
      expect(bytesToHex(input0[input0.length - 1]!.key)).toBe(bytesToHex(unknownEntry(SCALE_ENTRIES - 1).key))
      expect(new Set(keysOf(input0)).size).toBe(input0.length)
      // Every other map is the honest one unchanged.
      expect(combined.global).toEqual(honest.global)
      expect(combined.inputs.slice(1)).toEqual(honest.inputs.slice(1))
      expect(combined.outputs).toEqual(honest.outputs)
    },
    SCALE_TIMEOUT_MS,
  )

  it(
    `still rejects a conflicting value among ${SCALE_ENTRIES} keys`,
    () => {
      const hostile = withUnknownEntries(SCALE_ENTRIES)
      const conflicting = withUnknownEntries(SCALE_ENTRIES)
      const last = conflicting.inputs[0]![conflicting.inputs[0]!.length - 1]!
      last.value = Uint8Array.of(last.value[0]! ^ 0xff)

      const start = performance.now()
      let thrown: unknown
      try {
        combinePsbts([hostile, conflicting])
      } catch (error) {
        thrown = error
      }
      expect(performance.now() - start).toBeLessThan(SCALE_TIMEOUT_MS)
      expect(thrown).toBeInstanceOf(QbitProtocolError)
      expect((thrown as QbitProtocolError).code).toBe('INVALID_PSBT')
      expect((thrown as QbitProtocolError).message).toBe('conflicting values for the same PSBT key')
    },
    SCALE_TIMEOUT_MS,
  )
})

describe('combinePsbts merge semantics (regression guard)', () => {
  it('rejects a conflicting value for an unknown key', () => {
    const a = parsePsbt(PSBT_BYTES)
    const b = parsePsbt(PSBT_BYTES)
    a.inputs[0]!.push(unknownEntry(7, Uint8Array.of(1)))
    b.inputs[0]!.push(unknownEntry(7, Uint8Array.of(2)))
    expect(() => combinePsbts([a, b])).toThrow(new QbitProtocolError('INVALID_PSBT', 'conflicting values for the same PSBT key'))
  })

  it('dedupes identical entries across PSBTs and within one PSBT', () => {
    const base = parsePsbt(PSBT_BYTES)
    const b = parsePsbt(PSBT_BYTES)
    const c = parsePsbt(PSBT_BYTES)
    b.outputs[0]!.push(unknownEntry(1), unknownEntry(2))
    // `c` repeats a key `b` added, and carries its own key twice. Only `parsePsbt`
    // rejects duplicate keys; a hand-built Psbt can still hold them.
    c.outputs[0]!.push(unknownEntry(2), unknownEntry(3), unknownEntry(3))

    const combined = combinePsbts([base, b, c])
    expect(keysOf(combined.outputs[0]!)).toEqual([
      ...keysOf(base.outputs[0]!),
      bytesToHex(unknownEntry(1).key),
      bytesToHex(unknownEntry(2).key),
      bytesToHex(unknownEntry(3).key),
    ])
    expect(bytesToHex(serializePsbt(combinePsbts([base, parsePsbt(PSBT_BYTES)])))).toBe(fixture.psbtHex)
  })

  it('keeps first-seen order: base entries first, then each later PSBT in its own order', () => {
    const base = parsePsbt(PSBT_BYTES)
    const b = parsePsbt(PSBT_BYTES)
    const c = parsePsbt(PSBT_BYTES)
    // Later PSBTs list their extra keys in descending order; they must not be sorted.
    b.global.unshift(unknownEntry(9), unknownEntry(5))
    c.global.push(unknownEntry(8), unknownEntry(5), unknownEntry(1))

    const combined = combinePsbts([base, b, c])
    expect(keysOf(combined.global)).toEqual([
      ...keysOf(base.global),
      bytesToHex(unknownEntry(9).key),
      bytesToHex(unknownEntry(5).key),
      bytesToHex(unknownEntry(8).key),
      bytesToHex(unknownEntry(1).key),
    ])
  })

  it('compares a later duplicate against the first copy of a repeated base key', () => {
    // A hand-built base map holding the same key twice with different values:
    // the merge compares against the first copy, as the linear scan did.
    const base = parsePsbt(PSBT_BYTES)
    base.inputs[1]!.push(unknownEntry(4, Uint8Array.of(1)), unknownEntry(4, Uint8Array.of(2)))
    const matchesFirst = parsePsbt(PSBT_BYTES)
    matchesFirst.inputs[1]!.push(unknownEntry(4, Uint8Array.of(1)))
    const matchesSecond = parsePsbt(PSBT_BYTES)
    matchesSecond.inputs[1]!.push(unknownEntry(4, Uint8Array.of(2)))

    expect(combinePsbts([base, matchesFirst]).inputs[1]!.length).toBe(base.inputs[1]!.length)
    expect(() => combinePsbts([base, matchesSecond])).toThrow(/conflicting values for the same PSBT key/)
  })

  it('does not alias the source PSBTs', () => {
    const base = parsePsbt(PSBT_BYTES)
    const b = parsePsbt(PSBT_BYTES)
    b.inputs[0]!.push(unknownEntry(6, Uint8Array.of(6)))
    const combined = combinePsbts([base, b])
    const added = combined.inputs[0]![combined.inputs[0]!.length - 1]!
    added.value[0] = 0x99
    expect(b.inputs[0]![b.inputs[0]!.length - 1]!.value[0]).toBe(6)
    expect(base.inputs[0]!.length).toBe(parsePsbt(PSBT_BYTES).inputs[0]!.length)
  })
})

describe('combinePsbts with many PSBTs', () => {
  const LATER_PSBTS = 1_000
  it(
    `merges ${SCALE_ENTRIES} new keys spread over ${LATER_PSBTS} later PSBTs well inside ${SCALE_TIMEOUT_MS} ms`,
    () => {
      // Rebuilding a merge index for every later PSBT would cost O(PSBT count x map size).
      const perPsbt = SCALE_ENTRIES / LATER_PSBTS
      const later = Array.from({ length: LATER_PSBTS }, (_, k) => {
        const psbt = parsePsbt(PSBT_BYTES)
        for (let i = 0; i < perPsbt; i += 1) psbt.inputs[0]!.push(unknownEntry(k * perPsbt + i))
        return psbt
      })
      const honest = parsePsbt(PSBT_BYTES)
      const start = performance.now()
      const combined = combinePsbts([honest, ...later])
      expect(performance.now() - start).toBeLessThan(SCALE_TIMEOUT_MS)
      expect(combined.inputs[0]!.length).toBe(honest.inputs[0]!.length + SCALE_ENTRIES)
      expect(bytesToHex(combined.inputs[0]![combined.inputs[0]!.length - 1]!.key)).toBe(bytesToHex(unknownEntry(SCALE_ENTRIES - 1).key))
    },
    SCALE_TIMEOUT_MS,
  )
})

describe('combinePsbts with long keys', () => {
  // V8 hashes a string longer than 16,383 characters by its length alone, so a
  // hex index over equal-length 8 KiB keys collapses into one bucket.
  const LONG_KEY_BYTES = 8_192
  const LONG_KEYS_PER_PSBT = 1_500

  function longKey(index: number): Uint8Array {
    const key = new Uint8Array(LONG_KEY_BYTES)
    key[0] = UNKNOWN_KEY_TYPE
    // Differ only at the end, so comparing two keys reads all of both.
    new DataView(key.buffer).setUint32(LONG_KEY_BYTES - 4, index, false)
    return key
  }

  function withLongKeys(offset: number): Psbt {
    const psbt = parsePsbt(PSBT_BYTES)
    for (let i = 0; i < LONG_KEYS_PER_PSBT; i += 1) {
      psbt.inputs[0]!.push({ key: longKey(offset + i), value: Uint8Array.of(1) })
    }
    return psbt
  }

  it(
    `merges ${LONG_KEYS_PER_PSBT * 2} distinct ${LONG_KEY_BYTES}-byte keys well inside ${SCALE_TIMEOUT_MS} ms, in either order`,
    () => {
      const honest = parsePsbt(PSBT_BYTES)
      const hostileA = withLongKeys(0)
      const hostileB = withLongKeys(LONG_KEYS_PER_PSBT)
      // With a hex index this took about 14 s; hostile-first also paid for indexing.
      for (const order of [
        [honest, hostileA, hostileB],
        [hostileA, hostileB, honest],
      ]) {
        const start = performance.now()
        const combined = combinePsbts(order)
        expect(performance.now() - start).toBeLessThan(SCALE_TIMEOUT_MS)
        expect(combined.inputs[0]!.length).toBe(honest.inputs[0]!.length + LONG_KEYS_PER_PSBT * 2)
      }
      // A conflicting value for an existing long key is still caught.
      const conflicting = parsePsbt(PSBT_BYTES)
      conflicting.inputs[0]!.push({ key: longKey(7), value: Uint8Array.of(2) })
      expect(() => combinePsbts([hostileA, conflicting])).toThrow(QbitProtocolError)
    },
    SCALE_TIMEOUT_MS * 3,
  )
})

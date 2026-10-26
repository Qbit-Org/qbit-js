import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import ts from 'typescript'
import { describe, expect, it } from 'vitest'

import fixture from '../fixtures/p2mr-psbt.json'
import {
  P2MR_LEAF_VERSION_V1,
  PQC_SIGNATURE_BYTES,
  PSBT_DEFAULT_MAX_BYTES,
  PSBT_DEFAULT_MAX_OBJECTS,
  PSBT_IN_FINAL_SCRIPTWITNESS,
  QbitProtocolError,
  SIGHASH_ALL,
  buildControlBlock,
  bytesToHex,
  createP2mrPsbt,
  decodePsbt,
  extractP2mrTransaction,
  finalizeP2mrPsbt,
  hexToBytes,
  p2mrLeafHash,
  p2mrScriptPubKey,
  parsePsbt,
  psbtUnsignedTransaction,
  serializePsbt,
  signP2mrPsbt,
  singleKeyLeafScript,
  type Psbt,
} from '../src/index'

// Regression tests: small untrusted PSBTs must not be able to make the
// parser, finalizer or extractor allocate without bound.

const PSBT_MAGIC = Uint8Array.of(0x70, 0x73, 0x62, 0x74, 0xff)
const P2MR_MAX_FINAL_WITNESS_ITEMS = 1003
const P2MR_V1_MAX_STACK_ITEM_BYTES = 16 * 1024
const P2MR_V1_MAX_STACK_BYTES = 128 * 1024
const OBJECTS_AT_DEFAULT = PSBT_DEFAULT_MAX_OBJECTS

function concat(chunks: readonly Uint8Array[]): Uint8Array {
  const out = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.length, 0))
  let offset = 0
  for (const chunk of chunks) {
    out.set(chunk, offset)
    offset += chunk.length
  }
  return out
}

function compactSize(value: number): Uint8Array {
  if (value < 0xfd) return Uint8Array.of(value)
  if (value <= 0xffff) return Uint8Array.of(0xfd, value & 0xff, value >> 8)
  return Uint8Array.of(0xfe, value & 0xff, (value >> 8) & 0xff, (value >> 16) & 0xff, value >>> 24)
}

function varBytes(bytes: Uint8Array): Uint8Array {
  return concat([compactSize(bytes.length), bytes])
}

/** A serialized witness stack: item count, then each item with its length. */
function witness(items: readonly Uint8Array[]): Uint8Array {
  return concat([compactSize(items.length), ...items.map(varBytes)])
}

/** `fe <n> || n×00`: n empty witness items, the first probe below. */
function emptyItemsWitness(n: number): Uint8Array {
  return concat([compactSize(n), new Uint8Array(n)])
}

/** A raw unsigned transaction with `inputs` inputs and `outputs` empty-script outputs. */
function rawUnsignedTx(inputs: number, outputs: number): Uint8Array {
  const parts: Uint8Array[] = [Uint8Array.of(2, 0, 0, 0), compactSize(inputs)]
  const input = new Uint8Array(41)
  input.fill(0xff, 37) // empty scriptSig, sequence 0xffffffff
  for (let i = 0; i < inputs; i += 1) parts.push(input)
  parts.push(compactSize(outputs), new Uint8Array(outputs * 9), new Uint8Array(4))
  return concat(parts)
}

function expectInvalidPsbt(run: () => unknown, message: RegExp): void {
  let caught: unknown
  try {
    run()
  } catch (error) {
    caught = error
  }
  expect(caught).toBeInstanceOf(QbitProtocolError)
  expect((caught as QbitProtocolError).code).toBe('INVALID_PSBT')
  expect((caught as Error).message).toMatch(message)
}

function elapsedMs(run: () => void): number {
  const start = performance.now()
  run()
  return performance.now() - start
}

const pubkey = Uint8Array.from({ length: 32 }, (_, i) => (i * 7 + 1) & 0xff)
const leafScript = singleKeyLeafScript(pubkey)
const leafHash = p2mrLeafHash(P2MR_LEAF_VERSION_V1, leafScript)
const controlBlock = buildControlBlock(P2MR_LEAF_VERSION_V1, [])
const scriptPubKey = p2mrScriptPubKey(leafHash)

function unsignedP2mrPsbt(inputCount: number): Psbt {
  return createP2mrPsbt({
    inputs: Array.from({ length: inputCount }, (_, i) => ({
      prevout: { txid: new Uint8Array(32).fill(i & 0xff).fill(i >> 8, 0, 1), vout: i },
      witnessUtxo: { value: 100_000n, scriptPubKey },
      leafScript,
      controlBlock,
    })),
    outputs: [{ value: 90_000n * BigInt(inputCount), scriptPubKey }],
  })
}

/** An in-memory PSBT whose inputs carry the given final scriptwitness values. */
function finalizedPsbt(finalWitnesses: readonly Uint8Array[]): Psbt {
  const psbt = unsignedP2mrPsbt(finalWitnesses.length)
  psbt.inputs = finalWitnesses.map((value, index) => [
    psbt.inputs[index]![0]!,
    { key: Uint8Array.of(PSBT_IN_FINAL_SCRIPTWITNESS), value },
  ])
  return psbt
}

/** A single-key P2MR spend witness whose stack holds `stack` before the script and control block. */
function p2mrWitness(stack: readonly Uint8Array[], control = controlBlock): Uint8Array {
  return witness([...stack, leafScript, control])
}

describe('final scriptwitness bounds', () => {
  it('rejects fe <n> || n×00 with n = 1.5M quickly instead of exhausting the heap', () => {
    const hostile = emptyItemsWitness(1_500_000)
    const bytes = serializePsbt(finalizedPsbt([hostile]))
    // parsePsbt does not decode 0x08 yet, so the probe gets through parsing ...
    const psbt = parsePsbt(bytes)
    // ... and is stopped before any item is allocated.
    const ms = elapsedMs(() => {
      expectInvalidPsbt(() => extractP2mrTransaction(psbt), /final scriptwitness has more than 1003 items/)
      expectInvalidPsbt(() => finalizeP2mrPsbt(psbt), /final scriptwitness has more than 1003 items/)
    })
    expect(ms).toBeLessThan(2000)
  })

  it('applies the same bound to in-memory PSBTs built without parsePsbt', () => {
    const psbt = finalizedPsbt([emptyItemsWitness(1_500_000)])
    expectInvalidPsbt(() => extractP2mrTransaction(psbt), /more than 1003 items/)
    expectInvalidPsbt(() => finalizeP2mrPsbt(psbt), /more than 1003 items/)
  })

  it('rejects an item count larger than the bytes that follow before looping', () => {
    const truncated = concat([compactSize(1000), new Uint8Array(10)])
    expectInvalidPsbt(() => extractP2mrTransaction(finalizedPsbt([truncated])), /item count exceeds the remaining data/)
  })

  it('accepts the most items a valid P2MR witness has: 1000 stack items, script, control block and annex', () => {
    const stack = Array.from({ length: 1000 }, () => new Uint8Array())
    const annex = Uint8Array.of(0x50)
    const value = witness([...stack, leafScript, controlBlock, annex])
    expect(P2MR_MAX_FINAL_WITNESS_ITEMS).toBe(1003)
    expect(() => extractP2mrTransaction(finalizedPsbt([value]))).not.toThrow()

    const tooMany = witness([...stack, new Uint8Array(), leafScript, controlBlock, annex])
    expectInvalidPsbt(() => extractP2mrTransaction(finalizedPsbt([tooMany])), /more than 1003 items/)
  })

  it("enforces Core's P2MR v1 stack item count, item size and total size limits", () => {
    const empties = (n: number) => Array.from({ length: n }, () => new Uint8Array())
    const accept = (value: Uint8Array) => expect(() => extractP2mrTransaction(finalizedPsbt([value]))).not.toThrow()
    const reject = (value: Uint8Array, message: RegExp) => {
      expectInvalidPsbt(() => extractP2mrTransaction(finalizedPsbt([value])), message)
      expectInvalidPsbt(() => finalizeP2mrPsbt(finalizedPsbt([value])), message)
    }

    accept(p2mrWitness(empties(1000)))
    reject(p2mrWitness(empties(1001)), /more than 1000 stack items/)

    accept(p2mrWitness([new Uint8Array(P2MR_V1_MAX_STACK_ITEM_BYTES)]))
    reject(p2mrWitness([new Uint8Array(P2MR_V1_MAX_STACK_ITEM_BYTES + 1)]), /item exceeds 16384 bytes/)

    const fullStack = Array.from({ length: 8 }, () => new Uint8Array(P2MR_V1_MAX_STACK_ITEM_BYTES))
    expect(fullStack.reduce((sum, item) => sum + item.length, 0)).toBe(P2MR_V1_MAX_STACK_BYTES)
    accept(p2mrWitness(fullStack))
    reject(p2mrWitness([...fullStack, Uint8Array.of(1)]), /stack exceeds 131072 bytes/)

    // Core skips the v1 limits for other leaf versions; so do we.
    const reservedLeafControl = Uint8Array.of(0xc3)
    accept(p2mrWitness([new Uint8Array(P2MR_V1_MAX_STACK_ITEM_BYTES + 1)], reservedLeafControl))
  })

  it("rejects a final witness that lacks its item count (the P2MR PSBT fixture's old shape) with QbitProtocolError", () => {
    // ser_string(sig) || ser_string(script) || ser_string(control) with no leading count:
    // the first bytes (fd600e) read as 3680 items.
    const sig = new Uint8Array(3680).map((_, i) => i & 0xff)
    const uncounted = concat([
      compactSize(sig.length),
      sig,
      compactSize(leafScript.length),
      leafScript,
      compactSize(controlBlock.length),
      controlBlock,
    ])
    const psbt = finalizedPsbt([uncounted])
    expectInvalidPsbt(() => extractP2mrTransaction(psbt), /final scriptwitness/)
    expectInvalidPsbt(() => finalizeP2mrPsbt(psbt), /final scriptwitness/)
  })

  it.todo('parsePsbt decodes and bounds 0x08 final scriptwitness values at parse time, as qbit Core does')
})

describe('PSBT map and transaction bounds', () => {
  /** magic, a global map holding `tx`, one input map of `body` entries, one empty output map. */
  function psbtWithInputMap(body: Uint8Array): Uint8Array {
    const tx = rawUnsignedTx(1, 1)
    const global = concat([varBytes(Uint8Array.of(0x00)), varBytes(tx), Uint8Array.of(0)])
    return concat([PSBT_MAGIC, global, body, Uint8Array.of(0), Uint8Array.of(0)])
  }

  /** `count` distinct unknown entries: 4-byte key 0x77 || index, empty value (6 bytes each). */
  function tinyUnknownEntries(count: number): Uint8Array {
    const body = new Uint8Array(count * 6)
    for (let i = 0; i < count; i += 1) {
      body.set([4, 0x77, (i >> 16) & 0xff, (i >> 8) & 0xff, i & 0xff, 0], i * 6)
    }
    return body
  }

  it('rejects a 10 MB map of tiny unknown keys quickly at the object cap', () => {
    const bytes = psbtWithInputMap(tinyUnknownEntries(1_700_000))
    expect(bytes.length).toBeGreaterThan(10_000_000)
    expect(bytes.length).toBeLessThan(PSBT_DEFAULT_MAX_BYTES)
    const ms = elapsedMs(() => {
      expectInvalidPsbt(() => parsePsbt(bytes), new RegExp(`more than ${OBJECTS_AT_DEFAULT} map entries.*raise maxObjects`))
    })
    expect(ms).toBeLessThan(2000)
  })

  it('accepts many tiny entries under the cap, and more when maxObjects is raised', () => {
    const under = psbtWithInputMap(tinyUnknownEntries(OBJECTS_AT_DEFAULT - 10))
    expect(parsePsbt(under).inputs[0]).toHaveLength(OBJECTS_AT_DEFAULT - 10)

    const over = psbtWithInputMap(tinyUnknownEntries(OBJECTS_AT_DEFAULT + 1))
    expectInvalidPsbt(() => parsePsbt(over), /raise maxObjects/)
    // The object cap does not scale with maxBytes.
    expectInvalidPsbt(() => parsePsbt(over, { maxBytes: 2 * PSBT_DEFAULT_MAX_BYTES }), /raise maxObjects/)
    expect(parsePsbt(over, { maxObjects: 2 * OBJECTS_AT_DEFAULT }).inputs[0]).toHaveLength(OBJECTS_AT_DEFAULT + 1)
  })

  it('counts every map entry, input and output against maxObjects exactly', () => {
    // A global tx entry, one input, one output and three unknown input-map entries: six objects.
    const bytes = psbtWithInputMap(tinyUnknownEntries(3))
    expect(parsePsbt(bytes, { maxObjects: 6 }).inputs[0]).toHaveLength(3)
    expectInvalidPsbt(() => parsePsbt(bytes, { maxObjects: 5 }), /more than 5 map entries/)
  })

  it('keeps rejecting duplicate keys', () => {
    const entry = concat([varBytes(Uint8Array.of(0x77)), varBytes(new Uint8Array())])
    expectInvalidPsbt(() => parsePsbt(psbtWithInputMap(concat([entry, entry]))), /duplicate key/)
  })

  /** An 8 KiB unknown key that differs from the others only in its last 4 bytes. */
  function longKeyEntry(index: number): Uint8Array {
    const key = new Uint8Array(8192).fill(0xab)
    key[0] = 0x77
    new DataView(key.buffer).setUint32(key.length - 4, index)
    return concat([varBytes(key), varBytes(new Uint8Array())])
  }

  it('checks 2,000 distinct 8 KiB keys for duplicates in linear time', () => {
    // V8 hashes a string longer than 16,383 characters by its length alone, so
    // hex ids of these keys all shared one Set bucket: about 4 s here before.
    const bytes = psbtWithInputMap(concat(Array.from({ length: 2000 }, (_, i) => longKeyEntry(i))))
    expect(bytes.length).toBeGreaterThan(16_000_000)
    let psbt: Psbt | undefined
    const ms = elapsedMs(() => {
      psbt = parsePsbt(bytes)
    })
    expect(psbt!.inputs[0]).toHaveLength(2000)
    expect(ms).toBeLessThan(2000)

    // Long keys are compared by SHA-256, and a repeated one is still a duplicate.
    const repeated = concat([longKeyEntry(0), longKeyEntry(1), longKeyEntry(0)])
    expectInvalidPsbt(() => parsePsbt(psbtWithInputMap(repeated)), /duplicate key/)
  })

  it('rejects input and output counts larger than the transaction data before looping', () => {
    const huge = (count: Uint8Array, outputs: boolean) => {
      // version, then either the count or one minimal input followed by the count
      const tx = outputs
        ? concat([Uint8Array.of(2, 0, 0, 0, 1), new Uint8Array(32 + 4 + 1 + 4), count])
        : concat([Uint8Array.of(2, 0, 0, 0), count])
      return { global: [{ key: Uint8Array.of(0x00), value: tx }], inputs: [], outputs: [] } as Psbt
    }
    // MAX_SIZE (0x02000000), the largest count a canonical CompactSize may carry.
    const max = Uint8Array.of(0xfe, 0x00, 0x00, 0x00, 0x02)
    const ms = elapsedMs(() => {
      expectInvalidPsbt(() => psbtUnsignedTransaction(huge(max, false)), /input count exceeds the remaining data/)
      expectInvalidPsbt(() => psbtUnsignedTransaction(huge(max, true)), /output count exceeds the remaining data/)
      expectInvalidPsbt(() => parsePsbt(serializePsbt(huge(max, true))), /output count exceeds the remaining data/)
    })
    expect(ms).toBeLessThan(2000)
  })

  it('counts unsigned-transaction outputs against the object cap', () => {
    const tx = rawUnsignedTx(1, OBJECTS_AT_DEFAULT)
    // global map terminator, one empty input map, then one empty map per output
    const maps = new Uint8Array(1 + 1 + OBJECTS_AT_DEFAULT)
    const bytes = concat([PSBT_MAGIC, varBytes(Uint8Array.of(0x00)), varBytes(tx), maps])
    expectInvalidPsbt(() => parsePsbt(bytes), /raise maxObjects/)
    expect(parsePsbt(bytes, { maxObjects: 2 * OBJECTS_AT_DEFAULT }).outputs).toHaveLength(OBJECTS_AT_DEFAULT)
  })

  it('counts final witness items across inputs against the object cap in extractP2mrTransaction', () => {
    // 131 inputs × 1003 empty items stays structurally valid per witness but exceeds 131,072 items in total.
    const inputs = Math.ceil(OBJECTS_AT_DEFAULT / P2MR_MAX_FINAL_WITNESS_ITEMS)
    const psbt = finalizedPsbt(Array.from({ length: inputs }, () => emptyItemsWitness(P2MR_MAX_FINAL_WITNESS_ITEMS)))
    expectInvalidPsbt(() => extractP2mrTransaction(psbt), /raise maxObjects/)
    expect(() => extractP2mrTransaction(psbt, { maxObjects: 2 * OBJECTS_AT_DEFAULT })).not.toThrow()
  })
})

describe('maxBytes', () => {
  const fixtureBytes = hexToBytes(fixture.psbtHex)

  it('rejects input over maxBytes before parsing it', () => {
    // Not even a PSBT: the size check runs first.
    expectInvalidPsbt(() => parsePsbt(new Uint8Array(PSBT_DEFAULT_MAX_BYTES + 1)), /larger than maxBytes \(16777216\)/)
    expectInvalidPsbt(() => parsePsbt(fixtureBytes, { maxBytes: fixtureBytes.length - 1 }), /larger than maxBytes/)
    expect(bytesToHex(serializePsbt(parsePsbt(fixtureBytes, { maxBytes: fixtureBytes.length })))).toBe(fixture.psbtHex)
  })

  it('bounds the transaction extractP2mrTransaction builds', () => {
    const psbt = finalizedPsbt([p2mrWitness([new Uint8Array(PQC_SIGNATURE_BYTES)])])
    const size = extractP2mrTransaction(psbt).length
    expect(extractP2mrTransaction(psbt, { maxBytes: size })).toHaveLength(size)
    expectInvalidPsbt(() => extractP2mrTransaction(psbt, { maxBytes: size - 1 }), /larger than maxBytes/)
  })

  it('rejects a maxBytes or maxObjects that is not a positive safe integer', () => {
    const invalid = [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, null as unknown as number]
    for (const limit of invalid) {
      for (const options of [{ maxBytes: limit }, { maxObjects: limit }]) {
        expect(() => parsePsbt(fixtureBytes, options)).toThrow(RangeError)
        expect(() => extractP2mrTransaction(parsePsbt(fixtureBytes), options)).toThrow(RangeError)
      }
    }
  })

  it('accepts a minimal PSBT with maxBytes equal to its size, however small', () => {
    // 71 bytes: the old maxBytes / 128 object budget was 0 here.
    const tx = rawUnsignedTx(1, 1)
    const bytes = concat([PSBT_MAGIC, varBytes(Uint8Array.of(0x00)), varBytes(tx), Uint8Array.of(0, 0, 0)])
    expect(bytes.length).toBe(71)
    expect(parsePsbt(bytes, { maxBytes: bytes.length }).global).toHaveLength(1)
    expectInvalidPsbt(() => parsePsbt(bytes, { maxBytes: bytes.length - 1 }), /larger than maxBytes/)
  })
})

describe('valid PSBTs stay accepted', () => {
  it('parses, round-trips and decodes the existing fixture under the default limits', () => {
    const psbt = parsePsbt(hexToBytes(fixture.psbtHex))
    expect(bytesToHex(serializePsbt(psbt))).toBe(fixture.psbtHex)
    expect(decodePsbt(psbt).fee).toBe(BigInt(fixture.expected.fee))
  })

  it("signs, finalizes and extracts the fixture's unsigned transaction shape", () => {
    const uv = fixture.unsignedTx
    const psbt = createP2mrPsbt({
      version: uv.version,
      locktime: uv.locktime,
      inputs: uv.inputs.map(input => ({
        prevout: { txid: hexToBytes(input.txid), vout: input.vout },
        sequence: input.sequence,
        witnessUtxo: { value: 100_000n, scriptPubKey },
        leafScript,
        controlBlock,
      })),
      outputs: uv.outputs.map(output => ({
        value: BigInt(output.valueSats),
        scriptPubKey: hexToBytes(output.scriptPubKey),
      })),
    })
    const { psbt: signed } = signP2mrPsbt({
      psbt: parsePsbt(serializePsbt(psbt)),
      keys: uv.inputs.map((_, inputIndex) => ({ inputIndex, pubkey, leafHash })),
      sign: () => new Uint8Array(PQC_SIGNATURE_BYTES).fill(7),
    })
    const finalized = parsePsbt(serializePsbt(finalizeP2mrPsbt(signed)))
    const rawTx = extractP2mrTransaction(finalized)
    expect(bytesToHex(rawTx).startsWith('020000000001')).toBe(true)
    expect(bytesToHex(rawTx)).toContain(uv.hex.slice(10, 10 + 64)) // first prevout txid
  })

  /** `inputCount` single-key P2MR inputs, each signed with a 3680-byte signature + SIGHASH_ALL byte. */
  function signedPsbt(inputCount: number): Psbt {
    return signP2mrPsbt({
      psbt: unsignedP2mrPsbt(inputCount),
      keys: Array.from({ length: inputCount }, (_, inputIndex) => ({
        inputIndex,
        pubkey,
        leafHash,
        hashType: SIGHASH_ALL,
      })),
      sign: () => new Uint8Array(PQC_SIGNATURE_BYTES).fill(0x5a),
      allowNonDefaultSighash: true,
    }).psbt
  }

  it('accepts 120 P2MR inputs with real-size 3681-byte signatures through parse, finalize and extract', () => {
    const signedBytes = serializePsbt(signedPsbt(120))
    expect(signedBytes.length).toBeGreaterThan(120 * (PQC_SIGNATURE_BYTES + 1))
    const reparsed = parsePsbt(signedBytes)
    for (const input of decodePsbt(reparsed).inputs) {
      expect(input.scriptSigs[0]!.signature.signature).toHaveLength(PQC_SIGNATURE_BYTES)
      expect(input.scriptSigs[0]!.signature.hashType).toBe(SIGHASH_ALL)
    }

    const finalized = parsePsbt(serializePsbt(finalizeP2mrPsbt(reparsed)))
    const rawTx = extractP2mrTransaction(finalized)
    expect(rawTx.length).toBeGreaterThan(120 * (PQC_SIGNATURE_BYTES + 1))
  })

  it('accepts a 9,000-output batch payout at its natural size and with maxBytes equal to its length', () => {
    // One single-key P2MR input paying 9,000 P2MR outputs: a standard 390,777-byte transaction at
    // about 44 bytes per decoded object, which the old maxBytes / 128 object budget rejected.
    const outputs = 9000
    const unsigned = createP2mrPsbt({
      inputs: [
        {
          prevout: { txid: new Uint8Array(32).fill(1), vout: 0 },
          witnessUtxo: { value: 10n ** 12n, scriptPubKey },
          leafScript,
          controlBlock,
        },
      ],
      outputs: Array.from({ length: outputs }, () => ({ value: 1000n, scriptPubKey })),
    })
    const unsignedBytes = serializePsbt(unsigned)
    expect(unsignedBytes.length).toBe(396_152)
    for (const maxBytes of [400_000, 1024 * 1024, unsignedBytes.length]) {
      expect(parsePsbt(unsignedBytes, { maxBytes }).outputs).toHaveLength(outputs)
    }

    const { psbt: signed } = signP2mrPsbt({
      psbt: parsePsbt(unsignedBytes, { maxBytes: unsignedBytes.length }),
      keys: [{ inputIndex: 0, pubkey, leafHash, hashType: SIGHASH_ALL }],
      sign: () => new Uint8Array(PQC_SIGNATURE_BYTES).fill(0x5a),
      allowNonDefaultSighash: true,
    })
    const finalBytes = serializePsbt(finalizeP2mrPsbt(signed))
    const finalized = parsePsbt(finalBytes, { maxBytes: finalBytes.length })
    const rawTx = extractP2mrTransaction(finalized, { maxBytes: 400_000 })
    expect(rawTx.length).toBe(390_777)
    expect(Buffer.from(extractP2mrTransaction(finalized, { maxBytes: rawTx.length })).equals(rawTx)).toBe(true)
    expectInvalidPsbt(() => extractP2mrTransaction(finalized, { maxBytes: rawTx.length - 1 }), /larger than maxBytes/)
  })

  it('accepts a block-sized (2,000,000-byte) P2MR transaction under the default limits', () => {
    // 3,763 bytes per single-key P2MR input (Core P2MR_V1_SINGLE_KEY_SPEND_SIZE).
    const bytes = serializePsbt(finalizeP2mrPsbt(signedPsbt(530)))
    expect(bytes.length).toBeGreaterThan(2_000_000)
    const rawTx = extractP2mrTransaction(parsePsbt(bytes))
    expect(rawTx.length).toBeGreaterThan(1_990_000)
    expect(rawTx.length).toBeLessThan(2_000_000)
  })
})

/** The previous `bytesToHex`, kept as the reference its output must still match. */
function referenceHex(bytes: Uint8Array): string {
  let out = ''
  for (const byte of bytes) out += byte.toString(16).padStart(2, '0')
  return out
}

/** `length` bytes covering every byte value. */
function bytePattern(length: number): Uint8Array {
  return Uint8Array.from({ length }, (_, i) => (i * 37 + (i >> 8)) & 0xff)
}

/**
 * Builds a PSBT whose one global key (`key`) or one output scriptPubKey
 * (`script`) is 10 MiB, parses it, combines two copies for `script`, and
 * prints a summary. Runs in a child process, because exhausting the heap
 * aborts the process rather than throwing.
 */
const LARGE_FIELD_PROBE = `
const [modulePath, field, textDecoder] = process.argv.slice(2)
if (textDecoder === 'without-text-decoder') delete globalThis.TextDecoder
const q = require(modulePath)
const leafScript = q.singleKeyLeafScript(new Uint8Array(32).fill(1))
const scriptPubKey = q.p2mrScriptPubKey(q.p2mrLeafHash(q.P2MR_LEAF_VERSION_V1, leafScript))
const large = new Uint8Array(10 * 1024 * 1024).fill(0xab)
// An unknown key type, or as a script OP_RETURN: the only kind of output this
// large that qbit's restricted-output mode allows.
large[0] = field === 'script' ? 0x6a : 0x77
const psbt = q.createP2mrPsbt({
  inputs: [{
    prevout: { txid: new Uint8Array(32), vout: 0 },
    witnessUtxo: { value: 2000n, scriptPubKey },
    leafScript,
    controlBlock: q.buildControlBlock(q.P2MR_LEAF_VERSION_V1, []),
  }],
  outputs: [{ value: 1000n, scriptPubKey: field === 'script' ? large : scriptPubKey }],
})
if (field === 'key') psbt.global.push({ key: large, value: new Uint8Array(0) })
const bytes = q.serializePsbt(psbt)
const parsed = q.parsePsbt(bytes)
const result = field === 'script' ? q.combinePsbts([parsed, q.parsePsbt(bytes)]) : parsed
const sample = Uint8Array.from({ length: 20000 }, (_, i) => (i * 37 + (i >> 8)) & 0xff)
process.stdout.write(JSON.stringify({
  bytes: bytes.length,
  globalEntries: result.global.length,
  outputScriptBytes: q.psbtUnsignedTransaction(result).outputs[0].scriptPubKey.length,
  sampleHex: q.bytesToHex(sample),
}))
`

/**
 * Builds the densest PSBT of distinct `keyBytes`-byte unknown global keys the
 * default limits allow, parses and decodes it, and prints a summary. The
 * bytes are written directly, so the child's heap holds only what parsing
 * keeps.
 */
const DENSE_KEYS_PROBE = `
const [modulePath, keyBytes] = process.argv.slice(2)
const q = require(modulePath)
const L = Number(keyBytes)
// version 2, one input (zero outpoint, empty scriptSig, final sequence), one empty output, locktime 0
const tx = new Uint8Array(60)
tx.set([2, 0, 0, 0, 1], 0)
tx.fill(0xff, 42, 46)
tx[46] = 1
const fixed = 5 + 3 + tx.length + 3 // magic, the tx entry, three map terminators
const entryBytes = 1 + L + 1 // key length, key, empty value
const keys = Math.min(q.PSBT_DEFAULT_MAX_OBJECTS - 3, Math.floor((q.PSBT_DEFAULT_MAX_BYTES - fixed) / entryBytes))
const bytes = new Uint8Array(fixed + keys * entryBytes)
bytes.set([0x70, 0x73, 0x62, 0x74, 0xff, 1, 0x00, tx.length], 0)
bytes.set(tx, 8)
let offset = 8 + tx.length
for (let i = 0; i < keys; i += 1) {
  bytes[offset] = L
  bytes[offset + 1] = 0x77 // an unknown key type
  bytes.set([i >>> 24, (i >> 16) & 0xff, (i >> 8) & 0xff, i & 0xff], offset + 2)
  for (let j = 5; j < L; j += 1) bytes[offset + 1 + j] = (j * 31 + 7) & 0xff
  offset += entryBytes // the empty value's length is already 0
}
const psbt = q.parsePsbt(bytes)
q.decodePsbt(psbt)
process.stdout.write(JSON.stringify({ bytes: bytes.length, globalEntries: psbt.global.length }))
`

/** Compiles `src/index.ts` to CommonJS in `dir`, so a child process can't test a stale `lib/`. */
function compileSource(dir: string): string {
  const modulePath = join(dir, 'index.cjs')
  const source = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8')
  const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  })
  writeFileSync(modulePath, compiled.outputText)
  return modulePath
}

/** Runs `script` in a child process whose V8 heap is capped at `heapMb`; exhausting it aborts only the child. */
function runWithHeap(heapMb: number, scriptPath: string, args: readonly string[]) {
  return spawnSync(process.execPath, [`--max-old-space-size=${heapMb}`, scriptPath, ...args], {
    encoding: 'utf8',
    timeout: 60_000,
    // The compiled module requires @noble/hashes from this package's dependencies.
    env: { ...process.env, NODE_PATH: fileURLToPath(new URL('../node_modules', import.meta.url)) },
  })
}

describe('hex of large keys and scripts', () => {
  it('keeps the previous bytesToHex output for every byte value and across its length thresholds', () => {
    for (const length of [0, 1, 2, 6, 7, 32, 64, 65, 127, 128, 129, 255, 256, 4095, 4096, 4097, 20_000]) {
      const bytes = bytePattern(length)
      expect(bytesToHex(bytes)).toBe(referenceHex(bytes))
    }
    const all = Uint8Array.from({ length: 256 }, (_, i) => i)
    expect(bytesToHex(all)).toBe(referenceHex(all))
    expect(bytesToHex(Buffer.from(all))).toBe(referenceHex(all))
  })

  it('parses a 10 MiB key, and combines PSBTs with a 10 MiB output script, in a 128 MB heap', () => {
    // The previous bytesToHex cost about 57 bytes of heap per byte of key: about
    // 600 MB here, an uncatchable abort under --max-old-space-size=128 (and at 512).
    const dir = mkdtempSync(join(tmpdir(), 'qbit-psbt-hex-'))
    try {
      const modulePath = compileSource(dir)
      const probePath = join(dir, 'probe.cjs')
      writeFileSync(probePath, LARGE_FIELD_PROBE)
      const runs = [
        ['key', 'with-text-decoder'],
        ['script', 'with-text-decoder'],
        ['key', 'without-text-decoder'],
      ] as const
      for (const [field, textDecoder] of runs) {
        const child = runWithHeap(128, probePath, [modulePath, field, textDecoder])
        expect(child.status, `${field} ${textDecoder}: ${child.stderr}`).toBe(0)
        const summary = JSON.parse(child.stdout) as {
          bytes: number
          globalEntries: number
          outputScriptBytes: number
          sampleHex: string
        }
        expect(summary.bytes).toBeGreaterThan(10 * 1024 * 1024)
        expect(summary.globalEntries).toBe(field === 'key' ? 2 : 1)
        expect(summary.outputScriptBytes).toBe(field === 'script' ? 10 * 1024 * 1024 : scriptPubKey.length)
        expect(summary.sampleHex).toBe(referenceHex(bytePattern(20_000)))
      }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }, 120_000)

  it('parses and decodes the densest PSBTs of distinct 64- and 128-byte keys in a 160 MB heap', () => {
    // At the defaults: 131,069 64-byte keys (8.7 MB), or 129,054 128-byte keys
    // (16.8 MB). The duplicate-key check kept every key's hex, and `+=` built
    // it as a rope of about 30 bytes of heap per key byte: about 560 MB for the
    // 128-byte keys, an uncatchable abort at --max-old-space-size=512. They now
    // need about 85 MB.
    const dir = mkdtempSync(join(tmpdir(), 'qbit-psbt-keys-'))
    try {
      const modulePath = compileSource(dir)
      const probePath = join(dir, 'probe.cjs')
      writeFileSync(probePath, DENSE_KEYS_PROBE)
      for (const [keyBytes, keys] of [
        [64, PSBT_DEFAULT_MAX_OBJECTS - 3],
        [128, 129_054],
      ] as const) {
        const child = runWithHeap(160, probePath, [modulePath, String(keyBytes)])
        expect(child.status, `${keyBytes}-byte keys: ${child.stderr}`).toBe(0)
        const summary = JSON.parse(child.stdout) as { bytes: number; globalEntries: number }
        expect(summary.globalEntries).toBe(keys + 1)
        expect(summary.bytes).toBeLessThanOrEqual(PSBT_DEFAULT_MAX_BYTES)
      }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }, 120_000)
})

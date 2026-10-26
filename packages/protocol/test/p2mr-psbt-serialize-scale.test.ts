import { describe, expect, it } from 'vitest'

import fixture from '../fixtures/p2mr-psbt.json'
import {
  P2MR_LEAF_VERSION_V1,
  PQC_SIGNATURE_BYTES,
  buildControlBlock,
  bytesToHex,
  createP2mrPsbt,
  decodePsbt,
  hexToBytes,
  p2mrLeafHash,
  p2mrScriptPubKey,
  parsePsbt,
  serializePsbt,
  signP2mrPsbt,
  singleKeyLeafScript,
} from '../src/index'

// `concatBytes(...parts)` passed two arguments per map entry and overflowed the
// call stack at about 63k entries in one map on Node's main-thread stack.
// 100k is past that and, with the fixture's own entries, inside the
// 131,072-object default budget (`PSBT_DEFAULT_MAX_OBJECTS`). Vitest runs tests in a worker
// thread with a larger (4 MB) stack, where the old spread survived up to about
// 248k entries. Each entry takes two 8-byte argument slots, so no 4 MiB stack
// holds more than 262,144 entries; the hand-built map below goes past that and
// beyond any single parse.
const SCALE_ENTRIES = 100_000
const COMBINED_ENTRIES = 300_000
// 0xf0 is not a key type qbit Core decodes, so these land in its `unknown` map.
const UNKNOWN_KEY_TYPE = 0xf0
const ENTRY_BYTES = 8 // keylen(1) || 0xf0 || uint32 BE index || vallen(1) || value(1)

/**
 * Append `count` unknown entries to the last output map of a serialized PSBT.
 * That map is the last thing in the PSBT, so the entries go right before its
 * 0x00 terminator. Built by hand because `serializePsbt` is what is under test.
 * Entry `i` gets the key index and value `keyIndex(i)`.
 */
function withUnknownOutputEntries(psbtBytes: Uint8Array, count: number, keyIndex = (i: number) => i): Uint8Array {
  expect(psbtBytes[psbtBytes.length - 1]).toBe(0x00)
  const out = new Uint8Array(psbtBytes.length + count * ENTRY_BYTES)
  out.set(psbtBytes.subarray(0, psbtBytes.length - 1), 0)
  const view = new DataView(out.buffer)
  let offset = psbtBytes.length - 1
  for (let i = 0; i < count; i += 1) {
    const index = keyIndex(i)
    out[offset] = 5
    out[offset + 1] = UNKNOWN_KEY_TYPE
    view.setUint32(offset + 2, index, false)
    out[offset + 6] = 1
    out[offset + 7] = index & 0xff
    offset += ENTRY_BYTES
  }
  out[offset] = 0x00
  return out
}

describe('serializePsbt on large maps', () => {
  it(`round-trips ${SCALE_ENTRIES} unknown entries in one output map byte-for-byte`, () => {
    const original = parsePsbt(hexToBytes(fixture.psbtHex))
    const bytes = withUnknownOutputEntries(hexToBytes(fixture.psbtHex), SCALE_ENTRIES)
    // Default parse limits: no options passed.
    const psbt = parsePsbt(bytes)
    const last = psbt.outputs.length - 1
    expect(psbt.outputs[last]!.length).toBe(original.outputs[last]!.length + SCALE_ENTRIES)

    const reserialized = serializePsbt(psbt)
    expect(reserialized.length).toBe(bytes.length)
    expect(Buffer.from(reserialized).equals(Buffer.from(bytes))).toBe(true)
  })

  it('serializes a signed PSBT carrying a huge output map, so the signature is not lost', () => {
    const pubkey = Uint8Array.from({ length: 32 }, (_, i) => (i * 7 + 1) & 0xff)
    const leafScript = singleKeyLeafScript(pubkey)
    const leafHash = p2mrLeafHash(P2MR_LEAF_VERSION_V1, leafScript)
    const scriptPubKey = p2mrScriptPubKey(leafHash)
    const unsigned = createP2mrPsbt({
      inputs: [
        {
          prevout: { txid: new Uint8Array(32).fill(9), vout: 0 },
          witnessUtxo: { value: 100_000n, scriptPubKey },
          leafScript,
          controlBlock: buildControlBlock(P2MR_LEAF_VERSION_V1, []),
          merkleRoot: leafHash,
        },
      ],
      outputs: [{ value: 90_000n, scriptPubKey }],
    })
    const bytes = withUnknownOutputEntries(serializePsbt(unsigned), SCALE_ENTRIES)

    const signature = Uint8Array.from({ length: PQC_SIGNATURE_BYTES }, (_, i) => i & 0xff)
    let signerCalls = 0
    const { psbt: signed, signed: signers } = signP2mrPsbt({
      psbt: parsePsbt(bytes),
      keys: [{ inputIndex: 0, pubkey, leafHash }],
      sign: () => {
        signerCalls += 1
        return signature
      },
    })
    expect(signerCalls).toBe(1)
    expect(signers).toHaveLength(1)

    // Before the fix this threw `RangeError: Maximum call stack size exceeded` on a
    // main-thread stack, after the bounded-use signature had already been
    // produced. Vitest 0.34's worker-thread stack is large enough for this test
    // to pass without the fix; the 300k test below is the one that fails without it.
    const signedBytes = serializePsbt(signed)
    const reparsed = parsePsbt(signedBytes)
    expect(reparsed.outputs[0]!.length).toBe(SCALE_ENTRIES)
    const scriptSigs = decodePsbt(reparsed).inputs[0]!.scriptSigs
    expect(scriptSigs).toHaveLength(1)
    expect(bytesToHex(scriptSigs[0]!.signature.signature)).toBe(bytesToHex(signature))
    expect(Buffer.from(serializePsbt(reparsed)).equals(Buffer.from(signedBytes))).toBe(true)
  })

  it(`serializes ${COMBINED_ENTRIES} entries in one map, more than one parse admits`, () => {
    // `combinePsbts` can build a map this size from several PSBTs that each fit
    // the parse budget; here it is built directly. It repeats one entry object
    // to keep the test's memory down: `serializePsbt` does not check for
    // repeated keys, and the chunk count is what overflowed.
    const psbt = parsePsbt(hexToBytes(fixture.psbtHex))
    const outputMap = psbt.outputs[psbt.outputs.length - 1]!
    expect(outputMap).toHaveLength(0)
    const entry = { key: Uint8Array.of(UNKNOWN_KEY_TYPE, 0, 0, 0, 0), value: Uint8Array.of(0) }
    for (let i = 0; i < COMBINED_ENTRIES; i += 1) outputMap.push(entry)

    const expected = withUnknownOutputEntries(hexToBytes(fixture.psbtHex), COMBINED_ENTRIES, () => 0)
    expect(Buffer.from(serializePsbt(psbt)).equals(Buffer.from(expected))).toBe(true)
  })
})

import { describe, expect, it } from 'vitest'

import {
  P2MR_LEAF_VERSION_V1,
  buildControlBlock,
  combinePsbts,
  createP2mrPsbt,
  decodePsbt,
  finalizeP2mrPsbt,
  p2mrLeafHash,
  p2mrScriptPubKey,
  parsePsbt,
  serializePsbt,
  singleKeyLeafScript,
  type Psbt,
  type PsbtKeyValue,
} from '../src/index'

// qbit Core reads these key types only as the type byte alone and rejects a
// longer key as "... key is more than one byte type" (src/psbt.h at 7ebcddb:
// global :1446-1450, :1495-1498; input :557-560, :567-570, :603-606,
// :614-617, :624-627, :639-642, :649-652, :743-746, :878-881, :888-891;
// output :1183-1186, :1193-1196, :1208-1211, :1218-1221). qbit-js kept such a
// key, so an input `08 00` record parsed, decoded as not finalized, and
// finalizeP2mrPsbt appended a real `08` beside it: a PSBT Core rejects.

const SINGLE_BYTE: ['global' | 'input' | 'output', number][] = [
  ['global', 0x00],
  ['global', 0xfb],
  ...[0x00, 0x01, 0x03, 0x04, 0x05, 0x07, 0x08, 0x13, 0x17, 0x18].map((type): ['input', number] => ['input', type]),
  ...[0x00, 0x01, 0x05, 0x06].map((type): ['output', number] => ['output', type]),
]

const PUBKEY = new Uint8Array(32).fill(0x07)
const LEAF_SCRIPT = singleKeyLeafScript(PUBKEY)
const SCRIPT_PUBKEY = p2mrScriptPubKey(p2mrLeafHash(P2MR_LEAF_VERSION_V1, LEAF_SCRIPT))

function basePsbt(): Psbt {
  return createP2mrPsbt({
    inputs: [
      {
        prevout: { txid: new Uint8Array(32).fill(0x01), vout: 0 },
        witnessUtxo: { value: 100_000n, scriptPubKey: SCRIPT_PUBKEY },
        leafScript: LEAF_SCRIPT,
        controlBlock: buildControlBlock(P2MR_LEAF_VERSION_V1),
      },
    ],
    outputs: [{ value: 1_000n, scriptPubKey: SCRIPT_PUBKEY }],
  })
}

/** `psbt` with `entry` added to its global map, first input map or first output map. */
function withEntry(psbt: Psbt, kind: 'global' | 'input' | 'output', entry: PsbtKeyValue): Psbt {
  return {
    global: kind === 'global' ? [...psbt.global, entry] : psbt.global,
    inputs: kind === 'input' ? [[...psbt.inputs[0]!, entry]] : psbt.inputs,
    outputs: kind === 'output' ? [[...psbt.outputs[0]!, entry]] : psbt.outputs,
  }
}

const refused = (kind: string, type: number) =>
  expect.objectContaining({
    code: 'INVALID_PSBT',
    message: `PSBT ${kind} key of type 0x${type.toString(16).padStart(2, '0')} must be the single type byte`,
  })

describe('PSBT key types that must be the single type byte', () => {
  it.each(SINGLE_BYTE)('refuses a %s key of type %i with key data', (kind, type) => {
    const psbt = withEntry(basePsbt(), kind, { key: Uint8Array.of(type, 0x00), value: Uint8Array.of(0x01) })
    expect(() => parsePsbt(serializePsbt(psbt))).toThrow(refused(kind, type))
    expect(() => combinePsbts([psbt])).toThrow(refused(kind, type))
    expect(() => decodePsbt(psbt)).toThrow(refused(kind, type))
  })

  it('does not finalize an input beside an 08 key with key data', () => {
    const finalWitness = Uint8Array.of(0x01, 0x00)
    const psbt = withEntry(basePsbt(), 'input', { key: Uint8Array.of(0x08, 0x00), value: finalWitness })
    expect(() => finalizeP2mrPsbt(psbt)).toThrow(refused('input', 0x08))
  })

  it('keeps key data on the types that carry it, which differ by map', () => {
    for (const [kind, key] of [
      // An input partial signature (0x02) and Taproot leaf script (0x15) key carry key data.
      ['input', Uint8Array.of(0x02, ...new Uint8Array(33).fill(0x02))],
      ['input', Uint8Array.of(0x15, 0xc0, ...new Uint8Array(32))],
      // In an output map 0x08 is MuSig2 participant pubkeys, and 0x07 a Taproot BIP32 path.
      ['output', Uint8Array.of(0x08, ...new Uint8Array(33).fill(0x02))],
      ['output', Uint8Array.of(0x07, ...new Uint8Array(32))],
      // A global xpub (0x01), and unknown types, which Core keeps whatever their length.
      ['global', Uint8Array.of(0x01, ...new Uint8Array(78))],
      ['global', Uint8Array.of(0x02, 0x00)],
      ['input', Uint8Array.of(0x0e, 0x00)],
    ] as const) {
      const psbt = withEntry(basePsbt(), kind, { key, value: Uint8Array.of(0x01) })
      const parsed = parsePsbt(serializePsbt(psbt))
      expect(serializePsbt(parsed)).toEqual(serializePsbt(psbt))
      expect(decodePsbt(parsed).inputs).toHaveLength(1)
    }
  })
})

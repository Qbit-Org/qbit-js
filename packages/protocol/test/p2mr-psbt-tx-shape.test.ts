import { describe, expect, it, vi } from 'vitest'

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
  validateP2mrSigningPlans,
  type Psbt,
} from '../src/index'

// qbit Core's CheckTransaction rejects a transaction without inputs
// (bad-txns-vin-empty) or outputs (bad-txns-vout-empty), with two inputs
// spending one outpoint (bad-txns-inputs-duplicate), or with an input spending
// the null outpoint (bad-txns-prevout-null; src/consensus/tx_check.cpp:14-17,
// :41-44, :54-56 at 7ebcddb). A lone null-outpoint input makes a coinbase,
// which it rejects with bad-cb-length for an empty scriptSig (:47-50), and the
// mempool as `coinbase` (src/validation.cpp:843-845). qbit-js built and signed
// such transactions, calling a stateful SLH-DSA signer for every plan and
// spending key uses on a transaction no node accepts. Core's DecodeRawPSBT
// does not run CheckTransaction (src/psbt.cpp:754-768), so parsing and
// decoding still accept such a PSBT, except one without inputs, which
// parsePsbt refuses.

const bytes = (length: number, fill: number) => new Uint8Array(length).fill(fill)

const PUBKEY = bytes(32, 0x07)
const LEAF_SCRIPT = singleKeyLeafScript(PUBKEY)
const LEAF_HASH = p2mrLeafHash(P2MR_LEAF_VERSION_V1, LEAF_SCRIPT)
const SCRIPT_PUBKEY = p2mrScriptPubKey(LEAF_HASH)
const SIGNATURE = bytes(PQC_SIGNATURE_BYTES, 0x5a)
const KEYS = [
  { inputIndex: 0, pubkey: PUBKEY, leafHash: LEAF_HASH },
  { inputIndex: 1, pubkey: PUBKEY, leafHash: LEAF_HASH },
]

function input(txidFill: number, vout: number) {
  return {
    prevout: { txid: bytes(32, txidFill), vout },
    witnessUtxo: { value: 100_000n, scriptPubKey: SCRIPT_PUBKEY },
    leafScript: LEAF_SCRIPT,
    controlBlock: buildControlBlock(P2MR_LEAF_VERSION_V1),
  }
}

const OUTPUTS = [{ value: 1_000n, scriptPubKey: SCRIPT_PUBKEY }]

/** An unsigned transaction serialized by hand: version 2, empty scriptSigs, locktime 0. */
function unsignedTx(prevouts: readonly { txidFill: number; vout: number }[], outputCount: number): Uint8Array {
  const le32 = (value: number) => bytesToHex(Uint8Array.of(value, value >>> 8, value >>> 16, value >>> 24))
  const inputs = prevouts.map(({ txidFill, vout }) => `${bytesToHex(bytes(32, txidFill))}${le32(vout)}00fdffffff`)
  const output = `e803000000000000${bytesToHex(Uint8Array.of(SCRIPT_PUBKEY.length))}${bytesToHex(SCRIPT_PUBKEY)}`
  return hexToBytes(
    `02000000${prevouts.length.toString(16).padStart(2, '0')}${inputs.join('')}` +
      `${outputCount.toString(16).padStart(2, '0')}${output.repeat(outputCount)}00000000`
  )
}

/** A PSBT another wallet built, with the input maps createP2mrPsbt writes, round-tripped through the parser. */
function foreignPsbt(prevouts: readonly { txidFill: number; vout: number }[], outputCount: number): Psbt {
  const template = createP2mrPsbt({ inputs: prevouts.map((_, index) => input(0x40 + index, 0)), outputs: OUTPUTS })
  const psbt: Psbt = {
    global: [{ key: Uint8Array.of(0x00), value: unsignedTx(prevouts, outputCount) }],
    inputs: template.inputs,
    outputs: Array.from({ length: outputCount }, () => []),
  }
  return parsePsbt(serializePsbt(psbt))
}

const NO_OUTPUTS = expect.objectContaining({
  code: 'INVALID_PSBT',
  message: 'transaction has no outputs (Core rejects it with bad-txns-vout-empty)',
})
const DUPLICATE = expect.objectContaining({
  code: 'INVALID_PSBT',
  message: 'inputs 0 and 1 spend the same output (Core rejects the transaction with bad-txns-inputs-duplicate)',
})
const NO_INPUTS = expect.objectContaining({
  code: 'INVALID_PSBT',
  message: 'transaction has no inputs (Core rejects it with bad-txns-vin-empty)',
})
const NULL_PREVOUT = expect.objectContaining({
  code: 'INVALID_PSBT',
  message: 'input 1 spends the null outpoint (Core rejects the transaction with bad-txns-prevout-null)',
})
const COINBASE = expect.objectContaining({
  code: 'INVALID_PSBT',
  message:
    'input 0 spends the null outpoint, making the transaction a coinbase ' +
    '(Core rejects it with bad-cb-length, or with coinbase outside a block)',
})
/** COutPoint::IsNull: an all-zero txid and vout 0xffffffff. */
const NULL_TXID_FILL = 0x00
const NULL_VOUT = 0xffffffff

describe('createP2mrPsbt refuses transactions CheckTransaction rejects', () => {
  it('refuses a transaction without inputs, which parsePsbt would refuse', () => {
    expect(() => createP2mrPsbt({ inputs: [], outputs: OUTPUTS })).toThrow(NO_INPUTS)
    // Checked first, as Core does.
    expect(() => createP2mrPsbt({ inputs: [], outputs: [] })).toThrow(NO_INPUTS)

    // Such a PSBT from elsewhere is refused before any signer call too.
    const psbt: Psbt = { global: [{ key: Uint8Array.of(0x00), value: unsignedTx([], 1) }], inputs: [], outputs: [[]] }
    expect(() => parsePsbt(serializePsbt(psbt))).toThrow(expect.objectContaining({ code: 'INVALID_PSBT' }))
    const sign = vi.fn(() => SIGNATURE)
    expect(() => validateP2mrSigningPlans({ psbt, keys: [] })).toThrow(
      expect.objectContaining({ code: 'INVALID_PSBT' })
    )
    expect(() => signP2mrPsbt({ psbt, keys: [], sign })).toThrow(expect.objectContaining({ code: 'INVALID_PSBT' }))
    expect(sign).not.toHaveBeenCalled()
  })

  it('refuses a transaction without outputs', () => {
    expect(() => createP2mrPsbt({ inputs: [input(0x01, 0)], outputs: [] })).toThrow(NO_OUTPUTS)
  })

  it('refuses an input spending the null outpoint', () => {
    expect(() =>
      createP2mrPsbt({ inputs: [input(0x01, 0), input(NULL_TXID_FILL, NULL_VOUT)], outputs: OUTPUTS })
    ).toThrow(NULL_PREVOUT)
    // A lone one makes the transaction a coinbase.
    expect(() => createP2mrPsbt({ inputs: [input(NULL_TXID_FILL, NULL_VOUT)], outputs: OUTPUTS })).toThrow(COINBASE)
    // Two are duplicates first, as in Core.
    expect(() =>
      createP2mrPsbt({ inputs: [input(NULL_TXID_FILL, NULL_VOUT), input(NULL_TXID_FILL, NULL_VOUT)], outputs: OUTPUTS })
    ).toThrow(DUPLICATE)

    // An outpoint null in only its txid or only its vout is an ordinary one.
    const psbt = createP2mrPsbt({
      inputs: [input(NULL_TXID_FILL, 0), input(0x01, NULL_VOUT)],
      outputs: OUTPUTS,
    })
    expect(decodePsbt(psbt).inputs).toHaveLength(2)
    expect(createP2mrPsbt({ inputs: [input(NULL_TXID_FILL, NULL_VOUT - 1)], outputs: OUTPUTS }).inputs).toHaveLength(1)
  })

  it('refuses two inputs spending the same outpoint', () => {
    expect(() => createP2mrPsbt({ inputs: [input(0x01, 0), input(0x01, 0)], outputs: OUTPUTS })).toThrow(DUPLICATE)
    // Reported by the first pair, whatever lies between.
    expect(() =>
      createP2mrPsbt({ inputs: [input(0x01, 0), input(0x02, 0), input(0x01, 1), input(0x02, 0)], outputs: OUTPUTS })
    ).toThrow(expect.objectContaining({ message: expect.stringMatching(/^inputs 1 and 3 spend the same output/) }))
  })

  it('builds inputs that share a txid or a vout but not both', () => {
    const psbt = createP2mrPsbt({
      inputs: [input(0x01, 0), input(0x01, 1), input(0x02, 0)],
      outputs: OUTPUTS,
    })
    expect(decodePsbt(psbt).inputs).toHaveLength(3)
  })
})

describe('the signing preflight refuses transactions CheckTransaction rejects', () => {
  it.each([
    ['without outputs', [{ txidFill: 0x01, vout: 0 }], 0, NO_OUTPUTS],
    [
      'with two inputs spending one outpoint',
      [
        { txidFill: 0x01, vout: 0 },
        { txidFill: 0x01, vout: 0 },
      ],
      1,
      DUPLICATE,
    ],
    [
      'with an input spending the null outpoint',
      [
        { txidFill: 0x01, vout: 0 },
        { txidFill: NULL_TXID_FILL, vout: NULL_VOUT },
      ],
      1,
      NULL_PREVOUT,
    ],
    ['whose only input spends the null outpoint', [{ txidFill: NULL_TXID_FILL, vout: NULL_VOUT }], 1, COINBASE],
  ])('parses and decodes a PSBT %s, as Core does, but signs nothing', (_, prevouts, outputCount, error) => {
    const psbt = foreignPsbt(prevouts, outputCount)
    expect(decodePsbt(psbt).inputs).toHaveLength(prevouts.length)
    const keys = KEYS.slice(0, prevouts.length)
    const sign = vi.fn(() => SIGNATURE)

    expect(() => validateP2mrSigningPlans({ psbt, keys })).toThrow(error)
    expect(() => validateP2mrSigningPlans({ psbt, keys: [] })).toThrow(error)
    expect(() => signP2mrPsbt({ psbt, keys, sign })).toThrow(error)
    expect(sign).not.toHaveBeenCalled()
  })

  it('signs the same PSBT once its inputs spend distinct outpoints', () => {
    const psbt = foreignPsbt(
      [
        { txidFill: 0x01, vout: 0 },
        { txidFill: 0x01, vout: 1 },
      ],
      1
    )
    const sign = vi.fn(() => SIGNATURE)
    expect(signP2mrPsbt({ psbt, keys: KEYS, sign }).signed).toHaveLength(2)
    expect(sign).toHaveBeenCalledTimes(2)
  })
})

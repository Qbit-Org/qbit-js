import { describe, expect, it, vi } from 'vitest'

import {
  P2MR_LEAF_VERSION_V1,
  PQC_SIGNATURE_BYTES,
  buildControlBlock,
  createP2mrPsbt,
  hexToBytes,
  isRestrictedOutputModeOutput,
  p2mrLeafHash,
  p2mrScriptPubKey,
  parsePsbt,
  serializePsbt,
  signP2mrPsbt,
  singleKeyLeafScript,
  validateP2mrSigningPlans,
} from '../src/index'

// qbit Core v1.0.0 runs every network in restricted-output mode
// (src/kernel/chainparams.cpp:159,360,482; regtest :571 unless -p2mronly=0) and
// rejects any transaction with an output outside
// Consensus::IsRestrictedOutputModeConsensusOutput
// (src/consensus/restricted_outputs.h:18-39), from the mempool with
// tx-output-not-p2mr (src/validation.cpp:849) and in a block (:2855-2859).
// qbit-js used to build and sign such transactions, spending a bounded
// SLH-DSA signature on something that could never confirm.

const bytes = (length: number, fill: number) => new Uint8Array(length).fill(fill)
const script = (...parts: (number | Uint8Array)[]) =>
  Uint8Array.from(parts.flatMap(part => (typeof part === 'number' ? [part] : [...part])))

const P2MR = script(0x52, 0x20, bytes(32, 0x11))
const OP_RETURN = 0x6a

/** Output scripts that restricted-output mode allows whatever the reserved-witness state. */
const ALLOWED: [string, Uint8Array][] = [
  ['P2MR (witness v2, 32-byte program)', P2MR],
  ['bare OP_RETURN', script(OP_RETURN)],
  ['OP_RETURN with pushed data', script(OP_RETURN, 0x04, bytes(4, 0xde))],
  // Consensus exempts any script starting with OP_RETURN; push-only data and
  // -datacarriersize are relay policy (src/script/solver.cpp:164, policy.cpp:161-167).
  ['OP_RETURN followed by non-push opcodes', script(OP_RETURN, 0xac, 0x87)],
  ['OP_RETURN over the default -datacarriersize', script(OP_RETURN, bytes(200_001, 0x01))],
  ['P2A (OP_1 <0x4e73>)', hexToBytes('51024e73')],
]

/** Output scripts that restricted-output mode never allows. */
const REFUSED: [string, Uint8Array][] = [
  ['P2WPKH', script(0x00, 0x14, bytes(20, 0x22))],
  ['P2WSH', script(0x00, 0x20, bytes(32, 0x22))],
  ['P2TR (witness v1, 32-byte program)', script(0x51, 0x20, bytes(32, 0x22))],
  ['P2PKH', script(0x76, 0xa9, 0x14, bytes(20, 0x22), 0x88, 0xac)],
  ['P2SH', script(0xa9, 0x14, bytes(20, 0x22), 0x87)],
  ['bare OP_1', script(0x51)],
  ['empty script', new Uint8Array()],
  ['bare OP_CHECKSIG', script(0xac)],
  ['witness v2 with a 20-byte program', script(0x52, 0x14, bytes(20, 0x11))],
  ['witness v2 with a 40-byte program', script(0x52, 0x28, bytes(40, 0x11))],
  ['P2MR with a trailing byte', script(P2MR, 0x00)],
  ['P2MR cut short', P2MR.subarray(0, 33)],
  ['P2MR program pushed with OP_PUSHDATA1', script(0x52, 0x4c, 0x20, bytes(32, 0x11))],
  ['P2A with another program', hexToBytes('51024e74')],
  ['P2A with a trailing byte', hexToBytes('51024e7300')],
  ['witness v1 with a 3-byte program', hexToBytes('51034e7300')],
  ['OP_RETURN that is not the first opcode', script(0x00, OP_RETURN)],
  ['reserved witness version with a 1-byte program', script(0x53, 0x01, 0x01)],
  ['reserved witness version with a 41-byte program', script(0x53, 0x29, bytes(41, 0x01))],
]

/** Witness v3..v16 outputs: allowed only once Core's reserved outer witness versions are active. */
const RESERVED: [string, Uint8Array][] = [
  ['witness v3, 32-byte program', script(0x53, 0x20, bytes(32, 0x33))],
  ['witness v3, 2-byte program', script(0x53, 0x02, 0x4e, 0x73)],
  ['witness v16, 40-byte program', script(0x60, 0x28, bytes(40, 0x33))],
]

describe('isRestrictedOutputModeOutput', () => {
  it.each(ALLOWED)('allows %s', (_, scriptPubKey) => {
    expect(isRestrictedOutputModeOutput(scriptPubKey)).toBe(true)
    expect(isRestrictedOutputModeOutput(scriptPubKey, { reservedWitnessActive: true })).toBe(true)
  })

  it.each(REFUSED)('refuses %s', (_, scriptPubKey) => {
    expect(isRestrictedOutputModeOutput(scriptPubKey)).toBe(false)
    expect(isRestrictedOutputModeOutput(scriptPubKey, { reservedWitnessActive: true })).toBe(false)
  })

  it.each(RESERVED)('allows %s only with reservedWitnessActive: true', (_, scriptPubKey) => {
    expect(isRestrictedOutputModeOutput(scriptPubKey)).toBe(false)
    expect(isRestrictedOutputModeOutput(scriptPubKey, { reservedWitnessActive: false })).toBe(false)
    expect(isRestrictedOutputModeOutput(scriptPubKey, { reservedWitnessActive: true })).toBe(true)
  })

  it('treats only a literal true as reservedWitnessActive', () => {
    const [, v3] = RESERVED[0]!
    expect(isRestrictedOutputModeOutput(v3, { reservedWitnessActive: 1 as never })).toBe(false)
    expect(isRestrictedOutputModeOutput(v3, { reservedWitnessActive: 'true' as never })).toBe(false)
  })

  it('accepts a Buffer and rejects a non-Uint8Array script', () => {
    expect(isRestrictedOutputModeOutput(Buffer.from(P2MR))).toBe(true)
    expect(isRestrictedOutputModeOutput(Buffer.from(REFUSED[0]![1]))).toBe(false)
    for (const lookAlike of ['52' + '11'.repeat(32), [...P2MR], Uint16Array.from(P2MR)]) {
      expect(() => isRestrictedOutputModeOutput(lookAlike as never)).toThrow(
        expect.objectContaining({ code: 'INVALID_BYTES', message: 'scriptPubKey must be a Uint8Array' })
      )
    }
  })
})

const PUBKEY = bytes(32, 0x07)
const LEAF_SCRIPT = singleKeyLeafScript(PUBKEY)
const LEAF_HASH = p2mrLeafHash(P2MR_LEAF_VERSION_V1, LEAF_SCRIPT)
const KEYS = [{ inputIndex: 0, pubkey: PUBKEY, leafHash: LEAF_HASH }]
const SIGNATURE = bytes(PQC_SIGNATURE_BYTES, 0x5a)

function psbtParams(outputScripts: readonly Uint8Array[]) {
  return {
    inputs: [
      {
        prevout: { txid: bytes(32, 0x01), vout: 0 },
        witnessUtxo: { value: 100_000n, scriptPubKey: p2mrScriptPubKey(LEAF_HASH) },
        leafScript: LEAF_SCRIPT,
        controlBlock: buildControlBlock(P2MR_LEAF_VERSION_V1),
      },
    ],
    outputs: outputScripts.map(scriptPubKey => ({ value: 1_000n, scriptPubKey })),
  }
}

const notAllowed = (index: number) =>
  expect.objectContaining({
    code: 'INVALID_SCRIPT',
    message: expect.stringMatching(new RegExp(`^output ${index}: .*restricted-output mode.*tx-output-not-p2mr`)),
  })

describe('createP2mrPsbt enforces restricted-output mode', () => {
  it.each([...REFUSED, ...RESERVED])('refuses a %s output', (_, scriptPubKey) => {
    expect(() => createP2mrPsbt(psbtParams([P2MR, scriptPubKey]))).toThrow(notAllowed(1))
    expect(() => createP2mrPsbt({ ...psbtParams([P2MR, scriptPubKey]), restrictedOutputMode: true })).toThrow(
      notAllowed(1)
    )
  })

  it('builds a transaction mixing every allowed output type', () => {
    const psbt = createP2mrPsbt(psbtParams(ALLOWED.map(([, scriptPubKey]) => scriptPubKey)))
    expect(psbt.outputs).toHaveLength(ALLOWED.length)
  })

  it('builds any output with restrictedOutputMode: false (regtest -p2mronly=0)', () => {
    const outputs = [...REFUSED, ...RESERVED].map(([, scriptPubKey]) => scriptPubKey)
    const psbt = createP2mrPsbt({ ...psbtParams(outputs), restrictedOutputMode: false })
    expect(psbt.outputs).toHaveLength(outputs.length)
  })

  it('keeps the check on for any value other than a literal false', () => {
    const params = psbtParams([REFUSED[0]![1]])
    for (const restrictedOutputMode of [0, null, 'false']) {
      expect(() => createP2mrPsbt({ ...params, restrictedOutputMode: restrictedOutputMode as never })).toThrow(
        notAllowed(0)
      )
    }
  })

  it('rejects a non-Uint8Array output script with INVALID_BYTES', () => {
    const params = psbtParams([P2MR])
    const outputs = [{ value: 1_000n, scriptPubKey: [...P2MR] as never }]
    expect(() => createP2mrPsbt({ ...params, outputs })).toThrow(
      expect.objectContaining({ code: 'INVALID_BYTES', message: 'output 0 scriptPubKey must be a Uint8Array' })
    )
  })
})

describe('the signing preflight enforces restricted-output mode', () => {
  // A PSBT from elsewhere (another wallet, a dApp, or this library with the
  // check turned off) reaches the signer through parsePsbt.
  const foreignPsbt = (scriptPubKey: Uint8Array) =>
    parsePsbt(serializePsbt(createP2mrPsbt({ ...psbtParams([P2MR, scriptPubKey]), restrictedOutputMode: false })))

  it.each([...REFUSED, ...RESERVED])('refuses a PSBT with a %s output before any signer call', (_, scriptPubKey) => {
    const psbt = foreignPsbt(scriptPubKey)
    const sign = vi.fn(() => SIGNATURE)
    expect(() => validateP2mrSigningPlans({ psbt, keys: KEYS })).toThrow(notAllowed(1))
    expect(() => signP2mrPsbt({ psbt, keys: KEYS, sign })).toThrow(notAllowed(1))
    expect(sign).not.toHaveBeenCalled()
  })

  it('refuses such a PSBT even with no signing keys', () => {
    expect(() => validateP2mrSigningPlans({ psbt: foreignPsbt(REFUSED[0]![1]), keys: [] })).toThrow(notAllowed(1))
  })

  it('signs a PSBT whose outputs are all allowed', () => {
    const psbt = createP2mrPsbt(psbtParams(ALLOWED.map(([, scriptPubKey]) => scriptPubKey)))
    const sign = vi.fn(() => SIGNATURE)
    expect(signP2mrPsbt({ psbt, keys: KEYS, sign }).signed).toHaveLength(1)
    expect(sign).toHaveBeenCalledTimes(1)
  })

  it('signs any output with restrictedOutputMode: false (regtest -p2mronly=0)', () => {
    const psbt = foreignPsbt(REFUSED[0]![1])
    const sign = vi.fn(() => SIGNATURE)
    expect(() => validateP2mrSigningPlans({ psbt, keys: KEYS, restrictedOutputMode: false })).not.toThrow()
    expect(signP2mrPsbt({ psbt, keys: KEYS, sign, restrictedOutputMode: false }).signed).toHaveLength(1)
    expect(sign).toHaveBeenCalledTimes(1)
  })
})

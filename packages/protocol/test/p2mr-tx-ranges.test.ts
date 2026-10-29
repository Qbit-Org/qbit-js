import { sha256 } from '@noble/hashes/sha256'
import { describe, expect, it } from 'vitest'

import {
  type P2mrSpentOutput,
  type P2mrTransaction,
  type Psbt,
  PSBT_GLOBAL_UNSIGNED_TX,
  PSBT_IN_WITNESS_UTXO,
  QBIT_MAX_MONEY,
  QbitProtocolError,
  SIGHASH_ALL,
  SIGHASH_ANYONECANPAY,
  SIGHASH_SINGLE,
  assertMoneyRange,
  assertUint32,
  bytesToHex,
  createP2mrPsbt,
  decodePsbt,
  hexToBytes,
  p2mrSighash,
  parsePsbt,
  precomputeSighashMidstates,
  psbtUnsignedTransaction,
  schnorrSignatureHash,
  serializePsbt,
  validateP2mrSigningPlans,
} from '../src/index'

// Regression coverage: integer fields and amounts used to be
// serialized (and signed) modulo 2^32 / 2^64 instead of being rejected.

const SCRIPT = hexToBytes(`5220${'11'.repeat(32)}`)
const TXID = new Uint8Array(32).fill(7)
const LEAF_HASH = hexToBytes('22'.repeat(32))
const UINT32_MAX = 0xffffffff

/** Values that `>>> 0` used to wrap or truncate silently. */
const BAD_UINT32 = [NaN, Infinity, -Infinity, -1, 1.5, 2 ** 32, 2 ** 32 + 5, 1e10]
/** Runtime values a JS caller could pass where TypeScript expects a number. */
const NOT_A_NUMBER = ['5', 5n, null, undefined, true, {}] as unknown as number[]
/** For optional fields `undefined` legitimately means "use the default"; `null` does not. */
const NOT_A_NUMBER_NOR_DEFAULT = NOT_A_NUMBER.filter(value => value !== undefined)
/** Amounts outside MoneyRange, including ones that wrap to in-range int64 values. */
const BAD_AMOUNTS = [-1n, QBIT_MAX_MONEY + 1n, 2n ** 63n, 2n ** 64n + 5n]
/** Runtime values a JS caller could pass where TypeScript expects a bigint. */
const NOT_A_BIGINT = [1000, '1000', null, undefined, 1.5] as unknown as bigint[]

function tx(overrides: Partial<P2mrTransaction> = {}): P2mrTransaction {
  return {
    version: 2,
    locktime: 0,
    inputs: [{ prevout: { txid: TXID, vout: 0 }, sequence: 0xfffffffd }],
    outputs: [{ value: 90_000n, scriptPubKey: SCRIPT }],
    ...overrides,
  }
}

function spent(value = 100_000n): P2mrSpentOutput[] {
  return [{ value, scriptPubKey: SCRIPT }]
}

function withInput(overrides: { vout?: number; sequence?: number }): P2mrTransaction {
  return tx({
    inputs: [{ prevout: { txid: TXID, vout: overrides.vout ?? 0 }, sequence: overrides.sequence ?? 0xfffffffd }],
  })
}

function psbtParams(overrides: {
  version?: number
  locktime?: number
  vout?: number
  sequence?: number
  utxoValue?: bigint
  outputValue?: bigint
}) {
  // Keys that are present are passed through verbatim, even when null/undefined.
  const input: Parameters<typeof createP2mrPsbt>[0]['inputs'][number] = {
    prevout: { txid: TXID, vout: 'vout' in overrides ? overrides.vout! : 0 },
    witnessUtxo: { value: 'utxoValue' in overrides ? overrides.utxoValue! : 100_000n, scriptPubKey: SCRIPT },
    leafScript: new Uint8Array(),
    controlBlock: Uint8Array.of(0xc1),
  }
  if ('sequence' in overrides) input.sequence = overrides.sequence!
  const params: Parameters<typeof createP2mrPsbt>[0] = {
    inputs: [input],
    outputs: [{ value: 'outputValue' in overrides ? overrides.outputValue! : 90_000n, scriptPubKey: SCRIPT }],
  }
  if ('version' in overrides) params.version = overrides.version!
  if ('locktime' in overrides) params.locktime = overrides.locktime!
  return params
}

function expectProtocolError(fn: () => unknown, code: 'INVALID_AMOUNT' | 'INVALID_INTEGER', message: RegExp): void {
  let caught: unknown
  try {
    fn()
  } catch (error) {
    caught = error
  }
  expect(caught).toBeInstanceOf(QbitProtocolError)
  expect((caught as QbitProtocolError).code).toBe(code)
  expect((caught as QbitProtocolError).message).toMatch(message)
}

// --- raw wire helpers: build what a malicious or buggy peer could hand us ---

function rawUint32LE(value: number): Uint8Array {
  const out = new Uint8Array(4)
  new DataView(out.buffer).setUint32(0, value, true)
  return out
}

/** Two's-complement int64 LE, exactly as the old serializer wrapped it. */
function rawInt64LE(value: bigint): Uint8Array {
  const out = new Uint8Array(8)
  new DataView(out.buffer).setBigInt64(0, BigInt.asIntN(64, value), true)
  return out
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  let offset = 0
  for (const part of parts) {
    out.set(part, offset)
    offset += part.length
  }
  return out
}

function rawTxOut(value: bigint): Uint8Array {
  return concat(rawInt64LE(value), Uint8Array.of(SCRIPT.length), SCRIPT)
}

function rawUnsignedTx(outputValues: readonly bigint[], inputCount = 1, version = 2): Uint8Array {
  const inputs = Array.from({ length: inputCount }, (_, i) =>
    concat(new Uint8Array(32).fill(i + 1), rawUint32LE(0), Uint8Array.of(0x00), rawUint32LE(0xfffffffd))
  )
  return concat(
    rawUint32LE(version),
    Uint8Array.of(inputCount),
    ...inputs,
    Uint8Array.of(outputValues.length),
    ...outputValues.map(rawTxOut),
    rawUint32LE(0)
  )
}

function rawPsbt(outputValues: readonly bigint[], witnessValues: readonly (bigint | undefined)[], version = 2): Psbt {
  return {
    global: [
      {
        key: Uint8Array.of(PSBT_GLOBAL_UNSIGNED_TX),
        value: rawUnsignedTx(outputValues, witnessValues.length, version),
      },
    ],
    inputs: witnessValues.map(value =>
      value === undefined ? [] : [{ key: Uint8Array.of(PSBT_IN_WITNESS_UTXO), value: rawTxOut(value) }]
    ),
    outputs: outputValues.map(() => []),
  }
}

describe('assertMoneyRange', () => {
  it('accepts the MoneyRange boundaries', () => {
    expect(() => assertMoneyRange(0n, 'amount')).not.toThrow()
    expect(() => assertMoneyRange(QBIT_MAX_MONEY, 'amount')).not.toThrow()
    expect(() => assertMoneyRange(1n)).not.toThrow()
  })

  it.each(BAD_AMOUNTS)('rejects %s', value => {
    expectProtocolError(() => assertMoneyRange(value, 'output value'), 'INVALID_AMOUNT', /output value .* MoneyRange/)
  })

  it.each(NOT_A_BIGINT)('rejects the non-bigint %s', value => {
    expectProtocolError(
      () => assertMoneyRange(value, 'output value'),
      'INVALID_AMOUNT',
      /output value must be a bigint/
    )
  })
})

describe('assertUint32', () => {
  it('accepts the uint32 boundaries', () => {
    expect(() => assertUint32(0, 'locktime')).not.toThrow()
    expect(() => assertUint32(UINT32_MAX, 'locktime')).not.toThrow()
  })

  it.each(BAD_UINT32)('rejects %s', value => {
    expectProtocolError(
      () => assertUint32(value, 'locktime'),
      'INVALID_INTEGER',
      /locktime .* integer in \[0, 4294967295\]/
    )
  })

  it.each(NOT_A_NUMBER)('rejects the non-number %s', value => {
    expectProtocolError(() => assertUint32(value, 'locktime'), 'INVALID_INTEGER', /^locktime /)
  })
})

describe('createP2mrPsbt rejects out-of-range transaction fields', () => {
  it('no longer time-locks to block 5 when asked for locktime 2^32 + 5', () => {
    expectProtocolError(() => createP2mrPsbt(psbtParams({ locktime: 2 ** 32 + 5 })), 'INVALID_INTEGER', /locktime/)
    // A millisecond timestamp is the other reported foot-gun.
    expectProtocolError(() => createP2mrPsbt(psbtParams({ locktime: 1e10 })), 'INVALID_INTEGER', /locktime/)
  })

  it.each(BAD_UINT32)('rejects version %s', value => {
    expectProtocolError(() => createP2mrPsbt(psbtParams({ version: value })), 'INVALID_INTEGER', /version/)
  })

  it.each(BAD_UINT32)('rejects locktime %s', value => {
    expectProtocolError(() => createP2mrPsbt(psbtParams({ locktime: value })), 'INVALID_INTEGER', /locktime/)
  })

  it.each(BAD_UINT32)('rejects vout %s', value => {
    expectProtocolError(() => createP2mrPsbt(psbtParams({ vout: value })), 'INVALID_INTEGER', /vout/)
  })

  it.each(BAD_UINT32)('rejects sequence %s', value => {
    expectProtocolError(() => createP2mrPsbt(psbtParams({ sequence: value })), 'INVALID_INTEGER', /sequence/)
  })

  it.each(NOT_A_NUMBER_NOR_DEFAULT)('rejects the non-number version %s instead of defaulting', value => {
    expectProtocolError(() => createP2mrPsbt(psbtParams({ version: value })), 'INVALID_INTEGER', /version/)
  })

  it.each(NOT_A_NUMBER_NOR_DEFAULT)('rejects the non-number locktime %s instead of defaulting', value => {
    expectProtocolError(() => createP2mrPsbt(psbtParams({ locktime: value })), 'INVALID_INTEGER', /locktime/)
  })

  it.each(NOT_A_NUMBER_NOR_DEFAULT)('rejects the non-number sequence %s instead of defaulting', value => {
    expectProtocolError(() => createP2mrPsbt(psbtParams({ sequence: value })), 'INVALID_INTEGER', /sequence/)
  })

  it('still applies the defaults when a field is undefined', () => {
    const parsed = psbtUnsignedTransaction(
      createP2mrPsbt(psbtParams({ version: undefined, locktime: undefined, sequence: undefined }))
    )
    expect(parsed.version).toBe(2)
    expect(parsed.locktime).toBe(0)
    expect(parsed.inputs[0]!.sequence).toBe(0xfffffffd)
  })

  it.each(BAD_AMOUNTS)('rejects output value %s', value => {
    expectProtocolError(() => createP2mrPsbt(psbtParams({ outputValue: value })), 'INVALID_AMOUNT', /^output 0 value/)
  })

  it.each(BAD_AMOUNTS)('rejects witness UTXO value %s', value => {
    expectProtocolError(
      () => createP2mrPsbt(psbtParams({ utxoValue: value })),
      'INVALID_AMOUNT',
      /input 0 witness UTXO value/
    )
  })

  it.each(NOT_A_BIGINT)('rejects the non-bigint output value %s', value => {
    expectProtocolError(() => createP2mrPsbt(psbtParams({ outputValue: value })), 'INVALID_AMOUNT', /must be a bigint/)
  })

  it('round-trips every boundary value unchanged', () => {
    const psbt = createP2mrPsbt({
      ...psbtParams({ version: UINT32_MAX, locktime: UINT32_MAX, vout: UINT32_MAX, sequence: 0 }),
      outputs: [
        { value: 0n, scriptPubKey: SCRIPT },
        { value: QBIT_MAX_MONEY, scriptPubKey: SCRIPT },
      ],
    })
    const parsed = psbtUnsignedTransaction(parsePsbt(serializePsbt(psbt)))
    expect(parsed.version).toBe(UINT32_MAX)
    expect(parsed.locktime).toBe(UINT32_MAX)
    expect(parsed.inputs[0]!.prevout.vout).toBe(UINT32_MAX)
    expect(parsed.inputs[0]!.sequence).toBe(0)
    expect(parsed.outputs.map(output => output.value)).toEqual([0n, QBIT_MAX_MONEY])
  })
})

describe('sighash rejects out-of-range transaction fields', () => {
  const leafHash = LEAF_HASH

  it('refuses to sign locktime 2^32 + 5 as if it were locktime 5', () => {
    const wrapped = () =>
      p2mrSighash({ tx: tx({ locktime: 2 ** 32 + 5 }), inputIndex: 0, spentOutputs: spent(), leafHash })
    expectProtocolError(wrapped, 'INVALID_INTEGER', /locktime 4294967301/)
    // The honest digest for locktime 5 is still produced.
    expect(p2mrSighash({ tx: tx({ locktime: 5 }), inputIndex: 0, spentOutputs: spent(), leafHash })).toHaveLength(32)
  })

  it.each(BAD_UINT32)('rejects version %s', value => {
    expectProtocolError(
      () => p2mrSighash({ tx: tx({ version: value }), inputIndex: 0, spentOutputs: spent(), leafHash }),
      'INVALID_INTEGER',
      /version/
    )
  })

  it.each(BAD_UINT32)('rejects locktime %s', value => {
    expectProtocolError(
      () => p2mrSighash({ tx: tx({ locktime: value }), inputIndex: 0, spentOutputs: spent(), leafHash }),
      'INVALID_INTEGER',
      /locktime/
    )
  })

  it.each(BAD_UINT32)('rejects vout %s', value => {
    expectProtocolError(
      () => p2mrSighash({ tx: withInput({ vout: value }), inputIndex: 0, spentOutputs: spent(), leafHash }),
      'INVALID_INTEGER',
      /vout/
    )
    expectProtocolError(
      () => precomputeSighashMidstates(withInput({ vout: value }), spent()),
      'INVALID_INTEGER',
      /vout/
    )
  })

  it.each(BAD_UINT32)('rejects sequence %s', value => {
    expectProtocolError(
      () => p2mrSighash({ tx: withInput({ sequence: value }), inputIndex: 0, spentOutputs: spent(), leafHash }),
      'INVALID_INTEGER',
      /sequence/
    )
    expectProtocolError(
      () => precomputeSighashMidstates(withInput({ sequence: value }), spent()),
      'INVALID_INTEGER',
      /sequence/
    )
  })

  it.each(BAD_UINT32)('rejects codeSeparatorPos %s', value => {
    expectProtocolError(
      () => p2mrSighash({ tx: tx(), inputIndex: 0, spentOutputs: spent(), leafHash, codeSeparatorPos: value }),
      'INVALID_INTEGER',
      /codeSeparatorPos/
    )
    // Validated at the entry point even when the sig version does not commit to it.
    expectProtocolError(
      () =>
        schnorrSignatureHash({
          tx: tx(),
          inputIndex: 0,
          spentOutputs: spent(),
          sigVersion: 'taproot',
          codeSeparatorPos: value,
        }),
      'INVALID_INTEGER',
      /codeSeparatorPos/
    )
  })

  it.each(BAD_AMOUNTS)('rejects spent output value %s', value => {
    expectProtocolError(() => precomputeSighashMidstates(tx(), spent(value)), 'INVALID_AMOUNT', /spent output 0 value/)
    expectProtocolError(
      () => p2mrSighash({ tx: tx(), inputIndex: 0, spentOutputs: spent(value), leafHash }),
      'INVALID_AMOUNT',
      /spent output 0 value/
    )
  })

  it.each(BAD_AMOUNTS)('rejects spent output value %s on the ANYONECANPAY path with cached midstates', value => {
    // With caller-supplied midstates only the ANYONECANPAY branch serializes the amount itself.
    const midstates = precomputeSighashMidstates(tx(), spent())
    expectProtocolError(
      () =>
        p2mrSighash({
          tx: tx(),
          inputIndex: 0,
          spentOutputs: spent(value),
          leafHash,
          hashType: SIGHASH_ANYONECANPAY | SIGHASH_ALL,
          midstates,
        }),
      'INVALID_AMOUNT',
      /spent output 0 value/
    )
  })

  it.each(BAD_AMOUNTS)('rejects transaction output value %s', value => {
    const bad = tx({ outputs: [{ value, scriptPubKey: SCRIPT }] })
    expectProtocolError(() => precomputeSighashMidstates(bad, spent()), 'INVALID_AMOUNT', /^output 0 value/)
    expectProtocolError(
      () => p2mrSighash({ tx: bad, inputIndex: 0, spentOutputs: spent(), leafHash }),
      'INVALID_AMOUNT',
      /^output 0 value/
    )
    // SIGHASH_SINGLE hashes the matching output directly, bypassing the midstates.
    const midstates = precomputeSighashMidstates(tx(), spent())
    expectProtocolError(
      () =>
        p2mrSighash({ tx: bad, inputIndex: 0, spentOutputs: spent(), leafHash, hashType: SIGHASH_SINGLE, midstates }),
      'INVALID_AMOUNT',
      /^output 0 value/
    )
  })

  describe('with caller-supplied cached midstates (SIGHASH_DEFAULT, no ANYONECANPAY)', () => {
    // The midstates come from a valid transaction; the bad field must still be caught.
    const midstates = precomputeSighashMidstates(tx(), spent())
    const hash =
      (bad: P2mrTransaction, spentOutputs: P2mrSpentOutput[] = spent()) =>
      () =>
        p2mrSighash({ tx: bad, inputIndex: 0, spentOutputs, leafHash, midstates })

    it.each(BAD_UINT32)('rejects vout %s', value => {
      expectProtocolError(hash(withInput({ vout: value })), 'INVALID_INTEGER', /input 0 vout/)
    })

    it.each(BAD_UINT32)('rejects sequence %s', value => {
      expectProtocolError(hash(withInput({ sequence: value })), 'INVALID_INTEGER', /input 0 sequence/)
    })

    it.each(BAD_AMOUNTS)('rejects transaction output value %s', value => {
      expectProtocolError(hash(tx({ outputs: [{ value, scriptPubKey: SCRIPT }] })), 'INVALID_AMOUNT', /^output 0 value/)
    })

    it.each(BAD_AMOUNTS)('rejects spent output value %s', value => {
      expectProtocolError(hash(tx(), spent(value)), 'INVALID_AMOUNT', /spent output 0 value/)
    })

    it('rejects a prevout txid that is not 32 bytes', () => {
      const short: P2mrTransaction = tx({
        inputs: [{ prevout: { txid: TXID.subarray(1), vout: 0 }, sequence: 0xfffffffd }],
      })
      let caught: unknown
      try {
        p2mrSighash({ tx: short, inputIndex: 0, spentOutputs: spent(), leafHash, midstates })
      } catch (error) {
        caught = error
      }
      expect(caught).toBeInstanceOf(QbitProtocolError)
      expect((caught as QbitProtocolError).code).toBe('INVALID_BYTES')
      expect((caught as QbitProtocolError).message).toBe('input 0 outpoint txid must be 32 bytes')
    })

    it('rejects a transaction with several out-of-range fields', () => {
      const bad: P2mrTransaction = {
        version: 2,
        locktime: 0,
        inputs: [{ prevout: { txid: TXID, vout: 2 ** 32 + 5 }, sequence: 2 ** 32 }],
        outputs: [{ value: -1n, scriptPubKey: SCRIPT }],
      }
      expect(hash(bad, spent(-1n))).toThrow(QbitProtocolError)
    })

    it('checks the second input and output too', () => {
      const twoIn = tx({
        inputs: [
          { prevout: { txid: TXID, vout: 0 }, sequence: 0xfffffffd },
          { prevout: { txid: TXID, vout: 1.5 }, sequence: 0xfffffffd },
        ],
      })
      const twoSpent = [...spent(), ...spent()]
      expectProtocolError(
        () =>
          p2mrSighash({
            tx: twoIn,
            inputIndex: 0,
            spentOutputs: twoSpent,
            leafHash,
            midstates: precomputeSighashMidstates(tx({ inputs: [twoIn.inputs[0]!, twoIn.inputs[0]!] }), twoSpent),
          }),
        'INVALID_INTEGER',
        /input 1 vout/
      )
      expectProtocolError(
        hash(
          tx({
            outputs: [
              { value: 1n, scriptPubKey: SCRIPT },
              { value: QBIT_MAX_MONEY + 1n, scriptPubKey: SCRIPT },
            ],
          })
        ),
        'INVALID_AMOUNT',
        /^output 1 value/
      )
    })
  })

  describe('keyVersion', () => {
    const hash = (keyVersion: number) =>
      schnorrSignatureHash({ tx: tx(), inputIndex: 0, spentOutputs: spent(), sigVersion: 'p2mr', leafHash, keyVersion })

    it.each([-1, 1.5, 256, 2 ** 32, NaN, Infinity, -Infinity])(
      'rejects %s instead of masking it with & 0xff',
      value => {
        expectProtocolError(() => hash(value), 'INVALID_INTEGER', /keyVersion .* integer in \[0, 255\]/)
      }
    )

    it.each(NOT_A_NUMBER_NOR_DEFAULT)('rejects the non-number %s', value => {
      expectProtocolError(() => hash(value), 'INVALID_INTEGER', /keyVersion/)
    })

    it('accepts the uint8 boundaries and commits to them', () => {
      expect(hash(0)).toHaveLength(32)
      expect(hash(255)).toHaveLength(32)
      expect(bytesToHex(hash(0))).toBe(
        bytesToHex(p2mrSighash({ tx: tx(), inputIndex: 0, spentOutputs: spent(), leafHash }))
      )
      expect(bytesToHex(hash(255))).not.toBe(bytesToHex(hash(0)))
    })
  })

  it('still hashes every boundary value', () => {
    const boundary: P2mrTransaction = {
      version: UINT32_MAX,
      locktime: UINT32_MAX,
      inputs: [{ prevout: { txid: TXID, vout: UINT32_MAX }, sequence: 0 }],
      outputs: [
        { value: 0n, scriptPubKey: SCRIPT },
        { value: QBIT_MAX_MONEY, scriptPubKey: SCRIPT },
      ],
    }
    const spentMax = spent(QBIT_MAX_MONEY)
    const direct = p2mrSighash({ tx: boundary, inputIndex: 0, spentOutputs: spentMax, leafHash, codeSeparatorPos: 0 })
    const cached = p2mrSighash({
      tx: boundary,
      inputIndex: 0,
      spentOutputs: spentMax,
      leafHash,
      codeSeparatorPos: 0,
      midstates: precomputeSighashMidstates(boundary, spentMax),
    })
    expect(direct).toHaveLength(32)
    expect(bytesToHex(cached)).toBe(bytesToHex(direct))
    expect(
      p2mrSighash({
        tx: boundary,
        inputIndex: 0,
        spentOutputs: spent(0n),
        leafHash,
        hashType: SIGHASH_ANYONECANPAY | SIGHASH_SINGLE,
      })
    ).toHaveLength(32)
  })
})

describe('PSBT parsing and decoding reject out-of-range amounts', () => {
  it.each([-1n, QBIT_MAX_MONEY + 1n, 2n ** 63n])('rejects an unsigned transaction output of %s', value => {
    expectProtocolError(
      () => parsePsbt(serializePsbt(rawPsbt([value], [undefined]))),
      'INVALID_AMOUNT',
      /output 0 value/
    )
    expectProtocolError(
      () => psbtUnsignedTransaction(rawPsbt([value], [undefined])),
      'INVALID_AMOUNT',
      /output 0 value/
    )
  })

  it.each([-1n, QBIT_MAX_MONEY + 1n, 2n ** 63n])(
    'rejects a witness UTXO of %s instead of reporting a bogus fee',
    value => {
      const psbt = rawPsbt([90_000n], [value])
      expectProtocolError(() => decodePsbt(psbt), 'INVALID_AMOUNT', /input 0 witness UTXO value/)
      expectProtocolError(
        () => validateP2mrSigningPlans({ psbt, keys: [] }),
        'INVALID_AMOUNT',
        /input 0 witness UTXO value/
      )
    }
  )

  it('rejects outputs that exceed the inputs (negative fee)', () => {
    expectProtocolError(
      () => decodePsbt(rawPsbt([100_001n], [100_000n])),
      'INVALID_AMOUNT',
      /exceeds total input value/
    )
  })

  it('rejects totals outside MoneyRange even when each amount is in range', () => {
    expectProtocolError(
      () => decodePsbt(rawPsbt([QBIT_MAX_MONEY, QBIT_MAX_MONEY], [undefined])),
      'INVALID_AMOUNT',
      /total output value/
    )
    expectProtocolError(
      () => decodePsbt(rawPsbt([QBIT_MAX_MONEY], [QBIT_MAX_MONEY, QBIT_MAX_MONEY])),
      'INVALID_AMOUNT',
      /total input value/
    )
  })

  it('still computes the fee for in-range boundary amounts', () => {
    expect(decodePsbt(rawPsbt([0n], [QBIT_MAX_MONEY])).fee).toBe(QBIT_MAX_MONEY)
    expect(decodePsbt(rawPsbt([QBIT_MAX_MONEY], [QBIT_MAX_MONEY])).fee).toBe(0n)
    expect(decodePsbt(rawPsbt([90_000n], [undefined])).fee).toBeUndefined()
  })
})

describe('transaction version is uint32, as in qbit Core', () => {
  // qbit Core v1.0.0 (7ebcddb6) stores CTransaction::version as uint32_t
  // (primitives/transaction.h:308, inherited from Bitcoin Core 28.0 /
  // bitcoin#29325): createrawtransaction/createpsbt take it as uint32_t and
  // decoderawtransaction/decodepsbt report it unsigned. The pre-28 int32 idiom
  // `-1` is therefore spelled 0xffffffff here and must not be a second spelling.
  const leafHash = LEAF_HASH
  const INT32_MIN = -(2 ** 31)
  const INT32_MAX = 2 ** 31 - 1
  const varBytes = (bytes: Uint8Array) => concat(Uint8Array.of(bytes.length), bytes)

  it.each([-1, INT32_MIN])('rejects the int32 spelling %s wherever the version is serialized', value => {
    const range = /^version -\d+ must be an integer in \[0, 4294967295\]$/
    expectProtocolError(() => createP2mrPsbt(psbtParams({ version: value })), 'INVALID_INTEGER', range)
    expectProtocolError(
      () => p2mrSighash({ tx: tx({ version: value }), inputIndex: 0, spentOutputs: spent(), leafHash }),
      'INVALID_INTEGER',
      range
    )
    // Cached midstates do not carry the version, so they cannot smuggle it past the check either.
    expectProtocolError(
      () =>
        p2mrSighash({
          tx: tx({ version: value }),
          inputIndex: 0,
          spentOutputs: spent(),
          leafHash,
          midstates: precomputeSighashMidstates(tx(), spent()),
        }),
      'INVALID_INTEGER',
      range
    )
  })

  it.each([INT32_MAX + 1, UINT32_MAX])('accepts %s, which an int32 rule would reject', value => {
    const parsed = psbtUnsignedTransaction(createP2mrPsbt(psbtParams({ version: value })))
    expect(parsed.version).toBe(value)
    expect(p2mrSighash({ tx: tx({ version: value }), inputIndex: 0, spentOutputs: spent(), leafHash })).toHaveLength(32)
  })

  it('parses a ffffffff version as 4294967295 and re-serializes it byte for byte', () => {
    const raw = rawUnsignedTx([90_000n], 1, UINT32_MAX)
    expect(bytesToHex(raw.subarray(0, 4))).toBe('ffffffff')

    const psbt = parsePsbt(serializePsbt(rawPsbt([90_000n], [100_000n], UINT32_MAX)))
    const parsed = psbtUnsignedTransaction(psbt)
    // Unsigned, exactly as Core's decodepsbt / decoderawtransaction report it.
    expect(parsed.version).toBe(UINT32_MAX)
    expect(decodePsbt(psbt).version).toBe(UINT32_MAX)

    // Feeding the parsed version back in reproduces the original bytes, so
    // parse -> createP2mrPsbt is a lossless round trip with a single spelling.
    const rebuilt = createP2mrPsbt({
      version: parsed.version,
      locktime: parsed.locktime,
      inputs: parsed.inputs.map(input => ({
        prevout: input.prevout,
        sequence: input.sequence,
        witnessUtxo: { value: 100_000n, scriptPubKey: SCRIPT },
        leafScript: new Uint8Array(),
        controlBlock: Uint8Array.of(0xc1),
      })),
      outputs: parsed.outputs,
    })
    expect(bytesToHex(rebuilt.global[0]!.value)).toBe(bytesToHex(raw))
  })

  it('commits version 0xffffffff as the bytes ff ff ff ff (byte-exact against the spec table)', () => {
    const t = tx({ version: UINT32_MAX })
    const spentOutputs = spent()
    // packages/protocol/docs/p2mr-sighash.md, fields 1-16 for SIGHASH_DEFAULT with no annex.
    const message = concat(
      Uint8Array.of(0x00), // 1 epoch
      Uint8Array.of(0x00), // 2 hash_type (SIGHASH_DEFAULT)
      hexToBytes('ffffffff'), // 3 tx version, uint32 LE
      rawUint32LE(t.locktime), // 4 tx locktime
      sha256(concat(TXID, rawUint32LE(0))), // 5 sha_prevouts
      sha256(rawInt64LE(100_000n)), // 6 sha_amounts
      sha256(varBytes(SCRIPT)), // 7 sha_scriptpubkeys
      sha256(rawUint32LE(0xfffffffd)), // 8 sha_sequences
      sha256(concat(rawInt64LE(90_000n), varBytes(SCRIPT))), // 9 sha_outputs
      Uint8Array.of(0x02), // 10 spend_type: ext_flag = 1, no annex
      rawUint32LE(0), // 11d input index
      LEAF_HASH, // 14 leaf hash
      Uint8Array.of(0x00), // 15 key_version
      rawUint32LE(0xffffffff) // 16 code-separator position
    )
    const tagHash = sha256(new TextEncoder().encode('P2MRSighash'))
    const expected = sha256(concat(tagHash, tagHash, message))

    expect(bytesToHex(p2mrSighash({ tx: t, inputIndex: 0, spentOutputs, leafHash }))).toBe(bytesToHex(expected))
    // And the same digest whether or not cached midstates are supplied.
    expect(
      bytesToHex(
        p2mrSighash({
          tx: t,
          inputIndex: 0,
          spentOutputs,
          leafHash,
          midstates: precomputeSighashMidstates(t, spentOutputs),
        })
      )
    ).toBe(bytesToHex(expected))
  })
})

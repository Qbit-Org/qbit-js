import { describe, expect, it, vi } from 'vitest'

import {
  P2MR_LEAF_VERSION_V1,
  P2mrPsbtSigningError,
  PQC_SIGNATURE_BYTES,
  PSBT_IN_SIGHASH_TYPE,
  QbitProtocolError,
  SIGHASH_ALL,
  SIGHASH_ANYONECANPAY,
  SIGHASH_DEFAULT,
  SIGHASH_NONE,
  SIGHASH_SINGLE,
  buildControlBlock,
  bytesToHex,
  createP2mrPsbt,
  decodePsbt,
  encodeP2mrPsbtScriptSigField,
  extractP2mrTransaction,
  finalizeP2mrPsbt,
  multiALeafScript,
  p2mrLeafHash,
  p2mrScriptPubKey,
  p2mrSighash,
  parsePsbt,
  psbtUnsignedTransaction,
  serializePsbt,
  signP2mrPsbt,
  singleKeyLeafScript,
  validateP2mrSigningPlans,
  type P2mrPsbtSignContext,
  type Psbt,
} from '../src/index'

const NONE_ANYONECANPAY = SIGHASH_NONE | SIGHASH_ANYONECANPAY // 0x82
const ALL_ANYONECANPAY = SIGHASH_ALL | SIGHASH_ANYONECANPAY // 0x81
const SINGLE_ANYONECANPAY = SIGHASH_SINGLE | SIGHASH_ANYONECANPAY // 0x83
const NON_DEFAULT_TYPES = [SIGHASH_ALL, SIGHASH_NONE, SIGHASH_SINGLE, ALL_ANYONECANPAY, NONE_ANYONECANPAY, SINGLE_ANYONECANPAY]

const pubkey = Uint8Array.from({ length: 32 }, (_, i) => (i * 7 + 1) & 0xff)
const leafScript = singleKeyLeafScript(pubkey)
const leafHash = p2mrLeafHash(P2MR_LEAF_VERSION_V1, leafScript)
const controlBlock = buildControlBlock(P2MR_LEAF_VERSION_V1, [])
const scriptPubKey = p2mrScriptPubKey(leafHash)
const merchantScriptPubKey = p2mrScriptPubKey(new Uint8Array(32).fill(0x33))
const attackerScriptPubKey = p2mrScriptPubKey(new Uint8Array(32).fill(0x66))
const txid = new Uint8Array(32).fill(9)
const spentOutput = { value: 100_000n, scriptPubKey }

function dummySignature(fill: number): Uint8Array {
  return new Uint8Array(PQC_SIGNATURE_BYTES).fill(fill)
}

function uint32le(value: number): Uint8Array {
  const out = new Uint8Array(4)
  new DataView(out.buffer).setUint32(0, value >>> 0, true)
  return out
}

/** An honest PSBT: 100 000 sat UTXO paying 90 000 sat to a merchant. */
function honestPsbt(): Psbt {
  return createP2mrPsbt({
    inputs: [{ prevout: { txid, vout: 0 }, witnessUtxo: spentOutput, leafScript, controlBlock, merkleRoot: leafHash }],
    outputs: [{ value: 90_000n, scriptPubKey: merchantScriptPubKey }],
  })
}

/** Deep-clone a PSBT and append a raw PSBT_IN_SIGHASH_TYPE record to input 0. */
function withSighashField(psbt: Psbt, value: Uint8Array, key: Uint8Array = Uint8Array.of(PSBT_IN_SIGHASH_TYPE)): Psbt {
  const clone = parsePsbt(serializePsbt(psbt))
  clone.inputs[0]!.push({ key, value })
  return clone
}

function sighashFieldEntries(psbt: Psbt, inputIndex = 0) {
  return psbt.inputs[inputIndex]!.filter(entry => entry.key.length === 1 && entry.key[0] === PSBT_IN_SIGHASH_TYPE)
}

function expectProtocolError(fn: () => unknown, code: QbitProtocolError['code'], message: RegExp): void {
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

describe('decodePsbt reports PSBT_IN_SIGHASH_TYPE', () => {
  it('leaves sighashType undefined when the input has no sighash field', () => {
    expect(decodePsbt(honestPsbt()).inputs[0]!.sighashType).toBeUndefined()
  })

  it.each([SIGHASH_DEFAULT, SIGHASH_ALL, SIGHASH_SINGLE, ALL_ANYONECANPAY, NONE_ANYONECANPAY, SINGLE_ANYONECANPAY])(
    'surfaces sighash type %d as a 4-byte little-endian uint32',
    hashType => {
      const psbt = withSighashField(honestPsbt(), uint32le(hashType))
      expect(decodePsbt(psbt).inputs[0]!.sighashType).toBe(hashType)
      // survives a serialize/parse round trip untouched
      expect(decodePsbt(parsePsbt(serializePsbt(psbt))).inputs[0]!.sighashType).toBe(hashType)
    }
  )

  it.each([
    ['empty', new Uint8Array()],
    ['1 byte', Uint8Array.of(NONE_ANYONECANPAY)],
    ['3 bytes', Uint8Array.of(NONE_ANYONECANPAY, 0, 0)],
    ['5 bytes', Uint8Array.of(NONE_ANYONECANPAY, 0, 0, 0, 0)],
  ])('rejects a sighash field whose value is %s', (_label, value) => {
    expectProtocolError(() => decodePsbt(withSighashField(honestPsbt(), value)), 'INVALID_PSBT', /4-byte little-endian uint32/)
  })

  it.each([0x04, 0x1f, 0x7f, 0x80, 0x84, 0xff, 0x100, 0x1_0082, 0xffff_ffff])(
    'rejects an out-of-range sighash type %d instead of misreading it',
    hashType => {
      expectProtocolError(
        () => decodePsbt(withSighashField(honestPsbt(), uint32le(hashType))),
        'INVALID_PSBT',
        /not a valid P2MR sighash type/
      )
    }
  )

  it('rejects a sighash key that carries extra key data (Core: key must be the type byte alone)', () => {
    expectProtocolError(
      () => decodePsbt(withSighashField(honestPsbt(), uint32le(SIGHASH_DEFAULT), Uint8Array.of(PSBT_IN_SIGHASH_TYPE, 0x01))),
      'INVALID_PSBT',
      /single type byte/
    )
  })
})

describe('non-default sighash types require an explicit opt-in', () => {
  it.each(NON_DEFAULT_TYPES)('refuses to sign with %d unless allowNonDefaultSighash is true', hashType => {
    const signer = vi.fn(() => dummySignature(1))
    const keys = [{ inputIndex: 0, pubkey, leafHash, hashType }]
    expectProtocolError(
      () => signP2mrPsbt({ psbt: honestPsbt(), keys, sign: signer }),
      'INVALID_SIGHASH',
      /requires allowNonDefaultSighash: true/
    )
    expectProtocolError(
      () => signP2mrPsbt({ psbt: honestPsbt(), keys, sign: signer, allowNonDefaultSighash: false }),
      'INVALID_SIGHASH',
      /requires allowNonDefaultSighash: true/
    )
    expect(signer).not.toHaveBeenCalled()
    // the side-effect-free preflight applies the same gate
    expectProtocolError(
      () => validateP2mrSigningPlans({ psbt: honestPsbt(), keys }),
      'INVALID_SIGHASH',
      /requires allowNonDefaultSighash: true/
    )
    expect(() => validateP2mrSigningPlans({ psbt: honestPsbt(), keys, allowNonDefaultSighash: true })).not.toThrow()
  })

  it('only a literal true opts in', () => {
    const signer = vi.fn(() => dummySignature(1))
    const keys = [{ inputIndex: 0, pubkey, leafHash, hashType: NONE_ANYONECANPAY }]
    for (const truthy of [1, 'true', {}, []] as unknown[]) {
      expectProtocolError(
        () =>
          signP2mrPsbt({ psbt: honestPsbt(), keys, sign: signer, allowNonDefaultSighash: truthy as boolean }),
        'INVALID_SIGHASH',
        /requires allowNonDefaultSighash: true/
      )
    }
    expect(signer).not.toHaveBeenCalled()
  })

  it.each([undefined, SIGHASH_DEFAULT])('signs SIGHASH_DEFAULT (hashType %s) without an opt-in', hashType => {
    const psbt = honestPsbt()
    const keys = hashType === undefined ? [{ inputIndex: 0, pubkey, leafHash }] : [{ inputIndex: 0, pubkey, leafHash, hashType }]
    const { psbt: signed, signed: signers } = signP2mrPsbt({ psbt, keys, sign: () => dummySignature(2) })
    expect(signers).toHaveLength(1)
    const input = decodePsbt(signed).inputs[0]!
    expect(input.scriptSigs[0]!.signature.hashType).toBe(SIGHASH_DEFAULT)
    expect(input.scriptSigs[0]!.signature.explicitHashType).toBe(false)
    // SIGHASH_DEFAULT is never written to PSBT_IN_SIGHASH_TYPE (mirrors Core)
    expect(input.sighashType).toBeUndefined()
    expect(sighashFieldEntries(signed)).toHaveLength(0)
  })

  it('signs a non-default type once opted in and records it in PSBT_IN_SIGHASH_TYPE', () => {
    const psbt = honestPsbt()
    const signer = vi.fn(() => dummySignature(3))
    const { psbt: signed } = signP2mrPsbt({
      psbt,
      keys: [{ inputIndex: 0, pubkey, leafHash, hashType: NONE_ANYONECANPAY }],
      sign: signer,
      allowNonDefaultSighash: true,
    })
    expect(signer).toHaveBeenCalledTimes(1)
    const input = decodePsbt(signed).inputs[0]!
    expect(input.scriptSigs).toHaveLength(1)
    expect(input.scriptSigs[0]!.signature.hashType).toBe(NONE_ANYONECANPAY)
    expect(input.scriptSigs[0]!.signature.explicitHashType).toBe(true)
    expect(input.sighashType).toBe(NONE_ANYONECANPAY)
    const fields = sighashFieldEntries(signed)
    expect(fields).toHaveLength(1)
    expect(bytesToHex(fields[0]!.value)).toBe('82000000')
    // the original PSBT is untouched
    expect(decodePsbt(psbt).inputs[0]!.sighashType).toBeUndefined()
    expect(decodePsbt(psbt).inputs[0]!.scriptSigs).toHaveLength(0)
  })

  it.each([-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, 0x04, 0x7f, 0x80, 0x84, 0x100])(
    'rejects an invalid plan sighash type %s even with the opt-in',
    hashType => {
      const signer = vi.fn(() => dummySignature(1))
      expectProtocolError(
        () =>
          signP2mrPsbt({
            psbt: honestPsbt(),
            keys: [{ inputIndex: 0, pubkey, leafHash, hashType }],
            sign: signer,
            allowNonDefaultSighash: true,
          }),
        'INVALID_SIGHASH',
        /invalid P2MR signing plan sighash type/
      )
      expect(signer).not.toHaveBeenCalled()
    }
  )
})

describe('PSBT_IN_SIGHASH_TYPE is enforced like Core SIGHASH_MISMATCH', () => {
  it('refuses a default-type plan when the PSBT demands NONE|ANYONECANPAY', () => {
    const signer = vi.fn(() => dummySignature(1))
    const psbt = withSighashField(honestPsbt(), uint32le(NONE_ANYONECANPAY))
    expectProtocolError(
      () => signP2mrPsbt({ psbt, keys: [{ inputIndex: 0, pubkey, leafHash }], sign: signer }),
      'INVALID_SIGHASH',
      /PSBT_IN_SIGHASH_TYPE 0x82 does not match the signing plan sighash type 0x00/
    )
    expectProtocolError(
      () => validateP2mrSigningPlans({ psbt, keys: [{ inputIndex: 0, pubkey, leafHash }] }),
      'INVALID_SIGHASH',
      /PSBT_IN_SIGHASH_TYPE 0x82 does not match/
    )
    expect(signer).not.toHaveBeenCalled()
  })

  it('still requires the opt-in when the PSBT itself asks for a non-default type', () => {
    const signer = vi.fn(() => dummySignature(1))
    const psbt = withSighashField(honestPsbt(), uint32le(NONE_ANYONECANPAY))
    expectProtocolError(
      () =>
        signP2mrPsbt({
          psbt,
          keys: [{ inputIndex: 0, pubkey, leafHash, hashType: NONE_ANYONECANPAY }],
          sign: signer,
        }),
      'INVALID_SIGHASH',
      /requires allowNonDefaultSighash: true/
    )
    expect(signer).not.toHaveBeenCalled()
  })

  it.each([
    [SIGHASH_DEFAULT, SIGHASH_ALL],
    [SIGHASH_ALL, SIGHASH_DEFAULT],
    [ALL_ANYONECANPAY, NONE_ANYONECANPAY],
    [SIGHASH_SINGLE, SINGLE_ANYONECANPAY],
  ])('treats PSBT field %d and plan type %d as a strict mismatch', (fieldType, planType) => {
    const signer = vi.fn(() => dummySignature(1))
    const psbt = withSighashField(honestPsbt(), uint32le(fieldType))
    expectProtocolError(
      () =>
        signP2mrPsbt({
          psbt,
          keys: [{ inputIndex: 0, pubkey, leafHash, hashType: planType }],
          sign: signer,
          allowNonDefaultSighash: true,
        }),
      'INVALID_SIGHASH',
      /PSBT_IN_SIGHASH_TYPE .* does not match the signing plan sighash type/
    )
    expect(signer).not.toHaveBeenCalled()
  })

  it.each([SIGHASH_DEFAULT, SIGHASH_ALL, ALL_ANYONECANPAY, NONE_ANYONECANPAY])(
    'signs when the plan type equals the PSBT field %d and keeps a single field record',
    hashType => {
      const psbt = withSighashField(honestPsbt(), uint32le(hashType))
      const { psbt: signed, signed: signers } = signP2mrPsbt({
        psbt,
        keys: [{ inputIndex: 0, pubkey, leafHash, hashType }],
        sign: () => dummySignature(4),
        allowNonDefaultSighash: true,
      })
      expect(signers).toHaveLength(1)
      const input = decodePsbt(signed).inputs[0]!
      expect(input.sighashType).toBe(hashType)
      expect(input.scriptSigs[0]!.signature.hashType).toBe(hashType)
      expect(sighashFieldEntries(signed)).toHaveLength(1)
      // no duplicate key: the result still serializes and parses
      expect(decodePsbt(parsePsbt(serializePsbt(signed))).inputs[0]!.sighashType).toBe(hashType)
    }
  )

  it('rejects a malformed PSBT_IN_SIGHASH_TYPE before any plan is considered', () => {
    const signer = vi.fn(() => dummySignature(1))
    const psbt = withSighashField(honestPsbt(), Uint8Array.of(0x00))
    expectProtocolError(
      () => signP2mrPsbt({ psbt, keys: [{ inputIndex: 0, pubkey, leafHash }], sign: signer }),
      'INVALID_PSBT',
      /PSBT_IN_SIGHASH_TYPE value must be a 4-byte/
    )
    expect(signer).not.toHaveBeenCalled()
  })
})

describe('an input never ends up with mixed sighash types', () => {
  const secondPubkey = new Uint8Array(32).fill(0x42)
  const multiLeafScript = multiALeafScript(2, [pubkey, secondPubkey])
  const multiLeafHash = p2mrLeafHash(P2MR_LEAF_VERSION_V1, multiLeafScript)

  function multiPsbt(): Psbt {
    return createP2mrPsbt({
      inputs: [
        {
          prevout: { txid, vout: 1 },
          witnessUtxo: { value: 100_000n, scriptPubKey: p2mrScriptPubKey(multiLeafHash) },
          leafScript: multiLeafScript,
          controlBlock,
          merkleRoot: multiLeafHash,
        },
      ],
      outputs: [{ value: 90_000n, scriptPubKey: merchantScriptPubKey }],
    })
  }

  function withExistingSignature(psbt: Psbt, signer: Uint8Array, hashType: number): Psbt {
    const clone = parsePsbt(serializePsbt(psbt))
    clone.inputs[0]!.push(encodeP2mrPsbtScriptSigField(signer, multiLeafHash, dummySignature(0x11), hashType))
    return clone
  }

  it.each([
    [SIGHASH_DEFAULT, NONE_ANYONECANPAY],
    [NONE_ANYONECANPAY, SIGHASH_DEFAULT],
    [SIGHASH_ALL, SIGHASH_DEFAULT],
    [ALL_ANYONECANPAY, NONE_ANYONECANPAY],
  ])('refuses a %d-signed input when the new plan uses %d', (existingType, planType) => {
    const signer = vi.fn(() => dummySignature(1))
    const psbt = withExistingSignature(multiPsbt(), pubkey, existingType)
    expectProtocolError(
      () =>
        signP2mrPsbt({
          psbt,
          keys: [{ inputIndex: 0, pubkey: secondPubkey, leafHash: multiLeafHash, hashType: planType }],
          sign: signer,
          allowNonDefaultSighash: true,
        }),
      'INVALID_SIGHASH',
      /existing P2MR signature uses sighash type .* but the signing plan uses/
    )
    expect(signer).not.toHaveBeenCalled()
  })

  it('refuses two plans for the same input with different types in one call', () => {
    const signer = vi.fn(() => dummySignature(1))
    expectProtocolError(
      () =>
        signP2mrPsbt({
          psbt: multiPsbt(),
          keys: [
            { inputIndex: 0, pubkey, leafHash: multiLeafHash },
            { inputIndex: 0, pubkey: secondPubkey, leafHash: multiLeafHash, hashType: NONE_ANYONECANPAY },
          ],
          sign: signer,
          allowNonDefaultSighash: true,
        }),
      'INVALID_SIGHASH',
      /signing plans for one input must share a sighash type \(0x00 and 0x82\)/
    )
    expect(signer).not.toHaveBeenCalled()
  })

  it('co-signs an input when every signature shares the (opted-in) type', () => {
    const first = signP2mrPsbt({
      psbt: multiPsbt(),
      keys: [{ inputIndex: 0, pubkey, leafHash: multiLeafHash, hashType: ALL_ANYONECANPAY }],
      sign: () => dummySignature(5),
      allowNonDefaultSighash: true,
    }).psbt
    const second = signP2mrPsbt({
      psbt: first,
      keys: [{ inputIndex: 0, pubkey: secondPubkey, leafHash: multiLeafHash, hashType: ALL_ANYONECANPAY }],
      sign: () => dummySignature(6),
      allowNonDefaultSighash: true,
    }).psbt
    const input = decodePsbt(second).inputs[0]!
    expect(input.scriptSigs.map(sig => sig.signature.hashType)).toEqual([ALL_ANYONECANPAY, ALL_ANYONECANPAY])
    expect(input.sighashType).toBe(ALL_ANYONECANPAY)
    expect(sighashFieldEntries(second)).toHaveLength(1)
  })
})

describe('the sign callback can see what it commits to', () => {
  it('receives hashType, the unsigned transaction and the spent outputs', () => {
    const psbt = honestPsbt()
    const contexts: P2mrPsbtSignContext[] = []
    const digests: Uint8Array[] = []
    signP2mrPsbt({
      psbt,
      keys: [{ inputIndex: 0, pubkey, leafHash }],
      sign: (sighash, context) => {
        digests.push(sighash)
        contexts.push(context)
        return dummySignature(7)
      },
    })
    expect(contexts).toHaveLength(1)
    const context = contexts[0]!
    expect(context.inputIndex).toBe(0)
    expect(bytesToHex(context.pubkey)).toBe(bytesToHex(pubkey))
    expect(bytesToHex(context.leafHash)).toBe(bytesToHex(leafHash))
    expect(context.hashType).toBe(SIGHASH_DEFAULT)
    expect(context.tx).toEqual(psbtUnsignedTransaction(psbt))
    expect(context.spentOutputs).toEqual([spentOutput])
    // the digest is the one computed for exactly that tx / spent outputs / hashType
    expect(bytesToHex(digests[0]!)).toBe(
      bytesToHex(p2mrSighash({ tx: context.tx, inputIndex: 0, spentOutputs: context.spentOutputs, leafHash, hashType: context.hashType }))
    )
  })

  it('reports the non-default type so a device can display or refuse it', () => {
    const seen: number[] = []
    signP2mrPsbt({
      psbt: honestPsbt(),
      keys: [{ inputIndex: 0, pubkey, leafHash, hashType: NONE_ANYONECANPAY }],
      sign: (_sighash, context) => {
        seen.push(context.hashType)
        return context.hashType === SIGHASH_DEFAULT ? dummySignature(8) : undefined // device refuses
      },
      allowNonDefaultSighash: true,
    })
    expect(seen).toEqual([NONE_ANYONECANPAY])
  })
})

describe('NONE|ANYONECANPAY digests are output-independent (reproduction)', () => {
  it('blocks the lifted-signature attack by default', () => {
    const honest = honestPsbt()
    const attacker = createP2mrPsbt({
      inputs: [{ prevout: { txid, vout: 0 }, witnessUtxo: spentOutput, leafScript, controlBlock, merkleRoot: leafHash }],
      outputs: [{ value: 100_000n, scriptPubKey: attackerScriptPubKey }],
    })
    const digest = (psbt: Psbt, hashType: number) =>
      bytesToHex(p2mrSighash({ tx: psbtUnsignedTransaction(psbt), inputIndex: 0, spentOutputs: [spentOutput], leafHash, hashType }))
    // under 0x82 the honest and attacker transactions hash identically ...
    expect(digest(honest, NONE_ANYONECANPAY)).toBe(digest(attacker, NONE_ANYONECANPAY))
    // ... while the default type commits to the outputs the user approved
    expect(digest(honest, SIGHASH_DEFAULT)).not.toBe(digest(attacker, SIGHASH_DEFAULT))

    // A wallet that forwards a dApp-requested 0x82 without opting in never reaches the device.
    const device = vi.fn(() => dummySignature(9))
    expectProtocolError(
      () => signP2mrPsbt({ psbt: honest, keys: [{ inputIndex: 0, pubkey, leafHash, hashType: NONE_ANYONECANPAY }], sign: device }),
      'INVALID_SIGHASH',
      /requires allowNonDefaultSighash: true/
    )
    expect(device).not.toHaveBeenCalled()
  })
})

describe('finalizeP2mrPsbt enforces the input sighash type like Core FinalizePSBT', () => {
  /** Honest PSBT carrying one signature of `signatureType` and, optionally, a PSBT_IN_SIGHASH_TYPE field. */
  function signedPsbt(signatureType: number, fieldType?: number): Psbt {
    const psbt = parsePsbt(serializePsbt(honestPsbt()))
    psbt.inputs[0]!.push(encodeP2mrPsbtScriptSigField(pubkey, leafHash, dummySignature(0x21), signatureType))
    if (fieldType !== undefined) psbt.inputs[0]!.push({ key: Uint8Array.of(PSBT_IN_SIGHASH_TYPE), value: uint32le(fieldType) })
    return psbt
  }

  // qbit Core v1.0.0 src/psbt.cpp: FinalizePSBT (:697) re-runs SignPSBTInput with
  // the input's sighash_type; an absent field means SIGHASH_DEFAULT for P2MR
  // (:530) and any explicit P2MR signature type then fails SIGHASH_MISMATCH
  // (:548-568). Core does not finalize these, so neither does the library.
  it.each(NON_DEFAULT_TYPES)(
    'refuses an explicit type %d signature on an input without PSBT_IN_SIGHASH_TYPE (Core psbt.cpp:530,561-568)',
    signatureType => {
      expectProtocolError(
        () => finalizeP2mrPsbt(signedPsbt(signatureType)),
        'INVALID_SIGHASH',
        new RegExp(
          `signature sighash type 0x${signatureType.toString(16).padStart(2, '0')} does not match the input's ` +
            `SIGHASH_DEFAULT implied by the absent PSBT_IN_SIGHASH_TYPE`
        )
      )
    }
  )

  it('finalizes an externally signed non-default input once the matching PSBT_IN_SIGHASH_TYPE record is added', () => {
    // The record Core's own signer writes (psbt.cpp:542-545) is what makes such
    // a PSBT finalizable by Core, and therefore by this library.
    const external = signedPsbt(NONE_ANYONECANPAY)
    expectProtocolError(() => finalizeP2mrPsbt(external), 'INVALID_SIGHASH', /absent PSBT_IN_SIGHASH_TYPE/)
    const withField = withSighashField(external, uint32le(NONE_ANYONECANPAY))
    const finalized = finalizeP2mrPsbt(withField)
    expect(decodePsbt(finalized).inputs[0]!.finalized).toBe(true)
    expect(bytesToHex(extractP2mrTransaction(finalized))).toContain(bytesToHex(dummySignature(0x21)) + '82')
  })

  // Field present and differing: SignPSBTInput's per-signature check for a
  // non-DEFAULT sighash (psbt.cpp:589-596) returns SIGHASH_MISMATCH.
  it('refuses a default-type signature when the input demands NONE|ANYONECANPAY (Core psbt.cpp:589-596)', () => {
    expectProtocolError(
      () => finalizeP2mrPsbt(signedPsbt(SIGHASH_DEFAULT, NONE_ANYONECANPAY)),
      'INVALID_SIGHASH',
      /signature sighash type 0x00 does not match the input's PSBT_IN_SIGHASH_TYPE 0x82/
    )
  })

  it.each([
    [SIGHASH_ALL, SIGHASH_DEFAULT],
    [SIGHASH_DEFAULT, SIGHASH_ALL],
    [ALL_ANYONECANPAY, NONE_ANYONECANPAY],
    [SIGHASH_SINGLE, SINGLE_ANYONECANPAY],
  ])('treats field %d and signature %d as a strict mismatch', (fieldType, signatureType) => {
    expectProtocolError(
      () => finalizeP2mrPsbt(signedPsbt(signatureType, fieldType)),
      'INVALID_SIGHASH',
      /signature sighash type .* does not match the input's PSBT_IN_SIGHASH_TYPE/
    )
  })

  it.each([SIGHASH_DEFAULT, SIGHASH_ALL, ALL_ANYONECANPAY, NONE_ANYONECANPAY, SINGLE_ANYONECANPAY])(
    'finalizes a signature of type %d that matches the field and keeps the explicit type byte',
    hashType => {
      const finalized = finalizeP2mrPsbt(signedPsbt(hashType, hashType))
      expect(decodePsbt(finalized).inputs[0]!.finalized).toBe(true)
      const rawTx = bytesToHex(extractP2mrTransaction(finalized))
      const witnessItem = bytesToHex(dummySignature(0x21)) + (hashType === SIGHASH_DEFAULT ? '' : hashType.toString(16).padStart(2, '0'))
      expect(rawTx).toContain(witnessItem)
    }
  )

  it('finalizes signP2mrPsbt output for an opted-in type end to end', () => {
    const { psbt: signed } = signP2mrPsbt({
      psbt: honestPsbt(),
      keys: [{ inputIndex: 0, pubkey, leafHash, hashType: ALL_ANYONECANPAY }],
      sign: () => dummySignature(0x22),
      allowNonDefaultSighash: true,
    })
    const finalized = finalizeP2mrPsbt(signed)
    expect(decodePsbt(finalized).inputs[0]!.finalized).toBe(true)
    expect(bytesToHex(extractP2mrTransaction(finalized))).toContain(bytesToHex(dummySignature(0x22)) + '81')
  })

  it('still finalizes a default-type signature on an input without the field', () => {
    expect(decodePsbt(finalizeP2mrPsbt(signedPsbt(SIGHASH_DEFAULT))).inputs[0]!.finalized).toBe(true)
  })
})

describe('each sign callback receives its own copy of tx and spentOutputs', () => {
  it('a callback that mutates its context cannot change what later callbacks see', () => {
    const secondPubkey = new Uint8Array(32).fill(0x42)
    const multiLeafScript = multiALeafScript(2, [pubkey, secondPubkey])
    const multiLeafHash = p2mrLeafHash(P2MR_LEAF_VERSION_V1, multiLeafScript)
    const multiSpent = { value: 100_000n, scriptPubKey: p2mrScriptPubKey(multiLeafHash) }
    const psbt = createP2mrPsbt({
      inputs: [{ prevout: { txid, vout: 1 }, witnessUtxo: multiSpent, leafScript: multiLeafScript, controlBlock, merkleRoot: multiLeafHash }],
      outputs: [{ value: 90_000n, scriptPubKey: merchantScriptPubKey }],
    })
    const expectedTx = psbtUnsignedTransaction(psbt)
    const expectedDigest = bytesToHex(
      p2mrSighash({ tx: expectedTx, inputIndex: 0, spentOutputs: [multiSpent], leafHash: multiLeafHash, hashType: SIGHASH_DEFAULT })
    )
    const seen: P2mrPsbtSignContext[] = []
    const digests: string[] = []
    const { psbt: signed } = signP2mrPsbt({
      psbt,
      keys: [
        { inputIndex: 0, pubkey, leafHash: multiLeafHash },
        { inputIndex: 0, pubkey: secondPubkey, leafHash: multiLeafHash },
      ],
      sign: (sighash, context) => {
        seen.push(context)
        digests.push(bytesToHex(sighash))
        if (seen.length === 1) {
          // a hostile or buggy first callback tampers with everything it was handed
          context.tx.outputs[0]!.value = 1n
          context.tx.outputs[0]!.scriptPubKey[0] = 0xff
          context.tx.inputs[0]!.prevout.txid[0] = 0xff
          context.spentOutputs[0]!.value = 1n
          context.spentOutputs[0]!.scriptPubKey[0] = 0xff
        }
        return dummySignature(0x31)
      },
    })
    expect(seen).toHaveLength(2)
    // the second callback saw pristine data, not the first callback's edits
    expect(seen[1]!.tx).toEqual(expectedTx)
    expect(seen[1]!.spentOutputs).toEqual([multiSpent])
    expect(seen[1]!.tx).not.toBe(seen[0]!.tx)
    expect(seen[1]!.spentOutputs).not.toBe(seen[0]!.spentOutputs)
    expect(digests).toEqual([expectedDigest, expectedDigest])
    // the tampering never reached the signed PSBT
    expect(psbtUnsignedTransaction(signed)).toEqual(expectedTx)
    expect(decodePsbt(signed).inputs[0]!.witnessUtxo).toEqual(multiSpent)
  })
})

describe('non-default sighash types on the crash-safe signing path', () => {
  function signingError(fn: () => unknown): P2mrPsbtSigningError {
    try {
      fn()
    } catch (error) {
      expect(error).toBeInstanceOf(P2mrPsbtSigningError)
      return error as P2mrPsbtSigningError
    }
    throw new Error('expected signP2mrPsbt to throw')
  }

  it('stores PSBT_IN_SIGHASH_TYPE with the signature, so a failed onSigned keeps both in the error PSBT', () => {
    const error = signingError(() =>
      signP2mrPsbt({
        psbt: honestPsbt(),
        keys: [{ inputIndex: 0, pubkey, leafHash, hashType: NONE_ANYONECANPAY }],
        sign: () => dummySignature(0x44),
        onSigned: () => {
          throw new Error('keyring offline')
        },
        allowNonDefaultSighash: true,
      })
    )
    expect(error.phase).toBe('onSigned')
    const input = decodePsbt(error.psbt).inputs[0]!
    expect(input.scriptSigs).toHaveLength(1)
    expect(input.scriptSigs[0]!.signature.hashType).toBe(NONE_ANYONECANPAY)
    expect(input.sighashType).toBe(NONE_ANYONECANPAY)
    // the partially signed PSBT is complete enough to finalize as Core would
    expect(decodePsbt(finalizeP2mrPsbt(error.psbt)).inputs[0]!.finalized).toBe(true)
  })

  it('hands onSigned the 0x19 record and the signer its full context for a non-default type', () => {
    const contexts: P2mrPsbtSignContext[] = []
    const events: { key: Uint8Array; value: Uint8Array }[] = []
    signP2mrPsbt({
      psbt: honestPsbt(),
      keys: [{ inputIndex: 0, pubkey, leafHash, hashType: ALL_ANYONECANPAY }],
      sign: (_sighash, context) => {
        contexts.push(context)
        return dummySignature(0x45)
      },
      onSigned: event => {
        events.push(event.field)
      },
      allowNonDefaultSighash: true,
    })
    expect(contexts).toHaveLength(1)
    expect(contexts[0]).toMatchObject({ inputIndex: 0, pubkey, leafHash, hashType: ALL_ANYONECANPAY })
    expect(contexts[0]!.tx).toEqual(psbtUnsignedTransaction(honestPsbt()))
    expect(contexts[0]!.spentOutputs).toEqual([spentOutput])
    expect(events).toHaveLength(1)
    expect(bytesToHex(events[0]!.value)).toBe(bytesToHex(dummySignature(0x45)) + '81')
  })

  it('fails an async signer on a non-default plan without storing either record', async () => {
    const rejections: unknown[] = []
    const onUnhandled = (reason: unknown) => rejections.push(reason)
    process.on('unhandledRejection', onUnhandled)
    try {
      const error = signingError(() =>
        signP2mrPsbt({
          psbt: honestPsbt(),
          keys: [{ inputIndex: 0, pubkey, leafHash, hashType: NONE_ANYONECANPAY }],
          sign: (async () => {
            throw new Error('device')
          }) as never,
          allowNonDefaultSighash: true,
        })
      )
      expect(error.phase).toBe('sign')
      expect((error.cause as QbitProtocolError).code).toBe('INVALID_SIGNER')
      expect(decodePsbt(error.psbt).inputs[0]!.scriptSigs).toHaveLength(0)
      expect(sighashFieldEntries(error.psbt)).toHaveLength(0)
      await new Promise(resolve => setTimeout(resolve, 10))
      expect(rejections).toEqual([])
    } finally {
      process.off('unhandledRejection', onUnhandled)
    }
  })
})

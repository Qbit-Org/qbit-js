import { runInNewContext } from 'node:vm'

import { describe, expect, it, vi } from 'vitest'

import type { P2mrPsbtOnSignedFn, P2mrPsbtSignFn, P2mrSigningKey, P2mrSigningPlanRef } from '../src/index'
import {
  P2MR_LEAF_VERSION_V1,
  PQC_SIGNATURE_BYTES,
  P2mrPsbtSigningError,
  QbitProtocolError,
  buildControlBlock,
  bytesToHex,
  createP2mrPsbt,
  decodeP2mrPsbtScriptSigField,
  decodePsbt,
  extractP2mrTransaction,
  finalizeP2mrPsbt,
  p2mrLeafHash,
  p2mrScriptPubKey,
  parsePsbt,
  serializePsbt,
  signP2mrPsbt,
  singleKeyLeafScript,
} from '../src/index'

// Three single-key inputs with one key each, mirroring the hardware-wallet
// scenario this guards: the device approves inputs 0 and 1, then fails on input 2.
const keys = Array.from({ length: 3 }, (_, index) => {
  const pubkey = Uint8Array.from({ length: 32 }, (_, i) => (i * 11 + index + 1) & 0xff)
  const leafScript = singleKeyLeafScript(pubkey)
  const leafHash = p2mrLeafHash(P2MR_LEAF_VERSION_V1, leafScript)
  return { pubkey, leafScript, leafHash, scriptPubKey: p2mrScriptPubKey(leafHash) }
})
const controlBlock = buildControlBlock(P2MR_LEAF_VERSION_V1, [])
const psbt = createP2mrPsbt({
  inputs: keys.map((key, index) => ({
    prevout: { txid: new Uint8Array(32).fill(index + 1), vout: index },
    witnessUtxo: { value: 50_000n, scriptPubKey: key.scriptPubKey },
    leafScript: key.leafScript,
    controlBlock,
    merkleRoot: key.leafHash,
  })),
  outputs: [{ value: 140_000n, scriptPubKey: keys[0]!.scriptPubKey }],
})
const plans: P2mrSigningKey[] = keys.map((key, inputIndex) => ({
  inputIndex,
  pubkey: key.pubkey,
  leafHash: key.leafHash,
}))
const hex = bytesToHex
const signatureFor = (inputIndex: number): Uint8Array => new Uint8Array(PQC_SIGNATURE_BYTES).fill(0x10 + inputIndex)
/** Builds a value in a separate realm, so it fails this realm's `instanceof`. */
const inAnotherRealm = <T>(expression: string): T => runInNewContext(expression) as T
const samePlan = (a: P2mrSigningPlanRef, b: P2mrSigningPlanRef): boolean =>
  a.inputIndex === b.inputIndex && hex(a.pubkey) === hex(b.pubkey) && hex(a.leafHash) === hex(b.leafHash)

function storedSignatures(target: Parameters<typeof decodePsbt>[0]): (string | undefined)[] {
  return decodePsbt(target).inputs.map(input => {
    expect(input.scriptSigs.length).toBeLessThanOrEqual(1)
    return input.scriptSigs[0] === undefined ? undefined : hex(input.scriptSigs[0].signature.signature)
  })
}

function captureFailure(run: () => unknown): P2mrPsbtSigningError {
  let thrown: unknown
  try {
    run()
  } catch (error) {
    thrown = error
  }
  expect(thrown).toBeInstanceOf(P2mrPsbtSigningError)
  return thrown as P2mrPsbtSigningError
}

/** Signs inputs 0 and 1, then the device drops on input 2. */
function signUntilInputTwoFails(): { failure: P2mrPsbtSigningError; sighashes: Map<number, string> } {
  const sighashes = new Map<number, string>()
  const failure = captureFailure(() =>
    signP2mrPsbt({
      psbt,
      keys: plans,
      sign: (sighash, ctx) => {
        sighashes.set(ctx.inputIndex, hex(sighash))
        if (ctx.inputIndex === 2) throw new Error('USB device disconnected')
        return signatureFor(ctx.inputIndex)
      },
    })
  )
  return { failure, sighashes }
}

describe('signP2mrPsbt preserves partial progress', () => {
  it('keeps earlier signatures when the signer throws on a later plan', () => {
    const { failure } = signUntilInputTwoFails()

    expect(failure).toBeInstanceOf(QbitProtocolError)
    expect(failure.name).toBe('P2mrPsbtSigningError')
    expect(failure.code).toBe('SIGNING_FAILED')
    expect(failure.message).toMatch(
      /^input 2: P2MR signing failed in sign after 2 signature\(s\): USB device disconnected$/
    )
    expect(failure.phase).toBe('sign')
    expect(failure.cause).toBeInstanceOf(Error)
    expect((failure.cause as Error).message).toBe('USB device disconnected')

    expect(failure.signed).toEqual([plans[0], plans[1]])
    expect(failure.failed).toEqual(plans[2])
    expect(storedSignatures(failure.psbt)).toEqual([hex(signatureFor(0)), hex(signatureFor(1)), undefined])
  })

  it('keeps plan 0 when plan 1 returns a wrong-length signature and never reaches plan 2', () => {
    const signer = vi.fn((_sighash: Uint8Array, ctx: { inputIndex: number }) =>
      ctx.inputIndex === 0 ? signatureFor(0) : new Uint8Array(10)
    )
    const failure = captureFailure(() => signP2mrPsbt({ psbt, keys: plans, sign: signer }))

    expect(signer).toHaveBeenCalledTimes(2)
    expect(failure.signed).toEqual([plans[0]])
    expect(failure.failed).toEqual(plans[1])
    expect(failure.cause).toBeInstanceOf(QbitProtocolError)
    expect((failure.cause as QbitProtocolError).code).toBe('INVALID_BYTES')
    expect(failure.phase).toBe('sign')
    expect(failure.message).toMatch(
      /input 1: P2MR signing failed in sign after 1 signature\(s\): PQC signature must be 3680 bytes/
    )
    expect(storedSignatures(failure.psbt)).toEqual([hex(signatureFor(0)), undefined, undefined])
  })

  it('reports nothing signed and an unmodified PSBT when the first plan fails', () => {
    const signer = vi.fn(() => {
      throw new Error('rejected on device')
    })
    const failure = captureFailure(() => signP2mrPsbt({ psbt, keys: plans, sign: signer }))

    expect(signer).toHaveBeenCalledTimes(1)
    expect(failure.phase).toBe('sign')
    expect(failure.signed).toEqual([])
    expect(failure.failed).toEqual(plans[0])
    expect(hex(serializePsbt(failure.psbt))).toBe(hex(serializePsbt(psbt)))
  })

  it('describes a non-Error throw without losing the partial result', () => {
    const failure = captureFailure(() =>
      signP2mrPsbt({
        psbt,
        keys: plans,
        sign: (_sighash, ctx) => {
          if (ctx.inputIndex === 1) throw 'device busy'
          return signatureFor(ctx.inputIndex)
        },
      })
    )
    expect(failure.cause).toBe('device busy')
    expect(failure.message).toMatch(/after 1 signature\(s\): device busy$/)
    expect(failure.signed).toEqual([plans[0]])
  })

  it('still rejects invalid plans up front as a plain QbitProtocolError with no partial state', () => {
    const signer = vi.fn(() => signatureFor(0))
    let thrown: unknown
    try {
      signP2mrPsbt({ psbt, keys: [plans[0]!, { ...plans[1]!, inputIndex: 9 }], sign: signer })
    } catch (error) {
      thrown = error
    }
    expect(thrown).toBeInstanceOf(QbitProtocolError)
    expect(thrown).not.toBeInstanceOf(P2mrPsbtSigningError)
    expect(signer).not.toHaveBeenCalled()
  })
})

describe('signP2mrPsbt onSigned callback', () => {
  it('fires after each signature is stored and before the next signer call', () => {
    const log: string[] = []
    const events: Parameters<NonNullable<Parameters<typeof signP2mrPsbt>[0]['onSigned']>>[0][] = []
    const { psbt: signedPsbt, signed } = signP2mrPsbt({
      psbt,
      keys: plans,
      sign: (_sighash, ctx) => {
        log.push(`sign:${ctx.inputIndex}`)
        return signatureFor(ctx.inputIndex)
      },
      onSigned: event => {
        log.push(`onSigned:${event.inputIndex}`)
        events.push(event)
      },
    })

    expect(log).toEqual(['sign:0', 'onSigned:0', 'sign:1', 'onSigned:1', 'sign:2', 'onSigned:2'])
    expect(signed).toEqual(plans)
    expect(events).toHaveLength(3)
    events.forEach((event, index) => {
      expect(event.inputIndex).toBe(index)
      expect(hex(event.pubkey)).toBe(hex(keys[index]!.pubkey))
      expect(hex(event.leafHash)).toBe(hex(keys[index]!.leafHash))
      const decoded = decodeP2mrPsbtScriptSigField(event.field.key, event.field.value)
      expect(hex(decoded.pubkey)).toBe(hex(keys[index]!.pubkey))
      expect(hex(decoded.leafHash)).toBe(hex(keys[index]!.leafHash))
      expect(hex(decoded.signature.signature)).toBe(hex(signatureFor(index)))
      expect(decoded.signature.hashType).toBe(0)
      const stored = signedPsbt.inputs[index]!.find(entry => hex(entry.key) === hex(event.field.key))
      expect(stored).toBeDefined()
      expect(hex(stored!.value)).toBe(hex(event.field.value))
    })
  })

  it('skips declined plans and reports exactly the plans that were signed', () => {
    const seen: number[] = []
    const { signed } = signP2mrPsbt({
      psbt,
      keys: plans,
      sign: (_sighash, ctx) => (ctx.inputIndex === 1 ? undefined : signatureFor(ctx.inputIndex)),
      onSigned: event => {
        seen.push(event.inputIndex)
      },
    })
    expect(seen).toEqual([0, 2])
    expect(signed).toEqual([plans[0], plans[2]])
  })

  it('has already delivered every completed signature when a later plan fails', () => {
    const seen: number[] = []
    const failure = captureFailure(() =>
      signP2mrPsbt({
        psbt,
        keys: plans,
        sign: (_sighash, ctx) => {
          if (ctx.inputIndex === 2) throw new Error('USB device disconnected')
          return signatureFor(ctx.inputIndex)
        },
        onSigned: event => {
          seen.push(event.inputIndex)
        },
      })
    )
    expect(seen).toEqual([0, 1])
    expect(failure.signed.map(plan => plan.inputIndex)).toEqual(seen)
  })

  it('wraps an onSigned failure without dropping the signature it was reporting', () => {
    const signer = vi.fn((_sighash: Uint8Array, ctx: { inputIndex: number }) => signatureFor(ctx.inputIndex))
    const failure = captureFailure(() =>
      signP2mrPsbt({
        psbt,
        keys: plans,
        sign: signer,
        onSigned: event => {
          if (event.inputIndex === 1) throw new Error('counter store unavailable')
        },
      })
    )

    expect(signer).toHaveBeenCalledTimes(2)
    expect(failure.phase).toBe('onSigned')
    expect((failure.cause as Error).message).toBe('counter store unavailable')
    expect(failure.failed).toEqual(plans[1])
    expect(failure.signed).toEqual([plans[0], plans[1]])
    expect(storedSignatures(failure.psbt)).toEqual([hex(signatureFor(0)), hex(signatureFor(1)), undefined])
  })

  it('gives the callback copies, so mutating the event cannot corrupt the result', () => {
    const { psbt: signedPsbt, signed } = signP2mrPsbt({
      psbt,
      keys: [plans[0]!],
      sign: () => signatureFor(0),
      onSigned: event => {
        event.pubkey.fill(0)
        event.leafHash.fill(0)
        event.field.key.fill(0)
        event.field.value.fill(0)
      },
    })
    expect(storedSignatures(signedPsbt)).toEqual([hex(signatureFor(0)), undefined, undefined])
    expect(signed).toEqual([plans[0]])
  })
})

describe('signP2mrPsbt retry with a partially signed PSBT', () => {
  it('refuses to resubmit already-signed plans before invoking the signer', () => {
    const { failure } = signUntilInputTwoFails()
    const signer = vi.fn(() => signatureFor(2))

    expect(() => signP2mrPsbt({ psbt: failure.psbt, keys: plans, sign: signer })).toThrow(
      /input 0: signing plan already has a P2MR signature/
    )
    expect(signer).not.toHaveBeenCalled()
  })

  it('resumes with only the unsigned plans, signs the same digest, and completes the spend', () => {
    const { failure, sighashes } = signUntilInputTwoFails()
    const remaining = plans.filter(plan => !failure.signed.some(done => samePlan(done, plan)))
    expect(remaining).toEqual([plans[2]])

    const signer = vi.fn((sighash: Uint8Array, ctx: { inputIndex: number }) => {
      expect(hex(sighash)).toBe(sighashes.get(ctx.inputIndex))
      return signatureFor(ctx.inputIndex)
    })
    const resumed = signP2mrPsbt({ psbt: failure.psbt, keys: remaining, sign: signer })

    expect(signer).toHaveBeenCalledTimes(1)
    expect(signer.mock.calls[0]![1].inputIndex).toBe(2)
    expect(resumed.signed).toEqual([plans[2]])
    expect(storedSignatures(resumed.psbt)).toEqual([hex(signatureFor(0)), hex(signatureFor(1)), hex(signatureFor(2))])

    const rawTx = hex(extractP2mrTransaction(finalizeP2mrPsbt(resumed.psbt)))
    for (const inputIndex of [0, 1, 2]) {
      expect(rawTx).toContain(hex(signatureFor(inputIndex)))
    }
  })
})

describe('signP2mrPsbt signer and callback boundary checks', () => {
  function captureUsageError(run: () => unknown): QbitProtocolError {
    let thrown: unknown
    try {
      run()
    } catch (error) {
      thrown = error
    }
    expect(thrown).toBeInstanceOf(QbitProtocolError)
    expect(thrown).not.toBeInstanceOf(P2mrPsbtSigningError)
    return thrown as QbitProtocolError
  }

  it('rejects a non-function sign before validating plans or signing anything', () => {
    const error = captureUsageError(() =>
      signP2mrPsbt({ psbt, keys: plans, sign: 'sign-me' as unknown as P2mrPsbtSignFn })
    )
    expect(error.code).toBe('INVALID_SIGNER')
    expect(error.message).toMatch(/sign must be a function/)
  })

  it('rejects a non-function onSigned without invoking the signer', () => {
    const signer = vi.fn(() => signatureFor(0))
    const error = captureUsageError(() =>
      signP2mrPsbt({ psbt, keys: plans, sign: signer, onSigned: {} as unknown as P2mrPsbtOnSignedFn })
    )
    expect(error.code).toBe('INVALID_SIGNER')
    expect(error.message).toMatch(/onSigned must be a function/)
    expect(signer).not.toHaveBeenCalled()
  })

  const bogusSignatures: [string, unknown][] = [
    ['a string', 'not-a-signature'],
    ['a number[] of the right length', Array.from({ length: PQC_SIGNATURE_BYTES }, () => 1)],
    ['an ArrayBuffer of the right length', new ArrayBuffer(PQC_SIGNATURE_BYTES)],
    ['a DataView of the right length', new DataView(new ArrayBuffer(PQC_SIGNATURE_BYTES))],
    ['an Int8Array of the right length', new Int8Array(PQC_SIGNATURE_BYTES)],
    ['an Int8Array from another realm', inAnotherRealm(`new Int8Array(${PQC_SIGNATURE_BYTES})`)],
    ['a DataView from another realm', inAnotherRealm(`new DataView(new ArrayBuffer(${PQC_SIGNATURE_BYTES}))`)],
    [
      'a plain object that only claims to be a Uint8Array',
      { length: PQC_SIGNATURE_BYTES, [Symbol.toStringTag]: 'Uint8Array' },
    ],
  ]

  it.each(bogusSignatures)('rejects %s returned by sign and stores nothing for that plan', (_label, bogus) => {
    const signer = vi.fn(
      (_sighash: Uint8Array, ctx: { inputIndex: number }) =>
        (ctx.inputIndex === 0 ? signatureFor(0) : bogus) as Uint8Array
    )
    const failure = captureFailure(() => signP2mrPsbt({ psbt, keys: plans, sign: signer }))

    expect(signer).toHaveBeenCalledTimes(2)
    expect(failure.phase).toBe('sign')
    expect(failure.failed).toEqual(plans[1])
    expect(failure.signed).toEqual([plans[0]])
    expect(failure.cause).toBeInstanceOf(QbitProtocolError)
    expect((failure.cause as QbitProtocolError).code).toBe('INVALID_SIGNER')
    expect((failure.cause as QbitProtocolError).message).toMatch(/sign must return a Uint8Array/)
    expect(storedSignatures(failure.psbt)).toEqual([hex(signatureFor(0)), undefined, undefined])
  })
})

describe('signP2mrPsbt rejects an asynchronous onSigned', () => {
  async function expectAsyncCallbackFailure(onSigned: P2mrPsbtOnSignedFn): Promise<void> {
    const unhandled: unknown[] = []
    const record = (reason: unknown): void => {
      unhandled.push(reason)
    }
    process.on('unhandledRejection', record)
    try {
      const signer = vi.fn((_sighash: Uint8Array, ctx: { inputIndex: number }) => signatureFor(ctx.inputIndex))
      const failure = captureFailure(() => signP2mrPsbt({ psbt, keys: plans, sign: signer, onSigned }))

      // Signing stopped before the next signer call, and the signature the
      // callback was reporting is still stored and listed.
      expect(signer).toHaveBeenCalledTimes(1)
      expect(failure.phase).toBe('onSigned')
      expect(failure.failed).toEqual(plans[0])
      expect(failure.signed).toEqual([plans[0]])
      expect(storedSignatures(failure.psbt)).toEqual([hex(signatureFor(0)), undefined, undefined])
      expect(failure.cause).toBeInstanceOf(QbitProtocolError)
      expect((failure.cause as QbitProtocolError).code).toBe('INVALID_SIGNER')
      expect((failure.cause as QbitProtocolError).message).toMatch(/onSigned must be synchronous/)
      expect(failure.message).toMatch(/failed in onSigned after 1 signature\(s\): onSigned must be synchronous/)

      // Let the returned promise settle: its rejection must not leak.
      await new Promise(resolve => setTimeout(resolve, 0))
      expect(unhandled).toEqual([])
    } finally {
      process.off('unhandledRejection', record)
    }
  }

  it('fails the plan when onSigned returns a promise that resolves', async () => {
    await expectAsyncCallbackFailure((async () => {}) as unknown as P2mrPsbtOnSignedFn)
  })

  it('fails the plan and swallows the rejection when onSigned returns a promise that rejects', async () => {
    await expectAsyncCallbackFailure((async () => {
      throw new Error('persist failed')
    }) as unknown as P2mrPsbtOnSignedFn)
  })

  it('treats a non-Promise thenable the same way', async () => {
    const thenable = {
      then(_onFulfilled: unknown, onRejected: (reason: unknown) => void): void {
        onRejected(new Error('persist failed'))
      },
    }
    await expectAsyncCallbackFailure((() => thenable) as unknown as P2mrPsbtOnSignedFn)
  })

  it('still lets a synchronous callback that returns a non-thenable value pass', () => {
    const { signed } = signP2mrPsbt({
      psbt,
      keys: plans,
      sign: (_sighash, ctx) => signatureFor(ctx.inputIndex),
      onSigned: (() => 'persisted') as unknown as P2mrPsbtOnSignedFn,
    })
    expect(signed).toEqual(plans)
  })
})

describe('signP2mrPsbt rejects an asynchronous sign', () => {
  /** Plan 0 signs synchronously; plan 1 is handed to the asynchronous signer under test. */
  async function expectAsyncSignerFailure(asyncSign: P2mrPsbtSignFn): Promise<void> {
    const unhandled: unknown[] = []
    const record = (reason: unknown): void => {
      unhandled.push(reason)
    }
    process.on('unhandledRejection', record)
    try {
      const signer = vi.fn((sighash: Uint8Array, ctx: Parameters<P2mrPsbtSignFn>[1]) =>
        ctx.inputIndex === 0 ? signatureFor(0) : asyncSign(sighash, ctx)
      )
      const failure = captureFailure(() => signP2mrPsbt({ psbt, keys: plans, sign: signer }))

      // Plan 1's key use is reported as consumed with nothing stored for it, plan 2
      // is never attempted, and plan 0's signature survives.
      expect(signer).toHaveBeenCalledTimes(2)
      expect(failure.phase).toBe('sign')
      expect(failure.failed).toEqual(plans[1])
      expect(failure.signed).toEqual([plans[0]])
      expect(storedSignatures(failure.psbt)).toEqual([hex(signatureFor(0)), undefined, undefined])
      expect(failure.cause).toBeInstanceOf(QbitProtocolError)
      expect((failure.cause as QbitProtocolError).code).toBe('INVALID_SIGNER')
      expect((failure.cause as QbitProtocolError).message).toMatch(/sign must be synchronous/)
      expect(failure.message).toMatch(/failed in sign after 1 signature\(s\): sign must be synchronous/)

      // Let the returned promise settle: its rejection must not leak.
      await new Promise(resolve => setTimeout(resolve, 0))
      expect(unhandled).toEqual([])
    } finally {
      process.off('unhandledRejection', record)
    }
  }

  it('fails the plan and swallows the rejection when sign is an async function that throws', async () => {
    await expectAsyncSignerFailure((async () => {
      throw new Error('device')
    }) as unknown as P2mrPsbtSignFn)
  })

  it('fails the plan and ignores the result when sign is an async function that resolves', async () => {
    await expectAsyncSignerFailure((async () => signatureFor(1)) as unknown as P2mrPsbtSignFn)
  })

  it('treats a non-Promise thenable the same way', async () => {
    const thenable = {
      then(_onFulfilled: unknown, onRejected: (reason: unknown) => void): void {
        onRejected(new Error('device'))
      },
    }
    await expectAsyncSignerFailure((() => thenable) as unknown as P2mrPsbtSignFn)
  })
})

describe('signP2mrPsbt accepts any Uint8Array signature', () => {
  const foreignSignature = (): Uint8Array =>
    inAnotherRealm<Uint8Array>(`new Uint8Array(${PQC_SIGNATURE_BYTES}).fill(0x21)`)

  const acceptedSignatures: [string, () => Uint8Array][] = [
    ['a Uint8Array from another realm', foreignSignature],
    ['a Node Buffer', () => Buffer.from(signatureFor(1))],
  ]

  it('exercises a value that really fails instanceof in this realm', () => {
    const foreign = foreignSignature()
    expect(foreign instanceof Uint8Array).toBe(false)
    expect(ArrayBuffer.isView(foreign)).toBe(true)
    expect(foreign.length).toBe(PQC_SIGNATURE_BYTES)
  })

  it.each(acceptedSignatures)('stores %s as a copy without wasting the key use', (_label, make) => {
    const signature = make()
    const expected = hex(signature)
    const signer = vi.fn((_sighash: Uint8Array, ctx: { inputIndex: number }) =>
      ctx.inputIndex === 1 ? signature : signatureFor(ctx.inputIndex)
    )
    const events: Uint8Array[] = []
    const { psbt: result, signed } = signP2mrPsbt({
      psbt,
      keys: plans,
      sign: signer,
      onSigned: event => {
        events.push(event.field.value)
      },
    })

    expect(signer).toHaveBeenCalledTimes(3)
    expect(signed).toEqual(plans)
    expect(storedSignatures(result)).toEqual([hex(signatureFor(0)), expected, hex(signatureFor(2))])

    // The stored field is this realm's own copy: the signer's buffer is never
    // aliased, so mutating it afterwards cannot change the PSBT or the event.
    signature.fill(0)
    expect(storedSignatures(result)[1]).toBe(expected)
    expect(events[1]).toBeInstanceOf(Uint8Array)
    expect(hex(events[1]!)).toBe(expected)
    const roundTripped = decodePsbt(parsePsbt(serializePsbt(result)))
    expect(roundTripped.inputs[1]!.scriptSigs[0]!.signature.signature).toBeInstanceOf(Uint8Array)
    expect(hex(roundTripped.inputs[1]!.scriptSigs[0]!.signature.signature)).toBe(expected)
  })
})

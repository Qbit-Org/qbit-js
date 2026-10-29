import { describe, expect, it, vi } from 'vitest'

import { P2mrPsbtSigningError, QbitProtocolError, assertMoneyRange, type Psbt } from '../src/index'

// An app that loads both the CommonJS and the ESM build (or two installed
// versions) gets two copies of each error class, and `instanceof` fails across
// them. A second module instance stands in for the other build here; the
// packed CJS/ESM pair is checked by scripts/check-packed-consumer.mjs.

async function otherCopy(): Promise<typeof import('../src/index')> {
  vi.resetModules()
  return import('../src/index')
}

function thrownBy(fn: () => unknown): unknown {
  try {
    fn()
  } catch (error) {
    return error
  }
  throw new Error('expected a throw')
}

function signingError(SigningError: typeof P2mrPsbtSigningError): P2mrPsbtSigningError {
  const failed = { inputIndex: 0, pubkey: new Uint8Array(32), leafHash: new Uint8Array(32) }
  return new SigningError({
    psbt: {} as Psbt,
    signed: [],
    failed,
    phase: 'sign',
    cause: new TypeError('signer failed'),
  })
}

describe('QbitProtocolError.is and P2mrPsbtSigningError.is', () => {
  it('recognize errors from another copy of the package, where instanceof cannot', async () => {
    const other = await otherCopy()
    expect(other.QbitProtocolError).not.toBe(QbitProtocolError)

    const foreign = thrownBy(() => other.assertMoneyRange(-1n))
    const foreignSigning = signingError(other.P2mrPsbtSigningError)

    expect(foreign instanceof QbitProtocolError).toBe(false)
    expect(foreignSigning instanceof P2mrPsbtSigningError).toBe(false)
    expect(QbitProtocolError.is(foreign)).toBe(true)
    expect(QbitProtocolError.is(foreignSigning)).toBe(true)
    expect(P2mrPsbtSigningError.is(foreignSigning)).toBe(true)
    expect(other.QbitProtocolError.is(thrownBy(() => assertMoneyRange(-1n)))).toBe(true)
    if (!QbitProtocolError.is(foreign)) throw new Error('unreachable')
    expect(foreign.code).toBe('INVALID_AMOUNT')
  })

  it('tell a signing error from other protocol errors', () => {
    const plain = thrownBy(() => assertMoneyRange(-1n))
    const signing = signingError(P2mrPsbtSigningError)

    expect(P2mrPsbtSigningError.is(plain)).toBe(false)
    expect(P2mrPsbtSigningError.is(signing)).toBe(true)
    expect(QbitProtocolError.is(signing)).toBe(true)
  })

  it('keep instanceof within one copy', () => {
    const signing = signingError(P2mrPsbtSigningError)
    expect(signing).toBeInstanceOf(P2mrPsbtSigningError)
    expect(signing).toBeInstanceOf(QbitProtocolError)
    expect(thrownBy(() => assertMoneyRange(-1n))).toBeInstanceOf(QbitProtocolError)
    expect(thrownBy(() => assertMoneyRange(-1n))).not.toBeInstanceOf(P2mrPsbtSigningError)
  })

  it.each([
    ['undefined', undefined],
    ['null', null],
    ['a plain Error', new Error('x')],
    [
      'an Error named QbitProtocolError with a code',
      Object.assign(new Error('x'), { name: 'QbitProtocolError', code: 'INVALID_PSBT' }),
    ],
    ['a plain object with a code', { name: 'QbitProtocolError', code: 'INVALID_PSBT' }],
    ['the class itself', QbitProtocolError],
  ])('reject %s', (_label, value) => {
    expect(QbitProtocolError.is(value)).toBe(false)
    expect(P2mrPsbtSigningError.is(value)).toBe(false)
  })

  it('work detached from the class', () => {
    const errors: unknown[] = [
      new QbitProtocolError('INVALID_PSBT', 'x'),
      signingError(P2mrPsbtSigningError),
      new Error('y'),
    ]
    expect(errors.filter(QbitProtocolError.is)).toHaveLength(2)
    expect(errors.filter(P2mrPsbtSigningError.is)).toHaveLength(1)
  })

  it('leave error instances unchanged', () => {
    const error = new QbitProtocolError('INVALID_PSBT', 'x')
    expect(Object.getOwnPropertySymbols(error)).toEqual([])
    expect(Object.getOwnPropertySymbols(signingError(P2mrPsbtSigningError))).toEqual([])
    expect(JSON.stringify(error)).toBe('{"name":"QbitProtocolError","code":"INVALID_PSBT"}')
  })
})

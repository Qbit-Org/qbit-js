import { describe, expect, it, vi } from 'vitest'

import { EsploraClient, QbitApiError } from '../src/index'

// An app that loads both the CommonJS and the ESM build (or two installed
// versions) gets two QbitApiError classes, and `instanceof` fails across them.
// A second module instance stands in for the other build here; the packed
// CJS/ESM pair is checked by scripts/check-packed-consumer.mjs.

async function otherCopy(): Promise<typeof import('../src/index')> {
  vi.resetModules()
  return import('../src/index')
}

describe('QbitApiError.is', () => {
  it('recognizes errors from another copy of the package, where instanceof cannot', async () => {
    const other = await otherCopy()
    expect(other.QbitApiError).not.toBe(QbitApiError)

    const foreign = new other.QbitApiError('parse', 'from the other build')
    const local = new QbitApiError('parse', 'from this build')

    expect(foreign instanceof QbitApiError).toBe(false)
    expect(local instanceof other.QbitApiError).toBe(false)
    expect(QbitApiError.is(foreign)).toBe(true)
    expect(other.QbitApiError.is(local)).toBe(true)
  })

  it('recognizes an error a client from another copy rejects with', async () => {
    const other = await otherCopy()
    const fetchFn = (async () => new Response('', { status: 200 })) as typeof fetch
    const client = new other.EsploraClient({ baseUrl: 'https://esplora.example/api', fetchFn })

    const error: unknown = await client.getTxHex('ab'.repeat(32)).catch((caught: unknown) => caught)

    expect(error instanceof QbitApiError).toBe(false)
    expect(QbitApiError.is(error)).toBe(true)
    if (!QbitApiError.is(error)) throw new Error('unreachable')
    expect(error.kind).toBe('parse')
  })

  it('keeps instanceof within one copy, including for subclasses', () => {
    class AppError extends QbitApiError {}
    const error = new AppError('network', 'from a custom fetchFn')

    expect(error).toBeInstanceOf(QbitApiError)
    expect(error).toBeInstanceOf(AppError)
    expect(new QbitApiError('http', 'x')).not.toBeInstanceOf(AppError)
    expect(QbitApiError.is(error)).toBe(true)
  })

  it('recognizes errors the client throws', async () => {
    expect(() => new EsploraClient({ baseUrl: 'ftp://example.com' })).toThrow(QbitApiError)
    let thrown: unknown
    try {
      new EsploraClient({ baseUrl: 'ftp://example.com' })
    } catch (error) {
      thrown = error
    }
    expect(QbitApiError.is(thrown)).toBe(true)
  })

  it.each([
    ['undefined', undefined],
    ['null', null],
    ['a string', 'QbitApiError'],
    ['a plain Error', new Error('x')],
    ['an Error named QbitApiError with a kind', Object.assign(new Error('x'), { name: 'QbitApiError', kind: 'parse' })],
    ['a plain object with a kind', { name: 'QbitApiError', kind: 'parse', message: 'x' }],
    ['the class itself', QbitApiError],
    ['a brand that is not true', { [Symbol.for('qbit-js.QbitApiError')]: 'yes' }],
  ])('rejects %s', (_label, value) => {
    expect(QbitApiError.is(value)).toBe(false)
  })

  it('works detached from the class', () => {
    const errors: unknown[] = [new QbitApiError('timeout', 'x'), new Error('y'), 'z']
    expect(errors.filter(QbitApiError.is)).toHaveLength(1)
  })

  it('leaves error instances and their serialization unchanged', () => {
    const error = new QbitApiError('parse', 'x', { status: 200 })

    expect(Object.getOwnPropertySymbols(error)).toEqual([])
    expect(Object.keys(error)).toEqual(['name', 'kind', 'status'])
    expect(JSON.stringify(error)).toBe('{"name":"QbitApiError","kind":"parse","status":200}')
    const brand = Object.getOwnPropertyDescriptor(QbitApiError.prototype, Symbol.for('qbit-js.QbitApiError'))
    expect(brand).toEqual({ value: true, writable: false, enumerable: false, configurable: false })
  })
})

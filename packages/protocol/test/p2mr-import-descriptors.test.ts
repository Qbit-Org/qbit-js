import { describe, expect, it } from 'vitest'

import { QbitProtocolError, addDescriptorChecksum, formatP2mrImportDescriptors } from '../src/index'

// One BIP32 payload encoded under each network's private version bytes, so only
// the network differs between these keys.
const QRPV =
  'qrpvV1brS3WRoVwgS5xyXiUp3mtpwpSs8xy5BoE1RoSfwu8zY4kXL4vZTUdqw7UNivGw3rwtcfiKLVwGRWQWPJYRN4SMAPuBHYSFy1sd1VtMk8j'
const QPRV =
  'qprvYWJDeuDutHd55wTaAEQY7yjXDXCgEZftZWbfHNxYApSptL4ZKSwax29JbvrxEC8iWoU2T8w7CmveoDshmjfDNYrbGEt6oiTfCgMHDFoYC2B'
const TQPV =
  'tqpvTyVzVPBRS3roGiVnNwm4qHJFeJzYJJ93fJYh2QtaaVAY2sTT9cp12BpQUA6MKNW6TU9ADnHpcmu86GPLqu2ycuttP5FGcQapiYJfhTEqLiC'
const XPRV =
  'xprv9s21ZrQH143K24wRdsX9TnFuNKBUZJDDM4DfJkKgF4HkNxzHqVaWQNr7mnpffA1Q6tHGs2QhJAfmJFL3zg3Rj45hjkA4qaPX6BFpzGf4WsL'
const TPRV =
  'tprv8ZgxMBicQKsPctAxJSNedRstgSbgnpFDgc8nBAk8j2nEAZjNprvFv8DZgxzKfXPiUKp3s82TTXFZm6so7tPNY7MJGPNNVw7a1H1FS3KGbXN'

function external(key = QRPV): string {
  return `mr(pk(pqc(${key}/87h/1h/0h/0/*)))`
}

function internal(key = QRPV): string {
  return `mr(pk(pqc(${key}/87h/1h/0h/1/*)))`
}

const PAIR = { external: external(), internal: internal() }

function importError(fn: () => unknown): QbitProtocolError {
  try {
    fn()
  } catch (error) {
    expect(error).toBeInstanceOf(QbitProtocolError)
    expect((error as QbitProtocolError).code).toBe('INVALID_DESCRIPTOR')
    return error as QbitProtocolError
  }
  throw new Error('expected formatP2mrImportDescriptors to throw')
}

describe('formatP2mrImportDescriptors rejects these requests, which Core v1.0.0 rejects or misapplies', () => {
  it('keeps the default [0, 999] range and "now" timestamp', () => {
    expect(formatP2mrImportDescriptors(PAIR)).toEqual([
      {
        desc: addDescriptorChecksum(PAIR.external),
        timestamp: 'now',
        active: true,
        internal: false,
        range: [0, 999],
      },
      {
        desc: addDescriptorChecksum(PAIR.internal),
        timestamp: 'now',
        active: true,
        internal: true,
        range: [0, 999],
      },
    ])
  })

  it.each([
    ['leading space', ` ${external()}`, internal()],
    ['trailing space', external(), `${internal()} `],
    ['trailing space after a checksum', `${addDescriptorChecksum(external())} `, internal()],
    ['trailing newline', `${external()}\n`, internal()],
    ['leading tab', external(), `\t${internal()}`],
    ['trailing NBSP', `${external()} `, internal()],
  ])('rejects a descriptor with %s', (_name, externalDesc, internalDesc) => {
    expect(
      importError(() => formatP2mrImportDescriptors({ external: externalDesc, internal: internalDesc })).message
    ).toMatch(/import descriptor must not have leading or trailing whitespace$/)
  })

  it('rejects a non-string descriptor from an untyped caller', () => {
    expect(
      importError(() => formatP2mrImportDescriptors({ external: undefined, internal: internal() } as never)).message
    ).toBe('external import descriptor must be a string')
  })

  it('accepts ranges of up to 1,000,000 indices (end inclusive), like Core', () => {
    expect(formatP2mrImportDescriptors(PAIR, [0, 999_999])[0]?.range).toEqual([0, 999_999])
    expect(formatP2mrImportDescriptors(PAIR, [0x7fffffff - 999_999, 0x7fffffff])[1]?.range).toEqual([
      0x7fffffff - 999_999,
      0x7fffffff,
    ])
  })

  it.each([[[0, 1_000_000]], [[5, 1_000_005]], [[0, 0x7fffffff]]] as const)('rejects range %j as too large', range => {
    expect(importError(() => formatP2mrImportDescriptors(PAIR, [...range])).message).toBe('Range is too large')
  })

  it('rejects ranges that are not a [start, end] pair', () => {
    expect(importError(() => formatP2mrImportDescriptors(PAIR, [0, 10, 20] as never)).message).toBe(
      'descriptor range must be [start, end]'
    )
    expect(importError(() => formatP2mrImportDescriptors(PAIR, 10 as never)).message).toBe(
      'descriptor range must be [start, end]'
    )
  })

  it.each([0, 1, 1_700_000_000, Number.MAX_SAFE_INTEGER])('accepts timestamp %j', timestamp => {
    expect(formatP2mrImportDescriptors(PAIR, [0, 999], timestamp)[0]?.timestamp).toBe(timestamp)
  })

  it.each([NaN, 1.5, Infinity, -1, 1e20, 'yesterday', '1234', null])('rejects timestamp %s', timestamp => {
    expect(importError(() => formatP2mrImportDescriptors(PAIR, [0, 999], timestamp as never)).message).toBe(
      "import timestamp must be 'now' or a non-negative integer number of seconds"
    )
  })

  it('rejects an identical external and internal descriptor, with or without checksums', () => {
    const message = 'external and internal import descriptors must differ'
    expect(importError(() => formatP2mrImportDescriptors({ external: external(), internal: external() })).message).toBe(
      message
    )
    expect(
      importError(() =>
        formatP2mrImportDescriptors({
          external: addDescriptorChecksum(external()),
          internal: external(),
        })
      ).message
    ).toBe(message)
  })

  it.each([
    ['mainnet and regtest', QPRV, QRPV],
    ['testnet4/signet and regtest', TQPV, QRPV],
    ['mainnet and testnet4/signet', QPRV, TQPV],
    ['Bitcoin mainnet and regtest', XPRV, QRPV],
    ['Bitcoin testnet and mainnet', TPRV, QPRV],
  ])('rejects a pair mixing %s keys', (_name, externalKey, internalKey) => {
    expect(
      importError(() =>
        formatP2mrImportDescriptors({ external: external(externalKey), internal: internal(internalKey) })
      ).message
    ).toMatch(/^import descriptors mix extended keys from different networks/)
  })

  it('rejects mixed networks inside one descriptor tree', () => {
    expect(
      importError(() =>
        formatP2mrImportDescriptors({
          external: `mr({pk(pqc(${QRPV}/0/*)),pk(pqc(${QPRV}/0/*))})`,
          internal: internal(),
        })
      ).message
    ).toBe('import descriptors mix extended keys from different networks (qrpv, qprv)')
  })

  // qbit Core also decodes Bitcoin's version bytes: xpub/xprv on mainnet and
  // tpub/tprv on every other chain (src/key_io.cpp:62-87).
  it.each([
    ['qprv with xprv (mainnet)', QPRV, XPRV],
    ['tqpv with tprv (testnet4/signet)', TQPV, TPRV],
    ['qrpv with tprv (regtest)', QRPV, TPRV],
  ])('accepts a pair that one network decodes: %s', (_name, externalKey, internalKey) => {
    expect(
      formatP2mrImportDescriptors({ external: external(externalKey), internal: internal(internalKey) })
    ).toHaveLength(2)
  })
})

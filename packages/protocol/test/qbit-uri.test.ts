import { describe, expect, it } from 'vitest'

import {
  QbitProtocolError,
  type QbitProtocolErrorCode,
  type QbitUriFields,
  formatQbitUri,
  hexToBytes,
  p2mrAddressFromRoot,
  parseQbitUri,
} from '../src/index'

// Core reference: Qbit-Org/qbit v1.0.0 (7ebcddb), src/qt/guiutil.cpp
// parseBitcoinURI (:156-221) and formatBitcoinURI (:223-251).

const RAW_ROOT = hexToBytes('000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f')
const ADDRESS = p2mrAddressFromRoot(RAW_ROOT, 'mainnet')
const REGTEST_ADDRESS = p2mrAddressFromRoot(RAW_ROOT, 'regtest')

function uriError(fn: () => unknown): QbitProtocolError {
  try {
    fn()
  } catch (error) {
    expect(error).toBeInstanceOf(QbitProtocolError)
    return error as QbitProtocolError
  }
  throw new Error('expected a QbitProtocolError')
}

function expectUriError(fn: () => unknown, code: QbitProtocolErrorCode): void {
  expect(uriError(fn).code).toBe(code)
}

describe('parseQbitUri req- parameters (BIP21, guiutil.cpp:176-206)', () => {
  it('rejects a URI with a req- parameter it does not understand', () => {
    expectUriError(() => parseQbitUri(`qbit:${ADDRESS}?amount=1&req-expires=1700000000`), 'INVALID_URI')
    expectUriError(() => parseQbitUri(`qbit:${ADDRESS}?req-expires=1700000000`), 'INVALID_URI')
    expectUriError(() => parseQbitUri(`qbit:${ADDRESS}?req-=1`), 'INVALID_URI')
    expectUriError(() => parseQbitUri(`qbit:${ADDRESS}?req-pj=https%3A%2F%2Fexample.com`), 'INVALID_URI')
  })

  it('detects req- after percent-decoding the key', () => {
    expectUriError(() => parseQbitUri(`qbit:${ADDRESS}?%72eq-expires=1`), 'INVALID_URI')
  })

  it('maps req-amount, req-label and req-message to their base fields', () => {
    const parsed = parseQbitUri(`qbit:${ADDRESS}?req-amount=5&req-label=Alice&req-message=Thanks`)

    expect(parsed.amount).toBe('5')
    expect(parsed.label).toBe('Alice')
    expect(parsed.message).toBe('Thanks')
  })

  it('validates a req-amount like amount', () => {
    expectUriError(() => parseQbitUri(`qbit:${ADDRESS}?req-amount=1.000000001`), 'INVALID_URI')
    expectUriError(() => parseQbitUri(`qbit:${ADDRESS}?req-amount=abc`), 'INVALID_URI')
  })

  it.each([
    ['AMOUNT=5'],
    ['Amount=5'],
    ['amount=1&AMOUNT=1000'],
    ['Label=x'],
    ['MESSAGE=x'],
    ['REQ-amount=5'],
    ['req-AMOUNT=5'],
    ['REQ-expires=1'],
    ['Req-foo=1'],
    ['%41MOUNT=5'],
  ])('rejects the case variant in %s (Core ignores it, BIP321 reads it)', query => {
    expectUriError(() => parseQbitUri(`qbit:${ADDRESS}?${query}`), 'INVALID_URI')
  })

  // ſ and ß are lowercase, but uppercase to S and SS, and capital ẞ casefolds to
  // ss. A case-insensitive reader can take these as message: Python's casefold()
  // maps all three, Java's equalsIgnoreCase maps ſ.
  it.each([['me%C5%BF%C5%BFage=hi'], ['me%C3%9Fage=hi'], ['meſsage=hi'], ['me%E1%BA%9Eage=hi']])(
    'rejects the Unicode case variant in %s',
    query => {
      expectUriError(() => parseQbitUri(`qbit:${ADDRESS}?${query}`), 'INVALID_URI')
    }
  )

  it('keeps other mixed-case names as unknown parameters', () => {
    const parsed = parseQbitUri(`qbit:${ADDRESS}?amount=1&PJ=x&Lightning=y&AMOUNTS=2`)

    expect(parsed.amount).toBe('1')
    expect([...parsed.params]).toEqual([
      ['amount', '1'],
      ['PJ', 'x'],
      ['Lightning', 'y'],
      ['AMOUNTS', '2'],
    ])
  })
})

describe('parseQbitUri duplicate parameters (fails closed; Core is last-wins)', () => {
  it.each([
    ['amount=1&amount=1000'],
    ['amount=1&req-amount=1000'],
    ['req-amount=1&amount=1000'],
    ['req-amount=1&req-amount=1000'],
    ['amount=1&%61mount=1000'],
    ['label=Alice&label=Mallory'],
    ['label=Alice&req-label=Mallory'],
    ['message=a&message=b'],
    ['req-message=a&message=b'],
  ])('rejects %s', query => {
    expectUriError(() => parseQbitUri(`qbit:${ADDRESS}?${query}`), 'INVALID_URI')
  })

  it('keeps repeated unknown parameters in params', () => {
    const parsed = parseQbitUri(`qbit:${ADDRESS}?foo=1&foo=2&amount=3`)

    expect(parsed.amount).toBe('3')
    expect(parsed.params.getAll('foo')).toEqual(['1', '2'])
  })
})

describe('parseQbitUri query decoding (RFC 3986, not form-urlencoding)', () => {
  it('keeps + literal', () => {
    const parsed = parseQbitUri(`qbit:${ADDRESS}?label=A+B&message=1+1%3D2`)

    expect(parsed.label).toBe('A+B')
    expect(parsed.message).toBe('1+1=2')
  })

  it('decodes %20 and UTF-8 escapes', () => {
    const parsed = parseQbitUri(`qbit:${ADDRESS}?label=Coffee%20shop&message=caf%C3%A9%20%E2%82%BF`)

    expect(parsed.label).toBe('Coffee shop')
    expect(parsed.message).toBe('café ₿')
  })

  it.each([['label=%ZZ'], ['label=100%'], ['label=%E2%82'], ['label=%FF'], ['%ZZ=1'], ['pj=%ZZ'], ['amount=%']])(
    'rejects the malformed escape in %s',
    query => {
      expectUriError(() => parseQbitUri(`qbit:${ADDRESS}?${query}`), 'INVALID_URI')
    }
  )

  it('rejects a stray % that makes Core skip an escaped amount', () => {
    // One malformed escape stops QUrl decoding the query, so Core sees the key
    // %61mount, not amount, and reads no amount.
    expectUriError(() => parseQbitUri(`qbit:${ADDRESS}?%61mount=5&pj=100%`), 'INVALID_URI')
  })

  it('splits each segment on its first =', () => {
    const parsed = parseQbitUri(`qbit:${ADDRESS}?message=a=b&label`)

    expect(parsed.message).toBe('a=b')
    expect(parsed.label).toBe('')
  })

  it('skips empty segments', () => {
    const parsed = parseQbitUri(`qbit:${ADDRESS}?&amount=1&&label=x&`)

    expect(parsed.amount).toBe('1')
    expect(parsed.label).toBe('x')
    expect([...parsed.params]).toEqual([
      ['amount', '1'],
      ['label', 'x'],
    ])
  })

  it('fills params with every decoded pair in order, keys as written', () => {
    const parsed = parseQbitUri(
      `qbit:${ADDRESS}?req-amount=5&pj=https%3A%2F%2Fexample.com%2Fpj&lightning=lnbc1&note=a+b`
    )

    expect(parsed.amount).toBe('5')
    expect([...parsed.params]).toEqual([
      ['req-amount', '5'],
      ['pj', 'https://example.com/pj'],
      ['lightning', 'lnbc1'],
      ['note', 'a+b'],
    ])
  })

  it('still rejects an empty amount= (fails closed; Core reads it as no amount)', () => {
    expectUriError(() => parseQbitUri(`qbit:${ADDRESS}?amount=`), 'INVALID_URI')
    expectUriError(() => parseQbitUri(`qbit:${ADDRESS}?amount`), 'INVALID_URI')
    expectUriError(() => parseQbitUri(`qbit:${ADDRESS}?req-amount=`), 'INVALID_URI')
  })
})

describe('parseQbitUri scheme and address (guiutil.cpp:160,166-169,216)', () => {
  it('matches the qbit: scheme case-insensitively', () => {
    const upper = parseQbitUri(`QBIT:${ADDRESS.toUpperCase()}?amount=1`, 'mainnet')

    expect(upper.address).toBe(ADDRESS.toUpperCase())
    expect(upper.network).toBe('mainnet')
    expect(upper.amount).toBe('1')
    expect(parseQbitUri(`Qbit:${ADDRESS}`).address).toBe(ADDRESS)
  })

  it('strips one trailing slash from the address', () => {
    expect(parseQbitUri(`qbit:${ADDRESS}/`).address).toBe(ADDRESS)
    expect(parseQbitUri(`qbit:${ADDRESS}/?amount=2`).amount).toBe('2')
    expectUriError(() => parseQbitUri(`qbit:${ADDRESS}//`), 'INVALID_BECH32')
    expectUriError(() => parseQbitUri('qbit:/'), 'INVALID_URI')
  })

  it.each([
    [`QBIT://${ADDRESS}`],
    [`Qbit://${ADDRESS}`],
    [`qbit://${ADDRESS}`],
    [`BITCOIN:${ADDRESS}`],
    [`Bitcoin:${ADDRESS}`],
    [`bitcoin:${ADDRESS}`],
    [ADDRESS],
  ])('rejects %s with WRONG_URI_SCHEME', uri => {
    expectUriError(() => parseQbitUri(uri), 'WRONG_URI_SCHEME')
  })

  it.each([
    [`qbit:${ADDRESS}?label=x#&amount=1000`],
    [`qbit:${ADDRESS}?#&amount=1000`],
    [`qbit:${ADDRESS}?amount=1#`],
    [`qbit:${ADDRESS}#?amount=5`],
  ])('rejects the # fragment in %s (Core drops it, so it reads no amount)', uri => {
    expectUriError(() => parseQbitUri(uri), 'INVALID_URI')
  })

  it('keeps the existing address and network checks', () => {
    expectUriError(() => parseQbitUri('qbit:'), 'INVALID_URI')
    expectUriError(() => parseQbitUri('qbit:?amount=1'), 'INVALID_URI')
    expectUriError(() => parseQbitUri(`qbit:${REGTEST_ADDRESS}`, 'mainnet'), 'WRONG_HRP')
    expect(parseQbitUri(`qbit:${REGTEST_ADDRESS}`).network).toBe('regtest')
  })
})

describe('formatQbitUri percent-encoding (QUrl::toPercentEncoding, guiutil.cpp:238,245)', () => {
  it('encodes a space as %20 and leaves only RFC 3986 unreserved characters bare', () => {
    expect(formatQbitUri({ address: ADDRESS, label: 'Coffee shop', message: "it's (a) *test*! ~_.-" })).toBe(
      `qbit:${ADDRESS}?label=Coffee%20shop&message=it%27s%20%28a%29%20%2Atest%2A%21%20~_.-`
    )
  })

  it('encodes +, &, =, %, # and non-ASCII', () => {
    expect(formatQbitUri({ address: ADDRESS, label: 'a+b&c=d%e#f', message: 'café ₿' })).toBe(
      `qbit:${ADDRESS}?label=a%2Bb%26c%3Dd%25e%23f&message=caf%C3%A9%20%E2%82%BF`
    )
  })

  it('emits amount, label, message in that order', () => {
    const fields: QbitUriFields = { message: 'm', label: 'l', amount: '0.5', address: ADDRESS }

    expect(formatQbitUri(fields)).toBe(`qbit:${ADDRESS}?amount=0.5&label=l&message=m`)
    expect(formatQbitUri({ address: ADDRESS })).toBe(`qbit:${ADDRESS}`)
  })

  it('rejects text that is not well-formed Unicode', () => {
    expectUriError(() => formatQbitUri({ address: ADDRESS, label: '\uD800' }), 'INVALID_URI')
    expectUriError(() => formatQbitUri({ address: ADDRESS, message: 'a\uDC00b' }), 'INVALID_URI')
  })
})

describe('qbit URI amount cap (QBIT_MAX_MONEY, bitcoinamountfield.cpp:171)', () => {
  it.each([['209999999.99999999'], ['210000000'], ['210000000.00000000']])('accepts amount=%s', amount => {
    expect(parseQbitUri(`qbit:${ADDRESS}?amount=${amount}`).amount).toBe(amount)
    expect(parseQbitUri(`qbit:${ADDRESS}?req-amount=${amount}`).amount).toBe(amount)
    expect(formatQbitUri({ address: ADDRESS, amount })).toBe(`qbit:${ADDRESS}?amount=${amount}`)
  })

  it.each([
    ['210000000.00000001'],
    ['210000001'],
    ['10000000000'],
    // 2^64 + 1 base units, which a uint64 backend wraps to 1.
    ['184467440737.09551617'],
    ['99999999999999999999999'],
  ])('rejects amount=%s in parse and format', amount => {
    expectUriError(() => parseQbitUri(`qbit:${ADDRESS}?amount=${amount}`), 'INVALID_URI')
    expectUriError(() => parseQbitUri(`qbit:${ADDRESS}?req-amount=${amount}`), 'INVALID_URI')
    expectUriError(() => formatQbitUri({ address: ADDRESS, amount }), 'INVALID_URI')
  })
})

describe('formatQbitUri -> parseQbitUri round trip', () => {
  // Deterministic PRNG so failures reproduce.
  function mulberry32(seed: number): () => number {
    let state = seed
    return () => {
      state = (state + 0x6d2b79f5) | 0
      let t = Math.imul(state ^ (state >>> 15), 1 | state)
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296
    }
  }

  const ALPHABET = [..."aZ09+ &=%?#/:;,!'()*~-._@$", '%20', '%ZZ', 'req-', 'é', '中', '₿', '😀', '\u0000', '\n']

  it('round-trips random label/message/amount values exactly', () => {
    const random = mulberry32(0x9b1f2c)
    const pick = <T>(items: readonly T[]): T => items[Math.floor(random() * items.length)]!
    const text = (): string => Array.from({ length: Math.floor(random() * 12) }, () => pick(ALPHABET)).join('')
    const amount = (): string => {
      // Up to qbit's MAX_MONEY of 210,000,000 QBT, not Bitcoin's 21,000,000.
      const whole = String(Math.floor(random() * 210_000_000))
      const decimals = Math.floor(random() * 9)
      if (decimals === 0) return whole
      const fraction = Array.from({ length: decimals }, () => String(Math.floor(random() * 10))).join('')
      return `${whole}.${fraction}`
    }

    for (let i = 0; i < 2000; i += 1) {
      const fields: QbitUriFields = { address: i % 2 === 0 ? ADDRESS : REGTEST_ADDRESS }
      if (random() < 0.7) fields.amount = amount()
      if (random() < 0.8) fields.label = text()
      if (random() < 0.8) fields.message = text()

      const uri = formatQbitUri(fields)
      expect(uri).toMatch(/^qbit:[a-z0-9]+(\?[A-Za-z0-9\-._~%&=]+)?$/)

      const parsed = parseQbitUri(uri)
      expect(parsed.address).toBe(fields.address)
      expect(parsed.amount).toBe(fields.amount)
      expect(parsed.label).toBe(fields.label)
      expect(parsed.message).toBe(fields.message)
    }
  })
})

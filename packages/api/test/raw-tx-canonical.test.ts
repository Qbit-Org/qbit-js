import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

import { EsploraClient, MempoolQbitClient, QbitApiError, txidFromRawTx } from '../src/index'

// getTxHex and txidFromRawTx used to read CompactSizes without Core's
// canonical-encoding and MAX_SIZE checks, and accepted the witness flag with
// every witness stack empty. The witness section is stripped before hashing,
// so a witness item count of 3 written `fd0300` instead of `03` still yields
// the requested txid, and getTxHex returned bytes qbit Core refuses to decode
// (`non-canonical ReadCompactSize()`, `Superfluous witness record`).

const BASE = 'https://esplora.example/api'

/** qbit Core `serialize.h` MAX_SIZE. */
const MAX_SIZE = 0x02000000
/**
 * Several cases build and decode a MAX_SIZE (32 MiB) witness item, which takes a few seconds on a
 * slow CI runner, near vitest's 5 s default.
 */
const SCALE_TIMEOUT_MS = 60_000

const P2MR_TX = JSON.parse(readFileSync(new URL('./fixtures/p2mr-witness-tx.json', import.meta.url), 'utf8')) as {
  unsignedTxHex: string
  rawTxHex: string
  txid: string
}

const CLIENTS = [
  ['EsploraClient', EsploraClient],
  ['MempoolQbitClient', MempoolQbitClient],
] as const

interface DecodedTx {
  version: string
  inputs: { outpoint: string; scriptSig: string; sequence: string }[]
  outputs: { value: string; scriptPubKey: string }[]
  witnesses: string[][]
  locktime: string
}

/** Decodes the canonical BIP144 fixture into hex fields. */
function decode(hex: string): DecodedTx {
  let at = 0
  const take = (bytes: number) => {
    const out = hex.slice(at, at + 2 * bytes)
    at += 2 * bytes
    return out
  }
  const size = () => {
    const first = parseInt(take(1), 16)
    if (first < 0xfd) return first
    if (first === 0xfd) return parseInt(take(2).match(/../g)!.reverse().join(''), 16)
    throw new Error('fixture uses an unexpected CompactSize')
  }
  const version = take(4)
  if (take(2) !== '0001') throw new Error('fixture is not witness-serialized')
  const inputs = Array.from({ length: size() }, () => ({
    outpoint: take(36),
    scriptSig: take(size()),
    sequence: take(4),
  }))
  const outputs = Array.from({ length: size() }, () => ({ value: take(8), scriptPubKey: take(size()) }))
  const witnesses = inputs.map(() => Array.from({ length: size() }, () => take(size())))
  const locktime = take(4)
  if (at !== hex.length) throw new Error('fixture has trailing data')
  return { version, inputs, outputs, witnesses, locktime }
}

function le(value: number, bytes: number): string {
  let out = ''
  for (let i = 0; i < bytes; i += 1) out += (Math.floor(value / 2 ** (8 * i)) % 256).toString(16).padStart(2, '0')
  return out
}

function canonical(value: number): string {
  if (value < 0xfd) return le(value, 1)
  if (value < 0x10000) return 'fd' + le(value, 2)
  if (value < 2 ** 32) return 'fe' + le(value, 4)
  return 'ff' + le(value, 8)
}

/** The next-wider encoding of `value`, which Core rejects as non-canonical. */
function nonCanonical(value: number): string {
  if (value < 0xfd) return 'fd' + le(value, 2)
  if (value < 0x10000) return 'fe' + le(value, 4)
  return 'ff' + le(value, 8)
}

/**
 * `tx` in BIP144 encoding. `encodeSize(field, value)` writes each CompactSize;
 * fields are `inputs`, `outputs`, `scriptSig[i]`, `scriptPubKey[i]`,
 * `witness[i]` (item count) and `witness[i][j]` (item length).
 */
function encode(tx: DecodedTx, encodeSize: (field: string, value: number) => string = (_f, v) => canonical(v)): string {
  const bytes = (field: string, hex: string) => encodeSize(field, hex.length / 2) + hex
  return [
    tx.version,
    '0001',
    encodeSize('inputs', tx.inputs.length),
    ...tx.inputs.map((input, i) => input.outpoint + bytes(`scriptSig[${i}]`, input.scriptSig) + input.sequence),
    encodeSize('outputs', tx.outputs.length),
    ...tx.outputs.map((output, i) => output.value + bytes(`scriptPubKey[${i}]`, output.scriptPubKey)),
    ...tx.witnesses.map(
      (stack, i) =>
        encodeSize(`witness[${i}]`, stack.length) + stack.map((item, j) => bytes(`witness[${i}][${j}]`, item)).join('')
    ),
    tx.locktime,
  ].join('')
}

/** The fixture with the CompactSize at `field` written non-canonically. */
function withNonCanonical(field: string): string {
  return encode(TX, (f, v) => (f === field ? nonCanonical(v) : canonical(v)))
}

/** The fixture with witness stacks replaced. */
function withWitnesses(witnesses: string[][]): string {
  return encode({ ...TX, witnesses })
}

const TX = decode(P2MR_TX.rawTxHex)

const ALL_EMPTY_STACKS = withWitnesses([[], []])

/** Each malformed encoding, and whether its witness-stripped bytes still hash to the fixture txid. */
const MALFORMED: [string, () => string, boolean][] = [
  ['a non-canonical witness item count (3 as fd0300)', () => withNonCanonical('witness[0]'), true],
  ['a non-canonical empty witness stack count (0 as fd0000)', () => withNonCanonical('witness[1]'), true],
  ['a non-canonical witness item length', () => withNonCanonical('witness[0][1]'), true],
  ['a non-canonical witness item length one width up (fe prefix)', () => withNonCanonical('witness[0][0]'), true],
  [
    'a non-canonical 9-byte witness item count (ff prefix)',
    () => encode(TX, (f, v) => (f === 'witness[0]' ? 'ff' + le(v, 8) : canonical(v))),
    true,
  ],
  ['a non-canonical input count', () => withNonCanonical('inputs'), false],
  ['a non-canonical output count', () => withNonCanonical('outputs'), false],
  ['a non-canonical scriptPubKey length', () => withNonCanonical('scriptPubKey[0]'), false],
  ['a non-canonical (empty) scriptSig length', () => withNonCanonical('scriptSig[0]'), false],
  ['the witness flag with every witness stack empty', () => ALL_EMPTY_STACKS, true],
]

/** A witness item of MAX_SIZE + 1 bytes: canonical, present in full, and above Core's limit. */
function withOversizedWitnessItem(): string {
  return encode({ ...TX, witnesses: [TX.witnesses[0]!, ['']] }, (f, v) =>
    f === 'witness[1][0]' ? canonical(MAX_SIZE + 1) + '00'.repeat(MAX_SIZE + 1) : canonical(v)
  )
}

function serving(Client: typeof EsploraClient, body: string, maxResponseBytes?: number): EsploraClient {
  const fetchFn = (async () => new Response(body, { status: 200 })) as unknown as typeof fetch
  return new Client({
    baseUrl: BASE,
    fetchFn,
    retries: 0,
    ...(maxResponseBytes === undefined ? {} : { maxResponseBytes }),
  })
}

describe('raw transaction fixture re-encoding', () => {
  it('round-trips the fixture canonically', () => {
    expect(encode(TX)).toBe(P2MR_TX.rawTxHex)
    expect(TX.witnesses.map(stack => stack.length)).toEqual([3, 0])
  })
})

describe('txidFromRawTx: qbit Core decoding rules', { timeout: SCALE_TIMEOUT_MS }, () => {
  it.each(MALFORMED)('throws parse on %s', (_name, hex) => {
    let error: unknown
    try {
      txidFromRawTx(hex())
    } catch (caught) {
      error = caught
    }
    expect(error).toBeInstanceOf(QbitApiError)
    expect(error).toMatchObject({ kind: 'parse', message: 'raw transaction hex is not a well-formed transaction' })
  })

  it('throws parse on a canonical CompactSize above MAX_SIZE with all its bytes present', () => {
    expect(() => txidFromRawTx(withOversizedWitnessItem())).toThrow(/not a well-formed transaction/)
  })

  it('throws parse on a canonical 9-byte count (2^32), which is above MAX_SIZE', () => {
    const hex = encode(TX, (f, v) => (f === 'witness[0]' ? canonical(2 ** 32) : canonical(v)))
    expect(hex).toContain('ff0000000001000000')
    expect(() => txidFromRawTx(hex)).toThrow(/not a well-formed transaction/)
  })

  it.each([
    ['0xfc in one byte', 0xfc, 'fc'],
    ['0xfd as fdfd00', 0xfd, 'fdfd00'],
    ['0xffff as fdffff', 0xffff, 'fdffff'],
    ['0x10000 as fe00000100', 0x10000, 'fe00000100'],
  ])('still parses the canonical boundary encoding of %s', (_name, length, prefix) => {
    const hex = withWitnesses([TX.witnesses[0]!, ['ab'.repeat(length)]])
    expect(hex).toContain(prefix + 'abab')
    expect(txidFromRawTx(hex)).toBe(P2MR_TX.txid)
  })

  it('still parses a canonical CompactSize of exactly MAX_SIZE', () => {
    const hex = withWitnesses([TX.witnesses[0]!, ['00'.repeat(MAX_SIZE)]])
    expect(txidFromRawTx(hex)).toBe(P2MR_TX.txid)
  })

  it('counts a stack holding one empty item as a witness (Core HasWitness)', () => {
    expect(txidFromRawTx(withWitnesses([[''], []]))).toBe(P2MR_TX.txid)
    expect(txidFromRawTx(withWitnesses([[], ['']]))).toBe(P2MR_TX.txid)
  })
})

describe.each(CLIENTS)('%s.getTxHex: qbit Core decoding rules', { timeout: SCALE_TIMEOUT_MS }, (_name, Client) => {
  it.each(MALFORMED)('rejects %s as not well-formed', async (_case, hex, sameTxid) => {
    const body = hex()
    // Witness-only changes keep the stripped bytes, so only these checks catch them.
    expect(body.startsWith(TX.version + '0001' + P2MR_TX.unsignedTxHex.slice(8, -8))).toBe(sameTxid)
    const error = await serving(Client, body)
      .getTxHex(P2MR_TX.txid)
      .catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(QbitApiError)
    expect(error).toMatchObject({ kind: 'parse', message: 'transaction hex reply is not a well-formed transaction' })
  })

  it('rejects a canonical CompactSize above MAX_SIZE as not well-formed', async () => {
    // Its 64 MiB of hex is far over the default maxResponseBytes, which refuses it first.
    const hex = withOversizedWitnessItem()
    await expect(serving(Client, hex).getTxHex(P2MR_TX.txid)).rejects.toMatchObject({ kind: 'response_too_large' })
    await expect(serving(Client, hex, hex.length).getTxHex(P2MR_TX.txid)).rejects.toMatchObject({
      kind: 'parse',
      message: 'transaction hex reply is not a well-formed transaction',
    })
  })

  it('still returns canonical boundary encodings and a stack holding one empty item', async () => {
    for (const hex of [
      withWitnesses([TX.witnesses[0]!, ['ab'.repeat(0xfd)]]),
      withWitnesses([TX.witnesses[0]!, ['ab'.repeat(0x10000)]]),
      withWitnesses([[''], []]),
    ]) {
      await expect(serving(Client, hex).getTxHex(P2MR_TX.txid)).resolves.toBe(hex)
    }
  })
})

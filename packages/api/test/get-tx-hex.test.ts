import { readFileSync } from 'node:fs'

import { sha256 } from '@noble/hashes/sha2'
import { describe, expect, it } from 'vitest'

import { EsploraClient, MempoolQbitClient, QbitApiError, txidFromRawTx } from '../src/index'

// mempool.qbit.org once answered `GET /api/tx/<txid>/hex` with 200 and an
// empty text/plain body, and getTxHex resolved with ''. It now checks the
// reply is the requested transaction before returning it.

const BASE = 'https://esplora.example/regtest/api'
/** BASE as errors show it: the origin, with the base path redacted. */
const SAFE_BASE = 'https://esplora.example/...'

/** A real P2MR transaction with witness data (BIP144 encoding) and its txid. */
const P2MR_TX = JSON.parse(readFileSync(new URL('./fixtures/p2mr-witness-tx.json', import.meta.url), 'utf8')) as {
  unsignedTxHex: string
  rawTxHex: string
  txid: string
}

/** A one-input, one-output legacy transaction and its txid, computed independently. */
const LEGACY_TX_HEX =
  '020000000111111111111111111111111111111111111111111111111111111111111111110000000000ffffffff0100000000000000000000000000'
const LEGACY_TXID = '992393c6db57a325f48e3097a50c45349c3eb27df5160a68cbb7a022f98c2dc2'

const CLIENTS = [
  ['EsploraClient', EsploraClient],
  ['MempoolQbitClient', MempoolQbitClient],
] as const

function serving(Client: typeof EsploraClient, body: string, status = 200): { client: EsploraClient; urls: string[] } {
  const urls: string[] = []
  const fetchFn = (async (input: RequestInfo | URL) => {
    urls.push(String(input))
    return new Response(body, { status, headers: { 'content-type': 'text/plain' } })
  }) as typeof fetch
  return { client: new Client({ baseUrl: BASE, fetchFn, retries: 0 }), urls }
}

function bytesFromHex(hex: string): Uint8Array {
  return Uint8Array.from(hex.match(/../g)!.map(byte => parseInt(byte, 16)))
}

/** The wtxid: double SHA-256 of the full serialization, witness included. */
function wtxid(hex: string): string {
  return Array.from(sha256(sha256(bytesFromHex(hex))).reverse(), byte => byte.toString(16).padStart(2, '0')).join('')
}

describe.each(CLIENTS)('%s.getTxHex reply validation', (_name, Client) => {
  it('rejects an empty 200 reply as parse', async () => {
    const { client, urls } = serving(Client, '')

    const error = await client.getTxHex(P2MR_TX.txid).catch((caught: unknown) => caught)

    expect(urls).toEqual([`${BASE}/tx/${P2MR_TX.txid}/hex`])
    expect(error).toBeInstanceOf(QbitApiError)
    expect(error).toMatchObject({
      kind: 'parse',
      url: `${SAFE_BASE}/tx/${P2MR_TX.txid}/hex`,
      responseBody: '',
      message: 'transaction hex reply was empty',
    })
  })

  it('rejects a reply of only whitespace as empty', async () => {
    const { client } = serving(Client, ' \r\n\t')
    await expect(client.getTxHex(P2MR_TX.txid)).rejects.toMatchObject({
      kind: 'parse',
      message: 'transaction hex reply was empty',
    })
  })

  it.each([
    ['odd-length hex', LEGACY_TX_HEX.slice(0, -1)],
    ['an HTML page', '<html><body>Bad gateway</body></html>'],
    ['a JSON transaction', JSON.stringify({ txid: LEGACY_TXID, hex: LEGACY_TX_HEX })],
    ['hex with a 0x prefix', `0x${LEGACY_TX_HEX}`],
    ['hex split by a space', `${LEGACY_TX_HEX.slice(0, 10)} ${LEGACY_TX_HEX.slice(10)}`],
    ['hex followed by a non-breaking space', `${LEGACY_TX_HEX} `],
  ])('rejects %s as parse', async (_label, body) => {
    const { client } = serving(Client, body)
    await expect(client.getTxHex(LEGACY_TXID)).rejects.toMatchObject({
      kind: 'parse',
      message: expect.stringMatching(/^transaction hex reply was not even-length hex: /),
    })
  })

  it.each([
    ['bytes that are not a transaction', 'deadbeef'],
    ['a truncated transaction', LEGACY_TX_HEX.slice(0, -2)],
    ['a transaction followed by trailing bytes', `${LEGACY_TX_HEX}00`],
    ['a witness transaction with an unknown flag', `${P2MR_TX.rawTxHex.slice(0, 10)}02${P2MR_TX.rawTxHex.slice(12)}`],
  ])('rejects %s as parse', async (_label, body) => {
    const { client } = serving(Client, body)
    await expect(client.getTxHex(LEGACY_TXID)).rejects.toMatchObject({
      kind: 'parse',
      message: 'transaction hex reply is not a well-formed transaction',
    })
  })

  it('rejects a well-formed transaction other than the one requested', async () => {
    const { client } = serving(Client, LEGACY_TX_HEX)

    await expect(client.getTxHex(P2MR_TX.txid)).rejects.toMatchObject({
      kind: 'parse',
      url: `${SAFE_BASE}/tx/${P2MR_TX.txid}/hex`,
      message: `transaction hex reply is transaction ${LEGACY_TXID}, not the one requested`,
    })
  })

  it('returns a witness transaction requested by its txid', async () => {
    const { client } = serving(Client, P2MR_TX.rawTxHex)
    await expect(client.getTxHex(P2MR_TX.txid)).resolves.toBe(P2MR_TX.rawTxHex)
  })

  it('compares the txid, not the wtxid, which a witness transaction does not share', async () => {
    const witnessId = wtxid(P2MR_TX.rawTxHex)
    expect(witnessId).not.toBe(P2MR_TX.txid)
    const { client } = serving(Client, P2MR_TX.rawTxHex)

    await expect(client.getTxHex(witnessId)).rejects.toMatchObject({
      kind: 'parse',
      message: `transaction hex reply is transaction ${P2MR_TX.txid}, not the one requested`,
    })
  })

  it('accepts the witness-stripped serialization, since the txid does not commit to witnesses', async () => {
    // Documented limitation: only a wtxid comparison could catch this.
    expect(txidFromRawTx(P2MR_TX.unsignedTxHex)).toBe(P2MR_TX.txid)
    const { client } = serving(Client, P2MR_TX.unsignedTxHex)
    await expect(client.getTxHex(P2MR_TX.txid)).resolves.toBe(P2MR_TX.unsignedTxHex)
  })

  it('returns a legacy transaction', async () => {
    const { client } = serving(Client, LEGACY_TX_HEX)
    await expect(client.getTxHex(LEGACY_TXID)).resolves.toBe(LEGACY_TX_HEX)
  })

  it('compares the txid case-insensitively and returns lowercase hex', async () => {
    const { client, urls } = serving(Client, LEGACY_TX_HEX.toUpperCase())
    await expect(client.getTxHex(LEGACY_TXID.toUpperCase())).resolves.toBe(LEGACY_TX_HEX)
    expect(urls).toEqual([`${BASE}/tx/${LEGACY_TXID.toUpperCase()}/hex`])
  })

  it('ignores the line break a REST server appends, as qbit Core REST does', async () => {
    const { client } = serving(Client, `\r\n ${LEGACY_TX_HEX}\n`)
    await expect(client.getTxHex(LEGACY_TXID)).resolves.toBe(LEGACY_TX_HEX)
  })

  it('still reports a missing transaction as not_found', async () => {
    const { client } = serving(Client, 'Transaction not found', 404)
    await expect(client.getTxHex(LEGACY_TXID)).rejects.toMatchObject({
      kind: 'not_found',
      status: 404,
      responseBody: 'Transaction not found',
    })
  })
})

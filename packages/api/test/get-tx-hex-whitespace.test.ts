import { describe, expect, it } from 'vitest'

import { EsploraClient, MempoolQbitClient, QbitApiError } from '../src/index'

// getTxHex used to trim the reply with /^[\t\n\r ]+|[\t\n\r ]+$/g, which
// backtracks quadratically over a whitespace run inside the body ('a' + 80k
// spaces + 'a' took seconds). The work is synchronous, so neither `deadlineMs`
// nor a signal could interrupt it, and a reply body is unbounded: a hostile
// backend could freeze the event loop for minutes. The trim is now an index scan.

const BASE = 'https://esplora.example/api'

/** A one-input, one-output legacy transaction and its txid, computed independently. */
const LEGACY_TX_HEX =
  '020000000111111111111111111111111111111111111111111111111111111111111111110000000000ffffffff0100000000000000000000000000'
const LEGACY_TXID = '992393c6db57a325f48e3097a50c45349c3eb27df5160a68cbb7a022f98c2dc2'

const CLIENTS = [
  ['EsploraClient', EsploraClient],
  ['MempoolQbitClient', MempoolQbitClient],
] as const

/** Well under the quadratic trim's time for these bodies, and well over a linear one's. */
const LINEAR_BUDGET_MS = 1000

function serving(Client: typeof EsploraClient, body: string): EsploraClient {
  const fetchFn = (async () => new Response(body, { status: 200, headers: { 'content-type': 'text/plain' } })) as typeof fetch
  return new Client({ baseUrl: BASE, fetchFn, retries: 0 })
}

async function timedRejection(client: EsploraClient, txid: string): Promise<{ error: unknown; ms: number }> {
  const started = performance.now()
  const error = await client.getTxHex(txid).catch((caught: unknown) => caught)
  return { error, ms: performance.now() - started }
}

describe.each(CLIENTS)('%s.getTxHex whitespace trim', (_name, Client) => {
  it('rejects a million-space run inside the reply as parse, in linear time', async () => {
    const client = serving(Client, `a${' '.repeat(1_000_000)}a`)

    const { error, ms } = await timedRejection(client, LEGACY_TXID)

    expect(error).toBeInstanceOf(QbitApiError)
    expect(error).toMatchObject({ kind: 'parse' })
    expect((error as QbitApiError).message).toContain('was not even-length hex')
    expect(ms).toBeLessThan(LINEAR_BUDGET_MS)
  })

  it('rejects a 1 MB all-whitespace reply as empty, in linear time', async () => {
    const client = serving(Client, ' \t\r\n'.repeat(250_000))

    const { error, ms } = await timedRejection(client, LEGACY_TXID)

    expect(error).toMatchObject({ kind: 'parse', message: 'transaction hex reply was empty' })
    expect(ms).toBeLessThan(LINEAR_BUDGET_MS)
  })

  it('accepts the transaction behind long runs of spaces, tabs, CR and LF', async () => {
    const padding = ' \t\r\n'.repeat(100_000)
    const client = serving(Client, `${padding}${LEGACY_TX_HEX.toUpperCase()}${padding}`)

    const started = performance.now()
    await expect(client.getTxHex(LEGACY_TXID)).resolves.toBe(LEGACY_TX_HEX)
    expect(performance.now() - started).toBeLessThan(LINEAR_BUDGET_MS)
  })

  it.each([
    ['a no-break space', '\u00a0'],
    ['a vertical tab', '\v'],
    ['a form feed', '\f'],
    ['a byte order mark', '\ufeff'],
    ['a line separator', '\u2028'],
    ['an ideographic space', '\u3000'],
  ])('still rejects %s around the hex', async (_label, char) => {
    // Never first in the body: Response.text() drops a leading BOM as it decodes.
    for (const body of [`\n${char}${LEGACY_TX_HEX}`, `${LEGACY_TX_HEX}${char}`, ` ${char}${LEGACY_TX_HEX}\n`]) {
      const { error } = await timedRejection(serving(Client, body), LEGACY_TXID)
      expect(error).toMatchObject({ kind: 'parse' })
      expect((error as QbitApiError).message).toContain('was not even-length hex')
    }
  })
})

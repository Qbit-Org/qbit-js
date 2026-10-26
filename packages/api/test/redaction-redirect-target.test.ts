import { inspect } from 'node:util'

import { describe, expect, it } from 'vitest'

import { EsploraClient, MempoolQbitClient, QbitApiError } from '../src/index'

const noSleep = () => Promise.resolve()

/** A mocked fetch whose responses report `url` (the request URL unless given). */
function fetchReplying(reply: (url: string, call: number) => { response: Response; url?: string }) {
  const calls: string[] = []
  const fetchFn = (async (input: RequestInfo | URL) => {
    const url = String(input)
    calls.push(url)
    const { response, url: reported } = reply(url, calls.length - 1)
    return Object.defineProperty(response, 'url', { value: reported ?? url })
  }) as typeof fetch
  return { fetchFn, calls }
}

async function rejection(promise: Promise<unknown>): Promise<QbitApiError> {
  const error = await promise.then(
    () => undefined,
    (reason: unknown) => reason
  )
  expect(error).toBeInstanceOf(QbitApiError)
  return error as QbitApiError
}

function logged(error: QbitApiError): string {
  return [error.message, String(error), error.stack ?? '', inspect(error), JSON.stringify(error)].join('\n')
}

describe('redirect targets in error messages', () => {
  const TOKEN = '9f86d081884c7d659a2feaa0c55ad015'
  const BASE = `https://indexer.example/v1/${TOKEN}/api`

  it('redacts a base-URL token the server moved into the Location host', async () => {
    const { fetchFn } = fetchReplying(() => ({
      response: new Response(null, { status: 302, headers: { location: `https://${TOKEN}.indexer.example/api` } }),
    }))
    const error = await rejection(new EsploraClient({ baseUrl: BASE, fetchFn, retries: 0 }).getTipHash())
    expect(error.message).toContain('redirect to')
    expect(logged(error)).not.toContain(TOKEN)
  })

  it('redacts it from a redirect the runtime followed', async () => {
    const { fetchFn } = fetchReplying(() => ({
      response: new Response('00'.repeat(32)),
      url: `https://${TOKEN}.indexer.example/api/blocks/tip/hash`,
    }))
    const error = await rejection(new EsploraClient({ baseUrl: BASE, fetchFn, retries: 0 }).getTipHash())
    expect(error.message).toContain('followed a redirect')
    expect(logged(error)).not.toContain(TOKEN)
  })

  it('matches a mixed-case token in a lowercased host', async () => {
    const mixed = 'AbCdEf0123456789'
    const { fetchFn } = fetchReplying(() => ({
      response: new Response(null, { status: 301, headers: { location: `https://${mixed}.evil.example/` } }),
    }))
    const error = await rejection(
      new EsploraClient({ baseUrl: `https://indexer.example/${mixed}/api`, fetchFn, retries: 0 }).getTipHash()
    )
    expect(logged(error).toLowerCase()).not.toContain(mixed.toLowerCase())
  })
})

describe('the /tx/push fallback reads the unredacted reply', () => {
  it('still falls back when a base-URL part is a word of the reply', async () => {
    // `broadcast` is an 8+ character base-URL part, so it is redacted from
    // responseBody; the fallback decision must not see "Failed to ... transaction".
    const base = 'https://indexer.example/broadcast/api/v1'
    const { fetchFn, calls } = fetchReplying((_url, call) =>
      call === 0
        ? { response: new Response('Failed to broadcast transaction', { status: 400 }) }
        : { response: new Response('ab'.repeat(32)) }
    )
    const client = new MempoolQbitClient({ baseUrl: base, fetchFn, sleepFn: noSleep })
    // With no txid derivable from the hex, only a bare txid reply resolves.
    await expect(client.broadcastTx('0200000000ffff')).resolves.toBe('ab'.repeat(32))
    expect(calls[1]).toBe(`${base}/tx/push`)
  })
})

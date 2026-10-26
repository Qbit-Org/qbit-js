import { inspect } from 'node:util'

import { describe, expect, it } from 'vitest'

import { EsploraClient, QbitApiError } from '../src/index'

const TOKEN = 'SECRETTOKEN0123456789'
const BASE = `https://indexer.example/v1/${TOKEN}/api`

function client(body: string) {
  const fetchFn = (async (input: RequestInfo | URL) =>
    Object.defineProperty(new Response(body, { status: 200 }), 'url', { value: String(input) })) as typeof fetch
  return new EsploraClient({ baseUrl: BASE, fetchFn, retries: 0 })
}

async function parseError(body: string): Promise<QbitApiError> {
  const error = await client(body)
    .getAddressStats('qbrt1zqqqsyqcyq5rqwzqfpg9scrgwpugpzysnzs23v9ccrydpk8qarc0s8kqqny')
    .then(
      () => undefined,
      (reason: unknown) => reason
    )
  expect(error).toBeInstanceOf(QbitApiError)
  return error as QbitApiError
}

describe('a JSON parse error does not quote a cut-off base-URL token', () => {
  it.each([
    ['a body that starts with the token', `${TOKEN} is not JSON`],
    ['a body that starts with the base path', `/v1/${TOKEN}/api is not JSON`],
  ])('%s', async (_case, body) => {
    const error = await parseError(body)
    expect(error.kind).toBe('parse')
    const logged = [
      error.message,
      String(error),
      String(error.cause),
      inspect(error, { depth: 10 }),
      JSON.stringify(error),
      JSON.stringify(error.cause, Object.getOwnPropertyNames(error.cause as object)),
    ].join('\n')
    // V8 quotes about 10 characters of the body: "SECRETTOKE"...
    expect(logged).not.toContain(TOKEN.slice(0, 6))
    // The original error is still available to the caller on purpose.
    expect(QbitApiError.unredactedCause(error)).toBeInstanceOf(SyntaxError)
  })
})

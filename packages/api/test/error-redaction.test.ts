import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { inspect } from 'node:util'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { EsploraClient, MempoolQbitClient, QbitApiError } from '../src/index'

const SECRET = 'TOKEN-abc123'
const BASE = `https://indexer.example/v1/${SECRET}/api`
const SAFE_BASE = 'https://indexer.example/...'
const ADDR = 'qbrt1zqqqsyqcyq5rqwzqfpg9scrgwpugpzysnzs23v9ccrydpk8qarc0s8kqqny'

const noSleep = () => Promise.resolve()

interface Reply {
  status?: number
  body?: string
}

/** A mocked fetch whose responses report the request URL, as real fetch does. */
function fetchReplying(reply: (url: string) => Reply | Response): {
  fetchFn: typeof fetch
  calls: string[]
} {
  const calls: string[] = []
  const fetchFn = (async (input: RequestInfo | URL) => {
    const url = String(input)
    calls.push(url)
    const value = reply(url)
    const response = value instanceof Response ? value : new Response(value.body ?? '', { status: value.status ?? 200 })
    return Object.defineProperty(response, 'url', { value: url })
  }) as typeof fetch
  return { fetchFn, calls }
}

/** A reply whose body stream fails with `error` once read. */
function failingBody(error: unknown, init?: ResponseInit): Response {
  return new Response(
    new ReadableStream({
      pull(controller) {
        controller.error(error)
      },
    }),
    init
  )
}

async function rejection(promise: Promise<unknown>): Promise<QbitApiError> {
  const error = await promise.then(
    () => undefined,
    (reason: unknown) => reason
  )
  expect(error).toBeInstanceOf(QbitApiError)
  return error as QbitApiError
}

/**
 * Everything a logger or error reporter typically records about the error.
 * `inspect` is what `console.error` prints, `cause` chain included; unbounded
 * depth covers reporters that walk the whole chain.
 */
function loggedForms(error: QbitApiError): string[] {
  return [
    error.message,
    String(error.url),
    String(error),
    JSON.stringify(error),
    error.stack ?? '',
    inspect(error),
    inspect(error, { depth: Infinity }),
    inspect(error, { depth: Infinity, showHidden: true }),
    JSON.stringify(error, Object.getOwnPropertyNames(error)),
  ]
}

function expectNoSecret(error: QbitApiError, secret = SECRET): void {
  for (const text of loggedForms(error)) expect(text).not.toContain(secret)
}

describe('error URL redaction', () => {
  it('redacts the base path from an HTTP error', async () => {
    const { fetchFn } = fetchReplying(() => ({ status: 500, body: 'boom' }))
    const client = new EsploraClient({ baseUrl: BASE, fetchFn, retries: 0, sleepFn: noSleep })

    const error = await rejection(client.getTipHeight())

    expect(error).toMatchObject({
      kind: 'http',
      status: 500,
      url: `${SAFE_BASE}/blocks/tip/height`,
      message: `HTTP 500 from ${SAFE_BASE}/blocks/tip/height: boom`,
    })
    expectNoSecret(error)
  })

  it.each([
    ['a runtime that names no URL', () => new TypeError('Failed to fetch')],
    ['node-fetch quoting the normalized URL', (url: string) => new TypeError(`request to ${new URL(url).href} failed, reason: connect ECONNREFUSED`)],
    ['undici quoting the configured URL', (url: string) => new TypeError(`Failed to parse URL from ${url}`)],
  ])('redacts the base path from a network error from %s', async (_case, makeError) => {
    const baseUrl = `HTTPS://Indexer.Example/v1/${SECRET}/api`
    const client = new EsploraClient({
      baseUrl,
      retries: 0,
      sleepFn: noSleep,
      fetchFn: (async (input: RequestInfo | URL) => {
        throw makeError(String(input))
      }) as typeof fetch,
    })

    const error = await rejection(client.getAddressUtxos(ADDR))

    expect(error).toMatchObject({ kind: 'network', url: `${SAFE_BASE}/address/${ADDR}/utxo` })
    expect(error.message).toMatch(new RegExp(`^network error: ${SAFE_BASE.replace(/\./g, '\\.')}/address/${ADDR}/utxo \\(TypeError: `))
    expectNoSecret(error)
    // cause is a redacted copy; the underlying error stays reachable for programmatic inspection.
    expect(error.cause).toBeInstanceOf(TypeError)
    expect(QbitApiError.unredactedCause(error)).toBeInstanceOf(TypeError)
  })

  it('redacts the base path from a timeout', async () => {
    const client = new EsploraClient({
      baseUrl: BASE,
      retries: 0,
      timeoutMs: 5,
      sleepFn: noSleep,
      fetchFn: ((_input: RequestInfo | URL, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () =>
            reject(new DOMException('This operation was aborted', 'AbortError'))
          )
        })) as typeof fetch,
    })

    const error = await rejection(client.getTipHash())

    expect(error).toMatchObject({
      kind: 'timeout',
      url: `${SAFE_BASE}/blocks/tip/hash`,
      message: `request timed out after 5ms: ${SAFE_BASE}/blocks/tip/hash (AbortError: This operation was aborted)`,
    })
    expectNoSecret(error)
  })

  it('redacts the base path from parse and body-read errors', async () => {
    const { fetchFn } = fetchReplying(url =>
      url.endsWith('/fee-estimates') ? { body: 'not json' } : failingBody(new TypeError(`terminated: ${url}`))
    )
    const client = new EsploraClient({ baseUrl: BASE, fetchFn, sleepFn: noSleep })

    const parse = await rejection(client.getFeeEstimates())
    expect(parse).toMatchObject({
      kind: 'parse',
      url: `${SAFE_BASE}/fee-estimates`,
      message: 'failed to parse JSON from /fee-estimates',
    })
    expectNoSecret(parse)

    const read = await rejection(client.getTipHash())
    expect(read).toMatchObject({
      kind: 'parse',
      url: `${SAFE_BASE}/blocks/tip/hash`,
      message: `failed to read response body from ${SAFE_BASE}/blocks/tip/hash`,
    })
    expectNoSecret(read)
  })

  it('redacts the base path from broadcast and refused-redirect errors', async () => {
    const { fetchFn, calls } = fetchReplying(url => {
      if (url.endsWith('/tx')) return { status: 404, body: 'not found' }
      if (url.endsWith('/tx/push')) return { status: 400, body: 'bad-txns-inputs-missingorspent' }
      return new Response('', { status: 302, headers: { location: `https://mirror.example/v1/${SECRET}/api` } })
    })
    const client = new MempoolQbitClient({ baseUrl: BASE, fetchFn, sleepFn: noSleep })

    const broadcast = await rejection(client.broadcastTx('0200000000ffff'))
    expect(calls.slice(-2)).toEqual([`${BASE}/tx`, `${BASE}/tx/push`])
    expect(broadcast).toMatchObject({ kind: 'http', status: 400, url: `${SAFE_BASE}/tx/push` })
    expectNoSecret(broadcast)

    const redirect = await rejection(client.getTipHash())
    expect(redirect).toMatchObject({
      kind: 'http',
      status: 302,
      url: `${SAFE_BASE}/blocks/tip/hash`,
      message: `HTTP 302 redirect to https://mirror.example refused: ${SAFE_BASE}/blocks/tip/hash`,
    })
    expectNoSecret(redirect)
  })

  it.each([
    ['a numeric password the URL parser takes for a port', 'https://apikey:8443/x@indexer.example/api', 'apikey:8443'],
    ['an @ in its path', 'https://indexer.example/@scope/api', 'indexer.example'],
  ])('shows a base URL with %s as ...', async (_case, baseUrl, secret) => {
    const { fetchFn } = fetchReplying(() => ({ status: 500, body: 'boom' }))
    const client = new EsploraClient({ baseUrl, fetchFn, retries: 0, sleepFn: noSleep })

    const error = await rejection(client.getTipHeight())

    expect(error).toMatchObject({
      url: '.../blocks/tip/height',
      message: 'HTTP 500 from .../blocks/tip/height: boom',
    })
    expectNoSecret(error, secret)
    expectNoSecret(error, secret.toLowerCase())
  })

  it('shows a base URL with a port or an IPv6 host by origin', async () => {
    const { fetchFn } = fetchReplying(() => ({ status: 500, body: 'boom' }))
    for (const [baseUrl, safeBase] of [
      ['https://Indexer.Example:8443/api', 'https://indexer.example:8443/...'],
      ['https://[2001:DB8::1]/api', 'https://[2001:db8::1]/...'],
    ]) {
      const client = new EsploraClient({ baseUrl: baseUrl!, fetchFn, retries: 0, sleepFn: noSleep })

      expect((await rejection(client.getTipHeight())).url).toBe(`${safeBase}/blocks/tip/height`)
    }
  })

  it('shows a base URL without a path in full', async () => {
    const { fetchFn } = fetchReplying(() => ({ status: 500, body: 'boom' }))
    const client = new EsploraClient({ baseUrl: 'https://indexer.example/', fetchFn, retries: 0, sleepFn: noSleep })

    await expect(client.getTipHeight()).rejects.toMatchObject({
      url: 'https://indexer.example/blocks/tip/height',
      message: 'HTTP 500 from https://indexer.example/blocks/tip/height: boom',
    })
  })
})

describe('response text in error messages', () => {
  const HOSTILE = 'boom\r\n2026-10-22T00:00:00Z INFO payment confirmed\u2028\u001b[31m\u202Eevil\t'

  it('escapes control characters in HTTP error messages but not in responseBody', async () => {
    const { fetchFn } = fetchReplying(() => ({ status: 400, body: `  ${HOSTILE}  ` }))
    const client = new EsploraClient({ baseUrl: BASE, fetchFn, sleepFn: noSleep })

    const error = await rejection(client.getAddressUtxos(ADDR))

    expect(error.message).toBe(
      `HTTP 400 from ${SAFE_BASE}/address/${ADDR}/utxo: ` +
        'boom\\r\\n2026-10-22T00:00:00Z INFO payment confirmed\\u2028\\u001b[31m\\u202eevil'
    )
    expect(String(error)).not.toMatch(/[\r\n\u2028\u001b\u202e]/)
    expect(error.responseBody).toBe(HOSTILE.trim())
  })

  it('escapes control characters in a malformed tip height', async () => {
    const { fetchFn } = fetchReplying(() => ({ body: '12\nERROR forged' }))
    const client = new EsploraClient({ baseUrl: BASE, fetchFn, sleepFn: noSleep })

    await expect(client.getTipHeight()).rejects.toMatchObject({
      kind: 'parse',
      message: 'tip height was not an integer: 12\\nERROR forged',
    })
  })

  it('escapes control characters in a server-supplied history cursor', async () => {
    const page = Array.from({ length: 10 }, (_, index) => ({
      txid: index === 9 ? 'evil\ncursor' : `${index}`.repeat(64),
      status: { confirmed: false },
    }))
    const { fetchFn } = fetchReplying(() => ({ body: JSON.stringify(page) }))
    const client = new MempoolQbitClient({ baseUrl: BASE, fetchFn, sleepFn: noSleep })

    const error = await rejection(client.getAddressMempoolTxs(ADDR))

    expect(error.kind).toBe('invalid_cursor')
    expect(error.message).toContain('cursor stopped advancing: evil\\ncursor')
    expect(error.message).not.toContain('\n')
  })
})

describe('error URL redaction with the runtime fetch', () => {
  async function listen(
    handler: (request: IncomingMessage, response: ServerResponse) => void
  ): Promise<{ server: Server; origin: string }> {
    const server = createServer(handler)
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const { port } = server.address() as AddressInfo
    return { server, origin: `http://127.0.0.1:${port}` }
  }

  function close(server: Server): Promise<void> {
    server.closeAllConnections()
    return new Promise(resolve => server.close(() => resolve()))
  }

  it('redacts HTTP and connection errors', async () => {
    const backend = await listen((_request, response) => {
      response.writeHead(500)
      response.end('boom\r\nforged')
    })
    const closed = await listen(() => undefined)
    await close(closed.server)

    try {
      const client = new EsploraClient({ baseUrl: `${backend.origin}/v1/${SECRET}/api`, retries: 0 })
      const http = await rejection(client.getTipHeight())
      expect(http).toMatchObject({
        kind: 'http',
        url: `${backend.origin}/.../blocks/tip/height`,
        message: `HTTP 500 from ${backend.origin}/.../blocks/tip/height: boom\\r\\nforged`,
      })
      expectNoSecret(http)

      const offline = new EsploraClient({ baseUrl: `${closed.origin}/v1/${SECRET}/api`, retries: 0 })
      const network = await rejection(offline.getTipHeight())
      expect(network).toMatchObject({ kind: 'network', url: `${closed.origin}/.../blocks/tip/height` })
      expectNoSecret(network)
    } finally {
      await close(backend.server)
    }
  })
})

describe('redacted error causes', () => {
  function throwingFetch(makeError: (url: string) => unknown): typeof fetch {
    return (async (input: RequestInfo | URL) => {
      throw makeError(String(input))
    }) as typeof fetch
  }

  it('redacts a Bun-style path property and a nested cause, keeping the original off the error', async () => {
    const client = new EsploraClient({
      baseUrl: BASE,
      retries: 0,
      sleepFn: noSleep,
      fetchFn: throwingFetch(url => {
        const inner = Object.assign(new Error(`connect ECONNREFUSED ${new URL(url).href}`), {
          code: 'ECONNREFUSED',
          url,
        })
        return Object.assign(
          new TypeError('Unable to connect. Is the computer able to access the url?', { cause: inner }),
          { path: url, code: 'ConnectionRefused' }
        )
      }),
    })

    const error = await rejection(client.getTipHeight())

    expectNoSecret(error)
    expect(error.cause).toBeInstanceOf(TypeError)
    expect(error.cause).toMatchObject({
      name: 'TypeError',
      message: 'Unable to connect. Is the computer able to access the url?',
      path: `${SAFE_BASE}/blocks/tip/height`,
      code: 'ConnectionRefused',
    })
    const cause = error.cause as Error & { path: string }
    expect(cause.stack).toMatch(/^TypeError: Unable to connect/)
    expect(cause.cause).toMatchObject({
      message: `connect ECONNREFUSED ${SAFE_BASE}/blocks/tip/height`,
      code: 'ECONNREFUSED',
      url: `${SAFE_BASE}/blocks/tip/height`,
    })
    expect(Object.getOwnPropertyDescriptor(cause, 'cause')?.enumerable).toBe(false)
    // The original stays reachable for debugging, but not through the error object.
    expect((QbitApiError.unredactedCause(error) as { path: string }).path).toBe(`${BASE}/blocks/tip/height`)
    expect(Object.getOwnPropertyNames(error)).not.toContain('unredactedCause')
    expect('unredactedCause' in error).toBe(false)
  })

  it('reads the original only through QbitApiError.unredactedCause', () => {
    const original = new TypeError(`fetch failed: ${BASE}/blocks/tip/height`)
    const error = new QbitApiError('network', 'network error', { cause: 'redacted', unredactedCause: original })

    expect(QbitApiError.unredactedCause(error)).toBe(original)
    expect(Reflect.ownKeys(error)).not.toContain('unredactedCause')
    expect(inspect(error, { showHidden: true, depth: Infinity })).not.toContain(SECRET)
    expect(JSON.stringify(error, Object.getOwnPropertyNames(error))).not.toContain(SECRET)
    for (const value of [new QbitApiError('http', 'x'), new Error('x'), {}, null, undefined, 'x']) {
      expect(QbitApiError.unredactedCause(value)).toBeUndefined()
    }
  })

  it('keeps the name of a non-built-in error and drops values it cannot copy', async () => {
    class FetchError extends Error {
      override name = 'FetchError'
      readonly request = new Request('https://indexer.example/')
    }
    const client = new EsploraClient({
      baseUrl: BASE,
      retries: 0,
      sleepFn: noSleep,
      fetchFn: throwingFetch(url =>
        Object.assign(new FetchError(`request to ${url} failed`), {
          details: { url, attempts: [url], at: 3 },
          log: () => url,
        })
      ),
    })

    const error = await rejection(client.getTipHeight())

    expectNoSecret(error)
    expect(error.cause).not.toBeInstanceOf(FetchError)
    expect(error.cause).toMatchObject({
      name: 'FetchError',
      message: `request to ${SAFE_BASE}/blocks/tip/height failed`,
      details: { url: `${SAFE_BASE}/blocks/tip/height`, attempts: [`${SAFE_BASE}/blocks/tip/height`], at: 3 },
    })
    expect(error.cause).not.toHaveProperty('request')
    expect(error.cause).not.toHaveProperty('log')
  })

  it('bounds a cyclic cause chain', async () => {
    const client = new EsploraClient({
      baseUrl: BASE,
      retries: 0,
      sleepFn: noSleep,
      fetchFn: throwingFetch(url => {
        const error = new TypeError(`fetch failed: ${url}`)
        error.cause = error
        return error
      }),
    })

    const error = await rejection(client.getTipHeight())

    expectNoSecret(error)
    let depth = 0
    for (let cause = error.cause; cause instanceof Error; cause = cause.cause) depth += 1
    expect(depth).toBe(5)
  })

  it('redacts a string thrown in place of an error', async () => {
    const client = new EsploraClient({ baseUrl: BASE, retries: 0, sleepFn: noSleep, fetchFn: throwingFetch(url => url) })

    const error = await rejection(client.getTipHeight())

    expect(error.cause).toBe(`${SAFE_BASE}/blocks/tip/height`)
    expect(QbitApiError.unredactedCause(error)).toBe(`${BASE}/blocks/tip/height`)
    expectNoSecret(error)
  })

  it('redacts the cause of a body-read and a JSON parse error', async () => {
    const { fetchFn } = fetchReplying(url =>
      url.endsWith('/fee-estimates')
        ? { body: `{"x": "${url}"` }
        : failingBody(Object.assign(new TypeError('terminated'), { url }))
    )
    const client = new EsploraClient({ baseUrl: BASE, fetchFn, sleepFn: noSleep })

    const parse = await rejection(client.getFeeEstimates())
    expect(parse.cause).toBeInstanceOf(SyntaxError)
    expectNoSecret(parse)

    const read = await rejection(client.getTipHash())
    expect(read.cause).toMatchObject({ message: 'terminated', url: `${SAFE_BASE}/blocks/tip/hash` })
    expectNoSecret(read)
  })
})

describe('response text quoting the base path', () => {
  const EXPRESS_404 = (path: string) =>
    '<!DOCTYPE html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n<title>Error</title>\n</head>\n' +
    `<body>\n<pre>Cannot GET ${path}</pre>\n</body>\n</html>\n`

  it('redacts the base path from an HTTP error message and responseBody', async () => {
    const { fetchFn } = fetchReplying(url => ({ status: 404, body: EXPRESS_404(new URL(url).pathname) }))
    const client = new EsploraClient({ baseUrl: BASE, fetchFn, sleepFn: noSleep })

    const error = await rejection(client.getTipHeight())

    expect(error.kind).toBe('not_found')
    expect(error.message).toContain('<pre>Cannot GET /.../blocks/tip/height</pre>')
    // Otherwise intact: not escaped.
    expect(error.responseBody).toBe(EXPRESS_404('/.../blocks/tip/height').trim())
    expectNoSecret(error)
  })

  it.each([
    ['quoted alone', `invalid api key ${SECRET}`, 'invalid api key ...'],
    [
      'JSON-escaped',
      `{"error":"Cannot GET \\/v1\\/${SECRET}\\/api\\/blocks\\/tip\\/height"}`,
      '{"error":"Cannot GET \\/v1\\/...\\/api\\/blocks\\/tip\\/height"}',
    ],
    ['%2F-joined', `no route %2Fv1%2F${SECRET}%2Fapi%2Fblocks`, 'no route %2Fv1%2F...%2Fapi%2Fblocks'],
  ])('redacts a base-path segment %s', async (_case, body, redacted) => {
    const { fetchFn } = fetchReplying(() => ({ status: 401, body }))
    const client = new EsploraClient({ baseUrl: BASE, fetchFn, sleepFn: noSleep })

    const error = await rejection(client.getTipHeight())

    expect(error.message).toBe(`HTTP 401 from ${SAFE_BASE}/blocks/tip/height: ${redacted}`)
    expect(error.responseBody).toBe(redacted)
    expectNoSecret(error)
  })

  it('redacts percent-decoded segments, but not short or re-cased parts', async () => {
    const parts = ['tok+en-segment', 'tok%2Ben-segment', SECRET]
    const { fetchFn } = fetchReplying(() => ({
      status: 403,
      body: `${parts.join(' ')} short1 ${SECRET.toLowerCase()}`,
    }))
    const client = new EsploraClient({
      baseUrl: `https://indexer.example/short1/tok%2Ben-segment/${SECRET}/api`,
      fetchFn,
      sleepFn: noSleep,
    })

    const error = await rejection(client.getTipHeight())

    expect(error.responseBody).toBe(`... ... ... short1 ${SECRET.toLowerCase()}`)
    for (const part of parts) expectNoSecret(error, part)
  })

  it('redacts a quoted full URL, and the base path before the 200-character cut', async () => {
    const { fetchFn } = fetchReplying(url =>
      url.endsWith('/height')
        ? { status: 502, body: `upstream ${url} failed` }
        : { status: 502, body: `${'x'.repeat(190)} /v1/${SECRET}/api/blocks/tip/hash` }
    )
    const client = new EsploraClient({ baseUrl: BASE, fetchFn, retries: 0, sleepFn: noSleep })

    expect((await rejection(client.getTipHeight())).message).toBe(
      `HTTP 502 from ${SAFE_BASE}/blocks/tip/height: upstream ${SAFE_BASE}/blocks/tip/height failed`
    )
    const cut = await rejection(client.getTipHash())
    expect(cut.message).not.toContain('TOKEN')
    expect(cut.message).toMatch(/x \/\.\.\.\/bloc$/)
  })

  it('gives a malformed tip height a url and responseBody, and redacts its message', async () => {
    const body = `  <html>proxy error at /v1/${SECRET}/api/blocks/tip/height</html>  `
    const { fetchFn } = fetchReplying(() => ({ body }))
    const client = new EsploraClient({ baseUrl: BASE, fetchFn, sleepFn: noSleep })

    const error = await rejection(client.getTipHeight())

    expect(error).toMatchObject({
      kind: 'parse',
      url: `${SAFE_BASE}/blocks/tip/height`,
      message: 'tip height was not an integer: <html>proxy error at /.../blocks/tip/height</html>',
      responseBody: '<html>proxy error at /.../blocks/tip/height</html>',
    })
    expectNoSecret(error)
  })

  it('redacts the base path from a server-supplied history cursor', async () => {
    const page = Array.from({ length: 10 }, (_, index) => ({
      txid: index === 9 ? `/v1/${SECRET}/api` : `${index}`.repeat(64),
      status: { confirmed: false },
    }))
    const { fetchFn } = fetchReplying(() => ({ body: JSON.stringify(page) }))
    const client = new MempoolQbitClient({ baseUrl: BASE, fetchFn, sleepFn: noSleep })

    const error = await rejection(client.getAddressMempoolTxs(ADDR))

    expect(error.message).toContain('cursor stopped advancing: /... (')
    expectNoSecret(error)
  })
})

describe('error sites of rate limiting, body timeouts, cancellation and broadcast outcomes', () => {
  const TXID = 'ab'.repeat(32)
  const HEX = '0200000000ffff'

  /** A reply whose body sends a first chunk and then stalls. */
  function stallingBody(status = 200): Response {
    return new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('0000'))
        },
      }),
      { status }
    )
  }

  /** A fetch that never answers and rejects once its signal aborts, quoting the URL. */
  function hangingFetch(signals: AbortSignal[] = []): typeof fetch {
    return ((input: RequestInfo | URL, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        signals.push(init!.signal!)
        init!.signal!.addEventListener('abort', () =>
          reject(Object.assign(new DOMException(`aborted: ${String(input)}`, 'AbortError'), { url: String(input) }))
        )
      })) as typeof fetch
  }

  it('redacts a body that stalls past timeoutMs (the body timeout error)', async () => {
    const client = new EsploraClient({
      baseUrl: BASE,
      retries: 0,
      timeoutMs: 20,
      sleepFn: noSleep,
      fetchFn: (async () => stallingBody()) as typeof fetch,
    })

    const error = await rejection(client.getTipHash())

    expect(error).toMatchObject({ kind: 'timeout', status: 200, url: `${SAFE_BASE}/blocks/tip/hash` })
    expect(error.message).toMatch(/^request timed out after 20ms: https:\/\/indexer\.example\/\.\.\.\/blocks\/tip\/hash/)
    expectNoSecret(error)
  })

  it('redacts a fetch that rejects with the URL when its attempt times out', async () => {
    const client = new EsploraClient({ baseUrl: BASE, retries: 0, timeoutMs: 5, sleepFn: noSleep, fetchFn: hangingFetch() })

    const error = await rejection(client.getTipHash())

    expect(error).toMatchObject({ kind: 'timeout', url: `${SAFE_BASE}/blocks/tip/hash` })
    expect(error.cause).toMatchObject({ message: `aborted: ${SAFE_BASE}/blocks/tip/hash`, url: `${SAFE_BASE}/blocks/tip/hash` })
    expectNoSecret(error)
  })

  it('redacts the aborted and deadline errors, and the reason an abandoned request gives fetch', async () => {
    const signals: AbortSignal[] = []
    const client = new EsploraClient({ baseUrl: BASE, retries: 0, sleepFn: noSleep, fetchFn: hangingFetch(signals) })
    const controller = new AbortController()

    const pending = rejection(client.getTipHeight({ signal: controller.signal }))
    await new Promise(resolve => setTimeout(resolve, 5))
    controller.abort(new Error('user left the screen'))
    const aborted = await pending
    expect(aborted).toMatchObject({ kind: 'aborted', message: 'request aborted by caller (Error: user left the screen)' })
    expectNoSecret(aborted)
    // The shared GET was abandoned by its only caller; fetch sees why.
    const reason = signals[0]!.reason as QbitApiError
    expect(reason).toMatchObject({ kind: 'aborted', url: `${SAFE_BASE}/blocks/tip/height` })
    expectNoSecret(reason)

    const deadline = await rejection(client.getTipHash({ deadlineMs: 5 }))
    expect(deadline).toMatchObject({ kind: 'timeout', message: 'operation exceeded its 5ms deadline' })
    expectNoSecret(deadline)
  })

  it.each([
    [
      'a 5xx with no node verdict',
      (url: string) => new Response(`upstream ${new URL(url).pathname} failed`, { status: 502 }),
      { status: 502, responseBody: 'upstream /.../tx failed' },
      `HTTP 502 from ${SAFE_BASE}/tx: upstream /.../tx failed`,
    ],
    [
      'a 2xx that does not echo the txid',
      (url: string) => new Response(`<html>${url}</html>`),
      { status: 200, responseBody: `<html>${SAFE_BASE}/tx</html>` },
      `reply did not echo the txid (HTTP 200 from ${SAFE_BASE}/tx: <html>${SAFE_BASE}/tx</html>)`,
    ],
    [
      'an already-known 5xx reply without a txid',
      (url: string) =>
        new Response(`{"code":-27,"message":"Transaction already in block chain","path":"${url}"}`, { status: 500 }),
      { status: 500 },
      `node already knows the transaction: HTTP 500 from ${SAFE_BASE}/tx: `,
    ],
    [
      'a backend relaying a lost node connection',
      (url: string) => new Response(`sendrawtransaction RPC error: {"code":"ECONNRESET","url":"${url}"}`, { status: 400 }),
      { status: 400 },
      `backend lost its node connection (HTTP 400 from ${SAFE_BASE}/tx: `,
    ],
    [
      'a reply whose body cannot be read',
      (url: string) => failingBody(new TypeError(`terminated: ${url}`)),
      { status: 200, cause: { kind: 'parse', url: `${SAFE_BASE}/tx` } },
      'HTTP 200 reply body could not be read',
    ],
    [
      'a refused redirect',
      () => new Response(null, { status: 307, headers: { location: `https://mirror.example/v1/${SECRET}/api/tx` } }),
      { status: 307, cause: { kind: 'http', status: 307 } },
      `HTTP 307 redirect to https://mirror.example refused: ${SAFE_BASE}/tx`,
    ],
  ] as const)('redacts the broadcast unknown_outcome for %s', async (_case, reply, fields, quoted) => {
    const { fetchFn } = fetchReplying(url => reply(url))
    const client = new EsploraClient({ baseUrl: BASE, fetchFn, retries: 0, sleepFn: noSleep })
    const txid = _case.includes('without a txid') ? undefined : TXID

    const error = await rejection(client.broadcastTx(HEX, txid === undefined ? undefined : { txid }))

    expect(error).toMatchObject({ kind: 'unknown_outcome', url: `${SAFE_BASE}/tx`, ...fields })
    expect(error.message).toContain(quoted)
    expectNoSecret(error)
  })

  it.each([
    ['a network error quoting the URL', 'network'],
    ['a timeout', 'timeout'],
  ] as const)('redacts the broadcast unknown_outcome after %s', async (_case, causeKind) => {
    const fetchFn =
      causeKind === 'network'
        ? ((async (input: RequestInfo | URL) => {
            throw Object.assign(new TypeError(`fetch failed: ${String(input)}`), { cause: { url: String(input) } })
          }) as typeof fetch)
        : hangingFetch()
    const client = new EsploraClient({ baseUrl: BASE, fetchFn, retries: 0, timeoutMs: 5, sleepFn: noSleep })

    const error = await rejection(client.broadcastTx(HEX, { txid: TXID }))

    expect(error).toMatchObject({ kind: 'unknown_outcome', url: `${SAFE_BASE}/tx`, cause: { kind: causeKind } })
    expectNoSecret(error)
  })

  it('redacts the abort of an in-flight broadcast', async () => {
    const client = new EsploraClient({ baseUrl: BASE, retries: 0, sleepFn: noSleep, fetchFn: hangingFetch() })
    const controller = new AbortController()

    const pending = rejection(client.broadcastTx(HEX, { txid: TXID, signal: controller.signal }))
    await new Promise(resolve => setTimeout(resolve, 5))
    controller.abort()
    const error = await pending

    expect(error).toMatchObject({ kind: 'unknown_outcome', url: `${SAFE_BASE}/tx`, cause: { kind: 'aborted' } })
    expectNoSecret(error)
  })

  it('redacts rate_limit errors carrying retryAfterMs', async () => {
    const { fetchFn } = fetchReplying(url =>
      url.endsWith('/tx')
        ? failingBody(new TypeError(`terminated: ${url}`), { status: 429, headers: { 'retry-after': '5' } })
        : new Response(`slow down: ${url}`, { status: 429, headers: { 'retry-after': '3600' } })
    )
    const client = new EsploraClient({ baseUrl: BASE, fetchFn, retries: 0, sleepFn: noSleep })

    const read = await rejection(client.getTipHeight())
    expect(read).toMatchObject({
      kind: 'rate_limit',
      status: 429,
      retryAfterMs: 3_600_000,
      url: `${SAFE_BASE}/blocks/tip/height`,
      message: `HTTP 429 from ${SAFE_BASE}/blocks/tip/height: slow down: ${SAFE_BASE}/blocks/tip/height`,
    })
    expectNoSecret(read)

    const submission = await rejection(client.broadcastTx(HEX, { txid: TXID }))
    expect(submission).toMatchObject({
      kind: 'rate_limit',
      status: 429,
      retryAfterMs: 5_000,
      url: `${SAFE_BASE}/tx`,
      message: `HTTP 429 from ${SAFE_BASE}/tx (reply body could not be read)`,
    })
    expectNoSecret(submission)
  })

  it.each([
    ['a token in the query', `https://indexer.example/api?key=${SECRET}`],
    ['a token as the password', `https://user:${SECRET}@indexer.example/api`],
    ['a password with a raw /', `https://apikey:${SECRET}/x@indexer.example/api`],
    ['a token in the fragment', `${BASE}#${SECRET}`],
    ['trailing whitespace', `${BASE} `],
    ['a relative URL', `/v1/${SECRET}/api`],
    ['plain http to a remote host', `http://indexer.example/v1/${SECRET}/api`],
  ])("never echoes a base URL with %s in the constructor's errors", (_case, baseUrl) => {
    for (const Client of [EsploraClient, MempoolQbitClient]) {
      let error: unknown
      try {
        new Client({ baseUrl, fetchFn: fetchReplying(() => ({})).fetchFn })
      } catch (caught) {
        error = caught
      }
      expect(error).toBeInstanceOf(QbitApiError)
      expectNoSecret(error as QbitApiError)
    }
  })

  it('never echoes a valid base URL in the errors for other invalid options', async () => {
    const { fetchFn } = fetchReplying(() => ({}))
    for (const options of [{ timeoutMs: -1 }, { retries: 99 }, { retryBaseDelayMs: Infinity }, { maxRetryAfterMs: 0.5 }]) {
      let error: unknown
      try {
        new EsploraClient({ baseUrl: BASE, fetchFn, ...options })
      } catch (caught) {
        error = caught
      }
      expect(error).toBeInstanceOf(QbitApiError)
      expectNoSecret(error as QbitApiError)
    }
    const deadline = await rejection(new EsploraClient({ baseUrl: BASE, fetchFn }).getTipHeight({ deadlineMs: -1 }))
    expectNoSecret(deadline)
  })

  it('passes a QbitApiError thrown by a custom fetchFn through unchanged', async () => {
    const own = new QbitApiError('network', `offline: ${BASE}/blocks/tip/height`)
    const client = new EsploraClient({
      baseUrl: BASE,
      retries: 0,
      sleepFn: noSleep,
      fetchFn: (async () => {
        throw own
      }) as typeof fetch,
    })

    // The SDK neither wraps nor redacts it: its text is the fetchFn's own.
    await expect(client.getTipHeight()).rejects.toBe(own)
  })
})

/** React Native's global URL before 0.80: it stores the string and its getters throw. */
class ReactNative079URL {
  private readonly _url: string

  constructor(url: string) {
    this._url = url.endsWith('/') ? url : `${url}/`
  }

  get href(): string {
    return this._url
  }

  get origin(): string {
    throw new Error('URL.origin is not implemented')
  }

  get pathname(): string {
    throw new Error('URL.pathname not implemented')
  }
}

/** React Native's global URL from 0.80: its getters are regexes over the configured string. */
class ReactNative080URL {
  private readonly _url: string

  constructor(url: string) {
    this._url = url
  }

  get href(): string {
    return this._url
  }

  get origin(): string {
    const matches = this._url.match(/^(https?:\/\/[^/]+)/)
    return matches ? matches[1]! : ''
  }

  get pathname(): string {
    const pathMatch = this._url.match(/https?:\/\/[^/]+(\/[^?#]*)?/)
    return pathMatch ? pathMatch[1] || '/' : '/'
  }

  get search(): string {
    const searchMatch = this._url.match(/\?([^#]*)/)
    return searchMatch ? `?${searchMatch[1]}` : ''
  }

  get hash(): string {
    const hashMatch = this._url.match(/#([^/]*)/)
    return hashMatch ? `#${hashMatch[1]}` : ''
  }
}

describe.each([
  ['React Native < 0.80', ReactNative079URL],
  ['React Native >= 0.80', ReactNative080URL],
])('error URL redaction with the URL global of %s', (_label, RNURL) => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it.each([
    [`https://Indexer.Example/v1/${SECRET}/api`, SAFE_BASE],
    ['https://Indexer.Example', 'https://indexer.example'],
    [`https://indexer.example/v1/${SECRET}/@scope/api`, '...'],
  ])('shows %s as %s', async (baseUrl, safeBase) => {
    vi.stubGlobal('URL', RNURL)
    const { fetchFn } = fetchReplying(() => ({ status: 500, body: 'boom' }))
    const client = new EsploraClient({ baseUrl, fetchFn, retries: 0, sleepFn: noSleep })

    const error = await rejection(client.getTipHeight())

    expect(error).toMatchObject({ url: `${safeBase}/blocks/tip/height` })
    expectNoSecret(error)
  })
  it.each([
    `https://user:${SECRET}@Indexer.Example/v1/${SECRET}/api`,
    `https://user:${SECRET}@Indexer.Example`,
    `https://apikey:${SECRET}/x@indexer.example/api`,
  ])('rejects %s in the constructor without echoing it', baseUrl => {
    vi.stubGlobal('URL', RNURL)
    const { fetchFn } = fetchReplying(() => ({}))
    let error: unknown
    try {
      new EsploraClient({ baseUrl, fetchFn })
    } catch (caught) {
      error = caught
    }

    expect(error).toBeInstanceOf(QbitApiError)
    expectNoSecret(error as QbitApiError)
  })
})

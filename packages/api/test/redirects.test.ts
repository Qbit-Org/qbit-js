import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'

import { describe, expect, it } from 'vitest'

import { EsploraClient, MempoolQbitClient, QbitApiError } from '../src/index'

const BASE = 'https://esplora.example/regtest/api'
const ADDR = 'qbrt1zqqqsyqcyq5rqwzqfpg9scrgwpugpzysnzs23v9ccrydpk8qarc0s8kqqny'
const FORGED_STATS = {
  address: ADDR,
  chain_stats: { funded_txo_count: 1, funded_txo_sum: 5_000_000_000, spent_txo_count: 0, spent_txo_sum: 0, tx_count: 1 },
  mempool_stats: { funded_txo_count: 0, funded_txo_sum: 0, spent_txo_count: 0, spent_txo_sum: 0, tx_count: 0 },
}
const TXID = 'ab'.repeat(32)

const noSleep = () => Promise.resolve()

interface Reply {
  status?: number
  body?: string
  headers?: Record<string, string>
}

interface Call {
  url: string
  method: string
  headers: Record<string, string>
  redirect: RequestRedirect | undefined
}

/**
 * A mocked fetch that treats redirects the way real fetch does: by default it
 * re-requests `Location` with the same headers, turning a POST into a GET on
 * 301/302/303; with `redirect: 'manual'` it returns the 3xx reply as is.
 */
function redirectingFetch(route: (url: string, method: string) => Reply): {
  fetchFn: typeof fetch
  calls: Call[]
  responses: Response[]
} {
  const calls: Call[] = []
  const responses: Response[] = []
  const fetchFn = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    let url = String(input)
    let method = init.method ?? 'GET'
    for (let hops = 0; ; hops += 1) {
      calls.push({
        url,
        method,
        headers: { ...(init.headers as Record<string, string>) },
        redirect: init.redirect,
      })
      const reply = route(url, method)
      const response = new Response(reply.body ?? '', {
        status: reply.status ?? 200,
        headers: reply.headers,
      })
      responses.push(response)
      const location = response.headers.get('location')
      const follow = (init.redirect ?? 'follow') === 'follow'
      if (!follow || location === null || response.status < 300 || response.status > 399 || hops === 20) {
        return response
      }
      if (response.status === 303 || ((response.status === 301 || response.status === 302) && method === 'POST')) {
        method = 'GET'
      }
      url = new URL(location, url).href
    }
  }) as typeof fetch
  return { fetchFn, calls, responses }
}

async function rejection(promise: Promise<unknown>): Promise<QbitApiError> {
  const error = await promise.then(
    () => undefined,
    (reason: unknown) => reason
  )
  expect(error).toBeInstanceOf(QbitApiError)
  return error as QbitApiError
}

describe('redirects', () => {
  it('refuses a cross-origin 302 without requesting its target', async () => {
    const { fetchFn, calls, responses } = redirectingFetch(url =>
      url.startsWith(BASE)
        ? { status: 302, body: 'moved', headers: { location: 'https://attacker.example/steal/api?k=PATH-SECRET' } }
        : { body: JSON.stringify(FORGED_STATS) }
    )
    const client = new EsploraClient({
      baseUrl: BASE,
      fetchFn,
      sleepFn: noSleep,
      headers: { 'x-api-key': 'SECRET-KEY' },
    })

    const error = await rejection(client.getAddressBalance(ADDR))

    expect(error).toMatchObject({ kind: 'http', status: 302 })
    expect(error.message).toContain('redirect to https://attacker.example refused')
    expect(error.message).not.toContain('/steal')
    expect(error.message).not.toContain('PATH-SECRET')
    // One request, to the backend only: not followed and not retried.
    expect(calls).toEqual([
      { url: `${BASE}/address/${ADDR}`, method: 'GET', headers: { 'x-api-key': 'SECRET-KEY' }, redirect: 'manual' },
    ])
    expect(responses[0]!.bodyUsed).toBe(true)
  })

  it.each([300, 301, 302, 303, 307, 308])('refuses a same-origin HTTP %i on GET', async status => {
    const { fetchFn, calls } = redirectingFetch(url =>
      url.endsWith('/blocks/tip/height') ? { status, headers: { location: `${BASE}/blocks/tip/height/` } } : { body: '7' }
    )
    const client = new EsploraClient({ baseUrl: BASE, fetchFn, sleepFn: noSleep })

    const error = await rejection(client.getTipHeight())

    expect(error).toMatchObject({ kind: 'http', status })
    expect(error.message).toContain(`HTTP ${status} redirect to https://esplora.example refused`)
    expect(calls).toHaveLength(1)
  })

  it('refuses an https to http downgrade', async () => {
    const { fetchFn, calls } = redirectingFetch(url =>
      url.startsWith('https:')
        ? { status: 301, headers: { location: url.replace('https:', 'http:') } }
        : { body: JSON.stringify(FORGED_STATS) }
    )
    const client = new EsploraClient({
      baseUrl: BASE,
      fetchFn,
      sleepFn: noSleep,
      headers: { 'x-api-key': 'SECRET-KEY' },
    })

    const error = await rejection(client.getAddressStats(ADDR))

    expect(error).toMatchObject({ kind: 'http', status: 301 })
    expect(error.message).toContain('redirect to http://esplora.example refused')
    expect(calls.map(call => call.url)).toEqual([`${BASE}/address/${ADDR}`])
  })

  it('names a redirect without a usable Location', async () => {
    const { fetchFn } = redirectingFetch(url =>
      url.endsWith('/hash') ? { status: 302 } : { status: 302, headers: { location: 'http://[bad' } }
    )
    const client = new EsploraClient({ baseUrl: BASE, fetchFn, sleepFn: noSleep })

    expect((await rejection(client.getTipHash())).message).toContain('redirect to an unspecified location refused')
    expect((await rejection(client.getTipHeight())).message).toContain('redirect to an invalid location refused')
  })

  it.each([
    ['EsploraClient', 301, EsploraClient],
    ['EsploraClient', 302, EsploraClient],
    ['EsploraClient', 303, EsploraClient],
    ['EsploraClient', 307, EsploraClient],
    ['EsploraClient', 308, EsploraClient],
    ['MempoolQbitClient', 301, MempoolQbitClient],
    ['MempoolQbitClient', 302, MempoolQbitClient],
    ['MempoolQbitClient', 307, MempoolQbitClient],
  ] as const)('%s does not re-send POST /tx after HTTP %i', async (_name, status, Client) => {
    const { fetchFn, calls } = redirectingFetch((url, method) =>
      method === 'POST' && url === `${BASE}/tx`
        ? { status, headers: { location: 'https://mirror.example/api/tx' } }
        : method === 'GET'
          ? { status: 404, body: 'not found' }
          : { body: TXID }
    )
    const client = new Client({ baseUrl: BASE, fetchFn, sleepFn: noSleep })

    const error = await rejection(client.broadcastTx('0200000000ffff'))

    // The POST reached the backend, which may have accepted it before redirecting.
    expect(error).toMatchObject({ kind: 'unknown_outcome', status })
    expect(error.message).toContain(`HTTP ${status} redirect to https://mirror.example refused`)
    expect(error.cause).toMatchObject({ kind: 'http', status })
    // No GET to the target, no re-POST, no retry and no /tx/push fallback.
    expect(calls.map(call => `${call.method} ${call.url}`)).toEqual([`POST ${BASE}/tx`])
    expect(calls[0]!.redirect).toBe('manual')
  })

  it.each(
    (
      [
        [
          'a manual 307',
          () => new Response('moved', { status: 307, headers: { location: 'https://mirror.example/api/tx' } }),
          307,
        ],
        [
          'a manual 303',
          () => new Response('see other', { status: 303, headers: { location: `${BASE}/tx/${TXID}` } }),
          303,
        ],
        [
          'a browser opaque redirect',
          () =>
            Object.defineProperties(new Response(null), {
              type: { value: 'opaqueredirect' },
              status: { value: 0 },
              ok: { value: false },
            }) as Response,
          undefined,
        ],
        [
          'a reply from a redirect the runtime followed, echoing the txid',
          () =>
            Object.defineProperties(new Response(TXID), {
              url: { value: `${BASE}/tx/` },
              redirected: { value: false },
            }) as Response,
          undefined,
        ],
      ] as const
    ).flatMap(([shape, reply, status]) =>
      [EsploraClient, MempoolQbitClient].map(Client => [Client.name, shape, reply, status, Client] as const)
    )
  )('%s rejects a broadcast answered by %s as unknown_outcome, without a re-send', async (_name, _shape, reply, status, Client) => {
    const calls: string[] = []
    const responses: Response[] = []
    const fetchFn = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
      calls.push(`${init.method ?? 'GET'} ${String(input)}`)
      const response = reply()
      responses.push(response)
      return response
    }) as typeof fetch
    const client = new Client({ baseUrl: BASE, fetchFn, sleepFn: noSleep })

    const error = await rejection(client.broadcastTx('0200000000ffff', { txid: TXID }))

    expect(error).toMatchObject({ kind: 'unknown_outcome', txid: TXID, url: 'https://esplora.example/.../tx' })
    expect(error.status).toBe(status)
    expect(error.message).toContain(`txid ${TXID} may have been accepted`)
    expect(error.cause).toBeInstanceOf(QbitApiError)
    expect((error.cause as QbitApiError).kind).toBe('http')
    expect((error.cause as QbitApiError).status).toBe(status)
    // Not followed, retried, re-sent or sent to /tx/push, and the body is discarded unread.
    expect(calls).toEqual([`POST ${BASE}/tx`])
    expect(responses[0]!.body === null || responses[0]!.bodyUsed).toBe(true)
  })

  it('refuses a browser opaque redirect', async () => {
    const opaque = Object.defineProperties(new Response(null), {
      type: { value: 'opaqueredirect' },
      status: { value: 0 },
      ok: { value: false },
    }) as Response
    const client = new EsploraClient({
      baseUrl: BASE,
      fetchFn: (async () => opaque) as typeof fetch,
      sleepFn: noSleep,
    })

    const error = await rejection(client.getTipHash())

    expect(error.kind).toBe('http')
    expect(error.status).toBeUndefined()
    expect(error.message).toBe(
      'redirect refused (target hidden by the browser): https://esplora.example/.../blocks/tip/hash'
    )
  })

  it('discards a reply that a fetch implementation reached by following a redirect anyway', async () => {
    const followed = Object.defineProperties(new Response(JSON.stringify(FORGED_STATS)), {
      redirected: { value: true },
      url: { value: 'https://attacker.example/steal/api/address' },
    }) as Response
    const client = new EsploraClient({
      baseUrl: BASE,
      fetchFn: (async () => followed) as typeof fetch,
      sleepFn: noSleep,
    })

    const error = await rejection(client.getAddressBalance(ADDR))

    expect(error.kind).toBe('http')
    expect(error.message).toContain('fetch followed a redirect to https://attacker.example; reply discarded')
    expect(error.message).not.toContain('/steal')
    expect(followed.bodyUsed).toBe(true)
  })
})

describe('http: base URLs', () => {
  const { fetchFn } = redirectingFetch(() => ({ body: '7' }))

  it.each([
    'http://esplora.example/regtest/api',
    'HTTP://ESPLORA.EXAMPLE/api',
    'http://localhost.example/api',
    'http://127.0.0.1.nip.io/api',
    'http://10.0.0.1:3000',
    'http://[::2]/api',
  ])('rejects %s', baseUrl => {
    for (const Client of [EsploraClient, MempoolQbitClient]) {
      let error: unknown
      try {
        new Client({ baseUrl, fetchFn })
      } catch (caught) {
        error = caught
      }
      expect(error).toBeInstanceOf(QbitApiError)
      expect(error).toMatchObject({
        kind: 'http',
        message: 'baseUrl must use https unless its host is loopback; pass allowInsecureHttp: true to allow plain http',
      })
    }
  })

  it.each([
    'http://localhost:3002/api',
    'http://LOCALHOST/api',
    'http://127.0.0.1:3002',
    'http://127.1.2.3/api',
    'http://127.1/api',
    'http://[::1]:3002/api',
    'http://[0:0:0:0:0:0:0:1]/api',
  ])('allows loopback %s', async baseUrl => {
    const { fetchFn, calls } = redirectingFetch(() => ({ body: '7' }))
    const client = new EsploraClient({ baseUrl, fetchFn, sleepFn: noSleep })

    await expect(client.getTipHeight()).resolves.toBe(7)
    expect(calls[0]!.url).toBe(`${baseUrl}/blocks/tip/height`)
  })

  it('allows a non-loopback http base with allowInsecureHttp: true', async () => {
    const { fetchFn, calls } = redirectingFetch(() => ({ body: '7' }))
    const client = new MempoolQbitClient({
      baseUrl: 'http://esplora.example/api',
      allowInsecureHttp: true,
      fetchFn,
      sleepFn: noSleep,
    })

    await expect(client.getTipHeight()).resolves.toBe(7)
    expect(calls[0]!.url).toBe('http://esplora.example/api/blocks/tip/height')
  })

  it('only opts in for allowInsecureHttp: true', () => {
    expect(
      () =>
        new EsploraClient({
          baseUrl: 'http://esplora.example/api',
          allowInsecureHttp: 'true' as unknown as boolean,
          fetchFn,
        })
    ).toThrow(QbitApiError)
  })
})

describe('redirects with the runtime fetch', () => {
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

  it('never sends a request to a cross-origin redirect target', async () => {
    const stolen: string[] = []
    const attacker = await listen((request, response) => {
      stolen.push(`${request.method} ${request.url} ${String(request.headers['x-api-key'])}`)
      response.end(request.method === 'POST' ? TXID : JSON.stringify(FORGED_STATS))
    })
    const backend = await listen((request, response) => {
      response.writeHead(request.method === 'POST' ? 307 : 302, {
        location: `${attacker.origin}/steal${request.url ?? ''}`,
      })
      response.end('moved')
    })

    try {
      const client = new EsploraClient({
        baseUrl: `${backend.origin}/api`,
        headers: { 'x-api-key': 'SECRET-KEY' },
        retries: 0,
      })

      const read = await rejection(client.getAddressBalance(ADDR))
      expect(read).toMatchObject({ kind: 'http', status: 302 })
      expect(read.message).toContain(`redirect to ${attacker.origin} refused`)
      expect(read.message).not.toContain('/steal')

      await expect(client.broadcastTx('0200000000ffff')).rejects.toMatchObject({
        kind: 'unknown_outcome',
        status: 307,
        cause: { kind: 'http', status: 307 },
      })
      expect(stolen).toEqual([])
    } finally {
      await Promise.all([close(backend.server), close(attacker.server)])
    }
  })

  it("accepts the runtime's reply from the requested URL, however the base URL is spelled", async () => {
    const backend = await listen((request, response) => {
      response.end(request.url?.endsWith('/blocks/tip/height') ? '7' : TXID)
    })
    const port = new URL(backend.origin).port

    try {
      for (const baseUrl of [
        `${backend.origin}/api`,
        `${backend.origin}/api/`,
        `HTTP://127.0.0.1:${port}/API/../api`,
        `http://127.1:${port}/a%2fb/c%20d`,
      ]) {
        const client = new EsploraClient({ baseUrl, retries: 0 })

        await expect(client.getTipHeight()).resolves.toBe(7)
        await expect(client.broadcastTx('0200000000ffff')).resolves.toBe(TXID)
      }
    } finally {
      await close(backend.server)
    }
  })
})

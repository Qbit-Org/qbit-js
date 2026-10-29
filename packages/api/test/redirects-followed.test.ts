import { afterEach, describe, expect, it, vi } from 'vitest'

import { EsploraClient, MempoolQbitClient, QbitApiError } from '../src/index'

const BASE = 'https://esplora.example/regtest/api'
const ADDR = 'qbrt1zqqqsyqcyq5rqwzqfpg9scrgwpugpzysnzs23v9ccrydpk8qarc0s8kqqny'
const STATS = {
  address: ADDR,
  chain_stats: {
    funded_txo_count: 1,
    funded_txo_sum: 5_000_000_000,
    spent_txo_count: 0,
    spent_txo_sum: 0,
    tx_count: 1,
  },
  mempool_stats: { funded_txo_count: 0, funded_txo_sum: 0, spent_txo_count: 0, spent_txo_sum: 0, tx_count: 0 },
}
const TXID = 'ab'.repeat(32)

const noSleep = () => Promise.resolve()

/**
 * A fetch shaped like React Native's (whatwg-fetch over the platform stack): it
 * ignores `redirect: 'manual'`, follows a redirect itself, and returns the final
 * reply with `url` set to the final URL and `redirected` false or undefined.
 * `finalUrl` maps the requested URL to the URL the platform ended up at.
 */
function followingFetch(
  finalUrl: (url: string) => string,
  options: { redirected?: false | undefined; body?: string } = {}
): { fetchFn: typeof fetch; calls: { url: string; redirect: RequestRedirect | undefined }[]; responses: Response[] } {
  const calls: { url: string; redirect: RequestRedirect | undefined }[] = []
  const responses: Response[] = []
  const fetchFn = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = String(input)
    calls.push({ url, redirect: init.redirect })
    const response = Object.defineProperties(new Response(options.body ?? JSON.stringify(STATS)), {
      url: { value: finalUrl(url) },
      redirected: { value: 'redirected' in options ? options.redirected : false },
    }) as Response
    responses.push(response)
    return response
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

describe('replies from a redirect the runtime followed anyway', () => {
  it.each([
    ['false', false],
    ['undefined', undefined],
  ] as const)('refuses a cross-origin reply with redirected %s', async (_label, redirected) => {
    const { fetchFn, calls, responses } = followingFetch(
      url => url.replace(BASE, 'https://attacker.example/steal/api') + '?k=PATH-SECRET',
      { redirected }
    )
    const client = new EsploraClient({
      baseUrl: BASE,
      fetchFn,
      sleepFn: noSleep,
      headers: { 'x-api-key': 'SECRET-KEY' },
    })

    const error = await rejection(client.getAddressBalance(ADDR))

    expect(error.kind).toBe('http')
    expect(error.status).toBeUndefined()
    expect(error.message).toContain('fetch followed a redirect to https://attacker.example; reply discarded: ')
    expect(error.message).toContain(`/address/${ADDR}`)
    expect(error.message).not.toContain('/steal')
    expect(error.message).not.toContain('PATH-SECRET')
    // Not retried, and the forged body is discarded unread.
    expect(calls).toEqual([{ url: `${BASE}/address/${ADDR}`, redirect: 'manual' }])
    expect(responses[0]!.bodyUsed).toBe(true)
  })

  it.each([
    ['an https to http downgrade', (url: string) => url.replace('https:', 'http:')],
    ['another host', (url: string) => url.replace('esplora.example', 'esplora.example.attacker.example')],
    ['another subdomain', (url: string) => url.replace('esplora.example', 'api.esplora.example')],
    [
      'userinfo naming the backend',
      (url: string) => url.replace('esplora.example', 'esplora.example@attacker.example'),
    ],
    [
      'the backend host in the path',
      (url: string) => url.replace('esplora.example', 'attacker.example/@esplora.example'),
    ],
    ['a backslash path', (url: string) => url.replace('esplora.example', 'attacker.example\\@esplora.example')],
    ['an unreadable url', () => 'not a url'],
    ['another path on the same host', (url: string) => url.replace('/regtest/api', '/v2/api')],
    ['another endpoint on the backend', (url: string) => url.replace('/blocks/tip/height', '/blocks/tip/hash')],
    ['the same path with a trailing slash', (url: string) => `${url}/`],
    ['the same path with a query', (url: string) => `${url}?page=2`],
    ['a different port', (url: string) => url.replace('esplora.example', 'esplora.example:8443')],
    ['the default port of another scheme', (url: string) => url.replace('esplora.example', 'esplora.example:80')],
  ])('refuses %s', async (_label, finalUrl) => {
    const { fetchFn, calls } = followingFetch(finalUrl, { body: '7' })
    const client = new EsploraClient({ baseUrl: BASE, fetchFn, sleepFn: noSleep })

    const error = await rejection(client.getTipHeight())

    expect(error.kind).toBe('http')
    expect(error.message).toMatch(/^fetch followed a redirect to .*; reply discarded: /)
    expect(calls).toHaveLength(1)
  })

  it.each([
    ['the requested URL', BASE, (url: string) => url],
    ['the requested URL, for a base URL with a trailing slash', `${BASE}/`, (url: string) => url],
    ['the default port', BASE, (url: string) => url.replace('esplora.example', 'esplora.example:443')],
    [
      'the requested URL without the default port configured in the base',
      'https://esplora.example:443/regtest/api',
      (url: string) => url.replace(':443', ''),
    ],
    [
      'an uppercase host and scheme',
      BASE,
      (url: string) => url.replace('https://esplora.example', 'HTTPS://ESPLORA.EXAMPLE'),
    ],
    ['a trailing-dot host', BASE, (url: string) => url.replace('esplora.example', 'esplora.example.')],
    ['userinfo', BASE, (url: string) => url.replace('esplora.example', 'user:pw@esplora.example')],
    [
      'a normalized URL for a mixed-case base with :443',
      'https://Esplora.Example:443/regtest/api',
      (url: string) => url.replace('https://Esplora.Example:443', 'https://esplora.example'),
    ],
    [
      'the trailing-dot-free equivalent of the base host',
      'https://esplora.example./regtest/api',
      (url: string) => url.replace('esplora.example.', 'esplora.example'),
    ],
    [
      'the WHATWG spelling of a loopback base',
      'http://127.1:3002/api',
      (url: string) => url.replace('127.1', '127.0.0.1'),
    ],
  ])('accepts a reply from %s', async (_label, baseUrl, finalUrl) => {
    const { fetchFn } = followingFetch(finalUrl, { body: '7' })
    const client = new EsploraClient({ baseUrl, fetchFn, sleepFn: noSleep })

    await expect(client.getTipHeight()).resolves.toBe(7)
  })

  it('rejects a relative baseUrl in the constructor, even where a document base URL would resolve it', () => {
    vi.stubGlobal('document', { baseURI: 'https://app.example/wallet/' })
    vi.stubGlobal('location', { href: 'https://app.example/wallet/' })
    try {
      const { fetchFn } = followingFetch(url => `https://app.example${url}`, { body: '7' })

      expect(() => new EsploraClient({ baseUrl: '/api', fetchFn })).toThrow(
        /^baseUrl must be an absolute http\(s\) URL/
      )
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it("refuses another transaction's status reached through a same-host redirect", async () => {
    const other = 'cd'.repeat(32)
    const { fetchFn, calls } = followingFetch(url => url.replace(TXID, other), {
      body: JSON.stringify({ confirmed: true, block_height: 7 }),
    })
    const client = new EsploraClient({ baseUrl: BASE, fetchFn, sleepFn: noSleep })

    const error = await rejection(client.getTxStatus(TXID))

    expect(error.kind).toBe('http')
    expect(error.message).toContain('fetch followed a redirect to https://esplora.example; reply discarded: ')
    expect(error.message).toContain(`/tx/${TXID}/status`)
    expect(calls).toHaveLength(1)
  })

  it('accepts an empty url, as a mocked Response has', async () => {
    const { fetchFn } = followingFetch(() => '', { body: '7' })
    const client = new EsploraClient({ baseUrl: BASE, fetchFn, sleepFn: noSleep })

    await expect(client.getTipHeight()).resolves.toBe(7)
  })

  it.each([
    ['EsploraClient', EsploraClient],
    ['MempoolQbitClient', MempoolQbitClient],
  ] as const)('%s refuses a followed POST /tx without a /tx/push fallback', async (_name, Client) => {
    const { fetchFn, calls } = followingFetch(url => url.replace(BASE, 'https://mirror.example/api'), { body: TXID })
    const client = new Client({ baseUrl: BASE, fetchFn, sleepFn: noSleep })

    const error = await rejection(client.broadcastTx('0200000000ffff'))

    // The runtime may have re-sent the POST to the target.
    expect(error.kind).toBe('unknown_outcome')
    expect(error.cause).toMatchObject({ kind: 'http' })
    expect(error.message).toContain('fetch followed a redirect to https://mirror.example; reply discarded')
    expect(calls.map(call => call.url)).toEqual([`${BASE}/tx`])
  })

  it.each([
    ['EsploraClient', EsploraClient],
    ['MempoolQbitClient', MempoolQbitClient],
  ] as const)('%s refuses a POST /tx answered from another path on the backend', async (_name, Client) => {
    const { fetchFn, calls } = followingFetch(url => url.replace('/tx', '/blocks/tip/hash'), { body: TXID })
    const client = new Client({ baseUrl: BASE, fetchFn, sleepFn: noSleep })

    const error = await rejection(client.broadcastTx('0200000000ffff'))

    expect(error.kind).toBe('unknown_outcome')
    expect(error.cause).toMatchObject({ kind: 'http' })
    expect(error.message).toContain('fetch followed a redirect to https://esplora.example; reply discarded')
    expect(calls.map(call => call.url)).toEqual([`${BASE}/tx`])
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

  get protocol(): string {
    throw new Error('URL.protocol is not implemented')
  }

  get hostname(): string {
    throw new Error('URL.hostname is not implemented')
  }

  get origin(): string {
    throw new Error('URL.origin is not implemented')
  }
}

/**
 * React Native's global URL from 0.80: it stores the string, with a `/` appended
 * unless it has a query or fragment, and its getters are regexes over it.
 */
class ReactNative080URL {
  private readonly _url: string

  constructor(url: string) {
    this._url = url.endsWith('/') || url.includes('?') || url.includes('#') ? url : `${url}/`
  }

  get href(): string {
    return this._url
  }

  get protocol(): string {
    const protocolMatch = this._url.match(/^([a-zA-Z][a-zA-Z\d+\-.]*):/)
    return protocolMatch ? protocolMatch[1] + ':' : ''
  }

  get hostname(): string {
    const hostnameMatch = this._url.match(/^https?:\/\/(?:[^@]+@)?([^:/?#]+)/)
    return hostnameMatch ? hostnameMatch[1]! : ''
  }

  get origin(): string {
    const matches = this._url.match(/^(https?:\/\/[^/]+)/)
    return matches ? matches[1]! : ''
  }
}

describe.each([
  ['React Native < 0.80', ReactNative079URL],
  ['React Native >= 0.80', ReactNative080URL],
])('with the URL global of %s', (_label, RNURL) => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('refuses a cross-origin reply, including one naming the backend after an @', async () => {
    vi.stubGlobal('URL', RNURL)
    for (const attacker of ['https://attacker.example', 'https://attacker.example/@esplora.example']) {
      const { fetchFn } = followingFetch(url => url.replace('https://esplora.example', attacker), { body: '7' })
      const client = new EsploraClient({ baseUrl: BASE, fetchFn, sleepFn: noSleep })

      expect((await rejection(client.getTipHeight())).kind).toBe('http')
    }
  })

  it('refuses a same-host reply from another path', async () => {
    vi.stubGlobal('URL', RNURL)
    for (const finalUrl of [
      (url: string) => url.replace('/height', '/hash'),
      (url: string) => `${url}/`,
      (url: string) => url.replace('esplora.example', 'esplora.example:8443'),
    ]) {
      const { fetchFn } = followingFetch(finalUrl, { body: '7' })
      const client = new EsploraClient({ baseUrl: BASE, fetchFn, sleepFn: noSleep })

      expect((await rejection(client.getTipHeight())).kind).toBe('http')
    }
  })

  it('accepts the requested URL, which its href would spell with a trailing slash', async () => {
    vi.stubGlobal('URL', RNURL)
    expect(new RNURL(`${BASE}/blocks/tip/height`).href).toBe(`${BASE}/blocks/tip/height/`)
    const { fetchFn } = followingFetch(url => url, { body: '7' })
    const client = new EsploraClient({ baseUrl: BASE, fetchFn, sleepFn: noSleep })

    await expect(client.getTipHeight()).resolves.toBe(7)
  })

  it('names a redirect target by its origin, without userinfo, path or query', async () => {
    vi.stubGlobal('URL', RNURL)
    const target = 'https://user:PASS-SECRET@Attacker.Example:8443?k=QUERY-SECRET'
    const redirected = (async () => new Response(null, { status: 302, headers: { location: target } })) as typeof fetch
    const relative = (async () =>
      new Response(null, { status: 302, headers: { location: '/moved?k=QUERY-SECRET' } })) as typeof fetch
    const schemeRelative = (async () =>
      new Response(null, { status: 302, headers: { location: '//mirror.example/api' } })) as typeof fetch
    const { fetchFn: followed } = followingFetch(() => target, { body: '7' })

    const messages = await Promise.all(
      [redirected, relative, schemeRelative, followed].map(async fetchFn => {
        const client = new EsploraClient({ baseUrl: BASE, fetchFn, sleepFn: noSleep })
        return (await rejection(client.getTipHeight())).message
      })
    )

    const url = 'https://esplora.example/.../blocks/tip/height'
    expect(messages).toEqual([
      `HTTP 302 redirect to https://attacker.example:8443 refused: ${url}`,
      `HTTP 302 redirect to https://esplora.example refused: ${url}`,
      `HTTP 302 redirect to https://mirror.example refused: ${url}`,
      `fetch followed a redirect to https://attacker.example:8443; reply discarded: ${url}`,
    ])
  })

  it('accepts a same-host reply despite case and port differences', async () => {
    vi.stubGlobal('URL', RNURL)
    const { fetchFn } = followingFetch(url => url.replace('https://Esplora.Example:443', 'https://esplora.example'), {
      body: '7',
    })
    const client = new EsploraClient({ baseUrl: 'https://Esplora.Example:443/regtest/api', fetchFn, sleepFn: noSleep })

    await expect(client.getTipHeight()).resolves.toBe(7)
  })

  it('checks http: base URLs without relying on its getters', () => {
    vi.stubGlobal('URL', RNURL)
    const { fetchFn } = followingFetch(url => url, { body: '7' })

    expect(() => new EsploraClient({ baseUrl: BASE, fetchFn })).not.toThrow()
    expect(() => new EsploraClient({ baseUrl: 'http://LOCALHOST:3002/api', fetchFn })).not.toThrow()
    for (const baseUrl of [
      'HTTP://ESPLORA.EXAMPLE/api',
      'http://esplora.example/@localhost',
      'http:esplora.example/api',
    ]) {
      expect(() => new EsploraClient({ baseUrl, fetchFn })).toThrow(
        'baseUrl must use https unless its host is loopback; pass allowInsecureHttp: true to allow plain http'
      )
    }
  })

  it('applies the other baseUrl checks without relying on its getters', () => {
    vi.stubGlobal('URL', RNURL)
    const { fetchFn } = followingFetch(url => url, { body: '7' })

    for (const baseUrl of [
      'https://user:secret@esplora.example/api',
      'https://user@esplora.example/api',
      // A raw `/` in the password ends the authority early, leaving `Zx9Qsecret` as the port.
      'https://apikey:Zx9Qsecret/rest@esplora.example/api',
      'https://esplora.example:65536/api',
      'https://esplora.example/api?x=1',
      'https://esplora.example/api#tip',
      'https://esplora.example\\api',
      'https://esplora.example/a\u200cpi',
      'https://',
      '/regtest/api',
      'esplora.example/api',
      'ftp://esplora.example/api',
    ]) {
      expect(() => new EsploraClient({ baseUrl, fetchFn }), baseUrl).toThrow(
        'baseUrl must be an absolute http(s) URL without whitespace, control or format characters, backslashes, credentials, query or fragment'
      )
    }
    for (const baseUrl of [
      'https://esplora.example/regtest/api/',
      'https://b\u00fccher.example/api',
      'http://127.0.0.1:3002',
    ]) {
      expect(() => new EsploraClient({ baseUrl, fetchFn }), baseUrl).not.toThrow()
    }
  })
})

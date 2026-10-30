import {
  causeOptions,
  detachedString,
  escapeControlChars,
  formatErrorCause,
  PREVIEW_LENGTH,
  QbitApiError,
  type QbitApiErrorOptions,
  redactBaseUrl,
  redactRedirectTarget,
  responseBodyPreview,
} from './errors'

/** setTimeout stores its delay as a signed 32-bit int; larger values fire after ~1 ms. */
const MAX_TIMER_DELAY_MS = 2_147_483_647

const UNSAFE_BASE_URL_CHAR = /[\s\p{Cc}\\?#]|(?![\u200c\u200d])[\p{Cf}\p{Default_Ignorable_Code_Point}]/u

/**
 * A character RFC 3986 allows in a URL only percent-encoded (non-ASCII, a
 * space, a backtick, any of `"<>\^{|}`, or `[` or `]` outside an IPv6 host),
 * or a `%` that does not start an escape. A URL Standard parser, and React
 * Native's native stack, encode most of these, so a reply's `url` would not
 * spell the configured URL.
 */
const UNENCODED_URL_CHAR = /[^\w.~!$&'()*+,;=:@/%-]|%(?![\da-f]{2})/i

function validBaseUrl(value: unknown, allowInsecureHttp: boolean | undefined): string {
  // Paths are appended to the raw string, so a query or fragment would swallow
  // them. new URL() silently strips whitespace and C0 controls, turns
  // backslashes into slashes (`/api\` would request `/api//...`), and
  // percent-encodes C1 controls (U+0080-U+009F), format characters and other
  // default-ignorable code points (e.g. U+00AD, U+200B, U+FE0F, U+034F) into a
  // different path, or drops them from the host.
  // fetch rejects credentials. Other non-ASCII stays valid: IDN hosts map to
  // punycode and path characters get their standard UTF-8 percent-encoding,
  // except where the URL parser is not standard: there the host must be ASCII
  // and every other character percent-encoded where RFC 3986 requires it.
  // ZWNJ/ZWJ (U+200C/U+200D) are exempt in the host because they are
  // significant in some IDN labels (new URL() rejects them where IDNA does not
  // allow them); in the path they are invisible and rejected like the rest.
  // The parts are read with `schemeAndHost`, as React Native's URL getters
  // throw before 0.80 and misread the host from 0.80; where the runtime's URL
  // parser follows the URL Standard, it must also accept the URL.
  const invalid = () =>
    new QbitApiError(
      'http',
      'baseUrl must be an absolute http(s) URL without whitespace, control or format characters, backslashes, credentials, query or fragment'
    )
  if (typeof value !== 'string' || UNSAFE_BASE_URL_CHAR.test(value)) throw invalid()
  if (followsUrlStandard() && standardHref(value) === undefined) throw invalid()
  const url = schemeAndHost(value)
  if (
    !url ||
    (url.protocol !== 'http:' && url.protocol !== 'https:') ||
    !url.hostname ||
    url.userinfo ||
    !/^\d*$/.test(url.port) ||
    Number(url.port) > 65535 ||
    /%E2%80%8[CD]|[\u200c\u200d]/i.test(url.path)
  ) {
    throw invalid()
  }
  // Without a standard URL parser nothing here maps an internationalized host
  // to punycode or percent-encodes the path, but the native stack does, so
  // every reply's `url` would spell another URL and be refused as a followed
  // redirect (`fromAnotherUrl`).
  if (!followsUrlStandard()) {
    if (/[^\x00-\x7f]/.test(url.hostname)) {
      throw new QbitApiError(
        'http',
        'baseUrl host must be ASCII where the runtime has no standard URL parser (React Native); pass its punycode (xn--) form'
      )
    }
    if (UNENCODED_URL_CHAR.test(value.replace(/^[a-z][a-z\d+.-]*:\/*\[[\da-f:.]*\]/i, ''))) {
      throw new QbitApiError(
        'http',
        "baseUrl must be percent-encoded where the runtime has no standard URL parser (React Native): escape each character other than ASCII letters, digits and -._~!$&'()*+,;=:@/ as the %XX of its UTF-8 bytes, as encodeURIComponent does for a path segment"
      )
    }
  }
  // Plain http exposes request headers (API keys) and every response to the
  // network; loopback is exempt for local and regtest backends.
  if (url.protocol === 'http:' && allowInsecureHttp !== true && !isLoopbackHostname(url.hostname)) {
    throw new QbitApiError(
      'http',
      'baseUrl must use https unless its host is loopback; pass allowInsecureHttp: true to allow plain http'
    )
  }
  return value.replace(/\/+$/, '')
}

function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortErrorFor(signal))
      return
    }
    const onAbort = () => {
      clearTimeout(timer)
      reject(abortErrorFor(signal!))
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

// ---------------------------------------------------------------------------
// Operation scope: one signal per public call, carried through every
// dependent request, retry, and backoff.
// ---------------------------------------------------------------------------

/**
 * Signals created by this package, always aborted with the `QbitApiError` the
 * call rejects with. Any other signal belongs to a caller, whose reason is
 * only ever a cause, even when it is an error this package returned earlier.
 */
const internalSignals = new WeakSet<AbortSignal>()

function internalAbortController(): AbortController {
  const controller = new AbortController()
  internalSignals.add(controller.signal)
  return controller
}

/**
 * Operation signals under which every GET is sent in a request of its own,
 * never joined to an identical one already in flight. An operation opened
 * from such a signal is under it too, so the mark reaches every call made
 * under it, through an overridden method included.
 */
const unsharedSignals = new WeakSet<AbortSignal>()

/** Send every GET made under `signal`, an operation scope's, in a request of its own. */
function sendUnshared(signal: AbortSignal): void {
  unsharedSignals.add(signal)
}

function isUnshared(signal: AbortSignal): boolean {
  return unsharedSignals.has(signal)
}

/** The `QbitApiError` an aborted signal stands for: a deadline or caller cancellation. */
function abortErrorFor(signal: AbortSignal): QbitApiError {
  const reason: unknown = signal.reason
  // `instanceof`, not `QbitApiError.is`: only this package aborts its internal
  // signals, always with its own errors.
  if (internalSignals.has(signal) && reason instanceof QbitApiError) return reason
  return new QbitApiError('aborted', `request aborted by caller${formatErrorCause(reason)}`, {
    cause: reason,
  })
}

interface OperationScope {
  signal: AbortSignal
  dispose(): void
}

function openOperationScope(sources: (AbortSignal | undefined)[], deadlineMs: number | undefined): OperationScope {
  if (
    deadlineMs !== undefined &&
    !(Number.isFinite(deadlineMs) && deadlineMs > 0 && deadlineMs <= MAX_TIMER_DELAY_MS)
  ) {
    throw new QbitApiError('http', `deadlineMs must be a positive number no greater than ${MAX_TIMER_DELAY_MS}`)
  }

  const controller = internalAbortController()
  if (sources.some(source => source !== undefined && unsharedSignals.has(source))) sendUnshared(controller.signal)
  const cleanups: (() => void)[] = []
  const dispose = () => {
    for (const cleanup of cleanups) cleanup()
    cleanups.length = 0
  }
  const abort = (error: QbitApiError) => {
    if (controller.signal.aborted) return
    controller.abort(error)
    dispose()
  }

  for (const source of sources) {
    if (source === undefined) continue
    if (source.aborted) {
      abort(abortErrorFor(source))
      break
    }
    const onAbort = () => abort(abortErrorFor(source))
    source.addEventListener('abort', onAbort, { once: true })
    cleanups.push(() => source.removeEventListener('abort', onAbort))
  }
  if (deadlineMs !== undefined && !controller.signal.aborted) {
    const timer = setTimeout(
      () => abort(new QbitApiError('timeout', `operation exceeded its ${deadlineMs}ms deadline`)),
      deadlineMs
    )
    cleanups.push(() => clearTimeout(timer))
  }

  if (controller.signal.aborted) {
    dispose()
    throw abortErrorFor(controller.signal)
  }
  return { signal: controller.signal, dispose }
}

/** Settle with `promise`, or reject as soon as `signal` aborts, whichever is first. */
function raceAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(abortErrorFor(signal))
    if (signal.aborted) onAbort()
    else signal.addEventListener('abort', onAbort, { once: true })
    promise.then(
      value => {
        signal.removeEventListener('abort', onAbort)
        resolve(value)
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort)
        reject(error)
      }
    )
  })
}

/** `Retry-After` (delta-seconds or HTTP-date) as a non-negative, finite whole number of ms. */
function parseRetryAfter(value: string | null): number | undefined {
  if (!value) return undefined
  let ms: number
  const seconds = Number(value)
  // Overlong delta-seconds overflow to Infinity; keep them as "too long", not unparseable.
  if (!Number.isNaN(seconds)) {
    ms = seconds * 1000
  } else {
    const date = Date.parse(value)
    if (!Number.isFinite(date)) return undefined
    ms = date - Date.now()
  }
  return Math.min(Math.max(0, Math.ceil(ms)), Number.MAX_SAFE_INTEGER)
}

function isAbortError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { name?: string }).name === 'AbortError'
}

/** `localhost`, `127.0.0.0/8` or `[::1]`, as normalized by the URL parser (`127.1` is `127.0.0.1`). */
function isLoopbackHostname(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '[::1]' || /^127\.\d+\.\d+\.\d+$/.test(hostname)
}

/** Ports a URL parser drops from a URL with this scheme. */
const DEFAULT_PORTS: Record<string, string> = {
  'http:': '80',
  'https:': '443',
  'ws:': '80',
  'wss:': '443',
  'ftp:': '21',
}

/**
 * The lowercased scheme and host of a URL with a scheme, without userinfo or
 * one trailing dot, whether it has userinfo (an `@` in the authority), its
 * port (empty for the scheme's default) and its path with the query (`/` for
 * an empty path, without the fragment); undefined for a relative URL that
 * `base` does not resolve. A runtime URL parser that
 * follows the URL Standard canonicalizes first (`127.1`, IDN, `[0::1]`, dot
 * segments, percent-encoding), but the parts are read by hand: React Native's
 * global URL throws from `protocol` and `hostname` before 0.80, and from 0.80
 * reads them with regexes that neither lowercase nor end the authority at the
 * first `/`, so `https://evil.example/@host` would have the hostname `host`.
 * There the configured spelling is read, since its `href` appends a `/`.
 */
function schemeAndHost(
  url: string,
  base?: string
): { protocol: string; hostname: string; userinfo: boolean; port: string; path: string } | undefined {
  const match = /^([a-z][a-z\d+.-]*:)[/\\]*([^/?#\\]*)([^#]*)/i.exec(standardHref(url, base) ?? url)
  if (!match) return undefined
  const protocol = match[1]!.toLowerCase()
  const at = match[2]!.lastIndexOf('@')
  const authority = match[2]!.slice(at + 1)
  const [, hostname, port] = /^(\[[^\]]*\]|[^:]*):?(.*)$/s.exec(authority)!
  return {
    protocol,
    hostname: hostname!.toLowerCase().replace(/\.$/, ''),
    userinfo: at !== -1,
    port: port === DEFAULT_PORTS[protocol] ? '' : port!,
    path: match[3]!.startsWith('/') ? match[3]! : `/${match[3]!}`,
  }
}

/**
 * `new URL(url, base).href` where the runtime's URL parser follows the URL
 * Standard; undefined where it does not parse `url`, and on React Native.
 */
function standardHref(url: string, base?: string): string | undefined {
  if (!followsUrlStandard()) return undefined
  try {
    return new URL(url, base).href
  } catch {
    return undefined
  }
}

/**
 * Whether the runtime's URL parser follows the URL Standard (Node, browsers,
 * Deno, Bun). React Native's does not: its `href` is the input with a `/`
 * appended, and its other getters throw before 0.80.
 */
function followsUrlStandard(): boolean {
  try {
    return new URL('HTTP://Q.EXAMPLE:80/a/../b').href === 'http://q.example/b'
  } catch {
    return false
  }
}

/**
 * True when `response.url` is not the requested URL: another scheme, host,
 * port, or path and query. React Native's fetch ignores `redirect: 'manual'`:
 * the platform follows the redirect and the reply arrives with the final URL
 * in `url` but without `redirected`. A redirect within the backend is refused
 * too, since its reply answers another request (another transaction's status,
 * say). Both URLs are read with `schemeAndHost`, so the case of the scheme and
 * host, a default port and a trailing dot on the host do not count. When
 * either URL cannot be read, the reply counts as from another URL.
 */
function fromAnotherUrl(response: Response, url: string): boolean {
  if (typeof response.url !== 'string' || response.url === '') return false
  const requested = schemeAndHost(url)
  const replied = schemeAndHost(response.url)
  if (!requested || !replied) return true
  return (
    replied.protocol !== requested.protocol ||
    replied.hostname !== requested.hostname ||
    replied.port !== requested.port ||
    replied.path !== requested.path
  )
}

/**
 * Requests use `redirect: 'manual'`, so a redirect arrives here as a 3xx, or in
 * browsers as an `opaqueredirect` with status 0. Following it would send the
 * configured headers wherever `Location` points and accept that server's reply
 * as backend data. A fetch that ignores `redirect` and follows anyway reports
 * `redirected`, or a `url` other than the request's; its reply is refused too.
 */
function refuseRedirect(response: Response, url: string, baseUrl: string): Response {
  const opaque = response.type === 'opaqueredirect'
  const redirectStatus = response.status >= 300 && response.status <= 399
  if (!opaque && !redirectStatus && response.redirected !== true && !fromAnotherUrl(response, url)) {
    return response
  }
  void discardResponseBody(response)
  const errorUrl = redactBaseUrl(url, baseUrl)
  if (opaque) {
    throw new QbitApiError('http', `redirect refused (target hidden by the browser): ${errorUrl}`, { url: errorUrl })
  }
  if (redirectStatus) {
    const target = redactRedirectTarget(redirectTargetOrigin(response.headers.get('location'), url), baseUrl)
    throw new QbitApiError('http', `HTTP ${response.status} redirect to ${target} refused: ${errorUrl}`, {
      status: response.status,
      url: errorUrl,
    })
  }
  const target = redactRedirectTarget(redirectTargetOrigin(response.url, url), baseUrl)
  throw new QbitApiError('http', `fetch followed a redirect to ${target}; reply discarded: ${errorUrl}`, {
    url: errorUrl,
  })
}

/**
 * A redirect target as its origin only; its path and query may carry tokens.
 * Read with `schemeAndHost`, not the runtime's `origin`: React Native's throws
 * before 0.80 and from 0.80 keeps userinfo and a query. Where the runtime
 * cannot resolve a relative location, a scheme-relative one keeps the
 * request's scheme and any other keeps its origin.
 */
function redirectTargetOrigin(location: string | null, url: string): string {
  if (!location) return 'an unspecified location'
  const target =
    schemeAndHost(location, url) ??
    schemeAndHost(/^[/\\]{2}/.test(location) ? `${schemeAndHost(url)?.protocol ?? ''}${location}` : url)
  if (!target) return 'an invalid location'
  if (!/^(?:https?|wss?|ftp):$/.test(target.protocol)) return `a ${target.protocol} URL`
  if (!/^(?:[a-z\d._~-]+|\[[a-f\d:.]+\])$/.test(target.hostname) || !/^\d*$/.test(target.port)) {
    return 'an invalid location'
  }
  return `${target.protocol}//${target.hostname}${target.port ? `:${target.port}` : ''}`
}

/**
 * Read a call's response body as text through `readBodyUntilAborted`, the one
 * body reader. If `signal` aborts first, reject at once with the call's
 * `aborted` / `timeout` error and cancel the body (best-effort, never
 * awaited); a failed read is `parse`. fetchOnce has already buffered the
 * response, so its text, shared by every clone handed to a de-duplicated GET,
 * is returned as it is, without another copy or decode. `url` is the request
 * URL as errors show it.
 */
async function readBody(response: Response, url: string, baseUrl: string, signal: AbortSignal): Promise<string> {
  if (signal.aborted) {
    const error = abortErrorFor(signal)
    void discardResponseBody(response, error)
    throw error
  }
  const buffered = bufferedText(response)
  if (buffered !== undefined) return buffered
  try {
    return await readBodyUntilAborted(response, signal)
  } catch (cause) {
    if (signal.aborted) throw abortErrorFor(signal)
    throw bodyReadError(response, cause, url, baseUrl)
  }
}

function bodyReadError(response: Response, cause: unknown, url: string, baseUrl: string): QbitApiError {
  return new QbitApiError('parse', `failed to read response body from ${url}`, {
    url,
    status: response.status,
    ...causeOptions(cause, baseUrl),
  })
}

/**
 * Rejection of `readBodyUntilAborted` for a body longer than its `maxBytes`;
 * fetchOnce turns it into a `response_too_large` error.
 */
class BodyLimitExceeded extends Error {
  constructor(readonly maxBytes: number) {
    super(`response body exceeded ${maxBytes} bytes`)
    this.name = 'BodyLimitExceeded'
  }
}

/**
 * Read the whole body as UTF-8 text, giving up as soon as `signal` aborts, or
 * with `BodyLimitExceeded` once more than `maxBytes` bytes (if given) have
 * arrived. A body that is a WHATWG `ReadableStream` (it has `getReader()`), or
 * failing that an async iterable such as node-fetch's Node `Readable`, is
 * read chunk by chunk and its bytes counted as they arrive, after any content
 * decoding; on failure it is cancelled or destroyed, so a body that stalls
 * after the headers, or runs past `maxBytes`, releases its connection even if
 * the fetch implementation ignores the signal. A response without such a body
 * is read whole, so the limit fails the read but cannot stop it: through
 * `blob()` where it has one (React Native's fetch, which has downloaded the
 * body natively by then), whose `size` is checked before the text is read,
 * else `arrayBuffer()`, whose bytes are counted before they are decoded, else
 * `text()`, measured as that text's UTF-8 encoding. React Native 0.71 and
 * earlier do not implement the `FileReader.readAsArrayBuffer` its
 * `arrayBuffer()` needs, while `blob()` and reading a Blob as text work in
 * every version.
 */
async function readBodyUntilAborted(response: Response, signal: AbortSignal, maxBytes?: number): Promise<string> {
  let rejectAborted: (reason: unknown) => void = () => {}
  const aborted = new Promise<never>((_, reject) => {
    rejectAborted = reject
  })
  // Every path below races `aborted`; this only guards an early synchronous throw.
  aborted.catch(() => {})
  const onAbort = () => rejectAborted(signal.reason)
  if (signal.aborted) onAbort()
  else signal.addEventListener('abort', onAbort, { once: true })

  try {
    const body: unknown = response.body
    const chunks = bodyChunks(body)
    if (chunks !== undefined) return await readChunks(chunks, aborted, maxBytes)
    try {
      if (typeof response.blob === 'function') {
        const blob = await Promise.race([response.blob(), aborted])
        const size: unknown = blob.size
        if (maxBytes !== undefined && typeof size === 'number' && size > maxBytes) {
          throw new BodyLimitExceeded(maxBytes)
        }
        const text = await Promise.race([blobText(blob), aborted])
        if (maxBytes !== undefined && typeof size !== 'number' && utf8ByteLength(text) > maxBytes) {
          throw new BodyLimitExceeded(maxBytes)
        }
        return text
      }
      if (typeof response.arrayBuffer === 'function') {
        const buffer = await Promise.race([response.arrayBuffer(), aborted])
        if (maxBytes !== undefined && buffer.byteLength > maxBytes) throw new BodyLimitExceeded(maxBytes)
        const decoder = utf8Decoder()
        return decoder.write(new Uint8Array(buffer)) + decoder.end()
      }
      const text = await Promise.race([response.text(), aborted])
      if (maxBytes !== undefined && utf8ByteLength(text) > maxBytes) throw new BodyLimitExceeded(maxBytes)
      return text
    } catch (error) {
      if (signal.aborted) releaseBody(body, signal.reason)
      throw error
    }
  } finally {
    signal.removeEventListener('abort', onAbort)
  }
}

/**
 * A Blob's text, decoded as UTF-8: with `text()` where the Blob has it, else
 * (React Native's Blob) through `Response`, which reads it with
 * `FileReader.readAsText`, else from `arrayBuffer()`.
 */
async function blobText(blob: Blob): Promise<string> {
  if (typeof blob.text === 'function') return blob.text()
  if (typeof Response === 'function') return new Response(blob).text()
  const decoder = utf8Decoder()
  return decoder.write(new Uint8Array(await blob.arrayBuffer())) + decoder.end()
}

/** A body read chunk by chunk, and how to stop it after a failure (best-effort, never awaited). */
interface BodyChunks {
  next(): Promise<{ done?: boolean; value?: unknown }>
  release(reason: unknown): void
}

/** A WHATWG stream's reader, or an async-iterable body's iterator; undefined for any other body. */
function bodyChunks(body: unknown): BodyChunks | undefined {
  if (body === null || typeof body !== 'object') return undefined
  if (typeof (body as { getReader?: unknown }).getReader === 'function') {
    const reader = (body as ReadableStream<unknown>).getReader()
    return {
      next: () => reader.read(),
      release: reason => {
        reader.cancel(reason).catch(() => {
          // Cancellation is best-effort; the read failure remains authoritative.
        })
      },
    }
  }
  if (typeof (body as { [Symbol.asyncIterator]?: unknown })[Symbol.asyncIterator] === 'function') {
    const iterator = (body as AsyncIterable<unknown>)[Symbol.asyncIterator]()
    return {
      next: () => iterator.next(),
      release: reason => {
        // A Node stream is destroyed at once: an async iterator's return() can
        // wait for the read in flight, which may never end.
        releaseBody(body, reason)
        try {
          Promise.resolve(iterator.return?.()).catch(() => {})
        } catch {
          // Cleanup is best-effort; the read failure remains authoritative.
        }
      },
    }
  }
  return undefined
}

async function readChunks(chunks: BodyChunks, aborted: Promise<never>, maxBytes: number | undefined): Promise<string> {
  const decoder = utf8Decoder()
  let text = ''
  let bytes = 0
  try {
    while (true) {
      const chunk = await Promise.race([chunks.next(), aborted])
      if (chunk.done) return text + decoder.end()
      const value = chunkBytes(chunk.value)
      // Checked before decoding, so at most one chunk past the limit is held.
      bytes += value.byteLength
      if (maxBytes !== undefined && bytes > maxBytes) throw new BodyLimitExceeded(maxBytes)
      text += decoder.write(value)
    }
  } catch (error) {
    chunks.release(error)
    throw error
  }
}

/** A body chunk's bytes: a `Uint8Array` (a Node `Buffer` included), another view, or an `ArrayBuffer`. */
function chunkBytes(value: unknown): Uint8Array {
  if (value instanceof Uint8Array) return value
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
  if (value instanceof ArrayBuffer) return new Uint8Array(value)
  throw new TypeError('response body chunk is not bytes')
}

/** A streaming UTF-8 decoder that decodes as `new TextDecoder()` does. */
interface Utf8Decoder {
  write(bytes: Uint8Array): string
  end(): string
}

function utf8Decoder(): Utf8Decoder {
  if (typeof TextDecoder === 'function') {
    const decoder = new TextDecoder()
    return { write: bytes => decoder.decode(bytes, { stream: true }), end: () => decoder.decode() }
  }
  // Without TextDecoder (older React Native), the bytes are kept and decoded once at the end.
  const chunks: Uint8Array[] = []
  return {
    write: bytes => {
      chunks.push(bytes)
      return ''
    },
    end: () => {
      const all = new Uint8Array(chunks.reduce((length, chunk) => length + chunk.byteLength, 0))
      let offset = 0
      for (const chunk of chunks) {
        all.set(chunk, offset)
        offset += chunk.byteLength
      }
      return decodeUtf8(all)
    },
  }
}

/**
 * `bytes` decoded as the Encoding Standard's UTF-8 decode does, and so
 * `new TextDecoder().decode(bytes)`: a leading byte order mark dropped, and
 * each maximal invalid subsequence replaced with one U+FFFD.
 */
function decodeUtf8(bytes: Uint8Array): string {
  const units: number[] = []
  let text = ''
  let codePoint = 0
  let needed = 0
  let seen = 0
  let lower = 0x80
  let upper = 0xbf
  const emit = (unit: number) => {
    units.push(unit)
    if (units.length >= 8192) {
      text += String.fromCharCode(...units)
      units.length = 0
    }
  }
  const emitCodePoint = (value: number) => {
    if (value < 0x10000) {
      emit(value)
    } else {
      emit(0xd800 + ((value - 0x10000) >> 10))
      emit(0xdc00 + ((value - 0x10000) & 0x3ff))
    }
  }
  const start = bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf ? 3 : 0
  for (let i = start; i < bytes.length; i += 1) {
    const byte = bytes[i]!
    if (needed === 0) {
      if (byte <= 0x7f) emit(byte)
      else if (byte >= 0xc2 && byte <= 0xdf) {
        needed = 1
        codePoint = byte & 0x1f
      } else if (byte >= 0xe0 && byte <= 0xef) {
        if (byte === 0xe0) lower = 0xa0
        if (byte === 0xed) upper = 0x9f
        needed = 2
        codePoint = byte & 0xf
      } else if (byte >= 0xf0 && byte <= 0xf4) {
        if (byte === 0xf0) lower = 0x90
        if (byte === 0xf4) upper = 0x8f
        needed = 3
        codePoint = byte & 0x7
      } else emit(0xfffd)
      continue
    }
    if (byte < lower || byte > upper) {
      // The byte that broke the sequence starts the next one.
      codePoint = needed = seen = 0
      lower = 0x80
      upper = 0xbf
      emit(0xfffd)
      i -= 1
      continue
    }
    lower = 0x80
    upper = 0xbf
    codePoint = (codePoint << 6) | (byte & 0x3f)
    seen += 1
    if (seen === needed) {
      emitCodePoint(codePoint)
      codePoint = needed = seen = 0
    }
  }
  if (needed !== 0) emit(0xfffd)
  return text + String.fromCharCode(...units)
}

/** The length of `text` encoded as UTF-8, a lone surrogate counting as U+FFFD (3 bytes). */
function utf8ByteLength(text: string): number {
  let bytes = 0
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i)
    if (code < 0x80) bytes += 1
    else if (code < 0x800) bytes += 2
    else if (code >= 0xd800 && code <= 0xdbff && (text.charCodeAt(i + 1) & 0xfc00) === 0xdc00) {
      bytes += 4
      i += 1
    } else bytes += 3
  }
  return bytes
}

/**
 * Best-effort, non-blocking release of a body whose read failed or lost the
 * race to the deadline, for a fetch implementation that ignores the signal
 * once the headers have arrived. A web stream is cancelled (a no-op if
 * `blob()`, `arrayBuffer()` or `text()` holds its lock). A Node-style stream is
 * destroyed with the reason, which settles a consumer such as `text()` or an
 * async iterator that listens for `'error'`; with no `'error'` listener it is
 * destroyed without one, since an unhandled `'error'` event would crash the
 * process.
 */
function releaseBody(body: unknown, reason: unknown): void {
  if (body === null || typeof body !== 'object') return
  const stream = body as { cancel?: unknown; destroy?: unknown; listenerCount?: unknown }
  try {
    if (typeof stream.cancel === 'function') {
      const result = stream.cancel(reason) as { then?: unknown } | null | undefined
      if (result && typeof result.then === 'function') (result as PromiseLike<unknown>).then(undefined, () => {})
    } else if (typeof stream.destroy === 'function') {
      const handled = typeof stream.listenerCount === 'function' && Number(stream.listenerCount('error')) > 0
      if (handled) stream.destroy(reason)
      else stream.destroy()
    }
  } catch {
    // Cleanup is best-effort; the timeout remains authoritative.
  }
}

/** Statuses whose responses carry no body; `new Response` rejects one for them. */
const NULL_BODY_STATUSES = new Set([204, 205, 304])

/**
 * The text of every response `bufferedResponse` built, clones included, which
 * `readBody` returns instead of decoding the body again.
 */
const bufferedTexts = new WeakMap<Response, string>()

/**
 * A fully buffered copy of `response`. A custom `fetchFn` (node-fetch on old
 * Node, React Native polyfills) may run where there is no global `Response`,
 * or one that rejects the fetched status, so this falls back to a minimal
 * Response-like object instead of failing the attempt. Its body, and each
 * clone's, is encoded from `text` only if something reads it as a stream or
 * with `text()`, `json()` or `arrayBuffer()`; the client reads `text` itself
 * through `readBody`, so a reply shared by de-duplicated GETs is held once.
 */
function bufferedResponse(response: Response, text: string): Response {
  const body = NULL_BODY_STATUSES.has(response.status) ? null : text
  const buffered = constructedResponse(response, body) ?? plainBufferedResponse(response, body ?? '')
  // Constructed responses (and their clones) have an empty `url`; keep the
  // fetched one for errors, including on clones handed to de-duplicated GETs.
  // `headers` stays the fetched object, which may be a foreign or minimal
  // `Headers`, so it is never handed to the constructor to re-parse.
  Object.defineProperties(buffered, {
    url: { value: response.url },
    headers: { value: response.headers },
    clone: { value: () => bufferedResponse(response, text) },
  })
  bufferedTexts.set(buffered, body ?? '')
  return buffered
}

/** The text `bufferedResponse` kept for `response`; undefined for any other response. */
function bufferedText(response: Response): string | undefined {
  return bufferedTexts.get(response)
}

function constructedResponse(response: Response, body: string | null): Response | undefined {
  if (typeof Response !== 'function') return undefined
  try {
    return new Response(body === null ? null : lazyBody(body), {
      status: response.status,
      statusText: response.statusText,
    })
  } catch {
    return undefined
  }
}

/** A stream that encodes `text` when it is first read, or `text` itself where there is no `ReadableStream`. */
function lazyBody(text: string): ReadableStream<Uint8Array> | string {
  if (typeof ReadableStream !== 'function' || typeof TextEncoder !== 'function') return text
  return new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        if (text !== '') controller.enqueue(new TextEncoder().encode(text))
        controller.close()
      },
    },
    // Without this the stream pulls once as soon as it is built.
    { highWaterMark: 0 }
  )
}

/**
 * The subset of `Response` the client and `request()` callers rely on:
 * status fields, `text()`/`json()` with single-use `bodyUsed` semantics, and
 * (added by the caller) `url`, `headers` and `clone()`. `body` is `null`, as
 * there is no stream to read or cancel.
 */
function plainBufferedResponse(response: Response, text: string): Response {
  let bodyUsed = false
  const consume = async (): Promise<string> => {
    if (bodyUsed) throw new TypeError('Body has already been consumed')
    bodyUsed = true
    return text
  }
  return {
    status: response.status,
    statusText: response.statusText,
    ok: response.status >= 200 && response.status <= 299,
    redirected: response.redirected ?? false,
    type: response.type ?? 'default',
    body: null,
    get bodyUsed() {
      return bodyUsed
    },
    text: consume,
    json: async () => JSON.parse(await consume()) as unknown,
  } as unknown as Response
}

async function discardResponseBody(response: Response, reason?: unknown): Promise<void> {
  if (response.body === null || response.bodyUsed) return
  try {
    await response.body.cancel(reason)
  } catch {
    // Cleanup is best-effort; the retry result remains authoritative.
  }
}

/** A reply as error messages quote it: `url` redacted, `detail` a `responseBodyPreview`. */
function httpReplyMessage(status: number, url: string, detail: string): string {
  return `HTTP ${status} from ${url}${detail ? `: ${escapeControlChars(detail)}` : ''}`
}

/**
 * Unredacted response previews, keyed by error. Only the SDK's own decisions
 * read them (the `/tx/push` fallback): redaction can rewrite words of a reply
 * when a base-URL part matches them.
 */
const rawResponseBodies = new WeakMap<QbitApiError, string>()

function httpError(response: Response, body: string, url: string, baseUrl: string): QbitApiError {
  const status = response.status
  const detail = responseBodyPreview(body, baseUrl)
  const message = httpReplyMessage(status, url, detail)
  const options: QbitApiErrorOptions = { status, url, responseBody: detail }
  const retryAfterMs = parseRetryAfter(response.headers.get('retry-after'))
  if (retryAfterMs !== undefined) options.retryAfterMs = retryAfterMs
  const error =
    status === 429
      ? new QbitApiError('rate_limit', message, options)
      : status === 413
        ? new QbitApiError('payload_too_large', message, options)
        : status === 404
          ? new QbitApiError('not_found', message, options)
          : new QbitApiError('http', message, options)
  rawResponseBodies.set(error, detachedString(body.trim().slice(0, PREVIEW_LENGTH)))
  return error
}

export {
  abortErrorFor,
  BodyLimitExceeded,
  bodyReadError,
  bufferedResponse,
  bufferedText,
  defaultSleep,
  discardResponseBody,
  httpError,
  httpReplyMessage,
  internalAbortController,
  isAbortError,
  isUnshared,
  MAX_TIMER_DELAY_MS,
  openOperationScope,
  parseRetryAfter,
  raceAbort,
  rawResponseBodies,
  readBody,
  readBodyUntilAborted,
  refuseRedirect,
  sendUnshared,
  validBaseUrl,
}

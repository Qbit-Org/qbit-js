// ---------------------------------------------------------------------------
// Error taxonomy (user-presentable)
// ---------------------------------------------------------------------------

/**
 * What went wrong, as {@link QbitApiError.kind} reports it:
 *
 * - `rate_limit`: an HTTP 429 reply the client stopped retrying.
 * - `payload_too_large`: an HTTP 413 reply.
 * - `not_found`: an HTTP 404 reply.
 * - `http`: any other non-2xx reply, a refused redirect, a submission the node
 *   rejected, an invalid `baseUrl` or numeric constructor option, or an
 *   invalid `deadlineMs`, `maxPages` or `maxTransactions`. An invalid
 *   `fetchFn` is `network` instead, and invalid `broadcastTx` and
 *   `feeTiersFromEstimates` arguments are `TypeError`s.
 * - `network`: fetch threw (offline, DNS, CORS), or no fetch implementation
 *   was available.
 * - `timeout`: an attempt exceeded `timeoutMs`, or the call's `deadlineMs`
 *   expired.
 * - `aborted`: the call's or the client's `AbortSignal` fired.
 * - `parse`: a body was not the expected JSON or text, could not be read, or
 *   failed the client's validation.
 * - `pagination_limit`: a history scan exceeded its page or transaction bound.
 * - `invalid_cursor`: an address-history scan could not be shown complete
 *   (retry it later), or a `MempoolQbitClient.getAddressTxs` cursor is stale,
 *   unrelated or unconfirmed.
 * - `unknown_outcome`: a submission may have reached the node. Resubmitting
 *   the same hex is harmless; never rebuild the payment with different inputs.
 *   See
 *   [Broadcasting](https://github.com/Qbit-Org/qbit-js/blob/main/packages/api/docs/broadcasting.md#recovering-from-an-unknown-outcome).
 *
 * An error from another version of this package can carry a kind this version
 * does not list, so keep a default branch when switching on it.
 *
 * @remarks
 * See [Resilience](https://github.com/Qbit-Org/qbit-js/blob/main/packages/api/docs/resilience.md).
 *
 * @category Errors
 */
export type QbitApiErrorKind =
  | 'rate_limit' // HTTP 429
  | 'payload_too_large' // HTTP 413
  | 'not_found' // HTTP 404
  | 'http' // other non-2xx
  | 'network' // fetch threw (offline / DNS / CORS)
  | 'timeout' // request or call deadline expired
  | 'aborted' // caller's AbortSignal fired
  | 'parse' // body was not the expected JSON/text
  | 'pagination_limit' // history scan exceeded its configured page or transaction bound
  | 'invalid_cursor' // an address-history scan could not be shown complete; retry it
  | 'unknown_outcome' // a submission may have reached the node; see docs/broadcasting.md

/**
 * Optional fields of a new {@link QbitApiError}. Each one given is copied to the
 * error's property of the same name, except `unredactedCause`.
 *
 * @category Errors
 */
export interface QbitApiErrorOptions {
  /** The error's {@link QbitApiError.status}. */
  status?: number
  /** The error's {@link QbitApiError.url}. */
  url?: string
  /** The error's {@link QbitApiError.cause}. */
  cause?: unknown
  /**
   * The underlying error before redaction. It is kept off the error object:
   * read it with `QbitApiError.unredactedCause(error)`.
   */
  unredactedCause?: unknown
  /** The error's {@link QbitApiError.retryAfterMs}. */
  retryAfterMs?: number
  /**
   * Trimmed response body preview, capped at 200 characters. Errors the client
   * creates redact the base URL from it as they do in `message`.
   */
  responseBody?: string
  /** Transaction id of the submission an `unknown_outcome` error refers to, when known. */
  txid?: string
}

/** Underlying errors before redaction, by the `QbitApiError` that carries their redacted copy. */
const unredactedCauses = new WeakMap<object, unknown>()

/** Brand shared by every copy of this class: `Symbol.for` keys are global across builds and realms. */
const QBIT_API_ERROR_BRAND = Symbol.for('qbit-js.QbitApiError')

/**
 * The error the clients and adapters throw for a failed request, a reply they
 * reject, or an invalid constructor option, `deadlineMs`, `maxPages` or
 * `maxTransactions`, classified by {@link QbitApiError.kind}. Its `name` is
 * `'QbitApiError'`.
 *
 * Recognize it with {@link QbitApiError.is} rather than `instanceof`, which is
 * false for an error from another copy of this package (the other build, or
 * another version).
 *
 * @remarks
 * Errors the client creates redact the base URL from `url`, `message` and
 * `responseBody`, and attach underlying errors as a redacted `cause`, with the
 * exceptions {@link QbitApiError.cause} lists; see
 * [Logging errors](https://github.com/Qbit-Org/qbit-js/blob/main/packages/api/docs/logging-and-redaction.md).
 * The kinds, and which failures are retried, are in
 * [Resilience](https://github.com/Qbit-Org/qbit-js/blob/main/packages/api/docs/resilience.md).
 *
 * @category Errors
 */
export class QbitApiError extends Error {
  /**
   * What went wrong; see {@link QbitApiErrorKind}. An error from another
   * version of this package can carry a kind this version does not list.
   */
  readonly kind: QbitApiErrorKind
  /** HTTP status of the reply the error is about, when there was one. */
  readonly status?: number
  /**
   * URL of the request the error is about, when the error names one. Errors
   * the client creates show the base URL as its origin, followed by `/...` in
   * place of any path, then the endpoint path, e.g.
   * `https://host/.../blocks/tip/height`.
   */
  readonly url?: string
  /**
   * The reply's `Retry-After` header in ms, as the client parsed it
   * (delta-seconds or an HTTP date), on the errors the client builds from a
   * reply's status, such as `rate_limit`, when the reply carried one.
   */
  readonly retryAfterMs?: number
  /**
   * The underlying error. Errors the client creates attach a redacted copy,
   * safe to log: see `QbitApiError.unredactedCause`. A JSON `parse` error's
   * cause is a generic `SyntaxError` instead. Two causes are passed through
   * unchanged: an `aborted` error's, which is the signal's reason, and a
   * `QbitApiError`, such as one a custom `fetchFn` threw.
   */
  readonly cause?: unknown
  /**
   * Trimmed response body preview, capped at 200 characters. Errors the client
   * creates redact the base URL from it as they do in `message`, but do not
   * escape control characters in it.
   */
  readonly responseBody?: string
  /**
   * On an `unknown_outcome` error, the transaction id of the submission, when
   * known: one was supplied or could be derived from the hex. See
   * [Recovering from an unknown outcome](https://github.com/Qbit-Org/qbit-js/blob/main/packages/api/docs/broadcasting.md#recovering-from-an-unknown-outcome).
   */
  readonly txid?: string

  /**
   * The underlying error of `error` as the fetch implementation threw it, or
   * undefined. Its message, stack and properties can contain the full request
   * URL, base-URL secrets included, so it is kept off the error object, where
   * no logger, error reporter or serializer can reach it. Do not log it where
   * the base URL is secret. It is only found for an error from this copy of
   * the package.
   *
   * @param error - Any value; an error from this copy of the package that has
   *   an unredacted cause yields it.
   * @returns The unredacted underlying error, or undefined.
   */
  static unredactedCause(error: unknown): unknown {
    return typeof error === 'object' && error !== null ? unredactedCauses.get(error) : undefined
  }

  /**
   * Whether `value` is a `QbitApiError` (or a subclass instance) from any copy
   * of `@qbit-oss/api`. `instanceof` only recognizes errors from the same copy,
   * so it is false when an app loads both the CommonJS and the ESM build (or
   * two installed versions) and the error comes from the other one. This checks
   * a brand, `Symbol.for('qbit-js.QbitApiError')`, set on the class prototype
   * instead. It identifies the class, not where the error came from: any code
   * can set the brand. An error from another version can carry a `kind` this
   * version does not list, so keep a default branch when switching on it.
   *
   * @param value - Any value, typically a caught error.
   * @returns True when `value` carries the `QbitApiError` brand.
   *
   * @example
   * ```ts
   * try {
   *   await client.getAddressBalance(address)
   * } catch (error) {
   *   if (!QbitApiError.is(error)) throw error
   *   switch (error.kind) {
   *     case 'parse':
   *       // The backend's reply failed validation; see the Response validation page.
   *       break
   *     case 'rate_limit':
   *       // error.retryAfterMs is the server's Retry-After, when it sent one.
   *       break
   *     default:
   *       // Every other kind, including any a newer version adds.
   *       throw error
   *   }
   * }
   * ```
   */
  static is(value: unknown): value is QbitApiError {
    return (
      typeof value === 'object' && value !== null && (value as Record<symbol, unknown>)[QBIT_API_ERROR_BRAND] === true
    )
  }

  /**
   * Creates an error of `kind`. A custom `fetchFn` can throw one; how the
   * client passes it on is described under {@link EsploraClientOptions.fetchFn}.
   *
   * @param kind - What went wrong.
   * @param message - The error message, used as given.
   * @param options - Optional fields, copied to the properties of the same
   *   name; `unredactedCause` is kept off the error object.
   */
  constructor(kind: QbitApiErrorKind, message: string, options: QbitApiErrorOptions = {}) {
    super(message)
    this.name = 'QbitApiError'
    this.kind = kind
    if (options.status !== undefined) this.status = options.status
    if (options.url !== undefined) this.url = options.url
    if (options.retryAfterMs !== undefined) this.retryAfterMs = options.retryAfterMs
    if (options.cause !== undefined) this.cause = options.cause
    if (options.unredactedCause !== undefined) unredactedCauses.set(this, options.unredactedCause)
    if (options.responseBody !== undefined) this.responseBody = options.responseBody
    if (options.txid !== undefined) this.txid = options.txid
  }
}

Object.defineProperty(QbitApiError.prototype, QBIT_API_ERROR_BRAND, { value: true })

/**
 * The base URL as errors show it: its origin, with `/...` in place of any path
 * or query, where hosted indexers often put an API token
 * (`https://host/<token>/api`). Errors get logged and reported. Read by hand
 * after the runtime's URL parser has normalized it, as in `schemeAndHost`:
 * React Native's `origin` throws before 0.80 and keeps credentials from 0.80.
 * `...` alone when the host cannot be read reliably.
 */
function redactedBaseUrl(baseUrl: string): string {
  let href = baseUrl
  try {
    href = new URL(baseUrl).href
  } catch {
    // Not parsable here: read the configured spelling.
  }
  const match = /^(https?:)[/\\]*([^/?#\\]*)/i.exec(href)
  if (!match) return '...' // Not an http(s) URL: show none of it.
  const host = match[2]!.slice(match[2]!.lastIndexOf('@') + 1).toLowerCase()
  // A password with a raw `/`, `?`, `#` or `\` ends the authority early, so
  // the host read can be `user:password-prefix`, or (`apikey:8443/x@host`) a
  // username and a numeric password the URL parser takes for host and port.
  // Show only a plain host[:port] with no `@` after it.
  if (!/^(?:[a-z\d._~-]+|\[[a-f\d:.]+\])(?::\d*)?$/.test(host) || href.slice(match[0].length).includes('@')) {
    return '...'
  }
  const origin = `${match[1]!.toLowerCase()}//${host}`
  return basePath(href) ? `${origin}/...` : origin
}

/**
 * `text` with the base URL replaced by `redactedBaseUrl`, both as configured
 * and as the URL parser normalizes it: fetch implementations quote either form
 * in their own error messages. The base URL's path and query become `/...`
 * where they appear on their own, as servers quote the request path (Express:
 * `Cannot GET /<token>/api/blocks/tip/height`), and each of `baseUrlParts`
 * becomes `...`, as a server may quote a token alone. One pass, longest match
 * first, so replaced text is not matched again.
 */
function redactBaseUrl(text: string, baseUrl: string): string {
  const spellings = [baseUrl]
  try {
    spellings.push(new URL(baseUrl).href.replace(/\/+$/, ''))
  } catch {
    // Unparsable: only the configured spelling can appear.
  }
  const redacted = redactedBaseUrl(baseUrl)
  const replacements = new Map<string, string>()
  for (const part of spellings.flatMap(baseUrlParts)) replacements.set(part, '...')
  for (const path of spellings.map(basePath)) if (path) replacements.set(path, '/...')
  for (const spelling of spellings) if (spelling) replacements.set(spelling, redacted)
  if (replacements.size === 0) return text
  const pattern = [...replacements.keys()]
    .sort((a, b) => b.length - a.length)
    .map(needle => needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('|')
  return text.replace(new RegExp(pattern, 'g'), match => replacements.get(match)!)
}

/**
 * Parts of a base URL that a server may quote on their own (`invalid api key
 * <token>`, a JSON-escaped `\/<token>\/` or `%2F`-joined path): each path
 * segment, query value and userinfo part of at least 8 characters, also
 * percent-decoded. Userinfo runs to the last `@` before the query, so a
 * password with a raw `/` is found whole, and path segments are read both
 * after the authority and after that `@`.
 */
function baseUrlParts(url: string): string[] {
  const match = /^(?:[a-z][a-z\d+.-]*:[/\\]*)?([^?#]*)(?:\?([^#]*))?/i.exec(url)!
  const beforeQuery = match[1]!
  const at = beforeQuery.lastIndexOf('@')
  const userinfo = at === -1 ? '' : beforeQuery.slice(0, at)
  const colon = userinfo.indexOf(':')
  const parts = [
    ...(colon === -1 ? [userinfo] : [userinfo.slice(0, colon), userinfo.slice(colon + 1)]),
    ...beforeQuery.split(/[/\\]/).slice(1),
    ...beforeQuery
      .slice(at + 1)
      .split(/[/\\]/)
      .slice(1),
    ...(match[2] ?? '').split('&').map(pair => pair.slice(pair.indexOf('=') + 1)),
  ]
  return parts.flatMap(part => [part, percentDecoded(part)]).filter(part => part.length >= 8)
}

function percentDecoded(text: string): string {
  try {
    return decodeURIComponent(text)
  } catch {
    return text
  }
}

/** What follows the origin of an absolute URL; empty for a bare origin or a relative URL. */
function basePath(url: string): string {
  const path = /^[a-z][a-z\d+.-]*:[/\\]*[^/?#\\]*(.*)$/i.exec(url)?.[1] ?? ''
  return path === '/' ? '' : path
}

/**
 * A redirect target's origin with the base URL's parts redacted. The server
 * chose it, and a provider that moves a key from the path into a subdomain
 * would put the key in the message. Hosts are lowercased, so parts are matched
 * case-insensitively.
 */
function redactRedirectTarget(target: string, baseUrl: string): string {
  const redacted = redactBaseUrl(target, baseUrl)
  const parts = [...new Set(baseUrlParts(baseUrl))].sort((a, b) => b.length - a.length)
  if (parts.length === 0) return redacted
  const pattern = parts.map(part => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')
  return redacted.replace(new RegExp(pattern, 'gi'), '...')
}

/** A response body preview: trimmed, the base URL redacted, capped at 200 characters. */
function responseBodyPreview(text: string, baseUrl: string): string {
  return redactBaseUrl(text.trim(), baseUrl).slice(0, 200)
}

/** Response text quoted in an error message: `responseBodyPreview` with control characters escaped. */
function quotedResponseText(text: string, baseUrl: string): string {
  return escapeControlChars(responseBodyPreview(text, baseUrl))
}

/** How many levels of nested errors and objects a redacted cause keeps. */
const REDACTED_CAUSE_DEPTH = 5

/** Built-in error classes a redacted cause keeps, so `cause instanceof TypeError` still holds. */
const NATIVE_ERRORS: (new (message?: string) => Error)[] = [
  Error,
  TypeError,
  RangeError,
  SyntaxError,
  ReferenceError,
  EvalError,
  URIError,
]

/** `QbitApiError` options for an underlying error: a redacted `cause`, the original kept off the error. */
function causeOptions(cause: unknown, baseUrl: string): { cause: unknown; unredactedCause: unknown } {
  return { cause: redactedCause(cause, baseUrl, REDACTED_CAUSE_DEPTH), unredactedCause: cause }
}

/**
 * A copy of an underlying error that is safe to log. Fetch implementations put
 * the full request URL in their errors (Bun's `path`, Node's messages for a
 * credentialed or relative URL, node-fetch's), and loggers print `cause`
 * (`console.error`, `util.inspect`, Sentry, pino). Strings pass through
 * `redactBaseUrl`: the message, the stack and every string property. Errors
 * (a nested `cause` included), arrays and plain objects are copied the same
 * way, `depth` levels deep, keeping each property's enumerability; deeper
 * values, accessors and other objects are left out. An error keeps its
 * `name`, and its class when that is a built-in one.
 */
function redactedCause(value: unknown, baseUrl: string, depth: number): unknown {
  if (typeof value === 'string') return redactBaseUrl(value, baseUrl)
  if (typeof value === 'function') return undefined
  if (typeof value !== 'object' || value === null) return value
  if (depth === 0) return undefined
  if (Array.isArray(value)) return value.map(item => redactedCause(item, baseUrl, depth - 1))
  try {
    let copy: object
    const prototype: unknown = Object.getPrototypeOf(value)
    if (value instanceof Error) {
      const ErrorClass = NATIVE_ERRORS.find(errorClass => errorClass === value.constructor) ?? Error
      const error = new ErrorClass(redactBaseUrl(String(value.message), baseUrl))
      if (error.name !== value.name) {
        Object.defineProperty(error, 'name', { value: String(value.name), writable: true, configurable: true })
      }
      error.stack =
        typeof value.stack === 'string' ? redactBaseUrl(value.stack, baseUrl) : `${error.name}: ${error.message}`
      copy = error
    } else if (prototype === Object.prototype || prototype === null) {
      copy = {}
    } else {
      return undefined
    }
    for (const key of Object.getOwnPropertyNames(value)) {
      if (value instanceof Error && (key === 'message' || key === 'stack')) continue
      const descriptor = Object.getOwnPropertyDescriptor(value, key)
      if (descriptor === undefined || !('value' in descriptor)) continue
      const redacted = redactedCause(descriptor.value, baseUrl, depth - 1)
      if (redacted === undefined && descriptor.value !== undefined) continue
      Object.defineProperty(copy, key, {
        value: redacted,
        enumerable: descriptor.enumerable ?? false,
        writable: true,
        configurable: true,
      })
    }
    return copy
  } catch {
    return undefined
  }
}

/**
 * Response text for an error message, with control characters (CR and LF
 * included), Unicode line separators and bidi controls escaped so a hostile
 * body cannot forge or reorder log lines. `responseBody` keeps them unescaped.
 */
function escapeControlChars(text: string): string {
  return text.replace(/[\p{Cc}\p{Zl}\p{Zp}\p{Bidi_Control}]/gu, char => {
    if (char === '\n') return '\\n'
    if (char === '\r') return '\\r'
    if (char === '\t') return '\\t'
    return `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`
  })
}

function formatErrorCause(error: unknown): string {
  if (error instanceof Error) {
    return ` (${error.name}: ${error.message})`
  }
  if (typeof error === 'string') {
    return ` (${error})`
  }
  return ''
}

export {
  causeOptions,
  escapeControlChars,
  formatErrorCause,
  quotedResponseText,
  redactBaseUrl,
  redactedBaseUrl,
  redactRedirectTarget,
  responseBodyPreview,
}

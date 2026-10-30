import { QbitApiError, type QbitApiErrorOptions } from './errors'
import { isRecord } from './validation'
import { rawResponseBodies } from './transport'

/** Error codes that only occur before a connection exists, so nothing was sent. */
const PRE_CONNECTION_ERROR_CODES = new Set(['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'UND_ERR_CONNECT_TIMEOUT'])
/** Route errors that are pre-send only from the connect syscall; later ones can follow a written request. */
const CONNECT_STAGE_ERROR_CODES = new Set(['EHOSTUNREACH', 'ENETUNREACH'])
/**
 * String codes a backend relays when its own node call fails: Node system and
 * internal errors (`ETIMEDOUT`, `ECONNRESET`, `ERR_STREAM_PREMATURE_CLOSE`),
 * undici (`UND_ERR_*`) and http-parser (`HPE_*`) errors. Other strings are
 * gateway or application codes that say nothing about the node call.
 */
const TRANSPORT_ERROR_CODE_PATTERN = /^(?:E[A-Z0-9_]+|UND_ERR_[A-Z0-9_]+|HPE_[A-Z0-9_]+)$/

function unknownOutcomeError(
  url: string,
  txid: string | undefined,
  reason: string,
  options: Omit<QbitApiErrorOptions, 'url' | 'txid'> = {}
): QbitApiError {
  const subject = txid === undefined ? 'the transaction' : `txid ${txid}`
  // Without a known txid an already-known reply cannot resolve, so say how to supply one.
  const resubmit = txid === undefined ? 'resubmit the same hex with its { txid }' : 'resubmit the same hex'
  return new QbitApiError(
    'unknown_outcome',
    `transaction submission outcome unknown (${reason}); ${subject} may have been accepted; ${resubmit}, and never rebuild the payment with different inputs`,
    { ...options, url, ...(txid === undefined ? {} : { txid }) }
  )
}

interface ErrorCodeEntry {
  code: string
  syscall: string | undefined
}

/**
 * True when every coded error in the chain says no connection was
 * established. `EHOSTUNREACH`/`ENETUNREACH` count only from the connect
 * syscall, since a route can also vanish after the request was written.
 */
function isPreConnectionFailure(error: unknown): boolean {
  const entries = collectErrorCodes(error, 0, [])
  return (
    entries.length > 0 &&
    entries.every(
      entry =>
        PRE_CONNECTION_ERROR_CODES.has(entry.code) ||
        (CONNECT_STAGE_ERROR_CODES.has(entry.code) && entry.syscall === 'connect')
    )
  )
}

function collectErrorCodes(error: unknown, depth: number, entries: ErrorCodeEntry[]): ErrorCodeEntry[] {
  if (!isRecord(error)) return entries
  // Too deep to judge: count it as a failure that may have reached the server,
  // so a cut-off member can't leave only pre-connection codes behind.
  if (depth > 5) {
    entries.push({ code: 'UNJUDGED', syscall: undefined })
    return entries
  }
  const nested = error['errors']
  if (Array.isArray(nested) && nested.length > 0) {
    // An AggregateError (happy eyeballs) summarises its members; judge each member.
    for (const entry of nested) collectErrorCodes(entry, depth + 1, entries)
  } else if (typeof error['code'] === 'string') {
    const syscall = error['syscall']
    entries.push({ code: error['code'], syscall: typeof syscall === 'string' ? syscall : undefined })
  }
  collectErrorCodes(error['cause'], depth + 1, entries)
  return entries
}

/**
 * Node replies meaning this exact transaction is already in the mempool or
 * chain: qbit Core's `txn-already-in-mempool`, `txn-already-known`,
 * `txn-same-nonwitness-data-in-mempool`, and RPC error -27 (already in block
 * chain / outputs already in utxo set), as relayed by esplora and mempool.
 * Conflicts with a different transaction (`txn-mempool-conflict`,
 * `bad-txns-inputs-missingorspent`) are not matched.
 */
const ALREADY_KNOWN_BROADCAST_REPLY =
  /\b(?:txn already in mempool|txn already known|txn same nonwitness data in mempool|transaction already in block ?chain|transaction outputs already in utxo set)\b/

function isAlreadyKnownBroadcastReply(reply: BroadcastReply): boolean {
  if (reply.code === -27) return true
  return ALREADY_KNOWN_BROADCAST_REPLY.test(normalizeReplyText(reply.message))
}

/**
 * A reply in which the backend reports that its own call to the node failed
 * in transit or came back unreadable, so the node may still have processed
 * it. mempool-qbit serialises the transport error code (`{"code":"ETIMEDOUT"}`,
 * `ESOCKETTIMEDOUT`, `ECONNRESET`; backend/src/rpc-api/jsonrpc.ts via
 * bitcoin.routes.ts), `-32603` when the node answered 200 with an unreadable
 * body, or `-32602` when it answered non-200 with one: qbit Core answers 500
 * for every RPC error, so that reply may have been a -27 (already confirmed)
 * as well as a rejection or an auth failure, and `sendrawtransaction` itself
 * never raises -32602. qbit-electrs answers `Connection error` once it cannot
 * reconnect to the daemon (src/daemon.rs). Codes proving the backend never
 * connected (`PRE_CONNECTION_ERROR_CODES`: `ECONNREFUSED`, `ENOTFOUND`,
 * `EAI_AGAIN`, `UND_ERR_CONNECT_TIMEOUT`) stay definite failures.
 */
function isRelayedTransportFailure(reply: BroadcastReply): boolean {
  if (typeof reply.code === 'string') return !PRE_CONNECTION_ERROR_CODES.has(reply.code)
  if (reply.code === -32603 || reply.code === -32602) return true
  return /^connection error\b/.test(normalizeReplyText(reply.message))
}

/**
 * JSON-RPC request-level codes: the server refused the request before running
 * any method (qbit Core src/rpc/protocol.h). `-32602` is left out because a
 * relaying backend reuses it for an unreadable non-200 node reply; see
 * `isRelayedTransportFailure`.
 */
const RPC_REQUEST_ERROR_CODES = new Set([-32700, -32600, -32601])

/**
 * True for an RPC error code that is the node's verdict on the request: one of
 * qbit Core's application codes (src/rpc/protocol.h defines -1 … -36; for
 * `sendrawtransaction` that is -22 `TX decode failed`, -25 verify error /
 * missing inputs, -26 rejected by network rules, -28 warming up, and the
 * parameter errors -1/-3/-8, all raised before the mempool is touched —
 * src/rpc/mempool.cpp, src/rpc/util.cpp `RPCErrorFromTransactionError`), or
 * a request-level code. `-32603` and `-32602` (mempool-qbit's markers for an
 * unreadable node reply) and the implementation-defined server-error range
 * `-32099 … -32000`, which Core never emits and proxies use for upstream
 * failures, describe the server or its transport, not the transaction.
 */
function isNodeVerdictCode(code: number): boolean {
  return (code >= -99 && code <= -1) || RPC_REQUEST_ERROR_CODES.has(code)
}

/**
 * qbit Core's literal transaction reject reasons (src/validation.cpp,
 * src/policy/policy.cpp, src/consensus/tx_check.cpp, src/rpc/mempool.cpp),
 * recognised only at the start of an uncoded reply. Reasons that are ordinary
 * words (`coinbase`, `version`) are left out so a gateway page cannot match.
 */
const DEFINITE_REJECTION_REPLY =
  /^(?:bad txns |bad witness nonstandard|bad cb length|txn mempool conflict|tx decode failed|tx size\b|tx output not p2mr|scriptsig (?:size|not pushonly)|scriptpubkey\b|bare multisig|datacarrier|dust\b|non (?:bip68 )?final|(?:mempool |block |(?:non )?mandatory )script verify flag|min relay fee not met|mempool min fee not met|insufficient fee|max feerate exceeded|mempool full|too long mempool chain|truc violation|missing ephemeral spends|bip125 replacement disallowed|too many potential replacements|replacement adds unconfirmed|missing inputs|no mempool\b)/

/**
 * A reply in which the node itself refused or rejected this submission: a
 * node verdict code, a relayed code proving the backend never connected to
 * the node, or, when the body carries no code at all, one of Core's reject
 * reasons. It is consulted only for a 5xx other than 501, 505 and 511, where
 * a match makes the reply a definite `http` error instead of an
 * `unknown_outcome`; see the [outcome table](https://github.com/Qbit-Org/qbit-js/blob/main/packages/api/docs/broadcasting.md#outcomes).
 * Already-known replies are resolved before this is consulted.
 */
function isDefiniteNodeRejection(reply: BroadcastReply): boolean {
  if (typeof reply.code === 'number') return isNodeVerdictCode(reply.code)
  if (typeof reply.code === 'string') return PRE_CONNECTION_ERROR_CODES.has(reply.code)
  return DEFINITE_REJECTION_REPLY.test(normalizeReplyText(reply.message))
}

/**
 * Fallback only after `/tx` reported that it did not submit: a missing route
 * or the backend's generic no-RPC-code failure. `unknown_outcome` never
 * qualifies, since the transaction may already be with the node.
 */
function shouldRetryBroadcastViaTxPush(error: unknown): boolean {
  if (!QbitApiError.is(error)) return false
  // A custom fetchFn's own QbitApiError is judged the same way, although it may
  // have been thrown after the `/tx` POST was sent; the fallback then sends the
  // same hex a second time, which is harmless.
  if (
    (error.kind === 'not_found' && error.status === 404) ||
    (error.kind === 'http' && (error.status === 405 || error.status === 501))
  ) {
    return true
  }
  // Another copy's error keeps its raw body where this copy cannot read it, and
  // its `responseBody` may be a redacted preview, so its body never qualifies.
  const body = error instanceof QbitApiError ? (rawResponseBodies.get(error) ?? error.responseBody) : undefined
  if (error.kind !== 'http' || error.status !== 400 || body === undefined) {
    return false
  }

  // mempool-qbit reserves this generic response for failures without an RPC
  // error code; a reply carrying a node RPC or transport code is never that
  // generic failure, whatever its message says.
  const reply = parseBroadcastReply(body)
  if (reply.code !== undefined) return false
  return /^(?:(?:failed|unable) to|could not) (?:send|submit|broadcast)(?: raw)? transaction$/.test(
    normalizeReplyText(reply.message)
  )
}

interface BroadcastReply {
  /**
   * Node RPC error code (a negative integer, as all of qbit Core's are) or
   * relayed transport code (upper-cased, see `TRANSPORT_ERROR_CODE_PATTERN`)
   * from a structured body. A positive number is an HTTP status echo and
   * any other string a gateway code; neither describes the node call, so
   * both are left out.
   */
  code: number | string | undefined
  /** Human-readable detail: the structured body's message, or the body itself. */
  message: string
}

/**
 * Read a rejection body into its error code and message. Backends answer in
 * several shapes: plain text, optionally with an embedded
 * `sendrawtransaction RPC error: {"code":...,"message":...}` object (esplora,
 * mempool-qbit); the node's JSON-RPC envelope `{"error":{"code","message"}}`;
 * a flat `{"code","message"}` object; or a JSON string / `{"error":"..."}` /
 * `{"message":"..."}` wrapper around the plain-text form. The code is taken
 * from the structured object before the body is reduced to its message, since
 * the code is authoritative while the message may be localised or reworded.
 * A nested `error.code` wins over a top-level `code`.
 */
function parseBroadcastReply(body: string): BroadcastReply {
  let text = body
  try {
    const parsed = JSON.parse(body) as unknown
    if (typeof parsed === 'string') {
      text = parsed
    } else if (isRecord(parsed)) {
      const nested = parsed['error']
      const code = errorCodeOf(nested) ?? errorCodeOf(parsed)
      let message = body
      if (typeof nested === 'string') message = nested
      else if (isRecord(nested) && typeof nested['message'] === 'string') message = nested['message']
      else if (typeof parsed['message'] === 'string') message = parsed['message']
      // A JSON wrapper around the plain-text form still carries the code in that text.
      return { code: code ?? embeddedErrorCode(message), message }
    }
  } catch {
    // Plain-text backend errors are expected here.
  }
  return { code: embeddedErrorCode(text), message: text }
}

function errorCodeOf(value: unknown): number | string | undefined {
  if (!isRecord(value)) return undefined
  const code = value['code']
  if (typeof code === 'number') return Number.isInteger(code) && code < 0 ? code : undefined
  if (typeof code !== 'string') return undefined
  const transportCode = code.toUpperCase()
  return TRANSPORT_ERROR_CODE_PATTERN.test(transportCode) ? transportCode : undefined
}

/**
 * Code from an esplora/mempool `sendrawtransaction RPC error: {"code":...}`
 * object embedded in plain text: a number for node RPC errors, or a string
 * when mempool-qbit relays its own transport failure (`{"code":"ETIMEDOUT"}`).
 */
function embeddedErrorCode(text: string): number | string | undefined {
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start === -1 || end <= start) return undefined
  try {
    const parsed = JSON.parse(text.slice(start, end + 1)) as unknown
    if (isRecord(parsed)) return errorCodeOf(parsed['error']) ?? errorCodeOf(parsed)
  } catch {
    // Not an RPC error object; the caller falls back to message matching.
  }
  return undefined
}

function normalizeReplyText(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
}

export {
  isAlreadyKnownBroadcastReply,
  isDefiniteNodeRejection,
  isPreConnectionFailure,
  isRelayedTransportFailure,
  parseBroadcastReply,
  shouldRetryBroadcastViaTxPush,
  unknownOutcomeError,
}

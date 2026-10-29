# Resilience

Timeouts, retries, cancellation, de-duplication and the error taxonomy shared by
every client method.

- Per-request timeout (`AbortController`) covering both the response headers
  and the full body, error bodies included; a body that stalls is cancelled.
  For a read, not a submission, it fails as `timeout` (retried with backoff,
  not `Retry-After`). A submission whose reply stalls or cannot be read is
  never re-sent, since the node may already have it: it rejects with
  `unknown_outcome` (see [Broadcasting](broadcasting.md)). The exception is a `429`, which
  proves nothing was processed even when its body is lost: it is retried with
  backoff, and rejects as `rate_limit` once retries run out.
- Retry with exponential backoff on network errors, timeouts, `5xx`, and `429`
  (honoring `Retry-After` up to `maxRetryAfterMs`, default 30 s) for reads. When
  the server asks for a longer wait, the client does not sleep: it throws the
  `rate_limit` / `http` error immediately with `retryAfterMs` set so the UI can
  decide when to try again. Submissions follow the stricter policy in
  [Broadcasting](broadcasting.md): an attempt that may have reached the node is never re-sent.
- Cancellation and an overall deadline per call: every method accepts a final
  `{ signal, deadlineMs }` options argument (`getAddressHistory` takes them
  alongside `maxPages`/`maxTransactions`, `broadcastTx` alongside `txid`).
  Both cover every dependent request of the call — pagination, retries,
  backoff sleeps, and body reads — so a history scan stops fetching as soon as
  either fires. An abort rejects with a new error of kind `aborted` whose
  `cause` is the signal's reason; an expired `deadlineMs` rejects with kind
  `timeout` and is not retried. A constructor `signal` cancels every call on
  the client.
- **`broadcastTx`** (either client, including the mempool-qbit `/tx/push`
  fallback): an abort or expired deadline before the POST is sent rejects with
  `aborted` / `timeout`, and nothing was submitted. Once the POST may have been
  sent — while it is in flight or its reply body is being read — the call
  rejects with `unknown_outcome` carrying `txid`, with the `aborted` /
  `timeout` error as `cause`; check `getTxStatus(error.txid)` before
  resubmitting (see [Broadcasting](broadcasting.md)). The client never re-sends a POST after an
  abort, an expired deadline, or an attempt that hit `timeoutMs`. A `429`
  reply is the exception: it proves nothing was submitted, so an abort or
  deadline while its body is read rejects with `aborted` / `timeout`, and a
  `429` whose body hit `timeoutMs` is retried like any other `429`.
- An abort or expired deadline while a response body is still streaming
  cancels that body stream, releasing the connection. For de-duplicated
  `GET`s, the shared body is cancelled only once every caller reading it has
  given up.
- In-flight de-duplication of identical concurrent `GET`s (polling-friendly).
  One caller aborting stops only its own wait; the shared request is cancelled
  only when every caller waiting on it has given up.
- Fetch credentials default to `omit`; authenticated reverse proxies can opt
  into `same-origin` or `include` with the `credentials` option.
- Typed `QbitApiError` taxonomy for UI: `rate_limit` (429), `payload_too_large`
  (413), `not_found` (404), `http`, `network`, `timeout`, `aborted`, `parse`,
  `pagination_limit` (a history scan hit `maxPages` / `maxTransactions`),
  `invalid_cursor` (a history scan could not be shown complete; retry it), and
  `unknown_outcome` (a submission may have reached the node; carries `txid`).
- `QbitApiError.is(error)` recognizes a `QbitApiError` from any copy of this
  package. Use it instead of `instanceof` where the app can load both the
  CommonJS and the ESM build (an ESM app with a CommonJS dependency, or a
  bundler mixing `import` and `require`), or two versions: each copy has its
  own class, and `instanceof` is false for an error from the other one. It
  checks the `Symbol.for('qbit-js.QbitApiError')` brand on the class
  prototype. Any code can set that brand, so it classifies errors, it does not
  authenticate them. An error from another version can carry a `kind` this one
  does not list, so keep a default branch. `QbitApiError.unredactedCause` only
  finds the cause of an error from its own copy.

```ts
const controller = new AbortController()
const history = client.getAddressHistory(address, {
  signal: controller.signal, // e.g. aborted when the user switches address
  deadlineMs: 30_000,        // whole scan, including retries and backoff
})
```

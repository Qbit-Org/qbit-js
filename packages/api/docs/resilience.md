# Resilience

Timeouts, retries, cancellation, de-duplication and the error taxonomy shared by
every client method.

- Per-request timeout (`AbortController`) covering both the response headers
  and the full body, error bodies included; a body that stalls is cancelled.
  For a read it fails as `timeout` (retried with backoff, not `Retry-After`);
  for a submission, see the [outcome table](broadcasting.md#outcomes).
- Retry with exponential backoff on network errors, timeouts, `500`, `502`,
  `503`, `504` and `429` (honoring `Retry-After` up to `maxRetryAfterMs`,
  default 30 s) for reads; other `5xx` replies, and a reply over
  `maxResponseBytes`, are not retried. When
  the server asks for a longer wait, the client does not sleep: it throws the
  `rate_limit` / `http` error immediately with `retryAfterMs` set so the UI can
  decide when to try again. Submissions are retried only as the
  [outcome table](broadcasting.md#outcomes) says.
- Cancellation and an overall deadline per call: every method accepts a final
  `{ signal, deadlineMs }` options argument (`getAddressHistory` takes them
  alongside `maxPages`/`maxTransactions`, `broadcastTx` alongside `txid`).
  Both cover every dependent request of the call — pagination, retries,
  backoff sleeps, and body reads — so a history scan stops fetching as soon as
  either fires. An abort rejects with a new error of kind `aborted` whose
  `cause` is the signal's reason; an expired `deadlineMs` rejects with kind
  `timeout` and is not retried. A constructor `signal` cancels every call on
  the client.
- **`broadcastTx`** (either client, including the `/tx/push` fallback): what an
  abort, an expired deadline or an attempt timeout means for a submission is in
  the [outcome table](broadcasting.md#outcomes).
- An abort or expired deadline while a response body is still streaming
  cancels that body stream, releasing the connection. For de-duplicated
  `GET`s, the shared body is cancelled only once every caller reading it has
  given up.
- In-flight de-duplication of identical concurrent `GET`s (polling-friendly).
  One caller aborting stops only its own wait; the shared request is cancelled
  only when every caller waiting on it has given up.
- A size limit on every response body, `maxResponseBytes` (see
  [Configuration](configuration.md#response-size-limit)), counted as the bytes
  arrive. Once a body passes it the client cancels the body and stops
  reading: a read fails with `response_too_large` and is not retried, and a
  submission is judged by the [outcome table](broadcasting.md#outcomes).
  De-duplicated `GET`s share one request, so they share one limit, and one
  copy of the body.
- Fetch credentials default to `omit`; authenticated reverse proxies can opt
  into `same-origin` or `include` with the `credentials` option.
- Typed `QbitApiError` taxonomy for UI: `rate_limit` (429), `payload_too_large`
  (413), `not_found` (404), `http`, `network`, `timeout`, `aborted`, `parse`,
  `response_too_large` (a reply's body passed `maxResponseBytes`; never a
  submission's outcome),
  `pagination_limit` (a history scan hit `maxPages` / `maxTransactions`),
  `invalid_cursor` (a history scan could not be shown complete; retry it), and
  `unknown_outcome` (a submission may have reached the node; carries `txid`
  when one is known).
- `QbitApiError.is(error)` recognizes a `QbitApiError` from any copy of this
  package. Use it instead of `instanceof` where the app can load both the
  CommonJS and the ESM build (an ESM app with a CommonJS dependency, or a
  bundler mixing `import` and `require`), or two versions: each copy has its
  own class, and `instanceof` is false for an error from the other one. It
  checks the `Symbol.for('qbit-js.QbitApiError')` brand on the class
  prototype. Any code can set that brand, so it classifies errors, it does not
  authenticate them. An error from another version can carry a `kind` this one
  does not list, so keep a default branch: `response_too_large`, new in 0.1.1,
  reaches code written for 0.1.0 there. `QbitApiError.unredactedCause` only
  finds the cause of an error from its own copy.

```ts
const controller = new AbortController()
const history = client.getAddressHistory(address, {
  signal: controller.signal, // e.g. aborted when the user switches address
  deadlineMs: 30_000,        // whole scan, including retries and backoff
})
```

# @qbit-oss/api

Typed [esplora](https://github.com/Blockstream/esplora/blob/master/API.md) REST
client for qbit wallets and apps. Talks to an electrs/esplora endpoint
**directly** against a configurable per-chain base URL — no centralized facade.

```ts
import { EsploraClient } from '@qbit-oss/api'

const client = new EsploraClient({ baseUrl: 'https://esplora.example/regtest/api' })

const balance = await client.getAddressBalance(address) // { confirmedSats, mempoolSats, totalSats }
const utxos = await client.getAddressUtxos(address)
const history = await client.getAddressHistory(address) // { confirmed, mempool }
const fees = await client.getFeeTiers() // [{ target, feeRate }] ascending
const txid = await client.broadcastTx(rawTxHex) // see "Broadcasting" below
```

For the `/api/v1` surface of mempool-qbit (qbit's port of the mempool explorer
backend, as served at `mempool.qbit.org/api`), use `MempoolQbitClient`. Its
`getFeeEstimates()` adapter maps the backend's three projected-block quotes to
targets 1, 2, and 3. `getMempoolRecommendedFees()` returns the original named
response, including `economyFee` and `minimumFee`; those values are policy
floors and are not presented as confirmation-target estimates.
Combined address-history pagination is capped at 256 requests per call by
default; pass `maxAddressHistoryPages` to set a different positive integer
limit. Exhaustion throws a `pagination_limit` `QbitApiError` rather than
returning silently truncated history.
`getAddressTxs(address, afterTxid)` scans from the current first page and
requires the exact confirmed address-history cursor before returning older
rows. A stale, unrelated, or unconfirmed cursor throws an `invalid_cursor`
`QbitApiError`.
If a volatile internal cursor disappears and the backend replays an earlier
full page, both history methods also throw `invalid_cursor` rather than return
incomplete results. Short final pages still complete normally.
Without `afterTxid`, an empty page right after a mempool row is checked against
the address stats: qbit-electrs answers that cursor with `[]` instead of the
confirmed rows that follow, so `getAddressTxs` throws `invalid_cursor` when the
stats count more confirmed transactions than it found.
Cursor-validation scan pages count against the same per-call limit; callers
that intentionally page deeper histories must raise `maxAddressHistoryPages`.

For complete scans, prefer `getAddressHistory(address, options)`. It returns
both `{ confirmed, mempool }` from page one without re-fetching mempool-qbit's
combined-history prefix for every 25 confirmed transactions. `EsploraClient`
fetches the mempool set once and exhausts `/txs/chain`; `MempoolQbitClient`
classifies one traversal of the combined `/txs` route. Neither implementation
assumes a fixed page size: completion requires an explicit empty response.

An empty response does not prove the history is complete. qbit-electrs answers
a cursor it cannot continue from with HTTP 200 `[]`: on a node that lags the
one that served the previous page (behind a load balancer, or mempool-qbit's
failover between indexers), after a reorg between pages, and on the combined
route when the cursor is the last mempool row (mempool-qbit then drops all
confirmed history whenever an address has 50, 100, … mempool transactions).
`/txs/mempool` lists at most 50 transactions. So `getAddressHistory` reads the
address stats (`/address/:address`) before and after the scan, each in a
request of its own, and returns only if both reads agree and the history holds
exactly `chain_stats.tx_count` confirmed and `mempool_stats.tx_count` mempool
transactions. If the stats changed during the scan, it scans once more; if they
change again, or the counts differ, it throws `invalid_cursor`. Retry such a
scan later. Some causes persist until the backend changes: on `EsploraClient`,
an address with more than 50 mempool transactions fails until enough confirm,
and on `MempoolQbitClient`, an address whose mempool rows exactly fill pages of
50 fails while it has confirmed history. Stats without a non-negative
safe-integer `tx_count` throw `parse`.

`maxPages` defaults to 256 history page fetches including the terminal empty
response. It covers the whole call, so a rescan only gets the fetches the first
scan left. The two or three stats reads are not page fetches, nor is
`EsploraClient`'s `/txs/mempool` fetch.
Configured HTTP retries may add transport attempts for a page fetch.
On `MempoolQbitClient`, `maxPages` can lower but not raise the constructor's
`maxAddressHistoryPages` ceiling. `maxTransactions` independently defaults to
6,400 raw rows for the whole call, a rescan included, and is checked before
duplicate detection; callers intentionally scanning larger histories must opt
into a higher value. Malformed rows,
transactions unrelated to the requested address, route/status mismatches,
duplicate txids, and non-advancing cursors fail closed.
These limits bound requests and post-parse processing/retention, not the byte
size of one HTTP response while it is being received and decoded.

## Broadcasting

`broadcastTx(rawTxHex, { txid? })` submits a signed transaction and resolves
with its txid. Submitting is not idempotent from the caller's point of view, so
it does not use the read retry loop:

- **Accepted.** Resolves with the txid when a `2xx` reply echoes it, or when
  the node reports the transaction as already in its mempool or already
  confirmed (`txn-already-in-mempool`, `txn-already-known`, RPC error `-27`).
  The code is read from the reply's structure first (esplora's plain-text
  `sendrawtransaction RPC error: {...}`, a JSON-RPC `{"error":{"code":...}}`
  envelope, or a flat `{"code":...}` object), so `-27` resolves even when
  the message is localised or reworded. A repeated submission of the same
  hex is therefore safe.
- **Rejected.** Coded validity rejections (`-26` `bad-txns-*`,
  `txn-mempool-conflict`, decode failures, the backend's generic failure, or
  a backend reporting it could not even connect to its node) throw an `http`
  `QbitApiError` with the node's message. The transaction was not accepted.
  The body is read before the HTTP status is judged: qbit Core's JSON-RPC
  server answers `500` for every RPC error, so a relayed `5xx` whose body
  carries the node's own code (`-22`, `-25`, `-26`, `-28`, …) or one of its
  literal reject reasons is a definite rejection, and one carrying `-27` or an
  already-known reason resolves with the txid.
- **Unknown.** When an attempt may have reached the node but produced no
  definitive answer — a timeout, an abort or expired `deadlineMs` after the
  POST may have been sent, an ambiguous network error, a redirect (see
  "Redirects and transport security"), a reply that stalls or
  cannot be read (other than a `429`), a `5xx` reply
  whose body carries no verdict from the node (a gateway's HTML page, `-32603`,
  a relayed transport code, no code at all), a
  `2xx` reply that does not echo the txid (an empty body, a proxy's HTML page;
  when no txid is known, any `2xx` body that is not itself a 64-hex txid),
  or a backend relaying that its own call to the node timed out or was reset
  (mempool-qbit's `{"code":"ETIMEDOUT"}` / `ESOCKETTIMEDOUT` / `ECONNRESET`,
  its `-32603` / `-32602` for a node reply it could not read, qbit-electrs's
  `Connection error`) — the client throws a `QbitApiError` of
  kind `unknown_outcome` carrying `txid`, and never re-sends on its own. Poll
  `getTxStatus(error.txid)` (a `not_found` means the node has not seen it
  *yet*; give propagation a moment) and, once it is clearly absent, resubmit
  the **same** hex. Never rebuild the payment with different inputs on
  `unknown_outcome`: the original may already be in the mempool, and the
  rebuilt transaction would double-spend or pay twice.

Only replies that prove the submission was not processed are retried: `429`
(honoring `Retry-After` up to `maxRetryAfterMs`, default 30 s) and connection
failures reported before anything was sent (`ECONNREFUSED`, `ENOTFOUND`,
connect timeouts, and `EHOSTUNREACH` / `ENETUNREACH` only from the `connect`
syscall). A `429` whose `Retry-After` exceeds `maxRetryAfterMs` is not waited
on: it rejects at once as `rate_limit` with `retryAfterMs` set, and the POST
is not re-sent. Browsers do not expose the failure stage, so a plain
`Failed to fetch` is treated as unknown.

The txid is derived from the hex (`txidFromRawTx`, witness-stripped double
SHA-256), so it is available even when the request never returned. Pass
`{ txid }` to supply it yourself; when both are available they must agree.
A `rawTxHex` that is not a string, or a `txid` option that is not a 64-hex
transaction id matching the hex, throws a `TypeError` before anything is
sent. Hex the parser cannot read, including encodings qbit Core refuses to
decode (a non-canonical or over-`MAX_SIZE` CompactSize, a witness flag with
every witness stack empty), is still sent as-is and left to the node; then
only a supplied `txid` can be attached to an `unknown_outcome`.

`MempoolQbitClient` falls back to the `/tx/push` form route only after `/tx`
reported that it did not submit (missing route or the backend's generic
failure). The fallback is a second submission and follows the same rules; an
uncertain `/tx` attempt never falls back.

## Endpoints

`getAddressStats` · `getAddressUtxos` · `getAddressTxs` (paginated via
`/txs/chain[/:txid]`) · `getAddressMempoolTxs` · `getTx` · `getTxHex` · `getTxStatus` ·
`broadcastTx` · `getFeeEstimates` · `getTipHeight` · `getTipHash`, plus the
`getAddressBalance` / `getAddressHistory` / `getFeeTiers` adapters. `MempoolQbitClient` adapts the
mempool-qbit address pagination, recommended-fee, and broadcast fallback routes.

## Resilience

- Per-request timeout (`AbortController`) covering both the response headers
  and the full body, error bodies included; a body that stalls is cancelled.
  For a read, not a submission, it fails as `timeout` (retried with backoff,
  not `Retry-After`). A submission whose reply stalls or cannot be read is
  never re-sent, since the node may already have it: it rejects with
  `unknown_outcome` (see "Broadcasting"). The exception is a `429`, which
  proves nothing was processed even when its body is lost: it is retried with
  backoff, and rejects as `rate_limit` once retries run out.
- Retry with exponential backoff on network errors, timeouts, `5xx`, and `429`
  (honoring `Retry-After` up to `maxRetryAfterMs`, default 30 s) for reads. When
  the server asks for a longer wait, the client does not sleep: it throws the
  `rate_limit` / `http` error immediately with `retryAfterMs` set so the UI can
  decide when to try again. Submissions follow the stricter policy in
  "Broadcasting": an attempt that may have reached the node is never re-sent.
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
  resubmitting (see "Broadcasting"). The client never re-sends a POST after an
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

## Redirects and transport security

- The SDK does not follow redirects. Every request (`GET` and `POST`) is sent
  with `redirect: 'manual'`, and a `3xx` reply (in browsers, an opaque
  redirect) rejects with an `http` `QbitApiError`; `status` is the `3xx` code
  where the runtime exposes it, and the message names only the target's
  origin, never its path or query. Following a redirect would send your
  `headers` (API keys included) to whatever `Location` names, possibly over
  plain `http`, accept that server's reply as backend data, and turn a
  `broadcastTx` `POST` into a `GET`. If an endpoint has moved, point `baseUrl`
  at its new location.
- Some runtimes ignore `redirect: 'manual'` and follow the redirect
  themselves; React Native's global `fetch` does. There the SDK can only
  refuse the reply: a reply the runtime reports as `redirected`, or whose
  `url` is not the requested URL, rejects with an `http` `QbitApiError` and
  its body is discarded. Any difference in scheme, host, port, path or query
  counts, so a redirect to another path on the same backend is refused too:
  its reply answers another request. The case of the scheme and host, a
  default port and a trailing dot on the host do not count. The redirected
  request has already been sent by then. On Android it carries your custom
  `headers` (an `x-api-key`, say) to the target; on iOS custom headers are
  dropped, but the request is still sent. If your `headers` need protecting on
  such a runtime, pass a `fetchFn` that honours `redirect: 'manual'`. The same
  applies to any custom `fetchFn`.
- On `broadcastTx` (either client) a refused redirect of any kind rejects with
  `unknown_outcome` carrying `txid` instead, with the `http` refusal as
  `cause`. The `POST` reached the backend, which may have accepted it before
  redirecting (a `303` can follow an accepted submission), and a runtime that
  followed the redirect may have re-sent it to the target (`307` / `308`). It
  is never re-sent, retried or sent to the `/tx/push` fallback: check
  `getTxStatus(error.txid)` as for any `unknown_outcome`.
- A custom `fetchFn` must return a `Response` whose `url` is the URL it was
  given, or empty. A wrapper that rewrites the request URL (to add a query
  parameter or a path prefix, say) and returns the rewritten `url` has every
  reply refused as a followed redirect. Rewrite the URL inside the wrapper,
  then return a `Response` that reports the original URL or none.
- Tip: on React Native, send an API key in the `Authorization` header if your
  backend accepts it. Android's HTTP client drops `Authorization` on a
  redirect to another origin, though it forwards other custom headers, and
  iOS drops all custom headers.
- An `http:` `baseUrl` is rejected by the constructor (an `http`
  `QbitApiError`) unless its host is loopback (`localhost`, `127.0.0.0/8`,
  `[::1]`) or you pass `allowInsecureHttp: true`. Plain `http` exposes request
  headers and every response to the network.

## Logging errors

`QbitApiError.url` never contains the base URL's path, where hosted indexers
often put an API token (`https://host/<token>/api`); the constructor rejects
credentials and a query in `baseUrl`. It shows the base as its origin followed
by `/...`, then the endpoint path, e.g. `https://host/.../blocks/tip/height`.
A base URL without a path is shown as its origin
(`https://host/blocks/tip/height`: lowercased, without a default port). A base
URL whose host cannot be read reliably is shown as `...`
(`.../blocks/tip/height`): one with an `@` after its host, or with a host or
port that is not plain ASCII letters, digits and `.-_~` (an IPv6 address in
brackets is fine). `message` names the request URL the same way. This holds
for every error the client creates: HTTP, `rate_limit`, `network`, `timeout`
(an attempt's, including a body that stalls, or a call's deadline), `parse`
(including a body that cannot be read), `aborted`, a refused redirect and
`unknown_outcome`.

Text the client quotes from elsewhere is redacted too, as far as it can be
recognized: fetch's own error text in `network` and `timeout` messages,
response text in `message` and `responseBody` (an HTTP error preview, a
submission reply in an `unknown_outcome`, a malformed tip height, a history
cursor), and `cause` (below). In it, the base URL becomes the form above; its
path becomes `/...` where a server quotes it on its own (Express:
`Cannot GET /<token>/api/...`); and each path segment of 8 or more characters
becomes `...` wherever it appears, as when a server quotes a key alone, a
JSON-escaped `\/<token>\/` path or a `%2F`-joined one. Matching is exact and
case-sensitive, against the base URL as configured, as the URL parser
normalizes it and, for those parts, percent-decoded. It runs before quoted
text is cut to 200 characters. A secret quoted any other way (re-cased,
re-encoded or split up, or a part shorter than 8 characters) is not caught, so
where you can, send an API key in a header rather than in the base URL. Parts
that are not secret are replaced too when they are 8 or more characters long
(a `testnet4` path segment, say).

Response text quoted in `message` also has control characters, line
separators and bidi controls escaped (`\r`, `\n`, `\u001b`, ...) so a hostile
body cannot forge log lines. `responseBody` keeps them unescaped.

`cause` is a redacted copy of the underlying error: its message, stack and
string properties (such as Bun's `path`) and its nested causes are redacted
the same way, and it keeps the error's `name` (and its class, for built-in
errors). So `console.error(error)`, `util.inspect` and error reporters that
follow `cause` print it redacted. The original error is not stored on the
`QbitApiError`, so no logger, serializer or `util.inspect(error, { showHidden:
true })` reaches it; read it with `QbitApiError.unredactedCause(error)`, and
do not log it where the base URL is secret. A `QbitApiError` that is itself
the cause (a timeout inside an `unknown_outcome`, say) was redacted when it
was created and is kept as it is.

Two values are your own and pass through unchanged: an `aborted` error's
`cause` is your signal's `reason`, and a `QbitApiError` thrown by a custom
`fetchFn` propagates as it is (or becomes the `cause` of an
`unknown_outcome`), so redact those yourself if they can carry the base URL.
That includes a `QbitApiError` from another copy of this package (the other
build, recognized as `QbitApiError.is` does). The client judges such an error
by its public fields only, since its original cause and response body stay
private to the copy that created it: on a submission, a `network` error from
another copy never counts as proof that nothing was sent (it becomes
`unknown_outcome`), and its response body never triggers the `/tx/push`
fallback.

## Scope

This package intentionally carries none of the legacy centralized surface: no
asset/token endpoints, no remote wallet config, and no device-id/channel/client
telemetry headers. A test guard enforces that by construction.

## Response validation

The fee and balance adapters reject an implausible backend response with a
`parse` `QbitApiError` instead of throwing a `TypeError` or returning `NaN`, a
silently dropped entry or an inflated value. One invalid entry rejects the
whole response.

`getTxHex(txid)` (either client) returns the hex only if it is the requested
transaction. The reply must be non-empty, even-length hex that decodes to one
complete transaction, and that transaction's txid must equal `txid`, compared
case-insensitively. The txid is the double SHA-256 of the witness-stripped
serialization, as qbit Core computes it (`CTransaction::ComputeHash`), so ask
by txid, not wtxid. It must also be encoded as qbit Core's decoder requires,
witness section included: each count and length in its shortest CompactSize
form and at most `MAX_SIZE` (0x02000000), and no witness flag when every
witness stack is empty (a stack holding one empty item is not empty); the
same rules apply to `txidFromRawTx`. Spaces, tabs and line breaks around the
hex are ignored, such as the line break qbit Core's REST interface appends.
Anything else throws a `parse` `QbitApiError`, and the hex is returned in
lowercase.
mempool.qbit.org currently answers this route with `200` and an empty body, so
`getTxHex` throws there until the backend is fixed. The txid does not commit
to witness data, so a reply whose witnesses were altered or stripped still
passes; compare the wtxid if you rely on them.

`getFeeTiers()` and `feeTiersFromEstimates()` require every confirmation
target to be a decimal block count from 1 to 1008 (the longest horizon Core's
fee estimator tracks) and every rate to be a finite number above 0 and at most
a fee-rate ceiling. The default ceiling, `DEFAULT_MAX_FEE_RATE_SAT_VB`
(10,000 sat/vB), is qbit Core's default `sendrawtransaction` `maxfeerate`.
It is a ceiling, not a sanity check: it only rejects rates that neither
esplora nor mempool-qbit could broadcast, so a hostile or broken backend can
still return 9,999 sat/vB. Set a lower ceiling for your wallet, cap the total
fee before signing, or both. To set a ceiling, fetch the raw estimates and
pass it:

```ts
// 500 sat/vB leaves room for fee spikes and is 1/20 of the default worst case.
const tiers = feeTiersFromEstimates(await client.getFeeEstimates(), { maxFeeRate: 500 })
```

`MempoolQbitClient` also requires `fastestFee`, `halfHourFee` and `hourFee` to
be finite numbers above 0.

`getAddressBalance()` and `addressBalanceFromStats()` require a string
`address`, `funded_txo_sum` and `spent_txo_sum` that are non-negative safe
integers in both `chain_stats` and `mempool_stats`, a confirmed balance that is
not negative, and a `totalSats` that is a non-negative safe integer.
`mempoolSats` may still be negative while mempool transactions spend confirmed
outputs.

`funded_txo_sum` and `spent_txo_sum` are lifetime totals of everything the
address has received and spent, not balances, and Core's `MAX_MONEY` (2.1e16
sats) does not bound them. `JSON.parse` silently rounds integers above
`Number.MAX_SAFE_INTEGER` (2^53 - 1 sats, about 90M QBT), so a larger sum
fails closed instead of producing a plausible but wrong balance. A reused
address that has received more than about 90M QBT over its life therefore
fails on every call, however little it holds now. For such an address, sum
the `value` of each output from `getAddressUtxos()` instead, checking that
each value is a non-negative safe integer, because that raw endpoint is not
validated.

On electrs, a negative-total `parse` error can be transient right after a
block. electrs applies the block's headers before indexing it and does not
deduplicate mempool stats against the chain, so a spend that was just
confirmed can count in both `chain_stats` and `mempool_stats` for a moment.
Retry on the next poll.

## Configuration

```ts
new EsploraClient({
  baseUrl,            // required; absolute http(s) URL
  fetchFn,            // default: global fetch
  allowInsecureHttp,  // default false; accept plain http to a non-loopback host
  credentials,        // default: 'omit'; accepts 'same-origin' or 'include'
  timeoutMs,          // default 15000; integer 1..2147483647
  retries,            // default 2; integer 0..10 (reads; submissions only repeat unsent attempts)
  retryBaseDelayMs,   // default 300; finite 0..2147483647
  maxRetryAfterMs,    // default 30000; integer 0..2147483647; longest Retry-After to sleep on
  headers,            // optional extra request headers
  signal,             // optional AbortSignal that cancels every call
  sleepFn,            // optional (ms, signal) => Promise<void> backoff sleep
})
```

The constructor throws a `QbitApiError` for out-of-range options instead of
storing them. `timeoutMs`, `retries`, `retryBaseDelayMs` and `maxRetryAfterMs`
reject `null`; only an omitted option takes its default. `baseUrl` must not contain
whitespace, control characters (C0, DEL or C1), invisible format or
default-ignorable characters (such as U+00AD, U+200B or U+FE0F; ZWNJ/ZWJ stay
allowed in IDN hosts only), backslashes, credentials, a query or a fragment,
because endpoint paths are appended to it. A plain `http` URL also needs a
loopback host or `allowInsecureHttp: true` (see "Redirects and transport
security"). These checks read the URL by hand rather than through the
runtime's `URL` getters, which throw on React Native before 0.80, so they run
there too. Other non-ASCII characters are
accepted: an internationalized host is sent as punycode and path characters
are percent-encoded as UTF-8. On React Native without a standard `URL`
implementation, though, the SDK compares each reply's `url` with `baseUrl` as
you spelled it, and the native stack reports the canonical form. There, give
`baseUrl` in its ASCII form (a punycode host, a percent-encoded path, no `.` or
`..` segments), or every reply is refused as a followed redirect. Retry backoff
is capped at 2147483647 ms, the largest delay `setTimeout` supports.

`credentials` is typed `QbitFetchCredentials` (`'omit' | 'same-origin' |
'include'`, the values of the DOM's `RequestCredentials`), so the type
declarations compile without the DOM lib, for example with `lib: ["ES2022"]`
and `types: ["node"]`. They still name the global `fetch`, `Response` and
`AbortSignal` types, which the DOM lib provides, and `@types/node` does from
18.18.7 in 18.x, from 20.8.4 in 20.x, and in every release from 22 on. Without
the DOM lib, an older `@types/node` (16.x, 18.17, 20.8.0, say) fails with
`Cannot find name 'fetch'` (TS2304) in this package's declarations.

A custom `fetchFn` (for example node-fetch, or a React Native polyfill) only
needs to return a Response-like object with `status`, `statusText`, `url`,
`headers.get()` and `text()` (or a readable `body` stream); no global
`Response` is required. Where the runtime has no usable `Response`
constructor, `request()` resolves with a buffered stand-in that supports the
status fields, `headers`, `url`, `text()`, `json()` and `clone()`, with
`body: null`.

A custom `fetchFn` should honour `init.signal` for the whole response, aborting
the body read when the signal fires after the headers have arrived. The client
stops waiting at the deadline either way, but it can only release what it can
reach: it cancels a web `ReadableStream` body it reads itself, and when it falls
back to `text()` it makes a best-effort `body.cancel()` (web stream) or
`body.destroy()` (Node stream). A `text()`-only response with no `body`, or a web
stream that `text()` has already locked, is only released if `fetchFn` honours the
signal.

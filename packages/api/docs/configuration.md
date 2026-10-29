# Configuration

The constructor options both clients take, their defaults and accepted ranges,
and what a custom `fetchFn` must do.

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
loopback host or `allowInsecureHttp: true` (see [Redirects and transport
security](transport-security.md)). These checks read the URL by hand rather than through the
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

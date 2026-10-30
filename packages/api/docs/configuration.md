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
  maxResponseBytes,   // default 67108864 (64 MiB); integer 1..9007199254740991; largest body read
  headers,            // optional extra request headers
  signal,             // optional AbortSignal that cancels every call
  sleepFn,            // optional (ms, signal) => Promise<void> backoff sleep
})
```

The constructor throws a `QbitApiError` for out-of-range options instead of
storing them. `timeoutMs`, `retries`, `retryBaseDelayMs`, `maxRetryAfterMs`
and `maxResponseBytes` reject `null`; only an omitted option takes its default. `baseUrl` must not contain
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
`..` segments), or every reply is refused as a followed redirect. There the
constructor refuses, with an `http` `QbitApiError`, a non-ASCII host, asking
for its punycode (`xn--`) form, and any other character RFC 3986 allows only
percent-encoded (a non-ASCII or space character, a backtick, any of
`"<>\^{|}`, `[` or `]` outside an IPv6 host, or a `%` that does not start an
escape), asking for its `%XX` UTF-8 escapes, as `encodeURIComponent` writes
them for a path segment. A dot segment is not detected. Retry backoff
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
`headers.get()` and a way to read the body: a `body` that is a WHATWG
`ReadableStream` or an async iterable of bytes (node-fetch's Node `Readable`),
or else `blob()`, `arrayBuffer()` or `text()`. The client tries them in that
order; see [Response size limit](#response-size-limit) for how each is
measured. No global `Response` is required. Where the runtime has no usable `Response`
constructor, `request()` resolves with a buffered stand-in that supports the
status fields, `headers`, `url`, `text()`, `json()` and `clone()`, with
`body: null`.

A custom `fetchFn` should honour `init.signal` for the whole response, aborting
the body read when the signal fires after the headers have arrived. The client
stops waiting at the deadline either way, but it can only release what it can
reach: it cancels a web `ReadableStream` body and destroys a Node stream body
it reads itself (calling `return()` on any other async iterator), and when it
falls back to `blob()`, `arrayBuffer()` or `text()` it makes a best-effort
`body.cancel()` (web stream) or `body.destroy()` (Node stream). A response
with no `body`, or a web stream that one of those has already locked, is only
released if `fetchFn` honours the signal.

## Response size limit

`maxResponseBytes` caps the body of every reply the client reads, error
replies included, at 64 MiB by default (`DEFAULT_MAX_RESPONSE_BYTES`). The
client counts the bytes as the body stream delivers them, after any content
decoding, and once a body passes the limit it cancels the body and stops
reading, so a backend that streams without end cannot fill the app's memory
before `timeoutMs`. A read then fails with `response_too_large`, which is not
retried: the backend would send the same body again. Concurrent identical
reads share one request (see [Resilience](resilience.md)), so they share one
limit and all fail with the one error; under the limit they share one copy of
the body, and each parses its own value from it. A submission's reply over
the limit is `unknown_outcome`, a `429` included, since the node may have
accepted the transaction, and is not re-sent; see the
[outcome table](broadcasting.md#outcomes). An error keeps at most 200
characters of a body, as a copy, so it never holds the body itself.

The default holds every reply qbit-electrs (and mempool-qbit, which relays it)
serves about one transaction, for any transaction a block can hold: its hex is
under 4 MB, and its JSON, which repeats each input's prevout and prints every
script as hex and as asm, at most about 50 MB. It also holds a full page of
address history (25 transactions on `/txs/chain`, 50 on `/txs/mempool` and
the combined `/txs` route) of the largest standard spends, about 43 MB. A
page of large batch payouts (about 160 MB), or of transactions built to
inflate the JSON, can exceed it: a client for such an address needs a larger
`maxResponseBytes`. On a device with little memory, a smaller one bounds each
reply more tightly; most replies are far smaller (a transaction status, fee
estimates or the tip are under 1 kB).

Which body forms the limit stops while they stream, and which it only measures
once they are read whole:

- **Counted as it arrives, and stopped at the limit**: a `body` that is a WHATWG
  `ReadableStream` (it has `getReader()`; the global `fetch` of Node, browsers,
  Deno and Bun), or else an async iterable of bytes, such as the Node
  `Readable` that node-fetch v2 and v3 return. The client cancels the web
  stream, or destroys the Node stream (and returns any other iterator), at the
  first chunk past the limit. This holds without a global `TextDecoder` too:
  the client then decodes the bytes itself.
- **Read whole, then measured in bytes**: a response without such a `body`
  that has `blob()`, or else `arrayBuffer()`. The limit fails the call before
  the reply is decoded or parsed, but cannot stop the download, which only
  `timeoutMs` bounds. React Native's global `fetch` (whatwg-fetch) takes the
  `blob()` path: it has downloaded the whole body natively before it
  resolves, and the client compares the Blob's `size` with the limit before
  any of the body enters JavaScript, then reads its text (with the Blob's
  `text()`, or else through `Response`, whose whatwg-fetch reads it with
  `FileReader.readAsText`, which every React Native version implements). It
  does not use `arrayBuffer()` there: whatwg-fetch's needs
  `FileReader.readAsArrayBuffer`, which React Native 0.71 and earlier do not
  implement (checked in the 0.65.0 and 0.71.0 sources; 0.72.0 implements it).
  A Blob whose `size` is not a number is measured as its text, as below.
- **Read whole, then measured as text**: a Response-like object with only
  `text()`. Its length is that text's UTF-8 encoding, which can differ from
  the bytes on the wire: an invalid byte decodes to U+FFFD, three bytes.

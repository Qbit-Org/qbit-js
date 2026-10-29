# Redirects and transport security

Why the clients refuse redirects and, by default, plain `http`, and what that
means for React Native and custom `fetchFn`s.

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
- On `broadcastTx`, a refused redirect is an `unknown_outcome`, not an `http`
  error ([outcome table](broadcasting.md#outcomes)).
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

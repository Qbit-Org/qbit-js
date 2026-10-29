# Logging errors

What a `QbitApiError` redacts from its URL, message, response body and cause,
and what it passes through.

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

# Broadcasting

How `broadcastTx` reports whether a signed transaction was accepted, rejected,
or may have reached the node.

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
  [Redirects and transport security](transport-security.md)), a reply that stalls or
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

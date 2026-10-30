# Broadcasting

How `broadcastTx` reports whether a signed transaction was accepted, rejected,
or may have reached the node. This page is the one reference for submission
outcomes; other pages link here.

`broadcastTx(rawTxHex, { txid? })` submits a signed transaction and resolves
with its txid. Submitting is not idempotent from the caller's point of view, so
it does not use the read retry loop.

## Outcomes

The first row that matches decides. A reply's body is read before its status
is judged: qbit Core's JSON-RPC server answers `500` for every RPC error, and a
backend or proxy may relay that status with the node's verdict in the body.
The body verdicts are defined [below the table](#body-verdicts). A *known txid*
means the hex parses or `{ txid }` was passed ([The txid](#the-txid)).

| Reply or event | `EsploraClient` | `MempoolQbitClient` (`/tx`) |
| --- | --- | --- |
| Abort or expired `deadlineMs` before the POST is sent or re-sent, or after a `429` whose whole body is neither already-known nor a relayed transport failure ⁷ | `aborted` / `timeout` | same |
| Connection failure before anything was sent ¹ | retried, then `network` | same |
| `429` with retries left, and no `Retry-After` or one at most `maxRetryAfterMs`, whose whole body was read and is neither already-known nor a relayed transport failure ⁷ | re-sent after `Retry-After` or the backoff | same |
| Any other network error, an attempt over `timeoutMs`, or an abort or deadline once the POST may have been sent ² | `unknown_outcome` | same |
| Redirect refused: a `3xx`, an `opaqueredirect`, or a reply the runtime followed (`redirected`, or a `url` other than the one requested) ³ | `unknown_outcome` | same |
| Any reply whose body fails, stalls (past `timeoutMs` included) or exceeds `maxResponseBytes`, a `429` included ⁶ | `unknown_outcome` | same |
| `2xx` that echoes the txid ⁵ | resolves | same |
| Any other `2xx`, an already-known or rejection body included | `unknown_outcome` | same |
| `501` | `http` | `/tx/push` |
| `505`, `511` | `http` | same |
| Already-known body | resolves with a known txid, else `unknown_outcome` | same |
| Other `5xx`, definite node rejection | `http` | same |
| Other `5xx`, any other body | `unknown_outcome` | same |
| `4xx`, relayed transport failure | `unknown_outcome` | same |
| `404`, any other body | `not_found` | `/tx/push` |
| `405`, any other body | `http` | `/tx/push` |
| `400`, generic failure | `http` | `/tx/push` |
| `413`, any other body | `payload_too_large` | same |
| `429`, any other body, once not retried ⁴ | `rate_limit` | same |
| Other `4xx`, any other body | `http` | same |

¹ `ECONNREFUSED`, `ENOTFOUND`, `EAI_AGAIN`, undici's `UND_ERR_CONNECT_TIMEOUT`,
or `EHOSTUNREACH` / `ENETUNREACH` from the `connect` syscall. Any other timeout,
`ETIMEDOUT` from the `connect` syscall included, is "any other network error".
Browsers do not expose the failure stage, so a plain `Failed to fetch` is too.

² The `unknown_outcome` carries the network, `timeout` or `aborted` error as
`cause`. The client never re-sends a POST after an abort, an expired deadline,
or an attempt that hit `timeoutMs`.

³ The POST reached the backend, which may have accepted it before redirecting
(a `303` can follow an accepted submission), and a runtime that followed the
redirect may have re-sent it to the target (`307` / `308`). The `http` refusal
is the `cause`; see [Redirects and transport security](transport-security.md).

⁴ Retries ran out, or `Retry-After` exceeds `maxRetryAfterMs`, which is not
waited on. `rate_limit` carries `retryAfterMs` when the reply sent
`Retry-After`.

⁵ With no known txid, a `2xx` resolves only when its body is itself a 64-hex
txid.

⁶ The client cannot judge a reply whose body it could not read in full, and
the node may have accepted the transaction before the backend answered. A
`429` is no exception: only its body shows that nothing was processed, and it
might instead have been already-known, which resolves, or a relayed transport
failure. The client stops reading a body as soon as it passes
`maxResponseBytes` (see [Configuration](configuration.md#response-size-limit)),
and never re-sends such a reply. The `unknown_outcome` carries the error that
ended the read as `cause`: `response_too_large`, `timeout`, `aborted` or
`parse`. No submission ends as `response_too_large`.

⁷ Only such a `429` proves that nothing was processed, so the client re-sends
it, and an abort or expired deadline while it waits to, or once the whole
`429` has arrived, is definite. A `429` that is already-known or a relayed
transport failure is judged by the rows below it, never re-sent.

`/tx/push` means `MempoolQbitClient` submits again through the `/tx/push` form
route and returns that call's result, judged by the `EsploraClient` column. An
uncertain `/tx` attempt never falls back, and neither does an abort or expired
deadline during `/tx`.

`http`, `not_found`, `payload_too_large` and `rate_limit` are definite: this
submission was not accepted. For a resubmission, that proves nothing about the
original ([Recovering from an unknown outcome](#recovering-from-an-unknown-outcome)).

A `QbitApiError` thrown by a custom `fetchFn` passes through as it is, and on
`MempoolQbitClient` one that matches a `/tx/push` row falls back. One of kind
`network`, `timeout`, `aborted` or `response_too_large` (which says a reply
arrived) becomes `unknown_outcome` with it as `cause`,
except a `network` error from this copy of the package whose original cause is
a connection failure before anything was sent, which is retried. An error from
another copy (the other build, or another version) is judged by its public
fields only: its `network` error is always `unknown_outcome`, and its response
body never counts as a generic failure.

The client cannot tell whether a custom `fetchFn` sent the POST before it
threw, so it takes the error at its word. An `http`, `not_found`,
`payload_too_large` or `rate_limit` error from a `fetchFn` proves that nothing
was accepted only if the `fetchFn` threw it before anything was sent, and a
retried `network` error, or a fallback to `/tx/push`, sends the transaction
again. A `fetchFn` must therefore throw a `QbitApiError` only when nothing was
sent; once the request may have been sent, it should return the reply, or
throw the underlying error, and let the client classify the failure.

### Body verdicts

The client reads an RPC error code from the reply's structure first (esplora's
plain-text `sendrawtransaction RPC error: {...}`, a JSON-RPC
`{"error":{"code":...}}` envelope, or a flat `{"code":...}` object) and falls
back to the message, so a localised or reworded message does not change the
verdict.

- **Already-known**: RPC error `-27`, or `txn-already-in-mempool`,
  `txn-already-known`, `txn-same-nonwitness-data-in-mempool`, "transaction
  already in block chain" or "transaction outputs already in utxo set": the
  node already has this exact transaction.
- **Definite node rejection**: one of qbit Core's own RPC codes (`-1` to `-99`,
  such as `-22`, `-25`, `-26` and `-28`) or a JSON-RPC request-level code
  (`-32700`, `-32600`, `-32601`); one of Core's literal reject reasons at the
  start of an uncoded reply (`bad-txns-*`, `txn-mempool-conflict`,
  `missing inputs`, …); or a backend code showing it never reached its node
  (`ECONNREFUSED`, `ENOTFOUND`, `EAI_AGAIN`, `UND_ERR_CONNECT_TIMEOUT`).
- **Relayed transport failure**: the backend's own call to the node failed in
  transit or came back unreadable. That is any other string code shaped like a
  transport error (`E…`, `UND_ERR_…` or `HPE_…`, such as mempool-qbit's
  `{"code":"ETIMEDOUT"}`, `ESOCKETTIMEDOUT` or `ECONNRESET`), `-32603` or
  `-32602`, or qbit-electrs's `Connection error`. Other string codes, such as
  `RATE_LIMITED`, carry no verdict: the status decides.
- **Generic failure**: a `400` with no RPC code whose whole message is "failed
  to", "unable to" or "could not", then "send", "submit" or "broadcast", then
  "transaction" or "raw transaction" (mempool-qbit's "Failed to send
  transaction", say).

## Recovering from an unknown outcome

`unknown_outcome` carries `txid` when one is known, and the client never
re-sends on its own. Resubmitting the **same** hex is harmless, since the same
transaction cannot pay twice. If the node holds it in its mempool, qbit Core
answers with the txid, which resolves. An already-known reply (such as `-27`,
which Core sends while an output of the confirmed original is unspent)
resolves only with a known txid; without one it is `unknown_outcome` again. A
rejected resubmission proves nothing about the original: once the original
confirmed and every one of its outputs was spent, Core rejects the
resubmission for missing inputs.

Lookups cannot settle it either. `getTx(txid)` asks the indexer, whose mempool
view can lag the node, so its `not_found` does not prove the node lacks the
transaction. `getTxStatus` is no better: qbit-electrs answers it with
`{ confirmed: false }` for a txid it has never seen. Whatever they say, never
rebuild the payment with different inputs on `unknown_outcome`: the original
may already be in the mempool, and the rebuilt transaction would double-spend
or pay twice.

## The txid

The txid is derived from the hex (`txidFromRawTx`, witness-stripped double
SHA-256), so it is available even when the request never returned. Pass
`{ txid }` to supply it yourself; when both are available they must agree.
A `rawTxHex` that is not a string, or a `txid` option that is not a 64-hex
transaction id matching the hex, throws a `TypeError` before anything is
sent. Hex the parser cannot read, including encodings qbit Core refuses to
decode (a non-canonical or over-`MAX_SIZE` CompactSize, a witness flag with
every witness stack empty), is still sent as-is and left to the node; then
only a supplied `txid` can be attached to an `unknown_outcome`.

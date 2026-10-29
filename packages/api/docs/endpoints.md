# Endpoints and clients

The methods both clients provide, what `MempoolQbitClient` adapts, and what this
package leaves out.

## Endpoints

`getAddressStats` · `getAddressUtxos` · `getAddressTxs` (paginated via
`/txs/chain[/:txid]`) · `getAddressMempoolTxs` · `getTx` · `getTxHex` · `getTxStatus` ·
`broadcastTx` · `getFeeEstimates` · `getTipHeight` · `getTipHash`, plus the
`getAddressBalance` / `getAddressHistory` / `getFeeTiers` adapters. `MempoolQbitClient` adapts the
mempool-qbit address pagination, recommended-fee, and broadcast fallback routes.

## `MempoolQbitClient`

For mempool-qbit (qbit's port of the mempool explorer backend), use
`MempoolQbitClient` with the backend's `/api/v1` base URL, the prefix the client
is written for: `https://mempool.qbit.org/api/v1` or
`https://mempool-testnet.qbit.org/api/v1`. Those two hosts currently answer the
same GET routes under `/api` as well. Under either prefix they answer
`/address/:address/txs/chain`, `/address/:address/txs/mempool` and
`/fee-estimates` with `404`, so `EsploraClient`'s history and fee calls fail
there with `not_found`. `MempoolQbitClient`'s `getFeeEstimates()` adapter maps
the backend's three projected-block quotes to targets 1, 2, and 3.
`getMempoolRecommendedFees()` returns the original named
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
If an internal cursor is in neither the mempool nor the chain history by the
next page, both history methods reject with an `http` `QbitApiError` rather than
return incomplete results. qbit-electrs answers that page with `422`
(`after_txid not found`), which is not retried. `mempool.qbit.org` and
`mempool-testnet.qbit.org` currently answer it with `500`
(`{"error":"Failed to get address transactions"}`), which the read retries
repeat before the call rejects with that `500`. A backend that replays an
earlier full page makes them throw `invalid_cursor`.
`getAddressTxs` and `getAddressMempoolTxs` take a page of fewer than 10 rows
as the last one; a page of 10 or more makes them ask for the next.
`getAddressMempoolTxs` also stops at the first page that holds a confirmed
row, and `getAddressTxs` once it has collected 25 confirmed rows, returning at
most 25.
Without `afterTxid`, an empty page right after a mempool row is checked against
the address stats: qbit-electrs answers that cursor with `[]` instead of the
confirmed rows that follow, so `getAddressTxs` throws `invalid_cursor` when the
stats count more confirmed transactions than it found.
Cursor-validation scan pages count against the same per-call limit; callers
that intentionally page deeper histories must raise `maxAddressHistoryPages`.

## Scope

This package intentionally carries none of the legacy centralized surface: no
asset/token endpoints, no remote wallet config, and no device-id/channel/client
telemetry headers. A test guard enforces that by construction.

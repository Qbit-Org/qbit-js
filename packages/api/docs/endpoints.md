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

## Scope

This package intentionally carries none of the legacy centralized surface: no
asset/token endpoints, no remote wallet config, and no device-id/channel/client
telemetry headers. A test guard enforces that by construction.

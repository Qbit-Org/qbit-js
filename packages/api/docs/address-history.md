# Address history

How `getAddressHistory` shows an address's history is complete, and the limits
on a scan. `MempoolQbitClient`'s `getAddressTxs` cursor rules are under
[`MempoolQbitClient`](endpoints.md#mempoolqbitclient).

For complete scans, prefer `getAddressHistory(address, options)`. It returns
both `{ confirmed, mempool }` from page one without re-fetching mempool-qbit's
combined-history prefix for every 25 confirmed transactions. `EsploraClient`
fetches the mempool set once and exhausts `/txs/chain`; `MempoolQbitClient`
classifies one traversal of the combined `/txs` route. Neither
`getAddressHistory` implementation assumes a fixed page size: completion
requires an explicit empty response. `MempoolQbitClient`'s `getAddressTxs` and
`getAddressMempoolTxs` do assume one: they take a page of fewer than 10 rows as
the last (see [`MempoolQbitClient`](endpoints.md#mempoolqbitclient)).

An empty response does not prove the history is complete. qbit-electrs's
`/txs/chain` route answers a cursor it does not know with HTTP 200 `[]`: on a
node that lags the one that served the previous page (behind a load balancer),
or after a reorg between pages. Its combined `/txs` route answers `[]` when the
cursor is the last mempool row (mempool-qbit then drops all confirmed history
whenever an address has 50, 100, … mempool transactions), and `422` for a cursor
it finds nowhere, which rejects as an `http` `QbitApiError`; hosted backends
can answer that cursor differently (see
[`MempoolQbitClient`](endpoints.md#mempoolqbitclient)). Full pages hold 25
transactions on `/txs/chain` and, by default, 50 on the combined route;
`/txs/mempool` lists at most 50 transactions, with no way to page further. So
`getAddressHistory` reads the address stats (`/address/:address`) before and
after the scan, and returns only if both reads agree and the history holds
exactly `chain_stats.tx_count` confirmed and `mempool_stats.tx_count` mempool
transactions. If the stats changed during the scan, it scans once more; if they
change again, or the counts differ, it throws `invalid_cursor`. The stats reads
and the page fetches each go out in a request of their own, never joined to an
identical `GET` already in flight (see [Resilience](resilience.md)), whose reply
could predate the first stats read: a replacement (RBF) that pays the address
the same leaves the stats unchanged, so a joined page could still list the
transaction it evicted. Retry such a scan later. Some causes persist until the backend
changes: on `EsploraClient`, an address with more than 50 mempool transactions
fails until enough confirm, and on `MempoolQbitClient`, an address whose mempool
rows exactly fill pages of 50 fails while it has confirmed history. Stats
without a non-negative safe-integer `tx_count` throw `parse`.

`maxPages` counts history page fetches including the terminal empty response. It
defaults to 256 on `EsploraClient`. On `MempoolQbitClient` it defaults to the
constructor's `maxAddressHistoryPages` (256 unless set), and a larger value is
capped there. It covers the whole call, so a rescan only gets the fetches the
first scan left. The two or three stats reads are not page fetches, nor is
`EsploraClient`'s `/txs/mempool` fetch. Configured HTTP retries may add
transport attempts for a page fetch. `maxTransactions` independently defaults to
6,400 raw rows for the whole call, a rescan included, and is checked before
duplicate detection; callers intentionally scanning larger histories must opt
into a higher value. Malformed rows, transactions unrelated to the requested
address, route/status mismatches, duplicate txids, and non-advancing cursors
fail closed. These limits bound requests and post-parse processing/retention;
the client's `maxResponseBytes` bounds each HTTP response while it is being
received and decoded (see [Configuration](configuration.md#response-size-limit)).

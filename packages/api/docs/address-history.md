# Address history

How `getAddressHistory` shows an address's history is complete, and the limits
on a scan. `MempoolQbitClient`'s `getAddressTxs` cursor rules are under
[`MempoolQbitClient`](endpoints.md#mempoolqbitclient).

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

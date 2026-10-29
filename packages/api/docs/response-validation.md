# Response validation

Which backend responses the adapters and `getTxHex` reject as `parse` errors,
and why.

The fee and balance adapters reject an implausible backend response with a
`parse` `QbitApiError` instead of throwing a `TypeError` or returning `NaN`, a
silently dropped entry or an inflated value. One invalid entry rejects the
whole response.

`getTxHex(txid)` (either client) returns the hex only if it is the requested
transaction. The reply must be non-empty, even-length hex that decodes to one
complete transaction, and that transaction's txid must equal `txid`, compared
case-insensitively. The txid is the double SHA-256 of the witness-stripped
serialization, as qbit Core computes it (`CTransaction::ComputeHash`), so ask
by txid, not wtxid. It must also be encoded as qbit Core's decoder requires,
witness section included: each count and length in its shortest CompactSize
form and at most `MAX_SIZE` (0x02000000), and no witness flag when every
witness stack is empty (a stack holding one empty item is not empty); the
same rules apply to `txidFromRawTx`. Spaces, tabs and line breaks around the
hex are ignored, such as the line break qbit Core's REST interface appends.
Anything else throws a `parse` `QbitApiError`, and the hex is returned in
lowercase. The txid does not commit to witness data, so a reply whose
witnesses were altered or stripped still passes; compare the wtxid if you rely
on them.

`getFeeTiers()` and `feeTiersFromEstimates()` require every confirmation
target to be a decimal block count from 1 to 1008 (the longest horizon Core's
fee estimator tracks) and every rate to be a finite number above 0 and at most
a fee-rate ceiling. The default ceiling, `DEFAULT_MAX_FEE_RATE_SAT_VB`
(10,000 sat/vB), is qbit Core's default `sendrawtransaction` `maxfeerate`.
It is a ceiling, not a sanity check: it only rejects rates that neither
esplora nor mempool-qbit could broadcast, so a hostile or broken backend can
still return 9,999 sat/vB. Set a lower ceiling for your wallet, cap the total
fee before signing, or both. To set a ceiling, fetch the raw estimates and
pass it:

```ts
// 500 sat/vB leaves room for fee spikes and is 1/20 of the default worst case.
const tiers = feeTiersFromEstimates(await client.getFeeEstimates(), { maxFeeRate: 500 })
```

`MempoolQbitClient` also requires `fastestFee`, `halfHourFee` and `hourFee` to
be finite numbers above 0.

`getAddressBalance()` and `addressBalanceFromStats()` require a string
`address`, `funded_txo_sum` and `spent_txo_sum` that are non-negative safe
integers in both `chain_stats` and `mempool_stats`, a confirmed balance that is
not negative, and a `totalSats` that is a non-negative safe integer.
`mempoolSats` may still be negative while mempool transactions spend confirmed
outputs.

`funded_txo_sum` and `spent_txo_sum` are lifetime totals of everything the
address has received and spent, not balances, and Core's `MAX_MONEY` (2.1e16
sats) does not bound them. `JSON.parse` silently rounds integers above
`Number.MAX_SAFE_INTEGER` (2^53 - 1 sats, about 90M QBT), so a larger sum
fails closed instead of producing a plausible but wrong balance. A reused
address that has received more than about 90M QBT over its life therefore
fails on every call, however little it holds now. For such an address, sum
the `value` of each output from `getAddressUtxos()` instead, checking that
each value is a non-negative safe integer, because that raw endpoint is not
validated.

On electrs, a negative-total `parse` error can be transient right after a
block. electrs applies the block's headers before indexing it and does not
deduplicate mempool stats against the chain, so a spend that was just
confirmed can count in both `chain_stats` and `mempool_stats` for a moment.
Retry on the next poll.

# Examples

Short, commented TypeScript examples of
[`@qbit-oss/protocol`](../packages/protocol/README.md) and
[`@qbit-oss/api`](../packages/api/README.md), with
[`@qbit-oss/pqc`](https://github.com/Qbit-Org/qbit-pqc) as the SLH-DSA signer.
Each example exports functions that its test calls, except the two quick
starts, which are scripts that their test runs. The ones that talk to a block
explorer get an in-memory esplora backend, as `fetchFn` or in place of the
global `fetch`, so every example runs offline, and CI runs them with the rest
of the tests. This is a private
workspace package, `@qbit-oss/examples`; it is never published.

| Example | Shows |
| --- | --- |
| [`api-quick-start.ts`](src/api-quick-start.ts) | The `@qbit-oss/api` README's quick start: balance, UTXOs, history and fee tiers |
| [`protocol-quick-start.ts`](src/protocol-quick-start.ts) | The `@qbit-oss/protocol` README's quick start: an address, an unsigned PSBT and its signing plan |
| [`check-balance.ts`](src/check-balance.ts) | `EsploraClient`, `getAddressBalance`, `getFeeTiers`, and `feeTiersFromEstimates` with the wallet's own `maxFeeRate` |
| [`payment-uri.ts`](src/payment-uri.ts) | `formatQbitUri` and `parseQbitUri`, and handling a rejected URI |
| [`message-proof.ts`](src/message-proof.ts) | `createP2mrMessageProof` and `verifyP2mrMessageProof` with `{ expectedAddress }` |
| [`send-payment.ts`](src/send-payment.ts) | A whole payment: UTXO scan and selection, skipping coinbase outputs that are not mature, PSBT, signing plans, signing with `onSigned`, finalizing, extracting and broadcasting, then recovering from `unknown_outcome`, or abandoning a transaction no node will take |

## Running them

The examples import the packages the way an app does, through their built
`lib/` output, so build first:

```sh
corepack pnpm install
corepack pnpm build
corepack pnpm --filter @qbit-oss/examples test
corepack pnpm --filter @qbit-oss/examples typecheck
```

The root `pnpm test` runs them too, after the packages' own tests, and CI
builds before it tests. Signing takes a fraction of a second per signature,
so `send-payment`'s tests take several seconds.

The tests sign with keys from [`test/test-only-keys.ts`](test/test-only-keys.ts),
which derives them from fixed, public bytes so that every run signs the same
transaction. Anyone can recompute those keys: never fund their addresses or
derive keys that way in a wallet.

## Addresses with many outputs

`send-payment.ts` lists the address's unspent outputs with one
`GET /address/:address/utxo`. qbit-electrs refuses that for an address with
more outputs than its `--utxos-limit`, 500 by default, and the payment then
fails with a `too_many_utxos` `SendPaymentError` before any key is used.
`abandonPendingPayment` lists them the same way, and rejects with a
`too_many_utxos` `AbandonPaymentError` instead, releasing nothing. A regtest
wallet that mined to its own address the 1,000 or more blocks a coinbase output
needs to mature holds a coinbase output for each block, so it has more than
500. Raise the backend's `--utxos-limit`, consolidate the outputs
into fewer with a backend that lists them all, or mine to an address other than
the wallet's and send the wallet only what it needs. To abandon a payment,
raise the limit, or use a backend that lists them all.

## Broadcasting

`send-payment.ts` follows
[Broadcasting](../packages/api/docs/broadcasting.md). It checks the recipient,
amount, fee rate, deadline, poll interval and signal before any request, and the
backend's UTXO rows before any key is used; `reconcileBroadcast` checks its
poll interval, signal and the time left before its `end` the same way, and that
its record is an object. Both check the signal's shape, as the client uses it,
not `instanceof AbortSignal`, so a signal from another realm or a polyfill will
do, and with a signal that has already aborted, neither sends a request, nor
does `sendPayment` start loading the signer. `sendPayment` refuses to start
while an earlier payment is still pending, and checks again right before
it stores its own transaction, so two overlapping calls cannot both pay. It
stores the signed transaction before the first broadcast and drops it only when
`broadcastTx` proves the node did not accept it, or throws a `TypeError`, which
it does only before sending anything. When the outcome is unknown, the
transaction may already be on the network, so it looks the txid up with `getTx`
before it resubmits anything, resubmits only the same hex, and never rebuilds
the payment. `reconcileBroadcast` takes the pending record, its txid and hex,
and checks that the hex is that transaction before any request. A lookup finds
the transaction only when the reply's `txid` is its txid, since `getTx` returns
the reply as parsed, without checking that it is the transaction requested.
Each round of reconciliation waits a poll interval, or
half of what is left when less than two are left, then looks the transaction
up. A round with less than two poll intervals left once its lookup is over is
the last: if the lookup did not find the transaction, it resubmits once with
what remains, unless the deadline has passed by the time it would send, and
stops, so only the last round resubmits with less than two poll intervals left.
One reading of the clock, once the lookup is over, decides which round is the
last; a resubmission's budget is timed from the deadline right before it is
sent, so a stall in between cannot stretch it past the deadline. One budget
rule covers the first broadcast and every other
lookup and resubmission: each gets all but a poll interval of the time left
while at least two poll intervals are left, and half of what is left below
that. So one that stalls leaves a later request time, and however little time
is left, each gets at least half of it. A short deadline still settles a
transaction that never reached the node, even when the first broadcast, the
indexer or an earlier resubmission stalls, without a burst of requests. A `not_found` lookup only means the indexer does
not know the transaction yet. `getTxStatus` cannot tell either way, since
qbit-electrs answers `{ confirmed: false }` for a txid it has never seen. One
deadline covers the whole payment. Signing blocks the thread, so a cancel issued meanwhile takes
effect once signing ends, before anything is stored or sent. A cancel before
the transaction is stored, while the signer loads included, rejects with an
`aborted` `QbitApiError`, as the client's calls do, or, when signing sees it
between two signatures, with a `P2mrPsbtSigningError` caused by one. If
the deadline passes, or the caller cancels, once the transaction may have been
sent, the call rejects with `unknown_outcome` and the transaction stays stored,
to settle later with `reconcileBroadcast`.

A transaction the node accepted, later evicted and now refuses on every
resubmission, for example because its mempool asks a higher fee, stays pending
until the wallet calls `abandonPendingPayment`. That releases it only when the
indexer does not know the txid and every input is still unspent, and resolves
with those inputs. The only safe follow-up is a replacement that spends the
same inputs at a higher fee, so that at most one of the two can confirm, never
a payment built from other inputs. The replacement stays pending on any
rejection, even one that makes `sendPayment` drop its own transaction: the
abandoned transaction, still in a mempool or in a block, may be why the node
refused it.

A pending record that is corrupt, its txid or hex not a string, or its hex not
the whole transaction its txid names, is reported as `corrupt_pending`, never
as nothing pending, by `sendPayment`, `reconcileBroadcast` and
`abandonPendingPayment`, whichever field is the damaged one and, for
`abandonPendingPayment`, whatever txid it is asked to release, before any of
them sends or releases anything: resubmitting hex that is another transaction,
such as an older payment that is still valid, would pay it again. The
transaction may have been sent. The `PaymentStore` contract allows no rewrite
of a pending record, and a corrupt one is never repaired in place: nothing
tells which field is the damaged one, and either may hold an earlier payment's
value, as after a write that stopped halfway, which is why the contract asks
`saveTransaction` to write both in one atomic write. A lookup only shows that a txid is some
transaction the indexer knows, not that it is the record's, and the newest
signature records need not be the pending payment's: two overlapping
`sendPayment` calls both sign before one is refused. A record repaired to name
an earlier payment would be cleared once that one confirms, and the payment
still pending forgotten, so that the next payment could pay twice.

The one way out is a sweep, which `AbandonPaymentErrorCode` describes step by
step for `corrupt_pending`: wait until the indexer lists no unconfirmed
transaction for the address, since its list of unspent outputs leaves out any
that a transaction in its mempool spends; move every output it then lists to
the wallet itself, and wait until those transfers confirm; repeat until the
address's confirmed history shows every output paid to it, but the transfers'
own, spent in a block, so that the lost transaction can no longer confirm.
Then look in that history for a transaction other than the transfers that
spends from the address and that the wallet does not know as an earlier
payment: the lost transaction may have confirmed first and made the payment.
Only then clear the record, and pay again only if the payment was not made.

<!-- snippet: examples/src/send-payment.ts#broadcast -->
```ts
// Signing blocked the thread, so a cancel issued meanwhile (a timer, a
// click) has not run yet. Let it run, and stop before anything is stored
// or sent if it did, or if the deadline passed.
await sleep(0, signal)
throwIfCancelled(signal)
// The POST is round 0 of reconcileBroadcast's schedule, with the budget its
// requests get: if it stalls, the last round still has time to resubmit.
const deadlineMs = requestBudgetMs(msLeft(end), pollMs) // a deadline that has passed sends nothing
// Another call may have stored a payment while this one scanned and signed.
// Check again, with no await before the save, so that only one of them pays.
refuseWhilePending(store)
store.saveTransaction(txid, rawTxHex)
try {
  await client.broadcastTx(rawTxHex, { txid, signal, deadlineMs })
} catch (error) {
  // broadcastTx throws a TypeError only for an invalid argument, before it sends anything.
  if (error instanceof TypeError || (QbitApiError.is(error) && NOT_ACCEPTED.has(error.kind))) {
    store.dropTransaction(txid) // definitely not accepted: never send it later
    throw error
  }
  // unknown_outcome, a kind this version does not know, or any other error,
  // which may follow a send: the node may have the transaction. Find out
  // before sending again, and never rebuild.
  await reconcileBroadcast(client, { txid, rawTxHex }, { end, signal, pollMs })
}
```

## README snippets

The quick starts in the package READMEs are copied from regions of these
files, marked `// #region <name>` and `// #endregion <name>`. A README marks
each copied block with a comment on the line before it, such as
`<!-- snippet: examples/src/api-quick-start.ts#quick-start -->`. A quick start
must run as pasted, in a CommonJS or an ES module project, so its region holds
the whole script: the imports, every placeholder declared and labelled, and no
top-level `await`. After editing a region, refresh the copies:

```sh
node examples/scripts/readme-snippets.mjs --write
```

The examples' `test` script runs the same script with `--check`, which fails
when a copy differs from its region. The script lists every copied block, so
it also fails when a marker is deleted or a new one is not listed. It reads
markers only in `README.md`, `examples/README.md` and `packages/*/README.md`,
and fails on a marker in any other Markdown file git tracks, whose block it
would never check. It lists those files with `git ls-files`, run at the
repository root, which lists the files git tracks under it, whether the root is
a checkout of its own or a tracked part of another one, and scans them when the
list includes the script itself. Otherwise it skips that scan with a note and
still checks the READMEs: when git is missing, when `git ls-files` fails for any
reason, such as outside any checkout, or when the list does not include the
script, as in a source tarball unpacked inside another checkout. In CI, with
the `CI` environment variable set (to anything but `0` or `false`), that scan
must run, so any of those reasons fails the check instead. A tracked file
missing from the working tree holds no marker, so it skips that file with a
note. Either mode prints every problem and every difference it finds, and
`--write` rewrites nothing until every check has passed. Line endings do not
count, so a CRLF checkout checks the same as an LF one. `--write` keeps every line outside the
blocks it changes as it was, ending included, and ends the lines it writes with
the line ending most of the README's lines use.

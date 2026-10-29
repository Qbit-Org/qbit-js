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
amount, fee rate, deadline and poll interval before any request, and the
backend's UTXO rows before any key is used; `reconcileBroadcast` checks its
poll interval and the time left before its `end` the same way. It refuses to
start while an earlier payment is still pending, and checks again right before
it stores its own transaction, so two overlapping calls cannot both pay. It
stores the signed transaction before the first broadcast and drops it only when
`broadcastTx` proves the node did not accept it, or throws a `TypeError`, which
it does only before sending anything. When the outcome is unknown, the
transaction may already be on the network, so it looks the txid up with `getTx`
before it resubmits anything, resubmits only the same hex, and never rebuilds
the payment. A lookup finds the transaction only when the reply's `txid` is its
txid, since `getTx` returns the reply as parsed, without checking that it is the
transaction requested. Each round of reconciliation waits a poll interval, or
half of what is left when less than two are left, then looks the transaction
up. A round with less than two poll intervals left once it has waited is the
last: unless its lookup finds the transaction, it resubmits once with what
remains, and stops. One budget rule covers the first broadcast and every other
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
a payment built from other inputs.

A pending record whose stored hex is not its transaction, or not a whole
transaction, is reported as `corrupt_pending`, never as nothing pending, by
`sendPayment` and `abandonPendingPayment`, before either sends or releases
anything; `reconcileBroadcast` refuses hex that is not a whole transaction the
same way, before any request. The transaction may have been sent, so the wallet
must restore its hex from its own records before it can settle or release it.
Looking the txid up with `getTx` is still safe meanwhile.

<!-- snippet: examples/src/send-payment.ts#broadcast -->
```ts
// Signing blocked the thread, so a cancel issued meanwhile (a timer, a
// click) has not run yet. Let it run, and stop before anything is stored
// or sent if it did, or if the deadline passed.
await sleep(0, signal)
throwIfCancelled(signal)
// The POST is round 0 of reconcileBroadcast's schedule, with the budget its
// requests get: if it stalls, the last round still has time to resubmit.
const deadlineMs = requestBudgetMs(end, pollMs) // a deadline that has passed sends nothing
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
  await reconcileBroadcast(client, rawTxHex, { end, signal, pollMs })
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
would never check. Without git, or when the repository root is not the top
level of a git checkout, as `git rev-parse --show-toplevel` names it, such as in
a source tarball, whether unpacked on its own or inside another checkout, it
skips that scan with a note and still checks the READMEs. A tracked
file missing from the working tree holds no marker, so it skips that file with
a note. Line endings do not count, so a CRLF
checkout checks the same as an LF one. `--write` keeps every line outside the
blocks it changes as it was, ending included, and ends the lines it writes with
the line ending most of the README's lines use.

# Testing

`@qbit-oss/api/testing` is an offline mock of the qbit-electrs (esplora) and
mempool-qbit backends, for the unit tests of code that uses `EsploraClient` or
`MempoolQbitClient`. It serves every route the two clients call from one small
fixture, records the requests it receives, and injects the faults a wallet has
to survive. It is for tests only: never import it in production code.

## Quick start

```ts
import { EsploraClient, QbitApiError, txidFromRawTx } from '@qbit-oss/api'
import { createMockEsplora } from '@qbit-oss/api/testing'

const address = 'qbrt1zzasx2u2z7v9kn4q8e66r57mfw08xvrvdcqfcq6xfte0eau9dgdgqz42zd5'
const mock = createMockEsplora({
  backend: 'esplora',
  txs: [{ txid: 'a1'.repeat(32), vout: [{ address, value: 150_000 }], block: { height: 120 } }],
  faults: [{ route: 'POST /tx', kind: 'broadcast', outcome: 'lost-reply' }],
})
const client = new EsploraClient({ baseUrl: mock.baseUrl, fetchFn: mock.fetchFn })

await client.getAddressBalance(address) // { address, confirmedSats: 150000, mempoolSats: 0, totalSats: 150000 }
await client.getAddressUtxos(address) // [{ txid: 'a1a1...', vout: 0, value: 150000, status: { confirmed: true, ... } }]

// signedTxHex: a transaction the code under test signed
try {
  await client.broadcastTx(signedTxHex)
} catch (error) {
  // The node took the transaction, but the reply was lost.
  if (!QbitApiError.is(error) || error.kind !== 'unknown_outcome') throw error
}
mock.hasTx(txidFromRawTx(signedTxHex)) // true: getTx finds it too
mock.requests // [{ method: 'POST', url: 'https://esplora.example/api/tx', path: '/tx', body: signedTxHex }, ...]
```

`createMockEsplora` checks its options and throws a `TypeError` for a missing,
unknown or malformed one (a txid, address or hex string, a negative or
non-finite number, an unknown route or fault kind, `null`) and for a fixture
that contradicts itself. Only an option left out, or `undefined`, takes its
default.

## Backends

`backend` is required, because the two backends answer differently:

| Request | `esplora` (qbit-electrs) | `mempool-qbit` (the `mempool.qbit.org` hosts) |
| --- | --- | --- |
| `GET /tx/:txid/status` for a txid it has never seen | `200 {"confirmed":false}`, the reply for a mempool transaction | `404` |
| `GET /address/:address/txs?after_txid=` with a cursor found nowhere | `422` | `500` |
| `GET /address/:address/txs/chain`, `/txs/mempool`, `GET /fee-estimates` | served | `404` |
| `GET /fees/recommended`, `POST /tx/push` | `404` | served |

So on `esplora` a `getTxStatus` reply proves nothing about a submission whose
outcome is unknown; `getTx` does, as on a real qbit-electrs
([Recovering from an unknown outcome](broadcasting.md#recovering-from-an-unknown-outcome)).

`baseUrl` defaults to `https://esplora.example/api`, or
`https://mempool.example/api/v1` for `mempool-qbit`. Give the client
`mock.baseUrl`. A request outside it rejects with a `TypeError`.

## The fixture

`txs` lists the transactions the node and its indexer have. Each has:

- `txid`, or `hex`, from which the txid is derived as the client derives it;
  with both, they must agree. `GET /tx/:txid/hex` serves `hex`, and answers
  `501` for a transaction declared without one.
- `vout`: at least one `{ address?, value, scriptPubKey? }`. The mock does not
  derive a scriptPubKey from an address, so `scriptpubkey` is the given hex or
  empty.
- `vin`: the outputs it spends, as `{ txid, vout }`. An output of a
  transaction listed earlier brings its address and value; an output outside
  the fixture needs `value`, and may give `address`. No output may be spent
  twice, and a confirmed transaction cannot spend an unconfirmed output.
- `fee`: inputs minus outputs by default, and it must equal that when the
  transaction has inputs.
- `block: { height, hash?, time? }` for a confirmed transaction; omit it for one
  in the mempool. The hash defaults to the height in hex, zero-padded, and the
  time to `1700000000 + 600 * height`. Transactions at one height are in one
  block, so they must agree on its hash and time.

Every address view is derived from these transactions, so the views agree with
each other as they do on a real backend:

- `GET /address/:address`: `chain_stats` and `mempool_stats` count the
  outputs paying the address and the inputs spending from it, in confirmed and
  mempool transactions, and the distinct transactions touching it.
- `GET /address/:address/utxo`: the address's outputs that no fixture
  transaction spends, confirmed or not.
- History, newest first (the mempool in reverse fixture order; the chain by
  block height, then in reverse fixture order), paged as qbit-electrs pages it:
  `/txs/chain` 25 rows per page, where a cursor it cannot find yields `[]`;
  `/txs/mempool` at most 50 rows; and the combined `/txs?after_txid=` route 50
  rows per page, mempool rows first. A cursor that is the last mempool row
  yields `[]` there, as on qbit-electrs, which `MempoolQbitClient` detects.

`feeEstimates` (default `{ "1": 20, "3": 10, "6": 5, "144": 1 }`) answers
`GET /fee-estimates`, `recommendedFees` (default 20, 15, 10, 5 and 1 sat/vB)
`GET /fees/recommended`, and `tip` the tip routes. The tip height defaults to
the highest fixture block. The tip hash defaults to the hash of the fixture
block at the tip height, which a given `tip.hash` must then match, or to the
height in hex, zero-padded.

## Submissions

Without a fault, `POST /tx`, and `POST /tx/push` with its `txHash=<hex>` form
body, answer as qbit Core v1.0.0 behind qbit-electrs or mempool-qbit does. The
node's coins are the outputs of the fixture's transactions and of the
submissions it took, except those a transaction in a block spends and the
unspendable ones (an `OP_RETURN` scriptPubKey, or one over 10,000 bytes). The
first row that matches decides; each refusal is a `400` reply in the
`sendrawtransaction RPC error: {...}` form:

| Submission | Reply |
| --- | --- |
| Hex the node cannot decode | RPC error `-22`, `TX decode failed` |
| A transaction in a block, while one of its outputs is a coin | RPC error `-27`, `Transaction outputs already in utxo set`: the already-known reply, which the client resolves with the txid it knows |
| A transaction in the mempool | `200` with the txid |
| One that spends an output twice | RPC error `-26`, `bad-txns-inputs-duplicate` |
| One that spends an output that is not a coin: one no known transaction creates, one spent in a block, or an unspendable one | RPC error `-25`, `bad-txns-inputs-missingorspent` |
| One that spends an output a mempool transaction spends | RPC error `-26`, `insufficient fee, rejecting replacement <txid>` |
| Any other | `200` with the txid: the node takes it into its mempool |

So a payment spends a coin only when `txs`, or an earlier submission, holds
the transaction that creates it: declare a test's funding in `txs`. The
outputs of a transaction outside the fixture, such as the one a fixture input
spends with its own `value`, are not coins. A spend in the mempool leaves an output a coin, so a resubmitted
transaction from a block is `-27` until a transaction in a block spends its
last coin. Then its own inputs are spent, and it is `-25`: a rejection of the
resubmission that proves nothing about the original, as
[Recovering from an unknown outcome](broadcasting.md#recovering-from-an-unknown-outcome)
says.

A payment rebuilt from the same outputs after `unknown_outcome`, while the
original is in the mempool, is refused with `-26`. Resubmitting the original's
hex resolves with its txid. qbit Core takes a conflicting transaction as a
replacement (full RBF) when it passes its replacement checks, which require,
among other things, a higher feerate than each transaction it conflicts with,
and fees that exceed the total of every transaction it would evict by at
least the incremental relay fee for its size; it then evicts them. It refuses
one that pays too little in the mock's words, followed by the feerates or fees
it compared. The mock never replaces. An `accepted` fault takes a conflicting transaction, but leaves the
one it conflicts with in the mempool.

The mock checks no script, signature, amount, fee or relay policy: a
transaction that spends coins is taken even if its outputs exceed its inputs.

A transaction the node took is found by `GET /tx/:txid`, `/hex` and `/status`
and by `mock.hasTx(txid)`. `mock.mine()` confirms every mempool transaction in
a new block on the tip. A submission does not join the address views, since the
mock cannot tell which addresses its outputs pay; declare the transaction in
`txs` to test balances after a payment.

## Faults

`faults` replaces the replies of one route. Each request takes the first fault
left for its route, in the order given; `times` (default 1, or `Infinity`)
says how many requests a fault answers, and the route's own reply returns once
its faults are used up. Routes are named as the clients call them, such as
`GET /tx/:txid` or `POST /tx`. The client then reports what the
[outcome table](broadcasting.md#outcomes) and [Resilience](resilience.md) say:

| Fault | What the mock does | Read | `broadcastTx` |
| --- | --- | --- | --- |
| `{ kind: 'status', status, retryAfter?, body? }` | Replies with that status, `Retry-After` header and body | Retried for 429, 500, 502, 503 and 504, then the status's kind | Judged by status and body: a `429` is re-sent within `maxRetryAfterMs`, a `5xx` without a node verdict is `unknown_outcome`, a `404` falls back to `/tx/push` on `MempoolQbitClient` |
| `{ kind: 'network-error' }` | Rejects as undici does for `ECONNREFUSED` from `connect`, before anything is sent | Retried, then `network` | Retried, then `network`; the node never sees it |
| `{ kind: 'stall', status?, retryAfter? }` | Sends the headers and never ends the body, until the request is aborted | The attempt times out and is retried; `timeout` once retries run out | `unknown_outcome`, though the node never sees it; a stalled `429` is re-sent, or `rate_limit` once not retried |
| `{ kind: 'broadcast', outcome: 'accepted' }` | The node takes the transaction, whatever it would answer without the fault | | Resolves with the txid |
| `{ kind: 'broadcast', outcome: 'rejected', code, message? }` | The node refuses it: `400` with RPC error `code` | | `http` for a node code such as `-26`; other codes as the [body verdicts](broadcasting.md#body-verdicts) say, so `-27` resolves with a known txid |
| `{ kind: 'broadcast', outcome: 'lost-reply' }` | The node takes the transaction, as for `accepted`, then the connection resets (`ECONNRESET`) | | `unknown_outcome`, and later lookups find the transaction |

The `broadcast` faults apply only to `POST /tx` and `POST /tx/push`. Hex the
node cannot decode is never taken: `accepted` and `lost-reply` then answer, or
lose, RPC error `-22`. A `status` or `stall` fault on those routes leaves the
node without the transaction.

An indexer that lags its node is a `404` on `GET /tx/:txid` for a few requests:

```ts
const mock = createMockEsplora({
  backend: 'esplora',
  faults: [
    { route: 'POST /tx', kind: 'broadcast', outcome: 'lost-reply' },
    { route: 'GET /tx/:txid', kind: 'status', status: 404, body: 'Transaction not found', times: 3 },
  ],
})
```

## Beyond the mock

The mock models the backends, not every transport. For a reply it does not
produce, such as a redirect, another network error or a body that fails
mid-read, give the client a `fetchFn` of your own. To act when a request
arrives, wrap the mock's:

```ts
const fetchFn: typeof fetch = (input, init) => {
  if (init?.method === 'POST') controller.abort() // the user cancels while the POST is in flight
  return mock.fetchFn(input, init)
}
```

`fetchFn` is a plain `typeof fetch`, and the mock shares no code with the
client at runtime, so a mock from one version of `@qbit-oss/api`, or one build,
can drive a client from another.

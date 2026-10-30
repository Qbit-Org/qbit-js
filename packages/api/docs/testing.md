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
mock.requests.map(({ method, path }) => `${method} ${path}`) // [`GET /address/${address}`, `GET /address/${address}/utxo`, 'POST /tx']
mock.requests[2] // { method: 'POST', url: 'https://esplora.example/api/tx', path: '/tx', body: signedTxHex }
```

`createMockEsplora` checks its options and throws a `TypeError` for a missing,
unknown or malformed one (a txid, address or hex string, a negative or
non-finite number, a `Retry-After` that `Headers` refuses, an unknown route or
fault kind, `null`) and for a fixture that contradicts itself or that qbit
Core could not hold ([The fixture](#the-fixture)). Only an option left out, or
`undefined`, takes its default.

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
  twice, a confirmed transaction cannot spend an unconfirmed output, and no
  transaction can spend an unspendable output (an `OP_RETURN` scriptPubKey, or
  one over 10,000 bytes), which qbit Core never adds to its coins and whose
  script fails every spend.
- `fee`: inputs minus outputs by default, and it must equal that when the
  transaction has inputs. The outputs, and the outputs the inputs spend, may
  each total at most `MAX_MONEY`, 21,000,000,000,000,000 sats, as in qbit
  Core.
- `block: { height, hash?, time? }` for a confirmed transaction; omit it for one
  in the mempool. The hash defaults to the height in hex, zero-padded, and the
  time to `1700000000 + 600 * height`. Transactions at one height are in one
  block, so they must agree on its hash and time.
- `coinbase`: whether it is a block's coinbase transaction. With `hex`, the
  hex decides, and a `coinbase` given too must agree with it; without `hex`,
  `coinbase: true` declares one. A coinbase needs a `block`, has no `vin` and
  pays no fee. A block's transactions are in fixture order, and as in qbit
  Core its coinbase is its first and only one, so a coinbase must be listed
  before the other transactions of its block, and a block has at most one.
  It is served with its coinbase input, from its `hex` when given, witness
  included. Its outputs mature 1,000 blocks after it, as in qbit Core: a
  fixture transaction spends one only in a block at least 1,000 higher, or in
  the mempool once the tip is at least 999 higher, and a submission is
  refused until then.

Every address view is derived from these transactions and the submissions the
node took, as qbit-electrs derives it from its chain index and its mempool, so
the views agree with each other as they do on a real backend:

- `GET /address/:address`: `chain_stats` counts confirmed transactions only,
  and `mempool_stats` mempool ones only: the outputs paying the address, the
  inputs spending from it, and the distinct transactions touching it. So a
  mempool spend of a confirmed output leaves the output funded in
  `chain_stats` and counts it spent in `mempool_stats`, and a mempool output
  that a later mempool transaction spends still counts as funded.
- `GET /address/:address/utxo`: the confirmed outputs that no confirmed or
  mempool transaction spends, then the mempool outputs that no mempool
  transaction spends, each part in fixture and arrival order, with a block
  `mock.mine()` made in its own order ([Submissions](#submissions)).
  qbit-electrs lists the confirmed part in no fixed order.
- History: the chain newest first, by block height, then by position in the
  block, last first, where a fixture block holds its transactions in fixture
  order and a block `mock.mine()` made in its own, so a block's coinbase comes
  after the rest of its block; and the mempool oldest first, in fixture and
  arrival order, as qbit-electrs lists it. It is paged as qbit-electrs pages it with its default page sizes,
  which its operator can change (`--rest-default-chain-txs-per-page` and
  `--rest-default-max-mempool-txs`): `/txs/chain` 25 rows per page, where a
  cursor it cannot find yields `[]` and an unparseable one is ignored;
  `/txs/mempool` at most 50 rows; and the combined `/txs?after_txid=` route
  50 rows per page, mempool rows first. That route looks the cursor up among
  every transaction, not only the address's: one in a block pages the chain
  history after it, one in the mempool pages the mempool rows after it, one
  found nowhere is the error the backends table lists, and an unparseable one
  is ignored. A cursor that no mempool row follows, such as the last mempool
  row, yields `[]`, as on qbit-electrs, which `MempoolQbitClient` detects.

An address is matched as qbit-electrs matches it, by the script it decodes the
address to. A qbit bech32m address, with the HRP `qb`, `tq` or `qbrt`, is the
same address in lowercase and in uppercase, in a request or in the fixture,
and is served in lowercase, as qbit-electrs encodes it from the script;
`GET /address/:address` names it as it was asked for. In mixed case, which
qbit-electrs's decoder refuses, it is a `400` reply, or a `TypeError` in the
fixture. The mock checks no checksum, and matches any other address, such as
a base58 one, exactly.

An output whose `scriptPubKey` qbit-electrs takes as provably unspendable
counts for no address, whatever `address` it is given: qbit-electrs indexes no
such output unless it runs with `--index-unspendables`, so the output is in no
address's stats or unspent outputs, and its transaction is in the address's
history only for another output or an input. These are the scripts that
start with `OP_RETURN`, with an opcode a legacy script treats as `OP_RETURN`
(`OP_RESERVED`, `OP_VER`, `OP_RESERVED1`, `OP_RESERVED2`, or 0xba and above),
or with an illegal one (`OP_VERIF`, `OP_VERNOTIF` or one of the 15 disabled
opcodes, such as `OP_CAT`), as the rust-bitcoin version qbit-electrs uses
decides. It does not look at the size, unlike qbit Core, so an output over
10,000 bytes that starts otherwise is listed. Spends are indexed whatever they
spend.

A mempool transaction that spends an output the mock does not know when it
arrives, which only an `accepted` or `lost-reply` fault can put there, stays
out of the address views while it is in the mempool, even once the
transaction that creates the output arrives: qbit-electrs indexes a mempool
transaction when it arrives, and skips one whose spent outputs it cannot all
find then. The lookups below still find it, and `GET /tx/:txid` gives each
output it spends, and its fee, once the mock knows them, as qbit-electrs looks
them up each time. Once `mock.mine()` confirms it, the address views count it
with every output it spends that the mock knows, as qbit-electrs indexes a
block.

`feeEstimates` (default `{ "1": 20, "3": 10, "6": 5, "144": 1 }`) answers
`GET /fee-estimates`, `recommendedFees` (default 20, 15, 10, 5 and 1 sat/vB)
`GET /fees/recommended`, and `tip` the tip routes. The tip height defaults to
the highest fixture block. The tip hash defaults to the hash of the fixture
block at the tip height, which a given `tip.hash` must then match, or to the
height in hex, zero-padded.

## Submissions

Without a fault, `POST /tx`, and `POST /tx/push` with its `txHash=<hex>` form
body, answer as qbit Core v1.0.0's `sendrawtransaction` behind qbit-electrs or
mempool-qbit does. The node's coins are the outputs of the fixture's
transactions and of the submissions it took, except those a transaction in a
block spends and the unspendable outputs (an `OP_RETURN` scriptPubKey, or one
over 10,000 bytes) of transactions in a block. Every output of a mempool
transaction is a coin, as in Core's view of its mempool, so a spend of an
unspendable one passes the input checks, and Core refuses it at its script
check, as the mock does. The first row that matches decides, in the order
Core checks; each refusal is a `400` reply in the
`sendrawtransaction RPC error: {...}` form, with Core's code and its whole
message, except for a conflict, where the mock gives Core's reason and the
start of its message, without the feerates or fees Core compared:

| Submission | Reply |
| --- | --- |
| Hex the node cannot decode, by Core's decoder: empty or not hex, truncated or with bytes left over, a CompactSize that is non-canonical or over 33,554,432, a witness flag with every witness stack empty, or an unknown flag | `-22`, `TX decode failed. Make sure the tx has at least one input.` |
| An output with a value above 0 whose script is unspendable or does not parse into valid opcodes (`maxburnamount`, 0 by default) | `-25`, `Unspendable output exceeds maximum configured by user (maxburnamount)` |
| A transaction in a block, while one of its outputs is a coin | `-27`, `Transaction outputs already in utxo set`: the already-known reply, which the client resolves with the txid it knows |
| A transaction in the mempool | `200` with the txid |
| One that breaks a rule of `CheckTransaction`: no inputs, no outputs, over 2,000,000 bytes without the witness, an output below 0 or above `MAX_MONEY` (21,000,000,000,000,000 sats), outputs above `MAX_MONEY` in total, an output spent twice, a coinbase input script under 2 or over 100 bytes, or a null prevout in another transaction | `-26`, with the first broken rule's reason, in that order: `bad-txns-vin-empty`, `bad-txns-vout-empty`, `bad-txns-oversize`, `bad-txns-vout-negative`, `bad-txns-vout-toolarge`, `bad-txns-txouttotal-toolarge`, `bad-txns-inputs-duplicate`, `bad-cb-length`, `bad-txns-prevout-null` |
| A coinbase, which only a block holds | `-26`, `coinbase` |
| One that spends an output that is not a coin: one no known transaction creates, one spent in a block, or an unspendable output of a transaction in a block | `-25`, `bad-txns-inputs-missingorspent` |
| One that spends a coinbase output less than 1,000 blocks deep in the next block | `-26`, `bad-txns-premature-spend-of-coinbase, tried to spend coinbase at depth <depth>` |
| One whose inputs are worth more than `MAX_MONEY` in total | `-26`, `bad-txns-inputvalues-outofrange` |
| One whose outputs are worth more than its inputs | `-26`, `bad-txns-in-belowout, value in (<in>) < value out (<out>)`, in coins as Core writes them, such as `0.001` and `1.00` |
| One that spends an output of a mempool transaction it conflicts with | `-26`, `bad-txns-spends-conflicting-tx, <txid> spends conflicting transaction <txid>` |
| One that spends an output a mempool transaction spends | `-26`, `insufficient fee, rejecting replacement <txid>`: Core's reason and the start of its message, which Core goes on with the feerates or fees it compared |
| One that spends an unspendable output of a mempool transaction | `-26`, `mempool-script-verify-flag-failed (OP_RETURN was encountered), input <n> of <txid> (wtxid <wtxid>), spending <txid>:<vout>`, with `(Script is too big)` for a script over 10,000 bytes. Core stops at the first input whose scripts fail, and the mock runs no other script, so this is Core's reply when the scripts of the inputs before it, and its own scriptSig, pass |
| One whose fee is above 10,000 sats per byte of its size: `sendrawtransaction`'s default `maxfeerate`, 0.1 coin per kvB | `-25`, `Fee exceeds maximum configured by user (e.g. -maxtxfee, maxfeerate)` |
| Any other | `200` with the txid: the node takes it into its mempool |

So a payment spends a coin only when `txs`, or an earlier submission, holds
the transaction that creates it: declare a test's funding in `txs`. The
outputs of a transaction outside the fixture, such as the one a fixture input
spends with its own `value`, are not coins. A spend in the mempool leaves an
output a coin, so a resubmitted transaction from a block is `-27` until a
transaction in a block spends its last coin. Then its own inputs are spent,
and it is `-25`: a rejection of the resubmission that proves nothing about the
original, as
[Recovering from an unknown outcome](broadcasting.md#recovering-from-an-unknown-outcome)
says.

A payment rebuilt from the same outputs after `unknown_outcome`, while the
original is in the mempool, is refused with `-26`. Resubmitting the original's
hex resolves with its txid. qbit Core takes a conflicting transaction as a
replacement (full RBF) when it passes its replacement checks, which require,
among other things, a higher feerate than each transaction it conflicts with,
and fees that exceed the total of every transaction it would evict by at
least the incremental relay fee for its size; it then evicts them. A conflict
that fails them gets `insufficient fee, rejecting replacement <txid>` followed
by the feerates or fees Core compared, or the reason of a limit it hit. The
mock never replaces, and its message stops before those numbers, which it does
not compute. An `accepted` fault takes a conflicting transaction, but leaves
the one it conflicts with in the mempool.

The mock models only these checks. It takes a transaction that qbit Core
refuses for any of the following, unless a check it models refuses it. Core
runs many of them between the checks above, though: the policy and finality
checks come before its inputs are looked up, fee floors and mempool limits
before its conflicts, and all of them but a full mempool before the scripts.
So for a transaction that breaks one of them and a modeled rule too, Core's
reply can name the rule below where the mock's names the modeled one:

- relay policy and standardness: the standard transaction rules, the 65-byte
  minimum size without the witness (`tx-size-small`), standard inputs and
  witnesses, the sigop limit, dust and the TRUC rules;
- qbit's rule that outputs pay only to P2MR, `OP_RETURN`, an anchor or, once
  activated, a reserved witness version (`tx-output-not-p2mr`), which mainnet,
  testnet, testnet4 and signet enforce, and regtest unless the node runs with
  `-p2mronly=0`: the mock takes an output to any script;
- fee floors: the minimum relay feerate and the mempool's minimum fee;
- scripts and signatures, which the mock runs only for a spend of an
  unspendable output, above;
- finality: lock times (`non-final`) and sequence locks (`non-BIP68-final`);
- mempool limits: ancestor and descendant chains (`too-long-mempool-chain`)
  and a full mempool;
- replacement, as above.

A transaction the node took is found by `GET /tx/:txid`, `/hex` and `/status`
and by `mock.hasTx(txid)`, and joins the address views in the mempool.
`mock.mine()` confirms every mempool transaction in a new block on the tip,
where the address views count it as confirmed. The block holds them in arrival
order, except that a transaction that arrived after one spending from it goes
just before that one, as qbit Core's miner and consensus rules put a
transaction after those it spends from; only a fault can take a transaction
before one it spends from. A submission's input counts for
the address of the output it spends. Its output counts for an address only
when a fixture output pairs that address with the same `scriptPubKey`, since
the mock does not derive addresses from scripts: give the fixture's outputs
the scripts your code pays to, and a change output, say, joins its address's
balance.

## Faults

`faults` replaces the replies of one route. Each request takes the first fault
left for its route, in the order given; `times` (default 1, or `Infinity`)
says how many requests a fault answers, and the route's own reply returns once
its faults are used up. Routes are named as the clients call them, such as
`GET /tx/:txid` or `POST /tx`. The client then reports what the
[outcome table](broadcasting.md#outcomes) and [Resilience](resilience.md) say:

| Fault | What the mock does | Read | `broadcastTx` |
| --- | --- | --- | --- |
| `{ kind: 'status', status, retryAfter?, body? }` | Replies with that status, `Retry-After` header and body | Retried for 429, 500, 502, 503 and 504, then the status's kind | Judged by status and body as the outcome table says. A `429` with retries left is re-sent when its `Retry-After` is absent or at most `maxRetryAfterMs`. A `501`, `505` or `511` is `http`, but `MempoolQbitClient` falls back to `/tx/push` after a `501`. Any other `5xx` is `unknown_outcome`, unless its body is an already-known reply, which resolves when the txid is known, or a definite node rejection, which is `http`. `MempoolQbitClient` also falls back to `/tx/push` after a `404` or `405` whose body is neither an already-known reply nor a relayed transport failure, and after a generic `400` failure |
| `{ kind: 'network-error' }` | Rejects as undici does for `ECONNREFUSED` from `connect`, before anything is sent | Retried, then `network` | Retried, then `network`; the node never sees it |
| `{ kind: 'stall', status?, retryAfter? }` | Sends the headers and never ends the body, until the request is aborted | The attempt times out and is retried; `timeout` once retries run out | `unknown_outcome`, though the node never sees it; a stalled `429` is re-sent, or `rate_limit` once not retried |
| `{ kind: 'broadcast', outcome: 'accepted' }` | Replies with the txid, whatever the node would answer without the fault. A transaction the node does not have joins its mempool; one it has, in a block or in its mempool, stays where it is | | Resolves with the txid |
| `{ kind: 'broadcast', outcome: 'rejected', code, message? }` | The node refuses it: `400` with RPC error `code` | | `http` for a definite rejection such as `-26`; any other body as the [body verdicts](broadcasting.md#body-verdicts) and the outcome table say, so the already-known `-27` resolves with a known txid, and a relayed transport failure such as `-32603` is `unknown_outcome` |
| `{ kind: 'broadcast', outcome: 'lost-reply' }` | The node takes the transaction, as for `accepted`, then the connection resets (`ECONNRESET`) | | `unknown_outcome`, and later lookups find the transaction |

The `broadcast` faults apply only to `POST /tx` and `POST /tx/push`. Hex the
node cannot decode is never taken: `accepted` and `lost-reply` then answer, or
lose, RPC error `-22`. A `status` or `stall` fault on those routes leaves the
node without the transaction. `retryAfter` is integer seconds or any header
value `Headers` accepts, which trims it of leading and trailing whitespace; a
value with a NUL, CR or LF inside it, or a character above U+00FF, is a
`TypeError` from `createMockEsplora`.

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
can drive a client from another. The mock needs the runtime's `Response`,
`Headers` and `ReadableStream`.

## Resolvers that ignore `exports`

A `testing/package.json` shim points resolvers that ignore the `exports` map at
the subpath: its `main` names the CommonJS build, its `module` the ESM build,
as the package's own fields do, and its `types` the declarations. These were
checked against the packed package:

- TypeScript with `moduleResolution: "node10"` finds `lib/testing.d.ts`
  through `types`.
- Jest before 28, which ignores `exports` (26.6.3 and 27.5.1 were checked),
  finds `lib/testing.js` through `main`. Its node environment does not expose
  `Response`, `Headers` or `ReadableStream`, which the mock needs, nor, in
  Jest 26, the `AbortController` and `AbortSignal` the client needs, so give
  it a test environment that does, such as one that extends
  `jest-environment-node` and copies them onto its `global`.
- Metro 0.87.2 with `unstable_enablePackageExports: false` bundles
  `lib/testing.js` through `main`.

Both entry points, `@qbit-oss/api` and `@qbit-oss/api/testing`, are built for
ES2020, which webpack 4's parser does not support: webpack 4.47.0 fails on the
optional chaining in each of them, through `module` or through `main`.

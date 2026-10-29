# @qbit-oss/api

Typed [esplora](https://github.com/Blockstream/esplora/blob/master/API.md) REST
client for qbit wallets and apps. Talks to an electrs/esplora endpoint
**directly** against a configurable per-chain base URL — no centralized facade.

## Install

```sh
npm install @qbit-oss/api
pnpm add @qbit-oss/api
yarn add @qbit-oss/api
```

A plain install gets the latest final release. Release candidates are published
under the npm dist-tag `candidate`, never `latest`: when one is published,
`@qbit-oss/api@candidate` installs the most recently published candidate.
To pin a version, install `@qbit-oss/api@<version>`. `pnpm add` and
`yarn add` take the same suffixes. Versions and dist-tags are described in
[RELEASING.md](https://github.com/Qbit-Org/qbit-js/blob/main/RELEASING.md).

This package does not build or sign transactions; use
[`@qbit-oss/protocol`](https://github.com/Qbit-Org/qbit-js/blob/main/packages/protocol/README.md)
for that. Low-level PQC signing is in a separate package, `@qbit-oss/pqc`,
published from [Qbit-Org/qbit-pqc](https://github.com/Qbit-Org/qbit-pqc).

## Runtime support

The package ships a CommonJS and an ESM build, each with type declarations, and
its `package.json` declares no `engines` range. What the repository checks:

- CI builds, tests and type-checks it, and runs the checks below, on Node.js 22.
- `consumer:check`
  ([`scripts/check-packed-consumer.mjs`](https://github.com/Qbit-Org/qbit-js/blob/main/scripts/check-packed-consumer.mjs))
  type-checks a consumer against the packed declarations, through both the
  `import` and the `require` condition, as a Node-only project
  (`lib: ["ES2022"]`, `types: ["node"]`, no DOM lib) and as a browser project
  (`lib: ["ES2022", "DOM"]`, no `@types/node`). It then loads the CommonJS and
  the ESM build side by side in Node.js. The browser project is only
  type-checked; no test runs in a browser.
- `smoke:consumer` installs the packed package into a fresh project with npm and
  imports it by name through both builds in Node.js.

Caveats:

- React Native's global `fetch` follows redirects itself. The client refuses
  the reply, but the redirected request has already been sent, on Android with
  your custom `headers`; see
  [Redirects and transport security](docs/transport-security.md). Without a
  standard `URL` implementation, give `baseUrl` in its ASCII form
  ([Configuration](docs/configuration.md)).
- A custom `fetchFn` (node-fetch, a React Native polyfill) only needs to return
  a Response-like object, but its `url` must be the URL it was given, or empty,
  and it should honour `init.signal` and `redirect: 'manual'`
  ([Configuration](docs/configuration.md),
  [Redirects and transport security](docs/transport-security.md)).
- Without the DOM lib, the type declarations need `@types/node` 18.18.7 or later
  in 18.x, 20.8.4 or later in 20.x, or any release from 22 on
  ([Configuration](docs/configuration.md)).

## Quick start

<!-- snippet: examples/src/api-quick-start.ts#quick-start -->
```ts
import { EsploraClient } from '@qbit-oss/api'

async function main() {
  const client = new EsploraClient({ baseUrl: 'https://esplora.example/regtest/api' }) // placeholder: your esplora endpoint
  const address = 'qbrt1zzasx2u2z7v9kn4q8e66r57mfw08xvrvdcqfcq6xfte0eau9dgdgqz42zd5' // placeholder: the address to read
  const balance = await client.getAddressBalance(address) // { address, confirmedSats, mempoolSats, totalSats }
  const utxos = await client.getAddressUtxos(address)
  const history = await client.getAddressHistory(address) // { confirmed, mempool }
  const fees = await client.getFeeTiers() // [{ target, feeRate }] ascending
  console.log({ balance, utxos, history, fees })
  // Once you have a signed transaction (built with @qbit-oss/protocol):
  // const txid = await client.broadcastTx(signedTxHex) // see "Errors you must handle"
}

main().catch(error => console.error(error))
```

For a mempool-qbit backend, such as `https://mempool.qbit.org/api/v1` or
`https://mempool-testnet.qbit.org/api/v1`, construct a `MempoolQbitClient` with
the same options. There, `EsploraClient`'s history and fee-estimate calls
answer `404` ([`MempoolQbitClient`](docs/endpoints.md#mempoolqbitclient)).
Every method also takes a final `{ signal, deadlineMs }` argument
([Resilience](docs/resilience.md)).
A whole payment, recovering from `unknown_outcome` as below, is in [examples/src/send-payment.ts](https://github.com/Qbit-Org/qbit-js/blob/main/examples/src/send-payment.ts).

## Common tasks

| Task | Function(s) | Details |
| --- | --- | --- |
| Show an address's balance | `getAddressBalance`, `addressBalanceFromStats` | [Response validation](docs/response-validation.md) |
| List an address's unspent outputs | `getAddressUtxos` | [Endpoints](docs/endpoints.md#endpoints) |
| Load an address's complete history | `getAddressHistory` | [Address history](docs/address-history.md) |
| Page through history yourself | `getAddressTxs`, `getAddressMempoolTxs` | [Endpoints and clients](docs/endpoints.md) |
| Look up a transaction or its status | `getTx`, `getTxStatus` | [Endpoints](docs/endpoints.md#endpoints) |
| Fetch a transaction's raw hex | `getTxHex` | [Response validation](docs/response-validation.md) |
| Pick a fee rate | `getFeeTiers`, `getFeeEstimates`, `feeTiersFromEstimates` | [Response validation](docs/response-validation.md) |
| Read mempool-qbit's named fees | `MempoolQbitClient.getMempoolRecommendedFees` | [`MempoolQbitClient`](docs/endpoints.md#mempoolqbitclient) |
| Broadcast a signed transaction | `broadcastTx` | [Broadcasting](docs/broadcasting.md) |
| Compute a transaction's txid | `txidFromRawTx` | [Broadcasting](docs/broadcasting.md) |
| Read the chain tip | `getTipHeight`, `getTipHash` | [Endpoints](docs/endpoints.md#endpoints) |
| Cancel a call or bound its duration | `{ signal, deadlineMs }` | [Resilience](docs/resilience.md) |
| Set timeouts, retries, headers or `fetchFn` | `new EsploraClient({ ... })` | [Configuration](docs/configuration.md) |
| Classify an error | `QbitApiError.is`, `error.kind` | [Resilience](docs/resilience.md) |
| Log errors without leaking the base URL | `QbitApiError` `url`, `message`, `cause` | [Logging errors](docs/logging-and-redaction.md) |

## Errors you must handle

`QbitApiError.kind` classifies a failed request (the full list is in
[Resilience](docs/resilience.md)). Four cases need deliberate handling:

- **`unknown_outcome`** from `broadcastTx`: the transaction may have reached the
  node. Never rebuild the payment with different inputs, which can double-spend
  or pay twice; resubmitting the **same** hex is harmless. See
  [Recovering from an unknown outcome](docs/broadcasting.md#recovering-from-an-unknown-outcome).
- **`invalid_cursor`** from a history scan: the history could not be shown
  complete. On `EsploraClient` that happens, for example, behind a lagging node
  or across a reorg. Retry the scan later, but not in an endless loop: some
  causes persist until the backend changes, such as an address with more than
  50 mempool transactions on `EsploraClient`
  ([Address history](docs/address-history.md)). On `MempoolQbitClient`, an
  internal page cursor the backend has lost rejects as `http` rather than
  `invalid_cursor`; its other `invalid_cursor` cases remain
  ([`MempoolQbitClient`](docs/endpoints.md#mempoolqbitclient)).
- **`rate_limit`**: the backend answered `429` and the client stopped retrying.
  `error.retryAfterMs` carries the server's `Retry-After` when it sent one, so
  the UI can decide when to try again ([Resilience](docs/resilience.md); for
  `broadcastTx`, the [outcome table](docs/broadcasting.md#outcomes)).
- **`QbitApiError.is(error)`, not `instanceof`**: an app that loads both the
  CommonJS and the ESM build, or two versions, has two `QbitApiError` classes,
  and `instanceof` is false for the other one's errors. Keep a default branch
  for kinds this version does not list. [Resilience](docs/resilience.md)

## Topic pages

- [Address history](docs/address-history.md): complete scans with
  `getAddressHistory`, and why an empty page does not prove completeness.
- [Broadcasting](docs/broadcasting.md): the outcome of every submission reply,
  and how to recover from an unknown outcome.
- [Endpoints and clients](docs/endpoints.md): the method list,
  `MempoolQbitClient`, and what the package leaves out.
- [Resilience](docs/resilience.md): timeouts, retries, cancellation, deadlines,
  de-duplication and the error taxonomy.
- [Redirects and transport security](docs/transport-security.md): refused
  redirects, React Native, custom `fetchFn`s and plain `http`.
- [Logging errors](docs/logging-and-redaction.md): what errors redact and what
  they pass through.
- [Response validation](docs/response-validation.md): what the fee, balance and
  `getTxHex` adapters reject, and the fee-rate ceiling.
- [Configuration](docs/configuration.md): constructor options, `baseUrl` rules,
  types without the DOM lib, and custom `fetchFn` requirements.

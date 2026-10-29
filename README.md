# qbit-js

TypeScript SDK packages for qbit wallets and applications.

This repo is intentionally a workspace. Each package publishes separately while
sharing one toolchain, CI and release line. Each package README starts with
install lines, a quick start and a table of common tasks.

## Which package do I need?

- [`@qbit-oss/protocol`](packages/protocol/README.md) to derive addresses, build,
  sign and finalize PSBTs, and handle descriptors, `qbit:` URIs and message
  proofs. It makes no network requests.
- [`@qbit-oss/api`](packages/api/README.md) to read balances, UTXOs, history and
  fee estimates from a qbit block explorer and to broadcast a signed
  transaction.
- A wallet usually needs both, plus a PQC signer for the signatures
  `@qbit-oss/protocol` asks for (see the PQC note below).

```sh
npm install @qbit-oss/protocol @qbit-oss/api
pnpm add @qbit-oss/protocol @qbit-oss/api
yarn add @qbit-oss/protocol @qbit-oss/api
```

Both packages are released together at one version, which names one tested
combination; see [RELEASING.md](RELEASING.md) for versions and the `candidate`
dist-tag.

## Packages

- [`@qbit-oss/protocol`](packages/protocol/README.md): qbit protocol primitives for
  networks, P2MR addresses, scripts, descriptors, sighash, PSBT fields, and
  transaction helpers.
- [`@qbit-oss/api`](packages/api/README.md): typed REST clients for qbit block
  explorers. `EsploraClient` talks to an electrs/esplora endpoint, and
  `MempoolQbitClient` to a mempool-qbit backend (qbit's port of the mempool
  explorer) such as `mempool.qbit.org/api/v1`. Both cover address balance, UTXOs
  and history, transaction lookup, fee estimates and broadcast.

Runnable examples of both packages, tested in CI, are in [`examples/`](examples/README.md).

Planned packages:

- `@qbit-oss/wallet-core` or `@qbit-oss/keyring`: seed phrase, derivation, encrypted
  vault interfaces, address rotation, and PQC signature-counter lifecycle
  helpers.

Low-level PQC signing is not part of these packages. It is in a separate
package, `@qbit-oss/pqc`, published from
[Qbit-Org/qbit-pqc](https://github.com/Qbit-Org/qbit-pqc).

## Development

Prerequisites, setup, CI checks and the change process are in
[CONTRIBUTING.md](CONTRIBUTING.md).

```sh
corepack pnpm install
corepack pnpm verify
```

## Releases

Versioning, release branches and tags are described in
[RELEASING.md](RELEASING.md); changes are listed in [CHANGELOG.md](CHANGELOG.md).

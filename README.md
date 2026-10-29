# qbit-js

TypeScript SDK packages for qbit wallets and applications.

This repo is intentionally a workspace. Each package publishes separately while
sharing one toolchain, CI and release line. The `@qbit-oss/api` README includes
usage examples.

## Packages

- [`@qbit-oss/protocol`](packages/protocol/README.md): qbit protocol primitives for
  networks, P2MR addresses, scripts, descriptors, sighash, PSBT fields, and
  transaction helpers.
- [`@qbit-oss/api`](packages/api/README.md): typed REST clients for qbit block
  explorers. `EsploraClient` talks to an electrs/esplora endpoint, and
  `MempoolQbitClient` to a mempool-qbit backend (qbit's port of the mempool
  explorer) such as `mempool.qbit.org/api`. Both cover address balance, UTXOs
  and history, transaction lookup, fee estimates and broadcast.

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

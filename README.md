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

Requires Node.js 22.13+ (22.x), 24.x, or 26 and later; CI runs Node.js 22. The
range is the root `package.json` `engines.node` field, the intersection of what
pnpm 11 (`>=22.13`) and vitest 5 (`^22.12.0 || ^24.0.0 || >=26.0.0`) support.
Node.js 23 and 25 are not supported: `pnpm install` prints an "Unsupported
engine" warning on them, and pnpm 11 itself fails to start on Node.js older than
22.13. The pnpm version is pinned by `packageManager` in `package.json` (pnpm
11), and Corepack runs that exact version. Node.js 25 and later no longer bundle
Corepack, so on Node.js 26+ install it with `npm install -g corepack`.

```sh
corepack pnpm install
corepack pnpm build
corepack pnpm test
corepack pnpm typecheck
```

## Releases

Versioning, release branches and tags are described in
[RELEASING.md](RELEASING.md); changes are listed in [CHANGELOG.md](CHANGELOG.md).

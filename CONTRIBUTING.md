# Contributing

## Prerequisites

Requires Node.js 22.13+ (22.x), 24.x, or 26 and later; CI runs Node.js 22. The
range is the root `package.json` `engines.node` field, the intersection of what
pnpm 11 (`>=22.13`) and vitest 5 (`^22.12.0 || ^24.0.0 || >=26.0.0`) support.
Node.js 23 and 25 are not supported: `pnpm install` prints an "Unsupported
engine" warning on them, and pnpm 11 itself fails to start on Node.js older than
22.13. The pnpm version is pinned by `packageManager` in `package.json` (pnpm
11), and Corepack runs that exact version. Node.js 25 and later no longer bundle
Corepack, so on Node.js 26+ install it with `npm install -g corepack`.

CI reads its Node.js version from `.nvmrc`, so `nvm use` selects the same one.

## Setup

```sh
corepack pnpm install
corepack pnpm verify
```

`verify` runs CI's offline checks in CI's order and stops at the first failure:
`format:check`, `build`, `test`, `typecheck`, `pack:check` and
`consumer:check`. It leaves two checks to CI: `smoke:consumer`, which installs
the packed packages with npm and resolves their dependencies from the
registry, and `fixtures:check`, which clones qbit Core and also needs git and
Python (see `scripts/check-core-fixtures.sh`). Both run locally too, given
network access.

## CI checks

The `verify` job in `.github/workflows/ci.yml` runs these steps in order, on
pull requests to `main` and `release/**`, on pushes to them, and on manual
dispatch:

- **Check pnpm matches packageManager**: CI installs the pnpm pinned by
  `packageManager` in `package.json` and fails if a different one runs, so CI
  and local Corepack cannot drift.
- **Install dependencies**: `pnpm install --frozen-lockfile --config.engine-strict=true`.
  Its engine-strict flag turns pnpm's "Unsupported engine" warning into a
  failure, so CI's Node.js must stay inside the root `engines.node` range and
  every non-optional locked dependency's engines.
- **Format check**: `pnpm format:check` fails if Prettier would change a file.
- **Build**: `pnpm build` builds each package's `lib/` with tsup.
- **Test**: `pnpm test` runs each package's vitest suite.
- **Typecheck**: `pnpm typecheck` runs `tsc --noEmit` in each package.
- **Check npm package contents**: `pnpm pack:check` fails if a package's
  tarball misses a required file, would publish anything outside the expected
  set, or has a LICENSE that differs from the root one.
- **Packed-consumer types and dual-build check**: `pnpm consumer:check`
  type-checks the packed declarations as a Node-only (no DOM lib) and a browser
  (no `@types/node`) consumer, and loads the CJS and ESM builds side by side to
  check the error-class brands.
- **Fresh-consumer install smoke**: `pnpm smoke:consumer` builds and packs both
  packages, installs the tarballs with npm into a clean project outside the
  workspace, and imports them by name.
- **Check Core-derived fixtures reproduce from qbit Core**: `pnpm fixtures:check`
  regenerates `p2mr-sighash.json` and `p2mr-psbt.json` (the generated fixtures
  in `packages/protocol/fixtures`) from a fresh qbit Core v1.0.0 clone and fails
  unless both match the committed files byte for byte.

## Formatting

[Prettier](https://prettier.io) formats the code, with the settings in
`.prettierrc.json`. Run `corepack pnpm format` to rewrite files in place;
`corepack pnpm format:check` only reports them.

Prettier skips what `.gitignore` lists and what `.prettierignore` excludes:

- build output (`packages/*/lib`) and `coverage`;
- the Core-derived and vendored fixtures, `packages/protocol/fixtures/**` and
  `packages/api/test/fixtures/**`, which keep the exact bytes they were
  generated or vendored with;
- every `*.md` file;
- `pnpm-lock.yaml` and every `package.json`, whose formatting npm and pnpm own;
- every `*.yml` and `*.yaml` file, including the workflows.

The commit that first applied Prettier is listed in `.git-blame-ignore-revs`.
GitHub's blame view skips it; to have `git blame` skip it too, run:

```sh
git config blame.ignoreRevsFile .git-blame-ignore-revs
```

## Fixtures

The fixtures in `packages/protocol/fixtures` and `packages/api/test/fixtures`
are generated, derived or vendored from qbit Core. Do not edit them by hand:
regenerate or re-vendor them as the
[conformance playbook](docs/conformance-playbook.md) describes.
`packages/api/test/fixtures/p2mr-witness-tx.json` records its own derivation
in `source.method`.

## Changes and releases

- Add an entry to [CHANGELOG.md](CHANGELOG.md) for every user-visible change,
  in the matching subsection of the unreleased version's section. Start it
  with **Breaking:** when the change can make existing caller code fail or
  behave differently.
- Versions follow [SemVer](https://semver.org), and both packages share one
  version. Below 1.0, a breaking change bumps MINOR (`0.1.x` → `0.2.0`) and a
  backward-compatible fix or addition bumps PATCH (`0.1.0` → `0.1.1`). From
  1.0.0 on, a breaking change bumps MAJOR.
- Feature and fix PRs target `main`. A `release/X.Y` branch takes only fixes,
  docs, and version and CHANGELOG updates.

[RELEASING.md](RELEASING.md) covers versioning, release branches, back-merges,
tags and publishing.

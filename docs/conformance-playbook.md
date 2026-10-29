# qbit Core Conformance Playbook

The conformance pin for wallet work is qbit Core `v1.0.0`
(`Qbit-Org/qbit` @ `7ebcddb622d6e639041f005a189b048ec2a221fe`).

Core's own committed P2MR v1 vectors at this pin are vendored verbatim in `packages/protocol/fixtures/core/` (provenance and re-vendoring steps in its README) and checked by `packages/protocol/test/core-p2mr-vectors.test.ts`; re-vendor them with any pin bump.

This repo has no live conformance harness. Live conformance runs downstream,
in a wallet's regtest harness: qbit Core and
[`Qbit-Org/qbit-electrs`](https://github.com/Qbit-Org/qbit-electrs) on regtest,
with a conformance matrix that exercises these packages against them. Here, the
offline checks are the Core-derived fixture tests that `corepack pnpm test`
runs.

For a candidate qbit Core pin bump:

1. Build qbit Core and qbit-electrs for the candidate ref.
2. Start a regtest harness on those builds: a qbit Core node and a qbit-electrs
   instance indexing it.
3. Run the conformance matrix against that harness, with this repo's candidate
   changes in place, and treat a skipped check as a failure.

4. Regenerate any affected fixtures in the relevant package and review the diff by fixture name. Do not adopt a new pin without explicit sign-off on the changed consensus, descriptor, address, signing, or PSBT behavior.

   The Core-derived P2MR fixtures in `packages/protocol/fixtures` are generated from a `Qbit-Org/qbit` checkout whose `origin` is that GitHub repository, at the candidate commit:

   ```sh
   python3 -I packages/protocol/scripts/gen-sighash-fixtures.py --qbit <qbit-checkout> \
     --commit <candidate-commit> --out packages/protocol/fixtures/p2mr-sighash.json
   python3 -I packages/protocol/scripts/gen-psbt-fixtures.py --qbit <qbit-checkout> \
     --commit <candidate-commit> --out packages/protocol/fixtures/p2mr-psbt.json
   ```

   Commit the generated files unedited. CI runs the check below, which regenerates both fixtures from a fresh clone of the pinned tag and fails unless they match the committed files byte for byte. When the pin moves, update `CORE_TAG` and `CORE_COMMIT` in `scripts/check-core-fixtures.sh` and `DEFAULT_COMMIT` in both generators with it:

   ```sh
   corepack pnpm fixtures:check
   ```

5. Update the pinned commit references in docs and fixtures together.

The generated fixtures and their generators are also a contract with
[`Qbit-Org/qbit-wallet`](https://github.com/Qbit-Org/qbit-wallet). Its
`scripts/conformance/qbit-js/` vendors `packages/protocol/fixtures/p2mr-sighash.json`,
`packages/protocol/fixtures/p2mr-psbt.json` and both generators by those paths.
Its conformance checks run the fixtures against the installed
`@qbit-oss/protocol` and regenerate them with the generators' `--qbit`, `--out`,
`--repository` and `--commit` flags. Keep those paths and flags, and keep
changes under `schemaVersion: 1` additive: add vectors or fields, and leave
every existing entry and field as it is. Any other change to a fixture's layout
needs a new `schemaVersion` and a matching qbit-wallet change.

When a new protocol or signing surface lands here, add a live check for it to the downstream conformance matrix.

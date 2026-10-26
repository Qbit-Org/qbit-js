# Vendored qbit Core P2MR conformance vectors

These four files are byte-for-byte copies of qbit Core's committed P2MR v1
vectors. They are not generated in this repository and must not be edited by
hand. `test/core-p2mr-vectors.test.ts` checks their sha256 digests against the
manifest and pins the manifest's own digest. `.gitattributes` marks them
`-text`, so a checkout that converts line endings keeps the bytes those
digests cover.

| File | Core path | Git blob | sha256 |
| --- | --- | --- | --- |
| `p2mr_vectors.json` | `src/test/data/p2mr_vectors.json` | `13898cd2b689e12a3d98ec4f654bc8d41b291c23` | `50527577dd84cd9ee2b66a3fbc91c53677f5d4e45527afdc86d4f9cb050cbc1a` |
| `p2mr_pqc_witness_vectors.json` | `src/test/data/p2mr_pqc_witness_vectors.json` | `d9a3690645323a10bbb29a311f6db5928fd05b5f` | `4efb0a13b60b50b95e74e2979b4d8edee36184001f7d0448c5e1afaabc2dcfb4` |
| `p2mr_script_boundary_vectors.json` | `src/test/data/p2mr_script_boundary_vectors.json` | `0ee6ce236b667dc8f8debc315d9254f6e0aa2457` | `0dfff99a45b8e1ccb80e149b069f28c47114b05767ecec2a37e07c9dc578c6b4` |
| `p2mr_v1_manifest.json` | `src/test/data/p2mr_v1_manifest.json` | `59fcec2fbe10de149cb038eb01df2bc864f24b31` | `d30f2fb354ee9b55bc72ba2d9b250aefd96656f0eac61b0f2cdb77001aacdad4` |

## Source

- Repository: `Qbit-Org/qbit`
- Tag: `v1.0.0` (annotated tag object `c72d230476ffe94e2f672d925f34288159233dfc`)
- Commit: `7ebcddb622d6e639041f005a189b048ec2a221fe`. This is the same conformance
  pin as `docs/conformance-playbook.md` and the generated fixtures in `..`.

## Manifest commit discrepancy

The manifest's `reference_implementation.commit` is
`988756471aeecdf4463c04be49da2b7b89a98c21`, not the tag commit. That commit is
not an ancestor of `v1.0.0`: GitHub's compare reports the two as diverged, with
the tag 5 commits ahead and 12 behind. At `9887564` the manifest and
`p2mr_script_boundary_vectors.json` do not exist, and the other two files have
different blobs. These copies are therefore pinned by the tag commit above, and
the manifest's `reference_implementation.commit` is treated as informational.

The manifest also lists `src/test/data/p2mr_cross_profile_vectors.json`. That
file is not vendored here. Its two cases contrast qbit with the non-normative
BIP-360 0.12.0 profile, whose depth-zero root is a `TapLeaf` hash. On the qbit
side, one case fails the commitment because its program is that `TapLeaf`
hash. The other passes the commitment and then fails executing its `OP_0`
leaf, which the SDK cannot evaluate. The only qbit value either case carries
is the `P2MRLeaf` hash of that leaf, and the tests already check leaf hashes
against `p2mr_vectors.json` and the witness vectors.

## Re-vendoring

To move the pin, fetch each file at the new commit, then update this README, the
`CORE_*` constants in `test/core-p2mr-vectors.test.ts` and the conformance
playbook together:

```sh
ref=<commit>
for f in p2mr_vectors.json p2mr_pqc_witness_vectors.json \
  p2mr_script_boundary_vectors.json p2mr_v1_manifest.json; do
  gh api "repos/Qbit-Org/qbit/contents/src/test/data/$f?ref=$ref" \
    -H "Accept: application/vnd.github.raw" > "packages/protocol/fixtures/core/$f"
done
git hash-object packages/protocol/fixtures/core/*.json  # compare with the tree at $ref
```

## Coverage

The SDK has no script interpreter and does not verify PQC signatures. The tests
check the leaf hashes, branch preimages, control blocks, roots, scriptPubKeys,
addresses and sighash digests in the vectors, and that each invalid commitment
fails at Core's stage. They do not check:

- the boundary cases that need script execution: witness shape, opcode
  execution, initial-stack resource limits and validation weight. The test file
  pins which cases it skips.
- the signatures.
- intermediate values that the SDK computes internally but does not export.
  Each is covered through the hash or digest it feeds:
  - `leaf_preimage` in the valid commitment vectors, the input to `leaf_hash`;
  - `annexHash`, committed inside `p2mrSighash`;
  - `p2mrSigMsg`, `noAnnexSigMsg`, `wrongCodeseparatorSigMsg` and
    `checkSigAdd.p2mrSigMsg`, the messages behind the checked sighashes.
- the invalid commitment vectors' `wrong_leaf_preimage`, `wrong_leaf_hash`,
  `wrong_branch_preimage` and `wrong_merkle_root`. They record the mistake each
  vector models. The tests check only that the vector's `merkle_root` is
  rejected at Core's stage.
- the CTV boundary cases' `template_hash`. The SDK does not compute CTV template
  hashes, so only the commitment of each `leaf_script` to its `script_pubkey`
  is checked.

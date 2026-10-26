#!/usr/bin/env bash
# Regenerate the Core-derived P2MR fixtures from a fresh clone of qbit Core
# and check that they match the committed files byte for byte.
#
# Usage: bash scripts/check-core-fixtures.sh   (or: pnpm fixtures:check)
#
# Needs git, network access to github.com, and a python3 with tarfile's "data"
# filter (3.12+, or 3.9.17+, 3.10.12+ or 3.11.4+). To adopt a new Core pin,
# update CORE_TAG and CORE_COMMIT here and DEFAULT_COMMIT in both generators,
# then regenerate the fixtures (docs/conformance-playbook.md, step 4).
set -euo pipefail

CORE_URL=https://github.com/Qbit-Org/qbit
CORE_REPOSITORY=Qbit-Org/qbit
CORE_TAG=v1.0.0
CORE_COMMIT=7ebcddb622d6e639041f005a189b048ec2a221fe

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
generators=$repo_root/packages/protocol/scripts
fixtures=$repo_root/packages/protocol/fixtures

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

# Fetch only the tag's tree, then check out just the files the generators read.
# (Shallow-cloning an annotated tag makes git warn "... is not a commit!"; harmless.)
git -c advice.detachedHead=false clone --quiet --depth 1 --branch "$CORE_TAG" --no-tags \
  --filter=blob:none --sparse "$CORE_URL" "$work/qbit"
git -C "$work/qbit" sparse-checkout set --no-cone \
  /test/functional/test_framework/ /src/test/data/bip341_wallet_vectors.json

head=$(git -C "$work/qbit" rev-parse HEAD)
if [[ $head != "$CORE_COMMIT" ]]; then
  echo "$CORE_URL $CORE_TAG is at $head, not the pinned $CORE_COMMIT" >&2
  exit 1
fi

mkdir "$work/out"
for generator in sighash psbt; do
  python3 -I "$generators/gen-$generator-fixtures.py" --qbit "$work/qbit" \
    --repository "$CORE_REPOSITORY" --commit "$CORE_COMMIT" \
    --out "$work/out/p2mr-$generator.json"
done

status=0
for name in p2mr-sighash.json p2mr-psbt.json; do
  if cmp "$fixtures/$name" "$work/out/$name"; then
    echo "$name matches $CORE_REPOSITORY $CORE_TAG ($CORE_COMMIT)"
  else
    echo "$name differs from its regeneration from $CORE_REPOSITORY $CORE_TAG ($CORE_COMMIT):" >&2
    # psbtHex is one 15 KB line: show the start of each changed line only.
    diff -u "$fixtures/$name" "$work/out/$name" | cut -c 1-200 | head -n 40 >&2 || true
    status=1
  fi
done
exit "$status"

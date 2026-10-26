#!/usr/bin/env python3
"""Generate a qbit P2MR PSBT fixture using qbit's own (Core-faithful) test
framework PSBT/PSBTMap serialization.

Provenance: Qbit-Org/qbit @ 7ebcddb622d6e639041f005a189b048ec2a221fe (v1.0.0),
test/functional/test_framework.

The PSBT carries the qbit-specific fields (witness UTXO, 0x1d leaf script,
0x19 script sig, the "qbit" proprietary merkle root, a finalized input) plus an
unknown field, so the TS container codec is exercised on externally-produced
bytes for byte-exact round-trip + field preservation.

Usage:
    python3 -I gen-psbt-fixtures.py --qbit /path/to/qbit --out ../fixtures/p2mr-psbt.json \
        [--repository Qbit-Org/qbit] [--commit <40-hex commit, default: v1.0.0's>]

The --qbit checkout must be at --commit and its origin remote must be
--repository on GitHub. The framework is imported from a `git archive` export
of --commit, never from the working tree, and the fixture is written only after
every self-check passes.
Extracting the export needs tarfile's "data" filter: Python 3.12+, or
3.9.17+, 3.10.12+ or 3.11.4+.
"""
import argparse
import importlib.util
import io
import json
import os
import re
import subprocess
import sys
import tarfile
import tempfile

P2MR_LEAF_VERSION = 0xC0
OP_CHECKSIGPQC = 0xB3
PQC_SIG_SIZE = 3680

DEFAULT_REPOSITORY = "Qbit-Org/qbit"
# Qbit-Org/qbit v1.0.0, the Core release the committed fixtures come from.
DEFAULT_COMMIT = "7ebcddb622d6e639041f005a189b048ec2a221fe"
# What the generator reads from --commit.
CORE_PATHS = ["test/functional/test_framework"]
# The https and ssh forms of a GitHub remote URL.
GITHUB_REMOTE = re.compile(
    r"(?:https://github\.com/|ssh://git@github\.com/|git@github\.com:)"
    r"(?P<slug>[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+?)(?:\.git)?/?"
)


def repository_slug(value):
    if not re.fullmatch(r"[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+", value):
        raise argparse.ArgumentTypeError("must be a GitHub owner/repo slug")
    return value


def commit_id(value):
    if not re.fullmatch(r"[0-9a-f]{40}", value):
        raise argparse.ArgumentTypeError("must be a full 40-character lowercase commit ID")
    return value


def checkout_commit(qbit, expected):
    """Return the --qbit checkout's HEAD, which must be the expected commit."""
    head = subprocess.run(
        ["git", "-C", qbit, "rev-parse", "HEAD"],
        check=True, capture_output=True, text=True,
    ).stdout.strip()
    if head != expected:
        sys.exit(f"--qbit checkout is at {head}, not --commit {expected}")
    return head


def check_origin(qbit, repository):
    """Refuse to record --repository unless it is the checkout's origin remote."""
    remote = subprocess.run(
        ["git", "-C", qbit, "remote", "get-url", "origin"],
        capture_output=True, text=True,
    )
    url = remote.stdout.strip() if remote.returncode == 0 else ""
    match = GITHUB_REMOTE.fullmatch(url)
    if match is None or match["slug"].lower() != repository.lower():
        sys.exit(f"--qbit origin remote is {url or '(none)'}, not --repository {repository} on GitHub")


def export_commit(qbit, commit, dest):
    """Extract CORE_PATHS at commit into dest with git archive; return dest's real path.

    The generator imports and reads only this export, so untracked or ignored
    files in the working tree (a sourceless *.pyc, a module hidden by
    status.showUntrackedFiles=no) cannot reach a run.
    """
    archive = subprocess.run(
        ["git", "--no-replace-objects", "-C", qbit, "archive", "--format=tar", commit, "--", *CORE_PATHS],
        check=True, stdout=subprocess.PIPE,
    ).stdout
    with tarfile.open(fileobj=io.BytesIO(archive)) as tar:
        tar.extractall(dest, filter="data")
    return os.path.realpath(dest)


def import_framework(root):
    """Append root's test/functional to sys.path and check test_framework resolves there."""
    fdir = os.path.join(root, "test", "functional")
    # Appended, not prepended, so nothing in the export can shadow a stdlib module.
    sys.path.append(fdir)
    # Locate the package without running it, in case another test_framework comes first.
    spec = importlib.util.find_spec("test_framework")
    origin = spec.origin if spec is not None and spec.origin is not None else "nowhere"
    if os.path.dirname(os.path.dirname(os.path.realpath(origin))) != fdir:
        sys.exit(f"test_framework resolves to {origin}, not the export in {fdir}")


def write_fixture(path, fixture):
    """Write fixture to path as JSON through a temp file, so a failed run leaves path as it was."""
    out_path = os.path.abspath(path)
    tmp_path = f"{out_path}.{os.getpid()}.tmp"
    try:
        with open(tmp_path, "w") as fh:
            json.dump(fixture, fh, indent=2)
            fh.write("\n")
        os.replace(tmp_path, out_path)
    finally:
        if os.path.exists(tmp_path):
            os.unlink(tmp_path)
    return out_path


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--qbit", required=True, help="path to a qbit repo checkout at --commit")
    ap.add_argument("--out", required=True, help="output fixture JSON path")
    ap.add_argument("--repository", type=repository_slug, default=DEFAULT_REPOSITORY,
                    help=f"source repository recorded in the fixture; must be the checkout's origin "
                         f"(default: {DEFAULT_REPOSITORY})")
    ap.add_argument("--commit", type=commit_id, default=DEFAULT_COMMIT,
                    help=f"commit the --qbit checkout must be at (default: {DEFAULT_COMMIT}, v1.0.0)")
    args = ap.parse_args()
    if not __debug__:
        sys.exit("the self-checks are asserts; run the generator without -O")
    if not hasattr(tarfile, "data_filter"):
        sys.exit(f"Python {sys.version.split()[0]} lacks tarfile's data filter, which the export needs; "
                 "use Python 3.12+, or 3.9.17+, 3.10.12+ or 3.11.4+")
    args.commit = checkout_commit(args.qbit, args.commit)
    check_origin(args.qbit, args.repository)
    with tempfile.TemporaryDirectory(prefix="qbit-core-") as export:
        generate(args, export_commit(args.qbit, args.commit, export))


def generate(args, root):
    import_framework(root)
    from test_framework.messages import (  # noqa: E402
        CTransaction, CTxIn, CTxOut, COutPoint, ser_string, ser_string_vector, ser_compact_size, ser_uint256,
    )
    from test_framework.script import TaggedHash  # noqa: E402

    h = lambda b: b.hex()

    def leaf(pubkey):
        script = bytes([0x20]) + pubkey + bytes([OP_CHECKSIGPQC])
        leaf_hash = TaggedHash("P2MRLeaf", bytes([P2MR_LEAF_VERSION]) + ser_string(script))
        spk = bytes([0x52, 0x20]) + leaf_hash  # OP_2 push32 root (single-leaf tree => root == leaf hash)
        control = bytes([P2MR_LEAF_VERSION | 1])  # bit 0 set, no merkle branch
        return script, leaf_hash, spk, control

    pk0 = bytes((i * 7 + 1) & 0xFF for i in range(32))
    pk1 = bytes((i * 5 + 9) & 0xFF for i in range(32))
    script0, leafhash0, spk0, control0 = leaf(pk0)
    script1, leafhash1, spk1, control1 = leaf(pk1)
    out_spk = bytes([0x52, 0x20]) + bytes((i ^ 0x5A) & 0xFF for i in range(32))

    def outpoint(seed):
        op = COutPoint()
        op.hash = int.from_bytes(bytes((seed + i) & 0xFF for i in range(32)), "little")
        op.n = seed & 3
        return op

    spent0 = CTxOut(100_000, spk0)
    spent1 = CTxOut(95_000, spk1)

    tx = CTransaction()
    tx.version = 2
    tx.nLockTime = 0
    tx.vin = [CTxIn(outpoint(3), b"", 0xFFFFFFFD), CTxIn(outpoint(40), b"", 0xFFFFFFFE)]
    tx.vout = [CTxOut(180_000, out_spk)]

    def proprietary_key(identifier, subtype, keydata=b""):
        return bytes([0xFC]) + ser_string(identifier) + ser_compact_size(subtype) + keydata

    # input 0: witness_utxo, leaf script (0x1d), script sig (0x19), proprietary qbit merkle root
    in0 = {
        0x01: spent0.serialize(),
        bytes([0x1D]) + control0: bytes(script0) + bytes([P2MR_LEAF_VERSION]),
        bytes([0x19]) + pk0 + leafhash0: bytes(i & 0xFF for i in range(PQC_SIG_SIZE)),
        proprietary_key(b"qbit", 0x01): leafhash0,
    }
    # input 1: witness_utxo, an UNKNOWN field (preservation), and a finalized witness
    in1 = {
        0x01: spent1.serialize(),
        bytes([0x77]): bytes.fromhex("deadbeef"),
        # A final scriptwitness is a count-prefixed stack: Core reads it with
        # UnserializeFromVector (src/psbt.h:647-655).
        0x08: ser_string_vector([bytes(i & 0xFF for i in range(PQC_SIG_SIZE)), bytes(script1), control1]),
    }

    from test_framework.psbt import PSBT, PSBTMap  # noqa: E402

    psbt = PSBT(
        g=PSBTMap(map={0x00: tx.serialize()}),
        i=[PSBTMap(map=in0), PSBTMap(map=in1)],
        o=[PSBTMap(map={})],
    )
    psbt_bytes = psbt.serialize()

    out = {
        "schemaVersion": 1,
        "name": "qbit-p2mr-psbt",
        "source": {
            "repository": args.repository,
            "commit": args.commit,
            "files": ["test/functional/test_framework/psbt.py", "test/functional/test_framework/messages.py"],
            "generator": "packages/protocol/scripts/gen-psbt-fixtures.py",
        },
        "psbtHex": h(psbt_bytes),
        "unsignedTx": {
            "hex": h(tx.serialize()),
            "version": tx.version,
            "locktime": tx.nLockTime,
            "inputs": [
                {"txid": h(ser_uint256(i.prevout.hash)), "vout": i.prevout.n, "sequence": i.nSequence}
                for i in tx.vin
            ],
            "outputs": [{"valueSats": str(o.nValue), "scriptPubKey": h(o.scriptPubKey)} for o in tx.vout],
        },
        "expected": {
            "version": 2,
            "locktime": 0,
            "inputCount": 2,
            "outputCount": 1,
            "fee": str(spent0.nValue + spent1.nValue - tx.vout[0].nValue),
            "inputs": [
                {
                    "witnessValue": str(spent0.nValue),
                    "leafScripts": 1,
                    "scriptSigs": 1,
                    "merkleRoot": h(leafhash0),
                    "scriptSigPubkey": h(pk0),
                    "scriptSigLeafHash": h(leafhash0),
                    "finalized": False,
                },
                {
                    "witnessValue": str(spent1.nValue),
                    "leafScripts": 0,
                    "scriptSigs": 0,
                    "finalized": True,
                },
            ],
        },
    }
    # sanity: framework can round-trip its own bytes
    from test_framework.messages import from_binary  # noqa: E402
    assert from_binary(PSBT, psbt_bytes).serialize() == psbt_bytes
    out_path = write_fixture(args.out, out)
    print(f"wrote {out_path} ({len(psbt_bytes)} PSBT bytes); framework self-round-trip OK")


if __name__ == "__main__":
    main()

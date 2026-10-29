#!/usr/bin/env python3
# Portions of this file (p2mr_msg) are adapted from Bitcoin Core's
# TaprootSignatureMsg (test/functional/test_framework/script.py) and
# SignatureHashSchnorr (src/script/interpreter.cpp).
# Copyright (c) The Bitcoin Core developers
# Distributed under the MIT software license, see
# https://opensource.org/licenses/mit-license.php.
"""Generate byte-exact P2MR sighash fixtures from qbit's own test framework.

Provenance: Qbit-Org/qbit @ 7ebcddb622d6e639041f005a189b048ec2a221fe (v1.0.0),
test/functional/test_framework and src/test/data/bip341_wallet_vectors.json
(Core-committed BIP341 vectors).

Usage:
    python3 -I gen-sighash-fixtures.py --qbit /path/to/qbit/checkout \
        --out ../fixtures/p2mr-sighash.json \
        [--repository Qbit-Org/qbit] [--commit <40-hex commit, default: v1.0.0's>]

The --qbit checkout must be at --commit and its origin remote must be
--repository on GitHub. The framework and the BIP341 vectors are read from a
`git archive` export of --commit, never from the working tree, and the fixture
is written only after every self-check passes.
Extracting the export needs tarfile's "data" filter: Python 3.12+, or
3.9.17+, 3.10.12+ or 3.11.4+.

Integrity chain (asserted at generation time):
  A) The framework's TaprootSignatureHash reproduces Core's committed
     bip341_wallet_vectors.json key-path sigHash AND the five intermediary
     midstates  => the framework machinery matches consensus.
  B) Our p2mr_msg(leaf_tag="TapLeaf") is byte-identical to the framework's
     TaprootSignatureMsg(scriptpath=True)  => our message copy is faithful,
     including the script-path tail.
  Therefore p2mr_msg(leaf_tag="P2MRLeaf") hashed under tag "P2MRSighash" is the
  correct P2MR sighash: P2MR differs from Tapscript only by the sighash tag and
  the leaf-hash tag (verified in interpreter.cpp SignatureHashSchnorrCommon).
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

OP_CHECKSIGPQC = 0xB3
P2MR_LEAF_VERSION_V1 = 0xC0
HASH_TYPES = [0x00, 0x01, 0x02, 0x03, 0x81, 0x82, 0x83]

DEFAULT_REPOSITORY = "Qbit-Org/qbit"
# Qbit-Org/qbit v1.0.0, the Core release the committed fixtures come from.
DEFAULT_COMMIT = "7ebcddb622d6e639041f005a189b048ec2a221fe"
# What the generator reads from --commit.
CORE_PATHS = ["test/functional/test_framework", "src/test/data/bip341_wallet_vectors.json"]
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
    from test_framework.script import (  # noqa: E402
        TaprootSignatureMsg,
        TaprootSignatureHash,
        TaggedHash,
        sha256,
        ser_string,
        BIP341_sha_prevouts,
        BIP341_sha_amounts,
        BIP341_sha_scriptpubkeys,
        BIP341_sha_sequences,
        BIP341_sha_outputs,
        LEAF_VERSION_TAPSCRIPT,
        SIGHASH_ALL,
        SIGHASH_SINGLE,
        SIGHASH_ANYONECANPAY,
    )
    from test_framework.messages import (  # noqa: E402
        CTransaction,
        CTxIn,
        CTxOut,
        COutPoint,
        MAX_MONEY,
        ser_uint256,
        tx_from_hex,
    )

    # --- our P2MR message: a copy of TaprootSignatureMsg with the script path
    #     forced (ext_flag=1) and the leaf-hash tag parameterized ---
    def p2mr_msg(tx, spent, hash_type, idx, leaf_script, leaf_ver, leaf_tag,
                 codeseparator_pos=-1, annex=None):
        out_type = SIGHASH_ALL if hash_type == 0 else hash_type & 3
        in_type = hash_type & SIGHASH_ANYONECANPAY
        spk = spent[idx].scriptPubKey
        ss = bytes([0, hash_type])
        ss += tx.version.to_bytes(4, "little")
        ss += tx.nLockTime.to_bytes(4, "little")
        if in_type != SIGHASH_ANYONECANPAY:
            ss += BIP341_sha_prevouts(tx)
            ss += BIP341_sha_amounts(spent)
            ss += BIP341_sha_scriptpubkeys(spent)
            ss += BIP341_sha_sequences(tx)
        if out_type == SIGHASH_ALL:
            ss += BIP341_sha_outputs(tx)
        spend_type = 2  # (ext_flag=1 << 1)
        if annex is not None:
            spend_type |= 1
        ss += bytes([spend_type])
        if in_type == SIGHASH_ANYONECANPAY:
            ss += tx.vin[idx].prevout.serialize()
            ss += spent[idx].nValue.to_bytes(8, "little", signed=True)
            ss += ser_string(spk)
            ss += tx.vin[idx].nSequence.to_bytes(4, "little")
        else:
            ss += idx.to_bytes(4, "little")
        if annex is not None:
            ss += sha256(ser_string(annex))
        if out_type == SIGHASH_SINGLE:
            if idx < len(tx.vout):
                ss += sha256(tx.vout[idx].serialize())
            else:
                ss += bytes(32)
        ss += TaggedHash(leaf_tag, bytes([leaf_ver]) + ser_string(leaf_script))
        ss += bytes([0])  # key_version
        ss += codeseparator_pos.to_bytes(4, "little", signed=True)
        return ss

    def p2mr_sighash(*a, **k):
        return TaggedHash("P2MRSighash", p2mr_msg(*a, **k))

    h = lambda b: b.hex()

    # ============ Self-check A: framework vs Core bip341 vectors ============
    vec_path = os.path.join(root, "src", "test", "data", "bip341_wallet_vectors.json")
    with open(vec_path) as fh:
        bip341 = json.load(fh)
    kp = bip341["keyPathSpending"][0]
    tx = tx_from_hex(kp["given"]["rawUnsignedTx"])
    spent = [
        CTxOut(int(u["amountSats"]), bytes.fromhex(u["scriptPubKey"]))
        for u in kp["given"]["utxosSpent"]
    ]
    inter = kp["intermediary"]
    assert h(BIP341_sha_prevouts(tx)) == inter["hashPrevouts"], "hashPrevouts"
    assert h(BIP341_sha_amounts(spent)) == inter["hashAmounts"], "hashAmounts"
    assert h(BIP341_sha_scriptpubkeys(spent)) == inter["hashScriptPubkeys"], "hashScriptPubkeys"
    assert h(BIP341_sha_sequences(tx)) == inter["hashSequences"], "hashSequences"
    assert h(BIP341_sha_outputs(tx)) == inter["hashOutputs"], "hashOutputs"

    bip341_cases = []
    for isp in kp["inputSpending"]:
        idx = isp["given"]["txinIndex"]
        ht = isp["given"]["hashType"]
        got = TaprootSignatureHash(tx, spent, ht, input_index=idx, scriptpath=False)
        assert h(got) == isp["intermediary"]["sigHash"], f"sigHash idx={idx} ht={ht}"
        bip341_cases.append({"inputIndex": idx, "hashType": ht, "sigHash": isp["intermediary"]["sigHash"]})
    print(f"[A] framework matches Core bip341: 5 midstates + {len(bip341_cases)} sigHashes OK")

    bip341_fixture = {
        "version": tx.version,
        "locktime": tx.nLockTime,
        "inputs": [
            {"txid": h(ser_uint256(i.prevout.hash)), "vout": i.prevout.n, "sequence": i.nSequence}
            for i in tx.vin
        ],
        "outputs": [{"valueSats": str(o.nValue), "scriptPubKey": h(o.scriptPubKey)} for o in tx.vout],
        "spentOutputs": [{"valueSats": str(s.nValue), "scriptPubKey": h(s.scriptPubKey)} for s in spent],
        "midstates": {
            "prevouts": inter["hashPrevouts"],
            "amounts": inter["hashAmounts"],
            "scriptPubKeys": inter["hashScriptPubkeys"],
            "sequences": inter["hashSequences"],
            "outputs": inter["hashOutputs"],
        },
        "cases": bip341_cases,
    }

    # ============ helpers to build deterministic P2MR test txs ============
    def leaf_for(pk32):
        leaf_script = bytes([0x20]) + pk32 + bytes([OP_CHECKSIGPQC])
        leaf_hash = TaggedHash("P2MRLeaf", bytes([P2MR_LEAF_VERSION_V1]) + ser_string(leaf_script))
        spk = bytes([0x52, 0x20]) + leaf_hash  # OP_2 push32 root
        return leaf_script, leaf_hash, spk

    def outpoint(seed):
        op = COutPoint()
        op.hash = int.from_bytes(bytes((seed + i) & 0xFF for i in range(32)), "little")
        op.n = seed & 3
        return op

    pk_a = bytes((i * 7 + 1) & 0xFF for i in range(32))
    pk_b = bytes((i * 5 + 9) & 0xFF for i in range(32))
    leaf_script_a, leaf_hash_a, spk_a = leaf_for(pk_a)
    leaf_script_b, leaf_hash_b, spk_b = leaf_for(pk_b)
    out_spk1 = bytes([0x52, 0x20]) + bytes((i ^ 0x5A) & 0xFF for i in range(32))
    out_spk2 = bytes([0x52, 0x20]) + bytes((i ^ 0x33) & 0xFF for i in range(32))

    # tx1: single input, two outputs
    tx1 = CTransaction()
    tx1.version = 2
    tx1.nLockTime = 0
    tx1.vin = [CTxIn(outpoint(1), b"", 0xFFFFFFFD)]
    tx1.vout = [CTxOut(50_000, out_spk1), CTxOut(49_000, out_spk2)]
    spent1 = [CTxOut(100_000, spk_a)]
    leaf1 = [(leaf_script_a, leaf_hash_a, pk_a)]

    # tx2: two inputs, two outputs
    tx2 = CTransaction()
    tx2.version = 2
    tx2.nLockTime = 21
    tx2.vin = [CTxIn(outpoint(7), b"", 0xFFFFFFFE), CTxIn(outpoint(40), b"", 0xFFFFFFFF)]
    tx2.vout = [CTxOut(70_000, out_spk1), CTxOut(80_000, out_spk2)]
    spent2 = [CTxOut(90_000, spk_a), CTxOut(95_000, spk_b)]
    leaf2 = [(leaf_script_a, leaf_hash_a, pk_a), (leaf_script_b, leaf_hash_b, pk_b)]

    # tx3: field extremes. version, nLockTime, one nSequence and one prevout
    # index are the uint32 maximum, and the other nSequence is 0. Every amount
    # is above 2^53, past which JavaScript numbers are not exact: the odd ones
    # have no double, and one spent output is qbit's MAX_MONEY (210,000,000 QBT).
    tx3 = CTransaction()
    tx3.version = 0xFFFFFFFF
    tx3.nLockTime = 0xFFFFFFFF
    extreme_prevout = outpoint(90)
    extreme_prevout.n = 0xFFFFFFFF
    tx3.vin = [CTxIn(outpoint(60), b"", 0), CTxIn(extreme_prevout, b"", 0xFFFFFFFF)]
    tx3.vout = [CTxOut(2**53 + 1, out_spk1), CTxOut(2**53 + 3, out_spk2)]
    spent3 = [CTxOut(MAX_MONEY, spk_a), CTxOut(2**53 + 5, spk_b)]
    leaf3 = leaf2

    txs = [
        ("single-input", tx1, spent1, leaf1),
        ("two-input", tx2, spent2, leaf2),
        ("field-extremes", tx3, spent3, leaf3),
    ]

    # --- Self-check B: our copy (TapLeaf) == framework TaprootSignatureMsg ---
    checkB = 0
    for _, tx_, spent_, leaves in txs:
        for idx in range(len(tx_.vin)):
            ls, _, _ = leaves[idx]
            for ht in HASH_TYPES:
                ours = p2mr_msg(tx_, spent_, ht, idx, ls, LEAF_VERSION_TAPSCRIPT, "TapLeaf")
                ref = TaprootSignatureMsg(
                    tx_, spent_, ht, input_index=idx, scriptpath=True,
                    leaf_script=ls, leaf_ver=LEAF_VERSION_TAPSCRIPT,
                )
                assert ours == ref, f"copy mismatch idx={idx} ht={ht}"
                checkB += 1
    print(f"[B] our message copy matches framework TaprootSignatureMsg: {checkB} cases OK")

    # ============ emit genuine P2MR-tag vectors ============
    p2mr_vectors = []
    for label, tx_, spent_, leaves in txs:
        fixture_tx = {
            "version": tx_.version,
            "locktime": tx_.nLockTime,
            "inputs": [
                {"txid": h(ser_uint256(i.prevout.hash)), "vout": i.prevout.n, "sequence": i.nSequence}
                for i in tx_.vin
            ],
            "outputs": [{"valueSats": str(o.nValue), "scriptPubKey": h(o.scriptPubKey)} for o in tx_.vout],
            "spentOutputs": [{"valueSats": str(s.nValue), "scriptPubKey": h(s.scriptPubKey)} for s in spent_],
        }
        for idx in range(len(tx_.vin)):
            ls, lh, pk = leaves[idx]
            for ht in HASH_TYPES:
                # SINGLE requires a matching output index
                if (ht & 3) == SIGHASH_SINGLE and idx >= len(tx_.vout):
                    continue
                digest = p2mr_sighash(tx_, spent_, ht, idx, ls, P2MR_LEAF_VERSION_V1, "P2MRLeaf")
                p2mr_vectors.append({
                    "label": f"{label}#{idx}",
                    "tx": fixture_tx,
                    "inputIndex": idx,
                    "hashType": ht,
                    "leaf": {
                        "pubkey": h(pk),
                        "leafScript": h(ls),
                        "leafVersion": P2MR_LEAF_VERSION_V1,
                        "leafHash": h(lh),
                    },
                    "sigHash": h(digest),
                })
    print(f"[P2MR] emitted {len(p2mr_vectors)} P2MR-tag vectors")

    out = {
        "schemaVersion": 1,
        "name": "qbit-p2mr-sighash",
        "tag": "P2MRSighash",
        "source": {
            "repository": args.repository,
            "commit": args.commit,
            "files": [
                "src/script/interpreter.cpp",
                "test/functional/test_framework/script.py",
                "src/test/data/bip341_wallet_vectors.json",
            ],
            "generator": "packages/protocol/scripts/gen-sighash-fixtures.py",
            "integrity": "Self-checked: framework==Core (bip341 key-path), our copy==framework (script path).",
        },
        "bip341KeyPath": bip341_fixture,
        "p2mr": p2mr_vectors,
    }
    out_path = write_fixture(args.out, out)
    print(f"wrote {out_path}")


if __name__ == "__main__":
    main()

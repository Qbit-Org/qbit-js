"""Check per-input P2MR digests of signed PSBT fixtures with the pinned Core test framework."""

import json
import sys
from pathlib import Path

from test_framework.messages import CTxOut, from_binary, ser_string
from test_framework.psbt import PSBT
from test_framework.script import TaggedHash, TaprootSignatureMsg


def signed_input_digest(psbt, spent, index):
    records = psbt.i[index].map
    # These captured inputs have one native partial signature. Match its leaf
    # hash so a recovery path or additional leaf record cannot affect the result.
    (signature_key,) = [key for key in records if isinstance(key, bytes) and key[0] == 0x19]
    for key, value in records.items():
        if not isinstance(key, bytes) or key[0] != 0x1D:
            continue
        script, version = value[:-1], value[-1:]
        leaf = TaggedHash("P2MRLeaf", version + ser_string(script))
        if leaf != signature_key[33:]:
            continue
        hash_type = int.from_bytes(records.get(3, bytes(4)), "little")
        msg = TaprootSignatureMsg(psbt.tx, spent, hash_type, index, scriptpath=True,
                                  leaf_script=script, leaf_ver=version[0])
        # Core's BIP341 script-path message ends in leaf hash, key version
        # and code-separator position. P2MR uses its own leaf and sighash tags.
        return TaggedHash("P2MRSighash", msg[:-37] + leaf + msg[-5:]).hex()
    raise ValueError(f"input {index} lacks the leaf used by its signature")


def check_fixture(path):
    fixture = json.loads(path.read_text())
    for field, expected in fixture.get("coreInputDigests", {}).items():
        psbt = from_binary(PSBT, bytes.fromhex(fixture[field]))
        spent = [from_binary(CTxOut, inp.map[1]) for inp in psbt.i]
        actual = [signed_input_digest(psbt, spent, i) for i in range(len(spent))]
        if actual != expected:
            raise ValueError(f"{path.name} {field}: expected {expected}, got {actual}")
        print(f"{path.name} {field}: {len(actual)} Core input digest(s) match")


if __name__ == "__main__":
    for filename in sys.argv[1:]:
        check_fixture(Path(filename))

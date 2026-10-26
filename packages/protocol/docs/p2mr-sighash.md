# P2MR Signature Hash (`P2MRSighash`)

Byte-exact specification of the message committed by a qbit P2MR signature.
This is the external-integrator reference; a single wrong byte signs an invalid
— or worse, replayable — transaction.

**Source of truth:** `Qbit-Org/qbit` `v1.0.0`
(`7ebcddb622d6e639041f005a189b048ec2a221fe`), `src/script/interpreter.cpp`:

- `HASHER_P2MR_SIGHASH{TaggedHash("P2MRSighash")}` — `interpreter.cpp:1662`,
  declared `interpreter.h:260`.
- `SignatureHashP2MR(...)` — `interpreter.cpp:1810`, delegates to the shared
  `SignatureHashSchnorrCommon(..., SigVersion::P2MR, HASHER_P2MR_SIGHASH)` —
  `interpreter.cpp:1709`.
- Precomputed midstates: `PrecomputedTransactionData::Init` and the
  `GetPrevoutsSHA256` / `GetSpentAmountsSHA256` / `GetSpentScriptsSHA256` /
  `GetSequencesSHA256` / `GetOutputsSHA256` helpers — `interpreter.cpp:1510`+
  (helpers), `interpreter.cpp:1584` (`Init`).
- Cross-checked against qbit's Python test framework
  `test/functional/test_framework/script.py` (`TaprootSignatureMsg`, `:835`).

P2MR reuses **the exact Tapscript message construction** (`ext_flag = 1`,
`key_version = 0`); the only differences from BIP341 Tapscript are the hash
**tag** (`P2MRSighash` vs `TapSighash`) and that the committed leaf hash is a
**P2MR** leaf hash (tag `P2MRLeaf`), not a `TapLeaf` hash.

## Tagged hash

The digest is a **single** SHA-256 over the tagged midstate followed by the
message:

```
tag_hash = SHA256("P2MRSighash")                     # ASCII, no NUL
sighash  = SHA256( tag_hash || tag_hash || message )
```

(There is no second/double SHA-256 of the message — this is the BIP340 tagged
hash construction.)

## Witness signature item

A P2MR witness signature stack item is:

```
signature : 3680 bytes (SLH-DSA-SHA2-128s-bounded30)
hash_type : 1 byte, OPTIONAL
```

- If the `hash_type` byte is **absent**, the hash type is `SIGHASH_DEFAULT`
  (`0x00`), which commits outputs as `SIGHASH_ALL` while the committed
  `hash_type` byte (field 2 below) remains `0x00`.
- If present, the byte **must not** be `0x00` and must be one of the accepted
  values below. (The pre-launch algorithm-id byte was **removed**; the
  message commits nothing algorithm-shaped.)

Accepted `hash_type` values (`SIGHASH_OUTPUT_MASK = 0x03`,
`SIGHASH_INPUT_MASK = SIGHASH_ANYONECANPAY = 0x80`):

| Value | Meaning | In witness item |
|---|---|---|
| `0x00` | `DEFAULT` (≡ `ALL`) | only as the absent byte |
| `0x01` | `ALL` | explicit |
| `0x02` | `NONE` | explicit |
| `0x03` | `SINGLE` | explicit |
| `0x81` | `ALL` + `ANYONECANPAY` | explicit |
| `0x82` | `NONE` + `ANYONECANPAY` | explicit |
| `0x83` | `SINGLE` + `ANYONECANPAY` | explicit |

Any other byte is invalid (`SignatureHashSchnorrCommon` returns failure for
`hash_type` outside `{0x00..0x03, 0x81..0x83}`).

## Committed message

`output_type = (hash_type == 0x00) ? ALL : (hash_type & 0x03)`;
`input_type = hash_type & 0x80`.

All integers are little-endian. "Var-bytes" = `compactSize(len) || bytes`
(qbit Core `CScript` / `ser_string`). All sub-hashes are a **single** SHA-256.

| # | Field | Size | Included when |
|---|---|---|---|
| 1 | epoch `0x00` | 1 | always |
| 2 | `hash_type` | 1 | always |
| 3 | tx version (uint32 LE) | 4 | always |
| 4 | tx locktime (uint32 LE) | 4 | always |
| 5 | `sha_prevouts` | 32 | `input_type != ANYONECANPAY` |
| 6 | `sha_amounts` | 32 | `input_type != ANYONECANPAY` |
| 7 | `sha_scriptpubkeys` | 32 | `input_type != ANYONECANPAY` |
| 8 | `sha_sequences` | 32 | `input_type != ANYONECANPAY` |
| 9 | `sha_outputs` | 32 | `output_type == ALL` |
| 10 | `spend_type = (ext_flag<<1) + annex_present` | 1 | always; P2MR `ext_flag = 1` |
| 11a | this input's outpoint (32 txid LE + 4 index LE) | 36 | `input_type == ANYONECANPAY` |
| 11b | this input's spent output (int64 amount LE + var-bytes scriptPubKey) | var | `input_type == ANYONECANPAY` |
| 11c | this input's nSequence (uint32 LE) | 4 | `input_type == ANYONECANPAY` |
| 11d | input index (uint32 LE) | 4 | `input_type != ANYONECANPAY` |
| 12 | `SHA256(ser_string(annex))` | 32 | annex present |
| 13 | `SHA256(serialized output[input_index])` | 32 | `output_type == SINGLE` |
| 14 | P2MR leaf hash (`TaggedHash("P2MRLeaf", …)`) | 32 | always (P2MR) |
| 15 | `key_version = 0x00` | 1 | always (P2MR) |
| 16 | code-separator position (uint32 LE, default `0xffffffff`) | 4 | always (P2MR) |

`SINGLE` with `input_index >= len(outputs)` is a failure (Core returns false);
callers must ensure a matching output exists.

### Precomputed midstates (`PrecomputedTransactionData` equivalent)

Computed once per transaction and reused across inputs:

```
sha_prevouts      = SHA256( for each input:  outpoint (32 txid LE || 4 index LE) )
sha_amounts       = SHA256( for each spent output:  int64 LE amount )
sha_scriptpubkeys = SHA256( for each spent output:  var-bytes scriptPubKey )
sha_sequences     = SHA256( for each input:  uint32 LE nSequence )
sha_outputs       = SHA256( for each output: int64 LE amount || var-bytes scriptPubKey )
```

### Message length

For the common P2MR case (non-`ANYONECANPAY`, `ALL`, no annex) the message is
**212 bytes**: `175` base + `37` script-path tail. General formula (matches
`TaprootSignatureMsg`'s internal assertion):

```
len = 175
      - 49 * (input_type == ANYONECANPAY)
      - 32 * (output_type not in {ALL, SINGLE})
      + 32 * (annex present)
      + 37 * (script-path; always for P2MR)
```

## Implementation

`@qbit-oss/protocol` exposes:

- `precomputeSighashMidstates(tx, spentOutputs)` → the five midstates above.
- `p2mrSighash({ tx, inputIndex, spentOutputs, leafHash, hashType?, codeSeparatorPos?, annex? })`
  → 32-byte digest (`hashType` defaults to `SIGHASH_DEFAULT`).
- `schnorrSignatureHash({ ..., sigVersion })` — the shared engine, also usable
  for `'taproot'`/`'tapscript'` (BIP341), which is how the implementation is
  validated byte-exactly against Core's committed `bip341_wallet_vectors.json`.
- `encodeP2mrWitnessSignature` / `decodeP2mrWitnessSignature` — the witness
  sig-item codec with the default-type rules above.
- `signP2mrPsbt` / `validateP2mrSigningPlans` — only sign `SIGHASH_DEFAULT`
  unless `allowNonDefaultSighash: true` is passed; a plan's `hashType` must
  equal the input's `PSBT_IN_SIGHASH_TYPE` (0x03, 4-byte LE uint32) when present
  and the type of every existing P2MR signature on that input (Core's
  `SIGHASH_MISMATCH`); a non-default type is written back to
  `PSBT_IN_SIGHASH_TYPE`, as Core does, so later signers must agree. The `sign`
  callback receives `{ hashType, tx, spentOutputs }` alongside the digest.
- `finalizeP2mrPsbt` — mirrors Core's `FinalizePSBT` (`src/psbt.cpp:697`),
  which re-runs `SignPSBTInput` with the input's `sighash_type`: an absent
  `PSBT_IN_SIGHASH_TYPE` means `SIGHASH_DEFAULT` for P2MR (`psbt.cpp:530`), and
  an existing P2MR signature of any other type fails with `SIGHASH_MISMATCH`
  (`psbt.cpp:548-568`; `589-596` when the field is present and differs). The
  library throws `INVALID_SIGHASH` in both cases. A non-default signature from
  a signer that omitted the field needs a matching `PSBT_IN_SIGHASH_TYPE`
  record (Core's signer writes it, `psbt.cpp:542-545`) before Core or this
  library will finalize it.

Every uint32 field (`version`, `locktime`, `vout`, `sequence`,
`codeSeparatorPos`), the uint8 `keyVersion`, every amount, every prevout
txid, and every output and spent-output `scriptPubKey` is checked up front,
before anything is hashed and regardless of caller-supplied cached midstates:
non-integer, non-finite or out-of-range integers throw `INVALID_INTEGER`,
amounts outside qbit Core's `MoneyRange` (`0 ≤ v ≤ QBIT_MAX_MONEY`) throw
`INVALID_AMOUNT`, and a txid that is not a 32-byte `Uint8Array` or a script
that is not a `Uint8Array` throws `INVALID_BYTES`. The cached midstates
themselves must each be a 32-byte `Uint8Array` and the `annex` a
`Uint8Array` (`INVALID_BYTES`), and `leafHash` a 32-byte `Uint8Array`
(`INVALID_SIGHASH`), so a hex string is never hashed as different bytes. Nothing is wrapped modulo
2^8 / 2^32 / 2^64, so the digest always commits to exactly the fields the
caller supplied.

`version` is unsigned because qbit Core's is: `CTransaction::version` and
`CMutableTransaction::version` are `uint32_t` (`primitives/transaction.h:308`,
`:381`; serialized by `s << tx.version`, `:260`), inherited from Bitcoin Core
28.0 (bitcoin/bitcoin#29325). `createrawtransaction` / `createpsbt` take the
version as `uint32_t` and `decoderawtransaction` / `decodepsbt` report it
unsigned, so the pre-28 `int32` idiom `-1` is spelled `0xffffffff`
(`4294967295`) here and parses back as `4294967295`. A negative `version`
throws `INVALID_INTEGER` instead of being two's-complement wrapped, so one wire
value has exactly one JS spelling.

`txid` bytes are in **serialization (internal) order** — the reverse of the
big-endian txid shown by explorers/RPC.

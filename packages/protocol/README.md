# @qbit-oss/protocol

qbit protocol primitives for wallet integration across Qbit mainnet, Testnet4,
signet, and regtest:

- network parameters for qbit mainnet, testnet4, signet, and regtest
- strict P2MR bech32m address encode/decode (printable ASCII only, 90-character
  limit, and no mixed case, matching qbit Core's `bech32::Decode`)
- P2MR single-key leaf scripts, merkle roots, control blocks, and scriptPubKeys
- structured P2MR wallet message proofs (`createP2mrMessageProof`,
  `verifyP2mrMessageProof`). `verifyP2mrMessageProof(message, proof, verifyPqc,
  options)` requires `options` with `{ expectedAddress }` and/or
  `{ expectedNetwork }`; the three-argument form was removed, and missing,
  non-object or empty `options` throws `TypeError`. `proof.address` is
  attacker-controlled and the same Merkle root encodes to a different string on
  each network except signet and Testnet4, which share the `tq` prefix (so
  `expectedNetwork` cannot tell those two apart; pass `expectedAddress` to pin
  an exact address). Never trust `proof.address` on its own. Only the canonical
  lowercase spelling verifies: an uppercase `proof.address` returns `false`, so
  re-create such a proof with `createP2mrMessageProof`.
- `qbit:` payment URI parse/format helpers
- qbit Core descriptor checksum helpers
- P2MR descriptor parse/serialize helpers for `rawmr(...)`, literal `mr(pk(...))`,
  `mr(multi_a(...))`, `mr(sortedmulti_a(...))`, Core-style binary script trees,
  and parse-only `mr(pk(pqc(...)))`
- qbit Core `importdescriptors` JSON entry formatting for receive/change P2MR descriptors
- P2MR witness signature item and PSBT input-field codecs for qbit's `0x19`,
  `0x1d`, and `qbit` proprietary P2MR fields
- qbit-aware PSBT creation, inspection, combination, signing, finalization, and
  transaction extraction, including side-effect-free `validateP2mrSigningPlans`
  preflight for stateful signers
- consensus range checks: amounts must satisfy qbit Core `MoneyRange`
  (`0 ≤ value ≤ QBIT_MAX_MONEY`), `version`/`locktime`/`vout`/`sequence`/
  `codeSeparatorPos` must be uint32 (`version` included: qbit Core's
  `CTransaction::version` is `uint32_t`, so a legacy int32 `-1` is
  `0xffffffff`) and `keyVersion` must be uint8; out-of-range values throw
  `QbitProtocolError` (`INVALID_AMOUNT` / `INVALID_INTEGER`) instead of being
  serialized and signed modulo 2^64 / 2^32 / 2^8 (`assertMoneyRange`,
  `assertUint32`)
- crash-safe P2MR signing for stateful signers: `signP2mrPsbt` reports each
  signature through the synchronous `onSigned` callback as soon as it is
  stored, and a failed signer call or callback throws `P2mrPsbtSigningError`
  carrying the partially signed PSBT, the plans signed so far, and the `phase`
  (`'sign'`: nothing stored for the failed plan; `'onSigned'`: its signature is
  already stored), so a retry passes that PSBT back in with only the unsigned
  plans; `sign` and `onSigned` must both be synchronous, and one that returns
  a promise fails its plan the same way (the promise is never left unhandled);
  a signature `Uint8Array` from another realm (vm, iframe, worker) is accepted
- error classification across builds: `QbitProtocolError.is(error)` and
  `P2mrPsbtSigningError.is(error)` recognize those errors from any copy of this
  package. Use them instead of `instanceof` where the app can load both the
  CommonJS and the ESM build, or two versions: each copy has its own classes,
  and `instanceof` is false for an error from the other one. They check the
  `Symbol.for('qbit-js.QbitProtocolError')` and
  `Symbol.for('qbit-js.P2mrPsbtSigningError')` brands on the class prototypes.
  Any code can set a brand, so they classify errors, they do not authenticate
  them. An error from another version can carry a `code` this one does not
  list, so keep a default branch
- qbit Core's restricted-output consensus rule
  (`src/consensus/restricted_outputs.h` @ v1.0.0), on for every network
  including default regtest: `isRestrictedOutputModeOutput(scriptPubKey,
  { reservedWitnessActive })` mirrors it, and `createP2mrPsbt`,
  `validateP2mrSigningPlans` and `signP2mrPsbt` throw `INVALID_SCRIPT` before
  any signer call for an output that is not P2MR, `OP_RETURN` or P2A, which
  Core rejects with `tx-output-not-p2mr`. They refuse witness v3..v16 outputs
  too, which Core's consensus allows on mainnet, testnet4 and signet but no
  default node relays. Pass `restrictedOutputMode: false` only for a regtest
  node run with `-p2mronly=0`. Relay policy (`OP_RETURN` push-only data,
  `-datacarriersize`, dust) is not checked
- sighash-type guardrails on the signing path: `signP2mrPsbt` /
  `validateP2mrSigningPlans` accept only `SIGHASH_DEFAULT` unless the caller
  passes `allowNonDefaultSighash: true`, enforce the input's
  `PSBT_IN_SIGHASH_TYPE` field and existing-signature agreement the way qbit
  Core's `SIGHASH_MISMATCH` does, and hand the `sign` callback the `hashType`,
  unsigned `tx` and `spentOutputs` it is committing to
- sighash-type enforcement at finalization: `finalizeP2mrPsbt` throws
  `INVALID_SIGHASH` for a signature whose type differs from the input's
  `PSBT_IN_SIGHASH_TYPE`, or is not `SIGHASH_DEFAULT` when that field is
  absent, exactly as qbit Core's `FinalizePSBT` → `SignPSBTInput` does
  (`src/psbt.cpp:530,548-568,589-596,697` @ v1.0.0)
- signing and finalization agree as they do in qbit Core: `finalizeP2mrPsbt`
  builds Core's witness for a committed v1 `pk` or `multi_a` leaf that has
  enough signatures (the smallest witness when several do), and ignores
  unrelated leaves and signatures (`src/script/sign.cpp:503-631,699-741`). A
  leaf or signature carried as both a standard and a `qbit` proprietary field
  counts once, as `decodePsbt` reports it; two different signatures for one
  (pubkey, leaf hash) throw `INVALID_PSBT`. `validateP2mrSigningPlans` and
  `signP2mrPsbt` refuse the whole call with `INVALID_PSBT`, before any signer
  call, when a plan's leaf is not one finalize can use, when the call plans
  signatures on two or more leaves of one input (a witness reveals one leaf,
  so at least one of them could never be used, even when none completes), or
  when finalize, run over the input's signatures plus this call's, would
  complete a witness that leaves a plan's signature out: another leaf it
  prefers is already complete, or the plan's `multi_a` leaf reaches its
  threshold on keys finalize places first. Finalize places from the last key,
  so for a 1-of-2 `[K1, K2]` leaf with K2 signed a K1 plan is refused, but
  with K1 signed a K2 plan is accepted and finalize uses K2. Core likewise
  signs only the leaf it finalizes, up to its threshold, and with no leaf
  complete only its best partial leaf
  (`src/script/sign.cpp:592-613,729-756`). Plans on one leaf that do not
  complete it pass, so co-signers can sign a `multi_a` leaf in turn; hedging
  across leaves in separate calls is not refused. So once every plan is
  signed, finalize uses each of the call's signatures or still waits for more;
  signatures added later can make it choose another leaf. Neither the
  preflight nor finalize verifies signatures: an invalid signature already on
  the PSBT counts as a valid one. On a leaf finalize prefers it gets the plan refused before a key use is
  spent, but on the leaf finalize uses, including the plan's own `multi_a`
  leaf, it makes finalize produce a transaction that does not verify

PSBT and field-decoding results do not alias caller memory. Parsed PSBTs,
decoded fields, PSBTs returned by sign/combine/finalize, and signing-plan keys
are fresh plain `Uint8Array` copies, including when the input is a Node
`Buffer` (whose `slice` returns a view). Callers may wipe or reuse input
buffers after a call returns.

Byte inputs must be `Uint8Array`s: every fixed-length one (pubkeys,
signatures, leaf hashes, merkle roots and siblings, outpoint txids, address
programs, the five cached sighash `midstates`), the leaf scripts and control
blocks given to the builders and encoders, output, witness-UTXO and
spent-output scripts, the sighash annex, the map keys and values
`serializePsbt` writes (so a hand-built `Psbt` holding `number[]`s no longer
serializes), the `keyData` of `decodeQbitProprietaryP2mrInputField`, and the
arguments of `outputScriptToAddress`, `decodeP2mrWitnessSignature` and
`decodeP2mrPsbtScriptSigField`. A Node `Buffer`, a subarray, a subclass or a
`Uint8Array` from another realm (vm, iframe, worker) is accepted; a string, a
plain array, another typed array (even one whose `Symbol.toStringTag` claims
`'Uint8Array'`) or a `DataView` throws `QbitProtocolError` `INVALID_BYTES`
even when its `length` is right. The sighash `leafHash` of `p2mrSighash` and
`schnorrSignatureHash` is the exception: it throws `INVALID_SIGHASH`. Wrap a
`number[]` or another typed array with `Uint8Array.from(...)`.

Non-default sighash types (`NONE`, `SINGLE`, and the `ANYONECANPAY` variants)
do not commit to every input and output, so a signature made with one can be
lifted into a transaction the user never saw. Applications must surface the
type (`decodePsbt(...).inputs[i].sighashType` and the signing key's `hashType`)
in their approval flow before opting in with `allowNonDefaultSighash: true`.

This package does not derive seed phrases or private keys. Wallet code should
combine these helpers with a PQC signer and its own key management.

## Untrusted PSBT input

`parsePsbt(bytes, { maxBytes, maxObjects })` and
`extractP2mrTransaction(psbt, { maxBytes, maxObjects })` bound what a hostile
PSBT can make them allocate. The two limits are independent:

- `maxBytes` (default `PSBT_DEFAULT_MAX_BYTES`, 16 MiB, 8x a block-sized qbit
  transaction): `parsePsbt` rejects larger input before parsing it, and
  `extractP2mrTransaction` refuses to build a larger transaction.
- `maxObjects` (default `PSBT_DEFAULT_MAX_OBJECTS`, 131,072): the most PSBT
  map entries, unsigned-transaction inputs and outputs, and final-witness items
  one call decodes, counted together. Each costs about 0.5 KB of heap however
  few bytes encode it (a map entry can take 3 bytes), and key and value bytes
  add to that (see below), so this, not `maxBytes`, bounds the heap a small,
  dense PSBT can claim. A PSBT within `maxBytes` with
  at most `maxObjects` objects is accepted however dense it is: a 9,000-output
  P2MR batch payout (a 396,152-byte unsigned PSBT, 390,777-byte transaction)
  passes with `maxBytes` set to its exact size. A standard transaction (at
  most 400,000 bytes) has fewer than 44,500 inputs and outputs. Raise
  `maxObjects` for a non-standard transaction with more objects than that
  allows, and lower both limits to tighten the memory bound.
- Counts and lengths are checked against the bytes that remain before the
  parser allocates or loops.
- `finalizeP2mrPsbt` and `extractP2mrTransaction` decode final scriptwitness
  (`0x08`) values with qbit Core v1.0.0's P2MR limits, including on `Psbt`
  objects built without `parsePsbt`: at most 1,003 items (a 1,000-item stack,
  leaf script, control block and annex), and for leaf version `0xc0` a stack
  of at most 1,000 items, 16 KiB each and 128 KiB in total
  (`src/script/script.h:43-49`, `src/script/interpreter.cpp:37-47`).

At the defaults, the densest hostile PSBTs measured on Node 24 needed at most
96 MB of V8 heap in `parsePsbt` (131,069 distinct 64-byte keys with 61-byte
values) and 144 MB in `parsePsbt` and then `decodePsbt` (131,069 P2MR leaf
scripts of 63 bytes), as the smallest passing `--max-old-space-size`. The
parsed PSBT retained at most about 70 MB of that, and the `decodePsbt` summary
about 70 MB more. `extractP2mrTransaction` of 130 inputs with 1,003 empty
witness items each completed with `--max-old-space-size=36`. What drives the
heap is `maxObjects` times the cost of each object: about 0.5 KB, plus up to
about 0.25 KB for a map entry's key and value, because V8 keeps byte arrays of
up to 64 bytes on its heap and the duplicate-key check holds the hex of keys of
up to 64 bytes, plus about 0.4 KB for each leaf script `decodePsbt` decodes.
Longer keys are checked by their SHA-256, and longer keys and values live
outside the V8 heap. Parsed fields are copies of the input, so a parsed PSBT
also holds about its encoded size (at most `maxBytes`) in byte buffers outside
the heap.

Unlike qbit Core, `parsePsbt` does not decode `0x08` values yet, so a
malformed final witness is reported by `finalizeP2mrPsbt` or
`extractP2mrTransaction`, not at parse time. All of these failures throw
`QbitProtocolError` with code `INVALID_PSBT`; a `maxBytes` or `maxObjects`
that is not a positive safe integer throws `RangeError`.

# Changelog

Notable changes to `@qbit-oss/protocol` and `@qbit-oss/api`. Both packages share one
version (see [RELEASING.md](RELEASING.md)). Versions follow SemVer. Below 1.0,
breaking changes bump MINOR.

## 0.1.1 (unreleased)

### @qbit-oss/protocol

- `createP2mrPsbt`, `precomputeSighashMidstates`, `validateP2mrSigningPlans`,
  `signP2mrPsbt` and `extractP2mrTransaction` handle transactions with any
  number of inputs and outputs, as do `p2mrSighash` and `schnorrSignatureHash`
  without cached `midstates`. They spread one call argument per input, output
  or witness item, so past about 120,000 of them they threw a bare
  `RangeError` on Node's main thread. A 1-input, 131,000-output PSBT that
  `parsePsbt` accepts at the default limits could not be signed (the signer
  was never called) or extracted, and a 40,000-input PSBT could not be
  extracted. Output bytes and signature hashes are unchanged.
- `decodePsbt`, and so `finalizeP2mrPsbt`, `validateP2mrSigningPlans` and
  `signP2mrPsbt`, checks a PSBT's keys for duplicates by the ids `parsePsbt`
  uses, so a key over 64 bytes is compared by its SHA-256. It built the full
  hex of every key, and V8 hashes a string longer than 16,383 characters by its
  length alone, so 2,000 distinct 8 KiB keys, within the default limits, took
  2.5 to 3.7 s in our measurements instead of about 60 ms, and held twice the
  key bytes in strings on the heap. Results and errors are unchanged.
- `combinePsbts` accepts a map key over 64 bytes, such as a 65-byte script-sig
  key, that is a `Uint8Array` subclass from another realm (vm, iframe,
  worker), for example a `Buffer`, or with `@noble/hashes` before 1.3.3 any
  `Uint8Array` from another realm. It threw a bare `TypeError` from
  `@noble/hashes`, which rejects such arrays.
- Requires `@noble/hashes` `~1.8.0` (was `^1.3.0`) and imports its `sha2`
  entry point instead of the deprecated `sha256` one. A fresh install already
  resolved 1.8.0, and a lockfile that keeps an older 1.x now gets a separate
  1.8.x copy. An `overrides` or `resolutions` entry still forces its version,
  and `@noble/hashes` has no `sha2` entry point before 1.3.3, so this release
  fails to load with an override below 1.3.3. `@noble/hashes` 1.8.0 declares
  `engines` `node: ^14.21.3 || >=16`, where 1.3.0 declared none.

### @qbit-oss/api

- New `@qbit-oss/api/testing` entry point, for tests only: `createMockEsplora`
  returns an offline mock of the qbit-electrs or mempool-qbit backend to pass
  to a client as `fetchFn`. It serves every route `EsploraClient` and
  `MempoolQbitClient` call from a declarative fixture, answers as the chosen
  backend does where they differ (an unknown txid's status is
  `200 {"confirmed":false}` on qbit-electrs and `404` on mempool-qbit), records
  each request, and injects per-route faults: an HTTP status with
  `Retry-After`, a refused connection, a stalled body, and a submission that is
  accepted, rejected with a node code, or accepted with its reply lost. Without
  a fault, a submission gets qbit Core v1.0.0's `sendrawtransaction` verdict,
  with Core's code and message (for a conflict, Core's reason and the start of
  its message, without the feerates or fees Core compared), from the outputs
  the fixture and earlier submissions create and spend, in Core's order: `-22`
  for hex Core cannot decode, `-25` for an unspendable output with a value
  (`maxburnamount`), `-27` for a transaction in a block while one of its
  outputs is unspent, `-26` for a broken `CheckTransaction` rule, `-25` for a
  spend of an output that is not a coin and for a transaction a block spends
  from, which is in the chain, `-26` for a broken `CheckTxInputs`
  rule (an immature coinbase output, input values out of range, outputs worth
  more than the inputs), `-26` for a conflict with a mempool transaction,
  which the mock never takes as a replacement, `-26` for a spend of a mempool
  transaction's unspendable output, which Core's script check refuses, and
  `-25` for a fee above the default `maxfeerate`. It does not model relay
  policy or standardness, fee floors, other scripts or signatures, lock times
  or sequence locks, qbit's P2MR-only output rule, mempool limits or
  replacement. A submission it takes joins the address views, in the mempool
  until `mine()` confirms it; they follow qbit-electrs, which lists the
  mempool oldest first and by default indexes no provably unspendable output,
  such as an `OP_RETURN` one, and matches a qbit bech32 address in lowercase
  or uppercase alike, refusing one in mixed case. A coinbase, in the fixture
  (declared or found from its hex) or taken through a fault, is served with
  its coinbase input. Where a fault makes the node take what qbit Core never
  would, such as a coinbase, a spend of an output it does not know, or a
  transaction a block spends from, the mock places it so that no block spends
  from the mempool. Its options are validated up front:
  `null`, a `Retry-After` that `Headers` refuses, and a fixture qbit Core could
  not hold, such as a spend of an unspendable or immature coinbase output or a
  block with two coinbases, are refused, not taken. It ships in both builds
  with type declarations, and imports nothing from the client at runtime. A
  `testing/package.json` shim points resolvers that ignore `exports` at it:
  TypeScript's `moduleResolution: "node10"` through `types`, and Jest before
  28 (given a test environment with `Response`, `Headers` and
  `ReadableStream`) and Metro without package exports through `main`. Like
  `@qbit-oss/api`, it is built for ES2020, which webpack 4's parser does not
  support. `@qbit-oss/api` itself resolves as before. See
  [Testing](packages/api/docs/testing.md).
- The `unknown_outcome` error message ends "may have been accepted; resubmit
  the same hex, and never rebuild the payment with different inputs" (or
  "resubmit the same hex with its { txid }" when no txid is known) instead of
  "may have been accepted, check its status before resubmitting": qbit-electrs
  reports an unknown txid as unconfirmed, so a status check cannot settle the
  outcome. The error's `kind` and fields are unchanged.
- Requires `@noble/hashes` `~1.8.0` (was `^1.3.0`) and imports its `sha2`
  entry point instead of the deprecated `sha256` one, as `@qbit-oss/protocol`
  does, with the same effect on lockfiles and overrides. `@noble/hashes` 1.8.0
  declares `engines` `node: ^14.21.3 || >=16`, where 1.3.0 declared none.

## 0.1.0 (2026-10-26)

This is the first release line, and nothing has been published before. Changes
are listed against the unpublished `0.0.0` development snapshot of both
packages, which early integrators consumed from git. **Breaking** marks a
change that can make existing caller code fail or behave differently.

### @qbit-oss/protocol

- **Breaking:** PSBT and field-decoding results no longer alias caller memory.
  Byte values are returned as fresh plain `Uint8Array` copies, including when
  the input is a Node `Buffer`. Callers that used `Buffer`-only methods on
  returned fields must wrap them with `Buffer.from(...)`. Serialized bytes are
  unchanged.
- **Breaking:** `signP2mrPsbt` keeps every completed signature when a later
  plan fails. A new optional synchronous `onSigned` callback fires after each
  signature is stored. Failures inside the signing loop throw
  `P2mrPsbtSigningError` (code `SIGNING_FAILED`) carrying `psbt`, `signed`,
  `failed`, `phase` and the original error as `cause`. Signer exceptions no
  longer propagate raw. `sign` and `onSigned` must be synchronous: a returned
  promise fails that plan with `INVALID_SIGNER`. `signed` entries gain
  `leafHash`, and `QbitProtocolErrorCode` gains `SIGNING_FAILED` and
  `INVALID_SIGNER`.
- **Breaking:** bech32 decoding rejects strings longer than 90 characters and
  any character outside printable ASCII before case folding, so look-alike
  spellings (for example U+212A KELVIN SIGN) no longer decode to a real
  address.
- **Breaking:** the P2MR signing path enforces sighash types as qbit Core does.
  `signP2mrPsbt` and `validateP2mrSigningPlans` accept only `SIGHASH_DEFAULT`
  unless `allowNonDefaultSighash: true` is passed. They also enforce the
  input's `PSBT_IN_SIGHASH_TYPE` and refuse mixed types on an input. A
  non-default type is written back to `PSBT_IN_SIGHASH_TYPE`.
  `finalizeP2mrPsbt` rejects a signature whose type differs from that field,
  or from `SIGHASH_DEFAULT` when the field is absent. `decodePsbt` reports
  `sighashType`, and the `sign` callback context (`P2mrPsbtSignContext`) gains
  `hashType`, `tx` and `spentOutputs`. A PSBT signed with a non-default type
  by the `0.0.0` snapshot has no `PSBT_IN_SIGHASH_TYPE` record and will not
  finalize until one is added.
- **Breaking:** PSBT parsing rejects non-canonical CompactSize encodings, reads
  PSBT key types as CompactSize, enforces Core's `MAX_SIZE` (`0x02000000`), and
  checks the key-data shape of qbit P2MR proprietary keys in input maps.
- **Breaking:** amounts must lie within `MoneyRange` (`0..QBIT_MAX_MONEY`).
  `version`, `locktime`, `vout`, `sequence` and `codeSeparatorPos` must be
  uint32, and `keyVersion` must be uint8. Out-of-range values throw
  `INVALID_AMOUNT` or `INVALID_INTEGER` instead of being serialized and signed
  modulo 2^n. `decodePsbt` rejects out-of-range totals and outputs that exceed
  inputs. `createP2mrPsbt` rejects `null` for `version`, `locktime` and
  `sequence`. New exports: `QBIT_MAX_MONEY`, `assertMoneyRange` and
  `assertUint32`.
- **Breaking:** `verifyP2mrMessageProof` requires a fourth `options` argument,
  `{ expectedAddress }` and/or `{ expectedNetwork }` (new exported type
  `VerifyP2mrMessageProofOptions`), and binds the proof to it. The
  three-argument form is removed. A missing, `null`, non-object or empty
  `options` throws `TypeError` instead of verifying. A proof that fails
  verification, or a malformed expectation such as an unknown network, still
  returns `false`. Signet and Testnet4 share the `tq` HRP, so `expectedNetwork`
  cannot tell them apart; pass `expectedAddress` to pin an exact address.
- **Breaking:** `verifyP2mrMessageProof` accepts only the canonical lowercase
  spelling of `proof.address`. A proof whose `address` is uppercase returns
  `false` and must be re-created; `createP2mrMessageProof` now always emits
  the canonical lowercase address.
- **Breaking:** `parsePsbt` and `extractP2mrTransaction` bound what an
  untrusted PSBT can make them allocate, so a small hostile PSBT can no longer
  abort the process with a heap out-of-memory error. Both take
  `{ maxBytes, maxObjects }`. `parsePsbt` rejects input over `maxBytes`
  (default `PSBT_DEFAULT_MAX_BYTES`, 16 MiB) before parsing it, and
  `extractP2mrTransaction` refuses to build a larger transaction. One call
  decodes at most `maxObjects` (default `PSBT_DEFAULT_MAX_OBJECTS`, 131,072)
  map entries, transaction inputs and outputs, and final-witness items;
  `maxObjects` does not scale with `maxBytes`. `finalizeP2mrPsbt` and
  `extractP2mrTransaction` reject a final scriptwitness (`0x08`) with more than
  1,003 items or over qbit Core's P2MR v1 stack limits (1,000 items, 16 KiB
  each, 128 KiB in total), and `finalizeP2mrPsbt` validates an existing `0x08`
  instead of passing it through. These failures throw `INVALID_PSBT`. A limit
  that is not a positive safe integer, including `null`, throws `RangeError`.
  At the defaults, the densest hostile PSBTs measured need at most 96 MB of V8
  heap in `parsePsbt` and 144 MB with `decodePsbt`. `bytesToHex` returns the
  same strings, as flat strings in linear memory. New exports:
  `PsbtLimitOptions`, `PSBT_DEFAULT_MAX_BYTES` and `PSBT_DEFAULT_MAX_OBJECTS`.
- **Breaking:** `qbitWalletMessageHash`, and so `createP2mrMessageProof`,
  throws `INVALID_BYTES` for a message containing a lone UTF-16 surrogate
  instead of hashing it with U+FFFD substituted, so two different strings
  never share a message hash. `verifyP2mrMessageProof` returns `false` for
  such a message.
- **Breaking:** `signP2mrPsbt` and `validateP2mrSigningPlans` sign only
  leaves qbit Core signs: leaf version `0xc0`, and a script that is exactly
  `pk(K)` or a `multi_a` with a minimal threshold of at most 35, containing the
  signing key. Any other leaf throws `INVALID_PSBT` before the signer runs.
  This includes a key pushed inside `OP_PUSHDATA` or non-minimally, extra
  opcodes or `OP_CODESEPARATOR`, other leaf versions, and `multi_a` with
  k > 35.
- **Breaking:** descriptor key paths and `[fingerprint/...]` origins follow
  qbit Core's `ParseKeyPathNum`. `parseP2mrDescriptor` and every helper that
  takes a descriptor string throw `INVALID_DESCRIPTOR` for an `H` hardened
  marker or an index above 2147483647, with Core's error text
  (`Key path value '<v>' is not a valid uint32`,
  `Key path value <n> is out of range`). Hardened wildcards and multipath
  segments are still unsupported and now say so.
- **Breaking:** `formatP2mrImportDescriptors` throws `INVALID_DESCRIPTOR` for
  these requests, which qbit Core v1.0.0 rejects or misapplies: a descriptor
  that isn't a string or has leading or trailing whitespace; a `range` that
  isn't a `[start, end]` pair or covers more than 1,000,000 indices; a timestamp
  other than `'now'` or a non-negative safe integer; external and internal
  descriptors that are textually identical once checksums are removed; and
  `pqc()` keys that no single network decodes. It doesn't check `pqc()` keys
  given as extended public keys, keys for a network other than the node's, or
  wallet state. `docs/p2mr-descriptor-support.md` lists the supported forms.
- **Breaking:** P2MR `multi_a` / `sortedmulti_a` thresholds above 35 are
  refused where they would make coins unspendable, as qbit Core does.
  `multiALeafScript` throws a `RangeError` for `k > 35`.
  `p2mrRootFromDescriptor` and `p2mrAddressFromDescriptor` throw
  `INVALID_DESCRIPTOR` for an `mr()` descriptor whose every leaf needs more than
  35 signatures. A tree with a spendable leaf still gets Core's address, and
  parsing still accepts `k` up to 999. New exports:
  `P2MR_V1_MAX_MULTI_A_THRESHOLD` (35) and `hasP2mrStandardSatisfaction`.
- **Breaking:** descriptor objects passed to `serializeP2mrDescriptor`,
  `p2mrRootFromDescriptor`, `p2mrAddressFromDescriptor` and
  `hasP2mrStandardSatisfaction` get the checks `parseP2mrDescriptor` applies to
  strings, and throw `INVALID_DESCRIPTOR` if they fail.
  - Some objects that were serialized or hashed as given are now rejected: a
    threshold of 0, a 31-byte `rawmr` root, an unknown `type`, a tree deeper
    than 128, or keys given as `number[]`.
  - Other bad input threw a `TypeError`, a `RangeError` or `INVALID_BYTES`, and
    now throws `INVALID_DESCRIPTOR`. This covers `null`, non-objects,
    wrong-length keys, and very deep or cyclic trees.
  - Node `Buffer`s and bytes from another realm are still accepted.
- **Breaking:** `finalizeP2mrPsbt` keeps the input fields qbit Core keeps on a
  finalized input: the non-witness UTXO (`0x00`), the witness UTXO, proprietary
  records other than `qbit` subtypes 1-3, and unknown key types. It drops the
  partial-signing fields Core drops (`0x02`-`0x06`, `0x0a`-`0x0d`,
  `0x13`-`0x1d` and `qbit` subtypes 1-3) and an empty final scriptSig
  (`0x07`). Before, only the witness UTXO and the new final scriptwitness
  survived. An input to finalize that carries a non-empty final scriptSig now
  throws `INVALID_PSBT`, because a P2MR spend's scriptSig must be empty and
  Core would treat that input as already final.
- **Breaking:** `parseQbitUri` reads the query like qbit Core's GUI parser.
  `+` is a literal plus, not a space. `req-amount`, `req-label` and
  `req-message` fill `amount`, `label` and `message`, and any other `req-`
  parameter throws `INVALID_URI`. `QBIT:` in any case and one trailing `/`
  after the address are accepted. Where Core is lenient, it now throws
  `INVALID_URI` instead of guessing: a repeated `amount`, `label` or
  `message`, a `#` anywhere, a case variant of those names or of `req-`
  (`AMOUNT=5`, `REQ-expires=1`, `meſſage=x`), a malformed percent-escape in
  any key or value, and an empty `amount=`. A decoded `label` or `message`
  can hold control characters, so escape it before display.
- **Breaking:** `parseQbitUri` and `formatQbitUri` throw `INVALID_URI` for an
  amount above `QBIT_MAX_MONEY` (210,000,000 QBT), the cap Core's amount
  field enforces. Both used to accept any number of digits, so
  `184467440737.09551617` (2^64 + 1 base units) passed.
- **Breaking:** `formatQbitUri` percent-encodes `label` and `message` like
  Core's `QUrl::toPercentEncoding`: a space becomes `%20` instead of `+`, and
  `! ' ( ) *` are escaped. Text with a lone UTF-16 surrogate throws
  `INVALID_URI` instead of being replaced with U+FFFD.
- **Breaking:** `decodePsbt`, and through it `validateP2mrSigningPlans`,
  `signP2mrPsbt` and `finalizeP2mrPsbt`, reject a `Psbt` object that
  `parsePsbt` could never return: an input or output map count that differs
  from the unsigned transaction, an empty key, or a raw key repeated within a
  map. Each throws `INVALID_PSBT` before any signature hash or signer call.
  Before, a second witness UTXO on an input changed the amount and fee shown
  while the signature committed to the first one. `qbit` proprietary input
  records with a subtype other than 1-3 are now kept undecoded, as Core keeps
  them, instead of throwing `INVALID_PSBT`.
- **Breaking:** `finalizeP2mrPsbt` builds the witness qbit Core's
  `FinalizePSBT` builds, and `validateP2mrSigningPlans` and `signP2mrPsbt`
  refuse, before any signer call, a plan whose signature finalize would not
  use. Before, the preflight accepted inputs that finalize always rejected, or
  whose signature finalize then left out, so a stateful signer spent a key use
  for nothing.
  - The preflight runs finalize's own leaf selection over each input's
    signatures plus the call's plans. When that completes a witness that
    leaves out a plan's signature, the whole call throws `INVALID_PSBT`
    (`input N: finalizeP2mrPsbt would not use the signature planned for pubkey
    … and leaf hash …`) and nothing is signed: another leaf finalize prefers is
    already complete (for example a dApp-supplied signature for the other leaf
    of a two-leaf wallet address), or the plan's `multi_a` leaf reaches its
    threshold, with existing signatures or the call's other plans, on keys
    finalize places first. Finalize places from the last key: for a 1-of-2
    `[K1, K2]` leaf with K2 signed, a K1 plan is refused (as are plans for both
    keys in one call), but with K1 signed a K2 plan is accepted and finalize
    uses K2. Core signs only the leaf it finalizes, up to its threshold.
  - When no leaf completes, a call that plans signatures on two or more leaves
    of one input throws `INVALID_PSBT` (`input N: this call plans signatures on
    L leaves and completes none; finalizeP2mrPsbt uses one leaf`): a witness
    reveals one leaf, so at least one of those key uses is wasted. For example,
    a wallet planning every leaf that holds its key on a dApp PSBT listing two
    2-of-2 leaves `{U, K1}` and `{U, K2}`. Core signs only its best partial leaf
    for the same reason (`src/script/sign.cpp:743-756`). Plans on one leaf that
    do not complete it are still accepted, for multi-party `multi_a` signing,
    and so are separate calls for different leaves.
  - Neither the preflight nor finalize verifies signatures. An invalid
    signature already on the PSBT counts as a valid one: on a leaf finalize
    prefers, it gets the plan refused, but on the leaf finalize uses it makes
    finalize produce a transaction that does not verify.
  - Finalize no longer requires exactly one leaf and one signature. It ignores
    and drops leaf records that do not commit to the witness UTXO or are not
    v1 `pk` / `multi_a` leaves, and signatures for other (pubkey, leaf hash)
    pairs. It finalizes a `multi_a` leaf once its threshold is met: one item
    per key, last key first, each a signature until the threshold is placed
    and empty otherwise. When several leaves are complete it uses the
    smallest witness, ties going to the bytewise-smallest script, and it uses
    a leaf's shortest committing control block. Single-key witnesses are
    unchanged.
  - Every P2MR signature on the input, used or not, must carry the input's
    sighash type, or finalize throws `INVALID_SIGHASH`, as Core does.
  - `decodePsbt` lists a leaf carried as both `0x1d` and `qbit` `0x02` with the
    same control block once, and a signature carried as both `0x19` and `qbit`
    `0x03` once. Two different signatures for one (pubkey, leaf hash) now
    throw `INVALID_PSBT` in `decodePsbt` and every function that calls it, as
    Core rejects that PSBT.
  - The preflight refuses an input with a non-empty final scriptSig (`0x07`).
    A control block whose control byte names another leaf version is skipped,
    as Core skips it, instead of throwing `INVALID_SCRIPT`; when no control
    block of the leaf commits, signing and finalizing throw `INVALID_PSBT`.
  - Finalize's `INVALID_PSBT` messages for an input it cannot finalize
    changed: `finalize supports single-key P2MR spends` is replaced by `no
    P2MR script signature to finalize`, `no P2MR script signature is for a key
    of a v1 pk or multi_a leaf script on the input`, `P2MR control block does
    not commit to the witness UTXO program` or `no committed P2MR leaf has
    enough signatures to finalize`.
- **Breaking:** the byte inputs listed below must be a `Uint8Array`; any other
  value now throws `INVALID_BYTES` (`<name> must be a Uint8Array`), even when
  its `length` is right. A Node `Buffer`, a subarray, a subclass and a
  `Uint8Array` from another realm are still accepted; a `Uint16Array` whose
  `Symbol.toStringTag` was redefined as `'Uint8Array'` is not. Code that
  passed a plain `number[]` or another integer typed array (`Int8Array`,
  `Uint8ClampedArray`, `Uint16Array`, ...) holding byte values got the
  correct bytes from most helpers and now throws, for example
  `p2mrScriptPubKey`, `encodeP2mrAddress`, `singleKeyLeafScript`,
  `p2mrBranchHash`, `encodeP2mrWitnessSignature`, `qbitDataSigPqcHash`,
  `createP2mrMessageProof`'s `signature`, `createP2mrPsbt`'s txids, leaf
  scripts and output scripts, `p2mrSighash`'s txids and scripts, and every
  key and value of a hand-built `Psbt` given to `serializePsbt`: wrap such a
  value with `Uint8Array.from(...)`. A string, or an element
  outside 0-255, was encoded as different bytes: a 3680-character string
  signature gave a message proof whose `signature` was 7360 hex digits, `00`
  for every character except a decimal digit `d`, which gave `0d`; a string
  script hashed as zeros; a string `scriptPubKey` in `p2mrSighash`'s
  `spentOutputs`, or a hex-string field of its cached `midstates`, gave a
  digest qbit Core never computes; a 3680-character string decoded as a
  0-byte witness signature; a string `keyData` given to
  `decodeQbitProprietaryP2mrInputField` decoded as an all-zero pubkey and
  leaf hash; and a `Uint16Array` was truncated mod 256. This covers every
  fixed-length byte input (pubkeys, signatures, leaf hashes, merkle roots and
  siblings, outpoint txids, address programs, signing-key `pubkey` and
  `leafHash`, and the five 32-byte `midstates` fields of `p2mrSighash` and
  `schnorrSignatureHash`), the leaf script and control block of
  `createP2mrMessageProof`, `p2mrLeafHash`, `verifyControlBlock` and the
  `encode*LeafScriptField` helpers, every output and witness-UTXO
  `scriptPubKey` of `createP2mrPsbt` (also with `restrictedOutputMode:
  false`), the `tx.outputs` and `spentOutputs` scripts and the `annex` of
  `p2mrSighash`, `schnorrSignatureHash` and `precomputeSighashMidstates`, the
  map keys and values `serializePsbt` writes, the `keyData` of
  `decodeQbitProprietaryP2mrInputField`, and the arguments of
  `outputScriptToAddress`, `decodeP2mrWitnessSignature` and
  `decodeP2mrPsbtScriptSigField`. `parsePsbt`, `bytesToHex`,
  `decodeP2mrPsbtLeafScriptField` and the `value` of
  `decodeQbitProprietaryP2mrInputField`'s leaf-script subtype are not checked
  yet. The error kind changes too: a byte input that is not a `Uint8Array`
  now throws `INVALID_BYTES` whatever it threw before, whether a `TypeError`
  or `RangeError` or a `QbitProtocolError` (`INVALID_SCRIPT`, `INVALID_PSBT`,
  `INVALID_BECH32`) from a later check. For example, `undefined`, `null` or a
  `DataView` threw a `TypeError` or `RangeError`; a `number[]` or string leaf
  hash in `merkleRootFromPath` or `verifyControlBlock` threw a `TypeError`; a
  string control block in `createP2mrPsbt` threw `INVALID_PSBT`; a string
  control block or pubkey in `createP2mrMessageProof` threw `INVALID_SCRIPT`;
  and `encodeP2mrAddress` threw `INVALID_BECH32` for a `Uint16Array` holding
  a value above 255. The exception is the sighash `leafHash`: `p2mrSighash`
  and `schnorrSignatureHash` throw `INVALID_SIGHASH` for one that is not a
  32-byte `Uint8Array`.
- **Breaking:** `createP2mrPsbt`, `validateP2mrSigningPlans` and
  `signP2mrPsbt` enforce qbit Core's restricted-output consensus rule, which
  is on for mainnet, testnet4, signet and regtest (unless the node runs with
  `-p2mronly=0`). Every output must be P2MR (witness v2 with a 32-byte
  program), start with `OP_RETURN`, or be P2A (`51024e73`). Any other output,
  such as P2WPKH, P2TR, P2PKH, a bare `OP_1` or an empty script, throws
  `INVALID_SCRIPT` before any signer call, even when no signing keys are
  given. Such a transaction used to be signed, finalized and extracted,
  spending a bounded signature, and then rejected at broadcast with
  `tx-output-not-p2mr`. Witness v3..v16 outputs are refused too: Core's
  consensus allows them on mainnet, testnet4 and signet, but they are
  non-standard, so no default node relays them, and anyone can spend them.
  `OP_RETURN` push-only data and size, which are relay policy, are not
  checked. Pass the new `restrictedOutputMode: false` option (on
  `createP2mrPsbt` and `P2mrSigningOptions`) only for a regtest node run with
  `-p2mronly=0`. New exports: `isRestrictedOutputModeOutput`, which mirrors
  Core's per-output check, and `RestrictedOutputModeOptions`.
- `pqc()` descriptor keys are base58-decoded with Core's 82-byte bound, so an
  oversized key fails at once with `base58 payload exceeds 82 bytes` instead
  of stalling the caller.
- `combinePsbts` merges in time linear in the total number of map entries,
  however many PSBTs are passed. A PSBT carrying many distinct keys in one map
  made it quadratic: 100,000 keys took about 50 s. Output and errors are
  unchanged. Its JSDoc now notes that rejecting conflicting values is stricter
  than qbit Core, which keeps the first value.
- `serializePsbt` serializes maps of any size. It spread every chunk into call
  arguments, so a map with more than about 62,000 entries threw a bare
  `RangeError` on Node's main thread instead of serializing. That could lose
  a signature `signP2mrPsbt` had just produced. Output bytes are unchanged.
- `QbitProtocolError.is(value)` and `P2mrPsbtSigningError.is(value)` recognize
  those errors from any copy of the package, such as the CommonJS build when
  the error came from the ESM build, where `instanceof` is false. They check
  non-enumerable `Symbol.for('qbit-js.QbitProtocolError')` and
  `Symbol.for('qbit-js.P2mrPsbtSigningError')` brands on the class
  prototypes. `instanceof`, error instances and their serialization are
  unchanged.

### @qbit-oss/api

- **Breaking:** the `EsploraClient` constructor validates `timeoutMs`
  (integer `1..2147483647`), `retries` (integer `0..10`), `retryBaseDelayMs`
  (finite `0..2147483647`) and `baseUrl` (absolute http(s), with no
  whitespace, control or format characters, backslash, credentials, query or
  fragment). An invalid value throws `QbitApiError` with kind `http`. Retry
  backoff is capped at 2147483647 ms.
- **Breaking:** `broadcastTx` never re-sends a submission that may have
  reached the node. A timeout, a possibly-sent network error, a 5xx with no
  node verdict in its body, or a 2xx that does not echo the txid rejects with
  the new kind `unknown_outcome`, carrying `txid`: check
  `getTxStatus(error.txid)` before resubmitting the same hex. An already-known
  reply (`-27`, `txn-already-in-mempool`, …) resolves with the txid. A coded
  node rejection (for example `-25` missing inputs or `-26`) is a definite
  `http` failure whatever the HTTP status. With no txid available, a 2xx must
  be a bare 64-hex txid. `broadcastTx` accepts `{ txid }`, malformed arguments
  throw `TypeError` before anything is sent, and `txidFromRawTx` is a new
  export. `@qbit-oss/api` now depends on `@noble/hashes` `^1.3.0`.
- **Breaking:** cancellation and a per-call deadline. Every method on both
  clients takes a final `{ signal, deadlineMs }` argument, and the constructor takes a
  client-wide `signal`. One signal and deadline cover every request a call
  depends on: pagination, retries, backoff sleeps, body reads and the
  mempool-qbit `/tx/push` fallback. An abort rejects with the new kind
  `aborted` (exhaustive `switch`es over `QbitApiErrorKind` need a case), and an
  expired deadline rejects with `timeout`. Neither is retried, and a body
  still streaming is cancelled. For `broadcastTx`, an abort or deadline before
  the POST is sent is `aborted` / `timeout`. Once the POST may have been sent,
  it is `unknown_outcome` with the txid, and the POST is never re-sent. An
  invalid `deadlineMs` throws `QbitApiError` with kind `http`. `sleepFn` now
  receives the signal: `(ms, signal?) => Promise<void>`.
- **Breaking:** a server-supplied `Retry-After` is honoured only up to the new
  `maxRetryAfterMs` option (default 30000 ms). A longer wait now throws
  instead of sleeping: a read's 429/5xx surfaces at once as `rate_limit` /
  `http` with `retryAfterMs` set (de-duplicated GETs are released with it),
  and a `broadcastTx` 429 rejects at once as `rate_limit` with `retryAfterMs`,
  without re-sending. Previously any delay was slept on, and one above about
  24.8 days fired at once. An overflowing delta-seconds value counts as too
  long. `maxRetryAfterMs` is validated like the other options: it must be an
  integer `0..2147483647`, and any other value, including `null`, throws
  `QbitApiError` with kind `http`. An HTTP status error (`rate_limit`,
  `http`, `not_found`, `payload_too_large`) whose reply has a parseable
  `Retry-After` now carries `retryAfterMs`, including after retries run out.
- **Breaking:** `timeoutMs` bounds the whole response, headers and body
  (error bodies included), with one timer per attempt measured from its
  start; the call's `signal` and `deadlineMs` bound the body read too. A body
  that stalls is cancelled and fails the attempt as `timeout`, carrying the
  reply's `status`, and a read is retried with backoff (not `Retry-After`).
  Previously a stalled body hung the call, and a body that legitimately takes
  longer than `timeoutMs` to arrive now times out. A 429/5xx reply that is
  retried is now downloaded under the timer before the retry. `broadcastTx`
  never re-sends once a reply has arrived: a reply that stalls, cannot be
  read, or is cut short by an abort or deadline rejects with
  `unknown_outcome` (with `status` and `txid`) after one POST. The exception
  is a `429`, which proves nothing was submitted: one whose body stalls or
  cannot be read is retried with backoff and rejects as `rate_limit` once
  retries run out, and an abort or deadline during its body is `aborted` /
  `timeout`. For subclasses, `request()` resolves with a fully buffered
  response that keeps `status`, `headers`, `url` and `clone()`. A custom
  `fetchFn` no longer needs a global `Response` (without one, `request()`
  returns a buffered Response-like object with `body: null`) and should
  honour `init.signal` for the whole response.
- **Breaking:** requests are sent with `redirect: 'manual'`, and the client
  never follows a redirect. A `3xx` reply or a browser opaque redirect rejects
  as `QbitApiError` kind `http`, naming the target by origin only. Where the
  runtime follows a redirect anyway (React Native's `fetch` does), a reply it
  reports as `redirected`, or whose `url` is not the requested URL, is refused
  the same way. A refused reply's body is discarded unread. Any difference in
  scheme, host, port, path or query counts, so a redirect to another path on
  the same backend is refused too; the case of the scheme and host, a default
  port and a trailing dot on the host do not count. On such a runtime the
  redirected request has already been sent, on Android with your custom
  `headers`: send an API key in `Authorization`, or pass a `fetchFn` that
  honours `redirect: 'manual'`. On `broadcastTx` a refused redirect of any
  kind rejects with `unknown_outcome` carrying `txid` (and the `3xx` status),
  with the `http` refusal as `cause`: the `POST` reached the backend, which
  may have accepted it, and a runtime that followed the redirect may have
  re-sent it. It is never re-sent (as a `GET` or otherwise), retried or sent
  to `/tx/push`. `http://mempool.qbit.org`, which answers `301`, now fails:
  use the https URL. A `QbitApiError` thrown by a custom `fetchFn` now
  propagates unchanged.
- **Breaking:** a plain-`http` `baseUrl` is rejected by the constructor unless
  its host is loopback (`localhost`, `127.0.0.0/8`, `[::1]`) or the new option
  `allowInsecureHttp: true` is set. Scheme and host are compared
  case-insensitively. The constructor's `baseUrl` checks read the URL by hand,
  so they also run on React Native, whose `URL` getters throw before 0.80.
- **Breaking:** `QbitApiError.message` and `.url` no longer contain the base
  URL's path. They show the base as its origin followed by `/...`, then the
  endpoint path (`https://host/.../blocks/tip/height`), on every error the
  client creates, `unknown_outcome`, `rate_limit`, `timeout` and `aborted`
  included. A base URL without a path is shown as its origin, and one whose
  host cannot be read reliably (an `@` after the host, or a host or port that
  is not plain) as `...`. Text the client quotes is redacted too, as far as it
  can be recognized: fetch's own error text in `network` and `timeout`
  messages, and response text in `message` and in `responseBody` (an
  `unknown_outcome`'s included), which is no longer the raw preview. In it
  the base URL, its path (Express: `Cannot GET /<token>/api/...`) and each
  path segment of 8 or more characters are replaced, matching exactly and
  case-sensitively; a secret quoted any other way is not caught. Quoted text
  in `message` has control characters, line separators and bidi controls
  escaped. The tip-height parse error now carries `url` and `responseBody`.
  `EsploraClient` gains the protected `errorUrl(path)`, and its `baseUrl` is
  now protected.
- **Breaking:** `cause` is a redacted copy of the underlying error, with the
  same `name` (and class, for built-in errors), so `error.cause === original`
  no longer holds. The original is available only through the new static
  `QbitApiError.unredactedCause(error)`, and `QbitApiErrorOptions` gains
  `unredactedCause`. A `QbitApiError` the client created is kept as the
  `cause` as it is. An `aborted` error's `cause` is still the signal's
  reason, and a `QbitApiError` thrown by a custom `fetchFn` still propagates
  unchanged.
- **Breaking:** fee tiers and address balances fail closed. `getFeeTiers()`
  and `feeTiersFromEstimates()` throw a `parse` `QbitApiError` when a fee rate
  is above `maxFeeRate`, when a rate is not finite or not above 0, or when a
  target is not a decimal block count from 1 to 1008. The default
  `maxFeeRate` is `DEFAULT_MAX_FEE_RATE_SAT_VB`, 10,000 sat/vB, which is qbit
  Core's default `maxfeerate`. Invalid entries used to be dropped. The
  default is a ceiling, not a sanity check: a backend can still return
  9,999 sat/vB, so pass a lower `{ maxFeeRate }` to
  `feeTiersFromEstimates()`, cap the total fee, or both.
  `MempoolQbitClient` requires finite `fastestFee`, `halfHourFee` and
  `hourFee` above 0. `getAddressBalance()` and `addressBalanceFromStats()`
  throw `parse` for malformed stats, for sums that are not non-negative safe
  integers (including JSON values above 2^53), for confirmed spent above
  funded, and for a negative total. `funded_txo_sum` and `spent_txo_sum` are
  lifetime totals, so an address that has received more than about 90M QBT
  over its life fails on every call; sum `getAddressUtxos()` instead for
  such an address. On electrs a negative total can be transient right after
  a block, so retry on the next poll. New export:
  `DEFAULT_MAX_FEE_RATE_SAT_VB`.
- **Breaking:** `getAddressHistory` on both clients throws `invalid_cursor`
  instead of returning a history the backend cut short. It took an empty page
  as proof of completion, but qbit-electrs answers a cursor it cannot continue
  from with HTTP 200 `[]` (on a node that lags the one that served the
  previous page, behind a load balancer or mempool-qbit's failover; after a
  reorg between pages; on the combined route when the cursor is the last
  mempool row), and `/txs/mempool` lists at most 50 transactions. The call now
  reads the address stats before and after the scan, each in a request of its
  own, and requires exactly `chain_stats.tx_count` confirmed and
  `mempool_stats.tx_count` mempool transactions. If the stats changed during
  the scan, it scans once more; if they change again, or the counts differ,
  it throws `invalid_cursor`. Each call makes two more requests (three with a
  rescan), and a backend without `/address/:address` now fails it. Some
  failures last as long as their cause: `EsploraClient` fails for an address
  with more than 50 mempool transactions, and `MempoolQbitClient` for one
  whose mempool rows exactly fill pages of 50 while it has confirmed history
  (until the backend's combined route stops answering `[]` for a cursor that
  is the address's last mempool row). Stats without a non-negative
  safe-integer `tx_count` throw `parse`. `maxPages` and `maxTransactions` now
  cover the whole call, a rescan included; the stats reads and
  `EsploraClient`'s `/txs/mempool` fetch are not page fetches.
  `MempoolQbitClient.getAddressTxs(address)` reads the stats when an empty
  page follows a mempool row, and throws `invalid_cursor` instead of
  returning `[]` when they count confirmed transactions it has not found. The
  protected `getJson` takes an optional `dedup` flag.
- **Breaking:** `getTxHex` (both clients) checks the reply before returning
  it, and throws a `parse` `QbitApiError` unless the body is non-empty,
  even-length hex that decodes to one complete transaction whose txid equals
  the requested `txid` (compared case-insensitively). The txid is the double
  SHA-256 of the witness-stripped serialization, as qbit Core computes it, so
  a wtxid never matches. Before, any 2xx body was returned as it was:
  mempool.qbit.org's empty `200` reply came back as `''`, and a backend could
  serve another transaction undetected. Spaces, tabs and line breaks around
  the hex are ignored, and the hex is returned in lowercase. The txid does not
  commit to witness data, so a reply with altered or stripped witnesses still
  passes. Both `getTxHex` and `txidFromRawTx` now also refuse, as `parse`,
  the encodings qbit Core's decoder refuses even where they leave the txid
  unchanged: a count or length (witness section included) in a longer
  CompactSize form than its value needs or above `MAX_SIZE` (0x02000000), and
  a witness flag with every witness stack empty; `broadcastTx` still sends
  such hex as it is, without a derived txid.
- `QbitApiError.is(value)` recognizes a `QbitApiError` from any copy of the
  package, such as the CommonJS build when the error came from the ESM build,
  where `instanceof` is false. It checks a non-enumerable
  `Symbol.for('qbit-js.QbitApiError')` brand on the class prototype.
  `instanceof`, error instances and their serialization are unchanged.
- **Breaking:** a `QbitApiError` a custom `fetchFn` throws is recognized by
  that brand, so one from the other build (an ESM-loaded fetch wrapper used by
  a client from the CommonJS build, say) propagates as it is, as one from the
  same build already did. Before, it was re-wrapped as `network`: a
  `rate_limit` lost its kind and `retryAfterMs`, and a read was retried. Such
  an error is judged by its public fields only, since the copy that created it
  keeps its original cause and response body to itself: on a submission, its
  `network` error never counts as proof that nothing was sent (it becomes
  `unknown_outcome`), and its response body never triggers
  `MempoolQbitClient`'s `/tx/push` fallback.
- The `credentials` option is typed with the new export `QbitFetchCredentials`
  (`'omit' | 'same-origin' | 'include'`) instead of the DOM's
  `RequestCredentials`, so the declarations compile without the DOM lib, for
  example with `lib: ["ES2022"]` and `types: ["node"]` (before:
  `Cannot find name 'RequestCredentials'`). They still need global `fetch` and
  `Response` types, which `@types/node` declares from 18.18.7 in 18.x, from
  20.8.4 in 20.x, and from 22 on. The accepted values are unchanged.

### Packaging

- The packages are published as `@qbit-oss/protocol` and `@qbit-oss/api`.
  `repository`, `bugs` and `homepage` point at `Qbit-Org/qbit-js`.
- Both packages publish ESM type declarations (`lib/index.d.mts`) through
  nested `import`/`require` export conditions, expose `./package.json`, ship
  their LICENSE, and build on `npm pack`/`npm publish` (`prepack`). `pnpm
  pack:check` asserts both tarballs' contents and that each package's LICENSE
  matches the root one.
- Both packages are published only from `Qbit-Org/qbit-js`, by a workflow run
  on the release tag, with npm provenance. After each package's first
  version, which a short-lived token publishes, the run authenticates through
  npm trusted publishing. Release candidates go to the `candidate` dist-tag
  and final releases to `latest`.
- `pnpm consumer:check` type-checks a consumer against both packed packages'
  declarations (`lib/index.d.ts` and `lib/index.d.mts`) with
  `skipLibCheck: false`, as a Node-only project (no DOM lib) and as a browser
  project (no `@types/node`), and loads the CommonJS and ESM builds side by
  side to check the error-class brands, including that a client passes a
  `fetchFn`'s error from the other build through. CI runs it.

### Development

- pnpm 11.28.6, pinned by `packageManager` and read by CI, plus a dev
  toolchain refresh (vitest 5, tsup 8, TypeScript 5.9) and Dependabot.
  Developing in this repo needs Node.js `^22.13.0 || ^24.0.0 || >=26.0.0`. The
  published packages' `engines` are unchanged.
- Release process: `RELEASING.md`, this changelog, and CI on `release/**`
  branches.
- The Core-derived P2MR fixtures are reproducible and checked in CI.
  `p2mr-psbt.json`'s finalized input now carries the witness-stack count that
  qbit Core and `extractP2mrTransaction` require, and `source.method` is gone
  from both fixtures. The generators check the qbit checkout's commit and
  `origin`, import only a `git archive` export of that commit, and need a
  Python with `tarfile`'s `data` filter (3.12+, or 3.9.17+, 3.10.12+ or
  3.11.4+). `pnpm fixtures:check` regenerates both fixtures from
  `Qbit-Org/qbit` v1.0.0 and fails unless they match byte for byte. CI runs it,
  which needs network access to github.com.
- The fresh-consumer install smoke installs both tarballs and also imports
  `@qbit-oss/api` through ESM and CJS.

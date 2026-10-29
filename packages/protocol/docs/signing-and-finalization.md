# Signing and finalization

How `signP2mrPsbt`, `validateP2mrSigningPlans` and `finalizeP2mrPsbt` sign,
recover from partial signing, enforce sighash types and pick a witness.

- crash-safe P2MR signing for stateful signers: `signP2mrPsbt` reports each
  signature through the synchronous `onSigned` callback as soon as it is
  stored, and a failed signer call or callback throws `P2mrPsbtSigningError`
  carrying the partially signed PSBT, the plans signed so far, and the `phase`
  (`'sign'`: nothing stored for the failed plan and `onSigned` not called, but
  a stateful signer must still treat its key use as consumed, so it records
  each key use in `sign` before signing, not in `onSigned`; `'onSigned'`: its
  signature is already stored), so a retry passes that PSBT back in with only
  the unsigned plans, which include a `'sign'`-phase failed plan: the signer
  is called for it again with the same digest; `sign` and `onSigned` must both
  be synchronous, and one that returns a promise fails its plan the same way
  (the promise is never left unhandled);
  a signature `Uint8Array` from another realm (vm, iframe, worker) is accepted
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

## Non-default sighash types

Non-default sighash types (`NONE`, `SINGLE`, and the `ANYONECANPAY` variants)
do not commit to every input and output, so a signature made with one can be
lifted into a transaction the user never saw. Applications must surface the
type (`decodePsbt(...).inputs[i].sighashType` and the signing key's `hashType`)
in their approval flow before opting in with `allowNonDefaultSighash: true`.

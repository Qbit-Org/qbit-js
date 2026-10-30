import { QbitProtocolError, P2mrPsbtSigningError } from './errors'
import {
  P2MR_PROGRAM_BYTES,
  P2MR_LEAF_VERSION_MASK,
  P2MR_LEAF_VERSION_V1,
  OP_1,
  OP_2,
  OP_16,
  OP_CHECKSIGPQC,
  OP_CHECKSIGADD,
  OP_NUMEQUAL,
  PQC_SIGNATURE_BYTES,
  SIGHASH_DEFAULT,
  PSBT_IN_WITNESS_UTXO,
  PSBT_IN_FINAL_SCRIPTWITNESS,
  PSBT_IN_PROPRIETARY,
  PSBT_QBIT_IDENTIFIER,
  PSBT_QBIT_IN_P2MR_MERKLE_ROOT,
  PSBT_QBIT_IN_P2MR_SCRIPT_SIG,
} from './constants'
import { assertRestrictedOutputModeOutputs } from './consensus'
import {
  bytesToHex,
  compactSize,
  copyBytes,
  bytesEqual,
  compareBytes,
  isUint8Array,
  assertByteLength,
  asciiBytes,
} from './bytes'
import { p2mrLeafHash, verifyControlBlock } from './scripts'
import { type P2mrTransaction, cloneTxOut, cloneP2mrTransaction, serializeWitnessStack } from './transaction'
import {
  isValidP2mrSighashType,
  type P2mrSpentOutput,
  precomputeSighashMidstates,
  p2mrSighash,
  formatSighashType,
} from './sighash'
import {
  type P2mrPsbtScriptSigField,
  type P2mrPsbtLeafScriptField,
  encodeP2mrWitnessSignature,
  encodeP2mrPsbtScriptSigField,
} from './psbt-fields'
import {
  type PsbtKeyValue,
  type Psbt,
  type PsbtInputSummary,
  type PsbtSummary,
  psbtUnsignedTransaction,
  decodePsbt,
  parseTxOut,
  parseProprietaryKey,
  cloneEntry,
  mergeMap,
  parseWitnessStack,
  encodePsbtSighashTypeField,
} from './psbt'

/**
 * What a `P2mrPsbtSignFn` is asked to commit to. A signing device can render
 * `tx` / `spentOutputs` and must show or refuse any `hashType` other than
 * `SIGHASH_DEFAULT`: `NONE`, `SINGLE` and the `ANYONECANPAY` variants leave
 * outputs and/or other inputs uncommitted, so the same digest (and therefore
 * the same signature) is valid in transactions the user never saw.
 *
 * @remarks
 * See
 * [Signing and finalization](https://github.com/Qbit-Org/qbit-js/blob/main/packages/protocol/docs/signing-and-finalization.md).
 *
 * @category Signing
 */
export interface P2mrPsbtSignContext {
  /** Index of the input being signed. */
  inputIndex: number
  /** The plan's 32-byte public key (a copy). */
  pubkey: Uint8Array
  /** The 32-byte hash of the leaf being signed (a copy). */
  leafHash: Uint8Array
  /** Sighash type the digest was computed with (and the type byte appended to the witness signature when not `SIGHASH_DEFAULT`). */
  hashType: number
  /** The unsigned transaction being signed. */
  tx: P2mrTransaction
  /** The outputs being spent, one per transaction input in input order. */
  spentOutputs: readonly P2mrSpentOutput[]
}

/**
 * Signer callback: returns a 3680-byte SLH-DSA signature, or `undefined` (not
 * `null`) to skip the plan.
 *
 * A stateful signer records each key use here, when it is called and before
 * it signs, not in `onSigned`: a plan that fails in phase `'sign'` never
 * reaches `onSigned`, and a retry calls the signer again for it with the same
 * digest.
 *
 * Must be synchronous: `signP2mrPsbt` stores each signature before the next
 * plan is attempted, so it cannot wait for a promise. A returned promise or
 * other thenable fails that plan with a `P2mrPsbtSigningError` in phase
 * `'sign'` (its eventual settlement is ignored, and the key use still counts
 * as consumed). Any `Uint8Array`, including one created in another realm
 * (vm context, iframe, worker) or a Node `Buffer`, is accepted and copied; other
 * views such as `DataView` or `Int8Array` are rejected.
 *
 * @remarks
 * `sighash` is the 32-byte {@link p2mrSighash} digest to sign. See
 * [Signing and finalization](https://github.com/Qbit-Org/qbit-js/blob/main/packages/protocol/docs/signing-and-finalization.md).
 *
 * @category Signing
 */
export type P2mrPsbtSignFn = (sighash: Uint8Array, context: P2mrPsbtSignContext) => Uint8Array | undefined

/**
 * One signing plan for {@link signP2mrPsbt} or
 * {@link validateP2mrSigningPlans}: sign an input with a key, through one leaf.
 *
 * @category Signing
 */
export interface P2mrSigningKey {
  /** Index of the input to sign; an index outside the transaction throws `INVALID_PSBT`. */
  inputIndex: number
  /** 32-byte `Uint8Array`; any other value throws `INVALID_BYTES` before any signer call. */
  pubkey: Uint8Array
  /** 32-byte `Uint8Array`; any other value throws `INVALID_BYTES` before any signer call. */
  leafHash: Uint8Array
  /**
   * Sighash type; defaults to `SIGHASH_DEFAULT`. Any other type requires
   * `allowNonDefaultSighash: true`, must equal the input's
   * `PSBT_IN_SIGHASH_TYPE` field when that field is present, and must equal the
   * type of every P2MR signature already on the input (qbit Core's
   * `SIGHASH_MISMATCH` rules).
   */
  hashType?: number
}

/**
 * Identifies one signing plan: the (input, pubkey, leaf hash) triple a signature is keyed by.
 *
 * @category Signing
 */
export interface P2mrSigningPlanRef {
  /** Index of the signed input. */
  inputIndex: number
  /** The 32-byte public key (a copy). */
  pubkey: Uint8Array
  /** The 32-byte leaf hash (a copy). */
  leafHash: Uint8Array
}

/**
 * Called by `signP2mrPsbt` right after each signature has been validated and
 * stored, before the next plan's `sign` call. `field` is the stored 0x19
 * script-sig record (`key` = type||pubkey||leafHash, `value` = signature with
 * any explicit sighash type appended). Persist the signature here, so a later
 * failure can never lose the record of a signature that was already produced.
 * This runs only for a stored signature, so a stateful signer records key use
 * in `sign` instead (see {@link P2mrPsbtSignFn}): a plan that fails in phase
 * `'sign'` counts as a key use but never reaches `onSigned`. For a non-default
 * sighash type the input's
 * `PSBT_IN_SIGHASH_TYPE` (0x03) record is stored in the same step; it is not
 * part of `field`.
 *
 * Must be synchronous: signing cannot wait for a promise, so persistence has
 * to complete before the callback returns. A returned promise or other
 * thenable is treated as a failure of that plan and signing stops with a
 * `P2mrPsbtSigningError` in phase `'onSigned'` before the next plan's `sign`
 * call. Its eventual settlement is ignored, so the signature is stored but
 * whether the persistence it started completed is unknown to the caller.
 *
 * @remarks
 * See
 * [Signing and finalization](https://github.com/Qbit-Org/qbit-js/blob/main/packages/protocol/docs/signing-and-finalization.md).
 *
 * @category Signing
 */
export type P2mrPsbtOnSignedFn = (event: P2mrSigningPlanRef & { field: { key: Uint8Array; value: Uint8Array } }) => void

/**
 * Options shared by {@link signP2mrPsbt} and {@link validateP2mrSigningPlans}.
 *
 * @category Signing
 */
export interface P2mrSigningOptions {
  /**
   * Permit sighash types other than `SIGHASH_DEFAULT`. Off by default because
   * `NONE`, `SINGLE` and the `ANYONECANPAY` variants do not commit to every
   * input and output, so a signature made with them can be lifted into a
   * transaction the user never approved. Only set this after the application's
   * approval flow has shown the requested type to the user.
   */
  allowNonDefaultSighash?: boolean
  /**
   * `false` skips the restricted-output check, matching qbit Core's regtest
   * `-p2mronly=0`. By default every output of the unsigned transaction must be
   * one Core's restricted-output mode allows (see
   * {@link isRestrictedOutputModeOutput}, with reserved witness outputs
   * refused), or signing throws `INVALID_SCRIPT` before any signer call.
   */
  restrictedOutputMode?: boolean
}

/**
 * What {@link signP2mrPsbt} returns.
 *
 * @category Signing
 */
export interface SignP2mrPsbtResult {
  /** A new PSBT with the signatures added; the input PSBT is not modified. */
  psbt: Psbt
  /** Plans whose signatures were stored, in signing order. */
  signed: P2mrSigningPlanRef[]
}

interface PreparedP2mrSigningPlan {
  inputIndex: number
  pubkey: Uint8Array
  leafHash: Uint8Array
  hashType: number
  sighash: Uint8Array
}

/**
 * Validate every signing plan without invoking a signer or mutating the PSBT.
 * Stateful signers can call this before reserving counters or keys. It also
 * checks every output against qbit Core's restricted-output mode unless
 * `restrictedOutputMode: false` is passed (see {@link P2mrSigningOptions}).
 *
 * Each plan's leaf must be a committed v1 `pk` or `multi_a` leaf containing
 * the key, with no signature yet for that (pubkey, leaf hash); its input must
 * have no final scriptwitness (`0x08`) or non-empty final scriptSig (`0x07`);
 * and the sighash types must agree. The plans are then checked together
 * against the signatures already on each input: `finalizeP2mrPsbt`'s own leaf
 * selection runs over those signatures plus this call's, and when it completes
 * a witness, that witness must place every plan's signature. A witness
 * reveals one leaf, so the call is refused when it plans signatures on two or
 * more leaves of one input, whether or not any completes. A plan is also
 * refused when another leaf finalize prefers is already complete, or when its
 * `multi_a` leaf reaches its threshold, with existing signatures or the call's
 * other plans, on keys finalize places first: it places from the last key, so
 * for a 1-of-2 `[K1, K2]` leaf with K2 signed a K1 plan is refused, but with
 * K1 signed a K2 plan is accepted and finalize uses K2. qbit Core signs only
 * the leaf it finalizes and stops at its threshold, and with no leaf complete
 * signs only its best partial leaf (`src/script/sign.cpp:592-613`, `:729-756`
 * @ v1.0.0). Plans on one leaf that do not complete it pass, so co-signers can
 * sign a `multi_a` leaf in turn.
 *
 * Once every accepted plan is signed, finalize either uses each of the call's
 * signatures or, with no leaf complete yet, waits for more. Signatures added
 * later, or a plan the signer skips, can make it choose another leaf. Neither
 * this check nor finalize verifies signatures, so an invalid signature already
 * on the PSBT counts as a valid one: on a leaf finalize prefers, it gets the
 * plan refused before a key use is spent, but on the leaf finalize uses,
 * including the plan's own `multi_a` leaf, it makes finalize produce a
 * transaction that does not verify. A failure throws `INVALID_PSBT`,
 * `INVALID_SCRIPT` for an output restricted-output mode rejects, or
 * `INVALID_SIGHASH` for a sighash rule.
 *
 * @param params - The PSBT, the signing plans (`keys`) and the
 * {@link P2mrSigningOptions}.
 * @throws {QbitProtocolError} `INVALID_PSBT` for a plan the rules above refuse,
 * an `inputIndex` out of range, a duplicate plan, an input without a witness
 * UTXO (every input needs one, since the sighash commits to all spent
 * outputs), or a PSBT {@link decodePsbt} rejects.
 * @throws {QbitProtocolError} `INVALID_SCRIPT` for an output restricted-output
 * mode rejects, or `INVALID_SIGHASH` for a sighash rule.
 * @throws {QbitProtocolError} `INVALID_BYTES` for a plan's `pubkey` or
 * `leafHash` that is not a 32-byte `Uint8Array`, or any other code
 * {@link decodePsbt} throws, such as `INVALID_AMOUNT`.
 *
 * @remarks
 * See
 * [Signing and finalization](https://github.com/Qbit-Org/qbit-js/blob/main/packages/protocol/docs/signing-and-finalization.md).
 *
 * @category Signing
 */
export function validateP2mrSigningPlans(
  params: {
    psbt: Psbt
    keys: readonly P2mrSigningKey[]
  } & P2mrSigningOptions
): void {
  prepareP2mrSigningPlans(params.psbt, params.keys, params)
}

/**
 * Sign P2MR inputs. For each key, computes the P2MRSighash from the
 * PSBT's witness UTXOs and calls `sign`; a returned signature is inserted as a
 * 0x19 script-sig field keyed by (pubkey, leafHash). The actual SLH-DSA signing
 * lives outside this package (in the caller's PQC signer), passed in via `sign`.
 *
 * `sign` and `onSigned` are checked to be functions, every output is checked
 * against qbit Core's restricted-output mode (see {@link P2mrSigningOptions}),
 * and the plans are validated as `validateP2mrSigningPlans` validates them
 * before the first signer call, so no key is used for a plan whose signature
 * `finalizeP2mrPsbt` would leave out of the witness it builds from the PSBT's
 * signatures and this call's (`validateP2mrSigningPlans` says what this does
 * not cover); those failures throw a plain `QbitProtocolError` with nothing
 * signed. Both callbacks must be synchronous. Each signature is then checked
 * to be a `Uint8Array` (from any realm) of the expected length and stored as
 * soon as `sign` returns, and reported through `onSigned` before the next plan
 * is attempted. If any plan fails, the `P2mrPsbtSigningError` carries the
 * partially signed PSBT and the plans signed so far; see that class for the
 * retry contract.
 *
 * @param params - The PSBT, the signing plans (`keys`), the synchronous `sign`
 * and optional `onSigned` callbacks, and the {@link P2mrSigningOptions}.
 * @returns A new PSBT with the signatures (`0x19` records, plus
 * `PSBT_IN_SIGHASH_TYPE` for a non-default type) and the plans signed. A plan
 * whose `sign` returned `undefined` is skipped and not listed.
 * @throws {QbitProtocolError} `INVALID_SIGNER` if `sign` is not a function or
 * `onSigned` is neither a function nor `undefined`.
 * @throws {QbitProtocolError} Any code {@link validateP2mrSigningPlans} throws,
 * before the first signer call.
 * @throws {P2mrPsbtSigningError} `SIGNING_FAILED` if a `sign` or `onSigned`
 * call throws or returns a promise, or `sign` returns something other than a
 * 3680-byte `Uint8Array` or `undefined`.
 *
 * @remarks
 * See
 * [Signing and finalization](https://github.com/Qbit-Org/qbit-js/blob/main/packages/protocol/docs/signing-and-finalization.md).
 *
 * @example
 * ```ts
 * import {
 *   P2MR_LEAF_VERSION_V1,
 *   P2mrPsbtSigningError,
 *   p2mrLeafHash,
 *   signP2mrPsbt,
 *   singleKeyLeafScript,
 * } from '@qbit-oss/protocol'
 *
 * // psbt: from createP2mrPsbt or parsePsbt
 * // pubkey: the signing key's 32-byte public key
 * // pqcSign(sighash): your synchronous PQC signer, returning a 3680-byte signature
 * // reserveKeyUse(ref): your keyring's synchronous check-and-record of a key
 * //   use; it throws if the key's state does not allow another signature
 * // saveSignature(ref, field): your synchronous store for a produced signature
 * const leafHash = p2mrLeafHash(P2MR_LEAF_VERSION_V1, singleKeyLeafScript(pubkey))
 * try {
 *   const { psbt: signed } = signP2mrPsbt({
 *     psbt,
 *     keys: [{ inputIndex: 0, pubkey, leafHash }],
 *     sign: (sighash, { inputIndex, pubkey, leafHash }) => {
 *       // Before signing: a plan that fails in phase 'sign' never reaches onSigned,
 *       // and a retry calls sign again, so refuse here when the key's state says so.
 *       reserveKeyUse({ inputIndex, pubkey, leafHash })
 *       return pqcSign(sighash)
 *     },
 *     onSigned: ({ inputIndex, pubkey, leafHash, field }) => saveSignature({ inputIndex, pubkey, leafHash }, field),
 *   })
 *   // pass `signed` to finalizeP2mrPsbt
 * } catch (error) {
 *   if (P2mrPsbtSigningError.is(error)) {
 *     // error.psbt holds the signatures of error.signed; retry with the other keys.
 *     // In phase 'sign', the retry sends error.failed to the signer again.
 *   }
 *   throw error
 * }
 * ```
 *
 * @category Signing
 */
export function signP2mrPsbt(
  params: {
    psbt: Psbt
    keys: readonly P2mrSigningKey[]
    sign: P2mrPsbtSignFn
    onSigned?: P2mrPsbtOnSignedFn
  } & P2mrSigningOptions
): SignP2mrPsbtResult {
  const { psbt, keys, sign, onSigned } = params
  if (typeof sign !== 'function') {
    throw new QbitProtocolError('INVALID_SIGNER', 'signP2mrPsbt sign must be a function')
  }
  if (onSigned !== undefined && typeof onSigned !== 'function') {
    throw new QbitProtocolError('INVALID_SIGNER', 'signP2mrPsbt onSigned must be a function when provided')
  }
  const { tx, spentOutputs, plans } = prepareP2mrSigningPlans(psbt, keys, params)
  const result: Psbt = {
    global: psbt.global.map(cloneEntry),
    inputs: psbt.inputs.map(map => map.map(cloneEntry)),
    outputs: psbt.outputs.map(map => map.map(cloneEntry)),
  }
  const signed: P2mrSigningPlanRef[] = []
  for (const plan of plans) {
    let field: PsbtKeyValue | undefined
    try {
      const signature: unknown = sign(plan.sighash, {
        ...signingPlanRef(plan),
        hashType: plan.hashType,
        // Fresh copies per call: one callback cannot alter what later ones see.
        tx: cloneP2mrTransaction(tx),
        spentOutputs: spentOutputs.map(cloneTxOut),
      })
      if (isThenable(signature)) {
        // The signer may still be talking to the device, so the key use counts
        // as consumed even though nothing can be stored.
        throw thenableFromSynchronousCallback('sign', signature, 'so no signature can be stored for this plan')
      }
      if (signature !== undefined) {
        if (!isUint8Array(signature)) {
          throw new QbitProtocolError('INVALID_SIGNER', 'sign must return a Uint8Array signature or undefined')
        }
        // The encoder copies the bytes, so the stored field never aliases the
        // signer's buffer, whichever realm it came from. Storing inside the
        // guarded region keeps every earlier signature in the error if it fails.
        field = encodeP2mrPsbtScriptSigField(plan.pubkey, plan.leafHash, signature, plan.hashType)
        const entries: PsbtKeyValue[] = [field]
        if (plan.hashType !== SIGHASH_DEFAULT) {
          // Mirror Core: record a non-default type in PSBT_IN_SIGHASH_TYPE so later
          // signers (this library or Core) must use the same type for this input.
          entries.push(encodePsbtSighashTypeField(plan.hashType))
        }
        mergeMap(result.inputs[plan.inputIndex]!, entries)
      }
    } catch (cause) {
      throw new P2mrPsbtSigningError({
        psbt: result,
        signed,
        failed: signingPlanRef(plan),
        phase: 'sign',
        cause,
      })
    }
    if (field === undefined) continue
    signed.push(signingPlanRef(plan))
    if (onSigned === undefined) continue
    try {
      const returned: unknown = onSigned({ ...signingPlanRef(plan), field })
      if (isThenable(returned)) {
        // Persistence is still pending, so the next signer call would race it.
        throw thenableFromSynchronousCallback('onSigned', returned, 'so signing cannot continue safely')
      }
    } catch (cause) {
      throw new P2mrPsbtSigningError({
        psbt: result,
        signed,
        failed: signingPlanRef(plan),
        phase: 'onSigned',
        cause,
      })
    }
  }
  return { psbt: result, signed }
}

function signingPlanRef(plan: PreparedP2mrSigningPlan): P2mrSigningPlanRef {
  return { inputIndex: plan.inputIndex, pubkey: copyBytes(plan.pubkey), leafHash: copyBytes(plan.leafHash) }
}

/**
 * A callback that must be synchronous returned a thenable. Whatever it settles
 * to is never used, so silence it (a rejection must not surface as unhandled)
 * and report the misuse through the typed error instead.
 */
function thenableFromSynchronousCallback(
  callback: 'sign' | 'onSigned',
  returned: PromiseLike<unknown>,
  consequence: string
): QbitProtocolError {
  void Promise.resolve(returned).catch(() => {})
  return new QbitProtocolError(
    'INVALID_SIGNER',
    `${callback} must be synchronous: it returned a promise, ${consequence}`
  )
}

function isThenable(value: unknown): value is PromiseLike<unknown> {
  return (
    (typeof value === 'object' || typeof value === 'function') &&
    value !== null &&
    typeof (value as { then?: unknown }).then === 'function'
  )
}

/**
 * Finalize P2MR inputs: build the witness qbit Core's `FinalizePSBT` builds
 * (`src/psbt.cpp:697` and `src/script/sign.cpp:699-741` @ v1.0.0, `7ebcddb6`),
 * store it as the final scriptwitness (0x08), and drop the now-redundant
 * partial fields and an empty final scriptSig (0x07). On an input it
 * finalizes, a non-empty 0x07 throws `INVALID_PSBT`: a P2MR spend's scriptSig
 * must be empty. An input that already has a final scriptwitness is left
 * untouched once that witness passes the limits `extractP2mrTransaction`
 * enforces, and its 0x07 is not checked; `extractP2mrTransaction` writes an
 * empty scriptSig for it either way.
 *
 * Leaves and signatures are read as `decodePsbt` reports them: one leaf per
 * (control block, script, leaf version) and one signature per (pubkey, leaf
 * hash), whether carried as `0x1d`/`0x19` or `qbit` `0x02`/`0x03`. Of the
 * leaves whose control block commits to the witness UTXO's program, each v1
 * `pk(K)` or `multi_a` leaf with signatures for `threshold` of its keys can be
 * finalized; the one with the smallest witness is used, ties going to the
 * bytewise-smallest script. Its witness is `[signature, leaf_script,
 * control_block]` for `pk`, and for `multi_a` one item per key, last key
 * first, each a signature until `threshold` are placed and empty otherwise,
 * then the script and control block. The shortest committing control block of
 * the leaf is used. Other leaves and signatures are ignored and dropped. If no
 * leaf qualifies, the input throws `INVALID_PSBT`. Signatures are not
 * verified.
 *
 * The signature's sighash type is enforced exactly as qbit Core's `FinalizePSBT`
 * enforces it: `FinalizePSBT` (`:697`) re-runs `SignPSBTInput` with the input's
 * `sighash_type`, which treats an absent `PSBT_IN_SIGHASH_TYPE` as
 * `SIGHASH_DEFAULT` for P2MR (`:530`) and returns `SIGHASH_MISMATCH` when any
 * P2MR signature on the input, used or not, carries any other type
 * (`:548-568` for the absent/DEFAULT case, `:589-596` when the field is
 * present and differs). Such an input throws `INVALID_SIGHASH` here instead of
 * being assembled into a witness. A non-default signature made by a signer
 * that omitted the field needs a matching `PSBT_IN_SIGHASH_TYPE` record (which
 * Core's own signer always writes, `:542-545`) before Core or this function
 * will finalize it.
 *
 * @param psbt - The signed PSBT.
 * @returns A new PSBT in which every input has a final scriptwitness; the
 * input PSBT is not modified.
 * @throws {QbitProtocolError} `INVALID_PSBT` if any input cannot be finalized,
 * including an input with no P2MR signature or witness UTXO, a non-P2MR
 * witness UTXO, a `qbit` Merkle root that differs from its program, or an
 * existing final scriptwitness over the limits. Every input is finalized or
 * none is.
 * @throws {QbitProtocolError} `INVALID_SIGHASH` for a signature whose type
 * breaks the rules above.
 * @throws {QbitProtocolError} Any other code {@link decodePsbt} throws, such
 * as `INVALID_AMOUNT`.
 *
 * @remarks
 * See
 * [Signing and finalization](https://github.com/Qbit-Org/qbit-js/blob/main/packages/protocol/docs/signing-and-finalization.md).
 *
 * @example
 * ```ts
 * import { bytesToHex, extractP2mrTransaction, finalizeP2mrPsbt } from '@qbit-oss/protocol'
 *
 * // signed: the PSBT signP2mrPsbt returned, or combinePsbts of co-signers' PSBTs
 * const finalized = finalizeP2mrPsbt(signed)
 * const rawTx = bytesToHex(extractP2mrTransaction(finalized)) // for sendrawtransaction
 * ```
 *
 * @category Signing
 */
export function finalizeP2mrPsbt(psbt: Psbt): Psbt {
  const summary = decodePsbt(psbt)
  const result: Psbt = {
    global: psbt.global.map(cloneEntry),
    inputs: psbt.inputs.map(map => map.map(cloneEntry)),
    outputs: psbt.outputs.map(map => map.map(cloneEntry)),
  }
  result.inputs.forEach((map, index) => {
    const existing = map.find(entry => entry.key.length === 1 && entry.key[0] === PSBT_IN_FINAL_SCRIPTWITNESS)
    if (existing !== undefined) {
      parseWitnessStack(existing.value)
      return
    }
    assertNoP2mrFinalScriptSig(map, index)
    const finalWitness = p2mrFinalWitness(summary.inputs[index]!, index)
    // Core omits an empty final scriptSig (psbt.h:503-507), so it is dropped too.
    const kept = map.filter(entry => !isCoreNonFinalInputField(entry) && !isFinalScriptSig(entry))
    kept.push({ key: Uint8Array.of(PSBT_IN_FINAL_SCRIPTWITNESS), value: finalWitness })
    result.inputs[index] = kept
  })
  return result
}

/** BIP174 PSBT_IN_FINAL_SCRIPTSIG. */
const PSBT_IN_FINAL_SCRIPTSIG = 0x07

interface PreparedP2mrSigning {
  tx: P2mrTransaction
  spentOutputs: readonly P2mrSpentOutput[]
  plans: PreparedP2mrSigningPlan[]
}

function prepareP2mrSigningPlans(
  psbt: Psbt,
  keys: readonly P2mrSigningKey[],
  options: P2mrSigningOptions = {}
): PreparedP2mrSigning {
  const tx = psbtUnsignedTransaction(psbt)
  const summary = decodePsbt(psbt)
  assertRestrictedOutputModeOutputs(tx.outputs, options.restrictedOutputMode)
  const spentOutputs = extractSpentOutputs(psbt)
  const midstates = precomputeSighashMidstates(tx, spentOutputs)
  const targets = new Set<string>()
  const inputHashTypes = new Map<number, number>()
  const plans: PreparedP2mrSigningPlan[] = []

  for (const key of keys) {
    if (!Number.isInteger(key.inputIndex) || key.inputIndex < 0 || key.inputIndex >= tx.inputs.length) {
      throw new QbitProtocolError('INVALID_PSBT', 'signing key inputIndex out of range')
    }

    // Check before copying: copying another view would convert it first.
    const { pubkey: pubkeyInput, leafHash: leafHashInput } = key
    assertByteLength(pubkeyInput, P2MR_PROGRAM_BYTES, 'P2MR signing pubkey')
    assertByteLength(leafHashInput, P2MR_PROGRAM_BYTES, 'P2MR signing leaf hash')
    const pubkey = copyBytes(pubkeyInput)
    const leafHash = copyBytes(leafHashInput)

    const hashType = key.hashType ?? SIGHASH_DEFAULT
    if (!isValidP2mrSighashType(hashType)) {
      throw new QbitProtocolError('INVALID_SIGHASH', 'invalid P2MR signing plan sighash type')
    }
    // Only a literal `true` opts in: the gate protects users from signatures
    // that do not commit to the transaction an approval UI showed them.
    if (hashType !== SIGHASH_DEFAULT && options.allowNonDefaultSighash !== true) {
      throw new QbitProtocolError(
        'INVALID_SIGHASH',
        `input ${key.inputIndex}: sighash type ${formatSighashType(hashType)} requires allowNonDefaultSighash: true; ` +
          'only SIGHASH_DEFAULT is accepted without an explicit opt-in'
      )
    }

    const target = `${key.inputIndex}:${bytesToHex(pubkey)}:${bytesToHex(leafHash)}`
    if (targets.has(target)) {
      throw new QbitProtocolError('INVALID_PSBT', `input ${key.inputIndex}: duplicate P2MR signing plan`)
    }
    targets.add(target)

    const input = summary.inputs[key.inputIndex]!
    if (input.finalized) {
      throw new QbitProtocolError('INVALID_PSBT', `input ${key.inputIndex}: input is already finalized`)
    }
    // finalizeP2mrPsbt would refuse this input whatever is signed.
    assertNoP2mrFinalScriptSig(psbt.inputs[key.inputIndex]!, key.inputIndex)
    if (input.scriptSigs.some(sig => bytesEqual(sig.pubkey, pubkey) && bytesEqual(sig.leafHash, leafHash))) {
      throw new QbitProtocolError('INVALID_PSBT', `input ${key.inputIndex}: signing plan already has a P2MR signature`)
    }
    // Core's SignPSBTInput SIGHASH_MISMATCH rules: the plan's type must equal the
    // input's PSBT_IN_SIGHASH_TYPE (if present) and the type of every P2MR
    // signature already on the input. Plans made in one call for the same input
    // are held to the same rule so an input never ends up with mixed types.
    if (input.sighashType !== undefined && input.sighashType !== hashType) {
      throw new QbitProtocolError(
        'INVALID_SIGHASH',
        `input ${key.inputIndex}: PSBT_IN_SIGHASH_TYPE ${formatSighashType(input.sighashType)} ` +
          `does not match the signing plan sighash type ${formatSighashType(hashType)}`
      )
    }
    const plannedHashType = inputHashTypes.get(key.inputIndex)
    if (plannedHashType !== undefined && plannedHashType !== hashType) {
      throw new QbitProtocolError(
        'INVALID_SIGHASH',
        `input ${key.inputIndex}: signing plans for one input must share a sighash type ` +
          `(${formatSighashType(plannedHashType)} and ${formatSighashType(hashType)})`
      )
    }
    inputHashTypes.set(key.inputIndex, hashType)
    for (const sig of input.scriptSigs) {
      if (sig.signature.hashType !== hashType) {
        throw new QbitProtocolError(
          'INVALID_SIGHASH',
          `input ${key.inputIndex}: existing P2MR signature uses sighash type ` +
            `${formatSighashType(sig.signature.hashType)} but the signing plan uses ${formatSighashType(hashType)}`
        )
      }
    }
    validateP2mrSigningPlan(input, key.inputIndex, pubkey, leafHash)

    plans.push({
      inputIndex: key.inputIndex,
      pubkey,
      leafHash,
      hashType,
      sighash: p2mrSighash({
        tx,
        inputIndex: key.inputIndex,
        spentOutputs,
        leafHash,
        hashType,
        midstates,
      }),
    })
  }

  assertFinalizeUsesP2mrPlans(summary, plans)
  return { tx, spentOutputs, plans }
}

/**
 * Refuse plans whose signatures `finalizeP2mrPsbt` would leave out. For each
 * input, finalize's own selection ({@link selectP2mrWitness}) runs over the
 * input's signatures plus a placeholder for each of the input's plans; a real
 * signature has the placeholder's length, so the witness sizes are exact. When
 * a witness is complete, it must place every plan, as qbit Core signs only the
 * leaf it finalizes and stops at its threshold (sign.cpp:592-613, :729-741).
 * When no leaf is complete, the plans must share one leaf hash, as a witness
 * reveals one leaf and Core signs only its best partial plan (sign.cpp:743-756);
 * plans on one leaf pass, so co-signers can complete a `multi_a` leaf in turn.
 */
function assertFinalizeUsesP2mrPlans(summary: PsbtSummary, plans: readonly PreparedP2mrSigningPlan[]): void {
  const placeholder = new Uint8Array(PQC_SIGNATURE_BYTES)
  const planned = new Map<number, P2mrPsbtScriptSigField[]>()
  for (const { inputIndex, pubkey, leafHash, hashType } of plans) {
    const sig: P2mrPsbtScriptSigField = {
      type: 'p2mrScriptSig',
      pubkey,
      leafHash,
      signature: { signature: placeholder, hashType, explicitHashType: hashType !== SIGHASH_DEFAULT },
    }
    const sigs = planned.get(inputIndex)
    if (sigs === undefined) planned.set(inputIndex, [sig])
    else sigs.push(sig)
  }
  for (const [inputIndex, sigs] of planned) {
    const input = summary.inputs[inputIndex]!
    const root = requireP2mrInputRoot(input, inputIndex)
    // The preflight refused a plan that repeats an existing signature, so no placeholder replaces one.
    const { witness } = selectP2mrWitness(input, [...input.scriptSigs, ...sigs], root)
    if (witness === undefined) {
      // A witness reveals one leaf and a signature commits to its leaf hash, so plans on two leaves
      // that complete neither spend a key use that finalize can never place (sign.cpp:743-756).
      const leafHashes = new Set(sigs.map(sig => bytesToHex(sig.leafHash)))
      if (leafHashes.size > 1) {
        throw new QbitProtocolError(
          'INVALID_PSBT',
          `input ${inputIndex}: this call plans signatures on ${leafHashes.size} leaves and completes none; ` +
            'finalizeP2mrPsbt uses one leaf'
        )
      }
      continue
    }
    const unused = sigs.find(sig => !witness.stack.includes(sig))
    if (unused !== undefined) {
      throw new QbitProtocolError(
        'INVALID_PSBT',
        `input ${inputIndex}: finalizeP2mrPsbt would not use the signature planned for pubkey ` +
          `${bytesToHex(unused.pubkey)} and leaf hash ${bytesToHex(unused.leafHash)}: the input's signatures ` +
          "and this call's other plans complete a witness without it"
      )
    }
  }
}

function validateP2mrSigningPlan(
  input: PsbtInputSummary,
  inputIndex: number,
  pubkey: Uint8Array,
  leafHash: Uint8Array
): void {
  const root = requireP2mrInputRoot(input, inputIndex)
  const leafHashHex = bytesToHex(leafHash)
  const leaf = groupP2mrInputLeaves(input.leafScripts, new Set([leafHashHex])).get(leafHashHex)
  if (leaf === undefined) {
    throw new QbitProtocolError(
      'INVALID_PSBT',
      `input ${inputIndex}: signing leaf hash does not match a PSBT leaf script`
    )
  }
  const { leafVersion, script } = leaf
  if (!p2mrSigningTemplateHasKey(leafVersion, script, pubkey)) {
    if (p2mrSigningTemplate(leafVersion, script) === undefined) {
      throw new QbitProtocolError(
        'INVALID_PSBT',
        `input ${inputIndex}: signing leaf is not a v1 pk/multi_a template containing this key`
      )
    }
    throw new QbitProtocolError(
      'INVALID_PSBT',
      `input ${inputIndex}: signing pubkey is not used by the selected P2MR leaf script`
    )
  }
  // The rule finalizeP2mrPsbt applies, so a leaf signed here is one it can put in the witness.
  if (committedP2mrControlBlock(leaf.controlBlocks, leafVersion, leafHash, root) === undefined) {
    throw new QbitProtocolError(
      'INVALID_PSBT',
      `input ${inputIndex}: P2MR control block does not commit to the witness UTXO program`
    )
  }
}

/**
 * The control block qbit Core puts in the witness for a leaf: of the leaf's
 * control blocks whose control byte carries the leaf's version and whose path
 * reaches `root`, the shortest, then the bytewise smallest. Core keeps a leaf's
 * control blocks in a shortest-first set (psbt.h:298) and takes the first that
 * commits (`FindValidP2MRControlBlock`, sign.cpp:616-631); a control block that
 * does not is skipped rather than rejected. `undefined` when none commits.
 */
function committedP2mrControlBlock(
  controlBlocks: readonly Uint8Array[],
  leafVersion: number,
  leafHash: Uint8Array,
  root: Uint8Array
): Uint8Array | undefined {
  const ordered = [...controlBlocks].sort((a, b) => a.length - b.length || compareBytes(a, b))
  return ordered.find(
    controlBlock =>
      (controlBlock[0]! & P2MR_LEAF_VERSION_MASK) === leafVersion &&
      bytesEqual(verifyControlBlock(controlBlock, leafHash), root)
  )
}

interface P2mrSigningTemplate {
  /** The keys in script order. */
  keys: Uint8Array[]
  threshold: number
}

/**
 * The pubkeys (in script order) and threshold of a P2MR leaf that qbit Core
 * would sign and finalize, or `undefined` when Core builds no signing plan for
 * the leaf. Mirrors qbit Core v1.0.0
 * `BuildP2MRScriptSigningPlan` (src/script/sign.cpp:503-511):
 *
 * - the leaf version is `P2MR_LEAF_VERSION_V1` (0xc0) (sign.cpp:506);
 * - the script is exactly `pk(K)`: `0x20 K OP_CHECKSIGPQC` (sign.cpp:313-320);
 * - or a `multi_a` matched by `p2mr::MatchMultiA` (src/script/p2mr.h:40-70,
 *   called at sign.cpp:323): n >= 1 groups of `0x20 K`, each followed by
 *   OP_CHECKSIGPQC for the first key and OP_CHECKSIGADD for the rest, with
 *   n <= MAX_PUBKEYS_PER_MULTI_A = 999 (src/script/script.h:37); then the
 *   threshold as a minimal script number in 1..n
 *   (src/script/scriptnum_parsing.h:22-39); then OP_NUMEQUAL as the last byte;
 * - the threshold is at most P2MR_V1_MAX_STANDARD_SIGNATURES = 35
 *   (sign.cpp:511, src/script/p2mr_sizing.h:18-24).
 *
 * Because the threshold is at most 35, its only minimal encodings are OP_1..OP_16
 * and a one-byte direct push of 17..35.
 */
function p2mrSigningTemplate(leafVersion: number, script: Uint8Array): P2mrSigningTemplate | undefined {
  const maxPubkeysPerMultiA = 999
  const maxStandardSignatures = 35
  const keyGroupBytes = 1 + P2MR_PROGRAM_BYTES + 1

  if (leafVersion !== P2MR_LEAF_VERSION_V1) return undefined
  if (
    script.length === keyGroupBytes &&
    script[0] === P2MR_PROGRAM_BYTES &&
    script[keyGroupBytes - 1] === OP_CHECKSIGPQC
  ) {
    return { keys: [script.subarray(1, keyGroupBytes - 1)], threshold: 1 }
  }

  const keys: Uint8Array[] = []
  let offset = 0
  while (script.length - offset >= keyGroupBytes) {
    if (script[offset] !== P2MR_PROGRAM_BYTES) return undefined
    const checksigOpcode = keys.length === 0 ? OP_CHECKSIGPQC : OP_CHECKSIGADD
    if (script[offset + keyGroupBytes - 1] !== checksigOpcode) return undefined
    keys.push(script.subarray(offset + 1, offset + keyGroupBytes - 1))
    offset += keyGroupBytes
  }
  if (keys.length === 0 || keys.length > maxPubkeysPerMultiA) return undefined
  if (script[script.length - 1] !== OP_NUMEQUAL) return undefined

  const thresholdOp = script.subarray(offset, script.length - 1)
  let threshold: number
  if (thresholdOp.length === 1 && thresholdOp[0]! >= OP_1 && thresholdOp[0]! <= OP_16) {
    threshold = thresholdOp[0]! - OP_1 + 1
  } else if (thresholdOp.length === 2 && thresholdOp[0] === 1 && thresholdOp[1]! > 16) {
    threshold = thresholdOp[1]!
  } else {
    return undefined
  }
  if (threshold > keys.length || threshold > maxStandardSignatures) return undefined
  return { keys, threshold }
}

/**
 * Whether qbit Core would sign `pubkey` in this leaf: the leaf is a v1 `pk(K)`
 * or Core-shaped `multi_a` (threshold <= 35) template, as accepted by
 * {@link p2mrSigningTemplate}, and `pubkey` is one of its keys.
 *
 * The signing preflight uses this instead of scanning the script for
 * `<pubkey> OP_CHECKSIGPQC|OP_CHECKSIGADD`, which also matched leaves that
 * Core never signs: a non-v1 leaf version (whose script consensus does not
 * execute), the key inside an OP_PUSHDATA payload, a non-minimal key push,
 * extra opcodes, or a threshold above 35. Core's wallet does not sign these
 * leaves: such a signature is never checked, can never verify, or sits in an
 * invalid or nonstandard witness.
 *
 * It also keeps OP_CODESEPARATOR out of signed leaves. The sighash is computed
 * with codeSeparatorPos 0xffffffff, as Core's signer hard-codes
 * (sign.cpp:118), while Core's interpreter commits to the position of the last
 * executed OP_CODESEPARATOR (src/script/interpreter.cpp:1170-1177), so a
 * signature checked after one would not verify. Neither template contains
 * OP_CODESEPARATOR, so the fixed position is right for every accepted leaf.
 */
function p2mrSigningTemplateHasKey(leafVersion: number, script: Uint8Array, pubkey: Uint8Array): boolean {
  const template = p2mrSigningTemplate(leafVersion, script)
  return template !== undefined && template.keys.some(key => bytesEqual(key, pubkey))
}

/**
 * One leaf of an input as Core stores it: a (script, leaf version) entry with
 * every control block it is carried with (psbt.h:298).
 */
interface P2mrInputLeaf {
  script: Uint8Array
  leafVersion: number
  leafHash: Uint8Array
  controlBlocks: Uint8Array[]
}

/**
 * Group an input's leaf records, as `decodePsbt` reports them, into Core's
 * (script, leaf version) entries, keyed by the leaf hash's hex, which commits
 * to both. Only leaves whose hash is in `wanted` are kept, so a PSBT dense
 * with leaf records costs no retained heap per record. The signing preflight
 * and `finalizeP2mrPsbt` read leaves only through this, so they agree on the
 * control blocks of each leaf.
 */
function groupP2mrInputLeaves(
  leafScripts: readonly P2mrPsbtLeafScriptField[],
  wanted: ReadonlySet<string>
): Map<string, P2mrInputLeaf> {
  const leaves = new Map<string, P2mrInputLeaf>()
  for (const { script, leafVersion, controlBlock } of leafScripts) {
    const leafHash = p2mrLeafHash(leafVersion, script)
    const leafHashHex = bytesToHex(leafHash)
    if (!wanted.has(leafHashHex)) continue
    const existing = leaves.get(leafHashHex)
    if (existing !== undefined) {
      existing.controlBlocks.push(controlBlock)
    } else {
      leaves.set(leafHashHex, { script, leafVersion, leafHash, controlBlocks: [controlBlock] })
    }
  }
  return leaves
}

/** The witness `finalizeP2mrPsbt` chooses for an input, before it is encoded. */
interface P2mrWitnessChoice {
  /** One entry per key of the leaf, last key first: the signature placed there, or `undefined` for an empty item. */
  stack: (P2mrPsbtScriptSigField | undefined)[]
  script: Uint8Array
  controlBlock: Uint8Array
}

interface P2mrWitnessSelection {
  /** `undefined` when no committed leaf has enough signatures. */
  witness: P2mrWitnessChoice | undefined
  /** Some v1 `pk` or `multi_a` leaf has a signature for one of its keys. */
  signedLeaf: boolean
  /** Some such leaf also has a control block that commits to the root. */
  committedLeaf: boolean
}

/**
 * The witness qbit Core's `FinalizePSBT` chooses for a P2MR input from its
 * leaves and `sigs`, one per (pubkey, leaf hash). It runs `SignPSBTInput` with
 * no keys (psbt.cpp:697), so only these signatures count:
 *
 * - each leaf is a (script, leaf version) entry with its committing control
 *   block ({@link committedP2mrControlBlock}). Only a v1 `pk` or `multi_a`
 *   leaf ({@link p2mrSigningTemplate}) with at least one signature gets a plan,
 *   and the plan is complete when signatures for `threshold` of its keys are
 *   present (`BuildP2MRScriptSigningPlan`, sign.cpp:503-590). Signatures and
 *   leaves for anything else are ignored;
 * - of the complete plans, the one with the smallest witness wins, ties going
 *   to the bytewise-smallest script (sign.cpp:716-741). Its stack holds, from
 *   the last key to the first, a signature while fewer than `threshold` are
 *   placed and an empty item otherwise, then the script and control block
 *   (`SignP2MRScript`, sign.cpp:592-614).
 *
 * `finalizeP2mrPsbt` runs this on the input's signatures, and the signing
 * preflight on those plus a placeholder for each planned signature, so a plan
 * passes only when the witness finalize will choose places it.
 *
 * The stack-size and weight checks of `BuildP2MRScriptSigningPlan`
 * (sign.cpp:565-577) always pass for these templates: at most 999 keys and 35
 * signatures of at most 3,681 bytes, and each signature adds at least as many
 * witness bytes as the 3,683 weight it costs. Signatures are not verified, so
 * one that does not verify is chosen where Core would report
 * `INVALID_P2MR_SIGNATURE`.
 */
function selectP2mrWitness(
  input: PsbtInputSummary,
  sigs: readonly P2mrPsbtScriptSigField[],
  root: Uint8Array
): P2mrWitnessSelection {
  const sigsById = new Map<string, P2mrPsbtScriptSigField>()
  const signedLeafHashes = new Set<string>()
  for (const sig of sigs) {
    const leafHashHex = bytesToHex(sig.leafHash)
    sigsById.set(bytesToHex(sig.pubkey) + leafHashHex, sig)
    signedLeafHashes.add(leafHashHex)
  }

  let best: (P2mrWitnessChoice & { size: number }) | undefined
  let signedLeaf = false
  let committedLeaf = false
  for (const [leafHashHex, leaf] of groupP2mrInputLeaves(input.leafScripts, signedLeafHashes)) {
    const template = p2mrSigningTemplate(leaf.leafVersion, leaf.script)
    if (template === undefined) continue
    const { keys, threshold } = template
    const stack: (P2mrPsbtScriptSigField | undefined)[] = []
    let placed = 0
    for (let i = keys.length - 1; i >= 0; i -= 1) {
      const sig = placed < threshold ? sigsById.get(bytesToHex(keys[i]!) + leafHashHex) : undefined
      if (sig !== undefined) placed += 1
      stack.push(sig)
    }
    if (placed === 0) continue
    signedLeaf = true
    const controlBlock = committedP2mrControlBlock(leaf.controlBlocks, leaf.leafVersion, leaf.leafHash, root)
    if (controlBlock === undefined) continue
    committedLeaf = true
    if (placed < threshold) continue
    // The serialized witness size, as Core's GetSerializeSize(estimated_stack).
    const itemLengths = stack.map(sig =>
      sig === undefined ? 0 : sig.signature.signature.length + (sig.signature.hashType === SIGHASH_DEFAULT ? 0 : 1)
    )
    itemLengths.push(leaf.script.length, controlBlock.length)
    let size = compactSize(itemLengths.length).length
    for (const length of itemLengths) size += compactSize(length).length + length
    if (best === undefined || size < best.size || (size === best.size && compareBytes(leaf.script, best.script) < 0)) {
      best = { stack, script: leaf.script, controlBlock, size }
    }
  }
  return { witness: best, signedLeaf, committedLeaf }
}

/**
 * The final witness qbit Core's `FinalizePSBT` builds for a P2MR input. Every
 * P2MR signature on the input must carry the input's sighash type,
 * `SIGHASH_DEFAULT` when `PSBT_IN_SIGHASH_TYPE` is absent (psbt.cpp:530,
 * :548-568, :589-596), or the input fails with `SIGHASH_MISMATCH`, even when
 * the signature is not used. The witness is then the one
 * {@link selectP2mrWitness} chooses.
 */
function p2mrFinalWitness(input: PsbtInputSummary, inputIndex: number): Uint8Array {
  const root = requireP2mrInputRoot(input, inputIndex)
  const requiredHashType = input.sighashType ?? SIGHASH_DEFAULT
  for (const sig of input.scriptSigs) {
    if (sig.signature.hashType !== requiredHashType) {
      const required =
        input.sighashType === undefined
          ? 'SIGHASH_DEFAULT implied by the absent PSBT_IN_SIGHASH_TYPE field'
          : `PSBT_IN_SIGHASH_TYPE ${formatSighashType(input.sighashType)}`
      throw new QbitProtocolError(
        'INVALID_SIGHASH',
        `input ${inputIndex}: P2MR signature sighash type ${formatSighashType(sig.signature.hashType)} ` +
          `does not match the input's ${required}`
      )
    }
  }
  if (input.scriptSigs.length === 0) {
    throw new QbitProtocolError('INVALID_PSBT', `input ${inputIndex}: no P2MR script signature to finalize`)
  }

  const { witness, signedLeaf, committedLeaf } = selectP2mrWitness(input, input.scriptSigs, root)
  if (witness === undefined) {
    if (!signedLeaf) {
      throw new QbitProtocolError(
        'INVALID_PSBT',
        `input ${inputIndex}: no P2MR script signature is for a key of a v1 pk or multi_a leaf script on the input`
      )
    }
    if (!committedLeaf) {
      throw new QbitProtocolError(
        'INVALID_PSBT',
        `input ${inputIndex}: P2MR control block does not commit to the witness UTXO program`
      )
    }
    throw new QbitProtocolError(
      'INVALID_PSBT',
      `input ${inputIndex}: no committed P2MR leaf has enough signatures to finalize`
    )
  }
  const items = witness.stack.map(sig =>
    sig === undefined ? new Uint8Array() : encodeP2mrWitnessSignature(sig.signature.signature, sig.signature.hashType)
  )
  return serializeWitnessStack([...items, witness.script, witness.controlBlock])
}

function isFinalScriptSig(entry: PsbtKeyValue): boolean {
  return entry.key.length === 1 && entry.key[0] === PSBT_IN_FINAL_SCRIPTSIG
}

/**
 * Core treats an input with a non-empty final scriptSig (0x07) as already final
 * (psbt.cpp:345-348), so it neither signs nor finalizes it (psbt.cpp:110-119,
 * sign.cpp:1315), and a P2MR spend must have an empty scriptSig
 * (interpreter.cpp:2459-2461).
 */
function assertNoP2mrFinalScriptSig(map: readonly PsbtKeyValue[], inputIndex: number): void {
  if (map.some(entry => isFinalScriptSig(entry) && entry.value.length > 0)) {
    throw new QbitProtocolError('INVALID_PSBT', `input ${inputIndex}: a P2MR input cannot carry a final scriptSig`)
  }
}

function requireP2mrInputRoot(input: PsbtInputSummary, inputIndex: number): Uint8Array {
  const scriptPubKey = input.witnessUtxo?.scriptPubKey
  if (scriptPubKey === undefined) {
    throw new QbitProtocolError('INVALID_PSBT', `input ${inputIndex}: missing witness UTXO`)
  }
  if (
    scriptPubKey.length !== 2 + P2MR_PROGRAM_BYTES ||
    scriptPubKey[0] !== OP_2 ||
    scriptPubKey[1] !== P2MR_PROGRAM_BYTES
  ) {
    throw new QbitProtocolError('INVALID_PSBT', `input ${inputIndex}: witness UTXO is not an OP_2 PUSH32 P2MR output`)
  }

  const root = copyBytes(scriptPubKey, 2)
  if (input.merkleRoot !== undefined && !bytesEqual(input.merkleRoot, root)) {
    throw new QbitProtocolError(
      'INVALID_PSBT',
      `input ${inputIndex}: P2MR merkle root does not match the witness UTXO program`
    )
  }
  return root
}

function p2mrLeafScriptUsesPubkey(script: Uint8Array, pubkey: Uint8Array): boolean {
  let offset = 0
  let pushedValue: Uint8Array | undefined
  while (offset < script.length) {
    const opcode = script[offset++]!
    if (opcode >= 1 && opcode <= 75) {
      if (offset + opcode > script.length) return false
      pushedValue = script.subarray(offset, offset + opcode)
      offset += opcode
      continue
    }
    if (
      (opcode === OP_CHECKSIGPQC || opcode === OP_CHECKSIGADD) &&
      pushedValue !== undefined &&
      bytesEqual(pushedValue, pubkey)
    ) {
      return true
    }
    pushedValue = undefined
  }
  return false
}

function extractSpentOutputs(psbt: Psbt): P2mrSpentOutput[] {
  return psbt.inputs.map((map, index) => {
    const entry = map.find(item => item.key.length === 1 && item.key[0] === PSBT_IN_WITNESS_UTXO)
    if (entry === undefined) {
      throw new QbitProtocolError('INVALID_PSBT', `input ${index} is missing a witness UTXO`)
    }
    return parseTxOut(entry.value, `input ${index} witness UTXO value`)
  })
}

/**
 * Whether an input-map entry is a field Core drops once the input is finalized,
 * so `finalizeP2mrPsbt` drops it too. Core writes these fields only while the
 * input has no final scriptSig or scriptWitness (psbt.h:342-501): partial
 * signatures (0x02), sighash type (0x03), redeem and witness scripts (0x04,
 * 0x05), BIP32 derivations (0x06), hash preimages (0x0a-0x0d), the Taproot,
 * P2MR and MuSig2 fields (0x13-0x1d), and the `qbit` proprietary P2MR merkle
 * root, leaf script and script sig (subtypes 1-3). Core keeps every other field
 * on a finalized input: the UTXOs (0x00, 0x01; psbt.h:331-340), the final
 * scriptSig and scriptWitness (0x07, 0x08; psbt.h:503-512), other proprietary
 * records, including unknown `qbit` subtypes, and unknown key types
 * (psbt.h:514-524).
 */
function isCoreNonFinalInputField(entry: PsbtKeyValue): boolean {
  const keyType = entry.key[0]
  if (keyType === undefined) return false
  if (keyType === PSBT_IN_PROPRIETARY) {
    const proprietary = parseProprietaryKey(entry.key)
    return (
      bytesEqual(proprietary.identifier, asciiBytes(PSBT_QBIT_IDENTIFIER)) &&
      proprietary.subtype >= PSBT_QBIT_IN_P2MR_MERKLE_ROOT &&
      proprietary.subtype <= PSBT_QBIT_IN_P2MR_SCRIPT_SIG
    )
  }
  return (
    (keyType >= 0x02 && keyType <= 0x06) || (keyType >= 0x0a && keyType <= 0x0d) || (keyType >= 0x13 && keyType <= 0x1d)
  )
}

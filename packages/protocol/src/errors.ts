import type { Psbt } from './psbt'
import type { P2mrSigningPlanRef } from './signing'

/**
 * The `code` of a {@link QbitProtocolError}:
 *
 * - `UNKNOWN_NETWORK`: a network name that is not in {@link qbitNetworks}. A
 *   name `Object.prototype` defines, such as `'toString'`, does not throw it;
 *   see {@link getQbitNetwork}.
 * - `INVALID_BECH32`: a malformed bech32 string: longer than 90 characters,
 *   not printable ASCII, mixed case, or a bad separator, character, checksum
 *   or padding.
 * - `WRONG_HRP`: an address HRP that no qbit network uses or that is not the
 *   expected network's, or network parameters whose HRP is not printable
 *   lowercase ASCII.
 * - `WRONG_ENCODING`: a bech32 address where P2MR needs bech32m.
 * - `WRONG_WITNESS_VERSION`: an address whose witness version is not 2.
 * - `WRONG_PROGRAM_LENGTH`: an address whose witness program is not 32 bytes.
 * - `INVALID_BYTES`: a byte input that is not a `Uint8Array` or has the wrong
 *   length, malformed hex, or a wallet message with a lone UTF-16 surrogate.
 * - `INVALID_SCRIPT`: a malformed script, leaf version, witness signature item
 *   or sighash type in one, or control block outside a PSBT record (in one,
 *   it is `INVALID_PSBT`), an output qbit's restricted-output mode rejects, or
 *   a message proof whose leaf does not match its key or address.
 * - `INVALID_URI`: a `qbit:` URI with no address, a `#` fragment, a malformed
 *   percent-escape, an invalid amount, a payment field name that is not
 *   lowercase ASCII, a repeated payment field or an unsupported `req-`
 *   parameter, or a `formatQbitUri` label or message with a lone UTF-16
 *   surrogate.
 * - `WRONG_URI_SCHEME`: a URI whose scheme is not `qbit:` (in any case), or
 *   that starts with `qbit://`.
 * - `INVALID_DESCRIPTOR`: a malformed or unsupported descriptor, checksum or
 *   import request.
 * - `INVALID_PSBT`: a malformed PSBT, one over its decoding limits, or one
 *   that cannot be signed or finalized as asked.
 * - `INVALID_SIGHASH`: an invalid sighash type given to a sighash function or
 *   signing plan, a type the signing and finalization rules refuse, or a
 *   sighash request with a bad input index, `spentOutputs` count or leaf hash,
 *   or `SIGHASH_SINGLE` without a matching output. An invalid
 *   `PSBT_IN_SIGHASH_TYPE` record is `INVALID_PSBT`.
 * - `INVALID_AMOUNT`: an amount or total outside `MoneyRange`, or outputs that
 *   exceed the inputs.
 * - `INVALID_INTEGER`: a transaction integer field outside its uint32 or uint8
 *   range.
 * - `SIGNING_FAILED`: a {@link P2mrPsbtSigningError}.
 * - `INVALID_SIGNER`: a `sign` that is not a function, or an `onSigned` that
 *   is neither a function nor `undefined`. A callback that returns a promise,
 *   or a `sign` result that is neither a `Uint8Array` nor `undefined`, throws
 *   `SIGNING_FAILED` with an `INVALID_SIGNER` error as its `cause`.
 *
 * @remarks
 * An error from another version of this package can carry a code this list
 * does not include, so keep a default branch when switching on it. See
 * [Error classification](https://github.com/Qbit-Org/qbit-js/blob/main/packages/protocol/docs/error-classification.md).
 *
 * @category Errors
 */
export type QbitProtocolErrorCode =
  | 'UNKNOWN_NETWORK'
  | 'INVALID_BECH32'
  | 'WRONG_HRP'
  | 'WRONG_ENCODING'
  | 'WRONG_WITNESS_VERSION'
  | 'WRONG_PROGRAM_LENGTH'
  | 'INVALID_BYTES'
  | 'INVALID_SCRIPT'
  | 'INVALID_URI'
  | 'WRONG_URI_SCHEME'
  | 'INVALID_DESCRIPTOR'
  | 'INVALID_PSBT'
  | 'INVALID_SIGHASH'
  | 'INVALID_AMOUNT'
  | 'INVALID_INTEGER'
  | 'SIGNING_FAILED'
  | 'INVALID_SIGNER'

/** Brands shared by every copy of these classes: `Symbol.for` keys are global across builds and realms. */
const QBIT_PROTOCOL_ERROR_BRAND = Symbol.for('qbit-js.QbitProtocolError')
const P2MR_PSBT_SIGNING_ERROR_BRAND = Symbol.for('qbit-js.P2mrPsbtSigningError')

function hasBrand(value: unknown, brand: symbol): boolean {
  return typeof value === 'object' && value !== null && (value as Record<symbol, unknown>)[brand] === true
}

/**
 * The error this package throws for invalid input, with a
 * {@link QbitProtocolErrorCode} in `code`.
 *
 * @remarks
 * Some programming errors throw a plain `TypeError` or `RangeError` instead.
 * A function's `@throws` does not list every one: an argument of the wrong
 * type, such as a hex string where a `Uint8Array` belongs, can also throw a
 * `TypeError` from inside the function. Recognize this error with
 * {@link QbitProtocolError.is} rather than `instanceof` where an app can load
 * more than one copy of this package. See
 * [Error classification](https://github.com/Qbit-Org/qbit-js/blob/main/packages/protocol/docs/error-classification.md).
 *
 * @category Errors
 */
export class QbitProtocolError extends Error {
  /** What was wrong; see {@link QbitProtocolErrorCode}. */
  readonly code: QbitProtocolErrorCode

  /**
   * Whether `value` is a `QbitProtocolError` (or a subclass instance, such as
   * `P2mrPsbtSigningError`) from any copy of `@qbit-oss/protocol`.
   * `instanceof` only recognizes errors from the same copy, so it is false
   * when an app loads both the CommonJS and the ESM build (or two installed
   * versions) and the error comes from the other one. This checks a brand,
   * `Symbol.for('qbit-js.QbitProtocolError')`, set on the class prototype
   * instead. It identifies the class, not where the error came from: any code
   * can set the brand. An error from another version can carry a `code` this
   * version does not list, so keep a default branch when switching on it.
   */
  static is(value: unknown): value is QbitProtocolError {
    return hasBrand(value, QBIT_PROTOCOL_ERROR_BRAND)
  }

  constructor(code: QbitProtocolErrorCode, message: string) {
    super(message)
    this.name = 'QbitProtocolError'
    this.code = code
  }
}

Object.defineProperty(QbitProtocolError.prototype, QBIT_PROTOCOL_ERROR_BRAND, { value: true })

/**
 * Which step of a signing plan raised a `P2mrPsbtSigningError`.
 *
 * @category Errors
 */
export type P2mrPsbtSigningPhase = 'sign' | 'onSigned'

/**
 * Thrown by `signP2mrPsbt` when a plan's `sign` call throws, returns a
 * thenable, or returns an invalid signature, or when `onSigned` throws or
 * returns a thenable. Nothing produced before the failure is lost: `psbt`
 * holds every signature made so far and `signed` lists them. `failed` is the
 * plan being processed when `cause` was raised, and `phase` says how far it
 * got:
 *
 * - `'sign'`: the signer was invoked for `failed` but no signature was stored,
 *   so `failed` is not in `signed`. A stateful signer must still treat that
 *   key use as consumed.
 * - `'onSigned'`: the signature for `failed` was validated and stored, so
 *   `failed` is the last entry of `signed` and its field is in `psbt`; only
 *   the callback failed.
 *
 * Retry contract: call `signP2mrPsbt` again with `psbt` and only the keys that
 * are not listed in `signed`. A key whose signature is already present makes
 * the call throw `INVALID_PSBT` before any signer call, so a plan whose
 * signature is stored is never sent to the signer again. A plan that failed in
 * phase `'sign'` has no stored signature, so the retry sends it to the signer
 * again with the same digest: a stateful signer must already have recorded
 * that key use when `sign` was called (see {@link P2mrPsbtSignFn}), and decide
 * from that record whether it may sign again. If it may not, throwing would
 * stop the retry at the same plan again, so drop its entry from the retry's
 * `keys` (or have `sign` return `undefined` for it, which skips the plan).
 * Then drop every entry that can no longer help finalize the transaction:
 * the other entries for a leaf that cannot complete without that key (a
 * `multi_a` leaf left short of its threshold, say), and every entry when an
 * input is left with no leaf that can complete, since the transaction can
 * then never be finalized. Signing those would spend key uses for nothing.
 *
 * @remarks
 * Its `code` is always `SIGNING_FAILED`. Recognize it with
 * {@link P2mrPsbtSigningError.is}. See
 * [Signing and finalization](https://github.com/Qbit-Org/qbit-js/blob/main/packages/protocol/docs/signing-and-finalization.md) and
 * [Error classification](https://github.com/Qbit-Org/qbit-js/blob/main/packages/protocol/docs/error-classification.md).
 *
 * @category Errors
 */
export class P2mrPsbtSigningError extends QbitProtocolError {
  /** The PSBT with every signature stored before the failure. */
  readonly psbt: Psbt
  /** The plans whose signatures are in `psbt`, in signing order. */
  readonly signed: P2mrSigningPlanRef[]
  /** The plan being processed when the failure happened. */
  readonly failed: P2mrSigningPlanRef
  /** How far `failed` got: see {@link P2mrPsbtSigningPhase}. */
  readonly phase: P2mrPsbtSigningPhase
  /**
   * What `sign` or `onSigned` threw, or the `INVALID_SIGNER` or
   * `INVALID_BYTES` `QbitProtocolError` for a promise or invalid signature it
   * returned.
   */
  readonly cause: unknown

  /**
   * Whether `value` is a `P2mrPsbtSigningError` from any copy of
   * `@qbit-oss/protocol`, by its brand
   * `Symbol.for('qbit-js.P2mrPsbtSigningError')`; see `QbitProtocolError.is`.
   */
  static override is(value: unknown): value is P2mrPsbtSigningError {
    return hasBrand(value, P2MR_PSBT_SIGNING_ERROR_BRAND)
  }

  constructor(params: {
    psbt: Psbt
    signed: P2mrSigningPlanRef[]
    failed: P2mrSigningPlanRef
    phase: P2mrPsbtSigningPhase
    cause: unknown
  }) {
    super(
      'SIGNING_FAILED',
      `input ${params.failed.inputIndex}: P2MR signing failed in ${params.phase} after ` +
        `${params.signed.length} signature(s): ${describeThrown(params.cause)}`
    )
    this.name = 'P2mrPsbtSigningError'
    this.psbt = params.psbt
    this.signed = params.signed
    this.failed = params.failed
    this.phase = params.phase
    this.cause = params.cause
  }
}

Object.defineProperty(P2mrPsbtSigningError.prototype, P2MR_PSBT_SIGNING_ERROR_BRAND, { value: true })

function describeThrown(cause: unknown): string {
  if (cause instanceof Error) return cause.message
  try {
    return String(cause)
  } catch {
    return 'non-Error value thrown'
  }
}

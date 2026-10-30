import { QbitProtocolError } from './errors'
import {
  P2MR_WITNESS_VERSION,
  P2MR_PROGRAM_BYTES,
  OP_0,
  OP_1,
  OP_16,
  OP_RETURN,
  PAY_TO_ANCHOR_SCRIPT,
  PQC_SIGNATURE_BYTES,
} from './constants'
import { bytesEqual, assertBytes, bytesToHex } from './bytes'
import type { createP2mrPsbt } from './psbt'
import type { multiALeafScript } from './scripts'
import type { signP2mrPsbt, validateP2mrSigningPlans } from './signing'

/**
 * Coinbase outputs are spendable only after this many confirmations on every
 * qbit network (qbit Core `src/consensus/consensus.h` `COINBASE_MATURITY`).
 *
 * @remarks
 * No helper in this package applies it, so wallet coin selection must. See
 * [Features](https://github.com/Qbit-Org/qbit-js/blob/main/packages/protocol/docs/features.md).
 *
 * @category Consensus limits
 */
export const QBIT_COINBASE_MATURITY = 1000
/**
 * No amount larger than this (in satoshis) is valid on any qbit network
 * (qbit Core `src/consensus/amount.h`: `MAX_MONEY = 210000000 * COIN`,
 * `COIN = 1e8`). It is a consensus-critical sanity bound, not the total money
 * supply.
 *
 * @remarks
 * A `bigint`: 21,000,000,000,000,000 satoshis, which is 210,000,000 QBT. Every
 * amount this package serializes, hashes or signs must be in
 * `[0, QBIT_MAX_MONEY]`, qbit Core's `MoneyRange` (see {@link assertMoneyRange}
 * and [Consensus checks](https://github.com/Qbit-Org/qbit-js/blob/main/packages/protocol/docs/consensus-checks.md)).
 *
 * @category Consensus limits
 */
export const QBIT_MAX_MONEY = 21_000_000_000_000_000n

// qbit Core MAX_P2MR_V1_STACK_ITEM_SIZE and MAX_P2MR_V1_TOTAL_INITIAL_STACK_BYTES
// (src/script/script.h:46, :49): consensus caps on each item and on the whole
// initial P2MR v1 witness stack (src/script/interpreter.cpp:37-47, :2395).
const P2MR_V1_MAX_INITIAL_STACK_ITEM_BYTES = 16384
const P2MR_V1_MAX_TOTAL_INITIAL_STACK_BYTES = 131072
// qbit Core P2MR_V1_MAX_SIGNATURE_ITEM_SIZE (src/script/p2mr_sizing.h:16): a PQC
// signature plus an explicit sighash byte.
const P2MR_V1_MAX_SIGNATURE_ITEM_BYTES = PQC_SIGNATURE_BYTES + 1
/**
 * Highest `multi_a`/`sortedmulti_a` threshold a P2MR v1 leaf can ever be spent
 * with: qbit Core P2MR_V1_MAX_STANDARD_SIGNATURES (src/script/p2mr_sizing.h:16-24),
 * which is P2MR_V1_MAX_TOTAL_INITIAL_STACK_BYTES (131072) divided by the largest
 * signature item (PQC_SIGNATURE_BYTES + 1 sighash byte = 3681), i.e. 35. Each
 * signature item is at least PQC_SIGNATURE_BYTES, so 36 of them (132480 bytes)
 * always exceed the consensus initial-stack limit.
 *
 * @remarks
 * {@link multiALeafScript} refuses higher thresholds; descriptors with them
 * still parse. See
 * [P2MR Descriptors](https://github.com/Qbit-Org/qbit-js/blob/main/packages/protocol/docs/p2mr-descriptors.md).
 *
 * @category Consensus limits
 */
export const P2MR_V1_MAX_MULTI_A_THRESHOLD =
  // Core static_asserts that a signature item fits one stack item
  // (p2mr_sizing.h:21); if it did not, no multi_a leaf could be spent.
  P2MR_V1_MAX_SIGNATURE_ITEM_BYTES <= P2MR_V1_MAX_INITIAL_STACK_ITEM_BYTES
    ? Math.floor(P2MR_V1_MAX_TOTAL_INITIAL_STACK_BYTES / P2MR_V1_MAX_SIGNATURE_ITEM_BYTES)
    : 0
// qbit Core MAX_PUBKEYS_PER_MULTI_A (src/script/script.h:37).
const P2MR_MAX_MULTI_A_PUBKEYS = 999

/**
 * qbit Core `MoneyRange`: an amount is a bigint satoshi count in
 * `[0, QBIT_MAX_MONEY]`. Throws `INVALID_AMOUNT` for anything else (including
 * non-bigint values), so an out-of-range amount is never serialized, hashed or
 * signed in int64-wrapped form.
 *
 * @param value - The amount in satoshis.
 * @param name - What to call the amount in the error message. Default
 * `'amount'`.
 * @throws {QbitProtocolError} `INVALID_AMOUNT` if `value` is not a `bigint` in
 * `[0, QBIT_MAX_MONEY]`.
 *
 * @remarks
 * See [Consensus checks](https://github.com/Qbit-Org/qbit-js/blob/main/packages/protocol/docs/consensus-checks.md).
 *
 * @category Consensus limits
 */
export function assertMoneyRange(value: bigint, name = 'amount'): void {
  if (typeof value !== 'bigint') {
    throw new QbitProtocolError('INVALID_AMOUNT', `${name} must be a bigint amount in satoshis`)
  }
  if (value < 0n || value > QBIT_MAX_MONEY) {
    throw new QbitProtocolError('INVALID_AMOUNT', `${name} ${value} is outside MoneyRange [0, ${QBIT_MAX_MONEY}]`)
  }
}

/**
 * Transaction integer fields (`version`, `locktime`, `vout`, `sequence`,
 * `codeSeparatorPos`) are uint32. Throws `INVALID_INTEGER` for non-integers,
 * non-finite values and anything outside `[0, 0xffffffff]` instead of the
 * silent modulo-2^32 wrap of `>>> 0`. `version` is included because qbit Core
 * stores `CTransaction::version` as `uint32_t` (Bitcoin Core 28.0+); the legacy
 * int32 spelling `-1` is `0xffffffff` here, not a second accepted encoding.
 *
 * @param value - The field's value.
 * @param name - What to call the field in the error message.
 * @throws {QbitProtocolError} `INVALID_INTEGER` if `value` is not a number
 * that is an integer in `[0, 0xffffffff]`.
 *
 * @remarks
 * See [Consensus checks](https://github.com/Qbit-Org/qbit-js/blob/main/packages/protocol/docs/consensus-checks.md).
 *
 * @category Consensus limits
 */
export function assertUint32(value: number, name: string): void {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > 0xffffffff) {
    throw new QbitProtocolError('INVALID_INTEGER', `${name} ${String(value)} must be an integer in [0, 4294967295]`)
  }
}

/**
 * Options for {@link isRestrictedOutputModeOutput}.
 *
 * @category Consensus limits
 */
export interface RestrictedOutputModeOptions {
  /**
   * Also allow qbit Core's reserved future witness outputs (witness v3..v16
   * with a 2..40-byte program), as Core does once
   * `OuterReservedWitnessActiveAtHeight` holds: at every height on mainnet,
   * testnet4 and signet (`nOuterReservedWitnessHeight = 0`,
   * src/kernel/chainparams.cpp:146,347,471), and on regtest only after
   * `-testactivationheight=outerwitness@<height>` (:557). Pass `true` for
   * Core's exact consensus answer on those networks.
   *
   * Default `false`. Such outputs are non-standard on every network
   * (src/policy/policy.cpp:156), so a default node never relays a transaction
   * that creates one, and until a soft fork gives them meaning anyone can
   * spend them.
   */
  reservedWitnessActive?: boolean
}

/**
 * Whether qbit Core's restricted-output mode allows an output with this
 * scriptPubKey (`Consensus::IsRestrictedOutputModeConsensusOutput`,
 * src/consensus/restricted_outputs.h:18-39 @ v1.0.0). Consensus allows only:
 *
 * - P2MR: witness v2 with a 32-byte program (`OP_2 <32 bytes>`);
 * - any script that starts with `OP_RETURN`, whatever follows and however long;
 * - P2A, the pay-to-anchor script `OP_1 <0x4e73>` (`51024e73`);
 * - with `reservedWitnessActive: true`, witness v3..v16 with a 2..40-byte
 *   program.
 *
 * Any other output, including P2PKH, P2SH, P2WPKH, P2WSH, P2TR, any other
 * witness v0, v1 or v2 program, a bare script and the empty script, makes the
 * transaction consensus-invalid. Core rejects it from the mempool with
 * `tx-output-not-p2mr` (src/validation.cpp:849) and in a block with
 * `bad-txns-output-not-p2mr` (:2855-2859). The mode is on for mainnet,
 * testnet4 and signet, and on regtest unless the node runs with
 * `-p2mronly=0` (src/kernel/chainparams.cpp:159,360,482,571,
 * src/chainparams.cpp:49).
 *
 * This is the consensus rule, not relay policy. An `OP_RETURN` output whose
 * data is not push-only, or `OP_RETURN` data beyond the node's
 * `-datacarriersize` (default 200,000 bytes over the whole transaction), is
 * allowed here but non-standard (src/script/solver.cpp:164,
 * src/policy/policy.cpp:161-167).
 *
 * @param scriptPubKey - The output script.
 * @param options - `reservedWitnessActive` also allows reserved witness
 * outputs. Default `{}`.
 * @returns Whether consensus allows the output in restricted-output mode.
 * @throws {QbitProtocolError} `INVALID_BYTES` if `scriptPubKey` is not a `Uint8Array`.
 *
 * @remarks
 * {@link createP2mrPsbt}, {@link validateP2mrSigningPlans} and
 * {@link signP2mrPsbt} apply this check, with reserved witness outputs
 * refused, unless `restrictedOutputMode: false` is passed. See
 * [Consensus checks](https://github.com/Qbit-Org/qbit-js/blob/main/packages/protocol/docs/consensus-checks.md).
 *
 * @category Consensus limits
 */
export function isRestrictedOutputModeOutput(
  scriptPubKey: Uint8Array,
  options: RestrictedOutputModeOptions = {}
): boolean {
  assertBytes(scriptPubKey, 'scriptPubKey')
  if (scriptPubKey[0] === OP_RETURN || bytesEqual(scriptPubKey, PAY_TO_ANCHOR_SCRIPT)) return true
  const version = witnessProgramVersion(scriptPubKey)
  if (version === P2MR_WITNESS_VERSION) return scriptPubKey.length === 2 + P2MR_PROGRAM_BYTES
  return version !== undefined && version >= 3 && options.reservedWitnessActive === true
}

/** qbit Core `CScript::IsWitnessProgram` (src/script/script.cpp:256-270): the witness version, if any. */
function witnessProgramVersion(script: Uint8Array): number | undefined {
  if (script.length < 4 || script.length > 42 || script[1]! + 2 !== script.length) return undefined
  const opcode = script[0]!
  if (opcode === OP_0) return 0
  return opcode >= OP_1 && opcode <= OP_16 ? opcode - OP_1 + 1 : undefined
}

/**
 * Refuse outputs that qbit Core's restricted-output mode rejects, so no
 * signature is spent on a transaction that can never confirm. Only a literal
 * `false` (Core's regtest `-p2mronly=0`) turns the check off.
 */
function assertRestrictedOutputModeOutputs(
  outputs: readonly { scriptPubKey: Uint8Array }[],
  restrictedOutputMode: boolean | undefined
): void {
  if (restrictedOutputMode === false) return
  outputs.forEach((output, index) => {
    assertBytes(output.scriptPubKey, `output ${index} scriptPubKey`)
    if (!isRestrictedOutputModeOutput(output.scriptPubKey)) {
      throw new QbitProtocolError(
        'INVALID_SCRIPT',
        `output ${index}: qbit restricted-output mode allows only P2MR, OP_RETURN and P2A outputs ` +
          '(Core rejects the transaction with tx-output-not-p2mr)'
      )
    }
  })
}

/** qbit Core `COutPoint::IsNull` (src/primitives/transaction.h:42): an all-zero txid and vout 0xffffffff. */
function isNullOutpoint(prevout: { txid: Uint8Array; vout: number }): boolean {
  return prevout.vout === 0xffffffff && prevout.txid.every(byte => byte === 0)
}

/**
 * Refuse a transaction qbit Core's `CheckTransaction` rejects for its shape,
 * so no signature is spent on one that can never confirm, in Core's order:
 * one without inputs (`bad-txns-vin-empty`) or outputs
 * (`bad-txns-vout-empty`), two inputs spending one outpoint
 * (`bad-txns-inputs-duplicate`), or an input spending the null outpoint
 * (`bad-txns-prevout-null`; src/consensus/tx_check.cpp:14-17, :41-44,
 * :54-56). As the only input, a null outpoint makes the transaction a
 * coinbase (src/primitives/transaction.h:356-358), which is never a valid
 * spend: Core rejects it with `bad-cb-length` unless its scriptSig is 2 to
 * 100 bytes (tx_check.cpp:47-50), and the mempool with `coinbase`
 * (src/validation.cpp:843-845). Core's PSBT decoder does not run
 * `CheckTransaction` (`DecodeRawPSBT`, src/psbt.cpp:754-768), so parsing and
 * decoding accept such a PSBT, except one without inputs, which this
 * package's parser refuses.
 */
function assertTransactionShape(tx: {
  inputs: readonly { prevout: { txid: Uint8Array; vout: number } }[]
  outputs: readonly unknown[]
}): void {
  if (tx.inputs.length === 0) {
    throw new QbitProtocolError('INVALID_PSBT', 'transaction has no inputs (Core rejects it with bad-txns-vin-empty)')
  }
  if (tx.outputs.length === 0) {
    throw new QbitProtocolError('INVALID_PSBT', 'transaction has no outputs (Core rejects it with bad-txns-vout-empty)')
  }
  const spentBy = new Map<string, number>()
  tx.inputs.forEach((input, index) => {
    const outpoint = `${bytesToHex(input.prevout.txid)}:${input.prevout.vout}`
    const earlier = spentBy.get(outpoint)
    if (earlier !== undefined) {
      throw new QbitProtocolError(
        'INVALID_PSBT',
        `inputs ${earlier} and ${index} spend the same output ` +
          '(Core rejects the transaction with bad-txns-inputs-duplicate)'
      )
    }
    spentBy.set(outpoint, index)
  })
  const nullInput = tx.inputs.findIndex(input => isNullOutpoint(input.prevout))
  if (nullInput !== -1) {
    throw new QbitProtocolError(
      'INVALID_PSBT',
      tx.inputs.length === 1
        ? 'input 0 spends the null outpoint, making the transaction a coinbase ' +
            '(Core rejects it with bad-cb-length, or with coinbase outside a block)'
        : `input ${nullInput} spends the null outpoint (Core rejects the transaction with bad-txns-prevout-null)`
    )
  }
}

export { P2MR_MAX_MULTI_A_PUBKEYS, assertRestrictedOutputModeOutputs, assertTransactionShape }

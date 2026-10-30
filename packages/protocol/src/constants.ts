import type { extractP2mrTransaction } from './psbt'
import type { encodeP2mrPsbtLeafScriptField, encodeP2mrPsbtScriptSigField } from './psbt-fields'
import type { verifyControlBlock } from './scripts'
import type { p2mrSighash } from './sighash'
import type { finalizeP2mrPsbt } from './signing'

/**
 * Witness version of P2MR outputs. Their scriptPubKey starts with `OP_2`, and
 * the data part of their address with `z` (`qb1z…` on mainnet).
 *
 * @category Constants
 */
export const P2MR_WITNESS_VERSION = 2
/**
 * Byte length of a P2MR witness program, which is the Merkle root of the
 * output's script tree. P2MR public keys and leaf hashes are 32 bytes too.
 *
 * @category Constants
 */
export const P2MR_PROGRAM_BYTES = 32
/**
 * Mask that takes the leaf version from a control block's first byte. That
 * byte's low bit must be set (see {@link verifyControlBlock}).
 *
 * @category Constants
 */
export const P2MR_LEAF_VERSION_MASK = 0xfe
/**
 * The P2MR v1 leaf version. It is the only leaf version this package signs,
 * finalizes and builds message proofs for, and its control blocks start with
 * `0xc1`.
 *
 * @category Constants
 */
export const P2MR_LEAF_VERSION_V1 = 0xc0
/**
 * Byte length of a control block's first byte, which holds the leaf version
 * and a set low bit.
 *
 * @category Constants
 */
export const P2MR_CONTROL_BASE_BYTES = 1
/**
 * Byte length of each sibling hash in a control block's Merkle path.
 *
 * @category Constants
 */
export const P2MR_CONTROL_NODE_BYTES = 32
/**
 * Most sibling hashes a control block may hold, so a control block is at most
 * 4,097 bytes. This package rejects longer control blocks and Merkle paths,
 * and descriptor trees more than 128 branches deep, as qbit Core's `mr()`
 * parser does.
 *
 * @category Constants
 */
export const P2MR_CONTROL_MAX_NODE_COUNT = 128

/**
 * Opcode `0x00`, which pushes an empty item: the script number 0.
 *
 * @category Constants
 */
export const OP_0 = 0x00
/**
 * Opcode `0x51`, which pushes the number 1. `OP_1` to `OP_16` push 1 to 16.
 *
 * @category Constants
 */
export const OP_1 = 0x51
/**
 * Opcode `0x52`, which pushes the number 2. A P2MR scriptPubKey starts with it,
 * as its witness version.
 *
 * @category Constants
 */
export const OP_2 = 0x52
/**
 * Opcode `0x60`, which pushes the number 16.
 *
 * @category Constants
 */
export const OP_16 = 0x60
/**
 * Opcode `0xb3`, qbit's PQC signature check. It follows the key of a `pk` leaf
 * script and the first key of a `multi_a` leaf script.
 *
 * @category Constants
 */
export const OP_CHECKSIGPQC = 0xb3
/**
 * Opcode `0xba`. It follows every key of a `multi_a` leaf script after the
 * first.
 *
 * @category Constants
 */
export const OP_CHECKSIGADD = 0xba
/**
 * Opcode `0x9c`. It ends a `multi_a` leaf script, after the threshold.
 *
 * @category Constants
 */
export const OP_NUMEQUAL = 0x9c
const OP_RETURN = 0x6a
// qbit Core CScript::IsPayToAnchor (src/script/script.cpp:213-220): OP_1 PUSH2 0x4e73.
const PAY_TO_ANCHOR_SCRIPT = Uint8Array.of(OP_1, 0x02, 0x4e, 0x73)
/**
 * Byte length of a P2MR PQC signature (SLH-DSA-SHA2-128s-bounded30). A witness
 * signature item is this long, or one byte longer when it carries an explicit
 * sighash type.
 *
 * @remarks
 * See [P2MR Signature Hash](https://github.com/Qbit-Org/qbit-js/blob/main/packages/protocol/docs/p2mr-sighash.md).
 *
 * @category Constants
 */
export const PQC_SIGNATURE_BYTES = 3680

/**
 * Sighash type `0x00`: commits to every input and output, as `SIGHASH_ALL`
 * does, and is written as a 3680-byte signature with no type byte. The signing
 * helpers use no other type unless `allowNonDefaultSighash: true` is passed.
 *
 * @remarks
 * See [P2MR Signature Hash](https://github.com/Qbit-Org/qbit-js/blob/main/packages/protocol/docs/p2mr-sighash.md).
 *
 * @category Constants
 */
export const SIGHASH_DEFAULT = 0x00
/**
 * Sighash type `0x01`: commits to every input and output, like
 * `SIGHASH_DEFAULT`, but with an explicit type byte.
 *
 * @category Constants
 */
export const SIGHASH_ALL = 0x01
/**
 * Sighash type `0x02`: commits to no output.
 *
 * @category Constants
 */
export const SIGHASH_NONE = 0x02
/**
 * Sighash type `0x03`: commits only to the output at the signed input's index,
 * which must exist.
 *
 * @category Constants
 */
export const SIGHASH_SINGLE = 0x03
/**
 * Flag `0x80`, combined with `SIGHASH_ALL`, `SIGHASH_NONE` or `SIGHASH_SINGLE`:
 * commits to the signed input's outpoint, spent output and sequence instead of
 * every input's.
 *
 * @category Constants
 */
export const SIGHASH_ANYONECANPAY = 0x80
/**
 * Mask that takes the output type (`SIGHASH_ALL`, `SIGHASH_NONE` or
 * `SIGHASH_SINGLE`) from a sighash type. It does not handle
 * `SIGHASH_DEFAULT`: `0x00 & SIGHASH_OUTPUT_MASK` is `0`, not `SIGHASH_ALL`,
 * so treat `SIGHASH_DEFAULT` as `SIGHASH_ALL` before masking, as
 * {@link p2mrSighash} does.
 *
 * @category Constants
 */
export const SIGHASH_OUTPUT_MASK = 0x03
/**
 * Mask that takes the input type (`SIGHASH_ANYONECANPAY` or `0`) from a
 * sighash type.
 *
 * @category Constants
 */
export const SIGHASH_INPUT_MASK = 0x80
/**
 * The BIP174 magic `psbt` (`70 73 62 74`) as a big-endian uint32. A serialized
 * PSBT starts with these four bytes and then `0xff`.
 *
 * @category Constants
 */
export const PSBT_MAGIC_BYTES = 0x70736274 // "psbt"
/**
 * Global key type `0x00`: the unsigned transaction, which every PSBT must
 * carry.
 *
 * @category Constants
 */
export const PSBT_GLOBAL_UNSIGNED_TX = 0x00
/**
 * Input key type `0x01`: the output the input spends, its amount and
 * scriptPubKey. Signing needs one on every input.
 *
 * @category Constants
 */
export const PSBT_IN_WITNESS_UTXO = 0x01
/**
 * Input key type `0x03`: the sighash type every signature on the input must
 * use, as a 4-byte little-endian uint32.
 *
 * @category Constants
 */
export const PSBT_IN_SIGHASH_TYPE = 0x03
/**
 * Input key type `0x08`: the input's final script witness, which
 * {@link finalizeP2mrPsbt} writes and {@link extractP2mrTransaction} reads.
 *
 * @category Constants
 */
export const PSBT_IN_FINAL_SCRIPTWITNESS = 0x08
/**
 * qbit input key type `0x19`: a P2MR script signature, keyed by public key and
 * leaf hash. See {@link encodeP2mrPsbtScriptSigField}.
 *
 * @category Constants
 */
export const PSBT_IN_P2MR_SCRIPT_SIG = 0x19
/**
 * qbit input key type `0x1d`: a P2MR leaf script, keyed by its control block.
 * See {@link encodeP2mrPsbtLeafScriptField}.
 *
 * @category Constants
 */
export const PSBT_IN_P2MR_LEAF_SCRIPT = 0x1d
/**
 * Key type `0xfc` of a proprietary record, in any PSBT map. The key goes on
 * with a length-prefixed identifier, a compact-size subtype and key data.
 *
 * @category Constants
 */
export const PSBT_IN_PROPRIETARY = 0xfc
/**
 * Identifier of qbit's proprietary P2MR input records.
 *
 * @category Constants
 */
export const PSBT_QBIT_IDENTIFIER = 'qbit'
/**
 * `qbit` proprietary input subtype `0x01`: the P2MR Merkle root of the spent
 * output, with empty key data and a 32-byte value.
 *
 * @category Constants
 */
export const PSBT_QBIT_IN_P2MR_MERKLE_ROOT = 0x01
/**
 * `qbit` proprietary input subtype `0x02`: a P2MR leaf script, laid out as a
 * `0x1d` record is.
 *
 * @category Constants
 */
export const PSBT_QBIT_IN_P2MR_LEAF_SCRIPT = 0x02
/**
 * `qbit` proprietary input subtype `0x03`: a P2MR script signature, laid out
 * as a `0x19` record is.
 *
 * @category Constants
 */
export const PSBT_QBIT_IN_P2MR_SCRIPT_SIG = 0x03

export { OP_RETURN, PAY_TO_ANCHOR_SCRIPT }

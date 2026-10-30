import { QbitProtocolError } from './errors'
import { type QbitNetworkName, type QbitNetworkParams, getQbitNetwork, networkNameForHrp } from './networks'
import { P2MR_WITNESS_VERSION, P2MR_PROGRAM_BYTES, P2MR_LEAF_VERSION_V1, OP_2 } from './constants'
import { copyBytes, concatBytes, assertBytes, assertByteLength } from './bytes'
import { bech32Encode, bech32Decode, convertBits } from './bech32'
import { singleKeyLeafScript, p2mrLeafHash } from './scripts'

/**
 * A decoded P2MR address, as {@link decodeP2mrAddress} returns it.
 *
 * @category Addresses
 */
export interface DecodedP2mrAddress {
  /**
   * The address's network. Testnet4 and signet share the `tq` HRP, so without
   * an expected network a `tq` address decodes as `'testnet4'`; with one, this
   * is the expected network's name.
   */
  network: QbitNetworkName
  /** The address's human-readable part, in lowercase. */
  hrp: string
  /** The 32-byte witness program: the Merkle root of the output's script tree. */
  program: Uint8Array
}

/**
 * Encode a 32-byte P2MR witness program, a Merkle root, as a bech32m address.
 * The same as {@link p2mrAddressFromRoot}.
 *
 * @param program - The 32-byte witness program.
 * @param network - The network whose HRP the address uses.
 * @returns The lowercase address, such as `qb1z…` on mainnet.
 * @throws {QbitProtocolError} `INVALID_BYTES` if `program` is not a 32-byte
 * `Uint8Array`.
 * @throws {QbitProtocolError} `UNKNOWN_NETWORK` for an unknown network name,
 * or `WRONG_HRP` for network parameters whose HRP is not printable lowercase
 * ASCII. A name `Object.prototype` defines, such as `'toString'`, throws a
 * `TypeError` instead; see {@link getQbitNetwork}.
 *
 * @remarks
 * See [Features](https://github.com/Qbit-Org/qbit-js/blob/main/packages/protocol/docs/features.md).
 *
 * @category Addresses
 */
export function encodeP2mrAddress(program: Uint8Array, network: QbitNetworkName | QbitNetworkParams): string {
  assertByteLength(program, P2MR_PROGRAM_BYTES, 'P2MR program')
  const params = getQbitNetwork(network)
  const data = [P2MR_WITNESS_VERSION, ...convertBits([...program], 8, 5, true)]
  return bech32Encode('bech32m', params.bech32Hrp, data)
}

/**
 * Decode and validate a P2MR address.
 *
 * Decoding is as strict as qbit Core's `bech32::Decode`: at most 90
 * characters, printable ASCII only, and not mixed case. The address must then
 * be bech32m, use the HRP of a qbit network, and carry witness version 2 with
 * a 32-byte program.
 *
 * @param address - The address, all lowercase or all uppercase.
 * @param expectedNetwork - If given, the address must use this network's HRP,
 * and the result names this network.
 * @returns The address's network, lowercase HRP and witness program.
 * @throws {QbitProtocolError} `INVALID_BECH32` for a malformed bech32 string,
 * or `WRONG_ENCODING` for bech32 rather than bech32m.
 * @throws {QbitProtocolError} `WRONG_HRP` for an HRP that no qbit network uses
 * or that is not `expectedNetwork`'s, or `UNKNOWN_NETWORK` for an unknown
 * `expectedNetwork` name. A name `Object.prototype` defines, such as
 * `'toString'`, gives `WRONG_HRP` instead; see {@link getQbitNetwork}.
 * @throws {QbitProtocolError} `WRONG_WITNESS_VERSION` unless the witness
 * version is 2, or `WRONG_PROGRAM_LENGTH` unless the program is 32 bytes. A
 * program whose 5-bit groups do not convert cleanly to bytes (5 or more bits
 * left over, or non-zero padding bits) throws `INVALID_BECH32` instead.
 *
 * @remarks
 * Testnet4 and signet share the `tq` HRP, so a `tq` address decodes as
 * `'testnet4'` unless `expectedNetwork` says otherwise. See
 * [Features](https://github.com/Qbit-Org/qbit-js/blob/main/packages/protocol/docs/features.md).
 *
 * @example
 * ```ts
 * import { bytesToHex, decodeP2mrAddress, QbitProtocolError } from '@qbit-oss/protocol'
 *
 * const address = 'qbrt1zzasx2u2z7v9kn4q8e66r57mfw08xvrvdcqfcq6xfte0eau9dgdgqz42zd5'
 * const { network, program } = decodeP2mrAddress(address, 'regtest')
 * // network: 'regtest'
 * // bytesToHex(program): '1760657142f30b69d407ceb43a7b6973ce660d8dc0138068c95e5f9ef0ad4350'
 *
 * try {
 *   decodeP2mrAddress(address, 'mainnet')
 * } catch (error) {
 *   if (!QbitProtocolError.is(error) || error.code !== 'WRONG_HRP') throw error
 *   // a regtest address where a mainnet one was expected
 * }
 * ```
 *
 * @category Addresses
 */
export function decodeP2mrAddress(
  address: string,
  expectedNetwork?: QbitNetworkName | QbitNetworkParams
): DecodedP2mrAddress {
  const decoded = bech32Decode(address)
  if (decoded.encoding !== 'bech32m') {
    throw new QbitProtocolError('WRONG_ENCODING', 'P2MR addresses must use bech32m')
  }

  const decodedNetwork = networkNameForHrp(decoded.hrp)
  if (decodedNetwork === undefined) {
    throw new QbitProtocolError('WRONG_HRP', `unsupported qbit address HRP: ${decoded.hrp}`)
  }

  let network = decodedNetwork
  if (expectedNetwork !== undefined) {
    const expected = getQbitNetwork(expectedNetwork)
    if (decoded.hrp !== expected.bech32Hrp) {
      throw new QbitProtocolError('WRONG_HRP', `expected ${expected.bech32Hrp} HRP, got ${decoded.hrp}`)
    }
    network = expected.name
  }

  const [version, ...programWords] = decoded.data
  if (version !== P2MR_WITNESS_VERSION) {
    throw new QbitProtocolError('WRONG_WITNESS_VERSION', 'P2MR witness version must be 2')
  }

  const program = new Uint8Array(convertBits(programWords, 5, 8, false))
  if (program.length !== P2MR_PROGRAM_BYTES) {
    throw new QbitProtocolError('WRONG_PROGRAM_LENGTH', 'P2MR witness program must be 32 bytes')
  }

  return {
    network,
    hrp: decoded.hrp,
    program,
  }
}

/**
 * Build the P2MR scriptPubKey for a Merkle root: `OP_2 PUSH32 <root>`.
 *
 * @param root - The 32-byte Merkle root, which is the witness program.
 * @returns The 34-byte scriptPubKey.
 * @throws {QbitProtocolError} `INVALID_BYTES` if `root` is not a 32-byte
 * `Uint8Array`.
 *
 * @remarks
 * See [Features](https://github.com/Qbit-Org/qbit-js/blob/main/packages/protocol/docs/features.md).
 *
 * @category Addresses
 */
export function p2mrScriptPubKey(root: Uint8Array): Uint8Array {
  assertByteLength(root, P2MR_PROGRAM_BYTES, 'P2MR merkle root')
  return concatBytes(Uint8Array.of(OP_2, P2MR_PROGRAM_BYTES), root)
}

/**
 * Decode a P2MR address into its scriptPubKey, `OP_2 PUSH32 <program>`.
 *
 * @param address - The address, decoded as {@link decodeP2mrAddress} decodes
 * it.
 * @param expectedNetwork - If given, the network the address must belong to.
 * @returns The 34-byte scriptPubKey.
 * @throws {QbitProtocolError} Any code {@link decodeP2mrAddress} throws.
 *
 * @remarks
 * See [Features](https://github.com/Qbit-Org/qbit-js/blob/main/packages/protocol/docs/features.md).
 *
 * @category Addresses
 */
export function addressToScriptPubKey(
  address: string,
  expectedNetwork?: QbitNetworkName | QbitNetworkParams
): Uint8Array {
  return p2mrScriptPubKey(decodeP2mrAddress(address, expectedNetwork).program)
}

/**
 * Encode a P2MR `scriptPubKey` as an address. The script must be a
 * `Uint8Array` (a Node `Buffer` or one from another realm passes); anything
 * else throws `INVALID_BYTES`.
 *
 * @param scriptPubKey - A 34-byte `OP_2 PUSH32 <program>` script.
 * @param network - The network whose HRP the address uses.
 * @returns The lowercase address.
 * @throws {QbitProtocolError} `INVALID_BYTES` if `scriptPubKey` is not a
 * `Uint8Array`, or `INVALID_SCRIPT` if it is not a P2MR scriptPubKey.
 * @throws {QbitProtocolError} `UNKNOWN_NETWORK` or `WRONG_HRP`, as
 * {@link encodeP2mrAddress} throws them (it throws a `TypeError` instead for a
 * name `Object.prototype` defines).
 *
 * @remarks
 * See [Byte inputs and outputs](https://github.com/Qbit-Org/qbit-js/blob/main/packages/protocol/docs/byte-inputs.md).
 *
 * @category Addresses
 */
export function outputScriptToAddress(scriptPubKey: Uint8Array, network: QbitNetworkName | QbitNetworkParams): string {
  assertBytes(scriptPubKey, 'scriptPubKey')
  if (scriptPubKey.length !== 34 || scriptPubKey[0] !== OP_2 || scriptPubKey[1] !== P2MR_PROGRAM_BYTES) {
    throw new QbitProtocolError('INVALID_SCRIPT', 'expected OP_2 PUSH32 P2MR scriptPubKey')
  }
  return encodeP2mrAddress(copyBytes(scriptPubKey, 2), network)
}

/**
 * Encode a P2MR Merkle root as an address; the same as
 * {@link encodeP2mrAddress}.
 *
 * @param root - The 32-byte Merkle root of the output's script tree.
 * @param network - The network whose HRP the address uses.
 * @returns The lowercase address.
 * @throws {QbitProtocolError} `INVALID_BYTES` if `root` is not a 32-byte
 * `Uint8Array`, or `UNKNOWN_NETWORK` or `WRONG_HRP` for the network, as
 * {@link encodeP2mrAddress} throws them (it throws a `TypeError` instead for a
 * name `Object.prototype` defines).
 *
 * @remarks
 * It cannot tell whether any leaf under `root` can be spent. See
 * [P2MR Descriptors](https://github.com/Qbit-Org/qbit-js/blob/main/packages/protocol/docs/p2mr-descriptors.md).
 *
 * @category Addresses
 */
export function p2mrAddressFromRoot(root: Uint8Array, network: QbitNetworkName | QbitNetworkParams): string {
  return encodeP2mrAddress(root, network)
}

/** Canonical lowercase bech32m spelling of a decoded P2MR address. */
function canonicalP2mrAddress(decoded: DecodedP2mrAddress): string {
  return bech32Encode('bech32m', decoded.hrp, [P2MR_WITNESS_VERSION, ...convertBits([...decoded.program], 8, 5, true)])
}

/**
 * Derive the address of a single-key P2MR output: a tree whose only leaf is
 * `pk32`'s v1 single-key leaf script, so the Merkle root is that leaf's hash.
 *
 * @param pk32 - The 32-byte PQC public key.
 * @param network - The network whose HRP the address uses.
 * @returns The lowercase address.
 * @throws {QbitProtocolError} `INVALID_BYTES` if `pk32` is not a 32-byte
 * `Uint8Array`, or `UNKNOWN_NETWORK` or `WRONG_HRP` for the network, as
 * {@link encodeP2mrAddress} throws them (it throws a `TypeError` instead for a
 * name `Object.prototype` defines).
 *
 * @remarks
 * Spend it with `singleKeyLeafScript(pk32)` and `buildControlBlock()`. See
 * [Features](https://github.com/Qbit-Org/qbit-js/blob/main/packages/protocol/docs/features.md).
 *
 * @example
 * ```ts
 * import { hexToBytes, p2mrAddressFromPubkey } from '@qbit-oss/protocol'
 *
 * const pubkey = hexToBytes('02'.repeat(32)) // the 32-byte public key from your PQC signer
 * p2mrAddressFromPubkey(pubkey, 'regtest')
 * // 'qbrt1zzasx2u2z7v9kn4q8e66r57mfw08xvrvdcqfcq6xfte0eau9dgdgqz42zd5'
 * ```
 *
 * @category Addresses
 */
export function p2mrAddressFromPubkey(pk32: Uint8Array, network: QbitNetworkName | QbitNetworkParams): string {
  const script = singleKeyLeafScript(pk32)
  const root = p2mrLeafHash(P2MR_LEAF_VERSION_V1, script)
  return p2mrAddressFromRoot(root, network)
}

export { canonicalP2mrAddress }

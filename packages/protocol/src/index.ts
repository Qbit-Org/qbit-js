export { QbitProtocolError, P2mrPsbtSigningError } from './errors'
export type { QbitProtocolErrorCode, P2mrPsbtSigningPhase } from './errors'
export { qbitNetworks, getQbitNetwork } from './networks'
export type { QbitNetworkName, QbitNetworkParams } from './networks'
export {
  P2MR_WITNESS_VERSION,
  P2MR_PROGRAM_BYTES,
  P2MR_LEAF_VERSION_MASK,
  P2MR_LEAF_VERSION_V1,
  P2MR_CONTROL_BASE_BYTES,
  P2MR_CONTROL_NODE_BYTES,
  P2MR_CONTROL_MAX_NODE_COUNT,
  OP_0,
  OP_1,
  OP_2,
  OP_16,
  OP_CHECKSIGPQC,
  OP_CHECKSIGADD,
  OP_NUMEQUAL,
  PQC_SIGNATURE_BYTES,
  SIGHASH_DEFAULT,
  SIGHASH_ALL,
  SIGHASH_NONE,
  SIGHASH_SINGLE,
  SIGHASH_ANYONECANPAY,
  SIGHASH_OUTPUT_MASK,
  SIGHASH_INPUT_MASK,
  PSBT_MAGIC_BYTES,
  PSBT_GLOBAL_UNSIGNED_TX,
  PSBT_IN_WITNESS_UTXO,
  PSBT_IN_SIGHASH_TYPE,
  PSBT_IN_FINAL_SCRIPTWITNESS,
  PSBT_IN_P2MR_SCRIPT_SIG,
  PSBT_IN_P2MR_LEAF_SCRIPT,
  PSBT_IN_PROPRIETARY,
  PSBT_QBIT_IDENTIFIER,
  PSBT_QBIT_IN_P2MR_MERKLE_ROOT,
  PSBT_QBIT_IN_P2MR_LEAF_SCRIPT,
  PSBT_QBIT_IN_P2MR_SCRIPT_SIG,
} from './constants'
export {
  QBIT_COINBASE_MATURITY,
  QBIT_MAX_MONEY,
  P2MR_V1_MAX_MULTI_A_THRESHOLD,
  assertMoneyRange,
  assertUint32,
  isRestrictedOutputModeOutput,
} from './consensus'
export type { RestrictedOutputModeOptions } from './consensus'
export { bytesToHex, hexToBytes } from './bytes'
export {
  encodeP2mrAddress,
  decodeP2mrAddress,
  p2mrScriptPubKey,
  addressToScriptPubKey,
  outputScriptToAddress,
  p2mrAddressFromRoot,
  p2mrAddressFromPubkey,
} from './addresses'
export type { DecodedP2mrAddress } from './addresses'
export {
  singleKeyLeafScript,
  multiALeafScript,
  p2mrLeafHash,
  p2mrBranchHash,
  merkleRootFromPath,
  buildControlBlock,
  verifyControlBlock,
} from './scripts'
export {
  QBIT_WALLET_MESSAGE_DOMAIN,
  QBIT_DATA_SIG_PQC_DOMAIN,
  P2MR_MESSAGE_PROOF_TYPE,
  P2MR_MESSAGE_PROOF_VERSION,
  P2MR_MESSAGE_PROOF_MODE,
  P2MR_MESSAGE_ALGORITHM,
  qbitWalletMessageHash,
  qbitDataSigPqcHash,
  createP2mrMessageProof,
  verifyP2mrMessageProof,
} from './message'
export type {
  P2mrMessageProof,
  CreateP2mrMessageProofParams,
  P2mrPqcVerifyFn,
  VerifyP2mrMessageProofOptions,
} from './message'
export type { P2mrOutpoint, P2mrTransactionInput, P2mrTransactionOutput, P2mrTransaction } from './transaction'
export { isValidP2mrSighashType, precomputeSighashMidstates, schnorrSignatureHash, p2mrSighash } from './sighash'
export type {
  P2mrSpentOutput,
  SighashMidstates,
  SchnorrSigVersion,
  SchnorrSighashParams,
  P2mrSighashParams,
} from './sighash'
export {
  encodeP2mrWitnessSignature,
  decodeP2mrWitnessSignature,
  encodeP2mrPsbtScriptSigField,
  decodeP2mrPsbtScriptSigField,
  encodeP2mrPsbtLeafScriptField,
  decodeP2mrPsbtLeafScriptField,
  decodeQbitProprietaryP2mrInputField,
  encodeQbitProprietaryP2mrMerkleRootField,
  encodeQbitProprietaryP2mrLeafScriptField,
  encodeQbitProprietaryP2mrScriptSigField,
} from './psbt-fields'
export type {
  P2mrWitnessSignature,
  P2mrPsbtScriptSigField,
  P2mrPsbtLeafScriptField,
  QbitProprietaryP2mrMerkleRootField,
  QbitProprietaryP2mrField,
  EncodedQbitProprietaryP2mrField,
} from './psbt-fields'
export {
  PSBT_DEFAULT_MAX_BYTES,
  PSBT_DEFAULT_MAX_OBJECTS,
  parsePsbt,
  serializePsbt,
  psbtUnsignedTransaction,
  combinePsbts,
  decodePsbt,
  createP2mrPsbt,
  extractP2mrTransaction,
} from './psbt'
export type { PsbtKeyValue, Psbt, PsbtLimitOptions, PsbtInputSummary, PsbtSummary, P2mrPsbtInput } from './psbt'
export { validateP2mrSigningPlans, signP2mrPsbt, finalizeP2mrPsbt } from './signing'
export type {
  P2mrPsbtSignContext,
  P2mrPsbtSignFn,
  P2mrSigningKey,
  P2mrSigningPlanRef,
  P2mrPsbtOnSignedFn,
  P2mrSigningOptions,
  SignP2mrPsbtResult,
} from './signing'
export {
  splitDescriptorChecksum,
  verifyDescriptorChecksum,
  parseP2mrDescriptor,
  serializeP2mrDescriptor,
  p2mrRootFromDescriptor,
  p2mrAddressFromDescriptor,
  formatP2mrImportDescriptors,
  hasP2mrStandardSatisfaction,
  descriptorChecksum,
  addDescriptorChecksum,
} from './descriptors'
export type {
  DescriptorChecksumParts,
  P2mrPqcKeyExpression,
  P2mrDescriptorLeaf,
  P2mrDescriptorTree,
  ParsedP2mrDescriptor,
  ParseP2mrDescriptorOptions,
  P2mrImportDescriptorPair,
  P2mrImportDescriptorEntry,
} from './descriptors'
export { parseQbitUri, formatQbitUri } from './uri'
export type { ParsedQbitUri, QbitUriFields } from './uri'

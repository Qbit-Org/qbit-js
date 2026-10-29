# @qbit-oss/protocol

qbit protocol primitives for wallet integration across Qbit mainnet, Testnet4,
signet, and regtest. The full feature list is in [docs/features.md](docs/features.md).

Byte inputs and outputs: see [docs/byte-inputs.md](docs/byte-inputs.md).

Non-default sighash types: see [docs/signing-and-finalization.md](docs/signing-and-finalization.md#non-default-sighash-types).

This package does not derive seed phrases or private keys. Wallet code should
combine these helpers with a PQC signer and its own key management.

Untrusted PSBT input: see [docs/untrusted-psbt.md](docs/untrusted-psbt.md).

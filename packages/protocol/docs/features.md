# Features

Everything `@qbit-oss/protocol` provides; entries with more detail link to their
own page.

- network parameters for qbit mainnet, testnet4, signet, and regtest
- `QBIT_COINBASE_MATURITY` (1000): a coinbase output can be spent once it has
  this many confirmations, on every qbit network (qbit Core
  `src/consensus/consensus.h` `COINBASE_MATURITY`). No helper in this package
  applies it, so wallet coin selection must skip a coinbase output until it has
  at least 1000 confirmations: qbit Core rejects a spend whose block height is
  less than 1000 above the coinbase's as `bad-txns-premature-spend-of-coinbase`
  (`src/consensus/tx_verify.cpp`)
- strict P2MR bech32m address encode/decode (printable ASCII only, 90-character
  limit, and no mixed case, matching qbit Core's `bech32::Decode`)
- P2MR single-key leaf scripts, merkle roots, control blocks, and scriptPubKeys
- structured P2MR wallet message proofs: see [message-proofs.md](message-proofs.md)
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
- consensus range checks: see [consensus-checks.md](consensus-checks.md)
- crash-safe P2MR signing for stateful signers: see [signing-and-finalization.md](signing-and-finalization.md)
- error classification across builds: see [error-classification.md](error-classification.md)
- qbit Core's restricted-output consensus rule: see [consensus-checks.md](consensus-checks.md)
- sighash-type guardrails on the signing path, sighash-type enforcement at
  finalization, and signing and finalization agreement: see
  [signing-and-finalization.md](signing-and-finalization.md)

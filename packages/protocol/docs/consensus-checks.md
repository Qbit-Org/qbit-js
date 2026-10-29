# Consensus checks

The consensus range checks and the restricted-output rule this package applies
to the transactions it builds and signs.

- consensus range checks: amounts must satisfy qbit Core `MoneyRange`
  (`0 ≤ value ≤ QBIT_MAX_MONEY`), `version`/`locktime`/`vout`/`sequence`/
  `codeSeparatorPos` must be uint32 (`version` included: qbit Core's
  `CTransaction::version` is `uint32_t`, so a legacy int32 `-1` is
  `0xffffffff`) and `keyVersion` must be uint8; out-of-range values throw
  `QbitProtocolError` (`INVALID_AMOUNT` / `INVALID_INTEGER`) instead of being
  serialized and signed modulo 2^64 / 2^32 / 2^8 (`assertMoneyRange`,
  `assertUint32`)
- qbit Core's restricted-output consensus rule
  (`src/consensus/restricted_outputs.h` @ v1.0.0), on for every network
  including default regtest: `isRestrictedOutputModeOutput(scriptPubKey,
  { reservedWitnessActive })` mirrors it, and `createP2mrPsbt`,
  `validateP2mrSigningPlans` and `signP2mrPsbt` throw `INVALID_SCRIPT` before
  any signer call for an output that is not P2MR, `OP_RETURN` or P2A, which
  Core rejects with `tx-output-not-p2mr`. They refuse witness v3..v16 outputs
  too, which Core's consensus allows on mainnet, testnet4 and signet but no
  default node relays. Pass `restrictedOutputMode: false` only for a regtest
  node run with `-p2mronly=0`. Relay policy (`OP_RETURN` push-only data,
  `-datacarriersize`, dust) is not checked

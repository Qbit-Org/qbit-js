# Message proofs

Creating and verifying structured P2MR wallet message proofs, and why
`verifyP2mrMessageProof` needs an expectation.

- structured P2MR wallet message proofs (`createP2mrMessageProof`,
  `verifyP2mrMessageProof`). `verifyP2mrMessageProof(message, proof, verifyPqc,
  options)` requires `options` with `{ expectedAddress }` and/or
  `{ expectedNetwork }`; the three-argument form was removed, and missing,
  non-object or empty `options` throws `TypeError`. `proof.address` is
  attacker-controlled and the same Merkle root encodes to a different string on
  each network except signet and Testnet4, which share the `tq` prefix (so
  `expectedNetwork` cannot tell those two apart; pass `expectedAddress` to pin
  an exact address). Never trust `proof.address` on its own. Only the canonical
  lowercase spelling verifies: an uppercase `proof.address` returns `false`, so
  re-create such a proof with `createP2mrMessageProof`.

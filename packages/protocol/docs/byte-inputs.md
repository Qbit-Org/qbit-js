# Byte inputs and outputs

Which arguments must be `Uint8Array`s, which values pass and fail that check,
and why results never alias caller memory.

PSBT and field-decoding results do not alias caller memory. Parsed PSBTs,
decoded fields, PSBTs returned by sign/combine/finalize, and signing-plan keys
are fresh plain `Uint8Array` copies, including when the input is a Node
`Buffer` (whose `slice` returns a view). Callers may wipe or reuse input
buffers after a call returns.

Byte inputs must be `Uint8Array`s: every fixed-length one (pubkeys,
signatures, leaf hashes, merkle roots and siblings, outpoint txids, address
programs, the five cached sighash `midstates`), the leaf scripts and control
blocks given to the builders and encoders, output, witness-UTXO and
spent-output scripts, the sighash annex, the map keys and values
`serializePsbt` writes (so a hand-built `Psbt` holding `number[]`s no longer
serializes), the `keyData` of `decodeQbitProprietaryP2mrInputField`, and the
arguments of `outputScriptToAddress`, `decodeP2mrWitnessSignature` and
`decodeP2mrPsbtScriptSigField`. A Node `Buffer`, a subarray, a subclass or a
`Uint8Array` from another realm (vm, iframe, worker) is accepted; a string, a
plain array, another typed array (even one whose `Symbol.toStringTag` claims
`'Uint8Array'`) or a `DataView` throws `QbitProtocolError` `INVALID_BYTES`
even when its `length` is right. The sighash `leafHash` of `p2mrSighash` and
`schnorrSignatureHash` is the exception: it throws `INVALID_SIGHASH`. Wrap a
`number[]` or another typed array with `Uint8Array.from(...)`.

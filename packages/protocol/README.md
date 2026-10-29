# @qbit-oss/protocol

qbit protocol primitives for wallet integration across Qbit mainnet, Testnet4,
signet, and regtest.

This package does not derive seed phrases or private keys. Wallet code should
combine these helpers with a PQC signer and its own key management. Low-level
PQC signing is in a separate package, `@qbit-oss/pqc`, published from
[Qbit-Org/qbit-pqc](https://github.com/Qbit-Org/qbit-pqc). To read chain data
and broadcast, use
[`@qbit-oss/api`](https://github.com/Qbit-Org/qbit-js/blob/main/packages/api/README.md).

## Install

```sh
npm install @qbit-oss/protocol
pnpm add @qbit-oss/protocol
yarn add @qbit-oss/protocol
```

A plain install gets the latest final release. Release candidates are published
under the npm dist-tag `candidate`, never `latest`: when one is published,
`@qbit-oss/protocol@candidate` installs the most recently published candidate.
To pin a version, install `@qbit-oss/protocol@<version>`. `pnpm add` and
`yarn add` take the same suffixes. Versions and dist-tags are described in
[RELEASING.md](https://github.com/Qbit-Org/qbit-js/blob/main/RELEASING.md).

## Runtime support

The package ships a CommonJS and an ESM build, each with type declarations, and
its `package.json` declares no `engines` range. What the repository checks:

- CI builds, tests and type-checks it, and runs the checks below, on Node.js 22.
- `consumer:check`
  ([`scripts/check-packed-consumer.mjs`](https://github.com/Qbit-Org/qbit-js/blob/main/scripts/check-packed-consumer.mjs))
  type-checks a consumer against the packed declarations, through both the
  `import` and the `require` condition, as a Node-only project
  (`lib: ["ES2022"]`, `types: ["node"]`, no DOM lib) and as a browser project
  (`lib: ["ES2022", "DOM"]`, no `@types/node`). It then loads the CommonJS and
  the ESM build side by side in Node.js and checks that each build's
  `QbitProtocolError.is` and `P2mrPsbtSigningError.is` recognize the other
  build's errors. The browser project is only type-checked; no test runs in a
  browser.
- `smoke:consumer` installs the packed package into a fresh project with npm,
  imports it by name through both builds in Node.js, and checks it against
  qbit Core vectors.

Byte inputs must be `Uint8Array`s. A Node `Buffer` or a `Uint8Array` from
another realm (vm, iframe, worker) is accepted; see
[Byte inputs and outputs](docs/byte-inputs.md).

## Quick start

```ts
import { addressToScriptPubKey, buildControlBlock, createP2mrPsbt, hexToBytes, p2mrAddressFromPubkey,
  p2mrLeafHash, P2MR_LEAF_VERSION_V1, singleKeyLeafScript, validateP2mrSigningPlans } from '@qbit-oss/protocol'

const fundingTxid = '0123456789abcdef'.repeat(4) // placeholder: the txid of the output you spend
const pubkey = hexToBytes('02'.repeat(32)) // placeholder: 32-byte public key from your PQC signer
const address = p2mrAddressFromPubkey(pubkey, 'regtest') // 'qbrt1zzasx2u2z7v9kn4q8e66r57mfw08xvrvdcqfcq6xfte0eau9dgdgqz42zd5'
const scriptPubKey = addressToScriptPubKey(address, 'regtest')
const leafScript = singleKeyLeafScript(pubkey)
const txid = hexToBytes(fundingTxid).reverse() // fundingTxid as an explorer shows it, reversed to internal order
const psbt = createP2mrPsbt({
  inputs: [{ prevout: { txid, vout: 0 }, witnessUtxo: { value: 100_000n, scriptPubKey }, leafScript, controlBlock: buildControlBlock() }],
  outputs: [{ value: 99_000n, scriptPubKey }], // pays back to the same address
})
const keys = [{ inputIndex: 0, pubkey, leafHash: p2mrLeafHash(P2MR_LEAF_VERSION_V1, leafScript) }]
validateP2mrSigningPlans({ psbt, keys }) // the plan checks signP2mrPsbt runs before its first signer call
```

Then sign with `signP2mrPsbt({ psbt, keys, sign })`, where `sign` is a
synchronous callback that returns your PQC signer's 3680-byte signature for the
sighash it is given. Pass the `psbt` it returns to `finalizeP2mrPsbt`, then
`extractP2mrTransaction` returns the transaction as bytes. `@qbit-oss/api`'s
`broadcastTx` takes hex, so send `bytesToHex(tx)`.
See [Signing and finalization](docs/signing-and-finalization.md).

## Common tasks

| Task | Function(s) | Details |
| --- | --- | --- |
| Derive a single-key P2MR address | `p2mrAddressFromPubkey` | [Features](docs/features.md) |
| Encode or decode a P2MR address | `encodeP2mrAddress`, `decodeP2mrAddress` | [Features](docs/features.md) |
| Convert between address and output script | `addressToScriptPubKey`, `outputScriptToAddress` | [Features](docs/features.md) |
| Build leaf scripts and control blocks | `singleKeyLeafScript`, `multiALeafScript`, `p2mrLeafHash`, `buildControlBlock` | [Features](docs/features.md) |
| Look up network parameters | `getQbitNetwork`, `qbitNetworks` | [Features](docs/features.md) |
| Know when a coinbase output can be spent | `QBIT_COINBASE_MATURITY` | [Features](docs/features.md) |
| Parse or format a `qbit:` payment URI | `parseQbitUri`, `formatQbitUri` | [qbit Payment URIs](docs/qbit-uri.md) |
| Parse a descriptor or derive its address | `parseP2mrDescriptor`, `p2mrAddressFromDescriptor` | [P2MR descriptor support](docs/p2mr-descriptor-support.md) |
| Export descriptors to qbit Core | `formatP2mrImportDescriptors` | [`formatP2mrImportDescriptors`](docs/p2mr-descriptor-support.md#formatp2mrimportdescriptors) |
| Create an unsigned PSBT | `createP2mrPsbt` | [Consensus checks](docs/consensus-checks.md) |
| Parse, inspect or combine PSBTs | `parsePsbt`, `decodePsbt`, `combinePsbts`, `serializePsbt` | [Untrusted PSBT input](docs/untrusted-psbt.md) |
| Check signing plans before using a key | `validateP2mrSigningPlans` | [Signing and finalization](docs/signing-and-finalization.md) |
| Sign, finalize and extract a transaction | `signP2mrPsbt`, `finalizeP2mrPsbt`, `extractP2mrTransaction` | [Signing and finalization](docs/signing-and-finalization.md) |
| Compute a sighash | `p2mrSighash`, `precomputeSighashMidstates` | [P2MR Signature Hash](docs/p2mr-sighash.md) |
| Create or verify a message proof | `createP2mrMessageProof`, `verifyP2mrMessageProof` | [Message proofs](docs/message-proofs.md) |
| Check amounts and integer fields | `assertMoneyRange`, `assertUint32` | [Consensus checks](docs/consensus-checks.md) |
| Check an output against restricted-output mode | `isRestrictedOutputModeOutput` | [Consensus checks](docs/consensus-checks.md) |
| Classify an error | `QbitProtocolError.is`, `P2mrPsbtSigningError.is` | [Error classification](docs/error-classification.md) |

## Errors you must handle

- **`QbitProtocolError.is(error)` and `P2mrPsbtSigningError.is(error)`, not
  `instanceof`**: they recognize errors from any copy of this package, where an
  app that loads both the CommonJS and the ESM build, or two versions, has two
  of each class. Keep a default branch when switching on `code`, since another
  version can carry a code this one does not list.
  [Error classification](docs/error-classification.md)
- **`P2mrPsbtSigningError`** from `signP2mrPsbt`: a `sign` call or the
  `onSigned` callback failed. `error.psbt` holds every signature made so far,
  `error.signed` lists them, and `error.failed` is the plan that failed. In
  phase `'sign'` the signer was invoked for `failed` but no signature was
  stored, so `failed` is not in `signed` and `onSigned` never ran for it; a
  stateful signer must still treat that key use as consumed, so it records
  each key use inside `sign`, before signing, and never signs again from the
  same one-time state. In phase `'onSigned'` the signature for `failed` is
  stored and is the last entry of `signed`; only the callback failed. Retry by
  calling `signP2mrPsbt` with `error.psbt` and only the keys not listed in
  `error.signed`; a key whose signature is already present is refused before
  any signer call, but a `'sign'`-phase `failed` is sent to the signer again
  with the same digest.
  [Signing and finalization](docs/signing-and-finalization.md)

## Topic pages

- [Features](docs/features.md): everything the package provides, one entry per
  area.
- [Signing and finalization](docs/signing-and-finalization.md): crash-safe
  signing, sighash-type rules, and which leaf finalize uses.
- [Byte inputs and outputs](docs/byte-inputs.md): accepted byte types and
  copy-on-return results.
- [Untrusted PSBT input](docs/untrusted-psbt.md): parser limits and their
  measured memory cost.
- [Consensus checks](docs/consensus-checks.md): amount and integer ranges, and
  the restricted-output rule.
- [Message proofs](docs/message-proofs.md): creating and verifying P2MR wallet
  message proofs.
- [Error classification](docs/error-classification.md): `QbitProtocolError.is`
  and `P2mrPsbtSigningError.is`.
- [P2MR Signature Hash](docs/p2mr-sighash.md): the byte-exact message a P2MR
  signature commits to.
- [P2MR descriptors](docs/p2mr-descriptors.md) and
  [P2MR descriptor support](docs/p2mr-descriptor-support.md): the `mr(...)` and
  `rawmr(...)` helpers and where they differ from qbit Core.
- [qbit Payment URIs](docs/qbit-uri.md): parsing and formatting `qbit:` URIs.

import { describe, expect, it, vi } from 'vitest'

import fixture from '../fixtures/p2mr-psbt.json'
import {
  P2MR_LEAF_VERSION_V1,
  PSBT_GLOBAL_UNSIGNED_TX,
  PQC_SIGNATURE_BYTES,
  QbitProtocolError,
  buildControlBlock,
  bytesToHex,
  createP2mrPsbt,
  decodePsbt,
  encodeP2mrPsbtScriptSigField,
  extractP2mrTransaction,
  finalizeP2mrPsbt,
  hexToBytes,
  multiALeafScript,
  p2mrLeafHash,
  p2mrScriptPubKey,
  p2mrSighash,
  parsePsbt,
  psbtUnsignedTransaction,
  serializePsbt,
  signP2mrPsbt,
  singleKeyLeafScript,
  validateP2mrSigningPlans,
} from '../src/index'

describe('createP2mrPsbt unsigned transaction serialization', () => {
  it('matches the framework byte-for-byte', () => {
    const uv = fixture.unsignedTx
    const created = createP2mrPsbt({
      version: uv.version,
      locktime: uv.locktime,
      inputs: uv.inputs.map(input => ({
        prevout: { txid: hexToBytes(input.txid), vout: input.vout },
        sequence: input.sequence,
        witnessUtxo: { value: 0n, scriptPubKey: new Uint8Array() },
        leafScript: new Uint8Array(),
        controlBlock: Uint8Array.of(0xc1),
      })),
      outputs: uv.outputs.map(output => ({
        value: BigInt(output.valueSats),
        scriptPubKey: hexToBytes(output.scriptPubKey),
      })),
    })
    const txEntry = created.global.find(entry => entry.key.length === 1 && entry.key[0] === PSBT_GLOBAL_UNSIGNED_TX)!
    expect(bytesToHex(txEntry.value)).toBe(uv.hex)
  })
})

describe('P2MR PSBT create → sign → finalize → extract (single-key)', () => {
  const pubkey = Uint8Array.from({ length: 32 }, (_, i) => (i * 7 + 1) & 0xff)
  const leafScript = singleKeyLeafScript(pubkey)
  const leafHash = p2mrLeafHash(P2MR_LEAF_VERSION_V1, leafScript)
  const controlBlock = buildControlBlock(P2MR_LEAF_VERSION_V1, [])
  const scriptPubKey = p2mrScriptPubKey(leafHash)
  const txid = new Uint8Array(32).fill(9)

  const psbt = createP2mrPsbt({
    inputs: [
      {
        prevout: { txid, vout: 0 },
        witnessUtxo: { value: 100_000n, scriptPubKey },
        leafScript,
        controlBlock,
        merkleRoot: leafHash,
      },
    ],
    outputs: [{ value: 90_000n, scriptPubKey }],
  })

  it('creates an update-complete PSBT that round-trips and decodes', () => {
    const bytes = serializePsbt(psbt)
    expect(bytesToHex(serializePsbt(parsePsbt(bytes)))).toBe(bytesToHex(bytes))
    const input = decodePsbt(psbt).inputs[0]!
    expect(input.witnessUtxo?.value).toBe(100_000n)
    expect(input.leafScripts.length).toBe(1)
    expect(bytesToHex(input.merkleRoot!)).toBe(bytesToHex(leafHash))
    expect(input.scriptSigs.length).toBe(0)
  })

  it('signs with the correct P2MR sighash and records the signer pubkey', () => {
    const tx = psbtUnsignedTransaction(psbt)
    const expectedSighash = p2mrSighash({
      tx,
      inputIndex: 0,
      spentOutputs: [{ value: 100_000n, scriptPubKey }],
      leafHash,
      hashType: 0,
    })
    const dummySignature = Uint8Array.from({ length: PQC_SIGNATURE_BYTES }, (_, i) => i & 0xff)
    let observed: Uint8Array | undefined
    const { psbt: signed, signed: signers } = signP2mrPsbt({
      psbt,
      keys: [{ inputIndex: 0, pubkey, leafHash }],
      sign: (sighash, ctx) => {
        observed = sighash
        expect(ctx.inputIndex).toBe(0)
        expect(bytesToHex(ctx.pubkey)).toBe(bytesToHex(pubkey))
        return dummySignature
      },
    })
    expect(bytesToHex(observed!)).toBe(bytesToHex(expectedSighash))
    expect(signers).toEqual([{ inputIndex: 0, pubkey, leafHash }])
    expect(decodePsbt(signed).inputs[0]!.scriptSigs.length).toBe(1)
    expect(bytesToHex(decodePsbt(signed).inputs[0]!.scriptSigs[0]!.signature.signature)).toBe(
      bytesToHex(dummySignature)
    )
  })

  it('exposes a side-effect-free validator for stateful signers', () => {
    expect(() =>
      validateP2mrSigningPlans({
        psbt,
        keys: [{ inputIndex: 0, pubkey, leafHash }],
      })
    ).not.toThrow()
    expect(decodePsbt(psbt).inputs[0]!.scriptSigs).toHaveLength(0)
  })

  it('validates signing pubkeys used by a multi_a leaf', () => {
    const secondPubkey = new Uint8Array(32).fill(0x42)
    const multiLeafScript = multiALeafScript(2, [pubkey, secondPubkey])
    const multiLeafHash = p2mrLeafHash(P2MR_LEAF_VERSION_V1, multiLeafScript)
    const multiPsbt = createP2mrPsbt({
      inputs: [
        {
          prevout: { txid, vout: 1 },
          witnessUtxo: { value: 100_000n, scriptPubKey: p2mrScriptPubKey(multiLeafHash) },
          leafScript: multiLeafScript,
          controlBlock,
          merkleRoot: multiLeafHash,
        },
      ],
      outputs: [{ value: 90_000n, scriptPubKey }],
    })

    expect(() =>
      validateP2mrSigningPlans({
        psbt: multiPsbt,
        keys: [{ inputIndex: 0, pubkey: secondPubkey, leafHash: multiLeafHash }],
      })
    ).not.toThrow()
  })

  it('finalizes and extracts a network-ready witness transaction', () => {
    const dummySignature = Uint8Array.from({ length: PQC_SIGNATURE_BYTES }, (_, i) => (i * 3) & 0xff)
    const { psbt: signed } = signP2mrPsbt({
      psbt,
      keys: [{ inputIndex: 0, pubkey, leafHash }],
      sign: () => dummySignature,
    })

    expect(() => extractP2mrTransaction(signed)).toThrow(/not finalized/)

    const finalized = finalizeP2mrPsbt(signed)
    const input = decodePsbt(finalized).inputs[0]!
    expect(input.finalized).toBe(true)
    expect(input.leafScripts.length).toBe(0) // partial fields dropped
    expect(input.scriptSigs.length).toBe(0)
    expect(input.witnessUtxo?.value).toBe(100_000n) // witness UTXO kept

    const rawTx = bytesToHex(extractP2mrTransaction(finalized))
    expect(rawTx.startsWith('020000000001')).toBe(true) // version 2 + segwit marker/flag
    // witness stack is [signature, leaf_script, control_block]
    expect(rawTx).toContain(bytesToHex(dummySignature))
    expect(rawTx).toContain(bytesToHex(leafScript))
    expect(rawTx.endsWith(bytesToHex(controlBlock) + '00000000')).toBe(true) // control block then locktime
  })

  it('refuses to finalize an unsigned input', () => {
    expect(() => finalizeP2mrPsbt(psbt)).toThrow(/no P2MR script signature to finalize/)
  })

  it('preflights every plan before invoking the signer', () => {
    const signer = vi.fn(() => new Uint8Array(PQC_SIGNATURE_BYTES))
    expect(() =>
      signP2mrPsbt({
        psbt,
        keys: [
          { inputIndex: 0, pubkey, leafHash },
          { inputIndex: 9, pubkey, leafHash },
        ],
        sign: signer,
      })
    ).toThrow(/inputIndex/)
    expect(signer).not.toHaveBeenCalled()
  })

  it('rejects duplicate plans before invoking the signer', () => {
    const signer = vi.fn(() => new Uint8Array(PQC_SIGNATURE_BYTES))
    const plan = { inputIndex: 0, pubkey, leafHash }
    expect(() => signP2mrPsbt({ psbt, keys: [plan, plan], sign: signer })).toThrow(
      /duplicate P2MR signing plan/
    )
    expect(signer).not.toHaveBeenCalled()
  })

  it('rejects a signing pubkey that is not used by the selected leaf', () => {
    const signer = vi.fn(() => new Uint8Array(PQC_SIGNATURE_BYTES))
    expect(() =>
      signP2mrPsbt({
        psbt,
        keys: [{ inputIndex: 0, pubkey: new Uint8Array(32).fill(0x7f), leafHash }],
        sign: signer,
      })
    ).toThrow(/signing pubkey.*leaf script/)
    expect(signer).not.toHaveBeenCalled()
  })

  it('does not re-sign a PSBT field that already exists', () => {
    const signature = new Uint8Array(PQC_SIGNATURE_BYTES).fill(1)
    const signed = signP2mrPsbt({
      psbt,
      keys: [{ inputIndex: 0, pubkey, leafHash }],
      sign: () => signature,
    }).psbt
    const signer = vi.fn(() => signature)

    expect(() =>
      signP2mrPsbt({
        psbt: signed,
        keys: [{ inputIndex: 0, pubkey, leafHash }],
        sign: signer,
      })
    ).toThrow(/already has a P2MR signature/)
    expect(signer).not.toHaveBeenCalled()
  })

  it('rejects signing and finalization when the control root is unrelated to the witness UTXO', () => {
    const unrelatedRoot = leafHash.slice()
    unrelatedRoot[0] = unrelatedRoot[0]! ^ 0xff
    const mismatched = createP2mrPsbt({
      inputs: [
        {
          prevout: { txid, vout: 0 },
          witnessUtxo: { value: 100_000n, scriptPubKey: p2mrScriptPubKey(unrelatedRoot) },
          leafScript,
          controlBlock,
          merkleRoot: unrelatedRoot,
        },
      ],
      outputs: [{ value: 90_000n, scriptPubKey }],
    })
    const signer = vi.fn(() => new Uint8Array(PQC_SIGNATURE_BYTES))
    expect(() =>
      signP2mrPsbt({
        psbt: mismatched,
        keys: [{ inputIndex: 0, pubkey, leafHash }],
        sign: signer,
      })
    ).toThrow(/control block.*witness UTXO/)
    expect(signer).not.toHaveBeenCalled()

    const forged = parsePsbt(serializePsbt(mismatched))
    forged.inputs[0]!.push(
      encodeP2mrPsbtScriptSigField(
        pubkey,
        leafHash,
        new Uint8Array(PQC_SIGNATURE_BYTES)
      )
    )
    expect(() => finalizeP2mrPsbt(forged)).toThrow(/control block.*witness UTXO/)
  })

  it('refuses to pair a leaf script with an unrelated signature pubkey', () => {
    const unrelatedPubkey = new Uint8Array(32).fill(0xa5)
    const forged = parsePsbt(serializePsbt(psbt))
    forged.inputs[0]!.push(
      encodeP2mrPsbtScriptSigField(
        unrelatedPubkey,
        leafHash,
        new Uint8Array(PQC_SIGNATURE_BYTES)
      )
    )

    expect(() => finalizeP2mrPsbt(forged)).toThrow(/no P2MR script signature is for a key of a v1 pk or multi_a leaf/)
  })

  it('refuses to pair a leaf script with an unrelated signature leaf hash', () => {
    const unrelatedLeafHash = new Uint8Array(32).fill(0x5a)
    const forged = parsePsbt(serializePsbt(psbt))
    forged.inputs[0]!.push(
      encodeP2mrPsbtScriptSigField(
        pubkey,
        unrelatedLeafHash,
        new Uint8Array(PQC_SIGNATURE_BYTES)
      )
    )

    expect(() => finalizeP2mrPsbt(forged)).toThrow(/no P2MR script signature is for a key of a v1 pk or multi_a leaf/)
  })
})

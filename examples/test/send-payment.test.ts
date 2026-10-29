import { EsploraClient, QbitApiError, txidFromRawTx, type EsploraUtxo, type QbitApiErrorKind } from '@qbit-oss/api'
import { init, type PqcDerivedKey } from '@qbit-oss/pqc'
import {
  addressToScriptPubKey,
  buildControlBlock,
  bytesToHex,
  createP2mrPsbt,
  extractP2mrTransaction,
  finalizeP2mrPsbt,
  hexToBytes,
  p2mrAddressFromPubkey,
  p2mrLeafHash,
  p2mrSighash,
  P2MR_LEAF_VERSION_V1,
  P2mrPsbtSigningError,
  PQC_SIGNATURE_BYTES,
  type P2mrTransaction,
  PSBT_GLOBAL_UNSIGNED_TX,
  psbtUnsignedTransaction,
  signP2mrPsbt,
  singleKeyLeafScript,
} from '@qbit-oss/protocol'
import { beforeAll, describe, expect, it, vi } from 'vitest'

import { WALLET_MAX_FEE_RATE } from '../src/check-balance'
import {
  abandonPendingPayment,
  AbandonPaymentError,
  reconcileBroadcast,
  sendPayment,
  SendPaymentError,
  type AbandonPaymentErrorCode,
  type PaymentStore,
  type SendPaymentErrorCode,
  type SendPaymentParams,
  type SignatureRecord,
} from '../src/send-payment'
import { BASE_URL, stubEsplora, type BroadcastReply, type StubEsploraOptions } from './stub-esplora'
import { testOnlyKey } from './test-only-keys'

// Lets a test run code while sendPayment's init() call loads the signer.
const signerLoad = vi.hoisted(() => ({ during: undefined as (() => Promise<void>) | undefined }))
vi.mock('@qbit-oss/pqc', async importOriginal => {
  const pqc = await importOriginal<typeof import('@qbit-oss/pqc')>()
  return {
    ...pqc,
    init: async (...args: Parameters<typeof pqc.init>) => {
      await signerLoad.during?.()
      return pqc.init(...args)
    },
  }
})

// Two confirmed outputs to spend, and an unconfirmed one the example leaves alone.
const UTXOS: EsploraUtxo[] = [
  { txid: 'a1'.repeat(32), vout: 1, value: 100_000, status: { confirmed: true, block_height: 120 } },
  { txid: 'c3'.repeat(32), vout: 0, value: 30_000, status: { confirmed: true, block_height: 121 } },
  { txid: 'b2'.repeat(32), vout: 0, value: 70_000, status: { confirmed: false } },
]
// More than the larger output can pay with its fee, so the payment spends both.
const AMOUNT_SATS = 110_000n
const FEE_RATE = 2 // sat/vB
// Two inputs and two outputs: 12 + 2 * 3,763 + 2 * 43 = 7,624 bytes estimated, 7,622 actual.
const FEE_SATS = 2n * 7_624n
const CHANGE_SATS = 130_000n - AMOUNT_SATS - FEE_SATS
// The smallest P2MR output qbit Core relays.
const DUST_THRESHOLD_SATS = 2_855n

let key: PqcDerivedKey
let from: string
let to: string

beforeAll(async () => {
  key = await testOnlyKey(0)
  from = p2mrAddressFromPubkey(key.pk32, 'regtest')
  to = p2mrAddressFromPubkey((await testOnlyKey(1)).pk32, 'regtest')
})

function memoryStore(onReserve?: () => void) {
  const reservations: string[] = []
  const signatures: SignatureRecord[] = []
  const pending = new Map<string, string>()
  const store: PaymentStore = {
    reserveSignature: pubkey => {
      reservations.push(bytesToHex(pubkey))
      onReserve?.()
    },
    saveSignature: record => void signatures.push(record),
    saveTransaction: (txid, rawTxHex) => void pending.set(txid, rawTxHex),
    dropTransaction: txid => void pending.delete(txid),
    pendingTransaction: () => {
      const [entry] = pending
      return entry && { txid: entry[0], rawTxHex: entry[1] }
    },
  }
  return { store, reservations, signatures, pending }
}

function setUp(
  options: Omit<StubEsploraOptions, 'address'> = {},
  controller = new AbortController(),
  onReserve?: () => void,
  Client = EsploraClient
) {
  const { store, reservations, signatures, pending } = memoryStore(onReserve)
  /** How many transactions were stored when each POST arrived. */
  const pendingAtEachPost: number[] = []
  const esplora = stubEsplora({
    ...options,
    address: from,
    utxos: options.utxos ?? UTXOS,
    onBroadcast: () => {
      pendingAtEachPost.push(pending.size)
      options.onBroadcast?.()
    },
  })
  const client = new Client({ baseUrl: BASE_URL, fetchFn: esplora.fetchFn })
  const send = (deadlineMs = 20_000, overrides: Partial<SendPaymentParams> = {}) =>
    sendPayment({
      client,
      key,
      to,
      amountSats: AMOUNT_SATS,
      feeRate: FEE_RATE,
      store,
      deadlineMs,
      signal: controller.signal,
      pollMs: 1,
      ...overrides,
    })
  return { esplora, client, send, store, reservations, signatures, pending, pendingAtEachPost }
}

/**
 * The unsigned transaction a payment builds, read from its PSBT, and the
 * requests it made. The store refuses the first signature, so nothing is
 * signed, stored or sent.
 */
async function plannedTransaction(
  options: Omit<StubEsploraOptions, 'address'>,
  overrides: Partial<SendPaymentParams> = {}
): Promise<{ tx: P2mrTransaction; requests: string[] }> {
  const { esplora, send, pending } = setUp(options, undefined, () => {
    throw new Error('test: no signature')
  })
  const error = await caught(send(20_000, overrides))
  if (!P2mrPsbtSigningError.is(error)) throw error
  expect(pending.size).toBe(0)
  expect(esplora.broadcasts).toEqual([])
  return { tx: psbtUnsignedTransaction(error.psbt), requests: esplora.requests }
}

/** The outputs `tx` spends, as `txid:vout` with the txid as explorers show it. */
const outpointsOf = (tx: P2mrTransaction) =>
  tx.inputs.map(({ prevout }) => `${bytesToHex(prevout.txid.slice().reverse())}:${prevout.vout}`)
/** An output in the block at `blockHeight`. The stub's tip is at height 2,000. */
const confirmedAt = (blockHeight: number, txid: string, value: number, vout = 0): EsploraUtxo => ({
  txid,
  vout,
  value,
  status: { confirmed: true, block_height: blockHeight },
})
/** An output 1,901 blocks deep, so the payment needs no lookup to spend it. */
const confirmed = (txid: string, value: number) => confirmedAt(100, txid, value)
/** An output 10 blocks deep, so the payment looks up its funding transaction first. */
const young = (txid: string, value: number, vout = 0) => confirmedAt(1_991, txid, value, vout)

/** A client that hands broadcastTx a txid that does not match the hex, which it refuses with a TypeError before sending. */
class MismatchedTxidClient extends EsploraClient {
  override broadcastTx(...[rawTxHex, options]: Parameters<EsploraClient['broadcastTx']>): Promise<string> {
    return super.broadcastTx(rawTxHex, { ...options, txid: '00'.repeat(32) })
  }
}

/** A client whose first broadcast sends the transaction, then fails with an error that is not a QbitApiError. */
class FailsAfterSendingClient extends EsploraClient {
  private thrown = false

  override async broadcastTx(...args: Parameters<EsploraClient['broadcastTx']>): Promise<string> {
    const txid = await super.broadcastTx(...args)
    if (this.thrown) return txid
    this.thrown = true
    throw new Error('test: a failure after the POST was sent')
  }
}

/** A client whose first broadcast fails with a kind this version of @qbit-oss/api does not list. */
class FutureKindClient extends EsploraClient {
  private thrown = false

  override async broadcastTx(...args: Parameters<EsploraClient['broadcastTx']>): Promise<string> {
    if (this.thrown) return super.broadcastTx(...args)
    this.thrown = true
    throw new QbitApiError(
      'kind_from_a_newer_version' as QbitApiErrorKind,
      'test: an error kind this version does not list'
    )
  }
}

const count = (requests: string[], suffix: string) => requests.filter(request => request.endsWith(suffix)).length
/** `getTx` calls: `GET /tx/:txid`. */
const lookups = (requests: string[]) => requests.filter(request => /^GET \/tx\/[0-9a-f]{64}$/.test(request)).length
const caught = (promise: Promise<unknown>) =>
  promise.then(
    () => undefined,
    (error: unknown) => error
  )
const reconcileOptions = (ms: number, pollMs = 1) => ({
  end: Date.now() + ms,
  signal: new AbortController().signal,
  pollMs,
})
const codeOf = (error: unknown) => error instanceof SendPaymentError && error.code
/** Replies a broken backend or proxy might send to `GET /tx/:txid`: JSON, but not the transaction. */
const NOT_THE_TRANSACTION: [string, unknown][] = [
  ['an empty object', {}],
  ['null', null],
  ['an array', []],
  ['a string', 'found'],
  ['another transaction', { txid: 'ab'.repeat(32), status: { confirmed: true } }],
  ['a txid that is not a string', { txid: 1 }],
]
/** A lookup reply that names `txid` in uppercase, which is still that transaction. */
const upperCaseReply = (txid: string) => ({ txid: txid.toUpperCase(), status: { confirmed: false } })
/** The txid of the unsigned transaction spending `spent` to `outputs`, as the example builds it. */
function unsignedTxid(spent: EsploraUtxo[], outputs: { value: bigint; scriptPubKey: Uint8Array }[]): string {
  const scriptPubKey = addressToScriptPubKey(from, 'regtest')
  const leafScript = singleKeyLeafScript(key.pk32)
  const psbt = createP2mrPsbt({
    inputs: spent.map(utxo => ({
      prevout: { txid: hexToBytes(utxo.txid).reverse(), vout: utxo.vout },
      witnessUtxo: { value: BigInt(utxo.value), scriptPubKey },
      leafScript,
      controlBlock: buildControlBlock(),
    })),
    outputs,
  })
  return txidFromRawTx(bytesToHex(psbt.global.find(entry => entry.key[0] === PSBT_GLOBAL_UNSIGNED_TX)!.value))
}

describe('send-payment example', () => {
  let paid: ReturnType<typeof setUp> & { txid: string; rawTxHex: string }

  beforeAll(async () => {
    const setup = setUp()
    paid = { ...setup, ...(await setup.send()) }
  })

  it('builds, signs, finalizes and broadcasts the payment', async () => {
    const { txid, rawTxHex, esplora, reservations, signatures, pending, pendingAtEachPost } = paid

    // Rebuilding the unsigned transaction the example should have built gives
    // the same txid: it spends both confirmed outputs, pays the recipient and
    // returns the change, at the requested fee rate.
    const scriptPubKey = addressToScriptPubKey(from, 'regtest')
    const leafScript = singleKeyLeafScript(key.pk32)
    const spent = UTXOS.slice(0, 2)
    const expected = createP2mrPsbt({
      inputs: spent.map(utxo => ({
        prevout: { txid: hexToBytes(utxo.txid).reverse(), vout: utxo.vout },
        witnessUtxo: { value: BigInt(utxo.value), scriptPubKey },
        leafScript,
        controlBlock: buildControlBlock(),
      })),
      outputs: [
        { value: AMOUNT_SATS, scriptPubKey: addressToScriptPubKey(to, 'regtest') },
        { value: CHANGE_SATS, scriptPubKey },
      ],
    })
    const unsignedTx = expected.global.find(entry => entry.key[0] === PSBT_GLOBAL_UNSIGNED_TX)!.value
    expect(txid).toBe(txidFromRawTx(bytesToHex(unsignedTx)))
    expect(rawTxHex.length / 2).toBe(7_622)
    expect(Number(FEE_SATS) / (rawTxHex.length / 2)).toBeGreaterThanOrEqual(FEE_RATE)

    // Each signature was reserved, persisted through onSigned, and is a valid
    // SLH-DSA signature of its input's P2MR sighash.
    expect(reservations).toEqual([bytesToHex(key.pk32), bytesToHex(key.pk32)])
    const leafHash = p2mrLeafHash(P2MR_LEAF_VERSION_V1, leafScript)
    // Each record names the transaction, input, key and leaf it signs.
    expect(
      signatures.map(({ txid, inputIndex, pubkey, leafHash }) => ({ txid, inputIndex, pubkey, leafHash }))
    ).toEqual([
      { txid, inputIndex: 0, pubkey: key.pk32, leafHash },
      { txid, inputIndex: 1, pubkey: key.pk32, leafHash },
    ])
    const pqc = await init()
    const tx = psbtUnsignedTransaction(expected)
    const spentOutputs = spent.map(utxo => ({ value: BigInt(utxo.value), scriptPubKey }))
    for (const { inputIndex, value } of signatures) {
      expect(value).toHaveLength(PQC_SIGNATURE_BYTES)
      expect(rawTxHex).toContain(bytesToHex(value))
      const sighash = p2mrSighash({ tx, inputIndex, spentOutputs, leafHash })
      expect(pqc.verify(key.pk32, sighash, value)).toBe(true)
    }

    // The transaction was stored before the one POST, and the node has it.
    expect(pendingAtEachPost).toEqual([1])
    expect(pending.get(txid)).toBe(rawTxHex)
    expect(esplora.broadcasts).toEqual([rawTxHex])
    expect(esplora.known.has(txid)).toBe(true)
  })

  it('reconciles a lost reply instead of sending again', async () => {
    // The node accepts the transaction, but the reply is lost: unknown_outcome.
    const { esplora, send } = setUp({ broadcastReplies: ['accept, reply lost'] })

    const { txid, rawTxHex } = await send()

    expect(esplora.broadcasts).toEqual([rawTxHex]) // never re-sent
    expect(lookups(esplora.requests)).toBe(1) // the first lookup finds it
    expect(count(esplora.requests, '/utxo')).toBe(1) // never rebuilt
    expect(esplora.known.has(txid)).toBe(true)
  })

  it('answers getTxStatus as qbit-electrs does, so a status reply proves nothing', async () => {
    // A txid the backend has never seen gets { confirmed: false }, as a
    // mempool transaction does; only getTx answers not_found.
    const { client } = setUp()
    const unknownTxid = 'ab'.repeat(32)

    await expect(client.getTxStatus(unknownTxid)).resolves.toEqual({ confirmed: false })
    const error = await caught(client.getTx(unknownTxid))
    expect(QbitApiError.is(error) && error.kind).toBe('not_found')
  })

  it('resubmits the same hex when the first POST never reaches the node', async () => {
    // The gateway's 504 leaves the outcome unknown, and the node never got the transaction.
    const { esplora, send, pending } = setUp({ broadcastReplies: ['lost', 'accept'] })

    const { txid, rawTxHex } = await send()

    // The identical bytes again, which reach the node, after three not_found lookups.
    expect(esplora.broadcasts).toEqual([rawTxHex, rawTxHex])
    expect(esplora.known.has(txid)).toBe(true)
    expect(lookups(esplora.requests)).toBe(3)
    expect(count(esplora.requests, '/utxo')).toBe(1)
    expect(pending.get(txid)).toBe(rawTxHex)
  })

  it('settles on an already-known reply to the resubmission while the indexer lags', async () => {
    // The node took the first POST and the transaction confirmed, but the
    // reply was lost and the indexer has not caught up, so getTx answers
    // not_found. The node answers the resubmission with RPC error -27.
    const { esplora, send, pending } = setUp({
      broadcastReplies: ['accept, reply lost', 'already known'],
      indexerLag: 3,
    })

    const { txid, rawTxHex } = await send()

    expect(lookups(esplora.requests)).toBe(3)
    expect(esplora.broadcasts).toEqual([rawTxHex, rawTxHex])
    expect(pending.get(txid)).toBe(rawTxHex)
  })

  it('drops the transaction when the node definitely rejects it', async () => {
    const { esplora, send, pending } = setUp({ broadcastReplies: ['reject'] })

    const error = await caught(send())

    expect(QbitApiError.is(error) && error.kind).toBe('http')
    expect(esplora.broadcasts).toHaveLength(1)
    expect(pending.size).toBe(0) // nothing left to resend later
  })

  it('treats an error kind it does not know as an unknown outcome', async () => {
    const { esplora, send, pending } = setUp({}, undefined, undefined, FutureKindClient)

    const { txid, rawTxHex } = await send()

    // Not dropped as a failure: reconciled, then resubmitted unchanged.
    expect(lookups(esplora.requests)).toBe(3)
    expect(esplora.broadcasts).toEqual([rawTxHex])
    expect(pending.get(txid)).toBe(rawTxHex)
  })

  it('keeps polling after a rejected resubmission, and finds the first copy confirmed', async () => {
    // The first copy confirms while the client cannot tell, so resubmitting
    // it is rejected as spending spent inputs.
    const { esplora, send, pending } = setUp({ broadcastReplies: ['lost', 'reject, already confirmed'] })

    const { txid, rawTxHex } = await send()

    expect(esplora.broadcasts).toEqual([rawTxHex, rawTxHex])
    expect(lookups(esplora.requests)).toBe(4) // three not_found, then the confirmed transaction
    expect(pending.get(txid)).toBe(rawTxHex)
  })

  it('never reports a rejected resubmission as a definite failure', async () => {
    const rejecting = stubEsplora({ address: from, broadcastReplies: Array<BroadcastReply>(1_000).fill('reject') })
    const client = new EsploraClient({ baseUrl: BASE_URL, fetchFn: rejecting.fetchFn })

    const error = await caught(reconcileBroadcast(client, paid.rawTxHex, reconcileOptions(200)))

    expect(QbitApiError.is(error) && error.kind).toBe('unknown_outcome')
    expect(QbitApiError.is(error) && error.txid).toBe(paid.txid)
    expect(rejecting.broadcasts.length).toBeGreaterThan(1)
    expect(new Set(rejecting.broadcasts)).toEqual(new Set([paid.rawTxHex])) // only ever the same bytes
  })

  it('keeps the outcome unknown when cancelled, and resumes from the stored hex', async () => {
    // The user cancels while the POST is in flight, and the request never reached the node.
    const controller = new AbortController()
    const { esplora, client, send, pending } = setUp(
      { broadcastReplies: ['lost'], onBroadcast: () => controller.abort() },
      controller
    )

    const error = await caught(send())

    // Cancelling cannot undo a submission that may have happened: the error
    // stays unknown_outcome, never a plain abort, and the transaction stays pending.
    expect(QbitApiError.is(error) && error.kind).toBe('unknown_outcome')
    expect(pending.size).toBe(1)
    const [[txid, rawTxHex]] = [...pending] as [[string, string]]
    expect(QbitApiError.is(error) && error.txid).toBe(txid)
    expect(esplora.broadcasts).toEqual([rawTxHex])

    // Later, for example after a restart, the wallet settles it from what it stored.
    await reconcileBroadcast(client, rawTxHex, reconcileOptions(5_000))
    expect(esplora.broadcasts).toEqual([rawTxHex, rawTxHex])
    expect(esplora.known.has(txid)).toBe(true)
    expect(count(esplora.requests, '/utxo')).toBe(1)
  })

  it('stops between signatures when cancelled, with nothing stored or sent', async () => {
    // The user cancels while the first input is being signed.
    const controller = new AbortController()
    const { esplora, send, reservations, signatures, pending } = setUp({}, controller, () => controller.abort())

    const error = await caught(send())

    expect(P2mrPsbtSigningError.is(error) && error.signed.map(plan => plan.inputIndex)).toEqual([0])
    expect(reservations).toHaveLength(1) // the second input was never signed
    expect(signatures).toHaveLength(1)
    expect(pending.size).toBe(0)
    expect(esplora.broadcasts).toEqual([])
  })

  it('stops before storing or sending when a timer cancels the payment during signing', async () => {
    // The timer is due as soon as the first of two inputs starts signing, but
    // signing blocks the thread, so it can only run once both are signed.
    const controller = new AbortController()
    const abortedAtEachReserve: boolean[] = []
    const { esplora, send, reservations, signatures, pending } = setUp({}, controller, () => {
      if (abortedAtEachReserve.length === 0) setTimeout(() => controller.abort(), 0)
      abortedAtEachReserve.push(controller.signal.aborted)
    })

    const error = await caught(send())

    expect(abortedAtEachReserve).toEqual([false, false]) // the cancel arrived only after signing
    expect(error).toBe(controller.signal.reason)
    expect(reservations).toHaveLength(2)
    expect(signatures).toHaveLength(2)
    expect(pending.size).toBe(0)
    expect(esplora.broadcasts).toEqual([])
  })

  it('reports a deadline that passes during signing as a timeout, with nothing stored or sent', async () => {
    // The clock jumps past the deadline while the second input is signed.
    const realNow = Date.now.bind(Date)
    let skewMs = 0
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => realNow() + skewMs)
    try {
      let reserved = 0
      const { esplora, send, signatures, pending } = setUp({}, undefined, () => {
        reserved += 1
        if (reserved === 2) skewMs = 60_000
      })

      const error = await caught(send(20_000))

      expect(QbitApiError.is(error) && error.kind).toBe('timeout')
      expect(signatures).toHaveLength(2)
      expect(pending.size).toBe(0)
      expect(esplora.broadcasts).toEqual([])
    } finally {
      clock.mockRestore()
    }
  })

  it('refuses a new payment while one is still pending', async () => {
    const { esplora, send, pending } = setUp()
    const { txid } = await send()

    const error = await caught(send())

    expect(codeOf(error)).toBe('pending')
    expect(error instanceof SendPaymentError && error.txid).toBe(txid)
    expect(error instanceof Error && error.message).toContain(txid)
    expect(count(esplora.requests, '/utxo')).toBe(1) // the second call did not even scan
    expect(esplora.broadcasts).toHaveLength(1)
    expect([...pending.keys()]).toEqual([txid])
  })

  it('stops a stalled scan at the deadline, before anything is signed or sent', async () => {
    // The client's own timeout is 15 s, so only the deadline can stop this early.
    const { esplora, send, reservations, pending } = setUp({ stallReads: true })
    const started = Date.now()

    const error = await caught(send(200))

    expect(QbitApiError.is(error) && error.kind).toBe('timeout')
    expect(Date.now() - started).toBeLessThan(5_000)
    expect(reservations).toEqual([])
    expect(pending.size).toBe(0)
    expect(esplora.broadcasts).toEqual([])
  })

  it('settles only on a lookup reply that is the transaction, whatever JSON the backend sends', async () => {
    for (const [name, body] of NOT_THE_TRANSACTION) {
      // The first POST never reached the node, and every lookup answers 200 with `body`.
      const esplora = stubEsplora({ address: from, lookupReply: () => body })
      const client = new EsploraClient({ baseUrl: BASE_URL, fetchFn: esplora.fetchFn })

      await reconcileBroadcast(client, paid.rawTxHex, reconcileOptions(400, 100))

      // Neither found nor not_found: it keeps polling, and only the last round resubmits.
      expect(lookups(esplora.requests), name).toBeGreaterThan(1)
      expect(esplora.broadcasts, name).toEqual([paid.rawTxHex])
      expect(esplora.known.has(paid.txid), name).toBe(true)
    }

    // The txid compares case-insensitively.
    const upper = stubEsplora({ address: from, lookupReply: upperCaseReply })
    const client = new EsploraClient({ baseUrl: BASE_URL, fetchFn: upper.fetchFn })
    await reconcileBroadcast(client, paid.rawTxHex, reconcileOptions(5_000))
    expect(lookups(upper.requests)).toBe(1)
    expect(upper.broadcasts).toEqual([])
  })

  it('keeps the outcome unknown when the deadline passes while the POST is in flight', async () => {
    // The clock jumps past the deadline while the node takes the transaction,
    // and the reply is lost. reconcileBroadcast then gets an `end` that has
    // passed, which is no invalid option: the transaction may have been sent.
    const realNow = Date.now.bind(Date)
    let skewMs = 0
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => realNow() + skewMs)
    try {
      const { esplora, send, pending } = setUp({
        broadcastReplies: ['accept, reply lost'],
        onBroadcast: () => {
          skewMs = 60_000
        },
      })

      const error = await caught(send(20_000))

      expect(QbitApiError.is(error) && error.kind).toBe('unknown_outcome')
      expect(lookups(esplora.requests)).toBe(0)
      expect([...pending.values()]).toEqual(esplora.broadcasts)
    } finally {
      clock.mockRestore()
    }
  })

  it.each<[string, { endMs?: number; pollMs?: number }]>([
    ['a zero poll interval', { pollMs: 0 }],
    ['a NaN poll interval', { pollMs: Number.NaN }],
    ['a poll interval longer than a timer can wait', { pollMs: 2_147_483_648 }],
    ['a NaN end', { endMs: Number.NaN }],
    ['an infinite end', { endMs: Number.POSITIVE_INFINITY }],
    ['an end further away than a timer can wait', { endMs: 2_147_483_647 + 60_000 }],
  ])('refuses to reconcile with %s, before any request', async (_, { endMs = 5_000, pollMs = 1 }) => {
    const esplora = stubEsplora({ address: from })
    const client = new EsploraClient({ baseUrl: BASE_URL, fetchFn: esplora.fetchFn })
    // Unchecked, such a call would poll back to back, or never settle, until the signal aborts.
    const options = { end: Date.now() + endMs, signal: AbortSignal.timeout(1_000), pollMs }

    const error = await caught(reconcileBroadcast(client, paid.rawTxHex, options))

    expect(codeOf(error)).toBe('invalid_options')
    expect(esplora.requests).toEqual([])
  })

  it('stops a stalled reconciliation at the deadline with the outcome still unknown', async () => {
    // Neither the indexer nor the node ever answers.
    const stalled = stubEsplora({ address: from, stallReads: true, broadcastReplies: ['stall'] })
    const client = new EsploraClient({ baseUrl: BASE_URL, fetchFn: stalled.fetchFn })
    const started = Date.now()

    const error = await caught(reconcileBroadcast(client, paid.rawTxHex, reconcileOptions(1_000, 200)))

    expect(QbitApiError.is(error) && error.kind).toBe('unknown_outcome')
    expect(Date.now() - started).toBeLessThan(5_000)
    // The first lookup stops 200 ms before the end, and the last round looks
    // the transaction up and resubmits it once, both stalling too.
    expect(lookups(stalled.requests)).toBe(2)
    expect(stalled.broadcasts).toEqual([paid.rawTxHex])
  })

  it('lets only one of two overlapping payments store and send a transaction', async () => {
    // Both calls share one store and start before either stores anything, so
    // both pass the first pending check, and both sign.
    const { esplora, send, reservations, pending } = setUp()

    const results = await Promise.allSettled([send(), send(20_000, { amountSats: AMOUNT_SATS + 1_000n })])

    expect(reservations).toHaveLength(4)
    const paidOnce = results.flatMap(result => (result.status === 'fulfilled' ? [result.value] : []))
    const refused = results.flatMap(result => (result.status === 'rejected' ? [result.reason] : []))
    expect(paidOnce).toHaveLength(1)
    expect(refused.map(codeOf)).toEqual(['pending'])
    expect(refused[0] instanceof SendPaymentError && refused[0].txid).toBe(paidOnce[0]!.txid)
    expect(esplora.broadcasts).toEqual([paidOnce[0]!.rawTxHex])
    expect([...pending.keys()]).toEqual([paidOnce[0]!.txid])
  })

  it.each<[string, Partial<SendPaymentParams>, SendPaymentErrorCode]>([
    ['a NaN fee rate', { feeRate: Number.NaN }, 'invalid_fee_rate'],
    ['an infinite fee rate', { feeRate: Number.POSITIVE_INFINITY }, 'invalid_fee_rate'],
    ['a zero fee rate', { feeRate: 0 }, 'invalid_fee_rate'],
    ['a negative fee rate', { feeRate: -2 }, 'invalid_fee_rate'],
    ["a fee rate below qbit Core's minimum relay fee rate, 0.25 sat/vB", { feeRate: 0.24 }, 'invalid_fee_rate'],
    ["a fee rate above the wallet's ceiling", { feeRate: WALLET_MAX_FEE_RATE + 0.5 }, 'invalid_fee_rate'],
    ['a fee rate that is a string', { feeRate: '2' as unknown as number }, 'invalid_fee_rate'],
    ['a zero amount', { amountSats: 0n }, 'invalid_amount'],
    ['a negative amount', { amountSats: -AMOUNT_SATS }, 'invalid_amount'],
    ['an amount below the dust threshold', { amountSats: DUST_THRESHOLD_SATS - 1n }, 'invalid_amount'],
    ['an amount that is a number', { amountSats: 50_000 as unknown as bigint }, 'invalid_amount'],
    ['a NaN deadline', { deadlineMs: Number.NaN }, 'invalid_options'],
    // The longest delay a timer supports, and the most the client accepts as `deadlineMs`, is 2,147,483,647 ms.
    ['a deadline longer than a timer can wait', { deadlineMs: 2_147_483_648 }, 'invalid_options'],
    ['a zero poll interval', { pollMs: 0 }, 'invalid_options'],
    ['a poll interval longer than a timer can wait', { pollMs: 2_147_483_648 }, 'invalid_options'],
  ])('refuses %s before any request or signature', async (_, params, code) => {
    const { esplora, send, reservations, pending } = setUp()

    const error = await caught(send(20_000, params))

    expect(codeOf(error)).toBe(code)
    expect(esplora.requests).toEqual([])
    expect(reservations).toEqual([])
    expect(pending.size).toBe(0)
  })

  it('folds change below the dust threshold into the fee, and keeps change at the threshold', async () => {
    // The smallest amount and the largest fee rate the example accepts. With
    // one input, the transaction takes 12 + 3,763 + 2 * 43 = 3,861 bytes with change.
    const amountSats = DUST_THRESHOLD_SATS
    const feeSats = BigInt(WALLET_MAX_FEE_RATE) * 3_861n
    const recipient = addressToScriptPubKey(to, 'regtest')
    for (const changeSats of [DUST_THRESHOLD_SATS - 1n, DUST_THRESHOLD_SATS]) {
      const value = Number(amountSats + feeSats + changeSats)
      const funding: EsploraUtxo = { ...confirmed('d4'.repeat(32), value), vout: 2 }
      const { send } = setUp({ utxos: [funding] })

      const { txid } = await send(20_000, { amountSats, feeRate: WALLET_MAX_FEE_RATE })

      const outputs = [{ value: amountSats, scriptPubKey: recipient }]
      if (changeSats >= DUST_THRESHOLD_SATS) {
        outputs.push({ value: changeSats, scriptPubKey: addressToScriptPubKey(from, 'regtest') })
      }
      expect(txid).toBe(unsignedTxid([funding], outputs))
    }
  })

  it('resubmits after the first miss when the deadline leaves no time to poll again', async () => {
    // The first POST never reached the node, and 300 ms are left: less than one 2-second poll.
    const esplora = stubEsplora({ address: from })
    const client = new EsploraClient({ baseUrl: BASE_URL, fetchFn: esplora.fetchFn })

    await reconcileBroadcast(client, paid.rawTxHex, reconcileOptions(300, 2_000))

    expect(lookups(esplora.requests)).toBe(1)
    expect(esplora.broadcasts).toEqual([paid.rawTxHex])
    expect(esplora.known.has(paid.txid)).toBe(true)
  })

  it('drops the transaction on a TypeError, which broadcastTx throws before sending, and reconciles any other error', async () => {
    const refused = setUp({}, undefined, undefined, MismatchedTxidClient)

    const error = await caught(refused.send(5_000))

    expect(error).toBeInstanceOf(TypeError)
    expect(refused.esplora.broadcasts).toEqual([]) // nothing was sent
    expect(lookups(refused.esplora.requests)).toBe(0)
    expect(refused.pending.size).toBe(0)

    // An error that is neither a QbitApiError nor a TypeError may follow a send, so it is unknown.
    const failed = setUp({}, undefined, undefined, FailsAfterSendingClient)

    const { txid, rawTxHex } = await failed.send()

    expect(failed.esplora.broadcasts).toEqual([rawTxHex])
    expect(lookups(failed.esplora.requests)).toBe(1) // found: never re-sent
    expect(failed.pending.get(txid)).toBe(rawTxHex)
  })

  it.each<[string, Record<string, unknown>]>([
    ['a txid that is not hex', { txid: 'zz'.repeat(32) }],
    ['a txid that is too short', { txid: 'c3'.repeat(31) }],
    ['a vout above 2^32 - 1', { vout: 2 ** 32 }],
    ['a negative vout', { vout: -1 }],
    ['a fractional vout', { vout: 0.5 }],
    ['a value above 2^53', { value: 2 ** 53 }],
    ['a negative value', { value: -1 }],
    ['a value that is a string', { value: '30000' }],
  ])('refuses a UTXO row with %s before any key is used', async (_, row) => {
    const { esplora, send, reservations, pending } = setUp({
      utxos: [UTXOS[0]!, { ...UTXOS[1]!, ...row } as EsploraUtxo],
    })

    const error = await caught(send())

    expect(codeOf(error)).toBe('invalid_utxos')
    expect(reservations).toEqual([])
    expect(pending.size).toBe(0)
    expect(esplora.broadcasts).toEqual([])
  })

  it('refuses a UTXO list that names one outpoint twice', async () => {
    // Counting the repeated row would overstate the funds by its value.
    const { esplora, send, reservations } = setUp({ utxos: [...UTXOS, { ...UTXOS[1]! }] })

    const error = await caught(send())

    expect(codeOf(error)).toBe('invalid_utxos')
    expect(error instanceof Error && error.message).toContain(`${UTXOS[1]!.txid}:${UTXOS[1]!.vout}`)
    expect(reservations).toEqual([])
    expect(esplora.broadcasts).toEqual([])
  })

  it('saves each signature with its txid, so a payment stopped while signing can be finished', async () => {
    // The user cancels while the first of two inputs is being signed.
    const controller = new AbortController()
    const { esplora, send, signatures } = setUp({}, controller, () => controller.abort())

    const error = await caught(send())

    if (!P2mrPsbtSigningError.is(error)) throw error
    expect(signatures).toHaveLength(1)
    const [record] = signatures as [SignatureRecord]
    const leafHash = p2mrLeafHash(P2MR_LEAF_VERSION_V1, singleKeyLeafScript(key.pk32))
    expect(record).toMatchObject({ inputIndex: 0, pubkey: key.pk32, leafHash })

    // Resume as sendPayment's doc says: error.psbt, with only the plans not in error.signed.
    const plans = error.psbt.inputs.map((_, inputIndex) => ({ inputIndex, pubkey: key.pk32, leafHash }))
    const unsigned = plans.filter(plan => !error.signed.some(done => done.inputIndex === plan.inputIndex))
    const pqc = await init()
    const resumed = signP2mrPsbt({ psbt: error.psbt, keys: unsigned, sign: sighash => pqc.sign(key.sk64, sighash) })
    const rawTxHex = bytesToHex(extractP2mrTransaction(finalizeP2mrPsbt(resumed.psbt)))

    // The finished transaction is the one the saved signature names, with that signature in it.
    expect(resumed.signed.map(plan => plan.inputIndex)).toEqual([1])
    expect(txidFromRawTx(rawTxHex)).toBe(record.txid)
    expect(rawTxHex).toContain(bytesToHex(record.value))
    expect(esplora.broadcasts).toEqual([])
  })

  it('accepts the longest deadline and poll interval a timer can wait', async () => {
    const { tx } = await plannedTransaction({}, { deadlineMs: 2_147_483_647, pollMs: 2_147_483_647 })

    expect(tx.inputs).toHaveLength(2)

    // reconcileBroadcast too, and an `end` that has already passed, which leaves the outcome unknown.
    const esplora = stubEsplora({ address: from })
    const client = new EsploraClient({ baseUrl: BASE_URL, fetchFn: esplora.fetchFn })
    for (const options of [
      { end: Date.now() + 2_147_483_647, pollMs: 2_147_483_647, signal: AbortSignal.abort() },
      { end: Date.now() - 1, pollMs: 2_147_483_647, signal: new AbortController().signal },
    ]) {
      const error = await caught(reconcileBroadcast(client, paid.rawTxHex, options))
      expect(QbitApiError.is(error) && error.kind).toBe('unknown_outcome')
    }
    expect(esplora.requests).toEqual([])
  })

  it("pays at least qbit Core's minimum relay fee at the lowest fee rate it accepts", async () => {
    // One input and two outputs: 12 + 3,763 + 2 * 43 = 3,861 bytes estimated,
    // so 0.25 sat/vB pays 966 sats.
    const amountSats = 50_000n
    const funding = confirmed('d4'.repeat(32), 100_000)
    const { send } = setUp({ utxos: [funding] })

    const { txid, rawTxHex } = await send(20_000, { amountSats, feeRate: 0.25 })

    const change = { value: 100_000n - amountSats - 966n, scriptPubKey: addressToScriptPubKey(from, 'regtest') }
    expect(txid).toBe(
      unsignedTxid([funding], [{ value: amountSats, scriptPubKey: addressToScriptPubKey(to, 'regtest') }, change])
    )
    // Core asks 250 sat/kvB of the transaction's size, rounded up (DEFAULT_MIN_RELAY_TX_FEE).
    expect(966).toBeGreaterThanOrEqual(Math.ceil((rawTxHex.length / 2) * 0.25))
  })

  it('spends the largest confirmed outputs first, and only as many as the payment needs', async () => {
    const utxos = [
      // At 2 sat/vB, spending an input costs 2 * 3,763 = 7,526 sats: this one
      // is worth no more than that, and spending every output would waste it.
      confirmed('e5'.repeat(32), 7_526),
      confirmed('c3'.repeat(32), 30_000),
      confirmed('a1'.repeat(32), 100_000),
      confirmed('d4'.repeat(32), 60_000),
      { txid: 'b2'.repeat(32), vout: 0, value: 200_000, status: { confirmed: false } },
    ]

    const { tx } = await plannedTransaction({ utxos })

    // 100,000 alone cannot pay 110,000 and the fee; with 60,000, it pays them
    // and returns the rest. Two inputs and two outputs, as in the first test.
    expect(outpointsOf(tx)).toEqual([`${'a1'.repeat(32)}:0`, `${'d4'.repeat(32)}:0`])
    expect(tx.outputs.map(output => output.value)).toEqual([AMOUNT_SATS, 160_000n - AMOUNT_SATS - FEE_SATS])
  })

  it("spends at most 106 inputs, which keeps the transaction within qbit Core's standard size", async () => {
    // At 1 sat/vB, each 10,000-sat output adds 10,000 - 3,763 = 6,237 sats.
    // 106 of them pay 1,060,000 - (12 + 106 * 3,763 + 43) = 661,067 sats with
    // no change; one sat more takes 107. Core relays up to 400,000 bytes, and
    // 106 inputs with two outputs take at most 12 + 106 * 3,763 + 2 * 43 = 398,976.
    const utxos = Array.from({ length: 120 }, (_, index) => confirmed(index.toString(16).padStart(64, '0'), 10_000))

    const { tx } = await plannedTransaction({ utxos }, { amountSats: 661_067n, feeRate: 1 })

    expect(tx.inputs).toHaveLength(106)
    expect(tx.outputs.map(output => output.value)).toEqual([661_067n])

    for (const [amountSats, code] of [
      [661_068n, 'too_many_inputs'],
      // All 120 pay at most 120 * 6,237 - 55 = 748,385 sats.
      [748_386n, 'insufficient_funds'],
    ] as const) {
      const { esplora, send, reservations, pending } = setUp({ utxos })

      const error = await caught(send(20_000, { amountSats, feeRate: 1 }))

      expect(codeOf(error)).toBe(code)
      expect(reservations).toEqual([])
      expect(pending.size).toBe(0)
      expect(esplora.broadcasts).toEqual([])
    }
  })

  it('starts the UTXO scan while the signer loads', async () => {
    const { esplora, send } = setUp()
    let scansWhileLoading: number | undefined
    signerLoad.during = async () => {
      await new Promise(resolve => setTimeout(resolve, 50))
      scansWhileLoading = count(esplora.requests, '/utxo')
    }
    try {
      // More than the address holds, so it stops before signing.
      const error = await caught(send(20_000, { amountSats: 1_000_000n }))
      expect(codeOf(error)).toBe('insufficient_funds')
    } finally {
      signerLoad.during = undefined
    }

    expect(scansWhileLoading).toBe(1)
  })

  it('resubmits once and stops when less than two polls are left, however fast the backend fails', async () => {
    // Every lookup misses and every resubmission is refused, at once.
    const failing = stubEsplora({ address: from, broadcastReplies: Array<BroadcastReply>(1_000).fill('reject') })
    const client = new EsploraClient({ baseUrl: BASE_URL, fetchFn: failing.fetchFn })

    const error = await caught(reconcileBroadcast(client, paid.rawTxHex, reconcileOptions(1_000, 1_000)))

    expect(QbitApiError.is(error) && error.kind).toBe('unknown_outcome')
    expect(failing.requests).toEqual([`GET /tx/${paid.txid}`, 'POST /tx'])
  })

  it('skips a coinbase output with 1,000 confirmations, and spends one with 1,001', async () => {
    // A wallet funded by mining, at tip 2,000. qbit Core's mempool would take
    // a spend of the larger coinbase output, at height 1,001, but its wallet
    // waits a block more, and so does the payment.
    const immature = confirmedAt(1_001, 'c0'.repeat(32), 500_000)
    const mature = confirmedAt(1_000, 'c1'.repeat(32), 200_000)

    const { tx, requests } = await plannedTransaction({
      utxos: [immature, mature],
      tipHeight: 2_000,
      coinbase: [immature.txid, mature.txid],
    })

    expect(outpointsOf(tx)).toEqual([`${mature.txid}:0`])
    // Only the younger one needs a lookup.
    expect(requests.filter(request => request.startsWith('GET /tx/'))).toEqual([`GET /tx/${immature.txid}`])
  })

  it('looks each young funding transaction up once, and spends its outputs when no coinbase made them', async () => {
    // Two outputs of one transaction 10 blocks deep, and one whose row gives no block height.
    const noHeight: EsploraUtxo = { txid: 'f6'.repeat(32), vout: 0, value: 40_000, status: { confirmed: true } }
    const utxos = [young('e5'.repeat(32), 60_000, 0), young('e5'.repeat(32), 50_000, 1), noHeight]

    // 60,000 and 50,000 cannot pay 120,000 and the fee; with 40,000 they can.
    const { tx, requests } = await plannedTransaction({ utxos }, { amountSats: 120_000n })

    expect(outpointsOf(tx)).toEqual([`${'e5'.repeat(32)}:0`, `${'e5'.repeat(32)}:1`, `${'f6'.repeat(32)}:0`])
    expect(requests.filter(request => request.startsWith('GET /tx/'))).toEqual([
      `GET /tx/${'e5'.repeat(32)}`,
      `GET /tx/${'f6'.repeat(32)}`,
    ])
  })

  it('refuses with immature_funds when only coinbase outputs that are not mature could pay, before any key is used', async () => {
    const immature = young('c0'.repeat(32), 500_000)
    const utxos = [immature, confirmed('d4'.repeat(32), 20_000)]

    for (const [amountSats, code, fundingLookups] of [
      [AMOUNT_SATS, 'immature_funds', 1],
      // Not even the coinbase output could pay this, so nothing is looked up.
      [1_000_000n, 'insufficient_funds', 0],
    ] as const) {
      const { esplora, send, reservations, pending } = setUp({ utxos, coinbase: [immature.txid] })

      const error = await caught(send(20_000, { amountSats }))

      expect(codeOf(error)).toBe(code)
      expect(lookups(esplora.requests)).toBe(fundingLookups)
      expect(reservations).toEqual([])
      expect(pending.size).toBe(0)
      expect(esplora.broadcasts).toEqual([])
    }
  })

  it('looks up at most 106 funding transactions, and counts the young outputs of any other as unspendable', async () => {
    // 107 coinbase outputs 10 blocks deep, each larger than any of the three mature outputs.
    const immature = Array.from({ length: 107 }, (_, index) => young(index.toString(16).padStart(64, '0'), 100_000))
    const mature = ['d1', 'd2', 'd3'].map(byte => confirmed(byte.repeat(32), 50_000))
    const options = { utxos: [...immature, ...mature], coinbase: immature.map(utxo => utxo.txid) }

    // The three mature outputs pay 110,000 and the fee: 150,000 - 110,000 >= 2 * (12 + 3 * 3,763 + 43).
    const { tx, requests } = await plannedTransaction(options)

    expect(outpointsOf(tx)).toEqual(mature.map(utxo => `${utxo.txid}:0`))
    expect(lookups(requests)).toBe(106)

    // They cannot pay 150,000, and the outputs it did not look up count as unspendable.
    const { esplora, send, reservations } = setUp(options)

    const error = await caught(send(20_000, { amountSats: 150_000n }))

    expect(codeOf(error)).toBe('immature_funds')
    expect(error instanceof Error && error.message).toContain('did not check')
    expect(lookups(esplora.requests)).toBe(106)
    expect(reservations).toEqual([])
  })

  it('takes at most 106 inputs, and looks up no output past them', async () => {
    // A young coinbase output that alone could pay, then 106 outputs of one
    // young transaction no coinbase made, then one of another.
    const immature = young('c0'.repeat(32), 1_000_000)
    const spendable = Array.from({ length: 106 }, (_, vout) => young('e5'.repeat(32), 10_000, vout))
    const next = young('e6'.repeat(32), 9_000)
    const { esplora, send, reservations } = setUp({
      utxos: [immature, ...spendable, next],
      coinbase: [immature.txid],
    })

    // The 106 pay at most 106 * (10,000 - 3,763) - 55 = 661,067 sats at 1 sat/vB.
    const error = await caught(send(20_000, { amountSats: 700_000n, feeRate: 1 }))

    expect(codeOf(error)).toBe('immature_funds')
    expect(esplora.requests.filter(request => request.startsWith('GET /tx/'))).toEqual([
      `GET /tx/${immature.txid}`,
      `GET /tx/${'e5'.repeat(32)}`,
    ])
    expect(reservations).toEqual([])
  })

  it('stops a stalled funding transaction lookup at the deadline, before any key is used', async () => {
    const { esplora, send, reservations, pending } = setUp({
      utxos: [young('e5'.repeat(32), 200_000)],
      stallLookups: true,
    })
    const started = Date.now()

    const error = await caught(send(300))

    expect(QbitApiError.is(error) && error.kind).toBe('timeout')
    expect(Date.now() - started).toBeLessThan(5_000)
    expect(lookups(esplora.requests)).toBe(1)
    expect(reservations).toEqual([])
    expect(pending.size).toBe(0)
    expect(esplora.broadcasts).toEqual([])
  })

  it('refuses to pay when a funding transaction lookup does not answer with that transaction and its coinbase flag', async () => {
    const funding = young('e5'.repeat(32), 200_000)
    const replies: [string, unknown][] = [
      ...NOT_THE_TRANSACTION,
      ['the transaction without inputs', { txid: funding.txid, vin: [] }],
      ['the transaction without vin', { txid: funding.txid }],
      ['an is_coinbase that is not a boolean', { txid: funding.txid, vin: [{ is_coinbase: 'false' }] }],
    ]
    for (const [name, body] of replies) {
      const { esplora, send, reservations } = setUp({ utxos: [funding], lookupReply: () => body })

      const error = await caught(send())

      expect(QbitApiError.is(error) && error.kind, name).toBe('parse')
      expect(reservations, name).toEqual([])
      expect(esplora.broadcasts, name).toEqual([])
    }

    // The txid compares case-insensitively.
    const { tx } = await plannedTransaction({
      utxos: [funding],
      lookupReply: txid => ({ txid: txid.toUpperCase(), vin: [{ is_coinbase: false }] }),
    })
    expect(outpointsOf(tx)).toEqual([`${funding.txid}:0`])
  })

  it.each([
    ['a negative tip height', -1],
    ['a tip height above 2^53', 2 ** 60],
  ])('refuses %s, which is not a block height, before any key is used', async (_, tipHeight) => {
    const { esplora, send, reservations } = setUp({ tipHeight })

    const error = await caught(send())

    expect(QbitApiError.is(error) && error.kind).toBe('parse')
    expect(reservations).toEqual([])
    expect(esplora.broadcasts).toEqual([])
  })

  it('keeps an end that passes between two readings of the clock an unknown outcome, never an invalid option', async () => {
    const esplora = stubEsplora({ address: from })
    const client = new EsploraClient({ baseUrl: BASE_URL, fetchFn: esplora.fetchFn })
    const end = Date.now() + 1_000
    // The clock reads 1 ms before `end`, then `end`, as if it ticked between two readings.
    const clock = vi
      .spyOn(Date, 'now')
      .mockReturnValueOnce(end - 1)
      .mockReturnValue(end)
    try {
      const error = await caught(
        reconcileBroadcast(client, paid.rawTxHex, { end, signal: new AbortController().signal, pollMs: 1 })
      )

      expect(QbitApiError.is(error) && error.kind).toBe('unknown_outcome')
      expect(esplora.requests).toEqual([])
    } finally {
      clock.mockRestore()
    }
  })

  it('leaves the last round time to resubmit when its lookup stalls', async () => {
    // The first POST never reached the node, the indexer never answers, and
    // less than two polls are left.
    const stalled = stubEsplora({ address: from, stallReads: true })
    const client = new EsploraClient({ baseUrl: BASE_URL, fetchFn: stalled.fetchFn })

    await reconcileBroadcast(client, paid.rawTxHex, reconcileOptions(1_000, 1_000))

    expect(lookups(stalled.requests)).toBe(1)
    expect(stalled.broadcasts).toEqual([paid.rawTxHex])
    expect(stalled.known.has(paid.txid)).toBe(true)
  })

  it('leaves the last round time to resubmit when a lookup in an earlier round stalls', async () => {
    // The first POST never reached the node, and the indexer never answers.
    // 1,000 ms are left, at least two 400 ms polls, so the first round is not the last.
    let resubmittedAt: number | undefined
    const stalled = stubEsplora({
      address: from,
      stallReads: true,
      onBroadcast: () => {
        resubmittedAt = Date.now()
      },
    })
    const client = new EsploraClient({ baseUrl: BASE_URL, fetchFn: stalled.fetchFn })
    const options = reconcileOptions(1_000, 400)

    await reconcileBroadcast(client, paid.rawTxHex, options)

    // The first lookup stops 400 ms before the end, and the last round looks
    // the transaction up again, then resubmits the same hex once.
    expect(lookups(stalled.requests)).toBe(2)
    expect(stalled.broadcasts).toEqual([paid.rawTxHex])
    expect(resubmittedAt).toBeLessThan(options.end)
    expect(stalled.known.has(paid.txid)).toBe(true)
  })

  it('leaves the last round time to resubmit when a resubmission in an earlier round stalls', async () => {
    // The first POST never reached the node. Three lookups miss, the
    // resubmission that follows never gets a reply, and the next is accepted.
    const esplora = stubEsplora({ address: from, broadcastReplies: ['stall'] })
    const client = new EsploraClient({ baseUrl: BASE_URL, fetchFn: esplora.fetchFn })

    await reconcileBroadcast(client, paid.rawTxHex, reconcileOptions(1_500, 200))

    // The stalled resubmission stops 200 ms before the end, and the last
    // round looks the transaction up once more, then resubmits it again.
    expect(lookups(esplora.requests)).toBe(4)
    expect(esplora.broadcasts).toEqual([paid.rawTxHex, paid.rawTxHex])
    expect(esplora.known.has(paid.txid)).toBe(true)
  })

  it('abandons a transaction no node will take any more, and returns the inputs a fee bump must spend', async () => {
    // The node accepts the payment, later evicts it from its mempool, and then
    // refuses every resubmission because its mempool asks a higher fee.
    const { esplora, client, send, store, pending } = setUp({
      broadcastReplies: ['accept', ...Array<BroadcastReply>(1_000).fill('reject, fee too low')],
    })
    const { txid, rawTxHex } = await send()
    esplora.known.delete(txid)
    const unsettled = await caught(reconcileBroadcast(client, rawTxHex, reconcileOptions(200)))
    expect(QbitApiError.is(unsettled) && unsettled.kind).toBe('unknown_outcome')
    expect(codeOf(await caught(send()))).toBe('pending') // stuck until the wallet acts
    const sent = esplora.broadcasts.length

    const inputs = await abandonPendingPayment({
      client,
      address: from,
      store,
      txid,
      deadlineMs: 5_000,
      signal: new AbortController().signal,
    })

    expect(inputs).toEqual(UTXOS.slice(0, 2)) // the outputs the transaction spent, in its input order
    expect(pending.size).toBe(0)
    expect(esplora.broadcasts).toHaveLength(sent) // abandoning sends nothing
  })

  describe('refuses to abandon a transaction', () => {
    /** A store holding the first test's transaction as pending, and a backend that has never seen it. */
    function stuck(options: Omit<StubEsploraOptions, 'address'> = {}) {
      const { store, pending } = memoryStore()
      store.saveTransaction(paid.txid, paid.rawTxHex)
      const esplora = stubEsplora({ address: from, utxos: UTXOS, ...options })
      const client = new EsploraClient({ baseUrl: BASE_URL, fetchFn: esplora.fetchFn })
      const abandon = (overrides: Partial<Parameters<typeof abandonPendingPayment>[0]> = {}) =>
        abandonPendingPayment({
          client,
          address: from,
          store,
          txid: paid.txid,
          deadlineMs: 5_000,
          signal: new AbortController().signal,
          ...overrides,
        })
      return { esplora, pending, abandon }
    }
    const abandonCodeOf = (error: unknown) => error instanceof AbandonPaymentError && error.code

    it.each<[string, (esplora: ReturnType<typeof stubEsplora>) => void, AbandonPaymentErrorCode]>([
      ['the indexer has in its mempool', esplora => esplora.known.set(paid.txid, { confirmed: false }), 'known'],
      ['the indexer has in a block', esplora => esplora.known.set(paid.txid, { confirmed: true }), 'known'],
    ])('%s', async (_, arrange, code) => {
      const { esplora, pending, abandon } = stuck()
      arrange(esplora)

      const error = await caught(abandon())

      expect(abandonCodeOf(error)).toBe(code)
      expect(error instanceof AbandonPaymentError && error.txid).toBe(paid.txid)
      expect(pending.get(paid.txid)).toBe(paid.rawTxHex)
    })

    it('when one of its inputs is no longer unspent', async () => {
      // Another transaction spent the second input, in a block or in the mempool.
      const { pending, abandon } = stuck({ utxos: [UTXOS[0]!, UTXOS[2]!] })

      const error = await caught(abandon())

      expect(abandonCodeOf(error)).toBe('inputs_spent')
      expect(error instanceof Error && error.message).toContain(`${UTXOS[1]!.txid}:${UTXOS[1]!.vout}`)
      expect(pending.get(paid.txid)).toBe(paid.rawTxHex)
    })

    it('when the backend lists a UTXO row it cannot use', async () => {
      const { pending, abandon } = stuck({ utxos: [UTXOS[0]!, { ...UTXOS[1]!, value: -1 }] })

      const error = await caught(abandon())

      expect(abandonCodeOf(error)).toBe('invalid_utxos')
      expect(pending.get(paid.txid)).toBe(paid.rawTxHex)
    })

    it('when the backend answers the lookup with JSON that is not the transaction', async () => {
      for (const [name, body] of NOT_THE_TRANSACTION) {
        const { esplora, pending, abandon } = stuck({ lookupReply: () => body })

        const error = await caught(abandon())

        // Not proof that the indexer knows it, nor that it does not.
        expect(QbitApiError.is(error) && error.kind, name).toBe('parse')
        expect(count(esplora.requests, '/utxo'), name).toBe(0)
        expect(pending.get(paid.txid), name).toBe(paid.rawTxHex)
      }

      // The txid compares case-insensitively.
      const { pending, abandon } = stuck({ lookupReply: upperCaseReply })
      expect(abandonCodeOf(await caught(abandon()))).toBe('known')
      expect(pending.get(paid.txid)).toBe(paid.rawTxHex)
    })

    it('when a lookup cannot answer before the deadline', async () => {
      const { pending, abandon } = stuck({ stallReads: true })

      const error = await caught(abandon({ deadlineMs: 200 }))

      expect(QbitApiError.is(error) && error.kind).toBe('timeout')
      expect(pending.get(paid.txid)).toBe(paid.rawTxHex)
    })

    it.each<[string, Partial<Parameters<typeof abandonPendingPayment>[0]>, AbandonPaymentErrorCode]>([
      ['that is not the pending one', { txid: 'ab'.repeat(32) }, 'not_pending'],
      ['with a deadline longer than a timer can wait', { deadlineMs: 2_147_483_648 }, 'invalid_options'],
      ['with a zero deadline', { deadlineMs: 0 }, 'invalid_options'],
    ])('%s, before any request', async (_, overrides, code) => {
      const { esplora, pending, abandon } = stuck()

      const error = await caught(abandon(overrides))

      expect(abandonCodeOf(error)).toBe(code)
      expect(esplora.requests).toEqual([])
      expect(pending.get(paid.txid)).toBe(paid.rawTxHex)
    })
  })
})

import { getEventListeners } from 'node:events'
import { runInNewContext } from 'node:vm'

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
  replacePendingPayment,
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

// Lets a test run code while sendPayment's init() call loads the signer, or
// make init() throw before it returns a promise, and counts the init() calls.
const signerLoad = vi.hoisted(() => ({
  during: undefined as (() => Promise<void>) | undefined,
  throws: undefined as Error | undefined,
  starts: 0,
}))
vi.mock('@qbit-oss/pqc', async importOriginal => {
  const pqc = await importOriginal<typeof import('@qbit-oss/pqc')>()
  const load = async (...args: Parameters<typeof pqc.init>) => {
    await signerLoad.during?.()
    return pqc.init(...args)
  }
  return {
    ...pqc,
    init: (...args: Parameters<typeof pqc.init>) => {
      signerLoad.starts += 1
      if (signerLoad.throws !== undefined) throw signerLoad.throws
      return load(...args)
    },
  }
})

// Counts the calls to txidFromRawTx, which parses and hashes a whole transaction.
const txidHashes = vi.hoisted(() => ({ count: 0 }))
vi.mock('@qbit-oss/api', async importOriginal => {
  const api = await importOriginal<typeof import('@qbit-oss/api')>()
  return {
    ...api,
    txidFromRawTx: (rawTxHex: string) => {
      txidHashes.count += 1
      return api.txidFromRawTx(rawTxHex)
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

/**
 * A store in memory. It writes a transaction's txid and hex as one Map entry,
 * swaps the record for another in one synchronous step, only while its txid
 * is the one it is given, and drops only the record whose txid it is given,
 * as `PaymentStore` asks.
 */
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
    replaceTransaction: (oldTxid, { txid, rawTxHex }) => {
      const [entry] = pending
      if (entry?.[0] !== oldTxid) throw new Error(`test: transaction ${oldTxid} is not the pending one`)
      pending.delete(oldTxid)
      pending.set(txid, rawTxHex)
    },
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
/** A deposit the first test's transaction does not spend, which pays AMOUNT_SATS and its fee alone. */
const DEPOSIT = confirmed('d4'.repeat(32), 200_000)

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

/** A client that records when each lookup and broadcast starts, and the `deadlineMs` it gets. */
class BudgetsClient extends EsploraClient {
  readonly calls: { request: 'lookup' | 'broadcast'; at: number; deadlineMs: number }[] = []

  override getTx(...[txid, options]: Parameters<EsploraClient['getTx']>): ReturnType<EsploraClient['getTx']> {
    this.calls.push({ request: 'lookup', at: Date.now(), deadlineMs: options!.deadlineMs! })
    return super.getTx(txid, options)
  }

  override broadcastTx(...[rawTxHex, options]: Parameters<EsploraClient['broadcastTx']>): Promise<string> {
    this.calls.push({ request: 'broadcast', at: Date.now(), deadlineMs: options!.deadlineMs! })
    return super.broadcastTx(rawTxHex, options)
  }
}

/**
 * Checks the budget rule on `calls`, made before `end`: every request but the
 * last gets at least half of the time left, and leaves the next a poll
 * interval, or half of that time; the last gets all that is left.
 */
function expectBudgets(calls: BudgetsClient['calls'], end: number, pollMs: number, name: string): void {
  calls.forEach(({ request, at, deadlineMs }, index) => {
    const left = end - at
    const which = `${name}: ${request} ${index}, ${left} ms left`
    if (index === calls.length - 1) {
      expect(deadlineMs, which).toBe(left)
    } else {
      expect(deadlineMs, which).toBeGreaterThanOrEqual(left / 2)
      expect(left - deadlineMs, which).toBeGreaterThanOrEqual(Math.min(pollMs, left / 2))
    }
  })
}

/** A client class whose UTXO scan fails with `error`. */
const scanFailsWith = (error: unknown) =>
  class extends EsploraClient {
    override getAddressUtxos(): Promise<EsploraUtxo[]> {
      return Promise.reject(error)
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
/**
 * Run `test` on a fake clock: `Date.now()` and the timers stand still until
 * `settledWithin` moves them, so the rounds a deadline leaves room for, and
 * the requests they make, do not depend on how busy the machine is.
 */
async function onFakeClock(test: () => Promise<void>): Promise<void> {
  vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] })
  try {
    await test()
  } finally {
    vi.useRealTimers()
  }
}
/**
 * Move the fake clock `ms` ahead, and return `promise`'s error, or undefined
 * if it resolved. Fails unless it settled by then.
 */
async function settledWithin(promise: Promise<unknown>, ms: number): Promise<unknown> {
  let settled = false
  const outcome = caught(promise).finally(() => {
    settled = true
  })
  await vi.advanceTimersByTimeAsync(ms)
  expect(settled, `settled within ${ms} ms`).toBe(true)
  return outcome
}
const codeOf = (error: unknown) => error instanceof SendPaymentError && error.code
const abandonCodeOf = (error: unknown) => error instanceof AbandonPaymentError && error.code
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
type TxOutputs = { value: bigint; scriptPubKey: Uint8Array }[]
/** The unsigned PSBT spending the sender's outputs `spent` to `outputs`, as the example builds it. */
function unsignedPsbt(spent: EsploraUtxo[], outputs: TxOutputs) {
  const scriptPubKey = addressToScriptPubKey(from, 'regtest')
  const leafScript = singleKeyLeafScript(key.pk32)
  return createP2mrPsbt({
    inputs: spent.map(utxo => ({
      prevout: { txid: hexToBytes(utxo.txid).reverse(), vout: utxo.vout },
      witnessUtxo: { value: BigInt(utxo.value), scriptPubKey },
      leafScript,
      controlBlock: buildControlBlock(),
    })),
    outputs,
  })
}
/** The unsigned transaction spending `spent` to `outputs`, as the example builds it, as hex. */
function unsignedTxHex(spent: EsploraUtxo[], outputs: TxOutputs): string {
  return bytesToHex(unsignedPsbt(spent, outputs).global.find(entry => entry.key[0] === PSBT_GLOBAL_UNSIGNED_TX)!.value)
}
/** The txid of the unsigned transaction spending `spent` to `outputs`, as the example builds it. */
const unsignedTxid = (spent: EsploraUtxo[], outputs: TxOutputs) => txidFromRawTx(unsignedTxHex(spent, outputs))
/**
 * The signed transaction spending `spent` to `outputs`, as a wallet signs the
 * replacement of a stuck payment: as `sendPayment` signs, each signature
 * reserved and saved through `store`, with the replacement's txid.
 */
async function signedTx(spent: EsploraUtxo[], outputs: TxOutputs, store: PaymentStore): Promise<string> {
  const psbt = unsignedPsbt(spent, outputs)
  const txid = unsignedTxid(spent, outputs)
  const leafHash = p2mrLeafHash(P2MR_LEAF_VERSION_V1, singleKeyLeafScript(key.pk32))
  const pqc = await init()
  const signed = signP2mrPsbt({
    psbt,
    keys: spent.map((_, inputIndex) => ({ inputIndex, pubkey: key.pk32, leafHash })),
    sign: sighash => {
      store.reserveSignature(key.pk32)
      return pqc.sign(key.sk64, sighash)
    },
    onSigned: ({ field, ...plan }) => store.saveSignature({ txid, ...plan, key: field.key, value: field.value }),
  })
  return bytesToHex(extractP2mrTransaction(finalizeP2mrPsbt(signed.psbt)))
}
/** The first test's payment alone: the output of its fee bump, whose fee takes the change, 20,000 sats on 7,581 bytes. */
const bumpOutputs = (): TxOutputs => [{ value: AMOUNT_SATS, scriptPubKey: addressToScriptPubKey(to, 'regtest') }]
/** Its two inputs back to the sender, less 4 sat/vB on 7,581 bytes: a cancel, which pays no one. */
const cancelOutputs = (): TxOutputs => [
  { value: 130_000n - 4n * 7_581n, scriptPubKey: addressToScriptPubKey(from, 'regtest') },
]
/** Turns the record of transaction `tx` into one a corrupt store might return. */
type Damage = (tx: { txid: string; rawTxHex: string }) => { txid?: unknown; rawTxHex?: unknown }
/**
 * Pending records of a transaction a corrupt store might hold, with its hex
 * or its txid damaged: a cut-off transaction, text that is not hex, a whole
 * transaction that is another one, a txid one character off, and either field
 * missing or not a string.
 */
const CORRUPT_RECORDS: [string, Damage][] = [
  ['hex that is not a whole transaction', ({ txid, rawTxHex }) => ({ txid, rawTxHex: rawTxHex.slice(0, -2) })],
  ['hex that is not hex', ({ txid }) => ({ txid, rawTxHex: 'zz' })],
  [
    'hex that is another transaction',
    ({ txid }) => ({
      txid,
      rawTxHex: unsignedTxHex([UTXOS[0]!], [{ value: 50_000n, scriptPubKey: addressToScriptPubKey(to, 'regtest') }]),
    }),
  ],
  ['hex that is not a string', ({ txid }) => ({ txid, rawTxHex: 1 })],
  ['no hex', ({ txid }) => ({ txid })],
  [
    'a txid one character off',
    ({ txid, rawTxHex }) => ({ txid: `${txid.slice(0, -1)}${txid.endsWith('0') ? '1' : '0'}`, rawTxHex }),
  ],
  ['a txid that is not a string', ({ rawTxHex }) => ({ txid: 1, rawTxHex })],
  ['no txid', ({ rawTxHex }) => ({ rawTxHex })],
]
/**
 * An AbortController made in another realm, a vm context, as an iframe, jsdom
 * or a polyfill makes one: its signal is an EventTarget with `aborted` and
 * `reason`, the shape the client uses, but no `instanceof AbortSignal` here.
 */
function foreignAbortController(): { signal: AbortSignal; abort(reason: unknown): void } {
  return runInNewContext(
    `
    class AbortSignal extends EventTarget {
      aborted = false
      reason = undefined
    }
    const signal = new AbortSignal()
    const controller = {
      signal,
      abort(reason) {
        if (signal.aborted) return
        signal.aborted = true
        signal.reason = reason
        signal.dispatchEvent(new Event('abort'))
      },
    }
    controller
    `,
    { EventTarget, Event }
  ) as ReturnType<typeof foreignAbortController>
}

describe('send-payment example', () => {
  let paid: ReturnType<typeof setUp> & { txid: string; rawTxHex: string }

  /** A fee bump of the first test's transaction, signed: its two inputs, to `bumpOutputs()`. */
  let bump: string

  beforeAll(async () => {
    const setup = setUp()
    paid = { ...setup, ...(await setup.send()) }
    bump = await signedTx(UTXOS.slice(0, 2), bumpOutputs(), memoryStore().store)
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

    await onFakeClock(async () => {
      const error = await settledWithin(reconcileBroadcast(client, paid, reconcileOptions(200)), 200)

      expect(QbitApiError.is(error) && error.kind).toBe('unknown_outcome')
      expect(QbitApiError.is(error) && error.txid).toBe(paid.txid)
      expect(rejecting.broadcasts.length).toBeGreaterThan(1)
      expect(new Set(rejecting.broadcasts)).toEqual(new Set([paid.rawTxHex])) // only ever the same bytes
    })
  })

  it('keeps the outcome unknown when cancelled, and resumes from the stored hex', async () => {
    // The user cancels while the POST is in flight, and the request never reached the node.
    const controller = new AbortController()
    const { esplora, client, send, store, pending } = setUp(
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
    await reconcileBroadcast(client, store.pendingTransaction()!, reconcileOptions(5_000))
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
    // Its cause is the aborted error every other step rejects a cancel with.
    const cause = P2mrPsbtSigningError.is(error) ? error.cause : undefined
    expect(QbitApiError.is(cause) && cause.kind).toBe('aborted')
    expect(QbitApiError.is(cause) && cause.cause).toBe(controller.signal.reason)
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
    expect(QbitApiError.is(error) && error.kind).toBe('aborted')
    expect(QbitApiError.is(error) && error.cause).toBe(controller.signal.reason)
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

    // A store that returns the txid in uppercase still holds that transaction.
    pending.set(txid.toUpperCase(), pending.get(txid)!).delete(txid)
    expect(codeOf(await caught(send()))).toBe('pending')
  })

  it.each(CORRUPT_RECORDS)(
    'reports a pending record with %s as corrupt_pending from sendPayment, reconcileBroadcast, abandonPendingPayment and replacePendingPayment, before any request',
    async (_, corrupt) => {
      // `pending` would point the wallet at a record reconcileBroadcast cannot
      // settle, and `not_pending` or `invalid_options` at nothing pending.
      const record = corrupt(paid)
      const recordTxid = typeof record.txid === 'string' ? record.txid : undefined
      const { esplora, client, send, store, reservations, pending } = setUp()
      store.saveTransaction(record.txid as string, record.rawTxHex as string)

      const refused = await caught(send())

      expect(codeOf(refused)).toBe('corrupt_pending')
      expect(refused instanceof SendPaymentError && refused.txid).toBe(recordTxid)
      expect(refused instanceof Error && refused.message).toContain('never repair it in place')

      // The record as the store returns it.
      const unsettled = await caught(reconcileBroadcast(client, store.pendingTransaction()!, reconcileOptions(5_000)))

      expect(codeOf(unsettled)).toBe('corrupt_pending')
      expect(unsettled instanceof SendPaymentError && unsettled.txid).toBe(recordTxid)

      // Whatever txid the wallet gives it: the payment's, the record's, or another.
      for (const txid of new Set([paid.txid, recordTxid ?? paid.txid, 'ab'.repeat(32)])) {
        const kept = await caught(
          abandonPendingPayment({
            client,
            address: from,
            store,
            txid,
            deadlineMs: 5_000,
            signal: new AbortController().signal,
          })
        )

        expect(abandonCodeOf(kept), txid).toBe('corrupt_pending')
        expect(kept instanceof AbandonPaymentError && kept.txid, txid).toBe(txid)
        expect(kept instanceof Error && kept.message, txid).toContain('never repair it in place')

        // Nor is it swapped for a replacement, whatever the replacement spends.
        const unswapped = await caught(
          replacePendingPayment({
            client,
            store,
            txid,
            rawTxHex: bump,
            deadlineMs: 5_000,
            signal: new AbortController().signal,
          })
        )

        expect(abandonCodeOf(unswapped), txid).toBe('corrupt_pending')
        expect(unswapped instanceof AbandonPaymentError && unswapped.txid, txid).toBe(txid)
      }
      expect(esplora.requests).toEqual([])
      expect(reservations).toEqual([])
      expect([...pending]).toEqual([[record.txid, record.rawTxHex]])
    }
  )

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

      await onFakeClock(async () => {
        const error = await settledWithin(reconcileBroadcast(client, paid, reconcileOptions(400, 100)), 400)

        // Neither found nor not_found: it keeps polling, and only the last round resubmits.
        expect(error, name).toBeUndefined()
        expect(lookups(esplora.requests), name).toBeGreaterThan(1)
        expect(esplora.broadcasts, name).toEqual([paid.rawTxHex])
        expect(esplora.known.has(paid.txid), name).toBe(true)
      })
    }

    // The txid compares case-insensitively.
    const upper = stubEsplora({ address: from, lookupReply: upperCaseReply })
    const client = new EsploraClient({ baseUrl: BASE_URL, fetchFn: upper.fetchFn })
    await reconcileBroadcast(client, paid, reconcileOptions(5_000))
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

  it.each<[string, { endMs?: number; pollMs?: number; signal?: () => unknown }]>([
    ['a zero poll interval', { pollMs: 0 }],
    ['a NaN poll interval', { pollMs: Number.NaN }],
    ['a poll interval longer than a timer can wait', { pollMs: 2_147_483_648 }],
    ['a NaN end', { endMs: Number.NaN }],
    ['an infinite end', { endMs: Number.POSITIVE_INFINITY }],
    ['an end further away than a timer can wait', { endMs: 2_147_483_647 + 60_000 }],
    ['a signal that is not an AbortSignal', { signal: () => ({}) }],
    ['no signal', { signal: () => undefined }],
  ])(
    'refuses to reconcile with %s, before any request',
    async (_, { endMs = 5_000, pollMs = 1, signal = () => AbortSignal.timeout(1_000) }) => {
      const esplora = stubEsplora({ address: from })
      const client = new EsploraClient({ baseUrl: BASE_URL, fetchFn: esplora.fetchFn })
      // Unchecked, such a call would poll back to back, or never settle, until
      // the signal aborts, or fail only once it had started waiting.
      const options = { end: Date.now() + endMs, signal: signal() as AbortSignal, pollMs }

      const error = await caught(reconcileBroadcast(client, paid, options))

      expect(codeOf(error)).toBe('invalid_options')
      expect(esplora.requests).toEqual([])
    }
  )

  it.each<[string, () => unknown]>([
    // reconcileBroadcast(client, rawTxHex, options), as an earlier version of this example took it.
    ['the hex alone', () => paid.rawTxHex],
    ['nothing', () => undefined],
    ['null', () => null],
  ])(
    'refuses %s in place of the pending record object as invalid_options, not corrupt_pending, before any request',
    async (_, record) => {
      const esplora = stubEsplora({ address: from })
      const client = new EsploraClient({ baseUrl: BASE_URL, fetchFn: esplora.fetchFn })

      const error = await caught(
        reconcileBroadcast(client, record() as { txid: string; rawTxHex: string }, reconcileOptions(5_000))
      )

      expect(codeOf(error)).toBe('invalid_options')
      expect(error instanceof Error && error.message).toContain('must be an object { txid, rawTxHex }')
      expect(esplora.requests).toEqual([])
    }
  )

  it("parses and hashes the record's hex once", async () => {
    const esplora = stubEsplora({ address: from })
    const client = new EsploraClient({ baseUrl: BASE_URL, fetchFn: esplora.fetchFn })
    esplora.known.set(paid.txid, { confirmed: false })
    txidHashes.count = 0

    await reconcileBroadcast(client, paid, reconcileOptions(5_000))

    // The stub hashes nothing to answer a lookup, so every hash is the example's.
    expect(lookups(esplora.requests)).toBe(1)
    expect(txidHashes.count).toBe(1)
  })

  it("never resubmits an older payment's hex stored under another payment's txid, which would pay it again", async () => {
    // The store holds `{ txid: A, rawTxHex: B }`, where B is an earlier signed
    // payment that is still valid. The wallet follows the PaymentStore doc and
    // passes the record to reconcileBroadcast.
    const otherTxid = unsignedTxid(
      [UTXOS[0]!],
      [{ value: 50_000n, scriptPubKey: addressToScriptPubKey(to, 'regtest') }]
    )
    const { store } = memoryStore()
    store.saveTransaction(otherTxid, paid.rawTxHex)
    const esplora = stubEsplora({ address: from })
    const client = new EsploraClient({ baseUrl: BASE_URL, fetchFn: esplora.fetchFn })

    const error = await caught(reconcileBroadcast(client, store.pendingTransaction()!, reconcileOptions(5_000)))

    expect(codeOf(error)).toBe('corrupt_pending')
    expect(error instanceof SendPaymentError && error.txid).toBe(otherTxid)
    expect(esplora.requests).toEqual([])
    expect(esplora.broadcasts).toEqual([])

    // The txid compares case-insensitively: a record that names B's txid in uppercase is B.
    esplora.known.set(paid.txid, { confirmed: false })
    await reconcileBroadcast(
      client,
      { txid: paid.txid.toUpperCase(), rawTxHex: paid.rawTxHex },
      reconcileOptions(5_000)
    )
    expect(lookups(esplora.requests)).toBe(1)
    expect(esplora.broadcasts).toEqual([])
  })

  it('checks its options, then the record, and only then whether end has passed, all before any request', async () => {
    const esplora = stubEsplora({ address: from })
    const client = new EsploraClient({ baseUrl: BASE_URL, fetchFn: esplora.fetchFn })
    const corrupt = { txid: paid.txid, rawTxHex: paid.rawTxHex.slice(0, -2) }
    const passed = { end: Date.now() - 1, signal: new AbortController().signal, pollMs: 1 }

    // A corrupt record is reported even once `end` has passed, and an invalid option before it.
    expect(codeOf(await caught(reconcileBroadcast(client, corrupt, passed)))).toBe('corrupt_pending')
    expect(codeOf(await caught(reconcileBroadcast(client, corrupt, { ...passed, pollMs: 0 })))).toBe('invalid_options')
    // A whole record with an `end` that has passed is an unknown outcome.
    const error = await caught(reconcileBroadcast(client, paid, passed))
    expect(QbitApiError.is(error) && error.kind).toBe('unknown_outcome')
    expect(esplora.requests).toEqual([])
  })

  it('stops a stalled reconciliation at the deadline with the outcome still unknown', async () => {
    // Neither the indexer nor the node ever answers.
    const stalled = stubEsplora({ address: from, stallReads: true, broadcastReplies: ['stall'] })
    const client = new EsploraClient({ baseUrl: BASE_URL, fetchFn: stalled.fetchFn })

    await onFakeClock(async () => {
      const error = await settledWithin(reconcileBroadcast(client, paid, reconcileOptions(1_000, 200)), 1_000)

      expect(QbitApiError.is(error) && error.kind).toBe('unknown_outcome')
      // The first lookup stops 200 ms before the end, which makes its round
      // the last: it resubmits once, stalling too, and stops.
      expect(lookups(stalled.requests)).toBe(1)
      expect(stalled.broadcasts).toEqual([paid.rawTxHex])
    })
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
    // Unchecked, either would fail only once the signer load and the scan had started.
    ['a signal that is not an AbortSignal', { signal: {} as AbortSignal }, 'invalid_options'],
    ['no signal', { signal: undefined as unknown as AbortSignal }, 'invalid_options'],
  ])('refuses %s before any request or signature', async (_, params, code) => {
    const { esplora, send, reservations, pending } = setUp()

    const error = await caught(send(20_000, params))

    expect(codeOf(error)).toBe(code)
    expect(esplora.requests).toEqual([])
    expect(reservations).toEqual([])
    expect(pending.size).toBe(0)
  })

  it('leaves no timer and no listener behind when the payment fails while the signer loads, nor does reconcileBroadcast', async () => {
    // The scan fails at once, for an address with more outputs than the
    // backend lists, while the signer never loads.
    signerLoad.during = () => new Promise<void>(() => {})
    try {
      await onFakeClock(async () => {
        const controller = new AbortController()
        const utxos = Array.from({ length: 501 }, (_, index) => confirmed(index.toString(16).padStart(64, '0'), 10_000))
        const { send } = setUp({ utxos }, controller)

        const error = await settledWithin(send(), 0)

        expect(codeOf(error)).toBe('too_many_utxos')
        expect(vi.getTimerCount()).toBe(0)
        expect(getEventListeners(controller.signal, 'abort')).toEqual([])

        // A reconciliation that ends at its deadline, with the indexer and the node stalled.
        const stalled = stubEsplora({ address: from, stallReads: true, broadcastReplies: ['stall'] })
        const client = new EsploraClient({ baseUrl: BASE_URL, fetchFn: stalled.fetchFn })
        const options = { ...reconcileOptions(1_000, 200), signal: controller.signal }

        const unsettled = await settledWithin(reconcileBroadcast(client, paid, options), 1_000)

        expect(QbitApiError.is(unsettled) && unsettled.kind).toBe('unknown_outcome')
        expect(vi.getTimerCount()).toBe(0)
        expect(getEventListeners(controller.signal, 'abort')).toEqual([])
      })
    } finally {
      signerLoad.during = undefined
    }
  })

  it('takes a signal from another realm or a polyfill, as the client does, and refuses an object that only looks like one', async () => {
    const foreign = foreignAbortController()
    expect(foreign.signal instanceof AbortSignal).toBe(false)
    const { esplora, client, send } = setUp()

    const { txid, rawTxHex } = await send(20_000, { signal: foreign.signal })
    await reconcileBroadcast(client, { txid, rawTxHex }, { ...reconcileOptions(5_000), signal: foreign.signal })

    expect(esplora.broadcasts).toEqual([rawTxHex])
    expect(lookups(esplora.requests)).toBe(1)

    // Its abort cancels a payment as a native signal's does.
    const cancelled = setUp()
    const reason = new Error('test: cancelled')
    foreign.abort(reason)

    const error = await caught(cancelled.send(20_000, { signal: foreign.signal }))

    expect(QbitApiError.is(error) && error.kind).toBe('aborted')
    expect(QbitApiError.is(error) && error.cause).toBe(reason)
    expect(cancelled.esplora.requests).toEqual([])

    for (const [name, notASignal] of [
      ['aborted alone', { aborted: false }],
      ['no removeEventListener', { aborted: false, addEventListener: () => {} }],
      ['an aborted that is not a boolean', { aborted: 0, addEventListener: () => {}, removeEventListener: () => {} }],
    ] as const) {
      const refused = setUp()
      const signal = notASignal as unknown as AbortSignal

      expect(codeOf(await caught(refused.send(20_000, { signal }))), name).toBe('invalid_options')
      const options = { ...reconcileOptions(5_000), signal }
      expect(codeOf(await caught(reconcileBroadcast(refused.client, paid, options))), name).toBe('invalid_options')
      expect(refused.esplora.requests, name).toEqual([])
    }
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

    await onFakeClock(async () => {
      const error = await settledWithin(reconcileBroadcast(client, paid, reconcileOptions(300, 2_000)), 300)

      expect(error).toBeUndefined()
      expect(lookups(esplora.requests)).toBe(1)
      expect(esplora.broadcasts).toEqual([paid.rawTxHex])
      expect(esplora.known.has(paid.txid)).toBe(true)
    })
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
      const error = await caught(reconcileBroadcast(client, paid, options))
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

    await onFakeClock(async () => {
      const error = await settledWithin(reconcileBroadcast(client, paid, reconcileOptions(1_000, 1_000)), 1_000)

      expect(QbitApiError.is(error) && error.kind).toBe('unknown_outcome')
      expect(failing.requests).toEqual([`GET /tx/${paid.txid}`, 'POST /tx'])
    })
  })

  it("resubmits at most once in the last two polls, even when an earlier round's third miss arrives in them", async () => {
    // Every lookup takes 600 ms to miss, and every resubmission is refused.
    // With 6,500 ms and 1 s polls, the third round's wait ends with 2,300 ms
    // left, and its lookup misses for the third time with 1,700 ms left.
    const resubmittedAt: number[] = []
    const slow = stubEsplora({
      address: from,
      lookupDelayMs: 600,
      broadcastReplies: Array<BroadcastReply>(1_000).fill('reject'),
      onBroadcast: () => void resubmittedAt.push(Date.now()),
    })
    const client = new EsploraClient({ baseUrl: BASE_URL, fetchFn: slow.fetchFn })

    await onFakeClock(async () => {
      const options = reconcileOptions(6_500, 1_000)

      const error = await settledWithin(reconcileBroadcast(client, paid, options), 6_500)

      // That round is the last: it resubmits once, with all that is left, and
      // stops, rather than leave a later round to resubmit again.
      expect(QbitApiError.is(error) && error.kind).toBe('unknown_outcome')
      expect(lookups(slow.requests)).toBe(3)
      expect(resubmittedAt.map(at => options.end - at)).toEqual([1_700])
    })
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

    await onFakeClock(async () => {
      const error = await settledWithin(send(300), 300)

      expect(QbitApiError.is(error) && error.kind).toBe('timeout')
      expect(lookups(esplora.requests)).toBe(1)
      expect(reservations).toEqual([])
      expect(pending.size).toBe(0)
      expect(esplora.broadcasts).toEqual([])
    })
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
        reconcileBroadcast(client, paid, { end, signal: new AbortController().signal, pollMs: 1 })
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

    await onFakeClock(async () => {
      const error = await settledWithin(reconcileBroadcast(client, paid, reconcileOptions(1_000, 1_000)), 1_000)

      expect(error).toBeUndefined()
      expect(lookups(stalled.requests)).toBe(1)
      expect(stalled.broadcasts).toEqual([paid.rawTxHex])
      expect(stalled.known.has(paid.txid)).toBe(true)
    })
  })

  it('leaves time to resubmit when a lookup with two or more polls left stalls', async () => {
    // The first POST never reached the node, and the indexer never answers.
    // 1,500 ms are left, so after one 400 ms poll at least two are still
    // left, and the lookup gets all but one.
    let resubmittedAt: number | undefined
    const stalled = stubEsplora({
      address: from,
      stallReads: true,
      onBroadcast: () => {
        resubmittedAt = Date.now()
      },
    })
    const client = new EsploraClient({ baseUrl: BASE_URL, fetchFn: stalled.fetchFn })

    await onFakeClock(async () => {
      const options = reconcileOptions(1_500, 400)

      const error = await settledWithin(reconcileBroadcast(client, paid, options), 1_500)

      // The lookup stops 400 ms before the end, which makes its round the
      // last: it resubmits the same hex once, with those 400 ms.
      expect(error).toBeUndefined()
      expect(lookups(stalled.requests)).toBe(1)
      expect(stalled.broadcasts).toEqual([paid.rawTxHex])
      expect(resubmittedAt).toBeLessThan(options.end)
      expect(stalled.known.has(paid.txid)).toBe(true)
    })
  })

  it('leaves the last round time to resubmit when a resubmission in an earlier round stalls', async () => {
    // The first POST never reached the node. Three lookups miss, the
    // resubmission that follows never gets a reply, and the next is accepted.
    const esplora = stubEsplora({ address: from, broadcastReplies: ['stall'] })
    const client = new EsploraClient({ baseUrl: BASE_URL, fetchFn: esplora.fetchFn })

    await onFakeClock(async () => {
      const error = await settledWithin(reconcileBroadcast(client, paid, reconcileOptions(1_500, 200)), 1_500)

      // The stalled resubmission stops 200 ms before the end, and the last
      // round looks the transaction up once more, then resubmits it again.
      expect(error).toBeUndefined()
      expect(lookups(esplora.requests)).toBe(4)
      expect(esplora.broadcasts).toEqual([paid.rawTxHex, paid.rawTxHex])
      expect(esplora.known.has(paid.txid)).toBe(true)
    })
  })

  it('leaves reconciliation time to resubmit when the first POST stalls', async () => {
    // The first POST never reaches the node and gets no reply, and the next is accepted.
    const postedAt: number[] = []
    const { esplora, send, pending } = setUp({
      broadcastReplies: ['stall'],
      onBroadcast: () => void postedAt.push(Date.now()),
    })

    await onFakeClock(async () => {
      // Less than the client's own 15 s timeout, so only the deadline stops
      // the POST. The clock stands still while the payment scans and signs.
      const end = Date.now() + 10_000

      const error = await settledWithin(send(10_000, { pollMs: 2_000 }), 10_000)

      // The first POST stops 2 s before the end, and reconciliation's last
      // round looks the transaction up, then resubmits the same hex in time.
      expect(error).toBeUndefined()
      const [[txid, rawTxHex]] = [...pending] as [[string, string]]
      expect(esplora.broadcasts).toEqual([rawTxHex, rawTxHex])
      expect(lookups(esplora.requests)).toBe(1)
      expect(postedAt[1]).toBeLessThan(end)
      expect(esplora.known.has(txid)).toBe(true)
    })
  })

  it('gives the first POST at least half of the time left, and reconciliation its last round, across one and two poll intervals', async () => {
    // Just below and above one and two 2 s poll intervals left once signed.
    // The clock stands still while the payment scans and signs.
    for (const left of [1_999, 2_001, 3_999, 4_001]) {
      // The first POST never reaches the node and gets no reply, and the next is accepted.
      const { esplora, client, send, pending } = setUp(
        { broadcastReplies: ['stall'] },
        undefined,
        undefined,
        BudgetsClient
      )
      const { calls } = client as BudgetsClient

      await onFakeClock(async () => {
        const end = Date.now() + left

        const error = await settledWithin(send(left, { pollMs: 2_000 }), left)

        // The stalled POST stops while reconciliation's last round can still
        // look the transaction up, then resubmit the same hex in time.
        expect(error, `${left} ms left`).toBeUndefined()
        expect(calls[0], `${left} ms left`).toMatchObject({ request: 'broadcast', at: end - left })
        expectBudgets(calls, end, 2_000, `${left} ms left`)
        const [[txid, rawTxHex]] = [...pending] as [[string, string]]
        expect(esplora.broadcasts, `${left} ms left`).toEqual([rawTxHex, rawTxHex])
        expect(lookups(esplora.requests), `${left} ms left`).toBe(1)
        expect(esplora.known.has(txid), `${left} ms left`).toBe(true)
      })
    }
  })

  it("gives each of reconcileBroadcast's requests the first POST's budget, when a round starts with just below or above two polls left", async () => {
    // The indexer never answers. A round that starts with 2,001 ms left, two
    // 1 s polls, waits a poll, and with 1,001 ms then left, less than two, its
    // lookup gets half of them, not a sliver, and the round is the last: its
    // resubmission gets the rest, about what they get when the round starts
    // with 1,999 ms.
    for (const left of [1_999, 2_001]) {
      const stalled = stubEsplora({ address: from, stallReads: true })
      const client = new BudgetsClient({ baseUrl: BASE_URL, fetchFn: stalled.fetchFn })

      await onFakeClock(async () => {
        const options = reconcileOptions(left, 1_000)

        const error = await settledWithin(reconcileBroadcast(client, paid, options), left)

        expect(error, `${left} ms left`).toBeUndefined()
        expect(
          client.calls.map(call => call.request),
          `${left} ms left`
        ).toEqual(['lookup', 'broadcast'])
        expectBudgets(client.calls, options.end, 1_000, `${left} ms left`)
        expect(client.calls[1]!.deadlineMs, `${left} ms left`).toBeGreaterThanOrEqual(left / 4)
        expect(stalled.broadcasts, `${left} ms left`).toEqual([paid.rawTxHex])
      })
    }
  })

  it('decides the last round from one reading, and times its resubmission from end right before it is sent', async () => {
    // The first POST never reached the node. Once the lookup is over, the
    // clock reads `decidedAt` ms before `end`, which makes the round the
    // last, then `sentAt` ms before `end`, as after a stall before the
    // resubmission is sent.
    for (const [decidedAt, sentAt] of [
      [500, 100],
      [500, 0],
      [0, 0],
    ] as const) {
      const esplora = stubEsplora({ address: from })
      await onFakeClock(async () => {
        const options = reconcileOptions(1_000, 1_000)
        let clock: { mockRestore(): void } | undefined
        class StallsAfterLookupClient extends BudgetsClient {
          override async getTx(...args: Parameters<EsploraClient['getTx']>): ReturnType<EsploraClient['getTx']> {
            try {
              return await super.getTx(...args)
            } finally {
              clock = vi
                .spyOn(Date, 'now')
                .mockReturnValueOnce(options.end - decidedAt)
                .mockReturnValue(options.end - sentAt)
            }
          }
        }
        const client = new StallsAfterLookupClient({ baseUrl: BASE_URL, fetchFn: esplora.fetchFn })
        try {
          const error = await settledWithin(reconcileBroadcast(client, paid, options), 1_000)

          // The lookup misses with less than two polls left, so its round is
          // the last: it resubmits with what is left when it sends, never
          // with what was left when it decided, and with nothing left, it
          // sends nothing.
          const name = `decided ${decidedAt} ms before end, sent ${sentAt} ms before`
          const budgets = client.calls.map(({ request, deadlineMs }) => [request, deadlineMs])
          if (sentAt > 0) {
            expect(error, name).toBeUndefined()
            expect(budgets, name).toEqual([
              ['lookup', 250],
              ['broadcast', sentAt],
            ])
            expect(esplora.broadcasts, name).toEqual([paid.rawTxHex])
          } else {
            expect(QbitApiError.is(error) && error.kind, name).toBe('unknown_outcome')
            expect(budgets, name).toEqual([['lookup', 250]])
            expect(esplora.broadcasts, name).toEqual([])
          }
        } finally {
          clock?.mockRestore()
        }
      })
    }
  })

  it('times the signer load, the scan and the tip height from one reading of the clock, and handles every request it starts', async () => {
    // The signer never loads, and neither request is ever answered, so each
    // fails only at its own deadline. The clock reads `start` when the payment
    // sets its deadline and when it times the three, and the deadline from
    // then on. Read again for the signer, the wait would reject at once, with
    // the load and both requests started.
    signerLoad.during = () => new Promise<void>(() => {})
    const unhandled: unknown[] = []
    const onUnhandled = (reason: unknown) => void unhandled.push(reason)
    process.on('unhandledRejection', onUnhandled)
    try {
      await onFakeClock(async () => {
        const { esplora, send, reservations, pending } = setUp({ stallReads: true })
        const start = Date.now()
        const clock = vi
          .spyOn(Date, 'now')
          .mockReturnValueOnce(start)
          .mockReturnValueOnce(start)
          .mockReturnValue(start + 50)
        try {
          let outcome: unknown = 'unsettled'
          void caught(send(50)).then(error => {
            outcome = error
          })

          await vi.advanceTimersByTimeAsync(49)
          expect(outcome).toBe('unsettled')
          await vi.advanceTimersByTimeAsync(1)
          // Node reports any rejection nothing handles once the event loop turns.
          await new Promise(resolve => setImmediate(resolve))

          expect(QbitApiError.is(outcome) && outcome.kind).toBe('timeout')
          expect(unhandled).toEqual([])
          expect(count(esplora.requests, '/utxo')).toBe(1)
          expect(reservations).toEqual([])
          expect(pending.size).toBe(0)
        } finally {
          clock.mockRestore()
        }
      })
    } finally {
      signerLoad.during = undefined
      process.off('unhandledRejection', onUnhandled)
    }
  })

  it('starts no signer load and sends no request when the signal has already aborted, and nor does reconcileBroadcast', async () => {
    const controller = new AbortController()
    controller.abort(new Error('test: cancelled before the call'))
    const { esplora, client, send, reservations, pending } = setUp({}, controller)
    signerLoad.starts = 0

    const error = await caught(send())

    expect(QbitApiError.is(error) && error.kind).toBe('aborted')
    expect(QbitApiError.is(error) && error.cause).toBe(controller.signal.reason)
    expect(signerLoad.starts).toBe(0)
    expect(esplora.requests).toEqual([])
    expect(reservations).toEqual([])
    expect(pending.size).toBe(0)

    // The outcome stays unknown.
    const unsettled = await caught(
      reconcileBroadcast(client, paid, { ...reconcileOptions(5_000), signal: controller.signal })
    )

    expect(QbitApiError.is(unsettled) && unsettled.kind).toBe('unknown_outcome')
    expect(esplora.requests).toEqual([])
  })

  it('handles every request it starts when init() throws before it returns a promise', async () => {
    // A signer whose init() throws at once, as a wrapper might when it finds
    // no WebAssembly. Neither request is ever answered, so each fails only at
    // its own deadline, after sendPayment has rejected.
    const { esplora, send, reservations, pending } = setUp({ stallReads: true })
    const unhandled: unknown[] = []
    const onUnhandled = (reason: unknown) => void unhandled.push(reason)
    process.on('unhandledRejection', onUnhandled)
    const thrown = new Error('test: no WebAssembly')
    signerLoad.throws = thrown
    try {
      await onFakeClock(async () => {
        const error = await settledWithin(send(50), 0)
        // Both requests fail at their 50 ms deadline; then Node reports any
        // rejection nothing handles once the event loop turns.
        await vi.advanceTimersByTimeAsync(50)
        await new Promise(resolve => setImmediate(resolve))

        expect(error).toBe(thrown)
        expect(unhandled).toEqual([])
        expect(count(esplora.requests, '/utxo')).toBe(1)
        expect(count(esplora.requests, '/blocks/tip/height')).toBe(1)
        expect(reservations).toEqual([])
        expect(pending.size).toBe(0)
        expect(esplora.broadcasts).toEqual([])
      })
    } finally {
      signerLoad.throws = undefined
      process.off('unhandledRejection', onUnhandled)
    }
  })

  it('starts no signer load and leaves no timer behind when it cannot listen for a cancel', async () => {
    // An AbortSignal whose addEventListener throws. Had the payment started
    // loading the signer first, the failed load would go unhandled, and the
    // wait's timer would stay armed until the deadline.
    const controller = new AbortController()
    const thrown = new Error('test: no listener')
    Object.defineProperty(controller.signal, 'addEventListener', {
      value: () => {
        throw thrown
      },
    })
    const { esplora, send, reservations, pending } = setUp({}, controller)
    const unhandled: unknown[] = []
    const onUnhandled = (reason: unknown) => void unhandled.push(reason)
    process.on('unhandledRejection', onUnhandled)
    signerLoad.during = () => Promise.reject(new Error('test: the signer failed to load'))
    try {
      await onFakeClock(async () => {
        const error = await settledWithin(send(20_000), 0)
        // Node reports any rejection nothing handles once the event loop turns.
        await new Promise(resolve => setImmediate(resolve))

        expect(error).toBe(thrown)
        expect(unhandled).toEqual([])
        expect(vi.getTimerCount()).toBe(0)
        expect(esplora.requests).toEqual([]) // the client could not listen either
        expect(reservations).toEqual([])
        expect(pending.size).toBe(0)
      })
    } finally {
      signerLoad.during = undefined
      process.off('unhandledRejection', onUnhandled)
    }
  })

  it('stops waiting for a signer that never loads at the deadline, before any key is used', async () => {
    signerLoad.during = () => new Promise<void>(() => {})
    try {
      await onFakeClock(async () => {
        const { esplora, send, reservations, pending } = setUp()

        const error = await settledWithin(send(300), 300)

        expect(QbitApiError.is(error) && error.kind).toBe('timeout')
        expect(count(esplora.requests, '/utxo')).toBe(1) // the scan ran meanwhile
        expect(reservations).toEqual([])
        expect(pending.size).toBe(0)
      })
    } finally {
      signerLoad.during = undefined
    }
  })

  it('rejects a cancel while the signer loads with the aborted error a cancel during the scan gets', async () => {
    // Cancelled 100 ms in: once while the signer is still loading, with the
    // scan and the tip height back, and once while the scan is in flight,
    // with the signer loaded.
    for (const [name, loading, stallReads] of [
      ['while the signer loads', true, false],
      ['during the scan', false, true],
    ] as const) {
      signerLoad.during = loading ? () => new Promise<void>(() => {}) : undefined
      try {
        await onFakeClock(async () => {
          const controller = new AbortController()
          const { send, reservations, pending } = setUp({ stallReads }, controller)
          setTimeout(() => controller.abort(), 100)

          const error = await settledWithin(send(20_000), 100)

          expect(QbitApiError.is(error) && error.kind, name).toBe('aborted')
          expect(QbitApiError.is(error) && error.cause, name).toBe(controller.signal.reason)
          expect(reservations, name).toEqual([])
          expect(pending.size, name).toBe(0)
        })
      } finally {
        signerLoad.during = undefined
      }
    }
  })

  it('explains a backend that refuses to list more unspent outputs than its limit, before any key is used', async () => {
    // A regtest wallet that mined to its own address holds a coinbase output
    // for each block, more than the 500 qbit-electrs lists by default.
    const utxos = Array.from({ length: 501 }, (_, index) => confirmed(index.toString(16).padStart(64, '0'), 10_000))
    const { esplora, send, reservations, pending } = setUp({ utxos })

    const error = await caught(send())

    expect(codeOf(error)).toBe('too_many_utxos')
    expect(error instanceof Error && error.message).toContain('Too many unspent transaction outputs (>500)')
    expect(reservations).toEqual([])
    expect(pending.size).toBe(0)
    expect(esplora.broadcasts).toEqual([])
  })

  it.each<[string, QbitApiError]>([
    [
      'another 400',
      new QbitApiError('http', 'test: refused', { status: 400, responseBody: 'Invalid Bitcoin address' }),
    ],
    [
      "the limit's text with another status",
      new QbitApiError('http', 'test: refused', {
        status: 500,
        responseBody: 'Too many unspent transaction outputs (>500). Contact support to raise limits.',
      }),
    ],
  ])("passes the client's error through when the UTXO scan fails with %s", async (_, refusal) => {
    const { send, reservations } = setUp({}, undefined, undefined, scanFailsWith(refusal))

    const error = await caught(send())

    expect(error).toBe(refusal)
    expect(reservations).toEqual([])
  })

  /**
   * A store holding the first test's transaction as pending, with `rawTxHex`
   * as its hex, and a backend that has never seen it: a payment no node will
   * take any more. `send` pays with that store, through a client of its own,
   * so that hooks in `Client` see only the abandon and replace sequence.
   */
  function stuck(options: Omit<StubEsploraOptions, 'address'> = {}, rawTxHex = paid.rawTxHex, Client = EsploraClient) {
    const { store, pending } = memoryStore()
    store.saveTransaction(paid.txid, rawTxHex)
    const esplora = stubEsplora({ address: from, utxos: UTXOS, ...options })
    const client = new Client({ baseUrl: BASE_URL, fetchFn: esplora.fetchFn })
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
    const replace = (overrides: Partial<Parameters<typeof replacePendingPayment>[0]> = {}) =>
      replacePendingPayment({
        client,
        store,
        txid: paid.txid,
        rawTxHex: bump,
        deadlineMs: 5_000,
        signal: new AbortController().signal,
        pollMs: 1,
        ...overrides,
      })
    const sendClient = new EsploraClient({ baseUrl: BASE_URL, fetchFn: esplora.fetchFn })
    const send = () =>
      sendPayment({
        client: sendClient,
        key,
        to,
        amountSats: AMOUNT_SATS,
        feeRate: FEE_RATE,
        store,
        deadlineMs: 20_000,
        signal: new AbortController().signal,
        pollMs: 1,
      })
    return { esplora, client, store, pending, abandon, replace, send }
  }

  it('proves a transaction no node will take any more stuck, keeps it pending, and swaps it for a fee bump of its inputs', async () => {
    // The node accepts the payment, later evicts it from its mempool, and then
    // refuses every resubmission because its mempool asks a higher fee.
    const evicted = new Set<string>()
    const pendingAtEachPost: (string | undefined)[] = []
    const { esplora, client, send, store, pending } = setUp({
      replyFor: rawTxHex => (evicted.has(rawTxHex) ? 'reject, fee too low' : undefined),
      onBroadcast: () => void pendingAtEachPost.push(store.pendingTransaction()?.txid),
    })
    const { txid, rawTxHex } = await send()
    esplora.known.delete(txid)
    evicted.add(rawTxHex)
    const unsettled = await caught(reconcileBroadcast(client, { txid, rawTxHex }, reconcileOptions(200)))
    expect(QbitApiError.is(unsettled) && unsettled.kind).toBe('unknown_outcome')
    expect(codeOf(await caught(send()))).toBe('pending') // stuck until the wallet acts
    const sent = esplora.broadcasts.length

    const proof = await abandonPendingPayment({
      client,
      address: from,
      store,
      txid,
      deadlineMs: 5_000,
      signal: new AbortController().signal,
    })

    // The outputs the transaction spends, in its input order, and its record,
    // which stays pending: no payment from other outputs can start.
    expect(proof).toEqual({ pending: { txid, rawTxHex }, inputs: UTXOS.slice(0, 2) })
    expect([...pending]).toEqual([[txid, rawTxHex]])
    expect(esplora.broadcasts).toHaveLength(sent) // proving sends nothing
    expect(codeOf(await caught(send()))).toBe('pending')

    // The wallet signs a fee bump of exactly those outputs, and swaps it in.
    const replaced = await replacePendingPayment({
      client,
      store,
      txid,
      rawTxHex: bump,
      deadlineMs: 5_000,
      signal: new AbortController().signal,
      pollMs: 1,
    })

    expect(replaced).toEqual({ txid: txidFromRawTx(bump), rawTxHex: bump })
    expect([...pending]).toEqual([[replaced.txid, bump]])
    expect(esplora.broadcasts.slice(sent)).toEqual([bump])
    expect(pendingAtEachPost.slice(sent)).toEqual([replaced.txid]) // sent only once it was pending
    expect(esplora.known.has(replaced.txid)).toBe(true)
  })

  it('refuses a payment from other outputs while a stuck one is replaced, which could otherwise pay twice', async () => {
    // With nothing pending, as the store was once the stuck transaction was
    // released and before its replacement was saved, the next payment spends
    // the deposit alone: nothing it spends conflicts with the stuck
    // transaction, so both could confirm.
    const { tx } = await plannedTransaction({ utxos: [...UTXOS, DEPOSIT] })
    expect(outpointsOf(tx)).toEqual([`${DEPOSIT.txid}:0`])

    // The stuck transaction stays pending until its replacement takes its
    // place, so the same payment, started once the proof resolves or after a
    // crash there, is refused before it scans.
    const { esplora, pending, abandon, replace, send } = stuck({ utxos: [...UTXOS, DEPOSIT] })
    await abandon()
    const refused = await caught(send())

    expect(codeOf(refused)).toBe('pending')
    expect(refused instanceof SendPaymentError && refused.txid).toBe(paid.txid)

    const { txid } = await replace()
    const stillRefused = await caught(send())

    expect(codeOf(stillRefused)).toBe('pending')
    expect(stillRefused instanceof SendPaymentError && stillRefused.txid).toBe(txid)
    expect(count(esplora.requests, '/utxo')).toBe(1) // abandonPendingPayment's
    expect(esplora.broadcasts).toEqual([bump]) // only the replacement, which conflicts with the stuck transaction
    expect([...pending]).toEqual([[txid, bump]])
  })

  it('refuses a concurrent sendPayment at every step from the proof to the replacement, which is pending from the swap on', async () => {
    // Each step starts a payment the deposit could pay for alone.
    const attempts: { step: string; outcome: Promise<unknown> }[] = []
    let attempt = (step: string) => void step
    class AttemptingClient extends EsploraClient {
      override getTx(...args: Parameters<EsploraClient['getTx']>): ReturnType<EsploraClient['getTx']> {
        attempt('while the indexer is asked for the stuck transaction')
        return super.getTx(...args)
      }

      override getAddressUtxos(...args: Parameters<EsploraClient['getAddressUtxos']>): Promise<EsploraUtxo[]> {
        attempt("while the address's unspent outputs are listed")
        return super.getAddressUtxos(...args)
      }

      override broadcastTx(...args: Parameters<EsploraClient['broadcastTx']>): Promise<string> {
        attempt('while the replacement is sent')
        return super.broadcastTx(...args)
      }
    }
    const { esplora, store, pending, abandon, replace, send } = stuck(
      { utxos: [...UTXOS, DEPOSIT] },
      paid.rawTxHex,
      AttemptingClient
    )
    attempt = step => void attempts.push({ step, outcome: caught(send()) })
    const swap = store.replaceTransaction
    store.replaceTransaction = (oldTxid, record) => {
      attempt('right before the swap')
      swap(oldTxid, record)
      attempt('right after the swap')
    }

    await abandon()
    attempt('once the proof resolves, while the wallet signs the replacement')
    const { txid } = await replace()
    attempt('once the replacement is sent')

    for (const [index, { step, outcome }] of attempts.entries()) {
      const error = await outcome
      expect(codeOf(error), step).toBe('pending')
      expect(error instanceof SendPaymentError && error.txid, step).toBe(index < 4 ? paid.txid : txid)
    }
    expect(attempts.map(({ step }) => step)).toEqual([
      'while the indexer is asked for the stuck transaction',
      "while the address's unspent outputs are listed",
      'once the proof resolves, while the wallet signs the replacement',
      'right before the swap',
      'right after the swap',
      'while the replacement is sent',
      'once the replacement is sent',
    ])
    expect(count(esplora.requests, '/utxo')).toBe(1) // none of them scanned
    expect(esplora.broadcasts).toEqual([bump])
    expect([...pending]).toEqual([[txid, bump]])
  })

  it('leaves the stuck transaction or its replacement pending, never neither, wherever it crashes, and ends as it would have', async () => {
    const crash = new Error('test: crash')
    const crashed = (error: unknown) => error === crash || (P2mrPsbtSigningError.is(error) && error.cause === crash)
    const bumpTxid = txidFromRawTx(bump)
    for (const step of [
      'the lookup',
      'the scan',
      'signing the replacement',
      'the swap, before it writes',
      'the swap, once it has written',
    ]) {
      // Throws `crash` the first time the sequence reaches `step`.
      let armed: string | undefined = step
      const strike = (at: string) => {
        if (armed !== at) return
        armed = undefined
        throw crash
      }
      class CrashingClient extends EsploraClient {
        override getTx(...args: Parameters<EsploraClient['getTx']>): ReturnType<EsploraClient['getTx']> {
          strike('the lookup')
          return super.getTx(...args)
        }

        override getAddressUtxos(...args: Parameters<EsploraClient['getAddressUtxos']>): Promise<EsploraUtxo[]> {
          strike('the scan')
          return super.getAddressUtxos(...args)
        }
      }
      const { esplora, client, store, pending, abandon, replace } = stuck({}, paid.rawTxHex, CrashingClient)
      const swap = store.replaceTransaction
      store.replaceTransaction = (oldTxid, record) => {
        strike('the swap, before it writes')
        swap(oldTxid, record)
        strike('the swap, once it has written')
      }
      // The wallet's sequence: prove, sign the replacement, swap it in and send it.
      const sequence = async () => {
        const proof = await abandon()
        const rawTxHex =
          armed === 'signing the replacement'
            ? await signedTx(proof.inputs, bumpOutputs(), { ...store, reserveSignature: () => strike(step) })
            : bump
        return replace({ rawTxHex })
      }

      const error = await caught(sequence())

      expect(crashed(error), step).toBe(true)
      const swapped = step === 'the swap, once it has written'
      expect([...pending], step).toEqual([swapped ? [bumpTxid, bump] : [paid.txid, paid.rawTxHex]])
      expect(esplora.broadcasts, step).toEqual([])

      // After a restart, proving again is safe and changes nothing, and the
      // wallet settles whichever is pending, as after any crash.
      if (swapped) {
        expect(abandonCodeOf(await caught(abandon())), step).toBe('not_pending') // the replacement is pending instead
        await reconcileBroadcast(client, store.pendingTransaction()!, reconcileOptions(5_000))
      } else {
        expect(await abandon(), step).toEqual({
          pending: { txid: paid.txid, rawTxHex: paid.rawTxHex },
          inputs: UTXOS.slice(0, 2),
        })
        expect([...pending], step).toEqual([[paid.txid, paid.rawTxHex]])
        await replace()
      }
      expect([...pending], step).toEqual([[bumpTxid, bump]])
      expect(esplora.broadcasts, step).toEqual([bump])
      expect(esplora.known.has(bumpTxid), step).toBe(true)
    }
  })

  it('swaps a record only while it holds the stuck transaction, and sends no replacement it did not swap in', async () => {
    // Another call, or another device sharing the store, has replaced the
    // stuck transaction with one of its own.
    const outputs = [...bumpOutputs(), { value: 3_000n, scriptPubKey: addressToScriptPubKey(from, 'regtest') }]
    const theirs = {
      txid: unsignedTxid(UTXOS.slice(0, 2), outputs),
      rawTxHex: unsignedTxHex(UTXOS.slice(0, 2), outputs),
    }

    // Before the call: refused as not_pending.
    const before = stuck()
    before.store.replaceTransaction(paid.txid, theirs)

    expect(abandonCodeOf(await caught(before.replace()))).toBe('not_pending')
    expect([...before.pending]).toEqual([[theirs.txid, theirs.rawTxHex]])
    expect(before.esplora.requests).toEqual([])

    // Between its check and its write, which only the store's compare-and-set can see.
    const during = stuck()
    const swap = during.store.replaceTransaction
    during.store.replaceTransaction = (oldTxid, record) => {
      swap(paid.txid, theirs)
      swap(oldTxid, record)
    }
    const refused = await caught(during.replace())

    expect(refused instanceof Error && refused.message).toBe(`test: transaction ${paid.txid} is not the pending one`)
    expect([...during.pending]).toEqual([[theirs.txid, theirs.rawTxHex]])
    expect(during.esplora.requests).toEqual([])

    // The store itself refuses a txid that is not the pending one's, and
    // writes the replacement's txid and hex together.
    const { store, pending } = memoryStore()
    expect(() => store.replaceTransaction(paid.txid, theirs)).toThrow('is not the pending one') // nothing pending
    store.saveTransaction(paid.txid, paid.rawTxHex)
    expect(() => store.replaceTransaction(theirs.txid, { txid: paid.txid, rawTxHex: bump })).toThrow(
      'is not the pending one'
    )
    expect([...pending]).toEqual([[paid.txid, paid.rawTxHex]])
    store.replaceTransaction(paid.txid, theirs)
    expect([...pending]).toEqual([[theirs.txid, theirs.rawTxHex]])
  })

  it.each<[string, BroadcastReply]>([
    ['for a conflict', 'reject'],
    ['for a fee too low', 'reject, fee too low'],
  ])('keeps the replacement pending when the node refuses it %s, unlike sendPayment', async (_, reply) => {
    const { esplora, pending, replace } = stuck({ broadcastReplies: [reply] })

    const error = await caught(replace())

    expect(QbitApiError.is(error) && error.kind).toBe('http')
    expect([...pending]).toEqual([[txidFromRawTx(bump), bump]])
    expect(esplora.broadcasts).toEqual([bump])
  })

  it('keeps the replacement pending on a TypeError, and reconciles an unknown outcome as sendPayment does', async () => {
    const mismatched = stuck({}, paid.rawTxHex, MismatchedTxidClient)

    expect(await caught(mismatched.replace())).toBeInstanceOf(TypeError)
    expect([...mismatched.pending]).toEqual([[txidFromRawTx(bump), bump]])
    expect(mismatched.esplora.broadcasts).toEqual([])

    // The first POST never reaches the node: three not_found lookups, then the same hex again.
    const lost = stuck({ broadcastReplies: ['lost'] })

    expect(await lost.replace()).toEqual({ txid: txidFromRawTx(bump), rawTxHex: bump })
    expect(lookups(lost.esplora.requests)).toBe(3)
    expect(lost.esplora.broadcasts).toEqual([bump, bump])
    expect([...lost.pending]).toEqual([[txidFromRawTx(bump), bump]])
  })

  it('takes a replacement that spends the same outputs in another order', async () => {
    const reordered = unsignedTxHex([UTXOS[1]!, UTXOS[0]!], bumpOutputs())
    const { esplora, pending, replace } = stuck()

    const { txid } = await replace({ rawTxHex: reordered })

    expect(txid).toBe(txidFromRawTx(reordered))
    expect([...pending]).toEqual([[txid, reordered]])
    expect(esplora.broadcasts).toEqual([reordered])
  })

  it('gives a stuck payment up only by swapping in a cancel, never through an empty store, and pays again once the cancel confirms', async () => {
    // The backend lists what the store holds at each step of the sequence.
    const pendingAtEachStep: (string | undefined)[] = []
    let note = () => {}
    class NotingClient extends EsploraClient {
      override getTx(...args: Parameters<EsploraClient['getTx']>): ReturnType<EsploraClient['getTx']> {
        note()
        return super.getTx(...args)
      }

      override getAddressUtxos(...args: Parameters<EsploraClient['getAddressUtxos']>): Promise<EsploraUtxo[]> {
        note()
        return super.getAddressUtxos(...args)
      }

      override broadcastTx(...args: Parameters<EsploraClient['broadcastTx']>): Promise<string> {
        note()
        return super.broadcastTx(...args)
      }
    }
    const utxos = [...UTXOS, DEPOSIT]
    const { esplora, client, store, pending, abandon, replace, send } = stuck({ utxos }, paid.rawTxHex, NotingClient)
    note = () => void pendingAtEachStep.push(store.pendingTransaction()?.txid)
    const swap = store.replaceTransaction
    store.replaceTransaction = (oldTxid, record) => {
      note()
      swap(oldTxid, record)
      note()
    }

    const proof = await abandon()
    note()
    // Every input back to the sender, less the fee: it pays no one.
    const cancel = await signedTx(proof.inputs, cancelOutputs(), {
      ...store,
      reserveSignature: pubkey => {
        note()
        store.reserveSignature(pubkey)
      },
    })
    const { txid } = await replace({ rawTxHex: cancel })
    note()

    // Lookup, scan, proof, two signatures, swap, POST, and once it is sent.
    expect(pendingAtEachStep).not.toContain(undefined)
    expect(pendingAtEachStep).toEqual([...Array<string>(6).fill(paid.txid), ...Array<string>(3).fill(txid)])
    expect([...pending]).toEqual([[txid, cancel]])
    expect(esplora.broadcasts).toEqual([cancel])
    expect(codeOf(await caught(send()))).toBe('pending') // until the cancel, or the stuck transaction, confirms

    // The cancel confirms, so the payment was not made: the wallet clears it,
    // as PaymentStore says, and may pay again, here from the deposit.
    esplora.known.set(txid, { confirmed: true })
    utxos.splice(0, utxos.length, DEPOSIT, confirmedAt(2_000, txid, Number(cancelOutputs()[0]!.value)))
    await reconcileBroadcast(client, store.pendingTransaction()!, reconcileOptions(5_000))
    expect(await client.getTxStatus(txid)).toEqual({ confirmed: true })
    store.dropTransaction(txid)
    const again = await send()

    expect([...pending]).toEqual([[again.txid, again.rawTxHex]])
    expect(esplora.broadcasts).toEqual([cancel, again.rawTxHex])
  })

  it('keeps a cancel pending, and pays nothing more, when the stuck transaction confirms instead', async () => {
    const utxos = [...UTXOS, DEPOSIT]
    const { esplora, client, store, pending, abandon, replace, send } = stuck({ utxos, replyFor: () => 'reject' })
    const proof = await abandon()
    const cancel = await signedTx(proof.inputs, cancelOutputs(), store)
    // The cancel reaches the node, which refuses it: a peer has relayed the
    // stuck transaction to it again, though the indexer has not seen it yet.
    const refused = await caught(replace({ rawTxHex: cancel }))
    expect(QbitApiError.is(refused) && refused.kind).toBe('http')
    const cancelTxid = txidFromRawTx(cancel)
    expect([...pending]).toEqual([[cancelTxid, cancel]])

    // Then the stuck transaction confirms, spending the outputs the cancel
    // spends: the payment was made, and the cancel can no longer confirm.
    esplora.known.set(paid.txid, { confirmed: true })
    utxos.splice(0, utxos.length, DEPOSIT)

    // Nothing in the example settles the cancel or releases it: it stays
    // pending, and no payment starts, until the wallet finds the stuck
    // transaction confirmed, counts the payment as made, and clears the cancel.
    const unsettled = await caught(reconcileBroadcast(client, store.pendingTransaction()!, reconcileOptions(200)))
    expect(QbitApiError.is(unsettled) && unsettled.kind).toBe('unknown_outcome')
    expect(abandonCodeOf(await caught(abandon({ txid: cancelTxid })))).toBe('inputs_spent')
    expect(codeOf(await caught(send()))).toBe('pending')
    expect([...pending]).toEqual([[cancelTxid, cancel]])
    expect(new Set(esplora.broadcasts)).toEqual(new Set([cancel])) // the cancel alone, never another payment
  })

  describe('refuses to abandon a transaction', () => {
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

    it('when the backend refuses to list more unspent outputs than its limit, as sendPayment does', async () => {
      // 501 outputs, more than the 500 qbit-electrs lists by default.
      const many = Array.from({ length: 499 }, (_, index) => confirmed(index.toString(16).padStart(64, '0'), 10_000))
      const { esplora, pending, abandon } = stuck({ utxos: [...UTXOS.slice(0, 2), ...many] })

      const error = await caught(abandon())

      expect(abandonCodeOf(error)).toBe('too_many_utxos')
      expect(error instanceof AbandonPaymentError && error.txid).toBe(paid.txid)
      expect(error instanceof Error && error.message).toContain('Too many unspent transaction outputs (>500)')
      expect(count(esplora.requests, '/utxo')).toBe(1)
      expect(pending.get(paid.txid)).toBe(paid.rawTxHex)

      // Any other failure of the scan is the client's error, unchanged.
      const refusal = new QbitApiError('http', 'test: refused', {
        status: 400,
        responseBody: 'Invalid Bitcoin address',
      })
      const other = stuck({}, paid.rawTxHex, scanFailsWith(refusal))

      expect(await caught(other.abandon())).toBe(refusal)
      expect(other.pending.get(paid.txid)).toBe(paid.rawTxHex)
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

    it('whose record is swapped for a replacement during the lookups, as not_pending, before it resolves', async () => {
      // A client whose scan sees another call swap the record first.
      let swap = () => {}
      class SwapsTheRecordClient extends EsploraClient {
        override getAddressUtxos(...args: Parameters<EsploraClient['getAddressUtxos']>): Promise<EsploraUtxo[]> {
          swap()
          return super.getAddressUtxos(...args)
        }
      }
      const { store, pending, abandon } = stuck({}, paid.rawTxHex, SwapsTheRecordClient)
      const replacement = { txid: txidFromRawTx(bump), rawTxHex: bump }
      swap = () => store.replaceTransaction(paid.txid, replacement)

      const error = await caught(abandon())

      expect(abandonCodeOf(error)).toBe('not_pending')
      expect([...pending]).toEqual([[replacement.txid, bump]])
    })

    it('whose stored hex turns corrupt during the lookups, as corrupt_pending, before it resolves', async () => {
      // A client whose scan sees the store's record overwritten with a cut-off copy first.
      const truncated = paid.rawTxHex.slice(0, -2)
      let corrupt = () => {}
      class CorruptsTheStoreClient extends EsploraClient {
        override getAddressUtxos(...args: Parameters<EsploraClient['getAddressUtxos']>): Promise<EsploraUtxo[]> {
          corrupt()
          return super.getAddressUtxos(...args)
        }
      }
      const { store, pending, abandon } = stuck({}, paid.rawTxHex, CorruptsTheStoreClient)
      corrupt = () => store.saveTransaction(paid.txid, truncated)

      const error = await caught(abandon())

      expect(abandonCodeOf(error)).toBe('corrupt_pending')
      expect(pending.get(paid.txid)).toBe(truncated) // not released
    })
  })

  describe('refuses to replace a transaction, before it changes or sends anything,', () => {
    // Unsigned: they are refused before anything could check a witness.
    const payment = () => [{ value: 50_000n, scriptPubKey: addressToScriptPubKey(to, 'regtest') }]

    it.each<[string, () => unknown, string]>([
      ['with one that spends only one of its inputs', () => unsignedTxHex([UTXOS[0]!], payment()), 'exactly'],
      [
        'with one that spends another output as well',
        () => unsignedTxHex([...UTXOS.slice(0, 2), DEPOSIT], payment()),
        'exactly',
      ],
      ['with one that spends other outputs', () => unsignedTxHex([DEPOSIT], payment()), 'exactly'],
      ['with itself', () => paid.rawTxHex, 'itself'],
      ['with itself, stored under an uppercase txid', () => paid.rawTxHex, 'itself'],
      ['with hex that is not a whole transaction', () => bump.slice(0, -2), 'not a whole transaction'],
      ['with hex that is not a string', () => 1, 'not a whole transaction'],
    ])('%s', async (name, replacement, reason) => {
      // A store may return the txid in uppercase: it still names that transaction.
      const upperCase = name.includes('uppercase')
      const txid = upperCase ? paid.txid.toUpperCase() : paid.txid
      const { esplora, store, pending, replace } = stuck()
      if (upperCase) pending.set(txid, pending.get(paid.txid)!).delete(paid.txid)

      const error = await caught(replace({ txid, rawTxHex: replacement() as string }))

      expect(abandonCodeOf(error)).toBe('invalid_replacement')
      expect(error instanceof Error && error.message).toContain(reason)
      expect(error instanceof AbandonPaymentError && error.txid).toBe(txid)
      expect([...pending]).toEqual([[txid, paid.rawTxHex]])
      expect(esplora.requests).toEqual([])
    })

    it.each<[string, Partial<Parameters<typeof replacePendingPayment>[0]>, AbandonPaymentErrorCode]>([
      ['that is not the pending one', { txid: 'ab'.repeat(32) }, 'not_pending'],
      ['with a deadline longer than a timer can wait', { deadlineMs: 2_147_483_648 }, 'invalid_options'],
      ['with a zero poll interval', { pollMs: 0 }, 'invalid_options'],
      ['with an object that is not a signal', { signal: { aborted: false } as AbortSignal }, 'invalid_options'],
    ])('%s', async (_, overrides, code) => {
      const { esplora, pending, replace } = stuck()

      const error = await caught(replace(overrides))

      expect(abandonCodeOf(error)).toBe(code)
      expect([...pending]).toEqual([[paid.txid, paid.rawTxHex]])
      expect(esplora.requests).toEqual([])
    })

    it('once its deadline has passed, as a timeout QbitApiError', async () => {
      // The clock jumps past the deadline between the call's two readings of it.
      const realNow = Date.now.bind(Date)
      let readings = 0
      const clock = vi.spyOn(Date, 'now').mockImplementation(() => realNow() + (readings++ === 0 ? 0 : 60_000))
      try {
        const { esplora, pending, replace } = stuck()

        const error = await caught(replace())

        expect(readings).toBe(2)
        expect(QbitApiError.is(error) && error.kind).toBe('timeout')
        expect([...pending]).toEqual([[paid.txid, paid.rawTxHex]])
        expect(esplora.requests).toEqual([])
      } finally {
        clock.mockRestore()
      }
    })

    it('once its signal has aborted, as an aborted QbitApiError', async () => {
      const controller = new AbortController()
      controller.abort(new Error('test: cancelled'))
      const { esplora, pending, replace } = stuck()

      const error = await caught(replace({ signal: controller.signal }))

      expect(QbitApiError.is(error) && error.kind).toBe('aborted')
      expect(QbitApiError.is(error) && error.cause).toBe(controller.signal.reason)
      expect([...pending]).toEqual([[paid.txid, paid.rawTxHex]])
      expect(esplora.requests).toEqual([])
    })
  })
})

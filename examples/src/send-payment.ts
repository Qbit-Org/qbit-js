// Send a payment from a single-key P2MR address, end to end:
//
//   1. getAddressUtxos          find the outputs the wallet can spend, and pick
//      getTipHeight, getTx      the largest, only as many as the payment needs,
//                               skipping coinbase outputs that are not mature
//   2. createP2mrPsbt           build the unsigned transaction
//   3. validateP2mrSigningPlans check the plans before any key is used
//   4. signP2mrPsbt             sign every input, persisting each signature
//   5. finalizeP2mrPsbt         assemble the witnesses
//   6. extractP2mrTransaction   get the bytes to broadcast
//   7. broadcastTx              submit them, and reconcile an unknown outcome
//
// It checks its parameters before any request and the backend's UTXO rows
// before any key is used, and it never stores a transaction while an earlier
// payment is still pending. `abandonPendingPayment` releases a pending
// transaction that no node will take any more.
//
// `key` is the wallet's key from @qbit-oss/pqc's `deriveP2mrDescriptorKey`
// (`{ pk32, sk64 }`). The broadcast rules are in packages/api/docs/broadcasting.md,
// the signing rules in packages/protocol/docs/signing-and-finalization.md.

import {
  EsploraClient,
  QbitApiError,
  txidFromRawTx,
  type EsploraUtxo,
  type QbitApiErrorKind,
  type RequestOptions,
} from '@qbit-oss/api'
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
  P2MR_LEAF_VERSION_V1,
  PSBT_GLOBAL_UNSIGNED_TX,
  QBIT_COINBASE_MATURITY,
  signP2mrPsbt,
  singleKeyLeafScript,
  validateP2mrSigningPlans,
} from '@qbit-oss/protocol'

import { WALLET_MAX_FEE_RATE } from './check-balance'

/**
 * What the wallet writes down while it pays. Each method must finish writing
 * before it returns: signing is synchronous and cannot wait for a promise.
 *
 * A pending record is rewritten in one case only: restoring one that
 * `sendPayment`, `reconcileBroadcast` or `abandonPendingPayment` refused as
 * `corrupt_pending`, whose hex is not the transaction its txid names, as
 * `AbandonPaymentErrorCode` says. No method here does that: the wallet writes
 * the record itself, in place and only while it is still pending, and only so
 * that `txidFromRawTx` of its hex is its txid, compared case-insensitively:
 *
 * - Usually its hex: the record keeps its txid and takes hex whose
 *   `txidFromRawTx` is that txid, such as `client.getTxHex(txid)` returns.
 * - When the txid is the damaged field: the record keeps its hex and takes
 *   `txidFromRawTx` of it as its txid, but only once `client.getTxHex` of that
 *   txid has returned that same transaction. Never on the hex alone: it may be
 *   an older payment that is still valid, which resubmitting would pay again.
 */
export interface PaymentStore {
  /**
   * Count one more signature by `pubkey` before it is made, and throw to
   * refuse: a bounded30 key must stop after 2^30 signatures, and
   * @qbit-oss/pqc keeps no counter.
   */
  reserveSignature(pubkey: Uint8Array): void
  /** One signature, as soon as it exists, so a crash or later failure cannot lose it. */
  saveSignature(record: SignatureRecord): void
  /**
   * The signed transaction, before it is first sent. It stays pending until it
   * confirms, or another transaction spending its inputs confirms; the wallet
   * clears it then. Until then, after a crash or an unknown outcome, settle it
   * by passing the record `pendingTransaction()` returns, txid and hex, to
   * `reconcileBroadcast`, which checks that the hex is that transaction; never
   * pay again with other inputs. Only the proof `abandonPendingPayment` checks
   * releases one that no node will take: that call checks it, or, for a record
   * it refuses as `corrupt_pending`, the wallet does, as
   * `AbandonPaymentErrorCode` says.
   *
   * `sendPayment` checks `pendingTransaction()` again right before this call,
   * with no await in between, which keeps two calls in one process from both
   * paying. A store that several processes or devices share must also make
   * this a compare-and-set that throws while another transaction is pending.
   */
  saveTransaction(txid: string, rawTxHex: string): void
  /**
   * The transaction is no longer pending: the node definitely did not accept
   * it, or the proof `abandonPendingPayment` checks releases it.
   */
  dropTransaction(txid: string): void
  /** The transaction saved with `saveTransaction`, or restored as above, that is still pending, if any. */
  pendingTransaction(): { txid: string; rawTxHex: string } | undefined
}

/** One signature, with what it signs: transaction, input and leaf. */
export interface SignatureRecord {
  /** The transaction it signs. Witnesses do not change a txid, so it is known before signing. */
  txid: string
  inputIndex: number
  /** The key that made it. */
  pubkey: Uint8Array
  /** The leaf it signs for, `p2mrLeafHash` of the key's single-key leaf script. */
  leafHash: Uint8Array
  /** The PSBT record that holds it: `key` is its type, pubkey and leaf hash, `value` the signature. */
  key: Uint8Array
  value: Uint8Array
}

export interface SendPaymentParams {
  client: EsploraClient
  key: PqcDerivedKey
  /** Recipient's regtest P2MR address. */
  to: string
  /** At least the dust threshold, 2,855 sats. */
  amountSats: bigint
  /**
   * sat/vB, at least qbit Core's minimum relay fee rate, 0.25, and at most
   * `WALLET_MAX_FEE_RATE`; for example from `walletFeeTiers` in check-balance.ts.
   */
  feeRate: number
  store: PaymentStore
  /** One budget for the whole payment: scan, signing, broadcast and any reconciliation. At most 2,147,483,647 ms. */
  deadlineMs: number
  /**
   * Cancels the payment. Until the transaction is stored, a cancel rejects
   * with an `aborted` QbitApiError, or a `P2mrPsbtSigningError` caused by one,
   * as `sendPayment` says; once the transaction may have been sent, the
   * outcome stays unknown.
   */
  signal: AbortSignal
  /**
   * Wait between status checks after an unknown outcome (default 2 s), at most
   * 2,147,483,647 ms. It also sets the budget of the first POST, and of every
   * lookup and resubmission after it but the last round's resubmission, which
   * gets all that is left: see `reconcileBroadcast`.
   */
  pollMs?: number
}

/**
 * Why `sendPayment` refused to pay, before it stored or sent anything, or
 * `reconcileBroadcast` refused its options or its record, before any request:
 *
 * - `invalid_amount`: `amountSats` is not a bigint, or is below the dust threshold.
 * - `invalid_fee_rate`: `feeRate` is not a number from qbit Core's minimum
 *   relay fee rate, 0.25 sat/vB, to `WALLET_MAX_FEE_RATE`.
 * - `invalid_options`: `deadlineMs` or `pollMs` is not a number above 0 and at
 *   most 2,147,483,647, the longest delay a timer supports, or `signal` is not
 *   an `AbortSignal`. `reconcileBroadcast` applies the same rules to its
 *   `pollMs` and `signal`, and to the time left before its `end` unless `end`
 *   has passed, and refuses a record that is not an object with a string
 *   `txid` and `rawTxHex`, such as the hex alone; its transaction stays pending.
 * - `too_many_utxos`: the backend refuses to list the address's unspent
 *   outputs because there are more than it lists for one address.
 *   qbit-electrs refuses above its `--utxos-limit`, 500 by default, with a
 *   400 whose body starts "Too many unspent transaction outputs"; it is
 *   recognized by that status and body, and any other failure of the scan is
 *   the client's `QbitApiError`, unchanged. A regtest wallet that mined the
 *   blocks its coinbase outputs need to mature to its own address has more
 *   than 500. Raise the backend's `--utxos-limit`, consolidate the outputs
 *   into fewer with a backend that lists them all, or mine to an address
 *   other than the wallet's and send the wallet only what it needs.
 * - `invalid_utxos`: the backend's UTXO list is malformed or lists an outpoint twice.
 * - `insufficient_funds`: the confirmed outputs worth more than the fee to
 *   spend them cannot cover the amount and the fee.
 * - `too_many_inputs`: they can, but only with more than 106 inputs, which
 *   would make the transaction too large for qbit Core to relay.
 * - `immature_funds`: they can with at most 106 inputs, but not without
 *   coinbase outputs with fewer than 1,001 confirmations,
 *   `QBIT_COINBASE_MATURITY` plus one, which it does not spend yet: qbit
 *   Core's own wallet waits that long. It looks up at most 106 funding
 *   transactions to tell, and counts as unspendable too any output with fewer
 *   than 1,001 confirmations whose funding transaction it did not look up.
 *   Either way, it can pay with them once they have 1,001 confirmations.
 * - `pending`: an earlier payment, `txid`, is still pending. Checked before
 *   the UTXO scan, and again after signing, right before the transaction is
 *   stored.
 * - `corrupt_pending`: as with `pending`, an earlier payment, `txid`, is still
 *   pending, but the hex the store holds for it is not that transaction, or
 *   not a whole transaction. `reconcileBroadcast` refuses such a record with
 *   `corrupt_pending` too, and `abandonPendingPayment` cannot release it.
 *   Never treat it as nothing pending: restore the record, as `PaymentStore`
 *   allows and `AbandonPaymentErrorCode` says.
 */
export type SendPaymentErrorCode =
  | 'invalid_amount'
  | 'invalid_fee_rate'
  | 'invalid_options'
  | 'too_many_utxos'
  | 'invalid_utxos'
  | 'insufficient_funds'
  | 'too_many_inputs'
  | 'immature_funds'
  | 'pending'
  | 'corrupt_pending'

export class SendPaymentError extends Error {
  readonly code: SendPaymentErrorCode
  /** With `pending` and `corrupt_pending`: the transaction that is still pending. */
  readonly txid: string | undefined

  constructor(code: SendPaymentErrorCode, message: string, txid?: string) {
    super(message)
    this.name = 'SendPaymentError'
    this.code = code
    this.txid = txid
  }
}

// qbit has no witness discount, so a transaction's virtual size is its full
// size in bytes. A single-key P2MR input takes at most 3,763 bytes with its
// witness (qbit Core's P2MR_V1_SINGLE_KEY_SPEND_SIZE), a P2MR output 43, and
// the version, witness marker and flag, input and output counts and locktime 12.
const INPUT_BYTES = 3_763
const OUTPUT_BYTES = 43
const OVERHEAD_BYTES = 12

/**
 * The smallest P2MR output qbit Core relays, 2,855 sats. `GetDustThreshold`
 * (src/policy/policy.cpp @ v1.0.0, 7ebcddb622d6e639041f005a189b048ec2a221fe)
 * prices the output's own 43 bytes plus the 3,763-byte input that spends it at
 * `DUST_RELAY_TX_FEE`, 750 sat/kvB by default (src/policy/policy.h), rounding
 * up: 3,806 * 750 / 1,000 = 2,854.5. A transaction that pays a fee and has an
 * output below it is not standard, so the node would not relay it.
 */
const DUST_THRESHOLD_SATS = (BigInt(OUTPUT_BYTES + INPUT_BYTES) * 750n + 999n) / 1_000n

/**
 * The lowest fee rate qbit Core relays, 0.25 sat/vB: `DEFAULT_MIN_RELAY_TX_FEE`,
 * 250 sat/kvB (src/policy/policy.h @ v1.0.0,
 * 7ebcddb622d6e639041f005a189b048ec2a221fe). Core asks that rate of a
 * transaction's size, rounded up, and refuses less with "min relay fee not
 * met". The fee here is rounded up over an upper bound of the size, so any
 * rate from this one up pays enough. A node started with a higher
 * `-minrelaytxfee`, or whose mempool is full, asks more.
 */
const MIN_RELAY_FEE_RATE = 250 / 1_000

/**
 * The most inputs a payment spends, 106. qbit Core relays no transaction
 * heavier than `MAX_STANDARD_TX_WEIGHT`, 400,000 (src/policy/policy.h @ v1.0.0,
 * 7ebcddb622d6e639041f005a189b048ec2a221fe), and with no witness discount a
 * transaction's weight is its size. With two outputs, 106 inputs take at most
 * 12 + 106 * 3,763 + 2 * 43 = 398,976 bytes, and 107 would take 402,739. Up to
 * 252 inputs, the input count takes the one byte OVERHEAD_BYTES counts.
 */
const MAX_INPUTS = Math.floor((400_000 - OVERHEAD_BYTES - 2 * OUTPUT_BYTES) / INPUT_BYTES)

/**
 * The fewest confirmations a coinbase output needs before a payment spends it,
 * 1,001: `QBIT_COINBASE_MATURITY` plus one, as qbit Core's own wallet counts
 * it (`CWallet::GetTxBlocksToMaturity`, src/wallet/wallet.cpp:4386-4395 @
 * v1.0.0, 7ebcddb622d6e639041f005a189b048ec2a221fe). A node's mempool takes a
 * spend once the output has 1,000 confirmations at the node's own tip
 * (src/consensus/tx_verify.cpp:179), and after a reorg it checks a coinbase
 * spend again at its new tip and evicts one that is no longer mature
 * (src/validation.cpp:406-407).
 *
 * The extra block keeps the spend mature while the node's tip is at most one
 * block below the indexer's tip height that the payment counted from. That
 * covers an indexer one block ahead of the node that checks the broadcast, or
 * a reorg that leaves that node's tip one block lower after it took the spend,
 * but not both together. Two or more blocks below, the spend is premature.
 * Then the node rejects the broadcast with
 * `bad-txns-premature-spend-of-coinbase`, which `broadcastTx` reports as `http`
 * (packages/api/docs/broadcasting.md), so `sendPayment` drops the transaction
 * and rejects with that error, having paid nothing. Or, if the node took the
 * spend first, a reorg evicts it from the mempool although `sendPayment`
 * resolved: the transaction stays pending until the wallet settles it with
 * `reconcileBroadcast`, whose resubmission of the same hex the node takes once
 * the output is mature at its tip again.
 */
const COINBASE_SPEND_DEPTH = QBIT_COINBASE_MATURITY + 1

/** The longest delay a timer supports, and the largest `deadlineMs` the client accepts. */
const MAX_TIMER_MS = 2_147_483_647

/**
 * `broadcastTx` error kinds that prove the node did not accept the
 * transaction: a rejection, or a request refused or stopped before it was
 * sent. `unknown_outcome`, and any kind a newer version of @qbit-oss/api adds,
 * may mean it did.
 *
 * This is a copy. packages/api/docs/broadcasting.md is the authority on what
 * each kind means, and a wallet must keep this list in sync with it: check it
 * again whenever it upgrades @qbit-oss/api.
 */
const NOT_ACCEPTED = new Set<QbitApiErrorKind>([
  'http',
  'rate_limit',
  'payload_too_large',
  'not_found',
  'network',
  'aborted',
  'timeout',
])

/**
 * Pay `amountSats` to `to` from `key`'s address, spending its largest
 * confirmed outputs first, only as many as the amount and the fee need, and
 * returning the change, and resolve once the node has the transaction. Change
 * below the dust threshold goes to the fee instead. It spends a coinbase output
 * only once it has `QBIT_COINBASE_MATURITY` plus one confirmations, 1,001, as
 * qbit Core's own wallet does: a block later than the mempool allows.
 *
 * It rejects with a `SendPaymentError` (see `SendPaymentErrorCode`), with a
 * `QbitProtocolError` when `to` is not a regtest P2MR address, or with the
 * `QbitApiError` of a request that fails, before any key is used. The
 * requests then are the UTXO scan, the tip height and the funding transaction
 * lookups; a lookup fails with `parse` when the reply is not that transaction
 * or does not say whether it is a coinbase transaction. Only a payment that
 * became pending while this one signed is found after signing, still before
 * anything is stored or sent. The signer loads within the same deadline: if
 * it has not loaded when the deadline passes or `signal` aborts, the payment
 * rejects with a `timeout` or an `aborted` QbitApiError, while the load, which
 * later calls share, carries on. A cancel before the transaction is stored,
 * the signer's load included, rejects with an `aborted` QbitApiError whose
 * `cause` is the signal's reason, as the client's calls do, or, when signing
 * sees it between two signatures, with a `P2mrPsbtSigningError` whose `cause`
 * is that error.
 *
 * If signing fails, it rejects with the `P2mrPsbtSigningError` and stores or
 * sends no transaction. Starting over is safe, since nothing was sent. To
 * finish the same transaction instead, call `signP2mrPsbt` with `error.psbt`
 * and only the plans that are not in `error.signed`. There is one plan per
 * input, `{ inputIndex, pubkey: key.pk32, leafHash }`, with the leaf hash the
 * saved `SignatureRecord`s carry; a plan already signed is refused before any
 * signer call. In phase `'sign'`, no signature was stored for `error.failed`,
 * but a reservation its `sign` call made stays counted. In phase `'onSigned'`
 * the store missed the signature for `error.failed`, so save it from
 * `error.psbt` first. Then finalize, extract, store and broadcast as steps 5
 * to 7 below do.
 *
 * The first broadcast is round 0 of `reconcileBroadcast`'s schedule, and its
 * budget follows the rule every request there but the last round's
 * resubmission follows: all but a poll interval of the time left while at
 * least two are left, and half of it below that. So if it stalls, it stops
 * while reconciliation's last round still has time to look the transaction up
 * and resubmit it, and however little time is left, it gets at least half.
 */
export async function sendPayment(params: SendPaymentParams): Promise<{ txid: string; rawTxHex: string }> {
  const { client, key, to, amountSats, feeRate, store, signal, pollMs = 2_000 } = params
  const network = 'regtest'
  checkParams(params)
  const recipient = addressToScriptPubKey(to, network) // throws for an address that is not regtest P2MR
  const end = Date.now() + params.deadlineMs

  // A pending payment may be in the mempool already, where the UTXO scan no
  // longer lists its inputs, so a call that retries it would spend other
  // outputs and pay twice. Wait until it confirms or is dropped.
  refuseWhilePending(store)

  // 1. Find the outputs to spend, and the chain's height, while the WASM
  // signer loads (init() loads it once; later calls share it). Every step gets
  // what is left of the one deadline. The clock is read once for both
  // requests: had the deadline passed between two readings, msLeft would throw
  // with the scan already started and nothing to handle its rejection. None of
  // the three calls below throws: each turns any throw, init()'s included, into
  // a rejection, so Promise.all handles every request they start.
  const from = p2mrAddressFromPubkey(key.pk32, network)
  const requestMs = msLeft(end)
  const [pqc, rows, tipHeight] = await Promise.all([
    waitWithin(init, end, signal),
    scanUtxos(client, from, { signal, deadlineMs: requestMs }, (code, message) => new SendPaymentError(code, message)),
    checkedTipHeight(client, { signal, deadlineMs: requestMs }),
  ])
  const utxos = rows.filter(utxo => utxo.status?.confirmed === true) // this example spends confirmed outputs only

  // Spend the largest outputs first, only as many as the payment needs, and
  // no coinbase output that is not mature, which takes a lookup for each
  // output with fewer than 1,001 confirmations it reaches. Change below the dust
  // threshold would make the transaction nonstandard, so it goes to the fee
  // instead of to an output.
  const spent = await selectInputs(utxos, amountSats, feeRate, tipHeight, txid =>
    isCoinbaseTx(client, txid, { signal, deadlineMs: msLeft(end) })
  )
  const totalSats = spent.reduce((sum, utxo) => sum + BigInt(utxo.value), 0n)
  const changeSats = totalSats - amountSats - feeFor(spent.length, 2, feeRate)

  // 2-3. Build the unsigned transaction, then check the signing plans before
  // the user approves it and before any key is used.
  const scriptPubKey = addressToScriptPubKey(from, network) // `from` = p2mrAddressFromPubkey(key.pk32, network)
  const leafScript = singleKeyLeafScript(key.pk32) // the only leaf of a single-key address
  const psbt = createP2mrPsbt({
    inputs: spent.map(utxo => ({
      prevout: { txid: hexToBytes(utxo.txid).reverse(), vout: utxo.vout }, // explorers show txids byte-reversed
      witnessUtxo: { value: BigInt(utxo.value), scriptPubKey },
      leafScript,
      controlBlock: buildControlBlock(),
    })),
    outputs: [
      { value: amountSats, scriptPubKey: recipient },
      ...(changeSats >= DUST_THRESHOLD_SATS ? [{ value: changeSats, scriptPubKey }] : []), // change back to the sender
    ],
  })
  const leafHash = p2mrLeafHash(P2MR_LEAF_VERSION_V1, leafScript)
  const keys = spent.map((_, inputIndex) => ({ inputIndex, pubkey: key.pk32, leafHash }))
  validateP2mrSigningPlans({ psbt, keys }) // the checks signP2mrPsbt runs before its first signer call
  // The txid of the unsigned transaction, which signing does not change.
  const txid = txidFromRawTx(bytesToHex(psbt.global.find(entry => entry.key[0] === PSBT_GLOBAL_UNSIGNED_TX)!.value))

  // 4. Sign. Both callbacks must be synchronous.
  const signed = signP2mrPsbt({
    psbt,
    keys,
    // Returns the 3,680-byte SLH-DSA signature of the sighash it is handed.
    // Each signature takes about 0.6 s, so check the deadline and the signal
    // first, then record that the key is about to sign once more.
    sign: sighash => {
      msLeft(end)
      throwIfCancelled(signal)
      store.reserveSignature(key.pk32)
      return pqc.sign(key.sk64, sighash)
    },
    // Runs after each signature is stored in the PSBT and before the next
    // `sign` call. A stateful signer persists the signature here, with the
    // txid, input and leaf it signs, so a crash or a later failure never loses
    // a signature it already made. sendPayment's doc says how to resume.
    onSigned: ({ field, ...plan }) => store.saveSignature({ txid, ...plan, key: field.key, value: field.value }),
  })

  // 5-6. Assemble the witnesses and extract the transaction.
  const rawTxHex = bytesToHex(extractP2mrTransaction(finalizeP2mrPsbt(signed.psbt)))

  // 7. Store the transaction, then broadcast it.
  // #region broadcast
  // Signing blocked the thread, so a cancel issued meanwhile (a timer, a
  // click) has not run yet. Let it run, and stop before anything is stored
  // or sent if it did, or if the deadline passed.
  await sleep(0, signal)
  throwIfCancelled(signal)
  // The POST is round 0 of reconcileBroadcast's schedule, with the budget its
  // requests get: if it stalls, the last round still has time to resubmit.
  const deadlineMs = requestBudgetMs(msLeft(end), pollMs) // a deadline that has passed sends nothing
  // Another call may have stored a payment while this one scanned and signed.
  // Check again, with no await before the save, so that only one of them pays.
  refuseWhilePending(store)
  store.saveTransaction(txid, rawTxHex)
  try {
    await client.broadcastTx(rawTxHex, { txid, signal, deadlineMs })
  } catch (error) {
    // broadcastTx throws a TypeError only for an invalid argument, before it sends anything.
    if (error instanceof TypeError || (QbitApiError.is(error) && NOT_ACCEPTED.has(error.kind))) {
      store.dropTransaction(txid) // definitely not accepted: never send it later
      throw error
    }
    // unknown_outcome, a kind this version does not know, or any other error,
    // which may follow a send: the node may have the transaction. Find out
    // before sending again, and never rebuild.
    await reconcileBroadcast(client, { txid, rawTxHex }, { end, signal, pollMs })
  }
  // #endregion broadcast
  return { txid, rawTxHex }
}

/**
 * Settle a broadcast whose outcome is unknown, such as `broadcastTx`'s
 * `unknown_outcome`. `pending` is the pending record, its txid and hex, as
 * `PaymentStore.pendingTransaction()` returns it. The transaction may already
 * be in the node's mempool, so this looks it up with `getTx`, and resolves once
 * the indexer answers with the transaction, in its mempool or in a block. Any
 * other reply, such as one whose `txid` is another transaction's, proves
 * nothing. Nor does `not_found`, which only means this indexer does not know
 * the transaction yet: the request may never have reached the node, or the
 * indexer may lag its node. After three `not_found` replies in a row, it
 * resubmits the **same** hex, which cannot pay twice, and resolves when the
 * node accepts it.
 *
 * Each round waits a poll interval, or half of what is left before `end` when
 * less than two are left, then looks the transaction up. A round with less
 * than two poll intervals left once its lookup is over is the last: unless the
 * lookup found the transaction or `end` has passed, it resubmits once with
 * what remains and stops. One reading of the clock decides that and sets that
 * resubmission's budget, so the clock reaching `end` just after the reading
 * cannot stop the resubmission before it is sent. So only the last round
 * resubmits with less than two poll intervals left.
 * One budget rule covers every other request, and `sendPayment`'s first
 * broadcast, which is round 0: each gets all but a poll interval of the time
 * left while at least two are left, and half of what is left below that, and
 * a request that stalls is stopped then. So however little time is left, a
 * request gets at least half of it, and a stalled one leaves the requests
 * after it a poll interval, or half of what was left when it started. A short
 * deadline still settles a transaction that never reached the node, even when
 * the first broadcast, the indexer or an earlier resubmission stalls, without
 * a burst of requests as the deadline nears.
 * `broadcastTx` resolves an already-known reply too, since this passes the
 * txid. Rebuilding the payment with other inputs instead could pay twice.
 *
 * `getTxStatus` cannot answer this: qbit-electrs replies `{ confirmed: false }`
 * for a txid it has never seen, as it does for a transaction in its mempool.
 *
 * A rejected resubmission settles nothing: the first copy may have confirmed
 * already, so the node sees its inputs as spent, or may still confirm. If
 * `end` passes, `signal` aborts, or the last round's resubmission fails first,
 * it rejects with an `unknown_outcome` error: keep the transaction pending and
 * call this again later, for example after a restart. If no node will take it
 * any more, see `abandonPendingPayment`.
 *
 * Before any request, it checks, in this order: `pollMs`, `signal` and the
 * time left before `end`, as `sendPayment` checks `pollMs`, `signal` and
 * `deadlineMs`, and that `pending` is an object with a string `txid` and
 * `rawTxHex`, throwing an `invalid_options` `SendPaymentError` for any of them,
 * such as for a call that passes the hex alone; then the record, throwing a
 * `corrupt_pending` `SendPaymentError` unless `rawTxHex` is the whole
 * transaction `txid`, compared case-insensitively, since resubmitting another
 * transaction, such as an older payment that is still valid, would pay it
 * again. Restore such a record as `PaymentStore` allows and
 * `AbandonPaymentErrorCode` says. Only then does an `end` that has already
 * passed, which is no mistake, reject with `unknown_outcome` without a
 * request, as when `end` passes while it polls. So a corrupt record is
 * reported even once `end` has passed.
 */
export async function reconcileBroadcast(
  client: EsploraClient,
  pending: { txid: string; rawTxHex: string },
  options: { end: number; signal: AbortSignal; pollMs: number }
): Promise<void> {
  const { end, signal, pollMs } = options
  checkDelay('pollMs', pollMs)
  checkSignal(signal)
  // Read the clock once: `end` passing between two readings is no invalid option.
  const timeLeft = end - Date.now()
  if (!(timeLeft <= 0)) checkDelay('the time left before end', timeLeft)
  // Read once, so that the hex checked is the hex sent. The hex alone, or
  // nothing, in the record's place reads as no fields.
  const { txid: recordTxid, rawTxHex }: Partial<typeof pending> = pending ?? {}
  if (typeof recordTxid !== 'string' || typeof rawTxHex !== 'string') {
    throw new SendPaymentError(
      'invalid_options',
      'the pending record must be an object { txid, rawTxHex } with both strings, as PaymentStore.pendingTransaction() returns it'
    )
  }
  const txid = txidOf(rawTxHex) // the record's txid, in lowercase, if the hex is that whole transaction
  if (txid !== recordTxid.toLowerCase()) {
    throw new SendPaymentError('corrupt_pending', corruptRecord(recordTxid), recordTxid)
  }
  let absentReplies = 0
  while (Date.now() < end && !signal.aborted) {
    // Give the transaction time to propagate.
    const beforeWait = end - Date.now()
    await sleep(finalStretch(beforeWait, pollMs) ? beforeWait / 2 : pollMs, signal)
    // Every request but the last round's resubmission gets requestBudgetMs,
    // which leaves a later one time, so that a stalled one cannot take the
    // last round's. Once `end` has passed, it throws before the request.
    let lookup: 'found' | 'absent' | 'unknown'
    try {
      await lookUpTx(client, txid, { signal, deadlineMs: requestBudgetMs(msLeft(end), pollMs) })
      lookup = 'found' // in the mempool or in a block
    } catch (error) {
      // `not_found`: not known to this indexer yet. Any other failure, a reply
      // that is not this transaction or a lookup with no time left included,
      // tells us nothing.
      lookup = QbitApiError.is(error) && error.kind === 'not_found' ? 'absent' : 'unknown'
    }
    if (lookup === 'found') return
    // Decided once the lookup is over, from the one reading that also sets the
    // resubmission's budget, so that only the last round resubmits in the
    // final stretch, and then stops. Read again, the clock could reach `end`
    // in between and stop the last round's resubmission before it is sent.
    const left = end - Date.now()
    const lastRound = finalStretch(left, pollMs)
    absentReplies = lookup === 'absent' ? absentReplies + 1 : 0
    if (absentReplies < 3 && !lastRound) continue
    if (left <= 0) break // `end` passed during the lookup: no time is left to resubmit
    absentReplies = 0
    try {
      const deadlineMs = lastRound ? left : requestBudgetMs(left, pollMs) // the last request gets all that is left
      await client.broadcastTx(rawTxHex, { txid, signal, deadlineMs })
      return
    } catch {
      // Whatever went wrong, a rejection included, keep looking.
    }
    if (lastRound) break // resubmit once at the end, never again and again
  }
  throw new QbitApiError('unknown_outcome', `the outcome of transaction ${txid} is still unknown`, { txid })
}

/**
 * Why `abandonPendingPayment` refused to release a pending transaction. It
 * released nothing.
 *
 * - `invalid_options`: `deadlineMs` is not a number above 0 and at most 2,147,483,647.
 * - `not_pending`: the store holds no pending transaction `txid`.
 * - `corrupt_pending`: the store holds pending transaction `txid`, but the hex
 *   it holds for it is not that transaction, or not a whole transaction.
 *   Checked before any request, and again right before the release: this
 *   call broadcast nothing and released nothing. Never treat it as nothing
 *   pending: the transaction may have been sent, and may yet confirm. Until
 *   the record holds the transaction's hex again, this call cannot release
 *   it, and `reconcileBroadcast` and `sendPayment` refuse with
 *   `corrupt_pending`. Restore the record, the one rewrite `PaymentStore`
 *   allows, then settle or release the transaction as usual.
 *   `client.getTxHex(txid)` needs no backup: it returns the hex only when it
 *   is transaction `txid`, and it answers whenever the indexer knows the
 *   transaction, in its mempool or in a block. It does not check the
 *   witnesses, which the txid does not commit to, but hex with other
 *   witnesses still spends the same inputs to the same outputs, so
 *   resubmitting it cannot pay twice. Hex from the wallet's own records, such
 *   as a backup of the store, will do once `txidFromRawTx` of it is `txid`,
 *   compared case-insensitively.
 *
 *   The txid may be the damaged field instead, while the hex is the
 *   transaction that was sent, so that `getTxHex(txid)` cannot find it. Then
 *   look up the hex's own txid, `txidFromRawTx` of it, with `getTxHex`, and
 *   only if the indexer returns that same transaction, give the record that
 *   txid, as `PaymentStore` says. Never trust the hex alone: it may be an
 *   older payment that is still valid, which resubmitting would pay again.
 *   Otherwise, the wallet knows neither the transaction's inputs nor, unless
 *   the hex is that transaction, its txid: keep the record, ask again later,
 *   and failing that, take the last way out below, a transfer of every
 *   confirmed output to the wallet itself.
 *
 *   While no indexer knows the transaction, so that `getTxHex` answers
 *   `not_found`, and the wallet has no record of its inputs, the wallet must
 *   not clear the record: not knowing which outputs the transaction spends,
 *   it cannot tell which ones a new payment may spend without paying twice.
 *   This example's store keeps no such record: a `SignatureRecord` names an
 *   input by its index, not by the output it spends. Keep the record, and
 *   ask again later, or ask other indexers. Only the proof this call checks
 *   allows clearing it, and since this call refuses the record, the wallet
 *   must check that proof itself before it drops the record: it knows the
 *   transaction's inputs, the indexer does not know the transaction, and
 *   every input is still among the address's unspent outputs. Then, as after
 *   this call, the only safe follow-up is a replacement that spends those
 *   same inputs. Without its inputs, one way out remains: move every
 *   confirmed output the address holds to the wallet itself, in one or more
 *   transactions the wallet tracks outside this example's single pending
 *   record, and wait until they confirm. This example's payments spend only
 *   the address's own confirmed outputs, so the lost transaction can spend
 *   only those that are still unspent, and once all of them are spent it can
 *   never confirm, and the record can be cleared. A transfer to
 *   the wallet itself pays no one: if the lost transaction confirms first,
 *   the transfer is refused instead, and `getTxHex` then finds it.
 * - `known`: the indexer knows the transaction, in its mempool or in a block,
 *   so it is not stuck: settle it with `reconcileBroadcast`.
 * - `too_many_utxos`: the backend refuses to list `address`'s unspent outputs,
 *   as for `sendPayment`'s `too_many_utxos`: qbit-electrs above its
 *   `--utxos-limit`, recognized by the same status and body, so the inputs
 *   cannot be checked. Raise the backend's `--utxos-limit`, or call this with
 *   a backend that lists them all.
 * - `invalid_utxos`: the backend's UTXO list is malformed or lists an outpoint twice.
 * - `inputs_spent`: an input is not among the address's unspent outputs. The
 *   transaction, or another one that spends the same output, may be in a
 *   block or in a mempool.
 */
export type AbandonPaymentErrorCode =
  'invalid_options' | 'not_pending' | 'corrupt_pending' | 'known' | 'too_many_utxos' | 'invalid_utxos' | 'inputs_spent'

export class AbandonPaymentError extends Error {
  readonly code: AbandonPaymentErrorCode
  /** The transaction it was asked to release. */
  readonly txid: string

  constructor(code: AbandonPaymentErrorCode, message: string, txid: string) {
    super(message)
    this.name = 'AbandonPaymentError'
    this.code = code
    this.txid = txid
  }
}

/**
 * Release a pending transaction that no node will take any more, so that the
 * wallet can replace it. The example never calls it: call it on purpose, when
 * for example the node accepted the transaction, later evicted it from its
 * mempool, and now refuses every resubmission of the same hex because its
 * mempool asks a higher fee than it pays ("mempool min fee not met"). Until
 * then `sendPayment` refuses to pay with `pending`, and `reconcileBroadcast`
 * never settles.
 *
 * It releases `txid` from `store` only when the indexer does not know it
 * (`getTx` answers `not_found`) and every one of its inputs is still among
 * `address`'s unspent outputs, which qbit-electrs lists without any output a
 * transaction in its mempool spends. It resolves with those outputs, in the
 * transaction's input order. Otherwise it rejects with an
 * `AbandonPaymentError`, or with a `QbitApiError` when a lookup fails (`parse`
 * when `getTx` answers with anything but the transaction), and releases nothing.
 *
 * Releasing it does not unsend it. The indexer can lag its node, and a node
 * that still holds a copy can relay or mine it, so the abandoned transaction
 * may yet confirm. The only safe follow-up is a replacement that spends the
 * **same** inputs, the outputs this resolves with, at a higher fee rate (a fee
 * bump): the two conflict, so at most one of them can confirm. Build it as
 * `sendPayment` builds its transaction, from exactly these outputs, then store
 * and broadcast it the same way. Never pay with a transaction built from
 * different inputs, such as a new `sendPayment` call, which picks its own: if
 * the abandoned transaction confirms as well, the recipient is paid twice.
 */
export async function abandonPendingPayment(params: {
  client: EsploraClient
  /** The address the payment spends from: `p2mrAddressFromPubkey(key.pk32, 'regtest')`. */
  address: string
  store: PaymentStore
  /** The pending transaction to release, as `store.pendingTransaction()` names it. */
  txid: string
  /** One budget for both lookups, at most 2,147,483,647 ms. */
  deadlineMs: number
  signal: AbortSignal
}): Promise<EsploraUtxo[]> {
  const { client, address, store, txid, signal } = params
  if (!isTimerDelay(params.deadlineMs)) {
    throw new AbandonPaymentError(
      'invalid_options',
      `deadlineMs must be a number above 0 and at most ${MAX_TIMER_MS}, not ${String(params.deadlineMs)}`,
      txid
    )
  }
  const end = Date.now() + params.deadlineMs
  const rawTxHex = pendingHex(store, txid)

  // The indexer must not know the transaction. Any failure but not_found
  // proves nothing, and neither does a reply that is not this transaction.
  const known = await lookUpTx(client, txid, { signal, deadlineMs: msLeft(end) }).then(
    () => true,
    (error: unknown) => {
      if (QbitApiError.is(error) && error.kind === 'not_found') return false
      throw error
    }
  )
  if (known) {
    throw new AbandonPaymentError(
      'known',
      `the indexer knows transaction ${txid}: settle it with reconcileBroadcast`,
      txid
    )
  }

  // Every input must be unspent. The client has no outspend lookup, but this
  // example spends only `address`'s outputs, and its UTXO list leaves out any
  // output spent in a block or by a transaction in the indexer's mempool.
  const rows = await scanUtxos(
    client,
    address,
    { signal, deadlineMs: msLeft(end) },
    (code, message) => new AbandonPaymentError(code, message, txid)
  )
  const unspent = new Map(rows.map(utxo => [`${utxo.txid.toLowerCase()}:${utxo.vout}`, utxo]))
  const inputs = spentOutpoints(rawTxHex).map(outpoint => {
    const utxo = unspent.get(outpoint)
    if (utxo === undefined) {
      throw new AbandonPaymentError(
        'inputs_spent',
        `input ${outpoint} of transaction ${txid} is not among ${address}'s unspent outputs`,
        txid
      )
    }
    return utxo
  })

  // Release only the transaction these lookups checked, with no await in between.
  pendingHex(store, txid)
  store.dropTransaction(txid)
  return inputs
}

/** Throws a `SendPaymentError` for a parameter that could pay the wrong amount or fee, or never settle. */
function checkParams({ amountSats, feeRate, deadlineMs, pollMs, signal }: SendPaymentParams): void {
  // A NaN or infinite fee rate would reach BigInt() as a bare RangeError, a
  // rate below Core's minimum relay fee would make a transaction no node
  // relays, and a rate above the wallet's ceiling, from a typo or a hostile
  // fee source, would overpay.
  if (!Number.isFinite(feeRate) || feeRate < MIN_RELAY_FEE_RATE || feeRate > WALLET_MAX_FEE_RATE) {
    throw new SendPaymentError(
      'invalid_fee_rate',
      `feeRate must be at least ${MIN_RELAY_FEE_RATE}, qbit Core's minimum relay fee rate, and at most ${WALLET_MAX_FEE_RATE} sat/vB, not ${String(feeRate)}`
    )
  }
  if (typeof amountSats !== 'bigint' || amountSats < DUST_THRESHOLD_SATS) {
    throw new SendPaymentError(
      'invalid_amount',
      `amountSats must be a bigint of at least ${DUST_THRESHOLD_SATS}, the dust threshold, not ${String(amountSats)}`
    )
  }
  checkDelay('deadlineMs', deadlineMs)
  if (pollMs !== undefined) checkDelay('pollMs', pollMs)
  checkSignal(signal)
}

/** Throws an `invalid_options` SendPaymentError unless `signal` is an AbortSignal. */
function checkSignal(signal: AbortSignal): void {
  // Anything else would fail only once the work it should cancel has started.
  if (!(signal instanceof AbortSignal)) {
    throw new SendPaymentError('invalid_options', 'signal must be an AbortSignal')
  }
}

/** Throws an `invalid_options` SendPaymentError naming option `name` unless `ms` is a delay a timer can wait. */
function checkDelay(name: string, ms: number): void {
  // A timer fires at once for a longer delay than MAX_TIMER_MS, and the
  // client refuses such a deadline with an `http` error.
  if (!isTimerDelay(ms)) {
    throw new SendPaymentError(
      'invalid_options',
      `${name} must be a number above 0 and at most ${MAX_TIMER_MS}, not ${String(ms)}`
    )
  }
}

/** Whether `ms` is a delay a timer can wait, and the client accepts as `deadlineMs`. */
function isTimerDelay(ms: number): boolean {
  return Number.isFinite(ms) && ms > 0 && ms <= MAX_TIMER_MS
}

/** The fee for `inputs` inputs and `outputs` outputs at `feeRate`, rounded up. */
function feeFor(inputs: number, outputs: number, feeRate: number): bigint {
  return BigInt(Math.ceil((OVERHEAD_BYTES + inputs * INPUT_BYTES + outputs * OUTPUT_BYTES) * feeRate))
}

/**
 * The outputs to spend: the largest first, until they cover `amountSats` and
 * the fee without change. An output worth no more than the fee to spend it
 * would only lower what the payment can send, so it is never spent, whatever
 * order a wallet picks outputs in. Throws a
 * `SendPaymentError` when they cannot cover the payment, or can only with more
 * than `MAX_INPUTS` inputs, before any lookup.
 *
 * Nor does it spend a coinbase output with fewer than `COINBASE_SPEND_DEPTH`
 * confirmations, counted from `tipHeight`. The UTXO rows do not say which
 * outputs a coinbase made, so `isCoinbase` looks up the funding transaction of
 * each output it reaches that has fewer, or whose row has no usable block
 * height: one at a time, once per transaction, and at most `MAX_INPUTS`
 * transactions. Such an output whose funding transaction it did not look up
 * counts as unspendable. When the outputs left cannot cover the payment with
 * at most `MAX_INPUTS` inputs, it throws `immature_funds`.
 */
async function selectInputs(
  utxos: EsploraUtxo[],
  amountSats: bigint,
  feeRate: number,
  tipHeight: number,
  isCoinbase: (txid: string) => Promise<boolean>
): Promise<EsploraUtxo[]> {
  // Confirmations, or 0 when the row gives no usable block height.
  const depth = ({ status: { block_height: height } }: EsploraUtxo) =>
    height !== undefined && Number.isSafeInteger(height) && height >= 0 ? tipHeight - height + 1 : 0
  // The older of two equal outputs first: it is likelier to need no lookup.
  const worthSpending = utxos
    .filter(utxo => utxo.value > INPUT_BYTES * feeRate)
    .sort((a, b) => b.value - a.value || depth(b) - depth(a))
  const covers = (inputs: number, totalSats: bigint) => totalSats - amountSats >= feeFor(inputs, 1, feeRate)
  /**
   * The outputs worth spending that `spendable` allows, in order, until they
   * cover the payment or `cap` of them are taken, and whether they cover it.
   * `spendable` is asked only about the outputs the walk reaches.
   */
  const walk = async (cap: number, spendable: (utxo: EsploraUtxo) => boolean | Promise<boolean>) => {
    const selected: EsploraUtxo[] = []
    let totalSats = 0n
    for (const utxo of worthSpending) {
      if (covers(selected.length, totalSats) || selected.length === cap) break
      if (!(await spendable(utxo))) continue
      selected.push(utxo)
      totalSats += BigInt(utxo.value)
    }
    return { selected, covered: covers(selected.length, totalSats) }
  }

  // First as if every output could be spent, which takes no request: if they
  // cannot pay even then, no output maturing would help.
  const unfiltered = await walk(Infinity, () => true)
  if (!unfiltered.covered) {
    throw new SendPaymentError('insufficient_funds', 'insufficient confirmed funds')
  }
  if (unfiltered.selected.length > MAX_INPUTS) {
    throw new SendPaymentError(
      'too_many_inputs',
      `the payment needs ${unfiltered.selected.length} confirmed outputs, and a standard transaction spends at most ${MAX_INPUTS}: consolidate them first`
    )
  }

  // Then the same without the coinbase outputs it does not spend yet, and with
  // at most MAX_INPUTS inputs.
  /** Whether a coinbase made each funding transaction looked up, by lowercase txid. */
  const coinbase = new Map<string, boolean>()
  let unchecked = false
  const { selected, covered } = await walk(MAX_INPUTS, async utxo => {
    if (depth(utxo) >= COINBASE_SPEND_DEPTH) return true
    const txid = utxo.txid.toLowerCase()
    if (!coinbase.has(txid)) {
      // At most one lookup for each input a payment can spend, so that only
      // coinbase outputs in the way can use them up.
      if (coinbase.size === MAX_INPUTS) {
        unchecked = true // counts as unspendable
        return false
      }
      coinbase.set(txid, await isCoinbase(txid))
    }
    return coinbase.get(txid) === false // unless a coinbase made it, which is not mature yet
  })
  if (!covered) {
    throw new SendPaymentError(
      'immature_funds',
      unchecked
        ? `the payment needs outputs with fewer than ${COINBASE_SPEND_DEPTH} confirmations that are coinbase outputs, which it does not spend yet, or that it did not check, since it looks up at most ${MAX_INPUTS} funding transactions: wait for more blocks`
        : `the payment needs coinbase outputs with fewer than ${COINBASE_SPEND_DEPTH} confirmations, which it does not spend yet: wait for more blocks`
    )
  }
  return selected
}

/**
 * Throws a `SendPaymentError` while `store` holds a transaction that is still
 * pending: `corrupt_pending` when the hex it holds for it is not that
 * transaction, which `reconcileBroadcast` refuses too, and `pending`
 * otherwise.
 */
function refuseWhilePending(store: PaymentStore): void {
  const pending = store.pendingTransaction()
  if (pending === undefined) return
  if (!isHexOf(pending.rawTxHex, pending.txid)) {
    throw new SendPaymentError('corrupt_pending', corruptRecord(pending.txid), pending.txid)
  }
  throw new SendPaymentError('pending', `transaction ${pending.txid} is still pending`, pending.txid)
}

/**
 * The hex `store` holds for its pending transaction `txid`. Throws a
 * `not_pending` AbandonPaymentError when it holds no pending transaction
 * `txid`, and `corrupt_pending` when the hex it holds for it is not that
 * transaction.
 */
function pendingHex(store: PaymentStore, txid: string): string {
  const pending = store.pendingTransaction()
  if (pending === undefined || pending.txid !== txid) {
    throw new AbandonPaymentError('not_pending', `transaction ${txid} is not pending`, txid)
  }
  if (!isHexOf(pending.rawTxHex, txid)) throw new AbandonPaymentError('corrupt_pending', corruptRecord(txid), txid)
  return pending.rawTxHex
}

/** The message for a pending transaction `txid` whose stored hex is not that transaction. */
function corruptRecord(txid: string): string {
  return `transaction ${txid} is still pending, but the hex stored for it is not that transaction: restore the record as PaymentStore says, with getTxHex(txid) or from the wallet's own records, and never treat it as nothing pending`
}

/** Whether `rawTxHex` is the whole transaction `txid`, which compares case-insensitively. */
function isHexOf(rawTxHex: string, txid: string): boolean {
  return txidOf(rawTxHex) === String(txid).toLowerCase()
}

/** `txidFromRawTx(rawTxHex)`, or undefined when `rawTxHex` is not a whole transaction. */
function txidOf(rawTxHex: string): string | undefined {
  try {
    return txidFromRawTx(rawTxHex)
  } catch {
    return undefined
  }
}

/**
 * `address`'s unspent outputs, from `getAddressUtxos`, once `checkedUtxos`
 * has checked the rows, for `sendPayment` and `abandonPendingPayment` alike.
 * Throws what `refuse` returns: with `too_many_utxos` when qbit-electrs refuses
 * to list them because there are more than its `--utxos-limit`, which is an
 * `http` error for a 400 whose body starts "Too many unspent transaction
 * outputs", and with `invalid_utxos` for rows `checkedUtxos` refuses. Any
 * other failure of the request is the client's `QbitApiError`, unchanged.
 */
async function scanUtxos(
  client: EsploraClient,
  address: string,
  options: RequestOptions,
  refuse: (code: 'too_many_utxos' | 'invalid_utxos', message: string) => Error
): Promise<EsploraUtxo[]> {
  let rows: unknown
  try {
    rows = await client.getAddressUtxos(address, options)
  } catch (error) {
    const body =
      QbitApiError.is(error) && error.kind === 'http' && error.status === 400 ? error.responseBody : undefined
    if (body === undefined || !body.startsWith('Too many unspent transaction outputs')) throw error
    throw refuse(
      'too_many_utxos',
      `the backend refuses to list the unspent outputs of ${address}, which has more than it lists for one address ("${body}"): raise its --utxos-limit, or use a backend that lists them all`
    )
  }
  return checkedUtxos(rows, message => refuse('invalid_utxos', message))
}

/**
 * The outputs a transaction spends, as `txid:vout` with the txid as explorers
 * show it. `txidFromRawTx` has already checked that the hex is one whole
 * transaction: version, the witness marker and flag if present, the input
 * count, then each input's outpoint, scriptSig and sequence.
 */
function spentOutpoints(rawTxHex: string): string[] {
  const bytes = hexToBytes(rawTxHex)
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  let at = 4
  const compactSize = () => {
    const first = bytes[at]!
    const width = first < 0xfd ? 0 : first === 0xfd ? 2 : 4 // never 0xff: no count exceeds 0x02000000
    const value = width === 0 ? first : width === 2 ? view.getUint16(at + 1, true) : view.getUint32(at + 1, true)
    at += 1 + width
    return value
  }
  if (bytes[at] === 0) at += 2
  return Array.from({ length: compactSize() }, () => {
    const outpoint = `${bytesToHex(bytes.slice(at, at + 32).reverse())}:${view.getUint32(at + 32, true)}`
    at += 36
    const scriptSigBytes = compactSize()
    at += scriptSigBytes + 4
    return outpoint
  })
}

/**
 * `rows` once every row has a 64-hex txid, a uint32 vout and a value that is
 * a non-negative safe integer, and no outpoint repeats; otherwise throws what
 * `refuse` returns. The client does not validate this endpoint's rows, JSON
 * cannot carry amounts above 2^53 exactly, and an outpoint listed twice would
 * count its value twice.
 */
function checkedUtxos(rows: unknown, refuse: (message: string) => Error): EsploraUtxo[] {
  if (!Array.isArray(rows)) throw refuse('backend sent a UTXO list that is not an array')
  const outpoints = new Set<string>()
  rows.forEach((row: Partial<EsploraUtxo> | null, index) => {
    const { txid, vout, value } = row ?? {}
    const unusable = (field: string) => refuse(`backend sent an unusable ${field} in UTXO row ${index}`)
    if (typeof txid !== 'string' || !/^[0-9a-f]{64}$/i.test(txid)) throw unusable('txid')
    if (typeof vout !== 'number' || !Number.isInteger(vout) || vout < 0 || vout > 0xffff_ffff) throw unusable('vout')
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw unusable('value')
    const outpoint = `${txid.toLowerCase()}:${vout}`
    if (outpoints.has(outpoint)) throw refuse(`backend listed outpoint ${outpoint} twice`)
    outpoints.add(outpoint)
  })
  return rows as EsploraUtxo[]
}

/**
 * Look `txid` up with `getTx`, and resolve with the reply only when it is that
 * transaction: an object whose `txid` is `txid`, compared case-insensitively.
 * The client returns the reply as parsed, without checking which transaction
 * it is, so a broken backend or proxy that answers any JSON would otherwise
 * pass for an indexer that knows the transaction. Throws a `parse`
 * QbitApiError for any other reply, as `getTxHex` does for another
 * transaction's hex, and the client's error, such as `not_found`, when the
 * lookup fails.
 */
async function lookUpTx(client: EsploraClient, txid: string, options: RequestOptions): Promise<object> {
  const tx: unknown = await client.getTx(txid, options)
  if (typeof tx === 'object' && tx !== null && 'txid' in tx && typeof tx.txid === 'string') {
    if (tx.txid.toLowerCase() === txid.toLowerCase()) return tx
  }
  throw new QbitApiError('parse', `the reply to the lookup of transaction ${txid} is not that transaction`)
}

/**
 * The chain's height, from `getTipHeight`, which checks only that the reply is
 * an integer. Throws a `parse` QbitApiError for a height that is negative, or
 * too large, which would make a young coinbase output look mature.
 */
async function checkedTipHeight(client: EsploraClient, options: RequestOptions): Promise<number> {
  const height = await client.getTipHeight(options)
  if (!Number.isSafeInteger(height) || height < 0) {
    throw new QbitApiError('parse', `the backend sent tip height ${height}, which is not a block height`)
  }
  return height
}

/**
 * Whether `txid` is a coinbase transaction, from `lookUpTx`: its first input's
 * `is_coinbase`. Throws a `parse` QbitApiError when the reply does not say.
 */
async function isCoinbaseTx(client: EsploraClient, txid: string, options: RequestOptions): Promise<boolean> {
  const tx = await lookUpTx(client, txid, options)
  const first: unknown = 'vin' in tx && Array.isArray(tx.vin) ? tx.vin[0] : undefined
  const flag = typeof first === 'object' && first !== null && 'is_coinbase' in first ? first.is_coinbase : undefined
  if (typeof flag !== 'boolean') {
    throw new QbitApiError(
      'parse',
      `the reply to the lookup of transaction ${txid} does not say whether it is a coinbase`
    )
  }
  return flag
}

/**
 * Milliseconds left before `end`, the payment's single deadline. Once it has
 * passed, throws a `timeout` QbitApiError, as the client's own calls do.
 */
function msLeft(end: number): number {
  const left = end - Date.now()
  if (left <= 0) throw deadlinePassed()
  return left
}

/**
 * The budget of a broadcast request, with `left` ms before the deadline, when
 * a later one must still have time: all but a poll interval, or half of
 * `left` in the final stretch. `sendPayment`'s first broadcast, round 0, and
 * every request of `reconcileBroadcast` but the last round's resubmission get
 * this one rule. It is continuous in the time left and never less than half
 * of it, and it leaves the request after it a poll interval, or half of what
 * is left. Callers pass `msLeft(end)`, which throws once the deadline has
 * passed, or a time left they have already found to be at least two poll
 * intervals.
 */
function requestBudgetMs(left: number, pollMs: number): number {
  return finalStretch(left, pollMs) ? left / 2 : left - pollMs
}

/**
 * Whether `left` ms are the final stretch before the deadline: less than two
 * poll intervals, too few to poll again after the next. It is the broadcast
 * schedule's one rule. Then a round of `reconcileBroadcast` waits half of what
 * is left instead of a poll interval, `requestBudgetMs` gives a request half
 * of it instead of all but a poll interval, and a round whose lookup ends in
 * it is the last.
 */
function finalStretch(left: number, pollMs: number): boolean {
  return left < 2 * pollMs
}

/** The `timeout` QbitApiError for a payment whose deadline passed. */
function deadlinePassed(): QbitApiError {
  return new QbitApiError('timeout', 'the payment deadline passed')
}

/**
 * The `aborted` QbitApiError for a payment that `signal` cancelled, as the
 * client's own calls reject with: its `cause` is the signal's reason.
 */
function cancelled(signal: AbortSignal): QbitApiError {
  return new QbitApiError('aborted', 'the payment was cancelled', { cause: signal.reason })
}

/** Throws the `aborted` QbitApiError `cancelled` returns once `signal` has aborted. */
function throwIfCancelled(signal: AbortSignal): void {
  if (signal.aborted) throw cancelled(signal)
}

/**
 * Settle as the promise `start()` returns does, unless `end` passes or
 * `signal` aborts first: then reject with the `timeout` QbitApiError `msLeft`
 * throws, or with the `aborted` one `cancelled` returns. If `start` throws, it
 * rejects with that error instead of throwing. Only the wait stops, not the
 * work behind the promise, and a rejection that comes after the wait stopped
 * is handled here, never left unhandled. Cleans up its timer and listener
 * either way.
 */
function waitWithin<T>(start: () => Promise<T>, end: number, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const settle = (finish: () => void) => {
      clearTimeout(timer)
      signal.removeEventListener('abort', onAbort)
      finish()
    }
    const onAbort = () => settle(() => reject(cancelled(signal)))
    // The listener, then the timer, then the work, whose outcome is handled at
    // once: a throw rejects the wait, and leaves nothing started without a
    // handler, and no timer or listener behind.
    signal.addEventListener('abort', onAbort)
    const timer = setTimeout(() => settle(() => reject(deadlinePassed())), end - Date.now())
    try {
      start().then(
        value => settle(() => resolve(value)),
        (error: unknown) => settle(() => reject(error))
      )
    } catch (error) {
      settle(() => reject(error))
    }
    if (signal.aborted) onAbort()
  })
}

/** Wait `ms`, or less if `signal` aborts. Cleans up its timer and listener either way. */
function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise(resolve => {
    const done = () => {
      clearTimeout(timer)
      signal.removeEventListener('abort', done)
      resolve()
    }
    const timer = setTimeout(done, ms)
    signal.addEventListener('abort', done)
  })
}

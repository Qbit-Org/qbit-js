import { QbitProtocolError } from './errors'
import type { QbitNetworkName } from './networks'
import { QBIT_MAX_MONEY } from './consensus'
import { decodeP2mrAddress } from './addresses'

/**
 * A parsed `qbit:` payment URI, as {@link parseQbitUri} returns it.
 *
 * @remarks
 * See [qbit Payment URIs](https://github.com/Qbit-Org/qbit-js/blob/main/packages/protocol/docs/qbit-uri.md).
 *
 * @category URIs
 */
export interface ParsedQbitUri {
  /**
   * The address as written, minus one trailing `/`. It can be uppercase, as
   * Core's GUI writes it, so lowercase it before comparing it with stored
   * addresses.
   */
  address: string
  /**
   * The address's network, from its HRP: a `tq` address reads as `'testnet4'`
   * unless `'signet'` is the expected network.
   */
  network: QbitNetworkName
  /**
   * The amount from `amount` or `req-amount`, in QBT (not satoshis), as
   * decoded: `0` or digits without a leading zero, optionally followed by `.`
   * and 1 to 8 digits, and at most 210,000,000.
   */
  amount?: string
  /**
   * The decoded `label` or `req-label`. Untrusted text that can hold control
   * characters, so escape it before showing or logging it.
   */
  label?: string
  /** The decoded `message` or `req-message`, with the same caveat as `label`. */
  message?: string
  /**
   * Every decoded key/value pair in URI order, keys as written, including
   * unknown keys such as `pj`. Read the payment fields from `amount`, `label`
   * and `message`, and do not reuse `params.toString()` as a URI query: it
   * writes a space as `+`.
   */
  params: URLSearchParams
}

/**
 * Fields for {@link formatQbitUri}.
 *
 * @remarks
 * See [qbit Payment URIs](https://github.com/Qbit-Org/qbit-js/blob/main/packages/protocol/docs/qbit-uri.md).
 *
 * @category URIs
 */
export interface QbitUriFields {
  /** A P2MR address on any qbit network. It is validated and written as given. */
  address: string
  /**
   * The amount in QBT (not satoshis), written as given: `0` or digits without
   * a leading zero, optionally followed by `.` and 1 to 8 digits, and at most
   * 210,000,000.
   */
  amount?: string
  /** The label, percent-encoded. `undefined` omits it; `''` writes `label=`. */
  label?: string
  /** The message, percent-encoded. `undefined` omits it; `''` writes `message=`. */
  message?: string
}

/**
 * Parse a BIP21 `qbit:` payment URI.
 *
 * Follows qbit Core's GUI parser (`src/qt/guiutil.cpp` `parseBitcoinURI`, v1.0.0
 * `:156-221`) except where noted, and fails closed where Core is lenient:
 *
 * - The `qbit:` scheme matches case-insensitively, so the QR alphanumeric form
 *   `QBIT:QB1…` is accepted. `bitcoin:` and `qbit://` are rejected in any case with
 *   `WRONG_URI_SCHEME`.
 * - One trailing `/` after the address is dropped. Otherwise `address` is returned
 *   as written, so an uppercase address stays uppercase.
 * - A `#` anywhere throws `INVALID_URI`. Core's `QUrl` treats it as the start of a
 *   fragment and never reads the parameters after it, so `?label=x#&amount=1000`
 *   has no amount in Core.
 * - The query is split on `&` (empty segments are skipped) and each segment on its
 *   first `=`. Keys and values are percent-decoded per RFC 3986: `+` is a literal
 *   plus, not a space. A malformed escape (`%ZZ`, a truncated or invalid UTF-8
 *   sequence) throws `INVALID_URI`.
 * - `req-amount`, `req-label` and `req-message` are read as `amount`, `label` and
 *   `message`. Any other `req-` parameter throws `INVALID_URI`, as BIP21 requires.
 * - `amount`, `label` or `message` given more than once, counting its `req-` form,
 *   throws `INVALID_URI`. Core keeps the last value and `URLSearchParams.get` the
 *   first; rejecting means qbit-js never has to pick one of two amounts.
 * - `amount` must be a QBT amount written as `0` or digits without a leading
 *   zero, optionally followed by `.` and 1 to 8 digits, so `.5`, `1.` and `01`
 *   throw `INVALID_URI`. It must be at most `QBIT_MAX_MONEY` (210,000,000 QBT),
 *   the cap Core's amount field enforces (`bitcoinamountfield.cpp:171`), so
 *   `210000000.00000001` throws `INVALID_URI`.
 *   An empty `amount=` throws `INVALID_URI`, although Core reads it as no amount.
 * - Parameter names are case-sensitive, as in Core and BIP21. BIP321 makes them
 *   case-insensitive, so a name that case-folds to `amount`, `label`, `message` or
 *   `req-…` but is not written in lowercase ASCII (`AMOUNT=5`, `Label`,
 *   `REQ-expires`, `meſſage`) throws `INVALID_URI`. Core ignores it, but a BIP321
 *   reader would use it. Other parameters without `req-` are ignored.
 *
 * `params` holds every decoded key/value pair in URI order, with keys as written
 * (`req-amount` stays `req-amount`). Read the payment fields from `amount`, `label`
 * and `message`.
 *
 * Behaviour change in 0.1.0: `+` used to decode as a space, `%ZZ` was
 * kept as literal text, a `req-` parameter was ignored, a duplicate used its
 * first value, text after `#` was read as part of the last parameter, a case
 * variant such as `AMOUNT` or `REQ-expires` was ignored, an amount above
 * `QBIT_MAX_MONEY` was accepted, and `QBIT:` or a trailing `/` was rejected.
 *
 * @param uri - The URI.
 * @param expectedNetwork - If given, the address must belong to this network.
 * @returns The address, its network, the payment fields and every parameter.
 * @throws {QbitProtocolError} `WRONG_URI_SCHEME` unless the URI starts with
 * `qbit:` (in any case) and not `qbit://`.
 * @throws {QbitProtocolError} `INVALID_URI` for an empty address or any of the
 * cases above.
 * @throws {QbitProtocolError} Any code {@link decodeP2mrAddress} throws for
 * the address.
 *
 * @remarks
 * `amount` is a QBT decimal string, not satoshis. See
 * [qbit Payment URIs](https://github.com/Qbit-Org/qbit-js/blob/main/packages/protocol/docs/qbit-uri.md).
 *
 * @example
 * ```ts
 * import { parseQbitUri } from '@qbit-oss/protocol'
 *
 * const uri = parseQbitUri(
 *   'qbit:qbrt1zzasx2u2z7v9kn4q8e66r57mfw08xvrvdcqfcq6xfte0eau9dgdgqz42zd5?amount=0.5&label=Coffee%20shop',
 *   'regtest'
 * )
 * // uri.amount: '0.5' (QBT), uri.label: 'Coffee shop', uri.network: 'regtest'
 * ```
 *
 * @category URIs
 */
export function parseQbitUri(uri: string, expectedNetwork?: QbitNetworkName): ParsedQbitUri {
  // Schemes compare case-insensitively (guiutil.cpp:160,216).
  if (/^bitcoin:/i.test(uri)) {
    throw new QbitProtocolError('WRONG_URI_SCHEME', 'bitcoin: URIs are not valid qbit URIs')
  }
  if (/^qbit:\/\//i.test(uri)) {
    throw new QbitProtocolError('WRONG_URI_SCHEME', 'qbit URI scheme is qbit:, not qbit://')
  }
  if (!/^qbit:/i.test(uri)) {
    throw new QbitProtocolError('WRONG_URI_SCHEME', 'qbit URI must start with qbit:')
  }
  // Core's QUrl ends the query at the first '#', so Core never reads parameters
  // after it (guiutil.cpp:172-173); BIP21 and BIP321 define no fragment. Reject
  // it rather than read an amount that Core does not see.
  if (uri.includes('#')) {
    throw new QbitProtocolError('INVALID_URI', 'qbit URI must not contain a # fragment')
  }

  const body = uri.slice('qbit:'.length)
  const separator = body.indexOf('?')
  let address = separator === -1 ? body : body.slice(0, separator)
  const query = separator === -1 ? '' : body.slice(separator + 1)
  // Trim one trailing slash the OS may have added (guiutil.cpp:166-169).
  if (address.endsWith('/')) address = address.slice(0, -1)
  if (address.length === 0) {
    throw new QbitProtocolError('INVALID_URI', 'qbit URI is missing an address')
  }

  const decoded = decodeP2mrAddress(address, expectedNetwork)
  const params = new URLSearchParams()
  const fields: Pick<ParsedQbitUri, QbitUriFieldName> = {}
  for (const segment of query.split('&')) {
    if (segment.length === 0) continue
    const equals = segment.indexOf('=')
    const key = decodeQbitUriComponent(equals === -1 ? segment : segment.slice(0, equals))
    const value = decodeQbitUriComponent(equals === -1 ? '' : segment.slice(equals + 1))
    params.append(key, value)
    const field = qbitUriFieldName(key)
    if (field === undefined) continue
    if (fields[field] !== undefined) {
      throw new QbitProtocolError('INVALID_URI', `qbit URI repeats the ${field} parameter`)
    }
    fields[field] = value
  }
  if (fields.amount !== undefined && !isValidQbtAmount(fields.amount)) {
    throw new QbitProtocolError('INVALID_URI', 'invalid qbit URI amount')
  }

  return { address, network: decoded.network, params, ...fields }
}

/**
 * Format a BIP21 `qbit:` payment URI with parameters in the order amount, label,
 * message.
 *
 * `label` and `message` are percent-encoded like Core's `QUrl::toPercentEncoding`
 * (`src/qt/guiutil.cpp:238,245`): every character except the RFC 3986 unreserved set
 * `A-Z a-z 0-9 - . _ ~` is escaped, so a space becomes `%20`. Text that is not
 * well-formed Unicode (a lone surrogate) throws `INVALID_URI`. Unlike Core, the
 * address is emitted as given, and an empty label or message is still emitted.
 * `amount` must be a QBT amount written as `0` or digits without a leading
 * zero, optionally followed by `.` and 1 to 8 digits, and at most
 * `QBIT_MAX_MONEY` (210,000,000 QBT), or it throws `INVALID_URI`.
 *
 * Behaviour change in 0.1.0: a space used to be emitted as `+`, which Core
 * shows as a literal plus, a lone surrogate was replaced with U+FFFD, and an
 * amount above `QBIT_MAX_MONEY` was emitted.
 *
 * @param fields - The address and the optional amount (in QBT), label and
 * message.
 * @returns The URI.
 * @throws {QbitProtocolError} `INVALID_URI` for an invalid amount or a label
 * or message with a lone surrogate.
 * @throws {QbitProtocolError} Any code {@link decodeP2mrAddress} throws for
 * the address.
 *
 * @remarks
 * {@link parseQbitUri} reads the result back with the same address, amount,
 * label and message. See
 * [qbit Payment URIs](https://github.com/Qbit-Org/qbit-js/blob/main/packages/protocol/docs/qbit-uri.md).
 *
 * @example
 * ```ts
 * import { formatQbitUri } from '@qbit-oss/protocol'
 *
 * formatQbitUri({
 *   address: 'qbrt1zzasx2u2z7v9kn4q8e66r57mfw08xvrvdcqfcq6xfte0eau9dgdgqz42zd5',
 *   amount: '0.5', // QBT
 *   label: 'Coffee shop',
 *   message: '1+1=2',
 * })
 * // 'qbit:qbrt1zzasx2u2z7v9kn4q8e66r57mfw08xvrvdcqfcq6xfte0eau9dgdgqz42zd5?amount=0.5&label=Coffee%20shop&message=1%2B1%3D2'
 * ```
 *
 * @category URIs
 */
export function formatQbitUri(fields: QbitUriFields): string {
  decodeP2mrAddress(fields.address)
  const query: string[] = []
  if (fields.amount !== undefined) {
    if (!isValidQbtAmount(fields.amount)) {
      throw new QbitProtocolError('INVALID_URI', 'invalid qbit URI amount')
    }
    query.push(`amount=${fields.amount}`)
  }
  if (fields.label !== undefined) query.push(`label=${encodeQbitUriComponent(fields.label)}`)
  if (fields.message !== undefined) query.push(`message=${encodeQbitUriComponent(fields.message)}`)
  return `qbit:${fields.address}${query.length > 0 ? `?${query.join('&')}` : ''}`
}

type QbitUriFieldName = 'amount' | 'label' | 'message'

function qbitUriFieldName(key: string): QbitUriFieldName | undefined {
  // Core and BIP21 match names case-sensitively, so Core ignores AMOUNT=5, but
  // BIP321 readers match case-insensitively and would pay it. Reject the variant.
  // Fold through uppercase as well: ſ and ß are already lowercase, but meſſage
  // and meßage uppercase to MESSAGE. Capital ẞ (U+1E9E) folds only to ß that way,
  // so map ß to ss as Unicode casefolding does.
  const lower = key.toUpperCase().toLowerCase().replace(/ß/g, 'ss')
  if (key !== lower && (lower === 'amount' || lower === 'label' || lower === 'message' || lower.startsWith('req-'))) {
    throw new QbitProtocolError('INVALID_URI', 'qbit URI amount, label, message and req- names must be lowercase ASCII')
  }
  // Core strips req- and accepts it only on amount, label and message
  // (guiutil.cpp:176-206); BIP21 requires rejecting any other req- parameter.
  const required = key.startsWith('req-')
  const name = required ? key.slice('req-'.length) : key
  if (name === 'amount' || name === 'label' || name === 'message') return name
  if (required) {
    throw new QbitProtocolError('INVALID_URI', 'qbit URI has an unsupported req- parameter')
  }
  return undefined
}

function decodeQbitUriComponent(component: string): string {
  try {
    return decodeURIComponent(component)
  } catch {
    throw new QbitProtocolError('INVALID_URI', 'qbit URI has a malformed percent-escape')
  }
}

function encodeQbitUriComponent(text: string): string {
  let encoded: string
  try {
    encoded = encodeURIComponent(text)
  } catch {
    throw new QbitProtocolError('INVALID_URI', 'qbit URI text must be well-formed Unicode')
  }
  // encodeURIComponent leaves !'()* bare; QUrl::toPercentEncoding escapes them.
  return encoded.replace(/[!'()*]/g, char => `%${char.charCodeAt(0).toString(16).toUpperCase()}`)
}

// A QBT decimal with at most 8 fractional digits and at most QBIT_MAX_MONEY, which
// Core's amount field enforces (bitcoinamountfield.cpp:171). The whole part has at
// most 10 digits, as in QbitUnits::parse (qbitunits.cpp:193-196), so BigInt only
// ever reads a short string. Compared in base units, so nothing wraps or rounds.
function isValidQbtAmount(amount: string): boolean {
  const match = /^(0|[1-9][0-9]{0,9})(?:\.([0-9]{1,8}))?$/.exec(amount)
  return match !== null && BigInt(match[1]! + (match[2] ?? '').padEnd(8, '0')) <= QBIT_MAX_MONEY
}

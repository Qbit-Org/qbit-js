// Write a `qbit:` payment request and read one back, with @qbit-oss/protocol.
// See packages/protocol/docs/qbit-uri.md for every rule the parser applies.

import { formatQbitUri, parseQbitUri, QbitProtocolError, type ParsedQbitUri } from '@qbit-oss/protocol'

/** Build a payment request for `address`, for example to show as a QR code. */
export function createPaymentRequest(address: string): string {
  // The amount is a QBT decimal string, never a float. Label and message are
  // percent-encoded: a space becomes %20 and `+` becomes %2B, so neither
  // changes meaning when the URI is read back.
  return formatQbitUri({ address, amount: '0.5', label: 'Coffee shop', message: '1+1=2' })
}

/**
 * Read a payment request someone gave us, refusing anything that is not a
 * well-formed `qbit:` URI for a `regtest` address.
 */
export function readPaymentRequest(
  uri: string
): { ok: true; request: ParsedQbitUri } | { ok: false; code: string; reason: string } {
  try {
    // Passing the network rejects an address from any other network.
    const request = parseQbitUri(uri, 'regtest')
    // The address keeps the case it was written in (Core writes uppercase for
    // denser QR codes), so lowercase it before comparing with stored addresses.
    return { ok: true, request: { ...request, address: request.address.toLowerCase() } }
  } catch (error) {
    // `QbitProtocolError.is` also recognizes errors from another copy of the
    // package, which `instanceof` does not. Anything else is a bug: rethrow it.
    if (!QbitProtocolError.is(error)) throw error
    // WRONG_URI_SCHEME, INVALID_URI, an address code such as WRONG_HRP, or one a newer version added.
    return { ok: false, code: error.code, reason: error.message }
  }
}

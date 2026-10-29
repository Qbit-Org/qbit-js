# qbit Payment URIs (`qbit:`)

How `parseQbitUri` and `formatQbitUri` read and write BIP21-style payment URIs,
and where they differ from qbit Core's GUI.

**Source of truth:** `Qbit-Org/qbit` `v1.0.0`
(`7ebcddb622d6e639041f005a189b048ec2a221fe`), `src/qt/guiutil.cpp`:

- `parseBitcoinURI(const QUrl&, …)`: `guiutil.cpp:156-212`.
- `parseBitcoinURI(QString, …)`, which rejects `qbit://`: `guiutil.cpp:214-221`.
- `formatBitcoinURI(…)`: `guiutil.cpp:223-251`.

Also [BIP21](https://github.com/bitcoin/bips/blob/master/bip-0021.mediawiki),
with RFC 3986 percent-encoding.

## Shape

```
qbit:<address>[/][?<key>=<value>[&<key>=<value>]…]
```

The fields are `amount` (QBT), `label` and `message`. qbit uses only P2MR
addresses, so `<address>` must decode as a P2MR bech32m address. When
`expectedNetwork` is given, the address must also be on that network.

## Parsing (`parseQbitUri`)

| Input | Result | Core GUI |
| --- | --- | --- |
| `qbit:`, `QBIT:`, `Qbit:` | accepted (scheme is case-insensitive) | same (`:160`) |
| `bitcoin:…`, `BITCOIN:…` | `WRONG_URI_SCHEME` | rejected (wrong scheme) |
| `qbit://…`, `QBIT://…` | `WRONG_URI_SCHEME` | rejected (`:216`) |
| `qbit:<addr>/` | the trailing `/` is dropped | same (`:166-169`) |
| `qbit:<addr>//` | address error (only one `/` is dropped) | same |
| `?label=x#&amount=1000`, any `#` | `INVALID_URI` | `#…` is a fragment and is dropped: no amount |
| `label=A+B` | `"A+B"` (`+` is literal) | same (`QUrlQuery`) |
| `label=A%20B` | `"A B"` | same |
| `label=%3F`, `%2B`, `%25` | `"?"`, `"+"`, `"%"` | escape kept as text: `"%3F"` (`uritests.cpp:90-95`) |
| `label=%ZZ`, `label=%FF`, `label=100%` | `INVALID_URI` | lenient |
| `req-amount=5` | `amount: "5"` | same (`:177-181`) |
| `req-label=…`, `req-message=…` | `label`, `message` | same |
| `req-expires=…` or any other `req-` key | `INVALID_URI` | rejected (`:204-205`) |
| `amount=1&amount=1000` | `INVALID_URI` | last value wins (`1000`) |
| `amount=1&req-amount=1000` | `INVALID_URI` | last value wins (`1000`) |
| `label=a&label=b`, `message=a&message=b` | `INVALID_URI` | last value wins |
| `amount=` (empty) or a bare `amount` | `INVALID_URI` | no amount (`:195`) |
| `amount=1.000000001` | `INVALID_URI` | rejected (`:197`) |
| `amount=210000000` | `amount: "210000000"` (`QBIT_MAX_MONEY`) | same |
| `amount=210000000.00000001` | `INVALID_URI` | read, then the send form marks it invalid (`bitcoinamountfield.cpp:171`) |
| `amount=10000000000` (11 or more whole digits) | `INVALID_URI` | rejected (`qbitunits.cpp:193-196`) |
| `AMOUNT=5`, `Label=x`, `REQ-expires=1`, `meſſage=x`, `meßage=x`, `meẞage=x` | `INVALID_URI` | ignored (names are case-sensitive) |
| `pj=…`, `lightning=…`, other unknown keys | ignored, kept in `params` | ignored |

The query is split on `&`, and empty segments are skipped. Each segment is
split on its first `=`, so `message=a=b` gives `"a=b"`, and a segment without `=`
has an empty value. Keys and values are decoded with `decodeURIComponent`.
The case, `req-` and duplicate checks run on the decoded key, so
`%72eq-expires`, `%61mount` and `%41MOUNT` count as `req-expires`, `amount` and
`AMOUNT`.

### Where qbit-js is stricter than Core

qbit-js rejects these URIs that Core's GUI accepts:

- **A `#` fragment.** Core's `QUrl` drops everything after `#`, so it never
  sees a parameter there. Reading it would give a different amount
  (`?label=x#&amount=1000`: Core has no amount). BIP21 and BIP321 define no
  fragment, and `formatQbitUri` escapes `#` as `%23`.
- **Duplicate fields.** Core's loop overwrites, so the last value wins.
  qbit-js rejects the URI. Another parser could take the first value, as
  `URLSearchParams.get` does. Then a checkout validator and the paying wallet
  would read different amounts from the same URI.
- **Case variants of the field names.** Core and BIP21 match names
  case-sensitively, so Core ignores `AMOUNT=5`. BIP321 makes names
  case-insensitive, so a BIP321 wallet pays 5 QBT. qbit-js rejects any name that
  case-folds to `amount`, `label`, `message` or `req-…` but is not written in
  lowercase ASCII. The check folds through uppercase too, so `meſſage` and
  `meßage` (`ſ` and `ß` uppercase to `S` and `SS`) are rejected, and `ß` is mapped to `ss` so `meẞage` (capital `ẞ`) is too. Other names,
  such as `PJ`, are still ignored.
- **Malformed escapes and an empty amount.** A broken `%` escape or an empty
  `amount=` usually comes from a broken generator. Rejecting it is safer than
  guessing at a payment. One stray `%` also stops `QUrl` decoding the rest of
  the query, so Core reads no amount from `?%61mount=5&pj=100%`.
- **Amounts above `QBIT_MAX_MONEY`.** Core's URI parser reads up to 10 whole
  digits (`qbitunits.cpp:193-196`), and the send form then marks anything above
  `MAX_MONEY`, 210,000,000 QBT, invalid (`bitcoinamountfield.cpp:171`). qbit-js
  rejects such a URI, so a backend never stores an amount that wraps or
  overflows. The bound is compared in base units, without floating point.
- **Non-canonical amounts.** `QbitUnits::parse` (`qbitunits.cpp:165-203`) also
  takes `.5`, `1.`, `01`, `+1`, `-1` and `1%20000` (spaces are removed, so
  1000 QBT). qbit-js accepts only `0` or a digit string without a leading zero,
  with an optional `.` and 1-8 digits.
- **A percent-encoded address.** `QUrl` decodes `qbit:%71b1…`; qbit-js does not
  decode the address and rejects it.

### The result

```ts
interface ParsedQbitUri {
  address: string          // as written, minus one trailing '/', may be uppercase
  network: QbitNetworkName // from the address HRP
  amount?: string          // QBT: `0` or digits with no leading zero, then optionally `.` and 1-8 digits; at most 210,000,000 QBT
  label?: string
  message?: string
  params: URLSearchParams  // every decoded pair, in order, keys as written
}
```

`address` keeps its original case. A URI from Core's `formatBitcoinURI` uses an
uppercase bech32 address (`:227`), so lowercase `address` before you compare it
with stored addresses.

`label` and `message` are decoded text from the URI, so they can hold control
characters (`%00`, `%0A`, `%1B`, bidi overrides such as `%E2%80%AE`). Escape or
strip them before you show them in a UI or write them to a log.

`params` holds all decoded pairs, including unknown keys such as `pj`.
`req-amount` stays `req-amount` in `params`, so read the payment fields from
`amount`, `label` and `message`, not from `params`. Never pass `params.toString()`
on as a URI query: `URLSearchParams` serialises with form encoding (space as `+`).

## Formatting (`formatQbitUri`)

- Parameters are emitted in the order `amount`, `label`, `message`, and only the
  ones that are set (`undefined` is skipped; an empty string is emitted as
  `label=`).
- `amount` must be a valid QBT decimal of at most 210,000,000 QBT
  (`QBIT_MAX_MONEY`) and is emitted as given.
- `label` and `message` are UTF-8 percent-encoded like `QUrl::toPercentEncoding`
  (`:238,245`). Only the RFC 3986 unreserved characters `A-Z a-z 0-9 - . _ ~`
  stay bare. A space becomes `%20`, and `+ & = % # ! ' ( ) *` are escaped.
- A string with a lone UTF-16 surrogate throws `INVALID_URI`.
- The address is validated and emitted as given. Core uppercases bech32
  addresses for denser QR codes; qbit-js leaves that to the caller.

```ts
formatQbitUri({ address, amount: '0.5', label: 'Coffee shop', message: '1+1=2' })
// qbit:qb1z…?amount=0.5&label=Coffee%20shop&message=1%2B1%3D2
```

`parseQbitUri(formatQbitUri(fields))` returns the same `address`, `amount`,
`label` and `message`. The tests fuzz this round trip with `+`, space, `&`, `=`,
`%`, `#` and non-ASCII text.

## Changes from earlier builds

Earlier builds of `@qbit-oss/protocol` read the query with `URLSearchParams`:

- `+` decoded as a space, and `%ZZ` was kept as literal text.
- A `req-` parameter was ignored, so `req-amount` gave no amount.
- A duplicate key used its first value.
- Text after a `#` was read as part of the last parameter.
- A case variant such as `AMOUNT` or `REQ-expires` was ignored.
- Both functions accepted an amount of any size, such as
  `184467440737.09551617` (2^64 + 1 base units).
- `QBIT:` and a trailing `/` were rejected.
- `formatQbitUri` emitted a space as `+`, and Core's GUI shows that as a literal
  `+`. It replaced a lone surrogate with U+FFFD.

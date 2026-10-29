# Error classification

Recognizing `QbitProtocolError` and `P2mrPsbtSigningError` across the CommonJS
and ESM builds and across versions.

- error classification across builds: `QbitProtocolError.is(error)` and
  `P2mrPsbtSigningError.is(error)` recognize those errors from any copy of this
  package. Use them instead of `instanceof` where the app can load both the
  CommonJS and the ESM build, or two versions: each copy has its own classes,
  and `instanceof` is false for an error from the other one. They check the
  `Symbol.for('qbit-js.QbitProtocolError')` and
  `Symbol.for('qbit-js.P2mrPsbtSigningError')` brands on the class prototypes.
  Any code can set a brand, so they classify errors, they do not authenticate
  them. An error from another version can carry a `code` this one does not
  list, so keep a default branch

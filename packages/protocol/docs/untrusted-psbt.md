# Untrusted PSBT input

The limits on what a hostile PSBT can make `parsePsbt`, `finalizeP2mrPsbt` and
`extractP2mrTransaction` decode and allocate.

`parsePsbt(bytes, { maxBytes, maxObjects })` and
`extractP2mrTransaction(psbt, { maxBytes, maxObjects })` bound what a hostile
PSBT can make them allocate. The two limits are independent:

- `maxBytes` (default `PSBT_DEFAULT_MAX_BYTES`, 16 MiB, 8x a block-sized qbit
  transaction): `parsePsbt` rejects larger input before parsing it, and
  `extractP2mrTransaction` refuses to build a larger transaction.
- `maxObjects` (default `PSBT_DEFAULT_MAX_OBJECTS`, 131,072): the most PSBT
  map entries, unsigned-transaction inputs and outputs, and final-witness items
  one call decodes, counted together. Each costs about 0.5 KB of heap however
  few bytes encode it (a map entry can take 3 bytes), and key and value bytes
  add to that (see below), so this, not `maxBytes`, bounds the heap a small,
  dense PSBT can claim. A PSBT within `maxBytes` with
  at most `maxObjects` objects is accepted however dense it is: a 9,000-output
  P2MR batch payout (a 396,152-byte unsigned PSBT, 390,777-byte transaction)
  passes with `maxBytes` set to its exact size. A standard transaction (at
  most 400,000 bytes) has fewer than 44,500 inputs and outputs. Raise
  `maxObjects` for a non-standard transaction with more objects than that
  allows, and lower both limits to tighten the memory bound.
- Counts and lengths are checked against the bytes that remain before the
  parser allocates or loops.
- `finalizeP2mrPsbt` and `extractP2mrTransaction` decode final scriptwitness
  (`0x08`) values with qbit Core v1.0.0's P2MR limits, including on `Psbt`
  objects built without `parsePsbt`: at most 1,003 items (a 1,000-item stack,
  leaf script, control block and annex), and for leaf version `0xc0` a stack
  of at most 1,000 items, 16 KiB each and 128 KiB in total
  (`src/script/script.h:43-49`, `src/script/interpreter.cpp:37-47`).

At the defaults, the densest hostile PSBTs measured on Node 24 needed at most
96 MB of V8 heap in `parsePsbt` (131,069 distinct 64-byte keys with 61-byte
values) and 144 MB in `parsePsbt` and then `decodePsbt` (131,069 P2MR leaf
scripts of 63 bytes), as the smallest passing `--max-old-space-size`. The
parsed PSBT retained at most about 70 MB of that, and the `decodePsbt` summary
about 70 MB more. `extractP2mrTransaction` of 130 inputs with 1,003 empty
witness items each completed with `--max-old-space-size=36`. What drives the
heap is `maxObjects` times the cost of each object: about 0.5 KB, plus up to
about 0.25 KB for a map entry's key and value, because V8 keeps byte arrays of
up to 64 bytes on its heap and the duplicate-key check holds the hex of keys of
up to 64 bytes, plus about 0.4 KB for each leaf script `decodePsbt` decodes.
Longer keys are checked by their SHA-256, and longer keys and values live
outside the V8 heap. Parsed fields are copies of the input, so a parsed PSBT
also holds about its encoded size (at most `maxBytes`) in byte buffers outside
the heap.

Unlike qbit Core, `parsePsbt` does not decode `0x08` values yet, so a
malformed final witness is reported by `finalizeP2mrPsbt` or
`extractP2mrTransaction`, not at parse time. All of these failures throw
`QbitProtocolError` with code `INVALID_PSBT`; a `maxBytes` or `maxObjects`
that is not a positive safe integer throws `RangeError`.

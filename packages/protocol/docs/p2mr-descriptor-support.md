# P2MR descriptor support

What `parseP2mrDescriptor` and `formatP2mrImportDescriptors` accept, and where
that differs from qbit Core. Line references are to `Qbit-Org/qbit` `v1.0.0`.

## Descriptor support

| Form | Status |
| --- | --- |
| `rawmr(<32-byte hex>)` | Supported |
| `mr(pk(<32-byte hex>))`, `mr(multi_a(...))`, `mr(sortedmulti_a(...))` | Supported |
| `mr({left,right})` script trees, up to 128 levels deep | Supported |
| `mr(pk(pqc(KEY/path)))` with an optional `[fingerprint/path]` origin | Parsed; deriving its PQC key needs private BIP32/PQC derivation, which this package doesn't do |
| Final unhardened wildcard `/*` | Supported |
| Hardened wildcard `/*'` or `/*h` | **Not supported**; Core accepts it (`script/descriptor.cpp:2220-2232`) |
| Multipath segment `<a;b>` | **Not supported**; Core accepts it after the key, not in an origin (`script/descriptor.cpp:2162-2193`, `:2543`) |

### Key-path segments

Key paths and origin paths follow Core's `ParseKeyPathNum`
(`script/descriptor.cpp:2114-2136`):

- A segment is decimal digits with an optional hardened marker. The marker is
  `'` or `h`; `H` is rejected.
- Leading zeros are allowed (`00`, `0002147483647h`).
- The value must be at most `2147483647` (`0x7FFFFFFF`). The hardened bit comes
  only from the marker, so `2147483648` is not a spelling of `0'`.
- Errors use Core's wording: `Key path value '87H' is not a valid uint32` (not a
  uint32 at all) and `Key path value 2147483648 is out of range` (a uint32
  above `0x7FFFFFFF`).

## `formatP2mrImportDescriptors`

The helper builds the request array for Core's `importdescriptors` RPC. It
throws `INVALID_DESCRIPTOR` for requests that break these rules, which Core
v1.0.0 rejects or misapplies:

| Input | Rule | Core reference |
| --- | --- | --- |
| `external`, `internal` | Ranged `mr(...)` descriptors with no leading or trailing whitespace. Core doesn't trim `desc`; `parseP2mrDescriptor` still does. | `script/descriptor.cpp:3529-3544` |
| `range` | `[start, end]` with `0 <= start <= end <= 2^31-1` and `end - start < 1_000_000` (`Range is too large`). Defaults to `[0, 999]`. | `rpc/util.cpp:1502-1530` |
| `timestamp` | `'now'` (the default) or a non-negative safe integer number of seconds. Core clamps negative values to 1; this helper rejects them. | `wallet/rpc/backup.cpp:805-818` |
| Pair | The descriptors must differ once checksums are removed. Activating one descriptor as both external and internal leaves the wallet with no active receive descriptor. The comparison is textual, so spellings Core treats as one descriptor, such as `87h` and `87'`, `0` and `00`, or fingerprints that differ only in case, aren't detected. | `wallet/wallet.cpp:4828-4836` |
| Pair | All `pqc()` keys must be decodable on one network. | `key_io.cpp:62-87` |

A node decodes these extended-key prefixes:

| Network | Prefixes |
| --- | --- |
| mainnet | `qpub`/`qprv`, plus Bitcoin `xpub`/`xprv` |
| testnet4, signet | `tqpb`/`tqpv`, plus Bitcoin `tpub`/`tprv` |
| regtest | `qrpb`/`qrpv`, plus Bitcoin `tpub`/`tprv` |

A `qprv` receive descriptor paired with a `qrpv` change descriptor is rejected.
A `qrpv` key paired with a `tprv` key is accepted, because regtest decodes both.

Not checked:

- `pqc()` keys given as extended public keys, which Core rejects
  (`wallet/rpc/backup.cpp:932-947`);
- keys for a network other than the node's;
- wallet state.

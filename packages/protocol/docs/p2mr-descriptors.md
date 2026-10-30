# P2MR Descriptors

Notes on the `mr(...)` / `rawmr(...)` descriptor helpers in `@qbit-oss/protocol`
where they enforce a qbit Core rule that is easy to miss.

**Source of truth:** `Qbit-Org/qbit` `v1.0.0`.

## `multi_a` thresholds above 35 can never be spent

A P2MR v1 leaf's initial witness stack (the arguments left after the annex,
leaf script and control block are removed) is capped by **consensus** at
`MAX_P2MR_V1_TOTAL_INITIAL_STACK_BYTES = 131072` bytes, with each item at most
`MAX_P2MR_V1_STACK_ITEM_SIZE = 16384` bytes (`src/script/script.h:46-49`,
enforced by `CheckP2MRV1InitialStackResourceLimits`,
`src/script/interpreter.cpp:37-47`, called at `:2395`). Violations fail with
`SCRIPT_ERR_PUSH_SIZE`.

A `multi_a(k, ...)` / `sortedmulti_a(k, ...)` leaf needs `k` non-empty PQC
signature items, each 3680 bytes (`SIGHASH_DEFAULT`) or 3681 bytes (explicit
sighash byte). So:

| k  | signature bytes (all 3680) | signature bytes (all 3681) | spendable |
| -- | -------------------------- | -------------------------- | --------- |
| 35 | 128800                     | 128835                     | yes       |
| 36 | 132480 > 131072            | 132516 > 131072            | **never** |

qbit Core pins this as `P2MR_V1_MAX_STANDARD_SIGNATURES = 131072 / 3681 = 35`
(`src/script/p2mr_sizing.h:16-24`), and its signer never signs a `multi_a`
leaf past it (`src/script/sign.cpp:511`). Core still parses such descriptors
and expands their trees (`src/script/descriptor.cpp:1744-1757`). It refuses
one only when no leaf is within the cap (`HasP2MRStandardSatisfaction`,
`src/script/descriptor.cpp:1785`, `:1864-1868`), and then only in
`deriveaddresses` (`src/rpc/output_script.cpp:339-341`) and for an active
`importdescriptors` entry; an inactive import only gets a warning
(`src/wallet/rpc/backup.cpp:853-859`). Coins sent to a P2MR output whose
**every** leaf needs more than 35 signatures are lost.
Large `n` is fine: P2MR leaves have no script size limit, and up to 999 keys
are allowed as long as `k ≤ 35`.

This package exports the cap as `P2MR_V1_MAX_MULTI_A_THRESHOLD` (35) and
mirrors Core:

- **`multiALeafScript(k, pubkeys)`** throws a `RangeError` when `k > 35`.
- **`parseP2mrDescriptor`** still accepts `1 ≤ k ≤ n ≤ 999`, as Core's parser
  does (`src/script/descriptor.cpp:2775-2786`), so a threshold above 35 never
  stops a Core descriptor from parsing, and `serializeP2mrDescriptor`
  round-trips it. (Other Core syntax, such as multipath `<0;1>` key paths, is
  not supported.)
- **`hasP2mrStandardSatisfaction(descriptor)`** matches Core's
  `HasP2MRStandardSatisfaction` (`getdescriptorinfo`'s
  `has_p2mr_standard_satisfaction`): `rawmr()` is `false`; `mr()` is `true` when
  any leaf is `pk(...)` (including `pk(pqc(...))`) or a `multi_a` /
  `sortedmulti_a` with `k ≤ 35` (`src/script/descriptor.cpp:1864-1868`, `:1925`).
- **`p2mrRootFromDescriptor` / `p2mrAddressFromDescriptor`** throw
  `INVALID_DESCRIPTOR` (`P2MR descriptor has no wallet-constructible
  satisfaction: multi_a thresholds must not exceed 35`) for an `mr()` descriptor
  with no such leaf, like Core's `deriveaddresses`
  (`src/rpc/output_script.cpp:339-341`). A tree with at least one spendable leaf
  still expands, and its root commits to the unspendable leaves too, so
  `mr({pk(A),multi_a(36,...)})` gives the same address as Core. `rawmr()` is
  exempt: it commits to no known leaves.
- **`formatP2mrImportDescriptors`** is unaffected: an import descriptor must
  have a ranged `pk(pqc(...))` leaf, which is always spendable.

### Mixed trees

`mr({pk(A),multi_a(36,...)})` still gets an address, the same one Core gives,
because its `pk(A)` leaf is spendable. Spending `pk(A)` needs a control block
that holds the `multi_a(36,...)` sibling's leaf hash. `multiALeafScript` now
refuses to build that leaf's script, and this package has no other public
helper that returns it. You have to build the script bytes yourself:
`<pk_0> OP_CHECKSIGPQC <pk_1> OP_CHECKSIGADD ... <pk_n-1> OP_CHECKSIGADD <k>
OP_NUMEQUAL`, with the keys sorted for `sortedmulti_a` and `k` pushed as a
minimally encoded script number. Then hash it with
`p2mrLeafHash(P2MR_LEAF_VERSION_V1, script)`. Otherwise, avoid putting
unspendable leaves in a tree.

### Raw builders cannot check the cap

`p2mrLeafHash`, `p2mrBranchHash`, `merkleRootFromPath` and `p2mrAddressFromRoot`
hash bytes and roots they are given. They cannot tell whether a script is a
`k > 35` `multi_a` leaf or whether any leaf under a root is spendable. If you
assemble P2MR trees from raw scripts, build `multi_a` leaves with
`multiALeafScript`, or check your descriptor with `hasP2mrStandardSatisfaction`,
before deriving an address.

## Descriptor objects are validated like strings

The functions that accept a `ParsedP2mrDescriptor` object
(`serializeP2mrDescriptor`, `p2mrRootFromDescriptor`,
`p2mrAddressFromDescriptor`, `hasP2mrStandardSatisfaction`) apply the same
checks `parseP2mrDescriptor` applies to strings, and throw `INVALID_DESCRIPTOR`
otherwise:

- `type` is `mr` or `rawmr`; tree nodes are `branch`, `pk`, `pqc`, `multi_a` or
  `sortedmulti_a`.
- The `rawmr` root and every `pk` / `multi_a` pubkey is a 32-byte `Uint8Array`.
- `multi_a` / `sortedmulti_a` thresholds are integers with `1 ≤ k ≤ n ≤ 999`.
- `pqc` keys pass the same parser as `pk(pqc(...))` strings.
- No leaf is more than 128 branches deep (`P2MR_CONTROL_MAX_NODE_COUNT`, Core's
  `mr()` nesting limit, `src/script/descriptor.cpp:3052`). The check is
  iterative, so very deep objects fail with `INVALID_DESCRIPTOR` instead of a
  stack overflow.
- Every tree node is a distinct object, as `parseP2mrDescriptor` builds them. A
  node object reached twice, through a shared subtree or a cycle, fails with
  `INVALID_DESCRIPTOR`, so the check visits each object once. Depth alone does
  not bound the work: 100 levels of `{ type: 'branch', left: prev, right: prev }`
  are 101 objects but 2^100 paths. To repeat a leaf, give each position its own
  object.

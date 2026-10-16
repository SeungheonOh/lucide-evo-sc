# Port notes

This standalone recipe fetches and links the original sc-tools library sources at
`4546122230491db4839a4a42fc2bc601f7900909`. It uses Cardano API 11.0.0.0,
Plutus 1.63.0.0, and GHC WASM 9.12.4.20260731. The separate Cabal project
selects the transaction, coin-selection, wallet, optics, and mockchain libraries
from `deps/sc-tools/` in the external build cache.

The cache defaults to `~/.cache/lucid-sctools-wasm`, respects `XDG_CACHE_HOME`, and
can be overridden with `SC_TOOLS_WASM_CACHE`. Downloads, extracted sources,
compiler output, browser artifacts, and test dependencies all stay there.

`dependencies.json` records source archive hashes or immutable Git revisions.
`patches/` contains the differences applied to those sources, including Cabal
metadata revisions. `prepare-dependencies.py` checks downloads, applies patches,
and refuses to overwrite a dependency with conflicting local modifications.

| Area | Change and reason |
| --- | --- |
| Plutus budgets | `SatInt` stores `Int64`. Arithmetic saturates at 64-bit bounds on WASM32. Ledger execution budgets exceed the signed 32-bit range. |
| Plutus builtins | Integer denotations that were native `Int` use `Int64`. Byte-array indexing narrows only after range checks or saturation. Bit operations preserve 64-bit indices and shift/rotate amounts. |
| Plutus examples | Example builtin denotations use explicit `Int64`/`Word64`, matching the native 64-bit meaning. No failing placeholder builtin instances are added. |
| Cryptography | Link portable sodium, blst, and secp256k1 C packages. Correct C/Haskell return signatures for Curve25519, Curve448, Ed25519, wallet initialization, and VRF conversion functions. WebAssembly validates function signatures strictly. |
| VRF | A four-limb C scalar buffer uses `unsigned long long`, retaining the required 32-byte size on WASM32. Certificate ordering compares serialized proof bytes as required by the selected crypto-class API. |
| Foundation | Use WASI memory-map emulation, little-endian configuration, WASI secure randomness, and clock wrappers. Native socket bindings are excluded from this package's WASM build. |
| Other portable dependencies | Use pinned WASM-compatible basement, network, cborg, ram, memory, cryptonite, and double-conversion sources/patches. Disable Argon2 native threading in crypton. |
| CBOR compatibility | Restore the `decodeWithByteSpan` tuple interface expected by the selected Cardano packages, using the decoder's byte offsets. |
| Build graph | Exclude native database tools and unrelated test/executable components from the patched API/consensus package descriptions. Retain the libraries needed by the actual builder and local ledger. |
| GHC compatibility | Add required KES size constraints and match the heap-size C helper's 64-bit return type. |
| API compatibility | Use the crypto package's public BLS proof-of-possession context and disambiguate the ledger's `ByteSpan` type from the newer CBOR export. |

The Web Worker provides WASI system calls and an in-memory filesystem. It does
not implement Cardano operations. `LiveTx.hs` supplies a `MonadBlockchain`
instance backed by wallet UTXOs and an explicit chain-data snapshot. The editor
uses `Convex.BuildTx` and `Convex.CoinSelection.balanceTx` without the mockchain.

A second balancing pass reserves Cardano's conservative key-witness count and
additional native-script/signing witnesses. Collateral return is recalculated
for the resulting fee; serialization and minimum-fee checks repeat until the fee
covers the final fields. This avoids underfunded collateral when the witness
estimate increases the fee. Signing assembles the CIP-30 witness set in WASM and
checks the fee against the returned signature count.

Each request creates a fresh WASM instance. The matching-number contract and
12 integer-width regressions remain in the regression-only CLI entry point.
Browser integration tests exercise the live bridge with a CIP-30 test adapter;
they do not constitute full Cardano conformance or an actual wallet submission.

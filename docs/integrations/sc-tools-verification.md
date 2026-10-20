# Verification of the Haskell-only integration

Verified locally on 2026-10-20. The source projects remain separate:

- Lucid: `~/fun/lucid-revolution`, based on Lucid Evolution 0.8.1 at upstream
  commit `5394f993c22e12d090b06bbb1af3ad8d005c2b6f`.
- Bridge: `~/fun/lucid-sctools-wasm`, commit
  `d0cdc6bcd5a6981abb9f48678611dd34bbecad6f`, on the remote
  [`sc-tools-wasm` branch](https://github.com/SeungheonOh/lucide-evo-sc/tree/sc-tools-wasm).
- Original `~/fun/sc-tools-wasm`: unchanged, with a clean working tree.

CML, its bundled Rust sources/binaries, and the Aiken/Scalus evaluator packages
are removed. The package dependency graph and browser bundle contain no CML or
alternative Cardano ledger engine. The only shipped WASM is the Haskell reactor.

## Results

| Check                                                                                      | Result                                                                          |
| ------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------- |
| Complete offline Lucid suite                                                               | 248 passed; 5 existing skips                                                    |
| Ledger, Plutus, utilities, wallets, providers, message signing, transaction graphs         | 237 passed; 54 existing network-dependent skips                                 |
| Recorded Plutus data corpus                                                                | 3,000 values in both encoding formats and 15,000 decoding outcomes passed       |
| Generated canonical transaction cases                                                      | 3,000 passed                                                                    |
| Consensus regressions for signing, native scripts, reference scripts and canonical exports | Passed through actual convex-mockchain submission                               |
| Haskell reactor primitive/ledger checks                                                    | 139 passed                                                                      |
| Haskell reactor in real Chromium main thread                                               | 61 passed                                                                       |
| Built package, Node 18 and Node 24, ESM and CommonJS                                       | Passed payment, signing and actual ledger submission                            |
| Built public package in real Chromium                                                      | Passed data, wallet, payment, signing, ledger submission and CIP-8 verification |
| Source TypeScript, changed test types, formatting and frozen dependency install            | Passed                                                                          |
| Package ESM/CommonJS/declarations and documentation builds                                 | Passed                                                                          |

The documentation build retains a pre-existing ESLint/AJV dependency diagnostic;
MDX compilation and all 33 static pages complete successfully. The workspace
TypeScript lint command passes separately.

The full suites ran on reactor `911f868149f119f750da233a40796e311c319a0eef7939664b1dbc11f6b9fb94`.
The final reactor changes only independent signed-transaction minimum-fee
inspection to avoid adding estimated witnesses twice. All `tx.minFee` consumers,
custom-fee regressions, package smoke tests and artifact checks were rerun on the
final artifact below. Transaction balancing's fee calculation is unchanged by
that last correction.

## Coverage

Financial flows include payments, chaining, Byron destinations, native mint/burn,
Plutus V1/V2/V3, reference scripts, inline/hash/supplemental datums, metadata,
validity intervals, exact integers, multi-asset change, collateral, fee overrides,
disabled coin selection, both delayed redeemer APIs, and external/provider
evaluation. Staking and governance cases cover deposits/refunds, pools and relays,
reward withdrawals, DReps, proposals, votes, committee certificates and treasury
donations. The emulator validates signatures, rejects double spends and invalid
scripts, preserves state after rejected submissions, and synchronizes mutable
JavaScript fixtures with the actual Haskell ledger.

The recorded data/address/script/DRep/wallet/message vectors come from the prior
implementation and fixed expected results. Tests do not regenerate expected
values using the implementation under test. The data corpus includes malformed
CBOR, large integers, ordered maps, duplicate keys, chunked bytes, constructor
tags and trailing bytes. Legacy `Data.from` tolerances are isolated from strict
transaction/ledger decoding.

Canonical export and witness merging preserve bytes already committed by script,
metadata and integrity hashes. Native reference scripts keep their original
bytes through output encoding, balancing, fee calculation, simulation and
queries. Tests submit both witness and reference-script transactions to the real
ledger and check that native minimum ADA charges the actual serialized size.

The default emulator retains its original implicit protocol version 11.
Generic providers that omit a version use 10. Explicit versions and provider
chain state are honored, including when using an explicit Haskell evaluator.
Legacy bootstrap reward scenarios explicitly use version 9 and seed their pool.

Tests tied solely to deleted CML/Aiken internals were replaced with Haskell or
actual-ledger assertions; obsolete private cache/placeholder tests were removed.
No failing financial test was converted into a skip. Network-dependent suites
are excluded from the offline Lucid command or retain their existing skips.

## Reproduction

```sh
pnpm install --frozen-lockfile
pnpm --filter '@lucid-evolution/lucid...' build
pnpm check:haskell
pnpm test:offline
pnpm --filter @lucid-evolution/ledger --filter @lucid-evolution/plutus \
  --filter @lucid-evolution/utils --filter @lucid-evolution/wallet \
  --filter @lucid-evolution/provider --filter @lucid-evolution/sign_data \
  --filter @lucid-evolution/tx-graph -r --workspace-concurrency=1 \
  exec vitest run --minWorkers 1 --maxWorkers 1
pnpm test:package
pnpm exec playwright-core install chromium
pnpm test:browser
pnpm lint
pnpm format-check
```

The package includes the reactor and third-party notices. Its exact compiler,
source revision and checksum are recorded in
[`packages/ledger/artifact.json`](../../packages/ledger/artifact.json):

- Compiler: `wasm32-wasi-ghc 9.12.4.20260731`
- sc-tools revision: `4546122230491db4839a4a42fc2bc601f7900909`
- Reactor ABI version: 1
- WASM size: 63,668,118 bytes
- SHA-256: `a25796a197fcc9419d8e12b50fc0f427dce617e2d2520a3a90edcad204608c72`

See [the runtime and migration guide](sc-tools.md) for browser asset deployment,
bridge rebuilding and artifact vendoring. The bridge's `wasm/LUCID-BRIDGE.md`
documents its JSON operations and standalone regression commands.

## Limits

These checks establish the covered contracts, not exhaustive equivalence for
every transaction, byte representation or error message. Coin choices and
conservative fees can differ from the former balancer. Direct CML object APIs
are replaced by CBOR or plain snapshots; the migration guide lists those changes.

Real Conway validation rejects invalid fixtures that the former JavaScript
emulator accepted. Pool registration, reward registration, full-balance
withdrawals and post-bootstrap vote delegation must satisfy ledger rules.
Neither simulator implements node epoch processing, automatic epoch rewards or
governance ratification. Applications need a full chain context for historical
deposits that differ from current protocol parameters.

No verification transaction was submitted to a public chain. Live credentials,
wallet browser extensions and public-network submission were not exercised.

# Verification of the sc-tools integration

Verified locally on 2026-10-15. Both source checkouts remain separate:

- Lucid: `~/fun/lucid-revolution`, incorporating Lucid Evolution 0.8.1 at upstream
  commit `5394f993c22e12d090b06bbb1af3ad8d005c2b6f`.
- WASM bridge: `~/fun/lucid-sctools-wasm`, commit
  `bc65fb1b7a17d39810ecce1600c7c80fc0cbb60c`, published on the
  [`sc-tools-wasm` branch](https://github.com/SeungheonOh/lucide-evo-sc/tree/sc-tools-wasm).
- Original `~/fun/sc-tools-wasm`: unchanged, clean working tree.

## Results

| Check                                                                 | Result                        |
| --------------------------------------------------------------------- | ----------------------------- |
| Upstream offline Lucid regressions, CML backend                       | 204 passed, 10 existing skips |
| Upstream offline Lucid regressions, sc-tools and convex-mockchain     | 192 passed, 10 existing skips |
| Dedicated bridge and actual-ledger simulator tests                    | 43 passed                     |
| Unchanged upstream mutable-ledger fixture tests with convex-mockchain | 14 passed                     |
| Provider capability regressions, including retained Maestro           | 13 passed                     |
| UTxO conversion regressions, including hash-only datums               | 4 passed                      |
| TypeScript source and new integration tests                           | Passed                        |
| Lucid ESM, CommonJS, and declaration builds                           | Passed                        |
| Built ESM package payment, signing, and ledger submission             | Passed                        |
| Built CommonJS package WASM runtime                                   | Passed                        |
| Existing browser workflow                                             | 24 checks passed              |
| Browser v2 worker, offline after loading                              | 9 checks passed               |
| Haskell/WASM dependency and executable build                          | Passed                        |

The SC suite excludes 12 tests in `completion-evaluation.test.ts` that instrument
Aiken calls and CML draft/replay counts; they remain enabled in the CML suite.
Dedicated SC tests verify the corresponding behavior using the actual ledger:
fee-dependent final evaluation, delayed redeemers, explicit Aiken adapters, and
byte evaluators. No failing test was changed into a skip.

The parity setup changes backend selection and emulator construction. Legacy
reward fixtures use Conway protocol version 9 and seed their assumed pool.
Dedicated tests check explicit protocol versions 9, 10, and 11, plus the omitted
version fallback of 10, matching upstream Aiken. Withdrawals outside bootstrap
Conway use explicit DRep delegation.

The tests cover payments and chaining, Byron destinations, native mint/burn,
Plutus V1 hash datums, Plutus V2/V3, reference scripts, exact asset/data integers,
metadata key types, validity intervals, ordinary providers without extra callbacks,
provider switching, fractional slot mappings, wallet collateral, exact fees,
dust, disabled coin selection, composition, canonical Plutus-data preservation,
both delayed redeemer interfaces, staking deposits/refunds, DReps, proposals/votes,
treasury donations, pool relays/metadata/margins, queued rewards and withdrawals,
large change bundles, rejected scripts, failed submissions, and double spends.

Mutable-fixture tests cover ledger replacement, nested edits, shared records,
query-returned object edits, property definitions, mempool/history, and churn.
The actual ledger is synchronized before balancing, evaluation, rewards, or
submission, while read-only queries preserve the original Emulator's behavior.

Shared Lucid fixes cover ledger voter ordering, governance datum handling, vote
signing keys, signed redeemer encoding, pool margins/relays/metadata, and datum
hashes on UTxOs whose datum has not been fetched. Both CML and SC transactions
spending Plutus V1 hash-datum outputs were accepted by convex-mockchain.

The browser v2 test verifies capabilities, genesis creation, automatic Lucid
context, public fixtures, balancing, signing, ledger submission, duplicate-spend
rejection, and persisted state. Both browser suites run offline after loading;
the legacy suite fetches public protocol parameters before going offline. No
test submits to a public chain.

## Rebuilt artifact

- WASM: `~/.cache/lucid-sctools-wasm/output/sc-tools.wasm`
- Browser assets: `~/.cache/lucid-sctools-wasm/output/browser/`
- Compiler: `wasm32-wasi-ghc 9.12.4.20260731`
- sc-tools source: `4546122230491db4839a4a42fc2bc601f7900909`
- Bridge version: 2
- WASM bytes: 64,099,882
- Compressed bytes: 10,421,135
- WASM SHA-256: `ef51162b41bc18a6a91fa8796a543f3bfa276baa429a68a45d350340253fde3a`
- Gzip SHA-256: `eb5a8d029a706299ba10259434b736296ff2a2cffed19faab20a8ad2105e0e99`

The browser directory includes its runtime manifest and collected third-party
notices. Generated dependencies and binaries stay outside the source repositories.
See [setup and reproduction commands](sc-tools.md) and the bridge project's
`wasm/LUCID-BRIDGE.md` for the request schema and browser test commands.

## Scope

These results verify the covered public contracts against the merged upstream
baseline; they do not establish exhaustive parity for every transaction or error.
Coin choices and conservative fees can differ between balancers. The simulator
uses real Conway transaction validation, which rejects invalid transactions the
JavaScript Emulator may accept. Neither simulator implements node epoch processing,
automatic epoch rewards, or governance ratification.

Ordinary providers work through the unchanged Provider interface using Lucid's
protocol parameters and slot mapping. Applications can supply a full node context
when they need historical pool/deposit state. Live-network submission, node epoch
processing, and external provider credentials were not exercised.

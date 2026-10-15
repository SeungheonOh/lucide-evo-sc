# Verification of the sc-tools integration

Verified locally on 2026-09-27. Both source checkouts remain separate:

- Lucid: `~/fun/lucid-revolution`, based on `20b74d7e9c1df4c0d74b24e819eb47d4e5461e4a`.
- WASM bridge: `~/fun/lucid-sctools-wasm`, based on `32fe170fa8a0a34dfc401a27b541b163462e288c`.
- Original `~/fun/sc-tools-wasm`: unchanged, clean working tree.

## Results

| Check                                                     | Result                                        |
| --------------------------------------------------------- | --------------------------------------------- |
| Existing offline regressions, CML backend                 | 148 passed, 10 existing skips                 |
| Same regressions, sc-tools and convex-mockchain           | 148 passed, 10 existing skips                 |
| Dedicated bridge and simulator tests                      | 28 passed                                     |
| Queued submissions and reward distribution                | Both zero/fractional-margin pool cases passed |
| TypeScript, including new integration tests               | Passed                                        |
| Lucid ESM, CommonJS, and declaration builds               | Passed                                        |
| Built ESM package payment, signing, and ledger submission | Passed                                        |
| Built CommonJS package WASM runtime                       | Passed                                        |
| Existing browser workflow                                 | 24 checks passed                              |
| Browser v2 worker, offline after loading                  | 7 checks passed                               |
| Full Haskell/WASM dependency and executable build         | Passed                                        |

The parity configuration changes backend selection and emulator construction only.
One pre-existing test's voter-order expectation was corrected alongside the shared
implementation: the ledger orders script credentials before key credentials within
a voter role. Mixed key/script DRep voting now submits successfully through both
backends to the actual ledger. The legacy fixtures seed their assumed pool and use
Conway protocol version 9; dedicated simulator tests use default protocol version
11 and explicit DRep delegation for withdrawals.

The dedicated tests cover payments and chaining, native minting, exact asset and
datum integers, metadata key types, reference scripts, Plutus success/failure,
provider evaluation, collateral, fees, dust, disabled coin selection, composition,
repeatability, both delayed redeemer interfaces, staking deposits/refunds, DReps,
proposals/votes, treasury donations, pool relays/metadata/margins, reward distribution
and withdrawals, large change bundles, failed submissions, and double spends.

The browser v2 test verifies capabilities, genesis creation, balancing, signing,
ledger submission, duplicate-spend rejection, and persisted state round-tripping.
It switches the browser offline after loading the worker. No test submits to a
public chain; the older browser suite fetches public protocol parameters as input.

## Rebuilt artifact

- WASM: `~/.cache/lucid-sctools-wasm/output/sc-tools.wasm`
- Browser assets: `~/.cache/lucid-sctools-wasm/output/browser/`
- Compiler: `wasm32-wasi-ghc 9.12.4.20260731`
- Bridge version: 2
- WASM bytes: 63,979,161
- Compressed bytes: 10,402,427
- SHA-256: `9eeb5ad66c1934c8c53261ee651b978d1753552e5a6b3fbd2f59b8b6956b06a7`

The browser directory includes its runtime manifest and collected third-party
notices. Generated dependencies and binaries stay outside the source repositories.
See [setup and reproduction commands](sc-tools.md) and the bridge project's
`wasm/LUCID-BRIDGE.md` for the request schema and browser test commands.

## Scope

These results cover the tested transaction construction and Emulator scenarios;
they do not establish exhaustive Lucid parity. The bridge currently rejects Byron
addresses, including output destinations. Coin choices and conservative fees can
differ between balancers. The simulator runs real Conway
transaction validation and persists ledger state; its clock does not run epoch
transitions, automatic epoch rewards, or governance ratification. Live-provider
adapters must supply an accurate complete chain context. Live-network submission
and node epoch processing were not exercised.

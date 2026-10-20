# Haskell ledger runtime

This fork uses Haskell WASM for Cardano ledger operations. The packaged reactor
provides sc-tools balancing, Plutus evaluation, serialization, keys, signatures,
script parameters, and convex-mockchain. CML and the Aiken/Scalus evaluator
packages are removed from the source tree and dependency graph.

## Using Lucid

The default path needs no backend configuration or separate WASM build:

```ts
import { Lucid } from "@lucid-evolution/lucid";

const lucid = await Lucid(provider, "Preprod");
lucid.selectWallet.fromSeed(seedPhrase);
const tx = await lucid
  .newTx()
  .pay.ToAddress(recipient, { lovelace: 2_000_000n })
  .complete();
const signed = await tx.sign.withWallet().complete();
const hash = await signed.submit();
```

The transaction actions, completion options, delayed redeemers, wallet selection,
CIP-30 integration, provider methods, signing, submission, and chaining retain
their high-level interfaces. `Data.to` and `Data.from` remain synchronous.
`Emulator` now uses actual convex-mockchain; `ScToolsEmulator` remains an alias.

## Architecture

`@lucid-evolution/ledger` owns the single bundled `sc-tools.wasm` and its JSON
reactor interface. It has no dependency on Lucid's higher-level packages.
Haskell owns ledger encoding, keys, hashes, script execution, transaction
balancing, and validation. TypeScript owns the fluent builder, user callbacks,
provider transport, and conversion between domain objects and JSON.

The builder records domain actions, resolves UTxOs and delayed redeemers, then
passes intent to sc-tools. The Haskell balancer selects inputs, calculates fees
and minimum ADA, partitions change, selects collateral, evaluates scripts, and
converges on the final transaction. Signing merges witnesses while preserving
the body and committed datum/redeemer bytes. There is no preliminary CML build
or fallback engine.

Ledger JSON encodes integer amounts as decimal strings. Public TypeScript
amounts remain `bigint`. A persistent reactor avoids recompiling WASM for each
synchronous utility call. Request buffers are released after each operation;
secure entropy comes from Node webcrypto or browser `crypto.getRandomValues`.

## Node and browsers

Node ESM and CommonJS load the packaged reactor from disk. Browsers use an ESM
entry with top-level await: the reactor is fetched and instantiated
asynchronously once, after which utility functions remain synchronous.

Browser bundlers must support ES2022/top-level await and include the WASM asset.
The runtime resolves `../sc-tools.wasm` relative to its emitted module. If the
bundler does not copy `new URL` assets, copy `packages/ledger/sc-tools.wasm` to
that resolved URL. `scripts/check-browser-runtime.mjs` demonstrates an esbuild
bundle served at `/dist/lucid.js` with the asset at `/sc-tools.wasm` and exercises
the public API in Chromium. Serve a correct WASM content type and retain the
package's third-party notices. Running the whole Lucid module in a Worker avoids
blocking the UI during synchronous ledger operations.

Explicit `ScToolsRuntime`, worker runtimes, `evaluateBytes`, and provider
`evaluateTx` adapters remain supported. `makeHaskellEvaluator()` creates the
built-in evaluator explicitly. `localUPLCEval: false` selects provider evaluation.
These are application-supplied integrations; the built-in ledger engine is Haskell.

## Low-level API migration

Removing a library also removes its raw objects. Financial APIs keep their
signatures, while direct CML consumers must migrate:

| Previous low-level value                              | Replacement                                                                                          |
| ----------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `CML` export, CML-owned object/free methods           | No export; domain values and Haskell operations                                                      |
| `toTransaction()` transaction object                  | `TransactionSnapshot`, including `body.fee`, `body.inputs`, `redeemers`, `hash`, and original `cbor` |
| Redeemer callback `txBody`                            | `TransactionBodySnapshot`                                                                            |
| Wallet `signTx` argument/result                       | Transaction CBOR / witness-set CBOR                                                                  |
| `getUtxosCore`, `utxoToCore`, input/output converters | CIP-30 UTxO, input, or output CBOR hex                                                               |
| Cost model wrapper                                    | Plain `CostModels`                                                                                   |
| Governance parameter-update wrapper                   | CBOR hex or `Map<CborValue, CborValue>`                                                              |
| `toCMLNativeScript` and CML redeemer-tag helpers      | `nativeScriptToCbor`, `toRedeemerTagIndex`, `fromRedeemerTagIndex`                                   |
| `makeAikenEvaluator`                                  | `makeHaskellEvaluator`                                                                               |

The `@lucid-evolution/ledger` package exports generic CBOR helpers and snapshot
inspection for advanced integrations. Decoded fields are semantic values;
use the original CBOR when preserving bytes matters. Canonical export preserves
datum/redeemer, native-script, and auxiliary-data bytes committed by hashes.
Transactions with existing signatures retain their original bytes. Use
`.complete({ canonical: true })` to canonicalize the body before signing.

## Chain context

Ordinary providers work through the existing `Provider` interface. Lucid derives
the balancing context from provider protocol parameters and its slot mapping,
including after `switchProvider()`. Missing protocol versions default to Conway
major version 10. This context is sufficient for balancing, not a complete node
consensus snapshot.

Applications can supply `balancer.chainContext` with full protocol parameters,
era history, pool state, and historical stake/DRep deposits. The schema is in the
separate bridge's `wasm/LUCID-BRIDGE.md`. Historical deposits are needed when a
refund differs from the current protocol deposit. The provider still submits
the resulting transaction.

## Simulator

```ts
import {
  Emulator,
  generateEmulatorAccount,
  Lucid,
} from "@lucid-evolution/lucid";

const account = generateEmulatorAccount({ lovelace: 1_000_000_000n });
const emulator = new Emulator([account]);
const lucid = await Lucid(emulator, "Custom");
lucid.selectWallet.fromSeed(account.seedPhrase);
```

The original first three constructor arguments, account utilities, queries,
clock, confirmation methods, mutable fixtures, and rewards interface remain.
The fourth argument optionally supplies a runtime; the fifth accepts genesis
pool fixtures such as `{ stakePools: [poolId] }`. The emulator retains the
original implicit protocol major version 11; an explicit version takes precedence.

The simulator serializes actual Conway ledger state between requests. Submission
validates signatures, value conservation, fees, minimum ADA, collateral, scripts,
certificates, and governance. Rejected submissions leave the state unchanged;
concurrent submissions are serialized. Mutable `ledger`, `mempool`, `chain`,
`datumTable`, `treasury`, and protocol-parameter fixtures are synchronized into
Haskell before ledger operations. Queries retain their existing behavior.

Real ledger validation rejects some fixtures accepted by the former JavaScript
emulator: pools must exist before delegation, rewards require registered
credentials, and post-bootstrap Conway withdrawals require vote delegation.
Register these through transactions or seed explicit fixtures. Reward withdrawals must match the account’s full reward balance; zero
withdrawals are valid for zero-balance accounts. Clock advancement
does not implement node epoch processing, automatic rewards, or governance
ratification; neither did the original emulator.

## Rebuilding the reactor

The source projects remain separate. Lucid is on `main`; the bridge source is on
`sc-tools-wasm` in the same remote repository:

```sh
git clone --single-branch --branch sc-tools-wasm \
  https://github.com/SeungheonOh/lucide-evo-sc.git ~/fun/lucid-sctools-wasm
cd ~/fun/lucid-sctools-wasm
bash wasm/build.sh
```

The bridge build produces `~/.cache/lucid-sctools-wasm/output/sc-tools-ledger.wasm`.
The Lucid package records its exact source/compiler/hash in
`packages/ledger/artifact.json`. After committing the bridge source, run
`node scripts/vendor-ledger.mjs ~/fun/lucid-sctools-wasm ~/.cache/lucid-sctools-wasm/output`
from this repository to copy the reactor, manifest, and notices together. `pnpm check:haskell` verifies the artifact and rejects reintroduced
CML or alternative ledger-engine dependencies.

See [verification](sc-tools-verification.md) for runnable checks and their limits.

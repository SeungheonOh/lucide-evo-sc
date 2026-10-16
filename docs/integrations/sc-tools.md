# sc-tools balancing backend

Lucid can use the JSON/WASI bridge from `lucid-sctools-wasm` bridge v2 for transaction balancing.
Configure `balancer` once when creating Lucid. Existing `newTx`, `pay`, `collectFrom`,
`mintAssets`, `compose`, `complete`, `completeSafe`, `completeProgram`, `chain`,
signing, and submission calls retain their signatures and return types. Omitting
`balancer` retains the existing CML backend and its behavior.

The adapter records intent while Lucid replays its builder actions. CML continues
to encode individual ledger values and calculate output minimum ADA. sc-tools
performs final coin selection, change, fees, collateral, Plutus evaluation, and
transaction serialization. The adapter does not first balance with CML. The
returned transaction goes directly into Lucid's existing signing builder.

## Node.js

Build the sibling sc-tools project once (`bash wasm/build.sh` there), then load its
uncompressed WASM artifact. Build output remains outside either repository.

```ts
import { readFile } from "node:fs/promises";
import { Lucid, createScToolsWasmRuntime } from "@lucid-evolution/lucid";

const runtime = await createScToolsWasmRuntime(
  await WebAssembly.compile(await readFile(wasmPath)),
);
const lucid = await Lucid(provider, "Preprod", {
  balancer: {
    type: "sc-tools",
    runtime,
  },
});

lucid.selectWallet.fromSeed(seedPhrase);
const tx = await lucid
  .newTx()
  .pay.ToAddress(recipient, { lovelace: 2_000_000n })
  .complete();
const signed = await tx.sign.withWallet().complete();
// Submit explicitly when ready: await signed.submit();
```

`wasmPath` normally points to
`~/.cache/lucid-sctools-wasm/output/sc-tools.wasm`; expand `~` in application code.
`provider`, wallet credentials, and recipient above are
application-supplied. The adapter uses the protocol parameters fetched by Lucid from the provider;
it does not submit transactions automatically. Each request has isolated WASI memory; the
compiled module is reused. Run the WASM runtime in a worker when you need to keep
ledger evaluation off the main thread.

## Browser

Serve the generated sc-tools browser runtime assets together, including
`worker.js`, `sc-tools.wasm.gz`, and `wasi/`. The upstream worker resolves its WASM
fetch against its worker location. Its dependencies and third-party notices must
remain available. Connect it as follows:

```ts
import { createScToolsWorkerRuntime } from "@lucid-evolution/lucid";
const runtime = createScToolsWorkerRuntime(
  new Worker("/sc-tools/worker.js", { type: "module" }),
);
// Pass runtime to the same balancer configuration as above.
// When finished: runtime.close();
```

The sibling project's `Engine` also satisfies `ScToolsRuntime`; it must load the rebuilt v2 WASM.
No WASM binary is bundled into the Lucid package.

## Chain context

A chain-context callback is optional. With just `{ type: "sc-tools", runtime }`,
all existing providers work through their unchanged `Provider` interface. The
bridge uses the same protocol-parameter snapshot and per-instance slot mapping
as Lucid's CML backend, including after `switchProvider()`. Fractional-second
slot lengths and system starts are preserved.

If a provider omits the protocol version, the bridge defaults to major version
10, matching Lucid's Aiken evaluator. An explicit provider version takes precedence.

This default is a **balancing context**, not a node consensus snapshot. Every
parameter used for fees, execution, deposits, collateral, and transaction limits
comes from Lucid. Unused epoch/ratification fields are filled from the bridge's
bundled Conway configuration. Slot-to-time conversion follows Lucid's mapping;
it does not invent historical era transitions.

For applications with a full node snapshot, supply
`balancer.chainContext: async ({ provider, network }) => snapshot` using the schema
from `wasm/app/LiveTx.hs`:

- `network`: `mainnet`, `preprod`, `preview`, or `custom` (with optional `networkMagic`).
- `systemStart`: Unix seconds as a decimal string.
- `protocolParameters`: full cardano-cli Conway protocol-parameter JSON.
- `eraSummaries`: node era history with `start`, finite `end`, and `parameters`.
  Each boundary has `time`, `slot`, and `epoch`. Parameters contain `epoch_length`,
  `slot_length`, and optionally `safe_zone`.

Lucid and an explicit snapshot must agree on network, minimum ADA, and deposits;
the adapter rejects mismatches. The caller owns explicit snapshot freshness.
The test fixture is historical data, not a live snapshot.

## Transaction behavior

The sc backend supports Lucid's existing Shelley and Byron destination payments, mint/burn, input, reference
script, datum, validity, signer, metadata, withdrawal, certificate, voting,
proposal, treasury, composition, signing, and chaining APIs. Asset amounts,
Plutus data, native scripts, and metadata cross the bridge without converting
ledger integers or map keys through JavaScript numbers.

All completion options are supported: `presetWalletInputs`, `changeAddress`,
`coinSelection`, `canonical`, `setCollateral`, `includeLeftoverLovelaceAsFee`,
`localUPLCEval`, and `evaluator`; `setMinFee` remains a transaction-builder method.
Delayed `RedeemerBuilder` and `BuildTxWithRedeemer` callbacks use the selected
canonical inputs. The bridge returns bootstrap candidates and requests a replay
if input selection changes. Local or external execution budgets, fees, collateral,
and change converge before completion returns.

Coin selection uses convex-wallet and can select different inputs from CML.
Output order is preserved and change follows explicit outputs. Large change
bundles are partitioned to respect the maximum value size. Chaining removes the
inputs actually consumed by sc-tools. Key-witness fee estimates are conservative. External evaluators can supply synthetic
budgets for transaction inspection, as with CML; the ledger still enforces
execution limits at submission.
Canonical completion preserves the order and encoding of Plutus data, while
canonicalizing ledger containers. The signing path preserves the redeemer
encoding covered by the body hash. Wallet-provided collateral is preferred,
subject to preset inputs and protocol limits; unusable candidates fall back to
wallet UTxOs. Reference inputs may also provide collateral without being spent.
Explicit `evaluateBytes` adapters are supported. With no evaluator override,
local evaluation runs inside the sc-tools Haskell ledger.

For live chains, include `stakePools` (raw pool-key hashes), `stakeDeposits`, and
`drepDeposits` when balancing state-dependent registrations or refunds. Deposit
entries are `{ type: "Key" | "Script", hash, deposit: "decimal lovelace" }`.
When a registration's original deposit differs from current parameters, the
recorded deposit is required. Transaction submission remains with your provider.

## convex-mockchain simulator

`ScToolsEmulator` provides the existing Emulator account, query, clock,
confirmation, reward, evaluation, and submission methods. Its first three
constructor arguments are the same as `Emulator`; the fourth supplies the runtime.

```ts
import {
  ScToolsEmulator,
  generateEmulatorAccount,
  Lucid,
} from "@lucid-evolution/lucid";

const account = generateEmulatorAccount({ lovelace: 1_000_000_000n });
const emulator = new ScToolsEmulator([account], undefined, 0n, runtime);
const lucid = await Lucid(emulator, "Custom", { balancer: emulator.balancer });
lucid.selectWallet.fromSeed(account.seedPhrase);

const tx = await lucid
  .newTx()
  .pay.ToAddress(recipient, { lovelace: 2_000_000n })
  .complete();
const signed = await tx.sign.withWallet().complete();
const hash = await signed.submit();
emulator.awaitBlock();
console.log(await emulator.getTransactionStatus(hash));
```

The bridge serializes convex-mockchain's actual Conway ledger state between WASM
calls. It validates signatures, fees, conservation of value, minimum ADA,
collateral, scripts, certificates, rewards, and governance transitions. A failed
submission leaves the state unchanged, and concurrent submissions are serialized.
The JavaScript `ledger`, `mempool`, `chain`, and status fields are projections of
that state. Direct edits to `ledger`, `mempool`, `chain`, `datumTable`, `treasury`, and
`protocolParameters` remain available for fixtures. Queries retain the original
Emulator's behavior, including synchronous NFT multiplicity errors. Fixture
changes are synchronized into the actual ledger before balancing, evaluation,
reward distribution, or submission. They do not bypass validation of submitted
transactions.

`awaitSlot` and `awaitBlock` advance the simulation clock and confirm pending
transactions. `distributeRewards` credits registered, delegated accounts. As in
Lucid's Emulator, donations become available in the mock treasury immediately.
This is a transaction simulator; advancing the clock does not run a node's epoch
reward calculation or governance ratification process.

Pool delegation requires a registered pool. Register one through the transaction
API, or seed pool IDs at genesis using the optional fifth constructor argument
`{ stakePools: [poolId] }`. Genesis pool fixtures use zero deposit and default
mockchain pool data. The simulator supplies its complete chain context through
`emulator.balancer`; applications do not need to manufacture an era history.

## Compatibility baseline

This fork includes Lucid Evolution 0.8.1, upstream commit
`5394f993c22e12d090b06bbb1af3ad8d005c2b6f`, including its vendored CML,
wallet collateral API, byte evaluators, and exact `setMinFee` behavior. The older
`Maestro` export is retained so existing applications continue to compile.

The existing builder, wallet, signing, provider, and completion interfaces are
preserved. Balancer coin choices and conservative fees can differ. Real ledger
validation is stricter than the original JavaScript Emulator, so transactions
that violate Conway rules are rejected. The bridge is Conway-specific, as is
the current transaction-building target. Byron wallet spending is not added;
original Lucid's payment-credential path does not support it either.

Live-network submission has not been exercised. The simulator does not run node
epoch transitions, automatic epoch rewards, or governance ratification; the
original Emulator does not supply those capabilities either. Test results below
establish the covered contracts, not a proof of every possible input or error.

The WASM source is a separate project on the repository's `sc-tools-wasm` branch;
Lucid lives on `main`. To reproduce the bridge in a new checkout:

```sh
git clone --single-branch --branch sc-tools-wasm \
  https://github.com/SeungheonOh/lucide-evo-sc.git ~/fun/lucid-sctools-wasm
cd ~/fun/lucid-sctools-wasm
bash wasm/build.sh
```

## Verification

From the repository root:

```sh
corepack pnpm install --frozen-lockfile --filter '@lucid-evolution/lucid...'
corepack pnpm --filter '@lucid-evolution/lucid^...' build
SC_TOOLS_WASM="$HOME/.cache/lucid-sctools-wasm/output/sc-tools.wasm" \
  corepack pnpm --filter @lucid-evolution/lucid exec vitest run test/sc-tools.test.ts test/sc-tools-emulator.test.ts
SC_TOOLS_WASM="$HOME/.cache/lucid-sctools-wasm/output/sc-tools.wasm" \
  corepack pnpm --filter @lucid-evolution/lucid exec vitest run --config vitest.sctools.config.ts
SC_TOOLS_WASM="$HOME/.cache/lucid-sctools-wasm/output/sc-tools.wasm" \
  corepack pnpm --filter @lucid-evolution/lucid exec vitest run --config vitest.sctools-provider.config.ts
corepack pnpm --filter @lucid-evolution/lucid exec tsc --noEmit
```

The WASM tests balance and sign synthetic transactions locally and never submit
anything to a network. They use the actual compiled Haskell ledger, including
successful and rejected Plutus evaluation. Without `SC_TOOLS_WASM`, those tests are
explicitly skipped; adapter error-path tests still run.

The parity configuration runs the upstream transaction regressions with the
sc backend and actual mockchain. The 12 tests in `completion-evaluation.test.ts`
instrument Aiken's internal calls and CML's draft counts; they run under CML.
Equivalent SC contracts (fee-dependent final evaluation, delayed redeemers,
explicit Aiken and byte adapters) have dedicated actual-ledger tests.
`vitest.sctools-provider.config.ts` also runs upstream's 14 mutable-ledger tests. Its legacy reward fixtures use Conway protocol
version 9 and seed their assumed existing pool; the dedicated mockchain tests use
the current default parameters and explicitly delegate to a DRep for withdrawals.
Network-dependent tests retain their existing skip conditions.

Ledger validation also exposed shared CML adapter bugs corrected in this checkout:
script voter ordering, unnecessary governance datums, vote signing keys, preservation
of signed redeemer encoding, and pool margins, relay encoding, and metadata hashing.
UTxO conversion also preserves a datum hash when the datum has not been fetched,
so hash-datum Plutus V1 spending and reference inputs retain their ledger data.
These corrections preserve the public API.

See the [verification record](sc-tools-verification.md) for test results and the rebuilt artifact hash.

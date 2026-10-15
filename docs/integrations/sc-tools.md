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
import {
  Lucid,
  createScToolsWasmRuntime,
  type ScToolsChainContext,
} from "@lucid-evolution/lucid";

const runtime = await createScToolsWasmRuntime(
  await WebAssembly.compile(await readFile(wasmPath)),
);
const lucid = await Lucid(provider, "Preprod", {
  balancer: {
    type: "sc-tools",
    runtime,
    chainContext: async ({
      provider,
      network,
    }): Promise<ScToolsChainContext> => {
      // Fetch an up-to-date snapshot from your node or provider integration.
      // This callback receives the current provider, including after switchProvider().
      return getScToolsChainContext(provider, network);
    },
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
`provider`, `getScToolsChainContext`, wallet credentials, and recipient above are
application-supplied. Neither the runtime nor this adapter fetches chain state or
submits transactions automatically. Each request has isolated WASI memory; the
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

Supply the same schema used by `wasm/app/LiveTx.hs`:

- `network`: `mainnet`, `preprod`, `preview`, or `custom` (with optional `networkMagic`).
- `systemStart`: Unix seconds as a decimal string.
- `protocolParameters`: full cardano-cli Conway protocol-parameter JSON.
- `eraSummaries`: node era history with `start`, finite `end`, and `parameters`.
  Each boundary has `time`, `slot`, and `epoch`. Parameters contain `epoch_length`,
  `slot_length`, and optionally `safe_zone`.

Lucid's standard `Provider` interface is unchanged. Its reduced protocol-parameter
object cannot reconstruct the full snapshot; do not fill missing parameters or era
history with invented defaults. The caller owns snapshot freshness. Lucid and the
snapshot must agree on network, output minimum ADA, and deposit parameters; the
adapter rejects mismatches. Proposal deposits must match the snapshot's protocol
parameter. The fixture in the tests is historical test data, not a live snapshot.

## Transaction behavior

The sc backend supports Lucid's existing payment, mint/burn, input, reference
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
The signing path preserves the redeemer encoding covered by the body hash.

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
that state. Explicit reward-fixture changes through `chain[address].delegation.rewards`
are synchronized into the ledger before the next operation.

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

## Known compatibility limits

Full compatibility with every original Lucid behavior has not been achieved.
The bridge currently rejects Byron addresses, including Byron output destinations.
Existing live providers also need an additional full chain-context callback; merely
selecting the sc-tools backend is not sufficient. The bridge source and rebuilt
WASM are maintained separately in `lucid-sctools-wasm` and are not bundled in this
repository.

The regression results below cover the tested Conway transaction features.
Live-network submission and exhaustive behavior/error equivalence remain
unverified. The simulator's lack of epoch processing is a separate limitation,
not evidence of a regression against the original Emulator.

## Verification

From the repository root:

```sh
corepack pnpm install --frozen-lockfile --filter '@lucid-evolution/lucid...'
corepack pnpm --filter '@lucid-evolution/lucid^...' build
SC_TOOLS_WASM="$HOME/.cache/lucid-sctools-wasm/output/sc-tools.wasm" \
  corepack pnpm --filter @lucid-evolution/lucid exec vitest run test/sc-tools.test.ts test/sc-tools-emulator.test.ts
SC_TOOLS_WASM="$HOME/.cache/lucid-sctools-wasm/output/sc-tools.wasm" \
  corepack pnpm --filter @lucid-evolution/lucid exec vitest run --config vitest.sctools.config.ts
corepack pnpm --filter @lucid-evolution/lucid exec tsc --noEmit
```

The WASM tests balance and sign synthetic transactions locally and never submit
anything to a network. They use the actual compiled Haskell ledger, including
successful and rejected Plutus evaluation. Without `SC_TOOLS_WASM`, those tests are
explicitly skipped; adapter error-path tests still run.

The parity configuration runs the existing 148 offline regression tests with the
sc backend and actual mockchain. Its legacy reward fixtures use Conway protocol
version 9 and seed their assumed existing pool; the dedicated mockchain tests use
the current default parameters and explicitly delegate to a DRep for withdrawals.
Network-dependent tests retain their existing skip conditions.

Ledger validation also exposed shared CML adapter bugs corrected in this checkout:
script voter ordering, unnecessary governance datums, vote signing keys, preservation
of signed redeemer encoding, and pool margins, relay encoding, and metadata hashing.
These corrections preserve the public API.

See the [verification record](sc-tools-verification.md) for test results and the rebuilt artifact hash.

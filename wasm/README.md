# Build and use the transaction editor

This directory contains the WASM build recipe and application bridge. Upstream
sc-tools and all dependency sources are fetched into the external build cache.
The selected upstream libraries are `convex-base`, `convex-optics`,
`convex-wallet`, `convex-mockchain`, and `convex-coin-selection`.
The editor calls the original `Convex.BuildTx` and `Convex.CoinSelection`
libraries; it does not run a mockchain or generate test wallet funds.

## Build

On Linux, install Git, Python 3.12+, curl, patch, autoconf, automake, make,
Perl, and the archive utilities required by ghc-wasm-meta. Node.js is needed
for browser tests and the npm convenience scripts.

```sh
bash wasm/build.sh
```

The script installs the pinned GHC WASM toolchain, prepares the pinned sources
and patches, and compiles the executable. Initial compilation is substantial
because it includes the Cardano ledger. To reuse a toolchain:

```sh
GHC_WASM_PREFIX=/path/to/ghc-wasm BUILD_JOBS=4 bash wasm/build.sh
```

All generated paths are under `~/.cache/lucid-sctools-wasm`, respecting
`XDG_CACHE_HOME`. Set `SC_TOOLS_WASM_CACHE` for another external location.
Locations inside the source tree are rejected.

| Cache directory | Contents |
| --- | --- |
| `deps/`, `downloads/` | Dependency sources and verified archives |
| `toolchain/` | Default compiler installation |
| `build/` | Cabal compilation output |
| `output/sc-tools.wasm` | Raw executable |
| `output/browser/` | Runnable static editor, compressed WASM, notices, hash manifest |
| `browser-test/`, `evidence/` | Test dependencies and results |

## Use with a wallet

```sh
npm run serve
```

Open `http://127.0.0.1:4173` in a normal browser with a CIP-30 wallet extension.
The in-app browser may not have wallet extensions installed.

1. Connect the wallet. Connection requests access to public wallet data.
2. Choose the correct network. CIP-30 network ID 0 covers both Preprod and Preview;
   the provider checks a wallet UTXO against the selected network.
3. Under **Chain data**, enter a Blockfrost project ID for that network. This is
   kept in memory, and never included in recipes, downloads, or browser storage.
4. Add blocks in the Inputs, Outputs, Mint/Burn, Withdrawals, Certificates,
   Governance, and Conditions sections. Reorder blocks within a section with the
   arrow buttons or drag their headers. Output order is preserved in CBOR.
5. **Balance transaction** refreshes wallet UTXOs, loads current chain data, resolves
   additional inputs, and sends that data to the local WASM worker.
6. Inspect the selected inputs, recipient outputs, trailing wallet change, fees,
   collateral, script budgets, JSON, CBOR, and sc-tools balancing trace.
7. Download the unsigned text envelope or explicitly request wallet signatures.
   Returned witnesses are assembled into the transaction in WASM. Submission is
   a separate button and never happens automatically.

Editing a recipe invalidates its balanced and signed result. Signing also checks
wallet identity, network, selected wallet inputs, parameter freshness, and the
fee required by the returned witness count. Partial signatures can be downloaded
for another signer; a wallet accepting a signing request does not imply all
required signatures are present.

The provider uses only read requests. Transaction construction, coin selection,
balancing, Plutus evaluation, serialization, and witness assembly run in the
browser. The static server only serves files. Nothing sends private keys to the
application. The Blockfrost project ID is used in browser-to-Blockfrost requests.

## Transaction components

| Section | Blocks and fields |
| --- | --- |
| Inputs | Key, native-script, and Plutus V1/V2/V3 spending inputs; reference inputs; collateral inputs; in-transaction or reference script witnesses; inline or supplied input datums |
| Outputs | Recipient address, ADA, native assets, inline datum, datum hash, hash plus supplemental datum, and optional reference script |
| Mint/Burn | Policy ID, asset-name bytes, signed integer quantities, native or Plutus witness, optional reference script |
| Withdrawals | Reward address, amount, key or script authorization |
| Certificates | Stake registration, deregistration, pool delegation; custom Conway certificate CBOR with optional script witness |
| Governance | Voting-procedures CBOR with optional voter witnesses; proposal-procedure CBOR with optional script witness; treasury donation and optional current-treasury assertion |
| Conditions & data | Validity slots, required payment-key hashes, metadata, auxiliary scripts |

Advanced certificate and governance fields accept ledger CBOR, not an arbitrary
JSON approximation. One voting block contains the entire voting-procedures map.
The signature reserve includes Cardano's conservative estimate plus native-script
and explicitly reserved signatures. For reference native scripts and additional
signers, use **Additional signatures** as needed. It can overestimate fees when
several credentials share a key.

The editor checks transaction construction, balance, output minimum ADA, execution
budgets, and final fee/collateral consistency. It does not claim full ledger-state
validation. Reward availability, certificate registration/refund state, registered
pools, governance action existence, and later UTXO spends are ultimately checked
by the network. In particular, custom certificates whose balancing depends on
non-default pool or DRep refund state require extending the chain context.
Mainnet transactions involve real funds; inspect the actual outputs and network
in your wallet before approving them.

## Chain snapshots

Select **Import chain snapshot** to supply data obtained independently from a
node or provider. The same wallet and WASM path is used; no test UTXOs are inserted.
Snapshots must be no more than five minutes old and contain:

```json
{
  "network": "preprod",
  "fetchedAt": 1789190000000,
  "source": "Your node or provider",
  "systemStart": "1654041600",
  "tip": { "slot": 133506800, "epoch": 312, "hash": "..." },
  "protocolParameters": { "...": "cardano-cli Conway protocol-parameter JSON" },
  "eraSummaries": [
    {
      "start": { "time": 0, "slot": 0, "epoch": 0 },
      "end": { "time": 1728000, "slot": 86400, "epoch": 4 },
      "parameters": { "epoch_length": 21600, "slot_length": 20, "safe_zone": 4320 }
    }
  ],
  "resolvedInputs": []
}
```

This illustrates the schema, not a usable snapshot. Supply all actual era
summaries through the current finite safe horizon, complete protocol parameters,
and resolved non-wallet inputs needed by the recipe. `resolvedInputs` accepts
CIP-30 UTXO CBOR strings, or `{input, output}` objects matching the bridge's output
schema. There is no fallback to default protocol parameters. Koios currently
omits the required CORS header for these browser requests, so it is not offered
as an in-browser provider.

## Browser verification

With the static server running:

```sh
CHROMIUM_PATH=/path/to/chrome npm run test:browser
```

The runner installs Playwright under the external cache. The test fixture fetches
public preprod protocol parameters and confirmed era transitions, then injects a
CIP-30 test adapter with deterministic test keys and synthetic UTXOs. No real
wallet is accessed and no network transaction is submitted by the test.

The suite checks the actual editor/worker handshake, wallet decoding, ADA and
native-asset balance conservation, token minting/burning, metadata, validity,
reference inputs, withdrawals, stake certificates, governance, Plutus success
and failure, collateral coverage, 64-bit integers, witness assembly, stale-result
invalidation, and desktop/mobile layouts. Networking is disabled before
transaction work. Reports and screenshots are saved in the external `evidence/`
directory. The original matching-number contract and portability regressions
remain behind the CLI regression entry point, which is not exposed in the UI.

## WASM bridge

`LiveTx.hs` accepts JSON through an in-memory standard input. Actions are
`wallet`, `balance`, `inspect`, and `mergeWitnesses`. The request uses wallet
UTXO CBOR and change address directly. Its `MonadBlockchain` instance reads an
immutable chain-data snapshot; it never creates mockchain state or test funds.
Datum, redeemer, and metadata JSON can be supplied as raw JSON strings so large
integers reach Haskell without JavaScript rounding. Integers outside JavaScript's
exact range are returned as decimal strings in inspection JSON; transaction CBOR
retains the original integer encoding.

The worker runs `@bjorn3/browser_wasi_shim` 0.4.2, fetched into the external cache
and copied only into generated output. No JavaScript Cardano SDK implements
transaction building or balancing.

Primary interface references: [CIP-30](https://cips.cardano.org/cip/CIP-0030),
[Blockfrost API](https://docs.blockfrost.io/), and the
[pinned sc-tools source](https://github.com/input-output-hk/sc-tools/tree/4546122230491db4839a4a42fc2bc601f7900909).

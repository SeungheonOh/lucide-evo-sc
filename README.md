# Lucid sc-tools WASM bridge

This checkout adds the [Lucid bridge v2 and convex-mockchain API](wasm/LUCID-BRIDGE.md) for the separate `lucid-revolution` integration.

# sc-tools transaction studio

A browser transaction block editor backed by upstream
[sc-tools](https://github.com/input-output-hk/sc-tools), compiled to WebAssembly.
The source revision is pinned at `4546122230491db4839a4a42fc2bc601f7900909`.

Connect a CIP-30 wallet, compose inputs and outputs, add minting, withdrawals,
certificates, governance, and transaction conditions, then balance and inspect
an unsigned transaction. sc-tools performs coin selection, transaction building,
script evaluation, fee calculation, collateral calculation, and CBOR serialization
inside the browser. Wallet signatures are requested separately.

Native assets use editable rows: select an asset from the wallet or enter a
policy ID and a text/hex name. Quantities are exact whole numbers in the asset's
smallest unit. Minting rows also accept negative quantities for burning.

The balanced transaction review shows every input and output with its ADA,
native assets, datum tree, and reference script. It includes withdrawals,
certificates, governance, metadata, witnesses, scripts, redeemers, and decoded
transaction body fields. Drag the inspector's title bar to float it, drag its
Resize handle to change its size, or select Full screen. The docked pane's left
edge changes its width. Arrow keys also move/resize the focused handles; Escape
restores a full-screen inspector.

```sh
bash wasm/build.sh
npm run serve
```

Open `http://127.0.0.1:4173` in a browser with a Cardano wallet extension. Choose
Mainnet, Preprod, or Preview and enter a Blockfrost project ID for that network.
The ID stays in the current tab. The provider supplies chain data; it does not
build, balance, sign, or evaluate the transaction. A recent imported chain
snapshot can also supply the required data.

Use **Export → Copy JSON** to copy an editable transaction, then **Import** to
paste that JSON back into the editor. Both dialogs also support files. Invalid
JSON leaves the current transaction intact; a successful import clears the old
balance and signatures so the imported transaction can be balanced again.

**Examples** loads editable transactions for Preprod or Preview:

- Lock ADA with an inline integer datum, then unlock it when the redeemer equals
  that datum. A different redeemer fails during browser-side script evaluation.
- Mint and burn tokens under a native policy requiring your wallet signature.
- Mint and burn tokens under a Plutus V2 policy requiring integer redeemer `42`.
- Prepare a separate 5 ADA wallet output for collateral.

Connect a funded testnet wallet and configure chain data first. Load an example,
review its blocks, balance, inspect, sign, and submit. Wait for confirmation
before spending its outputs. The tab remembers the latest submitted lock output
and token name/quantity for each minting example, including across reloads.
Refresh the wallet after minting before loading a burn example. The same recipes
can be copied with Export and restored with Import.

These public Plutus examples are deliberately minimal: anyone who supplies the
matching datum can unlock the ADA, and anyone who supplies `42` can use the
Plutus minting policy. The example picker only supports testnets. Script bytes,
addresses and policy hashes are produced by Cardano API inside WASM; no browser
transaction library or backend builder is added.

To reuse an installed toolchain:

```sh
GHC_WASM_PREFIX=/path/to/ghc-wasm bash wasm/build.sh
```

All downloads, dependency sources, compiler installations, build output, and
browser test artifacts stay **outside this directory**, under
`~/.cache/lucid-sctools-wasm` by default. `XDG_CACHE_HOME` is respected;
`SC_TOOLS_WASM_CACHE` can select another external directory.

- `wasm/patches/`: WASM32 portability patches.
- `wasm/dependencies.json`: pinned upstream sources and checksums.
- `wasm/build.sh`, `wasm/prepare-dependencies.py`: fetch, patch, and compile.
- `cabal.wasm.project.in`: generated external Cabal project template.
- `wasm/app/LiveTx.hs`: wallet CBOR, transaction blocks, balancing, and inspection.
- `browser/`: editor, CIP-30 connection, chain reads, and WASI worker.
- `wasm/check-browser.mjs`: browser acceptance tests with a CIP-30 test adapter.

See [usage and build instructions](wasm/README.md) and
[porting notes](wasm/PORTING.md).


## Cloudflare hosting

The app is hosted at [sc.isotopy.xyz](https://sc.isotopy.xyz) using Cloudflare
Workers static assets. Cloudflare serves files only; all transaction building,
balancing, inspection, and script evaluation still happen in browser WASM.

`wrangler.jsonc` defines the Worker and custom domain. The deploy helper uses the
compiled runtime from the external cache and stages its Wrangler configuration
there. It does not copy dependencies or build output into this repository.

Install Wrangler outside the project, then deploy with a Cloudflare API token
provided in the `CLOUDFLARE_API_TOKEN` environment variable:

```sh
npm install --prefix ~/.cache/lucid-sctools-wasm/cloudflare-cli --save-dev wrangler@4.131.1
python3 -B wasm/deploy.py --dry-run
npm run deploy
```

The token needs Workers Scripts edit and the zone permissions needed to bind
`sc.isotopy.xyz`. No token is stored in source, browser code, or configuration.

```sh
npm run test:editor
npm run serve
# In another terminal:
npm run test:browser
npm run test:examples
```

Browser tests connect a CIP-30 test adapter, then disable networking before
transaction work. They cover asset editing, large integer datum inspection,
floating/resizing/full-screen review, balancing, signing, and edit invalidation.
The example tests additionally exercise lock/unlock, native and Plutus mint/burn,
rejected redeemers, and the handoff between submitted transactions. Their wallet
and chain inputs are controlled fixtures; they never submit to a real network.

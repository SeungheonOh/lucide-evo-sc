# Lucid bridge v2

This checkout extends the pinned sc-tools WASM port for the sibling
`lucid-revolution` project. The original `sc-tools-wasm` checkout is independent.
Generated dependencies, build products, and browser assets use
`~/.cache/lucid-sctools-wasm` by default. Set `GHC_WASM_PREFIX` when reusing an
existing pinned toolchain, then run `bash wasm/build.sh`.

The original JSON actions and browser editor remain available. `capabilities`
returns `bridgeVersion: 2`.

## Persistent ledger reactor

The build also produces `sc-tools-ledger.wasm`. This WASI reactor owns Lucid's
address, key, script, Plutus data, CBOR, output, and transaction operations.
`Ledger.hs` dispatches those operations to Cardano API, Cardano ledger,
cardano-crypto, Convex, and the Haskell codecs. JavaScript supplies UTF-8 JSON and
WASI services. No CML code or Rust WASM is part of this artifact.

A browser asynchronously instantiates the reactor once. It then calls the
exports synchronously, so existing synchronous Lucid utilities remain
synchronous. This avoids Chromium's 8 MB limit on synchronous WASM instantiation.
The same reactor accepts the original balancing and mockchain requests.

The ABI exports these functions:

| Export | Contract |
| --- | --- |
| `_initialize()` | Initializes WASI once through the host WASI adapter. |
| `lucid_init()` | Initializes the Haskell runtime once after WASI. |
| `lucid_alloc(length)` | Allocates an input byte buffer. |
| `lucid_run(pointer, length)` | Reads UTF-8 JSON and returns an allocated result buffer. |
| `lucid_result_len()` | Returns the previous result's byte length. |
| `lucid_free(pointer)` | Frees an allocated input or result buffer. |
| `memory` | Exposes the reactor's linear memory. |

The caller reads the result before the next request and frees both buffers.
Requests run serially within an instance. Memory views must be refreshed after
calls because Haskell can grow linear memory. The host implements WASI
`random_get` with secure operating-system or Web Crypto randomness.

Primitive requests have the form
`{ action: "ledger", operation, ...payload }`. Successful responses have
`{ ok: true, result }`. Errors have `{ ok: false, error }`. Integer values use
decimal strings when they cannot safely pass through JavaScript numbers.

| Operation | Input fields | Result |
| --- | --- | --- |
| `cbor.encode` | `value`, optional `canonical` | CBOR hex. |
| `cbor.decode` | `cbor` | A typed CBOR term. |
| `cbor.canonical` | `cbor` | Canonical CBOR hex. |
| `cbor.encodingLevel` | `cbor` | The script wrapper count, capped at two. |
| `hash.blake2b` | `hex`, `size` of 28 or 32 | Digest hex. |
| `data.encode` | Detailed-schema `data`, `canonical` | Plutus data CBOR hex. |
| `data.decode` | `cbor` | Detailed-schema Plutus data. |
| `data.hash` | `cbor` | Datum hash of the supplied encoding. |
| `address.inspect` | `address` | Lucid address details. |
| `address.fromCredentials` | `network`, `payment`, `stake` | Bech32 address. |
| `key.generate` | None | Bech32 Ed25519 private key. |
| `key.fromSeed` | `entropy`, `password`, `accountIndex`, `network`, `addressType` | Lucid seed-wallet keys and addresses. |
| `key.fromPrivate` | `privateKey` | Bech32 public key, public key hex, and key hash. |
| `key.hash` | `publicKey` as raw hex or bech32 | Key hash. |
| `key.sign` | `privateKey`, `message` as hex | Signature hex. |
| `key.verify` | `publicKey`, `message`, `signature` | Boolean. |
| `native.encode` | Native JSON `script` | Native script CBOR hex. |
| `script.hash` | Script `type`, `script` | Script hash. Plutus input contains two CBOR wrappers. |
| `script.applyParams` | `script`, datum-CBOR `params` | Applied script CBOR with one wrapper. |
| `output.encode` | Lucid `utxo` | Ledger transaction-output CBOR. |
| `output.decode` | `cbor` | Lucid transaction output. |
| `output.minAda` | `output` or `cbor`, `coinsPerUtxoByte` | Minimum lovelace. |
| `tx.inspect` | `cbor` | Transaction details, body CBOR, Lucid outputs, datums, and redeemers. |
| `tx.hash` | `cbor` | Transaction ID. |
| `tx.minFee` | `cbor`, full `protocolParameters`, CIP-30 `utxos` | Minimum ledger fee for the current signatures. |
| `tx.sign` | `cbor`, `privateKeys` | Witness-set CBOR. |
| `tx.mergeWitnesses` | `cbor`, `witnessSets` | Transaction CBOR. |
| `tx.canonical` | `cbor` | Transaction CBOR with canonical ledger containers and preserved Plutus encodings. |
| `tx.requiredKeys` | `cbor`, Lucid `utxos` | Relevant key hashes for wallet signing. |

CBOR terms use `{ int: "123" }`, `{ bytes: "abcd" }`, `{ text: "value" }`,
`{ list: [...] }`, `{ map: [[key, value]] }`, and
`{ tag: "258", value: term }`. Booleans and null are JSON literals. Lists and
maps can set `indefinite: true` to preserve their encoding. The codec also
supports `float` and `simple` terms for non-ledger CBOR consumers.

`data.encode` preserves Lucid's established Plutus ordering, duplicate-map-key
behavior, constructor encodings, and 64-byte byte-string chunks. `tx.inspect`
returns datum and redeemer bytes from Cardano's memoized ledger values. It does
not re-encode them through a JSON data model. `tx.canonical` preserves the
complete original bytes of signed transactions. For unsigned transactions it
normalizes ledger containers while retaining exact inline datum options and
witness datums. Existing script integrity commitments also preserve the complete
original datum and redeemer witness fields, including their container encodings.
Auxiliary data covered by an existing metadata hash retains its exact bytes.
Redeemer values retain their complete original encoding when
canonicalizing data would change the order of Plutus map entries.

Native scripts retain their original memoized CBOR through hashes, attached
witnesses, reference outputs, fee calculation, evaluation, and mockchain state.
Minimum ADA uses the serialized ledger output, including the original native
reference bytes. Required signing keys come from the ledger's certificate and
governance authorization rules.

`node wasm/check-ledger.mjs` checks the built reactor directly. It covers key
derivation, signatures, codecs, minimum ADA, transaction balance and signing,
and submission to the actual convex-mockchain ledger.

## Balancing

`balanceV2` accepts the original `chain`, `wallet`, `resolvedInputs`, and `blocks`
plus `options`:

- `coinSelection`: whether wallet inputs can fund the transaction.
- `canonical`: canonicalize the transaction body before fee calculation and
  evaluation, and normalize eligible redeemers before computing the script
  integrity hash. Ordered Plutus maps retain their
  encoding when canonicalization would change their value.
- `minFee`, `setCollateral`: nonnegative decimal lovelace strings.
- `explicitFee`: whether Lucid explicitly set the fee floor. Bootstrap candidates
  do not charge maximum synthetic execution budgets against that explicit fee;
  the completed transaction still pays for its actual evaluated budget.
- `includeLeftoverLovelaceAsFee`: permit ADA-only dust to become fees.
- `evaluation`: `local`, `bootstrap`, or `provided`.
- `exUnits`: Lucid evaluation results with `redeemer_tag`, `redeemer_index`, and
  `ex_units: { mem, steps }` for `provided` evaluation.
- `expectedInputs`: canonical `txHash#index` strings used to build delayed
  redeemers. A changed set returns `needsRedeemers: true` before evaluation.

The balancer uses convex-wallet coin selection, Convex.BuildTx, and the Cardano
ledger's balance, fee, minimum-output, collateral, and execution-unit functions.
It preserves explicit output order, splits large change bundles, and converges
fees and budgets. The validated legacy Cardano API body constructor is used
because the experimental conversion in the pinned API misindexes mixed
witnessless/script certificate and governance purposes.

A successful response contains `transaction.cborHex`, `inputs`, `exUnits`, and
`needsRedeemers`, plus normalized `costModels` for canonical CBOR hashing. `evaluateV2` takes the same chain and resolved inputs with a
transaction in `cbor` and returns execution units.

Wallet `utxos` are spending candidates. `collateral` contains preferred wallet
collateral; `collateralFallback` may include additional key UTxOs, including
reference inputs. Collateral-only inputs are never selected for spending.
Unusable preferences fall back to wallet funds; growing fees can extend the
preferred set within the protocol's input limit.

Shelley and Byron output addresses are accepted, including raw address hex.
Chain context supports `custom` plus `networkMagic`. Full Conway protocol
parameters can contain decimal strings for exact integer quantities. Pool IDs
and registered stake/DRep deposits can be included in `stakePools`,
`stakeDeposits`, and `drepDeposits` to calculate state-dependent deposits/refunds.

Witnesses accept `redeemerCbor`; spending blocks accept `datumCbor`; native
scripts accept `nativeScriptCbor`; metadata blocks accept metadata-map `cbor`.
These preserve ledger types and precision. Original JSON forms remain accepted.

## Existing Lucid providers

`lucidContext` accepts `network`, `protocolParameters` in cardano-cli field names,
and Lucid's `slotConfig: { zeroTime, zeroSlot, slotLength }` in milliseconds. It
returns a `chain` suitable for balancing and evaluation. Lucid supplies every
fee, execution, deposit, and transaction-limit parameter from its provider
snapshot. Only fields unused by transaction balancing come from bundled Conway
parameters. This is a balancing configuration with Lucid's slot mapping, not a
claim to reconstruct node consensus history. Decimal `systemStart` seconds and
fractional-second slot lengths are preserved.

## convex-mockchain

`{ action: "mockchain", operation, ... }` exposes:

- `init`: seed CIP-30 UTxOs, datum CBOR, treasury, and optional genesis pool IDs.
  `protocolParameters` overrides the bundled simulator defaults; `systemStart`
  is Unix seconds. Alternatively supply a complete `chain`.
- `submit`: validate and apply a signed transaction in `cbor`.
- `query`: retrieve current ledger UTxOs, datums, reward accounts, treasury, and
  the balancing chain context, including registered pools and deposits.
- `delegation`: query one reward address.
- `reward`: add `amount` to each registered, pool-delegated reward account.
- `setFixtures`: replace explicit Emulator fixtures: `utxos`, `datums`,
  `accounts: [{ address, rewards, poolId }]`, and `treasury`. Account edits retain
  existing DRep delegation and registered deposits; new account fixtures use the
  configured stake deposit. Ledger deposit and stake-distribution accounting are
  updated. Lucid synchronizes these before ledger operations, not on read-only
  JavaScript queries. A changed parameter snapshot is supplied through `chain`.
- `setRewards`: set balances of registered reward accounts using
  `updates: [{ address, rewards }]`, for Emulator fixture compatibility.

After initialization each call supplies `state`, `chain`, and `slot`. The opaque
state contains the actual serialized Conway ledger (UTxO, certificates, deposits,
pools, DReps, committee, governance proposals/votes), datum store, treasury, and
transaction index. A successful call returns the next state. Failures return no
replacement state. Lucid serializes operations and commits snapshots only after
success, so rejected or concurrent submissions cannot corrupt the simulation.

The clock does not run epoch transitions. Explicit reward distribution and
immediate donation availability match Lucid's Emulator conventions. The ledger
still performs phase-one and phase-two transaction validation; this bridge does
not replace those rules with JavaScript checks.

The sibling Lucid package contains real-WASM tests and a configuration for
running its existing transaction regressions against this backend.

Browser verification (after building, serving, and installing the browser test dependencies):

```sh
npm run test:browser
npm run test:lucid-bridge
```

The second test loads the generated worker, switches the browser offline, and
checks provider-context conversion, public fixtures, v2 balancing, signed ledger
submission, double-spend rejection, and state serialization. Set `DEMO_URL` and `CHROMIUM_PATH` for a custom server/browser.

## Source layout

The Lucid integration is on `main` and this separate WASM project is on
`sc-tools-wasm` in https://github.com/SeungheonOh/lucide-evo-sc. Neither project
embeds the other project's source tree. The original `sc-web` checkout is unchanged.

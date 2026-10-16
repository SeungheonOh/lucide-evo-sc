import { beforeAll, describe, expect, test, vi } from "vitest";
import { readFile } from "node:fs/promises";
import {
  CML,
  Lucid,
  PROTOCOL_PARAMETERS_DEFAULT,
  createScToolsWasmRuntime,
  type ScToolsRuntime,
  type ScToolsChainContext,
  type Provider,
  type UTxO,
  Data,
  validatorToAddress,
  generateSeedPhrase,
} from "../src/index.js";
import chain from "./fixtures/sc-tools/chain.json";

const wasmPath = process.env.SC_TOOLS_WASM;
const address =
  "addr_test1qrngfyc452vy4twdrepdjc50d4kvqutgt0hs9w6j2qhcdjfx0gpv7rsrjtxv97rplyz3ymyaqdwqa635zrcdena94ljs0xy950";
const funds: UTxO[] = [10, 11, 12].map((n) => ({
  txHash: n.toString(16).padStart(2, "0").repeat(32),
  outputIndex: 0,
  address,
  assets: { lovelace: 100_000_000n },
}));
const provider: Provider = {
  getProtocolParameters: async () => ({
    ...PROTOCOL_PARAMETERS_DEFAULT,
    govActionDeposit: BigInt(chain.protocolParameters.govActionDeposit),
  }),
  getDatum: async () => Data.void(),
  getUtxos: async () => funds,
  getUtxosWithUnit: async () => [],
  getUtxoByUnit: async () => {
    throw new Error("unused");
  },
  getUtxosByOutRef: async () => [],
  getDelegation: async () => ({ poolId: null, rewards: 0n }),
  awaitTx: async () => true,
  submitTx: async () => {
    throw new Error("Tests must not submit");
  },
  evaluateTx: async () => {
    throw new Error("sc-tools must evaluate locally");
  },
};
const setup = async (runtime: ScToolsRuntime) => {
  const lucid = await Lucid(provider, "Preprod", {
    balancer: {
      type: "sc-tools",
      runtime,
      chainContext: async () => chain as ScToolsChainContext,
    },
  });
  lucid.selectWallet.fromAddress(address, funds);
  return lucid;
};

describe.skipIf(!wasmPath)("sc-tools actual WASM", () => {
  let runtime: ScToolsRuntime;
  beforeAll(async () => {
    runtime = await createScToolsWasmRuntime(
      await WebAssembly.compile(await readFile(wasmPath!)),
    );
  });
  test("balances a payment and chains through the unchanged API", async () => {
    const lucid = await setup(runtime);
    const [wallet, outputs, tx] = await lucid
      .newTx()
      .pay.ToAddress(address, { lovelace: 2_000_000n })
      .chain();
    const body = tx.toTransaction().body();
    expect(body.fee()).toBeGreaterThan(0n);
    const consumed = body.inputs().len();
    expect(
      outputs.reduce((sum, u) => sum + u.assets.lovelace, 0n) + body.fee(),
    ).toBe(BigInt(consumed) * 100_000_000n);
    expect(outputs[0].assets.lovelace).toBe(2_000_000n);
    expect(wallet.length).toBe(funds.length - consumed + outputs.length);
    expect(lucid.fromTx(tx.toCBOR()).toHash()).toBe(tx.toHash());
  });
  test("accepts Byron payment destinations like CML", async () => {
    const key = CML.Bip32PrivateKey.from_bip39_entropy(
      new Uint8Array(32).fill(1),
      new Uint8Array(),
    );
    const byron = CML.AddressContent.icarus_from_key(
      key.to_public(),
      CML.ProtocolMagic.new(1),
    ).to_address();
    const legacy = await Lucid(provider, "Preprod");
    legacy.selectWallet.fromAddress(address, funds);
    const sc = await setup(runtime);
    for (const lucid of [legacy, sc]) {
      const tx = await lucid
        .newTx()
        .pay.ToAddress(byron.to_base58(), { lovelace: 2_000_000n })
        .complete();
      expect(
        tx.toTransaction().body().outputs().get(0).address().to_hex(),
      ).toBe(byron.to_address().to_hex());
    }
  });

  test("uses ordinary Provider parameters without a chain-context callback", async () => {
    const lucid = await Lucid(provider, "Preprod", {
      balancer: { type: "sc-tools", runtime },
    });
    lucid.selectWallet.fromAddress(address, funds);
    const script = {
      type: "PlutusV2" as const,
      script: "49480100002221200101",
    };
    const utxo = {
      ...funds[0],
      txHash: "33".repeat(32),
      address: validatorToAddress("Preprod", script),
      datum: Data.void(),
    };
    const tx = await lucid
      .newTx()
      .collectFrom([utxo], Data.void())
      .attach.SpendingValidator(script)
      .validTo(1_900_000_000_000)
      .pay.ToAddress(address, { lovelace: 2_000_000n })
      .complete();
    expect(tx.toTransaction().body().fee()).toBeGreaterThan(0n);
    expect(
      tx
        .toTransaction()
        .witness_set()
        .redeemers()!
        .to_flat_format()
        .get(0)
        .ex_units()
        .steps(),
    ).toBeGreaterThan(0n);
    // switchProvider refreshes the same parameter snapshot used by both backends.
    const changed = {
      ...provider,
      getProtocolParameters: async () => ({
        ...(await provider.getProtocolParameters()),
        minFeeB: 5_000_000,
      }),
    };
    await lucid.switchProvider(changed);
    const next = await lucid
      .newTx()
      .pay.ToAddress(address, { lovelace: 2_000_000n })
      .complete();
    expect(next.toTransaction().body().fee()).toBeGreaterThan(5_000_000n);
  });

  test("keeps millisecond slot mappings when deriving a provider context", async () => {
    const slotConfig = {
      zeroTime: 1_700_000_000_123,
      zeroSlot: 10,
      slotLength: 500,
    };
    const lucid = await Lucid(provider, "Custom", {
      slotConfig,
      balancer: { type: "sc-tools", runtime },
    });
    lucid.selectWallet.fromAddress(address, funds);
    const script = {
      type: "PlutusV2" as const,
      script: "49480100002221200101",
    };
    const utxo = {
      ...funds[0],
      txHash: "33".repeat(32),
      address: validatorToAddress("Custom", script),
      datum: Data.void(),
    };
    const tx = await lucid
      .newTx()
      .collectFrom([utxo], Data.void())
      .attach.SpendingValidator(script)
      .validFrom(slotConfig.zeroTime)
      .validTo(slotConfig.zeroTime + 5_000)
      .complete();
    expect(tx.toTransaction().body().validity_interval_start()).toBe(10n);
    expect(tx.toTransaction().body().ttl()).toBe(20n);
  });

  test("mints native tokens with exact quantities and metadata", async () => {
    const script = CML.NativeScript.new_script_pubkey(
      CML.Ed25519KeyHash.from_hex("11".repeat(28)),
    );
    const policy = { type: "Native" as const, script: script.to_cbor_hex() };
    const unit = script.hash().to_hex() + "abcd";
    const lucid = await setup(runtime);
    const tx = await lucid
      .newTx()
      .attach.MintingPolicy(policy)
      .mintAssets({ [unit]: 9_007_199_254_740_993n })
      .pay.ToAddress(address, { [unit]: 9_007_199_254_740_993n })
      .attachMetadata(674, { msg: ["sc-tools"] })
      .complete();
    const inspected = (await runtime.run({
      action: "inspect",
      cbor: tx.toCBOR(),
    })) as any;
    expect(inspected.transaction.mint[0].quantity).toBe("9007199254740993");
    expect(inspected.transaction.metadata["674"]).toEqual({
      msg: ["sc-tools"],
    });
  });

  test("metadata values match the default backend", async () => {
    const metadata = {
      key: "text",
      "123": "numeric-looking text key",
      "0xabcd": "hex-looking text key",
      bytes: new Uint8Array([0xab, 0xcd]),
      list: [1, "a"],
    };
    const lucid = await setup(runtime);
    const legacy = await Lucid(provider, "Preprod");
    legacy.selectWallet.fromAddress(address, funds);
    const make = (l: typeof lucid) =>
      l
        .newTx()
        .pay.ToAddress(address, { lovelace: 2_000_000n })
        .attachMetadata(674, metadata)
        .complete();
    const sc = await make(lucid),
      cml = await make(legacy);
    const actual = sc
      .toTransaction()
      .auxiliary_data()!
      .metadata()!
      .get(674n)!
      .as_map()!;
    const expected = cml
      .toTransaction()
      .auxiliary_data()!
      .metadata()!
      .get(674n)!
      .as_map()!;
    expect(actual.len()).toBe(expected.len());
    for (const name of Object.keys(metadata)) {
      const key = CML.TransactionMetadatum.new_text(name);
      expect(actual.get(key)!.to_json()).toBe(expected.get(key)!.to_json());
    }
  });
  test("evaluates a Plutus spend and sets collateral", async () => {
    const script = {
      type: "PlutusV2" as const,
      script: "49480100002221200101",
    };
    const utxo = {
      ...funds[0],
      txHash: "33".repeat(32),
      address: validatorToAddress("Preprod", script),
      datum: Data.void(),
    };
    const lucid = await setup(runtime);
    const tx = await lucid
      .newTx()
      .attach.SpendingValidator(script)
      .collectFrom([utxo], Data.void())
      .pay.ToAddress(address, { lovelace: 2_000_000n })
      .complete();
    expect(
      tx.toTransaction().body().collateral_inputs()!.len(),
    ).toBeGreaterThan(0);
    expect(tx.toTransaction().witness_set().redeemers()).toBeDefined();
  });
  test("uses reference scripts without adding their bytes to witnesses", async () => {
    const script = {
      type: "PlutusV2" as const,
      script: "49480100002221200101",
    };
    const locked = {
      ...funds[0],
      txHash: "33".repeat(32),
      address: validatorToAddress("Preprod", script),
      datum: Data.void(),
    };
    const reference = {
      ...funds[0],
      txHash: "44".repeat(32),
      scriptRef: script,
    };
    const lucid = await setup(runtime);
    const tx = await lucid
      .newTx()
      .readFrom([reference])
      .collectFrom([locked], Data.void())
      .complete();
    expect(tx.toTransaction().body().reference_inputs()!.len()).toBe(1);
    expect(
      tx.toTransaction().witness_set().plutus_v2_scripts()?.len() ?? 0,
    ).toBe(0);
  });
  test("preserves explicit inputs with coin selection disabled", async () => {
    const lucid = await setup(runtime);
    const tx = await lucid
      .newTx()
      .collectFrom([funds[0]])
      .pay.ToAddress(address, { lovelace: 2_000_000n })
      .complete({ coinSelection: false });
    expect(tx.toTransaction().body().inputs().len()).toBe(1);
  });
  test("preserves inline and supplemental datums including large integers", async () => {
    const lucid = await setup(runtime);
    const datum = Data.to(9_007_199_254_740_993n);
    const tx = await lucid
      .newTx()
      .pay.ToAddressWithData(
        address,
        { kind: "inline", value: datum },
        { lovelace: 2_000_000n },
      )
      .pay.ToAddressWithData(
        address,
        { kind: "asHash", value: datum },
        { lovelace: 2_000_000n },
      )
      .complete();
    const ws = tx.toTransaction().witness_set();
    expect(ws.plutus_datums()!.get(0).to_cbor_hex()).toBe(datum);
    expect(
      tx
        .toTransaction()
        .body()
        .outputs()
        .get(0)
        .datum()!
        .as_datum()!
        .to_cbor_hex(),
    ).toBe(datum);
  });
  test("balances stake registration and withdrawal", async () => {
    const lucid = await setup(runtime);
    const reward = CML.RewardAddress.new(
      0,
      CML.Credential.new_pub_key(CML.Ed25519KeyHash.from_hex("11".repeat(28))),
    )
      .to_address()
      .to_bech32();
    const tx = await lucid
      .newTx()
      .register.Stake(reward)
      .withdraw(reward, 1_000_000n)
      .complete();
    expect(tx.toTransaction().body().certs()!.len()).toBe(1);
    expect(tx.toTransaction().body().withdrawals()!.len()).toBe(1);
  });
  test("preserves votes, proposals, and treasury donation", async () => {
    const lucid = await setup(runtime);
    const reward = CML.RewardAddress.new(
      0,
      CML.Credential.new_pub_key(CML.Ed25519KeyHash.from_hex("11".repeat(28))),
    )
      .to_address()
      .to_bech32();
    lucid.overrideUTxOs(
      funds.map((u) => ({ ...u, assets: { lovelace: 2_000_000_000n } })),
    );
    const tx = await lucid
      .newTx()
      .vote(
        { type: "DRep", credential: { type: "Key", hash: "11".repeat(28) } },
        { txHash: "22".repeat(32), index: 0 },
        "Yes",
      )
      .propose({
        action: { type: "InfoAction" },
        returnAddress: reward,
        deposit: BigInt(chain.protocolParameters.govActionDeposit),
        anchor: { url: "https://example.com", dataHash: "33".repeat(32) },
      })
      .donateToTreasury(2_000_000n, 1_000_000_000n)
      .complete();
    const body = tx.toTransaction().body();
    expect(body.voting_procedures()!.len()).toBe(1);
    expect(body.proposal_procedures()!.len()).toBe(1);
    expect(body.donation()).toBe(2_000_000n);
  });

  test("rejects an incorrect Plutus redeemer without returning a transaction", async () => {
    const examples = (await runtime.run({
      action: "exampleScripts",
      network: "preprod",
    })) as any;
    const script = {
      type: "PlutusV2" as const,
      script: examples.matchingNumber.scriptCbor,
    };
    const utxo = {
      ...funds[0],
      txHash: "33".repeat(32),
      address: examples.matchingNumber.address,
      datum: Data.to(42n),
    };
    const lucid = await setup(runtime);
    await expect(
      lucid
        .newTx()
        .attach.SpendingValidator(script)
        .collectFrom([utxo], Data.to(41n))
        .complete(),
    ).rejects.toThrow("sc-tools balance failed");
    await lucid
      .newTx()
      .attach.SpendingValidator(script)
      .collectFrom([utxo], Data.to(42n))
      .complete();
  });
  test("completion is repeatable and compose preserves action order", async () => {
    const lucid = await setup(runtime);
    const builder = lucid
      .newTx()
      .pay.ToAddress(address, { lovelace: 2_000_000n })
      .compose(lucid.newTx().pay.ToAddress(address, { lovelace: 3_000_000n }));
    const first = await builder.complete();
    const second = await builder.complete();
    expect(second.toCBOR()).toBe(first.toCBOR());
    expect(first.toTransaction().body().outputs().get(1).amount().coin()).toBe(
      3_000_000n,
    );
  });
  test("signs sc-tools transactions using the existing wallet API", async () => {
    const lucid = await setup(runtime);
    lucid.selectWallet.fromSeed(generateSeedPhrase());
    const ownAddress = await lucid.wallet().address();
    lucid.overrideUTxOs(funds.map((u) => ({ ...u, address: ownAddress })));
    const tx = await lucid
      .newTx()
      .pay.ToAddress(address, { lovelace: 2_000_000n })
      .complete();
    const signed = await tx.sign.withWallet().complete();
    expect(signed.toHash()).toBe(tx.toHash());
    expect(
      CML.Transaction.from_cbor_hex(signed.toCBOR())
        .witness_set()
        .vkeywitnesses()!
        .len(),
    ).toBeGreaterThan(0);
  });
});

describe("sc-tools errors", () => {
  test("surfaces engine errors through completeSafe", async () => {
    const lucid = await setup({
      run: async () => ({ ok: false, error: "insufficient funds" }),
    });
    const result = await lucid
      .newTx()
      .pay.ToAddress(address, { lovelace: 2_000_000n })
      .completeSafe();
    expect(result._tag).toBe("Left");
    expect(String((result as any).left)).toContain("insufficient funds");
  });

  test("rejects mismatched chain deposits before balancing", async () => {
    const run = vi.fn();
    const lucid = await setup({ run });
    lucid.config().balancer!.chainContext = async () =>
      ({
        ...chain,
        protocolParameters: {
          ...chain.protocolParameters,
          stakeAddressDeposit: 3_000_000,
        },
      }) as ScToolsChainContext;
    await expect(
      lucid.newTx().pay.ToAddress(address, { lovelace: 2_000_000n }).complete(),
    ).rejects.toThrow("keyDeposit");
    expect(run).not.toHaveBeenCalled();
  });
  test("uses the switched provider when requesting chain context", async () => {
    const lucid = await setup({
      run: async () => ({ ok: false, error: "test stop" }),
    });
    const context = vi.fn(async () => chain as ScToolsChainContext);
    lucid.config().balancer!.chainContext = context;
    const nextProvider = { ...provider };
    await lucid.switchProvider(nextProvider);
    await lucid
      .newTx()
      .pay.ToAddress(address, { lovelace: 2_000_000n })
      .completeSafe();
    expect(context).toHaveBeenCalledWith(
      expect.objectContaining({ provider: nextProvider, network: "Preprod" }),
    );
  });
});

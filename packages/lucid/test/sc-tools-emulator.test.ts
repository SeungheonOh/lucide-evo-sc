import { beforeAll, describe, expect, test, vi } from "vitest";
import { readFile } from "node:fs/promises";
import {
  mintingPolicyToId,
  CML,
  Data,
  Lucid,
  ScToolsEmulator,
  createScToolsWasmRuntime,
  generateEmulatorAccount,
  validatorToAddress,
  validatorToRewardAddress,
  type ScToolsRuntime,
  type TxSignBuilder,
  type LucidEvolution,
  type EmulatorAccount,
  PROTOCOL_PARAMETERS_DEFAULT,
} from "../src/index.js";
import { alwaysSucceedV3Script } from "./fixtures/scripts.js";

const wasmPath = process.env.SC_TOOLS_WASM;
describe.skipIf(!wasmPath)("convex-mockchain actual WASM", () => {
  let runtime: ScToolsRuntime;
  beforeAll(async () => {
    runtime = await createScToolsWasmRuntime(
      await WebAssembly.compile(await readFile(wasmPath!)),
    );
  });
  const setup = async (extras: EmulatorAccount[] = []) => {
    const account = generateEmulatorAccount({ lovelace: 1_000_000_000_000n });
    const emulator = new ScToolsEmulator(
      [account, ...extras],
      undefined,
      100_000n,
      runtime,
    );
    const lucid = await Lucid(emulator, "Custom", {
      balancer: emulator.balancer,
    });
    lucid.selectWallet.fromSeed(account.seedPhrase);
    return { account, emulator, lucid };
  };
  const submit = async (lucid: LucidEvolution, tx: TxSignBuilder) => {
    const signed = await tx.sign.withWallet().complete();
    const hash = await lucid.config().provider!.submitTx(signed.toCBOR());
    await lucid.awaitTx(hash);
    return signed;
  };
  test("validates signed payments, confirms, rejects double spends atomically, and recovers", async () => {
    const { lucid, account, emulator } = await setup();
    const recipient = generateEmulatorAccount({ lovelace: 0n });
    const tx = await lucid
      .newTx()
      .pay.ToAddress(recipient.address, { lovelace: 2_000_000n })
      .complete();
    await expect(emulator.submitTx(tx.toCBOR())).rejects.toThrow();
    expect(await emulator.getUtxos(account.address)).toHaveLength(1);
    const signed = await tx.sign.withWallet().complete();
    const hash = await signed.submit();
    expect((await emulator.getTransactionStatus(hash)).status).toBe("pending");
    expect(await emulator.getUtxos(recipient.address)).toHaveLength(0);
    await expect(emulator.submitTx(signed.toCBOR())).rejects.toThrow();
    await emulator.awaitTx(hash);
    expect((await emulator.getTransactionStatus(hash)).status).toBe(
      "confirmed",
    );
    expect(
      (await emulator.getUtxos(recipient.address))[0].assets.lovelace,
    ).toBe(2_000_000n);
    await submit(
      lucid,
      await lucid
        .newTx()
        .pay.ToAddress(account.address, { lovelace: 2_000_000n })
        .complete(),
    );
  });
  test("runs Plutus validation and provider evaluation, handles inline and supplemental datums", async () => {
    const { lucid, account, emulator } = await setup();
    const script = {
      type: "PlutusV2" as const,
      script: "49480100002221200101",
    };
    const lockedAddress = validatorToAddress("Custom", script);
    await submit(
      lucid,
      await lucid
        .newTx()
        .pay.ToContract(
          lockedAddress,
          { kind: "inline", value: Data.void() },
          { lovelace: 10_000_000n },
        )
        .pay.ToContract(
          lockedAddress,
          { kind: "asHash", value: Data.to(42n) },
          { lovelace: 10_000_000n },
        )
        .complete(),
    );
    const locked = await emulator.getUtxos(lockedAddress);
    expect(locked).toHaveLength(2);
    const hashed = locked.find((u) => u.datumHash)!;
    expect(await emulator.getDatum(hashed.datumHash!)).toBe(Data.to(42n));
    const tx = await lucid
      .newTx()
      .collectFrom(locked, Data.void())
      .attach.SpendingValidator(script)
      .pay.ToAddress(account.address, { lovelace: 2_000_000n })
      .complete({ localUPLCEval: false, setCollateral: 7_000_000n });
    expect(tx.toTransaction().body().total_collateral()).toBe(7_000_000n);
    await submit(lucid, tx);
    expect(await emulator.getUtxos(lockedAddress)).toHaveLength(0);
  });
  test("preserves custom fees and metadata map key types", async () => {
    const { lucid, account } = await setup();
    const tx = await lucid
      .newTx()
      .pay.ToAddress(account.address, { lovelace: 2_000_000n })
      .attachMetadata(674, {
        "123": "text",
        "0x01": "also text",
        integer: Number.MAX_SAFE_INTEGER,
      })
      .setMinFee(1_000_000n)
      .complete();
    expect(tx.toTransaction().body().fee()).toBe(1_000_000n);
    await submit(lucid, tx);
  });
  test("tracks stake registration deposits and refunds in the real ledger", async () => {
    const { lucid, emulator } = await setup();
    const reward = (await lucid.wallet().rewardAddress())!;
    await submit(lucid, await lucid.newTx().register.Stake(reward).complete());
    expect((await emulator.getRewardAccount(reward)).registered).toBe(true);
    expect((await emulator.getChainContext()).stakeDeposits).toHaveLength(1);
    await submit(
      lucid,
      await lucid.newTx().deregister.Stake(reward).complete(),
    );
    expect((await emulator.getRewardAccount(reward)).registered).toBe(false);
    expect((await emulator.getChainContext()).stakeDeposits).toHaveLength(0);
  });
  test("tracks DRep state and validates duplicate registrations", async () => {
    const { lucid, emulator, account } = await setup();
    const credential = CML.Address.from_bech32(account.address).payment_cred()!;
    const drep = CML.RewardAddress.new(0, credential)
      .to_address()
      .to_bech32(undefined);
    await submit(lucid, await lucid.newTx().register.DRep(drep).complete());
    expect((await emulator.getChainContext()).drepDeposits).toHaveLength(1);
    const duplicate = await lucid.newTx().register.DRep(drep).complete();
    const signed = await duplicate.sign.withWallet().complete();
    await expect(signed.submit()).rejects.toThrow();
    await submit(lucid, await lucid.newTx().deregister.DRep(drep).complete());
    expect((await emulator.getChainContext()).drepDeposits).toHaveLength(0);
  });
  test("treasury donations remain queryable across subsequent transactions", async () => {
    const { lucid, emulator } = await setup();
    for (let n = 1n; n <= 2n; n++) {
      await submit(
        lucid,
        await lucid.newTx().donateToTreasury(1_000_000n).complete(),
      );
      expect(await emulator.getTreasury()).toBe(100_000n + n * 1_000_000n);
    }
  });
  test.each(["sc-tools", "cml"])(
    "submits mixed script/key Conway votes through the ledger with %s",
    async (backend) => {
      const setupResult = await setup();
      const { emulator, account } = setupResult;
      const lucid =
        backend === "sc-tools"
          ? setupResult.lucid
          : await Lucid(emulator, "Custom");
      lucid.selectWallet.fromSeed(account.seedPhrase);
      const reward = (await lucid.wallet().rewardAddress())!;
      const cred = CML.RewardAddress.from_address(
        CML.Address.from_bech32(reward),
      )!.payment();
      await submit(
        lucid,
        await lucid
          .newTx()
          .register.Stake(reward)
          .register.DRep(reward)
          .complete(),
      );
      const proposal = await lucid
        .newTx()
        .propose({
          action: { type: "InfoAction" },
          returnAddress: reward,
          anchor: {
            url: "https://example.com/proposal",
            dataHash: "33".repeat(32),
          },
        })
        .complete();
      const proposalHash = proposal.toHash();
      await submit(lucid, proposal);
      await submit(
        lucid,
        await lucid
          .newTx()
          .vote(
            {
              type: "DRep",
              credential: { type: "Key", hash: cred.as_pub_key()!.to_hex() },
            },
            { txHash: proposalHash, index: 0 },
            "Yes",
          )
          .complete(),
      );
      const scriptReward = validatorToRewardAddress(
        "Custom",
        alwaysSucceedV3Script,
      );
      await submit(
        lucid,
        await lucid
          .newTx()
          .attach.CertificateValidator(alwaysSucceedV3Script)
          .register.DRep(scriptReward, undefined, Data.void())
          .complete(),
      );
      const voted = await lucid
        .newTx()
        .attach.VoteValidator(alwaysSucceedV3Script)
        .vote(
          {
            type: "DRep",
            credential: { type: "Key", hash: cred.as_pub_key()!.to_hex() },
          },
          { txHash: proposalHash, index: 0 },
          "No",
        )
        .vote(
          {
            type: "DRep",
            credential: {
              type: "Script",
              hash: mintingPolicyToId(alwaysSucceedV3Script),
            },
          },
          { txHash: proposalHash, index: 0 },
          "Yes",
          undefined,
          (ctx) => {
            expect(ctx.ownPurpose.index).toBe(0n);
            return Data.void();
          },
        )
        .complete();
      await submit(lucid, voted);
      expect((await emulator.getChainContext()).drepDeposits).toHaveLength(2);
    },
  );
  test.each([0, 0.125])(
    "registers a pool with margin %s, relays and metadata, distributes rewards, withdraws, and retires",
    async (margin) => {
      const { lucid, emulator, account } = await setup();
      const reward = (await lucid.wallet().rewardAddress())!;
      const key = CML.Address.from_bech32(account.address)
        .payment_cred()!
        .as_pub_key()!;
      const poolId = key.to_bech32("pool");
      const metadata =
        '{"name":"Fixture","ticker":"SC","homepage":"https://example.com","description":"Test pool"}';
      const fetchMock = vi
        .spyOn(globalThis, "fetch")
        .mockResolvedValue(new Response(metadata));
      let poolTx: TxSignBuilder;
      try {
        poolTx = await lucid
          .newTx()
          .register.Pool({
            poolId,
            vrfKeyHash: "00".repeat(32),
            pledge: 0n,
            cost: 340_000_000n,
            margin,
            rewardAddress: reward,
            owners: [reward],
            metadataUrl: "https://example.com/pool.json",
            relays: [
              {
                type: "SingleHostIp",
                ipV4: "192.0.2.1",
                ipV6: "2001:db8::1",
                port: 3001,
              },
              {
                type: "SingleHostDomainName",
                domainName: "relay.example.com",
                port: 3001,
              },
              { type: "MultiHost", domainName: "relays.example.com" },
            ],
          })
          .registerAndDelegate.ToPoolAndDRep(reward, poolId, {
            __typename: "AlwaysAbstain",
          })
          .complete();
      } finally {
        fetchMock.mockRestore();
      }
      const params = poolTx
        .toTransaction()
        .body()
        .certs()!
        .get(0)
        .as_pool_registration()!
        .pool_params();
      expect(params.margin().start()).toBe(margin === 0 ? 0n : 1n);
      expect(params.margin().end()).toBe(margin === 0 ? 1n : 8n);
      expect(params.relays().len()).toBe(3);
      expect(params.pool_metadata()!.pool_metadata_hash().to_hex()).toBe(
        "953a8195fedf3b7ef6da7d8f4a42b3657bf9c2120730775b3d826d0ecf6365f2",
      );
      await submit(lucid, poolTx);
      expect((await emulator.getChainContext()).stakePools).toEqual([
        key.to_hex(),
      ]);
      emulator.distributeRewards(5_000_000n);
      expect((await emulator.getDelegation(reward)).rewards).toBe(5_000_000n);
      await submit(
        lucid,
        await lucid.newTx().withdraw(reward, 5_000_000n).complete(),
      );
      expect((await emulator.getDelegation(reward)).rewards).toBe(0n);
      const payment = await lucid
        .newTx()
        .pay.ToAddress(account.address, { lovelace: 2_000_000n })
        .complete();
      const signedPayment = await payment.sign.withWallet().complete();
      const pendingPayment = emulator.submitTx(signedPayment.toCBOR());
      emulator.distributeRewards(1_000_000n);
      emulator.distributeRewards(2_000_000n);
      await pendingPayment;
      expect((await emulator.getDelegation(reward)).rewards).toBe(3_000_000n);
      emulator.awaitBlock();
      await submit(
        lucid,
        await lucid.newTx().retire.Pool(poolId, 1n).complete(),
      );
    },
  );
  test("resolves both delayed redeemer APIs using the selected canonical inputs", async () => {
    const { lucid, account } = await setup();
    const policyId = mintingPolicyToId(alwaysSucceedV3Script);
    const unit = policyId + "01";
    const observed: bigint[] = [];
    const tx = await lucid
      .newTx()
      .attach.MintingPolicy(alwaysSucceedV3Script)
      .mintAssets({ [unit]: 1n }, (ctx) => {
        observed.push(ctx.ownPurpose.index);
        expect(ctx.inputs.length).toBeGreaterThan(0);
        return Data.to(ctx.ownPurpose.index);
      })
      .pay.ToAddress(account.address, { [unit]: 1n })
      .complete();
    expect(observed.length).toBeGreaterThan(0);
    await submit(lucid, tx);
    const scriptAddress = validatorToAddress("Custom", alwaysSucceedV3Script);
    await submit(
      lucid,
      await lucid
        .newTx()
        .pay.ToAddress(scriptAddress, { lovelace: 10_000_000n })
        .complete(),
    );
    const locked = await lucid.utxosAt(scriptAddress);
    await submit(
      lucid,
      await lucid
        .newTx()
        .attach.SpendingValidator(alwaysSucceedV3Script)
        .collectFrom(locked, {
          kind: "self",
          makeRedeemer: (index) => Data.to(index),
        })
        .complete(),
    );
  });

  test("splits large token change into ledger-valid outputs without losing assets", async () => {
    const tokens = Object.fromEntries(
      Array.from({ length: 40 }, (_, i) => [
        "ab".repeat(28) + i.toString(16).padStart(64, "0"),
        1n,
      ]),
    );
    const account = generateEmulatorAccount({
      lovelace: 100_000_000n,
      ...tokens,
    });
    const emulator = new ScToolsEmulator(
      [account],
      { ...PROTOCOL_PARAMETERS_DEFAULT, maxValSize: 256 },
      0n,
      runtime,
    );
    const lucid = await Lucid(emulator, "Custom", {
      balancer: emulator.balancer,
    });
    lucid.selectWallet.fromSeed(account.seedPhrase);
    const recipient = generateEmulatorAccount({ lovelace: 0n });
    const tx = await lucid
      .newTx()
      .pay.ToAddress(recipient.address, { lovelace: 2_000_000n })
      .complete();
    expect(tx.toTransaction().body().outputs().len()).toBeGreaterThan(2);
    await submit(lucid, tx);
    const received = (await emulator.getUtxos(account.address)).reduce<
      Record<string, bigint>
    >((sum, u) => {
      for (const [unit, amount] of Object.entries(u.assets))
        sum[unit] = (sum[unit] ?? 0n) + amount;
      return sum;
    }, {});
    for (const [unit, amount] of Object.entries(tokens))
      expect(received[unit]).toBe(amount);
  });
  test("allows explicit ADA dust fees and refuses to add funds when selection is disabled", async () => {
    const account = generateEmulatorAccount({ lovelace: 3_000_000n });
    const emulator = new ScToolsEmulator([account], undefined, 0n, runtime);
    const lucid = await Lucid(emulator, "Custom", {
      balancer: emulator.balancer,
    });
    lucid.selectWallet.fromSeed(account.seedPhrase);
    const inputs = await lucid.wallet().getUtxos();
    const make = () =>
      lucid
        .newTx()
        .collectFrom(inputs)
        .pay.ToAddress(account.address, { lovelace: 2_000_000n });
    await expect(make().complete({ coinSelection: false })).rejects.toThrow();
    const tx = await make().complete({
      coinSelection: false,
      includeLeftoverLovelaceAsFee: true,
    });
    expect(tx.toTransaction().body().fee()).toBe(1_000_000n);
    expect(tx.toTransaction().body().outputs().len()).toBe(1);
    await submit(lucid, tx);
  });
});

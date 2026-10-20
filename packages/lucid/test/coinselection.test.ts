import { describe, expect, test } from "vitest";
import {
  Emulator,
  generateEmulatorAccount,
  Lucid,
  type Assets,
} from "../src/index.js";

const assets = (lovelace: bigint, count: number): Assets => ({
  lovelace,
  ...Object.fromEntries(
    Array.from({ length: count }, (_, i) => [
      "ab".repeat(28) + i.toString(16).padStart(64, "0"),
      BigInt(i + 1),
    ]),
  ),
});
const sum = (values: Assets[]): Assets =>
  values.reduce<Assets>((total, value) => {
    for (const [unit, amount] of Object.entries(value))
      total[unit] = (total[unit] ?? 0n) + amount;
    return total;
  }, {});

// Exercise the public balancer with the upstream wallet shapes. Input order is
// an implementation choice; funds, token change, fees and ledger acceptance are
// the contract. Genesis fixtures may contain outputs below minimum ADA.
describe("Haskell coin selection", () => {
  test.each([
    {
      name: "one adequately funded input",
      inputs: [
        assets(5_000_000n, 0),
        assets(9_798_383n, 0),
        assets(3_662_726n, 7),
      ],
      payment: 5_000_000n,
    },
    {
      name: "multiple inputs with token change",
      inputs: [
        assets(798_383n, 0),
        assets(5_000_000n, 1),
        assets(3_662_726n, 7),
      ],
      payment: 5_900_000n,
    },
    {
      name: "small inputs needed for minimum change",
      inputs: [assets(798_383n, 0), assets(5_000_000n, 0), assets(466_272n, 0)],
      payment: 4_800_000n,
    },
    {
      name: "token-rich wallet needs extra ADA",
      inputs: [
        assets(798_383n, 5),
        assets(5_000_000n, 40),
        assets(466_272n, 7),
        ...Array.from({ length: 6 }, () => assets(1_000_000n, 0)),
        assets(905_327n, 0),
        assets(781_143n, 0),
      ],
      payment: 5_200_000n,
    },
    {
      name: "fee-only consolidation",
      inputs: [assets(798_383n, 0), assets(100_000n, 0), assets(466_272n, 0)],
      payment: 0n,
    },
  ])("preserves every asset: $name", async ({ inputs, payment }) => {
    const account = generateEmulatorAccount({ lovelace: 0n });
    const recipient = generateEmulatorAccount({ lovelace: 0n });
    const emulator = new Emulator(
      inputs.map((assets) => ({ ...account, assets })),
    );
    const lucid = await Lucid(emulator, "Custom");
    lucid.selectWallet.fromSeed(account.seedPhrase);
    const builder = lucid.newTx();
    if (payment)
      builder.pay.ToAddress(recipient.address, { lovelace: payment });
    const unsigned = await builder.complete();
    const signed = await unsigned.sign.withWallet().complete();
    expect(await signed.submit()).toBe(signed.toHash());
    emulator.awaitBlock();
    const receiver = await emulator.getUtxos(recipient.address);
    expect(sum(receiver.map((utxo) => utxo.assets)).lovelace ?? 0n).toBe(
      payment,
    );
    const after = sum(
      [...(await emulator.getUtxos(account.address)), ...receiver].map(
        (utxo) => utxo.assets,
      ),
    );
    after.lovelace += unsigned.toTransaction().body.fee;
    expect(after).toEqual(sum(inputs));
  });

  test("rejects insufficient ADA for payment, fees and token change", async () => {
    const account = generateEmulatorAccount({ lovelace: 0n });
    const inputs = [
      assets(798_383n, 5),
      assets(5_000_000n, 40),
      assets(466_272n, 7),
    ];
    const emulator = new Emulator(
      inputs.map((assets) => ({ ...account, assets })),
    );
    const lucid = await Lucid(emulator, "Custom");
    lucid.selectWallet.fromSeed(account.seedPhrase);
    await expect(
      lucid
        .newTx()
        .pay.ToAddress(account.address, { lovelace: 5_200_000n })
        .complete(),
    ).rejects.toThrow();
  });
});

import { describe, expect, test } from "vitest";
import { Lucid } from "../src/index.js";
import { Emulator, generateEmulatorAccount } from "../../provider/src/index.js";

describe("Treasury donation", () => {
  test("builds and submits a treasury donation transaction", async () => {
    const initialTreasury = 123_000_000n;
    const donation = 2_000_000n;
    const account = generateEmulatorAccount({ lovelace: 80_000_000n });
    const emulator = new Emulator([account], undefined, initialTreasury);
    const lucid = await Lucid(emulator, "Custom");
    lucid.selectWallet.fromSeed(account.seedPhrase);

    const signBuilder = await lucid
      .newTx()
      .donateToTreasury(donation)
      .complete();
    const body = signBuilder.toTransaction().body;

    expect(body.currentTreasury).toBe(initialTreasury);
    expect(body.treasuryDonation).toBe(donation);
    expect(body.fee).toBeGreaterThan(0n);
    expect(signBuilder.toHash()).toHaveLength(64);

    const signed = await signBuilder.sign.withWallet().complete();
    await signed.submit();

    expect(await emulator.getTreasury()).toBe(initialTreasury + donation);
  });
});

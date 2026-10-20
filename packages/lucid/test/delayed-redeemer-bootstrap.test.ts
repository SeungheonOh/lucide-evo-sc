import { describe, expect, test } from "vitest";
import { Data } from "@lucid-evolution/plutus";
import {
  Emulator,
  generateEmulatorAccount,
  Lucid,
  PROTOCOL_PARAMETERS_DEFAULT,
  validatorToAddress,
} from "../src/index.js";
import { alwaysSucceedV3Script } from "./fixtures/scripts.js";
describe("delayed redeemer bootstrap with setMinFee", () => {
  test("an explicitly funded fee is not charged the maximum transaction budget", async () => {
    const account = generateEmulatorAccount({ lovelace: 100_000_000n });
    const emulator = new Emulator([account], PROTOCOL_PARAMETERS_DEFAULT);
    const lucid = await Lucid(emulator, "Custom");
    lucid.selectWallet.fromSeed(account.seedPhrase);
    const address = await lucid.wallet().address();
    const scriptAddress = validatorToAddress("Custom", alwaysSucceedV3Script);
    const locked = await lucid
      .newTx()
      .pay.ToAddress(scriptAddress, { lovelace: 10_000_000n })
      .complete();
    await lucid.awaitTx(
      await (await locked.sign.withWallet().complete()).submit(),
    );
    const [scriptUtxo] = await lucid.utxosAt(scriptAddress);

    // The script input funds exactly a 9.5 ADA payment and a 0.5 ADA fee, so
    // there is no change output. A bootstrap fee for the maximum transaction
    // budget (over 1 ADA) is more than the input can pay.
    const fee = 500_000n;
    const { maxTxExMem, maxTxExSteps, priceMem, priceStep } =
      PROTOCOL_PARAMETERS_DEFAULT;
    expect(
      Math.ceil(
        Number(maxTxExMem) * priceMem + Number(maxTxExSteps) * priceStep,
      ),
    ).toBeGreaterThan(1_000_000);
    let callbacks = 0;
    const completed = await lucid
      .newTx()
      .collectFrom([scriptUtxo], () => {
        callbacks++;
        return Data.void();
      })
      .attach.SpendingValidator(alwaysSucceedV3Script)
      .pay.ToAddress(address, { lovelace: 9_500_000n })
      .setMinFee(fee)
      .complete({ coinSelection: false });

    const tx = completed.toTransaction();
    expect(callbacks).toBeGreaterThan(0);
    expect(tx.body.fee).toBe(fee);
    expect(tx.body.inputs.length).toBe(1);
    expect(tx.body.outputs.length).toBe(1);
    const redeemers = tx.redeemers;
    expect(redeemers.length).toBe(1);
    // The final redeemer carries real evaluated ex-units, not the bootstrap.
    expect(redeemers[0].exUnits.mem).toBeGreaterThan(0n);
    expect(redeemers[0].exUnits.steps).toBeGreaterThan(0n);
    expect(redeemers[0].exUnits.mem).toBeLessThan(maxTxExMem);

    await lucid.awaitTx(
      await (await completed.sign.withWallet().complete()).submit(),
    );
    expect(await lucid.utxosAt(scriptAddress)).toHaveLength(0);
  });
});

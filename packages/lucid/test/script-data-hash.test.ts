import { expect, test } from "vitest";
import { Constr, Data } from "@lucid-evolution/plutus";
import {
  Emulator,
  generateEmulatorAccount,
  Lucid,
  PROTOCOL_PARAMETERS_DEFAULT,
  applyDoubleCborEncoding,
  fromText,
  mintingPolicyToId,
  validatorToRewardAddress,
} from "../src/index.js";
import scripts from "./specs/contracts/plutus.json" assert { type: "json" };

test("refreshes script data hash from final redeemer witnesses", async () => {
  const account = generateEmulatorAccount({ lovelace: 75_000_000_000n });
  const emulator = new Emulator([account], PROTOCOL_PARAMETERS_DEFAULT);
  const lucid = await Lucid(emulator, "Custom");
  lucid.selectWallet.fromSeed(account.seedPhrase);

  const mint = {
    type: "PlutusV3",
    script: applyDoubleCborEncoding(
      scripts.validators.find(
        (validator) => validator.title === "simple_mint.mint_policy.mint",
      )!.compiledCode,
    ),
  } as const;
  const stake = {
    type: "PlutusV3",
    script: applyDoubleCborEncoding(
      scripts.validators.find(
        (validator) => validator.title === "simple_mint.mint_policy.withdraw",
      )!.compiledCode,
    ),
  } as const;

  const policyId = mintingPolicyToId(mint);
  const rewardAddress = validatorToRewardAddress("Custom", stake);
  const registration = await lucid
    .newTx()
    .register.Stake(rewardAddress)
    .complete();
  await (await registration.sign.withWallet().complete()).submit();
  emulator.awaitBlock();
  const signBuilder = await lucid
    .newTx()
    .mintAssets(
      { [policyId + fromText("MintWithdraw")]: 1n },
      Data.to(new Constr(0, [1n])),
    )
    .withdraw(rewardAddress, 0n, Data.to(new Constr(0, [fromText("1")])))
    .attach.WithdrawalValidator(stake)
    .attach.MintingPolicy(mint)
    .complete();
  const tx = signBuilder.toTransaction();
  expect(tx.redeemers).toHaveLength(2);
  expect(tx.body.scriptDataHash).toMatch(/^[0-9a-f]{64}$/);
  // Ledger submission independently checks the final integrity hash against
  // the actual redeemer bytes, execution budgets, datums, and language views.
  const signed = await signBuilder.sign.withWallet().complete();
  expect(await signed.submit()).toBe(tx.hash);
});

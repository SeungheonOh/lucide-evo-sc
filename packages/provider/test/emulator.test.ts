import { ProtocolParameters } from "@lucid-evolution/core-types";
import { assert, describe, test } from "vitest";
import { PROTOCOL_PARAMETERS_DEFAULT } from "@lucid-evolution/utils";
import { Emulator, generateEmulatorAccount } from "../src/index.js";
import { Effect } from "effect";
import { expect } from "vitest";
import { Lucid } from "../../lucid/src/index.js";
import * as PreprodConstants from "./preprod-constants.js";

export const EMULATOR_ACCOUNT = generateEmulatorAccount({
  lovelace: 80000000000n,
});

export const emulator = await Effect.gen(function* () {
  return new Emulator([EMULATOR_ACCOUNT]);
}).pipe(Effect.runPromise);

describe.sequential("Emulator", () => {
  test("Get Protocol Parameters", async () => {
    const pp: ProtocolParameters = await emulator.getProtocolParameters();
    assert.deepEqual(pp, PROTOCOL_PARAMETERS_DEFAULT);
  });

  test("Get Treasury", async () => {
    const treasury = 42_000_000n;
    const localEmulator = new Emulator([EMULATOR_ACCOUNT], undefined, treasury);
    assert.equal(await localEmulator.getTreasury(), treasury);
  });

  test("Get Reward Account distinguishes registration state", async () => {
    const localEmulator = new Emulator([EMULATOR_ACCOUNT]);
    const rewardAddress =
      "stake_test17zt3vxfjx9pjnpnapa65lx375p2utwxmpc8afj053h0l3vgc8a3g3";

    assert.deepEqual(await localEmulator.getRewardAccount(rewardAddress), {
      registered: false,
      poolId: null,
      rewards: 0n,
    });

    localEmulator.chain[rewardAddress] = {
      registeredStake: true,
      delegation: { poolId: null, rewards: 0n },
    };
    assert.deepEqual(await localEmulator.getRewardAccount(rewardAddress), {
      registered: true,
      poolId: null,
      rewards: 0n,
    });
  });

  test("Correct Start Balance", async () => {
    const utxos = await emulator.getUtxos(EMULATOR_ACCOUNT.address);
    const lovelace = utxos.reduce(
      (amount: any, utxo: any) => amount + utxo.assets.lovelace,
      0n,
    );
    assert.equal(lovelace, EMULATOR_ACCOUNT.assets.lovelace);
  });

  test("evaluate tx", async () => {
    const redeemers = await emulator.evaluateTx(
      PreprodConstants.evalSample1.transaction,
      PreprodConstants.evalSample1.utxos,
    );
    assert.deepStrictEqual(
      redeemers,
      // Actual evaluation uses the current emulator cost models. The old
      // implementation only echoed the transaction's embedded budget.
      PreprodConstants.evalSample1.redeemersExUnits.map((redeemer) => ({
        ...redeemer,
        ex_units: { mem: 26_285, steps: 7_850_649 },
      })),
    );
    assert.notDeepEqual(
      redeemers,
      PreprodConstants.evalSample1.redeemersExUnits,
    );
  });

  test("submit tx", async () => {
    emulator.ledger = {
      ...emulator.ledger,
      "442575f1e4becbcaef8b20e61ee8b130cb02d1959a4dbe43dccd327a62d9eb180": {
        utxo: {
          txHash:
            "442575f1e4becbcaef8b20e61ee8b130cb02d1959a4dbe43dccd327a62d9eb18",
          outputIndex: 0,
          assets: { lovelace: 55000000n },
          address:
            "addr_test1wza9ek9k6fqddswte7ytf6r7uayyka9rat3rkm0mgdw8wysgv773j",
          datumHash: undefined,
          datum:
            "d87a84d87981d87982d87981581c983ed9af5d9f13d0cb5e64ab3a1c00140f663518e78aa8c8ca09e042d87981d87981d87981581c6d2a842a4ded1909f71835598d7d34dd55201d62dc2a88078a7a8f441a000f424000d87984581ce16c2dc8ae937e8d3790c7fd7168d7b994621ba14ca11415f39fed72434d494ed87a801a002625a0",
          scriptRef: undefined,
        },
        spent: false,
      },
      "442575f1e4becbcaef8b20e61ee8b130cb02d1959a4dbe43dccd327a62d9eb181": {
        utxo: {
          txHash:
            "442575f1e4becbcaef8b20e61ee8b130cb02d1959a4dbe43dccd327a62d9eb18",
          outputIndex: 1,
          assets: { lovelace: 144826975n },
          address:
            "addr_test1qzvrakd0tk0385xttej2kwsuqq2q7e34rrnc42xgegy7qsnd92zz5n0dryylwxp4txxh6dxa25sp6cku92yq0zn63azqya0vgs",
          datumHash: undefined,
          datum: undefined,
          scriptRef: undefined,
        },
        spent: false,
      },
    };
    // The historical transaction commits to different protocol cost models.
    // Actual ledger validation rejects its stale script integrity hash.
    await expect(
      emulator.submitTx(PreprodConstants.submitCbor),
    ).rejects.toThrow(/ScriptIntegrityHashMismatch/);
    const lucid = await Lucid(emulator, "Custom");
    lucid.selectWallet.fromSeed(EMULATOR_ACCOUNT.seedPhrase);
    const tx = await lucid
      .newTx()
      .pay.ToAddress(EMULATOR_ACCOUNT.address, { lovelace: 10_000_000n })
      .complete();
    const signed = await tx.sign.withWallet().complete();
    const txHash = await signed.submit();
    assert.equal(txHash, signed.toHash());

    const spentEntry = Object.values(emulator.ledger).find(
      ({ spent }) => spent,
    );
    assert.isDefined(spentEntry);
    if (!spentEntry) throw new Error("Missing spent input after submission");

    const spentUnit = `${"f".repeat(56)}01`;
    spentEntry.utxo.assets[spentUnit] = 1n;
    const spentOutRef = {
      txHash: spentEntry.utxo.txHash,
      outputIndex: spentEntry.utxo.outputIndex,
    };
    const includesSpentOutRef = (utxos: (typeof spentEntry.utxo)[]) =>
      utxos.some(
        ({ txHash, outputIndex }) =>
          txHash === spentOutRef.txHash &&
          outputIndex === spentOutRef.outputIndex,
      );

    assert.isFalse(
      includesSpentOutRef(await emulator.getUtxos(spentEntry.utxo.address)),
    );
    assert.isFalse(
      includesSpentOutRef(
        await emulator.getUtxosWithUnit(spentEntry.utxo.address, spentUnit),
      ),
    );
    assert.isFalse(
      includesSpentOutRef(await emulator.getUtxosByOutRef([spentOutRef])),
    );
    assert.isUndefined(await emulator.getUtxoByUnit(spentUnit));

    assert.deepEqual(await emulator.getTransactionStatus(txHash), {
      status: "pending",
      txHash,
    });
    emulator.awaitBlock();
    assert.deepEqual(await emulator.getTransactionStatus(txHash), {
      status: "confirmed",
      txHash,
      confirmation: {
        txHash,
        blockHeight: 1,
        slot: 20,
        confirmations: 1,
      },
    });
    const confirmedOutput = Object.entries(emulator.ledger).find(
      ([, { utxo }]) => utxo.txHash === txHash,
    );
    assert.isDefined(confirmedOutput);
    if (!confirmedOutput) throw new Error("Missing confirmed output");
    confirmedOutput[1].spent = true;
    emulator.awaitBlock(2);
    assert.notProperty(emulator.ledger, confirmedOutput[0]);
    const finalStatus = await emulator.getTransactionStatus(txHash);
    assert.equal(
      finalStatus.status === "confirmed"
        ? finalStatus.confirmation.confirmations
        : undefined,
      3,
    );
  });
});

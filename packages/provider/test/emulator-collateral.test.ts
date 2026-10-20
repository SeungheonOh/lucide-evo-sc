import { Assets, Script } from "@lucid-evolution/core-types";
import { describe, expect, test } from "vitest";
import {
  utxoToTransactionInput,
  utxoToTransactionOutput,
  PROTOCOL_PARAMETERS_DEFAULT,
  validatorToAddress,
} from "@lucid-evolution/utils";
import {
  encodeCbor,
  decodeCbor,
  ledger,
  type CborValue,
} from "@lucid-evolution/ledger";
import { Lucid } from "../../lucid/src/index.js";
import {
  Emulator,
  generateEmulatorAccountFromPrivateKey,
} from "../src/index.js";

/*
  The ledger's collateral rules for a transaction with redeemers (feesOK):
    - at least one collateral input (NoCollateralInputs);
    - at most maxCollateralInputs of them (TooManyCollateralInputs);
    - the collateral inputs minus the collateral return hold only ADA
      (CollateralContainsNonADA);
    - that balance covers collateralPercentage of the fee
      (InsufficientCollateral);
    - total_collateral, when present, equals that balance
      (IncorrectTotalCollateralField);
    - the collateral return holds at least its minimum ADA
      (BabbageOutputTooSmallUTxO).
*/

const FEE = 200_000n;
// 150% of the fee.
const REQUIRED = 300_000n;
const SCRIPT_UTXO_HASH = "11".repeat(32);
const COLLATERAL_HASH = "22".repeat(32);
const SCRIPT: Script = { type: "PlutusV3", script: "450100002499" };
const UNIT = "33".repeat(28) + "01";

type OutRef = { txHash: string; outputIndex: number };

const setup = (collateralUTxOs: Assets[]) => {
  const account = generateEmulatorAccountFromPrivateKey({
    lovelace: 100_000_000n,
  });
  const emulator = new Emulator([account], PROTOCOL_PARAMETERS_DEFAULT);
  const scriptOutRef: OutRef = { txHash: SCRIPT_UTXO_HASH, outputIndex: 0 };
  emulator.ledger[scriptOutRef.txHash + scriptOutRef.outputIndex] = {
    utxo: {
      ...scriptOutRef,
      address: validatorToAddress("Custom", SCRIPT),
      assets: { lovelace: 10_000_000n },
      datumHash: undefined,
      datum: "d87980",
      scriptRef: SCRIPT,
    },
    spent: false,
  };
  const collateral = collateralUTxOs.map((assets, outputIndex) => {
    const outRef = { txHash: COLLATERAL_HASH, outputIndex };
    emulator.ledger[outRef.txHash + outRef.outputIndex] = {
      utxo: { ...outRef, address: account.address, assets },
      spent: false,
    };
    return outRef;
  });
  return { account, emulator, scriptOutRef, collateral };
};

const spendScript = async (
  fixture: ReturnType<typeof setup>,
  options: {
    collateral: OutRef[];
    collateralReturn?: Assets;
    totalCollateral?: bigint;
  },
) => {
  const { account, emulator, scriptOutRef } = fixture;
  const lucid = await Lucid(emulator, "Custom");
  lucid.selectWallet.fromPrivateKey(account.privateKey);
  const locked =
    emulator.ledger[scriptOutRef.txHash + scriptOutRef.outputIndex].utxo;
  const prepared = await lucid
    .newTx()
    .collectFrom([locked], "00")
    .attach.SpendingValidator(SCRIPT)
    .pay.ToAddress(account.address, { lovelace: 10_000_000n - FEE })
    .setMinFee(FEE)
    .complete({ coinSelection: false });
  const transaction = decodeCbor(prepared.toCBOR()) as CborValue[];
  const body = transaction[0] as Map<CborValue, CborValue>;
  body.delete(13n);
  body.delete(16n);
  body.delete(17n);
  if (options.collateral.length)
    body.set(
      13n,
      options.collateral.map((ref) => decodeCbor(utxoToTransactionInput(ref))),
    );
  if (options.collateralReturn)
    body.set(
      16n,
      decodeCbor(
        utxoToTransactionOutput({
          address: account.address,
          assets: options.collateralReturn,
        }),
      ),
    );
  if (options.totalCollateral !== undefined)
    body.set(17n, options.totalCollateral);
  const cbor = encodeCbor(transaction);
  const witness = ledger<string>("tx.sign", {
    cbor,
    privateKeys: [account.privateKey],
  });
  const signed = ledger<string>("tx.mergeWitnesses", {
    cbor,
    witnessSets: [witness],
  });
  return emulator.submitTx(signed);
};

describe("Emulator collateral checks", () => {
  test("accepts collateral covering the fee exactly", async () => {
    const fixture = setup([{ lovelace: REQUIRED }]);
    await spendScript(fixture, {
      collateral: fixture.collateral,
      totalCollateral: REQUIRED,
    });
  });

  test("accepts a collateral return that leaves enough collateral", async () => {
    const fixture = setup([{ lovelace: 5_000_000n, [UNIT]: 1n }]);
    await spendScript(fixture, {
      collateral: fixture.collateral,
      collateralReturn: { lovelace: 5_000_000n - REQUIRED, [UNIT]: 1n },
      totalCollateral: REQUIRED,
    });
  });

  test("rejects a script transaction without collateral", async () => {
    const fixture = setup([]);
    await expect(spendScript(fixture, { collateral: [] })).rejects.toThrow(
      /NoCollateralInputs/,
    );
  });

  test("rejects collateral below collateralPercentage of the fee", async () => {
    const fixture = setup([{ lovelace: REQUIRED - 1n }]);
    await expect(
      spendScript(fixture, { collateral: fixture.collateral }),
    ).rejects.toThrow(/InsufficientCollateral/);
  });

  test("rejects a collateral return that leaves too little collateral", async () => {
    const fixture = setup([{ lovelace: 5_000_000n }]);
    await expect(
      spendScript(fixture, {
        collateral: fixture.collateral,
        collateralReturn: { lovelace: 5_000_000n - REQUIRED + 1n },
      }),
    ).rejects.toThrow(/InsufficientCollateral/);
  });

  test("rejects a total collateral that differs from the balance", async () => {
    const fixture = setup([{ lovelace: 5_000_000n }]);
    await expect(
      spendScript(fixture, {
        collateral: fixture.collateral,
        collateralReturn: { lovelace: 4_000_000n },
        totalCollateral: 5_000_000n,
      }),
    ).rejects.toThrow(/IncorrectTotalCollateralField/);
  });

  test("rejects a collateral return below its minimum ADA", async () => {
    const fixture = setup([{ lovelace: 5_000_000n }]);
    await expect(
      spendScript(fixture, {
        collateral: fixture.collateral,
        collateralReturn: { lovelace: 500_000n },
        totalCollateral: 4_500_000n,
      }),
    ).rejects.toThrow(/BabbageOutputTooSmallUTxO|OutputTooSmallUTxO/);
  });

  test("rejects collateral that keeps native assets", async () => {
    const fixture = setup([{ lovelace: 5_000_000n, [UNIT]: 1n }]);
    await expect(
      spendScript(fixture, { collateral: fixture.collateral }),
    ).rejects.toThrow(/CollateralContainsNonADA/);
  });

  test("rejects more collateral inputs than maxCollateralInputs", async () => {
    const fixture = setup(
      Array.from(
        { length: PROTOCOL_PARAMETERS_DEFAULT.maxCollateralInputs + 1 },
        () => ({ lovelace: REQUIRED }),
      ),
    );
    await expect(
      spendScript(fixture, { collateral: fixture.collateral }),
    ).rejects.toThrow(/TooManyCollateralInputs/);
  });
});

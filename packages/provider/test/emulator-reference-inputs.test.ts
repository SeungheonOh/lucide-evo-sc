import { ProtocolParameters, Script } from "@lucid-evolution/core-types";
import { describe, expect, test } from "vitest";
import {
  PROTOCOL_PARAMETERS_DEFAULT,
  validatorToAddress,
  utxoToTransactionInput,
} from "@lucid-evolution/utils";
import {
  encodeCbor,
  decodeCbor,
  ledger,
  type CborValue,
} from "@lucid-evolution/ledger";
import { fixtureTransaction } from "./transaction-fixture.js";
import { Lucid } from "../../lucid/src/index.js";
import {
  Emulator,
  generateEmulatorAccountFromPrivateKey,
} from "../src/index.js";

/*
  The ledger requires a transaction's reference inputs to be disjoint from
  its inputs, with the rule depending on the protocol version:
    - up to major version 8, any overlap is allowed;
    - major versions 9 and 10 reject any overlap (BabbageNonDisjointRefInputs);
    - from major version 11 the check is part of building a PlutusV3 script
      context (ReferenceInputsNotDisjointFromInputs), so only a transaction
      that runs a PlutusV3 script is rejected.
  These tests exercise every branch against the emulator's submit check.
*/

const GENESIS_HASH = "00".repeat(32);
const SCRIPT_UTXO_HASH = "11".repeat(32);

const plutusV2Script: Script = {
  type: "PlutusV2",
  script: "49480100002221200101",
};
const plutusV3Script: Script = { type: "PlutusV3", script: "450100002499" };

const withProtocolMajorVersion = (
  protocolMajorVersion: number | undefined,
): ProtocolParameters => ({
  ...PROTOCOL_PARAMETERS_DEFAULT,
  protocolMajorVersion,
});

type OutRef = { txHash: string; outputIndex: number };

const setup = (protocolMajorVersion: number | undefined) => {
  const account = generateEmulatorAccountFromPrivateKey({
    lovelace: 100_000_000n,
  });
  const emulator = new Emulator(
    [account],
    withProtocolMajorVersion(protocolMajorVersion),
  );
  const accountOutRef: OutRef = { txHash: GENESIS_HASH, outputIndex: 0 };
  const scriptOutRef: OutRef = { txHash: SCRIPT_UTXO_HASH, outputIndex: 0 };
  const lockAt = (script: Script) => {
    emulator.ledger[scriptOutRef.txHash + scriptOutRef.outputIndex] = {
      utxo: {
        ...scriptOutRef,
        address: validatorToAddress("Custom", script),
        assets: { lovelace: 10_000_000n },
        datumHash: undefined,
        datum: "d87980",
        scriptRef: script,
      },
      spent: false,
    };
  };
  return { account, emulator, accountOutRef, scriptOutRef, lockAt };
};

const spendOwnCoinReadingItself = async (
  protocolMajorVersion: number | undefined,
) => {
  const { account, emulator, accountOutRef } = setup(protocolMajorVersion);
  const tx = fixtureTransaction({
    inputs: [accountOutRef],
    referenceInputs: [accountOutRef],
    outputs: [{ address: account.address, assets: { lovelace: 99_800_000n } }],
    fee: 200_000n,
    privateKeys: [account.privateKey],
  });
  return emulator.submitTx(tx);
};

const spendScriptCoin = async (input: {
  protocolMajorVersion: number | undefined;
  script: Script;
  readItself: boolean;
}) => {
  const { account, emulator, accountOutRef, scriptOutRef, lockAt } = setup(
    input.protocolMajorVersion,
  );
  lockAt(input.script);
  const lucid = await Lucid(emulator, "Custom");
  lucid.selectWallet.fromPrivateKey(account.privateKey);
  const prepared = await lucid
    .newTx()
    .collectFrom(
      [emulator.ledger[scriptOutRef.txHash + scriptOutRef.outputIndex].utxo],
      "00",
    )
    .readFrom([
      emulator.ledger[accountOutRef.txHash + accountOutRef.outputIndex].utxo,
    ])
    .attach.SpendingValidator(input.script)
    .pay.ToAddress(account.address, { lovelace: 9_800_000n })
    .setMinFee(200_000n)
    .complete({ coinSelection: false });
  const transaction = decodeCbor(prepared.toCBOR()) as CborValue[];
  const body = transaction[0] as Map<CborValue, CborValue>;
  if (input.readItself)
    body.set(18n, [decodeCbor(utxoToTransactionInput(scriptOutRef))]);
  const cbor = encodeCbor(transaction);
  const witnesses = ledger<string>("tx.sign", {
    cbor,
    privateKeys: [account.privateKey],
  });
  const tx = ledger<string>("tx.mergeWitnesses", {
    cbor,
    witnessSets: [witnesses],
  });
  return emulator.submitTx(tx);
};

describe("Emulator reference inputs overlapping inputs", () => {
  test("protocol version 8 accepts the overlap", async () => {
    await spendOwnCoinReadingItself(8);
  });

  test("protocol version 9 rejects the overlap", async () => {
    await expect(spendOwnCoinReadingItself(9)).rejects.toThrow(
      /BabbageNonDisjointRefInputs/,
    );
  });

  test("protocol version 10 rejects the overlap", async () => {
    await expect(spendOwnCoinReadingItself(10)).rejects.toThrow(
      /BabbageNonDisjointRefInputs/,
    );
  });

  test("protocol version 11 accepts the overlap when no PlutusV3 script runs", async () => {
    await spendOwnCoinReadingItself(11);
    await spendScriptCoin({
      protocolMajorVersion: 11,
      script: plutusV2Script,
      readItself: true,
    });
  });

  test("protocol version 11 rejects the overlap when a PlutusV3 script runs", async () => {
    await expect(
      spendScriptCoin({
        protocolMajorVersion: 11,
        script: plutusV3Script,
        readItself: true,
      }),
    ).rejects.toThrow(/ReferenceInputsNotDisjointFromInputs/);
  });

  test("protocol version 11 accepts a PlutusV3 script with disjoint reference inputs", async () => {
    await spendScriptCoin({
      protocolMajorVersion: 11,
      script: plutusV3Script,
      readItself: false,
    });
  });

  test("an unset protocol version preserves the original Emulator version 11 rules", async () => {
    await spendOwnCoinReadingItself(undefined);
    await expect(
      spendScriptCoin({
        protocolMajorVersion: undefined,
        script: plutusV3Script,
        readItself: true,
      }),
    ).rejects.toThrow(/ReferenceInputsNotDisjointFromInputs/);
  });
});

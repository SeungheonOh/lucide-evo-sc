import { Script } from "@lucid-evolution/core-types";
import { describe, expect, test } from "vitest";
import { validatorToAddress, scriptFromNative } from "@lucid-evolution/utils";
import { ledger } from "@lucid-evolution/ledger";
import { fixtureTransaction } from "./transaction-fixture.js";
import {
  Emulator,
  generateEmulatorAccountFromPrivateKey,
} from "../src/index.js";

/*
  A native script supplied through a script reference (rather than the
  witness set) is verified against the transaction's vkey witnesses. That
  verification once ran after the witness key list had been freed.
*/

const GENESIS_HASH = "00".repeat(32);
const SCRIPT_UTXO_HASH = "22".repeat(32);

const setup = (scriptSigner: "account" | "other") => {
  const account = generateEmulatorAccountFromPrivateKey({
    lovelace: 100_000_000n,
  });
  const emulator = new Emulator([account]);
  const signerHash =
    scriptSigner === "account"
      ? ledger<{ keyHash: string }>("key.fromPrivate", {
          privateKey: account.privateKey,
        }).keyHash
      : "ff".repeat(28);
  const nativeScript = scriptFromNative({ type: "sig", keyHash: signerHash });
  emulator.ledger[SCRIPT_UTXO_HASH + 0] = {
    utxo: {
      txHash: SCRIPT_UTXO_HASH,
      outputIndex: 0,
      address: validatorToAddress("Custom", nativeScript),
      assets: { lovelace: 10_000_000n },
      datumHash: undefined,
      datum: undefined,
      scriptRef: nativeScript,
    },
    spent: false,
  };

  // Spends the account coin and the script coin; the native script is only
  // available as the script coin's reference script.
  const tx = fixtureTransaction({
    inputs: [
      { txHash: GENESIS_HASH, outputIndex: 0 },
      { txHash: SCRIPT_UTXO_HASH, outputIndex: 0 },
    ],
    outputs: [{ address: account.address, assets: { lovelace: 109_800_000n } }],
    fee: 200_000n,
    privateKeys: [account.privateKey],
  });
  return { emulator, tx };
};

describe("Emulator native scripts from script references", () => {
  test("accepts a reference native script satisfied by a vkey witness", async () => {
    const { emulator, tx } = setup("account");
    await expect(emulator.submitTx(tx)).resolves.toMatch(/^[0-9a-f]{64}$/);
    emulator.awaitBlock();
    expect(
      await emulator.getUtxosByOutRef([
        { txHash: SCRIPT_UTXO_HASH, outputIndex: 0 },
      ]),
    ).toEqual([]);
  });

  test("rejects a reference native script whose signer did not sign", async () => {
    const { emulator, tx } = setup("other");
    await expect(async () => emulator.submitTx(tx)).rejects.toThrow(
      /ScriptWitnessNotValidating/,
    );
  });
});

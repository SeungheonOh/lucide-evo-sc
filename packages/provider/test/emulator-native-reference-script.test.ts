import { Script } from "@lucid-evolution/core-types";
import { describe, expect, test } from "vitest";
import {
  PROTOCOL_PARAMETERS_DEFAULT,
  validatorToAddress,
  scriptFromNative,
} from "@lucid-evolution/utils";
import { ledger } from "@lucid-evolution/ledger";
import { fixtureTransaction } from "./transaction-fixture.js";
import {
  Emulator,
  generateEmulatorAccountFromPrivateKey,
} from "../src/index.js";

// Spends a UTxO locked by a native script that the transaction only carries
// in a reference input, so the emulator must verify the reference script.

const GENESIS_HASH = "00".repeat(32);
const SCRIPT_UTXO_HASH = "11".repeat(32);
const REFERENCE_UTXO_HASH = "22".repeat(32);

const keyHashOf = (privateKey: string): string =>
  ledger<{ keyHash: string }>("key.fromPrivate", { privateKey }).keyHash;
const requireSignature = (keyHash: string): Script =>
  scriptFromNative({ type: "sig", keyHash });

const setup = () => {
  const owner = generateEmulatorAccountFromPrivateKey({
    lovelace: 100_000_000n,
  });
  const other = generateEmulatorAccountFromPrivateKey({
    lovelace: 100_000_000n,
  });
  const emulator = new Emulator([owner, other], PROTOCOL_PARAMETERS_DEFAULT);
  const script = requireSignature(keyHashOf(owner.privateKey));
  emulator.ledger[SCRIPT_UTXO_HASH + 0] = {
    utxo: {
      txHash: SCRIPT_UTXO_HASH,
      outputIndex: 0,
      address: validatorToAddress("Custom", script),
      assets: { lovelace: 10_000_000n },
      datumHash: undefined,
      datum: undefined,
      scriptRef: undefined,
    },
    spent: false,
  };
  emulator.ledger[REFERENCE_UTXO_HASH + 0] = {
    utxo: {
      txHash: REFERENCE_UTXO_HASH,
      outputIndex: 0,
      address: owner.address,
      assets: { lovelace: 5_000_000n },
      datumHash: undefined,
      datum: undefined,
      scriptRef: script,
    },
    spent: false,
  };
  return { emulator, owner, other };
};

// Spends the signer's genesis UTxO (index 0 for the owner, 1 for the other
// account) and the script UTxO, reading the native script by reference.
const spendWithReferenceScript = (
  signer: { address: string; privateKey: string },
  genesisIndex: number,
): string => {
  return fixtureTransaction({
    inputs: [
      { txHash: GENESIS_HASH, outputIndex: genesisIndex },
      { txHash: SCRIPT_UTXO_HASH, outputIndex: 0 },
    ],
    outputs: [{ address: signer.address, assets: { lovelace: 109_800_000n } }],
    fee: 200_000n,
    referenceInputs: [{ txHash: REFERENCE_UTXO_HASH, outputIndex: 0 }],
    privateKeys: [signer.privateKey],
  });
};

describe("Emulator native reference scripts", () => {
  test("accepts a spend authorized by a reference-only native script", async () => {
    const { emulator, owner } = setup();
    const txHash = await emulator.submitTx(spendWithReferenceScript(owner, 0));
    emulator.awaitBlock(1);
    expect(
      await emulator.getUtxosByOutRef([{ txHash, outputIndex: 0 }]),
    ).toHaveLength(1);
  });

  test("rejects a spend whose signer does not satisfy the reference script", async () => {
    const { emulator, other } = setup();
    await expect(
      (async () => emulator.submitTx(spendWithReferenceScript(other, 1)))(),
    ).rejects.toThrow(/ScriptWitnessNotValidating/);
  });
});

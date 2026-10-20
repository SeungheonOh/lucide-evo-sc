import { describe, expect, test } from "vitest";
import { Emulator, generateEmulatorAccount } from "@lucid-evolution/provider";
import {
  decodeCbor,
  encodeCbor,
  inspectTransaction,
  hexToBytes,
  type CborValue,
} from "@lucid-evolution/ledger";
import { utxoToTransactionOutput } from "@lucid-evolution/utils";
import { createTxGraph } from "../src/graph.js";
import { outRefKey } from "../src/resolve.js";

const makeEvaluationTx = (
  txHash: string,
  outputIndex: number,
  address: string,
) =>
  inspectTransaction(
    encodeCbor([
      new Map<CborValue, CborValue>([
        [0n, [[hexToBytes(txHash), BigInt(outputIndex)]]],
        [
          1n,
          [
            decodeCbor(
              utxoToTransactionOutput({
                address,
                assets: { lovelace: 2_000_000n },
              }),
            ),
          ],
        ],
        [2n, 170_000n],
      ]),
      new Map(),
      true,
      null,
    ]),
  );

describe("tx graph with Emulator provider", () => {
  test("wraps a real Emulator evaluateTx flow and resolves additional UTxOs", async () => {
    const account = generateEmulatorAccount({
      lovelace: 10_000_000n,
    });
    const emulator = new Emulator([account]);
    const [seedUtxo] = await emulator.getUtxos(account.address);
    const tx = makeEvaluationTx(
      seedUtxo.txHash,
      seedUtxo.outputIndex,
      account.address,
    );
    const graph = createTxGraph({
      addresses: {
        [account.address]: "emulator-wallet",
      },
    });
    const tracedProvider = graph.wrapProvider(emulator, {
      evaluateLabel: "emulator-evaluate",
    });

    await expect(
      tracedProvider.evaluateTx(tx.cbor, [seedUtxo]),
    ).resolves.toEqual([]);

    const trace = graph.toJSON();
    expect(trace.transactions).toEqual([
      expect.objectContaining({
        label: "emulator-evaluate",
        status: "built",
        evaluation: [],
      }),
    ]);
    expect(trace.utxos[outRefKey(seedUtxo)]).toMatchObject({
      txHash: seedUtxo.txHash,
      outputIndex: seedUtxo.outputIndex,
      address: account.address,
      assets: { lovelace: "10000000" },
      resolution: "genesis",
      tags: ["genesis"],
    });
    expect(graph.toMermaid()).toContain("emulator-wallet");
    expect(graph.toMermaid()).toContain("genesis UTxO");
  });
});

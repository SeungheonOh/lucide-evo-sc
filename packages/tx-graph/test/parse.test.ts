import { describe, expect, test } from "vitest";
import {
  encodeCbor,
  hexToBytes,
  type CborValue,
} from "@lucid-evolution/ledger";
import {
  credentialToRewardAddress,
  getAddressDetails,
} from "@lucid-evolution/utils";
import { parseTransaction } from "../src/parse.js";
import {
  transaction,
  inputList,
  output,
  fixtureAddress as address,
} from "./ledger-fixtures.js";
const rewardAddress = credentialToRewardAddress("Custom", {
  type: "Script",
  hash: "66".repeat(28),
});
const makeBaseTx = () =>
  transaction(
    [{ txHash: "11".repeat(32), outputIndex: 0 }],
    [2_000_000n],
    (body) => {
      body.set(8n, 10n);
      body.set(3n, 20n);
      body.set(18n, inputList([{ txHash: "22".repeat(32), outputIndex: 1 }]));
      body.set(13n, inputList([{ txHash: "33".repeat(32), outputIndex: 2 }]));
      body.set(16n, output(1_500_000n));
      body.set(17n, 1_000_000n);
      body.set(14n, [hexToBytes("44".repeat(28))]);
      body.set(
        5n,
        new Map([
          [hexToBytes(getAddressDetails(rewardAddress).address.hex), 123_456n],
        ]),
      );
    },
  );
describe("parseTransaction", () => {
  test("parses body inputs, outputs, validity, collateral, withdrawals, and signers", () => {
    const tx = makeBaseTx();
    const parsed = parseTransaction(tx, {
      label: "basic-flow",
      status: "signed",
    });

    expect(parsed.label).toBe("basic-flow");
    expect(parsed.status).toBe("signed");
    expect(parsed.hash).toBe(tx.hash);
    expect(parsed.fee).toBe("170000");
    expect(parsed.validityInterval).toEqual({
      validFrom: "10",
      validTo: "20",
    });
    expect(parsed.inputs).toEqual([
      { txHash: "11".repeat(32), outputIndex: 0 },
    ]);
    expect(parsed.referenceInputs).toEqual([
      { txHash: "22".repeat(32), outputIndex: 1 },
    ]);
    expect(parsed.collateralInputs).toEqual([
      { txHash: "33".repeat(32), outputIndex: 2 },
    ]);
    expect(parsed.totalCollateral).toBe("1000000");
    expect(parsed.collateralReturn?.assets).toEqual({
      lovelace: "1500000",
    });
    expect(parsed.outputs).toHaveLength(1);
    expect(parsed.outputs[0]).toMatchObject({
      txHash: parsed.hash,
      outputIndex: 0,
      address,
      assets: { lovelace: "2000000" },
      resolution: "resolved",
      tags: [],
    });
    expect(parsed.outputs[0]?.paymentCredential?.type).toBe("Key");
    expect(parsed.withdrawals).toEqual([{ rewardAddress, amount: "123456" }]);
    expect(parsed.requiredSigners).toEqual(["44".repeat(28)]);
  });

  test("normalizes CBOR and toTransaction inputs", () => {
    const tx = makeBaseTx();

    expect(parseTransaction(tx.cbor).hash).toBe(tx.hash);
    expect(parseTransaction({ toTransaction: () => tx }).hash).toBe(tx.hash);
    expect(parseTransaction({ toCBOR: () => tx.cbor }).hash).toBe(tx.hash);
  });

  test("splits minted and burned assets and parses redeemers", () => {
    const witnesses = new Map<CborValue, CborValue>([
      [
        5n,
        new Map<CborValue, CborValue>([
          [
            [1n, 0n],
            [2n, [2n, 102n]],
          ],
          [
            [0n, 0n],
            [1n, [1n, 101n]],
          ],
        ]),
      ],
    ]);
    const tx = transaction(
      [{ txHash: "11".repeat(32), outputIndex: 0 }],
      [2_000_000n],
      (body) => {
        body.set(
          9n,
          new Map([
            [
              hexToBytes("55".repeat(28)),
              new Map([
                [hexToBytes("aa"), 7n],
                [hexToBytes("bb"), -3n],
              ]),
            ],
          ]),
        );
      },
      witnesses,
    );
    const parsed = parseTransaction(tx);
    const mintedUnit = "55".repeat(28) + "aa";
    const burnedUnit = "55".repeat(28) + "bb";

    expect(parsed.mint).toEqual({
      [mintedUnit]: "7",
      [burnedUnit]: "-3",
    });
    expect(parsed.mintedAssets).toEqual({ [mintedUnit]: "7" });
    expect(parsed.burnedAssets).toEqual({ [burnedUnit]: "3" });
    expect(parsed.redeemers).toEqual([
      {
        tag: "spend",
        index: "0",
        redeemerListIndex: 0,
        data: encodeCbor(1n),
        exUnits: { mem: "1", steps: "101" },
      },
      {
        tag: "mint",
        index: "0",
        redeemerListIndex: 1,
        data: encodeCbor(2n),
        exUnits: { mem: "2", steps: "102" },
      },
    ]);
  });
});

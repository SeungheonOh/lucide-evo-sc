import { describe, expect, test } from "vitest";
import {
  CborTag,
  decodeCbor,
  encodeCbor,
  ledger,
  type CborValue,
} from "../src/node.js";

describe("packaged Haskell reactor", () => {
  test("retains exact integer values and heterogeneous CBOR map keys", () => {
    const value = new Map<CborValue, CborValue>([
      [1n, -(1n << 600n)],
      ["1", new Uint8Array([0, 128, 255])],
      [2n, new CborTag(258n, [3n, 4n])],
    ]);
    expect(decodeCbor(encodeCbor(value))).toEqual(value);
  });

  test("recovers after rejected requests without corrupting subsequent data", () => {
    const hash = ledger("data.hash", { cbor: "d8799f01ff" });
    for (let index = 0; index < 100; index++) {
      expect(() => ledger("data.decode", { cbor: "9f01" })).toThrow();
      expect(() =>
        ledger("data.decode", { cbor: "5bffffffffffffffff" }),
      ).toThrow();
      expect(ledger("data.hash", { cbor: "d8799f01ff" })).toBe(hash);
    }
  });

  test("preserves committed inline datum bytes through output inspection", () => {
    const address = ledger<string>("address.fromCredentials", {
      network: 0,
      payment: { type: "Key", hash: "01".repeat(28) },
    });
    const datum = "d8799f0102ff";
    const cbor = ledger<string>("output.encode", {
      utxo: { address, assets: { lovelace: "2000000" }, datum },
    });
    expect(ledger<{ datum: string }>("output.decode", { cbor }).datum).toBe(
      datum,
    );
  });
});

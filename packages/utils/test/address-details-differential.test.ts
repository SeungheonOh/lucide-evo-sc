import { describe, expect, test } from "vitest";
import { readFileSync } from "node:fs";
import { brotliDecompressSync } from "node:zlib";
import type { AddressDetails } from "@lucid-evolution/core-types";
import { getAddressDetails } from "../src/address.js";

const fixtures = JSON.parse(
  brotliDecompressSync(
    readFileSync(new URL("./fixtures/addresses.json.br", import.meta.url)),
  ).toString(),
) as {
  input: string;
  ok: boolean;
  value?: AddressDetails;
  message?: string;
}[];

describe("recorded Lucid address behavior", () => {
  test("preserves every address kind, encoding, and network", () => {
    let matched = 0;
    const types = new Set<string>();
    for (const { input, ok, value, message } of fixtures) {
      if (ok) {
        expect(getAddressDetails(input), input).toStrictEqual(value);
        expect(getAddressDetails(input), input).toStrictEqual(value);
        matched++;
        types.add(value!.type);
      } else expect(() => getAddressDetails(input)).toThrow(message);
    }
    expect(types).toEqual(
      new Set(["Base", "Enterprise", "Pointer", "Reward", "Byron"]),
    );
    expect(matched).toBeGreaterThan(500);
  });
  test("callers cannot mutate subsequent results", () => {
    const input = fixtures.find((row) => row.ok)!.input;
    const first = getAddressDetails(input),
      snapshot = structuredClone(first);
    first.address.hex = "mutated";
    first.paymentCredential!.hash = "mutated";
    first.networkId = 99;
    expect(getAddressDetails(input)).toStrictEqual(snapshot);
  });
});

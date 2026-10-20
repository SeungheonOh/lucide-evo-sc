import { describe, expect, test } from "vitest";
import { readFileSync } from "node:fs";
import { brotliDecompressSync } from "node:zlib";
import { bech32 } from "@scure/base";
import type { Credential } from "@lucid-evolution/core-types";
import { fromHex, toHex } from "@lucid-evolution/core-utils";
import { drepIDToCredential } from "../src/credential.js";

// Recorded against Cardano SDK before removing its transitive ledger dependency.
const fixtures = JSON.parse(
  brotliDecompressSync(
    readFileSync(new URL("./fixtures/drep-ids.json.br", import.meta.url)),
  ).toString(),
) as ({ input: string } & ({ ok: Credential } | { error: string }))[];
const headerError = (drepID: string, header: number) =>
  `Invalid DRep ID: ${drepID}, header 0x${header.toString(16).padStart(2, "0")} is neither a DRep key hash (0x22) nor a script hash (0x23)`;

const outcome = (f: () => Credential) => {
  try {
    return { ok: f() };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
};

describe("drepIDToCredential", () => {
  test("preserves known, random, and corrupted DRep IDs", () => {
    let valid = 0;
    for (const { input, ...expected } of fixtures) {
      expect(
        outcome(() => drepIDToCredential(input)),
        input,
      ).toStrictEqual(expected);
      if ("ok" in expected) valid++;
    }
    expect(valid).toBeGreaterThan(400);
  });
  test("accepts only the CIP-129 DRep key and script headers", () => {
    const hash = fromHex(
      "17c5c7c8c4f3d6b4be03d5e6c8a3a0f2d6b8a7e9f0c1d2e3f4a5b6c7",
    );
    for (let header = 0; header < 256; header++) {
      const id = bech32.encode(
        "drep",
        bech32.toWords(Uint8Array.of(header, ...hash)),
        1023,
      );
      const expected =
        header === 0x22
          ? { ok: { type: "Key", hash: toHex(hash) } }
          : header === 0x23
            ? { ok: { type: "Script", hash: toHex(hash) } }
            : { error: headerError(id, header) };
      expect(
        outcome(() => drepIDToCredential(id)),
        id,
      ).toStrictEqual(expected);
    }
  });
});

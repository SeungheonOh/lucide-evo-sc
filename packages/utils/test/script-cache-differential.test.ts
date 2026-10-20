import { describe, expect, test } from "vitest";
import { readFileSync } from "node:fs";
import { brotliDecompressSync } from "node:zlib";
import type { Script } from "@lucid-evolution/core-types";
import { toHex } from "@lucid-evolution/core-utils";
import { applyDoubleCborEncoding } from "../src/cbor.js";
import { ScriptCache } from "../src/script-cache.js";
import {
  mintingPolicyToId,
  scriptCborBytes,
  toScriptRef,
  validatorToScriptHash,
} from "../src/scripts.js";

const fixtures = JSON.parse(
  brotliDecompressSync(
    readFileSync(new URL("./fixtures/scripts.json.br", import.meta.url)),
  ).toString(),
) as {
  encoding: { input: string; value?: string; error?: string }[];
  scripts: { script: Script; hash: string; reference: string }[];
};

describe("recorded Lucid script encodings", () => {
  test("preserves script wrapping across valid and malformed CBOR inputs", () => {
    for (const { input, value, error } of fixtures.encoding) {
      if (error) expect(() => applyDoubleCborEncoding(input)).toThrow();
      else expect(applyDoubleCborEncoding(input), input).toBe(value);
    }
  });
  test("rejects malformed hexadecimal input", () => {
    for (const input of ["0", "abc", "zz", "4501zz0000", "q".repeat(4000)])
      expect(() => applyDoubleCborEncoding(input)).toThrow();
  });
  test("preserves validator and policy hashes", () => {
    for (const { script, hash } of fixtures.scripts) {
      expect(validatorToScriptHash(script)).toBe(hash);
      expect(validatorToScriptHash({ ...script })).toBe(hash);
      expect(mintingPolicyToId(script)).toBe(hash);
    }
  });
  test("preserves reference script encoding", () => {
    for (const { script, reference } of fixtures.scripts)
      expect(toScriptRef(script)).toBe(reference);
  });
  test("script bytes are independently owned", () => {
    const { script } = fixtures.scripts[1];
    const first = scriptCborBytes(script);
    const expected = toHex(first);
    expect(expected).toBe(applyDoubleCborEncoding(script.script));
    first.fill(0);
    expect(toHex(scriptCborBytes(script))).toBe(expected);
  });
  test("invalid scripts are rejected", () => {
    for (const script of [
      { type: "PlutusV3", script: "zz" },
      { type: "Native", script: "00" },
      { type: "Native", script: "zz" },
      { type: "Unknown", script: "4100" },
    ] as Script[]) {
      expect(() => validatorToScriptHash(script)).toThrow();
      expect(() => toScriptRef(script)).toThrow();
    }
  });
});

describe("ScriptCache", () => {
  test("evicts the oldest entry past its capacity", () => {
    const cache = new ScriptCache<number>(3, Infinity);
    for (let i = 0; i < 5; i++) cache.set("t", `s${i}`, i);
    expect(cache.size).toBe(3);
    expect(cache.get("t", "s0")).toBeUndefined();
    expect(cache.get("t", "s1")).toBeUndefined();
    expect(cache.get("t", "s4")).toBe(4);
  });

  test("keeps namespaces apart", () => {
    const cache = new ScriptCache<string>(10, Infinity);
    cache.set("PlutusV2", "4100", "two");
    cache.set("PlutusV3", "4100", "three");
    expect(cache.get("PlutusV2", "4100")).toBe("two");
    expect(cache.get("PlutusV3", "4100")).toBe("three");
  });

  test("stays within its weight budget", () => {
    const cache = new ScriptCache<string>(100, 10_000, (v) => v.length);
    for (let i = 0; i < 20; i++) cache.set("t", "ab".repeat(1000) + i, "x");
    expect(cache.size).toBeLessThanOrEqual(5);
    cache.set("t", "ab".repeat(10_000), "too big");
    expect(cache.get("t", "ab".repeat(10_000))).toBeUndefined();
  });

  test("tells apart long scripts that share a fingerprint", () => {
    // Same length, head, tail and samples: only one unsampled byte differs.
    const base = "ab".repeat(20_000);
    const variant = (i: number) =>
      base.slice(0, 20_001) + i.toString(16) + base.slice(20_002);
    const cache = new ScriptCache<number>(100, Infinity);
    for (let i = 0; i < 10; i++) cache.set("t", variant(i), i);
    // At most four entries per fingerprint are kept.
    expect(cache.size).toBe(4);
    for (let i = 0; i < 6; i++)
      expect(cache.get("t", variant(i))).toBe(undefined);
    for (let i = 6; i < 10; i++) expect(cache.get("t", variant(i))).toBe(i);
    expect(cache.get("t", base)).toBeUndefined();
  });

  test("replaces an existing entry", () => {
    const cache = new ScriptCache<number>(10, Infinity);
    cache.set("t", "aa", 1);
    cache.set("t", "aa", 2);
    expect(cache.size).toBe(1);
    expect(cache.get("t", "aa")).toBe(2);
  });

  test("getOrCompute stores nothing when compute throws", () => {
    const cache = new ScriptCache<number>(10, Infinity);
    expect(() =>
      cache.getOrCompute("t", "aa", () => {
        throw new Error("boom");
      }),
    ).toThrow("boom");
    expect(cache.size).toBe(0);
    expect(cache.getOrCompute("t", "aa", () => 7)).toBe(7);
    expect(cache.getOrCompute("t", "aa", () => 8)).toBe(7);
  });
});

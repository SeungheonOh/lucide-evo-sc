import { describe, expect, test } from "vitest";
import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { Constr, Data } from "../src/data.js";

type VectorData =
  | { int: string }
  | { bytes: string }
  | { constructor: string; fields: VectorData[] }
  | { list: VectorData[] }
  | { map: { k: VectorData; v: VectorData }[] };
const corpus = JSON.parse(
  gunzipSync(
    readFileSync(new URL("./fixtures/data-codec.json.gz", import.meta.url)),
  ).toString(),
) as {
  encodings: { data: VectorData; node: string; canonical: string }[];
  decoding: { cbor: string; data?: VectorData; invalid?: boolean }[];
};
function unpack(data: VectorData): Data {
  if ("int" in data) return BigInt(data.int);
  if ("bytes" in data) return data.bytes;
  if ("list" in data) return data.list.map(unpack);
  if ("map" in data)
    return new Map(data.map.map(({ k, v }) => [unpack(k), unpack(v)]));
  return new Constr(
    BigInt(data.constructor) as unknown as number,
    data.fields.map(unpack),
  );
}
function pack(data: Data): VectorData {
  if (typeof data === "bigint") return { int: String(data) };
  if (typeof data === "string") return { bytes: data };
  if (data instanceof Constr)
    return { constructor: String(data.index), fields: data.fields.map(pack) };
  if (Array.isArray(data)) return { list: data.map(pack) };
  return { map: Array.from(data, ([k, v]) => ({ k: pack(k), v: pack(v) })) };
}

describe("Haskell Plutus codec against recorded upstream behavior", () => {
  test("retains 3000 seeded input encodings in node and canonical formats", () => {
    expect(corpus.encodings).toHaveLength(3000);
    for (const vector of corpus.encodings) {
      const data = unpack(vector.data);
      expect(Data.to(data), JSON.stringify(vector.data)).toBe(vector.node);
      expect(
        Data.to<Data>(data, undefined, { canonical: true }),
        JSON.stringify(vector.data),
      ).toBe(vector.canonical);
    }
  }, 120_000);
  test("retains decoding of canonical and node encodings", () => {
    for (const vector of corpus.encodings) {
      expect(Data.from(vector.node)).toEqual(Data.from(vector.canonical));
    }
  }, 120_000);
  test("retains 15000 noncanonical and malformed decoding outcomes", () => {
    expect(corpus.decoding).toHaveLength(15000);
    for (const vector of corpus.decoding) {
      if (vector.invalid)
        expect(() => Data.from(vector.cbor), vector.cbor).toThrow();
      else
        expect(pack(Data.from(vector.cbor)), vector.cbor).toEqual(vector.data);
    }
  }, 120_000);
  test("rejects invalid data without coercing it into a valid ledger value", () => {
    const invalid = [
      "abc",
      "zz",
      5,
      {},
      undefined,
      null,
      new Constr(-1, []),
      new Constr(1.5, []),
      new Constr(2 ** 64, []),
      new Constr(1e21, []),
      new Constr(0, new Set([1n]) as unknown as Data[]),
      [[[{}]]],
      new Map([[{}, 1n]]),
      new Map([[1n, "xyz"]]),
    ];
    for (const value of invalid)
      for (const canonical of [false, true])
        expect(() =>
          Data.to<Data>(value as Data, undefined, { canonical }),
        ).toThrow();
  });
});

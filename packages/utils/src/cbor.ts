import { fromHex, toHex } from "@lucid-evolution/core-utils";
import type { Datum, DatumJson } from "@lucid-evolution/core-types";
import { Data, Constr } from "@lucid-evolution/plutus";
import { ledger, encodeCbor, decodeCbor } from "@lucid-evolution/ledger";

export function applyDoubleCborEncoding(script: string): string {
  const level = ledger<number>("cbor.encodingLevel", { cbor: script });
  if (level === 2) return script;
  const wrapped = encodeCbor(fromHex(script));
  return level === 1 ? wrapped : encodeCbor(fromHex(wrapped));
}

export function applySingleCborEncoding(script: string): string {
  const level = ledger<number>("cbor.encodingLevel", { cbor: script });
  if (level === 0) return encodeCbor(fromHex(script));
  if (level === 1) return script;
  return toHex(decodeCbor(script) as Uint8Array);
}

export function CBOREncodingLevel(script: string): "double" | "single" {
  const level = ledger<number>("cbor.encodingLevel", { cbor: script });
  if (level === 0)
    throw new Error("Script is not CBOR-encoded or invalid format.");
  return level === 2 ? "double" : "single";
}

export function datumJsonToCbor(json: DatumJson): Datum {
  function convert(value: any): Data {
    if (value.int !== undefined) return BigInt(value.int);
    if (value.bytes !== undefined) return value.bytes;
    if (value.list) return value.list.map(convert);
    if (value.map)
      return new Map(
        value.map.map(({ k, v }: any) => [convert(k), convert(v)]),
      );
    if (typeof value.constructor === "number")
      return new Constr(value.constructor, value.fields.map(convert));
    throw new Error("Unsupported datum JSON");
  }
  return Data.to(convert(json));
}

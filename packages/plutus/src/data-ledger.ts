import { ledger } from "@lucid-evolution/ledger";
import { Constr } from "./constr.js";
import type { Data } from "./data.js";
type WireData =
  | { int: string }
  | { bytes: string }
  | { list: WireData[] }
  | { map: { k: WireData; v: WireData }[] }
  | { constructor: number; fields: WireData[] };
function toWire(data: Data): WireData {
  if (typeof data === "bigint") return { int: data.toString() };
  if (typeof data === "string") return { bytes: data };
  if (data instanceof Constr)
    return {
      constructor: data.index,
      fields: data.fields.flatMap((field) => [toWire(field)]),
    };
  if (Array.isArray(data))
    return { list: data.flatMap((field) => [toWire(field)]) };
  if (data instanceof Map)
    return {
      map: Array.from(data, ([k, v]) => ({ k: toWire(k), v: toWire(v) })),
    };
  throw new Error("Unsupported Plutus data value");
}
function fromWire(data: WireData): Data {
  if ("int" in data) return BigInt(data.int);
  if ("bytes" in data) return data.bytes;
  if ("list" in data) return data.list.map(fromWire);
  if ("map" in data)
    return new Map(data.map.map(({ k, v }) => [fromWire(k), fromWire(v)]));
  return new Constr(Number(data.constructor), data.fields.map(fromWire));
}
export function dataToCbor(data: Data, canonical: boolean): string {
  return ledger<string>("data.encode", { data: toWire(data), canonical });
}
export function dataFromCbor(cbor: string): Data {
  return fromWire(ledger<WireData>("data.decode", { cbor }));
}

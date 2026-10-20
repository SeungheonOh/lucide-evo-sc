import { ledger } from "@lucid-evolution/ledger";

import type { CborTerm } from "@lucid-evolution/ledger";
export type { CborTerm };
export const encodeTerm = (value: CborTerm): string =>
  ledger("cbor.encode", { value });
export const decodeTerm = (cbor: string): CborTerm =>
  ledger("cbor.decode", { cbor });
export const integer = (value: bigint | number | string): CborTerm => ({
  int: String(value),
});
export function asList(value: CborTerm): CborTerm[] {
  if (value && typeof value === "object" && "tag" in value)
    return asList(value.value);
  if (!value || typeof value !== "object" || !("list" in value))
    throw new Error("Expected a CBOR list");
  return value.list;
}
export function asMap(value: CborTerm): [CborTerm, CborTerm][] {
  if (!value || typeof value !== "object" || !("map" in value))
    throw new Error("Expected a CBOR map");
  return value.map;
}
export function asBytes(value: CborTerm): string {
  if (!value || typeof value !== "object" || !("bytes" in value))
    throw new Error("Expected a CBOR byte string");
  return value.bytes;
}
export function asInteger(value: CborTerm): bigint {
  if (!value || typeof value !== "object" || !("int" in value))
    throw new Error("Expected a CBOR integer");
  return BigInt(value.int);
}

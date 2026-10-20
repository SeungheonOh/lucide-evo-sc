import { ledger } from "./runtime.js";
import { CborTag, type CborValue } from "./types.js";
export type CborTerm =
  | null
  | boolean
  | { int: string }
  | { bytes: string }
  | { text: string }
  | { list: CborTerm[]; indefinite?: boolean }
  | { map: [CborTerm, CborTerm][]; indefinite?: boolean }
  | { tag: string; value: CborTerm };
const indefinite = new WeakSet<object>();
export const bytesToHex = (bytes: Uint8Array): string =>
  Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
export const hexToBytes = (hex: string): Uint8Array => {
  if (!/^(?:[0-9a-fA-F]{2})*$/.test(hex))
    throw new Error("Invalid hexadecimal bytes");
  return Uint8Array.from(hex.match(/../g) ?? [], (b) => parseInt(b, 16));
};
export function toCborTerm(value: CborValue): CborTerm {
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "bigint") return { int: value.toString() };
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value))
      throw new Error("CBOR integer must be a bigint or a safe integer");
    return { int: String(value) };
  }
  if (typeof value === "string") return { text: value };
  if (value instanceof Uint8Array) return { bytes: bytesToHex(value) };
  if (value instanceof CborTag)
    return { tag: String(value.tag), value: toCborTerm(value.value) };
  if (Array.isArray(value))
    return {
      list: value.map(toCborTerm),
      ...(indefinite.has(value) ? { indefinite: true } : {}),
    };
  if (value instanceof Map)
    return {
      map: Array.from(value, ([k, v]) => [toCborTerm(k), toCborTerm(v)]),
      ...(indefinite.has(value) ? { indefinite: true } : {}),
    };
  throw new Error("Unsupported CBOR value");
}
export function fromCborTerm(term: CborTerm): CborValue {
  if (term === null || typeof term === "boolean") return term;
  if ("int" in term) return BigInt(term.int);
  if ("bytes" in term) return hexToBytes(term.bytes);
  if ("text" in term) return term.text;
  if ("tag" in term)
    return new CborTag(BigInt(term.tag), fromCborTerm(term.value));
  const value =
    "list" in term
      ? term.list.map(fromCborTerm)
      : new Map(term.map.map(([k, v]) => [fromCborTerm(k), fromCborTerm(v)]));
  if (term.indefinite) indefinite.add(value);
  return value;
}
export function encodeCbor(value: CborValue, canonical = false): string {
  return ledger<string>("cbor.encode", { value: toCborTerm(value), canonical });
}
export function decodeCbor(cbor: string): CborValue {
  return fromCborTerm(ledger<CborTerm>("cbor.decode", { cbor }));
}

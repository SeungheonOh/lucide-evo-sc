import type { Datum, DatumHash } from "@lucid-evolution/core-types";
import { ledger } from "@lucid-evolution/ledger";
export function datumToHash(datum: Datum): DatumHash {
  return ledger("data.hash", { cbor: datum });
}

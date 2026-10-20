import type {
  Address,
  Exact,
  Credential,
  MintingPolicy,
  Network,
  PolicyId,
  Script,
  ScriptHash,
  Validator,
} from "@lucid-evolution/core-types";
import { fromHex } from "@lucid-evolution/core-utils";
import { Data } from "@lucid-evolution/plutus";
import { ledger } from "@lucid-evolution/ledger";
import { credentialToAddress } from "./credential.js";
import { applyDoubleCborEncoding } from "./cbor.js";
import {
  asInteger,
  asList,
  asBytes,
  decodeTerm,
  encodeTerm,
  integer,
} from "./ledger-cbor.js";

export function validatorToAddress(
  network: Network,
  validator: Validator,
  stakeCredential?: Credential,
): Address {
  return credentialToAddress(
    network,
    { type: "Script", hash: validatorToScriptHash(validator) },
    stakeCredential,
  );
}
export function validatorToScriptHash(validator: Validator): ScriptHash {
  return ledger("script.hash", {
    ...validator,
    script:
      validator.type === "Native"
        ? validator.script
        : applyDoubleCborEncoding(validator.script),
  });
}
export function scriptCborBytes(script: Script): Uint8Array {
  return fromHex(
    script.type === "Native"
      ? script.script
      : applyDoubleCborEncoding(script.script),
  );
}
export function toScriptRef(script: Script): string {
  validatorToScriptHash(script);
  const version = script.type === "Native" ? 0 : Number(script.type.slice(-1));
  const value =
    version === 0
      ? decodeTerm(script.script)
      : decodeTerm(applyDoubleCborEncoding(script.script));
  return encodeTerm({ list: [integer(version), value] });
}
export function fromScriptRef(cbor: string): Script {
  const [version, value] = asList(decodeTerm(cbor));
  const n = Number(asInteger(version));
  if (n === 0) return { type: "Native", script: encodeTerm(value) };
  if (n < 1 || n > 3) throw new Error("Unknown script language");
  return {
    type: `PlutusV${n}` as Script["type"],
    script: applyDoubleCborEncoding(asBytes(value)),
  };
}
export const mintingPolicyToId = (mintingPolicy: MintingPolicy): PolicyId =>
  validatorToScriptHash(mintingPolicy);
export function applyParamsToScript<T extends unknown[] = Data[]>(
  script: string,
  params: Exact<[...T]>,
  type?: T,
): string {
  const values = (type ? Data.castTo<T>(params, type) : params) as Data[];
  return applyDoubleCborEncoding(
    ledger<string>("script.applyParams", {
      script: applyDoubleCborEncoding(script),
      params: values.map((value) => Data.to(value)),
    }),
  );
}

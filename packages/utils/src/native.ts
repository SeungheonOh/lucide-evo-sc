import type { Native, Script } from "@lucid-evolution/core-types";
import * as S from "@effect/schema/Schema";
import { ledger } from "@lucid-evolution/ledger";

export const nativeScriptToCbor = (script: Native): string =>
  ledger("native.encode", { script });
export const scriptFromNative = (script: Native): Script => ({
  type: "Native",
  script: nativeScriptToCbor(script),
});

export type NativeScriptJson =
  | {
      ScriptPubkey: {
        ed25519_key_hash: string;
      };
    }
  | {
      ScriptInvalidBefore: { before: number };
    }
  | {
      ScriptInvalidHereafter: { after: number };
    }
  | {
      ScriptAll: {
        native_scripts: ReadonlyArray<NativeScriptJson>;
      };
    }
  | {
      ScriptAny: {
        native_scripts: ReadonlyArray<NativeScriptJson>;
      };
    }
  | {
      ScriptNOfK: {
        n: number;
        native_scripts: ReadonlyArray<NativeScriptJson>;
      };
    };

/**
 * Schema definition for NativeScriptJson type using effect schema
 */
const NativeScriptJsonSchema: S.Schema<NativeScriptJson> = S.Union(
  S.Struct({
    ScriptPubkey: S.Struct({
      ed25519_key_hash: S.String,
    }),
  }),
  S.Struct({
    ScriptInvalidBefore: S.Struct({
      before: S.Number,
    }),
  }),
  S.Struct({
    ScriptInvalidHereafter: S.Struct({
      after: S.Number,
    }),
  }),
  S.Struct({
    ScriptAll: S.Struct({
      native_scripts: S.Array(S.suspend(() => NativeScriptJsonSchema)),
    }),
  }),
  S.Struct({
    ScriptAny: S.Struct({
      native_scripts: S.Array(S.suspend(() => NativeScriptJsonSchema)),
    }),
  }),
  S.Struct({
    ScriptNOfK: S.Struct({
      n: S.Number,
      native_scripts: S.Array(S.suspend(() => NativeScriptJsonSchema)),
    }),
  }),
);

/**
 * Parses a NativeScriptJson type from an unknown input using effect schema.
 * This function is useful for decoding unknown data to NativeScriptJson from a file or an API.
 *
 *  @throws {ParseError} - Throws a ParseError if the input does not conform to the schema.
 */
export const parseNativeScriptJson = S.decodeUnknownSync(
  NativeScriptJsonSchema,
);

export function scriptFromNativeJson(script: NativeScriptJson): Script {
  function convert(value: NativeScriptJson): Native {
    if ("ScriptPubkey" in value)
      return { type: "sig", keyHash: value.ScriptPubkey.ed25519_key_hash };
    if ("ScriptInvalidBefore" in value)
      return { type: "after", slot: value.ScriptInvalidBefore.before };
    if ("ScriptInvalidHereafter" in value)
      return { type: "before", slot: value.ScriptInvalidHereafter.after };
    if ("ScriptAll" in value)
      return {
        type: "all",
        scripts: value.ScriptAll.native_scripts.map(convert),
      };
    if ("ScriptAny" in value)
      return {
        type: "any",
        scripts: value.ScriptAny.native_scripts.map(convert),
      };
    return {
      type: "atLeast",
      required: value.ScriptNOfK.n,
      scripts: value.ScriptNOfK.native_scripts.map(convert),
    };
  }
  return scriptFromNative(convert(script));
}

import * as Effect from "effect/Effect";
import type { Assets, Redeemer } from "@lucid-evolution/core-types";
import { ERROR_MESSAGE, TxBuilderError } from "../../Errors.js";
import { recordScMint } from "../../sc-tools/intent.js";
import { TxConfig } from "./Service.js";
export const mintError = (cause: unknown) =>
  new TxBuilderError({ cause: `{ Mint: ${cause} }` });
export const mintAssets = (assets: Assets) => (redeemer?: Redeemer) =>
  Effect.gen(function* () {
    const { config } = yield* TxConfig;
    yield* Effect.try({
      try: () => {
        const units = Object.keys(assets);
        if (!units.length || units.includes("lovelace"))
          throw new Error("Minting requires native assets");
        if (new Set(units.map((unit) => unit.slice(0, 56))).size !== 1)
          throw new Error("Only one policy is allowed per mintAssets call");
        const policyId = units[0].slice(0, 56);
        if (!config.scripts.has(policyId))
          throw new Error(ERROR_MESSAGE.MISSING_POLICY(policyId));
        recordScMint(config, assets, redeemer);
      },
      catch: mintError,
    });
  });

import * as Effect from "effect/Effect";
import type {
  Redeemer,
  RedeemerBuilder,
  UTxO,
} from "@lucid-evolution/core-types";
import { ERROR_MESSAGE, TxBuilderError } from "../../Errors.js";
import { recordScInput } from "../../sc-tools/intent.js";
import { resolveDatum } from "./TxUtils.js";
import { TxConfig } from "./Service.js";
export const collectError = (cause: unknown) =>
  new TxBuilderError({ cause: `{ Collect: ${cause} }` });
export const collectFromUTxO =
  (utxos: UTxO[], collectInputs = true) =>
  (redeemer?: Redeemer) =>
    Effect.gen(function* () {
      const { config } = yield* TxConfig;
      if (!utxos.length)
        return yield* Effect.fail(collectError(ERROR_MESSAGE.EMPTY_UTXO));
      for (const utxo of utxos) {
        utxo.datum = yield* resolveDatum(
          utxo.datumHash,
          utxo.datum,
          config.lucidConfig.provider,
        );
        if (collectInputs) config.collectedInputs.push(utxo);
        yield* Effect.try({
          try: () => recordScInput(config, utxo, redeemer),
          catch: collectError,
        });
      }
    });
export const collectFromUTxOPartial = (
  utxos: UTxO[],
  redeemer: RedeemerBuilder,
) =>
  Effect.gen(function* () {
    const { config } = yield* TxConfig;
    if (!utxos.length)
      return yield* Effect.fail(collectError(ERROR_MESSAGE.EMPTY_UTXO));
    if (redeemer.kind === "self") redeemer.inputs = utxos;
    config.collectedInputs.push(...utxos);
    config.partialPrograms.set(redeemer, collectFromUTxO(utxos, false));
  });

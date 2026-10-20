import * as Effect from "effect/Effect";
import type { UTxO } from "@lucid-evolution/core-types";
import { ERROR_MESSAGE, TxBuilderError } from "../../Errors.js";
import { resolveDatum } from "./TxUtils.js";
import { TxConfig } from "./Service.js";
import { outRefKey } from "./RedeemerContext.js";
export const readError = (cause: unknown) =>
  new TxBuilderError({ cause: `{ Read: ${cause} }` });
export const readFrom = (utxos: UTxO[]) =>
  Effect.gen(function* () {
    const { config } = yield* TxConfig;
    if (!utxos.length)
      return yield* Effect.fail(readError(ERROR_MESSAGE.EMPTY_UTXO));
    const read = new Set(config.readInputs.map(outRefKey));
    for (const utxo of utxos) {
      const datum = yield* resolveDatum(
        utxo.datumHash,
        utxo.datum,
        config.lucidConfig.provider,
      );
      if (!read.has(outRefKey(utxo))) {
        config.readInputs.push({ ...utxo, datum });
        read.add(outRefKey(utxo));
      }
    }
  });

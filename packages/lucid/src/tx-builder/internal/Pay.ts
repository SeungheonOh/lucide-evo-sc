import * as Effect from "effect/Effect";
import {
  addAssets,
  datumToHash,
  calculateMinLovelaceFromUTxO,
} from "@lucid-evolution/utils";
import type {
  Address,
  Assets,
  Script,
  TxOutput,
  UTxO,
} from "@lucid-evolution/core-types";
import { ledger } from "@lucid-evolution/ledger";
import type { OutputDatum } from "../types.js";
import { recordScOutput } from "../../sc-tools/intent.js";
import { ERROR_MESSAGE, TxBuilderError } from "../../Errors.js";
import { validateAddressDetails } from "./TxUtils.js";
import { TxConfig } from "./Service.js";
export const payError = (cause: unknown) =>
  new TxBuilderError({ cause: `{ Pay: ${cause} }` });
export const payToAddress = (address: Address, assets: Assets) =>
  Effect.gen(function* () {
    if (!Object.keys(assets).length)
      return yield* Effect.fail(payError(ERROR_MESSAGE.EMPTY_ASSETS));
    yield* ToAddressWithData(address, undefined, assets);
  });
export const ToAddressWithData = (
  address: Address,
  datum?: OutputDatum,
  assets: Assets = {},
  scriptRef?: Script,
) =>
  Effect.gen(function* () {
    const { config } = yield* TxConfig;
    yield* validateAddressDetails(address, config.lucidConfig);
    yield* Effect.try({
      try: () => {
        if (datum && !datum.value.trim())
          throw new Error(
            "datum value is missing. Please provide a non-empty cbor hex data.",
          );
        if (Object.values(assets).some((q) => q < 0n))
          throw new Error("Output quantities must be nonnegative");
        const output: TxOutput = {
          address,
          assets: { ...assets },
          ...(scriptRef ? { scriptRef } : {}),
          ...(datum?.kind === "hash"
            ? { datumHash: datum.value }
            : datum?.kind === "asHash"
              ? { datumHash: datumToHash(datum.value) }
              : datum
                ? { datum: datum.value }
                : {}),
        };
        let minimum = 0n;
        for (let i = 0; i < 4; i++) {
          minimum = calculateMinLovelaceFromUTxO(
            config.lucidConfig.protocolParameters.coinsPerUtxoByte,
            output as UTxO,
          );
          if ((output.assets.lovelace ?? 0n) >= minimum) break;
          output.assets.lovelace = minimum;
        }
        config.totalOutputAssets = addAssets(
          config.totalOutputAssets,
          output.assets,
        );
        config.payToOutputs.push(output);
        recordScOutput(
          config,
          output,
          datum?.kind === "asHash" ? datum.value : undefined,
        );
      },
      catch: payError,
    });
  });
export const ToContract = ToAddressWithData;

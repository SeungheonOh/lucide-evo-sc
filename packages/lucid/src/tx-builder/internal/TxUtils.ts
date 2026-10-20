import * as Effect from "effect/Effect";
import { getAddressDetails, networkToId } from "@lucid-evolution/utils";
import type {
  Address,
  AddressDetails,
  RewardAddress,
  RedeemerBuilder,
  Credential,
  UTxO,
  Provider,
} from "@lucid-evolution/core-types";
import { ERROR_MESSAGE, TxBuilderError } from "../../Errors.js";
import type { LucidConfig } from "../../lucid-evolution/LucidEvolution.js";
import type { TxBuilderConfig } from "../TxBuilder.js";
import { TxConfig } from "./Service.js";
export const txBuilderError = (cause: unknown) =>
  new TxBuilderError({ cause: `{ TxBuilder: ${cause} }` });
export const handleRedeemerBuilder = (
  config: TxBuilderConfig,
  partialProgram: (
    redeemer?: string,
  ) => Effect.Effect<void, TxBuilderError, TxConfig>,
  redeemer?: string | RedeemerBuilder,
) => {
  if (typeof redeemer === "object")
    config.partialPrograms.set(redeemer, partialProgram);
  else config.programs.push(partialProgram(redeemer));
};
export const isEqual = (a: Uint8Array, b: Uint8Array): boolean =>
  a.length === b.length && a.every((v, i) => v === b[i]);
export const validateAddressDetails = (
  address: Address | RewardAddress,
  lucidConfig: LucidConfig,
): Effect.Effect<AddressDetails, TxBuilderError> =>
  Effect.try({
    try: () => {
      const details = getAddressDetails(address),
        id = networkToId(lucidConfig.network);
      if (details.networkId !== id)
        throw new Error(
          ERROR_MESSAGE.INVALID_NETWORK(address, id, lucidConfig.network),
        );
      return details;
    },
    catch: txBuilderError,
  });
export const validateAndGetStakeCredential = (
  address: RewardAddress,
  config: TxBuilderConfig,
): Effect.Effect<Credential, TxBuilderError> =>
  Effect.gen(function* () {
    const details = yield* validateAddressDetails(address, config.lucidConfig);
    if (details.type !== "Reward" || !details.stakeCredential)
      return yield* Effect.fail(
        txBuilderError(ERROR_MESSAGE.MISSING_REWARD_TYPE),
      );
    return details.stakeCredential;
  });
export const resolveDatum = (
  hash: UTxO["datumHash"],
  datum: UTxO["datum"],
  provider: Provider,
) =>
  Effect.gen(function* () {
    if (!hash || datum) return datum;
    return yield* Effect.tryPromise({
      try: () => provider.getDatum(hash),
      catch: txBuilderError,
    });
  });

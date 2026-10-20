import * as Effect from "effect/Effect";
import type {
  Lovelace,
  Redeemer,
  RewardAddress,
} from "@lucid-evolution/core-types";
import {
  recordCertificate,
  credentialCbor,
  recordScBlock,
  scWitness,
} from "../../sc-tools/intent.js";
import { TxBuilderError } from "../../Errors.js";
import { validateAndGetStakeCredential } from "./TxUtils.js";
import { TxConfig } from "./Service.js";
export const stakeError = (cause: unknown) =>
  new TxBuilderError({ cause: `{ Stake: ${cause} }` });
export const registerStake = (address: RewardAddress, redeemer?: Redeemer) =>
  Effect.gen(function* () {
    const { config } = yield* TxConfig,
      credential = yield* validateAndGetStakeCredential(address, config).pipe(
        Effect.mapError(stakeError),
      );
    yield* Effect.try({
      try: () =>
        recordCertificate(
          config,
          redeemer === undefined
            ? [0n, credentialCbor(credential)]
            : [
                7n,
                credentialCbor(credential),
                config.lucidConfig.protocolParameters.keyDeposit,
              ],
          credential,
          redeemer,
          redeemer !== undefined,
        ),
      catch: stakeError,
    });
  });
export const deRegisterStake = (address: RewardAddress, redeemer?: Redeemer) =>
  Effect.gen(function* () {
    const { config } = yield* TxConfig,
      credential = yield* validateAndGetStakeCredential(address, config).pipe(
        Effect.mapError(stakeError),
      );
    yield* Effect.try({
      try: () =>
        recordCertificate(
          config,
          [
            8n,
            credentialCbor(credential),
            config.lucidConfig.protocolParameters.keyDeposit,
          ],
          credential,
          redeemer,
        ),
      catch: stakeError,
    });
  });
export const withdraw =
  (address: RewardAddress, amount: Lovelace) => (redeemer?: Redeemer) =>
    Effect.gen(function* () {
      const { config } = yield* TxConfig,
        credential = yield* validateAndGetStakeCredential(address, config).pipe(
          Effect.mapError(stakeError),
        );
      yield* Effect.try({
        try: () => {
          if (amount < 0n) throw new Error("Withdrawal must be nonnegative");
          recordScBlock(config, {
            type: "withdrawal",
            address,
            lovelace: String(amount),
            ...(credential.type === "Script"
              ? { witness: scWitness(config, credential.hash, redeemer) }
              : {}),
          });
        },
        catch: stakeError,
      });
    });

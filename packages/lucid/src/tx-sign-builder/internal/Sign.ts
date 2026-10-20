import * as Effect from "effect/Effect";
import { ledger, decodeCbor } from "@lucid-evolution/ledger";
import { ERROR_MESSAGE, TxSignerError } from "../../Errors.js";
import type { TxSignBuilderConfig } from "../TxSignBuilder.js";
import type {
  PrivateKey,
  TransactionWitnesses,
} from "@lucid-evolution/core-types";
export const signError = (cause: unknown) => new TxSignerError({ cause });
export const partialWithWallet = (
  config: TxSignBuilderConfig,
): Effect.Effect<TransactionWitnesses, TxSignerError> =>
  Effect.tryPromise({
    try: async () => {
      if (!config.wallet) throw new Error(ERROR_MESSAGE.MISSING_WALLET);
      return config.wallet.signTx(config.txComplete.cbor);
    },
    catch: signError,
  });
export const withWallet = (config: TxSignBuilderConfig) =>
  partialWithWallet(config).pipe(
    Effect.map((witness) => {
      config.witnessSets.push(witness);
    }),
  );
export const partialWithPrivateKey = (
  config: TxSignBuilderConfig,
  privateKey: PrivateKey,
): Effect.Effect<TransactionWitnesses, TxSignerError> =>
  Effect.try({
    try: () =>
      ledger<string>("tx.sign", {
        cbor: config.txComplete.cbor,
        privateKeys: [privateKey],
      }),
    catch: signError,
  });
export const withPrivateKey = (
  config: TxSignBuilderConfig,
  privateKey: PrivateKey,
) =>
  partialWithPrivateKey(config, privateKey).pipe(
    Effect.map((witness) => {
      config.witnessSets.push(witness);
    }),
  );
export const assemble = (
  config: TxSignBuilderConfig,
  witnesses: TransactionWitnesses[],
) =>
  Effect.try({
    try: () => {
      for (const witness of witnesses) {
        if (!(decodeCbor(witness) instanceof Map))
          throw new Error("Expected a CBOR transaction witness set");
      }
      config.witnessSets.push(...witnesses);
    },
    catch: signError,
  });

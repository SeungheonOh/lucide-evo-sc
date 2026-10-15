import { Effect, pipe } from "effect";
import { CML } from "../../core.js";
import {
  ERROR_MESSAGE,
  RunTimeError,
  TransactionSignError,
} from "../../Errors.js";
import * as TxSignBuilder from "../TxSignBuilder.js";
import * as TxSubmitBuilder from "../../tx-submit/TxSubmit.js";
import { signError } from "./Sign.js";
import { withCMLScope } from "@lucid-evolution/core-utils";

export const completeTxSigner = (
  config: TxSignBuilder.TxSignBuilderConfig,
): Effect.Effect<TxSubmitBuilder.TxSigned, TransactionSignError> =>
  Effect.gen(function* () {
    yield* Effect.all(config.programs, { concurrency: "unbounded" });
    const signedTx = withCMLScope((own) => {
      const witnessSet = own(config.txComplete.witness_set());
      const plutus_datums = own(witnessSet.plutus_datums());
      // TODO: currently add_existing does not support add_plutus_datums
      // https://github.com/dcSpark/cardano-multiplatform-lib/pull/350/files
      config.witnessSetBuilder.add_existing(witnessSet);
      if (plutus_datums) {
        for (let i = 0; i < plutus_datums.len(); i++) {
          // `add_plutus_datum` takes ownership of the datum.
          config.witnessSetBuilder.add_plutus_datum(plutus_datums.get(i));
        }
      }
      const mergedWitnesses = own(config.witnessSetBuilder.build());
      const redeemers = own(witnessSet.redeemers());
      // The signing builder flattens Conway redeemer maps into legacy arrays.
      // Preserve the original representation: its bytes are part of the script
      // data hash already committed to by the body and every signature.
      if (redeemers) mergedWitnesses.set_redeemers(redeemers);
      // `Transaction.new` takes ownership of the auxiliary data.
      return CML.Transaction.new(
        own(config.txComplete.body()),
        mergedWitnesses,
        true,
        config.txComplete.auxiliary_data(),
      );
    });
    const wallet = yield* pipe(
      Effect.fromNullable(config.wallet),
      Effect.orElseFail(() => signError(ERROR_MESSAGE.MISSING_WALLET)),
    );
    return TxSubmitBuilder.makeSubmit(wallet, signedTx);
  }).pipe(Effect.catchAllDefect((cause) => new RunTimeError({ cause })));

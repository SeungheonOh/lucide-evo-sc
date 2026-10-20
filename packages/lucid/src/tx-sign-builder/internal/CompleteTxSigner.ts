import * as Effect from "effect/Effect";
import { ledger, inspectTransaction } from "@lucid-evolution/ledger";
import {
  ERROR_MESSAGE,
  RunTimeError,
  type TransactionSignError,
} from "../../Errors.js";
import type { TxSignBuilderConfig } from "../TxSignBuilder.js";
import { makeSubmit, type TxSigned } from "../../tx-submit/TxSubmit.js";
import { signError } from "./Sign.js";
export const completeTxSigner = (
  config: TxSignBuilderConfig,
): Effect.Effect<TxSigned, TransactionSignError> =>
  Effect.gen(function* () {
    yield* Effect.all(config.programs, { concurrency: "unbounded" });
    const wallet = yield* Effect.fromNullable(config.wallet).pipe(
      Effect.orElseFail(() => signError(ERROR_MESSAGE.MISSING_WALLET)),
    );
    const signed = yield* Effect.try({
      try: () =>
        inspectTransaction(
          ledger<string>("tx.mergeWitnesses", {
            cbor: config.txComplete.cbor,
            witnessSets: config.witnessSets,
          }),
        ),
      catch: signError,
    });
    return makeSubmit(wallet, signed);
  }).pipe(Effect.catchAllDefect((cause) => new RunTimeError({ cause })));

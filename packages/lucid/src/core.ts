import * as Effect from "effect/Effect";

export type {
  TransactionSnapshot,
  TransactionBodySnapshot,
} from "@lucid-evolution/ledger";

export const makeReturn = <A, E>(program: Effect.Effect<A, E>) => {
  return {
    unsafeRun: () => Effect.runPromise(program),
    safeRun: () => Effect.runPromise(Effect.either(program)),
    program: () => program,
  };
};

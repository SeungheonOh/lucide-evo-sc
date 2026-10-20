import { Effect } from "effect";
import { User } from "./services.js";
import { handleSignSubmit, withLogRetry } from "./utils.js";

const DONATION = 500_000n;

export const donateToTreasury = Effect.gen(function* () {
  const { user } = yield* User;

  const signBuilder = yield* user
    .newTx()
    .donateToTreasury(DONATION)
    .completeProgram();

  const body = signBuilder.toTransaction().body;
  const currentTreasuryValue = body.currentTreasury;

  if (body.treasuryDonation !== DONATION) {
    return yield* Effect.fail(new Error("Unexpected treasury donation value"));
  }

  if (typeof currentTreasuryValue !== "bigint") {
    return yield* Effect.fail(new Error("Missing current treasury value"));
  }

  return signBuilder;
}).pipe(Effect.flatMap(handleSignSubmit), withLogRetry, Effect.orDie);

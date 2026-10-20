import { describe, expect, test } from "vitest";
import { Cause, Effect, Layer, pipe } from "effect";
import { makeHaskellEvaluator } from "../../src/index.js";
import { EvaluationInput, EvaluatorAdapter, Lucid } from "../../src/index.js";
import { HelloContract } from "../specs/services.js";
import { User } from "./service/EmulatorUser.js";
import { EmulatorInstance } from "./service/EmulatorInstance.js";
import { CONSTANTS } from "./Constants.js";
import * as StakeExecutor from "./executor/StakeExecutor.js";
import * as PayExecutor from "./executor/PayExecutor.js";
import * as MintExecutor from "./executor/MintExecutor.js";
import * as HelloExecutor from "./executor/HelloExecutor.js";
import * as HelloFailsExecutor from "./executor/HelloFailsExecutor.js";
import * as GovExecutor from "./executor/GovExecutor.js";
import * as SignExecutor from "./executor/SignExecutor.js";

const DefaultEnvironment = pipe(
  Layer.provide(User.layer, EmulatorInstance.layer),
  Layer.merge(EmulatorInstance.layer),
);

const makeCountingExplicitEvaluator = (
  evaluated: EvaluationInput[],
): EvaluatorAdapter => {
  const explicit = makeHaskellEvaluator();
  return {
    name: explicit.name,
    evaluate: async (input) => {
      evaluated.push(input);
      return explicit.evaluate(input);
    },
  };
};

const makeExplicitEnvironment = (evaluated: EvaluationInput[]) => {
  const makeExplicitSeedUser = Effect.gen(function* () {
    const { emulator, ACCOUNTS } = yield* EmulatorInstance;
    const user = yield* Effect.promise(() =>
      Lucid(emulator, "Custom", {
        evaluator: makeCountingExplicitEvaluator(evaluated),
      }),
    );
    user.selectWallet.fromSeed(ACCOUNTS.SEED_ACCOUNTS[0].seedPhrase);
    const getUtxos = Effect.promise(() => user.wallet().getUtxos());
    const rewardAddress = yield* pipe(
      Effect.promise(() => user.wallet().rewardAddress()),
      Effect.andThen(Effect.fromNullable),
    );
    return {
      user,
      getUtxos,
      rewardAddress,
    };
  });

  const ExplicitUserLayer = Layer.effect(User, makeExplicitSeedUser);

  return pipe(
    Layer.provide(ExplicitUserLayer, EmulatorInstance.layer),
    Layer.merge(EmulatorInstance.layer),
  );
};

type ParityCase = {
  name: string;
  requiresExplicitEvaluation?: boolean;
  expectedOutcome?: "Success" | "Failure";
  expectedError?: string;
} & (
  | {
      program: Effect.Effect<unknown, unknown, User | EmulatorInstance>;
      withHelloContract?: false;
    }
  | {
      program: Effect.Effect<
        unknown,
        unknown,
        User | EmulatorInstance | HelloContract
      >;
      withHelloContract: true;
    }
);

const runCase = (
  scenario: ParityCase,
  environment: Layer.Layer<User | EmulatorInstance, unknown>,
) =>
  Effect.runPromiseExit(
    scenario.withHelloContract
      ? scenario.program.pipe(
          Effect.provide(environment),
          Effect.provide(HelloContract.layer),
        )
      : scenario.program.pipe(Effect.provide(environment)),
  );

const cases: ParityCase[] = [
  {
    name: "mint tokens with composed transaction",
    program: MintExecutor.mintAndPay(),
  },
  {
    name: "mint tokens and register stake address in one composed transaction",
    program: MintExecutor.mintAndStake(),
  },
  {
    name: "register and then deregister stake address",
    program: Effect.gen(function* () {
      yield* StakeExecutor.registerStake;
      yield* StakeExecutor.deregisterStake;
    }),
  },
  {
    name: "compose transaction with datum hash and inline datum",
    program: PayExecutor.withDatumHashAndInlineDatum,
  },
  {
    name: "mint tokens with correct quantity in valid slot range",
    program: MintExecutor.mintInSlotRange(),
  },
  {
    name: "register stake address",
    program: StakeExecutor.registerStake,
  },
  {
    name: "register script stake address with redeemer",
    program: StakeExecutor.registerScriptStakeWithRedeemer,
    requiresExplicitEvaluation: true,
  },
  {
    name: "deposit funds to Hello contract and collect using readFrom",
    program: Effect.gen(function* () {
      yield* HelloExecutor.depositFunds;
      yield* HelloExecutor.collectFromReadFrom;
    }),
    withHelloContract: true,
    requiresExplicitEvaluation: true,
  },
  {
    name: "Hello contract collect fails with an incorrect redeemer",
    program: HelloFailsExecutor.collectWithWrongRedeemer,
    withHelloContract: true,
    requiresExplicitEvaluation: true,
    expectedOutcome: "Failure",
  },
  {
    name: "delegate to stake pool",
    program: Effect.gen(function* () {
      yield* StakeExecutor.registerStake;
      yield* StakeExecutor.delegateStake;
    }),
  },
  {
    name: "register DRep",
    program: GovExecutor.registerDRep,
  },
  {
    name: "delegate vote to always abstain",
    program: GovExecutor.delegateVoteToAlwaysAbstain,
  },
  {
    name: "register and retire stake pool",
    program: GovExecutor.registerAndRetirePool,
  },
  {
    name: "register, delegate, receive rewards, and withdraw them",
    program: Effect.gen(function* () {
      yield* StakeExecutor.registerStake;
      yield* StakeExecutor.delegateStake;
      yield* StakeExecutor.withdrawRewardAmount({
        rewardAmount: CONSTANTS.REWARD_AMOUNT,
      });
    }),
  },
  {
    name: "withdraw zero from a registered account with zero rewards",
    program: Effect.gen(function* () {
      yield* StakeExecutor.registerStake;
      yield* StakeExecutor.withdrawRewardAmount({ rewardAmount: 0n });
    }),
  },
  {
    name: "reject zero withdrawal while rewards remain",
    expectedOutcome: "Failure",
    expectedError: "WithdrawalsNotInRewardsCERTS",
    program: Effect.gen(function* () {
      yield* StakeExecutor.registerStake;
      yield* StakeExecutor.delegateStake;
      yield* StakeExecutor.withdrawRewardAmount({ rewardAmount: 0n });
    }),
  },
  {
    name: "send all funds to Hello contract",
    program: PayExecutor.sendAllFund,
    withHelloContract: true,
  },
  {
    name: "compose multiple transactions",
    program: PayExecutor.multiTxCompose,
  },
  {
    name: "compose mint and pay transactions",
    program: PayExecutor.mintAndPayTxCompose,
    requiresExplicitEvaluation: true,
  },
  {
    name: "verify message",
    program: SignExecutor.verifySignedMessage,
  },
  {
    name: "verify add signer key",
    program: SignExecutor.verifyAddSignerKey,
  },
];

describe("emulator evaluator parity", () => {
  test.each(cases)(
    "$name has the same outcome with default and explicit Haskell evaluators",
    async (scenario) => {
      const { expectedOutcome, expectedError, requiresExplicitEvaluation } =
        scenario;
      const explicitEvaluations: EvaluationInput[] = [];
      const defaultResult = await runCase(scenario, DefaultEnvironment);
      const explicit = await runCase(
        scenario,
        makeExplicitEnvironment(explicitEvaluations),
      );

      expect(explicit._tag).toBe(defaultResult._tag);
      expect(
        defaultResult._tag,
        defaultResult._tag === "Failure"
          ? Cause.pretty(defaultResult.cause)
          : undefined,
      ).toBe(expectedOutcome ?? "Success");
      if (expectedError) {
        expect(
          defaultResult._tag === "Failure" && Cause.pretty(defaultResult.cause),
        ).toContain(expectedError);
        expect(
          explicit._tag === "Failure" && Cause.pretty(explicit.cause),
        ).toContain(expectedError);
      }
      if (requiresExplicitEvaluation) {
        expect(explicitEvaluations.length).toBeGreaterThan(0);
      }
    },
  );
});

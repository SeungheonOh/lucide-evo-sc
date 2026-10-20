import {
  inspectTransaction,
  encodeCbor,
  type TransactionSnapshot,
} from "@lucid-evolution/ledger";
import { beforeEach, describe, expect, test } from "vitest";
import {
  applyParamsToScript,
  EvalRedeemer,
  Data,
  Emulator,
  EvaluatorAdapter,
  generateEmulatorAccount,
  Lucid,
  LucidEvolution,
  makeHaskellEvaluator,
  PROTOCOL_PARAMETERS_DEFAULT,
  Script,
  UTxO,
  validatorToAddress,
} from "../src/index.js";
import {
  alwaysSucceedV3Script,
  feeThresholdV3Script,
} from "./fixtures/scripts.js";

// Record actual evaluations through the public Haskell evaluator adapter.
type Evaluation = { key: string; tx: string; redeemers: EvalRedeemer[] };
const evaluations: Evaluation[] = [];
const evaluating = (): EvaluatorAdapter => {
  const haskell = makeHaskellEvaluator();
  return {
    name: "recorded-haskell",
    async evaluate(input) {
      const redeemers = await haskell.evaluate(input);
      evaluations.push({ key: input.tx, tx: input.tx, redeemers });
      return redeemers;
    },
  };
};

beforeEach(() => {
  evaluations.length = 0;
});

const recordEvaluations = async <T>(
  run: () => Promise<T>,
): Promise<{ result: T; evaluations: Evaluation[] }> => {
  const start = evaluations.length;
  const result = await run();
  return { result, evaluations: evaluations.slice(start) };
};

const bodyWithoutScriptDataHash = (tx: TransactionSnapshot): string => {
  const fields = new Map(tx.body.fields);
  fields.delete(11n);
  return encodeCbor(fields);
};
const totalSteps = (evaluation: Evaluation): bigint =>
  evaluation.redeemers.reduce(
    (total, redeemer) => total + BigInt(redeemer.ex_units.steps),
    0n,
  );
const evaluatedFee = (evaluation: Evaluation): bigint =>
  inspectTransaction(evaluation.tx).body.fee;
const expectFinalEvaluated = (
  tx: TransactionSnapshot,
  recorded: Evaluation[],
): void => {
  const body = bodyWithoutScriptDataHash(tx);
  const match = recorded
    .filter(
      (evaluation) =>
        bodyWithoutScriptDataHash(inspectTransaction(evaluation.tx)) === body,
    )
    .at(-1);
  expect(match).toBeDefined();
  expect(match!.redeemers).toEqual(
    tx.redeemers.map((redeemer) => ({
      redeemer_tag: redeemer.tag,
      redeemer_index: Number(redeemer.index),
      ex_units: {
        mem: Number(redeemer.exUnits.mem),
        steps: Number(redeemer.exUnits.steps),
      },
    })),
  );
  const required =
    (tx.body.fee * BigInt(PROTOCOL_PARAMETERS_DEFAULT.collateralPercentage) +
      99n) /
    100n;
  expect(tx.body.totalCollateral!).toBeGreaterThanOrEqual(required);
};

const setup = async (script: Script = alwaysSucceedV3Script) => {
  const account = generateEmulatorAccount({ lovelace: 1_000_000_000n });
  const emulator = new Emulator([account], PROTOCOL_PARAMETERS_DEFAULT);
  const lucid = await Lucid(emulator, "Custom", { evaluator: evaluating() });
  lucid.selectWallet.fromSeed(account.seedPhrase);
  const address = await lucid.wallet().address();
  const scriptAddress = validatorToAddress("Custom", script);
  const funded = await lucid
    .newTx()
    .pay.ToContract(
      scriptAddress,
      { kind: "inline", value: Data.void() },
      { lovelace: 20_000_000n },
    )
    .pay.ToAddress(address, { lovelace: 6_000_000n })
    .pay.ToAddress(address, { lovelace: 9_000_000n })
    .complete();
  await lucid.awaitTx(
    await (await funded.sign.withWallet().complete()).submit(),
  );
  const [input] = await lucid.utxosAt(scriptAddress);
  return { account, emulator, lucid, address, script, input };
};

type Fixture = Awaited<ReturnType<typeof setup>>;

const withThreshold = (threshold: bigint): Script => ({
  type: "PlutusV3",
  script: applyParamsToScript(feeThresholdV3Script.script, [threshold]),
});

// Spends the script UTxO, paying `amount` to the wallet. With
// coinSelection: false the script input alone funds the payment and fee.
const spend = (
  fixture: Fixture,
  options: Parameters<ReturnType<LucidEvolution["newTx"]>["complete"]>[0],
  amount = 10_000_000n,
  lucid = fixture.lucid,
) =>
  lucid
    .newTx()
    .collectFrom([fixture.input], Data.void())
    .attach.SpendingValidator(fixture.script)
    .pay.ToAddress(fixture.address, { lovelace: amount })
    .complete(options);

const spendDelayed = (fixture: Fixture, lucid = fixture.lucid) =>
  lucid
    .newTx()
    .collectFrom([fixture.input], (context) =>
      Data.to(context.inputIndex(fixture.input)!),
    )
    .attach.SpendingValidator(fixture.script)
    .pay.ToAddress(fixture.address, { lovelace: 10_000_000n })
    .complete();

const recordingEvaluator = (
  fixture: Fixture,
  recorded: string[],
): EvaluatorAdapter => ({
  name: "recording",
  evaluate: async ({ tx, additionalUTxOs }) => {
    recorded.push(tx);
    return fixture.emulator.evaluateTx(tx, additionalUTxOs as UTxO[]);
  },
});

describe("Haskell evaluator fixed points", () => {
  test("an explicit Haskell evaluator receives the provider's implicit protocol version", async () => {
    const fixture = await setup();
    expect(
      fixture.lucid.config().protocolParameters!.protocolMajorVersion,
    ).toBeUndefined();
    const versions: Array<[number | undefined, number | undefined]> = [];
    const haskell = makeHaskellEvaluator();
    const completed = await spend(fixture, {
      evaluator: {
        name: "protocol-version-regression",
        evaluate(input) {
          const parameters = input.context.protocolParameters;
          versions.push([
            parameters.protocolMajorVersion,
            parameters.protocolMinorVersion,
          ]);
          return haskell.evaluate(input);
        },
      },
    });
    expect(versions.length).toBeGreaterThan(0);
    for (const version of versions) expect(version).toEqual([11, 0]);
    await fixture.lucid.awaitTx(
      await (await completed.sign.withWallet().complete()).submit(),
    );
  });

  test("a delayed-redeemer completion is deterministic and evaluates its final body", async () => {
    const fixture = await setup();
    const first = await recordEvaluations(() => spendDelayed(fixture));
    expect(first.evaluations.length).toBeGreaterThanOrEqual(2);
    const keys = first.evaluations.map((evaluation) => evaluation.key);
    expect(new Set(keys).size).toBeGreaterThanOrEqual(2);
    expectFinalEvaluated(first.result.toTransaction(), first.evaluations);

    // Separate completions do not share results.
    const second = await recordEvaluations(() => spendDelayed(fixture));
    expect(second.evaluations.map((evaluation) => evaluation.key)).toEqual(
      keys,
    );
    expect(second.result.toCBOR()).toBe(first.result.toCBOR());

    await fixture.lucid.awaitTx(
      await (await first.result.sign.withWallet().complete()).submit(),
    );
  });

  test("custom evaluators still receive every request", async () => {
    const fixture = await setup();
    const fromOptions: string[] = [];
    await recordEvaluations(() =>
      fixture.lucid
        .newTx()
        .collectFrom([fixture.input], (context) =>
          Data.to(context.inputIndex(fixture.input)!),
        )
        .attach.SpendingValidator(fixture.script)
        .pay.ToAddress(fixture.address, { lovelace: 10_000_000n })
        .complete({ evaluator: recordingEvaluator(fixture, fromOptions) }),
    );
    const configured: string[] = [];
    const configuredLucid = await Lucid(fixture.emulator, "Custom", {
      evaluator: recordingEvaluator(fixture, configured),
    });
    configuredLucid.selectWallet.fromSeed(fixture.account.seedPhrase);
    const { evaluations: wasm } = await recordEvaluations(() =>
      spendDelayed(fixture, configuredLucid),
    );

    expect(wasm).toHaveLength(0);
    // The delayed fixed point repeats its final request; a custom evaluator
    // is asked again rather than served a remembered result.
    for (const recorded of [fromOptions, configured]) {
      expect(recorded).toHaveLength(3);
      expect(new Set(recorded).size).toBe(2);
    }
  });

  test("a custom evaluator sees the draft once and the final transaction once", async () => {
    const fixture = await setup();
    const recorded: string[] = [];
    const { result, evaluations: wasm } = await recordEvaluations(() =>
      spend(fixture, { evaluator: recordingEvaluator(fixture, recorded) }),
    );
    expect(wasm).toHaveLength(0);
    expect(recorded).toHaveLength(2);
    const final = result.toTransaction();
    expect(bodyWithoutScriptDataHash(inspectTransaction(recorded[1]))).toBe(
      bodyWithoutScriptDataHash(final),
    );
  });
});

describe("static script spend", () => {
  test("evaluates the collateral-free draft once and the final transaction to a fixed point", async () => {
    const fixture = await setup();
    const { result, evaluations: recorded } = await recordEvaluations(() =>
      spend(fixture, { coinSelection: false }),
    );
    expect(recorded).toHaveLength(2);
    expectFinalEvaluated(result.toTransaction(), recorded);
    await fixture.lucid.awaitTx(
      await (await result.sign.withWallet().complete()).submit(),
    );
  });

  test("automatic coin selection evaluates the draft once and the final transaction once", async () => {
    const fixture = await setup();
    const { result, evaluations: recorded } = await recordEvaluations(() =>
      spend(fixture, { coinSelection: true }),
    );
    expect(recorded).toHaveLength(2);
    expectFinalEvaluated(result.toTransaction(), recorded);
    await fixture.lucid.awaitTx(
      await (await result.sign.withWallet().complete()).submit(),
    );
  });

  test("automatic coin selection evaluates a fee-dependent script in its final context", async () => {
    // Below the threshold for any fee: find the provisional and final fees.
    const probe = await setup(withThreshold(100_000_000n));
    const probed = await recordEvaluations(() => spend(probe, {}));
    const provisionalFee = evaluatedFee(probed.evaluations[0]);
    const finalFee = probed.result.toTransaction().body.fee;
    expect(finalFee).toBeGreaterThan(provisionalFee);

    const threshold = (provisionalFee + finalFee) / 2n;
    const fixture = await setup(withThreshold(threshold));
    const { result, evaluations: recorded } = await recordEvaluations(() =>
      spend(fixture, {}),
    );
    expect(recorded.length).toBeGreaterThanOrEqual(3);
    expect(totalSteps(recorded.at(-1)!)).toBeGreaterThan(
      totalSteps(recorded[0]),
    );
    expectFinalEvaluated(result.toTransaction(), recorded);
    await fixture.lucid.awaitTx(
      await (await result.sign.withWallet().complete()).submit(),
    );
  });

  test("an unfunded payment is still refused", async () => {
    const fixture = await setup();
    await expect(
      spend(fixture, { coinSelection: false }, 20_000_000n),
    ).rejects.toThrow(/insufficient|enough|balance|negative/i);
  });

  test("a setCollateral below the final fee's requirement is raised to cover it", async () => {
    const fixture = await setup();
    const result = await spend(fixture, {
      coinSelection: false,
      setCollateral: 0n,
    });
    const tx = result.toTransaction();
    const required =
      (tx.body.fee * BigInt(PROTOCOL_PARAMETERS_DEFAULT.collateralPercentage) +
        99n) /
      100n;
    expect(tx.body.totalCollateral).toBe(required);
    await fixture.lucid.awaitTx(
      await (await result.sign.withWallet().complete()).submit(),
    );
  });

  test("a script whose cost depends on the fee is evaluated in its final context", async () => {
    // Below the threshold for any fee: find the provisional and final fees.
    const probe = await setup(withThreshold(100_000_000n));
    const probed = await recordEvaluations(() =>
      spend(probe, { coinSelection: false }),
    );
    const provisionalFee = evaluatedFee(probed.evaluations[0]);
    const finalFee = probed.result.toTransaction().body.fee;
    expect(finalFee).toBeGreaterThan(provisionalFee);

    // A threshold between the two: the provisional draft takes the cheap
    // branch and the final transaction the expensive one.
    const threshold = (provisionalFee + finalFee) / 2n;
    const fixture = await setup(withThreshold(threshold));
    const { result, evaluations: recorded } = await recordEvaluations(() =>
      spend(fixture, { coinSelection: false, setCollateral: 1_000_000n }),
    );
    expect(recorded.length).toBeGreaterThanOrEqual(3);
    expect(totalSteps(recorded.at(-1)!)).toBeGreaterThan(
      totalSteps(recorded[0]),
    );
    expectFinalEvaluated(result.toTransaction(), recorded);
    // Collateral sized from the provisional fee is raised to the final one.
    const raised = await spend(fixture, {
      coinSelection: false,
      setCollateral: 0n,
    });
    expect(raised.toTransaction().body.fee).toBe(
      result.toTransaction().body.fee,
    );
    expectFinalEvaluated(raised.toTransaction(), evaluations);

    await fixture.lucid.awaitTx(
      await (await result.sign.withWallet().complete()).submit(),
    );
  });
});

describe("evaluator bytes path", () => {
  const bytesEvaluator = (
    fixture: Fixture,
    viaBytes: Uint8Array[],
    viaHex: string[],
  ): EvaluatorAdapter => {
    const adapter: EvaluatorAdapter = {
      name: "bytes",
      evaluate: async ({ tx, additionalUTxOs }) => {
        viaHex.push(tx);
        return fixture.emulator.evaluateTx(tx, additionalUTxOs as UTxO[]);
      },
    };
    Object.defineProperty(adapter, "evaluateBytes", {
      value: async ({
        tx,
        additionalUTxOs,
      }: {
        tx: Uint8Array;
        additionalUTxOs: UTxO[];
      }) => {
        viaBytes.push(tx);
        return fixture.emulator.evaluateTx(
          Buffer.from(tx).toString("hex"),
          additionalUTxOs,
        );
      },
    });
    return adapter;
  };

  test("an adapter with evaluateBytes receives the transaction as bytes", async () => {
    const fixture = await setup();
    const viaBytes: Uint8Array[] = [];
    const viaHex: string[] = [];
    const result = await spend(fixture, {
      evaluator: bytesEvaluator(fixture, viaBytes, viaHex),
    });
    expect(viaHex).toHaveLength(0);
    expect(viaBytes).toHaveLength(2);
    expect(
      bodyWithoutScriptDataHash(
        inspectTransaction(Buffer.from(viaBytes[1]).toString("hex")),
      ),
    ).toBe(bodyWithoutScriptDataHash(result.toTransaction()));
  });

  test("a copy with a replaced evaluate does not keep the bytes path", async () => {
    const fixture = await setup();
    const viaBytes: Uint8Array[] = [];
    const ignored: string[] = [];
    const wrapped: string[] = [];
    const base = bytesEvaluator(fixture, viaBytes, ignored);
    await spend(fixture, {
      evaluator: {
        ...base,
        evaluate: (input) => {
          wrapped.push(input.tx);
          return base.evaluate(input);
        },
      },
    });
    expect(viaBytes).toHaveLength(0);
    expect(wrapped).toHaveLength(2);
  });
});

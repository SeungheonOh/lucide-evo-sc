import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import {
  getLedgerRuntime,
  inspectTransaction,
  type TransactionSnapshot,
} from "@lucid-evolution/ledger";
import type {
  Address,
  EvaluatorAdapter,
  UTxO,
  EvalRedeemer,
} from "@lucid-evolution/core-types";
import { utxoToCore } from "@lucid-evolution/utils";
import {
  balanceScTools,
  ScToolsRedeemerRefresh,
} from "../../sc-tools/complete.js";
import { protocolOverrides } from "../../sc-tools/context.js";
import {
  makeTxSignBuilder,
  type TxSignBuilder,
} from "../../tx-sign-builder/TxSignBuilder.js";
import { TxBuilderError, ERROR_MESSAGE } from "../../Errors.js";
import {
  makeReplayConfig,
  replayTxActions,
  hasDelayedActions,
  type TxBuilderConfig,
} from "../TxBuilder.js";
import { TxConfig } from "./Service.js";
import {
  buildCanonicalRedeemerInfo,
  buildRedeemersFromCanonicalContext,
  redeemerMapsEqual,
  transactionFixedPointFingerprint,
  cloneUTxOs,
  outRefKey,
  type RedeemerBuilderCache,
} from "./RedeemerContext.js";
export type CompleteOptions = {
  coinSelection?: boolean;
  changeAddress?: Address;
  localUPLCEval?: boolean;
  evaluator?: EvaluatorAdapter;
  setCollateral?: bigint;
  /**
   * Normalizes ledger containers during balancing and eligible redeemers before
   * computing the script-data hash. Hashed datum, native-script and metadata
   * bytes remain intact, as do ordered Plutus map values. Protected values can
   * contain noncanonical CBOR. Enabled automatically for delayed redeemers.
   */
  canonical?: boolean;
  includeLeftoverLovelaceAsFee?: boolean;
  presetWalletInputs?: UTxO[];
};
export const completeTxError = (cause: unknown) =>
  new TxBuilderError({ cause: `{ Complete: ${cause} }` });
const finish = (
  config: TxBuilderConfig,
  transaction: TransactionSnapshot,
  walletInputs: UTxO[],
  walletAddress: string,
): [UTxO[], UTxO[], TxSignBuilder] => {
  const created = transaction.body.outputs.map((output, outputIndex) => ({
    ...output,
    txHash: transaction.hash,
    outputIndex,
  }));
  const spent = new Set(config.consumedInputs.map(outRefKey));
  return [
    [
      ...created.filter((u) => u.address === walletAddress),
      ...walletInputs.filter((u) => !spent.has(outRefKey(u))),
    ],
    created,
    makeTxSignBuilder(config.lucidConfig.wallet, transaction, {
      resolvedInputs: [
        ...walletInputs,
        ...config.consumedInputs,
        ...config.collectedInputs,
        ...config.readInputs,
      ],
      slotConfig: config.lucidConfig.slotConfig,
    }),
  ];
};
const runComplete = async (
  source: TxBuilderConfig,
  options: CompleteOptions,
): Promise<[UTxO[], UTxO[], TxSignBuilder]> => {
  const wallet = source.lucidConfig.wallet;
  if (!wallet) throw new Error(ERROR_MESSAGE.MISSING_WALLET);
  const walletAddress = await wallet.address(),
    changeAddress = options.changeAddress ?? walletAddress;
  const walletInputs = cloneUTxOs(
    options.presetWalletInputs?.length
      ? options.presetWalletInputs
      : await wallet.getUtxos(),
  );
  const hasPlutus = [...source.scripts.values()].some(
    (s) => s.type !== "Native",
  );
  let collateral: UTxO[] = [];
  if (hasPlutus && wallet.getCollateral) {
    try {
      collateral = await wallet.getCollateral(
        options.setCollateral ?? 5000000n,
      );
      if (options.presetWalletInputs?.length) {
        const allowed = new Set(walletInputs.map(outRefKey));
        collateral = collateral.filter((utxo) => allowed.has(outRefKey(utxo)));
      }
    } catch {
      collateral = [];
    }
  }
  const delayed = hasDelayedActions(source),
    cache: RedeemerBuilderCache = new Map();
  let current = new Map<number, string>(),
    previous: string | undefined,
    expectedInputs: string | undefined,
    pinned: UTxO[] = [];
  let evaluatedExUnits: EvalRedeemer[] | undefined;
  for (let attempt = 0; attempt < (delayed ? 8 : 1); attempt++) {
    const config = makeReplayConfig(source);
    config.walletInputs = cloneUTxOs(walletInputs);
    await Effect.runPromise(
      replayTxActions(source.actions, current).pipe(
        Effect.provide(Layer.succeed(TxConfig, { config })),
      ),
    );
    const bootstrap = config.pendingRedeemers.some((p) => !current.has(p.id));
    let transaction: TransactionSnapshot,
      refresh = false;
    try {
      transaction = await balanceScTools(
        config,
        walletInputs,
        changeAddress,
        { ...options, canonical: options.canonical || delayed },
        {
          bootstrapExUnits: bootstrap,
          collateralInputs: collateral,
          redeemerInputFingerprint: expectedInputs,
          pinnedInputs: pinned,
          evaluatedExUnits,
        },
      );
    } catch (error) {
      if (error instanceof ScToolsRedeemerRefresh) {
        transaction = error.transaction;
        refresh = true;
      } else throw error;
    }
    const result = finish(config, transaction, walletInputs, walletAddress);
    if (!delayed) return result;
    const info = await Effect.runPromise(
      buildCanonicalRedeemerInfo(transaction, [
        ...walletInputs,
        ...config.collectedInputs,
        ...config.readInputs,
      ]),
    );
    const next = await Effect.runPromise(
      buildRedeemersFromCanonicalContext(info, config.pendingRedeemers, cache),
    );
    expectedInputs = transaction.body.inputs.map(outRefKey).join(",");
    pinned = bootstrap
      ? config.consumedInputs.filter((u) =>
          walletInputs.some((w) => outRefKey(w) === outRefKey(u)),
        )
      : [];
    if (refresh || !redeemerMapsEqual(current, next)) {
      current = next;
      previous = undefined;
      evaluatedExUnits = undefined;
      continue;
    }
    const fingerprint = transactionFixedPointFingerprint(transaction);
    if (fingerprint === previous) return result;
    previous = fingerprint;
    // The confirming delayed pass uses the already evaluated budget. Custom
    // evaluators still validate the final body once more, without rebuilding
    // an identical zero-budget draft.
    evaluatedExUnits = transaction.redeemers.map((redeemer) => ({
      redeemer_tag: redeemer.tag,
      redeemer_index: Number(redeemer.index),
      ex_units: {
        mem: Number(redeemer.exUnits.mem),
        steps: Number(redeemer.exUnits.steps),
      },
    }));
  }
  throw new Error(
    "Context-dependent redeemers did not converge after 8 attempts. Check for circular redeemer dependencies on the final transaction body, fees, or ex-units.",
  );
};
export const complete = (options: CompleteOptions = {}) =>
  Effect.gen(function* () {
    const { config } = yield* TxConfig;
    return yield* Effect.tryPromise({
      try: () => runComplete(config, options),
      catch: completeTxError,
    });
  });
export const makeHaskellEvaluator = (): EvaluatorAdapter => ({
  name: "sc-tools",
  async evaluate({ tx, additionalUTxOs, context }) {
    const runtime = getLedgerRuntime();
    const chainResult = (await runtime.run({
      action: "lucidContext",
      network: context.network.toLowerCase(),
      protocolParameters: protocolOverrides(context.protocolParameters),
      slotConfig: context.slotConfig,
    })) as { ok: boolean; chain: unknown; error?: string };
    if (!chainResult.ok) throw new Error(chainResult.error);
    const response = (await runtime.run({
      action: "evaluateV2",
      chain: chainResult.chain,
      cbor: tx,
      wallet: {
        changeAddress:
          additionalUTxOs[0]?.address ??
          inspectTransaction(tx).body.outputs[0]?.address,
        utxos: [],
      },
      blocks: [],
      resolvedInputs: additionalUTxOs.map(utxoToCore),
    })) as {
      ok: boolean;
      exUnits?: {
        purpose: { tag: EvalRedeemer["redeemer_tag"]; index: number };
        mem: number;
        steps: number;
      }[];
      error?: string;
    };
    if (!response.ok) throw new Error(response.error);
    return (response.exUnits ?? []).map((r) => ({
      redeemer_tag: r.purpose.tag,
      redeemer_index: Number(r.purpose.index),
      ex_units: { mem: Number(r.mem), steps: Number(r.steps) },
    }));
  },
});

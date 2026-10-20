import { scChainContext } from "./context.js";
import {
  inspectTransaction,
  encodeCbor,
  decodeCbor,
  getLedgerRuntime,
  type TransactionSnapshot,
} from "@lucid-evolution/ledger";
import { fromHex } from "@lucid-evolution/core-utils";
import { utxoToCore, paymentCredentialOf } from "@lucid-evolution/utils";
import type {
  EvalRedeemer,
  EvaluatorAdapter,
  UTxO,
} from "@lucid-evolution/core-types";
import type { TxBuilderConfig } from "../tx-builder/TxBuilder.js";
import type { CompleteOptions } from "../tx-builder/internal/CompleteTxBuilder.js";
import { scBlocks, scOutRef, resolveScReferences } from "./intent.js";
export class ScToolsRedeemerRefresh extends Error {
  constructor(readonly transaction: TransactionSnapshot) {
    super("sc-tools selected different inputs; rebuild delayed redeemers");
  }
}
export type ScToolsCompletionContext = {
  bootstrapExUnits?: boolean;
  collateralInputs?: UTxO[];
  redeemerInputFingerprint?: string;
  pinnedInputs?: UTxO[];
  evaluatedExUnits?: EvalRedeemer[];
};
export async function balanceScTools(
  config: TxBuilderConfig,
  walletInputs: UTxO[],
  changeAddress: string,
  options: CompleteOptions,
  internal: ScToolsCompletionContext = {},
): Promise<TransactionSnapshot> {
  const runtime = config.lucidConfig.balancer?.runtime ?? getLedgerRuntime();
  const chain = await scChainContext(config.lucidConfig);
  const protocolVersion = chain.protocolParameters.protocolVersion as {
    major: number;
    minor: number;
  };
  const evaluationParameters = {
    ...config.lucidConfig.protocolParameters,
    protocolMajorVersion: protocolVersion.major,
    protocolMinorVersion: protocolVersion.minor,
  };
  if (chain.network !== config.lucidConfig.network.toLowerCase())
    throw new Error("sc-tools chain context does not match Lucid network");
  const parameterNames = {
    coinsPerUtxoByte: "utxoCostPerByte",
    keyDeposit: "stakeAddressDeposit",
    poolDeposit: "stakePoolDeposit",
    drepDeposit: "dRepDeposit",
    govActionDeposit: "govActionDeposit",
  } as const;
  for (const [key, value] of Object.entries(parameterNames))
    if (
      String(
        config.lucidConfig.protocolParameters[
          key as keyof typeof parameterNames
        ],
      ) !== String(chain.protocolParameters[value])
    )
      throw new Error(
        `sc-tools chain context disagrees with Lucid protocol parameter: ${key}`,
      );
  const blocks = scBlocks(config).map((block) => ({ ...block }));
  if (config.metadata.size)
    blocks.push({
      type: "metadata",
      cbor: encodeCbor(
        config.metadata as import("@lucid-evolution/ledger").CborValue,
      ),
    });
  const read = new Set(config.readInputs.map(scOutRef));
  const funding = walletInputs.filter(
    (u) =>
      !read.has(scOutRef(u)) && paymentCredentialOf(u.address).type === "Key",
  );
  for (const utxo of config.readInputs)
    blocks.push({ type: "reference", input: scOutRef(utxo) });
  for (const utxo of internal.pinnedInputs ?? [])
    if (!config.collectedInputs.some((u) => scOutRef(u) === scOutRef(utxo)))
      blocks.push({ type: "input", input: scOutRef(utxo) });
  resolveScReferences(config, blocks);
  if (config.treasuryDonation)
    blocks.push({
      type: "treasury",
      lovelace: String(config.treasuryDonation.donation),
      currentTreasury: String(config.treasuryDonation.currentTreasuryValue),
    });
  const collateral = (internal.collateralInputs ?? []).filter(
    (u) => !u.scriptRef && paymentCredentialOf(u.address).type === "Key",
  );
  const byRef = new Map(
    [
      ...walletInputs,
      ...collateral,
      ...config.collectedInputs,
      ...config.readInputs,
    ].map((u) => [scOutRef(u), u]),
  );
  const nativeKeys = new Set<string>();
  const nativeSigners = (term: unknown): void => {
    if (!Array.isArray(term)) return;
    if (term[0] === 0n && term[1] instanceof Uint8Array) {
      nativeKeys.add(
        Array.from(term[1], (b) => b.toString(16).padStart(2, "0")).join(""),
      );
      return;
    }
    const children = term[0] === 3n ? term[2] : term[1];
    if (Array.isArray(children)) children.forEach(nativeSigners);
  };
  for (const script of config.scripts.values())
    if (script.type === "Native") nativeSigners(decodeCbor(script.script));
  const external: EvaluatorAdapter | undefined =
    options.localUPLCEval === false
      ? {
          name: "provider",
          evaluate: ({ tx, additionalUTxOs }) =>
            config.lucidConfig.provider.evaluateTx(tx, additionalUTxOs),
        }
      : (options.evaluator ?? config.lucidConfig.evaluator);
  const request = {
    action: "balanceV2",
    chain,
    blocks,
    wallet: {
      changeAddress,
      utxos: funding.map(utxoToCore),
      collateral: collateral.map(utxoToCore),
      collateralFallback: walletInputs
        .filter(
          (u) => !u.scriptRef && paymentCredentialOf(u.address).type === "Key",
        )
        .map(utxoToCore),
    },
    resolvedInputs: [...byRef.values()].map(utxoToCore),
    additionalWitnesses: nativeKeys.size,
  };
  let supplied = internal.evaluatedExUnits,
    previous: string | undefined;
  for (let attempt = 0; attempt < 12; attempt++) {
    const response = (await runtime.run({
      ...request,
      options: {
        coinSelection: options.coinSelection ?? true,
        minFee: String(config.minFee ?? 0n),
        explicitFee: config.minFee !== undefined,
        setCollateral: String(options.setCollateral ?? 5000000n),
        includeLeftoverLovelaceAsFee:
          options.includeLeftoverLovelaceAsFee ?? false,
        expectedInputs: internal.redeemerInputFingerprint
          ?.split(",")
          .filter(Boolean),
        canonical: options.canonical ?? false,
        evaluation: internal.bootstrapExUnits
          ? "bootstrap"
          : external
            ? "provided"
            : "local",
        exUnits: supplied,
      },
    })) as {
      ok?: boolean;
      error?: unknown;
      needsRedeemers?: boolean;
      transaction?: { cborHex?: string };
    };
    if (response?.ok !== true || !response.transaction?.cborHex)
      throw new Error(
        `sc-tools balance failed: ${String(response?.error ?? "missing transaction")}`,
      );
    const transaction = inspectTransaction(response.transaction.cborHex);
    const consumed = transaction.body.inputs.map((ref) => {
      const key = scOutRef(ref),
        utxo = byRef.get(key);
      if (!utxo || read.has(key))
        throw new Error(
          `sc-tools returned an unavailable spending input: ${key}`,
        );
      return utxo;
    });
    if (
      config.collectedInputs.some(
        (input) => !consumed.some((u) => scOutRef(u) === scOutRef(input)),
      )
    )
      throw new Error("sc-tools omitted an explicit input");
    if (
      options.coinSelection === false &&
      consumed.some(
        (u) => !config.collectedInputs.some((v) => scOutRef(v) === scOutRef(u)),
      )
    )
      throw new Error("sc-tools selected an input with coinSelection disabled");
    config.consumedInputs = consumed;
    if (response.needsRedeemers) throw new ScToolsRedeemerRefresh(transaction);
    if (
      !external ||
      internal.bootstrapExUnits ||
      !transaction.redeemers.length ||
      transaction.cbor === previous
    )
      return transaction;
    previous = transaction.cbor;
    const input = {
      additionalUTxOs: [...consumed, ...config.readInputs],
      context: {
        network: config.lucidConfig.network,
        slotConfig: config.lucidConfig.slotConfig,
        protocolParameters: evaluationParameters,
        costModels: config.lucidConfig.costModels,
      },
    };
    const evaluated = external.evaluateBytes
      ? await external.evaluateBytes({
          ...input,
          tx: fromHex(transaction.cbor),
        })
      : await external.evaluate({ ...input, tx: transaction.cbor });
    const expected = new Set(
        transaction.redeemers.map((r) => `${r.tag}:${r.index}`),
      ),
      seen = new Set<string>();
    for (const result of evaluated) {
      const key = `${result.redeemer_tag}:${result.redeemer_index}`;
      if (
        !expected.has(key) ||
        seen.has(key) ||
        !Number.isSafeInteger(result.redeemer_index) ||
        !Number.isSafeInteger(result.ex_units.mem) ||
        !Number.isSafeInteger(result.ex_units.steps) ||
        result.ex_units.mem < 0 ||
        result.ex_units.steps < 0
      )
        throw new Error("Invalid or duplicate external evaluation result");
      seen.add(key);
    }
    if (seen.size !== expected.size)
      throw new Error("External evaluator omitted redeemers");
    supplied = evaluated;
  }
  throw new Error("sc-tools external evaluation did not converge");
}

import type { ScToolsChainContext } from "./types.js";
import { CML } from "../core.js";
import { withCMLScope } from "@lucid-evolution/core-utils";
import {
  utxoToCore,
  paymentCredentialOf,
  coreToOutRef,
} from "@lucid-evolution/utils";
import type { EvalRedeemer, UTxO } from "@lucid-evolution/core-types";
import type { TxBuilderConfig } from "../tx-builder/TxBuilder.js";
import type { CompleteOptions } from "../tx-builder/internal/CompleteTxBuilder.js";
import { scBlocks, scOutRef, resolveScReferences } from "./intent.js";

export class ScToolsRedeemerRefresh extends Error {
  constructor(readonly transaction: CML.Transaction) {
    super("sc-tools selected different inputs; rebuild delayed redeemers");
  }
}
export type ScToolsCompletionContext = {
  bootstrapExUnits?: boolean;
  redeemerInputFingerprint?: string;
};

export async function balanceScTools(
  config: TxBuilderConfig,
  walletInputs: UTxO[],
  changeAddress: string,
  options: CompleteOptions,
  internal: ScToolsCompletionContext = {},
  refreshHash?: (
    tx: CML.Transaction,
    chain: ScToolsChainContext,
  ) => Promise<CML.Transaction>,
): Promise<CML.Transaction> {
  const backend = config.lucidConfig.balancer!;
  const chain = await backend.chainContext(config.lucidConfig);
  if (chain.network !== config.lucidConfig.network.toLowerCase())
    throw new Error("sc-tools chain context does not match Lucid network");
  const parameterNames = {
    coinsPerUtxoByte: "utxoCostPerByte",
    keyDeposit: "stakeAddressDeposit",
    poolDeposit: "stakePoolDeposit",
    drepDeposit: "dRepDeposit",
    govActionDeposit: "govActionDeposit",
  } as const;
  for (const [lucidName, chainName] of Object.entries(parameterNames)) {
    const value =
      config.lucidConfig.protocolParameters[
        lucidName as keyof typeof parameterNames
      ];
    if (String(value) !== String(chain.protocolParameters[chainName]))
      throw new Error(
        `sc-tools chain context disagrees with Lucid protocol parameter: ${lucidName}`,
      );
  }
  const blocks = scBlocks(config).map((block) => ({ ...block }));
  withCMLScope((own) => {
    const aux = own(config.txBuilder.get_auxiliary_data());
    const metadata = aux && own(aux.metadata());
    if (metadata)
      blocks.push({
        type: "metadata",
        cbor: own(CML.AuxiliaryData.new_shelley(metadata)).to_cbor_hex(),
      });
  });
  const read = new Set(config.readInputs.map(scOutRef));
  const funding = walletInputs.filter(
    (u) =>
      !read.has(scOutRef(u)) && paymentCredentialOf(u.address).type === "Key",
  );
  for (const utxo of config.readInputs)
    blocks.push({ type: "reference", input: scOutRef(utxo) });
  resolveScReferences(config, blocks);
  if (config.treasuryDonation)
    blocks.push({
      type: "treasury",
      lovelace: String(config.treasuryDonation.donation),
      currentTreasury: String(config.treasuryDonation.currentTreasuryValue),
    });
  const byRef = new Map(
    [...walletInputs, ...config.collectedInputs, ...config.readInputs].map(
      (u) => [scOutRef(u), u],
    ),
  );
  const encode = (u: UTxO) =>
    withCMLScope((own) => own(utxoToCore(u)).to_cbor_hex());
  const expectedInputs =
    internal.redeemerInputFingerprint === undefined
      ? undefined
      : withCMLScope((own) =>
          internal
            .redeemerInputFingerprint!.split(",")
            .filter(Boolean)
            .map((hex) =>
              scOutRef(
                coreToOutRef(
                  own(CML.TransactionInput.from_cbor_hex(hex)),
                ) as UTxO,
              ),
            ),
        );
  const external =
    options.localUPLCEval === false
      ? {
          name: "provider",
          evaluate: ({
            tx,
            additionalUTxOs,
          }: {
            tx: string;
            additionalUTxOs: UTxO[];
          }) => config.lucidConfig.provider.evaluateTx(tx, additionalUTxOs),
        }
      : (options.evaluator ?? config.lucidConfig.evaluator);
  const request = {
    action: "balanceV2",
    chain,
    blocks,
    wallet: {
      changeAddress,
      utxos: funding.map(encode),
      collateral: walletInputs
        .filter((u) => paymentCredentialOf(u.address).type === "Key")
        .map(encode),
    },
    resolvedInputs: [...byRef.values()].map(encode),
    additionalWitnesses: withCMLScope((own) => {
      const keys = new Set<string>();
      for (const script of config.scripts.values())
        if (script.type === "Native") {
          const signers = own(
            own(
              CML.NativeScript.from_cbor_hex(script.script),
            ).get_required_signers(),
          );
          for (let i = 0; i < signers.len(); i++)
            keys.add(own(signers.get(i)).to_hex());
        }
      return keys.size;
    }),
  };
  let supplied: EvalRedeemer[] | undefined;
  let previous: string | undefined;
  for (let attempt = 0; attempt < 12; attempt++) {
    const response = await backend.runtime.run({
      ...request,
      options: {
        coinSelection: options.coinSelection ?? true,
        minFee: String(config.minFee ?? 0n),
        setCollateral: String(options.setCollateral ?? 5_000_000n),
        includeLeftoverLovelaceAsFee:
          options.includeLeftoverLovelaceAsFee ?? false,
        expectedInputs,
        evaluation: internal.bootstrapExUnits
          ? "bootstrap"
          : external
            ? "provided"
            : "local",
        exUnits: supplied,
      },
    });
    if (!response || typeof response !== "object")
      throw new Error("Invalid sc-tools response");
    const result = response as {
      ok?: boolean;
      error?: unknown;
      needsRedeemers?: boolean;
      costModels?: Record<string, unknown>;
      transaction?: { cborHex?: string };
    };
    if (result.ok !== true || typeof result.transaction?.cborHex !== "string")
      throw new Error(
        `sc-tools balance failed: ${String(result.error ?? "missing transaction")}`,
      );
    let tx = CML.Transaction.from_cbor_hex(result.transaction.cborHex);
    if (options.canonical) {
      const canonical = CML.Transaction.from_cbor_bytes(
        tx.to_canonical_cbor_bytes(),
      );
      tx.free();
      tx = canonical;
      if (refreshHash) {
        const refreshed = await refreshHash(tx, {
          ...chain,
          protocolParameters: {
            ...chain.protocolParameters,
            costModels:
              result.costModels ?? chain.protocolParameters.costModels,
          },
        });
        if (refreshed !== tx) tx.free();
        tx = refreshed;
      }
    }
    let consumed: UTxO[];
    try {
      consumed = withCMLScope((own) => {
        const inputs = own(own(tx.body()).inputs());
        const spent = Array.from({ length: inputs.len() }, (_, i) => {
          const key = scOutRef(coreToOutRef(own(inputs.get(i))) as UTxO);
          const utxo = byRef.get(key);
          if (!utxo || read.has(key))
            throw new Error(
              `sc-tools returned an unavailable spending input: ${key}`,
            );
          return utxo;
        });
        for (const input of config.collectedInputs)
          if (!spent.some((u) => scOutRef(u) === scOutRef(input)))
            throw new Error("sc-tools omitted an explicit input");
        if (
          options.coinSelection === false &&
          spent.some(
            (u) =>
              !config.collectedInputs.some((v) => scOutRef(u) === scOutRef(v)),
          )
        )
          throw new Error(
            "sc-tools selected an input with coinSelection disabled",
          );
        return spent;
      });
    } catch (error) {
      tx.free();
      throw error;
    }
    config.consumedInputs = consumed;
    if (result.needsRedeemers) throw new ScToolsRedeemerRefresh(tx);
    if (!external || internal.bootstrapExUnits) return tx;
    const hex = tx.to_cbor_hex();
    const expected = withCMLScope((own) => {
      const r = own(own(tx.witness_set()).redeemers());
      if (!r) return new Set<string>();
      const legacy = own(r.to_flat_format());
      return new Set(
        Array.from({ length: legacy.len() }, (_, i) => {
          const redeemer = own(legacy.get(i));
          return `${redeemer.tag()}:${redeemer.index()}`;
        }),
      );
    });
    if (expected.size === 0 || hex === previous) return tx;
    previous = hex;
    tx.free();
    const evaluated = await external.evaluate({
      tx: hex,
      additionalUTxOs: [...consumed, ...config.readInputs],
      context: {
        network: config.lucidConfig.network,
        slotConfig: config.lucidConfig.slotConfig,
        protocolParameters: config.lucidConfig.protocolParameters,
        costModels: config.lucidConfig.costModels,
      },
    });
    const tags = {
      spend: 0,
      mint: 1,
      publish: 2,
      withdraw: 3,
      vote: 4,
      propose: 5,
    };
    const seen = new Set<string>();
    for (const value of evaluated) {
      const key = `${tags[value.redeemer_tag]}:${value.redeemer_index}`;
      if (
        !expected.has(key) ||
        seen.has(key) ||
        !Number.isSafeInteger(value.redeemer_index) ||
        !Number.isSafeInteger(value.ex_units.mem) ||
        !Number.isSafeInteger(value.ex_units.steps) ||
        value.ex_units.mem < 0 ||
        value.ex_units.steps < 0
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

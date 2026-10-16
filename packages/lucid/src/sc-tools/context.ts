import type { ProtocolParameters } from "@lucid-evolution/core-types";
import type { LucidConfig } from "../lucid-evolution/LucidEvolution.js";
import type { ScToolsChainContext } from "./types.js";

// The rest of the Conway parameters come from convex-mockchain's bundled defaults.
export function protocolOverrides(
  p: ProtocolParameters,
): Record<string, unknown> {
  return {
    protocolVersion: {
      // Match Lucid's Aiken fallback when a provider omits the version.
      major: p.protocolMajorVersion ?? 10,
      minor: p.protocolMinorVersion ?? 0,
    },
    txFeePerByte: p.minFeeA,
    txFeeFixed: p.minFeeB,
    maxTxSize: p.maxTxSize,
    maxValueSize: p.maxValSize,
    stakeAddressDeposit: String(p.keyDeposit),
    stakePoolDeposit: String(p.poolDeposit),
    dRepDeposit: String(p.drepDeposit),
    govActionDeposit: String(p.govActionDeposit),
    executionUnitPrices: { priceMemory: p.priceMem, priceSteps: p.priceStep },
    maxTxExecutionUnits: {
      memory: String(p.maxTxExMem),
      steps: String(p.maxTxExSteps),
    },
    utxoCostPerByte: String(p.coinsPerUtxoByte),
    collateralPercentage: p.collateralPercentage,
    maxCollateralInputs: p.maxCollateralInputs,
    minFeeRefScriptCostPerByte: p.minFeeRefScriptCostPerByte,
    costModels: p.costModels,
  };
}

/** Use exactly the parameter snapshot and slot mapping that the CML backend uses. */
export async function scChainContext(
  config: LucidConfig,
): Promise<ScToolsChainContext> {
  const backend = config.balancer!;
  if (backend.chainContext) return backend.chainContext(config);
  const response = (await backend.runtime.run({
    action: "lucidContext",
    network: config.network.toLowerCase(),
    protocolParameters: protocolOverrides(config.protocolParameters),
    slotConfig: config.slotConfig,
  })) as { ok?: boolean; error?: string; chain?: ScToolsChainContext };
  if (!response?.ok || !response.chain) {
    throw new Error(
      `sc-tools could not prepare Lucid context: ${response?.error ?? "missing chain context"}`,
    );
  }
  return response.chain;
}

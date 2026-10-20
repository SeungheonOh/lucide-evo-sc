import { getLedgerRuntime } from "@lucid-evolution/ledger";
import type { ProtocolParameters } from "@lucid-evolution/core-types";
import type { LucidConfig } from "../lucid-evolution/LucidEvolution.js";
import type { ScToolsChainContext } from "./types.js";

// The rest of the Conway parameters come from convex-mockchain's bundled defaults.
export function protocolOverrides(
  p: ProtocolParameters,
): Record<string, unknown> {
  return {
    protocolVersion: {
      // Match Lucid's generic-provider fallback when a provider omits the version.
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

/** Use exactly the parameter snapshot and slot mapping that Lucid uses. */
export async function scChainContext(
  config: LucidConfig,
): Promise<ScToolsChainContext> {
  const backend = config.balancer ?? { runtime: getLedgerRuntime() };
  if ("chainContext" in backend && backend.chainContext)
    return backend.chainContext(config);
  const provider = config.provider as typeof config.provider & {
    getChainContext?: () => Promise<ScToolsChainContext>;
  };
  const current = provider.getChainContext
    ? await provider.getChainContext()
    : undefined;
  const parameters = protocolOverrides(config.protocolParameters);
  const currentVersion = current?.protocolParameters.protocolVersion as
    | { major: number; minor: number }
    | undefined;
  if (
    currentVersion &&
    config.protocolParameters.protocolMajorVersion === undefined
  ) {
    parameters.protocolVersion = {
      ...currentVersion,
      minor:
        config.protocolParameters.protocolMinorVersion ?? currentVersion.minor,
    };
  }
  const response = (await backend.runtime.run({
    action: "lucidContext",
    network: config.network.toLowerCase(),
    protocolParameters: { ...current?.protocolParameters, ...parameters },
    slotConfig: config.slotConfig,
  })) as { ok?: boolean; error?: string; chain?: ScToolsChainContext };
  if (!response?.ok || !response.chain) {
    throw new Error(
      `sc-tools could not prepare Lucid context: ${response?.error ?? "missing chain context"}`,
    );
  }
  return current
    ? {
        ...current,
        protocolParameters: response.chain.protocolParameters,
        systemStart: response.chain.systemStart,
        eraSummaries: response.chain.eraSummaries,
      }
    : response.chain;
}

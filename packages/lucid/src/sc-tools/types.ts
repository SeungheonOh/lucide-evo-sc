import type { Network, Provider } from "@lucid-evolution/core-types";

/** Exact cardano-cli Conway parameters and node era history, as used by LiveTx.hs. */
export type ScToolsChainContext = {
  network: "mainnet" | "preprod" | "preview" | "custom";
  networkMagic?: number;
  stakePools?: string[];
  stakeDeposits?: Array<{
    type: "Key" | "Script";
    hash: string;
    deposit: string;
  }>;
  drepDeposits?: Array<{
    type: "Key" | "Script";
    hash: string;
    deposit: string;
  }>;
  systemStart: string;
  protocolParameters: Record<string, unknown>;
  eraSummaries: Array<{
    start: { time: number; slot: number; epoch: number };
    end: { time: number; slot: number; epoch: number };
    parameters: {
      epoch_length: number;
      slot_length: number;
      safe_zone?: number;
    };
  }>;
};

/** Compatible with sc-tools-wasm's Engine. No wallet secrets cross this boundary. */
export interface ScToolsRuntime {
  run(payload: Record<string, unknown>): Promise<unknown>;
}

export type ScToolsBalancer = {
  type: "sc-tools";
  runtime: ScToolsRuntime;
  /** Called for each completion, including after switchProvider(). */
  chainContext: (context: {
    provider: Provider;
    network: Network;
  }) => Promise<ScToolsChainContext>;
};

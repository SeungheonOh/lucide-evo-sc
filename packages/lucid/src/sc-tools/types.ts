import type { Network, Provider } from "@lucid-evolution/core-types";

/** Conway parameters and slot-to-time context consumed by the WASM bridge. */
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

/** Runtime transport for Haskell balancing and mockchain operations. */
export interface ScToolsRuntime {
  run(payload: Record<string, unknown>): Promise<unknown>;
}

export type ScToolsBalancer = {
  type: "sc-tools";
  runtime: ScToolsRuntime;
  /**
   * Overrides the full node context. By default, uses provider chain state when
   * available with Lucid's pinned parameters and slot mapping.
   */
  chainContext?: (context: {
    provider: Provider;
    network: Network;
  }) => Promise<ScToolsChainContext>;
};

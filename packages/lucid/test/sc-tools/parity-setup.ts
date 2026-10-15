import { vi } from "vitest";
import { readFile } from "node:fs/promises";

// Reuse the existing CML regression scenarios against the new backend and ledger.
// Only the test's provider constructor and Lucid's backend selection change.
vi.mock("../../src/index.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/index.js")>();
  const path = process.env.SC_TOOLS_WASM;
  if (!path)
    throw new Error("SC_TOOLS_WASM must point to the rebuilt bridge v2");
  const runtime = await actual.createScToolsWasmRuntime(
    await WebAssembly.compile(await readFile(path)),
  );
  class Emulator extends actual.ScToolsEmulator {
    constructor(
      accounts: import("../../src/index.js").EmulatorAccount[],
      parameters?: import("../../src/index.js").ProtocolParameters,
      treasury?: bigint,
    ) {
      super(
        accounts,
        {
          ...actual.PROTOCOL_PARAMETERS_DEFAULT,
          ...parameters,
          // Legacy reward fixtures have no DRep delegation and model bootstrap Conway.
          protocolMajorVersion: 9,
        },
        treasury,
        runtime,
        {
          // The original emulator fixtures assume this pool already exists.
          stakePools: [
            "9ed23a4a839826d08d7d10f277a91f0e2373ea90251fb33664d52c94",
          ],
        },
      );
    }
  }
  const Lucid: typeof actual.Lucid = (provider, network, options = {}) =>
    actual.Lucid(provider, network, {
      ...options,
      balancer:
        options.balancer ??
        (provider instanceof Emulator ? provider.balancer : undefined),
    });
  const chains = new WeakMap<
    object,
    Promise<import("../../src/index.js").ScToolsChainContext>
  >();
  const makeTxBuilder: typeof actual.makeTxBuilder = (config) => {
    let chain = chains.get(config.protocolParameters);
    if (!chain) {
      chain = new actual.ScToolsEmulator(
        [],
        config.protocolParameters,
        0n,
        runtime,
      ).getChainContext();
      chains.set(config.protocolParameters, chain);
    }
    return actual.makeTxBuilder({
      ...config,
      balancer: config.balancer ?? {
        type: "sc-tools",
        runtime,
        chainContext: async () => {
          const context = structuredClone(await chain!);
          context.network =
            config.network.toLowerCase() as typeof context.network;
          const slots = config.slotConfig ?? {
            zeroTime: 0,
            zeroSlot: 0,
            slotLength: 1000,
          };
          context.systemStart = String(
            (slots.zeroTime - slots.zeroSlot * slots.slotLength) / 1000,
          );
          context.eraSummaries[0].parameters.slot_length =
            slots.slotLength / 1000;
          context.eraSummaries[0].end.time =
            (context.eraSummaries[0].end.slot * slots.slotLength) / 1000;
          return context;
        },
      },
    });
  };
  return { ...actual, Emulator, Lucid, makeTxBuilder };
});

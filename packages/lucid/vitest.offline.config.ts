import { defineConfig, mergeConfig } from "vitest/config";
import base from "./vitest.config.js";

export default mergeConfig(
  base,
  defineConfig({
    test: {
      exclude: [
        "**/node_modules/**",
        "**/onchain-*.test.ts",
        "**/wallet.test.ts",
        "**/txHash.test.ts",
        "**/txEval.test.ts",
      ],
      minWorkers: 1,
      maxWorkers: 2,
      bail: 0,
    },
  }),
);

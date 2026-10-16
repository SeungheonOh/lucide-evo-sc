import { defineConfig, mergeConfig } from "vitest/config";
import { fileURLToPath } from "node:url";
import base from "./vitest.config.js";

export default mergeConfig(
  base,
  defineConfig({
    plugins: [
      {
        name: "sc-tools-provider-test-imports",
        enforce: "pre",
        transform(code, id) {
          if (!id.includes("/test/") || id.endsWith("parity-setup.ts")) return;
          const source = fileURLToPath(
            new URL("./src/index.ts", import.meta.url),
          );
          if (id.includes("/packages/provider/test/")) {
            code = code.replace(
              /from (["'])\.\.\/src\/index\.js\1/g,
              `from "${source}"`,
            );
          }
          return code.replace(
            /from (["'])(?:@lucid-evolution\/provider|[^"']*\/provider\/src(?:\/index\.js)?)\1/g,
            `from "${source}"`,
          );
        },
      },
    ],
    test: {
      setupFiles: ["./test/sc-tools/parity-setup.ts"],
      exclude: [
        "**/onchain-*.test.ts",
        "**/sc-tools.test.ts",
        "**/sc-tools-emulator.test.ts",
        // Instruments Aiken calls and CML's draft/replay counts. SC uses Haskell
        // locally; its fee-dependent and external-evaluator contracts are tested
        // against the actual ledger in sc-tools-emulator.test.ts instead.
        "**/completion-evaluation.test.ts",
        "**/node_modules/**",
      ],
      maxWorkers: 2,
      minWorkers: 1,
      bail: 0,
    },
  }),
);

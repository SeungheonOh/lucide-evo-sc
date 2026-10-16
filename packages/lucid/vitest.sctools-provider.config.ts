import { defineConfig } from "vitest/config";
import parity from "./vitest.sctools.config.js";

// Run upstream's mutable-Emulator fixture contracts without copying the tests.
export default defineConfig({
  ...parity,
  test: {
    ...parity.test,
    include: ["../provider/test/emulator-ledger-*.test.ts"],
  },
});

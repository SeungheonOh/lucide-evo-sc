import { defineConfig } from "tsup";
export default defineConfig([
  {
    entry: ["src/node.ts"],
    format: ["esm", "cjs"],
    target: "es2022",
    dts: true,
    noExternal: ["@bjorn3/browser_wasi_shim"],
  },
  {
    entry: ["src/browser.ts"],
    format: ["esm"],
    target: "es2022",
    dts: true,
    noExternal: ["@bjorn3/browser_wasi_shim"],
  },
]);

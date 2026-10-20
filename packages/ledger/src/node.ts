import { readFileSync } from "node:fs";
import { webcrypto } from "node:crypto";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { prepareReactor, initializeLedger } from "./runtime.js";
const reactor = prepareReactor((bytes) => {
  webcrypto.getRandomValues(bytes);
});
const path =
  process.env.SC_TOOLS_REACTOR ??
  (typeof __dirname === "string"
    ? resolve(__dirname, "../sc-tools.wasm")
    : fileURLToPath(new URL("../sc-tools.wasm", import.meta.url)));
initializeLedger(
  reactor.attach(
    new WebAssembly.Instance(
      new WebAssembly.Module(readFileSync(path)),
      reactor.imports,
    ),
  ),
);
export * from "./api.js";

import { prepareReactor, initializeLedger } from "./runtime.js";
const reactor = prepareReactor((bytes) => {
  crypto.getRandomValues(bytes);
});
const response = await fetch(new URL("../sc-tools.wasm", import.meta.url));
if (!response.ok)
  throw new Error(`Unable to load Haskell ledger WASM: ${response.status}`);
const { instance } = await WebAssembly.instantiate(
  await response.arrayBuffer(),
  reactor.imports,
);
initializeLedger(reactor.attach(instance));
export * from "./api.js";

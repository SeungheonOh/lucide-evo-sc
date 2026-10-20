import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const cache = execFileSync("python3", ["-B", fileURLToPath(new URL("./paths.py", import.meta.url)), "cache"], { encoding: "utf8" }).trim();
const { chromium } = createRequire(`${cache}/browser-test/package.json`)("playwright-core");
const artifact = process.env.SC_TOOLS_LEDGER_WASM || `${cache}/output/sc-tools-ledger.wasm`;
const server = createServer(async (request, response) => {
  try {
    if (request.url === "/") {
      response.setHeader("content-type", "text/html");
      response.end("<!doctype html><title>Haskell ledger reactor</title>");
      return;
    }
    if (request.url !== "/ledger.wasm" && !/^\/wasi\/[a-z_]+\.js$/.test(request.url)) {
      response.writeHead(404).end();
      return;
    }
    response.setHeader("content-type", request.url.endsWith(".js") ? "application/javascript" : "application/wasm");
    response.end(await readFile(request.url === "/ledger.wasm" ? artifact : `${cache}/output/browser${request.url}`));
  } catch (error) {
    response.writeHead(500).end(String(error));
  }
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || chromium.executablePath(), headless: true, args: ["--no-sandbox"] });
try {
  const page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  const result = await page.evaluate(async () => {
    const { WASI, File, OpenFile, ConsoleStdout, PreopenDirectory } = await import("/wasi/index.js");
    const logs = [];
    const wasi = new WASI(["sc-tools-ledger"], [], [new OpenFile(new File(new Uint8Array())), ConsoleStdout.lineBuffered(line => logs.push(line)), ConsoleStdout.lineBuffered(line => logs.push(line)), new PreopenDirectory("/", new Map())], { debug: false });
    wasi.wasiImport.random_get = (pointer, length) => {
      const bytes = new Uint8Array(wasi.inst.exports.memory.buffer, pointer, length);
      for (let index = 0; index < length; index += 65536) crypto.getRandomValues(bytes.subarray(index, index + 65536));
      return 0;
    };
    const bytes = await (await fetch("/ledger.wasm")).arrayBuffer();
    const { instance } = await WebAssembly.instantiate(bytes, { wasi_snapshot_preview1: wasi.wasiImport });
    wasi.initialize(instance);
    const exports = instance.exports;
    exports.lucid_init();
    let calls = 0;
    const ledger = (operation, payload = {}) => {
      const bytes = new TextEncoder().encode(JSON.stringify({ action: "ledger", operation, ...payload }));
      const pointer = exports.lucid_alloc(bytes.length);
      let output = 0;
      try {
        new Uint8Array(exports.memory.buffer).set(bytes, pointer);
        output = exports.lucid_run(pointer, bytes.length);
        const result = JSON.parse(new TextDecoder().decode(new Uint8Array(exports.memory.buffer, output, exports.lucid_result_len())));
        if (!result.ok) throw Error(result.error);
        calls += 1;
        return result.result;
      } finally {
        exports.lucid_free(pointer);
        if (output) exports.lucid_free(output);
      }
    };
    const privateKey = ledger("key.generate");
    const { publicKey } = ledger("key.fromPrivate", { privateKey });
    const signature = ledger("key.sign", { privateKey, message: "cafe" });
    const signatureVerified = ledger("key.verify", { publicKey, message: "cafe", signature });
    const seed = ledger("key.fromSeed", { entropy: "00".repeat(16), password: "", network: 0, accountIndex: 0, addressType: "Base" });
    const details = ledger("address.inspect", { address: seed.address });
    const output = { address: seed.address, assets: { lovelace: "2000000" }, datum: "d8799f01ff" };
    const cbor = ledger("output.encode", { utxo: output });
    const decoded = ledger("output.decode", { cbor });
    const minAda = ledger("output.minAda", { output, coinsPerUtxoByte: "4310" });
    const encodedBigInteger = ledger("data.encode", { data: { int: (1n << 600n).toString() }, canonical: false });
    const decodedBigInteger = ledger("data.decode", { cbor: encodedBigInteger });
    for (let i = 0; i < 50; i++) ledger("data.hash", { cbor: "01" });
    return { calls, wasmBytes: bytes.byteLength, signatureVerified, addressType: details.type, datum: decoded.datum, minAda, largeIntegerVerified: decodedBigInteger.int === (1n << 600n).toString(), logs };
  });
  assert.equal(result.signatureVerified, true);
  assert.equal(result.addressType, "Base");
  assert.equal(result.datum, "d8799f01ff");
  assert.equal(result.largeIntegerVerified, true);
  assert(BigInt(result.minAda) > 0n);
  assert.deepEqual(result.logs, []);
  console.log(JSON.stringify({ passed: true, mainThread: true, ...result }, null, 2));
} finally {
  await browser.close();
  server.close();
}

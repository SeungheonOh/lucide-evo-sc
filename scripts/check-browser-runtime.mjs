import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { chromium } from "playwright-core";

const root = fileURLToPath(new URL("../", import.meta.url));
const bundle = await build({
  entryPoints: [root + "packages/lucid/dist/index.js"],
  bundle: true,
  format: "esm",
  platform: "browser",
  target: "es2022",
  conditions: ["browser"],
  write: false,
  metafile: true,
  logLevel: "error",
});
assert(
  Object.keys(bundle.metafile.inputs).some((path) =>
    path.endsWith("ledger/dist/browser.js"),
  ),
);
assert(
  !Object.keys(bundle.metafile.inputs).some((path) =>
    /(?:cardano-multiplatform|cardano-serialization|packages\/cml\/|scalus|\/uplc\/)/.test(
      path,
    ),
  ),
);
const wasm = await readFile(root + "packages/ledger/sc-tools.wasm");
const server = createServer((request, response) => {
  if (request.url === "/") {
    response.setHeader("content-type", "text/html");
    response.end("<!doctype html><title>Lucid Haskell package test</title>");
  } else if (request.url === "/dist/lucid.js") {
    response.setHeader("content-type", "application/javascript");
    response.end(bundle.outputFiles[0].contents);
  } else if (request.url === "/sc-tools.wasm") {
    response.setHeader("content-type", "application/wasm");
    response.end(wasm);
  } else response.writeHead(404).end();
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
let browser;
try {
  browser = await chromium.launch({
    executablePath: process.env.CHROMIUM_PATH || chromium.executablePath(),
    headless: true,
    args: ["--no-sandbox"],
  });
  const page = await browser.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(String(error)));
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  const result = await page.evaluate(async () => {
    const api = await import("/dist/lucid.js");
    const account = api.generateEmulatorAccount({ lovelace: 100_000_000n });
    const receiver = api.generateEmulatorAccount({ lovelace: 0n });
    const emulator = new api.Emulator([account]);
    const lucid = await api.Lucid(emulator, "Custom");
    lucid.selectWallet.fromSeed(account.seedPhrase);
    const completed = await lucid
      .newTx()
      .pay.ToAddress(receiver.address, { lovelace: 3_000_000n })
      .complete();
    const signed = await completed.sign.withWallet().complete();
    const hash = await signed.submit();
    emulator.awaitBlock();
    const received = await emulator.getUtxos(receiver.address);
    const message = "cafe";
    const signature = await lucid
      .wallet()
      .signMessage(account.address, message);
    const details = api.getAddressDetails(account.address);
    const verified = api.verifyData(
      details.address.hex,
      details.paymentCredential.hash,
      message,
      signature,
    );
    return {
      mainThread: typeof document !== "undefined",
      cmlExport: "CML" in api,
      dataRoundtrip: api.Data.from(api.Data.to(1n << 600n)) === 1n << 600n,
      amount: received[0]?.assets.lovelace.toString(),
      hashMatches: hash === signed.toHash(),
      messageVerified: verified,
    };
  });
  assert.deepEqual(result, {
    mainThread: true,
    cmlExport: false,
    dataRoundtrip: true,
    amount: "3000000",
    hashMatches: true,
    messageVerified: true,
  });
  assert.deepEqual(errors, []);
  console.log(
    JSON.stringify(
      {
        passed: true,
        wasmBytes: wasm.length,
        bundleBytes: bundle.outputFiles[0].contents.length,
        ...result,
      },
      null,
      2,
    ),
  );
} finally {
  await browser?.close();
  server.close();
}

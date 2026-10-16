// Exercise bridge v2 in the shipped browser worker, without a chain service.
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { wallet, witnessSet } from "./test-fixtures.mjs";

const cache = execFileSync("python3", ["-B", fileURLToPath(new URL("./paths.py", import.meta.url)), "cache"], { encoding: "utf8" }).trim();
const { chromium } = createRequire(join(cache, "browser-test/package.json"))("playwright-core");
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || chromium.executablePath(), headless: true, args: ["--no-sandbox"] });
try {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(process.env.DEMO_URL || "http://127.0.0.1:4173");
  await page.evaluate(() => window.scTools.ready);
  await context.setOffline(true);
  const run = (payload) => page.evaluate((p) => window.scTools.run(p), payload);
  const checked = async (payload) => {
    const result = await run(payload);
    assert.equal(result.ok, true, result.error);
    return result;
  };
  assert.equal((await checked({ action: "capabilities" })).bridgeVersion, 2);
  const genesis = await checked({ action: "mockchain", operation: "init", utxos: wallet.utxos, systemStart: "0", treasury: "0" });
  const automatic = await checked({ action: "lucidContext", network: "custom", protocolParameters: genesis.chain.protocolParameters,
    slotConfig: { zeroTime: 123, zeroSlot: 0, slotLength: 500 } });
  assert.equal(Number(automatic.chain.systemStart), 0.123);
  assert.equal(automatic.chain.eraSummaries[0].parameters.slot_length, 0.5);
  const fixture = await checked({ action: "mockchain", operation: "setFixtures", state: genesis.state, chain: genesis.chain, slot: 0,
    utxos: wallet.utxos, datums: [], accounts: [], treasury: "1000000" });
  assert.equal(fixture.treasury, "1000000");
  const balanced = await checked({ action: "balanceV2", chain: genesis.chain, wallet, resolvedInputs: wallet.utxos,
    blocks: [{ type: "output", output: { address: wallet.changeAddress, lovelace: "2000000", assets: [] } }], options: { minFee: "1000000" } });
  const signed = await checked({ action: "mergeWitnesses", cbor: balanced.transaction.cborHex, witnessSet: witnessSet(balanced.transaction.txId) });
  const request = { action: "mockchain", operation: "submit", state: genesis.state, chain: genesis.chain, slot: 0, cbor: signed.transaction.cborHex };
  const submitted = await checked(request);
  assert.equal(submitted.txHash, balanced.transaction.txId);
  const rejected = await run({ ...request, state: submitted.state });
  assert.equal(rejected.ok, false);
  const queried = await checked({ action: "mockchain", operation: "query", state: submitted.state, chain: submitted.chain, slot: 1 });
  assert.deepEqual(queried.utxos, submitted.utxos);
  console.log(JSON.stringify({ passed: true, offline: true, bridgeVersion: 2, checks: ["capabilities", "genesis", "Lucid context", "public fixtures", "balance", "sign", "ledger submission", "double-spend rejection", "state round-trip"] }, null, 2));
} finally {
  await browser.close();
}

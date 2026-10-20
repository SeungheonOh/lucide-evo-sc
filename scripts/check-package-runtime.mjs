import assert from "node:assert/strict";
import { createRequire } from "node:module";
import * as esm from "../packages/lucid/dist/index.js";

const require = createRequire(import.meta.url);
const cjs = require("../packages/lucid/dist/index.cjs");
for (const [format, api] of [
  ["esm", esm],
  ["commonjs", cjs],
]) {
  assert(!("CML" in api));
  assert.equal(api.Data.to(42n), "182a");
  assert.equal(api.Data.from(api.Data.to(1n << 600n)), 1n << 600n);
  const account = api.generateEmulatorAccount({ lovelace: 100_000_000n });
  const emulator = new api.Emulator([account]);
  const lucid = await api.Lucid(emulator, "Custom");
  lucid.selectWallet.fromSeed(account.seedPhrase);
  const receiver = api.generateEmulatorAccount({ lovelace: 0n });
  const unsigned = await lucid
    .newTx()
    .pay.ToAddress(receiver.address, { lovelace: 3_000_000n })
    .complete();
  const signed = await unsigned.sign.withWallet().complete();
  assert.equal(await signed.submit(), signed.toHash());
  emulator.awaitBlock();
  const received = await emulator.getUtxos(receiver.address);
  assert.equal(received.length, 1);
  assert.equal(received[0].assets.lovelace, 3_000_000n);
  console.log(
    `${process.version} ${format}: packaged Haskell data, wallet, balancing, signing and convex-mockchain submission passed.`,
  );
}

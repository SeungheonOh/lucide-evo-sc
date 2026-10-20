import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const cache = execFileSync("python3", ["-B", fileURLToPath(new URL("./paths.py", import.meta.url)), "cache"], { encoding: "utf8" }).trim();
const artifact = process.env.SC_TOOLS_LEDGER_WASM || `${cache}/build/build/wasm32-wasi/ghc-9.12.4.20260731/sc-tools-browser-0.1.0.0/x/sc-tools-ledger/build/sc-tools-ledger/sc-tools-ledger.wasm`;
const { WASI, File, OpenFile, ConsoleStdout, PreopenDirectory } = await import(pathToFileURL(`${cache}/output/browser/wasi/index.js`));
const wasi = new WASI(["sc-tools-ledger"], [], [new OpenFile(new File(new Uint8Array())), ConsoleStdout.lineBuffered(console.log), ConsoleStdout.lineBuffered(console.error), new PreopenDirectory("/", new Map())], { debug: false });
wasi.wasiImport.random_get = (pointer, length) => {
  const bytes = new Uint8Array(wasi.inst.exports.memory.buffer, pointer, length);
  for (let index = 0; index < length; index += 65536) webcrypto.getRandomValues(bytes.subarray(index, index + 65536));
  return 0;
};
const { instance } = await WebAssembly.instantiate(readFileSync(artifact), { wasi_snapshot_preview1: wasi.wasiImport });
wasi.initialize(instance);
const exports = instance.exports;
exports.lucid_init();
let calls = 0;
function request(payload) {
  const bytes = new TextEncoder().encode(JSON.stringify(payload));
  const pointer = exports.lucid_alloc(bytes.length);
  let result = 0;
  try {
    new Uint8Array(exports.memory.buffer).set(bytes, pointer);
    result = exports.lucid_run(pointer, bytes.length);
    const decoded = JSON.parse(new TextDecoder().decode(new Uint8Array(exports.memory.buffer, result, exports.lucid_result_len())));
    assert.equal(decoded.ok, true, decoded.error);
    calls += 1;
    return decoded;
  } finally {
    exports.lucid_free(pointer);
    if (result) exports.lucid_free(result);
  }
}
const ledger = (operation, payload = {}) => request({ action: "ledger", operation, ...payload }).result;
const hash = ledger("hash.blake2b", { hex: "", size: 32 });
assert.equal(hash, "0e5751c026e543b2e8ab2eb06099daa1d1e5df47778f7787faab45cdf12fe3a8");
const term = { list: [{ int: "18446744073709551616" }, { bytes: "abcd" }, { tag: "258", value: { list: [] } }] };
assert.deepEqual(ledger("cbor.decode", { cbor: ledger("cbor.encode", { value: term }) }), term);
const data = { constructor: "128", fields: [{ map: [{ k: { bytes: "abcd" }, v: { int: "1" } }, { k: { int: "-1" }, v: { list: [] } }] }] };
const cbor = ledger("data.encode", { data, canonical: false });
assert.equal(cbor, "d8669f18809fbf208042abcd01ffffff");
assert.deepEqual(ledger("data.decode", { cbor }), { constructor: 128, fields: [{ map: [{ k: { int: -1 }, v: { list: [] } }, { k: { bytes: "abcd" }, v: { int: 1 } }] }] });
// Public Data.from preserves map insertion order and first duplicate values,
// and consumes one item. The general ledger CBOR decoder remains strict.
assert.deepEqual(ledger("data.decode", { cbor: "a20100180002" }), { map: [{ k: { int: 1 }, v: { int: 0 } }, { k: { int: 0 }, v: { int: 2 } }] });
assert.deepEqual(ledger("data.decode", { cbor: "a201020103" }), { map: [{ k: { int: 1 }, v: { int: 2 } }, { k: { int: 1 }, v: { int: 2 } }] });
assert.deepEqual(ledger("data.decode", { cbor: "01ff" }), { int: 1 });
assert.throws(() => ledger("cbor.decode", { cbor: "01ff" }), /Trailing CBOR bytes/);
assert.throws(() => ledger("data.decode", { cbor: "5bffffffffffffffff" }));
assert.equal(ledger("data.hash", { cbor: "01" }).length, 64);
const privateKey = ledger("key.generate");
const normal = ledger("key.fromPrivate", { privateKey });
const signature = ledger("key.sign", { privateKey, message: "cafe" });
assert.equal(ledger("key.verify", { publicKey: normal.publicKey, message: "cafe", signature }), true);
assert.equal(ledger("key.verify", { publicKey: normal.publicKeyHex, message: "caff", signature }), false);
const seed = ledger("key.fromSeed", { entropy: "00".repeat(16), password: "", network: 0, accountIndex: 0, addressType: "Base" });
const extended = ledger("key.fromPrivate", { privateKey: seed.paymentKey });
const extendedSignature = ledger("key.sign", { privateKey: seed.paymentKey, message: "cafe" });
assert.equal(ledger("key.verify", { publicKey: extended.publicKey, message: "cafe", signature: extendedSignature }), true);
assert.equal(ledger("address.inspect", { address: seed.address }).paymentCredential.hash, extended.keyHash);
const address = ledger("address.fromCredentials", { network: 0, payment: { type: "Key", hash: normal.keyHash } });
const output = { address, assets: { lovelace: "100000000" }, datumHash: "12".repeat(32) };
const encodedOutput = ledger("output.encode", { utxo: output });
assert.deepEqual(ledger("output.decode", { cbor: encodedOutput }), output);
assert(BigInt(ledger("output.minAda", { output, coinsPerUtxoByte: "4310" })) > 0n);
// Native script hashes and minimum ADA use the exact memoized script bytes.
const native = `9f00581c${normal.keyHash}ff`;
const canonicalNative = `8200581c${normal.keyHash}`;
assert.equal(ledger("script.hash", { type: "Native", script: native }), ledger("hash.blake2b", { hex: `00${native}`, size: 28 }));
const nativeOutput = { address, assets: { lovelace: "100000000" }, scriptRef: { type: "Native", script: native } };
assert.deepEqual(ledger("output.decode", { cbor: ledger("output.encode", { utxo: nativeOutput }) }), nativeOutput);
const canonicalNativeOutput = { ...nativeOutput, scriptRef: { type: "Native", script: canonicalNative } };
assert.equal(BigInt(ledger("output.minAda", { output: nativeOutput, coinsPerUtxoByte: "4310" })) - BigInt(ledger("output.minAda", { output: canonicalNativeOutput, coinsPerUtxoByte: "4310" })), 4310n);
const fundedOutput = ledger("output.encode", { utxo: { address, assets: { lovelace: "100000000" } } });
const utxo = ledger("cbor.encode", { value: { list: [{ list: [{ bytes: "12".repeat(32) }, { int: "0" }] }, ledger("cbor.decode", { cbor: fundedOutput })] } });
const genesis = request({ action: "mockchain", operation: "init", utxos: [utxo], systemStart: "0", treasury: "0" });
const balanced = request({ action: "balanceV2", chain: genesis.chain, wallet: { changeAddress: address, utxos: [utxo] }, resolvedInputs: [utxo], blocks: [{ type: "output", output: { address, lovelace: "2000000", assets: [] } }], options: { minFee: "1000000" } });
const transaction = balanced.transaction.cborHex;
const witness = ledger("tx.sign", { cbor: transaction, privateKeys: [privateKey] });
const signed = ledger("tx.mergeWitnesses", { cbor: transaction, witnessSets: [witness] });
const inspected = ledger("tx.inspect", { cbor: signed });
assert.equal(inspected.txId, balanced.transaction.txId);
assert.equal(inspected.lucidOutputs[0].address, address);
assert(inspected.bodyCbor.length > 0);
const signedMinimumFee = BigInt(ledger("tx.minFee", { cbor: signed, protocolParameters: genesis.chain.protocolParameters, utxos: [utxo] }));
assert(signedMinimumFee > 0n && signedMinimumFee < 1_000_000n);
const submitted = request({ action: "mockchain", operation: "submit", state: genesis.state, chain: genesis.chain, slot: 0, cbor: signed });
assert.equal(submitted.txHash, inspected.txId);
for (let i = 0; i < 100; i++) assert.equal(ledger("data.hash", { cbor: "01" }).length, 64);
console.log(JSON.stringify({ passed: true, calls, transactionHash: submitted.txHash, checks: ["CBOR", "Plutus data", "normal signing", "HD signing", "addresses", "datum hash output", "minimum ADA", "balance", "sign", "ledger submission", "persistent reactor"] }, null, 2));

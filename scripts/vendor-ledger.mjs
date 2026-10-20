import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, writeFile, rename } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const [bridgePath, outputPath] = process.argv.slice(2);
assert(
  bridgePath && outputPath,
  "Usage: node scripts/vendor-ledger.mjs BRIDGE_CHECKOUT BUILD_OUTPUT",
);
const bridge = resolve(bridgePath);
const output = resolve(outputPath);
assert.equal(
  execFileSync("git", ["status", "--porcelain"], {
    cwd: bridge,
    encoding: "utf8",
  }).trim(),
  "",
  "Commit the bridge source before recording artifact provenance",
);
const revision = execFileSync("git", ["rev-parse", "HEAD"], {
  cwd: bridge,
  encoding: "utf8",
}).trim();
const build = JSON.parse(
  await readFile(resolve(output, "browser/runtime-manifest.json"), "utf8"),
);
const wasm = await readFile(resolve(output, "sc-tools-ledger.wasm"));
const sha256 = createHash("sha256").update(wasm).digest("hex");
assert.equal(sha256, build.ledger.wasmSha256);
assert.equal(wasm.length, build.ledger.wasmBytes);
const target = fileURLToPath(new URL("../packages/ledger/", import.meta.url));
await writeFile(resolve(target, "sc-tools.wasm.next"), wasm);
await rename(
  resolve(target, "sc-tools.wasm.next"),
  resolve(target, "sc-tools.wasm"),
);
let notices = await readFile(
  resolve(output, "browser/THIRD_PARTY_NOTICES.txt"),
  "utf8",
);
for (const name of ["LICENSE-MIT", "LICENSE-APACHE"])
  notices += `\n\nBrowser WASI shim: ${name}\n\n${await readFile(resolve(output, "browser/wasi", name), "utf8")}`;
// Keep the license text while normalizing upstream line endings and whitespace.
notices =
  notices
    .replace(/\r\n/g, "\n")
    .replace(/[\t ]+$/gm, "")
    .trimEnd() + "\n";
await writeFile(resolve(target, "THIRD_PARTY_NOTICES.txt"), notices);
await writeFile(
  resolve(target, "artifact.json"),
  JSON.stringify(
    {
      schemaVersion: 1,
      compiler: build.compiler,
      upstreamRevision: build.upstreamCommit,
      bridgeRepository: "https://github.com/SeungheonOh/lucide-evo-sc",
      bridgeBranch: "sc-tools-wasm",
      bridgeRevision: revision,
      reactorAbiVersion: build.ledger.version,
      bytes: wasm.length,
      sha256,
    },
    null,
    2,
  ) + "\n",
);
console.log(`Vendored Haskell reactor from ${revision}: ${sha256}`);

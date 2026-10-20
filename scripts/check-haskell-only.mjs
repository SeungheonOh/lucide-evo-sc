import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

const root = fileURLToPath(new URL("../", import.meta.url));
const forbidden =
  /@(?:dcspark|emurgo|harmoniclabs)\/|cardano-multiplatform-lib|cardano-serialization-lib|@lucid-evolution\/(?:cml|uplc|scalus-uplc)(?:["'\s/]|$)/i;
const files = execFileSync(
  "git",
  ["ls-files", "-z", "--cached", "--others", "--exclude-standard"],
  { cwd: root, encoding: "utf8" },
)
  .split("\0")
  .filter((file) => file && existsSync(resolve(root, file)));
for (const file of files) {
  if (
    file === "pnpm-lock.yaml" ||
    file.endsWith("package.json") ||
    /^packages\/[^/]+\/(?:src|test)\/.*\.[cm]?[jt]sx?$/.test(file)
  ) {
    assert(
      !forbidden.test(readFileSync(resolve(root, file), "utf8")),
      `Forbidden ledger dependency in ${file}`,
    );
  }
}
assert.deepEqual(
  files.filter((file) => file.endsWith(".wasm")),
  ["packages/ledger/sc-tools.wasm"],
  "Only the Haskell reactor may be shipped",
);
const artifact = readFileSync(resolve(root, "packages/ledger/sc-tools.wasm"));
const manifest = JSON.parse(
  readFileSync(resolve(root, "packages/ledger/artifact.json"), "utf8"),
);
assert.equal(
  createHash("sha256").update(artifact).digest("hex"),
  manifest.sha256,
);
assert.equal(artifact.length, manifest.bytes);
const module = new WebAssembly.Module(artifact);
const exports = new Set(
  WebAssembly.Module.exports(module).map((item) => item.name),
);
for (const name of [
  "memory",
  "lucid_init",
  "lucid_alloc",
  "lucid_run",
  "lucid_result_len",
  "lucid_free",
])
  assert(exports.has(name), `Missing Haskell reactor export ${name}`);
assert(
  WebAssembly.Module.imports(module).every(
    (item) => item.module === "wasi_snapshot_preview1",
  ),
);
for (const directory of readdirSync(resolve(root, "packages"))) {
  const dist = resolve(root, "packages", directory, "dist");
  if (
    !existsSync(resolve(root, "packages", directory, "package.json")) ||
    !existsSync(dist)
  )
    continue;
  for (const file of readdirSync(dist)) {
    if (/\.(?:c?js|d\.[cm]?ts)$/.test(file))
      assert(
        !forbidden.test(readFileSync(resolve(dist, file), "utf8")),
        `Forbidden dependency in built ${directory}/${file}`,
      );
  }
}
console.log(
  `Haskell-only dependency and artifact checks passed (${artifact.length} bytes, ${manifest.sha256}).`,
);

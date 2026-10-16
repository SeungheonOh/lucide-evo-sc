#!/usr/bin/env python3
from pathlib import Path
import gzip
import hashlib
import json
import shutil
import sys

sys.dont_write_bytecode = True
from paths import BROWSER, DEPS, OUTPUT, ROOT

data = Path(sys.argv[1]).read_bytes()
if data[:4] != b'\0asm':
    raise SystemExit('Expected a WebAssembly executable')
compressed = gzip.compress(data, compresslevel=9, mtime=0)
OUTPUT.mkdir(parents=True, exist_ok=True)
if BROWSER.exists():
    shutil.rmtree(BROWSER)
shutil.copytree(ROOT / 'browser', BROWSER)
shim = DEPS / 'browser-wasi-shim-0.4.2'
shutil.copytree(shim / 'dist', BROWSER / 'wasi')
for license_name in ['LICENSE-APACHE', 'LICENSE-MIT']:
    shutil.copy2(shim / license_name, BROWSER / 'wasi' / license_name)
(OUTPUT / 'sc-tools.wasm').write_bytes(data)
(BROWSER / 'sc-tools.wasm.gz').write_bytes(compressed)
metadata = {
    'bridgeVersion': 2,
    'upstreamCommit': '4546122230491db4839a4a42fc2bc601f7900909',
    'compiler': 'wasm32-wasi-ghc 9.12.4.20260731',
    'wasmBytes': len(data),
    'gzipBytes': len(compressed),
    'wasmSha256': hashlib.sha256(data).hexdigest(),
    'gzipSha256': hashlib.sha256(compressed).hexdigest(),
}
(BROWSER / 'runtime-manifest.json').write_text(json.dumps(metadata, indent=2) + '\n')
print(json.dumps(metadata, indent=2))

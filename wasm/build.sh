#!/usr/bin/env bash
set -euo pipefail

project_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
cd "$project_dir"
cache_dir=$(python3 -B wasm/paths.py cache)
toolchain_dir=${GHC_WASM_PREFIX:-"$cache_dir/toolchain"}
mkdir -p "$cache_dir/tmp"
export TMPDIR="$cache_dir/tmp"
export PYTHONDONTWRITEBYTECODE=1

if [[ ! -f "$toolchain_dir/env" ]]; then
  meta_dir="$cache_dir/downloads/ghc-wasm-meta"
  mkdir -p "$meta_dir"
  git -C "$meta_dir" init -q
  git -C "$meta_dir" fetch --depth=1 https://gitlab.haskell.org/ghc/ghc-wasm-meta.git 8fd59591635cb47ad7db124562039bea8441cae8
  git -C "$meta_dir" checkout --detach FETCH_HEAD
  PREFIX="$toolchain_dir" FLAVOUR=9.12 "$meta_dir/setup.sh"
fi
source "$toolchain_dir/env"
[[ $(wasm32-wasi-ghc --numeric-version) == 9.12.4.20260731 ]] || {
  echo 'This port requires the pinned GHC WASM 9.12.4.20260731 toolchain.' >&2
  exit 1
}
python3 wasm/prepare-dependencies.py
wasm32-wasi-cabal build --project-file="$cache_dir/cabal.project" --builddir="$cache_dir/build" -j"${BUILD_JOBS:-4}" exe:sc-tools-browser exe:sc-tools-ledger
executable=$(wasm32-wasi-cabal list-bin --project-file="$cache_dir/cabal.project" --builddir="$cache_dir/build" exe:sc-tools-browser)
reactor=$(wasm32-wasi-cabal list-bin --project-file="$cache_dir/cabal.project" --builddir="$cache_dir/build" exe:sc-tools-ledger)
python3 wasm/package-runtime.py "$executable" "$reactor"
python3 wasm/collect-notices.py "$toolchain_dir"

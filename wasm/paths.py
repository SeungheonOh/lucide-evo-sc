"""External paths shared by the build, packaging, and browser test helpers."""
from pathlib import Path
import os
import sys

ROOT = Path(__file__).resolve().parent.parent
default_cache = Path(os.environ.get('XDG_CACHE_HOME', Path.home() / '.cache')) / 'lucid-sctools-wasm'
CACHE_ROOT = Path(os.environ.get('SC_TOOLS_WASM_CACHE', default_cache)).expanduser().resolve()
if CACHE_ROOT.is_relative_to(ROOT):
    raise SystemExit('SC_TOOLS_WASM_CACHE must point outside the source directory.')
DEPS = CACHE_ROOT / 'deps'
DOWNLOADS = CACHE_ROOT / 'downloads'
BUILD = CACHE_ROOT / 'build'
OUTPUT = CACHE_ROOT / 'output'
BROWSER = OUTPUT / 'browser'
PROJECT = CACHE_ROOT / 'cabal.project'

if __name__ == '__main__':
    print({'cache': CACHE_ROOT, 'deps': DEPS, 'downloads': DOWNLOADS,
           'build': BUILD, 'output': OUTPUT, 'browser': BROWSER,
           'project': PROJECT, 'test': CACHE_ROOT / 'browser-test',
           'evidence': CACHE_ROOT / 'evidence'}[sys.argv[1]])

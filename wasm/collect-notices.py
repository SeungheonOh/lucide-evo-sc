#!/usr/bin/env python3
"""Collect bundled runtime dependency notices from Cabal's resolved source graph."""
from pathlib import Path
import json
import re
import sys
import tarfile

sys.dont_write_bytecode = True
from paths import BROWSER, BUILD, DEPS, ROOT

toolchain = Path(sys.argv[1]).resolve()
plan = json.loads((BUILD / 'cache/plan.json').read_text())
nodes = {node['id']: node for node in plan['install-plan']}
visited = set()

def walk(key):
    if key in visited:
        return
    visited.add(key)
    for dep in nodes[key].get('depends', []):
        walk(dep)

for key, node in nodes.items():
    if node['pkg-name'] == 'sc-tools-browser':
        walk(key)
packages = {(nodes[key]['pkg-name'], nodes[key]['pkg-version']): nodes[key] for key in visited}
notice = re.compile(r'^(unlicense|licen[cs]e|copying|copyright|notice)([.\-_].*)?$', re.I)
sections = ['sc-tools browser runtime — third-party notices\n\n'
            'Collected from the runtime dependency graph; unused library code may be eliminated by the linker.\n'
            'The browser WASI shim licenses are also supplied in wasi/.\n']
missing = []
for (name, version), node in sorted(packages.items()):
    files = []
    source = node.get('pkg-src', {})
    cabal_metadata = ''
    if name.startswith('convex-'):
        files = [('sc-tools/LICENSE', (DEPS / 'sc-tools/LICENSE').read_text())]
    elif name == 'sc-tools-browser':
        files = [('LICENSE', (ROOT / 'LICENSE').read_text())]
    elif source.get('type') in ('local', 'source-repo'):
        path = Path(source['path']) if source['type'] == 'local' else next(p.parent for p in (BUILD / 'src').glob('*/' + name + '.cabal'))
        files = [(str(p.relative_to(path)), p.read_text(errors='replace')) for p in sorted(path.rglob('*'))
                 if p.is_file() and notice.match(p.name) and '.git' not in p.parts and 'dist-build' not in p.parts]
    else:
        archives = list((toolchain / '.cabal/packages').glob(f'*/{name}/{version}/{name}-{version}.tar.gz'))
        if archives:
            with tarfile.open(archives[0]) as archive:
                for member in archive.getmembers():
                    if member.isfile() and member.name.endswith('/' + name + '.cabal'):
                        cabal_metadata = archive.extractfile(member).read().decode(errors='replace')
                    if member.isfile() and notice.match(Path(member.name).name):
                        files.append((member.name, archive.extractfile(member).read().decode(errors='replace')))
        elif node['type'] == 'pre-existing':
            for p in (toolchain / 'wasm32-wasi-ghc/lib/doc').glob(f'*/{name}-{version}/*'):
                if p.is_file() and notice.match(p.name):
                    files.append((p.name, p.read_text(errors='replace')))
    if not files:
        fields = '\n'.join(line for line in cabal_metadata.splitlines() if re.match(r'^(license|copyright|author|homepage):', line, re.I))
        if fields:
            files = [('Package metadata (no separate license file in source archive)', fields)]
        else:
            missing.append(f'{name}-{version}')
    else:
        sections.append('\n' + '=' * 72 + f'\n{name} {version}\n' + '=' * 72 + '\n')
        for filename, contents in files:
            sections.append(f'\n{filename}\n\n{contents}\n')
(BROWSER / 'THIRD_PARTY_NOTICES.txt').write_text(''.join(sections))
print(f'Collected notices for {len(packages) - len(missing)} runtime packages.')
if missing:
    print('Packages without a source notice found:', ', '.join(missing))
    with (BROWSER / 'THIRD_PARTY_NOTICES.txt').open('a') as output:
        output.write('\nToolchain components without a separate notice in this installation: ' + ', '.join(missing) + '\n')

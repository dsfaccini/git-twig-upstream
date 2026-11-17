#!/usr/bin/env python3
"""Create an owned lower-layer adoption case with valid future merged Git paths."""
import json
import os
from pathlib import Path
import subprocess
import sys
import uuid

backing = Path(sys.argv[1]).resolve(strict=True)
case = backing / ('adopt-lower-' + uuid.uuid4().hex)
case.mkdir(mode=0o700)
for name in ['lower', 'upper', 'work', 'merged']:
    (case / name).mkdir()
lower, merged = case / 'lower', case / 'merged'
privileged = [] if os.geteuid() == 0 else ['sudo', '-n']
environment = {k: v for k, v in os.environ.items() if not k.startswith('GIT_')}
environment.update(GIT_CONFIG_GLOBAL='/dev/null', GIT_CONFIG_NOSYSTEM='1',
                   GIT_TEMPLATE_DIR='', GIT_TERMINAL_PROMPT='0')
def command(args, cwd=case):
    subprocess.run(args, cwd=cwd, env=environment, check=True,
                   stdout=subprocess.DEVNULL, timeout=30)
def git(args, cwd):
    command(['git', '-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false'] + args, cwd)
# Bind first: Git records the same merged paths it will see through OverlayFS.
# Mutating a lower directory after mounting OverlayFS would be an invalid fixture.
command(privileged + ['mount', '--bind', str(lower), str(merged)])
try:
    source = merged / 'source'
    source.mkdir()
    git(['init', '-b', 'main'], source)
    git(['config', 'user.name', 'Fixture'], source)
    git(['config', 'user.email', 'fixture@example.invalid'], source)
    (source / 'payload').write_bytes(bytes(i % 251 for i in range(65536 + 37)))
    (source / 'dirty').write_bytes(b'committed\n')
    git(['add', '.'], source)
    git(['commit', '-m', 'lower adoption fixture'], source)
    git(['worktree', 'add', '--detach', '../feature', 'HEAD'], source)
    probe = merged / 'probe'
    probe.mkdir()
    data = bytes((i * 17 + 23) % 251 for i in range(65536 + 37))
    for name in ['donor', 'target']:
        (probe / name).write_bytes(data)
    target = merged / 'feature'
    (target / 'dirty').write_bytes(b'staged bytes\n')
    git(['add', 'dirty'], target)
    for checkout in [source, target]:
        (checkout / 'dirty').write_bytes(b'identical dirty current bytes\x00\xff\n')
finally:
    command(privileged + ['umount', str(merged)])
command(privileged + ['mount', '-t', 'overlay', 'overlay', '-o',
                     f'lowerdir={lower},upperdir={case}/upper,workdir={case}/work', str(merged)])
print(json.dumps({'schemaVersion': 1, 'case': str(merged), 'oracle': str(lower),
                  'note': 'Owned mount; unmount merged before detaching backing. All fixture files retained.'}))

#!/usr/bin/env python3
"""Probe Linux clone/dedupe independently; retain all fixtures and raw outcomes."""
import argparse
import json
import os
from pathlib import Path
import subprocess
import uuid

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('filesystem_root', type=Path)
parser.add_argument('--github-env', action='store_true')
args = parser.parse_args()
root = args.filesystem_root.resolve(strict=True)
if not root.is_dir():
    parser.error('filesystem root must be an existing owned test directory')
identity = 'probe-' + uuid.uuid4().hex
fixture = root / identity
fixture.mkdir(mode=0o700)
output = Path(__file__).resolve().parents[4] / 'target/adoption-probes' / identity
output.mkdir(parents=True, mode=0o700)


def run(command, label):
    result = subprocess.run(command, capture_output=True, timeout=60)
    (output / (label + '.stdout')).write_bytes(result.stdout)
    (output / (label + '.stderr')).write_bytes(result.stderr)
    return result


executable = output / 'dedupe-probe'
compile_result = run(['cc', '-std=gnu11', '-Wall', '-Wextra', '-Werror',
                      str(Path(__file__).with_name('linux-dedupe-probe.c')),
                      '-o', str(executable)], 'compile')
compile_result.check_returncode()
result = run([str(executable), str(fixture)], 'dedupe')
result.check_returncode()
probe = json.loads(result.stdout)
if (probe['request'], probe['headerBytes'], probe['infoBytes'], probe['infoOffset']) != (0xc0189436, 24, 32, 24):
    raise RuntimeError('installed Linux UAPI differs from the supported adoption ABI')
clone = run(['cp', '--reflink=always', str(fixture / 'donor'), str(fixture / 'clone')], 'clone')
capability = {'schemaVersion': 1, 'fixture': str(fixture), 'artifacts': str(output),
              'cloneSupported': clone.returncode == 0,
              'dedupeSupported': probe['supported'], 'dedupeProbe': probe}
(output / 'capability.json').write_text(json.dumps(capability, indent=2) + '\n')
if args.github_env:
    with open(os.environ['GITHUB_ENV'], 'a') as environment:
        environment.write('TWIG_TEST_DEDUPE_SUPPORTED=' + str(int(probe['supported'])) + '\n')
print(json.dumps(capability))

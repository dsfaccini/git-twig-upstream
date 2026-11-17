#!/usr/bin/env python3
"""Collect frozen checkout campaigns without fixtures/images/logs; derive CSV/SVG."""
import argparse
import csv
import hashlib
import json
import math
import statistics
from collections import defaultdict
from pathlib import Path


def read_json(path):
    data = path.read_bytes()
    return json.loads(data), hashlib.sha256(data).hexdigest()


def collect(manifest_path, interrupted_progress=None):
    manifest, digest = read_json(manifest_path)
    if manifest['schemaVersion'] not in (1, 2):
        raise ValueError('unsupported campaign schema')
    if manifest['status'] in ('preparing', 'running'):
        raise ValueError('campaign is still running')
    if manifest.get('exploratory', False):
        raise ValueError('exploratory campaign is not a publishable snapshot')
    runs = []
    for point in manifest['points']:
        name = point['result']
        if Path(name).name != name or not name.endswith('.json'):
            raise ValueError('unsafe result name')
        path = manifest_path.parent / name
        if not path.exists():
            if point['verified']:
                raise ValueError('verified point has no result')
            runs.append({'name': name, 'sha256': None, 'result': None})
            continue
        if path.is_symlink():
            raise ValueError('result must not be a symlink')
        result, result_digest = read_json(path)
        expected = manifest['baseline'] if point['backend'] == 'baseline' else manifest['candidate']
        if result['schemaVersion'] != 4 or result['commit'] != manifest['commit'] or result['dirty']:
            raise ValueError('unfrozen or incompatible point')
        if result['candidateSha256'] != expected['sha256']:
            raise ValueError('binary identity differs')
        if point['verified'] and (result['failures'] or len(result['cohorts']) != 1):
            raise ValueError('verified point has invalid cohorts')
        runs.append({'name': name, 'sha256': result_digest, 'result': result})
    partial = None
    if interrupted_progress:
        failed = [p for p in manifest['points'] if not p['verified']]
        if len(failed) != 1:
            raise ValueError('partial progress requires exactly one interrupted point')
        data = interrupted_progress.read_bytes()
        records = [json.loads(line) for line in data.splitlines() if line.strip()]
        partial = {'point': failed[0]['result'], 'sha256': hashlib.sha256(data).hexdigest(), 'records': records}
    kind = ('checkout-coverage-snapshot' if manifest['config'].get('target', {}).get('os') == 'darwin'
            else 'linux-coverage-snapshot')
    return {'schemaVersion': 1, 'kind': kind,
            'notes': ['All original suite headers and cohorts are retained without changing measurements. Original file hashes identify the source runs; images, source fixtures and large logs are excluded.',
                      'CSV batch medians use repeated cohorts, not individual-create latency. Nearest-rank operation percentiles describe only the observed sample; small samples do not establish population tail latency.',
                      'Manifest v1 does not record each effective timeout. The runner bounds it by min(pointTimeoutSeconds, remaining total budget). A timeout at the end of a campaign is not necessarily the full configured per-point timeout.',
                      'Interrupted creation checkpoints are unverified diagnostic outcomes, never successful performance cohorts. Incomplete or unstable three-way groups cannot support comparative conclusions.'],
            'manifestSha256': digest, 'manifest': manifest, 'runs': runs, 'partialCreationProgress': partial}


def percentile(values, percent):
    return sorted(values)[max(0, math.ceil(len(values) * percent / 100) - 1)]


def summaries(snapshot):
    manifest = snapshot['manifest']
    runs = {run['name']: run['result'] for run in snapshot['runs']}
    groups = defaultdict(list)
    for point in manifest['points']:
        groups[(point['filesystem'], point['profile'], point['concurrency'], point['worktrees'])].append(point)
    for key, points in sorted(groups.items()):
        expected = {(r, b) for r in range(manifest['config']['rounds']) for b in ('git', 'baseline', 'candidate')}
        observed = {(p['round'], p['backend']) for p in points if p['verified'] and p['allocationStable']}
        complete = observed == expected and len(points) == len(expected)
        for backend in ('git', 'baseline', 'candidate'):
            selected = [p for p in points if p['backend'] == backend]
            good = [runs[p['result']]['cohorts'][0] for p in selected if p['verified']]
            if not good:
                continue
            operations = [op for cohort in good for op in cohort['operations']]
            latencies = [op['createMs'] for op in operations]
            clones = [op['verifiedClones'] for op in operations]
            written = [op['gitWrittenPaths'] for op in operations]
            yield dict(filesystem=key[0], profile=key[1], concurrency=key[2], worktrees=key[3],
                backend=backend, pairedGroupComplete=complete, verifiedPoints=len(good),
                failedPoints=sum(not p['verified'] for p in selected), operations=len(operations),
                batchCreateMedianMs=statistics.median(c['createWallMs'] for c in good),
                createsPerSecondMedian=statistics.median(c['createsPerSecond'] for c in good),
                createP50Ms=percentile(latencies,50), createP95Ms=percentile(latencies,95),
                createP99Ms=percentile(latencies,99), createMaxMs=max(latencies),
                firstStatusP50Ms=statistics.median(op['firstStatusMs'] for op in operations),
                allocationMedianBytes=statistics.median(c['growthAfterStatusBytes'] for c in good),
                allocationMinBytes=min(c['growthAfterStatusBytes'] for c in good),
                allocationMaxBytes=max(c['growthAfterStatusBytes'] for c in good),
                maxHarnessCpuWallRatio=max(c['harnessCpuMsDuringCreate']/c['createWallMs'] for c in good),
                nativeOperations=sum(op['nativeCow'] for op in operations),
                verifiedClones=sum(clones) if all(x is not None for x in clones) else None,
                gitWrittenPaths=sum(written) if all(x is not None for x in written) else None)


def save_csv(snapshot, path):
    rows = list(summaries(snapshot))
    if not rows:
        raise ValueError('no observed groups')
    with path.open('x', newline='') as handle:
        writer = csv.DictWriter(handle, fieldnames=list(rows[0]), lineterminator='\n')
        writer.writeheader()
        writer.writerows(rows)


def save_svg(snapshot, path):
    from html import escape
    rows = [r for r in summaries(snapshot) if r['pairedGroupComplete'] and r['concurrency'] == 1]
    if not rows:
        raise ValueError('no complete c1 groups for chart')
    filesystems = sorted({r['filesystem'] for r in rows})
    profiles = ['cross-revision', 'mixed-builtins', 'auto-crlf', 'submodules', 'byte-heavy', 'file-heavy']
    labels = ['revision', 'builtins', 'auto CRLF', 'gitlinks', 'unchanged', '4096 files']
    backends = [('git', '#7c8696'), ('baseline', '#5187d2'), ('candidate', '#28a179')]
    height = 120 + 365 * len(filesystems)
    rounds = snapshot['manifest']['config']['rounds']
    parts = [f'<svg xmlns="http://www.w3.org/2000/svg" width="1240" height="{height}" viewBox="0 0 1240 {height}">',
             '<rect width="100%" height="100%" fill="#fff"/>',
             '<g font-family="monospace" font-size="12" fill="#17212c">',
             f'<text x="30" y="24">Local warm-cache filesystem images: c1 batch medians; {escape(str(rounds))} planned rounds</text>']
    for i, (backend, color) in enumerate(backends):
        identity = snapshot['manifest'].get(backend, {})
        revision = identity.get('sourceCommit') or identity.get('sha256', '')
        name = 'stock Git' if backend == 'git' else f'Twig {revision[:7]}'
        parts.append(f'<rect x="{30+i*220}" y="40" width="14" height="14" fill="{color}"/><text x="{50+i*220}" y="52">{escape(name)}</text>')
    for fs_index, filesystem in enumerate(filesystems):
        for metric_index, (metric, divisor, title) in enumerate([
                ('allocationMedianBytes', 1048576, 'additional allocation after status (MiB)'),
                ('batchCreateMedianMs', 1, 'batch create CLI wall time (ms)')]):
            x0, y0 = 65 + metric_index * 620, 345 + fs_index * 365
            selected = {(r['profile'], r['backend']): r[metric]/divisor for r in rows if r['filesystem'] == filesystem}
            lower = min(min(selected.values()) * 1.18, 0)
            upper = max(max(selected.values()) * 1.18, 1e-9)
            scale = 220 / (upper - lower)
            zero = y0 + lower * scale
            parts.append(f'<text x="{x0-30}" y="{y0-255}">{escape(filesystem)}: {title}</text>')
            for tick in range(5):
                value = lower + (upper-lower)*tick/4
                y = y0 - (value-lower)*scale
                parts.append(f'<path d="M{x0} {y}h520" stroke="#e3e7eb"/><text x="{x0-52}" y="{y+4}">{value:.1f}</text>')
            parts.append(f'<path d="M{x0} {zero}h520" stroke="#7c8696"/>')
            for i, (profile, label) in enumerate(zip(profiles, labels)):
                if any((profile, backend) not in selected for backend, _ in backends):
                    continue
                for j, (backend, color) in enumerate(backends):
                    value = selected[(profile, backend)]
                    x = x0 + i*86 + j*23
                    y = y0 - (value-lower)*scale
                    bar_y, bar_height = min(y, zero), max(abs(y-zero), 0.5)
                    label_y = bar_y-6 if value >= 0 else bar_y+bar_height+12
                    label_value = f"{value:.4f}" if 0 < abs(value) < 0.01 else f"{value:.2f}"
                    parts.append(f'<rect x="{x}" y="{bar_y}" width="20" height="{bar_height}" fill="{color}"/><text x="{x+10}" y="{label_y}" text-anchor="middle" font-size="9">{label_value}</text>')
                parts.append(f'<text x="{x0+i*86+30}" y="{y0+22}" text-anchor="middle" font-size="10">{label}</text>')
    parts.extend([f'<text x="30" y="{height-25}">Synthetic fixtures only; complete stable groups only. Small samples do not establish population tails.</text>', '</g></svg>'])
    with path.open('x') as handle:
        handle.write('\n'.join(parts) + '\n')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    source = parser.add_mutually_exclusive_group(required=True)
    source.add_argument('--manifest', type=Path)
    source.add_argument('--snapshot', type=Path)
    parser.add_argument('--output', type=Path)
    parser.add_argument('--csv', type=Path)
    parser.add_argument('--svg', type=Path)
    parser.add_argument('--interrupted-progress', type=Path)
    args = parser.parse_args()
    if args.manifest:
        if not args.output:
            parser.error('--manifest requires --output')
        snapshot = collect(args.manifest, args.interrupted_progress)
    else:
        snapshot, _ = read_json(args.snapshot)
        if snapshot.get('schemaVersion') != 1 or snapshot.get('kind') != 'linux-coverage-snapshot':
            raise ValueError('unsupported snapshot schema')
    if args.output:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        with args.output.open('x') as handle:
            json.dump(snapshot, handle, separators=(',', ':'), ensure_ascii=True)
            handle.write('\n')
    if args.csv:
        save_csv(snapshot, args.csv)
    if args.svg:
        save_svg(snapshot, args.svg)


if __name__ == '__main__':
    main()

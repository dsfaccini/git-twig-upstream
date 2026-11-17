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
    filesystems = sorted({row['filesystem'] for row in rows})
    if not filesystems:
        raise ValueError('no complete stable c1 comparisons to plot')

    profiles = [('cross-revision', 'Cross-revision'), ('mixed-builtins', 'Builtin conversions'),
                ('auto-crlf', 'Auto CRLF'), ('submodules', 'Submodules'),
                ('byte-heavy', 'Unchanged bytes'), ('file-heavy', '4,096 small files')]
    backends = [('git', '#98a2b3'), ('baseline', '#5789c7'), ('candidate', '#3a9d5d')]
    filesystem_names = {'apfs': 'APFS · default', 'apfs-sensitive': 'APFS · case-sensitive', 'apfs-case-sensitive': 'APFS · case-sensitive',
                        'xfs': 'XFS', 'btrfs': 'Btrfs'}
    manifest = snapshot['manifest']
    points = manifest['points']
    verified = sum(point['verified'] for point in points)
    unstable = sum(point['verified'] and not point['allocationStable'] for point in points)
    section_height = 630
    canvas_height = 200 + len(filesystems) * section_height
    style = """text{font-family:Inter,ui-sans-serif,system-ui,-apple-system,sans-serif;fill:#101828}
.title{font-size:26px;font-weight:700}.sub{font-size:15px;fill:#475467}
.tick{font-size:13px;fill:#667085}.label{font-size:15px;font-weight:600;fill:#344054}
.section{font-size:16px;font-weight:700}.legend{font-size:15px}
.value{font-size:13px;font-weight:600;fill:#344054}
.fail{font-size:14px;font-weight:600;fill:#b54708}
.grid{stroke:#eaecf0}.range{stroke:#344054;stroke-width:1.5;opacity:.55}"""
    parts = [f'<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="{canvas_height}" viewBox="0 0 1200 {canvas_height}">',
             f'<style>{style}</style>', f'<rect width="1200" height="{canvas_height}" fill="#fff"/>',
             '<text x="48" y="40" class="title">Twig · checkout time and disk allocation</text>',
             '<text x="48" y="66" class="sub">Warm-cache filesystem images · cohort medians · one create at a time · lower is better</text>']
    failed = sum(not point['verified'] for point in points)
    status = f"{'Run completed' if manifest['status'] == 'completed' else 'Run stopped'} · {verified} verified points"
    if unstable:
        status += f" · {unstable} unstable allocation {'observation' if unstable == 1 else 'observations'} retained"
    if failed:
        status += f" · {failed} failed/unfinished {'point' if failed == 1 else 'points'}; incomplete groups not compared"
    parts.append(f'<text x="48" y="90" class="{"fail" if manifest["status"] != "completed" or unstable else "sub"}">{escape(status)}</text>')
    for index, (backend, color) in enumerate(backends):
        identity = manifest.get(backend, {})
        revision = identity.get('sourceCommit') or identity.get('sha256', '')
        name = 'stock Git' if backend == 'git' else f'Twig {backend} · {revision[:7]}'
        x = 48 + index * 260
        parts.append(f'<rect x="{x}" y="112" width="26" height="14" rx="3" fill="{color}"/><text x="{x+36}" y="125" class="legend">{escape(name)}</text>')

    def duration(ms):
        return f'{ms/1000:.2f} s' if ms >= 1000 else f'{ms:.0f} ms'

    def allocation(value):
        return f'{value/1048576:.2f} MiB' if value >= 1048576 else f'{value/1024:.1f} KiB'

    for fs_index, filesystem in enumerate(filesystems):
        top = 170 + fs_index * section_height
        selected = {(r['profile'], r['backend']): r for r in rows if r['filesystem'] == filesystem}
        visible = [(profile, label) for profile, label in profiles if all((profile, backend) in selected for backend, _ in backends)]
        parts.append(f'<text x="48" y="{top}" class="section">{escape(filesystem_names.get(filesystem, filesystem))}</text>')
        for metric, bar_x, value_x, title, formatter in [
                ('batchCreateMedianMs', 250, 650, 'Creation time', duration),
                ('allocationMedianBytes', 775, 1175, 'Additional allocation', allocation)]:
            scale_key = 'allocationMaxBytes' if metric == 'allocationMedianBytes' else metric
            upper = max(max(row[scale_key] for row in selected.values()) * 1.08, 1)
            lower = min(0, min(row['allocationMinBytes'] for row in selected.values())) * 1.08 if metric == 'allocationMedianBytes' else 0
            scale = 280 / (upper - lower)
            zero_x = bar_x - lower * scale
            parts.append(f'<text x="{bar_x}" y="{top}" class="section">{title}</text>')
            for tick in range(5):
                x = bar_x + 280 * tick / 4
                parts.append(f'<path d="M{x:.1f} {top+18}V{top+len(visible)*88+4}" class="grid"/>')
                parts.append(f'<text x="{x:.1f}" y="{top+len(visible)*88+24}" text-anchor="middle" class="tick">{escape(formatter(lower+(upper-lower)*tick/4))}</text>')
            for index, (profile, _) in enumerate(visible):
                row_y = top + 22 + index * 88
                for backend_index, (backend, color) in enumerate(backends):
                    row = selected[(profile, backend)]
                    value = row[metric]
                    y = row_y + backend_index * 21
                    width = abs(value * scale)
                    if value != 0:
                        start_x = zero_x - max(width, 2) if value < 0 else zero_x
                        parts.append(f'<rect x="{start_x:.1f}" y="{y}" width="{max(width,2):.1f}" height="16" rx="3" fill="{color}"/>')
                    if metric == 'allocationMedianBytes':
                        low = row['allocationMinBytes']
                        high = row['allocationMaxBytes']
                        if low != high:
                            x1, x2 = zero_x+low*scale, zero_x+high*scale
                            parts.append(f'<path d="M{x1:.1f} {y+8}H{x2:.1f}" class="range"/>')
                    parts.append(f'<text x="{value_x}" y="{y+13}" text-anchor="end" class="value">{escape(formatter(value))}</text>')
        for index, (profile, label) in enumerate(visible):
            row_y = top + 22 + index * 88
            row = selected[(profile, 'candidate')]
            rounds = row['verifiedPoints']
            parts.append(f'<text x="48" y="{row_y+26}" class="label">{escape(label)}</text>')
            parts.append(f'<text x="48" y="{row_y+47}" class="tick">{row["worktrees"]} creates · {rounds} {"round" if rounds == 1 else "rounds"}</text>')

    parts.extend([f'<text x="48" y="{canvas_height-52}" class="sub">Each column uses one linear scale per filesystem. Allocation includes metadata and indexes after first status.</text>',
                  f'<text x="48" y="{canvas_height-28}" class="sub">Synthetic workloads on a shared host. CSV retains every level, unstable observation and incomplete group.</text>',
                  '</svg>'])
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
        if snapshot.get('schemaVersion') != 1 or snapshot.get('kind') not in ('linux-coverage-snapshot', 'checkout-coverage-snapshot', 'filesystem-coverage-snapshot'):
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

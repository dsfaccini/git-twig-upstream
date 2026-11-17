import hashlib
import json
import tarfile
import tempfile
import unittest
from pathlib import Path

import coverage_snapshot as snapshot


class SnapshotTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name)
        self.manifest = {
            'schemaVersion': 1, 'status': 'completed', 'commit': 'harness',
            'config': {'rounds': 1}, 'baseline': {'sha256': 'old'},
            'candidate': {'sha256': 'new'}, 'points': []}
        self.result = {'schemaVersion': 4, 'commit': 'harness', 'dirty': False,
                       'candidateSha256': 'new', 'cohorts': [], 'failures': []}

    def write(self):
        path = self.root / 'manifest.json'
        path.write_text(json.dumps(self.manifest))
        return path

    def point(self, **changes):
        point = dict(filesystem='xfs', profile='fixture', concurrency=1,
                     worktrees=2, round=0, backend='candidate', result='point.json',
                     verified=False, allocationStable=False)
        point.update(changes)
        self.manifest['points'].append(point)
        (self.root / 'point.json').write_text(json.dumps(self.result))
        return point

    def test_apfs_retains_platform_identity(self):
        self.manifest['config']['target'] = {'os': 'darwin'}
        self.point(filesystem='apfs')
        value = snapshot.collect(self.write())
        self.assertEqual(value['kind'], 'checkout-coverage-snapshot')
        self.assertEqual(value['manifest']['points'][0]['filesystem'], 'apfs')

    def test_svg_uses_actual_target_and_excludes_incomplete_groups(self):
        from unittest.mock import patch
        rows = [dict(filesystem='apfs-case-sensitive', profile='byte-heavy',
                     concurrency=1, pairedGroupComplete=True, backend=backend,
                     allocationMedianBytes=-4096 if backend == 'candidate' else 1048576,
                     batchCreateMedianMs=2)
                for backend in ('git', 'baseline', 'candidate')]
        with patch.object(snapshot, 'summaries', return_value=iter(rows)):
            path = self.root / 'chart.svg'
            snapshot.save_svg({'manifest': self.manifest}, path)
        svg = path.read_text()
        self.assertIn('apfs-case-sensitive', svg)
        self.assertIn('1 planned rounds', svg)
        self.assertNotIn('Interrupted Btrfs', svg)
        self.assertIn('-0.0039', svg)
        with patch.object(snapshot, 'summaries', return_value=iter([])):
            with self.assertRaisesRegex(ValueError, 'no complete c1'):
                snapshot.save_svg({'manifest': self.manifest}, self.root/'empty.svg')

    def test_retained_v05_csvs_regenerate_byte_for_byte(self):
        paths = list(Path(__file__).parent.glob('results/sha256-*/*/2026-11-17/checkout-v05/snapshot.json'))
        self.assertEqual(len(paths), 4)
        for index, path in enumerate(paths):
            with self.subTest(path=str(path)):
                value = json.loads(path.read_bytes())
                output = self.root / f'archive-{index}.csv'
                snapshot.save_csv(value, output)
                self.assertEqual(output.read_bytes(), path.with_name('summary.csv').read_bytes())
                artifact_index = json.loads(path.with_name('artifact-index.json').read_bytes())
                for artifact in artifact_index['artifacts']:
                    data = path.with_name(artifact['name']).read_bytes()
                    self.assertEqual(len(data), artifact['bytes'])
                    self.assertEqual(hashlib.sha256(data).hexdigest(), artifact['sha256'])
                with tarfile.open(path.with_name('raw-json.tar.gz'), 'r:gz') as archive:
                    data = archive.extractfile('manifest.json').read()
                    self.assertEqual(hashlib.sha256(data).hexdigest(), value['manifestSha256'])
                    self.assertEqual(json.loads(data), value['manifest'])
                    for run in value['runs']:
                        if run['sha256'] is None:
                            continue
                        data = archive.extractfile(run['name']).read()
                        self.assertEqual(hashlib.sha256(data).hexdigest(), run['sha256'])
                        self.assertEqual(json.loads(data), run['result'])

    def test_preserves_interrupted_header_and_unverified_creation_errors(self):
        self.point()
        progress = self.root / 'creation.jsonl'
        record = {'operations': [{'exitCode': 128, 'verified': False,
                                 'error': 'failed to read commondir'}]}
        progress.write_text(json.dumps(record) + '\n')
        value = snapshot.collect(self.write(), progress)
        self.assertEqual(value['runs'][0]['result'], self.result)
        self.assertEqual(value['partialCreationProgress']['records'], [record])
        self.assertEqual(list(snapshot.summaries(value)), [])
        self.assertEqual(len(value['runs'][0]['sha256']), 64)

    def test_preserves_verified_raw_numbers_without_normalizing_them(self):
        cohort = {'growthAfterStatusBytes': -4096, 'sourceCommit': 'a', 'targetCommit': 'b'}
        self.result['cohorts'] = [cohort]
        self.point(verified=True, allocationStable=True)
        value = snapshot.collect(self.write())
        self.assertEqual(value['runs'][0]['result']['cohorts'], [cohort])

    def test_accepts_new_deadline_metadata_without_rewriting_it(self):
        self.manifest['schemaVersion'] = 2
        self.point(timeoutSeconds=3, startedElapsedMs=1797000, finishedElapsedMs=1800010)
        value = snapshot.collect(self.write())
        self.assertEqual(value['manifest'], self.manifest)

    def test_rejects_running_campaign(self):
        self.manifest['status'] = 'running'
        with self.assertRaisesRegex(ValueError, 'still running'):
            snapshot.collect(self.write())

    def test_rejects_live_preparation_and_exploratory_campaigns(self):
        self.manifest['status'] = 'preparing'
        with self.assertRaisesRegex(ValueError, 'still running'):
            snapshot.collect(self.write())
        self.manifest['status'] = 'completed'
        self.manifest['exploratory'] = True
        with self.assertRaisesRegex(ValueError, 'not a publishable snapshot'):
            snapshot.collect(self.write())

    def test_rejects_redirected_or_mutated_result_identity(self):
        point = self.point(result='../elsewhere.json')
        with self.assertRaisesRegex(ValueError, 'unsafe result'):
            snapshot.collect(self.write())
        point['result'] = 'point.json'
        self.result['candidateSha256'] = 'different'
        (self.root / 'point.json').write_text(json.dumps(self.result))
        with self.assertRaisesRegex(ValueError, 'identity differs'):
            snapshot.collect(self.write())

    def test_rejects_symlink_result(self):
        self.point()
        target = self.root / 'target.json'
        (self.root / 'point.json').rename(target)
        (self.root / 'point.json').symlink_to(target)
        with self.assertRaisesRegex(ValueError, 'symlink'):
            snapshot.collect(self.write())

    def test_missing_failed_result_is_retained_but_not_promoted(self):
        self.point()
        (self.root / 'point.json').unlink()
        value = snapshot.collect(self.write())
        self.assertIsNone(value['runs'][0]['result'])
        self.assertEqual(list(snapshot.summaries(value)), [])

    def test_percentiles_are_nearest_rank_not_interpolated_tail_estimates(self):
        self.assertEqual(snapshot.percentile([4, 1, 3, 2], 50), 2)
        self.assertEqual(snapshot.percentile([4, 1, 3, 2], 95), 4)


if __name__ == '__main__':
    unittest.main()

import copy
import csv
import json
import unittest
from pathlib import Path
import publish_preview as p


class PreviewTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.data = p.build()
        entry = json.loads((p.ROOT / "bench/results/preview-sources.json").read_text())["datasets"][0]
        cls.entry = entry
        cls.snapshot = json.loads((p.ROOT / entry["snapshot"]).read_text())

    def test_counts_and_provenance_from_all_four_targets(self):
        self.assertEqual(sum(d["verifiedCreates"] for d in self.data["datasets"]), 992)
        self.assertEqual(sum(d["failedPoints"] for d in self.data["datasets"]), 2)
        self.assertEqual(sum(d["unstablePoints"] for d in self.data["datasets"]), 1)
        self.assertEqual(len({d["candidate"]["sourceCommit"] for d in self.data["datasets"]}), 1)

    def test_values_equal_retained_csvs(self):
        for dataset in self.data["datasets"]:
            with (p.ROOT / dataset["snapshot"]).with_name("summary.csv").open() as handle:
                rows = {(r["profile"], r["backend"]): r for r in csv.DictReader(handle)
                        if r["concurrency"] == "1"}
            for profile in dataset["profiles"]:
                self.assertIsNotNone(profile["measurements"])
                for value in profile["measurements"]:
                    raw = rows[(profile["profile"], value["backend"])]
                    self.assertEqual(value["timeMs"], float(raw["batchCreateMedianMs"]))
                    self.assertEqual(value["bytes"], float(raw["allocationMedianBytes"]))

    def test_unstable_group_is_not_compared_or_replaced_by_zero(self):
        snapshot = copy.deepcopy(self.snapshot)
        snapshot["manifest"]["points"][0]["allocationStable"] = False
        dataset = p.dataset(self.entry, snapshot, "unused")
        self.assertIsNone(dataset["profiles"][0]["measurements"])
        self.assertEqual(dataset["unstablePoints"], 1)

    def test_missing_round_is_not_compared(self):
        snapshot = copy.deepcopy(self.snapshot)
        del snapshot["manifest"]["points"][0]
        self.assertIsNone(p.dataset(self.entry, snapshot, "unused")["profiles"][0]["measurements"])

    def test_forged_verified_operation_is_rejected(self):
        snapshot = copy.deepcopy(self.snapshot)
        snapshot["runs"][0]["result"]["cohorts"][0]["operations"][0]["verified"] = False
        with self.assertRaisesRegex(ValueError, "unverified operation"):
            p.audit(snapshot)

    def test_wrong_binary_is_rejected(self):
        snapshot = copy.deepcopy(self.snapshot)
        snapshot["runs"][0]["result"]["candidateSha256"] = "0" * 64
        with self.assertRaisesRegex(ValueError, "identity differs"):
            p.audit(snapshot)

    def test_missing_private_write_check_is_rejected(self):
        snapshot = copy.deepcopy(self.snapshot)
        snapshot["runs"][0]["result"]["cohorts"][0]["privateWriteTested"] = False
        with self.assertRaisesRegex(ValueError, "private-write"):
            p.audit(snapshot)

    def test_running_dirty_and_exploratory_are_rejected(self):
        for field, value in (("status", "running"), ("dirty", True), ("exploratory", True)):
            snapshot = copy.deepcopy(self.snapshot)
            snapshot["manifest"][field] = value
            with self.assertRaises(ValueError):
                p.audit(snapshot)

    def test_negative_allocation_keeps_its_sign(self):
        self.assertEqual(p.disk(-4096), "-4.00 KiB")


if __name__ == "__main__":
    unittest.main()

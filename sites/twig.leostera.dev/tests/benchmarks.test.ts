import { expect, test } from "bun:test";
import { loadBenchmarks } from "../scripts/benchmarks";
import { loadPreview, previewSchema } from "../scripts/preview";

test("website compares only stock Git and latest Twig, without cross-revision", () => {
  const { datasets } = loadBenchmarks();
  expect(datasets.map((d) => d.target)).toEqual([
    "macos-apfs",
    "macos-apfs-case-sensitive",
    "linux-xfs",
    "linux-btrfs",
  ]);
  for (const dataset of datasets) {
    expect("baseline" in dataset).toBe(false);
    expect(dataset.profiles).toHaveLength(5);
    expect(dataset.profiles.some((p) => p.profile === "cross-revision")).toBe(
      false,
    );
    for (const profile of dataset.profiles) {
      expect(profile.measurements?.map((m) => m.backend)).toEqual([
        "git",
        "candidate",
      ]);
    }
  }
});

test("public values are derived from the full archived comparison", () => {
  const raw = loadPreview();
  const shown = loadBenchmarks();
  for (const dataset of shown.datasets) {
    const original = raw.datasets.find((d) => d.target === dataset.target)!;
    for (const profile of dataset.profiles) {
      const values = original.profiles.find(
        (p) => p.profile === profile.profile,
      )!.measurements!;
      expect(profile.measurements).toEqual([
        { ...values[0], backend: "git" as const },
        { ...values[2], backend: "candidate" as const },
      ]);
    }
  }
});

test("retains complete campaign counts and source identities", () => {
  const { datasets } = loadBenchmarks();
  expect(datasets.reduce((sum, d) => sum + d.verifiedCreates, 0)).toBe(992);
  expect(datasets.reduce((sum, d) => sum + d.failedPoints, 0)).toBe(2);
  expect(datasets.reduce((sum, d) => sum + d.unstablePoints, 0)).toBe(1);
  expect(new Set(datasets.map((d) => d.candidate.sourceCommit)).size).toBe(1);
});

test("rejects missing backends, nonfinite metrics and mixed sources", () => {
  const data = loadPreview();
  const row = data.datasets[0]!.profiles[0]!.measurements!;
  row[0].backend = "candidate";
  expect(() => previewSchema.parse(data)).toThrow();
  row[0].backend = "git";
  row[0].bytes = Number.NaN;
  expect(() => previewSchema.parse(data)).toThrow();
  const other = loadPreview();
  other.datasets[0]!.candidate.sourceCommit = "0".repeat(40);
  expect(() => previewSchema.parse(other)).toThrow();
});

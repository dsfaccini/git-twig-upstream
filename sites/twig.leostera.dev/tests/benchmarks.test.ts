import { expect, test } from "bun:test";
import { loadBenchmarks, loadPlatforms } from "../scripts/benchmarks";

const repositories = [
  "Linux kernel", "Pulumi docs", "OpenClaw", "Axo", "git-twig", "Workers starter",
];

test("uses verified checked-in allocation measurements", () => {
  const data = loadBenchmarks();
  expect(data.map(d => d.name)).toEqual(repositories);
  expect(data[0]!.gitBytes).toBeGreaterThan(data[0]!.twigBytes);
  expect(data.every(d => d.source.startsWith("https://github.com/leostera/git-twig/"))).toBe(true);
});

test("provides complete paired real-repository comparisons for all platforms", () => {
  const platforms = loadPlatforms();
  expect(Object.keys(platforms)).toEqual(["mac", "xfs", "btrfs"]);
  for (const rows of Object.values(platforms)) {
    expect(rows.map(d => d.name)).toEqual(repositories);
    expect(rows.every(d => d.gitBytes > 0 && d.twigBytes > 0 && d.rounds === 3 && d.concurrency === 1)).toBe(true);
    expect(rows.map(d => d.worktrees)).toEqual([1, 1, 1, 1, 10, 10]);
  }
});

test("retains the audited absolute allocation values", () => {
  const data = loadPlatforms();
  expect(data.mac[0]!.gitBytes).toBe(1964982272);
  expect(data.mac[0]!.twigBytes).toBe(46772224);
  expect(data.xfs[0]!.gitBytes).toBe(1982636032);
  expect(data.xfs[0]!.twigBytes).toBe(74174464);
  expect(data.btrfs[0]!.gitBytes).toBe(1981104128);
  expect(data.btrfs[0]!.twigBytes).toBe(200765440);
});

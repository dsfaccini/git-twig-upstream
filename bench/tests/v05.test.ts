import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { parseFixtures, verify } from "../suites/checkout.ts";

const root = new URL("../../", import.meta.url);
const archives = [
  {
    build: "a73d956e3301",
    target: "linux-xfs",
    verified: 72,
    stable: 72,
    status: "completed",
  },
  {
    build: "a73d956e3301",
    target: "linux-btrfs",
    verified: 71,
    stable: 71,
    status: "failed",
  },
  {
    build: "c4989db26497",
    target: "macos-apfs",
    verified: 63,
    stable: 63,
    status: "failed",
  },
  {
    build: "c4989db26497",
    target: "macos-apfs-case-sensitive",
    verified: 72,
    stable: 71,
    status: "completed",
  },
] as const;

test("fresh native snapshots retain every outcome and pass the original result gate", async () => {
  let verified = 0,
    creates = 0,
    failed = 0;
  for (const archive of archives) {
    const path = `bench/results/sha256-${archive.build}/${archive.target}/2026-11-17/checkout-v05/`;
    const snapshot = JSON.parse(
      await readFile(new URL(path + "snapshot.json", root), "utf8"),
    );
    const summary = JSON.parse(
      await readFile(new URL(path + "campaign-summary.json", root), "utf8"),
    );
    const manifest = snapshot.manifest;
    expect(manifest.commit).toBe("dc7f7205d46a8628508eee138149a39d4da96f24");
    expect(manifest.dirty).toBe(false);
    expect(manifest.exploratory).toBe(false);
    expect(manifest.status).toBe(archive.status);
    expect(manifest.candidate.sha256.startsWith(archive.build)).toBe(true);
    expect(summary.plannedPoints).toBe(72);
    expect(summary.verifiedPoints).toBe(archive.verified);
    expect(summary.stableVerifiedPoints).toBe(archive.stable);
    expect(snapshot.runs.length).toBe(manifest.points.length);
    const fixtures = parseFixtures(
      manifest.fixtures.map((f: object) => ({
        ...f,
        path: "<retained fixture>",
      })),
    );
    for (const point of manifest.points) {
      const run = snapshot.runs.find(
        (r: { name: string }) => r.name === point.result,
      );
      expect(run).toBeDefined();
      if (!point.verified) {
        failed++;
        expect(point.backend).toBe("git");
        expect(run.result.failures.length).toBeGreaterThan(0);
        expect(
          run.result.cohorts.some((c: { failed: number }) => c.failed > 0),
        ).toBe(true);
        continue;
      }
      verified++;
      creates += point.worktrees;
      const fixture = fixtures.find((f) => f.label === point.profile)!;
      expect(
        verify(run.result, {
          point,
          fixture,
          sha256:
            manifest[point.backend === "baseline" ? "baseline" : "candidate"]
              .sha256,
          commit: manifest.commit,
          filesystem: manifest.config.target.workerFilesystem,
          exploratory: false,
        }),
      ).toBe(point.allocationStable);
    }
  }
  expect(verified).toBe(278);
  expect(creates).toBe(992);
  expect(failed).toBe(2);
});

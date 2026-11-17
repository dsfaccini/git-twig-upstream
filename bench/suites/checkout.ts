import { invariant, list, record, string } from "../lib/results.ts";

export const profiles = [
  "cross-revision",
  "mixed-builtins",
  "auto-crlf",
  "submodules",
  "byte-heavy",
  "file-heavy",
] as const;
export type Profile = (typeof profiles)[number];
export type Backend = "git" | "baseline" | "candidate";
export interface Fixture {
  label: Profile;
  path: string;
  targetCommit: string;
  donorCommit: string | null;
}
export interface PlannedPoint {
  profile: Profile;
  concurrency: number;
  worktrees: number;
  round: number;
  backend: Backend;
}
export function plan(
  selected: Profile[],
  rounds: number,
  maxConcurrency: number,
): PlannedPoint[] {
  const points: PlannedPoint[] = [];
  const orders: Backend[][] = [
    ["git", "baseline", "candidate"],
    ["candidate", "git", "baseline"],
    ["baseline", "candidate", "git"],
  ];
  for (const profile of selected) {
    const levels =
      profile === "file-heavy"
        ? [1, 4, 16, 64, 128].filter((n) => n <= maxConcurrency)
        : [1];
    for (const concurrency of levels) {
      for (let round = 0; round < rounds; round++) {
        for (const backend of orders[round % 3]!)
          points.push({
            profile,
            concurrency,
            worktrees: Math.max(2, concurrency),
            round,
            backend,
          });
      }
    }
  }
  return points;
}
export function parseFixtures(value: unknown): Fixture[] {
  const fixtures = list(value).map((item) => {
    const f = record(item);
    invariant(profiles.includes(f.label as Profile), "Unknown fixture profile");
    invariant(
      /^[a-f0-9]{40}$/.test(string(f.targetCommit)),
      "Invalid fixture target",
    );
    invariant(
      f.donorCommit === null || /^[a-f0-9]{40}$/.test(string(f.donorCommit)),
      "Invalid fixture donor",
    );
    return {
      label: f.label as Profile,
      path: string(f.path),
      targetCommit: string(f.targetCommit),
      donorCommit: f.donorCommit as string | null,
    };
  });
  invariant(
    new Set(fixtures.map((f) => f.label)).size === fixtures.length,
    "Duplicate fixture",
  );
  return fixtures;
}

// This gate certifies the Rust worker's raw result, never substitutes for its byte checks.
export function verify(
  value: unknown,
  expected: {
    point: PlannedPoint;
    fixture: Fixture;
    sha256: string;
    commit: string;
    filesystem: string;
    exploratory: boolean;
  },
): boolean {
  const raw = record(value),
    { point, fixture } = expected;
  invariant(
    raw.schemaVersion === 4 &&
      (raw.dirty === false || (expected.exploratory && raw.dirty === true)),
    "Wrong schema or dirty harness",
  );
  invariant(
    raw.candidateSha256 === expected.sha256 && raw.commit === expected.commit,
    "Binary or harness provenance changed",
  );
  invariant(
    raw.filesystem === expected.filesystem &&
      raw.concurrency === point.concurrency &&
      raw.worktreesPerCohort === point.worktrees &&
      raw.repeats === 1,
    "Wrong filesystem or cohort configuration",
  );
  invariant(
    raw.selectedBackend === (point.backend === "git" ? "git" : "twig"),
    "Wrong selected backend",
  );
  invariant(
    raw.requireNative === (point.backend === "candidate"),
    "Wrong native requirement",
  );
  invariant(list(raw.failures).length === 0, "Harness reported failures");
  const cohorts = list(raw.cohorts);
  invariant(cohorts.length === 1, "Expected one completed cohort");
  const cohort = record(cohorts[0]);
  invariant(
    cohort.repository === fixture.label &&
      cohort.backend === (point.backend === "git" ? "git" : "twig") &&
      cohort.repeat === 0,
    "Wrong fixture or backend",
  );
  invariant(
    cohort.targetCommit === fixture.targetCommit &&
      cohort.sourceCommit === (fixture.donorCommit ?? fixture.targetCommit),
    "Wrong source or target revision",
  );
  invariant(
    cohort.succeeded === point.worktrees &&
      cohort.failed === 0 &&
      cohort.sourceUnchanged === true,
    "Incorrect or incomplete point",
  );
  invariant(
    cohort.privateWriteTested === true &&
      Number.isSafeInteger(cohort.trackedFiles) &&
      Number(cohort.trackedFiles) > 0 &&
      cohort.verifiedFiles === Number(cohort.trackedFiles) * point.worktrees,
    "Missing full verification or private-write probe",
  );
  for (const key of ["createWallMs", "createsPerSecond"]) {
    invariant(
      typeof cohort[key] === "number" &&
        Number.isFinite(cohort[key]) &&
        Number(cohort[key]) > 0,
      `Invalid ${key}`,
    );
  }
  for (const key of ["harnessCpuMsDuringCreate", "observerWallMs"]) {
    invariant(
      typeof cohort[key] === "number" &&
        Number.isFinite(cohort[key]) &&
        Number(cohort[key]) >= 0,
      `Invalid ${key}`,
    );
  }
  invariant(
    Number.isSafeInteger(cohort.growthAfterStatusBytes),
    "Invalid allocation delta",
  );
  const operations = list(cohort.operations);
  invariant(operations.length === point.worktrees, "Missing operations");
  for (const item of operations) {
    const operation = record(item);
    invariant(
      operation.verified === true &&
        operation.exitCode === 0 &&
        operation.error === null,
      "Operation did not verify",
    );
    for (const key of ["createMs", "firstStatusMs"]) {
      invariant(
        typeof operation[key] === "number" &&
          Number.isFinite(operation[key]) &&
          Number(operation[key]) >= 0,
        `Invalid ${key}`,
      );
    }
    if (point.backend === "candidate")
      invariant(
        operation.nativeCow === true &&
          Number.isSafeInteger(operation.verifiedClones) &&
          Number(operation.verifiedClones) > 0,
        "Candidate did not retain verified clones",
      );
  }
  const snapshots = [
    "before",
    "afterCreate",
    "afterStatus",
    "afterPrivateWrites",
  ].map((key) => record(cohort[key]));
  for (const snapshot of snapshots) {
    invariant(
      typeof snapshot.stable === "boolean",
      "Missing allocation stability observation",
    );
    invariant(
      Number.isSafeInteger(snapshot.allocatedBytes) &&
        Number(snapshot.allocatedBytes) >= 0,
      "Invalid allocated bytes",
    );
    invariant(
      Number.isSafeInteger(snapshot.totalBytes) &&
        Number(snapshot.totalBytes) > 0,
      "Invalid filesystem size",
    );
    const observed = list(snapshot.observedAllocatedBytes);
    invariant(
      observed.length > 0 &&
        observed.every((n) => Number.isSafeInteger(n) && Number(n) >= 0),
      "Missing allocation samples",
    );
  }
  return snapshots.every((snapshot) => snapshot.stable === true);
}

import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { posix } from "node:path";
import { z } from "zod";

export interface DiskComparison {
  name: string;
  worktrees: number;
  concurrency: number;
  rounds: number;
  gitBytes: number;
  twigBytes: number;
  source: string;
}
const macFile = "sha256-eaa9c3990dfa/macos-apfs-case-sensitive/2026-11-18/real-repositories-v05-qualified/summary.json";
const linuxFile = "v0.5.0-linux-stable.json";
export const sources = [{ file: macFile }, { file: linuxFile }];
export const benchmarkFile = (file: string) => new URL(`../../../bench/results/${file}`, import.meta.url);
const read = (file: string) => JSON.parse(readFileSync(benchmarkFile(file), "utf8"));
const names = [
  ["linux", "Linux kernel"], ["pulumi", "Pulumi docs"], ["openclaw", "OpenClaw"],
  ["axo", "Axo"], ["twig", "git-twig"], ["workers-starter", "Workers starter"],
] as const;
const snapshot = z.object({
  stable: z.literal(true),
  allocatedBytes: z.number().finite(),
  observedAllocatedBytes: z.array(z.number().finite()).min(3),
});
const suite = z.object({
  schemaVersion: z.literal(4), dirty: z.literal(false), failures: z.array(z.unknown()).length(0),
  candidateSha256: z.string(), concurrency: z.literal(1), worktreesPerCohort: z.number().int().positive(),
  allocationSampling: z.object({ minimumSamples: z.number().int().positive(), stableSamples: z.number().int().positive() }).optional(),
  cohorts: z.array(z.object({
    repository: z.string(), sourceCommit: z.string(), targetCommit: z.string(),
    backend: z.enum(["git", "twig"]), repeat: z.number().int(),
    sourceUnchanged: z.literal(true), privateWriteTested: z.literal(true),
    succeeded: z.number().int().positive(), failed: z.literal(0),
    before: snapshot, afterStatus: snapshot, growthAfterStatusBytes: z.number().finite().positive(),
    operations: z.array(z.object({
      verified: z.literal(true), exitCode: z.literal(0), error: z.null(), nativeCow: z.boolean(),
    })),
  })).length(6),
});
const median = (values: number[]) => [...values].sort((a,b) => a-b)[1]!;
function comparison(file: string, sha: string, repository: string, name: string, candidate: string, pin: string, count: number): DiskComparison {
  const bytes = readFileSync(benchmarkFile(file));
  if (createHash("sha256").update(bytes).digest("hex") !== sha) throw new Error("Raw artifact hash differs");
  const run = suite.parse(JSON.parse(bytes.toString("utf8")));
  if (run.candidateSha256 !== candidate || run.worktreesPerCohort !== count) throw new Error("Candidate/batch mismatch");
  const pairs = new Set(run.cohorts.map(c => c.backend + ":" + c.repeat));
  if (!["git:0","git:1","git:2","twig:0","twig:1","twig:2"].every(p => pairs.has(p))) throw new Error("Missing paired round");
  for (const c of run.cohorts) {
    if (c.repository !== repository || c.sourceCommit !== pin || c.targetCommit !== pin ||
        c.succeeded !== count || c.operations.length !== count) throw new Error("Repository/cohort differs");
    if (c.backend === "twig" && c.operations.some(o => !o.nativeCow)) throw new Error("Not native CoW");
    for (const s of [c.before, c.afterStatus]) {
      const n = run.allocationSampling?.stableSamples ?? 3;
      const values = s.observedAllocatedBytes;
      if (values.length < (run.allocationSampling?.minimumSamples ?? 3) ||
          new Set(values.slice(-n)).size !== 1) throw new Error("Allocation not settled");
    }
    if (c.growthAfterStatusBytes !== c.afterStatus.allocatedBytes-c.before.allocatedBytes) throw new Error("Delta differs");
  }
  return { name, worktrees: count, concurrency: 1, rounds: 3,
    gitBytes: median(run.cohorts.filter(c=>c.backend==="git").map(c=>c.growthAfterStatusBytes)),
    twigBytes: median(run.cohorts.filter(c=>c.backend==="twig").map(c=>c.growthAfterStatusBytes)),
    source: `https://github.com/leostera/git-twig/blob/727d5d6a283cb2bb14ba60c58064b1bb839f6309/bench/results/${file}` };
}
export function loadPlatforms(): Record<"mac"|"xfs"|"btrfs", DiskComparison[]> {
  const linux = read(linuxFile), mac = read(macFile);
  const result: Record<"mac"|"xfs"|"btrfs", DiskComparison[]> = { mac: [], xfs: [], btrfs: [] };
  for (const [repository, name] of names) {
    const input = linux.inputs.find((x: {label:string}) => x.label===repository);
    const row = mac.comparisons.find((x: {repository:string})=>x.repository===repository);
    if (!row?.comparisonEligible || !input) throw new Error("Missing qualified Mac/input data");
    const file = row.rawFile.startsWith("bench/results/")
      ? row.rawFile.slice("bench/results/".length) : posix.join(posix.dirname(macFile),row.rawFile);
    result.mac.push(comparison(file,row.rawSHA256,repository,name,mac.candidateSHA256,input.revision,input.worktrees));
    for (const fs of ["xfs","btrfs"] as const) {
      const target = "linux-"+fs;
      const observation = linux.observations.find((o: {target:string;repository:string}) => o.target===target && o.repository===repository);
      if (!observation || observation.status!=="verified") throw new Error("Missing qualified Linux data");
      result[fs].push(comparison(observation.file.slice("bench/results/".length),observation.sha256,
        repository,name,linux.candidateHashes[target].sha256,input.revision,input.worktrees));
    }
  }
  return result;
}
export function loadBenchmarks(): DiskComparison[] { return loadPlatforms().mac; }

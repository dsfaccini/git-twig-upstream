#!/usr/bin/env bun
/** Sequential campaign controller; measurements remain in the frozen Rust CLI harness. */
import { createHash } from "node:crypto";
import { chmodSync, closeSync, copyFileSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, statfsSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const [runArg, mainArg, axoArg] = process.argv.slice(2);
if (!runArg || !mainArg || !axoArg) throw new Error("bun bench/run-apfs-release.ts RUN_DIRECTORY MAIN_CHECKOUT AXO_CHECKOUT");
const cwd = process.cwd();
const run = resolve(runArg), main = resolve(mainArg), axo = resolve(axoArg);
const bin = resolve(run, "bin");
const text = (args: string[]) => {
  const p = Bun.spawnSync(args, { cwd, stdout: "pipe", stderr: "pipe" });
  if (p.exitCode) throw new Error(new TextDecoder().decode(p.stderr));
  return new TextDecoder().decode(p.stdout).trim();
};
if (text(["git", "status", "--porcelain"])) throw new Error("Commit harness before measurement");
for (const name of ["git-twig", "twig-real-bench", "git"]) {
  if (!existsSync(resolve(bin, name))) throw new Error(`Missing frozen ${name}`);
}
const sha = (file: string) => createHash("sha256").update(readFileSync(file)).digest("hex");
const environment = { ...process.env, PATH: `${bin}:${process.env.PATH}`, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_ATTR_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0", GIT_EXEC_PATH: text([resolve(bin, "git"), "--exec-path"]) };
for (const key of Object.keys(environment)) {
  if (key.startsWith("GIT_TRACE") || key.startsWith("TWIG_PROFILE")) delete environment[key];
}
const inputs = [
  { name: "workers-starter", path: resolve(main, "target/workers-starter"), commit: "d0b1ee485dc1cf2bc0b2a3511cf8cf1057624d02" },
  { name: "twig", path: main, commit: "96c43950e4c0d8524de4ad53157c136eb222d39c" },
  { name: "axo", path: axo, commit: "67af816be26633039e8507d93d577b2073d6f5fd" },
  { name: "linux", path: resolve(main, "target/kernel-input.git"), commit: "23c62304dde29abe92013d85910d03a77dada35d" },
  { name: "openclaw", path: resolve(run, "input/openclaw.git"), commit: "410c0dda40702e25263b49b8b7d0786a5e49e366" },
];
for (const input of inputs) text(["git", "-C", input.path, "cat-file", "-e", `${input.commit}^{commit}`]);
const jobs = inputs.flatMap(input => {
  const large = ["linux", "openclaw"].includes(input.name);
  const modes = input.name === "linux" ? ["case-sensitive-image"] : ["host", "case-sensitive-image"];
  return modes.map(mode => ({ input, mode, count: large ? 10 : 100, concurrency: large ? 1 : 100, repeats: 3, capacity: input.name === "linux" ? 32 : input.name === "openclaw" ? 24 : 16, file: `${input.name}-${mode === "host" ? "host" : "images"}.json` }));
});
const manifest = {
  schemaVersion: 1, generatedAt: new Date().toISOString(), runnerCommit: text(["git", "rev-parse", "HEAD"]), dirty: false,
  candidateSourceCommit: "47c92163c3ca8b59eee76fa546f86eef826780a7",
  candidateVersion: text([resolve(bin, "git-twig"), "--version"]),
  binaries: Object.fromEntries(["git-twig", "twig-real-bench", "git"].map(name => [name, { sha256: sha(resolve(bin, name)) }])),
  baseline: text([resolve(bin, "git"), "--version"]), platform: text(["sw_vers"]), cpu: text(["sysctl", "-n", "machdep.cpu.brand_string"]),
  config: jobs.map(({ input, ...job }) => ({ repository: input.name, sourceCommit: input.commit, ...job })),
  limits: { minimumHostFreeGiB: 128, disposableImageCapacityGiB: 32, concurrentCampaignJobs: 1 },
  notes: [
    "Release candidate, not a published v0.4.0 binary; source commit and binary digests identify the implementation, version string remains 0.3.0.",
    "Stock Git baseline and candidate use the same pinned tree per pair. Prior four workload revisions are preserved. OpenClaw retains its original attributes.",
    "Warm caches on a shared Mac; no competing builds/tests initiated by this controller. Background apps are not stopped. No cold-cache or general speed claim.",
    "100-way/100-worktree cohorts for Workers/git-twig/Axo; ten sequential creates for kernel/OpenClaw. Three paired repetitions and one warmup per backend/repetition.",
    "Host timing and isolated-image allocation are separate measurements. Kernel timing/allocation both use case-sensitive APFS images.",
    "Filesystem image allocations include metadata/indexes and are not exclusive per-file block counts. Isolated images are disposable; host fixtures retained.",
    "All raw failures are retained. No retries or automatic exclusion of failed observations. Final verification, native selection and private writes are outside creation timing.",
  ],
};
writeFileSync(resolve(run, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
let phase = "running";
const completed: unknown[] = [];
let current = "", childPid: number | null = null;
function state(extra: Record<string, unknown> = {}) {
  const fs = statfsSync(run);
  const freeGiB = fs.bavail * fs.bsize / 2 ** 30;
  const value = { schemaVersion: 1, phase, supervisorPid: process.pid, current, childPid, updatedAt: new Date().toISOString(), freeGiB, completed, ...extra };
  writeFileSync(resolve(run, "state.tmp"), JSON.stringify(value, null, 2) + "\n");
  renameSync(resolve(run, "state.tmp"), resolve(run, "state.json"));
  return freeGiB;
}
try {
  for (const job of jobs) {
    current = job.file;
    if (state() < 128) throw new Error("Minimum host free-space guard");
    const output = resolve(run, job.file);
    if (existsSync(output)) throw new Error(`Refusing to overwrite ${output}`);
    const args = [resolve(bin, "twig-real-bench"), "--repo", `${job.input.name}=${job.input.path}`, "--revision", `${job.input.name}=${job.input.commit}`, "--candidate", resolve(bin, "git-twig"), "--filesystem", job.mode, "--image-gib", String(job.capacity), "--worktrees", String(job.count), "--concurrency", String(job.concurrency), "--repeats", String(job.repeats), "--warmup", "true", "--output", output];
    console.log(new Date().toISOString(), "START", current);
    const log = openSync(resolve(run, job.file.replace(".json", ".log")), "wx");
    const child = Bun.spawn(args, { cwd, env: environment, stdin: "ignore", stdout: log, stderr: log });
    childPid = child.pid;
    let done = false;
    const finished = child.exited.then(code => { done = true; return code; });
    while (!done) {
      const cohorts = existsSync(output) ? JSON.parse(readFileSync(output, "utf8")).cohorts : [];
      const free = state({ cohorts: cohorts.map((c: any) => ({ backend: c.backend, repeat: c.repeat, succeeded: c.succeeded, failed: c.failed, createWallMs: c.createWallMs, growthAfterStatusBytes: c.growthAfterStatusBytes })) });
      if (free < 128) { child.kill("SIGTERM"); await finished; throw new Error("Minimum host free-space guard"); }
      await Bun.sleep(5000);
    }
    const exitCode = await finished;
    closeSync(log);
    const data = existsSync(output) ? JSON.parse(readFileSync(output, "utf8")) : null;
    completed.push({ file: job.file, exitCode, cohorts: data?.cohorts.length ?? 0, failures: data?.failures ?? ["missing results"] });
    state();
    console.log(new Date().toISOString(), "FINISH", current, "exit", exitCode);
    if (exitCode !== 0) throw new Error(`Harness stopped; retain partial results: ${job.file}`);
    if (data.cohorts.some((c: any) => c.operations.some((op: any) => op.exitCode === 0 && (!op.verified || op.error)))) {
      throw new Error(`Correctness/native/private-write gate failed: ${job.file}`);
    }
  }
  phase = "finished"; childPid = null; state();
} catch (error) {
  phase = "failed"; state({ error: String(error) }); throw error;
}

import { expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { parse } from "../lib/config.ts";
import { campaign } from "../lib/campaign.ts";
import { allocate, digest } from "../lib/results.ts";
import { environment, execute } from "../lib/process.ts";
import { plan, verify } from "../suites/checkout.ts";

async function scratch() {
  return mkdtemp(join(tmpdir(), "twig-runner-test-"));
}

test("selectors reject unknowns, duplicates, bad budgets and traversal", () => {
  const base = [
    "--target",
    "linux-xfs",
    "--baseline",
    "/baseline",
    "--environment",
    "owned test lab",
  ];
  expect(() => parse(base.slice(0, 4), "/repo")).toThrow("--environment");
  expect(parse(base, "/repo").candidate).toBe("/repo/target/release/git-twig");
  for (const extra of [
    ["--profiles", "byte-heavy,byte-heavy"],
    ["--rounds", "0"],
    ["--max-concurrency", "129"],
    ["--minimum-free-gib", "0"],
    ["--minimum-free-gib", "1.5"],
    ["--wat", "1"],
    ["--rounds", "1", "--rounds", "2"],
    ["--candidate-commit", "abc"],
  ])
    expect(() => parse([...base, ...extra], "/repo")).toThrow();
  expect(() =>
    parse(["--target", "../../escape", "--baseline", "x"], "/repo"),
  ).toThrow();
});
test("APFS targets preserve their distinct worker filesystems", () => {
  for (const [target, filesystem] of [
    ["macos-apfs", "isolated-image"],
    ["macos-apfs-case-sensitive", "case-sensitive-image"],
  ] as const) {
    const config = parse(
      [
        "--target",
        target!,
        "--baseline",
        "/baseline",
        "--environment",
        "owned Mac",
        "--minimum-free-gib",
        "128",
      ],
      "/repo",
    );
    expect(config.target.os).toBe("darwin");
    expect(config.target.workerFilesystem).toBe(filesystem);
    expect(config.minimumFreeGiB).toBe(128);
    const { raw, expected } = valid();
    raw.filesystem = filesystem!;
    expected.filesystem = filesystem!;
    expect(verify(raw, expected)).toBe(true);
    expected.filesystem = "wrong-image";
    expect(() => verify(raw, expected)).toThrow();
  }
});
test("Python reporting caches cannot dirty a measured checkout", () => {
  const path = "bench/__pycache__/coverage_snapshot.cpython-313.pyc";
  const root = new URL("../../", import.meta.url);
  expect(
    execFileSync("git", ["check-ignore", "--stdin"], {
      cwd: root,
      env: environment(),
      input: path + "\n",
      encoding: "utf8",
    }).trim(),
  ).toBe(path);
});
test("three rounds rotate each variant through each position", () => {
  const points = plan(["byte-heavy"], 3, 16);
  for (let position = 0; position < 3; position++)
    expect(
      new Set([0, 1, 2].map((r) => points[r * 3 + position]!.backend)).size,
    ).toBe(3);
  expect(plan(["file-heavy"], 1, 16).map((p) => p.concurrency)).toEqual([
    1, 1, 1, 4, 4, 4, 16, 16, 16,
  ]);
});
test("environment isolation never mutates the caller", () => {
  const parent = {
    GIT_DIR: "evil",
    GIT_CONFIG_KEY_0: "evil",
    GIT_TRACE2_EVENT: "private",
    HOME: "/home/test",
  };
  const env = environment(parent);
  expect(env.GIT_DIR).toBeUndefined();
  expect(env.GIT_CONFIG_KEY_0).toBeUndefined();
  expect(env.GIT_TRACE2_EVENT).toBeUndefined();
  expect(env.HOME).toBe(parent.HOME);
  expect(parent.GIT_DIR).toBe("evil");
});
test("exclusive automatic allocation cannot overwrite another same-time run", async () => {
  const root = await scratch();
  const date = new Date("2026-11-17T00:00:00Z");
  const first = await allocate(root, "a".repeat(64), "linux-xfs", date);
  const second = await allocate(root, "a".repeat(64), "linux-xfs", date);
  expect(second).not.toBe(first);
  expect(first).toContain("sha256-aaaaaaaaaaaa/linux-xfs/2026-11-17/run-");
  await expect(allocate(root, "a".repeat(64), "../bad")).rejects.toThrow();
});
function valid() {
  const point = plan(["byte-heavy"], 1, 1)[2]!;
  const fixture = {
    label: "byte-heavy" as const,
    path: "/fixture",
    targetCommit: "b".repeat(40),
    donorCommit: "a".repeat(40),
  };
  const space = {
    stable: true,
    allocatedBytes: 4096,
    totalBytes: 100000,
    observedAllocatedBytes: [4096],
  };
  const raw = {
    schemaVersion: 4,
    dirty: false,
    commit: "harness",
    candidateSha256: "hash",
    filesystem: "linux-xfs-image",
    selectedBackend: "twig",
    requireNative: true,
    concurrency: 1,
    worktreesPerCohort: 2,
    repeats: 1,
    failures: [],
    cohorts: [
      {
        repository: fixture.label,
        backend: "twig",
        repeat: 0,
        createWallMs: 5,
        createsPerSecond: 400,
        harnessCpuMsDuringCreate: 1,
        observerWallMs: 6,
        growthAfterStatusBytes: -4096,
        targetCommit: fixture.targetCommit,
        sourceCommit: fixture.donorCommit,
        sourceUnchanged: true,
        succeeded: 2,
        failed: 0,
        privateWriteTested: true,
        trackedFiles: 3,
        verifiedFiles: 6,
        operations: Array.from({ length: 2 }, () => ({
          verified: true,
          exitCode: 0,
          error: null,
          nativeCow: true,
          verifiedClones: 2,
          createMs: 2,
          firstStatusMs: 1,
        })),
        before: space,
        afterCreate: space,
        afterStatus: space,
        afterPrivateWrites: space,
      },
    ],
  };
  return {
    raw,
    expected: {
      point,
      fixture,
      sha256: "hash",
      commit: "harness",
      filesystem: "linux-xfs-image",
      exploratory: false,
    },
  };
}
test("verification rejects provenance, corruption, missing clones and wrong configuration", () => {
  expect(verify(valid().raw, valid().expected)).toBe(true);
  const mutations = [
    (r: any) => (r.dirty = true),
    (r: any) => (r.commit = "wrong"),
    (r: any) => (r.candidateSha256 = "wrong"),
    (r: any) => (r.filesystem = "linux-btrfs-image"),
    (r: any) => (r.concurrency = 4),
    (r: any) => (r.cohorts[0].sourceUnchanged = false),
    (r: any) => (r.cohorts[0].targetCommit = "wrong"),
    (r: any) => r.cohorts[0].verifiedFiles--,
    (r: any) => r.cohorts[0].operations.pop(),
    (r: any) => (r.cohorts[0].operations[0].verifiedClones = 0),
    (r: any) => (r.cohorts[0].operations[0].verified = false),
  ];
  for (const mutate of mutations) {
    const { raw, expected } = valid();
    mutate(raw);
    expect(() => verify(raw, expected)).toThrow();
  }
  const { raw, expected } = valid();
  raw.cohorts[0]!.before.stable = false;
  expect(verify(raw, expected)).toBe(false);
});
test("a timeout kills owned descendants even after their leader exits", async () => {
  const root = await scratch();
  const script = `const {spawn}=require('node:child_process');const fs=require('node:fs');const c=spawn(process.execPath,['-e',\"process.on('SIGTERM',()=>{});setInterval(()=>{},100)\"],{stdio:'ignore'});fs.writeFileSync(${JSON.stringify(join(root, "pid"))},String(c.pid));setInterval(()=>{},100);`;
  const outcome = await execute([process.execPath, "-e", script], {
    cwd: root,
    stdout: join(root, "out"),
    stderr: join(root, "err"),
    timeoutMs: 500,
    graceMs: 50,
  });
  expect(outcome.termination).toBe("timeout");
  const pid = Number(await readFile(join(root, "pid"), "utf8"));
  // An orphan can briefly remain as a zombie until the OS reaps it; it must not execute.
  for (let attempt = 0; attempt < 100; attempt++) {
    // /proc does not exist on macOS: ENOENT there never proved child termination.
    const inspection = spawnSync(
      "/bin/ps",
      ["-o", "stat=", "-p", String(pid)],
      {
        encoding: "utf8",
      },
    );
    if (inspection.error) throw inspection.error;
    if (inspection.status === 1 && inspection.stdout.trim() === "") return;
    expect(inspection.status).toBe(0);
    if (inspection.stdout.trim().startsWith("Z")) return;
    await Bun.sleep(10);
  }
  throw new Error("Owned descendant still executing after KILL");
});
test("absolute remaining deadline wins over the configured point limit", async () => {
  const root = await scratch();
  const outcome = await execute(
    [process.execPath, "-e", "setInterval(()=>{},100)"],
    {
      cwd: root,
      stdout: join(root, "out"),
      stderr: join(root, "err"),
      timeoutMs: 10000,
      deadlineMs: performance.now() + 50,
      graceMs: 10,
    },
  );
  expect(outcome.termination).toBe("timeout");
  expect(outcome.timeoutMs).toBeLessThanOrEqual(50);
});

test("spawn errors retain diagnostics and do not wait for a whole point budget", async () => {
  const root = await scratch();
  await expect(
    execute([join(root, "missing")], {
      cwd: root,
      stdout: join(root, "out"),
      stderr: join(root, "err"),
      timeoutMs: 10000,
    }),
  ).rejects.toThrow();
  expect(await readFile(join(root, "out"), "utf8")).toBe("");
});

async function fakeLab(mode: "pass" | "fail" | "hang" | "mutate") {
  const root = await scratch(),
    bin = join(root, "target/release");
  await mkdir(bin, { recursive: true });
  execFileSync("git", ["init", "-q"], { cwd: root, env: environment() });
  execFileSync(
    "git",
    [
      "-c",
      "user.name=fixture",
      "-c",
      "user.email=fixture@example.invalid",
      "commit",
      "-q",
      "--allow-empty",
      "-m",
      "test",
    ],
    { cwd: root, env: environment() },
  );
  await writeFile(join(bin, "git-twig"), "candidate");
  await writeFile(join(root, "baseline"), "baseline");
  await writeFile(join(bin, "twig-fixture"), "fixture");
  const executable = async (name: string, code: string) =>
    writeFile(join(bin, name), `#!${process.execPath}\n${code}`, {
      mode: 0o755,
    });
  await executable(
    "twig-coverage-fixture",
    `import{mkdirSync,writeFileSync}from'node:fs';const p=process.argv[2];mkdirSync(p);writeFileSync(p+'/fixtures.json',JSON.stringify([{label:'byte-heavy',path:p,targetCommit:'${"b".repeat(40)}',donorCommit:null}]));`,
  );
  await executable(
    "twig-real-bench",
    `import{writeFileSync,readFileSync}from'node:fs';import{createHash}from'node:crypto';import{execFileSync}from'node:child_process';const a=process.argv.slice(2);const get=k=>a[a.indexOf(k)+1];const native=get('--require-native')==='true';
if(${JSON.stringify(mode)}==='fail'&&get('--candidate').endsWith('baseline'))process.exit(42);
if(${JSON.stringify(mode)}==='hang')await new Promise(()=>setInterval(()=>{},100));
const sha=createHash('sha256').update(readFileSync(get('--candidate'))).digest('hex');
if(${JSON.stringify(mode)}==='mutate')writeFileSync(get('--candidate'),'changed');
const s={stable:true,allocatedBytes:4096,totalBytes:100000,observedAllocatedBytes:[4096]};writeFileSync(get('--output'),JSON.stringify({schemaVersion:4,dirty:true,commit:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),candidateSha256:sha,filesystem:get('--filesystem'),concurrency:1,worktreesPerCohort:2,repeats:1,selectedBackend:get('--backend'),requireNative:native,failures:[],cohorts:[{repository:'byte-heavy',backend:get('--backend'),repeat:0,createWallMs:5,createsPerSecond:400,harnessCpuMsDuringCreate:1,observerWallMs:6,growthAfterStatusBytes:4096,sourceCommit:'${"b".repeat(40)}',targetCommit:'${"b".repeat(40)}',succeeded:2,failed:0,trackedFiles:1,verifiedFiles:2,sourceUnchanged:true,privateWriteTested:true,before:s,afterCreate:s,afterStatus:s,afterPrivateWrites:s,operations:[0,1].map(()=>({verified:true,exitCode:0,error:null,nativeCow:native,verifiedClones:native?1:0,createMs:2,firstStatusMs:1}))}]}));`,
  );
  const config = parse(
    [
      "--target",
      process.platform === "darwin" ? "macos-apfs" : "linux-xfs",
      "--baseline",
      "baseline",
      "--profiles",
      "byte-heavy",
      "--rounds",
      "1",
      "--exploratory",
      "--budget-seconds",
      "5",
      "--minimum-free-gib",
      "1",
    ],
    root,
  );
  return { root, config };
}
// Fake workers exercise the local OS adapter; real filesystem claims require
// the separately gated native-image measurements.
const campaignTest = test;
test("free-space guard retains a failed manifest without launching preparation", async () => {
  const { root, config } = await fakeLab("pass");
  config.minimumFreeGiB = 1048576;
  const path = await campaign(root, config, new AbortController().signal);
  const manifest = JSON.parse(await readFile(path, "utf8"));
  expect(manifest.status).toBe("failed");
  expect(manifest.points).toEqual([]);
  expect(manifest.stopReason).toContain("Free disk");
  await expect(
    readFile(join(path, "../prepare.log"), "utf8"),
  ).rejects.toThrow();
});
for (const mode of ["pass", "fail", "mutate"] as const)
  campaignTest(
    `end-to-end fake worker ${mode} preserves results without retry`,
    async () => {
      const { root, config } = await fakeLab(mode);
      const manifestPath = await campaign(
        root,
        config,
        new AbortController().signal,
      );
      const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
      expect(manifest.status).toBe(mode === "pass" ? "completed" : "failed");
      expect(manifest.points.length).toBe(
        mode === "pass" ? 3 : mode === "fail" ? 2 : 1,
      );
      expect(
        manifest.points.every((p: any) => p.finishedElapsedMs !== null),
      ).toBe(true);
      expect(manifest.candidate.sha256).toBe(
        mode === "mutate"
          ? manifest.candidate.sha256
          : await digest(config.candidate),
      );
    },
  );
campaignTest(
  "pending point is durable before interruption; remaining deadline is recorded",
  async () => {
    const { root, config } = await fakeLab("hang");
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 400);
    const path = await campaign(root, config, controller.signal);
    clearTimeout(timer);
    const manifest = JSON.parse(await readFile(path, "utf8"));
    expect(manifest.status).toBe("interrupted");
    expect(manifest.points.length).toBe(1);
    expect(manifest.points[0].verified).toBe(false);
    expect(manifest.points[0].timeoutSeconds).toBeLessThanOrEqual(
      config.budgetSeconds,
    );
  },
  20000,
);

import { execFileSync } from "node:child_process";
import { mkdir, readFile, statfs } from "node:fs/promises";
import { basename, join } from "node:path";
import type { parse } from "./config.ts";
import { environment, execute } from "./process.ts";
import { allocate, digest, invariant, save } from "./results.ts";
import { parseFixtures, plan, verify } from "../suites/checkout.ts";

type Config = ReturnType<typeof parse>;
type State =
  | "preparing"
  | "running"
  | "completed"
  | "failed"
  | "budget-stop"
  | "interrupted";
type Planned = ReturnType<typeof plan>[number];
interface Point extends Planned {
  filesystem: string;
  result: string;
  command: string[];
  startedElapsedMs: number;
  finishedElapsedMs: number | null;
  timeoutSeconds: number;
  deadlineElapsedMs: number;
  exitCode: number | null;
  verified: boolean;
  allocationStable: boolean;
  error: string | null;
  status: State;
}
function git(root: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd: root,
    env: environment(),
    encoding: "utf8",
  }).trim();
}
function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function campaign(
  root: string,
  config: Config,
  signal: AbortSignal,
): Promise<string> {
  invariant(
    process.platform === config.target.os,
    `Target requires ${config.target.os}`,
  );
  const dirty = git(root, ["status", "--porcelain"]).length > 0;
  invariant(
    !dirty || config.exploratory,
    "Commit the harness before measuring, or use --exploratory (not publishable)",
  );
  const commit = git(root, ["rev-parse", "HEAD"]);
  const identities = {
    baseline: {
      label: "frozen-twig",
      sourceCommit: config.baselineCommit,
      sha256: await digest(config.baseline),
    },
    candidate: {
      label: "candidate-twig",
      sourceCommit: config.candidateCommit,
      sha256: await digest(config.candidate),
    },
  };
  const worker = join(config.binaryDir, "twig-real-bench");
  const preparer = join(config.binaryDir, "twig-coverage-fixture");
  const gitPath = execFileSync("sh", ["-c", "command -v git"], {
    cwd: root,
    env: environment(),
    encoding: "utf8",
  }).trim();
  invariant(gitPath.length > 0, "Cannot locate Git executable");
  const frozen = new Map<string, string>();
  for (const file of [
    config.baseline,
    config.candidate,
    worker,
    preparer,
    join(config.binaryDir, "twig-fixture"),
    gitPath,
  ])
    frozen.set(file, await digest(file));
  const output = await allocate(
    join(root, "bench/results"),
    identities.candidate.sha256,
    config.target.name,
  );
  const manifest = {
    schemaVersion: 2,
    generatedAtUnixMs: Date.now(),
    commit,
    dirty,
    exploratory: config.exploratory,
    runtime: process.versions,
    ...identities,
    tools: Object.fromEntries(frozen),
    git: {
      path: gitPath,
      version: git(root, ["--version"]),
      execPath: git(root, ["--exec-path"]),
    },
    config: { ...config, filesystems: [config.target.filesystem] },
    fixtures: [] as {
      label: string;
      targetCommit: string;
      donorCommit: string | null;
    }[],
    notes: [
      "Shared-host warm-cache filesystem-image measurements, not bare-device, host-volume or universal speed claims.",
      "No retries. Complete paired groups only. Rust owns timing, allocation, full byte verification and private-write probes.",
      "Binary source commits are operator declarations; SHA-256 identifies the measured bytes.",
      `Operator-provided environment: ${config.environment}`,
      ...config.target.notes,
    ],
    status: "preparing" as State,
    stopReason: null as string | null,
    points: [] as Point[],
  };
  const manifestPath = join(output, "manifest.json");
  const persist = () => save(manifestPath, manifest);
  const start = performance.now();
  const remaining = () =>
    config.budgetSeconds * 1000 - (performance.now() - start);
  const effective = () =>
    Math.max(0, Math.min(config.pointTimeoutSeconds * 1000, remaining()));
  async function unchanged() {
    const space = await statfs(root);
    const freeGiB = (space.bavail * space.bsize) / 2 ** 30;
    invariant(
      freeGiB >= config.minimumFreeGiB,
      `Free disk ${freeGiB.toFixed(2)} GiB is below ${config.minimumFreeGiB} GiB; no further work launched`,
    );
    invariant(
      git(root, ["rev-parse", "HEAD"]) === commit &&
        (config.exploratory || git(root, ["status", "--porcelain"]) === ""),
      "Harness checkout changed",
    );
    for (const [file, hash] of frozen)
      invariant((await digest(file)) === hash, `Executable changed: ${file}`);
  }
  await persist();
  console.log(`results: ${output}`);
  try {
    await unchanged();
    const scratchParent = join(root, "target/bench-fixtures");
    await mkdir(scratchParent, { recursive: true });
    const scratch = join(scratchParent, basename(output));
    const preparation = [preparer, scratch];
    await save(join(output, "preparation.json"), {
      command: preparation,
      timeoutSeconds: remaining() / 1000,
    });
    const prepared = await execute(preparation, {
      cwd: root,
      stdout: join(output, "prepare.log"),
      stderr: join(output, "prepare.stderr.log"),
      timeoutMs: remaining(),
      signal,
    });
    invariant(
      prepared.termination === "exited" && prepared.exitCode === 0,
      `Preparation ${prepared.termination}, exit ${prepared.exitCode}`,
    );
    const fixtures = parseFixtures(
      JSON.parse(await readFile(join(scratch, "fixtures.json"), "utf8")),
    );
    manifest.fixtures = fixtures
      .filter((f) => config.profiles.includes(f.label))
      .map(({ path: _, ...f }) => f);
    invariant(
      manifest.fixtures.length === config.profiles.length,
      "Missing selected fixtures",
    );
    manifest.status = "running";
    await persist();
    for (const item of plan(
      config.profiles,
      config.rounds,
      config.maxConcurrency,
    )) {
      if (signal.aborted || effective() < 1) {
        manifest.status = signal.aborted ? "interrupted" : "budget-stop";
        manifest.stopReason = "Remaining points unmeasured";
        break;
      }
      await unchanged();
      const fixture = fixtures.find((f) => f.label === item.profile)!;
      const binary =
        item.backend === "baseline" ? config.baseline : config.candidate;
      const filename = `${config.target.filesystem}-${item.profile}-c${item.concurrency}-r${item.round}-${item.backend}.json`;
      const args = [
        worker,
        "--filesystem",
        config.target.workerFilesystem,
        "--repo",
        `${fixture.label}=${fixture.path}`,
        "--revision",
        `${fixture.label}=${fixture.targetCommit}`,
        "--backend",
        item.backend === "git" ? "git" : "twig",
        "--require-native",
        String(item.backend === "candidate"),
        "--repeats",
        "1",
        "--concurrency",
        String(item.concurrency),
        "--worktrees",
        String(item.worktrees),
        "--image-gib",
        String(config.target.imageGib),
        "--candidate",
        binary,
        "--output",
        join(output, filename),
        "--note",
        `Checkout campaign round ${item.round}, ${item.backend}; adjacent manifest.json records provenance and effective budgets.`,
      ];
      if (fixture.donorCommit)
        args.push(
          "--donor-revision",
          `${fixture.label}=${fixture.donorCommit}`,
        );
      const point: Point = {
        ...item,
        filesystem: config.target.filesystem,
        result: filename,
        command: args,
        startedElapsedMs: performance.now() - start,
        finishedElapsedMs: null,
        timeoutSeconds: effective() / 1000,
        deadlineElapsedMs: Math.min(
          config.budgetSeconds * 1000,
          performance.now() - start + effective(),
        ),
        status: "running",
        exitCode: null,
        verified: false,
        allocationStable: false,
        error: null,
      };
      manifest.points.push(point);
      await persist(); // Pending point survives an abruptly killed supervisor.
      console.log(
        `${manifest.points.length}: ${config.target.name} / ${item.profile} / c${item.concurrency} / r${item.round} / ${item.backend}`,
      );
      try {
        // The persisted absolute monotonic deadline includes launch/persistence overhead.

        const outcome = await execute(args, {
          cwd: root,
          stdout: join(output, filename + ".log"),
          stderr: join(output, filename + ".stderr.log"),
          timeoutMs: point.timeoutSeconds * 1000,
          deadlineMs: start + point.deadlineElapsedMs,
          signal,
        });
        point.timeoutSeconds = outcome.timeoutMs / 1000;
        point.exitCode = outcome.exitCode;
        if (outcome.termination !== "exited") {
          point.status =
            outcome.termination === "timeout" ? "budget-stop" : "interrupted";
          throw new Error(`Point ${outcome.termination}; no retry`);
        }
        invariant(
          outcome.exitCode === 0,
          `Process exit ${outcome.exitCode} / ${outcome.signal}`,
        );
        await unchanged();
        point.allocationStable = verify(
          JSON.parse(await readFile(join(output, filename), "utf8")),
          {
            point: item,
            fixture,
            sha256:
              identities[item.backend === "baseline" ? "baseline" : "candidate"]
                .sha256,
            commit,
            filesystem: config.target.workerFilesystem,
            exploratory: config.exploratory,
          },
        );
        point.verified = true;
        point.status = "completed";
      } catch (error) {
        point.error = errorText(error);
        if (point.status === "running") point.status = "failed";
        manifest.status = point.status;
        manifest.stopReason = point.error;
      }
      point.finishedElapsedMs = performance.now() - start;
      await persist();
      if (!point.verified) break;
    }
    if (manifest.status === "running") manifest.status = "completed";
  } catch (error) {
    manifest.status = signal.aborted
      ? "interrupted"
      : remaining() <= 0
        ? "budget-stop"
        : "failed";
    manifest.stopReason = errorText(error);
  }
  await persist();
  console.log(`${manifest.status}: ${manifestPath}`);
  return manifestPath;
}

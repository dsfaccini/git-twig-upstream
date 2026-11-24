import { globSync } from "node:fs";
import { readFile, writeFile, rename, statfs } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { run } from "./real.ts";
import { parseInputs } from "./lib/real-results.ts";
import { digest, invariant, list, record, string } from "./lib/results.ts";

const root = fileURLToPath(new URL("../", import.meta.url));
const gib = 1024 ** 3;
export function classifyAttempt(
  exitCode: number,
  manifest: Record<string, unknown>,
): "accepted" | "retry-allocation" | "terminal" {
  const jobs = list(manifest.jobs).map(record);
  invariant(jobs.length === 1, "Unexpected job inventory");
  const job = jobs[0]!;
  if (
    exitCode === 0 &&
    manifest.status === "completed" &&
    job.status === "completed" &&
    job.verified === true &&
    job.allocationComparable === true
  )
    return "accepted";
  if (
    exitCode === 1 &&
    manifest.status === "failed" &&
    job.status === "failed" &&
    job.verified === true &&
    job.allocationComparable === false &&
    String(manifest.stopReason).includes("Allocation did not settle")
  )
    return "retry-allocation";
  return "terminal";
}
export async function stableCampaign(configFile: string) {
  const config = record(JSON.parse(await readFile(configFile, "utf8"))),
    lab = resolve(string(config.lab));
  invariant(
    config.schemaVersion === 1,
    "Unknown stable-campaign configuration",
  );
  const inputs = parseInputs(
    JSON.parse(await readFile(string(config.inputs), "utf8")),
  );
  const targets = list(config.targets).map(string);
  invariant(
    targets.length > 0 &&
      new Set(targets).size === targets.length &&
      targets.every((t) =>
        ["linux-xfs", "linux-btrfs", "macos-apfs-case-sensitive"].includes(t),
      ),
    "Invalid stability targets",
  );
  const candidate = resolve(string(config.candidate)),
    bin = resolve(string(config.binaryDir));
  const candidateSha256 = await digest(candidate),
    start = performance.now(),
    budgetSeconds = 21600;
  const free = async () => {
    const s = await statfs(root);
    return Number(s.bavail) * Number(s.bsize);
  };
  const initialFree = await free();
  const state = {
    schemaVersion: 1,
    kind: "first-stable-complete-paired-jobs",
    candidateSha256,
    source: string(config.sourceCommit),
    budgetSeconds,
    maximumAttemptsPerRepository: 3,
    minimumFreeGiB: 128,
    maximumGrowthGiB: 160,
    status: "running",
    attempts: [] as Record<string, unknown>[],
    accepted: [] as Record<string, unknown>[],
    error: null as string | null,
  };
  await writeFile(
    join(lab, "stable-plan.json"),
    JSON.stringify(
      {
        ...state,
        config,
        driverSha256: await digest(fileURLToPath(import.meta.url)),
      },
      null,
      2,
    ) + "\n",
    { flag: "wx" },
  );
  const persist = async () => {
    const tmp = join(lab, "stable-state.tmp");
    await writeFile(tmp, JSON.stringify(state, null, 2) + "\n");
    await rename(tmp, join(lab, "stable-state.json"));
  };
  const guard = async () => {
    const available = await free();
    invariant(
      available >= 128 * gib && initialFree - available <= 160 * gib,
      "Platform-wide disk guard",
    );
    invariant(
      (performance.now() - start) / 1000 < budgetSeconds,
      "Platform-wide campaign deadline",
    );
  };
  try {
    for (const target of targets)
      for (const input of inputs) {
        const inputFile = join(lab, `inputs-${target}-${input.label}.json`);
        await writeFile(
          inputFile,
          JSON.stringify({ schemaVersion: 1, repositories: [input] }, null, 2) +
            "\n",
          { flag: "wx" },
        );
        let accepted = false;
        for (let attempt = 1; attempt <= 3 && !accepted; attempt++) {
          await guard();
          const pattern = `bench/results/sha256-${candidateSha256.slice(0, 12)}/${target}/*/run-*/manifest.json`;
          const before = new Set(globSync(pattern, { cwd: root }));
          const remaining = Math.floor(
            budgetSeconds - (performance.now() - start) / 1000,
          );
          console.log("attempt", target, input.label, attempt);
          const exitCode = await run([
            "--target",
            target,
            "--candidate",
            candidate,
            "--candidate-commit",
            string(config.releaseCommit),
            "--binary-dir",
            bin,
            "--inputs",
            inputFile,
            "--environment",
            string(config.environment),
            "--budget-seconds",
            String(remaining),
            "--point-timeout-seconds",
            String(Math.min(7200, remaining)),
            "--minimum-free-gib",
            "128",
            "--max-growth-gib",
            "160",
          ]);
          const added = globSync(pattern, { cwd: root }).filter(
            (p) => !before.has(p),
          );
          invariant(
            added.length === 1,
            "Attempt did not produce exactly one immutable campaign",
          );
          const manifestPath = added[0]!,
            manifest = record(
              JSON.parse(await readFile(join(root, manifestPath), "utf8")),
            );
          invariant(
            manifest.commit === state.source,
            "Unfrozen source changed during campaign",
          );
          const jobs = list(manifest.jobs).map(record);
          invariant(jobs.length === 1, "Unexpected job inventory");
          const verdict = classifyAttempt(exitCode, manifest);
          accepted = verdict === "accepted";
          const observation = {
            target,
            repository: input.label,
            attempt,
            manifest: manifestPath,
            accepted,
            stopReason: manifest.stopReason,
          };
          state.attempts.push(observation);
          if (accepted) state.accepted.push(observation);
          await persist();
          await guard();
          if (!accepted)
            invariant(
              verdict === "retry-allocation",
              "Non-allocation failure is terminal; do not retry correctness errors or interruptions",
            );
        }
        invariant(
          accepted,
          "Three retained whole-job attempts did not settle; diagnose before another campaign",
        );
      }
    state.status = "completed";
  } catch (error) {
    state.status = "failed";
    state.error = String(error);
    throw error;
  } finally {
    await persist();
    console.log(state.status, join(lab, "stable-state.json"));
  }
  return state;
}
if (import.meta.main) await stableCampaign(process.argv[2]!);

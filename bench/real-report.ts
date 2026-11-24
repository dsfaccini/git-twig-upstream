import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { digest, invariant, list, record, string } from "./lib/results.ts";
import { parseInputs, parseReal, summarizeReal } from "./lib/real-results.ts";
import { formatBytes } from "./lib/units.ts";

const root = fileURLToPath(new URL("../", import.meta.url));
function path(value: unknown) {
  const name = string(value),
    full = resolve(root, name);
  invariant(
    full.startsWith(resolve(root, "bench/results") + "/"),
    "Result path escapes archive",
  );
  return full;
}
async function json(name: unknown) {
  return JSON.parse(await readFile(path(name), "utf8"));
}
function csv(rows: Record<string, unknown>[]) {
  const columns = Object.keys(rows[0]!);
  const cell = (v: unknown) => {
    const s = v === null ? "unmeasured" : String(v);
    return /[,"\n\r]/.test(s) ? '"' + s.replaceAll('"', '""') + '"' : s;
  };
  return (
    [
      columns.join(","),
      ...rows.map((row) => columns.map((key) => cell(row[key])).join(",")),
    ].join("\n") + "\n"
  );
}
export async function report(captureName: string, check = false) {
  const capture = record(await json(captureName));
  invariant(
    capture.schemaVersion === 1 && capture.release === "v0.5.0",
    "Unsupported release capture",
  );
  const pins = parseInputs({
    schemaVersion: 1,
    repositories: list(capture.inputs).map((v) => ({
      ...record(v),
      path: "/retained-input",
    })),
  });
  const seen = new Set<string>();
  let creates = 0,
    cohortCount = 0,
    interrupted = 0;
  const reported = [];
  for (const value of list(capture.observations)) {
    const entry = record(value),
      file = string(entry.file),
      manifest = record(await json(entry.manifest)),
      config = record(manifest.config),
      candidate = record(manifest.candidate);
    invariant(
      (await digest(path(file))) === entry.sha256,
      "Original result hash differs",
    );
    invariant(
      candidate.version === "git-twig 0.5.0" &&
        candidate.sourceCommit === capture.releaseCommit,
      "Wrong published release identity",
    );
    const release = record(
      record(capture.candidateHashes)[string(config.target)],
    );
    invariant(
      candidate.sha256 === release.sha256,
      "Candidate is not the frozen published binary",
    );
    const raw = record(await json(file)),
      input = pins.find((p) => p.label === entry.repository);
    invariant(
      input && entry.target === config.target,
      "Unknown repository/target",
    );
    const key = String(entry.target) + ":" + input.label;
    invariant(!seen.has(key), "Repeated measurement in capture");
    seen.add(key);
    const job = list(manifest.jobs)
      .map(record)
      .find((j) => j.repository === input.label);
    invariant(
      job && file.endsWith("/" + job.file),
      "Result not owned by recorded campaign",
    );
    if (entry.status === "interrupted") {
      const stop = record(await json(entry.interruption));
      invariant(
        stop.originalManifestSha256 === (await digest(path(entry.manifest))),
        "Missing immutable interruption evidence",
      );
      invariant(
        record(stop.containerState).Running === false,
        "Interrupted environment is still active",
      );
      invariant(
        list(raw.cohorts).length < 6,
        "Unexpected complete result marked partial",
      );
      interrupted++;
      continue;
    }
    invariant(entry.status === "verified", "Unknown observation status");
    if (job.verified !== true) {
      const qualification = record(await json(entry.qualification));
      invariant(
        qualification.verified === true &&
          qualification.originalResultSha256 === entry.sha256 &&
          job.exitCode === 0,
        "Unqualified gate failure",
      );
    }
    const cohorts = parseReal(raw, {
      commit: string(manifest.commit),
      sha256: string(candidate.sha256),
      filesystem: string(config.filesystem),
      input,
      rounds: 3,
      longAllocationWindow: capture.longAllocationWindow === true,
    });
    if (capture.longAllocationWindow === true)
      invariant(
        cohorts.every((c) => c.allocationStable),
        "Unsettled allocation cannot enter the stable release capture",
      );
    for (const c of list(raw.cohorts).map(record)) {
      let finished = 0;
      for (const op of list(c.operations)
        .map(record)
        .sort(
          (a, b) => Number(a.createStartedAtMs) - Number(b.createStartedAtMs),
        )) {
        invariant(
          typeof op.createStartedAtMs === "number" &&
            typeof op.createFinishedAtMs === "number" &&
            Number.isFinite(op.createStartedAtMs) &&
            Number.isFinite(op.createFinishedAtMs) &&
            op.createStartedAtMs + 1e-6 >= finished &&
            op.createFinishedAtMs >= op.createStartedAtMs,
          "Nonsequential or invalid creation intervals",
        );
        finished = op.createFinishedAtMs;
      }
    }
    const summary = summarizeReal(cohorts),
      allocationComparable = cohorts.every((c) => c.allocationStable);
    const document = {
      schemaVersion: 1,
      target: entry.target,
      repository: input.label,
      release: "v0.5.0",
      rawSha256: entry.sha256,
      worktreesPerCohort: input.worktrees,
      concurrency: 1,
      pairedRounds: 3,
      warmup: true,
      allocationComparable,
      ...(capture.longAllocationWindow === true
        ? {
            allocationDisplay: summary.map((row) => ({
              backend: row.backend,
              label: formatBytes(row.allocationMedianBytes),
            })),
          }
        : {}),
      summary,
    };
    const prefix = path(file).slice(0, -5);
    for (const [name, contents] of [
      [prefix + ".report.json", JSON.stringify(document, null, 2) + "\n"],
      [prefix + ".csv", csv(summary)],
    ]) {
      if (check)
        invariant(
          (await readFile(name!, "utf8")) === contents,
          "Derived report differs: " + name,
        );
      else await writeFile(name!, contents!, { flag: "wx" });
    }
    creates += cohorts.reduce((n, c) => n + c.operations.length, 0);
    cohortCount += cohorts.length;
    reported.push({
      target: entry.target,
      repository: input.label,
      creates: cohorts.reduce((n, c) => n + c.operations.length, 0),
      allocationComparable,
    });
  }
  invariant(
    creates === capture.verifiedCreates &&
      cohortCount === capture.verifiedCohorts &&
      interrupted === capture.interruptedResults,
    "Capture totals differ",
  );
  return { creates, cohorts: cohortCount, interrupted, reported };
}
if (import.meta.main) {
  const args = process.argv.slice(2),
    check = args[0] === "--check";
  console.log(await report(args[check ? 1 : 0]!, check));
}

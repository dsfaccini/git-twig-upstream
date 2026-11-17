import { resolve } from "node:path";
import { invariant } from "./results.ts";
import xfs from "../linux-xfs/target.ts";
import btrfs from "../linux-btrfs/target.ts";
import { profiles, type Fixture } from "../suites/checkout.ts";

export const targets = [xfs, btrfs];
export interface Config {
  target: (typeof targets)[number];
  baseline: string;
  candidate: string;
  baselineCommit: string | null;
  candidateCommit: string | null;
  binaryDir: string;
  rounds: number;
  maxConcurrency: number;
  budgetSeconds: number;
  pointTimeoutSeconds: number;
  profiles: Fixture["label"][];
  exploratory: boolean;
  environment: string;
}
export function parse(args: string[], cwd: string): Config {
  const values = new Map<string, string>();
  let exploratory = false;
  const allowed = [
    "target",
    "suite",
    "baseline",
    "candidate",
    "baseline-commit",
    "candidate-commit",
    "binary-dir",
    "rounds",
    "max-concurrency",
    "budget-seconds",
    "point-timeout-seconds",
    "profiles",
    "environment",
  ];
  for (let i = 0; i < args.length; i++) {
    const key = args[i]!;
    if (key === "--exploratory") {
      invariant(!exploratory, "Duplicate --exploratory");
      exploratory = true;
      continue;
    }
    invariant(
      key.startsWith("--") && allowed.includes(key.slice(2)),
      `Unknown option ${key}`,
    );
    invariant(!values.has(key), `Duplicate option ${key}`);
    const value = args[++i];
    invariant(value && !value.startsWith("--"), `Missing value for ${key}`);
    values.set(key, value);
  }
  const value = (key: string, fallback?: string) =>
    values.get("--" + key) ?? fallback;
  const target = targets.find((t) => t.name === value("target"));
  invariant(target, "--target must be linux-xfs or linux-btrfs");
  invariant(value("suite", "checkout") === "checkout", "Unknown suite");
  invariant(value("baseline"), "--baseline is required");
  invariant(
    exploratory || value("environment")?.trim(),
    "--environment is required unless --exploratory is set",
  );
  function integer(key: string, fallback: number, max: number) {
    const text = value(key, String(fallback))!;
    invariant(/^[1-9][0-9]*$/.test(text), `Invalid --${key}`);
    const n = Number(text);
    invariant(Number.isSafeInteger(n) && n <= max, `Invalid --${key}`);
    return n;
  }
  function commit(key: string) {
    const text = value(key);
    invariant(
      text === undefined || /^([a-f0-9]{40}|[a-f0-9]{64})$/.test(text),
      `Invalid --${key}`,
    );
    return text ?? null;
  }
  const selected = value("profiles", profiles.join(","))!.split(",");
  invariant(
    selected.length > 0 &&
      selected.every((p) => profiles.includes(p as Fixture["label"])) &&
      new Set(selected).size === selected.length,
    "Unknown or duplicate profiles",
  );
  const binaryDir = resolve(cwd, value("binary-dir", "target/release")!);
  return {
    target,
    baseline: resolve(cwd, value("baseline")!),
    candidate: resolve(cwd, value("candidate", binaryDir + "/git-twig")!),
    binaryDir,
    baselineCommit: commit("baseline-commit"),
    candidateCommit: commit("candidate-commit"),
    rounds: integer("rounds", 3, 100),
    maxConcurrency: integer("max-concurrency", 16, 128),
    budgetSeconds: integer("budget-seconds", 1800, 86400),
    pointTimeoutSeconds: integer("point-timeout-seconds", 180, 86400),
    profiles: selected as Fixture["label"][],
    exploratory,
    environment: value(
      "environment",
      "unspecified backing storage; exploratory environment",
    )!,
  };
}

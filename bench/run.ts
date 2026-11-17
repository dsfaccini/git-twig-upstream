import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { readFile } from "node:fs/promises";
import { parse, targets } from "./lib/config.ts";
import { campaign } from "./lib/campaign.ts";
import { invariant } from "./lib/results.ts";

const help = `Usage:
  bun bench/run.ts list
  bun bench/run.ts run --target linux-xfs --suite checkout --baseline FROZEN_TWIG [options]

Options:
  --candidate PATH             default target/release/git-twig
  --binary-dir PATH            Rust worker/fixture directory (default target/release)
  --baseline-commit FULL_OID    optional operator-declared source identity
  --candidate-commit FULL_OID   optional operator-declared source identity
  --profiles comma,list        default all six checkout profiles
  --rounds N                   default 3
  --max-concurrency N          default 16, maximum 128
  --budget-seconds N           default 1800, includes preparation
  --point-timeout-seconds N    default 180, capped by remaining budget
  --minimum-free-gib N         default 16, checked before preparation and each point
  --environment TEXT           required lab/backing storage description unless exploratory
  --exploratory                allow dirty checkout; never publishable

Results: bench/results/sha256-<candidate>/<os-fs>/<UTC-date>/run-<time>/
Fixtures/images stay under ignored target/. Nothing is pushed or deployed.
`;

export async function main(args: string[]): Promise<number> {
  if (args.length === 0 || args.includes("--help")) {
    console.log(help);
    return 0;
  }
  const [command, ...rest] = args;
  if (command === "list") {
    invariant(rest.length === 0, "list takes no arguments");
    for (const target of targets) console.log(`${target.name}\tcheckout`);
    return 0;
  }
  invariant(command === "run", "Expected list or run; use --help");
  const root = fileURLToPath(new URL("../", import.meta.url));
  const config = parse(rest, root);
  const controller = new AbortController();
  const interrupt = () => controller.abort();
  process.on("SIGINT", interrupt);
  process.on("SIGTERM", interrupt);
  try {
    const manifest = await campaign(resolve(root), config, controller.signal);
    const status = JSON.parse(await readFile(manifest, "utf8")).status;
    return status === "completed" ? 0 : status === "interrupted" ? 130 : 1;
  } finally {
    process.off("SIGINT", interrupt);
    process.off("SIGTERM", interrupt);
  }
}
if (import.meta.main) {
  try {
    process.exitCode = await main(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}

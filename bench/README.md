# Local CLI benchmarks

## Typed campaigns and result archives

Use Bun 1.3+ to select a target and suite. Targets are small typed modules under
`bench/{os}-{fs}/`; scheduling and provenance live in `lib/`, workload plans in
`suites/`. Rust workers retain timing, allocation, full raw-byte verification and
private-write checks. The first orchestrated suite is Linux `checkout` on XFS and
Btrfs; other existing measurement tools below remain independently usable.

```sh
bun install --cwd bench --frozen-lockfile
bun bench/run.ts list
bun bench/run.ts run --target linux-xfs --suite checkout \
  --baseline target/baselines/870f52e/git-twig \
  --profiles cross-revision,mixed-builtins --rounds 1 --max-concurrency 1 \
  --budget-seconds 300 --environment 'owned lab, ext4-backed loopback images'
bun test bench/tests
bun run --cwd bench typecheck
```

Build release workers first with `cargo build --release --workspace --locked`.
See [Linux setup and safety constraints](linux.md). Commit the harness before
measuring. `--exploratory` explicitly permits a dirty checkout, not a publishable
run. The runner never infers a candidate commit from the harness checkout:
optional full source OIDs are operator declarations; executable SHA-256 is the
identity of the actual measured bytes.

Each campaign gets a new directory automatically:

```text
results/<build>/<os-fs>/<UTC-date>/<campaign>/
  manifest.json                  # identities, plan, pending/final outcomes
  preparation.json               # preparation command and budget
  *.json                         # original Rust measurement results
  *.log                          # stdout/stderr, including failures
```

New builds use `sha256-<12-hex-prefix>` directory names and retain the full hashes
in manifests. Same-time runs get unique IDs and never overwrite an existing run.
In-progress `run-*` directories are ignored so writing results does not dirty the
measured checkout. Promote only reviewed compact data explicitly with `git add -f`;
never add fixtures, images, credentials or verbose private logs. Nothing is pushed,
released or deployed by this runner. Fixture/image data stays under `target/`.

Historical artifacts have been moved without changing their bytes. The archive
[index](results/index.json) records every original path, canonical path and hash;
it also resolves paths embedded inside immutable historical files. `unattributed`
means candidate identity was not recorded; `multi-build` and `linux-mixed` preserve
indivisible comparisons rather than inventing a single build/filesystem identity.
Root `readme.json` selects published comparisons and `readme-details.md` remains
the generated table consumer, not a run. Existing README/site numbers are unchanged.

Adding a target or workload means adding a typed module, registering it, and
extending the plan/result-gate tests—not copying a campaign shell script.
Correctness-only VM runs are not performance campaigns and remain separately
retained under `target/vm-lab/`. Emulation timings are never benchmark evidence.

## Standalone synthetic measurements

For real repositories, 100-way cohorts, and isolated APFS allocation measurements,
see [real-repository benchmarks](real-repositories.md).

Question: does verified APFS cloning reduce real worktree creation **plus first
status** latency versus the installed stock Git? Numeric correctness target:
zero wrong checkouts and zero source mutations. Speed is an open measurement,
not a promise.

```sh
cargo build --release --workspace
cargo run --release -p twig-bench -- --files 64 --bytes 262144 --samples 3 --concurrency 1,2,4 --output target/bench-results/mixed.json
cargo run --release -p twig-bench --bin twig-plot -- target/bench-results/mixed.json
```

Run from the repository root with the release git-twig already built.
The harness creates deterministic pseudo-random, committed fixtures, warms each
backend once, alternates backend order, drives actual CLI subprocesses and retains
all fixtures under target/bench-fixtures. No shell command string interpolation.
Git global/system configuration is disabled for comparability.

Each raw JSON run has schemaVersion, timestamp, source commit/dirty state, Git,
Rust and candidate versions, platform, CPU, full workload configuration and raw
per-operation timings/errors/correctness counters. It is saved after each point.
Report p50/p95/p99/max from those samples; small samples do not support strong
tail claims. Plot files and summary tables are generated from raw JSON only.

First and warm status are timed before full byte verification. Each created file
is verified, then an in-place write must leave the source unchanged and Git must
detect the edit. On macOS the candidate must actually select CoW or the run fails.
In schema v2, all create/status workers join before full-content verification
starts. Batch throughput includes status calls but excludes verification/generator
work; do not confuse it with creation-only throughput. Schema v1 exploratory runs
included verification in batch time and allowed verification CPU to contend with
other creates. Keep them as exploratory data, not headline performance evidence. Warmup/fixture generation are not measured.
Hardware is shared with other local apps; no cold-cache, production or exclusive
physical-storage claim.

Suggested suites:
- byte-heavy: --files 16 --bytes 16777216
- file-heavy: --files 5000 --bytes 1024
- mixed: --files 64 --bytes 262144
- ramp: repeat profiles with --concurrency 1,2,4,8,16,32 until a gate fails
  or disk/host budget requires a stop; record the stopping reason.

Retaining worktrees makes later operations share a growing Git worktree registry.
Order alternates to reduce this bias, not eliminate it. Fixtures may consume many
GiB, especially stock Git copies. Inspect free space first; cleanup is an explicit
separate operation. du and st_blocks cannot establish exclusive APFS usage.

Commit the harness before a publishable run. Commit raw JSON and generated SVG
supporting public claims; fixture data never belongs in Git. A dirty run is
exploratory only. Failed runs remain data, never silently disappear.

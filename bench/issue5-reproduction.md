# Issue #5 reproduction protocol

Question: can the reported roughly 120-second native creation versus six-second
stock checkout be reproduced, and does the published v0.4 binary change it?

Do not substitute the published v0.3 binary for the reported native baseline:
Pablo reports v0.3 delegation with the original attributes, and the native slowdown
on source `870f52e` compiled with Rust 1.99.1. Compare all four arms explicitly.

`reproduce-issue5.ts` runs stock Git, the downloaded v0.3 ARM archive, the exact
reported source/toolchain build, and the downloaded v0.4 ARM archive against an
ordinary full remote clone at the issue's pinned commit. It operates directly on
that source checkout, not a harness-created shared seed. It retains all three
repetitions (including first-use points), alternates arm order, and invokes the
actual CLI with `/usr/bin/time -l`. No builds or controlled fetches overlap the
measurements on that host.

After each command, compare raw file contents, executable modes, symlink targets,
and inventory against the stock checkout; check source bytes and private-write
isolation. Git status is supplementary, not a byte-identity certificate. Retain
stdout, stderr/resource logs, commands, versions, binary hashes, environment and
incremental state. Guards stop before overwriting paths or exhausting the declared
free-space budget. Worktrees are retained, not deleted between samples; this is
an explicit difference from the reporter's removal-between-runs description.

The ordinary-clone scenarios use separate real APFS Macs. Neither matches the
reporter's exact M3 Max/macOS 26.5.2 combination. This is not a Linux-container
performance emulation of APFS. Global Git configuration is isolated consistently;
the reporter's non-default global configuration and filesystem observers remain
unknown variables.

The ignored-donor hypothesis uses 50,000 generated small files under the original
ignored `theme/node_modules` path, without executing application or dependency
scripts or changing attributes. The top-level control moves those same files to
ignored root `node_modules`, preserving content and count while changing whether
the tracked-subtree cloning planner encounters them. This is synthetic diagnostic
data, not evidence that Pablo had these files. Creation-time phase traces can
separate snapshot/pruning work from raw content verification.

The M4 bootstrap installs Rust 1.99.1 alongside the existing toolchains, leaves
existing CLI installations alone, and caps its anticipated footprint with explicit
setup/run free-space guards. Fixtures, source clones and toolchains remain on the
machines for inspection; their removal requires confirmation.

Run the controller with `RUN SOURCE V03 REPORTED870 V04` absolute or relative paths.
Use a clean experiment checkout and unused output paths. See `prepare-issue5-mac.ts`
for the isolated second-Mac preparation and `create-ignored-donor.ts` for generation.
Generate JSON summaries and SVGs using `bun bench/summarize-issue5-reproduction.ts`.
Raw and generated data live under `bench/results/2026-11-17-issue5-reproduction/`.
Do not promote an experiment branch directly into main or claim that a synthetic
slowdown reproduces the original environment.

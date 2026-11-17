# RFD0020 — Typed benchmark campaigns and result layout

- Status: implementation contract
- Author: leostera
- Date: 2026-11-17

## Decision and motivation

Use a small TypeScript campaign runner with explicit filesystem targets and suite
plans. Rust continues to create fixtures, time actual CLI operations and certify
checkout bytes, modes, links and private writes. Move scheduling, deadlines,
process groups, provenance and manifest persistence out of the Linux Rust driver.
This supersedes its orchestration, not the measurement contracts in RFD0012/0015.

A contributor should add a target or suite without copying a campaign program.
The first slice supports the existing six-profile Linux campaign on XFS/Btrfs.
It does not provision machines, run new large benchmarks, publish results, change
measurement timing boundaries, or claim ZFS/NFS performance coverage.

## Guide-level contract

`bun bench/run.ts list` lists targets and suites. A run selects one target and
suite plus frozen candidate/baseline binaries. The runner derives an exclusive
output directory under `bench/results/<build>/<os>-<fs>/<UTC-date>/<run-id>/`.
Each point has raw JSON and stdout/stderr logs. A manifest exists before fixture
preparation and before every child starts. Interrupted or timed-out children are
never upgraded to verified results, even when they wrote a parseable JSON file.

Images, fixture bytes and executables stay in ignored `target/`. In-flight result
directories are ignored too so measuring does not dirty later points. Import or
explicitly select reviewed result files for version control; no automatic add,
commit, push or publication takes place.

## Reference-level contract

- Build identity is the executable SHA-256, not the harness revision. An optional
  operator-supplied source revision is recorded, never inferred from the binary's
  pathname. The version directory uses a hash identity when source provenance is
  unavailable. Full hashes remain in manifests even if directory labels shorten them.
- Targets bind a platform and a Rust filesystem selector. A plan rotates Git,
  frozen Twig and candidate once per round and preserves the existing concurrency
  sequence. Each point is attempted once; a failure stops the campaign.
- Monotonic total budgets include preparation. Effective point timeout is the
  smaller of the point limit and remaining campaign budget. Record elapsed times,
  command arguments, process outcome and a pending point before launch.
- Kill only the owned child process group on timeout or interruption, TERM then
  bounded KILL. Subprocess environments clear Git redirects/config injections,
  template overrides and trace destinations. Never modify the parent environment.
- Rehash binaries around measured points. Parse schema-4 results into verified
  points only after matching binary/harness/fixture/filesystem/backend identities,
  expected operation counts, source preservation, private-write and clone checks.
  Allocation stability is distinct from correctness and remains explicitly recorded.
- Save manifests by atomic replacement. Preserve unknown/missing/failed outputs;
  no retries, resume-overwrite, synthesized timings or performance conclusions for
  incomplete groups. An abrupt supervisor death leaves a visible pending point.
- Historical raw artifacts are immutable. A machine-readable archive index records
  original path, new path and SHA-256. Multi-build/multi-filesystem campaigns remain
  intact under explicit mixed labels; missing provenance is unattributed, not guessed.
  Update consumers to canonical paths; do not create forwarding aliases or duplicate
  raw data. Embedded historical paths remain part of the original bytes and can be
  resolved using the archive index.

## Alternatives and limitations

Only moving directories leaves duplicated orchestration and manual output naming.
Keeping orchestration in Rust is viable but slower to edit for campaign work;
rewriting verification in TypeScript risks losing the strongest correctness gate.
A generic plugin framework, VM scheduler or database would add concepts without
helping this first slice. Targets/suites are plain typed modules, not executable
user configuration or shell templates. Existing Python snapshot/chart code and
other Rust measurement programs remain because they perform distinct jobs.

Historical harness commits are not necessarily candidate commits. Some archives
compare several Twig builds or filesystems, and some predate binary hashes. They
must remain honestly labelled rather than being split or relabelled by inference.

## Executable acceptance

Tests cover deterministic plans, target/config parsing, safe environment isolation,
result provenance and corruption rejection, exclusive output allocation, timeout
and signal process-group cleanup, pending-point persistence, and raw archive hash
conservation. Smoke execution uses fake measurement processes rather than spending
another performance campaign's budget. Existing Rust workspace, snapshot regeneration,
README data checks and site data tests must continue to pass. Actual image-backed
smoke tests, if run, are exploratory while the checkout is dirty and cannot establish
performance claims.

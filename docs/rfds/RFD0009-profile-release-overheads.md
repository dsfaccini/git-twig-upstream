# RFD0009 — Profile release overheads

- Status: implementation snapshot
- Author: leostera
- Date: 2026-11-15

## Question and decision

Where does time go when creating a file-heavy kernel worktree, and on its first
status? Decide whether to prioritize native filesystem metadata work or Git index
handling. Do not optimize either based on the current hypothesis alone.

Baseline: stock Git 2.56.0. Candidate: the unchanged, optimized release executable
from the fixed-count experiment (core source f335c8e; its SHA-256 is recorded in
that dataset). Both use the same pinned kernel commit on fresh case-sensitive
32 GiB APFS images, one operation in flight. Collect three paired single-operation
rounds, warmed independently. Require zero incorrect checkouts or source mutations.

## Capture contract

`twig-profile` drives the existing real-CLI harness. A copied Rust Git wrapper
forwards standard streams and exit status to the pinned real Git and records each
invocation, monotonic elapsed duration, calling PID, actual Git PID, arguments and
staging-index environment. It does not replace or rebuild the candidate.

Git Trace2 events expose index and command regions. Stack sampling attaches to
candidate and Git processes alive for at least 500 ms, at 5 ms intervals, including
first status. Sample stacks include blocked threads: sample counts are not syscall
counts or CPU percentages. Short commands still have wrapper timing records.

Subtracting direct-child Git elapsed time from CLI creation leaves a diagnostic
residual, not pure filesystem CPU: it includes Rust work, process startup, wrapper
bookkeeping and scheduling. Use the native stack samples to explain that residual.
Correlate by PID and measured destination; keep warmups, setup, independent byte
verification, and measured calls distinct.

## Reporting and invariants

Keep the README main table to time and space, with configuration and verification
in a disclosure below it. Existing uninstrumented results remain authoritative;
never substitute profiled timings as an apparent speed change. Archive profile
records and generate any numeric summaries or plots from them. Record binary
hashes, source/dirty state, tool versions, sampling configuration and limitations.
Redact local home/project paths before publication; raw local sample files stay
under target until reviewed. Preserve failed or interrupted captures explicitly.

Existing harness verification checks every file's bytes, executable bit and symlink
target, native selection and source isolation outside creation time. Disposable
images are cleaned by that harness; on interruption, inspect and detach only this
run's owned images. One 32 GiB image is active at a time; retain the host's 128 GiB
free-space safeguard and the approved 250 GiB scratch ceiling.

## Alternatives and limitations

Source inspection alone cannot distinguish hashing, metadata and scheduling costs.
Adding phase instrumentation to the production binary changes the executable we
are explaining. DTrace syscall counting may require elevated privileges/SIP changes;
start with unprivileged stack sampling and Trace2 instead. The wrapper, polling,
Trace2 and sampler add observer overhead, so this is diagnostic evidence, not a new
performance comparison. No optimization or broad compatibility change is included.

## Recorded findings and next decision

The [versioned capture](../../bench/results/unattributed/macos-unspecified/2026-11-15/kernel-profile-release/kernel-profile-release.json),
[generated elapsed breakdown](../../bench/results/unattributed/macos-unspecified/2026-11-15/kernel-profile-release/kernel-profile-release.svg)
and [Trace2 events](../../bench/results/unattributed/macos-unspecified/2026-11-15/kernel-profile-release/kernel-profile-release.trace2.jsonl)
back these findings. All recorded creates passed independent verification and source
isolation checks. Original samplers succeeded; supplementary short Git-status
attachments that ended before sampling are retained as failures, not invented data.

The dominant individual Git subprocess is staged `update-index --really-refresh`,
not process startup across the short plumbing calls. Trace2 reports scanning every
tracked kernel entry during that refresh and again on the installed worktree's
first status. Source inspection explains the latter: `finish_install` creates a
fresh index with `read-tree`, discarding the staging index's populated stat cache.
Preserving that cache is a separate potential optimization, not part of directory
cloning.

Native parent stacks also show time in `clonefileat`, chmod, lstat and mkdir, with
substantial blocked time waiting for Git. These are wall-clock stack observations,
not syscall counters or CPU utilization. Directory cloning is the user's selected
next change; compare uninstrumented old/new release CLIs before claiming a win.

The initial selector missed status stacks because the worktree was in cwd rather
than argv. An operational supplemental sampler captured the remaining Twig status
operations; wrapper timings and Trace2 remained available for every round. The
subsequent Rust selector recognizes the status command independently of cwd and
retains post-exec command observations. The first missing status stack is not
retrospectively fabricated.

## Validation

Run a small real-CLI smoke capture through the wrapper before the kernel capture.
Require complete paired cohorts, native CoW selection, unchanged source, successful
verification, wrapper records and tool exit statuses. Missing symbols or sampling
permissions must be reported rather than replaced with invented attribution.

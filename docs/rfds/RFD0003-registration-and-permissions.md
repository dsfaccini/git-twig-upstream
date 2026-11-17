# RFD0003 — Registration and creation-permission boundaries

- Status: implementation snapshot
- Author: leostera
- Date: 2026-11-15

## Decision and motivation

Keep clone/verification parallel, but serialize optimized Twig worktree registration
and installation per shared Git directory using an OS file lock. At concurrency
16, the schema-v2 mixed run recorded Git failing to read a peer worktree's
commondir while that peer was being registered. See the raw failed run in
[bench/results](../../bench/results/sha256-51e21596eaf1/macos-unspecified/2026-11-15/mixed-v2/2026-11-15-mixed-v2.json).
This is a failed operation, not evidence of incorrect acknowledged file contents.
Do not hide it or claim a clean concurrency-16 result for that revision.

Also derive destination file permissions from normal creation probes in staging,
rather than hardcoding 0644/0755. Hardcoded modes would ignore a restrictive
caller umask. Probes discover effective regular/executable modes without temporarily
mutating the process-global umask in a multi-thread-capable library.

## Contract and invariants

The common Git directory owns twigs/registration.lock. Resolve this directory
through Git, including from linked-worktree sources. Git remains the only
worktree registry; twigs/ stores Twig-specific coordination and may later hold
recovery journals, not a duplicate list of worktrees. Each optimized creator opens
the lock and takes an exclusive OS lock before Git registration, holds it through
installation/index initialization, and closes it before invoking user hooks.
Closing the file or process death releases the OS lock; the persistent lock file
is not itself evidence of a live lock. No stale-lock-file deletion is required.
Only the small metadata operation is serialized, not data cloning or verification.

Stock Git and delegated unsupported operations do not participate in this lock.
This avoids races among optimized Twig creators; it is not a general lock over all
programs that might edit Git metadata. Git still owns branch checks. Crashes may
still leave partial registered worktrees; recovery remains manual.

Regular file modes come from a newly created 0666 probe and executable modes from
a 0777 probe, both filtered by the OS umask. Clone metadata is adjusted to that
creation policy. Probe files stay outside tracked staged data and are retained with
the prototype's staging directory. Directory creation already honors the umask.
This is not a guarantee about every ACL/xattr policy on every filesystem.

## Alternatives and drawbacks

Retrying arbitrary registration errors can disguise partial mutation; do not retry
blindly. A separate serial daemon is unnecessary. Serializing the entire operation
would throw away useful clone parallelism. The OS lock adds contention and does not
coordinate non-Twig writers. Creation probes add two tiny retained files per stage.

## Validation

A sixteen-creator CLI test requires all independent destinations to register and
remain clean. A child process with umask 077 must produce a 0600 regular file.
Rerun the concurrency ramp with versioned raw data before drawing conclusions.

# RFD0015 — Linux donor coverage and differential controls

- Status: implementation snapshot
- Author: leostera
- Date: 2026-11-17

## Decision and motivation

Expand where Twig saves disk rather than optimize its wall time. First support
explicit revisions using a bounded, same-filesystem donor search, retaining raw
private-byte verification. Add systematic checkout comparisons and deliberately
corrupted snapshots that prove the comparator detects differences. Then expand
safe builtin checkout conversions. External filter execution, sparse checkout and
submodules remain separate steps until their side effects and failure ordering
have a tested contract. This supersedes the same-HEAD restriction in RFD0014,
not its raw-byte, policy, source-preservation or registration invariants.

Work is local: no push, release, website publication or deployment. Acceptance is
zero wrong checkout bytes, source mutations, source hardlinks or overwritten
existing destinations. Sharing counts and actual filesystem allocation are both
measured: a backend banner alone is not proof of disk savings.

## Guide-level contract

Given a current checkout at commit A and a request for commit B, Twig can share
unchanged files at the same paths from A and have Git materialize changed or new
files from B. A nearby existing worktree may supply more matching blobs than A;
Twig chooses one donor, not an unbounded per-file search across all worktrees.

For example, if B changes one of a thousand files, the other 999 may remain CoW
clones. A dirty donor cannot supply its uncommitted bytes: every private candidate
must still match B's raw object, or Git writes that path. Attribute/configuration
policy comes from the invoking repository and pinned target index, never from
whichever donor happened to be selected.

## Reference-level contract

1. Resolve the requested commit once; use that object for target inventory,
   verification and post-registration HEAD checks. Keep existing argument and
   option fallbacks; no claim of full Git worktree compatibility.
2. Parse `worktree list --porcelain -z` without decoding paths as UTF-8. Ignore
   bare, prunable, missing and other-device worktrees. Prefer the current checkout
   on equal scores and bound scoring to five eligible worktrees.
3. Rank donors by the number of same-path, same-kind, same-object target entries.
   Executable-bit differences between regular files are safe because target
   checkout modes are applied separately. This count is an explicit heuristic,
   not a claim to maximize bytes shared. Byte-weighted scoring is a later option.
4. Clone only target entries present in the chosen donor tree with compatible
   kinds and matching object IDs. An omitted candidate is not an error: Git
   materializes it. Missing private candidates are detected before starting an
   object-stream request, preserving framing for following candidates.
5. Preserve the no-follow tracked walker and conservative fallback on donor
   type/special-file changes. No tree/index cleanliness signal certifies bytes.
   Keep source indexes untouched. Dirty or stale donor HEAD/index information can
   reduce coverage, but cannot authorize unverified bytes.
6. Keep target policy rechecks before registration and installation, registrar
   serialization, post-checkout ordering and retained post-registration failures.
   Existing sparse/config/hook/filter safety exclusions remain explicit. Exclude
   branch.* bookkeeping from the config fingerprint: Git legitimately adds
   tracking keys while registering a branch. Branch-conditional includes still
   delegate, so these keys cannot silently select a different conversion policy.
7. Builtin ident and encoding paths may be Git-written in private staging because
   they do not launch external conversion programs. External filters remain a
   whole-request fallback until execution in the final destination and exactly-once
   failure behavior are designed. Literal attribute sentinel values stay distinct
   from absence; symlink contents are never text-converted.
8. For automatic text policies only, raw-equal NUL-bearing target blobs may stay
   cloned even when text files require CRLF. Git's convert_is_binary() recognizes
   NUL and will_convert_lf_to_crlf() skips automatic conversion for such blobs.
   Inspect raw target bytes across the whole stream, not a donor-only/prefix hint.
   Explicit text/eol, ambiguous sentinel values, legacy crlf and builtin conversion
   paths do not get this exemption. This is a conservative subset, not a rewrite
   of Git's complete binary heuristic.

## Executable contract and tests

Compare stock Git and Twig across a matrix of target revisions and donor layouts:
current/older/newer commits, unchanged/added/deleted/type-changed paths, dirty and
staged donors, linked donors, SHA-256 repositories, hostile names and target
attributes differing from donor attributes. Compare raw files, links, executable
modes, target HEAD, logical index entries and status. Git-versus-Git is the
control; mutation tests must reject wrong bytes, missing/extra paths and mode/link
changes. Output/reflog parity is not silently assumed by this first comparator.

Require native selection on XFS and Btrfs and exercise ext4 delegation, minimum
Git 2.40, concurrent creators, permissions, filters and policy races. Keep tests
bounded and fixtures retained under target. Extend coverage only when the relevant
failure and side-effect tests pass.

## Measurement and alternatives

Freeze today's Twig and each candidate by commit and binary SHA-256. Compare
stock Git, the frozen baseline and the candidate on pinned unchanged, LF-policy,
cross-revision and best-donor fixtures. Use repeated paired isolated-filesystem
measurements, explicit source and target commits, native/path counts and full byte
verification. Record fallback for the old baseline as fallback, not native CoW.
Ramp concurrency within a named time/disk budget; retain partial runs and failures.
Do not repeat the unbounded kernel loopback-stall experiment or publish incomplete
pairs as a win. The aim is additional allocation saved, not promised lower latency.

The local [snapshot](../../bench/results/2026-11-17-linux-coverage/snapshot.json)
and generated CSV support the disk-first decision for these synthetic fixtures:
two sequential cross-revision creates allocate 16.09 MiB rather than 128.08 MiB
(XFS) or 128.31 MiB (Btrfs). Builtin, automatic-CRLF and RFD0016 gitlink cases
avoid nearly all duplicated large-file data. Keep raw verification despite its
cost: cross-revision batch time rises from 180.56 to 376.89 ms on XFS, and
286.95 to 470.45 ms on Btrfs versus the frozen baseline. Unchanged-file sharing
does not materially improve, and Btrfs many-small-file allocation remains
metadata-heavy. These are not universal speed or capacity claims.

The campaign contains 135 verified points/432 creates and an interrupted,
unpaired Btrfs c16 point. Its checkpoints expose one stock Git registration error
while other creators were in flight; the total remaining budget expired before
verification. Preserve that finding without comparing incomplete capacity or
treating unverified exit-zero creates as successes. Manifest v2 now records the
actual effective timeout so a total-budget stop cannot be mistaken for the full
configured per-point timeout. No retry or publication is part of this decision.

Keeping same-HEAD only is simpler but leaves ordinary branch workflows without
sharing. Trusting donor stat caches is faster but loses the required raw-byte
certificate. Registering first and running arbitrary filters in staging risks
wrong cwd-dependent output and duplicate side effects after fallback; it is not
part of this slice. Multiple donors and a persistent object-to-file cache add
coordination and invalidation that a single bounded donor does not need.

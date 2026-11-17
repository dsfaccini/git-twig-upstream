# RFD0016 — Gitlinks and nonregular checkout entries

- Status: implementation snapshot
- Author: leostera
- Date: 2026-11-17

## Decision and motivation

A gitlink should not force unrelated large files to be copied. Match ordinary
`git worktree add` without recursion: share verified regular files and links,
while Git creates empty submodule directories and indexes their commit IDs. Never
clone or initialize an existing donor submodule. This replaces the gitlink
whole-request exclusion in RFD0015, not the exclusions for sparse checkout,
external conversion of regular files, or unsafe hooks/configuration.

Git's checkout-index implementation can create gitlink directories without
resolving their commit objects in the parent repository. Parent indexes record
submodule commit IDs; they do not contain the nested repository's file inventory.
That is the boundary: neither donor discovery nor snapshotting enters a gitlink.

## Guide-level contract

A repository with application files and `modules/library` can create a normal
linked worktree with shared application files. `modules/library` is an empty
folder, just as with stock Git's default creation. Initializing it is still an
explicit later operation, possibly performed by the user's post-checkout hook.
Dirty tracked files, ignored data and the initialized nested Git repository in
the donor stay where they are. No recursive checkout, fetch or network access
is added by Twig.

## Reference-level contract

1. Parse gitlinks as commit IDs, but never nominate them for blob cloning.
2. Target-index policy classifies gitlinks for Git materialization, not raw blob
   comparison. `checkout-index --force --stdin -z` owns directory creation and
   leading-path handling; do not replace that with a symlink-following mkdir walk.
3. Force `submodule.recurse=false` only on private initialization/materialization
   and final index commands. This matches worktree add's no-recursion behavior
   without modifying configuration files or the context seen by user hooks.
4. Checkout conversion attributes on symlink/gitlink entries do not run ordinary
   blob conversion. Retain raw symlink verification and let Git recreate changed
   links; a filter matching only such an entry does not force a global fallback.
   Regular-file filters still delegate before external programs execute. A
   core.symlinks=false setting needs fallback only when the target actually has
   symlink entries; it does not affect regular files or gitlink directories.
5. Keep registration locking, raw-byte certificates, index/source preservation,
   policy rechecks, no-overwrite and post-checkout ordering unchanged.

## Executable contracts

Compare stock Git's raw tree, directories (including empty ones), HEAD, logical
index and status with Twig. Exercise absent/uninitialized and initialized dirty
source submodules; verify nested user data, ignored files, parent index and
nested index are unchanged. Test `submodule.recurse=true` without permitting
initialization in the new worktree. Symlink-only filter/ident/encoding rules
must neither rewrite link text nor execute the configured external filter.

Benchmark verification must model regular files, symlink text and gitlink
folders as different variants. A gitlink directory must exist, be a directory
rather than a followed link, and remain empty. Logical worktree bytes exclude
nested repository contents that the requested default Git operation does not
materialize. Preserve correctness and private-write checks on the actual shared
application data; do not count an empty directory as shared data.

## Alternatives and limits

Whole-request fallback is safe but discards sharing for every unrelated file.
Recursively copying a source submodule leaks local state and implements a different
operation. Manual directory creation bypasses Git's path/symlink behavior.
Post-processing a completed arbitrary checkout introduces inode/stat-cache and
hook/side-effect ordering questions that this simpler per-entry contract avoids.

Explicit recursive submodule operations, sparse checkout and external conversion
of regular files are not covered. This work is local only; no publication,
version bump or deployment is part of the decision.

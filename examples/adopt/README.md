# Existing-worktree adoption

## Layout adoption (development main)

```sh
git twig adopt --dry-run --worktrees-dir=/path/to/repo
git twig adopt --worktrees-dir=/path/to/repo
```

Discover this repository's registered worktrees and preview a sibling layout:
`/path/to/repo/{main,feat-x,...}`. The original clone uses `main/` regardless of its
branch. Omitting the directory prompts for a root, which is saved per repository
after success. A target path adopts only that checkout. With no target, the main
clone and every registered linked checkout are considered, not unrelated repos.

Coordinate agents/editors, inspect every proposed move and confirm before applying.
`--dry-run` changes nothing; noninteractive application requires `--yes` and an
explicit or saved root. Staged, dirty, untracked and ignored files are moved intact;
Git repairs registration links. Cross-device moves, locked/prunable registrations,
active Git locks, submodules and occupied/colliding destinations are refused.
Recovery journals remain in a private `.twig-adopt-*` directory beside the original
clone. Do not delete journals or parked files after an interrupted/failed move.
Session records and other external absolute paths are not updated automatically.

After adoption, `git twig new -b feat/x` can use the saved root without an explicit
path. Layout adoption on Linux attempts in-place sharing afterward. On macOS moving
alone leaves sharing unchanged; optional offline compaction is described below.
See [RFD0025](../../docs/rfds/RFD0025-adopt-worktree-layout.md).

## Offline APFS compaction (development main)

```sh
git twig adopt --compact --dry-run --worktrees-dir=/path/to/repo
# Save work; close all agents/editors/builds/servers using donor and targets.
git twig adopt --compact --worktrees-dir=/path/to/repo
```

Interactive adoption offers compaction and asks for explicit offline consent.
Already-approved automation requires `--compact --offline --yes` with an explicit
or saved root; `--yes` alone is move-only on macOS. `--move-only` disables sharing
on both platforms. Never use process scans or a paused session as proof that
replacement is safe.

Only byte-identical same-path tracked regular files are shared. Native candidates
receive the target's supported metadata (including creation time, ACLs and xattrs)
and are re-verified before atomic exchange. Index contents stay unchanged, while
inodes/ctime change. Verified originals are retired with a busy-file guard to
release old references; journals remain. On failure preserve both installed and
recovery copies and inspect the journal before restarting any agent. Unsupported
metadata, hardlinks, symlinks and ignored/untracked data are not replaced. Matching
logical bytes are not exclusive physical savings; snapshots/backups are not pruned.
See [RFD0026](../../docs/rfds/RFD0026-offline-adoption-compaction.md).

This layout flow is unreleased. Published v0.5 has the earlier sharing-only default;
check `git twig adopt -h` for `--worktrees-dir` before using the layout examples.

## Explicit file-sharing modes

Available since v0.5.0. Run from a distinct donor checkout; the target must be an
existing linked worktree of the same repository:

```sh
git twig --version
git twig adopt --dry-run ../existing
```

An explicit target dry-run includes read-only byte inspection (in addition to the
layout preview on development main). It compares current raw bytes at the same
paths tracked in both checkouts, including dirty files, without refreshing the index. Different,
missing, empty, symlinked, multiply-linked or cross-device files are skipped.
Eligible logical bytes are NOT an estimate of physical space reclaimed: files
may already share blocks.

On APFS, `--prepare` makes verified private CoW candidates in Git metadata and
leaves every existing worktree file in place. It can consume additional space.
The candidates are not metadata-complete installable files. **The --prepare mode is not an
APFS compactor.** `--dedupe` fails on macOS rather than replacing live files.

On Linux XFS/Btrfs, try `--dedupe` only in a disposable experiment first. It uses
the kernel's in-place FIDEDUPERANGE primitive, including its atomic byte comparison
against concurrent writes. It does not unlink, rename or replace the target inode.
An unsupported/changed range fails visibly; preceding successful sharing is not
rolled back, and neither file's contents are restored or overwritten. Syscall
bytes are reported separately from matching logical bytes and are not exclusive
physical allocation savings. No timing or allocation benchmark is included.

The explicit sharing-only modes consider one selected donor (the invoking checkout),
not all potential donors or content at other paths. These modes never create branches,
change registration, delete scratch, edit Git configuration, or force-adopt.
Run only in trusted local repositories. Inspection is not a durable certificate
that authorizes later replacement; concurrent changes remain possible.

## Tests

```sh
CARGO_TARGET_DIR=target/build cargo test -p git-twig adopt
# On an independently provisioned disposable reflink-enabled XFS or Btrfs mount:
TWIG_TEST_REQUIRE_NATIVE=1 TWIG_TEST_FIXTURE_ROOT=/owned/test-mount \
  CARGO_TARGET_DIR=target/build cargo test -p git-twig adopt -- --include-ignored
```

The two Linux dedupe-specific tests are explicitly ignored by default: clone
support on an arbitrary filesystem does not establish dedupe support. The native
lab must be provisioned independently, not inferred from Twig's behavior. Tests
compare bytes, modes, inode identity, index preservation and private writes;
Linux also checks an existing writable mapping and a stale comparison rejected
by the kernel. APFS tests cover preserving custom xattrs and ACLs while preparing.
Generated repositories and scratch remain under ignored target paths / the
explicit test mount. The open-descriptor counterexample retains both inode
versions to demonstrate why clone-and-rename is not safe live APFS adoption.

See [RFD0023](../../docs/rfds/RFD0023-adopt-existing-worktrees.md) for the contract,
alternatives and outstanding APFS application problem.

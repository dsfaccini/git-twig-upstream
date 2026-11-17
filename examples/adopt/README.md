# Existing-worktree adoption prototype

This exists only on `exp/adopt`, not in any released Twig version. Build and use
this experiment's binary explicitly; do not replace your installed Twig:

```sh
CARGO_TARGET_DIR=target/build cargo build --release -p git-twig --locked
# Run from the donor checkout; target is an existing linked worktree of that repo.
/absolute/path/to/exp-adopt/target/build/release/git-twig adopt --dry-run ../existing
```

Default mode is read-only inspection. It compares current raw bytes at the same
tracked paths, including dirty files, without refreshing the index. Different,
missing, empty, symlinked, multiply-linked or cross-device files are skipped.
Eligible logical bytes are NOT an estimate of physical space reclaimed: files
may already share blocks.

On APFS, `--prepare` makes verified private CoW candidates in Git metadata and
leaves every existing worktree file in place. It can consume additional space.
The candidates are not metadata-complete installable files. **This is not yet an
APFS compactor.** `--dedupe` fails on macOS rather than replacing live files.

On Linux XFS/Btrfs, try `--dedupe` only in a disposable experiment first. It uses
the kernel's in-place FIDEDUPERANGE primitive, including its atomic byte comparison
against concurrent writes. It does not unlink, rename or replace the target inode.
An unsupported/changed range fails visibly; preceding successful sharing is not
rolled back, and neither file's contents are restored or overwritten. Syscall
bytes are reported separately from matching logical bytes and are not exclusive
physical allocation savings. No timing or allocation benchmark is included.

The prototype considers one explicitly selected donor (the invoking checkout),
not all potential donors or content at other paths. It never creates branches,
changes registration, deletes scratch, edits Git configuration, or force-adopts.
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

See [RFD0021](../../docs/rfds/RFD0021-adopt-existing-worktrees.md) for the contract,
alternatives and outstanding APFS application problem.

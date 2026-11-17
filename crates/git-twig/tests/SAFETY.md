# Safety properties

Run `cargo test -p git-twig --test worktrees`. Fixtures are retained under
`target/test-fixtures`, or `TWIG_TEST_FIXTURE_ROOT`. Failures print the fixture
path. `TWIG_TEST_REQUIRE_NATIVE=1` makes Linux native coverage mandatory; an
independent reflink probe prevents silently testing fallback instead.

## New differential and lifecycle cases

`cases/safety_properties.rs` exercises these contracts through the actual CLI:

| Property | Oracle / injection |
| --- | --- |
| Target revision, not donor index, determines output | 12 deterministic SHA-1/SHA-256 cases; dirty/staged/missing files and changed modes; compare with independently created stock worktree |
| Raw output equals stock checkout | Exact recursive inventory, raw file bytes, executable bits, symlink targets; LF/CRLF attributes, binary data, Unicode/tab/newline paths |
| Ignored files cannot escape into the target | Root/nested/deep dependency directories, each containing small files and a symlink outside the clone |
| Source and source index remain untouched | Snapshot before creation, compare afterward, then mutate every private regular file and compare source again |
| No hardlinks to donor | Compare device/inode pairs for every surviving source regular file |
| Existing destinations stay untouched | Nonempty directory, file, symlink, dangling symlink; compare user inventory, outside sentinel, and Git registration |
| One owner per destination | Four CLI calls launched from a barrier, with shared or distinct destinations; exact success/registration counts and contents |
| Failure does not erase recovery evidence | Git wrapper performs real registration then fails or SIGKILLs Twig; also fails final read-tree after files are installed; inspect retained partial destination and staging |
| Verified private snapshots survive donor edits | Mutate donor immediately after registration; target remains equal to original stock contents, donor edit survives |
| Destination interference stops installation | Insert foreign file or source-pointing symlink after registration; neither it nor its target is overwritten |
| HEAD movement invalidates installation | Move detached destination HEAD after registration; reject installation before any target files are moved |
| Retrying cannot consume another invocation's scratch | Reject reuse of partial destination; succeed at fresh destination; compare retained staging before/after and exact registrations |

These are finite generated cases, not exhaustive proofs or a randomized shrinking
framework. The generation seed and fixture are retained. Parallel launch varies
scheduling but does not force every interleaving. The registration fault injection
is deterministic and has a process-group watchdog; no sleeps select the boundary.
Existing `checkout_races.rs` covers attribute changes before/after registration,
dirty filter policy, and macOS writable mappings. Existing worktree/checkout-policy
tests remain part of the same suite.

## Interpretation

A clean `git status` is not the contents oracle. Missing donor files may safely
fall back; intact donor cases must use native CoW on macOS and on required-native
Linux runs. Symlink traversal is never used by the inventory helper. `.git`
metadata is excluded from raw checkout comparisons and registration is checked
separately. Index preservation is an explicit byte comparison.

The ignored-file fixture checks correctness, not a performance threshold. There
are no elapsed-time assertions. Dependency scripts are never executed. These tests
do not claim to fix or reproduce issue #5's two-minute slowdown.

## Still required for broader coverage

- Deterministic failure at each individual installation/repair step, not only
  registration and the existing policy boundaries.
- Concurrent donor mutation during cloning/hashing (post-verification mutation is
  covered), and destination races within individual rename/check transitions.
- Full mode, ACL, extended-attribute, immutable-file, and Unicode/case-collision
  semantics on both case-sensitive and default APFS.
- Separate-volume/external-drive cases, ENOSPC and injected I/O failures using
  disposable volumes; never fill a user's main disk.
- Larger generated inventories with replayable randomness and shrinking, while
  retaining failures and avoiding unbounded fixture growth.
- Executing these additions on minimum Git/Rust, native Linux XFS/Btrfs, and
  multiple macOS releases and published archive architectures.

Passing on one local APFS machine does not establish the remaining matrix.

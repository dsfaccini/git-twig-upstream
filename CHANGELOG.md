# Changelog

This log starts with one consolidated entry for the feature set available in
v0.3.0, including features introduced in earlier releases. Future entries will
describe changes from this baseline after they are implemented and verified.

## Unreleased

### Fixed

- SIGINT, SIGTERM or SIGHUP before registration removes this invocation's staging,
  which bulk directory clones can briefly fill with ignored files, and starts no
  stock Git fallback. Later interrupts still retain staging; SIGKILL cannot be handled.

## [0.5.0] — 2026-11-17

Share unchanged files across revisions and more checkout policies, and inspect
existing worktrees with experimental adoption tools.

### Added

- Bounded same-filesystem donor selection across target revisions, while keeping
  private raw-byte verification and source indexes unchanged.
- Git-written builtin ident/encoding exceptions without losing other sharing.
- Verified NUL-bearing blobs stay shared under automatic CRLF policies; forced
  text conversion and dirty donor bytes still go through Git.
- Branch tracking setup no longer appears as a conversion-policy change.
- Gitlink directories no longer disable sharing for other files. Initialized
  donor submodules are never copied or recursively checked out.
- Conversion rules on symlinks/gitlinks do not disable unrelated sharing, and
  core.symlinks=false only delegates when the target has symlink entries.
- Agent skill guidance for choosing a checkout, creating task branches, and
  asking before cleanup, without requiring client-specific lifecycle hooks.

### Verification and benchmarks

- Differential revision/donor cases, dirty/staged source preservation, private
  writes, concurrent creators and deterministic interruption/race coverage.
- Linux filesystem coverage includes native XFS/Btrfs, tested OverlayFS layouts,
  NTFS drivers and portable-filesystem fallback subsets.
- Frozen checkout campaigns across XFS, Btrfs and default/case-sensitive APFS,
  with separate timing/allocation observations and retained failed/unstable points.
- Generated README tables for the frozen v0.5 candidate against stock Git and
  source-built v0.4; the website compares only stock Git with the latest candidate.
  Synthetic workload results remain separate from historical real-repository
  benchmarks; no blanket speedup or adoption-space-savings claim.

### Experimental

- `git twig adopt` inspects matching current tracked bytes in existing linked
  worktrees without restoring HEAD or changing the index/registration. Default
  mode and `--dry-run` are read-only; `--prepare` retains private verified clones.
- Linux `adopt --dedupe` shares identical ranges in place through FIDEDUPERANGE,
  preserving inode identity and open-writer/mapping behavior. Native XFS/Btrfs
  tests include stale-comparison rejection, private writes and dirty/staged data.
  APFS live replacement remains unsupported; preparation is not compaction, and
  reported logical/kernel bytes are not measured exclusive allocation savings.
- Adoption candidates must be tracked in both checkouts; ignored/untracked donor
  files are excluded even when the target tracks the same path.
- `adopt --prepare` rejects filesystems that cannot enforce private scratch
  permissions before writing candidate contents, retaining only an empty directory.
- Linux adoption CI independently probes cloning and deduplication, including
  safe refusal on unsupported filesystems and OverlayFS lower-layer restrictions.
  exFAT/VFAT coverage remains a regular-file portable subset, not POSIX parity.

External filters on regular files, sparse checkout, conditional config includes and
relative attribute-file configuration remain conservative whole-request fallbacks.

## [0.4.0] — 2026-11-17

### Fixed

- Reduce regular-file verification overhead by batching unfiltered Git blob hashes
  of private clones instead of inflating target blobs through a pipe (#5).
- Clarify that private staging is retained only if creation fails; successful
  creation still removes its owned staging directory.

- Distinguish absent attributes from literal filter names such as `unset` and
  `unspecified`; these filters can no longer bypass native eligibility checks.
- Verify private clone bytes against raw target blobs rather than trusting a
  normalized clean-filter/index comparison.
- Resolve attributes from the target index, not dirty, staged or untracked
  source attribute files. Recheck policy before registration and installation;
  retain partial state on a post-registration policy change.
- Delegate before staging when copied worktree configuration contains relative
  includes whose resolution would change in the new worktree; keep consistent
  ordinary worktree overrides and absolute includes eligible.

### Added

- Bounded parallel raw hashing for large file inventories, with length-based
  rejection of oversized dirty donors and opt-in verification phase timings.

- Native coverage for supported identity-checkout policies, including
  `text=auto eol=lf` and applicable `core.autocrlf=input` configurations.
- Hybrid creation: Git writes files requiring line-ending conversion or whose
  candidate bytes differ; other verified files retain copy-on-write sharing.
- Trace counts for verified file clones and Git-written paths.
- Specific fallback reasons for unsupported requests, configuration, hooks and
  destinations; attribute refusals name the escaped path, attribute and value.
- Differential and failure tests for line endings, literal attribute values,
  attribute precedence, dirty policies, mapped donors, private writes, SHA-256
  repositories, unusual paths and policy changes during creation.
- CI coverage for the minimum supported Git 2.40 on macOS and Linux.
External filters, ident expansion, working-tree encodings, conditional config
includes and relative attribute-file configuration remain conservative
whole-request fallbacks. Other-revision cloning, braiding and re-sharing are
not included.

## [0.3.0] — 2026-11-16

### Worktree creation

- `git twig new` creates ordinary Git linked worktrees with native copy-on-write
  file sharing on macOS/APFS and Linux Btrfs or reflink-enabled XFS.
- Native creation supports explicit new branches (`-b`) and detached worktrees
  (`--detach`) at the source checkout's current `HEAD`.
- Git owns worktree registration, branch validation and shared repository data.
  Native creation runs the post-checkout hook after installation.
- Private clones use Git-based verification against the requested commit;
  uncommitted changes and untracked or ignored files are not intentionally
  inherited. Writes do not modify source files; source hardlinks are never used.
- macOS clones tracked subtrees in bulk and prunes unrelated entries. Linux
  clones tracked regular files individually. Executable modes and symlinks are
  handled as Git checkout entries.
- Existing destinations are not overwritten. Owned staging lives under the
  common Git directory in `twigs/staging`; successful operations clean their
  staging, while failed or interrupted attempts retain it for inspection.

### Commands and agent support

- `new` is the creation command. `add` is rejected with guidance to use `new`.
- `list`, `remove`, `move`, `lock`, `unlock`, `prune` and `repair` delegate to Git.
  Machine-readable listing is available through `list --porcelain [-z]`.
- `git twig skill` prints bundled agent instructions without requiring a checkout.
- Short help, subcommand help and `--version` work outside a repository.
- `TWIG_TRACE=1` reports native backend selection or fallback.
- The website serves agent setup instructions at
  <https://twig.leostera.dev/llms.txt> and provides a copyable onboarding prompt.

### Installation

- One `git-twig` Cargo package contains the CLI and Rust library.
- Homebrew and GitHub release archives provide macOS arm64/x86_64 and Linux
  x86_64 binaries. Homebrew and archives include the `git-twig(1)` manual.
- Requires Git 2.40+; building from source requires Rust 1.95+.

### Compatibility limits

- Native CoW requires source, destination and common Git metadata on the same
  supported filesystem. Other revisions, unsupported options/filesystems and
  unsupported checkout semantics delegate to `git worktree`.
- Native coverage excludes conversion attributes such as `text=auto eol=lf`,
  non-false `core.autocrlf`, sparse checkouts, submodules and certain hooks.
  This is not full native coverage of Git's checkout behavior.
- Failed installation can leave a partial registered worktree; inspect retained
  state before retrying. There is no automatic repair or sweep of old staging.
- JSON listing, commit/integration queues and re-sharing existing worktrees are
  not available in this release. macOS binaries are not signed or notarized.

[0.5.0]: https://github.com/leostera/git-twig/releases/tag/v0.5.0
[0.4.0]: https://github.com/leostera/git-twig/releases/tag/v0.4.0
[0.3.0]: https://github.com/leostera/git-twig/releases/tag/v0.3.0

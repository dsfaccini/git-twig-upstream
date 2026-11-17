# RFD0017 — Filesystem capability and OverlayFS coverage

- Status: implementation snapshot
- Author: leostera
- Date: 2026-11-17

## Decision and motivation

Keep Linux cloning capability-driven, not a filesystem-name allowlist. Extend
checkout correctness coverage to ext4 and OverlayFS backed by ext4, reflink-enabled
XFS and Btrfs, plus Linux NTFS through the separate ntfs3 and ntfs-3g drivers. OverlayFS is a distinct filesystem layer: its backing filesystem
alone does not certify that cloning works through the mounted view. OpenZFS,
NFSv4.2 and bcachefs remain unverified until an appropriate environment exists.
This extends the executable contracts in RFD0011, RFD0012 and RFD0015 without
changing the production clone primitive or relaxing raw-byte verification.

## Guide-level contract

A repository created through an overlay starts in its upper layer. A repository
seeded before mount can instead start entirely in lowerdir. In either case,
requesting another checkout must produce the same files, links, modes, HEAD,
logical index and status as stock Git. The source index and bytes must remain
unchanged. A private write in the new checkout must not change either the merged
source or the original lowerdir data.

Copy-up may change physical placement or inode identity without changing those
user-visible guarantees. The test deliberately invokes Twig before its stock-Git
control so the control cannot accidentally warm up/copy up the donor first.
Do not modify lowerdir behind a mounted overlay: prepare all fixtures before
mount, then access them through the merged view. Lowerdir is a read-only oracle.

## Reference-level contract

- Independently probe reflinks with `cp --reflink=always`. For clone-capable test
  layouts, require Twig's native path; a backend defect must not become a silent
  skip. For non-cloning layouts, the existing Linux selector test requires stock
  Git delegation and verifies private-write/source preservation.
- Run the ordinary differential matrix on plain ext4 and fresh overlay upper
  directories. Run the opt-in lower-layer test separately with a preseeded
  two-commit repository, builtin conversion rules, executable file, symlink,
  NUL-bearing data and an ignored cache.
- Compare both HEAD and its parent against Git. Preserve lowerdir index, config,
  HEAD, source files and the absence of worktree registrations there. Overlay
  registrations and staging belong to the writable merged/upper view.
- The fixture seeder creates a new directory only. It never overwrites or repairs
  caller data. Benchmark subprocess sanitation also applies to its Git commands.
- CI owns fresh loopback images and unmounts overlay before the backing image.
  Local fixtures and images are retained under ignored target directories.
- A successful ioctl/native trace establishes tested capability, not physical
  disk savings. These compatibility checks are not allocation benchmarks or
  claims about every OverlayFS mount option, kernel or backing filesystem.

## Pathname representability and NTFS

A Linux kernel does not imply that every raw-byte pathname can be represented
by its mounted filesystems. With UTF-8 pathname conversion, ntfs3 rejects an
invalid-UTF-8 name with EINVAL and ntfs-3g with EILSEQ. Do not let that fixture
setup error skip unrelated empty, large and sparse-file isolation tests.

Keep those file-shape tests Unicode-safe and test raw-byte names separately.
Build the raw-name Git tree through update-index/cacheinfo even if the filesystem
cannot create the name. Twig must then match stock Git's failure, exit outcome
and destination cleanup, rather than silently omitting or renaming the path.
Other I/O errors are not interpreted as an encoding restriction. On filesystems
that accept the name, compare the successful checkout and private-write behavior.

NTFS coverage is configuration-specific: ntfs3 uses uid/gid plus ACL support;
ntfs-3g uses permissions/allow_other and an owned mount root. Keep these drivers
separate. Neither tested driver accepts the clone probe, so no native-CoW or
allocation savings claim follows. Default mounts without POSIX permission support
and Windows-hosted NTFS are different configurations, not implied coverage.

## Alternatives and boundaries

Treating every overlay as unsupported is simpler but discards working native
clones on the tested XFS/Btrfs layouts. Inferring support from the backing type
is unsafe because the overlay layer and mount policy also participate. The real
operation plus differential tests is the narrower, stronger contract.

Do not install/load host kernel modules merely to turn an unavailable OpenZFS
setup into a green result. A ZFS-enabled Linux test host with an owned dataset is
needed for its capability, isolation and allocation checks. No native support
claim is made from the existence of a block-cloning feature alone. All work stays
local; this document authorizes no push, release or deployment.

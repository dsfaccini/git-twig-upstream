# RFD0021 — v0.5 parity and benchmark gates

- Status: proposal
- Author: leostera
- Date: 2026-11-17

## Decision and motivation

Prepare v0.5 by establishing equivalent checkout and safety contracts across the
claimed OS/filesystem matrix before freezing a candidate and generating fresh
benchmark data. Parity means correct raw bytes, file kinds, executable modes,
source/index preservation, independent private writes, registration and recovery
semantics. It does not mean identical cloning algorithms, native support where
the filesystem refuses cloning, or equivalent performance across unlike hosts.
No tag, release publication, deployment or version bump is authorized by this
preparation work.

## Guide-level contract

First compare current main with the last integrated Linux baseline. Changes since
b241c8b through c0848c7 add Unix safety properties and Mac issue-5 reproduction
programs; they do not modify production materialization. The new Unix tests must
actually execute on clone-capable Linux, not silently pass through fallback.
macOS bulk directory cloning and Linux's tracked-entry-only FICLONE walker are
different implementations of the same contract. Do not copy directory-pruning
work to Linux merely to make the implementations look alike.

Then run the full applicable differential/lifecycle suite, including the new
registration failures, killed creators, donor edits, destination interference,
HEAD/index races, ignored state and concurrent ownership cases. Failures retain
their fixtures/logs and block benchmark conclusions until explained and fixed.

Only after the corresponding primary target’s correctness gate passes, identify
stock Git, a v0.4 baseline and the
candidate by exact executable hashes and source/toolchain provenance. Run repeated
paired campaigns on each applicable target, retaining failures, first-use/warmup
policy and all raw observations. Disk savings remain the primary decision metric;
creation and first-status regressions must remain visible.

## Reference-level contract

- Native primary targets: macOS APFS and case-sensitive APFS layouts, Linux
  reflink-enabled XFS and Btrfs. Independently probe native support and require
  actual nonzero verified clones in applicable native cases.
- Fallback/compatibility targets: ext4, tmpfs, Linux NTFS drivers and tested
  OverlayFS layouts retain their explicit driver/mount-specific contracts.
  exFAT/VFAT remain a portable subset, not full POSIX parity. Device-boundary
  metadata and destination tests must still delegate safely.
- OpenZFS and NFS remain separately labelled experimental coverage until their
  own complete bounded matrices pass. Do not turn earlier incomplete guest runs
  into release evidence. No Windows/ReFS support is inferred from Linux NTFS.
- Exercise minimum Git 2.40 and the current lab Git on native Linux filesystems.
  Record kernels, toolchains, mount options, expected native/fallback behavior,
  executed test counts and exit codes as machine-readable local run data.
- Use only owned images/mounts. Never format real devices, change shared host
  kernel modules, fill the user's primary disk or run benchmark I/O alongside
  correctness stress. Correctness fixtures/images/logs remain under target/.
- Frozen candidates and harnesses must be committed before publishable campaigns.
  Compare stock Git, a precisely labelled v0.4 build and the candidate on the same
  target, input commits, source/donor state, workload and measurement boundaries.
  A source-built release baseline is not silently called the published archive.
- Benchmark primary native targets separately. At least three paired rounds,
  bounded concurrency (initially 1/4/16), explicit total/per-point time and free
  disk budgets, and no retry of a failed measured point. Stop on correctness or
  unexplained errors. Loopback allocation is not bare-device capacity evidence.
- Include ignored-donor state as a named workload/control when the harness can
  faithfully preserve it. A seed created through Git clone discards ignored data;
  do not claim that such a seed measures the original donor's ignored-file cost.
- Mac reproduction resource tools (sw_vers/sysctl/time -l), ARM archives and
  machine-specific setup are not portable Linux measurements. Reuse contracts
  and verification, not those commands or Mac timing/allocation conclusions.
- Store reviewed compact results in the RFD0020 layout; preserve raw hashes and
  interrupted outcomes. Update public tables only from complete comparable groups
  and only when publication is explicitly authorized.

## Alternatives and open boundaries

Running performance campaigns immediately is quicker but can measure safe fallback
instead of the intended native path or obscure a correctness regression. Requiring
all imaginable filesystems to behave identically is impossible and would erase
honest support boundaries. The release gate is the explicitly claimed support
matrix, with experimental and portable subsets visible rather than promoted.

Mac results must come from owned Mac runs; Linux results cannot certify APFS.
Cross-host coordination, campaign disk/runtime budgets and a final release source
identity are required before launching a release-wide benchmark campaign. Primary
target campaigns use the shared checkout plan and result gate; APFS and
case-sensitive APFS have distinct adapters. Each campaign records a minimum free
space floor, checked before preparation and each point, in addition to its total
and per-point deadlines. No builds, correctness stress, overlapping campaigns on
the same backing disk, or harness changes may run during measurement.

Refreshing primary-target benchmark data does not certify still-pending
compatibility or experimental matrices, and does not by itself authorize v0.5
publication. Synthetic coverage campaigns must remain labelled synthetic rather
than replacing the existing real-repository claims.

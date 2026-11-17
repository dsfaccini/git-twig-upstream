# Linux CLI benchmarks

Question: does verified Linux CoW reduce actual worktree creation time and additional
filesystem allocation versus the installed stock Git? Correctness requires zero wrong
checkouts and source mutations. Time improvements are a measurement, not a promise.

## Build and inputs

```sh
cargo build --release --workspace --locked
# New paths only; deterministic xorshift bytes are not zero/compression fixtures.
target/release/twig-fixture target/inputs/byte-heavy/main 16 4194304
target/release/twig-fixture target/inputs/file-heavy/main 4096 1024
```

Use `--repo label=/absolute/path/to/repo` for public real repositories. The harness
pins HEAD and creates a new seed; original repositories are read-only inputs.
`--revision label=FULL_OID` pins the target. `--donor-revision label=FULL_OID`
can seed a different source commit. LF policies and builtin ident/encoding
exceptions and default nonrecursive gitlink directories are supported; regular-file
external filters and sparse checkout remain outside the native subset. Do not remove attributes just to label a modified
fixture an unmodified real repository.

## Isolated Linux environment

Run on Linux with Git 2.40+, `xfsprogs`, `btrfs-progs`, `util-linux`, `sudo`, and
`sha256sum`. Setup needs noninteractive permission to mount/unmount fresh loopback
images and change their mountpoint ownership. Run the harness unprivileged; do not
change the host's sudo policy for a benchmark. A disposable privileged Ubuntu
container is one option. Bind-mount the repository directory (including `main/`
and its sibling worktree) at the same absolute path so Git worktree metadata resolves.
Do not mount credentials or unrelated directories. Record the image ID/digest and
installed tool versions with the run. Rust compilation can happen outside the
container; export `TWIG_BENCH_RUST_VERSION="$(rustc --version)"` from that toolchain.

Loopback mount may need `/dev/loopN` device nodes in the container when the host
already uses all existing nodes. Never format or detach an unrelated loop device.
The harness formats only a newly created regular file and retains it after unmount.
`TWIG_BENCH_ROOT=1` permits direct mount commands in an explicitly root-run test
container; leave it unset for unprivileged measurements.

## Measure

Start with two worktrees and one paired round as a smoke test. Then commit the
harness/candidate, build release binaries, and run at least three paired rounds.
The timestamped raw output must not exist beforehand.

```sh
repo="$PWD/target/inputs/byte-heavy/main"
target/release/twig-real-bench --filesystem linux-xfs-image \
  --repo "byte-heavy=$repo" --concurrency 1 --worktrees 4 --repeats 3 \
  --image-gib 8 --output target/linux-results/linux-xfs-byte-c1.json
# Repeat with linux-btrfs-image and file-heavy/real public inputs.
# Ramp concurrency 1,4,16,64, up to128, keeping cohort sizes explicit.
target/release/twig-real-plot target/linux-results/linux-xfs-byte-c1.json
```

Keep in-progress outputs under ignored `target/` so raw files do not mark later
runs dirty. After the suite, copy publishable JSON/SVG into `bench/results/` and
commit them. `--note TEXT` records environment details and explicit budget stops.

Plots are SVG; percentile/allocation tables go to stdout, not evidence markdown.
Each filesystem/backend/repeat gets a fresh image, seed, warmup and registry.
Backend order alternates. JSON includes every attempt, native selection, exact
input commit/tree, candidate SHA-256, harness revision/dirty state, versions, CPU,
kernel, capacity, samples and allocation stabilization observations. Scratch
append-only completion JSONL preserves interrupted outcomes. Native Twig is
mandatory by default, including nonzero verified file-clone counts. Only an
explicit frozen fallback baseline may use `--require-native false`; its real
native flags and counts stay in the results, never relabeled as CoW.

Creation is the bounded cohort's wall time through the final CLI completion,
excluding final coordinator checkpoint/join work. Raw per-operation create latency,
first-status latency, harness CPU and observer wall time are separate. First status
and exhaustive byte/link/executable verification run only after all creates.
After verification, a nonzero byte in an existing regular file is changed privately;
its offset and file length are recorded. An all-empty/all-zero fixture cannot prove
existing-data-block CoW and reports that probe as not applicable.

Space is **additional isolated filesystem allocation after first status**, sampled
with statvfs after sync until stable or flagged unstable. It includes indexes,
metadata and retained staging. Shared data is counted once at filesystem level;
this is not summed file blocks, `du`, exact per-file exclusive allocation or host
image allocation. Btrfs statfs is an allocator estimate, not raw-device physical
accounting. Report observed ranges, negative deltas, failures and unstable snapshots.

Stop a ramp on correctness failure, unexplained errors, or an explicit disk/time
budget. Publish the stopping reason with raw data; a budget stop is not measured
maximum capacity. If a baseline cohort fails, retain its time/error records but do
not compare it as an equally complete successful cohort. Harness CPU and observer
lag help identify driver bottlenecks; compare the next level before calling a
flattening curve target saturation.

All images and fixtures remain under `target/real-images/`; disk use grows across
runs. Do not benchmark alongside the correctness stress suite or other image I/O.
Results describe warm-cache loopback files on the recorded backing filesystem and
a shared host, not cold-cache or bare-device performance. See
[RFD0012](../docs/rfds/RFD0012-linux-correctness-and-measurement.md).

## Local coverage and before/after ramp

Freeze the baseline binary before rebuilding the candidate. Commit the harness
and candidate before running. No source checkout, image, binary or verbose log
belongs in the committed results.

```sh
# Inside the unprivileged Linux lab, with mount permission already configured:
target/release/twig-linux-coverage \
  --baseline target/baselines/870f52e/git-twig \
  --baseline-commit 870f52e02f5cf168f17fe5646da7312fc626225f \
  --output target/linux-coverage/NEW_RUN \
  --rounds 3 --max-concurrency 16 \
  --budget-seconds 1800 --point-timeout-seconds 180
# Smaller staging run: --filesystems xfs --profiles cross-revision,mixed-builtins
#                         --rounds 1 --max-concurrency 1
```

The driver rotates stock Git, frozen Twig and candidate positions by round. It
covers unchanged incompressible data, changed target revisions, mixed builtin
conversions, automatic-CRLF binary sharing, nonrecursive gitlinks and many-file
concurrency levels. A configured ramp cap or budget is
not a measured capacity ceiling. Every point saves schema-4 raw measurements;
manifest.json records pins, binary hashes, ordering, correctness, allocation
stability and any stopping reason. The baseline may delegate where the candidate
is newly supported; that remains visible rather than being called native CoW.

Warmups have separate Git registries. A different-revision oracle is a separate
clone outside the measured image/registry, so neither can become a perfect donor
and inflate apparent coverage. Later measured creates may legitimately reuse an
earlier completed target. Source and target commits/trees are recorded separately.
The private-write probe uses the largest nonzero-data file present in both the target and original
donor, and all original donor files are checked afterwards. Incorrect points stop
the run without retry; unstable allocation remains data, not a publishable win.

Benchmark subprocesses explicitly clear inherited Git repository/index redirects,
injected config and trace destinations, and disable external template/config
inheritance. This isolation applies to benchmark fixtures, not production Twig.
Empty gitlink directories are checked for type and emptiness; nested module data
is not counted as worktree payload.

Collect a compact snapshot (raw JSON measurements and interrupted diagnostics,
not source files/images) with `python3 bench/coverage_snapshot.py --manifest
target/linux-coverage/<run>/manifest.json --output <snapshot.json> --csv
<summary.csv>`. Add `--interrupted-progress <retained-image>.creation.jsonl`
when exactly one point was interrupted. Rebuild the CSV or local SVG without
uncommitted raw files using `--snapshot <snapshot.json> --csv <new-summary.csv>
--svg <local-chart.svg>`. Outputs refuse to overwrite existing files.

Driver manifest v2 records effective timeout seconds and elapsed start/finish
times per point. A point gets the smaller of its configured timeout and the
remaining total budget; v1 does not record that effective value. Partial
creation checkpoints are diagnostic, unverified outcomes, not performance data.
The summary includes sample counts; nearest-rank percentiles from small samples
do not establish population tail latency. Charts use complete groups only.

Runs are local only. Updating README/site numbers, pushing or releasing is a
separate user decision. See [RFD0015](../docs/rfds/RFD0015-linux-donor-coverage.md).

## ext4 and OverlayFS compatibility

These are correctness checks, not allocation/latency benchmarks. The checkout
matrix can run on any owned fixture directory using `TWIG_TEST_FIXTURE_ROOT`.
Use `TWIG_TEST_REQUIRE_NATIVE=1` only after independently checking that the layout
supports `cp --reflink=always`; do not set it (even to an empty string) for ext4.

For OverlayFS choose a new absolute `lab` path on the backing filesystem being
tested. Use ext4, reflink-enabled XFS or Btrfs; overlay upperdir/workdir must share
a filesystem. Mounting requires Linux CAP_SYS_ADMIN or noninteractive sudo.
Never change lowerdir behind a mounted overlay. Prepare the fixture first:

```sh
cargo build --workspace --locked
lab=/absolute/owned/new-overlay-lab
mkdir "$lab"
mkdir "$lab/"{lower,upper,work,merged}
target/debug/twig-overlay-fixture "$lab/lower/case"
sudo -n mount -t overlay overlay -o "lowerdir=$lab/lower,upperdir=$lab/upper,workdir=$lab/work" "$lab/merged"

# Upper-layer repositories: full differential/argument/policy suite.
TWIG_TEST_FIXTURE_ROOT="$lab/merged/fresh-fixtures" cargo test -p git-twig --locked

# Lower-layer repository: Twig goes first, then a Git-vs-Twig oracle; HEAD and
# HEAD^, builtin conversions, modes, links, private writes, and source/lower
# index/config/HEAD/data preservation. Use a fresh case for each Git version.
TWIG_TEST_OVERLAY_LOWER_CASE="$lab/merged/case" \
TWIG_TEST_OVERLAY_LOWER_ORACLE="$lab/lower/case" \
cargo test -p git-twig --test worktrees --locked \
  filesystem_coverage::overlay_lower_layer_checkout_matches_git_without_mutating_lower_inputs -- --exact

sudo -n umount "$lab/merged"
```

Keep local fixtures after unmount. On failure, inspect retained state before
retrying. CI creates fresh isolated backing images and always attempts overlay
unmount before backing-image unmount. See
[RFD0017](../docs/rfds/RFD0017-filesystem-capability-and-overlay-coverage.md).
OpenZFS needs a ZFS-enabled Linux kernel, tools and an owned dataset; absence is
unverified coverage, not a passing fallback or native-support result.

## NTFS on Linux

Test kernel `ntfs3` and FUSE `ntfs-3g` independently; neither tested configuration
accepts the reflink probe. This establishes fallback correctness, not Windows
compatibility or NTFS disk-sharing benefits. Install `ntfs-3g` for its formatter
and FUSE driver. Use a fresh owned image for each driver, never a real NTFS volume:

```sh
lab=/absolute/owned/new-ntfs-lab
mkdir "$lab"
truncate -s 1G "$lab/volume.img"
mkfs.ntfs -F -Q -L TwigTest "$lab/volume.img"
mkdir "$lab/mount"
# Kernel driver, when available:
sudo -n mount -t ntfs3 -o "loop,uid=$(id -u),gid=$(id -g),acl" "$lab/volume.img" "$lab/mount"
# Or, on a separately formatted image, the FUSE driver:
# sudo -n ntfs-3g "$lab/volume.img" "$lab/mount" -o permissions,allow_other
# sudo -n chown "$(id -u):$(id -g)" "$lab/mount"

TWIG_TEST_FIXTURE_ROOT="$lab/mount/fixtures" cargo test -p git-twig --locked
sudo -n umount "$lab/mount"
```

Do not set `TWIG_TEST_REQUIRE_NATIVE` for these fallback configurations. The
mounts intentionally enable POSIX permissions: results do not cover arbitrary
uid/umask/no-permissions mounts. Record the driver, kernel/tool version and mount
options separately. Retain local images and fixture/log data after unmount.

Linux NTFS with UTF-8 pathname conversion rejects invalid-UTF-8 names. The
raw-path test inserts such a name directly into the Git index, then requires
Twig to match stock Git's failure and cleanup. It does not silently skip the
path or relabel the filesystem restriction as a successful checkout. File-shape
private-write tests use representable names so empty/large/sparse coverage is
still exercised on these filesystems.

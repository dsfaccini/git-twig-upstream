# git twig 🌱

With twig, your agents can create cheap lightweight worktrees and use up to 97% less space on disk. Imagine all the worktrees you could now make!

## Install

```sh
brew tap leostera/git-twig https://github.com/leostera/git-twig
brew install leostera/git-twig/git-twig
```

Or install from crates.io with Rust 1.95+ and Git 2.40+:

```sh
cargo install git-twig --locked
```

For local development: `cargo install --path crates/git-twig --locked`.

## Use

With your source checkout in `main/`:

```sh
git -C main twig new -b feat/x ../feat-x HEAD
git -C main twig list
```

Published v0.3.0 requires the source checkout's current `HEAD`. Development builds
can reuse matching files from nearby worktrees for other revisions too.
Short help works outside a checkout: `git twig -h` or `git twig new --help`.

For coding agents: `git twig skill` prints the bundled skill.

Native CoW is verified on macOS/APFS and Linux Btrfs/reflink-enabled XFS,
including the tested OverlayFS layouts below.
Creates ordinary linked worktrees from committed files; local changes and ignored
files aren't copied. Unsupported filesystems (including typical ext4), options and
checkout semantics use `git worktree`. Set `TWIG_TRACE=1` to see backend selection.

The selected donor, destination and Git metadata must share a clone-capable filesystem for
native CoW. Twig verifies cloned files against the requested commit; writes are
private, never hardlinked to source. Staging lives under the common Git directory
in `twigs/staging` and is removed after success. Failed/interrupted attempts retain
staging and may leave a partial registered worktree; inspect before retrying.

## Filesystem support

| Platform | Filesystem | CoW / fallback | Verification |
|---|---|---|---|
| macOS | APFS | Native `clonefile` | Tests, CI and allocation benchmarks |
| Linux | Btrfs | Native `FICLONE` | Tests, CI and allocation benchmarks |
| Linux | XFS with `reflink=1` | Native `FICLONE` | Tests, CI and allocation benchmarks |
| Linux | Typical ext4 | Stock Git fallback; no reflink savings | Full checkout test matrix |
| Linux | tmpfs | Stock Git fallback; no reflink savings | Checkout matrix and mixed-mount isolation |
| Linux | exFAT / VFAT | Stock Git fallback; filesystem limitations apply | Portable checkout subset, not full POSIX semantics |
| Linux | XFS with `reflink=0` | Stock Git fallback expected | Not separately verified |
| Linux | OverlayFS over ext4 | Stock Git fallback | Checkout matrix and lower-layer preservation tests |
| Linux | OverlayFS over reflink-enabled XFS / Btrfs | Native `FICLONE` in tested layouts | Checkout matrix, copy-up and private-write tests |
| Linux | NTFS (`ntfs3`, ACL-enabled) | Stock Git fallback; no reflink savings | Checkout matrix; UTF-8 name restrictions apply |
| Linux | NTFS (`ntfs-3g`, permissions enabled) | Stock Git fallback; no reflink savings | Checkout matrix; UTF-8 name restrictions apply |
| Linux | OpenZFS | Requires usable Linux block-cloning support | Not verified |
| Linux | NFSv4.2 | Depends on client/server clone support | Not verified |
| Linux | bcachefs | Exploratory; no support claim | Not verified |

Linux uses the actual clone operation, not a filesystem-name allowlist. Clone
refusals before registration fall back to stock Git; failures after registration
retain partial state for inspection. An accepted clone does not guarantee useful
disk savings, especially for tiny files. Verification covers the tested setups,
not every kernel, mount option or checkout policy. OverlayFS coverage includes
fresh upper-layer repositories and repositories seeded in lowerdir before mount;
it is not an allocation benchmark. See [Linux test setup](bench/linux.md).
Checkout policy coverage below is separate from filesystem capability.

## Checkout policies

Version 0.4.0 supports common LF policies such as `text=auto eol=lf`.
They compare private clones to raw target blobs and let Git write exceptional
files, retaining sharing for the rest. Development builds also choose a donor
across revisions and let Git write builtin ident/encoding exceptions. External
filters and sparse checkout still delegate. Submodules are Git-written empty
directories, never copied or recursively initialized from a donor.
See the [changelog](CHANGELOG.md) for released fixes and unreleased coverage.

With `TWIG_TRACE=1`, native creation reports verified-clone and Git-written path
counts. Delegation reports its specific cause; an attribute refusal names the
path, attribute, and value (for example `filter="unspecified" on "file.txt"`).
Do not override repository attributes with `-text` just to force the fast path:
that changes Git checkout semantics rather than proving the bytes are correct.

## Benchmarks

<!-- twig-bench:start -->

<!-- Generated from bench/results/readme.json by twig-readme-table. Do not edit numbers. -->

| Repo | `git worktree` | `git twig` | Improvement |
|---|---|---|---|
| [Workers starter (10 sequential)](bench/results/2026-11-17-final/workers-starter-host.json) | 456ms / 592 KiB | 4.27s / 308 KiB | 9.37× slower / **1.9× less space** |
| [git-twig (10 sequential)](bench/results/2026-11-17-final/twig-host.json) | 422ms / 5.2 MiB | 4.18s / 508 KiB | 9.91× slower / **10.6× less space** |
| [Axo](bench/results/2026-11-17-final/axo-host.json) | 400ms / 30.8 MiB | 948ms / 1.2 MiB | 2.37× slower / **26.7× less space** |
| [Linux kernel](bench/results/2026-11-17-final/linux-images.json) | 40.56s / 1.8 GiB | 31.32s / 44.7 MiB | 1.29× faster / **41.9× less space** |
| [OpenClaw](bench/results/2026-11-17-final/openclaw-host.json) | 8.58s / 919 MiB | 8.80s / 31.1 MiB | 1.03× slower / **29.5× less space** |
| [Pulumi docs](bench/results/2026-11-17-issue5/after-host.json) | 4.32s / 1.2 GiB | 3.64s / 7.9 MiB | 1.19× faster / **155.8× less space** |

Each cell is **creation time / additional disk space**. Batch sizes differ; creation excludes first status. † Includes failed Git attempts. [Setup and raw results](bench/results/readme-details.md).

<!-- twig-bench:end -->

For Linux CLI time/allocation measurements, see [Linux benchmarks](bench/linux.md).

## Develop

```sh
cargo fmt --all --check
cargo clippy --workspace --all-targets --locked -- -D warnings
cargo test --workspace --locked
```

Linux CI tests the host filesystem plus reflink-enabled XFS and Btrfs images,
requiring native CoW on both. Locally on a supported Linux filesystem, run
`TWIG_TEST_REQUIRE_NATIVE=1 cargo test -p git-twig`. Tests and benchmarks retain
fixtures under `target/`; disk use grows. See the
[design contract](docs/rfds/RFD0001-verified-cow-worktrees.md),
[Linux correctness boundaries](docs/rfds/RFD0012-linux-correctness-and-measurement.md),
[changelog](CHANGELOG.md), and [release operations](docs/releases.md).

[MIT](LICENSE)

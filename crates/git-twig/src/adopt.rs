//! Experimental existing-worktree sharing; never replace a worktree file.
use anyhow::{Context, Result, bail, ensure};
use std::{
    ffi::OsString,
    path::{Path, PathBuf},
};

const USAGE: &str =
    "prototype: git twig adopt [--dry-run | --prepare | --dedupe] <linked-worktree>";

#[derive(Clone, Copy, PartialEq, Eq)]
enum Mode {
    Inspect,
    Prepare,
    Dedupe,
}

struct Request {
    mode: Mode,
    target: PathBuf,
}
impl Request {
    fn parse(args: &[OsString]) -> Result<Self> {
        let mut mode = Mode::Inspect;
        let mut selected = false;
        let mut target = None;
        for argument in args {
            let choice = match argument.to_str() {
                Some("--dry-run") => Some(Mode::Inspect),
                Some("--prepare") => Some(Mode::Prepare),
                Some("--dedupe") => Some(Mode::Dedupe),
                _ => None,
            };
            if let Some(choice) = choice {
                ensure!(!selected, "choose exactly one adoption mode; {USAGE}");
                mode = choice;
                selected = true;
            } else {
                ensure!(
                    !argument.is_empty() && !argument.to_string_lossy().starts_with('-'),
                    "{USAGE}"
                );
                ensure!(target.is_none(), "{USAGE}");
                target = Some(PathBuf::from(argument));
            }
        }
        Ok(Self {
            mode,
            target: target.context(USAGE)?,
        })
    }
}

pub(super) fn run(cwd: &Path, args: &[OsString]) -> Result<i32> {
    let request = Request::parse(args)?;
    #[cfg(unix)]
    return unix::run(cwd, request);
    #[cfg(not(unix))]
    {
        let _ = (cwd, request);
        bail!("adoption prototype requires Unix");
    }
}

#[cfg(unix)]
mod unix {
    use super::*;
    use std::{
        collections::HashSet,
        ffi::CString,
        fs::{self, File, OpenOptions},
        io::Write,
        os::{
            fd::{AsRawFd, FromRawFd},
            unix::{
                ffi::OsStrExt,
                fs::{DirBuilderExt, MetadataExt, OpenOptionsExt},
            },
        },
        path::Component,
        time::{SystemTime, UNIX_EPOCH},
    };

    use crate::registry::git;

    fn repository(path: &Path) -> Result<PathBuf> {
        let root = crate::output_path(
            crate::checked(git(path).args(["rev-parse", "--show-toplevel"]))?.stdout,
        )?;
        Ok(fs::canonicalize(root)?)
    }
    fn common(root: &Path) -> Result<PathBuf> {
        Ok(fs::canonicalize(crate::output_path(
            crate::checked(git(root).args([
                "rev-parse",
                "--path-format=absolute",
                "--git-common-dir",
            ]))?
            .stdout,
        )?)?)
    }
    fn directory(path: &Path) -> Result<File> {
        Ok(OpenOptions::new()
            .read(true)
            .custom_flags(libc::O_DIRECTORY | libc::O_NOFOLLOW)
            .open(path)?)
    }
    /// Retain parent descriptors while opening each component, never following
    /// a symlink into a donor's or target's unrelated directory tree.
    fn open_relative(root: &File, relative: &Path, writable: bool) -> Result<File> {
        let mut parent = root.try_clone()?;
        let mut components = relative.components().peekable();
        ensure!(components.peek().is_some(), "empty tracked path");
        while let Some(component) = components.next() {
            let Component::Normal(name) = component else {
                bail!("unsafe tracked path: {relative:?}")
            };
            let name = CString::new(name.as_bytes())?;
            let leaf = components.peek().is_none();
            let flags = libc::O_NOFOLLOW
                | libc::O_CLOEXEC
                | libc::O_NONBLOCK
                | if leaf {
                    if writable {
                        libc::O_RDWR
                    } else {
                        libc::O_RDONLY
                    }
                } else {
                    libc::O_RDONLY | libc::O_DIRECTORY
                };
            // SAFETY: live parent fd and NUL-terminated component. Ownership of
            // the new descriptor transfers exactly once to File.
            let fd = unsafe { libc::openat(parent.as_raw_fd(), name.as_ptr(), flags) };
            if fd < 0 {
                return Err(std::io::Error::last_os_error().into());
            }
            parent = unsafe { File::from_raw_fd(fd) };
        }
        Ok(parent)
    }

    struct Pair {
        donor: File,
        target: File,
        bytes: u64,
    }
    fn matching_pair(donor: &File, target: &File, relative: &Path, mode: Mode) -> Result<Pair> {
        let donor = open_relative(donor, relative, false)?;
        let target = open_relative(target, relative, mode == Mode::Dedupe)?;
        let a = donor.metadata()?;
        let b = target.metadata()?;
        ensure!(a.is_file() && b.is_file(), "not two regular files");
        ensure!(a.dev() == b.dev(), "different devices");
        ensure!(a.ino() != b.ino(), "same inode");
        ensure!(a.nlink() == 1 && b.nlink() == 1, "multiply-linked file");
        ensure!(
            a.len() > 0 && a.len() == b.len(),
            "empty or unequal lengths"
        );
        let pair = Pair {
            donor,
            target,
            bytes: a.len(),
        };
        ensure!(
            equal(&pair.donor, &pair.target, pair.bytes)?,
            "different current bytes"
        );
        Ok(pair)
    }

    /// Pread leaves shared descriptor offsets untouched. A size check is only
    /// an early rejection; every accepted byte is compared, followed by EOF.
    fn equal(a: &File, b: &File, length: u64) -> Result<bool> {
        use std::os::unix::fs::FileExt;
        let mut left = [0u8; 65536];
        let mut right = [0u8; 65536];
        let mut offset = 0;
        while offset < length {
            let count = (length - offset).min(left.len() as u64) as usize;
            a.read_exact_at(&mut left[..count], offset)?;
            b.read_exact_at(&mut right[..count], offset)?;
            if left[..count] != right[..count] {
                return Ok(false);
            }
            offset += count as u64;
        }
        Ok(a.read_at(&mut left[..1], length)? == 0 && b.read_at(&mut right[..1], length)? == 0)
    }

    fn prepare_directory(common: &Path) -> Result<PathBuf> {
        // Do not reuse a path, remove previous attempts, or touch checkout files.
        let path = common.join(format!(
            "twig-adopt-prototype-{}-{}",
            std::process::id(),
            SystemTime::now().duration_since(UNIX_EPOCH)?.as_nanos()
        ));
        fs::DirBuilder::new().mode(0o700).create(&path)?;
        ensure!(
            fs::symlink_metadata(&path)?.mode() & 0o777 == 0o700,
            "filesystem cannot protect private preparation scratch; empty directory retained at {path:?}"
        );
        eprintln!(
            "git-twig: prepared candidates retained at {path:?}; existing files will NOT be replaced"
        );
        Ok(path)
    }

    #[cfg(target_os = "macos")]
    fn clone_descriptor(source: &File, destination: &Path) -> Result<()> {
        let destination = CString::new(destination.as_os_str().as_bytes())?;
        // SAFETY: live source fd, NUL-terminated fresh destination; Darwin's
        // fclonefileat clones this inode, not a racy pathname lookup of donor.
        let result = unsafe {
            libc::fclonefileat(
                source.as_raw_fd(),
                libc::AT_FDCWD,
                destination.as_ptr(),
                0x0008,
            )
        };
        ensure!(
            result == 0,
            "clone failed: {}",
            std::io::Error::last_os_error()
        );
        Ok(())
    }
    #[cfg(target_os = "linux")]
    fn clone_descriptor(source: &File, destination: &Path) -> Result<()> {
        let target = OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(destination)?;
        // SAFETY: both descriptors are live regular files; destination is new.
        let result = unsafe { libc::ioctl(target.as_raw_fd(), libc::FICLONE, source.as_raw_fd()) };
        ensure!(
            result == 0,
            "clone failed: {}",
            std::io::Error::last_os_error()
        );
        Ok(())
    }
    #[cfg(not(any(target_os = "macos", target_os = "linux")))]
    fn clone_descriptor(_: &File, _: &Path) -> Result<()> {
        bail!("native cloning unavailable")
    }

    pub(super) fn run(cwd: &Path, request: Request) -> Result<i32> {
        crate::registry::ensure_environment()?;
        if request.mode == Mode::Dedupe {
            ensure!(
                cfg!(all(
                    target_os = "linux",
                    any(target_arch = "x86_64", target_arch = "aarch64")
                )),
                "in-place adoption is Linux-only; APFS live file replacement is intentionally unsupported"
            );
        }
        let donor_path = repository(cwd)?;
        let target_path = fs::canonicalize(cwd.join(&request.target))?;
        ensure!(
            repository(&target_path)? == target_path,
            "target must be the worktree root"
        );
        ensure!(
            donor_path != target_path,
            "donor and target must be distinct worktrees"
        );
        let common = common(&donor_path)?;
        ensure!(
            common == self::common(&target_path)?,
            "worktrees must share Git common metadata"
        );
        ensure!(
            fs::symlink_metadata(target_path.join(".git"))?.is_file(),
            "target must be a linked worktree"
        );
        let registered = crate::registry::read(&donor_path)?;
        ensure!(
            registered.iter().any(|record| {
                fs::canonicalize(&record.path).ok().as_ref() == Some(&target_path)
            }),
            "target is not a registered worktree"
        );
        let output = crate::checked(git(&target_path).args([
            "ls-files",
            "--cached",
            "--deduplicate",
            "-z",
        ]))?;
        let donor_files =
            crate::checked(git(&donor_path).args(["ls-files", "--cached", "--deduplicate", "-z"]))?;
        let donor_paths: HashSet<&[u8]> = donor_files
            .stdout
            .split(|b| *b == 0)
            .filter(|path| !path.is_empty())
            .collect();
        let donor = directory(&donor_path)?;
        let target = directory(&target_path)?;
        let stage = if request.mode == Mode::Prepare {
            Some(prepare_directory(&common)?)
        } else {
            None
        };
        let mut journal = stage
            .as_ref()
            .map(|path| {
                OpenOptions::new()
                    .write(true)
                    .create_new(true)
                    .open(path.join("manifest.txt"))
            })
            .transpose()?;
        let mut matched = 0u64;
        let mut matched_bytes = 0u64;
        let mut skipped = 0u64;
        let mut deduped_bytes = 0u64;
        for raw in output.stdout.split(|b| *b == 0).filter(|p| !p.is_empty()) {
            let relative = PathBuf::from(crate::native::os_string(raw.to_vec()));
            if !donor_paths.contains(raw) {
                skipped += 1;
                println!("skip {relative:?}: donor path is not tracked");
                continue;
            }
            let pair = match matching_pair(&donor, &target, &relative, request.mode) {
                Ok(pair) => pair,
                Err(error) => {
                    skipped += 1;
                    println!("skip {relative:?}: {error:#}");
                    continue;
                }
            };
            if let Some(stage) = &stage {
                let candidate = stage.join(format!("candidate-{matched:08}"));
                clone_descriptor(&pair.donor, &candidate)?;
                ensure!(
                    equal(&File::open(&candidate)?, &pair.target, pair.bytes)?,
                    "candidate changed relative to target; retained at {candidate:?}"
                );
                let journal = journal.as_mut().expect("stage owns journal");
                writeln!(
                    journal,
                    "{candidate:?} target={relative:?} logical_bytes={}",
                    pair.bytes
                )?;
                journal.flush()?;
            }
            if request.mode == Mode::Dedupe {
                deduped_bytes += dedupe(&pair)?;
            }
            matched += 1;
            matched_bytes += pair.bytes;
            println!("match {relative:?}: {} logical bytes", pair.bytes);
        }
        println!(
            "prototype: matched_files={matched} matched_logical_bytes={matched_bytes} skipped_files={skipped} kernel_deduped_bytes={deduped_bytes}; physical savings NOT measured"
        );
        if request.mode != Mode::Dedupe {
            println!("existing worktree files and index were not replaced or written");
        }
        Ok(0)
    }

    #[cfg(all(
        target_os = "linux",
        any(target_arch = "x86_64", target_arch = "aarch64")
    ))]
    fn dedupe(pair: &Pair) -> Result<u64> {
        #[repr(C)]
        struct Info {
            fd: i64,
            offset: u64,
            bytes: u64,
            status: i32,
            reserved: u32,
        }
        #[repr(C)]
        struct Range {
            offset: u64,
            length: u64,
            count: u16,
            reserved1: u16,
            reserved2: u32,
            info: Info,
        }
        // Linux UAPI: _IOWR(0x94, 54, struct file_dedupe_range), whose
        // fixed header is 24 bytes; the single info entry is 32 bytes.
        const REQUEST: libc::c_ulong = 0xc0189436;
        const _: () = {
            assert!(std::mem::size_of::<Range>() == 56);
            assert!(std::mem::size_of::<Info>() == 32);
            assert!(std::mem::offset_of!(Range, info) == 24);
        };
        let mut offset = 0;
        while offset < pair.bytes {
            let length = (pair.bytes - offset).min(16 * 1024 * 1024);
            let mut range = Range {
                offset,
                length,
                count: 1,
                reserved1: 0,
                reserved2: 0,
                info: Info {
                    fd: pair.target.as_raw_fd().into(),
                    offset,
                    bytes: 0,
                    status: 0,
                    reserved: 0,
                },
            };
            // SAFETY: Range has the UAPI layout and space for exactly one info
            // entry; both file descriptors live throughout the synchronous call.
            let status = unsafe { libc::ioctl(pair.donor.as_raw_fd(), REQUEST, &mut range) };
            ensure!(
                status == 0,
                "dedupe syscall failed after {offset} bytes: {}",
                std::io::Error::last_os_error()
            );
            ensure!(
                range.info.status == 0,
                "dedupe range status {} after {offset} bytes (changed/unsupported range)",
                range.info.status
            );
            ensure!(
                range.info.bytes > 0 && range.info.bytes <= length,
                "invalid dedupe progress"
            );
            offset += range.info.bytes;
        }
        Ok(offset)
    }

    #[cfg(all(
        test,
        target_os = "linux",
        any(target_arch = "x86_64", target_arch = "aarch64")
    ))]
    #[test]
    #[ignore = "requires independently provisioned XFS/Btrfs; run with --include-ignored"]
    fn kernel_rejects_changed_bytes_after_a_successful_comparison() -> Result<()> {
        use std::os::unix::fs::FileExt;
        let root = std::env::var_os("TWIG_TEST_FIXTURE_ROOT")
            .map(PathBuf::from)
            .unwrap_or_else(|| {
                Path::new(env!("CARGO_MANIFEST_DIR")).join("../../target/test-fixtures")
            });
        let root = root.join(format!(
            "adopt-kernel-{}-{}",
            std::process::id(),
            SystemTime::now().duration_since(UNIX_EPOCH)?.as_nanos()
        ));
        fs::create_dir_all(&root)?;
        eprintln!("fixture retained: {root:?}");
        fs::write(root.join("donor"), vec![b'x'; 16384])?;
        fs::write(root.join("target"), vec![b'x'; 16384])?;
        let probe = std::process::Command::new("cp")
            .arg("--reflink=always")
            .arg(root.join("donor"))
            .arg(root.join("probe"))
            .output()?;
        if !probe.status.success() {
            ensure!(
                std::env::var_os("TWIG_TEST_REQUIRE_NATIVE").is_none(),
                "required independent reflink probe failed"
            );
            return Ok(());
        }
        let pair = Pair {
            donor: File::open(root.join("donor"))?,
            target: OpenOptions::new()
                .read(true)
                .write(true)
                .open(root.join("target"))?,
            bytes: 16384,
        };
        assert!(equal(&pair.donor, &pair.target, pair.bytes)?);
        let inode = pair.target.metadata()?.ino();
        pair.target.write_all_at(b"new edit", 4096)?;
        let error =
            dedupe(&pair).expect_err("kernel must not accept the stale equality observation");
        assert!(error.to_string().contains("range status 1"), "{error:#}");
        assert_eq!(pair.target.metadata()?.ino(), inode);
        let mut bytes = [0u8; 8];
        pair.target.read_exact_at(&mut bytes, 4096)?;
        assert_eq!(&bytes, b"new edit");
        pair.donor.read_exact_at(&mut bytes, 4096)?;
        assert_eq!(&bytes, b"xxxxxxxx");
        Ok(())
    }

    #[cfg(not(all(
        target_os = "linux",
        any(target_arch = "x86_64", target_arch = "aarch64")
    )))]
    fn dedupe(_: &Pair) -> Result<u64> {
        bail!("in-place deduplication unavailable")
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn request_modes_are_explicit_and_invalid_requests_fail() {
        for args in [
            vec![],
            vec!["--force", "target"],
            vec!["--prepare", "--dedupe", "target"],
            vec!["a", "b"],
        ] {
            assert!(
                Request::parse(&args.into_iter().map(OsString::from).collect::<Vec<_>>()).is_err()
            );
        }
        let request = Request::parse(&["target".into()]).unwrap();
        assert!(request.mode == Mode::Inspect);
    }
}

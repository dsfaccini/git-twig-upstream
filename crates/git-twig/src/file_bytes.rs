//! Descriptor-relative, no-symlink raw-byte inspection shared by adoption backends.
use anyhow::{Result, bail, ensure};
use std::{
    ffi::CString,
    fs::{File, OpenOptions},
    os::{
        fd::{AsRawFd, FromRawFd},
        unix::{ffi::OsStrExt, fs::OpenOptionsExt},
    },
    path::{Component, Path},
};

pub(super) fn directory(path: &Path) -> Result<File> {
    Ok(OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_DIRECTORY | libc::O_NOFOLLOW)
        .open(path)?)
}
/// Retain parent descriptors while opening each component, never following
/// a symlink into a donor's or target's unrelated directory tree.
pub(super) fn open_relative(root: &File, relative: &Path, writable: bool) -> Result<File> {
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

/// Pread leaves shared descriptor offsets untouched. A size check is only
/// an early rejection; every accepted byte is compared, followed by EOF.
pub(super) fn equal(a: &File, b: &File, length: u64) -> Result<bool> {
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

//! Target metadata is authoritative; donor metadata must never leak into a replacement.
use anyhow::{Context, Result, ensure};
use std::{
    collections::BTreeMap,
    ffi::{CString, c_void},
    fs::File,
    os::{fd::AsRawFd, macos::fs::MetadataExt as MacMetadataExt, unix::fs::MetadataExt},
};

const METADATA_LIMIT: usize = 1024 * 1024;
const ACL_TYPE_EXTENDED: libc::c_int = 0x100;
const SF_DATALESS: u32 = 0x4000_0000;

unsafe extern "C" {
    fn acl_get_fd_np(fd: libc::c_int, kind: libc::c_int) -> *mut c_void;
    fn acl_size(acl: *mut c_void) -> libc::ssize_t;
    fn acl_copy_ext(buffer: *mut c_void, acl: *mut c_void, size: libc::ssize_t) -> libc::ssize_t;
    fn acl_free(acl: *mut c_void) -> libc::c_int;
}
struct Acl(*mut c_void);
impl Drop for Acl {
    fn drop(&mut self) {
        // SAFETY: the handle came from acl_get_fd_np and is freed exactly once.
        unsafe {
            acl_free(self.0);
        }
    }
}
fn acl(file: &File) -> Result<Vec<u8>> {
    // SAFETY: file is a live descriptor; ACL_TYPE_EXTENDED is the public Darwin type.
    let value = unsafe { acl_get_fd_np(file.as_raw_fd(), ACL_TYPE_EXTENDED) };
    if value.is_null() {
        let error = std::io::Error::last_os_error();
        // Darwin reports ENOENT for an existing descriptor with no extended ACL.
        if error.raw_os_error() == Some(libc::ENOENT) {
            return Ok(Vec::new());
        }
        return Err(error).context("cannot read target ACL");
    }
    let value = Acl(value);
    // SAFETY: ACL handle remains owned and live through size/copy.
    let length = unsafe { acl_size(value.0) };
    ensure!(
        length >= 0 && length as usize <= METADATA_LIMIT,
        "unsupported ACL size"
    );
    let mut bytes = vec![0; length as usize];
    let copied = unsafe { acl_copy_ext(bytes.as_mut_ptr().cast(), value.0, length) };
    ensure!(copied == length, "cannot serialize target ACL");
    Ok(bytes)
}
fn xattrs(file: &File) -> Result<BTreeMap<Vec<u8>, Vec<u8>>> {
    // SAFETY: null/zero queries only the required name-list size.
    let length = unsafe { libc::flistxattr(file.as_raw_fd(), std::ptr::null_mut(), 0, 0) };
    ensure!(
        length >= 0 && length as usize <= METADATA_LIMIT,
        "unsupported xattr names"
    );
    let mut names = vec![0u8; length as usize];
    let actual =
        unsafe { libc::flistxattr(file.as_raw_fd(), names.as_mut_ptr().cast(), names.len(), 0) };
    ensure!(actual == length, "xattr names changed during inspection");
    let mut total = names.len();
    let mut result = BTreeMap::new();
    for raw in names.split(|b| *b == 0).filter(|p| !p.is_empty()) {
        ensure!(
            raw != b"com.apple.decmpfs",
            "compressed files are not compacted"
        );
        let name = CString::new(raw)?;
        let length = unsafe {
            libc::fgetxattr(
                file.as_raw_fd(),
                name.as_ptr(),
                std::ptr::null_mut(),
                0,
                0,
                0,
            )
        };
        ensure!(length >= 0, "cannot read xattr size");
        total = total
            .checked_add(length as usize)
            .context("xattr size overflow")?;
        ensure!(
            total <= METADATA_LIMIT,
            "target metadata exceeds 1 MiB limit"
        );
        let mut bytes = vec![0u8; length as usize];
        let actual = unsafe {
            libc::fgetxattr(
                file.as_raw_fd(),
                name.as_ptr(),
                bytes.as_mut_ptr().cast(),
                bytes.len(),
                0,
                0,
            )
        };
        ensure!(actual == length, "xattr changed during inspection");
        result.insert(raw.to_vec(), bytes);
    }
    Ok(result)
}

pub(super) fn ensure_private_directory(file: &File) -> Result<()> {
    let stat = file.metadata()?;
    // Darwin inherited ACLs can grant access despite mode 0700. Refuse them
    // before writing journals or candidate bytes; never chmod an existing parent.
    ensure!(
        stat.is_dir()
            && stat.mode() & 0o777 == 0o700
            && stat.uid() == unsafe { libc::geteuid() }
            && acl(file)?.is_empty(),
        "recovery directory is not private (owner, mode or inherited ACL)"
    );
    Ok(())
}

pub(super) fn ensure_supported_flags(file: &File) -> Result<()> {
    let flags = MacMetadataExt::st_flags(&file.metadata()?);
    ensure!(
        flags
            & (libc::UF_IMMUTABLE
                | libc::UF_APPEND
                | libc::UF_COMPRESSED
                | libc::SF_IMMUTABLE
                | libc::SF_APPEND
                | SF_DATALESS)
            == 0,
        "immutable, append-only, compressed or dataless file"
    );
    Ok(())
}

#[derive(Debug, PartialEq, Eq)]
pub(super) struct Metadata {
    mode: u32,
    uid: u32,
    gid: u32,
    mtime: (i64, i64),
    birthtime: (i64, i64),
    flags: u32,
    xattrs: BTreeMap<Vec<u8>, Vec<u8>>,
    acl: Vec<u8>,
}
impl Metadata {
    pub fn read(file: &File) -> Result<Self> {
        ensure_supported_flags(file)?;
        let stat = file.metadata()?;
        let flags = MacMetadataExt::st_flags(&stat);
        ensure!(
            flags
                & (libc::UF_IMMUTABLE
                    | libc::UF_APPEND
                    | libc::UF_COMPRESSED
                    | libc::SF_IMMUTABLE
                    | libc::SF_APPEND
                    | SF_DATALESS)
                == 0,
            "immutable, append-only, compressed or dataless target"
        );
        Ok(Self {
            mode: stat.mode(),
            uid: stat.uid(),
            gid: stat.gid(),
            mtime: (stat.mtime(), stat.mtime_nsec()),
            birthtime: (
                MacMetadataExt::st_birthtime(&stat),
                MacMetadataExt::st_birthtime_nsec(&stat),
            ),
            flags,
            xattrs: xattrs(file)?,
            acl: acl(file)?,
        })
    }
    pub fn copy_to(&self, target: &File, candidate: &File) -> Result<()> {
        // Only the new, private candidate is made writable/cleared of donor flags.
        // Existing target and donor permissions/flags are never changed.
        let cleared = unsafe { libc::fchflags(candidate.as_raw_fd(), 0) };
        ensure!(cleared == 0, "cannot clear candidate donor flags");
        let writable = unsafe { libc::fchmod(candidate.as_raw_fd(), 0o600) };
        ensure!(
            writable == 0,
            "cannot prepare private candidate permissions"
        );
        // SAFETY: both descriptors remain live; METADATA excludes COPYFILE_DATA.
        let copied = unsafe {
            libc::fcopyfile(
                target.as_raw_fd(),
                candidate.as_raw_fd(),
                std::ptr::null_mut(),
                libc::COPYFILE_METADATA,
            )
        };
        ensure!(
            copied == 0,
            "target metadata copy failed: {}",
            std::io::Error::last_os_error()
        );
        // copyfile preserves an earlier donor creation time rather than always
        // assigning the target's later creation time. Set it explicitly on the
        // private candidate, then verify all metadata again.
        let mut attributes = libc::attrlist {
            bitmapcount: libc::ATTR_BIT_MAP_COUNT,
            reserved: 0,
            commonattr: libc::ATTR_CMN_CRTIME,
            volattr: 0,
            dirattr: 0,
            fileattr: 0,
            forkattr: 0,
        };
        let mut birthtime = libc::timespec {
            tv_sec: self.birthtime.0,
            tv_nsec: self.birthtime.1,
        };
        // SAFETY: attrlist requests exactly one timespec and both buffers live for the call.
        let restored = unsafe {
            libc::fsetattrlist(
                candidate.as_raw_fd(),
                (&mut attributes as *mut libc::attrlist).cast(),
                (&mut birthtime as *mut libc::timespec).cast(),
                std::mem::size_of::<libc::timespec>(),
                0,
            )
        };
        ensure!(
            restored == 0,
            "cannot preserve target creation time: {}",
            std::io::Error::last_os_error()
        );
        ensure!(
            Self::read(target)? == *self,
            "target metadata changed during preparation"
        );
        ensure!(
            Self::read(candidate)? == *self,
            "candidate metadata is not identical to target metadata"
        );
        Ok(())
    }
}

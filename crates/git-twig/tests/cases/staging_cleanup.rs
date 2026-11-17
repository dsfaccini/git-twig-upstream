//! Donor immutability must not strand scratch, or ignored bytes, in Git metadata.
use super::*;

fn chflags(flags: &str, path: &Path) -> Result<()> {
    checked(
        command("/usr/bin/chflags", path.parent().unwrap())
            .arg(flags)
            .arg(path)
            .output()?,
    )?;
    Ok(())
}

/// Fixtures are retained, but must stay removable by an ordinary `rm -r`.
struct Unlock<'a>(&'a Path);
impl Drop for Unlock<'_> {
    fn drop(&mut self) {
        let _ = Command::new("/usr/bin/chflags")
            .args(["-R", "nouchg"])
            .arg(self.0)
            .output();
    }
}

fn flags(path: &Path) -> Result<u32> {
    use std::os::macos::fs::MetadataExt;
    Ok(fs::symlink_metadata(path)?.st_flags())
}

#[test]
fn immutable_tracked_files_are_shared_as_ordinary_private_files() -> Result<()> {
    let f = Fixture::new()?;
    let _unlock = Unlock(&f.root);
    fs::create_dir(f.source.join("tree"))?;
    fs::write(f.source.join("tree/file"), "nested\n")?;
    git(&f.source, &["add", "."])?;
    git(&f.source, &["commit", "-m", "nested"])?;
    for name in ["hello.txt", "tree/file", "tree"] {
        chflags("uchg", &f.source.join(name))?;
    }
    let output = checked(f.add()?)?;
    native(&output);
    for name in ["hello.txt", "tree/file", "tree"] {
        assert_eq!(flags(&f.destination().join(name))?, 0, "flags for {name}");
        assert_ne!(flags(&f.source.join(name))?, 0, "source flags for {name}");
    }
    fs::write(f.destination().join("tree/file"), "private\n")?;
    assert_eq!(fs::read(f.source.join("tree/file"))?, b"nested\n");
    assert_eq!(f.stages()?, Vec::<PathBuf>::new());
    Ok(())
}

#[test]
fn immutable_ignored_files_are_pruned_from_staging() -> Result<()> {
    let f = Fixture::new()?;
    let _unlock = Unlock(&f.root);
    fs::create_dir_all(f.source.join("tree/ignored/deep"))?;
    fs::write(f.source.join("tree/file"), "nested\n")?;
    git(&f.source, &["add", "."])?;
    git(&f.source, &["commit", "-m", "nested"])?;
    fs::write(f.source.join("tree/ignored/deep/secret"), "secret\n")?;
    chflags("uchg", &f.source.join("tree/ignored/deep/secret"))?;
    chflags("uchg", &f.source.join("tree/ignored/deep"))?;
    let output = checked(f.add()?)?;
    native(&output);
    assert!(!f.destination().join("tree/ignored").exists());
    clean(&f.destination())?;
    // Ignored donor bytes must not survive anywhere under Git metadata.
    assert_eq!(f.stages()?, Vec::<PathBuf>::new());
    assert_eq!(
        fs::read(f.source.join("tree/ignored/deep/secret"))?,
        b"secret\n"
    );
    Ok(())
}

//! Blobless partial clones must never pay one promisor fetch per file.
use super::*;

const CHANGED: usize = 12;

/// A blobless clone of a two-commit history. Only HEAD's blobs are local.
fn blobless() -> Result<(Fixture, PathBuf)> {
    let f = Fixture::new()?;
    fs::create_dir(f.source.join("tree"))?;
    for revision in ["old", "new"] {
        for index in 0..CHANGED {
            fs::write(
                f.source.join(format!("tree/file-{index}")),
                format!("{revision} {index}\n"),
            )?;
        }
        git(&f.source, &["add", "."])?;
        git(&f.source, &["commit", "-m", revision])?;
    }
    git(&f.source, &["config", "uploadpack.allowFilter", "true"])?;
    let url = format!("file://{}", f.source.display());
    fs::create_dir(f.root.join("partial"))?;
    git(
        &f.root,
        &["clone", "--filter=blob:none", &url, "partial/main"],
    )?;
    let clone = f.root.join("partial/main");
    Ok((f, clone))
}

fn missing_objects(clone: &Path) -> Result<usize> {
    let listing = git(
        clone,
        &["rev-list", "--objects", "--all", "--missing=print"],
    )?
    .stdout;
    Ok(listing
        .split(|byte| *byte == b'\n')
        .filter(|line| line.starts_with(b"?"))
        .count())
}

/// Run Twig while Git's own event trace records every promisor fetch it spawns.
fn traced_twig(clone: &Path, log: &Path, args: &[&str]) -> Result<(Output, usize)> {
    let output = checked(
        command(env!("CARGO_BIN_EXE_git-twig"), clone)
            .env("GIT_TRACE2_EVENT", log)
            .args(args)
            .output()?,
    )?;
    let fetches = fs::read_to_string(log)?
        .lines()
        .filter(|line| line.contains("\"child_start\"") && line.contains("\"fetch\""))
        .count();
    Ok((output, fetches))
}

#[test]
fn current_revision_shares_files_without_fetching() -> Result<()> {
    let (f, clone) = blobless()?;
    let missing = missing_objects(&clone)?;
    assert_eq!(missing, CHANGED, "only the old revision's blobs are absent");
    let (output, fetches) = traced_twig(
        &clone,
        &f.root.join("current.trace"),
        &["new", "--detach", "../current", "HEAD"],
    )?;
    native(&output);
    assert_eq!(fetches, 0, "{}", String::from_utf8_lossy(&output.stderr));
    assert_eq!(missing_objects(&clone)?, missing);
    clean(&f.root.join("partial/current"))
}

#[test]
fn missing_target_blobs_are_fetched_in_one_batch() -> Result<()> {
    let (f, clone) = blobless()?;
    let (output, fetches) = traced_twig(
        &clone,
        &f.root.join("old.trace"),
        &["new", "--detach", "../old", "HEAD~1"],
    )?;
    assert!(
        fetches <= 1,
        "{fetches} promisor fetches for {CHANGED} missing blobs: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    let destination = f.root.join("partial/old");
    for index in 0..CHANGED {
        assert_eq!(
            fs::read(destination.join(format!("tree/file-{index}")))?,
            format!("old {index}\n").as_bytes()
        );
    }
    assert_eq!(fs::read(destination.join("hello.txt"))?, b"hello\n");
    clean(&destination)
}

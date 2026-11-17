use super::{donor_coverage::Snapshot, *};

#[test]
fn raw_byte_paths_match_git_or_its_filesystem_rejection() -> Result<()> {
    use std::os::unix::ffi::OsStringExt;
    let f = Fixture::new()?;
    let name = std::ffi::OsString::from_vec(b"raw-\xff".to_vec());
    let representable = match fs::write(f.source.join(&name), b"hello\n") {
        Ok(()) => true,
        Err(error) if matches!(error.raw_os_error(), Some(libc::EINVAL | libc::EILSEQ)) => {
            eprintln!("filesystem rejects non-UTF-8 path before Twig: {error}");
            false
        }
        Err(error) => return Err(error.into()),
    };
    // Build the same Git tree without requiring the filesystem to represent its
    // raw name. Unsupported names must fail like Git, not silently disappear.
    let object = String::from_utf8(git(&f.source, &["rev-parse", "HEAD:hello.txt"])?.stdout)?;
    checked(
        command("git", &f.source)
            .args([
                "update-index",
                "--add",
                "--cacheinfo",
                "100644",
                object.trim(),
            ])
            .arg(&name)
            .output()?,
    )?;
    git(&f.source, &["commit", "-m", "raw name"])?;
    let index_before = fs::read(f.source.join(".git/index"))?;
    let stock = command("git", &f.source)
        .args(["worktree", "add", "--detach", "../stock", "HEAD"])
        .output()?;
    let candidate = f.add()?;
    assert_eq!(
        stock.status.success(),
        representable,
        "{}",
        String::from_utf8_lossy(&stock.stderr)
    );
    assert_eq!(
        candidate.status.success(),
        stock.status.success(),
        "{}",
        String::from_utf8_lossy(&candidate.stderr)
    );
    if representable {
        assert_eq!(
            Snapshot::capture(&f.root.join("stock"))?,
            Snapshot::capture(&f.destination())?
        );
        fs::write(f.destination().join(&name), b"private\n")?;
        assert_eq!(fs::read(f.source.join(&name))?, b"hello\n");
    } else {
        assert_eq!(candidate.status.code(), stock.status.code());
        assert_eq!(
            f.destination().try_exists()?,
            f.root.join("stock").try_exists()?
        );
    }
    assert_eq!(index_before, fs::read(f.source.join(".git/index"))?);
    assert_eq!(fs::read(f.source.join("hello.txt"))?, b"hello\n");
    Ok(())
}

// The lab seeds these repositories before mounting OverlayFS. Modifying lowerdir
// behind a mounted overlay is undefined; this test only reads it as an oracle.
#[cfg(target_os = "linux")]
#[test]
fn overlay_lower_layer_checkout_matches_git_without_mutating_lower_inputs() -> Result<()> {
    let Some(case) = std::env::var_os("TWIG_TEST_OVERLAY_LOWER_CASE") else {
        return Ok(());
    };
    let root = fs::canonicalize(case)?;
    let lower = fs::canonicalize(
        std::env::var_os("TWIG_TEST_OVERLAY_LOWER_ORACLE")
            .ok_or_else(|| anyhow::anyhow!("lower-layer case requires a lower oracle"))?,
    )?;
    ensure!(root != lower, "merged view and lower oracle must differ");
    let source = root.join("source");
    ensure!(
        source.is_dir(),
        "expected a preseeded lower-layer repository"
    );
    let original = Snapshot::capture(&source)?;
    let original_index = fs::read(source.join(".git/index"))?;
    let lower_files = Snapshot::capture(&lower.join("source"))?;
    let lower_index = fs::read(lower.join("source/.git/index"))?;
    let lower_config = fs::read(lower.join("source/.git/config"))?;
    let lower_head = fs::read(lower.join("source/.git/HEAD"))?;
    assert_eq!(original, lower_files);

    for (number, revision) in ["HEAD", "HEAD^"].into_iter().enumerate() {
        let twig_name = format!("../twig-lower-{number}");
        let stock_name = format!("../stock-lower-{number}");
        // Twig runs first: the matching data starts in lowerdir, not in an upper
        // worktree created by our stock-Git control.
        let output = checked(twig(&source, &["new", "--detach", &twig_name, revision])?)?;
        native(&output);
        git(
            &source,
            &["worktree", "add", "--detach", &stock_name, revision],
        )?;
        assert_eq!(
            Snapshot::capture(&root.join(format!("stock-lower-{number}")))?,
            Snapshot::capture(&root.join(format!("twig-lower-{number}")))?
        );
        assert_eq!(original, Snapshot::capture(&source)?);
        assert_eq!(original_index, fs::read(source.join(".git/index"))?);
    }
    let private = root.join("twig-lower-0/data.bin");
    let mut bytes = fs::read(&private)?;
    ensure!(!bytes.is_empty(), "fixture needs nonempty data.bin");
    bytes[0] ^= 0xff;
    fs::write(private, bytes)?;
    assert_eq!(original, Snapshot::capture(&source)?);
    assert_eq!(lower_files, Snapshot::capture(&lower.join("source"))?);
    assert_eq!(lower_index, fs::read(lower.join("source/.git/index"))?);
    assert_eq!(lower_config, fs::read(lower.join("source/.git/config"))?);
    assert_eq!(lower_head, fs::read(lower.join("source/.git/HEAD"))?);
    assert!(!lower.join("source/.git/worktrees").exists());
    Ok(())
}

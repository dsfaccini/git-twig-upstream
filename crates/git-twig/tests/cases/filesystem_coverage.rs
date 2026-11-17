use super::{donor_coverage::Snapshot, *};

// These contracts intentionally avoid requiring POSIX symlinks/chmod or raw-byte
// names, so removable-media filesystems are checked without hiding limitations.
#[test]
fn portable_regular_files_and_conversions_match_git() -> Result<()> {
    let f = Fixture::new()?;
    fs::write(
        f.source.join(".gitattributes"),
        "crlf text eol=crlf\nident ident\n",
    )?;
    fs::write(f.source.join("crlf"), "line\n")?;
    fs::write(f.source.join("ident"), "$Id$\n")?;
    fs::write(f.source.join("data.bin"), vec![42; 262144])?;
    git(&f.source, &["add", "."])?;
    git(&f.source, &["commit", "-m", "portable conversions"])?;
    let before = Snapshot::capture(&f.source)?;
    let index = fs::read(f.source.join(".git/index"))?;
    let reflinks = linux_reflinks_available(&f)?;
    for (number, revision) in ["HEAD", "HEAD^"].into_iter().enumerate() {
        let destination = format!("../portable-twig-{number}");
        let stock = format!("../portable-stock-{number}");
        let output = checked(twig(
            &f.source,
            &["new", "--detach", &destination, revision],
        )?)?;
        if !reflinks {
            assert!(String::from_utf8_lossy(&output.stderr).contains("stock Git:"));
        }
        git(
            &f.source,
            &["worktree", "add", "--detach", &stock, revision],
        )?;
        assert_eq!(
            Snapshot::capture(&f.root.join(format!("portable-stock-{number}")))?,
            Snapshot::capture(&f.root.join(format!("portable-twig-{number}")))?
        );
        fs::write(
            f.root.join(format!("portable-twig-{number}/hello.txt")),
            "private\n",
        )?;
        assert_eq!(before, Snapshot::capture(&f.source)?);
        assert_eq!(index, fs::read(f.source.join(".git/index"))?);
    }
    Ok(())
}

#[test]
fn portable_symlink_placeholders_match_git() -> Result<()> {
    let f = Fixture::new()?;
    git(&f.source, &["config", "core.symlinks", "false"])?;
    let object = String::from_utf8(git(&f.source, &["rev-parse", "HEAD:hello.txt"])?.stdout)?;
    git(
        &f.source,
        &[
            "update-index",
            "--add",
            "--cacheinfo",
            "120000",
            object.trim(),
            "link",
        ],
    )?;
    git(
        &f.source,
        &["commit", "-m", "portable symlink representation"],
    )?;
    git(&f.source, &["checkout-index", "--force", "link"])?;
    let before = Snapshot::capture(&f.source)?;
    checked(f.add()?)?;
    git(
        &f.source,
        &["worktree", "add", "--detach", "../stock", "HEAD"],
    )?;
    assert_eq!(
        Snapshot::capture(&f.root.join("stock"))?,
        Snapshot::capture(&f.destination())?
    );
    assert!(fs::symlink_metadata(f.destination().join("link"))?.is_file());
    assert_eq!(fs::read(f.destination().join("link"))?, b"hello\n");
    assert_eq!(before, Snapshot::capture(&f.source)?);
    Ok(())
}

#[test]
fn separate_git_metadata_on_another_filesystem_delegates() -> Result<()> {
    use std::os::unix::fs::MetadataExt;
    let Some(other) = std::env::var_os("TWIG_TEST_CROSS_FILESYSTEM_ROOT") else {
        return Ok(());
    };
    let f = Fixture::new()?;
    let parent = PathBuf::from(other).join(format!(
        "metadata-{}",
        f.root.file_name().unwrap().to_string_lossy()
    ));
    fs::create_dir(&parent)?;
    let admin = parent.join("admin");
    // Git cannot move an existing .git across devices with --separate-git-dir.
    // Preserve the initial fixture admin directory, then initialize this layout
    // directly on the other device rather than testing an invalid migration.
    fs::rename(f.source.join(".git"), f.root.join("original-admin"))?;
    checked(
        command("git", &f.source)
            .args(["init", "-b", "main", "--separate-git-dir"])
            .arg(&admin)
            .output()?,
    )?;
    git(&f.source, &["config", "user.name", "Fixture"])?;
    git(
        &f.source,
        &["config", "user.email", "fixture@example.invalid"],
    )?;
    git(&f.source, &["add", "."])?;
    git(&f.source, &["commit", "-m", "separate metadata seed"])?;
    assert_ne!(fs::metadata(&admin)?.dev(), fs::metadata(&f.source)?.dev());
    let before = Snapshot::capture(&f.source)?;
    let index = fs::read(admin.join("index"))?;
    let output = checked(f.add()?)?;
    assert!(String::from_utf8_lossy(&output.stderr).contains("stock Git:"));
    git(
        &f.source,
        &["worktree", "add", "--detach", "../stock", "HEAD"],
    )?;
    assert_eq!(
        Snapshot::capture(&f.root.join("stock"))?,
        Snapshot::capture(&f.destination())?
    );
    assert_eq!(before, Snapshot::capture(&f.source)?);
    assert_eq!(index, fs::read(admin.join("index"))?);
    fs::write(f.destination().join("hello.txt"), "private\n")?;
    assert_eq!(fs::read(f.source.join("hello.txt"))?, b"hello\n");
    Ok(())
}

#[test]
fn raw_byte_paths_match_git_or_its_filesystem_rejection() -> Result<()> {
    use std::os::unix::ffi::OsStringExt;
    let f = Fixture::new()?;
    let name = std::ffi::OsString::from_vec(b"raw-\xff".to_vec());
    let representable = match fs::write(f.source.join(&name), b"hello\n") {
        Ok(()) => true,
        // These UTF conversion failures occur on NTFS/exFAT. Stock Git must
        // independently reject the indexed name below; none becomes a skip.
        Err(error)
            if matches!(
                error.raw_os_error(),
                Some(libc::EINVAL | libc::EILSEQ | libc::EOVERFLOW)
            ) =>
        {
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

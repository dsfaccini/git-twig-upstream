use super::{donor_coverage::Snapshot, *};

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

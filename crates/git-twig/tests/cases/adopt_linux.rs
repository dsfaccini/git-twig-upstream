//! Adoption contracts shared by native and restricted Linux filesystems.
use super as adopt;
use super::*;
use anyhow::Context;

#[test]
fn inspection_and_failed_native_operations_preserve_portable_worktrees() -> Result<()> {
    let f = Fixture::new()?;
    fs::write(f.source.join("payload.bin"), vec![b'x'; 65536 + 37])?;
    fs::write(f.source.join("empty"), [])?;
    git(&f.source, &["add", "."])?;
    git(&f.source, &["commit", "-m", "portable adoption"])?;
    git(
        &f.source,
        &["worktree", "add", "--detach", "../feature", "HEAD"],
    )?;
    for root in [&f.source, &f.destination()] {
        fs::write(root.join("hello.txt"), b"identical dirty bytes\n")?;
    }
    let source = adopt::files(&f.source)?;
    let target = adopt::files(&f.destination())?;
    let indices = (adopt::index(&f.source)?, adopt::index(&f.destination())?);
    let registry = git(&f.source, &["worktree", "list", "--porcelain", "-z"])?.stdout;
    let clone_supported = linux_reflinks_available(&f)?;
    for mode in ["--dry-run", "--prepare", "--dedupe"] {
        let result = f.twig(&["adopt", mode, "../feature"])?;
        let stdout = String::from_utf8_lossy(&result.stdout);
        if mode == "--dry-run" {
            assert!(result.status.success(), "{result:?}");
            assert!(stdout.contains("match \"hello.txt\""), "{stdout}");
            assert!(stdout.contains("match \"payload.bin\""), "{stdout}");
            assert!(stdout.contains("skip \"empty\""), "{stdout}");
            assert!(adopt::stages(&f)?.is_empty());
        } else if mode == "--prepare" {
            assert_eq!(result.status.success(), clone_supported, "{result:?}");
            assert_eq!(adopt::stages(&f)?.len(), 1);
        } else if let Some(expected) = std::env::var_os("TWIG_TEST_DEDUPE_SUPPORTED") {
            let expected = expected
                .to_str()
                .context("dedupe capability must be UTF-8")?;
            ensure!(
                matches!(expected, "0" | "1"),
                "invalid independent dedupe capability"
            );
            assert_eq!(result.status.success(), expected == "1", "{result:?}");
            if expected == "1" {
                let bytes = stdout
                    .split("kernel_deduped_bytes=")
                    .nth(1)
                    .and_then(|s| s.split(';').next())
                    .context("missing dedupe byte counter")?
                    .parse::<u64>()?;
                assert!(bytes >= 65536 + 37);
            }
        }
        assert_eq!(adopt::files(&f.source)?, source);
        assert_eq!(adopt::files(&f.destination())?, target);
        assert_eq!(
            (adopt::index(&f.source)?, adopt::index(&f.destination())?),
            indices
        );
        assert_eq!(
            git(&f.source, &["worktree", "list", "--porcelain", "-z"])?.stdout,
            registry
        );
    }
    Ok(())
}

#[test]
fn cross_filesystem_layout_is_refused_and_sharing_preserves_current_data() -> Result<()> {
    let Some(other) = std::env::var_os("TWIG_TEST_CROSS_FILESYSTEM_ROOT") else {
        return Ok(());
    };
    let f = Fixture::new()?;
    let parent = PathBuf::from(other).join(f.root.file_name().unwrap());
    fs::create_dir_all(&parent)?;
    assert_ne!(fs::metadata(&f.source)?.dev(), fs::metadata(&parent)?.dev());
    let destination = parent.join("feature");
    checked(
        command("git", &f.source)
            .args(["worktree", "add", "--detach"])
            .arg(&destination)
            .arg("HEAD")
            .output()?,
    )?;
    let source = adopt::files(&f.source)?;
    let target = adopt::files(&destination)?;
    let indices = (adopt::index(&f.source)?, adopt::index(&destination)?);
    let registry = git(&f.source, &["worktree", "list", "--porcelain", "-z"])?.stdout;
    for mode in ["--dry-run", "--prepare", "--dedupe"] {
        let output = command(env!("CARGO_BIN_EXE_git-twig"), &f.source)
            .args(["adopt", mode])
            .arg(&destination)
            .output()?;
        if output.status.success() {
            let text = String::from_utf8_lossy(&output.stdout);
            assert!(text.contains("matched_files=0"), "{text}");
            assert!(text.contains("different devices"), "{text}");
        } else if mode == "--dry-run" {
            // Layout preview now refuses a cross-device migration. The explicit
            // v0.5 prepare/dedupe modes still perform sharing-only inspection.
            assert!(
                String::from_utf8_lossy(&output.stderr).contains("different filesystem"),
                "{output:?}"
            );
            assert!(adopt::stages(&f)?.is_empty());
        } else {
            assert_eq!(mode, "--prepare", "{output:?}");
            let scratch = adopt::stages(&f)?;
            assert_eq!(scratch.len(), 1);
            assert_ne!(fs::metadata(&scratch[0])?.mode() & 0o777, 0o700);
            assert_eq!(fs::read_dir(&scratch[0])?.count(), 0);
            assert!(
                String::from_utf8_lossy(&output.stderr)
                    .contains("cannot protect private preparation scratch")
            );
        }
        assert_eq!(adopt::files(&f.source)?, source);
        assert_eq!(adopt::files(&destination)?, target);
        assert_eq!(
            (adopt::index(&f.source)?, adopt::index(&destination)?),
            indices
        );
        assert_eq!(
            git(&f.source, &["worktree", "list", "--porcelain", "-z"])?.stdout,
            registry
        );
    }
    Ok(())
}

#[test]
fn overlay_lower_layer_adoption_preserves_originals_and_private_writes() -> Result<()> {
    let Some(root) = std::env::var_os("TWIG_TEST_ADOPT_OVERLAY_CASE") else {
        return Ok(());
    };
    let root = PathBuf::from(root);
    let lower = PathBuf::from(
        std::env::var_os("TWIG_TEST_ADOPT_OVERLAY_ORACLE").context("missing lower oracle")?,
    );
    let source = root.join("source");
    let target = root.join("feature");
    let source_before = adopt::files(&source)?;
    let target_before = adopt::files(&target)?;
    let lower_before = adopt::files(&lower)?;
    let indices = (adopt::index(&source)?, adopt::index(&target)?);
    let metadata = ["index", "HEAD", "config", "worktrees/feature/index"];
    let lower_metadata = metadata
        .iter()
        .map(|name| fs::read(lower.join("source/.git").join(name)))
        .collect::<std::io::Result<Vec<_>>>()?;
    let registry = git(&source, &["worktree", "list", "--porcelain", "-z"])?.stdout;
    for mode in ["--dry-run", "--prepare", "--dedupe"] {
        let output = command(env!("CARGO_BIN_EXE_git-twig"), &source)
            .args(["adopt", mode, "../feature"])
            .output()?;
        let expected = match mode {
            "--prepare" => std::env::var("TWIG_TEST_CLONE_SUPPORTED")? == "1",
            "--dedupe" => std::env::var("TWIG_TEST_DEDUPE_SUPPORTED")? == "1",
            _ => true,
        };
        assert_eq!(output.status.success(), expected, "{mode}: {output:?}");
        assert_eq!(adopt::files(&source)?, source_before);
        assert_eq!(adopt::files(&target)?, target_before);
        assert_eq!(adopt::files(&lower)?, lower_before);
        assert_eq!((adopt::index(&source)?, adopt::index(&target)?), indices);
        assert_eq!(
            git(&source, &["worktree", "list", "--porcelain", "-z"])?.stdout,
            registry
        );
        for (name, bytes) in metadata.iter().zip(&lower_metadata) {
            assert_eq!(&fs::read(lower.join("source/.git").join(name))?, bytes);
        }
    }
    fs::write(target.join("payload"), b"private upper-layer edit")?;
    assert_eq!(adopt::files(&source)?, source_before);
    assert_eq!(adopt::files(&lower)?, lower_before);
    Ok(())
}

#[test]
fn donor_ignored_files_are_not_adoption_candidates() -> Result<()> {
    let f = Fixture::new()?;
    fs::write(
        f.source.join("payload"),
        b"tracked before becoming ignored\n",
    )?;
    git(&f.source, &["add", "."])?;
    git(&f.source, &["commit", "-m", "target tracks payload"])?;
    git(
        &f.source,
        &["worktree", "add", "--detach", "../feature", "HEAD"],
    )?;
    git(&f.source, &["rm", "--cached", "payload"])?;
    fs::write(f.source.join(".git/info/exclude"), "payload\n")?;
    let source = adopt::files(&f.source)?;
    let target = adopt::files(&f.destination())?;
    let indices = (adopt::index(&f.source)?, adopt::index(&f.destination())?);
    let output = checked(f.twig(&["adopt", "--dry-run", "../feature"])?)?;
    let stdout = String::from_utf8_lossy(&output.stdout);
    assert!(!stdout.contains("match \"payload\""), "{stdout}");
    assert!(stdout.contains("skip \"payload\""), "{stdout}");
    assert_eq!(adopt::files(&f.source)?, source);
    assert_eq!(adopt::files(&f.destination())?, target);
    assert_eq!(
        (adopt::index(&f.source)?, adopt::index(&f.destination())?),
        indices
    );
    Ok(())
}

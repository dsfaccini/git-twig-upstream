//! Seed an owned lower-layer checkout before mounting OverlayFS; never modify a live lowerdir.
use anyhow::{Context, Result, ensure};
use std::{env, fs, path::Path};
use twig_bench::command;

fn git(root: &Path, args: &[&str]) -> Result<()> {
    let output = command("git", root).args(args).output()?;
    ensure!(
        output.status.success(),
        "fixture Git failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    Ok(())
}

fn seed(root: &Path) -> Result<()> {
    // Refuse existing paths rather than repairing, deleting or overwriting caller data.
    fs::create_dir(root).context("fixture root must be a new directory with an existing parent")?;
    let source = root.join("source");
    fs::create_dir(&source)?;
    git(&source, &["init", "-q", "-b", "main"])?;
    git(&source, &["config", "user.name", "Fixture"])?;
    git(
        &source,
        &["config", "user.email", "fixture@example.invalid"],
    )?;
    fs::write(source.join("hello"), "old\n")?;
    fs::write(source.join(".gitignore"), "ignored/\n")?;
    fs::write(source.join("executable"), "#!/bin/sh\nexit 0\n")?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(source.join("executable"), fs::Permissions::from_mode(0o755))?;
        std::os::unix::fs::symlink("missing", source.join("link"))?;
    }
    // Deterministic NUL-bearing test data, not a performance/distribution fixture.
    let data: Vec<u8> = (0..262_144).map(|index| (index % 251) as u8).collect();
    fs::write(source.join("data.bin"), data)?;
    git(&source, &["add", "."])?;
    git(&source, &["commit", "-qm", "seed"])?;
    fs::write(source.join("hello"), "new\n")?;
    fs::write(
        source.join(".gitattributes"),
        "crlf text eol=crlf\nident ident\n",
    )?;
    fs::write(source.join("crlf"), "line\n")?;
    fs::write(source.join("ident"), "$Id$\n")?;
    git(&source, &["add", "."])?;
    git(&source, &["commit", "-qm", "conversions"])?;
    git(&source, &["checkout-index", "--all", "--force"])?;
    fs::create_dir(source.join("ignored"))?;
    fs::write(source.join("ignored/cache"), "private cache\n")?;
    Ok(())
}

fn main() -> Result<()> {
    let args: Vec<_> = env::args_os().skip(1).collect();
    ensure!(
        args.len() == 1,
        "usage: twig-overlay-fixture NEW_LOWER_CASE_DIRECTORY (before mounting overlay)"
    );
    seed(Path::new(&args[0]))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn existing_paths_are_not_overwritten() -> Result<()> {
        let parent = Path::new(env!("CARGO_MANIFEST_DIR"));
        let before = fs::read(parent.join("Cargo.toml"))?;
        assert!(seed(parent).is_err());
        assert_eq!(before, fs::read(parent.join("Cargo.toml"))?);
        Ok(())
    }
}

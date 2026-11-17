//! Donor-only filesystem metadata is not part of a Git checkout.
use super::*;

fn run(program: &str, cwd: &Path, args: &[&str]) -> Result<String> {
    let output = checked(command(program, cwd).args(args).output()?)?;
    Ok(String::from_utf8(output.stdout)?)
}

/// Extended attribute names and BSD flags, as the system tools report them.
fn metadata(checkout: &Path, name: &str) -> Result<(String, String)> {
    Ok((
        run("/usr/bin/xattr", checkout, &["-s", name])?,
        run("/usr/bin/stat", checkout, &["-f", "%Sf", name])?,
    ))
}

#[test]
fn extended_attributes_and_flags_match_a_stock_checkout() -> Result<()> {
    let f = Fixture::new()?;
    fs::create_dir(f.source.join("tree"))?;
    fs::write(f.source.join("tree/file"), "nested\n")?;
    std::os::unix::fs::symlink("file", f.source.join("tree/link"))?;
    git(&f.source, &["add", "."])?;
    git(&f.source, &["commit", "-m", "nested"])?;
    let names = ["hello.txt", "tree", "tree/file", "tree/link"];
    for name in names {
        run(
            "/usr/bin/xattr",
            &f.source,
            &["-s", "-w", "user.twig.secret", "donor only", name],
        )?;
        run(
            "/usr/bin/xattr",
            &f.source,
            &["-s", "-w", "com.apple.quarantine", "0081;0;twig;", name],
        )?;
    }
    for name in ["hello.txt", "tree", "tree/file"] {
        run("/usr/bin/chflags", &f.source, &["hidden,nodump", name])?;
    }
    let output = checked(f.add()?)?;
    native(&output);
    git(&f.source, &["worktree", "add", "--detach", "../stock"])?;
    for name in names {
        assert_eq!(
            metadata(&f.destination(), name)?,
            metadata(&f.root.join("stock"), name)?,
            "metadata for {name}"
        );
        // The donor keeps what the user put there.
        let (attributes, _) = metadata(&f.source, name)?;
        assert!(attributes.contains("user.twig.secret"), "{attributes}");
    }
    clean(&f.destination())
}

use super::donor_coverage::Snapshot;
use super::*;

#[test]
fn disabled_symlinks_do_not_block_a_tree_with_no_symlinks() -> Result<()> {
    let f = Fixture::new()?;
    git(&f.source, &["config", "core.symlinks", "false"])?;
    git(
        &f.source,
        &["worktree", "add", "--detach", "../stock", "HEAD"],
    )?;
    let output = checked(f.add()?)?;
    native(&output);
    assert_eq!(
        Snapshot::capture(&f.root.join("stock"))?,
        Snapshot::capture(&f.destination())?
    );
    assert_eq!(
        git(&f.source, &["config", "core.symlinks"])?.stdout,
        b"false\n"
    );
    Ok(())
}

#[test]
fn initialized_dirty_submodules_are_not_copied_or_recursed() -> Result<()> {
    for recurse in [false, true] {
        let f = Fixture::new()?;
        let template = f.root.join("module-template");
        fs::create_dir(&template)?;
        git(&template, &["init", "-b", "main"])?;
        git(&template, &["config", "user.name", "Fixture"])?;
        git(
            &template,
            &["config", "user.email", "fixture@example.invalid"],
        )?;
        fs::write(template.join("private-data"), "committed nested bytes\n")?;
        fs::write(template.join(".gitignore"), "ignored/\n")?;
        git(&template, &["add", "."])?;
        git(&template, &["commit", "-m", "module seed"])?;
        git(
            &f.source,
            &[
                "-c",
                "protocol.file.allow=always",
                "submodule",
                "add",
                "--",
                template.to_str().unwrap(),
                "modules/sub",
            ],
        )?;
        git(&f.source, &["commit", "-am", "module pointer"])?;
        if recurse {
            git(&f.source, &["config", "submodule.recurse", "true"])?;
        }
        let sub = f.source.join("modules/sub");
        fs::write(sub.join("private-data"), "dirty nested bytes\n")?;
        fs::create_dir(sub.join("ignored"))?;
        fs::write(sub.join("ignored/cache"), "private ignored cache\n")?;
        // The reference shares the same parent Git configuration/module metadata.
        git(
            &f.source,
            &["worktree", "add", "--detach", "../stock", "HEAD"],
        )?;
        let nested_index = String::from_utf8(
            git(
                &sub,
                &["rev-parse", "--path-format=absolute", "--git-path", "index"],
            )?
            .stdout,
        )?;
        let nested_before = fs::read(nested_index.trim_end_matches('\n'))?;
        let parent_before = fs::read(f.source.join(".git/index"))?;
        let output = checked(f.add()?)?;
        native(&output);
        assert_eq!(
            Snapshot::capture(&f.root.join("stock"))?,
            Snapshot::capture(&f.destination())?
        );
        let target = f.destination().join("modules/sub");
        assert!(target.is_dir());
        assert!(fs::read_dir(target)?.next().is_none());
        assert_eq!(fs::read(sub.join("private-data"))?, b"dirty nested bytes\n");
        assert_eq!(
            fs::read(sub.join("ignored/cache"))?,
            b"private ignored cache\n"
        );
        assert_eq!(
            nested_before,
            fs::read(nested_index.trim_end_matches('\n'))?
        );
        assert_eq!(parent_before, fs::read(f.source.join(".git/index"))?);
        if recurse {
            assert_eq!(
                git(&f.source, &["config", "submodule.recurse"])?.stdout,
                b"true\n"
            );
        }
    }
    Ok(())
}

#[cfg(unix)]
#[test]
fn symlink_conversion_rules_do_not_run_programs_or_rewrite_link_text() -> Result<()> {
    use std::os::unix::fs::symlink;
    let f = Fixture::new()?;
    fs::write(
        f.source.join(".gitattributes"),
        "link filter=unexpected ident working-tree-encoding=UTF-16LE text eol=crlf\n",
    )?;
    git(
        &f.source,
        &[
            "config",
            "filter.unexpected.smudge",
            "printf invoked > unexpected-filter; cat",
        ],
    )?;
    symlink("missing\nlink", f.source.join("link"))?;
    git(&f.source, &["add", "."])?;
    git(&f.source, &["commit", "-m", "nonregular conversion rules"])?;
    fs::remove_file(f.source.join("link"))?;
    symlink("dirty\nlink", f.source.join("link"))?;
    git(
        &f.source,
        &["worktree", "add", "--detach", "../stock", "HEAD"],
    )?;
    let output = checked(f.add()?)?;
    native(&output);
    assert_eq!(
        Snapshot::capture(&f.root.join("stock"))?,
        Snapshot::capture(&f.destination())?
    );
    assert_eq!(
        fs::read_link(f.destination().join("link"))?,
        Path::new("missing\nlink")
    );
    assert_eq!(
        fs::read_link(f.source.join("link"))?,
        Path::new("dirty\nlink")
    );
    for root in [&f.source, &f.destination(), &f.root.join("stock")] {
        assert!(!root.join("unexpected-filter").exists());
    }
    Ok(())
}

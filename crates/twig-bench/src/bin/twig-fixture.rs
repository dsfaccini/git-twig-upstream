//! Deterministic, incompressible committed inputs for CLI benchmarks.
use anyhow::{Context, Result, ensure};
use std::{env, fs, path::PathBuf};
use twig_bench::command;

fn main() -> Result<()> {
    let args: Vec<_> = env::args_os().skip(1).collect();
    ensure!(
        args.len() == 3,
        "usage: twig-fixture NEW_PATH FILE_COUNT BYTES_PER_FILE"
    );
    let path = PathBuf::from(&args[0]);
    let files: usize = args[1].to_str().context("invalid file count")?.parse()?;
    let bytes: usize = args[2].to_str().context("invalid byte count")?.parse()?;
    ensure!(
        (1..=100_000).contains(&files) && (1..=64 * 1024 * 1024).contains(&bytes),
        "file count must be 1..100000; bytes 1..64 MiB"
    );
    ensure!(
        !path.try_exists()?,
        "refusing to overwrite an existing fixture"
    );
    fs::create_dir_all(path.parent().context("fixture needs a parent")?)?;
    fs::create_dir(&path)?;
    let path = fs::canonicalize(path)?;
    let mut state = 0x4d595df4d0f33173u64;
    let mut data = vec![0u8; bytes];
    for file in 0..files {
        for byte in &mut data {
            state ^= state << 13;
            state ^= state >> 7;
            state ^= state << 17;
            *byte = state as u8;
        }
        let directory = path.join(format!("tree-{:03}", file / 128));
        fs::create_dir_all(&directory)?;
        fs::write(directory.join(format!("file-{file:06}")), &data)?;
    }
    for args in [
        vec!["init", "-b", "main"],
        vec!["add", "."],
        vec![
            "-c",
            "user.name=Twig fixture",
            "-c",
            "user.email=fixture@example.invalid",
            "commit",
            "-m",
            "deterministic benchmark fixture",
        ],
    ] {
        let output = command("git", &path)
            .env("GIT_AUTHOR_DATE", "2026-11-15T00:00:00Z")
            .env("GIT_COMMITTER_DATE", "2026-11-15T00:00:00Z")
            .args(["-c", "core.hooksPath=/dev/null"])
            .args(args)
            .output()?;
        ensure!(
            output.status.success(),
            "fixture setup failed: {}",
            String::from_utf8_lossy(&output.stderr)
        );
    }
    println!("{}", path.display());
    Ok(())
}

//! Local Linux coverage ramp: stock Git, a frozen Twig, and the candidate.
//! Measurements belong to twig-real-bench; this driver freezes inputs and records every point.
use anyhow::{Context, Result, ensure};
use serde::Serialize;
use serde_json::Value;
use std::{
    env, fs,
    io::{Read, Seek, SeekFrom, Write},
    path::{Path, PathBuf},
    process::Command,
    time::{Instant, SystemTime, UNIX_EPOCH},
};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Config {
    rounds: usize,
    max_concurrency: usize,
    budget_seconds: u64,
    point_timeout_seconds: u64,
    image_gib: u64,
    filesystems: Vec<String>,
    profiles: Vec<String>,
}

#[derive(Clone, Copy, Debug, Serialize)]
#[serde(rename_all = "kebab-case")]
enum Backend {
    Git,
    Baseline,
    Candidate,
}
impl Backend {
    fn name(self) -> &'static str {
        match self {
            Self::Git => "git",
            Self::Baseline => "baseline",
            Self::Candidate => "candidate",
        }
    }
}
fn order(round: usize) -> [Backend; 3] {
    match round % 3 {
        0 => [Backend::Git, Backend::Baseline, Backend::Candidate],
        1 => [Backend::Candidate, Backend::Git, Backend::Baseline],
        _ => [Backend::Baseline, Backend::Candidate, Backend::Git],
    }
}
fn levels(profile: &str, max: usize) -> Vec<usize> {
    if profile == "file-heavy" {
        [1, 4, 16, 64, 128]
            .into_iter()
            .filter(|n| *n <= max)
            .collect()
    } else {
        vec![1]
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Fixture {
    label: String,
    #[serde(skip)]
    path: PathBuf,
    target_commit: String,
    donor_commit: Option<String>,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Binary {
    label: String,
    source_commit: Option<String>,
    sha256: String,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Point {
    filesystem: String,
    profile: String,
    concurrency: usize,
    worktrees: usize,
    round: usize,
    backend: Backend,
    result: String,
    exit_code: Option<i32>,
    verified: bool,
    allocation_stable: bool,
    error: Option<String>,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Manifest {
    schema_version: u32,
    generated_at_unix_ms: u128,
    commit: String,
    config: Config,
    baseline: Binary,
    candidate: Binary,
    fixtures: Vec<Fixture>,
    notes: Vec<String>,
    status: String,
    points: Vec<Point>,
    stop_reason: Option<String>,
}

fn command(program: impl AsRef<std::ffi::OsStr>, cwd: &Path) -> Command {
    let mut command = Command::new(program);
    command
        .current_dir(cwd)
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .env("GIT_CONFIG_GLOBAL", "/dev/null")
        .env("GIT_ATTR_NOSYSTEM", "1")
        .env("GIT_TERMINAL_PROMPT", "0");
    command
}
fn checked(command: &mut Command) -> Result<String> {
    let result = command.output()?;
    ensure!(
        result.status.success(),
        "command failed: {}",
        String::from_utf8_lossy(&result.stderr)
    );
    Ok(String::from_utf8(result.stdout)?
        .trim_end_matches('\n')
        .into())
}
fn git(root: &Path, args: &[&str]) -> Result<String> {
    checked(
        command("git", root)
            .args(["-c", "core.hooksPath=/dev/null"])
            .args(args),
    )
}
fn commit(root: &Path, message: &str) -> Result<String> {
    git(root, &["add", "."])?;
    checked(
        command("git", root)
            .env("GIT_AUTHOR_DATE", "2026-11-17T00:00:00Z")
            .env("GIT_COMMITTER_DATE", "2026-11-17T00:00:00Z")
            .args([
                "-c",
                "core.hooksPath=/dev/null",
                "-c",
                "user.name=Twig fixture",
                "-c",
                "user.email=fixture@example.invalid",
                "commit",
                "-m",
                message,
            ]),
    )?;
    git(root, &["rev-parse", "HEAD"])
}
fn clone_input(source: &Path, destination: &Path) -> Result<()> {
    checked(
        command(
            "git",
            destination.parent().context("fixture has no parent")?,
        )
        .args(["-c", "core.hooksPath=/dev/null", "clone", "--shared", "--"])
        .arg(source)
        .arg(destination),
    )?;
    Ok(())
}
fn fixtures(root: &Path, binaries: &Path) -> Result<Vec<Fixture>> {
    let inputs = root.join("inputs");
    fs::create_dir(&inputs)?;
    let bytes = inputs.join("bytes");
    let files = inputs.join("files");
    checked(
        command(binaries.join("twig-fixture"), root)
            .arg(&bytes)
            .args(["16", "4194304"]),
    )?;
    checked(
        command(binaries.join("twig-fixture"), root)
            .arg(&files)
            .args(["4096", "1024"]),
    )?;
    let byte_commit = git(&bytes, &["rev-parse", "HEAD"])?;
    let file_commit = git(&files, &["rev-parse", "HEAD"])?;
    let cross = inputs.join("cross");
    clone_input(&bytes, &cross)?;
    for i in 0..4 {
        let mut file = fs::OpenOptions::new()
            .read(true)
            .write(true)
            .open(cross.join(format!("tree-000/file-{i:06}")))?;
        let mut byte = [0];
        file.read_exact(&mut byte)?;
        file.seek(SeekFrom::Start(0))?;
        file.write_all(&[byte[0] ^ 0xff])?;
    }
    fs::write(cross.join(".gitattributes"), "* text=auto eol=lf\n")?;
    fs::write(cross.join("target-only"), b"new target file\n")?;
    let target = commit(
        &cross,
        "fixture: change four blobs and add LF target policy",
    )?;
    let mixed = inputs.join("mixed");
    clone_input(&bytes, &mixed)?;
    fs::write(
        mixed.join(".gitattributes"),
        "doc.id ident\ndoc.utf16 working-tree-encoding=UTF-16LE\n",
    )?;
    fs::write(mixed.join("doc.id"), "$Id$\n")?;
    let utf16: Vec<u8> = "hello\n"
        .encode_utf16()
        .flat_map(u16::to_le_bytes)
        .collect();
    fs::write(mixed.join("doc.utf16"), utf16)?;
    let mixed_commit = commit(&mixed, "fixture: add builtin ident and UTF-16 exceptions")?;
    let auto = inputs.join("auto-crlf");
    clone_input(&bytes, &auto)?;
    fs::write(auto.join(".gitattributes"), "* text=auto eol=crlf\n")?;
    fs::write(auto.join("doc.txt"), "text must become CRLF\n")?;
    let auto_commit = commit(&auto, "fixture: binary sharing with auto CRLF text")?;
    // New capability scenarios go first; expensive many-file ramps come last.
    Ok(vec![
        Fixture {
            label: "cross-revision".into(),
            path: cross,
            target_commit: target,
            donor_commit: Some(byte_commit.clone()),
        },
        Fixture {
            label: "mixed-builtins".into(),
            path: mixed,
            target_commit: mixed_commit,
            donor_commit: None,
        },
        Fixture {
            label: "auto-crlf".into(),
            path: auto,
            target_commit: auto_commit,
            donor_commit: None,
        },
        Fixture {
            label: "byte-heavy".into(),
            path: bytes,
            target_commit: byte_commit,
            donor_commit: None,
        },
        Fixture {
            label: "file-heavy".into(),
            path: files,
            target_commit: file_commit,
            donor_commit: None,
        },
    ])
}
fn digest(path: &Path, cwd: &Path) -> Result<String> {
    Ok(checked(command("sha256sum", cwd).arg(path))?
        .split_whitespace()
        .next()
        .context("missing digest")?
        .into())
}
fn save(output: &Path, manifest: &Manifest) -> Result<()> {
    let temporary = output.join("manifest.json.tmp");
    fs::write(&temporary, serde_json::to_vec_pretty(manifest)?)?;
    fs::rename(temporary, output.join("manifest.json"))?;
    Ok(())
}

fn valid_result(raw: &Value, backend: Backend, worktrees: usize, fixture: &Fixture) -> Result<()> {
    ensure!(
        raw["schemaVersion"] == 4 && raw["dirty"] == false,
        "wrong schema or dirty harness"
    );
    ensure!(
        raw["failures"].as_array().context("failures")?.is_empty(),
        "harness reported failures"
    );
    let cohorts = raw["cohorts"].as_array().context("cohorts")?;
    ensure!(
        cohorts.len() == 1,
        "point must contain one completed cohort"
    );
    let point = &cohorts[0];
    ensure!(
        point["targetCommit"] == fixture.target_commit
            && point["sourceCommit"]
                == fixture
                    .donor_commit
                    .as_ref()
                    .unwrap_or(&fixture.target_commit)
                    .as_str(),
        "wrong source or target revision"
    );
    ensure!(
        point["repository"] == fixture.label
            && point["backend"]
                == if matches!(backend, Backend::Git) {
                    "git"
                } else {
                    "twig"
                },
        "wrong fixture or backend"
    );
    ensure!(
        point["succeeded"] == worktrees && point["failed"] == 0 && point["sourceUnchanged"] == true,
        "incorrect or incomplete point"
    );
    ensure!(
        point["privateWriteTested"] == true
            && point["verifiedFiles"].as_u64()
                == point["trackedFiles"].as_u64().map(|n| n * worktrees as u64),
        "missing full verification or private-write probe"
    );
    let operations = point["operations"].as_array().context("operations")?;
    ensure!(operations.len() == worktrees, "missing operations");
    for operation in operations {
        ensure!(
            operation["verified"] == true
                && operation["exitCode"] == 0
                && operation["error"].is_null(),
            "operation did not verify"
        );
        if matches!(backend, Backend::Candidate) {
            ensure!(
                operation["nativeCow"] == true
                    && operation["verifiedClones"].as_u64().is_some_and(|n| n > 0),
                "candidate did not retain verified clones"
            );
        }
    }
    Ok(())
}

fn main() -> Result<()> {
    ensure!(cfg!(target_os = "linux"), "this driver requires Linux");
    let cwd = env::current_dir()?;
    let binaries = env::current_exe()?
        .parent()
        .context("binary has no parent")?
        .to_path_buf();
    let mut baseline = None;
    let mut baseline_commit: Option<String> = None;
    let mut candidate = binaries.join("git-twig");
    let mut output = None;
    let mut config = Config {
        rounds: 3,
        max_concurrency: 16,
        budget_seconds: 1800,
        point_timeout_seconds: 180,
        image_gib: 8,
        filesystems: vec!["xfs".into(), "btrfs".into()],
        profiles: vec![
            "cross-revision".into(),
            "mixed-builtins".into(),
            "auto-crlf".into(),
            "byte-heavy".into(),
            "file-heavy".into(),
        ],
    };
    let mut args = env::args().skip(1);
    while let Some(arg) = args.next() {
        if arg == "--help" {
            println!(
                "twig-linux-coverage --baseline FROZEN_TWIG --output NEW_DIRECTORY [--candidate TWIG] [--rounds 3] [--max-concurrency 16] [--budget-seconds 1800] [--point-timeout-seconds 180] [--baseline-commit FULL_OID] [--filesystems xfs,btrfs] [--profiles cross-revision,mixed-builtins,auto-crlf,byte-heavy,file-heavy]"
            );
            return Ok(());
        }
        let value = args.next().context("option requires value")?;
        match arg.as_str() {
            "--baseline" => baseline = Some(PathBuf::from(value)),
            "--baseline-commit" => {
                ensure!(
                    (value.len() == 40 || value.len() == 64)
                        && value.bytes().all(|b| b.is_ascii_hexdigit()),
                    "baseline commit must be a full OID"
                );
                baseline_commit = Some(value);
            }
            "--filesystems" => config.filesystems = value.split(',').map(str::to_owned).collect(),
            "--profiles" => config.profiles = value.split(',').map(str::to_owned).collect(),
            "--candidate" => candidate = PathBuf::from(value),
            "--output" => output = Some(PathBuf::from(value)),
            "--rounds" => config.rounds = value.parse()?,
            "--max-concurrency" => config.max_concurrency = value.parse()?,
            "--budget-seconds" => config.budget_seconds = value.parse()?,
            "--point-timeout-seconds" => config.point_timeout_seconds = value.parse()?,
            _ => anyhow::bail!("unknown option {arg}"),
        }
    }
    ensure!(
        config.rounds > 0
            && config.max_concurrency > 0
            && config.max_concurrency <= 128
            && config.budget_seconds > 0
            && config.point_timeout_seconds > 0,
        "invalid budget/ramp parameters"
    );
    ensure!(
        !config.filesystems.is_empty()
            && config
                .filesystems
                .iter()
                .all(|fs| ["xfs", "btrfs"].contains(&fs.as_str())),
        "unknown filesystem"
    );
    ensure!(
        !config.profiles.is_empty()
            && config.profiles.iter().all(|profile| [
                "cross-revision",
                "mixed-builtins",
                "auto-crlf",
                "byte-heavy",
                "file-heavy"
            ]
            .contains(&profile.as_str())),
        "unknown profile"
    );
    ensure!(
        config
            .filesystems
            .iter()
            .collect::<std::collections::BTreeSet<_>>()
            .len()
            == config.filesystems.len()
            && config
                .profiles
                .iter()
                .collect::<std::collections::BTreeSet<_>>()
                .len()
                == config.profiles.len(),
        "duplicate filesystem/profile selectors"
    );
    let baseline = fs::canonicalize(baseline.context("--baseline required")?)?;
    let candidate = fs::canonicalize(candidate)?;
    let candidate_commit =
        if fs::canonicalize(binaries.join("git-twig")).ok().as_ref() == Some(&candidate) {
            Some(git(&cwd, &["rev-parse", "HEAD"])?)
        } else {
            None // A custom binary is identified by SHA-256, not an invented source revision.
        };
    ensure!(
        git(&cwd, &["status", "--porcelain"])?.is_empty(),
        "commit the harness and candidate before measuring"
    );
    let generated = SystemTime::now().duration_since(UNIX_EPOCH)?.as_millis();
    let output = output.unwrap_or_else(|| cwd.join(format!("target/linux-coverage/{generated}")));
    fs::create_dir_all(output.parent().context("output has no parent")?)?;
    fs::create_dir(&output).context("output must be a new directory")?;
    let output = fs::canonicalize(output)?;
    let mut manifest = Manifest {
        schema_version: 1, generated_at_unix_ms: generated, commit: git(&cwd, &["rev-parse", "HEAD"])?,
        baseline: Binary { label: "frozen-twig".into(), source_commit: baseline_commit, sha256: digest(&baseline, &cwd)? },
        candidate: Binary { label: "candidate-twig".into(), source_commit: candidate_commit, sha256: digest(&candidate, &cwd)? },
        config, fixtures: fixtures(&output, &binaries)?, status: "running".into(), points: Vec::new(), stop_reason: None,
        notes: vec![
            "Local shared-host, warm-cache, ext4-backed loopback allocation measurements; not bare-device or universal speed claims. All fixture/image/source data is retained. No network, release or publication operation.".into(),
            "Baseline and candidate are frozen by binary SHA-256. Fixture source/target commits are pinned. Three variants rotate position by round; each has an isolated filesystem, oracle and warmup registry. Each point is one unretried measured cohort; all raw samples and failures are retained.".into(),
            "Baseline Twig may delegate and is explicitly marked requireNative=false; this never relabels fallback as native. Candidate requires real nonzero verified clone counts as well as raw byte/link/mode verification and source immutability. Final allocation, not the backend banner, establishes disk savings.".into(),
            "Concurrency is bounded by configured levels/time budget, not a measured maximum. The five fixtures are synthetic and deterministic (twig-fixture xorshift seed 0x4d595df4d0f33173); changed/mixed inputs are explicitly derived, not unmodified real repositories. No kernel workload is included in this bounded ramp.".into(),
        ],
    };
    manifest
        .fixtures
        .retain(|fixture| manifest.config.profiles.contains(&fixture.label));
    save(&output, &manifest)?;
    let start = Instant::now();
    for filesystem in manifest.config.filesystems.clone() {
        for fixture in &manifest.fixtures {
            for concurrency in levels(&fixture.label, manifest.config.max_concurrency) {
                let worktrees = concurrency.max(2);
                for round in 0..manifest.config.rounds {
                    for backend in order(round) {
                        let remaining = manifest
                            .config
                            .budget_seconds
                            .saturating_sub(start.elapsed().as_secs());
                        if remaining == 0 {
                            manifest.status = "budget-stop".into();
                            manifest.stop_reason = Some("configured total run budget exhausted; remaining points unmeasured".into());
                            save(&output, &manifest)?;
                            return Ok(());
                        }
                        let filename = format!(
                            "{filesystem}-{}-c{concurrency}-r{round}-{}.json",
                            fixture.label,
                            backend.name()
                        );
                        let log = output.join(filename.replace(".json", ".log"));
                        let binary = if matches!(backend, Backend::Baseline) {
                            &baseline
                        } else {
                            &candidate
                        };
                        let mut child = command("timeout", &cwd);
                        child.args(["--signal=TERM", "--kill-after=15s"])
                            .arg(format!("{}s", remaining.min(manifest.config.point_timeout_seconds)))
                            .arg(binaries.join("twig-real-bench"))
                            .args(["--filesystem", &format!("linux-{filesystem}-image"), "--repo", &format!("{}={}", fixture.label, fixture.path.display()), "--revision", &format!("{}={}", fixture.label, fixture.target_commit), "--backend", if matches!(backend, Backend::Git) { "git" } else { "twig" }, "--require-native", if matches!(backend, Backend::Candidate) { "true" } else { "false" }, "--repeats", "1", "--concurrency", &concurrency.to_string(), "--worktrees", &worktrees.to_string(), "--image-gib", &manifest.config.image_gib.to_string()])
                            .arg("--candidate").arg(binary).arg("--output").arg(output.join(&filename))
                            .args(["--note", &format!("Coverage driver round {round}, variant {}. See adjacent manifest.json for frozen binary identities, source/target pins, rotated order, budgets and caveats.", backend.name())]);
                        if let Some(donor) = &fixture.donor_commit {
                            child.args(["--donor-revision", &format!("{}={donor}", fixture.label)]);
                        }
                        child
                            .stdout(fs::File::create(&log)?)
                            .stderr(fs::File::create(
                                output.join(filename.replace(".json", ".stderr.log")),
                            )?);
                        eprintln!(
                            "{filesystem} / {} / c{concurrency} / round {round} / {}",
                            fixture.label,
                            backend.name()
                        );
                        let status = child.status()?;
                        let mut allocation_stable = false;
                        let result = fs::read(output.join(&filename))
                            .map_err(anyhow::Error::from)
                            .and_then(|bytes| Ok(serde_json::from_slice::<Value>(&bytes)?))
                            .and_then(|raw| {
                                allocation_stable =
                                    ["before", "afterCreate", "afterStatus", "afterPrivateWrites"]
                                        .iter()
                                        .all(|key| raw["cohorts"][0][key]["stable"] == true);
                                let expected_hash = if matches!(backend, Backend::Baseline) {
                                    &manifest.baseline.sha256
                                } else {
                                    &manifest.candidate.sha256
                                };
                                ensure!(
                                    raw["candidateSha256"] == expected_hash.as_str()
                                        && raw["commit"] == manifest.commit,
                                    "binary or harness provenance changed"
                                );
                                valid_result(&raw, backend, worktrees, fixture)
                            });
                        let error = if !status.success() {
                            Some(format!(
                                "process exit {:?}; timeouts are budget stops, not complete points",
                                status.code()
                            ))
                        } else {
                            result.err().map(|error| format!("{error:#}"))
                        };
                        let verified = error.is_none();
                        manifest.points.push(Point {
                            filesystem: filesystem.clone(),
                            profile: fixture.label.clone(),
                            concurrency,
                            worktrees,
                            round,
                            backend,
                            result: filename,
                            exit_code: status.code(),
                            verified,
                            allocation_stable,
                            error,
                        });
                        save(&output, &manifest)?;
                        if !verified {
                            manifest.status = if matches!(status.code(), Some(124 | 137)) {
                                "budget-stop"
                            } else {
                                "failed"
                            }
                            .into();
                            manifest.stop_reason = Some("point failed, timed out or did not verify; no retry and no performance conclusion for that point".into());
                            save(&output, &manifest)?;
                            anyhow::bail!(
                                "point did not complete correctly; inspect {}",
                                output.join("manifest.json").display()
                            );
                        }
                    }
                }
            }
        }
    }
    manifest.status = "completed".into();
    save(&output, &manifest)?;
    println!("{}", output.join("manifest.json").display());
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn rotates_each_variant_through_each_position() {
        for position in 0..3 {
            let names: std::collections::BTreeSet<_> =
                (0..3).map(|round| order(round)[position].name()).collect();
            assert_eq!(names.len(), 3);
        }
    }
    #[test]
    fn validates_revision_provenance_and_real_candidate_clones() -> Result<()> {
        let fixture = Fixture {
            label: "fixture".into(),
            path: PathBuf::new(),
            target_commit: "B".into(),
            donor_commit: Some("A".into()),
        };
        let raw = serde_json::json!({"schemaVersion":4,"dirty":false,"failures":[],"cohorts":[{"repository":"fixture","backend":"twig","sourceCommit":"A","targetCommit":"B","succeeded":1,"failed":0,"sourceUnchanged":true,"privateWriteTested":true,"trackedFiles":1,"verifiedFiles":1,"operations":[{"verified":true,"exitCode":0,"error":null,"nativeCow":true,"verifiedClones":1}]}]});
        valid_result(&raw, Backend::Candidate, 1, &fixture)?;
        let mut no_clones = raw.clone();
        no_clones["cohorts"][0]["operations"][0]["verifiedClones"] = 0.into();
        assert!(valid_result(&no_clones, Backend::Candidate, 1, &fixture).is_err());
        valid_result(&no_clones, Backend::Baseline, 1, &fixture)?;
        let mut wrong = raw.clone();
        wrong["cohorts"][0]["targetCommit"] = "A".into();
        assert!(valid_result(&wrong, Backend::Candidate, 1, &fixture).is_err());
        let mut incomplete = raw.clone();
        incomplete["cohorts"][0]["verifiedFiles"] = 0.into();
        assert!(valid_result(&incomplete, Backend::Candidate, 1, &fixture).is_err());
        Ok(())
    }

    #[test]
    fn configured_ramp_is_not_reported_as_capacity() {
        assert_eq!(levels("file-heavy", 16), [1, 4, 16]);
        assert_eq!(levels("file-heavy", 2), [1]);
        assert_eq!(levels("cross-revision", 128), [1]);
    }
}

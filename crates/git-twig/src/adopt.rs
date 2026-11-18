//! Confirmed layout adoption. Relocation never reconstructs checkout contents.
use anyhow::{Context, Result, bail, ensure};
use std::{
    ffi::{OsStr, OsString},
    fs,
    io::{self, IsTerminal, Write},
    path::{Path, PathBuf},
};

use crate::registry::{self, Checkout, Registration, git};

const ROOT_KEY: &str = "twig.worktreesDir";
const USAGE: &str = "git twig adopt [--dry-run] [--yes] [--worktrees-dir=<root>] [<worktree>]";

struct Request {
    root: Option<PathBuf>,
    target: Option<PathBuf>,
    dry_run: bool,
    yes: bool,
}
impl Request {
    fn parse(args: &[OsString]) -> Result<Self> {
        let mut request = Self {
            root: None,
            target: None,
            dry_run: false,
            yes: false,
        };
        let mut args = args.iter();
        let mut positional = false;
        while let Some(arg) = args.next() {
            if !positional && arg == "--" {
                positional = true;
                continue;
            }
            if !positional && arg == "--dry-run" {
                ensure!(!request.dry_run, "duplicate --dry-run");
                request.dry_run = true;
            } else if !positional && arg == "--yes" {
                ensure!(!request.yes, "duplicate --yes");
                request.yes = true;
            } else if !positional && arg == "--worktrees-dir" {
                ensure!(request.root.is_none(), "duplicate --worktrees-dir");
                let value = args.next().context("--worktrees-dir requires a path")?;
                ensure!(!value.is_empty(), "empty worktrees directory");
                request.root = Some(value.into());
            } else if !positional && arg.as_encoded_bytes().starts_with(b"--worktrees-dir=") {
                ensure!(request.root.is_none(), "duplicate --worktrees-dir");
                let value = &arg.as_encoded_bytes()[16..];
                ensure!(!value.is_empty(), "empty worktrees directory");
                request.root = Some(crate::native::os_string(value.to_vec()).into());
            } else {
                ensure!(
                    positional || !arg.as_encoded_bytes().starts_with(b"-"),
                    "unknown option {arg:?}; {USAGE}"
                );
                ensure!(!arg.is_empty() && request.target.is_none(), "{USAGE}");
                request.target = Some(arg.into());
            }
        }
        ensure!(
            !(request.yes && request.dry_run),
            "--yes and --dry-run are mutually exclusive"
        );
        Ok(request)
    }
}

/// Explicit v0.5 sharing modes keep their existing file-identity contract. The
/// default command and its layout preview are the new relocation interface.
pub(super) fn run(cwd: &Path, args: &[OsString]) -> Result<i32> {
    if args
        .iter()
        .take_while(|a| *a != "--")
        .any(|a| a == "--prepare" || a == "--dedupe")
    {
        return crate::sharing::run(cwd, args);
    }
    let request = Request::parse(args)?;
    #[cfg(unix)]
    return unix::run(cwd, request);
    #[cfg(not(unix))]
    {
        let _ = (cwd, request);
        bail!("layout adoption currently requires macOS or Linux");
    }
}

pub(super) fn saved_root(cwd: &Path) -> Result<Option<PathBuf>> {
    registry::ensure_environment()?;
    let output = git(cwd)
        .args(["config", "--local", "--null", "--get", ROOT_KEY])
        .output()?;
    if output.status.code() == Some(1) {
        return Ok(None);
    }
    ensure!(
        output.status.success(),
        "cannot read saved worktrees directory"
    );
    let bytes = output
        .stdout
        .strip_suffix(b"\0")
        .context("malformed worktrees directory config")?;
    let path = PathBuf::from(crate::native::os_string(bytes.to_vec()));
    ensure!(
        path.is_absolute(),
        "saved worktrees directory must be absolute"
    );
    Ok(Some(path))
}

fn slot(name: &OsStr) -> Result<OsString> {
    let mut encoded = String::new();
    for &byte in name.as_encoded_bytes() {
        match byte {
            b'/' => encoded.push('-'),
            b'a'..=b'z' | b'A'..=b'Z' | b'0'..=b'9' | b'-' | b'_' | b'.' => {
                encoded.push(byte as char)
            }
            _ => {
                use std::fmt::Write;
                write!(encoded, "%{byte:02X}")?;
            }
        }
    }
    ensure!(
        !encoded.is_empty() && encoded != "." && encoded != "..",
        "invalid worktree slot"
    );
    Ok(encoded.into())
}

/// Omitted destinations are inferred only for this unambiguous form. Explicit
/// destinations (and their existing Git semantics) are never reinterpreted.
pub(super) fn creation_args(cwd: &Path, args: &[OsString]) -> Result<Vec<OsString>> {
    let mut args = args.to_vec();
    if args.len() == 3
        && args[0] == "new"
        && args[1] == "-b"
        && let Some(root) = saved_root(cwd)?
    {
        args.push(root.join(slot(&args[2])?).into_os_string());
    }
    Ok(args)
}

#[cfg(unix)]
mod unix {
    use super::*;
    use std::{
        collections::HashSet,
        ffi::CString,
        fs::{File, OpenOptions},
        os::unix::{
            ffi::OsStrExt,
            fs::{DirBuilderExt, MetadataExt, OpenOptionsExt},
        },
        time::{SystemTime, UNIX_EPOCH},
    };

    struct Repository {
        main: PathBuf,
        records: Vec<Registration>,
    }
    impl Repository {
        fn read(cwd: &Path) -> Result<Self> {
            let records = registry::read(cwd)?;
            let first = records.first().context("repository has no main checkout")?;
            ensure!(
                !matches!(first.checkout, Checkout::Bare),
                "bare repositories have no main checkout to adopt"
            );
            let main = fs::canonicalize(&first.path)?;
            ensure!(
                fs::symlink_metadata(main.join(".git"))?.is_dir(),
                "main checkout must own its .git directory; external or symlinked Git metadata is unsupported"
            );
            Ok(Self { main, records })
        }
        fn recommended_root(&self, single: bool) -> Result<PathBuf> {
            let parent = self.main.parent().context("main checkout has no parent")?;
            if self.main.file_name() == Some(OsStr::new("main")) {
                return Ok(parent.into());
            }
            if single {
                let mut name = self
                    .main
                    .file_name()
                    .context("main checkout lacks a name")?
                    .to_os_string();
                name.push("-worktrees");
                return Ok(parent.join(name));
            }
            Ok(self.main.clone())
        }
    }

    #[derive(Clone, Copy, PartialEq, Eq)]
    struct Identity {
        device: u64,
        inode: u64,
    }
    fn identity(path: &Path) -> Result<Identity> {
        let stat = fs::symlink_metadata(path)?;
        ensure!(stat.is_dir(), "checkout is not a real directory: {path:?}");
        Ok(Identity {
            device: stat.dev(),
            inode: stat.ino(),
        })
    }
    struct Relocation {
        from: PathBuf,
        to: PathBuf,
        identity: Identity,
    }
    struct Plan {
        repository: Repository,
        root: PathBuf,
        main_destination: PathBuf,
        selected: Option<PathBuf>,
        moves: Vec<Relocation>,
    }

    /// Canonicalize the existing prefix, preserving nonexistent final components.
    fn destination(path: &Path) -> Result<PathBuf> {
        let mut prefix = path;
        let mut suffix = Vec::new();
        while !prefix.try_exists()? {
            // Dangling symlinks must not be mistaken for vacant paths.
            ensure!(
                fs::symlink_metadata(prefix).is_err(),
                "occupied destination: {prefix:?}"
            );
            suffix.push(
                prefix
                    .file_name()
                    .context("destination has an unresolved parent component")?
                    .to_owned(),
            );
            prefix = prefix
                .parent()
                .context("destination has no existing ancestor")?;
        }
        let mut result = fs::canonicalize(prefix)?;
        ensure!(result.is_dir(), "destination ancestor is not a directory");
        for name in suffix.into_iter().rev() {
            result.push(name);
        }
        Ok(result)
    }
    fn existing_ancestor(mut path: &Path) -> Result<&Path> {
        while !path.try_exists()? {
            path = path.parent().context("no destination ancestor")?;
        }
        Ok(path)
    }
    fn ensure_repository_links(checkout: &Path, main: &Path) -> Result<()> {
        let root = crate::output_path(
            crate::checked(git(checkout).args(["rev-parse", "--show-toplevel"]))?.stdout,
        )?;
        let common = crate::output_path(
            crate::checked(git(checkout).args([
                "rev-parse",
                "--path-format=absolute",
                "--git-common-dir",
            ]))?
            .stdout,
        )?;
        ensure!(
            fs::canonicalize(root)? == checkout && fs::canonicalize(common)? == main.join(".git"),
            "registration points at another checkout/repository: {checkout:?}"
        );
        let git_dir = crate::output_path(
            crate::checked(git(checkout).args(["rev-parse", "--absolute-git-dir"]))?.stdout,
        )?;
        for directory in [git_dir, main.join(".git")] {
            for name in [
                "index.lock",
                "HEAD.lock",
                "config.lock",
                "packed-refs.lock",
                "shallow.lock",
            ] {
                ensure!(
                    fs::symlink_metadata(directory.join(name)).is_err(),
                    "active Git lock {:?}; stop its owner before adopting",
                    directory.join(name)
                );
            }
        }
        Ok(())
    }
    fn ensure_relocatable(from: &Path) -> Result<()> {
        let core = git(from)
            .args(["config", "--get", "core.worktree"])
            .output()?;
        ensure!(
            core.status.code() == Some(1),
            "checkout has core.worktree configuration; relocation is unsupported: {from:?}"
        );
        let tracked = crate::checked(git(from).args(["ls-files", "--stage", "-z"]))?;
        ensure!(
            !tracked
                .stdout
                .split(|b| *b == 0)
                .any(|r| r.starts_with(b"160000 ")),
            "worktrees with submodule entries cannot yet be relocated: {from:?}"
        );
        Ok(())
    }
    fn selected_path(cwd: &Path, target: &Option<PathBuf>) -> Result<Option<PathBuf>> {
        target
            .as_ref()
            .map(|p| fs::canonicalize(cwd.join(p)).map_err(Into::into))
            .transpose()
    }
    impl Plan {
        fn build(repository: Repository, root: PathBuf, selected: Option<&Path>) -> Result<Self> {
            let root = destination(&root)?;
            let mut moves = Vec::new();
            let mut names = HashSet::new();
            let mut found = selected.is_none();
            let mut main_destination = repository.main.clone();
            let device = identity(&repository.main)?.device;
            ensure!(
                fs::metadata(existing_ancestor(&root)?)?.dev() == device,
                "worktrees directory is on a different filesystem; cross-device relocation is unsupported"
            );
            ensure!(
                identity(repository.main.parent().context("main has no parent")?)?.device == device,
                "main checkout is a mount point; cannot park it safely"
            );
            for (i, record) in repository.records.iter().enumerate() {
                let from = fs::canonicalize(&record.path).with_context(|| {
                    format!(
                        "missing registered worktree {:?}; repair it first",
                        record.path
                    )
                })?;
                ensure!(
                    from == record.path,
                    "registration uses a symlink/alias path; repair it first: {:?}",
                    record.path
                );
                ensure!(
                    record.locked.is_none()
                        && record.prunable.is_none()
                        && record.unknown.is_empty(),
                    "locked, prunable or unknown registration: {:?}; resolve it explicitly first",
                    record.path
                );
                ensure_repository_links(&from, &repository.main)?;
                let chosen = selected.is_none_or(|p| p == from);
                if !chosen {
                    continue;
                }
                found = true;
                ensure!(
                    !matches!(record.checkout, Checkout::Bare),
                    "cannot adopt a bare registration"
                );
                let name = if i == 0 {
                    OsString::from("main")
                } else {
                    match &record.checkout {
                        Checkout::Branch { reference, .. } => {
                            let bytes = reference
                                .as_bytes()
                                .strip_prefix(b"refs/heads/")
                                .context("unsupported branch reference")?;
                            slot(&crate::native::os_string(bytes.to_vec()))?
                        }
                        Checkout::Detached { .. } => {
                            slot(from.file_name().context("detached worktree lacks a name")?)?
                        }
                        Checkout::Bare => unreachable!(),
                    }
                };
                ensure!(
                    i == 0 || !name.as_encoded_bytes().eq_ignore_ascii_case(b"main"),
                    "the main directory slot is reserved for the original clone"
                );
                ensure!(
                    names.insert(name.to_string_lossy().to_ascii_lowercase()),
                    "worktree directory collision at {name:?}; choose distinct branches or adopt separately"
                );
                let to = root.join(name);
                if i == 0 {
                    main_destination = to.clone();
                }
                let id = identity(&from)?;
                ensure!(
                    id.device == device,
                    "worktree is on a different filesystem: {from:?}"
                );
                moves.push(Relocation {
                    from,
                    to,
                    identity: id,
                });
            }
            ensure!(
                found,
                "target is not a registered worktree root of this repository"
            );
            // Even an already-correct child slot must be parked when its parent
            // moves; otherwise moving main would implicitly carry that child away.
            let moving_parents: Vec<_> = moves
                .iter()
                .filter(|m| m.from != m.to)
                .map(|m| m.from.clone())
                .collect();
            moves.retain(|m| {
                m.from != m.to
                    || moving_parents
                        .iter()
                        .any(|p| m.from != *p && m.from.starts_with(p))
            });
            for moving in &moves {
                ensure!(
                    !root.starts_with(&moving.from)
                        || (moving.from == repository.main && root == moving.from),
                    "worktrees directory must be outside moving checkouts (or exactly the original main path)"
                );
                let vacated = moves.iter().any(|m| moving.to.starts_with(&m.from));
                ensure!(
                    fs::symlink_metadata(&moving.to).is_err() || vacated,
                    "destination already exists: {:?}",
                    moving.to
                );
                ensure_relocatable(&moving.from)?;
                for record in &repository.records {
                    if record.path != moving.from && record.path.starts_with(&moving.from) {
                        ensure!(
                            moves.iter().any(|m| m.from == record.path),
                            "moving {:?} would implicitly move unselected worktree {:?}; adopt all worktrees instead",
                            moving.from,
                            record.path
                        );
                    }
                    ensure!(
                        !moving.to.starts_with(&record.path)
                            || moves.iter().any(|m| m.from == record.path),
                        "destination would remain nested inside an unmoved worktree: {:?}",
                        moving.to
                    );
                }
            }
            // Children must leave before parents are parked. Main is installed first later.
            moves.sort_by_key(|m| std::cmp::Reverse(m.from.components().count()));
            Ok(Self {
                repository,
                root,
                main_destination,
                selected: selected.map(Path::to_path_buf),
                moves,
            })
        }
        fn show(&self) {
            println!("Worktrees directory: {:?}", self.root);
            for record in &self.repository.records {
                if let Some(m) = self.moves.iter().find(|m| m.from == record.path) {
                    println!("  {:?} -> {:?}", m.from, m.to);
                } else {
                    println!("  {:?} (unchanged)", record.path);
                }
            }
            println!(
                "{} worktree(s) to move. Branches, index and working files are preserved.",
                self.moves.len()
            );
            println!(
                "Coordinate active agents/editors first: their stored absolute paths will not be updated."
            );
            if cfg!(target_os = "macos") {
                println!(
                    "macOS: relocation does not compact existing files; sharing will remain unchanged."
                );
            } else {
                println!(
                    "Linux: after relocation, attempt safe in-place deduplication; physical savings are not measured."
                );
            }
        }
    }

    fn prompt(message: &str) -> Result<String> {
        ensure!(
            io::stdin().is_terminal(),
            "interactive confirmation requires a terminal; preview with --dry-run, then use --yes with an explicit/saved --worktrees-dir after review"
        );
        eprint!("{message}");
        io::stderr().flush()?;
        let mut line = String::new();
        ensure!(
            io::stdin().read_line(&mut line)? > 0,
            "input closed; adoption canceled"
        );
        Ok(line.trim_end_matches(['\r', '\n']).into())
    }
    pub(super) fn run(cwd: &Path, request: Request) -> Result<i32> {
        ensure!(
            cfg!(any(target_os = "macos", target_os = "linux")),
            "layout adoption currently requires macOS or Linux"
        );
        let repository = Repository::read(cwd)?;
        let selected = selected_path(cwd, &request.target)?;
        println!("Found {} registered worktree(s):", repository.records.len());
        for record in &repository.records {
            println!("  {:?}", record.path);
        }
        let saved = saved_root(cwd)?;
        let root = match request.root.or(saved) {
            Some(path) => cwd.join(path),
            None => {
                let default = repository.recommended_root(selected.is_some())?;
                if request.dry_run {
                    default
                } else {
                    ensure!(
                        !request.yes,
                        "first adoption requires --worktrees-dir with --yes"
                    );
                    let answer = prompt(&format!("Worktrees directory [{default:?}]: "))?;
                    if answer.is_empty() {
                        default
                    } else {
                        cwd.join(answer)
                    }
                }
            }
        };
        let plan = Plan::build(repository, root, selected.as_deref())?;
        plan.show();
        if request.dry_run {
            println!("Dry run: no directories, configuration or files changed.");
            if let Some(target) = selected {
                let donor = fs::canonicalize(crate::output_path(
                    crate::checked(git(cwd).args(["rev-parse", "--show-toplevel"]))?.stdout,
                )?)?;
                if donor != target && target != plan.repository.main {
                    crate::sharing::run(cwd, &["--dry-run".into(), target.into_os_string()])?;
                }
            }
            return Ok(0);
        }
        if !request.yes
            && !matches!(
                prompt("Apply this layout and attempt supported sharing? [y/N] ")?.as_str(),
                "y" | "Y" | "yes" | "YES"
            )
        {
            println!("Adoption canceled; nothing changed.");
            return Ok(0);
        }
        let _lock = crate::lock_registration(&plan.repository.main)?;
        ensure!(
            registry::read(&plan.repository.main)? == plan.repository.records,
            "registration changed after preview; rerun adopt"
        );
        for m in &plan.moves {
            ensure!(
                identity(&m.from)? == m.identity,
                "checkout identity changed after preview: {:?}",
                m.from
            );
        }
        apply(&plan)?;
        crate::checked(
            git(&plan.main_destination)
                .args(["config", "--local", ROOT_KEY])
                .arg(&plan.root),
        ).context("layout was adopted, but saving the root failed; worktree files remain at the displayed destinations")?;
        println!("Layout adopted. Saved worktrees directory: {:?}", plan.root);
        share_after_move(&plan);
        Ok(0)
    }

    fn share_after_move(plan: &Plan) {
        if !cfg!(target_os = "linux") {
            return;
        }
        for record in &plan.repository.records {
            if plan.selected.as_ref().is_some_and(|p| p != &record.path) {
                continue;
            }
            let target = plan
                .moves
                .iter()
                .find(|m| m.from == record.path)
                .map_or(&record.path, |m| &m.to);
            if target == &plan.main_destination {
                continue;
            }
            match crate::sharing::run(
                &plan.main_destination,
                &["--dedupe".into(), target.as_os_str().into()],
            ) {
                Ok(_) => {}
                Err(error) => eprintln!(
                    "git-twig: layout adopted, sharing not completed for {:?}: {error:#}; existing files were not replaced",
                    target
                ),
            }
        }
    }

    enum Undo {
        Rename { from: PathBuf, to: PathBuf },
        Directory(PathBuf),
    }
    struct Transaction {
        journal: File,
        path: PathBuf,
        undo: Vec<Undo>,
    }
    impl Transaction {
        fn new(plan: &Plan) -> Result<Self> {
            let parent = plan
                .repository
                .main
                .parent()
                .context("main checkout has no parent")?;
            let path = parent.join(format!(
                ".twig-adopt-{}-{}",
                std::process::id(),
                SystemTime::now().duration_since(UNIX_EPOCH)?.as_nanos()
            ));
            fs::DirBuilder::new().mode(0o700).create(&path)?;
            ensure!(
                fs::metadata(&path)?.mode() & 0o777 == 0o700,
                "cannot protect recovery journal: {path:?}"
            );
            let journal = OpenOptions::new()
                .write(true)
                .create_new(true)
                .mode(0o600)
                .open(path.join("journal.nul"))?;
            let mut transaction = Self {
                journal,
                path,
                undo: Vec::new(),
            };
            transaction.record("twig-adopt-layout-v1", &plan.repository.main, &plan.root)?;
            for m in &plan.moves {
                transaction.record("plan", &m.from, &m.to)?;
            }
            println!(
                "Recovery journal retained at {:?}",
                transaction.path.join("journal.nul")
            );
            Ok(transaction)
        }
        fn record(&mut self, operation: &str, from: &Path, to: &Path) -> Result<()> {
            for field in [
                operation.as_bytes(),
                from.as_os_str().as_bytes(),
                to.as_os_str().as_bytes(),
            ] {
                self.journal.write_all(field)?;
                self.journal.write_all(b"\0")?;
            }
            self.journal.sync_all()?;
            Ok(())
        }
        fn rename(&mut self, from: &Path, to: &Path) -> Result<()> {
            self.record("rename-intent", from, to)?;
            rename_exclusive(from, to)
                .with_context(|| format!("cannot move {from:?} to {to:?}"))?;
            self.undo.push(Undo::Rename {
                from: from.into(),
                to: to.into(),
            });
            self.record("renamed", from, to)
        }
        fn directory(&mut self, path: &Path) -> Result<()> {
            if path.try_exists()? {
                ensure!(
                    fs::symlink_metadata(path)?.is_dir(),
                    "not a directory: {path:?}"
                );
                return Ok(());
            }
            if let Some(parent) = path.parent() {
                self.directory(parent)?;
            }
            self.record("mkdir-intent", path, path)?;
            fs::create_dir(path)?;
            self.undo.push(Undo::Directory(path.into()));
            self.record("created-directory", path, path)
        }
        fn rollback(&mut self) -> Result<()> {
            while let Some(action) = self.undo.pop() {
                match action {
                    Undo::Rename { from, to } => {
                        self.record("rollback-intent", &to, &from)?;
                        rename_exclusive(&to, &from)?;
                        self.record("rolled-back", &to, &from)?;
                    }
                    Undo::Directory(path) => {
                        fs::remove_dir(path)?;
                    }
                }
            }
            Ok(())
        }
    }

    fn repair(main: &Path, peers: impl Iterator<Item = PathBuf>) -> Result<()> {
        crate::checked(
            git(main)
                .args(["worktree", "repair", "--"])
                .args(peers.filter(|p| p != main)),
        )?;
        Ok(())
    }
    fn apply(plan: &Plan) -> Result<()> {
        if plan.moves.is_empty() {
            return Ok(());
        }
        let mut transaction = Transaction::new(plan)?;
        let result = (|| -> Result<()> {
            let mut parked = Vec::new();
            for (i, m) in plan.moves.iter().enumerate() {
                ensure!(
                    identity(&m.from)? == m.identity,
                    "checkout changed before move: {:?}",
                    m.from
                );
                let temporary = transaction.path.join(format!("checkout-{i}"));
                transaction.rename(&m.from, &temporary)?;
                parked.push((m, temporary));
            }
            transaction.directory(&plan.root)?;
            parked.sort_by_key(|(m, _)| m.to != plan.main_destination);
            for (m, temporary) in parked {
                transaction.rename(&temporary, &m.to)?;
            }
            let paths = plan.repository.records.iter().map(|r| {
                plan.moves
                    .iter()
                    .find(|m| m.from == r.path)
                    .map_or_else(|| r.path.clone(), |m| m.to.clone())
            });
            repair(&plan.main_destination, paths)?;
            transaction.record(
                "layout-complete",
                &plan.repository.main,
                &plan.main_destination,
            )?;
            Ok(())
        })();
        if let Err(error) = result {
            let recovery = transaction.rollback().and_then(|_| {
                repair(
                    &plan.repository.main,
                    plan.repository.records.iter().map(|r| r.path.clone()),
                )
            });
            match recovery {
                Ok(()) => bail!(
                    "adoption failed and original layout was restored: {error:#}; journal retained at {:?}",
                    transaction.path
                ),
                Err(rollback) => bail!(
                    "adoption failed: {error:#}; recovery incomplete: {rollback:#}; do not delete anything; recovery journal and parked files retained at {:?}",
                    transaction.path
                ),
            }
        }
        Ok(())
    }

    /// Never use ordinary rename here: a destination appearing after preview
    /// must cause failure, not replacement of an existing directory or symlink.
    fn rename_exclusive(from: &Path, to: &Path) -> Result<()> {
        let from = CString::new(from.as_os_str().as_bytes())?;
        let to = CString::new(to.as_os_str().as_bytes())?;
        #[cfg(target_os = "macos")]
        let result = unsafe { libc::renamex_np(from.as_ptr(), to.as_ptr(), libc::RENAME_EXCL) };
        #[cfg(target_os = "linux")]
        let result = unsafe {
            libc::renameat2(
                libc::AT_FDCWD,
                from.as_ptr(),
                libc::AT_FDCWD,
                to.as_ptr(),
                libc::RENAME_NOREPLACE,
            )
        };
        #[cfg(not(any(target_os = "macos", target_os = "linux")))]
        let result = {
            let _ = (from, to);
            bail!("atomic no-replace relocation unavailable")
        };
        // SAFETY: paths are NUL-terminated and both APIs atomically refuse an occupied destination.
        ensure!(
            result == 0,
            "atomic no-replace rename failed: {}",
            io::Error::last_os_error()
        );
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn parses_layout_options_before_any_effects() -> Result<()> {
        let r = Request::parse(&[
            "--worktrees-dir=/tmp/repo".into(),
            "--dry-run".into(),
            "a".into(),
        ])?;
        assert_eq!(r.root, Some(PathBuf::from("/tmp/repo")));
        assert!(r.dry_run);
        assert_eq!(r.target, Some(PathBuf::from("a")));
        for words in [
            vec!["--layout=global"],
            vec!["--yes", "--dry-run"],
            vec!["a", "b"],
            vec!["--worktrees-dir="],
            vec!["--worktrees-dir", "a", "--worktrees-dir=b"],
        ] {
            assert!(Request::parse(&words.iter().map(OsString::from).collect::<Vec<_>>()).is_err());
        }
        Ok(())
    }
    #[test]
    fn slots_are_literal_safe_components_not_paths() -> Result<()> {
        assert_eq!(slot(OsStr::new("feat/x"))?, "feat-x");
        assert_eq!(slot(OsStr::new("space name"))?, "space%20name");
        assert!(slot(OsStr::new("..")).is_err());
        Ok(())
    }
}

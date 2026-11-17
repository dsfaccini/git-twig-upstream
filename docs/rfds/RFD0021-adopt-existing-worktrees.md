# RFD0021 — Adopt existing worktrees without changing their contents

- Status: experimental proposal
- Author: leostera
- Date: 2026-11-17

## Decision and motivation

Prototype `git twig adopt` for existing linked worktrees. Preserve current bytes,
not HEAD: dirty files and staged changes are legitimate state. Registration,
branches, index contents, file identities, links and permissions must not be
rewritten merely to gain shared storage. Never hardlink a donor. This experiment
is not a release proposal or a claim of measured space savings.

## Guide-level contract

From a donor checkout, `git twig adopt --dry-run ../existing` reports same-path
tracked regular files with byte-identical current contents. Default mode is also
inspection. Both checkouts must belong to the same Git common directory. Missing,
different, empty, multiply-linked, cross-device and nonregular files are skipped;
parent symlinks are not traversed. No ignored/untracked files are adopted.

`git twig adopt --prepare ../existing` retains verified private CoW candidate files
under the common Git directory. Existing worktree files are never replaced.
Candidates are content experiments, not metadata-complete installable files.
Preparation changes Git-owned scratch only and can consume metadata space. It
makes no claim to reclaim existing blocks. Errors leave scratch for inspection.

On Linux, `git twig adopt --dedupe ../existing` uses FIDEDUPERANGE in place. The
kernel compares and shares bytes under its own concurrency control; unsupported
filesystems fail rather than copying/replacing files. An already-open descriptor
continues to refer to the same file. This mode is unavailable on macOS: no
check-then-rename sequence proves exclusion of existing writable descriptors or
mappings. A future APFS application mechanism needs a separate contract.

## Reference-level contract

Arguments select exactly one mode and one target, resolved before any scratch or
sharing operation. Git environment redirects are rejected. Discovery uses the
canonical checkout roots and common-directory identity, not branch names. Target
paths come from NUL-delimited `git ls-files --cached --deduplicate`, never shell
interpolation; special names remain literal. Index bytes are not rewritten.

Files are opened relative to directory descriptors, rejecting symlinks on every
component. Both descriptors must be regular, on the same device, single-linked,
and distinct inodes. Inspection and preparation compare full raw contents; stat
and index cleanliness are not byte certificates. Files can change immediately
after observation, so a dry-run plan is not authority for later application.
Preparation clones an open donor descriptor and rechecks clone bytes against the
open target descriptor; mismatch fails and retains scratch.

Linux ioctl requests use bounded ranges, inspect both syscall and per-destination
status, and advance only by reported successful bytes. The kernel equality check,
not prior inspection, authorizes each range. Partial failure is not rollback:
earlier ranges may already share blocks, without changing either file's bytes.
The output distinguishes observed matching logical bytes, prepared clone bytes,
and kernel-reported deduplicated bytes. None means exclusive physical allocation
reclaimed; that requires a separate filesystem-level measurement.

## Safety and limits

No file replacement, chmod/chown, branch creation, index refresh, hooks, cleanup,
force option or automatic retry. Reading can affect access times. Root directory
lookup and Git metadata discovery assume a trusted local repository; this is not
an adversarial filesystem sandbox. Kernel in-place sharing avoids lost writes but
does not serialize Git status, index operations or editors into one transaction.

A read-only inspection still reads potentially large dirty files. The first
implementation considers same paths only, not cross-path content indexing or all
possible donors. It does not estimate exclusive bytes, deduplicate across volumes,
handle reflink-capable network filesystems, or preserve metadata on prepared files
for installation (because it never installs them).

## Alternatives

Doing nothing preserves all safety contracts but leaves existing worktrees with
full allocations. Replacing files with newly-created clones is portable and easy
but changes inodes and loses writes through already-open descriptors/mappings.
An explicit quiescent flag documents intent, not actual exclusive ownership.
Advisory locks are insufficient for noncooperating tools. Linux in-place range
deduplication avoids that replacement problem; APFS support remains open rather
than silently weakening safety.

## Executable acceptance

CLI tests retain generated repositories under ignored target directories. Compare
raw worktree inventories, index bytes, HEAD, registration, inode numbers and modes
before/after inspection and preparation, with dirty/staged data, filters, symlinks,
non-UTF8/odd names, missing files and donor mismatches. Verify private clones are
not hardlinks and private writes cannot affect either original. Keep an original
file descriptor open to demonstrate why replacement is unsafe on APFS.

Linux tests must independently probe native deduplication and retain status/error
outputs. Cover equal and unequal ranges, live descriptor writes and unsupported
filesystems; never count unsupported fallback as successful adoption. Physical
allocation and performance are separate future measurements, not test timing
assertions.

## Primitive references

- Existing clone adapters: `crates/git-twig/src/native.rs`.
- Linux [ioctl_fideduperange(2)](https://man7.org/linux/man-pages/man2/ioctl_fideduperange.2.html)
  explicitly documents atomicity with concurrent writes and per-destination status.
- Linux UAPI `linux/fs.h` defines the flexible-array request ABI; verify against
  installed headers before claiming a successful Linux implementation.

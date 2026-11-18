# RFD0024 — Verified-index reuse: read each shared file once

- Status: implementation snapshot
- Author: leostera
- Date: 2026-11-18

## Decision and motivation

Stop reading every shared file twice. [RFD0015](RFD0015-batched-raw-object-verification.md)
verifies private clones by hashing them, then installs an index built by
`read-tree`, which holds no stat data. The first `git status` in the new worktree
therefore hashes every file again. RFD0015 named this cost and left
"verified-index reuse" as separate work. This is that work.

For paths Git converts in neither direction, let Git verify the clone *while
refreshing the staged index*, and install that index. One read then yields both
the content verdict and the stat data that makes later Git commands cheap.

The cost is per-file, not per-byte, so small-file repositories feel it most. On
one APFS laptop running endpoint-security software, opening a file costs about
200µs however it is read, and no amount of parallelism helps. A 40,000-file,
87-MiB synthetic tree there took about 12s to create and 8s for its first
status; stock Git took 4s and 1.1–1.7s. After this change the first status
takes 0.15s. Creation is still one full read (about 11s there). These are local
observations from repeated CLI runs, not retained benchmark samples or a claim
about other machines.

## Contract

- A fresh staged index has no stat data. `update-index --refresh` must therefore
  compare every entry by content: this is Git hashing bytes, not stat trust.
- Index refresh hashes what *cleaning* the working file produces. That equals the
  raw blob hash only when cleaning is the identity. A path is eligible only if
  it has no `text`, `eol`, `crlf`, `ident`, `working-tree-encoding` or `filter`
  attribute (literal `unset`/`unspecified` text values are also inert) and
  `core.autocrlf` is false. Everything else keeps RFD0015's raw
  `hash-object --no-filters` or raw blob comparison. In particular
  `eol=lf` and `autocrlf=input` are identity on checkout but not on cleaning:
  a CRLF donor file would refresh clean while differing from the target bytes.
- `.gitattributes` files are never eligible. A dirty tracked one could change
  what cleaning means for its neighbours, so each is certified from raw bytes,
  or rewritten by Git, before the refresh runs. Untracked ones are already
  pruned from the snapshot.
- Length still bounds the work: a private file whose size cannot match the
  target blob goes to Git before the refresh, never through it.
- After the refresh, `diff-files --name-only -z` names every entry that is not
  clean. Eligible paths it names are rewritten by Git. Paths under a conversion
  policy may legitimately stay listed, exactly as after a stock checkout.
- Git-written paths use `checkout-index -u`, so they are recorded too.
- The staged index is created with split index, untracked cache and sparse index
  disabled: it must be one self-contained file tied to no location.
- Installation renames the staged index into the new worktree's Git directory,
  and fails if an index or index lock already exists there. Renaming a top-level
  entry changes its own ctime, so a final `update-index -q --refresh` in the
  destination rehashes only those entries. Nested files keep their identity.
- Policy rechecks, no-overwrite, staging ownership, hooks and failure retention
  are unchanged. A failure of the final refresh is a post-registration failure.

Clone normalization now reads each entry's metadata once and skips `chmod` when
the clone already has checkout permissions.

## Validation

Keep every raw dirty-byte, conversion-policy, attribute-race, sparse-donor and
write-isolation regression. Add: the installed index records inode and size for
root, nested, symlink and Git-rewritten entries; same-size dirty donor bytes are
rewritten, not recorded as clean; attribute classification distinguishes
refresh-eligible paths from checkout-identity ones. The parallel raw-hashing
case now sets `eol=lf` so it still exercises hash workers. The injected late
failure targets the final refresh instead of `read-tree`.

## Alternatives and limitations

Trusting the donor's index stat data would avoid the remaining read, and with it
most of the creation time on machines where opening files is slow. It certifies
only what Git itself believes is clean, and needs an index written without
hashing, which Git's plumbing does not offer. It changes the content invariant
and is not part of this change.

Running `update-index --refresh` after raw hashing would fill the index but keep
both reads. Refreshing every path, eligible or not, would accept bytes that only
match after cleaning.

Index refresh hashes on one thread, where RFD0015 used up to four workers for
large inventories. Total reads still drop from two to one, but creation alone
can be slower on large repositories with fast file opens. That is unmeasured
here. Partial clones list no blob lengths, so a large dirty donor file there is
hashed rather than skipped.

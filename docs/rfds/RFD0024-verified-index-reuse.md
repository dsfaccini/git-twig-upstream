# RFD0024 — Verified-index reuse: read each shared file once

- Status: implementation snapshot
- Author: leostera
- Date: 2026-11-18

## Decision and motivation

Stop reading every shared file twice. [RFD0015](RFD0015-batched-raw-object-verification.md)
verifies private clones by hashing them, then installed an index built by
`read-tree`, which holds no stat data. The first `git status` in the new worktree
therefore hashed every file again. RFD0015 named this cost and left
"verified-index reuse" as separate work. This is that work.

Verification is unchanged: RFD0015's raw hashing, with its workers. What changes
is what happens to its verdict. Twig records the stat data of the files it
verified in a draft index, and Git reads that draft, refreshes it, checks it
against the target commit and rewrites it. The rewritten index is the one
installed.

A first version let Git verify unconverted files while refreshing the staged
index. It read each file once, but on one thread: on a 40,000-file, 87-MiB
synthetic tree on Btrfs it raised creation from about 3.3s to 4.5s while the
first status fell from 0.66s to 0.09s. Keeping parallel raw hashing and recording
its result keeps both. With Linux file clones also spread over a few threads,
creation there takes about 2.5s. On an APFS laptop where endpoint-security
software makes every file open cost about 200µs, creation stays near 11s (one
read, which no parallelism shortens there) and the first status falls from
about 8s to 0.2s. These are local observations from repeated CLI runs, not
retained benchmark samples or a claim about other machines.

## Contract

- No content verdict comes from this change. Twig records a file as unchanged
  only because RFD0015 hashed its private bytes equal to the target blob, and
  only for a path Git converts in neither direction: no `text`, `eol`, `crlf`,
  `ident`, `working-tree-encoding` or `filter` attribute, and `core.autocrlf`
  false. There, equal raw bytes are also what Git calls unchanged.
- Every other entry is written to the draft without stat data: files Git wrote,
  symlinks, and files under a conversion policy. Git compares those by content
  when it refreshes the draft, exactly as after a checkout. A file whose raw
  bytes equal the blob but which cleaning would change (CRLF content under
  `text=auto`, say) therefore stays visibly modified, as in a stock worktree.
- The stat data of a hashed file is taken before hashing. When the draft is
  written the file must still have exactly that identity (inode, size, mtime and
  ctime); otherwise preparation fails and delegates before registration.
- The draft is index version 2 with every target entry at stage 0, in byte order
  of the full path, using the repository's object format. Gitlinks carry no stat
  data. Its trailing checksum is null, Git's own marker for "not computed".
- The draft never reaches a worktree.
  `git update-index -q --refresh --force-write-index` reads it, refreshes the
  unrecorded entries and rewrites it in Git's format, and
  `git diff-index --cached --quiet`
  must then report that it names exactly the target commit. A draft Git cannot
  read, or that names anything else, fails preparation before registration.
- The staged index is written with split index, untracked cache and sparse index
  disabled: it must be one self-contained file tied to no location.
- Installation renames the staged index into the new worktree's Git directory,
  and fails if an index or index lock already exists there. Renaming a top-level
  entry changes its own ctime, so a final `update-index -q --refresh` in the
  destination rehashes only those entries. Nested files keep their identity.
- Git's racy-timestamp rule still applies when it later reads the index: an
  entry as new as the index file is rechecked by content. Cloned files keep the
  donor's older mtime; files Git just wrote may be rechecked once.
- Policy rechecks, no-overwrite, staging ownership, hooks and failure retention
  are unchanged. A failure of the final refresh is a post-registration failure.

Linux clones regular files on up to eight threads for inventories of 1,024 files
or more; directories and symlinks are created first, on one thread, and every
worker joins before a failure is returned. Clone normalization reads each
entry's metadata once and skips `chmod` when the clone already has checkout
permissions.

## Validation

Keep every raw dirty-byte, conversion-policy, attribute-race, sparse-donor and
write-isolation regression. Add: the installed index records inode and size for
root, nested, symlink and Git-rewritten entries; same-size dirty donor bytes are
rewritten, not recorded as clean; the draft's layout, ordering and padding; a
file that changed or vanished after verification is refused; attribute
classification separates paths whose raw bytes settle "unchanged" from those
Git must judge. The line-ending policy matrix compares `git status` with a stock
worktree, which caught an earlier draft recording inherently modified files. The injected late
failure targets the final refresh instead of `read-tree`. Every existing native
test now also exercises Git reading the draft, under SHA-1 and SHA-256 and on
the minimum supported Git.

## Alternatives and limitations

Letting Git verify during an index refresh needs no index writer, but hashes on
one thread and only certifies paths Git never converts; it was slower where
file opens are cheap. Running a refresh after raw hashing keeps both reads.

Trusting the donor's index stat data would avoid the remaining read, and with it
most of the creation time on machines where opening files is slow. It certifies
only what Git itself believes is clean. It changes the content invariant and is
not part of this change, though the draft index is what it would need.

Twig now writes one Git file format. The surface is deliberately small: one
version, no extensions, no checksum, and Git must accept and rewrite the result
before it is used. A future index format changes nothing here as long as Git
still reads version 2.

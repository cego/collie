# A Run's checks are read where its checkout starts

**Status: accepted, to be built.** Amends
[ADR-0055](0055-a-run-never-asks-to-run-its-checks.md) D1, which says which file a Run's
checks come from but not from which tree. Keeps
[ADR-0035](0035-a-repositorys-checks-are-remembered-by-its-remote.md)'s remembered checks
and ADR-draft-a-check-left-to-ci-is-proved-by-its-pipeline-job as they are.

cego/collie's `.collie/verify.json` has left `check` to CI's `test` job since #218. Every
Release since then has still run `bun run check` on the Machine anyway, and
run-3301611c.release spent 447 s on it (#210). Its implement Run was started from
`/home/mk/.collie`, a checkout of master that was 115 commits behind origin and had no
`.collie/verify.json`. A start reads that file from the working tree of the checkout it was
made from, so it found none and took the checks remembered for the remote, which have no
`ci`. The Run's own checkout was cut from `origin/master`, which has the file. The Run was
held to checks that its own tree did not declare.

## Decision

**D1. A Run reads the project's checks file at the commit a checkout for it starts
from.** That is the ref a checkout is cut from: the remote branch the Run works on, else
the remote's default branch. The start has no checkout yet, so the start and the checkout
take their ref from one rule. What the checkout the start was made from has on disk, behind,
ahead or uncommitted, does not decide the Run's checks.

**D2. This holds for a Run with no checkout of its own too.** A `plan` or `architecture`
Run has no checkout, and the `implement` Run it chains into inherits its Intent, checks
included. If such a Run read the working tree, the stale checkout would still decide the
checks of every Run chained from it. run-38b2c876, the plan that made this decision, was that case:
it was started in `/home/mk/.collie` and admitted with `bun run check` and no `ci`. Only a repository with no
such ref, one with neither a remote nor a local default branch, falls back to the working
tree.

**D3. The order is unchanged.** It is still `--verify`, then the project's file, then the
checks remembered for the remote, then the user's `verify.json`, and the first one found
is taken whole. A plan that spans repositories reads each repository's file the same way.

## Consequences

- An uncommitted edit to `.collie/verify.json` no longer reaches a new Run. To try one, push
  it to the branch the Run starts from, or name the checks with `--verify` or
  `collie run intent verification`.
- A Run started from another still inherits that Run's Intent as it stands. Because the
  first Run of a chain now reads at the base, what it hands on is the base's.
- A base ref that cannot be read is the same as a base with no file: the next layer is
  read. A file at the base that does not decode is refused by name, as a working-tree file
  is today.
- Nothing is fetched to make this work. The start reads whatever ref the checkout will be
  cut from, so the two cannot disagree.

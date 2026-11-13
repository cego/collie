# A worktree's build cache goes once no live Run works in it

**Status: accepted.** It amends [ADR-0045](0045-collie-removes-what-it-made-once-nothing-needs-it.md)
D1 and D5.

## Context

Cargo builds into each checkout's own `target`. On vm-mk one worktree's `desktop-rune/target`
held 19 GB: 7.8 GB of build-script output, 5.2 GB of dependencies and 4.7 GB of incremental
sessions. ADR-0045 removes a worktree only once it is **Settled**, so a worktree whose Task
still owes work, or whose workspace is open, kept its whole target long after any Run used
it. The Machine's disk filled twice in a day, and Runs lost their checks and failed.

A Cargo target shared by every checkout was considered and rejected. Most of a target is the
workspace's own crates, which Cargo builds apart for each checkout's path, so little would be
shared. Cargo's lock on the build directory would make concurrent Runs wait for each other's
builds. A shared directory would still grow without bound.

## Decision

**D1, amended.** A build cache inside a worktree Collie made is a kind Collie may remove. It
is proved Collie's by the worktree's Run record. It is proved a cache by being ignored and
untracked in git and by holding a `CACHEDIR.TAG` with the standard signature. Nothing else in
the worktree is touched, and a directory without that tag is never a candidate.

**D5, a row added.** A worktree's build cache is kept while a Run that has not ended works in
that worktree. Once none does, the next sweep removes it. A build cache costs nothing but a
rebuild to make again.

## Consequences

- A worktree that is kept but idle holds its sources, not its build output.
- A finished Run that is steered again rebuilds from scratch, and a build already running
  when its cache goes fails once.
- A live Run's own target is not limited. `collie doctor`'s low-disk warning (D7) remains the
  signal for that.

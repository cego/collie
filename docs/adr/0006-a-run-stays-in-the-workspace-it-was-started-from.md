# 0006 — A run stays in the workspace it was activated from

**Status:** accepted, 2026-09-03

## Context

A mutating run needs a checkout of its own — two runs sharing a working tree share an
index and a stash stack. It used to get one by asking herdr (`herdr worktree create`),
which opens the checkout as a workspace and groups it with the repository's parent
workspace. herdr groups by Git provenance only and offers no way to place a workspace
into another group (CLI reference 0.8.2), so a run started from the operator's own
workspace landed somewhere else in the sidebar, and a workspace whose cwd is not a
checkout of the repository could not host a run at all.

The operator's rule is that the work surrounding a task is encapsulated in its
workspace. A checkout of its own is about not sharing an index; it was never about being
somewhere else in the sidebar.

## Decision

By default Collie makes the checkout itself with `git worktree add` and the run stays in
the workspace it was activated from: the Collie tab and every step tab are created with
`--workspace <that id>` and `cd`-ed into the checkout. The path is the same one herdr
would have used — `<worktrees.directory>/<repo>/<branch>`, from herdr's own config where
it sets one — so herdr's "open worktree" UI still finds the checkout. A branch's own `/`
segments nest rather than being flattened, because two branches that flatten to one
directory would be two runs one checkout away from sharing an index.

`--input workspace=new` selects the old behaviour and gives the run a herdr worktree
workspace of its own. It is a declared Input of every mutating workflow rather than a flag
one front door intercepts, so the CLI, the herdr actions and a chained run all reach it
the same way, and a `plan` started with it chains into an `implement` that gets one too.

The run records which it was (`worktree.managed_by`), because that decides who takes the
checkout away again: a git-managed checkout is removed with `git worktree remove` and
`git branch -d`, and the run's tabs still holding a shell inside it are closed with it —
a tab herdr will not close is counted on the board's removal line, since the checkout has
left the listing by then and nothing comes back to retry it. A checkout herdr has a
workspace open on goes through
`herdr worktree remove` whoever made it, so herdr never lists a checkout that is gone.

## Alternatives

- Ask herdr to place a workspace into a chosen group: no such method, and it would make
  Collie's placement depend on an upstream change.
- Keep the separate workspace and accept the sidebar: rejected by the rule above, and it
  leaves a workspace that is about a task unable to host a run at all.
- Run in the directory the run was started from: what this whole mechanism exists to
  prevent — it swapped one run's uncommitted work for another's.

## Consequences

Collie now shells out to git for the checkout, so the worktree path convention is
Collie's to keep in step with herdr's. A git-managed checkout is not a workspace, so it
has no sidebar entry of its own; `herdr worktree list` still lists it, and
`workspace=new` is the escape hatch for anyone who wants the old shape.

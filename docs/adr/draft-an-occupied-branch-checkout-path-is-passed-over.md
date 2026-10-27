# An occupied branch checkout path is passed over, and a refused cut leaves nothing behind

On 2026-10-27, Stage for one open merge request was refused three times in a row before any
step ran: `fatal: '<worktrees>/monorepo/<login>/run-<id>' already exists`. Nothing was wrong
with that directory. It was a live, clean worktree of a second clone of the same remote,
and both clones are called `monorepo`. A branch checkout's path is
`<worktrees>/<basename>/<branch>`, so two clones of one name want the same directory.
`gitCheckout` never looked at what was there. It ran `git worktree add` and returned git's
error, and the first attempt's `-b` had already created a local branch that stayed behind.
Every retry was refused in the same way (#220).

The roaming claim already asks who owns its destination (`occupant`, `describeOccupied`).
The branch checkout, which implement, investigate, a review's fix round, Stage and Release
all go through, did not.

This is not ADR-draft-a-kept-roaming-checkout-is-passed-over. That one is about an ended
Run's kept work in a roaming slot of _this_ repository. This one is about a branch
checkout's path that belongs to somebody else.

## Decision

**Reuse is what git lists.** A checkout that this repository's `git worktree list` has on
the branch is given to the Run, as today. Nothing else at any path is reused, whatever it
contains and whichever commit it is at.

**A path that is not free is passed over.** A new checkout goes in the first free slot of
`<worktrees>/<basename>/<branch>`, `…/<branch>-2`, `…/<branch>-3`. The suffix goes on the
last segment. One lock keyed by the first slot's path covers the whole look and cut, so two
clones of one name contend on it, as they do for `roaming`. A checkout git already lists on
the branch is reused only under that lock too, because git lists one before it has filled it.
Under the lock git is asked for the list again, so a Run that waited finds the checkout the
first one cut and reuses it.

A slot that holds anything is left as it is and passed over. That includes another clone's
checkout, a directory that does not say which repository it belongs to, and a checkout of
this repository on another branch. The Run's log names each slot it passed over in
`describeOccupied`'s words. When all three are passed over, the start is refused. The
refusal names each slot, says whose it is, and says what the human can do.

**A refused cut has no side effects.** What is at the path is read before git writes
anything. Collie makes a new local branch itself, at the commit it resolved the base to, with
`git branch`, which refuses a branch somebody else made since the look. `worktree add -b`
cannot be used: it fails the same way whether or not it made the branch. If the checkout
then fails, Collie deletes the branch it made, but only while it still points where it was
made. A branch that existed before is never moved, reset or deleted.

**The head is checked where it is used.** A local branch is checked out as git has it.
Stage and Release already fast-forward their checkout to the merge request's head. That
refuses a dirty or diverged checkout and parks the Run without discarding anything, and it
stays their check.

## Rejected

- **Refusing as soon as the first path is occupied.** Nobody can act on that refusal
  without removing another clone's checkout, which is a valid checkout of another Run.
- **Using the Run's placed checkout when it is at the head on another branch.** That is
  another Run's working tree, and checkouts exist so that two Runs never share one. A fix
  round also needs the branch itself, to push to it.
- **A path keyed by the repository's location**, such as `<basename>-<hash>/<branch>`. It
  moves every checkout and breaks the `<repo>/<branch>` layout that herdr and humans read.
- **Remembering a refusal so that an offer of Stage again is withheld until something
  changes.** Nothing can tell cheaply that something changed. Since a collision is now
  passed over, the remaining refusal is one a human fixes and then retries. The retry gives
  the same refusal and has no side effects.

## Consequences

A second clone of a repository gets its own checkout of a branch, at a suffixed path. The
cleanup sweep judges it by its record, as it judges any other. `docs/using.md`'s
`<repo>/<branch>` paragraph names the slots. A checkout that herdr makes (`separate`) still
goes to the path herdr chooses, and that case is outside this decision.

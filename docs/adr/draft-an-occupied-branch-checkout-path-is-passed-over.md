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

## Amendment: Stage works in the checkout of the Run blocked on it

Stage started by implement's **What next?** cut a checkout of its own even when implement's
was already at the merge request's head on a branch of another name (#220). A Stage Run now
works in the checkout of the Run that started it, and cuts nothing, when all of these hold:

- that Run is blocked awaiting this Stage's result and no other child's. The engine
  records each child a parent awaits when the wait begins, and again when it is replayed
  after a restart. It clears the record only when the result returns: a suspended child is
  still awaited;
- that Run has a checkout of its own, not the project it was started in;
- the checkout is clean and at the merge request's head, fetched from the remote first;
- no agent is working there. A herdr that will not say counts as one.

Only a Run that asks for its starter's checkout is given it. The checkout is on the
starter's branch, not the merge request's, so Stage asks because it commits and pushes
nothing, and Release and a review's fix round, which commit and push to the reviewed
branch, always cut their own.

Otherwise the checkout is resolved as above, and the log says why the starting Run's was not
used. A parent that awaits nothing, such as one whose card started the Stage, keeps its
checkout to itself, because it could go on in it while Stage works there. No other Run's
checkout is ever taken, so the rejection of a fix round's taking over another Run's working
tree stands.

## Amendment: Stage again is offered only where its checkout would get past

With all three paths held, a failed Stage's card offered **Stage again**, and implement's
**What next?** offered **Stage**. Each pick started another Stage that was refused at its
Checkout in the same way, the pattern #197 fixed for a review's fix (#220).

The checkout's resolution now has a form that cuts and records nothing: `checkoutRefusal`. It asks what a real cut asks:
the branch, the starting Run's checkout as in the amendment above, a checkout git lists on
the branch, and the three slots. It answers in the cut's own words. The host records that
a Run's reviewed checkout was refused, in that Run's directory, and the record decides
nothing by itself.

- **On the card.** For a failed Run with that record, every follow-up that starts the same
  workflow again is asked about each time the card is drawn and again when it is invoked
  (ADR-0025). While the resolution would still refuse, the follow-up is listed as
  unavailable with the refusal. The rule reads no workflow's id (ADR-0029), so Release's
  **Release again** follows it too, since it takes its checkout the same way.
- **In What next?** After a Stage child whose checkout was refused, implement asks the same
  resolution for a Stage it would start and wait on, before asking and when **Stage** is
  picked. While it would refuse, **Stage** is left out and the question says why.

Once an occupant is gone, both offer it again. A Stage or Release that failed for any other
reason has no record and is offered again as before.

This narrows the rejection above of remembering a refusal. What is remembered is only that
the checkout was refused, never the answer. The answer is asked again each time, at the
cost of one `git worktree list` and three path reads.

The dry resolution and the real cut can still disagree when an occupant changes between
them. The real cut refuses as before, so the cost is one failed Run.

## Consequences

A second clone of a repository gets its own checkout of a branch, at a suffixed path. The
cleanup sweep judges it by its record, as it judges any other. `docs/using.md`'s
`<repo>/<branch>` paragraph names the slots. A checkout that herdr makes (`separate`) still
goes to the path herdr chooses, and that case is outside this decision.

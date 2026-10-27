# A kept roaming checkout is passed over, and an unattended plan writes nothing in it

The Schedule `self-improve-machine` on vm-mk was refused at 2026-10-23, 24, 25 and 26,
19:00Z, and will be refused every day after that: `/home/mk/.herdr/worktrees/.collie/roaming
is a checkout of /home/mk/.collie, recorded by Run run-9a0c1c66, kept: uncommitted changes`.
run-9a0c1c66 had ended. No process worked in the checkout. The one change in it was an
ADR-0054 amendment, which matches master byte for byte because #197 landed the same text.

Two decisions caused this.
[ADR-0053](0053-collie-files-and-fixes-what-its-own-runs-show.md) has an Improvement's
`plan` Run work in self-improve's roaming checkout. `plan`'s grill puts glossary and ADR
changes "into the repository", so each of run-9a0c1c66's three planners wrote into one
shared working tree, at the same time, and nothing ever committed it. Its implement Run
wrote the docs again on its own branch, as Invariant 7 requires. run-9a0c1c66 was the first
self-improve whose Improvements started (#173 refused them before it), so every self-improve
that plans an Improvement leaves this behind. The second decision is the takeover (#99). It
refuses whatever moving the checkout would lose, and that is right. But one ended Run's
leftover then blocks every later roaming start of the repository, for good.

This is not #220. There, a branch checkout's path is held by another clone of the same
remote, and nothing asks who owns it. Here, the owner is known and has ended, and the
refusal protects that owner's work on purpose.

## Decision

**What a roaming start may not take, it passes over.** A repository has up to three roaming
checkouts: `roaming`, `roaming-2` and `roaming-3`, under its worktrees directory. A start
looks at them in that order, under one lock keyed by `roaming`'s path. That lock covers the
look and the claim for every slot, so two concurrent starts never get the same one.

- A Run of this repository that has not ended (stopped and waiting Runs count) holds one of
  them: the start is refused, as a second `renovate` is today. One roaming Run per
  repository at a time is unchanged.
- An empty slot is made there. An ended Run's slot that would lose nothing is taken over,
  with every refusal it has today.
- Anything else is left as it is and passed over. That covers a slot kept for an ended
  Run's uncommitted changes or unpushed commits, another clone's checkout, one no Run
  recorded, and one other than the checkout the Run made. Collie never stashes, commits,
  resets or deletes it to make room.
- The Run's log line names each slot it passed over, and why. When all three are passed
  over, the refusal names each one and why, so the operator has the paths to look at.

**An unattended plan writes nothing in its checkout.** A `plan` with `then=implement` puts
each glossary or ADR change it decides in the ticket that needs it. The build writes it on
its own branch. An attended plan still writes them into the repository as they are agreed.

## Rejected

- **A new checkout per Run**, such as `roaming/<run>`. It needs a cleanup and a naming
  change. Kept checkouts would still pile up silently while the cause went on.
- **Preserving the work on a branch, or in a stash, and then taking the checkout over.** It
  writes refs into the operator's repository, can run its hooks, and picks untracked files.
  The work is safe where it is.
- **Treating changes that match the new base as nothing lost.** That would unblock this
  incident, but it needs a forced checkout over the operator's tree. Passing the slot over
  is enough.

## Consequences

ADR-0053's "Another Run holding that repository's roaming checkout refuses the start" now
applies only while that Run has not ended. The cleanup sweep already removes an ended
roaming checkout that holds nothing and keeps one that does. A kept slot stays until a human
deals with it. A fourth leftover before then refuses again, and that refusal names all three.

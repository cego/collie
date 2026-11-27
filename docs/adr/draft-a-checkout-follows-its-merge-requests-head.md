# A checkout follows its merge request's head

**Status: draft.** Decided while building #542. It changes the promise
[`docs/workflows.md`](../workflows.md) makes about Release's and Stage's checkout, and the
fast-forward seam the two of them call.

## What was true before

Release and Stage were documented as only ever fast-forwarding their checkout, and the
host's `fastForward` refused any head that was not a descendant of the checkout's own:
"does not fast-forward …, as after a force push". Nothing was reset, so nothing was lost.

A merge request rebased on the forge is the case that promise could not survive. The
forge replaces the branch with a rebase of it, so the head the merge request now has is no
descendant of the head the checkout sits at. Every such Release parked `release-failed`
and started a Heal — the reported case (#542). The worktree could only be moved by hand,
which is exactly the work Release exists to remove. The same refusal also threw away the
one fact that says the move is safe: that the commit the checkout sits at was published,
so the forge still has it and nothing unpublished is dropped by resetting.

## Decision

**D1. Prove binds to one head: the forge's head of the merge request.** Release and Stage
bring the checkout to that head through the one seam they already share, the host's
`fastForward` of a placed worktree. Nothing reads the checkout before it is there.

**D2. A clean checkout whose own head was published is reset to the forge's head.** The
host resets it (`git reset --hard`) and logs
`moved the checkout from <from> to <head>, which origin's <branch> no longer carries`.
The commit is not lost: the forge carried it. Published means either of these:

- origin's remote-tracking branch for this branch has carried that commit — the commit is
  one of that ref's reflog entries, or one of their ancestors — or origin still has the
  branch and carries the checkout's own head, however far past it the forge has since
  moved the branch. Both questions are asked of origin (`git ls-remote`, whose answer is
  the tip ancestry is tested against), never of the tracking ref, because a fetch refspec
  can leave behind a ref that `--prune` does not reach and that a force push has since
  passed;
- this Run recorded it as a head earlier, journaled in the Run's own `heads.jsonl`, which
  covers a reflog that was expired or a ref fetched fresh.

A move that would write over a file the checkout keeps out of git — an ignored file at a
path the new head tracks, in either direction — is refused instead, naming those files
under `branch-force-pushed`, before either a reset or a fast-forward runs: `git status`
does not show them, and both git commands overwrite them. That guard is asked only where
Git would actually move the checkout, since a checkout already carrying a published head
answers `At` and writes nothing. Whether the checkout is dirty is read with
`--untracked-files=all`, since a person's `status.showUntrackedFiles` would otherwise hide
a file a reset goes on to replace; and an entry marked `--assume-unchanged` is compared
with its index blob by content, because `status` cannot see an edit to one either, while a
`--skip-worktree` entry is left alone: it is what a sparse checkout is made of.

**D3. A checkout holding commits that were never published is not reset.** The refusal
names every commit at risk that origin never carried, by short sha and subject, and carries
the park cause `branch-force-pushed` — a needs-you cause that never heals. Release and
Stage park under the cause the refusal carries. Refusals this decision does not type — a
wrong branch, an unreadable checkout, a head origin lacks, a failed merge — keep
`release-failed`; a dirty or unpushed checkout is typed by D5.

**D4. What still fast-forwards still does.** A checkout behind the head fast-forwards as
before, and a stale journaled head the checkout already carries still answers `At`.

**D5. A dirty or unpushed checkout is named, and only Collie's own is touched.** Before it
is read, the host waits for every agent of the Run placed in that checkout to stop working,
bounded by the collection budget — each roster read sized by what is left of it — and a
Stop cancels the read in flight. After the wait, a
checkout with uncommitted changes, or one whose head is ahead of the requested head while
origin's branch does not carry it, is refused under `checkout-dirty-collie` where Collie
made the worktree and `checkout-dirty-human` where it did not, naming the files or commits.
Collie resets neither, and a human's checkout it never touches at all.

**D6. A Collie-made checkout gets one round before it parks.** Release asks the Run's own
agent to commit the work and push it with a plain push, reads the checkout again, and parks
`checkout-dirty-collie` only when that leaves it dirty or ahead. The park's recheck is
the tree being clean **and** origin's branch carrying its head, so a clean checkout whose
commit was never pushed stays parked and resumes by itself once the push lands. The read
that refuses is taken inside the Activity that parks, which never completes: a resume reads
Git again rather than replaying the refusal and the round that already ran.

## Alternatives rejected

**Always refusing, and healing every rebase.** This was the behaviour, and it is what
#542 reported: the forge and the Run could settle it, and instead a person had to reset a
worktree and a Heal had to diagnose a park with no defect in it. A Heal is for what only a
diagnosis can settle.

**Reading a checkout while the Run's agent is still working in it.** #508: the agent's
half-written fix was judged dirty, and the Release parked on its own agent's work. The wait
is bounded, so an agent that never ends its turn still hands the checkout on.

**Pushing or resetting a checkout Collie did not make.** A person's uncommitted work and
unpushed commits are theirs to keep or drop, so that checkout parks `checkout-dirty-human`
and is not touched.

**Clearing a clean checkout park on the tree being clean alone.** A clean checkout whose
commit was never pushed is not proof of anything at the forge, so the recheck reads origin
too.

**Resetting whenever the tree is clean.** Without the published test, a rebase would drop
a commit the Run had never pushed. The published test is what lets the reset be silent and
the refusal name what it protects.

**Reading only origin's reflog.** A fresh clone or an expired reflog forgets a head origin
did carry, and the Run's own record is what still knows it. Reading only the Run's journal
would miss a commit published by another Run in the same worktree, so both are read.

## Consequences

- A Release or a Stage whose merge request was rebased continues from the forge's head and
  reaches its go without a person or a Heal.
- A rebase that would drop unpublished work parks `branch-force-pushed`, naming the
  commits, and never heals: only a person may say which history stands.
- The Run records every head it takes a checkout to, in its own journal, so a later
  decision about a force push does not depend on what this clone's reflog remembers.
- The move of a checkout to a head origin no longer carries is on the Run's log, so a
  person can see why the tree changed.
- A Run's own agent finishing its turn no longer parks its Release: the checkout is read
  afterwards, and one bounded commit-and-push round repairs what it left behind.

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

- origin's remote-tracking branch for this branch has carried that commit — it is in that
  ref's reflog, or it descends from a commit that is;
- this Run recorded it as a head earlier, journaled in the Run's own `heads.jsonl`, which
  covers a reflog that was expired or a ref fetched fresh.

**D3. A checkout holding commits that were never published is not reset.** The refusal
names each commit at risk that origin never carried, by short sha and subject, and carries
the park cause `branch-force-pushed` — a needs-you cause that never heals. Release and
Stage park under the cause the refusal carries. Refusals this decision does not type — a
wrong branch, an unreadable checkout, a head origin lacks, a failed merge, an uncommitted
tree — keep `release-failed`.

**D4. What still fast-forwards still does.** A checkout behind the head fast-forwards as
before, and a stale journaled head the checkout already carries still answers `At`.

## Alternatives rejected

**Always refusing, and healing every rebase.** This was the behaviour, and it is what
#542 reported: the forge and the Run could settle it, and instead a person had to reset a
worktree and a Heal had to diagnose a park with no defect in it. A Heal is for what only a
diagnosis can settle.

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

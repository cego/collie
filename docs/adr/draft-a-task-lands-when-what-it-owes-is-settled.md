# A Task lands when what it owes is settled

A Task's standing was its newest Disposition on any of its Runs, and any Disposition —
`merged`, `abandoned` or `superseded` — made it Landed. On 2026-11-10 on vm-mk, recovery
recorded `superseded` on four failed Nuxt CI upgrade Runs, each naming the follow-up in
the same Task that carried the same branch and merge request (support !279, compliance
!338, marketing !417, payments !952). Every line was true of its own Run. The board lifted
it to the Task. Each Task went to Finished saying "Superseded by" its own leading Run. The
merge watch stopped asking about the four merge requests. Cleanup closed their workspaces
and removed their checkouts "superseded, as recorded". All four merge requests were open
and waiting for an approval. The board would have hidden them in History the next day.

A Run ending well and a Task's work being delivered are different facts, and only the
forge can say whether a merge request merged.

## Decision

**D1. A Task owes each merge request its Runs carry, and a branch with none.** What it
owes is read from the Runs' records, as before. Nothing new is tracked.

**D2. A merge request is settled by the forge or by an explicit abandonment.** It is
settled when its forge reads it merged, or when the Run carrying it, or the Task's leading
Run, records `abandoned`. A recorded `merged` settles it unless a forge answer read after
that record says open. A forge that cannot be read settles nothing and unsettles nothing.

**D3. `superseded` hands a Run's obligation on; it does not settle an open merge request.**
A superseded Run stops being the one responsible. A successor in the same Task carries the
same merge request, so it is still owed. A successor in another Task makes that Task
responsible. A merge request its forge reads closed is settled by `superseded`, because
it cannot land and the human said the work went elsewhere. If it is reopened, it is owed
again. A `superseded` line naming the Run it is recorded on is refused.

**D4. Landed is derived once.** A Task has landed when everything it owes is settled and
none of its Runs is going. The board's section and sentence, History, the merge watch,
Cleanup, chat's reads and Desktop all use this one reading. The merge watch keeps asking
about every merge request a Task still owes, whatever its section or age.

**D5. Finish ends a Run, not a Task's delivery.** `then=finish`, the end menu's Finish
and acknowledging a report end or quiet the Run. A Task that still owes a merge request
stays in Waiting on you. Its sentence names the merge request and what is left, such as
approval, checks at its head, or a conflict.

## Rejected

- **Read only the leading Run's Disposition.** That fixes these four cards, but Cleanup
  still reads every Run's line, and a superseded attempt with its own merge request stays
  hidden.
- **A Delivery ledger per Task.** It would be a second record of what the forge and the
  Runs already say, and it would drift from them.
- **Refuse a human's `merged` while the forge says open.** The forge can lag a real
  merge. Recording the claim and letting a later forge answer outrank it costs nothing.

## Consequences

Tasks that were wrongly Finished come back to Waiting on you once the merge watch asks
about them again. Nothing is rewritten, and no notification is raised. A Task whose
checkout was removed shows that it has no checkout. A follow-up recreates the checkout
from the pushed branch. The merge watch asks about more merge requests, once per 5 minutes
each. Each answer is stored with the time it was read, so a card can say when the forge
last answered.

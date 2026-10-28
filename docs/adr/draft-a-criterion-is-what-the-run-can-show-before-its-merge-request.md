# A criterion is what the Run can show before its merge request

Three implement Runs ended with no review and no merge request on criteria that no build
step could meet (cego/collie#126). In run-33c8f85a.implement, four of ticket 01's criteria
could be seen only in CI or after a deploy. In run-ed73efbf.implement, ticket 04's criterion
named a file that #118 removed while the Run was building, and eight built tickets went with
it. `implement` read a ticket's criteria once, when the ticket started, and judged both
hand-backs and the final answer against that copy. A planner's amendment never reached the
builder, which said so: the criteria step still quoted the old wording. `plan.md` asked only
for "criteria someone else can check".

## Decision

**D1. A criterion is something the implement Run can show before its merge request**, such
as a test, a file or a command's result on the branch. An outcome that only CI, a merge or a
deploy can show goes under the ticket's `## After merge` heading as a plain list, not as
checkboxes, and is not a criterion. `plan.md`'s tickets step says so. Criteria are read only
from checkboxes under the Acceptance criteria heading, or from the whole ticket where it has
none, and never from under `## After merge`.

**D2. Criteria are read again before each hand-back and before the final judgement.** A
ticket the planner amended while it was being built is judged, and handed back, as it reads
now. This is [ADR-0024](0024-a-list-of-work-is-known-by-its-names.md)'s rule for the list of
tickets, applied inside one ticket.

**D3. A builder may answer a criterion `after merge: <reason>`.** It says what will show the
outcome and why the Run cannot. Such an answer is neither met nor unmet: it does not go back
to the builder, and it does not end the Run. The reviewer is shown it beside every other
answer and is told to raise it as blocking where the Run could have shown it. The merge
request names it, with the ticket's `## After merge` outcomes, under **Not settled by the
run**. This covers a Run built from a Linear spec or from text as well, which has no planner
to amend a ticket.

**D4. A criterion still `not met` after the hand-backs asks to hand it back or stop.** The
ticket can be amended before a hand-back; `Stop` fails the Run, as every other stop short of
the merge request does.

## Consequences

- A criterion only a merge can show no longer throws away a Run's built work.
- An agent can defer a real criterion on its own word. The reviewer is the first check on
  that and the human at the merge request the last, and the deferral is always written
  where both read it.
- A criterion made impossible by a change on the default branch is neither after-merge nor
  buildable. The planner amends the ticket, and D2 carries the amendment to the builder.

The goal, in my words:

{{inputs.goal}}

Project root: {{cwd}}
This run's plan directory: {{run.dir}}/plan
This run's id: {{run.id}}

A note you hand on — to a later step, another agent or a human — goes in
`{{run.dir}}/handoffs/`, never `/tmp`: the Run's record lists it, and it is kept as long
as the Run is.

{{rooting}}

{{attendance}}

## grill

If the goal above is a Linear issue id or a Linear URL, fetch it first with the Linear
MCP and treat what it says as the goal.

Read the goal and the repository first. Ask only when a missing decision changes what
you should build. When the goal is clear, proceed without an interview or approval of
a summary. Do not ask me to invoke another skill or to confirm that you may write the plan.
For larger work, break it into manageable pieces yourself.

Glossary (`CONTEXT.md`) and ADR changes we agree on go into the repository as we agree
them — they are domain knowledge. Nothing else does.

Choose the result kind from the task; this is metadata, not another question. Each one
decides what the build has to prove before it opens its merge request:

- `feature` — every ticket built, and a reviewer saying the agreed scope was met.
- `bug` — a `regression` verification that fails before the fix and passes after it.
- `refactor` — a reviewer saying behaviour was preserved. Not for a change that alters
  behaviour on purpose.
- `investigation` — a conclusion with evidence inside the run, and a reviewer saying it
  holds; there may be no patch.
- `docs` — every documented command run and passing, and a reviewer saying the
  instructions are accurate.
- `migration` — passing `migrate-up` and `migrate-down` (or `rollback`) verifications, and
  a reviewer saying it is compatible both ways.

Leave it empty if none fits: then only the run's checks have to pass. A wrong kind can be
changed later with `collie run intent set-outcome`.

Then write your Output, with what we settled under `decided`.

## spec

You were started with {{skill:to-spec}}. Write the spec to `{{run.dir}}/plan/SPEC.md`. It opens with an
`## Objective`: one paragraph saying what the plan's Runs are to achieve, which each of them
takes as its goal. It has the problem in one paragraph, what is explicitly out of scope, the ordered work with the seams that want
tests, and how we will know the whole thing works. The tickets carry each piece's detail
and acceptance criteria, so the spec does not restate them.

Then write your Output, naming the spec you wrote.

## tickets

You were started with {{skill:to-tickets}}. Cut the spec into tickets: one file each at
`{{run.dir}}/plan/issues/NN-<slug>.md`, numbered in the order they can land. Each says
what to build, what blocks it, and criteria someone else can check.

A criterion is something the implement Run can show before its merge request: a test, a
file, or a command's result on the branch. An outcome that only CI, a merge or a deploy can
show is not a criterion: put it under the ticket's `## After merge` heading as a plain list,
not as checkboxes, and the merge request names it.

A criterion is one the ticket's absence would make false: one the base already meets is a
Tautology. Before you write a criterion that names a command, run that command through
`collie verify` on the tree this plan is written against, the default branch's head:

- where it passes there, the criterion is a guard, and says it is one;
- where it fails there, the criterion is that the branch adds no failure over the base, and
  names the failures already present.

A text search is never a criterion.

Every ticket also carries a fifth header line, `**Repo:** <path>`, between "Blocked by"
and "Status" — always, one repository per ticket. The path is the checkout the ticket
changes, relative to the project root above and as it is on disk; write `.` when the root
is itself a repository. It is a path under that root: never absolute, and never with a
`..` in it. Implementation runs are fanned out one per repository from these lines, so a
ticket without one, or one naming a path that is not checked out under the root, stops the
whole hand-off.

Number every ticket of a plan once: a "Blocked by" line names a number, so two tickets
wearing one cannot say which an edge points at.

A "Blocked by" line names the numbers of the tickets it waits for, or `None` — every
number matching a ticket of this plan. Write each as a bare number; a number that is part
of a word, as in "the v2 rollout", is read as part of that word rather than as a ticket.
The waves are built from those lines, so one naming something that is not a ticket here
stops the hand-off too rather than quietly losing the edge.

Where the work spans several repositories, one rule holds: taken repository by
repository, the blocking edges must not form a cycle — once a repository's tickets are
blocked by another's, none of that other one's may be blocked by this one. Put the
repository that defines the contract first, and prefer one ticket per repository per
wave.

Then write your Output, naming the directory you wrote them to.

## unbuildable

The tickets in `{{run.dir}}/plan/issues/` cannot be built as they are:

{{refusal}}

Fix the tickets so that reason no longer holds, changing nothing else about the plan.

Then write your Output, naming the directory you wrote them to.

## second-opinion

Read `{{run.dir}}/plan/SPEC.md` and every ticket in `{{run.dir}}/plan/issues/`.

Review the plan, not the code: stories the spec is missing, seams in the wrong place,
tickets that cannot land on their own, an order that cannot work, criteria nobody can
check. Do not review the repository, do not propose implementations, and change nothing.

Raise, too, each criterion that is true by construction, each guard not labelled as one, and
each criterion whose only proof is a text search.

## revise

A second reviewer read the plan and found:

{{findings}}

Fix the spec and the tickets where you agree. Where you do not, leave them and record
why under `disputed`.

Then write your Output. The `changelog` is sent to an implementer already building from
this plan, with the diff, so write it for that reader.

## offload

Put this plan on the `{{config.linear.team}}` team's board with the Linear MCP.
Exactly ONE issue: the spec as its body, the tickets as a checklist inside it — never one
issue per ticket.

Then write your Output, naming the one issue you created.

## refine

I want changes to the plan. Ask me what, one question at a time, then rewrite
`{{run.dir}}/plan/SPEC.md` and the tickets in `{{run.dir}}/plan/issues/` to match.

Then write your Output. The `changelog` is sent to an implementer already building from
this plan, with the diff, so write it for that reader.

## attended

When I say proceed, implement, build or go, I am answering this run's end menu: run
`collie run answer {{run.id}} "Implement now"` and change nothing else — the run starts the
implementation itself. If the menu is not pending yet, finish the step you are in first
and it will be.

## unattended

Nobody is watching this Run. Do not ask questions and do not wait. Decide each open
question yourself, the way the goal most plausibly means it, and record each decision
under `decided` in your Output. The plan is built as soon as its tickets are written.

## projects-root

The project root above is the Projects root, and it is not a repository: find the
repositories under it that the goal is about. Each ticket's `Repo:` is a path relative to
it.

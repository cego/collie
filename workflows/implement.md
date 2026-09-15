---
name: implement
title: implement — build the plan, review it, fix until nothing blocks
description: Builds from a plan dir, a Linear issue or a description, gets one complete review, fixes what blocks until a review finds nothing blocking, then opens the merge request.
inputs:
  plan: work-source
  # The short kebab-case name of the work, which a generated branch is named after.
  task: optional
  # One repository's share of a plan that spans several, as the tickets' `Repo:` line
  # names it. Empty means the whole plan, which is every single-repository run.
  repo: optional
  # `new` gives the Run a herdr worktree workspace of its own; anything else or absent
  # keeps it in the workspace it was started from. See docs/using.md.
  workspace: optional
  # What kind of result this run has to prove: feature, bug, refactor, investigation,
  # docs or migration. Empty says nothing, and is held only to the approved
  # verifications — a run nobody classified is not a feature by default.
  outcome: optional
  # Extra review axes, where this change has a risk that earns one. Forwarded to review,
  # as `outcome` is: the embedded review reads both from this run's inputs.
  risks: optional
# A ceiling, not a target: at most four review rounds and four fix passes after the
# build. The run leaves the loop at the first review with nothing blocking.
max_iterations: 4
steps:
  - id: build
    persona: implementer
    skill: implement
    # A plan of two tickets or more is built one ticket at a time, on this same agent,
    # with a compact hand-off between them rather than one transcript for the whole plan.
    each: tickets
    # One implementer agent for the whole run, so its model is named once, here.
    # `default` passes no model flag and lets the harness pick its own.
    harness: claude
    model: opus
    effort: xhigh
    output: build.json
  - id: review
    use: review
    fresh: true
    # The reviewer names its own model and effort, so this reaches only synthesize.
    model: default
    effort: medium
  - id: fix
    persona: implementer
    agent: build
    output: fix.json
    repeat:
      from: review.synthesize
      # Back to the review, which is the step that judges the fix. `back_to` defaults to
      # `from`; it is written out because a reader should not have to know that.
      back_to: review
      # Only blocking findings drive the loop; the last fix's own dispositions and
      # checks decide the run, and the merge request says it was not re-reviewed.
      converge: true
  - id: mr
    persona: implementer
    agent: build
    requires: gitlab
    output: mr.json
---

Work source ({{inputs.plan_kind}}): {{inputs.plan}}
Repository (may be empty): {{inputs.repo}}
Project root: {{cwd}}
This run's directory: {{run.dir}}

Outcome to prove (empty means unclassified): {{inputs.outcome}}

The verifications this run is held to — Collie runs exactly these itself, and nothing
else it may be told to run, before it will open the merge request:

{{verify}}

## build

The work source above is one of five kinds. Do the one that matches
`{{inputs.plan_kind}}` and ignore the others.

- **plan-dir** — a plan is already written. `{{inputs.plan}}/SPEC.md` is the spec and
  `{{inputs.plan}}/issues/` holds the tickets. Where the repository above is not empty,
  this plan spans several and you own one of them: only the tickets whose `**Repo:**`
  line names it are yours, and the rest are another run's. Which ticket you are on is
  under **This slice** below; Collie hands them to you one at a time, in an order their
  `Blocked by` lines allow.
- **review** — a review of work that already exists. `{{inputs.plan}}/review.md` is the
  spec, and the same findings as JSON are that run's own review Output —
  `{{inputs.plan}}/steps/review/review.json` where one reviewer wrote it, or
  `{{inputs.plan}}/steps/synthesize/synthesized.json` where several were reconciled. The
  tickets are those findings, worst severity first. You are fixing an existing
  change and this checkout is already on its branch, so there is no branch to pick and
  nothing to check out: the fixes land on the branch that was reviewed, and a merge
  request on it is updated rather than replaced. Write the findings you are working from
  to `{{run.dir}}/plan/SPEC.md` and one ticket per finding under
  `{{run.dir}}/plan/issues/`, so this run records what it set out to fix. A finding you
  disagree with is `disputed` with a reason, exactly as in a fix round — never silently
  skipped.
- **linear** — a Linear issue id. Fetch it with the Linear MCP (`get_issue`) and treat
  its description as the spec. Before building, write that spec to
  `{{run.dir}}/plan/SPEC.md` and a short task list to `{{run.dir}}/plan/issues/NN-*.md`,
  one file per slice, so the run records what you decided to build. Every ticket you write
  carries a `**Checks:**` line naming the `collie verify` commands that will prove it —
  from the approved list above. Clear work states its acceptance checks before it starts;
  deciding afterwards what would have counted is not a check.
- **followup** — a finished run's outcome needs more work. `{{inputs.plan}}` names it as
  `followup:<run id>`; that run's `steering/drift.jsonl` open reports and the text in
  `{{run.dir}}/plan/SPEC.md` are the spec. Write one ticket per open report under
  `{{run.dir}}/plan/issues/`. This checkout is already on the branch that run built, and
  its merge request is updated rather than replaced — the parent run is finished and
  immutable, so nothing you do belongs in it.
- **text** — the work in the human's own words. Same as `linear` without the fetch: write
  `{{run.dir}}/plan/SPEC.md` and the task list from the text, with the same `**Checks:**`
  line on every ticket, then build. If the text does not say enough to build from, stop and
  say what you need — do not guess.

This run has a checkout of its own, on the branch it is building: Collie resolved the
branch and opened the worktree before you started, so never create a branch or switch
one. It is a fresh checkout, so install the project's dependencies before you run its
tests for the first time.

### This slice

Ticket: {{ticket.file}} — {{ticket.title}}

Where a ticket is named above, **build that one ticket and no other**. The tickets before
it are already built and committed on this branch; do not re-survey the repository and do
not redo their work. What they left:

{{progress}}

Where no ticket is named, the work source is not a plan of several tickets and the whole
of it is yours.

You were started with {{skill:implement}}, so build what this step is for, with
{{skill:tdd}} at the seams the spec names and the project's tests green. Commit as you
go — one commit per ticket. There is no separate commit step.

Apply your persona's **Code comment hygiene** rules to comments this branch added or
changed: make the code self-explanatory, delete unnecessary comments, and reduce each
essential comment to the fewest words that preserve its meaning.

Build the complete approved scope before you report the step done. A ticket or a
required behaviour you did not build is not an optional follow-up, and the size of the
work is not a reason to leave it out or to dispute it. Where the spec genuinely
conflicts with itself or with the code, stop and ask rather than choose for the human.

Push before you finish: `git push -u origin HEAD -o ci.skip`, onto the branch the work
source named where there is one. The reviewers read the merge request when there is one,
and a merge request shows the remote — so anything you want reviewed has to be on the
remote before the review step runs. `ci.skip` because this state is for the reviewers;
the `mr` step's push is the one that should build.

If the push fails — no remote, no permission, a protected branch, a rejected
non-fast-forward — say what failed, report `"pushed": false`, and carry on to your
Output. The commits are still good and the Run is still worth finishing.

Run every test, lint and typecheck command through
`collie verify --run {{run.id}} --cwd {{cwd}} -- <command>`; Collie records the result
against the tree it ran on, and only that is a verification — an Output that says the
tests pass is a claim. Say in your Output which verifications you ran, by name.

When you finish a ticket, write `{{run.dir}}/steering/progress/<ticket file without
.md>.json` as `{"ticket":"<file>","status":"done","claims":["<what you believe is
done>"],"at":"<iso>"}`. Collie writes the same file when it hands you the ticket and when
the slice ends; yours is what puts your own words on the card before that. These are your
claims, and Collie labels them as such.

{{obstacle}}

### What this run has to prove

`{{inputs.outcome}}` above decides what closes this run. Do the one that matches and
ignore the others; an empty outcome means only the approved verifications have to pass.

- **feature** — every ticket you were given is built and named in `tickets_done`, and the
  review has to be able to say the agreed scope was met.
- **bug** — reproduce it first. Write the failing test, record it as a verification that is
  _supposed_ to fail — `collie verify --run {{run.id}} --cwd {{cwd}} --name regression
--expect fail -- <command>` — and only then fix it. When it is fixed, record `regression`
  again, without `--expect`, so there is a fail and then a pass on two different trees.
  Name it in your Output as `"reproduced": "regression"`.
- **refactor** — behaviour is identical. Say what you ran; the review has to be able to say
  behaviour was preserved.
- **investigation** — the answer is the deliverable, and there may be no patch at all.
  Write the report to `{{run.dir}}/plan/INVESTIGATION.md`, and in your Output give
  `"conclusion"`, `"evidence"` as a list of paths inside this run or its checkout, and
  `"patch": true | false`. `false` is a real outcome: no merge request is opened, and
  nothing is invented to have something to merge.
- **docs** — run the commands you documented, as written, each through
  `collie verify --run {{run.id}} --cwd {{cwd}} --name docs-<what> -- <command>`, and list
  their names in `"documented_commands"`. Instructions nobody ran are not documentation.
- **migration** — prove it goes both ways: a `migrate-up` verification and a
  `migrate-down` (or `rollback`) one, both passing on the final tree.

{{session.ask}}

Then write the Output JSON: `{"verdict": "clean" | "findings", "findings": [<what is not
built or not passing, as findings>], "branch": "<branch>", "pushed": true, "tickets_done":
["ticket title", ...], "commits": ["<subject>", ...], "tests": "what you ran and what it
said"}`, plus whichever of the outcome fields above applies. `clean` means the whole scope is built and the tests pass; anything else is
`findings`, with one entry per thing that is not.

## fix

Iteration {{iteration}} of at most {{max_iterations}}. That is a ceiling, not a target:
the run leaves this loop at the first review that finds nothing blocking, and only
`blocker` and `major` findings bring it back here. Fix `minor` ones alongside them where
it is cheap; left alone, they stay visible to the human and cost no round.

The review found:

{{findings}}

That is one review, synthesised from every reviewer that looked at this branch, so each
finding arrives once and already reconciled. Apply the ones you agree with, as fixup
commits on this branch. For any finding you believe is wrong, do not apply it — record it
under `disputed` with your reason, and the human sees it at the end. A reason you give
once settles that finding: the reviewers are told about it and the loop stops raising it.
Re-run the tests.

Apply your persona's **Code comment hygiene** rules to comments this fix added or changed,
the same way `build` does.

A finding that arrives with `answers your dispute:` is one you rejected before and a
reviewer has now answered. Deal with it: apply it, or dispute it again with a reason that
answers what they said.

Run every test, lint and typecheck command through
`collie verify --run {{run.id}} --cwd {{cwd}} -- <command>`; Collie records the result
against the tree it ran on, and only that is a verification — an Output that says the
tests pass is a claim. Say in your Output which verifications you ran, by name.

When you start each ticket and when you finish it, write
`{{run.dir}}/steering/progress/<ticket-slug>.json` as `{"ticket":"<file>","status":
"started"|"done","claims":["<what you believe is done>"],"at":"<iso>"}`. These are your
claims, and Collie labels them as such.
Never defer a blocking finding to a follow-up or leave it out of your Output: every
`blocker` and `major` above is either under `fixed` or under `disputed`, never both and
never neither. Disputing every blocking finding stops the run for the human at once. On
iteration {{max_iterations}} there is no review after you: Collie reads your `fixed`,
`disputed` and `checks` against the findings above and the merge request says the last
fix was implementer-reported, not re-reviewed — so report exactly what you did. What your
checks said is not read from you: each `checks` entry names a verification, and Collie
reads its result from the journal, on the tree as it stands.

Push the fixups before you finish — `git push -u origin HEAD -o ci.skip` — every
iteration: the next round reviews the remote, and a fix it cannot see is a finding it
raises again. A push that fails is reported as `"pushed": false`, not fatal.

Then write the Output JSON: `{"verdict": "clean" | "findings", "findings": [<what you
could not finish>], "fixed": [{"file": "path", "title": "the finding", "note": "what you
changed"}], "disputed": [{"file": "path", "line": 12, "severity": "blocker|major|minor",
"title": "the finding", "detail": "why I disagree"}], "checks": [{"name": "the verification
name you ran it under", "note": "what it said"}], "pushed": true}`. `file` and `title` in
`fixed` and `disputed` are exactly as the finding above gives them, so Collie can match
them; `checks` names every test and lint command you ran, one entry each, by the name
`collie verify` recorded it under (the command's first word, unless you gave `--name`). A
check with no record on this tree is not a passing check, whatever the note says.

## mr

The branch is reviewed and the loop found nothing blocking. Push it and open the merge
request.

What was actually verified, and by whom — `by collie` is a command Collie ran itself,
`by agent` is one an agent ran through the collector:

{{evidence}}

Say that in the description, in one line: which verifications passed on the branch as it
stands. An Output that says the tests pass is a claim; these are not.

{{unreviewed}}

Where the line above is not empty, the last fix pass was checked by its own tests and
dispositions and not by a reviewer: say so in the description, in one sentence, and list
what that fix changed. Where findings were left open as non-blocking, list them too.

- Assignee: `{{mr.assignee}}`
- MR template: `{{mr.template}}`
- Linear tickets: `{{mr.issues}}`

Run every test, lint and typecheck command through
`collie verify --run {{run.id}} --cwd {{cwd}} -- <command>`; Collie records the result
against the tree it ran on, and only that is a verification — an Output that says the
tests pass is a claim. Say in your Output which verifications you ran, by name.

Push anything the earlier steps have not pushed yet, this time **without** `ci.skip`:
yours is the push that runs the pipeline, and the state a human will look at.
Never merge the MR, and never pass a merge flag to `glab`: this is the only step in the
whole run allowed to open or update a merge request, and doing that is the entire job.

**Before that push, check for auto-merge** (`glab mr view <iid> {{target_repo}}` shows
it). If the merge request has auto-merge enabled, **do not push** — a push that goes
green there merges someone else's merge request, and a push that causes a merge is a
merge. Report `"pushed": false` and say that auto-merge is why. This is a rule about
someone else's merge request; do not soften it.

**First check whether this branch already has a merge request** — it does when this run
was started from a review of one (`plan_kind` is `review` and
`target_kind` is `mr`), and `glab mr view {{target_repo}}` tells you either
way. If it has one, that MR is the one being fixed: push, and say so in a short note on it
(`glab mr note <iid> {{target_repo}}`) listing what you changed. Do **not** open a second
merge request for the same branch. Report its URL as `mr_url` exactly as if you had opened
it.

Write the description to a file in `{{run.dir}}` first, then create the MR with
`glab mr create --assignee {{mr.assignee}}` and that file as the description. `glab` does
not pre-fill the repo's template, so you fill it yourself.

**When the MR template path above is not empty**, read that file and answer every section
it has — it is a CIATF change-management assessment. Keep it short and plain:

- One or two ordinary sentences per section. No headings inside a section, no tables, no
  risk matrices, no lists of hypotheticals.
- Confidentiality, Integrity, Availability, Traceability and Fairness each ask whether
  this change makes that worse. For most changes the honest answer is `No impact.` —
  write exactly that and move on. Say something only where there is something to say.
- Description and Reason are a short paragraph each: what changed, and why it was worth
  doing.
- Category is `feature` or `bugfix`. Use `bugfix` only when the spec says you were fixing
  a defect.
- Where the template asks for a Trello card, put the Linear ticket links there instead —
  one link per ticket listed above. With no tickets, write `None.`

The whole description should read in under a minute. If you are writing more than that,
you are over-explaining it.

**When the template path is empty**, write a plain description instead: a short paragraph
saying what changed and why, plus the ticket links if there are any.

Then, for each Linear ticket listed above, comment the MR URL on that issue with the
Linear MCP. If the MCP is not configured, skip it and say so in your Output.

Never write the company package scope with a leading at-sign — in the MR, in a commit
message, or anywhere else. Write it as a bare name.

Then write the Output JSON: `{"verdict": "clean" | "findings", "findings": [], "mr_url":
"<url>", "linear_issues": [<the ids you linked>], "branch": "<what you pushed>", "pushed":
true}`. `clean` means the merge request exists or was updated; a push or `glab` that failed
is `findings`, saying what.

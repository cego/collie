---
name: implement
title: implement — build the plan, tidy it, review it, fix until clean
description: Builds from a plan dir, a Linear issue or a description, improves the architecture it touched, simplifies, fans out to reviewers, loops on findings, then opens the merge request.
inputs:
  plan: work-source
max_iterations: 5
steps:
  - id: build
    persona: implementer
    skill: implement
    output: build.json
  - id: architecture
    use: architecture
    prompt: unattended
    persona: implementer
    agent: build
  - id: simplify
    persona: implementer
    agent: build
    output: simplify.json
  - id: review
    use: review
    fresh: true
  - id: fix
    persona: implementer
    agent: build
    output: fix.json
    repeat:
      from: review.synthesize
      back_to: simplify
  - id: mr
    persona: implementer
    agent: build
    requires: gitlab
    output: mr.json

---
Work source ({{inputs.plan_kind}}): {{inputs.plan}}
Project root: {{cwd}}
This run's directory: {{run.dir}}

## build

The work source above is one of three kinds. Do the one that matches
`{{inputs.plan_kind}}` and ignore the other two.

- **plan-dir** — a plan is already written. Read `{{inputs.plan}}/SPEC.md` and every
  ticket in `{{inputs.plan}}/issues/`, and build those tickets.
- **linear** — a Linear issue id. Fetch it with the Linear MCP (`get_issue`) and treat
  its description as the spec. Before building, write that spec to
  `{{run.dir}}/plan/SPEC.md` and a short task list to `{{run.dir}}/plan/issues/NN-*.md`,
  one file per slice, so the run records what you decided to build.
- **text** — the work in the human's own words. Same as `linear` without the fetch:
  write `{{run.dir}}/plan/SPEC.md` and the task list from the text, then build. If the
  text does not say enough to build from, stop and say what you need — do not guess.

Branch off the default branch first, named after the spec's slug — short, kebab-case,
no ticket number unless the spec has one. This prompt arrives as `/implement`, so build
the tickets in their order, one at a time: `/tdd` at the seams the spec names, the
project's tests green, and one commit per ticket. There is no separate commit step.

Then write the Output JSON: `{"verdict": "clean", "findings": [], "branch": "<branch>",
"tickets_done": ["ticket title", ...], "commits": ["<subject>", ...], "tests": "what
you ran and what it said"}`.

## simplify

Iteration {{iteration}} of at most {{max_iterations}}.

Run `/code-simplification` over what this branch changed. Behaviour stays identical:
the tests you ran in `build` still pass, and you say what you ran. Do not touch code
this branch did not.

Then write the Output JSON: `{"verdict": "clean", "findings": [], "simplified": ["what
you collapsed and why", ...], "tests": "what you ran and what it said"}`.

## fix

Iteration {{iteration}} of at most {{max_iterations}}.

The review found:

{{findings}}

That is one review, synthesised from every reviewer that looked at this branch, so each
finding arrives once and already reconciled. Apply the ones you agree with, as fixup
commits on this branch. For any finding you believe is wrong, do not apply it — record it
under `disputed` with your reason, and the human sees it at the end. A reason you give
once settles that finding: the reviewers are told about it and the loop stops raising it.
Re-run the tests.

A finding that arrives with `answers your dispute:` is one you rejected before and a
reviewer has now answered. Deal with it: apply it, or dispute it again with a reason that
answers what they said.

Then write the Output JSON: `{"verdict": "clean", "findings": [], "disputed":
[{"file": "path", "severity": "minor", "title": "the finding", "detail": "why I
disagree"}], "fixed": ["what you changed", ...], "tests": "what you ran and what it
said"}`.

## mr

The branch is reviewed and the loop is clean. Push it and open the merge request.

- Assignee: `{{mr.assignee}}`
- MR template: `{{mr.template}}`
- Linear tickets: `{{mr.issues}}`

Push the branch with upstream tracking. This is the only step in the whole run allowed
to touch the remote, and pushing is all it may do. Never merge the MR, and never pass a
merge flag to `glab`; opening it is the entire job.

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

Then write the Output JSON: `{"verdict": "clean", "findings": [], "mr_url": "<url>",
"linear_issues": [<the ids you linked>], "branch": "<what you pushed>"}`.

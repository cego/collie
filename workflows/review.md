---
name: review
title: review — an MR, a branch diff, or the working tree
description: You pick the target — an MR, a branch diff or the working tree — two models review it, one review comes out, and what happens next is your call: fix the findings here, hand them to a live implementer, run a full implement, or post the review to the merge request.
inputs:
  target: diff-target
  # Empty unless a workflow embedding this one has a spec to hold the change to.
  plan: optional
  # A run id, when you want a particular earlier review as the one to compare against.
  previous: optional
steps:
  - id: review
    persona: reviewer
    output: review.json
    parallel:
      - { harness: claude, model: opus, effort: medium }
      - { harness: claude, model: sonnet, effort: xhigh }
  - id: synthesize
    persona: reviewer
    fan_in: review
    output: synthesized.json
  - id: post
    standalone: true
    choices:
      # One decision, two implementations: exactly one of these is ever offered, so
      # "Fix findings" means the same thing whether or not an implementer is live.
      - title: Fix findings
        handoff: implementer
      - title: Fix findings
        unless: implementer
        prompt: fix
        persona: implementer
        fresh: true
        output: fix.json
        max: 1
      - title: Fix findings in a full implement run
        run: implement
        inputs:
          plan: "{{run.dir}}"
          target: "{{inputs.target}}"
      - title: Post to MR
        post: true
        requires: [mr-target, gitlab]
      - title: Don't post
        stop: true
---

Review target: {{inputs.target}}
Project root: {{cwd}}
Spec: {{inputs.plan}}

Read the target first:

- `mr:<project>!<iid>` — the project is part of the target, so name it and you do not
  need a checkout of it: `glab mr diff <iid> {{target_repo}}` for the change and
  `glab mr view <iid> {{target_repo}}` for the description. An older target is a bare
  `mr:<iid>`, which means the merge request of the project you are standing in.
- `branch:<base>...<head>` — `git diff <base>...<head>`.
- `worktree` — the change in front of you: `git status` and `git diff HEAD` for
  uncommitted work, and `git log --oneline <default-branch>..HEAD` plus `git diff
<default-branch>...HEAD` for commits this branch has that the default branch does not.

The spec above is a directory when this review has one: read `SPEC.md` and the tickets
in `issues/` and hold the change to them. When it is empty there is no spec, and the
spec axis says exactly that.

## review

Iteration {{iteration}} of at most {{max_iterations}}.

{{previous.review}}

The first review of a change — iteration 1, with no earlier review above — is the
comprehensive one: both review skills, the whole spec, the whole change, and the code
around it. A later iteration is a follow-up, and so is any review with an earlier review
above it: do not run the full review skills again over the whole change. The previous
round's review is at `{{run.dir}}/review.md` and the implementer's account of it — what
it fixed, what it disputed, what it checked — is that step's Output under
`{{run.dir}}/steps/` (in the implement workflow, `steps/fix/fix.json`). Check each of its
findings against the code as it is now and say what happened to it — still there,
changed but not fixed, or fixed. Then review what has changed since that review, and the
callers and tests the fixes touched, and raise what is new. A finding you carry forward
is the same finding: keep its file and title unless the code moved under it.

Review against the project's own standards too — `CLAUDE.md`, `CONTEXT.md`, `README.md`
and the code around the change.

Already disputed — the implementer looked at these and did not apply them, with reasons:

{{disputed}}

Do not raise one of those again unless you can answer the reason it was disputed. If you
can, raise it with a `"rebuttal"` saying why that reason does not hold; that puts it back
in front of the implementer. If you cannot, leave it alone — it is the human's call now,
not another round's.

Where you run something to check a finding, run it through the collector so the result
is bound to the tree you checked it on: `collie verify --run {{run.id}} --cwd {{cwd}} -- <command>`; Collie records the result
against the tree it ran on, and only that is a verification — an Output that says the
tests pass is a claim. Say in your Output which verifications you ran, by name.

Change nothing outside your Output file.

## synthesize

The reviewing is done; do not run the review skills again. Every reviewer has written
their own review of this change:

{{fan_in}}

Read all of them, then read the target yourself, and write the one review this change
gets — the review a careful colleague would leave on it.

{{previous.review}}

Where a review of this target appears above, every finding it raised is accounted for:
carried with its own words if it is still there, or listed under `fixed` if it is not.
The human is watching a rally, not a new list every time.

- One entry per problem. Where two reviewers found the same thing, say it once, in
  whichever of their words is clearer.
- A finding the previous review raised keeps the same file and title when the problem is
  the same: that is how Collie tells a round that fixed nothing from one that moved. Give
  a finding new words only when the problem is genuinely new.
- Every finding has one of the three severities. Anything else is treated as blocking.
- Where they disagree, settle it against the diff. A finding only one of them raised
  survives only if you can defend it from the diff yourself.
- Everything you do not carry goes in `dropped` with a one-line `reason`. Nothing is
  dropped silently.
- Order the findings `blocker`, then `major`, then `minor`.
- Each finding is one or two plain sentences, with the `file` and `line` it is at. Say
  what goes wrong and what it costs. Never say which model or which skill found it.
- `summary` is two sentences: what this change does, and what is wrong with it.
- A finding that arrives with a `"rebuttal"` keeps it word for word. It answers a
  dispute the implementer has already made, and dropping it would end that argument
  without anyone deciding it.
- Do not edit files, commit, push, or comment anywhere. This Output is the whole job.

Then write the Output JSON: `{"verdict": "clean" | "findings", "summary": "two
sentences", "findings": [{"file": "path", "line": 12, "severity": "blocker|major|minor",
"title": "one line", "detail": "what goes wrong and what it costs", "rebuttal": "kept
from the reviewer that wrote it"}], "dropped": [{"file": "path", "severity": "minor",
"title": "what one reviewer raised", "reason": "why it did not survive"}],
"fixed": [{"file": "path", "title": "what the last review raised", "note": "how it was
fixed"}]}`.

## fix

The review is written and you are fixing it, in this run, on this target. The findings
are `{{run.dir}}/review.md`, and the same findings as JSON are at
`{{run.dir}}/steps/synthesize/synthesized.json`. Worst severity first.

Work where the review was pointed — `target_kind` is `{{inputs.target_kind}}`:

- `branch` — check out its head.
- `mr` — `glab mr checkout <iid> {{target_repo}}`, so the fixes land on that merge
  request's own branch.
- `worktree` — stay on the branch you are on.

Apply the findings you agree with and commit them. A finding you believe is wrong is not
silently skipped: record it under `disputed` with your reason, and the human sees it. Run
the project's tests and say what you ran.

**Do not push, do not open or update a merge request, and do not comment anywhere.**
Someone asked for the findings fixed, not for the change shipped — and this is usually
someone else's branch. Report `"pushed": false` and the `branch` your commits are on, so
a local-only result is never mistaken for a landed one.

Then write the Output JSON: `{"verdict": "clean", "findings": [], "fixed": ["what you
changed", ...], "disputed": [{"file": "path", "severity": "minor", "title": "the
finding", "detail": "why I disagree"}], "commits": ["<subject>", ...], "branch":
"<branch>", "pushed": false, "tests": "what you ran and what it said"}`.

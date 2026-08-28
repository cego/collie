---
name: review
title: review — an MR, a branch diff, or the working tree
description: You pick the target — an MR, a branch diff or the working tree — two models review it, one review comes out, and posting it to the merge request is your call.
inputs:
  target: diff-target
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
    requires: [mr-target, gitlab]
    choices:
      - title: Post to MR
        post: true
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

Review against the project's own standards too — `CLAUDE.md`, `CONTEXT.md`, `README.md`
and the code around the change.

Already disputed — the implementer looked at these and did not apply them, with reasons:

{{disputed}}

Do not raise one of those again unless you can answer the reason it was disputed. If you
can, raise it with a `"rebuttal"` saying why that reason does not hold; that puts it back
in front of the implementer. If you cannot, leave it alone — it is the human's call now,
not another round's.

Change nothing outside your Output file.

## synthesize

The reviewing is done; do not run the review skills again. Every reviewer has written
their own review of this change:

{{fan_in}}

Read all of them, then read the target yourself, and write the one review this change
gets — the review a careful colleague would leave on it.

- One entry per problem. Where two reviewers found the same thing, say it once, in
  whichever of their words is clearer.
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
"title": "what one reviewer raised", "reason": "why it did not survive"}]}`.

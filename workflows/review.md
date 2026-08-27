---
name: review
title: review — an MR, a branch diff, or the working tree
description: Reviews the inferred target with both review skills and writes one verdict. Posts to GitLab only when asked.
inputs:
  target: diff-target
  post: flag
steps:
  - id: review
    persona: reviewer
    output: review.json
    parallel:
      - { harness: claude, model: opus, effort: xhigh }
      - { harness: claude, model: sonnet, effort: xhigh }
---
Review target: {{inputs.target}}
Project root: {{cwd}}
Spec: {{inputs.plan}}

Read the target first:

- `mr:<iid>` — `glab mr diff <iid>` for the change and `glab mr view <iid>` for the
  description.
- `branch:<base>...<head>` — `git diff <base>...<head>`.
- `worktree` — the change in front of you: `git status` and `git diff HEAD` for
  uncommitted work, and `git log --oneline <default-branch>..HEAD` plus `git diff
  <default-branch>...HEAD` for commits this branch has that the default branch does not.

The spec above is a directory when this review has one: read `SPEC.md` and the tickets
in `issues/` and hold the change to them. When it is empty there is no spec, and the
spec axis says exactly that.

Review against the project's own standards too — `CLAUDE.md`, `CONTEXT.md`, `README.md`
and the code around the change.

Post to GitLab: {{inputs.post}} — only if that is `true` may you post a review comment
with `glab`. Otherwise change nothing outside your Output file.

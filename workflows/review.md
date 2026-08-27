---
name: review
title: review — an MR, a branch diff, or the working tree
description: Reviews the inferred target and writes a structured verdict. Posts to GitLab only when asked.
inputs:
  target: diff-target
  post: flag
steps:
  - id: review
    persona: reviewer
    output: review.json
---
Review target: {{inputs.target}}
Project root: {{cwd}}

Read the target first:

- `mr:!<iid>` — `glab mr diff <iid>` for the change and `glab mr view <iid>` for
  the description.
- `branch:<base>...<head>` — `git diff <base>...<head>`.
- `worktree` — `git status` and `git diff HEAD` for uncommitted work.

Review it against the project's own standards (read `CLAUDE.md`, `CONTEXT.md`,
`README.md`, and the code around the change). Then print a short summary in this
terminal so I can read it here, and write the Output JSON:

```
{"verdict": "clean" | "findings",
 "findings": [{"file": "path", "line": 12, "severity": "blocker|major|minor",
               "title": "one line", "detail": "what goes wrong"}]}
```

`verdict` is `clean` only when `findings` is empty.

Post to GitLab: {{inputs.post}} — post a review comment with `glab` only if that
is `true`. Otherwise change nothing outside the Output file.

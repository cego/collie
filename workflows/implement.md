---
name: implement
title: implement — build from a plan, review in parallel, fix until clean
description: Builds from a plan dir, fans out to parallel reviewers, and loops on findings.
inputs:
  plan: plan-dir
max_iterations: 5
steps:
  - id: build
    persona: implementer
    output: build.json
  - id: review
    use: review
    fresh: true
    parallel:
      - harness: claude
        model: opus
        effort: xhigh
      - harness: claude
        model: sonnet
        effort: xhigh
  - id: fix
    agent: build
    persona: implementer
    output: fix.json
    repeat:
      from: review
  - id: commit
    agent: build
    persona: implementer
    output: commit.json
  - id: verify
    use: review
    fresh: true
---
Plan directory: {{inputs.plan}}
Project root: {{cwd}}
This run's directory: {{run.dir}}

## build

Read `{{inputs.plan}}/SPEC.md` and the tickets in `{{inputs.plan}}/issues/`, then
build them. Work ticket by ticket, verifying each one before you start the next.
Run the project's tests and report what they said.

Do not commit yet.

Then write the Output JSON: `{"verdict": "clean", "findings": [], "tickets_done":
["ticket title", ...], "tests": "what you ran and what it said"}`.

## fix

Iteration {{iteration}} of at most {{max_iterations}}.

The reviewers found:

{{findings}}

Apply the findings you agree with. For any finding you believe is wrong, do not
apply it — record it under `disputed` with a reason, and I will look at it at the
end. Re-run the tests.

Then write the Output JSON: `{"verdict": "clean", "findings": [], "disputed":
[{"file": "path", "severity": "minor", "title": "the finding", "detail": "why I
disagree"}], "tests": "what you ran and what it said"}`.

## commit

The reviews are clean. Commit the work on a branch:

- create a branch if we are still on the default branch
- one commit per ticket where that is honest, otherwise one commit
- messages say why, in the imperative, no tool attribution

Do not push and do not open a merge request.

Then write the Output JSON: `{"verdict": "clean", "findings": [], "branch":
"<branch>", "commits": ["<subject>", ...]}`.

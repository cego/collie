---
name: implement
title: implement — build the plan, tidy it, review it, fix until clean
description: Builds from a plan dir, a Linear issue or a description, improves the architecture it touched, simplifies, fans out to reviewers and loops on findings.
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
      from: review
      back_to: simplify
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

The reviewers found:

{{findings}}

Apply the findings you agree with, as fixup commits on this branch. For any finding you
believe is wrong, do not apply it — record it under `disputed` with your reason, and the
human sees it at the end. A reason you give once settles that finding: the reviewers are
told about it and the loop stops raising it. Re-run the tests.

A finding that arrives with `answers your dispute:` is one you rejected before and a
reviewer has now answered. Deal with it: apply it, or dispute it again with a reason that
answers what they said.

Then write the Output JSON: `{"verdict": "clean", "findings": [], "disputed":
[{"file": "path", "severity": "minor", "title": "the finding", "detail": "why I
disagree"}], "fixed": ["what you changed", ...], "tests": "what you ran and what it
said"}`.

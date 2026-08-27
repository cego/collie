---
name: plan
title: plan — grill me, then write the spec and the tickets
description: Interviews you about a goal, writes the spec and tickets into the run dir, then asks what next.
inputs:
  goal: goal
  ticket: ticket
steps:
  - id: grill
    persona: planner
    output: grill.json
  - id: spec
    persona: planner
    agent: grill
    output: spec.json
  - id: tickets
    persona: planner
    agent: grill
    output: tickets.json
  - id: next
    choices:
      - title: Implement now
        run: implement
        inputs:
          plan: "{{run.dir}}/plan"
      - title: Second opinion
        prompt: second-opinion
        persona: reviewer
        model: opus
        effort: xhigh
        fresh: true
        output: opinion.json
        max: 2
        follow_up:
          agent: grill
          prompt: revise
          output: revise.json
      - title: Offload to Linear
        agent: grill
        prompt: offload
        output: linear.json
        config:
          key: linear.team
          question: Which Linear team do new issues go to
      - title: Refine
        agent: grill
        prompt: refine
        output: refine.json
---
The goal, in my words:

{{inputs.goal}}

Ticket (may be empty): {{inputs.ticket}}
Project root: {{cwd}}
This run's plan directory: {{run.dir}}/plan

## grill

If the goal above is a Linear issue id or a Linear URL, fetch it first with the Linear
MCP and treat what it says as the goal.

Grill me about it with `/grill-with-docs`: one question at a time, until you can state
the plan back to me and I agree with it. Write no spec and no tickets in this step.

If you cannot see the destination from here, or this is more than one session of work,
switch to `/wayfinder` and write the map to `{{run.dir}}/plan/MAP.md` before you carry on.

Glossary (`CONTEXT.md`) and ADR changes we agree on go into the repository as we agree
them — they are domain knowledge. Nothing else does.

Then write the Output JSON: `{"verdict": "clean", "findings": [], "slug":
"<short-kebab-case-name-for-this-work>", "decided": ["what we settled", ...],
"wayfinder": true or false}`.

## spec

Write the spec with `/to-spec` to `{{run.dir}}/plan/SPEC.md`. It has the problem in one
paragraph, what is explicitly out of scope, the ordered work with the seams that want
tests, and how we will know the whole thing works.

Then write the Output JSON: `{"verdict": "clean", "findings": [], "spec":
"{{run.dir}}/plan/SPEC.md"}`.

## tickets

Cut the spec into tickets with `/to-tickets`: one file each at
`{{run.dir}}/plan/issues/NN-<slug>.md`, numbered in the order they can land. Each says
what to build, what blocks it, and criteria someone else can check.

Then write the Output JSON: `{"verdict": "clean", "findings": [], "issues_dir":
"{{run.dir}}/plan/issues", "tickets": <how many>}`.

## second-opinion

Read `{{run.dir}}/plan/SPEC.md` and every ticket in `{{run.dir}}/plan/issues/`.

Review the plan, not the code: stories the spec is missing, seams in the wrong place,
tickets that cannot land on their own, an order that cannot work, criteria nobody can
check. Do not review the repository, do not propose implementations, and change nothing.

## revise

A second reviewer read the plan and found:

{{findings}}

Fix the spec and the tickets where you agree. Where you do not, leave them and record
why under `disputed`.

Then write the Output JSON: `{"verdict": "clean", "findings": [], "disputed": [...],
"changed": ["what you changed", ...]}`.

## offload

Put this plan on the `{{config.linear.team}}` team's board with the Linear MCP.
Exactly ONE issue: the spec as its body, the tickets as a checklist inside it — never one
issue per ticket.

Then write the Output JSON: `{"verdict": "clean", "findings": [], "issue": "<id>",
"url": "<url>"}`.

## refine

I want changes to the plan. Ask me what, one question at a time, then rewrite
`{{run.dir}}/plan/SPEC.md` and the tickets in `{{run.dir}}/plan/issues/` to match.

Then write the Output JSON: `{"verdict": "clean", "findings": [], "changed": ["what you
changed", ...]}`.

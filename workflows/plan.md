---
name: plan
title: plan — grill me, then write the spec and the tickets
description: Interviews you about a goal, writes the spec and tickets into the run dir, then asks what next.
inputs:
  goal: goal
  ticket: ticket
  # Forwarded to the implement this chains into, which is where it means anything.
  workspace: optional
steps:
  - id: grill
    persona: planner
    skill: grill-with-docs
    output: grill.json
  - id: spec
    persona: planner
    agent: grill
    skill: to-spec
    output: spec.json
  - id: tickets
    persona: planner
    agent: grill
    skill: to-tickets
    output: tickets.json
  - id: next
    choices:
      - title: Implement now
        run: implement
        inputs:
          plan: "{{run.dir}}/plan"
          workspace: "{{inputs.workspace}}"
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

You were started with {{skill:grill-with-docs}}, so the skill is already running: one question
at a time, until you can state the plan back to me and I agree with it. Write no spec and
no tickets in this step.

If you cannot see the destination from here, or this is more than one session of work,
say so and stop: ask me to run {{skill:wayfinder}} in this tab, and set `"wayfinder": true` in
your Output. You cannot start that skill yourself — only I can — and the map belongs at
`{{run.dir}}/plan/MAP.md`.

Glossary (`CONTEXT.md`) and ADR changes we agree on go into the repository as we agree
them — they are domain knowledge. Nothing else does.

Then write the Output JSON: `{"verdict": "clean", "findings": [], "slug":
"<short-kebab-case-name-for-this-work>", "decided": ["what we settled", ...],
"wayfinder": true or false}`.

## spec

You were started with {{skill:to-spec}}. Write the spec to `{{run.dir}}/plan/SPEC.md`. It has the problem in one
paragraph, what is explicitly out of scope, the ordered work with the seams that want
tests, and how we will know the whole thing works.

Then write the Output JSON: `{"verdict": "clean", "findings": [], "spec":
"{{run.dir}}/plan/SPEC.md"}`.

## tickets

You were started with {{skill:to-tickets}}. Cut the spec into tickets: one file each at
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
"changed": ["what you changed", ...], "changelog": "one or two sentences on what changed
in the plan"}`. The `changelog` is sent to an implementer already building from this plan,
with the diff, so write it for that reader.

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
changed", ...], "changelog": "one or two sentences on what changed in the plan"}`. The
`changelog` is sent to an implementer already building from this plan, with the diff, so
write it for that reader.

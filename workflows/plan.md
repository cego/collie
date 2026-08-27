---
name: plan
title: plan — interview me, then write the plan
description: Interviews you about a goal, then writes the plan into this run's plan dir.
inputs:
  goal: goal
  ticket: ticket
steps:
  - id: plan
    persona: planner
    output: plan.json
---
The goal, in my words:

{{inputs.goal}}

Ticket (may be empty): {{inputs.ticket}}
Project root: {{cwd}}

Interview me about this goal before you write anything. One question at a time.
When we agree on the plan, write it to `{{run.dir}}/plan/SPEC.md` — never into the
repository (ADR-0002). The plan must have:

- the problem in one paragraph
- what is explicitly out of scope
- an ordered list of tasks, each one landable on its own, each with acceptance
  criteria someone else can check
- how we will know the whole thing works

Then write the Output JSON: `{"verdict": "clean", "findings": [], "plan_dir":
"{{run.dir}}/plan", "slug": "<short kebab-case name for the goal>", "tasks":
<number of tasks>}`.

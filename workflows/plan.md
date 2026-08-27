---
name: plan
title: plan — interview me, then write the plan
description: Interviews you about a goal, then writes tasks/<slug>/PLAN.md for implement to pick up.
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
When we agree on the plan, write it to `tasks/<slug>/PLAN.md` under the project
root, where `<slug>` is a short kebab-case name for the goal. The plan must have:

- the problem in one paragraph
- what is explicitly out of scope
- an ordered list of tasks, each one landable on its own, each with acceptance
  criteria someone else can check
- how we will know the whole thing works

Then write the Output JSON: `{"verdict": "clean", "findings": [], "plan_file":
"tasks/<slug>/PLAN.md", "slug": "<slug>", "tasks": <number of tasks>}`.

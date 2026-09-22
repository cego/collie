---
name: plan
title: plan — turn a goal into a spec and tickets
description: Uses the goal and repository context to write a spec and tickets, asking only for missing decisions.
# The kind of result every Run of this proves; nobody chooses it.
outcome: plan
inputs:
  goal: goal
  ticket: ticket
  # Forwarded to the implement this chains into, which is where it means anything.
  workspace: optional
# What a finished plan offers: the tickets it wrote, built by the Workflow that builds.
offers:
  - id: implement-now
    title: Implement now
    workflow: implement
    needs: [plan]
    inputs:
      plan: plan-dir
steps:
  - id: grill
    persona: planner
    # One planner agent for the whole run, so its model is named once, here.
    model: fable
    effort: medium
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
          task: "{{outputs.grill.slug}}"
          # What kind of result this is, settled during the interview rather than asked
          # for again at the start of the build.
          outcome: "{{outputs.grill.outcome}}"
          workspace: "{{inputs.workspace}}"
      # Architecture is no longer a pass every implement run takes, so this is where a
      # plan that actually needs architectural decisions gets them: offered always,
      # chosen by the human, never inferred from the tickets.
      - title: Architecture first
        run: architecture
        inputs:
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
      - title: Finish planning
        stop: true
---

The goal, in my words:

{{inputs.goal}}

Ticket (may be empty): {{inputs.ticket}}
Project root: {{cwd}}
This run's plan directory: {{run.dir}}/plan
This run's id: {{run.id}}

When I say proceed, implement, build or go, I am answering this run's end menu: run
`collie run answer {{run.id}} "Implement now"` and change nothing else — the run starts the
implementation itself. If the menu is not pending yet, finish the step you are in first
and it will be.

## grill

If the goal above is a Linear issue id or a Linear URL, fetch it first with the Linear
MCP and treat what it says as the goal.

Read the goal and the repository first. Ask only when a missing decision changes what
you should build. When the goal is clear, proceed without an interview or approval of
a summary. Do not ask me to invoke another skill or to confirm that you may write the plan.
For larger work, break it into manageable pieces yourself.

Glossary (`CONTEXT.md`) and ADR changes we agree on go into the repository as we agree
them — they are domain knowledge. Nothing else does.

Choose the result kind from the task: `feature`, `bug`, `refactor`, `investigation`,
`docs` or `migration`. Leave it empty if none fits; this is metadata, not another question.

Then write your Output, with what we settled under `decided`.

## spec

You were started with {{skill:to-spec}}. Write the spec to `{{run.dir}}/plan/SPEC.md`. It has the problem in one
paragraph, what is explicitly out of scope, the ordered work with the seams that want
tests, and how we will know the whole thing works.

Then write your Output, naming the spec you wrote.

## tickets

You were started with {{skill:to-tickets}}. Cut the spec into tickets: one file each at
`{{run.dir}}/plan/issues/NN-<slug>.md`, numbered in the order they can land. Each says
what to build, what blocks it, and criteria someone else can check.

Every ticket also carries a fifth header line, `**Repo:** <path>`, between "Blocked by"
and "Status" — always, one repository per ticket. The path is the checkout the ticket
changes, relative to the project root above and as it is on disk; write `.` when the root
is itself a repository. It is a path under that root: never absolute, and never with a
`..` in it. Implementation runs are fanned out one per repository from these lines, so a
ticket without one, or one naming a path that is not checked out under the root, stops the
whole hand-off.

Number every ticket of a plan once: a "Blocked by" line names a number, so two tickets
wearing one cannot say which an edge points at.

A "Blocked by" line names the numbers of the tickets it waits for, or `None` — every
number matching a ticket of this plan. Write each as a bare number; a number that is part
of a word, as in "the v2 rollout", is read as part of that word rather than as a ticket.
The waves are built from those lines, so one naming something that is not a ticket here
stops the hand-off too rather than quietly losing the edge.

Where the work spans several repositories, one rule holds: taken repository by
repository, the blocking edges must not form a cycle — once a repository's tickets are
blocked by another's, none of that other one's may be blocked by this one. Put the
repository that defines the contract first, and prefer one ticket per repository per
wave.

Then write your Output, naming the directory you wrote them to.

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

Then write your Output. The `changelog` is sent to an implementer already building from
this plan, with the diff, so write it for that reader.

## offload

Put this plan on the `{{config.linear.team}}` team's board with the Linear MCP.
Exactly ONE issue: the spec as its body, the tickets as a checklist inside it — never one
issue per ticket.

Then write your Output, naming the one issue you created.

## refine

I want changes to the plan. Ask me what, one question at a time, then rewrite
`{{run.dir}}/plan/SPEC.md` and the tickets in `{{run.dir}}/plan/issues/` to match.

Then write your Output. The `changelog` is sent to an implementer already building from
this plan, with the diff, so write it for that reader.

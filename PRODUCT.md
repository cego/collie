# Collie product vision

Where Collie is going, in the maintainer's own terms. Not a description of what has
shipped — [`docs/`](docs/) is that, and [`CONTEXT.md`](CONTEXT.md) is the vocabulary. This
is the direction that decides what the next thing should be.

## The shepherd and the border collie

Collie is inspired by a shepherd's border collie. The shepherd sees the flock, knows
where it needs to go, and gives direction. The border collie coordinates the flock,
notices when a sheep strays, and brings it back without waiting for a separate command
for every movement.

The human is the shepherd. The coding agents and their work are the flock. Collie
connects the human's intent to coordinated execution and keeps that work moving in the
intended direction.

**The human sets direction and retains oversight. Collie handles coordination and
course correction. The human should not have to manage each agent.**

## See the work and talk to Collie

The visual overview is essential, not a temporary interface to replace with chat.
The Control Plane must let the human see what is running, where it is heading, what
is drifting, what has finished, and what needs a decision.

Conversation complements that overview. The human can express goals, change direction,
ask questions, and guide work in natural language. Collie understands the relevant
work, with filters and action targets visible rather than implicit.

There is one global Collie and one conversation per herdr session, covering all its
workspaces. Workspace and Run filters narrow the view, not supervision. Each Run
retains its own goal, constraints, and authority; one Collie does not mean mixing
every project's instructions into one model context.

Outcome handovers are live by default: progress, changes, inspection opportunities,
and verification evidence appear as work develops, without asking "show me" each
time. Routine updates stay visible; decisions and consequential developments bring
the human in. Feedback stays attached to the work and revision being inspected.

The board and the conversation are two ways of understanding and guiding the same
work. Neither may invent a separate account of what is happening.

## Active stewardship, not a chatbot over commands

Collie must do more than explain status or wait for instructions. It should notice
departures from the agreed goal and constraints, take permitted corrective action,
and check whether that action restored progress. Detecting drift means comparing
work against the human's intent and evidence, not merely noticing that an agent is idle.

For example, when work violates an agreed requirement to preserve a public API,
Collie should recognize the deviation and direct a correction within its authority.
If preserving that API turns out to conflict with the requested outcome, Collie
should surface the trade-off for the human rather than silently changing the goal.

This is the intended meaning of the border collie's "instinct": reliable, proactive
course correction, not unrestricted autonomy or unexplained model judgement.

## Proposed boundaries to define before implementation

- The human owns goals, priorities, constraints, and the authority delegated to Collie.
- Collie corrects drift within that authority; ambiguous goals, conflicting constraints,
  and actions beyond it require a human decision.
- Steering and correction are visible and traceable. A message sent, an instruction
  acknowledged, and an outcome verified are different facts.
- Global visibility does not by itself authorize changes across every workspace.
- The human can intervene and stop work. Collie does not silently undo intentional
  human direction in the name of keeping work "in line."

The exact permissions, interruption rules, and mechanisms for delivering steering to
busy agents remain design questions. This vision does not settle an agent architecture
or replace the existing execution engine.

## What success feels like

The human can look at the flock, give direction, and return to their own work with
confidence that Collie will keep progress aligned and bring back decisions that
actually need them.

Evaluate changes by whether they reduce manual coordination and unnoticed drift
without reducing visibility or human control. More agents, more messages, and more
autonomy are not success measures by themselves.

## Relationship to today's product

The [README](README.md) describes workflow execution, while the
[glossary](CONTEXT.md) defines the Control Plane, Runs, Attention, and hand-offs.
These are foundations for this direction, not evidence that conversational steering
or proactive intent-level correction already exists.

This document is retained under `plans/` during advisory work. When integrating the
vision into the main documentation, promote it to root `PRODUCT.md` and link it from
the README rather than maintaining two copies.

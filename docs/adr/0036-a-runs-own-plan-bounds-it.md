# A Run's own plan bounds it

**Status: accepted.**

What a Run's planner writes it will not do, and what it says done means, become
constraints in the Run's Intent, and they follow the plan as it changes.

## What was true before

Drift is judged against the constraints in a Run's Intent, and on the live host 29 of 32
Runs had none. The three that did had constraints a human typed. None came from any SPEC,
for two reasons.

`extractRequirements` read only bullets under `Requirements`, `Success criteria`,
`Boundaries` or `Constraints`. Collie's own planners write `## Out of scope` (4 of the live
SPECs) and `## Done when` (3), and none of them uses the four names. A `plan` → `implement`
hand-off seeded zero constraints from a SPEC with an `## Out of Scope` section.

The Intent was seeded once, at admission. When the plan is typed text, which is every
recent implement Run, the SPEC is written later by the Run's own planner into
`<runDir>/plan/SPEC.md`, and nothing read it.

## Decision

**D1. Read the headings planners write.** `Out of scope` and `Done when` join the heading
list. An out-of-scope bullet names something not to do, so it is read as
`Out of scope: <bullet>`; read bare, a judge would take it as something to do. Other
headings keep their bullet text, so no existing constraint id changes.

**D2. Follow the Run's own plan at every drift check.** Before `checkDrift` reads the
Intent, it reads `<runDir>/plan/SPEC.md` and, under the Run directory's lock, amends the
Intent to match: constraints the plan now has are added, and constraints from
`plan/SPEC.md` it no longer has are removed. Each amendment is by `plan:plan/SPEC.md`.

**D3. A human's removal stands.** A constraint whose removal the history records by anyone
other than the plan is never put back. Nothing with another source, or from a plan
directory's `SPEC.md`, is touched, and authority is never read from text.

## Consequences

- Runs have constraints without the human writing any, and no new heading or command
  exists for them to learn.
- More semantic judgements: each work boundary with a semantic constraint is one model
  call. That is usage and is recorded, never a quota.
- The Intent is no longer amended only by a human. A planner that keeps rewriting its SPEC
  bumps the version, and every bump makes earlier drift reports stale.
- If planners start writing other headings, they are added only when a real SPEC uses them.

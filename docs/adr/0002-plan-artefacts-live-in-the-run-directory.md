# 0002 — Plan artefacts live in the Run directory, not the repository

**Status:** accepted, 2026-08-27

## Context
`plan` produces a spec and tickets that `implement` consumes. The team does not want
plans or task files committed, and the implementer may run in any harness, so a
harness-specific scratch directory is unusable.

## Decision
Spec, tickets, wayfinder maps and architecture reports are written to the Run's
`plan/` directory under the plugin state dir. `implement` infers its plan from the
newest finished `plan` Run for the repo, or receives it explicitly when chained.
Glossary and ADR changes made while planning ARE written into the repo: they are
domain knowledge, not plans.

## Alternatives
- `tasks/` or `.scratch/` in the repo with `.git/info/exclude`: works, but leaks into
  every clone's working tree and tempts commits.
- Claude's per-session scratchpad: ephemeral and invisible to other harnesses.

## Consequences
Plans are per machine; sharing a plan means offloading to Linear (a Choice in `plan`).
Deleting the plugin state deletes unsent plans.

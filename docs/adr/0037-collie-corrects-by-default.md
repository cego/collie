# Collie corrects drift by default

**Status: accepted.** Built: `auto_correct` is on in `DEFAULT_AUTHORITY`. Claude's
attribution is still unproven, so on Claude a correction is sent only with
`exclusive_steering` until an operator records it with `tools/steering-live.ts`.

A Run nobody granted anything corrects drift at a work boundary, within the bound. Every
other grant stays off.

## What was true before

`DEFAULT_AUTHORITY` turned every grant off, and on the live host 32 of 32 Intents had
`auto_correct: false`: no human had ever typed `run intent authority <run>
auto_correct=true`. No correction was ever sent. Even with the grant none would have been
on Claude, the harness every Run uses, because `decideCorrections` also needs proven
attribution or `exclusive_steering`, and Claude's attribution was unproven.

A safety feature that waits for a per-Run grant nobody gives is one that never runs.

## Decision

**D1. `auto_correct` is on by default.** `DEFAULT_AUTHORITY.auto_correct` is `true`, so a
Run seeded without workspace defaults corrects drift. A workspace defaults file that says
`auto_correct: false` keeps it off: that is a human's explicit setting.

**D2. Every other grant stays off.** `now_allowed`, `interrupt_allowed`, `stop_allowed` and
`exclusive_steering` are `false` by default, and no grant is ever inferred from repository
content or worker output.

**D3. Every gate stays.** `decideCorrections` is unchanged: a hold, a manual override, a
correction in flight, the bound and the attribution gate each still refuse on their own.

**D4. Attribution is not claimed.** Claude's `attribution` row moves to `proven` only from
an operator's recorded live result. Until then a correction on Claude, like on any harness
without attribution, needs `exclusive_steering`.

## Consequences

- Collie types into panes unasked, but only at a work boundary and with the fixed template.
- A human who types into a pane stops it for that agent until `run clear-override`.
- After `max_corrections_per_constraint` (2) corrections, a report is escalated to the
  human.
- Opting out is `run intent authority <run> auto_correct=false`, or a workspace default.
- Until an operator records Claude's attribution, Claude Runs are corrected only where
  `exclusive_steering` was granted; recording it is what makes this default reach them.

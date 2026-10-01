# Collie corrects drift by default

**Status: accepted, not yet in effect.** Built: `auto_correct` is on in `DEFAULT_AUTHORITY`.
It reaches no shipped harness yet: attribution is `unproven` on Claude and `none` on codex,
opencode and pi, so a Run nobody granted anything is still not corrected. On Claude it
takes effect once attribution is proven; until then, a Run is corrected only where
`exclusive_steering` was granted too.

The `auto_correct` grant is on for every Run, so that the only thing between a Run and a
boundary correction is a gate that defers to somebody. Every other grant stays off.

## What was true before

`DEFAULT_AUTHORITY` turned every grant off, and on the live host 32 of 32 Intents had
`auto_correct: false`: no human had ever typed `run intent authority <run>
auto_correct=true`. No correction was ever sent. Even with the grant none would have been
on Claude, the harness every Run uses, because `decideCorrections` also needs proven
attribution or `exclusive_steering`, and Claude's attribution was unproven.

A safety feature that waits for a per-Run grant nobody gives is one that never runs.

## Decision

**D1. `auto_correct` is on by default.** `DEFAULT_AUTHORITY.auto_correct` is `true`, so a
Run seeded without workspace defaults has the grant. A workspace defaults file that says
`auto_correct: false` keeps it off. A defaults file stores the whole authority, so one
written by an earlier build through `run intent defaults` or chat's `update_defaults` says
`auto_correct: false` without anyone having asked for it, and keeps it off too; turn it on
with `run intent defaults set-authority auto_correct=true`.

**D2. Every other grant stays off.** `now_allowed`, `interrupt_allowed`, `stop_allowed` and
`exclusive_steering` are `false` by default, and no grant is ever inferred from repository
content or worker output.

**D3. Every gate stays.** `decideCorrections` is unchanged: a hold, a manual override, a
correction in flight, the bound and the attribution gate each still refuse on their own.

**D4. Attribution is not claimed.** Claude's `attribution` row moves to `proven` only from
a recorded live result of `tools/steering-live.ts`. Until then a correction on Claude, as on any harness
without attribution, needs `exclusive_steering`.

## Consequences

- Today nothing changes on a Run nobody granted anything: no shipped harness has proven
  attribution. A Run granted `exclusive_steering` is now corrected without also needing
  `auto_correct`.
- Claude's attribution cannot be proven yet. Its `UserPromptSubmit` hook also fires on
  turns Claude injects itself, such as a task notification, and records them as external,
  so every Claude agent shows external submissions nobody typed, and oversight's
  `noticeOverride` may read them as a manual override. The probe cannot pass either: it
  looks for a `manual_override` that only a live Run's oversight writes. Both are fixed
  separately.
- Once Claude's attribution is proven, Collie types into Claude panes unasked, but only
  at a work boundary and with the fixed template.
- A human who types into a pane stops it for that agent until `run clear-override`.
- After `max_corrections_per_constraint` (2) corrections, a report is escalated to the
  human.
- Opting out is `run intent authority <run> auto_correct=false`, or a workspace default.

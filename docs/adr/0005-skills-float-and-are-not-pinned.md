# 0005 — Skills float; we do not pin them

**Status:** accepted, 2026-09-02

## Context

Collie's baseline workflows hard-require ten skills they do not ship: `code-review`,
`grill-with-docs`, `implement`, `improve-codebase-architecture`, `tdd`, `to-spec`,
`to-tickets` and `wayfinder` from `mattpocock/skills`, and `code-review-and-quality` and
`code-simplification` from `addyosmani/agent-skills`. Validation treats a missing skill as a
missing prerequisite, like the harness binary, so on a machine without them every workflow
stops before its first tab opens.

The skills.sh CLI installs them globally into `~/.agents/skills` — already Collie's
`skillDirs` — and `npx skills update -g -y` brings them to their latest upstream state. It
can also restore an exact set from a committed `skills-lock.json` (`experimental_install`).

So the choice is whether this installation tracks upstream or a version we bump by hand.
It is not a free choice: several Steps read a skill's _output contract_. The `plan`
workflow expects `grill-with-docs` to write `grill.json`, `to-spec` to write `spec.json`,
`to-tickets` to write `tickets.json`. An upstream change to what a skill writes breaks a
workflow with no change on our side.

## Decision

Skills float. Every install and every `collie upgrade` runs the skills.sh CLI's `add` and
`update` for the configured sources, always taking the latest upstream. No lockfile is
committed, and no skill is vendored into this repo.

The sources are pinned; the versions are not. The `mattpocock/skills` official bucket is
its `.claude-plugin/plugin.json` skill list, which is exactly `skills/engineering` plus
`skills/productivity`, so those two paths are added rather than the whole repository or a
list of skill names — a path keeps picking up what upstream adds to it, where a name list
would silently stop at what we knew about.

## Alternatives

- **Commit a `skills-lock.json` and bump deliberately.** Correct on paper, and it would
  turn "an upstream edit broke the `plan` workflow" into a change we chose. Rejected on two
  counts: the restore command is flagged experimental, and a lock nobody bumps is precisely
  the keeping-up-to-date chore this work exists to delete. A pin that goes stale is worse
  than no pin, because it looks like it is being maintained.
- **Vendor the ten skills into this repo.** One version, one `git pull`, no network at
  install. Rejected: it forks someone else's work, and every upstream improvement then
  arrives only if a human copies it across.

## Consequences

An upstream skill change can break a workflow between one run and the next, and no diff in
this repo will explain it. The symptom is a Step whose output cannot be read, which Collie
already reports (`output-unusable`), and the fix is to look upstream first. The docs say so
out loud rather than leaving it to be discovered.

In exchange, keeping up to date needs no decision from anyone: the sources are declared
once and the upgrade path fetches whatever they now say.

Project root: {{cwd}}
Report: {{run.dir}}/plan/ARCHITECTURE.md

## attended

You were started with {{skill:improve-codebase-architecture}}, over `{{cwd}}`, with the real
grill: ask me about the parts you cannot judge from the code, one question at a time, and
rate every candidate by the deletion test.

Write the report to `{{run.dir}}/plan/ARCHITECTURE.md`. Never open a browser and never
write into the repository in this step.

If we agree on work worth doing, write it up the way the planner would — a spec at
`{{run.dir}}/plan/SPEC.md` and tickets at `{{run.dir}}/plan/issues/NN-<slug>.md` — so
that Implement now has a plan to build from.

Then write your Output, with everything we agreed not to do now under `deferred`. The
`slug` is what the branch an Implement now would build is named after, so make it name the
work we agreed on rather than the repository.

## unattended

Nobody is watching this step. Do not ask questions and do not wait.

Scope: only the area this run has changed — `git diff` against the branch point, plus
the files that change with it. Leave the rest of the project alone.

You were started with {{skill:improve-codebase-architecture}}, scoped to that. Apply `Strong`
candidates only,
largest first, then re-scan and go again; at most two passes. Behaviour stays identical
and the project's tests stay green — say what you ran. Never open a browser.

Write the report to `{{run.dir}}/plan/ARCHITECTURE.md`. Everything you did not apply
goes under `deferred` with its strength and what leaving it costs, because that list is
what the human reads at the end.

Then write the Output JSON as your persona describes.

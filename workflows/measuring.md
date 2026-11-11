## measure

This ticket's speed-up criterion is proved by a Measurement, never by timing anything
yourself. Its benchmark plan is `{{benchmark}}`, the JSON `collie measure --plan` takes:

## measure.own

A criterion that something is faster, smaller or lighter is a Measurement, never a timing
script, as a planned ticket's `**Benchmark:**` is. Write its benchmark plan beside its
ticket, `{{benchmark}}`, as the JSON `collie measure --plan` takes: the commands that
exercise the work, its metrics with exactly one `primary`, and the harness's `paths` with
no `commits` yet. Name it on the ticket's own line, `**Benchmark:** NN-<slug>.benchmark.json`,
and write the criterion as the verdict its `final` Measurement gives: a `gain` on the
primary metric with every guardrail held. Then:

## measure.task

A claim that something is faster, smaller or lighter is a Measurement, never a timing
script. For a speed comparison, write its benchmark plan in `{{benchmark}}`, as the JSON
`collie measure --plan` takes: the commands that exercise the work, its metrics with
exactly one `primary`, and the harness's `paths` with no `commits` yet. Then:

## measure.steps

1. Commit the benchmark harness, touching only the plan's `harness.paths`, and add those
   commits to the plan's `harness.commits`.
2. Before the speed-up, measure the base against itself:
   `collie measure --base <merge-base> --plan {{benchmark}} --pass calibration`, where
   `<merge-base>` is the commit this branch leaves its default branch at.
3. On the finished tree:
   `collie measure --base <merge-base> --plan {{benchmark}} --pass final`.
4. Read the verdict for each metric. The criterion is met where the primary metric is a
   `gain` and every guardrail is held: answer it with the `final` Measurement's id and those
   verdicts.

Time no A/B comparison yourself, as a verification or otherwise, and take no lock of your
own: the host's Measurement holds the Machine and samples both trees. Leave the plan as it
is between the two passes, since a changed plan is a new comparison.

A note you hand on — to a later step, another agent or a human — goes in
`{{run.dir}}/handoffs/`, never `/tmp`: the Run's record lists it, and it is kept as long
as the Run is.

## discover

Find out what would make this project faster, before anything is changed.

The project is the checkout you are in. What the human asked to focus on, if anything:

{{inputs.focus}}

1. Find the stack: languages, runtimes, frameworks, databases and how it is built. Load the
   installed skills that fit it, by name, and list them. Never copy a skill into the project.
2. Write down the journeys that matter to the people using it, each with its objectives —
   p50, p95 or p99 latency, throughput at an equal load, CPU, memory, allocations, I/O,
   query count, startup, build, bundle or browser metrics — and why each matters.
3. Try each telemetry source you can reach: APM, logs, traces, flamegraphs. Record each as
   `used`, with the release, the time window, the sample and a link with any credential or
   personal data taken out, or as `unavailable`, with the reason. Production is read-only:
   only bounded queries over a stated window, and never a load test against it.
4. Read the official documentation of the stack, runtime and database, and the prior work on
   this project — issues, merge requests, commits, published benchmarks. Record each source
   with its link and the opportunity it raised, lowered or ruled out. Where you found nothing,
   record what you searched.
5. Rank the opportunities, best first. Mark each `measured`, `telemetry` or `hypothesis`, and
   cite the research links, telemetry sources or Measurement ids it rests on.
6. List the improvements only another repository could make as candidate external findings.
   Never change another repository.

Change nothing in the checkout.

## harness

Write the benchmark this Run will be measured by, before any product change.

What Discover found:

{{discovered}}

1. Write a benchmark harness that measures the journeys above: small local commands with a
   bounded workload against a local target, end to end as well as micro where it applies.
   Never against production, and never a load that reaches anything outside this Machine.
2. Commit it on its own commits, touching only the harness paths you declare: no product
   change goes in these commits. List every harness commit in your Output.
3. Write the plan as your Output:
   - the journeys and cases (cold, warm) it measures;
   - the commands each sample runs, in order, from the checkout's root, with no shell;
   - a prepare command run once per tree before its samples, or null;
   - the metrics, each with its direction (`lower` or `higher` is better) and role: exactly
     one `primary`, the rest `guardrail`. The host reads `<command>.wall_ms`,
     `<command>.cpu_ms` and `<command>.peak_kb`, and every number in a JSON object a
     command prints as its last stdout line as `<command>.<key>`;
   - the warmup;
   - for a metric this Machine may be too noisy to prove, a low-variance counter of the
     same work (instructions, allocations, queries, bytes) to judge it by instead.

The Run takes {{budget.samples}} samples per side and judges a gain of at least
{{budget.threshold}}% against a tolerance of {{budget.tolerance}}%. The host then measures
the base against itself to learn how noisy this Machine is.

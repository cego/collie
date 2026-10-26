# Test processes share one budget per Machine

**Status: accepted, to be built.** Replaces the whole-suite lock of #66 and the idle-core
sample of #135 (`tools/test.ts`, `tools/test-run.ts`, `tools/suite-lock.ts`).

On vm-mk on 2026-10-26, run-a0b408a4.release's `bun run check` took 15 and 13 minutes. The
whole suite's wall time was one file's serial time. `bun test --parallel` spreads files,
not tests, and `test/baseline.test.ts` ran its 322 scenarios one after another in 744 of
the suite's 756 seconds. Balanced over the 16 workers, the same work would have taken 350
seconds. In 99 of the 101 whole suites logged since 10-14, a baseline file was the longest,
and the suite took as long as that file.

Workers past about 16 on 24 cores bought nothing. Each test process starts hosts, compiled
fakes and git: 17,216 processes in one suite. Across those logs, total test time per test
was 0.72 s at 2 workers, about 1.0 s at 8, 1.28 s at 16 and 1.95 s at 24. Tests per second
stop rising at about 16. The one-second idle sample picks 24 whenever the moment after the
builds is idle, which is the oversubscribed point. These figures are observational, from
different days and loads.

The lock covered only whole suites run through `tools/test.ts`. An agent's bare `bun test`
of the two baseline files ran from the sources, outside the lock, for 2,093 seconds. It
overlapped run-c59ace93's 24-worker suite, the day's slowest at 1,077 seconds. Targeted
runs take no turn, so their number has no bound. The lock is claimed by polling every 25 ms,
so the next suite is whichever waiter polls first, not the one that has waited longest. On
10-22 and 10-23, with 16 cores near 100 % busy for five hours, suites took 31 to 77 minutes
and failed with up to 94 tests each.

## Decision

**D1. No test file is the critical path.** The baseline scenarios are split over several
files per pass, each a stable share by scenario name, so each file takes no more than a
fraction of the suite. Every scenario still runs as shipped and under an unrelated id
([ADR-0029](0029-one-host-acts-for-a-run-and-a-workflows-name-decides-nothing.md)).

**D2. One budget per user per Machine, counted in test processes.** The budget is two
thirds of the cores, at least 2: 16 on vm-mk. A quarter of it, at least 2, is reserved
for small runs: a targeted run, a bare `bun test`, or one of Collie's single-test reruns.
Whole suites share the rest. A whole suite asks for all of that rest, so whole suites run
one at a time, as they did under the lock. A small run never waits behind a whole suite.
A caller's `--parallel=N` asks for N workers. A run gets no more than its class's share,
and its log says when it got fewer than it asked for; otherwise a request larger than the
reserve could never start. `COLLIE_TEST_BUDGET` sets the budget's size, for an experiment
or a Machine where two thirds is wrong. Where the rest after the reserve would be under 2, as with a budget of 2
or 3, there are no classes: every run takes from all of the budget, in arrival order across
both kinds, and a whole suite asks for all of it. A small run waits behind a whole suite only
on a Machine that small, and the bound still holds.

**D3. Admission is in arrival order, and a dead holder holds nothing.** A waiter takes a
ticket. Within its class, tickets are admitted oldest first. A hold names every process
that runs on it, the runner and the `bun test` it starts, so a runner killed with
`kill -9` does not free the slots its still-running tests use. A ticket or hold whose
processes are all gone is removed by the next process that looks. A process is identified
by pid and start time, as `src/lock.ts` identifies a holder. Interrupting a run gives back what it
held. Waiting polls at most a few times a second, and says once who it waits for and
then how long it has waited.

**D4. Every test process counts, however it was started.** `tools/test.ts` admits its own
workers before it starts them, and tells them so. The test preload, which every
`bun test` loads, admits any process nobody admitted, so a bare `bun test` joins the budget
like any other run.

**D5. A run says where its time went.** Each run reports how long it queued, built and
ran, its workers, the budget, its longest file and that file's share of the run, the sum
of test time, the processes it started, and CPU pressure and load when it started and
ended.

**D6. Two versions share the Machine while worktrees catch up.** A whole suite admitted
by the budget also takes the old suite lock. A whole suite from an older checkout then
still waits for a newer one, and the reverse.

**D7. Slowness is never hidden.** No test timeout is raised, and no retry is added. A
failed test that passes alone is still reported as a Flake, as ADR-0034 says.

## Considered

- **Sample idle cores and adapt.** This is #135's approach. One sample cannot see the
  load the suite is about to create, and it picks the oversubscribed point whenever the
  Machine is idle at that moment. A controller fed by PSI could follow load as it changes.
  It would still need the same cap to stay stable, so the cap comes first.
- **Run two whole suites at once, half the workers each.** The work done is about the
  same as running them one after the other. The first result arrives about twice as late.
- **cgroups or `nice`.** Either bounds a share of CPU without counting what is waiting,
  and neither is on macOS (ADR-0048). They are left for the host's own checks, if one day
  those need a bound.
- **Run the unrelated pass on a subset.** This would cut about 13 % of the suite's
  work, and it would give up ADR-0029's guarantee that no scenario works only under its
  shipped name.
- **Only document "run `bun run test`".** Agents run bare `bun test` today, and this
  morning's slowest suite overlapped exactly such a run.

## Consequences

A whole suite on vm-mk should take about 7 minutes rather than 13 to 18. Its work, about
4,400 tests at roughly 1.15 s each over 12 workers, sets that time now, rather than its
longest file. Making each test cheaper is what takes it below 6 minutes. A profile of
baseline scenarios puts their CPU in the engine's storage polling, git process starts,
including fixtures' own `git gc --auto` and `git maintenance run`, and the filesystem. A minute is not reachable on vm-mk
with this suite. A minute is what a targeted run (`--changed`, or one shard) is for.

A Machine with fewer cores gets fewer workers. The two-thirds figure was measured on
vm-mk alone, and is to be checked again on a laptop before it is trusted there.

Checks for other projects that Collie's host runs are not covered. Nothing in the
evidence shows them competing on vm-mk.

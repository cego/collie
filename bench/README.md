# Host read comparison

`read.ts prepare` freezes 487 completed `hello` Runs with fake herdr. Each sample starts
a fresh host from a copy of that state. It records cold startup, a 10-second warm-up,
a 20-second idle CPU window, and 12 reads of each RPC. The mutation phase adds one
waiting Run and runs control/read sequences alongside reads of a settled Run. It checks
control freshness, Flow actions and answered Choice content.

Run `paired.ts` from the candidate checkout, with a detached merge-base checkout and
a new evidence directory:

```sh
bun bench/paired.ts /path/to/merge-base /path/to/evidence /path/to/state/measurements/machine.lock
```

Install candidate dependencies from a fresh private cache with `bun install
--frozen-lockfile --cache-dir .scratch/private-bun-cache --backend copyfile`, then copy
that independent installation to the baseline checkout. Do not edit shared dependencies.

The driver takes Collie's cooperative Machine Measurement lock. It checks the locked
4.0.1 filesystem and SQL implementation hashes against pristine packages and requires
independent files with one hard link. It repeats those checks before and after every
process, and installs baseline dependencies only through the private cache with
`copyfile`. It copies the identical harness into that checkout. Both versions use
copies of one frozen fixture, with the same absolute paths. It retains each process's
stdout, stderr and surrounding load/process readings. Cold means a fresh host with warm
OS caches; the driver never evicts system caches or stops other work.

The fixed protocol is ten alternating AB/BA pairs, with no discarded samples, retries
or optional stopping. A process's mean warm `collie_run` latency is the primary endpoint;
its twelve RPCs are repeated observations, not twelve independent experiments. The
driver reports paired log-ratio effect sizes and two-sided 95% Student t intervals
with nine degrees of freedom. This assumes approximately normal paired log ratios.

The verdict requires an upper interval below 1 for primary latency and idle CPU,
below 1.10 for latency guardrails and peak RSS, and candidate warm p95 at most five
seconds in every sample. It also requires zero correctness failures and matching
settled answer text. An inconclusive interval or failed guardrail means performance
is not proved improved. Raw data remains available even when a process fails.

`bun bench/paired.ts --self-check` checks the ratio/interval calculation against a
known 50% reduction. The original discovery baseline was `eadce921`; each study records
its actual merge-base and candidate revisions separately.

The first study of 2026-10-29 was invalidated in full after discovering filesystem and
SQL profiling instrumentation left in shared dependencies by the original tune-up.
Its samples are retained in the Run record and excluded from conclusions. Only the
replacement study with verified pristine dependencies can support a verdict.

## Final-tree comparison

The [final-tree evidence](results/read-final-2026-10-29.json) compares `dc39763f`
against merge base `cb8edab0`, including the merged runtime and child-order fix.
**Verdict: not proved improved; leave unmerged.** Peak host RSS exceeds the 10%
allowance. Correctness and all other declared guardrails held in this study.

| Metric                        | Baseline mean | Candidate mean | Paired ratio, 95% CI | Guardrail |
| ----------------------------- | ------------: | -------------: | -------------------- | --------- |
| Warm read, ms                 |       1,775.2 |        1,017.7 | 0.568 [0.485, 0.665] | Held      |
| Warm read p95, ms             |       3,573.2 |        1,968.8 | 0.567 [0.480, 0.671] | Held      |
| Cold read, ms                 |       9,788.8 |        7,125.9 | 0.728 [0.672, 0.789] | Held      |
| Shown, ms                     |         861.6 |          757.8 | 0.886 [0.814, 0.964] | Held      |
| Listing, ms                   |         798.3 |          701.5 | 0.868 [0.732, 1.030] | Held      |
| Idle host CPU, ms/s           |         792.7 |          498.2 | 0.627 [0.594, 0.663] | Held      |
| Peak RSS, KiB                 |     324,227.2 |      521,775.6 | 1.610 [1.579, 1.641] | Failed    |
| Concurrent control + read, ms |       5,981.5 |        3,524.4 | 0.595 [0.534, 0.664] | Held      |
| Read during mutation load, ms |       5,881.9 |        2,636.2 | 0.451 [0.411, 0.494] | Held      |

Peak RSS rises 61.0% (95% CI: 57.9–64.1%), so the favorable latency and CPU
endpoints cannot establish an acceptable overall result. The historical shown and
listing uncertainty remains recorded below; these final-tree observations are independent.

All ten interleaved pairs completed without interruption, retries, or discarded
observations, ending October 29, 2026, at 14:31:20.906 UTC. All 240 settled answers
were identical, and every candidate warm p95 was within five seconds. Surrounding
one-minute load ranged from 5.94 to 20.65 on 24 logical CPUs. Dependency hashes and
single-link provenance were checked before and after every process.

The completion did not resume the implementer. The lock-release notice and evidence
handoff were completed during recovery on October 30; no timing observations were repeated.
The raw logs, dependency checks, and contention snapshots are embedded in the evidence.

## Historical candidate

The following study predates the merge of `origin/master` and the child-order fix.
It does not establish performance for the current tree. The final-tree comparison above
uses the same ten-pair protocol, endpoints, intervals, and guardrails against merge
base `cb8edab0`. No historical observation is reused in that comparison.

The [complete observations and provenance](results/read-2026-10-29.json) compare
implementation `7b67f8a6` against merge base `6b3e277f`. **Verdict: not proved
improved; leave unmerged.** Correctness checks passed, and every candidate warm p95
was at most five seconds. Peak RSS exceeded its 10% allowance; shown and listing
latency guardrails were inconclusive.

| Metric                        | Baseline mean | Candidate mean | Paired ratio, 95% CI | Verdict      |
| ----------------------------- | ------------: | -------------: | -------------------- | ------------ |
| Warm read, ms                 |       1,988.2 |        1,102.5 | 0.551 [0.456, 0.665] | Improved     |
| Warm read p95, ms             |       4,313.9 |        2,167.1 | 0.529 [0.359, 0.779] | Held         |
| Cold read, ms                 |      10,396.9 |        7,536.0 | 0.728 [0.684, 0.774] | Held         |
| Shown, ms                     |         899.8 |          889.0 | 0.977 [0.804, 1.185] | Inconclusive |
| Listing, ms                   |         865.6 |          829.7 | 0.945 [0.769, 1.161] | Inconclusive |
| Idle host CPU, ms/s           |         781.9 |          498.0 | 0.641 [0.589, 0.697] | Improved     |
| Peak RSS, KiB                 |     325,406.8 |      515,069.6 | 1.584 [1.533, 1.637] | Failed       |
| Concurrent control + read, ms |       6,022.6 |        3,603.8 | 0.600 [0.565, 0.637] | Held         |
| Read during mutation load, ms |       6,407.9 |        2,744.6 | 0.429 [0.389, 0.473] | Held         |

Means above are arithmetic process means; ratios and intervals use paired log ratios.
Each process's empirical p95 is the maximum of its twelve observations. The primary
latency reduction is 44.9% (95% CI: 33.5–54.4%), and idle host CPU falls 35.9%
(30.3–41.1%). Peak RSS rises 58.4% (53.3–63.7%). These fixture results do not establish
live Desktop latency or whole-process-tree CPU cost.

The Machine remained shared: surrounding one-minute load ranged from 7.00 to 27.31
on 24 logical CPUs. Load/process snapshots are retained for each process. Two production
host upgrades terminated the first process of pair seven
before it yielded an observation. The six completed pairs were retained, the unchanged
fixture hash and dependency provenance were rechecked, and only incomplete attempts
were repeated. All twenty completed observations enter the fixed ten-pair analysis;
no completed pair spans a host upgrade. The interruption records are included in the
data. Bulk fixtures were relocated out of the Run's recursive handoff listing.

Check the harness with `bunx tsc --noEmit -p bench/tsconfig.json` and
`bun bench/paired.ts --self-check`, each through `collie verify` when working in a Run.

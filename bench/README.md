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
4.1.0 filesystem and SQL implementation hashes against pristine packages and requires
independent files with one hard link. It repeats those checks before and after every
process, and installs baseline dependencies only through the private cache with
`copyfile`. It copies the identical harness into that checkout. Both versions use
copies of one frozen fixture, with the same absolute paths. It retains each process's
stdout, stderr and surrounding load/process readings. Cold means a fresh host with warm
OS caches; the driver never evicts system caches or stops other work.

The fixed protocol is ten alternating AB/BA pairs, with no discarded samples, retries
or optional stopping. Since 0.109.0 released the read optimization, the base already
has it and the study measures the memory fix: a process's peak host RSS is the primary
endpoint. A latency's twelve RPCs are repeated observations, not twelve independent
experiments. The driver reports paired log-ratio effect sizes and two-sided 95% Student
t intervals with nine degrees of freedom. This assumes approximately normal paired log
ratios.

The verdict requires an upper interval below 1 for peak RSS, below 1.10 for every
latency and idle CPU, and candidate warm p95 at most five seconds in every sample. It
also requires zero correctness failures and matching settled answer text. An inconclusive interval or failed guardrail means performance
is not proved improved. Raw data remains available even when a process fails.

`bun bench/paired.ts --self-check` checks the ratio/interval calculation against a
known 50% reduction. The original discovery baseline was `eadce921`; each study records
its actual merge-base and candidate revisions separately.

The first study of 2026-10-29 was invalidated in full after discovering filesystem and
SQL profiling instrumentation left in shared dependencies by the original tune-up.
Its samples are retained in the Run record and excluded from conclusions. Only the
replacement study with verified pristine dependencies can support a verdict.

## Memory fix against 0.109.0

The [memory-fix evidence](results/read-fix-2026-10-30.json) compares `efeb81b5` against
merge base `e8d02a5d` (release 0.109.0, which already has the read optimization).
**Verdict: not proved improved; do not release.** Peak RSS, the primary endpoint, falls
36.3% (95% CI: 34.9–37.7%). Six latency guardrails were inconclusive, and one candidate
warm p95 exceeded five seconds.

| Metric                        | Baseline mean | Candidate mean | Paired ratio, 95% CI | Verdict      |
| ----------------------------- | ------------: | -------------: | -------------------- | ------------ |
| Peak RSS, KiB                 |     504,999.2 |      321,392.0 | 0.637 [0.623, 0.651] | Improved     |
| Warm read, ms                 |       1,695.9 |        1,658.2 | 0.989 [0.834, 1.174] | Inconclusive |
| Warm read p95, ms             |       3,176.1 |        3,089.9 | 0.983 [0.748, 1.293] | Inconclusive |
| Cold read, ms                 |      10,758.0 |        9,056.8 | 0.863 [0.746, 0.997] | Held         |
| Shown, ms                     |       1,527.2 |        1,540.7 | 1.023 [0.834, 1.255] | Inconclusive |
| Listing, ms                   |         852.2 |          785.5 | 0.915 [0.723, 1.157] | Inconclusive |
| Idle host CPU, ms/s           |         534.8 |          522.0 | 0.978 [0.907, 1.055] | Held         |
| Concurrent control + read, ms |       4,507.3 |        4,641.1 | 1.027 [0.936, 1.127] | Inconclusive |
| Read during mutation load, ms |       3,553.2 |        3,815.7 | 1.068 [0.960, 1.187] | Inconclusive |

Pair six ran under one-minute load 27–33. Its warm p95 was 6,956 ms for the candidate
and 6,798 ms for the base. Surrounding load over the study ranged from 10.42 to 32.95
on 24 logical CPUs. That is higher than the October 29 studies saw, and it widened every
latency interval. Apart from cold read, every latency's point estimate is within 9% of
the base. The protocol, though, needs an upper bound below 1.10.

All ten pairs completed, ending October 30, 2026, at 12:24:41.5 UTC. There were no
retries and no discarded observations. All 240 settled answers were identical. Two
earlier attempts ended before any observation:

- The first stopped in the dependency check, on Effect 4.1's bigint link count. That
  was fixed in `efeb81b5`, on both sides alike.
- The second was ended by the production host's upgrade to 0.109.0.

Both records are in the evidence.

## Final-tree comparison

The [final-tree evidence](results/read-final-2026-10-29.json) compares `dc39763f`
against merge base `cb8edab0`, including the merged runtime and child-order fix.
**Verdict: not proved improved; leave unmerged.** Peak host RSS exceeds the 10%
allowance. Correctness and all other declared guardrails held in this study.

Later `origin/master` merges moved this branch's base past `cb8edab0`, including runtime
files. The branch still adds and removes exactly the measured lines, and the harness is
unchanged, but this study measured the change on `cb8edab0` only. It establishes nothing
about the change on any later base, and no later tree was measured.

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

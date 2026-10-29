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

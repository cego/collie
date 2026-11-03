# One runner holds one shard

**Status: accepted.** Extends [ADR-0014](0014-native-workflows-run-on-effects-own-engine.md)
D2 with a third setting that is not the default.

A host runs Effect's cluster as one `SingleRunner`, which holds every shard there is.
Upstream's `shardsPerGroup` is 300. Each shard is a row in `cluster_locks` the runner takes
at start, refreshes, and deletes at stop, one statement each. On vm-mk on 2026-11-02,
counting the SQL one baseline scenario file ran (`test/baseline-01.test.ts`, 39 scenarios,
45 engines) gave 44,616 statements, 13,500 of them per-shard lock deletes and 5,499
transactions. In two AB/BA pairs of three files (`test/baseline-01.test.ts`,
`test/host.test.ts`, `test/reports.test.ts`), one shard used 382 and 383 CPU-s against 398
and 423 at 300, with the same 83 tests passing.

## Decision

**D1. `shardsPerGroup` is 1.** No second runner can share a host's state directory
(ADR-0015), so more shards spread work over nothing.

**D2. Messages an engine on 300 shards left are moved onto the one, before the cluster reads
its storage.** A message carries its shard, and the runner reads only the shards it holds,
so a message left on `default:223` by an earlier host would never be read again. Before the
runner is built, `cluster_messages` rows on any other shard are moved to `default:1` and
lock rows for other shards are deleted. `test/engine.test.ts` holds it: work an engine on
upstream's sharding left waiting is finished by the one-shard engine.

## Consequences

- A host that is downgraded after this reads the moved messages: an earlier runner holds all
  300 shards, `default:1` among them.
- The rewrite runs on every engine start, and is a no-op once nothing is on another shard.

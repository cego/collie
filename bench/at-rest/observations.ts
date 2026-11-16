/* oxlint-disable effecttsgo/node-builtin-import, no-restricted-imports -- the benchmark reads its isolated host's files. */
import type { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { Effect } from "effect";
import * as Arr from "effect/Array";
import * as Str from "effect/String";

export const writerMarkers = <A, E, R>(completed: Effect.Effect<A, E, R>, path: string) =>
  Effect.gen(function* () {
    yield* completed.pipe(Effect.timeout("30 seconds"));
    const text = yield* Effect.sync(() => readFileSync(path, "utf8"));
    return Arr.map(Arr.fromIterable(Str.matchAll(/bench-log:(\d+):(\d+)/g)(text)), (marker) => ({
      sequence: Number(marker[1]),
      at: Number(marker[2]),
    }));
  });

export const wakeDeadline = (db: Database, runId: string) => {
  const row = db
    .query<{ deliver_at: number | null }, [string]>(`
    SELECT m.deliver_at FROM cluster_messages m
    JOIN collie_runs r ON r.execution = m.entity_id
    WHERE r.run = ? AND m.entity_type = 'Workflow/-/DurableClock'
    ORDER BY m.deliver_at LIMIT 1
  `)
    .get(runId);
  if (row?.deliver_at == null || !Number.isFinite(row.deliver_at))
    throw new Error(`no durable deadline for ${runId}`);
  return row.deliver_at;
};

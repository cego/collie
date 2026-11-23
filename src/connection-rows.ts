// Each Connection reading an offer needs, as the host last read it, in its database
// (ADR-draft-the-board-is-a-projection-of-facts-the-host-syncs). A listing's offers read the
// row; taking an offer, and the syncer, read the Connection itself.

import * as Arr from "effect/Array";
import { Context, Effect, Layer, Option, Result, Schema, flow } from "effect";
import * as Reactivity from "effect/reactivity/Reactivity";
import * as SqlClient from "effect/sql/SqlClient";
import { ConnectionId, ConnectionReading } from "./connection-model";

const ReadingJson = Schema.fromJsonString(ConnectionReading);
const encodeReading = flow(Schema.encodeResult(ReadingJson), Result.getOrThrow);
const decodeReading = Schema.decodeUnknownOption(ReadingJson);
const decodeId = Schema.decodeUnknownOption(ConnectionId);

/** Where a Connection is read: its id, and the checkout it is read from. */
export interface ConnectionAt {
  readonly id: ConnectionId;
  readonly cwd: string;
}

export interface ConnectionRowsApi {
  /** The kept reading, or null where none was read yet, which asks the syncer for one. */
  readonly of: (at: ConnectionAt) => Effect.Effect<ConnectionReading | null>;
  /** Every Connection a listing asked for: those never read first. */
  readonly wanted: Effect.Effect<ReadonlyArray<ConnectionAt & { readonly read: number }>>;
  readonly put: (at: ConnectionAt, reading: ConnectionReading, read: number) => Effect.Effect<void>;
  /** Each checkout's kept readings, as one text that moves only when one of them does. */
  readonly readings: Effect.Effect<ReadonlyMap<string, string>>;
}

export class ConnectionRows extends Context.Service<ConnectionRows, ConnectionRowsApi>()(
  "collie/ConnectionRows",
) {}

/** What a moved reading invalidates. */
export const CONNECTIONS = "collie/connections";

export const connectionRowsLayer = Layer.effect(ConnectionRows)(
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const reactivity = yield* Reactivity.Reactivity;
    return {
      of: ({ id, cwd }) =>
        Effect.gen(function* () {
          const found = yield* sql<{ readonly reading: string | null }>`
            SELECT reading FROM collie_connections WHERE id = ${id} AND cwd = ${cwd}
          `;
          const row = found[0];
          if (row === undefined)
            yield* sql`
              INSERT OR IGNORE INTO collie_connections (id, cwd, reading, read)
              VALUES (${id}, ${cwd}, NULL, 0)
            `;
          return row?.reading == null ? null : Option.getOrNull(decodeReading(row.reading));
        }).pipe(Effect.orDie),
      wanted: sql<{ readonly id: string; readonly cwd: string; readonly read: number }>`
        SELECT id, cwd, read FROM collie_connections ORDER BY read
      `.pipe(
        Effect.map(
          Arr.flatMap((row) =>
            Option.match(decodeId(row.id), {
              onNone: () => [],
              onSome: (id) => [{ id, cwd: row.cwd, read: row.read }],
            }),
          ),
        ),
        Effect.orDie,
      ),
      put: ({ id, cwd }, reading, read) =>
        Effect.gen(function* () {
          const text = encodeReading(reading);
          const was = yield* sql<{ readonly reading: string | null }>`
            SELECT reading FROM collie_connections WHERE id = ${id} AND cwd = ${cwd}
          `;
          yield* sql`
            INSERT INTO collie_connections (id, cwd, reading, read) VALUES (${id}, ${cwd}, ${text}, ${read})
            ON CONFLICT (id, cwd) DO UPDATE SET reading = excluded.reading, read = excluded.read
          `;
          if (was[0]?.reading !== text) yield* reactivity.invalidate([CONNECTIONS]);
        }).pipe(Effect.orDie),
      readings: sql<{ readonly id: string; readonly cwd: string; readonly reading: string | null }>`
        SELECT id, cwd, reading FROM collie_connections ORDER BY cwd, id
      `.pipe(
        Effect.map((rows) => {
          const byCwd = new Map<string, string>();
          for (const row of rows)
            byCwd.set(row.cwd, `${byCwd.get(row.cwd) ?? ""}${row.id}=${row.reading ?? ""}\n`);
          return byCwd;
        }),
        Effect.orDie,
      ),
    } satisfies ConnectionRowsApi;
  }),
);

import * as Arr from "effect/Array";
import { Context, Effect, Layer, Option, Result, Schema, flow } from "effect";
import * as Reactivity from "effect/reactivity/Reactivity";
import * as SqlClient from "effect/sql/SqlClient";
import { ConnectionId, ConnectionReading } from "./connection-model";

const ReadingJson = Schema.fromJsonString(ConnectionReading);
const encodeReading = flow(Schema.encodeResult(ReadingJson), Result.getOrThrow);
const decodeReading = Schema.decodeUnknownOption(ReadingJson);
const decodeId = Schema.decodeUnknownOption(ConnectionId);

export interface ConnectionAt {
  readonly id: ConnectionId;
  readonly cwd: string;
}

export interface ConnectionRowsApi {
  // WARNING: a null reading asks the syncer for one.
  readonly of: (at: ConnectionAt) => Effect.Effect<ConnectionReading | null>;
  readonly wanted: Effect.Effect<ReadonlyArray<ConnectionAt & { readonly read: number }>>;
  readonly put: (at: ConnectionAt, reading: ConnectionReading, read: number) => Effect.Effect<void>;
}

export class ConnectionRows extends Context.Service<ConnectionRows, ConnectionRowsApi>()(
  "collie/ConnectionRows",
) {}

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
          if (row === undefined) {
            yield* sql`
              INSERT OR IGNORE INTO collie_connections (id, cwd, reading, read)
              VALUES (${id}, ${cwd}, NULL, 0)
            `;
          }
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
          if (was[0]?.reading !== text) {
            yield* reactivity.invalidate([CONNECTIONS]);
          }
        }).pipe(Effect.orDie),
    } satisfies ConnectionRowsApi;
  }),
);

import * as Arr from "effect/Array";
import { Context, Effect, Layer, Option, Result, Schema, flow } from "effect";
import * as SqlClient from "effect/sql/SqlClient";
import { TaskView } from "./board-model";

// WARNING: `view` is null for a card folded into History.
export interface CardRow {
  readonly task: string;
  readonly view: TaskView | null;
  // WARNING: by content, so it holds across a host restart.
  readonly digest: string;
  readonly due: number;
  readonly at: number;
}

const ViewJson = Schema.fromJsonString(TaskView);
const encodeView = flow(Schema.encodeResult(ViewJson), Result.getOrThrow);
const decodeView = Schema.decodeUnknownOption(ViewJson);

interface Stored {
  readonly task: string;
  readonly view: string | null;
  readonly digest: string;
  readonly due: number | null;
  readonly at: number;
}

export interface CardRowsApi {
  // WARNING: a row whose view no longer decodes is left out.
  readonly all: Effect.Effect<ReadonlyArray<CardRow>>;
  readonly write: (put: ReadonlyArray<CardRow>, drop: ReadonlyArray<string>) => Effect.Effect<void>;
}

export class CardRows extends Context.Service<CardRows, CardRowsApi>()("collie/CardRows") {}

export const cardRowsLayer = Layer.effect(CardRows)(
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    return {
      all: sql<Stored>`SELECT task, view, digest, due, at FROM collie_cards`.pipe(
        Effect.map(
          Arr.flatMap((row) => {
            const view = row.view === null ? Option.some(null) : decodeView(row.view);
            const returned: ReadonlyArray<CardRow> = Option.isNone(view)
              ? []
              : [
                  {
                    task: row.task,
                    view: view.value,
                    digest: row.digest,
                    due: row.due ?? Infinity,
                    at: row.at,
                  },
                ];
            return returned;
          }),
        ),
        Effect.orDie,
      ),
      write: (put, drop) =>
        put.length === 0 && drop.length === 0
          ? Effect.void
          : sql
              .withTransaction(
                Effect.gen(function* () {
                  for (const row of put) {
                    yield* sql`
                      INSERT INTO collie_cards (task, view, digest, due, at)
                      VALUES (${row.task}, ${row.view === null ? null : encodeView(row.view)},
                        ${row.digest}, ${Number.isFinite(row.due) ? row.due : null}, ${row.at})
                      ON CONFLICT (task) DO UPDATE SET view = excluded.view,
                        digest = excluded.digest, due = excluded.due, at = excluded.at
                    `;
                  }
                  for (const chunk of Arr.chunksOf(drop, 500)) {
                    yield* sql`DELETE FROM collie_cards WHERE task IN ${sql.in(chunk)}`;
                  }
                }),
              )
              .pipe(Effect.orDie),
    } satisfies CardRowsApi;
  }),
);

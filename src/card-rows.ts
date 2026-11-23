// The board's projection in the host's database (ADR-draft-the-board-is-a-projection-of-facts-the-host-syncs):
// each Task's card as it was last derived, with the digest of what it was derived from, so a
// host's first board is these rows and a card is derived again only when what it read moves.

import * as Arr from "effect/Array";
import { Context, Effect, Layer, Option, Result, Schema, flow } from "effect";
import * as SqlClient from "effect/sql/SqlClient";
import { TaskView } from "./board-model";

/** One Task's card. `view` is null for a card folded into History. */
export interface CardRow {
  readonly task: string;
  readonly view: TaskView | null;
  /** What the card was derived from, by content, so it holds across a host restart. */
  readonly digest: string;
  /** When time alone next changes what the card says; Infinity for never. */
  readonly due: number;
  /** When the host that derived it wrote it. */
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
  /** Every card, folded ones too; a row whose view no longer decodes is left out. */
  readonly all: Effect.Effect<ReadonlyArray<CardRow>>;
  /** Writes these cards and drops these Tasks' cards, in one transaction. */
  readonly write: (put: ReadonlyArray<CardRow>, drop: ReadonlyArray<string>) => Effect.Effect<void>;
}

export class CardRows extends Context.Service<CardRows, CardRowsApi>()("collie/CardRows") {}

export const cardRowsLayer = Layer.effect(CardRows)(
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    return {
      all: sql<Stored>`SELECT task, view, digest, due, at FROM collie_cards`.pipe(
        Effect.map(
          Arr.flatMap((row): ReadonlyArray<CardRow> => {
            const view = row.view === null ? Option.some(null) : decodeView(row.view);
            return Option.isNone(view)
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
                  for (const row of put)
                    yield* sql`
                      INSERT INTO collie_cards (task, view, digest, due, at)
                      VALUES (${row.task}, ${row.view === null ? null : encodeView(row.view)},
                        ${row.digest}, ${Number.isFinite(row.due) ? row.due : null}, ${row.at})
                      ON CONFLICT (task) DO UPDATE SET view = excluded.view,
                        digest = excluded.digest, due = excluded.due, at = excluded.at
                    `;
                  for (const chunk of Arr.chunksOf(drop, 500))
                    yield* sql`DELETE FROM collie_cards WHERE task IN ${sql.in(chunk)}`;
                }),
              )
              .pipe(Effect.orDie),
    } satisfies CardRowsApi;
  }),
);

// What the forge syncer (the Merge watch) last read of each merge request, as rows in the
// host's database (ADR-draft-the-board-is-a-projection-of-facts-the-host-syncs). A card reads
// these rows; only the syncer, and an action taken now, asks the forge.

import * as Arr from "effect/Array";
import * as Rec from "effect/Record";
import { Context, Effect, FileSystem, Layer, Option, Path, Result, Schema, flow } from "effect";
import * as Reactivity from "effect/reactivity/Reactivity";
import * as SqlClient from "effect/sql/SqlClient";
import { ForgeChecks, Mergeability } from "./board-model";
import { epochMs } from "./time";

/** Where an older host kept these answers; read once, and left for a downgrade. */
export const MR_STATES_FILE = "board/mr-states.json";

const StateSchema = Schema.Literals(["open", "merged", "closed", "on-stage", "in-prod"]);
export const MrEntry = Schema.Struct({
  state: Schema.optionalKey(StateSchema),
  checks: Schema.optionalKey(ForgeChecks),
  head: Schema.optionalKey(Schema.NullOr(Schema.String)),
  draft: Schema.optionalKey(Schema.Boolean),
  mergeable: Schema.optionalKey(Mergeability),
  source: Schema.optionalKey(Schema.String),
  target: Schema.optionalKey(Schema.String),
  /** Who opened it, which says whose a fix of its review findings is. */
  author: Schema.optionalKey(Schema.String),
  /** Its approvals, phrased as the forge's panel phrases them. */
  approvals: Schema.optionalKey(Schema.String),
  /** Whether a discussion on it is still unresolved. */
  unresolved: Schema.optionalKey(Schema.Boolean),
  read: Schema.optionalKey(Schema.String),
  asked: Schema.optionalKey(Schema.String),
});
export type MrEntry = typeof MrEntry.Type;

const EntryJson = Schema.fromJsonString(MrEntry);
const encodeEntry = flow(Schema.encodeResult(EntryJson), Result.getOrThrow);
const decodeEntry = Schema.decodeUnknownOption(EntryJson);
const StatesJson = Schema.fromJsonString(Schema.Record(Schema.String, MrEntry));
/** The shape written before checks were kept: a bare state per merge request. */
const OldStatesJson = Schema.fromJsonString(Schema.Record(Schema.String, StateSchema));

/** The newer answer of two, keeping the later time it was asked. */
export const newerEntry = (known: MrEntry | undefined, incoming: MrEntry): MrEntry => {
  const read = epochMs(known?.read ?? "") || -Infinity;
  const next = epochMs(incoming.read ?? "") || -Infinity;
  const kept = read > next ? known! : incoming;
  const asked =
    (epochMs(known?.asked ?? "") || 0) > (epochMs(incoming.asked ?? "") || 0)
      ? known?.asked
      : (incoming.asked ?? known?.asked);
  return asked === undefined ? kept : { ...kept, asked };
};

/** Who the forge says Collie is, on one forge host, and when it said. */
export interface ForgeLogin {
  readonly login: string | null;
  readonly read: number;
}

export interface MergeRequestsApi {
  /** Every merge request's last answer, by MR id. */
  readonly entries: Effect.Effect<ReadonlyMap<string, MrEntry>>;
  /** Each answer over the one kept, the newer read standing (`newerEntry`). */
  readonly merge: (entries: ReadonlyMap<string, MrEntry>) => Effect.Effect<void>;
  readonly login: (host: string) => Effect.Effect<ForgeLogin | null>;
  readonly putLogin: (host: string, login: ForgeLogin) => Effect.Effect<void>;
}

export class MergeRequests extends Context.Service<MergeRequests, MergeRequestsApi>()(
  "collie/MergeRequests",
) {}

/** What a write to the merge requests invalidates. */
export const MERGE_REQUESTS = "collie/merge-requests";

export const mergeRequestsLayer = Layer.effect(MergeRequests)(
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const reactivity = yield* Reactivity.Reactivity;
    const rows = sql<{ readonly id: string; readonly entry: string }>`
      SELECT id, entry FROM collie_merge_requests
    `;
    const decoded = (found: ReadonlyArray<{ readonly id: string; readonly entry: string }>) =>
      new Map(
        Arr.flatMap(found, (row) =>
          Option.match(decodeEntry(row.entry), {
            onNone: () => [],
            onSome: (entry) => [[row.id, entry] as const],
          }),
        ),
      );
    return {
      entries: rows.pipe(Effect.map(decoded), Effect.orDie),
      merge: (entries) =>
        entries.size === 0
          ? Effect.void
          : sql
              .withTransaction(
                Effect.gen(function* () {
                  const ids = [...entries.keys()];
                  const known = new Map<string, MrEntry>();
                  for (const chunk of Arr.chunksOf(ids, 500)) {
                    for (const [id, entry] of decoded(
                      yield* sql<{ readonly id: string; readonly entry: string }>`
                        SELECT id, entry FROM collie_merge_requests WHERE id IN ${sql.in(chunk)}
                      `,
                    ))
                      known.set(id, entry);
                  }
                  for (const [id, entry] of entries) {
                    yield* sql`
                      INSERT INTO collie_merge_requests (id, entry)
                      VALUES (${id}, ${encodeEntry(newerEntry(known.get(id), entry))})
                      ON CONFLICT (id) DO UPDATE SET entry = excluded.entry
                    `;
                  }
                }),
              )
              .pipe(Effect.andThen(reactivity.invalidate([MERGE_REQUESTS])), Effect.orDie),
      login: (host) =>
        sql<{ readonly login: string | null; readonly read: number }>`
          SELECT login, read FROM collie_forge_logins WHERE host = ${host}
        `.pipe(
          Effect.map((found) => found[0] ?? null),
          Effect.orDie,
        ),
      putLogin: (host, { login, read }) =>
        sql`
          INSERT INTO collie_forge_logins (host, login, read) VALUES (${host}, ${login}, ${read})
          ON CONFLICT (host) DO UPDATE SET login = excluded.login, read = excluded.read
        `.pipe(Effect.orDie),
    } satisfies MergeRequestsApi;
  }),
);

/** The answers an older host kept in `board/mr-states.json`, read once into the table. */
export const importMrStates = Effect.fn("RecordsImport.mrStates")(function* (stateDir: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const sql = yield* SqlClient.SqlClient;
  const text = yield* fs
    .readFileString(path.join(stateDir, MR_STATES_FILE))
    .pipe(Effect.orElseSucceed(() => "{}"));
  const entries: Readonly<Record<string, MrEntry>> = Option.getOrElse(
    Option.orElse(
      Schema.decodeOption(StatesJson)(text),
      (): Option.Option<Readonly<Record<string, MrEntry>>> =>
        Option.map(
          Schema.decodeOption(OldStatesJson)(text),
          Rec.map((state) => ({ state })),
        ),
    ),
    () => ({}),
  );
  for (const [id, entry] of Rec.toEntries(entries)) {
    yield* sql`INSERT OR REPLACE INTO collie_merge_requests (id, entry) VALUES (${id}, ${encodeEntry(entry)})`;
  }
});

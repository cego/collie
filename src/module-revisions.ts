// The revision of each workflow directory as the host last computed it, as rows in its
// database (ADR-draft-the-board-is-a-projection-of-facts-the-host-syncs). A listing's offers
// read the row; a Run's start, an offer taken and the workflow commands compute it afresh,
// and the backstop poll catches an edit made in an editor.

import * as Arr from "effect/Array";
import { Context, Effect, Layer } from "effect";
import * as Reactivity from "effect/reactivity/Reactivity";
import * as SqlClient from "effect/sql/SqlClient";

export interface ModuleRevisionsApi {
  /** Every directory's revision, by its path. */
  readonly all: Effect.Effect<ReadonlyMap<string, string>>;
  /** One directory's, or null where it was never computed. */
  readonly of: (dir: string) => Effect.Effect<string | null>;
  /** Records the revision computed now; a write that moves nothing invalidates nothing. */
  readonly put: (dir: string, revision: string) => Effect.Effect<void>;
}

export class ModuleRevisions extends Context.Service<ModuleRevisions, ModuleRevisionsApi>()(
  "collie/ModuleRevisions",
) {}

/**
 * The rows a discovery keeps its revisions in, where a host keeps them; `synced` where it
 * reads the kept revision rather than computing one, as a listing does.
 */
export const RevisionRows = Context.Reference<{
  readonly rows: ModuleRevisionsApi;
  readonly synced: boolean;
} | null>("collie/RevisionRows", { defaultValue: () => null });

/** Runs `read` on the kept revisions, where a host keeps any. */
export const onSyncedRevisions = <A, E, R>(read: Effect.Effect<A, E, R>) =>
  Effect.updateService(read, RevisionRows, (kept) =>
    kept === null ? null : { ...kept, synced: true },
  );

/** What a moved revision invalidates. */
export const MODULE_REVISIONS = "collie/module-revisions";

export const moduleRevisionsLayer = Layer.effect(ModuleRevisions)(
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const reactivity = yield* Reactivity.Reactivity;
    return {
      all: sql<{ readonly dir: string; readonly revision: string }>`
        SELECT dir, revision FROM collie_module_revisions
      `.pipe(
        Effect.map((rows) => new Map(Arr.map(rows, (row) => [row.dir, row.revision] as const))),
        Effect.orDie,
      ),
      of: (dir) =>
        sql<{ readonly revision: string }>`
          SELECT revision FROM collie_module_revisions WHERE dir = ${dir}
        `.pipe(
          Effect.map((found) => found[0]?.revision ?? null),
          Effect.orDie,
        ),
      put: (dir, revision) =>
        sql<{ readonly revision: string }>`
          SELECT revision FROM collie_module_revisions WHERE dir = ${dir}
        `.pipe(
          Effect.flatMap((found) =>
            found[0]?.revision === revision
              ? Effect.void
              : sql`
                  INSERT INTO collie_module_revisions (dir, revision) VALUES (${dir}, ${revision})
                  ON CONFLICT (dir) DO UPDATE SET revision = excluded.revision
                `.pipe(Effect.andThen(reactivity.invalidate([MODULE_REVISIONS]))),
          ),
          Effect.orDie,
        ),
    } satisfies ModuleRevisionsApi;
  }),
);

import { Effect, Schema, Struct } from "effect";

export const WorktreeRecordSchema = Schema.Struct({
  path: Schema.String,
  branch: Schema.String,
  created_by_collie: Schema.Boolean,
  created_branch: Schema.Boolean.pipe(Schema.withDecodingDefaultKey(Effect.succeed(false))),
  created_on: Schema.NullOr(Schema.String).pipe(
    Schema.withDecodingDefaultKey(Effect.succeed(null)),
  ),
  managed_by: Schema.Literals(["git", "herdr"]).pipe(
    Schema.withDecodingDefaultKey(Effect.succeed("herdr" as const)),
  ),
  workspace_id: Schema.NullOr(Schema.String),
  // WARNING: a record without made_at is never a prune candidate: a path and a branch do not prove Collie made the checkout.
  made_at: Schema.NullOr(Schema.Finite).pipe(Schema.withDecodingDefaultKey(Effect.succeed(null))),
  root_tab_id: Schema.NullOr(Schema.String).pipe(
    Schema.withDecodingDefaultKey(Effect.succeed(null)),
  ),
  root_pane_id: Schema.NullOr(Schema.String).pipe(
    Schema.withDecodingDefaultKey(Effect.succeed(null)),
  ),
}).mapFields(Struct.map(Schema.mutableKey));
export type WorktreeRecord = Schema.Schema.Type<typeof WorktreeRecordSchema>;

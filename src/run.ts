// The checkout Collie made for a Run: what says it may take it away again.

import { Effect, Schema, Struct } from "effect";

/**
 * The checkout a mutating Run owns, keyed by its branch. `created_by_collie` is what
 * makes a worktree a candidate for pruning: a checkout a human made is never touched.
 */
export const WorktreeRecordSchema = Schema.Struct({
  path: Schema.String,
  branch: Schema.String,
  created_by_collie: Schema.Boolean,
  /**
   * Who made this checkout, and so who takes it away again: Collie with git itself,
   * or herdr as a workspace of its own. A record written before this existed is
   * `herdr`, which is what every checkout was then.
   */
  managed_by: Schema.Literals(["git", "herdr"]).pipe(
    Schema.withDecodingDefaultKey(Effect.succeed("herdr" as const)),
  ),
  /** The workspace herdr opened on it, which is what removing it names. */
  workspace_id: Schema.NullOr(Schema.String),
  /**
   * When git wrote this checkout's `.git` file, as milliseconds. It is what says the
   * checkout at that path is still the one Collie made: a path and a branch are not
   * provenance, because a human can make a worktree at a path Collie's used to be at,
   * on the same branch, and pruning must never touch a checkout it did not create. A
   * record without it — one written before this was kept — is never a candidate.
   */
  made_at: Schema.NullOr(Schema.Number).pipe(Schema.withDecodingDefaultKey(Effect.succeed(null))),
  /**
   * The shell tab and pane herdr's new workspace came with, which this Run's first
   * agent takes over rather than leaving behind. Both null for a checkout that was
   * opened rather than created, and for a record written before they were kept.
   */
  root_tab_id: Schema.NullOr(Schema.String).pipe(
    Schema.withDecodingDefaultKey(Effect.succeed(null)),
  ),
  root_pane_id: Schema.NullOr(Schema.String).pipe(
    Schema.withDecodingDefaultKey(Effect.succeed(null)),
  ),
}).mapFields(Struct.map(Schema.mutableKey));
export type WorktreeRecord = Schema.Schema.Type<typeof WorktreeRecordSchema>;

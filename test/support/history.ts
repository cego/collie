// What an older Collie left in a state directory: a Run's own directory and the
// `run.json` that version wrote, for the importer and whatever reads its rows.

import { Effect, FileSystem, Path, Schema } from "effect";

/** A record as some version of Collie wrote it, encoded the way that version encoded it. */
const asText = Schema.encodeSync(Schema.fromJsonString(Schema.Json, { space: 2 }));

/** An old Run as an installation has it: a directory and the JSON that version wrote. */
export const oldRun = Effect.fn("test.oldRun")(function* (
  stateDir: string,
  id: string,
  record: Schema.Json,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const dir = path.join(stateDir, "runs", id);
  yield* fs.makeDirectory(dir, { recursive: true });
  yield* fs.writeFileString(path.join(dir, "run.json"), `${asText(record)}\n`);
  return dir;
});

/** The shape every version of the record has had, with the fields a test varies. */
export const oldRecord = (id: string, over: Record<string, Schema.Json> = {}) => ({
  id,
  seq: 1,
  slug: "implement-picker",
  workflow: "implement",
  cwd: "/work/app",
  session: null,
  workspace: "w1",
  workspace_label: "picker",
  workspace_worktree: null,
  created_at: "2026-09-01T10:00:00Z",
  finished_at: "2026-09-01T11:00:00Z",
  status: "done",
  iteration: 1,
  max_iterations: 3,
  inputs: { plan: "ENG-1", branch: "mk/picker" },
  input_sources: { plan: "explicit", branch: "inferred" },
  steps: [{ id: "build", status: "done", iteration: 1, note: null, variants: [] }],
  parent: null,
  target_label: null,
  synthesis: null,
  mr_url: null,
  linear_issues: [],
  summary: null,
  ...over,
});

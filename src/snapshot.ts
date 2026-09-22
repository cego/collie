// The workflow a Run is actually running, frozen in the Run's own directory.
//
// Without this a Driver re-resolves the workflow from the *current* layers every time it
// starts (`driveFlow`), so editing `workflows/implement.md` changes what a Run started
// yesterday does on resume — or crashes it, because `Run.step(id)` throws for a step id
// the record does not have. A Run is a piece of work someone authorised, not a live
// subscription to whatever the files say now.
//
// What is frozen is the **resolved** workflow — after `extends:` and after `use:` —
// because that is what the engine executes: rebased step ids, merged variant settings,
// and each step's prompt text as it was resolved. Re-emitting Markdown and parsing it
// back would re-resolve against today's layers, which is the exact thing being prevented,
// so the snapshot is the resolved structure itself, encoded as JSON.
//
// The snapshot is a copy inside the run directory. Nothing under the user's or the
// project's config is ever written.

import { Data, Effect, FileSystem, Path, Schema } from "effect";
import { contentHash, type ResolvedWorkflow } from "./definitions";
import { NEEDS_NAMES, SOURCE_NAMES } from "./offers";

/**
 * Absent, or present and undefined. `expand` builds a resolved step by spreading and
 * then assigning every inherited field — `harness: step.harness ?? child.harness` — so a
 * step that names no harness carries the *key* with an undefined value. A schema that
 * only allowed the key to be missing would refuse to freeze the workflows we ship.
 */
const opt = <S extends Schema.Top>(schema: S) => Schema.optionalKey(Schema.UndefinedOr(schema));

const VariantSchema = Schema.Struct({
  harness: Schema.String,
  model: Schema.String,
  effort: opt(Schema.String),
  permissions: opt(Schema.String),
});

const RoundSchema = Schema.Struct({
  section: Schema.String,
  prompt: Schema.String,
  agent: opt(Schema.String),
  skill: opt(Schema.String),
  persona: opt(Schema.String),
  harness: opt(Schema.String),
  model: opt(Schema.String),
  effort: opt(Schema.String),
  permissions: opt(Schema.String),
  fresh: opt(Schema.Boolean),
  output: opt(Schema.String),
});

const ChoiceSchema = Schema.Struct({
  title: Schema.String,
  run: opt(Schema.String),
  round: opt(RoundSchema),
  stop: opt(Schema.Boolean),
  post: opt(Schema.Boolean),
  handoff: opt(Schema.String),
  unless: opt(Schema.String),
  requires: opt(Schema.Array(Schema.String)),
  inputs: opt(Schema.Record(Schema.String, Schema.String)),
  max: opt(Schema.Number),
  config: opt(Schema.Struct({ key: Schema.String, question: Schema.String })),
  followUp: opt(RoundSchema),
});

const StepSchema = Schema.Struct({
  id: Schema.String,
  summary: opt(Schema.String),
  origin: Schema.String,
  prompt: Schema.String,
  preamble: Schema.String,
  known: Schema.Array(Schema.String),
  persona: opt(Schema.String),
  harness: opt(Schema.String),
  model: opt(Schema.String),
  effort: opt(Schema.String),
  permissions: opt(Schema.String),
  fresh: opt(Schema.Boolean),
  output: opt(Schema.String),
  agent: opt(Schema.String),
  skill: opt(Schema.String),
  parallel: opt(Schema.Array(VariantSchema)),
  use: opt(Schema.String),
  promptSection: opt(Schema.String),
  choices: opt(Schema.Array(ChoiceSchema)),
  standalone: opt(Schema.Boolean),
  requires: opt(Schema.Array(Schema.String)),
  // Without this a frozen Run lost every `waits: helle` and merged unclaimed.
  waits: opt(Schema.Array(Schema.String)),
  fanIn: opt(Schema.String),
  each: opt(Schema.String),
  repeat: opt(
    Schema.Struct({
      from: Schema.String,
      back_to: opt(Schema.String),
      max: opt(Schema.Number),
      converge: opt(Schema.Boolean),
    }),
  ),
});

const WorkflowSchema = Schema.Struct({
  name: Schema.String,
  // Optional only for snapshots written before they were kept; every new one has them.
  base: opt(Schema.String),
  checkout: opt(Schema.String),
  title: Schema.String,
  description: Schema.String,
  inputs: Schema.Record(Schema.String, Schema.String),
  embeddedInputs: Schema.Array(Schema.String),
  // What this Workflow always proves, where it proves one. Null for the Workflows whose
  // outcome a human chooses, and for a snapshot written before it was declared.
  outcome: Schema.NullOr(Schema.String).pipe(Schema.withDecodingDefaultKey(Effect.succeed(null))),
  maxIterations: Schema.Number,
  // Frozen with the rest of the definition: what a Run offers when it ends is decided
  // from current code, but a Run resumed from a snapshot must still decode.
  offers: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      title: Schema.String,
      workflow: Schema.String,
      kind: Schema.Literals(["action", "follow-up"]),
      needs: Schema.Array(Schema.Literals(NEEDS_NAMES)),
      inputs: Schema.Record(Schema.String, Schema.Literals(SOURCE_NAMES)),
    }),
  ).pipe(Schema.withDecodingDefaultKey(Effect.succeed([]))),
  steps: Schema.Array(StepSchema),
  layer: Schema.Literals(["baseline", "user", "project"]),
  path: Schema.String,
});

const WorkflowJson = Schema.fromJsonString(WorkflowSchema);

export class SnapshotUnreadable extends Data.TaggedError("SnapshotUnreadable")<{
  file: string;
  why: string;
}> {
  override get message() {
    return `the frozen definition at ${this.file} could not be read: ${this.why}`;
  }
}

/** Where a Run keeps the definition it is running, relative to the run directory. */
export const snapshotFile = (name: string) => `workflow/${name}.json`;

/**
 * The `definition` a Run records: enough to say what it is running, where that came
 * from, and whether two Runs are running the same thing. The hash is over the encoded
 * snapshot, so a user-layer override and the baseline hash differently even when their
 * step ids match — which is the case a step-id comparison cannot see.
 */
export interface Definition {
  hash: string;
  layer: "baseline" | "user" | "project";
  path: string;
  snapshot: string;
}

/**
 * Freezes the resolved workflow into the run directory and returns what to record.
 * Called once, where the Run is created; a Run never re-snapshots, because a definition
 * that can be rewritten is not frozen.
 */
export const writeSnapshot = Effect.fn("Snapshot.write")(function* (
  runDir: string,
  wf: ResolvedWorkflow,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const encoded = Schema.encodeSync(WorkflowJson)(wf);
  const relative = snapshotFile(wf.name);
  const file = path.join(runDir, relative);
  yield* fs.makeDirectory(path.dirname(file), { recursive: true }).pipe(Effect.orDie);
  yield* fs.writeFileString(file, `${encoded}\n`).pipe(Effect.orDie);
  return {
    hash: yield* contentHash(encoded),
    layer: wf.layer,
    path: wf.path,
    snapshot: relative,
  };
});

/**
 * The frozen definition, or null where there is none to read. Null is the legacy Run:
 * it resolves from the layers as it always did, under the step-id guard its callers
 * apply. A snapshot that is there but unreadable is *not* null — a Run whose frozen
 * definition has been corrupted must not quietly fall back to today's files.
 */
export const readSnapshot = Effect.fn("Snapshot.read")(function* (
  runDir: string,
  definition: Definition | null,
) {
  if (definition === null) return null;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const file = path.join(runDir, definition.snapshot);
  const text = yield* fs.readFileString(file).pipe(Effect.catch(() => Effect.succeed(null)));
  if (text === null)
    return yield* new SnapshotUnreadable({ file, why: "it is not there any more" });
  return yield* Schema.decodeUnknownEffect(WorkflowJson)(text.trim()).pipe(
    // SAFETY: `WorkflowSchema` mirrors `ResolvedWorkflow` field for field; what decoding
    // guarantees is that every field is there and of the right type. The assertion only
    // drops the `readonly` the schema adds, which the engine mutates nothing of.
    Effect.map((wf) => wf as ResolvedWorkflow),
    Effect.mapError((cause) => new SnapshotUnreadable({ file, why: String(cause) })),
  );
});

/**
 * What a Run resolving from the layers must be checked against: the steps it recorded
 * against the steps the definition has now. Ids, in order — a step inserted, removed or
 * renamed changes what a resumed Driver does, and `Run.step(id)` throws outright for one
 * the record lacks.
 */
export function stepsDiffer(recorded: ReadonlyArray<string>, now: ReadonlyArray<string>): boolean {
  return recorded.length !== now.length || recorded.some((id, at) => id !== now[at]);
}

/** The differing ids, both ways round, for the message a refusal gives the human. */
export function stepDifference(
  recorded: ReadonlyArray<string>,
  now: ReadonlyArray<string>,
): string {
  const gone = recorded.filter((id) => !now.includes(id));
  const added = now.filter((id) => !recorded.includes(id));
  const parts: string[] = [];
  if (gone.length > 0) parts.push(`no longer has ${gone.join(", ")}`);
  if (added.length > 0) parts.push(`now has ${added.join(", ")}`);
  if (parts.length === 0) parts.push(`has the same steps in a different order`);
  return parts.join("; ");
}

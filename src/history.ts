// The work the old engine left in directories, read once into the rows every reader uses.
//
// Historical parsing lives here and nowhere else. A `run.json` was written by whichever
// version was installed at the time, so the shape below is deliberately forgiving: every
// field a later version added reads as absent rather than as a broken record. That
// tolerance is the whole reason this is one importer and not an adapter every reader
// carries — once a Run is a row, nothing asks a directory what it was again.
//
// What is kept is what stays true: the facts, where each value came from, and where the
// evidence still is. Not the steps — they were an account of an executor that no longer
// exists, and a row that described one would be an invitation to resume it. Imported work
// cannot run again; `docs/adr/0027-one-engine-and-history-is-imported-once.md` is why.

import { Effect, FileSystem, Path, Schema } from "effect";
import { currentPid, processStartTime, signalProcess } from "./lock";
import { Store } from "./store";

/** The claim an old Driver wrote while it owned a Run. Read, never written. */
export interface OwnerRecord {
  readonly pid: number;
  readonly start: string | null;
  readonly at: string;
}

const OwnerRecordJson = Schema.fromJsonString(
  Schema.Struct({
    pid: Schema.Number,
    start: Schema.NullOr(Schema.String),
    at: Schema.String,
  }),
);

/**
 * Whether something still owns a Run: `live`, conclusively `none`, or `unknown`. The
 * third is the one that matters here — a claim whose identity cannot be read may be a
 * working installation, and "I could not tell" is never permission to take its work.
 */
export type Ownership = "live" | "none" | "unknown";

/** The same three-way answer as a pure decision, so each branch is a test. */
export function ownershipFrom(
  claim: OwnerRecord | null,
  signalled: boolean,
  start: string | null,
): Ownership {
  if (!claim) return "none";
  if (!signalled) return "none";
  // A claim written without a start time is all the identity there is, and it is read
  // as alive rather than as doubt about a process that is answering.
  if (claim.start === null) return "live";
  // The pid answers but its identity cannot be read: it may be that owner or it may be
  // whatever reused the number. Neither is something to act on.
  if (start === null) return "unknown";
  return start === claim.start ? "live" : "none";
}

export const CLAIM_FILE = "runner.pid";

const readOwner = Effect.fn("history.readOwner")(function* (dir: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const raw = yield* fs
    .readFileString(path.join(dir, CLAIM_FILE))
    .pipe(Effect.catch(() => Effect.succeed(null)));
  if (raw === null) return null;
  const claim = yield* Schema.decodeUnknownEffect(OwnerRecordJson)(raw).pipe(
    Effect.catch(() => Effect.succeed(null)),
  );
  return claim && claim.pid > 0 ? claim : null;
});

/** Whether this Run has a claim file at all, readable or not. */
const claimExists = Effect.fn("history.claimExists")(function* (dir: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  // An unreadable directory is not evidence of an unclaimed Run either.
  return yield* fs
    .exists(path.join(dir, CLAIM_FILE))
    .pipe(Effect.catch(() => Effect.succeed(true)));
});

/**
 * Who owns this Run, from the evidence the old installation left. The one probe of a
 * claim: does that pid answer, and is it still the process that wrote it. The start time
 * is read only where the claim carries one to compare against, because on a system with
 * no `/proc` reading it means spawning `ps`.
 */
export const ownerOf = Effect.fn("history.ownerOf")(function* (dir: string) {
  const claim = yield* readOwner(dir);
  // A missing claim and an unreadable one both decode to null, and only the missing one
  // is conclusive: a truncated claim file was written by something that may still be
  // working, so it is `unknown` and its Run is left where it is.
  if (!claim) {
    const answer: Ownership = (yield* claimExists(dir)) ? "unknown" : "none";
    return answer;
  }
  const signalled = yield* signalProcess(claim.pid);
  const start = signalled && claim.start !== null ? yield* processStartTime(claim.pid) : null;
  // A record this process itself wrote is still this process's, and importing under it
  // would be the one case where an owner reads its own claim as somebody else's.
  const mine: Ownership = "live";
  if (claim.pid === (yield* currentPid)) return mine;
  return ownershipFrom(claim, signalled, start);
});

const absent = <S extends Schema.Top>(schema: S, fallback: S["Type"]) =>
  schema.pipe(Schema.withDecodingDefaultKey(Effect.succeed(fallback)));

const Text = Schema.Record(Schema.String, Schema.String);

/**
 * A recorded Run as the importer needs it, and no more. Everything a later version
 * added is optional here, because an installation being upgraded has records from every
 * version it ever ran — and a field one of them did not keep is not a broken record.
 */
const Recorded = Schema.Struct({
  id: Schema.String,
  workflow: Schema.String,
  cwd: Schema.String,
  status: Schema.String,
  created_at: Schema.String,
  finished_at: absent(Schema.NullOr(Schema.String), null),
  task: absent(Schema.NullOr(Schema.String), null),
  parent: absent(Schema.NullOr(Schema.String), null),
  inputs: absent(Text, {}),
  input_sources: absent(Text, {}),
  input_strategies: absent(Text, {}),
  definition: absent(
    Schema.NullOr(
      Schema.Struct({
        hash: Schema.String,
        layer: Schema.String,
        path: Schema.String,
      }),
    ),
    null,
  ),
  outcome: absent(Schema.NullOr(Schema.String), null),
  mr_url: absent(Schema.NullOr(Schema.String), null),
  linear_issues: absent(Schema.Array(Schema.String), []),
  synthesis: absent(Schema.NullOr(Schema.String), null),
  summary: absent(Schema.NullOr(Schema.String), null),
});
const RecordedJson = Schema.fromJsonString(Recorded);

/** What became of a Run, from its own record rather than from the label it stopped on. */
export function fateOf(record: { readonly status: string }): string {
  // Nothing is importing a Run anything still owns, so `running` is a Run whose engine
  // went away mid-step. Recording it as running would be a row that never ends.
  return record.status === "running" ? "interrupted" : record.status;
}

/** What one Run's directory turned into. Nothing here changes a file. */
export const Kept = Schema.Struct({
  run: Schema.String,
  kind: Schema.Literals(["imported", "already", "held", "malformed"]),
  /** What still owns it, where something does; null where nothing does. */
  owner: Schema.NullOr(Schema.Literals(["live", "unknown"])),
  /** Why it was not imported; empty where it was. */
  detail: Schema.String,
});
export type Kept = typeof Kept.Type;

/** What a report says out loud, in the words every front door uses for it. */
export function describeKept(kept: Kept): string {
  switch (kept.kind) {
    case "imported":
      return `${kept.run}: imported`;
    case "already":
      return `${kept.run}: already imported`;
    case "held":
      return kept.owner === "live"
        ? `${kept.run}: something is still running it; it imports once that finishes or is stopped`
        : `${kept.run}: its claim could not be read, so it may still be running; it imports once that claim is gone`;
    case "malformed":
      return `${kept.run}: not imported — ${kept.detail}`;
  }
}

const RUN_FILE = "run.json";

/** What a Run nobody classified had to prove: nothing in particular, said out loud. */
const UNCLASSIFIED = "unspecified";

/**
 * Every old Run in this state directory, read into rows. Idempotent by Run identity: a
 * second import keeps nothing and says so, which is what makes this safe to wire into
 * every install and upgrade.
 *
 * Nothing is written to a run directory, and no process is signalled beyond asking
 * whether a pid answers. An installation still working is left entirely alone.
 */
export const importHistory = Effect.fn("history.import")(function* (stateDir: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const store = yield* Store;
  const root = path.join(stateDir, "runs");
  if (!(yield* fs.exists(root).pipe(Effect.catch(() => Effect.succeed(false))))) return [];
  const names = yield* fs.readDirectory(root).pipe(Effect.catch(() => Effect.succeed([])));
  const reports: Kept[] = [];
  for (const name of [...names].sort()) {
    if (name.startsWith(".")) continue;
    const dir = path.join(root, name);
    const file = path.join(dir, RUN_FILE);
    if (!(yield* fs.exists(file).pipe(Effect.catch(() => Effect.succeed(false))))) continue;
    // Ownership before the record: a Run something is still working on is not read at
    // all, so an import can never race a write of the file it is reading.
    const owner = yield* ownerOf(dir);
    if (owner !== "none") {
      reports.push({ run: name, kind: "held", owner, detail: "" });
      continue;
    }
    const raw = yield* fs.readFileString(file).pipe(
      Effect.map((text) => ({ ok: true as const, text })),
      Effect.catch((cause) => Effect.succeed({ ok: false as const, text: String(cause) })),
    );
    if (!raw.ok) {
      reports.push({
        run: name,
        kind: "malformed",
        owner: null,
        detail: `${RUN_FILE} could not be read`,
      });
      continue;
    }
    const decoded = yield* Schema.decodeUnknownEffect(RecordedJson)(raw.text).pipe(
      Effect.catch(() => Effect.succeed(null)),
    );
    if (decoded === null) {
      // Reported and left exactly where it is: a record nobody can decode is still the
      // only copy of that work, and rewriting it to fit is how history is lost.
      reports.push({
        run: name,
        kind: "malformed",
        owner: null,
        detail: `${RUN_FILE} is not a Run record`,
      });
      continue;
    }
    const kept = yield* store.keep({
      run: decoded.id,
      workflow: decoded.workflow,
      project: decoded.cwd,
      status: fateOf(decoded),
      outcome: decoded.outcome ?? UNCLASSIFIED,
      created: decoded.created_at,
      finished: decoded.finished_at,
      task: decoded.task,
      parent: decoded.parent,
      inputs: decoded.inputs,
      provenance: {
        sources: decoded.input_sources,
        strategies: decoded.input_strategies,
        // The definition it was frozen against, as the fact that it was: a path and a
        // hash nobody resolves again, not a workflow to rebuild.
        definition: decoded.definition,
      },
      evidence: {
        // The directory is the reference: its cards, verifications, drift and outputs
        // are files by design and stay exactly where they were written.
        dir,
        mr: decoded.mr_url,
        linear: [...decoded.linear_issues],
        review: decoded.synthesis === null ? null : path.join(dir, decoded.synthesis),
      },
      summary: decoded.summary,
    });
    reports.push({ run: decoded.id, kind: kept ? "imported" : "already", owner: null, detail: "" });
  }
  return reports;
});

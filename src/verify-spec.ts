// Which commands Collie may run itself for this Run, and where that list comes from.
//
// A verification Collie collects is the only kind a gate will accept, so the list of what
// it may run is a permission — and a permission read from the repository would be one the
// repository granted itself. It comes from a file a human wrote, in the project or in
// their own config, and it is copied into `run.json` when the Run starts. Editing the file
// afterwards changes the next Run, never a live one.

import { Data, Effect, FileSystem, Path, Schema } from "effect";

/**
 * Exactly what Collie may run for a verification, bound argument by argument: the wrapper
 * is part of what was approved, so `npm test` and `npm test -- --bail` are not the same
 * permission, and nothing here is a shell string.
 */
export const VerifySpecSchema = Schema.Struct({
  name: Schema.String,
  executable: Schema.String,
  argv: Schema.Array(Schema.String),
  cwd: Schema.String,
});
export type VerifySpec = Schema.Schema.Type<typeof VerifySpecSchema>;

/** A file that is there and is not a list of verifications. Named, never read as empty. */
export class ApprovedUnreadable extends Data.TaggedError("ApprovedUnreadable")<{
  file: string;
  why: string;
}> {
  override get message() {
    return `${this.file} is not a list of verifications: ${this.why}`;
  }
}

/** What a layer's file holds: the specs, whole. A file is taken or refused, never merged. */
const ApprovedJson = Schema.fromJsonString(Schema.Array(VerifySpecSchema));

/** The project's own list, and then the user's. Relative to the Run's root. */
export const PROJECT_FILE = ".herdr/verify.json";
export const USER_FILE = "verify.json";

/**
 * The approved set for a Run starting here: the project's file if there is one, else the
 * user's, else nothing. First found wins **whole** — the two are not merged, because a
 * project that lists its own three commands has said what this repository's verifications
 * are, and quietly adding the user's global ones to them would run commands in a
 * repository neither file names together.
 *
 * A file that is there and does not decode is an error naming it, never an empty set: a
 * typo that silently approved nothing would make every Run's evidence gate unsatisfiable
 * for a reason nobody could see.
 */
export const approvedFrom = Effect.fn("VerifySpec.approvedFrom")(function* (layers: {
  readonly cwd: string;
  readonly configDir: string;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  for (const file of [
    path.join(layers.cwd, PROJECT_FILE),
    path.join(layers.configDir, USER_FILE),
  ]) {
    const text = yield* fs.readFileString(file).pipe(Effect.catch(() => Effect.succeed(null)));
    if (text === null) continue;
    const decoded = yield* Schema.decodeUnknownEffect(ApprovedJson)(text.trim()).pipe(
      Effect.result,
    );
    if (decoded._tag === "Failure")
      return yield* new ApprovedUnreadable({ file, why: String(decoded.failure) });
    return decoded.success.map((spec) => ({ ...spec, argv: [...spec.argv] }));
  }
  const none: VerifySpec[] = [];
  return none;
});

/**
 * The set this Run may actually run. The Intent's `run_verification` *is* the set: it is
 * seeded from the approved file at version 1 and amended only by `run intent
 * verification`, so an Intent that grants nothing is a Run that may run nothing — a human
 * removed the last entry, and the seed must not quietly put it back. The seeded copy on
 * the record is for a Run that has no Intent at all. Never written back from here.
 */
export function approvedFor(
  seeded: ReadonlyArray<VerifySpec>,
  intent: { readonly authority: { readonly run_verification: ReadonlyArray<VerifySpec> } } | null,
): ReadonlyArray<VerifySpec> {
  return intent === null ? seeded : intent.authority.run_verification;
}

/** The approved set as the commands a human would type, for a prompt to name them. */
export function renderApproved(approved: ReadonlyArray<VerifySpec>): string {
  if (approved.length === 0) return "(none approved for this Run)";
  return approved
    .map((spec) => `- ${spec.name}: ${[spec.executable, ...spec.argv].join(" ")} (in ${spec.cwd})`)
    .join("\n");
}

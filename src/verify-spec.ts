// Which commands Collie may run itself for this Run, and where that list comes from.
//
// A verification Collie collects is the only kind a gate will accept, so the list of what
// it may run is a permission. It comes from a file in the project or in the user's config,
// or with the start (`--verify`, or chat's `verify`), and it is copied into the Run's
// evidence when the Run starts; editing the file afterwards changes the next Run, never a
// live one. A running Run's list changes by `run intent verification`, or by chat's
// `set_verification`, which `collie_propose` carries out in the same call with no yes. So
// chat, reading the repository, can grant the repository what Collie itself runs: the
// human reads what ran in the merge request, before it lands (ADR-0011, 2026-09-29).

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

const decodeGiven = Schema.decodeUnknownResult(Schema.fromJsonString(VerifySpecSchema));

/** `--verify` values, each one verify.json entry as JSON; the first that is not one is named. */
export function givenVerifications(
  values: ReadonlyArray<string>,
):
  | { readonly ok: true; readonly specs: ReadonlyArray<VerifySpec> }
  | { readonly ok: false; readonly error: string } {
  const specs: VerifySpec[] = [];
  for (const value of values) {
    const decoded = decodeGiven(value);
    if (decoded._tag === "Failure")
      return {
        ok: false,
        error: `--verify ${value} is not a verification: ${String(decoded.failure)}`,
      };
    specs.push(decoded.success);
  }
  return { ok: true, specs };
}

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
export const PROJECT_FILE = ".collie/verify.json";
export const USER_FILE = "verify.json";
/**
 * A repository's own list in the user's config, by its remote: `verify/<host>/<path>.json`.
 * Null for a remote whose path would leave `verify/`.
 */
export const rememberedFile = (userDir: string, project: string): string | null =>
  project.split("/").some((part) => part === "" || part === "." || part === "..")
    ? null
    : `${userDir}/verify/${project}.json`;

/**
 * The approved set for a Run starting here: the project's file if there is one, else the
 * one remembered for its repository's remote, else the user's, else nothing. First found
 * wins **whole** — the layers are not merged, because a
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
  readonly userDir: string;
  readonly project?: string | null;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const remembered = layers.project ? rememberedFile(layers.userDir, layers.project) : null;
  const files = [
    path.join(layers.cwd, PROJECT_FILE),
    ...(remembered === null ? [] : [remembered]),
    path.join(layers.userDir, USER_FILE),
  ];
  for (const file of files) {
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

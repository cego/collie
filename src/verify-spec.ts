// A Run's checks: the commands Collie runs itself to prove it, and where they come from.
//
// A verification Collie collects is the only kind a gate will accept. The checks come
// from a file in the project or in the user's config, or with the start (`--verify`, or
// chat's `verify`), and are copied into the Run's evidence when the Run starts; editing
// the file afterwards changes the next Run, never a live one. Where none of those names
// any, the Run's own agent names them. Anyone — a human, chat or the agent — names or
// withdraws one on a live Run with `run intent verification` (chat's `set_verification`),
// and nobody approves them: the human reads what ran in the merge request, before it
// lands (ADR-0055).

import { Data, Effect, FileSystem, Path, Schema } from "effect";

/**
 * Exactly what Collie runs for a check, bound argument by argument: the wrapper is part
 * of the check, so `npm test` and `npm test -- --bail` are not the same one, and nothing
 * here is a shell string.
 */
export const VerifySpecSchema = Schema.Struct({
  name: Schema.String,
  executable: Schema.String,
  argv: Schema.Array(Schema.String),
  cwd: Schema.String,
  /** The merge request pipeline job that proves it: nobody runs it locally (ADR-draft-a-check-left-to-ci-is-proved-by-its-pipeline-job). */
  ci: Schema.optionalKey(Schema.String),
});
export type VerifySpec = Schema.Schema.Type<typeof VerifySpecSchema>;

const decodeGiven = Schema.decodeUnknownResult(Schema.fromJsonString(VerifySpecSchema));

const ApprovedJson = Schema.fromJsonString(Schema.Array(VerifySpecSchema));
const decodeApproved = Schema.decodeUnknownEffect(ApprovedJson);
export const encodeApproved = Schema.encodeSync(ApprovedJson);

/** Where a Run's checks are frozen, in its evidence directory. */
export const approvedFile = (evidenceDir: string) => `${evidenceDir}/approved.json`;

/** The checks a Run was started with, frozen in its evidence directory; none where unreadable. */
export const approvedIn = (evidenceDir: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    return yield* decodeApproved(yield* fs.readFileString(approvedFile(evidenceDir)));
  }).pipe(Effect.orElseSucceed((): ReadonlyArray<VerifySpec> => []));

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
export const encodeApprovedFile = Schema.encodeSync(
  Schema.fromJsonString(Schema.Array(VerifySpecSchema), { space: 2 }),
);

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
 * The checks for a Run starting here: the project's file if there is one, as the Run's
 * base has it where it has one, else the one remembered for its repository's remote, else
 * the user's, else nothing. First found wins **whole** — the layers are not merged, because a
 * project that lists its own three commands has said what this repository's verifications
 * are, and quietly adding the user's global ones to them would run commands in a
 * repository neither file names together.
 *
 * A file that is there and does not decode is an error naming it, never an empty set: a
 * typo that silently named nothing would hand the choice to an agent for a reason nobody
 * could see.
 */
export const approvedFrom = Effect.fn("VerifySpec.approvedFrom")(function* (layers: {
  readonly cwd: string;
  readonly userDir: string;
  readonly project?: string | null;
  /** The project's file as the Run's base ref has it, read instead of the working tree's. */
  readonly base?: { readonly ref: string; readonly text: string | null };
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const onDisk = (file: string) => ({
    file,
    text: fs.readFileString(file).pipe(Effect.catch(() => Effect.succeed(null))),
  });
  const remembered = layers.project ? rememberedFile(layers.userDir, layers.project) : null;
  const files = [
    layers.base === undefined
      ? onDisk(path.join(layers.cwd, PROJECT_FILE))
      : {
          file: `${path.join(layers.cwd, PROJECT_FILE)} at ${layers.base.ref}`,
          text: Effect.succeed(layers.base.text),
        },
    ...(remembered === null ? [] : [onDisk(remembered)]),
    onDisk(path.join(layers.userDir, USER_FILE)),
  ];
  for (const { file, text: reading } of files) {
    const text = yield* reading;
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
 * This Run's checks as they stand. The Intent's `run_verification` *is* the set: it is
 * seeded from the checks file at version 1 and amended only by `run intent
 * verification`, so an Intent with none is a Run with no checks — someone withdrew the
 * last entry, and the seed must not quietly put it back. The seeded copy on
 * the record is for a Run that has no Intent at all. Never written back from here.
 */
export function approvedFor(
  seeded: ReadonlyArray<VerifySpec>,
  intent: { readonly authority: { readonly run_verification: ReadonlyArray<VerifySpec> } } | null,
): ReadonlyArray<VerifySpec> {
  return intent === null ? seeded : intent.authority.run_verification;
}

/** A Run's checks as the commands a human would type, for a prompt to name them. */
export function renderApproved(approved: ReadonlyArray<VerifySpec>): string {
  if (approved.length === 0) return "(no check is named for this Run yet)";
  return approved
    .map((spec) =>
      spec.ci === undefined
        ? `- ${spec.name}: ${[spec.executable, ...spec.argv].join(" ")} (in ${spec.cwd})`
        : `- ${spec.name}: left to CI (job ${spec.ci}), do not run it`,
    )
    .join("\n");
}

const PACKAGE_MANAGERS = new Set(["bun", "npm", "pnpm", "yarn", "deno"]);

/**
 * What a check is called where nobody named it: the script a package manager runs, else
 * the manager and its subcommand, else the tool.
 */
export function checkNameOf(executable: string, argv: ReadonlyArray<string>): string {
  const tool = executable.split("/").at(-1) ?? executable;
  const passed = argv.indexOf("--");
  // A flag's value is a plain word too, so a script is the last one before `--`.
  const words = (passed === -1 ? argv : argv.slice(0, passed)).filter(
    (word) => !word.startsWith("-"),
  );
  const [first] = words;
  if (!PACKAGE_MANAGERS.has(tool) || first === undefined) return tool;
  const script = words.at(-1);
  if (first === "run" && words.length > 1 && script !== undefined) return script;
  return /^[\w:-]+$/.test(first) ? `${tool} ${first}` : tool;
}

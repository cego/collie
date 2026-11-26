import * as Str from "effect/String";
import * as Arr from "effect/Array";
import { pipe as pipe_ } from "effect/Function";
import { Data, Effect, FileSystem, Path, Schema, flow, Result } from "effect";
import { CommandLine } from "effect/process";
import { addressOf, RunRecords } from "./run-records";
import { PrepareSchema } from "./verify-model";

export const markRefused: (spec: {
  readonly ci?: string;
  readonly before_review?: boolean;
}) => string | undefined = (spec) =>
  spec.ci !== undefined && spec.before_review === true
    ? "a check left to CI cannot run before review: nobody runs it locally"
    : undefined;

// WARNING: argv is exact and whole: the wrapper is part of the check and nothing here is a shell string.
export const VerifySpecSchema = Schema.Struct({
  name: Schema.String,
  executable: Schema.String,
  argv: Schema.Array(Schema.String),
  cwd: Schema.String,
  // WARNING: a ci check is proved by its pipeline job; nobody runs it locally.
  ci: Schema.optionalKey(Schema.String),
  // WARNING: a detached checkout of its start tree, so edits in the Worktree cannot move it.
  isolated: Schema.optionalKey(Schema.Boolean),
  prepare: Schema.optionalKey(PrepareSchema),
  before_review: Schema.optionalKey(Schema.Boolean),
}).check(Schema.makeFilter(markRefused));
export type VerifySpec = Schema.Schema.Type<typeof VerifySpecSchema>;

const decodeGiven = Schema.decodeUnknownResult(Schema.fromJsonString(VerifySpecSchema));

const ApprovedJson = Schema.fromJsonString(Schema.Array(VerifySpecSchema));
const decodeApproved = Schema.decodeUnknownEffect(ApprovedJson);
export const encodeApproved = flow(Schema.encodeResult(ApprovedJson), Result.getOrThrow);

const approvedAt = (evidenceDir: string) => {
  const { run, prefix } = addressOf(evidenceDir);
  return { run, name: `${prefix}approved.json` };
};
const decodeOrNone = (raw: string | null) =>
  raw === null
    ? Effect.succeed<ReadonlyArray<VerifySpec>>([])
    : decodeApproved(raw).pipe(Effect.orElseSucceed(() => []));

// WARNING: checks are frozen into the Run's evidence at start; editing the file changes only the next Run.
export const approvedIn = (evidenceDir: string) =>
  RunRecords.use((records) => {
    const at = approvedAt(evidenceDir);
    return records.fact(at.run, at.name);
  }).pipe(Effect.flatMap(decodeOrNone));

export const updateApproved = (
  evidenceDir: string,
  change: (frozen: ReadonlyArray<VerifySpec> | null) => ReadonlyArray<VerifySpec>,
) =>
  RunRecords.use((records) => {
    const at = approvedAt(evidenceDir);
    return records.update(at.run, at.name, (raw) =>
      Effect.map(decodeOrNone(raw), (frozen) =>
        encodeApproved(change(raw === null ? null : frozen)),
      ),
    );
  }).pipe(Effect.flatMap(decodeOrNone));

export function givenVerifications(values: ReadonlyArray<string>) {
  const specs: Array<VerifySpec> = [];
  for (const value of values) {
    const decoded = decodeGiven(value);
    if (decoded._tag === "Failure") {
      const returned:
        | { readonly ok: true; readonly specs: ReadonlyArray<VerifySpec> }
        | { readonly ok: false; readonly error: string } = {
        ok: false,
        error: `--verify ${value} is not a verification: ${String(decoded.failure)}`,
      };
      return returned;
    }
    specs.push(decoded.success);
  }
  const returned:
    | { readonly ok: true; readonly specs: ReadonlyArray<VerifySpec> }
    | { readonly ok: false; readonly error: string } = { ok: true, specs };
  return returned;
}

export class ApprovedUnreadable extends Data.TaggedError("ApprovedUnreadable")<{
  file: string;
  why: string;
}> {
  override get message() {
    return `${this.file} is not a list of verifications: ${this.why}`;
  }
}

export const encodeApprovedFile = flow(
  Schema.encodeResult(Schema.fromJsonString(Schema.Array(VerifySpecSchema), { space: 2 })),
  Result.getOrThrow,
);

export const PROJECT_FILE = ".collie/verify.json";
export const USER_FILE = "verify.json";
// WARNING: a remote whose path would leave verify/ maps to null.
export const rememberedFile = (userDir: string, project: string) =>
  Arr.some(Str.split(project, "/"), (part) => part === "" || part === "." || part === "..")
    ? null
    : `${userDir}/verify/${project}.json`;

// WARNING: the first layer found wins whole and is never merged; an undecodable file is an error, never an empty set.
export const approvedFrom = Effect.fn("VerifySpec.approvedFrom")(function* (layers: {
  readonly cwd: string;
  readonly userDir: string;
  readonly project?: string | null;
  readonly base?: { readonly ref: string; readonly text: string | null };
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const onDisk = (file: string) => ({
    file,
    text: fs.readFileString(file).pipe(Effect.orElseSucceed(() => null)),
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
    if (text === null) {
      continue;
    }
    const decoded = yield* Schema.decodeEffect(ApprovedJson)(Str.trim(text)).pipe(Effect.result);
    if (decoded._tag === "Failure") {
      return yield* new ApprovedUnreadable({ file, why: String(decoded.failure) });
    }
    return Arr.map(decoded.success, (spec) => ({ ...spec, argv: [...spec.argv] }));
  }
  const none: Array<VerifySpec> = [];
  return none;
});

// WARNING: an Intent with no verification is a Run with no checks; the seeded copy must not refill it.
export function approvedFor(
  seeded: ReadonlyArray<VerifySpec>,
  intent: { readonly authority: { readonly run_verification: ReadonlyArray<VerifySpec> } } | null,
) {
  return intent === null ? seeded : intent.authority.run_verification;
}

export function renderApproved(approved: ReadonlyArray<VerifySpec>) {
  if (approved.length === 0) {
    return "(no check is named for this Run yet)";
  }
  return Arr.join(
    Arr.map(approved, (spec) =>
      spec.ci === undefined
        ? `- ${spec.name}: ${CommandLine.display([spec.executable, ...spec.argv])} (in ${spec.cwd})`
        : `- ${spec.name}: left to CI (job ${spec.ci}), do not run it`,
    ),
    "\n",
  );
}

const PACKAGE_MANAGERS = new Set(["bun", "npm", "pnpm", "yarn", "deno"]);

export function checkNameOf(executable: string, argv: ReadonlyArray<string>) {
  const tool = Str.split(executable, "/").at(-1) ?? executable;
  const passed = argv.indexOf("--");
  // WARNING: a flag's value is a plain word too, so the script is the last word before --.
  const words = Arr.filter(
    passed === -1 ? argv : argv.slice(0, passed),
    (word) => !pipe_(word, Str.startsWith("-")),
  );
  const [first] = words;
  if (!PACKAGE_MANAGERS.has(tool) || first === undefined) {
    return tool;
  }
  const script = words.at(-1);
  if (first === "run" && words.length > 1 && script !== undefined) {
    return script;
  }
  return /^[\w:-]+$/.test(first) ? `${tool} ${first}` : tool;
}

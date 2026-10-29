// An agent saying "the tests pass" is a claim. This is the other thing: a command whose
// exit Collie watched, bound to the exact tree it ran on.
//
// The binding is what makes it worth anything. A pass on a tree that changed while the
// command ran says nothing about either tree, so a verification whose start and end
// snapshots differ is `unstable` — never `pass`, and never quietly re-run.
//
// Nothing here goes through a shell. The command is an executable and an argument list,
// resolved once and recorded as an absolute path, so the check named is what ran.

import * as Str from "effect/String";
import { pipe } from "effect/Function";
import * as Option from "effect/Option";
import * as Arr from "effect/Array";
import { Data, Effect, FileSystem, Path, Schema, flow, Result } from "effect";
import type { ChildProcessSpawner } from "effect/process";
import { Stream } from "effect";
import { CheckProcesses } from "./check-processes";
import type { VerifySpec } from "./intent";
import { failedAlone, failedTests, ranAlone, rerunArgv } from "./bun-tests";
import { appendJournal, readJournal } from "./journal";
import { shell } from "./mr";
import { nowIso, epochMs } from "./time";
import { CurrentStep, type StepPlace } from "./steps";
import { Pass, VerificationSchema, type FailedTest, type Snapshot } from "./verify-model";

/** Over this many bytes of working-tree content, the tree is not fingerprinted at all. */
export const FINGERPRINT_MAX_BYTES = 50 * 1024 * 1024;

/** How much of each stream is kept: enough to see what failed, not a transcript. */
const TAIL_BYTES = 4 * 1024;

/** How much of a check's output its log keeps; what comes after is cut, and the log says so. */
export const LOG_BYTES = 8 * 1024 * 1024;

/**
 * A tree too large to fingerprint. Two of these are **not** equality: they say the same
 * thing about two trees nobody looked at, and treating them as equal would turn every
 * verification on a big repository into a `pass`.
 */
export const TOO_LARGE = "unstable:too-large";

export { PASSES, Pass, VerificationSchema, type FailedTest, type Snapshot } from "./verify-model";
/** A pass, and the gate fix it follows where it is a `fix`. */
export interface CheckPass {
  readonly pass: Pass;
  readonly round?: number;
}
export type Verification = Schema.Schema.Type<typeof VerificationSchema>;
const VerificationJson = Schema.fromJsonString(VerificationSchema);

export class VerifyRefused extends Data.TaggedError("VerifyRefused")<{
  why: string;
  /** Where the refusal is about the Run's state rather than what was asked. */
  state?: true;
}> {}

type Services = FileSystem.FileSystem | Path.Path | ChildProcessSpawner.ChildProcessSpawner;

const git = (args: string[], cwd: string) => shell("git", args, cwd);

/**
 * What this working tree is, right now: the commit it is on, plus a digest over
 * everything that is not in it — the porcelain status, the diff against HEAD, and the
 * content of every untracked file git is not ignoring.
 *
 * Untracked content is included deliberately. A test run that passed because of a file
 * nobody committed passed on a tree that is not the one anybody will get.
 */
export const fingerprint = (cwd: string) =>
  Effect.map(treeOf(cwd), ({ head_sha, fingerprint }) => ({ head_sha, fingerprint }));

/** The Git tree HEAD names: the same files at two commits are the same content. Empty before a first commit. */
export const contentOf = (cwd: string) =>
  Effect.map(git(["rev-parse", "HEAD^{tree}"], cwd), (got) =>
    got.code === 0 ? Str.trim(got.stdout) : "",
  );

/** `git status --porcelain=v2 --branch -z`'s headers, and the entries after them. */
const statusParts = (stdout: string) => {
  const headers = new Map<string, string>();
  let rest = stdout;
  while (pipe(rest, Str.startsWith("# "))) {
    const end = Option.getOrElse(pipe(rest, Str.indexOf("\0")), () => -1);
    const [key = "", ...value] = Str.split(pipe(rest, Str.slice(2, end)), " ");
    headers.set(key, Arr.join(value, " "));
    rest = pipe(rest, Str.slice(end + 1));
  }
  return { headers, entries: rest };
};

/**
 * The fingerprint, with the branch HEAD names (`HEAD` when detached, null before a first
 * commit) and whether anything is uncommitted, all from one status.
 */
export const treeOf = Effect.fn("Verify.treeOf")(function* (cwd: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const [status, diff, others] = yield* Effect.all(
    [
      git(["status", "--porcelain=v2", "--branch", "--no-ahead-behind", "-z"], cwd),
      git(["diff", "HEAD", "--binary"], cwd),
      git(["ls-files", "--others", "--exclude-standard", "-z"], cwd),
    ],
    { concurrency: "unbounded" },
  );
  const { headers, entries } = statusParts(status.code === 0 ? status.stdout : "");
  const oid = headers.get("branch.oid");
  const born = oid !== undefined && oid !== "(initial)";
  const head_sha = born ? oid : "";
  const named = headers.get("branch.head");
  const branch = !born || named === undefined ? null : named === "(detached)" ? "HEAD" : named;
  const dirty = entries !== "";

  const parts = [entries, Bun.hash(diff.stdout).toString(16)];
  let bytes = entries.length + diff.stdout.length;
  for (const relative of Str.split(others.stdout, "\0")) {
    if (relative === "") continue;
    const file = path.join(cwd, relative);
    const size = yield* fs.stat(file).pipe(
      Effect.map((info) => Number(info.size)),
      Effect.orElseSucceed(() => 0),
    );
    bytes += size;
    if (bytes > FINGERPRINT_MAX_BYTES) return { head_sha, fingerprint: TOO_LARGE, branch, dirty };
    const content = yield* fs.readFileString(file).pipe(Effect.orElseSucceed(() => ""));
    parts.push(`${relative}:${Bun.hash(content).toString(16)}`);
  }
  return { head_sha, fingerprint: Bun.hash(Arr.join(parts, "\n")).toString(16), branch, dirty };
});

/**
 * Whether the tree was the same at both ends, and so whether the exit code says anything
 * about it. The sentinel is the case worth spelling out: two unmeasured trees are not one
 * tree, so a repository over the cap can never produce a `pass`.
 */
export function resultOf(
  start: Snapshot,
  end: Snapshot,
  exit: number,
  expect: Verification["expect"] = "pass",
): Verification["result"] {
  if (start.fingerprint === TOO_LARGE || end.fingerprint === TOO_LARGE) return "unstable";
  if (start.head_sha !== end.head_sha || start.fingerprint !== end.fingerprint) return "unstable";
  // Never `(exit === 0) === wanted` on its own: an unstable tree says nothing about
  // either expectation, and the rules above have to come first for both.
  return (exit === 0) === (expect === "pass") ? "pass" : "fail";
}

/** What outside the tree decides how a check behaves, beside the executable itself. */
const TOOLCHAIN_VARIABLES = ["PATH", "NODE_ENV", "NODE_OPTIONS"] as const;
const TOOLCHAIN_RUNTIMES = ["node", "bun"] as const;

/** Content digests by file identity and change time, so a 100MB runtime is read once. */
const digests = new Map<string, string>();

const identityOf = (executable: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const real = yield* fs.realPath(executable);
    // ctime, which no extractor can set back the way npm fixes an mtime.
    const info = yield* Effect.tryPromise(() => Bun.file(real).stat());
    const key = Arr.join(
      Arr.map([real, info.dev, info.ino, info.size, info.ctimeMs, info.mtimeMs], (part) =>
        part === null || part === undefined ? "" : globalThis.String(part),
      ),
      ":",
    );
    const known = digests.get(key);
    if (known !== undefined) return `${real}@${known}`;
    const digest = Bun.hash(yield* fs.readFile(real)).toString(16);
    digests.set(key, digest);
    return `${real}@${digest}`;
  });

/**
 * The environment a check runs in: the executable's real path and content, the runtimes
 * on PATH, and `TOOLCHAIN_VARIABLES`. Null where any of them cannot be read, which no
 * record can be reused under.
 */
export const environmentOf = Effect.fn("Verify.environmentOf")(
  function* (absolute: string) {
    const parts = [yield* identityOf(absolute)];
    for (const runtime of TOOLCHAIN_RUNTIMES) {
      const found = Bun.which(runtime, { PATH: Bun.env.PATH ?? "" });
      parts.push(`${runtime}=${found === null ? "" : yield* identityOf(found)}`);
    }
    for (const name of TOOLCHAIN_VARIABLES) parts.push(`${name}=${Bun.env[name] ?? ""}`);
    return Bun.hash(Arr.join(parts, "\n")).toString(16);
  },
  Effect.orElseSucceed(() => null),
);

/**
 * Whether this verification still says anything about the tree in front of us. A result
 * is bound to the tree it ran on, so a commit or an edit since makes it history — no time
 * component, because a verification does not go off, it is superseded.
 */
export function staleAgainst(record: Verification, now: Snapshot): boolean {
  if (record.end.fingerprint === TOO_LARGE || now.fingerprint === TOO_LARGE) return true;
  return record.end.head_sha !== now.head_sha || record.end.fingerprint !== now.fingerprint;
}

export const verificationsPath = Effect.fn("Verify.verificationsPath")(function* (runDir: string) {
  const path = yield* Path.Path;
  return path.join(runDir, "steering", "verifications.jsonl");
});

export const appendVerification = Effect.fn("Verify.append")(function* (
  runDir: string,
  record: Verification,
) {
  yield* appendJournal(yield* verificationsPath(runDir), VerificationJson, record);
});

/**
 * The check Collie itself is running for a Run, in its run directory while it runs. Its
 * agents are idle then, and without this a card reads whatever the last of them was doing.
 */
export const VERIFYING_FILE = "verifying";

const VerifyingSchema = Schema.Struct({
  name: Schema.String,
  executable: Schema.String,
  argv: Schema.Array(Schema.String),
  pass: Pass,
  round: Schema.NullOr(Schema.Int),
  /** The commit it runs at, which for `baseline` is where the branch left the default one. */
  revision: Schema.String,
  /** The default branch a `baseline` runs where the branch left; null for every other pass. */
  base: Schema.NullOr(Schema.String),
  started: Schema.String,
  /** Where its output is being written. */
  log: Schema.optionalKey(Schema.String),
  /** The pipeline job a `ci` pass waits on. */
  job: Schema.optionalKey(Schema.String),
});
export type Verifying = typeof VerifyingSchema.Type;
const VerifyingJson = Schema.fromJsonString(VerifyingSchema);
export const encodeVerifying = flow(Schema.encodeResult(VerifyingJson), Result.getOrThrow);

/**
 * The check running for the Run in `dir`, or null when none is. A marker in the old
 * one-line shape reads as its name alone, a plain `check` nothing else is known about.
 */
export const verifyingIn = (
  dir: string,
): Effect.Effect<Verifying | null, never, FileSystem.FileSystem> =>
  FileSystem.FileSystem.pipe(
    Effect.flatMap((fs) => fs.readFileString(`${dir}/${VERIFYING_FILE}`)),
    Effect.map((text): Verifying | null => {
      const decoded = Schema.decodeOption(VerifyingJson)(text);
      if (decoded._tag === "Some") return decoded.value;
      const name = Str.trim(text);
      return name === ""
        ? null
        : {
            name,
            executable: "",
            argv: [],
            pass: "check",
            round: null,
            revision: "",
            base: null,
            started: "",
          };
    }),
    Effect.orElseSucceed(() => null),
  );

export const readVerifications = Effect.fn("Verify.read")(function* (runDir: string) {
  return yield* readJournal(yield* verificationsPath(runDir), VerificationJson);
});

/**
 * Whether this directory is one of the Run's own. A verification names the tree it was
 * collected on, so a command run somewhere else would attach a real result to the wrong
 * tree — which is worse than no result.
 */
export const insideRun = Effect.fn("Verify.insideRun")(function* (
  cwd: string,
  run: { readonly cwd: string; readonly worktree: string | null },
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const real = (dir: string) =>
    fs.realPath(dir).pipe(Effect.orElseSucceed(() => path.resolve(dir)));
  const here = yield* real(cwd);
  for (const root of [run.cwd, run.worktree]) {
    if (root === null) continue;
    const inside = yield* real(root);
    if (here === inside || pipe(here, Str.startsWith(`${inside}${path.sep}`))) return true;
  }
  return false;
});

/** The executable as PATH resolves it now, recorded absolute so the record says what ran. */
export const resolveExecutable = Effect.fn("Verify.resolveExecutable")(function* (
  executable: string,
  cwd: string,
) {
  const path = yield* Path.Path;
  if (pipe(executable, Str.includes(path.sep))) return path.resolve(cwd, executable);
  // `Bun.which` and not a `command -v` subprocess: `command` is a shell builtin, and
  // reaching for a shell to find out what to run without a shell is the wrong shape.
  return Bun.which(executable, { PATH: Bun.env.PATH ?? "" });
});

function tail(text: string): string {
  return text.length <= TAIL_BYTES ? text : pipe(text, Str.slice(-TAIL_BYTES));
}

/** Where a command's two streams are shown while it runs. */
export interface Echo {
  readonly stdout: (text: string) => Effect.Effect<void>;
  readonly stderr: (text: string) => Effect.Effect<void>;
  /** A line of verify's own about what it waits on, for its client and the Run's log. */
  readonly said?: (line: string) => Effect.Effect<void>;
}

export interface Collected {
  readonly step?: string;
  readonly place?: StepPlace | null;
  readonly run: string;
  readonly name: string;
  readonly executable: string;
  readonly argv: ReadonlyArray<string>;
  readonly cwd: string;
  readonly by: "agent" | "collie";
  readonly expect?: "pass" | "fail";
  readonly pass?: CheckPass;
  /** Where both streams are appended as they arrive, so the output can be read while it runs. */
  readonly log?: string;
  /**
   * The one failed test this runs alone. A `rerun` passes only where it ran alone and passed; at
   * the `baseline` it fails only where bun reported it failing, so a test the base lacks passes.
   */
  readonly test?: FailedTest;
}

/**
 * Run it, watch it, and record what the tree was at both ends. The exit status is passed
 * back to the caller unchanged: `collie verify -- bun test` has to behave like `bun test`
 * for anything wrapping it, whatever the tree did.
 */
export const collect = Effect.fn("Verify.collect")(function* (
  runDir: string,
  what: Collected,
  /** Where each stream is shown as it arrives, for a caller watching the command run. */
  echo?: Echo,
): Effect.fn.Return<Verification, VerifyRefused, Services> {
  const absolute = yield* resolveExecutable(what.executable, what.cwd);
  if (absolute === null)
    return yield* new VerifyRefused({ why: `nothing on PATH called "${what.executable}"` });

  const environment = yield* environmentOf(absolute);
  const start = yield* fingerprint(what.cwd);
  const began = yield* nowIso;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  let logged = 0;
  if (what.log !== undefined) {
    yield* fs.makeDirectory(path.dirname(what.log), { recursive: true }).pipe(Effect.orDie);
    yield* fs.writeFileString(what.log, "").pipe(Effect.orDie);
  }
  /** One chunk into the log, in the order the two streams delivered them. */
  const toLog = (chunk: string): Effect.Effect<void> => {
    if (what.log === undefined || logged > LOG_BYTES) return Effect.void;
    const bytes = Buffer.byteLength(chunk, "utf8");
    const room = LOG_BYTES - logged;
    logged += bytes;
    const text =
      bytes <= room
        ? chunk
        : `${Buffer.from(chunk, "utf8").subarray(0, room).toString("utf8")}\n[collie: the output was cut at ${LOG_BYTES} bytes; the rest was not kept]\n`;
    return fs.writeFileString(what.log, text, { flag: "a" }).pipe(Effect.ignore);
  };
  // No shell, and the argument list whole: a verification's value is that what ran is
  // what was written down, and a shell string is a second language in between.
  const [stdout, stderr, exit] = yield* Effect.gen(function* () {
    const checks = yield* CheckProcesses;
    const handle = yield* checks.run(
      { run: what.run, name: what.name, by: what.by, ...(what.pass && { pass: what.pass }) },
      { executable: absolute, argv: what.argv, cwd: what.cwd },
      echo?.said,
    );
    if (handle.pid !== null && echo?.said !== undefined)
      yield* echo.said(`"${what.name}" started, pid ${handle.pid}`);
    // Tailed as it arrives, never folded whole: only the last 4 KiB is recorded, and a
    // verification that prints for an hour must not allocate for an hour to say so.
    const drain = (stream: typeof handle.stdout, shown?: (text: string) => Effect.Effect<void>) =>
      stream.pipe(
        Stream.decodeText(),
        Stream.tap((chunk) => toLog(chunk)),
        Stream.tap((chunk) => (shown === undefined ? Effect.void : shown(chunk))),
        Stream.runFold(
          () => "",
          (kept: string, chunk: string) => tail(kept + chunk),
        ),
      );
    return yield* handle.collected(
      Effect.all(
        [drain(handle.stdout, echo?.stdout), drain(handle.stderr, echo?.stderr), handle.exit],
        {
          concurrency: "unbounded",
        },
      ),
    );
  }).pipe(
    Effect.scoped,
    Effect.catch((cause) =>
      cause._tag === "CheckRefused"
        ? Effect.fail(
            new VerifyRefused({
              why: `${cause.why}; \`collie cleanup --apply\` tries to end it again and reports what is left`,
              state: true,
            }),
          )
        : Effect.die(cause),
    ),
  );
  const end = yield* fingerprint(what.cwd);
  const at = yield* nowIso;
  const output = `${stdout}\n${stderr}`;
  const testPassed =
    what.test === undefined ||
    (what.pass?.pass === "baseline"
      ? !failedAlone(Number(exit), output, what.test)
      : ranAlone(Number(exit), output));
  const judged = what.test === undefined ? Number(exit) : testPassed ? 0 : Number(exit) || 1;
  const failed =
    what.test !== undefined || what.log === undefined || Number(exit) === 0
      ? null
      : failedTests(yield* fs.readFileString(what.log).pipe(Effect.orElseSucceed(() => "")));

  const record: Verification = {
    id: `${what.run}-${what.name}-${epochMs(at)}`,
    run: what.run,
    name: what.name,
    executable: absolute,
    asked: what.executable,
    argv: [...what.argv],
    cwd: what.cwd,
    start,
    end,
    exit: Number(exit),
    seconds: Math.max(0, (epochMs(at) - epochMs(began)) / 1000),
    tail: { stdout, stderr },
    expect: what.expect ?? "pass",
    result: resultOf(start, end, judged, what.expect ?? "pass"),
    at,
    by: what.by,
    ...passFields(what.pass),
  };
  const read: Verification = failed === null ? record : { ...record, failed };
  const tested: Verification = what.test === undefined ? read : { ...read, test: what.test };
  const placed: Verification = environment === null ? tested : { ...tested, environment };
  const loggedRecord: Verification = what.log === undefined ? placed : { ...placed, log: what.log };
  const atStep = yield* CurrentStep;
  const step = what.step === undefined ? atStep : { step: what.step, place: what.place ?? null };
  const kept: Verification =
    step === null ? loggedRecord : { ...loggedRecord, step: step.step, place: step.place };
  yield* appendVerification(runDir, kept).pipe(Effect.orDie);
  return kept;
});

/** The pass and round a record keeps, with nothing where no pass was given. */
function passFields(given: CheckPass | undefined): Pick<Verification, "pass" | "round"> {
  if (given === undefined) return {};
  if (given.round === undefined) return { pass: given.pass };
  return { pass: given.pass, round: given.round };
}

export type CheckRun = {
  readonly id: string;
  readonly cwd: string;
  readonly worktree: string | null;
};

/**
 * A verification Collie runs itself, which it does only for one of the Run's checks —
 * exactly, argument by argument. The wrapper is part of the check: `npm test` and
 * `npm test -- --bail` are not the same one. Anyone names them (verify.json, `--verify`,
 * `run intent verification`, chat's `set_verification`), with no yes (ADR-0055). It runs
 * here, outside any agent's permission rules.
 */
export const runApproved = Effect.fn("Verify.runApproved")(function* (
  runDir: string,
  run: CheckRun,
  approved: ReadonlyArray<VerifySpec>,
  spec: VerifySpec,
  expect: "pass" | "fail" = "pass",
  pass?: CheckPass,
  log?: string,
): Effect.fn.Return<Verification, VerifyRefused, Services> {
  const match = Option.getOrUndefined(
    Arr.findFirst(approved, (entry) => entry.name === spec.name && sameCommand(entry, spec)),
  );
  if (!match)
    return yield* new VerifyRefused({
      why: `"${spec.name}" is not among this Run's checks, argument for argument`,
    });
  const cwd = yield* checkCwd(run, spec);
  if (!(yield* insideRun(cwd, run)))
    return yield* new VerifyRefused({ why: `"${cwd}" is not inside run ${run.id}` });
  return yield* collect(runDir, {
    run: run.id,
    name: spec.name,
    executable: spec.executable,
    argv: spec.argv,
    cwd,
    by: "collie",
    expect,
    pass,
    log,
  });
});

/**
 * One failed test of a check run alone, from the sources, in the check's directory and under
 * its name: again on the same tree, whether it was a Flake, or at the base, whether it failed
 * there too (ADR-0034).
 */
export const rerunTest = Effect.fn("Verify.rerunTest")(function* (
  runDir: string,
  run: CheckRun,
  spec: VerifySpec,
  test: FailedTest,
  pass: { readonly pass: "rerun" | "baseline" },
  log?: string,
): Effect.fn.Return<Verification, VerifyRefused, Services> {
  const cwd = yield* checkCwd(run, spec);
  if (!(yield* insideRun(cwd, run)))
    return yield* new VerifyRefused({ why: `"${cwd}" is not inside run ${run.id}` });
  return yield* collect(runDir, {
    run: run.id,
    name: spec.name,
    executable: "bun",
    argv: rerunArgv(test),
    cwd,
    by: "collie",
    pass,
    log,
    test,
  });
});

export const checkCwd = (run: CheckRun, spec: VerifySpec) =>
  Path.Path.pipe(
    Effect.map((path) =>
      spec.cwd === "worktree" ? (run.worktree ?? run.cwd) : path.resolve(run.cwd, spec.cwd),
    ),
  );

type Command = Pick<VerifySpec, "executable" | "argv" | "cwd">;

export const sameCommand = (one: Command, other: Command) =>
  one.executable === other.executable &&
  one.cwd === other.cwd &&
  one.argv.length === other.argv.length &&
  Arr.every(one.argv, (word, at) => word === other.argv[at]);

/**
 * Whether two records ran the same command as it was asked, so a fail and a pass through
 * different installs of one tool are one command; by resolved path where either does not say.
 */
export const sameAsked = (one: Verification, other: Verification) =>
  one.asked === undefined || other.asked === undefined
    ? sameCommand(one, other)
    : sameCommand({ ...one, executable: one.asked }, { ...other, executable: other.asked });

/** A check's command resolved for its Run; one whose executable is not found matches no record. */
export type CheckCommand = Pick<Verification, "name" | "argv" | "cwd"> & {
  readonly executable: string | null;
  readonly ci?: string;
};

/** Whether this record ran exactly that check's command. */
export const ranCommand = (record: Command, check: CheckCommand) =>
  check.executable !== null && sameCommand(record, { ...check, executable: check.executable });

/** A run of one failed test, again or at the base, is recorded under its check's name, and is never the check's own run. */
export const ranOneTest = (v: Pick<Verification, "test">) => v.test !== undefined;

/** A pass that expected one: a reproduced failure is not. */
export const passed = (v: Verification) => v.result === "pass" && v.expect === "pass";

/**
 * The latest record of exactly this command on this tree, where it was collected in this
 * environment since `since`. Whoever asked for it does not matter: the host ran it.
 */
function latestRecord(
  records: ReadonlyArray<Verification>,
  wanted: Pick<Verification, "executable" | "argv" | "cwd"> & {
    readonly environment: string | null;
  },
  now: Snapshot,
  since: string,
): Verification | null {
  const latest = Option.getOrUndefined(
    Arr.findLast(records, (one) => sameCommand(one, wanted) && !staleAgainst(one, now)),
  );
  if (latest === undefined || wanted.environment === null) return null;
  const holds = latest.environment === wanted.environment && epochMs(latest.at) > epochMs(since);
  return holds ? latest : null;
}

/** A check's command as Collie runs it for this Run; its executable is null where none is found. */
export const commandOf = Effect.fn("Verify.commandOf")(function* (run: CheckRun, spec: VerifySpec) {
  const cwd = yield* checkCwd(run, spec);
  const executable = yield* resolveExecutable(spec.executable, cwd);
  const command = { name: spec.name, executable, argv: spec.argv, cwd };
  return spec.ci === undefined ? command : { ...command, ci: spec.ci };
});

/** `latestRecord` for one of a Run's checks, read from its journal against its tree now. */
export const recordFor = Effect.fn("Verify.recordFor")(function* (
  runDir: string,
  run: CheckRun,
  spec: VerifySpec,
  since: string,
) {
  const cwd = yield* checkCwd(run, spec);
  const executable = yield* resolveExecutable(spec.executable, cwd);
  if (executable === null) return null;
  return latestRecord(
    yield* readVerifications(runDir).pipe(Effect.orElseSucceed(() => [])),
    { executable, argv: spec.argv, cwd, environment: yield* environmentOf(executable) },
    yield* fingerprint(cwd),
    since,
  );
});

/** `recordFor`, where it is a pass. */
export const reliedFor = (...args: Parameters<typeof recordFor>) =>
  recordFor(...args).pipe(
    Effect.map((latest) => (latest !== null && passed(latest) ? latest : null)),
  );

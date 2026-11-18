import * as Str from "effect/String";
import { pipe } from "effect/Function";
import * as Option from "effect/Option";
import * as Arr from "effect/Array";
import * as Order from "effect/Order";
import { Data, Effect, FileSystem, Path, Schema, flow, Result } from "effect";
import type { ChildProcessSpawner } from "effect/process";
import { Stream } from "effect";
// oxlint-disable-next-line effecttsgo/node-builtin-import -- Effect's file info has no ctime.
import { lstat } from "node:fs/promises";
import { CheckProcesses, type CheckOf } from "./check-processes";
import { logged } from "./check-supervisor";
import type { VerifySpec } from "./intent";
import { failedAlone, failedTests, ranAlone, rerunArgv } from "./bun-tests";
import { appendRunJournal, readBriefsOf, readRunJournal, runJournal } from "./journal";
import { RunRecords } from "./run-records";
import { shell, type Ran } from "./mr";
import { nowIso, epochMs } from "./time";
import { CurrentStep, type StepPlace } from "./steps";
import {
  Pass,
  ProofSchema,
  VerificationSchema,
  type FailedTest,
  type MovedPath,
  type Snapshot,
} from "./verify-model";

export const FINGERPRINT_MAX_BYTES = 50 * 1024 * 1024;

const TAIL_BYTES = 4 * 1024;

export { LOG_BYTES } from "./check-supervisor";

export const TOO_LARGE = "unstable:too-large";

export const UNMEASURED = "unstable:unmeasured";

export {
  movedLine,
  PASSES,
  Pass,
  VerificationSchema,
  type FailedTest,
  type Proof,
  type Snapshot,
} from "./verify-model";
export interface CheckPass {
  readonly pass: Pass;
  readonly round?: number;
}
export type Verification = Schema.Schema.Type<typeof VerificationSchema>;
const VerificationJson = Schema.fromJsonString(VerificationSchema);

export class VerifyRefused extends Data.TaggedError("VerifyRefused")<{
  why: string;
  state?: true;
}> {}

export const noVerdict =
  (name: string, what: "exit status" | "output" | "record", how: "read" | "written") =>
  (error: Error) =>
    new VerifyRefused({
      why: `"${name}" gave no verdict: its ${what} could not be ${how}: ${error.message}`,
      state: true,
    });

type Services =
  | FileSystem.FileSystem
  | Path.Path
  | ChildProcessSpawner.ChildProcessSpawner
  | RunRecords;

const git = (args: string[], cwd: string) => shell("git", args, cwd);

export const fingerprint = (cwd: string) =>
  Effect.map(treeOf(cwd), ({ head_sha, fingerprint, unmeasured }) =>
    unmeasured === undefined ? { head_sha, fingerprint } : { head_sha, fingerprint, unmeasured },
  );

export const contentOf = (cwd: string) =>
  Effect.map(git(["rev-parse", "HEAD^{tree}"], cwd), (got) =>
    got.code === 0 ? Str.trim(got.stdout) : "",
  );

const statusParts = (stdout: string) => {
  const headers = new Map<string, string>();
  let rest = stdout;
  while (pipe(rest, Str.startsWith("# "))) {
    const end = Option.getOrElse(pipe(rest, Str.indexOf("\0")), () => -1);
    const [key, ...value] = Str.split(pipe(rest, Str.slice(2, end)), " ");
    headers.set(key, Arr.join(value, " "));
    rest = pipe(rest, Str.slice(end + 1));
  }
  return { headers, entries: rest };
};

export const treeOf: (cwd: string) => Effect.Effect<
  {
    head_sha: string;
    fingerprint: string;
    unmeasured?: string;
    branch: string | null;
    dirty: boolean;
  },
  never,
  Services
> = Effect.fn("Verify.treeOf")(function* (cwd: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const [status, place] = yield* Effect.all(
    [
      git(
        [
          "status",
          "--porcelain=v2",
          "--branch",
          "--no-ahead-behind",
          "--ignore-submodules=none",
          "--untracked-files=all",
          "-z",
        ],
        cwd,
      ),
      placeOf(cwd),
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

  const root = place?.root ?? cwd;
  let bytes = 0;
  for (const relative of unstagedPaths(entries)) {
    bytes += yield* fs.stat(path.join(root, relative)).pipe(
      Effect.map((info) => Number(info.size)),
      Effect.orElseSucceed(() => 0),
    );
    if (bytes > FINGERPRINT_MAX_BYTES) return { head_sha, fingerprint: TOO_LARGE, branch, dirty };
  }
  const { tree, unmeasured } = place === null ? { tree: "" } : yield* workingTree(cwd, place.index);
  if (unmeasured !== undefined)
    return { head_sha, fingerprint: UNMEASURED, unmeasured, branch, dirty };
  const parts = [tree];
  for (const sub of changedSubmodules(entries)) {
    const inner = yield* treeOf(path.join(root, sub));
    if (inner.fingerprint === TOO_LARGE) return { head_sha, fingerprint: TOO_LARGE, branch, dirty };
    if (inner.fingerprint === UNMEASURED || inner.fingerprint === "")
      return inner.unmeasured === undefined
        ? { head_sha, fingerprint: UNMEASURED, branch, dirty }
        : { head_sha, fingerprint: UNMEASURED, unmeasured: inner.unmeasured, branch, dirty };
    parts.push(`${sub}=${inner.fingerprint}`);
  }
  return { head_sha, fingerprint: Arr.join(parts, " "), branch, dirty };
});

const changedSubmodules = (entries: string) => {
  const found: string[] = [];
  let original = false;
  for (const record of Str.split(entries, "\0")) {
    if (original) {
      original = false;
      continue;
    }
    const [kind, , sub, ...rest] = Str.split(record, " ");
    original = kind === "2";
    if (
      (kind === "1" || kind === "2") &&
      sub !== undefined &&
      sub[0] === "S" &&
      (sub[2] === "M" || sub[3] === "U")
    )
      found.push(Arr.join(Arr.drop(rest, kind === "1" ? 5 : 6), " "));
  }
  return found;
};

const unstagedPaths = (entries: string) => {
  const found: string[] = [];
  let original = false;
  for (const record of Str.split(entries, "\0")) {
    if (original) {
      original = false;
      continue;
    }
    const [kind, xy = "", ...rest] = Str.split(record, " ");
    original = kind === "2";
    if (kind === "?") found.push(Arr.join([xy, ...rest], " "));
    else if (kind === "u") found.push(Arr.join(Arr.drop(rest, 8), " "));
    else if ((kind === "1" || kind === "2") && xy[1] !== ".")
      found.push(Arr.join(Arr.drop(rest, kind === "1" ? 6 : 7), " "));
  }
  return found;
};

const places = new Map<
  string,
  { readonly index: string; readonly root: string; readonly dotGit: string }
>();

const dotGitOf = Effect.fn("Verify.dotGitOf")(
  function* (root: string) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const dotGit = path.join(root, ".git");
    const info = yield* fs.stat(dotGit);
    return info.type === "Directory" ? "directory" : yield* fs.readFileString(dotGit);
  },
  Effect.orElseSucceed(() => null),
);

const placeOf = Effect.fn("Verify.placeOf")(function* (cwd: string) {
  const path = yield* Path.Path;
  const dotGit = yield* dotGitOf(cwd);
  const known = places.get(cwd);
  if (known !== undefined && known.dotGit === dotGit) return known;
  const said = yield* git(["rev-parse", "--git-path", "index", "--show-cdup"], cwd);
  if (said.code !== 0) return null;
  const [index, cdup = ""] = Str.split(said.stdout, "\n");
  const place = { index: path.resolve(cwd, index), root: path.resolve(cwd, cdup) };
  if (cdup === "" && dotGit !== null) places.set(cwd, { ...place, dotGit });
  return place;
});

type Measured = { readonly tree: string; readonly unmeasured?: string };

const unmeasuredBy: (verb: string, ran: Ran) => Measured = (verb, ran) => ({
  tree: UNMEASURED,
  unmeasured: tail(Str.trim(ran.stderr ?? "")) || `git ${verb} exited ${ran.code}`,
});

const stageAndWrite = Effect.fn("Verify.stageAndWrite")(
  function* (cwd: string, index: string) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    return yield* Effect.acquireUseRelease(
      fs.makeTempDirectory({ prefix: "collie-index-" }),
      (scratch) =>
        Effect.gen(function* () {
          const env = { GIT_INDEX_FILE: path.join(scratch, "index") };
          if (yield* fs.exists(index)) {
            const written = (yield* fs.stat(index)).mtime;
            yield* fs.copyFile(index, env.GIT_INDEX_FILE);
            if (Option.isSome(written)) {
              const at = Math.floor(written.value.getTime() / 1000);
              yield* fs.utimes(env.GIT_INDEX_FILE, at, at);
            }
          }
          const added = yield* shell("git", ["add", "-A"], cwd, env);
          if (added.code !== 0) return unmeasuredBy("add", added);
          const tree = yield* shell("git", ["write-tree"], cwd, env);
          return tree.code === 0
            ? { tree: Str.trim(tree.stdout) }
            : unmeasuredBy("write-tree", tree);
        }),
      (scratch) => fs.remove(scratch, { recursive: true }).pipe(Effect.ignore),
    );
  },
  Effect.catch((error) =>
    Effect.succeed<Measured>({ tree: UNMEASURED, unmeasured: error.message }),
  ),
);

const workingTree = (cwd: string, index: string) =>
  stageAndWrite(cwd, index).pipe(
    Effect.filterOrElse(
      (first) => first.unmeasured === undefined,
      () => stageAndWrite(cwd, index),
    ),
  );

export const sameTree = (
  one: Pick<Snapshot, "fingerprint">,
  other: Pick<Snapshot, "fingerprint">,
) =>
  one.fingerprint !== TOO_LARGE &&
  one.fingerprint !== UNMEASURED &&
  one.fingerprint === other.fingerprint;

export function resultOf(
  start: Snapshot,
  end: Snapshot,
  exit: number,
  expect: Verification["expect"] = "pass",
) {
  if (!sameTree(start, end)) return "unstable";
  return (exit === 0) === (expect === "pass") ? "pass" : "fail";
}

const LOCKFILES: ReadonlySet<string> = new Set([
  "bun.lock",
  "bun.lockb",
  "package-lock.json",
  "npm-shrinkwrap.json",
  "yarn.lock",
  "pnpm-lock.yaml",
  "Cargo.lock",
  "composer.lock",
  "Gemfile.lock",
  "poetry.lock",
  "uv.lock",
  "go.sum",
]);

const changeOf: (status: string) => MovedPath["change"] = (status) => {
  switch (status[0]) {
    case "A":
      return "added";
    case "D":
      return "deleted";
    case "T":
      return "type-changed";
    default:
      return "modified";
  }
};

const nothingMoved: ReadonlyArray<MovedPath> = [];

export const movedBetween = Effect.fn("Verify.movedBetween")(
  function* (cwd: string, start: Snapshot, end: Snapshot) {
    const [from] = Str.split(start.fingerprint, " ");
    const [to] = Str.split(end.fingerprint, " ");
    const measured = (tree: string | undefined): tree is string =>
      tree !== undefined && tree !== "" && tree !== TOO_LARGE && tree !== UNMEASURED;
    const place = yield* placeOf(cwd);
    if (place === null || !measured(from) || !measured(to) || from === to) return [];
    const diff = yield* git(
      ["diff-tree", "-r", "-z", "--no-renames", "--name-status", from, to],
      place.root,
    );
    if (diff.code !== 0) return [];
    const fields = Arr.filter(Str.split(diff.stdout, "\0"), Str.isNonEmpty);
    const changed = Arr.map(Arr.chunksOf(fields, 2), ([status, path = ""]) => ({
      path,
      change: changeOf(status),
    }));
    const listed = yield* git(
      ["--literal-pathspecs", "ls-files", "-z", "--", ...Arr.map(changed, (one) => one.path)],
      place.root,
    );
    const indexed = new Set(Str.split(listed.code === 0 ? listed.stdout : "", "\0"));
    return Arr.map(changed, (one) => {
      const moved: MovedPath = {
        ...one,
        class: LOCKFILES.has(Str.split(one.path, "/").at(-1) ?? "")
          ? "lockfile"
          : indexed.has(one.path)
            ? "tracked"
            : "untracked",
      };
      return moved;
    });
  },
  Effect.orElseSucceed(() => nothingMoved),
);

const TOOLCHAIN_VARIABLES = ["PATH", "NODE_ENV", "NODE_OPTIONS"] as const;
const TOOLCHAIN_RUNTIMES = ["node", "bun"] as const;

const digests = new Map<string, string>();

const identityOf = (executable: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const real = yield* fs.realPath(executable);
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

const packageRoots = Effect.fn("Verify.packageRoots")(function* (cwd: string) {
  const path = yield* Path.Path;
  const top = yield* git(["rev-parse", "--show-toplevel"], cwd);
  if (top.code !== 0) return [cwd];
  const root = Str.trim(top.stdout);
  const listed = yield* git(["ls-files", "-z", "--", ":(glob)**/package.json"], root);
  if (listed.code !== 0) return [cwd];
  const files = Arr.filter(Str.split(listed.stdout, "\0"), (file) => file !== "");
  return Arr.map(files, (file) => path.join(root, path.dirname(file)));
});

const identityLine = (name: string, at: string) =>
  Effect.map(
    Effect.tryPromise(() => lstat(at)),
    (info) => ({
      line: `${name}:${info.ino}:${info.ctimeMs}`,
      scope: pipe(name, Str.startsWith("@")) && info.isDirectory(),
    }),
  );

const installedAt = Effect.fn("Verify.installedAt")(function* (root: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const modules = path.join(root, "node_modules");
  const names = yield* fs.readDirectory(modules).pipe(
    Effect.map((found) => found),
    Effect.catchTag("PlatformError", (error) =>
      error.reason._tag === "NotFound" ? Effect.succeed(null) : Effect.fail(error),
    ),
  );
  if (names === null) return `${root}:absent`;
  const lines = [root];
  for (const name of Arr.sort(names, Order.String)) {
    if (pipe(name, Str.startsWith(".")) && name !== ".bin") continue;
    const { line, scope } = yield* identityLine(name, path.join(modules, name));
    lines.push(line);
    if (!scope) continue;
    for (const inner of Arr.sort(yield* fs.readDirectory(path.join(modules, name)), Order.String))
      lines.push((yield* identityLine(`${name}/${inner}`, path.join(modules, name, inner))).line);
  }
  return Arr.join(lines, "\n");
});

export const environmentOf = Effect.fn("Verify.environmentOf")(
  function* (absolute: string, cwd: string) {
    const parts = [yield* identityOf(absolute)];
    for (const runtime of TOOLCHAIN_RUNTIMES) {
      const found = Bun.which(runtime, { PATH: Bun.env.PATH ?? "" });
      parts.push(`${runtime}=${found === null ? "" : yield* identityOf(found)}`);
    }
    for (const name of TOOLCHAIN_VARIABLES) parts.push(`${name}=${Bun.env[name] ?? ""}`);
    for (const root of yield* packageRoots(cwd)) parts.push(yield* installedAt(root));
    return Bun.hash(Arr.join(parts, "\n")).toString(16);
  },
  Effect.orElseSucceed(() => null),
);

export function staleAgainst(record: Verification, now: Snapshot) {
  return !sameTree(record.end, now);
}

export const verificationsPath = (runDir: string) =>
  runJournal(runDir, "steering/verifications.jsonl");

export const appendVerification = Effect.fn("Verify.append")(function* (
  runDir: string,
  record: Verification,
) {
  yield* appendRunJournal(verificationsPath(runDir), VerificationJson, record);
});

export const VERIFYING = "verifying";

const VerifyingSchema = Schema.Struct({
  name: Schema.String,
  executable: Schema.String,
  argv: Schema.Array(Schema.String),
  pass: Pass,
  round: Schema.NullOr(Schema.Int),
  revision: Schema.String,
  base: Schema.NullOr(Schema.String),
  started: Schema.String,
  checkout: Schema.optionalKey(Schema.String),
  log: Schema.optionalKey(Schema.String),
  job: Schema.optionalKey(Schema.String),
});
export type Verifying = typeof VerifyingSchema.Type;
const VerifyingJson = Schema.fromJsonString(VerifyingSchema);
export const encodeVerifying = flow(Schema.encodeResult(VerifyingJson), Result.getOrThrow);

export const decodeVerifying = (data: string | null) =>
  data === null ? null : Option.getOrNull(Schema.decodeOption(VerifyingJson)(data));

export const verifyingOf = (runId: string) =>
  Effect.map(
    RunRecords.use((records) => records.control(VERIFYING, runId)),
    decodeVerifying,
  );

export const readVerifications = Effect.fn("Verify.read")(function* (runDir: string) {
  return yield* readRunJournal(verificationsPath(runDir), VerificationJson);
});

export const readProofsOf = Effect.fn("Verify.readProofsOf")(function* (
  runDirs: ReadonlyArray<string>,
) {
  const at = Arr.map(runDirs, verificationsPath);
  return at.length === 0
    ? []
    : yield* readBriefsOf(
        Arr.map(at, (one) => one.run),
        at[0]!.name,
        ProofJson,
      );
});
const ProofJson = Schema.fromJsonString(ProofSchema);

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

export const resolveExecutable = Effect.fn("Verify.resolveExecutable")(function* (
  executable: string,
  cwd: string,
) {
  const path = yield* Path.Path;
  if (pipe(executable, Str.includes(path.sep))) return path.resolve(cwd, executable);
  return Bun.which(executable, { PATH: Bun.env.PATH ?? "" });
});

function tail(text: string) {
  return text.length <= TAIL_BYTES ? text : pipe(text, Str.slice(-TAIL_BYTES));
}

export interface Echo {
  readonly stdout: (text: string) => Effect.Effect<void>;
  readonly stderr: (text: string) => Effect.Effect<void>;
  readonly said?: (line: string) => Effect.Effect<void>;
  readonly started?: (check: string) => Effect.Effect<void>;
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
  readonly log?: string;
  readonly test?: FailedTest;
  readonly own?: boolean;
}

export interface StartedCheck {
  readonly id: string;
  readonly exit: Effect.Effect<number, VerifyRefused>;
}

export const startCheck = Effect.fn("Verify.startCheck")(function* (
  runDir: string,
  what: Collected,
  echo?: Echo,
) {
  const absolute = yield* resolveExecutable(what.executable, what.cwd);
  if (absolute === null)
    return yield* new VerifyRefused({ why: `nothing on PATH called "${what.executable}"` });

  const environment = yield* environmentOf(absolute, what.cwd);
  const start = yield* fingerprint(what.cwd);
  const began = yield* nowIso;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  let already = 0;
  if (what.log !== undefined) {
    yield* fs.makeDirectory(path.dirname(what.log), { recursive: true }).pipe(Effect.orDie);
    yield* fs.writeFileString(what.log, "", { flag: "a" }).pipe(Effect.orDie);
  }
  const toLog = (chunk: string) => {
    if (what.log === undefined || handle.logged) return Effect.void;
    const next = logged(chunk, already);
    already = next.logged;
    return next.text === ""
      ? Effect.void
      : fs.writeFileString(what.log, next.text, { flag: "a" }).pipe(Effect.ignore);
  };
  const atStep = yield* CurrentStep;
  const step = what.step === undefined ? atStep : { step: what.step, place: what.place ?? null };
  const checks = yield* CheckProcesses;
  const handle = yield* checks
    .run(
      { run: what.run, name: what.name, by: what.by, ...(what.pass && { pass: what.pass }) },
      {
        executable: absolute,
        argv: what.argv,
        cwd: what.cwd,
        spec: {
          evidence: runDir,
          asked: what.executable,
          start,
          began,
          expect: what.expect ?? "pass",
          step,
          ...(what.log !== undefined && { log: what.log }),
          ...(what.test !== undefined && { test: what.test }),
          ...(what.own !== undefined && { own: what.own }),
          ...(environment !== null && { environment }),
        },
      },
      echo?.said,
    )
    .pipe(
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
  if (handle.id === null) return yield* Effect.never;
  if (echo?.started !== undefined) yield* echo.started(handle.id);
  if (echo?.said !== undefined) {
    const pid = yield* handle.pid;
    if (pid !== null) yield* echo.said(`"${what.name}" started, pid ${pid}`);
  }
  const drain = (stream: typeof handle.stdout, shown?: (text: string) => Effect.Effect<void>) =>
    stream.pipe(
      Stream.decodeText(),
      Stream.tap((chunk) => toLog(chunk)),
      Stream.tap((chunk) => (shown === undefined ? Effect.void : shown(chunk))),
      Stream.runDrain,
    );
  return {
    id: handle.id,
    exit: handle
      .collected(
        Effect.all(
          [
            drain(handle.stdout, echo?.stdout).pipe(Effect.orDie),
            drain(handle.stderr, echo?.stderr).pipe(Effect.orDie),
            handle.exit.pipe(Effect.mapError(noVerdict(what.name, "exit status", "read"))),
          ],
          { concurrency: "unbounded" },
        ),
      )
      .pipe(Effect.map(([, , exit]) => exit)),
  };
});

export const finishCheck = (id: string, name: string, exit: number) =>
  Effect.flatMap(readCheck(id, name), (read) => settleCheck(read, exit));

const readCheck = Effect.fn("Verify.readCheck")(function* (id: string, name: string) {
  const found = yield* (yield* CheckProcesses)
    .finished(id)
    .pipe(Effect.mapError(noVerdict(name, "output", "read")));
  if (found === null) return yield* Effect.die(`check ${id} has no record to finish it from`);
  return {
    ...found,
    tail: { stdout: tail(found.output.stdout), stderr: tail(found.output.stderr) },
  };
});

const settleCheck = Effect.fn("Verify.settleCheck")(function* (
  { check, command, tail: { stdout, stderr } }: Effect.Success<ReturnType<typeof readCheck>>,
  exit: number,
) {
  const { spec } = command;
  const fs = yield* FileSystem.FileSystem;
  const end = yield* fingerprint(command.cwd);
  const at = yield* nowIso;
  const output = `${stdout}\n${stderr}`;
  const testPassed =
    spec.test === undefined ||
    (check.pass?.pass === "baseline"
      ? !failedAlone(exit, output, spec.test)
      : ranAlone(exit, output));
  const judged = spec.test === undefined ? exit : testPassed ? 0 : exit || 1;
  const failed =
    spec.test !== undefined || spec.log === undefined || exit === 0
      ? null
      : failedTests(yield* fs.readFileString(spec.log).pipe(Effect.orElseSucceed(() => "")));

  const record: Verification = {
    id: `${check.run}-${check.name}-${epochMs(at)}`,
    run: check.run,
    name: check.name,
    executable: command.executable,
    asked: spec.asked,
    argv: [...command.argv],
    cwd: command.cwd,
    start: spec.start,
    end,
    exit,
    seconds: Math.max(0, (epochMs(at) - epochMs(spec.began)) / 1000),
    tail: { stdout, stderr },
    expect: spec.expect,
    result: resultOf(spec.start, end, judged, spec.expect),
    at,
    by: check.by,
    ...passFields(passOf(check.pass)),
  };
  const moved =
    record.result === "unstable" ? yield* movedBetween(command.cwd, spec.start, end) : [];
  const shifted: Verification = moved.length === 0 ? record : { ...record, moved };
  const read: Verification = failed === null ? shifted : { ...shifted, failed };
  const tested: Verification = spec.test === undefined ? read : { ...read, test: spec.test };
  const owned: Verification = spec.own === undefined ? tested : { ...tested, own: spec.own };
  const placed: Verification =
    spec.environment === undefined ? owned : { ...owned, environment: spec.environment };
  const loggedRecord: Verification = spec.log === undefined ? placed : { ...placed, log: spec.log };
  const kept: Verification =
    spec.step === null
      ? loggedRecord
      : { ...loggedRecord, step: spec.step.step, place: spec.step.place };
  yield* appendVerification(spec.evidence, kept).pipe(
    Effect.catchDefect((defect) =>
      Effect.fail(
        noVerdict(
          check.name,
          "record",
          "written",
        )(defect instanceof Error ? defect : new Error(String(defect))),
      ),
    ),
  );
  return kept;
});

export const collect = (runDir: string, what: Collected, echo?: Echo) =>
  startCheck(runDir, what, echo).pipe(
    Effect.flatMap((started) =>
      Effect.flatMap(started.exit, (exit) =>
        Effect.map(readCheck(started.id, what.name), (read) => [read, exit] as const),
      ),
    ),
    Effect.scoped,
    Effect.flatMap(([read, exit]) => settleCheck(read, exit)),
    Effect.withSpan("Verify.collect"),
  );

function passOf(given: CheckOf["pass"]) {
  if (given === undefined || !Schema.is(Pass)(given.pass)) return undefined;
  return given.round === undefined
    ? { pass: given.pass }
    : { pass: given.pass, round: given.round };
}

function passFields(given: CheckPass | undefined) {
  if (given === undefined) return {};
  if (given.round === undefined) return { pass: given.pass };
  return { pass: given.pass, round: given.round };
}

export type CheckRun = {
  readonly id: string;
  readonly cwd: string;
  readonly worktree: string | null;
};

export const runApproved = Effect.fn("Verify.runApproved")(function* (
  runDir: string,
  run: CheckRun,
  approved: ReadonlyArray<VerifySpec>,
  spec: VerifySpec,
  expect: "pass" | "fail" = "pass",
  pass?: CheckPass,
  log?: string,
) {
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

export const rerunTest = Effect.fn("Verify.rerunTest")(function* (
  runDir: string,
  run: CheckRun,
  spec: VerifySpec,
  test: FailedTest,
  pass: { readonly pass: "rerun"; readonly own: boolean } | { readonly pass: "baseline" },
  log?: string,
) {
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
    pass: { pass: pass.pass },
    log,
    test,
    ...(pass.pass === "rerun" && { own: pass.own }),
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

export const sameAsked = (one: Verification, other: Verification) =>
  one.asked === undefined || other.asked === undefined
    ? sameCommand(one, other)
    : sameCommand({ ...one, executable: one.asked }, { ...other, executable: other.asked });

export type CheckCommand = Pick<Verification, "name" | "argv" | "cwd"> & {
  readonly executable: string | null;
  readonly ci?: string;
};

export const ranCommand = (record: Command, check: CheckCommand) =>
  check.executable !== null && sameCommand(record, { ...check, executable: check.executable });

export const ranOneTest = (v: Pick<Verification, "test">) => v.test !== undefined;

export const passed = (v: Verification) => v.result === "pass" && v.expect === "pass";

function latestRecord(
  records: ReadonlyArray<Verification>,
  wanted: Pick<Verification, "executable" | "argv" | "cwd"> & {
    readonly environment: string | null;
  },
  now: Snapshot,
  since: string,
) {
  const latest = Option.getOrUndefined(
    Arr.findLast(records, (one) => sameCommand(one, wanted) && !staleAgainst(one, now)),
  );
  if (latest === undefined || wanted.environment === null) return null;
  const holds = latest.environment === wanted.environment && epochMs(latest.at) > epochMs(since);
  return holds ? latest : null;
}

export const commandOf = Effect.fn("Verify.commandOf")(function* (run: CheckRun, spec: VerifySpec) {
  const cwd = yield* checkCwd(run, spec);
  const executable = yield* resolveExecutable(spec.executable, cwd);
  const command = { name: spec.name, executable, argv: spec.argv, cwd };
  return spec.ci === undefined ? command : { ...command, ci: spec.ci };
});

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
    { executable, argv: spec.argv, cwd, environment: yield* environmentOf(executable, cwd) },
    yield* fingerprint(cwd),
    since,
  );
});

export const recordedFor = Effect.fn("Verify.recordedFor")(function* (
  runDir: string,
  wanted: Pick<Verification, "name" | "executable" | "argv" | "cwd" | "expect">,
  since: string,
) {
  const latest = latestRecord(
    Arr.filter(
      yield* readVerifications(runDir).pipe(Effect.orElseSucceed(() => [])),
      (one) => one.name === wanted.name && one.expect === wanted.expect,
    ),
    { ...wanted, environment: yield* environmentOf(wanted.executable, wanted.cwd) },
    yield* fingerprint(wanted.cwd),
    since,
  );
  return latest === null || latest.result === "unstable" || ranOneTest(latest) ? null : latest;
});

export const reliedFor = (...args: Parameters<typeof recordFor>) =>
  recordFor(...args).pipe(
    Effect.map((latest) => (latest !== null && passed(latest) ? latest : null)),
  );

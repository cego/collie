import * as Str from "effect/String";
import { pipe } from "effect/Function";
import * as Option from "effect/Option";
import * as Arr from "effect/Array";
import * as Order from "effect/Order";
import {
  Clock,
  Data,
  Deferred,
  Effect,
  Exit,
  FileSystem,
  Path,
  Schema,
  flow,
  Result,
} from "effect";
import type { Scope } from "effect";
import type { ChildProcessSpawner } from "effect/process";
import { Stream } from "effect";
// oxlint-disable-next-line effecttsgo/node-builtin-import -- Effect's file info has no ctime.
import { lstat } from "node:fs/promises";
import { baseTree } from "./base-tree";
import { CheckProcesses } from "./check-processes";
import type { CheckOf } from "./check-processes";
import { logged } from "./check-supervisor";
import type { VerifySpec } from "./intent";
import { failedAlone, failedTests, ranAlone, rerunArgv } from "./bun-tests";
import { appendRunJournal, readBriefsOf, readRunJournal, runJournal } from "./journal";
import { RunRecords } from "./run-records";
import { shell } from "./mr";
import type { Ran } from "./mr";
import { nowIso, epochMs } from "./time";
import { CurrentStep } from "./steps";
import type { StepPlace } from "./steps";
import { Pass, ProofSchema, VerificationSchema } from "./verify-model";
import type { FailedTest, MovedPath, Prepare, Snapshot } from "./verify-model";

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

const git = (args: Array<string>, cwd: string) => shell("git", args, cwd);

// WARNING: untracked content counts on purpose, or a pass could rest on a file nobody committed.
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

  // WARNING: git status names paths from the repository root, not from cwd.
  const root = place?.root ?? cwd;
  let bytes = 0;
  for (const relative of unstagedPaths(entries)) {
    bytes += yield* fs.stat(path.join(root, relative)).pipe(
      Effect.map((info) => Number(info.size)),
      Effect.orElseSucceed(() => 0),
    );
    if (bytes > FINGERPRINT_MAX_BYTES) {
      return { head_sha, fingerprint: TOO_LARGE, branch, dirty };
    }
  }
  const { tree, unmeasured } = place === null ? { tree: "" } : yield* workingTree(cwd, place.index);
  if (unmeasured !== undefined) {
    return { head_sha, fingerprint: UNMEASURED, unmeasured, branch, dirty };
  }
  const parts = [tree];
  for (const sub of changedSubmodules(entries)) {
    const inner = yield* treeOf(path.join(root, sub));
    if (inner.fingerprint === TOO_LARGE) {
      return { head_sha, fingerprint: TOO_LARGE, branch, dirty };
    }
    if (inner.fingerprint === UNMEASURED || inner.fingerprint === "") {
      return inner.unmeasured === undefined
        ? { head_sha, fingerprint: UNMEASURED, branch, dirty }
        : { head_sha, fingerprint: UNMEASURED, unmeasured: inner.unmeasured, branch, dirty };
    }
    parts.push(`${sub}=${inner.fingerprint}`);
  }
  return { head_sha, fingerprint: Arr.join(parts, " "), branch, dirty };
});

const changedSubmodules = (entries: string) => {
  const found: Array<string> = [];
  let original = false;
  for (const record of Str.split(entries, "\0")) {
    // WARNING: a rename's original path is the record after it.
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
    ) {
      found.push(Arr.join(Arr.drop(rest, kind === "1" ? 5 : 6), " "));
    }
  }
  return found;
};

const unstagedPaths = (entries: string) => {
  const found: Array<string> = [];
  let original = false;
  for (const record of Str.split(entries, "\0")) {
    if (original) {
      original = false;
      continue;
    }
    const [kind, xy = "", ...rest] = Str.split(record, " ");
    original = kind === "2";
    if (kind === "?") {
      found.push(Arr.join([xy, ...rest], " "));
    } else if (kind === "u") {
      found.push(Arr.join(Arr.drop(rest, 8), " "));
    } else if ((kind === "1" || kind === "2") && xy[1] !== ".") {
      found.push(Arr.join(Arr.drop(rest, kind === "1" ? 6 : 7), " "));
    }
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
  if (known !== undefined && known.dotGit === dotGit) {
    return known;
  }
  const said = yield* git(["rev-parse", "--git-path", "index", "--show-cdup"], cwd);
  if (said.code !== 0) {
    return null;
  }
  const [index, cdup = ""] = Str.split(said.stdout, "\n");
  const place = { index: path.resolve(cwd, index), root: path.resolve(cwd, cdup) };
  if (cdup === "" && dotGit !== null) {
    places.set(cwd, { ...place, dotGit });
  }
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
            // WARNING: read the index's time before copying, or a write meanwhile dates the copy later.
            const written = (yield* fs.stat(index)).mtime;
            yield* fs.copyFile(index, env.GIT_INDEX_FILE);
            // WARNING: git trusts a stat-matching entry unless the index is no newer than the file, so the copy keeps the index's own time.
            if (Option.isSome(written)) {
              const at = Math.floor(written.value.getTime() / 1000);
              yield* fs.utimes(env.GIT_INDEX_FILE, at, at);
            }
          }
          const added = yield* shell("git", ["add", "-A"], cwd, env);
          if (added.code !== 0) {
            return unmeasuredBy("add", added);
          }
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

// WARNING: an unmeasured tree never equals another, or every verification over the size cap would pass.
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
  if (!sameTree(start, end)) {
    return "unstable";
  }
  // WARNING: the exit code alone is never the verdict: an unstable tree says nothing about either expectation.
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
    if (place === null || !measured(from) || !measured(to) || from === to) {
      return [];
    }
    const diff = yield* git(
      ["diff-tree", "-r", "-z", "--no-renames", "--name-status", from, to],
      place.root,
    );
    if (diff.code !== 0) {
      return [];
    }
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
    // WARNING: ctime, not mtime: an extractor can set mtime back, as npm does.
    const info = yield* Effect.tryPromise(() => Bun.file(real).stat());
    const key = Arr.join(
      Arr.map([real, info.dev, info.ino, info.size, info.ctimeMs, info.mtimeMs], (part) =>
        part === null || part === undefined ? "" : globalThis.String(part),
      ),
      ":",
    );
    const known = digests.get(key);
    if (known !== undefined) {
      return `${real}@${known}`;
    }
    const digest = Bun.hash(yield* fs.readFile(real)).toString(16);
    digests.set(key, digest);
    return `${real}@${digest}`;
  });

const packageRoots = Effect.fn("Verify.packageRoots")(function* (cwd: string) {
  const path = yield* Path.Path;
  const top = yield* git(["rev-parse", "--show-toplevel"], cwd);
  if (top.code !== 0) {
    return [cwd];
  }
  const root = Str.trim(top.stdout);
  const listed = yield* git(["ls-files", "-z", "--", ":(glob)**/package.json"], root);
  if (listed.code !== 0) {
    return [cwd];
  }
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

// WARNING: a file rewritten in place inside a package goes unseen: only entry identity is read.
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
  if (names === null) {
    return `${root}:absent`;
  }
  const lines = [root];
  for (const name of Arr.sort(names, Order.String)) {
    if (pipe(name, Str.startsWith(".")) && name !== ".bin") {
      continue;
    }
    const { line, scope } = yield* identityLine(name, path.join(modules, name));
    lines.push(line);
    if (!scope) {
      continue;
    }
    for (const inner of Arr.sort(yield* fs.readDirectory(path.join(modules, name)), Order.String)) {
      lines.push((yield* identityLine(`${name}/${inner}`, path.join(modules, name, inner))).line);
    }
  }
  return Arr.join(lines, "\n");
});

/**
 * The environment a check runs in: the executable's real path and content, the runtimes
 * on PATH, `TOOLCHAIN_VARIABLES`, and the dependencies installed in `cwd`'s checkout, or for
 * one run isolated, the prepare that installs them in its own. Null where any of them cannot
 * be read, which no record can be reused under.
 */
export const environmentOf = Effect.fn("Verify.environmentOf")(
  function* (absolute: string, cwd: string, isolated?: Isolation | undefined) {
    const parts = [yield* identityOf(absolute)];
    for (const runtime of TOOLCHAIN_RUNTIMES) {
      const found = Bun.which(runtime, { PATH: Bun.env.PATH ?? "" });
      parts.push(`${runtime}=${found === null ? "" : yield* identityOf(found)}`);
    }
    for (const name of TOOLCHAIN_VARIABLES) {
      parts.push(`${name}=${Bun.env[name] ?? ""}`);
    }
    if (isolated === undefined) {
      for (const root of yield* packageRoots(cwd)) {
        parts.push(yield* installedAt(root));
      }
    } else {
      parts.push(
        `isolated after ${yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))(isolated.prepare ?? null)}`,
      );
    }
    return Bun.hash(Arr.join(parts, "\n")).toString(16);
  },
  Effect.orElseSucceed(() => null),
);

// WARNING: no time limit: a verification is superseded by a changed tree, it never expires.
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

// WARNING: set while Collie's own check runs, since its agents are idle then and a card would show a stale one.
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

// WARNING: a command run outside the Run would attach its real result to the wrong tree.
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
    if (root === null) {
      continue;
    }
    const inside = yield* real(root);
    if (here === inside || pipe(here, Str.startsWith(`${inside}${path.sep}`))) {
      return true;
    }
  }
  return false;
});

export const resolveExecutable = Effect.fn("Verify.resolveExecutable")(function* (
  executable: string,
  cwd: string,
) {
  const path = yield* Path.Path;
  if (pipe(executable, Str.includes(path.sep))) {
    return path.resolve(cwd, executable);
  }
  // WARNING: Bun.which, not `command -v`: command is a shell builtin, and no check runs through a shell.
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
  // WARNING: a rerun passes only if it ran alone and passed; at the baseline, a test the base lacks passes.
  readonly test?: FailedTest;
  readonly own?: boolean;
  /** Run in a detached checkout of its start tree under `checkouts`, after its prepare there. */
  readonly isolated?: Isolation & { readonly checkouts: string };
}

export interface Isolation {
  readonly prepare?: Prepare | undefined;
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
  return yield* startPrepared(runDir, what, yield* prepare(what), echo);
});

/** What a check is run with and on, read before it starts. */
interface Prepared {
  readonly absolute: string;
  readonly environment: string | null;
  readonly start: Snapshot;
  readonly placed?: Placed;
}

/** Where an isolated check runs, and how its prepare ended there. */
interface Placed {
  readonly checkout: string;
  /** What it spawns: the checkout's copy of an executable inside the repository. */
  readonly executable: string;
  readonly prepare?: { readonly exit: number; readonly seconds: number } & Prepare;
  readonly output?: { readonly stdout: string; readonly stderr: string };
}

const prepare = Effect.fn("Verify.prepare")(function* (what: Collected) {
  const absolute = yield* resolveExecutable(what.executable, what.cwd);
  if (absolute === null) {
    return yield* new VerifyRefused({ why: `nothing on PATH called "${what.executable}"` });
  }
  return {
    absolute,
    environment: yield* environmentOf(absolute, what.cwd, what.isolated),
    start: yield* fingerprint(what.cwd),
  };
});

/**
 * A detached checkout of `start`, which already holds the Worktree's untracked files and none
 * of its ignored ones, and the prepare run there first.
 */
const isolate = Effect.fn("Verify.isolate")(function* (
  what: Collected & { readonly isolated: NonNullable<Collected["isolated"]> },
  { start, absolute }: Prepared,
  request: string,
) {
  const path = yield* Path.Path;
  const refused = (why: string) =>
    new VerifyRefused({ why: `"${what.name}" cannot run isolated: ${why}` });
  if (
    start.fingerprint === "" ||
    start.fingerprint === TOO_LARGE ||
    start.fingerprint === UNMEASURED ||
    Str.includes(" ")(start.fingerprint)
  ) {
    return yield* refused(
      start.unmeasured ??
        "its tree is too large, has changed submodules or is not in a git checkout",
    );
  }
  const top = yield* git(["rev-parse", "--show-toplevel"], what.cwd);
  const root = Str.trim(top.stdout);
  const made = yield* baseTree(what.isolated.checkouts, root, start.head_sha, {
    tree: start.fingerprint,
    check: what.name,
    request,
  }).pipe(Effect.mapError((cause) => refused(cause.why)));
  const checkout = path.join(made, path.relative(root, what.cwd));
  const there = yield* fingerprint(checkout);
  if (!sameTree(there, start)) {
    return yield* refused(`its checkout ${made} is not the tree it started on`);
  }
  const executable = Str.startsWith(`${root}${path.sep}`)(absolute)
    ? path.join(made, path.relative(root, absolute))
    : absolute;
  const prepare = what.isolated.prepare;
  if (prepare === undefined) {
    return { checkout, executable };
  }
  const began = yield* Clock.currentTimeMillis;
  // ponytail: outside CheckProcesses, so a host replaced while it runs does not take it over.
  const ran = yield* shell(prepare.executable, [...prepare.argv], checkout);
  const seconds = ((yield* Clock.currentTimeMillis) - began) / 1000;
  return {
    checkout,
    executable,
    prepare: { ...prepare, argv: [...prepare.argv], exit: ran.code, seconds },
    output: { stdout: ran.stdout, stderr: ran.stderr ?? "" },
  };
});

const startPrepared = Effect.fn("Verify.startPrepared")(function* (
  runDir: string,
  what: Collected,
  prepared: Prepared,
  echo?: Echo,
): Effect.fn.Return<StartedCheck, VerifyRefused, Services | Scope.Scope> {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  let already = 0;
  if (what.log !== undefined) {
    yield* fs.makeDirectory(path.dirname(what.log), { recursive: true }).pipe(Effect.orDie);
    // WARNING: never emptied: a check taken over from another host may already have written to it.
    yield* fs.writeFileString(what.log, "", { flag: "a" }).pipe(Effect.orDie);
  }
  const toLog = (chunk: string) => {
    if (what.log === undefined || handle.logged) {
      return Effect.void;
    }
    const next = logged(chunk, already);
    already = next.logged;
    return next.text === ""
      ? Effect.void
      : fs.writeFileString(what.log, next.text, { flag: "a" }).pipe(Effect.ignore);
  };
  const checks = yield* CheckProcesses;
  const handle = yield* checks
    .run(checkOf(what), yield* toRun(runDir, what, prepared), echo?.said)
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
  if (handle.id === null) {
    return yield* Effect.never;
  }
  if (echo?.started !== undefined) {
    yield* echo.started(handle.id);
  }
  if (echo?.said !== undefined) {
    const pid = yield* handle.pid;
    if (pid !== null) {
      yield* echo.said(`"${what.name}" started, pid ${pid}`);
    }
  }
  // WARNING: only each stream's tail is kept, so a long-running check cannot grow memory.
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

const checkOf = (what: Collected) => ({
  run: what.run,
  name: what.name,
  by: what.by,
  ...(what.pass && { pass: what.pass }),
});

/** What a check runs, where, and what finishing its record takes. */
const toRun = Effect.fn("Verify.toRun")(function* (
  runDir: string,
  what: Collected,
  { absolute, environment, start, placed }: Prepared,
) {
  const atStep = yield* CurrentStep;
  return {
    executable: placed?.executable ?? absolute,
    argv: what.argv,
    cwd: placed?.checkout ?? what.cwd,
    spec: {
      evidence: runDir,
      asked: what.executable,
      start,
      began: yield* nowIso,
      expect: what.expect ?? "pass",
      step: what.step === undefined ? atStep : { step: what.step, place: what.place ?? null },
      ...(what.log !== undefined && { log: what.log }),
      ...(what.test !== undefined && { test: what.test }),
      ...(what.own !== undefined && { own: what.own }),
      ...(environment !== null && { environment }),
      ...(placed !== undefined && {
        isolated: {
          cwd: what.cwd,
          executable: absolute,
          checkout: placed.checkout,
          ...(placed.prepare !== undefined && { prepare: placed.prepare }),
        },
      }),
    },
  };
});

/**
 * The Verification of a check that exited with `exit`, from its record and output alone, so
 * any host on its state directory can finish it; appended to its Run's evidence.
 */
export const finishCheck = (id: string, name: string, exit: number) =>
  Effect.flatMap(readCheck(id, name), (read) => settleCheck(read, exit));

const readCheck = Effect.fn("Verify.readCheck")(function* (id: string, name: string) {
  const found = yield* (yield* CheckProcesses)
    .finished(id)
    .pipe(Effect.mapError(noVerdict(name, "output", "read")));
  if (found === null) {
    return yield* Effect.die(`check ${id} has no record to finish it from`);
  }
  return {
    ...found,
    tail: { stdout: tail(found.output.stdout), stderr: tail(found.output.stderr) },
  };
});

type Asker = NonNullable<Verification["answered"]>[number];

const askerOf = (what: Pick<Collected, "by" | "pass">): Asker => ({
  by: what.by,
  ...passFields(what.pass),
});

const settleCheck = Effect.fn("Verify.settleCheck")(function* (
  { check, command, tail: { stdout, stderr } }: Effect.Success<ReturnType<typeof readCheck>>,
  exit: number,
  joined: ReadonlyArray<Asker> = [],
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

  const prepareFailed = spec.isolated?.prepare !== undefined && spec.isolated.prepare.exit !== 0;
  const record: Verification = {
    id: `${check.run}-${check.name}-${epochMs(at)}`,
    run: check.run,
    name: check.name,
    executable: spec.isolated?.executable ?? command.executable,
    asked: spec.asked,
    argv: [...command.argv],
    cwd: spec.isolated?.cwd ?? command.cwd,
    start: spec.start,
    end,
    exit,
    seconds: Math.max(0, (epochMs(at) - epochMs(spec.began)) / 1000),
    tail: { stdout, stderr },
    expect: spec.expect,
    result: prepareFailed ? "fail" : resultOf(spec.start, end, judged, spec.expect),
    at,
    by: check.by,
    ...passFields(passOf(check.pass)),
    ...(spec.isolated !== undefined && {
      isolated: {
        checkout: spec.isolated.checkout,
        ...(spec.isolated.prepare !== undefined && { prepare: spec.isolated.prepare }),
      },
    }),
    ...(prepareFailed && { stage: "prepare" as const }),
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
  const stepped: Verification =
    spec.step === null
      ? loggedRecord
      : { ...loggedRecord, step: spec.step.step, place: spec.step.place };
  const kept: Verification =
    joined.length === 0
      ? stepped
      : { ...stepped, answered: [askerOf({ by: check.by, pass: passOf(check.pass) }), ...joined] };
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

export const collect = (
  runDir: string,
  what: Collected,
  /** Where each stream is shown as it arrives, for a caller watching the command run. */
  echo?: Echo,
) =>
  Effect.gen(function* () {
    const prepared = yield* prepare(what);
    const key = sharedRunOf(runDir, what, prepared);
    if (key === null) {
      return yield* collectPrepared(runDir, what, prepared, `unshared ${++unshared}`, echo);
    }
    for (;;) {
      const running = underWay.get(key);
      if (running === undefined) {
        break;
      }
      running.joined.push(askerOf(what));
      if (echo?.said !== undefined) {
        yield* echo.said(`"${what.name}" is already running on this tree: waiting on it`);
      }
      const exit = yield* Effect.exit(Deferred.await(running.done));
      // Where the run it waited on was ended, it runs anew.
      if (!Exit.hasInterrupts(exit)) {
        return yield* exit;
      }
    }
    const entry: UnderWay = { done: Deferred.makeUnsafe(), joined: [] };
    underWay.set(key, entry);
    const close = Effect.sync(() => {
      if (underWay.get(key) === entry) {
        underWay.delete(key);
      }
      return entry.joined;
    });
    return yield* collectPrepared(runDir, what, prepared, key, echo, close).pipe(
      Effect.onExit((exit) => Effect.andThen(close, Deferred.done(entry.done, exit))),
    );
  }).pipe(Effect.withSpan("Verify.collect"));

const collectPrepared = (
  runDir: string,
  what: Collected,
  prepared: Prepared,
  /** Identifies the run, so requests not sharing one never share an isolated checkout. */
  request: string,
  echo?: Echo,
  /** Takes the identical requests that joined it, after which none more do. */
  close: Effect.Effect<ReadonlyArray<Asker>> = Effect.succeed([]),
) =>
  Effect.gen(function* () {
    const placed =
      what.isolated === undefined
        ? undefined
        : yield* isolate({ ...what, isolated: what.isolated }, prepared, request);
    const ready: Prepared = placed === undefined ? prepared : { ...prepared, placed };
    if (placed?.prepare !== undefined && placed.prepare.exit !== 0) {
      return yield* settleCheck(
        yield* unprepared(runDir, what, ready, placed.output ?? { stdout: "", stderr: "" }),
        placed.prepare.exit,
        yield* close,
      );
    }
    return yield* startPrepared(runDir, what, ready, echo).pipe(
      Effect.flatMap((started) =>
        Effect.zipWith(
          started.exit,
          readCheck(started.id, what.name),
          (exit, read) => [read, exit] as const,
        ),
      ),
      // Its Scope ends what is left of it before the tree is looked at again.
      Effect.scoped,
      Effect.flatMap(([read, exit]) =>
        Effect.flatMap(close, (joined) => settleCheck(read, exit, joined)),
      ),
    );
  });

/** A check whose prepare failed, finished from the prepare's output without running it. */
const unprepared = Effect.fn("Verify.unprepared")(function* (
  runDir: string,
  what: Collected,
  prepared: Prepared,
  output: { readonly stdout: string; readonly stderr: string },
) {
  const command = yield* toRun(runDir, what, prepared);
  if (what.log !== undefined) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    yield* fs.makeDirectory(path.dirname(what.log), { recursive: true }).pipe(Effect.ignore);
    yield* fs
      .writeFileString(what.log, `${output.stdout}${output.stderr}`, { flag: "a" })
      .pipe(Effect.ignore);
  }
  return {
    check: checkOf(what),
    command,
    output,
    tail: { stdout: tail(output.stdout), stderr: tail(output.stderr) },
  };
});

interface UnderWay {
  readonly done: Deferred.Deferred<Verification, VerifyRefused>;
  readonly joined: Array<Asker>;
}

// ponytail: in memory, as only this process's requests can wait on its run.
const underWay = new Map<string, UnderWay>();
let unshared = 0;

/** What makes two requests one run, or null where the tree or environment cannot be known. */
const sharedRunOf = (runDir: string, what: Collected, prepared: Prepared) =>
  prepared.environment === null ||
  prepared.start.fingerprint === TOO_LARGE ||
  prepared.start.fingerprint === UNMEASURED
    ? null
    : JSON.stringify([
        runDir,
        what.run,
        prepared.absolute,
        what.argv,
        what.cwd,
        prepared.start.fingerprint,
        prepared.environment,
        what.expect ?? "pass",
        what.test ?? null,
        what.own ?? null,
      ]);

function passOf(given: CheckOf["pass"]) {
  if (given === undefined || !Schema.is(Pass)(given.pass)) {
    return undefined;
  }
  return given.round === undefined
    ? { pass: given.pass }
    : { pass: given.pass, round: given.round };
}

function passFields(given: CheckPass | undefined) {
  if (given === undefined) {
    return {};
  }
  if (given.round === undefined) {
    return { pass: given.pass };
  }
  return { pass: given.pass, round: given.round };
}

export type CheckRun = {
  readonly id: string;
  readonly cwd: string;
  readonly worktree: string | null;
  /** Where its isolated checks' checkouts are made, under its state. */
  readonly checkouts?: string;
};

/** How a check marked isolated is run; undefined for one that is not. */
export const isolationOf = (spec: VerifySpec): Isolation | undefined =>
  spec.isolated === true ? { prepare: spec.prepare } : undefined;

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
) {
  const match = Option.getOrUndefined(
    Arr.findFirst(approved, (entry) => entry.name === spec.name && sameCommand(entry, spec)),
  );
  if (!match) {
    return yield* new VerifyRefused({
      why: `"${spec.name}" is not among this Run's checks, argument for argument`,
    });
  }
  const cwd = yield* checkCwd(run, spec);
  if (!(yield* insideRun(cwd, run))) {
    return yield* new VerifyRefused({ why: `"${cwd}" is not inside run ${run.id}` });
  }
  const isolation = isolationOf(spec);
  const isolated =
    isolation === undefined || run.checkouts === undefined
      ? undefined
      : { ...isolation, checkouts: run.checkouts };
  if (isolation !== undefined && isolated === undefined) {
    return yield* new VerifyRefused({
      why: `"${spec.name}" is isolated and run ${run.id} names nowhere to check it out`,
    });
  }
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
    ...(isolated !== undefined && { isolated }),
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
  if (!(yield* insideRun(cwd, run))) {
    return yield* new VerifyRefused({ why: `"${cwd}" is not inside run ${run.id}` });
  }
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

/** Why no record answers for a command now: exactly one reason, naming the record compared with. */
export type Miss =
  | { readonly reason: "none" }
  | {
      readonly reason: "command" | "tree" | "unstable" | "environment" | "before-host";
      readonly record: string;
    };

/** What a lookup found: a record, or why none answers. */
export type Reuse =
  | { readonly record: Verification; readonly miss: null }
  | { readonly record: null; readonly miss: Miss };

const missed = (miss: Miss): Reuse => ({ record: null, miss });

/** Why it was not reused, as the Run's log and `collie verify` say it. */
export const missSaid = (miss: Miss): string => {
  switch (miss.reason) {
    case "none":
      return "no record of this command on this Run";
    case "command":
    case "tree":
    case "environment":
      return `the ${miss.reason} differs from verification ${miss.record}'s`;
    case "unstable":
      return `verification ${miss.record} on this tree is unstable or expected red`;
    case "before-host":
      return `verification ${miss.record} was collected before this host started`;
  }
};

/**
 * The latest record of exactly this command on this tree, where it was collected in this
 * environment since `since`, stable and expecting what was asked. Whoever asked for it does
 * not matter: the host ran it. A run of one failed test is never the command's own.
 */
function latestRecord(
  records: ReadonlyArray<Verification>,
  wanted: Pick<Verification, "name" | "executable" | "argv" | "cwd"> & {
    readonly environment: string | null;
    readonly expect?: Verification["expect"];
  },
  now: Snapshot,
  since: string,
) {
  const own = Arr.filter(records, (one) => !ranOneTest(one));
  const same = Arr.filter(own, (one) => sameCommand(one, wanted));
  const last = Arr.last(same);
  if (Option.isNone(last)) {
    const named = Arr.findLast(own, (one) => one.name === wanted.name);
    return missed(
      Option.isNone(named) ? { reason: "none" } : { reason: "command", record: named.value.id },
    );
  }
  const onTree = Option.getOrUndefined(Arr.findLast(same, (one) => !staleAgainst(one, now)));
  if (onTree === undefined) {
    return missed({ reason: "tree", record: last.value.id });
  }
  const record = onTree.id;
  if (onTree.result === "unstable" || (wanted.expect ?? onTree.expect) !== onTree.expect) {
    return missed({ reason: "unstable", record });
  }
  if (wanted.environment === null || onTree.environment !== wanted.environment) {
    return missed({ reason: "environment", record });
  }
  if (epochMs(onTree.at) <= epochMs(since)) {
    return missed({ reason: "before-host", record });
  }
  return { record: onTree, miss: null };
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
  expect?: Verification["expect"],
) {
  const cwd = yield* checkCwd(run, spec);
  const executable = yield* resolveExecutable(spec.executable, cwd);
  if (executable === null) {
    return missed({ reason: "none" });
  }
  return latestRecord(
    yield* readVerifications(runDir).pipe(Effect.orElseSucceed(() => [])),
    {
      name: spec.name,
      executable,
      argv: spec.argv,
      cwd,
      environment: yield* environmentOf(executable, cwd, isolationOf(spec)),
      ...(expect !== undefined && { expect }),
    },
    yield* fingerprint(cwd),
    since,
  );
});

export const recordedFor = Effect.fn("Verify.recordedFor")(function* (
  runDir: string,
  wanted: Pick<Verification, "name" | "executable" | "argv" | "cwd" | "expect"> & {
    readonly isolated?: Isolation | undefined;
  },
  since: string,
) {
  return latestRecord(
    Arr.filter(
      yield* readVerifications(runDir).pipe(Effect.orElseSucceed(() => [])),
      (one) => one.name === wanted.name,
    ),
    {
      ...wanted,
      environment: yield* environmentOf(wanted.executable, wanted.cwd, wanted.isolated),
    },
    yield* fingerprint(wanted.cwd),
    since,
  );
});

/** `recordFor` a pass; a record that failed on this tree answers nothing, and is no miss. */
export const reliedFor = (runDir: string, run: CheckRun, spec: VerifySpec, since: string) =>
  recordFor(runDir, run, spec, since, "pass").pipe(
    Effect.map((found): { readonly record: Verification | null; readonly miss: Miss | null } =>
      found.record === null || passed(found.record) ? found : { record: null, miss: null },
    ),
  );

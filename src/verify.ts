// An agent saying "the tests pass" is a claim. This is the other thing: a command whose
// exit Collie watched, bound to the exact tree it ran on.
//
// The binding is what makes it worth anything. A pass on a tree that changed while the
// command ran says nothing about either tree, so a verification whose start and end
// snapshots differ is `unstable` — never `pass`, and never quietly re-run.
//
// Nothing here goes through a shell. The command is an executable and an argument list,
// resolved once and recorded as an absolute path, so what was approved is what ran.

import { Data, Effect, FileSystem, Path, Schema } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { Stream } from "effect";
import type { VerifySpec } from "./intent";
import { appendJournal, readJournal } from "./journal";
import { shell } from "./mr";
import { nowIso } from "./time";

/** Over this many bytes of working-tree content, the tree is not fingerprinted at all. */
export const FINGERPRINT_MAX_BYTES = 50 * 1024 * 1024;

/** How much of each stream is kept: enough to see what failed, not a transcript. */
const TAIL_BYTES = 4 * 1024;

/**
 * A tree too large to fingerprint. Two of these are **not** equality: they say the same
 * thing about two trees nobody looked at, and treating them as equal would turn every
 * verification on a big repository into a `pass`.
 */
export const TOO_LARGE = "unstable:too-large";

const SnapshotSchema = Schema.Struct({ head_sha: Schema.String, fingerprint: Schema.String });
export type Snapshot = Schema.Schema.Type<typeof SnapshotSchema>;

const VerificationSchema = Schema.Struct({
  id: Schema.String,
  run: Schema.String,
  name: Schema.String,
  executable: Schema.String,
  argv: Schema.Array(Schema.String),
  cwd: Schema.String,
  start: SnapshotSchema,
  end: SnapshotSchema,
  exit: Schema.Int,
  seconds: Schema.Number,
  tail: Schema.Struct({ stdout: Schema.String, stderr: Schema.String }),
  /**
   * What a pass looks like for this command. `fail` is how a bug is proved to exist: a
   * regression test that exits non-zero on the tree before the fix is the evidence, and
   * calling that a failure would make reproducing a bug indistinguishable from not
   * having fixed it. Records written before this decode as `pass`, which is what they were.
   */
  expect: Schema.Literals(["pass", "fail"]).pipe(
    Schema.withDecodingDefaultKey(Effect.succeed("pass" as const)),
  ),
  result: Schema.Literals(["pass", "fail", "unstable"]),
  at: Schema.String,
  /** Who collected it. An agent may run one; only Collie may run an approved spec. */
  by: Schema.Literals(["agent", "collie"]),
});
export type Verification = Schema.Schema.Type<typeof VerificationSchema>;
const VerificationJson = Schema.fromJsonString(VerificationSchema);

export class VerifyRefused extends Data.TaggedError("VerifyRefused")<{ why: string }> {}

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
export const fingerprint = Effect.fn("Verify.fingerprint")(function* (cwd: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const head = yield* git(["rev-parse", "HEAD"], cwd);
  const head_sha = head.code === 0 ? head.stdout.trim() : "";

  const status = yield* git(["status", "--porcelain=v2", "-z"], cwd);
  const diff = yield* git(["diff", "HEAD", "--binary"], cwd);
  const others = yield* git(["ls-files", "--others", "--exclude-standard", "-z"], cwd);

  const parts = [status.stdout, Bun.hash(diff.stdout).toString(16)];
  let bytes = status.stdout.length + diff.stdout.length;
  for (const relative of others.stdout.split("\0")) {
    if (relative === "") continue;
    const file = path.join(cwd, relative);
    const size = yield* fs.stat(file).pipe(
      Effect.map((info) => Number(info.size)),
      Effect.catch(() => Effect.succeed(0)),
    );
    bytes += size;
    if (bytes > FINGERPRINT_MAX_BYTES) return { head_sha, fingerprint: TOO_LARGE };
    const content = yield* fs.readFileString(file).pipe(Effect.catch(() => Effect.succeed("")));
    parts.push(`${relative}:${Bun.hash(content).toString(16)}`);
  }
  return { head_sha, fingerprint: Bun.hash(parts.join("\n")).toString(16) };
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
    fs.realPath(dir).pipe(Effect.catch(() => Effect.succeed(path.resolve(dir))));
  const here = yield* real(cwd);
  for (const root of [run.cwd, run.worktree]) {
    if (root === null) continue;
    const inside = yield* real(root);
    if (here === inside || here.startsWith(`${inside}${path.sep}`)) return true;
  }
  return false;
});

/** The executable as PATH resolves it now, recorded absolute so the record says what ran. */
export const resolveExecutable = Effect.fn("Verify.resolveExecutable")(function* (
  executable: string,
  cwd: string,
) {
  const path = yield* Path.Path;
  if (executable.includes(path.sep)) return path.resolve(cwd, executable);
  // `Bun.which` and not a `command -v` subprocess: `command` is a shell builtin, and
  // reaching for a shell to find out what to run without a shell is the wrong shape.
  return Bun.which(executable, { PATH: Bun.env.PATH ?? "" });
});

function tail(text: string): string {
  return text.length <= TAIL_BYTES ? text : text.slice(-TAIL_BYTES);
}

/** Where a command's two streams are shown while it runs. */
export interface Echo {
  readonly stdout: (text: string) => Effect.Effect<void>;
  readonly stderr: (text: string) => Effect.Effect<void>;
}

export interface Collected {
  readonly run: string;
  readonly name: string;
  readonly executable: string;
  readonly argv: ReadonlyArray<string>;
  readonly cwd: string;
  readonly by: "agent" | "collie";
  readonly expect?: "pass" | "fail";
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

  const start = yield* fingerprint(what.cwd);
  const began = yield* nowIso();
  // No shell, and the argument list whole: a verification's value is that what ran is
  // what was written down, and a shell string is a second language in between.
  const [stdout, stderr, exit] = yield* Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const handle = yield* spawner.spawn(
      ChildProcess.make(absolute, [...what.argv], {
        cwd: what.cwd,
        stdout: "pipe",
        stderr: "pipe",
        extendEnv: true,
      }),
    );
    // Tailed as it arrives, never folded whole: only the last 4 KiB is recorded, and a
    // verification that prints for an hour must not allocate for an hour to say so.
    const drain = (stream: typeof handle.stdout, shown?: (text: string) => Effect.Effect<void>) =>
      stream.pipe(
        Stream.decodeText(),
        Stream.tap((chunk) => (shown === undefined ? Effect.void : shown(chunk))),
        Stream.runFold(
          () => "",
          (kept: string, chunk: string) => tail(kept + chunk),
        ),
      );
    return yield* Effect.all(
      [drain(handle.stdout, echo?.stdout), drain(handle.stderr, echo?.stderr), handle.exitCode],
      {
        concurrency: "unbounded",
      },
    );
  }).pipe(Effect.scoped, Effect.orDie);
  const end = yield* fingerprint(what.cwd);
  const at = yield* nowIso();

  const record: Verification = {
    id: `${what.run}-${what.name}-${Date.parse(at)}`,
    run: what.run,
    name: what.name,
    executable: absolute,
    argv: [...what.argv],
    cwd: what.cwd,
    start,
    end,
    exit: Number(exit),
    seconds: Math.max(0, (Date.parse(at) - Date.parse(began)) / 1000),
    tail: { stdout, stderr },
    expect: what.expect ?? "pass",
    result: resultOf(start, end, Number(exit), what.expect ?? "pass"),
    at,
    by: what.by,
  };
  yield* appendVerification(runDir, record).pipe(Effect.orDie);
  return record;
});

/**
 * A verification Collie runs itself, which it may do only for a command the human wrote
 * into the Run's authority — exactly, argument by argument. The wrapper is part of what
 * was approved: `npm test` and `npm test -- --bail` are not the same permission.
 */
export const runApproved = Effect.fn("Verify.runApproved")(function* (
  runDir: string,
  run: { readonly id: string; readonly cwd: string; readonly worktree: string | null },
  approved: ReadonlyArray<VerifySpec>,
  spec: VerifySpec,
  expect: "pass" | "fail" = "pass",
): Effect.fn.Return<Verification, VerifyRefused, Services> {
  const match = approved.find(
    (entry) =>
      entry.name === spec.name &&
      entry.executable === spec.executable &&
      entry.cwd === spec.cwd &&
      entry.argv.length === spec.argv.length &&
      entry.argv.every((word, at) => word === spec.argv[at]),
  );
  if (!match)
    return yield* new VerifyRefused({
      why: `"${spec.name}" is not among this Run's approved verifications, argument for argument`,
    });
  const path = yield* Path.Path;
  const cwd = spec.cwd === "worktree" ? (run.worktree ?? run.cwd) : path.resolve(run.cwd, spec.cwd);
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
  });
});

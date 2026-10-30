// What every doctor check is made of, shared by the doctor and each forge's own checks.

import * as Str from "effect/String";
import * as Arr from "effect/Array";
import { pipe as pipe_ } from "effect/Function";
import { Effect, FileSystem, Option, Path, Result } from "effect";
import type { ChildProcessSpawner } from "effect/process";
import type { Ran } from "./mr";

export interface Check {
  /** How the check is named, in the rendering and in `--json`. */
  name: string;
  ok: boolean;
  /** What was found. */
  detail: string;
  /** The command or the one thing to do about it; empty when there is nothing to fix. */
  fix: string;
  /** Set up and not working: nothing a Run needs by default, so `ok`, but shown as `!`. */
  warn?: boolean;
}

/**
 * What one check found. Every check chooses one of these once, rather than deciding
 * `ok`, `detail` and `fix` in three ternaries over the same condition — where a new
 * state means editing all three in step and a reader has to hold the predicate three
 * times to read one answer.
 */
export type Outcome = Omit<Check, "name">;

export const passed = (detail: string): Outcome => ({ ok: true, detail, fix: "" });
export const failed = (detail: string, fix: string): Outcome => ({ ok: false, detail, fix });
/** Nothing is wrong, but there is still something a reader may want to run. */
export const noted = (detail: string, fix: string): Outcome => ({ ok: true, detail, fix });
/** Configured and broken, for something no Run needs by default: not a failure, but not a ✓. */
export const warned = (detail: string, fix: string): Outcome => ({
  ok: true,
  detail,
  fix,
  warn: true,
});

/** How long a check that asks over a network may wait for its answer. */
export const FETCH_LIMIT = "20 seconds";

/**
 * A command that answers or is taken to have said nothing. An install ends by running
 * `doctor`, so nothing it asks over a network may wait on an unreachable host for as
 * long as it likes.
 */
export const answered = (
  command: Effect.Effect<Ran, never, ChildProcessSpawner.ChildProcessSpawner>,
) =>
  Effect.timeoutOption(command, FETCH_LIMIT).pipe(
    Effect.map(Option.getOrElse((): Ran => ({ code: 124, stdout: "", stderr: "timed out" }))),
  );

/**
 * The first directory on PATH holding `name` as something this machine can run, or
 * null. The executable bit is the question, not the file: a shim or a harness that
 * is there but not executable fails with permission denied at the point of use,
 * which is exactly the confusion `doctor` exists to end.
 */
export const onPath = Effect.fn("Doctor.onPath")(function* (search: string, name: string) {
  const path = yield* Path.Path;
  for (const dir of Arr.filter(Str.split(search, ":"), (d) => d !== "")) {
    if (yield* runnable(path.join(dir, name))) return dir;
  }
  return null;
});

export const runnable = Effect.fn("Doctor.runnable")(function* (file: string) {
  const fs = yield* FileSystem.FileSystem;
  const info = yield* Effect.result(fs.stat(file));
  return Result.isSuccess(info) && (info.success.mode & 0o111) !== 0;
});

/** The JSON object in a command's output, from the line it starts on, so a preamble is skipped. */
export const jsonIn = (text: string) => {
  const lines = Str.split(text, "\n");
  const from = Option.getOrElse(
    Arr.findFirstIndex(lines, (line) => pipe_(Str.trimStart(line), Str.startsWith("{"))),
    () => -1,
  );
  const json = from === -1 ? "" : Arr.join(lines.slice(from), "\n");
  return pipe_(
    json,
    Str.slice(0, Option.getOrElse(pipe_(json, Str.lastIndexOf("}")), () => -1) + 1),
  );
};

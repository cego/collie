import * as Str from "effect/String";
import * as Arr from "effect/Array";
import { pipe as pipe_ } from "effect/Function";
import { Effect, FileSystem, Option, Path, Result } from "effect";
import type { ChildProcessSpawner } from "effect/process";
import type { Ran } from "./mr";

export interface Check {
  name: string;
  ok: boolean;
  detail: string;
  fix: string;
  warn?: boolean;
}

export type Outcome = Omit<Check, "name">;

export const passed = (detail: string) => ({ ok: true, detail, fix: "" });
export const failed = (detail: string, fix: string) => ({ ok: false, detail, fix });
export const noted = (detail: string, fix: string) => ({ ok: true, detail, fix });
export const warned = (detail: string, fix: string) => ({
  ok: true,
  detail,
  fix,
  warn: true,
});

export const FETCH_LIMIT = "20 seconds";

export const answered = (
  command: Effect.Effect<Ran, never, ChildProcessSpawner.ChildProcessSpawner>,
) =>
  Effect.timeoutOption(command, FETCH_LIMIT).pipe(
    Effect.map(Option.getOrElse(() => ({ code: 124, stdout: "", stderr: "timed out" }))),
  );

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

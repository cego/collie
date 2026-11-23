import * as Arr from "effect/Array";
import * as Str from "effect/String";
import { pipe as pipe_ } from "effect/Function";
import * as Base64 from "effect/encoding/Base64";
import { Effect, Result } from "effect";
import type { RunFile } from "./board-model";

export const DEFAULT_LINES = 200;

export interface LinesAsked {
  readonly start: number;
  readonly count: number;
  readonly search: string | null;
}

export const linesError = (asked: LinesAsked) => {
  if (asked.count < 1) {
    return `count takes 1 or more; not ${asked.count}.`;
  }
  if (asked.search === null) {
    return null;
  }
  const valid = Result.try(() => new RegExp(asked.search!));
  return Result.isFailure(valid)
    ? `"${asked.search}" is not a search pattern: ${String(valid.failure)}`
    : null;
};

export const linesOf = (ref: string, text: string, asked: LinesAsked) => {
  const all = text === "" ? [] : Str.split(pipe_(text, Str.replace(/\n$/, "")), "\n");
  const total = all.length;
  const from = Math.max(1, asked.start);
  const at = (line: number) => all[line - 1] ?? null;
  const answer = (
    to: number,
    lines: ReadonlyArray<{
      line: number;
      text: string;
      before?: string | null;
      after?: string | null;
    }>,
  ) => ({
    ref,
    total,
    from,
    to,
    lines,
    complete: to >= total,
    next: to >= total ? null : to + 1,
  });
  if (asked.search === null) {
    const to = Math.min(total, from + asked.count - 1);
    return answer(
      to,
      Arr.makeBy(Math.max(0, to - from + 1), (i) => ({ line: from + i, text: at(from + i)! })),
    );
  }
  const pattern = new RegExp(asked.search);
  const found: Array<{ line: number; text: string; before: string | null; after: string | null }> =
    [];
  for (let line = from; line <= total; line++) {
    if (!pattern.test(at(line)!)) {
      continue;
    }
    if (found.length === asked.count) {
      return answer(line - 1, found);
    }
    found.push({ line, text: at(line)!, before: at(line - 1), after: at(line + 1) });
  }
  return answer(total, found);
};

export const wholeText = <E, R>(part: (offset: number) => Effect.Effect<RunFile, E, R>) =>
  Effect.gen(function* () {
    const parts: Array<Uint8Array> = [];
    let read = 0;
    let size = 0;
    do {
      const got = yield* part(read);
      const bytes =
        got.encoding === "utf8"
          ? new TextEncoder().encode(got.content)
          : Result.getOrElse(Base64.decode(got.content), () => new Uint8Array());
      if (bytes.length === 0) {
        break;
      }
      parts.push(bytes);
      read += bytes.length;
      size = got.size;
    } while (read < size);
    const whole = Buffer.concat(parts);
    if (whole.includes(0)) {
      return null;
    }
    return Result.getOrNull(
      Result.try(() => new TextDecoder("utf-8", { fatal: true }).decode(whole)),
    );
  });

import * as Str from "effect/String";
import { pipe as pipe_ } from "effect/Function";
import { Effect, FileSystem, Option, Schema, Semaphore, Stream } from "effect";
export interface LogTail {
  readonly panel: { readonly _tag: "Text"; readonly text: string; readonly truncated: boolean };
  readonly firstLine: number;
}
const Index = Schema.fromJsonString(
  Schema.Struct({ bytes: Schema.Finite, lines: Schema.Finite, ended: Schema.Boolean }),
);
const writing = Semaphore.makeUnsafe(1);
const indexOf = Effect.fn("RunLog.index")(function* (dir: string) {
  const fs = yield* FileSystem.FileSystem;
  const size = yield* fs.stat(`${dir}/log.txt`).pipe(
    Effect.map((info) => Number(info.size)),
    Effect.orElseSucceed(() => 0),
  );
  const known = yield* fs
    .readFileString(`${dir}/log-index.json`)
    .pipe(Effect.flatMap(Schema.decodeUnknownEffect(Index)), Effect.option);
  if (Option.isSome(known) && known.value.bytes === size) return known.value;
  const counted =
    size === 0
      ? { lines: 0, ended: true }
      : yield* fs.stream(`${dir}/log.txt`).pipe(
          Stream.runFold(
            () => ({ lines: 0, ended: true }),
            (count, chunk) => ({
              lines: count.lines + chunk.reduce((n, byte) => n + Number(byte === 10), 0),
              ended: chunk.length === 0 ? count.ended : chunk.at(-1) === 10,
            }),
          ),
        );
  const index = { bytes: size, ...counted };
  yield* fs.writeFileString(
    `${dir}/log-index.json`,
    yield* Schema.encodeEffect(Index)(index).pipe(Effect.orDie),
  );
  return index;
});

export const appendLogLine = Effect.fn("RunLog.append")(function* (dir: string, line: string) {
  const fs = yield* FileSystem.FileSystem;
  yield* fs.makeDirectory(dir, { recursive: true });
  const before = yield* indexOf(dir);
  const prefix = before.ended ? "" : "\n";
  const text = `${prefix}${line}\n`;
  const first = before.lines + (before.ended ? 1 : 2);
  yield* fs.writeFileString(`${dir}/log.txt`, text, { flag: "a" });
  yield* fs.writeFileString(
    `${dir}/log-index.json`,
    yield* Schema.encodeEffect(Index)({
      bytes: before.bytes + Buffer.byteLength(text),
      lines: before.lines + Str.split(text, "\n").length - 1,
      ended: true,
    }).pipe(Effect.orDie),
  );
  return first;
}, writing.withPermits(1));

export const readLogTail = Effect.fn("RunLog.tail")(function* (
  dir: string,
  cap: number,
): Effect.fn.Return<
  LogTail | null,
  import("effect/PlatformError").PlatformError,
  FileSystem.FileSystem
> {
  const fs = yield* FileSystem.FileSystem;
  if (!(yield* fs.exists(`${dir}/log.txt`))) return null;
  const index = yield* indexOf(dir);
  const from = Math.max(0, index.bytes - cap);
  const raw = yield* fs
    .stream(`${dir}/log.txt`, { offset: from })
    .pipe(Stream.decodeText(), Stream.mkString);
  const text =
    from === 0
      ? raw
      : pipe_(raw, Str.includes("\n"))
        ? pipe_(raw, Str.slice(Option.getOrElse(pipe_(raw, Str.indexOf("\n")), () => -1) + 1))
        : "";
  const shown =
    text === "" ? 0 : Str.split(text, "\n").length - Number(pipe_(text, Str.endsWith("\n")));
  return {
    panel: { _tag: "Text", text, truncated: from > 0 },
    firstLine: index.lines + Number(!index.ended) - shown + 1,
  };
}, writing.withPermits(1));

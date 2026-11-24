import * as Arr from "effect/Array";
import { Effect, FileSystem, Logger } from "effect";

const MAX_BYTES = 1024 * 1024;

export const isHostLog = (path: string) => /^host\.(log|out)(\.\d+)?$/.test(path);

export const hostLogger = (file: string, maxBytes: number = MAX_BYTES) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const append = (lines: ReadonlyArray<string>) =>
      Effect.gen(function* () {
        const bytes = new TextEncoder().encode(`${Arr.join(lines, "\n")}\n`);
        const size = yield* fs.stat(file).pipe(
          Effect.map((info) => Number(info.size)),
          Effect.orElseSucceed(() => 0),
        );
        if (size > 0 && size + bytes.length > maxBytes) {
          yield* fs.rename(file, `${file}.1`);
        }
        yield* fs.writeFile(file, bytes, { flag: "a" });
      }).pipe(Effect.ignore);
    // WARNING: Flushed often: a host stopped past its grace exits without flushing.
    return yield* Logger.batched(Logger.formatLogFmt, { window: "100 millis", flush: append });
  });

// WARNING: Copied and emptied in place: a rename would leave the writer on the old file.
export const rotateInPlace = (file: string, maxBytes: number = MAX_BYTES) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const size = Number((yield* fs.stat(file)).size);
    if (size <= maxBytes) {
      return;
    }
    yield* fs.copyFile(file, `${file}.1`);
    yield* fs.truncate(file);
  }).pipe(Effect.ignore);

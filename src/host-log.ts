// The host's own log, kept beside its state, so a host that wedges leaves a trail.

import { Effect, FileSystem, Logger } from "effect";

/** The log is never larger than this; what came before is kept once, as `<file>.1`. */
const MAX_BYTES = 1024 * 1024;

/** A logger appending to `file`, which starts again from empty once it would pass `maxBytes`. */
export const hostLogger = (file: string, maxBytes: number = MAX_BYTES) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const append = (lines: ReadonlyArray<string>) =>
      Effect.gen(function* () {
        const text = `${lines.join("\n")}\n`;
        const size = yield* fs.stat(file).pipe(
          Effect.map((info) => Number(info.size)),
          Effect.orElseSucceed(() => 0),
        );
        if (size > 0 && size + text.length > maxBytes) yield* fs.rename(file, `${file}.1`);
        yield* fs.writeFileString(file, text, { flag: "a" });
      }).pipe(Effect.ignore);
    // Flushed often, because a host stopped past its grace exits without flushing.
    return yield* Logger.batched(Logger.formatLogFmt, { window: "100 millis", flush: append });
  });

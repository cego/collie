import { test } from "bun:test";
import { Config, Effect, FileSystem, Schedule } from "effect";
import { runEffect } from "../../support/effect";

test(
  "a small file",
  () =>
    runEffect(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const notes = yield* Config.String("COLLIE_BARE_NOTES");
        yield* fs.writeFileString(`${notes}/started`, "");
        yield* fs.exists(`${notes}/release`).pipe(
          Effect.repeat({
            until: (released) => released,
            schedule: Schedule.spaced("20 millis"),
          }),
        );
      }),
    ),
  60_000,
);

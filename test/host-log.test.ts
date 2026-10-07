import { expect, test } from "bun:test";
import { Effect, FileSystem, Logger } from "effect";
import { hostLogger } from "../src/host-log";
import { runEffect } from "./support/effect";

test("the host log starts again past its bound and keeps the one before it", () =>
  runEffect(
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const dir = yield* fs.makeTempDirectoryScoped({ prefix: "collie-host-log-" });
        const file = `${dir}/host.log`;
        // One flush per line, the way a host that logs now and then writes them.
        for (let n = 1; n <= 10; n++) {
          yield* Effect.scoped(
            Effect.flatMap(hostLogger(file, 250), (logger) =>
              Effect.log(`line ${n} ${"x".repeat(40)}`).pipe(
                Effect.provide(Logger.layer([logger])),
              ),
            ),
          );
        }
        const newest = yield* fs.readFileString(file);
        expect(newest).toContain("line 10 ");
        expect(newest).not.toContain("line 1 ");
        expect(newest.length).toBeLessThanOrEqual(250);
        expect(yield* fs.readFileString(`${file}.1`)).toContain("line 8 ");
      }),
    ),
  ));

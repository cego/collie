import * as Str from "effect/String";
import { pipe as pipe_ } from "effect/Function";
import { expect, test } from "bun:test";
import { Effect, FileSystem, Logger } from "effect";
import { hostLogger, rotateInPlace } from "../src/host-log";
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
              Effect.log(`line ${n} ${pipe_("x", Str.repeat(40))}`).pipe(
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

test("kept output past its bound moves to the one before it, and its writer carries on in the same file", () =>
  runEffect(
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const dir = yield* fs.makeTempDirectoryScoped({ prefix: "collie-host-out-" });
        const file = `${dir}/host.out`;
        const writer = yield* fs.open(file, { flag: "a" });
        const write = (text: string) => writer.write(new TextEncoder().encode(text));
        yield* write("small\n");
        yield* rotateInPlace(file, 100);
        expect(yield* fs.exists(`${file}.1`)).toBe(false);

        yield* write(`${pipe_("x", Str.repeat(120))}\n`);
        yield* rotateInPlace(file, 100);
        expect(yield* fs.readFileString(`${file}.1`)).toContain("small");
        yield* write("after\n");
        expect(yield* fs.readFileString(file)).toBe("after\n");
      }),
    ),
  ));

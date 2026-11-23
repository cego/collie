import * as Arr from "effect/Array";
import { expect, test } from "bun:test";
import { Effect, FileSystem } from "effect";
import { readAudit } from "../src/audit";
import { connect } from "../src/host";
import { withLock } from "../src/lock";
import { tellHost } from "../src/tell-host";
import { fileTime } from "../src/time";
import { memoryRecords, runEffect } from "./support/effect";
import { until } from "./support/host";
import { twoMachines } from "./support/peers";
import type { Side } from "./support/peers";
import { proves } from "./support/world";

test("a definition created, edited, removed or edited on both reaches the other host by its latest edit", () =>
  runEffect(
    twoMachines(
      "collie-peer-definitions-",
      (first, second) =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const file = (side: Side, path: string) => `${side.world.config}/${path}`;
          const text = (side: Side, path: string) =>
            fs.readFileString(file(side, path)).pipe(Effect.orElseSucceed(() => null));
          const save = (side: Side, path: string, saved: string, at: string) =>
            Effect.gen(function* () {
              const staged = `${side.world.home}/staged`;
              yield* fs.writeFileString(staged, saved);
              yield* fs.utimes(staged, fileTime(at), fileTime(at));
              yield* fs.rename(staged, file(side, path));
            });
          // WARNING: nothing is watched; a hand edit reaches the other host once its own is told.
          const told = (side: Side, path: string) => tellHost(side.world.state, [file(side, path)]);
          for (const side of [first, second]) {
            yield* fs.writeFileString(
              file(side, "workflows/package.json"),
              `{ "name": "${side.name}" }\n`,
            );
          }
          yield* fs.writeFileString(file(first, "workflows/forked.workflow.ts"), "forked\n");

          yield* first.lists([second]);
          expect((yield* first.cli(["--machine", "second", "board"])).envelope.ok).toBe(true);
          yield* until(
            () => text(second, "workflows/forked.workflow.ts"),
            (has) => has === "forked\n",
          );

          yield* fs.writeFileString(file(first, "personas/kept.md"), "kept\n");
          yield* told(first, "personas/kept.md");
          yield* until(
            () => text(second, "personas/kept.md"),
            (has) => has === "kept\n",
          );
          yield* fs.makeDirectory(file(first, "personas-new"));
          yield* save(first, "personas-new/kept.md", "older\n", "2000-01-01T00:00:00.000Z");
          yield* Effect.sleep("2 seconds");
          yield* withLock(
            file(second, "definitions.lock"),
            Effect.die("the other host holds its definitions"),
            Effect.gen(function* () {
              yield* fs.rename(file(first, "personas"), file(first, "personas-old"));
              yield* fs.rename(file(first, "personas-new"), file(first, "personas"));
              yield* Effect.sleep("250 millis");
              yield* fs.writeFileString(file(first, "personas/after.md"), "after\n");
              yield* told(first, "personas/after.md");
              yield* Effect.sleep("250 millis");
            }),
          );
          yield* Effect.sleep("2 seconds");
          expect(yield* text(second, "personas/after.md")).toBe("after\n");

          yield* fs.writeFileString(file(second, "workflows/forked.workflow.ts"), "edited\n");
          yield* told(second, "workflows/forked.workflow.ts");
          yield* until(
            () => text(first, "workflows/forked.workflow.ts"),
            (has) => has === "edited\n",
          );

          yield* fs.remove(file(first, "workflows/forked.workflow.ts"));
          yield* told(first, "workflows/forked.workflow.ts");
          yield* until(
            () => fs.exists(file(second, "workflows/forked.workflow.ts")),
            (exists) => !exists,
          );

          yield* Effect.all(
            [
              save(first, "personas/both.md", "first's\n", "2099-10-14T10:00:00.000Z"),
              save(second, "personas/both.md", "second's\n", "2099-10-14T11:00:00.000Z"),
            ],
            { concurrency: "unbounded" },
          );
          yield* told(first, "personas/both.md");
          yield* told(second, "personas/both.md");
          yield* until(
            () => Effect.all([text(first, "personas/both.md"), text(second, "personas/both.md")]),
            (both) => Arr.every(both, (has) => has === "second's\n"),
          );
          expect(
            yield* fs.readFileString(
              file(first, "replaced/2099-10-14T10:00:00.000Z/personas/both.md"),
            ),
          ).toBe("first's\n");

          for (const side of [first, second]) {
            expect(yield* text(side, "workflows/package.json")).toBe(
              `{ "name": "${side.name}" }\n`,
            );
          }

          const shares = Effect.all(
            Arr.map([first, second], (side) =>
              readAudit(`${side.world.state}/definitions`).pipe(
                Effect.provide(memoryRecords),
                Effect.map(
                  (lines) =>
                    Arr.filter(lines, (line) => line.operation === "share definitions").length,
                ),
              ),
            ),
          );
          yield* Effect.sleep("2 seconds");
          const settled = yield* shares;
          yield* Effect.sleep("3 seconds");
          expect(yield* shares).toEqual(settled);
        }),
      [],
    ),
  ));

test("a host whose user directory is removed does not make it again", () =>
  proves(
    "collie-user-dir-gone-",
    (world) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        yield* connect(world.state);
        yield* fs.remove(world.config, { recursive: true });
        yield* Effect.sleep("12 seconds");
        expect(yield* fs.exists(world.config)).toBe(false);
      }),
    [],
  ));

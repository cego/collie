// Paired hosts keep the user Layer level without Desktop: each file is its latest edit,
// a removal included, and the text that lost is kept where it lost.

import * as Arr from "effect/Array";
import { expect, test } from "bun:test";
import { Effect, FileSystem } from "effect";
import { readAudit } from "../src/audit";
import { connect } from "../src/host";
import { withLock } from "../src/lock";
import { fileTime } from "../src/time";
import { runEffect } from "./support/effect";
import { until } from "./support/host";
import { twoMachines, type Side } from "./support/peers";
import { proves } from "./support/world";

test(
  "a definition created, edited, removed or edited on both reaches the other host by its latest edit",
  () =>
    runEffect(
      twoMachines(
        "collie-peer-definitions-",
        (first, second) =>
          Effect.gen(function* () {
            const fs = yield* FileSystem.FileSystem;
            const file = (side: Side, path: string) => `${side.world.config}/${path}`;
            const text = (side: Side, path: string) =>
              fs.readFileString(file(side, path)).pipe(Effect.orElseSucceed(() => null));
            /** Written whole, with its edit's time, the way an editor saves it. */
            const save = (side: Side, path: string, saved: string, at: string) =>
              Effect.gen(function* () {
                const staged = `${side.world.home}/staged`;
                yield* fs.writeFileString(staged, saved);
                yield* fs.utimes(staged, fileTime(at), fileTime(at));
                yield* fs.rename(staged, file(side, path));
              });
            for (const side of [first, second])
              yield* fs.writeFileString(
                file(side, "workflows/package.json"),
                `{ "name": "${side.name}" }\n`,
              );
            yield* fs.writeFileString(file(first, "workflows/forked.workflow.ts"), "forked\n");

            yield* first.lists([second]);
            expect((yield* first.cli(["--machine", "second", "board"])).envelope.ok).toBe(true);
            yield* until(
              () => text(second, "workflows/forked.workflow.ts"),
              (has) => has === "forked\n",
            );

            // A directory replaced by hand is watched again, and a save made while its catch-up waits
            // on the other host reaches it without another save.
            yield* fs.writeFileString(file(first, "personas/kept.md"), "kept\n");
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
                yield* Effect.sleep("250 millis");
              }),
            );
            yield* Effect.sleep("2 seconds");
            expect(yield* text(second, "personas/after.md")).toBe("after\n");

            yield* fs.writeFileString(file(second, "workflows/forked.workflow.ts"), "edited\n");
            yield* until(
              () => text(first, "workflows/forked.workflow.ts"),
              (has) => has === "edited\n",
            );

            yield* fs.remove(file(first, "workflows/forked.workflow.ts"));
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
            yield* until(
              () => Effect.all([text(first, "personas/both.md"), text(second, "personas/both.md")]),
              (both) => Arr.every(both, (has) => has === "second's\n"),
            );
            expect(
              yield* fs.readFileString(
                file(first, "replaced/2099-10-14T10:00:00.000Z/personas/both.md"),
              ),
            ).toBe("first's\n");

            for (const side of [first, second])
              expect(yield* text(side, "workflows/package.json")).toBe(
                `{ "name": "${side.name}" }\n`,
              );

            // Once the last round has finished, a sync's own writes start no more.
            const shares = Effect.all(
              Arr.map([first, second], (side) =>
                readAudit(`${side.world.state}/definitions`).pipe(
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
    ),
  180_000,
);

test(
  "a host whose user directory is removed does not make it again",
  () =>
    proves(
      "collie-user-dir-gone-",
      (world) =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          yield* connect(world.state);
          yield* fs.remove(world.config, { recursive: true });
          // Past the 10 seconds a failed watch waits before it tries again.
          yield* Effect.sleep("12 seconds");
          expect(yield* fs.exists(world.config)).toBe(false);
        }),
      [],
    ),
  60_000,
);

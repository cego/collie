import { expect, test } from "bun:test";
import { Effect, Fiber, FileSystem, Option, Schedule } from "effect";
import { replacedOnDisk } from "../src/flows";
import { answering } from "../src/mcp";
import { runEffect } from "./support/effect";

test("a board notices its binary renamed over, and nothing while it is left alone", () =>
  runEffect(
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const dir = yield* fs.makeTempDirectoryScoped({ prefix: "hw-relaunch-" });
        const bin = `${dir}/collie`;
        yield* fs.writeFileString(bin, "old");

        const replaced = yield* replacedOnDisk(bin, "10 millis");
        const watching = yield* Effect.forkChild(replaced.pipe(Effect.timeoutOption(2000)));
        yield* Effect.sleep(100);
        // Rewritten in place is the same file: not an upgrade.
        yield* fs.writeFileString(bin, "old again");
        yield* Effect.sleep(100);
        expect(watching.pollUnsafe()).toBeUndefined();

        // How tools/build.ts installs one: beside it, then renamed over it.
        yield* fs.writeFileString(`${bin}.new`, "new");
        yield* fs.rename(`${bin}.new`, bin);
        expect(Option.isSome(yield* Fiber.join(watching))).toBe(true);

        // A path nobody can read never counts as rebuilt.
        const missing = yield* Effect.flatten(replacedOnDisk(`${dir}/gone`, "10 millis")).pipe(
          Effect.timeoutOption(100),
        );
        expect(Option.isNone(missing)).toBe(true);
      }),
    ),
  ));

test("the MCP server answers here until its binary is renamed over, then through the new one", () =>
  runEffect(
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const dir = yield* fs.makeTempDirectoryScoped({ prefix: "hw-mcp-upgrade-" });
        const bin = `${dir}/collie`;
        yield* fs.writeFileString(bin, "old");
        const answer = yield* answering({
          binary: bin,
          every: "10 millis",
          direct: (name) => Effect.succeed(`old ${name}`),
          rebuilt: (name) => Effect.succeed(`new ${name}`),
        });
        expect(yield* answer("collie_herd", {})).toBe("old collie_herd");

        yield* fs.writeFileString(`${bin}.new`, "new");
        yield* fs.rename(`${bin}.new`, bin);
        // Asked until it changes: the watch notices on its own schedule, not on the test's.
        const after = yield* answer("collie_herd", {}).pipe(
          Effect.repeat({
            until: (said) => said !== "old collie_herd",
            schedule: Schedule.spaced("10 millis"),
          }),
          Effect.timeout("10 seconds"),
        );
        expect(after).toBe("new collie_herd");
      }),
    ),
  ));

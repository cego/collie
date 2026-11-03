// The fake herdr's call log is appended to by its CLI from another process while a test
// reads it, so a read can land in the middle of a line.

import * as Str from "effect/String";
import { Effect, FileSystem } from "effect";
import { expect, test } from "bun:test";
import { Rig } from "./support/recorder";
import { runEffect } from "./support/effect";

const line = (cmd: string) =>
  `${JSON.stringify({ transport: "cli", cmd, argv: Str.split(cmd, " ") })}\n`;

test("a call the fake herdr is still writing is read once its line is whole", () =>
  runEffect(
    Effect.gen(function* () {
      const rig = yield* Rig.scoped();
      const fs = yield* FileSystem.FileSystem;
      const written = line("workspace list");
      const writing = line("tab create");
      const half = writing.length / 2;
      yield* fs.writeFileString(rig.logPath, written + Str.slice(0, half)(writing));
      expect(yield* rig.cmds()).toEqual(["workspace list"]);
      yield* fs.writeFileString(rig.logPath, Str.slice(half)(writing), { flag: "a" });
      expect(yield* rig.cmds()).toEqual(["workspace list", "tab create"]);
    }).pipe(Effect.orDie),
  ));

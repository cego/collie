import { expect, test } from "bun:test";
import { ConfigProvider, Effect, FileSystem } from "effect";
import { recordStart } from "../src/starts";
import { runEffect } from "./support/effect";

test("a start is one line naming the executable and what it was asked, and nothing unset", () =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "starts-" });
      const file = `${dir}/starts`;
      const starts = Effect.provide(
        Effect.all([
          recordStart("collie", ["--json", "run", "start", "plan"]),
          recordStart("collie", ["host", "--dir", "/state"]),
          recordStart("herdr", ["pane", "list"]),
          recordStart("forge gitlab", ["mr", "view", "12"]),
        ]),
        ConfigProvider.layer(ConfigProvider.fromUnknown({ COLLIE_TEST_STARTS: file })),
      );
      yield* starts;
      yield* recordStart("collie", ["host"]).pipe(
        Effect.provide(ConfigProvider.layer(ConfigProvider.fromUnknown({}))),
      );
      expect(yield* fs.readFileString(file)).toBe(
        "collie run start\ncollie host\nherdr pane list\nforge gitlab mr view\n",
      );
    }).pipe(Effect.scoped),
  ));

import { expect, test } from "bun:test";
import { ConfigProvider, Effect, FileSystem } from "effect";
import { recordStart } from "../src/starts";
import { runEffect } from "./support/effect";
import { writeFakeHerdrShim } from "./support/fake-herdr-core";

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

test("a fake herdr started by a test file records that file", () =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "starts-" });
      yield* writeFakeHerdrShim(`${dir}/herdr`);
      const child = Bun.spawn([`${dir}/herdr`, "pane", "list"], {
        env: {
          ...process.env,
          COLLIE_TEST_STARTS: `${dir}/starts`,
          FAKE_HERDR_STATE: dir,
          FAKE_HERDR_LOG: `${dir}/calls.jsonl`,
        },
        stdout: "ignore",
        stderr: "ignore",
      });
      yield* Effect.promise(() => child.exited);
      expect(yield* fs.readFileString(`${dir}/starts`)).toBe(
        "herdr pane list\ttest/starts.test.ts\n",
      );
    }).pipe(Effect.scoped),
  ));

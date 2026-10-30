import { expect, test } from "bun:test";
import { BunServices } from "@effect/platform-bun";
import { Effect, FileSystem, Schema } from "effect";
import { readPiModels } from "../desktop/src/bun/pi-models";
import { NO_FLOCK_SETTINGS } from "../desktop/src/shared/flock-settings";
import { harnessLists } from "../desktop/src/bun/harness-lists";
import { offerOf } from "../desktop/src/bun/chat-choices";

test("Pi's reader isolates setup and pairs delayed, out-of-order answers with each model before ending its process", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "pi-models-" });
      const previous = Bun.env.PI_CODING_AGENT_DIR;
      Bun.env.PI_CODING_AGENT_DIR = `${dir}/agent`;
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          if (previous === undefined) delete Bun.env.PI_CODING_AGENT_DIR;
          else Bun.env.PI_CODING_AGENT_DIR = previous;
        }),
      );
      const models = yield* readPiModels(NO_FLOCK_SETTINGS, dir, [
        "bun",
        `${import.meta.dir}/fixtures/pi-models.ts`,
        "list",
      ]);
      expect(models).toEqual([
        {
          id: "openai-codex/gpt-5.5",
          label: "GPT-5.5",
          efforts: ["off", "minimal", "low", "medium", "high", "xhigh"],
        },
        {
          id: "openai-codex/gpt-6.1-sol",
          label: "Sol",
          efforts: ["minimal", "low", "medium", "high", "xhigh", "max"],
        },
        { id: "local/only-off", label: "Off only", efforts: [] },
        { id: "local/plain", label: "Plain", efforts: [] },
      ]);
      const started = yield* Schema.decodeEffect(
        Schema.fromJsonString(
          Schema.Struct({
            args: Schema.Array(Schema.String),
            agent: Schema.String,
            pid: Schema.Finite,
          }),
        ),
      )(yield* fs.readFileString(`${dir}/reader-start.json`)).pipe(Effect.orDie);
      expect(started.args).toEqual([
        "--mode",
        "rpc",
        "--no-session",
        "--no-extensions",
        "--no-skills",
        "--no-prompt-templates",
        "--no-context-files",
        "--offline",
        "--no-mcp",
        "--no-themes",
        "--no-tools",
      ]);
      expect(started.agent).toBe(`${dir}/agent`);
      expect(() => process.kill(started.pid, 0)).toThrow();
      for (const failure of [
        { command: [`${dir}/missing-pi`], reason: "missing-pi" },
        {
          command: ["bun", `${import.meta.dir}/fixtures/pi-models.ts`, "error"],
          reason: "Pi login expired for openai-codex",
        },
        {
          command: ["bun", `${import.meta.dir}/fixtures/pi-models.ts`, "exit"],
          reason: "Pi could not load this provider",
        },
      ]) {
        const lists = yield* harnessLists({
          pi: readPiModels(NO_FLOCK_SETTINGS, dir, failure.command),
        });
        yield* lists.ready("pi");
        expect(
          yield* offerOf(
            "pi",
            { proactive: true, chatHarness: "pi", chatModel: "openai-codex/gpt-5.5" },
            NO_FLOCK_SETTINGS,
            Effect.succeed({}),
            lists,
          ),
        ).toMatchObject({
          from: "table",
          why: expect.stringContaining(failure.reason),
          models: [
            {
              id: "openai-codex/gpt-5.5",
              label: "openai-codex/gpt-5.5",
              efforts: ["off", "minimal", "low", "medium", "high", "xhigh", "max"],
            },
          ],
        });
      }
    }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
  ));

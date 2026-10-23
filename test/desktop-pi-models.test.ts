// Pi's own list of models and each one's thinking levels, read from a Pi RPC process that loads
// none of the human's setup and keeps no session, and what of it the Flock chat offers.

import { expect, test } from "bun:test";
import { BunServices } from "@effect/platform-bun";
import { Effect, FileSystem, Result, Schema } from "effect";
import { readPiModels } from "../desktop/src/bun/pi-models";
import { harnessOffer } from "../desktop/src/shared/chat-choices";

const FIXTURE = `${import.meta.dir}/fixtures/pi-rpc.ts`;

const Started = Schema.fromJsonString(
  Schema.Struct({
    args: Schema.Array(Schema.String),
    agentDir: Schema.NullOr(Schema.String),
    pid: Schema.Number,
  }),
);

/** The reader run on the fake Pi in `scenario`, with what the fake was started with and sent. */
const readOn = (scenario: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const dir = yield* fs.makeTempDirectoryScoped({ prefix: "pi-models-" });
    const env = Bun.env;
    const previous = env.PI_CODING_AGENT_DIR;
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        if (previous === undefined) delete env.PI_CODING_AGENT_DIR;
        else env.PI_CODING_AGENT_DIR = previous;
      }),
    );
    env.PI_CODING_AGENT_DIR = `${dir}/agent`;
    const record = `${dir}/record`;
    const read = yield* readPiModels(["bun", FIXTURE, record, scenario]).pipe(Effect.result);
    const [first, ...sent] = (yield* fs.readFileString(record)).trimEnd().split("\n");
    return {
      read,
      started: Schema.decodeUnknownSync(Started)(first),
      sent,
      agentDir: `${dir}/agent`,
    };
  }).pipe(Effect.scoped, Effect.provide(BunServices.layer));

const ARGS = [
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
];

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

test("each reasoning model is given its own levels though Pi answers out of order, and Pi is ended once read", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const { read, started, sent, agentDir } = yield* readOn("models");
      expect(started.args).toEqual(ARGS);
      expect(started.agentDir).toBe(agentDir);
      expect(alive(started.pid)).toBe(false);
      // Only reasoning models are set, each before its levels are asked for.
      expect(sent).toEqual([
        "get_available_models /",
        "set_model openai-codex/gpt-6.1-sol",
        "get_available_thinking_levels /",
        "set_model openai-codex/gpt-5.5",
        "get_available_thinking_levels /",
        "set_model ollama/tiny-thinker",
        "get_available_thinking_levels /",
      ]);
      const listed = Result.getOrThrow(read);
      expect(listed).toEqual([
        {
          id: "openai-codex/gpt-6.1-sol",
          label: "GPT-6.1 Sol",
          efforts: ["minimal", "low", "medium", "high", "xhigh", "max"],
        },
        {
          id: "openai-codex/gpt-5.5",
          label: "GPT-5.5",
          efforts: ["off", "minimal", "low", "medium", "high", "xhigh"],
        },
        // Its only level is off, and the other is no reasoning model: neither takes an effort.
        { id: "ollama/tiny-thinker", label: "Tiny Thinker", efforts: [] },
        { id: "openai/gpt-4o-mini", label: "GPT-4o mini", efforts: [] },
      ]);
      expect(harnessOffer("pi", listed, [], {}).models.map(({ id }) => id)).toEqual([
        "openai-codex/gpt-6.1-sol",
        "openai-codex/gpt-5.5",
        "ollama/tiny-thinker",
        "openai/gpt-4o-mini",
      ]);
    }),
  ));

test("an answer that reports an error fails the read with Pi's own words", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const { read, started } = yield* readOn("error");
      expect(read).toEqual(Result.fail("No models available: no provider is logged in"));
      expect(started.args).toEqual(ARGS);
      expect(alive(started.pid)).toBe(false);
    }),
  ));

test("a Pi that exits before it answers fails the read with what it said", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const { read, started } = yield* readOn("exits");
      expect(read).toEqual(Result.fail("Error: models.json is not valid JSON"));
      expect(started.args).toEqual(ARGS);
    }),
  ));

test("a Pi that cannot start fails the read with why", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const missing = yield* readPiModels(["/nonexistent/pi"]).pipe(Effect.result);
      expect(Result.isFailure(missing) && missing.failure).toContain("/nonexistent/pi");
      expect(yield* readPiModels(null).pipe(Effect.result)).toEqual(
        Result.fail("pi is not on PATH"),
      );
    }),
  ));

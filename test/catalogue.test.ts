import { describe, expect, test } from "bun:test";
import { BunServices } from "@effect/platform-bun";
import { Effect, Fiber, FileSystem, Schema, Scope } from "effect";
import { TestClock } from "effect/testing";
import { CATALOGUE_CALL_MS, CATALOGUE_RETRY_MS, makeCatalogue } from "../src/catalogue";
import { HarnessCatalogue, modelsLines } from "../src/catalogue-model";
import { fakeSources, serveCatalogue } from "./support/catalogue";
import { exec } from "./support/command";

const onTestClock = <A, E>(effect: Effect.Effect<A, E, BunServices.BunServices | Scope.Scope>) =>
  Effect.runPromise(
    effect.pipe(Effect.scoped, Effect.provide([BunServices.layer, TestClock.layer()])),
  );

const counted = <A, E>(source: Effect.Effect<A, E>) => {
  const calls = { count: 0 };
  return { calls, read: Effect.suspend(() => ((calls.count += 1), source)) };
};

describe("a harness that cannot be read", () => {
  test("is said to be on Collie's table, with why, and is not read again until its back-off", () =>
    onTestClock(
      Effect.gen(function* () {
        const claude = counted(Effect.fail("claude exited 1: not logged in"));
        const catalogue = yield* makeCatalogue(
          fakeSources({ claude: claude.read }),
          Effect.succeed({}),
        );

        const read = yield* catalogue.catalogues;
        const said = read.find((one) => one.harness === "claude");
        expect(said?.table).toBe("claude exited 1: not logged in");
        expect(said?.entries.map(({ model, from }) => [model, from])).toEqual([
          ["fable", "table"],
          ["opus", "table"],
          ["sonnet", "table"],
          ["haiku", "table"],
          ["opusplan", "table"],
        ]);
        expect(modelsLines(read)).toContain(
          "claude    from Collie's table: claude exited 1: not logged in",
        );
        expect(read.find((one) => one.harness === "codex")?.table).toBeNull();

        yield* TestClock.adjust(CATALOGUE_RETRY_MS - 1);
        yield* catalogue.catalogues;
        expect(claude.calls.count).toBe(1);
        yield* TestClock.adjust(1);
        yield* catalogue.catalogues;
        expect(claude.calls.count).toBe(2);
        // A second failure waits twice as long.
        yield* TestClock.adjust(2 * CATALOGUE_RETRY_MS - 1);
        yield* catalogue.catalogues;
        expect(claude.calls.count).toBe(2);
        yield* TestClock.adjust(1);
        yield* catalogue.catalogues;
        expect(claude.calls.count).toBe(3);
      }),
    ));

  test("one that does not answer in time is on Collie's table too", () =>
    onTestClock(
      Effect.gen(function* () {
        const pi = counted(Effect.never);
        const catalogue = yield* makeCatalogue(fakeSources({ pi: pi.read }), Effect.succeed({}));
        const asking = yield* Effect.forkChild(catalogue.catalogues);
        yield* TestClock.adjust(CATALOGUE_CALL_MS);
        const said = (yield* Fiber.join(asking)).find((one) => one.harness === "pi");
        expect(said).toMatchObject({
          table: "pi --list-models did not answer within 20s",
          entries: [],
        });
        yield* catalogue.catalogues;
        expect(pi.calls.count).toBe(1);
      }),
    ));
});

describe("what a Machine's catalogue holds", () => {
  test("a harness not installed is absent, and models.<harness> adds what a harness hides", () =>
    onTestClock(
      Effect.gen(function* () {
        const catalogue = yield* makeCatalogue(
          fakeSources({ opencode: Effect.succeed(null) }),
          Effect.succeed({ codex: ["gpt-reserve", "gpt-internal"] }),
        );
        const read = yield* catalogue.catalogues;
        expect(read.map((one) => one.harness)).toEqual(["claude", "codex", "pi"]);
        const codex = read.find((one) => one.harness === "codex")?.entries ?? [];
        expect(codex.filter((entry) => entry.model === "gpt-reserve")).toMatchObject([
          { hidden: true, from: "harness" },
        ]);
        expect(codex.at(-1)).toMatchObject({ model: "gpt-internal", from: "added" });
      }),
    ));
});

const CliEnvelope = Schema.fromJsonString(
  Schema.Struct({
    ok: Schema.Literal(true),
    data: Schema.Struct({
      machine: Schema.Null,
      catalogues: Schema.Array(HarnessCatalogue),
    }),
  }),
);
const root = new URL("../", import.meta.url).pathname;

describe("collie models", () => {
  test("--json prints its host's catalogue envelope, and --harness keeps one harness", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const dir = yield* fs.makeTempDirectoryScoped({ prefix: "collie-models-" });
        const state = `${dir}/state`;
        yield* fs.makeDirectory(state, { recursive: true });
        yield* serveCatalogue(state, yield* makeCatalogue(fakeSources(), Effect.succeed({})));
        const cli = (...args: ReadonlyArray<string>) =>
          exec([process.execPath, `${root}src/main.ts`, "--json", "models", ...args], {
            cwd: root,
            env: {
              ...process.env,
              HERDR_PLUGIN_ROOT: root,
              HERDR_PLUGIN_STATE_DIR: state,
              COLLIE_USER_DIR: `${dir}/config`,
              HOME: dir,
            },
          }).pipe(Effect.map((ran) => Schema.decodeUnknownSync(CliEnvelope)(ran.stdout).data));

        const every = yield* cli();
        expect(every.machine).toBeNull();
        expect(every.catalogues.map((one) => [one.harness, one.table])).toEqual([
          ["claude", null],
          ["codex", null],
          ["pi", null],
          ["opencode", null],
        ]);
        expect(every.catalogues[0]?.entries[0]).toEqual({
          model: "opus",
          label: "Opus 5.5",
          description: "For complex work and everyday tasks",
          efforts: ["low", "medium", "high", "xhigh", "max"],
          defaultEffort: null,
          hidden: false,
          from: "harness",
        });

        const pi = yield* cli("--harness", "pi");
        expect(pi.catalogues.map((one) => one.harness)).toEqual(["pi"]);
        expect(pi.catalogues[0]?.entries.map((entry) => entry.model)).toContain(
          "ollama/qwen3-coder:30b",
        );
      }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
    ));
});

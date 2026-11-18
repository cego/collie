import * as Arr from "effect/Array";
import { expect, test } from "bun:test";
import { Effect, Fiber, FileSystem, Schema } from "effect";
import { stopHost } from "./support/host";
import { collie, proves, type World } from "./support/world";

const View = Schema.Struct({
  runId: Schema.String,
  status: Schema.Struct({ status: Schema.String }),
  parked: Schema.NullOr(Schema.String),
});
const Waited = Schema.Struct({
  runId: Schema.optional(Schema.String),
  run: Schema.optional(View),
  runs: Schema.optional(Schema.Array(Schema.Struct({ run: View }))),
});
const payloadOf = (envelope: { readonly data?: unknown }) =>
  Schema.decodeUnknownEffect(Waited)(envelope.data).pipe(Effect.orDie);

const parksOnCue = (world: World, cue: string) =>
  Effect.gen(function* () {
    const started = yield* collie(world, [
      "run",
      "start",
      "parks-on-cue",
      "--input",
      `cue=${cue}`,
      "--input",
      "cause=unknown",
      "--input",
      "asks=no",
    ]);
    return (yield* payloadOf(started.envelope)).runId ?? "";
  });

test("a wait on one Run returns that Run when it meets the condition", () =>
  proves(
    "collie-wait-one-",
    (world) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const runId = yield* parksOnCue(world, `${world.state}/cue-one`);
        yield* fs.writeFileString(`${world.state}/cue-one`, "go");

        const waited = yield* collie(world, ["run", "wait", runId, "--until", "attention"]);
        expect(waited.exit).toBe(0);
        const run = (yield* payloadOf(waited.envelope)).run;
        expect(run?.runId).toBe(runId);
        expect(run?.parked).toBe("parked for unknown");
        yield* stopHost(world.state);
      }),
    ["parks-on-cue.workflow.ts"],
  ));

test("a wait on two Runs returns the first to need attention, naming it and its state", () =>
  proves(
    "collie-wait-first-",
    (world) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const first = yield* parksOnCue(world, `${world.state}/cue-first`);
        const second = yield* parksOnCue(world, `${world.state}/cue-second`);
        yield* fs.writeFileString(`${world.state}/cue-second`, "go");

        const waited = yield* collie(world, ["run", "wait", first, second, "--until", "attention"]);
        expect(waited.exit).toBe(0);
        const run = (yield* payloadOf(waited.envelope)).run;
        expect(run?.runId).toBe(second);
        expect(run?.parked).toBe("parked for unknown");
        yield* stopHost(world.state);
      }),
    ["parks-on-cue.workflow.ts"],
  ));

test("a wait with --all on two Runs returns only once both meet the condition", () =>
  proves(
    "collie-wait-all-",
    (world) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const first = yield* parksOnCue(world, `${world.state}/cue-first`);
        const second = yield* parksOnCue(world, `${world.state}/cue-second`);

        const both = yield* collie(world, [
          "run",
          "wait",
          first,
          second,
          "--all",
          "--until",
          "attention",
        ]).pipe(Effect.forkChild);
        yield* fs.writeFileString(`${world.state}/cue-second`, "go");
        yield* collie(world, ["run", "wait", second, "--until", "attention"]);
        yield* Effect.sleep("2 seconds");
        expect(both.pollUnsafe()).toBeUndefined();

        yield* fs.writeFileString(`${world.state}/cue-first`, "go");
        const waited = yield* Fiber.join(both);
        expect(waited.exit).toBe(0);
        const runs = (yield* payloadOf(waited.envelope)).runs ?? [];
        expect(Arr.map(runs, ({ run }) => [run.runId, run.parked])).toEqual([
          [first, "parked for unknown"],
          [second, "parked for unknown"],
        ]);
        yield* stopHost(world.state);
      }),
    ["parks-on-cue.workflow.ts"],
  ));

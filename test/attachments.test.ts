// A Run takes attachments by path (ADR-0045): the host copies each into the Run's own
// directory before its first step or the steer it came with, every step's prompt lists
// them, and a Run started from it gets copies. Driven through the CLI and host an
// installation runs, with herdr faked.

import { expect, test } from "bun:test";
import type { BunServices } from "@effect/platform-bun/BunServices";
import { Effect, FileSystem, Schema, type Scope } from "effect";
import { readAudit } from "../src/audit";
import { runDir, type RunView } from "../src/engine";
import { connect } from "../src/host";
import { isSettled } from "../src/lifecycle";
import { stopHost, until } from "./support/host";
import { collie, proves, type World } from "./support/world";

const encode = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const Payload = Schema.Struct({
  runId: Schema.optional(Schema.String),
  run: Schema.optional(Schema.String),
});
const payloadOf = (envelope: { readonly data?: unknown }) =>
  Schema.decodeUnknownSync(Payload)(envelope.data);
const CallLine = Schema.fromJsonString(
  Schema.Struct({ cmd: Schema.String, argv: Schema.Array(Schema.String) }),
);

/** A world whose fake agents answer each prompt with an Output, and stay alive. */
const attending = <A, E>(
  prefix: string,
  body: (
    world: World,
    cli: (args: ReadonlyArray<string>) => ReturnType<typeof collie>,
  ) => Effect.Effect<A, E, BunServices | Scope.Scope>,
) =>
  proves(
    prefix,
    (world) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const outputs = `${world.home}/outputs.json`;
        yield* fs
          .writeFileString(outputs, encode(Array.from({ length: 4 }, () => ({ verdict: "done" }))))
          .pipe(Effect.orDie);
        for (const [name, text] of [
          ["shot.png", "a screenshot"],
          ["notes.txt", "some notes"],
          ["late.png", "arrived later"],
        ])
          yield* fs.writeFileString(`${world.project}/${name}`, text!).pipe(Effect.orDie);
        const extra = { FAKE_HERDR_OUTPUTS: outputs };
        return yield* body(world, (args) => collie(world, args, extra)).pipe(
          Effect.ensuring(stopHost(world.state)),
        );
      }),
    ["attended.workflow.ts"],
  );

const read = (file: string) =>
  Effect.flatMap(FileSystem.FileSystem, (fs) => fs.readFileString(file)).pipe(Effect.orDie);

const viewOf = (world: World, runId: string, wanted: (view: RunView | null) => boolean) =>
  Effect.gen(function* () {
    const client = yield* connect(world.state).pipe(Effect.orDie);
    return yield* until(() => client.run({ runId }).pipe(Effect.orDie), wanted);
  });

const asking = (view: RunView | null) => (view?.waiting ?? []).some((one) => one.answer === null);

const answer = (world: World, runId: string) =>
  Effect.gen(function* () {
    const client = yield* connect(world.state).pipe(Effect.orDie);
    yield* client
      .answer({ runId, decision: "go", value: "yes", request: `answer-${runId}` })
      .pipe(Effect.orDie);
    return yield* viewOf(world, runId, (view) => view !== null && isSettled(view));
  });

test(
  "a start's attachments are in the Run's directory and its first prompt before it runs, and on its audit line",
  () =>
    attending("collie-attach-start-", (world, cli) =>
      Effect.gen(function* () {
        const started = yield* cli([
          "run",
          "start",
          "attended",
          "--input",
          "work=the picker",
          "--attach",
          "shot.png",
          "--attach",
          `${world.project}/notes.txt`,
        ]);
        expect(started.envelope.error).toBeUndefined();
        const runId = payloadOf(started.envelope).runId!;
        yield* viewOf(world, runId, asking);
        const dir = `${runDir(world.state, runId)}/attachments`;
        expect(yield* read(`${dir}/shot.png`)).toBe("a screenshot");
        expect(yield* read(`${dir}/notes.txt`)).toBe("some notes");
        const prompt = yield* read(`${world.state}/agents/${runId}/build.prompt.md`);
        expect(prompt).toContain(`- shot.png (image/png, 12 bytes): ${dir}/shot.png`);
        expect(prompt).toContain(`: ${dir}/notes.txt`);

        const line = (yield* readAudit(runDir(world.state, runId)).pipe(Effect.orDie)).find(
          (one) => one.operation === "start",
        );
        expect(line?.asked).toEqual({
          attachments: [
            { name: "shot.png", from: `${world.project}/shot.png` },
            { name: "notes.txt", from: `${world.project}/notes.txt` },
          ],
        });
      }),
    ),
  120_000,
);

test(
  "a start naming a missing file is refused, naming it, and no Run exists",
  () =>
    attending("collie-attach-missing-", (world, cli) =>
      Effect.gen(function* () {
        const refused = yield* cli([
          "run",
          "start",
          "attended",
          "--input",
          "work=the picker",
          "--attach",
          "gone.png",
        ]);
        expect(refused.envelope.ok).toBe(false);
        expect(refused.envelope.error?.message).toContain(`${world.project}/gone.png`);
        const client = yield* connect(world.state).pipe(Effect.orDie);
        expect(yield* client.runs({ task: null }).pipe(Effect.orDie)).toEqual([]);
      }),
    ),
  120_000,
);

test(
  "the same request with another file is a conflict, and with the same file is the same Run",
  () =>
    attending("collie-attach-conflict-", (world) =>
      Effect.gen(function* () {
        const client = yield* connect(world.state).pipe(Effect.orDie);
        const start = (file: string) =>
          client.start({
            project: world.project,
            id: "attended",
            request: "req-attach",
            input: { work: "the picker" },
            attachments: [`${world.project}/${file}`],
          });
        const first = yield* start("shot.png").pipe(Effect.orDie);
        const again = yield* start("shot.png").pipe(Effect.orDie);
        expect(again).toMatchObject({ runId: first.runId, fresh: false });
        const other = yield* start("notes.txt").pipe(Effect.flip, Effect.orDie);
        expect(other._tag).toBe("RequestConflict");
      }),
    ),
  120_000,
);

test(
  "an offer invoked from a Run with attachments gives the new Run copies of them beside its own",
  () =>
    attending("collie-attach-invoke-", (world, cli) =>
      Effect.gen(function* () {
        const started = yield* cli([
          "run",
          "start",
          "attended",
          "--input",
          "work=the picker",
          "--attach",
          "shot.png",
        ]);
        const parent = payloadOf(started.envelope).runId!;
        yield* viewOf(world, parent, asking);
        yield* answer(world, parent);

        const invoked = yield* cli([
          "run",
          "action",
          parent,
          "carry-on",
          "--input",
          "work=more",
          "--attach",
          "notes.txt",
        ]);
        expect(invoked.envelope.error).toBeUndefined();
        const child = payloadOf(invoked.envelope).run!;
        yield* viewOf(world, child, asking);
        const dir = `${runDir(world.state, child)}/attachments`;
        expect(yield* read(`${dir}/shot.png`)).toBe("a screenshot");
        expect(yield* read(`${dir}/notes.txt`)).toBe("some notes");
        const prompt = yield* read(`${world.state}/agents/${child}/build.prompt.md`);
        expect(prompt).toContain(`${dir}/shot.png`);
        expect(prompt).toContain(`${dir}/notes.txt`);
      }),
    ),
  120_000,
);

test(
  "a steer's file is copied, named in what the agent is told, and listed in the next step's prompt",
  () =>
    attending("collie-attach-steer-", (world, cli) =>
      Effect.gen(function* () {
        const started = yield* cli(["run", "start", "attended", "--input", "work=the picker"]);
        const runId = payloadOf(started.envelope).runId!;
        yield* viewOf(world, runId, asking);

        const steered = yield* cli(["run", "steer", runId, "look at this", "--attach", "late.png"]);
        expect(steered.envelope.error).toBeUndefined();
        const copy = `${runDir(world.state, runId)}/attachments/late.png`;
        expect(yield* read(copy)).toBe("arrived later");
        const told = (yield* read(Bun.env.FAKE_HERDR_LOG!))
          .split("\n")
          .filter((line) => line !== "")
          .map((line) => Schema.decodeUnknownSync(CallLine)(line))
          .filter((call) => call.cmd === "agent prompt")
          .map((call) => call.argv.join(" "))
          .find((text) => text.includes("look at this"));
        expect(told).toContain(`Attached: ${copy}`);
        const delivered = (yield* readAudit(runDir(world.state, runId)).pipe(Effect.orDie)).find(
          (one) => one.operation === "deliver",
        );
        expect(delivered?.asked).toMatchObject({
          attachments: [{ name: "late.png", from: `${world.project}/late.png` }],
        });

        yield* answer(world, runId);
        expect(yield* read(`${world.state}/agents/${runId}/check.prompt.md`)).toContain(copy);
      }),
    ),
  120_000,
);

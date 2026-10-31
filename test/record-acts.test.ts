// What a record's revision is for: an act shown at one is refused once the Step it targets
// has finished, and every reader of a Run's Flow says the same at the same revision.

import * as Rec from "effect/Record";
import * as Arr from "effect/Array";
import { expect, test } from "bun:test";
import { Clock, Effect, Fiber, FileSystem, Option, Queue, Schema, Stream } from "effect";
import { Flow, recordIn, type RunDetail } from "../src/board-model";
import { runDir } from "../src/engine";
import { readEnv } from "../src/env";
import { timedFlow } from "../src/flow-timing";
import { frontDoor, socketOf } from "../src/host";
import { toolNamed } from "../src/tools";
import { until } from "./support/host";
import { collie, proves, type World } from "./support/world";

const RunId = Schema.Struct({ runId: Schema.String });

const start = (world: World, workflow: string, input: Readonly<Record<string, string>>) =>
  collie(world, [
    "run",
    "start",
    workflow,
    ...Arr.flatMap(Rec.toEntries(input), ([name, value]) => ["--input", `${name}=${value}`]),
  ]).pipe(
    Effect.flatMap(({ envelope }) => Schema.decodeUnknownEffect(RunId)(envelope.data)),
    Effect.map(({ runId }) => runId),
    Effect.orDie,
  );

/** A `stepped` Run in mode `stop`, waiting inside `ship` until its own gate is opened. */
const shipping = (world: World, name: string) =>
  Effect.gen(function* () {
    const gates = `${world.home}/gates-${name}`;
    yield* (yield* FileSystem.FileSystem).makeDirectory(gates, { recursive: true });
    const runId = yield* start(world, "stepped", { mode: "stop", gates });
    const open = (yield* FileSystem.FileSystem).writeFileString(`${gates}/ship`, "");
    return { runId, open };
  }).pipe(Effect.orDie);

const isDone = (frame: RunDetail | null) => frame !== null && frame.pending?.length === 0;

/** The record as a drawer opening on the Run now is sent it, every part come. */
const recordOf = (world: World, runId: string) =>
  Effect.gen(function* () {
    const door = yield* frontDoor(socketOf(world.state));
    const done = yield* door
      .runDetail({ runId, tail: true, pages: 1, refreshMr: false, parts: true })
      .pipe(
        Stream.map(recordIn),
        Stream.filter(isDone),
        Stream.runHead,
        Effect.timeout("30 seconds"),
      );
    return done._tag === "Some" ? done.value! : null;
  }).pipe(Effect.orDie);

const nodeOf = (flow: Flow | undefined, runId: string, step: string) =>
  Option.getOrUndefined(
    Option.flatMap(
      Arr.findFirst(flow?.lanes ?? [], (lane) => lane.run === runId),
      (lane) => Arr.findFirst(lane.nodes, (one) => one.id === step),
    ),
  );

const holdBefore = (runId: string, step: string) => [{ kind: "hold", run: runId, before: step }];

test(
  "an act shown before its Step finished is refused as stale; one shown before an unrelated change is carried out",
  () =>
    proves(
      "collie-record-stale-",
      (world) =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const door = yield* frontDoor(socketOf(world.state));
          const finishing = yield* shipping(world, "a");
          const working = yield* shipping(world, "b");
          for (const { runId } of [finishing, working])
            yield* until(
              () => recordOf(world, runId),
              (record) => nodeOf(record?.flow, runId, "ship")?.state === "running",
            );

          const shownA = (yield* recordOf(world, finishing.runId))!.revision!;
          yield* finishing.open;
          yield* until(
            () => recordOf(world, finishing.runId),
            (record) => nodeOf(record?.flow, finishing.runId, "wrap")?.state === "done",
          );
          const stale = yield* door
            .act({
              actions: holdBefore(finishing.runId, "wrap"),
              request: "stale-a",
              shown: shownA,
            })
            .pipe(Effect.flip, Effect.orDie);

          const frames = yield* Queue.unbounded<RunDetail | null>();
          const following = yield* door
            .runDetail({
              runId: working.runId,
              tail: false,
              pages: 1,
              refreshMr: false,
              parts: true,
            })
            .pipe(
              Stream.map(recordIn),
              Stream.runForEach((frame) => Queue.offer(frames, frame)),
              Effect.forkScoped,
            );
          let first = yield* Queue.take(frames);
          while (!isDone(first)) first = yield* Queue.take(frames);
          const shownB = first!.revision!;
          const handoffs = `${runDir(world.state, working.runId)}/handoffs`;
          yield* fs.makeDirectory(handoffs, { recursive: true }).pipe(Effect.orDie);
          yield* fs.writeFileString(`${handoffs}/note.md`, "a note\n").pipe(Effect.orDie);
          let noted = yield* Queue.take(frames);
          while ((noted?.handoffFiles ?? []).length === 0) noted = yield* Queue.take(frames);
          const [held] = yield* door
            .act({ actions: holdBefore(working.runId, "wrap"), request: "fresh-b", shown: shownB })
            .pipe(Effect.orDie);
          const next = yield* Queue.take(frames);
          yield* Fiber.interrupt(following);

          expect(stale).toMatchObject({ _tag: "StaleAct", run: finishing.runId, step: "wrap" });
          expect(noted!.revision!.seq).toBeGreaterThan(shownB.seq);
          expect(held?.state).not.toBe("refused");
          expect(next!.revision!.epoch).toBe(held!.revision!.epoch);
          expect(next!.revision!.seq).toBeGreaterThanOrEqual(held!.revision!.seq);
        }),
      ["stepped.workflow.ts"],
    ),
  120_000,
);

const FlowShown = Schema.Struct({ flow: Flow });
const decodeFlow = Schema.decodeUnknownEffect(Schema.fromJsonString(Flow));
const FLOW_BLOCK = /### Flow, as `run show --json` carries it\n\n```json\n(.*)\n```/s;

test(
  "the record, run show and chat's collie_run say the same Flow at one revision, for a large Run and a live one",
  () =>
    proves(
      "collie-record-readers-",
      (world) =>
        Effect.gen(function* () {
          const large = yield* start(world, "many-steps", { steps: "120" });
          yield* collie(world, ["run", "wait", large]);
          const live = (yield* shipping(world, "live")).runId;
          yield* until(
            () => recordOf(world, live),
            (record) => nodeOf(record?.flow, live, "ship")?.state === "running",
          );
          const env = readEnv({
            HERDR_PLUGIN_STATE_DIR: world.state,
            COLLIE_CWD: world.project,
            HOME: world.home,
          });

          for (const runId of [large, live]) {
            /** Each reader once, between two reads of the record. */
            const read = Effect.gen(function* () {
              const before = yield* recordOf(world, runId);
              const shown = yield* collie(world, ["run", "show", runId]).pipe(
                Effect.flatMap(({ envelope }) =>
                  Schema.decodeUnknownEffect(FlowShown)(envelope.data),
                ),
                Effect.orDie,
              );
              const said = yield* toolNamed("collie_run")!.call(env, { run: runId });
              const after = yield* recordOf(world, runId);
              return { before, shown, said, after };
            });
            // A Run settling after its end moves its revision; the readers are compared at one.
            const { before, shown, said } = yield* until(
              () => read,
              (one) =>
                one.after?.revision?.epoch === one.before?.revision?.epoch &&
                one.after?.revision?.seq === one.before?.revision?.seq,
            );
            const now = yield* Clock.currentTimeMillis;
            const told = yield* decodeFlow(FLOW_BLOCK.exec(said)?.[1] ?? "null").pipe(Effect.orDie);

            const record = timedFlow(before!.flow!, now);
            expect(Arr.flatMap(record.lanes, (lane) => lane.nodes).length).toBeGreaterThanOrEqual(
              runId === large ? 120 : 3,
            );
            expect(timedFlow(shown.flow, now)).toEqual(record);
            expect(timedFlow(told, now)).toEqual(record);
          }
        }),
      ["stepped.workflow.ts", "many-steps.workflow.ts"],
    ),
  180_000,
);

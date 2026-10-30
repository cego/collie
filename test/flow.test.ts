// A Run's Flow as the host serves it in RunDetail and `run show`: one row of the Steps a
// module declares, or of what happened where it declares none
// (ADR-draft-a-step-is-declared-where-its-work-is-written).

import * as Rec from "effect/Record";
import * as Arr from "effect/Array";
import * as Str from "effect/String";
import { pipe as pipe_ } from "effect/Function";
import { expect, test } from "bun:test";
import type { PlatformServices } from "../src/platform";
import {
  Clock,
  DateTime,
  Effect,
  FileSystem,
  Option,
  Schema,
  type Scope,
  Stream,
  flow as Schemaflow,
  Result,
} from "effect";
import type { Flow, FlowLane, FlowNode } from "../src/board-model";
import { STEPS_FILE } from "../src/steps";
import { writeTask } from "../src/task";
import { epochMs } from "../src/time";
import { runDir } from "../src/engine";
import { frontDoor, ownerOf, socketOf } from "../src/host";
import { until } from "./support/host";
import { collie, proves, type World } from "./support/world";

const encode = Schemaflow(
  Schema.encodeResult(Schema.fromJsonString(Schema.Unknown)),
  Result.getOrThrow,
);

const outputsOf = (world: World) => `${world.home}/outputs.json`;
const gatesOf = (world: World) => `${world.home}/gates`;

/**
 * `collie` with the fake agents' answers, so a host it starts hands them out, on this
 * process's clock zone, so a time of day it says is one this test can say too.
 */
const cli = (world: World, args: ReadonlyArray<string>) =>
  collie(world, args, { FAKE_HERDR_OUTPUTS: outputsOf(world), TZ: "UTC" });

/** A world whose fake agents answer each prompt in turn with these Outputs. */
const flowing = <A, E>(
  prefix: string,
  body: (world: World) => Effect.Effect<A, E, PlatformServices | Scope.Scope>,
  answers: number,
  modules: ReadonlyArray<string> = ["stepped.workflow.ts"],
) =>
  proves(
    prefix,
    (world) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        yield* fs
          .writeFileString(
            outputsOf(world),
            encode(Array.from({ length: answers }, () => ({ verdict: "done" }))),
          )
          .pipe(Effect.orDie);
        yield* fs.makeDirectory(gatesOf(world), { recursive: true }).pipe(Effect.orDie);
        return yield* body(world);
      }),
    modules,
  );

const RunId = Schema.Struct({ runId: Schema.String });

const start = (world: World, workflow: string, input: Readonly<Record<string, string>>) =>
  cli(world, [
    "run",
    "start",
    workflow,
    ...Arr.flatMap(Rec.toEntries(input), ([name, value]) => ["--input", `${name}=${value}`]),
  ]).pipe(
    Effect.flatMap(({ envelope }) => Schema.decodeUnknownEffect(RunId)(envelope.data)),
    Effect.map(({ runId }) => runId),
    Effect.orDie,
  );

const stepped = (world: World, mode: string) =>
  start(world, "stepped", { mode, gates: gatesOf(world) });

const parented = (world: World, mode: string, task?: string) =>
  cli(world, [
    "run",
    "start",
    "parents",
    "--input",
    `mode=${mode}`,
    ...(task === undefined ? [] : ["--task", task]),
  ]).pipe(
    Effect.flatMap(({ envelope }) => Schema.decodeUnknownEffect(RunId)(envelope.data)),
    Effect.map(({ runId }) => runId),
    Effect.orDie,
  );

/** A Task a Run can be started into, as one a workspace was opened for would be recorded. */
const recordedTask = (world: World, id: string) =>
  writeTask(world.state, {
    id,
    workspace: `w-${id}`,
    label: `collie | ${id}`,
    cwd: world.project,
    created_at: "2026-10-23T07:00:00.000Z",
  }).pipe(Effect.orDie);

const open = (world: World, name: string) =>
  Effect.gen(function* () {
    yield* (yield* FileSystem.FileSystem)
      .writeFileString(`${gatesOf(world)}/${name}`, "")
      .pipe(Effect.orDie);
  });

/** The Run's Flow as a drawer opening on it now is sent it. */
const flowOf = (world: World, runId: string) =>
  Effect.gen(function* () {
    const door = yield* frontDoor(socketOf(world.state));
    const detail = yield* door
      .runDetail({ runId, tail: false, pages: 1, refreshMr: false })
      .pipe(Stream.runHead, Effect.timeout("30 seconds"));
    return Option.getOrNull(detail)?.flow ?? null;
  }).pipe(
    // A host between one process and the next has no socket to answer on yet.
    Effect.orElseSucceed(() => null),
  );

const until_ = (world: World, runId: string, wanted: (flow: Flow) => boolean) =>
  until(
    () => flowOf(world, runId),
    (flow) => flow !== null && wanted(flow),
  ).pipe(Effect.map((flow) => flow!));

const laneOf = (flow: Flow): FlowLane => flow.lanes[0]!;
const nodeOf = (flow: Flow, id: string): FlowNode | undefined =>
  Option.getOrUndefined(Arr.findFirst(laneOf(flow).nodes, (node) => node.id === id));
const statesOf = (flow: Flow) =>
  Arr.map(laneOf(flow).nodes, (node) => ({ id: node.id, state: node.state }));

test.each(["working", "blocked"])(
  "RunDetail and run show offer Watch and Tell for a live %s agent",
  (status) =>
    flowing(
      "collie-flow-live-",
      (world) =>
        Effect.gen(function* () {
          const started = yield* collie(
            world,
            [
              "run",
              "start",
              "stepped",
              "--input",
              "mode=declared",
              "--input",
              `gates=${gatesOf(world)}`,
            ],
            { FAKE_HERDR_OUTPUTS: outputsOf(world), FAKE_HERDR_AGENT_STATUS: status },
          );
          const { runId } = yield* Schema.decodeUnknownEffect(RunId)(started.envelope.data);
          // The node names its agent before the host has polled that agent's status.
          const flow = yield* until_(world, runId, (one) => nodeOf(one, "build")?.primary != null);
          const build = nodeOf(flow, "build")!;
          expect(build).toMatchObject({
            primary: "terminal",
            actions: expect.arrayContaining(["tell"]),
          });
          expect(build.wait).toBe(status === "blocked" ? "stalled" : null);
          const shown = yield* cli(world, ["run", "show", runId]);
          expect(shown.envelope.data).toMatchObject({
            flow: {
              lanes: [
                {
                  nodes: [
                    expect.objectContaining({
                      id: "build",
                      agent: build.agent,
                      primary: "terminal",
                      actions: expect.arrayContaining(["tell"]),
                      wait: status === "blocked" ? "stalled" : null,
                    }),
                    expect.anything(),
                    expect.anything(),
                  ],
                },
              ],
            },
          });
        }),
      0,
    ),
  120_000,
);

test(
  "a declared path is drawn in order: done with its agent, needs you, then expected",
  () =>
    flowing(
      "collie-flow-declared-",
      (world) =>
        Effect.gen(function* () {
          const runId = yield* stepped(world, "declared");
          const asking = yield* until_(
            world,
            runId,
            (flow) => nodeOf(flow, "decide")?.state === "needs-you",
          );
          expect(laneOf(asking).declared).toBe(true);
          expect(statesOf(asking)).toEqual([
            { id: "build", state: "done" },
            { id: "decide", state: "needs-you" },
            { id: "ship", state: "expected" },
          ]);
          expect(nodeOf(asking, "build")?.ranOn).toBe("claude/opus");
          expect(nodeOf(asking, "decide")?.said).toMatch(/^Asked .+ ago$/);
          expect(nodeOf(asking, "ship")?.said).toBeNull();
          expect(asking.current).toEqual({ run: runId, node: "decide" });
          expect(nodeOf(asking, "decide")).toMatchObject({
            primary: "answer",
            questions: [
              {
                id: "go",
                open: true,
                text: "Ship it?",
                options: [
                  { id: "yes", title: "yes" },
                  { id: "no", title: "no" },
                ],
              },
            ],
          });

          const answered = yield* cli(world, ["run", "answer", runId, "yes", "--decision", "go"]);
          expect(answered.envelope.ok).toBe(true);
          const done = yield* until_(
            world,
            runId,
            (flow) => laneOf(flow).execution === "completed",
          );
          expect(Arr.map(laneOf(done).nodes, (node) => node.state)).toEqual([
            "done",
            "done",
            "done",
            "done",
          ]);
          const [question] = nodeOf(done, "decide")?.questions ?? [];
          expect(question).toMatchObject({ name: "go", by: "the CLI" });
          expect(epochMs(question!.answered!)).toBeGreaterThanOrEqual(epochMs(question!.asked!));
          // Work no Step declared, in a declared lane, is drawn as it happened.
          expect(nodeOf(done, "tidy")).toMatchObject({
            declared: false,
            title: "tidy",
            said: "Done",
          });

          // An agent reads what Desktop draws.
          const shown = yield* cli(world, ["run", "show", runId]);
          const { flow } = yield* Schema.decodeUnknownEffect(
            Schema.Struct({ flow: Schema.Unknown }),
          )(shown.envelope.data).pipe(Effect.orDie);
          expect(flow).toEqual(yield* flowOf(world, runId));
        }),
      3,
    ),
  120_000,
);

test(
  "a Step called per item, per round, off the path, and under a new forecast",
  () =>
    flowing(
      "collie-flow-repeats-",
      (world) =>
        Effect.gen(function* () {
          yield* open(world, "a");
          const items = yield* stepped(world, "items");
          const second = yield* until_(
            world,
            items,
            (flow) =>
              Option.getOrUndefined(
                Option.map(Option.fromNullishOr(nodeOf(flow, "slice")), (present) =>
                  Arr.some(present.runs, (one) => one.id === "slice@b"),
                ),
              ) ?? false,
          );
          const slice = nodeOf(second, "slice")!;
          expect(laneOf(second).nodes).toHaveLength(1);
          expect(slice).toMatchObject({ state: "running", said: "Slice 2 of 3" });
          expect(Arr.map(slice.runs, (one) => [one.title, one.state])).toEqual([
            ["a", "done"],
            ["b", "running"],
            ["c", "expected"],
          ]);
          expect(slice.runs[1]!.log).toBeGreaterThan(0);
          const itemLog = Str.split(
            yield* (yield* FileSystem.FileSystem).readFileString(
              `${runDir(world.state, items)}/log.txt`,
            ),
            "\n",
          );
          expect(itemLog[slice.runs[1]!.log! - 1]).toBe("── Build a slice · b ──");
          expect(slice.runs[0]!.log).not.toBe(slice.runs[1]!.log);

          const rounds = yield* stepped(world, "rounds");
          const reviewed = yield* until_(
            world,
            rounds,
            (flow) => laneOf(flow).execution === "completed",
          );
          expect(Arr.map(laneOf(reviewed).nodes, (node) => node.id)).toEqual(["review"]);
          expect(
            Option.getOrUndefined(
              Option.map(Option.fromNullishOr(nodeOf(reviewed, "review")), (present_) =>
                Arr.map(present_.runs, (one) => one.title),
              ),
            ),
          ).toEqual(["Round 1", "Round 2"]);

          const offpath = yield* stepped(world, "offpath");
          const off = yield* until_(
            world,
            offpath,
            (flow) => laneOf(flow).execution === "completed",
          );
          expect(Arr.map(laneOf(off).nodes, (node) => node.id)).toEqual(["build", "extra", "ship"]);
          expect(nodeOf(off, "extra")?.offPath).toBe(true);
          expect(nodeOf(off, "extra")?.said).toStartWith("Off the path · ");
          expect(nodeOf(off, "ship")?.offPath).toBe(false);

          const reforecast = yield* stepped(world, "reforecast");
          const next = yield* until_(
            world,
            reforecast,
            (flow) => nodeOf(flow, "polish") !== undefined,
          );
          expect(statesOf(next)).toEqual([
            { id: "build", state: "done" },
            { id: "polish", state: "expected" },
          ]);
          yield* open(world, "polish");
          yield* open(world, "b");
          yield* open(world, "c");
        }),
      0,
    ),
  120_000,
);

test(
  "a stopped Run says who stopped the Step it was in, and what it never reached",
  () =>
    flowing(
      "collie-flow-stop-",
      (world) =>
        Effect.gen(function* () {
          const runId = yield* stepped(world, "stop");
          yield* until_(world, runId, (flow) => nodeOf(flow, "ship")?.state === "running");
          const stopped = yield* cli(world, ["run", "stop", runId]);
          expect(stopped.envelope.ok).toBe(true);
          const flow = yield* until_(world, runId, (one) => laneOf(one).execution === "stopped");
          expect(statesOf(flow)).toEqual([
            { id: "build", state: "done" },
            { id: "ship", state: "stopped" },
            { id: "wrap", state: "not-run" },
          ]);
          expect(nodeOf(flow, "ship")?.said).toBe("Stopped by the CLI");
          expect(nodeOf(flow, "wrap")?.said).toBe("Not run");
        }),
      0,
    ),
  120_000,
);

test(
  "a host killed inside a Step is that Step's second attempt, entered once",
  () =>
    flowing(
      "collie-flow-crash-",
      (world) =>
        Effect.gen(function* () {
          const runId = yield* stepped(world, "crash");
          yield* until_(world, runId, (flow) => nodeOf(flow, "build")?.state === "running");
          const owner = yield* ownerOf(world.state);
          process.kill(owner!.pid, "SIGKILL");
          // The next command starts the next host, which recovers the Run.
          yield* cli(world, ["run", "show", runId]);
          yield* open(world, "build");
          const flow = yield* until_(world, runId, (one) => laneOf(one).execution === "completed");
          const build = nodeOf(flow, "build")!;
          expect(Arr.map(build.attempts, (one) => one.cause)).toEqual([null, "restarted"]);
          expect(build.said).toEndWith(" · 2nd attempt");
          const lines = Arr.filter(
            Str.split(
              yield* (yield* FileSystem.FileSystem)
                .readFileString(`${runDir(world.state, runId)}/${STEPS_FILE}`)
                .pipe(Effect.orDie),
              "\n",
            ),
            (line) =>
              pipe_(line, Str.includes('"kind":"enter"')) &&
              pipe_(line, Str.includes('"key":"build"')),
          );
          expect(lines).toHaveLength(1);
          const log = yield* (yield* FileSystem.FileSystem)
            .readFileString(`${runDir(world.state, runId)}/log.txt`)
            .pipe(Effect.orElseSucceed(() => ""));
          expect(
            Arr.filter(Str.split(log, "\n"), (line) => line === "── Build it ──"),
          ).toHaveLength(1);
        }),
      0,
    ),
  120_000,
);

test(
  "a Run resumed after its Step parked takes that Step again, as resumed",
  () =>
    flowing(
      "collie-flow-resume-",
      (world) =>
        Effect.gen(function* () {
          const runId = yield* stepped(world, "parks");
          yield* until_(world, runId, (flow) => laneOf(flow).execution === "suspended");
          yield* open(world, "build");
          const resumed = yield* cli(world, ["run", "resume", runId]);
          expect(resumed.envelope.ok).toBe(true);
          const flow = yield* until_(world, runId, (one) => laneOf(one).execution === "completed");
          expect(
            Option.getOrUndefined(
              Option.map(Option.fromNullishOr(nodeOf(flow, "build")), (present__) =>
                Arr.map(present__.attempts, (one) => one.cause),
              ),
            ),
          ).toEqual([null, "resumed"]);
        }),
      0,
    ),
  120_000,
);

test(
  "a failed Step's action retries its own Run and records the resumed attempt",
  () =>
    flowing(
      "collie-flow-retry-action-",
      (world) =>
        Effect.gen(function* () {
          const started = yield* cli(world, [
            "run",
            "start",
            "retry-steps",
            "--input",
            `gates=${gatesOf(world)}`,
          ]);
          expect(started.envelope).toMatchObject({ ok: true });
          const { runId: run } = yield* Schema.decodeUnknownEffect(RunId)(
            started.envelope.data,
          ).pipe(Effect.orDie);
          yield* until_(world, run, (flow) => laneOf(flow).execution === "suspended");
          const shown = yield* cli(world, ["run", "show", run]);
          const flow = (yield* Schema.decodeUnknownEffect(Schema.Struct({ flow: Schema.Unknown }))(
            shown.envelope.data,
          ).pipe(Effect.orDie)).flow;
          expect(flow).toMatchObject({
            current: { run, node: "second" },
            lanes: [
              {
                nodes: [
                  { id: "first", state: "done", primary: null },
                  { id: "second", state: "failed", primary: "retry" },
                ],
              },
            ],
          });
          yield* open(world, "pass");
          expect((yield* cli(world, ["run", "resume", run])).envelope.ok).toBe(true);
          const resumed = yield* until_(world, run, (one) => laneOf(one).execution === "completed");
          expect(
            Option.getOrUndefined(
              Option.map(Option.fromNullishOr(nodeOf(resumed, "second")), (present___) =>
                Arr.map(present___.attempts, (one) => one.cause),
              ),
            ),
          ).toEqual([null, "resumed"]);
        }),
      0,
      ["retry-steps.workflow.ts"],
    ),
  120_000,
);

test(
  "a Step asleep on a durable timer is waiting, and says when it wakes",
  () =>
    flowing(
      "collie-flow-timer-",
      (world) =>
        Effect.gen(function* () {
          const before = yield* Clock.currentTimeMillis;
          const runId = yield* stepped(world, "timer");
          const flow = yield* until_(
            world,
            runId,
            (one) => nodeOf(one, "nap")?.state === "waiting",
          );
          const nap = nodeOf(flow, "nap")!;
          expect(nap.wait).toBe("timer");
          // The host was started on UTC, as this process is.
          const wakes = (at: number) =>
            `Wakes at ${pipe_(DateTime.formatIso(DateTime.makeUnsafe(at + 3_600_000)), Str.slice(11, 16))}`;
          const after = yield* Clock.currentTimeMillis;
          expect([wakes(before), wakes(after)]).toContain(nap.said!);
        }),
      0,
    ),
  120_000,
);

test(
  "a module that declares nothing is drawn as what happened, by name, with nothing to come",
  () =>
    flowing(
      "collie-flow-undeclared-",
      (world) =>
        Effect.gen(function* () {
          const runId = yield* start(world, "attended", { work: "it" });
          const asking = yield* until_(world, runId, (flow) =>
            Arr.some(laneOf(flow).nodes, (node) => node.state === "needs-you"),
          );
          expect(laneOf(asking).declared).toBe(false);
          expect(statesOf(asking)).toEqual([
            { id: "build", state: "done" },
            { id: "go", state: "needs-you" },
          ]);
          const build = nodeOf(asking, "build")!;
          expect(build).toMatchObject({
            declared: false,
            title: "build",
            said: "Done",
            ended: null,
          });
          yield* cli(world, ["run", "answer", runId, "yes", "--decision", "go"]);
          const done = yield* until_(
            world,
            runId,
            (flow) => laneOf(flow).execution === "completed",
          );
          expect(Arr.map(laneOf(done).nodes, (node) => [node.title, node.state])).toEqual([
            ["build", "done"],
            ["go", "done"],
            ["check", "done"],
          ]);
        }),
      2,
      ["attended.workflow.ts"],
    ),
  120_000,
);

test(
  "workflow check refuses a path that lists one Step twice, by its id",
  () =>
    flowing(
      "collie-flow-check-",
      (world) =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const source = yield* fs
            .readFileString(`${world.user}/stepped.workflow.ts`)
            .pipe(Effect.orDie);
          yield* fs
            .writeFileString(
              `${world.user}/stepped.workflow.ts`,
              pipe_(
                source,
                Str.replace("path: [build, decide, ship]", "path: [build, decide, build]"),
              ),
            )
            .pipe(Effect.orDie);
          const checked = yield* cli(world, ["workflow", "check", "stepped"]);
          expect(checked.exit).not.toBe(0);
          expect(checked.envelope.error?.message ?? "").toContain(
            'path lists the Step "build" more than once',
          );
        }),
      0,
    ),
  120_000,
);

const RunShow = Schema.Struct({ flow: Schema.Unknown });

const children = (world: World, parent: string) =>
  until(
    () => cli(world, ["run", "list"]),
    ({ envelope }) =>
      pipe_(JSON.stringify(envelope.data ?? ""), Str.includes(`"parent":"${parent}"`)),
  ).pipe(
    Effect.flatMap(({ envelope }) =>
      Schema.decodeUnknownEffect(
        Schema.Struct({
          runs: Schema.Array(
            Schema.Struct({ runId: Schema.String, parent: Schema.NullOr(Schema.String) }),
          ),
        }),
      )(envelope.data),
    ),
    Effect.map(({ runs }) =>
      Arr.map(
        Arr.filter(runs, (one) => one.parent === parent),
        (one) => one.runId,
      ),
    ),
    Effect.orDie,
  );

test(
  "a child started into the same Task is a row of its own, and its parent's row has no node for it",
  () =>
    flowing(
      "collie-flow-same-task-",
      (world) =>
        Effect.gen(function* () {
          yield* recordedTask(world, "task-same");
          const parent = yield* parented(world, "same", "task-same");
          const flow = yield* until_(
            world,
            parent,
            (one) =>
              one.lanes.length === 2 &&
              Arr.every(one.lanes, (lane) => lane.execution === "completed"),
          );
          const [kid] = yield* children(world, parent);
          expect(Arr.map(flow.lanes, (lane) => lane.run)).toEqual([parent, kid!]);
          expect(flow.lanes[1]!.startedBy).toEqual({ run: parent, step: "spawn" });
          expect(Arr.map(flow.lanes[0]!.nodes, (node) => [node.id, node.kind])).toEqual([
            ["spawn", "workflow"],
            ["wrap", "check"],
          ]);
          expect(flow.lanes[0]!.nodes[0]!.link).toBeUndefined();

          // Either Run's details carry its Task's one Flow, and so does `run show`.
          expect(yield* flowOf(world, kid!)).toEqual(flow);
          const shown = yield* cli(world, ["run", "show", kid!]);
          const { flow: carried } = yield* Schema.decodeUnknownEffect(RunShow)(
            shown.envelope.data,
          ).pipe(Effect.orDie);
          expect(carried).toEqual(flow);

          // The card's strip is the leading Run's row, as `--json board` carries it.
          const board = yield* cli(world, ["board"]);
          const { tasks } = yield* Schema.decodeUnknownEffect(
            Schema.Struct({
              tasks: Schema.Array(
                Schema.Struct({
                  run: Schema.String,
                  runs: Schema.Array(Schema.String),
                  flow: Schema.optionalKey(Schema.Unknown),
                }),
              ),
            }),
          )(board.envelope.data).pipe(Effect.orDie);
          const card = Option.getOrUndefined(
            Arr.findFirst(tasks, (one) => one.runs.includes(parent)),
          )!;
          const leading = Option.getOrUndefined(
            Arr.findFirst(flow.lanes, (lane) => lane.run === card.run),
          )!;
          expect(card.flow).toEqual({
            glyphs: Arr.map(leading.nodes, (node) => ({ title: node.title, state: node.state })),
            release: 0,
            current: null,
          });

          yield* recordedTask(world, "task-loose");
          const loose = yield* parented(world, "loose", "task-loose");
          const outside = yield* until_(
            world,
            loose,
            (one) =>
              one.lanes.length === 2 &&
              Arr.every(one.lanes, (lane) => lane.execution === "completed"),
          );
          expect(outside.lanes[1]!.startedBy).toEqual({ run: loose, step: null });
          expect(Arr.map(outside.lanes[0]!.nodes, (node) => [node.id, node.state])).toEqual([
            ["spawn", "not-run"],
            ["wrap", "done"],
          ]);
        }),
      0,
      ["parents.workflow.ts", "plain.workflow.ts"],
    ),
  120_000,
);

test(
  "a child started as a Task of its own is a link on the Step that started it",
  () =>
    flowing(
      "collie-flow-own-task-",
      (world) =>
        Effect.gen(function* () {
          const parent = yield* parented(world, "own");
          const flow = yield* until_(world, parent, (one) => laneOf(one).execution === "completed");
          const [kid] = yield* children(world, parent);
          expect(flow.lanes).toHaveLength(1);
          expect(nodeOf(flow, "spawn")?.link).toMatchObject({ run: kid!, state: "done" });
          const own = yield* until_(world, kid!, (one) => one.lanes.length > 0);
          expect(Arr.map(own.lanes, (lane) => lane.run)).toEqual([kid!]);
        }),
      0,
      ["parents.workflow.ts", "plain.workflow.ts"],
    ),
  120_000,
);

test(
  "each item of a workflow Step links to the Task it started",
  () =>
    flowing(
      "collie-flow-item-tasks-",
      (world) =>
        Effect.gen(function* () {
          const parent = yield* parented(world, "own-items");
          const flow = yield* until_(world, parent, (one) => laneOf(one).execution === "completed");
          const kids = yield* children(world, parent);
          const spawn = nodeOf(flow, "spawn")!;
          expect(spawn.link).toBeUndefined();
          expect(Arr.map(spawn.runs, (one) => [one.title, one.link?.state])).toEqual([
            ["first", "done"],
            ["second", "done"],
          ]);
          expect(new Set(Arr.map(spawn.runs, (one) => one.link?.run))).toEqual(new Set(kids));
          expect(new Set(Arr.map(spawn.runs, (one) => one.link?.run)).size).toBe(2);
        }),
      0,
      ["parents.workflow.ts", "plain.workflow.ts"],
    ),
  120_000,
);

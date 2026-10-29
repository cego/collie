// The board as the host serves it on `FrontDoorRpcs`: what a client on another computer
// reads, over the same socket every client uses.

import * as Arr from "effect/Array";
import * as Str from "effect/String";
import { pipe as pipe_ } from "effect/Function";
import { expect, test } from "bun:test";
import {
  Clock,
  Deferred,
  type Duration,
  Effect,
  Fiber,
  FileSystem,
  Logger,
  Option,
  Path,
  Queue,
  Schedule,
  Schema,
  Stream,
  flow as Schemaflow,
  Result,
} from "effect";
import {
  BoardMessage,
  type Flow,
  PaneAt,
  PROTOCOL,
  TaskView,
  type BoardSnapshot,
} from "../src/board-model";
import { boardMessages, shareBoard } from "../src/board-stream";
import { recordDisposition } from "../src/disposition";
import { currentEnv } from "../src/env";
import { Herdr } from "../src/herdr";
import { BUILD, boardWrites, connect, drawerWrites, frontDoor, socketOf } from "../src/host";
import { handoffsIn } from "../src/handoffs";
import { followDetail } from "../src/run-detail";
import { foundationLayer } from "../src/engine";
import { Store } from "../src/store";
import { readTask, writeTask } from "../src/task";
import { TestClock } from "effect/testing";
import { fastForward, runEffect } from "./support/effect";
import { stopHost, until } from "./support/host";
import { task } from "./support/task";
import { collie, proves } from "./support/world";

const asSessions = Schemaflow(
  Schema.encodeResult(
    Schema.fromJsonString(
      Schema.Array(Schema.Struct({ name: Schema.String, socket_path: Schema.String })),
    ),
  ),
  Result.getOrThrow,
);

const firstSnapshot = (state: string) =>
  Effect.scoped(
    Effect.gen(function* () {
      const door = yield* frontDoor(socketOf(state));
      const first = yield* Stream.runHead(door.board());
      return first._tag === "Some" && first.value._tag === "Snapshot" ? first.value : null;
    }),
  ).pipe(Effect.orDie);

test(
  "a client reads a snapshot, then keyed changes to files the host does not write, then a fresh snapshot",
  () =>
    proves(
      "collie-board-stream-",
      (world) =>
        Effect.gen(function* () {
          yield* writeTask(world.state, {
            id: "task-1",
            workspace: "w1",
            label: "project | Plain",
            cwd: world.project,
            created_at: "2026-10-01T09:00:00Z",
          }).pipe(Effect.orDie);
          const started = yield* collie(world, [
            "run",
            "start",
            "plain",
            "--task",
            "task-1",
            "--input",
            "note=hi",
          ]);
          expect(started.envelope.ok).toBe(true);

          const renamed = (message: BoardMessage) =>
            message._tag === "Upsert" && message.task.name === "Renamed";
          const door = yield* frontDoor(socketOf(world.state)).pipe(Effect.orDie);
          const opened = yield* Deferred.make<BoardSnapshot>();
          const reading = yield* door.board().pipe(
            Stream.tap((message) =>
              message._tag === "Snapshot" ? Deferred.succeed(opened, message) : Effect.void,
            ),
            Stream.takeUntil(renamed),
            Stream.runCollect,
            Effect.forkScoped,
          );
          // A second subscriber rides the same change stream and is told too.
          const alongside = yield* (yield* frontDoor(socketOf(world.state)).pipe(Effect.orDie))
            .board()
            .pipe(Stream.filter(renamed), Stream.runHead, Effect.forkScoped);
          const snapshot = yield* Deferred.await(opened);
          expect(snapshot.protocol).toBe(PROTOCOL);
          expect(snapshot.build).toBe(BUILD);
          expect(snapshot.installation).not.toBe("");
          expect(Arr.map(snapshot.tasks, (task) => task.name)).toEqual(["Plain"]);
          const runId = snapshot.tasks[0]!.run;

          yield* recordDisposition(`${world.state}/runs/${runId}`, {
            kind: "merged",
            ref: "",
            at: "2026-10-01T12:00:00Z",
            by: "human",
            note: null,
          }).pipe(Effect.orDie);
          const record = yield* readTask(world.state, "task-1").pipe(Effect.orDie);
          yield* writeTask(world.state, { ...record!, label: "project | Renamed" }).pipe(
            Effect.orDie,
          );

          const messages = yield* Fiber.join(reading).pipe(Effect.timeout("20 seconds"));
          expect((yield* Fiber.join(alongside).pipe(Effect.timeout("20 seconds")))._tag).toBe(
            "Some",
          );
          const changes = Arr.filter(messages.slice(1), (message) => message._tag !== "Unknown");
          expect(Arr.every(changes, (message) => message._tag !== "Snapshot")).toBe(true);
          const seqs = [snapshot.seq, ...Arr.map(changes, (message) => message.seq)];
          expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
          expect(new Set(seqs).size).toBe(seqs.length);
          const last = changes.at(-1)!;
          expect(last._tag === "Upsert" && last.task.id).toBe(snapshot.tasks[0]!.id);

          // A client that comes back is told where the board is now, not what it missed.
          const again = yield* firstSnapshot(world.state);
          expect(again?._tag).toBe("Snapshot");
          expect(again?.tasks[0]?.disposition).toBe("merged");
          expect(again?.tasks[0]?.name).toBe("Renamed");

          // The CLI prints that same snapshot.
          const printed = yield* collie(world, ["board"]);
          const cards = (yield* Schema.decodeUnknownEffect(
            Schema.Struct({ tasks: Schema.Array(TaskView) }),
          )(printed.envelope.data).pipe(Effect.orDie)).tasks;
          expect(Arr.map(cards, ({ id, name, sentence }) => ({ id, name, sentence }))).toEqual(
            Arr.map(again!.tasks, ({ id, name, sentence }) => ({ id, name, sentence })),
          );

          // Every subscriber has left; one that reconnects is still told what changes.
          const retitled = (message: BoardMessage) =>
            message._tag === "Upsert" && message.task.name === "Retitled";
          const back = yield* (yield* frontDoor(socketOf(world.state)).pipe(Effect.orDie))
            .board()
            .pipe(
              Stream.tap((message) =>
                message._tag === "Snapshot"
                  ? writeTask(world.state, { ...record!, label: "project | Retitled" }).pipe(
                      Effect.orDie,
                    )
                  : Effect.void,
              ),
              Stream.filter(retitled),
              Stream.runHead,
              Effect.forkScoped,
            );
          expect((yield* Fiber.join(back).pipe(Effect.timeout("20 seconds")))._tag).toBe("Some");
          yield* stopHost(world.state);
        }),
      ["plain.workflow.ts"],
    ),
  120_000,
);

test(
  "two clients of one host read the same board",
  () =>
    proves(
      "collie-board-shared-",
      (world) =>
        Effect.gen(function* () {
          const started = yield* collie(world, ["run", "start", "plain", "--input", "note=hi"]);
          expect(started.envelope.ok).toBe(true);
          const { runId } = yield* Schema.decodeUnknownEffect(
            Schema.Struct({ runId: Schema.String }),
          )(started.envelope.data).pipe(Effect.orDie);
          expect((yield* collie(world, ["run", "wait", runId])).envelope.ok).toBe(true);
          // The host sees the finish a moment after the wait returns.
          yield* until(
            () => firstSnapshot(world.state),
            (snapshot) => snapshot?.tasks[0]?.state === "done",
          );
          const [first, second] = yield* Effect.all(
            [firstSnapshot(world.state), firstSnapshot(world.state)],
            { concurrency: "unbounded" },
          );
          yield* stopHost(world.state);
          expect(
            Option.getOrUndefined(
              Option.map(Option.fromNullishOr(first), (present) =>
                Arr.map(present.tasks, (one) => one.name),
              ),
            ),
          ).toEqual(["Plain"]);
          // `age` is reckoned when a board is built, and a tick may build one between the two.
          const ageless = (tasks: ReadonlyArray<TaskView> = []) =>
            Arr.map(tasks, (task) => ({ ...task, age: null }));
          expect(ageless(second?.tasks)).toEqual(ageless(first?.tasks));
        }),
      ["plain.workflow.ts"],
    ),
  120_000,
);

const readsOnlyOnTicks = (drawer: boolean) =>
  proves(
    "collie-board-reading-",
    (world) =>
      Effect.gen(function* () {
        yield* writeTask(world.state, {
          id: "task-1",
          workspace: "w1",
          label: "project | Plain",
          cwd: world.project,
          created_at: "2026-10-01T09:00:00Z",
        }).pipe(Effect.orDie);
        const started = yield* collie(world, [
          "run",
          "start",
          "plain",
          "--task",
          "task-1",
          "--input",
          "note=hi",
        ]);
        const { runId } = yield* Schema.decodeUnknownEffect(
          Schema.Struct({ runId: Schema.String }),
        )(started.envelope.data).pipe(Effect.orDie);
        expect((yield* collie(world, ["run", "wait", runId])).envelope.ok).toBe(true);
        yield* until(
          () => firstSnapshot(world.state),
          (snapshot) => snapshot?.tasks[0]?.state === "done",
        );
        const record = (yield* readTask(world.state, "task-1").pipe(Effect.orDie))!;
        const door = yield* frontDoor(socketOf(world.state)).pipe(Effect.orDie);
        if (drawer) {
          const opened = yield* Deferred.make<void>();
          yield* door.runDetail({ runId, tail: false, pages: 1, refreshMr: false }).pipe(
            Stream.tap(() => Deferred.succeed(opened, undefined)),
            Stream.runDrain,
            Effect.ignore,
            Effect.forkScoped,
          );
          yield* Deferred.await(opened);
        }
        const log = `${(yield* Path.Path).dirname(world.state)}/herdr-calls.jsonl`;
        const lists = Effect.map(
          Effect.flatMap(FileSystem.FileSystem, (fs) => fs.readFileString(log)),
          (text) =>
            Arr.filter(Str.split(text, "\n"), (line) => /"cmd":"(agent|pane) list"/.test(line))
              .length,
        ).pipe(Effect.orDie);
        const before = yield* lists;
        const since = yield* Clock.currentTimeMillis;
        for (const name of ["One", "Two", "Three", "Four", "Five", "Six"]) {
          const shown = yield* door.board().pipe(
            Stream.filter((message) =>
              message._tag === "Snapshot"
                ? Arr.some(message.tasks, (one) => one.name === name)
                : message._tag === "Upsert" && message.task.name === name,
            ),
            Stream.runHead,
            Effect.forkScoped,
          );
          yield* writeTask(world.state, { ...record, label: `project | ${name}` }).pipe(
            Effect.orDie,
          );
          expect((yield* Fiber.join(shown).pipe(Effect.timeout("20 seconds")))._tag).toBe("Some");
        }
        const ticks = Math.ceil(((yield* Clock.currentTimeMillis) - since) / 5000);
        expect((yield* lists) - before).toBeLessThanOrEqual(2 * ticks);
        yield* stopHost(world.state);
      }),
    ["plain.workflow.ts"],
  );

test(
  "a write under the state directory rebuilds the board on herdr's last reading of its agents",
  () => readsOnlyOnTicks(false),
  120_000,
);

test(
  "a Run's open drawer follows the board's reading of herdr, and reads none of its own",
  () => readsOnlyOnTicks(true),
  120_000,
);

const asJson = Schemaflow(
  Schema.encodeResult(Schema.fromJsonString(Schema.Unknown)),
  Result.getOrThrow,
);
const Herd = Schema.fromJsonString(
  Schema.StructWithRest(
    Schema.Struct({
      agents: Schema.Array(
        Schema.StructWithRest(Schema.Struct({ name: Schema.String }), [
          Schema.Record(Schema.String, Schema.Json),
        ]),
      ),
    }),
    [Schema.Record(Schema.String, Schema.Json)],
  ),
);

/** The actions a Run's Flow offers on the node of the agent named `agent`. */
const actionsOf = (flow: Flow | null | undefined, agent: string) =>
  Option.getOrUndefined(
    Option.flatMap(Option.fromNullishOr(flow), (present_) =>
      Option.map(
        Option.fromNullishOr(
          Option.getOrUndefined(
            Arr.findFirst(
              Arr.flatMap(present_.lanes, (lane) =>
                Arr.flatMap(lane.nodes, (node) => [node, ...node.runs]),
              ),
              (one) => one.agent === agent,
            ),
          ),
        ),
        (present__) => present__.actions,
      ),
    ),
  );

test(
  "run show says whether a Run's agent is alive as herdr lists it now, and a drawer opened after it draws the same",
  () =>
    proves(
      "collie-show-alive-",
      (world) =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const outputs = `${world.home}/outputs.json`;
          yield* fs.writeFileString(outputs, asJson([{ verdict: "done" }]));
          const started = yield* collie(
            world,
            ["run", "start", "attended", "--input", "work=the link"],
            { FAKE_HERDR_OUTPUTS: outputs },
          );
          const { runId } = yield* Schema.decodeUnknownEffect(
            Schema.Struct({ runId: Schema.String }),
          )(started.envelope.data).pipe(Effect.orDie);
          const agent = `${runId}-build-r1`;
          const client = yield* connect(world.state);
          const shown = () =>
            Effect.map(client.shown({ runId }), (one) => actionsOf(one?.flow, agent));
          const door = yield* frontDoor(socketOf(world.state));
          const drawn = () =>
            door.runDetail({ runId, tail: false, pages: 1, refreshMr: false }).pipe(
              Stream.runHead,
              Effect.map((one) => actionsOf(Option.getOrNull(one)?.flow, agent)),
            );
          yield* until(shown, (actions) => actions?.includes("tell") === true);
          yield* until(drawn, (actions) => actions?.includes("tell") === true);

          const state = `${(yield* Path.Path).dirname(world.state)}/herdr-calls.jsonl.state.json`;
          const herd = yield* Schema.decodeEffect(Herd)(yield* fs.readFileString(state)).pipe(
            Effect.orDie,
          );
          yield* fs.writeFileString(
            state,
            asJson({ ...herd, agents: Arr.filter(herd.agents, (one) => one.name !== agent) }),
          );

          expect(yield* shown()).not.toContain("tell");
          expect(yield* drawn()).not.toContain("tell");
          yield* stopHost(world.state);
        }).pipe(Effect.orDie),
      ["attended.workflow.ts"],
    ),
  120_000,
);

test(
  "the installation id is the state directory's, through a host restart",
  () =>
    proves(
      "collie-board-installation-",
      (world) =>
        Effect.gen(function* () {
          expect((yield* collie(world, ["board"])).envelope.ok).toBe(true);
          const before = yield* firstSnapshot(world.state);
          yield* stopHost(world.state);
          expect((yield* collie(world, ["board"])).envelope.ok).toBe(true);
          const after = yield* firstSnapshot(world.state);
          yield* stopHost(world.state);
          expect(after?.installation).toBe(before!.installation);
        }),
      [],
    ),
  120_000,
);

test("a kind of message this client does not know is read, and a broken known one refused", () => {
  const decode = Schemaflow(Schema.decodeUnknownResult(BoardMessage), Result.getOrThrow);
  expect(decode({ _tag: "Herded", seq: 4, herd: "x" })).toEqual({
    _tag: "Unknown",
    kind: "Herded",
    seq: 4,
  });
  expect(() => decode({ _tag: "Upsert", seq: 5 })).toThrow();
});

test("an older host's focus, which names no pane, still decodes", () => {
  const decode = Schemaflow(Schema.decodeUnknownResult(PaneAt), Result.getOrThrow);
  expect(decode({ session: null, workspace: "w", tab: "t" })).toEqual({
    session: null,
    workspace: "w",
    tab: "t",
  });
  expect(decode({ session: "work", workspace: "w", tab: "t", pane: "1-2" }).pane).toBe("1-2");
});

const HEAD = { installation: "i", build: "b", protocol: PROTOCOL, herds: [] };

/** A board built from what the test hands it, one build at a time, counting each. */
const handBuilt = Effect.gen(function* () {
  const builds = yield* Queue.unbounded<ReadonlyArray<TaskView> | "fails">();
  const changed = yield* Queue.unbounded<void>();
  let calls = 0;
  const build = Effect.suspend(() => {
    calls++;
    return Queue.take(builds);
  }).pipe(
    Effect.filterOrFail(
      (next) => next !== "fails",
      () => "unreadable" as const,
    ),
  );
  const { boards } = yield* shareBoard({ build, changed: Stream.fromQueue(changed) });
  const follow = (count: number) =>
    boardMessages({ head: HEAD, boards }).pipe(
      Stream.take(count),
      Stream.runCollect,
      Effect.forkScoped,
    );
  /** Hands over a board and waits until a build has taken it, so the next change is its own. */
  const built = (next: ReadonlyArray<TaskView> | "fails") =>
    Queue.offer(builds, next).pipe(
      Effect.andThen(
        Effect.gen(function* () {
          while ((yield* Queue.size(builds)) > 0) yield* Effect.yieldNow;
        }),
      ),
    );
  return { builds, changed, boards, follow, built, calls: () => calls };
});

const one = task({ id: "a" });
const two = task({ id: "b" });
const tags = (messages: ReadonlyArray<BoardMessage>) =>
  Arr.map(messages, (message) => message._tag);
const seqs = (messages: ReadonlyArray<BoardMessage>) =>
  Arr.map(messages, (message) => ("seq" in message ? message.seq : null));

test("two clients of one board cost one build per change, and each is told what changed", () =>
  runEffect(
    Effect.scoped(
      Effect.gen(function* () {
        const hand = yield* handBuilt;
        const first = yield* hand.follow(2);
        const second = yield* hand.follow(2);
        yield* hand.built([one, two]);
        yield* Queue.offer(hand.changed, undefined);
        yield* Queue.offer(hand.builds, [{ ...one, sentence: "Moved." }, two]);
        const told = [yield* Fiber.join(first), yield* Fiber.join(second)];
        for (const messages of told) {
          expect(tags(messages)).toEqual(["Snapshot", "Upsert"]);
          expect(seqs(messages)).toEqual([2, 3]);
        }
        expect(hand.calls()).toBe(2);
      }),
    ),
  ));

test("a client arriving after a build is told that board, and nothing is built for it", () =>
  runEffect(
    Effect.scoped(
      Effect.gen(function* () {
        const hand = yield* handBuilt;
        yield* Queue.offer(hand.builds, [one]);
        yield* Fiber.join(yield* hand.follow(1));
        const late = yield* Fiber.join(yield* hand.follow(1));
        expect(late).toEqual([{ _tag: "Snapshot", ...HEAD, tasks: [one], seq: 1 }]);
        expect(hand.calls()).toBe(1);
      }),
    ),
  ));

test("a client arriving before the first build is told its snapshot once that build is done", () =>
  runEffect(
    Effect.scoped(
      Effect.gen(function* () {
        const hand = yield* handBuilt;
        const early = yield* hand.follow(1);
        yield* Effect.yieldNow;
        expect(early.pollUnsafe()).toBeUndefined();
        yield* Queue.offer(hand.builds, [two]);
        expect(yield* Fiber.join(early)).toEqual([
          { _tag: "Snapshot", ...HEAD, tasks: [two], seq: 1 },
        ]);
      }),
    ),
  ));

test("changes that arrive during a build are folded into one more build", () =>
  runEffect(
    Effect.scoped(
      Effect.gen(function* () {
        const hand = yield* handBuilt;
        const following = yield* hand.follow(1);
        // The first build is under way, so the changes arrive during it.
        while (hand.calls() === 0) yield* Effect.yieldNow;
        yield* Queue.offerAll(hand.changed, [undefined, undefined, undefined]);
        yield* hand.built([one]);
        yield* hand.built([one, two]);
        yield* Fiber.join(following);
        yield* Effect.yieldNow;
        expect(hand.calls()).toBe(2);
      }),
    ),
  ));

test("a build that fails leaves the last board, and the next change builds again", () =>
  runEffect(
    Effect.scoped(
      Effect.gen(function* () {
        const hand = yield* handBuilt;
        const following = yield* hand.follow(2);
        yield* hand.built([one, two]);
        yield* Queue.offer(hand.changed, undefined);
        yield* hand.built("fails");
        yield* Queue.offer(hand.changed, undefined);
        yield* Queue.offer(hand.builds, [one, { ...two, sentence: "Moved." }]);
        const messages = yield* Fiber.join(following);
        expect(messages[1]).toEqual({
          _tag: "Upsert",
          seq: 3,
          task: { ...two, sentence: "Moved." },
        });
        expect(hand.calls()).toBe(3);
      }),
    ),
  ));

test("the board is built with nobody subscribed, and every reader of one interval costs one build", () =>
  runEffect(
    Effect.scoped(
      Effect.gen(function* () {
        const hand = yield* handBuilt;
        yield* hand.built([one]);
        expect(hand.calls()).toBe(1);
        const clients = [yield* hand.follow(1), yield* hand.follow(1)];
        // News and the merge watch each read the latest board.
        const latest = [yield* Stream.runHead(hand.boards), yield* Stream.runHead(hand.boards)];
        for (const client of clients) expect(tags(yield* Fiber.join(client))).toEqual(["Snapshot"]);
        expect(Arr.map(latest, (read) => read._tag === "Some" && read.value)).toEqual([
          [one],
          [one],
        ]);
        expect(hand.calls()).toBe(1);
      }),
    ),
  ));

test("the latest board is read at once while a newer one builds, and the first is waited for", () =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const changed = yield* Queue.unbounded<void>();
        let builds = 0;
        const build = Effect.suspend(() => {
          const board = [task({ id: `built-${++builds}` })];
          return Effect.sleep("10 seconds").pipe(Effect.as(board));
        });
        const { latest } = yield* shareBoard({ build, changed: Stream.fromQueue(changed) });

        const first = yield* Effect.forkChild(latest);
        yield* Effect.yieldNow;
        expect(first.pollUnsafe()).toBeUndefined();
        yield* TestClock.adjust("10 seconds");
        expect(Arr.map(yield* Fiber.join(first), (view) => view.id)).toEqual(["built-1"]);

        yield* Queue.offer(changed, undefined);
        while (builds < 2) yield* Effect.yieldNow;
        const asked = yield* Clock.currentTimeMillis;
        const read = yield* Effect.forkChild(latest);
        for (let turn = 0; turn < 100 && read.pollUnsafe() === undefined; turn++)
          yield* Effect.yieldNow;
        expect(read.pollUnsafe()).toBeDefined();
        expect(Arr.map(yield* Fiber.join(read), (view) => view.id)).toEqual(["built-1"]);
        expect(yield* Clock.currentTimeMillis).toBe(asked);
        expect(builds).toBe(2);
      }),
    ).pipe(Effect.provide(TestClock.layer())),
  ));

const warnedDuring = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const warned: string[] = [];
    const logger = Logger.make(({ logLevel, message }) => {
      if (logLevel === "Warn") warned.push(String(message));
    });
    yield* effect.pipe(Effect.provide(Logger.layer([logger])));
    return warned;
  });

const builtIn = (took: Duration.Input) =>
  warnedDuring(
    Effect.scoped(
      Effect.gen(function* () {
        const { boards } = yield* shareBoard({
          build: Effect.sleep(took).pipe(Effect.as([one])),
          changed: Stream.never,
        });
        yield* Stream.runHead(boards);
      }),
    ).pipe(fastForward),
  );

test("a build over 2 s is logged at warn with how long it took, and a faster one is not", () =>
  runEffect(
    Effect.gen(function* () {
      const slow = yield* builtIn("3 seconds");
      expect(slow).toHaveLength(1);
      expect(slow[0]).toMatch(/the board took \d+ ms to build/);
      expect(yield* builtIn("1 second")).toEqual([]);
    }),
  ));

test("a Run recorded in the store is on the board at once, with no tick and no file event", () =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "collie-board-commit-" });
      yield* Effect.gen(function* () {
        const store = yield* Store;
        const { boards } = yield* shareBoard({
          build: store.runs.pipe(
            Effect.map((rows) => Arr.map(rows, (row) => task({ id: row.run }))),
          ),
          changed: store.changes,
        });
        yield* Stream.runHead(boards);
        yield* store.admit({
          request: "r1",
          run: "run-new",
          workflow: "quiet",
          project: dir,
          input: {},
          provenance: {},
          options: {},
          generation: "quiet-1",
          execution: "e1",
          task: null,
          parent: null,
        });
        const seen = yield* boards.pipe(
          Stream.filter((views) => Arr.some(views, (view) => view.id === "run-new")),
          Stream.runHead,
          // Well inside the 5 s tick, which this board does not have.
          Effect.timeout("3 seconds"),
        );
        expect(seen._tag).toBe("Some");
      }).pipe(Effect.provide(foundationLayer({ dir })), Effect.scoped, Effect.orDie);
    }),
  ));

test(
  "an agent in a second herdr session reaches the board and makes its card Stalled",
  () =>
    proves(
      "collie-board-sessions-",
      (world) =>
        Effect.gen(function* () {
          const first = `${world.home}/first.sock`;
          const second = `${world.home}/second.sock`;
          // Two sessions, and the Run's agent is only in the second, at its own prompt.
          // Started from a workspace in the second, so its Task is that session's.
          const env = yield* currentEnv.pipe(Effect.orDie);
          const workspace = yield* new Herdr(env)
            .workspaceCreate({ cwd: world.project, label: "builds" })
            .pipe(Effect.orDie);
          const herdr = {
            HERDR_SOCKET_PATH: second,
            HERDR_WORKSPACE_ID: workspace.workspaceId,
            FAKE_HERDR_SESSIONS: asSessions([
              { name: "desk", socket_path: first },
              { name: "builds", socket_path: second },
            ]),
            FAKE_HERDR_AGENTS_IN: second,
            FAKE_HERDR_AGENT_STATUS: "blocked",
          };
          const started = yield* collie(
            world,
            [
              "run",
              "start",
              "agent",
              "--here",
              "--input",
              "target=worktree",
              "--input",
              `cwd=${world.project}`,
              "--input",
              "skip=false",
            ],
            herdr,
          );
          expect(started.envelope.ok).toBe(true);
          const snapshot = yield* firstSnapshot(world.state).pipe(
            Effect.repeat({
              until: (read) => read?.tasks[0]?.state === "blocked",
              schedule: Schedule.spaced("250 millis"),
              times: 60,
            }),
          );
          yield* stopHost(world.state);
          // A host spawned from the first session reads the second, which it did not inherit.
          const desk = yield* collie(world, ["--json", "board"], {
            ...herdr,
            HERDR_SOCKET_PATH: first,
          });
          expect(desk.envelope.ok).toBe(true);
          const fromDesk = yield* firstSnapshot(world.state);
          yield* stopHost(world.state);
          expect(fromDesk?.tasks[0]?.state).toBe("blocked");
          expect(
            Option.getOrUndefined(
              Option.map(Option.fromNullishOr(snapshot), (present___) =>
                Arr.map(present___.herds, (herd) => herd.name),
              ),
            ),
          ).toEqual(["desk", "builds"]);
          const builds = Option.getOrUndefined(
            Option.map(Option.fromNullishOr(snapshot), (present____) =>
              Option.getOrUndefined(
                Arr.findFirst(present____.herds, (herd) => herd.name === "builds"),
              ),
            ),
          );
          expect(snapshot?.tasks[0]?.herd).toBe(builds!.id);
          expect(snapshot?.tasks[0]?.sentence).toMatch(/^Waiting for you in \S+'s pane\.$/);
        }),
      ["agent.workflow.ts", "notes.md"],
    ),
  120_000,
);

test("a reader that arrives after a change reads a board built after it, not the one before", () =>
  runEffect(
    Effect.scoped(
      Effect.gen(function* () {
        let runs = 0;
        const changed = yield* Queue.unbounded<void>();
        const { boards } = yield* shareBoard({
          build: Effect.sleep("1 second").pipe(Effect.map(() => runs)),
          changed: Stream.fromQueue(changed),
        });
        expect(Option.getOrThrow(yield* Stream.runHead(boards))).toBe(0);
        runs = 1;
        yield* Queue.offer(changed, undefined);
        yield* Effect.yieldNow;
        expect(Option.getOrThrow(yield* Stream.runHead(boards))).toBe(1);
      }),
    ).pipe(fastForward),
  ));

/** A state directory with a Run's files, and the paths its board's watch lets through. */
const watchedState = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const dir = yield* fs.makeTempDirectoryScoped({
    prefix: "collie-board-writes-",
  });
  const write = (file: string, text = "x\n") =>
    fs
      .makeDirectory(path.dirname(`${dir}/${file}`), { recursive: true })
      .pipe(Effect.andThen(fs.writeFileString(`${dir}/${file}`, text)), Effect.orDie);
  const append = (file: string) =>
    fs.writeFileString(`${dir}/${file}`, "more\n", { flag: "a" }).pipe(Effect.orDie);
  for (const file of [
    "runs/run-a/handoffs/test.log",
    "evidence/run-a/verify/v.log",
    "evidence/run-a/checks/c.log",
    "compaction/agent-a/questions.jsonl",
    "compaction/agent-a/events.jsonl",
    "agents/run-a/step.json",
    "tasks/task-a.json",
    "ssh/.made",
  ])
    yield* write(file);
  yield* write("runs/run-a/handoffs/ready", "");
  const seen = yield* Queue.unbounded<string>();
  yield* Effect.forkScoped(Stream.runForEach(boardWrites(dir), (path) => Queue.offer(seen, path)));
  yield* until(() => write("ready").pipe(Effect.andThen(Queue.poll(seen))), Option.isSome);
  const told = new Set<string>();
  /** Each path through not told before, readiness left out, once every one of `wanted` is. */
  const through = (wanted: ReadonlyArray<string>) =>
    Effect.gen(function* () {
      const paths = new Set<string>();
      while (!Arr.every(wanted, (one) => paths.has(one))) {
        const written = yield* Queue.take(seen);
        if (!pipe_(written, Str.endsWith("ready")) && !told.has(written)) paths.add(written);
      }
      for (const one of paths) told.add(one);
      return [...paths].sort();
    }).pipe(Effect.timeoutOption("2 seconds"));
  return { dir, write, append, through };
});

test("no write to the host's own bookkeeping reaches the board", () =>
  runEffect(
    Effect.gen(function* () {
      const { write, through } = yield* watchedState;
      for (const file of [
        "host.lock",
        "tasks/task-a.json.lock",
        "tasks/task-a.json.123.1.tmp",
        "host.log",
        "host.log.1",
        "host.out",
        "host.out.1",
        "host.db-wal",
        "host.db-journal",
        "ssh/98276eb421de291c",
        "compaction/agent-a/events.jsonl",
        "compaction/agent-a/events.lock",
        "compaction/agent-a/control.json",
      ])
        yield* write(file);
      yield* write("tasks/marker.json");
      expect(yield* through(["tasks/marker.json"])).toEqual(Option.some(["tasks/marker.json"]));
    }),
  ));

test("a log growing in a Run's handoffs or verify logs reaches no board, and a file created there does", () =>
  runEffect(
    Effect.gen(function* () {
      const { write, append, through } = yield* watchedState;
      yield* append("runs/run-a/handoffs/test.log");
      yield* append("evidence/run-a/verify/v.log");
      yield* write("tasks/marker.json");
      expect(yield* through(["tasks/marker.json"])).toEqual(Option.some(["tasks/marker.json"]));
      const created = ["evidence/run-a/verify/w.log", "runs/run-a/handoffs/new.log"];
      for (const file of created) yield* write(file);
      expect(yield* through(created)).toEqual(Option.some(created));
    }),
  ));

test("a running check's log, an agent's question and its Output reach the board as they are written", () =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const { dir, write, append, through } = yield* watchedState;
      yield* append("evidence/run-a/checks/c.log");
      yield* append("compaction/agent-a/questions.jsonl");
      yield* write("agents/run-a/step.json.123.tmp", "{}");
      yield* fs.rename(`${dir}/agents/run-a/step.json.123.tmp`, `${dir}/agents/run-a/step.json`);
      const read = [
        "agents/run-a/step.json",
        "compaction/agent-a/questions.jsonl",
        "evidence/run-a/checks/c.log",
      ];
      expect(yield* through(read)).toEqual(Option.some(read));
    }),
  ));

test("a Run's open drawer lists a handoff's new size while the board's watch lets the write by", () =>
  runEffect(
    Effect.gen(function* () {
      const { dir, write, append, through } = yield* watchedState;
      let listed: ReadonlyArray<{
        readonly name: string;
        readonly bytes: number;
      }> = [];
      let drawerSaw = false;
      const changed = boardWrites(dir).pipe(Stream.debounce("200 millis"));
      const own = drawerWrites(dir, "run-a").pipe(
        Stream.tap(() => Effect.sync(() => (drawerSaw = true))),
      );
      yield* Effect.forkScoped(
        Stream.runForEach(
          followDetail(handoffsIn(`${dir}/runs/run-a`), Stream.merge(changed, own)),
          (files) => Effect.sync(() => (listed = files)),
        ),
      );
      const bytesOf = (name: string) => () =>
        Effect.sync(
          () =>
            Option.getOrUndefined(Arr.findFirst(listed, (file) => file.name === name))?.bytes ?? 0,
        );
      // Further apart than the drawer's debounce, which each write would put off again.
      const followed = append("runs/run-a/handoffs/ready").pipe(
        Effect.map(() => drawerSaw),
        Effect.repeat({ until: (saw) => saw, schedule: Schedule.spaced("300 millis") }),
        Effect.timeoutOption("2 seconds"),
      );
      expect(yield* followed).toEqual(Option.some(true));
      yield* append("runs/run-a/handoffs/test.log");
      const grown = until(bytesOf("test.log"), (bytes) => bytes === 7);
      expect(yield* grown.pipe(Effect.timeoutOption("2 seconds"))).toEqual(Option.some(7));
      yield* write("tasks/marker.json");
      expect(yield* through(["tasks/marker.json"])).toEqual(Option.some(["tasks/marker.json"]));
    }),
  ));

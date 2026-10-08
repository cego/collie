// The board as the host serves it on `FrontDoorRpcs`: what a client on another computer
// reads, over the same socket every client uses.

import { expect, test } from "bun:test";
import { Deferred, Effect, Fiber, Queue, Schedule, Schema, Stream } from "effect";
import { BoardMessage, PaneAt, PROTOCOL, TaskView, type BoardSnapshot } from "../src/board-model";
import { boardMessages, shareBoard } from "../src/board-stream";
import { recordDisposition } from "../src/disposition";
import { currentEnv } from "../src/env";
import { Herdr } from "../src/herdr";
import { BUILD, frontDoor } from "../src/host";
import { readTask, writeTask } from "../src/task";
import { runEffect } from "./support/effect";
import { stopHost } from "./support/host";
import { task } from "./support/task";
import { collie, proves } from "./support/world";

const asSessions = Schema.encodeSync(
  Schema.fromJsonString(
    Schema.Array(Schema.Struct({ name: Schema.String, socket_path: Schema.String })),
  ),
);

const firstSnapshot = (state: string) =>
  Effect.scoped(
    Effect.gen(function* () {
      const door = yield* frontDoor(state);
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
          const door = yield* frontDoor(world.state).pipe(Effect.orDie);
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
          const alongside = yield* (yield* frontDoor(world.state).pipe(Effect.orDie))
            .board()
            .pipe(Stream.filter(renamed), Stream.runHead, Effect.forkScoped);
          const snapshot = yield* Deferred.await(opened);
          expect(snapshot.protocol).toBe(PROTOCOL);
          expect(snapshot.build).toBe(BUILD);
          expect(snapshot.installation).not.toBe("");
          expect(snapshot.tasks.map((task) => task.name)).toEqual(["Plain"]);
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
          const changes = messages.slice(1).filter((message) => message._tag !== "Unknown");
          expect(changes.every((message) => message._tag !== "Snapshot")).toBe(true);
          const seqs = [snapshot.seq, ...changes.map((message) => message.seq)];
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
          const cards = Schema.decodeUnknownSync(Schema.Struct({ tasks: Schema.Array(TaskView) }))(
            printed.envelope.data,
          ).tasks;
          expect(cards.map(({ id, name, sentence }) => ({ id, name, sentence }))).toEqual(
            again!.tasks.map(({ id, name, sentence }) => ({ id, name, sentence })),
          );

          // Every subscriber has left; one that reconnects is still told what changes.
          const retitled = (message: BoardMessage) =>
            message._tag === "Upsert" && message.task.name === "Retitled";
          const back = yield* (yield* frontDoor(world.state).pipe(Effect.orDie)).board().pipe(
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
          const [first, second] = yield* Effect.all(
            [firstSnapshot(world.state), firstSnapshot(world.state)],
            { concurrency: "unbounded" },
          );
          yield* stopHost(world.state);
          expect(first?.tasks.map((one) => one.name)).toEqual(["Plain"]);
          expect(second?.tasks).toEqual(first!.tasks);
        }),
      ["plain.workflow.ts"],
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
  const decode = Schema.decodeUnknownSync(BoardMessage);
  expect(decode({ _tag: "Herded", seq: 4, herd: "x" })).toEqual({
    _tag: "Unknown",
    kind: "Herded",
    seq: 4,
  });
  expect(() => decode({ _tag: "Upsert", seq: 5 })).toThrow();
});

test("an older host's focus, which names no pane, still decodes", () => {
  const decode = Schema.decodeUnknownSync(PaneAt);
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
    Effect.flatMap((next) => (next === "fails" ? Effect.fail("unreadable") : Effect.succeed(next))),
  );
  const boards = yield* shareBoard({ build, changed: Stream.fromQueue(changed) });
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
  return { builds, changed, follow, built, calls: () => calls };
});

const one = task({ id: "a" });
const two = task({ id: "b" });
const tags = (messages: ReadonlyArray<BoardMessage>) => messages.map((message) => message._tag);
const seqs = (messages: ReadonlyArray<BoardMessage>) =>
  messages.map((message) => ("seq" in message ? message.seq : null));

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
        // Nothing was removed for the failure: the next message is the next build's change.
        expect(messages[1]).toEqual({
          _tag: "Upsert",
          seq: 3,
          task: { ...two, sentence: "Moved." },
        });
        expect(hand.calls()).toBe(3);
      }),
    ),
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
          expect(snapshot?.herds.map((herd) => herd.name)).toEqual(["desk", "builds"]);
          const builds = snapshot?.herds.find((herd) => herd.name === "builds");
          expect(snapshot?.tasks[0]?.herd).toBe(builds!.id);
          expect(snapshot?.tasks[0]?.sentence).toMatch(/^Waiting for you in \S+'s pane\.$/);
        }),
      ["agent.workflow.ts", "notes.md"],
    ),
  120_000,
);

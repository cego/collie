// The board as the host serves it on `FrontDoorRpcs`: what a client on another computer
// reads, over the same socket every client uses.

import { expect, test } from "bun:test";
import { Deferred, Effect, Fiber, Queue, Schedule, Schema, Stream } from "effect";
import { BoardMessage, PROTOCOL, TaskView, type BoardSnapshot } from "../src/board-model";
import { boardMessages } from "../src/board-stream";
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
          yield* stopHost(world.state);
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

test("a Task that leaves the board is removed, and a build that fails is skipped", () =>
  runEffect(
    Effect.gen(function* () {
      const builds = yield* Queue.unbounded<ReadonlyArray<TaskView> | "fails">();
      const build = Queue.take(builds).pipe(
        Effect.flatMap((next) =>
          next === "fails" ? Effect.fail("unreadable") : Effect.succeed(next),
        ),
      );
      const changed = yield* Queue.unbounded<void>();
      const one = task({ id: "a" });
      const two = task({ id: "b" });
      yield* Queue.offerAll(builds, [[one, two], "fails", [{ ...one, sentence: "Moved." }]]);
      yield* Queue.offerAll(changed, [undefined, undefined]);
      const messages = yield* boardMessages({
        head: { installation: "i", build: "b", protocol: PROTOCOL, herds: [] },
        build,
        changed: Stream.fromQueue(changed),
      }).pipe(Stream.take(3), Stream.runCollect);
      expect(messages.map((message) => message._tag)).toEqual(["Snapshot", "Upsert", "Remove"]);
      expect(messages.map((message) => ("seq" in message ? message.seq : null))).toEqual([2, 3, 4]);
      expect(messages[2]).toEqual({ _tag: "Remove", seq: 4, id: "b" });
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
          expect(snapshot?.herds.map((herd) => herd.name)).toEqual(["desk", "builds"]);
          const builds = snapshot?.herds.find((herd) => herd.name === "builds");
          expect(snapshot?.tasks[0]?.herd).toBe(builds!.id);
          expect(snapshot?.tasks[0]?.sentence).toMatch(/^Waiting for you in \S+'s pane\.$/);
        }),
      ["agent.workflow.ts", "notes.md"],
    ),
  120_000,
);

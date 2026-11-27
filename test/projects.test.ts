import * as Arr from "effect/Array";
import * as Option from "effect/Option";
import { expect, test } from "bun:test";
import { Effect, Schema } from "effect";
import { ProjectView, TaskView } from "../src/board-model";
import { frontDoor, socketOf } from "../src/host";
import { stopHost } from "./support/host";
import { collie, proves } from "./support/world";
import { runEffect } from "./support/effect";
import { twoMachines } from "./support/peers";
import type { World } from "./support/world";
const Board = Schema.Struct({ tasks: Schema.Array(TaskView), projects: Schema.Array(ProjectView) });
const Something = Schema.Struct({ project: Schema.String });
const boardOf = (world: World) =>
  collie(world, ["board"]).pipe(
    Effect.flatMap(({ envelope }) =>
      Schema.decodeUnknownEffect(Board)(envelope.data).pipe(Effect.orDie),
    ),
  );
const projectOf = (world: World, name: string) =>
  collie(world, ["project", "create", "--name", name]).pipe(
    Effect.flatMap(({ envelope }) =>
      Schema.decodeUnknownEffect(Something)(envelope.data).pipe(Effect.orDie),
    ),
    Effect.map(({ project }) => project),
  );
const taskOf = (world: World, instruction: string, project?: string) =>
  collie(world, [
    "task",
    "create",
    "--instruction",
    instruction,
    ...(project === undefined ? [] : ["--project", project]),
  ]).pipe(
    Effect.flatMap(({ envelope }) =>
      Schema.decodeUnknownEffect(Schema.Struct({ task: Schema.String }))(envelope.data),
    ),
    Effect.map(({ task }) => task),
    Effect.orDie,
  );
const cardOf = (world: World, id: string) =>
  Effect.map(boardOf(world), (board) =>
    Option.getOrNull(Arr.findFirst(board.tasks, (one) => one.id === id)),
  );
const projectIn = (world: World, id: string) =>
  Effect.map(boardOf(world), (board) =>
    Option.getOrNull(Arr.findFirst(board.projects, (one) => one.id === id)),
  );
const file = (world: World, task: string, project: string | null, expected?: number) =>
  collie(world, [
    "task",
    "file",
    "--task",
    task,
    ...(project === null ? [] : ["--project", project]),
    ...(expected === undefined ? [] : ["--expected", String(expected)]),
  ]);
test("two Projects made here are two identities, and a Task filed into one is scoped to it", () =>
  proves(
    "collie-project-scope-",
    (world) =>
      Effect.gen(function* () {
        const payments = yield* projectOf(world, "Payments");
        const platform = yield* projectOf(world, "CEGO Platform");
        expect(payments).not.toBe(platform);
        const refunds = yield* taskOf(world, "Say a duplicate refunds notice twice", payments);
        const elsewhere = yield* taskOf(world, "Decide the payout window");
        const card = yield* cardOf(world, refunds);
        expect(card?.projectId?.id).toBe(payments);
        expect(card?.projectId?.installation).toBeString();
        expect((yield* cardOf(world, elsewhere))?.projectId).toBeNull();
        expect((yield* projectIn(world, payments))?.tasks).toBe(1);
        expect((yield* projectIn(world, platform))?.tasks).toBe(0);
      }),
    [],
  ));
test("starring a Project keeps it in its own section, and archiving it leaves its Tasks on the global board", () =>
  proves(
    "collie-project-archive-",
    (world) =>
      Effect.gen(function* () {
        const payments = yield* projectOf(world, "Payments");
        const platform = yield* projectOf(world, "CEGO Platform");
        const refunds = yield* taskOf(world, "Say a duplicate refunds notice twice", payments);
        expect((yield* collie(world, ["project", "star", "--project", platform])).envelope.ok).toBe(
          true,
        );
        expect((yield* projectIn(world, platform))?.starred).toBe(true);
        expect((yield* projectIn(world, payments))?.starred).toBe(false);
        expect(
          (yield* collie(world, ["project", "archive", "--project", payments])).envelope.ok,
        ).toBe(true);
        expect((yield* projectIn(world, payments))?.archived).toBe(true);
        // WARNING: archiving puts a Project away, never its work: the Task stays on the global board.
        expect((yield* cardOf(world, refunds))?.id).toBe(refunds);
        expect((yield* projectIn(world, payments))?.tasks).toBe(1);
        const refused = yield* file(
          world,
          yield* taskOf(world, "Move the payout window"),
          payments,
        );
        expect(refused.envelope.ok).toBe(false);
        expect(
          (yield* collie(world, ["project", "restore", "--project", payments])).envelope.ok,
        ).toBe(true);
        expect((yield* projectIn(world, payments))?.archived).toBe(false);
      }),
    [],
  ));
test("a move names the membership it saw, and a stale one is refused with the membership that won", () =>
  proves(
    "collie-project-move-",
    (world) =>
      Effect.gen(function* () {
        const payments = yield* projectOf(world, "Payments");
        const platform = yield* projectOf(world, "CEGO Platform");
        const refunds = yield* taskOf(world, "Say a duplicate refunds notice twice", payments);
        expect((yield* cardOf(world, refunds))?.membershipSeq).toBe(0);
        const moved = yield* file(world, refunds, platform, 0);
        expect(moved.envelope).toMatchObject({ ok: true, data: { result: "filed" } });
        const card = yield* cardOf(world, refunds);
        expect(card?.projectId?.id).toBe(platform);
        expect(card?.membershipSeq).toBe(1);
        // WARNING: the second move was asked against the membership before the first, so it loses.
        const stale = yield* file(world, refunds, payments, 0);
        expect(stale.envelope.ok).toBe(false);
        expect(stale.envelope.error?.details).toMatchObject({
          result: "stale",
          membership: { project: { id: platform }, seq: 1 },
        });
        expect((yield* cardOf(world, refunds))?.projectId?.id).toBe(platform);
        expect((yield* file(world, refunds, payments, 1)).envelope.ok).toBe(true);
        expect((yield* cardOf(world, refunds))?.projectId?.id).toBe(payments);
      }),
    [],
  ));
test("following a Task is kept at its owner, and needs you counts the Task once however many questions it has", () =>
  proves(
    "collie-project-follow-",
    (world) =>
      Effect.gen(function* () {
        const payments = yield* projectOf(world, "Payments");
        const first = yield* collie(world, [
          "run",
          "start",
          "asks",
          "--input",
          "goal=refund twice",
        ]).pipe(
          Effect.map(({ envelope }) =>
            Option.getOrThrow(
              Schema.decodeUnknownOption(Schema.Struct({ runId: Schema.String }))(envelope.data),
            ),
          ),
        );
        const task = yield* collie(world, ["run", "show", first.runId]).pipe(
          Effect.flatMap(({ envelope }) =>
            Schema.decodeUnknownEffect(
              Schema.Struct({ run: Schema.Struct({ task: Schema.String }) }),
            )(envelope.data),
          ),
          Effect.map(({ run }) => run.task),
          Effect.orDie,
        );
        yield* collie(world, ["task", "file", "--task", task, "--project", payments]);
        yield* collie(world, [
          "run",
          "start",
          "asks",
          "--input",
          "goal=refund twice",
          "--task",
          task,
        ]);
        const needs = (yield* projectIn(world, payments))?.needs;
        expect(needs).toBe(1);
        const followed = yield* collie(world, ["task", "follow", "--task", task]);
        expect(followed.envelope.ok).toBe(true);
        expect((yield* cardOf(world, task))?.following).toBe(true);
        yield* collie(world, ["task", "unfollow", "--task", task]);
        expect((yield* cardOf(world, task))?.following).toBeUndefined();
      }),
    ["asks.workflow.ts"],
  ));
test("a batch filing answers for every entry, and filing the same batch again changes nothing", () =>
  proves(
    "collie-project-batch-",
    (world) =>
      Effect.gen(function* () {
        const payments = yield* projectOf(world, "Payments");
        const mine = yield* taskOf(world, "Say a duplicate refunds notice twice");
        const door = yield* frontDoor(socketOf(world.state));
        const here = Option.getOrThrow(
          Option.map(
            Arr.findFirst((yield* boardOf(world)).projects, (one) => one.id === payments),
            (one) => one.installation,
          ),
        );
        const at = { installation: here, id: payments };
        const entries = [
          { task: mine, project: at },
          { task: "task-elsewhere", installation: "another-installation", project: at },
          { task: "task-unknown", project: at },
        ];
        const [first] = yield* door.act({
          actions: [{ kind: "task_file", filings: entries }],
          request: "file-1",
        });
        expect(first?.state).toBe("applied");
        expect(Arr.map(first?.filed ?? [], (one) => one.result)).toEqual([
          "filed",
          "missing",
          "missing",
        ]);
        const [again] = yield* door.act({
          actions: [{ kind: "task_file", filings: entries }],
          request: "file-2",
        });
        expect(Arr.map(again?.filed ?? [], (one) => one.result)).toEqual([
          "already",
          "missing",
          "missing",
        ]);
        expect((yield* cardOf(world, mine))?.membershipSeq).toBe(1);
      }),
    [],
  ));
test("a filing into a Project an older host never heard of is refused, and the Task is untouched", () =>
  proves(
    "collie-project-unknown-",
    (world) =>
      Effect.gen(function* () {
        const mine = yield* taskOf(world, "Say a duplicate refunds notice twice");
        const refused = yield* file(world, mine, "project-nothing");
        expect(refused.envelope.ok).toBe(false);
        yield* stopHost(world.state);
        expect((yield* cardOf(world, mine))?.projectId).toBeNull();
      }),
    [],
  ));

test("a Project another Machine owns takes a Task, and an absent or archived one leaves it alone", () =>
  runEffect(
    twoMachines(
      "collie-project-away-",
      (first, second) =>
        Effect.gen(function* () {
          yield* first.lists([second]);
          // WARNING: a command that reaches the far Machine is what pairs the two, and filing uses that route.
          expect((yield* first.cli(["--machine", "second", "board"])).envelope.ok).toBe(true);
          const payments = yield* projectOf(second.world, "Payments");
          const owner = Option.getOrThrow(
            Option.map(
              Arr.findFirst((yield* boardOf(second.world)).projects, (one) => one.id === payments),
              (one) => one.installation,
            ),
          );
          const task = yield* taskOf(first.world, "Say a duplicate refunds notice twice");
          const away = yield* file(first.world, task, "inst-nowhere:project-payments");
          expect(away.envelope.error?.message).toContain("unavailable");
          expect((yield* cardOf(first.world, task))?.projectId).toBeNull();
          const filed = yield* file(first.world, task, `${owner}:${payments}`);
          expect(filed.envelope.data).toMatchObject({ result: "filed" });
          expect((yield* cardOf(first.world, task))?.projectId).toEqual({
            installation: owner,
            id: payments,
          });
          expect(
            (yield* collie(second.world, ["project", "archive", "--project", payments])).envelope
              .ok,
          ).toBe(true);
          const other = yield* taskOf(first.world, "Move the payout window");
          const archived = yield* file(first.world, other, `${owner}:${payments}`);
          expect(archived.envelope.error?.message).toContain("archived");
          expect((yield* cardOf(first.world, other))?.projectId).toBeNull();
        }),
      [],
    ),
  ));

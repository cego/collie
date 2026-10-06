// Desktop reaches Local's host the way it reaches any Machine's: through a bridge it starts
// as `desktop`, never through Collie's own host client.

import { expect, test } from "bun:test";
import { Config, Deferred, Effect, Option, Schedule, Schema, Stream } from "effect";
import { type BoardMessage, type BoardSnapshot, PROTOCOL } from "../src/board-model";
import { readAudit } from "../src/audit";
import { runDir } from "../src/engine";
import {
  act,
  bridgeCommand,
  flockStream,
  machineBoard,
  buildVerdict,
  openBridge,
  type Route,
} from "../desktop/src/bun/machine";
import type { FlockItem } from "../desktop/src/shared/flock";
import { fastForward, watchedBy } from "./support/effect";
import { root, stopHost } from "./support/host";
import { proves } from "./support/world";

const asCommand = Schema.encodeSync(Schema.fromJsonString(Schema.Array(Schema.String)));

test(
  "Desktop sees Local's board through a bridge it started, a Run appears on it live, and what Desktop does there is recorded as Desktop's",
  () =>
    proves(
      "collie-desktop-local-",
      (world) =>
        Effect.gen(function* () {
          const binary = yield* Config.option(Config.String("COLLIE_TEST_BINARY"));
          const collie = Option.isSome(binary)
            ? [binary.value]
            : [process.execPath, `${root}src/main.ts`];
          const door = yield* openBridge(bridgeCommand(collie, "mk-pc"), {
            PATH: "/usr/bin:/bin",
            HOME: world.home,
            HERDR_PLUGIN_ROOT: world.install,
            HERDR_PLUGIN_STATE_DIR: world.state,
            COLLIE_USER_DIR: world.config,
            COLLIE_HOST: asCommand(collie),
            COLLIE_HOST_WATCH_PID: yield* watchedBy,
            HERDR_BIN_PATH: Bun.env.HERDR_BIN_PATH ?? "",
            FAKE_HERDR_LOG: Bun.env.FAKE_HERDR_LOG ?? "",
          });
          const board = yield* machineBoard({ profile: "local", name: "mk-pc" }, door).pipe(
            Stream.toPull,
          );

          const first = yield* board;
          const snapshot = first[0].message;
          expect(snapshot._tag).toBe("Snapshot");
          // The Machine is its installation, which every later message carries too.
          const installation = snapshot._tag === "Snapshot" ? snapshot.installation : "";
          expect(installation).not.toBe("");
          expect(first[0].machine).toEqual({ installation, profile: "local", name: "mk-pc" });

          const { runId } = yield* door.start({
            project: world.project,
            id: "proof",
            request: "start-1",
            input: { note: "from Desktop" },
          });
          let seen = false;
          while (!seen) {
            const next = yield* board;
            seen = next.some(
              (item) => item.message._tag === "Upsert" && item.message.task.runs.includes(runId),
            );
          }

          expect(
            yield* act(door, "hold-1", { _tag: "Control", runId, control: "hold", set: true }),
          ).not.toBe("");
          // Tried again under the same request, it is the one hold.
          yield* act(door, "hold-1", { _tag: "Control", runId, control: "hold", set: true });
          const refused = yield* act(door, "resume-x", { _tag: "Resume", runId: "r-nobody" }).pipe(
            Effect.flip,
          );
          expect(refused.reason).toBe("no Run r-nobody");

          const trail = yield* readAudit(runDir(world.state, runId));
          expect(trail.map((line) => line.actor)).toEqual([
            { origin: "desktop", requestId: "start-1", from: { client: "mk-pc" } },
            { origin: "desktop", requestId: "hold-1", from: { client: "mk-pc" } },
          ]);
          yield* stopHost(world.state);
        }).pipe(Effect.orDie),
      ["proof.workflow.ts", "helper.ts", "notes.md"],
    ),
  120_000,
);

test("Desktop's main process never reaches Collie's own host client", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const reached: string[] = [];
      const built = yield* Effect.promise(() =>
        Bun.build({
          entrypoints: [`${root}desktop/src/bun/index.ts`],
          target: "bun",
          // Desktop's own dependencies, which the root suite does not install.
          external: [
            "electrobun",
            "electrobun/*",
            "@anthropic-ai/claude-agent-sdk",
            "@modelcontextprotocol/sdk/*",
          ],
          plugins: [
            {
              name: "host-client",
              setup(build) {
                build.onLoad({ filter: /\/src\/(host|lock)\.ts$/ }, (args) => {
                  reached.push(args.path);
                  return undefined;
                });
              },
            },
          ],
        }),
      );
      expect(built.logs.filter((log) => log.level === "error")).toEqual([]);
      expect(reached).toEqual([]);
    }),
  ));

const snapshot = (installation: string): BoardSnapshot => ({
  _tag: "Snapshot",
  installation,
  build: "0.31.0",
  protocol: 1,
  herds: [],
  tasks: [],
  seq: 0,
});
interface Fake {
  readonly name: string;
  readonly board: () => Stream.Stream<BoardMessage, { readonly message: string }>;
}
const fakeRoute = (
  name: string,
  board: Stream.Stream<BoardMessage>,
  closed: string[] = [],
): Route<Fake> => ({
  machine: { profile: `p-${name}`, name, target: `mk@${name}` },
  open: () =>
    Effect.acquireRelease(Effect.succeed<Fake>({ name, board: () => board }), () =>
      Effect.sync(() => closed.push(name)),
    ),
  collie: () => Effect.die("not asked"),
});
const toldOf = (item: FlockItem) =>
  `${item.machine.name} ${"_tag" in item ? item._tag : item.message._tag}`;
const until = (what: () => boolean) =>
  Effect.suspend(() => (what() ? Effect.void : Effect.fail("not yet"))).pipe(
    Effect.retry(Schedule.spaced("5 millis")),
  );

test("a Machine reached by two routes is shown through the first, and the other's bridge closes at once", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const closed: string[] = [];
      const preferredAnswers = yield* Deferred.make<void>();
      const after = (go: Deferred.Deferred<void>, message: BoardMessage) =>
        Stream.fromEffect(Deferred.await(go).pipe(Effect.as(message)));
      const told: string[] = [];
      const doors = new Map<string, Fake>();
      yield* flockStream(
        [
          fakeRoute(
            "preferred",
            after(preferredAnswers, snapshot("vm")).pipe(Stream.concat(Stream.never)),
            closed,
          ),
          fakeRoute("other", Stream.make(snapshot("vm")).pipe(Stream.concat(Stream.never)), closed),
        ],
        doors,
        "0.31.0",
      ).pipe(
        Stream.runForEach((item) => Effect.sync(() => told.push(toldOf(item)))),
        Effect.forkScoped,
      );

      yield* until(() => told.length === 1);
      yield* Deferred.succeed(preferredAnswers, undefined);
      yield* until(() => told.length === 2 && closed.includes("other"));
      expect(told).toEqual(["other Snapshot", "preferred Snapshot"]);
      expect(closed).toEqual(["other"]);
      // Actions on the Machine go through the route it is shown through.
      expect(doors.get("vm")?.name).toBe("preferred");
    }).pipe(Effect.scoped),
  ));

test("a route that comes up to a Machine already shown merges into it and closes", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const closed: string[] = [];
      const told: string[] = [];
      const doors = new Map<string, Fake>();
      const shown = yield* Deferred.make<void>();
      const later = Stream.fromEffect(Deferred.await(shown).pipe(Effect.as(snapshot("vm"))));
      yield* flockStream(
        [
          fakeRoute("vm", Stream.make(snapshot("vm")).pipe(Stream.concat(Stream.never)), closed),
          fakeRoute("installed", later.pipe(Stream.concat(Stream.never)), closed),
        ],
        doors,
        "0.31.0",
      ).pipe(
        Stream.runForEach((item) => Effect.sync(() => told.push(toldOf(item)))),
        Effect.forkScoped,
      );
      yield* until(() => told.length === 1);
      yield* Deferred.succeed(shown, undefined);
      yield* until(() => told.length === 2 && closed.includes("installed"));
      expect(told).toEqual(["vm Snapshot", "installed Merged"]);
      expect(doors.get("vm")?.name).toBe("vm");
    }).pipe(Effect.scoped),
  ));

test("a route that cannot be opened says why and tries again by itself", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      let tries = 0;
      const told: FlockItem[] = [];
      const flaky: Route<Fake> = {
        machine: { profile: "p-vm", name: "vm", target: "mk@vm" },
        collie: () => Effect.die("not asked"),
        open: () =>
          Effect.suspend(() =>
            tries++ === 0
              ? Effect.fail({ state: "unreachable" as const, reason: "ssh: connection refused" })
              : Effect.succeed<Fake>({
                  name: "vm",
                  board: () => Stream.make(snapshot("vm")).pipe(Stream.concat(Stream.never)),
                }),
          ),
      };
      yield* flockStream([flaky], new Map(), "0.31.0").pipe(
        Stream.runForEach((item) => Effect.sync(() => told.push(item))),
        Effect.forkScoped,
      );
      yield* until(() => told.length === 2);
      expect(told.map(toldOf)).toEqual(["vm Lost", "vm Snapshot"]);
      expect(told[0]).toMatchObject({ state: "unreachable", reason: "ssh: connection refused" });
    }).pipe(Effect.scoped, fastForward),
  ));

test("a bridge whose shell finds no collie is a Machine without Collie, in the shell's words", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const failed = yield* openBridge([
        "/bin/sh",
        "-c",
        "echo 'sh: 1: exec: collie: not found' >&2; exit 127",
      ]).pipe(Effect.flip);
      expect(failed).toEqual({ state: "no-collie", reason: "sh: 1: exec: collie: not found" });
      const other = yield* openBridge([
        "/bin/sh",
        "-c",
        "echo 'Permission denied' >&2; exit 1",
      ]).pipe(Effect.flip);
      expect(other).toEqual({ state: "unreachable", reason: "Permission denied" });
    }).pipe(Effect.scoped),
  ));

test("a Machine's build asks for an upgrade only where it is an older release, and for a newer Desktop only outside the window", () => {
  const at = (over: Partial<BoardSnapshot>) => ({ ...snapshot("vm"), ...over });
  expect(buildVerdict(at({ build: "0.30.2" }), "0.31.0")).toBe("upgrade");
  expect(buildVerdict(at({ build: "0.31.0" }), "0.31.0")).toBe("as-is");
  expect(buildVerdict(at({ build: "0.32.0" }), "0.31.0")).toBe("as-is");
  expect(buildVerdict(at({ build: "0.30.2", development: "0.30.2+abc1234" }), "0.31.0")).toBe(
    "as-is",
  );
  expect(buildVerdict(at({ build: "0.32.0", protocol: PROTOCOL + 1 }), "0.31.0")).toBe("as-is");
  expect(buildVerdict(at({ build: "0.40.0", protocol: PROTOCOL + 2 }), "0.31.0")).toBe(
    "update-desktop",
  );
});

const toldWithNotices = (item: FlockItem) =>
  "_tag" in item && item._tag === "Notice"
    ? item.text
    : "_tag" in item
      ? toldOf(item)
      : `${item.message._tag}${item.message._tag === "Snapshot" ? ` ${item.message.build}` : ""}`;

test("an older release is upgraded once through its route while its board stays live, then opened again on its new build without being shown lost", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      let build = "0.30.2";
      const asked: string[][] = [];
      const told: string[] = [];
      const upgradeMayFinish = yield* Deferred.make<void>();
      const old: Route<Fake> = {
        machine: { profile: "p-vm", name: "vm", target: "mk@vm" },
        open: () =>
          Effect.sync(() => ({
            name: "vm",
            board: () =>
              Stream.fromIterable<BoardMessage>([
                { ...snapshot("vm"), build },
                { _tag: "Remove", seq: 1, id: "t-gone" },
              ]).pipe(Stream.concat(Stream.never)),
          })),
        collie: (args) =>
          Deferred.await(upgradeMayFinish).pipe(
            Effect.andThen(
              Effect.sync(() => {
                asked.push([...args]);
                build = args.at(-1)!;
                return { out: "", err: "", code: 0 };
              }),
            ),
          ),
      };
      yield* flockStream([old], new Map(), "0.31.0").pipe(
        Stream.runForEach((item) => Effect.sync(() => told.push(toldWithNotices(item)))),
        Effect.forkScoped,
      );
      // A change on the board reaches it while the upgrade is still running.
      yield* until(() => told.length === 2);
      yield* Deferred.succeed(upgradeMayFinish, undefined);
      yield* until(() => told.length >= 4);
      expect(told.slice(0, 4)).toEqual([
        "Snapshot 0.30.2",
        "Remove",
        "vm upgraded 0.30.2 → 0.31.0",
        "Snapshot 0.31.0",
      ]);
      expect(asked).toEqual([["--json", "upgrade", "--to", "0.31.0"]]);
    }).pipe(Effect.scoped),
  ));

test("a board a newer collie serves that this Desktop cannot read asks for a newer Desktop, and is not tried again", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      let opened = 0;
      const told: FlockItem[] = [];
      const newer: Route<Fake> = {
        machine: { profile: "p-vm", name: "vm", target: "mk@vm" },
        open: () =>
          Effect.sync(() => {
            opened++;
            return {
              name: "vm",
              board: () => Stream.fail({ message: "could not decode Snapshot" }),
            };
          }),
        collie: () => Effect.succeed({ out: "collie v0.40.0\n", err: "", code: 0 }),
      };
      yield* flockStream([newer], new Map(), "0.31.0").pipe(
        Stream.runForEach((item) => Effect.sync(() => told.push(item))),
        Effect.forkScoped,
      );
      yield* until(() => told.length === 1);
      expect(told[0]).toMatchObject({
        _tag: "Lost",
        state: "update-desktop",
        reason: "vm runs collie 0.40.0, whose board this Desktop (0.31.0) cannot read.",
      });
      yield* Effect.sleep("1500 millis");
      expect(opened).toBe(1);
    }).pipe(Effect.scoped, fastForward),
  ));

test("a Machine that cannot be upgraded says why in its own words, and is shown as it is", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const told: string[] = [];
      const stuck: Route<Fake> = {
        machine: { profile: "p-vm", name: "vm", target: "mk@vm" },
        open: () =>
          Effect.succeed({
            name: "vm",
            board: () =>
              Stream.make({ ...snapshot("vm"), build: "0.30.2" }).pipe(Stream.concat(Stream.never)),
          }),
        collie: () =>
          Effect.succeed({
            out: JSON.stringify({ ok: false, error: { message: "There is no release 0.31.0." } }),
            err: "",
            code: 1,
          }),
      };
      yield* flockStream([stuck], new Map(), "0.31.0").pipe(
        Stream.runForEach((item) => Effect.sync(() => told.push(toldWithNotices(item)))),
        Effect.forkScoped,
      );
      yield* until(() => told.length === 2);
      expect(told).toEqual([
        "Snapshot 0.30.2",
        "Could not upgrade vm to 0.31.0: There is no release 0.31.0.",
      ]);
    }).pipe(Effect.scoped),
  ));

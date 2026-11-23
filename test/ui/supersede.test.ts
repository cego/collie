import * as Cause from "effect/Cause";

// WARNING: a newer focus interrupts the read in flight, and a slow command never stalls the next keypress.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { Deferred, Effect, FileSystem, Queue, Stream } from "effect";
import { Rig } from "../support/recorder";
import { runEffect } from "../support/effect";
import { driveBridge } from "../../src/ui/bridge";
import type { Focus } from "../../src/ui/bridge";
import type { AppState, Command } from "../../src/ui/state";
import { epochMs } from "../../src/time";

let rig: Rig;

beforeEach(() =>
  runEffect(
    Effect.gen(function* () {
      rig = yield* Rig.make();
    }),
  ),
);

afterEach(() => runEffect(rig.close()));

// WARNING: newer rather than note, since a load keeps the note the last command left in the footer.
function stateFor(selected: string | null) {
  const returned: AppState = {
    view: "runs",
    filter: { kind: "workspace", id: "w1" },
    tasks: [],
    now: epochMs("2026-09-16T12:00:00.000Z"),
    density: "comfortable",
    newer: selected ?? "none",
    note: null,
    history: null,
    definitions: null,
    settings: null,
    detail: null,
    live: null,
    previewing: null,
    stopping: [],
  };
  return returned;
}

const until = Effect.fn("supersede.until")(function* (what: string, ready: () => boolean) {
  for (let tries = 0; tries < 200; tries++) {
    if (ready()) return;
    yield* Effect.sleep("5 millis");
  }
  return yield* new Cause.TimeoutError(`${what} never happened`);
});

test("a newer focus interrupts the read in flight, and the newer one lands", () =>
  runEffect(
    Effect.scoped(
      Effect.gen(function* () {
        const started: Array<string> = [];
        const interrupted: Array<string> = [];
        const held = yield* Deferred.make<void>();

        const driven = yield* driveBridge({
          filter: { kind: "workspace", id: "w1" } as const,
          origin: "w1",
          stateDir: rig.stateDir,
          load: (focus: Focus) =>
            Effect.gen(function* () {
              const which = focus.selected ?? "none";
              started.push(which);
              if (which === "run:a") yield* Deferred.await(held);
              return stateFor(focus.selected);
            }).pipe(
              Effect.onInterrupt(() =>
                Effect.sync(() => {
                  interrupted.push(focus.selected ?? "none");
                }),
              ),
            ),
          act: () => Effect.succeed(null),
        });

        driven.dispatch({ _tag: "Select", id: "run:a", on: null });
        yield* until("the first read to start", () => started.includes("run:a"));

        driven.dispatch({ _tag: "Select", id: "run:b", on: null });
        yield* until("the second read to land", () => driven.state().newer === "run:b");

        expect(interrupted).toContain("run:a");
        expect(driven.state().newer).toBe("run:b");
      }),
    ),
  ));

test("writes during a refresh let it finish and request one fresh read afterwards", () =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const events = yield* Queue.unbounded<FileSystem.WatchEvent>();
      const held = yield* Deferred.make<void>();
      let reads = 0;
      let seen = 0;
      let interrupted = false;
      const driven = yield* driveBridge({
        filter: { kind: "all" },
        origin: null,
        stateDir: rig.stateDir,
        load: () =>
          Effect.gen(function* () {
            const reading = ++reads;
            if (reading === 2)
              yield* Deferred.await(held).pipe(
                Effect.onInterrupt(() =>
                  Effect.sync(() => {
                    interrupted = true;
                  }),
                ),
              );
            return stateFor(String(reading));
          }),
        act: () => Effect.succeed(null),
      }).pipe(
        Effect.provideService(FileSystem.FileSystem, {
          ...fs,
          watch: () =>
            Stream.fromQueue(events).pipe(
              Stream.tap(() =>
                Effect.sync(() => {
                  seen++;
                }),
              ),
            ),
        }),
      );
      yield* until("the refresh to start", () => reads === 2);
      for (let i = 0; i < 20; i++) {
        yield* Queue.offer(events, { _tag: "Update", path: "runs/one/output.json" });
        yield* until("the write to be consumed", () => seen === i + 1);
      }
      expect(interrupted).toBe(false);
      expect(reads).toBe(2);
      yield* Deferred.succeed(held, undefined);
      yield* until("the pending refresh to finish", () => driven.state().newer === "3");
      expect(reads).toBe(3);
    }),
  ));

test("host board changes publish without a file write and coalesce behind the current read", () =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const changes = yield* Queue.unbounded<void>();
      const held = yield* Deferred.make<void>();
      let latest = "initial";
      let reads = 0;
      let seen = 0;
      let interrupted = false;
      const driven = yield* driveBridge({
        filter: { kind: "all" },
        origin: null,
        stateDir: rig.stateDir,
        changes: Stream.fromQueue(changes).pipe(
          Stream.tap(() =>
            Effect.sync(() => {
              seen++;
            }),
          ),
        ),
        load: () =>
          Effect.gen(function* () {
            const reading = ++reads;
            const value = latest;
            if (reading === 3)
              yield* Deferred.await(held).pipe(
                Effect.onInterrupt(() =>
                  Effect.sync(() => {
                    interrupted = true;
                  }),
                ),
              );
            return stateFor(value);
          }),
        act: () => Effect.succeed(null),
      }).pipe(Effect.provideService(FileSystem.FileSystem, { ...fs, watch: () => Stream.never }));
      yield* until(
        "the initial board to land",
        () => reads === 2 && driven.state().newer === "initial",
      );

      latest = "host update";
      yield* Queue.offer(changes, undefined);
      yield* until("the host update to start a read", () => reads === 3);
      latest = "newest host update";
      for (let i = 0; i < 20; i++) {
        yield* Queue.offer(changes, undefined);
        yield* until("the host event to be consumed", () => seen === i + 2);
      }
      expect(reads).toBe(3);
      expect(interrupted).toBe(false);
      yield* Deferred.succeed(held, undefined);
      yield* until(
        "the latest host state to land",
        () => driven.state().newer === "newest host update",
      );
      expect(reads).toBe(4);
    }),
  ));

test("host logs do not refresh the board, but Run writes still do", () =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const events = yield* Queue.unbounded<FileSystem.WatchEvent>();
      let reads = 0;
      let seen = 0;
      const driven = yield* driveBridge({
        filter: { kind: "all" },
        origin: null,
        stateDir: rig.stateDir,
        load: () => Effect.sync(() => stateFor(String(++reads))),
        act: () => Effect.succeed(null),
      }).pipe(
        Effect.provideService(FileSystem.FileSystem, {
          ...fs,
          watch: () =>
            Stream.fromQueue(events).pipe(
              Stream.tap(() =>
                Effect.sync(() => {
                  seen++;
                }),
              ),
            ),
        }),
      );
      yield* until("the first refresh to finish", () => reads >= 2);
      yield* Effect.sleep("20 millis");
      const before = reads;
      for (const path of ["host.log", "host.out", "host.log.1"]) {
        yield* Queue.offer(events, { _tag: "Update", path });
      }
      yield* until("the events to be read", () => seen === 3);
      yield* Effect.sleep("20 millis");
      expect(reads).toBe(before);
      yield* Queue.offer(events, { _tag: "Update", path: "runs/one/output.json" });
      yield* until("the Run write to be shown", () => driven.state().newer === String(before + 1));
    }),
  ));

test("a usage audit written by a read does not trigger another read", () =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const events = yield* Queue.unbounded<FileSystem.WatchEvent>();
      let reads = 0;
      let auditsSeen = 0;
      const driven = yield* driveBridge({
        filter: { kind: "all" },
        origin: null,
        stateDir: rig.stateDir,
        load: () =>
          Effect.gen(function* () {
            const reading = ++reads;
            // WARNING: a board refresh asks the host for usage, which appends its audit; bound the loop so a broken build cannot run forever.
            if (reading > 1 && reading <= 4)
              yield* Queue.offer(events, { _tag: "Update", path: "usage/operations.jsonl" });
            return stateFor(String(reading));
          }),
        act: () => Effect.succeed(null),
      }).pipe(
        Effect.provideService(FileSystem.FileSystem, {
          ...fs,
          watch: () =>
            Stream.fromQueue(events).pipe(
              Stream.tap((event) =>
                Effect.sync(() => {
                  if (event.path === "usage/operations.jsonl") auditsSeen++;
                }),
              ),
            ),
        }),
      );
      yield* until("the first audit to be watched", () => auditsSeen >= 1);
      yield* Effect.sleep("50 millis");
      expect(reads).toBe(2);
      expect(driven.state().newer).toBe("2");

      yield* Queue.offer(events, { _tag: "Update", path: "runs/one/output.json" });
      yield* until("the Run change to refresh the board", () => driven.state().newer === "3");
      yield* until("the next audit to be watched", () => auditsSeen >= 2);
      yield* Effect.sleep("50 millis");
      expect(reads).toBe(3);
    }),
  ));

test("one watcher follows focus changes and closes with the bridge", () =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      let opened = 0;
      let closed = 0;
      yield* Effect.scoped(
        Effect.gen(function* () {
          const driven = yield* driveBridge({
            filter: { kind: "all" },
            origin: null,
            stateDir: rig.stateDir,
            load: (focus) => Effect.succeed(stateFor(focus.selected)),
            act: () => Effect.succeed(null),
          }).pipe(
            Effect.provideService(FileSystem.FileSystem, {
              ...fs,
              watch: () =>
                Stream.unwrap(
                  Effect.acquireRelease(
                    Effect.sync(() => {
                      opened++;
                      return Stream.never;
                    }),
                    () =>
                      Effect.sync(() => {
                        closed++;
                      }),
                  ),
                ),
            }),
          );
          yield* until("the watcher to open", () => opened > 0);
          for (let i = 0; i < 10; i++) {
            driven.dispatch({ _tag: "Select", id: `run:${i}`, on: null });
            yield* until("the new focus", () => driven.state().newer === `run:${i}`);
          }
          expect(opened).toBe(1);
          expect(closed).toBe(0);
        }),
      );
      expect(closed).toBe(1);
    }),
  ));

test("a command that takes its time does not stall the next keypress", () =>
  runEffect(
    Effect.scoped(
      Effect.gen(function* () {
        const acted: Array<Command> = [];
        const slow = yield* Deferred.make<void>();

        const driven = yield* driveBridge({
          filter: { kind: "workspace", id: "w1" } as const,
          origin: "w1",
          stateDir: rig.stateDir,
          load: (focus: Focus) => Effect.succeed(stateFor(focus.selected)),
          act: (command) =>
            Effect.gen(function* () {
              acted.push(command);
              yield* Deferred.await(slow);
              return "done";
            }),
        });

        driven.dispatch({ _tag: "OpenMr", target: "mr:host/g/p!1", runId: null });
        yield* until("the command to start", () => acted.length === 1);

        // WARNING: a focus change never joins the queue the slow command sits in.
        driven.dispatch({ _tag: "Select", id: "run:b", on: null });
        yield* until("the Selection to land", () => driven.state().newer === "run:b");

        expect(driven.state().newer).toBe("run:b");
        yield* Deferred.succeed(slow, undefined);
      }),
    ),
  ));

test("a Refresh asked for twice is read twice, because a repeat is the whole point", () =>
  runEffect(
    Effect.scoped(
      Effect.gen(function* () {
        const nonces: Array<number> = [];

        const driven = yield* driveBridge({
          filter: { kind: "workspace", id: "w1" } as const,
          origin: "w1",
          stateDir: rig.stateDir,
          load: (focus: Focus) =>
            Effect.sync(() => {
              nonces.push(focus.nonce);
              return stateFor(focus.selected);
            }),
          act: () => Effect.succeed(null),
        });

        driven.dispatch({ _tag: "Refresh" });
        yield* until("the first re-read", () => nonces.includes(1));
        driven.dispatch({ _tag: "Refresh" });
        yield* until("the second re-read", () => nonces.includes(2));

        // WARNING: without the nonce, changes would drop a repeated focus and pressing the key again would do nothing.
        expect(nonces).toContain(1);
        expect(nonces).toContain(2);
      }),
    ),
  ));

test("a command that fails leaves its reason in the footer", () =>
  runEffect(
    Effect.scoped(
      Effect.gen(function* () {
        const driven = yield* driveBridge({
          filter: { kind: "workspace", id: "w1" } as const,
          origin: "w1",
          stateDir: rig.stateDir,
          load: (focus: Focus) => Effect.succeed(stateFor(focus.selected)),
          act: () =>
            Effect.fail(
              new Cause.UnknownError(undefined, "glab could not reach gitlab.example.com"),
            ),
        });

        driven.dispatch({ _tag: "OpenMr", target: "mr:host/g/p!1", runId: null });
        yield* until("the failure to reach the footer", () => driven.state().note !== null);

        expect(driven.state().note).toContain("glab could not reach");

        driven.dispatch({ _tag: "Refresh" });
        yield* Effect.sleep("30 millis");
        expect(driven.state().note).toContain("glab could not reach");
      }),
    ),
  ));

test("a load's own note is shown, and taken back when the load stops saying it", () =>
  runEffect(
    Effect.scoped(
      Effect.gen(function* () {
        let hostSays: string | null = "the workflow host has not sent its board";
        const driven = yield* driveBridge({
          filter: { kind: "workspace", id: "w1" } as const,
          origin: "w1",
          stateDir: rig.stateDir,
          load: (focus: Focus) =>
            Effect.sync(() => ({ ...stateFor(focus.selected), note: hostSays })),
          act: () => Effect.succeed("opened"),
        });
        const refreshed = (note: string | null) =>
          Effect.gen(function* () {
            driven.dispatch({ _tag: "Refresh" });
            yield* until(`the note to be ${note}`, () => driven.state().note === note);
          });

        expect(driven.state().note).toBe("the workflow host has not sent its board");
        hostSays = null;
        yield* refreshed(null);
        hostSays = "reconnecting to the workflow host; these cards may be out of date";
        yield* refreshed(hostSays);
        hostSays = null;
        yield* refreshed(null);

        // WARNING: a command's note is the command's; a load with nothing to say leaves it.
        driven.dispatch({ _tag: "OpenMr", target: "mr:host/g/p!1", runId: null });
        yield* until("the command's note", () => driven.state().note === "opened");
        driven.dispatch({ _tag: "Refresh" });
        yield* Effect.sleep("30 millis");
        expect(driven.state().note).toBe("opened");
      }),
    ),
  ));

test("the board opens on the scope from config, and g is what changes it after", () =>
  runEffect(
    Effect.scoped(
      Effect.gen(function* () {
        const scopes: Array<string> = [];

        const driven = yield* driveBridge({
          filter: { kind: "all" } as const,
          origin: "w1",
          stateDir: rig.stateDir,
          load: (focus: Focus) =>
            Effect.sync(() => {
              scopes.push(focus.filter.kind);
              return { ...stateFor(focus.selected), filter: focus.filter };
            }),
          act: () => Effect.succeed(null),
        });

        expect(scopes[0]).toBe("all");

        // WARNING: wait on the state, not on the load call; the stream writes state a moment after the scope push.
        driven.dispatch({ _tag: "ToggleFilter" });
        yield* until("the narrowed board", () => driven.state().filter.kind === "workspace");
        expect(scopes).toContain("workspace");
      }),
    ),
  ));

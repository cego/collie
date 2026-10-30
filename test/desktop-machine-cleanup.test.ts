// What a sweep would remove on each Machine, read by Desktop's main process and drawn by the
// Cleanup dialog (ADR-0045).

import * as Arr from "effect/Array";
import { describe, expect, test } from "bun:test";
import { Deferred, Effect, Fiber } from "effect";
import * as Rpc from "effect/rpc/Rpc";
import * as RpcClient from "effect/rpc/RpcClient";
import { RpcClientDefect, RpcClientError } from "effect/rpc/RpcClientError";
import * as RpcGroup from "effect/rpc/RpcGroup";
import type * as RpcMessage from "effect/rpc/RpcMessage";
import * as RpcServer from "effect/rpc/RpcServer";
import { TestClock } from "effect/testing";
import { cleanupOn, type Door, DoorMap, type Reached } from "../desktop/src/bun/machine";
import {
  CLEANUP_UPGRADE_SAID,
  type CleanupRead,
  choose,
  cleanupView,
  sweptToast,
} from "../desktop/src/shared/machine-cleanup";
import { cleanupLines } from "../src/cleanup";
import { type CleanupReport, FrontDoorRpcs, HostRefused } from "../src/board-model";

type Rpcs = RpcGroup.Rpcs<typeof FrontDoorRpcs>;

const report = (bytes: number): CleanupReport => ({
  remove: [{ kind: "worktree", target: "/w/run-1", bytes, reason: "its Run ended" }],
  keep: [],
  bytes,
});

/** The `cleanup` call alone, as a host serves it; an older host serves neither it nor `sweep`. */
const Cleanup = RpcGroup.make(
  // SAFETY: the group's own `cleanup`, which its map types as any of its Rpcs.
  FrontDoorRpcs.requests.get("cleanup") as Extract<Rpcs, { readonly _tag: "cleanup" }>,
);
const Older = RpcGroup.make(Rpc.make("ping"));

/** A host answering `cleanup` with `answer`, or too old for it; every request it is sent is kept. */
const fakeHost = (answer: Effect.Effect<CleanupReport, HostRefused> | "older") =>
  Effect.gen(function* () {
    const asked: Array<string> = [];
    let toClient: (response: RpcMessage.FromServer<Rpcs>) => Effect.Effect<void> = () =>
      Effect.void;
    const server =
      answer === "older"
        ? yield* RpcServer.makeNoSerialization(Older, {
            // SAFETY: what a host answers is the same envelope whichever group it serves.
            onFromServer: (response) => toClient(response as RpcMessage.FromServer<Rpcs>),
          }).pipe(Effect.provide(Older.toLayer({ ping: () => Effect.void })))
        : yield* RpcServer.makeNoSerialization(Cleanup, {
            onFromServer: (response) => toClient(response),
          }).pipe(Effect.provide(Cleanup.toLayer({ cleanup: () => answer })));
    const client = yield* RpcClient.makeNoSerialization(FrontDoorRpcs, {
      supportsAck: true,
      onFromClient: ({ message }) => {
        if (message._tag === "Request") asked.push(message.tag);
        // SAFETY: the host is handed a request it may have no schema for, as over the wire.
        return server.write(0, message as never);
      },
    });
    toClient = client.write;
    return { door: reachedOver(client.client), asked };
  });

const vm = { profile: "p-vm", name: "vm" };
const reachedOver = (desktop: Partial<Door>): Reached => ({
  machine: vm,
  // SAFETY: each test calls only what its door answers.
  desktop: desktop as Door,
});
/** A door whose call is cut off once `closed` is done: interrupted as a closing door is, or broken. */
const cutOff = (closed: Deferred.Deferred<void>, how: "closed" | "broken") =>
  reachedOver({
    // SAFETY: answered as the client answers a call not asked to discard its reply.
    cleanup: (() =>
      Deferred.await(closed).pipe(
        Effect.andThen(
          how === "closed"
            ? Effect.interrupt
            : Effect.fail(
                new RpcClientError({
                  reason: new RpcClientDefect({ message: "socket closed", cause: null }),
                }),
              ),
        ),
      )) as Door["cleanup"],
  });
const doorsWith = (door: Reached) => {
  const doors = new DoorMap<Reached>();
  doors.set("i-vm", door);
  return doors;
};

describe("the main process reads one Machine's cleanup listing over its door", () => {
  test("a host that answers gives its report, and is asked only for its listing", () =>
    Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const host = yield* fakeHost(Effect.succeed(report(2048)));
          expect(yield* cleanupOn(doorsWith(host.door), "p-vm")).toEqual({
            installation: "i-vm",
            report: report(2048),
          });
          expect(host.asked).toEqual(["cleanup"]);
        }),
      ),
    ));

  test("a host that refuses gives its reason", () =>
    Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const host = yield* fakeHost(
            Effect.fail(new HostRefused({ reason: "the disk is gone" })),
          );
          const failed = yield* Effect.flip(cleanupOn(doorsWith(host.door), "p-vm"));
          expect(failed.reason).toBe("the disk is gone");
        }),
      ),
    ));

  test("a host that answers at 40 s gives its report", () =>
    Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const host = yield* fakeHost(Effect.sleep("40 seconds").pipe(Effect.as(report(4096))));
          const reading = yield* cleanupOn(doorsWith(host.door), "p-vm").pipe(Effect.forkChild);
          yield* TestClock.adjust("40 seconds");
          expect(yield* Fiber.join(reading)).toEqual({
            installation: "i-vm",
            report: report(4096),
          });
        }),
      ).pipe(Effect.provide(TestClock.layer())),
    ));

  for (const how of ["closed", "broken"] as const)
    test(`a door ${how} under the call is followed to the Machine's next door, whose host answers`, () =>
      Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const closed = yield* Deferred.make<void>();
            const doors = doorsWith(cutOff(closed, how));
            const next = yield* fakeHost(Effect.succeed(report(77)));
            const reading = yield* cleanupOn(doors, "p-vm").pipe(Effect.forkChild);
            yield* Effect.yieldNow;
            doors.delete("i-vm");
            yield* Deferred.succeed(closed, undefined);
            yield* Effect.yieldNow;
            expect(next.asked).toEqual([]);
            doors.set("i-vm", next.door);
            expect(yield* Fiber.join(reading)).toEqual({
              installation: "i-vm",
              report: report(77),
            });
            expect(next.asked).toEqual(["cleanup"]);
          }),
        ),
      ));

  test("a host that never answers is waited on for 2 minutes, then said so", () =>
    Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const host = yield* fakeHost(Effect.never);
          const reading = yield* cleanupOn(doorsWith(host.door), "p-vm").pipe(Effect.forkChild);
          yield* TestClock.adjust("119 seconds");
          expect(reading.pollUnsafe()).toBeUndefined();
          yield* TestClock.adjust("1 second");
          const failed = yield* Effect.flip(Fiber.join(reading));
          expect(failed.reason).toBe("its host did not answer within 2 minutes");
        }),
      ).pipe(Effect.provide(TestClock.layer())),
    ));

  test("a door that closes and gets no successor says its connection did not come back", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const closed = yield* Deferred.make<void>();
        const doors = doorsWith(cutOff(closed, "closed"));
        const reading = yield* cleanupOn(doors, "p-vm").pipe(Effect.forkChild);
        yield* Effect.yieldNow;
        doors.delete("i-vm");
        yield* Deferred.succeed(closed, undefined);
        yield* TestClock.adjust("2 minutes");
        const failed = yield* Effect.flip(Fiber.join(reading));
        expect(failed.reason).toBe("its connection did not come back within 2 minutes");
      }).pipe(Effect.provide(TestClock.layer())),
    ));

  test("a Machine with no door when asked is said not to be connected, at once", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const doors = doorsWith(reachedOver({}));
        const failed = yield* Effect.flip(cleanupOn(doors, "p-elsewhere"));
        expect(failed.reason).toBe("That Machine isn't connected.");
      }),
    ));

  test("a host without the call asks for an upgrade", () =>
    Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const host = yield* fakeHost("older");
          const failed = yield* Effect.flip(cleanupOn(doorsWith(host.door), "p-vm"));
          expect(failed.reason).toBe(CLEANUP_UPGRADE_SAID);
          expect(CLEANUP_UPGRADE_SAID).toBe(
            "Can't list what it would clean up; upgrade this Machine.",
          );
        }),
      ),
    ));
});

type Shown = Parameters<typeof cleanupView>[0][number];
const live = (name: string): Shown => ({ profile: `p-${name}`, name, state: "live", reason: null });
type Read = readonly [string, CleanupRead];
const listed = (name: string, report: CleanupReport): Read => [
  `p-${name}`,
  { state: "listed", installation: `i-${name}`, report },
];
const failed = (name: string, problem: string): Read => [`p-${name}`, { state: "failed", problem }];
const reading = (name: string, since: number): Read => [`p-${name}`, { state: "reading", since }];
const reads = (...each: ReadonlyArray<Read>) => new Map(each);
const item = (kind: string, target: string, bytes: number) => ({
  kind,
  target,
  bytes,
  reason: `${target} is done`,
});
const GiB = 1024 ** 3;

describe("the Cleanup dialog", () => {
  test("a Machine's removals are grouped by kind, largest first, each with its count and size", () => {
    const remove = [
      item("generation", "/g/1", 1024),
      item("worktree", "/w/a", GiB),
      item("generation", "/g/2", 3 * 1024),
      item("worktree", "/w/b", 2 * GiB),
      item("staged-blob", "/s/x", 5),
    ];
    const bytes = Arr.reduce(remove, 0, (sum, { bytes }) => sum + bytes);
    const [row] = cleanupView(
      [live("vm")],
      reads(listed("vm", { remove, keep: [], bytes })),
      null,
    ).rows;
    expect(row!.said).toBe("Would free 3.0 GiB");
    expect(row!.groups).toEqual([
      {
        kind: "worktree",
        count: 2,
        size: "3.0 GiB",
        items: [
          { target: "/w/b", size: "2.0 GiB", reason: "/w/b is done" },
          { target: "/w/a", size: "1.0 GiB", reason: "/w/a is done" },
        ],
      },
      {
        kind: "generation",
        count: 2,
        size: "4.0 KiB",
        items: [
          { target: "/g/2", size: "3.0 KiB", reason: "/g/2 is done" },
          { target: "/g/1", size: "1.0 KiB", reason: "/g/1 is done" },
        ],
      },
      {
        kind: "staged-blob",
        count: 1,
        size: "5 B",
        items: [{ target: "/s/x", size: "5 B", reason: "/s/x is done" }],
      },
    ]);
    expect(row!.kept).toBeNull();
  });

  test("its sizes read as `collie cleanup` prints them", () => {
    const remove = [item("worktree", "/w/a", 1_288_490_189)];
    const report = { remove, keep: [], bytes: 1_288_490_189 };
    const [row] = cleanupView([live("vm")], reads(listed("vm", report)), null).rows;
    expect(cleanupLines(report, false)).toBe(
      "would remove\tworktree\t/w/a\t1.2 GiB\t/w/a is done\nwould free\t1.2 GiB",
    );
    expect(row!.groups[0]!.items[0]!.size).toBe("1.2 GiB");
    expect(row!.said).toBe("Would free 1.2 GiB");
  });

  test("what Collie keeps opens to each kept item's kind, target and reason", () => {
    const keep = [
      { kind: "worktree", target: "/w/open", reason: "its Task is open" },
      { kind: "home", target: "/h", reason: "it is a Home" },
    ];
    const [row] = cleanupView(
      [live("vm")],
      reads(listed("vm", { remove: [item("worktree", "/w/a", 10)], keep, bytes: 10 })),
      null,
    ).rows;
    expect(row!.kept).toEqual({ said: "Kept 2", items: keep });
  });

  test("a Machine with nothing to remove says so and can still be chosen", () => {
    const view = cleanupView(
      [live("vm")],
      reads(listed("vm", { remove: [], keep: [], bytes: 0 })),
      null,
    );
    expect(view.rows[0]).toMatchObject({
      said: "Nothing to remove now",
      groups: [],
      choosable: true,
      chosen: true,
    });
  });

  test("a Machine Desktop doesn't reach says its state and reason, and can't be chosen", () => {
    const states = [
      ["connecting", "Connecting"],
      ["unreachable", "Out of reach"],
      ["sso", "Waiting for SSO"],
      ["no-collie", "Collie isn't installed"],
      ["update-desktop", "Update Desktop"],
    ] as const;
    const view = cleanupView(
      Arr.map(states, ([state]) => ({ profile: `p-${state}`, name: state, state, reason: "why" })),
      reads(),
      null,
    );
    expect(Arr.map(view.rows, ({ said, note, choosable }) => [said, note, choosable])).toEqual([
      ["Connecting: why", null, false],
      ["Out of reach: why", "Its host still cleans up there every ten minutes.", false],
      ["Waiting for SSO: why", "Its host still cleans up there every ten minutes.", false],
      ["Collie isn't installed: why", null, false],
      ["Update Desktop: why", null, false],
    ]);
    expect(view.chosen).toBe("0 Machines chosen · would free 0 B");
  });

  test("a live Machine being read says how long it has waited and can't be chosen, while one listed already can", () => {
    const view = cleanupView(
      [live("slow"), live("vm")],
      reads(reading("slow", 1_000), listed("vm", { remove: [], keep: [], bytes: 0 })),
      null,
      new Map(),
      24_500,
    );
    expect(
      Arr.map(view.rows, ({ said, choosable, chosen, readAgain }) => [
        said,
        choosable,
        chosen,
        readAgain,
      ]),
    ).toEqual([
      ["Reading… 23 s", false, false, false],
      ["Nothing to remove now", true, true, false],
    ]);
  });

  test("a Machine that isn't live shows its state and reason while its listing is out", () => {
    const view = cleanupView(
      [{ profile: "p-off", name: "off", state: "unreachable", reason: "down" }],
      reads(reading("off", 0)),
      null,
      new Map(),
      5_000,
    );
    expect(view.rows[0]).toMatchObject({
      said: "Out of reach: down",
      choosable: false,
      readAgain: false,
    });
  });

  test("a live Machine whose read failed says why and offers Read again", () => {
    const [row] = cleanupView([live("old")], reads(failed("old", CLEANUP_UPGRADE_SAID)), null).rows;
    expect(row).toMatchObject({
      said: CLEANUP_UPGRADE_SAID,
      choosable: false,
      warn: true,
      readAgain: true,
    });
  });

  test("a live Machine never asked says it wasn't connected when Cleanup read, and offers Read again", () => {
    const [row] = cleanupView([live("late")], reads(), null).rows;
    expect(row).toMatchObject({
      said: "It wasn't connected when Cleanup read.",
      choosable: false,
      readAgain: true,
    });
  });

  test("a listed Machine offers no Read again, and once any Machine is swept no row does", () => {
    const rows = [live("vm"), live("old"), live("late")];
    const read = reads(
      listed("vm", { remove: [], keep: [], bytes: 0 }),
      failed("old", "the disk is gone"),
    );
    expect(Arr.map(cleanupView(rows, read, null).rows, ({ readAgain }) => readAgain)).toEqual([
      false,
      true,
      true,
    ]);
    const swept = cleanupView(
      rows,
      read,
      null,
      new Map([["p-vm", { state: "running", request: "s-1" }]]),
    );
    expect(Arr.map(swept.rows, ({ readAgain }) => readAgain)).toEqual([false, false, false]);
  });

  test("a listing that arrives after the choice was changed starts unchosen, and with no change chosen", () => {
    const rows = [live("a"), live("late")];
    const nothing = { remove: [], keep: [], bytes: 0 };
    const before = cleanupView(rows, reads(listed("a", nothing), reading("late", 0)), null);
    const changed = choose(before, "all");
    const after = reads(listed("a", nothing), listed("late", nothing));
    expect(Arr.map(cleanupView(rows, after, changed).rows, ({ chosen }) => chosen)).toEqual([
      true,
      false,
    ]);
    expect(Arr.map(cleanupView(rows, after, null).rows, ({ chosen }) => chosen)).toEqual([
      true,
      true,
    ]);
  });

  test("every Machine that can be chosen starts chosen; All and None act on those", () => {
    const rows = Arr.map([live("a"), live("b"), live("old"), live("off")], (row, i) =>
      i === 3 ? { ...row, state: "unreachable" as const } : row,
    );
    const read = reads(
      listed("a", { remove: [item("worktree", "/w", GiB)], keep: [], bytes: GiB }),
      listed("b", { remove: [], keep: [], bytes: 0 }),
      failed("old", "the disk is gone"),
    );
    const atStart = cleanupView(rows, read, null);
    expect(Arr.map(atStart.rows, ({ chosen }) => chosen)).toEqual([true, true, false, false]);
    expect(atStart.chosen).toBe("2 Machines chosen · would free 1.0 GiB");
    const none = cleanupView(rows, read, choose(atStart, "none"));
    expect(Arr.map(none.rows, ({ chosen }) => chosen)).toEqual([false, false, false, false]);
    expect(none.chosen).toBe("0 Machines chosen · would free 0 B");
    const all = cleanupView(rows, read, choose(none, "all"));
    expect(Arr.map(all.rows, ({ chosen }) => chosen)).toEqual([true, true, false, false]);
  });

  test("the chosen line counts the chosen Machines and adds what they would free", () => {
    const rows = [live("a"), live("b")];
    const read = reads(
      listed("a", { remove: [item("worktree", "/w", 3 * GiB)], keep: [], bytes: 3 * GiB }),
      listed("b", { remove: [item("worktree", "/v", 1.1 * GiB)], keep: [], bytes: 1.1 * GiB }),
    );
    expect(cleanupView(rows, read, null).chosen).toBe("2 Machines chosen · would free 4.1 GiB");
    expect(cleanupView(rows, read, new Set(["p-b"])).chosen).toBe(
      "1 Machine chosen · would free 1.1 GiB",
    );
  });
});

describe("the Cleanup dialog while and after it sweeps", () => {
  const rows = [live("a"), live("b"), live("c")];
  const read = reads(
    listed("a", { remove: [item("worktree", "/w", 3 * GiB)], keep: [], bytes: 3 * GiB }),
    listed("b", { remove: [item("worktree", "/v", GiB)], keep: [], bytes: GiB }),
    listed("c", { remove: [item("generation", "/g", 1024)], keep: [], bytes: 1024 }),
  );
  const chosen = new Set(["p-a", "p-b"]);

  test("the button counts the chosen Machines and is disabled when none is", () => {
    expect(cleanupView(rows, read, null).button).toEqual({
      said: "Clean up 3 Machines",
      disabled: false,
    });
    expect(cleanupView(rows, read, new Set(["p-a"])).button).toEqual({
      said: "Clean up 1 Machine",
      disabled: false,
    });
    expect(cleanupView(rows, read, new Set()).button).toMatchObject({ disabled: true });
    expect(cleanupView(rows, reads(reading("a", 0)), new Set()).button).toMatchObject({
      disabled: true,
    });
  });

  test("a sweeping Machine says Cleaning…, the choice is fixed, and the button is disabled", () => {
    const view = cleanupView(
      rows,
      read,
      chosen,
      new Map([
        ["p-a", { state: "running", request: "s-a" }],
        ["p-b", { state: "running", request: "s-b" }],
      ]),
    );
    expect(
      Arr.map(view.rows, ({ said, chosen, choosable, warn }) => [said, chosen, choosable, warn]),
    ).toEqual([
      ["Cleaning…", true, false, false],
      ["Cleaning…", true, false, false],
      ["Would free 1.0 KiB", false, false, false],
    ]);
    expect(view.rows[2]!.groups).toHaveLength(1);
    expect(view.choosable).toEqual([]);
    expect(view.button).toEqual({ said: "Clean up 2 Machines", disabled: true });
  });

  test("a sweeping Machine that isn't live says it waits for it to reconnect, then Cleaning… again", () => {
    const sweeping = new Map([["p-vm-mk", { state: "running" as const, request: "s-1" }]]);
    const read = reads(listed("vm-mk", { remove: [], keep: [], bytes: 0 }));
    const [away] = cleanupView(
      [{ ...live("vm-mk"), state: "unreachable", reason: "down" }],
      read,
      null,
      sweeping,
    ).rows;
    expect([away!.said, away!.warn]).toEqual(["Cleaning… waiting for vm-mk to reconnect", false]);
    const [back] = cleanupView([live("vm-mk")], read, null, sweeping).rows;
    expect(back!.said).toBe("Cleaning…");
  });

  test("a done sweep says what it freed, its removals by kind, and what it kept and why", () => {
    const swept = {
      remove: [item("worktree", "/w/a", 2 * GiB), item("worktree", "/w/b", 1.2 * GiB)],
      keep: [{ kind: "worktree", target: "/w/open", reason: "its Task is open" }],
      bytes: 3.2 * GiB,
    };
    const view = cleanupView(
      rows,
      read,
      chosen,
      new Map([["p-a", { state: "done", report: swept }]]),
    );
    expect(view.rows[0]).toMatchObject({
      said: "Freed 3.2 GiB",
      warn: false,
      reason: null,
      tryAgain: false,
      groups: [{ kind: "worktree", count: 2, size: "3.2 GiB" }],
      kept: { said: "Kept 1", items: swept.keep },
    });
    expect(view.button.disabled).toBe(true);
  });

  test("a sweep that removed nothing says so", () => {
    const view = cleanupView(
      rows,
      read,
      chosen,
      new Map([["p-a", { state: "done", report: { remove: [], keep: [], bytes: 0 } }]]),
    );
    expect(view.rows[0]).toMatchObject({ said: "Nothing removed", groups: [], kept: null });
  });

  test("a failed sweep says Not cleaned with its reason, and offers Try again", () => {
    const view = cleanupView(
      rows,
      read,
      chosen,
      new Map([["p-b", { state: "failed", request: "s-b", reason: "the disk is gone" }]]),
    );
    expect(view.rows[1]).toMatchObject({
      said: "Not cleaned",
      reason: "the disk is gone",
      tryAgain: true,
      warn: true,
      groups: [],
    });
    expect(view.rows[0]).toMatchObject({ tryAgain: false, reason: null });
  });

  test("each sweep's end is told in a toast", () => {
    expect(
      sweptToast("vm-mk", { state: "done", report: { remove: [], keep: [], bytes: 3.2 * GiB } }),
    ).toEqual({ title: "Cleaned up vm-mk: freed 3.2 GiB", color: "success" });
    expect(
      sweptToast("vm-mk", { state: "failed", request: "s-1", reason: "the disk is gone" }),
    ).toEqual({ title: "vm-mk not cleaned: the disk is gone", color: "error" });
  });
});

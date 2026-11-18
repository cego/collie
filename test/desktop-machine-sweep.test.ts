import { describe, expect, test } from "bun:test";
import { Effect, Exit, Fiber, Scope } from "effect";
import * as RpcClient from "effect/rpc/RpcClient";
import { RpcClientDefect, RpcClientError } from "effect/rpc/RpcClientError";
import * as RpcGroup from "effect/rpc/RpcGroup";
import type * as RpcMessage from "effect/rpc/RpcMessage";
import * as RpcServer from "effect/rpc/RpcServer";
import { TestClock } from "effect/testing";
import { type Door, DoorMap, type Reached, sweepOn } from "../desktop/src/bun/machine";
import type { Attempted } from "../desktop/src/bun/sent";
import { ActionFailed } from "../desktop/src/shared/flock";
import { type CleanupReport, FrontDoorRpcs, HostRefused } from "../src/board-model";

type Rpcs = RpcGroup.Rpcs<typeof FrontDoorRpcs>;

const report = (bytes: number) => ({
  remove: [{ kind: "worktree", target: "/w/run-1", bytes, reason: "its Run ended" }],
  keep: [{ kind: "worktree", target: "/w/run-2", reason: "its Run is live" }],
  bytes,
});

const Sweep = RpcGroup.make(
  // WARNING: the group's own `sweep`, which its map types as any of its Rpcs.
  FrontDoorRpcs.requests.get("sweep") as Extract<Rpcs, { readonly _tag: "sweep" }>,
);

const fakeHost = (name: string, answer: Effect.Effect<CleanupReport, HostRefused>) =>
  Effect.gen(function* () {
    const swept: Array<string> = [];
    let toClient: (response: RpcMessage.FromServer<Rpcs>) => Effect.Effect<void> = () =>
      Effect.void;
    const server = yield* RpcServer.makeNoSerialization(Sweep, {
      onFromServer: (response) => toClient(response),
    }).pipe(
      Effect.provide(
        Sweep.toLayer({
          sweep: ({ request }) => Effect.suspend(() => (swept.push(request), answer)),
        }),
      ),
    );
    const client = yield* RpcClient.makeNoSerialization(FrontDoorRpcs, {
      supportsAck: true,
      onFromClient: ({ message }) => server.write(0, message),
    });
    toClient = client.write;
    // WARNING: a sweep calls only `sweep` over its door.
    const reached = { machine: { profile: `p-${name}`, name }, desktop: client.client } as Reached;
    return { reached, swept };
  });

const logged = () => {
  const lines: Attempted[] = [];
  return { lines, log: (line: Attempted) => Effect.sync(() => void lines.push(line)) };
};

const line = (request: string, ended: Attempted["ended"], reason?: string, attempt = 1) => {
  const sent: Attempted = {
    door: "board",
    machine: "vm-mk",
    request,
    kind: "cleanup",
    about: null,
    attempt,
    ended,
  };
  return reason === undefined ? sent : { ...sent, reason };
};

const doorsWith = (door: Reached) => {
  const doors = new DoorMap<Reached>();
  doors.set("i-vm", door);
  return doors;
};

const broken = new RpcClientError({
  reason: new RpcClientDefect({ message: "socket closed", cause: null }),
});
const brokenDoor: Reached = {
  machine: { profile: "p-vm-mk", name: "vm-mk" },
  // WARNING: a sweep calls only `sweep` over its door, answered as the client answers it.
  desktop: { sweep: (() => Effect.fail(broken)) as Door["sweep"] } as Door,
};

const TIMED_OUT =
  "vm-mk did not finish cleaning up within 10 minutes. It may still be sweeping; Try again asks for the same sweep.";

describe("the main process sweeps a chosen Machine", () => {
  test("a sweep that answers gives its report, with one accepted line", () =>
    Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const { lines, log } = logged();
          const host = yield* fakeHost("vm-mk", Effect.succeed(report(2048)));
          const doors = doorsWith(host.reached);
          const swept = yield* sweepOn(
            doors,
            { installation: "i-vm", machine: "vm-mk" },
            "s-1",
            log,
          );
          expect(swept).toEqual(report(2048));
          expect(host.swept).toEqual(["s-1"]);
          expect(lines).toEqual([line("s-1", "accepted")]);
        }),
      ),
    ));

  test("a refusal gives the host's reason, with a refused line", () =>
    Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const { lines, log } = logged();
          const host = yield* fakeHost(
            "vm-mk",
            Effect.fail(new HostRefused({ reason: "the disk is gone" })),
          );
          const failed = yield* sweepOn(
            doorsWith(host.reached),
            { installation: "i-vm", machine: "vm-mk" },
            "s-1",
            log,
          ).pipe(Effect.flip);
          expect(failed).toEqual(new ActionFailed({ request: "s-1", reason: "the disk is gone" }));
          expect(lines).toEqual([line("s-1", "refused", "the disk is gone")]);
        }),
      ),
    ));

  test("a door renewed mid-sweep is sent the same request, and its answer is the sweep's", () =>
    Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const { lines, log } = logged();
          const door = yield* Scope.make();
          const first = yield* fakeHost("vm-mk", Effect.never).pipe(Scope.provide(door));
          const next = yield* fakeHost("vm-mk", Effect.succeed(report(512)));
          const doors = doorsWith(first.reached);
          const sweeping = yield* sweepOn(
            doors,
            { installation: "i-vm", machine: "vm-mk" },
            "s-1",
            log,
          ).pipe(Effect.forkChild);
          yield* Effect.yieldNow;
          doors.delete("i-vm");
          yield* Scope.close(door, Exit.void);
          yield* Effect.yieldNow;
          doors.set("i-vm", next.reached);
          expect(yield* Fiber.join(sweeping)).toEqual(report(512));
          expect(first.swept).toEqual(["s-1"]);
          expect(next.swept).toEqual(["s-1"]);
          expect(lines).toEqual([
            line("s-1", "failed", "the connection was renewed before this finished"),
            line("s-1", "accepted", undefined, 2),
          ]);
        }),
      ),
    ));

  test("a send over a broken connection is sent again over the next door", () =>
    Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const { lines, log } = logged();
          const next = yield* fakeHost("vm-mk", Effect.succeed(report(512)));
          const doors = doorsWith(brokenDoor);
          const sweeping = yield* sweepOn(
            doors,
            { installation: "i-vm", machine: "vm-mk" },
            "s-1",
            log,
          ).pipe(Effect.forkChild);
          yield* Effect.yieldNow;
          doors.set("i-vm", next.reached);
          expect(yield* Fiber.join(sweeping)).toEqual(report(512));
          expect(next.swept).toEqual(["s-1"]);
          expect(lines).toEqual([
            line("s-1", "failed", broken.message),
            line("s-1", "accepted", undefined, 2),
          ]);
        }),
      ),
    ));

  test("a resend shares the first send's 10 minutes", () =>
    Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const { lines, log } = logged();
          const door = yield* Scope.make();
          const first = yield* fakeHost("vm-mk", Effect.never).pipe(Scope.provide(door));
          const next = yield* fakeHost("vm-mk", Effect.never);
          const doors = doorsWith(first.reached);
          const sweeping = yield* sweepOn(
            doors,
            { installation: "i-vm", machine: "vm-mk" },
            "s-1",
            log,
          ).pipe(Effect.flip, Effect.forkChild);
          yield* TestClock.adjust("6 minutes");
          doors.set("i-vm", next.reached);
          yield* Scope.close(door, Exit.void);
          yield* TestClock.adjust("239 seconds");
          expect(sweeping.pollUnsafe()).toBeUndefined();
          yield* TestClock.adjust("1 second");
          expect(yield* Fiber.join(sweeping)).toEqual(
            new ActionFailed({ request: "s-1", reason: TIMED_OUT }),
          );
          expect(next.swept).toEqual(["s-1"]);
          expect(lines).toEqual([
            line("s-1", "failed", "the connection was renewed before this finished"),
            line("s-1", "timed-out", TIMED_OUT, 2),
          ]);
        }),
      ).pipe(Effect.provide(TestClock.layer())),
    ));

  test("a door lost with none to follow it waits out the 10 minutes, with a not-sent line", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const { lines, log } = logged();
        const door = yield* Scope.make();
        const first = yield* fakeHost("vm-mk", Effect.never).pipe(Scope.provide(door));
        const doors = doorsWith(first.reached);
        const sweeping = yield* sweepOn(
          doors,
          { installation: "i-vm", machine: "vm-mk" },
          "s-1",
          log,
        ).pipe(Effect.flip, Effect.forkChild);
        yield* TestClock.adjust("1 minute");
        doors.delete("i-vm");
        yield* Scope.close(door, Exit.void);
        yield* TestClock.adjust("539 seconds");
        expect(sweeping.pollUnsafe()).toBeUndefined();
        yield* TestClock.adjust("1 second");
        expect(yield* Fiber.join(sweeping)).toEqual(
          new ActionFailed({ request: "s-1", reason: TIMED_OUT }),
        );
        expect(lines).toEqual([
          line("s-1", "failed", "the connection was renewed before this finished"),
          line("s-1", "not-sent", "it did not reconnect within 10 minutes", 2),
        ]);
      }).pipe(Effect.provide(TestClock.layer())),
    ));

  test("an answer after 45 s is waited for: sent once, and its whole report returned", () =>
    Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const { lines, log } = logged();
          const host = yield* fakeHost(
            "vm-mk",
            Effect.sleep("45 seconds").pipe(Effect.as(report(3 * 1024 ** 3))),
          );
          const sweeping = yield* sweepOn(
            doorsWith(host.reached),
            { installation: "i-vm", machine: "vm-mk" },
            "s-1",
            log,
          ).pipe(Effect.forkChild);
          yield* TestClock.adjust("45 seconds");
          expect(yield* Fiber.join(sweeping)).toEqual(report(3 * 1024 ** 3));
          expect(host.swept).toEqual(["s-1"]);
          expect(lines).toEqual([line("s-1", "accepted")]);
        }),
      ).pipe(Effect.provide(TestClock.layer())),
    ));

  test("no answer in 10 minutes times out, having sent one sweep", () =>
    Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const { lines, log } = logged();
          const host = yield* fakeHost("vm-mk", Effect.never);
          const sweeping = yield* sweepOn(
            doorsWith(host.reached),
            { installation: "i-vm", machine: "vm-mk" },
            "s-1",
            log,
          ).pipe(Effect.flip, Effect.forkChild);
          yield* TestClock.adjust("10 minutes");
          expect(yield* Fiber.join(sweeping)).toEqual(
            new ActionFailed({ request: "s-1", reason: TIMED_OUT }),
          );
          expect(host.swept).toEqual(["s-1"]);
          expect(lines).toEqual([line("s-1", "timed-out", TIMED_OUT)]);
        }),
      ).pipe(Effect.provide(TestClock.layer())),
    ));

  test("Try again sends the same request", () =>
    Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const { log } = logged();
          const host = yield* fakeHost(
            "vm-mk",
            Effect.fail(new HostRefused({ reason: "the disk is gone" })),
          );
          const doors = doorsWith(host.reached);
          const machine = { installation: "i-vm", machine: "vm-mk" };
          yield* sweepOn(doors, machine, "s-1", log).pipe(Effect.ignore);
          yield* sweepOn(doors, machine, "s-1", log).pipe(Effect.ignore);
          expect(host.swept).toEqual(["s-1", "s-1"]);
        }),
      ),
    ));

  test("a Machine that isn't connected is sent nothing, with a not-sent line", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const { lines, log } = logged();
        const failed = yield* sweepOn(
          new DoorMap<Reached>(),
          { installation: "i-vm", machine: "vm-mk" },
          "s-1",
          log,
        ).pipe(Effect.flip);
        expect(failed).toEqual(
          new ActionFailed({
            request: "s-1",
            reason: "Not sent to vm-mk: that Machine is not connected.",
          }),
        );
        expect(lines).toEqual([
          { ...line("s-1", "not-sent", "that Machine is not connected"), attempt: 0 },
        ]);
      }),
    ));

  test("two Machines swept at once: one failing does not stop the other's report", () =>
    Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const { log } = logged();
          const failing = yield* fakeHost(
            "vm-a",
            Effect.fail(new HostRefused({ reason: "the disk is gone" })),
          );
          const answering = yield* fakeHost(
            "vm-b",
            Effect.sleep("45 seconds").pipe(Effect.as(report(10))),
          );
          const doors = new DoorMap<Reached>();
          doors.set("i-a", failing.reached);
          doors.set("i-b", answering.reached);
          const sweeping = yield* Effect.all(
            [
              sweepOn(doors, { installation: "i-a", machine: "vm-a" }, "s-a", log).pipe(
                Effect.exit,
              ),
              sweepOn(doors, { installation: "i-b", machine: "vm-b" }, "s-b", log).pipe(
                Effect.exit,
              ),
            ],
            { concurrency: "unbounded" },
          ).pipe(Effect.forkChild);
          yield* TestClock.adjust("45 seconds");
          const [a, b] = yield* Fiber.join(sweeping);
          expect(a).toEqual(
            Exit.fail(new ActionFailed({ request: "s-a", reason: "the disk is gone" })),
          );
          expect(b).toEqual(Exit.succeed(report(10)));
          expect([...failing.swept, ...answering.swept]).toEqual(["s-a", "s-b"]);
        }),
      ).pipe(Effect.provide(TestClock.layer())),
    ));
});

import { expect, test } from "bun:test";
import { Deferred, Effect, Fiber, FileSystem } from "effect";
import { processStartTime, signalProcess, withLock } from "../src/lock";
import {
  admission,
  admitted,
  budgetOf,
  type Entry,
  enqueue,
  entriesOf,
  look,
  ownProcess,
  processOf,
  startOnHold,
} from "../tools/budget";
import { runEffect } from "./support/effect";
import { until } from "./support/host";

const VM_MK = budgetOf(24);

let seq = 0;
const entry = (
  kind: Entry["kind"],
  state: Entry["state"],
  asked: number,
  workers = asked,
): Entry => ({
  id: `e${++seq}`,
  kind,
  state,
  asked,
  workers,
  seq,
});

test("the budget is two thirds of the cores and a quarter of it is kept for small runs", () => {
  expect(VM_MK).toEqual({ total: 16, reserve: 4 });
  expect(budgetOf(8)).toEqual({ total: 5, reserve: 2 });
  expect(budgetOf(24, "40")).toEqual({ total: 40, reserve: 10 });
  expect(budgetOf(24, "none")).toEqual({ total: 16, reserve: 4 });
});

test("a targeted run is admitted while a whole suite holds all a whole suite may have", () => {
  const suite = entry("whole", "held", 12);
  const targeted = entry("small", "waiting", 2);
  expect(admission(VM_MK, [suite, targeted], targeted)).toEqual({
    _tag: "admit",
    workers: 2,
    fewer: null,
  });
});

test("a second whole suite waits for the one that holds", () => {
  const suite = entry("whole", "held", 12);
  const next = entry("whole", "waiting", 12);
  expect(admission(VM_MK, [suite, next], next)).toEqual({ _tag: "wait", behind: [suite] });
});

test("two waiting whole suites are admitted in the order they arrived", () => {
  const first = entry("whole", "waiting", 12);
  const second = entry("whole", "waiting", 12);
  expect(admission(VM_MK, [second, first], second)).toEqual({ _tag: "wait", behind: [first] });
  expect(admission(VM_MK, [second, first], first)).toMatchObject({ _tag: "admit", workers: 12 });
});

test("a later small run that would fit does not overtake an earlier one of its class", () => {
  const running = entry("small", "held", 2);
  const earlier = entry("small", "waiting", 4);
  const later = entry("small", "waiting", 2);
  const all = [running, later, earlier];
  expect(admission(VM_MK, all, later)).toEqual({ _tag: "wait", behind: [earlier] });
  expect(admission(VM_MK, all, earlier)).toEqual({ _tag: "wait", behind: [running] });
});

test("a --parallel larger than its class's share gets the share, and says so", () => {
  const suite = entry("whole", "waiting", 20);
  expect(admission(VM_MK, [suite], suite)).toEqual({
    _tag: "admit",
    workers: 12,
    fewer: "asked for 20 workers and got 12: a whole suite has at most 12 of a budget of 16",
  });
  const targeted = entry("small", "waiting", 8);
  expect(admission(VM_MK, [targeted], targeted)).toEqual({
    _tag: "admit",
    workers: 4,
    fewer: "asked for 8 workers and got 4: small runs share 4 of a budget of 16",
  });
});

test("on two cores there is one pool: a whole suite takes it, and a small run after it waits", () => {
  const small = budgetOf(2);
  expect(small).toEqual({ total: 2, reserve: 2 });
  const suite = entry("whole", "waiting", 2);
  expect(admission(small, [suite], suite)).toEqual({ _tag: "admit", workers: 2, fewer: null });
  const held = { ...suite, state: "held" as const };
  const targeted = entry("small", "waiting", 2);
  expect(admission(small, [held, targeted], targeted)).toEqual({ _tag: "wait", behind: [held] });
  expect(admission(small, [targeted], targeted)).toMatchObject({ _tag: "admit", workers: 2 });
});

const RUNNER = new URL("./support/budget-runner.ts", import.meta.url).pathname;

const store = Effect.flatMap(FileSystem.FileSystem, (fs) =>
  fs.makeTempDirectoryScoped({ prefix: "budget-" }),
);

const sleeper = Effect.acquireRelease(
  Effect.sync(() => Bun.spawn(["sleep", "30"])),
  (child) => Effect.sync(() => child.kill("SIGKILL")),
);

const gone = (pid: number) =>
  until(
    () => signalProcess(pid),
    (lives) => !lives,
  );

const runner = (dir: string) =>
  Effect.gen(function* () {
    const one = yield* Effect.acquireRelease(
      Effect.sync(() => Bun.spawn(["bun", RUNNER, dir], { stdout: "pipe", stderr: "inherit" })),
      (one) => Effect.sync(() => one.kill("SIGKILL")),
    );
    const reader = one.stdout.getReader();
    let out = "";
    while (!out.includes("\n")) {
      const { value, done } = yield* Effect.promise(() => reader.read());
      if (done) throw new Error(`the runner ended before it held: ${out}`);
      out += new TextDecoder().decode(value);
    }
    const child = Number(out.trim());
    yield* Effect.addFinalizer(() => signalProcess(child, "SIGKILL"));
    return { runner: one, child };
  });

const waiting = (dir: string) =>
  Effect.flatMap(ownProcess, (me) => enqueue(dir, "whole", 12, [me]));

test(
  "a runner killed with kill -9 holds its workers until the bun test it started is gone too",
  () =>
    runEffect(
      Effect.gen(function* () {
        const dir = yield* store;
        const { runner: held, child } = yield* runner(dir);
        held.kill("SIGKILL");
        yield* Effect.promise(() => held.exited);
        const next = yield* waiting(dir);
        expect(yield* look(dir, VM_MK, next.id)).toMatchObject({ _tag: "wait" });

        process.kill(child, "SIGKILL");
        yield* gone(child);
        expect(yield* look(dir, VM_MK, next.id)).toMatchObject({ _tag: "admit", workers: 12 });
      }),
    ),
  20_000,
);

test(
  "a runner stopped with SIGTERM gives back its hold and stops what it started",
  () =>
    runEffect(
      Effect.gen(function* () {
        const dir = yield* store;
        const { runner: held, child } = yield* runner(dir);
        held.kill("SIGTERM");
        yield* Effect.promise(() => held.exited);
        yield* gone(child);
        expect(yield* entriesOf(dir)).toEqual([]);
      }),
    ),
  20_000,
);

test(
  "a runner killed while it names its child in the store leaves nothing running on the hold",
  () =>
    runEffect(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const dir = yield* store;
        const marker = `${dir}/ran`;
        const one = yield* Effect.acquireRelease(
          Effect.sync(() =>
            Bun.spawn(["bun", RUNNER, dir, marker], {
              stdin: "pipe",
              stdout: "pipe",
              stderr: "inherit",
            }),
          ),
          (one) => Effect.sync(() => one.kill("SIGKILL")),
        );
        const reader = one.stdout.getReader();
        yield* Effect.promise(() => reader.read());

        const taken = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        const lock = yield* Effect.forkChild(
          withLock(
            `${dir}/budget.lock`,
            Effect.die(new Error("the store's lock could not be taken")),
            Deferred.succeed(taken, undefined).pipe(Effect.andThen(Deferred.await(release))),
          ),
        );
        yield* Deferred.await(taken);
        void one.stdin.write("start\n");
        void one.stdin.end();
        const child = yield* until(
          () =>
            Effect.sync(() => Bun.spawnSync(["pgrep", "-P", String(one.pid)]).stdout.toString()),
          (out) => out.trim() !== "",
        ).pipe(Effect.map(Number));
        yield* Effect.addFinalizer(() => signalProcess(child, "SIGKILL"));
        one.kill("SIGKILL");
        yield* Effect.promise(() => one.exited);
        yield* Deferred.succeed(release, undefined);
        yield* Fiber.join(lock);

        const [, ran] = yield* until(
          () => Effect.all([signalProcess(child), fs.exists(marker)]),
          ([lives, ran]) => !lives || ran,
        );
        expect(ran).toBe(false);
      }),
    ),
  20_000,
);

test(
  "a hold is given back only once the process started on it is gone, even one SIGTERM does not end",
  () =>
    runEffect(
      Effect.gen(function* () {
        const dir = yield* store;
        const child = yield* Effect.scoped(
          Effect.gen(function* () {
            const hold = yield* admitted(dir, VM_MK, "whole", 12, () => Effect.void);
            const child = yield* startOnHold(dir, hold.id, ["sleep", "30"], { env: process.env });
            process.kill(child.pid, "SIGSTOP");
            return child;
          }),
        );
        const lives = yield* signalProcess(child.pid);
        if (lives) child.kill("SIGKILL");
        expect({ lives, store: yield* entriesOf(dir) }).toEqual({ lives: false, store: [] });
      }),
    ),
  20_000,
);

test("a hold whose pid now belongs to a process that started later is reclaimed", () =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const dir = yield* store;
      const stranger = yield* sleeper;
      const holdOn = (start: string | null) =>
        fs.writeFileString(
          `${dir}/budget.json`,
          JSON.stringify({
            next: 1,
            entries: [
              {
                id: "old",
                kind: "whole",
                state: "held",
                asked: 12,
                workers: 12,
                seq: 0,
                processes: [{ pid: stranger.pid, start }],
              },
            ],
          }),
        );

      yield* holdOn(yield* processStartTime(stranger.pid));
      const kept = yield* waiting(dir);
      expect(yield* look(dir, VM_MK, kept.id)).toMatchObject({ _tag: "wait" });

      yield* holdOn("a start long before this process's");
      const next = yield* waiting(dir);
      expect(yield* look(dir, VM_MK, next.id)).toMatchObject({ _tag: "admit", workers: 12 });
      expect((yield* entriesOf(dir)).map((one) => one.id)).toEqual([next.id]);
    }),
  ));

test("an interrupted waiter leaves no ticket, and an interrupted holder leaves no hold", () =>
  runEffect(
    Effect.gen(function* () {
      const dir = yield* store;
      const other = yield* sleeper;
      const theirs = yield* enqueue(dir, "whole", 12, [yield* processOf(other.pid)]);
      yield* look(dir, VM_MK, theirs.id);

      const waiter = yield* Effect.forkChild(
        Effect.scoped(admitted(dir, VM_MK, "whole", 12, () => Effect.void)),
      );
      yield* until(
        () => entriesOf(dir),
        (all) => all.length === 2,
      );
      yield* Fiber.interrupt(waiter);
      expect((yield* entriesOf(dir)).map((one) => one.id)).toEqual([theirs.id]);

      const holder = yield* Effect.forkChild(
        Effect.scoped(
          admitted(dir, VM_MK, "small", 2, () => Effect.void).pipe(Effect.andThen(Effect.never)),
        ),
      );
      yield* until(
        () => entriesOf(dir),
        (all) => all.some((one) => one.kind === "small" && one.state === "held"),
      );
      yield* Fiber.interrupt(holder);
      expect((yield* entriesOf(dir)).map((one) => one.id)).toEqual([theirs.id]);
    }),
  ));

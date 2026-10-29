import { expect, test } from "bun:test";
import { Clock, Effect, FileSystem, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import {
  bindingsOf,
  boundProcesses,
  commandOf,
  groupOf,
  processOf,
  startedOf,
} from "../src/processes";
import { runEffect } from "./support/effect";

test("a process's command and start time read alone are what reading it whole says", () =>
  runEffect(
    Effect.gen(function* () {
      const whole = (yield* processOf(process.pid))!;
      expect(yield* commandOf(process.pid)).toBe(whole.command);
      expect(yield* startedOf(process.pid)).toBe(whole.started);
    }),
  ));

test("a process that is not running has no start time", () =>
  runEffect(Effect.map(startedOf(2 ** 22 + 1), (started) => expect(started).toBeNull())));

test.skipIf(process.platform !== "linux")(
  "a process gone from /proc is not looked for with ps",
  () =>
    runEffect(
      Effect.gen(function* () {
        const spawned: string[] = [];
        const spawner = ChildProcessSpawner.make((command) =>
          Effect.sync(() => {
            if (command._tag === "StandardCommand") spawned.push(command.command);
          }).pipe(Effect.andThen(Effect.die("nothing may be spawned"))),
        );
        const started = yield* startedOf(2 ** 22 + 1).pipe(
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
        );
        expect(started).toBeNull();
        expect(spawned).toEqual([]);
      }),
    ),
);

test("a running process's group and bindings are read, and a gone one has neither", () =>
  runEffect(
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const leader = yield* spawner.spawn(
        ChildProcess.make("sh", ["-c", "echo ready; while :; do sleep 1; done"], {
          env: { COLLIE_PROBE: "carried" },
          extendEnv: true,
          detached: true,
          stdout: "pipe",
          stderr: "ignore",
        }),
      );
      // Until it has exec'd, /proc shows its parent's environment, or none.
      yield* Stream.runDrain(Stream.take(Stream.decodeText(leader.stdout), 1));
      expect(yield* groupOf(leader.pid)).toBe(leader.pid);
      // Without a readable /proc, a binding proves nothing.
      expect(yield* bindingsOf(leader.pid, ["COLLIE_PROBE", "COLLIE_ABSENT"])).toEqual(
        process.platform === "linux" ? { COLLIE_PROBE: "carried" } : null,
      );

      const gone = 2 ** 22 + 1;
      expect(yield* groupOf(gone)).toBeNull();
      expect(yield* bindingsOf(gone, ["COLLIE_PROBE"])).toBeNull();
    }),
  ));

test("an environ /proc shows empty, as mid-exec, proves nothing", () =>
  runEffect(
    Effect.gen(function* () {
      const midExec = FileSystem.makeNoop({ readFileString: () => Effect.succeed("") });
      expect(
        yield* bindingsOf(7, ["COLLIE_PROBE"]).pipe(
          Effect.provideService(FileSystem.FileSystem, midExec),
        ),
      ).toBeNull();
    }),
  ));

test("a look for bound processes on a busy machine takes about one process's reads, not all of theirs", () =>
  runEffect(
    Effect.gen(function* () {
      const pids = Array.from({ length: 100 }, (_, at) => String(at + 1));
      const stat = (pid: string) =>
        [`${pid} (sh)`, "S", ...Array(18).fill("1"), `start-${pid}`].join(" ");
      const slowProc = FileSystem.makeNoop({
        exists: () => Effect.succeed(true),
        readDirectory: () => Effect.succeed(pids),
        readFileString: (path) => {
          const [, , pid, file] = path.split("/");
          const environ = pid === "7" ? "COLLIE_PROBE=carried\0HOME=/x" : "HOME=/x";
          return Effect.sleep("20 millis").pipe(Effect.as(file === "stat" ? stat(pid!) : environ));
        },
      });

      const began = yield* Clock.currentTimeMillis;
      const found = yield* boundProcesses(["COLLIE_PROBE"]).pipe(
        Effect.provideService(FileSystem.FileSystem, slowProc),
      );
      expect(found).toEqual([{ pid: 7, started: "start-7", bound: { COLLIE_PROBE: "carried" } }]);
      // Read one after another, 100 processes' two reads take 4 seconds.
      expect((yield* Clock.currentTimeMillis) - began).toBeLessThan(1_000);
    }),
  ));

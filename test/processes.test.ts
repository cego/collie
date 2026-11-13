import * as Arr from "effect/Array";
import * as Str from "effect/String";
import { expect, test } from "bun:test";
import { Clock, Effect, Fiber, FileSystem, PlatformError, Stream } from "effect";
import { TestClock } from "effect/testing";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import {
  bindingsOf,
  boundProcesses,
  commandOf,
  groupOf,
  processOf,
  processAbsent,
  sessionOf,
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

test.each(["listing", "member", "ps"])(
  "an unreadable process %s does not prove an empty session",
  (at) =>
    runEffect(
      Effect.gen(function* () {
        const refused = Effect.fail(
          PlatformError.systemError({
            _tag: "PermissionDenied",
            module: "FileSystem",
            method: "read",
          }),
        );
        const fs = FileSystem.makeNoop({
          exists: () => Effect.succeed(at !== "ps"),
          readDirectory: () => (at === "listing" ? refused : Effect.succeed([String(process.pid)])),
          readFileString: () => refused,
        });
        const found = yield* sessionOf(7).pipe(
          Effect.provideService(FileSystem.FileSystem, fs),
          Effect.provideService(
            ChildProcessSpawner.ChildProcessSpawner,
            ChildProcessSpawner.make(() => refused),
          ),
          Effect.result,
        );
        expect(found._tag).toBe("Failure");
      }),
    ),
);

test.skipIf(process.platform !== "linux").each([
  [true, "Unknown"],
  [false, "Unknown"],
  [true, "NotFound"],
  [false, "NotFound"],
] as const)(
  "a session cmdline error is ignored only for a proven absent process (exited: %p, error: %s)",
  (exited, error) =>
    runEffect(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
        const child = yield* spawner.spawn(
          ChildProcess.make(
            process.execPath,
            ["-e", 'console.log("ready"); setInterval(() => {}, 1000);'],
            { detached: false, stdout: "pipe", stderr: "ignore" },
          ),
        );
        yield* Stream.runDrain(Stream.take(Stream.decodeText(child.stdout), 1));
        const live = (yield* processOf(child.pid))!;
        expect(live.session).not.toBeNull();
        expect(live.session).not.toBe(child.pid);
        expect(yield* processAbsent(child.pid)).toBe(false);
        const cmdline = `/proc/${child.pid}/cmdline`;
        const unknown = PlatformError.systemError({
          _tag: error,
          module: "FileSystem",
          method: "readFile",
          pathOrDescriptor: cmdline,
          description: "cmdline read failed",
        });
        const absentAtRead: boolean[] = [];
        const raced: FileSystem.FileSystem = {
          ...fs,
          readDirectory: (path, options) =>
            fs
              .readDirectory(path, options)
              .pipe(
                Effect.map((names) =>
                  path === "/proc"
                    ? Arr.filter(names, (name) => name === String(child.pid))
                    : names,
                ),
              ),
          readFileString: (path, encoding) =>
            path === cmdline
              ? Effect.gen(function* () {
                  if (exited) {
                    yield* child.kill();
                    yield* child.exitCode.pipe(Effect.result);
                  } else yield* fs.readFileString(path, encoding);
                  absentAtRead.push(yield* processAbsent(child.pid));
                  return yield* unknown;
                })
              : fs.readFileString(path, encoding),
        };
        const found = yield* sessionOf(live.session!).pipe(
          Effect.provideService(FileSystem.FileSystem, raced),
          Effect.result,
        );
        expect(absentAtRead).toEqual([exited]);
        if (exited) {
          expect(found._tag).toBe("Success");
          expect(found._tag === "Success" && found.success).toEqual([]);
        } else {
          expect(found._tag).toBe("Failure");
          expect(found._tag === "Failure" && found.failure).toBe(unknown);
        }
      }),
    ),
);

test("only an absent pid proves exit; live and invalid process probes do not", () =>
  runEffect(
    Effect.gen(function* () {
      expect(yield* processAbsent(process.pid)).toBe(false);
      expect(yield* processAbsent(2 ** 22 + 1)).toBe(true);
      expect(yield* processAbsent(Number.NaN)).toBe(false);
    }),
  ));

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

test("unrelated process metadata cannot delay finding a bound process, whose bindings are read after its start", () =>
  runEffect(
    Effect.gen(function* () {
      const clock = yield* TestClock.make();
      let binding = "before-start";
      const proc = FileSystem.makeNoop({
        exists: () => Effect.succeed(true),
        readDirectory: () => Effect.succeed(["7", "8"]),
        readFileString: (path) =>
          Effect.suspend(() => {
            if (path === "/proc/8/stat") return Effect.never;
            if (path === "/proc/7/stat") {
              binding = "after-start";
              return Effect.succeed(
                Arr.join(["7 (sh)", "S", ...Array(18).fill("1"), "start-7"], " "),
              );
            }
            return Effect.succeed(
              path === "/proc/7/environ" ? `COLLIE_PROBE=${binding}\0HOME=/x` : "HOME=/x",
            );
          }),
      });
      yield* Effect.gen(function* () {
        const finding = yield* boundProcesses(["COLLIE_PROBE"]).pipe(Effect.forkChild);
        yield* clock.adjust("1 millis");
        expect(finding.pollUnsafe()).toBeDefined();
        expect(yield* Fiber.join(finding)).toEqual([
          { pid: 7, started: "start-7", bound: { COLLIE_PROBE: "after-start" } },
        ]);
      }).pipe(
        Effect.provideService(Clock.Clock, clock),
        Effect.provideService(FileSystem.FileSystem, proc),
      );
    }),
  ));

test("a look for bound processes on a busy machine takes about one process's reads, not all of theirs", () =>
  runEffect(
    Effect.gen(function* () {
      const pids = Array.from({ length: 100 }, (_, at) => String(at + 1));
      const stat = (pid: string) =>
        Arr.join([`${pid} (sh)`, "S", ...Array(18).fill("1"), `start-${pid}`], " ");
      const slowProc = FileSystem.makeNoop({
        exists: () => Effect.succeed(true),
        readDirectory: () => Effect.succeed(pids),
        readFileString: (path) => {
          const [, , pid, file] = Str.split(path, "/");
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

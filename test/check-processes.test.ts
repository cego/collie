// A check's processes, run by the host's adapter with real processes: what is left running,
// by pid and start token, and what is recorded.

import * as Str from "effect/String";
import * as Arr from "effect/Array";
import { pipe as pipe_ } from "effect/Function";
import { expect, test } from "bun:test";
import { Clock, Deferred, Duration, Effect, Fiber, FileSystem, Option, Sink, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { TestClock } from "effect/testing";
import {
  CHECK_ID,
  CHECK_INSTALLATION,
  CheckProcesses,
  encodeCheckRecord,
  endAllWithin,
  endCheck,
  hostCheckProcesses,
  KILL_CEILING,
  runningChecksDir,
} from "../src/check-processes";
import {
  bindingsOf,
  commandOf,
  groupOf,
  readsSessions,
  startedOf,
  stillRunning,
} from "../src/processes";
import { collect, readVerifications } from "../src/verify";
import { runEffect } from "./support/effect";
import { startDetached } from "./support/command";
import { until } from "./support/host";

const held = new URL("./fixtures/checks/held.sh", import.meta.url).pathname;
const leaves = new URL("./fixtures/checks/leaves.sh", import.meta.url).pathname;
const refuses = new URL("./fixtures/checks/refuses.sh", import.meta.url).pathname;
// Its own, so no other file's checks, running beside these, are taken for leftovers.
const installation = "check-processes-test-installation";

/** A state directory, a directory the check notes its pids in, and the host's adapter. */
const worldWith = (
  options: Omit<Parameters<typeof hostCheckProcesses>[0], "dir" | "installation"> = {},
  adapters: {
    readonly fileSystem?: FileSystem.FileSystem;
    readonly spawner?: ReturnType<typeof ChildProcessSpawner.make>;
  } = {},
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "collie-check-processes-" });
    const state = `${root}/state`;
    const notes = `${root}/notes`;
    yield* fs.makeDirectory(state, { recursive: true });
    yield* fs.makeDirectory(notes, { recursive: true });
    const spawner = adapters.spawner ?? (yield* ChildProcessSpawner.ChildProcessSpawner);
    const checks = yield* hostCheckProcesses({ dir: state, installation, ...options }).pipe(
      Effect.provideService(FileSystem.FileSystem, adapters.fileSystem ?? fs),
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
    );
    return { root, state, notes, checks };
  });
const world = worldWith();

const check = { run: "run-1", name: "held", by: "collie" } as const;

test.skipIf(process.platform !== "linux")(
  "ending a host with no checks does not scan unrelated processes",
  () =>
    runEffect(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        let scans = 0;
        const counted: FileSystem.FileSystem = {
          ...fs,
          readDirectory: (path, options) =>
            Effect.sync(() => {
              if (path === "/proc") scans++;
            }).pipe(Effect.andThen(fs.readDirectory(path, options))),
        };
        const { checks, notes } = yield* worldWith({ sweep: false }, { fileSystem: counted });
        expect(yield* checks.endAll).toEqual([]);
        yield* checks.killEnded;
        const refused = yield* checks.run(check, { executable: held, argv: [notes], cwd: notes });
        expect(refused.pid).toBeNull();
        expect(scans).toBe(0);
      }),
    ),
);

/** The check's leader and its `setsid` child once both have started, each with its start token. */
const startedIn = (notes: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const pidIn = (file: string) =>
      until(
        () => fs.readFileString(`${notes}/${file}`).pipe(Effect.orElseSucceed(() => "")),
        (text) => Str.trim(text) !== "",
      ).pipe(Effect.map((text) => Number(Str.split(Str.trim(text), "\n").at(-1))));
    const ones = [yield* pidIn("starts"), yield* pidIn("children")];
    return yield* Effect.forEach(ones, (pid) =>
      Effect.map(startedOf(pid), (started) => ({ pid, started: started ?? "" })),
    );
  });

const noneRunning = (ones: ReadonlyArray<{ readonly pid: number; readonly started: string }>) =>
  Effect.map(Effect.forEach(ones, stillRunning), (running) => !Arr.some(running, Boolean));

const records = (state: string) =>
  FileSystem.FileSystem.pipe(
    Effect.flatMap((fs) => fs.readDirectory(runningChecksDir(state))),
    Effect.orElseSucceed((): Array<string> => []),
  );

test.skipIf(process.platform !== "linux")(
  "an interrupted check that ignores SIGTERM is gone with its child, and leaves no record",
  () =>
    runEffect(
      Effect.gen(function* () {
        const { state, notes, checks } = yield* world;
        const running = yield* Effect.forkScoped(
          Effect.scoped(
            checks
              .run(check, { executable: held, argv: [notes], cwd: notes })
              .pipe(Effect.flatMap((one) => one.exit)),
          ),
        );
        const ones = yield* startedIn(notes);

        yield* Fiber.interrupt(running);
        expect(yield* noneRunning(ones)).toBe(true);
        expect(yield* records(state)).toEqual([]);
      }),
    ),
  30_000,
);

test.skipIf(process.platform !== "linux")(
  "a check its host ended reports no exit, even once it is gone, and records nothing",
  () =>
    runEffect(
      Effect.gen(function* () {
        const { root, notes, checks } = yield* world;
        const evidence = `${root}/evidence`;
        const collecting = yield* Effect.forkScoped(
          collect(evidence, {
            ...check,
            executable: held,
            argv: [notes],
            cwd: notes,
          }).pipe(Effect.provideService(CheckProcesses, checks)),
        );
        const ones = yield* startedIn(notes);

        expect(Arr.map(yield* checks.endAll, (one) => one.name)).toEqual(["held"]);
        yield* checks.killEnded;
        yield* until(() => noneRunning(ones), Boolean);

        const after = yield* Fiber.join(collecting).pipe(Effect.timeoutOption("1 second"));
        expect(Option.isNone(after)).toBe(true);
        expect(yield* readVerifications(evidence).pipe(Effect.orElseSucceed(() => []))).toEqual([]);
      }),
    ),
  30_000,
);

test.skipIf(process.platform !== "linux")(
  "a check its host ended after its leader exited, while a child held its output, records nothing",
  () =>
    runEffect(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const { root, notes, checks } = yield* world;
        const evidence = `${root}/evidence`;
        const collecting = yield* Effect.forkScoped(
          collect(evidence, {
            ...check,
            executable: leaves,
            argv: [notes],
            cwd: notes,
          }).pipe(Effect.provideService(CheckProcesses, checks)),
        );
        const [leader, child] = yield* Effect.forEach(["starts", "children"], (file) =>
          until(
            () => fs.readFileString(`${notes}/${file}`).pipe(Effect.orElseSucceed(() => "")),
            (text) => Str.trim(text) !== "",
          ).pipe(Effect.map((text) => Number(Str.trim(text)))),
        );
        yield* until(
          () => startedOf(leader!),
          (started) => started === null,
        );
        const ones = [{ pid: child!, started: (yield* startedOf(child!)) ?? "" }];

        expect(Arr.map(yield* checks.endAll, (one) => one.name)).toEqual(["held"]);
        yield* checks.killEnded;
        yield* until(() => noneRunning(ones), Boolean);

        const after = yield* Fiber.join(collecting).pipe(Effect.timeoutOption("1 second"));
        expect(Option.isNone(after)).toBe(true);
        expect(yield* readVerifications(evidence).pipe(Effect.orElseSucceed(() => []))).toEqual([]);
      }),
    ),
  30_000,
);

test.skipIf(process.platform !== "linux")(
  "a check is recorded and marked while it runs, and reports its exit once it ends by itself",
  () =>
    runEffect(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const { state, notes, checks } = yield* world;
        const exit = yield* Effect.forkScoped(
          Effect.scoped(
            checks
              .run(check, { executable: held, argv: [notes], cwd: notes })
              .pipe(Effect.flatMap((one) => one.exit)),
          ),
        );
        const ones = yield* startedIn(notes);

        expect(yield* records(state)).toHaveLength(1);
        const bound = yield* Effect.forEach(ones, ({ pid }) =>
          bindingsOf(pid, [CHECK_INSTALLATION, CHECK_ID]),
        );
        expect(Arr.every(bound, (one) => one?.[CHECK_INSTALLATION] === installation)).toBe(true);
        expect(new Set(Arr.map(bound, (one) => one?.[CHECK_ID])).size).toBe(1);
        expect(bound[0]?.[CHECK_ID]).toStartWith("run-1@");

        yield* fs.writeFileString(`${notes}/release`, "");
        expect(yield* Fiber.join(exit)).toBe(0);
        expect(yield* records(state)).toEqual([]);
      }),
    ),
  30_000,
);

test.skipIf(process.platform !== "linux")(
  "a process its caller spawned is recorded and marked as the check's, and a host after its own ends it as left",
  () =>
    runEffect(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const { state, notes, checks } = yield* world;
        yield* Effect.addFinalizer(() =>
          fs.writeFileString(`${notes}/release`, "").pipe(Effect.ignore),
        );
        yield* Effect.forkScoped(
          checks.adopt(check, (markers) =>
            Effect.sync(() =>
              Bun.spawn([held, notes], {
                env: { ...process.env, ...markers },
                stdout: "ignore",
                stderr: "ignore",
                detached: true,
              }),
            ),
          ),
        );
        const ones = yield* startedIn(notes);
        expect(yield* records(state)).toHaveLength(1);
        const bound = yield* bindingsOf(ones[1]!.pid, [CHECK_INSTALLATION, CHECK_ID]);
        expect(bound?.[CHECK_ID]).toStartWith("run-1@");

        // The host that adopted it died: the next one on the state directory ends it.
        yield* hostCheckProcesses({ dir: state, installation });
        expect(yield* noneRunning(ones)).toBe(true);
        expect(yield* records(state)).toEqual([]);
      }),
    ),
  30_000,
);

test.skipIf(process.platform !== "linux")(
  "a recorded pid with another start, and another installation's check, are never signalled",
  () =>
    runEffect(
      Effect.gen(function* () {
        expect(yield* readsSessions).toBe(true);
        const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
        const sleeper = (env: Record<string, string>) =>
          spawner.spawn(
            ChildProcess.make("sleep", ["30"], {
              env,
              extendEnv: true,
              stdout: "ignore",
              stderr: "ignore",
            }),
          );
        const reused = yield* sleeper({});
        const theirs = yield* sleeper({
          [CHECK_INSTALLATION]: "another-installation",
          [CHECK_ID]: "run-1@1-theirs",
        });

        expect(
          yield* endCheck(
            {
              id: "run-1@1-mine",
              leader: { pid: reused.pid, started: "not-its-start", group: reused.pid },
            },
            installation,
          ),
        ).toBe(true);
        expect(
          yield* endCheck(
            { id: "run-1@1-theirs", leader: { pid: 2 ** 22 + 1, started: "", group: 2 ** 22 + 1 } },
            installation,
          ),
        ).toBe(true);

        expect(yield* reused.isRunning).toBe(true);
        expect(yield* theirs.isRunning).toBe(true);
      }),
    ),
  30_000,
);

/** The held check, left running by nobody, marked as check `id` of `installation`. */
const leftBehind = (
  notes: string,
  marker: { readonly installation: string; readonly id: string },
) =>
  startDetached([
    "env",
    `${CHECK_INSTALLATION}=${marker.installation}`,
    `${CHECK_ID}=${marker.id}`,
    held,
    notes,
  ]);

test.skipIf(process.platform !== "linux")(
  "a check of a Run ends what another host left of that Run before it starts, and nothing of another Run",
  () =>
    runEffect(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const { root, notes, checks } = yield* world;
        const others = `${root}/others`;
        yield* fs.makeDirectory(others);
        yield* Effect.addFinalizer(() =>
          Effect.all([
            fs.writeFileString(`${notes}/release`, ""),
            fs.writeFileString(`${others}/release`, ""),
          ]).pipe(Effect.ignore),
        );
        yield* leftBehind(notes, { installation, id: "run-1@1-left" });
        yield* leftBehind(others, { installation, id: "run-2@1-left" });
        const left = yield* startedIn(notes);
        const another = yield* startedIn(others);

        const exit = yield* Effect.forkScoped(
          Effect.scoped(
            checks
              .run(check, { executable: held, argv: [notes], cwd: notes })
              .pipe(Effect.flatMap((one) => one.exit)),
          ),
        );
        yield* until(
          () => fs.readFileString(`${notes}/starts`),
          (text) => Str.split(Str.trim(text), "\n").length === 2,
        );

        expect(yield* noneRunning(left)).toBe(true);
        expect(yield* fs.exists(`${notes}/overlaps`)).toBe(false);
        expect(yield* Effect.forEach(another, stillRunning)).toEqual([true, true]);
        yield* fs.writeFileString(`${notes}/release`, "");
        expect(yield* Fiber.join(exit)).toBe(0);
        yield* fs.writeFileString(`${others}/release`, "");
        yield* until(() => noneRunning(another), Boolean);
      }),
    ),
  30_000,
);

/** This machine as macOS shows it: no `/proc`, and `ps -E` for a process's environment. */
const withoutProc = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const hidden = (path: string) => path === "/proc" || pipe_(path, Str.startsWith("/proc/"));
  const noProc: FileSystem.FileSystem = {
    ...fs,
    exists: (path) => (hidden(path) ? Effect.succeed(false) : fs.exists(path)),
    readDirectory: (path, options) =>
      hidden(path) ? fs.readDirectory("/nonexistent/proc") : fs.readDirectory(path, options),
    readFileString: (path, encoding) =>
      hidden(path) ? fs.readFileString("/nonexistent/proc") : fs.readFileString(path, encoding),
  };
  // procps spells macOS's `-E` as `e`.
  const macPs = ChildProcessSpawner.make((command) =>
    command._tag === "StandardCommand" && command.command === "ps" && command.args.includes("-E")
      ? spawner.spawn(
          ChildProcess.make(
            "ps",
            [...Arr.filter(command.args, (arg) => arg !== "-E"), "e"],
            command.options,
          ),
        )
      : spawner.spawn(command),
  );
  return { noProc, macPs };
});

test.skipIf(process.platform !== "linux")(
  "without /proc, a marked check another host left proves nothing and is left running",
  () =>
    runEffect(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "collie-check-processes-" });
        const notes = `${root}/notes`;
        yield* fs.makeDirectory(notes);
        yield* Effect.addFinalizer(() =>
          fs.writeFileString(`${notes}/release`, "").pipe(Effect.ignore),
        );
        yield* leftBehind(notes, { installation, id: "run-1@1-left" });
        const left = yield* startedIn(notes);
        yield* Effect.addFinalizer(() =>
          fs
            .writeFileString(`${notes}/release`, "")
            .pipe(Effect.andThen(until(() => noneRunning(left), Boolean)), Effect.ignore),
        );
        const { noProc, macPs } = yield* withoutProc;

        const checks = yield* hostCheckProcesses({ dir: `${root}/state`, installation }).pipe(
          Effect.provideService(FileSystem.FileSystem, noProc),
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, macPs),
        );

        expect(yield* noneRunning(left)).toBe(false);
        expect(yield* checks.left).toEqual([]);
      }),
    ),
  30_000,
);

test.skipIf(process.platform !== "linux")(
  "without /proc, a process naming a check's markers only in its arguments is never Collie's",
  () =>
    runEffect(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "collie-check-processes-" });
        const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
        const posing = yield* spawner.spawn(
          ChildProcess.make(
            "sh",
            [
              "-c",
              "sleep 30",
              `${CHECK_INSTALLATION}=${installation}`,
              `${CHECK_ID}=run-1@1-posing`,
            ],
            { stdout: "ignore", stderr: "ignore" },
          ),
        );
        const { noProc, macPs } = yield* withoutProc;

        const checks = yield* hostCheckProcesses({ dir: `${root}/state`, installation }).pipe(
          Effect.provideService(FileSystem.FileSystem, noProc),
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, macPs),
        );

        expect(yield* checks.left).toEqual([]);
        expect(
          yield* bindingsOf(posing.pid, [CHECK_INSTALLATION, CHECK_ID]).pipe(
            Effect.provideService(FileSystem.FileSystem, noProc),
            Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, macPs),
          ),
        ).toBeNull();
        expect(yield* posing.isRunning).toBe(true);
      }),
    ),
  30_000,
);

test.skipIf(process.platform !== "linux")(
  "without /proc, a process whose environment only quotes a check's markers is never ended",
  () =>
    runEffect(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "collie-check-processes-" });
        const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
        const quoting = yield* spawner.spawn(
          ChildProcess.make("sleep", ["30"], {
            env: { QUOTED: `x ${CHECK_INSTALLATION}=${installation} ${CHECK_ID}=run-1@1-quoted` },
            extendEnv: true,
            detached: true,
            stdout: "ignore",
            stderr: "ignore",
          }),
        );
        yield* until(
          () => commandOf(quoting.pid),
          (command) => pipe_(command, Str.startsWith("sleep")),
        );
        const { noProc, macPs } = yield* withoutProc;
        const signalled: Array<number> = [];

        const checks = yield* hostCheckProcesses({
          dir: `${root}/state`,
          installation,
          kill: (target) => void signalled.push(Math.abs(target)),
        }).pipe(
          Effect.provideService(FileSystem.FileSystem, noProc),
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, macPs),
        );

        expect(signalled).not.toContain(quoting.pid);
        expect(yield* checks.left).toEqual([]);
      }),
    ),
  30_000,
);

interface Gate {
  armed: string | null;
  readonly reached: Deferred.Deferred<void>;
  readonly release: Deferred.Deferred<void>;
}

const gatedSpawn = Effect.gen(function* () {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const gate: Gate = {
    armed: null,
    reached: yield* Deferred.make<void>(),
    release: yield* Deferred.make<void>(),
  };
  const gated = ChildProcessSpawner.make((command) =>
    spawner.spawn(command).pipe(
      Effect.tap(() =>
        Effect.suspend(() => {
          if (
            gate.armed === null ||
            command._tag !== "StandardCommand" ||
            !command.args.includes(gate.armed)
          )
            return Effect.void;
          gate.armed = null;
          return Deferred.succeed(gate.reached, undefined).pipe(
            Effect.andThen(Deferred.await(gate.release)),
          );
        }),
      ),
    ),
  );
  return { gate, gated };
});

const runHeld = (checks: Effect.Success<typeof world>["checks"], notes: string) =>
  Effect.forkScoped(
    Effect.scoped(
      checks
        .run(check, { executable: held, argv: [notes], cwd: notes })
        .pipe(Effect.flatMap((one) => one.collected(one.exit))),
    ),
  );

test.skipIf(process.platform !== "linux")(
  "a check interrupted between its spawn and its record is gone with its child, and leaves no record",
  () =>
    runEffect(
      Effect.gen(function* () {
        const { gate, gated } = yield* gatedSpawn;
        const { state, notes, checks } = yield* worldWith({}, { spawner: gated });
        gate.armed = notes;
        const running = yield* runHeld(checks, notes);
        yield* Effect.addFinalizer(() => Deferred.succeed(gate.release, undefined));
        yield* Deferred.await(gate.reached);
        const ones = yield* startedIn(notes);

        const interrupted = yield* Effect.forkScoped(Fiber.interrupt(running));
        yield* Deferred.succeed(gate.release, undefined);
        yield* Fiber.join(interrupted).pipe(Effect.timeout("10 seconds"));
        expect(yield* noneRunning(ones)).toBe(true);
        expect(yield* records(state)).toEqual([]);
      }),
    ),
  30_000,
);

test.skipIf(process.platform !== "linux")(
  "a check asked for once its host has begun to end is never started",
  () =>
    runEffect(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const { notes, checks } = yield* world;
        expect(yield* checks.endAll).toEqual([]);

        const exit = yield* runHeld(checks, notes);
        expect(Option.isNone(yield* Fiber.join(exit).pipe(Effect.timeoutOption("1 second")))).toBe(
          true,
        );
        expect(yield* checks.collecting).toEqual([]);
        expect(yield* fs.exists(`${notes}/starts`)).toBe(false);
      }),
    ),
  30_000,
);

test.skipIf(process.platform !== "linux")(
  "a check whose spawn is under way as its host begins to end is ended with the rest",
  () =>
    runEffect(
      Effect.gen(function* () {
        const { gate, gated } = yield* gatedSpawn;
        const { notes, checks } = yield* worldWith({}, { spawner: gated });
        gate.armed = notes;
        const exit = yield* runHeld(checks, notes);
        yield* Effect.addFinalizer(() => Deferred.succeed(gate.release, undefined));
        yield* Deferred.await(gate.reached);
        const ones = yield* startedIn(notes);

        yield* checks.endAll;
        yield* Deferred.succeed(gate.release, undefined);
        yield* until(
          () => checks.collecting,
          (ids) => ids.length === 1,
        );
        yield* checks.killEnded;
        yield* until(() => noneRunning(ones), Boolean);
        expect(Option.isNone(yield* Fiber.join(exit).pipe(Effect.timeoutOption("1 second")))).toBe(
          true,
        );
      }),
    ),
  30_000,
);

test.skipIf(process.platform !== "linux")(
  "a check whose spawn lands once its host's checks are killed is killed too",
  () =>
    runEffect(
      Effect.gen(function* () {
        const { gate, gated } = yield* gatedSpawn;
        const { notes, checks } = yield* worldWith({}, { spawner: gated });
        gate.armed = notes;
        yield* runHeld(checks, notes);
        yield* Effect.addFinalizer(() => Deferred.succeed(gate.release, undefined));
        yield* Deferred.await(gate.reached);
        const ones = yield* startedIn(notes);

        yield* checks.endAll;
        const killed = yield* Effect.forkScoped(checks.killEnded);
        yield* Deferred.succeed(gate.release, undefined);
        yield* Fiber.join(killed);
        const gone = yield* until(() => noneRunning(ones), Boolean).pipe(
          Effect.timeoutOption("3 seconds"),
        );
        expect(Option.isSome(gone)).toBe(true);
      }),
    ),
  30_000,
);

test.skipIf(process.platform !== "linux")(
  "a check whose spawn is under way as its host begins to end is named once among those ended",
  () =>
    runEffect(
      Effect.gen(function* () {
        const { gate, gated } = yield* gatedSpawn;
        const { notes, checks } = yield* worldWith({}, { spawner: gated });
        gate.armed = notes;
        yield* runHeld(checks, notes);
        // Before the check's own finalizer, which waits for it.
        yield* Effect.addFinalizer(() => Deferred.succeed(gate.release, undefined));
        yield* Deferred.await(gate.reached);

        expect(yield* checks.endAll).toEqual([check]);
        yield* Deferred.succeed(gate.release, undefined);
        yield* until(
          () => checks.collecting,
          (ids) => ids.length === 1,
        );
        expect(yield* checks.endAll).toEqual([]);
      }),
    ),
  30_000,
);

test.skipIf(process.platform !== "linux")(
  "a check whose spawn has not landed when its host's grace is up is ended by then, beside another Run's",
  () =>
    runEffect(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const { gate, gated } = yield* gatedSpawn;
        const { root, notes, checks } = yield* worldWith({}, { spawner: gated });
        const others = `${root}/others`;
        yield* fs.makeDirectory(others);
        yield* leftBehind(others, { installation, id: "run-2@1-left" });
        const another = yield* startedIn(others);
        yield* Effect.addFinalizer(() =>
          fs
            .writeFileString(`${others}/release`, "")
            .pipe(Effect.andThen(until(() => noneRunning(another), Boolean)), Effect.ignore),
        );
        gate.armed = notes;
        yield* runHeld(checks, notes);
        // Before the check's own finalizer, which waits for it.
        yield* Effect.addFinalizer(() => Deferred.succeed(gate.release, undefined));
        yield* Deferred.await(gate.reached);
        const ones = yield* startedIn(notes);

        yield* endAllWithin(checks, Duration.seconds(2), () => Effect.void);
        const gone = yield* until(() => noneRunning(ones), Boolean).pipe(
          Effect.timeoutOption("2 seconds"),
        );
        expect(Option.isSome(gone)).toBe(true);
        expect(yield* Effect.forEach(another, stillRunning)).toEqual([true, true]);
      }),
    ),
  30_000,
);

test.skipIf(process.platform !== "linux")(
  "a slow look at /proc while a host's checks get SIGTERM does not hold back their SIGKILL",
  () =>
    runEffect(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const listing = { armed: false, release: yield* Deferred.make<void>() };
        const slow: FileSystem.FileSystem = {
          ...fs,
          readDirectory: (path, options) => {
            if (!listing.armed || path !== "/proc") return fs.readDirectory(path, options);
            listing.armed = false;
            return Deferred.await(listing.release).pipe(
              Effect.andThen(fs.readDirectory(path, options)),
            );
          },
        };
        const { notes, checks } = yield* worldWith({}, { fileSystem: slow });
        yield* Effect.addFinalizer(() => Deferred.succeed(listing.release, undefined));
        yield* runHeld(checks, notes);
        const ones = yield* startedIn(notes);

        listing.armed = true;
        yield* endAllWithin(checks, Duration.millis(2_000), () => Effect.void);
        expect(yield* noneRunning(ones)).toBe(true);
      }),
    ),
  30_000,
);

// Each look at /proc answering before the SIGKILL starts, and after it but before the grace ends.
for (const { delay, grace } of [
  { delay: 200, grace: 500 },
  { delay: 1_700, grace: 2_000 },
])
  test.skipIf(process.platform !== "linux")(
    `a check's child that refuses SIGTERM is killed within a ${grace} ms grace, with each look at /proc ${delay} ms slow`,
    () =>
      runEffect(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const listing = { slow: false };
          const slow: FileSystem.FileSystem = {
            ...fs,
            readDirectory: (path, options) =>
              listing.slow && path === "/proc"
                ? Effect.sleep(Duration.millis(delay)).pipe(
                    Effect.andThen(fs.readDirectory(path, options)),
                  )
                : fs.readDirectory(path, options),
          };
          const { notes, checks } = yield* worldWith({}, { fileSystem: slow });
          yield* Effect.forkScoped(
            Effect.scoped(
              checks
                .run(check, { executable: refuses, argv: [notes], cwd: notes })
                .pipe(Effect.flatMap((one) => one.collected(one.exit))),
            ),
          );
          const ones = yield* startedIn(notes);

          listing.slow = true;
          yield* endAllWithin(checks, Duration.millis(grace), () => Effect.void);
          yield* Effect.sleep("100 millis");
          expect(yield* noneRunning(ones)).toBe(true);
        }),
      ),
    30_000,
  );

test.skipIf(process.platform !== "linux")(
  "slow reads of unrelated processes do not leave a check's child alive after its host stops",
  () =>
    runEffect(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const unrelated = Array.from({ length: 40 }, (_, i) => String(2 ** 22 + i));
        let slow = false;
        const proc: FileSystem.FileSystem = {
          ...fs,
          readDirectory: (path, options) =>
            fs
              .readDirectory(path, options)
              .pipe(Effect.map((names) => (path === "/proc" ? [...unrelated, ...names] : names))),
          readFileString: (path, encoding) => {
            const read = fs.readFileString(path, encoding);
            return slow && Arr.some(unrelated, (pid) => path === `/proc/${pid}/stat`)
              ? Effect.sleep("100 millis").pipe(Effect.andThen(read))
              : read;
          },
        };
        const { notes, checks } = yield* worldWith({}, { fileSystem: proc });
        yield* runHeld(checks, notes);
        const ones = yield* startedIn(notes);

        slow = true;
        yield* endAllWithin(checks, Duration.seconds(2), () => Effect.void).pipe(
          Effect.ensuring(Effect.sync(() => (slow = false))),
        );
        expect(yield* noneRunning(ones)).toBe(true);
      }),
    ),
  30_000,
);

test.skipIf(process.platform !== "linux")(
  "a child that leaves its check's group after the SIGTERM's look is killed before the stop ends",
  () =>
    runEffect(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        let armed = false;
        let looks = 0;
        // The first look starts the child after its snapshot; the SIGKILL's look outlasts the first.
        const slow: FileSystem.FileSystem = {
          ...fs,
          readDirectory: (path, options) => {
            if (!armed || path !== "/proc") return fs.readDirectory(path, options);
            const index = ++looks;
            return Effect.gen(function* () {
              const names = yield* fs.readDirectory(path, options);
              if (index === 1) yield* fs.writeFileString(`${notes}/spawn`, "");
              yield* Effect.sleep(Duration.millis(index === 1 ? 4_400 : index === 2 ? 700 : 1_300));
              return names;
            });
          },
        };
        const { notes, checks } = yield* worldWith({}, { fileSystem: slow });
        yield* Effect.addFinalizer(() =>
          fs.writeFileString(`${notes}/release`, "").pipe(Effect.ignore),
        );
        const child = `trap "" TERM; echo $$ > "$1/children"; while [ ! -f "$1/release" ]; do sleep 0.05; done`;
        const parent = `trap "" TERM; echo $$ > "$1/starts"; while [ ! -f "$1/spawn" ]; do sleep 0.05; done; setsid sh -c "$2" sh "$1" >/dev/null 2>&1 & while [ ! -f "$1/release" ]; do sleep 0.05; done`;
        yield* Effect.forkScoped(
          Effect.scoped(
            checks
              .run(check, {
                executable: "/bin/sh",
                argv: ["-c", parent, "sh", notes, child],
                cwd: notes,
              })
              .pipe(Effect.flatMap((one) => one.collected(one.exit))),
          ),
        );
        yield* until(
          () => checks.collecting,
          (ids) => ids.length === 1,
        );

        armed = true;
        yield* endAllWithin(checks, Duration.seconds(5), () => Effect.void).pipe(
          Effect.ensuring(Effect.sync(() => (armed = false))),
        );
        expect(yield* noneRunning(yield* startedIn(notes))).toBe(true);
      }),
    ),
  30_000,
);

const refusal = () => Object.assign(new Error("kill EPERM"), { code: "EPERM" });

/** `/proc` as it shows one marked process `pid`, through `fs`, with its stat and environment as given. */
const fakeProc = (
  fs: FileSystem.FileSystem,
  pid: number,
  show: {
    readonly stat: () => string;
    readonly environ: () => string;
    readonly list?: Effect.Effect<void>;
  },
): FileSystem.FileSystem => ({
  ...fs,
  exists: (path) => (path === "/proc/self/stat" ? Effect.succeed(true) : fs.exists(path)),
  readDirectory: (path, options) =>
    path === "/proc"
      ? (show.list ?? Effect.void).pipe(
          Effect.map(() => (show.environ() === "" ? [] : [String(pid)])),
        )
      : fs.readDirectory(path, options),
  readFileString: (path, encoding) =>
    path === `/proc/${pid}/environ`
      ? Effect.sync(show.environ)
      : path === `/proc/${pid}/stat`
        ? Effect.sync(show.stat)
        : path === `/proc/${pid}/cmdline`
          ? Effect.succeed("worker\0")
          : fs.readFileString(path, encoding),
});

const statLine = (pid: number, started: string) => {
  const fields = Array<string>(20).fill("0");
  fields[0] = "S";
  fields[2] = String(pid);
  fields[19] = started;
  return `${pid} (worker) ${Arr.join(fields, " ")}`;
};

const markers = (id: string) => `${CHECK_INSTALLATION}=${installation}\0${CHECK_ID}=${id}\0`;

test("a marked process whose pid is taken by another while it is looked at is never signalled", () =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const pid = 987_654;
      let replaced = false;
      const sent: Array<boolean> = [];
      // Reading its start is where the marked process exits and an unmarked one takes its pid.
      const proc = fakeProc(fs, pid, {
        stat: () => {
          const line = statLine(pid, replaced ? "new-start" : "old-start");
          replaced = true;
          return line;
        },
        environ: () => (replaced ? "" : markers("run-1@1-check")),
      });

      yield* endCheck(
        { id: "run-1@1-check", leader: { pid, started: "", group: pid } },
        installation,
        () => sent.push(replaced),
      ).pipe(Effect.provideService(FileSystem.FileSystem, proc));
      expect(sent).not.toContain(true);
    }),
  ));

test(
  "ending a marked check waits two seconds for its SIGTERM by the clock, however slow each look",
  () =>
    runEffect(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const pid = 987_654;
        let alive = true;
        const sent: Array<NodeJS.Signals> = [];
        const proc = fakeProc(fs, pid, {
          stat: () => statLine(pid, "start"),
          environ: () => (alive ? markers("run-1@1-check") : ""),
          list: Effect.sleep("200 millis"),
        });

        const began = yield* Clock.currentTimeMillis;
        const gone = yield* endCheck(
          { id: "run-1@1-check", leader: { pid, started: "", group: pid } },
          installation,
          (_target, name) => {
            sent.push(name);
            if (name === "SIGKILL") alive = false;
          },
        ).pipe(Effect.provideService(FileSystem.FileSystem, proc));
        expect(gone).toBe(true);
        expect(sent).toEqual(["SIGTERM", "SIGKILL"]);
        // Two seconds after the SIGTERM, with a look before it and one after the SIGKILL.
        expect((yield* Clock.currentTimeMillis) - began).toBeLessThan(3_200);
      }),
    ),
  10_000,
);

/** `endCheck` on a TestClock its sleeps advance: each look at `/proc` and signal, by when. */
const endedOnClock = (look: (at: number, alive: { now: boolean }) => Effect.Effect<void>) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const clock = yield* TestClock.make();
    const fast: Clock.Clock = { ...clock, sleep: (duration) => clock.adjust(duration) };
    const start = clock.currentTimeMillisUnsafe();
    const pid = 987_654;
    const alive = { now: true };
    const said: string[] = [];
    const at = () => clock.currentTimeMillisUnsafe() - start;
    const proc = fakeProc(fs, pid, {
      stat: () => statLine(pid, "start"),
      environ: () => (alive.now ? markers("run-1@1-check") : ""),
      list: Effect.suspend(() => {
        said.push(`look@${at()}`);
        return look(at(), alive);
      }),
    });
    const gone = yield* endCheck(
      { id: "run-1@1-check", leader: { pid, started: "", group: pid } },
      installation,
      (_target, name) => said.push(`${name}@${at()}`),
    ).pipe(
      Effect.provideService(FileSystem.FileSystem, proc),
      Effect.provideService(Clock.Clock, fast),
    );
    return { gone, said, ended: at() };
  });

test("ending a check looks every 100 ms, two seconds after its SIGTERM and one after its SIGKILL", () =>
  runEffect(
    Effect.gen(function* () {
      const { gone, said } = yield* endedOnClock(() => Effect.void);
      const looks = (from: number, to: number) =>
        Array.from({ length: (to - from) / 100 + 1 }, (_, at) => `look@${from + at * 100}`);
      expect(gone).toBe(false);
      expect(said).toEqual([
        "look@0",
        "SIGTERM@0",
        ...looks(0, 2000),
        "look@2000",
        "SIGKILL@2000",
        ...looks(2000, 3000),
      ]);
    }),
  ));

test("a look at a check still running when its SIGTERM's two seconds are up is waited for, and used", () =>
  runEffect(
    Effect.gen(function* () {
      const { gone, said, ended } = yield* endedOnClock((at, alive) =>
        at === 1900
          ? Effect.sleep("300 millis").pipe(Effect.andThen(Effect.sync(() => (alive.now = false))))
          : Effect.void,
      );
      expect(gone).toBe(true);
      expect(Arr.filter(said, (one) => pipe_(one, Str.startsWith("SIG")))).toEqual(["SIGTERM@0"]);
      expect(ended).toBe(2200);
    }),
  ));

test(
  "a check whose end is refused keeps its record, so it is still found as left",
  () =>
    runEffect(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const stored = new Map<string, string>();
        const pid = 987_654;
        const started = "Mon Oct 19 00:00:00 2026";
        let refused = 0;
        const noProc: FileSystem.FileSystem = {
          ...fs,
          exists: (path) =>
            Effect.succeed(!pipe_(path, Str.startsWith("/proc")) && stored.has(path)),
          readDirectory: (path) =>
            Effect.succeed(
              Arr.map(
                Arr.filter([...stored.keys()], (one) => pipe_(one, Str.startsWith(`${path}/`))),
                (one) => pipe_(one, Str.slice(path.length + 1)),
              ),
            ),
          makeDirectory: () => Effect.void,
          writeFileString: (path, text) => Effect.sync(() => void stored.set(path, text)),
          rename: (from, to) =>
            Effect.sync(() => {
              stored.set(to, stored.get(from) ?? "");
              stored.delete(from);
            }),
          remove: (path) => Effect.sync(() => void stored.delete(path)),
          readFileString: (path, encoding) =>
            stored.has(path)
              ? Effect.succeed(stored.get(path) ?? "")
              : fs.readFileString(path, encoding),
        };
        // `ps` answers for one check that runs on, whatever it is sent.
        const spawner = ChildProcessSpawner.make((command) => {
          const ps = command._tag === "StandardCommand" && command.command === "ps";
          const args = command._tag === "StandardCommand" ? command.args : [];
          const text = args.includes("pgid=")
            ? String(pid)
            : args.includes("lstart=")
              ? started
              : `${pid} 1 ${started} check`;
          return Effect.succeed(
            ChildProcessSpawner.makeHandle({
              pid: ChildProcessSpawner.ProcessId(pid),
              stdout: ps ? Stream.make(new TextEncoder().encode(text)) : Stream.empty,
              stderr: Stream.empty,
              all: Stream.empty,
              exitCode: ps ? Effect.succeed(ChildProcessSpawner.ExitCode(0)) : Effect.never,
              isRunning: Effect.succeed(true),
              kill: () => Effect.void,
              stdin: Sink.drain,
              getInputFd: () => Sink.drain,
              getOutputFd: () => Stream.empty,
              unref: Effect.never,
            }),
          );
        });
        const checks = yield* hostCheckProcesses({
          dir: "/state",
          installation,
          kill: () => {
            refused++;
            throw refusal();
          },
        }).pipe(
          Effect.provideService(FileSystem.FileSystem, noProc),
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
        );

        yield* Effect.scoped(checks.run(check, { executable: "check", argv: [], cwd: "/" }));
        expect(refused).toBeGreaterThan(0);
        expect(Arr.map(yield* checks.left, (one) => one.run)).toEqual([check.run]);
      }),
    ),
  10_000,
);

/**
 * Check `held` of pass `gate` of run-1, left running and recorded by host 4242, for a kill
 * that signals nothing; let go and waited for once the test is done. Gives back its leader.
 */
const survivingLeftover = (state: string, notes: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    yield* leftBehind(notes, { installation, id: "run-1@1-left" });
    const left = yield* startedIn(notes);
    yield* Effect.addFinalizer(() =>
      fs
        .writeFileString(`${notes}/release`, "")
        .pipe(Effect.andThen(until(() => noneRunning(left), Boolean)), Effect.ignore),
    );
    const leader = left[0]!;
    yield* fs.makeDirectory(runningChecksDir(state), { recursive: true });
    yield* fs.writeFileString(
      `${runningChecksDir(state)}/run-1@1-left.json`,
      encodeCheckRecord({
        id: "run-1@1-left",
        run: "run-1",
        name: "held",
        pass: "gate",
        by: "collie",
        leader: {
          pid: leader.pid,
          started: leader.started,
          group: (yield* groupOf(leader.pid)) ?? leader.pid,
        },
        host: { pid: 4242, started: "2" },
        started: "1970-01-01T00:00:00.001Z",
      }),
    );
    return leader;
  });

test.skipIf(process.platform !== "linux")(
  "a check of a Run is refused, naming the leftover of that Run that survives its one end, which is announced first",
  () =>
    runEffect(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const events: string[] = [];
        const { state, notes, checks } = yield* worldWith({
          kill: (_target, name) => void events.push(`kill ${name}`),
        });
        const leader = yield* survivingLeftover(state, notes);

        const refused = yield* Effect.scoped(
          checks.run(check, { executable: held, argv: [notes], cwd: notes }, (line) =>
            Effect.sync(() => void events.push(line)),
          ),
        ).pipe(Effect.flip, Effect.timeout("15 seconds"));

        expect(refused._tag).toBe("CheckRefused");
        const why = refused._tag === "CheckRefused" ? refused.why : "";
        expect(why).toContain("check held (pass gate) of run-1");
        expect(why).toContain(`pid ${leader.pid}`);
        const announced = Option.getOrElse(
          Arr.findFirstIndex(events, (one) => pipe_(one, Str.includes(`pid ${leader.pid}`))),
          () => -1,
        );
        expect(announced).toBe(0);
        expect(events[0]).toContain("check held (pass gate) of run-1");
        expect(events[0]).toContain("host 4242");
        expect(events.indexOf("kill SIGTERM")).toBeGreaterThan(announced);
        expect(Str.split(Str.trim(yield* fs.readFileString(`${notes}/starts`)), "\n")).toHaveLength(
          1,
        );
      }),
    ),
  30_000,
);

test.skipIf(process.platform !== "linux")(
  "a verify of a Run whose leftover survives its end is refused, naming the check, its pid and how to try again",
  () =>
    runEffect(
      Effect.gen(function* () {
        const { root, state, notes, checks } = yield* worldWith({ kill: () => {} });
        const leader = yield* survivingLeftover(state, notes);
        const said: string[] = [];

        const refused = yield* collect(
          `${root}/evidence`,
          { ...check, executable: held, argv: [notes], cwd: notes },
          {
            stdout: () => Effect.void,
            stderr: () => Effect.void,
            said: (line) => Effect.sync(() => void said.push(line)),
          },
        ).pipe(
          Effect.provideService(CheckProcesses, checks),
          Effect.flip,
          Effect.timeout("15 seconds"),
        );

        expect(refused.why).toContain(`check held (pass gate) of run-1 (pid ${leader.pid})`);
        expect(refused.why).toContain("`collie cleanup --apply`");
        expect(refused.state).toBe(true);
        expect(said).toHaveLength(1);
        expect(said[0]).toContain(`(pid ${leader.pid})`);
      }),
    ),
  30_000,
);

test.skipIf(process.platform !== "linux")(
  "killing what a host ended takes no longer for many checks that refuse it than for one",
  () =>
    runEffect(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        let refusing = false;
        const { root, checks } = yield* worldWith({
          kill: (target, name) => {
            if (refusing) throw refusal();
            process.kill(target, name);
          },
        });
        const dirs = [`${root}/one`, `${root}/two`, `${root}/three`];
        for (const dir of dirs) {
          yield* fs.makeDirectory(dir);
          yield* runHeld(checks, dir);
          yield* startedIn(dir);
        }
        // Before the checks' own finalizers, which would be refused too.
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => (refusing = false)).pipe(
            Effect.andThen(Effect.forEach(dirs, (dir) => fs.writeFileString(`${dir}/release`, ""))),
            Effect.ignore,
          ),
        );

        refusing = true;
        expect(yield* checks.endAll).toHaveLength(3);
        // Time passes only by its sleeps, so a slow look at /proc under load counts for nothing.
        const clock = yield* TestClock.make();
        const slept: Clock.Clock = { ...clock, sleep: (duration) => clock.adjust(duration) };
        const began = clock.currentTimeMillisUnsafe();
        yield* checks.killEnded.pipe(Effect.provideService(Clock.Clock, slept));
        expect(clock.currentTimeMillisUnsafe() - began).toBeLessThan(2_000);
      }),
    ),
  30_000,
);

test(
  "ending a host's checks is done by its kill ceiling past its grace, however long their kill takes",
  () =>
    runEffect(
      Effect.gen(function* () {
        const killing = yield* Deferred.make<void>();
        const checks = {
          ...(yield* CheckProcesses),
          endAll: Effect.succeed([check]),
          killEnded: Deferred.succeed(killing, undefined).pipe(Effect.andThen(Effect.never)),
        };

        const began = yield* Clock.currentTimeMillis;
        const done = yield* endAllWithin(checks, Duration.millis(500), () => Effect.void).pipe(
          Effect.timeoutOption("6 seconds"),
        );
        expect(Option.isSome(done)).toBe(true);
        expect((yield* Clock.currentTimeMillis) - began).toBeLessThan(
          500 + Duration.toMillis(KILL_CEILING) + 400,
        );
        expect(yield* Deferred.isDone(killing)).toBe(true);
      }),
    ),
  10_000,
);

test("ending a host's checks waits past its grace for a kill still under way", () =>
  runEffect(
    Effect.gen(function* () {
      let killed = false;
      const checks = {
        ...(yield* CheckProcesses),
        endAll: Effect.succeed([check]),
        killEnded: Effect.sleep("1 second").pipe(
          Effect.andThen(Effect.sync(() => (killed = true))),
        ),
      };

      const began = yield* Clock.currentTimeMillis;
      yield* endAllWithin(checks, Duration.millis(500), () => Effect.void);
      expect(killed).toBe(true);
      expect((yield* Clock.currentTimeMillis) - began).toBeLessThan(1_400 + 400);
    }),
  ));

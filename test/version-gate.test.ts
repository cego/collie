// How Collie asks an installed harness about itself: the version gate before a launch, and
// the `--help` a launch reads its flags from. Its own file, because the gate's answers are
// kept for the process and must not reach the tests that gate a real harness.

import { expect, test } from "bun:test";
import { Clock, Effect, Fiber, FileSystem, Sink, Stream } from "effect";
import { ChildProcessSpawner } from "effect/process";
import { TestClock } from "effect/testing";
import { COMPACTION_PORTS } from "../src/compactors";
import { installedHelp } from "../src/harness";
import { runEffect } from "./support/effect";
import { until } from "./support/host";

/** Answers each `--version` with the next of `answers`, once `settled`, and counts them. */
function versionsAnswering(
  answers: Array<{ code: number; stdout: string }>,
  settled: Effect.Effect<void> = Effect.void,
) {
  const asked: unknown[][] = [];
  const spawner = ChildProcessSpawner.make((command) =>
    Effect.sync(() => {
      if (command._tag === "StandardCommand") asked.push([command.command, ...command.args]);
      const { code, stdout } = answers.shift() ?? { code: 1, stdout: "" };
      return ChildProcessSpawner.makeHandle({
        pid: ChildProcessSpawner.ProcessId(1),
        stdout: Stream.make(new TextEncoder().encode(stdout)),
        stderr: Stream.empty,
        all: Stream.empty,
        exitCode: settled.pipe(Effect.as(ChildProcessSpawner.ExitCode(code))),
        isRunning: Effect.succeed(false),
        kill: () => Effect.void,
        stdin: Sink.drain,
        getInputFd: () => Sink.drain,
        getOutputFd: () => Stream.empty,
        unref: Effect.never,
      });
    }),
  );
  return { asked, spawner };
}

test("a harness whose --version failed is asked again once the failure has expired", () =>
  runEffect(
    Effect.gen(function* () {
      const clock = yield* TestClock.make();
      const { asked, spawner } = versionsAnswering([
        { code: 1, stdout: "" },
        { code: 0, stdout: "99.0.0\n" },
      ]);
      const gate = COMPACTION_PORTS.opencode!.gate().pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
        Effect.provideService(Clock.Clock, clock),
      );

      expect((yield* Effect.flip(gate)).message).toBe("cannot ask opencode its version (exit 1)");
      // Kept a while, so a launch right behind a failed one does not probe again.
      expect((yield* Effect.flip(gate)).message).toBe("cannot ask opencode its version (exit 1)");
      expect(asked).toEqual([["opencode", "--version"]]);

      yield* clock.adjust("1 hour");
      yield* gate;
      expect(asked).toEqual([
        ["opencode", "--version"],
        ["opencode", "--version"],
      ]);
    }),
  ));

test("two launches of one harness at once share one --version probe", () =>
  runEffect(
    Effect.gen(function* () {
      // Answered later, so both launches are asking before either has an answer.
      const { asked, spawner } = versionsAnswering(
        [
          { code: 0, stdout: "99.0.0\n" },
          { code: 0, stdout: "99.0.0\n" },
        ],
        Effect.sleep("50 millis"),
      );
      const gate = COMPACTION_PORTS.pi!.gate().pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
      );
      yield* Effect.all([gate, gate], { concurrency: "unbounded" });
      expect(asked).toEqual([["pi", "--version"]]);
    }),
  ));

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

test("a harness whose --help never exits is stopped with the fiber that asked it", () =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const dir = yield* fs.makeTempDirectoryScoped({
        prefix: "collie-help-hangs-",
      });
      const harness = `${dir}/hangs`;
      yield* fs.writeFileString(harness, `#!/bin/sh\necho $$ > ${dir}/pid\nexec sleep 30\n`);
      yield* fs.chmod(harness, 0o755);

      const asking = yield* Effect.forkChild(installedHelp(harness));
      const pid = Number(
        yield* until(
          () => fs.readFileString(`${dir}/pid`).pipe(Effect.orElseSucceed(() => "")),
          (text) => text.endsWith("\n"),
        ),
      );
      yield* Effect.addFinalizer(() => Effect.sync(() => alive(pid) && process.kill(pid)));

      const stopped = yield* Fiber.interrupt(asking).pipe(Effect.timeoutOption("1 second"));
      expect(stopped._tag).toBe("Some");
      expect(alive(pid)).toBe(false);
    }),
  ));

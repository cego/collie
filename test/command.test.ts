import { expect, test } from "bun:test";
import { Effect, Fiber, FileSystem } from "effect";
import { exec } from "./support/command";
import { fastForward, runEffect } from "./support/effect";
import { until } from "./support/host";
import { alive } from "./support/sweep";

test("a fixture command drains both pipes, keeps its exit code, and inherits the current environment", () =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "collie-command-" });
      const out = "ø🙂".repeat(50_000);
      yield* fs.writeFileString(`${dir}/output`, out);
      const ran = yield* exec(
        [
          process.execPath,
          "-e",
          `await Bun.write(Bun.stdout, await Bun.file("output").text());
          await Bun.write(Bun.stderr, process.cwd() + "\\n" + process.env.COLLIE_TEST_ROOT);
          process.exit(7);`,
        ],
        { cwd: dir },
      );
      expect(ran).toEqual({
        exitCode: 7,
        stdout: out,
        stderr: `${dir}\n${Bun.env.COLLIE_TEST_ROOT}`,
      });
      const isolated = yield* exec(
        ["/bin/sh", "-c", 'printf "%s:%s" "$ONLY" "$COLLIE_TEST_ROOT"'],
        {
          env: { ONLY: "given" },
        },
      );
      expect(isolated.stdout).toBe("given:");
    }).pipe(Effect.scoped),
  ));

test(
  "interrupting a fixture command ends its child and the child's process group",
  () =>
    runEffect(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const dir = yield* fs.makeTempDirectoryScoped({ prefix: "collie-command-stop-" });
        const pids = `${dir}/pids`;
        const running = yield* Effect.forkScoped(
          exec([
            "/bin/sh",
            "-c",
            'sh -c \'trap "" TERM; touch "$1"; sleep 60\' sh "$1.ready" & trap "exit 0" TERM; printf "%s %s" "$$" "$!" > "$1"; wait',
            "sh",
            pids,
          ]),
        );
        yield* until(() => fs.exists(pids).pipe(Effect.orDie), Boolean);
        const [parent = 0, child = 0] = (yield* fs.readFileString(pids)).split(" ").map(Number);
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            try {
              process.kill(-parent, "SIGKILL");
            } catch {
              /* Already gone. */
            }
          }),
        );
        yield* until(() => fs.exists(`${pids}.ready`).pipe(Effect.orDie), Boolean);
        expect(alive(parent) && alive(child)).toBe(true);
        yield* Fiber.interrupt(running);
        yield* until(
          () => Effect.sync(() => alive(parent)),
          (live) => !live,
        );
        // A killed descendant can briefly be a zombie until its parent or init reaps it.
        const executing = () =>
          fs.readFileString(`/proc/${child}/stat`).pipe(
            Effect.map((stat) => !/\) Z /.test(stat)),
            Effect.orElseSucceed(() => false),
          );
        if (process.platform === "linux") {
          yield* until(executing, (live) => !live).pipe(Effect.timeout("1 second"));
          expect(yield* executing()).toBe(false);
        } else {
          yield* until(
            () => Effect.sync(() => alive(child)),
            (live) => !live,
          );
          expect(alive(child)).toBe(false);
        }
      }).pipe(Effect.scoped),
    ),
  10_000,
);

test("a fixture command keeps a nonzero exit when a background child holds its output pipes open", () =>
  runEffect(
    exec(["/bin/sh", "-c", "sleep 60 & exit 7"]).pipe(
      Effect.timeout("1 second"),
      Effect.map((ran) => expect(ran.exitCode).toBe(7)),
    ),
  ));

test("interrupting a fixture command escalates when its leader ignores SIGTERM", () =>
  runEffect(
    fastForward(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const dir = yield* fs.makeTempDirectoryScoped({ prefix: "collie-command-wedged-" });
        const pidFile = `${dir}/pid`;
        const running = yield* Effect.forkScoped(
          exec([
            "/bin/sh",
            "-c",
            'trap "" TERM; echo $$ > "$1.next"; mv "$1.next" "$1"; sleep 60',
            "sh",
            pidFile,
          ]),
        );
        yield* until(() => fs.exists(pidFile).pipe(Effect.orDie), Boolean);
        const pid = Number(yield* fs.readFileString(pidFile));
        expect(pid).toBeGreaterThan(0);
        expect(alive(pid)).toBe(true);
        yield* Fiber.interrupt(running);
        expect(alive(pid)).toBe(false);
      }).pipe(Effect.scoped),
    ),
  ));

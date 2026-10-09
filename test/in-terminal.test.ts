// A command in a terminal of its own: what it prints, what is typed at it, how it exits.

import { expect, test } from "bun:test";
import { Effect, Stream } from "effect";
import { inTerminal } from "../src/in-terminal";

test("a command started in a terminal has one, says what it prints, takes what is typed and exits with its code", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const asked = yield* inTerminal([
        "/bin/sh",
        "-c",
        '[ -t 0 ] && [ -t 1 ] && echo "a terminal"; printf "name? "; read name; echo "hi $name" >&2; exit 3',
      ]);
      let said = "";
      yield* asked.output.pipe(
        Stream.decodeText(),
        Stream.runForEach((chunk) =>
          Effect.gen(function* () {
            said += chunk;
            if (chunk.includes("name? ")) yield* asked.type("collie\n");
          }),
        ),
      );
      expect(said).toContain("a terminal");
      expect(said).toContain("hi collie");
      expect(yield* asked.exitCode).toBe(3);
    }).pipe(Effect.scoped),
  ));

test("a command still running when its scope closes is put down", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const exited = yield* Effect.scoped(
        Effect.map(inTerminal(["/bin/sleep", "30"]), (asked) => asked.exitCode),
      );
      expect(yield* exited).not.toBe(0);
    }),
  ));

test("the environment it is given is laid over this process's own", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const user = Bun.env.USER;
      const asked = yield* inTerminal(["/bin/sh", "-c", 'echo "$USER/$GIVEN"'], {
        env: { GIVEN: "given" },
      });
      const said = yield* asked.output.pipe(
        Stream.decodeText(),
        Stream.runFold(
          () => "",
          (all, chunk) => all + chunk,
        ),
      );
      expect(said).toContain(`${user}/given`);
    }).pipe(Effect.scoped),
  ));

test("the terminal closes with its scope even when Desktop owns the child", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      let terminal: Bun.Terminal | undefined;
      yield* inTerminal(["/bin/true"], {}, (start) =>
        Effect.acquireRelease(
          Effect.sync(() => {
            const child = start();
            terminal = child.terminal;
            return child;
          }),
          (child) => Effect.sync(() => child.kill()),
        ),
      ).pipe(
        Effect.flatMap((child) => child.exitCode),
        Effect.scoped,
      );
      expect(terminal?.closed).toBe(true);
    }),
  ));

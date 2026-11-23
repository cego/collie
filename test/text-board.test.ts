import * as Arr from "effect/Array";
import * as Str from "effect/String";
import { pipe as pipe_ } from "effect/Function";
import { expect, test } from "bun:test";
import { Clock, Effect, Exit, Fiber, FileSystem, Option } from "effect";
import { TestClock } from "effect/testing";
import { currentEnv } from "../src/env";
import { workspaceFlow } from "../src/flows";
import { Herdr } from "../src/herdr";
import { connect } from "../src/host";
import { PRUNE_FILE } from "../src/worktree";
import { recordsAt } from "../src/records";
import { until } from "./support/host";
import { proves } from "./support/world";

const CLEAR = "\u001b[2J\u001b[H";

const terminalStdin = Effect.acquireRelease(
  Effect.sync(() => {
    const stdin = process.stdin;
    const names = ["isTTY", "setRawMode", "on", "off", "resume", "pause"] as const;
    const own = new Map(
      Arr.map(names, (name) => [name, Object.getOwnPropertyDescriptor(stdin, name)]),
    );
    const rawModes: Array<boolean> = [];
    let listener: ((...args: Array<unknown>) => void) | null = null;
    const on = stdin.on.bind(stdin);
    const off = stdin.off.bind(stdin);
    Object.defineProperties(stdin, {
      isTTY: { value: true, configurable: true, writable: true },
      setRawMode: {
        value: (enabled: boolean) => {
          rawModes.push(enabled);
          return stdin;
        },
        configurable: true,
        writable: true,
      },
      on: {
        value: (event: string, handler: (...args: Array<unknown>) => void) => {
          if (event === "data") listener = handler;
          else on(event, handler);
          return stdin;
        },
        configurable: true,
        writable: true,
      },
      off: {
        value: (event: string, handler: (...args: Array<unknown>) => void) => {
          if (event === "data") {
            if (listener === handler) listener = null;
          } else off(event, handler);
          return stdin;
        },
        configurable: true,
        writable: true,
      },
      resume: { value: () => stdin, configurable: true, writable: true },
      pause: { value: () => stdin, configurable: true, writable: true },
    });
    return {
      rawModes,
      send: (key: string) => listener?.(Buffer.from(key)),
      restore: () => {
        for (const [name, descriptor] of own) {
          if (descriptor === undefined) Reflect.deleteProperty(stdin, name);
          else Object.defineProperty(stdin, name, descriptor);
        }
      },
    };
  }),
  (stub) => Effect.sync(stub.restore),
);

const capturedStdout = Effect.acquireRelease(
  Effect.sync(() => {
    const written: Array<string> = [];
    const write = process.stdout.write.bind(process.stdout);
    // WARNING: the board writes strings and reads nothing back, so the overload that takes an encoding or a callback is never the one reached here.
    process.stdout.write = ((chunk: string) => {
      written.push(String(chunk));
      return true;
    }) as typeof process.stdout.write;
    return { written, restore: () => (process.stdout.write = write) };
  }),
  (captured) => Effect.sync(captured.restore),
).pipe(Effect.map(({ written }) => written));

const drawn = (written: ReadonlyArray<string>) =>
  until(
    () => Effect.sync(() => Arr.join(written, "")),
    (text) => pipe_(text, Str.includes(CLEAR)),
  );

test("a board whose rebuild fails after a key hands the terminal back out of raw mode", () =>
  proves(
    "collie-text-board-fails-",
    (world) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const env = yield* currentEnv.pipe(Effect.orDie);
        const stdin = yield* terminalStdin;
        const written = yield* capturedStdout;
        const reported = `${world.state}/${PRUNE_FILE}`;
        let failing = false;
        const failingFs: FileSystem.FileSystem = {
          ...fs,
          readFileString: (path, encoding) =>
            failing && path === reported
              ? Effect.die(new Error("the reported worktrees went away"))
              : fs.readFileString(path, encoding),
        };

        const board = yield* Effect.forkChild(
          workspaceFlow(new Herdr(env), env).pipe(
            Effect.provideService(FileSystem.FileSystem, failingFs),
            Effect.provide(recordsAt(env.stateDir)),
          ),
        );
        yield* drawn(written);
        failing = true;
        stdin.send("l");
        const exit = yield* Fiber.await(board).pipe(Effect.timeoutOption("10 seconds"));

        expect(exit._tag === "Some" && Exit.isFailure(exit.value)).toBe(true);
        expect(stdin.rawModes).toEqual([true, false]);
      }),
    [],
  ));

test("a key is acted on as it arrives, not on the board's next tick", () =>
  proves(
    "collie-text-board-key-",
    () =>
      Effect.gen(function* () {
        const env = yield* currentEnv.pipe(Effect.orDie);
        const stdin = yield* terminalStdin;
        const written = yield* capturedStdout;
        yield* connect(env.stateDir).pipe(Effect.orDie);
        const clock = yield* TestClock.make();
        yield* clock.setTime(yield* Clock.currentTimeMillis);

        const board = yield* Effect.forkChild(
          workspaceFlow(new Herdr(env), env).pipe(
            Effect.provideService(Clock.Clock, clock),
            Effect.provide(recordsAt(env.stateDir)),
          ),
        );
        yield* drawn(written);
        stdin.send("q");
        const code = yield* Fiber.join(board).pipe(Effect.timeoutOption("5 seconds"));

        expect(Option.getOrNull(code)).toBe(0);
      }),
    [],
  ));

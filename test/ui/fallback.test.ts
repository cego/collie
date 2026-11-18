import * as Arr from "effect/Array";
import * as Str from "effect/String";
import { pipe as pipe_ } from "effect/Function";
import { expect, test } from "bun:test";
import { ConfigProvider, Effect, Queue } from "effect";
import { connect } from "../../src/host";
import { recordsAt, recordsReadLayer } from "../../src/records";
import { currentEnv } from "../../src/env";
import { appState, workspaceFlow } from "../../src/flows";
import { Herdr } from "../../src/herdr";
import { followBoard } from "../../src/lifecycle";
import { COLLIE_TAB } from "../../src/naming";
import { scopeFor } from "../../src/registry";
import { focus } from "../support/focus";
import { stopHost, until } from "../support/host";
import { blockedAtItsPrompt, collie, proves } from "../support/world";

const printed = Effect.gen(function* () {
  const env = yield* currentEnv.pipe(Effect.orDie);
  const written: string[] = [];
  const write = process.stdout.write.bind(process.stdout);
  // WARNING: the board writes one string and reads nothing back, so the overload that takes an encoding or a callback is never the one reached here.
  process.stdout.write = ((chunk: string) => {
    written.push(String(chunk));
    return true;
  }) as typeof process.stdout.write;
  const code = yield* Effect.ensuring(
    workspaceFlow(new Herdr(env), env).pipe(Effect.provide(recordsAt(env.stateDir))),
    Effect.sync(() => {
      process.stdout.write = write;
    }),
  );
  return { code, board: Arr.join(written, ""), env };
});

test("with no terminal the tab prints the text board and ends", () =>
  proves(
    "collie-fallback-",
    (world) =>
      Effect.gen(function* () {
        const { code, board, env } = yield* printed;
        yield* stopHost(world.state);
        expect(code).toBe(0);
        expect(board).toContain(`${COLLIE_TAB} — ${Str.split(env.cwd, "/").at(-1)}`);
        expect(board).toContain("no terminal on this pane");
        expect(board).toContain("p run a workflow");
      }),
    [],
  ));

test("the text board says the host could not be read, rather than that nothing needs you", () =>
  proves(
    "collie-fallback-no-host-",
    () =>
      Effect.gen(function* () {
        const { board } = yield* printed.pipe(
          Effect.provide(
            ConfigProvider.layerAdd(ConfigProvider.fromUnknown({ COLLIE_HOST: "/bin/false" }), {
              asPrimary: true,
            }),
          ),
        );
        expect(board).toContain("the workflow host has not sent its board");
      }),
    [],
  ));

test("the text board shows an agent waiting at its own prompt as a Task that needs you", () =>
  proves(
    "collie-fallback-stalled-",
    (world, core) =>
      Effect.gen(function* () {
        const started = yield* collie(world, [
          "run",
          "start",
          "agent",
          "--input",
          "target=worktree",
          "--input",
          `cwd=${world.project}`,
          "--input",
          "skip=false",
        ]);
        expect(started.envelope.ok).toBe(true);
        yield* blockedAtItsPrompt(core);
        const shown = yield* until(
          () => printed.pipe(Effect.map(({ board }) => board)),
          (board) => pipe_(board, Str.includes("Waiting for you in")),
        );
        yield* stopHost(world.state);
        expect(shown).toContain("Needs you");
        expect(shown).toMatch(/Waiting for you in \S+'s pane\./);
      }),
    ["agent.workflow.ts", "notes.md"],
  ));

test("the Home draws the host's board and follows it as it changes", () =>
  proves(
    "collie-home-follows-",
    (world) =>
      Effect.gen(function* () {
        expect(
          (yield* collie(world, ["run", "start", "plain", "--input", "note=hi"])).envelope.ok,
        ).toBe(true);
        yield* Effect.scoped(
          Effect.gen(function* () {
            const env = yield* currentEnv.pipe(Effect.orDie);
            const changes = yield* Queue.unbounded<void>();
            let notifications = 0;
            const app = appState(
              {
                herdr: new Herdr(env),
                ...scopeFor(env.cwd),
                stateDir: env.stateDir,
                userDir: env.userDir,
                pluginRoot: env.pluginRoot,
                tasksOf: yield* followBoard(env, () => {
                  notifications++;
                  Queue.offerUnsafe(changes, undefined);
                }),
              },
              env,
            );
            const before = yield* app.load(focus());
            expect(Arr.map(before.tasks, (task) => task.name)).toEqual(["Hi"]);
            const changed = Effect.gen(function* () {
              yield* Queue.take(changes);
              return yield* app.load(focus());
            }).pipe(Effect.timeout("10 seconds"));
            yield* changed;
            const beforeChange = notifications;

            yield* (yield* connect(world.state))
              .dispose({
                runId: before.tasks[0]!.run,
                kind: "merged",
                ref: "",
                note: null,
                request: "merged-1",
              })
              .pipe(Effect.orDie);
            const after = yield* changed.pipe(
              Effect.repeat({
                until: (state) => state.tasks[0]?.disposition === "merged",
                times: 50,
              }),
            );
            expect(after.tasks[0]?.disposition).toBe("merged");
            expect(notifications).toBeGreaterThan(beforeChange);

            const beforeDisconnect = notifications;
            yield* stopHost(world.state);
            const away = yield* changed.pipe(
              Effect.repeat({
                until: (state) => state.note !== null,
                times: 100,
              }),
            );
            expect(away.note).toContain("reconnecting to the workflow host");
            expect(away.tasks[0]?.disposition).toBe("merged");
            expect(notifications).toBeGreaterThan(beforeDisconnect);
            const moved = yield* app.load(focus({ selected: away.tasks[0]!.id }));
            expect(moved.note).toBe(away.note);
            const beforeReconnect = notifications;
            const reconnected = yield* changed.pipe(
              Effect.repeat({ until: (state) => state.note === null, times: 100 }),
            );
            expect(reconnected.tasks[0]?.disposition).toBe("merged");
            expect(notifications).toBeGreaterThan(beforeReconnect);
          }).pipe(Effect.provide(recordsReadLayer(world.state))),
        );
        yield* stopHost(world.state);
      }),
    ["plain.workflow.ts"],
  ));

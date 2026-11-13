import * as Arr from "effect/Array";
import * as Str from "effect/String";
import { pipe as pipe_ } from "effect/Function";
import { expect, test } from "bun:test";
import { ConfigProvider, Effect, Queue } from "effect";
import { recordDisposition } from "../../src/disposition";
import { currentEnv } from "../../src/env";
import { appState, workspaceFlow } from "../../src/flows";
import { Herdr } from "../../src/herdr";
import { followBoard } from "../../src/lifecycle";
import { COLLIE_TAB } from "../../src/naming";
import { scopeFor } from "../../src/registry";
import { focus } from "../support/focus";
import { stopHost, until } from "../support/host";
import { collie, proves } from "../support/world";

/** The text board, as a pane with no terminal prints it, from the host this world runs. */
const printed = Effect.gen(function* () {
  const env = yield* currentEnv.pipe(Effect.orDie);
  const written: string[] = [];
  const write = process.stdout.write.bind(process.stdout);
  // SAFETY: the board writes one string and reads nothing back, so the overload
  // that takes an encoding or a callback is never the one reached here.
  process.stdout.write = ((chunk: string) => {
    written.push(String(chunk));
    return true;
  }) as typeof process.stdout.write;
  const code = yield* Effect.ensuring(
    workspaceFlow(new Herdr(env), env),
    Effect.sync(() => {
      process.stdout.write = write;
    }),
  );
  return { code, board: Arr.join(written, ""), env };
});

/**
 * A pane that cannot render must still be readable. `bun test` has no terminal, which is
 * exactly the condition — so this is the fallback under its own reason rather than a
 * simulated one, and the renderer is never asked to start.
 */
test(
  "with no terminal the tab prints the text board and ends",
  () =>
    proves(
      "collie-fallback-",
      (world) =>
        Effect.gen(function* () {
          const { code, board, env } = yield* printed;
          yield* stopHost(world.state);
          expect(code).toBe(0);
          expect(board).toContain(`${COLLIE_TAB} — ${Str.split(env.cwd, "/").at(-1)}`);
          // The reason is on screen too: a pane that fell back says why it did.
          expect(board).toContain("no terminal on this pane");
          expect(board).toContain("p run a workflow");
        }),
      [],
    ),
  60_000,
);

test(
  "the text board says the host could not be read, rather than that nothing needs you",
  () =>
    proves(
      "collie-fallback-no-host-",
      () =>
        Effect.gen(function* () {
          // A host too broken to start.
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
    ),
  60_000,
);

test(
  "the text board shows an agent waiting at its own prompt as a Task that needs you",
  () =>
    proves(
      "collie-fallback-stalled-",
      (world) =>
        Effect.gen(function* () {
          // The host inherits this from the client that starts it, and so does its herdr.
          const blocked = { FAKE_HERDR_AGENT_STATUS: "blocked" };
          const started = yield* collie(
            world,
            [
              "run",
              "start",
              "agent",
              "--input",
              "target=worktree",
              "--input",
              `cwd=${world.project}`,
              "--input",
              "skip=false",
            ],
            blocked,
          );
          expect(started.envelope.ok).toBe(true);
          const shown = yield* until(
            () => printed.pipe(Effect.map(({ board }) => board)),
            (board) => pipe_(board, Str.includes("Waiting for you in")),
          );
          yield* stopHost(world.state);
          expect(shown).toContain("Needs you");
          expect(shown).toMatch(/Waiting for you in \S+'s pane\./);
        }),
      ["agent.workflow.ts", "notes.md"],
    ),
  120_000,
);

test(
  "the Home draws the host's board and follows it as it changes",
  () =>
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
                  ...scopeFor(env, env.cwd),
                  stateDir: env.stateDir,
                  userDir: env.userDir,
                  paneId: env.paneId,
                  pluginRoot: env.pluginRoot,
                  tasksOf: yield* followBoard(env, () => {
                    notifications++;
                    Queue.offerUnsafe(changes, undefined);
                  }),
                },
                env,
              );
              const before = yield* app.load(focus());
              expect(Arr.map(before.tasks, (task) => task.name)).toEqual(["Plain"]);
              // Reading a subscription's latest value is not what drives it. Each next
              // read below happens only after the host follower says something changed.
              const changed = Effect.gen(function* () {
                yield* Queue.take(changes);
                return yield* app.load(focus());
              }).pipe(Effect.timeout("10 seconds"));
              yield* changed;
              const beforeChange = notifications;

              yield* recordDisposition(`${world.state}/runs/${before.tasks[0]!.run}`, {
                kind: "merged",
                ref: "",
                at: "2026-10-01T12:00:00Z",
                by: "human",
                note: null,
              }).pipe(Effect.orDie);
              const after = yield* changed.pipe(
                Effect.repeat({
                  until: (state) => state.tasks[0]?.disposition === "merged",
                  times: 50,
                }),
              );
              expect(after.tasks[0]?.disposition).toBe("merged");
              expect(notifications).toBeGreaterThan(beforeChange);

              // A host gone away is said, and the cards it last sent are not passed off as live.
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
              // Moving the cursor reads nothing, and says what the last read said.
              const moved = yield* app.load(focus({ selected: away.tasks[0]!.id }));
              expect(moved.note).toBe(away.note);
              const beforeReconnect = notifications;
              const reconnected = yield* changed.pipe(
                Effect.repeat({ until: (state) => state.note === null, times: 100 }),
              );
              expect(reconnected.tasks[0]?.disposition).toBe("merged");
              expect(notifications).toBeGreaterThan(beforeReconnect);
            }),
          );
          yield* stopHost(world.state);
        }),
      ["plain.workflow.ts"],
    ),
  120_000,
);

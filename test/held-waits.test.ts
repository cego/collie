// A Hold or Stop an operator sets through `collie run` ends the wait a Run is in. The host
// here is a real one over a fake herdr.

import { expect, test } from "bun:test";
import { Effect, FileSystem, Schema } from "effect";
import { connect } from "../src/host";
import { stopHost, until } from "./support/host";
import { collie, proves, type World } from "./support/world";

const encode = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

/** The world's host, started from this process with `set` in its environment. */
const hostWith = Effect.fn("test.hostWith")(function* (
  world: World,
  set: Readonly<Record<string, string>>,
) {
  const all = { ...set, HERDR_PLUGIN_STATE_DIR: world.state, COLLIE_USER_DIR: world.config };
  yield* Effect.acquireRelease(
    Effect.sync(() => {
      const before = Object.fromEntries(Object.keys(all).map((key) => [key, Bun.env[key]]));
      Object.assign(Bun.env, all);
      return before;
    }),
    (before) =>
      Effect.sync(() => {
        for (const [key, value] of Object.entries(before))
          if (value === undefined) delete Bun.env[key];
          else Bun.env[key] = value;
      }),
  );
  return yield* connect(world.state).pipe(Effect.orDie);
});

const suspended = (client: Effect.Success<ReturnType<typeof hostWith>>, runId: string) =>
  until(
    () => client.status({ runId }).pipe(Effect.orDie),
    (status) => status.status === "suspended",
  );

test(
  "a stop set through collie run stop ends a reused agent's wait at its boundary, and types nothing",
  () =>
    proves(
      "collie-stop-boundary-",
      (world) =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const status = `${world.home}/agent-status`;
          const outputs = `${world.home}/outputs.json`;
          // The first operation's Output, and the agent still working after it.
          yield* fs.writeFileString(
            outputs,
            encode([
              { writes: [{ path: status, text: "working\n" }], output: { verdict: "clean" } },
            ]),
          );
          const client = yield* hostWith(world, {
            FAKE_HERDR_OUTPUTS: outputs,
            FAKE_HERDR_AGENT_STATUS_FILE: status,
          });
          const { runId } = yield* client
            .start({
              project: world.project,
              id: "reuses",
              request: "start",
              input: { work: "it" },
            })
            .pipe(Effect.orDie);
          const log = `${world.state}/agents/${runId}/agents.log`;
          yield* until(
            () => fs.readFileString(log).pipe(Effect.orElseSucceed(() => "")),
            (text) => text.includes("second-step waits for its turn to end"),
          );

          const stopped = yield* collie(world, ["run", "stop", runId]);
          expect(stopped.envelope.ok).toBe(true);
          yield* suspended(client, runId);
          const said = yield* fs.readFileString(log);
          const calls = yield* fs.readFileString(Bun.env.FAKE_HERDR_LOG ?? "");
          yield* stopHost(world.state);
          expect(said).not.toContain("its turn ended");
          expect(calls).not.toContain("second-step");
        }).pipe(Effect.orDie),
      ["reuses.workflow.ts"],
    ),
  120_000,
);

test(
  "a hold set through collie run hold ends a Run's wait on its review",
  () =>
    proves(
      "collie-hold-review-",
      (world) =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const client = yield* hostWith(world, {});
          const { runId } = yield* client
            .start({
              project: world.project,
              id: "awaits-review",
              request: "start",
              input: {
                mr: "https://gitlab.example.com/group/app/-/merge_requests/1",
                cwd: world.project,
              },
            })
            .pipe(Effect.orDie);
          // Unreadable, so the wait goes on and says so on the card.
          yield* until(
            () =>
              fs.exists(`${world.state}/awaiting.${runId}`).pipe(Effect.orElseSucceed(() => false)),
            (waiting) => waiting,
          );

          const held = yield* collie(world, ["run", "hold", runId]);
          expect(held.envelope.ok).toBe(true);
          yield* suspended(client, runId);
          const waiting = yield* fs.exists(`${world.state}/awaiting.${runId}`);
          yield* stopHost(world.state);
          expect(waiting).toBe(false);
        }).pipe(Effect.orDie),
      ["awaits-review.workflow.ts"],
    ),
  120_000,
);

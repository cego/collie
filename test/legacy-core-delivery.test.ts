import { expect, test } from "bun:test";
import { Effect } from "effect";
import { Herdr } from "../src/herdr";
import { connect } from "../src/host";
import { recordLaunch } from "../src/launches";
import { registerAgent } from "../src/registry";
import { hosted, hostedRun } from "./support/hosted";
import { recordsAt } from "./support/records";

for (const collision of [false, true]) {
  test(`a legacy launch cannot deliver to a core terminal that reuses its agent name (terminal id reused: ${collision})`, () =>
    hosted("collie-legacy-core-delivery-", ({ world, env }) =>
      Effect.gen(function* () {
        const run = yield* hostedRun(world, "keep old delivery identities historical");
        const agent = "legacy-implementer";
        const liveId = yield* new Herdr(env).agentLaunch({
          name: agent,
          argv: ["claude"],
          cwd: world.project,
          env: {},
          labels: { run: run.id },
        });
        const terminalId = collision ? liveId : "old-herdr-terminal";
        yield* Effect.gen(function* () {
          yield* registerAgent(
            { session: "/old/herdr.sock", workspaceId: "w1", cwd: world.project },
            {
              role: "implementer",
              agent,
              paneId: "1-9",
              workspaceId: "w1",
              runId: run.id,
              workflow: "proof",
              at: "2026-09-09T09:00:00Z",
              incarnation: { terminalId, agentSession: null },
            },
          );
          yield* recordLaunch({
            agent,
            output: `${run.dir}/build.json`,
            reused: false,
            runId: run.id,
            operation: "build",
            role: "implementer",
            workflow: "proof",
            harness: "claude",
            terminalId,
          });
        }).pipe(Effect.provide(recordsAt(world.state)));
        const client = yield* connect(world.state);
        const result = yield* client.steer({
          runId: run.id,
          agent,
          text: "This belongs only to the old Herdr incarnation.",
          request: "legacy-delivery",
        });
        expect(result.delivered).toBe(false);
      }),
    ));
}

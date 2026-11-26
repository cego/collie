import { expect, test } from "bun:test";
import { Effect } from "effect";
import { Herdr } from "../src/herdr";
import { connect } from "../src/host";
import { registerAgent } from "../src/registry";
import { hosted, hostedRun } from "./support/hosted";
import { recordsAt } from "./support/records";

test("a legacy registration cannot focus a core terminal that reuses its agent name", () =>
  hosted("collie-legacy-core-focus-", ({ world, env }) =>
    Effect.gen(function* () {
      const run = yield* hostedRun(world, "keep old terminal identities historical");
      const name = "legacy-implementer";
      const liveId = yield* new Herdr(env).agentLaunch({
        name,
        argv: ["claude"],
        cwd: world.project,
        env: {},
        labels: { run: run.id },
      });
      yield* registerAgent(
        { session: "/old/herdr.sock", workspaceId: "w1", cwd: world.project },
        {
          role: "implementer",
          agent: name,
          paneId: liveId,
          workspaceId: "w1",
          runId: run.id,
          workflow: "proof",
          at: "2026-09-09T09:00:00Z",
          incarnation: { terminalId: liveId, agentSession: null },
        },
      ).pipe(Effect.provide(recordsAt(world.state)));
      const client = yield* connect(world.state);
      const result = yield* client
        .focus({ runId: run.id, request: "legacy-focus" })
        .pipe(Effect.result);
      expect(result).toMatchObject({
        _tag: "Failure",
        failure: { _tag: "HostRefused", reason: `${run.id} has no live agent on core` },
      });
    }),
  ));

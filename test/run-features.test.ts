import { Effect } from "effect";
import { expect, test } from "bun:test";
import { setSetting } from "../src/config";
import { connect } from "../src/host";
import { isSettled } from "../src/lifecycle";
import { featuresOf } from "../src/run-features";
import { hosted } from "./support/hosted";
import { until } from "./support/host";
import { hostRecords } from "./support/records";

test("a Run started now, and one started from it, record that their follow-up rounds get a delta, their findings ledger ids and their marked checks run before review", () =>
  hosted("hw-features-", ({ world }) =>
    Effect.gen(function* () {
      const client = yield* connect(world.state).pipe(Effect.orDie);
      const started = yield* client
        .start({
          project: world.project,
          id: "hello",
          request: "features",
          input: { name: "features" },
        })
        .pipe(Effect.orDie);
      const child = yield* client
        .start({
          project: world.project,
          id: "hello",
          request: "features-child",
          input: { name: "" },
          parent: started.runId,
        })
        .pipe(Effect.orDie);
      for (const runId of [started.runId, child.runId]) {
        expect(yield* hostRecords(world.state, featuresOf(runId))).toEqual({
          review_delta: true,
          findings_ledger: true,
          inline_plan: false,
          agent_sessions: "run",
          before_review: true,
        });
        yield* until(
          () => client.run({ runId }).pipe(Effect.orDie),
          (view) => view !== null && isSettled(view),
        );
      }
    }),
  ));

test("a Run started while inline_plan is on records that it plans, and keeps it once the setting is off", () =>
  hosted("hw-features-plan-", ({ world }) =>
    Effect.gen(function* () {
      yield* setSetting(world.config, "inline_plan", "on", "2026-11-18T00:00:00.000Z");
      const client = yield* connect(world.state).pipe(Effect.orDie);
      const started = yield* client
        .start({ project: world.project, id: "hello", request: "plans", input: { name: "" } })
        .pipe(Effect.orDie);
      yield* setSetting(world.config, "inline_plan", "off", "2026-11-18T00:00:01.000Z");
      expect(yield* hostRecords(world.state, featuresOf(started.runId))).toMatchObject({
        inline_plan: true,
      });
      yield* until(
        () => client.run({ runId: started.runId }).pipe(Effect.orDie),
        (view) => view !== null && isSettled(view),
      );
    }),
  ));

test("a Run started under agent_sessions: ticket records it, and keeps it once the setting changes", () =>
  hosted("hw-features-sessions-", ({ world }) =>
    Effect.gen(function* () {
      yield* setSetting(world.config, "agent_sessions", "ticket", "2026-11-20T00:00:00.000Z");
      const client = yield* connect(world.state).pipe(Effect.orDie);
      const started = yield* client
        .start({ project: world.project, id: "hello", request: "sessions", input: { name: "" } })
        .pipe(Effect.orDie);
      yield* setSetting(world.config, "agent_sessions", "run", "2026-11-20T00:00:01.000Z");
      expect(yield* hostRecords(world.state, featuresOf(started.runId))).toMatchObject({
        agent_sessions: "ticket",
      });
      yield* until(
        () => client.run({ runId: started.runId }).pipe(Effect.orDie),
        (view) => view !== null && isSettled(view),
      );
    }),
  ));

import { expect, test } from "bun:test";
import { Crypto, Effect } from "effect";
import { connect } from "../src/host";
import { isSettled } from "../src/lifecycle";
import { toolNamed } from "../src/tools";
import { until } from "./support/host";
import { hosted, hostedRun } from "./support/hosted";

test(
  "local answers preserve native answer content, offers and Flow after mutations",
  () =>
    hosted(
      "collie-local-answer-",
      ({ world, env }) =>
        Effect.gen(function* () {
          const client = yield* connect(world.state);
          const started = yield* client.start({
            project: world.project,
            id: "offered",
            request: yield* (yield* Crypto.Crypto).randomUUIDv4,
            input: { note: "compare answers" },
          });
          const runId = started.runId;
          yield* until(
            () => client.run({ runId }),
            (view) => view !== null && isSettled(view),
          );
          const local = yield* client.read({ tool: "collie_run", input: { run: runId } });
          const native = yield* toolNamed("collie_run")!.call(env, { run: runId });
          expect(local).toBe(native);
          expect(local).toContain("grade-it");
          expect(local).toContain("look-again");
          expect(local).toContain("### Flow");

          const waiting = yield* hostedRun(world, "control freshness");
          for (const set of [true, false]) {
            yield* client.control({
              runId: waiting.id,
              control: "hold",
              set,
              request: `hold-${set}`,
            });
            const read = yield* client.read({ tool: "collie_run", input: { run: waiting.id } });
            expect(read).toBe(yield* toolNamed("collie_run")!.call(env, { run: waiting.id }));
          }
          expect(yield* client.read({ tool: "collie_run", input: { run: "absent" } })).toContain(
            'No Run "absent"',
          );
          expect(yield* client.read({ tool: "collie_run", input: { run: 3 } })).toContain(
            "InvalidInput",
          );
        }),
      ["offered.workflow.ts", "graded.workflow.ts", "proof.workflow.ts", "helper.ts", "notes.md"],
    ),
  120_000,
);

// A workflow is one default-exported definition: what it is, what it takes and gives,
// and what it does. These read it the ways a front door does — found, described and run.

import { expect, test } from "bun:test";
import { Effect } from "effect";
import { connect } from "../src/host";
import { savedModules } from "../src/discovery";
import { stopHost, until } from "./support/host";
import { proves } from "./support/world";

const MODULES = ["hello.workflow.ts", "quiet.workflow.ts", "branches.workflow.ts"];

test(
  "a default-exported definition is found, described with its defaults, and run",
  () =>
    proves(
      "collie-definition-",
      (world) =>
        Effect.gen(function* () {
          const found = yield* savedModules({ pluginRoot: world.install, cwd: world.project });
          expect(found.problems).toEqual([]);
          const byId = new Map(found.entries.map((one) => [one.id, one]));
          expect(byId.get("hello")?.title).toBe("Say hello");
          expect(byId.get("hello")?.inputs.map((one) => [one.name, one.required])).toEqual([
            ["name", true],
          ]);
          // Nothing but an id and what it does: the title is the id, and it takes nothing.
          expect(byId.get("quiet")?.title).toBe("quiet");
          expect(byId.get("quiet")?.description).toBe("");
          expect(byId.get("quiet")?.inputs).toEqual([]);

          const client = yield* connect(world.state).pipe(Effect.orDie);
          const hello = yield* client
            .start({ project: world.project, id: "hello", request: "req-1", input: { name: "mk" } })
            .pipe(Effect.orDie);
          const said = yield* until(
            () => client.run({ runId: hello.runId }),
            (view) => view?.status.status === "complete",
          ).pipe(Effect.orDie);
          expect(said?.status).toEqual({ status: "complete", value: "hello mk, from hello" });

          const quiet = yield* client
            .start({ project: world.project, id: "quiet", request: "req-2", input: {} })
            .pipe(Effect.orDie);
          const done = yield* until(
            () => client.run({ runId: quiet.runId }),
            (view) => view?.status.status === "complete",
          ).pipe(Effect.orDie);
          expect(done?.status.status).toBe("complete");
          yield* stopHost(world.state);
        }),
      MODULES,
    ),
  300_000,
);

test(
  "a question is asked when the work reaches it, and only then",
  () =>
    proves(
      "collie-definition-ask-",
      (world) =>
        Effect.gen(function* () {
          const client = yield* connect(world.state).pipe(Effect.orDie);
          const start = (size: string, request: string) =>
            client
              .start({ project: world.project, id: "branches", request, input: { size } })
              .pipe(Effect.orDie);

          const small = yield* start("small", "req-1");
          const quick = yield* until(
            () => client.run({ runId: small.runId }),
            (view) => view?.status.status === "complete",
          ).pipe(Effect.orDie);
          expect(quick?.waiting).toEqual([]);
          expect(quick?.status).toEqual({ status: "complete", value: "quick" });

          const big = yield* start("big", "req-2");
          const asking = yield* until(
            () => client.run({ runId: big.runId }),
            (view) => (view?.waiting ?? []).length > 0,
          ).pipe(Effect.orDie);
          expect(asking?.waiting.map((one) => [one.name, one.options])).toEqual([
            ["approach", ["quick", "review-first"]],
          ]);
          yield* client
            .answer({
              runId: big.runId,
              decision: "approach",
              value: "review-first",
              request: "a-1",
            })
            .pipe(Effect.orDie);
          const answered = yield* until(
            () => client.run({ runId: big.runId }),
            (view) => view?.status.status === "complete",
          ).pipe(Effect.orDie);
          expect(answered?.status).toEqual({ status: "complete", value: "review-first" });
          yield* stopHost(world.state);
        }),
      MODULES,
    ),
  300_000,
);

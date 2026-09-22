// What a finished Run offers to do next, and what it takes to carry one out.
//
// The offers are the module's own declarations and the eligibility is the module's own
// code, so this exercises the whole path a card takes: what is listed, what starts when
// one is invoked, and every way an invocation is refused — an offer that has been edited
// away, one whose facts no longer hold, and arguments the child will not take. None of
// those may leave a Run behind.

import { expect, test } from "bun:test";
import { Effect, FileSystem, Schema } from "effect";
import { connect, type HostClient } from "../src/host";
import { stopHost, until } from "./support/native";
import { collie, proves, save, type World } from "./support/world";

/** The envelope's payload as text, for asking whether an offer is in it at all. */
const asText = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

const MODULES = ["offered.workflow.ts", "graded.workflow.ts", "capability.ts", "house.ts"] as const;

const projectOf = Effect.fn("ActionsTest.project")(function* (world: World) {
  const project = `${world.project}/work`;
  yield* save(`${project}/.herdr/workflows`, MODULES);
  return project;
});

/** A Run of the offering module, finished, which is when its offers are on the table. */
const finished = Effect.fn("ActionsTest.finished")(function* (client: HostClient, project: string) {
  const started = yield* client.start({
    project,
    id: "offered",
    request: "req-1",
    input: { note: "the diff" },
  });
  yield* until(
    () => client.run({ runId: started.runId }),
    (view) => view?.status.status === "complete",
  );
  return started.runId;
});

test(
  "a finished Run lists what its module offers, and invoking one starts it",
  () =>
    proves(
      "collie-actions-offer-",
      (world) =>
        Effect.gen(function* () {
          const project = yield* projectOf(world);
          const client = yield* connect(world.state).pipe(Effect.orDie);
          const runId = yield* finished(client, project).pipe(Effect.orDie);

          const offers = yield* client.offers({ runId }).pipe(Effect.orDie);
          expect(offers.map((one) => [one.id, one.primary, one.unavailable])).toEqual([
            ["grade-it", true, null],
            ["look-again", false, null],
          ]);
          // The arguments travel as a drawing, so a front door can ask for them.
          expect(offers[0]?.arguments).toMatchObject({ type: "object" });

          const started = yield* client
            .invoke({
              runId,
              offer: "grade-it",
              input: { note: "the diff", grade: "pass" },
              request: "act-1",
            })
            .pipe(Effect.orDie);
          const done = yield* until(
            () => client.run({ runId: started.runId }).pipe(Effect.orDie),
            (view) => view?.status.status === "complete",
          );
          // Its own Run, of the workflow the offer named, belonging to the one that offered it.
          expect(done?.workflow).toBe("graded");
          expect(done?.parent).toBe(runId);
          expect(done?.status).toEqual({ status: "complete", value: "strict:the diff/pass" });
          yield* stopHost(world.state);
        }),
      [],
    ),
  300_000,
);

test(
  "an offer the module no longer makes starts nothing, however recently it was listed",
  () =>
    proves(
      "collie-actions-stale-",
      (world) =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const project = yield* projectOf(world);
          const client = yield* connect(world.state).pipe(Effect.orDie);
          const runId = yield* finished(client, project).pipe(Effect.orDie);
          expect((yield* client.offers({ runId }).pipe(Effect.orDie)).map((one) => one.id)).toEqual(
            ["grade-it", "look-again"],
          );

          // The author edits the module: the action is gone, and the card a moment ago
          // is not authority for anything.
          const entry = `${project}/.herdr/workflows/offered.workflow.ts`;
          const source = yield* fs.readFileString(entry);
          yield* fs.writeFileString(
            entry,
            source.replace(/actions: \[[\s\S]*?\],\n/, "actions: [],\n"),
          );

          expect((yield* client.offers({ runId }).pipe(Effect.orDie)).map((one) => one.id)).toEqual(
            ["look-again"],
          );
          const refused = yield* client
            .invoke({ runId, offer: "grade-it", input: {}, request: "act-1" })
            .pipe(Effect.result);
          expect(refused._tag).toBe("Failure");
          // Nothing was started: the Run that offered it is still the only one here.
          expect((yield* client.runs({ task: null }).pipe(Effect.orDie)).length).toBe(1);
          yield* stopHost(world.state);
        }),
      [],
    ),
  300_000,
);

test(
  "arguments the child will not take are refused, and nothing is created",
  () =>
    proves(
      "collie-actions-invalid-",
      (world) =>
        Effect.gen(function* () {
          const project = yield* projectOf(world);
          const client = yield* connect(world.state).pipe(Effect.orDie);
          const runId = yield* finished(client, project).pipe(Effect.orDie);

          const refused = yield* client
            .invoke({
              runId,
              offer: "grade-it",
              input: { note: "the diff", grade: "maybe" },
              request: "act-1",
            })
            .pipe(Effect.result);
          expect(refused._tag).toBe("Failure");
          expect((yield* client.runs({ task: null }).pipe(Effect.orDie)).length).toBe(1);

          // And an offer nobody declared is refused the same way.
          const unknown = yield* client
            .invoke({ runId, offer: "make-coffee", input: {}, request: "act-2" })
            .pipe(Effect.result);
          expect(unknown._tag).toBe("Failure");
          expect((yield* client.runs({ task: null }).pipe(Effect.orDie)).length).toBe(1);
          yield* stopHost(world.state);
        }),
      [],
    ),
  300_000,
);

test(
  "the command line lists and invokes the same offers the host makes",
  () =>
    proves(
      "collie-actions-cli-",
      (world) =>
        Effect.gen(function* () {
          const project = yield* projectOf(world);
          const client = yield* connect(world.state).pipe(Effect.orDie);
          const runId = yield* finished(client, project).pipe(Effect.orDie);

          const listed = yield* collie({ ...world, project }, ["run", "actions", runId]);
          expect(listed.envelope.ok).toBe(true);
          expect(asText(listed.envelope.data ?? [])).toContain("grade-it");

          const done = yield* collie({ ...world, project }, [
            "run",
            "action",
            runId,
            "grade-it",
            "--input",
            "note=the diff",
            "--input",
            "grade=pass",
          ]);
          expect(done.envelope.ok).toBe(true);
          const runs = yield* client.runs({ task: null }).pipe(Effect.orDie);
          expect(runs.map((one) => one.workflow).sort()).toEqual(["graded", "offered"]);

          // And the same refusal from this door: an offer nobody declares starts nothing.
          const refused = yield* collie({ ...world, project }, [
            "run",
            "action",
            runId,
            "make-coffee",
          ]);
          expect(refused.envelope.ok).toBe(false);
          expect((yield* client.runs({ task: null }).pipe(Effect.orDie)).length).toBe(2);
          yield* stopHost(world.state);
        }),
      [],
    ),
  300_000,
);

// A child Run is reached under the execution it was recorded with, not one derived again.
//
// A release that derives a workflow's execution id differently from its payload (Effect
// 4.0.1 does) must not run a finished child a second time, or orphan a running one, when it
// resumes a parent an earlier release started. Each test leaves the children as such a
// release would have: with the host stopped, every child's row names an execution the
// payload no longer derives.

import { expect, test } from "bun:test";
import * as SqliteClient from "@effect/sql-sqlite-bun/SqliteClient";
import { Effect, Layer } from "effect";
import * as Reactivity from "effect/unstable/reactivity/Reactivity";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import type { SqlError } from "effect/unstable/sql/SqlError";
import { connect } from "../src/host";
import { events, stopHost, until } from "./support/host";
import { proves, type World } from "./support/world";

const MODULES = ["resumes.workflow.ts", "paced.workflow.ts"] as const;

/** The host's database, written with the host stopped. */
const offline = <A>(world: World, write: Effect.Effect<A, SqlError, SqlClient.SqlClient>) =>
  stopHost(world.state).pipe(
    Effect.andThen(write),
    Effect.provide(
      SqliteClient.layer({ filename: `${world.state}/host.db` }).pipe(
        Layer.provideMerge(Reactivity.layer),
      ),
    ),
    Effect.orDie,
  );

/** Every child of `parent` admitted under an execution its payload no longer derives. */
const recordedAsBefore = (world: World, parent: string) =>
  offline(
    world,
    Effect.flatMap(
      SqlClient.SqlClient,
      (sql) => sql`UPDATE collie_runs SET execution = 'legacy-' || run WHERE parent = ${parent}`,
    ),
  );

/** The same, and not yet handed over, so the next host starts each child under it. */
const handedOverAsBefore = (world: World, parent: string) =>
  offline(
    world,
    Effect.flatMap(
      SqlClient.SqlClient,
      (sql) =>
        sql`UPDATE collie_runs SET execution = 'legacy-' || run, accepted = NULL WHERE parent = ${parent}`,
    ),
  );

/** Every execution the engine was asked to run for `runId`, read with the host stopped. */
const executionsOf = (world: World, runId: string) =>
  offline(
    world,
    Effect.flatMap(
      SqlClient.SqlClient,
      (sql) =>
        sql<{
          readonly entity_id: string;
        }>`SELECT DISTINCT entity_id FROM cluster_messages WHERE tag = 'run' AND payload LIKE ${`%"runId":"${runId}"%`}`,
    ),
  ).pipe(Effect.map((rows) => rows.map((row) => row.entity_id)));

/** What a paced child recorded doing its work, apart from oversight's lines. */
const ran = (world: World, runId: string) =>
  events(world.state, runId).pipe(
    Effect.map((lines) => lines.filter((line) => line.startsWith("ran "))),
  );

const parked = Effect.fn("ChildExecutionTest.parked")(function* (
  world: World,
  input: { readonly notes: string; readonly waits: string },
) {
  const client = yield* connect(world.state).pipe(Effect.orDie);
  const started = yield* client
    .start({ project: world.project, id: "resumes", request: "req-1", input })
    .pipe(Effect.orDie);
  yield* until(
    () => client.run({ runId: started.runId }).pipe(Effect.orDie),
    (view) => (view?.waiting ?? []).some((one) => one.name === "go"),
  );
  return started.runId;
});

const status = (world: World, runId: string, wanted: string) =>
  connect(world.state).pipe(
    Effect.orDie,
    Effect.flatMap((client) =>
      until(
        () => client.run({ runId }).pipe(Effect.orDie),
        (view) => view?.status.status === wanted,
      ),
    ),
  );

const answer = (world: World, runId: string, decision: string) =>
  connect(world.state).pipe(
    Effect.orDie,
    Effect.flatMap((client) =>
      client.answer({ runId, decision, value: "ok", request: `${runId}-${decision}` }),
    ),
    Effect.orDie,
  );

test(
  "a child that finished under its recorded execution is not run again when its parent resumes",
  () =>
    proves(
      "collie-child-finished-",
      (world) =>
        Effect.gen(function* () {
          const parent = yield* parked(world, { notes: "one", waits: "" });
          const child = `${parent}.pace-one`;
          yield* handedOverAsBefore(world, parent);
          yield* status(world, child, "complete");
          // A host of the new release, which derives another id from the same payload.
          yield* stopHost(world.state);

          yield* answer(world, parent, "go");
          const done = yield* status(world, parent, "complete");
          expect(done?.status).toEqual({ status: "complete", value: "paced one" });
          expect(yield* ran(world, child)).toEqual(["ran one"]);
          expect(yield* executionsOf(world, child)).toEqual([`legacy-${child}`]);
        }),
      MODULES,
    ),
  300_000,
);

test(
  "a child still suspended under its recorded execution finishes with its parent, once",
  () =>
    proves(
      "collie-child-suspended-",
      (world) =>
        Effect.gen(function* () {
          const parent = yield* parked(world, { notes: "one", waits: "one" });
          const child = `${parent}.pace-one`;
          yield* recordedAsBefore(world, parent);
          // The parent reaches its child, which parks on its own question and the parent
          // with it, as both would have under the earlier release.
          yield* answer(world, parent, "go");
          yield* until(
            () =>
              connect(world.state).pipe(
                Effect.orDie,
                Effect.flatMap((client) => client.run({ runId: child }).pipe(Effect.orDie)),
              ),
            (view) => (view?.waiting ?? []).some((one) => one.name === "release"),
          );
          yield* stopHost(world.state);

          yield* answer(world, child, "release");
          const done = yield* status(world, parent, "complete");
          expect(done?.status).toEqual({ status: "complete", value: "paced one" });
          expect((yield* status(world, child, "complete"))?.status.status).toBe("complete");
          expect(yield* ran(world, child)).toEqual(["ran one"]);
          expect(yield* executionsOf(world, child)).toEqual([`legacy-${child}`]);
        }),
      MODULES,
    ),
  300_000,
);

test(
  "two children collected concurrently under their recorded executions each run once",
  () =>
    proves(
      "collie-child-concurrent-",
      (world) =>
        Effect.gen(function* () {
          const parent = yield* parked(world, { notes: "one,two", waits: "" });
          yield* handedOverAsBefore(world, parent);
          for (const note of ["one", "two"])
            yield* status(world, `${parent}.pace-${note}`, "complete");
          yield* stopHost(world.state);

          yield* answer(world, parent, "go");
          const done = yield* status(world, parent, "complete");
          expect(done?.status).toEqual({ status: "complete", value: "paced one+paced two" });
          for (const note of ["one", "two"]) {
            expect(yield* ran(world, `${parent}.pace-${note}`)).toEqual([`ran ${note}`]);
            expect(yield* executionsOf(world, `${parent}.pace-${note}`)).toEqual([
              `legacy-${parent}.pace-${note}`,
            ]);
          }
        }),
      MODULES,
    ),
  300_000,
);

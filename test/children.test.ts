// A workflow made of other workflows, and the services two projects give them.
//
// The question this file exists for is whose implementation a piece of work gets. A
// module reaches a shared contract two ways — by importing it, where the file it was
// saved beside decides, and by starting another workflow by its public id, where the
// search path decides. Both have to follow the project the Run belongs to, and neither
// may reach into the other project running at the same time.
//
// The rest is what a child costs: input the child will not take makes no child, replaying
// a parent reuses the one it has, and a separate invocation is a separate Run.
//
// Real hosts, real SQLite, real projects — a service that is selected only in a map is
// not selected at all.

import { expect, test } from "bun:test";
import { Effect, FileSystem } from "effect";
import { connect } from "../src/host";
import { events, stopHost, until } from "./support/host";
import { proves, save, type World } from "./support/world";

/** The parent, the child, the contract they share, and which house provides it. */
const MODULES = [
  "reviewed.workflow.ts",
  "graded.workflow.ts",
  "capability.ts",
  "house.ts",
] as const;

const sorted = <A>(values: ReadonlyArray<A>) =>
  [...values].sort((one, other) => String(one).localeCompare(String(other)));

/** A project of its own, with the same modules saved in it and its own house. */
const projectOf = Effect.fn("ChildrenTest.project")(function* (
  world: World,
  name: string,
  house: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const project = `${world.project}/${name}`;
  const saved = `${project}/.collie/workflows`;
  yield* save(saved, MODULES);
  yield* fs
    .writeFileString(`${saved}/house.ts`, `export const HOUSE = "${house}";\n`)
    .pipe(Effect.orDie);
  return project;
});

test(
  "two projects grade the same notes with their own reviewer, parent and child alike",
  () =>
    proves(
      "collie-children-projects-",
      (world) =>
        Effect.gen(function* () {
          const strict = yield* projectOf(world, "strict-project", "strict");
          const lenient = yield* projectOf(world, "lenient-project", "lenient");
          const client = yield* connect(world.state).pipe(Effect.orDie);

          // Both at once, on one host and one database: the selection is the Run's, not
          // the host's, so neither project can be the reason the other got what it got.
          const started = yield* Effect.forEach(
            [
              { project: strict, request: "req-strict" },
              { project: lenient, request: "req-lenient" },
            ],
            (one) =>
              client.start({
                project: one.project,
                id: "reviewed",
                request: one.request,
                input: { notes: "n", grade: "pass" },
              }),
            { concurrency: "unbounded" },
          ).pipe(Effect.orDie);

          for (const run of started) {
            yield* until(
              () => client.run({ runId: run.runId }).pipe(Effect.orDie),
              (view) => (view?.waiting ?? []).some((one) => one.name === "sign-off"),
            );
            yield* client
              .answer({ runId: run.runId, decision: "sign-off", value: "ok", request: run.runId })
              .pipe(Effect.orDie);
          }

          const values = yield* Effect.forEach(started, (run) =>
            until(
              () => client.run({ runId: run.runId }).pipe(Effect.orDie),
              (view) => view?.status.status === "complete",
            ).pipe(Effect.map((view) => view?.status)),
          );
          // The house is in both halves: the parent's own reading of the contract and
          // the child's, which was selected in the parent's project rather than in the
          // host's most recent generation of "graded".
          expect(values).toEqual([
            { status: "complete", value: "strict:n+strict:n/pass+ok" },
            { status: "complete", value: "lenient:n+lenient:n/pass+ok" },
          ]);
          yield* stopHost(world.state);
        }),
      [],
    ),
  300_000,
);

test(
  "input the child will not take makes no child at all, and says so at the parent",
  () =>
    proves(
      "collie-children-invalid-",
      (world) =>
        Effect.gen(function* () {
          const project = yield* projectOf(world, "one-project", "strict");
          const client = yield* connect(world.state).pipe(Effect.orDie);
          // The parent's own field takes any string; the child's takes two of them, and
          // the child is what decides.
          const started = yield* client
            .start({
              project,
              id: "reviewed",
              request: "req-1",
              input: { notes: "n", grade: "maybe" },
            })
            .pipe(Effect.orDie);

          const view = yield* until(
            () => client.run({ runId: started.runId }).pipe(Effect.orDie),
            (one) => one?.status.status === "failed",
          );
          expect(view?.status).toMatchObject({
            status: "failed",
            reason: expect.stringContaining("grade"),
          });

          // Nothing was half-made: no row, no execution, and nothing the child recorded.
          const runs = yield* client.runs({ task: null }).pipe(Effect.orDie);
          expect(runs.map((one) => one.runId)).toEqual([started.runId]);
          expect(yield* events(world.state, `${started.runId}.grade-n`)).toEqual([]);
          yield* stopHost(world.state);
        }),
      [],
    ),
  300_000,
);

test(
  "replaying a parent reuses the children it admitted, and each invocation is its own Run",
  () =>
    proves(
      "collie-children-replay-",
      (world) =>
        Effect.gen(function* () {
          const project = yield* projectOf(world, "one-project", "strict");
          const client = yield* connect(world.state).pipe(Effect.orDie);
          const started = yield* client
            .start({
              project,
              id: "reviewed",
              request: "req-1",
              input: { notes: "one,two", grade: "pass" },
              task: "task-9",
            })
            .pipe(Effect.orDie);

          // The parent parks on its question with both children already admitted.
          yield* until(
            () => client.run({ runId: started.runId }).pipe(Effect.orDie),
            (view) => (view?.waiting ?? []).some((one) => one.name === "sign-off"),
          );
          const children = (yield* client.runs({ task: "task-9" }).pipe(Effect.orDie)).filter(
            (one) => one.parent === started.runId,
          );
          // One Run per invocation, each carrying what it belongs to and what it was given.
          expect(sorted(children.map((one) => one.runId))).toEqual([
            `${started.runId}.grade-one`,
            `${started.runId}.grade-two`,
          ]);
          expect(sorted(children.map((one) => one.input.note))).toEqual(["one", "two"]);
          expect(children.every((one) => one.workflow === "graded" && one.task === "task-9")).toBe(
            true,
          );

          // Answering replays the parent from the top: it asks for the same children
          // again, and the engine's idempotency hands back the executions it already has.
          yield* client
            .answer({
              runId: started.runId,
              decision: "sign-off",
              value: "ok",
              request: "answer-1",
            })
            .pipe(Effect.orDie);
          const done = yield* until(
            () => client.run({ runId: started.runId }).pipe(Effect.orDie),
            (view) => view?.status.status === "complete",
          );
          expect(done?.status).toEqual({
            status: "complete",
            value: "strict:one,two+strict:one/pass+strict:two/pass+ok",
          });
          for (const note of ["one", "two"]) {
            expect(yield* events(world.state, `${started.runId}.grade-${note}`)).toEqual([
              `graded strict:${note}/pass`,
            ]);
          }
          expect((yield* client.runs({ task: "task-9" }).pipe(Effect.orDie)).length).toBe(3);
          yield* stopHost(world.state);
        }),
      [],
    ),
  300_000,
);

test(
  "a hold reaches a parent that has children, and what it replays under it makes no more",
  () =>
    proves(
      "collie-children-held-",
      (world) =>
        Effect.gen(function* () {
          const project = yield* projectOf(world, "one-project", "strict");
          const runId = yield* Effect.scoped(
            Effect.gen(function* () {
              const client = yield* connect(world.state);
              const started = yield* client.start({
                project,
                id: "reviewed",
                request: "req-1",
                input: { notes: "a,b", grade: "pass" },
              });
              yield* until(
                () => client.run({ runId: started.runId }),
                // Parked, not only asking: an earlier answer is taken without a replay.
                (view) =>
                  view?.status.status === "suspended" &&
                  view.waiting.some((one) => one.name === "sign-off"),
              );
              yield* client.control({ runId: started.runId, control: "hold", set: true });
              return started.runId;
            }),
          ).pipe(Effect.orDie);

          // The client that started the parent and held it is gone. Neither the work nor
          // the control was its to take: they belong to the host.
          const client = yield* connect(world.state).pipe(Effect.orDie);
          expect((yield* client.run({ runId }).pipe(Effect.orDie))?.controls).toEqual(["hold"]);

          // Answering replays the parent, which parks at its hold instead of finishing.
          yield* client
            .answer({ runId, decision: "sign-off", value: "ok", request: "answer-1" })
            .pipe(Effect.orDie);
          yield* until(
            () => events(world.state, runId),
            (log) => log.includes("held"),
          );
          expect((yield* client.run({ runId }).pipe(Effect.orDie))?.status).toEqual({
            status: "suspended",
          });
          // Two replays later there are still two children, each having graded once.
          yield* client.control({ runId, control: "hold", set: false }).pipe(Effect.orDie);
          const done = yield* until(
            () => client.run({ runId }).pipe(Effect.orDie),
            (view) => view?.status.status === "complete",
          );
          expect(done?.status).toEqual({
            status: "complete",
            value: "strict:a,b+strict:a/pass+strict:b/pass+ok",
          });
          for (const note of ["a", "b"]) {
            expect(yield* events(world.state, `${runId}.grade-${note}`)).toEqual([
              `graded strict:${note}/pass`,
            ]);
          }
          expect(yield* client.runs({ task: null }).pipe(Effect.orDie)).toHaveLength(3);
          yield* stopHost(world.state);
        }),
      [],
    ),
  300_000,
);

test(
  "a project that overrides only the child changes the child, and leaves the import alone",
  () =>
    proves(
      "collie-children-bypass-",
      (world) =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          // The parent is nobody's override: it is found in the author's own directory,
          // and the contract it reads is the file saved beside it there.
          yield* save(world.user, MODULES);
          const project = `${world.project}/half`;
          const saved = `${project}/.collie/workflows`;
          yield* save(saved, ["graded.workflow.ts", "capability.ts", "house.ts"]);
          yield* fs
            .writeFileString(`${saved}/house.ts`, `export const HOUSE = "override";\n`)
            .pipe(Effect.orDie);

          const client = yield* connect(world.state).pipe(Effect.orDie);
          const started = yield* client
            .start({
              project,
              id: "reviewed",
              request: "req-1",
              input: { notes: "n", grade: "pass" },
            })
            .pipe(Effect.orDie);
          yield* until(
            () => client.run({ runId: started.runId }).pipe(Effect.orDie),
            (view) => (view?.waiting ?? []).some((one) => one.name === "sign-off"),
          );
          yield* client
            .answer({ runId: started.runId, decision: "sign-off", value: "ok", request: "a-1" })
            .pipe(Effect.orDie);

          const done = yield* until(
            () => client.run({ runId: started.runId }).pipe(Effect.orDie),
            (view) => view?.status.status === "complete",
          );
          // Two halves, two answers. The parent's own reading came from the file it
          // imported; the child came from the id it named, which the project claims. The
          // two copies of the contract are separate modules and one service all the same,
          // because a service is its key and not the file that declared it.
          expect(done?.status).toEqual({
            status: "complete",
            value: "strict:n+override:n/pass+ok",
          });
          expect(
            (yield* client.run({ runId: `${started.runId}.grade-n` }).pipe(Effect.orDie))?.entry,
          ).toBe(`${saved}/graded.workflow.ts`);
          yield* stopHost(world.state);
        }),
      [],
    ),
  300_000,
);

test(
  "a host that replaces another comes back to the children the parent already had",
  () =>
    proves(
      "collie-children-restart-",
      (world) =>
        Effect.gen(function* () {
          const project = yield* projectOf(world, "one-project", "strict");
          const runId = yield* Effect.scoped(
            Effect.gen(function* () {
              const client = yield* connect(world.state);
              const started = yield* client.start({
                project,
                id: "reviewed",
                request: "req-1",
                input: { notes: "a,b", grade: "pass" },
              });
              yield* until(
                () => client.run({ runId: started.runId }),
                // Parked, not only asking: an earlier answer is taken without a replay.
                (view) =>
                  view?.status.status === "suspended" &&
                  view.waiting.some((one) => one.name === "sign-off"),
              );
              return started.runId;
            }),
          ).pipe(Effect.orDie);

          // The host that admitted them is gone, and so is everything it held in memory.
          yield* stopHost(world.state);
          const client = yield* connect(world.state).pipe(Effect.orDie);
          yield* client
            .answer({ runId, decision: "sign-off", value: "ok", request: "answer-1" })
            .pipe(Effect.orDie);

          const done = yield* until(
            () => client.run({ runId }).pipe(Effect.orDie),
            (view) => view?.status.status === "complete",
          );
          // Replayed in a host that never started them, onto the executions it found.
          expect(done?.status).toEqual({
            status: "complete",
            value: "strict:a,b+strict:a/pass+strict:b/pass+ok",
          });
          for (const note of ["a", "b"]) {
            expect(yield* events(world.state, `${runId}.grade-${note}`)).toEqual([
              `graded strict:${note}/pass`,
            ]);
          }
          expect(yield* client.runs({ task: null }).pipe(Effect.orDie)).toHaveLength(3);
          yield* stopHost(world.state);
        }),
      [],
    ),
  300_000,
);

import * as Str from "effect/String";
import { pipe as pipe_ } from "effect/Function";
import * as Arr from "effect/Array";
import { expect, test } from "bun:test";
import { Effect, FileSystem, Schema } from "effect";
import { connect } from "../src/host";
import { readTask } from "../src/task";
import { events, root, stopHost, until } from "./support/host";
import { hostRecords } from "./support/records";
import { proves, save } from "./support/world";
import type { World } from "./support/world";

const MODULES = [
  "reviewed.workflow.ts",
  "graded.workflow.ts",
  "capability.ts",
  "house.ts",
] as const;

const sorted = <A>(values: ReadonlyArray<A>) =>
  [...values].sort((one, other) => pipe_(String(one), Str.localeCompare(String(other))));

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

const graded = (lines: ReadonlyArray<string>) =>
  Arr.filter(lines, (line) => pipe_(line, Str.startsWith("graded ")));

test("two projects grade the same notes with their own reviewer, parent and child alike", () =>
  proves(
    "collie-children-projects-",
    (world) =>
      Effect.gen(function* () {
        const strict = yield* projectOf(world, "strict-project", "strict");
        const lenient = yield* projectOf(world, "lenient-project", "lenient");
        const client = yield* connect(world.state).pipe(Effect.orDie);

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
            (view) => Arr.some(view?.waiting ?? [], (one) => one.name === "sign-off"),
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
        expect(values).toEqual([
          { status: "complete", value: "strict:n+strict:n/pass+ok" },
          { status: "complete", value: "lenient:n+lenient:n/pass+ok" },
        ]);
        yield* stopHost(world.state);
      }),
    [],
  ));

test("input the child will not take makes no child at all, and says so at the parent", () =>
  proves(
    "collie-children-invalid-",
    (world) =>
      Effect.gen(function* () {
        const project = yield* projectOf(world, "one-project", "strict");
        const client = yield* connect(world.state).pipe(Effect.orDie);
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

        const runs = yield* client.runs({ task: null }).pipe(Effect.orDie);
        expect(Arr.map(runs, (one) => one.runId)).toEqual([started.runId]);
        expect(yield* events(world.state, `${started.runId}.grade-n`)).toEqual([]);
        yield* stopHost(world.state);
      }),
    [],
  ));

test("replaying a parent reuses the children it admitted, and each invocation is its own Run", () =>
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

        yield* until(
          () => client.run({ runId: started.runId }).pipe(Effect.orDie),
          (view) => Arr.some(view?.waiting ?? [], (one) => one.name === "sign-off"),
        );
        const children = Arr.filter(
          yield* client.runs({ task: "task-9" }).pipe(Effect.orDie),
          (one) => one.parent === started.runId,
        );
        expect(sorted(Arr.map(children, (one) => one.runId))).toEqual([
          `${started.runId}.grade-one`,
          `${started.runId}.grade-two`,
        ]);
        expect(sorted(Arr.map(children, (one) => one.input.note))).toEqual(["one", "two"]);
        expect(
          Arr.every(children, (one) => one.workflow === "graded" && one.task === "task-9"),
        ).toBe(true);

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
          expect(graded(yield* events(world.state, `${started.runId}.grade-${note}`))).toEqual([
            `graded strict:${note}/pass`,
          ]);
        }
        expect((yield* client.runs({ task: "task-9" }).pipe(Effect.orDie)).length).toBe(3);
        yield* stopHost(world.state);
      }),
    [],
  ));

test("a child that is work of its own keeps its Task on replay, and still returns its result to its parent", () =>
  proves(
    "collie-children-own-",
    (world) =>
      Effect.gen(function* () {
        const project = yield* projectOf(world, "one-project", "strict");
        const client = yield* connect(world.state).pipe(Effect.orDie);
        const started = yield* client
          .start({
            project,
            id: "reviewed",
            request: "req-1",
            input: { notes: "one", grade: "pass", own: true },
            task: "task-9",
          })
          .pipe(Effect.orDie);
        yield* until(
          () => client.run({ runId: started.runId }).pipe(Effect.orDie),
          (view) => Arr.some(view?.waiting ?? [], (one) => one.name === "sign-off"),
        );

        const childId = `${started.runId}.grade-one`;
        const child = yield* client.run({ runId: childId }).pipe(Effect.orDie);
        expect(child?.parent).toBe(started.runId);
        expect(child?.task).not.toBeNull();
        expect(child?.task).not.toBe("task-9");
        expect(
          (yield* hostRecords(world.state, readTask(child?.task ?? "")).pipe(Effect.orDie))?.label,
        ).toBe("One project | One");

        yield* client
          .answer({ runId: started.runId, decision: "sign-off", value: "ok", request: "a-1" })
          .pipe(Effect.orDie);
        const done = yield* until(
          () => client.run({ runId: started.runId }).pipe(Effect.orDie),
          (view) => view?.status.status === "complete",
        );
        expect(done?.status).toEqual({
          status: "complete",
          value: "strict:one+strict:one/pass+ok",
        });
        expect(graded(yield* events(world.state, childId))).toEqual(["graded strict:one/pass"]);
        const runs = yield* client.runs({ task: null }).pipe(Effect.orDie);
        expect(sorted(Arr.map(runs, (one) => one.runId))).toEqual([started.runId, childId]);
        expect((yield* client.run({ runId: childId }).pipe(Effect.orDie))?.task).toBe(child?.task);
        yield* stopHost(world.state);
      }),
    [],
  ));

test("stopping and resuming the parent reaches its own-Task child while the parent waits for it", () =>
  proves(
    "collie-children-own-stop-",
    (world) =>
      Effect.gen(function* () {
        const project = yield* projectOf(world, "one-project", "strict");
        const client = yield* connect(world.state).pipe(Effect.orDie);
        const started = yield* client
          .start({
            project,
            id: "reviewed",
            request: "req-1",
            input: { notes: "one", grade: "pass", own: true, wait: true },
          })
          .pipe(Effect.orDie);
        yield* until(
          () => client.run({ runId: `${started.runId}.grade-one` }).pipe(Effect.orDie),
          (view) =>
            view?.status.status === "suspended" &&
            Arr.some(view.waiting, (one) => one.name === "ready"),
        );

        expect(
          (yield* client.run({ runId: started.runId }).pipe(Effect.orDie))?.status.status,
        ).not.toBe("complete");

        yield* client
          .control({ runId: started.runId, control: "stop", set: true, request: "stop-1" })
          .pipe(Effect.orDie);

        const child = yield* client.run({ runId: `${started.runId}.grade-one` }).pipe(Effect.orDie);
        expect(child?.task).not.toBe(
          (yield* client.run({ runId: started.runId }).pipe(Effect.orDie))?.task,
        );
        expect(child?.controls).toContain("stop");
        yield* client
          .control({ runId: started.runId, control: "stop", set: false, request: "resume-1" })
          .pipe(Effect.orDie);
        expect((yield* client.run({ runId: child!.runId }).pipe(Effect.orDie))?.controls).toEqual(
          [],
        );
        yield* client
          .answer({ runId: child!.runId, decision: "ready", value: "yes", request: "ready-1" })
          .pipe(Effect.orDie);
        yield* until(
          () => client.run({ runId: started.runId }).pipe(Effect.orDie),
          (view) =>
            view?.status.status === "suspended" &&
            Arr.some(view.waiting, (one) => one.name === "sign-off"),
        );
        yield* client
          .answer({ runId: started.runId, decision: "sign-off", value: "ok", request: "sign-1" })
          .pipe(Effect.orDie);
        const done = yield* until(
          () => client.run({ runId: started.runId }).pipe(Effect.orDie),
          (view) => view?.status.status === "complete",
        );
        expect(done?.status).toEqual({
          status: "complete",
          value: "strict:one+strict:one/pass+ok",
        });
        yield* stopHost(world.state);
      }),
    [],
  ));

test("a hold reaches a parent that has children, and what it replays under it makes no more", () =>
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
              (view) =>
                view?.status.status === "suspended" &&
                Arr.some(view.waiting, (one) => one.name === "sign-off"),
            );
            yield* client.control({
              runId: started.runId,
              control: "hold",
              set: true,
              request: "hold-child",
            });
            return started.runId;
          }),
        ).pipe(Effect.orDie);

        const client = yield* connect(world.state).pipe(Effect.orDie);
        expect((yield* client.run({ runId }).pipe(Effect.orDie))?.controls).toEqual(["hold"]);

        yield* client
          .answer({ runId, decision: "sign-off", value: "ok", request: "answer-1" })
          .pipe(Effect.orDie);
        yield* until(
          () => events(world.state, runId),
          (log) => log.includes("held"),
        );
        const held = yield* until(
          () => client.run({ runId }).pipe(Effect.orDie),
          (view) => view?.status.status === "suspended",
        );
        expect(held?.status).toEqual({
          status: "suspended",
        });
        yield* client
          .control({ runId, control: "hold", set: false, request: "release-child" })
          .pipe(Effect.orDie);
        const done = yield* until(
          () => client.run({ runId }).pipe(Effect.orDie),
          (view) => view?.status.status === "complete",
        );
        expect(done?.status).toEqual({
          status: "complete",
          value: "strict:a,b+strict:a/pass+strict:b/pass+ok",
        });
        for (const note of ["a", "b"]) {
          expect(graded(yield* events(world.state, `${runId}.grade-${note}`))).toEqual([
            `graded strict:${note}/pass`,
          ]);
        }
        expect(yield* client.runs({ task: null }).pipe(Effect.orDie)).toHaveLength(3);
        yield* stopHost(world.state);
      }),
    [],
  ));

test("a project that overrides only the child changes the child, and leaves the import alone", () =>
  proves(
    "collie-children-bypass-",
    (world) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
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
          (view) => Arr.some(view?.waiting ?? [], (one) => one.name === "sign-off"),
        );
        yield* client
          .answer({ runId: started.runId, decision: "sign-off", value: "ok", request: "a-1" })
          .pipe(Effect.orDie);

        const done = yield* until(
          () => client.run({ runId: started.runId }).pipe(Effect.orDie),
          (view) => view?.status.status === "complete",
        );
        // WARNING: A service is its key, not the file that declared it.
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
  ));

test("a host that replaces another comes back to the children the parent already had", () =>
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
              (view) =>
                view?.status.status === "suspended" &&
                Arr.some(view.waiting, (one) => one.name === "sign-off"),
            );
            return started.runId;
          }),
        ).pipe(Effect.orDie);

        yield* stopHost(world.state);
        const client = yield* connect(world.state).pipe(Effect.orDie);
        yield* client
          .answer({ runId, decision: "sign-off", value: "ok", request: "answer-1" })
          .pipe(Effect.orDie);

        const done = yield* until(
          () => client.run({ runId }).pipe(Effect.orDie),
          (view) => view?.status.status === "complete",
        );
        expect(done?.status).toEqual({
          status: "complete",
          value: "strict:a,b+strict:a/pass+strict:b/pass+ok",
        });
        for (const note of ["a", "b"]) {
          expect(graded(yield* events(world.state, `${runId}.grade-${note}`))).toEqual([
            `graded strict:${note}/pass`,
          ]);
        }
        expect(yield* client.runs({ task: null }).pipe(Effect.orDie)).toHaveLength(3);
        yield* stopHost(world.state);
      }),
    [],
  ));

test("a parent the host is replaced under reads the child that finished before the swap", () =>
  proves(
    "collie-children-swap-",
    (world) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const project = `${world.project}/swapped-project`;
        yield* save(`${project}/.collie/workflows`, ["outlived.workflow.ts", "late.workflow.ts"]);
        const gate = `${world.project}/gate`;
        yield* fs.writeFileString(gate, "").pipe(Effect.orDie);
        const runId = yield* Effect.scoped(
          Effect.gen(function* () {
            const client = yield* connect(world.state);
            const started = yield* client.start({
              project,
              id: "outlived",
              request: "req-1",
              input: { note: "n", gate },
            });
            yield* until(
              () => events(world.state, started.runId),
              (lines) => lines.includes("held"),
            );
            return started.runId;
          }),
        ).pipe(Effect.orDie);

        yield* stopHost(world.state);
        const client = yield* connect(world.state).pipe(Effect.orDie);
        yield* fs.remove(gate).pipe(Effect.orDie);

        const done = yield* until(
          () => client.run({ runId }).pipe(Effect.orDie),
          (view) => view?.status.status === "complete" || view?.status.status === "failed",
        );
        expect(done?.status).toEqual({ status: "complete", value: "outlived late:n" });
        expect(graded(yield* events(world.state, `${runId}.grade`))).toEqual(["graded late:n"]);
        yield* stopHost(world.state);
      }),
    [],
  ));

const SPREADING_FORK = `import { defineWorkflow } from "collie";
import original from "../../workflows/plan.workflow.ts";

export default defineWorkflow({ ...original, id: "plan" });
`;

test.each([
  { against: "the shipped plan", fork: false },
  { against: "a user-layer fork that spreads it", fork: true },
])("an Improvement starts plan with then=implement against $against", ({ fork }) =>
  proves(
    "collie-children-then-",
    (world) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        for (const file of ["plan.workflow.ts", "plan.md", "connections.ts"]) {
          yield* fs
            .copyFile(`${root}workflows/${file}`, `${world.install}/workflows/${file}`)
            .pipe(Effect.orDie);
        }
        if (fork) {
          yield* fs
            .writeFileString(`${world.user}/plan.workflow.ts`, SPREADING_FORK)
            .pipe(Effect.orDie);
        }
        const client = yield* connect(world.state).pipe(Effect.orDie);
        const started = yield* client
          .start({
            project: world.project,
            id: "improves",
            request: "req-1",
            input: { goal: "Fix what the day showed" },
          })
          .pipe(Effect.orDie);
        const view = yield* until(
          () => client.run({ runId: started.runId }).pipe(Effect.orDie),
          (one) => one?.status.status === "complete" || one?.status.status === "failed",
        );
        expect(view?.status).toMatchObject({ status: "complete" });
        const child = yield* Schema.decodeUnknownEffect(Schema.String)(
          view?.status.status === "complete" ? view.status.value : undefined,
        );
        expect(yield* client.run({ runId: child }).pipe(Effect.orDie)).not.toBeNull();
        yield* stopHost(world.state);
      }),
    ["improves.workflow.ts"],
  ),
);

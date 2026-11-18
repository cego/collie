import * as Str from "effect/String";
import { pipe as pipe_ } from "effect/Function";
import * as Arr from "effect/Array";
import * as Option from "effect/Option";
import { expect, test } from "bun:test";
import { Effect, FileSystem } from "effect";
import { connect } from "../src/host";
import { stopHost, until } from "./support/host";
import { proves, save, type World } from "./support/world";

const MODULES = ["spread.workflow.ts", "share.workflow.ts"] as const;

const sorted = <A>(values: ReadonlyArray<A>) =>
  [...values].sort((one, other) => pipe_(String(one), Str.localeCompare(String(other))));

const ticket = (into: string, file: string, repo: string, over?: { readonly blockedBy?: string }) =>
  FileSystem.FileSystem.pipe(
    Effect.flatMap((fs) =>
      fs.writeFileString(
        `${into}/issues/${file}`,
        Arr.join(
          [
            `# ${file}`,
            "",
            `**Blocked by:** ${over?.blockedBy ?? "None"}`,
            "",
            `**Repo:** ${repo}`,
            "",
            "**Checks:** test",
            "",
          ],
          "\n",
        ),
      ),
    ),
    Effect.orDie,
  );

const projectOf = Effect.fn("ReposTest.project")(function* (
  world: World,
  checkouts: ReadonlyArray<string>,
) {
  const fs = yield* FileSystem.FileSystem;
  const project = `${world.project}/work`;
  yield* save(`${project}/.collie/workflows`, MODULES);
  yield* fs.makeDirectory(`${project}/plan/issues`, { recursive: true }).pipe(Effect.orDie);
  for (const repo of checkouts) {
    yield* fs.makeDirectory(`${project}/${repo}/.git`, { recursive: true }).pipe(Effect.orDie);
  }
  return project;
});

test("a plan over two repositories is two Runs, each with its own share and its own repo", () =>
  proves(
    "collie-repos-fanout-",
    (world) =>
      Effect.gen(function* () {
        const project = yield* projectOf(world, ["api", "ui"]);
        const plan = `${project}/plan`;
        yield* ticket(plan, "01-serve.md", "api");
        yield* ticket(plan, "02-show.md", "ui", { blockedBy: "01" });
        yield* ticket(plan, "03-more.md", "api");

        const client = yield* connect(world.state).pipe(Effect.orDie);
        const started = yield* client
          .start({
            project,
            id: "spread",
            request: "req-1",
            input: { plan, root: project },
            task: "task-1",
          })
          .pipe(Effect.orDie);

        const done = yield* until(
          () => client.run({ runId: started.runId }).pipe(Effect.orDie),
          (view) => view?.status.status === "complete",
        );
        expect(done?.status).toEqual({
          status: "complete",
          value: "api(01-serve.md,03-more.md) then ui(02-show.md)",
        });

        const children = Arr.filter(
          yield* client.runs({ task: "task-1" }).pipe(Effect.orDie),
          (one) => one.parent === started.runId,
        );
        expect(sorted(Arr.map(children, (one) => one.runId))).toEqual([
          `${started.runId}.repo-api`,
          `${started.runId}.repo-ui`,
        ]);
        const api = Option.getOrUndefined(
          Arr.findFirst(children, (one) => one.runId === `${started.runId}.repo-api`),
        );
        expect(api?.input.tickets).toEqual(["01-serve.md", "03-more.md"]);
        expect(api?.options).toEqual({ repo: "api", workspace: `${project}/api` });
        expect(api?.outcome).toBe("unspecified");
        expect(api?.workflow).toBe("share");
        expect(api?.task).toBe("task-1");
        yield* stopHost(world.state);
      }),
    [],
  ));

test("a repository with nowhere to work stops the plan before any Run is started for it", () =>
  proves(
    "collie-repos-refused-",
    (world) =>
      Effect.gen(function* () {
        const project = yield* projectOf(world, ["api"]);
        const plan = `${project}/plan`;
        yield* ticket(plan, "01-serve.md", "api");
        yield* ticket(plan, "02-show.md", "ui");

        const client = yield* connect(world.state).pipe(Effect.orDie);
        const started = yield* client
          .start({ project, id: "spread", request: "req-1", input: { plan, root: project } })
          .pipe(Effect.orDie);

        const view = yield* until(
          () => client.run({ runId: started.runId }).pipe(Effect.orDie),
          (one) => one?.status.status === "failed",
        );
        expect(view?.status).toMatchObject({
          status: "failed",
          reason: expect.stringContaining("missing-checkout"),
        });
        expect(
          Arr.map(yield* client.runs({ task: null }).pipe(Effect.orDie), (one) => one.runId),
        ).toEqual([started.runId]);
        yield* stopHost(world.state);
      }),
    [],
  ));

test("replaying the parent comes back to the Runs it already started for each repository", () =>
  proves(
    "collie-repos-replay-",
    (world) =>
      Effect.gen(function* () {
        const project = yield* projectOf(world, ["api", "ui"]);
        const plan = `${project}/plan`;
        yield* ticket(plan, "01-serve.md", "api");
        yield* ticket(plan, "02-show.md", "ui");

        const client = yield* connect(world.state).pipe(Effect.orDie);
        const started = yield* client
          .start({ project, id: "spread", request: "req-1", input: { plan, root: project } })
          .pipe(Effect.orDie);
        yield* until(
          () => client.run({ runId: started.runId }).pipe(Effect.orDie),
          (view) => view?.status.status === "complete",
        );

        const again = yield* client
          .start({ project, id: "spread", request: "req-1", input: { plan, root: project } })
          .pipe(Effect.orDie);
        expect(again.runId).toBe(started.runId);
        expect((yield* client.runs({ task: null }).pipe(Effect.orDie)).length).toBe(3);
        yield* stopHost(world.state);
      }),
    [],
  ));

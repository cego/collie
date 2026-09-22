// A plan that spans repositories, fanned out into one Run per repository.
//
// The fan-out is the parent's own code: `readPlanRepos` says which repositories a plan
// changes and in what order they may start, `Effect.forEach` starts a wave, and each
// child is admitted like any other Run — with its own share of the plan settled and
// decoded before it exists, and the host's own options saying which repository it is for.
//
// A plan that cannot be fanned out at all is refused at the parent, where there is
// nothing to clean up: no child, no row, no execution.

import { expect, test } from "bun:test";
import { Effect, FileSystem } from "effect";
import { connect } from "../src/host";
import { stopHost, until } from "./support/native";
import { proves, save, type World } from "./support/world";

const MODULES = ["spread.workflow.ts", "share.workflow.ts"] as const;

const sorted = <A>(values: ReadonlyArray<A>) =>
  [...values].sort((one, other) => String(one).localeCompare(String(other)));

/** One ticket, as the planning step writes them. */
const ticket = (into: string, file: string, repo: string, over?: { readonly blockedBy?: string }) =>
  FileSystem.FileSystem.pipe(
    Effect.flatMap((fs) =>
      fs.writeFileString(
        `${into}/issues/${file}`,
        [
          `# ${file}`,
          "",
          `**Blocked by:** ${over?.blockedBy ?? "None"}`,
          "",
          `**Repo:** ${repo}`,
          "",
          "**Checks:** test",
          "",
        ].join("\n"),
      ),
    ),
    Effect.orDie,
  );

/** A project with the modules saved in it, and the plan the parent is started on. */
const projectOf = Effect.fn("ReposTest.project")(function* (
  world: World,
  checkouts: ReadonlyArray<string>,
) {
  const fs = yield* FileSystem.FileSystem;
  const project = `${world.project}/work`;
  yield* save(`${project}/.herdr/workflows`, MODULES);
  yield* fs.makeDirectory(`${project}/plan/issues`, { recursive: true }).pipe(Effect.orDie);
  // A `.git` that is there at all is a checkout to root a run at.
  for (const repo of checkouts) {
    yield* fs.makeDirectory(`${project}/${repo}/.git`, { recursive: true }).pipe(Effect.orDie);
  }
  return project;
});

test(
  "a plan over two repositories is two Runs, each with its own share and its own repo",
  () =>
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
          // In wave order, because `ui` waits on the repository its ticket is blocked by.
          expect(done?.status).toEqual({
            status: "complete",
            value: "api(01-serve.md,03-more.md) then ui(02-show.md)",
          });

          const children = (yield* client.runs({ task: "task-1" }).pipe(Effect.orDie)).filter(
            (one) => one.parent === started.runId,
          );
          expect(sorted(children.map((one) => one.runId))).toEqual([
            `${started.runId}.repo-api`,
            `${started.runId}.repo-ui`,
          ]);
          const api = children.find((one) => one.runId === `${started.runId}.repo-api`);
          // Its own share of the work source, decoded by its own schema before it existed.
          expect(api?.input.tickets).toEqual(["01-serve.md", "03-more.md"]);
          // The host's own options: which repository this Run is for, and where it works.
          expect(api?.options).toEqual({ repo: "api", workspace: `${project}/api` });
          // Its own module decides what it proves; nothing of the parent's is inherited.
          expect(api?.outcome).toBe("unspecified");
          expect(api?.workflow).toBe("share");
          expect(api?.task).toBe("task-1");
          yield* stopHost(world.state);
        }),
      [],
    ),
  300_000,
);

test(
  "a repository with nowhere to work stops the plan before any Run is started for it",
  () =>
    proves(
      "collie-repos-refused-",
      (world) =>
        Effect.gen(function* () {
          // `ui` names a repository that is not a checkout under the root.
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
          // Not one repository was started: a plan that cannot be fanned out is refused
          // where there is nothing yet to clean up.
          expect(
            (yield* client.runs({ task: null }).pipe(Effect.orDie)).map((one) => one.runId),
          ).toEqual([started.runId]);
          yield* stopHost(world.state);
        }),
      [],
    ),
  300_000,
);

test(
  "replaying the parent comes back to the Runs it already started for each repository",
  () =>
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

          // The same request again is the same Run, replayed onto the children it has.
          const again = yield* client
            .start({ project, id: "spread", request: "req-1", input: { plan, root: project } })
            .pipe(Effect.orDie);
          expect(again.runId).toBe(started.runId);
          expect((yield* client.runs({ task: null }).pipe(Effect.orDie)).length).toBe(3);
          yield* stopHost(world.state);
        }),
      [],
    ),
  300_000,
);

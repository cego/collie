// A Run can work in a checkout another tool made, as bodil makes one: a parent runs the
// tool's "up", a child works in the worktree it cut, and the tool's "down" runs once the
// child has settled. Collie reuses that checkout and never prunes it, since it did not make
// it. Real host, real git.

import { expect, test } from "bun:test";
import { Effect, FileSystem, Schema } from "effect";
import { CleanupReport } from "../src/board-model";
import { connect } from "../src/host";
import { exec } from "./support/command";
import { stopHost, until } from "./support/host";
import { collie, proves, type World } from "./support/world";

const MODULES = ["provisions.workflow.ts", "placed.workflow.ts"] as const;
const Listed = Schema.decodeUnknownSync(CleanupReport);

/** The tool's repository, with the one commit a worktree needs to be cut from. */
const toolRepo = Effect.fn("ToolCheckoutTest.toolRepo")(function* (world: World) {
  const fs = yield* FileSystem.FileSystem;
  const repo = `${world.home}/tool/repo`;
  yield* fs.makeDirectory(repo, { recursive: true });
  for (const args of [
    ["init", "-q", "-b", "master"],
    ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "one"],
  ]) {
    yield* exec(["git", ...args], { cwd: repo });
  }
  return repo;
});

/** What the tool logged: one line per "up" and "down" it ran. */
const toolLog = (world: World) =>
  FileSystem.FileSystem.pipe(
    Effect.flatMap((fs) => fs.readFileString(`${world.home}/tool/tool.log`)),
    Effect.map((text) => text.trim().split("\n")),
  );

/** The parent started, its question answered by a host that replaced the first, and both Runs settled. */
const settled = Effect.fn("ToolCheckoutTest.settled")(function* (
  world: World,
  outcome: "succeed" | "fail",
) {
  const repo = yield* toolRepo(world);
  const started = yield* Effect.scoped(
    Effect.gen(function* () {
      const first = yield* connect(world.state);
      const run = yield* first.start({
        project: world.project,
        id: "provisions",
        request: `req-${outcome}`,
        input: { source: repo, name: "collie-try", ending: outcome },
      });
      yield* until(
        () => first.run({ runId: run.runId }),
        (view) =>
          view?.status.status === "suspended" && view.waiting.some((one) => one.name === "go"),
      );
      return run;
    }),
  ).pipe(Effect.orDie);
  // A host that never ran "up" resumes the parent past it.
  yield* stopHost(world.state);
  const client = yield* connect(world.state).pipe(Effect.orDie);
  yield* client
    .answer({ runId: started.runId, decision: "go", value: "yes", request: "answer-1" })
    .pipe(Effect.orDie);
  const parent = yield* until(
    () => client.run({ runId: started.runId }).pipe(Effect.orDie),
    (view) => view?.status.status === "complete" || view?.status.status === "failed",
  );
  const child = yield* client.run({ runId: `${started.runId}.build` }).pipe(Effect.orDie);
  return { parent, child, worktree: `${world.home}/tool/worktrees/collie-try` };
});

test(
  "a child works in the tool's worktree on its branch, which Collie did not make and never prunes",
  () =>
    proves(
      "collie-tool-checkout-",
      (world) =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const { parent, child, worktree } = yield* settled(world, "succeed");

          expect(parent?.status).toEqual({ status: "complete", value: worktree });
          expect(child?.cwd).toBe(worktree);
          expect(child?.worktree).toMatchObject({
            path: worktree,
            branch: "collie-try",
            created_by_collie: false,
          });
          // "up" ran once though a new host replayed the parent past it, and "down" once.
          expect(yield* toolLog(world)).toEqual(["up", "down"]);

          const listed = Listed((yield* collie(world, ["cleanup"])).envelope.data);
          expect(listed.remove.filter((item) => item.target.startsWith(worktree))).toEqual([]);
          yield* collie(world, ["cleanup", "--apply", "--request-id", "sweep-1"]);
          expect(yield* fs.exists(worktree)).toBe(true);
          yield* stopHost(world.state);
        }),
      MODULES,
    ),
  300_000,
);

test(
  "the tool's down runs once after a child that failed, and the parent fails with it",
  () =>
    proves(
      "collie-tool-checkout-failed-",
      (world) =>
        Effect.gen(function* () {
          const { parent, child } = yield* settled(world, "fail");

          expect(child?.status.status).toBe("failed");
          expect(parent?.status).toMatchObject({
            status: "failed",
            reason: expect.stringContaining("failed in"),
          });
          expect(yield* toolLog(world)).toEqual(["up", "down"]);
          yield* stopHost(world.state);
        }),
      MODULES,
    ),
  300_000,
);

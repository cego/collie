import { expect, test } from "bun:test";
import { Effect, FileSystem } from "effect";
import { buildBoard } from "../src/board";
import { readDispositions } from "../src/disposition";
import { readMrStates, settleMerges } from "../src/merges";
import type { Runner } from "../src/mr";
import { RunStore } from "../src/run";
import { task } from "./support/task";
import { runEffect } from "./support/effect";

/** A GitLab that answers every readiness check and says one thing about every MR. */
function gitlab(state: string, log: string[] = []): Runner {
  return (cmd, args) => {
    log.push(`${cmd} ${args.join(" ")}`);
    if (args[0] === "api") return Effect.succeed({ code: 0, stdout: '{"username":"mk"}' });
    if (args[0] === "mr")
      return Effect.succeed({
        code: 0,
        stdout: `{"iid":65,"state":"${state}","title":"Cards","web_url":"https://gitlab.cego.dk/mk/collie/-/merge_requests/65"}`,
      });
    return Effect.succeed({ code: 0, stdout: "" });
  };
}

const MR = "https://gitlab.cego.dk/mk/collie/-/merge_requests/65";

const seeded = Effect.fn("merges.seeded")(function* () {
  const fs = yield* FileSystem.FileSystem;
  const stateDir = yield* fs.makeTempDirectory({ prefix: "collie-merges-" });
  const run = yield* new RunStore(stateDir).create({
    workflow: "implement",
    cwd: "/project",
    session: null,
    workspace: "w1",
    workspaceLabel: "collie | Control plane",
    inputs: {},
    inputSources: {},
    stepIds: ["build"],
    maxIterations: 4,
    namedAfter: "control-plane",
  });
  run.record.status = "done";
  run.record.mr_url = MR;
  yield* run.save();
  return { stateDir, run };
});

test("a merge GitLab reports lands the work: a disposition by gitlab, and the card moves", () =>
  runEffect(
    Effect.gen(function* () {
      const { stateDir, run } = yield* seeded();
      const before = yield* buildBoard({ stateDir, mrStates: new Map() });
      expect(before[0]!.sentence).toBe("Finished; mk/collie!65 is open.");

      const states = new Map();
      yield* settleMerges({
        stateDir,
        cwd: "/project",
        run: gitlab("merged"),
        views: before,
        now: Date.parse("2026-09-17T10:00:00Z"),
        checked: new Map(),
        states,
      });

      const recorded = yield* readDispositions(run.dir);
      expect(recorded.map((line) => [line.by, line.kind, line.ref])).toEqual([
        ["gitlab", "merged", "mk/collie!65"],
      ]);
      expect(yield* readMrStates(stateDir)).toEqual(new Map([["mk/collie!65", "merged"]]));
      // Nothing passed in: the CLI's board reads what the pane's watch wrote.
      const after = yield* buildBoard({ stateDir, now: Date.parse("2026-09-17T11:00:00Z") });
      expect(after[0]!.landed).toBe(true);
      expect(after[0]!.sentence).toBe("Merged as mk/collie!65.");
    }),
  ));

test("a closed merge request is news, not a verdict, and a fresh answer is not asked for again", () =>
  runEffect(
    Effect.gen(function* () {
      const { stateDir, run } = yield* seeded();
      const views = yield* buildBoard({ stateDir, mrStates: new Map() });
      const log: string[] = [];
      const checked = new Map<string, number>();
      const states = new Map();
      const now = Date.parse("2026-09-17T10:00:00Z");
      yield* settleMerges({
        stateDir,
        cwd: "/project",
        run: gitlab("closed", log),
        views,
        now,
        checked,
        states,
      });
      expect(yield* readDispositions(run.dir)).toEqual([]);
      const again = yield* buildBoard({ stateDir, mrStates: states, now });
      expect(again[0]!.sentence).toBe("Merge request mk/collie!65 closed without merging.");
      expect(again[0]!.landed).toBe(false);

      // Two minutes on: nothing is asked, the last answer stands.
      const asked = log.length;
      yield* settleMerges({
        stateDir,
        cwd: "/project",
        run: gitlab("closed", log),
        views,
        now: now + 120_000,
        checked,
        states,
      });
      expect(log.length).toBe(asked);
    }),
  ));

/** A GitLab whose merge landed and whose deploy jobs have taken it as far as `live` says. */
function deployed(live: { stage: string; prod: string | null }, log: string[] = []): Runner {
  const merged = "35ae2cea5e5848602729dbc0e8a87ed0d9049c46";
  return (cmd, args) => {
    log.push(`${cmd} ${args.join(" ")}`);
    const route = args[0] === "api" ? (args.at(-1) ?? "") : "";
    if (route.endsWith("/environments"))
      return Effect.succeed({
        code: 0,
        stdout: JSON.stringify([
          { name: "stage", tier: "staging" },
          { name: "prod", tier: "production" },
          { name: "review/x", tier: "development" },
        ]),
      });
    if (route.includes("/deployments?"))
      return Effect.succeed({
        code: 0,
        stdout: JSON.stringify([
          ...(live.prod ? [{ sha: live.prod, environment: { name: "prod" } }] : []),
          { sha: live.stage, environment: { name: "stage" } },
          { sha: "0000000", environment: { name: "prod" } },
        ]),
      });
    if (route.includes("/merge_base?"))
      // Only a descendant of the merge commit has it as the merge-base.
      return Effect.succeed({
        code: 0,
        stdout: JSON.stringify({ id: route.includes("refs[]=child") ? merged : "0000000" }),
      });
    if (args[0] === "api") return Effect.succeed({ code: 0, stdout: '{"username":"mk"}' });
    if (args[0] === "mr")
      return Effect.succeed({
        code: 0,
        stdout: `{"iid":65,"state":"merged","merge_commit_sha":"${merged}","title":"Cards","web_url":"${MR}"}`,
      });
    return Effect.succeed({ code: 0, stdout: "" });
  };
}

test("a merged card follows its deploy jobs: on stage, then in production, then asked no more", () =>
  runEffect(
    Effect.gen(function* () {
      const { stateDir, run } = yield* seeded();
      const states = new Map();
      const checked = new Map<string, number>();
      let now = Date.parse("2026-09-17T10:00:00Z");
      const settle = (gitlab: Runner, log: string[] = []) =>
        Effect.gen(function* () {
          const current = yield* buildBoard({ stateDir, mrStates: states, now });
          yield* settleMerges({
            stateDir,
            cwd: "/project",
            run: gitlab,
            views: current,
            now,
            checked,
            states,
          });
          return log;
        });

      // Stage has a child of the merge commit; prod still runs something older.
      yield* settle(deployed({ stage: "child", prod: "0000000" }));
      expect(states.get("mk/collie!65")).toBe("on-stage");
      expect((yield* readDispositions(run.dir)).map((line) => line.kind)).toEqual(["merged"]);
      let board = yield* buildBoard({ stateDir, now });
      expect(board[0]!.landed).toBe(true);
      expect(board[0]!.sentence).toBe("Merged as mk/collie!65. On stage.");

      // Disposed of, and still followed: production now has the merge commit itself.
      now += 6 * 60_000;
      yield* settle(deployed({ stage: "child", prod: "35ae2cea5e5848602729dbc0e8a87ed0d9049c46" }));
      expect(states.get("mk/collie!65")).toBe("in-prod");
      board = yield* buildBoard({ stateDir, now });
      expect(board[0]!.sentence).toBe("Merged as mk/collie!65. In production.");
      // One merged disposition, not one per round.
      expect((yield* readDispositions(run.dir)).map((line) => line.kind)).toEqual(["merged"]);

      // In production is as far as it goes: GitLab is not asked about it again.
      now += 6 * 60_000;
      const log: string[] = [];
      yield* settle(deployed({ stage: "child", prod: "child" }, log), log);
      expect(log).toEqual([]);
    }),
  ));

test("what is working, or already disposed of, is not asked about", () =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const stateDir = yield* fs.makeTempDirectory({ prefix: "collie-merges-" });
      const log: string[] = [];
      yield* settleMerges({
        stateDir,
        cwd: "/project",
        run: gitlab("merged", log),
        views: [
          task({ id: "working", state: "active", mr: MR }),
          task({
            id: "landed",
            state: "done",
            landed: true,
            mr: MR,
            disposition: "superseded mk/collie!66",
          }),
          task({ id: "no-mr", state: "failed" }),
        ],
        now: Date.parse("2026-09-17T10:00:00Z"),
        checked: new Map(),
        states: new Map(),
      });
      expect(log).toEqual([]);
    }),
  ));

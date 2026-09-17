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
            disposition: "merged mk/collie!65",
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

// "Implement now" on a plan that spans repositories: one run per repository, in waves,
// with the plan run staying alive as their parent. Driven through the recorder rig, so
// what is asserted is what the run records say rather than the engine's own state.

import { afterEach, beforeEach, expect, test } from "bun:test";
import { ConfigProvider, Effect, FileSystem, Layer, Path, Schema } from "effect";
import { Rig, TEST_LOGIN } from "./support/recorder";
import { FakeBin } from "./support/bin";
import { runEffect } from "./support/effect";
import { EffectFakeHerdr, installBaseline, runWorkflow, scriptedPrompts } from "./support/engine";
import { testDefaults } from "./support/compaction";
import { layers, loadDefinitions, resolveWorkflow } from "../src/definitions";
import { executeRun, type EnginePrompts } from "../src/engine";
import { stopRun } from "../src/operations";
import { Herdr } from "../src/herdr";
import { writeDef } from "./support/defs";
import { RunStore, type Run } from "../src/run";

let rig: Rig;
let bin: FakeBin;
let driverLog: string;
let driverLayer: Layer.Layer<never>;

/**
 * A parent shaped like `plan`: it writes a plan directory, then offers a `run:` choice
 * that hands `implement` the plan it wrote.
 */
const PARENT = `---
name: multi-parent
inputs:
  goal: goal
steps:
  - id: draft
    persona: planner
    output: draft.json
  - id: next
    choices:
      - title: Implement now
        run: implement
        inputs:
          plan: "{{run.dir}}/plan"
          task: "{{outputs.draft.slug}}"
      - title: Refine
        agent: draft
        prompt: refine
        output: refine.json
      - title: Stop here
        stop: true
---
## draft
Draft into {{run.dir}}/plan/SPEC.md

## refine
Change the plan.
`;

const CLEAN = { verdict: "clean", findings: [] };

/** One ticket, as `to-tickets` writes it. */
function ticket(title: string, repo: string, blockedBy = "None") {
  return `# ${title}\n\n**What to build:** something.\n\n**Blocked by:** ${blockedBy}\n\n**Repo:** ${repo}\n\n**Status:** ready-for-agent\n`;
}

/** The plan a `draft` step writes: `SPEC.md` plus the tickets given here. */
function plan(tickets: Record<string, string>) {
  return {
    __write: { "plan/SPEC.md": "# Add a version flag\n", ...tickets },
    // The short name the planner and the human agreed the work is called, which is
    // what every repository run's branch is named after.
    output: { ...CLEAN, slug: "version-flag" },
  };
}

const TWO_REPOS = {
  "plan/issues/01-api.md": ticket("01: the contract", "cego/api"),
  "plan/issues/02-web.md": ticket("02: the page", "cego/web", "01"),
};

/**
 * A Driver that does to a child what a real one would end up doing: records that it was
 * started for it, then writes a terminal status into its `run.json`. What status, and
 * what merge request it opened, are read from files a test writes before it runs.
 */
const driverScript = (root: string, log: string, stateDir: string) =>
  `printf '%s\\n' "$COLLIE_RUN" >> "${log}"
sleep 0.05
f="${stateDir}/runs/$COLLIE_RUN/run.json"
parent=$(sed -n 's/.*"parent":"\\([^"]*\\)".*/\\1/p' "$f")
sed -n 's/.*"status":"\\([^"]*\\)".*/\\1/p' "${stateDir}/runs/$parent/run.json" | head -1 >> "${log}.parent"
# Per-repository where a test asks for it, so one wave can hold a failure and a
# success: the child's own repo input is what names the file.
# The first match, not a greedy one: input_sources carries a "repo" key of its own.
key=$(grep -o '"repo":"[^"]*"' "$f" | head -1 | sed 's/.*:"//;s/"$//' | tr / -)
status=$(cat "${root}/driver-status-$key" 2>/dev/null || cat "${root}/driver-status" 2>/dev/null || echo done)
mr=$(cat "${root}/driver-mr-$key" 2>/dev/null || cat "${root}/driver-mr" 2>/dev/null || echo "")
# The merge request first and the status last, as a real Driver records them: a parent
# watching for a terminal status would otherwise read the record between the two.
if [ -n "$mr" ]; then sed -i "s|\\"mr_url\\":null|\\"mr_url\\":\\"$mr\\"|" "$f"; fi
sed -i "0,/\\"status\\":\\"running\\"/s//\\"status\\":\\"$status\\"/" "$f"
`;

beforeEach(() =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      rig = yield* Rig.make();
      yield* rig.startSocket();
      yield* installBaseline(rig);
      bin = yield* FakeBin.make(path.join(rig.root, "bin"));
      yield* bin.add("glab", `exit 1`);
      // Every directory is its own repository, so a child rooted at one repo of the
      // plan is given a checkout of that repo rather than of the plan's root.
      yield* bin.add(
        "git",
        `case "$*" in
  "worktree list --porcelain") printf 'worktree %s\\nbranch refs/heads/master\\n' "$PWD" ;;
  "worktree add"*) mkdir -p "$3" && printf 'gitdir: %s/.gitdir\\n' "$3" > "$3/.git" ;;
  *) echo main ;;
esac`,
      );
      yield* writeDef(rig.baselineDir, "workflows", "multi-parent", PARENT);
      // The checkouts the tickets name, under the plan run's root.
      for (const repo of ["cego/api", "cego/web"]) {
        yield* fs.makeDirectory(path.join(rig.projectDir, repo), { recursive: true });
        yield* fs.writeFileString(path.join(rig.projectDir, repo, ".git"), "gitdir: .\n");
      }
      driverLog = path.join(rig.root, "drivers");
      const driver = path.join(rig.root, "fake-driver");
      yield* fs.writeFileString(
        driver,
        `#!/bin/sh\n${driverScript(rig.root, driverLog, rig.stateDir)}`,
        {
          mode: 0o755,
        },
      );
      driverLayer = ConfigProvider.layer(ConfigProvider.fromUnknown({ COLLIE_DRIVER: driver }));
    }),
  ),
);

afterEach(() =>
  runEffect(
    Effect.gen(function* () {
      yield* bin.restore();
      yield* rig.close();
    }),
  ),
);

function runWorkflowEffect(...args: Parameters<typeof runWorkflow>) {
  return runWorkflow(...args).pipe(Effect.provide(driverLayer));
}

const started = () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const log = yield* fs.readFileString(driverLog).pipe(Effect.catch(() => Effect.succeed("")));
    return log.trim() === "" ? [] : log.trim().split("\n");
  });

/**
 * The same Run again, as a resumed Driver executes it: nothing is created, the steps
 * that were left unfinished are picked up.
 */
const reExecute = Effect.fn("fanout.reExecute")(function* (run: Run, prompts: EnginePrompts) {
  const env = rig.pluginEnv();
  const configEnv = rig.env();
  const defs = yield* layers(env).pipe(Effect.flatMap(loadDefinitions));
  const defaults = yield* testDefaults(env.configDir);
  const lines: string[] = [];
  for (const step of run.record.steps) if (step.status !== "done") step.status = "pending";
  run.record.status = "running";
  yield* run.save();
  const status = yield* executeRun({
    herdr: new EffectFakeHerdr(env, configEnv),
    defs,
    defaults,
    wf: resolveWorkflow(run.record.workflow, defs, defaults),
    run,
    env,
    prompts,
    out: (line) =>
      Effect.sync(() => {
        lines.push(line);
      }),
  }).pipe(
    Effect.provide(driverLayer),
    Effect.catch(() => Effect.succeed("failed")),
  );
  return { status, lines };
});

/** The Driver's ownership claim, as `src/driver.ts` reads it back. */
const encodeClaim = Schema.encodeSync(
  Schema.fromJsonString(
    Schema.Struct({ pid: Schema.Int, start: Schema.NullOr(Schema.String), at: Schema.String }),
  ),
);
const NOW = "2026-09-04T10:00:00.000Z";

/**
 * A parent mid-fan-out and the repository run of its first wave, with nothing driving
 * either — which is what a stop from another pane finds.
 */
const fannedOutPair = Effect.fn("fanout.fannedOutPair")(function* () {
  const store = new RunStore(rig.stateDir);
  const seed = { cwd: rig.projectDir, inputs: {}, inputSources: {}, maxIterations: 1 };
  const child = yield* store.create({
    ...seed,
    workflow: "implement",
    stepIds: ["build"],
    namedAfter: "add-a-version-flag",
  });
  const parent = yield* store.create({
    ...seed,
    workflow: "multi-parent",
    stepIds: ["draft", "next"],
    namedAfter: "add-a-version-flag",
  });
  parent.record.fanout = {
    step: "next",
    title: "Implement now",
    waves: [["cego/api"], ["cego/web"]],
    runs: { "cego/api": child.id },
    mrs: {},
    wave: 1,
    blocked: null,
  };
  yield* parent.save();
  return { parent, child };
});

test("a two-repo plan chains one run per repository, in waves, and the parent waits", () =>
  runEffect(
    Effect.gen(function* () {
      yield* rig.queueOutputs([plan(TWO_REPOS)]);

      const { run, status } = yield* runWorkflowEffect(
        rig,
        "multi-parent",
        { goal: "Add a version flag" },
        { prompts: scriptedPrompts(["Implement now"]) },
      );

      expect(status).toBe("done");
      expect(run.record.fanout?.waves).toEqual([["cego/api"], ["cego/web"]]);
      const runs = run.record.fanout!.runs;
      expect(Object.keys(runs).sort()).toEqual(["cego/api", "cego/web"]);
      // The contract repo's run is started, waited on and only then the one after it.
      expect(yield* started()).toEqual([runs["cego/api"]!, runs["cego/web"]!]);

      const store = new RunStore(rig.stateDir);
      const path = yield* Path.Path;
      for (const repo of ["cego/api", "cego/web"]) {
        const child = yield* store.load(runs[repo]!);
        expect(child.record.workflow).toBe("implement");
        expect(child.record.parent).toBe(run.id);
        // Its share of the plan, and the plan itself: one plan directory, several runs.
        expect(child.record.inputs.repo).toBe(repo);
        expect(child.record.inputs.plan).toBe(`${run.dir}/plan`);
        // The checkout is of that repository, not of the plan's root: worktrees are laid
        // out under the repository they are of.
        expect(child.record.worktree?.path).toContain(`/${path.basename(repo)}/`);
      }
      // One branch name in every repository, so the sibling merge requests are findable.
      const branches = new Set<string>();
      for (const repo of ["cego/api", "cego/web"]) {
        branches.add((yield* store.load(runs[repo]!)).record.worktree!.branch);
      }
      // The task's own name under the operator's login — not the plan directory Collie
      // chained, and not the whole goal the parent was named after.
      expect([...branches]).toEqual([`${TEST_LOGIN}/version-flag`]);
      expect(run.record.children).toEqual([runs["cego/api"]!, runs["cego/web"]!]);
    }),
  ));

test("the parent is still running while a repository run of its own is", () =>
  runEffect(
    Effect.gen(function* () {
      yield* rig.queueOutputs([plan(TWO_REPOS)]);

      yield* runWorkflowEffect(
        rig,
        "multi-parent",
        { goal: "Add a version flag" },
        { prompts: scriptedPrompts(["Implement now"]) },
      );

      const fs = yield* FileSystem.FileSystem;
      // What each child's Driver read on the parent as it started: the parent that
      // finished `done` the moment it chained is what this replaces.
      const seen = (yield* fs.readFileString(`${driverLog}.parent`)).trim().split("\n");
      expect(seen).toEqual(["running", "running"]);
    }),
  ));

test("stopping the parent stops the repository runs it started", () =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const { parent, child } = yield* fannedOutPair();

      const stopped = yield* stopRun(
        rig.stateDir,
        new Herdr(rig.pluginEnv()),
        parent,
        "stop-the-plan",
      );

      expect(stopped.ok).toBe(true);
      expect(yield* fs.exists(path.join(child.dir, "stopped"))).toBe(true);
      expect(yield* fs.exists(path.join(parent.dir, "stopped"))).toBe(true);
    }),
  ));

test("a repository run that will not stop leaves the parent running, and says which", () =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const { parent, child } = yield* fannedOutPair();
      // A claim this process answers to with no start time: `liveOwner` deliberately
      // treats that as alive and `stopDriver` refuses to signal what it cannot
      // identify, which is the one way a child declines to stop.
      yield* fs.writeFileString(
        path.join(child.dir, "runner.pid"),
        `${encodeClaim({ pid: globalThis.process.pid, start: null, at: NOW })}\n`,
      );

      const stopped = yield* stopRun(
        rig.stateDir,
        new Herdr(rig.pluginEnv()),
        parent,
        "stop-the-plan",
      );

      // Not `ok`: saying the plan had stopped would leave the operator believing a
      // repository run that is still orchestrating agents had ended.
      if (stopped.ok) throw new Error("expected the stop to be refused");
      expect(stopped.error.message).toContain("cego/api");
      expect(stopped.error.message).toContain(child.id);
      // The parent is left alone, so it is still waiting on that run and a second
      // `run stop` still means something.
      expect(yield* fs.exists(path.join(parent.dir, "stopped"))).toBe(false);
    }),
  ));

test("a plan that was built keeps what it recorded when someone stops it", () =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const { parent, child } = yield* fannedOutPair();
      // Every repository built and the parent finished: the fan-out is over, so this
      // is a succeeded run like any other.
      child.record.status = "done";
      yield* child.save();
      parent.record.fanout = {
        ...parent.record.fanout!,
        runs: { "cego/api": child.id, "cego/web": child.id },
        wave: 0,
      };
      parent.record.status = "done";
      parent.record.finished_at = NOW;
      for (const step of parent.record.steps) step.status = "done";
      yield* parent.save();

      const stopped = yield* stopRun(
        rig.stateDir,
        new Herdr(rig.pluginEnv()),
        parent,
        "stop-the-plan",
      );

      if (stopped.ok) throw new Error("expected the stop to be refused");
      expect(stopped.error.code).toBe("invalid_state");
      // Nothing overwritten: the board, `run show` and `run wait` still say it was built.
      expect(yield* fs.exists(path.join(parent.dir, "stopped"))).toBe(false);
      const reread = yield* new RunStore(rig.stateDir).load(parent.id);
      expect(reread.record.status).toBe("done");
      expect(reread.record.finished_at).toBe(NOW);
    }),
  ));

test("a resumed parent picks up the fan-out of the step that started it, not another", () =>
  runEffect(
    Effect.gen(function* () {
      yield* rig.queueOutputs([plan(TWO_REPOS)]);
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      yield* fs.writeFileString(path.join(rig.root, "driver-status"), "blocked\n");
      const first = yield* runWorkflowEffect(
        rig,
        "multi-parent",
        { goal: "Add a version flag" },
        { prompts: scriptedPrompts(["Implement now"]) },
      );
      const runs = { ...first.run.record.fanout!.runs };

      // The same unfinished fan-out, recorded against a step this workflow does not
      // reach here. Titles are deliberately not unique across steps, so the title alone
      // would have re-entered the wave loop in whichever step matched first.
      first.run.record.fanout = { ...first.run.record.fanout!, step: "some-other-step" };
      yield* first.run.save();
      const again = yield* reExecute(first.run, scriptedPrompts(["Stop here"]));

      // Asked rather than resumed, and nothing of the fan-out touched.
      expect(again.status).toBe("done");
      expect(again.lines.join("\n")).not.toContain("resumed");
      expect(first.run.record.fanout!.runs).toEqual(runs);
      expect(first.run.record.choices.map((c) => c.title)).toEqual(["Implement now", "Stop here"]);
    }),
  ));

test("a resumed parent skips what succeeded, resumes what failed and starts the rest", () =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      yield* rig.queueOutputs([plan(TWO_REPOS)]);
      yield* fs.writeFileString(path.join(rig.root, "driver-status"), "blocked\n");

      const first = yield* runWorkflowEffect(
        rig,
        "multi-parent",
        { goal: "Add a version flag" },
        { prompts: scriptedPrompts(["Implement now"]) },
      );
      expect(first.status).toBe("blocked");
      const api = first.run.record.fanout!.runs["cego/api"]!;

      // Whatever went wrong is fixed, and the plan is resumed rather than picked again.
      yield* fs.writeFileString(path.join(rig.root, "driver-status"), "done\n");
      const again = yield* reExecute(first.run, scriptedPrompts([]));

      expect(again.status).toBe("done");
      const runs = first.run.record.fanout!.runs;
      // The repository that failed is resumed as itself rather than started again, so
      // no second merge request is opened for it.
      expect(runs["cego/api"]).toBe(api);
      expect(yield* started()).toEqual([api, api, runs["cego/web"]!]);
      // And nothing asked the human anything: the record was the answer.
      expect(again.lines.join("\n")).toContain("cego/api resumed");
    }),
  ));

test("a plan naming one repository by path is a wave of one, rooted there", () =>
  runEffect(
    Effect.gen(function* () {
      // Started from a folder of checkouts and touching only one of them: the root is
      // not a repository, so a run rooted there has nowhere to work. This is the shape
      // that used to end at "nothing started" — the failure the fan-out exists to fix.
      yield* rig.queueOutputs([
        plan({
          "plan/issues/01-api.md": ticket("01: the contract", "cego/api"),
          "plan/issues/02-api.md": ticket("02: the callback", "cego/api", "01"),
        }),
      ]);

      const { run, status } = yield* runWorkflowEffect(
        rig,
        "multi-parent",
        { goal: "Add a version flag" },
        { prompts: scriptedPrompts(["Implement now"]) },
      );

      expect(status).toBe("done");
      expect(run.record.fanout?.waves).toEqual([["cego/api"]]);
      const child = yield* new RunStore(rig.stateDir).load(run.record.fanout!.runs["cego/api"]!);
      // Its own repository, and its share of the plan named as such.
      expect(child.record.inputs.repo).toBe("cego/api");
      const path = yield* Path.Path;
      expect(child.record.worktree?.path).toContain(`/${path.basename("cego/api")}/`);
    }),
  ));

test("repositories that block nothing start in one wave", () =>
  runEffect(
    Effect.gen(function* () {
      yield* rig.queueOutputs([
        plan({
          "plan/issues/01-api.md": ticket("01: the contract", "cego/api"),
          "plan/issues/02-web.md": ticket("02: the page", "cego/web"),
        }),
      ]);

      const { run, status } = yield* runWorkflowEffect(
        rig,
        "multi-parent",
        { goal: "Add a version flag" },
        { prompts: scriptedPrompts(["Implement now"]) },
      );

      expect(status).toBe("done");
      expect(run.record.fanout?.waves).toEqual([["cego/api", "cego/web"]]);
      expect(yield* started()).toHaveLength(2);
    }),
  ));

test("a repository built beside one that failed still has its merge request listed", () =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      // One wave, two repositories: both start, so both are left to finish. The one
      // that was built has a merge request, and the parent is the only place a sibling's
      // is findable from.
      yield* rig.queueOutputs([
        plan({
          "plan/issues/01-api.md": ticket("01: the contract", "cego/api"),
          "plan/issues/02-web.md": ticket("02: the page", "cego/web"),
        }),
      ]);
      yield* fs.writeFileString(path.join(rig.root, "driver-status-cego-api"), "blocked\n");
      yield* fs.writeFileString(
        path.join(rig.root, "driver-mr-cego-web"),
        "https://gitlab.example.com/g/web!3\n",
      );

      const { run, status } = yield* runWorkflowEffect(
        rig,
        "multi-parent",
        { goal: "Add a version flag" },
        { prompts: scriptedPrompts(["Implement now"]) },
      );

      expect(status).toBe("blocked");
      expect(run.record.fanout?.blocked).toEqual({ repo: "cego/api", status: "failed" });
      // Not dropped because a sibling of its own wave failed first.
      expect(run.record.fanout?.mrs["cego/web"]).toBe("https://gitlab.example.com/g/web!3");
      expect(run.record.summary).toContain("https://gitlab.example.com/g/web!3");
    }),
  ));

test("a repository that cannot be started leaves its wave's siblings waited on", () =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      // One wave, two repositories with no edge between them. The second has no checkout
      // to work in by the time the fan-out reaches it, so nothing can be started for it —
      // and the first is already building.
      yield* rig.queueOutputs([
        plan({
          "plan/issues/01-api.md": ticket("01: the contract", "cego/api"),
          "plan/issues/02-web.md": ticket("02: the page", "cego/web"),
        }),
      ]);
      yield* fs.writeFileString(
        path.join(rig.root, "driver-mr-cego-api"),
        "https://gitlab.example.com/g/api!9\n",
      );
      // `worktree add` refuses for the second repository only, which is what leaves
      // `chain` with nowhere to work for it.
      yield* bin.add(
        "git",
        `case "$*" in
  "worktree list --porcelain") printf 'worktree %s\\nbranch refs/heads/master\\n' "$PWD" ;;
  "worktree add"*) case "$3" in *web*) exit 1 ;; esac
    mkdir -p "$3" && printf 'gitdir: %s/.gitdir\\n' "$3" > "$3/.git" ;;
  *) echo main ;;
esac`,
      );

      const { run, status } = yield* runWorkflowEffect(
        rig,
        "multi-parent",
        { goal: "Add a version flag" },
        { prompts: scriptedPrompts(["Implement now"]) },
      );

      expect(status).toBe("blocked");
      // The one that could not start is what the parent is blocked on.
      expect(run.record.fanout?.blocked).toEqual({ repo: "cego/web", status: "not started" });
      // And the sibling already building was waited on rather than abandoned, so its
      // merge request is on the parent where the operator looks for it.
      expect(run.record.fanout?.mrs["cego/api"]).toBe("https://gitlab.example.com/g/api!9");
      expect(run.record.summary).toContain("https://gitlab.example.com/g/api!9");
    }),
  ));

test("a parent adopts a repository run it started but had not recorded", () =>
  runEffect(
    Effect.gen(function* () {
      // The gap between `chain` handing a child its Driver and this record learning which
      // repository it is for: an interrupt there used to leave a run nothing could see —
      // not stopped with the plan, and started again by a resume on the same branch.
      const { parent, child } = yield* fannedOutPair();
      child.record.inputs.repo = "cego/api";
      // Already built, so the wait on it returns at once and the fan-out carries on.
      child.record.status = "done";
      yield* child.save();
      parent.record.children.push(child.id);
      parent.record.fanout = { ...parent.record.fanout!, runs: {}, wave: 1 };
      // Its own drafting is behind it: the step to pick up is the fan-out.
      parent.record.steps[0]!.status = "done";
      yield* parent.save();

      const again = yield* reExecute(parent, scriptedPrompts([]));

      expect(again.lines.join("\n")).toContain(`cego/api was already started as ${child.id}`);
      // Adopted rather than started again: no second run for that repository.
      expect(parent.record.fanout?.runs["cego/api"]).toBe(child.id);
      expect(yield* started()).not.toContain(child.id);
    }),
  ));

test("a child that fails stops the next wave and the parent ends blocked naming it", () =>
  runEffect(
    Effect.gen(function* () {
      yield* rig.queueOutputs([plan(TWO_REPOS)]);
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      yield* fs.writeFileString(path.join(rig.root, "driver-status"), "blocked\n");

      const { run, status } = yield* runWorkflowEffect(
        rig,
        "multi-parent",
        { goal: "Add a version flag" },
        { prompts: scriptedPrompts(["Implement now"]) },
      );

      expect(status).toBe("blocked");
      expect(run.step("next").note).toContain("cego/api failed");
      expect(run.record.fanout?.blocked).toEqual({ repo: "cego/api", status: "failed" });
      // The repository after it was never started, and the summary says why.
      expect(Object.keys(run.record.fanout!.runs)).toEqual(["cego/api"]);
      expect(yield* started()).toHaveLength(1);
      expect(run.record.summary).toContain("cego/web: not run: waiting on cego/api");
    }),
  ));

test("a plan blocked by a failed repository says so rather than asking for you", () =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      yield* rig.queueOutputs([plan(TWO_REPOS)]);
      yield* fs.writeFileString(path.join(rig.root, "driver-status"), "blocked\n");

      const { run } = yield* runWorkflowEffect(
        rig,
        "multi-parent",
        { goal: "Add a version flag" },
        { prompts: scriptedPrompts(["Implement now"]) },
      );

      // The toast the operator gets: US14 asks to be told which repository stopped the
      // plan, and "next needs you" sent them looking for a question nobody had asked.
      const toast = (yield* rig.calls()).filter((c) => c.cmd === "notification show").at(-1)!.argv!;
      expect(toast.at(-1)).toContain("cego/api");
      expect(toast.at(-1)).not.toContain("needs you");
      expect(run.step("next").note).toContain("cego/api failed");
    }),
  ));

test("the parent's summary lists every repository's merge request", () =>
  runEffect(
    Effect.gen(function* () {
      yield* rig.queueOutputs([plan(TWO_REPOS)]);
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      yield* fs.writeFileString(
        path.join(rig.root, "driver-mr"),
        "https://gitlab.example.com/g/p!7\n",
      );

      const { run } = yield* runWorkflowEffect(
        rig,
        "multi-parent",
        { goal: "Add a version flag" },
        { prompts: scriptedPrompts(["Implement now"]) },
      );

      expect(run.record.summary).toContain("Repository runs:");
      for (const repo of ["cego/api", "cego/web"]) {
        expect(run.record.summary).toContain(`${repo}: ${run.record.fanout!.runs[repo]!}`);
      }
      expect(run.record.summary).toContain("https://gitlab.example.com/g/p!7");
    }),
  ));

const REFUSALS = {
  // Two repositories whose tickets interleave: neither can go first.
  cycle: {
    tickets: {
      "plan/issues/01-api.md": ticket("01: the contract", "cego/api"),
      "plan/issues/02-web.md": ticket("02: the page", "cego/web", "01"),
      "plan/issues/03-api.md": ticket("03: the callback", "cego/api", "02"),
    },
    says: "block each other",
  },
  // One ticket says nothing about where it belongs, while its sibling does.
  "missing-repo": {
    tickets: {
      "plan/issues/01-api.md": ticket("01: the contract", "cego/api"),
      "plan/issues/02-web.md":
        "# 02: the page\n\n**Blocked by:** 01\n\n**Status:** ready-for-agent\n",
    },
    says: "02-web.md",
  },
  // A repository nobody has cloned under the plan's root.
  "missing-checkout": {
    tickets: {
      "plan/issues/01-api.md": ticket("01: the contract", "cego/api"),
      "plan/issues/02-cli.md": ticket("02: the flag", "cego/cli", "01"),
    },
    says: "cego/cli",
  },
  // A repository that is not under the root at all.
  "outside-root": {
    tickets: {
      "plan/issues/01-api.md": ticket("01: the contract", "cego/api"),
      "plan/issues/02-out.md": ticket("02: the other project", "../other-project", "01"),
    },
    says: "../other-project",
  },
  // A "Blocked by" line naming something that is not a ticket of this plan.
  "unknown-blocker": {
    tickets: {
      "plan/issues/01-api.md": ticket("01: the contract", "cego/api"),
      "plan/issues/02-web.md": ticket("02: the page", "cego/web", "the API contract"),
    },
    says: "02-web.md",
  },
  // Two tickets wearing one number, so an edge onto it cannot say which it means.
  "duplicate-ticket": {
    tickets: {
      "plan/issues/01-api.md": ticket("01: the contract", "cego/api"),
      "plan/issues/01-web.md": ticket("01: the page", "cego/web"),
    },
    says: "numbered the same",
  },
} satisfies Record<string, { tickets: Record<string, string>; says: string }>;

for (const [why, kase] of Object.entries(REFUSALS)) {
  test(`a plan with a ${why} is refused when picked, and the menu comes back`, () =>
    runEffect(
      Effect.gen(function* () {
        yield* rig.queueOutputs([plan(kase.tickets)]);
        // Picked, refused, and then picked again: the second pick is what shows the menu
        // came back rather than the run ending on the refusal.
        const { run, status, lines } = yield* runWorkflowEffect(
          rig,
          "multi-parent",
          { goal: "Add a version flag" },
          { prompts: scriptedPrompts(["Implement now", "Stop here"]) },
        );

        expect(status).toBe("done");
        expect(lines.join("\n")).toContain(kase.says);
        expect(run.record.children).toEqual([]);
        expect(run.record.fanout).toBeNull();
        expect(run.record.choices.map((c) => c.title)).toEqual(["Implement now", "Stop here"]);
        expect(yield* started()).toEqual([]);
      }),
    ));
}

test("a plan rooted where there is nowhere to work starts nothing, and the menu comes back", () =>
  runEffect(
    Effect.gen(function* () {
      // The case the whole hand-off exists for, from the other side: a single-repository
      // plan whose root is not a checkout. Nothing in the reading refuses it — the
      // checkout resolver does — so this is the one refusal path the fan-out relies on
      // and does not own.
      yield* bin.add("git", "echo main");
      yield* rig.queueOutputs([
        plan({ "plan/issues/01-only.md": ticket("01: the only one", ".") }),
      ]);

      const { run, status, lines } = yield* runWorkflowEffect(
        rig,
        "multi-parent",
        { goal: "Add a version flag" },
        { prompts: scriptedPrompts(["Implement now", "Stop here"]) },
      );

      expect(status).toBe("done");
      expect(lines.join("\n")).toContain("has nowhere to work");
      expect(run.record.children).toEqual([]);
      expect(run.record.fanout).toBeNull();
      // Picked, refused, and picked again: the menu came back rather than the run
      // ending on the refusal.
      expect(run.record.choices.map((c) => c.title)).toEqual(["Implement now", "Stop here"]);
      expect(yield* started()).toEqual([]);
    }),
  ));

test("a single-repository plan chains exactly one run and the parent finishes as today", () =>
  runEffect(
    Effect.gen(function* () {
      yield* rig.queueOutputs([
        plan({ "plan/issues/01-only.md": ticket("01: the only one", ".") }),
      ]);

      const { run, status } = yield* runWorkflowEffect(
        rig,
        "multi-parent",
        { goal: "Add a version flag" },
        { prompts: scriptedPrompts(["Implement now"]) },
      );

      expect(status).toBe("done");
      expect(run.record.fanout).toBeNull();
      expect(run.record.children).toHaveLength(1);
      const child = yield* new RunStore(rig.stateDir).load(run.record.children[0]!);
      expect(child.record.inputs.repo).toBe("");
      expect(run.record.summary).toContain(`Chained: ${child.id}`);
    }),
  ));

import { Clock, Effect, FileSystem, Path } from "effect";
import { nowIso } from "../src/time";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { REVIEW_FILE } from "../src/output";
import { liveRole, record, type Session } from "../src/handoff";
import { acquireDriver, readInboxMidStep, RUNNER_PID, STOPPED } from "../src/driver";
import { liveEntries, readRegistry, registerAgent, registryPath, scopeFor } from "../src/registry";
import { RunStore, type HandoffRecord } from "../src/run";
import type { AgentInfo } from "../src/herdr";
import { FakeBin } from "./support/bin";
import { runEffect } from "./support/effect";
import { installBaseline, runWorkflow, scriptedPrompts } from "./support/engine";
import { scriptedPort } from "./support/compaction";
import { installControls } from "../src/compaction";
import { FakeHerdr, Rig } from "./support/recorder";

let rig: Rig;
let bin: FakeBin;

const CLEAN = { verdict: "clean", findings: [] };
const SYNTH = { verdict: "clean", findings: [], summary: "Nothing to fix.", dropped: [] };
const FOUND = {
  verdict: "findings",
  summary: "One blocker.",
  findings: [
    { file: "cli.js", line: 4, severity: "blocker", title: "wrong exit code", detail: "d" },
  ],
  dropped: [],
};

function must<T>(value: T | null | undefined, label: string): T {
  expect(value, label).toBeDefined();
  if (value === null || value === undefined) throw new Error(label);
  return value;
}

function session(env: ReturnType<Rig["pluginEnv"]>): Session {
  return { herdr: new FakeHerdr(env), stateDir: env.stateDir, ...scopeFor(env, env.cwd) };
}

const readText = Effect.fn("sessionTest.readText")(function* (file: string) {
  const fs = yield* FileSystem.FileSystem;
  return yield* fs.readFileString(file);
});

const fileExists = Effect.fn("sessionTest.fileExists")(function* (file: string) {
  const fs = yield* FileSystem.FileSystem;
  return yield* fs.exists(file);
});

const removeFile = Effect.fn("sessionTest.removeFile")(function* (file: string) {
  const fs = yield* FileSystem.FileSystem;
  yield* fs.remove(file);
});

/** The checkout the reviewed branch already has, as both the git fixture and the test see it. */
const featureWorktree = (path: Path.Path) => path.join(rig.root, "worktrees", "feature");

beforeEach(() =>
  runEffect(
    Effect.gen(function* () {
      const path = yield* Path.Path;
      rig = yield* Rig.make();
      yield* rig.startSocket();
      yield* installBaseline(rig);
      bin = yield* FakeBin.make(path.join(rig.root, "bin"));
      yield* bin.add("glab", "exit 1");
      yield* bin.add(
        "git",
        `case "$*" in
      "rev-parse --git-dir") echo .git ;;
      "rev-parse --abbrev-ref HEAD") echo feature ;;
      # The repository and the checkout the reviewed branch already has, which is
      # where a chained fix round has to land.
      "worktree list --porcelain") printf 'worktree %s\nbranch refs/heads/master\n\nworktree %s\nbranch refs/heads/feature\n' "${rig.projectDir}" "${featureWorktree(path)}" ;;
      # A plan change is found with a real \`git diff --no-index\`, so that one is not faked.
      diff*) exec /usr/bin/git "$@" ;;
      *) echo main ;;
    esac`,
      );
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

/** An implementer already working in this Session, as a run of its own would leave it. */
const liveImplementer = Effect.fn("sessionTest.liveImplementer")(function* (
  agent = "impl-1",
  paneId = "1-9",
) {
  const env = rig.pluginEnv();
  const run = yield* new RunStore(env.stateDir).create({
    workflow: "implement",
    cwd: env.cwd,
    session: env.socketPath,
    workspace: env.workspaceId,
    workspaceLabel: "test",
    inputs: { plan: "p" },
    inputSources: { plan: "asked" },
    inputStrategies: { plan: "work-source" },
    stepIds: ["build"],
    maxIterations: 5,
    namedAfter: "add-a-picker",
  });
  const file = yield* registryPath(env.stateDir, scopeFor(env, env.cwd));
  yield* registerAgent(file, {
    role: "implementer",
    agent,
    paneId,
    workspaceId: env.workspaceId,
    runId: run.id,
    workflow: "implement",
    at: yield* nowIso(),
    incarnation: { terminalId: `term-${agent}`, agentSession: null },
  });
  // The fake `agent list` answers from the agents it has been asked to start, so the
  // rig is told about this one the same way.
  yield* rig.addAgent(agent, paneId);
  // A hand-off is queued for the target Run's Driver, so there has to be one: this
  // process's own claim stands in for it.
  yield* acquireDriver(run.dir);
  return {
    name: agent,
    paneId,
    workspaceId: env.workspaceId,
    status: "idle",
    title: null,
    terminalId: `term-${agent}`,
    agentSession: null,
  } satisfies AgentInfo;
});

test("an agent whose run failed no longer takes hand-offs", () =>
  runEffect(
    Effect.gen(function* () {
      yield* liveImplementer();
      const env = rig.pluginEnv();
      const run = must((yield* new RunStore(env.stateDir).list()).at(0), "expected implement run");
      expect(yield* liveRole(session(env), "implementer")).not.toBeNull();

      run.record.status = "failed";
      yield* run.save();
      expect(yield* liveRole(session(env), "implementer")).toBeNull();
    }),
  ));

test("an agent whose run was stopped no longer takes hand-offs", () =>
  runEffect(
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const fs = yield* FileSystem.FileSystem;
      yield* liveImplementer();
      const env = rig.pluginEnv();
      const run = must((yield* new RunStore(env.stateDir).list()).at(0), "expected implement run");

      yield* fs.writeFileString(path.join(run.dir, STOPPED), "t\n");
      expect(yield* liveRole(session(env), "implementer")).toBeNull();
    }),
  ));

test("with an implementer live, the review hands it the findings and both runs record it", () =>
  runEffect(
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const implementer = yield* liveImplementer();
      const before = must(
        (yield* new RunStore(rig.stateDir).list()).at(0),
        "expected implement run",
      );
      yield* rig.queueOutputs([FOUND]);
      // One decision, two implementations: with an implementer live, "Fix findings"
      // is the hand-off.
      const prompts = scriptedPrompts(["Fix findings"]);

      const { run, status } = yield* runWorkflow(rig, "review", {}, { prompts });

      expect(status).toBe("done");
      expect(prompts.offered).toEqual([
        ["Fix findings", "Fix findings in a full implement run", "Don't post"],
      ]);

      // Queued for the implementer's own Driver rather than typed into its pane: the
      // Driver is what composes it into the agent's next piece of work, holds it behind
      // an unresolved compaction, and records whether it was understood.
      const queued = must(
        (yield* readInboxMidStep(before.dir)).taken.at(0)?.deliver,
        "expected a deliver in the implementer's inbox",
      );
      expect(queued.agent).toBe(implementer.name);
      expect(queued.mode).toBe("boundary");
      expect(queued.text).toContain(path.join(run.dir, REVIEW_FILE));
      // The review's own Output: with one reviewer there is no synthesis file, and the
      // hand-off points at whatever the Run recorded as its review rather than guessing.
      expect(queued.text).toContain(path.join(run.dir, "steps", "review", "review.json"));
      expect(queued.text).toContain("disagree with a finding say so with a reason");
      expect(
        (yield* rig.calls()).some(
          (c) => c.cmd === "agent prompt" && c.argv?.[2] === implementer.name,
        ),
      ).toBe(false);

      expect(run.record.handoffs).toEqual([
        {
          id: expect.any(String),
          direction: "sent",
          role: "implementer",
          agent: implementer.name,
          run: before.id,
          at: expect.any(String),
          note: `sent ${REVIEW_FILE} to the implementer`,
        },
      ]);
      const other = yield* new RunStore(rig.stateDir).load(before.id);
      expect(other.record.handoffs.map((h) => [h.direction, h.role, h.run])).toEqual([
        ["received", "implementer", run.id],
      ]);
      expect(run.step("post").note).toContain("sent");
    }),
  ));

test("with no implementer live, the review offers to start one on the reviewed target", () =>
  runEffect(
    Effect.gen(function* () {
      yield* rig.queueOutputs([FOUND]);
      const prompts = scriptedPrompts(["Fix findings in a full implement run"]);

      const { run, status } = yield* runWorkflow(rig, "review", {}, { prompts });

      expect(status).toBe("done");
      expect(prompts.offered).toEqual([
        ["Fix findings", "Fix findings in a full implement run", "Don't post"],
      ]);
      expect(run.record.children).toHaveLength(1);
      const childId = must(run.record.children.at(0), "expected child run");
      const child = yield* new RunStore(rig.stateDir).load(childId);
      expect(child.record.workflow).toBe("implement");
      expect(child.record.inputs.plan).toBe(run.dir);
      expect(child.record.inputs.plan_kind).toBe("review");
      expect(child.record.inputs.target).toBe(run.record.inputs.target);
      expect(child.record.inputs.target_kind).toBe("branch");
      expect(run.step("post").note).toContain("implement run");
    }),
  ));

test("the implement run chained from a review lands in the reviewed branch's own worktree", () =>
  runEffect(
    Effect.gen(function* () {
      const path = yield* Path.Path;
      // The branch under review already has a checkout, from whoever built it.
      const existing = featureWorktree(path);
      yield* rig.addWorktree("feature", existing, null);
      yield* rig.queueOutputs([FOUND]);

      const { run } = yield* runWorkflow(
        rig,
        "review",
        {},
        { prompts: scriptedPrompts(["Fix findings in a full implement run"]) },
      );
      const childId = must(run.record.children.at(0), "expected child run");
      const child = yield* new RunStore(rig.stateDir).load(childId);

      expect(child.record.worktree).toEqual({
        path: existing,
        branch: "feature",
        created_by_collie: false,
        managed_by: "git",
        workspace_id: null,
        // The checkout already existed, so git wrote its `.git` when whoever made it
        // ran `worktree add`; the rig's stand-in has one. And nothing was made for
        // this Run, so there is no root tab of its own to take over.
        made_at: expect.any(Number),
        root_tab_id: null,
        root_pane_id: null,
      });
      expect(child.record.cwd).toBe(existing);
      // The workspace the review was started in: the child works in the branch's own
      // checkout, and its tabs belong beside the run that chained it.
      expect(child.record.workspace).toBe("1");
      // Reused, never created: git allows one worktree per branch, and this branch
      // already has one — and herdr is not asked for a workspace of its own.
      expect((yield* rig.cmds()).filter((cmd) => cmd.startsWith("worktree"))).toEqual([]);
    }),
  ));

test("a review of a merge request chains onto that merge request's own branch", () =>
  runEffect(
    Effect.gen(function* () {
      // `implement` embeds `review`, so `target` is one of its resolved inputs and the
      // chain forwards it. That is what lets the child resolve the branch from the
      // merge request rather than from whatever branch the caller happens to be on —
      // the fake git here answers `feature` for that, and it must not be used.
      yield* bin.add("glab", `echo '{"source_branch": "fix-the-parser", "iid": 42}'`);
      yield* rig.queueOutputs([FOUND]);

      const { run } = yield* runWorkflow(
        rig,
        "review",
        { target: "mr:42" },
        { prompts: scriptedPrompts(["Fix findings in a full implement run"]) },
      );
      const childId = must(run.record.children.at(0), "expected child run");
      const child = yield* new RunStore(rig.stateDir).load(childId);

      expect(child.record.inputs.target).toBe("mr:42");
      expect(child.record.inputs.target_kind).toBe("mr");
      expect(child.record.worktree?.branch).toBe("fix-the-parser");
    }),
  ));

test("the build prompt for a review work source checks out what was reviewed", () =>
  runEffect(
    Effect.gen(function* () {
      const path = yield* Path.Path;
      yield* rig.queueOutputs([FOUND]);
      const { run } = yield* runWorkflow(
        rig,
        "review",
        {},
        { prompts: scriptedPrompts(["Fix findings in a full implement run"]) },
      );
      const childId = must(run.record.children.at(0), "expected child run");
      const child = yield* new RunStore(rig.stateDir).load(childId);

      yield* rig.queueOutputs([CLEAN]);
      const built = yield* runWorkflow(
        rig,
        "implement",
        { plan: run.dir, target: must(run.record.inputs.target, "expected target") },
        { prompts: scriptedPrompts([]) },
      );
      const prompt = yield* readText(path.join(built.run.dir, "steps", "build", "prompt-1.md"));

      expect(prompt).toContain("Work source (review)");
      expect(prompt).toContain(`${run.dir}/review.md`);
      expect(prompt).toContain(`${run.dir}/steps/synthesize/synthesized.json`);
      // The branch is settled before the agent starts, so the prompt says where it
      // already is rather than how to get there.
      expect(prompt).toContain("this checkout is already on its branch");
      expect(prompt).toContain("never create a branch or switch");
      expect(prompt).not.toContain("git checkout");
      expect(prompt).not.toContain("glab mr checkout");
      expect(child.record.inputs.plan_kind).toBe("review");
    }),
  ));

test("a plan that changes under a live implementer is sent the diff, once per change", () =>
  runEffect(
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const implementer = yield* liveImplementer();
      const planned = must(
        (yield* new RunStore(rig.stateDir).list()).at(0),
        "expected implement run",
      );
      const prompts = scriptedPrompts(["Refine", "Refine", null]);
      const menu = prompts.menu.bind(prompts);
      prompts.menu = (items, opts) =>
        Effect.gen(function* () {
          const store = new RunStore(rig.stateDir);
          const plan = (yield* store.list()).find((r) => r.record.workflow === "plan");
          if (plan) {
            const impl = yield* store.load(planned.id);
            impl.record.inputs.plan = path.join(plan.dir, "plan");
            yield* impl.save();
          }
          return yield* menu(items, opts);
        });
      yield* rig.queueOutputs([
        CLEAN,
        { __write: { "plan/SPEC.md": "# Add a picker\n" }, output: CLEAN },
        { __write: { "plan/issues/03-third.md": "# 03: third ticket\n" }, output: CLEAN },
        {
          __write: { "plan/issues/03-third.md": "# 03: third ticket, cut\n" },
          output: {
            verdict: "clean",
            findings: [],
            changed: ["cut ticket 3"],
            changelog: "Ticket 3 is gone.",
          },
        },
        { verdict: "clean", findings: [], changed: [] },
      ]);

      const { run, status } = yield* runWorkflow(
        rig,
        "plan",
        { goal: "Add a picker" },
        { prompts },
      );

      expect(status).toBe("blocked");
      expect(run.step("next").note).toBe("no choice taken");

      // Queued for the implementer's Driver, once per change, not typed into its pane.
      const prompted = (yield* readInboxMidStep(planned.dir)).taken.flatMap((command) => {
        const deliver = command.deliver;
        return deliver && deliver.agent === implementer.name ? [deliver.text] : [];
      });
      expect(
        (yield* rig.calls()).some(
          (c) => c.cmd === "agent prompt" && c.argv?.[2] === implementer.name,
        ),
      ).toBe(false);

      expect(prompted).toHaveLength(1);
      const prompt = must(prompted.at(0), "expected one prompt");
      expect(prompt).toContain("The plan you are building from has changed.");
      expect(prompt).toContain("Ticket 3 is gone.");
      expect(prompt).toContain(path.join(run.dir, "plan"));
      expect(prompt).toContain("Reconcile:");
      const patchPath = must(/is in (\S+\.patch)/.exec(prompt)?.at(1), "expected patch path");
      expect(yield* fileExists(patchPath)).toBe(true);
      expect(yield* readText(patchPath)).toContain("ticket");

      expect(run.record.handoffs.map((h) => [h.direction, h.note])).toEqual([
        ["sent", "sent the plan change to the implementer"],
      ]);
      expect((yield* new RunStore(rig.stateDir).load(planned.id)).record.handoffs).toHaveLength(1);
    }),
  ));

test("a plan change reaches only the implementer building from that plan", () =>
  runEffect(
    Effect.gen(function* () {
      yield* liveImplementer();
      const other = must(
        (yield* new RunStore(rig.stateDir).list()).at(0),
        "expected implement run",
      );
      other.record.inputs.plan = "/some/other/plan";
      yield* other.save();

      const prompts = scriptedPrompts(["Refine", null]);
      yield* rig.queueOutputs([
        CLEAN,
        { __write: { "plan/SPEC.md": "# Add a picker\n" }, output: CLEAN },
        CLEAN,
        {
          __write: { "plan/SPEC.md": "# Add a picker, revised\n" },
          output: { verdict: "clean", findings: [], changed: ["reworded"], changelog: "Reworded." },
        },
      ]);

      const { run } = yield* runWorkflow(rig, "plan", { goal: "Add a picker" }, { prompts });

      expect(
        (yield* rig.calls()).filter((c) => c.cmd === "agent prompt" && c.argv?.[2] === "impl-1"),
      ).toEqual([]);
      expect(run.record.handoffs).toEqual([]);
    }),
  ));

test("an implementer that herdr no longer has is not offered, and its entry goes", () =>
  runEffect(
    Effect.gen(function* () {
      const env = rig.pluginEnv();
      yield* liveImplementer("gone-1", "1-9");
      rig.dropAgent("gone-1");
      // The last output is the fix round's: with nothing live, "Fix findings" is the
      // round this run does itself.
      yield* rig.queueOutputs([FOUND, CLEAN]);
      const prompts = scriptedPrompts(["Fix findings", "Don't post"]);

      const { status } = yield* runWorkflow(rig, "review", {}, { prompts });

      expect(status).toBe("done");
      const offered = must(prompts.offered.at(0), "expected offered choices");
      // The hand-off twin is gone with the agent; the round that fixes it here is
      // what "Fix findings" means now.
      expect(offered).toContain("Fix findings");
      const file = yield* registryPath(env.stateDir, scopeFor(env, env.cwd));
      expect(yield* readRegistry(file)).toEqual([]);
    }),
  ));

test("the implementer is told where to take a decision the plan does not cover", () =>
  runEffect(
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const env = rig.pluginEnv();
      const planned = yield* new RunStore(env.stateDir).create({
        workflow: "plan",
        cwd: env.cwd,
        session: env.socketPath,
        workspace: env.workspaceId,
        workspaceLabel: "test",
        inputs: { goal: "g" },
        inputSources: { goal: "asked" },
        stepIds: ["grill"],
        maxIterations: 1,
        namedAfter: "add-a-picker",
      });
      const file = yield* registryPath(env.stateDir, scopeFor(env, env.cwd));
      yield* registerAgent(file, {
        role: "planner",
        agent: "plan-1",
        paneId: "1-8",
        workspaceId: env.workspaceId,
        runId: planned.id,
        workflow: "plan",
        at: "t",
        incarnation: { terminalId: "term-plan-1", agentSession: null },
      });
      yield* rig.addAgent("plan-1", "1-8");
      yield* rig.queueOutputs([CLEAN]);

      const { run } = yield* runWorkflow(rig, "implement", { plan: "build a picker" });
      const prompt = yield* readText(path.join(run.dir, "steps", "build", "prompt-1.md"));

      expect(prompt).toContain("still live as agent `plan-1` in pane `1-8`");
      expect(prompt).toContain('herdr agent prompt plan-1 "<your question>"');
      expect(prompt).toContain("herdr agent read plan-1 --lines 40");
      expect(prompt).not.toContain("There is no planner live");
    }),
  ));

test("with no planner live, the implementer is told to stop and ask instead", () =>
  runEffect(
    Effect.gen(function* () {
      const path = yield* Path.Path;
      yield* rig.queueOutputs([CLEAN]);

      const { run } = yield* runWorkflow(rig, "implement", { plan: "build a picker" });
      const prompt = yield* readText(path.join(run.dir, "steps", "build", "prompt-1.md"));

      expect(prompt).toContain("There is no planner live for this work");
      expect(prompt).toContain("stop, ask me in your own pane");
      expect(prompt).not.toContain("herdr agent prompt");
      expect(prompt).not.toContain("{{session");
    }),
  ));

test("another workspace's implementer is not this Session's", () =>
  runEffect(
    Effect.gen(function* () {
      const env = rig.pluginEnv();
      const file = yield* registryPath(env.stateDir, scopeFor(env, env.cwd));
      const elsewhere = yield* registryPath(env.stateDir, {
        session: env.socketPath,
        workspaceId: "9",
        cwd: env.cwd,
      });
      // A Run's own worktree is a different directory in the same workspace: same Session.
      const ownWorktree = yield* registryPath(env.stateDir, {
        ...scopeFor(env, env.cwd),
        cwd: "/elsewhere",
      });
      const otherSession = yield* registryPath(env.stateDir, {
        ...scopeFor(env, env.cwd),
        session: "/other.sock",
      });

      expect(ownWorktree).toBe(file);
      expect(new Set([file, elsewhere, otherSession]).size).toBe(3);

      const entry = {
        role: "implementer",
        agent: "impl-1",
        paneId: "1-9",
        workspaceId: "9",
        runId: "r1",
        workflow: "implement",
        at: "t",
      };
      yield* registerAgent(elsewhere, entry);
      expect(yield* readRegistry(file)).toEqual([]);

      yield* registerAgent(file, { ...entry, workspaceId: env.workspaceId });
      const alive: AgentInfo = {
        name: "impl-1",
        paneId: "1-9",
        workspaceId: "9",
        status: "idle",
        title: null,
        terminalId: "term-impl-1",
        agentSession: null,
      };
      expect(liveEntries([...(yield* readRegistry(file))], [alive])).toEqual([]);
      expect(
        liveEntries([...(yield* readRegistry(file))], [{ ...alive, workspaceId: env.workspaceId }]),
      ).toHaveLength(1);
    }),
  ));

test("a run registers its long-lived agent, and a reviewer is not one", () =>
  runEffect(
    Effect.gen(function* () {
      const env = rig.pluginEnv();
      yield* rig.queueOutputs([SYNTH]);

      yield* runWorkflow(rig, "review", {}, { prompts: scriptedPrompts(["Don't post"]) });

      const file = yield* registryPath(env.stateDir, scopeFor(env, env.cwd));
      expect(yield* fileExists(file)).toBe(false);
    }),
  ));

test("a received Hand-off survives the receiving Driver's stale save, exactly once", () =>
  runEffect(
    Effect.gen(function* () {
      const env = rig.pluginEnv();
      const store = new RunStore(env.stateDir);
      const mk = (workflow: string) =>
        store.create({
          workflow,
          cwd: env.cwd,
          inputs: {},
          inputSources: {},
          stepIds: ["build"],
          maxIterations: 1,
          namedAfter: workflow,
        });
      const receiver = yield* mk("implement");
      const driverCopy = yield* store.load(receiver.id);
      const sender = yield* mk("review");

      yield* record(
        session(env),
        sender,
        {
          role: "implementer",
          agent: "impl-1",
          paneId: "1-9",
          workspaceId: "1",
          runId: receiver.id,
          workflow: "implement",
          at: "",
        },
        "sent review.md to the implementer",
      );

      const sent = must(
        (yield* store.load(sender.id)).record.handoffs.at(0),
        "expected sent handoff",
      );
      const received = must(
        (yield* store.load(receiver.id)).record.handoffs.at(0),
        "expected received handoff",
      );
      expect(sent.id).toBeTruthy();
      expect(received.id).toBe(sent.id);
      expect(received.at).toBe(sent.at);
      expect(sent.direction).toBe("sent");
      expect(received.direction).toBe("received");

      driverCopy.step("build").status = "done";
      yield* driverCopy.save();
      yield* driverCopy.save();
      const after = yield* store.load(receiver.id);
      expect(after.record.handoffs.map((h) => h.id)).toEqual([sent.id]);
      expect(after.step("build").status).toBe("done");
    }),
  ));

test("a receiver that cannot be updated leaves the sender's record intact", () =>
  runEffect(
    Effect.gen(function* () {
      const env = rig.pluginEnv();
      const store = new RunStore(env.stateDir);
      const sender = yield* store.create({
        workflow: "review",
        cwd: env.cwd,
        inputs: {},
        inputSources: {},
        stepIds: ["review"],
        maxIterations: 1,
        namedAfter: "x",
      });
      const started = yield* Clock.currentTimeMillis;
      yield* record(
        session(env),
        sender,
        {
          role: "implementer",
          agent: "impl-1",
          paneId: "1-9",
          workspaceId: "1",
          runId: "no-such-run",
          workflow: "implement",
          at: "",
        },
        "sent review.md to the implementer",
      );
      expect((yield* Clock.currentTimeMillis) - started).toBeLessThan(1_000);

      const kept = (yield* store.load(sender.id)).record.handoffs;
      expect(kept).toHaveLength(1);
      expect(must(kept.at(0), "expected kept handoff").run).toBe("no-such-run");
    }),
  ));

test("recording a Hand-off can neither roll back Driver state nor duplicate on a retried write", () =>
  runEffect(
    Effect.gen(function* () {
      const env = rig.pluginEnv();
      const store = new RunStore(env.stateDir);
      const receiver = yield* store.create({
        workflow: "implement",
        cwd: env.cwd,
        inputs: {},
        inputSources: {},
        stepIds: ["build"],
        maxIterations: 1,
        namedAfter: "x",
      });
      receiver.step("build").status = "done";
      yield* receiver.save();

      const handoff = {
        id: "exchange-1",
        direction: "received",
        role: "implementer",
        agent: "impl-1",
        run: "sender-run",
        at: yield* nowIso(),
        note: "sent review.md to the implementer",
      } satisfies HandoffRecord;
      yield* store.appendHandoff(receiver.id, handoff);
      yield* store.appendHandoff(receiver.id, handoff);

      const after = yield* store.load(receiver.id);
      expect(after.record.handoffs.map((h) => h.id)).toEqual(["exchange-1"]);
      expect(after.step("build").status).toBe("done");
    }),
  ));

test("a Hand-off sent from a stale board snapshot cannot roll back the sender's Driver state", () =>
  runEffect(
    Effect.gen(function* () {
      const env = rig.pluginEnv();
      const store = new RunStore(env.stateDir);
      const mk = (workflow: string, stepIds: string[]) =>
        store.create({
          workflow,
          cwd: env.cwd,
          inputs: {},
          inputSources: {},
          stepIds,
          maxIterations: 1,
          namedAfter: workflow,
        });
      const sender = yield* mk("review", ["synthesize"]);
      const receiver = yield* mk("implement", ["build"]);
      const boardCopy = yield* store.load(sender.id);
      sender.step("synthesize").status = "done";
      sender.record.summary = "done by the driver";
      yield* sender.save();

      yield* record(
        session(env),
        boardCopy,
        {
          role: "implementer",
          agent: "impl-1",
          paneId: "1-9",
          workspaceId: "1",
          runId: receiver.id,
          workflow: "implement",
          at: "",
        },
        "sent review.md to the implementer",
      );

      const after = yield* store.load(sender.id);
      expect(after.step("synthesize").status).toBe("done");
      expect(after.record.summary).toBe("done by the driver");
      expect(after.record.handoffs.map((h) => h.direction)).toEqual(["sent"]);
      const received = (yield* store.load(receiver.id)).record.handoffs;
      expect(received.map((h) => h.direction)).toEqual(["received"]);
      expect(must(received.at(0), "expected received handoff").id).toBe(
        must(after.record.handoffs.at(0), "expected sent handoff").id,
      );
    }),
  ));

test("a sender whose record cannot be persisted still completes the exchange", () =>
  runEffect(
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const env = rig.pluginEnv();
      const store = new RunStore(env.stateDir);
      const mk = (workflow: string) =>
        store.create({
          workflow,
          cwd: env.cwd,
          inputs: {},
          inputSources: {},
          stepIds: ["s"],
          maxIterations: 1,
          namedAfter: workflow,
        });
      const sender = yield* mk("review");
      const receiver = yield* mk("implement");
      yield* removeFile(path.join(sender.dir, "run.json"));

      yield* record(
        session(env),
        sender,
        {
          role: "implementer",
          agent: "impl-1",
          paneId: "1-9",
          workspaceId: "1",
          runId: receiver.id,
          workflow: "implement",
          at: "",
        },
        "sent review.md to the implementer",
      );

      expect(sender.record.handoffs.map((h) => h.direction)).toEqual(["sent"]);
      expect((yield* store.load(receiver.id)).record.handoffs.map((h) => h.direction)).toEqual([
        "received",
      ]);
      expect(yield* readText(path.join(sender.dir, "log.txt"))).toContain("not yet persisted");
    }),
  ));

test("a Run handing off to its own agent keeps both sides of the exchange", () =>
  runEffect(
    Effect.gen(function* () {
      const env = rig.pluginEnv();
      const store = new RunStore(env.stateDir);
      const run = yield* store.create({
        workflow: "implement",
        cwd: env.cwd,
        inputs: {},
        inputSources: {},
        stepIds: ["build"],
        maxIterations: 1,
        namedAfter: "x",
      });

      yield* record(
        session(env),
        run,
        {
          role: "implementer",
          agent: "impl-1",
          paneId: "1-9",
          workspaceId: "1",
          runId: run.id,
          workflow: "implement",
          at: "",
        },
        "sent review.md to the implementer",
      );

      const after = yield* store.load(run.id);
      expect(after.record.handoffs.map((h) => h.direction).sort()).toEqual(["received", "sent"]);
      expect(new Set(after.record.handoffs.map((h) => h.id)).size).toBe(1);
    }),
  ));

/**
 * The controls a live implementer was launched with, as its own Run left them: a
 * hand-off reaches the agent from a different process, and has to find them.
 */
const installedControls = Effect.fn("sessionTest.installedControls")(function* (
  agent: string,
  scripted: ReturnType<typeof scriptedPort>,
) {
  const env = rig.pluginEnv();
  yield* installControls(
    {
      ports: scripted.ports,
      stateDir: env.stateDir,
      configured: 372_000,
      herdr: new FakeHerdr(env),
      log: () => Effect.void,
    },
    { agent, harness: "claude", cwd: env.cwd },
  );
});

test("a hand-off is queued for the receiving Driver, whatever that agent is doing", () =>
  runEffect(
    Effect.gen(function* () {
      const implementer = yield* liveImplementer();
      const planned = must(
        (yield* new RunStore(rig.stateDir).list()).at(0),
        "expected implement run",
      );
      // An unresolved compaction on the receiving agent. It no longer decides anything
      // here: the hand-off is a command to that agent's own Driver, and it is that
      // Driver's next work boundary that holds the message behind the compaction —
      // the same check every other piece of work for that agent goes through.
      const port = scriptedPort({ usage: [400_000] });
      yield* installedControls(implementer.name, port);
      yield* rig.queueOutputs([FOUND]);
      const prompts = scriptedPrompts(["Fix findings"]);

      const { run, status } = yield* runWorkflow(
        rig,
        "review",
        {},
        { prompts, compaction: port.ports },
      );

      expect(status).toBe("done");
      // Nothing was asked of the agent from here: not a compaction, not a prompt.
      expect(port.requests).toHaveLength(0);
      expect(
        (yield* rig.calls()).some(
          (c) => c.cmd === "agent prompt" && c.argv?.[2] === implementer.name,
        ),
      ).toBe(false);

      const queued = (yield* readInboxMidStep(planned.dir)).taken;
      expect(queued.map((c) => c.deliver?.agent)).toEqual([implementer.name]);
      expect(run.record.handoffs).toHaveLength(1);
    }),
  ));

test("a hand-off to a Run nobody is driving is refused rather than typed into a pane", () =>
  runEffect(
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const implementer = yield* liveImplementer();
      const planned = must(
        (yield* new RunStore(rig.stateDir).list()).at(0),
        "expected implement run",
      );
      // The Driver claim `liveImplementer` left behind, removed: an agent in a pane with
      // nothing driving its Run has nothing to compose a hand-off into its next work,
      // nothing to hold it behind a compaction, and nothing to record whether it landed.
      const fs = yield* FileSystem.FileSystem;
      yield* fs.remove(path.join(planned.dir, RUNNER_PID), { force: true });
      yield* rig.queueOutputs([FOUND]);
      const prompts = scriptedPrompts(["Fix findings", null]);

      const { run, status } = yield* runWorkflow(rig, "review", {}, { prompts });

      expect(status).toBe("blocked");
      expect(run.record.summary).toContain("no choice taken");
      expect(
        (yield* rig.calls()).some(
          (c) => c.cmd === "agent prompt" && c.argv?.[2] === implementer.name,
        ),
      ).toBe(false);
      expect(run.record.handoffs).toEqual([]);
    }),
  ));

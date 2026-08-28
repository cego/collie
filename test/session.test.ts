import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Rig } from "./support/recorder";
import { FakeBin } from "./support/bin";
import { installBaseline, runWorkflow, scriptedPrompts } from "./support/engine";
import { REVIEW_FILE } from "../src/output";
import { liveEntries, readRegistry, registerAgent, registryPath, scopeFor } from "../src/registry";
import { RunStore } from "../src/run";
import type { AgentInfo } from "../src/herdr";

let rig: Rig;
let bin: FakeBin;

const CLEAN = { verdict: "clean", findings: [] };
const SYNTH = { verdict: "clean", findings: [], summary: "Nothing to fix.", dropped: [] };
const FOUND = {
  verdict: "findings",
  summary: "One blocker.",
  findings: [{ file: "cli.js", line: 4, severity: "blocker", title: "wrong exit code", detail: "d" }],
  dropped: [],
};

beforeEach(async () => {
  rig = new Rig();
  await rig.startSocket();
  installBaseline(rig);
  bin = new FakeBin(join(rig.root, "bin"));
  bin.add("glab", `exit 1`);
  bin.add(
    "git",
    `case "$*" in
      "rev-parse --git-dir") echo .git ;;
      "rev-parse --abbrev-ref HEAD") echo feature ;;
      # A plan change is found with a real `+"`git diff --no-index`"+`, so that one is not faked.
      diff*) exec /usr/bin/git "$@" ;;
      *) echo main ;;
    esac`,
  );
});

afterEach(async () => {
  bin.restore();
  await rig.close();
});

/** An implementer already working in this Session, as a run of its own would leave it. */
function liveImplementer(agent = "impl-1", paneId = "1-9"): AgentInfo {
  const env = rig.pluginEnv();
  const run = new RunStore(env.stateDir).create({
    workflow: "implement",
    cwd: env.cwd,
    session: env.socketPath,
    workspace: env.workspaceId,
    workspaceLabel: "test",
    inputs: { plan: "p" },
    inputSources: { plan: "asked" },
    stepIds: ["build"],
    maxIterations: 5,
    primaryInput: "add-a-picker",
  });
  registerAgent(registryPath(env.stateDir, scopeFor(env, env.cwd)), {
    role: "implementer",
    agent,
    paneId,
    workspaceId: env.workspaceId,
    runId: run.id,
    workflow: "implement",
    at: new Date().toISOString(),
  });
  // The fake `agent list` answers from the agents it has been asked to start, so the
  // rig is told about this one the same way.
  rig.addAgent(agent, paneId);
  return { name: agent, paneId, workspaceId: env.workspaceId, status: "idle" };
}

test("with an implementer live, the review hands it the findings and both runs record it", async () => {
  const implementer = liveImplementer();
  const before = new RunStore(rig.stateDir).list()[0]!;
  rig.queueOutputs([CLEAN, CLEAN, FOUND]);
  const prompts = scriptedPrompts(["Send to implementer"]);

  const { run, status } = await runWorkflow(rig, "review", {}, { prompts });

  expect(status).toBe("done");
  // The hand-off is first, so Enter takes it, and Fix findings is not offered at all:
  // one implementer per workspace.
  expect(prompts.offered).toEqual([["Send to implementer", "Don't post"]]);

  // The prompt went to that agent, and names both the prose and the JSON.
  const sent = rig.calls().filter((c) => c.cmd === "agent prompt").at(-1)!.argv!;
  expect(sent[2]).toBe(implementer.name);
  expect(sent[3]).toContain(join(run.dir, REVIEW_FILE));
  expect(sent[3]).toContain(join(run.dir, "steps", "synthesize", "synthesized.json"));
  expect(sent[3]).toContain("disagree with a finding say so with a reason");

  // Recorded on both runs, each from its own side.
  expect(run.record.handoffs).toEqual([
    {
      direction: "sent",
      role: "implementer",
      agent: implementer.name,
      run: before.id,
      at: expect.any(String),
      note: `sent ${REVIEW_FILE} to the implementer`,
    },
  ]);
  const other = new RunStore(rig.stateDir).load(before.id);
  expect(other.record.handoffs.map((h) => [h.direction, h.role, h.run])).toEqual([
    ["received", "implementer", run.id],
  ]);
  expect(run.step("post").note).toContain("sent");
});

test("with no implementer live, the review offers to start one on the reviewed target", async () => {
  rig.queueOutputs([CLEAN, CLEAN, FOUND]);
  const prompts = scriptedPrompts(["Fix findings"]);

  const { run, status } = await runWorkflow(rig, "review", {}, { prompts });

  expect(status).toBe("done");
  expect(prompts.offered).toEqual([["Fix findings", "Don't post"]]);

  // A child `implement` run, pointed at this review as its work source.
  expect(run.record.children).toHaveLength(1);
  const child = new RunStore(rig.stateDir).load(run.record.children[0]!);
  expect(child.record.workflow).toBe("implement");
  expect(child.record.inputs.plan).toBe(run.dir);
  expect(child.record.inputs.plan_kind).toBe("review");
  // And at the same target, so the fixes land where the review was pointed.
  expect(child.record.inputs.target).toBe(run.record.inputs.target);
  expect(child.record.inputs.target_kind).toBe("branch");
  expect(run.step("post").note).toContain("implement run");
});

test("the build prompt for a review work source checks out what was reviewed", async () => {
  rig.queueOutputs([CLEAN, CLEAN, FOUND]);
  const { run } = await runWorkflow(rig, "review", {}, { prompts: scriptedPrompts(["Fix findings"]) });
  const child = new RunStore(rig.stateDir).load(run.record.children[0]!);

  // The child has not run; what matters is the prompt it will send, so drive it.
  rig.queueOutputs([CLEAN]);
  const built = await runWorkflow(
    rig,
    "implement",
    { plan: run.dir, target: run.record.inputs.target! },
    { prompts: scriptedPrompts([]) },
  );
  const prompt = readFileSync(join(built.run.dir, "steps", "build", "prompt-1.md"), "utf8");

  expect(prompt).toContain("Work source (review)");
  expect(prompt).toContain(`${run.dir}/review.md`);
  expect(prompt).toContain(`${run.dir}/steps/synthesize/synthesized.json`);
  // Branch, MR and worktree each have their rule, and none of them is "branch off main".
  expect(prompt).toContain("do not branch off the default branch");
  expect(prompt).toContain("git checkout <head of branch:main...feature>");
  expect(prompt).toContain("glab mr checkout <iid>");
  expect(prompt).toContain("stay on the branch you are on");
  expect(child.record.inputs.plan_kind).toBe("review");
});

test("a plan that changes under a live implementer is sent the diff, once per change", async () => {
  const implementer = liveImplementer();
  const planned = new RunStore(rig.stateDir).list()[0]!;

  // The implementer is building from the plan this run is about to write, which is
  // what makes the hand-off this plan's business and not any implementer's.
  // Two Refine rounds, then Esc — which is how a plan run is left open for later.
  const prompts = scriptedPrompts(["Refine", "Refine", null]);
  // The plan run's dir only exists once it is running, so the implementer is pointed
  // at it when the first menu appears — by then `tickets` has written the plan.
  const menu = prompts.menu.bind(prompts);
  prompts.menu = async (items, opts) => {
    const store = new RunStore(rig.stateDir);
    const plan = store.list().find((r) => r.record.workflow === "plan");
    if (plan) {
      const impl = store.load(planned.id);
      impl.record.inputs.plan = join(plan.dir, "plan");
      impl.save();
    }
    return await menu(items, opts);
  };
  rig.queueOutputs([
    CLEAN,
    // spec and tickets write the plan the implementer is building from.
    { __write: { "plan/SPEC.md": "# Add a picker\n" }, output: CLEAN },
    { __write: { "plan/issues/03-third.md": "# 03: third ticket\n" }, output: CLEAN },
    // Refine once, actually changing the plan, with a changelog.
    {
      __write: { "plan/issues/03-third.md": "# 03: third ticket, cut\n" },
      output: { verdict: "clean", findings: [], changed: ["cut ticket 3"], changelog: "Ticket 3 is gone." },
    },
    // Refine again, changing nothing at all.
    { verdict: "clean", findings: [], changed: [] },
  ]);

  const { run, status } = await runWorkflow(rig, "plan", { goal: "Add a picker" }, { prompts });

  expect(status).toBe("blocked");
  expect(run.step("next").note).toBe("no choice taken");

  const prompted = rig
    .calls()
    .filter((c) => c.cmd === "agent prompt" && c.argv![2] === implementer.name)
    .map((c) => c.argv![3]!);

  // Once: the round that changed the plan. The round that changed nothing said nothing.
  expect(prompted).toHaveLength(1);
  expect(prompted[0]).toContain("The plan you are building from has changed.");
  expect(prompted[0]).toContain("Ticket 3 is gone.");
  expect(prompted[0]).toContain(join(run.dir, "plan"));
  expect(prompted[0]).toContain("Reconcile:");
  // The diff itself is a file in the run dir, so the audit trail has it too.
  const path = /is in (\S+\.patch)/.exec(prompted[0]!)![1]!;
  expect(existsSync(path)).toBe(true);
  expect(readFileSync(path, "utf8")).toContain("ticket");

  // Recorded on both sides, like every other hand-off.
  expect(run.record.handoffs.map((h) => [h.direction, h.note])).toEqual([
    ["sent", "sent the plan change to the implementer"],
  ]);
  expect(new RunStore(rig.stateDir).load(planned.id).record.handoffs).toHaveLength(1);
});

test("a plan change reaches only the implementer building from that plan", async () => {
  liveImplementer();
  // That implementer is building from something else, so this plan is not its business.
  const other = new RunStore(rig.stateDir).list()[0]!;
  other.record.inputs.plan = "/some/other/plan";
  other.save();

  const prompts = scriptedPrompts(["Refine", null]);
  rig.queueOutputs([
    CLEAN,
    { __write: { "plan/SPEC.md": "# Add a picker\n" }, output: CLEAN },
    CLEAN,
    {
      __write: { "plan/SPEC.md": "# Add a picker, revised\n" },
      output: { verdict: "clean", findings: [], changed: ["reworded"], changelog: "Reworded." },
    },
  ]);

  const { run } = await runWorkflow(rig, "plan", { goal: "Add a picker" }, { prompts });

  expect(rig.calls().filter((c) => c.cmd === "agent prompt" && c.argv![2] === "impl-1")).toEqual([]);
  expect(run.record.handoffs).toEqual([]);
});

test("an implementer that herdr no longer has is not offered, and its entry goes", async () => {
  const env = rig.pluginEnv();
  liveImplementer("gone-1", "1-9");
  // herdr has forgotten it: the pane is gone, so the agent is gone with it.
  rig.dropAgent("gone-1");
  rig.queueOutputs([CLEAN, CLEAN, FOUND]);
  const prompts = scriptedPrompts(["Fix findings"]);

  const { status } = await runWorkflow(rig, "review", {}, { prompts });

  expect(status).toBe("done");
  // Send to implementer is absent; the option that starts one is what is left.
  expect(prompts.offered[0]).not.toContain("Send to implementer");
  expect(prompts.offered[0]).toContain("Fix findings");
  // And the stale entry was dropped on the way, silently.
  expect(readRegistry(registryPath(env.stateDir, scopeFor(env, env.cwd)))).toEqual([]);
});

test("the implementer is told where to take a decision the plan does not cover", async () => {
  const env = rig.pluginEnv();
  // A planner still live from an earlier `plan` run in this Session.
  const planned = new RunStore(env.stateDir).create({
    workflow: "plan",
    cwd: env.cwd,
    session: env.socketPath,
    workspace: env.workspaceId,
    workspaceLabel: "test",
    inputs: { goal: "g" },
    inputSources: { goal: "asked" },
    stepIds: ["grill"],
    maxIterations: 1,
    primaryInput: "add-a-picker",
  });
  registerAgent(registryPath(env.stateDir, scopeFor(env, env.cwd)), {
    role: "planner",
    agent: "plan-1",
    paneId: "1-8",
    workspaceId: env.workspaceId,
    runId: planned.id,
    workflow: "plan",
    at: "t",
  });
  rig.addAgent("plan-1", "1-8");
  rig.queueOutputs([CLEAN]);

  const { run } = await runWorkflow(rig, "implement", { plan: "build a picker" });
  const prompt = readFileSync(join(run.dir, "steps", "build", "prompt-1.md"), "utf8");

  // The pane and the agent, and how to ask — not "stop and ask the human".
  expect(prompt).toContain("still live as agent `plan-1` in pane `1-8`");
  expect(prompt).toContain('herdr agent prompt plan-1 "<your question>"');
  expect(prompt).toContain("herdr agent read plan-1 --lines 40");
  expect(prompt).not.toContain("There is no planner live");
});

test("with no planner live, the implementer is told to stop and ask instead", async () => {
  rig.queueOutputs([CLEAN]);

  const { run } = await runWorkflow(rig, "implement", { plan: "build a picker" });
  const prompt = readFileSync(join(run.dir, "steps", "build", "prompt-1.md"), "utf8");

  expect(prompt).toContain("There is no planner live for this work");
  expect(prompt).toContain("stop, ask me in your own pane");
  expect(prompt).not.toContain("herdr agent prompt");
  // And nothing is left unrendered in the prompt either way.
  expect(prompt).not.toContain("{{session");
});

test("another workspace's implementer is not this Session's", async () => {
  const env = rig.pluginEnv();
  const path = registryPath(env.stateDir, scopeFor(env, env.cwd));
  const elsewhere = registryPath(env.stateDir, { session: env.socketPath, workspaceId: "9", cwd: env.cwd });
  const otherRepo = registryPath(env.stateDir, { ...scopeFor(env, env.cwd), cwd: "/elsewhere" });
  const otherSession = registryPath(env.stateDir, { ...scopeFor(env, env.cwd), session: "/other.sock" });

  // Four Sessions, four files: the same repo in another workspace, the same workspace
  // on another repo, and the same pair in another herdr session are all different.
  expect(new Set([path, elsewhere, otherRepo, otherSession]).size).toBe(4);

  const entry = {
    role: "implementer",
    agent: "impl-1",
    paneId: "1-9",
    workspaceId: "9",
    runId: "r1",
    workflow: "implement",
    at: "t",
  };
  registerAgent(elsewhere, entry);
  expect(readRegistry(path)).toEqual([]);

  // Even inside one file, an agent herdr places in another workspace is not live here.
  registerAgent(path, { ...entry, workspaceId: env.workspaceId });
  const alive: AgentInfo[] = [{ name: "impl-1", paneId: "1-9", workspaceId: "9", status: "idle" }];
  expect(liveEntries(readRegistry(path), alive)).toEqual([]);
  expect(
    liveEntries(readRegistry(path), [{ ...alive[0]!, workspaceId: env.workspaceId }]),
  ).toHaveLength(1);
});

test("a run registers its long-lived agent, and a reviewer is not one", async () => {
  const env = rig.pluginEnv();
  rig.queueOutputs([CLEAN, CLEAN, SYNTH]);

  await runWorkflow(rig, "review", {}, { prompts: scriptedPrompts(["Don't post"]) });

  // `review` has no `agent:` group, so nobody is registered by it — the reviewers are
  // this run's and nothing should hand them work afterwards.
  expect(existsSync(registryPath(env.stateDir, scopeFor(env, env.cwd)))).toBe(false);
});

import { afterEach, beforeEach, expect, test } from "bun:test";
import { ConfigProvider, Effect, FileSystem, Path, Schema } from "effect";
import { FakeHerdr, Rig } from "./support/recorder";
import { COLLIE_TAB } from "../src/naming";
import { fakeHerdr } from "./support/fake-herdr-core";
import { installBaseline, runWorkflow, scriptedPrompts } from "./support/engine";
import { writeDef } from "./support/defs";
import { runEffect } from "./support/effect";

const Json = Schema.fromJsonString(Schema.Any);
const decodeJson = Schema.decodeUnknownSync(Json);
const encodeJson = Schema.encodeUnknownSync(Json);

Object.defineProperty(FakeHerdr.prototype, "exec", {
  value(args: string[]) {
    return fakeHerdr(args).pipe(
      Effect.provide(ConfigProvider.layer(ConfigProvider.fromEnvRecord(Bun.env))),
    );
  },
});

let rig: Rig;

const SOLO = `---
name: solo
title: solo — one interviewing step
inputs:
  goal: goal
  ticket: ticket
steps:
  - id: solo
    persona: planner
    output: solo.json
---
The goal, in my words:

{{inputs.goal}}

Interview me about this goal before you write anything. One question at a time.
When we agree, write the plan to {{run.dir}}/plan/SPEC.md.
`;

/** SOLO's one step, but keeping the harness's own tool-call prompting. */
const ASKS = `---
name: asks
title: asks — one step that answers its own prompts
inputs:
  goal: goal
steps:
  - id: solo
    persona: planner
    permissions: harness
    output: solo.json
---
Interview me about {{inputs.goal}}, then write the plan.
`;

beforeEach(() =>
  runEffect(
    Effect.gen(function* () {
      rig = yield* Rig.make();
      yield* rig.startSocket();
      yield* installBaseline(rig);
      yield* writeDef(rig.baselineDir, "workflows", "solo", SOLO);
    }),
  ),
);

afterEach(() => runEffect(rig.close()));

function runWorkflowEffect(...args: Parameters<typeof runWorkflow>) {
  return runWorkflow(...args).pipe(Effect.orDie);
}

test("agents start unattended by default, and with the harness's prompts under `harness`", () =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const outputs = [{ verdict: "clean", findings: [], plan_file: "tasks/p/PLAN.md", slug: "p" }];

      yield* rig.queueOutputs(outputs);
      const bypassed = yield* runWorkflowEffect(rig, "solo", { goal: "Add a picker" });
      const bypassStart = (yield* rig.calls()).find((c) => c.cmd === "agent start")!.argv!;
      expect(bypassStart.slice(-2)).toEqual(["--permission-mode", "bypassPermissions"]);
      expect(yield* fs.readFileString(path.join(bypassed.run.dir, "log.txt"))).toContain(
        "permissions bypass",
      );

      // A step that says so keeps the harness's prompting while the default stays bypass.
      yield* writeDef(rig.baselineDir, "workflows", "asks", ASKS);
      yield* rig.queueOutputs(outputs);
      const asked = yield* runWorkflowEffect(rig, "asks", { goal: "Add a picker" });
      const askStart = (yield* rig.calls()).findLast((c) => c.cmd === "agent start")!.argv!;
      expect(askStart).not.toContain("--permission-mode");
      expect(yield* fs.readFileString(path.join(asked.run.dir, "log.txt"))).toContain(
        "permissions harness",
      );
    }),
  ));

test("a mode the engine cannot resolve fails the step instead of starting it unattended", () =>
  runEffect(
    Effect.gen(function* () {
      // A chained Run and a resumed Driver resolve a Workflow without validating it, so
      // the engine is the last place that can refuse — and the fallback it would
      // otherwise take is `bypass`.
      const { run, status } = yield* runWorkflowEffect(
        rig,
        "solo",
        { goal: "Add a picker" },
        { defaults: { permissions: "bypas" }, unvalidated: true },
      );

      expect(status).toBe("failed");
      expect(run.step("solo").note).toContain('unknown permissions "bypas"');
      // Before a tab opens, which is the contract — not after one is created, named and
      // cd'd into and then abandoned.
      for (const cmd of ["agent start", "tab create", "pane split"])
        expect(yield* rig.cmds()).not.toContain(cmd);
    }),
  ));

test("a Collie-created worktree's own shell tab becomes the first agent's", () =>
  runEffect(
    Effect.gen(function* () {
      // herdr opens a worktree workspace with one numbered shell tab in it. The run
      // owns that workspace, so the tab is its first agent's rather than an empty one
      // left beside the Collie tab for a human to close.
      yield* rig.queueOutputs([{ verdict: "clean", findings: [] }]);
      const root = yield* rig.addTab("3", "");
      const worktreePath = `${rig.root}/worktrees/add-picker`;
      yield* rig.addWorktree("add-picker", worktreePath, "w2");

      const { run, status } = yield* runWorkflowEffect(
        rig,
        "solo",
        { goal: "Add a picker" },
        {
          worktree: {
            path: worktreePath,
            branch: "add-picker",
            created_by_collie: true,
            managed_by: "herdr",
            workspace_id: "w2",
            made_at: null,
            root_tab_id: root.tabId,
            root_pane_id: root.paneId,
          },
        },
      );

      expect(status).toBe("done");
      const variant = run.step("solo").variants[0]!;
      expect(variant.paneId).toBe(root.paneId);
      expect(variant.tabId).toBe(root.tabId);
      expect(yield* rig.cmds()).not.toContain("tab create");
    }),
  ));

test("plan runs one step in a tab of its own and records the run", () =>
  runEffect(
    Effect.gen(function* () {
      yield* rig.queueOutputs([
        {
          verdict: "clean",
          findings: [],
          plan_file: "tasks/add-a-picker/PLAN.md",
          slug: "add-a-picker",
        },
      ]);

      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const { run, status, lines } = yield* runWorkflowEffect(rig, "solo", {
        goal: "Add a picker",
      });

      expect(status).toBe("done");
      // The workspace's board is found or opened and put first, and then the step opens
      // its own tab — after checking whether the launch pane is a reusable numbered
      // shell. Nothing asks what the other tabs are called: a run's tab is named after
      // the run, so there is no collision to judge. The run itself is driven headlessly.
      expect(yield* rig.cmds()).toEqual([
        "tab list",
        "plugin pane",
        "pane rename",
        "tab rename",
        "tab.move",
        "tab list",
        "pane list",
        "tab create",
        // The new tab is placed by rank as soon as it exists, and never again.
        "tab list",
        "tab.move",
        "pane run",
        "agent start",
        "agent.view.set",
        // What the agent was doing before the prompt, so that a turn seen afterwards
        // is known to be this prompt's and not one already running.
        "agent get",
        // The submission waits for the agent to take it, so nothing waits again after
        // it: `agent prompt` answers that question at the boundary.
        "agent prompt",
        // The step is watched, not waited on: one status poll, and it is already idle.
        "agent get",
        // Its step over, and then the run: the tab drops the step it was on, and
        // then says the run is done.
        "tab rename",
        "tab rename",
        "agent.view.clear",
        "notification show",
      ]);

      // No pane is split, moved or swapped for the run itself: the Control Plane's is
      // the only pane this plugin keeps, and the step's tab holds the agent.
      for (const cmd of ["pane split", "pane move", "pane swap"])
        expect(yield* rig.cmds()).not.toContain(cmd);
      // One pane rename in the whole run: the board's own. The agent's pane is alone in
      // its tab, so the tab says `Solo` and the pane says nothing.
      expect(
        (yield* rig.calls()).filter((c) => c.cmd === "pane rename").map((c) => c.argv!.slice(2)),
      ).toEqual([["1-1", COLLIE_TAB]]);
      expect(
        (yield* rig.calls())
          .filter((c) => c.cmd === "tab rename")
          .at(-1)!
          .argv!.at(-1),
      ).toBe("✓ Solo · add-a-picker");

      const start = (yield* rig.calls()).find((c) => c.cmd === "agent start")!.argv!;
      expect(start.slice(0, 8)).toEqual([
        "agent",
        "start",
        "solo-add-a-picker-solo-r1",
        "--kind",
        "claude",
        "--pane",
        "1-2",
        "--",
      ]);
      expect(start.slice(8, 10)).toEqual(["--model", "opus"]);
      expect(start[10]).toBe("--append-system-prompt-file");
      expect(start[11]).toBe(path.join(run.dir, "personas", "planner.claude.md"));
      expect(yield* fs.readFileString(start[11]!)).toContain("You are a planner");

      // The prompt goes to a file: a multi-line prompt cannot be typed into a harness.
      const promptPath = path.join(run.dir, "steps", "solo", "prompt-1.md");
      expect((yield* rig.calls()).find((c) => c.cmd === "agent prompt")!.argv![3]).toBe(
        `Your task for this step is in ${promptPath} — read it and follow it.`,
      );
      const prompt = yield* fs.readFileString(promptPath);
      expect(prompt).toContain("Add a picker");
      expect(prompt).toContain(`${run.dir}/plan/SPEC.md`);
      // A headingless body is the prompt, not the prompt twice.
      expect(prompt.split("Interview me about this goal")).toHaveLength(2);
      expect(prompt).toContain(`OUTPUT_PATH: ${path.join(run.dir, "steps", "solo", "solo.json")}`);

      const record = decodeJson(yield* fs.readFileString(path.join(run.dir, "run.json")));
      expect(record.workflow).toBe("solo");
      expect(record.status).toBe("done");
      expect(record.inputs).toEqual({ goal: "Add a picker", ticket: "" });
      expect(record.input_sources.goal).toBe("asked");
      expect(record.steps).toHaveLength(1);
      expect(record.steps[0].status).toBe("done");
      // Both ends of the step, so the board can say how long it took and the panel can
      // say how long a running one has been going.
      expect(Date.parse(record.steps[0].started_at)).toBeLessThanOrEqual(
        Date.parse(record.steps[0].finished_at),
      );
      expect(record.steps[0].variants[0]).toMatchObject({
        harness: "claude",
        model: "opus",
        agent: "solo-add-a-picker-solo-r1",
        label: "solo-add-a-picker/solo",
        status: "done",
        output: "steps/solo/solo.json",
      });
      expect(yield* fs.exists(path.join(run.dir, "steps", "solo", "solo.json"))).toBe(true);
      expect(lines.at(-1)).toContain("done after 1 iteration(s)");
    }),
  ));

test("a step whose Output never appears blocks the run and toasts", () =>
  runEffect(
    Effect.gen(function* () {
      yield* rig.queueOutputs([]);

      const { run, status } = yield* runWorkflowEffect(rig, "solo", { goal: "Add a picker" });

      expect(status).toBe("blocked");
      expect(run.record.steps[0]!.status).toBe("blocked");
      expect(run.record.steps[0]!.variants[0]!.error).toBe("no Output at steps/solo/solo.json");
      const toast = (yield* rig.calls()).find((c) => c.cmd === "notification show")!.argv!;
      // The repo is in the title: one herdr session runs several checkouts.
      expect(toast[2]).toBe("project · solo-add-a-picker stopped on an unusable Output");
      // The toast names the file and the reason, and says the agent was already
      // asked to write it again: that is what tells a human it is ten seconds of work.
      expect(toast).toContain("solo: no Output at steps/solo/solo.json (asked once already)");
      expect(yield* rig.cmds()).toContain("agent.view.clear");
    }),
  ));

test("an Output that is not valid JSON fails the step with the parse error", () =>
  runEffect(
    Effect.gen(function* () {
      yield* rig.queueOutputs(["not json"]);

      const { run, status } = yield* runWorkflowEffect(rig, "solo", { goal: "g" });

      expect(status).toBe("blocked");
      expect(run.record.steps[0]!.variants[0]!.status).toBe("failed");
      expect(run.record.steps[0]!.variants[0]!.error).toContain("not valid JSON");
    }),
  ));

test("the sidebar filter is set to the run's panes and cleared at the end", () =>
  runEffect(
    Effect.gen(function* () {
      yield* rig.queueOutputs([{ verdict: "clean", findings: [] }]);

      const { run } = yield* runWorkflowEffect(rig, "solo", { goal: "g" });

      const set = (yield* rig.calls()).find((c) => c.cmd === "agent.view.set")!;
      expect(set.params).toEqual({
        source: `cego.collie:${run.id}`,
        label: run.record.slug,
        filter: { op: "in", field: "pane_id", values: ["1-2"] },
      });
      expect((yield* rig.calls()).find((c) => c.cmd === "agent.view.clear")!.params).toEqual({
        source: `cego.collie:${run.id}`,
      });
    }),
  ));

test("an interviewing agent hands off, and the step finishes when the Output appears", () =>
  runEffect(
    Effect.gen(function* () {
      yield* rig.queueOutputs([
        { __delay_ms: 300, output: { verdict: "clean", findings: [], slug: "s" } },
      ]);

      const { run, status, lines } = yield* runWorkflowEffect(
        rig,
        "solo",
        { goal: "Add a picker" },
        { handoffTimeoutMs: 10_000, outputPollMs: 50 },
      );

      expect(status).toBe("done");
      expect(run.record.steps[0]!.status).toBe("done");
      expect(lines.some((l) => l.includes("is waiting for you in its tab"))).toBe(true);
      const toasts = (yield* rig.calls()).filter((c) => c.cmd === "notification show");
      expect(toasts[0]!.argv![2]).toBe("project · solo-add-a-picker needs you");
      expect(toasts.at(-1)!.argv![2]).toBe("project · solo-add-a-picker finished");
    }),
  ));

test("agent names stay inside herdr's 32-character lowercase limit", () =>
  runEffect(
    Effect.gen(function* () {
      const { agentName, stepLabel } = yield* Effect.promise(() => import("../src/naming"));

      expect(agentName("plan-add-a-picker", "plan", null, 1)).toBe("plan-add-a-picker-plan-r1");
      const long = agentName(
        "implement-a-very-long-goal-indeed-truly",
        "review",
        "claude-sonnet",
        12,
      );
      expect(long).toBe("impleme-review-claude-sonnet-r12");
      expect(long.length).toBeLessThanOrEqual(32);
      expect(long).toMatch(/^[a-z][a-z0-9_-]*$/);
      expect(agentName("9lives", "s", null, 1)).toMatch(/^[a-z]/);
      expect(stepLabel("plan-x", "review", "codex-gpt-5-codex")).toBe(
        "plan-x/review/codex-gpt-5-codex",
      );
    }),
  ));

test("{{run.dir}} is substituted in every step's prompt", () =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      yield* writeDef(
        rig.baselineDir,
        "workflows",
        "artefacts",
        `---
name: artefacts
steps:
  - id: spec
    persona: planner
    output: spec.json
  - id: tickets
    persona: planner
    agent: spec
    output: tickets.json
---
Run dir: {{run.dir}}

## spec
Write the spec to {{run.dir}}/plan/SPEC.md

## tickets
Write the tickets to {{run.dir}}/plan/issues/
`,
      );
      yield* rig.queueOutputs([
        { verdict: "clean", findings: [] },
        { verdict: "clean", findings: [] },
      ]);

      const { run, status } = yield* runWorkflowEffect(rig, "artefacts", {});

      expect(status).toBe("done");
      for (const step of ["spec", "tickets"]) {
        const prompt = yield* fs.readFileString(path.join(run.dir, "steps", step, "prompt-1.md"));
        expect(prompt).toContain(`Run dir: ${run.dir}`);
        expect(prompt).toContain(`${run.dir}/plan`);
      }
    }),
  ));

test("an agent blocked on a first-run prompt waits for the human instead of failing", () =>
  runEffect(
    Effect.gen(function* () {
      yield* rig.queueOutputs([{ verdict: "clean", findings: [], slug: "s" }]);

      const { run, status, lines } = yield* runWorkflowEffect(
        rig,
        "solo",
        { goal: "Add a picker" },
        { env: { FAKE_HERDR_BLOCK_START: "2" }, handoffTimeoutMs: 10_000, outputPollMs: 20 },
      );

      expect(status).toBe("done");
      expect(run.step("solo").variants[0]!.status).toBe("done");
      // The agent is registered and blocked, so it is started once and then waited for.
      expect((yield* rig.cmds()).filter((c) => c === "agent start")).toHaveLength(1);
      expect(lines.some((l) => l.includes("is waiting for you in its pane"))).toBe(true);
      const toast = (yield* rig.calls()).find((c) => c.cmd === "notification show")!.argv!;
      expect(toast[2]).toBe("project · solo-add-a-picker needs you");
      expect(toast).toContain("solo: answer the prompt in its pane");
    }),
  ));

test("an agent that never becomes ready still fails the step, with herdr's own error", () =>
  runEffect(
    Effect.gen(function* () {
      yield* rig.queueOutputs([{ verdict: "clean", findings: [] }]);

      const { run, status } = yield* runWorkflowEffect(
        rig,
        "solo",
        { goal: "g" },
        { env: { FAKE_HERDR_BLOCK_START: "9999" }, handoffTimeoutMs: 300, outputPollMs: 20 },
      );

      expect(status).toBe("failed");
      expect(run.step("solo").note).toContain("agent_not_ready");
    }),
  ));

test("a step with skill: is prompted as the slash command, so a user-only skill runs", () =>
  runEffect(
    Effect.gen(function* () {
      const path = yield* Path.Path;
      yield* writeDef(
        rig.baselineDir,
        "workflows",
        "grill",
        `---
name: grill
inputs:
  goal: goal
steps:
  - id: grill
    persona: planner
    skill: grill-with-docs
    output: grill.json
---
Grill me about {{inputs.goal}}.
`,
      );
      yield* rig.queueOutputs([{ verdict: "clean", findings: [] }]);

      const { run, status } = yield* runWorkflowEffect(rig, "grill", { goal: "Add a picker" });

      expect(status).toBe("done");
      const prompt = path.join(run.dir, "steps", "grill", "prompt-1.md");
      // The slash command has to be the first thing on the line, and the line has to stay
      // one line: herdr types it into the harness the way a human would.
      expect((yield* rig.calls()).find((c) => c.cmd === "agent prompt")!.argv![3]).toBe(
        `/grill-with-docs Your task for this step is in ${prompt} — read it and follow it.`,
      );
    }),
  ));

/** A ~/.claude.json in the rig's HOME, which is where the runner will look. */
function claudeSeen(rig: Rig, projects: Record<string, { hasTrustDialogAccepted?: boolean }>) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    yield* fs.writeFileString(path.join(rig.root, ".claude.json"), encodeJson({ projects }));
  });
}

test("an untrusted directory is offered up front, so no tab ever stops on the dialog", () =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      yield* claudeSeen(rig, {});
      yield* rig.queueOutputs([{ verdict: "clean", findings: [] }]);
      const prompts = scriptedPrompts(["Trust it now"]);

      const { run, status, lines } = yield* runWorkflowEffect(
        rig,
        "solo",
        { goal: "g" },
        { prompts },
      );

      expect(status).toBe("done");
      expect(prompts.offered).toEqual([["Trust it now", "Let claude ask me in its tab"]]);
      const config = decodeJson(yield* fs.readFileString(path.join(rig.root, ".claude.json")));
      expect(config.projects[run.record.cwd].hasTrustDialogAccepted).toBe(true);
      expect(lines.some((l) => l.includes("trusted"))).toBe(true);
      // Nothing was blocked, so nothing had to wait.
      expect(lines.some((l) => l.includes("waiting for you in its pane"))).toBe(false);
    }),
  ));

test("a run in its own git checkout opens its tabs in the workspace it started in", () =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      yield* rig.queueOutputs([{ verdict: "clean", findings: [] }]);
      const worktree = path.join(rig.root, "worktrees", "add-picker");
      yield* fs.makeDirectory(worktree, { recursive: true });

      const { status } = yield* runWorkflowEffect(
        rig,
        "solo",
        { goal: "g" },
        {
          prompts: scriptedPrompts([]),
          worktree: {
            path: worktree,
            branch: "add-picker",
            created_by_collie: true,
            managed_by: "git",
            workspace_id: null,
            made_at: null,
            root_tab_id: null,
            root_pane_id: null,
          },
        },
      );

      expect(status).toBe("done");
      const calls = yield* rig.calls();
      // The workspace the run was activated from, which is the rig's own.
      const created = calls.filter((call) => call.cmd === "tab create");
      expect(created).not.toHaveLength(0);
      for (const call of created) expect(call.argv?.join(" ")).toContain("--workspace 1");
      // herdr 0.8.2 echoes `--cwd` on `tab create` but leaves the pane's shell in the
      // workspace directory, so the pane is `cd`-ed into the checkout explicitly.
      expect(
        calls.filter((call) => call.cmd === "pane run").map((call) => call.argv?.at(-1)),
      ).toContain(`cd '${worktree}'`);
      // No workspace of its own: the checkout was made with git.
      expect(calls.map((call) => call.cmd)).not.toContain("worktree create");
    }),
  ));

test("a checkout Collie just created is trusted without asking anyone", () =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      yield* claudeSeen(rig, {});
      yield* rig.queueOutputs([{ verdict: "clean", findings: [] }]);
      const worktree = path.join(rig.root, "worktrees", "add-picker");
      yield* fs.makeDirectory(worktree, { recursive: true });
      // Nothing is scripted: a question here would fail the run rather than pass it.
      const prompts = scriptedPrompts([]);

      const { status, lines } = yield* runWorkflowEffect(
        rig,
        "solo",
        { goal: "g" },
        {
          prompts,
          worktree: {
            path: worktree,
            branch: "add-picker",
            created_by_collie: true,
            managed_by: "herdr",
            workspace_id: "w7",
            made_at: null,
            root_tab_id: null,
            root_pane_id: null,
          },
        },
      );

      expect(status).toBe("done");
      expect(prompts.offered).toEqual([]);
      const config = decodeJson(yield* fs.readFileString(path.join(rig.root, ".claude.json")));
      expect(config.projects[worktree].hasTrustDialogAccepted).toBe(true);
      expect(lines.some((l) => l.includes("trusted"))).toBe(true);
    }),
  ));

test("a trust write that fails leaves claude to ask, and the run goes ahead anyway", () =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      yield* claudeSeen(rig, {});
      // The backup is taken before the write, and it cannot be written over a directory.
      yield* fs.makeDirectory(path.join(rig.stateDir, "claude.json.bak"), { recursive: true });
      yield* rig.queueOutputs([{ verdict: "clean", findings: [] }]);
      const prompts = scriptedPrompts(["Trust it now"]);

      const { status, lines } = yield* runWorkflowEffect(rig, "solo", { goal: "g" }, { prompts });

      expect(status).toBe("done");
      expect(lines.some((l) => l.includes("could not record trust"))).toBe(true);
    }),
  ));

test("declining leaves claude to ask, and the run goes ahead anyway", () =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      yield* claudeSeen(rig, {});
      yield* rig.queueOutputs([{ verdict: "clean", findings: [] }]);
      const prompts = scriptedPrompts(["Let claude ask me in its tab"]);

      const { status } = yield* runWorkflowEffect(rig, "solo", { goal: "g" }, { prompts });

      expect(status).toBe("done");
      const config = decodeJson(yield* fs.readFileString(path.join(rig.root, ".claude.json")));
      expect(config.projects).toEqual({});
    }),
  ));

test("a directory claude already trusts is not mentioned at all", () =>
  runEffect(
    Effect.gen(function* () {
      yield* rig.queueOutputs([{ verdict: "clean", findings: [] }]);
      const prompts = scriptedPrompts([]);

      yield* claudeSeen(rig, { [rig.projectDir]: { hasTrustDialogAccepted: true } });
      expect((yield* runWorkflowEffect(rig, "solo", { goal: "g" }, { prompts })).status).toBe(
        "done",
      );
      expect(prompts.offered).toEqual([]);
    }),
  ));

test("config.json can turn the question off for good", () =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      yield* claudeSeen(rig, {});
      yield* fs.writeFileString(
        path.join(rig.configDir, "config.json"),
        encodeJson({ trust: "never" }),
      );
      yield* rig.queueOutputs([{ verdict: "clean", findings: [] }]);
      const prompts = scriptedPrompts([]);

      const { status } = yield* runWorkflowEffect(rig, "solo", { goal: "g" }, { prompts });

      expect(status).toBe("done");
      expect(prompts.offered).toEqual([]);
    }),
  ));

test("config.json can also answer it in advance", () =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      yield* claudeSeen(rig, {});
      yield* fs.writeFileString(
        path.join(rig.configDir, "config.json"),
        encodeJson({ trust: "auto" }),
      );
      yield* rig.queueOutputs([{ verdict: "clean", findings: [] }]);
      const prompts = scriptedPrompts([]);

      const { run, status } = yield* runWorkflowEffect(rig, "solo", { goal: "g" }, { prompts });

      expect(status).toBe("done");
      expect(prompts.offered).toEqual([]);
      const config = decodeJson(yield* fs.readFileString(path.join(rig.root, ".claude.json")));
      expect(config.projects[run.record.cwd].hasTrustDialogAccepted).toBe(true);
    }),
  ));

test("a mentioned skill renders as the file to read, the same for every harness", () =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      // Installed the way skills.sh installs them: <root>/.agents/skills/<name>/SKILL.md.
      const skill = path.join(rig.root, ".agents", "skills", "code-review");
      yield* fs.makeDirectory(skill, { recursive: true });
      yield* fs.writeFileString(path.join(skill, "SKILL.md"), "# code-review\n");
      yield* writeDef(
        rig.baselineDir,
        "workflows",
        "mentions",
        `---
name: mentions
inputs:
  goal: goal
steps:
  - id: mention
    persona: reviewer
    output: mention.json
---
Run {{skill:code-review}} and {{skill:not-a-skill}}.
`,
      );
      yield* rig.queueOutputs([{ verdict: "clean", findings: [] }]);

      const { run, status } = yield* runWorkflowEffect(rig, "mentions", { goal: "g" });

      expect(status).toBe("done");
      const prompt = yield* fs.readFileString(
        path.join(run.dir, "steps", "mention", "prompt-1.md"),
      );
      // A path is a path: nothing expands `/code-review` inside a file a model reads.
      expect(prompt).toContain(
        `the \`code-review\` skill (read \`${path.join(skill, "SKILL.md")}\` and follow it)`,
      );
      expect(prompt).not.toContain("Run /code-review");
      expect(prompt).toContain("the `not-a-skill` skill (not installed here)");
      // The persona the agent was handed reads the same way.
      const persona = yield* fs.readFileString(
        path.join(run.dir, "personas", "reviewer.claude.md"),
      );
      expect(persona).toContain(
        `the \`code-review\` skill (read \`${path.join(skill, "SKILL.md")}\` and follow it)`,
      );
      expect(persona).toContain("the `code-review-and-quality` skill (not installed here)");

      const log = yield* fs.readFileString(path.join(run.dir, "log.txt"));
      expect(log.match(/skills not installed here/g)?.length).toBe(1);
    }),
  ));

test("an unusable Output is repaired by the agent that wrote it, once", () =>
  runEffect(
    Effect.gen(function* () {
      const path = yield* Path.Path;
      // The first write is not JSON; the second is what the repair prompt gets back.
      yield* rig.queueOutputs(["not json at all", { verdict: "clean", findings: [] }]);

      const { run, status } = yield* runWorkflowEffect(rig, "solo", {
        goal: "Add a picker",
        ticket: "",
      });

      expect(status).toBe("done");
      const variant = run.record.steps[0]!.variants[0]!;
      expect(variant.status).toBe("done");
      expect(variant.repairs).toHaveLength(1);
      expect(variant.repairs[0]).toContain("not valid JSON");

      // The prompt names the problem and the exact file: a generic "try again" does not
      // tell the agent what it got wrong.
      const prompts = (yield* rig.calls()).filter((c) => c.cmd === "agent prompt");
      expect(prompts).toHaveLength(2);
      expect(prompts[1]!.argv![3]).toContain("not valid JSON");
      expect(prompts[1]!.argv![3]).toContain(path.join("steps", "solo", "solo.json"));
    }),
  ));

test("a second unusable Output blocks, with one repair and no third prompt", () =>
  runEffect(
    Effect.gen(function* () {
      yield* rig.queueOutputs(["not json at all", "still not json"]);

      const { run, status } = yield* runWorkflowEffect(rig, "solo", {
        goal: "Add a picker",
        ticket: "",
      });

      expect(status).toBe("blocked");
      const variant = run.record.steps[0]!.variants[0]!;
      expect(variant.repairs).toHaveLength(1);
      expect(variant.error).toContain("not valid JSON");
      expect((yield* rig.calls()).filter((c) => c.cmd === "agent prompt")).toHaveLength(2);
      // One event, one interrupt: the specific kind names the step, the file and the
      // error, so the ending does not announce the same thing again under its own key.
      const toasts = (yield* rig.calls()).filter((c) => c.cmd === "notification show");
      expect(toasts).toHaveLength(1);
      expect(toasts[0]!.argv!.at(-1)).toContain("not valid JSON");
      expect(toasts[0]!.argv!.at(-1)).toContain("asked once already");
      expect(toasts[0]!.argv![2]).toContain("stopped on an unusable Output");
    }),
  ));

test("a blank Output file is a write that has not happened, not an empty answer", () =>
  runEffect(
    Effect.gen(function* () {
      // A file holding only whitespace used to end the wait and fail the parse.
      yield* rig.queueOutputs(["\n", { verdict: "clean", findings: [] }]);

      const { run, status } = yield* runWorkflowEffect(rig, "solo", {
        goal: "Add a picker",
        ticket: "",
      });

      expect(status).toBe("done");
      expect(run.record.steps[0]!.variants[0]!.repairs).toHaveLength(1);
      expect(run.record.steps[0]!.variants[0]!.repairs[0]).toContain("no Output at");
    }),
  ));

test("a blocked agent is not asked to repair — it has nothing left to give", () =>
  runEffect(
    Effect.gen(function* () {
      yield* rig.queueOutputs(["not json at all"]);

      const { run, status } = yield* runWorkflowEffect(
        rig,
        "solo",
        { goal: "Add a picker", ticket: "" },
        { env: { FAKE_HERDR_AGENT_STATUS: "blocked" } },
      );

      expect(status).toBe("blocked");
      expect(run.record.steps[0]!.variants[0]!.repairs).toEqual([]);
      // The prompt that started the step, and nothing after it.
      expect((yield* rig.calls()).filter((c) => c.cmd === "agent prompt")).toHaveLength(1);
    }),
  ));

test("an agent that goes quiet is nudged twice and then given up on", () =>
  runEffect(
    Effect.gen(function* () {
      const { run, status } = yield* runWorkflowEffect(
        rig,
        "solo",
        { goal: "Add a picker", ticket: "" },
        {
          // Quiet is the signal: same status, same pane tail, every poll.
          env: { FAKE_HERDR_AGENT_STATUS: "working", FAKE_HERDR_PANE_TEXT: "stuck" },
          // Real wall clock, so the budget has to survive a poll iteration that the
          // machine delays: nudges are owed per whole quiet period, and one stalled
          // iteration under a 30ms period skipped straight from no nudge to the
          // give-up at three.
          defaults: { quietMs: 300 },
          outputPollMs: 10,
        },
      );

      expect(status).toBe("blocked");
      const variant = run.record.steps[0]!.variants[0]!;
      expect(variant.nudges).toBe(2);
      expect(variant.error).toContain("did not respond to two nudges");
      // The toast names the step that went quiet, not just that one did.
      const toast = (yield* rig.calls()).filter((c) => c.cmd === "notification show").at(-1)!.argv!;
      expect(toast[2]).toBe("project · solo-add-a-picker stopped: solo went quiet");
      const nudges = (yield* rig.calls())
        .filter((c) => c.cmd === "agent prompt")
        .map((c) => c.argv![3]!)
        .filter((text) => text.includes("no output for"));
      expect(nudges).toHaveLength(2);
      // The hint is the harness's own: the generic version would not have unstuck
      // the case this was written for.
      expect(nudges[0]).toContain("/bashes");
      expect(nudges[0]).toContain("Do not restart the task");
      expect(nudges[1]).toContain("last nudge");
    }),
  ));

test("a step that is still producing output is never nudged, however slow", () =>
  runEffect(
    Effect.gen(function* () {
      yield* rig.queueOutputs([{ verdict: "clean", findings: [] }]);
      const { run, status } = yield* runWorkflowEffect(
        rig,
        "solo",
        { goal: "Add a picker", ticket: "" },
        {
          // Working, with a pane that says something new every poll, for far longer
          // than the quiet budget — then it finishes.
          env: {
            FAKE_HERDR_AGENT_STATUS: [...Array(12).fill("working"), "idle"].join(","),
            FAKE_HERDR_PANE_TEXT: "changing",
          },
          defaults: { quietMs: 20 },
          outputPollMs: 5,
        },
      );

      expect(status).toBe("done");
      expect(run.record.steps[0]!.variants[0]!.nudges).toBe(0);
      expect(
        (yield* rig.calls())
          .filter((c) => c.cmd === "agent prompt")
          .filter((c) => c.argv![3]!.includes("no output for")),
      ).toHaveLength(0);
    }),
  ));

test("quiet_ms 0 waits for as long as it takes and never nudges", () =>
  runEffect(
    Effect.gen(function* () {
      yield* rig.queueOutputs([{ verdict: "clean", findings: [] }]);
      const { run, status } = yield* runWorkflowEffect(
        rig,
        "solo",
        { goal: "Add a picker", ticket: "" },
        { defaults: { quietMs: 0 }, outputPollMs: 5 },
      );

      expect(status).toBe("done");
      expect(run.record.steps[0]!.variants[0]!.nudges).toBe(0);
      // The plain wait, not the watching loop: the one status read is the submission's
      // own, asked before the prompt went out.
      expect((yield* rig.cmds()).filter((c) => c === "agent get")).toHaveLength(1);
    }),
  ));

test("a herdr that cannot move tabs still finishes the run, with a log line", () =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      yield* rig.queueOutputs([{ verdict: "clean", findings: [] }]);

      const { run, status } = yield* runWorkflowEffect(
        rig,
        "solo",
        { goal: "Add a picker", ticket: "" },
        { env: { FAKE_HERDR_FAIL: encodeJson({ "tab.move": "no such method" }) } },
      );

      // A tab in the wrong place is never a reason to fail a run.
      expect(status).toBe("done");
      expect(yield* fs.readFileString(path.join(run.dir, "log.txt"))).toContain("tab order:");
    }),
  ));

test("a give-up keeps an Output the agent had already written", () =>
  runEffect(
    Effect.gen(function* () {
      // The work is done; only the background process it is sitting on is stuck.
      yield* rig.queueOutputs([{ verdict: "clean", findings: [] }]);

      const { run, status } = yield* runWorkflowEffect(
        rig,
        "solo",
        { goal: "Add a picker", ticket: "" },
        {
          env: { FAKE_HERDR_AGENT_STATUS: "working", FAKE_HERDR_PANE_TEXT: "stuck" },
          // Long enough that both nudges are due before the give-up whatever the
          // polls cost: the quiet clock is what this asserts, not the round trips.
          defaults: { quietMs: 1000 },
          outputPollMs: 5,
        },
      );

      expect(status).toBe("done");
      const variant = run.record.steps[0]!.variants[0]!;
      expect(variant.status).toBe("done");
      // It was nudged on the way — the step still counts as having gone quiet.
      expect(variant.nudges).toBe(2);
    }),
  ));

test("the nudge itself does not count as the agent waking up", () =>
  runEffect(
    Effect.gen(function* () {
      // The nudge is typed into the agent's own pane, so a pane that only changes when
      // something is typed into it is the case that used to reset the deadline and
      // nudge forever.
      const { run, status } = yield* runWorkflowEffect(
        rig,
        "solo",
        { goal: "Add a picker", ticket: "" },
        {
          env: { FAKE_HERDR_AGENT_STATUS: "working", FAKE_HERDR_PANE_TEXT: "prompts" },
          // Long enough that both nudges are due before the give-up whatever the
          // polls and the submissions cost: the quiet clock is what this asserts.
          defaults: { quietMs: 1000 },
          outputPollMs: 5,
        },
      );

      expect(status).toBe("blocked");
      const variant = run.record.steps[0]!.variants[0]!;
      expect(variant.nudges).toBe(2);
      // Two nudges and then a give-up. Which of the two give-up lines says so depends
      // on whether the second nudge's own writing landed inside a quiet period — a
      // race with the polls, and not what this test is about.
      expect(variant.error).toContain("two nudges");
    }),
  ));

test("a Choice round's own prompt and persona get their skills resolved too", () =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const skill = path.join(rig.root, ".agents", "skills", "code-simplification");
      yield* fs.makeDirectory(skill, { recursive: true });
      yield* fs.writeFileString(path.join(skill, "SKILL.md"), "# code-simplification\n");
      yield* writeDef(
        rig.baselineDir,
        "workflows",
        "rounds",
        `---
name: rounds
inputs:
  goal: goal
steps:
  - id: next
    choices:
      - title: Tidy it
        prompt: tidy
        persona: implementer
        fresh: true
        output: tidy.json
      - title: Stop here
        stop: true
---
Goal: {{inputs.goal}}

## tidy
Run {{skill:code-simplification}} over it.
`,
      );
      yield* rig.queueOutputs([{ verdict: "clean", findings: [] }]);

      const { run, status } = yield* runWorkflowEffect(
        rig,
        "rounds",
        { goal: "g" },
        { prompts: scriptedPrompts(["Tidy it", "Stop here"]) },
      );

      expect(status).toBe("done");
      // The round's own prompt...
      const prompt = yield* fs.readFileString(
        path.join(run.dir, "steps", "next", "tidy-it-1", "prompt-1.md"),
      );
      expect(prompt).toContain(`read \`${path.join(skill, "SKILL.md")}\` and follow it`);
      // ...and the persona it was given, which is where an implementer's skills live.
      const persona = yield* fs.readFileString(
        path.join(run.dir, "personas", "implementer.claude.md"),
      );
      expect(persona).toContain(`read \`${path.join(skill, "SKILL.md")}\` and follow it`);
    }),
  ));

test("an agent that answers each nudge and stalls again is still given up on", () =>
  runEffect(
    Effect.gen(function* () {
      // The pane changes one poll after every prompt and never otherwise: an agent
      // that says "ok, continuing" to each nudge while remaining stuck. Two nudges is
      // what a step gets for its whole turn, however often it stirs in between.
      const { run, status } = yield* runWorkflowEffect(
        rig,
        "solo",
        { goal: "Add a picker", ticket: "" },
        {
          env: { FAKE_HERDR_AGENT_STATUS: "working", FAKE_HERDR_PANE_TEXT: "echo" },
          defaults: { quietMs: 30 },
          outputPollMs: 5,
        },
      );

      expect(status).toBe("blocked");
      const variant = run.record.steps[0]!.variants[0]!;
      // Two, never three: stirring between nudges resets the spell, and the cap is
      // counted for the whole turn.
      expect(variant.nudges).toBe(2);
      expect(variant.error).toContain("went quiet again after two nudges");
    }),
  ));

test("an agent herdr no longer has is given up on at once, not waited out", () =>
  runEffect(
    Effect.gen(function* () {
      // A closed tab or a killed pane never breaks a quiet budget, and waiting one out
      // is half an hour of nothing reported as if two nudges had been ignored.
      const { run, status } = yield* runWorkflowEffect(
        rig,
        "solo",
        { goal: "Add a picker", ticket: "" },
        {
          env: {
            FAKE_HERDR_AGENT_STATUS: "working",
            FAKE_HERDR_AGENTS_GONE: "solo-add-a-picker-solo-r1",
          },
          defaults: { quietMs: 60_000 },
          outputPollMs: 5,
        },
      );

      expect(status).toBe("blocked");
      const variant = run.record.steps[0]!.variants[0]!;
      expect(variant.error).toContain("is gone — herdr no longer has it");
      // Nobody was nudged: there was nothing there to nudge.
      expect(variant.nudges).toBe(0);
    }),
  ));

test("a repair prompt that never lands is not recorded as a repair", () =>
  runEffect(
    Effect.gen(function* () {
      yield* rig.queueOutputs(["not json at all"]);

      const { run, status } = yield* runWorkflowEffect(
        rig,
        "solo",
        { goal: "Add a picker", ticket: "" },
        // The step's own prompt lands; the repair's does not.
        { env: { FAKE_HERDR_FAIL_PROMPT_FROM: "2" } },
      );

      expect(status).toBe("blocked");
      const variant = run.record.steps[0]!.variants[0]!;
      // The Output problem is what the human is told about, and nothing claims the
      // agent was asked to rewrite it.
      expect(variant.error).toContain("not valid JSON");
      expect(variant.repairs).toEqual([]);
      const toast = (yield* rig.calls()).filter((c) => c.cmd === "notification show").at(-1)!.argv!;
      expect(toast.at(-1)).not.toContain("asked once already");
    }),
  ));

test("herdr going quiet for a moment does not discard a live step", () =>
  runEffect(
    Effect.gen(function* () {
      // Not an answer, just no answer: a socket hiccup must not be read as a missing
      // agent and throw away a step that is working.
      yield* rig.queueOutputs([{ verdict: "clean", findings: [] }]);

      const { run, status } = yield* runWorkflowEffect(
        rig,
        "solo",
        { goal: "Add a picker", ticket: "" },
        {
          env: {
            FAKE_HERDR_FAIL: encodeJson({ "agent get": "socket closed" }),
            FAKE_HERDR_FAIL_TIMES: "3",
          },
          defaults: { quietMs: 60_000 },
          outputPollMs: 5,
        },
      );

      expect(status).toBe("done");
      expect(run.record.steps[0]!.variants[0]!.error).toBeNull();
    }),
  ));

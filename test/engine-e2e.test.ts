import { afterEach, beforeEach, expect, test } from "bun:test";
import { Clock, ConfigProvider, Effect, FileSystem, Path, Schema } from "effect";
import { TestClock } from "effect/testing";
import { FakeHerdr, Rig } from "./support/recorder";
import {} from "../src/naming";
import { fakeHerdr } from "./support/fake-herdr-core";
import {
  EffectFakeHerdr,
  installBaseline,
  plannedRun,
  runWorkflow,
  scriptedPrompts,
} from "./support/engine";
import { writeDef } from "./support/defs";
import { runEffect } from "./support/effect";
import { writeInbox } from "../src/operations";
import { amend, seedIntent, writeIntent } from "../src/intent";
import { deliveriesOf, herdOf, ledgerPath, readLedger, type Delivery } from "../src/steering";
import {
  currentReports,
  electionsPath,
  pendingEvaluation,
  readDrift,
  readElections,
  shouldStand,
} from "../src/drift";
import { FakeBin } from "./support/bin";
import { REQUIRED_FLAGS } from "../src/evaluator";
import { RunStore } from "../src/run";

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

const BUILDER = `---
name: builder
title: builder — a fresh look, then the agent that builds
inputs:
  plan: work-source
steps:
  - id: look
    persona: reviewer
    fresh: true
    output: look.json
  - id: build
    persona: implementer
    output: build.json
---
## look

Read the tickets in {{inputs.plan}} ({{inputs.plan_kind}}).

## build

Build them.
`;

beforeEach(() =>
  runEffect(
    Effect.gen(function* () {
      rig = yield* Rig.make();
      yield* rig.startSocket();
      yield* installBaseline(rig);
      yield* writeDef(rig.baselineDir, "workflows", "solo", SOLO);
      yield* writeDef(rig.baselineDir, "workflows", "builder", BUILDER);
    }),
  ),
);

afterEach(() => runEffect(rig.close()));

function runWorkflowEffect(...args: Parameters<typeof runWorkflow>) {
  return runWorkflow(...args).pipe(Effect.orDie);
}

function runQuietWorkflowEffect(...args: Parameters<typeof runWorkflow>) {
  return Effect.gen(function* () {
    const clock = yield* TestClock.make();
    // ponytail: these workflows have one polling fiber. Advance only at its sleeps,
    // not during I/O; concurrent polling would need explicit TestClock coordination.
    return yield* runWorkflowEffect(...args).pipe(
      Effect.provideService(Clock.Clock, { ...clock, sleep: clock.adjust }),
    );
  }).pipe(Effect.scoped);
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
      // cd'd into and then abandoned. The Home's own split is not the step's.
      for (const cmd of ["agent start", "tab create"]) expect(yield* rig.cmds()).not.toContain(cmd);
      expect((yield* rig.cmds()).filter((cmd) => cmd === "pane split")).toHaveLength(1);
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
      // The Herd's Home first — the runtime gate, then a workspace of Collie's own with
      // the board's pane in it, owned by the tokens it is given (ADR-0009) — and then
      // the step opens its own tab, after checking whether the launch pane is a reusable
      // numbered shell. Collie owns no tab in *this* workspace yet, so there is no
      // anchor and nothing is reordered. The run itself is driven headlessly.
      expect(yield* rig.cmds()).toEqual([
        "api schema",
        "status server",
        "workspace list",
        "pane list",
        "workspace create",
        // Tokened before its pane is opened, so a pane herdr refuses still leaves a
        // workspace that says whose it is.
        "workspace.report_metadata",
        // What herdr put in the new workspace, noted before Collie's own pane exists so
        // the shell it comes with can be closed rather than left as a second tab.
        "pane list",
        "plugin pane",
        "pane list",
        // The board's pane, then the tab split beside it for native chat.
        "pane split",
        "pane list",
        "pane.report_metadata",
        "pane.report_metadata",
        "tab list",
        "pane list",
        "tab create",
        "tab list",
        "pane run",
        "agent start",
        "agent.view.set",
        // Who is in that pane, twice: once to build the entry the send is addressed to,
        // and once inside the Dispatcher transaction that holds the ledger lock.
        "agent list",
        "agent list",
        // What the agent was doing before the prompt, so that a turn seen afterwards
        // is known to be this prompt's and not one already running.
        "agent get",
        // The submission waits for the agent to take it, so nothing waits again after
        // it: `agent prompt` answers that question at the boundary.
        "agent prompt",
        // The step is watched, not waited on: one status poll, and it is already idle.
        "agent get",
        // Its step over, and then the run: the tab drops the step it was on, and
        // then says the run is done. Each rename asks what the tab is called first, so
        // a tab the human has renamed keeps their name instead of this one.
        "tab list",
        "tab rename",
        "tab list",
        "tab rename",
        "agent.view.clear",
        "notification show",
      ]);

      // No pane is moved or swapped for the run itself, and the one split is the Home's
      // own — the board beside native chat. The step's tab holds the agent.
      for (const cmd of ["pane move", "pane swap"]) expect(yield* rig.cmds()).not.toContain(cmd);
      expect((yield* rig.cmds()).filter((cmd) => cmd === "pane split")).toHaveLength(1);
      // No pane rename in the whole run. The board's pane is the Home's and is owned by
      // a token rather than by a name, and the agent's pane is alone in its tab — so the
      // tab says `Solo` and the pane says nothing.
      expect(
        (yield* rig.calls()).filter((c) => c.cmd === "pane rename").map((c) => c.argv!.slice(2)),
      ).toEqual([]);
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
        "1-3",
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
        filter: { op: "in", field: "pane_id", values: ["1-3"] },
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

test("starting work trusts its directory without a duplicate Collie approval", () =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      yield* claudeSeen(rig, {});
      yield* rig.queueOutputs([{ verdict: "clean", findings: [] }]);
      const prompts = scriptedPrompts([]);

      const { run, status, lines } = yield* runWorkflowEffect(
        rig,
        "solo",
        { goal: "g" },
        { prompts },
      );

      expect(status).toBe("done");
      expect(prompts.offered).toEqual([]);
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

test("explicitly disabling trust leaves Claude's configuration alone", () =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      yield* claudeSeen(rig, {});
      yield* rig.queueOutputs([{ verdict: "clean", findings: [] }]);
      const prompts = scriptedPrompts([]);
      yield* fs.writeFileString(
        path.join(rig.configDir, "config.json"),
        encodeJson({ trust: "never" }),
      );

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
      const { run, status } = yield* runQuietWorkflowEffect(
        rig,
        "solo",
        { goal: "Add a picker", ticket: "" },
        {
          // Quiet is the signal: same status, same pane tail, every poll.
          env: { FAKE_HERDR_AGENT_STATUS: "working", FAKE_HERDR_PANE_TEXT: "stuck" },
          // The simulated clock advances only between polls, not during I/O.
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
      const { run, status } = yield* runQuietWorkflowEffect(
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
      const { run, status } = yield* runQuietWorkflowEffect(
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
      yield* rig.queueOutputs([
        { verdict: "clean", findings: [] },
        { verdict: "clean", findings: [] },
      ]);

      // Two runs, because the first tab Collie opens in a workspace is the anchor for
      // the ones after it: with nothing of Collie's in the strip there is no anchor and
      // nothing to reorder, so the failure this is about only happens to the second.
      yield* runWorkflowEffect(rig, "solo", { goal: "one", ticket: "" });
      const { run, status } = yield* runWorkflowEffect(
        rig,
        "solo",
        { goal: "two", ticket: "" },
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

      const { run, status } = yield* runQuietWorkflowEffect(
        rig,
        "solo",
        { goal: "Add a picker", ticket: "" },
        {
          env: { FAKE_HERDR_AGENT_STATUS: "working", FAKE_HERDR_PANE_TEXT: "stuck" },
          // Ten simulated polls per quiet period; wall-clock I/O is not the signal.
          defaults: { quietMs: 1000 },
          outputPollMs: 100,
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
      const { run, status } = yield* runQuietWorkflowEffect(
        rig,
        "solo",
        { goal: "Add a picker", ticket: "" },
        {
          env: { FAKE_HERDR_AGENT_STATUS: "working", FAKE_HERDR_PANE_TEXT: "prompts" },
          // Ten simulated polls per quiet period; wall-clock I/O is not the signal.
          defaults: { quietMs: 1000 },
          outputPollMs: 100,
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
      const { run, status } = yield* runQuietWorkflowEffect(
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

test("a hold written while a Run works stops the next piece of work, and a release starts it", () =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      yield* rig.queueOutputs([{ verdict: "clean", findings: [], slug: "s" }]);

      const { run, status } = yield* runWorkflowEffect(
        rig,
        "solo",
        { goal: "Add a picker" },
        {
          outputPollMs: 20,
          // Written before the Driver looks: the boundary of the first step is the
          // first thing that reads the inbox, so this is the hold it finds there.
          before: (started) =>
            Effect.gen(function* () {
              yield* writeInbox(started.dir, {
                type: "hold",
                requestId: "hold-1",
                reason: "wrong branch",
              });
              // Released from beside the Driver, after it is already holding: the point
              // of the test is that the hold loop keeps reading the inbox while it waits,
              // rather than checking once on the way past.
              yield* Effect.forkDetach(
                writeInbox(started.dir, {
                  type: "release",
                  requestId: "rel-1",
                  reason: "fixed",
                }).pipe(Effect.delay(200)),
              );
            }),
        },
      );

      expect(status).toBe("done");
      const log = yield* fs.readFileString(path.join(run.dir, "log.txt"));
      expect(log).toContain("held: wrong branch");
      expect(log).toContain("released: fixed");
      // The hold is over, so the Run is not left marked as waiting on a human.
      expect(run.record.awaiting).toBeNull();
    }),
  ));

test("an Intent amended under a live Driver is loaded, and a stale drift report is refused", () =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      yield* rig.queueOutputs([{ verdict: "clean", findings: [], slug: "s" }]);

      const { run } = yield* runWorkflowEffect(
        rig,
        "solo",
        { goal: "Add a picker" },
        {
          outputPollMs: 20,
          before: (started) =>
            Effect.gen(function* () {
              const v1 = seedIntent(started.id, { goal: "Add a picker" });
              yield* writeIntent(
                started.dir,
                amend(v1, { kind: "set-goal", goal: "Add two" }, "human:req", "t"),
              );
              yield* writeInbox(started.dir, {
                type: "intent_changed",
                requestId: "int-1",
                version: 2,
              });
              // Judged against v1, which is not the Intent any more.
              yield* writeInbox(started.dir, {
                type: "drift_report",
                requestId: "dr-1",
                report: { id: "dr-1", constraint: "gone" },
                vector: { intentVersion: 1, cardId: null },
              });
            }),
        },
      );

      const log = yield* fs.readFileString(path.join(run.dir, "log.txt"));
      expect(log).toContain("intent v2 loaded");
      expect(log).toContain("drift_report_stale: judged at intent v1, now v2");
      // Nothing was appended *from the stale command*. Not "the journal is empty": this
      // Run has a goal, so `finish` owes it a judgement, and one nobody could make is a
      // `skipped` line — which is what keeps the Run `unverified` rather than clean.
      const journal = yield* readDrift(run.dir);
      expect(journal.filter((line) => line.kind !== "skipped")).toEqual([]);
    }),
  ));

test("a boundary steer is composed in front of the next work, and recorded as its own delivery", () =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      yield* rig.queueOutputs([{ verdict: "clean", findings: [], slug: "s" }]);

      const { run, status } = yield* runWorkflowEffect(
        rig,
        "solo",
        { goal: "Add a picker" },
        {
          outputPollMs: 20,
          before: (started) =>
            writeInbox(started.dir, {
              type: "deliver",
              requestId: "steer-1",
              deliver: {
                deliveryId: "steer-1",
                incarnation: "term-solo-add-a-picker-solo-r1",
                agent: "solo-add-a-picker-solo-r1",
                text: "stay inside src/",
                mode: "boundary",
                cause: { kind: "steer", ref: "s1" },
                intentVersion: 1,
                attempt: 1,
              },
            }),
        },
      );

      expect(status).toBe("done");
      const prompt = yield* fs.readFileString(path.join(run.dir, "steps", "solo", "prompt-1.md"));
      // In front of the work, not behind it: a steer that queued behind the task would
      // be read after the thing it was meant to change.
      expect(prompt.startsWith("## Steering\n")).toBe(true);
      expect(prompt).toContain("(steer-1) stay inside src/");
      expect(prompt).toContain(path.join(run.dir, "steering", "acks", "steer-1.json"));

      // Its own ledger line, saying which prompt carried it.
      const ledger = yield* readLedger(
        yield* ledgerPath(rig.stateDir, "term-solo-add-a-picker-solo-r1"),
      );
      const composed = ledger.filter((line) => "state" in line && line.id === "steer-1");
      expect(composed.map((line) => ("state" in line ? line.state : ""))).toEqual(["submitted"]);
    }),
  ));

test("a hand-off herdr saw no turn come of says so, in the record and to the human", () =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      yield* rig.queueOutputs([{ verdict: "clean", findings: [], slug: "s" }]);

      // Queued the way `sendReview` queues one: through the receiving Run's inbox, for
      // its Driver to compose into the next prompt. herdr's `--wait` then runs out
      // without a turn seen — the text was written; nobody can say it was read.
      const { run, status } = yield* runWorkflowEffect(
        rig,
        "solo",
        { goal: "Add a picker" },
        {
          env: { FAKE_HERDR_PROMPT_ERROR: "timeout" },
          outputPollMs: 20,
          before: (started) =>
            writeInbox(started.dir, {
              type: "deliver",
              requestId: "handoff-1",
              deliver: {
                deliveryId: "handoff-1",
                incarnation: "term-solo-add-a-picker-solo-r1",
                agent: "solo-add-a-picker-solo-r1",
                text: "review.md is ready for you",
                mode: "boundary",
                cause: { kind: "handoff", ref: "review-run-1" },
                intentVersion: 0,
                attempt: 1,
              },
            }),
        },
      );

      // Written and worked on: the Run is not failed for a wait that ran out.
      expect(status).toBe("done");
      const log = yield* fs.readFileString(path.join(run.dir, "log.txt"));
      expect(log).toContain("solo-add-a-picker-solo-r1: prompt written, no turn observed");

      // The audit trail: the carrier is `submitted`, never rounded up, with the doubt as
      // its note — and it stays that way once the Output is collected, because an Output
      // beside a prompt nobody saw taken does not say the prompt was read. The hand-off it
      // carried inherits exactly that doubt.
      const ledger = (yield* readLedger(
        yield* ledgerPath(rig.stateDir, "term-solo-add-a-picker-solo-r1"),
      )).filter((line): line is Delivery => "state" in line);
      const carrier = ledger.filter((line) => line.cause.kind === "step");
      expect(carrier.map((line) => [line.state, line.note ?? ""])).toEqual([
        ["reserved", ""],
        ["submitted", "unobserved"],
      ]);
      const handoff = ledger.filter((line) => line.id === "handoff-1");
      expect(handoff.map((line) => line.state)).toEqual(["submitted"]);
      expect(handoff[0]?.note).toMatch(/^composed into .*; unobserved$/);

      // What the human is shown: `run deliveries` says it beside the state.
      const shown = (yield* deliveriesOf(rig.stateDir, run.id)).map((entry) => entry.delivery);
      expect(shown.find((d) => d.id === "handoff-1")?.note).toContain("unobserved");
    }),
  ));

test("a cross-run winner re-judges a stale snapshot twice, then leaves the Herd a pending mark", () =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const key = yield* herdOf(rig.socketPath);
      const elections = yield* electionsPath(rig.stateDir, key ?? "");
      yield* fs.makeDirectory(path.dirname(elections), { recursive: true });

      // A model that answers every Judgement cleanly — and a Herd that moves under it:
      // every call, a loser's `dirty` lands after the snapshot the call was made from.
      const bin = yield* FakeBin.make(path.join(rig.root, "fakebin"));
      const flags = REQUIRED_FLAGS.join(" ");
      yield* bin.add(
        "claude",
        [
          `case "$1" in --help) echo "${flags}"; exit 0;; esac`,
          "cat >/dev/null",
          `printf '{"kind":"dirty","at":"%s","by":"boundary","run":"sibling"}\\n' "$(date -u +%Y-%m-%dT%H:%M:%S.999Z)" >> "${elections}"`,
          `echo '{"result":"{\\"reports\\":[]}"}'`,
        ].join("\n"),
      );
      yield* rig.queueOutputs([{ verdict: "clean", findings: [], slug: "s" }]);

      const { run, status } = yield* runWorkflowEffect(
        rig,
        "solo",
        { goal: "Add a picker" },
        {
          outputPollMs: 20,
          before: (started) =>
            Effect.gen(function* () {
              // A child makes this Run related, so it stands; an Intent is what a
              // Judgement is charged to.
              const sibling = yield* new RunStore(rig.stateDir).create({
                workflow: "solo",
                cwd: started.record.cwd,
                inputs: {},
                inputSources: {},
                stepIds: ["solo"],
                maxIterations: 1,
                namedAfter: "sibling",
              });
              started.record.children.push(sibling.id);
              yield* started.save();
              yield* writeIntent(started.dir, seedIntent(started.id, { goal: "Add a picker" }));
            }),
        },
      ).pipe(Effect.ensuring(bin.restore()));

      expect(status).toBe("done");
      const log = yield* fs.readFileString(path.join(run.dir, "log.txt"));
      // One call, then at most two more — never a third extra pass, however the Herd moves.
      expect(log).toContain("cross-run snapshot went stale; judging again (extra pass 1)");
      expect(log).toContain("cross-run snapshot went stale; judging again (extra pass 2)");
      expect(log).not.toContain("extra pass 3");
      expect(log).toContain("the Herd kept moving through the passes");
      // Durable, and everybody's: the mark names both sides of the relationship, so the
      // wake rule hands it to the next Driver event anywhere in the Herd.
      const lines = yield* readElections(elections);
      const pending = pendingEvaluation(lines);
      expect([...(pending?.runs ?? [])].sort()).toEqual([run.id, run.record.children[0]!].sort());
      expect(shouldStand(lines, false)).toBe(true);
    }),
  ));

test("a rule constraint is checked against the tree, once per finding", () =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      yield* rig.queueOutputs([{ verdict: "clean", findings: [], slug: "s" }]);

      const { run, status } = yield* runWorkflowEffect(
        rig,
        "solo",
        { goal: "Add a picker" },
        {
          outputPollMs: 20,
          before: (started) =>
            Effect.gen(function* () {
              // Everything outside `src/` is out of bounds; the run's own directory has
              // nothing in `src/` at all, so whatever it writes is a breach.
              yield* writeIntent(
                started.dir,
                seedIntent(started.id, {
                  goal: "Add a picker",
                  constraints: [
                    {
                      id: "paths",
                      kind: "rule",
                      text: "rule:protected_paths:src/**",
                      severity: "block",
                      source: "human",
                      rule: { kind: "protected_paths", globs: ["src/**"] },
                    },
                  ],
                }),
              );
              // A change the check will find, in the tree the Run works in: untracked,
              // which is what a file an agent just wrote looks like.
              yield* Effect.sync(() => {
                for (const argv of [
                  ["init", "-q"],
                  ["config", "user.email", "t@example.com"],
                  ["config", "user.name", "t"],
                ])
                  Bun.spawnSync(["git", ...argv], { cwd: started.record.cwd, stdout: "pipe" });
              });
              yield* fs.writeFileString(path.join(started.record.cwd, "notes.md"), "hello\n");
            }),
        },
      );

      expect(status).toBe("done");
      const reports = currentReports(yield* readDrift(run.dir));
      expect(reports.map((report) => report.constraint)).toEqual(["paths"]);
      expect(reports[0]?.evidence.map((ref) => ref.path)).toContain("notes.md");
      // Checked at collect, at the boundary and at finish, and still one finding: the
      // same breach in the same place is not three of them.
      expect(reports).toHaveLength(1);
    }),
  ));

test("a ticket rewritten under a building step is sent to it as a change to reconcile", () =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const planDir = yield* plannedRun(rig, "add-picker");
      const ticket = path.join(planDir, "issues", "01-first.md");
      yield* fs.writeFileString(ticket, "# 01: first\n\n- [ ] keep the existing layout\n");
      yield* rig.queueOutputs([
        { verdict: "clean", findings: [] },
        { verdict: "clean", findings: [] },
      ]);

      // Edit after the first agent receives work, not after an assumed startup time.
      class EditingHerdr extends EffectFakeHerdr {
        private edited = false;
        override agentPrompt(target: string, text: string) {
          return super.agentPrompt(target, text).pipe(
            Effect.tap(() => {
              if (this.edited) return Effect.void;
              this.edited = true;
              return fs
                .writeFileString(
                  ticket,
                  "# 01: first\n\n- [ ] collisions are explicit refusals\n- [ ] a destination-keyed lock\n",
                )
                .pipe(Effect.orDie);
            }),
          );
        }
      }
      const env = {
        FAKE_HERDR_AGENT_STATUS: [
          ...Array(40).fill("working"),
          "idle",
          ...Array(40).fill("working"),
          "idle",
        ].join(","),
        FAKE_HERDR_PANE_TEXT: "changing",
      };

      const { run, status } = yield* runWorkflowEffect(
        rig,
        "builder",
        { plan: planDir },
        {
          env,
          herdr: new EditingHerdr(rig.pluginEnv(), rig.env(env)),
          defaults: { quietMs: 3000 },
          outputPollMs: 10,
        },
      );

      expect(status).toBe("done");
      const changed = (yield* rig.calls()).filter(
        (c) => c.cmd === "agent prompt" && c.argv![3]!.includes("changed on disk"),
      );
      // Once, and to the builder, not the fresh review step that reads the tickets itself.
      expect(changed).toHaveLength(1);
      expect(changed[0]!.argv![2]).toBe(run.step("build").variants[0]!.agent);
      const told = changed.map((c) => c.argv![3]!);
      // The checkboxes, both ways: what the ticket now demands and what it dropped.
      expect(told[0]).toContain("01-first.md changed:");
      expect(told[0]).toContain("+ - [ ] a destination-keyed lock");
      expect(told[0]).toContain("- - [ ] keep the existing layout");
      expect(told[0]).toContain("Reconcile rather than restart");
    }),
  ));

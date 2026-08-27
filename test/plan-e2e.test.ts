import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Rig } from "./support/recorder";
import { installBaseline, runWorkflow } from "./support/engine";
import { filterItems, renderList } from "../src/picker";

let rig: Rig;

beforeEach(async () => {
  rig = new Rig();
  await rig.startSocket();
  installBaseline(rig);
});

afterEach(async () => {
  await rig.close();
});

test("plan runs one step in the status pane's tab and records the run", async () => {
  rig.queueOutputs([{ verdict: "clean", findings: [], plan_file: "tasks/add-a-picker/PLAN.md", slug: "add-a-picker" }]);

  const { run, status, lines } = await runWorkflow(rig, "plan", { goal: "Add a picker" });

  expect(status).toBe("done");
  expect(rig.cmds()).toEqual([
    "pane split",
    "pane rename",
    "pane run",
    "agent start",
    "agent.view.set",
    "agent prompt",
    "agent wait",
    "agent wait",
    "pane rename",
    "agent.view.clear",
    "notification show",
  ]);

  const start = rig.calls().find((c) => c.cmd === "agent start")!.argv!;
  expect(start.slice(0, 8)).toEqual([
    "agent",
    "start",
    "plan-add-a-picker-plan-r1",
    "--kind",
    "claude",
    "--pane",
    "1-1",
    "--",
  ]);
  expect(start.slice(8, 10)).toEqual(["--model", "sonnet"]);
  expect(start[10]).toBe("--append-system-prompt-file");
  expect(start[11]).toBe(join(run.dir, "personas", "planner.md"));
  expect(readFileSync(start[11]!, "utf8")).toContain("You are a planner");

  // The prompt goes to a file: a multi-line prompt cannot be typed into a harness.
  const promptPath = join(run.dir, "steps", "plan", "prompt-1.md");
  expect(rig.calls().find((c) => c.cmd === "agent prompt")!.argv![3]).toBe(
    `Your task for this step is in ${promptPath} — read it and follow it.`,
  );
  const prompt = readFileSync(promptPath, "utf8");
  expect(prompt).toContain("Add a picker");
  expect(prompt).toContain("tasks/<slug>/PLAN.md");
  expect(prompt).toContain(`OUTPUT_PATH: ${join(run.dir, "steps", "plan", "plan.json")}`);

  expect(rig.calls().find((c) => c.cmd === "pane rename")!.argv).toEqual([
    "pane",
    "rename",
    "1-1",
    "plan-add-a-picker/plan",
  ]);
  expect(rig.calls().filter((c) => c.cmd === "pane rename")[1]!.argv![3]).toBe("✓ plan-add-a-picker/plan");

  const record = JSON.parse(readFileSync(join(run.dir, "run.json"), "utf8"));
  expect(record.workflow).toBe("plan");
  expect(record.status).toBe("done");
  expect(record.inputs).toEqual({ goal: "Add a picker", ticket: "" });
  expect(record.input_sources.goal).toBe("asked");
  expect(record.steps).toHaveLength(1);
  expect(record.steps[0].status).toBe("done");
  expect(record.steps[0].variants[0]).toMatchObject({
    harness: "claude",
    model: "sonnet",
    agent: "plan-add-a-picker-plan-r1",
    label: "plan-add-a-picker/plan",
    status: "done",
    output: "steps/plan/plan.json",
  });
  expect(existsSync(join(run.dir, "steps", "plan", "plan.json"))).toBe(true);
  expect(lines.at(-1)).toContain("done after 1 iteration(s)");
});

test("a step whose Output never appears blocks the run and toasts", async () => {
  rig.queueOutputs([]);

  const { run, status } = await runWorkflow(rig, "plan", { goal: "Add a picker" });

  expect(status).toBe("blocked");
  expect(run.record.steps[0]!.status).toBe("blocked");
  expect(run.record.steps[0]!.variants[0]!.error).toBe("no Output at steps/plan/plan.json");
  const toast = rig.calls().find((c) => c.cmd === "notification show")!.argv!;
  expect(toast[2]).toBe("plan-add-a-picker blocked");
  expect(toast).toContain("plan needs you");
  expect(rig.cmds()).toContain("agent.view.clear");
});

test("an Output that is not valid JSON fails the step with the parse error", async () => {
  rig.queueOutputs(["not json"]);

  const { run, status } = await runWorkflow(rig, "plan", { goal: "g" });

  expect(status).toBe("blocked");
  expect(run.record.steps[0]!.variants[0]!.status).toBe("failed");
  expect(run.record.steps[0]!.variants[0]!.error).toContain("not valid JSON");
});

test("the sidebar filter is set to the run's panes and cleared at the end", async () => {
  rig.queueOutputs([{ verdict: "clean", findings: [] }]);

  const { run } = await runWorkflow(rig, "plan", { goal: "g" });

  const set = rig.calls().find((c) => c.cmd === "agent.view.set")!;
  expect(set.params).toEqual({
    source: `cego.workflows:${run.id}`,
    label: run.record.slug,
    filter: { op: "in", field: "pane_id", values: ["1-1"] },
  });
  expect(rig.calls().find((c) => c.cmd === "agent.view.clear")!.params).toEqual({
    source: `cego.workflows:${run.id}`,
  });
});

test("every baseline workflow resolves and validates", async () => {
  const { loadDefinitions, layers, resolveWorkflow } = await import("../src/definitions");
  const { validateWorkflow } = await import("../src/definitions");
  const { FALLBACK_DEFAULTS } = await import("../src/config");
  const env = rig.pluginEnv();
  const defs = loadDefinitions(layers(env));

  expect(defs.errors).toEqual([]);
  expect([...defs.workflows.keys()].sort()).toEqual(["implement", "plan", "review"]);
  expect([...defs.personas.keys()].sort()).toEqual(["implementer", "planner", "reviewer"]);

  for (const name of defs.workflows.keys()) {
    const wf = resolveWorkflow(name, defs, FALLBACK_DEFAULTS);
    expect(validateWorkflow(wf, defs, FALLBACK_DEFAULTS)).toEqual([]);
  }
});

test("the picker ranks name prefix, then substring, then in-order characters", () => {
  const items = [
    { id: "implement", title: "implement — build from a plan, review in parallel", subtitle: "[baseline]" },
    { id: "plan", title: "plan — interview me", subtitle: "[baseline]" },
    { id: "review", title: "review — an MR", subtitle: "[user]" },
  ];

  expect(filterItems(items, "plan").map((i) => i.id)).toEqual(["plan", "implement"]);
  expect(filterItems(items, "review").map((i) => i.id)).toEqual(["review", "implement"]);
  expect(filterItems(items, "ipm").map((i) => i.id)).toEqual(["implement"]);
  expect(filterItems(items, "user").map((i) => i.id)).toEqual(["review"]);
  expect(filterItems(items, "zz")).toEqual([]);
  expect(filterItems(items, "")).toEqual(items);
});

test("the picker marks the selected row and shows the query", () => {
  const items = [
    { id: "plan", title: "plan", subtitle: "[baseline]" },
    { id: "review", title: "review", subtitle: "[user]" },
  ];

  const out = renderList(items, 1, "re", { header: "Workflows", footer: "Enter run" });

  expect(out.split("\n")).toEqual([
    "Workflows",
    "> re",
    "",
    "  plan                          [baseline]",
    "❯ review                        [user]",
    "",
    "Enter run",
  ]);
});

test("an interviewing agent hands off, and the step finishes when the Output appears", async () => {
  rig.queueOutputs([{ __delay_ms: 300, output: { verdict: "clean", findings: [], slug: "s" } }]);

  const { run, status, lines } = await runWorkflow(
    rig,
    "plan",
    { goal: "Add a picker" },
    { handoffTimeoutMs: 10_000, outputPollMs: 50 },
  );

  expect(status).toBe("done");
  expect(run.record.steps[0]!.status).toBe("done");
  expect(lines.some((l) => l.includes("is waiting for you in its tab"))).toBe(true);
  const toasts = rig.calls().filter((c) => c.cmd === "notification show");
  expect(toasts[0]!.argv![2]).toBe("plan-add-a-picker needs you");
  expect(toasts.at(-1)!.argv![2]).toBe("plan-add-a-picker finished");
});

test("a stdin chunk carrying several keypresses is split into keys", async () => {
  const { tokenizeKeys } = await import("../src/picker");

  expect(tokenizeKeys("\x7f\x7f\x7f")).toEqual(["\x7f", "\x7f", "\x7f"]);
  expect(tokenizeKeys("re\x1b[Bv\r")).toEqual(["r", "e", "\x1b[B", "v", "\r"]);
  expect(tokenizeKeys("\x1b")).toEqual(["\x1b"]);
});

test("agent names stay inside herdr's 32-character lowercase limit", async () => {
  const { agentName, stepLabel } = await import("../src/naming");

  expect(agentName("plan-add-a-picker", "plan", null, 1)).toBe("plan-add-a-picker-plan-r1");
  const long = agentName("implement-a-very-long-goal-indeed-truly", "review", "claude-sonnet", 12);
  expect(long).toBe("impleme-review-claude-sonnet-r12");
  expect(long.length).toBeLessThanOrEqual(32);
  expect(long).toMatch(/^[a-z][a-z0-9_-]*$/);
  expect(agentName("9lives", "s", null, 1)).toMatch(/^[a-z]/);
  expect(stepLabel("plan-x", "review", "codex-gpt-5-codex")).toBe("plan-x/review/codex-gpt-5-codex");
});

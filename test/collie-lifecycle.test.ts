import { afterEach, beforeEach, expect, test } from "bun:test";
import { appendFileSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = new URL("../", import.meta.url).pathname;
let dir: string;
let env: Record<string, string>;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "collie-life-"));
  const plugin = join(dir, "plugin");
  const workspace = join(dir, "workspace");
  mkdirSync(join(plugin, "workflows"), { recursive: true });
  mkdirSync(join(plugin, "personas"), { recursive: true });
  mkdirSync(workspace);
  writeFileSync(join(plugin, "workflows", "demo.md"), `---
name: demo
title: Demo
description: A demo.
inputs:
  goal: goal
steps:
  - id: work
    persona: helper
    output: out.json
---
## work
Do it.
`);
  writeFileSync(join(plugin, "personas", "helper.md"), `---
name: helper
description: Helps.
---
Help.
`);
  const herdr = join(dir, "herdr");
  writeFileSync(herdr, `#!/bin/sh
if [ "$1 $2" = "workspace list" ]; then
  printf '%s\n' '{"result":{"workspaces":[{"workspace_id":"w1","label":"One","cwd":"${workspace}","worktree":{"path":"${workspace}"}},{"workspace_id":"w2","label":"Two","cwd":"${workspace}"}]}}'
fi
`, { mode: 0o755 });
  const driver = join(dir, "driver");
  writeFileSync(driver, `#!/bin/sh
printf '%s\n' "$COLLIE_RUN" >> "${join(dir, "drivers")}" 
`, { mode: 0o755 });
  env = {
    PATH: process.env.PATH ?? "",
    HOME: dir,
    HERDR_PLUGIN_ROOT: plugin,
    HERDR_PLUGIN_CONFIG_DIR: join(dir, "config"),
    HERDR_PLUGIN_STATE_DIR: join(dir, "state"),
    HERDR_BIN_PATH: herdr,
    COLLIE_DRIVER: driver,
  };
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

async function cli(args: string[]) {
  const process = Bun.spawn(["bun", join(root, "src/main.ts"), "--json", ...args], {
    cwd: root,
    env,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exit] = await Promise.all([
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
    process.exited,
  ]);
  return { body: JSON.parse(stdout), stderr, exit };
}

test("start, inspect, scope, and every mutation are retry-safe", async () => {
  const first = await cli(["--workspace", "w1", "run", "start", "demo", "--input", "goal=ship", "--request-id", "start-1"]);
  const retry = await cli(["--workspace", "w1", "run", "start", "demo", "--input", "goal=ignored", "--request-id", "start-1"]);
  expect(first.exit).toBe(0);
  expect(retry.body.data.runId).toBe(first.body.data.runId);
  expect(readFileSync(join(dir, "drivers"), "utf8").trim().split("\n")).toHaveLength(1);

  const runId = first.body.data.runId as string;
  const shown = (await cli(["--workspace", "w1", "run", "show", runId])).body.data.run;
  expect(shown).toMatchObject({ workspace: "w1", workspace_label: "One", workspace_worktree: join(dir, "workspace"), cwd: join(dir, "workspace") });
  expect((await cli(["--workspace", "w2", "run", "show", runId])).body.error.code).toBe("run_not_found");

  const runDir = join(dir, "state", "runs", runId);
  const snapshotPath = join(runDir, "run.json");
  const snapshot = JSON.parse(readFileSync(snapshotPath, "utf8"));
  snapshot.steps[0].status = "done";
  writeFileSync(snapshotPath, JSON.stringify(snapshot));
  writeFileSync(join(runDir, "choice.json"), JSON.stringify({
    id: "choice-1", kind: "menu", run: runId, step: "work", header: "Pick", footer: "", items: [{ id: "yes", title: "Yes" }],
  }));
  const answer = await cli(["--workspace", "w1", "run", "answer", runId, "yes", "--request-id", "answer-1"]);
  const answerRetry = await cli(["--workspace", "w1", "run", "answer", runId, "yes", "--request-id", "answer-1"]);
  expect(answerRetry.body).toEqual(answer.body);
  expect(existsSync(join(runDir, "inbox", "answer-1.json"))).toBe(true);

  const stopped = await cli(["--workspace", "w1", "run", "stop", runId, "--request-id", "stop-1"]);
  expect(stopped.body.data.status).toBe("stopped");
  const resumed = await cli(["--workspace", "w1", "run", "resume", runId, "--request-id", "resume-1"]);
  expect(resumed.body.data.status).toBe("running");
  expect((await cli(["--workspace", "w1", "run", "show", runId])).body.data.run.steps[0].status).toBe("done");
});

test("wait follows recorded progress to exactly one successful terminal event", async () => {
  const started = await cli(["--workspace", "w1", "run", "start", "demo", "--input", "goal=wait"]);
  const runId = started.body.data.runId as string;
  const runDir = join(dir, "state", "runs", runId);
  appendFileSync(join(runDir, "progress.jsonl"), `${JSON.stringify({ at: new Date().toISOString(), text: "finished work" })}\n`);
  const snapshotPath = join(runDir, "run.json");
  const snapshot = JSON.parse(readFileSync(snapshotPath, "utf8"));
  snapshot.status = "done";
  snapshot.finished_at = new Date().toISOString();
  snapshot.steps[0].status = "done";
  writeFileSync(snapshotPath, JSON.stringify(snapshot));

  const process = Bun.spawn(["bun", join(root, "src/main.ts"), "--json", "--workspace", "w1", "run", "wait", runId, "--follow"], {
    cwd: root, env, stdout: "pipe", stderr: "pipe",
  });
  const output = await new Response(process.stdout).text();
  expect(await process.exited).toBe(0);
  const events = output.trim().split("\n").map((line) => JSON.parse(line));
  expect(events.map((event) => event.type)).toEqual(["snapshot", "progress", "terminal"]);
  expect(events.filter((event) => event.type === "terminal")).toHaveLength(1);
});

test("workflow and persona forks never overwrite and retries return the receipt", async () => {
  const workflow = await cli(["workflow", "fork", "demo", "--layer", "user", "--mode", "extends", "--name", "mine", "--step", "work", "--request-id", "wf-1"]);
  expect(workflow.exit).toBe(0);
  expect(readFileSync(workflow.body.data.path, "utf8")).toContain("extends: demo");
  expect((await cli(["workflow", "fork", "demo", "--layer", "user", "--mode", "extends", "--name", "mine", "--request-id", "wf-1"])).body).toEqual(workflow.body);
  expect((await cli(["workflow", "fork", "demo", "--layer", "user", "--mode", "copy", "--name", "mine"])).body.error.code).toBe("target_exists");
  expect((await cli(["workflow", "fork", "demo", "--layer", "user", "--mode", "copy", "--name", "../escape"])).body.error.code).toBe("invalid_input");

  const persona = await cli(["persona", "fork", "helper", "--layer", "project", "--name", "project-helper", "--workspace", "w1"]);
  expect(persona.exit).toBe(0);
  expect(persona.body.data.path).toContain("/workspace/.herdr/personas/project-helper.md");
});

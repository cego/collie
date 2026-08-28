#!/usr/bin/env bun
// Fake `herdr` CLI. Records every invocation and answers with canned ids so a
// whole run can be driven without a herdr server. It keeps just enough topology
// — tabs, panes and started agents — that `tab list`, `pane list` and
// `agent list` answer what the run actually built. See test/support/recorder.ts.

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

const log = process.env.FAKE_HERDR_LOG!;
const statePath = `${log}.state.json`;
const argv = process.argv.slice(2);

interface FakeTab {
  tab_id: string;
  label: string;
}

interface FakePane {
  pane_id: string;
  tab_id: string;
  label: string | null;
}

interface FakeAgent {
  name: string;
  pane_id: string;
}

interface State {
  tabs: number;
  panes: number;
  outputs: number;
  /** How many `agent get` calls have seen the agent blocked at startup. */
  blocked: number;
  tabList: FakeTab[];
  paneList: FakePane[];
  agents: FakeAgent[];
}

function loadState(): State {
  const empty: State = { tabs: 0, panes: 0, outputs: 0, blocked: 0, tabList: [], paneList: [], agents: [] };
  if (!existsSync(statePath)) return empty;
  return { ...empty, ...(JSON.parse(readFileSync(statePath, "utf8")) as State) };
}

function saveState(s: State) {
  writeFileSync(statePath, JSON.stringify(s));
}

function record(entry: Record<string, unknown>) {
  mkdirSync(dirname(log), { recursive: true });
  appendFileSync(log, `${JSON.stringify(entry)}\n`);
}

const cmd = argv.slice(0, 2).join(" ");
record({ transport: "cli", cmd, argv });

const failures: Record<string, string> = JSON.parse(process.env.FAKE_HERDR_FAIL ?? "{}");
if (failures[cmd]) {
  process.stderr.write(`${failures[cmd]}\n`);
  process.exit(1);
}

const state = loadState();

const flag = (name: string): string | undefined => {
  const at = argv.indexOf(name);
  return at >= 0 ? argv[at + 1] : undefined;
};

function newTab(label: string): FakeTab {
  const tab = { tab_id: `1:${(state.tabs += 1)}`, label };
  state.tabList.push(tab);
  return tab;
}

function newPane(tabId: string, label: string | null = null): FakePane {
  const pane = { pane_id: `1-${(state.panes += 1)}`, tab_id: tabId, label };
  state.paneList.push(pane);
  return pane;
}

function tabOf(paneId: string): string {
  return state.paneList.find((p) => p.pane_id === paneId)?.tab_id ?? "1:0";
}

// Stands in for a harness stopped on a first-run prompt: `agent start` refuses, and
// the agent stays blocked until someone answers it in the pane.
const blockFor = Number.parseInt(process.env.FAKE_HERDR_BLOCK_START ?? "0", 10);
if (blockFor > 0 && cmd === "agent start" && state.blocked === 0) {
  state.blocked = 1;
  saveState(state);
  process.stdout.write(
    `${JSON.stringify({
      id: "cli:agent:start",
      error: { code: "agent_not_ready", message: `agent ${argv[2]} is blocked during startup and is not ready for prompts` },
    })}\n`,
  );
  process.exit(1);
}

// Whatever a step asks its agent to write, the fake writes for it: the queue in
// FAKE_HERDR_OUTPUTS stands in for real agent work.
if (cmd === "agent prompt") {
  const line = argv[3] ?? "";
  // The runner points the agent at a prompt file; read it the way an agent would.
  const ref = /is in (\S+\.md) /.exec(line);
  const text = ref && existsSync(ref[1]!) ? readFileSync(ref[1]!, "utf8") : line;
  const match = /^OUTPUT_PATH: (.+)$/m.exec(text);
  const queuePath = process.env.FAKE_HERDR_OUTPUTS;
  if (match && queuePath && existsSync(queuePath)) {
    const queue = JSON.parse(readFileSync(queuePath, "utf8")) as unknown[];
    const next = queue[state.outputs];
    state.outputs += 1;
    if (next !== undefined && next !== null) {
      const path = match[1]!.trim();
      mkdirSync(dirname(path), { recursive: true });
      const delayed = next as {
        __delay_ms?: number;
        __write?: Record<string, string>;
        output?: unknown;
      };
      // Stands in for an agent that leaves artefacts behind, not just an Output:
      // paths are relative to the run dir, found by walking up to its run.json.
      if (delayed?.__write) {
        let dir = dirname(match[1]!.trim());
        while (dir !== "/" && !existsSync(`${dir}/run.json`)) dir = dirname(dir);
        for (const [rel, body] of Object.entries(delayed.__write)) {
          const path = `${dir}/${rel}`;
          mkdirSync(dirname(path), { recursive: true });
          writeFileSync(path, body);
        }
      }
      if (typeof delayed?.__delay_ms === "number") {
        // Stands in for an agent that finishes after handing off to the human.
        const body = JSON.stringify(delayed.output ?? {});
        Bun.spawn(
          [
            "bun",
            "-e",
            `await Bun.sleep(${delayed.__delay_ms}); await Bun.write(${JSON.stringify(path)}, ${JSON.stringify(body)});`,
          ],
          { stdout: "ignore", stderr: "ignore", stdin: "ignore" },
        ).unref();
      } else if (delayed?.__write) {
        writeFileSync(path, JSON.stringify(delayed.output ?? {}, null, 2));
      } else {
        writeFileSync(path, typeof next === "string" ? next : JSON.stringify(next, null, 2));
      }
    }
  }
}

let result: unknown = {};
switch (cmd) {
  case "tab create": {
    const tab = newTab(flag("--label") ?? String(state.tabs + 1));
    result = { type: "tab_created", tab, root_pane: newPane(tab.tab_id) };
    break;
  }
  case "tab rename": {
    const tab = state.tabList.find((t) => t.tab_id === argv[2]);
    if (tab) tab.label = argv[3] ?? tab.label;
    break;
  }
  case "tab list":
    result = { type: "tab_list", tabs: state.tabList.map((t) => ({ ...t, workspace_id: "1" })) };
    break;
  case "pane split": {
    result = { type: "pane_split", pane: newPane(tabOf(argv[2]!)) };
    break;
  }
  case "pane rename": {
    const pane = state.paneList.find((p) => p.pane_id === argv[2]);
    if (pane) pane.label = argv[3] ?? pane.label;
    break;
  }
  case "pane close":
    state.paneList = state.paneList.filter((p) => p.pane_id !== argv[2]);
    break;
  case "pane move": {
    const tabId = flag("--tab") ?? "";
    const pane = state.paneList.find((p) => p.pane_id === argv[2]);
    // The runner's own pane was made by herdr, not here; moving it puts it on the map.
    if (pane) pane.tab_id = tabId;
    else state.paneList.push({ pane_id: argv[2]!, tab_id: tabId, label: null });
    result = { type: "pane_move", move_result: { changed: true } };
    break;
  }
  case "pane list":
    result = { type: "pane_list", panes: state.paneList.map((p) => ({ ...p, workspace_id: "1" })) };
    break;
  case "plugin pane": {
    // `plugin pane open`: a tab of its own, or a split of the pane it targets.
    const target = flag("--target-pane");
    const tabId = flag("--placement") === "split" && target ? tabOf(target) : newTab("plugin").tab_id;
    result = {
      type: "plugin_pane_opened",
      plugin_pane: { entrypoint: flag("--entrypoint") ?? "", pane: newPane(tabId) },
    };
    break;
  }
  case "agent start":
    state.agents.push({ name: argv[2]!, pane_id: flag("--pane") ?? "" });
    result = { type: "agent_started" };
    break;
  case "agent list": {
    const gone = new Set((process.env.FAKE_HERDR_AGENTS_GONE ?? "").split(",").filter((n) => n));
    result = {
      type: "agent_list",
      agents: state.agents
        .filter((a) => !gone.has(a.name))
        .map((a) => ({ ...a, agent_status: process.env.FAKE_HERDR_AGENT_STATUS ?? "idle" })),
    };
    break;
  }
  case "agent get": {
    let status = process.env.FAKE_HERDR_AGENT_STATUS ?? "idle";
    if (state.blocked > 0 && state.blocked <= blockFor) {
      status = "blocked";
      state.blocked += 1;
    }
    result = { type: "agent", agent: { agent_status: status } };
    break;
  }
  default:
    result = { type: "ok" };
}

saveState(state);
process.stdout.write(`${JSON.stringify({ id: "fake", result })}\n`);

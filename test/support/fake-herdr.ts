#!/usr/bin/env bun
// Fake `herdr` CLI. Records every invocation and answers with canned ids so a
// whole run can be driven without a herdr server. See test/support/recorder.ts.

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

const log = process.env.FAKE_HERDR_LOG!;
const statePath = `${log}.state.json`;
const argv = process.argv.slice(2);

interface State {
  tabs: number;
  panes: number;
  outputs: number;
}

function loadState(): State {
  if (!existsSync(statePath)) return { tabs: 0, panes: 0, outputs: 0 };
  return JSON.parse(readFileSync(statePath, "utf8")) as State;
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

// Whatever a step asks its agent to write, the fake writes for it: the queue in
// FAKE_HERDR_OUTPUTS stands in for real agent work.
if (cmd === "agent prompt") {
  const text = argv[3] ?? "";
  const match = /^OUTPUT_PATH: (.+)$/m.exec(text);
  const queuePath = process.env.FAKE_HERDR_OUTPUTS;
  if (match && queuePath && existsSync(queuePath)) {
    const queue = JSON.parse(readFileSync(queuePath, "utf8")) as unknown[];
    const next = queue[state.outputs];
    state.outputs += 1;
    if (next !== undefined && next !== null) {
      const path = match[1]!.trim();
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, typeof next === "string" ? next : JSON.stringify(next, null, 2));
    }
  }
}

let result: unknown = {};
switch (cmd) {
  case "tab create": {
    state.tabs += 1;
    result = {
      type: "tab_created",
      tab: { tab_id: `1:${state.tabs}` },
      root_pane: { pane_id: `1-${(state.panes += 1)}` },
    };
    break;
  }
  case "pane split": {
    result = { type: "pane_split", pane: { pane_id: `1-${(state.panes += 1)}` } };
    break;
  }
  case "agent start":
    result = { type: "agent_started" };
    break;
  case "agent read":
    saveState(state);
    process.stdout.write(process.env.FAKE_HERDR_AGENT_TEXT ?? "");
    process.exit(0);
  default:
    result = { type: "ok" };
}

saveState(state);
process.stdout.write(`${JSON.stringify({ id: "fake", result })}\n`);

#!/usr/bin/env bun
// Whether several Claude agents started at once each take their first prompt, against a
// real herdr and a real Claude. A fake herdr cannot answer this: the race is herdr calling
// an agent ready for input before Claude has drawn the prompt the pointer is typed into.
//
//   herdr --session <scratch> server &
//   env -u HERDR_ENV -u HERDR_PANE_ID HERDR_SOCKET_PATH=~/.config/herdr/sessions/<scratch>/herdr.sock \
//     bun run tools/prompt-race-live.ts [--agents 4] [--keep]
//   herdr session stop <scratch> && herdr session delete <scratch>
//
// One trial at a time, at most four agents, and the scratch session stopped after each:
// every probe is a whole Claude with its MCP servers.
//
// It refuses any socket but a named session's, and keeps its state under `.scratch/` in
// the checkout it runs from, never in the state directory your Runs are in. It launches
// through the Agents layer a host uses — controls installed, the harness's ready sign
// awaited, the prompt sent and confirmed — so what it proves is the shipped path. It costs
// one short Haiku turn per agent.

import { BunServices } from "@effect/platform-bun";
import { Clock, Effect, FileSystem, ManagedRuntime } from "effect";
import { Agents, agentsLayer, type AgentAsk } from "../src/agents";
import { controlDir } from "../src/compaction";
import { readEnv } from "../src/env";
import { Herdr } from "../src/herdr";
import { deliveriesOf } from "../src/steering";

// The controls a launch installs call back as `<bun> <this script> herdr compaction`, and
// this script is not Collie's CLI.
Bun.argv[1] = new URL("../src/main.ts", import.meta.url).pathname;

const runtime = ManagedRuntime.make(BunServices.layer);

const flag = (name: string) => process.argv.indexOf(name);
/** More than this at once took the machine down: every probe carries its own MCP servers. */
const MAX_AGENTS = 4;
const count = Math.min(
  MAX_AGENTS,
  flag("--agents") === -1 ? MAX_AGENTS : Number(process.argv[flag("--agents") + 1]),
);
const keep = flag("--keep") !== -1;

const live = Effect.fn("live.promptRace")(function* (
  processEnv: Readonly<Record<string, string | undefined>>,
) {
  const stamp = (yield* Clock.currentTimeMillis).toString(36);
  // A probe runs inside a herdr pane; this must never be started from one, or a probe's
  // own status line could start it again.
  if (processEnv.HERDR_ENV !== undefined || processEnv.HERDR_PANE_ID !== undefined) {
    return yield* Effect.fail(
      new Error("run this from outside herdr: unset HERDR_ENV and HERDR_PANE_ID"),
    );
  }
  const socket = processEnv.HERDR_SOCKET_PATH ?? "";
  if (!socket.includes("/sessions/")) {
    return yield* Effect.fail(
      new Error(`HERDR_SOCKET_PATH must be a scratch session's socket, not "${socket}"`),
    );
  }
  const fs = yield* FileSystem.FileSystem;
  const cwd = process.cwd();
  const stateDir = `${cwd}/.scratch/prompt-race-${stamp}`;
  yield* fs.makeDirectory(stateDir, { recursive: true });
  const env = readEnv({ ...processEnv, HERDR_PLUGIN_STATE_DIR: stateDir });
  const herdr = new Herdr(env);
  const workspace = yield* herdr.workspaceCreate({ cwd, label: `prompt-race-${stamp}` });
  const dir = `${stateDir}/host`;
  const runId = `race-${stamp}`;

  const asks: AgentAsk[] = Array.from({ length: count }, (_, i) => {
    const output = `${dir}/agents/${runId}/probe-${i}.json`;
    return {
      runId,
      operation: `probe-${i}`,
      role: "implementer",
      agent: null,
      workflow: "prompt-race",
      task: null,
      workspace: workspace.workspaceId,
      cwd,
      output,
      prompt: `Write exactly {"took":${i}} to the file below and do nothing else.\nOUTPUT_PATH: ${output}`,
      skill: null,
      harness: "claude",
      model: "haiku",
      effort: null,
      permissions: null,
    };
  });

  const closeProbes = Effect.gen(function* () {
    for (const pane of yield* herdr.paneList().pipe(Effect.orElseSucceed(() => []))) {
      if (pane.workspaceId === workspace.workspaceId)
        yield* herdr.tabClose(pane.tabId).pipe(Effect.ignore);
    }
  });

  const rows = yield* Effect.forEach(
    asks,
    (ask) =>
      Agents.use((agents) =>
        agents.launch(ask).pipe(
          Effect.flatMap((launched) => agents.collect(launched)),
          Effect.map((written) => ({ operation: ask.operation, written, error: null })),
          Effect.catch((cause) =>
            Effect.succeed({ operation: ask.operation, written: null, error: String(cause) }),
          ),
        ),
      ),
    { concurrency: "unbounded" },
  ).pipe(
    Effect.ensuring(keep ? Effect.void : closeProbes),
    Effect.provide(
      agentsLayer({
        dir,
        env,
        herdr,
        harness: "claude",
        model: "haiku",
        permissions: "bypass",
        compactAtTokens: 150_000,
        pollMs: 1_000,
        collectMs: 5 * 60_000,
      }),
    ),
  );

  const deliveries = yield* deliveriesOf(stateDir, runId);
  const lines = [`| agent | took its first prompt | delivery | ledger | hook recorded it |`];
  lines.push(`|---|---|---|---|---|`);
  let took = 0;
  for (const row of rows) {
    const step = deliveries.find(
      (one) => one.delivery.cause.kind === "step" && one.delivery.cause.ref === row.operation,
    )?.delivery;
    const agent = step?.agent ?? row.operation;
    const events = yield* fs
      .readFileString(`${yield* controlDir(stateDir, agent)}/events.jsonl`)
      .pipe(Effect.orElseSucceed(() => ""));
    const hooked = step !== undefined && events.includes(`"delivery":"${step.id}"`);
    const ok = row.written?.includes(`"took":${row.operation.slice("probe-".length)}`) === true;
    if (ok) took += 1;
    lines.push(
      `| ${agent} | ${ok ? "yes" : `no${row.error ? ` (${row.error})` : ""}`} | ${step?.id ?? "-"} | ${step ? `${step.state}${step.note ? ` (${step.note})` : ""}` : "-"} | ${hooked ? "yes" : "no"} |`,
    );
  }
  lines.push(`\n${took} of ${count} agents took their first prompt. State: ${stateDir}`);

  return { report: lines.join("\n"), passed: took === count };
});

const { report, passed } = await runtime.runPromise(live(process.env));
await runtime.runPromise(Effect.log(report));
process.exitCode = passed ? 0 : 1;

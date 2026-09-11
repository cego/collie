#!/usr/bin/env bun
// What one harness actually does about a delivery, against a running herdr. Nothing in
// `src/steering-caps.ts` may say `proven` without a pass recorded here: help text is a
// claim, a version number is a claim, and neither is a result.
//
//   bun run tools/steering-live.ts <harness> --agent <name> [--keep]
//
// The agent is one you already have live in herdr, on that harness, with something slow
// to do — start it the way you normally would. This asks the three questions the
// capability table has rows for and prints them as markdown to paste into
// `CAPABILITIES.md`. Attribution is the one that needs you: it asks you to type a line
// into that pane and waits.

import { BunServices } from "@effect/platform-bun";
import { Clock, Effect, FileSystem, ManagedRuntime, Path } from "effect";
import { currentEnv } from "../src/env";
import { Herdr } from "../src/herdr";
import { installedVersion } from "../src/compactors";
import { ackPath, entryFromLive, transaction, INTERRUPT_WAIT_MS } from "../src/dispatcher";
import { ledgerPath, overrideActive, readLedger } from "../src/steering";
import { nowIso } from "../src/time";

const runtime = ManagedRuntime.make(BunServices.layer);

type Result = "pass" | "fail" | "not-run";
interface Row {
  readonly capability: string;
  readonly result: Result;
  readonly note: string;
}

const CAPABILITIES = ["now", "interrupt", "ack", "attribution"] as const;

function allNotRun(note: string): Row[] {
  return CAPABILITIES.map((capability) => ({ capability, result: "not-run" as const, note }));
}

/** What a delivery asks for in this experiment: the token, and the ack, and nothing else. */
function askFor(runDir: string, id: string): string {
  return [
    `collie-delivery:${id}`,
    "Stop what you are doing and do this instead:",
    `write \`${ackPath(runDir, id)}\` containing`,
    `{"delivery":"${id}","intent_version":1,"attempt":1,"understood":"<one sentence>"}`,
    "and then wait.",
  ].join("\n");
}

const live = Effect.fn("live.run")(function* (harness: string, agent: string, keep: boolean) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const env = yield* currentEnv;
  const herdr = new Herdr(env);

  const version = yield* installedVersion(harness);
  if (version === null)
    return { version: "not installed", rows: allNotRun(`${harness} is not on PATH`) };

  const scratch = yield* fs.makeTempDirectory({ prefix: `collie-live-${harness}-` });
  const runDir = path.join(scratch, "run");
  yield* fs.makeDirectory(path.join(runDir, "steering", "acks"), { recursive: true });

  const deps = {
    stateDir: env.stateDir,
    herdr,
    log: (line: string) => Effect.log(line).pipe(Effect.ignore),
  };
  const addressed = yield* entryFromLive(deps, {
    role: "live",
    agent,
    paneId: null,
    workspaceId: env.workspaceId,
    runId: "live",
    workflow: "live",
  });
  const entry = addressed.entry;
  if (entry === null) return { version, rows: allNotRun(addressed.reason) };
  const ledger = yield* ledgerPath(env.stateDir, entry.incarnation?.terminalId ?? "");

  /** Whether the agent wrote the ack for this delivery within the budget. */
  const acked = Effect.fn("live.acked")(function* (id: string, budgetMs: number) {
    const deadline = (yield* Clock.currentTimeMillis) + budgetMs;
    while ((yield* Clock.currentTimeMillis) < deadline) {
      if (yield* fs.exists(ackPath(runDir, id))) return true;
      yield* Effect.sleep(2_000);
    }
    return false;
  });

  const deliver = Effect.fn("live.deliver")(function* (id: string, ref: string) {
    return yield* transaction(deps, entry, (channel) =>
      channel.submit(askFor(runDir, id), {
        run: "live",
        harness,
        cause: { kind: "steer", ref },
        mode: "boundary",
        intentVersion: 1,
        attempt: 1,
        requestId: id,
      }),
    ).pipe(Effect.catch(() => Effect.succeed({ ok: false as const })));
  });

  const rows: Row[] = [];

  // (a) `now` and (b) the ack it asks for: one delivery answers both rows.
  const nowId = "live-now-1";
  const sent = yield* deliver(nowId, "now");
  const nowAcked = sent.ok ? yield* acked(nowId, 120_000) : false;
  rows.push({
    capability: "now",
    result: sent.ok && nowAcked ? "pass" : "fail",
    note: sent.ok
      ? nowAcked
        ? "acknowledged within 120s"
        : "no ack within 120s"
      : "the delivery was not sent",
  });
  rows.push({
    capability: "ack",
    result: nowAcked ? "pass" : "fail",
    note: nowAcked ? `wrote ${ackPath(runDir, nowId)}` : "no ack file appeared",
  });

  // (c) `interrupt`: keys first, then the message. Leaving `working` is what can be
  // observed; it is not a claim that the harness stopped.
  const before = yield* herdr
    .agentStatus(agent)
    .pipe(Effect.catch(() => Effect.succeed("unknown" as const)));
  yield* herdr.agentSendKeys(agent, ["Escape"]).pipe(Effect.catch(() => Effect.void));
  const moved = yield* leftWorking(herdr, agent, INTERRUPT_WAIT_MS);
  const interruptId = "live-interrupt-1";
  const interruptSent = yield* deliver(interruptId, "interrupt");
  const interruptAcked = interruptSent.ok ? yield* acked(interruptId, 120_000) : false;
  rows.push({
    capability: "interrupt",
    result: moved && interruptAcked ? "pass" : "fail",
    note: `was ${before}; left working within ${INTERRUPT_WAIT_MS}ms: ${moved}; acknowledged: ${interruptAcked}`,
  });

  // (d) attribution: only Claude installs a hook that can see a submission at all.
  if (harness !== "claude") {
    rows.push({
      capability: "attribution",
      result: "not-run",
      note: "no hook surface Collie can install on this harness",
    });
  } else {
    yield* Effect.log(`Type any line into ${agent}'s pane now, then Enter. Waiting 90 seconds.`);
    yield* Effect.sleep(90_000);
    const flagged = overrideActive(yield* readLedger(ledger));
    rows.push({
      capability: "attribution",
      result: flagged ? "pass" : "fail",
      note: flagged ? "manual_override recorded" : "no manual_override recorded",
    });
  }

  if (!keep) yield* fs.remove(scratch, { recursive: true, force: true });
  return { version, rows };
});

const leftWorking = Effect.fn("live.leftWorking")(function* (
  herdr: Herdr,
  agent: string,
  budgetMs: number,
) {
  const deadline = (yield* Clock.currentTimeMillis) + budgetMs;
  while ((yield* Clock.currentTimeMillis) < deadline) {
    const status = yield* herdr
      .agentStatus(agent)
      .pipe(Effect.catch(() => Effect.succeed("unknown" as const)));
    if (status !== "working") return true;
    yield* Effect.sleep(250);
  }
  return false;
});

const report = Effect.fn("live.report")(function* (harness: string) {
  const agentAt = Bun.argv.indexOf("--agent");
  const agent = agentAt > 0 ? Bun.argv[agentAt + 1] : undefined;
  if (!agent) {
    yield* Effect.logError("usage: bun run tools/steering-live.ts <harness> --agent <name>");
    return 2;
  }
  const { version, rows } = yield* live(harness, agent, Bun.argv.includes("--keep"));
  const lines = [
    "",
    `### ${harness} ${version} — ${(yield* nowIso()).slice(0, 10)}`,
    "",
    "| capability | result | note |",
    "|---|---|---|",
    ...rows.map((row) => `| ${row.capability} | ${row.result} | ${row.note} |`),
    "",
    "Paste these rows into the Run's CAPABILITIES.md, and flip the table in",
    "src/steering-caps.ts only for the ones that say pass.",
  ];
  yield* Effect.log(lines.join("\n"));
  return 0;
});

const harness = Bun.argv[2];
process.exitCode = harness
  ? await runtime.runPromise(report(harness).pipe(Effect.orDie))
  : await runtime.runPromise(
      Effect.logError("usage: bun run tools/steering-live.ts <harness> --agent <name>").pipe(
        Effect.as(2),
      ),
    );

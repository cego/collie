#!/usr/bin/env bun

import * as Arr from "effect/Array";
import * as Str from "effect/String";
import { pipe as pipe_ } from "effect/Function";
import { platformLayer } from "../src/platform";
import { Clock, Effect, FileSystem, Layer, ManagedRuntime, Path } from "effect";
import { currentEnv } from "../src/env";
import { Herdr } from "../src/herdr";
import { externalSubmissions, installedVersion, submittedDelivery } from "../src/compactors";
import { controlDir } from "../src/compaction";
import { entryFromLive, transaction, INTERRUPT_WAIT_MS } from "../src/dispatcher";
import { nowIso } from "../src/time";
import { recordsAt } from "../src/records";

const runtime = ManagedRuntime.make(platformLayer);
const ackPath = (dir: string, id: string) => `${dir}/steering/acks/${id}.txt`;

type Result = "pass" | "fail" | "not-run";
interface Row {
  readonly capability: string;
  readonly result: Result;
  readonly note: string;
}

const CAPABILITIES = ["now", "interrupt", "ack", "attribution"] as const;

function allNotRun(note: string) {
  return Arr.map(CAPABILITIES, (capability) => ({ capability, result: "not-run" as const, note }));
}

function askFor(runDir: string, id: string) {
  return Arr.join(
    [
      `collie-delivery:${id}`,
      "Stop what you are doing and do this instead:",
      `write \`${ackPath(runDir, id)}\` containing`,
      `{"delivery":"${id}","intent_version":1,"attempt":1,"understood":"<one sentence>"}`,
      "and then wait.",
    ],
    "\n",
  );
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
  if (!keep)
    yield* Effect.addFinalizer(() =>
      fs.remove(scratch, { recursive: true, force: true }).pipe(Effect.ignore),
    );
  const runDir = path.join(scratch, "run");
  // WARNING: the probe's ledger is its own, never the host's that this herdr serves.
  const records = yield* Layer.build(recordsAt(scratch));
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
    workspaceId: null,
    runId: "live",
    workflow: "live",
  });
  const entry = addressed.entry;
  if (entry === null) return { version, rows: allNotRun(addressed.reason) };
  const hookDir = yield* controlDir(env.stateDir, agent);

  const acked = Effect.fn("live.acked")(function* (id: string, budgetMs: number) {
    const deadline = (yield* Clock.currentTimeMillis) + budgetMs;
    while ((yield* Clock.currentTimeMillis) < deadline) {
      if (yield* fs.exists(ackPath(runDir, id))) return true;
      yield* Effect.sleep(2000);
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
    ).pipe(
      Effect.orElseSucceed(() => ({
        ok: false as const,
      })),
      Effect.provideContext(records),
    );
  });

  const rows: Row[] = [];

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

  // WARNING: leaving working is what can be observed; it is not a claim that the harness stopped.
  const before = yield* herdr
    .agentStatus(agent)
    .pipe(Effect.orElseSucceed(() => "unknown" as const));
  yield* herdr.agentSendKeys(agent, ["Escape"]).pipe(Effect.ignore);
  const moved = yield* leftWorking(herdr, agent, INTERRUPT_WAIT_MS);
  const interruptId = "live-interrupt-1";
  const interruptSent = yield* deliver(interruptId, "interrupt");
  const interruptAcked = interruptSent.ok ? yield* acked(interruptId, 120_000) : false;
  rows.push({
    capability: "interrupt",
    result: moved && interruptAcked ? "pass" : "fail",
    note: `was ${before}; left working within ${INTERRUPT_WAIT_MS}ms: ${moved}; acknowledged: ${interruptAcked}`,
  });

  // WARNING: only Claude installs a hook that can see a submission at all.
  if (harness !== "claude") {
    rows.push({
      capability: "attribution",
      result: "not-run",
      note: "no hook surface Collie can install on this harness",
    });
  } else {
    // WARNING: only a live Run's oversight writes manual_override; read the hook's record, not the ledger.
    const deliveredAsCollie = yield* submittedDelivery(hookDir, nowId);
    const before = yield* externalSubmissions(hookDir);
    yield* Effect.log(`Type any line into ${agent}'s pane now, then Enter. Waiting 90 seconds.`);
    yield* Effect.sleep(90_000);
    const typed = (yield* externalSubmissions(hookDir)) - before;
    rows.push({
      capability: "attribution",
      result: deliveredAsCollie && typed === 1 ? "pass" : "fail",
      note: `${nowId} recorded as collie: ${deliveredAsCollie}; external submissions while typing: ${typed}`,
    });
  }

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
      .pipe(Effect.orElseSucceed(() => "unknown" as const));
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
    `### ${harness} ${version} — ${pipe_(yield* nowIso, Str.slice(0, 10))}`,
    "",
    "| capability | result | note |",
    "|---|---|---|",
    ...Arr.map(rows, (row) => `| ${row.capability} | ${row.result} | ${row.note} |`),
    "",
    "Paste these rows into the Run's CAPABILITIES.md, and flip the table in",
    "src/steering-caps.ts only for the ones that say pass.",
  ];
  yield* Effect.log(Arr.join(lines, "\n"));
  return 0;
});

const harness = Bun.argv[2];
process.exitCode = harness
  ? await runtime.runPromise(report(harness).pipe(Effect.scoped, Effect.orDie))
  : await runtime.runPromise(
      Effect.logError("usage: bun run tools/steering-live.ts <harness> --agent <name>").pipe(
        Effect.as(2),
      ),
    );

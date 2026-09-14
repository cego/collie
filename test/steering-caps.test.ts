// A capability is a recorded live result, not a reading of documentation, so the thing
// tested here is what happens when there is no result: the gate refuses, and the refusal
// is written down where a human looking for their steer will find it.

import { Effect, FileSystem, Path } from "effect";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { CAPABILITIES, gate, interruptKeys, needed } from "../src/steering-caps";
import { DELIVERY_TOKEN, ackInstruction, ackPath, readAcks, transaction } from "../src/dispatcher";
import { appendLine, ledgerPath, readLedger, type Delivery } from "../src/steering";
import type { AgentEntry } from "../src/registry";
import type { AgentInfo } from "../src/herdr";
import { runEffect } from "./support/effect";

let stateDir: string;
let runDir: string;

beforeEach(() =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      stateDir = yield* fs.makeTempDirectory({ prefix: "hw-caps-" });
      runDir = yield* fs.makeTempDirectory({ prefix: "hw-caps-run-" });
    }),
  ),
);

afterEach(() =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      yield* fs.remove(stateDir, { recursive: true, force: true });
      yield* fs.remove(runDir, { recursive: true, force: true });
    }),
  ),
);

const entry: AgentEntry = {
  role: "implementer",
  agent: "impl-1",
  paneId: "1-9",
  workspaceId: "w1",
  runId: "r1",
  workflow: "implement",
  at: "2026-09-09T09:00:00Z",
  incarnation: { terminalId: "term-1", agentSession: null },
};

const alive: AgentInfo = {
  name: "impl-1",
  paneId: "1-9",
  workspaceId: "w1",
  status: "idle",
  title: null,
  terminalId: "term-1",
  agentSession: null,
};

function fake() {
  const calls: string[] = [];
  return {
    calls,
    deps: {
      stateDir,
      herdr: {
        restoreAgentName: () => Effect.succeed(false),
        agentList: () => Effect.succeed([alive]),
        agentPrompt: (target: string) =>
          Effect.sync(() => {
            calls.push(`agentPrompt ${target}`);
            return "observed" as const;
          }),
        agentSendKeys: (target: string, keys: ReadonlyArray<string>) =>
          Effect.sync(() => {
            calls.push(`agentSendKeys ${target} ${keys.join("+")}`);
          }),
      },
      log: () => Effect.void,
    },
  };
}

const delivery = (over: Partial<Delivery> = {}): Delivery => ({
  id: "d1",
  at: "2026-09-09T10:00:00Z",
  run: "r1",
  incarnation: "term-1",
  agent: "impl-1",
  causal_key: "k1",
  request_id: "req-1",
  cause: { kind: "steer", ref: "s1" },
  mode: "boundary",
  text_hash: "h",
  intent_version: 2,
  attempt: 1,
  state: "submitted",
  ...over,
});

test("proven is a recorded date, attribution and the other harnesses are not, and a boundary needs nothing proven", () =>
  runEffect(
    Effect.gen(function* () {
      for (const [harness, row] of Object.entries(CAPABILITIES))
        for (const [capability, record] of Object.entries(row)) {
          // A capability moves to `proven` only with the day it was recorded.
          if (record.status === "proven") expect(record.tested_at).not.toBeNull();
          else expect(record.tested_at).toBeNull();
          // Attribution needs a human at a Collie-launched agent's pane: nothing an agent
          // pressing keys can record, so no build claims it.
          if (capability === "attribution") expect(record.status).toBe("unproven");
        }
      // The live rows from 2026-09-11, kept with their evidence in CAPABILITIES.md: Claude
      // took a delivery while working and acknowledged it, and both Claude and pi left
      // `working` on Escape and acknowledged what followed. Nothing else has a pass.
      const proven = Object.entries(CAPABILITIES).flatMap(([harness, row]) =>
        Object.entries(row).flatMap(([capability, record]) =>
          record.status === "proven" ? [`${harness}.${capability}`] : [],
        ),
      );
      expect(proven.sort()).toEqual([
        "claude.ack",
        "claude.interrupt",
        "claude.now",
        "pi.interrupt",
      ]);

      expect(needed("boundary")).toBeNull();
      // A boundary delivery is the next prompt file, which every harness already takes.
      expect(yield* gate("claude", "boundary").pipe(Effect.exit)).toMatchObject({
        _tag: "Success",
      });
    }),
  ));

test("an untested mode is refused, and an unknown harness is refused the same way", () =>
  runEffect(
    Effect.gen(function* () {
      expect(yield* gate("codex", "now").pipe(Effect.flip)).toMatchObject({
        reason: "capability_unproven:codex:now",
      });
      expect(yield* gate("nothing-like-this", "interrupt").pipe(Effect.flip)).toMatchObject({
        reason: "capability_unproven:nothing-like-this:interrupt",
      });
    }),
  ));

test("a refused mode is written down, and nothing reaches the agent", () =>
  runEffect(
    Effect.gen(function* () {
      const h = fake();
      const outcome = yield* transaction(h.deps, entry, (channel) =>
        channel.submit("stop and look at this", {
          run: "r1",
          harness: "codex",
          cause: { kind: "steer", ref: "s1" },
          mode: "now",
          intentVersion: 1,
          attempt: 1,
          requestId: "req-1",
        }),
      );

      expect(outcome).toMatchObject({ ok: false, reason: "failed" });
      expect(h.calls).toEqual([]);
      const lines = yield* readLedger(yield* ledgerPath(stateDir, "term-1"));
      expect(lines).toHaveLength(1);
      expect(lines[0]).toMatchObject({
        state: "failed",
        note: "capability_unproven:codex:now",
      });
    }),
  ));

test("an interrupt is a key and a message, and is never called stopping", () =>
  runEffect(
    Effect.gen(function* () {
      expect(interruptKeys("claude")).toEqual(["Escape"]);
      expect(interruptKeys("nothing-like-this")).toBeNull();

      // What an interrupt can say is what was observed: keys were sent, and later the
      // agent acknowledged. herdr has no way to show a harness has actually stopped, so
      // neither of these files may claim one has.
      const fs = yield* FileSystem.FileSystem;
      for (const name of ["dispatcher.ts", "steering-caps.ts"]) {
        const source = new URL(`../src/${name}`, import.meta.url).pathname;
        const text = yield* fs.readFileString(source);
        expect([name, text.includes(`"stopped"`)]).toEqual([name, false]);
      }
    }),
  ));

test("the ack instruction carries the token a hook can see, and the file it asks for", () => {
  const instruction = ackInstruction("/runs/r1", { id: "d1", intentVersion: 2, attempt: 3 });
  expect(instruction.split("\n")[0]).toBe(`${DELIVERY_TOKEN}d1`);
  expect(instruction).toContain(ackPath("/runs/r1", "d1"));
  expect(instruction).toContain(`"intent_version":2`);
  expect(instruction).toContain(`"attempt":3`);
});

test("an ack for what was sent is acknowledgement; one for something else is a mismatch", () =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const ledger = yield* ledgerPath(stateDir, "term-1");
      yield* appendLine(ledger, delivery());
      const acks = path.join(runDir, "steering", "acks");
      yield* fs.makeDirectory(acks, { recursive: true });

      // The wrong attempt: the agent is answering a message that is not this one.
      yield* fs.writeFileString(
        path.join(acks, "d1.json"),
        `{"delivery":"d1","intent_version":2,"attempt":9,"understood":"stay in src"}`,
      );
      yield* readAcks(stateDir, runDir, () => Effect.void);
      expect((yield* readLedger(ledger)).at(-1)).toMatchObject({
        state: "submitted",
        note: "ack_mismatch",
      });

      yield* fs.writeFileString(
        path.join(acks, "d1.json"),
        `{"delivery":"d1","intent_version":2,"attempt":1,"understood":"stay in src"}`,
      );
      yield* readAcks(stateDir, runDir, () => Effect.void);
      expect((yield* readLedger(ledger)).at(-1)).toMatchObject({
        state: "acknowledged",
        evidence: { kind: "ack" },
      });
      // Removed only once its line is written, so a crash in between re-reads it.
      expect(yield* fs.exists(path.join(acks, "d1.json"))).toBe(false);
    }),
  ));

test("an ack nobody can decode is reported, not acted on", () =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const acks = path.join(runDir, "steering", "acks");
      yield* fs.makeDirectory(acks, { recursive: true });
      yield* fs.writeFileString(path.join(acks, "d9.json"), "not json at all");

      const said: string[] = [];
      yield* readAcks(stateDir, runDir, (line) =>
        Effect.sync(() => {
          said.push(line);
        }),
      );
      expect(said).toEqual(["ack d9.json could not be read"]);
    }),
  ));

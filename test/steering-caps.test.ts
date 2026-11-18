import * as Arr from "effect/Array";
import * as Rec from "effect/Record";
import * as Str from "effect/String";
import { pipe as pipe_ } from "effect/Function";
import { Effect, FileSystem } from "effect";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { CAPABILITIES, gate, interruptKeys, needed } from "../src/steering-caps";
import { transaction } from "../src/dispatcher";
import { readLedger } from "../src/steering";
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
  incarnation: { terminalId: "term-1", agentSession: null, backend: "core" },
};

const alive: AgentInfo = {
  name: "impl-1",
  paneId: "1-9",
  status: "idle",
  terminalId: "term-1",
  cwd: "/project",
  foregroundCwd: null,
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
            calls.push(`agentSendKeys ${target} ${Arr.join(keys, "+")}`);
          }),
      },
      log: () => Effect.void,
    },
  };
}

test("proven is a recorded date, attribution and the other harnesses are not, and a boundary needs nothing proven", () =>
  runEffect(
    Effect.gen(function* () {
      for (const row of Rec.values(CAPABILITIES))
        for (const [capability, record] of Rec.toEntries(row)) {
          if (record.status === "proven") expect(record.tested_at).not.toBeNull();
          else expect(record.tested_at).toBeNull();
          if (capability === "attribution") expect(record.status).toBe("unproven");
        }
      const proven = Arr.flatMap(Rec.toEntries(CAPABILITIES), ([harness, row]) =>
        Arr.flatMap(Rec.toEntries(row), ([capability, record]) =>
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
      const lines = yield* readLedger("term-1");
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

      const fs = yield* FileSystem.FileSystem;
      for (const name of ["dispatcher.ts", "steering-caps.ts"]) {
        const source = new URL(`../src/${name}`, import.meta.url).pathname;
        const text = yield* fs.readFileString(source);
        expect([name, pipe_(text, Str.includes(`"stopped"`))]).toEqual([name, false]);
      }
    }),
  ));

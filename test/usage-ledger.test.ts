// The usage ledger, fed each harness's own record of a session. Every figure asserted
// here was counted by hand from the fixture, never by the reader's own arithmetic.

import * as Arr from "effect/Array";
import * as Str from "effect/String";
import { expect, test } from "bun:test";
import { Effect, FileSystem } from "effect";
import { runEffect } from "./support/effect";
import { fakeChannel } from "./support/compaction";
import { readMetrics } from "../src/metrics";
import { recordFrom } from "../src/usage-ledger";
import { usageOf, type Source } from "../src/usage-ledger-model";
import { COMPACTION_PORTS, writeEvent } from "../src/compactors";
import { opencodeUsage } from "../src/harness";
import type { JsonObject } from "../src/schema";

const FIXTURES = new URL("./fixtures/usage-ledger/", import.meta.url).pathname;

const at = (file: string, parent: string | null = null): Source => ({
  path: `${FIXTURES}${file}`,
  format: Str.startsWith("codex")(file)
    ? "codex"
    : Str.startsWith("pi")(file)
      ? "pi"
      : Str.startsWith("opencode")(file)
        ? "opencode"
        : "claude",
  parent,
});

/** The Run's usage once one agent's sources are recorded, as `run metrics` reads it. */
const recorded = (harness: string, sources: ReadonlyArray<Source>, heal = false) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const root = yield* fs.makeTempDirectoryScoped();
    yield* recordFrom(
      { dir: root },
      { run: "r1", agent: "build", heal },
      { harness, cwd: root, dir: `${root}/controls` },
      sources,
    );
    return usageOf(yield* readMetrics(`${root}/evidence/r1`));
  });

test("Claude's transcript: a streamed request counts once at its largest, and a resumed session adds only what is new", () =>
  runEffect(
    Effect.gen(function* () {
      const usage = yield* recorded("claude", [at("claude.jsonl"), at("claude-resumed.jsonl")]);
      expect(usage.totals).toEqual({
        requests: 3,
        input: 6,
        cacheRead: 2200,
        cacheCreation: 1250,
        output: 150,
        reasoning: 15,
      });
    }),
  ));

test("Codex's events: cached input is not uncached input, and a replayed request counts once", () =>
  runEffect(
    Effect.gen(function* () {
      const usage = yield* recorded("codex", [at("codex.jsonl")]);
      expect(usage.totals).toEqual({
        requests: 3,
        input: 750,
        cacheRead: 3600,
        cacheCreation: 150,
        output: 600,
        reasoning: 170,
      });
    }),
  ));

test("Pi's session: a repeated entry and a resumed session's copy count once", () =>
  runEffect(
    Effect.gen(function* () {
      const usage = yield* recorded("pi", [at("pi.jsonl")]);
      expect(usage.totals).toEqual({
        requests: 3,
        input: 115,
        cacheRead: 1240,
        cacheCreation: 550,
        output: 65,
        reasoning: 8,
      });
    }),
  ));

test("OpenCode's reporter: a message updated as it streams counts once, with reasoning inside output", () =>
  runEffect(
    Effect.gen(function* () {
      const usage = yield* recorded("opencode", [at("opencode.jsonl")]);
      expect(usage.totals).toEqual({
        requests: 3,
        input: 225,
        cacheRead: 2100,
        cacheCreation: 900,
        output: 124,
        reasoning: 14,
      });
    }),
  ));

test("a harness that reports no cache creation has it unavailable, and its reasoning stays inside output", () =>
  runEffect(
    Effect.gen(function* () {
      const usage = yield* recorded("codex", [at("codex-no-cache-write.jsonl")]);
      expect(usage.totals).toEqual({
        requests: 1,
        input: 400,
        cacheRead: 100,
        cacheCreation: null,
        output: 300,
        reasoning: 200,
      });
      expect(usage.sessions[0]?.cacheCreation).toBeNull();
    }),
  ));

test("Claude's sub-agents are read beside their parent, keyed to it, and counted in the Run", () =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped();
      const controls = `${root}/controls`;
      yield* writeEvent(controls, {
        session: "par",
        kind: "usage",
        tokens: 110,
        transcript: `${FIXTURES}claude-parent.jsonl`,
      });
      const sources = yield* COMPACTION_PORTS.claude!.records!({
        agent: "build",
        run: "r1",
        harness: "claude",
        cwd: root,
        dir: controls,
        endpoint: null,
        channel: fakeChannel([]),
      });
      yield* recordFrom(
        { dir: root },
        { run: "r1", agent: "build" },
        { harness: "claude", cwd: root, dir: controls },
        sources,
      );
      const usage = usageOf(yield* readMetrics(`${root}/evidence/r1`));
      expect(usage.totals).toEqual({
        requests: 4,
        input: 23,
        cacheRead: 50,
        cacheCreation: 220,
        output: 49,
        reasoning: null,
      });
      expect(Arr.map(usage.sessions, (one) => [one.session, one.requests])).toEqual([["par", 1]]);
      expect(
        Arr.map(usage.sessions[0]!.subagents, (one) => [one.session, one.requests, one.output]),
      ).toEqual([
        ["a1", 2, 15],
        ["a2", 1, 14],
      ]);
    }),
  ));

test("a session's start, peak, compactions, tool payload and retries are its own figures", () =>
  runEffect(
    Effect.gen(function* () {
      const usage = yield* recorded("claude", [at("claude-session.jsonl")]);
      const [session] = usage.sessions;
      expect(session).toMatchObject({
        agent: "build",
        session: "s1",
        initialContext: 9004,
        peakContext: 10001,
        compactions: 2,
        toolResultChars: 150,
        reminders: 1,
        repairs: 1,
        recovery: false,
      });
      expect(usage.recovery.requests).toBe(0);
    }),
  ));

test("a Heal's session is recovery, and its tokens are the Run's recovery cost", () =>
  runEffect(
    Effect.gen(function* () {
      const usage = yield* recorded("claude", [at("claude-heal.jsonl")], true);
      expect(usage.sessions[0]?.recovery).toBe(true);
      expect(usage.recovery).toEqual({
        requests: 2,
        input: 9,
        cacheRead: 5000,
        cacheCreation: 5400,
        output: 390,
        reasoning: null,
      });
    }),
  ));

interface UsagePlugin {
  readonly CollieUsage: () => Promise<{
    event: (input: { event: { type: string; properties: JsonObject } }) => Promise<void>;
  }>;
}

test("OpenCode's usage plugin writes what the reader counts: finished messages, tool payloads and a sub-agent's parent", () =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped();
      const file = `${root}/controls/usage.jsonl`;
      yield* fs.writeFileString(`${root}/usage.js`, opencodeUsage(file));
      const plugin = yield* Effect.promise((): Promise<UsagePlugin> => import(`${root}/usage.js`));
      const hooks = yield* Effect.promise(() => plugin.CollieUsage());
      const event = (type: string, properties: JsonObject) =>
        Effect.promise(() => hooks.event({ event: { type, properties } }));
      const tokens = (input: number, output: number, reasoning: number) => ({
        input,
        output,
        reasoning,
        cache: { read: 100, write: 10 },
      });
      yield* event("session.created", { info: { id: "o1" } });
      yield* event("session.created", { info: { id: "o2", parentID: "o1" } });
      yield* event("message.updated", {
        info: {
          id: "m1",
          sessionID: "o1",
          role: "assistant",
          time: { created: 1 },
          tokens: tokens(5, 1, 0),
        },
      });
      yield* event("message.updated", {
        info: {
          id: "m1",
          sessionID: "o1",
          role: "assistant",
          time: { created: 1, completed: 2 },
          tokens: tokens(50, 20, 5),
        },
      });
      yield* event("message.part.updated", {
        part: {
          id: "p1",
          sessionID: "o1",
          messageID: "m1",
          type: "tool",
          callID: "c1",
          state: { status: "completed", output: "twelve chars" },
        },
      });
      yield* event("message.updated", {
        info: {
          id: "m2",
          sessionID: "o2",
          role: "assistant",
          time: { created: 3, completed: 4 },
          tokens: tokens(7, 3, 0),
        },
      });
      yield* recordFrom(
        { dir: root },
        { run: "r1", agent: "build" },
        { harness: "opencode", cwd: root, dir: `${root}/controls` },
        [{ path: file, format: "opencode", parent: null }],
      );
      const usage = usageOf(yield* readMetrics(`${root}/evidence/r1`));
      expect(usage.totals).toEqual({
        requests: 2,
        input: 57,
        cacheRead: 200,
        cacheCreation: 20,
        output: 28,
        reasoning: 5,
      });
      expect(Arr.map(usage.sessions, (one) => [one.session, one.toolResultChars])).toEqual([
        ["o1", 12],
      ]);
      expect(Arr.map(usage.sessions[0]!.subagents, (one) => one.session)).toEqual(["o2"]);
    }),
  ));

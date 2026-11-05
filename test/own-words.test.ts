// The human's own words: what the reader takes from each harness's sessions and Collie's
// records, what it drops, and what it says it left out. Fixtures copy each store's shape,
// with invented text.

import * as Arr from "effect/Array";
import * as Option from "effect/Option";
import * as Rec from "effect/Record";
import * as Str from "effect/String";
import { pipe } from "effect/Function";
import { Database } from "bun:sqlite";
import { Effect, FileSystem, Layer, Path, Result, Schema, flow } from "effect";
import { expect, test } from "bun:test";
import { ownInventory, readOwnWords } from "../src/own-words";
import type { OwnWords } from "../src/own-words-model";
import { runEffect } from "./support/effect";
import { epochMs, isoAt } from "../src/time";

type Json = Schema.Json;
type JsonFields = Readonly<Record<string, Json>>;
const encode = flow(
  Schema.encodeUnknownResult(Schema.fromJsonString(Schema.Unknown)),
  Result.getOrThrow,
);
const NOW = epochMs("2026-11-05T12:00:00.000Z");
const json = (lines: ReadonlyArray<JsonFields>) =>
  `${Arr.join(
    Arr.map(lines, (line) => encode(line)),
    "\n",
  )}\n`;

/** A home and a state directory, each file written relative to its root. */
const places = (files: Readonly<Record<string, string>>) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "own-words-" });
    const at = { home: `${root}/home`, stateDir: `${root}/state` };
    for (const [relative, text] of Rec.toEntries(files)) {
      const file = `${root}/${relative}`;
      yield* fs.makeDirectory(path.dirname(file), { recursive: true });
      yield* fs.writeFileString(file, text);
    }
    return { ...at, root };
  });

const texts = (words: OwnWords) => Arr.map(words.messages, ({ text }) => text);
const storeOf = (words: { readonly stores: OwnWords["stores"] }, source: string) =>
  Option.getOrUndefined(Arr.findFirst(words.stores, (store) => store.source === source));

const claudeUser = (sessionId: string, at: string, content: Json, more: JsonFields = {}) => ({
  parentUuid: null,
  isSidechain: false,
  userType: "external",
  cwd: "/home/u/shop",
  sessionId,
  version: "2.1.0",
  gitBranch: "main",
  type: "user",
  message: { role: "user", content },
  uuid: `${sessionId}-${at}`,
  timestamp: at,
  ...more,
});

const CLAUDE = {
  "home/.claude/projects/-home-u-shop/0b7c-human.jsonl": json([
    { type: "permission-mode", permissionMode: "default", sessionId: "0b7c-human" },
    claudeUser("0b7c-human", "2026-10-01T09:00:00.000Z", "Keep pull requests small.", {
      origin: { kind: "human" },
      promptSource: "typed",
    }),
    {
      type: "assistant",
      sessionId: "0b7c-human",
      timestamp: "2026-10-01T09:00:05.000Z",
      message: { role: "assistant", content: [{ type: "text", text: "Model says sure." }] },
    },
    claudeUser("0b7c-human", "2026-10-01T09:00:06.000Z", [
      { type: "tool_result", tool_use_id: "toolu_1", content: "Tool printed a file." },
    ]),
    claudeUser("0b7c-human", "2026-10-01T09:00:07.000Z", "Caveat: injected by the harness", {
      isMeta: true,
    }),
    claudeUser(
      "0b7c-human",
      "2026-10-01T09:00:08.000Z",
      "<command-name>/clear</command-name>\n<command-message>clear</command-message>",
    ),
    claudeUser(
      "0b7c-human",
      "2026-10-01T09:00:09.000Z",
      "<task-notification>\n<task-id>b1</task-id>\n</task-notification>",
      { origin: { kind: "task-notification" } },
    ),
    claudeUser(
      "0b7c-human",
      "2026-10-01T09:00:10.000Z",
      "This session is being continued from a previous conversation.",
      { isCompactSummary: true, isVisibleInTranscriptOnly: true },
    ),
    claudeUser(
      "0b7c-human",
      "2026-10-01T09:01:00.000Z",
      "Run the tests before you push.\n\n<system-reminder>\nHook context.\n</system-reminder>",
    ),
  ]),
  "home/.claude/projects/-home-u-shop/1d2e-collie.jsonl": json([
    claudeUser(
      "1d2e-collie",
      "2026-10-02T09:00:00.000Z",
      "collie-delivery:run-1-build-step-1\nYour task for this step is in a file.",
    ),
    claudeUser("1d2e-collie", "2026-10-02T09:05:00.000Z", "Collie's agent was steered."),
  ]),
};

test("from Claude Code, only what the human typed, with its date and directory; Collie's agents' sessions are skipped", () =>
  runEffect(
    Effect.gen(function* () {
      const at = yield* places(CLAUDE);
      const words = yield* readOwnWords(at, NOW);
      expect(words.messages).toEqual([
        {
          source: "claude-code",
          at: "2026-10-01T09:01:00.000Z",
          cwd: "/home/u/shop",
          text: "Run the tests before you push.",
        },
        {
          source: "claude-code",
          at: "2026-10-01T09:00:00.000Z",
          cwd: "/home/u/shop",
          text: "Keep pull requests small.",
        },
      ]);
      expect(storeOf(words, "claude-code")).toMatchObject({ found: "read", sessions: 2 });
      expect(words.skipped).toBe(1);
    }).pipe(Effect.scoped),
  ));

test("a session Collie recorded for an agent is skipped, though it carries no delivery token", () =>
  runEffect(
    Effect.gen(function* () {
      const at = yield* places({
        "home/.claude/projects/-home-u-shop/5f6a-agent.jsonl": json([
          claudeUser("5f6a-agent", "2026-10-02T09:00:00.000Z", "A prompt Collie wrote."),
        ]),
        "state/agents/run-1/build.launch.json": encode({
          agent: "run-1-build-r1",
          agentSession: { kind: "id", value: "5f6a-agent" },
        }),
      });
      const words = yield* readOwnWords(at, NOW);
      expect(words.messages).toEqual([]);
      expect(words.skipped).toBe(1);
    }).pipe(Effect.scoped),
  ));

const codexLine = (at: string, type: string, payload: JsonFields) => ({
  timestamp: at,
  type,
  payload,
});
const CODEX = {
  "home/.codex/sessions/2026/10/03/rollout-2026-10-03T08-00-00-01a0.jsonl": json([
    codexLine("2026-10-03T08:00:00.000Z", "session_meta", {
      id: "01a0",
      cwd: "/home/u/api",
      originator: "codex-tui",
      source: "cli",
    }),
    codexLine("2026-10-03T08:00:00.100Z", "response_item", {
      type: "message",
      role: "developer",
      content: [{ type: "input_text", text: "Developer instructions." }],
    }),
    codexLine("2026-10-03T08:00:00.200Z", "response_item", {
      type: "message",
      role: "user",
      content: [
        { type: "input_text", text: "# AGENTS.md instructions for /home/u/api\n\nRepo rules." },
        {
          type: "input_text",
          text: "<environment_context>\n  <cwd>/home/u/api</cwd>\n</environment_context>",
        },
      ],
    }),
    codexLine("2026-10-03T08:01:00.000Z", "response_item", {
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: "Prefer Effect over promises." }],
    }),
    codexLine("2026-10-03T08:01:00.100Z", "event_msg", {
      type: "user_message",
      message: "Prefer Effect over promises.",
    }),
    codexLine("2026-10-03T08:01:05.000Z", "response_item", {
      type: "function_call_output",
      call_id: "c1",
      output: "Tool output.",
    }),
    codexLine("2026-10-03T08:01:06.000Z", "response_item", {
      type: "message",
      role: "assistant",
      content: [{ type: "output_text", text: "Codex replies." }],
    }),
  ]),
  "home/.codex/sessions/2026/10/03/rollout-2026-10-03T09-00-00-02b0.jsonl": json([
    codexLine("2026-10-03T09:00:00.000Z", "session_meta", {
      id: "02b0",
      cwd: "/home/u/api",
      source: "exec",
    }),
    codexLine("2026-10-03T09:00:01.000Z", "response_item", {
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: "collie-delivery:run-2-build-step-1 Build it." }],
    }),
  ]),
};

test("from Codex, only what the human typed, once each, with its date and directory", () =>
  runEffect(
    Effect.gen(function* () {
      const words = yield* readOwnWords(yield* places(CODEX), NOW);
      expect(words.messages).toEqual([
        {
          source: "codex",
          at: "2026-10-03T08:01:00.000Z",
          cwd: "/home/u/api",
          text: "Prefer Effect over promises.",
        },
      ]);
      expect(storeOf(words, "codex")).toMatchObject({ found: "read", sessions: 2 });
      expect(words.skipped).toBe(1);
    }).pipe(Effect.scoped),
  ));

const PI = {
  "home/.pi/agent/sessions/--home-u-web--/2026-10-04T07-00-00-000Z_aa11.jsonl": json([
    {
      type: "session",
      version: 3,
      id: "aa11",
      timestamp: "2026-10-04T07:00:00.000Z",
      cwd: "/home/u/web",
    },
    { type: "model_change", id: "m1", parentId: null, timestamp: "2026-10-04T07:00:01.000Z" },
    {
      type: "message",
      id: "u1",
      parentId: "m1",
      timestamp: "2026-10-04T07:01:00.000Z",
      message: { role: "user", content: [{ type: "text", text: "Ask before deleting branches." }] },
    },
    {
      type: "message",
      id: "a1",
      parentId: "u1",
      timestamp: "2026-10-04T07:01:05.000Z",
      message: {
        role: "assistant",
        content: [
          { type: "text", text: "Pi replies." },
          { type: "toolCall", id: "t1", name: "bash", arguments: {} },
        ],
      },
    },
    {
      type: "message",
      id: "r1",
      parentId: "a1",
      timestamp: "2026-10-04T07:01:06.000Z",
      message: { role: "toolResult", content: [{ type: "text", text: "Pi tool output." }] },
    },
    {
      type: "custom_message",
      id: "c1",
      parentId: "r1",
      timestamp: "2026-10-04T07:02:00.000Z",
      customType: "collie-news",
      content: "News an extension injected.",
      display: true,
    },
  ]),
  "home/.pi/agent/sessions/--home-u-web--/2026-10-04T08-00-00-000Z_bb22.jsonl": json([
    {
      type: "session",
      version: 3,
      id: "bb22",
      timestamp: "2026-10-04T08:00:00.000Z",
      cwd: "/home/u/web",
    },
    {
      type: "message",
      id: "u1",
      parentId: null,
      timestamp: "2026-10-04T08:00:01.000Z",
      message: {
        role: "user",
        content: [{ type: "text", text: "collie-delivery:run-3-review-1 Review it." }],
      },
    },
  ]),
};

test("from Pi, only what the human typed, with its date and directory", () =>
  runEffect(
    Effect.gen(function* () {
      const words = yield* readOwnWords(yield* places(PI), NOW);
      expect(words.messages).toEqual([
        {
          source: "pi",
          at: "2026-10-04T07:01:00.000Z",
          cwd: "/home/u/web",
          text: "Ask before deleting branches.",
        },
      ]);
      expect(storeOf(words, "pi")).toMatchObject({ found: "read", sessions: 2 });
      expect(words.skipped).toBe(1);
    }).pipe(Effect.scoped),
  ));

/** OpenCode's store as its tables are, with only the columns read here among the rest. */
const openCode = (file: string) => {
  const db = new Database(file, { create: true });
  db.run(
    "CREATE TABLE session (id text PRIMARY KEY, project_id text NOT NULL, parent_id text, slug text NOT NULL, directory text NOT NULL, title text NOT NULL, version text NOT NULL, time_created integer NOT NULL, time_updated integer NOT NULL)",
  );
  db.run(
    "CREATE TABLE message (id text PRIMARY KEY, session_id text NOT NULL, time_created integer NOT NULL, time_updated integer NOT NULL, data text NOT NULL)",
  );
  db.run(
    "CREATE TABLE part (id text PRIMARY KEY, message_id text NOT NULL, session_id text NOT NULL, time_created integer NOT NULL, time_updated integer NOT NULL, data text NOT NULL)",
  );
  const session = (id: string, parent: string | null) =>
    db.run("INSERT INTO session VALUES (?, 'p1', ?, ?, '/home/u/ops', 't', '1', 0, 0)", [
      id,
      parent,
      id,
    ]);
  const message = (id: string, session: string, role: string, at: number) =>
    db.run("INSERT INTO message VALUES (?, ?, ?, ?, ?)", [
      id,
      session,
      at,
      at,
      encode({ role, time: { created: at } }),
    ]);
  const part = (id: string, messageId: string, session: string, data: JsonFields) =>
    db.run("INSERT INTO part VALUES (?, ?, ?, 0, 0, ?)", [id, messageId, session, encode(data)]);
  const at = epochMs("2026-10-05T10:00:00.000Z");
  session("ses_human", null);
  message("m1", "ses_human", "user", at);
  part("p1", "m1", "ses_human", { type: "text", text: "Deploy on Tuesdays only." });
  part("p2", "m1", "ses_human", { type: "text", text: "Called the read tool.", synthetic: true });
  message("m2", "ses_human", "assistant", at + 1000);
  part("p3", "m2", "ses_human", { type: "text", text: "OpenCode replies." });
  part("p4", "m2", "ses_human", { type: "tool", tool: "bash", state: { output: "Tool output." } });
  session("ses_sub", "ses_human");
  message("m3", "ses_sub", "user", at + 2000);
  part("p5", "m3", "ses_sub", { type: "text", text: "A subagent's prompt from the model." });
  session("ses_collie", null);
  message("m4", "ses_collie", "user", at + 3000);
  part("p6", "m4", "ses_collie", { type: "text", text: "collie-delivery:run-4-build Build." });
  db.close();
};

test("from OpenCode, only what the human typed, with its date and directory", () =>
  runEffect(
    Effect.gen(function* () {
      const at = yield* places({ "home/.local/share/opencode/.keep": "" });
      openCode(`${at.home}/.local/share/opencode/opencode.db`);
      const words = yield* readOwnWords(at, NOW);
      expect(words.messages).toEqual([
        {
          source: "opencode",
          at: "2026-10-05T10:00:00.000Z",
          cwd: "/home/u/ops",
          text: "Deploy on Tuesdays only.",
        },
      ]);
      expect(storeOf(words, "opencode")).toMatchObject({ found: "read", sessions: 3 });
      expect(words.skipped).toBe(1);
    }).pipe(Effect.scoped),
  ));

const audit = (
  operation: string,
  actor: JsonFields,
  asked: Json,
  at = "2026-10-06T10:00:00.000Z",
) => ({
  at,
  operation,
  request: `${operation}-${at}`,
  actor: { requestId: `${operation}-${at}`, ...actor },
  asked,
  result: {},
});
/** The host's store as it keeps who started each Run, with only the columns read here. */
const hostStore = (file: string, placings: Readonly<Record<string, Json>>) => {
  const db = new Database(file, { create: true });
  db.run("CREATE TABLE collie_runs (run TEXT PRIMARY KEY, request TEXT, placing TEXT)");
  for (const [run, placing] of Rec.toEntries(placings))
    db.run("INSERT INTO collie_runs VALUES (?, ?, ?)", [run, `r-${run}`, encode(placing)]);
  db.close();
};

const COLLIE = {
  "state/runs/run-a/intent.json": encode({
    version: 1,
    run: "run-a",
    goal: "A goal a planner wrote.",
  }),
  "state/runs/run-a/operations.jsonl": json([
    audit("start", { origin: "cli-tty" }, null, "2026-10-06T09:00:00.000Z"),
    audit(
      "deliver",
      { origin: "desktop" },
      { text: "Use the staging database.", operation: null, agent: null, mode: null },
    ),
    audit(
      "hold",
      { origin: "chat", conversation: "native", said: "pause it until Monday" },
      { reason: null },
      "2026-10-06T11:00:00.000Z",
    ),
    audit(
      "deliver",
      { origin: "agent", from: { run: "run-b", agent: "b1" } },
      { text: "An agent told it something.", operation: null, agent: null, mode: null },
      "2026-10-06T12:00:00.000Z",
    ),
    audit(
      "deliver",
      { origin: "host" },
      { text: "The host relayed this.", operation: null, agent: null, mode: null },
      "2026-10-06T12:01:00.000Z",
    ),
    audit(
      "start",
      { origin: "schedule", schedule: { name: "nightly", occurrence: "x" } },
      null,
      "2026-10-06T12:02:00.000Z",
    ),
    audit("verify", { origin: "cli" }, { name: "check" }, "2026-10-06T12:03:00.000Z"),
  ]),
};

test("from Collie's records, the human's own words with their Run, and nothing an agent, the host or a Schedule said", () =>
  runEffect(
    Effect.gen(function* () {
      const at = yield* places(COLLIE);
      hostStore(`${at.stateDir}/host.db`, {
        "run-a": {
          started: { door: "cli-tty", words: "Make checkout retry on 502." },
          from: "/x",
          taskLabel: null,
        },
      });
      const words = yield* readOwnWords(at, NOW);
      expect(words.messages).toEqual([
        {
          source: "collie",
          at: "2026-10-06T11:00:00.000Z",
          cwd: null,
          text: "pause it until Monday",
          run: "run-a",
        },
        {
          source: "collie",
          at: "2026-10-06T10:00:00.000Z",
          cwd: null,
          text: "Use the staging database.",
          run: "run-a",
        },
        {
          source: "collie",
          at: "2026-10-06T09:00:00.000Z",
          cwd: null,
          text: "Make checkout retry on 502.",
          run: "run-a",
        },
      ]);
      expect(storeOf(words, "collie")).toMatchObject({ found: "read", sessions: 3 });
    }).pipe(Effect.scoped),
  ));

test("the newest 400 messages and 60,000 characters at most, each cut to 1,000, the last 90 days, credentials redacted", () =>
  runEffect(
    Effect.gen(function* () {
      const lines = Arr.makeBy(450, (i) =>
        claudeUser(
          "9a9a-many",
          isoAt(epochMs("2026-10-10T00:00:00.000Z") + i * 60_000),
          `Message ${i}.`,
        ),
      );
      const many = yield* readOwnWords(
        yield* places({ "home/.claude/projects/-home-u-shop/9a9a-many.jsonl": json(lines) }),
        NOW,
      );
      expect(many.messages.length).toBe(400);
      expect(many.messages[0]?.text).toBe("Message 449.");
      expect(many.leftOut).toBe(50);

      const long = yield* readOwnWords(
        yield* places({
          "home/.claude/projects/-home-u-shop/8b8b-long.jsonl": json([
            claudeUser("8b8b-long", "2026-10-10T00:00:00.000Z", pipe("x", Str.repeat(1500))),
            claudeUser("8b8b-long", "2026-08-01T00:00:00.000Z", "Ninety-six days old."),
            claudeUser(
              "8b8b-long",
              "2026-10-11T00:00:00.000Z",
              "My token is glpat-abcdefghijklmnopqrst, keep it.",
            ),
          ]),
        }),
        NOW,
      );
      expect(texts(long)).toEqual([
        "My token is <gitlab token>, keep it.",
        pipe("x", Str.repeat(1000)),
      ]);
      expect(long.cut).toBe(1);

      const wide = yield* readOwnWords(
        yield* places({
          "home/.claude/projects/-home-u-shop/7c7c-wide.jsonl": json(
            Arr.makeBy(70, (i) =>
              claudeUser(
                "7c7c-wide",
                isoAt(epochMs("2026-10-10T00:00:00.000Z") + i * 60_000),
                pipe(`${i}`, Str.padEnd(1000, ".")),
              ),
            ),
          ),
        }),
        NOW,
      );
      expect(wide.messages.length).toBe(60);
      expect(wide.leftOut).toBe(10);
    }).pipe(Effect.scoped),
  ));

test("a store that is not there, or that cannot be read, is named and never guessed at", () =>
  runEffect(
    Effect.gen(function* () {
      const at = yield* places({ "home/.local/share/opencode/opencode.db": "not a database" });
      const words = yield* readOwnWords(at, NOW);
      expect(storeOf(words, "claude-code")).toMatchObject({ found: "missing", sessions: 0 });
      expect(storeOf(words, "opencode")).toMatchObject({ found: "unreadable" });
      expect(storeOf(words, "opencode")?.why).toBeDefined();
      expect(words.messages).toEqual([]);
    }).pipe(Effect.scoped),
  ));

test("the inventory counts where the human's words are, and holds none of them", () =>
  runEffect(
    Effect.gen(function* () {
      const at = yield* places({ ...CLAUDE, ...CODEX, ...PI, ...COLLIE });
      const inventory = yield* ownInventory(at);
      expect(storeOf(inventory, "claude-code")).toMatchObject({ found: "read", sessions: 2 });
      expect(storeOf(inventory, "codex")).toMatchObject({ found: "read", sessions: 2 });
      expect(storeOf(inventory, "pi")).toMatchObject({ found: "read", sessions: 2 });
      expect(storeOf(inventory, "opencode")).toMatchObject({ found: "missing", sessions: 0 });
      expect(storeOf(inventory, "collie")).toMatchObject({ found: "read", sessions: 3 });
      const said = encode(inventory);
      for (const typed of [
        "Keep pull requests small",
        "Prefer Effect",
        "Ask before deleting",
        "staging database",
      ])
        expect(said).not.toContain(typed);
    }).pipe(Effect.scoped),
  ));

test("a typed turn that carries an image keeps its text; a tool's result beside text is still dropped", () =>
  runEffect(
    Effect.gen(function* () {
      const image = {
        type: "image",
        source: { type: "base64", media_type: "image/png", data: "iVBO" },
      };
      const words = yield* readOwnWords(
        yield* places({
          "home/.claude/projects/-home-u-shop/6e6e-image.jsonl": json([
            claudeUser("6e6e-image", "2026-10-12T00:00:00.000Z", [
              { type: "text", text: "Match this screenshot's spacing." },
              image,
            ]),
            claudeUser("6e6e-image", "2026-10-12T00:01:00.000Z", [
              { type: "tool_result", tool_use_id: "toolu_2", content: "Tool output." },
              { type: "text", text: "Text a tool's result carried." },
            ]),
          ]),
          "home/.pi/agent/sessions/--home-u-web--/2026-10-12T00-00-00-000Z_cc33.jsonl": json([
            {
              type: "session",
              version: 3,
              id: "cc33",
              timestamp: "2026-10-12T00:00:00.000Z",
              cwd: "/home/u/web",
            },
            {
              type: "message",
              id: "u1",
              parentId: null,
              timestamp: "2026-10-12T00:02:00.000Z",
              message: {
                role: "user",
                content: [
                  { type: "text", text: "Use this logo." },
                  { type: "image", data: "iVBO", mimeType: "image/png" },
                ],
              },
            },
          ]),
        }),
        NOW,
      );
      expect(texts(words)).toEqual(["Use this logo.", "Match this screenshot's spacing."]);
    }).pipe(Effect.scoped),
  ));

test("an OpenCode session whose delivery token is older than 90 days is still Collie's", () =>
  runEffect(
    Effect.gen(function* () {
      const at = yield* places({ "home/.local/share/opencode/.keep": "" });
      const file = `${at.home}/.local/share/opencode/opencode.db`;
      openCode(file);
      const db = new Database(file);
      const old = epochMs("2026-07-01T10:00:00.000Z");
      const recent = epochMs("2026-10-20T10:00:00.000Z");
      db.run(
        "INSERT INTO session VALUES ('ses_old', 'p1', NULL, 'old', '/home/u/ops', 't', '1', 0, 0)",
      );
      db.run("INSERT INTO message VALUES ('m9', 'ses_old', ?, ?, ?)", [
        old,
        old,
        encode({ role: "user" }),
      ]);
      db.run("INSERT INTO part VALUES ('p9', 'm9', 'ses_old', 0, 0, ?)", [
        encode({ type: "text", text: "collie-delivery:run-5-build Build." }),
      ]);
      db.run("INSERT INTO message VALUES ('m10', 'ses_old', ?, ?, ?)", [
        recent,
        recent,
        encode({ role: "user" }),
      ]);
      db.run("INSERT INTO part VALUES ('p10', 'm10', 'ses_old', 0, 0, ?)", [
        encode({ type: "text", text: "Collie steered its agent." }),
      ]);
      db.close();
      const words = yield* readOwnWords(at, NOW);
      expect(texts(words)).toEqual(["Deploy on Tuesdays only."]);
      expect(words.skipped).toBe(2);
    }).pipe(Effect.scoped),
  ));

test("a human's answer comes back from where the host records it", () =>
  runEffect(
    Effect.gen(function* () {
      const words = yield* readOwnWords(
        yield* places({
          "state/runs/run-c/operations.jsonl": json([
            {
              at: "2026-10-07T10:00:00.000Z",
              operation: "answer",
              request: "a1",
              actor: { origin: "board", requestId: "a1" },
              result: {
                runId: "run-c",
                decision: "scope",
                value: "Only the API, not the UI.",
                fresh: true,
              },
            },
            {
              at: "2026-10-07T10:01:00.000Z",
              operation: "answer",
              request: "a2",
              actor: { origin: "agent", requestId: "a2" },
              result: {
                runId: "run-c",
                decision: "scope",
                value: "An agent's answer.",
                fresh: true,
              },
            },
          ]),
        }),
        NOW,
      );
      expect(texts(words)).toEqual(["Only the API, not the UI."]);
    }).pipe(Effect.scoped),
  ));

test("a Run's start is the words its human started it with, never the Intent's goal", () =>
  runEffect(
    Effect.gen(function* () {
      const at = yield* places({
        "state/runs/run-d/intent.json": encode({
          version: 1,
          run: "run-d",
          goal: "A goal a planner wrote.",
        }),
        "state/runs/run-d/operations.jsonl": json([
          audit("start", { origin: "desktop" }, null, "2026-10-08T09:00:00.000Z"),
        ]),
        "state/runs/run-e/intent.json": encode({
          version: 1,
          run: "run-e",
          goal: "Another planner's goal.",
        }),
        "state/runs/run-e/operations.jsonl": json([
          audit("start", { origin: "board" }, null, "2026-10-08T10:00:00.000Z"),
        ]),
      });
      hostStore(`${at.stateDir}/host.db`, {
        "run-d": {
          started: { door: "desktop", words: "Fix the flaky login test." },
          from: "/x",
          taskLabel: null,
        },
        "run-e": { from: "/x", taskLabel: null },
      });
      const words = yield* readOwnWords(at, NOW);
      expect(words.messages).toEqual([
        {
          source: "collie",
          at: "2026-10-08T09:00:00.000Z",
          cwd: null,
          text: "Fix the flaky login test.",
          run: "run-d",
        },
      ]);
    }).pipe(Effect.scoped),
  ));

test("the inventory counts Collie's human entries without opening what they said", () =>
  runEffect(
    Effect.gen(function* () {
      const at = yield* places({
        ...COLLIE,
        "state/runs/run-a/operations.jsonl": json([
          audit(
            "deliver",
            { origin: "desktop" },
            { text: "Same words.", operation: null, agent: null, mode: null },
          ),
          audit(
            "deliver",
            { origin: "desktop" },
            { text: "Same words.", operation: null, agent: null, mode: null },
            "2026-10-06T10:05:00.000Z",
          ),
          audit("start", { origin: "cli-tty" }, null, "2026-10-06T09:00:00.000Z"),
        ]),
      });
      const opened: Array<string> = [];
      const recording = Layer.effect(
        FileSystem.FileSystem,
        Effect.map(FileSystem.FileSystem, (fs) => ({
          ...fs,
          readFileString: (path: string, encoding?: string) => {
            opened.push(path);
            return fs.readFileString(path, encoding);
          },
        })),
      );
      const inventory = yield* ownInventory(at).pipe(Effect.provide(recording));
      expect(storeOf(inventory, "collie")).toMatchObject({ found: "read", sessions: 3 });
      expect(Arr.filter(opened, Str.endsWith("intent.json"))).toEqual([]);
    }).pipe(Effect.scoped),
  ));

test("a session file it cannot read, or whose records it does not know, is counted and named, never read as empty", () =>
  runEffect(
    Effect.gen(function* () {
      const at = yield* places({
        ...CLAUDE,
        "home/.claude/projects/-home-u-shop/2f2f-changed.jsonl": "{not json\n",
        "home/.codex/sessions/2026/10/03/rollout-2026-10-03T10-00-00-03c0.jsonl": json([
          { kind: "turn", said: "A format Codex might change to." },
        ]),
        "state/runs/run-f/operations.jsonl/.keep": "",
      });
      const words = yield* readOwnWords(at, NOW);
      expect(storeOf(words, "claude-code")).toMatchObject({
        found: "read",
        sessions: 3,
        unread: 1,
      });
      expect(storeOf(words, "claude-code")?.why).toContain("2f2f-changed.jsonl");
      expect(storeOf(words, "codex")).toMatchObject({ found: "read", sessions: 1, unread: 1 });
      expect(storeOf(words, "collie")).toMatchObject({ unread: 1 });
      expect(texts(words)).toEqual(["Run the tests before you push.", "Keep pull requests small."]);
    }).pipe(Effect.scoped),
  ));

test("a record type its harness does not write, or a broken audit line, makes the file unread", () =>
  runEffect(
    Effect.gen(function* () {
      const future = (more: JsonFields) =>
        json([{ type: "future_user_message", timestamp: "2026-10-03T10:00:00.000Z", ...more }]);
      const at = yield* places({
        "home/.claude/projects/-home-u-shop/3a3a-future.jsonl": future({
          message: { role: "user", content: "Said in a newer format." },
        }),
        "home/.codex/sessions/2026/10/03/rollout-2026-10-03T10-00-00-04c0.jsonl": future({
          payload: { text: "Said in a newer format." },
        }),
        "home/.pi/agent/sessions/--home-u-web--/2026-10-03_pi.jsonl": future({
          message: { role: "user", content: "Said in a newer format." },
        }),
        "state/runs/run-g/operations.jsonl": `${json([
          audit("start", { origin: "cli-tty" }, null, "2026-10-06T09:00:00.000Z"),
        ])}{"op":"deliver",\n`,
      });
      const words = yield* readOwnWords(at, NOW);
      for (const source of ["claude-code", "codex", "pi"]) {
        expect([source, storeOf(words, source)]).toMatchObject([
          source,
          { found: "read", sessions: 1, unread: 1 },
        ]);
        expect([source, storeOf(words, source)?.why]).toEqual([
          source,
          expect.stringContaining("future_user_message"),
        ]);
      }
      expect(storeOf(words, "collie")).toMatchObject({ unread: 1 });
      expect(storeOf(words, "collie")?.why).toContain("run-g");
    }).pipe(Effect.scoped),
  ));

// The Flock chat's turns, driven against a scripted Claude Code: one turn at a time, a turn
// of Desktop's own only about News that matters, and every turn ending however it ends.

import { expect, test } from "bun:test";
import { BunServices } from "@effect/platform-bun";
import {
  Crypto,
  Deferred,
  Effect,
  Fiber,
  FileSystem,
  Option,
  Path,
  Schema,
  type Scope,
  Stream,
  Queue,
} from "effect";
import { TestClock } from "effect/testing";
import { type Declaration, NewsBatch, PROTOCOL, type Significance } from "../src/board-model";
import { stageAttachment } from "../desktop/src/bun/attachments";
import { openFlockChat } from "../desktop/src/bun/chat";
import { type ClaudeCode, claudeDriver } from "../desktop/src/bun/claude-driver";
import type { AguiEvent } from "../desktop/src/shared/agui";
import type { TurnCost } from "../desktop/src/bun/driver";
import type { ChatDriver, DriverContext } from "../desktop/src/bun/driver";
import { changeSettings } from "../desktop/src/bun/settings";
import { offerOf, opensOn } from "../desktop/src/bun/chat-choices";
import { harnessLists } from "../desktop/src/bun/harness-lists";
import type { ListedModel } from "../desktop/src/bun/claude-models";
import { DesktopSettings } from "../desktop/src/shared/flock";
import type { ChatChoices } from "../desktop/src/shared/chat-choices";
import { NO_FLOCK_SETTINGS } from "../desktop/src/shared/flock-settings";
import type { SdkMessage } from "../desktop/src/bun/agui";
import {
  callFlockTool,
  type ChatDoor,
  type ChatMachine,
  type FlockChat,
} from "../desktop/src/bun/flock-tools";
import { listing } from "../desktop/src/shared/attachments";
import { aboutNote, type ChatMessage, DESKTOP_SAID } from "../desktop/src/shared/chat-view";
import { isString } from "../src/schema";

type Item = (typeof NewsBatch.Type)["items"][number];

const item = (key: string, significance: Significance): Item => ({
  key,
  run: key.split(":")[0] ?? key,
  text: `${key} happened.`,
  at: "2026-10-05T00:00:00Z",
  significance,
});

/** A Machine whose one Herd has this News until it is settled read. */
const machine = (
  items: ReadonlyArray<Item>,
  read: string[],
  declared: Declaration[] = [],
): ChatMachine => {
  const door: Partial<ChatDoor> = {
    declare: (payload) => Effect.sync(() => void declared.push(payload)),
    news: ({ as, keys }) =>
      Effect.sync(() => {
        if (as === "read") read.push(...(keys ?? []));
        return {
          items: items.filter(({ key }) => !read.includes(key)),
          omitted: 0,
        };
      }),
  };
  // SAFETY: the chat's turns reach a Machine only through declare and news.
  return {
    name: "vm-mk",
    door: door as ChatDoor,
    board: { _tag: "Live", herds: [{ id: "h1" }], tasks: [], protocol: PROTOCOL, files: false },
  };
};

interface ScriptedDrivers {
  [harness: string]: ChatDriver;
}

interface Seen {
  flock?: FlockChat;
  readonly transcripts: Map<string, unknown[]>;
  readonly prompts: string[];
  /** Each message as the SDK was handed it. */
  readonly contents: unknown[];
  /** What each turn's message went with, as the UserPromptSubmit hook adds it. */
  readonly context: string[];
  readonly refusals: string[];
  /** Each time the session was interrupted. */
  readonly interrupts: string[];
  /** Each session started: its model, and the conversation it resumed or started. */
  readonly sessions: Array<{
    readonly model: string;
    readonly resume?: string;
    readonly sessionId?: string;
  }>;
  /** Each session's MCP servers, by name. */
  readonly servers: string[][];
  readonly efforts: string[];
}

const SAID = { type: "stream_event", parent_tool_use_id: null };

/**
 * Claude Code answering each message with `reply`'s messages; one `holds` names answers only
 * once it is interrupted.
 */
const scripted = (
  seen: Seen,
  reply: (text: string) => ReadonlyArray<SdkMessage>,
  holds: (text: string) => boolean = () => false,
  gate?: Deferred.Deferred<void>,
): ClaudeCode<string> => ({
  query: ({ prompt, options }) => {
    const id = "resume" in options ? options.resume : options.sessionId;
    seen.servers.push(Object.keys(options.mcpServers));
    seen.efforts.push(options.effort ?? "none");
    seen.sessions.push({
      model: options.model,
      ...("resume" in options ? { resume: options.resume } : { sessionId: options.sessionId }),
    });
    const closed = Deferred.makeUnsafe<void>();
    let interrupted = Deferred.makeUnsafe<void>();
    const turns = Stream.fromAsyncIterable(prompt, String).pipe(
      Stream.interruptWhen(Deferred.await(closed)),
      Stream.mapEffect((message) =>
        Effect.gen(function* () {
          const text = isString(message.message.content) ? message.message.content : "";
          seen.prompts.push(text);
          seen.contents.push(message.message.content);
          const transcript = seen.transcripts.get(id) ?? [];
          transcript.push({ ...message, uuid: `u-${transcript.length}` });
          seen.transcripts.set(id, transcript);
          // SAFETY: sessionOptions sets one UserPromptSubmit hook.
          const added = yield* Effect.promise(() => options.hooks.UserPromptSubmit[0]!.hooks[0]!());
          seen.context.push(
            "hookSpecificOutput" in added
              ? (added.hookSpecificOutput?.additionalContext ?? "")
              : "",
          );
          // A human's turn would wait for their click; only Desktop's own is asked here.
          if (text.startsWith(DESKTOP_SAID)) {
            const asked = yield* Effect.promise(() =>
              options.canUseTool(
                "AskUserQuestion",
                { questions: [] },
                { signal: new AbortController().signal, toolUseID: `toolu_${seen.prompts.length}` },
              ),
            );
            if (asked.behavior === "deny") seen.refusals.push(text);
          }
          if (holds(text)) {
            yield* Deferred.await(interrupted);
            interrupted = Deferred.makeUnsafe<void>();
          }
          if (text === "slow" && gate !== undefined) yield* Deferred.await(gate);
          return reply(text);
        }),
      ),
      Stream.flatMap(Stream.fromIterable),
    );
    return Object.assign(Stream.toAsyncIterable(turns), {
      interrupt: () => {
        seen.interrupts.push("interrupt");
        Deferred.doneUnsafe(interrupted, Effect.void);
        return Promise.resolve();
      },
      close: () => Deferred.doneUnsafe(closed, Effect.void),
    });
  },
  getSessionInfo: (id) => Promise.resolve(seen.transcripts.has(id) ? { sessionId: id } : undefined),
  getSessionMessages: (id) => Promise.resolve(seen.transcripts.get(id) ?? []),
  listSessions: () =>
    Promise.resolve(
      [...seen.transcripts.keys()].map((sessionId) => ({
        sessionId,
        summary: "Earlier",
        lastModified: 1,
      })),
    ),
  server: (flock) => {
    seen.flock = flock;
    return "collie";
  },
  userServers: () =>
    Promise.resolve({ "linear-server": { type: "http", url: "https://mcp.linear.app/mcp" } }),
});

const answered = (text: string) => [
  { ...SAID, event: { type: "message_start", message: { id: `m-${text}` } } },
  { ...SAID, event: { type: "content_block_start", index: 0, content_block: { type: "text" } } },
  {
    ...SAID,
    event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Noted." } },
  },
  { ...SAID, event: { type: "content_block_stop", index: 0 } },
  {
    type: "result",
    subtype: "success",
    is_error: false,
    duration_ms: 1200,
    usage: {
      input_tokens: 10,
      output_tokens: 20,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
    },
  },
];

/** Waits, in real time, for what a session's own promises settle. */
const eventually = (check: () => boolean) =>
  Effect.gen(function* () {
    for (let tries = 0; tries < 200 && !check(); tries++)
      yield* TestClock.withLive(Effect.sleep("10 millis"));
    expect(check()).toBe(true);
  });

/** Claude Code whose first `failed` sessions fail as they start, as one not logged in does. */
const failingFirst = (claude: ClaudeCode<string>, failed: number): ClaudeCode<string> => {
  let started = 0;
  return {
    ...claude,
    query: (params) =>
      started++ < failed
        ? Object.assign(
            Stream.toAsyncIterable(Stream.fail(new Error("Claude Code is not logged in"))),
            { interrupt: () => Promise.resolve(), close: () => {} },
          )
        : claude.query(params),
  };
};

/** A harness that finishes each turn at once, with its own history, and the conversations it opened. */
const fakeDriver = (
  listed: ReadonlyArray<{ readonly session: string; readonly title: string; readonly at: number }>,
  transcripts: Readonly<Record<string, ReadonlyArray<ChatMessage>>> = {},
) => {
  const opened: string[] = [];
  const driver: ChatDriver = {
    installed: true,
    open: (id) =>
      Effect.gen(function* () {
        opened.push(id);
        const events = yield* Queue.unbounded<AguiEvent>();
        return {
          conversation: () => id,
          offer: () =>
            Queue.offer(events, { type: "RUN_FINISHED" as const, threadId: id, runId: id }).pipe(
              Effect.asVoid,
            ),
          events: Stream.fromQueue(events),
          interrupt: Effect.void,
          close: Effect.void,
          lastTurn: () => undefined,
          limited: () => false,
        };
      }),
    transcript: (id) => Effect.succeed(transcripts[id] ?? []),
    earlier: (limit) => Effect.succeed(listed.slice(0, limit)),
    transcriptPath: () => Effect.succeed(null),
  };
  return { driver, opened };
};

const said = (id: string, text: string): ChatMessage => ({
  id,
  role: "user",
  parts: [{ type: "text", content: text }],
});

const SESSION_FILE = Schema.fromJsonString(
  Schema.Struct({ session: Schema.String, harness: Schema.String }),
);

const withChat = <A, E>(
  opts: {
    readonly items: ReadonlyArray<Item>;
    readonly proactive: boolean;
    readonly holds?: (text: string) => boolean;
    readonly rule?: string;
    readonly declared?: Declaration[];
    readonly failedStarts?: number;
    /** What Desktop's Settings have, which a test may change between turns. */
    readonly settings?: { current: DesktopSettings };
    readonly pi?: (context: DriverContext) => ChatDriver;
    /** Drivers in place of, or beside, the scripted Claude Code. */
    readonly drivers?: ScriptedDrivers;
    readonly gate?: Deferred.Deferred<void>;
    /** The current conversation's file, as an earlier Desktop left it. */
    readonly savedFile?: string;
    readonly transcripts?: ReadonlyArray<readonly [string, unknown[]]>;
    /** Ticks as Desktop's saved settings or the Flock's models would. */
    readonly retold?: Stream.Stream<unknown>;
    readonly readers?: Readonly<Record<string, Effect.Effect<ReadonlyArray<ListedModel>, string>>>;
  },
  reply: (text: string) => ReadonlyArray<SdkMessage>,
  body: (chat: {
    readonly conversation: Effect.Success<ReturnType<typeof openFlockChat>>;
    readonly seen: Seen;
    readonly read: string[];
    readonly dir: string;
  }) => Effect.Effect<A, E, Crypto.Crypto | FileSystem.FileSystem | Path.Path | Scope.Scope>,
) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const dir = yield* fs.makeTempDirectoryScoped({
        prefix: "flock-chat-turns-",
      });
      const seen: Seen = {
        prompts: [],
        contents: [],
        context: [],
        refusals: [],
        interrupts: [],
        sessions: [],
        servers: [],
        efforts: [],
        transcripts: new Map(opts.transcripts),
      };
      const read: string[] = [];
      if (opts.savedFile !== undefined)
        yield* fs.writeFileString(`${dir}/flock-chat.json`, opts.savedFile);
      const settings = opts.settings ?? { current: { proactive: opts.proactive } };
      const lists = opts.readers === undefined ? undefined : yield* harnessLists(opts.readers);
      const conversation = yield* openFlockChat({
        drivers: (context) => {
          const drivers: ScriptedDrivers = {
            claude: claudeDriver(
              failingFirst(scripted(seen, reply, opts.holds, opts.gate), opts.failedStarts ?? 0),
              context,
            ),
          };
          if (opts.pi !== undefined) drivers.pi = opts.pi(context);
          return { ...drivers, ...opts.drivers };
        },
        dir,
        conversation: "flock@mk-pc",
        machines: () => [machine(opts.items, read, opts.declared)],
        proactive: () => opts.proactive,
        machineRule: () => opts.rule ?? "Everything is on the vm",
        setMachineRule: () => Effect.void,
        inSync: () => Effect.succeed(""),
        choice: () => opensOn(settings.current, NO_FLOCK_SETTINGS, Effect.succeed({}), lists),
        offered: (harness) =>
          offerOf(harness, settings.current, NO_FLOCK_SETTINGS, Effect.succeed({}), lists),
        readModels: lists?.need,
        modelsChanged: lists?.changes.pipe(Stream.drop(1)),
        retold: opts.retold ?? Stream.empty,
        chatHarness: () => ({
          harness: settings.current.chatHarness ?? "claude",
          model: settings.current.chatModel,
          effort: settings.current.chatEffort,
        }),
        // As Desktop saves it: through the settings check.
        setChatHarness: ({ harness, model, effort }) =>
          Effect.sync(() => {
            const changed = changeSettings(settings.current, NO_FLOCK_SETTINGS, {
              ...(harness !== undefined && { chatHarness: harness }),
              ...(model !== undefined && { chatModel: model }),
              ...(effort !== undefined && { chatEffort: effort }),
            });
            if ("refused" in changed) return changed.refused;
            settings.current = changed;
            return null;
          }),
      });
      return yield* body({ conversation, seen, read, dir });
    }).pipe(Effect.scoped, Effect.provide([BunServices.layer, TestClock.layer()])),
  );

test("Desktop speaks first only about what matters, and the rest goes with the human's next message", () =>
  withChat(
    {
      items: [item("r1:asking", "decision"), item("r2:ended", "routine")],
      proactive: true,
    },
    answered,
    ({ conversation, seen, read, dir }) =>
      Effect.gen(function* () {
        yield* TestClock.adjust("3 seconds");
        yield* eventually(() => read.length === 1);
        expect(seen.prompts[0]).toStartWith(DESKTOP_SAID);
        expect(seen.prompts[0]).toContain("r1:asking happened.");
        expect(seen.prompts[0]).not.toContain("r2:ended");
        // Desktop's own turn knows where work goes, as the human's would.
        expect(seen.context[0]).toContain("Everything is on the vm");
        expect(read).toEqual(["r1:asking"]);
        // Nobody is there to click an answer, so the question is refused rather than waited on.
        expect(seen.refusals).toEqual(seen.prompts.slice(0, 1));
        const fs = yield* FileSystem.FileSystem;
        // Recorded once the turn has drained, after its News was marked read.
        for (let tries = 0; tries < 200 && !(yield* fs.exists(`${dir}/flock-usage.jsonl`)); tries++)
          yield* TestClock.withLive(Effect.sleep("10 millis"));
        const usage = yield* fs.readFileString(`${dir}/flock-usage.jsonl`);
        expect(usage.trim().split("\n")).toHaveLength(1);
        expect(Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Json))(usage)).toMatchObject({
          turn: "desktop",
          harness: "claude",
          model: "opus",
          usage: { input_tokens: 10, output_tokens: 20 },
        });

        yield* Stream.runDrain(conversation.send("what's new?", null, false));
        expect(seen.prompts[1]).toBe("what's new?");
        expect(seen.context[1]).toContain("r2:ended happened.");
        expect(seen.context[1]).not.toContain("r1:asking");
        yield* eventually(() => read.includes("r2:ended"));
      }),
  ));

test("a rule left blank adds nothing to a turn", () =>
  withChat({ items: [], proactive: false, rule: "  \n" }, answered, ({ conversation, seen }) =>
    Effect.gen(function* () {
      yield* Stream.runDrain(conversation.send("start a review", null, false));
      expect(seen.context).toEqual([""]);
    }),
  ));

test("a message sent about a card carries Desktop's note of it after the words, and one about none is sent as before", () =>
  withChat({ items: [], proactive: false }, answered, ({ conversation, seen, dir }) =>
    Effect.gen(function* () {
      const about = { machine: "vm-mk", task: "t-1", run: "r-2", name: "Fix board bugs" };
      yield* Stream.runDrain(conversation.send("what is this one doing?", about, false));
      expect(seen.contents[0]).toEqual([
        { type: "text", text: "what is this one doing?" },
        { type: "text", text: aboutNote(about) },
      ]);
      expect(seen.context[0]).not.toContain("Fix board bugs");

      const shot = yield* staged(dir, "shot.png", "image/png", new Uint8Array([1, 2, 3]));
      yield* Stream.runDrain(conversation.send("and this?", about, false, [shot.id]));
      expect(seen.contents[1]).toEqual([
        { type: "text", text: "and this?" },
        { type: "text", text: aboutNote(about) },
        { type: "text", text: listing([shot]) },
      ]);

      yield* Stream.runDrain(conversation.send("and now?", null, false));
      expect(seen.contents[2]).toBe("and now?");
    }),
  ));

test("a message sent now interrupts the turn under way, even Desktop's own, and starts the next", () =>
  withChat(
    {
      items: [item("r1:asking", "decision")],
      proactive: true,
      holds: (text) => text.startsWith(DESKTOP_SAID),
    },
    answered,
    ({ conversation, seen }) =>
      Effect.gen(function* () {
        yield* TestClock.adjust("3 seconds");
        yield* eventually(() => seen.prompts.length === 1);
        expect(seen.interrupts).toEqual([]);

        const pushed = yield* Stream.runCollect(
          conversation.send("figure it out yourself", null, true),
        );
        expect(seen.interrupts).toEqual(["interrupt"]);
        expect(seen.prompts[1]).toBe("figure it out yourself");
        expect(pushed.at(-1)).toMatchObject({ type: "RUN_FINISHED" });
      }),
  ));

test("with the switch off, Desktop starts no turn of its own", () =>
  withChat(
    { items: [item("r1:asking", "decision")], proactive: false },
    answered,
    ({ seen, read }) =>
      Effect.gen(function* () {
        yield* TestClock.adjust("3 seconds");
        yield* TestClock.withLive(Effect.sleep("100 millis"));
        expect(seen.prompts).toEqual([]);
        expect(read).toEqual([]);
      }),
  ));

test("a turn that fails before the model's first word ends, leaves its News waiting, and the next one is taken", () =>
  withChat(
    { items: [item("r2:ended", "routine")], proactive: false },
    (text) =>
      text === "first"
        ? [
            {
              type: "result",
              subtype: "success",
              is_error: true,
              result: "API Error: rate limited",
            },
          ]
        : answered(text),
    ({ conversation, seen, read }) =>
      Effect.gen(function* () {
        const first = yield* Stream.runCollect(conversation.send("first", null, false));
        expect(first.at(-1)).toMatchObject({
          type: "RUN_ERROR",
          message: "API Error: rate limited",
        });
        yield* TestClock.withLive(Effect.sleep("50 millis"));
        expect(read).toEqual([]);
        const second = yield* Stream.runCollect(conversation.send("second", null, false));
        expect(second.at(-1)).toMatchObject({ type: "RUN_FINISHED" });
        expect(seen.prompts).toEqual(["first", "second"]);
        expect(seen.context[1]).toContain("r2:ended happened.");
        yield* eventually(() => read.includes("r2:ended"));
      }),
  ));

test("News a failed turn of Desktop's carried waits for the next look, and wakes it", () => {
  let failures = 1;
  return withChat(
    { items: [item("r1:asking", "decision")], proactive: true },
    (text) =>
      failures-- > 0
        ? [{ type: "result", subtype: "success", is_error: true, result: "Overloaded" }]
        : answered(text),
    ({ seen, read }) =>
      Effect.gen(function* () {
        yield* TestClock.adjust("3 seconds");
        yield* eventually(() => seen.prompts.length === 1);
        yield* TestClock.withLive(Effect.sleep("50 millis"));
        expect(read).toEqual([]);
        // Not again at the next nudge, which would retry a rate-limited seat every few seconds.
        yield* TestClock.adjust("3 seconds");
        yield* TestClock.withLive(Effect.sleep("50 millis"));
        expect(seen.prompts).toHaveLength(1);
        yield* TestClock.adjust("2 minutes");
        yield* eventually(() => read.includes("r1:asking"));
        expect(seen.prompts).toHaveLength(2);
        expect(seen.prompts[1]).toContain("r1:asking happened.");
      }),
  );
});

/** Staged as the view stages it: in parts, the last of which answers the descriptor. */
const staged = (
  dir: string,
  name: string,
  mediaType: string,
  bytes: Uint8Array,
  scaledOf?: string,
) =>
  Effect.gen(function* () {
    const key = `${name.replaceAll(".", "-")}-${scaledOf === undefined ? "original" : "scaled"}`;
    const half = Math.ceil(bytes.length / 2);
    const first = yield* stageAttachment(dir, {
      key,
      name,
      mediaType,
      size: bytes.length,
      offset: 0,
      content: Buffer.from(bytes.subarray(0, half)).toString("base64"),
      scaledOf,
    });
    expect(first).toBeNull();
    const last = yield* stageAttachment(dir, {
      key,
      name,
      mediaType,
      size: bytes.length,
      offset: half,
      content: Buffer.from(bytes.subarray(half)).toString("base64"),
      scaledOf,
    });
    return last!;
  });

test("a message with an image hands the SDK the words, Desktop's listing and the scaled image, and says only the words", () => {
  const declared: Declaration[] = [];
  return withChat(
    { items: [item("r1:ended", "routine")], proactive: false, declared },
    answered,
    ({ conversation, seen, read, dir }) =>
      Effect.gen(function* () {
        const original = new TextEncoder().encode("a very large png");
        const shot = yield* staged(dir, "shot.png", "image/png", original);
        expect(shot).toMatchObject({ name: "shot.png", size: 16, mediaType: "image/png" });
        expect(shot.path).toStartWith(`${dir}/attachments/`);
        expect(yield* (yield* FileSystem.FileSystem).readFile(shot.path)).toEqual(original);
        // A PNG's header is all Desktop reads to know an image is within 2000 px.
        const smaller = new Uint8Array(24);
        smaller.set([0x89, 0x50, 0x4e, 0x47, 13, 10, 26, 10, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
        new DataView(smaller.buffer).setUint32(16, 2000);
        new DataView(smaller.buffer).setUint32(20, 1500);
        yield* staged(dir, "shot.png", "image/png", smaller, shot.id);

        yield* Stream.runDrain(conversation.send("what is this?", null, false, [shot.id]));
        expect(seen.contents[0]).toEqual([
          { type: "text", text: "what is this?" },
          { type: "text", text: listing([shot]) },
          {
            type: "image",
            source: {
              type: "base64",
              media_type: "image/png",
              data: Buffer.from(smaller).toString("base64"),
            },
          },
        ]);
        // The News the turn carried is settled in the turn's voice: the words, and no file.
        yield* eventually(() => read.includes("r1:ended"));
        expect(declared.at(-1)?.said).toBe("what is this?");

        // Words are not needed, and a copy that is gone is said to be.
        yield* Stream.runDrain(conversation.send("", null, false, [shot.id]));
        expect(seen.contents[1]).toEqual([
          { type: "text", text: listing([shot]) },
          expect.objectContaining({ type: "image" }),
        ]);
        const gone = yield* Stream.runCollect(
          conversation.send("and this?", null, false, [`${"0".repeat(64)}/gone.png`]),
        );
        expect(gone).toEqual([expect.objectContaining({ type: "RUN_ERROR" })]);
      }),
  );
});

test("a message's files are inlined only while their base64 fits the request, and the rest go by name", () =>
  withChat({ items: [], proactive: false }, answered, ({ conversation, seen, dir }) =>
    Effect.gen(function* () {
      const pdfs = [];
      for (let n = 0; n < 5; n++)
        pdfs.push(
          yield* staged(dir, `part${n}.pdf`, "application/pdf", new Uint8Array(4 * 1024 * 1024)),
        );
      yield* Stream.runDrain(
        conversation.send(
          "read these",
          null,
          false,
          pdfs.map(({ id }) => id),
        ),
      );
      // Four 4 MB PDFs fit the 24 MB of base64; the fifth would not.
      expect(seen.contents[0]).toEqual([
        { type: "text", text: "read these" },
        { type: "text", text: listing(pdfs) },
        ...pdfs
          .slice(0, 4)
          .map(({ name }) => expect.objectContaining({ type: "document", title: name })),
      ]);
    }),
  ));

test("a PDF goes as a document, a small text as text headed with its name, and a large text, image or a zip only by name", () =>
  withChat({ items: [], proactive: false }, answered, ({ conversation, seen, dir }) =>
    Effect.gen(function* () {
      const bytes = (text: string) => new TextEncoder().encode(text);
      const pdf = yield* staged(dir, "spec.pdf", "application/pdf", bytes("%PDF-1.7 tiny"));
      const log = yield* staged(dir, "app.log", "text/plain", bytes("one\ntwo\n"));
      const big = yield* staged(dir, "big.txt", "text/plain", bytes("x".repeat(100 * 1024 + 1)));
      const zip = yield* staged(dir, "trace.zip", "application/zip", bytes("PK\u0003\u0004"));
      const gif = yield* staged(dir, "rec.gif", "image/gif", new Uint8Array(4 * 1024 * 1024));

      yield* Stream.runDrain(
        conversation.send("look", null, false, [pdf.id, log.id, big.id, zip.id, gif.id]),
      );
      expect(seen.contents[0]).toEqual([
        { type: "text", text: "look" },
        { type: "text", text: listing([pdf, log, big, zip, gif]) },
        {
          type: "document",
          source: {
            type: "base64",
            media_type: "application/pdf",
            data: Buffer.from("%PDF-1.7 tiny").toString("base64"),
          },
          title: "spec.pdf",
        },
        { type: "text", text: "app.log:\n\none\ntwo\n" },
      ]);
    }),
  ));

test("a session that fails as it starts is started again by the next message", () =>
  withChat({ items: [], proactive: false, failedStarts: 1 }, answered, ({ conversation, seen }) =>
    Effect.gen(function* () {
      const first = yield* Stream.runCollect(conversation.send("first", null, false));
      expect(first.at(-1)).toMatchObject({ type: "RUN_ERROR" });
      expect((yield* account(conversation)).runsOn).toBeNull();
      const second = yield* Stream.runCollect(conversation.send("second", null, false));
      expect(second.at(-1)).toMatchObject({ type: "RUN_FINISHED" });
      expect(seen.prompts).toEqual(["second"]);
      expect((yield* account(conversation)).runsOn).toEqual({
        harness: "claude",
        model: "opus",
        effort: "medium",
      });
    }),
  ));

test("a new subscriber to Desktop's turns is told the one under way", () =>
  withChat(
    {
      items: [item("r1:asking", "decision")],
      proactive: true,
      holds: (text) => text.startsWith(DESKTOP_SAID),
    },
    answered,
    ({ conversation, seen }) =>
      Effect.gen(function* () {
        const now = conversation.desktopTurns.pipe(Stream.take(1), Stream.runCollect);
        expect(yield* now).toEqual(["ended"]);
        yield* TestClock.adjust("3 seconds");
        yield* eventually(() => seen.prompts.length === 1);
        expect(yield* now).toEqual(["started"]);
      }),
  ));

test("unset, the chat runs opus; a model changed mid-turn waits for it, then the same conversation goes on on the new model", () => {
  const settings = { current: Schema.decodeUnknownSync(DesktopSettings)({ proactive: false }) };
  const gate = Deferred.makeUnsafe<void>();
  return withChat(
    { items: [], proactive: false, settings, gate },
    answered,
    ({ conversation, seen }) =>
      Effect.gen(function* () {
        const current = (yield* conversation.conversations).current;
        const slow = yield* Stream.runCollect(conversation.send("slow", null, false)).pipe(
          Effect.forkChild,
        );
        yield* eventually(() => seen.prompts.length === 1);
        settings.current = { proactive: false, chatModel: "sonnet" };
        yield* TestClock.withLive(Effect.sleep("50 millis"));
        expect(seen.interrupts).toEqual([]);
        expect(seen.sessions).toEqual([{ model: "opus", sessionId: current }]);
        Deferred.doneUnsafe(gate, Effect.void);
        expect((yield* Fiber.join(slow)).at(-1)).toMatchObject({ type: "RUN_FINISHED" });

        const next = yield* Stream.runCollect(conversation.send("next", null, false));
        expect(next.at(-1)).toMatchObject({ type: "RUN_FINISHED" });
        expect(seen.sessions).toEqual([
          { model: "opus", sessionId: current },
          { model: "sonnet", resume: current },
        ]);
        expect((yield* conversation.conversations).current).toBe(current);
        expect((yield* conversation.transcript).map(({ parts }) => parts)).toEqual([
          [{ type: "text", content: "slow" }],
          [{ type: "text", content: "next" }],
        ]);
        yield* Stream.runDrain(conversation.send("again", null, false));
        expect(seen.sessions).toHaveLength(2);
      }),
  );
});

test("an effort changed mid-turn waits for it, then the same conversation goes on at the new effort", () => {
  const settings = { current: Schema.decodeUnknownSync(DesktopSettings)({ proactive: false }) };
  const gate = Deferred.makeUnsafe<void>();
  return withChat(
    { items: [], proactive: false, settings, gate },
    answered,
    ({ conversation, seen }) =>
      Effect.gen(function* () {
        const current = (yield* conversation.conversations).current;
        const slow = yield* Stream.runCollect(conversation.send("slow", null, false)).pipe(
          Effect.forkChild,
        );
        yield* eventually(() => seen.prompts.length === 1);
        settings.current = { proactive: false, chatEffort: "high" };
        yield* TestClock.withLive(Effect.sleep("50 millis"));
        expect(seen.interrupts).toEqual([]);
        expect(seen.efforts).toEqual(["medium"]);
        Deferred.doneUnsafe(gate, Effect.void);
        expect((yield* Fiber.join(slow)).at(-1)).toMatchObject({ type: "RUN_FINISHED" });

        yield* Stream.runDrain(conversation.send("next", null, false));
        expect(seen.sessions).toEqual([
          { model: "opus", sessionId: current },
          { model: "opus", resume: current },
        ]);
        expect(seen.efforts).toEqual(["medium", "high"]);
      }),
  );
});

test("a model the harness does not take is said in the chat, and nothing is started", () =>
  withChat(
    {
      items: [],
      proactive: false,
      settings: { current: { proactive: false, chatModel: "gpt-6.1-sol" } },
    },
    answered,
    ({ conversation, seen }) =>
      Effect.gen(function* () {
        const said = yield* Stream.runCollect(conversation.send("hello", null, false));
        expect(said).toEqual([
          expect.objectContaining({
            type: "RUN_ERROR",
            message: expect.stringContaining('"gpt-6.1-sol" is not a model claude takes'),
          }),
        ]);
        expect(seen.sessions).toEqual([]);
      }),
  ));

test("the chat reports the model its conversation actually runs on, including the unset default", () =>
  withChat({ items: [], proactive: false }, answered, ({ conversation, seen }) =>
    Effect.gen(function* () {
      yield* Stream.runDrain(conversation.send("hello", null, false));
      const said = yield* callFlockTool(seen.flock!, "collie_chat_harness", {});
      expect(said).toContain("Its session runs on claude/opus at medium effort now.");
    }),
  ));

test("a conversation file from before harnesses is claude's, resumed as before, and kept with its harness", () =>
  withChat(
    {
      items: [],
      proactive: false,
      savedFile: '{"session":"5c1e6c8e-0000-4000-8000-000000000000"}',
      transcripts: [
        [
          "5c1e6c8e-0000-4000-8000-000000000000",
          [
            {
              type: "user",
              uuid: "old",
              parent_tool_use_id: null,
              message: { role: "user", content: "before the change" },
            },
          ],
        ],
      ],
    },
    answered,
    ({ conversation, seen, dir }) =>
      Effect.gen(function* () {
        expect((yield* conversation.conversations).current).toBe(
          "5c1e6c8e-0000-4000-8000-000000000000",
        );
        yield* Stream.runDrain(conversation.send("hello", null, false));
        expect(seen.sessions).toEqual([
          { model: "opus", resume: "5c1e6c8e-0000-4000-8000-000000000000" },
        ]);
        expect(seen.servers).toEqual([["linear-server", "collie"]]);
        expect((yield* conversation.transcript).map(({ parts }) => parts)).toEqual([
          [{ type: "text", content: "before the change" }],
          [{ type: "text", content: "hello" }],
        ]);
        yield* conversation.reopen({
          session: "5c1e6c8e-0000-4000-8000-000000000000",
          harness: "claude",
        });
        const fs = yield* FileSystem.FileSystem;
        expect(
          Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Json))(
            yield* fs.readFileString(`${dir}/flock-chat.json`),
          ),
        ).toEqual({
          session: "5c1e6c8e-0000-4000-8000-000000000000",
          harness: "claude",
        });
      }),
  ));

test("a harness change saved mid-turn waits for the next message, which starts a new conversation on Pi", () => {
  const settings = { current: { proactive: false, chatHarness: "claude" } };
  const gate = Deferred.makeUnsafe<void>();
  const pi = fakeDriver([{ session: "pi-earlier", title: "Pi before", at: 5 }]);
  return withChat(
    { items: [], proactive: false, settings, gate, drivers: { pi: pi.driver } },
    answered,
    ({ conversation, seen, dir }) =>
      Effect.gen(function* () {
        const first = (yield* conversation.conversations).current;
        const slow = yield* Stream.runCollect(conversation.send("slow", null, false)).pipe(
          Effect.forkChild,
        );
        yield* eventually(() => seen.prompts.length === 1);
        expect(yield* callFlockTool(seen.flock!, "collie_chat_harness", { harness: "pi" })).toBe(
          "The Flock chat is now set to pi, with no model set, so it runs as pi's own default model, with no effort set, so it runs at medium. It applies with the next message.",
        );
        yield* Deferred.succeed(gate, undefined);
        expect((yield* Fiber.join(slow)).at(-1)).toMatchObject({ type: "RUN_FINISHED" });
        yield* TestClock.withLive(Effect.sleep("50 millis"));

        expect(seen.interrupts).toEqual([]);
        expect((yield* conversation.conversations).current).toBe(first);
        expect((yield* conversation.transcript).map(({ parts }) => parts)).toEqual([
          [{ type: "text", content: "slow" }],
        ]);
        expect((yield* conversation.conversations).earlier).toEqual([
          { session: "pi-earlier", title: "Pi before", at: 5, harness: "pi" },
        ]);
        expect(pi.opened).toEqual([]);

        yield* Stream.runDrain(conversation.send("Pi turn", null, false));
        const second = (yield* conversation.conversations).current;
        expect(second).not.toBe(first);
        expect(pi.opened).toEqual([second]);
        const fs = yield* FileSystem.FileSystem;
        expect(
          Schema.decodeUnknownSync(SESSION_FILE)(
            yield* fs.readFileString(`${dir}/flock-chat.json`),
          ),
        ).toEqual({ session: second, harness: "pi" });
        expect(seen.sessions).toHaveLength(1);
      }),
  );
});

test("a conversation saved on Claude Code is kept while the settings name Pi, until the next message", () => {
  const pi = fakeDriver([]);
  return withChat(
    {
      items: [],
      proactive: false,
      settings: { current: { proactive: false, chatHarness: "pi" } },
      savedFile: '{"session":"claude-kept","harness":"claude"}',
      transcripts: [
        [
          "claude-kept",
          [
            {
              type: "user",
              uuid: "old",
              parent_tool_use_id: null,
              message: { role: "user", content: "on Claude Code" },
            },
          ],
        ],
      ],
      drivers: { pi: pi.driver },
    },
    answered,
    ({ conversation, seen }) =>
      Effect.gen(function* () {
        expect((yield* conversation.conversations).current).toBe("claude-kept");
        expect((yield* conversation.transcript).map(({ parts }) => parts)).toEqual([
          [{ type: "text", content: "on Claude Code" }],
        ]);
        yield* Stream.runDrain(conversation.send("hello", null, false));
        const now = (yield* conversation.conversations).current;
        expect(now).not.toBe("claude-kept");
        expect(pi.opened).toEqual([now]);
        expect(seen.sessions).toEqual([]);
      }),
  );
});

test("a turn of Desktop's own about News, while a harness change waits, starts the new conversation on Pi", () => {
  const pi = fakeDriver([]);
  return withChat(
    {
      items: [item("r1:asking", "decision")],
      proactive: true,
      settings: { current: { proactive: true, chatHarness: "pi" } },
      savedFile: '{"session":"claude-kept","harness":"claude"}',
      drivers: { pi: pi.driver },
    },
    answered,
    ({ conversation, seen }) =>
      Effect.gen(function* () {
        expect((yield* conversation.conversations).current).toBe("claude-kept");
        yield* TestClock.adjust("3 seconds");
        yield* eventually(() => pi.opened.length === 1);
        const now = (yield* conversation.conversations).current;
        expect(now).not.toBe("claude-kept");
        expect(pi.opened).toEqual([now]);
        expect(seen.sessions).toEqual([]);
      }),
  );
});

test("Earlier conversations merges every installed harness's, newest first, ten at most, without the current one", () => {
  const claude = fakeDriver([
    { session: "current", title: "Now", at: 100 },
    { session: "c1", title: "C1", at: 90 },
    { session: "c2", title: "C2", at: 70 },
    { session: "c3", title: "C3", at: 50 },
    { session: "c4", title: "C4", at: 30 },
    { session: "c5", title: "C5", at: 10 },
    { session: "c6", title: "C6", at: 5 },
  ]);
  const pi = fakeDriver([
    { session: "p1", title: "P1", at: 80 },
    { session: "p2", title: "P2", at: 60 },
    { session: "p3", title: "P3", at: 40 },
    { session: "p4", title: "P4", at: 20 },
    { session: "p5", title: "P5", at: 1 },
  ]);
  const missing: ChatDriver = {
    installed: false,
    open: () => Effect.die("must not open"),
    transcript: () => Effect.die("must not be asked"),
    earlier: () => Effect.die("must not be asked"),
    transcriptPath: () => Effect.succeed(null),
  };
  return withChat(
    {
      items: [],
      proactive: false,
      savedFile: '{"session":"current","harness":"claude"}',
      drivers: { claude: claude.driver, pi: pi.driver, codex: missing },
    },
    answered,
    ({ conversation }) =>
      Effect.gen(function* () {
        expect(yield* conversation.conversations).toEqual({
          current: "current",
          earlier: [
            { session: "c1", title: "C1", at: 90, harness: "claude" },
            { session: "p1", title: "P1", at: 80, harness: "pi" },
            { session: "c2", title: "C2", at: 70, harness: "claude" },
            { session: "p2", title: "P2", at: 60, harness: "pi" },
            { session: "c3", title: "C3", at: 50, harness: "claude" },
            { session: "p3", title: "P3", at: 40, harness: "pi" },
            { session: "c4", title: "C4", at: 30, harness: "claude" },
            { session: "p4", title: "P4", at: 20, harness: "pi" },
            { session: "c5", title: "C5", at: 10, harness: "claude" },
            { session: "c6", title: "C6", at: 5, harness: "claude" },
          ],
        });
      }),
  );
});

test("an earlier conversation on the set harness is reopened on it, with the settings as they were", () => {
  const settings = {
    current: Schema.decodeUnknownSync(DesktopSettings)({
      proactive: false,
      chatHarness: "claude",
      chatModel: "sonnet",
      chatEffort: "high",
    }),
  };
  return withChat(
    {
      items: [],
      proactive: false,
      settings,
      transcripts: [
        [
          "claude-earlier",
          [
            {
              type: "user",
              uuid: "old",
              parent_tool_use_id: null,
              message: { role: "user", content: "earlier on Claude Code" },
            },
          ],
        ],
      ],
    },
    answered,
    ({ conversation, seen }) =>
      Effect.gen(function* () {
        yield* conversation.reopen({ session: "claude-earlier", harness: "claude" });
        expect((yield* conversation.conversations).current).toBe("claude-earlier");
        expect((yield* conversation.transcript).map(({ parts }) => parts)).toEqual([
          [{ type: "text", content: "earlier on Claude Code" }],
        ]);
        expect(settings.current).toEqual({
          proactive: false,
          chatHarness: "claude",
          chatModel: "sonnet",
          chatEffort: "high",
        });
        yield* Stream.runDrain(conversation.send("again", null, false));
        expect(seen.sessions).toEqual([{ model: "sonnet", resume: "claude-earlier" }]);
      }),
  );
});

test("reopening another harness's conversation moves the chat to that harness and holds it, and Start fresh stays on the set harness", () => {
  const settings = {
    current: Schema.decodeUnknownSync(DesktopSettings)({
      proactive: false,
      chatHarness: "claude",
      chatModel: "sonnet",
      chatEffort: "high",
    }),
  };
  const pi = fakeDriver([{ session: "pi-earlier", title: "Pi before", at: 5 }], {
    "pi-earlier": [said("pi-1", "Pi before")],
  });
  return withChat(
    { items: [], proactive: false, settings, drivers: { pi: pi.driver } },
    answered,
    ({ conversation, seen, dir }) =>
      Effect.gen(function* () {
        yield* conversation.reopen({ session: "pi-earlier", harness: "pi" });
        expect(settings.current).toEqual({ proactive: false, chatHarness: "pi" });
        expect((yield* conversation.conversations).current).toBe("pi-earlier");
        expect(yield* conversation.transcript).toEqual([said("pi-1", "Pi before")]);
        yield* Stream.runDrain(conversation.send("on Pi", null, false));
        expect(pi.opened).toEqual(["pi-earlier"]);
        expect((yield* conversation.conversations).current).toBe("pi-earlier");

        yield* conversation.reopen(null);
        const fresh = (yield* conversation.conversations).current;
        expect(fresh).not.toBe("pi-earlier");
        expect(settings.current).toEqual({ proactive: false, chatHarness: "pi" });
        const fs = yield* FileSystem.FileSystem;
        expect(
          Schema.decodeUnknownSync(SESSION_FILE)(
            yield* fs.readFileString(`${dir}/flock-chat.json`),
          ),
        ).toEqual({ session: fresh, harness: "pi" });
        yield* Stream.runDrain(conversation.send("fresh", null, false));
        expect(pi.opened).toEqual(["pi-earlier", fresh]);
        expect(seen.sessions).toEqual([]);
      }),
  );
});

test("Pi missing from this computer refuses the message without launching a session", () =>
  withChat(
    {
      items: [],
      proactive: false,
      settings: { current: { proactive: false, chatHarness: "pi" } },
      pi: () => ({
        installed: false,
        open: () => Effect.die("must not open"),
        transcript: () => Effect.succeed([]),
        earlier: () => Effect.succeed([]),
        transcriptPath: () => Effect.succeed(null),
      }),
    },
    answered,
    ({ conversation }) =>
      Effect.gen(function* () {
        expect(yield* Stream.runCollect(conversation.send("hello", null, false))).toEqual([
          {
            type: "RUN_ERROR",
            runId: "",
            message: "pi is not installed or not on PATH on this computer",
          },
        ]);
      }),
  ));

test("Desktop's own turn on Pi records its harness, model and token counts", () =>
  withChat(
    {
      items: [item("r1:asking", "decision")],
      proactive: true,
      settings: {
        current: { proactive: true, chatHarness: "pi", chatModel: "openai-codex/gpt-6.1-sol" },
      },
      pi: (context) => ({
        installed: true,
        open: (id) =>
          Effect.gen(function* () {
            const events = yield* Queue.unbounded<AguiEvent>();
            let result: TurnCost | undefined;
            return {
              conversation: () => id,
              offer: (content) =>
                Effect.gen(function* () {
                  expect(content).toStartWith(DESKTOP_SAID);
                  expect(context.flock.said()).toBeUndefined();
                  result = {
                    duration_ms: 10,
                    usage: {
                      input_tokens: 12,
                      output_tokens: 7,
                      cache_read_input_tokens: 4,
                      cache_creation_input_tokens: 0,
                    },
                  };
                  yield* Queue.offerAll(events, [
                    { type: "TEXT_MESSAGE_START", messageId: "reply", role: "assistant" },
                    { type: "RUN_FINISHED", threadId: id, runId: id },
                  ]);
                }),
              events: Stream.fromQueue(events),
              interrupt: Effect.void,
              close: Effect.void,
              lastTurn: () => result,
              limited: () => false,
            };
          }),
        transcript: () => Effect.succeed([]),
        earlier: () => Effect.succeed([]),
        transcriptPath: () => Effect.succeed(null),
      }),
    },
    answered,
    ({ conversation, dir }) =>
      Effect.gen(function* () {
        const ended = yield* conversation.desktopTurns.pipe(
          Stream.drop(1),
          Stream.filter((state) => state === "ended"),
          Stream.take(1),
          Stream.runDrain,
          Effect.forkChild,
        );
        yield* TestClock.adjust("3 seconds");
        yield* Fiber.join(ended);
        const fs = yield* FileSystem.FileSystem;
        for (let tries = 0; tries < 200 && !(yield* fs.exists(`${dir}/flock-usage.jsonl`)); tries++)
          yield* TestClock.withLive(Effect.sleep("10 millis"));
        const usage = yield* fs.readFileString(`${dir}/flock-usage.jsonl`);
        expect(Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Json))(usage)).toMatchObject({
          turn: "desktop",
          harness: "pi",
          model: "openai-codex/gpt-6.1-sol",
          usage: {
            input_tokens: 12,
            output_tokens: 7,
            cache_read_input_tokens: 4,
            cache_creation_input_tokens: 0,
          },
        });
      }),
  ));

const account = (conversation: Effect.Success<ReturnType<typeof openFlockChat>>) =>
  conversation.choices.pipe(Stream.runHead, Effect.map(Option.getOrThrow));

test("the account says a turn is under way only while one is, Desktop's own or the human's", () => {
  const gate = Deferred.makeUnsafe<void>();
  return withChat(
    {
      items: [item("r1:asking", "decision")],
      proactive: true,
      holds: (text) => text.startsWith(DESKTOP_SAID),
      gate,
    },
    answered,
    ({ conversation, seen }) =>
      Effect.gen(function* () {
        const told: boolean[] = [];
        yield* conversation.choices.pipe(
          Stream.runForEach(({ turning }) =>
            Effect.sync(() => {
              if (told.at(-1) !== turning) told.push(turning);
            }),
          ),
          Effect.forkChild,
        );
        yield* eventually(() => told.length === 1);
        yield* TestClock.adjust("3 seconds");
        yield* eventually(() => seen.prompts.length === 1);
        yield* eventually(() => told.at(-1) === true);

        const slow = yield* Stream.runCollect(conversation.send("slow", null, true)).pipe(
          Effect.forkChild,
        );
        yield* eventually(() => seen.prompts.length === 2);
        expect(told.at(-1)).toBe(true);
        Deferred.doneUnsafe(gate, Effect.void);
        yield* Fiber.join(slow);
        yield* eventually(() => told.at(-1) === false);
        expect(told).toEqual([false, true, false, true, false]);
      }),
  );
});

test("runsOn is null until a session opens, then what the driver was opened with, an unset model and effort resolved", () =>
  withChat(
    {
      items: [],
      proactive: false,
      drivers: { pi: { ...fakeDriver([]).driver, installed: false } },
    },
    answered,
    ({ conversation, seen }) =>
      Effect.gen(function* () {
        const before = yield* account(conversation);
        expect(before).toMatchObject({ heldOn: "claude", runsOn: null, turning: false });
        expect(
          before.harnesses.map(({ harness, label, installed, offered }) => ({
            harness,
            label,
            installed,
            from: offered.from,
          })),
        ).toEqual([
          { harness: "claude", label: "Claude Code", installed: true, from: "table" },
          { harness: "pi", label: "Pi", installed: false, from: "table" },
        ]);
        yield* Stream.runDrain(conversation.send("hello", null, false));
        expect((yield* account(conversation)).runsOn).toEqual({
          harness: "claude",
          model: "opus",
          effort: "medium",
        });
        expect(seen.sessions).toEqual([{ model: "opus", sessionId: expect.any(String) }]);
        expect(seen.efforts).toEqual(["medium"]);
      }),
  ));

test("heldOn changes with the next message after a harness change, not when the change is saved", () => {
  const settings = { current: { proactive: false, chatHarness: "claude" } };
  const pi = fakeDriver([]);
  return withChat(
    { items: [], proactive: false, settings, drivers: { pi: pi.driver } },
    answered,
    ({ conversation, seen }) =>
      Effect.gen(function* () {
        yield* Stream.runDrain(conversation.send("hello", null, false));
        yield* callFlockTool(seen.flock!, "collie_chat_harness", { harness: "pi" });
        expect(yield* account(conversation)).toMatchObject({
          heldOn: "claude",
          runsOn: { harness: "claude", model: "opus", effort: "medium" },
        });
        yield* Stream.runDrain(conversation.send("on Pi", null, false));
        expect(yield* account(conversation)).toMatchObject({
          heldOn: "pi",
          runsOn: { harness: "pi", model: "default", effort: "medium" },
        });
      }),
  );
});

test("the account is told again when Desktop retells it, with each harness's list as it is then", () => {
  const settings = { current: Schema.decodeUnknownSync(DesktopSettings)({ proactive: false }) };
  const retold = Effect.runSync(Queue.unbounded<void>());
  return withChat(
    { items: [], proactive: false, settings, retold: Stream.fromQueue(retold) },
    answered,
    ({ conversation }) =>
      Effect.gen(function* () {
        const told: ChatChoices[] = [];
        yield* conversation.choices.pipe(
          Stream.runForEach((choices) => Effect.sync(() => void told.push(choices))),
          Effect.forkChild,
        );
        yield* eventually(() => told.length === 1);
        settings.current = { proactive: false, chatModel: "claude-opus-5" };
        yield* Queue.offer(retold, undefined);
        yield* eventually(() => told.length === 2);
        const ids = (choices: ChatChoices) => {
          const offered = choices.harnesses[0]!.offered;
          return offered.from === "reading" ? [] : offered.models.map(({ id }) => id);
        };
        expect(ids(told[0]!)).not.toContain("claude-opus-5");
        expect(ids(told[1]!)).toContain("claude-opus-5");
      }),
  );
});

test("windows start the set harness's read, choosing another starts its read, and the chat tool retries a failed list", () => {
  const settings = { current: Schema.decodeUnknownSync(DesktopSettings)({ proactive: false }) };
  const changed = Effect.runSync(Queue.unbounded<void>());
  const reads = { claude: 0, pi: 0 };
  return withChat(
    {
      items: [],
      proactive: false,
      settings,
      drivers: { pi: fakeDriver([]).driver },
      retold: Stream.fromQueue(changed),
      readers: {
        claude: Effect.sync(() => {
          reads.claude++;
        }).pipe(
          Effect.andThen(Effect.sleep("2 seconds")),
          Effect.as([{ id: "opus", label: "Opus 5", efforts: [] }]),
        ),
        pi: Effect.suspend(() => {
          reads.pi++;
          return Effect.sleep("2 seconds").pipe(
            Effect.andThen(
              reads.pi === 1
                ? Effect.fail("Login expired")
                : Effect.succeed([
                    { id: "openai-codex/gpt-6.1-sol", label: "Sol", efforts: ["low", "high"] },
                  ]),
            ),
          );
        }),
      },
    },
    answered,
    ({ conversation, seen }) =>
      Effect.gen(function* () {
        expect(reads).toEqual({ claude: 0, pi: 0 });
        const told: ChatChoices[] = [];
        yield* conversation.choices.pipe(
          Stream.runForEach((choices) =>
            Effect.sync(() => {
              told.push(choices);
            }),
          ),
          Effect.forkScoped,
        );
        yield* eventually(() => told.length > 0 && reads.claude === 1);
        expect(told[0]!.harnesses[0]!.offered).toEqual({ from: "reading" });
        expect(reads).toEqual({ claude: 1, pi: 0 });
        yield* TestClock.adjust("2 seconds");
        yield* eventually(() => told.at(-1)?.harnesses[0]?.offered.from === "harness");
        yield* Stream.runDrain(conversation.send("hello", null, false));
        expect(seen.efforts).toEqual(["none"]);
        yield* account(conversation);
        expect(reads.claude).toBe(1);
        settings.current = { proactive: false, chatHarness: "pi" };
        yield* Queue.offer(changed, undefined);
        yield* eventually(() => reads.pi === 1);
        expect(told.at(-1)!.harnesses[1]!.offered).toEqual({ from: "reading" });
        yield* TestClock.adjust("2 seconds");
        yield* eventually(() => told.at(-1)?.harnesses[1]?.offered.from === "table");
        expect(told.at(-1)!.harnesses[1]!.offered).toMatchObject({
          from: "table",
          why: "Login expired",
        });
        expect(yield* callFlockTool(seen.flock!, "collie_chat_harness", {})).toContain(
          "pi's models are still being read",
        );
        yield* eventually(() => reads.pi === 2);
        expect(reads.pi).toBe(2);
        yield* TestClock.adjust("2 seconds");
        yield* eventually(() => told.at(-1)?.harnesses[1]?.offered.from === "harness");
        expect(reads).toEqual({ claude: 1, pi: 2 });
      }),
  );
});

test("a harness changed while the first message waits for its list applies to the following message", () => {
  const settings = { current: Schema.decodeUnknownSync(DesktopSettings)({ proactive: false }) };
  const pi = fakeDriver([]);
  return withChat(
    {
      items: [],
      proactive: false,
      settings,
      drivers: { pi: pi.driver },
      readers: {
        claude: Effect.sleep("2 seconds").pipe(
          Effect.as([{ id: "opus", label: "Opus 5", efforts: [] }]),
        ),
      },
    },
    answered,
    ({ conversation, seen }) =>
      Effect.gen(function* () {
        const first = yield* Stream.runDrain(conversation.send("first", null, false)).pipe(
          Effect.forkScoped,
        );
        yield* TestClock.adjust("1 second");
        expect(seen.sessions).toEqual([]);
        settings.current = { proactive: false, chatHarness: "pi" };
        yield* TestClock.adjust("1 second");
        yield* Fiber.join(first);
        expect(yield* account(conversation)).toMatchObject({
          heldOn: "claude",
          runsOn: { harness: "claude", model: "opus", effort: null },
        });
        yield* Stream.runDrain(conversation.send("next", null, false));
        expect(yield* account(conversation)).toMatchObject({
          heldOn: "pi",
          runsOn: { harness: "pi" },
        });
        expect(pi.opened).toHaveLength(1);
      }),
  );
});

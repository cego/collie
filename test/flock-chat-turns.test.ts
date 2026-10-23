// The Flock chat's turns, driven against a scripted Claude Code: one turn at a time, a turn
// of Desktop's own only about News that matters, and every turn ending however it ends.

import { expect, test } from "bun:test";
import { BunServices } from "@effect/platform-bun";
import { Crypto, Deferred, Effect, Fiber, FileSystem, Path, Schema, Stream, Queue } from "effect";
import { TestClock } from "effect/testing";
import { type Declaration, NewsBatch, PROTOCOL, type Significance } from "../src/board-model";
import { stageAttachment } from "../desktop/src/bun/attachments";
import { openFlockChat } from "../desktop/src/bun/chat";
import { type ClaudeCode, claudeDriver } from "../desktop/src/bun/claude-driver";
import type { AguiEvent } from "../desktop/src/shared/agui";
import type { TurnCost } from "../desktop/src/bun/driver";
import type { ChatDriver, DriverContext } from "../desktop/src/bun/driver";
import { changeSettings } from "../desktop/src/bun/settings";
import { chatChoicesOf, chatResolved } from "../desktop/src/bun/chat-choices";
import { harnessLists } from "../desktop/src/bun/harness-lists";
import type { ListedModel } from "../desktop/src/shared/chat-choices";
import { DesktopSettings } from "../desktop/src/shared/flock";
import { NO_FLOCK_SETTINGS } from "../desktop/src/shared/flock-settings";
import type { SdkMessage } from "../desktop/src/bun/agui";
import {
  callFlockTool,
  type ChatDoor,
  type ChatMachine,
  type FlockChat,
} from "../desktop/src/bun/flock-tools";
import { listing } from "../desktop/src/shared/attachments";
import { aboutNote, DESKTOP_SAID, type Earlier } from "../desktop/src/shared/chat-view";
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
  /** Each session's effort. */
  readonly efforts: Array<string | undefined>;
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
    seen.efforts.push(options.effort);
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

/** What Desktop's Settings have, which a test may change between turns. */
interface HeldSettings {
  current: DesktopSettings;
}

/** Each conversation Claude Code has, by id. */
type Transcripts = ReadonlyArray<readonly [string, unknown[]]>;

const withChat = <A, E>(
  opts: {
    readonly items: ReadonlyArray<Item>;
    readonly proactive: boolean;
    readonly holds?: (text: string) => boolean;
    readonly rule?: string;
    readonly declared?: Declaration[];
    readonly failedStarts?: number;
    /** What Desktop's Settings have, which a test may change between turns. */
    readonly settings?: HeldSettings;
    readonly pi?: (context: DriverContext) => ChatDriver;
    /** Every driver, in place of the scripted Claude Code and `pi`. */
    readonly drivers?: ScriptedDrivers;
    readonly gate?: Deferred.Deferred<void>;
    /** The current conversation's file, as an earlier Desktop left it. */
    readonly savedFile?: string;
    readonly transcripts?: Transcripts;
    /** Each harness's own list, read as Desktop reads it. */
    readonly readers?: Readonly<Record<string, Effect.Effect<ReadonlyArray<ListedModel>, string>>>;
  },
  reply: (text: string) => ReadonlyArray<SdkMessage>,
  body: (chat: {
    readonly conversation: Effect.Success<ReturnType<typeof openFlockChat>>;
    readonly seen: Seen;
    readonly read: string[];
    readonly dir: string;
  }) => Effect.Effect<A, E, Crypto.Crypto | FileSystem.FileSystem | Path.Path>,
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
      const lists = yield* harnessLists(opts.readers ?? {});
      const conversation = yield* openFlockChat({
        drivers: (context) => {
          if (opts.drivers !== undefined) return opts.drivers;
          const drivers: ScriptedDrivers = {
            claude: claudeDriver(
              failingFirst(scripted(seen, reply, opts.holds, opts.gate), opts.failedStarts ?? 0),
              context,
            ),
          };
          if (opts.pi !== undefined) drivers.pi = opts.pi(context);
          return drivers;
        },
        dir,
        conversation: "flock@mk-pc",
        machines: () => [machine(opts.items, read, opts.declared)],
        proactive: () => opts.proactive,
        machineRule: () => opts.rule ?? "Everything is on the vm",
        setMachineRule: () => Effect.void,
        inSync: () => Effect.succeed(""),
        resolve: () => chatResolved(settings.current, NO_FLOCK_SETTINGS, Effect.succeed({}), lists),
        choicesOf: (held, installed) =>
          Effect.succeed(chatChoicesOf(held, installed, settings.current, NO_FLOCK_SETTINGS, {})),
        chatHarness: () => ({
          harness: settings.current.chatHarness ?? "claude",
          model: settings.current.chatModel,
          effort: settings.current.chatEffort,
        }),
        // Saved as Desktop saves it, with Settings' checks.
        setChatHarness: ({ harness, model, effort }) =>
          Effect.sync(() => {
            const changed: Partial<Record<"chatHarness" | "chatModel" | "chatEffort", string>> = {};
            if (harness !== undefined) changed.chatHarness = harness;
            if (model !== undefined) changed.chatModel = model;
            if (effort !== undefined) changed.chatEffort = effort;
            const next = changeSettings(settings.current, NO_FLOCK_SETTINGS, changed);
            if ("refused" in next) return next.refused;
            settings.current = next;
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
      const second = yield* Stream.runCollect(conversation.send("second", null, false));
      expect(second.at(-1)).toMatchObject({ type: "RUN_FINISHED" });
      expect(seen.prompts).toEqual(["second"]);
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
        settings.current = { proactive: false, chatEffort: "max" };
        yield* TestClock.withLive(Effect.sleep("50 millis"));
        expect(seen.interrupts).toEqual([]);
        expect(seen.efforts).toEqual(["medium"]);
        Deferred.doneUnsafe(gate, Effect.void);
        expect((yield* Fiber.join(slow)).at(-1)).toMatchObject({ type: "RUN_FINISHED" });

        yield* Stream.runDrain(conversation.send("next", null, false));
        expect(seen.efforts).toEqual(["medium", "max"]);
        expect(seen.sessions).toEqual([
          { model: "opus", sessionId: current },
          { model: "opus", resume: current },
        ]);
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
      expect(said).toContain("its session runs on claude/opus at medium now.");
    }),
  ));

/** What the chat module holds now, as the account is told it. */
const heldNow = (conversation: Effect.Success<ReturnType<typeof openFlockChat>>) =>
  conversation.held.pipe(
    Stream.take(1),
    Stream.runCollect,
    Effect.map((told) => told[0]!),
  );

test("the chat holds a turn only while one is under way, a turn of Desktop's own included", () => {
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
        expect((yield* heldNow(conversation)).turning).toBe(false);
        yield* TestClock.adjust("3 seconds");
        yield* eventually(() => seen.prompts.length === 1);
        expect((yield* heldNow(conversation)).turning).toBe(true);
        yield* Stream.runDrain(conversation.send("now", null, true));
        expect((yield* heldNow(conversation)).turning).toBe(false);

        const slow = yield* Stream.runDrain(conversation.send("slow", null, false)).pipe(
          Effect.forkChild,
        );
        yield* eventually(() => seen.prompts.includes("slow"));
        expect((yield* heldNow(conversation)).turning).toBe(true);
        Deferred.doneUnsafe(gate, Effect.void);
        yield* Fiber.join(slow);
        expect((yield* heldNow(conversation)).turning).toBe(false);
      }),
  );
});

test("the chat runs on nothing until a session opens, then on exactly what it opened, each unset choice resolved", () => {
  const settings: HeldSettings = { current: { proactive: false } };
  return withChat({ items: [], proactive: false, settings }, answered, ({ conversation, seen }) =>
    Effect.gen(function* () {
      expect((yield* heldNow(conversation)).runsOn).toBeNull();
      yield* Stream.runDrain(conversation.send("hello", null, false));
      expect((yield* heldNow(conversation)).runsOn).toEqual({
        harness: "claude",
        model: "opus",
        effort: "medium",
      });
      expect(seen.sessions.map(({ model }) => model)).toEqual(["opus"]);
      expect(seen.efforts).toEqual(["medium"]);

      settings.current = { proactive: false, chatModel: "sonnet", chatEffort: "max" };
      yield* Stream.runDrain(conversation.send("again", null, false));
      expect((yield* heldNow(conversation)).runsOn).toEqual({
        harness: "claude",
        model: "sonnet",
        effort: "max",
      });
      expect(seen.efforts).toEqual(["medium", "max"]);
    }),
  );
});

test("the harness the chat is held on changes with the next message after a harness change, not when it is saved", () => {
  const settings: HeldSettings = { current: { proactive: false, chatHarness: "claude" } };
  return withChat(
    { items: [], proactive: false, settings, pi: fakePi([]) },
    answered,
    ({ conversation, seen }) =>
      Effect.gen(function* () {
        yield* Stream.runDrain(conversation.send("hello", null, false));
        expect((yield* heldNow(conversation)).heldOn).toBe("claude");
        yield* callFlockTool(seen.flock!, "collie_chat_harness", { harness: "pi" });
        expect((yield* heldNow(conversation)).heldOn).toBe("claude");
        yield* Stream.runDrain(conversation.send("Pi turn", null, false));
        expect(yield* heldNow(conversation)).toMatchObject({
          heldOn: "pi",
          runsOn: { harness: "pi", model: "default", effort: "medium" },
        });
      }),
  );
});

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

const PI_BEFORE = {
  id: "pi-earlier",
  role: "user" as const,
  parts: [{ type: "text" as const, content: "Pi before" }],
};

/** Pi with one earlier conversation, recording each conversation it opens and each message. */
const fakePi =
  (opened: string[], offered: unknown[] = []) =>
  (_context: DriverContext): ChatDriver => ({
    installed: true,
    open: (id) =>
      Effect.gen(function* () {
        opened.push(id);
        const events = yield* Queue.unbounded<AguiEvent>();
        return {
          conversation: () => id,
          offer: (content) =>
            Effect.sync(() => offered.push(content)).pipe(
              Effect.andThen(
                Queue.offer(events, { type: "RUN_FINISHED" as const, threadId: id, runId: id }),
              ),
              Effect.asVoid,
            ),
          events: Stream.fromQueue(events),
          interrupt: Effect.void,
          close: Effect.void,
          lastTurn: () => undefined,
          limited: () => false,
        };
      }),
    transcript: (id) => Effect.succeed(id === "pi-earlier" ? [PI_BEFORE] : []),
    earlier: () => Effect.succeed([{ session: "pi-earlier", title: "Pi before", at: 1 }]),
    transcriptPath: () => Effect.succeed(null),
  });

const heldIn = (dir: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    return Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Json))(
      yield* fs.readFileString(`${dir}/flock-chat.json`),
    );
  });

const CLAUDE_HELD = "5c1e6c8e-0000-4000-8000-000000000000";
const claudeTranscripts: Transcripts = [
  [
    CLAUDE_HELD,
    [
      {
        type: "user",
        uuid: "old",
        parent_tool_use_id: null,
        message: { role: "user", content: "on Claude Code" },
      },
    ],
  ],
];
/** Desktop as it was left with a conversation held on Claude Code. */
const claudeHeld = {
  savedFile: JSON.stringify({ session: CLAUDE_HELD, harness: "claude" }),
  transcripts: claudeTranscripts,
};

test("a harness change saved while a turn runs leaves that turn, its conversation and its history on Claude Code", () => {
  const settings = { current: { proactive: false, chatHarness: "claude" } };
  const gate = Deferred.makeUnsafe<void>();
  const opened: string[] = [];
  return withChat(
    { items: [], proactive: false, settings, gate, pi: fakePi(opened) },
    answered,
    ({ conversation, seen, dir }) =>
      Effect.gen(function* () {
        const first = (yield* conversation.conversations).current;
        const slow = yield* Stream.runCollect(conversation.send("slow", null, false)).pipe(
          Effect.forkChild,
        );
        yield* eventually(() => seen.prompts.length === 1);
        expect(
          yield* callFlockTool(seen.flock!, "collie_chat_harness", { harness: "pi" }),
        ).toContain("It applies with the next message.");
        yield* Deferred.succeed(gate, undefined);
        expect((yield* Fiber.join(slow)).at(-1)).toMatchObject({ type: "RUN_FINISHED" });
        yield* TestClock.withLive(Effect.sleep("50 millis"));

        expect(seen.interrupts).toEqual([]);
        expect(opened).toEqual([]);
        expect(yield* conversation.conversations).toEqual({
          current: first,
          earlier: [{ session: "pi-earlier", title: "Pi before", at: 1, harness: "pi" }],
        });
        expect((yield* conversation.transcript).map(({ parts }) => parts)).toEqual([
          [{ type: "text", content: "slow" }],
        ]);
        expect(yield* heldIn(dir)).toEqual({ session: first, harness: "claude" });
      }),
  );
});

test("the next message after a harness change opens Pi on a new conversation, and the chat is then held on Pi", () => {
  const settings = { current: { proactive: false, chatHarness: "claude" } };
  const opened: string[] = [];
  return withChat(
    { items: [], proactive: false, settings, pi: fakePi(opened) },
    answered,
    ({ conversation, seen, dir }) =>
      Effect.gen(function* () {
        yield* Stream.runDrain(conversation.send("hello", null, false));
        const first = (yield* conversation.conversations).current;
        yield* callFlockTool(seen.flock!, "collie_chat_harness", { harness: "pi" });

        expect(
          (yield* Stream.runCollect(conversation.send("Pi turn", null, false))).at(-1),
        ).toMatchObject({ type: "RUN_FINISHED" });
        const second = (yield* conversation.conversations).current;
        expect(second).not.toBe(first);
        expect(opened).toEqual([second]);
        expect(yield* heldIn(dir)).toEqual({ session: second, harness: "pi" });
        expect(yield* conversation.transcript).toEqual([]);
        expect((yield* conversation.conversations).earlier).toContainEqual(
          expect.objectContaining({ session: first, harness: "claude" }),
        );
      }),
  );
});

test("opened with a conversation held on Claude Code while the settings name Pi, the chat keeps it until the next message", () => {
  const opened: string[] = [];
  return withChat(
    {
      items: [],
      proactive: false,
      settings: { current: { proactive: false, chatHarness: "pi" } },
      pi: fakePi(opened),
      ...claudeHeld,
    },
    answered,
    ({ conversation, dir }) =>
      Effect.gen(function* () {
        expect((yield* conversation.conversations).current).toBe(CLAUDE_HELD);
        expect((yield* conversation.transcript).map(({ parts }) => parts)).toEqual([
          [{ type: "text", content: "on Claude Code" }],
        ]);
        expect(yield* heldIn(dir)).toEqual({ session: CLAUDE_HELD, harness: "claude" });

        yield* Stream.runDrain(conversation.send("hello", null, false));
        const now = (yield* conversation.conversations).current;
        expect(now).not.toBe(CLAUDE_HELD);
        expect(opened).toEqual([now]);
      }),
  );
});

test("a turn of Desktop's own about News, while a harness change waits, starts the new conversation as the human's message would", () => {
  const opened: string[] = [];
  const offered: unknown[] = [];
  return withChat(
    {
      items: [item("r1:asking", "decision")],
      proactive: true,
      settings: { current: { proactive: true, chatHarness: "pi" } },
      pi: fakePi(opened, offered),
      ...claudeHeld,
    },
    answered,
    ({ conversation, seen, dir }) =>
      Effect.gen(function* () {
        expect((yield* conversation.conversations).current).toBe(CLAUDE_HELD);
        yield* TestClock.adjust("3 seconds");
        yield* eventually(() => offered.length === 1);

        const now = (yield* conversation.conversations).current;
        expect(now).not.toBe(CLAUDE_HELD);
        expect(opened).toEqual([now]);
        expect(offered[0]).toStartWith(DESKTOP_SAID);
        expect(seen.sessions).toEqual([]);
        expect(yield* heldIn(dir)).toEqual({ session: now, harness: "pi" });
      }),
  );
});

/** A driver whose history is `earlier`, and that refuses to be asked when not installed. */
const historyOf = (earlier: ReadonlyArray<Earlier>, installed = true): ChatDriver => ({
  installed,
  open: () => Effect.die("not opened"),
  transcript: () => Effect.succeed([]),
  earlier: (limit) =>
    installed ? Effect.succeed(earlier.slice(0, limit)) : Effect.die("not installed, not asked"),
  transcriptPath: () => Effect.succeed(null),
});

test("Earlier conversations merges every installed harness's history, newest first, ten at most, without the current one", () => {
  const entries = (prefix: string, ats: ReadonlyArray<number>) =>
    ats.map((at) => ({ session: `${prefix}-${at}`, title: `${prefix} ${at}`, at }));
  return withChat(
    {
      items: [],
      proactive: false,
      savedFile: JSON.stringify({ session: "c-14", harness: "claude" }),
      drivers: {
        claude: historyOf(entries("c", [14, 12, 10, 8, 6, 4, 2])),
        pi: historyOf(entries("p", [13, 11, 9, 7, 5, 3, 1])),
        codex: historyOf(entries("x", [15]), false),
      },
    },
    answered,
    ({ conversation }) =>
      Effect.gen(function* () {
        const { current, earlier } = yield* conversation.conversations;
        expect(current).toBe("c-14");
        expect(earlier.map(({ session, harness }) => `${harness}:${session}`)).toEqual([
          "pi:p-13",
          "claude:c-12",
          "pi:p-11",
          "claude:c-10",
          "pi:p-9",
          "claude:c-8",
          "pi:p-7",
          "claude:c-6",
          "pi:p-5",
          "claude:c-4",
        ]);
      }),
  );
});

test("reopening a conversation on the set harness holds it there and resumes it with the next message", () => {
  const settings: HeldSettings = {
    current: { proactive: false, chatHarness: "claude", chatModel: "sonnet" },
  };
  return withChat(
    { items: [], proactive: false, settings, ...claudeHeld },
    answered,
    ({ conversation, seen, dir }) =>
      Effect.gen(function* () {
        yield* conversation.reopen(null);
        expect(yield* conversation.reopen({ session: CLAUDE_HELD, harness: "claude" })).toBeNull();
        expect(settings.current).toEqual({
          proactive: false,
          chatHarness: "claude",
          chatModel: "sonnet",
        });
        expect((yield* conversation.conversations).current).toBe(CLAUDE_HELD);
        expect(yield* heldIn(dir)).toEqual({ session: CLAUDE_HELD, harness: "claude" });
        yield* Stream.runDrain(conversation.send("hello", null, false));
        expect(seen.sessions).toEqual([{ model: "sonnet", resume: CLAUDE_HELD }]);
      }),
  );
});

test("reopening a conversation on another harness sets that harness, unsetting the model and effort, and holds that very conversation", () => {
  const settings: HeldSettings = {
    current: { proactive: false, chatHarness: "claude", chatModel: "sonnet", chatEffort: "high" },
  };
  const opened: string[] = [];
  return withChat(
    { items: [], proactive: false, settings, pi: fakePi(opened) },
    answered,
    ({ conversation, seen, dir }) =>
      Effect.gen(function* () {
        expect(yield* conversation.reopen({ session: "pi-earlier", harness: "pi" })).toBeNull();
        expect(settings.current).toEqual({ proactive: false, chatHarness: "pi" });
        expect((yield* conversation.conversations).current).toBe("pi-earlier");
        expect(yield* conversation.transcript).toEqual([PI_BEFORE]);
        expect(yield* heldIn(dir)).toEqual({ session: "pi-earlier", harness: "pi" });

        yield* Stream.runDrain(conversation.send("next", null, false));
        expect(opened).toEqual(["pi-earlier"]);
        expect((yield* conversation.conversations).current).toBe("pi-earlier");
        expect(seen.sessions).toEqual([]);
      }),
  );
});

test("Start fresh, while a harness change waits, starts a new conversation on the set harness", () => {
  const opened: string[] = [];
  return withChat(
    {
      items: [],
      proactive: false,
      settings: { current: { proactive: false, chatHarness: "pi" } },
      pi: fakePi(opened),
      ...claudeHeld,
    },
    answered,
    ({ conversation, dir }) =>
      Effect.gen(function* () {
        expect((yield* conversation.conversations).current).toBe(CLAUDE_HELD);
        expect(yield* conversation.reopen(null)).toBeNull();
        const fresh = (yield* conversation.conversations).current;
        expect(fresh).not.toBe(CLAUDE_HELD);
        expect(yield* heldIn(dir)).toEqual({ session: fresh, harness: "pi" });
        expect(yield* conversation.transcript).toEqual([]);
        yield* Stream.runDrain(conversation.send("hello", null, false));
        expect(opened).toEqual([fresh]);
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

const HAIKU = "claude-haiku-4-5-20251001";

test("the first message's session waits for Claude Code's list, and opens on what it says", () => {
  const listed = Deferred.makeUnsafe<ReadonlyArray<ListedModel>, string>();
  return withChat(
    {
      items: [],
      proactive: false,
      settings: { current: { proactive: false, chatModel: HAIKU } },
      readers: { claude: Deferred.await(listed) },
    },
    answered,
    ({ conversation, seen }) =>
      Effect.gen(function* () {
        const turn = yield* Stream.runDrain(conversation.send("hello", null, false)).pipe(
          Effect.forkChild,
        );
        yield* TestClock.adjust("10 seconds");
        yield* TestClock.withLive(Effect.sleep("50 millis"));
        expect(seen.sessions).toEqual([]);
        yield* Deferred.succeed(listed, [{ id: HAIKU, label: "Haiku 4.5", efforts: [] }]);
        yield* Fiber.join(turn);
        expect(seen.sessions.map(({ model }) => model)).toEqual([HAIKU]);
        expect(seen.efforts).toEqual([undefined]);
      }),
  );
});

test("a harness chosen while a session waits for its list holds the conversation on the harness that opens", () => {
  const listed = Deferred.makeUnsafe<ReadonlyArray<ListedModel>, string>();
  const settings: HeldSettings = { current: { proactive: false, chatHarness: "claude" } };
  const opened: string[] = [];
  return withChat(
    {
      items: [],
      proactive: false,
      settings,
      pi: fakePi(opened),
      readers: { claude: Deferred.await(listed) },
    },
    answered,
    ({ conversation, seen, dir }) =>
      Effect.gen(function* () {
        const turn = yield* Stream.runDrain(conversation.send("hello", null, false)).pipe(
          Effect.forkChild,
        );
        yield* TestClock.withLive(Effect.sleep("50 millis"));
        settings.current = { ...settings.current, chatHarness: "pi" };
        yield* Deferred.succeed(listed, []);
        yield* Fiber.join(turn);
        expect(seen.sessions).toHaveLength(1);
        expect(opened).toEqual([]);
        expect(yield* heldIn(dir)).toMatchObject({ harness: "claude" });
      }),
  );
});

test("a reply stopped while its session opens releases what the opening had taken", () => {
  const opening = Deferred.makeUnsafe<void>();
  const released: string[] = [];
  return withChat(
    {
      items: [],
      proactive: false,
      settings: { current: { proactive: false, chatHarness: "pi" } },
      pi: () => ({
        installed: true,
        open: (id) =>
          Effect.addFinalizer(() => Effect.sync(() => released.push(id))).pipe(
            Effect.andThen(Deferred.succeed(opening, undefined)),
            Effect.andThen(Effect.never),
          ),
        transcript: () => Effect.succeed([]),
        earlier: () => Effect.succeed([]),
        transcriptPath: () => Effect.succeed(null),
      }),
    },
    answered,
    ({ conversation }) =>
      Effect.gen(function* () {
        const turn = yield* Stream.runDrain(conversation.send("hello", null, false)).pipe(
          Effect.forkChild,
        );
        yield* Deferred.await(opening);
        yield* Fiber.interrupt(turn);
        expect(released).toHaveLength(1);
      }),
  );
});

test("a list slower than 20 seconds lets the first session open on Collie's table", () =>
  withChat(
    {
      items: [],
      proactive: false,
      settings: { current: { proactive: false, chatModel: HAIKU } },
      readers: { claude: Effect.never },
    },
    answered,
    ({ conversation, seen }) =>
      Effect.gen(function* () {
        const turn = yield* Stream.runDrain(conversation.send("hello", null, false)).pipe(
          Effect.forkChild,
        );
        yield* TestClock.adjust("19 seconds");
        yield* TestClock.withLive(Effect.sleep("50 millis"));
        expect(seen.sessions).toEqual([]);
        yield* TestClock.adjust("1 second");
        yield* Fiber.join(turn);
        // Off the table's list, Haiku 4.5 takes the table's efforts, so it runs at medium.
        expect(seen.efforts).toEqual(["medium"]);
      }),
  ));

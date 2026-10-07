// The Flock chat's turns, driven against a scripted Claude Code: one turn at a time, a turn
// of Desktop's own only about News that matters, and every turn ending however it ends.

import { expect, test } from "bun:test";
import { BunServices } from "@effect/platform-bun";
import { Deferred, Effect, FileSystem, Path, Stream } from "effect";
import { TestClock } from "effect/testing";
import { type Declaration, NewsBatch, PROTOCOL, type Significance } from "../src/board-model";
import { stageAttachment } from "../desktop/src/bun/attachments";
import { type ClaudeCode, openFlockChat } from "../desktop/src/bun/chat";
import type { SdkMessage } from "../desktop/src/bun/agui";
import type { ChatDoor, ChatMachine } from "../desktop/src/bun/flock-tools";
import { listing } from "../desktop/src/shared/attachments";
import { DESKTOP_SAID } from "../desktop/src/shared/chat-view";
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
    board: () =>
      Stream.make({
        _tag: "Snapshot" as const,
        installation: "i",
        build: "test",
        protocol: PROTOCOL,
        herds: [{ id: "h1" }],
        tasks: [],
        seq: 0,
      }).pipe(Stream.concat(Stream.never)),
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
  // SAFETY: the chat's turns reach a Machine only through board, declare and news.
  return { name: "vm-mk", door: door as ChatDoor };
};

interface Seen {
  readonly prompts: string[];
  /** Each message as the SDK was handed it. */
  readonly contents: unknown[];
  /** What each turn's message went with, as the UserPromptSubmit hook adds it. */
  readonly context: string[];
  readonly refusals: string[];
  /** Each time the session was interrupted. */
  readonly interrupts: string[];
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
): ClaudeCode<string> => ({
  query: ({ prompt, options }) => {
    const closed = Deferred.makeUnsafe<void>();
    let interrupted = Deferred.makeUnsafe<void>();
    const turns = Stream.fromAsyncIterable(prompt, String).pipe(
      Stream.interruptWhen(Deferred.await(closed)),
      Stream.mapEffect((message) =>
        Effect.gen(function* () {
          const text = isString(message.message.content) ? message.message.content : "";
          seen.prompts.push(text);
          seen.contents.push(message.message.content);
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
  getSessionInfo: () => Promise.resolve(undefined),
  getSessionMessages: () => Promise.resolve([]),
  listSessions: () => Promise.resolve([]),
  server: () => "collie",
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

const withChat = <A, E>(
  opts: {
    readonly items: ReadonlyArray<Item>;
    readonly proactive: boolean;
    readonly holds?: (text: string) => boolean;
    readonly rule?: string;
    readonly declared?: Declaration[];
  },
  reply: (text: string) => ReadonlyArray<SdkMessage>,
  body: (chat: {
    readonly conversation: Effect.Success<ReturnType<typeof openFlockChat<string>>>;
    readonly seen: Seen;
    readonly read: string[];
    readonly dir: string;
  }) => Effect.Effect<A, E, FileSystem.FileSystem | Path.Path>,
) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const dir = yield* fs.makeTempDirectoryScoped({
        prefix: "flock-chat-turns-",
      });
      const seen: Seen = { prompts: [], contents: [], context: [], refusals: [], interrupts: [] };
      const read: string[] = [];
      const conversation = yield* openFlockChat({
        claude: scripted(seen, reply, opts.holds),
        dir,
        conversation: "flock@mk-pc",
        machines: () => [machine(opts.items, read, opts.declared)],
        proactive: () => opts.proactive,
        machineRule: () => opts.rule ?? "Everything is on the vm",
        setMachineRule: () => Effect.void,
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
        yield* staged(dir, "shot.png", "image/png", new TextEncoder().encode("smaller"), shot.id);

        yield* Stream.runDrain(conversation.send("what is this?", null, false, [shot.id]));
        expect(seen.contents[0]).toEqual([
          { type: "text", text: "what is this?" },
          { type: "text", text: listing([shot]) },
          {
            type: "image",
            source: {
              type: "base64",
              media_type: "image/png",
              data: Buffer.from("smaller").toString("base64"),
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

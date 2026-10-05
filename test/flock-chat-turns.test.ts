// The Flock chat's turns, driven against a scripted Claude Code: one turn at a time, a turn
// of Desktop's own only about News that matters, and every turn ending however it ends.

import { expect, test } from "bun:test";
import { BunServices } from "@effect/platform-bun";
import { Deferred, Effect, FileSystem, Stream } from "effect";
import { TestClock } from "effect/testing";
import { NewsBatch, PROTOCOL, type Significance } from "../src/board-model";
import { type ClaudeCode, openFlockChat } from "../desktop/src/bun/chat";
import type { SdkMessage } from "../desktop/src/bun/agui";
import type { ChatDoor, ChatMachine } from "../desktop/src/bun/flock-tools";
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
const machine = (items: ReadonlyArray<Item>, read: string[]): ChatMachine => {
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
    declare: () => Effect.void,
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
  /** What each turn's message went with, as the UserPromptSubmit hook adds it. */
  readonly context: string[];
  readonly refusals: string[];
}

const SAID = { type: "stream_event", parent_tool_use_id: null };

/** Claude Code answering each message with `reply`'s messages. */
const scripted = (
  seen: Seen,
  reply: (text: string) => ReadonlyArray<SdkMessage>,
): ClaudeCode<string> => ({
  query: ({ prompt, options }) => {
    const closed = Deferred.makeUnsafe<void>();
    const turns = Stream.fromAsyncIterable(prompt, String).pipe(
      Stream.interruptWhen(Deferred.await(closed)),
      Stream.mapEffect((message) =>
        Effect.gen(function* () {
          const text = isString(message.message.content) ? message.message.content : "";
          seen.prompts.push(text);
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
          return reply(text);
        }),
      ),
      Stream.flatMap(Stream.fromIterable),
    );
    return Object.assign(Stream.toAsyncIterable(turns), {
      interrupt: () => Promise.resolve(),
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
  opts: { readonly items: ReadonlyArray<Item>; readonly proactive: boolean },
  reply: (text: string) => ReadonlyArray<SdkMessage>,
  body: (chat: {
    readonly conversation: Effect.Success<ReturnType<typeof openFlockChat<string>>>;
    readonly seen: Seen;
    readonly read: string[];
    readonly dir: string;
  }) => Effect.Effect<A, E, FileSystem.FileSystem>,
) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const dir = yield* fs.makeTempDirectoryScoped({
        prefix: "flock-chat-turns-",
      });
      const seen: Seen = { prompts: [], context: [], refusals: [] };
      const read: string[] = [];
      const conversation = yield* openFlockChat({
        claude: scripted(seen, reply),
        dir,
        conversation: "flock@mk-pc",
        machines: () => [machine(opts.items, read)],
        proactive: () => opts.proactive,
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
        expect(read).toEqual(["r1:asking"]);
        // Nobody is there to click an answer, so the question is refused rather than waited on.
        expect(seen.refusals).toEqual(seen.prompts.slice(0, 1));
        const usage = yield* (yield* FileSystem.FileSystem).readFileString(
          `${dir}/flock-usage.jsonl`,
        );
        expect(usage.trim().split("\n")).toHaveLength(1);

        yield* Stream.runDrain(conversation.send("what's new?", null));
        expect(seen.prompts[1]).toBe("what's new?");
        expect(seen.context[1]).toContain("r2:ended happened.");
        expect(seen.context[1]).not.toContain("r1:asking");
        yield* eventually(() => read.includes("r2:ended"));
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

test("a turn that fails before the model's first word ends, and the next one is taken", () =>
  withChat(
    { items: [], proactive: true },
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
    ({ conversation, seen }) =>
      Effect.gen(function* () {
        const first = yield* Stream.runCollect(conversation.send("first", null));
        expect(first.at(-1)).toMatchObject({
          type: "RUN_ERROR",
          message: "API Error: rate limited",
        });
        const second = yield* Stream.runCollect(conversation.send("second", null));
        expect(second.at(-1)).toMatchObject({ type: "RUN_FINISHED" });
        expect(seen.prompts).toEqual(["first", "second"]);
      }),
  ));

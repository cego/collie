// What the Flock chat's window says of a tool call and of the card a message is about.

import { expect, test } from "bun:test";
import { Deferred, Effect, Stream } from "effect";
import { ChatClient } from "../desktop/node_modules/@tanstack/ai-client";
import { stopDraft } from "../desktop/src/shared/chat-choices";
import { replyEvents } from "../desktop/src/shared/chat-stream";
import {
  aboutLine,
  aboutNote,
  earlierNote,
  fromAboutNote,
  toolRow,
} from "../desktop/src/shared/chat-view";

test("a tool call is its tool, the Machine it reached and what it was asked", () => {
  expect(
    toolRow(
      "mcp__collie__collie_do",
      JSON.stringify({
        actions: [
          { kind: "stop", run: "vm-mk:r-2" },
          { kind: "hold", run: "vm-mk:r-3", reason: "lunch" },
        ],
      }),
    ),
  ).toEqual({ tool: "do", machine: "vm-mk", summary: "stop r-2, hold r-3" });
  expect(
    toolRow("mcp__collie__collie_hold", JSON.stringify({ run: "mk-pc:r-1", reason: "lunch" })),
  ).toEqual({
    tool: "hold",
    machine: "mk-pc",
    summary: "r-1 · lunch",
  });
});

test("a call that names no Machine, or several, says so", () => {
  expect(toolRow("mcp__collie__collie_herd", "{}")).toEqual({
    tool: "herd",
    machine: null,
    summary: "",
  });
  expect(
    toolRow(
      "mcp__collie__collie_do",
      JSON.stringify({
        actions: [
          { kind: "stop", run: "a:r-1" },
          { kind: "stop", run: "b:r-1" },
        ],
      }),
    ).machine,
  ).toBe("a, b");
});

test("arguments still streaming are summarised as far as they go", () => {
  expect(toolRow("mcp__collie__collie_run", '{"run": "vm-')).toEqual({
    tool: "run",
    machine: null,
    summary: "",
  });
});

test("a card a message is about reads as its Machine and its name", () => {
  expect(
    aboutLine({
      machine: "vm-mk",
      task: "t-1",
      run: "r-2",
      name: "Fix board bugs",
    }),
  ).toBe("vm-mk › Fix board bugs");
});

test("Desktop's note of the card a message is about reads back as that card, and nothing else does", () => {
  const about = { machine: "vm-mk", task: "t-1", run: "r-2", name: 'Fix "board"\nbugs' };
  const note = aboutNote(about);
  expect(note.split("\n")[0]).toStartWith("[Desktop:");
  expect(fromAboutNote(note)).toEqual(about);
  expect(fromAboutNote("this one, please")).toBeNull();
  expect(fromAboutNote(`${note}\nand more`)).toBeNull();
  expect(fromAboutNote(note.replace('"t-1"', "1"))).toBeNull();
  expect(fromAboutNote(note.split("\n")[1]!)).toBeNull();
});

test("Earlier conversations ends by saying that opening another harness's conversation moves the chat to it", () => {
  const entry = (harness: string) => ({ session: harness, title: harness, at: 1, harness });
  const listed = [entry("claude"), entry("pi"), entry("claude")];
  expect(earlierNote(listed, "claude")).toBe("Opening a Pi conversation moves the chat to Pi.");
  expect(earlierNote(listed, "pi")).toBe(
    "Opening a Claude Code conversation moves the chat to Claude Code.",
  );
  expect(earlierNote([entry("claude")], "claude")).toBeNull();
  expect(earlierNote([...listed, entry("codex")], "claude")).toBe(
    "Opening a Pi or codex conversation moves the chat to its harness.",
  );
});

test("Stop drops a waiting reply reader after its queued draft is recovered, without starting another turn", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const started = Deferred.makeUnsafe<void>();
      const closed = Deferred.makeUnsafe<void>();
      let connections = 0;
      const client = new ChatClient({
        connection: {
          connect: (_messages, _body, signal) => {
            connections++;
            return replyEvents(
              Stream.fromEffect(Deferred.succeed(started, undefined)).pipe(
                Stream.drain,
                Stream.concat(Stream.never),
                Stream.ensuring(Deferred.succeed(closed, undefined)),
              ),
              signal,
            );
          },
        },
      });
      try {
        const sending = client.sendMessage("Start a reply");
        yield* Deferred.await(started).pipe(Effect.timeout("1 second"));
        yield* Effect.promise(() => client.sendMessage("First queued question"));
        yield* Effect.promise(() => client.sendMessage("Second queued question"));
        const recovered = stopDraft(client.getQueue(), { text: "Draft", files: [], about: null });
        client.stop();
        yield* Deferred.await(closed).pipe(Effect.timeout("1 second"));
        yield* Effect.promise(() => sending);
        expect(recovered.text).toBe("First queued question\n\nSecond queued question\n\nDraft");
        expect(client.getQueue()).toEqual([]);
        expect(connections).toBe(1);
        const alreadyStopped = AbortSignal.abort();
        const events = yield* Effect.promise(() =>
          Array.fromAsync(replyEvents(Stream.make("unwanted"), alreadyStopped)),
        );
        expect(events).toEqual([]);
      } finally {
        client.stop();
        client.unsubscribe();
      }
    }),
  ));

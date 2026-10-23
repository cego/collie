// What the Flock chat's window says of a tool call and of the card a message is about.

import { expect, test } from "bun:test";
import { Effect, Stream } from "effect";
import {
  aboutLine,
  aboutNote,
  announcement,
  type Heard,
  earlierMenu,
  fromAboutNote,
  putBack,
  submitButton,
  toolRow,
  untilAborted,
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

test("Earlier conversations names each entry's harness, and says opening one on another harness moves the chat there", () => {
  const claude = { session: "c-1", title: "Release blockers", at: 2, harness: "claude" };
  const pi = { session: "p-1", title: "Why did renovate fail?", at: 1, harness: "pi" };
  expect(earlierMenu({ current: "c-0", earlier: [claude, pi] }, "claude")).toEqual({
    entries: [
      { ...claude, label: "Claude Code" },
      { ...pi, label: "Pi" },
    ],
    moves: "Opening a Pi conversation moves the chat to Pi.",
  });
  expect(earlierMenu({ current: "c-0", earlier: [claude, pi] }, "pi").moves).toBe(
    "Opening a Claude Code conversation moves the chat to Claude Code.",
  );
  expect(earlierMenu({ current: "c-0", earlier: [claude] }, "claude").moves).toBeNull();
});

const CARD = { machine: "vm-mk", task: "t-1", run: "r-2", name: "Fix login redirect" };
const OTHER = { machine: "vm-ci", task: "t-9", run: "r-9", name: "Nightly build" };
const FILE = { id: "ab12/notes.md", name: "notes.md", size: 120, mediaType: "text/markdown" };
const SHOT = { id: "cd34/shot.png", name: "shot.png", size: 4096, mediaType: "image/png" };
const filePart = (file: typeof FILE) => ({
  type: "document",
  id: file.id,
  source: { type: "file", value: file.id, mimeType: file.mediaType },
  metadata: { name: file.name, size: file.size },
});

test("Stop puts the queued words back in the order they were queued, each a paragraph, before what is already typed", () => {
  const queued = [
    { content: "And what about vm-ci?" },
    { content: { content: [{ type: "text", content: "Line one\nline two" }] } },
    { content: "Then hold it." },
  ];
  expect(putBack(queued, "", null).draft).toBe(
    "And what about vm-ci?\n\nLine one\nline two\n\nThen hold it.",
  );
  expect(putBack(queued, "  already typed ", null).draft).toBe(
    "And what about vm-ci?\n\nLine one\nline two\n\nThen hold it.\n\nalready typed",
  );
});

test("Stop puts the queued files back with the attachments, and a queued card on an empty chip", () => {
  const queued = [
    { content: { content: [filePart(FILE)] } },
    { content: "plain" },
    {
      content: {
        content: [{ type: "text", content: "and this" }, filePart(SHOT)],
        metadata: { about: CARD },
      },
    },
    { content: { content: "later", metadata: { about: OTHER } } },
  ];
  const back = putBack(queued, "", null);
  expect(back.files).toEqual([FILE, SHOT]);
  expect(back.draft).toBe("plain\n\nand this\n\nlater");
  expect(back.chip).toEqual(CARD);
  expect(putBack(queued, "", OTHER).chip).toEqual(OTHER);
});

test("Stop with nothing queued leaves the message box as it is", () => {
  expect(putBack([], "half a thought", CARD)).toEqual({
    draft: "half a thought",
    files: [],
    chip: CARD,
  });
});

test("the submit button sends unless the human's reply is under way, when it stops it, and an error never makes it a retry", () => {
  expect(submitButton("ready")).toEqual({ status: "ready", label: "Send" });
  expect(submitButton("error")).toEqual({ status: "ready", label: "Send" });
  expect(submitButton("submitted")).toEqual({ status: "submitted", label: "Stop the reply" });
  expect(submitButton("streaming")).toEqual({ status: "streaming", label: "Stop the reply" });
});

test("the status region announces a reply starting, a Stop and each notice as it appears, and never a reply finishing", () => {
  const quiet = { replying: false, stopped: false, notice: null };
  const replying = { ...quiet, replying: true };
  const notice =
    "This reply finishes on Opus 5.5 · High. Your next message runs on Sonnet 5.5 · Medium.";
  const switched = "Your next message starts a new conversation on Pi.";
  /** What the region reads after each state in turn, as the window's watcher sets it. */
  const region = (states: ReadonlyArray<Heard>) => {
    let shown = "";
    const read: string[] = [];
    states.slice(1).forEach((now, at) => {
      shown = announcement(states[at]!, now) ?? shown;
      read.push(shown);
    });
    return read;
  };
  expect(
    region([
      quiet,
      replying,
      { ...replying, notice },
      { ...replying, notice },
      replying,
      { ...quiet, stopped: true },
      { ...quiet, stopped: true },
      { ...replying, notice: switched },
      quiet,
    ]),
  ).toEqual([
    "Replying…",
    notice,
    notice,
    "",
    "Reply stopped",
    "Reply stopped",
    `Replying… ${switched}`,
    "",
  ]);
  // Each start and each notice that comes back is a change the region announces again.
  expect(region([quiet, replying, quiet, replying])).toEqual(["Replying…", "", "Replying…"]);
  expect(region([replying, { ...replying, notice }, replying, { ...replying, notice }])).toEqual([
    notice,
    "",
    notice,
  ]);
});

test("a reply stopped before it starts never asks for the turn", () => {
  const stop = new AbortController();
  stop.abort();
  const asked = untilAborted(Stream.die("asked for the turn"), stop.signal);
  return expect(Array.fromAsync(Stream.toAsyncIterable(asked))).resolves.toEqual([]);
});

test("a reply stopped after it is asked for but before it runs never asks for the turn", () => {
  const stop = new AbortController();
  const asked = untilAborted(Stream.die("asked for the turn"), stop.signal);
  stop.abort();
  return expect(Array.fromAsync(Stream.toAsyncIterable(asked))).resolves.toEqual([]);
});

test("a reply stopped while its first part is awaited never asks for the turn", () => {
  const stop = new AbortController();
  let asked = false;
  const turn = untilAborted(
    Stream.fromEffect(Effect.promise(() => Promise.resolve())).pipe(
      Stream.flatMap(() =>
        Stream.fromEffect(
          Effect.sync(() => {
            asked = true;
            return "part";
          }),
        ),
      ),
    ),
    stop.signal,
  );
  const first = Stream.toAsyncIterable(turn)[Symbol.asyncIterator]().next();
  stop.abort();
  return first.then(({ done }) => {
    expect(done).toBe(true);
    expect(asked).toBe(false);
  });
});

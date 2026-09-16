#!/usr/bin/env bun
// What the Home's native chat actually does, against a running herdr and a real harness.
// Nothing about typing, global scope, follow-ups or resume may be called proven from a
// test with a fake adapter: a process that started is not an editor that took a keystroke.
//
//   bun run tools/chat-live.ts [--harness claude|pi] [--keep]
//
// It makes a **disposable** Herd: its own state and config directories, its own Home
// workspace, its own chat session. It never touches the state directory your Runs are in,
// and it closes what it opened unless you pass --keep. It costs real model calls.
//
// Seven questions, printed as markdown to paste into the implementation Run:
//   1. the Home is one tab of two panes, board left and chat right
//   2. the chat pane holds a live agent on the harness that was asked for
//   3. a typed question reaches the editor and produces an answer
//   4. a follow-up naming nothing resolves against the answer before it
//   5. a chat pane closed under it is recovered, and the relaunch resumes that same
//      native session rather than starting a new one
//   6. a requested action changes the Run immediately, is attributed to chat, leaves no
//      confirmation pending, and cannot be replayed — observed in the Run's own record,
//      never just in what the model said it did
//   7. a development nobody asked about reaches the conversation — pushed where the
//      harness has a queue, on the next turn where it does not — and settles only once
//      the model has actually read it
//
// Every marker asserted here is a string the model had to find out, never one typed at
// it: a pane shows the question as well as the answer, so a marker that appears in the
// question is satisfied by its echo.

import { BunServices } from "@effect/platform-bun";
import { Clock, Effect, FileSystem, ManagedRuntime } from "effect";
import {
  chatHarnessOf,
  chatPath,
  ensureChatFor,
  preferredHarness,
  pushable,
  readChat,
} from "../src/chat";
import { writeConfigValue } from "../src/config";
import { readEnv } from "../src/env";
import { ensureHome, homeDeps, homePath, readHome, UNREADABLE } from "../src/home";
import { Herdr } from "../src/herdr";
import { carryOutProposal } from "../src/operations";
import { readIntent, seedIntent, writeIntent } from "../src/intent";
import {
  append as appendNews,
  newsPath,
  pending as pendingNews,
  read as readNews,
} from "../src/news";
import { pendingFor, proposalsPath, read as readProposals } from "../src/proposals";
import { RunStore } from "../src/run";
import { herdDir, herdOf } from "../src/steering";

const runtime = ManagedRuntime.make(BunServices.layer);

type Result = "pass" | "fail" | "not-run";
interface Row {
  readonly check: string;
  readonly result: Result;
  readonly note: string;
}

/** How long a native turn is given before its silence is the answer. */
const ANSWER_MS = 180_000;
/** How long an unasked-for arrival is waited for. Nobody is working, so silence is quick. */
const UNASKED_MS = 60_000;

/**
 * A turn's answer, waited for by the thing that proves it: the marker on the screen.
 *
 * Not the agent's status. A harness is `working` while it starts up and `idle` again
 * before it has read anything, so a probe that waited on status reported a question
 * answered that the model never saw. What is on the pane is the evidence.
 */
const answers = Effect.fn("live.answers")(function* (
  herdr: Herdr,
  paneId: string,
  marker: string,
  withinMs = ANSWER_MS,
) {
  const until = (yield* Clock.currentTimeMillis) + withinMs;
  while ((yield* Clock.currentTimeMillis) < until) {
    const tail = yield* herdr.paneRead(paneId, 200).pipe(Effect.catch(() => Effect.succeed("")));
    if (tail.includes(marker)) return tail;
    yield* Effect.sleep("3 seconds");
  }
  return null;
});

const live = Effect.fn("live.run")(function* (harness: string, keep: boolean) {
  const fs = yield* FileSystem.FileSystem;
  const rows: Row[] = [];
  const say = (check: string, result: Result, note: string) => rows.push({ check, result, note });

  const stateDir = yield* fs.makeTempDirectory({ prefix: "collie-chat-live-state-" });
  const configDir = yield* fs.makeTempDirectory({ prefix: "collie-chat-live-config-" });
  yield* writeConfigValue(configDir, "chat_harness", harness);

  const env = readEnv({
    ...process.env,
    HERDR_PLUGIN_STATE_DIR: stateDir,
    HERDR_PLUGIN_CONFIG_DIR: configDir,
  });
  const herdr = new Herdr(env);
  const chosen = preferredHarness(yield* chatHarnessOf(configDir));

  // A Herd identity of its own, so this never adopts, tokens or reconciles the Home the
  // human's own Collie is using on the same herdr session.
  const key = `probe-${(yield* Clock.currentTimeMillis).toString(36)}`;
  const namespaceDir = yield* herdDir(stateDir, key);
  const ensured = yield* ensureHome(
    stateDir,
    key,
    namespaceDir,
    homeDeps(herdr, (line) => Effect.log(line)),
  );
  if (ensured.kind !== "ready") {
    say("home", "fail", `the Home is ${ensured.kind}`);
    return rows;
  }
  const home = ensured.record;
  const panes = yield* herdr.paneList().pipe(Effect.catch(() => Effect.succeed([])));
  const board = panes.find((pane) => pane.paneId === home.paneId);
  const chatPane = panes.find((pane) => pane.paneId === home.chatPaneId);
  say(
    "one tab, two panes",
    board && chatPane && board.tabId === chatPane.tabId ? "pass" : "fail",
    `board ${home.paneId ?? "none"}, chat ${home.chatPaneId ?? "none"}, tab ${home.tabId ?? "none"}`,
  );

  // This repository's own entrypoint, not the probe's: `selfCommand` would name
  // `tools/chat-live.ts`, so the MCP server Claude started would be the probe again and
  // the conversation would have no Collie tools at all. An install has the compiled
  // binary and needs none of this.
  const self = [process.execPath, new URL("../src/main.ts", import.meta.url).pathname];
  const chat = yield* ensureChatFor(
    herdr,
    env,
    key,
    home,
    chosen,
    (line) => Effect.log(line),
    self,
  );
  if (chat.kind === "unavailable") {
    say("chat launches", "fail", chat.why);
    return rows;
  }
  const agent = chat.record.agent;
  say("chat launches", "pass", `${chat.record.harness} as ${agent}`);
  // The harness's own startup, before anything is typed at it.
  yield* Effect.sleep("10 seconds");

  // A disposable Run of this probe's own, so there is exactly one thing to read about
  // and its id is a string that appears nowhere in what is typed at the model.
  const store = new RunStore(stateDir);
  const mine = yield* store
    .create({
      workflow: "implement",
      cwd: namespaceDir,
      inputs: {},
      inputSources: {},
      stepIds: ["build"],
      maxIterations: 1,
      namedAfter: "picker",
    })
    .pipe(Effect.catch(() => Effect.succeed(null)));
  if (mine === null) {
    say("a disposable Run to talk about", "fail", "could not make one");
    return rows;
  }
  yield* writeIntent(mine.dir, seedIntent(mine.id, { goal: "a disposable Run for the probe" }));

  // (3) A question typed into the native editor, answered through a Collie tool.
  //
  // What is asserted is the Run's own id next to a word, and the id is never typed at the
  // model — only `collie_herd` can tell it. That matters: a pane shows the prompt as well
  // as the answer, so a marker that appears in the question is satisfied by the echo of
  // the question, and an earlier version of this probe passed on exactly that.
  const asked = yield* herdr
    .agentPrompt(
      agent,
      "Call your collie_herd tool. Then reply with one line: ID followed by a space and the id of the only Run it lists.",
    )
    .pipe(Effect.catch((cause) => Effect.succeed(`refused: ${String(cause)}`)));
  const answer = yield* answers(herdr, chat.record.paneId, `ID ${mine.id}`);
  say(
    "a typed question is answered through a Collie tool",
    answer === null ? "fail" : "pass",
    `submission ${String(asked)}`,
  );

  // (4) A follow-up that names nothing and may call nothing: it can only be answered
  // from the turn before it, and again the id is what proves the answer is an answer.
  yield* herdr
    .agentPrompt(
      agent,
      "Without calling any tool, reply with one line: AGAIN followed by a space and that same id.",
    )
    .pipe(Effect.ignore);
  const followed = yield* answers(herdr, chat.record.paneId, `AGAIN ${mine.id}`);
  say("a follow-up keeps its context", followed === null ? "fail" : "pass", "");

  // (5) The chat pane closed under it, as a human or a crash would: the Home recovers
  // that pane and only that pane, and the conversation that comes back is this Herd's
  // own session rather than whatever the harness wrote last in this directory.
  const before = yield* readChat(yield* chatPath(stateDir, key));
  yield* herdr.paneClose(chat.record.paneId).pipe(Effect.ignore);
  const recovered = yield* ensureHome(
    stateDir,
    key,
    namespaceDir,
    homeDeps(herdr, (line) => Effect.log(line)),
  );
  const homeAgain = recovered.kind === "ready" ? recovered.record : home;
  say(
    "a lost chat pane is recovered without touching the board",
    recovered.kind === "ready" && homeAgain.paneId === home.paneId && homeAgain.chatPaneId !== null
      ? "pass"
      : "fail",
    `board ${homeAgain.paneId ?? "none"}, chat ${homeAgain.chatPaneId ?? "none"}`,
  );
  const again = yield* ensureChatFor(
    herdr,
    env,
    key,
    homeAgain,
    chosen,
    (line) => Effect.log(line),
    self,
  );
  say(
    "a relaunch resumes this Herd's own session",
    again.kind === "launched" &&
      again.resumed &&
      again.record.sessions[chosen] === before?.sessions[chosen]
      ? "pass"
      : "fail",
    again.kind === "unavailable"
      ? again.why
      : `${again.kind}, session ${again.record.sessions[chosen] ?? "none"}`,
  );

  // (6) Control. A request typed at the real pane, checked against the Run's own record.
  // The expected version is not in the prompt: its echo cannot satisfy the check.
  yield* herdr
    .agentPrompt(
      again.kind === "unavailable" ? agent : again.record.agent,
      `Use your collie_propose tool to add the constraint "stay in src" to the Intent of Run ${mine.id}, against base_version 1, with request_id "probe-intent". Then call collie_run for that Run and reply with one line: APPLIED followed by a space and the Intent version it reports.`,
    )
    .pipe(Effect.ignore);
  const requestedPane = homeAgain.chatPaneId ?? chat.record.paneId;
  const applied = yield* answers(herdr, requestedPane, "APPLIED 2");
  // The key the *tools* use, which is this socket's — not the probe's own Herd identity.
  // Both are inside the disposable state directory; reading the wrong one would say
  // nothing was requested.
  const file = yield* proposalsPath(stateDir, yield* herdOf(env.socketPath));
  const now = yield* Clock.currentTimeMillis;
  const records = yield* readProposals(file);
  const one = records
    .filter((line) => line.kind === "proposal")
    .find((line) => line.targets.some((target) => target.run === mine.id));
  const intent = yield* readIntent(mine.dir);
  say(
    "a requested action is executed and attributed to chat",
    applied !== null &&
      one !== undefined &&
      one.by.startsWith("chat:") &&
      records.some((line) => line.kind === "confirmed" && line.id === one.id && line.by === one.by)
      ? "pass"
      : "fail",
    `by ${one?.by ?? "nobody"}`,
  );
  const constraints = (intent?.constraints ?? []).map((constraint) => constraint.text);
  say(
    "the Intent changes without a second confirmation",
    intent?.version === 2 && constraints.some((text) => text.includes("stay in src"))
      ? "pass"
      : "fail",
    `Intent v${intent?.version ?? "?"}: ${constraints.join("; ") || "no constraints"}`,
  );
  const waiting = pendingFor(records, mine.id, now);
  say(
    "no redundant confirmation is pending",
    one !== undefined && waiting.length === 0 ? "pass" : "fail",
    `${waiting.length} pending`,
  );
  if (one !== undefined) {
    const replay = yield* carryOutProposal(env, one.id, one.content_hash, {
      origin: "chat",
      requestId: "probe-replay",
    });
    const after = yield* readIntent(mine.dir);
    say(
      "a recorded execution cannot be replayed",
      !replay.ok && replay.error.details?.reason === "not_pending" && after?.version === 2
        ? "pass"
        : "fail",
      replay.ok ? "it executed again" : replay.error.message,
    );
  } else {
    say("a recorded execution cannot be replayed", "fail", "no request was recorded");
  }

  // (7) News. A meaningful development while nobody is asking, and what reaches the
  // conversation about it. Pi is pushed to between turns; Claude is told on its next turn
  // through `collie_news`. Either way the item settles only when the model has read it.
  const newsFile = yield* newsPath(stateDir, yield* herdOf(env.socketPath));
  yield* appendNews(newsFile, {
    key: `${mine.id}:probe`,
    run: mine.id,
    text: `Run ${mine.id} stopped with COLLIE-PROBE-NEWS. What is going on?`,
  }).pipe(Effect.ignore);
  const push = pushable(chosen);
  const deliveredPane = homeAgain.chatPaneId ?? chat.record.paneId;
  // Watched on every harness, including the one Collie attempts no push on. Whether a
  // development reaches an idle conversation unasked is a fact about this installation,
  // and reading a `--help` page is not how it is settled — an item is written while the
  // pane sits idle, and the pane is what says whether it arrived.
  const pushed = yield* answers(herdr, deliveredPane, "COLLIE-PROBE-NEWS", UNASKED_MS);
  say(
    "a queued push arrives on its own",
    pushed === null ? "fail" : "pass",
    pushed !== null
      ? "observed"
      : push.attempts
        ? "not observed; the next turn is what carries it"
        : "no push attempted here, and nothing arrived on its own: the next turn carries it",
  );
  // The path Collie actually relies on, and the one both harnesses have: the next turn
  // reads the news and says what is in it.
  yield* herdr
    .agentPrompt(
      again.kind === "unavailable" ? agent : again.record.agent,
      "Is there anything I have not been told about? Answer in one line.",
    )
    .pipe(Effect.ignore);
  const arrived = yield* answers(herdr, deliveredPane, "COLLIE-PROBE-NEWS");
  say(
    "news reaches the conversation on its next turn",
    arrived === null ? "fail" : "pass",
    push.how,
  );
  const settled = pendingNews(yield* readNews(newsFile)).items.some(
    (item) => item.key === `${mine.id}:probe`,
  );
  say(
    "and reading it is what settles it",
    arrived !== null && !settled ? "pass" : "fail",
    settled ? "still waiting" : "read",
  );

  const pane = homeAgain.chatPaneId ?? chat.record.paneId;
  yield* Effect.log(
    `--- ${pane} tail ---\n${yield* herdr.paneRead(pane, 60).pipe(Effect.catch(() => Effect.succeed("(nothing)")))}`,
  );
  if (!keep) {
    const record = yield* readHome(yield* homePath(stateDir, key));
    if (record !== null && record !== UNREADABLE)
      yield* herdr.cli(["workspace", "close", record.workspaceId]).pipe(Effect.ignore);
    yield* fs.remove(stateDir, { recursive: true, force: true });
    yield* fs.remove(configDir, { recursive: true, force: true });
  } else {
    yield* Effect.log(`kept ${stateDir} and ${configDir}`);
  }
  return rows;
});

const argv = Bun.argv.slice(2);
const flag = (name: string, fallback: string) => {
  const at = argv.indexOf(`--${name}`);
  return at === -1 ? fallback : (argv[at + 1] ?? fallback);
};

const rows = await runtime.runPromise(live(flag("harness", "claude"), argv.includes("--keep")));
await runtime.runPromise(
  Effect.log(
    [
      "",
      "| check | result | note |",
      "|---|---|---|",
      ...rows.map((row) => `| ${row.check} | ${row.result} | ${row.note} |`),
      "",
      "Paste these rows into the implementation Run, with the harness version and revision.",
    ].join("\n"),
  ),
);
process.exitCode = rows.some((row) => row.result !== "pass") ? 1 : 0;

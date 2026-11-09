#!/usr/bin/env bun
// What native chat actually does, as the core terminal a host keeps, with a real harness.
// Nothing about typing, global scope, follow-ups or resume may be called proven from a
// test with a fake adapter: a process that started is not an editor that took a keystroke.
//
//   HC_SOCKET=<a scratch core's socket> bun run tools/chat-live.ts [--harness claude|pi] [--keep]
//
// It makes a **disposable** Herd: its own state and config directories, its own host and
// its own chat session, on a core the caller started for it (`hc server start` under an
// `HC_SESSION` of its own), never the one your agents run in. It never touches the state
// directory your Runs are in. It costs real model calls.
//
// Six questions, printed as markdown to paste into the implementation Run:
//   2. the host starts the chat terminal on the harness that was asked for
//   3. a typed question reaches the editor and produces an answer
//   4. a follow-up naming nothing resolves against the answer before it
//   5. a chat that ends is started again, on a new conversation
//   6. a requested action changes the Run immediately, is attributed to chat, leaves no
//      confirmation pending, and cannot be replayed — observed in the Run's own record,
//      never just in what the model said it did
//   7. a development nobody asked about reaches the conversation — pushed where the
//      harness has a queue, on the next turn where it does not — and settles only once
//      the model has actually read it
//
// Every marker asserted here is a string the model had to find out, never one typed at
// it: a screen shows the question as well as the answer, so a marker that appears in the
// question is satisfied by its echo.

import * as Str from "effect/String";
import { pipe as pipe_ } from "effect/Function";
import * as Arr from "effect/Array";
import * as Option from "effect/Option";
import { Clock, ConfigProvider, Effect, FileSystem, ManagedRuntime, Schema } from "effect";
import { platformLayer } from "../src/platform";
import {
  CHAT_TERMINAL,
  chatHarnessOf,
  chatPath,
  preferredHarness,
  pushable,
  readChat,
  type ChatRecord,
} from "../src/chat";
import { writeConfigValue } from "../src/config";
import { readEnv, type PluginEnv } from "../src/env";
import { connect } from "../src/hc";
import { Herdr } from "../src/herdr";
import { ownerOf } from "../src/host";
import { BOARD_TERMINAL } from "../src/side-jobs";
import { readIntent } from "../src/intent";
import { confirmProposed, hostRunProposals, startRun } from "../src/lifecycle";
import {
  append as appendNews,
  newsPath,
  pending as pendingNews,
  read as readNews,
} from "../src/news";
import { pendingFor } from "../src/proposals";
import { machineHerd } from "../src/steering";

const runtime = ManagedRuntime.make(platformLayer);
const main = new URL("../src/main.ts", import.meta.url).pathname;
const CommandJson = Schema.fromJsonString(Schema.Array(Schema.String));
const probeWorkflow = `import { ask, defineWorkflow } from "collie";
import { Schema } from "effect";
export default defineWorkflow({
  id: "chat-probe",
  title: "A disposable Run for the chat probe",
  input: Schema.Struct({}),
  output: Schema.String,
  run: () => ask({ name: "finish", prompt: "Finish the chat probe?", options: ["Done"] }),
});
`;

const disposableRun = Effect.fn("live.disposableRun")(function* (env: PluginEnv, project: string) {
  const fs = yield* FileSystem.FileSystem;
  const workflows = `${env.userDir}/workflows`;
  yield* fs.makeDirectory(workflows, { recursive: true });
  yield* fs.writeFileString(`${workflows}/chat-probe.workflow.ts`, probeWorkflow);
  const host = yield* Schema.encodeEffect(CommandJson)([process.execPath, main]);
  const started = yield* startRun(
    { ...env, cwd: project, cwdExplicit: true },
    {
      door: "cli",
      id: "chat-probe",
      request: "chat-probe",
      input: { json: {}, text: {} },
      task: { mode: "here" },
      intent: { goal: "a disposable Run for the probe" },
    },
  ).pipe(
    Effect.provide(
      ConfigProvider.layer(
        ConfigProvider.fromEnv({
          env: { ...env.raw, COLLIE_HOST: host },
        }),
      ),
    ),
  );
  return started.ok ? { id: started.runId, dir: `${env.stateDir}/runs/${started.runId}` } : null;
});

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

/** What the chat terminal's screen shows now. */
const screen = (socket: string) =>
  Effect.scoped(
    Effect.flatMap(connect(socket), (hc) => hc.call("terminal.read", { terminal: CHAT_TERMINAL })),
  ).pipe(
    Effect.map((read) => read.text),
    Effect.orElseSucceed(() => ""),
  );

/**
 * A turn's answer, waited for by the thing that proves it: the marker on the screen.
 *
 * Not the agent's status. A harness is `working` while it starts up and `idle` again
 * before it has read anything, so a probe that waited on status reported a question
 * answered that the model never saw. What is on the screen is the evidence.
 */
const answers = Effect.fn("live.answers")(function* (
  socket: string,
  marker: string,
  withinMs = ANSWER_MS,
) {
  const until = (yield* Clock.currentTimeMillis) + withinMs;
  while ((yield* Clock.currentTimeMillis) < until) {
    const tail = yield* screen(socket);
    if (pipe_(tail, Str.includes(marker))) return tail;
    yield* Effect.sleep("3 seconds");
  }
  return null;
});

/** The chat record once it names a session other than `not`, as the host writes it. */
const chatOtherThan = Effect.fn("live.chatOtherThan")(function* (
  file: string,
  not: string | undefined,
) {
  const until = (yield* Clock.currentTimeMillis) + ANSWER_MS;
  while ((yield* Clock.currentTimeMillis) < until) {
    const record = yield* readChat(file);
    if (record !== null && record.sessions[record.harness] !== not) return record;
    yield* Effect.sleep("1 second");
  }
  return null;
});

const live = Effect.fn("live.run")(function* (harness: string, keep: boolean) {
  const fs = yield* FileSystem.FileSystem;
  const rows: Row[] = [];
  const say = (check: string, result: Result, note: string) => rows.push({ check, result, note });

  const temporary = (prefix: string) =>
    keep ? fs.makeTempDirectory({ prefix }) : fs.makeTempDirectoryScoped({ prefix });
  const stateDir = yield* temporary("collie-chat-live-state-");
  const userDir = yield* temporary("collie-chat-live-config-");
  yield* writeConfigValue(userDir, "chat_harness", harness);

  const env = readEnv({
    // The probe replays the caller's complete environment into its disposable configuration.
    // oxlint-disable-next-line effecttsgo/process-env, effecttsgo/process-env-in-effect
    ...process.env,
    HERDR_PLUGIN_STATE_DIR: stateDir,
    COLLIE_USER_DIR: userDir,
  });
  const socket = env.raw.HC_SOCKET;
  if (socket === undefined || socket === "") {
    say(
      "a scratch core",
      "fail",
      "HC_SOCKET names no core; start one under an HC_SESSION of its own",
    );
    return rows;
  }
  yield* writeConfigValue(userDir, "terminal_backend", "core");
  const herdr = new Herdr(env);
  const chosen = preferredHarness(yield* chatHarnessOf(userDir));
  const key = yield* machineHerd(env);
  const chatFile = yield* chatPath(stateDir, key);
  // The host first, so that the terminals it keeps are not started again once killed.
  yield* Effect.addFinalizer(() =>
    keep
      ? Effect.log(`kept ${stateDir} and ${userDir}`)
      : Effect.gen(function* () {
          const owner = yield* ownerOf(stateDir);
          if (owner !== null) process.kill(owner.pid, "SIGTERM");
          yield* Effect.sleep("2 seconds");
          for (const name of [BOARD_TERMINAL, CHAT_TERMINAL])
            yield* herdr.paneClose(name, "core").pipe(Effect.ignore);
        }).pipe(Effect.ignore),
  );

  // A disposable Run of this probe's own, so there is exactly one thing to read about
  // and its id is a string that appears nowhere in what is typed at the model. Starting
  // it starts the host, and the host starts the chat.
  const project = yield* temporary("collie-chat-live-project-");
  const mine = yield* disposableRun(env, project).pipe(Effect.orElseSucceed(() => null));
  if (mine === null) {
    say("a disposable Run to talk about", "fail", "could not make one");
    return rows;
  }
  const chat: ChatRecord | null = yield* chatOtherThan(chatFile, undefined);
  if (chat === null) {
    say("the host starts the chat", "fail", `no ${CHAT_TERMINAL} was recorded`);
    return rows;
  }
  say(
    "the host starts the chat",
    chat.harness === chosen ? "pass" : "fail",
    `${chat.harness} as ${CHAT_TERMINAL}`,
  );
  // The harness's own startup, before anything is typed at it.
  yield* Effect.sleep("10 seconds");

  // (3) A question typed into the native editor, answered through a Collie tool.
  //
  // What is asserted is the Run's own id next to a word, and the id is never typed at the
  // model — only `collie_herd` can tell it. That matters: a screen shows the prompt as well
  // as the answer, so a marker that appears in the question is satisfied by the echo of
  // the question, and an earlier version of this probe passed on exactly that.
  const prompt = (text: string) =>
    herdr
      .agentPrompt(CHAT_TERMINAL, text, "core")
      .pipe(Effect.catch((cause) => Effect.succeed(`refused: ${String(cause)}`)));
  const asked = yield* prompt(
    "Call your collie_herd tool. Then reply with one line: ID followed by a space and the id of the only Run it lists.",
  );
  const answer = yield* answers(socket, `ID ${mine.id}`);
  say(
    "a typed question is answered through a Collie tool",
    answer === null ? "fail" : "pass",
    `submission ${String(asked)}`,
  );

  // (4) A follow-up that names nothing and may call nothing: it can only be answered
  // from the turn before it, and again the id is what proves the answer is an answer.
  yield* prompt(
    "Without calling any tool, reply with one line: AGAIN followed by a space and that same id.",
  );
  const followed = yield* answers(socket, `AGAIN ${mine.id}`);
  say("a follow-up keeps its context", followed === null ? "fail" : "pass", "");

  // (5) The chat ended under it, as a human or a crash would: the host starts it again,
  // on a conversation of its own rather than whatever the harness wrote last.
  yield* herdr.paneClose(CHAT_TERMINAL, "core").pipe(Effect.ignore);
  const again = yield* chatOtherThan(chatFile, chat.sessions[chat.harness]);
  say(
    "a chat that ends is started again, on a new conversation",
    again === null ? "fail" : "pass",
    again === null ? "nothing was started" : `session ${again.sessions[again.harness] ?? "none"}`,
  );
  yield* Effect.sleep("10 seconds");

  // (6) Control. A request typed at the real editor, checked against the Run's own record.
  // The expected version is not in the prompt: its echo cannot satisfy the check.
  yield* prompt(
    `Use your collie_propose tool to add the constraint "stay in src" to the Intent of Run ${mine.id}, against base_version 1, with request_id "probe-intent". Then call collie_run for that Run and reply with one line: APPLIED followed by a space and the Intent version it reports.`,
  );
  const applied = yield* answers(socket, "APPLIED 2");
  const now = yield* Clock.currentTimeMillis;
  const records = yield* hostRunProposals(env, mine.id).pipe(Effect.orElseSucceed(() => []));
  const one = Option.getOrUndefined(
    Arr.findFirst(
      Arr.filter(records, (line) => line.kind === "proposal"),
      (line) => Arr.some(line.targets, (target) => target.run === mine.id),
    ),
  );
  const intent = yield* readIntent(mine.dir);
  say(
    "a requested action is executed and attributed to chat",
    applied !== null &&
      one !== undefined &&
      pipe_(one.by, Str.startsWith("chat:")) &&
      Arr.some(
        records,
        (line) => line.kind === "confirmed" && line.id === one.id && line.by === one.by,
      )
      ? "pass"
      : "fail",
    `by ${one?.by ?? "nobody"}`,
  );
  const constraints = Arr.map(intent?.constraints ?? [], (constraint) => constraint.text);
  say(
    "the Intent changes without a second confirmation",
    intent?.version === 2 &&
      Arr.some(constraints, (text) => pipe_(text, Str.includes("stay in src")))
      ? "pass"
      : "fail",
    `Intent v${intent?.version ?? "?"}: ${Arr.join(constraints, "; ") || "no constraints"}`,
  );
  const waiting = pendingFor(records, mine.id, now);
  say(
    "no redundant confirmation is pending",
    one !== undefined && waiting.length === 0 ? "pass" : "fail",
    `${waiting.length} pending`,
  );
  if (one !== undefined) {
    const replay = yield* confirmProposed(env, {
      door: { origin: "chat" },
      proposal: one.id,
      hash: one.content_hash,
      request: "probe-replay",
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
  const newsFile = yield* newsPath(stateDir, key);
  yield* appendNews(newsFile, {
    key: `${mine.id}:probe`,
    run: mine.id,
    text: `Run ${mine.id} stopped with COLLIE-PROBE-NEWS. What is going on?`,
  }).pipe(Effect.ignore);
  const push = pushable(chosen);
  // Watched on every harness, including the one Collie attempts no push on. Whether a
  // development reaches an idle conversation unasked is a fact about this installation,
  // and reading a `--help` page is not how it is settled — an item is written while the
  // editor sits idle, and the screen is what says whether it arrived.
  const pushed = yield* answers(socket, "COLLIE-PROBE-NEWS", UNASKED_MS);
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
  yield* prompt("Is there anything I have not been told about? Answer in one line.");
  const arrived = yield* answers(socket, "COLLIE-PROBE-NEWS");
  say(
    "news reaches the conversation on its next turn",
    arrived === null ? "fail" : "pass",
    push.how,
  );
  const settled = Arr.some(
    pendingNews(yield* readNews(newsFile)).items,
    (item) => item.key === `${mine.id}:probe`,
  );
  say(
    "and reading it is what settles it",
    arrived !== null && !settled ? "pass" : "fail",
    settled ? "still waiting" : "read",
  );

  yield* Effect.log(`--- ${CHAT_TERMINAL} ---\n${yield* screen(socket)}`);
  return rows;
});

const argv = Arr.drop(Bun.argv, 2);
const flag = (name: string, fallback: string) => {
  const at = argv.indexOf(`--${name}`);
  return at === -1 ? fallback : (argv[at + 1] ?? fallback);
};

const rows = await runtime.runPromise(
  Effect.scoped(live(flag("harness", "claude"), Arr.contains(argv, "--keep"))),
);
await runtime.runPromise(
  Effect.log(
    Arr.join(
      [
        "",
        "| check | result | note |",
        "|---|---|---|",
        ...Arr.map(rows, (row) => `| ${row.check} | ${row.result} | ${row.note} |`),
        "",
        "Paste these rows into the implementation Run, with the harness version and revision.",
      ],
      "\n",
    ),
  ),
);
process.exitCode = Arr.some(rows, (row) => row.result !== "pass") ? 1 : 0;

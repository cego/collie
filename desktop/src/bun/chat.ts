// The Flock chat: one warm Agent SDK session on the user's own Claude Code, in Desktop's
// main process beside the channels its tools call. Its session id is minted once and
// resumed on every launch after, until the human starts a fresh one or reopens an earlier
// one; Claude Code keeps and compacts the transcripts on this computer. Collie's tools and
// AskUserQuestion are its only tools.

import {
  getSessionInfo,
  getSessionMessages,
  listSessions,
  query,
  type SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import {
  Cause,
  Crypto,
  Deferred,
  Effect,
  Exit,
  FileSystem,
  Option,
  Path,
  PubSub,
  Queue,
  Schema,
  Scope,
  Semaphore,
  Stream,
} from "effect";
import { isJsonObject } from "../../../src/schema";
import { type AguiEvent, ends } from "../shared/agui";
import type { About, Answers, ChatMessage, Conversations } from "../shared/chat-view";
import { startState, step } from "./agui";
import { callFlockTool, FLOCK_TOOLS, type FlockChat } from "./flock-tools";
import { sessionOptions } from "./session";
import { transcriptOf } from "./transcript";

/** Collie's tools as an MCP server in this process: listed from the Toolkit, and every call decoded by it. */
export const flockServer = (
  flock: FlockChat,
  run: (effect: Effect.Effect<string, never, Crypto.Crypto>) => Promise<string>,
) => {
  const server = new McpServer(
    { name: "collie", version: "1" },
    { capabilities: { tools: { listChanged: false } } },
  );
  server.server.setRequestHandler(ListToolsRequestSchema, () =>
    Promise.resolve({
      tools: FLOCK_TOOLS.map((tool) => ({
        name: tool.name,
        title: tool.title,
        description: tool.description,
        // SAFETY: a JSON Schema document for an object's parameters, which is what MCP lists.
        inputSchema: tool.input() as { type: "object" },
        annotations: { readOnlyHint: tool.readOnly },
      })),
    }),
  );
  server.server.setRequestHandler(CallToolRequestSchema, (request) =>
    run(
      callFlockTool(
        flock,
        request.params.name,
        isJsonObject(request.params.arguments) ? request.params.arguments : {},
      ),
    ).then((text) => ({ content: [{ type: "text" as const, text }] })),
  );
  return server;
};

const SessionFile = Schema.fromJsonString(Schema.Struct({ session: Schema.String }));

export interface FlockConversation {
  /** One message from the human, about a card or none, and the events of the turn it starts. */
  readonly send: (text: string, about: About | null) => Stream.Stream<AguiEvent>;
  /** Answers the question the chat asked in that tool call, if it is still asking. */
  readonly answer: (toolCallId: string, answers: Answers) => Effect.Effect<void>;
  readonly transcript: Effect.Effect<ReadonlyArray<ChatMessage>>;
  readonly conversations: Effect.Effect<Conversations>;
  /** Ends the current session and makes that one current, or a fresh one. */
  readonly reopen: (session: string | null) => Effect.Effect<void>;
}

/** How many earlier conversations the history offers. */
const HISTORY = 10;

export const refusal = (message: string): AguiEvent => ({ type: "RUN_ERROR", runId: "", message });

/**
 * The current conversation's session, started by its first message and warm from then
 * until the scope closes, and never more than one. A session Claude Code has a transcript
 * for is resumed; one it has none of yet starts under its minted id.
 */
export const openFlockChat = Effect.fn("FlockChat.open")(function* (opts: {
  readonly dir: string;
  readonly conversation: string;
  readonly machines: FlockChat["machines"];
}) {
  const fs = yield* FileSystem.FileSystem;
  const crypto = yield* Crypto.Crypto;
  yield* fs.makeDirectory(opts.dir, { recursive: true });
  const file = (yield* Path.Path).join(opts.dir, "flock-chat.json");
  const saved = yield* fs
    .readFileString(file)
    .pipe(Effect.flatMap(Schema.decodeUnknownEffect(SessionFile)), Effect.option);
  const remember = (session: string) =>
    fs.writeFileString(file, Schema.encodeSync(SessionFile)({ session }));
  let said: string | undefined;
  let attached: About | undefined;
  const asking = new Map<string, Deferred.Deferred<Answers>>();
  const services = yield* Effect.context<Crypto.Crypto>();
  const run = (effect: Effect.Effect<string, never, Crypto.Crypto>) =>
    Effect.runPromise(effect.pipe(Effect.provideContext(services)));
  const server = flockServer(
    { machines: opts.machines, conversation: opts.conversation, said: () => said },
    run,
  );
  const ask = (toolUseID: string, signal: AbortSignal) => {
    const answered = Deferred.makeUnsafe<Answers>();
    asking.set(toolUseID, answered);
    return Effect.runPromise(
      Deferred.await(answered).pipe(Effect.ensuring(Effect.sync(() => asking.delete(toolUseID)))),
      { signal },
    );
  };

  /** One session, live until its scope closes. */
  const start = Effect.fnUntraced(function* (id: string) {
    const known = yield* Effect.tryPromise(() => getSessionInfo(id, { dir: opts.dir })).pipe(
      Effect.orElseSucceed(() => undefined),
    );
    const inbox = yield* Queue.unbounded<SDKUserMessage>();
    const claude = query({
      prompt: Stream.toAsyncIterable(Stream.fromQueue(inbox)),
      options: sessionOptions({
        cwd: opts.dir,
        session: known === undefined ? { sessionId: id } : { resume: id },
        server,
        claude: Bun.which("claude"),
        ask,
        about: () => attached,
      }),
    });
    const events = yield* PubSub.unbounded<AguiEvent>();
    /** Why the session ended, once it has: every turn after it is told at once. */
    let ended: string | null = null;
    const endWith = (why: string) =>
      Effect.suspend(() => {
        ended = why;
        return PubSub.publish(events, refusal(why));
      });
    yield* Stream.fromAsyncIterable(claude, String).pipe(
      Stream.mapAccum(() => startState(id), step),
      Stream.runForEach((event) => PubSub.publish(events, event)),
      Effect.matchCauseEffect({
        onSuccess: () => endWith("Claude Code ended the Flock chat's session."),
        onFailure: (cause) => endWith(Cause.pretty(cause)),
      }),
      Effect.forkScoped,
    );
    // Added after the reader, so it runs first and the reader's pending message ends.
    yield* Effect.addFinalizer(() => Effect.sync(() => claude.close()));
    return { claude, inbox, events, ended: () => ended };
  });

  type Live = Effect.Success<ReturnType<typeof start>>;
  let id = Option.isSome(saved) ? saved.value.session : yield* crypto.randomUUIDv4;
  if (Option.isNone(saved)) yield* remember(id);
  let live: { readonly running: Live; readonly scope: Scope.Closeable } | undefined;
  const warm = Effect.gen(function* () {
    if (live !== undefined) return live.running;
    const scope = yield* Scope.make();
    live = { running: yield* start(id).pipe(Scope.provide(scope)), scope };
    return live.running;
  });
  const end = Effect.suspend(() => {
    const ending = live;
    live = undefined;
    return ending === undefined ? Effect.void : Scope.close(ending.scope, Exit.void);
  });
  yield* Effect.addFinalizer(() => end);

  const turns = yield* Semaphore.make(1);
  /** The session a turn is under way on, if one is. */
  let turning: Live | undefined;
  const conversation: FlockConversation = {
    send: (text, about) =>
      Stream.unwrap(
        Effect.gen(function* () {
          yield* Effect.acquireRelease(turns.take(1), () => turns.release(1));
          const running = yield* warm;
          const ended = running.ended();
          if (ended !== null) return Stream.make(refusal(ended));
          const heard = yield* PubSub.subscribe(running.events);
          let finished = false;
          // A turn its reader dropped is interrupted and seen out, so the next starts clean.
          yield* Effect.addFinalizer(() =>
            Effect.sync(() => {
              said = undefined;
              turning = undefined;
              attached = undefined;
            }).pipe(
              Effect.andThen(
                finished
                  ? Effect.void
                  : Effect.tryPromise(() => running.claude.interrupt()).pipe(
                      Effect.andThen(
                        Stream.fromSubscription(heard).pipe(
                          Stream.takeUntil(ends),
                          Stream.runDrain,
                        ),
                      ),
                      Effect.timeout("10 seconds"),
                      Effect.ignore,
                    ),
              ),
            ),
          );
          said = text;
          turning = running;
          attached = about ?? undefined;
          yield* Queue.offer(running.inbox, {
            type: "user",
            message: { role: "user", content: text },
            parent_tool_use_id: null,
          });
          return Stream.fromSubscription(heard).pipe(
            Stream.takeUntil(ends),
            Stream.tap((event) =>
              Effect.sync(() => {
                if (ends(event)) finished = true;
              }),
            ),
          );
        }),
      ),
    answer: (toolCallId, answers) =>
      Effect.suspend(() => {
        const answered = asking.get(toolCallId);
        return answered === undefined ? Effect.void : Deferred.succeed(answered, answers);
      }),
    transcript: Effect.tryPromise(() => getSessionMessages(id, { dir: opts.dir })).pipe(
      Effect.map(transcriptOf),
      Effect.orElseSucceed(() => []),
    ),
    conversations: Effect.tryPromise(() =>
      listSessions({ dir: opts.dir, limit: HISTORY + 1 }),
    ).pipe(
      Effect.orElseSucceed(() => []),
      Effect.map((sessions) => ({
        current: id,
        earlier: sessions
          .filter(({ sessionId }) => sessionId !== id)
          .slice(0, HISTORY)
          .map(({ sessionId, summary, lastModified }) => ({
            session: sessionId,
            title: summary,
            at: lastModified,
          })),
      })),
    ),
    // A turn under way is interrupted, and the session it ran on ends before the next starts.
    reopen: (session) =>
      Effect.gen(function* () {
        const claude = turning?.claude;
        if (claude !== undefined)
          yield* Effect.tryPromise(() => claude.interrupt()).pipe(Effect.ignore);
        yield* turns.withPermits(1)(
          Effect.gen(function* () {
            yield* end;
            id = session ?? (yield* crypto.randomUUIDv4);
            yield* remember(id);
          }),
        );
      }).pipe(Effect.orDie),
  };
  return conversation;
});

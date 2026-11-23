import * as Arr from "effect/Array";
import { Data, Effect, Option, Queue, Schema, flow, Result } from "effect";

const CLIENT_INFO = { name: "collie", version: "0", title: "Collie" };

const CALL_MS = 10_000;
const REPLAY_MS = 3000;

export class CodexError extends Data.TaggedError("CodexError")<{
  readonly message: string;
  readonly code?: number;
}> {}

const failed = (message: string, code?: number) =>
  new CodexError(code === undefined ? { message } : { message, code });

const Reply = Schema.Struct({
  id: Schema.optionalKey(Schema.Finite),
  method: Schema.optionalKey(Schema.String),
  result: Schema.optionalKey(Schema.Unknown),
  params: Schema.optionalKey(Schema.Unknown),
  error: Schema.optionalKey(
    Schema.Struct({ message: Schema.String, code: Schema.optionalKey(Schema.Finite) }),
  ),
});
interface Reply extends Schema.Schema.Type<typeof Reply> {}
const decodeReply = Schema.decodeUnknownOption(Schema.fromJsonString(Reply));

type CodexParamValue = string | number | boolean | null | CodexParams;
export interface CodexParams {
  readonly [key: string]: CodexParamValue;
}

export interface CodexClient {
  call(method: string, params: CodexParams): Effect.Effect<unknown, CodexError>;
  readonly notifications: Queue.Dequeue<{ method: string; params: unknown }>;
}

interface Live {
  client: CodexClient;
  close: () => void;
}

const Request = Schema.fromJsonString(
  Schema.Struct({
    jsonrpc: Schema.String,
    id: Schema.Finite,
    method: Schema.String,
    params: Schema.Unknown,
  }),
);
const encodeRequest = flow(Schema.encodeResult(Request), Result.getOrThrow);

const open = (url: string) =>
  Effect.flatMap(
    Queue.unbounded<{
      method: string;
      params: unknown;
    }>(),
    (notifications) =>
      Effect.callback<Live, CodexError>((resume) => {
        const socket = new WebSocket(url);
        const pending = new Map<number, (reply: Reply) => void>();
        let nextId = 0;

        socket.onmessage = (event) => {
          const decodedReply = decodeReply(event.data);
          if (decodedReply._tag === "None") {
            return;
          }
          const reply = decodedReply.value;
          const waiting = reply.id === undefined ? undefined : pending.get(reply.id);
          if (waiting !== undefined && reply.id !== undefined) {
            pending.delete(reply.id);
            waiting(reply);
          } else if (reply.method !== undefined) {
            Queue.offerUnsafe(notifications, {
              method: reply.method,
              params: reply.params,
            });
          }
        };
        // WARNING: a close answers everyone still waiting, so a server that goes away fails the exchange.
        socket.onclose = () => {
          for (const waiting of pending.values()) {
            waiting({
              error: {
                message: "the connection closed",
              },
            });
          }
          pending.clear();
        };
        socket.onerror = () => resume(Effect.fail(failed(`${url} refused the connection`)));
        socket.onopen = () => {
          const call: CodexClient["call"] = (method, params) =>
            Effect.callback<unknown, CodexError>((answer) => {
              const id = ++nextId;
              pending.set(id, (reply) =>
                answer(
                  reply.error
                    ? Effect.fail(failed(`${method}: ${reply.error.message}`, reply.error.code))
                    : Effect.succeed(reply.result),
                ),
              );
              socket.send(
                encodeRequest({
                  jsonrpc: "2.0",
                  id,
                  method,
                  params,
                }),
              );
              return Effect.sync(() => pending.delete(id));
            }).pipe(
              Effect.timeoutOrElse({
                duration: CALL_MS,
                orElse: () => Effect.fail(failed(`${method} was not answered within ${CALL_MS}ms`)),
              }),
            );
          resume(
            Effect.succeed({
              client: {
                call,
                notifications,
              },
              close: () => socket.close(),
            }),
          );
        };
      }),
  ).pipe(
    Effect.timeoutOrElse({
      duration: CALL_MS,
      orElse: () => Effect.fail(failed(`${url} did not accept a connection within ${CALL_MS}ms`)),
    }),
  );

// WARNING: initialize is part of opening; every other method is refused before it.
export const withCodex = <A, E, R>(
  url: string,
  use: (client: CodexClient) => Effect.Effect<A, E, R>,
) =>
  Effect.acquireUseRelease(
    open(url),
    (live) =>
      live.client
        .call("initialize", { clientInfo: CLIENT_INFO })
        .pipe(Effect.andThen(use(live.client))),
    (live) => Effect.sync(() => live.close()),
  );

export const codexReachable = (url: string) =>
  Effect.acquireUseRelease(
    open(url),
    () => Effect.void,
    (live) => Effect.sync(() => live.close()),
  );

const LoadedList = Schema.Struct({ data: Schema.Array(Schema.String) });
const ThreadRead = Schema.Struct({
  thread: Schema.Struct({
    id: Schema.String,
    cwd: Schema.optionalKey(Schema.String),
    // WARNING: an ephemeral thread is the TUI's own cheap thread, not the agent.
    ephemeral: Schema.optionalKey(Schema.NullOr(Schema.Boolean)),
    parentThreadId: Schema.optionalKey(Schema.NullOr(Schema.String)),
    path: Schema.optionalKey(Schema.NullOr(Schema.String)),
    status: Schema.optionalKey(Schema.Struct({ type: Schema.String })),
    historyMode: Schema.optionalKey(Schema.String),
    preview: Schema.optionalKey(Schema.String),
    // WARNING: empty unless includeTurns is asked for, which a thread with no user message refuses.
    turns: Schema.optionalKey(Schema.Array(Schema.Unknown)),
  }),
});
const AsyncQuestion = Schema.Struct({
  title: Schema.String,
  options: Schema.optionalKey(Schema.NullOr(Schema.Array(Schema.String))),
});
const ItemsList = Schema.Struct({
  data: Schema.Array(
    Schema.Struct({
      turnId: Schema.String,
      item: Schema.Struct({
        id: Schema.String,
        type: Schema.String,
        questions: Schema.optionalKey(Schema.NullOr(Schema.Array(AsyncQuestion))),
      }),
    }),
  ),
});
const TurnsList = Schema.Struct({
  data: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      status: Schema.String,
      error: Schema.optionalKey(
        Schema.NullOr(Schema.Struct({ message: Schema.optionalKey(Schema.String) })),
      ),
    }),
  ),
});
const TokenUsage = Schema.Struct({
  threadId: Schema.String,
  tokenUsage: Schema.Struct({
    // WARNING: totalTokens is the context; total and its parts overlap, so never add or threshold them.
    last: Schema.Struct({ totalTokens: Schema.Finite }),
  }),
});

const decoded = <S extends Schema.Top>(what: string, schema: S, value: Reply["result"]) =>
  Schema.decodeUnknownEffect(schema)(value).pipe(
    Effect.mapError((cause) => failed(`${what}: ${String(cause)}`)),
  );

// WARNING: more than one of the agent's own threads is refused, not guessed at; ephemeral and sub-agent threads do not count.
export const boundThread = Effect.fn("Codex.boundThread")(function* (
  client: CodexClient,
  cwd: string,
) {
  const loaded = yield* decoded(
    "thread/loaded/list",
    LoadedList,
    yield* client.call("thread/loaded/list", {}),
  );
  if (loaded.data.length === 0) {
    return null;
  }
  const mine: Array<string> = [];
  const elsewhere: Array<string> = [];
  for (const threadId of loaded.data) {
    const read = yield* decoded(
      "thread/read",
      ThreadRead,
      yield* client.call("thread/read", { threadId }),
    );
    if (read.thread.ephemeral === true || read.thread.parentThreadId) {
      continue;
    }
    if (read.thread.cwd !== undefined && read.thread.cwd !== cwd) {
      elsewhere.push(`${threadId} in ${read.thread.cwd}`);
      continue;
    }
    mine.push(threadId);
  }
  if (mine.length > 1) {
    return yield* failed(
      `this agent's endpoint has ${mine.length} threads on it; Collie starts one server per agent and cannot say which is this one`,
    );
  }
  const threadId = mine[0];
  if (threadId === undefined) {
    return elsewhere.length === 0
      ? null
      : yield* failed(
          `no thread of this agent's on this endpoint: ${Arr.join(elsewhere, ", ")} — not ${cwd}`,
        );
  }
  return threadId;
});

// WARNING: null is not zero: no model request yet, or usage invalidated by a compaction.
export const currentContext = Effect.fn("Codex.currentContext")(function* (
  client: CodexClient,
  threadId: string,
) {
  yield* client.call("thread/resume", { threadId });
  const replayed = Effect.gen(function* () {
    for (;;) {
      const note = yield* Queue.take(client.notifications);
      if (note.method !== "thread/tokenUsage/updated") {
        continue;
      }
      const usage = yield* decoded("thread/tokenUsage/updated", TokenUsage, note.params);
      if (usage.threadId === threadId) {
        return usage.tokenUsage.last.totalTokens;
      }
    }
  });
  return Option.getOrNull(yield* replayed.pipe(Effect.timeoutOption(REPLAY_MS)));
});

export interface CompactionItem {
  id: string;
  turnId: string;
}

export const compactionItems = Effect.fn("Codex.compactionItems")(function* (
  client: CodexClient,
  threadId: string,
) {
  const items = yield* decoded(
    "thread/items/list",
    ItemsList,
    yield* client.call("thread/items/list", { threadId, sortDirection: "desc", limit: 100 }),
  );
  return Arr.map(
    Arr.filter(items.data, (entry) => entry.item.type === "contextCompaction"),
    (entry) => ({ id: entry.item.id, turnId: entry.turnId }),
  );
});

// WARNING: Codex's question tool returns at once, so this message is all there is of a question.
export const askedQuestions = Effect.fn("Codex.askedQuestions")(function* (
  client: CodexClient,
  threadId: string,
) {
  const items = yield* decoded(
    "thread/items/list",
    ItemsList,
    yield* client.call("thread/items/list", { threadId, sortDirection: "desc", limit: 100 }),
  );
  return Arr.reverse(
    Arr.flatMap(items.data, ({ item }) =>
      item.questions?.length ? [{ id: item.id, questions: item.questions }] : [],
    ),
  );
});

// WARNING: read the turn's own terminal status; never infer completion from idleness.
export const turnOutcome = Effect.fn("Codex.turnOutcome")(function* (
  client: CodexClient,
  threadId: string,
  turnId: string,
) {
  const turns = yield* decoded(
    "thread/turns/list",
    TurnsList,
    yield* client.call("thread/turns/list", { threadId, sortDirection: "desc", limit: 20 }),
  );
  const turn = Option.getOrUndefined(Arr.findFirst(turns.data, (entry) => entry.id === turnId));
  if (!turn || turn.status === "inProgress") {
    return { kind: "running" } as const;
  }
  if (turn.status === "completed") {
    return { kind: "completed" } as const;
  }
  return {
    kind: "failed",
    reason: turn.error?.message ?? `the compaction turn ${turn.status}`,
  } as const;
});

export const startCompaction = (client: CodexClient, threadId: string) =>
  Effect.asVoid(client.call("thread/compact/start", { threadId }));

export interface LoadedThread {
  readonly id: string;
  readonly transcript: string | null;
  readonly running: ReadonlyArray<string>;
}

// WARNING: refused where an agent's own thread works in another directory; that server is not provably this agent's.
export const agentThreads = Effect.fn("Codex.agentThreads")(function* (
  client: CodexClient,
  cwd: string,
) {
  const loaded = yield* decoded(
    "thread/loaded/list",
    LoadedList,
    yield* client.call("thread/loaded/list", {}),
  );
  const threads: Array<LoadedThread> = [];
  for (const threadId of loaded.data) {
    const { thread } = yield* decoded(
      "thread/read",
      ThreadRead,
      yield* client.call("thread/read", { threadId }),
    );
    const own = thread.ephemeral !== true && !thread.parentThreadId;
    if (own && thread.cwd !== undefined && thread.cwd !== cwd) {
      return yield* failed(`thread ${threadId} works in ${thread.cwd}, not ${cwd}`);
    }
    const idle = thread.status?.type === "idle" && thread.turns?.length === 0;
    const unlistable = idle && thread.historyMode === "paginated" && thread.preview === "";
    threads.push({
      id: threadId,
      transcript: thread.path ?? null,
      running: yield* runningTurns(client, threadId).pipe(
        Effect.catchIf(
          (cause) => (idle && unmaterialized(threadId, cause)) || (unlistable && unlisted(cause)),
          () => Effect.succeed([]),
        ),
      ),
    });
  }
  return threads;
});

// WARNING: Codex 0.162.1 refuses turns of a thread no user message has materialized.
const unmaterialized = (threadId: string, cause: CodexError) =>
  cause.code === -32_600 &&
  cause.message ===
    `thread/turns/list: thread ${threadId} is not materialized yet; thread/turns/list is unavailable before first user message`;

// WARNING: Codex 0.162.1 refuses to list an idle paginated thread with no user message.
const unlisted = (cause: CodexError) =>
  cause.code === -32_601 && cause.message === "thread/turns/list: list_turns is not supported yet";

export const runningTurns = Effect.fn("Codex.runningTurns")(function* (
  client: CodexClient,
  threadId: string,
) {
  const turns = yield* decoded(
    "thread/turns/list",
    TurnsList,
    yield* client.call("thread/turns/list", { threadId, sortDirection: "desc", limit: 20 }),
  );
  return Arr.map(
    Arr.filter(turns.data, (turn) => turn.status === "inProgress"),
    (turn) => turn.id,
  );
});

// WARNING: an empty reply accepts cancellation and promises nothing.
export const interruptTurn = (client: CodexClient, threadId: string, turnId: string) =>
  Effect.asVoid(client.call("turn/interrupt", { threadId, turnId }));

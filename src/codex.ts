// The Codex App Server, as a client. Collie owns one server per agent and connects to
// it as a second client; the ordinary interactive TUI in the agent's pane is the first.
//
// Everything here was checked against the installed 0.153.4 rather than taken from
// upstream source, and two of the checks changed the design:
//
//   - `--listen unix://PATH` binds, but nothing Collie sends over that socket is ever
//     answered. `ws://127.0.0.1:PORT` is answered, and is a documented `--remote` form,
//     so the endpoint is a loopback port.
//   - A second client is sent `thread/started` and `thread/status/changed` and nothing
//     else. Token usage, item and turn events go only to the client that owns the
//     thread. `thread/resume` on a thread that has a rollout rejoins it, which
//     subscribes this client and immediately replays the current token usage — and that
//     is the only way Collie can read a Codex agent's current context.

import { Clock, Data, Effect, Schema } from "effect";

/** What the client sends as itself, which the server echoes into its user agent. */
const CLIENT_INFO = { name: "collie", version: "0", title: "Collie" };

/** How long one exchange may take before the connection is given up on. */
const CALL_MS = 10_000;
/** How long to wait for the token usage a rejoin replays. */
const REPLAY_MS = 3_000;

export class CodexError extends Data.TaggedError("CodexError")<{
  readonly message: string;
}> {}

const failed = (message: string) => new CodexError({ message });

const Reply = Schema.Struct({
  id: Schema.optionalKey(Schema.Number),
  method: Schema.optionalKey(Schema.String),
  result: Schema.optionalKey(Schema.Unknown),
  params: Schema.optionalKey(Schema.Unknown),
  error: Schema.optionalKey(Schema.Struct({ message: Schema.String })),
});
interface Reply extends Schema.Schema.Type<typeof Reply> {}
const decodeReply = Schema.decodeUnknownOption(Schema.fromJsonString(Reply));

/**
 * One connection, for the duration of one boundary read or one request. Short-lived on
 * purpose: a client that stayed open would be a second Collie process per agent, and
 * every fact the policy needs can be read back on a fresh connection — a rejoin replays
 * the current usage, and the item and turn lists are the compaction lifecycle.
 */
/** What a method's params may hold: the protocol's own params are JSON objects. */
type CodexParamValue = string | number | boolean | null | CodexParams;
export interface CodexParams {
  readonly [key: string]: CodexParamValue;
}

export interface CodexClient {
  /** One request/response. Fails on a JSON-RPC error or a silent server. */
  call(method: string, params: CodexParams): Effect.Effect<unknown, CodexError>;
  /** Notifications received so far, in arrival order. */
  notifications(): ReadonlyArray<{ method: string; params: unknown }>;
}

interface Live {
  client: CodexClient;
  close: () => void;
}

const Request = Schema.fromJsonString(
  Schema.Struct({
    jsonrpc: Schema.String,
    id: Schema.Number,
    method: Schema.String,
    params: Schema.Unknown,
  }),
);
const encodeRequest = Schema.encodeSync(Request);

/**
 * The socket, behind one `Effect.callback`. Kept to this function: everything above it
 * works in `call`s and never sees a WebSocket. Bun's global is the client — the protocol
 * is request/response over a stream, and Effect has none for it.
 */
const open = (url: string) =>
  Effect.callback<Live, CodexError>((resume) => {
    const socket = new WebSocket(url);
    const notifications: { method: string; params: unknown }[] = [];
    const pending = new Map<number, (reply: Reply) => void>();
    let nextId = 0;

    // Every frame goes through the reply schema, which is where the protocol becomes
    // domain values: a binary frame, a half-written one and a method Collie does not
    // know all fall out here rather than reaching the policy.
    socket.onmessage = (event) => {
      const decodedReply = decodeReply(event.data);
      if (decodedReply._tag === "None") return;
      const reply = decodedReply.value;
      const waiting = reply.id === undefined ? undefined : pending.get(reply.id);
      if (waiting !== undefined && reply.id !== undefined) {
        pending.delete(reply.id);
        waiting(reply);
      } else if (reply.method !== undefined) {
        notifications.push({ method: reply.method, params: reply.params });
      }
    };
    // A close answers everyone still waiting, so a server that goes away fails the
    // exchange rather than leaving the boundary holding its budget open.
    socket.onclose = () => {
      for (const waiting of pending.values()) {
        waiting({ error: { message: "the connection closed" } });
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
                ? Effect.fail(failed(`${method}: ${reply.error.message}`))
                : Effect.succeed(reply.result),
            ),
          );
          socket.send(encodeRequest({ jsonrpc: "2.0", id, method, params }));
          return Effect.sync(() => pending.delete(id));
        }).pipe(
          Effect.timeout(CALL_MS),
          Effect.catchTag("TimeoutError", () =>
            Effect.fail(failed(`${method} was not answered within ${CALL_MS}ms`)),
          ),
        );
      resume(
        Effect.succeed({
          client: { call, notifications: () => notifications },
          close: () => socket.close(),
        }),
      );
    };
  }).pipe(
    Effect.timeout(CALL_MS),
    Effect.catchTag("TimeoutError", () =>
      Effect.fail(failed(`${url} did not accept a connection within ${CALL_MS}ms`)),
    ),
  );

/**
 * Opens a connection, hands it to `use`, and closes it whatever happens. The
 * `initialize` handshake is part of opening: every other method is refused before it.
 */
export const withCodex = <A, E, R>(
  url: string,
  use: (client: CodexClient) => Effect.Effect<A, E, R>,
): Effect.Effect<A, E | CodexError, R> =>
  Effect.acquireUseRelease(
    open(url),
    (live) =>
      live.client
        .call("initialize", { clientInfo: CLIENT_INFO })
        .pipe(Effect.andThen(use(live.client))),
    (live) => Effect.sync(() => live.close()),
  );

const LoadedList = Schema.Struct({ data: Schema.Array(Schema.String) });
const ThreadRead = Schema.Struct({
  thread: Schema.Struct({
    id: Schema.String,
    cwd: Schema.optionalKey(Schema.String),
    /** True for the cheap thread a TUI keeps for itself, which is not the agent. */
    ephemeral: Schema.optionalKey(Schema.NullOr(Schema.Boolean)),
  }),
});
const ItemsList = Schema.Struct({
  data: Schema.Array(
    Schema.Struct({
      turnId: Schema.String,
      item: Schema.Struct({ id: Schema.String, type: Schema.String }),
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
    /**
     * The latest request's context, which is what the native TUI's own indicator
     * shows. `total` beside it is accumulated session usage and must never be
     * thresholded. `totalTokens` is used as it stands: the `inputTokens`,
     * `cachedInputTokens`, `cacheWriteInputTokens`, `outputTokens` and
     * `reasoningOutputTokens` beside it are its overlapping parts, not addends.
     */
    last: Schema.Struct({ totalTokens: Schema.Number }),
  }),
});

/**
 * One protocol payload against its schema. `Reply` has already parsed the frame, so
 * what arrives here is a `result` or a `params` that the protocol says is this shape
 * and Collie has not yet checked is.
 */
const decoded = <S extends Schema.Top>(what: string, schema: S, value: Reply["result"]) =>
  Schema.decodeUnknownEffect(schema)(value).pipe(
    Effect.mapError((cause) => failed(`${what}: ${String(cause)}`)),
  );

/**
 * The one thread on a one-agent endpoint, checked against the agent's own directory.
 * No thread yet is `null`; more than one is refused rather than guessed at — the whole
 * reason Collie runs a server per agent is that this answer cannot be ambiguous, so an
 * endpoint with two of the agent's threads on it is a fact about the launch, not a
 * thread to pick.
 *
 * An `ephemeral` thread is not one of them. A 0.153.4 TUI loads a cheap thread of its
 * own — a different model, no preview — beside the one it is working in, so every Codex
 * agent's own endpoint answers `thread/loaded/list` with two, and reading the agent's
 * context would have been refused for the rest of its life.
 */
export const boundThread = Effect.fn("Codex.boundThread")(function* (
  client: CodexClient,
  cwd: string,
) {
  const loaded = yield* decoded(
    "thread/loaded/list",
    LoadedList,
    yield* client.call("thread/loaded/list", {}),
  );
  if (loaded.data.length === 0) return null;
  const mine: string[] = [];
  const elsewhere: string[] = [];
  for (const threadId of loaded.data) {
    const read = yield* decoded(
      "thread/read",
      ThreadRead,
      yield* client.call("thread/read", { threadId }),
    );
    if (read.thread.ephemeral === true) continue;
    if (read.thread.cwd !== undefined && read.thread.cwd !== cwd) {
      elsewhere.push(`${threadId} in ${read.thread.cwd}`);
      continue;
    }
    mine.push(threadId);
  }
  if (mine.length > 1) {
    return yield* Effect.fail(
      failed(
        `this agent's endpoint has ${mine.length} threads on it; Collie starts one server per agent and cannot say which is this one`,
      ),
    );
  }
  const threadId = mine[0];
  if (threadId === undefined) {
    // Every thread it has is working somewhere else, which is not this agent's
    // context and must not be measured as if it were.
    return elsewhere.length === 0
      ? null
      : yield* Effect.fail(
          failed(
            `no thread of this agent's on this endpoint: ${elsewhere.join(", ")} — not ${cwd}`,
          ),
        );
  }
  return threadId;
});

/**
 * Rejoins the bound thread and reads the token usage the rejoin replays. Null where the
 * server sent none: the thread has not made a model request yet, or its usage was
 * invalidated by a compaction and not yet rebuilt, and neither is a context of zero.
 */
export const currentContext = Effect.fn("Codex.currentContext")(function* (
  client: CodexClient,
  threadId: string,
) {
  yield* client.call("thread/resume", { threadId });
  const deadline = (yield* Clock.currentTimeMillis) + REPLAY_MS;
  for (;;) {
    for (const note of client.notifications()) {
      if (note.method !== "thread/tokenUsage/updated") continue;
      const usage = yield* decoded("thread/tokenUsage/updated", TokenUsage, note.params);
      if (usage.threadId === threadId) return usage.tokenUsage.last.totalTokens;
    }
    if ((yield* Clock.currentTimeMillis) >= deadline) return null;
    yield* Effect.sleep(100);
  }
});

export interface CompactionItem {
  id: string;
  turnId: string;
}

/** Every compaction this thread has recorded, newest first. */
export const compactionItems = Effect.fn("Codex.compactionItems")(function* (
  client: CodexClient,
  threadId: string,
) {
  const items = yield* decoded(
    "thread/items/list",
    ItemsList,
    yield* client.call("thread/items/list", { threadId, sortDirection: "desc", limit: 100 }),
  );
  return items.data
    .filter((entry) => entry.item.type === "contextCompaction")
    .map((entry): CompactionItem => ({ id: entry.item.id, turnId: entry.turnId }));
});

export type TurnOutcome =
  | { readonly kind: "running" }
  | { readonly kind: "completed" }
  | { readonly kind: "failed"; readonly reason: string };

/**
 * What became of the turn a compaction ran in. A compaction is a turn of its own, so
 * this is the protocol's own terminal mapping rather than a guess from idleness:
 * `completed`, or `failed`/`interrupted` with the turn's error where it has one.
 */
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
  const turn = turns.data.find((entry) => entry.id === turnId);
  if (!turn || turn.status === "inProgress") return { kind: "running" } as const;
  if (turn.status === "completed") return { kind: "completed" } as const;
  return {
    kind: "failed",
    reason: turn.error?.message ?? `the compaction turn ${turn.status}`,
  } as const;
});

/** Asks the bound thread to compact. The empty reply acknowledges submission only. */
export const startCompaction = (client: CodexClient, threadId: string) =>
  Effect.asVoid(client.call("thread/compact/start", { threadId }));

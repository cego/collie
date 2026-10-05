// The Flock chat: one warm Agent SDK session on the user's own Claude Code, in Desktop's
// main process beside the channels its tools call. Its session id is minted once and
// resumed on every launch after; Claude Code keeps and compacts the transcript on this
// computer. Collie's tools are its only tools.

import { getSessionInfo, query, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import {
  Cause,
  Crypto,
  Effect,
  FileSystem,
  Option,
  Path,
  PubSub,
  Queue,
  Schema,
  Semaphore,
  Stream,
} from "effect";
import { isJsonObject } from "../../../src/schema";
import { type AguiEvent, ends } from "../shared/agui";
import { startState, step } from "./agui";
import { callFlockTool, FLOCK_TOOLS, type FlockChat } from "./flock-tools";
import { sessionOptions } from "./session";

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

/** The conversation's session id, minted the first time and the same on every launch after. */
const sessionId = Effect.fn("FlockChat.sessionId")(function* (dir: string) {
  const fs = yield* FileSystem.FileSystem;
  const file = (yield* Path.Path).join(dir, "flock-chat.json");
  const saved = yield* fs
    .readFileString(file)
    .pipe(Effect.flatMap(Schema.decodeUnknownEffect(SessionFile)), Effect.option);
  if (Option.isSome(saved)) return saved.value.session;
  const minted = yield* (yield* Crypto.Crypto).randomUUIDv4;
  yield* fs.writeFileString(file, Schema.encodeSync(SessionFile)({ session: minted }));
  return minted;
});

export interface FlockConversation {
  /** One message from the human, and the events of the turn it starts. */
  readonly send: (text: string) => Stream.Stream<AguiEvent>;
}

/**
 * Starts the session and keeps it warm until the scope closes. A session Claude Code has
 * a transcript for is resumed; one it has none of yet starts under the minted id.
 */
export const openFlockChat = Effect.fn("FlockChat.open")(function* (opts: {
  readonly dir: string;
  readonly conversation: string;
  readonly machines: FlockChat["machines"];
}) {
  const fs = yield* FileSystem.FileSystem;
  yield* fs.makeDirectory(opts.dir, { recursive: true });
  const id = yield* sessionId(opts.dir);
  const known = yield* Effect.tryPromise(() => getSessionInfo(id, { dir: opts.dir })).pipe(
    Effect.orElseSucceed(() => undefined),
  );
  let said: string | undefined;
  const services = yield* Effect.context<Crypto.Crypto>();
  const run = (effect: Effect.Effect<string, never, Crypto.Crypto>) =>
    Effect.runPromise(effect.pipe(Effect.provideContext(services)));
  const server = flockServer(
    { machines: opts.machines, conversation: opts.conversation, said: () => said },
    run,
  );
  const inbox = yield* Queue.unbounded<SDKUserMessage>();
  const session = query({
    prompt: Stream.toAsyncIterable(Stream.fromQueue(inbox)),
    options: sessionOptions({
      cwd: opts.dir,
      session: known === undefined ? { sessionId: id } : { resume: id },
      server,
      claude: Bun.which("claude"),
    }),
  });
  yield* Effect.addFinalizer(() => Effect.sync(() => session.close()));
  const events = yield* PubSub.unbounded<AguiEvent>();
  /** Why the session ended, once it has: every turn after it is told at once. */
  let ended: string | null = null;
  const endWith = (why: string) =>
    Effect.suspend(() => {
      ended = why;
      return PubSub.publish(events, { type: "RUN_ERROR", runId: "", message: why });
    });
  yield* Stream.fromAsyncIterable(session, String).pipe(
    Stream.mapAccum(() => startState(id), step),
    Stream.runForEach((event) => PubSub.publish(events, event)),
    Effect.matchCauseEffect({
      onSuccess: () => endWith("Claude Code ended the Flock chat's session."),
      onFailure: (cause) => endWith(Cause.pretty(cause)),
    }),
    Effect.forkScoped,
  );
  // ponytail: one turn at a time; showing a message queued mid-turn is the chat window's.
  const turns = yield* Semaphore.make(1);
  const conversation: FlockConversation = {
    send: (text) =>
      Stream.unwrap(
        Effect.gen(function* () {
          yield* Effect.acquireRelease(turns.take(1), () => turns.release(1));
          if (ended !== null) {
            const refused: AguiEvent = { type: "RUN_ERROR", runId: "", message: ended };
            return Stream.make(refused);
          }
          const heard = yield* PubSub.subscribe(events);
          let finished = false;
          // A turn its reader dropped is interrupted and seen out, so the next starts clean.
          yield* Effect.addFinalizer(() =>
            Effect.sync(() => {
              said = undefined;
            }).pipe(
              Effect.andThen(
                finished
                  ? Effect.void
                  : Effect.tryPromise(() => session.interrupt()).pipe(
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
          yield* Queue.offer(inbox, {
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
  };
  return conversation;
});

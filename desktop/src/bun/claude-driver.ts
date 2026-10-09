// The Flock chat on the user's own Claude Code, through the Agent SDK. Desktop mints the
// session id; the Machine rule and News go in its UserPromptSubmit hook, not the message.

import { homedir } from "node:os";
import {
  Config,
  type Crypto,
  Effect,
  type FileSystem,
  Option,
  Path,
  Queue,
  Schema,
  Stream,
} from "effect";
import { type SdkMessage, startState, step } from "./agui";
import { type ChatDriver, type ContentBlock, type DriverContext, TurnCost } from "./driver";
import { which } from "./login-env";
import { isEffort, sessionOptions } from "./session";
import { transcriptOf } from "./transcript";
import type { FlockChat } from "./flock-tools";

/** A session as the chat drives it. */
export interface ClaudeSession extends AsyncIterable<SdkMessage> {
  readonly interrupt: () => Promise<object | void>;
  readonly close: () => void;
}

/** The Agent SDK's user message, as much of it as the chat sends; claude.ts holds it to the SDK's. */
export interface UserMessage {
  readonly type: "user";
  readonly message: {
    readonly role: "user";
    readonly content: string | Array<ContentBlock>;
  };
  readonly parent_tool_use_id: null;
}

/** What the chat needs of Claude Code: the Agent SDK in Desktop, a script in a test. */
export interface ClaudeCode<Server> {
  readonly query: (params: {
    readonly prompt: AsyncIterable<UserMessage>;
    readonly options: ReturnType<typeof sessionOptions<Server>>;
  }) => ClaudeSession;
  readonly getSessionInfo: (
    id: string,
    options: { dir: string },
  ) => Promise<{ readonly sessionId: string } | undefined>;
  readonly getSessionMessages: (
    id: string,
    options: { dir: string },
  ) => Promise<ReadonlyArray<unknown>>;
  readonly listSessions: (options: { dir: string; limit: number }) => Promise<
    ReadonlyArray<{
      readonly sessionId: string;
      readonly summary: string;
      readonly lastModified: number;
    }>
  >;
  /** Collie's tools as an MCP server in this process. */
  readonly server: (
    flock: FlockChat,
    run: <A>(effect: Effect.Effect<A, never, Crypto.Crypto | FileSystem.FileSystem>) => Promise<A>,
  ) => Server;
}

/** What a turn cost, as Claude Code's result says. */
const TurnResult = Schema.Struct({ type: Schema.Literal("result"), ...TurnCost.fields });
const decodeTurnResult = Schema.decodeUnknownOption(TurnResult);

export const claudeDriver = <Server>(
  claude: ClaudeCode<Server>,
  opts: DriverContext,
): ChatDriver => {
  const server = claude.server(opts.flock, opts.run);
  return {
    // The SDK carries a Claude Code of its own where none is on PATH.
    installed: true,
    open: Effect.fnUntraced(function* (id, model, effort) {
      const known = yield* Effect.tryPromise(() =>
        claude.getSessionInfo(id, { dir: opts.dir }),
      ).pipe(Effect.orElseSucceed(() => undefined));
      const inbox = yield* Queue.unbounded<UserMessage>();
      const session = claude.query({
        prompt: Stream.toAsyncIterable(Stream.fromQueue(inbox)),
        options: sessionOptions({
          cwd: opts.dir,
          session: known === undefined ? { sessionId: id } : { resume: id },
          model,
          effort: isEffort(effort) ? effort : "medium",
          server,
          claude: which("claude"),
          ask: opts.ask,
          noticed: opts.noticed,
          placement: opts.placement,
        }),
      });
      let lastTurn: TurnCost | undefined;
      return {
        conversation: () => id,
        offer: (content) =>
          Queue.offer(inbox, {
            type: "user",
            message: { role: "user", content },
            parent_tool_use_id: null,
          }).pipe(Effect.asVoid),
        events: Stream.fromAsyncIterable(session, String).pipe(
          Stream.tap((message) =>
            Effect.sync(() => {
              lastTurn = Option.getOrElse(decodeTurnResult(message), () => lastTurn);
            }),
          ),
          Stream.mapAccum(() => startState(id), step),
        ),
        interrupt: Effect.tryPromise(() => session.interrupt()).pipe(Effect.ignore),
        close: Effect.sync(() => session.close()),
        lastTurn: () => lastTurn,
        limited: () => false,
      };
    }),
    transcript: (id) =>
      Effect.tryPromise(() => claude.getSessionMessages(id, { dir: opts.dir })).pipe(
        Effect.map(transcriptOf),
        Effect.orElseSucceed(() => []),
      ),
    earlier: (limit) =>
      Effect.tryPromise(() => claude.listSessions({ dir: opts.dir, limit })).pipe(
        Effect.orElseSucceed(() => []),
        Effect.map((sessions) =>
          sessions.map(({ sessionId, summary, lastModified }) => ({
            session: sessionId,
            title: summary,
            at: lastModified,
          })),
        ),
      ),
    transcriptPath: (id) =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const config = yield* Config.String("CLAUDE_CONFIG_DIR").pipe(
          Config.withDefault(path.join(homedir(), ".claude")),
          Effect.orDie,
        );
        return path.join(config, "projects", opts.dir.replace(/[^a-zA-Z0-9]/g, "-"), `${id}.jsonl`);
      }),
  };
};

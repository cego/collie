import * as Str from "effect/String";
import { pipe as pipe_ } from "effect/Function";
import * as Arr from "effect/Array";
import { hostname } from "node:os";
import {
  type Cause,
  Clock,
  Effect,
  FileSystem,
  Option,
  Queue,
  Schema,
  Stream,
  flow,
  Result,
} from "effect";
import * as SecureRandom from "effect/crypto/SecureRandom";
import type { AguiEvent } from "../shared/agui";
import { ends } from "../shared/agui";
import type { ChatDriver, DriverContext, DriverSession, TurnCost } from "./driver";
import type { JsonObject } from "../../../src/schema";
import type { ChatEndpoint } from "./chat-endpoint";
import { childEnv, which } from "./login-env";
import { decodePiRecord, piEvents, piToolName } from "./pi-agui";
import { piPrompt, piSessions } from "./pi-transcript";
import { noticedContext, placementContext, systemPrompt } from "./session";

const TOKEN_ENV = "COLLIE_CHAT_MCP_TOKEN";
const TOOL_TIMEOUT = 24 * 60 * 60;

export const piDriver = (
  context: DriverContext,
  endpoint: ChatEndpoint,
  command: ReadonlyArray<string> | null = which("pi") === null ? null : [which("pi")!],
): ChatDriver => {
  const sessions = `${context.dir}/pi-sessions`;
  const read = Effect.promise(() => context.run(piSessions(sessions)));
  return {
    installed: command !== null,
    open: Effect.fnUntraced(function* (id, model, effort) {
      const { url, token } = yield* endpoint.start;
      // A short private name avoids user overrides and Pi hashing provider tool names.
      const server = `cf-${pipe_(
        yield* Effect.promise(() =>
          context.run(Effect.flatMap(SecureRandom.SecureRandom, (random) => random.uuidV4())),
        ),
        Str.replaceAll("-", ""),
      )}`;
      const extension = `${context.dir}/pi-collie.ts`;
      const source = `export default function(pi) { pi.registerMcpServer("${server}", { url: ${yield* Schema.encodeEffect(Schema.fromJsonString(Schema.String))(url).pipe(Effect.orDie)}, exposure: "direct", timeout: ${TOOL_TIMEOUT}, headers: { Authorization: "Bearer " + process.env.${TOKEN_ENV} } }); }\n`;
      yield* Effect.promise(() =>
        context.run(
          Effect.gen(function* () {
            const fs = yield* FileSystem.FileSystem;
            yield* fs.makeDirectory(sessions, { recursive: true });
            yield* fs.writeFileString(extension, source);
          }).pipe(Effect.orDie),
        ),
      );
      const args = [
        ...(command ?? []),
        "--mode",
        "rpc",
        "--session-dir",
        sessions,
        "--session-id",
        id,
        "--system-prompt",
        systemPrompt(hostname()),
        "--append-system-prompt",
        "",
        "--no-extensions",
        "-e",
        "builtin:mcp",
        "-e",
        extension,
        "--no-skills",
        "--no-prompt-templates",
        "--no-context-files",
        "--tools",
        `read,bash,edit,write,grep,find,ls,mcp__${pipe_(server, Str.replaceAll("-", "_"))}__*`,
      ];
      if (model !== "default") args.push("--model", model);
      if (effort !== null) args.push("--thinking", effort);
      const child = Bun.spawn(args, {
        cwd: context.dir,
        env: { ...childEnv(), [TOKEN_ENV]: token },
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
      });
      let diagnostics = "";
      yield* Stream.fromReadableStream({ evaluate: () => child.stderr, onError: String }).pipe(
        Stream.decodeText,
        Stream.runForEach((text) =>
          Effect.sync(() => {
            diagnostics = pipe_(diagnostics + text, Str.slice(-8000));
          }),
        ),
        Effect.forkScoped,
      );
      const output = yield* Queue.unbounded<AguiEvent, Cause.Done>();
      const state = piEvents(id);
      let started = 0;
      let lastTurn: TurnCost | undefined;
      const write = (record: JsonObject) =>
        Effect.gen(function* () {
          yield* Effect.promise(() =>
            Promise.resolve(
              child.stdin.write(
                `${flow(Schema.encodeResult(Schema.fromJsonString(Schema.Json)), Result.getOrThrow)(record)}\n`,
              ),
            ),
          );
          yield* Effect.promise(() => Promise.resolve(child.stdin.flush()));
        });
      const offer: DriverSession["offer"] = (content) =>
        Effect.gen(function* () {
          yield* endpoint.begin;
          started = yield* Clock.currentTimeMillis;
          yield* Queue.offer(output, state.begin());
          const placement = context.placement();
          const noticed = context.noticed();
          const note = Arr.join(
            Arr.filter(
              [
                placement === undefined ? "" : placementContext(placement),
                noticed === undefined ? "" : noticedContext(noticed),
              ],
              (text) => text !== "",
            ),
            "\n\n",
          );
          yield* write({ type: "prompt", ...piPrompt(content, note) });
        });
      let pending = "";
      yield* Stream.fromReadableStream({ evaluate: () => child.stdout, onError: String }).pipe(
        Stream.decodeText,
        Stream.mapEffect((chunk) =>
          Effect.gen(function* () {
            pending += chunk;
            let at: number;
            while ((at = Option.getOrElse(pipe_(pending, Str.indexOf("\n")), () => -1)) >= 0) {
              const record = decodePiRecord(pipe_(pending, Str.slice(0, at)));
              pending = pipe_(pending, Str.slice(at + 1));
              if (Option.isNone(record)) continue;
              const read = record.value;
              if (
                read.type === "tool_execution_start" &&
                piToolName(read.toolName) === "AskUserQuestion"
              ) {
                yield* endpoint.question(read.toolCallId, read.args);
              }
              const events = state.step(read);
              if (Arr.some(events, ends)) {
                lastTurn = {
                  duration_ms: (yield* Clock.currentTimeMillis) - started,
                  usage: state.usage(),
                };
                yield* endpoint.finish;
              }
              yield* Queue.offerAll(output, events);
            }
          }),
        ),
        Stream.runDrain,
        Effect.ensuring(
          Effect.gen(function* () {
            const code = yield* Effect.promise(() => child.exited);
            yield* Queue.offer(output, {
              type: "RUN_ERROR",
              runId: id,
              message: Str.trim(diagnostics) || `Pi ended its session (exit ${code}).`,
            });
            yield* Queue.end(output);
          }),
        ),
        Effect.forkScoped,
      );
      return {
        conversation: () => id,
        offer,
        events: Stream.fromQueue(output),
        interrupt: write({ type: "abort" }).pipe(Effect.andThen(endpoint.finish)),
        close: Effect.promise(() => Promise.resolve(child.stdin.end())).pipe(
          Effect.ensuring(Effect.sync(() => child.kill())),
          Effect.ensuring(endpoint.finish),
          Effect.ignoreCause,
        ),
        lastTurn: () => lastTurn,
        limited: () => false,
      };
    }),
    transcript: (id) =>
      read.pipe(
        Effect.map(
          (all) =>
            Option.getOrUndefined(Arr.findFirst(all, (session) => session.session === id))
              ?.transcript ?? [],
        ),
      ),
    earlier: (limit) =>
      read.pipe(
        Effect.map((all) =>
          Arr.map(all.slice(0, limit), ({ session, title, at }) => ({ session, title, at })),
        ),
      ),
    transcriptPath: (id) =>
      read.pipe(
        Effect.map(
          (all) =>
            Option.getOrUndefined(Arr.findFirst(all, (session) => session.session === id))?.path ??
            null,
        ),
      ),
  };
};

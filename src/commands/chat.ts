import * as Arr from "effect/Array";
import { Effect, Option, Schema } from "effect";
import { Argument, Command, Flag } from "effect/cli";
import {
  CHAT_HARNESSES,
  CHAT_HARNESS_KEY,
  chatHarnessOf,
  chatPath,
  DEFAULT_CHAT_HARNESS,
  hear,
  isChatHarness,
  pushable,
  readChat,
  whyUnavailable,
} from "../chat";
import { writeConfigValue } from "../config";
import {
  asText as newsText,
  NATIVE,
  newsPath,
  pending as pendingNews,
  read as readNews,
  uncertain as uncertainNews,
} from "../news";
import {
  chatContextFor,
  claudeSettingsPath,
  installStatusLine,
  statusLineFor,
} from "../statusline";
import { err, newRequestId } from "../operations";
import { settleNewsFor } from "../lifecycle";
import { machineHerd } from "../steering";
import { isJsonObject } from "../schema";
import { TOOLS, toolNamed } from "../tools";
import { UnknownJson, answering, requestIdFlag, stdinText } from "./shared";
import { mutation } from "../envelope";

const status = Command.make("status", {}, () =>
  answering((env) =>
    Effect.gen(function* () {
      const chosen = yield* chatHarnessOf(env.userDir);
      const key = yield* machineHerd(env).pipe(Effect.orElseSucceed(() => null));
      const record = key === null ? null : yield* readChat(yield* chatPath(env.stateDir, key));
      const unavailable = whyUnavailable(chosen, Bun.which(chosen));
      const delivery = pushable(chosen);
      const lines = key === null ? [] : yield* readNews(yield* newsPath(env.stateDir, key));
      const batch = pendingNews(lines);
      const unsettled = uncertainNews(lines);
      const pending = record !== null && record.harness !== chosen ? chosen : null;
      return {
        ok: true as const,
        data: {
          running: record?.harness ?? null,
          session: record === null ? null : (record.sessions[record.harness] ?? null),
          preference: chosen,
          pending,
          unavailable,
          delivery,
          waiting: batch.items.length,
          omitted: batch.omitted,
          uncertain: unsettled,
        },
        human: Arr.join(
          [
            `running\t${record?.harness ?? "nothing"}`,
            `preference\t${chosen}${pending === null ? "" : "\tnext launch"}`,
            unavailable === null ? `${chosen}\tinstalled` : `${chosen}\t${unavailable}`,
            `delivery\t${delivery.proven ? "push" : "on the next turn"}\t${delivery.how}`,
            `waiting\t${batch.items.length}${batch.omitted > 0 ? ` (+${batch.omitted} older)` : ""}`,
            ...(unsettled.length === 0 ? [] : [`uncertain\t${Arr.join(unsettled, ", ")}`]),
          ],
          "\n",
        ),
      };
    }),
  ),
).pipe(Command.withDescription("Which harness this Herd's conversation is in, and which is next"));

const harness = Command.make(
  "harness",
  {
    harness: Argument.String("harness").pipe(
      Argument.withDescription(
        `Which native chat Collie opens with: ${Arr.join(CHAT_HARNESSES, ", ")}`,
      ),
      Argument.optional,
    ),
    requestId: requestIdFlag,
  },
  ({ harness, requestId }) =>
    answering((env) =>
      Effect.gen(function* () {
        const chosen = Option.getOrNull(harness);
        if (chosen === null) {
          const now = yield* chatHarnessOf(env.userDir);
          return { ok: true as const, data: { preference: now }, human: now };
        }
        if (!isChatHarness(chosen))
          return err("invalid_input", `Chat is ${Arr.join(CHAT_HARNESSES, " or ")}.`);
        return yield* mutation(env, "chat-harness", requestId, () =>
          Effect.gen(function* () {
            yield* writeConfigValue(env.userDir, CHAT_HARNESS_KEY, chosen);
            return {
              ok: true as const,
              data: { preference: chosen },
              human: `Collie's next chat launch uses ${chosen}. Nothing running was touched.`,
            };
          }),
        );
      }),
    ),
).pipe(Command.withDescription("Choose which native chat Collie opens with next"));

const news = Command.make(
  "news",
  {
    sent: Flag.Boolean("sent").pipe(
      Flag.withDescription("Mark the current batch as submitted to the harness, not as read"),
      Flag.withDefault(false),
    ),
    uncertain: Flag.Boolean("uncertain").pipe(
      Flag.withDescription("Mark it as a send nobody can account for; it stays pending"),
      Flag.withDefault(false),
    ),
  },
  ({ sent, uncertain: unsure }) =>
    answering((env) =>
      Effect.gen(function* () {
        const key = yield* machineHerd(env).pipe(Effect.orElseSucceed(() => null));
        if (key === null) return err("invalid_state", "Collie cannot reach core.");
        const settled =
          sent || unsure
            ? yield* settleNewsFor(env, {
                door: "chat",
                herd: key,
                conversation: NATIVE,
                as: unsure ? "uncertain" : "sent",
                request: yield* newRequestId(),
              })
            : null;
        if (settled !== null && !settled.ok) return settled;
        const batch =
          settled?.value ??
          pendingNews(yield* readNews(yield* newsPath(env.stateDir, key)), NATIVE);
        return {
          ok: true as const,
          data: { count: batch.items.length, omitted: batch.omitted, text: newsText(batch) },
          human: newsText(batch),
        };
      }),
    ),
).pipe(Command.withDescription("What Collie has noticed that nobody has read yet"));

const statusLine = Command.make(
  "status-line",
  {
    install: Flag.Boolean("install").pipe(
      Flag.withDescription("Configure Claude Code to print it (what setup.sh runs)"),
      Flag.withDefault(false),
    ),
  },
  ({ install }) =>
    answering((env) =>
      Effect.gen(function* () {
        if (install) {
          const said = yield* installStatusLine(env);
          return {
            ok: true as const,
            data: { settings: yield* claudeSettingsPath(env) },
            human: said,
          };
        }
        const line = yield* statusLineFor(env);
        return { ok: true as const, data: { line }, human: line };
      }),
    ),
).pipe(Command.withDescription("The board's selection, as Claude Code's status line"));

const context = Command.make("context", {}, () =>
  answering((env) =>
    Effect.map(chatContextFor(env), (context) => ({
      ok: true as const,
      data: { context },
      human: context,
    })),
  ),
).pipe(
  Command.withDescription(
    "The Standing direction and the board's selection, as a chat prompt's context",
  ),
);

const heard = Command.make("heard", {}, () =>
  answering((env) =>
    Effect.gen(function* () {
      yield* hear(env, yield* stdinText);
      return { ok: true as const, data: {}, human: "" };
    }),
  ),
).pipe(Command.withDescription("Keep this turn's prompt for chat's actions (Claude's hook)"));

const list = Command.make("list", {}, () =>
  answering(() =>
    Effect.succeed({
      ok: true as const,
      data: {
        tools: Arr.map(TOOLS, ({ name, title, description, input, readOnly }) => ({
          name,
          title,
          description,
          input,
          readOnly,
        })),
      },
      human: Arr.join(
        Arr.map(
          TOOLS,
          (tool) => `${tool.name}\t${tool.title}\t${tool.readOnly ? "reads" : "writes"}`,
        ),
        "\n",
      ),
    }),
  ),
).pipe(Command.withDescription("The reads native chat may make"));

const call = Command.make(
  "call",
  {
    tool: Argument.String("tool").pipe(
      Argument.withDescription("The tool, as `tools list` names it"),
    ),
    input: Flag.String("input").pipe(
      Flag.withDescription("The tool's arguments as JSON; omit for a tool that takes none"),
      Flag.optional,
    ),
  },
  ({ tool, input }) =>
    answering((env) =>
      Effect.gen(function* () {
        const found = toolNamed(tool);
        if (found === null) return err("invalid_input", `No tool "${tool}".`);
        const decoded = Schema.decodeOption(UnknownJson)(Option.getOrElse(input, () => "{}"));
        if (decoded._tag === "None" || !isJsonObject(decoded.value))
          return err("invalid_input", "--input is a JSON object.");
        const text = yield* found.call(env, decoded.value);
        return { ok: true as const, data: { tool, text }, human: text };
      }),
    ),
).pipe(Command.withDescription("Make one of those reads"));

export const tools = Command.make("tools").pipe(
  Command.withDescription("The Collie reads native chat is given, and a way to make them yourself"),
  Command.withSubcommands([list, call]),
);

export const chat = Command.make("chat").pipe(
  Command.withDescription(`The Home's native conversation (default ${DEFAULT_CHAT_HARNESS})`),
  Command.withSubcommands([status, harness, news, statusLine, context, heard]),
);

export const mcp = Command.make("mcp", {}, () =>
  Effect.promise(() => import("../mcp")).pipe(Effect.flatMap(({ serveMcp }) => serveMcp())),
).pipe(
  Command.withDescription("Serve Collie's reads over MCP on stdin/stdout (used by native chat)"),
);

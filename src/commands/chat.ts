// The conversation half of the Home, from the terminal: which harness it opens with,
// what is running now, and the reads native chat itself makes.
//
// `tools` is here because it is the other front door onto the same contract: Claude
// reaches it over MCP and Pi through its extension, and both of those are adapters over
// what this prints. One implementation, three ways in.

import { Effect, Option, Schema } from "effect";
import { Argument, Command, Flag } from "effect/unstable/cli";
import {
  CHAT_HARNESSES,
  CHAT_HARNESS_KEY,
  chatHarnessOf,
  chatPath,
  DEFAULT_CHAT_HARNESS,
  isChatHarness,
  pushable,
  readChat,
  whyUnavailable,
} from "../chat";
import { writeConfigValue } from "../config";
import {
  asText as newsText,
  newsPath,
  pending as pendingNews,
  read as readNews,
  settle as settleNews,
  uncertain as uncertainNews,
} from "../news";
import { claudeSettingsPath, installStatusLine, promptLineFor, statusLineFor } from "../statusline";
import { err } from "../operations";
import { herdOf } from "../steering";
import { isJsonObject } from "../schema";
import { TOOLS, toolNamed } from "../tools";
import { UnknownJson, answering, requestIdFlag } from "./shared";
import { mutation } from "../envelope";

/**
 * What is running and what is chosen, kept apart. A preference the human changed while
 * Claude was mid-answer is a *pending* fact, not a description of the pane in front of
 * them, and saying otherwise is how a setting reads as an interruption that never came.
 */
const status = Command.make("status", {}, () =>
  answering((env) =>
    Effect.gen(function* () {
      const chosen = yield* chatHarnessOf(env.userDir);
      const key = yield* herdOf(env.socketPath).pipe(Effect.catch(() => Effect.succeed(null)));
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
        human: [
          `running\t${record?.harness ?? "nothing"}`,
          `preference\t${chosen}${pending === null ? "" : "\tnext launch"}`,
          unavailable === null ? `${chosen}\tinstalled` : `${chosen}\t${unavailable}`,
          // Two different questions, answered apart: whether there is a conversation, and
          // whether Collie can interrupt it. Claude has one and not the other here.
          `delivery\t${delivery.proven ? "push" : "on the next turn"}\t${delivery.how}`,
          `waiting\t${batch.items.length}${batch.omitted > 0 ? ` (+${batch.omitted} older)` : ""}`,
          ...(unsettled.length === 0 ? [] : [`uncertain\t${unsettled.join(", ")}`]),
        ].join("\n"),
      };
    }),
  ),
).pipe(Command.withDescription("Which harness this Herd's conversation is in, and which is next"));

/**
 * The launch preference. It changes what opens **next**; it never stops, replaces or
 * summarises a conversation that is already running, and it changes nothing about the
 * harnesses workers run on.
 */
const harness = Command.make(
  "harness",
  {
    harness: Argument.String("harness").pipe(
      Argument.withDescription(`Which native chat Collie opens with: ${CHAT_HARNESSES.join(", ")}`),
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
          return err("invalid_input", `Chat is ${CHAT_HARNESSES.join(" or ")}.`);
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

/**
 * The pending batch, and what became of it. Not a command a human needs: it is what the
 * Pi extension calls when the news journal changes, so the harness's own queue carries
 * facts Collie wrote rather than text typed at an editor.
 */
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
        const key = yield* herdOf(env.socketPath).pipe(Effect.catch(() => Effect.succeed(null)));
        if (key === null) return err("invalid_state", "Collie cannot reach herdr.");
        const file = yield* newsPath(env.stateDir, key);
        const batch = pendingNews(yield* readNews(file));
        // `sent` and `uncertain` are facts about a transport, never about a conversation.
        // Only `collie_news` being read settles an item, because only that shows it
        // arrived somewhere that could act on it.
        for (const item of batch.items)
          if (sent || unsure) yield* settleNews(file, item.key, unsure ? "uncertain" : "sent");
        return {
          ok: true as const,
          data: { count: batch.items.length, omitted: batch.omitted, text: newsText(batch) },
          human: newsText(batch),
        };
      }),
    ),
).pipe(Command.withDescription("What Collie has noticed that nobody has read yet"));

/**
 * What Claude Code prints under the chat prompt, and the one-off that configures it.
 *
 * Printed on every redraw, so it reads one small file and nothing else. `--install` is
 * `setup.sh`'s step: the setting is in the human's own Claude Code config, which is
 * `setup.sh`'s business exactly as the keybindings are and never `prepare.sh`'s.
 */
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

/**
 * What Claude Code's `UserPromptSubmit` hook attaches to a prompt: the card the board has
 * open, or nothing. Run on every message the human sends, so it reads one small file.
 */
const context = Command.make("context", {}, () =>
  answering((env) =>
    Effect.map(promptLineFor(env), (line) => ({ ok: true as const, data: { line }, human: line })),
  ),
).pipe(Command.withDescription("The board's selection, as a chat prompt's context"));

const list = Command.make("list", {}, () =>
  answering(() =>
    Effect.succeed({
      ok: true as const,
      data: {
        tools: TOOLS.map(({ name, title, description, input, readOnly }) => ({
          name,
          title,
          description,
          input,
          readOnly,
        })),
      },
      human: TOOLS.map(
        (tool) => `${tool.name}\t${tool.title}\t${tool.readOnly ? "reads" : "writes"}`,
      ).join("\n"),
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
        const decoded = Schema.decodeUnknownOption(UnknownJson)(
          Option.getOrElse(input, () => "{}"),
        );
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
  Command.withSubcommands([status, harness, news, statusLine, context]),
);

/**
 * The MCP server Claude Code is launched against. Not a command anyone types: it speaks
 * the protocol on stdin and stdout, so a human running it sees nothing happen.
 * Load its protocol schemas only here, not for every unrelated CLI invocation.
 */
export const mcp = Command.make("mcp", {}, () =>
  Effect.promise(() => import("../mcp")).pipe(Effect.flatMap(({ serveMcp }) => serveMcp())),
).pipe(
  Command.withDescription("Serve Collie's reads over MCP on stdin/stdout (used by native chat)"),
);

// What the Flock chat's window says of a tool call and of the card a message is about. No
// Bun-only import: the view bundles this.

import { Effect, Option, Schema, Stream } from "effect";
import { isString } from "../../../src/schema";
import { AttachmentPart, attachedIn } from "./attachments";
import { harnessLabel } from "./flock-settings";

/** The board's card a message goes with, named as the chat's tools name it. */
export const About = Schema.Struct({
  machine: Schema.String,
  task: Schema.String,
  run: Schema.String,
  name: Schema.String,
});
export type About = typeof About.Type;

export const aboutLine = (about: About) => `${about.machine} › ${about.name}`;

const ABOUT =
  '[Desktop: the human sent this message about this card of the board; "this one" means it]';
const AboutJson = Schema.fromJsonString(About);
const decodeAboutJson = Schema.decodeUnknownOption(AboutJson);

/** The block the model is handed after the human's words: the card, as data. */
export const aboutNote = (about: About) => `${ABOUT}\n${Schema.encodeSync(AboutJson)(about)}`;

/** The card a block of Desktop's names, or null for any other text. */
export const fromAboutNote = (text: string): About | null => {
  const [first, json, ...rest] = text.split("\n");
  return first !== ABOUT || json === undefined || rest.length > 0
    ? null
    : Option.getOrNull(decodeAboutJson(json));
};

/** How a turn Desktop starts about News begins, which is how the window tells it from the human's. */
export const DESKTOP_SAID = "Desktop noticed, while you were not asked:";

/** When a turn Desktop started of its own begins and ends. */
export const DesktopTurn = Schema.Literals(["started", "ended"]);
export type DesktopTurn = typeof DesktopTurn.Type;

/** The human's choices, keyed by question, as AskUserQuestion takes them. */
export const Answers = Schema.Record(Schema.String, Schema.String);
export type Answers = typeof Answers.Type;

/** A conversation one harness had before the current one. */
export const Earlier = Schema.Struct({
  session: Schema.String,
  title: Schema.String,
  at: Schema.Number,
});
export type Earlier = typeof Earlier.Type;

/** The current conversation and the earlier ones of every harness, newest first. */
export const Conversations = Schema.Struct({
  current: Schema.String,
  earlier: Schema.Array(Schema.Struct({ ...Earlier.fields, harness: Schema.String })),
});
export type Conversations = typeof Conversations.Type;

/** The Earlier conversations menu: each entry with its harness's name, and where opening one moves the chat. */
export const earlierMenu = ({ earlier }: Conversations, set: string) => {
  const others = [...new Set(earlier.map(({ harness }) => harness))].filter(
    (harness) => harness !== set,
  );
  return {
    entries: earlier.map((entry) => ({ ...entry, label: harnessLabel(entry.harness) })),
    moves:
      others.length === 0
        ? null
        : others
            .map(harnessLabel)
            .map((label) => `Opening a ${label} conversation moves the chat to ${label}.`)
            .join(" "),
  };
};

const Named = Schema.Struct({
  run: Schema.optionalKey(Schema.String),
  workspace: Schema.optionalKey(Schema.String),
});
const Asked = Schema.Struct({
  ...Named.fields,
  reason: Schema.optionalKey(Schema.String),
  actions: Schema.optionalKey(
    Schema.Array(Schema.Struct({ kind: Schema.String, ...Named.fields })),
  ),
});
const decodeAsked = Schema.decodeUnknownOption(Schema.fromJsonString(Asked));

const split = (id: string) => {
  const at = id.indexOf(":");
  return at < 0 ? { machine: null, id } : { machine: id.slice(0, at), id: id.slice(at + 1) };
};

/** A tool call as one row: the tool, the Machine its ids name, and a short summary of the rest. */
export const toolRow = (name: string, args: string) => {
  const tool = name.replace(/^mcp__collie__(collie_)?/, "");
  const asked = Option.getOrElse(decodeAsked(args), (): typeof Asked.Type => ({}));
  const ids = [asked, ...(asked.actions ?? [])].flatMap(({ run, workspace }) =>
    [run, workspace].filter(isString).map(split),
  );
  const machines = [...new Set(ids.flatMap(({ machine }) => (machine === null ? [] : [machine])))];
  const named = (thing: typeof Named.Type) =>
    [thing.run, thing.workspace].filter(isString).map((id) => split(id).id);
  const summary =
    asked.actions === undefined
      ? [...named(asked), ...[asked.reason].filter(isString)].join(" · ")
      : asked.actions.map((action) => [action.kind, ...named(action)].join(" ")).join(", ");
  return { tool, machine: machines.length === 0 ? null : machines.join(", "), summary };
};

const Part = Schema.Union([
  Schema.Struct({ type: Schema.Literals(["text", "thinking"]), content: Schema.String }),
  AttachmentPart,
  Schema.Struct({
    type: Schema.Literal("tool-call"),
    id: Schema.String,
    name: Schema.String,
    arguments: Schema.String,
    state: Schema.Literal("complete"),
    output: Schema.optionalKey(Schema.String),
  }),
]);

/** A message of a conversation already had, in the parts TanStack AI's client draws. */
export const ChatMessage = Schema.Struct({
  id: Schema.String,
  role: Schema.Literals(["user", "assistant"]),
  parts: Schema.Array(Part),
  metadata: Schema.optionalKey(Schema.Struct({ about: Schema.optionalKey(About) })),
});
export type ChatMessage = typeof ChatMessage.Type;

export const Questions = Schema.Struct({
  questions: Schema.Array(
    Schema.Struct({
      question: Schema.String,
      header: Schema.String,
      options: Schema.Array(
        Schema.Struct({ label: Schema.String, description: Schema.optionalKey(Schema.String) }),
      ),
      multiSelect: Schema.optionalKey(Schema.Boolean),
    }),
  ),
});
const decodeQuestions = Schema.decodeUnknownOption(Schema.fromJsonString(Questions));

/** What an AskUserQuestion call asks, once its arguments have all arrived. */
export const questionsOf = (args: string) =>
  Option.match(decodeQuestions(args), { onNone: () => [], onSome: ({ questions }) => questions });

/** A message the chat client holds back while a reply streams, as TanStack AI's client keeps it. */
export interface Queued {
  readonly content:
    | string
    | {
        readonly content:
          | string
          | ReadonlyArray<{ readonly type: string; readonly content?: unknown }>;
        readonly metadata?: { readonly about?: unknown };
      };
}

const decodeAbout = Schema.decodeUnknownOption(About);

/**
 * The message box once Stop has put the queue back, since the client discards it: the queued
 * words first, a paragraph each, the files after those already attached, and the first queued
 * card where the chip is empty.
 */
export const putBack = (queued: ReadonlyArray<Queued>, draft: string, chip: About | null) => {
  const said = queued.map(({ content }) => (isString(content) ? { content } : content));
  const words = said.flatMap(({ content }) =>
    isString(content)
      ? [content]
      : content.flatMap((part) =>
          part.type === "text" && isString(part.content) ? [part.content] : [],
        ),
  );
  return {
    draft: [...words, draft.trim()].filter((one) => one.trim() !== "").join("\n\n"),
    files: said.flatMap(({ content }) =>
      isString(content) ? [] : content.flatMap((part) => Option.toArray(attachedIn(part))),
    ),
    chip:
      chip ??
      said
        .map((one) => ("metadata" in one ? decodeAbout(one.metadata?.about) : Option.none()))
        .find(Option.isSome)?.value ??
      null,
  };
};

/** The message box's submit button: Stop while the human's reply is under way, else Send. */
export const submitButton = (status: "ready" | "submitted" | "streaming" | "error") =>
  status === "submitted" || status === "streaming"
    ? { status, label: "Stop the reply" }
    : { status: "ready" as const, label: "Send" };

/** What the window's status region has to say about. */
export interface Heard {
  readonly replying: boolean;
  readonly stopped: boolean;
  readonly notice: string | null;
}

/**
 * What the status region holds as `was` becomes `now`: what to announce, else empty, so the
 * same words announce again later; null where nothing changed. A reply finishing is not said.
 */
export const announcement = (was: Heard, now: Heard): string | null => {
  if (was.replying === now.replying && was.stopped === now.stopped && was.notice === now.notice)
    return null;
  return [
    now.replying && !was.replying ? "Replying…" : null,
    now.stopped && !was.stopped ? "Reply stopped" : null,
    now.notice !== null && now.notice !== was.notice ? now.notice : null,
  ]
    .filter((one) => one !== null)
    .join(" ");
};

/** `stream` until `signal` aborts, when it is interrupted and its finalizers run. */
export const untilAborted = <A, E, R>(
  stream: Stream.Stream<A, E, R>,
  signal?: AbortSignal,
): Stream.Stream<A, E, R> =>
  signal === undefined
    ? stream
    : Stream.suspend(() =>
        signal.aborted
          ? Stream.empty
          : stream.pipe(
              Stream.interruptWhen(
                Effect.callback<void>((resume) => {
                  const aborted = () => resume(Effect.void);
                  signal.addEventListener("abort", aborted, { once: true });
                  if (signal.aborted) aborted();
                  return Effect.sync(() => signal.removeEventListener("abort", aborted));
                }),
              ),
            ),
      );

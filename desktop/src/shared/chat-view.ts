// What the Flock chat's window says of a tool call and of the card a message is about. No
// Bun-only import: the view bundles this.

import * as Str from "effect/String";
import * as Arr from "effect/Array";
import { pipe } from "effect/Function";
import { Option, Schema, flow, Result } from "effect";
import { isString } from "../../../src/schema";
import { AttachmentPart } from "./attachments";

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
export const aboutNote = (about: About) =>
  `${ABOUT}\n${flow(Schema.encodeResult(AboutJson), Result.getOrThrow)(about)}`;

/** The card a block of Desktop's names, or null for any other text. */
export const fromAboutNote = (text: string): About | null => {
  const [first, json, ...rest] = Str.split(text, "\n");
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

/** A conversation as its harness lists it. */
export const Earlier = Schema.Struct({
  session: Schema.String,
  title: Schema.String,
  at: Schema.Finite,
});
export type Earlier = typeof Earlier.Type;

/** A conversation and the harness it is held on. */
export const HeldConversation = Schema.Struct({ session: Schema.String, harness: Schema.String });
export type HeldConversation = typeof HeldConversation.Type;

/** Each harness the chat runs on, by the name its maker gives it. */
const HARNESS_NAMES = new Map([
  ["claude", "Claude Code"],
  ["pi", "Pi"],
]);
export const harnessName = (harness: string) => HARNESS_NAMES.get(harness) ?? harness;

/** The current conversation and the earlier ones that can be reopened, newest first. */
export const Conversations = Schema.Struct({
  current: Schema.String,
  earlier: Schema.Array(Schema.Struct({ ...Earlier.fields, harness: Schema.String })),
});
export type Conversations = typeof Conversations.Type;

/** What opening a conversation held on another harness than `set` does, where one is listed. */
export const earlierNote = (earlier: Conversations["earlier"], set: string) => {
  const others = [
    ...new Set(
      Arr.flatMap(earlier, ({ harness }) => (harness === set ? [] : [harnessName(harness)])),
    ),
  ];
  if (others.length === 0) return null;
  return others.length === 1
    ? `Opening a ${others[0]} conversation moves the chat to ${others[0]}.`
    : `Opening a ${Arr.join(others, " or ")} conversation moves the chat to its harness.`;
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
  const at = Option.getOrElse(pipe(id, Str.indexOf(":")), () => -1);
  return at < 0
    ? { machine: null, id }
    : { machine: pipe(id, Str.slice(0, at)), id: pipe(id, Str.slice(at + 1)) };
};

/** A tool call as one row: the tool, the Machine its ids name, and a short summary of the rest. */
export const toolRow = (name: string, args: string) => {
  const tool = pipe(name, Str.replace(/^mcp__collie__(collie_)?/, ""));
  const asked = Option.getOrElse(decodeAsked(args), (): typeof Asked.Type => ({}));
  const ids = Arr.flatMap([asked, ...(asked.actions ?? [])], ({ run, workspace }) =>
    Arr.map(Arr.filter([run, workspace], isString), split),
  );
  const machines = [
    ...new Set(Arr.flatMap(ids, ({ machine }) => (machine === null ? [] : [machine]))),
  ];
  const named = (thing: typeof Named.Type) =>
    Arr.map(Arr.filter([thing.run, thing.workspace], isString), (id) => split(id).id);
  const summary =
    asked.actions === undefined
      ? Arr.join([...named(asked), ...Arr.filter([asked.reason], isString)], " · ")
      : Arr.join(
          Arr.map(asked.actions, (action) => Arr.join([action.kind, ...named(action)], " ")),
          ", ",
        );
  return { tool, machine: machines.length === 0 ? null : Arr.join(machines, ", "), summary };
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

// What the Flock chat's window says of a tool call and of the card a message is about. No
// Bun-only import: the view bundles this.

import { Option, Schema } from "effect";
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

/** How a turn Desktop starts about News begins, which is how the window tells it from the human's. */
export const DESKTOP_SAID = "Desktop noticed, while you were not asked:";

/** When a turn Desktop started of its own begins and ends. */
export const DesktopTurn = Schema.Literals(["started", "ended"]);
export type DesktopTurn = typeof DesktopTurn.Type;

/** The human's choices, keyed by question, as AskUserQuestion takes them. */
export const Answers = Schema.Record(Schema.String, Schema.String);
export type Answers = typeof Answers.Type;

/** The current conversation and the earlier ones that can be reopened, newest first. */
export const Conversations = Schema.Struct({
  current: Schema.String,
  earlier: Schema.Array(
    Schema.Struct({ session: Schema.String, title: Schema.String, at: Schema.Number }),
  ),
});
export type Conversations = typeof Conversations.Type;

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
});
export type ChatMessage = typeof ChatMessage.Type;

const Questions = Schema.Struct({
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

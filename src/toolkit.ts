// The tools a conversation may call on Collie, as one Effect Toolkit: what each takes, what
// it says when it refuses, and how a call's result becomes the sentence chat is answered
// with. No effects and nothing Bun-only, so Native chat's tool host (`tools.ts`) and
// Desktop's Flock chat serve the same definitions.

import * as Struct from "effect/Struct";
import * as Arr from "effect/Array";
import * as Rec from "effect/Record";
import { Context, Effect, Option, Result, Schema, Stream } from "effect";
import * as AiError from "effect/ai/AiError";
import * as Tool from "effect/ai/Tool";
import * as Toolkit from "effect/ai/Toolkit";
import { ActionSchema } from "./actions";
import {
  ASKED_KINDS,
  headerSentence,
  mrLabel,
  sectionOf,
  SECTIONS,
  type TaskView,
  mrNounOf,
} from "./board-model";
import { isString, type JsonObject } from "./schema";

/**
 * A key a tool does not take is refused, never stripped. Effect strips by default, and
 * a model that passed `goal` beside a start and was told "started" believes the goal is
 * in force while the Run runs without it. The refusal names the key so it can be acted on.
 */
export const STRICT = { onExcessProperty: "error", errors: "all" } as const;

export const decodeStrict = <S extends Schema.ConstraintDecoder<unknown, never>>(schema: S) => {
  const decode = Schema.decodeUnknownResult(schema, STRICT);
  return (input: JsonObject): Result.Result<S["Type"], string> =>
    Result.mapError(decode(input), (error) => error.message);
};

export const RunInput = Schema.Struct({ run: Schema.optionalKey(Schema.String) });
export const HoldInput = Schema.Struct({
  run: Schema.optionalKey(Schema.String.annotate({ description: "The Run to hold" })),
  workspace: Schema.optionalKey(
    Schema.String.annotate({ description: "Hold every unfinished Run in this workspace" }),
  ),
  reason: Schema.optionalKey(
    Schema.String.annotate({ description: "Why, in the human's own words" }),
  ),
});
export const DefinitionInput = Schema.Struct({
  workflow: Schema.optionalKey(
    Schema.String.annotate({ description: "Show this Workflow, checked" }),
  ),
  persona: Schema.optionalKey(
    Schema.String.annotate({ description: "Show this Persona's instructions" }),
  ),
});

/** What a tool says when it will not act: tagged, so a model can tell it from an answer. */
export const refused = (tool: string, why: string, takes: string) =>
  `${tool} refused the request (InvalidInput): ${why}. Nothing was done. ${takes}`;

/** What a proposal's actions may be, decoded at this boundary and nowhere later. */
export const ProposeInput = Schema.Struct({
  interpretation: Schema.String,
  actions: Schema.Array(ActionSchema),
  request_id: Schema.optionalKey(Schema.String),
});

/**
 * The board's decisions, which are not actions on a Run: a yes to a proposal, a no, and
 * what became of finished work. Chat takes them as the human takes them on the board.
 */
const SettleSchema = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("confirm"),
    proposal: Schema.String,
    /** The hash of exactly those actions, as `collie_receipts` lists it beside the id. */
    hash: Schema.String,
  }),
  Schema.Struct({ kind: Schema.Literal("decline"), proposal: Schema.String, hash: Schema.String }),
  Schema.Struct({
    kind: Schema.Literal("disposition"),
    run: Schema.String,
    became: Schema.Literals(["merged", "abandoned", "superseded"]),
    /** What backs it up: a merge request, a commit, or the Run that took the work over. */
    ref: Schema.optionalKey(Schema.String),
  }),
  /** A finished Run's report acknowledged, for every board in the Flock. */
  Schema.Struct({ kind: Schema.Literal("seen"), run: Schema.String }),
]);
export type Settle = Schema.Schema.Type<typeof SettleSchema>;
export const SETTLE_KINDS = ["confirm", "decline", "disposition", "seen"] as const;

const AskedInput = Schema.Struct({
  actions: Schema.Array(Schema.Union([ActionSchema, SettleSchema])),
});
export const decodeAsked = decodeStrict(AskedInput);

/** Each action kind's member of the closed unions, so a refusal can speak in its terms. */
const MEMBERS = new Map<
  string,
  (typeof ActionSchema.members | typeof SettleSchema.members)[number]
>(
  Arr.map([...ActionSchema.members, ...SettleSchema.members], (member) => [
    member.fields.kind.literal,
    member,
  ]),
);

/**
 * What `collie_do` is called with: `AskedInput`, except that an action about one Run may
 * leave `run` out for the board's selection to stand in. Decoded again once it has.
 */
const DoInput = Schema.Struct({
  actions: Schema.Array(
    Schema.Union(
      Arr.map([...MEMBERS.values()], (member) =>
        "run" in member.fields
          ? member.mapFields((fields) => ({ ...fields, run: Schema.optionalKey(Schema.String) }))
          : member,
      ),
    ),
  ),
});

/**
 * Why a request's actions were refused, per action and in the model's own terms: a kind
 * that does not exist, a key the kind does not take and what it does take, or the one
 * member's own complaint — never the whole union spelled out. Empty where the trouble is
 * elsewhere, and the schema's own message stands.
 */
function wrongActions(input: JsonObject): string[] {
  const loose = decodeLoose(input);
  if (loose._tag === "None") return [];
  return Arr.flatMap(loose.value.actions, (action, at) => {
    const kind = isString(action["kind"]) ? action["kind"] : JSON.stringify(action["kind"] ?? null);
    const member = MEMBERS.get(kind);
    if (!member)
      return [
        `actions[${at}] has kind ${kind}, which is none of ${Arr.join([...MEMBERS.keys()], ", ")}`,
      ];
    const takes = Struct.keys(member.fields);
    const extra = Arr.filter(
      Struct.keys(action),
      (key) => !Arr.some(takes, (name) => name === key),
    );
    if (extra.length === 0) {
      const own = decodeStrict(member)(action);
      return Result.isFailure(own) ? [`actions[${at}] (kind "${kind}"): ${own.failure}`] : [];
    }
    const hints = Arr.filter(
      [
        extra.includes("goal") ? 'a Run\'s goal is an Input: put it in "inputs"' : null,
        extra.includes("constraints") || extra.includes("constraint")
          ? "constraints are added with update_intent on the started Run, or update_defaults on the workspace before it starts"
          : null,
      ],
      (hint) => hint !== null,
    );
    return [
      `actions[${at}] (kind "${kind}") does not take ${Arr.join(extra, ", ")}; a ${kind} takes ${Arr.join(takes, ", ")}${hints.length > 0 ? ` (${Arr.join(hints, "; ")})` : ""}`,
    ];
  });
}

export const refusedActions = (tool: string, input: JsonObject, why: string, takes: string) => {
  const wrong = wrongActions(input);
  return refused(tool, wrong.length > 0 ? Arr.join(wrong, "; ") : why, takes);
};

/**
 * A Collie tool: it answers in a sentence, a refusal included, and it is allowed without
 * asking — every one carries out what the human asked for in this conversation (ADR-0011).
 */
const collieTool = <const Name extends string, P extends Schema.Constraint>(
  name: Name,
  options: {
    readonly title: string;
    /**
     * Whether this tool leaves everything as it found it. Said per tool rather than once
     * for the file, because a client uses it to decide what to run without asking: reading
     * the news settles the items it returns, and proposing writes to the journal.
     */
    readonly readOnly: boolean;
    readonly description: string;
    readonly parameters: P;
  },
) =>
  Tool.make(name, {
    description: options.description,
    parameters: options.parameters,
    success: Schema.String,
    failureMode: "return",
    needsApproval: false,
  })
    .annotate(Tool.Title, options.title)
    .annotate(Tool.Readonly, options.readOnly);

export const CollieTools = Toolkit.make(
  collieTool("collie_herd", {
    readOnly: true,
    title: "The Herd",
    description:
      "The board as the human sees it, card for card: its header sentence, then every " +
      "card under Needs you, Working, Waiting on you and Finished with its run id, state, " +
      "merge request or branch, agents and sentence. Herd-wide and never narrowed by what " +
      "the board is filtered to or which card is open; where more cards exist than fit, " +
      "the answer says how many were left out. Read this before answering anything about " +
      "the flock, and again when the answer has to be current.",
    parameters: Schema.Struct({ machine: Schema.optionalKey(Schema.String) }),
  }),
  collieTool("collie_run", {
    readOnly: true,
    title: "One Run",
    description:
      "One Run in detail: its goal, the constraints bounding it, the Choice it is waiting " +
      "on with every option and the collie_do action that answers it, each Choice already " +
      "answered with who answered it and when, what it ended with, the Runs it started, " +
      "its merge request with the state and checks the merge watch last recorded and its " +
      "branch, where its plan is, its findings, disposition and outcome to prove, the last " +
      "lines it recorded, the offers it makes now and why any is unavailable, " +
      "the work it has handed over with the evidence and the gaps in it, " +
      "and any drift nobody has settled. Use it when a question is about a particular Run " +
      "rather than the flock. " +
      "Name the Run; with no `run` it answers about whatever the board has selected, and " +
      "says which that was.",
    parameters: RunInput.mapFields((fields) => ({
      run: fields.run.annotate({
        description: "The Run id, as collie_herd lists it; omit for the board's selection",
      }),
    })),
  }),
  collieTool("collie_workspaces", {
    readOnly: true,
    title: "Where work can be started",
    description:
      "The workspaces this herdr session has, with the directory each stands for, the Tasks " +
      "whose workspace is still open, the Projects root, and each workflow that can be " +
      "started with the Inputs it takes. Read this before proposing a launch: a Run belongs " +
      "to the workspace whose repository it is about, and the Home is Collie's own " +
      "namespace, not anybody's checkout. A start may also name a checkout's path — a path " +
      "on the Machine the start goes to — or a repository's directory name under that " +
      "Machine's Projects root: a directory none is open on gets a workspace opened on it, " +
      "so a repository missing from this list is no reason to send the human to the board.",
    parameters: Tool.EmptyParams,
  }),
  collieTool("collie_receipts", {
    readOnly: true,
    title: "What actually happened",
    description:
      "Everything one Run is waiting on the human for — the Choice it asks with how to " +
      "answer it, and the proposals with their id and hash — and every message that has been sent " +
      "to its agents with the state each actually reached. `submitted` is that it was sent, " +
      "`acknowledged` is that the agent took a turn after it, and whether the work went " +
      "where it was told is the drift judgement in collie_run — different facts, none of " +
      "them standing in for another. Read this instead of saying that something was done. With no `run` it " +
      "answers about whatever the board has selected, and says which that was.",
    parameters: RunInput.mapFields((fields) => ({
      run: fields.run.annotate({ description: "The Run id; omit for the board's selection" }),
    })),
  }),
  collieTool("collie_report", {
    readOnly: true,
    title: "How Runs went",
    description:
      "`collie run report`: every Run since a date tallied by how it ended, then the " +
      "measures Collie is judged by — review rounds and how many hit the cap, merged " +
      "against superseded against abandoned, steers, follow-ups, deliveries and " +
      "corrections by who sent them, verifications with the repeated ones and the ones " +
      "named only by their executable, parks by reason, and peak context tokens. Each " +
      "measure names the Run ids it counts, so an answer can cite them.",
    parameters: Schema.Struct({
      since: Schema.optionalKey(
        Schema.String.annotate({
          description: "Only Runs admitted at or after this ISO date; omit for every Run",
        }),
      ),
    }),
  }),
  collieTool("collie_news", {
    readOnly: false,
    title: "What has happened since you last looked",
    description:
      "Meaningful developments nobody has told you about yet: Runs that ended, halted, " +
      "are waiting on the human, cannot show what they set out to prove, drifted past what " +
      "Collie could correct, or are going round in circles. Routine activity is not here " +
      "and is not meant to be — it is on the board. Reading this marks the items read, so " +
      "read it when a turn begins and tell the human what is in it; do not read it twice " +
      "for one answer. It says how many older items it left out.",
    parameters: Tool.EmptyParams,
  }),
  collieTool("collie_definitions", {
    readOnly: true,
    title: "What can be run, and what it says",
    description:
      "The Workflows and Personas this installation has, in every Layer. With no input " +
      "it names them all; `workflow` shows one resolved — its Steps, the Inputs it takes " +
      "and anything that would stop it running — and `persona` shows one's instructions. " +
      "Read this before proposing a launch or a fork: a Workflow's real Inputs are what " +
      "it resolves to, not what its file looks like.",
    parameters: DefinitionInput,
  }),
  collieTool("collie_installation", {
    // `doctor` fetches this checkout's refs to say whether it is behind, which writes to
    // the object store. Bounded, and still not a read.
    readOnly: false,
    title: "This installation",
    description:
      "Everything that is not about a Run: what Collie needs and whether it is there, " +
      "which workspace this Herd's Home is and what proves it, the panes an older " +
      "release left that a cleanup would close, what a cleanup sweep would remove and keep, " +
      "this Machine's Schedules — when each fires next, whether it is paused and what its " +
      "last occurrence became — " +
      "the constraints every new Run begins " +
      "with, and which harness this conversation is running in. Read this before " +
      "proposing an upgrade, an onboarding, a cleanup, a change to the defaults or to a Schedule.",
    parameters: Tool.EmptyParams,
  }),
  collieTool("collie_models", {
    readOnly: true,
    title: "Which models a Machine can run",
    description:
      "Which models and efforts each harness installed on a Machine offers, as that " +
      "Machine's host last read them from the harnesses themselves, with each model's " +
      "default effort and whether the harness hides it. A harness that could not be read " +
      "says why and lists Collie's own table instead. `machine` names one Machine; without " +
      "it the answer is for every Machine there is to ask. `harness` keeps one harness. " +
      "Read this before saying which model or effort a Machine can run.",
    parameters: Schema.Struct({
      machine: Schema.optionalKey(Schema.String),
      harness: Schema.optionalKey(Schema.String),
    }),
  }),
  collieTool("collie_connections", {
    readOnly: true,
    title: "Which services each Machine is logged in to",
    description:
      "Each Machine's Connections: GitLab, GitHub, Linear, Helle and Slack, with the account, " +
      "whether its login is absent or broken, and the fix. `machine` keeps one Machine; " +
      "without it the Flock chat reads every Machine it can reach. Credentials are never returned.",
    parameters: Schema.Struct({ machine: Schema.optionalKey(Schema.String) }),
  }),
  collieTool("collie_hold", {
    readOnly: false,
    title: "Hold a Run, or a whole workspace",
    description:
      "Stop a Run — or every unfinished Run in a workspace — taking on new work. What is " +
      "already running carries on; the Run parks at its next boundary instead of starting " +
      "the next thing. Carried out at once, because it is the human's own instruction: do " +
      "not propose a hold they asked for. Name the Run by the id `collie_herd` lists, or " +
      "the workspace by the id `collie_workspaces` lists. It is held until someone " +
      "releases it; nothing lifts a hold at a time.",
    parameters: HoldInput,
  }),
  collieTool("collie_do", {
    readOnly: false,
    title: "Do what the board does",
    description:
      "Carry out, at once, anything the board does: its own actions " +
      `on a named Run (${Arr.join(ASKED_KINDS, ", ")}), and its decisions — ` +
      "`confirm` a waiting proposal by its id and the hash `collie_receipts` lists beside " +
      "it, `decline` one by the same two, `disposition` to record what became of a finished Run's " +
      "work, and `seen` to acknowledge a finished Run's report for every board. " +
      "`take_offer` takes one of a Run's offers by the id `collie_run` lists, with " +
      "what its own arguments take as `inputs`: when the human asks for what a Run offers " +
      '("release it", "stage it", "fix the findings"), take the matching offer rather than ' +
      "start its Workflow fresh. `release` lifts a hold; it does not release a merge " +
      "request. This is not a proposal: it is done, and the board shows the result. Do not " +
      "send the human to the board for one of these. Name a Run by the id " +
      "`collie_herd` lists, or leave `run` out to act on the card the board has open, " +
      "which the answer then names. What is not here is what you would be asking for yourself — " +
      "amending an Intent, forking a definition, changing the defaults, upgrading, " +
      "cleaning up — and that is `collie_propose`.",
    parameters: DoInput,
  }),
  collieTool("collie_propose", {
    readOnly: false,
    title: "Carry out a request",
    description:
      "Carry out the human's requested actions and return their results, including the " +
      "kinds `collie_do` does not take: amending an Intent, forking a definition, changing " +
      "a workspace's defaults, a cleanup, an upgrade, onboarding this Machine, " +
      "or schedule_add, schedule_pause, schedule_resume and schedule_remove. " +
      "A schedule_add names its cron, optional tz and start (workflow, every Input, " +
      "workspace and optional verify); the others name the Schedule. In Desktop's Flock " +
      "chat name machine, or qualify the Schedule's name or start.workspace with <machine>:; " +
      "a cleanup or home_cleanup there names machine. " +
      "Native chat acts on its own Machine and reports which. No separate " +
      "confirmation: they asked. " +
      "Reuse request_id when retrying the same request. Use reads for questions, not this. " +
      "Name every Run by the id `collie_herd` lists — a Run that does not exist is refused " +
      "rather than guessed at, and if you are not sure which the human meant, ask them " +
      "instead of proposing. `interpretation` is what you understood, in their words.",
    parameters: ProposeInput,
  }),
);

export type ToolName = keyof typeof CollieTools.tools;

/** What each tool says it takes when it refuses what it was given. */
export const TAKES: Record<ToolName, string> = {
  collie_herd: 'It takes nothing, or {"machine": "<name>"}.',
  collie_run: `It takes {"run": "<run id>"}, or nothing at all for the board's selection.`,
  collie_workspaces: "It takes nothing.",
  collie_receipts: `It takes {"run": "<run id>"}, or nothing at all for the board's selection.`,
  collie_report: 'It takes nothing, or {"since": "<ISO date>"}.',
  collie_news: "It takes nothing.",
  collie_definitions: 'It takes {"workflow": "<name>"} or {"persona": "<name>"}.',
  collie_installation: "It takes nothing.",
  collie_models: 'It takes nothing, or {"machine": "<name>"} and {"harness": "<harness>"}.',
  collie_connections: 'It takes nothing, or {"machine": "<name>"}.',
  collie_hold: 'It takes {"run": "..."} or {"workspace": "..."}, and optionally "reason".',
  collie_do:
    'It takes {"actions": [...]}, and every action has to be one of the kinds in the schema. An action with no "run" acts on the board\'s selection, and the board has nothing open.',
  collie_propose:
    'It takes {"interpretation": "...", "actions": [...]}, and every action has to be one of the kinds in the schema.',
};

/** Cards per answer. Sections come in the board's order, so Finished is what gets cut. */
const HERD_CARDS = 40;

/** One card as chat reads it: what the human sees on it, plus the id an action needs. */
function cardLine(view: TaskView): string {
  const project = view.project === "" ? "" : ` (${view.project})`;
  const where =
    view.mr !== null
      ? `, ${mrNounOf(view.mr)} ${mrLabel(view.mr)}`
      : view.branch !== null
        ? `, branch ${view.branch}`
        : "";
  const agents =
    view.agents.length === 0
      ? ""
      : `, agents ${Arr.join(
          Arr.map(view.agents, (agent) => agent.name),
          ", ",
        )}`;
  return `- run ${view.run}: ${view.name}${project}, ${view.state}${where}${agents}. ${view.sentence}`;
}

/** The board as chat reads it: the header, then each section's cards in the board's order. */
export function herdLines(views: ReadonlyArray<TaskView>, now: number): string {
  if (views.length === 0) return "- (no Runs in this Herd)";
  const lines = [headerSentence(views, now).text];
  let room = HERD_CARDS;
  for (const [section, title] of SECTIONS) {
    const cards = Arr.filter(views, (view) => sectionOf(view) === section);
    if (cards.length === 0) continue;
    lines.push("", `## ${title} · ${cards.length}`, ...Arr.map(cards.slice(0, room), cardLine));
    room = Math.max(0, room - cards.length);
  }
  const left = views.length - HERD_CARDS;
  if (left > 0) lines.push("", `- (${left} more card(s) not listed here)`);
  return Arr.join(lines, "\n");
}

/** Only the two fields the stand-in turns on; the closed union decodes the rest. */
const LooseActions = Schema.Struct({
  actions: Schema.Array(Schema.Record(Schema.String, Schema.Json)),
});
export const decodeLoose = Schema.decodeUnknownOption(LooseActions);

/** The JSON Schema a harness is given, generated from the schema the call is decoded with. */
export const jsonSchemaOf = (schema: Schema.Top): JsonObject => {
  const document = Schema.toJsonSchemaDocument(schema, { onExcessProperty: "error" });
  // SAFETY: a JSON Schema document is JSON, which is what JsonObject says.
  return { ...document.schema, $defs: document.definitions } as JsonObject;
};

export const inputSchemaOf = (tool: Tool.Any): JsonObject => jsonSchemaOf(tool.parametersSchema);

export const isToolName = (name: string): name is ToolName =>
  Arr.some(Struct.keys(CollieTools.tools), (key) => key === name);

/**
 * One call through a Toolkit made of Collie tools, decoded strictly. Input it will not take
 * is a refusal in the tool's own terms, and a tool it does not have answers nothing.
 */
export const answerWith = Effect.fn("Toolkit.answer")(function* <
  Tools extends Record<string, Tool.Any>,
>(toolkit: Toolkit.WithHandler<Tools>, name: string, input: JsonObject) {
  if (!Rec.has(toolkit.tools, name)) return "";
  // SAFETY: `handle` decodes it, which is what makes untrusted JSON a tool's parameters.
  const results = yield* toolkit.handle(name, input as never, undefined, STRICT);
  const last = yield* Stream.runLast(results);
  if (Option.isNone(last)) return "";
  const result: unknown = last.value.result;
  if (isString(result)) return result;
  const why = !AiError.isAiError(result)
    ? String(result)
    : result.reason._tag === "ToolParameterValidationError"
      ? result.reason.description
      : result.message;
  return refusedActions(name, input, why, isToolName(name) ? TAKES[name] : "");
});

/** A tool as an MCP server lists it: its name, words, input schema and whether it only reads. */
export const describeTool = (tool: Tool.Any) => ({
  name: tool.name,
  title: Context.getUnsafe(tool.annotations, Tool.Title),
  description: tool.description ?? "",
  input: () => inputSchemaOf(tool),
  readOnly: Context.get(tool.annotations, Tool.Readonly),
});

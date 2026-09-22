// What native chat may ask Collie, and nothing else.
//
// These are the model's whole reach. There is no "run this command" here and no route to
// a record: a conversation held in Claude or Pi reads the Herd through the same shared
// operations the board draws itself from, so the two cannot tell different stories — and
// a model that decided to be creative has nowhere to put it.
//
// Most of them only read. The rest write, and say so in `readOnly` rather than letting a
// client assume. Every write here carries out what the human asked for in this
// conversation, at once — chat may do what they could do on the board themselves, because
// sending them to the UI for it is chat obstructing the person it serves (ADR-0011).
// `collie_hold` holds; `collie_do` takes the board's own actions and decisions, with the
// open card standing in for a Run nobody named; `collie_propose` takes the whole closed
// action set — Intent amendments, forks, defaults, upgrades — with a request id that makes
// a retry return the first receipt. What Collie wants of its own accord is not here at
// all: the evaluator's proposals wait on the board, and chat asks the human in words.
//
// The bridge's actor is stamped by this entrypoint rather than worked out from the process
// — a model inside a harness's pane inherits that pane's terminal, and the CLI's "a TTY
// means a person" shortcut would read it as human. Attribution, never a gate.

import type { BunServices } from "@effect/platform-bun/BunServices";
import { Clock, Crypto, Effect, FileSystem, Option, Result, Schema } from "effect";
import { ChildProcessSpawner } from "effect/unstable/process";
import type { PluginEnv } from "./env";
import { mutation } from "./envelope";
import {
  carryOutAsked,
  carryOutProposal,
  declineProposal,
  newRequestId,
  request,
  runFacts,
  workspaceCwdFromPanes,
} from "./operations";
import { ActionSchema, type Action } from "./evaluator";
import { nativeRuns, nativeSettled } from "./lifecycle";
import { taskOfWorkspace } from "./task";
import {
  actorName,
  pendingFor,
  proposalsPath,
  read as readProposals,
  type Actor,
} from "./proposals";
import { recordDisposition, statusLine } from "./disposition";
import { Herdr } from "./herdr";
import {
  buildBoard,
  headerSentence,
  mrLabel,
  sectionOf,
  type Section,
  type TaskView,
} from "./board";
import { loadDefaults } from "./config";
import {
  asText as newsText,
  newsPath,
  pending as pendingNews,
  read as readNews,
  settle as settleNews,
} from "./news";
import { RunStore, type Run } from "./run";
import { nowIso, untilFrom } from "./time";
import { attentionFor } from "./attention";
import { deliveriesOf, herdOf } from "./steering";
import { loadDefinitions, layers, skillDirs } from "./definitions";
import { chatHarnessOf, chatPath, pushable, readChat, whyUnavailable } from "./chat";
import { closable, decide, homePath, readHome, UNREADABLE } from "./home";
import { doctor } from "./doctor";
import { defaultsPath, describeDefaults, EMPTY_DEFAULTS, readDefaults } from "./intent";
import { scopeKey } from "./registry";
import { readSelection, selectionPath } from "./selection";
import { listTasks } from "./task";
import { isString, type JsonObject } from "./schema";
import { checkModule, readModule, type Checked as ModuleCheck, type Described } from "./authoring";
import { savedModules } from "./discovery";

export interface Tool {
  readonly name: string;
  readonly title: string;
  readonly description: string;
  /** JSON Schema, because that is what both harnesses' tool interfaces take. */
  readonly input: JsonObject;
  /**
   * Whether this tool leaves everything as it found it. Said per tool rather than once
   * for the file, because a client uses it to decide what to run without asking: reading
   * the news settles the items it returns, and proposing writes to the journal.
   */
  readonly readOnly: boolean;
  readonly call: (env: PluginEnv, input: JsonObject) => ToolAnswer;
}

/**
 * One tool call, which cannot fail into the conversation: an unreadable record is a
 * sentence the model can act on, and a thrown error would be a chat that dies because a
 * file was half-written.
 */
type ToolAnswer = Effect.Effect<
  string,
  never,
  BunServices | ChildProcessSpawner.ChildProcessSpawner
>;

const NO_INPUT = { type: "object", properties: {}, additionalProperties: false };

/**
 * A key a tool does not take is refused, never stripped. Effect strips by default, and
 * a model that passed `goal` beside a start and was told "started" believes the goal is
 * in force while the Run runs without it. The refusal names the key so it can be acted on.
 */
const decodeStrict = <S extends Schema.ConstraintDecoder<unknown, never>>(schema: S) => {
  const decode = Schema.decodeUnknownResult(schema, { onExcessProperty: "error", errors: "all" });
  return (input: JsonObject): Result.Result<S["Type"], string> =>
    Result.mapError(decode(input), (error) => error.message);
};

const RunInput = Schema.Struct({ run: Schema.optionalKey(Schema.String) });
const HoldInput = Schema.Struct({
  run: Schema.optionalKey(Schema.String),
  workspace: Schema.optionalKey(Schema.String),
  until: Schema.optionalKey(Schema.String),
  reason: Schema.optionalKey(Schema.String),
});
const decodeHold = decodeStrict(HoldInput);
const DefinitionInput = Schema.Struct({
  workflow: Schema.optionalKey(Schema.String),
  persona: Schema.optionalKey(Schema.String),
});
const decodeDefinition = decodeStrict(DefinitionInput);
const decodeRun = decodeStrict(RunInput);

/** What a tool says when it will not act: tagged, so a model can tell it from an answer. */
const refused = (tool: string, why: string, takes: string) =>
  `${tool} refused the request (InvalidInput): ${why}. Nothing was done. ${takes}`;

const said = <E, R>(effect: Effect.Effect<string, E, R>) =>
  effect.pipe(
    Effect.catch((cause) => Effect.succeed(`Collie could not read that: ${String(cause)}`)),
  );

/** What a proposal's actions may be, decoded at this boundary and nowhere later. */
const ProposeInput = Schema.Struct({
  interpretation: Schema.String,
  actions: Schema.Array(ActionSchema),
  request_id: Schema.optionalKey(Schema.String),
});
const decodePropose = decodeStrict(ProposeInput);

/**
 * What the human can ask for and have done: the board's own actions on a named Run, plus
 * starting one. A closed subset of the same union, because the line is who wanted it —
 * amending an Intent, forking a definition and changing what a workspace's Runs begin
 * with are Collie's to propose and the human's to confirm.
 */
const ASKED_KINDS = [
  "stop",
  "resume",
  "release",
  "answer",
  "deliver",
  "followup",
  "start",
] as const;

/**
 * The board's decisions, which are not actions on a Run: a yes to a proposal, a no, and
 * what became of finished work. Here because the human said it, which is the whole of
 * what lets a confirmation through (ADR-0011).
 */
const SettleSchema = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("confirm"),
    proposal: Schema.String,
    /** The hash of exactly those actions, as `collie_receipts` lists it beside the id. */
    hash: Schema.String,
  }),
  Schema.Struct({ kind: Schema.Literal("decline"), proposal: Schema.String }),
  Schema.Struct({
    kind: Schema.Literal("disposition"),
    run: Schema.String,
    became: Schema.Literals(["merged", "abandoned", "superseded"]),
    /** What backs it up: a merge request, a commit, or the Run that took the work over. */
    ref: Schema.optionalKey(Schema.String),
  }),
]);
type Settle = Schema.Schema.Type<typeof SettleSchema>;
const SETTLE_KINDS = ["confirm", "decline", "disposition"] as const;

const AskedInput = Schema.Struct({
  actions: Schema.Array(Schema.Union([ActionSchema, SettleSchema])),
});
const decodeAsked = decodeStrict(AskedInput);

/** Each action kind's member of the closed unions, so a refusal can speak in its terms. */
const MEMBERS = new Map<
  string,
  (typeof ActionSchema.members | typeof SettleSchema.members)[number]
>(
  [...ActionSchema.members, ...SettleSchema.members].map((member) => [
    member.fields.kind.literal,
    member,
  ]),
);

/**
 * Why a request's actions were refused, per action and in the model's own terms: a kind
 * that does not exist, a key the kind does not take and what it does take, or the one
 * member's own complaint — never the whole union spelled out. Empty where the trouble is
 * elsewhere, and the schema's own message stands.
 */
function wrongActions(input: JsonObject): string[] {
  const loose = decodeLoose(input);
  if (loose._tag === "None") return [];
  return loose.value.actions.flatMap((action, at) => {
    const kind = isString(action["kind"]) ? action["kind"] : JSON.stringify(action["kind"] ?? null);
    const member = MEMBERS.get(kind);
    if (!member)
      return [
        `actions[${at}] has kind ${kind}, which is none of ${[...MEMBERS.keys()].join(", ")}`,
      ];
    const takes = Object.keys(member.fields);
    const extra = Object.keys(action).filter((key) => !takes.includes(key));
    if (extra.length === 0) {
      const own = decodeStrict(member)(action);
      return Result.isFailure(own) ? [`actions[${at}] (kind "${kind}"): ${own.failure}`] : [];
    }
    const hints = [
      extra.includes("goal") ? 'a Run\'s goal is an Input: put it in "inputs"' : null,
      extra.includes("constraints") || extra.includes("constraint")
        ? "constraints are added with update_intent on the started Run, or update_defaults on the workspace before it starts"
        : null,
    ].filter((hint) => hint !== null);
    return [
      `actions[${at}] (kind "${kind}") does not take ${extra.join(", ")}; a ${kind} takes ${takes.join(", ")}${hints.length > 0 ? ` (${hints.join("; ")})` : ""}`,
    ];
  });
}

const refusedActions = (tool: string, input: JsonObject, why: string, takes: string) => {
  const wrong = wrongActions(input);
  return refused(tool, wrong.length > 0 ? wrong.join("; ") : why, takes);
};

function askedSchema(): JsonObject {
  const document = Schema.toJsonSchemaDocument(AskedInput);
  // SAFETY: a JSON Schema document is JSON, which is what JsonObject says.
  return { ...document.schema, $defs: document.definitions } as JsonObject;
}

/**
 * The JSON Schema the harnesses are given for `collie_propose`, generated from the same
 * closed union the decoder uses. Generated rather than written out, so a kind this build
 * cannot carry out is not a kind a model is invited to ask for.
 */
function proposeSchema(): JsonObject {
  const document = Schema.toJsonSchemaDocument(ProposeInput);
  // SAFETY: a JSON Schema document is JSON, which is what JsonObject says.
  return { ...document.schema, $defs: document.definitions } as JsonObject;
}

export const TOOLS: ReadonlyArray<Tool> = [
  {
    name: "collie_herd",
    readOnly: true,
    title: "The Herd",
    description:
      "The board as the human sees it, card for card: its header sentence, then every " +
      "card under Needs you, Working, Waiting on you and Finished with its run id, state, " +
      "merge request or branch, agents and sentence. Herd-wide and never narrowed by what " +
      "the board is filtered to or which card is open; where more cards exist than fit, " +
      "the answer says how many were left out. Read this before answering anything about " +
      "the flock, and again when the answer has to be current.",
    input: NO_INPUT,
    call: (env) => said(boardFacts(env)),
  },
  {
    name: "collie_run",
    readOnly: true,
    title: "One Run",
    description:
      "One Run in detail: its goal, the constraints bounding it, its Steps, the work it " +
      "has handed over with the evidence and the gaps in it, and any drift nobody has " +
      "settled. Use it when a question is about a particular Run rather than the flock. " +
      "Name the Run; with no `run` it answers about whatever the board has selected, and " +
      "says which that was.",
    input: {
      type: "object",
      properties: {
        run: {
          type: "string",
          description: "The Run id, as collie_herd lists it; omit for the board's selection",
        },
      },
      additionalProperties: false,
    },
    call: (env, input) =>
      onSelectedRun(env, input, "collie_run", (run) => said(runFacts(run, env))),
  },
  {
    name: "collie_workspaces",
    readOnly: true,
    title: "Where work can be started",
    description:
      "The workspaces this herdr session has, with the directory each stands for, the Tasks " +
      "their Runs belong to, and the workflows that can be started. Read this before " +
      "proposing a launch: a Run belongs to " +
      "the workspace whose repository it is about, and the Home is Collie's own namespace, " +
      "not anybody's checkout. A start may also name a checkout's path instead of a " +
      "workspace: a directory none is open on gets a workspace opened on it, so a " +
      "repository missing from this list is no reason to send the human to the board.",
    input: NO_INPUT,
    call: (env) => said(workspaceFacts(env)),
  },
  {
    name: "collie_receipts",
    readOnly: true,
    title: "What actually happened",
    description:
      "One Run's proposals still waiting on the human, and every message that has been sent " +
      "to its agents with the state each actually reached. `submitted` is that herdr took " +
      "it, `acknowledged` is that the agent wrote back, `verified` is that something " +
      "independent checked — they are three different facts and none of them stands in for " +
      "another. Read this instead of saying that something was done. With no `run` it " +
      "answers about whatever the board has selected, and says which that was.",
    input: {
      type: "object",
      properties: {
        run: {
          type: "string",
          description: "The Run id; omit for the board's selection",
        },
      },
      additionalProperties: false,
    },
    call: (env, input) =>
      onSelectedRun(env, input, "collie_receipts", (run) => said(receiptFacts(env, run.id))),
  },
  {
    name: "collie_news",
    readOnly: false,
    title: "What has happened since you last looked",
    description:
      "Meaningful developments nobody has told you about yet: Runs that ended, halted, " +
      "are waiting on the human, cannot show what they set out to prove, drifted past what " +
      "Collie could correct, or are going round in circles. Routine activity is not here " +
      "and is not meant to be — it is on the board. Reading this marks the items read, so " +
      "read it when a turn begins and tell the human what is in it; do not read it twice " +
      "for one answer. It says how many older items it left out.",
    input: NO_INPUT,
    call: (env) => said(newsFacts(env)),
  },
  {
    name: "collie_definitions",
    readOnly: true,
    title: "What can be run, and what it says",
    description:
      "The Workflows and Personas this installation has, in every Layer. With no input " +
      "it names them all; `workflow` shows one resolved — its Steps, the Inputs it takes " +
      "and anything that would stop it running — and `persona` shows one's instructions. " +
      "Read this before proposing a launch or a fork: a Workflow's real Inputs are what " +
      "it resolves to, not what its file looks like.",
    input: {
      type: "object",
      properties: {
        workflow: { type: "string", description: "Show this Workflow, checked" },
        persona: { type: "string", description: "Show this Persona's instructions" },
      },
      additionalProperties: false,
    },
    call: (env, input) => said(definitionFacts(env, input)),
  },
  {
    name: "collie_installation",
    // `doctor` fetches this checkout's refs to say whether it is behind, which writes to
    // the object store. Bounded, and still not a read.
    readOnly: false,
    title: "This installation",
    description:
      "Everything that is not about a Run: what Collie needs and whether it is there, " +
      "which workspace this Herd's Home is and what proves it, the panes an older " +
      "release left that a cleanup would close, the constraints every new Run begins " +
      "with, and which harness this conversation is running in. Read this before " +
      "proposing an upgrade, a cleanup or a change to the defaults.",
    input: NO_INPUT,
    call: (env) => said(installationFacts(env)),
  },
  {
    name: "collie_hold",
    readOnly: false,
    title: "Hold a Run, or a whole workspace",
    description:
      "Stop a Run — or every unfinished Run in a workspace — taking on new work. What is " +
      "already running carries on; the Driver simply declines to start the next thing. " +
      "Carried out at once, because it is the human's own instruction: do not propose a " +
      "hold they asked for. Name the Run by the id `collie_herd` lists, or the workspace " +
      "by the id `collie_workspaces` lists, and give `until` as a clock time (`14:00`) or " +
      "a full timestamp to have it lift by itself. Without `until` it is held until " +
      "someone releases it.",
    input: {
      type: "object",
      properties: {
        run: { type: "string", description: "The Run to hold" },
        workspace: { type: "string", description: "Hold every unfinished Run in this workspace" },
        until: { type: "string", description: "When it lifts: `14:00`, or a full timestamp" },
        reason: { type: "string", description: "Why, in the human's own words" },
      },
      additionalProperties: false,
    },
    call: (env, input) => said(hold(env, input)),
  },
  {
    name: "collie_do",
    readOnly: false,
    title: "Do what the human asked for",
    description:
      "Carry out, at once, something the human asked you to do: the board's own actions " +
      `on a named Run (${ASKED_KINDS.join(", ")}), and its decisions — ` +
      "`confirm` a waiting proposal by its id and the hash `collie_receipts` lists beside " +
      "it, `decline` one, and `disposition` to record what became of a finished Run's " +
      "work. This is not a proposal: they said it, so it is done, and the board shows the " +
      "result. Do not send them to the board for one of these. Name a Run by the id " +
      "`collie_herd` lists, or leave `run` out to act on the card the board has open, " +
      "which the answer then names. What is not here is what you would be asking for yourself — " +
      "amending an Intent, forking a definition, changing the defaults, upgrading, " +
      "cleaning up — and that is `collie_propose`.",
    input: askedSchema(),
    call: (env, input) => said(carryOut(env, input)),
  },
  {
    name: "collie_propose",
    readOnly: false,
    title: "Carry out a request",
    description:
      "Carry out the human's requested actions and return their results, including the " +
      "kinds `collie_do` does not take: amending an Intent, forking a definition, changing " +
      "a workspace's defaults, a cleanup, an upgrade. No separate confirmation: they asked. " +
      "Reuse request_id when retrying the same request. Use reads for questions, not this. " +
      "Name every Run by the id `collie_herd` lists — a Run that does not exist is refused " +
      "rather than guessed at, and if you are not sure which the human meant, ask them " +
      "instead of proposing. `interpretation` is what you understood, in their words.",
    input: proposeSchema(),
    call: (env, input) =>
      said(
        Effect.gen(function* () {
          const decoded = decodePropose(input);
          if (Result.isFailure(decoded))
            return refusedActions(
              "collie_propose",
              input,
              decoded.failure,
              'It takes {"interpretation": "...", "actions": [...]}, and every action has to be one of the kinds in the schema.',
            );
          const key = yield* herdOf(env.socketPath).pipe(Effect.catch(() => Effect.succeed(null)));
          if (key === null)
            return "Collie cannot reach herdr, so there is nothing to propose against.";
          const requestId = decoded.success.request_id ?? (yield* newRequestId());
          const answer = yield* said(
            mutation(env, "chat-request", Option.some(requestId), (id) =>
              request(env, key, {
                interpretation: decoded.success.interpretation,
                actions: decoded.success.actions,
                actor: { origin: "chat", requestId: id },
              }),
            ).pipe(Effect.map((result) => (result.ok ? result.human : result.error.message))),
          );
          return `Request: ${requestId}\n${answer}`;
        }),
      ),
  },
];

/**
 * What the board has open, or null where there is no Herd, no board and no selection.
 * Every caller treats those three the same way: nothing is selected.
 */
const selectionOf = Effect.fn("Tools.selection")(function* (env: PluginEnv) {
  const key = yield* herdOf(env.socketPath).pipe(Effect.catch(() => Effect.succeed(null)));
  if (key === null) return null;
  return yield* readSelection(yield* selectionPath(env.stateDir, key)).pipe(
    Effect.catch(() => Effect.succeed(null)),
  );
});

const isSettle = (action: Action | Settle): action is Settle =>
  SETTLE_KINDS.some((kind) => kind === action.kind);

/** The human's own instruction, carried out and reported a line per action. */
const carryOut = Effect.fn("Tools.carryOut")(function* (env: PluginEnv, input: JsonObject) {
  const selected = yield* onSelection(env, input);
  const decoded = decodeAsked(selected.input);
  if (Result.isFailure(decoded))
    return refusedActions(
      "collie_do",
      selected.input,
      decoded.failure,
      'It takes {"actions": [...]}, and every action has to be one of the kinds in the schema. An action with no "run" acts on the board\'s selection, and the board has nothing open.',
    );
  const actions = decoded.success.actions;
  if (actions.length === 0) return "collie_do needs an action. Ask which one they meant.";
  const asked: ReadonlyArray<string> = [...ASKED_KINDS, ...SETTLE_KINDS];
  const wrong = actions.filter((action) => !asked.includes(action.kind));
  if (wrong.length > 0)
    return `collie_do does not carry out ${[...new Set(wrong.map((a) => a.kind))].join(", ")}: that is collie_propose's, and the human confirms it on the board.`;
  const requestId = yield* (yield* Crypto.Crypto).randomUUIDv4;
  const actor: Actor = { origin: "chat", requestId };
  const said: string[] =
    selected.on === null
      ? []
      : [`On the board's selection, "${selected.on.name}" (${selected.on.run}):`];
  for (const action of actions) {
    const done = yield* isSettle(action)
      ? settle(env, action, actor)
      : carryOutAsked(env, [action], actor).pipe(Effect.map((results) => results[0]!));
    said.push(`${done.kind}: ${done.state}${done.note ? ` — ${done.note}` : ""}`);
    // What follows a failure was asked for on the assumption that it did not happen.
    if (done.state === "failed") break;
  }
  return said.join("\n");
});

/** A decision of the board's, taken where the human said it. */
const settle = Effect.fn("Tools.settle")(function* (env: PluginEnv, action: Settle, actor: Actor) {
  if (action.kind === "disposition") {
    const run = yield* new RunStore(env.stateDir)
      .load(action.run)
      .pipe(Effect.catch(() => Effect.succeed(null)));
    if (run === null) return { kind: action.kind, state: "failed", note: `no Run "${action.run}"` };
    const line = {
      at: yield* nowIso(),
      by: actorName(actor),
      kind: action.became,
      ref: action.ref ?? "",
      note: null,
    };
    yield* recordDisposition(run.dir, line);
    return { kind: action.kind, state: "applied", note: statusLine(run.record.status, line) };
  }
  const done =
    action.kind === "confirm"
      ? yield* carryOutProposal(env, action.proposal, action.hash, actor)
      : yield* declineProposal(env, action.proposal, actor);
  if (!done.ok) return { kind: action.kind, state: "failed", note: done.error.message };
  // A settled proposal is not a proposal that ran: whether its actions did is in their
  // own results, and what was asked for after this assumed they had.
  const ran =
    "results" in done.data && done.data.results.some((result) => result.state === "failed")
      ? "failed"
      : "applied";
  return { kind: action.kind, state: ran, note: done.human };
});

/** Cards per answer. Sections come in the board's order, so Finished is what gets cut. */
const HERD_CARDS = 40;
const SECTIONS: ReadonlyArray<readonly [Section, string]> = [
  ["needs-you", "Needs you"],
  ["working", "Working"],
  ["waiting", "Waiting on you"],
  ["finished", "Finished"],
];

/** One card as chat reads it: what the human sees on it, plus the id an action needs. */
function cardLine(view: TaskView): string {
  const project = view.project === "" ? "" : ` (${view.project})`;
  const where =
    view.mr !== null
      ? `, mr ${mrLabel(view.mr)}`
      : view.branch !== null
        ? `, branch ${view.branch}`
        : "";
  const agents =
    view.agents.length === 0 ? "" : `, agents ${view.agents.map((agent) => agent.name).join(", ")}`;
  return `- run ${view.run}: ${view.name}${project}, ${view.state}${where}${agents}. ${view.sentence}`;
}

/** What `collie_herd` answers with: the board, so chat and board can never disagree about a card. */
const boardFacts = Effect.fn("Tools.boardFacts")(function* (env: PluginEnv) {
  const alive = yield* new Herdr(env).agentList().pipe(Effect.catch(() => Effect.succeed([])));
  const now = yield* Clock.currentTimeMillis;
  const views = yield* buildBoard({
    stateDir: env.stateDir,
    socketPath: env.socketPath,
    alive,
    now,
    quietMs: (yield* loadDefaults(env.configDir)).boardQuietMs,
  });
  if (views.length === 0) return "- (no Runs in this Herd)";
  const lines = [headerSentence(views, now).text];
  let room = HERD_CARDS;
  for (const [section, title] of SECTIONS) {
    const cards = views.filter((view) => sectionOf(view) === section);
    if (cards.length === 0) continue;
    lines.push("", `## ${title} · ${cards.length}`, ...cards.slice(0, room).map(cardLine));
    room = Math.max(0, room - cards.length);
  }
  const left = views.length - HERD_CARDS;
  if (left > 0) lines.push("", `- (${left} more card(s) not listed here)`);
  return lines.join("\n");
});

/** The action kinds that are not about one Run, so the selection never stands in for theirs. */
const UNSCOPED_KINDS: ReadonlyArray<string> = ["start", "confirm", "decline"];

/** Only the two fields the stand-in turns on; the closed union decodes the rest. */
const LooseActions = Schema.Struct({
  actions: Schema.Array(Schema.Record(Schema.String, Schema.Json)),
});
const decodeLoose = Schema.decodeUnknownOption(LooseActions);
const wantsRun = (action: JsonObject) => {
  const kind = action["kind"];
  return action["run"] === undefined && isString(kind) && !UNSCOPED_KINDS.includes(kind);
};

/**
 * `collie_do`'s input with the board's selection standing in for every run-scoped action
 * that named no Run, and which selection that was — so the answer can say so (ADR-0012).
 */
const onSelection = Effect.fn("Tools.onSelection")(function* (env: PluginEnv, input: JsonObject) {
  const loose = decodeLoose(input);
  if (loose._tag === "None" || !loose.value.actions.some(wantsRun)) return { input, on: null };
  const on = yield* selectionOf(env);
  if (on === null) return { input, on: null };
  const filled = loose.value.actions.map((action) =>
    wantsRun(action) ? { ...action, run: on.run } : action,
  );
  return { input: { ...input, actions: filled }, on };
});

/**
 * A read about one Run, which the board's selection may stand in for.
 *
 * The selection is taken only when the caller named no Run, and the answer says which
 * Run it was: an answer about work nobody named, that does not say which work, is how
 * "how is it going?" gets answered confidently about the wrong thing.
 */
const onSelectedRun = Effect.fn("Tools.onSelectedRun")(function* (
  env: PluginEnv,
  input: JsonObject,
  tool: string,
  answer: (run: Run) => ToolAnswer,
) {
  const decoded = decodeRun(input);
  if (Result.isFailure(decoded))
    return refused(
      tool,
      decoded.failure,
      `It takes {"run": "<run id>"}, or nothing at all for the board's selection.`,
    );
  const named = decoded.success.run ?? null;
  // Non-null exactly when the selection was what this answer is about, which is what the
  // sentences below turn on.
  const on = named === null ? yield* selectionOf(env) : null;
  const id = named ?? on?.run ?? null;
  if (id === null)
    return `${tool} takes {"run": "<run id>"}, or answers about the board's selection when there is one. The board has nothing selected — collie_herd lists the Runs there are.`;
  const run = yield* new RunStore(env.stateDir)
    .load(id)
    .pipe(Effect.catch(() => Effect.succeed(null)));
  if (run === null)
    return on === null
      ? `No Run "${id}". collie_herd lists the ones there are.`
      : `The board has "${on.name}" selected, but Collie has no Run "${id}" any more.`;
  const text = yield* answer(run);
  return on === null
    ? text
    : `About "${on.name}" (${on.run}), which the board has selected.\n\n${text}`;
});

/**
 * A hold the human asked for, carried out. The actor is `chat` all the same: what is
 * relaxed is that chat may act, never that chat is a person — nothing here confirms a
 * proposal, and a hold is reversible by the same two ways it was asked for.
 */
const hold = Effect.fn("Tools.hold")(function* (env: PluginEnv, input: JsonObject) {
  const decoded = decodeHold(input);
  if (Result.isFailure(decoded))
    return refused(
      "collie_hold",
      decoded.failure,
      'It takes {"run": "..."} or {"workspace": "..."}, and optionally "until" and "reason".',
    );
  const { workspace, until, reason } = decoded.success;
  const on =
    decoded.success.run === undefined && workspace === undefined ? yield* selectionOf(env) : null;
  const run = decoded.success.run ?? on?.run;
  if (run === undefined && workspace === undefined)
    return "collie_hold needs a run or a workspace to hold, and the board has nothing open. Ask which one they meant.";
  const ends = until === undefined ? null : untilFrom(until, yield* Clock.currentTimeMillis);
  if (until !== undefined && ends === null)
    return `Collie could not read "${until}" as a time. Ask for a clock time like 14:00, or a full timestamp.`;
  const why = reason ?? "asked in chat";
  const requestId = yield* (yield* Crypto.Crypto).randomUUIDv4;

  // One channel for every control, so what chat can do to a Run is exactly what the
  // board and the CLI can do to it — including which Runs there are to do it to.
  const oneRun: Action =
    ends === null ? { kind: "hold", run: run! } : { kind: "hold", run: run!, until: ends };
  const held = yield* carryOutAsked(
    env,
    workspace === undefined ? [oneRun] : yield* holdsFor(env, workspace),
    { origin: "chat", requestId },
  );
  const about = on === null ? "" : `On the board's selection, "${on.name}": `;
  return (
    about +
    (held.length === 0
      ? `Nothing here is running${why === "" ? "" : ` (${why})`}.`
      : held.map((result) => `${result.kind}: ${result.state} ${result.note}`.trim()).join("\n"))
  );
});

/** Every Run of the Task this workspace belongs to, as one hold each. */
const holdsFor = Effect.fn("Tools.holdsFor")(function* (env: PluginEnv, workspace: string) {
  const task = yield* taskOfWorkspace(env.stateDir, workspace);
  if (task === null) return [];
  const runs = (yield* nativeRuns(env, task.id)).runs.filter((view) => !nativeSettled(view));
  return runs.map((view) => ({ kind: "hold" as const, run: view.runId }));
});

/** What `collie_workspaces` answers with: where a Run could go, and what could start. */
const workspaceFacts = Effect.fn("Tools.workspaces")(function* (env: PluginEnv) {
  const herdr = new Herdr(env);
  const all = yield* herdr.workspaceList().pipe(Effect.catch(() => Effect.succeed([])));
  const panes = yield* herdr.paneList().pipe(Effect.catch(() => Effect.succeed([])));
  const saved = (yield* savedModules(env)).entries;
  const lines = all.map((workspace) => {
    const cwd =
      workspace.cwd !== "" ? workspace.cwd : workspaceCwdFromPanes(workspace.workspaceId, panes);
    return `- workspace ${workspace.workspaceId} (${workspace.label}): ${cwd || "no directory"}`;
  });
  // The Tasks too: a Task with no Run yet is in no Herd listing, so this is the only
  // place a conversation can find out the work a new Run could join.
  const tasks = yield* listTasks(env.stateDir).pipe(Effect.catch(() => Effect.succeed([])));
  return [
    ...(lines.length > 0 ? lines : ["- (no workspaces)"]),
    "",
    ...tasks.map((task) => `- task ${task.id} (${task.label}) in workspace ${task.workspace}`),
    ...(tasks.length === 0 ? ["- (no Tasks)"] : []),
    "",
    `workflows: ${
      saved
        .map((one) => one.id)
        .sort()
        .join(", ") || "none"
    }`,
    "",
    "a start may name a workspace id, its label, or the path of a checkout — a directory",
    "with no workspace open on it gets one.",
  ].join("\n");
});

/**
 * What `collie_news` answers with, and the receipt for it.
 *
 * Reading is what settles an item, and nothing else does: a transport that accepted a
 * message has not shown that a conversation received it. Marked read here because this is
 * the moment it demonstrably reached the model — it is in the answer.
 */
const newsFacts = Effect.fn("Tools.news")(function* (env: PluginEnv) {
  const key = yield* herdOf(env.socketPath).pipe(Effect.catch(() => Effect.succeed(null)));
  if (key === null) return "Collie cannot reach herdr, so it has nothing to report.";
  const file = yield* newsPath(env.stateDir, key);
  const batch = pendingNews(yield* readNews(file));
  for (const item of batch.items) yield* settleNews(file, item.key, "read");
  return newsText(batch);
});

/** What `collie_receipts` answers with: what is waiting, and what each send actually reached. */
const receiptFacts = Effect.fn("Tools.receipts")(function* (env: PluginEnv, run: string) {
  const found = yield* new RunStore(env.stateDir)
    .load(run)
    .pipe(Effect.catch(() => Effect.succeed(null)));
  if (found === null) return `No Run "${run}".`;
  const key = yield* herdOf(env.socketPath).pipe(Effect.catch(() => Effect.succeed(null)));
  const now = yield* Clock.currentTimeMillis;
  const proposals =
    key === null
      ? []
      : pendingFor(yield* readProposals(yield* proposalsPath(env.stateDir, key)), run, now);
  const deliveries = yield* deliveriesOf(env.stateDir, run);
  // Every delivery is on the ledger now: the one sender writes there before it sends,
  // so there is no second place a steer can be sitting unrecorded.
  const unread: string[] = [];
  return [
    "### Waiting on the human",
    "",
    ...(proposals.length === 0
      ? ["- nothing"]
      : proposals.map(
          (p) => `- ${p.id} (${p.content_hash}): ${p.interpretation} — expires ${p.expires_at}`,
        )),
    "",
    "### Sent to this Run's agents",
    "",
    ...(deliveries.length === 0 && unread.length === 0
      ? ["- nothing"]
      : deliveries.map(
          ({ delivery }) =>
            `- ${delivery.id}: ${delivery.state}${delivery.note ? ` (${delivery.note})` : ""}, for ${delivery.cause.kind}`,
        )),
    ...unread,
  ].join("\n");
});

/** What `collie_definitions` answers with: what can be run, resolved rather than as authored. */
const definitionFacts = Effect.fn("Tools.definitions")(function* (
  env: PluginEnv,
  input: JsonObject,
) {
  const defs = yield* loadDefinitions(yield* layers(env));
  const saved = yield* savedModules(env);
  const wanted = decodeDefinition(input);
  if (Result.isFailure(wanted))
    return refused(
      "collie_definitions",
      wanted.failure,
      'It takes {"workflow": "<name>"} or {"persona": "<name>"}.',
    );
  const asked = wanted.success;
  if (asked.persona !== undefined) {
    const found = defs.personas.get(asked.persona);
    return found === undefined
      ? `No Persona "${asked.persona}".`
      : `${found.name} (${found.layer})\n${found.description}\n\n${found.body}`;
  }
  if (asked.workflow !== undefined) {
    // A module is what its id runs, so it is what this answers with — the same reading
    // `workflow show` gives, and the same schemas a refusal asks an input for.
    const module = saved.entries.find((one) => one.id === asked.workflow);
    if (module) return moduleFacts(yield* readModule(module), yield* checkModule(module));
    const broken = saved.problems.find((one) => one.id === asked.workflow);
    if (broken) return `${broken.path} will not load: ${broken.message}`;
    return `No Workflow "${asked.workflow}".`;
  }
  return [
    "### Workflows",
    "",
    ...saved.entries.map((one) => `- ${one.id} (${one.layer}): ${one.description}`).sort(),
    ...(saved.problems.length > 0
      ? ["", ...saved.problems.map((one) => `- ${one.id}: ${one.path} will not load`)]
      : []),
    "",
    "### Personas",
    "",
    ...[...defs.personas.values()]
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((p) => `- ${p.name} (${p.layer}): ${p.description}`),
    ...(defs.errors.length > 0
      ? ["", "### Would not load", "", ...defs.errors.map((e) => `- ${e}`)]
      : []),
  ].join("\n");
});

const asJson = Schema.encodeSync(Schema.fromJsonString(Schema.Json));

/** One module as the tool says it: what it takes, what it gives back, and what is wrong. */
const moduleFacts = (one: Described, checked: ModuleCheck): string =>
  [
    `${one.id} (${one.layer}): ${one.title}`,
    one.description,
    `inputs: ${one.inputs.map((input) => `${input.name}${input.required ? "" : "?"}`).join(", ") || "none"}`,
    `the host also settles: ${one.options.map((option) => option.name).join(", ")}`,
    `result: ${asJson(one.success.schema)}`,
    `failure: ${asJson(one.error.schema)}`,
    `metadata: ${asJson(one.metadata)}`,
    checked.problems.length === 0
      ? checked.toolchain === null
        ? "checks out"
        : `checks out, but nothing typechecked it: ${checked.toolchain}`
      : `problems:\n${checked.problems.map((problem) => `- ${problem}`).join("\n")}`,
    ...checked.limits.map((limit) => `drawn without: ${limit}`),
    `defined in: ${one.path}`,
  ].join("\n");

/** What `collie_installation` answers with: everything that is not about a Run. */
const installationFacts = Effect.fn("Tools.installation")(function* (env: PluginEnv) {
  const herdr = new Herdr(env);
  const key = yield* herdOf(env.socketPath).pipe(Effect.catch(() => Effect.succeed(null)));
  const panes = yield* herdr.paneList().pipe(Effect.catch(() => Effect.succeed([])));
  const workspaces = yield* herdr.workspaceList().pipe(Effect.catch(() => Effect.succeed([])));
  const health = yield* doctor(env).pipe(Effect.catch(() => Effect.succeed(null)));
  const record = key === null ? null : yield* readHome(yield* homePath(env.stateDir, key));
  const ownership = key === null ? null : decide(record, workspaces, panes, key);
  const { close, listed } = closable(panes);
  // Per workspace, because that is how a Run reads them: what a new Run begins with is
  // the file under the workspace it was started in, never under whichever one this
  // process happens to be serving from.
  const defaults = yield* Effect.forEach(workspaces, (workspace) =>
    Effect.gen(function* () {
      const cwd =
        workspace.cwd !== "" ? workspace.cwd : workspaceCwdFromPanes(workspace.workspaceId, panes);
      const scope = { session: env.socketPath, workspaceId: workspace.workspaceId, cwd };
      const found =
        (yield* readDefaults(yield* defaultsPath(env.stateDir, scopeKey(scope)))) ?? EMPTY_DEFAULTS;
      return `- ${workspace.workspaceId} (${workspace.label}): ${
        describeDefaults(found).replaceAll("\n", "; ") || "nothing"
      }`;
    }),
  );
  const harness = yield* chatHarnessOf(env.configDir);
  const chat = key === null ? null : yield* readChat(yield* chatPath(env.stateDir, key));
  return [
    `health: ${health === null ? "could not be checked" : health.ok ? health.human : health.error.message}`,
    "",
    `home: ${
      record === null
        ? "none recorded"
        : record === UNREADABLE
          ? "the record is unreadable"
          : `${record.workspaceId} (${record.state})`
    }`,
    `ownership: ${ownership === null ? "herdr could not be asked" : ownership.kind}`,
    `panes an older release left: ${close.length} closable, ${listed.length} sharing a tab`,
    "",
    "every new Run begins with, by the workspace it is started in:",
    ...(defaults.length > 0 ? defaults : ["- (no workspaces)"]),
    "",
    `chat: ${harness}${whyUnavailable(harness, Bun.which(harness)) ?? " installed"}, running ${chat?.harness ?? "nothing"}`,
    `delivery: ${pushable(harness).how}`,
  ].join("\n");
});

export function toolNamed(name: string): Tool | null {
  return TOOLS.find((tool) => tool.name === name) ?? null;
}

// What native chat may ask Collie, and nothing else.
//
// These are the model's whole reach. There is no "run this command" here and no route to
// a record: a conversation held in Claude or Pi reads the Herd through the same shared
// operations the board draws itself from, so the two cannot tell different stories — and
// a model that decided to be creative has nowhere to put it.
//
// Five of them only read. Three write, and say so in `readOnly` rather than letting a
// client assume: `collie_news` settles the items it hands over, `collie_installation`
// runs the installation checks and one of those fetches this checkout's refs, and
// `collie_propose` executes requested actions through the shared journal and executors.
// Its name is retained for existing clients; it no longer requires a confirmation hop.
// Inputs and targets are still validated, and the bridge records chat attribution.

import type { BunServices } from "@effect/platform-bun/BunServices";
import { Clock, Effect, Option, Schema } from "effect";
import { ChildProcessSpawner } from "effect/unstable/process";
import type { PluginEnv } from "./env";
import { mutation } from "./envelope";
import { herdFacts, newRequestId, request, runFacts, workspaceCwdFromPanes } from "./operations";
import { ActionSchema } from "./evaluator";
import { pendingFor, proposalsPath, read as readProposals } from "./proposals";
import { Herdr } from "./herdr";
import {
  asText as newsText,
  newsPath,
  pending as pendingNews,
  read as readNews,
  settle as settleNews,
} from "./news";
import { RunStore } from "./run";
import { attentionFor } from "./attention";
import { deliveriesOf, herdOf } from "./steering";
import {
  loadDefinitions,
  layers,
  resolveWorkflow,
  skillDirs,
  validateWorkflow,
} from "./definitions";
import { loadDefaults } from "./config";
import { chatHarnessOf, chatPath, pushable, readChat, whyUnavailable } from "./chat";
import { closable, decide, homePath, readHome, UNREADABLE } from "./home";
import { doctor } from "./doctor";
import { defaultsPath, describeDefaults, EMPTY_DEFAULTS, readDefaults } from "./intent";
import { scopeKey } from "./registry";
import { listTasks } from "./task";
import type { JsonObject } from "./schema";

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

const RunInput = Schema.Struct({ run: Schema.String });
const DefinitionInput = Schema.Struct({
  workflow: Schema.optionalKey(Schema.String),
  persona: Schema.optionalKey(Schema.String),
});
const decodeRun = Schema.decodeUnknownOption(RunInput);

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
const decodePropose = Schema.decodeUnknownOption(ProposeInput);

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
      "Every Run in this Herd right now: workflow, status, live agents, the outcome each " +
      "has to prove, what is not proved yet, and what is in the way. Herd-wide and never " +
      "narrowed by what the board is filtered to or which row is selected; where more Runs " +
      "exist than fit, the answer says how many were left out. Read this before answering " +
      "anything about the flock, and again when the answer has to be current.",
    input: NO_INPUT,
    call: (env) => said(herdFacts(env)),
  },
  {
    name: "collie_run",
    readOnly: true,
    title: "One Run",
    description:
      "One Run in detail: its goal, the constraints bounding it, its Steps, the work it " +
      "has handed over with the evidence and the gaps in it, and any drift nobody has " +
      "settled. Use it when a question is about a particular Run rather than the flock.",
    input: {
      type: "object",
      properties: { run: { type: "string", description: "The Run id, as collie_herd lists it" } },
      required: ["run"],
      additionalProperties: false,
    },
    call: (env, input) =>
      Effect.gen(function* () {
        const decoded = decodeRun(input);
        if (decoded._tag === "None") return 'collie_run takes {"run": "<run id>"}.';
        const run = yield* new RunStore(env.stateDir)
          .load(decoded.value.run)
          .pipe(Effect.catch(() => Effect.succeed(null)));
        return run === null
          ? `No Run "${decoded.value.run}". collie_herd lists the ones there are.`
          : yield* said(runFacts(run, env));
      }),
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
      "not anybody's checkout.",
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
      "another. Read this instead of saying that something was done.",
    input: {
      type: "object",
      properties: { run: { type: "string", description: "The Run id" } },
      required: ["run"],
      additionalProperties: false,
    },
    call: (env, input) =>
      Effect.gen(function* () {
        const decoded = decodeRun(input);
        if (decoded._tag === "None") return 'collie_receipts takes {"run": "<run id>"}.';
        return yield* said(receiptFacts(env, decoded.value.run));
      }),
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
    name: "collie_propose",
    readOnly: false,
    title: "Carry out a request",
    description:
      "Carry out the user's requested actions and return their execution results. No " +
      "separate confirmation is needed. Reuse request_id when retrying the same request. " +
      "Use reads for questions, not this tool. " +
      "Name every Run by the id `collie_herd` lists — a Run that does not exist is refused " +
      "rather than guessed at, and if you are not sure which the human meant, ask them " +
      "instead of proposing. `interpretation` is what you understood, in their words.",
    input: proposeSchema(),
    call: (env, input) =>
      said(
        Effect.gen(function* () {
          const decoded = decodePropose(input);
          if (decoded._tag === "None")
            return 'collie_propose takes {"interpretation": "...", "actions": [...]}, and every action has to be one of the kinds in the schema.';
          const key = yield* herdOf(env.socketPath).pipe(Effect.catch(() => Effect.succeed(null)));
          if (key === null)
            return "Collie cannot reach herdr, so there is nothing to propose against.";
          const requestId = decoded.value.request_id ?? (yield* newRequestId());
          const answer = yield* said(
            mutation(env, "chat-request", Option.some(requestId), (id) =>
              request(env, key, {
                interpretation: decoded.value.interpretation,
                actions: decoded.value.actions,
                actor: { origin: "chat", requestId: id },
              }),
            ).pipe(Effect.map((result) => (result.ok ? result.human : result.error.message))),
          );
          return `Request: ${requestId}\n${answer}`;
        }),
      ),
  },
];

/** What `collie_workspaces` answers with: where a Run could go, and what could start. */
const workspaceFacts = Effect.fn("Tools.workspaces")(function* (env: PluginEnv) {
  const herdr = new Herdr(env);
  const all = yield* herdr.workspaceList().pipe(Effect.catch(() => Effect.succeed([])));
  const panes = yield* herdr.paneList().pipe(Effect.catch(() => Effect.succeed([])));
  const defs = yield* loadDefinitions(yield* layers(env)).pipe(
    Effect.catch(() => Effect.succeed({ workflows: new Map<string, unknown>() })),
  );
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
    `workflows: ${[...defs.workflows.keys()].sort().join(", ") || "none"}`,
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
  const attention = yield* attentionFor(found, new Herdr(env));
  const question = attention.choice;
  return [
    "### Waiting on the human",
    "",
    ...(question === null
      ? []
      : [
          `- Question ${question.id}: ${question.header}`,
          ...question.items.map((item) => `  - ${item.title}`),
        ]),
    ...(proposals.length === 0 && question === null
      ? ["- nothing"]
      : proposals.map(
          (p) => `- ${p.id} (${p.content_hash}): ${p.interpretation} — expires ${p.expires_at}`,
        )),
    "",
    "### Sent to this Run's agents",
    "",
    ...(deliveries.length === 0
      ? ["- nothing"]
      : deliveries.map(
          ({ delivery }) =>
            `- ${delivery.id}: ${delivery.state}${delivery.note ? ` (${delivery.note})` : ""}, for ${delivery.cause.kind}`,
        )),
  ].join("\n");
});

/** What `collie_definitions` answers with: what can be run, resolved rather than as authored. */
const definitionFacts = Effect.fn("Tools.definitions")(function* (
  env: PluginEnv,
  input: JsonObject,
) {
  const defs = yield* loadDefinitions(yield* layers(env));
  const wanted = Schema.decodeUnknownOption(DefinitionInput)(input);
  const asked = wanted._tag === "Some" ? wanted.value : {};
  if (asked.persona !== undefined) {
    const found = defs.personas.get(asked.persona);
    return found === undefined
      ? `No Persona "${asked.persona}".`
      : `${found.name} (${found.layer})\n${found.description}\n\n${found.body}`;
  }
  if (asked.workflow !== undefined) {
    if (!defs.workflows.has(asked.workflow)) return `No Workflow "${asked.workflow}".`;
    const defaults = yield* loadDefaults(env.configDir);
    // Resolved, because a Run takes an embedded workflow's Inputs and runs its expanded
    // Steps: what the file says is not what starts.
    const wf = resolveWorkflow(asked.workflow, defs, defaults);
    const problems = yield* validateWorkflow(wf, defs, defaults, yield* skillDirs(env));
    return [
      `${wf.name} (${wf.layer}): ${wf.title}`,
      wf.description,
      `inputs: ${Object.keys(wf.inputs).join(", ") || "none"}`,
      `steps: ${wf.steps.map((step) => step.id).join(", ")}`,
      problems.length === 0
        ? "checks out"
        : `problems:\n${problems.map((p) => `- ${p}`).join("\n")}`,
    ].join("\n");
  }
  return [
    "### Workflows",
    "",
    ...[...defs.workflows.values()]
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((wf) => `- ${wf.name} (${wf.layer}): ${wf.description}`),
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

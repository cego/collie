// What native chat may ask Collie, and nothing else.
//
// These are the model's whole reach. There is no "run this command" here and no route to
// a record: a conversation held in Claude or Pi reads the Herd through the same shared
// operations the board draws itself from, so the two cannot tell different stories — and
// a model that decided to be creative has nowhere to put it.
//
// Most of them only read. The rest write, and say so with `Tool.Readonly` rather than
// letting a client assume. Every write here carries out what the human asked for in this
// conversation, at once — chat may do what they could do on the board themselves, because
// sending them to the UI for it is chat obstructing the person it serves (ADR-0011).
// `collie_hold` holds; `collie_do` takes the board's own actions and decisions, with the
// open card standing in for a Run nobody named; `collie_propose` takes the whole closed
// action set — Intent amendments, forks, defaults, upgrades — with a request id that makes
// a retry return the first receipt. The evaluator's proposals wait on the board for
// whoever settles them, and what no tool here does, chat runs through the CLI as the
// human would (AGENTS.md, invariant 1).
//
// The bridge's actor is stamped by this entrypoint rather than worked out from the process
// — a model inside a harness's pane inherits that pane's terminal, and the CLI's "a TTY
// means a person" shortcut would read it as human. Attribution, never a gate.

import type { BunServices } from "@effect/platform-bun/BunServices";
import { Clock, Crypto, Effect, Result, Schema } from "effect";
import { ChildProcessSpawner } from "effect/unstable/process";
import type { PluginEnv } from "./env";
import { newRequestId, runFacts, workspaceCwdFromPanes } from "./operations";
import type { Action } from "./actions";
import {
  boardSnapshot,
  confirmProposed,
  declineProposed,
  actAsked,
  disposeRun,
  proposeActions,
  runViews,
  isSettled,
  settleNewsFor,
  type Door,
} from "./lifecycle";
import { taskOfWorkspace } from "./task";
import { pendingFor, proposalsPath, read as readProposals } from "./proposals";
import { statusLine } from "./disposition";
import { Herdr } from "./herdr";
import { ASKED_KINDS } from "./board-model";
import { asText as newsText, NATIVE } from "./news";
import { findRun, listRuns, type RunFacts } from "./runs";
import { donePasses, markersOf, runningCheck } from "./checks";
import { deliveriesOf, herdOf } from "./steering";
import { loadDefinitions, layers } from "./definitions";
import { chatHarnessOf, chatPath, heardVoice, pushable, readChat, whyUnavailable } from "./chat";
import { closable, decide, homePath, readHome, UNREADABLE } from "./home";
import { doctor } from "./doctor";
import { defaultsPath, describeDefaults, EMPTY_DEFAULTS, readDefaults } from "./intent";
import { scopeKey } from "./registry";
import { readSelection, selectionPath } from "./selection";
import { listTasks } from "./task";
import { isString, type JsonObject } from "./schema";
import { checkModule, readModule, type Checked as ModuleCheck, type Described } from "./authoring";
import { savedModules } from "./discovery";
import {
  answerWith,
  CollieTools,
  decodeAsked,
  decodeLoose,
  DefinitionInput,
  describeTool,
  herdLines,
  HoldInput,
  isToolName,
  refusedActions,
  RunInput,
  type Settle,
  SETTLE_KINDS,
  TAKES,
} from "./toolkit";

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

const said = <E, R>(effect: Effect.Effect<string, E, R>) =>
  effect.pipe(
    Effect.catch((cause) => Effect.succeed(`Collie could not read that: ${String(cause)}`)),
  );

const handlersFor = Effect.fn("Tools.handlers")(function* (env: PluginEnv) {
  const services = yield* Effect.context<BunServices | ChildProcessSpawner.ChildProcessSpawner>();
  const answer = <E>(
    effect: Effect.Effect<string, E, BunServices | ChildProcessSpawner.ChildProcessSpawner>,
  ) => said(effect).pipe(Effect.provideContext(services));
  return CollieTools.of({
    collie_herd: () => answer(boardFacts(env)),
    collie_run: (input) =>
      answer(onSelectedRun(env, input, "collie_run", (run) => said(runAnswer(env, run)))),
    collie_workspaces: () => answer(workspaceFacts(env)),
    collie_receipts: (input) =>
      answer(
        onSelectedRun(env, input, "collie_receipts", (run) => said(receiptFacts(env, run.id))),
      ),
    collie_news: () => answer(newsFacts(env)),
    collie_definitions: (input) => answer(definitionFacts(env, input)),
    collie_installation: () => answer(installationFacts(env)),
    collie_hold: (input) => answer(hold(env, input)),
    collie_do: (input) => answer(carryOut(env, input)),
    collie_propose: (input) =>
      answer(
        Effect.gen(function* () {
          const herd = yield* herdOf(env.socketPath).pipe(Effect.catch(() => Effect.succeed(null)));
          const requestId = input.request_id ?? (yield* newRequestId());
          const done = yield* proposeActions(env, {
            door: { origin: "chat", ...(yield* heardVoice(env)) },
            herd,
            interpretation: input.interpretation,
            actions: input.actions,
            request: requestId,
          }).pipe(Effect.map((result) => (result.ok ? result.human : result.error.message)));
          return `Request: ${requestId}\n${done}`;
        }),
      ),
  });
});

/**
 * One call to a Collie tool, decoded strictly by the Toolkit. Input it will not take is a
 * refusal in the tool's own terms, and a tool this build does not have answers nothing.
 */
export const callTool = Effect.fn("Tools.call")(
  function* (env: PluginEnv, name: string, input: JsonObject) {
    if (!isToolName(name)) return "";
    const toolkit = yield* CollieTools.pipe(Effect.provide(CollieTools.toLayer(handlersFor(env))));
    return yield* answerWith(toolkit, name, input);
  },
  Effect.catch((cause) => Effect.succeed(`Collie could not answer: ${String(cause)}`)),
);

/**
 * Drawn the first time a tool list is read rather than when this file loads: every
 * command the binary runs imports it, and few of them ever describe a tool.
 */
const once = (draw: () => JsonObject) => {
  let drawn: JsonObject | undefined;
  return () => (drawn ??= draw());
};

/** The Toolkit as each harness's tool interface and `collie tools` read it. */
export const TOOLS = Object.values(CollieTools.tools).map((tool) => {
  const { input, ...described } = describeTool(tool);
  const schema = once(input);
  return {
    ...described,
    get input() {
      return schema();
    },
    call: (env: PluginEnv, input: JsonObject) => callTool(env, tool.name, input),
  };
});

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
    return refusedActions("collie_do", selected.input, decoded.failure, TAKES.collie_do);
  const actions = decoded.success.actions;
  if (actions.length === 0) return "collie_do needs an action. Ask which one they meant.";
  const asked: ReadonlyArray<string> = [...ASKED_KINDS, ...SETTLE_KINDS];
  const wrong = actions.filter((action) => !asked.includes(action.kind));
  if (wrong.length > 0)
    return `collie_do does not carry out ${[...new Set(wrong.map((a) => a.kind))].join(", ")}: that is collie_propose's, which carries it out in the same call.`;
  const requestId = yield* (yield* Crypto.Crypto).randomUUIDv4;
  const door: Door = { origin: "chat", ...(yield* heardVoice(env)) };
  const said: string[] =
    selected.on === null
      ? []
      : [`On the board's selection, "${selected.on.name}" (${selected.on.run}):`];
  for (const [index, action] of actions.entries()) {
    const done = yield* isSettle(action)
      ? settle(env, door, action, `${requestId}-${index}`)
      : actAsked(env, { door, actions: [action], request: `${requestId}-${index}` }).pipe(
          Effect.map((results) => results[0]!),
        );
    said.push(`${done.kind}: ${done.state}${done.note ? ` — ${done.note}` : ""}`);
    // What follows a failure was asked for on the assumption that it did not happen.
    if (done.state === "failed") break;
  }
  return said.join("\n");
});

/** A decision of the board's, taken where the human said it, by the host. */
const settle = Effect.fn("Tools.settle")(function* (
  env: PluginEnv,
  door: Door,
  action: Settle,
  request: string,
) {
  if (action.kind === "disposition") {
    const run = yield* findRun(env, action.run);
    if (run === null) return { kind: action.kind, state: "failed", note: `no Run "${action.run}"` };
    const done = yield* disposeRun(env, {
      door,
      runId: run.id,
      kind: action.became,
      ref: action.ref ?? "",
      note: null,
      request,
    });
    return done.ok
      ? { kind: action.kind, state: "applied", note: statusLine(run.state, done.value) }
      : { kind: action.kind, state: "failed", note: done.error.message };
  }
  const done =
    action.kind === "confirm"
      ? yield* confirmProposed(env, {
          door,
          proposal: action.proposal,
          hash: action.hash,
          request,
        })
      : yield* declineProposed(env, {
          door,
          proposal: action.proposal,
          hash: action.hash,
          request,
        });
  // A confirmation whose actions did not all apply is a failure, with each one's result in it.
  return done.ok
    ? { kind: action.kind, state: "applied", note: done.human }
    : { kind: action.kind, state: "failed", note: done.error.message };
});

/**
 * What `collie_run` leads with while Collie runs a check for the Run: the card's sentence,
 * then the last lines the check has written.
 */
export const checkLines = Effect.fn("Tools.checkLines")(function* (
  run: RunFacts,
  runs: ReadonlyArray<RunFacts>,
  now: number,
) {
  const check = yield* runningCheck(run, runs, yield* markersOf(runs), now);
  if (check === null) return [];
  return [
    `Check running: ${check.sentence}`,
    ...(check.lastLines.length === 0
      ? []
      : ["Its last lines:", ...check.lastLines.map((line) => `  ${line}`)]),
  ];
});

/** One Run in detail, led by the check Collie is running for it, then where each finished one's output is. */
const runAnswer = Effect.fn("Tools.runAnswer")(function* (env: PluginEnv, run: RunFacts) {
  const facts = yield* runFacts(run);
  const running = yield* checkLines(run, yield* listRuns(env), yield* Clock.currentTimeMillis);
  const kept = (yield* donePasses(run)).filter((one) => one.log !== null);
  const done =
    kept.length === 0
      ? []
      : [
          "",
          "### Checks run",
          "",
          ...kept.map((one) => `- ${one.name} (${one.pass}) ${one.result}: ${one.log}`),
        ];
  return [...running, facts, ...done].join("\n");
});

/** What `collie_herd` answers with: the board, so chat and board can never disagree about a card. */
const boardFacts = Effect.fn("Tools.boardFacts")(function* (env: PluginEnv) {
  const read = yield* boardSnapshot(env);
  if (!read.ok) return `- (the board could not be read: ${read.error.message})`;
  const views = read.value.tasks;
  const now = yield* Clock.currentTimeMillis;
  return herdLines(views, now);
});

/** The action kinds that are not about one Run, so the selection never stands in for theirs. */
const UNSCOPED_KINDS: ReadonlyArray<string> = ["start", "confirm", "decline"];

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
  input: typeof RunInput.Type,
  tool: string,
  answer: (run: RunFacts) => ToolAnswer,
) {
  const named = input.run ?? null;
  // Non-null exactly when the selection was what this answer is about, which is what the
  // sentences below turn on.
  const on = named === null ? yield* selectionOf(env) : null;
  const id = named ?? on?.run ?? null;
  if (id === null)
    return `${tool} takes {"run": "<run id>"}, or answers about the board's selection when there is one. The board has nothing selected — collie_herd lists the Runs there are.`;
  const run = yield* findRun(env, id);
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
 * A hold, carried out. The actor is `chat` all the same: attribution, never a gate.
 */
const hold = Effect.fn("Tools.hold")(function* (env: PluginEnv, input: typeof HoldInput.Type) {
  const { workspace, reason } = input;
  const on = input.run === undefined && workspace === undefined ? yield* selectionOf(env) : null;
  const run = input.run ?? on?.run;
  if (run === undefined && workspace === undefined)
    return "collie_hold needs a run or a workspace to hold, and the board has nothing open. Ask which one they meant.";
  const why = reason ?? "asked in chat";
  const requestId = yield* (yield* Crypto.Crypto).randomUUIDv4;

  // One channel for every control, so what chat can do to a Run is exactly what the
  // board and the CLI can do to it — including which Runs there are to do it to.
  const oneRun: Action = { kind: "hold", run: run!, reason: why };
  const held = yield* actAsked(env, {
    door: { origin: "chat", ...(yield* heardVoice(env)) },
    actions: workspace === undefined ? [oneRun] : yield* holdsFor(env, workspace, why),
    request: requestId,
  });
  const about = on === null ? "" : `On the board's selection, "${on.name}": `;
  return (
    about +
    (held.length === 0
      ? `Nothing here is running${why === "" ? "" : ` (${why})`}.`
      : held.map((result) => `${result.kind}: ${result.state} ${result.note}`.trim()).join("\n"))
  );
});

/** Every Run of the Task this workspace belongs to, as one hold each. */
const holdsFor = Effect.fn("Tools.holdsFor")(function* (
  env: PluginEnv,
  workspace: string,
  reason: string,
) {
  const task = yield* taskOfWorkspace(env.stateDir, workspace);
  if (task === null) return [];
  const runs = (yield* runViews(env, task.id)).runs.filter((view) => !isSettled(view));
  return runs.map((view) => ({ kind: "hold" as const, run: view.runId, reason }));
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
    "a start names its workspace — an id, its label, the path of a checkout or a repository's",
    "name under the Projects root (one with no workspace open on it gets one), or projects-root",
    "— and every Input, an optional",
    'one left empty as "". Nothing is inferred; a start missing any is refused with each listed.',
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
  const read = yield* settleNewsFor(env, {
    door: { origin: "chat", ...(yield* heardVoice(env)) },
    herd: key,
    conversation: NATIVE,
    as: "read",
    request: yield* newRequestId(),
  });
  return read.ok ? newsText(read.value) : `Collie could not read the news: ${read.error.message}`;
});

/** What `collie_receipts` answers with: what is waiting, and what each send actually reached. */
const receiptFacts = Effect.fn("Tools.receipts")(function* (env: PluginEnv, run: string) {
  const found = yield* findRun(env, run);
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
  asked: typeof DefinitionInput.Type,
) {
  const defs = yield* loadDefinitions(yield* layers(env));
  const saved = yield* savedModules(env);
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
  const harness = yield* chatHarnessOf(env.userDir);
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

export function toolNamed(name: string) {
  return TOOLS.find((tool) => tool.name === name) ?? null;
}

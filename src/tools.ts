import * as Rec from "effect/Record";
import { withArtefacts } from "./artefact-client";
import * as Arr from "effect/Array";
import { branchMovement } from "./recovery";
import * as Str from "effect/String";
import { pipe as pipe_ } from "effect/Function";
import * as Option from "effect/Option";
import type { PlatformServices } from "./platform";
import { Clock, Effect, Result, Schema, flow as Schemaflow } from "effect";
import * as SecureRandom from "effect/crypto/SecureRandom";
import { ChildProcessSpawner } from "effect/process";
import type * as Tool from "effect/ai/Tool";
import type { PluginEnv } from "./env";
import { choiceLines, newRequestId, runFacts } from "./operations";
import { recordsReadLayer } from "./records";
import { projectsRoot } from "./projects";
import type { Action } from "./actions";
import type { Launched } from "./launches";
import {
  boardSnapshot,
  asksRun,
  statusOf,
  confirmProposed,
  declineProposed,
  actAsked,
  disposeRun,
  seeRun,
  proposeActions,
  runViews,
  isSettled,
  settleNewsFor,
  anyRuns,
  asks,
  cleanupListing,
  scheduleListing,
  runProgress,
  runShown,
  reportFor,
  showOffers,
  catalogueReadings,
  connectionReadings,
  type Door,
  hostRunProposals,
  hostTasks,
  flockArtefacts,
  flockRunPage,
  asksArtefactRun,
} from "./lifecycle";
import { listAsked } from "./run-list";
import { readArtefactLines, readRunLines, type RunScope } from "./run-read";
import { DEFAULT_LINES, linesError } from "./text-lines";
import { modelsLines } from "./catalogue-model";
import { connectionsLines } from "./connection-model";
import { peersOf } from "./peers";
import { cleanupLines } from "./cleanup";
import { isOpen } from "./task";
import { pendingFor } from "./proposals";
import { statusLine } from "./disposition";
import { ASKED_KINDS, Flow, type FLOCK_READS, type RunProgress } from "./board-model";
import { asText as newsText, NATIVE } from "./news";
import { reportLines } from "./report";
import { epochMs } from "./time";
import { findRun, listRuns, type RunFacts } from "./runs";
import { progressReadyLines } from "./following";
import { donePasses, markersOf, runningCheck } from "./checks";
import { memoryWaitOf, waitLine } from "./memory-wait";
import { machineHerd } from "./steering";
import { loadDefinitions, layers } from "./definitions";
import { chatHarnessOf, chatPath, heardVoice, pushable, readChat, whyUnavailable } from "./chat";
import { doctor } from "./doctor";
import { savedReaches, standingDirectionOn } from "./config";
import { reachOf, type Reach } from "./reach";
import { standingDirectionContext } from "./standing-direction";
import { defaultsPath, describeDefaults, EMPTY_DEFAULTS, readDefaults } from "./intent";
import { scopeFor, scopeKey } from "./registry";
import { readSelection, selectionPath } from "./selection";
import { isString, type JsonObject } from "./schema";
import { scheduleLines } from "./schedule-model";
import { checkModule, readModule, type Checked as ModuleCheck, type Described } from "./authoring";
import { savedModules } from "./discovery";
import {
  answerWith,
  CollieTools,
  decodeStrict,
  decodeAsked,
  decodeLoose,
  DefinitionInput,
  describeTool,
  herdLines,
  HoldInput,
  isToolName,
  refused,
  refusedActions,
  RunInput,
  RunListInput,
  searchesArtefacts,
  type Settle,
  SETTLE_KINDS,
  SubmitInput,
  SubmitTool,
  TAKES,
  type ToolName,
} from "./toolkit";

type ToolAnswer = Effect.Effect<
  string,
  never,
  PlatformServices | ChildProcessSpawner.ChildProcessSpawner
>;

export interface RunAnswerReads {
  readonly runs: Effect.Effect<ReadonlyArray<RunFacts>>;
  readonly related?: Effect.Effect<ReadonlyArray<RunFacts>>;
  readonly offers: (runId: string) => ToolAnswer;
  readonly progress: (runId: string) => Effect.Effect<RunProgress | null, never, PlatformServices>;
  readonly flow: (runId: string) => Effect.Effect<Flow | null, never, PlatformServices>;
  readonly launches: (runId: string) => Effect.Effect<ReadonlyArray<Launched>>;
}

const said = <E, R>(effect: Effect.Effect<string, E, R>) =>
  effect.pipe(
    Effect.catch((cause) => Effect.succeed(`Collie could not read that: ${String(cause)}`)),
  );

const toolDoor = Effect.fn("Tools.door")(function* (env: PluginEnv) {
  if (env.asker !== undefined) return env.asker;
  const run = env.raw.COLLIE_RUN;
  const agent = env.raw.COLLIE_AGENT;
  return run && agent
    ? { origin: "agent" as const, from: { run, agent } }
    : { origin: "chat" as const, ...(yield* heardVoice(env)) };
});

const handlersFor = Effect.fn("Tools.handlers")(function* (
  env: PluginEnv,
  selected: boolean,
  reads?: RunAnswerReads,
) {
  const services = yield* Effect.context<
    PlatformServices | ChildProcessSpawner.ChildProcessSpawner
  >();
  const answer = <E>(
    effect: Effect.Effect<string, E, PlatformServices | ChildProcessSpawner.ChildProcessSpawner>,
  ) => said(effect).pipe(Effect.provideContext(services));
  return CollieTools.of({
    collie_artefacts: (input) =>
      answer(
        Effect.gen(function* () {
          if (searchesArtefacts(input)) {
            const {
              id: _id,
              revision: _revision,
              offset: _offset,
              refresh: _refresh,
              ...asked
            } = input;
            const found = yield* flockArtefacts(env, asked).pipe(Effect.result);
            return found._tag === "Success"
              ? asJson(found.success)
              : found.failure._tag === "AmbiguousRun"
                ? found.failure.message
                : found.failure.reason;
          }
          const runId = input.run!;
          if (input.ref !== undefined)
            return yield* refLines(env, "collie_artefacts", runId, input.ref, input);
          const door = yield* toolDoor(env);
          if (input.id !== undefined && input.revision !== undefined) {
            if (input.offset === undefined) {
              const asked = linesAsked(input);
              const badPattern = linesError(asked);
              if (badPattern !== null)
                return refused("collie_artefacts", badPattern, TAKES.collie_artefacts);
              const lines = yield* readArtefactLines(
                env,
                runId,
                input.id,
                input.revision,
                asked,
                door,
              );
              if (!lines.ok) return lines.error.message;
              if (lines.value !== null) return asJson(lines.value);
            }
            const done = yield* asksArtefactRun(
              env,
              runId,
              (client, runId) =>
                withArtefacts(
                  client.board(),
                  client.artefactRead({
                    runId,
                    id: input.id!,
                    revision: input.revision!,
                    offset: input.offset ?? 0,
                  }),
                ),
              door,
            );
            return done.ok ? asJson(done.value) : done.error.message;
          }
          const done = yield* asksArtefactRun(
            env,
            runId,
            (client, runId) =>
              withArtefacts(client.board(), client.artefacts({ runId, refresh: input.refresh })),
            door,
          );
          return done.ok
            ? asJson(
                input.id === undefined
                  ? done.value
                  : (Option.getOrUndefined(
                      Arr.findFirst(done.value.items, (one) => one.id === input.id),
                    ) ?? { error: "No such artefact" }),
              )
            : done.error.message;
        }),
      ),
    collie_herd: (input) =>
      answer(
        boardFacts(
          input.machine === undefined ? env : { ...env, machine: input.machine },
          input.after,
        ),
      ),
    collie_run: (input) =>
      input.list === true
        ? answer(runListFacts(env, input))
        : input.ref !== undefined
          ? input.run === undefined
            ? Effect.succeed(
                refused(
                  "collie_run",
                  "ref reads one Run's reference, so it takes run",
                  TAKES.collie_run,
                ),
              )
            : answer(refLines(env, "collie_run", input.run, input.ref, input))
          : Arr.some(LINE_FIELDS, (key) => input[key] !== undefined)
            ? Effect.succeed(
                refused(
                  "collie_run",
                  "start, count and search read a reference, which takes ref",
                  TAKES.collie_run,
                ),
              )
            : Arr.some(LIST_FILTERS, (key) => input[key] !== undefined)
              ? Effect.succeed(
                  refused(
                    "collie_run",
                    `${Arr.join(
                      Arr.filter(LIST_FILTERS, (key) => input[key] !== undefined),
                      ", ",
                    )} only filter a listing, which takes "list": true`,
                    TAKES.collie_run,
                  ),
                )
              : answer(
                  onSelectedRun(
                    env,
                    selected,
                    input,
                    "collie_run",
                    (run) =>
                      said(
                        runAnswer(env, run, reads).pipe(
                          Effect.provide(recordsReadLayer(env.stateDir)),
                        ),
                      ),
                    reads?.related ?? reads?.runs,
                  ),
                ),
    collie_workspaces: () => answer(workspaceFacts(env)),
    collie_receipts: (input) =>
      answer(
        onSelectedRun(env, selected, input, "collie_receipts", (run) =>
          said(receiptFacts(env, run.id)),
        ),
      ),
    collie_report: (input) => answer(reportFacts(env, input.since ?? null)),
    collie_news: () => answer(newsFacts(env)),
    collie_definitions: (input) => answer(definitionFacts(env, input)),
    collie_installation: () => answer(installationFacts(env)),
    collie_models: (input) =>
      answer(
        modelsFacts(
          input.machine === undefined ? env : { ...env, machine: input.machine },
          input.harness,
        ),
      ),
    collie_connections: (input) =>
      answer(
        connectionFacts(input.machine === undefined ? env : { ...env, machine: input.machine }),
      ),
    collie_hold: (input) => answer(hold(env, input)),
    collie_do: (input) => answer(carryOut(env, input)),
    collie_propose: (input) =>
      answer(
        Effect.gen(function* () {
          const herd = yield* machineHerd(env).pipe(Effect.orElseSucceed(() => null));
          const requestId = input.request_id ?? (yield* newRequestId());
          const done = yield* proposeActions(env, {
            door: yield* toolDoor(env),
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

const answered = Effect.fn("Tools.answered")(
  function* (
    env: PluginEnv,
    name: ToolName,
    input: JsonObject,
    selected: boolean,
    reads?: RunAnswerReads,
  ) {
    const toolkit = yield* CollieTools.pipe(
      Effect.provide(CollieTools.toLayer(handlersFor(env, selected, reads))),
    );
    return yield* answerWith(toolkit, name, input);
  },
  Effect.catch((cause) => Effect.succeed(`Collie could not answer: ${String(cause)}`)),
);

export const callTool = (env: PluginEnv, name: string, input: JsonObject) =>
  name === SubmitTool.name
    ? submitted(env, input)
    : !isToolName(name)
      ? Effect.succeed("")
      : (name === "collie_run" || name === "collie_receipts") && isString(input.run)
        ? Effect.gen(function* () {
            const run = input.run;
            if (!isString(run)) return "A Run id is required.";
            if (
              env.machine === undefined &&
              ((yield* findRun(env, run)) !== null || (yield* peersOf(env.stateDir)).length === 0)
            )
              return yield* answered(env, name, input, true);
            const found = yield* asksRun(
              env,
              run,
              (client) => client.read({ tool: name, input }),
              yield* toolDoor(env),
            );
            return found.ok ? found.value : found.error.message;
          })
        : answered(env, name, input, true);

const submitted = Effect.fn("Tools.submitted")(function* (env: PluginEnv, input: JsonObject) {
  const decoded = decodeStrict(SubmitInput)(input);
  if (Result.isFailure(decoded))
    return refused("collie_submit", decoded.failure, 'It takes {"output": <your Output>}.');
  const run = env.raw.COLLIE_RUN;
  if (!run || !env.raw.COLLIE_AGENT)
    return "collie_submit hands in a Run agent's Output, and this is no Run's agent. Nothing was written.";
  const done = yield* asksRun(
    env,
    run,
    (client) => client.submitOutput({ runId: run, output: decoded.success.output }),
    yield* toolDoor(env),
  );
  return done.ok ? done.value : done.error.message;
});

export const answerRead = (
  env: PluginEnv,
  name: (typeof FLOCK_READS)[number],
  input: JsonObject,
  reads?: RunAnswerReads,
) => answered(env, name, input, false, reads);

const once = (draw: () => JsonObject) => {
  let drawn: JsonObject | undefined;
  return () => (drawn ??= draw());
};

const listed = (tool: Tool.Any) => {
  const { input, ...described } = describeTool(tool);
  const schema = once(input);
  return {
    ...described,
    get input() {
      return schema();
    },
    call: (env: PluginEnv, input: JsonObject) => callTool(env, tool.name, input),
  };
};

export const TOOLS = Arr.map(Rec.values(CollieTools.tools), listed);

export const SUBMIT = listed(SubmitTool);

const selectionOf = Effect.fn("Tools.selection")(function* (env: PluginEnv) {
  const key = yield* machineHerd(env).pipe(Effect.orElseSucceed(() => null));
  if (key === null) return null;
  return yield* readSelection(yield* selectionPath(env.stateDir, key)).pipe(
    Effect.orElseSucceed(() => null),
  );
});

const isSettle = (action: Action | Settle): action is Settle =>
  Arr.some(SETTLE_KINDS, (kind) => kind === action.kind);

const carryOut = Effect.fn("Tools.carryOut")(function* (env: PluginEnv, input: JsonObject) {
  const selected = yield* onSelection(env, input);
  const decoded = decodeAsked(selected.input);
  if (Result.isFailure(decoded))
    return refusedActions("collie_do", selected.input, decoded.failure, TAKES.collie_do);
  const actions = decoded.success.actions;
  if (actions.length === 0) return "collie_do needs an action. Ask which one they meant.";
  const asked: ReadonlyArray<string> = [...ASKED_KINDS, ...SETTLE_KINDS];
  const wrong = Arr.filter(actions, (action) => !asked.includes(action.kind));
  if (wrong.length > 0)
    return `collie_do does not carry out ${Arr.join([...new Set(Arr.map(wrong, (a) => a.kind))], ", ")}: that is collie_propose's, which carries it out in the same call.`;
  const requestId =
    decoded.success.request_id ?? (yield* (yield* SecureRandom.SecureRandom).uuidV4());
  const door: Door = yield* toolDoor(env);
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
    if (done.state === "failed") break;
  }
  return Arr.join(said, "\n");
});

const settle = Effect.fn("Tools.settle")(function* (
  env: PluginEnv,
  door: Door,
  action: Settle,
  request: string,
) {
  if (action.kind === "artefact_register") {
    const { kind, run, artefactKind, ...input } = action;
    const done = yield* asksArtefactRun(
      env,
      run,
      (client, run) =>
        withArtefacts(
          client.board(),
          client.artefactRegister({ runId: run, request, ...input, kind: artefactKind }),
        ),
      door,
    );
    return done.ok
      ? {
          kind,
          state: "applied",
          note: `artefact ${done.value.address.id}: revision ${done.value.retained.revision} ${done.value.retained.digest === "" ? "registered" : `retained (${done.value.retained.digest})`}`,
        }
      : { kind, state: "failed", note: done.error.message };
  }
  if (action.kind === "artefact_seen" || action.kind === "artefact_unseen") {
    const done = yield* asksArtefactRun(
      env,
      action.run,
      (client, run) =>
        withArtefacts(
          client.board(),
          client.artefactSeen({
            runId: run,
            id: action.id,
            revision: action.kind === "artefact_seen" ? action.revision : null,
            request,
          }),
        ),
      door,
    );
    return done.ok
      ? {
          kind: action.kind,
          state: "applied",
          note: `artefact ${action.id}: revision ${done.value.seen?.revision ?? "unseen"}`,
        }
      : { kind: action.kind, state: "failed", note: done.error.message };
  }
  if (action.kind === "seen") {
    const done = yield* seeRun(env, { door, runId: action.run, request });
    return done.ok
      ? { kind: action.kind, state: "applied", note: `seen by ${done.value.by}` }
      : { kind: action.kind, state: "failed", note: done.error.message };
  }
  if (action.kind === "disposition") {
    const found = yield* asksRun(
      env,
      action.run,
      (client) => client.run({ runId: action.run }),
      door,
    );
    if (!found.ok || found.value === null)
      return {
        kind: action.kind,
        state: "failed",
        note: found.ok ? `no Run "${action.run}"` : found.error.message,
      };
    const run = found.value;
    const done = yield* disposeRun(env, {
      door,
      runId: action.run,
      kind: action.became,
      ref: action.ref ?? "",
      note: null,
      request,
    });
    return done.ok
      ? { kind: action.kind, state: "applied", note: statusLine(statusOf(run), done.value) }
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
  return done.ok
    ? { kind: action.kind, state: "applied", note: done.human }
    : { kind: action.kind, state: "failed", note: done.error.message };
});

export const checkLines = Effect.fn("Tools.checkLines")(function* (
  run: RunFacts,
  runs: ReadonlyArray<RunFacts>,
  now: number,
  all?: Effect.Effect<ReadonlyArray<RunFacts>>,
) {
  const markers = yield* markersOf();
  const every = markers.has(run.id) && all !== undefined ? yield* all : runs;
  const check = yield* runningCheck(run, every, markers, now);
  const memory = yield* memoryWaitOf(run.id);
  const waiting = memory === null ? [] : [waitLine(memory)];
  if (check === null) return waiting;
  return [
    ...waiting,
    `Check running: ${check.sentence}`,
    ...(check.lastLines.length === 0
      ? []
      : ["Its last lines:", ...Arr.map(check.lastLines, (line) => `  ${line}`)]),
  ];
});

const encodeFlow = Schemaflow(Schema.encodeResult(Schema.fromJsonString(Flow)), Result.getOrThrow);

const runAnswer = Effect.fn("Tools.runAnswer")(function* (
  env: PluginEnv,
  run: RunFacts,
  reads?: RunAnswerReads,
) {
  const runs = yield* reads?.related ?? reads?.runs ?? listRuns(env);
  const facts = yield* runFacts(env, run, runs, reads?.launches(run.id));
  const running = yield* checkLines(run, runs, yield* Clock.currentTimeMillis, reads?.runs);
  const kept = Arr.filter(yield* donePasses(run), (one) => one.log !== null);
  const done =
    kept.length === 0
      ? []
      : [
          "",
          "### Checks run",
          "",
          ...Arr.map(kept, (one) => `- ${one.name} (${one.pass}) ${one.result}: ${one.log}`),
        ];
  const offers =
    reads === undefined
      ? yield* showOffers(env, run.id).pipe(
          Effect.map((one) => (one.ok ? one.human : one.error.message)),
        )
      : yield* reads.offers(run.id);
  const offered = ["", "### Offers, taken with take_offer", "", offers];
  const progress =
    reads === undefined
      ? yield* runProgress(env, run.id)
      : { ok: true as const, value: yield* reads.progress(run.id) };
  const ready =
    !progress.ok || progress.value === null
      ? []
      : ["", "### Ready to release", "", ...progressReadyLines(progress.value)];
  const shown =
    reads === undefined
      ? yield* runShown(env, run.id)
      : { ok: true as const, flow: yield* reads.flow(run.id) };
  const flow =
    !shown.ok || shown.flow == null
      ? []
      : [
          "",
          "### Flow, as `run show --json` carries it",
          "",
          "```json",
          encodeFlow(shown.flow),
          "```",
        ];
  const movement = yield* branchMovement(run);
  return Arr.join(
    [
      ...running,
      facts,
      ...(movement === null ? [] : [movement]),
      ...done,
      ...offered,
      ...ready,
      ...flow,
    ],
    "\n",
  );
});

const boardFacts = Effect.fn("Tools.boardFacts")(function* (env: PluginEnv, after?: string) {
  const skip = after === undefined ? 0 : Number(after);
  if (!Number.isInteger(skip) || skip < 0)
    return refused("collie_herd", `"${after}" is not a next this tool gave`, TAKES.collie_herd);
  const read = yield* boardSnapshot(env);
  if (!read.ok) return `- (the board could not be read: ${read.error.message})`;
  const views = read.value.tasks;
  const now = yield* Clock.currentTimeMillis;
  return herdLines(views, now, skip);
});

const LIST_FILTERS = ["status", "limit", "fields", "after", "since"] as const;
const LINE_FIELDS = ["start", "count", "search"] as const;

const linesAsked = (input: {
  readonly start?: number;
  readonly count?: number;
  readonly search?: string;
}) => ({
  start: input.start ?? 1,
  count: input.count ?? DEFAULT_LINES,
  search: input.search ?? null,
});

const toolScope = Effect.fn("Tools.scope")(function* (env: PluginEnv) {
  const door = yield* toolDoor(env);
  const caller = (door.origin === "agent" ? door.from?.run : env.raw.COLLIE_RUN) || null;
  const own = caller === null ? null : yield* asks(env, (client) => client.run({ runId: caller }));
  return {
    task: own?.ok ? (own.value?.task ?? null) : null,
    caller,
  } satisfies RunScope;
});

const refLines = Effect.fn("Tools.refLines")(function* (
  env: PluginEnv,
  tool: ToolName,
  run: string,
  ref: string,
  input: { readonly start?: number; readonly count?: number; readonly search?: string },
) {
  const read = yield* readRunLines(env, yield* toolScope(env), run, ref, linesAsked(input));
  return read.ok
    ? asJson(read.data)
    : `${tool} could not read ${ref} (${read.error.code}): ${read.error.message}`;
});

const runListFacts = Effect.fn("Tools.runListFacts")(function* (
  env: PluginEnv,
  input: typeof RunListInput.Type,
) {
  const read = listAsked(
    {
      status: input.status ?? [],
      limit: input.limit === undefined ? null : String(input.limit),
      fields: input.fields ?? null,
      after: input.after ?? null,
      since: input.since ?? null,
    },
    null,
  );
  if (!read.ok) return refused("collie_run", read.message, TAKES.collie_run);
  const listed = yield* flockRunPage(env, read.asked);
  if (!listed.ok)
    return `collie_run could not list (${listed.error.code}): ${listed.error.message}`;
  return asJson({
    runs: Arr.map(listed.runs, ({ machine, summary, view }) => ({ ...(view ?? summary), machine })),
    complete: listed.complete,
    next: listed.next,
    cursor: listed.cursor,
    omitted: listed.omitted,
    unreadable: listed.unreadable,
    machines: listed.machines,
  });
});

const modelsFacts = Effect.fn("Tools.modelsFacts")(function* (
  env: PluginEnv,
  harness: string | undefined,
) {
  const read = yield* catalogueReadings(env, yield* toolDoor(env));
  if (!read.ok) return `- (the models could not be read: ${read.error.message})`;
  return modelsLines(read.value, harness);
});

const connectionFacts = Effect.fn("Tools.connectionFacts")(function* (env: PluginEnv) {
  const read = yield* connectionReadings(env, yield* toolDoor(env));
  return read.ok
    ? connectionsLines(read.value)
    : `- (the Connections could not be read: ${read.error.message})`;
});

const UNSCOPED_KINDS: ReadonlyArray<string> = ["start", "confirm", "decline"];

const wantsRun = (action: JsonObject) => {
  const kind = action["kind"];
  return action["run"] === undefined && isString(kind) && !UNSCOPED_KINDS.includes(kind);
};

const onSelection = Effect.fn("Tools.onSelection")(function* (env: PluginEnv, input: JsonObject) {
  const loose = decodeLoose(input);
  if (loose._tag === "None" || !Arr.some(loose.value.actions, wantsRun)) return { input, on: null };
  const on = yield* selectionOf(env);
  if (on === null) return { input, on: null };
  const filled = Arr.map(loose.value.actions, (action) =>
    wantsRun(action) ? { ...action, run: on.run } : action,
  );
  return { input: { ...input, actions: filled }, on };
});

const onSelectedRun = Effect.fn("Tools.onSelectedRun")(function* (
  env: PluginEnv,
  selected: boolean,
  input: typeof RunInput.Type,
  tool: string,
  answer: (run: RunFacts) => ToolAnswer,
  runs?: Effect.Effect<ReadonlyArray<RunFacts>>,
) {
  const named = input.run ?? null;
  const on = named === null && selected ? yield* selectionOf(env) : null;
  const id = named ?? on?.run ?? null;
  if (id === null && !selected) return `${tool} takes {"run": "<run id>"}.`;
  if (id === null)
    return `${tool} takes {"run": "<run id>"}, or answers about the board's selection when there is one. The board has nothing selected — collie_herd lists the Runs there are.`;
  const run =
    runs === undefined
      ? yield* findRun(env, id)
      : (Option.getOrUndefined(Arr.findFirst(yield* runs, (one) => one.id === id)) ?? null);
  if (run === null)
    return on === null
      ? `No Run "${id}". collie_herd lists the ones there are.`
      : `The board has "${on.name}" selected, but Collie has no Run "${id}" any more.`;
  const text = yield* answer(run);
  return on === null
    ? text
    : `About "${on.name}" (${on.run}), which the board has selected.\n\n${text}`;
});

const hold = Effect.fn("Tools.hold")(function* (env: PluginEnv, input: typeof HoldInput.Type) {
  const { task, reason } = input;
  const on = input.run === undefined && task === undefined ? yield* selectionOf(env) : null;
  const run = input.run ?? on?.run;
  if (run === undefined && task === undefined)
    return "collie_hold needs a run or a task to hold, and the board has nothing open. Ask which one they meant.";
  const why = reason ?? "asked in chat";
  const requestId = yield* (yield* SecureRandom.SecureRandom).uuidV4();

  const oneRun: Action = { kind: "hold", run: run!, reason: why };
  const held = yield* actAsked(env, {
    door: yield* toolDoor(env),
    actions: task === undefined ? [oneRun] : yield* holdsFor(env, task, why),
    request: requestId,
  });
  const about = on === null ? "" : `On the board's selection, "${on.name}": `;
  return (
    about +
    (held.length === 0
      ? `Nothing here is running${why === "" ? "" : ` (${why})`}.`
      : Arr.join(
          Arr.map(held, (result) => Str.trim(`${result.kind}: ${result.state} ${result.note}`)),
          "\n",
        ))
  );
});

const holdsFor = Effect.fn("Tools.holdsFor")(function* (
  env: PluginEnv,
  task: string,
  reason: string,
) {
  const runs = Arr.filter((yield* runViews(env, task)).runs, (view) => !isSettled(view));
  return Arr.map(runs, (view) => ({ kind: "hold" as const, run: view.runId, reason }));
});

const reachLine = (
  workflow: string,
  reach: Reach | null,
  reached: ReadonlyArray<{ workflow: string; project: string; value: string }>,
) => {
  if (reach === null) return [];
  const choices = Arr.join(
    Arr.map(reach.choices, (choice) => `"${choice.value}" ${choice.title}`),
    " · ",
  );
  const last = Arr.map(
    Arr.filter(reached, (one) => one.workflow === workflow),
    (one) => `last launched with "${one.value}" in ${one.project}`,
  );
  return [`  ${reach.name}, how far it goes: ${Arr.join([choices, ...last], "; ")}`];
};

const workspaceFacts = Effect.fn("Tools.workspaces")(function* (env: PluginEnv) {
  const saved = (yield* savedModules(env)).entries;
  const asked = yield* Effect.result(hostTasks(env));
  const tasks = Result.isSuccess(asked) ? Arr.filter(asked.success, isOpen) : [];
  const root = yield* projectsRoot(env).pipe(Effect.orElseSucceed(() => null));
  const reached = yield* savedReaches(env.userDir);
  return Arr.join(
    [
      ...Arr.map(tasks, (task) => `- task ${task.id} (${task.label}): ${task.cwd}`),
      ...(Result.isFailure(asked)
        ? [`- (the Tasks are unknown: ${asked.failure.message})`]
        : tasks.length === 0
          ? ["- (no open Tasks)"]
          : []),
      "",
      root === null
        ? "Projects root: none"
        : `Projects root: ${root.path} — a checkout under it is named by its directory name`,
      "",
      "workflows, with the Inputs each takes (? is optional) and what it is for:",
      ...Arr.flatMap(
        [...saved].sort((a, b) => pipe_(a.id, Str.localeCompare(b.id))),
        (one) => [
          `- ${one.id} (${Arr.join(
            Arr.map(one.inputs, (input) => `${input.name}${input.required ? "" : "?"}`),
            ", ",
          )})${one.description === "" ? "" : ` — ${one.description}`}`,
          ...reachLine(one.id, reachOf(one.inputs), reached),
        ],
      ),
      ...(saved.length === 0 ? ["- none"] : []),
      "",
      "a start names its workspace — the path of a checkout on this Machine, a repository's",
      "directory name under the Projects root, or projects-root — and every Input, an optional",
      'one left empty as "". Nothing is inferred; a start missing any is refused with each listed.',
      "How far it goes is the human's to say: pass what they said, else what the last launch of",
      'that workflow in that project chose, else "". A start for them saves it for the next.',
    ],
    "\n",
  );
});

const reportFacts = Effect.fn("Tools.reportFacts")(function* (
  env: PluginEnv,
  since: string | null,
) {
  if (since !== null && Number.isNaN(epochMs(since))) return `"since" is not a date: ${since}`;
  const done = yield* reportFor(env, since);
  return done.ok ? reportLines(done.report, done.unreadable) : done.error.message;
});

const newsFacts = Effect.fn("Tools.news")(function* (env: PluginEnv) {
  const key = yield* machineHerd(env).pipe(Effect.orElseSucceed(() => null));
  if (key === null) return "Collie cannot reach core, so it has nothing to report.";
  const door = yield* toolDoor(env);
  const read = yield* settleNewsFor(env, {
    door,
    herd: key,
    conversation:
      door.origin === "agent" && door.from !== undefined
        ? `${door.from.run}/${door.from.agent}`
        : NATIVE,
    as: "read",
    request: yield* newRequestId(),
  });
  return read.ok ? newsText(read.value) : `Collie could not read the news: ${read.error.message}`;
});

const receiptFacts = Effect.fn("Tools.receipts")(function* (env: PluginEnv, run: string) {
  const found = yield* findRun(env, run);
  if (found === null) return `No Run "${run}".`;
  const now = yield* Clock.currentTimeMillis;
  const proposals = pendingFor(yield* hostRunProposals(env, run), run, now);
  const asked = yield* asks(env, (client) => client.deliveries({ runId: run }));
  const deliveries = asked.ok ? (asked.value ?? []) : [];
  const unread = asked.ok ? [] : [`- the ledger could not be read: ${asked.error.message}`];
  const waiting = [
    ...Arr.flatMap(found.asking, (asked) =>
      Arr.map(choiceLines(run, asked), (line, n) => (n === 0 ? `- ${line}` : `  ${line}`)),
    ),
    ...Arr.map(
      proposals,
      (p) => `- ${p.id} (${p.content_hash}): ${p.interpretation} — expires ${p.expires_at}`,
    ),
  ];
  return Arr.join(
    [
      "### Waiting on the human",
      "",
      ...(waiting.length === 0 ? ["- nothing"] : waiting),
      "",
      "### Sent to this Run's agents",
      "",
      ...(deliveries.length === 0 && unread.length === 0
        ? ["- nothing"]
        : Arr.map(
            deliveries,
            (delivery) =>
              `- ${delivery.id}: ${delivery.state}${delivery.note ? ` (${delivery.note})` : ""}, for ${delivery.cause.kind}${delivery.workflowNotice === undefined ? "" : `. ${delivery.workflowNotice}`}`,
          )),
      ...unread,
    ],
    "\n",
  );
});

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
    const module = Option.getOrUndefined(
      Arr.findFirst(saved.entries, (one) => one.id === asked.workflow),
    );
    if (module) return moduleFacts(yield* readModule(module), yield* checkModule(module));
    const broken = Option.getOrUndefined(
      Arr.findFirst(saved.problems, (one) => one.id === asked.workflow),
    );
    if (broken) return `${broken.path} will not load: ${broken.message}`;
    return `No Workflow "${asked.workflow}".`;
  }
  return Arr.join(
    [
      "### Workflows",
      "",
      ...Arr.map(saved.entries, (one) => `- ${one.id} (${one.layer}): ${one.description}`).sort(),
      ...(saved.problems.length > 0
        ? ["", ...Arr.map(saved.problems, (one) => `- ${one.id}: ${one.path} will not load`)]
        : []),
      "",
      "### Personas",
      "",
      ...Arr.map(
        [...defs.personas.values()].sort((a, b) => pipe_(a.name, Str.localeCompare(b.name))),
        (p) => `- ${p.name} (${p.layer}): ${p.description}`,
      ),
      ...(defs.errors.length > 0
        ? ["", "### Would not load", "", ...Arr.map(defs.errors, (e) => `- ${e}`)]
        : []),
    ],
    "\n",
  );
});

const asJson = Schemaflow(
  Schema.encodeResult(Schema.fromJsonString(Schema.Json)),
  Result.getOrThrow,
);

const moduleFacts: (one: Described, checked: ModuleCheck) => string = (one, checked) =>
  Arr.join(
    [
      `${one.id} (${one.layer}): ${one.title}`,
      one.description,
      `inputs: ${
        Arr.join(
          Arr.map(one.inputs, (input) => `${input.name}${input.required ? "" : "?"}`),
          ", ",
        ) || "none"
      }`,
      `the host also settles: ${Arr.join(
        Arr.map(one.options, (option) => option.name),
        ", ",
      )}`,
      `result: ${asJson(one.success.schema)}`,
      `failure: ${asJson(one.error.schema)}`,
      `metadata: ${asJson(one.metadata)}`,
      checked.problems.length === 0
        ? checked.toolchain === null
          ? "checks out"
          : `checks out, but nothing typechecked it: ${checked.toolchain}`
        : `problems:\n${Arr.join(
            Arr.map(checked.problems, (problem) => `- ${problem}`),
            "\n",
          )}`,
      ...Arr.map(checked.limits, (limit) => `drawn without: ${limit}`),
      `defined in: ${one.path}`,
    ],
    "\n",
  );

const CLEANUP_LINES = 60;

const shortened = (text: string, most: number) => {
  const lines = Str.split(text, "\n");
  return lines.length <= most
    ? text
    : Arr.join([...lines.slice(0, most), `(${lines.length - most} more lines)`], "\n");
};

const installationFacts = Effect.fn("Tools.installation")(function* (env: PluginEnv) {
  const key = yield* machineHerd(env).pipe(Effect.orElseSucceed(() => null));
  const health = yield* doctor(env).pipe(Effect.orElseSucceed(() => null));
  const tasks = yield* hostTasks(env).pipe(Effect.orElseSucceed(() => []));
  const dirs = Arr.dedupe(Arr.map(Arr.filter(tasks, isOpen), (task) => task.cwd));
  const defaults = yield* Effect.forEach(dirs, (cwd) =>
    Effect.gen(function* () {
      const found =
        (yield* readDefaults(yield* defaultsPath(env.stateDir, scopeKey(scopeFor(cwd))))) ??
        EMPTY_DEFAULTS;
      return `- ${cwd}: ${pipe_(describeDefaults(found), Str.replaceAll("\n", "; ")) || "nothing"}`;
    }),
  );
  const harness = yield* chatHarnessOf(env.userDir);
  const chat = key === null ? null : yield* readChat(yield* chatPath(env.stateDir, key));
  const served = yield* anyRuns(env);
  const sweepable = served ? yield* cleanupListing(env, "chat") : null;
  const scheduled = served ? yield* scheduleListing(env, "chat") : null;
  const standing = standingDirectionContext(
    yield* standingDirectionOn(env.userDir).pipe(Effect.orElseSucceed(() => undefined)),
  );
  return Arr.join(
    [
      `health: ${health === null ? "could not be checked" : health.ok ? health.human : health.error.message}`,
      "",
      sweepable === null
        ? "cleanup: nothing swept here yet"
        : sweepable.ok
          ? `cleanup, as \`collie cleanup\` lists it:\n${shortened(cleanupLines(sweepable.value, false), CLEANUP_LINES)}`
          : `cleanup: ${sweepable.error.message}`,
      scheduled === null
        ? "schedules: none"
        : scheduled.ok
          ? scheduleLines(scheduled.value)
          : `schedules: ${scheduled.error.message}`,
      "",
      "every new Run begins with, by the directory of each open Task:",
      ...(defaults.length > 0 ? defaults : ["- (no open Tasks)"]),
      "",
      `chat: ${harness}${whyUnavailable(harness, Bun.which(harness)) ?? " installed"}, running ${chat?.harness ?? "nothing"}`,
      `delivery: ${pushable(harness).how}`,
      ...(standing === undefined ? [] : ["", standing]),
    ],
    "\n",
  );
});

export function toolNamed(name: string) {
  return (
    Option.getOrUndefined(Arr.findFirst([...TOOLS, SUBMIT], (tool) => tool.name === name)) ?? null
  );
}

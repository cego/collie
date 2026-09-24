// What a confirmed action does to a Run, and the one place each kind is carried out.
//
// The actions are the same whoever confirmed them — a human on the board, a chat turn, a
// CLI `confirm` — so they are registered once, here, against the host that is running the
// work. An action kind with nothing registered for it is refused rather than reported as
// done; `executors.ts` is what holds that line, and this only fills it in.
//
// Its own module rather than part of `operations.ts`, because carrying an action out means
// asking the host, and `lifecycle.ts` — the client side of the host — reads its refusals
// from `operations.ts`. One direction each way is a cycle; one module downstream of both
// is not.

import { Effect } from "effect";
import type { PlatformError } from "effect/PlatformError";
import { reason } from "./naming";
import type { BunServices } from "@effect/platform-bun/BunServices";
import { executorFor, registerExecutor, registeredKinds, type ExecutionResult } from "./executors";
import type { PluginEnv } from "./env";
import {
  answerRun,
  controlRun,
  invokeOffer,
  offersOf,
  startRun,
  steerRun,
  resumeRun,
} from "./lifecycle";
import {
  clearOverride,
  err,
  newRequestId,
  workspaceNamed,
  type Failure,
  type OpResult,
} from "./operations";
import { Herdr } from "./herdr";
import { runDir } from "./engine";
import { withDirLock } from "./lock";
import {
  amend as amendIntent,
  constraintId,
  describeDefaults,
  defaultsPath,
  EMPTY_DEFAULTS,
  parseConstraint,
  readDefaults,
  readIntent,
  writeDefaults,
  writeIntentHeld,
  type Intent,
} from "./intent";
import { scopeKey } from "./registry";
import { layers, loadDefinitions } from "./definitions";
import { closable } from "./home";
import { forkResolvedDefinition } from "./fork";
import { upgrade } from "./operations";
import { nowIso } from "./time";
import {
  actorName,
  admit,
  confirm as confirmProposal,
  proposalsPath,
  read as readProposals,
  stepSettled,
  stepStarted,
  type Actor,
  type ProposalRecord,
} from "./proposals";
import type { Action } from "./evaluator";
import { herdOf } from "./steering";
import { fingerprint } from "./verify";
import { findRun, settled } from "./runs";

/**
 * Every action kind this build can carry out, against the host that owns the work.
 * Called once per process by whichever front door is about to look an executor up.
 */
export const registerRunExecutors = Effect.fn("runActions.register")(function* (
  env: PluginEnv,
  /**
   * What a board does about a `navigate`: put the target on screen. Supplied by the
   * Control Plane and by nothing else, because `navigate` is a Selection change and a
   * CLI has no Selection — a `confirm` there names the target and stops.
   */
  opts: { readonly navigate?: (target: { run: string; agent?: string }) => void } = {},
) {
  // Once per process. A front door calls this before it looks an executor up, and two
  // calls in one process would be the same module claiming an action kind twice.
  if (registeredKinds().length > 0) return;
  const failed = (note: string): ExecutionResult => ({ state: "failed", note });
  const settled = (result: OpResult | Failure): ExecutionResult =>
    result.ok ? { state: "applied", note: result.human } : failed(result.error.message);
  const carry = (what: Effect.Effect<OpResult | Failure, PlatformError, BunServices>) =>
    what.pipe(
      Effect.map(settled),
      Effect.catch((cause) => Effect.succeed(failed(reason(cause)))),
    );

  registerExecutor("stop", (action) =>
    carry(controlRun(env, { runId: action.run, control: "stop", set: true })),
  );
  registerExecutor("resume", (action) => carry(resumeRun(env, action.run)));
  registerExecutor("answer", (action) =>
    carry(
      Effect.gen(function* () {
        const id = yield* newRequestId();
        return yield* answerRun(env, {
          runId: action.run,
          // The question as the board named it, so an answer that arrives after it was
          // replaced lands on the one it was given rather than on whatever is open now.
          decision: action.choiceId === "" ? null : action.choiceId,
          value: action.answer,
          request: id,
        });
      }),
    ),
  );
  registerExecutor("hold", (action) =>
    carry(controlRun(env, { runId: action.run, control: "hold", set: true })),
  );
  registerExecutor("release", (action) =>
    carry(controlRun(env, { runId: action.run, control: "hold", set: false })),
  );
  registerExecutor("clear_override", (action, by) =>
    carry(clearOverride(env.stateDir, new Herdr(env), action.run, action.agent, by)),
  );
  registerExecutor("deliver", (action) =>
    carry(
      Effect.gen(function* () {
        const id = yield* newRequestId();
        return yield* steerRun(env, {
          runId: action.run,
          agent: action.agent,
          text: action.text,
          request: id,
          mode: action.mode,
        });
      }),
    ),
  );
  registerExecutor("navigate", (action) =>
    Effect.sync(() => {
      opts.navigate?.({ run: action.run, agent: action.agent });
      const where = [action.run, action.agent].filter((part) => part !== undefined).join(" · ");
      return { state: "applied" as const, note: where };
    }),
  );
  registerExecutor("update_intent", (action, by) =>
    Effect.gen(function* () {
      const dir = runDir(env.stateDir, action.run);
      // The version check and the write under one lock: read outside it, two
      // confirmations both pass the check and the later rename erases the earlier.
      const next = yield* withDirLock(
        dir,
        Effect.gen(function* () {
          const intent: Intent | null = yield* readIntent(dir).pipe(
            Effect.catch(() => Effect.succeed(null)),
          );
          if (intent === null)
            return { ok: false, why: `Run "${action.run}" has no Intent to amend` } as const;
          if (intent.version !== action.base_version)
            return {
              ok: false,
              why: `the Intent is v${intent.version}, not v${action.base_version}`,
            } as const;
          // A constraint is taken in the human's own words — a `semantic` one, because
          // nothing a model writes is a rule Collie can check by itself. The other two
          // amendments take the patch as the goal, and as the constraint's id.
          const amended = amendIntent(
            intent,
            action.change === "set-goal"
              ? { kind: "set-goal", goal: action.patch }
              : action.change === "remove-constraint"
                ? { kind: "remove-constraint", id: action.patch }
                : {
                    kind: "add-constraint",
                    constraint: {
                      id: constraintId(action.patch),
                      kind: "semantic",
                      text: action.patch,
                      severity: "warn",
                      source: "human",
                    },
                  },
            by,
            yield* nowIso(),
          );
          yield* writeIntentHeld(dir, amended);
          return { ok: true, amended } as const;
        }),
      );
      if (!next.ok) return failed(next.why);
      // Nothing is told: a Run reads its Intent at its next boundary, from the file this
      // has just written.
      return { state: "applied" as const, note: `intent v${next.amended.version}` };
    }).pipe(Effect.catch((cause) => Effect.succeed(failed(String(cause))))),
  );
  // Which Workflow carries a follow-up is the Workflow's own declaration — the offer it
  // marks `follow-up` — never a name known here. One that declares none has nothing to
  // carry on with, and says so rather than starting something nobody asked for.
  registerExecutor("followup", (action) =>
    Effect.gen(function* () {
      const offers = yield* offersOf(env, action.run);
      if ("ok" in offers) return failed(offers.error.message);
      const offered = offers.find((one) => one.kind === "follow-up");
      if (offered === undefined)
        return failed(`${action.run} declares no follow-up, so there is nothing to carry on with`);
      const id = yield* newRequestId();
      return settled(
        yield* invokeOffer(env, {
          runId: action.run,
          offer: offered.id,
          input: { text: action.text },
          request: id,
        }),
      );
    }).pipe(Effect.catch((cause) => Effect.succeed(failed(String(cause))))),
  );
  // Through the same door `run start` takes, so a confirmed proposal and a typed command
  // settle Inputs the same way. An Input the action did not name is refused rather than
  // guessed: nobody is here to be asked, and a Run started on an inferred work source is
  // a Run about something the human never said.
  registerExecutor("start", (action) =>
    Effect.gen(function* () {
      // Where the work is. A launch that named a workspace roots in that workspace's
      // checkout; one that named none roots where the caller is, as `run start` does.
      const where = yield* workspaceNamed(env, action.workspace);
      if (where !== null && "error" in where) return failed(where.error);
      const rooted =
        where === null
          ? env
          : { ...env, cwd: where.found.cwd, workspaceId: where.found.workspaceId };
      const id = yield* newRequestId();
      const started = yield* startRun(rooted, {
        id: action.workflow,
        request: id,
        // Text, as the action carries it: the module's own schema is what turns it into
        // the value it takes, exactly as a typed `run start` does.
        input: { text: { ...action.inputs }, json: {} },
        options: {},
        task: { mode: "new" },
      });
      return started.ok
        ? { state: "applied" as const, note: `started ${started.runId}` }
        : failed(started.error.message);
    }).pipe(Effect.catch((cause) => Effect.succeed(failed(String(cause))))),
  );
  registerExecutor("update_defaults", (action) =>
    Effect.gen(function* () {
      // The named workspace's scope, never this process's. A Run reads its defaults under
      // the workspace it was started in; the board confirming a proposal is in the Home,
      // and writing there would be writing a file no Run opens.
      const where = yield* workspaceNamed(env, action.workspace);
      if (where === null) return failed("update_defaults has to name a workspace");
      if ("error" in where) return failed(where.error);
      const scope = {
        session: env.socketPath,
        workspaceId: where.found.workspaceId,
        cwd: where.found.cwd,
      };
      const file = yield* defaultsPath(env.stateDir, scopeKey(scope));
      const current = (yield* readDefaults(file)) ?? EMPTY_DEFAULTS;
      if (action.change === "remove-constraint") {
        // By id, and refused when nothing has it: ids are a hash of the text, so a
        // constraint named in prose matches none — and reporting that as applied would
        // tell the human a standing constraint was dropped that is still there.
        if (!current.constraints.some((c) => c.id === action.text))
          return failed(
            `no default constraint "${action.text}" in ${where.found.workspaceId}; remove one by the id \`collie_installation\` lists`,
          );
        const next = {
          ...current,
          constraints: current.constraints.filter((c) => c.id !== action.text),
        };
        yield* writeDefaults(file, next);
        return { state: "applied" as const, note: describeDefaults(next) };
      }
      const parsed = parseConstraint(action.text, "warn");
      if ("error" in parsed) return failed(parsed.error);
      // Filed as what it is: a default, not something a human typed for one Run.
      const constraint = { ...parsed, source: "workspace-default" as const, since: 1 };
      const next = {
        ...current,
        constraints: [...current.constraints.filter((c) => c.id !== constraint.id), constraint],
      };
      yield* writeDefaults(file, next);
      return { state: "applied" as const, note: describeDefaults(next) };
    }).pipe(Effect.catch((cause) => Effect.succeed(failed(String(cause))))),
  );
  // A persona is Markdown and is forked by copying it. A workflow is a module, and
  // `collie workflow fork` writes one that imports what it keeps — which is not this.
  registerExecutor("fork_definition", (action) =>
    Effect.gen(function* () {
      if (action.what !== "persona")
        return failed("a workflow is forked with `collie workflow fork`, which writes a module");
      const layer = action.layer ?? "user";
      const available = yield* layers(env);
      const found = (yield* loadDefinitions(available)).personas.get(action.name);
      if (!found) return failed(`No persona "${action.name}".`);
      const result = yield* forkResolvedDefinition(
        { path: found.path, kind: "personas", steps: [], body: found.body },
        available[layer].dir,
        { name: action.as, full: true },
      );
      return result.ok
        ? { state: "applied" as const, note: `forked to ${result.path}` }
        : failed(result.message);
    }).pipe(Effect.catch((cause) => Effect.succeed(failed(String(cause))))),
  );
  registerExecutor("home_cleanup", () =>
    Effect.gen(function* () {
      const herdr = new Herdr(env);
      const panes = yield* herdr.paneList();
      // Only the panes that are Collie's alone: a legacy pane sharing a tab with
      // something else is left, because taking somebody's window away is not cleanup.
      const { close, listed } = closable(panes);
      for (const paneId of close)
        yield* herdr.paneClose(paneId).pipe(Effect.catch(() => Effect.void));
      return {
        state: "applied" as const,
        note: `closed ${close.length}, left ${listed.length} sharing a tab`,
      };
    }).pipe(Effect.catch((cause) => Effect.succeed(failed(String(cause))))),
  );
  registerExecutor("upgrade", () =>
    upgrade(env).pipe(
      Effect.map(settled),
      Effect.catch((cause) => Effect.succeed(failed(String(cause)))),
    ),
  );
  yield* Effect.void;
});

/** What a caller is told about an id nothing is running. */
export const noSuchRun = (runId: string): Failure =>
  err("run_not_found", `Run "${runId}" was not found.`, { run: runId });

export const carryOutProposal = Effect.fn("runActions.carryOutProposal")(function* (
  env: PluginEnv,
  proposalId: string,
  hash: string | undefined,
  actor: Actor,
) {
  // The operations register what they can carry out; without this the registry is empty
  // and every action is refused as `executor_missing`, which would be a lie about this
  // build rather than a fact about it.
  yield* registerRunExecutors(env);
  const file = yield* proposalsPath(env.stateDir, yield* herdOf(env.socketPath));
  const proposal = (yield* readProposals(file)).find(
    (line): line is ProposalRecord => line.kind === "proposal" && line.id === proposalId,
  );
  const versions = new Map<string, number>();
  for (const target of proposal?.targets ?? []) {
    const intent = yield* readIntent(runDir(env.stateDir, target.run)).pipe(
      Effect.catch(() => Effect.succeed(null)),
    );
    if (intent !== null) versions.set(target.run, intent.version);
  }

  const judged = yield* confirmProposal(
    file,
    proposalId,
    hash ?? proposal?.content_hash ?? "",
    actor,
    versions,
  );
  if ("refused" in judged) return err("invalid_input", judged.detail, { reason: judged.refused });

  const results: Array<{ index: number; kind: string; state: string; note: string }> = [];
  const expectedVersions = { ...judged.proposal.intent_versions };
  // Runs an earlier action failed on: what was asked about them next was asked assuming
  // the failure did not happen. Everything else in the request is independent of it —
  // six launches asked for in one breath are six requests, and the first path that does
  // not exist is no reason to leave the other five unattempted.
  const failedRuns = new Set<string>();
  for (const [index, proposed] of judged.actions.entries()) {
    if ("run" in proposed && failedRuns.has(proposed.run)) {
      yield* stepSettled(file, proposalId, index, "skipped", "after_failure");
      results.push({ index, kind: proposed.kind, state: "skipped", note: "after_failure" });
      continue;
    }
    // All edits in a request name the snapshot it was checked against. Advance only
    // for edits this sequence applied; unrelated concurrent edits still fail admission.
    const action =
      proposed.kind === "update_intent" &&
      proposed.base_version === judged.proposal.intent_versions[proposed.run]
        ? { ...proposed, base_version: expectedVersions[proposed.run] ?? proposed.base_version }
        : proposed;
    if (action.kind === "none" || action.kind === "ask_human") {
      const state = action.kind === "none" ? "applied" : "failed";
      const note = action.kind === "none" ? action.why : action.question;
      yield* stepSettled(file, proposalId, index, state, note);
      results.push({ index, kind: action.kind, state, note });
      if (action.kind === "ask_human") break;
      continue;
    }
    const executor = executorFor(action.kind);
    if (!executor) {
      yield* stepSettled(file, proposalId, index, "skipped", "executor_missing");
      results.push({ index, kind: action.kind, state: "skipped", note: "executor_missing" });
      break;
    }
    const refusal = yield* admissionFor(env, action, {
      ...judged.proposal,
      intent_versions: expectedVersions,
    });
    if (refusal !== null) {
      yield* stepSettled(file, proposalId, index, "skipped", refusal);
      results.push({ index, kind: action.kind, state: "skipped", note: refusal });
      break;
    }
    yield* stepStarted(file, proposalId, index);
    const outcome = yield* executor(action, actorName(actor));
    yield* stepSettled(file, proposalId, index, outcome.state, outcome.note);
    results.push({
      index,
      kind: action.kind,
      state: outcome.state,
      note: outcome.note ?? "",
    });
    if (outcome.state === "failed" && "run" in action) failedRuns.add(action.run);
    if (outcome.state !== "failed" && action.kind === "update_intent")
      expectedVersions[action.run] = action.base_version + 1;
  }
  const message = results
    .map((r) => `${r.index} ${r.kind}: ${r.state}${r.note ? ` — ${r.note}` : ""}`)
    .join("\n");
  if (results.some((r) => r.state === "failed" || r.state === "skipped")) {
    const changed = results.some((r) => r.state === "applied" && r.kind !== "none");
    // needs_input is retryable without a receipt only when nothing has happened yet.
    const code =
      results.at(-1)?.kind === "ask_human" && !changed ? "needs_input" : "operation_failed";
    return err(code, message, {
      proposal: proposalId,
      results,
    });
  }
  return {
    ok: true as const,
    data: { proposal: proposalId, results },
    human: message,
  };
});

/**
 * One action the human asked for in chat, carried out now. The same closed union, the
 * same last-moment admission check and the same executors a confirmation runs; what it
 * has no part of is a proposal, because nobody is being asked — the human already said
 * it (ADR-0011). What Collie wants of its own accord still goes through `request`.
 */
export const carryOutAsked = Effect.fn("runActions.carryOutAsked")(function* (
  env: PluginEnv,
  actions: ReadonlyArray<Action>,
  actor: Actor,
) {
  yield* registerRunExecutors(env);
  const results: Array<{ kind: string; state: string; note: string }> = [];
  for (const action of actions) {
    const executor = executorFor(action.kind);
    if (!executor) {
      results.push({ kind: action.kind, state: "skipped", note: "executor_missing" });
      continue;
    }
    const refusal = yield* admissionFor(env, action, null);
    if (refusal !== null) {
      results.push({ kind: action.kind, state: "skipped", note: refusal });
      continue;
    }
    const outcome = yield* executor(action, actorName(actor));
    results.push({ kind: action.kind, state: outcome.state, note: outcome.note ?? "" });
    // What follows a failure was asked for on the assumption that it did not happen.
    if (outcome.state === "failed") break;
  }
  return results;
});

/** Everything the proposal assumed, asked again immediately before the action runs. */
const admissionFor = Effect.fn("runActions.admissionFor")(function* (
  env: PluginEnv,
  action: Parameters<typeof admit>[0],
  /** Null for an action nobody proposed: there is then nothing it assumed earlier. */
  proposal: ProposalRecord | null,
) {
  const id = "run" in action ? action.run : null;
  const run = id === null ? null : yield* findRun(env, id);
  if (run === null) return admit(action, emptyAdmission());
  const live = yield* new Herdr(env).agentList().pipe(Effect.catch(() => Effect.succeed([])));
  const agent = "agent" in action ? (action.agent ?? null) : null;
  // An Intent nobody can decode is not an Intent with no constraints. Refusing here is
  // what stops a corrupt file reading as "no version to disagree with".
  const intent = yield* readIntent(run.dir).pipe(
    Effect.catch(() => Effect.succeed<Intent | "unreadable">("unreadable")),
  );
  if (intent === "unreadable") return `${run.id}'s Intent cannot be read`;
  const bound = proposal?.card;
  const here = bound === undefined ? null : yield* fingerprint(run.cwd);
  const now = here === null ? null : `${here.head_sha}:${here.fingerprint}`;
  return admit(action, {
    run: { id: run.id, status: run.state },
    hostHolds: !settled(run),
    pendingChoice: run.asking[0]?.name ?? null,
    incarnation: agent === null ? null : (live.find((a) => a.name === agent)?.terminalId ?? null),
    proposedIncarnation: agent === null ? null : (proposal?.incarnations?.[agent] ?? null),
    intentVersion: intent?.version ?? null,
    proposedIntentVersion: proposal?.intent_versions[run.id] ?? null,
    revision: bound === undefined || now === null ? null : { card: bound.revision, now },
  });
});

function emptyAdmission(): Parameters<typeof admit>[1] {
  return {
    run: null,
    hostHolds: false,
    pendingChoice: null,
    incarnation: null,
    proposedIncarnation: null,
    intentVersion: null,
    proposedIntentVersion: null,
    revision: null,
  };
}

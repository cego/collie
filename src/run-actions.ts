// WARNING: carrying out needs the host, and lifecycle reads operations, so this module sits downstream of both.
import * as Rec from "effect/Record";
import * as Arr from "effect/Array";
import * as Str from "effect/String";
import { pipe as pipe_ } from "effect/Function";
import { withNotice } from "./redact";
import { Effect, Option, Schema } from "effect";
import { hostname } from "node:os";
import type { PlatformError } from "effect/PlatformError";
import { reason } from "./naming";
import { once } from "./audit";
import type { PlatformServices } from "./platform";
import type { Records } from "./records";
import { executorFor, registerExecutor, registeredKinds } from "./executors";
import type { ExecutionResult } from "./executors";
import type { PluginEnv } from "./env";
import {
  answerRun,
  carriedResult,
  changeIntentRun,
  controlRun,
  followUpRun,
  grantRun,
  invokeTypedOffer,
  rememberChecks,
  moduleFor,
  startRun,
  steerRun,
  withdrawNoteRun,
  resumeRun,
  runViews,
  sweepNow,
  changeSchedule,
} from "./lifecycle";
import type { ScheduleChange } from "./schedule-model";
import { listRuns } from "./runs";
import { humanBytes } from "./bytes";
import { agentStartRefusal, CHAT_CHECKOUT_FIX } from "./agent-start";
import { RESERVED_INPUTS } from "./sdk";
import { PROJECTS_ROOT_OPTION, projectsRoot, repositoryCheckout } from "./projects";
import {
  fileTask,
  followTask,
  isOpen,
  listTasks,
  newQueuedTask,
  readTask,
  removeTask,
  unfollowTask,
  writeTask,
} from "./task";
import type { Filing } from "./task";
import { FilingSchema } from "./task";
import { adoptPlan, appendEvent, editSpec, postTo, resolvePost } from "./task-context";
import {
  hostInstallation,
  isArchived,
  newProject,
  readProject,
  withProjectLock,
  writeProject,
} from "./project";
import type { ProjectRecord, ProjectRef } from "./project";
import { machineName, peersOf } from "./peers";
import { connectPeer } from "./host";
import { clearOverride, collieOwnRefusal, err, workspaceNamed } from "./operations";
import type { Failure, OpResult } from "./operations";
import { Herdr } from "./herdr";
import { runDir } from "./engine";
import {
  amend as amendIntent,
  constraintId,
  describeDefaults,
  defaultsPath,
  EMPTY_DEFAULTS,
  outcomeChange,
  parseConstraint,
  readDefaults,
  readIntent,
  verificationGrant,
  updateIntent,
  writeDefaults,
} from "./intent";
import { scopeFor, scopeKey } from "./registry";
import { layers, loadDefinitions } from "./definitions";
import { forkResolvedDefinition } from "./fork";
import { upgrade } from "./operations";
import { onboard } from "./onboard";
import manifest from "../package.json";
import { nowIso } from "./time";
import {
  actorName,
  admit,
  answeredBy,
  confirm as confirmProposal,
  journalOf,
  read as readProposals,
  stepResults,
  stepSettled,
  stepStarted,
  voiceOf,
} from "./proposals";
import type { Actor, ProposalRecord } from "./proposals";
import type { Action } from "./actions";
import { ProposalRefused } from "./board-model";
import type { ProposalCarried, StepResult } from "./board-model";
import { fingerprint } from "./verify";
import { findRun } from "./runs";

const takesFields = Schema.decodeUnknownOption(
  Schema.Struct({
    properties: Schema.optional(Schema.Record(Schema.String, Schema.Json)),
    required: Schema.optional(Schema.Array(Schema.String)),
  }),
);

export function followUpField(drawn: Schema.Json | null) {
  const takes = Option.getOrUndefined(takesFields(drawn));
  const open = Rec.keys(takes?.properties ?? {});
  const required = takes?.required ?? [];
  const field = required.length === 1 ? required[0] : open.length === 1 ? open[0] : undefined;
  return field === undefined
    ? { refused: `takes ${Arr.join(open, ", ") || "nothing"} rather than one piece of text` }
    : { field };
}

// WARNING: a second resolver would let a picker list Workflows the Start in that checkout cannot find.
export const startIn = Effect.fn("RunActions.startIn")(function* (
  env: PluginEnv,
  named: string | undefined,
) {
  const atRoot =
    Option.getOrUndefined(
      Option.map(Option.fromNullishOr(named), (present) => Str.trim(present)),
    ) === PROJECTS_ROOT_OPTION;
  const repository = named === undefined || atRoot ? null : yield* repositoryCheckout(env, named);
  if (repository !== null && "error" in repository) {
    return repository;
  }
  const where = atRoot
    ? null
    : repository !== null
      ? { found: { cwd: repository.path, label: named ?? "" } }
      : yield* workspaceNamed(env, named);
  return { atRoot, repository, where };
});

export const registerRunExecutors = Effect.fn("runActions.register")(function* () {
  // WARNING: a second registration would claim an action kind twice, so a repeat call returns early.
  if (registeredKinds().length > 0) {
    return;
  }
  const failed: (note: string) => ExecutionResult = (note) => ({ state: "failed", note });
  const settled: (result: OpResult | Failure) => ExecutionResult = (result) =>
    result.ok ? { state: "applied", note: result.human } : failed(result.error.message);
  const carry = (
    what: Effect.Effect<OpResult | Failure, PlatformError, PlatformServices | Records>,
  ) =>
    what.pipe(
      Effect.map(settled),
      Effect.catch((cause) => Effect.succeed(failed(reason(cause)))),
    );

  const control = (
    env: PluginEnv,
    by: Actor,
    runId: string,
    which: "hold" | "stop",
    set: boolean,
    reason?: string,
    before?: string,
  ) =>
    carry(
      controlRun(env, {
        door: by,
        runId,
        control: which,
        set,
        request: by.requestId,
        reason,
        before,
      }),
    );
  registerExecutor("stop", (action, by, env) => control(env, by, action.run, "stop", true));
  registerExecutor("resume", (action, by, env) =>
    carry(resumeRun(env, { door: by, runId: action.run, request: by.requestId })),
  );
  registerExecutor("answer", (action, by, env) =>
    carry(
      Effect.suspend(() =>
        answerRun(env, {
          door: by,
          runId: action.run,
          // WARNING: an answer lands on the question it was given, not whatever is open now.
          decision: action.choiceId === "" ? null : action.choiceId,
          value: action.answer,
          request: by.requestId,
        }),
      ),
    ),
  );
  registerExecutor("hold", (action, by, env) =>
    control(env, by, action.run, "hold", true, action.reason, action.before),
  );
  registerExecutor("release", (action, by, env) =>
    control(env, by, action.run, "hold", false, undefined, action.before),
  );
  registerExecutor("clear_override", (action, by, env) =>
    carry(
      clearOverride(
        env.stateDir,
        new Herdr(env),
        action.run,
        action.agent,
        actorName(by),
        voiceOf(by),
      ),
    ),
  );
  registerExecutor("deliver", (action, by, env) =>
    carry(
      Effect.suspend(() =>
        steerRun(env, {
          runId: action.run,
          agent: action.agent,
          to: action.to,
          text: action.text,
          request: by.requestId,
          mode: action.mode,
          step: action.step,
          attachments: action.attachments,
          door: by,
        }),
      ),
    ),
  );
  registerExecutor("withdraw_note", (action, by, env) =>
    carry(
      withdrawNoteRun(env, {
        runId: action.run,
        note: action.note,
        request: by.requestId,
        door: by,
      }),
    ),
  );
  registerExecutor("navigate", (action) =>
    Effect.sync(() => {
      const where = Arr.join(
        Arr.filter([action.run, action.agent], (part) => part !== undefined),
        " · ",
      );
      return { state: "applied" as const, note: where };
    }),
  );
  registerExecutor("update_intent", (action, by, env) =>
    Effect.gen(function* () {
      const dir = runDir(env.stateDir, action.run);
      if (action.change === "set-outcome") {
        const changed = yield* changeIntentRun(env, {
          runId: action.run,
          change: outcomeChange(action.patch),
          request: by.requestId,
          door: by,
          expected: action.base_version,
        });
        return changed.ok
          ? { state: "applied" as const, note: `intent v${changed.value.version}` }
          : failed(changed.error.message);
      }
      const amended = yield* updateIntent(dir, (intent) =>
        Effect.gen(function* () {
          if (intent === null) {
            return yield* Effect.fail(`Run "${action.run}" has no Intent to amend`);
          }
          if (intent.version !== action.base_version) {
            return yield* Effect.fail(
              `the Intent is v${intent.version}, not v${action.base_version}`,
            );
          }
          // WARNING: a constraint is semantic: a model's words are not a rule Collie can check by itself.
          return amendIntent(
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
            actorName(by),
            yield* nowIso,
            voiceOf(by),
          );
        }),
      );
      return { state: "applied" as const, note: `intent v${amended?.version}` };
    }).pipe(Effect.catch((cause) => Effect.succeed(failed(String(cause))))),
  );
  registerExecutor("set_verification", (action, by, env) =>
    Effect.gen(function* () {
      const command = action.command ?? null;
      const granted = yield* grantRun(env, {
        runId: action.run,
        name: action.name,
        command,
        request: by.requestId,
        door: by,
      });
      if (!granted.ok) {
        return failed(granted.error.message);
      }
      const dir = runDir(env.stateDir, action.run);
      // WARNING: an Intent that failed to follow the grant is reported as such, not as the grant failing.
      const unlisted = yield* updateIntent(dir, (intent) =>
        intent === null
          ? Effect.succeed(null)
          : Effect.map(nowIso, (now) =>
              amendIntent(
                intent,
                verificationGrant(intent, action.name, command),
                actorName(by),
                now,
                voiceOf(by),
              ),
            ),
      ).pipe(
        Effect.as(""),
        Effect.catch((cause) => Effect.succeed(String(cause))),
      );
      const done = command === null ? `${action.name} withdrawn` : `${action.name} named`;
      return {
        state: "applied" as const,
        note:
          unlisted === ""
            ? done
            : `${done}; the check change stands, but intent show will not reflect it: ${unlisted}`,
      };
    }),
  );
  registerExecutor("remember_verification", (action, _by, env) =>
    Effect.gen(function* () {
      const run = yield* findRun(env, action.run);
      if (run === null) {
        return failed(`no run "${action.run}"`);
      }
      const remembered = yield* rememberChecks(env, {
        runId: action.run,
        checkouts: [run.cwd, run.project],
        replace: action.replace === true,
      });
      return remembered.ok
        ? { state: "applied" as const, note: remembered.human }
        : failed(remembered.error.message);
    }).pipe(Effect.catch((cause) => Effect.succeed(failed(String(cause))))),
  );
  registerExecutor("followup", (action, by, env) =>
    carry(
      followUpRun(env, {
        door: by,
        runId: action.run,
        text: action.text,
        request: by.requestId,
        attachments: action.attachments,
      }),
    ),
  );
  registerExecutor("take_offer", (action, by, env) =>
    carry(
      invokeTypedOffer(env, {
        door: by,
        runId: action.run,
        offer: action.offer,
        input: action.inputs ?? {},
        request: by.requestId,
        attachments: action.attachments,
      }),
    ),
  );
  registerExecutor("start", (action, by, env) =>
    Effect.gen(function* () {
      const asked = action.task === undefined ? null : yield* readTask(action.task);
      if (action.task !== undefined && asked === null) {
        return failed(`no Task "${action.task}"`);
      }
      const named = action.workspace ?? action.inputs.workspace;
      const resolved = yield* startIn(env, named);
      if ("error" in resolved) {
        return failed(resolved.error);
      }
      const { atRoot, repository, where } = resolved;
      if (where !== null && "error" in where) {
        return failed(where.error);
      }
      const own =
        where === null ? null : yield* collieOwnRefusal(env, where.found.label, where.found.cwd);
      if (own !== null) {
        return failed(own);
      }
      const rooted = where === null ? env : { ...env, cwd: where.found.cwd };
      const fields = Rec.toEntries(action.inputs);
      const input = {
        text: Rec.fromEntries(Arr.filter(fields, ([name]) => !(name in RESERVED_INPUTS))),
        json: {},
      };
      const launch = Rec.fromEntries(Arr.filter(fields, ([name]) => name in RESERVED_INPUTS));
      if (atRoot) {
        launch.workspace = PROJECTS_ROOT_OPTION;
      } else if (repository !== null && named !== undefined) {
        launch.workspace = named;
      }
      const saved = yield* moduleFor(rooted, action.workflow);
      if (saved !== null && "inputs" in saved) {
        const refused = yield* agentStartRefusal(rooted, saved, input, {
          named: atRoot ? (yield* projectsRoot(env)).path : (where?.found.cwd ?? null),
          fix: CHAT_CHECKOUT_FIX,
        });
        if (refused !== null) {
          return failed(refused.error.message);
        }
      }
      const started = yield* startRun(rooted, {
        door: by,
        id: action.workflow,
        request: by.requestId,
        input,
        options: launch,
        task: asked === null ? { mode: "new" } : { mode: "continue", task: asked },
        title: action.title,
        verify: action.verify,
        attachments: action.attachments,
      });
      return started.ok
        ? {
            state: "applied" as const,
            note: withNotice(
              started.followed === undefined
                ? `started ${started.runId}`
                : `${started.runId} already follows ${started.followed}`,
              started.redacted,
              "; ",
            ),
          }
        : failed(started.error.message);
    }).pipe(Effect.catch((cause) => Effect.succeed(failed(String(cause))))),
  );
  registerExecutor("create_task", (action, by, env) =>
    Effect.gen(function* () {
      const instruction = Str.trim(action.instruction);
      if (instruction === "") {
        return failed("create_task needs an instruction");
      }
      const installation = yield* hostInstallation(env.stateDir);
      const asked = {
        instruction,
        label: action.label ?? null,
        cwd: env.cwd,
        project: action.project ?? null,
      };
      const made = yield* once(
        env.stateDir,
        {
          operation: "create_task",
          request: by.requestId,
          ...by,
          asked,
          result: Schema.Union([
            Schema.Struct({ task: Schema.String }),
            Schema.Struct({ refused: Schema.String }),
          ]),
          // WARNING: a refusal is no answer, so the same request is asked again once the Project is back.
          settles: (made) => !("refused" in made),
        },
        Effect.gen(function* () {
          // WARNING: a Project is read only where a Task is new, so a request answered once answers the same after an archive.
          const project = action.project === undefined ? null : yield* readProject(action.project);
          if (action.project !== undefined && (project === null || isArchived(project))) {
            return { refused: `no Project ${action.project} here, or it is archived` };
          }
          const task = yield* newQueuedTask({ instruction, label: action.label, cwd: env.cwd });
          const filed =
            project === null
              ? task
              : { ...task, project: { installation: installation ?? "", id: project.id } };
          const written = yield* writeTask(filed);
          return { task: written.id };
        }),
      );
      if ("refused" in made) {
        return failed(made.refused);
      }
      return { state: "applied" as const, note: made.task, task: made.task };
    }).pipe(Effect.catch((cause) => Effect.succeed(failed(reason(cause))))),
  );
  registerExecutor("project_create", (action, by, env) =>
    Effect.gen(function* () {
      const name = Str.trim(action.name);
      if (name === "") {
        return failed("project_create needs a name");
      }
      const made = yield* once(
        env.stateDir,
        {
          operation: "project_create",
          request: by.requestId,
          ...by,
          asked: { name },
          result: Schema.Struct({ project: Schema.String }),
        },
        Effect.gen(function* () {
          const written = yield* writeProject(yield* newProject({ name }));
          return { project: written.id };
        }),
      );
      return {
        state: "applied" as const,
        note: `${made.project} "${name}"`,
        project: made.project,
      };
    }).pipe(Effect.catch((cause) => Effect.succeed(failed(reason(cause))))),
  );
  // WARNING: an absent key, not a present undefined: a Project's JSON refuses undefined where a time is optional.
  const projectTimes = (
    project: { readonly id: string; readonly name: string; readonly created_at: string },
    times: { readonly starred_at?: string | undefined; readonly archived_at?: string | undefined },
  ) => {
    const { id, name, created_at } = project;
    if (times.starred_at !== undefined && times.archived_at !== undefined) {
      const both: ProjectRecord = {
        id,
        name,
        created_at,
        starred_at: times.starred_at,
        archived_at: times.archived_at,
      };
      return both;
    }
    if (times.starred_at !== undefined) {
      const starred: ProjectRecord = { id, name, created_at, starred_at: times.starred_at };
      return starred;
    }
    if (times.archived_at !== undefined) {
      const archived: ProjectRecord = { id, name, created_at, archived_at: times.archived_at };
      return archived;
    }
    const bare: ProjectRecord = { id, name, created_at };
    return bare;
  };
  const projectChange = (
    kind: "project_star" | "project_unstar" | "project_archive" | "project_restore",
  ) =>
    registerExecutor(kind, (action) =>
      Effect.gen(function* () {
        const done = yield* withProjectLock(
          action.project,
          Effect.gen(function* () {
            const project = yield* readProject(action.project);
            if (project === null) {
              return null;
            }
            if (kind === "project_star") {
              return yield* writeProject({
                ...project,
                starred_at: project.starred_at ?? (yield* nowIso),
              });
            }
            if (kind === "project_unstar") {
              return yield* writeProject(
                projectTimes(project, { archived_at: project.archived_at }),
              );
            }
            if (kind === "project_archive") {
              return yield* writeProject({
                ...project,
                archived_at: project.archived_at ?? (yield* nowIso),
              });
            }
            return yield* writeProject(projectTimes(project, { starred_at: project.starred_at }));
          }),
        );
        if (done === null) {
          return failed(`no Project ${action.project} here`);
        }
        const said = {
          project_star: "starred",
          project_unstar: "unstarred",
          project_archive: "archived",
          project_restore: "restored",
        }[kind];
        return { state: "applied" as const, note: `${done.name} ${said}`, project: done.id };
      }),
    );
  projectChange("project_star");
  projectChange("project_unstar");
  projectChange("project_archive");
  projectChange("project_restore");
  // WARNING: a destination belongs to the Machine that made it, so its existence is asked there.
  const projectAt = (env: PluginEnv, ref: ProjectRef) =>
    Effect.gen(function* () {
      const here = yield* hostInstallation(env.stateDir);
      if (ref.installation === here) {
        const project = yield* readProject(ref.id);
        return project === null ? null : { installation: here, project };
      }
      const peer = Option.getOrUndefined(
        Arr.findFirst(yield* peersOf(env.stateDir), (one) => one.installation === ref.installation),
      );
      if (peer === undefined) {
        return "unavailable" as const;
      }
      return yield* Effect.scoped(
        connectPeer(env.stateDir, peer.name, {
          as: "host",
          client: machineName(),
          stamp: env.hostStamp,
        }).pipe(
          Effect.flatMap((client) => client.projects()),
          Effect.map((projects) => {
            const found = Arr.findFirst(projects, (one) => one.id === ref.id);
            return Option.isNone(found)
              ? null
              : { installation: ref.installation, project: found.value };
          }),
          Effect.orElseSucceed(() => "unavailable" as const),
        ),
      );
    });
  // WARNING: a request answered once answers the same again, so a retry after a move nobody saw cannot move it back.
  registerExecutor("task_file", (action, by, env) =>
    Effect.gen(function* () {
      if (action.filings.length === 0) {
        return failed("task_file needs at least one Task");
      }
      const installation = yield* hostInstallation(env.stateDir);
      const fileAll = (settled: ReadonlyArray<Filing>) =>
        Effect.gen(function* () {
          const filed: Array<Filing> = [];
          for (const [at, entry] of action.filings.entries()) {
            // WARNING: an answer is kept by its entry's place in the batch, since one Task may be filed twice.
            const done = settled[at];
            if (done !== undefined && done.result !== "unavailable") {
              filed.push(done);
              continue;
            }
            const missing = {
              task: entry.task,
              result: "missing" as const,
              membership: { project: null, seq: 0 },
            };
            if (entry.installation !== undefined && entry.installation !== installation) {
              filed.push(missing);
              continue;
            }
            const where = entry.project === undefined ? null : yield* projectAt(env, entry.project);
            if (where === "unavailable") {
              filed.push({ ...missing, result: "unavailable" });
              continue;
            }
            if (entry.project !== undefined && where === null) {
              filed.push(missing);
              continue;
            }
            if (where !== null && isArchived(where.project)) {
              filed.push({ ...missing, result: "archived" });
              continue;
            }
            filed.push(
              yield* fileTask({
                id: entry.task,
                project:
                  where === null
                    ? null
                    : { installation: where.installation, id: where.project.id },
                expected: entry.expected,
              }),
            );
          }
          return { filed };
        });
      const landed = yield* once(
        env.stateDir,
        {
          operation: "task_file",
          request: by.requestId,
          ...by,
          asked: action,
          result: Schema.Struct({ filed: Schema.Array(FilingSchema) }),
          settles: (answer) => !Arr.some(answer.filed, (one) => one.result === "unavailable"),
          more: (kept) => fileAll(kept.filed),
        },
        fileAll([]),
      ).pipe(Effect.catchTag("RequestConflict", (conflict) => Effect.die(conflict.reason)));
      const said = Arr.join(
        Arr.flatMap(
          ["filed", "already", "stale", "archived", "missing", "unavailable"] as const,
          (result) => {
            const count = Arr.filter(landed.filed, (one) => one.result === result).length;
            return count === 0 ? [] : [`${count} ${result}`];
          },
        ),
        ", ",
      );
      const any = Arr.some(
        landed.filed,
        (one) => one.result === "filed" || one.result === "already",
      );
      return {
        state: any ? ("applied" as const) : ("failed" as const),
        note: said,
        filed: landed.filed,
      };
    }),
  );
  const followChange = (kind: "task_follow" | "task_unfollow") =>
    registerExecutor(kind, (action, by) =>
      Effect.gen(function* () {
        const done =
          kind === "task_follow"
            ? yield* followTask(action.task, actorName(by))
            : yield* unfollowTask(action.task);
        if (done === null) {
          return failed(`no Task ${action.task} here`);
        }
        return {
          state: "applied" as const,
          note: `${done.label} ${kind === "task_follow" ? "followed" : "unfollowed"}`,
          task: done.id,
        };
      }),
    );
  followChange("task_follow");
  followChange("task_unfollow");
  const taskMissing = (task: string) => `no Task ${task} on this Machine`;
  // WARNING: an amendment reaches agents already at work only at their next boundary; none is interrupted.
  const tellWorkingAgents = (env: PluginEnv, by: Actor, task: string, revision: number) =>
    Effect.gen(function* () {
      const listed = yield* listRuns(env).pipe(Effect.orElseSucceed(() => [] as const));
      for (const run of listed) {
        if (run.task !== task || run.state !== "running") {
          continue;
        }
        yield* steerRun(env, {
          runId: run.id,
          text: `The Task's plan is now revision ${revision}. Re-read it before your next decision; what you were admitted with still stands.`,
          mode: "boundary",
          request: `${by.requestId}:${run.id}`,
          door: by,
        }).pipe(Effect.orElseSucceed(() => null));
      }
    });
  registerExecutor("task_adopt_plan", (action, by, env) =>
    Effect.gen(function* () {
      const task = yield* readTask(action.task);
      if (task === null) {
        return failed(taskMissing(action.task));
      }
      const plan = `${runDir(env.stateDir, action.run)}/plan`;
      const made = yield* once(
        env.stateDir,
        {
          operation: "task_adopt_plan",
          request: by.requestId,
          ...by,
          asked: { task: action.task, run: action.run, plan, rationale: action.rationale ?? null },
          result: Schema.Struct({ revision: Schema.Finite }),
          settles: (made_) => made_.revision > 0,
        },
        adoptPlan({
          task: action.task,
          run: action.run,
          machine: env.machine ?? null,
          plan,
          actor: actorName(by),
          rationale: action.rationale ?? null,
        }).pipe(
          Effect.flatMap((adopted) =>
            "refused" in adopted
              ? Effect.succeed({ revision: 0, refused: adopted.refused })
              : Effect.as(
                  appendEvent({
                    task: action.task,
                    id: `adopted:${action.task}:${adopted.revision}`,
                    kind: "adopted",
                    text: `Plan adopted from ${action.run}, revision ${adopted.revision}`,
                    source: { kind: "plan", run: action.run, revision: adopted.revision },
                  }).pipe(Effect.orElseSucceed(() => null)),
                  { revision: adopted.revision },
                ),
          ),
        ),
      );
      return made.revision === 0
        ? failed(`no plan to adopt from ${action.run}`)
        : { state: "applied" as const, note: `plan revision ${made.revision}`, task: action.task };
    }).pipe(Effect.catch((cause) => Effect.succeed(failed(reason(cause))))),
  );
  registerExecutor("task_edit_spec", (action, by, env) =>
    Effect.gen(function* () {
      const task = yield* readTask(action.task);
      if (task === null) {
        return failed(taskMissing(action.task));
      }
      const made = yield* once(
        env.stateDir,
        {
          operation: "task_edit_spec",
          request: by.requestId,
          ...by,
          asked: {
            task: action.task,
            text: action.text,
            rationale: action.rationale ?? null,
            base: action.base_revision,
          },
          result: Schema.Struct({
            applied: Schema.Boolean,
            revision: Schema.Finite,
            current: Schema.Finite,
          }),
          settles: (made_) => made_.applied,
        },
        Effect.gen(function* () {
          const edited = yield* editSpec({
            task: action.task,
            text: action.text,
            actor: actorName(by),
            expected: action.base_revision,
            rationale: action.rationale ?? null,
          });
          if (!edited.applied) {
            return { applied: false, revision: 0, current: edited.current.revision };
          }
          yield* appendEvent({
            task: action.task,
            id: `amended:${action.task}:${edited.current.revision}`,
            kind: "amended",
            text:
              action.rationale === undefined
                ? `Plan revision ${edited.current.revision}`
                : `Plan revision ${edited.current.revision}: ${action.rationale}`,
            source: { kind: "spec", revision: edited.current.revision },
          }).pipe(Effect.orElseSucceed(() => null));
          yield* tellWorkingAgents(env, by, action.task, edited.current.revision);
          return {
            applied: true,
            revision: edited.current.revision,
            current: edited.current.revision,
          };
        }),
      );
      return made.applied
        ? { state: "applied" as const, note: `plan revision ${made.revision}`, task: action.task }
        : failed(
            `the plan is at revision ${made.current}, not ${action.base_revision}; your draft is kept for reconciliation`,
          );
    }).pipe(Effect.catch((cause) => Effect.succeed(failed(reason(cause))))),
  );
  const said = (kind: "task_post" | "task_decision") =>
    registerExecutor(kind, (action, by, env) =>
      Effect.gen(function* () {
        const task = yield* readTask(action.task);
        if (task === null) {
          return failed(taskMissing(action.task));
        }
        const made = yield* once(
          env.stateDir,
          {
            operation: kind,
            request: by.requestId,
            ...by,
            asked: { task: action.task, text: action.text },
            result: Schema.Struct({ id: Schema.String }),
          },
          Effect.map(
            postTo({
              task: action.task,
              by: actorName(by),
              kind: kind === "task_post" ? "comment" : "decision",
              text: action.text,
            }),
            (posted) => ({ id: posted.id }),
          ),
        );
        return { state: "applied" as const, note: made.id, task: action.task };
      }).pipe(Effect.catch((cause) => Effect.succeed(failed(reason(cause))))),
    );
  said("task_post");
  said("task_decision");
  registerExecutor("task_challenge", (action, by, env) =>
    Effect.gen(function* () {
      const made = yield* once(
        env.stateDir,
        {
          operation: "task_challenge",
          request: by.requestId,
          ...by,
          asked: { task: action.task, decision: action.decision, text: action.text },
          result: Schema.Struct({ id: Schema.String }),
        },
        Effect.map(
          postTo({
            task: action.task,
            by: actorName(by),
            kind: "challenge",
            text: action.text,
            source: { kind: "agent", agent: actorName(by) },
            about: [action.decision],
          }),
          (posted) => ({ id: posted.id }),
        ),
      );
      return { state: "applied" as const, note: made.id, task: action.task };
    }).pipe(Effect.catch((cause) => Effect.succeed(failed(reason(cause))))),
  );
  registerExecutor("task_resolve", (action, by, env) =>
    Effect.gen(function* () {
      const made = yield* once(
        env.stateDir,
        {
          operation: "task_resolve",
          request: by.requestId,
          ...by,
          asked: {
            task: action.task,
            decision: action.decision,
            challenge: action.challenge,
            text: action.text,
          },
          result: Schema.Struct({ id: Schema.String }),
        },
        Effect.map(
          resolvePost({
            task: action.task,
            by: actorName(by),
            decision: action.decision,
            challenge: action.challenge,
            text: action.text,
          }),
          (posted) => ({ id: posted.id }),
        ),
      );
      return { state: "applied" as const, note: made.id, task: action.task };
    }).pipe(Effect.catch((cause) => Effect.succeed(failed(reason(cause))))),
  );
  registerExecutor("update_defaults", (action, _by, env) =>
    Effect.gen(function* () {
      // WARNING: the named workspace's scope, never this process's: a Run reads its defaults where it was started.
      const where = yield* workspaceNamed(env, action.workspace);
      if (where === null) {
        return failed("update_defaults has to name a workspace");
      }
      if ("error" in where) {
        return failed(where.error);
      }
      const scope = scopeFor(where.found.cwd);
      const file = yield* defaultsPath(env.stateDir, scopeKey(scope));
      const current = (yield* readDefaults(file)) ?? EMPTY_DEFAULTS;
      if (action.change === "remove-constraint") {
        // WARNING: ids are hashes of the text, so a prose name matches none and is refused, not reported as applied.
        if (!Arr.some(current.constraints, (c) => c.id === action.text)) {
          return failed(
            `no default constraint "${action.text}" in ${where.found.label}; remove one by the id \`collie_installation\` lists`,
          );
        }
        const next = {
          ...current,
          constraints: Arr.filter(current.constraints, (c) => c.id !== action.text),
        };
        yield* writeDefaults(file, next);
        return { state: "applied" as const, note: describeDefaults(next) };
      }
      const parsed = parseConstraint(action.text, "warn");
      if ("error" in parsed) {
        return failed(parsed.error);
      }
      const constraint = { ...parsed, source: "workspace-default" as const, since: 1 };
      const next = {
        ...current,
        constraints: [
          ...Arr.filter(current.constraints, (c) => c.id !== constraint.id),
          constraint,
        ],
      };
      yield* writeDefaults(file, next);
      return { state: "applied" as const, note: describeDefaults(next) };
    }).pipe(Effect.catch((cause) => Effect.succeed(failed(String(cause))))),
  );
  registerExecutor("fork_definition", (action, _by, env) =>
    Effect.gen(function* () {
      if (action.what !== "persona") {
        return failed("a workflow is forked with `collie workflow fork`, which writes a module");
      }
      const layer = action.layer ?? "user";
      const available = yield* layers(env);
      const found = (yield* loadDefinitions(available)).personas.get(action.name);
      if (!found) {
        return failed(`No persona "${action.name}".`);
      }
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
  const onThisMachine = <R>(
    machine: string | undefined,
    instead: string,
    act: Effect.Effect<ExecutionResult, never, R>,
  ) =>
    machine !== undefined && machine !== hostname()
      ? Effect.succeed(failed(`Native chat acts on ${hostname()}; ${instead}`))
      : act;
  const elsewhereCleanup = "ask Desktop's Flock chat to clean up another Machine";
  registerExecutor("home_cleanup", (action, _by, env) =>
    onThisMachine(
      action.machine,
      elsewhereCleanup,
      Effect.gen(function* () {
        // WARNING: an unreadable listing keeps every Task, since it cannot prove any is unreachable.
        const listing = yield* runViews(env, null);
        const owned = new Set(Arr.map(listing.runs, (run) => run.task));
        const gone =
          listing.unreadable === null
            ? Arr.filter(yield* listTasks, (task) => !isOpen(task) && !owned.has(task.id))
            : [];
        for (const task of gone) {
          yield* removeTask(task.id);
        }
        return {
          state: "applied" as const,
          note: `forgot ${gone.length} closed Tasks`,
        };
      }),
    ),
  );
  const scheduleChange = (env: PluginEnv, by: Actor, change: ScheduleChange, machine?: string) =>
    onThisMachine(
      machine,
      `use collie schedule --machine ${machine} for another Machine`,
      changeSchedule(env, { door: by, change, request: by.requestId }).pipe(
        Effect.map((done) =>
          done.ok
            ? {
                state: "applied",
                note: `Schedule ${done.value.name} on ${done.value.machine.hostname} (${done.value.machine.installation}): ${done.value.change}`,
              }
            : failed(done.error.message),
        ),
      ),
    );
  registerExecutor("schedule_add", (action, by, env) =>
    Effect.gen(function* () {
      const named = action.start.workspace ?? "";
      let workspace = named;
      if (named !== "" && named !== PROJECTS_ROOT_OPTION && !pipe_(named, Str.startsWith("/"))) {
        const repository = yield* repositoryCheckout(env, named);
        if (repository !== null && "error" in repository) {
          return failed(repository.error);
        }
        if (repository !== null) {
          workspace = repository.path;
        } else {
          const where = yield* workspaceNamed(env, named);
          if (where !== null && "error" in where) {
            return failed(where.error);
          }
          workspace = where?.found.cwd ?? "";
        }
      }
      return yield* scheduleChange(
        env,
        by,
        {
          change: "add",
          name: action.name,
          cron: action.cron,
          tz: action.tz,
          paused: false,
          start: { ...action.start, workspace, verify: action.start.verify ?? [] },
        },
        action.machine,
      );
    }).pipe(Effect.catch((cause) => Effect.succeed(failed(reason(cause))))),
  );
  for (const [kind, change] of [
    ["schedule_pause", "pause"],
    ["schedule_resume", "resume"],
    ["schedule_remove", "remove"],
  ] as const) {
    registerExecutor(kind, (action, by, env) =>
      scheduleChange(env, by, { change, name: action.name }, action.machine),
    );
  }
  registerExecutor("cleanup", (action, by, env) =>
    onThisMachine(
      action.machine,
      elsewhereCleanup,
      sweepNow(env, { door: by, request: by.requestId }).pipe(
        Effect.map((swept) =>
          swept.ok
            ? {
                state: "applied" as const,
                note: `removed ${swept.value.remove.length} item(s), freeing ${humanBytes(swept.value.bytes)}; kept ${swept.value.keep.length}`,
              }
            : failed(swept.error.message),
        ),
      ),
    ),
  );
  registerExecutor("upgrade", (_action, _by, env) =>
    upgrade(env).pipe(
      Effect.map(settled),
      Effect.catch((cause) => Effect.succeed(failed(String(cause)))),
    ),
  );
  // WARNING: unattended: nobody sees a login URL from here, so a login is left as a step to do.
  registerExecutor("onboard", (action, _by, env) =>
    onboard(
      env,
      {
        to: manifest.version,
        skip: action.skip ?? [],
        attended: false,
      },
      () => Effect.void,
    ).pipe(
      Effect.map(settled),
      Effect.catch((cause) => Effect.succeed(failed(reason(cause)))),
    ),
  );
  yield* Effect.void;
});

export const carryOut = Effect.fn("runActions.carryOut")(function* (
  env: PluginEnv,
  proposalId: string,
  hash: string | undefined,
  actor: Actor,
  ownRequest = false,
) {
  // WARNING: without registration every action is refused as executor_missing, which would misstate this build.
  yield* registerRunExecutors();
  const file = yield* journalOf(proposalId);
  if (file === null) {
    return yield* new ProposalRefused({
      refused: "not_found",
      detail: `no proposal "${proposalId}"`,
    });
  }
  const proposal = Option.getOrUndefined(
    Arr.findFirst(
      yield* readProposals(file),
      (line): line is ProposalRecord => line.kind === "proposal" && line.id === proposalId,
    ),
  );
  const versions = new Map<string, number>();
  for (const target of proposal?.targets ?? []) {
    const intent = yield* readIntent(runDir(env.stateDir, target.run)).pipe(
      Effect.orElseSucceed(() => null),
    );
    if (intent !== null) {
      versions.set(target.run, intent.version);
    }
  }

  const judged = yield* confirmProposal(
    file,
    proposalId,
    hash ?? proposal?.content_hash ?? "",
    actor,
    versions,
  );
  if ("refused" in judged) {
    return yield* new ProposalRefused({ refused: judged.refused, detail: judged.detail });
  }

  const results: Array<StepResult> = [];
  const expectedVersions = { ...judged.proposal.intent_versions };
  // WARNING: a later action on a failed Run was asked assuming the failure did not happen; the others are independent.
  const failedRuns = new Set<string>();
  const settle = Effect.fnUntraced(function* (
    index: number,
    state: "applied" | "failed" | "skipped" | "unknown",
    note: string | undefined,
  ) {
    yield* stepSettled(file, proposalId, index, state, note);
    const action = judged.actions[index]!;
    results.push({
      index,
      kind: action.kind,
      state,
      note: note ?? "",
      run: "run" in action ? action.run : null,
    });
  });
  for (const [index, proposed] of judged.actions.entries()) {
    if ("run" in proposed && failedRuns.has(proposed.run)) {
      yield* settle(index, "skipped", "after_failure");
      continue;
    }
    const action =
      proposed.kind === "update_intent" &&
      proposed.base_version === judged.proposal.intent_versions[proposed.run]
        ? { ...proposed, base_version: expectedVersions[proposed.run] ?? proposed.base_version }
        : proposed;
    if (action.kind === "none" || action.kind === "ask_human") {
      const state = action.kind === "none" ? "applied" : "failed";
      const note = action.kind === "none" ? action.why : action.question;
      yield* settle(index, state, note);
      if (action.kind === "ask_human") {
        break;
      }
      continue;
    }
    const executor = executorFor(action.kind);
    if (!executor) {
      yield* settle(index, "skipped", "executor_missing");
      break;
    }
    const refusal = yield* admissionFor(env, action, {
      ...judged.proposal,
      intent_versions: expectedVersions,
    });
    if (refusal !== null) {
      yield* settle(index, "skipped", refusal);
      break;
    }
    yield* stepStarted(file, proposalId, index);
    const outcome = yield* executor(
      action,
      stepOf(actor, ownRequest ? index : `${proposalId}:${index}`),
      env,
    );
    yield* settle(index, outcome.state, outcome.note);
    if (outcome.state === "failed" && "run" in action) {
      failedRuns.add(action.run);
    }
    if (outcome.state !== "failed" && action.kind === "update_intent") {
      expectedVersions[action.run] = action.base_version + 1;
    }
  }
  return { proposal: proposalId, results } satisfies ProposalCarried;
  // WARNING: a hung-up client must not cut steps off from their record.
}, Effect.uninterruptible);

export const carryOutProposal = (
  env: PluginEnv,
  proposalId: string,
  hash: string | undefined,
  actor: Actor,
  ownRequest = false,
) =>
  carryOut(env, proposalId, hash, actor, ownRequest).pipe(
    Effect.map(carriedResult),
    Effect.catchTag("ProposalRefused", (refused) =>
      Effect.succeed(err("invalid_input", refused.detail, { reason: refused.refused })),
    ),
  );

export const carriedBefore = Effect.fn("runActions.carriedBefore")(function* (
  file: string,
  request: string,
) {
  const lines = yield* readProposals(file);
  const prior = answeredBy(lines, request);
  return prior?.kind === "confirmed"
    ? carriedResult({ proposal: prior.id, results: stepResults(lines, prior.id) })
    : null;
});

const stepOf = (actor: Actor, step: string | number) => ({
  ...actor,
  requestId: `${actor.requestId}:${step}`,
});

// WARNING: carried out without a proposal, because the human already asked for it.
export const carryOutAsked = Effect.fn("runActions.carryOutAsked")(function* (
  env: PluginEnv,
  actions: ReadonlyArray<Action>,
  actor: Actor,
) {
  yield* registerRunExecutors();
  const results: Array<{
    kind: string;
    state: string;
    note: string;
    task?: string;
    project?: string;
    filed?: ReadonlyArray<Filing>;
  }> = [];
  for (const [index, action] of actions.entries()) {
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
    const outcome = yield* executor(action, stepOf(actor, index), env);
    results.push({ kind: action.kind, ...outcome, note: outcome.note ?? "" });
    if (outcome.state === "failed") {
      break;
    }
  }
  return results;
});

const admissionFor = Effect.fn("runActions.admissionFor")(function* (
  env: PluginEnv,
  action: Parameters<typeof admit>[0],
  proposal: ProposalRecord | null,
) {
  const id = "run" in action ? action.run : null;
  const run = id === null ? null : yield* findRun(env, id);
  if (run === null) {
    return admit(action, emptyAdmission());
  }
  const live = yield* new Herdr(env).agentList().pipe(Effect.orElseSucceed(() => []));
  const agent = "agent" in action ? (action.agent ?? null) : null;
  // WARNING: refused rather than read as no version, or a corrupt file would pass as having none to disagree with.
  const intent = yield* readIntent(run.dir).pipe(Effect.orElseSucceed(() => "unreadable" as const));
  if (intent === "unreadable") {
    return `${run.id}'s Intent cannot be read`;
  }
  const bound = proposal?.card;
  const here = bound === undefined ? null : yield* fingerprint(run.cwd);
  const now = here === null ? null : `${here.head_sha}:${here.fingerprint}`;
  return admit(action, {
    run: { id: run.id, status: run.state },
    pendingChoice: run.asking[0]?.name ?? null,
    incarnation:
      agent === null
        ? null
        : (Option.getOrUndefined(Arr.findFirst(live, (a) => a.name === agent))?.terminalId ?? null),
    proposedIncarnation: agent === null ? null : (proposal?.incarnations?.[agent] ?? null),
    intentVersion: intent?.version ?? null,
    proposedIntentVersion: proposal?.intent_versions[run.id] ?? null,
    revision: bound === undefined || now === null ? null : { card: bound.revision, now },
  });
});

function emptyAdmission() {
  return {
    run: null,
    pendingChoice: null,
    incarnation: null,
    proposedIncarnation: null,
    intentVersion: null,
    proposedIntentVersion: null,
    revision: null,
  };
}

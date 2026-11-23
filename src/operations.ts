import * as Cause from "effect/Cause";

import * as Struct from "effect/Struct";
import { parkLine } from "./park-cause";
import * as Arr from "effect/Array";
import * as Option from "effect/Option";
import * as Str from "effect/String";
import { pipe } from "effect/Function";
import * as Rec from "effect/Record";
import type { PlatformServices } from "./platform";
import { repositoryCheckout } from "./projects";
import { Data, Effect, FileSystem, Path, Schema, flow, Result } from "effect";
import * as SecureRandom from "effect/crypto/SecureRandom";
import type { ChildProcessSpawner } from "effect/process";
import { nowIso } from "./time";
import { attentionFor } from "./attention";
import type { PluginEnv } from "./env";
import { Answered, mrLabel, mrNounOf, ranOn, solutionTitle, type FrontDoor } from "./board-model";
import { agentOfLaunch, type Launched } from "./launches";
import { hostLaunches } from "./lifecycle";
import { readAudit, type AuditLine } from "./audit";
import { readForge, readMrStates } from "./merges";
import { findingsIn } from "./output";
import { latest, readDispositions } from "./disposition";
import { PLAN_DIR } from "./run-detail";
import { tailed } from "./views";
import { Herdr, type AgentInfo } from "./herdr";
import { carriedBefore, carryOutProposal } from "./run-actions";
export { carryOutProposal, registerRunExecutors } from "./run-actions";
import { mrIdIn, shell, whatItSaid, type Runner } from "./mr";
import { ensureLockDir, withLock } from "./lock";
import { checkoutsUnder, projectsRoot } from "./projects";
import { newestRelease, ownPlatform, releasesOf, verifiedRunner } from "./releases";
import {
  atCollieDir,
  isCheckout,
  carriedRelease,
  releaseVersion,
  placeRelease,
  RELEASE_TAG,
  type Carried,
} from "./release";
import { BUNDLED_HC, placeHc } from "./hc-install";
import hcPin from "../hc-pin.json";
import manifest from "../package.json";
import { everyRegistered, type AgentEntry } from "./registry";
import { listRuns, liveCheckouts, type Asked, type RunFacts } from "./runs";
import type { TaskChoice, TaskRecord } from "./task";
import { freshTaskLabel, type StartAbout } from "./tasknames";
import { readIntent, type Authority } from "./intent";
import {
  appendLine,
  budgetPath,
  overrideActive,
  readLedger,
  reserve,
  settle as settleBudget,
} from "./steering";
import { append, conversationPath, tail, type NewTurn } from "./conversation";
import {
  evaluate,
  validate,
  type CallLimits as EvaluatorLimits,
  type EvaluatorDeps,
  type Validated,
} from "./evaluator";
import { ActionSchema, type Action } from "./actions";
import {
  actorName,
  record as recordProposal,
  type Recorded,
  type Actor,
  type Voice,
} from "./proposals";
import { openReports, readDrift } from "./drift";
import { readCards } from "./cards";
import { describeAction } from "./lines";
import { MAX_DELIVERY_BYTES } from "./dispatcher";
import { YamlMapSchema, type YamlMap } from "./yaml";

const ErrorCode = Schema.Literals([
  "workspace_required",
  "workspace_not_found",
  "task_not_found",
  "workflow_not_found",
  "persona_not_found",
  "run_not_found",
  "run_outside_task",
  "run_already_active",
  "run_not_waiting",
  "invalid_answer",
  "choice_already_answered",
  "choice_mismatch",
  "target_exists",
  "needs_input",
  "timeout",
  "machine_unreachable",
  "invalid_state",
  "definition_changed",
  "operation_failed",
  "invalid_input",
  "stale_cursor",
]);

export const ExpectedError = Schema.Struct({
  code: ErrorCode,
  message: Schema.String,
  details: YamlMapSchema,
});
export interface ExpectedError extends Schema.Schema.Type<typeof ExpectedError> {}

export type Failure = {
  ok: false;
  error: ExpectedError;
  readonly unreached?: true;
};

// WARNING: a host that could not be asked is not the same as having nothing.
export class HostUnread extends Data.TaggedError("HostUnread")<{
  readonly error: ExpectedError;
  readonly message: string;
}> {}
export type OpResult =
  | {
      ok: true;
      data: object;
      human: string;
    }
  | Failure;

export const err: (code: ExpectedError["code"], message: string, details?: YamlMap) => Failure = (
  code,
  message,
  details = {},
) => ({ ok: false, error: ExpectedError.make({ code, message, details }) });

const ok: <A extends object>(data: A, human: string) => OpResult = <A extends object>(
  data: A,
  human: string,
) => ({
  ok: true,
  data,
  human,
});

// WARNING: reusing a request id replays the mutation rather than repeating it.
export const newRequestId = Effect.fn("operations.newRequestId")(function* () {
  return yield* (yield* SecureRandom.SecureRandom).uuidV4();
});

// WARNING: ambiguity is an error, never a guess: a launch aimed at a guess runs in a repository nobody asked for.
export const workspaceNamed: (
  env: PluginEnv,
  named: string | undefined,
) => Effect.Effect<WorkspaceNamed, never, PlatformServices> = Effect.fn(
  "operations.workspaceNamed",
)(function* (env: PluginEnv, named: string | undefined) {
  if (named === undefined || Str.trim(named) === "") return null;
  const wanted = Str.trim(named);
  const refused: (error: string) => WorkspaceNamed = (error) => ({ error });
  const opened = yield* workspaceForDirectory(env, wanted);
  if (opened !== null) return opened;
  const repository = yield* repositoryCheckout(env, wanted).pipe(Effect.orElseSucceed(() => null));
  if (repository !== null) {
    if ("error" in repository) return refused(repository.error);
    return yield* workspaceForDirectory(env, repository.path);
  }
  if (pipe(wanted, Str.includes("/")))
    return refused(`no directory "${named}" on this Machine; ${yield* howToName(env)}`);
  const checkouts = yield* checkoutsNamed(env, wanted);
  if (checkouts.paths.length === 1) return yield* workspaceForDirectory(env, checkouts.paths[0]!);
  if (checkouts.paths.length > 1)
    return refused(
      `"${named}" names ${checkouts.paths.length} checkouts under ${checkouts.root} (${Arr.join(checkouts.paths, ", ")}); say which`,
    );
  const root = yield* projectsRoot(env).pipe(Effect.orElseSucceed(() => null));
  return refused(
    `no directory${root === null ? "" : ` or checkout under the Projects root ${root.path}`} is named "${named}"`,
  );
});

export const inCollieState = Effect.fn("operations.inCollieState")(function* (
  env: PluginEnv,
  cwd: string,
) {
  const path = yield* Path.Path;
  const state = path.resolve(env.stateDir);
  const dir = path.resolve(cwd);
  return dir === state || pipe(dir, Str.startsWith(`${state}${path.sep}`));
});

export const collieOwnRefusal = Effect.fn("operations.collieOwnRefusal")(function* (
  env: PluginEnv,
  named: string,
  cwd: string,
) {
  if (!(yield* inCollieState(env, cwd))) return null;
  return `"${named}" is ${cwd}, Collie's own namespace, not a checkout; ${yield* howToName(env)}, or projects-root`;
});

const howToName = Effect.fn("operations.howToName")(function* (env: PluginEnv) {
  const root = yield* projectsRoot(env).pipe(Effect.orElseSucceed(() => null));
  return `name a checkout by its workspace, its path on this Machine${root === null ? "" : ` or its directory name under the Projects root ${root.path}`}`;
});

const checkoutsNamed = Effect.fn("operations.checkoutsNamed")(function* (
  env: PluginEnv,
  name: string,
) {
  const path = yield* Path.Path;
  const root = yield* projectsRoot(env).pipe(Effect.orElseSucceed(() => null));
  if (root === null || pipe(name, Str.includes("/"))) return { root: "", paths: [] };
  const all = yield* checkoutsUnder(root.path).pipe(Effect.orElseSucceed(() => []));
  const paths = Arr.filter(
    all,
    (dir) => Str.toLowerCase(path.basename(dir)) === Str.toLowerCase(name),
  );
  return { root: root.path, paths };
});

const workspaceForDirectory: (
  env: PluginEnv,
  named: string,
) => Effect.Effect<WorkspaceNamed, never, PlatformServices> = Effect.fn(
  "operations.workspaceForDirectory",
)(function* (env: PluginEnv, named: string) {
  const path = yield* Path.Path;
  const fs = yield* FileSystem.FileSystem;
  const expanded = pipe(named, Str.startsWith("~/"))
    ? path.join(env.home, pipe(named, Str.slice(2)))
    : named;
  const dir = path.resolve(env.cwd, expanded);
  const isDir = yield* fs.stat(dir).pipe(
    Effect.map((info) => info.type === "Directory"),
    Effect.orElseSucceed(() => false),
  );
  if (!isDir) return null;
  return { found: { label: path.basename(dir), cwd: dir } };
});

export interface NamedDirectory {
  readonly label: string;
  readonly cwd: string;
}

export type WorkspaceNamed = { found: NamedDirectory } | { error: string } | null;

export const upgrade = Effect.fn("operations.upgrade")(function* (
  env: PluginEnv,
  options: {
    readonly to?: string;
    readonly carried?: Carried | null;
    readonly key?: string;
    readonly liveCheckouts?: Effect.Effect<ReadonlyArray<string> | null, never, PlatformServices>;
  } = {},
  run: Runner<ChildProcessSpawner.ChildProcessSpawner> = shell,
) {
  const { to } = options;
  if (to !== undefined && !RELEASE_TAG.test(to)) {
    return err("invalid_input", `"${to}" is not a Collie version, such as 0.27.0.`, { to });
  }
  const root = env.pluginRoot;
  const checkout = yield* isCheckout(root, run);
  if (!checkout) {
    const source = releasesOf(env.raw);
    const target = to ?? (yield* newestRelease(source));
    if (target === null) {
      return err(
        "operation_failed",
        `Could not read the newest release from ${source}, so ${root} was left as it was.`,
        { root, source },
      );
    }
    if (target !== manifest.version) return yield* handOff(env, target, source, options.key, run);
    return yield* placeOwn(
      env,
      options.carried === undefined ? carriedRelease() : options.carried,
      to,
      run,
    );
  }

  if (yield* atCollieDir(root, env.collieDir)) {
    return yield* migrate(env, to, options.key, options.liveCheckouts ?? liveCheckouts(env), run);
  }
  if (to !== undefined) {
    return err(
      "invalid_state",
      `${root} is a development checkout, so it is never moved to a release; \`collie upgrade\` pulls it.`,
      { root },
    );
  }
  const head = () => run("git", ["rev-parse", "--short", "HEAD"], root).pipe(Effect.map(short));
  const before = yield* head();
  // WARNING: --ff-only never merges or rebases local work; --autostash carries uncommitted work through the pull.
  const pulled = yield* run("git", ["pull", "--ff-only", "--autostash"], root);
  // WARNING: a conflicting autostash exits 0, so unmerged files are checked for separately.
  const unmerged = Str.trim((yield* run("git", ["ls-files", "--unmerged"], root)).stdout);
  if (pulled.code !== 0 || unmerged !== "") {
    return err("operation_failed", `Could not update ${root}.`, {
      root,
      output: whatItSaid(pulled),
    });
  }
  const after = yield* head();
  const moved = before !== after;
  const prepared = yield* prepareAndDesktop(env, root, undefined, run);
  if (!prepared.ok) return prepared;
  return {
    ok: true as const,
    data: { root, checkout, before, after, updated: moved, steps: prepared.steps },
    human: Arr.join(
      [
        moved
          ? `Updated ${root} from ${before} to ${after}.`
          : `${root} was already up to date at ${before}.`,
        ...stepLines(prepared.steps),
      ],
      "\n",
    ),
  };
});

const migrate = Effect.fn("operations.migrate")(function* (
  env: PluginEnv,
  to: string | undefined,
  key: string | undefined,
  live: Effect.Effect<ReadonlyArray<string> | null, never, PlatformServices>,
  run: Runner<ChildProcessSpawner.ChildProcessSpawner>,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = env.pluginRoot;
  const exclude = path.resolve(
    root,
    Str.trim((yield* run("git", ["rev-parse", "--git-path", "info/exclude"], root)).stdout),
  );
  const excluded = yield* fs.readFileString(exclude).pipe(Effect.orElseSucceed(() => ""));
  const adding = Arr.filter(
    MIGRATION_EXCLUDES,
    (line) => !Str.split(excluded, "\n").includes(line),
  );
  if (adding.length > 0) {
    yield* fs.makeDirectory(path.dirname(exclude), { recursive: true });
    const separator = excluded === "" || pipe(excluded, Str.endsWith("\n")) ? "" : "\n";
    yield* fs.writeFileString(exclude, `${excluded}${separator}${Arr.join(adding, "\n")}\n`);
  }

  const source = releasesOf(env.raw);
  const target = to ?? (yield* newestRelease(source));
  if (target === null) {
    return err(
      "operation_failed",
      `Could not read the newest release from ${source}, so ${root} was left as it was.`,
      { root, source },
    );
  }
  // WARNING: the release's own runner, since one built from this clone would place the clone's source.
  const placed = yield* handOff(env, target, source, key, run, path.join(env.collieDir, "release"));
  if (!placed.ok) return placed;

  const found = yield* humansIn(root, live, run);
  if (found.length === 0) {
    for (const entry of yield* fs.readDirectory(env.collieDir)) {
      if (!COLLIE_DIR_ENTRIES.includes(entry)) {
        yield* fs.remove(path.join(env.collieDir, entry), { recursive: true });
      }
    }
  }
  return {
    ok: true as const,
    data: { ...placed.data, clone: found.length === 0 ? ("removed" as const) : { kept: found } },
    human: Arr.join(
      [
        placed.human,
        found.length === 0
          ? `Removed the clone that was installed at ${root}: nothing in it was yours.`
          : Arr.join(
              [
                `Kept the clone at ${root} as it was, because it holds:`,
                ...Arr.map(found, (what) => `  ${what}`),
                `It is an ordinary checkout now; Collie runs from ${placed.data.root}.`,
              ],
              "\n",
            ),
      ],
      "\n",
    ),
  };
});

const MIGRATION_EXCLUDES = ["/release/", "/kept/"];
const COLLIE_DIR_ENTRIES = ["release", "user", "kept"];
const INSTALL_IGNORED = ["bin/", "node_modules/", "user/", "release/", "kept/"];

const humansIn = Effect.fn("operations.humansIn")(function* (
  root: string,
  live: Effect.Effect<ReadonlyArray<string> | null, never, PlatformServices>,
  run: Runner<ChildProcessSpawner.ChildProcessSpawner>,
) {
  const git = (...args: Array<string>) => run("git", args, root);
  const said = (result: { code: number; stdout: string }) =>
    result.code === 0 ? Str.trim(result.stdout) : null;
  const found: Array<string> = [];

  const status = said(yield* git("status", "--porcelain"));
  if (status !== "") found.push("changed or untracked files");
  const ignored = Arr.filter(
    Arr.map(
      Arr.filter(
        Str.split(said(yield* git("status", "--porcelain", "--ignored")) ?? "", "\n"),
        (line) => pipe(line, Str.startsWith("!! ")),
      ),
      (line) => pipe(line, Str.slice(3)),
    ),
    (entry) => !INSTALL_IGNORED.includes(entry),
  );
  if (ignored.length > 0) found.push(`ignored files of yours: ${Arr.join(ignored, ", ")}`);
  if (said(yield* git("log", "--branches", "--not", "--remotes", "--oneline")) !== "") {
    found.push("commits no remote branch contains");
  }
  if (said(yield* git("stash", "list")) !== "") found.push("a stash");
  const worktrees = said(yield* git("worktree", "list", "--porcelain"));
  if (
    worktrees === null ||
    Arr.filter(Str.split(worktrees, "\n"), (line) => pipe(line, Str.startsWith("worktree ")))
      .length > 1
  ) {
    found.push("linked worktrees");
  }
  const checkouts = yield* live;
  if (checkouts === null) found.push("live Runs on this Machine, which could not be asked about");
  else if (Arr.some(checkouts, (cwd) => cwd === root || pipe(cwd, Str.startsWith(`${root}/`)))) {
    found.push("a live Run working in it");
  }
  return found;
});

const PLACING_CLAIMS = 2400;

export const placeLocked = Effect.fn("operations.placeLocked")(function* (
  carried: Carried,
  collieDir: string,
  version: string,
) {
  const lock = `${collieDir}/placing.lock`;
  yield* ensureLockDir(lock);
  return yield* withLock(
    lock,
    Effect.fail(new Cause.TimeoutError(`another placement held ${lock} for over a minute`)),
    placeRelease(carried, collieDir, version),
    PLACING_CLAIMS,
  );
});

const placeOwn = Effect.fn("operations.placeOwn")(function* (
  env: PluginEnv,
  carried: Carried | null,
  to: string | undefined,
  run: Runner<ChildProcessSpawner.ChildProcessSpawner>,
) {
  if (carried === null) {
    return err(
      "invalid_state",
      `${env.pluginRoot} is not a checkout, and this runner was not built as a release, so it has none to place.`,
      { root: env.pluginRoot },
    );
  }
  const placed = yield* Effect.result(placeLocked(carried, env.collieDir, manifest.version));
  if (placed._tag === "Failure") {
    return err("operation_failed", `Could not place the release in ${env.collieDir}.`, {
      root: env.collieDir,
      output: placed.failure.message,
    });
  }
  const { root, kept, is } = placed.success;
  yield* (yield* FileSystem.FileSystem).makeDirectory(env.userDir, { recursive: true });
  const hc = yield* placeHc(env, root, is[BUNDLED_HC] ?? null, hcPin.version, run);
  const prepared = yield* prepareAndDesktop(env, root, manifest.version, run);
  if (!prepared.ok) return prepared;
  const data = {
    root,
    checkout: false,
    release: manifest.version,
    kept,
    steps: [...(hc === null ? [] : [hc]), ...prepared.steps],
    ...(to && { version: to }),
  };
  return { ok: true as const, data, human: placedReport(env, data) };
});

const Placed = Schema.Struct({
  root: Schema.String,
  release: Schema.String,
  kept: Schema.Array(Schema.String),
  steps: Schema.Array(
    Schema.Struct({ step: Schema.String, state: Schema.String, detail: Schema.String }),
  ),
});

const placedReport = (env: PluginEnv, placed: typeof Placed.Type) =>
  Arr.join(
    [
      `Placed Collie ${placed.release} in ${placed.root}.`,
      ...(placed.kept.length === 0
        ? []
        : [
            `Edits found in the release were copied aside, and are no longer in force:`,
            ...Arr.map(placed.kept, (file) => `  ${env.collieDir}/${file}`),
            `To keep one, fork it into ${env.userDir} with \`collie workflow fork\` or \`collie persona fork\`, and make the change there.`,
          ]),
      ...stepLines(placed.steps),
    ],
    "\n",
  );

const HandedOff = Schema.fromJsonString(
  Schema.Union([
    Schema.Struct({ ok: Schema.Literal(true), data: Placed }),
    Schema.Struct({ ok: Schema.Literal(false), error: ExpectedError }),
  ]),
);

// WARNING: nothing is replaced unless the target runner runs.
const handOff = Effect.fn("operations.handOff")(function* (
  env: PluginEnv,
  target: string,
  source: string,
  key: string | undefined,
  run: Runner<ChildProcessSpawner.ChildProcessSpawner>,
  pluginRoot: string = env.pluginRoot,
) {
  const got = yield* Effect.result(
    verifiedRunner(`${source}/download`, target, ownPlatform(), `${env.stateDir}/runners`, key),
  );
  if (got._tag === "Failure") {
    const { reason, missing } = got.failure;
    return missing
      ? err("invalid_input", `There is no release ${target}: ${reason}.`, { to: target })
      : err("operation_failed", `Could not use Collie ${target}'s runner: ${reason}.`, {
          to: target,
          output: reason,
        });
  }
  yield* (yield* FileSystem.FileSystem).chmod(got.success.file, 0o755);
  const ran = yield* run(
    "env",
    [
      `COLLIE_DIR=${env.collieDir}`,
      `COLLIE_USER_DIR=${env.userDir}`,
      `COLLIE_ROOT=${pluginRoot}`,
      `COLLIE_RELEASES=${source}`,
      got.success.file,
      "--json",
      "upgrade",
      "--to",
      target,
    ],
    env.home,
  );
  const answer = Schema.decodeUnknownOption(HandedOff)(
    Str.split(Str.trim(ran.stdout), "\n").at(-1),
  );
  if (answer._tag === "None") {
    return err("operation_failed", `Collie ${target}'s runner did not say what its upgrade did.`, {
      to: target,
      output: whatItSaid(ran),
    });
  }
  if (!answer.value.ok) return { ok: false as const, error: answer.value.error };
  const data = { ...answer.value.data, checkout: false, version: target };
  return { ok: true as const, data, human: placedReport(env, data) };
});

const stepLines = (steps: ReadonlyArray<{ step: string; state: string; detail: string }>) =>
  Arr.map(
    steps,
    (step) =>
      `  ${pipe(step.step, Str.padEnd(16))}${step.state}${step.detail ? ` — ${step.detail}` : ""}`,
  );

const prepareAndDesktop = Effect.fn("operations.prepareAndDesktop")(function* (
  env: PluginEnv,
  root: string,
  to: string | undefined,
  run: Runner<ChildProcessSpawner.ChildProcessSpawner>,
) {
  const installed = yield* run("sh", ["prepare.sh"], root);
  if (installed.code !== 0) {
    return err("operation_failed", `Could not prepare ${root}.`, {
      root,
      output: whatItSaid(installed),
    });
  }
  // WARNING: loaded lazily: only an upgrade reaches Desktop.
  const { dataHomeOf, updateDesktop } = yield* Effect.promise(() => import("./desktop"));
  const desktop = yield* updateDesktop(to ?? (yield* releaseVersion(root)), {
    dataHome: dataHomeOf(env.home, env.raw.XDG_DATA_HOME),
  });
  const steps = [...prepareSteps(installed.stdout), ...(desktop === null ? [] : [desktop])];
  return { ok: true as const, steps };
});

// WARNING: half of a contract with prepare.sh's printf: a reworded step line would silently empty this report.
const PREPARE_LINE = /^prepare: ([a-z-]+): (done|already in place|skipped|failed)(?: — (.*))?$/;

export function prepareSteps(output: string) {
  const returned: Array<{ step: string; state: string; detail: string }> = Arr.flatMap(
    Str.split(output, "\n"),
    (line) => {
      const match = PREPARE_LINE.exec(Str.trim(line));
      return match ? [{ step: match[1]!, state: match[2]!, detail: match[3] ?? "" }] : [];
    },
  );
  return returned;
}

function short(result: { code: number; stdout: string }) {
  return result.code === 0 ? Str.trim(result.stdout) : "";
}

// WARNING: a continuation's Task is given, never found by label, since two Tasks may share one.
export const taskFor = Effect.fn("operations.taskFor")(function* (
  env: PluginEnv,
  choice: TaskChoice,
  about: StartAbout,
) {
  const kept = (task: TaskRecord | null, label: string | null = null) => ({
    _tag: "Ok" as const,
    task,
    label,
  });
  if (choice.mode === "continue") return kept(choice.task);
  return kept(null, yield* freshTaskLabel(env, about));
});

export const clearOverride = Effect.fn("operations.clearOverride")(function* (
  stateDir: string,
  herdr: Herdr,
  runId: string,
  agent: string,
  by: string,
  voice: Voice = {},
) {
  const live: Array<AgentInfo> = yield* herdr.agentList().pipe(Effect.orElseSucceed(() => []));
  const terminalId =
    Option.getOrUndefined(Arr.findFirst(live, (a) => a.name === agent))?.terminalId ?? null;
  if (terminalId === null)
    return err("invalid_state", `core has no live agent "${agent}" to clear an override on.`);
  if (!overrideActive(yield* readLedger(terminalId)))
    return err("invalid_state", `"${agent}" is not under a manual override.`);
  yield* appendLine({
    kind: "override_cleared",
    at: yield* nowIso,
    incarnation: terminalId,
    by,
    ...voice,
  });
  return ok({ runId, agent }, `Cleared the manual override on ${agent}.`);
});

// WARNING: this is all chat may do: the same path a steer takes, with no second model re-reading the request.
export const request = Effect.fn("operations.request")(function* (
  env: PluginEnv,
  herdKey: string,
  options: {
    readonly interpretation: string;
    readonly actions: ReadonlyArray<Action>;
    // WARNING: stamped by the entrypoint, never read out of the request.
    readonly actor: Actor;
  },
) {
  if (options.actions.length === 0)
    return err("invalid_input", "A request with no actions changes nothing; say what to do.");
  const named = [...new Set(Arr.flatMap(options.actions, (a) => ("run" in a ? [a.run] : [])))];
  const known = yield* listRuns(env);
  const runs = new Map<string, RunFacts>();
  for (const id of named) {
    const run = Option.getOrUndefined(Arr.findFirst(known, (one) => one.id === id)) ?? null;
    // WARNING: refused, not retargeted: a guess lands an action on someone else's work.
    if (run === null) return err("run_not_found", `No Run "${id}".`, { run: id });
    runs.set(id, run);
  }

  const intents = new Map<string, { version: number; authority: Authority }>();
  for (const [id, run] of runs) {
    const intent = yield* readIntent(run.dir).pipe(
      Effect.orElseSucceed(() => "unreadable" as const),
    );
    if (intent === "unreadable")
      return err("invalid_state", `${id}'s Intent cannot be read; nothing was proposed.`);
    if (intent !== null) intents.set(id, { version: intent.version, authority: intent.authority });
  }

  const registered = yield* everyRegistered;
  const checked = validate(
    {
      interpretation: options.interpretation,
      targets: Arr.map(named, (run) => ({ run })),
      actions: [...options.actions],
      confidence: 1,
    },
    {
      runs: new Set(runs.keys()),
      agents: new Map(Arr.map([...runs.keys()], (id) => [id, agentsOf(registered, id)])),
      intents,
      origin: "steer",
      maxDeliveryBytes: MAX_DELIVERY_BYTES,
    },
  );

  const file = herdKey;
  const addressed = yield* incarnationsFor(env, checked);
  const proposal: Recorded = {
    interpretation: options.interpretation,
    targets: Arr.map(named, (run) => ({ run })),
    actions: Arr.map(checked, (entry) => entry.action),
    allowedNow: [],
    intentVersions: Rec.fromEntries(Arr.map([...intents], ([id, at]) => [id, at.version] as const)),
    by: actorName(options.actor),
  };
  const recorded = yield* recordProposal(
    file,
    Struct.keys(addressed).length === 0 ? proposal : { ...proposal, incarnations: addressed },
  );
  return yield* carryOutProposal(env, recorded.id, recorded.content_hash, options.actor, true);
});

const incarnationsFor = Effect.fn("operations.incarnationsFor")(function* (
  env: PluginEnv,
  checked: ReadonlyArray<Validated>,
) {
  const named = new Set(
    Arr.flatMap(checked, (entry) =>
      "agent" in entry.action && entry.action.agent !== undefined ? [entry.action.agent] : [],
    ),
  );
  const found: Record<string, string> = {};
  if (named.size === 0) return found;
  const live = yield* new Herdr(env).agentList().pipe(Effect.orElseSucceed(() => []));
  for (const agent of named) {
    const terminalId = Option.getOrUndefined(
      Arr.findFirst(live, (entry) => entry.name === agent),
    )?.terminalId;
    if (terminalId !== undefined && terminalId !== null) found[agent] = terminalId;
  }
  return found;
});

function revisionOf(revision: { readonly head_sha: string; readonly fingerprint: string }) {
  return `${revision.head_sha}:${revision.fingerprint}`;
}

const cardRevision = Effect.fn("operations.cardRevision")(function* (
  run: RunFacts,
  id: string | null,
) {
  if (id === null) return null;
  const cards = yield* readCards(run.dir).pipe(Effect.orElseSucceed(() => []));
  const card = Option.getOrUndefined(Arr.findFirst(cards, (entry) => entry.id === id));
  return card === undefined ? "unknown" : { id, revision: revisionOf(card.revision) };
});

// WARNING: a front door never chooses the budget, so a board and a terminal cannot disagree about spend.
export const steer = Effect.fn("operations.steer")(function* (
  env: PluginEnv,
  deps: {
    readonly herdKey: string;
    readonly evaluator: EvaluatorDeps;
    readonly limits: EvaluatorLimits;
  },
  options: {
    readonly text: string;
    readonly target?: string | null;
    readonly from?: string | null;
    readonly dryRun?: boolean;
    readonly requestId: string;
    readonly origin?: FrontDoor;
    // WARNING: an event question is journaled as the event, never as the human's words.
    readonly asked?: "human" | "event";
  },
) {
  const target = options.target ?? null;
  const known = yield* listRuns(env);
  const run =
    target === null
      ? null
      : (Option.getOrUndefined(Arr.findFirst(known, (one) => one.id === target)) ?? null);
  if (target === null)
    return err("invalid_input", "Name the Run this is about with --target.", {
      code: "target_required",
    });
  if (run === null) return err("run_not_found", `No Run "${target}".`, { run: target });
  // WARNING: a retry asks nobody again, since a second answer could order the actions differently.
  if (options.dryRun !== true && options.asked !== "event") {
    const before = yield* carriedBefore(deps.herdKey, options.requestId);
    if (before !== null) return before;
  }

  const journal = yield* conversationPath(env.stateDir, deps.herdKey);
  const roots = Arr.map(known, (r) => r.dir);
  const said: NewTurn = { role: options.asked ?? "human", text: options.text };
  yield* append(journal, { ...said, target }, roots);

  const from = options.from ?? null;
  const pack = yield* evidencePack(env, options.text, run, from, journal);

  // WARNING: read before the call: recorded as {}, the proposal would skip the version gate after the money is spent.
  const intent = yield* readIntent(run.dir).pipe(Effect.orElseSucceed(() => "unreadable" as const));
  if (intent === "unreadable")
    return err("invalid_state", `${run.id}'s Intent cannot be read; nothing was proposed.`);

  const budget = yield* budgetPath(env.stateDir, deps.herdKey);
  const callId = yield* newRequestId();
  yield* reserve(budget, { id: callId, run: run.id }, deps.limits);

  const asked = yield* evaluate(deps.evaluator, "proposal", pack);
  yield* settleBudget(budget, callId, {
    outcome: asked.spent.outcome === "ok" && asked.error !== null ? "failed" : asked.spent.outcome,
    usd: asked.spent.usd,
    seconds: asked.spent.seconds,
    bytes: asked.spent.bytes,
  });
  if (asked.value === null)
    return err("operation_failed", `Collie could not answer: ${asked.error ?? "no answer"}.`);

  const proposed = asked.value;
  if (!("actions" in proposed))
    return err("operation_failed", "Collie answered a question nobody asked.");

  const checked = validate(proposed, {
    runs: new Set([run.id]),
    agents: new Map([[run.id, agentsOf(yield* everyRegistered, run.id)]]),
    intents: new Map(
      intent === null ? [] : [[run.id, { version: intent.version, authority: intent.authority }]],
    ),
    origin: "steer",
    maxDeliveryBytes: MAX_DELIVERY_BYTES,
  });

  if (options.dryRun)
    return ok(
      {
        preview: { interpretation: proposed.interpretation, actions: checked },
        requestId: options.requestId,
      },
      previewOf(proposed.interpretation, checked),
    );

  const file = deps.herdKey;
  const bound = yield* cardRevision(run, from);
  if (bound === "unknown")
    return err("invalid_input", `Run ${run.id} has no card "${from}".`, { card: from ?? "" });
  const proposal: Recorded = {
    interpretation: proposed.interpretation,
    targets: [{ run: run.id }],
    actions: Arr.map(checked, (entry) => entry.action),
    // WARNING: a requested action is not the Driver's standing authority, so nothing is pre-allowed.
    allowedNow: [],
    intentVersions: intent === null ? {} : { [run.id]: intent.version },
    by: `evaluator:${callId}`,
  };
  const addressed = yield* incarnationsFor(env, checked);
  const withCard: Recorded = bound === null ? proposal : { ...proposal, card: bound };
  const recorded = yield* recordProposal(
    file,
    Struct.keys(addressed).length === 0 ? withCard : { ...withCard, incarnations: addressed },
  );
  const reply: NewTurn = {
    role: "collie",
    text: proposed.interpretation,
    target: run.id,
    proposal: recorded.id,
    evaluatorCall: callId,
  };
  yield* append(journal, from === null ? reply : { ...reply, card: from }, roots);

  if (options.asked !== "event")
    return yield* carryOutProposal(
      env,
      recorded.id,
      recorded.content_hash,
      { origin: options.origin ?? "cli", requestId: options.requestId },
      true,
    );

  return ok(
    {
      proposal: {
        id: recorded.id,
        hash: recorded.content_hash,
        expires_at: recorded.expires_at,
        actions: Arr.map(checked, (entry) => ({ ...entry.action, status: entry.state })),
      },
      requestId: options.requestId,
    },
    Arr.join(
      [
        previewOf(proposed.interpretation, checked),
        `collie confirm ${recorded.id} --hash ${recorded.content_hash}`,
      ],
      "\n",
    ),
  );
});

function previewOf(interpretation: string, checked: ReadonlyArray<Validated>) {
  return Arr.join(
    [
      interpretation,
      ...Arr.map(
        checked,
        (entry) => `  ${entry.state === "allowed_now" ? "→" : "?"} ${describeAction(entry.action)}`,
      ),
    ],
    "\n",
  );
}

const HERD_LINES = 40;
const TURNS_IN_CONTEXT = 20;
const CARDS_IN_CONTEXT = 3;

// WARNING: a steer is a question, never a command: its proposal stays pending even where Collie may correct drift.
export const herdFacts = Effect.fn("operations.herdFacts")(function* (env: PluginEnv) {
  const runs = yield* listRuns(env);
  const registered = yield* everyRegistered;
  const listed = runs.slice(0, HERD_LINES);
  const lines: Array<string> = [];
  for (const item of listed) {
    const said = [
      `- run ${item.id}: ${item.workflow}, ${item.state}`,
      `agents ${Arr.join([...agentsOf(registered, item.id)], ", ") || "none"}`,
      `outcome ${item.outcome}`,
    ];
    const attention = yield* attentionFor(item);
    if (attention.category !== "none") said.push(attention.explanation);
    lines.push(Arr.join(said, ", "));
  }
  if (lines.length === 0) return "- (no Runs in this Herd)";
  return Arr.join(
    [
      ...lines,
      ...(runs.length > listed.length
        ? [`- (${runs.length - listed.length} more Run(s) not listed here)`]
        : []),
    ],
    "\n",
  );
});

const agentsOf: (registered: ReadonlyArray<AgentEntry>, run: string) => Set<string> = (
  registered,
  run,
) =>
  new Set(
    Arr.map(
      Arr.filter(registered, (entry) => entry.runId === run),
      (entry) => entry.agent,
    ),
  );

const ANSWERS_IN_CONTEXT = 5;
const FINDINGS_IN_CONTEXT = 10;
const LOG_LINES_IN_CONTEXT = 5;
const LOG_LINE_CHARS = 200;
const LOG_TAIL_BYTES = 16 * 1024;

const actionText = flow(
  Schema.encodeResult(Schema.fromJsonString(ActionSchema)),
  Result.getOrThrow,
);

export const answerAction: (run: string, choiceId: string, answer: string) => string = (
  run,
  choiceId,
  answer,
) => actionText({ kind: "answer", run, choiceId, answer });

export const choiceLines: (run: string, asked: Asked) => Array<string> = (run, asked) => [
  `Waiting on the Choice "${asked.name}": ${asked.prompt}`,
  asked.options.length === 0
    ? "It has no options: it is answered in words."
    : `Options: ${Arr.join(Arr.map(asked.options, solutionTitle), " | ")}`,
  ...Arr.flatMap(asked.options, (option) =>
    option.detail === undefined ? [] : [`${solutionTitle(option)}: ${option.detail}`],
  ),
  `Answer it with the collie_do action ${answerAction(
    run,
    asked.name,
    asked.options.length === 0 ? "<their words>" : "<one of the options>",
  )}`,
];

const decodeAnswered = Schema.decodeUnknownOption(Answered);

const answererOf: (actor: AuditLine["actor"]) => string = (actor) => {
  const { origin, from, conversation } = actor;
  const door = (() => {
    switch (origin) {
      case "desktop":
        return from?.client === undefined ? "desktop" : `desktop on ${from.client}`;
      case "chat":
        return conversation === undefined ? "chat" : `chat ${conversation}`;
      case "cli-tty":
        return "cli";
      default:
        return origin;
    }
  })();
  return from?.machine === undefined ? door : `${door} from ${from.machine.name}`;
};

const answeredLines = Effect.fn("operations.answeredLines")(function* (run: RunFacts) {
  if (run.answered.length === 0) return [];
  const trail = yield* readAudit(run.dir).pipe(Effect.orElseSucceed(() => []));
  const by = new Map<string, AuditLine>();
  for (const line of trail) {
    if (line.operation !== "answer") continue;
    const answered = decodeAnswered(line.result);
    if (answered._tag === "Some" && answered.value.fresh) by.set(answered.value.decision, line);
  }
  return [
    "",
    "### Answered",
    "",
    ...Arr.map(run.answered.slice(-ANSWERS_IN_CONTEXT).reverse(), ({ name, answer }) => {
      const line = by.get(name);
      return `- "${name}": ${answer} — ${line === undefined ? "who answered is not recorded" : `${answererOf(line.actor)} at ${line.at}`}`;
    }),
  ];
});

const mergeLines = Effect.fn("operations.mergeLines")(function* (env: PluginEnv, run: RunFacts) {
  const lines = run.branch === null ? [] : [`Branch: ${run.branch}`];
  if (run.mr === null) return lines;
  const watched = yield* watchedOf(env);
  const noun = mrNounOf(run.mr);
  return [
    `${Str.toUpperCase(noun[0]!)}${pipe(noun, Str.slice(1))}: ${run.mr} — ${yield* watched(run.mr, run.cwd)}`,
    ...lines,
  ];
});

const watchedOf = Effect.fn("operations.watchedOf")(function* (env: PluginEnv) {
  const states = yield* readMrStates(env.stateDir);
  const forge = yield* readForge(env.stateDir);
  return (mr: string, cwd: string) =>
    Effect.map(mrIdIn(mr, cwd, shell), (id) => {
      const state = id === null ? undefined : states.get(id);
      const checks = id === null ? undefined : forge.get(id)?.checks;
      return state === undefined
        ? "not watched"
        : `${state}, checks ${checks === undefined ? "not recorded" : checks.state === "failed" ? `failed (${checks.name})` : checks.state}`;
    });
});

const planLines = Effect.fn("operations.planLines")(function* (run: RunFacts) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const dir = path.join(run.dir, PLAN_DIR);
  if (!(yield* fs.exists(dir))) return [];
  const tickets = Arr.filter(
    yield* fs.readDirectory(path.join(dir, "issues")).pipe(Effect.orElseSucceed(() => [])),
    (name) => pipe(name, Str.endsWith(".md")),
  ).length;
  return [`Plan: ${dir} (${tickets} ticket${tickets === 1 ? "" : "s"})`];
});

const verdictLines = Effect.fn("operations.verdictLines")(function* (run: RunFacts) {
  const findings = yield* findingsIn(run.dir);
  const disposition = latest(yield* readDispositions(run.dir));
  const left = findings.length - FINDINGS_IN_CONTEXT;
  return [
    ...(findings.length === 0
      ? []
      : [
          "",
          "### Findings",
          "",
          ...Arr.map(
            findings.slice(0, FINDINGS_IN_CONTEXT),
            (finding) => `- (${finding.severity}) ${finding.title}`,
          ),
          ...(left > 0 ? [`- (${left} more)`] : []),
          "",
        ]),
    ...(disposition === null
      ? []
      : [
          `Disposition: ${disposition.ref === "" ? disposition.kind : `${disposition.kind} ${disposition.ref}`}`,
        ]),
    ...(run.outcome === "unspecified" ? [] : [`Outcome to prove: ${run.outcome}`]),
  ];
});

const logLines = Effect.fn("operations.logLines")(function* (run: RunFacts) {
  const log = yield* tailed(`${run.dir}/log.txt`, LOG_TAIL_BYTES);
  const kept = Arr.filter(
    Arr.map(Str.split(log?.text ?? "", "\n"), (line) => Str.trim(line)),
    (line) =>
      line !== "" &&
      line !==
        Option.getOrUndefined(
          Option.map(Option.fromNullishOr(run.summary), (present) => Str.trim(present)),
        ),
  ).slice(-LOG_LINES_IN_CONTEXT);
  if (kept.length === 0) return [];
  return [
    "",
    "### Last recorded",
    "",
    ...Arr.map(
      kept,
      (line) =>
        `- ${line.length > LOG_LINE_CHARS ? `${pipe(line, Str.slice(0, LOG_LINE_CHARS))}…` : line}`,
    ),
  ];
});

export const runFacts = Effect.fn("operations.runFacts")(function* (
  env: PluginEnv,
  run: RunFacts,
  listed?: ReadonlyArray<RunFacts>,
  launched?: Effect.Effect<ReadonlyArray<Launched>>,
) {
  const intent = yield* readIntent(run.dir).pipe(Effect.orElseSucceed(() => null));
  const attention = yield* attentionFor(run);
  const started = Arr.filter(listed ?? (yield* listRuns(env)), (one) => one.parent === run.id);
  const agents = Arr.map(
    yield* launched ?? hostLaunches(env, run.id).pipe(Effect.orElseSucceed(() => [])),
    agentOfLaunch,
  );
  const watched = yield* watchedOf(env);
  const lines = [
    `Status: ${run.state}`,
    ...(run.park == null ? [] : [parkLine(run.park)]),
    `Directory: ${run.cwd}`,
    `Workspace: ${run.workspace ?? "its Task's"}`,
    `Goal: ${intent?.goal ?? run.settled.inputs.goal ?? "(none recorded)"}`,
    `Intent version: ${intent?.version ?? "(none)"}`,
    ...(run.asking.length === 0
      ? [attention.explanation]
      : Arr.flatMap(run.asking, (asked) => choiceLines(run.id, asked))),
    `Actions: ${Arr.join(attention.actions, ", ") || "none"}`,
    ...Arr.map(
      intent?.constraints ?? [],
      (c) => `- constraint ${c.id} (${c.severity}, ${c.source}): ${c.text}`,
    ),
    ...(yield* answeredLines(run)),
    ...(run.summary === null ? [] : ["", `Result: ${run.summary}`]),
    ...(started.length === 0
      ? []
      : [
          "",
          "### Runs it started",
          "",
          ...(yield* Effect.forEach(
            started,
            Effect.fnUntraced(function* (one) {
              return `- run ${one.id}: ${one.workflow}, ${one.state}${one.mr === null ? "" : `; ${mrLabel(one.mr)} ${yield* watched(one.mr, one.cwd)}`}`;
            }),
          )),
        ]),
    ...(agents.length === 0
      ? []
      : [
          "",
          "### Agents",
          "",
          ...Arr.map(agents, (one) => `- ${one.operation}: ${ranOn(one)} as ${one.agent}`),
        ]),
    "",
    ...(yield* mergeLines(env, run)),
    ...(yield* planLines(run)),
    ...(yield* verdictLines(run)),
    ...(yield* logLines(run)),
    ...((run.recovery?.length ?? 0) === 0 ? [] : ["", "### Recovery", "", ...(run.recovery ?? [])]),
  ];
  const cards = yield* readCards(run.dir).pipe(Effect.orElseSucceed(() => []));
  for (const entry of cards.slice(-CARDS_IN_CONTEXT)) {
    if (lines.at(-1) !== "") lines.push("", "### Cards", "");
    lines.push(
      `- card ${entry.id} (${entry.kind}, ${entry.readiness}, ${entry.significance}) at ${pipe(entry.revision.head_sha, Str.slice(0, 8))}${entry.revision.dirty ? " +dirty" : ""}`,
      `  aligned ${entry.aligned}; cross-run ${entry.cross_run}`,
      ...Arr.map(entry.claims, (claim) => `  claim: ${claim.text}`),
      ...Arr.map(
        entry.verifications,
        (verification) => `  verification ${verification.name}: ${verification.result}`,
      ),
      ...Arr.map(entry.missing, (what) => `  missing: ${what}`),
      ...(entry.drift.length > 0 ? [`  open drift: ${Arr.join(entry.drift, ", ")}`] : []),
    );
  }
  const drift = openReports(yield* readDrift(run.dir).pipe(Effect.orElseSucceed(() => [])));
  if (drift.length > 0) {
    lines.push("", "### Open drift", "");
    for (const report of drift)
      lines.push(
        `- ${report.constraint} (${report.severity}, ${report.kind}): ${report.correction ?? "no correction recorded"}`,
      );
  }
  return Str.trimEnd(pipe(Arr.join(lines, "\n"), Str.replaceAll(/\n{3,}/g, "\n\n")));
});

const evidencePack = Effect.fn("operations.evidencePack")(function* (
  env: PluginEnv,
  question: string,
  run: RunFacts | null,
  card: string | null,
  journal: string,
) {
  const lines = [
    "## The question",
    "",
    question,
    "",
    "## Runs in this Herd",
    "",
    yield* herdFacts(env),
  ];

  // WARNING: without the conversation, an untargeted question has no memory to resolve a follow-up against.
  const said = yield* tail(journal, TURNS_IN_CONTEXT);
  if (said.length > 0) {
    lines.push(
      "",
      "## This conversation so far",
      "",
      ...Arr.map(
        said,
        (turn) => `- ${turn.role}${turn.target ? ` (about ${turn.target})` : ""}: ${turn.text}`,
      ),
    );
  }
  if (run !== null) {
    lines.push("", `## Run ${run.id}`, "", yield* runFacts(env, run));
    if (card !== null) {
      const cards = yield* readCards(run.dir).pipe(Effect.orElseSucceed(() => []));
      const bound = Option.getOrUndefined(Arr.findFirst(cards, (entry) => entry.id === card));
      lines.push(
        "",
        `### Card ${card}`,
        "",
        bound === undefined
          ? "(no card of that id; nothing is bound)"
          : `Bound to this card's revision: ${bound.revision.head_sha} (${bound.readiness}).`,
      );
    }
    const turns = yield* tail(journal, TURNS_IN_CONTEXT, run.id);
    if (turns.length > 0)
      lines.push(
        "",
        "### Earlier turns about this run",
        "",
        ...Arr.map(turns, (t) => `- ${t.role}: ${t.text}`),
      );
  }
  return Arr.join(lines, "\n");
});

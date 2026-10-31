import * as Cause from "effect/Cause";
// What starting, answering, stopping and resuming a Run actually does. Both the CLI
// and the Herdr adapters call these; neither owns the behaviour, so a pane and a
// command cannot drift apart. What stays with each of them is presentation: picking,
// prompting, rendering, and turning a result into text or JSON.

import * as Struct from "effect/Struct";
import * as Arr from "effect/Array";
import * as Option from "effect/Option";
import * as Str from "effect/String";
import { pipe } from "effect/Function";
import * as Rec from "effect/Record";
import type { PlatformServices } from "./platform";
import { repositoryCheckout } from "./projects";
import { Effect, FileSystem, Path, Schema, flow, Result } from "effect";
import * as SecureRandom from "effect/crypto/SecureRandom";
import { ChildProcessSpawner } from "effect/process";
import { nowIso } from "./time";
import { attentionFor } from "./attention";
import type { PluginEnv } from "./env";
import { Answered, mrLabel, mrNounOf, ranOn, type FrontDoor } from "./board-model";
import { runAgents } from "./launches";
import { readAudit, type AuditLine } from "./audit";
import { readForge, readMrStates } from "./merges";
import { findingsIn } from "./output";
import { latest, readDispositions } from "./disposition";
import { PLAN_DIR } from "./run-detail";
import { tailed } from "./views";
import { Herdr, type AgentInfo, type PaneInfo, type WorkspaceInfo } from "./herdr";
import { carriedBefore, carryOutProposal } from "./run-actions";
export { carryOutProposal, registerRunExecutors } from "./run-actions";
import { shell, whatItSaid, type Runner } from "./mr";
import { ensureLockDir, withLock } from "./lock";
import { checkoutsUnder, projectsRoot } from "./projects";
import { newestRelease, ownPlatform, releasesOf, verifiedRunner } from "./releases";
import {
  atCollieDir,
  isCheckout,
  carriedRelease,
  manifestField,
  placeRelease,
  RELEASE_TAG,
  type Carried,
} from "./release";
import { BUNDLED_HC, placeHc } from "./hc-install";
import manifest from "../herdr-plugin.toml";
import { everyRegistered, type AgentEntry } from "./registry";
import { listRuns, liveCheckouts, type Asked, type RunFacts } from "./runs";
import { newTask, taskOfWorkspace, writeTask, type TaskChoice, type TaskRecord } from "./task";
import { freshTaskLabel, workNamedIn, type StartAbout } from "./tasknames";
import { readIntent, type Authority } from "./intent";
import {
  appendLine,
  budgetPath,
  ledgerPath,
  overrideActive,
  readLedger,
  reserve,
  settle as settleBudget,
  machineHerd,
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
  proposalsPath,
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
  "run_already_active",
  "run_not_waiting",
  "invalid_answer",
  "choice_already_answered",
  "choice_mismatch",
  "target_exists",
  "needs_input",
  "timeout",
  /** A paired Machine did not answer within its bound. */
  "machine_unreachable",
  "invalid_state",
  /** The workflow a Run recorded is not the workflow its layers resolve to now. */
  "definition_changed",
  "operation_failed",
  "invalid_input",
]);

export const ExpectedError = Schema.Struct({
  code: ErrorCode,
  message: Schema.String,
  details: YamlMapSchema,
});
export interface ExpectedError extends Schema.Schema.Type<typeof ExpectedError> {}

export type Failure = { ok: false; error: ExpectedError };
export type OpResult =
  | {
      ok: true;
      data: object;
      human: string;
    }
  | Failure;

export const err = (
  code: ExpectedError["code"],
  message: string,
  details: YamlMap = {},
): Failure => ({ ok: false, error: ExpectedError.make({ code, message, details }) });

const ok = <A extends object>(data: A, human: string): OpResult => ({
  ok: true,
  data,
  human,
});

/** A fresh id for a mutation whose caller supplied none. Reusing one replays it. */
export const newRequestId = Effect.fn("operations.newRequestId")(function* () {
  return yield* (yield* SecureRandom.SecureRandom).uuidV4();
});

/** The live workspace for this environment, shared by both adapters. */
export const resolveWorkspace = Effect.fn("operations.resolveWorkspace")(function* (
  herdr: Herdr,
  env: PluginEnv,
) {
  if (!env.workspaceId) return null;
  const workspace =
    Option.getOrUndefined(
      Arr.findFirst(yield* herdr.workspaceList(), (item) => item.workspaceId === env.workspaceId),
    ) ?? null;
  if (!workspace || workspace.cwd !== "") return workspace;
  // `herdr workspace list` carries no directory, so a workspace resolved by id alone
  // would fall back to the caller's own cwd — and a `--workspace` run would root at
  // whatever shell it was typed in. The workspace's directory is where its panes are.
  const panes = yield* herdr.paneList().pipe(Effect.orElseSucceed(() => []));
  return { ...workspace, cwd: workspaceCwdFromPanes(env.workspaceId, panes) };
});

/**
 * The workspace a request named, resolved to one this herdr actually has — by id, by the
 * label a human would say, or by the directory it stands for. `null` is a request that
 * named none. An error is a name that matches nothing or more than one thing: a launch
 * aimed at a guess is a Run in a repository nobody asked for.
 *
 * A directory nothing is open on is opened: the human naming a checkout has said which
 * repository they mean, and sending them to the board to open it first is chat obstructing
 * the person it serves (ADR-0011).
 */
export const workspaceNamed = Effect.fn("operations.workspaceNamed")(function* (
  env: PluginEnv,
  named: string | undefined,
): Effect.fn.Return<WorkspaceNamed, never, PlatformServices> {
  if (named === undefined || Str.trim(named) === "") return null;
  const herdr = new Herdr(env);
  const all = yield* herdr.workspaceList().pipe(Effect.orElseSucceed(() => []));
  const panes = yield* herdr.paneList().pipe(Effect.orElseSucceed(() => []));
  const wanted = Str.trim(named);
  const byId = Arr.filter(all, (workspace) => workspace.workspaceId === wanted);
  const matched =
    byId.length > 0
      ? byId
      : Arr.filter(
          all,
          (workspace) => Str.toLowerCase(workspace.label) === Str.toLowerCase(wanted),
        );
  const refused = (error: string): WorkspaceNamed => ({ error });
  if (matched.length === 0) {
    const opened = yield* workspaceForDirectory(env, wanted, all, panes);
    if (opened !== null) return opened;
    const repository = yield* repositoryCheckout(env, wanted).pipe(
      Effect.orElseSucceed(() => null),
    );
    if (repository !== null) {
      if ("error" in repository) return refused(repository.error);
      return yield* workspaceForDirectory(env, repository.path, all, panes);
    }
    if (pipe(wanted, Str.includes("/")))
      return refused(`no directory "${named}" on this Machine; ${yield* howToName(env)}`);
    const checkouts = yield* checkoutsNamed(env, wanted);
    if (checkouts.paths.length === 1)
      return yield* workspaceForDirectory(env, checkouts.paths[0]!, all, panes);
    if (checkouts.paths.length > 1)
      return refused(
        `"${named}" names ${checkouts.paths.length} checkouts under ${checkouts.root} (${Arr.join(checkouts.paths, ", ")}); say which`,
      );
    const root = yield* projectsRoot(env).pipe(Effect.orElseSucceed(() => null));
    return refused(
      `no workspace id, label, directory${root === null ? "" : ` or checkout under the Projects root ${root.path}`} is named "${named}"; workspaces: ${
        Arr.join(
          Arr.map(all, (w) => w.label),
          ", ",
        ) || "none"
      }`,
    );
  }
  if (matched.length > 1)
    return refused(
      `"${named}" names ${matched.length} workspaces (${Arr.join(
        Arr.map(matched, (w) => w.workspaceId),
        ", ",
      )}); say which`,
    );
  const workspace = matched[0]!;
  const cwd =
    workspace.cwd !== "" ? workspace.cwd : workspaceCwdFromPanes(workspace.workspaceId, panes);
  if (cwd === "") return refused(`workspace "${named}" has no directory to run in`);
  return { found: { ...workspace, cwd } };
});

/** Whether `cwd` is in Collie's state directory, the Home's among it: no checkout (ADR-0033). */
export const inCollieState = Effect.fn("operations.inCollieState")(function* (
  env: PluginEnv,
  cwd: string,
) {
  const path = yield* Path.Path;
  const state = path.resolve(env.stateDir);
  const dir = path.resolve(cwd);
  return dir === state || pipe(dir, Str.startsWith(`${state}${path.sep}`));
});

/** Why a start may not be rooted in `cwd`, or null where it may. */
export const collieOwnRefusal = Effect.fn("operations.collieOwnRefusal")(function* (
  env: PluginEnv,
  named: string,
  cwd: string,
) {
  if (!(yield* inCollieState(env, cwd))) return null;
  return `"${named}" is ${cwd}, Collie's own namespace, not a checkout; ${yield* howToName(env)}, or projects-root`;
});

/** How a checkout is named instead, on this Machine. */
const howToName = Effect.fn("operations.howToName")(function* (env: PluginEnv) {
  const root = yield* projectsRoot(env).pipe(Effect.orElseSucceed(() => null));
  return `name a checkout by its workspace, its path on this Machine${root === null ? "" : ` or its directory name under the Projects root ${root.path}`}`;
});

/**
 * The checkouts under the Projects root a repository name names, so a start says "monorepo"
 * from any chat, wherever that chat runs, as it would from the Home.
 */
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

/**
 * A name that is a directory, as the workspace standing for it: the one already on that
 * checkout, or a new one opened there. `null` is a name that is not a directory at all,
 * which is the caller's "matches nothing".
 */
const workspaceForDirectory = Effect.fn("operations.workspaceForDirectory")(function* (
  env: PluginEnv,
  named: string,
  all: ReadonlyArray<WorkspaceInfo>,
  panes: ReadonlyArray<Pick<PaneInfo, "workspaceId" | "cwd">>,
): Effect.fn.Return<WorkspaceNamed, never, PlatformServices> {
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
  const already = Option.getOrUndefined(
    Arr.findFirst(
      all,
      (workspace) =>
        (workspace.cwd !== ""
          ? workspace.cwd
          : workspaceCwdFromPanes(workspace.workspaceId, panes)) === dir,
    ),
  );
  if (already) return { found: { ...already, cwd: dir } };
  // No workspace is opened for it: a fresh Run gets a task workspace of its own whatever
  // it was launched from, so one opened here only to root the launch is left behind
  // empty beside the Run's. The checkout roots the launch; the caller's workspace is
  // where it was launched from.
  return {
    found: {
      workspaceId: env.workspaceId ?? "",
      label: path.basename(dir),
      cwd: dir,
      worktree: null,
      focused: false,
      tokens: {},
    },
  };
});

/** A workspace a request named: the one it is, why it is not one, or none named. */
export type WorkspaceNamed = { found: WorkspaceInfo } | { error: string } | null;

/** The directory a workspace stands for: where its first pane was started. */
export function workspaceCwdFromPanes(
  workspaceId: string,
  panes: ReadonlyArray<Pick<PaneInfo, "workspaceId" | "cwd">>,
): string {
  return (
    Option.getOrUndefined(
      Arr.findFirst(panes, (pane) => Boolean(pane.workspaceId === workspaceId && pane.cwd)),
    )?.cwd ?? ""
  );
}

/**
 * Brings this installation up to date. A release is replaced by the target release's, which
 * this runner places itself or hands to that release's runner. A development checkout is
 * pulled. A clone at the Collie directory has a release placed inside it, and is removed
 * where nothing in it is the human's.
 */
export const upgrade = Effect.fn("operations.upgrade")(function* (
  env: PluginEnv,
  options: {
    readonly to?: string;
    readonly carried?: Carried | null;
    /** The key a downloaded runner must verify against; Collie's own unless a test says. */
    readonly key?: string;
    /** Where live Runs work, or null where that cannot be asked; the host's answer by default. */
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
  // `--ff-only`: an upgrade that quietly merged or rebased someone's local work would be a
  // surprise nobody asked this command for. Uncommitted work rides through the pull.
  const pulled = yield* run("git", ["pull", "--ff-only", "--autostash"], root);
  // A conflicting autostash still exits 0, leaving the work unmerged.
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

/** Places a release inside a clone install, and removes the clone where nothing in it is the human's. */
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
  // Always the release's own runner: one built from this clone would place the clone's source.
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
/** What an install leaves ignored in its clone that is Collie's, or `user/`. */
const INSTALL_IGNORED = ["bin/", "node_modules/", "user/", "release/", "kept/"];

/** What in a clone is the human's, one line per kind; empty where nothing is. */
const humansIn = Effect.fn("operations.humansIn")(function* (
  root: string,
  live: Effect.Effect<ReadonlyArray<string> | null, never, PlatformServices>,
  run: Runner<ChildProcessSpawner.ChildProcessSpawner>,
) {
  const git = (...args: string[]) => run("git", args, root);
  const said = (result: { code: number; stdout: string }) =>
    result.code === 0 ? Str.trim(result.stdout) : null;
  const found: string[] = [];

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

/** Long enough for another placement to finish; claims are 25ms apart. */
const PLACING_CLAIMS = 2_400;

/** `placeRelease`, one placement at a time per Collie directory. */
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

/** Places the release this runner carries, then prepares it. */
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
  const hc = yield* placeHc(env, root, is[BUNDLED_HC] ?? null, run);
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

/** What placing a release did, as a human reads it. */
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

/**
 * Hands the upgrade to `target`'s runner, once it verifies, and reports what it did as this
 * upgrade's own. Nothing is replaced unless that runner runs.
 */
const handOff = Effect.fn("operations.handOff")(function* (
  env: PluginEnv,
  target: string,
  source: string,
  key: string | undefined,
  run: Runner<ChildProcessSpawner.ChildProcessSpawner>,
  /** The installation the release's runner upgrades, where it is not this one. */
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
      `HERDR_PLUGIN_ROOT=${pluginRoot}`,
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

/** What each preparation step did, rather than the install's own output. */
const stepLines = (steps: ReadonlyArray<{ step: string; state: string; detail: string }>) =>
  Arr.map(
    steps,
    (step) =>
      `  ${pipe(step.step, Str.padEnd(16))}${step.state}${step.detail ? ` — ${step.detail}` : ""}`,
  );

/** `prepare.sh` in `root`, then the Desktop step, as report lines. */
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
  // Loaded here: of every front door, only an upgrade reaches Desktop.
  const { dataHomeOf, updateDesktop } = yield* Effect.promise(() => import("./desktop"));
  const desktop = yield* updateDesktop(to ?? (yield* manifestField(root, "version")), {
    dataHome: dataHomeOf(env.home, env.raw.XDG_DATA_HOME),
  });
  const steps = [...prepareSteps(installed.stdout), ...(desktop === null ? [] : [desktop])];
  return { ok: true as const, steps };
});

/**
 * What `prepare.sh` reported, one line per step. Anything else it printed — the
 * install's own output, a stack of npm notices — is not part of the answer.
 *
 * This is one half of a contract whose other half is a `printf` in a shell script,
 * so it is exported for the test that runs the real script and reads its output back
 * through here: a step line reworded on one side and not the other would otherwise
 * empty this report with nothing failing.
 */
const PREPARE_LINE = /^prepare: ([a-z-]+): (done|already in place|skipped|failed)(?: — (.*))?$/;

export function prepareSteps(
  output: string,
): Array<{ step: string; state: string; detail: string }> {
  return Arr.flatMap(Str.split(output, "\n"), (line) => {
    const match = PREPARE_LINE.exec(Str.trim(line));
    return match ? [{ step: match[1]!, state: match[2]!, detail: match[3] ?? "" }] : [];
  });
}

/** `git rev-parse` prints one line; anything else means it did not answer. */
function short(result: { code: number; stdout: string }): string {
  return result.code === 0 ? Str.trim(result.stdout) : "";
}

/**
 * The Task a start belongs to, and the herdr workspace its Runs and agents live in.
 *
 * A fresh start gets a workspace of its own, whatever workspace it was launched from:
 * that is what keeps one human's several pieces of work from accumulating beside each
 * other. It is only named here. The host opens it at admission, on the checkout the Run
 * is given, and the Task's first agent takes over the shell it comes with; a stop that
 * would close the workspace's last pane leaves a shell there first, since herdr drops a
 * workspace with its last pane.
 *
 * A continuation is given its Task, and goes where that Task already is. Membership is
 * the record, never the label: two Tasks may be called much the same thing, and a
 * workspace a human renamed is still the Task's.
 *
 * Started from outside herdr, a Run has no workspace to be opened from, and one that
 * starts no agent needs none: it gets no Task rather than a refusal.
 */
export const taskFor = Effect.fn("operations.taskFor")(function* (
  env: PluginEnv,
  choice: TaskChoice,
  about: StartAbout,
) {
  const kept = (task: TaskRecord | null, label: string | null = null) => ({
    _tag: "Ok" as const,
    task,
    /** What a fresh Task's workspace is to be called, where this start opens one. */
    label,
  });
  if (choice.mode === "here") return yield* taskHere(env, about);
  if (
    env.workspaceId === null &&
    env.socketPath === null &&
    env.machine === undefined &&
    env.asker?.from?.machine === undefined
  )
    return kept(choice.mode === "continue" ? choice.task : null);
  // A workspace cleanup closed is reopened on the Run's checkout when its first agent starts.
  if (choice.mode === "continue") return kept(choice.task);
  return kept(null, yield* freshTaskLabel(env, about));
});

/**
 * The workspace this was started from, as the Task the Run belongs to: the Task already
 * kept there, or a new one kept there. Its checkout is still cut; only the workspace a new
 * Task would have opened is not, so the Run's agents open beside whoever started it.
 */
const taskHere = Effect.fn("operations.taskHere")(function* (env: PluginEnv, about: StartAbout) {
  if (env.workspaceId === null)
    return {
      _tag: "Rejected" as const,
      result: err(
        "workspace_required",
        "--here keeps the Run in the herdr workspace it was started from, and this was started outside one.",
      ),
    };
  const kept = yield* taskOfWorkspace(env.stateDir, env.workspaceId);
  if (kept !== null) return { _tag: "Ok" as const, task: kept, label: null };
  const open = yield* new Herdr(env)
    .workspaceList()
    .pipe(Effect.orElseSucceed((): WorkspaceInfo[] => []));
  const task = yield* newTask({
    herd: yield* machineHerd(env).pipe(Effect.orElseSucceed(() => null)),
    workspace: env.workspaceId,
    label:
      Option.getOrUndefined(Arr.findFirst(open, (one) => one.workspaceId === env.workspaceId))
        ?.label ??
      (workNamedIn(about.inputs) || about.workflow),
    cwd: env.cwd,
  });
  yield* writeTask(env.stateDir, task);
  return { _tag: "Ok" as const, task, label: null };
});

export const clearOverride = Effect.fn("operations.clearOverride")(function* (
  stateDir: string,
  herdr: Herdr,
  runId: string,
  agent: string,
  /** Who is lifting it, as `actorName` writes it. Derived at the front door, never here. */
  by: string,
  voice: Voice = {},
) {
  const live: AgentInfo[] = yield* herdr.agentList().pipe(Effect.orElseSucceed(() => []));
  const terminalId =
    Option.getOrUndefined(Arr.findFirst(live, (a) => a.name === agent))?.terminalId ?? null;
  if (terminalId === null)
    return err("invalid_state", `herdr has no live agent "${agent}" to clear an override on.`);
  const file = yield* ledgerPath(stateDir, terminalId);
  if (!overrideActive(yield* readLedger(file)))
    return err("invalid_state", `"${agent}" is not under a manual override.`);
  yield* appendLine(file, {
    kind: "override_cleared",
    at: yield* nowIso,
    incarnation: terminalId,
    by,
    ...voice,
  });
  return ok({ runId, agent }, `Cleared the manual override on ${agent}.`);
});

/**
 * Carrying out a Confirmation: the one place a proposal's actions run, whichever front
 * door said yes. The front door derives who is asking and renders what came back; it does
 * not decide what is checked first, because a second copy of this loop is a second policy
 * on what a confirmed action is still allowed to assume.
 */
/**
 * Which live process each agent a delivery names is now. Recorded with the proposal so a
 * confirmation can refuse rather than deliver to whatever took that agent's name since.
 */
/**
 * A structured request from native chat, validated and executed in the same call.
 *
 * This is the whole of what chat may *do*, and it is deliberately the same path a steer
 * takes from the point the actions exist: the closed `ActionSchema`, `validate`, and the
 * proposals journal. What it does not do is ask a second model what the first one meant —
 * the native agent already expressed this structurally, and paying a model to re-read it
 * would be two interpretations of one request.
 *
 * The journal and stale-target checks are shared with optional proposals. Attribution
 * stays with the chat request; no terminal or second human confirmation is required.
 */
export const request = Effect.fn("operations.request")(function* (
  env: PluginEnv,
  herdKey: string,
  options: {
    readonly interpretation: string;
    readonly actions: ReadonlyArray<Action>;
    /** Who asked. Stamped by the entrypoint, never read out of the request. */
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
    // Refused, not retargeted. A Run nobody has is a request about nothing, and guessing
    // which one was meant is how an action lands on somebody else's work.
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

  const registered = yield* everyRegistered(env.stateDir);
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

  const file = yield* proposalsPath(env.stateDir, herdKey);
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

/** The tree a card was written against, as the one string a confirmation compares. */
function revisionOf(revision: { readonly head_sha: string; readonly fingerprint: string }): string {
  return `${revision.head_sha}:${revision.fingerprint}`;
}

/**
 * The card a steer named, with the revision it was written against — or null when none was
 * named or no card has that id. Binding it is what lets a confirmation say `revision_moved`
 * instead of applying a decision about one tree to a different one (SPEC §7.6).
 */
const cardRevision = Effect.fn("operations.cardRevision")(function* (
  run: RunFacts,
  id: string | null,
) {
  if (id === null) return null;
  const cards = yield* readCards(run.dir).pipe(Effect.orElseSucceed(() => []));
  const card = Option.getOrUndefined(Arr.findFirst(cards, (entry) => entry.id === id));
  // A card nobody has is not an unbound proposal: the human asked about a specific piece
  // of work, and answering about the tree in general is answering a different question.
  return card === undefined ? "unknown" : { id, revision: revisionOf(card.revision) };
});

/**
 * What one evaluation is allowed to cost, and what it is asked with. Conservative: the
 * Herd's cap and the Run's own cap bound this again, and a front door never chooses its
 * own budget — a board and a terminal that disagreed about what Collie may spend would be
 * two policies wearing one name.
 */
export const steer = Effect.fn("operations.steer")(function* (
  env: PluginEnv,
  deps: {
    readonly herdKey: string;
    readonly evaluator: EvaluatorDeps;
    readonly limits: EvaluatorLimits;
  },
  options: {
    readonly text: string;
    /** The Run this is about. Required for anything that would change something. */
    readonly target?: string | null;
    readonly from?: string | null;
    readonly dryRun?: boolean;
    readonly requestId: string;
    /** The front door that asked, which the proposal is carried out as. */
    readonly origin?: FrontDoor;
    /**
     * Who is asking. `event` is the board speaking first about something that changed;
     * the question is journaled as that, never as the human's words. It changes what the
     * conversation shows. Unsolicited event suggestions stay proposals.
     */
    readonly asked?: "human" | "event";
  },
) {
  const target = options.target ?? null;
  const known = yield* listRuns(env);
  const run =
    target === null
      ? null
      : (Option.getOrUndefined(Arr.findFirst(known, (one) => one.id === target)) ?? null);
  // A steer is about one Run. A question about the flock is native chat's, which reads
  // the Herd rather than having a model asked one here — and a Run is never guessed at
  // from the words, so there is nothing to fall back to.
  if (target === null)
    return err("invalid_input", "Name the Run this is about with --target.", {
      code: "target_required",
    });
  if (run === null) return err("run_not_found", `No Run "${target}".`, { run: target });
  // A retry asks nobody again: a second answer could order the same actions differently.
  if (options.dryRun !== true && options.asked !== "event") {
    const before = yield* carriedBefore(
      yield* proposalsPath(env.stateDir, deps.herdKey),
      options.requestId,
    );
    if (before !== null) return before;
  }

  const journal = yield* conversationPath(env.stateDir, deps.herdKey);
  const roots = Arr.map(known, (r) => r.dir);
  const said: NewTurn = { role: options.asked ?? "human", text: options.text };
  yield* append(journal, { ...said, target }, roots);

  const from = options.from ?? null;
  const pack = yield* evidencePack(env, options.text, run, from, journal);

  // An Intent nobody can decode is not a Run with no constraints. Recorded as `{}`, the
  // proposal would skip the version gate at every later confirmation (SPEC §7.1). Read
  // before the call rather than after it: a Run whose Intent cannot be read is one no
  // proposal can be made about, and finding that out afterwards spends the money first.
  const intent = yield* readIntent(run.dir).pipe(Effect.orElseSucceed(() => "unreadable" as const));
  if (intent === "unreadable")
    return err("invalid_state", `${run.id}'s Intent cannot be read; nothing was proposed.`);

  // Written down as usage — the Herd's, and the Run's where there is one — before the
  // call and after it. Never refused over a count: usage is data, not a quota.
  const budget = yield* budgetPath(env.stateDir, deps.herdKey);
  const callId = yield* newRequestId();
  yield* reserve(budget, { id: callId, run: run.id }, deps.limits);

  const asked = yield* evaluate(deps.evaluator, "proposal", pack);
  // What the call did: a timeout and an output cap are their own facts, and this is the
  // only place either is written down. An unusable answer is `failed` — the call was not ok.
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
    agents: new Map([[run.id, agentsOf(yield* everyRegistered(env.stateDir), run.id)]]),
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

  const file = yield* proposalsPath(env.stateDir, deps.herdKey);
  const bound = yield* cardRevision(run, from);
  if (bound === "unknown")
    return err("invalid_input", `Run ${run.id} has no card "${from}".`, { card: from ?? "" });
  const proposal: Recorded = {
    interpretation: proposed.interpretation,
    targets: [{ run: run.id }],
    actions: Arr.map(checked, (entry) => entry.action),
    // A requested action is separate from the Driver's standing authority.
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

function previewOf(interpretation: string, checked: ReadonlyArray<Validated>): string {
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

/**
 * What the evaluator is shown. Compact Herd facts, then the target's own record — and
 * never a worker's terminal transcript: what an agent is doing reaches this as herdr's
 * own status and title, and no further.
 */
/**
 * How much of the Herd and of the conversation one question carries. Both are caps on a
 * prompt, not policy: a Herd with two hundred Runs must not produce a two-hundred-Run
 * prompt, and a conversation that has run all week must not be re-sent whole.
 */
const HERD_LINES = 40;
const TURNS_IN_CONTEXT = 20;
/** How many of a Run's newest cards a detail read carries. */
const CARDS_IN_CONTEXT = 3;

/**
 * Every Run in the Herd, bounded, with what was left out named.
 *
 * The Herd's, never a workspace's and never the Selection's: a board filter is what a
 * human is looking at, and a filter that decided what could be *read* would hide work by
 * hiding a row. Bounded and saying so, because a model told about forty of two hundred
 * Runs and not told so answers "that is all of them" in good faith.
 *
 * Shared: the evidence pack below and the tools native chat calls both read this, so
 * Collie and the row a human is looking at cannot tell different stories about one Run.
 */

/**
 * What the human said, and what Collie makes of it — as a proposal nobody has acted on.
 *
 * A steer is a question, never a command. Even where a Run has granted Collie authority
 * to correct its own drift, a proposal that came out of a conversation is `pending`: the
 * grant was for the Driver's own checks, and "the human was talking about it" is not the
 * same as "the human asked for it". That is what `allowedNow: []` below is.
 */
export const herdFacts = Effect.fn("operations.herdFacts")(function* (env: PluginEnv) {
  const runs = yield* listRuns(env);
  const registered = yield* everyRegistered(env.stateDir);
  const listed = runs.slice(0, HERD_LINES);
  const lines: string[] = [];
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
  // An empty answer is not an answer: a Herd with no Runs says so, rather than handing
  // the model nothing to read.
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

/** The agents registered for one Run, by name. */
const agentsOf = (registered: ReadonlyArray<AgentEntry>, run: string): Set<string> =>
  new Set(
    Arr.map(
      Arr.filter(registered, (entry) => entry.runId === run),
      (entry) => entry.agent,
    ),
  );

/** How much of a Run's own record one detail read carries. */
const ANSWERS_IN_CONTEXT = 5;
const FINDINGS_IN_CONTEXT = 10;
const LOG_LINES_IN_CONTEXT = 5;
const LOG_LINE_CHARS = 200;
const LOG_TAIL_BYTES = 16 * 1024;

const actionText = flow(
  Schema.encodeResult(Schema.fromJsonString(ActionSchema)),
  Result.getOrThrow,
);

/** The `collie_do` action that answers `choiceId` on `run`. */
export const answerAction = (run: string, choiceId: string, answer: string): string =>
  actionText({ kind: "answer", run, choiceId, answer });

/** The Choice a Run is waiting on, every option, and the `collie_do` action that answers it. */
export const choiceLines = (run: string, asked: Asked): string[] => [
  `Waiting on the Choice "${asked.name}": ${asked.prompt}`,
  asked.options.length === 0
    ? "It has no options: it is answered in words."
    : `Options: ${Arr.join(asked.options, " | ")}`,
  `Answer it with the collie_do action ${answerAction(
    run,
    asked.name,
    asked.options.length === 0 ? "<their words>" : "<one of the options>",
  )}`,
];

const decodeAnswered = Schema.decodeUnknownOption(Answered);

/** Who an answer came from, in the words a human uses for the place they answered. */
const answererOf = (actor: AuditLine["actor"]): string => {
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

/** Each answered Choice, newest first, with who answered it and when as the audit trail has it. */
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

/** Its merge request with what the host's merge watch last recorded of it, and its branch. */
const mergeLines = Effect.fn("operations.mergeLines")(function* (env: PluginEnv, run: RunFacts) {
  const lines = run.branch === null ? [] : [`Branch: ${run.branch}`];
  if (run.mr === null) return lines;
  const watched = yield* watchedOf(env);
  const noun = mrNounOf(run.mr);
  return [
    `${Str.toUpperCase(noun[0]!)}${pipe(noun, Str.slice(1))}: ${run.mr} — ${watched(mrLabel(run.mr))}`,
    ...lines,
  ];
});

/** What the host's merge watch last recorded of a merge request, by its label. */
const watchedOf = Effect.fn("operations.watchedOf")(function* (env: PluginEnv) {
  const states = yield* readMrStates(env.stateDir);
  const forge = yield* readForge(env.stateDir);
  return (label: string) => {
    const state = states.get(label);
    const checks = forge.get(label)?.checks;
    return state === undefined
      ? "not watched"
      : `${state}, checks ${checks === undefined ? "not recorded" : checks.state === "failed" ? `failed (${checks.name})` : checks.state}`;
  };
});

/** The Run's own plan directory and how many tickets it holds. */
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

/** What the review found, what became of the work and what the Run has to prove. */
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

/** The last lines its log recorded, each cut short, leaving out one that only repeats the result. */
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

/**
 * One Run in the detail a next action turns on: what it is for, what bounds it, what it
 * is asking, what it has produced and where it has drifted. The same read the evidence
 * pack embeds, so a detail asked for in chat is the detail a proposal was made from.
 */
export const runFacts = Effect.fn("operations.runFacts")(function* (
  env: PluginEnv,
  run: RunFacts,
  listed?: ReadonlyArray<RunFacts>,
) {
  const intent = yield* readIntent(run.dir).pipe(Effect.orElseSucceed(() => null));
  const attention = yield* attentionFor(run);
  const started = Arr.filter(listed ?? (yield* listRuns(env)), (one) => one.parent === run.id);
  const agents = yield* runAgents(env.stateDir, run.id);
  const watched = yield* watchedOf(env);
  const lines = [
    `Status: ${run.state}`,
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
          ...Arr.map(
            started,
            (one) =>
              `- run ${one.id}: ${one.workflow}, ${one.state}${one.mr === null ? "" : `; ${mrLabel(one.mr)} ${watched(mrLabel(one.mr))}`}`,
          ),
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
  return Str.trimEnd(pipe(Arr.join(lines, "\n"), Str.replace(/\n{3,}/g, "\n\n")));
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

  // Everything said in this Herd, whatever it was about. Without this an untargeted
  // question is asked with no memory of the conversation it belongs to, so a follow-up
  // like "what about the second one" has nothing to resolve — which is why the global
  // Collie could not hold a conversation at all.
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

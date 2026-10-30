// `collie doctor`: every prerequisite that is not the runner, checked in one pass,
// each with the command that fixes it. Everything here used to fail at its own
// point deep inside a Run — a harness that is not installed, a `glab` that is not
// logged in, a shim whose directory is not on PATH — which a teammate discovered one
// failed Run at a time.
//
// Two ways of asking, and the difference is deliberate: whether an executable is
// there is answered by walking PATH, which cannot hang and needs nothing stubbed;
// what it *says* — a version, a login — is answered by running it. herdr itself is
// asked through `src/herdr.ts` like everything else, and at `HERDR_BIN_PATH`: inside
// a pane that is the herdr this plugin will actually talk to, and it need not be on
// PATH at all.

import * as Str from "effect/String";
import { pipe } from "effect/Function";
import * as Arr from "effect/Array";
import { Clock, Effect, FileSystem, Option, Path, Schema } from "effect";
import type { ChildProcessSpawner } from "effect/process";
import { loadDefaults } from "./config";
import { savedModules } from "./discovery";
import { layers, loadDefinitions, skillDirs, skillFile } from "./definitions";
import type { PluginEnv } from "./env";
import { HARNESSES } from "./harness";
import { Herdr } from "./herdr";
import { shell, type Runner } from "./mr";
import { isCheckout, manifestField } from "./release";
import { isNewer, newestRelease, releasesOf } from "./releases";
import manifest from "../herdr-plugin.toml";
import { err } from "./operations";
import type { ConnectionReading } from "./connection-model";
import { connectionProbes, readConnections } from "./connections";
import { projectsRoot } from "./projects";
import { claudeSettingsPath, readStatusLine, STATUS_LINE_ARGS } from "./statusline";
import { humanBytes } from "./bytes";
import { collieCache } from "./cleanup";
import { anyRuns, cleanupListing, machineList } from "./lifecycle";
import { peersOf } from "./peers";
import { HERDLESS, herdOfHost } from "./host";
import { tmpdir } from "node:os";
import { machineMemory, memorySaid, type Memory } from "./memory";
import {
  FETCH_LIMIT,
  answered,
  failed,
  jsonIn,
  noted,
  onPath,
  passed,
  runnable,
  warned,
  type Check,
  type Outcome,
} from "./doctor-check";
import { gitlabChecks } from "./forge/gitlab-checks";
import { githubChecks } from "./forge/github-checks";

export type { Check } from "./doctor-check";
export { onPath } from "./doctor-check";

/** An optional integration, as doctor reports it: absent is a note, broken is a warning. */
const optional = (probe: ConnectionReading): Outcome =>
  probe.state === "ok"
    ? passed(probe.detail)
    : probe.state === "absent"
      ? noted(probe.detail, probe.fix)
      : warned(probe.detail, probe.fix);

const VERSION = /\d+\.\d+\.\d+/;
const isString = Schema.is(Schema.String);

/**
 * Where this herdr is, or null: an absolute `HERDR_BIN_PATH` is a file to look for,
 * a bare name is one to find on PATH.
 */
const located = Effect.fn("Doctor.located")(function* (search: string, bin: string) {
  if (!pipe(bin, Str.includes("/"))) return yield* onPath(search, bin);
  return (yield* runnable(bin)) ? bin : null;
});

/**
 * From here on `herdr update` leaves a running server and its panes alone. herdr 0.9.0's
 * release note: "Servers older than endpoint generation 1 need a one-time upgrade."
 */
const PANES_SURVIVE_UPDATE = "0.9.0";
const BY_PACKAGE_MANAGER = "or upgrade herdr with the package manager that installed it";
const RESTART_SERVER =
  "restart the server (`herdr server stop`, then `herdr`) when nothing is running, to give Collie what it needs";
const RESTART_OLD_SERVER = `${RESTART_SERVER} — ${BY_PACKAGE_MANAGER}`;

/** What upgrading a herdr client at `version` to `min` does to the panes its server runs. */
const upgradeAdvice = (version: string, min: string): string =>
  older(version, PANES_SURVIVE_UPDATE)
    ? `Moving from herdr ${version} to ${min} needs your running herdr server stopped once, which ends every program in its panes. Do it when nothing is running there: \`herdr update\`, then \`herdr server stop\`, then start \`herdr\`. \`herdr update --handoff\` tries to carry the panes across instead; herdr calls it experimental — ${BY_PACKAGE_MANAGER}`
    : `\`herdr update\` installs ${min} and leaves your running server and its panes alone; ${RESTART_OLD_SERVER}`;

/** `1.10.0` is newer than `1.9.0`; a string comparison would disagree. */
function older(version: string, than: string): boolean {
  const parts = (v: string) => Arr.map(Str.split(v, "."), (n) => Number(n) || 0);
  const [a, b] = [parts(version), parts(than)];
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const [left, right] = [a[i] ?? 0, b[i] ?? 0];
    if (left !== right) return left < right;
  }
  return false;
}

/**
 * What this machine needs to run work: the skills the operator's own guidance names, and
 * every harness the defaults may route an agent to. A workflow is a module now, so what
 * it asks for is TypeScript rather than a list to read — what is checked here is what an
 * installation needs whatever its workflows turn out to want.
 */
const asked = Effect.fn("Doctor.asked")(function* (env: PluginEnv) {
  const defaults = yield* loadDefaults(env.userDir);
  // Every harness a Run could be routed to: the default, and anything a variant may
  // name. A module decides its own at runtime, so what is checked is what the machine
  // would need whichever it picks.
  return { harnesses: [defaults.harness] };
});

/**
 * A fetch that can only succeed or give up. No prompt of any kind can come out of
 * it: an SSH passphrase or an HTTPS credential prompt would be asked by a process
 * the human cannot see, reading from the terminal the Control Plane is taking keys
 * from. And it is bounded, so a remote that hangs does not hang `collie doctor` or
 * the install that ends in it.
 *
 * The settings ride along as arguments rather than as this process's environment,
 * because that environment is inherited by every agent Collie starts.
 */
const FETCH = [
  "GIT_TERMINAL_PROMPT=0",
  "GIT_ASKPASS=",
  "git",
  "-c",
  "credential.helper=",
  "-c",
  "core.sshCommand=ssh -oBatchMode=yes -oConnectTimeout=5",
  "fetch",
  "--quiet",
];

const fetchRemote = (root: string, run: Runner<ChildProcessSpawner.ChildProcessSpawner>) =>
  Effect.timeoutOption(run("env", FETCH, root), FETCH_LIMIT);

/**
 * How many commits this installation's checkout is behind its upstream, or null when
 * there is nothing to say: an installation that is not a checkout, a branch with no
 * upstream, or a git that would not answer. Absent rather than alarming — a warning
 * about a state nobody can act on is worse than no line at all.
 *
 * A fetch is the only thing that changes this answer, and the only part of it that
 * touches the network. So there are two ways in, one per caller: the Control Plane
 * calls `behindRemote`, which counts against the remote-tracking ref — local, and
 * never waiting on a remote, because the board redraws every second and a half —
 * and starts a fetch *behind* that at most every few minutes, whose result the next
 * count picks up. `collie doctor` calls `refreshBehind`, which fetches and waits,
 * because a human waiting on a command can afford it.
 *
 * A fetch that fails or times out changes nothing: the count is what the refs on
 * this machine say, which stays true whether or not the remote could be reached.
 */
const FETCH_EVERY_MS = 5 * 60_000;
/**
 * How long a count stands before it is asked again. The board would otherwise spawn
 * a `git` every redraw — some thousands an hour for one open pane — to re-read refs
 * that change only when something fetches or pulls. Short enough that an upgrade in
 * another terminal shows up while the human is still looking at the board.
 */
const COUNT_FOR_MS = 30_000;

/** What this process already knows about one installation, and when it learned it. */
interface Known {
  fetchedAt: number;
  countedAt: number;
  behind: number | null;
}
const known = new Map<string, Known>();
const knownOf = (root: string): Known =>
  known.get(root) ?? { fetchedAt: 0, countedAt: 0, behind: null };

export const behindRemote = Effect.fn("Doctor.behindRemote")(function* (
  root: string,
  run: Runner<ChildProcessSpawner.ChildProcessSpawner> = shell,
  /** The board builds against one clock reading; both windows below are measured on it. */
  at?: number,
) {
  const now = at ?? (yield* Clock.currentTimeMillis);
  const seen = knownOf(root);
  if (now - seen.fetchedAt >= FETCH_EVERY_MS) {
    known.set(root, { ...seen, fetchedAt: now });
    yield* Effect.forkDetach(fetchRemote(root, run));
  }
  if (seen.countedAt !== 0 && now - seen.countedAt < COUNT_FOR_MS) return seen.behind;
  return yield* count(root, run, now);
});

export const refreshBehind = Effect.fn("Doctor.refreshBehind")(function* (
  root: string,
  run: Runner<ChildProcessSpawner.ChildProcessSpawner>,
) {
  const now = yield* Clock.currentTimeMillis;
  known.set(root, { ...knownOf(root), fetchedAt: now });
  yield* fetchRemote(root, run);
  return yield* count(root, run, now);
});

/** What the refs on this machine say, remembered only for as long as `COUNT_FOR_MS`. */
const count = Effect.fn("Doctor.count")(function* (
  root: string,
  run: Runner<ChildProcessSpawner.ChildProcessSpawner>,
  now: number,
) {
  const answer = yield* run("git", ["rev-list", "--count", "HEAD..@{upstream}"], root);
  const number = Str.trim(answer.stdout);
  const behind = answer.code === 0 && /^\d+$/.test(number) ? Number(number) : null;
  known.set(root, { ...knownOf(root), countedAt: now, behind });
  return behind;
});

/**
 * What this machine answers a workflow id with, where that is not what Collie ships. A
 * customisation is the operator's, so it is named and never judged: nothing here knows
 * what any workflow is supposed to contain, and an id it recognised would be the start
 * of a shipped workflow being privileged over one somebody wrote.
 *
 * A file that claims an id and will not load is the exception, because it answers for
 * that id and cannot run — the layer below it is not consulted.
 */
const overrides = Effect.fn("Doctor.overrides")(function* (env: PluginEnv) {
  const saved = yield* savedModules(env);
  const own = Arr.map(
    Arr.filter(saved.entries, (one) => one.layer !== "shipped"),
    (one) => `${one.id} (${one.layer}, ${one.path})`,
  ).sort();
  if (saved.problems.length > 0) {
    return noted(
      Arr.join(
        Arr.map(saved.problems, (one) => `${one.id}: ${one.message}`),
        "; ",
      ),
      `fix ${Arr.join(
        Arr.map(saved.problems, (one) => one.path),
        " and ",
      )}, or delete it to take the workflow below it`,
    );
  }
  return own.length === 0
    ? passed("every workflow here is the one Collie ships")
    : passed(`overridden here: ${Arr.join(own, "; ")}`);
});

/**
 * Every persona the layers define, read as a launch reads it: one that will not parse, or
 * that names anything but a skill, is named with why.
 */
const personas = Effect.fn("Doctor.personas")(function* (env: PluginEnv) {
  const found = yield* loadDefinitions(yield* layers(env));
  return found.errors.length === 0
    ? passed(`${found.personas.size} read, each one telling its agent only what it can fill`)
    : noted(Arr.join(found.errors, "; "), "fix each file named");
});

/** Where a Run started from the Home is rooted, and which of the three places said so. */
const projects = Effect.fn("Doctor.projects")(function* (env: PluginEnv) {
  const root = yield* projectsRoot(env);
  if (root.source === "config") return passed(`${root.path} (from projects.root)`);
  if (root.source === "gitte") return passed(`${root.path} (from GITTE_CWD)`);
  return warned(
    `${root.path} (the home directory: neither projects.root nor GITTE_CWD is set)`,
    `set projects.root in ${env.userDir}/config.json to the folder your checkouts live under`,
  );
});

const ClaudeStatus = Schema.fromJsonString(Schema.Struct({ loggedIn: Schema.Boolean }));

/**
 * Every check, in one pass, whatever the state of the machine: a prerequisite that
 * is missing must not stop the ones after it from being reported, or `doctor` is one
 * failed Run at a time again.
 */
export const doctor = Effect.fn("Doctor.doctor")(function* (
  env: PluginEnv,
  run: Runner<ChildProcessSpawner.ChildProcessSpawner> = shell,
  herdr: Herdr = new Herdr(env),
) {
  const path = yield* Path.Path;
  const root = env.pluginRoot;
  const search = env.raw["PATH"] ?? "";
  const checks: Check[] = [];

  // What the plugin manifest says it needs of herdr.
  const min = yield* manifestField(root, "min_herdr_version");
  const herdrBin = yield* located(search, env.binPath);
  // `cli` parses JSON where herdr answers with it; these two answer in plain text,
  // and anything else is as good as no answer.
  const text = (args: string[]) =>
    herdr.cli(args).pipe(
      Effect.map((answer) => (isString(answer) ? answer : "")),
      Effect.orElseSucceed(() => ""),
    );
  const said = herdrBin ? yield* text(["--version"]) : "";
  const version = VERSION.exec(said)?.[0] ?? "";
  const stale = version !== "" && min !== "" && older(version, min);
  checks.push({
    name: "herdr",
    ...(!herdrBin
      ? failed("not installed", "install herdr — https://herdr.dev/docs/install/")
      : stale
        ? failed(
            `${version} is older than the ${min} this plugin needs`,
            upgradeAdvice(version, min),
          )
        : passed(version || "installed")),
  });

  // A stale client's advice already covers its server.
  const server =
    herdrBin && !stale
      ? yield* herdr.serverInfo().pipe(Effect.option, Effect.map(Option.getOrNull))
      : null;
  if (server?.running) {
    const serverVersion = VERSION.exec(server.version)?.[0] ?? "";
    checks.push({
      name: "herdr server",
      ...(serverVersion === ""
        ? failed("the running server is too old to say its version", RESTART_OLD_SERVER)
        : min !== "" && older(serverVersion, min)
          ? failed(
              `the running server is ${serverVersion}, older than the ${min} this plugin needs`,
              RESTART_OLD_SERVER,
            )
          : passed(serverVersion)),
    });
  }

  const linked = herdrBin ? yield* text(["plugin", "list"]) : "";
  checks.push({
    name: "plugin",
    ...(linked.includes(`[local:${root}]`)
      ? passed(`linked from ${root}`)
      : failed(
          herdrBin ? `not linked from ${root}` : "herdr is not installed, so nothing can be linked",
          `herdr plugin link ${root}`,
        )),
  });

  checks.push({
    name: "runner",
    // Runnable, not merely there: the shim `exec`s this, so a `bin/collie` without
    // its executable bit is the same permission-denied mystery as a shim without one.
    ...((yield* runnable(path.join(root, "bin", "collie")))
      ? passed(`${root}/bin/collie`)
      : failed("not built", `sh ${root}/prepare.sh`)),
  });

  // The shim and its directory are two states, not one: "installed but not on PATH"
  // is the one that otherwise reads as a mystery.
  const shimDir = yield* onPath(search, "collie");
  const binDir = env.raw["COLLIE_BIN_DIR"] ?? path.join(env.home, ".local", "bin");
  // Runnable here too: a shim that exists without its bit is not "installed but not
  // on PATH" — putting that directory on PATH would not fix it, and rewriting the
  // shim would, which is what falling through to "not installed" tells you to do.
  const offPath = shimDir === null && (yield* runnable(path.join(binDir, "collie")));
  checks.push({
    name: "collie on PATH",
    ...(shimDir
      ? passed(`${shimDir}/collie`)
      : offPath
        ? failed(
            `${binDir}/collie is installed, but ${binDir} is not on PATH`,
            `add ${binDir} to your PATH`,
          )
        : failed("not installed", `sh ${root}/prepare.sh`)),
  });

  const needs = yield* asked(env);
  const dirs = yield* skillDirs(env);
  // What a module asks an agent for is decided while it runs, so there is no list to
  // check against: what this says is whether the store is there at all, and the routine
  // that fills it. The sources, the global store and the Claude Code target are
  // `prepare.sh`'s to know.
  checks.push({
    name: "skills",
    ...((yield* skillFile(dirs, "collie")) !== null
      ? passed(`the skill store is in place (${Arr.join(dirs, ", ")})`)
      : failed("the operator skill is not installed", `sh ${root}/prepare.sh`)),
  });

  const absent: string[] = [];
  for (const harness of needs.harnesses) {
    const kind = HARNESSES[harness]?.kind ?? harness;
    if ((yield* onPath(search, kind)) === null) absent.push(kind);
  }
  checks.push({
    name: "harnesses",
    ...(absent.length === 0
      ? passed(`${needs.harnesses.length} installed`)
      : failed(
          `not installed: ${Arr.join(absent, ", ")}`,
          `install the harness CLI: ${Arr.join(absent, ", ")}`,
        )),
  });

  if ((yield* onPath(search, "claude")) !== null) {
    const status = yield* answered(run("claude", ["auth", "status", "--json"], root));
    const login = Schema.decodeOption(ClaudeStatus)(jsonIn(status.stdout));
    checks.push({
      name: "claude login",
      ...(Option.isSome(login) && login.value.loggedIn
        ? passed("Claude Code is logged in")
        : status.code === 124
          ? failed(`did not answer within ${FETCH_LIMIT}`, "claude auth status")
          : failed("Claude Code is not logged in", "claude auth login")),
    });
  }

  // Reported, never failed: the board and every Run work without it, and a machine that
  // is otherwise ready must not exit non-zero over a line under a prompt.
  const line = yield* readStatusLine(env);
  const settings = yield* claudeSettingsPath(env);
  const install = `collie ${Arr.join(STATUS_LINE_ARGS, " ")} --install`;
  checks.push({
    name: "status line",
    ...(line.kind === "ours"
      ? passed(
          "Claude Code prints the board's selection under the chat prompt, the same fact chat is told at each prompt",
        )
      : line.kind === "theirs"
        ? noted(
            `Claude Code prints a status line of its own (${line.command}), so the board's selection is not under the chat prompt`,
            `to show it instead, set statusLine.command in ${settings} to what \`${install}\` would write`,
          )
        : noted(`not configured in ${settings}`, install)),
  });

  const gitDir = yield* onPath(search, "git");
  const checkout = gitDir !== null && (yield* isCheckout(root, run));
  const behind = checkout ? yield* refreshBehind(root, run) : null;
  const newest = checkout ? null : yield* newestRelease(releasesOf(env.raw));
  checks.push({
    name: "up to date",
    // Passing even when it is behind: an installation a release or a few commits back is
    // a thing to say, not a missing prerequisite, and the same line on the Control Plane is
    // shown rather than sent for the same reason. It still carries the command.
    ...(checkout
      ? behind === null
        ? passed("a checkout with no remote, so there is nothing to compare")
        : behind === 0
          ? passed("level with its remote")
          : noted(`${behind} commit${behind === 1 ? "" : "s"} behind its remote`, "collie upgrade")
      : isNewer(newest, manifest.version)
        ? noted(`Collie ${newest} is out`, "collie upgrade")
        : passed(
            newest === null
              ? "the newest release could not be read, so there is nothing to compare"
              : `Collie ${manifest.version} is the newest release`,
          )),
  });

  checks.push({ name: "workflows", ...(yield* overrides(env)) });
  checks.push({ name: "personas", ...(yield* personas(env)) });
  checks.push({ name: "projects root", ...(yield* projects(env)) });
  if ((yield* peersOf(env.stateDir)).length > 0) {
    const links = yield* machineList(env);
    const views = links.ok ? links.value : [];
    const failures = links.ok
      ? Arr.map(
          Arr.filter(views, (one) =>
            Boolean(
              one.dials === "in" &&
              Option.getOrUndefined(
                Option.map(Option.fromNullishOr(one.failure), (present) =>
                  pipe(present, Str.startsWith("could not listen on port ")),
                ),
              ),
            ),
          ),
          (one) => one.failure,
        )
      : [links.error.message];
    const waiting = Arr.filter(views, (one) => one.waits === "ssh_connection");
    const overSsh = Arr.filter(views, (one) => one.state === "live" && one.transport === "ssh");
    checks.push({
      name: "paired links",
      ...(failures.length > 0
        ? failed(
            Arr.join(
              Arr.map([...new Set(failures)], (part) =>
                part === null || part === undefined ? "" : globalThis.String(part),
              ),
              "; ",
            ),
            "Free the listening port, then run collie machine list again.",
          )
        : waiting.length > 0
          ? warned(
              Arr.join(
                Arr.map(waiting, (one) => `${one.name}'s link waits on an SSH connection`),
                "; ",
              ),
              Arr.join(
                Arr.map(waiting, (one) => `collie machine connect ${one.name}`),
                "; ",
              ),
            )
          : overSsh.length > 0
            ? passed(
                Arr.join(
                  Arr.map(
                    overSsh,
                    (one) => `${one.name}'s link goes over SSH: direct ${one.direct}.`,
                  ),
                  " ",
                ),
              )
            : passed("The paired listener has no recorded failure.")),
    });
  }
  checks.push({ name: "disk", ...(yield* diskSpace(env, run)) });
  checks.push({ name: "memory", ...(yield* memoryCheck(env, run)) });
  checks.push({ name: "checks", ...(yield* leftoverChecks(env)) });

  const herd = yield* herdOfHost(env.stateDir);
  if (herd !== undefined)
    checks.push({
      name: "host herd",
      ...(herd === null
        ? warned(HERDLESS, "start herdr, then run `collie host restart`")
        : passed(`the host works for the Herd at ${herd}`)),
    });

  checks.push(...(yield* gitlabChecks(env, search, run)));
  checks.push(...(yield* githubChecks(env, search, run)));

  for (const { id, reading } of yield* readConnections(
    Arr.filter(
      connectionProbes(env, run),
      ({ id }) => id !== "linear" || needs.harnesses.includes("claude"),
    ),
  )) {
    const name = id === "helle" ? "helle" : id === "linear" ? "linear mcp" : `${id} connection`;
    checks.push({ name, ...optional(reading) });
  }

  return report(checks);
});

/** Below either is low: a share of the filesystem, or a size (ADR-0045 D7). */
const LOW_SHARE = 0.1;
const LOW_BYTES = 5 * 1024 ** 3;

/**
 * Free space on each filesystem Collie writes to — the state directory, its cache, herdr's
 * worktrees and the temporary directory — each filesystem once. Low is a warning, with what
 * a sweep would free where a host has served this state directory.
 */
const diskSpace = Effect.fn("Doctor.diskSpace")(function* (
  env: PluginEnv,
  run: Runner<ChildProcessSpawner.ChildProcessSpawner>,
) {
  const fs = yield* FileSystem.FileSystem;
  const wanted = [env.stateDir, collieCache(), `${env.home}/.herdr/worktrees`, tmpdir()];
  const dirs: string[] = [];
  for (const dir of wanted)
    if (yield* fs.exists(dir).pipe(Effect.orElseSucceed(() => false))) dirs.push(dir);
  const df = yield* run("df", ["-Pk", ...dirs], "/");
  const mounts = new Map<string, { size: number; free: number }>();
  for (const line of Str.split(df.stdout, "\n").slice(1)) {
    const [, blocks, , available, , ...mount] = Str.split(Str.trim(line), /\s+/);
    // A line of df's complaints, not a filesystem.
    if (mount.length === 0 || !/^\d+$/.test(blocks ?? "") || !/^\d+$/.test(available ?? ""))
      continue;
    mounts.set(Arr.join(mount, " "), {
      size: Number(blocks) * 1024,
      free: Number(available) * 1024,
    });
  }
  if (mounts.size === 0) return noted("could not read how much space is free", "df -h");
  const low = Arr.filter(
    [...mounts],
    ([, one]) => one.free < LOW_BYTES || one.free < one.size * LOW_SHARE,
  );
  const said = ([mount, one]: [string, { size: number; free: number }]) =>
    `${mount} has ${humanBytes(one.free)} free (${Math.floor((one.free / one.size) * 100)}%)`;
  if (low.length === 0) return passed(Arr.join(Arr.map([...mounts], said), "; "));
  const listing = (yield* anyRuns(env)) ? yield* cleanupListing(env, "cli") : null;
  const frees =
    listing !== null && listing.ok
      ? `; \`collie cleanup\` would free ${humanBytes(listing.value.bytes)}`
      : "";
  return warned(`${Arr.join(Arr.map(low, said), "; ")}${frees}`, "collie cleanup --apply");
});

/**
 * This Machine's memory reading. Short is a warning with the agents `collie cleanup` would
 * close, `closing` null where that could not be asked.
 */
export const memoryOutcome = (
  memory: Memory,
  short: boolean,
  closing: ReadonlyArray<string> | null,
): Outcome => {
  if (!memory.known) return warned(`memory could not be read from ${memory.from}`, "");
  if (!short) return passed(memorySaid(memory));
  const closes =
    closing === null
      ? ""
      : `; \`collie cleanup\` would close ${closing.length === 0 ? "no agent" : Arr.join(closing, ", ")}`;
  return warned(`short of memory: ${memorySaid(memory)}${closes}`, "collie cleanup --apply");
};

const memoryCheck = Effect.fn("Doctor.memoryCheck")(function* (
  env: PluginEnv,
  run: Runner<ChildProcessSpawner.ChildProcessSpawner>,
) {
  const { memory, short } = yield* machineMemory(env, run);
  if (!short) return memoryOutcome(memory, short, null);
  const listing = (yield* anyRuns(env)) ? yield* cleanupListing(env, "cli") : null;
  const closing =
    listing === null
      ? []
      : listing.ok
        ? Arr.map(
            Arr.filter(listing.value.remove, (item) => item.kind === "idle-agent"),
            (item) => item.target,
          )
        : null;
  return memoryOutcome(memory, short, closing);
});

/** Check processes no host is collecting, as `collie cleanup` lists them. */
const leftoverChecks = Effect.fn("Doctor.leftoverChecks")(function* (env: PluginEnv) {
  const listing = (yield* anyRuns(env)) ? yield* cleanupListing(env, "cli") : null;
  const left =
    listing !== null && listing.ok
      ? Arr.filter(listing.value.remove, (item) => item.kind === "check")
      : [];
  const [first] = left;
  return first === undefined
    ? passed("no check is running that no host is collecting")
    : warned(
        `${left.length} check process(es) no host is collecting: ${first.reason}`,
        "collie cleanup --apply",
      );
});

/** One line per check, and under it the command to run where there is one. */
function render(checks: Check[]): string {
  return Arr.join(
    Arr.flatMap(checks, (check) => [
      `  ${check.ok ? (check.warn ? "!" : "✓") : "✗"} ${pipe(check.name, Str.padEnd(16))}${check.detail}`,
      ...(check.fix === "" ? [] : [`      fix: ${check.fix}`]),
    ]),
    "\n",
  );
}

function report(checks: Check[]) {
  const failed = Arr.filter(checks, (check) => !check.ok);
  if (failed.length === 0) {
    return {
      ok: true as const,
      data: { checks, ready: true },
      human: Arr.join([`Collie is ready — ${checks.length} checks passed.`, render(checks)], "\n"),
    };
  }
  // The failure envelope prints its message and nothing else, so the message is the
  // whole report: what is wrong, and the command that fixes each of them.
  return err(
    "operation_failed",
    Arr.join([`${failed.length} of ${checks.length} checks failed.`, render(checks)], "\n"),
    // Spread into plain maps: `err` takes a YAML map, and `Check` is an interface,
    // which has no index signature for it to satisfy.
    { checks: Arr.map(checks, (check) => ({ ...check })), ready: false },
  );
}

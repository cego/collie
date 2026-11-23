import * as Str from "effect/String";
import { pipe } from "effect/Function";
import * as Arr from "effect/Array";
import { Clock, Effect, Option, Path, Result, Schema } from "effect";
import { CommandLine } from "effect/process";
import type { ChildProcessSpawner } from "effect/process";
import * as SecureRandom from "effect/crypto/SecureRandom";
import { loadDefaults, worktreesDirectory } from "./config";
import { savedModules } from "./discovery";
import { layers, loadDefinitions, skillDirs, skillFile } from "./definitions";
import type { PluginEnv } from "./env";
import { HARNESSES } from "./harness";
import { Herdr } from "./herdr";
import { shell } from "./mr";
import type { Runner } from "./mr";
import { isCheckout } from "./release";
import { isNewer, newestRelease, releasesOf } from "./releases";
import manifest from "../package.json";
import { err } from "./operations";
import type { ConnectionReading } from "./connection-model";
import { connectionProbes, readConnections } from "./connections";
import { slackApi } from "./slack";
import { projectsRoot } from "./projects";
import { claudeSettingsPath, readStatusLine, STATUS_LINE_ARGS } from "./statusline";
import { humanBytes } from "./bytes";
import { diskSaid, lowOn, readDisk } from "./disk";
import { collieCache } from "./cleanup";
import { anyRuns, cleanupListing, hostRegistered, machineList, machineShell } from "./lifecycle";
import type { Door } from "./lifecycle";
import { peersOf } from "./peers";
import { herdOfHost } from "./host";
import { tmpdir } from "node:os";
import { machineMemory, memorySaid } from "./memory";
import type { Memory } from "./memory";
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
} from "./doctor-check";
import type { Check } from "./doctor-check";
import { gitlabChecks } from "./forge/gitlab-checks";
import { connect, coreSocket } from "./hc";
import { hcInstallDir, hcMeets, hcVersion } from "./hc-install";
import hcPin from "../hc-pin.json";
import { githubChecks } from "./forge/github-checks";

export type { Check } from "./doctor-check";
export { onPath } from "./doctor-check";

const optional = (probe: ConnectionReading) =>
  probe.state === "ok"
    ? passed(probe.detail)
    : probe.state === "absent"
      ? noted(probe.detail, probe.fix)
      : warned(probe.detail, probe.fix);

const HC_INSTALL = `curl -fsSL https://releases.herdr.dev/core/install.sh | HC_VERSION=${hcPin.version} sh`;

const hcInstalled = Effect.fn("Doctor.hcInstalled")(function* (
  env: PluginEnv,
  search: string,
  run: Runner<ChildProcessSpawner.ChildProcessSpawner>,
) {
  const path = yield* Path.Path;
  const dir = yield* onPath(search, "herdr-core");
  const installed = path.join(hcInstallDir(env.raw, env.home), "herdr-core");
  const bin =
    dir !== null ? path.join(dir, "herdr-core") : (yield* runnable(installed)) ? installed : null;
  if (bin === null) return failed("not installed", HC_INSTALL);
  const said = (yield* answered(run(bin, ["--version"], env.home))).stdout;
  const version = hcVersion(said);
  if (hcMeets(said, hcPin.version)) return passed(`${version} at ${bin}`);
  return failed(
    version === null
      ? `the hc at ${bin} names no version, so it is taken as older than the ${hcPin.version} this Collie needs`
      : `hc ${version} is installed, older than the ${hcPin.version} this Collie needs`,
    HC_INSTALL,
  );
});

const coreAnswers = Effect.fn("Doctor.coreAnswers")(function* (env: PluginEnv) {
  const socket = yield* coreSocket(env.raw);
  const hello = yield* Effect.scoped(
    Effect.flatMap(connect(socket), (hc) => hc.call("hello", {})),
  ).pipe(Effect.timeout("5 seconds"), Effect.option);
  return Option.match(hello, {
    onNone: () => failed(`no core answers at ${socket}`, "hc server start"),
    onSome: (said) => passed(`hc ${said.version} answers at ${socket}`),
  });
});

const onHerdrOne = Effect.fn("Doctor.onHerdrOne")(function* (env: PluginEnv) {
  const registered = (yield* anyRuns(env))
    ? yield* Effect.result(hostRegistered(env))
    : Result.succeed([]);
  if (Result.isFailure(registered))
    return warned(
      `could not ask this Machine's host which agents it registered (${registered.failure.message})`,
      "collie host restart",
    );
  const left = Arr.filter(registered.success, (entry) => entry.incarnation?.backend !== "core");
  if (left.length === 0) return passed("nothing on this Machine is registered on Herdr 1");
  return noted(
    `registered on Herdr 1, which Collie no longer reaches: ${Arr.join(
      Arr.map(left, (entry) => `${entry.agent} (run ${entry.runId})`),
      ", ",
    )}`,
    "collie run resume <run> starts its agents again on core",
  );
});

const asked = Effect.fn("Doctor.asked")(function* (env: PluginEnv) {
  const defaults = yield* loadDefaults(env.userDir);
  return { harnesses: [defaults.harness] };
});

// WARNING: never prompts, since a hidden credential prompt would hang the terminal, and it is bounded; settings go as arguments, not the inherited environment.
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

const FETCH_EVERY_MS = 5 * 60_000;
// WARNING: the board redraws often; a count is re-read only this often rather than spawning git on every redraw.
const COUNT_FOR_MS = 30_000;

interface Known {
  fetchedAt: number;
  countedAt: number;
  behind: number | null;
}
const known = new Map<string, Known>();
const knownOf = (root: string) => known.get(root) ?? { fetchedAt: 0, countedAt: 0, behind: null };

export const behindRemote = Effect.fn("Doctor.behindRemote")(function* (
  root: string,
  run: Runner<ChildProcessSpawner.ChildProcessSpawner> = shell,
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

// WARNING: a file that claims an id and will not load answers for it; the layer below is not consulted.
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

const personas = Effect.fn("Doctor.personas")(function* (env: PluginEnv) {
  const found = yield* loadDefinitions(yield* layers(env));
  return found.errors.length === 0
    ? passed(`${found.personas.size} read, each one telling its agent only what it can fill`)
    : noted(Arr.join(found.errors, "; "), "fix each file named");
});

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

export const doctor = Effect.fn("Doctor.doctor")(function* (
  env: PluginEnv,
  run: Runner<ChildProcessSpawner.ChildProcessSpawner> = shell,
  herdr: Herdr = new Herdr(env),
  slack = slackApi,
) {
  const path = yield* Path.Path;
  const root = env.pluginRoot;
  const search = env.raw["PATH"] ?? "";
  const checks: Array<Check> = [];

  checks.push(
    { name: "hc", ...(yield* hcInstalled(env, search, run)) },
    { name: "core", ...(yield* coreAnswers(env)) },
    { name: "herdr 1", ...(yield* onHerdrOne(env)) },
    {
      name: "runner",
      // WARNING: the shim exec's this, so a bin without its executable bit is the same permission-denied failure as a shim without one.
      ...((yield* runnable(path.join(root, "bin", "collie")))
        ? passed(`${root}/bin/collie`)
        : failed("not built", `sh ${root}/prepare.sh`)),
    },
  );

  const shimDir = yield* onPath(search, "collie");
  const binDir = env.raw["COLLIE_BIN_DIR"] ?? path.join(env.home, ".local", "bin");
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
  checks.push({
    name: "skills",
    ...((yield* skillFile(dirs, "collie")) !== null
      ? passed(`the skill store is in place (${Arr.join(dirs, ", ")})`)
      : failed("the operator skill is not installed", `sh ${root}/prepare.sh`)),
  });

  const absent: Array<string> = [];
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

  // WARNING: reported, never failed: a machine that is otherwise ready must not exit non-zero over a status line.
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
  checks.push(
    {
      name: "up to date",
      ...(checkout
        ? behind === null
          ? passed("a checkout with no remote, so there is nothing to compare")
          : behind === 0
            ? passed("level with its remote")
            : noted(
                `${behind} commit${behind === 1 ? "" : "s"} behind its remote`,
                "collie upgrade",
              )
        : isNewer(newest, manifest.version)
          ? noted(`Collie ${newest} is out`, "collie upgrade")
          : passed(
              newest === null
                ? "the newest release could not be read, so there is nothing to compare"
                : `Collie ${manifest.version} is the newest release`,
            )),
    },
    { name: "workflows", ...(yield* overrides(env)) },
    { name: "personas", ...(yield* personas(env)) },
    { name: "projects root", ...(yield* projects(env)) },
  );
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
  checks.push(
    { name: "disk", ...(yield* diskSpace(env, run)) },
    { name: "memory", ...(yield* memoryCheck(env, run)) },
    { name: "checks", ...(yield* leftoverChecks(env)) },
  );

  const herd = yield* herdOfHost(env.stateDir);
  if (herd !== undefined)
    checks.push({
      name: "host herd",
      ...(herd === null
        ? warned("this host has no Herd: judgements will be skipped", "collie host restart")
        : passed(`the host works for the Herd at ${herd}`)),
    });

  checks.push(
    ...(yield* gitlabChecks(env, search, run)),
    ...(yield* githubChecks(env, search, run)),
  );

  for (const { id, reading } of yield* readConnections(
    Arr.filter(
      connectionProbes(env, run, slack),
      ({ id }) => id !== "linear" || needs.harnesses.includes("claude"),
    ),
  )) {
    const name = id === "helle" ? "helle" : id === "linear" ? "linear mcp" : `${id} connection`;
    checks.push({ name, ...optional(reading) });
  }

  return report(checks);
});

const diskSpace = Effect.fn("Doctor.diskSpace")(function* (
  env: PluginEnv,
  run: Runner<ChildProcessSpawner.ChildProcessSpawner>,
) {
  const mounts = yield* readDisk(
    env,
    [
      env.stateDir,
      collieCache(),
      yield* worktreesDirectory(env),
      `${env.home}/.herdr/worktrees`,
      tmpdir(),
    ],
    run,
  );
  if (mounts.length === 0) return noted("could not read how much space is free", "df -h");
  const low = Arr.filter(mounts, lowOn);
  if (low.length === 0) return passed(Arr.join(Arr.map(mounts, diskSaid), "; "));
  const listing = (yield* anyRuns(env)) ? yield* cleanupListing(env, "cli") : null;
  const frees =
    listing !== null && listing.ok
      ? `; \`collie cleanup\` would free ${humanBytes(listing.value.bytes)}`
      : "";
  return warned(`${Arr.join(Arr.map(low, diskSaid), "; ")}${frees}`, "collie cleanup --apply");
});

export const memoryOutcome = (
  memory: Memory,
  short: boolean,
  closing: ReadonlyArray<string> | null,
) => {
  if (!memory.known) return warned(`memory could not be read from ${memory.from}`, "");
  if (!short) return passed(memorySaid(memory));
  const closes =
    closing === null
      ? ""
      : `; \`collie cleanup\` would close ${closing.length === 0 ? "no agent" : Arr.join(closing, ", ")}`;
  return warned(
    `short of memory: ${memorySaid(memory)}${closes}`,
    closing?.length === 0 ? "" : "collie cleanup --apply",
  );
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

const Reported = Schema.Struct({
  checks: Schema.Array(
    Schema.Struct({
      name: Schema.String,
      ok: Schema.Boolean,
      detail: Schema.String,
      fix: Schema.String,
      warn: Schema.optionalKey(Schema.Boolean),
    }),
  ),
});
const DoctorSaid = Schema.fromJsonString(
  Schema.Union([
    Schema.Struct({ data: Reported }),
    Schema.Struct({ error: Schema.Struct({ details: Reported }) }),
  ]),
);

export const doctorOn = Effect.fn("Doctor.doctorOn")(function* (
  env: PluginEnv,
  gitlabHost: Option.Option<string>,
  door: Door,
) {
  const script = CommandLine.join([
    "collie",
    "--json",
    "doctor",
    ...Option.match(gitlabHost, { onNone: () => [], onSome: (host) => ["--gitlab-host", host] }),
  ]);
  if (script._tag === "Failure")
    return err("invalid_input", `--gitlab-host cannot be passed on: ${script.failure.message}`);
  const request = `doctor:${yield* (yield* SecureRandom.SecureRandom).uuidV4()}`;
  const ran = yield* machineShell(env, script.success, request, door);
  if (!ran.ok) return ran;
  const said = Schema.decodeOption(DoctorSaid)(
    Arr.findLast(Str.split(Str.trim(ran.value.stdout), "\n"), (line) => line !== "").pipe(
      Option.getOrElse(() => ""),
    ),
  );
  if (Option.isNone(said))
    return err("operation_failed", `${env.machine}'s doctor did not report its checks.`, {
      output: Str.trim(ran.value.stderr) || Str.trim(ran.value.stdout),
    });
  return report([...("data" in said.value ? said.value.data : said.value.error.details).checks]);
});

function render(checks: Array<Check>) {
  return Arr.join(
    Arr.flatMap(checks, (check) => [
      `  ${check.ok ? (check.warn ? "!" : "✓") : "✗"} ${pipe(check.name, Str.padEnd(16))}${check.detail}`,
      ...(check.fix === "" ? [] : [`      fix: ${check.fix}`]),
    ]),
    "\n",
  );
}

function report(checks: Array<Check>) {
  const failed = Arr.filter(checks, (check) => !check.ok);
  if (failed.length === 0) {
    return {
      ok: true as const,
      data: { checks, ready: true },
      human: Arr.join([`Collie is ready — ${checks.length} checks passed.`, render(checks)], "\n"),
    };
  }
  return err(
    "operation_failed",
    Arr.join([`${failed.length} of ${checks.length} checks failed.`, render(checks)], "\n"),
    // WARNING: spread into plain maps: err takes a YAML map, and Check is an interface with no index signature.
    { checks: Arr.map(checks, (check) => ({ ...check })), ready: false },
  );
}

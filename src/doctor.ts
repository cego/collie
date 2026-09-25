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

import { Clock, Effect, FileSystem, Option, Path, Result, Schema } from "effect";
import type { ChildProcessSpawner } from "effect/unstable/process";
import { loadDefaults } from "./config";
import { savedModules } from "./discovery";
import { layers, loadDefinitions, skillDirs, skillInstalled } from "./definitions";
import type { PluginEnv } from "./env";
import { HARNESSES } from "./harness";
import { Herdr } from "./herdr";
import { shell, type Runner } from "./mr";
import { err } from "./operations";
import { probeHelle, probeLinearMcp, type Probe } from "./optional";
import { claudeSettingsPath, readStatusLine, STATUS_LINE_ARGS } from "./statusline";

export interface Check {
  /** How the check is named, in the rendering and in `--json`. */
  name: string;
  ok: boolean;
  /** What was found. */
  detail: string;
  /** The command or the one thing to do about it; empty when there is nothing to fix. */
  fix: string;
  /** Set up and not working: nothing a Run needs by default, so `ok`, but shown as `!`. */
  warn?: boolean;
}

/**
 * What one check found. Every check chooses one of these once, rather than deciding
 * `ok`, `detail` and `fix` in three ternaries over the same condition — where a new
 * state means editing all three in step and a reader has to hold the predicate three
 * times to read one answer.
 */
type Outcome = Omit<Check, "name">;

const passed = (detail: string): Outcome => ({ ok: true, detail, fix: "" });
const failed = (detail: string, fix: string): Outcome => ({ ok: false, detail, fix });
/** Nothing is wrong, but there is still something a reader may want to run. */
const noted = (detail: string, fix: string): Outcome => ({ ok: true, detail, fix });
/** Configured and broken, for something no Run needs by default: not a failure, but not a ✓. */
const warned = (detail: string, fix: string): Outcome => ({ ok: true, detail, fix, warn: true });

/** An optional integration, as doctor reports it: absent is a note, broken is a warning. */
const optional = (probe: Probe): Outcome =>
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
  if (!bin.includes("/")) return yield* onPath(search, bin);
  return (yield* runnable(bin)) ? bin : null;
});

/**
 * The first directory on PATH holding `name` as something this machine can run, or
 * null. The executable bit is the question, not the file: a shim or a harness that
 * is there but not executable fails with permission denied at the point of use,
 * which is exactly the confusion `doctor` exists to end.
 */
const onPath = Effect.fn("Doctor.onPath")(function* (search: string, name: string) {
  const path = yield* Path.Path;
  for (const dir of search.split(":").filter((d) => d !== "")) {
    if (yield* runnable(path.join(dir, name))) return dir;
  }
  return null;
});

const runnable = Effect.fn("Doctor.runnable")(function* (file: string) {
  const fs = yield* FileSystem.FileSystem;
  const info = yield* Effect.result(fs.stat(file));
  return Result.isSuccess(info) && (info.success.mode & 0o111) !== 0;
});

/** `1.10.0` is newer than `1.9.0`; a string comparison would disagree. */
function older(version: string, than: string): boolean {
  const parts = (v: string) => v.split(".").map((n) => Number(n) || 0);
  const [a, b] = [parts(version), parts(than)];
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const [left, right] = [a[i] ?? 0, b[i] ?? 0];
    if (left !== right) return left < right;
  }
  return false;
}

/** What the plugin manifest says it needs of herdr — declared since the start, and never checked until now. */
const minHerdrVersion = Effect.fn("Doctor.minHerdrVersion")(function* (root: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const manifest = path.join(root, "herdr-plugin.toml");
  if (!(yield* fs.exists(manifest))) return "";
  const text = yield* fs.readFileString(manifest);
  return /^min_herdr_version\s*=\s*"([^"]+)"/m.exec(text)?.[1] ?? "";
});

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
const FETCH_LIMIT = "20 seconds";
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
 * A command that answers or is taken to have said nothing. `doctor` asks two things
 * that can reach a network — the fetch above, and whether `glab` is logged in — and
 * an install ends by running all of this, so neither may wait on an unreachable host
 * for as long as it likes.
 */
const answered = (
  command: Effect.Effect<
    { code: number; stdout: string },
    never,
    ChildProcessSpawner.ChildProcessSpawner
  >,
) =>
  Effect.timeoutOption(command, FETCH_LIMIT).pipe(
    Effect.map(Option.getOrElse(() => ({ code: 124, stdout: "timed out" }))),
  );

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
  run: Runner<ChildProcessSpawner.ChildProcessSpawner> = (cmd, args, cwd) =>
    shell(cmd, args, cwd, "ignore"),
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
  // The line that is a number, not the whole output: `doctor` runs its commands with
  // stderr folded in so a human can be told why one failed, and a git that warns
  // about something while answering correctly would otherwise parse as nothing.
  const number = answer.stdout.split("\n").find((line) => /^\d+$/.test(line.trim()));
  const behind = answer.code === 0 && number !== undefined ? Number(number) : null;
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
  const own = saved.entries
    .filter((one) => one.layer !== "shipped")
    .map((one) => `${one.id} (${one.layer}, ${one.path})`)
    .sort();
  if (saved.problems.length > 0) {
    return noted(
      saved.problems.map((one) => `${one.id}: ${one.message}`).join("; "),
      `fix ${saved.problems.map((one) => one.path).join(" and ")}, or delete it to take the workflow below it`,
    );
  }
  return own.length === 0
    ? passed("every workflow here is the one Collie ships")
    : passed(`overridden here: ${own.join("; ")}`);
});

/**
 * Every persona the layers define, read as a launch reads it: one that will not parse, or
 * that names anything but a skill, is named with why.
 */
const personas = Effect.fn("Doctor.personas")(function* (env: PluginEnv) {
  const found = yield* loadDefinitions(yield* layers(env));
  return found.errors.length === 0
    ? passed(`${found.personas.size} read, each one telling its agent only what it can fill`)
    : noted(found.errors.join("; "), "fix each file named");
});

/**
 * Every check, in one pass, whatever the state of the machine: a prerequisite that
 * is missing must not stop the ones after it from being reported, or `doctor` is one
 * failed Run at a time again.
 */
export const doctor = Effect.fn("Doctor.doctor")(function* (
  env: PluginEnv,
  run: Runner<ChildProcessSpawner.ChildProcessSpawner> = (cmd, args, cwd) =>
    shell(cmd, args, cwd, "say"),
  herdr: Herdr = new Herdr(env),
) {
  const path = yield* Path.Path;
  const root = env.pluginRoot;
  const search = env.raw["PATH"] ?? "";
  const checks: Check[] = [];

  const min = yield* minHerdrVersion(root);
  const herdrBin = yield* located(search, env.binPath);
  // `cli` parses JSON where herdr answers with it; these two answer in plain text,
  // and anything else is as good as no answer.
  const text = (args: string[]) =>
    herdr.cli(args).pipe(
      Effect.map((answer) => (isString(answer) ? answer : "")),
      Effect.catch(() => Effect.succeed("")),
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
            "upgrade herdr — https://herdr.dev/docs/install/",
          )
        : passed(version || "installed")),
  });

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

  const npx = yield* onPath(search, "npx");
  checks.push({
    name: "node",
    ...(npx
      ? passed(`npx in ${npx}`)
      : failed(
          "no npx on PATH; the skills cannot be installed or updated",
          "install Node — https://nodejs.org — then run `collie upgrade`",
        )),
  });

  const needs = yield* asked(env);
  const dirs = yield* skillDirs(env);
  // What a module asks an agent for is decided while it runs, so there is no list to
  // check against: what this says is whether the store is there at all, and the routine
  // that fills it. The sources, the global store and the Claude Code target are
  // `prepare.sh`'s to know.
  checks.push({
    name: "skills",
    ...((yield* skillInstalled(dirs, "collie"))
      ? passed(`the skill store is in place (${dirs.join(", ")})`)
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
          `not installed: ${absent.join(", ")}`,
          `install the harness CLI: ${absent.join(", ")}`,
        )),
  });

  // Reported, never failed: the board and every Run work without it, and a machine that
  // is otherwise ready must not exit non-zero over a line under a prompt.
  const line = yield* readStatusLine(env);
  const settings = yield* claudeSettingsPath(env);
  const install = `collie ${STATUS_LINE_ARGS.join(" ")} --install`;
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
  const behind = gitDir ? yield* refreshBehind(root, run) : null;
  checks.push({
    name: "up to date",
    // Passing even when it is behind: a checkout a few commits back is a thing to
    // say, not a missing prerequisite, and the same line on the Control Plane is
    // shown rather than sent for the same reason. It still carries the command.
    ...(behind === null
      ? passed("not a checkout with a remote, so there is nothing to compare")
      : behind === 0
        ? passed("level with its remote")
        : noted(`${behind} commit${behind === 1 ? "" : "s"} behind its remote`, "collie upgrade")),
  });

  const glabDir = yield* onPath(search, "glab");
  const auth = glabDir ? yield* answered(run("glab", ["auth", "status"], root)) : null;
  checks.push({ name: "workflows", ...(yield* overrides(env)) });
  checks.push({ name: "personas", ...(yield* personas(env)) });

  checks.push({
    name: "glab",
    ...(!glabDir
      ? failed(
          "not installed; the workflows that open or review a merge request will not work",
          "install glab — https://gitlab.com/gitlab-org/cli",
        )
      : auth?.code === 0
        ? passed("logged in")
        : auth?.code === 124
          ? failed(`installed, but did not answer within ${FETCH_LIMIT}`, "glab auth status")
          : failed("installed, but not logged in", "glab auth login")),
  });

  // Optional, and only where work could reach for them: Helle for a module that waits
  // on it, Linear for an agent Claude Code runs. Absent is a note; set up and broken is
  // a warning, because that one fails a Run that nobody expected to.
  checks.push({ name: "helle", ...optional(yield* probeHelle(env)) });
  if (needs.harnesses.includes("claude"))
    checks.push({ name: "linear mcp", ...optional(yield* probeLinearMcp(env)) });

  return report(checks);
});

/** One line per check, and under it the command to run where there is one. */
function render(checks: Check[]): string {
  return checks
    .flatMap((check) => [
      `  ${check.ok ? (check.warn ? "!" : "✓") : "✗"} ${check.name.padEnd(16)}${check.detail}`,
      ...(check.fix === "" ? [] : [`      fix: ${check.fix}`]),
    ])
    .join("\n");
}

function report(checks: Check[]) {
  const failed = checks.filter((check) => !check.ok);
  if (failed.length === 0) {
    return {
      ok: true as const,
      data: { checks, ready: true },
      human: [`Collie is ready — ${checks.length} checks passed.`, render(checks)].join("\n"),
    };
  }
  // The failure envelope prints its message and nothing else, so the message is the
  // whole report: what is wrong, and the command that fixes each of them.
  return err(
    "operation_failed",
    [`${failed.length} of ${checks.length} checks failed.`, render(checks)].join("\n"),
    // Spread into plain maps: `err` takes a YAML map, and `Check` is an interface,
    // which has no index signature for it to satisfy.
    { checks: checks.map((check) => ({ ...check })), ready: false },
  );
}

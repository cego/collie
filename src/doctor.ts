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
import {
  DefinitionError,
  layers,
  loadDefinitions,
  requiredSkills,
  resolveWorkflow,
  skillDirs,
  skillInstalled,
  stepVariants,
} from "./definitions";
import type { PluginEnv } from "./env";
import { HARNESSES } from "./harness";
import { Herdr } from "./herdr";
import { shell, type Runner } from "./mr";
import { err } from "./operations";

export interface Check {
  /** How the check is named, in the rendering and in `--json`. */
  name: string;
  ok: boolean;
  /** What was found. */
  detail: string;
  /** The command or the one thing to do about it; empty when there is nothing to fix. */
  fix: string;
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
 * What the loaded Workflows need of this machine: the skills they name and the
 * harnesses they route steps to. Read from the definitions rather than hard-coded,
 * so a forked Workflow naming a new skill or harness is checked against that one.
 */
const asked = Effect.fn("Doctor.asked")(function* (env: PluginEnv) {
  const defs = yield* loadDefinitions(yield* layers(env));
  const defaults = yield* loadDefaults(env.configDir);
  const skills = new Set<string>();
  const harnesses = new Set<string>();
  for (const name of defs.workflows.keys()) {
    let workflow;
    try {
      workflow = resolveWorkflow(name, defs, defaults);
    } catch (cause) {
      // A Workflow that will not resolve is a definition error, which validation
      // reports on its own terms; it is not a missing prerequisite.
      if (cause instanceof DefinitionError) continue;
      throw cause;
    }
    for (const skill of requiredSkills(workflow, defs).keys()) skills.add(skill);
    for (const step of workflow.steps) {
      for (const variant of stepVariants(step, defaults)) harnesses.add(variant.harness);
    }
  }
  return { skills: [...skills].sort(), harnesses: [...harnesses].sort() };
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
 * The steps the bundled `implement` shed and the second reviewer `review` shed, so an
 * override that still carries them is recognisable as the old flow rather than as a
 * customisation. A user's own `architecture` step is their business; the report names
 * the edit and edits nothing.
 */
const OLD_IMPLEMENT_STEPS = new Set(["architecture", "simplify"]);

/**
 * What the effective `implement` and `review` resolve to on this machine, in this
 * project. A user or project override wins over the bundled definition, so a change to
 * the bundled flow is not in effect where one exists — and one that keeps the old flow
 * is what a Run here would actually run. Reported with the exact edit, never applied.
 */
const overrides = Effect.fn("Doctor.overrides")(function* (env: PluginEnv) {
  const loaded = yield* layers(env).pipe(Effect.flatMap(loadDefinitions), Effect.result);
  if (Result.isFailure(loaded))
    return failed(`the definitions do not load: ${String(loaded.failure)}`, "");
  const defs = loaded.success;
  const defaults = yield* loadDefaults(env.configDir);
  const kept: string[] = [];
  const edits: string[] = [];
  const own: string[] = [];
  for (const name of ["implement", "review"] as const) {
    let wf;
    try {
      wf = resolveWorkflow(name, defs, defaults);
    } catch (cause) {
      if (cause instanceof DefinitionError) return failed(`${name}: ${cause.message}`, "");
      throw cause;
    }
    if (wf.layer === "baseline") continue;
    own.push(`${name} (${wf.layer}, ${wf.path})`);
    if (name === "implement") {
      const old = wf.steps.filter((step) => OLD_IMPLEMENT_STEPS.has(step.id)).map((s) => s.id);
      if (old.length > 0) {
        kept.push(`${name} still runs ${old.join(" and ")}`);
        edits.push(`remove the ${old.join(" and ")} step(s) from ${wf.path}`);
      }
    } else {
      const review = wf.steps.find((step) => step.id === "review");
      const reviewers = review ? stepVariants(review, defaults).length : 0;
      if (reviewers > 1) {
        kept.push(`${name} still runs ${reviewers} reviewers`);
        edits.push(`keep one entry under \`parallel:\` of step review in ${wf.path}`);
      }
    }
  }
  if (own.length === 0) return passed("implement and review are the bundled ones");
  if (kept.length === 0) return passed(`overridden here, current flow: ${own.join("; ")}`);
  return noted(
    `${kept.join("; ")} — an override keeps the old flow, so the bundled change is not in effect here`,
    `${edits.join("; ")} (or delete the override to take the bundled definition)`,
  );
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
  const missing: string[] = [];
  for (const skill of needs.skills) {
    if (!(yield* skillInstalled(dirs, skill))) missing.push(skill);
  }
  checks.push({
    name: "skills",
    ...(missing.length === 0
      ? passed(`${needs.skills.length} installed`)
      : // The routine, not a bare `npx skills add`: the sources, the global store and
        // the Claude Code target are its to know, and it puts back what is missing.
        failed(`missing: ${missing.join(", ")}`, `sh ${root}/prepare.sh`)),
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

  return report(checks);
});

/** One line per check, and under it the command to run where there is one. */
function render(checks: Check[]): string {
  return checks
    .flatMap((check) => [
      `  ${check.ok ? "✓" : "✗"} ${check.name.padEnd(16)}${check.detail}`,
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

import * as Struct from "effect/Struct";
import * as Str from "effect/String";
import { pipe } from "effect/Function";
import * as Rec from "effect/Record";
import * as Arr from "effect/Array";
import type { Asker } from "./proposals";
import { Config, Effect, Option } from "effect";

// Collie's installation, state and invocation environment.

export const PLUGIN_ID = "cego.collie";

export interface PluginEnv {
  pluginRoot: string;
  /** The human's home, where a harness keeps what it remembers between sessions. */
  home: string;
  /** `COLLIE_DIR`, else `~/.collie`: `release/`, `user/` and `kept/`. */
  collieDir: string;
  /**
   * This person's own layer, which no upgrade writes: their `config.json`, `verify.json`,
   * personas and workflows, in the same shape a project's `.collie/` has.
   */
  userDir: string;
  /** Where Claude Code's managed settings live: an organisation's, beyond any flag. */
  claudeManagedDir: string;
  stateDir: string;
  /** The GitLab login a generated branch is namespaced under; null leaves it to glab. */
  gitlabLogin: string | null;
  /** `GITHUB_ACTOR`: who a generated branch is namespaced under on GitHub. */
  githubLogin: string | null;
  /** Directory the run should treat as the project. */
  cwd: string;
  /** True when COLLIE_CWD named it: an explicit directory beats every inference. */
  cwdExplicit: boolean;
  raw: Record<string, string>;
  /** The paired Machine a command was pointed at with `--machine`, for one that names no Run. */
  machine?: string;
  hostStamp?: string;
  asker?: Asker;
  /** A front door that can show an SSH login, which pairing on first reach needs. */
  pairs?: boolean;
}

function first(env: Record<string, string | undefined>, ...keys: string[]): string | null {
  for (const k of keys) {
    const v = env[k];
    if (v !== undefined && v !== "") return v;
  }
  return null;
}

/**
 * The installation the compiled runner was started from, so a `bin/collie` run from any
 * directory still finds its baseline and its own driver. Bun's single-file build runs its
 * sources from a virtual `/$bunfs/` path, and only then is `execPath` the runner itself
 * rather than `bun`, whose location says nothing about where the plugin is.
 */
export function ownRoot(
  modulePath: string = import.meta.path,
  execPath: string = process.execPath,
  collieDir: string | null = null,
): string | null {
  if (!pipe(modulePath, Str.startsWith("/$bunfs/"))) return null;
  const at = Option.getOrElse(pipe(execPath, Str.lastIndexOf("/bin/")), () => -1);
  // A downloaded runner upgrades the installation, never the caller's stale PWD.
  return at > 0
    ? pipe(execPath, Str.slice(0, at))
    : collieDir === null
      ? null
      : `${collieDir}/release`;
}

/**
 * How this runner re-invokes itself, as argv. Same discriminator as `ownRoot`: only a
 * `/$bunfs/` module path means the single-file build is running, and `execPath` is then
 * the runner itself rather than the `bun` that is executing its sources.
 *
 * This is what a harness's own hook or status-line command is pointed at, so the
 * helpers a launch installs are the ones compiled into the binary that installed them.
 */
export function selfCommand(
  modulePath: string = import.meta.path,
  execPath: string = process.execPath,
  script: string = Bun.argv[1] ?? "",
): string[] {
  return pipe(modulePath, Str.startsWith("/$bunfs/")) ? [execPath] : [execPath, script];
}

export function readEnv(
  env: Readonly<Record<string, string | undefined>>,
  installRoot: string | null = null,
): PluginEnv {
  const home = env.HOME ?? "/tmp";
  const collieDir = first(env, "COLLIE_DIR") ?? `${home}/.collie`;
  const pluginRoot =
    first(env, "COLLIE_ROOT") ??
    installRoot ??
    ownRoot(import.meta.path, process.execPath, collieDir) ??
    env.PWD ??
    ".";
  // `PWD` goes stale whenever something chdir'd; the real directory never does.
  const explicitCwd = first(env, "COLLIE_CWD");
  const cwd = explicitCwd ?? process.cwd();

  const raw: Record<string, string> = {};
  for (const [key, value] of Rec.toEntries(env)) {
    if (value !== undefined) raw[key] = value;
  }

  return {
    pluginRoot,
    home,
    collieDir,
    userDir: first(env, "COLLIE_USER_DIR") ?? `${collieDir}/user`,
    claudeManagedDir:
      first(env, "COLLIE_CLAUDE_MANAGED_DIR") ??
      (process.platform === "darwin"
        ? "/Library/Application Support/ClaudeCode"
        : "/etc/claude-code"),
    stateDir: first(env, "COLLIE_STATE_DIR") ?? `${home}/.local/state/herdr/plugins/${PLUGIN_ID}`,
    gitlabLogin: first(env, "GITLAB_USER_LOGIN"),
    githubLogin: first(env, "GITHUB_ACTOR"),
    cwd,
    cwdExplicit: explicitCwd !== null,
    raw,
  };
}

const environmentKeys = [
  "HOME",
  "PWD",
  // The machine's: `doctor` answers "is it installed" by walking
  // PATH, and "where would the shim be" from the directory the installer writes to.
  "PATH",
  "COLLIE_BIN_DIR",
  "COLLIE_CWD",
  "COLLIE_RUN",
  "COLLIE_AGENT",
  "OPENCODE_CONFIG_CONTENT",
  // Which environment file Helle's credentials are read from, for a machine that keeps
  // them somewhere other than the MCP wrapper's default.
  "HELLE_ENV_FILE",
  // Where Claude Code keeps its login and settings, where it is not `~/.claude`.
  "CLAUDE_CONFIG_DIR",
  // A fake Helle, for tests only.
  "COLLIE_HELLE_URL",
  // A fake proc directory to read memory from, for tests only.
  "COLLIE_PROC",
  "COLLIE_ROOT",
  "COLLIE_DIR",
  // Where releases are published, for a mirror or a test's fake.
  "COLLIE_RELEASES",
  "COLLIE_USER_DIR",
  "COLLIE_CLAUDE_MANAGED_DIR",
  "COLLIE_STATE_DIR",
  "GITLAB_USER_LOGIN",
  "GITHUB_ACTOR",
  // gitte's folder, which is the Projects root where `projects.root` names none.
  "GITTE_CWD",
  // Where Desktop keeps its own on this computer, which cleanup reads.
  "XDG_DATA_HOME",
  "XDG_STATE_HOME",
  // Which core this Machine's agents run on, as `hc` itself finds it.
  "HC_SOCKET",
  "HC_SESSION",
  "XDG_RUNTIME_DIR",
  "XDG_CONFIG_HOME",
  // Where upstream's installer put hc.
  "HC_INSTALL_DIR",
] as const;

export const currentEnv = Effect.gen(function* () {
  const env: Record<string, string | undefined> = {};
  for (const key of environmentKeys) {
    const value = yield* Config.option(Config.String(key));
    if (Option.isSome(value)) env[key] = value.value;
  }
  return readEnv(env);
});

const LAUNCHER_PRELOADS = new Set(["./libcef.so", "./libvk_swiftshader.so"]);

/**
 * Removes Electrobun's launcher variables, preserving the user's surviving entries. Its
 * library paths are known only by Desktop's `bin`; without one they are kept.
 */
export const withoutLauncher = (
  env: Readonly<Record<string, string | undefined>>,
  bin?: string,
) => {
  const {
    ELECTROBUN_LAUNCHER_PID: _pid,
    ELECTROBUN_INSTALL_ROOT_NAME: _root,
    LD_PRELOAD,
    LD_LIBRARY_PATH,
    ICU_DATA,
    ...inherited
  } = env;
  const kept = { ...inherited };
  const without = (list: string | undefined, launcher: (entry: string) => boolean) =>
    Arr.join(
      Arr.filter(Str.split(list ?? "", ":"), (entry) => !launcher(entry)),
      ":",
    );
  const preload = without(LD_PRELOAD, (entry) => LAUNCHER_PRELOADS.has(entry));
  const libraries = without(LD_LIBRARY_PATH, (entry) => entry === bin);
  if (preload !== "") kept.LD_PRELOAD = preload;
  if (libraries !== "") kept.LD_LIBRARY_PATH = libraries;
  if (ICU_DATA !== undefined && ICU_DATA !== "" && ICU_DATA !== bin) kept.ICU_DATA = ICU_DATA;
  return kept;
};

/** Nothing started by Collie inherits the retired Herdr runtime's environment. */
export const withoutHerdrOne = (env: Readonly<Record<string, string | undefined>>) =>
  Rec.filter(env, (_, name) => !pipe(name, Str.startsWith("HERDR_")));

/** Removes the launcher's variables from this process, so nothing it starts later is given them. */
export const leaveLauncher = () => {
  // Children are given the process environment, not an Effect Config.
  // oxlint-disable-next-line effecttsgo/process-env
  const env = process.env;
  const kept = withoutLauncher(env);
  for (const name of Struct.keys(env)) if (!(name in kept)) delete env[name];
  Object.assign(env, kept);
};

import * as Struct from "effect/Struct";
import * as Str from "effect/String";
import { pipe } from "effect/Function";
import * as Rec from "effect/Record";
import * as Arr from "effect/Array";
import * as Path from "effect/Path";
import type { Asker } from "./proposals";
import { Config, Effect, Option } from "effect";
export const PLUGIN_ID = "cego.collie";

const paths = Effect.runSync(Effect.provide(Path.Path, Path.layer));

export interface PluginEnv {
  pluginRoot: string;
  home: string;
  collieDir: string;
  userDir: string;
  claudeManagedDir: string;
  stateDir: string;
  gitlabLogin: string | null;
  githubLogin: string | null;
  cwd: string;
  cwdExplicit: boolean;
  raw: Record<string, string>;
  machine?: string;
  caller?: string | null;
  asked?: string | null;
  hostStamp?: string;
  asker?: Asker;
  pairs?: boolean;
}

function first(env: Record<string, string | undefined>, ...keys: Array<string>) {
  for (const k of keys) {
    const v = env[k];
    if (v !== undefined && v !== "") {
      return v;
    }
  }
  return null;
}

// WARNING: execPath is the runner itself only under Bun's /$bunfs/ single-file build; otherwise it is bun.
export function ownRoot(
  modulePath: string = import.meta.path,
  execPath: string = process.execPath,
  collieDir: string | null = null,
) {
  if (!pipe(modulePath, Str.startsWith("/$bunfs/"))) {
    return null;
  }
  const at = Option.getOrElse(pipe(execPath, Str.lastIndexOf("/bin/")), () => -1);
  // WARNING: a downloaded runner upgrades the installation, never the caller's stale PWD.
  return at > 0
    ? pipe(execPath, Str.slice(0, at))
    : collieDir === null
      ? null
      : `${collieDir}/release`;
}

export function selfCommand(
  modulePath: string = import.meta.path,
  execPath: string = process.execPath,
  script: string = Bun.argv[1] ?? "",
) {
  return pipe(modulePath, Str.startsWith("/$bunfs/")) ? [execPath] : [execPath, script];
}

export function readEnv(
  env: Readonly<Record<string, string | undefined>>,
  installRoot: string | null = null,
) {
  const home = env.HOME ?? "/tmp";
  const collieDir = first(env, "COLLIE_DIR") ?? `${home}/.collie`;
  const pluginRoot =
    first(env, "COLLIE_ROOT") ??
    installRoot ??
    ownRoot(import.meta.path, process.execPath, collieDir) ??
    env.PWD ??
    ".";
  // WARNING: PWD goes stale after any chdir; the real directory never does.
  const explicitCwd = first(env, "COLLIE_CWD");
  const cwd = paths.resolve(explicitCwd ?? process.cwd());

  const raw: Record<string, string> = {};
  for (const [key, value] of Rec.toEntries(env)) {
    if (value !== undefined) {
      raw[key] = value;
    }
  }

  const returned: PluginEnv = {
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
  return returned;
}

const environmentKeys = [
  "HOME",
  "PWD",
  "PATH",
  "COLLIE_BIN_DIR",
  "COLLIE_CWD",
  "COLLIE_RUN",
  "COLLIE_AGENT",
  "COLLIE_TOOLS_ROLE",
  "OPENCODE_CONFIG_CONTENT",
  "HELLE_ENV_FILE",
  "CLAUDE_CONFIG_DIR",
  "COLLIE_HELLE_URL",
  "COLLIE_PROC",
  "COLLIE_ROOT",
  "COLLIE_DIR",
  "COLLIE_RELEASES",
  "COLLIE_USER_DIR",
  "COLLIE_CLAUDE_MANAGED_DIR",
  "COLLIE_STATE_DIR",
  "GITLAB_USER_LOGIN",
  "GITHUB_ACTOR",
  "GITTE_CWD",
  "XDG_DATA_HOME",
  "XDG_STATE_HOME",
  "HC_SOCKET",
  "HC_SESSION",
  "XDG_RUNTIME_DIR",
  "XDG_CONFIG_HOME",
  "HC_INSTALL_DIR",
] as const;

export const currentEnv = Effect.gen(function* () {
  const env: Record<string, string | undefined> = {};
  for (const key of environmentKeys) {
    const value = yield* Config.option(Config.String(key));
    if (Option.isSome(value)) {
      env[key] = value.value;
    }
  }
  return readEnv(env);
});

const LAUNCHER_PRELOADS = new Set(["./libcef.so", "./libvk_swiftshader.so"]);

// WARNING: library paths are known only from Desktop's bin; without one they are kept.
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
  if (preload !== "") {
    kept.LD_PRELOAD = preload;
  }
  if (libraries !== "") {
    kept.LD_LIBRARY_PATH = libraries;
  }
  if (ICU_DATA !== undefined && ICU_DATA !== "" && ICU_DATA !== bin) {
    kept.ICU_DATA = ICU_DATA;
  }
  return kept;
};

export const withoutHerdrOne = (env: Readonly<Record<string, string | undefined>>) =>
  Rec.filter(env, (_, name) => !pipe(name, Str.startsWith("HERDR_")));

export const leaveLauncher = () => {
  const env = process.env;
  const kept = withoutLauncher(env);
  for (const name of Struct.keys(env)) {
    if (!(name in kept)) {
      delete env[name];
    }
  }
  Object.assign(env, kept);
};

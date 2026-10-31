// How to start each supported agent CLI, pass it a model, and inject a Persona.
// Personas are injected, never installed as harness-native config (CONTEXT.md, Persona).

import * as Str from "effect/String";
import { pipe as pipe_ } from "effect/Function";
import * as Arr from "effect/Array";
import * as Rec from "effect/Record";
import { Effect, FileSystem, Option, Schema } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import type { PluginEnv } from "./env";
import { isJsonObject, isString, type JsonObject } from "./schema";
import { type AutoCompactWindow, autoCompactWindowOf, PERMISSION_MODES } from "./settings";
import { claudeTrust, type Trust } from "./trust";
import { DEFAULT_MODEL, HARNESS_MODELS, type HarnessModels } from "./harness-choice";
import type { YamlValue } from "./yaml";

export {
  DEFAULT_MODEL,
  harnessNames,
  knownModel,
  modelHint,
  preferencesIn,
  preferencesFromOptions,
  ceilingIn,
  foldPreferences,
  resolveChoice,
  foldCeiling,
  chainEntry,
  said,
  resolveWithRoom,
  pinned,
  type Preferences,
  type AgentChoice,
  type Room,
  type Chosen,
} from "./harness-choice";

export type PermissionMode = (typeof PERMISSION_MODES)[number];

const PERMISSION_MODE_SET: ReadonlySet<string> = new Set(PERMISSION_MODES);

export function isPermissionMode(value: string | undefined): value is PermissionMode {
  return value !== undefined && PERMISSION_MODE_SET.has(value);
}

/**
 * A `permissions` value from a config file or a definition's frontmatter, as written —
 * kept even when it is not a string. Every neighbouring key drops a non-string and falls
 * back, which is harmless when the fallback is the default harness or model. Here the
 * fallback is `auto`, so a dropped `permissions: false` would start an agent that
 * approves its own calls; kept as text, validation names it instead.
 */
export function permissionsAsWritten(value: YamlValue | undefined): string | undefined {
  if (value === undefined) return undefined;
  return isString(value) ? value : JSON.stringify(value);
}

const ManagedSettingsJson = Schema.fromJsonString(
  Schema.Struct({
    permissions: Schema.optional(
      Schema.Struct({ disableBypassPermissionsMode: Schema.optional(Schema.String) }),
    ),
  }),
);

/**
 * Whether Claude Code's managed settings — an organisation's, which no flag overrides —
 * disable its bypass mode, in the file itself or any file in its drop-in directory.
 */
export const claudeForbidsBypass = Effect.fn("Harness.claudeForbidsBypass")(function* (
  dir: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const dropIns = yield* fs
    .readDirectory(`${dir}/managed-settings.d`)
    .pipe(Effect.orElseSucceed((): ReadonlyArray<string> => []));
  const files = [
    `${dir}/managed-settings.json`,
    ...Arr.map(
      Arr.filter(dropIns, (name) => pipe_(name, Str.endsWith(".json"))),
      (name) => `${dir}/managed-settings.d/${name}`,
    ),
  ];
  for (const file of files) {
    const text = yield* fs.readFileString(file).pipe(Effect.orElseSucceed(() => ""));
    const settings = Schema.decodeOption(ManagedSettingsJson)(text);
    if (
      Option.isSome(settings) &&
      settings.value.permissions?.disableBypassPermissionsMode === "disable"
    )
      return true;
  }
  return false;
});

export interface McpLaunch {
  readonly command: ReadonlyArray<string>;
  readonly env: Readonly<Record<string, string>>;
  readonly config: string;
  readonly extension: string;
  readonly settings?: JsonObject;
  readonly effort?: string | null;
}

export interface HarnessAdapter extends HarnessModels {
  id: string;
  /** herdr agent kind, i.e. the canonical executable. */
  kind: string;
  modelArgs(model: string): string[];
  /**
   * Present when the harness takes a persona file as a flag. herdr rejects agent
   * arguments it cannot encode for the shell, so this takes a path, not the text.
   */
  personaArgs?(personaFile: string): string[];
  /** Present when the harness can be given a directory beyond the one it starts in. */
  dirArgs?(dir: string): string[];
  /** Present when the harness lets a Step ask for a reasoning effort level. */
  effortArgs?(effort: string): string[];
  /**
   * How this harness is told to review its own tool calls rather than ask (`auto`), or to
   * run them unasked (`bypass`). A mode left out starts it as `harness` does.
   */
  permissionArgs?: {
    readonly auto?: ReadonlyArray<string>;
    readonly bypass?: ReadonlyArray<string>;
  };
  /**
   * Present where an organisation's managed settings can forbid the bypass switch, which
   * no flag overrides. A bypass they forbid is started in auto mode instead.
   */
  bypassForbidden?(env: PluginEnv): Effect.Effect<boolean, never, FileSystem.FileSystem>;
  /** Present when the harness takes an auto-compact window: this flag, then the window. */
  autoCompactFlag?: string;
  /** Present when the harness asks before it will work in a directory. */
  trust?(home: string, backupDir: string): Trust;
  mcp(launch: McpLaunch): {
    readonly args: string[];
    readonly env: Readonly<Record<string, string>>;
  };
  /**
   * What the human channel types to *start* a skill in this harness. The skills
   * themselves are shared — `~/.agents/skills`, installed by skills.sh — so only the
   * syntax differs, and a harness with no slash form is asked for it in words. This
   * is not for mentioning a skill inside a prompt: nothing expands a slash command in
   * a file a model is handed. `skillMention` is the mention.
   */
  skillCommand(name: string): string;
  /**
   * What to check first when this harness stops producing output. Unset where nobody
   * has seen one hang: an invented hint is worse than none.
   */
  stuckHint?: string;
}

export interface Harnesses {
  readonly [name: string]: HarnessAdapter;
}

export const HARNESSES: Harnesses = {
  claude: {
    id: "claude",
    kind: "claude",
    mcp: ({ config }) => ({ args: ["--mcp-config", config], env: {} }),
    skillCommand: (name) => `/${name}`,
    stuckHint:
      "check your background shells with `/bashes`, read or kill any that will not finish (`BashOutput`, `KillShell`), and continue from there.",
    modelArgs: (model) => ["--model", model],
    personaArgs: (file) => ["--append-system-prompt-file", file],
    dirArgs: (dir) => ["--add-dir", dir],
    effortArgs: (effort) => ["--effort", effort],
    permissionArgs: {
      auto: ["--permission-mode", "auto"],
      bypass: ["--permission-mode", "bypassPermissions"],
    },
    bypassForbidden: (env) => claudeForbidsBypass(env.claudeManagedDir),
    autoCompactFlag: "--autocompact",
    trust: claudeTrust,
    ...HARNESS_MODELS.claude!,
  },
  codex: {
    id: "codex",
    kind: "codex",
    mcp: ({ command, env, effort }) => ({
      args: [
        ...(effort == null ? [] : ["-c", `model_reasoning_effort=${JSON.stringify(effort)}`]),
        "-c",
        `mcp_servers.collie.command=${JSON.stringify(command[0])}`,
        "-c",
        `mcp_servers.collie.args=${JSON.stringify([...command.slice(1), "mcp"])}`,
        ...Arr.flatMap(Rec.toEntries(env), ([key, value]) => [
          "-c",
          `mcp_servers.collie.env.${key}=${JSON.stringify(value)}`,
        ]),
      ],
      env: {},
    }),
    skillCommand: (name) => `the ${JSON.stringify(name)} skill`,
    modelArgs: (model) => ["-m", model],
    permissionArgs: {
      auto: ["--approve-for-me"],
      bypass: ["--dangerously-bypass-approvals-and-sandbox"],
    },
    ...HARNESS_MODELS.codex!,
  },
  pi: {
    id: "pi",
    kind: "pi",
    mcp: ({ extension }) => ({ args: ["-e", extension], env: {} }),
    skillCommand: (name) => `/skill:${name}`,
    modelArgs: (model) => ["--model", model],
    // pi reads a path here as file contents, so the persona file can be passed directly.
    personaArgs: (file) => ["--append-system-prompt", file],
    effortArgs: (effort) => ["--thinking", effort],
    // No permissionArgs: pi has no tool-approval prompt, and its `--approve` only
    // trusts project-local files (`pi --help`, checked 2026-09-03).
    ...HARNESS_MODELS.pi!,
  },
  opencode: {
    id: "opencode",
    kind: "opencode",
    mcp: ({ command, env, settings = {} }) => {
      const prior = settings.mcp;
      const mcp: JsonObject = isJsonObject(prior) ? prior : {};
      return {
        args: [],
        env: {
          OPENCODE_CONFIG_CONTENT: JSON.stringify({
            ...settings,
            mcp: {
              ...mcp,
              collie: {
                type: "local",
                command: [...command, "mcp"],
                environment: env,
                enabled: true,
              },
            },
          }),
        },
      };
    },
    skillCommand: (name) => `the ${JSON.stringify(name)} skill`,
    modelArgs: (model) => ["--model", model],
    // No auto mode: its `--auto` approves every call rather than reviewing it.
    permissionArgs: { bypass: ["--auto"] },
    ...HARNESS_MODELS.opencode!,
  },
};

/**
 * The OpenCode plugin that gives an agent on core its status, which OpenCode does not
 * report itself: OSC 7501 to `tty` from its own session's events. It also writes that
 * session's id to `sessionFile`, once, for the agent to be resumed in.
 */
export const opencodeReporter = (files: {
  sessionFile: string;
  tty: string;
}) => `import { linkSync, unlinkSync, writeFileSync } from "node:fs";

const tty = ${JSON.stringify(files.tty)};
const sessionFile = ${JSON.stringify(files.sessionFile)};
let own = null;

const report = (state) => {
  try {
    writeFileSync(tty, \`\\x1b]7501;state=\${state}:app=opencode\\x1b\\\\\`, { flag: "a" });
  } catch {}
};

// A subagent's session has a parent, and is not the agent's.
const record = (info) => {
  if (own !== null || !info || info.parentID) return;
  own = info.id;
  const written = \`\${sessionFile}.\${process.pid}\`;
  try {
    writeFileSync(written, own);
    linkSync(written, sessionFile);
  } catch {}
  try {
    unlinkSync(written);
  } catch {}
};

export const CollieStatus = async () => ({
  event: async ({ event }) => {
    const about = event.properties ?? {};
    switch (event.type) {
      case "session.created":
      case "session.updated":
        record(about.info);
        break;
      case "session.status":
        if (about.sessionID === own) report(about.status?.type === "idle" ? "idle" : "working");
        break;
      case "session.error":
        if (about.sessionID === own) report("error");
        break;
      case "permission.asked":
        report("blocked:kind=permission");
        break;
      case "question.asked":
        report("blocked:kind=question");
        break;
      case "permission.replied":
      case "question.replied":
      case "question.rejected":
        report("working");
        break;
    }
  },
});
`;

/** Args for `herdr agent start ... -- <args>`. */
export function startArgs(
  harness: HarnessAdapter,
  model: string,
  personaFile: string,
  effort?: string,
  permissions: PermissionMode = "auto",
  autoCompactWindow?: AutoCompactWindow,
): string[] {
  const selectedModel = model === DEFAULT_MODEL ? harness.defaultModel : model;
  return [
    ...(selectedModel ? harness.modelArgs(selectedModel) : []),
    ...(effort ? (harness.effortArgs?.(effort) ?? []) : []),
    ...(harness.personaArgs?.(personaFile) ?? []),
    ...(permissions === "harness" ? [] : (harness.permissionArgs?.[permissions] ?? [])),
    ...(harness.autoCompactFlag && autoCompactWindow !== undefined
      ? [harness.autoCompactFlag, String(autoCompactWindow)]
      : []),
  ];
}

/** Asked once per harness per process, as its version is: the binary does not change under a host. */
const helps = new Map<string, string>();

/** A harness's `--help` as installed; empty, and asked again, where it cannot be run. */
export const installedHelp = Effect.fn("Harness.installedHelp")(function* (kind: string) {
  const known = helps.get(kind);
  if (known !== undefined) return known;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const help = yield* spawner
    .string(ChildProcess.make(kind, ["--help"], { extendEnv: true }))
    .pipe(Effect.orElseSucceed(() => ""));
  if (help !== "") helps.set(kind, help);
  return help;
});

/**
 * The auto-compact window a harness is started with: the configured one as written, left
 * off where its `--help` does not list the flag, and refused where it would not take it.
 */
export const autoCompactWindowFor = Effect.fn("Harness.autoCompactWindowFor")(function* (
  harness: HarnessAdapter,
  written: number | string,
  help: typeof installedHelp,
) {
  const flag = harness.autoCompactFlag;
  if (flag === undefined) return { passed: null, leftOff: null };
  const window = autoCompactWindowOf(String(written));
  if ("refused" in window) return window;
  return new RegExp(`${flag}(?![\\w-])`).test(yield* help(harness.kind))
    ? { passed: window.window, leftOff: null }
    : { passed: null, leftOff: `${harness.kind} --help does not list ${flag}` };
});

/** Persona text to prepend to the first prompt when the harness has no flag for it. */
export function personaPrefix(harness: HarnessAdapter, persona: string): string {
  return harness.personaArgs ? "" : persona;
}

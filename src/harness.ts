import * as Str from "effect/String";
import { pipe as pipe_ } from "effect/Function";
import * as Arr from "effect/Array";
import * as Rec from "effect/Record";
import { Effect, FileSystem, Option, Schema } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import type { PluginEnv } from "./env";
import { isJsonObject, isString } from "./schema";
import type { JsonObject } from "./schema";
import { autoCompactWindowOf, PERMISSION_MODES } from "./settings";
import type { AutoCompactWindow } from "./settings";
import { claudeTrust } from "./trust";
import type { Trust } from "./trust";
import { DEFAULT_MODEL, HARNESS_MODELS, resolveWithRoom } from "./harness-choice";
import type { HarnessModels, Preferences } from "./harness-choice";
import { roomFor } from "./usage-model";
import type { UsageReading } from "./usage-model";
import type { YamlValue } from "./yaml";
import { stringifyJson } from "./json";

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

// WARNING: a configuration Collie cannot resolve is not known to be spent, so it counts as room.
export const hasAnyRoom = (
  defaults: {
    readonly harness?: string | undefined;
    readonly model?: string | undefined;
    readonly effort?: string | undefined;
    readonly fallbacks?: ReadonlyArray<string> | undefined;
    readonly models?: Readonly<Record<string, ReadonlyArray<string>>> | undefined;
  },
  readings: ReadonlyArray<UsageReading>,
  now: number,
) => {
  const layers: ReadonlyArray<Preferences> = [
    { harness: defaults.harness, model: defaults.model, effort: defaults.effort },
  ];
  const resolved = resolveWithRoom(
    layers,
    defaults.fallbacks ?? [],
    roomFor(readings, now),
    defaults.models,
  );
  return !resolved.ok || resolved.chosen.from !== null || resolved.chosen.why === null;
};

// WARNING: a Run is owed room on the agents it runs, not on the Machine's defaults, or another account's room clears it.
export const hasRoomFor = (
  defaults: Parameters<typeof hasAnyRoom>[0],
  ranOn: { readonly harness?: string; readonly model?: string; readonly effort?: string } | null,
  readings: ReadonlyArray<UsageReading>,
  now: number,
) =>
  hasAnyRoom(
    {
      ...defaults,
      harness: ranOn?.harness ?? defaults.harness,
      model: ranOn?.model ?? defaults.model,
      effort: ranOn?.effort ?? defaults.effort,
    },
    readings,
    now,
  );

const PERMISSION_MODE_SET: ReadonlySet<string> = new Set(PERMISSION_MODES);

export function isPermissionMode(value: string | undefined): value is PermissionMode {
  return value !== undefined && PERMISSION_MODE_SET.has(value);
}

// WARNING: Kept as written even when not a string: a dropped `permissions: false` would fall back to auto and approve its own calls.
export function permissionsAsWritten(value: YamlValue | undefined) {
  if (value === undefined) {
    return undefined;
  }
  return isString(value) ? value : stringifyJson(value);
}

const ManagedSettingsJson = Schema.fromJsonString(
  Schema.Struct({
    permissions: Schema.optional(
      Schema.Struct({ disableBypassPermissionsMode: Schema.optional(Schema.String) }),
    ),
  }),
);

// WARNING: Organisation managed settings forbid bypass, and no flag overrides them.
export const claudeForbidsBypass = Effect.fn("Harness.claudeForbidsBypass")(function* (
  dir: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const dropIns = yield* fs
    .readDirectory(`${dir}/managed-settings.d`)
    .pipe(Effect.orElseSucceed(() => []));
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
    ) {
      return true;
    }
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
  kind: string;
  modelArgs(model: string): Array<string>;
  // WARNING: Takes a path, not the text: herdr rejects agent arguments it cannot encode for the shell.
  personaArgs?(personaFile: string): Array<string>;
  dirArgs?(dir: string): Array<string>;
  effortArgs?(effort: string): Array<string>;
  permissionArgs?: {
    readonly auto?: ReadonlyArray<string>;
    readonly bypass?: ReadonlyArray<string>;
  };
  bypassForbidden?(env: PluginEnv): Effect.Effect<boolean, never, FileSystem.FileSystem>;
  autoCompactFlag?: string;
  trust?(home: string, backupDir: string): Trust;
  mcp(launch: McpLaunch): {
    readonly args: Array<string>;
    readonly env: Readonly<Record<string, string>>;
  };
  // WARNING: Only for starting a skill: nothing expands a slash command in a prompt, so mention one with skillMention.
  skillCommand(name: string): string;
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
        ...(effort == null ? [] : ["-c", `model_reasoning_effort=${stringifyJson(effort)}`]),
        "-c",
        `mcp_servers.collie.command=${stringifyJson(command[0])}`,
        "-c",
        `mcp_servers.collie.args=${stringifyJson([...command.slice(1), "mcp"])}`,
        ...Arr.flatMap(Rec.toEntries(env), ([key, value]) => [
          "-c",
          `mcp_servers.collie.env.${key}=${stringifyJson(value)}`,
        ]),
      ],
      env: {},
    }),
    skillCommand: (name) => `the ${stringifyJson(name)} skill`,
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
    // WARNING: pi reads a path here as file contents, so the persona file is passed directly.
    personaArgs: (file) => ["--append-system-prompt", file],
    effortArgs: (effort) => ["--thinking", effort],
    // WARNING: No permissionArgs: pi has no tool-approval prompt, and its --approve only trusts project-local files.
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
          OPENCODE_CONFIG_CONTENT: stringifyJson({
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
    skillCommand: (name) => `the ${stringifyJson(name)} skill`,
    modelArgs: (model) => ["--model", model],
    // WARNING: No auto mode: pi's --auto approves every call rather than reviewing it.
    permissionArgs: { bypass: ["--auto"] },
    ...HARNESS_MODELS.opencode!,
  },
};

export const opencodeReporter = (files: {
  sessionFile: string;
  tty: string;
  session?: string;
}) => `import { linkSync, unlinkSync, writeFileSync } from "node:fs";

const tty = ${stringifyJson(files.tty)};
const sessionFile = ${stringifyJson(files.sessionFile)};
let own = null;

const report = (state) => {
  try {
    writeFileSync(tty, \`\\x1b]7501;state=\${state}:app=opencode\\x1b\\\\\`, { flag: "a" });
  } catch {}
};

const keep = (id) => {
  own = id;
  const written = \`\${sessionFile}.\${process.pid}\`;
  try {
    writeFileSync(written, own);
    linkSync(written, sessionFile);
  } catch {}
  try {
    unlinkSync(written);
  } catch {}
};

// A subagent's session has a parent, and is not the agent's.
const record = (info) => {
  if (own === null && info && !info.parentID) keep(info.id);
};

const resumed = ${stringifyJson(files.session ?? null)};

export const CollieStatus = async () => {
  // A resumed session says nothing of itself until it is prompted.
  if (resumed !== null) {
    keep(resumed);
    report("idle");
  }
  return {
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
  };
};
`;

export const opencodeUsage = (file: string) => `import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

const file = ${JSON.stringify(file)};
try {
  mkdirSync(dirname(file), { recursive: true });
} catch {}
const parents = new Map();
const roles = new Map();
const write = (line) => {
  try {
    appendFileSync(file, JSON.stringify(line) + "\\n");
  } catch {}
};

export const CollieUsage = async () => ({
  event: async ({ event }) => {
    const about = event.properties ?? {};
    switch (event.type) {
      case "session.created":
      case "session.updated":
        if (about.info?.parentID) parents.set(about.info.id, about.info.parentID);
        break;
      case "message.updated": {
        const info = about.info;
        if (!info) break;
        roles.set(info.id, info.role);
        if (info.role === "assistant" && info.time?.completed)
          write({ type: "message", parent: parents.get(info.sessionID) ?? null, info });
        break;
      }
      case "message.part.updated": {
        const part = about.part;
        if (!part) break;
        const role = roles.get(part.messageID) ?? null;
        const parent = parents.get(part.sessionID) ?? null;
        const kept = { id: part.id, sessionID: part.sessionID, messageID: part.messageID, type: part.type, callID: part.callID };
        if (part.type === "tool" && part.state?.status === "completed")
          write({ type: "part", parent, role, chars: String(part.state.output ?? "").length, part: kept });
        else if (part.type === "text" && role === "user")
          write({ type: "part", parent, role, part: { ...kept, text: String(part.text ?? "").slice(0, 400) } });
        break;
      }
    }
  },
});
`;

export function startArgs(
  harness: HarnessAdapter,
  model: string,
  personaFile: string,
  effort?: string,
  permissions: PermissionMode = "auto",
  autoCompactWindow?: AutoCompactWindow,
) {
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

// WARNING: Cached per process: the binary does not change under a running host.
const helps = new Map<string, string>();

// WARNING: Empty, and not cached, where the harness cannot be run.
export const installedHelp = Effect.fn("Harness.installedHelp")(function* (kind: string) {
  const known = helps.get(kind);
  if (known !== undefined) {
    return known;
  }
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const help = yield* spawner
    .string(ChildProcess.make(kind, ["--help"], { extendEnv: true }))
    .pipe(Effect.orElseSucceed(() => ""));
  if (help !== "") {
    helps.set(kind, help);
  }
  return help;
});

export const autoCompactWindowFor = Effect.fn("Harness.autoCompactWindowFor")(function* (
  harness: HarnessAdapter,
  written: number | string,
  help: typeof installedHelp,
) {
  const flag = harness.autoCompactFlag;
  if (flag === undefined) {
    return { passed: null, leftOff: null };
  }
  const window = autoCompactWindowOf(String(written));
  if ("refused" in window) {
    return window;
  }
  return new RegExp(`${flag}(?![\\w-])`).test(yield* help(harness.kind))
    ? { passed: window.window, leftOff: null }
    : { passed: null, leftOff: `${harness.kind} --help does not list ${flag}` };
});

export function personaPrefix(harness: HarnessAdapter, persona: string) {
  return harness.personaArgs ? "" : persona;
}

export interface StartSession {
  readonly id: string;
  readonly resumed: boolean;
}

export interface SessionArgs {
  readonly lead: ReadonlyArray<string>;
  readonly tail: ReadonlyArray<string>;
}

export const sessionArgs = (harness: string, session: StartSession) => {
  const { id } = session;
  if (!session.resumed) {
    return { lead: [], tail: ["--session-id", id] };
  }
  switch (harness) {
    case "codex":
      return { lead: ["resume", id], tail: [] };
    case "claude":
      return { lead: [], tail: ["--resume", id] };
    case "opencode":
      return { lead: [], tail: ["--session", id] };
    default:
      return { lead: [], tail: ["--session-id", id] };
  }
};

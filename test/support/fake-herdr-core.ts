// Fake herdr. Records every invocation and answers with canned ids so a whole
// run can be driven without a herdr server.

import { Cause, Config, Effect, FileSystem, Option, Path, Schema, Semaphore } from "effect";

interface FakeTab {
  tab_id: string;
  label: string;
}

interface FakePane {
  pane_id: string;
  tab_id: string;
  label: string | null;
  /** Where the pane's process was started, which is what a worktree check reads. */
  cwd?: string | null;
  agent?: string | null;
  agent_status?: string | null;
  workspace_id?: string | null;
  foreground_cwd?: string | null;
  /** What a plugin attached, which is what the Home's ownership proof reads back. */
  tokens?: Record<string, string>;
  terminal_id?: string | null;
}

interface FakeAgent {
  name: string;
  pane_id: string;
  /** herdr's identity for the process; defaulted per name unless a test pins one. */
  terminal_id?: string;
}

/** A workspace herdr has. Empty by default: a test that cares adds its own. */
interface FakeWorkspace {
  workspace_id: string;
  label: string;
  cwd?: string | null;
  /** As on a pane: what `workspace.report_metadata` attached. */
  tokens?: Record<string, string>;
}

interface FakeWorktree {
  path: string;
  branch: string;
  /** Null for a checkout herdr has no workspace open on, which is git's own. */
  open_workspace_id: string | null;
}

interface State {
  tabs: number;
  panes: number;
  outputs: number;
  statusReads: number;
  paneReads: number;
  failures: number;
  prompts: number;
  echoed: number;
  blocked: number;
  tabList: FakeTab[];
  paneList: FakePane[];
  agents: FakeAgent[];
  workspaces: FakeWorkspace[];
  worktrees: FakeWorktree[];
  /** The repository's own checkout, which is what herdr answers `list` with. */
  worktreeSource: string | undefined;
}

type FakeRecord = { transport: "cli"; cmd: string; argv: string[] };
interface FakeEnvelope {
  id: string;
  result?: object;
  error?: object;
}

export interface FakeResult {
  code: number;
  stdout: string;
  stderr: string;
}

const FakeTabSchema = Schema.Struct({ tab_id: Schema.String, label: Schema.String });
const FakePaneSchema = Schema.Struct({
  pane_id: Schema.String,
  tab_id: Schema.String,
  label: Schema.NullOr(Schema.String),
  /** What a plugin has attached to it. The Home's ownership proof rests on one of these. */
  tokens: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
  terminal_id: Schema.optionalKey(Schema.NullOr(Schema.String)),
  cwd: Schema.optionalKey(Schema.NullOr(Schema.String)),
  agent: Schema.optionalKey(Schema.NullOr(Schema.String)),
  agent_status: Schema.optionalKey(Schema.NullOr(Schema.String)),
  workspace_id: Schema.optionalKey(Schema.NullOr(Schema.String)),
  foreground_cwd: Schema.optionalKey(Schema.NullOr(Schema.String)),
});
const FakeAgentSchema = Schema.Struct({
  name: Schema.String,
  pane_id: Schema.String,
  terminal_id: Schema.optionalKey(Schema.String),
});
const FakeWorkspaceSchema = Schema.Struct({
  workspace_id: Schema.String,
  label: Schema.String,
  cwd: Schema.optionalKey(Schema.NullOr(Schema.String)),
  /** As on a pane: what `workspace.report_metadata` attached, which is what owns a Home. */
  tokens: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
});
const FakeWorktreeSchema = Schema.Struct({
  path: Schema.String,
  branch: Schema.String,
  open_workspace_id: Schema.NullOr(Schema.String),
});
/** The metadata file the socket side writes: tokens by workspace id and by pane id. */
const TokensJson = Schema.fromJsonString(
  Schema.Record(
    Schema.Literals(["workspaces", "panes"]),
    Schema.Record(Schema.String, Schema.Record(Schema.String, Schema.String)),
  ),
);

const StateJson = Schema.fromJsonString(
  Schema.Struct({
    tabs: Schema.optionalKey(Schema.Number),
    panes: Schema.optionalKey(Schema.Number),
    outputs: Schema.optionalKey(Schema.Number),
    statusReads: Schema.optionalKey(Schema.Number),
    paneReads: Schema.optionalKey(Schema.Number),
    failures: Schema.optionalKey(Schema.Number),
    prompts: Schema.optionalKey(Schema.Number),
    echoed: Schema.optionalKey(Schema.Number),
    blocked: Schema.optionalKey(Schema.Number),
    tabList: Schema.optionalKey(Schema.Array(FakeTabSchema)),
    paneList: Schema.optionalKey(Schema.Array(FakePaneSchema)),
    agents: Schema.optionalKey(Schema.Array(FakeAgentSchema)),
    workspaces: Schema.optionalKey(Schema.Array(FakeWorkspaceSchema)),
    worktrees: Schema.optionalKey(Schema.Array(FakeWorktreeSchema)),
    worktreeSource: Schema.optionalKey(Schema.String),
  }),
);
const FailuresJson = Schema.fromJsonString(Schema.Record(Schema.String, Schema.String));
const OutputWrites = Schema.Record(Schema.String, Schema.String);
const QueuedObjectJson = Schema.Union([
  Schema.Struct({
    __delay_ms: Schema.Number,
    __write: Schema.optionalKey(OutputWrites),
    output: Schema.optionalKey(Schema.Any),
  }),
  Schema.Struct({
    __delay_ms: Schema.optionalKey(Schema.Number),
    __write: OutputWrites,
    output: Schema.optionalKey(Schema.Any),
  }),
]);
const QueuedOutputJson = Schema.Union([
  Schema.String,
  Schema.Null,
  QueuedObjectJson,
  Schema.JsonObject,
]);
const QueueJson = Schema.fromJsonString(Schema.Array(QueuedOutputJson));
const JsonRecord = Schema.fromJsonString(Schema.Any);
const encodeJson = Schema.encodeSync(JsonRecord);
const emptyFailures: Record<string, string> = {};

const emptyState = (): State => ({
  tabs: 0,
  panes: 0,
  outputs: 0,
  statusReads: 0,
  paneReads: 0,
  failures: 0,
  prompts: 0,
  echoed: 0,
  blocked: 0,
  tabList: [],
  paneList: [],
  agents: [],
  workspaces: [],
  worktrees: [],
  worktreeSource: undefined,
});

function mutableState(state: State | Schema.Schema.Type<typeof StateJson>): State {
  return {
    tabs: state.tabs ?? 0,
    panes: state.panes ?? 0,
    outputs: state.outputs ?? 0,
    statusReads: state.statusReads ?? 0,
    paneReads: state.paneReads ?? 0,
    failures: state.failures ?? 0,
    prompts: state.prompts ?? 0,
    echoed: state.echoed ?? 0,
    blocked: state.blocked ?? 0,
    tabList: (state.tabList ?? []).map((tab) => ({ tab_id: tab.tab_id, label: tab.label })),
    paneList: (state.paneList ?? []).map((pane) => ({
      pane_id: pane.pane_id,
      tab_id: pane.tab_id,
      label: pane.label,
      cwd: pane.cwd ?? null,
      agent: pane.agent ?? null,
      agent_status: pane.agent_status ?? null,
      workspace_id: pane.workspace_id ?? null,
      foreground_cwd: pane.foreground_cwd ?? null,
    })),
    agents: (state.agents ?? []).map((agent) => ({ name: agent.name, pane_id: agent.pane_id })),
    workspaces: (state.workspaces ?? []).map((workspace) => ({ ...workspace })),
    worktrees: (state.worktrees ?? []).map((worktree) => ({ ...worktree })),
    worktreeSource: state.worktreeSource,
  };
}

/**
 * One call at a time. The fake keeps its state in a JSON file it reads, edits and writes
 * back; Collie now sends to several agents at once, and two concurrent calls would both
 * read the same output-queue index. A real herdr serialises on its own socket, so this is
 * the fake catching up with what it is standing in for, not a test-only relaxation.
 */
const turn = Semaphore.makeUnsafe(1);

export function fakeHerdr(
  argv: string[],
  environment: Readonly<Record<string, string | undefined>> = {},
): Effect.Effect<FakeResult, never, FileSystem.FileSystem | Path.Path> {
  return turn.withPermits(1)(handle(argv, environment));
}

function handle(
  argv: string[],
  environment: Readonly<Record<string, string | undefined>>,
): Effect.Effect<FakeResult, never, FileSystem.FileSystem | Path.Path> {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const envString = (name: string, fallback = "") => {
      const value = environment[name];
      return value === undefined
        ? Config.String(name).pipe(Config.withDefault(Bun.env[name] ?? fallback))
        : Config.succeed(value);
    };
    const log = yield* envString("FAKE_HERDR_LOG");
    const statePath = `${log}.state.json`;
    /**
     * The plugin metadata `*.report_metadata` attached, which only the socket side sees.
     * Its own file, so the two writers never share one: this is read here and merged into
     * whatever `workspace list` and `pane list` answer.
     */
    const tokensFor = Effect.fn("fake.tokensFor")(function* (on: "workspaces" | "panes") {
      const raw = yield* fs
        .readFileString(`${log}.tokens.json`, "utf8")
        .pipe(Effect.catch(() => Effect.succeed("")));
      const held = Schema.decodeUnknownOption(TokensJson)(raw);
      return held._tag === "Some" ? (held.value[on] ?? {}) : {};
    });

    const readState = (file: string) =>
      fs.readFileString(file, "utf8").pipe(
        Effect.map((text) =>
          mutableState(Option.getOrElse(Schema.decodeUnknownOption(StateJson)(text), emptyState)),
        ),
        Effect.catch(() => Effect.succeed(emptyState())),
      );
    const readQueue = (file: string) =>
      fs.readFileString(file, "utf8").pipe(
        Effect.map((text) =>
          Option.getOrElse(Schema.decodeUnknownOption(QueueJson)(text), () => []),
        ),
        Effect.catch(() => Effect.succeed([])),
      );
    const writeJson = (file: string, value: State | FakeRecord | FakeEnvelope) =>
      fs.writeFileString(file, `${encodeJson(value)}\n`);
    const flag = (name: string): string | undefined => {
      const at = argv.indexOf(name);
      return at >= 0 ? argv[at + 1] : undefined;
    };

    const cmd = argv.slice(0, 2).join(" ");
    yield* fs.makeDirectory(path.dirname(log), { recursive: true });
    yield* fs.writeFileString(
      log,
      `${encodeJson({ transport: "cli", cmd, argv } satisfies FakeRecord)}\n`,
      { flag: "a" },
    );

    const failuresText = yield* envString("FAKE_HERDR_FAIL", "{}");
    const failures = Option.getOrElse(
      Schema.decodeUnknownOption(FailuresJson)(failuresText),
      () => emptyFailures,
    );
    const failure = failures[cmd];
    // `FAKE_HERDR_FAIL_TIMES` makes a failure transient: the first N calls fail and
    // the rest answer, which is a hiccup rather than a verdict.
    const failTimes = Number.parseInt(yield* envString("FAKE_HERDR_FAIL_TIMES", "0"), 10);
    if (failure) {
      const state = yield* readState(statePath);
      const seen = (state.failures ?? 0) + 1;
      state.failures = seen;
      yield* writeJson(statePath, state);
      if (failTimes <= 0 || seen <= failTimes) {
        return { code: 1, stdout: "", stderr: `${failure}\n` };
      }
    }

    const state = yield* readState(statePath);
    const blockFor = Number.parseInt(yield* envString("FAKE_HERDR_BLOCK_START", "0"), 10);

    function newTab(label: string): FakeTab {
      const tab = { tab_id: `1:${(state.tabs += 1)}`, label };
      state.tabList.push(tab);
      return tab;
    }

    function newPane(tabId: string, label: string | null = null, workspaceId?: string): FakePane {
      const pane = {
        pane_id: `1-${(state.panes += 1)}`,
        tab_id: tabId,
        label,
        // The workspace it was opened in. herdr reports this on every pane, and the
        // Home's ownership proof is "the recorded pane, in the recorded workspace" —
        // so a pane that always claimed workspace 1 lost the proof every time.
        workspace_id: workspaceId ?? null,
      };
      state.paneList.push(pane);
      return pane;
    }

    const tabOf = (paneId: string) =>
      state.paneList.find((p) => p.pane_id === paneId)?.tab_id ?? "1:0";

    if (blockFor > 0 && cmd === "agent start" && state.blocked === 0) {
      const name = argv[2] ?? "";
      if (!state.agents.some((agent) => agent.name === name))
        state.agents.push({ name, pane_id: flag("--pane") ?? "" });
      state.blocked = 1;
      yield* writeJson(statePath, state);
      return {
        code: 1,
        stderr: "",
        stdout: `${encodeJson({
          id: "cli:agent:start",
          error: {
            code: "agent_not_ready",
            message: `agent ${argv[2]} is blocked during startup and is not ready for prompts`,
          },
        })}\n`,
      };
    }

    // `pane read` answers with terminal text, not an envelope. FAKE_HERDR_PANE_TEXT
    // is what it says; `changing` makes it different on every read, which is what a
    // step that is still working looks like.
    if (cmd === "pane read") {
      const text = yield* envString("FAKE_HERDR_PANE_TEXT", "");
      state.paneReads += 1;
      // `changing` is an agent that keeps working; `prompts` is a pane that only
      // changes when something is typed into it, which is what a nudge does.
      // `echo` is the agent that answers a nudge a moment later and then goes quiet
      // again: this read returns what the pane held at the last one, so the change
      // lands on the poll *after* the prompt rather than in the same breath as it.
      let body = text;
      if (text === "changing") body = `line ${state.paneReads}`;
      if (text === "prompts") body = `prompt ${state.prompts}`;
      if (text === "echo") {
        body = `prompt ${state.echoed}`;
        state.echoed = state.prompts;
      }
      yield* writeJson(statePath, state);
      return { code: 0, stdout: `${body}\n`, stderr: "" };
    }

    // What `doctor` asks of herdr, both plain text rather than an envelope, and both
    // scripted per test: the version this machine has, and what it has linked.
    if (cmd === "--version") {
      const version = yield* envString("FAKE_HERDR_VERSION", "herdr 0.9.0");
      return { code: 0, stdout: `${version}\n`, stderr: "" };
    }
    if (cmd === "plugin list") {
      return { code: 0, stdout: `${yield* envString("FAKE_HERDR_PLUGINS", "")}\n`, stderr: "" };
    }

    // What the socket boundary falls back to when HERDR_SOCKET_PATH is unset: herdr's
    // own idea of where its running server's socket is. `FAKE_HERDR_STATUS` scripts a
    // stopped server or a malformed reply; `FAKE_HERDR_STATUS_SOCKET` overrides which
    // socket a running one reports, defaulting to this process's own.
    if (cmd === "status server") {
      const mode = yield* envString("FAKE_HERDR_STATUS", "running");
      if (mode === "malformed") {
        return { code: 0, stdout: `${encodeJson({ nonsense: true })}\n`, stderr: "" };
      }
      if (mode === "stopped") {
        return {
          code: 0,
          stdout: `${encodeJson({ status: "stopped", running: false })}\n`,
          stderr: "",
        };
      }
      const fallbackSocket = yield* envString("HERDR_SOCKET_PATH", "");
      const socket = yield* envString("FAKE_HERDR_STATUS_SOCKET", fallbackSocket);
      return {
        code: 0,
        stdout: `${encodeJson({
          status: "running",
          running: true,
          socket: socket || null,
          session: null,
        })}\n`,
        stderr: "",
      };
    }

    // The installed binary's own description of what it can do, which the Home's
    // runtime gate reads. Only what the gate reads: the real document is a quarter of a
    // megabyte, and a fake that pushed that down a pipe was testing Bun's writes rather
    // than the gate. `FAKE_HERDR_RUNTIME_MISSING` names what this herdr does *not*
    // declare, which is how a test reaches the refusal.
    if (cmd === "api schema") {
      const absent = (yield* envString("FAKE_HERDR_RUNTIME_MISSING", ""))
        .split(",")
        .filter((name) => name !== "");
      const declared = (name: string) => !absent.includes(name);
      const properties = (...fields: string[]) =>
        Object.fromEntries(fields.filter(declared).map((field) => [field, {}]));
      const methods = ["workspace.report_metadata", "pane.report_metadata", "workspace.create"]
        .filter(declared)
        .map((method) => ({ method }));
      return {
        code: 0,
        stdout: `${encodeJson({
          protocol: 20,
          schemas: {
            socket: {
              methods,
              $defs: {
                WorkspaceInfo: { properties: properties("workspace_id", "tokens") },
                PaneInfo: { properties: properties("pane_id", "tokens", "terminal_id") },
              },
            },
          },
        })}\n`,
        stderr: "",
      };
    }

    if (cmd === "agent prompt") {
      state.prompts += 1;
      yield* writeJson(statePath, state);
      // Fails every prompt from the Nth on, so a test can let a step start and then
      // take the channel away — which is what a repair prompt meets when its agent
      // has gone.
      const failFrom = Number.parseInt(yield* envString("FAKE_HERDR_FAIL_PROMPT_FROM", "0"), 10);
      if (failFrom > 0 && state.prompts >= failFrom) {
        return { code: 1, stdout: "", stderr: `no agent ${argv[2]}\n` };
      }
      // The code `--wait` answers a submission with, exit 1 and an envelope on stdout
      // the way herdr really answers one: `agent_prompt_stalled` for a lost Enter,
      // `timeout` for a wait the caller ran out of.
      const code = yield* envString("FAKE_HERDR_PROMPT_ERROR", "");
      const answered = {
        code: 1,
        stdout: `${encodeJson({
          id: "cli:agent:prompt",
          error: { code, message: `agent prompt answered ${code}` },
        })}\n`,
        stderr: "",
      };
      // A `timeout` is a wait that ran out, not a prompt that was lost: the text and the
      // Enter were written, and the agent works on it whether or not herdr saw the turn
      // start. So the Output is still produced, and then the wait's answer is given.
      if (code !== "" && code !== "timeout") return answered;
      const line = argv[3] ?? "";
      const ref = /is in (\S+\.md) /.exec(line);
      const text =
        ref && (yield* fs.exists(ref[1]!)) ? yield* fs.readFileString(ref[1]!, "utf8") : line;
      const match = /^OUTPUT_PATH: (.+)$/m.exec(text);
      const queuePath = yield* envString("FAKE_HERDR_OUTPUTS");
      if (match && queuePath !== "" && (yield* fs.exists(queuePath))) {
        const queue = yield* readQueue(queuePath);
        const next = queue[state.outputs];
        state.outputs += 1;
        if (next !== undefined && next !== null) {
          const outputPath = match[1]!.trim();
          const delayed = Schema.decodeUnknownOption(QueuedObjectJson)(next);
          yield* fs.makeDirectory(path.dirname(outputPath), { recursive: true });
          if (Option.isSome(delayed) && delayed.value.__write) {
            let dir = path.dirname(outputPath);
            while (dir !== "/" && !(yield* fs.exists(path.join(dir, "run.json"))))
              dir = path.dirname(dir);
            for (const [rel, body] of Object.entries(delayed.value.__write)) {
              const writePath = path.join(dir, rel);
              yield* fs.makeDirectory(path.dirname(writePath), { recursive: true });
              yield* fs.writeFileString(writePath, body);
            }
          }
          if (Option.isSome(delayed) && Number.isFinite(delayed.value.__delay_ms)) {
            const body = encodeJson(delayed.value.output ?? {});
            yield* Effect.sync(() => {
              Bun.spawn(
                [
                  "bun",
                  "-e",
                  `await Bun.sleep(${delayed.value.__delay_ms}); await Bun.write(${encodeJson(outputPath)}, ${encodeJson(body)});`,
                ],
                { stdout: "ignore", stderr: "ignore", stdin: "ignore" },
              ).unref();
            });
          } else if (Option.isSome(delayed) && delayed.value.__write) {
            yield* fs.writeFileString(outputPath, encodeJson(delayed.value.output ?? {}));
          } else if (Option.isSome(delayed)) {
            yield* fs.writeFileString(outputPath, encodeJson(delayed.value));
          } else {
            const plain = Schema.decodeUnknownOption(Schema.String)(next);
            yield* fs.writeFileString(
              outputPath,
              Option.isSome(plain) ? plain.value : encodeJson(next),
            );
          }
        }
      }
      if (code === "timeout") return answered;
    }

    let result = {};
    switch (cmd) {
      case "tab create": {
        const tab = newTab(flag("--label") ?? String(state.tabs + 1));
        result = { type: "tab_created", tab, root_pane: newPane(tab.tab_id) };
        break;
      }
      case "tab close": {
        const tabId = argv[2] ?? "";
        state.tabList = state.tabList.filter((t) => t.tab_id !== tabId);
        state.paneList = state.paneList.filter((p) => p.tab_id !== tabId);
        break;
      }
      case "tab rename": {
        const tab = state.tabList.find((t) => t.tab_id === argv[2]);
        if (tab) tab.label = argv[3] ?? tab.label;
        break;
      }
      case "workspace list": {
        const held = yield* tokensFor("workspaces");
        result = {
          type: "workspace_list",
          workspaces: state.workspaces.map((w) => ({
            ...w,
            tokens: { ...w.tokens, ...held[w.workspace_id] },
          })),
        };
        break;
      }
      case "workspace create": {
        const workspace = {
          workspace_id: `w${state.workspaces.length + 1}`,
          label: flag("--label") ?? "",
          cwd: flag("--cwd") ?? null,
        };
        state.workspaces.push(workspace);
        yield* writeJson(statePath, state);
        // herdr's own reply: the new workspace comes with a shell tab.
        const tab = { tab_id: `${workspace.workspace_id}-t1`, label: "1" };
        const root_pane = { pane_id: `${workspace.workspace_id}-p1`, tab_id: tab.tab_id };
        result = { type: "workspace_created", workspace, tab, root_pane };
        break;
      }
      case "tab list":
        result = {
          type: "tab_list",
          tabs: state.tabList.map((t) => ({ ...t, workspace_id: "1" })),
        };
        break;
      case "pane split":
        result = { type: "pane_split", pane: newPane(tabOf(argv[2]!)) };
        break;
      case "pane rename": {
        const pane = state.paneList.find((p) => p.pane_id === argv[2]);
        if (pane) pane.label = argv[3] ?? pane.label;
        break;
      }
      case "pane close":
        state.paneList = state.paneList.filter((p) => p.pane_id !== argv[2]);
        break;
      case "pane move": {
        const tabId = flag("--tab") ?? "";
        const pane = state.paneList.find((p) => p.pane_id === argv[2]);
        if (pane) pane.tab_id = tabId;
        else state.paneList.push({ pane_id: argv[2]!, tab_id: tabId, label: null });
        result = { type: "pane_move", move_result: { changed: true } };
        break;
      }
      case "pane list": {
        const held = yield* tokensFor("panes");
        result = {
          type: "pane_list",
          // A pane herdr made carries the workspace it was made in; one a test placed
          // may name its own.
          panes: state.paneList.map((p) => ({
            ...p,
            workspace_id: p.workspace_id ?? "1",
            tokens: { ...p.tokens, ...held[p.pane_id] },
            // A pane herdr made has a terminal behind it; its id is the other half of
            // the Home's ownership proof, so it is as stable as the pane's own id.
            terminal_id: p.terminal_id ?? `t-${p.pane_id}`,
          })),
        };
        break;
      }
      case "plugin pane": {
        const target = flag("--target-pane");
        const tabId =
          flag("--placement") === "split" && target ? tabOf(target) : newTab("plugin").tab_id;
        result = {
          type: "plugin_pane_opened",
          plugin_pane: {
            entrypoint: flag("--entrypoint") ?? "",
            pane: newPane(tabId, null, flag("--workspace")),
          },
        };
        break;
      }
      case "agent start":
        state.agents.push({ name: argv[2]!, pane_id: flag("--pane") ?? "" });
        result = { type: "agent_started" };
        break;
      case "agent list": {
        const gone = new Set(
          (yield* envString("FAKE_HERDR_AGENTS_GONE")).split(",").filter((n) => n),
        );
        const status = yield* envString("FAKE_HERDR_AGENT_STATUS", "idle");
        result = {
          type: "agent_list",
          agents: state.agents
            .filter((a) => !gone.has(a.name))
            .map((a) => ({
              ...a,
              agent_status: status,
              // herdr names every live agent's process; Collie's registry records it as
              // the incarnation, so the fake has to have one or nothing is deliverable.
              terminal_id: a.terminal_id ?? `term-${a.name}`,
            })),
        };
        break;
      }
      case "agent get": {
        // A named agent herdr has been told to forget: `agent get` fails, the way it
        // does for a closed tab or a killed pane.
        if (
          (yield* envString("FAKE_HERDR_AGENTS_GONE"))
            .split(",")
            .filter((n) => n)
            .includes(argv[2] ?? "")
        ) {
          // herdr answers a missing target the way it really does: exit 0 with an
          // error envelope naming the code, not a failed process.
          return {
            code: 0,
            stdout: `${encodeJson({
              id: "cli:agent:get",
              error: { code: "agent_not_found", message: `agent target ${argv[2]} not found` },
            })}\n`,
            stderr: "",
          };
        }
        // A comma-separated list is read one per call, the last value repeating, so a
        // test can script "working for a while, then idle".
        const scripted = (yield* envString("FAKE_HERDR_AGENT_STATUS", "idle")).split(",");
        let status = scripted[Math.min(state.statusReads, scripted.length - 1)] ?? "idle";
        state.statusReads += 1;
        if (state.blocked > 0 && state.blocked <= blockFor) {
          status = "blocked";
          state.blocked += 1;
        }
        result = { type: "agent", agent: { agent_status: status } };
        break;
      }
      // A worktree-backed workspace, as herdr makes one: the checkout is a real
      // directory, because whatever runs there has to be able to cd into it.
      case "worktree list": {
        // The repository's own checkout, whichever of its checkouts is asking: that is
        // what herdr answers with, and it is the only place open and create may run.
        const asked = flag("--cwd") ?? "";
        const source = state.worktrees.some((w) => w.path === asked)
          ? (state.worktreeSource ?? asked)
          : asked;
        result = {
          type: "worktree_list",
          source: { repo_root: source, source_checkout_path: source },
          worktrees: state.worktrees,
        };
        break;
      }
      case "worktree create":
      case "worktree open": {
        // herdr answers both from the repository's own checkout only: from a linked
        // worktree it refuses with `linked_worktree_source`.
        const from = flag("--cwd") ?? "";
        if (state.worktrees.some((w) => w.path === from)) {
          return {
            code: 0,
            stderr: "",
            stdout: `${encodeJson({
              id: `cli:${cmd.replace(" ", ":")}`,
              error: {
                code: "linked_worktree_source",
                message: "New and open worktree actions start from the repo parent workspace.",
              },
            })}\n`,
          };
        }
        const branch = flag("--branch") ?? "";
        const asked = flag("--path");
        const known = state.worktrees.find((w) => (asked ? w.path === asked : w.branch === branch));
        const worktree =
          known ??
          ({
            path: asked ?? path.join(path.dirname(log), "worktrees", branch),
            branch,
            open_workspace_id: `w${state.worktrees.length + 1}`,
          } satisfies FakeWorktree);
        if (!known) {
          state.worktrees.push(worktree);
          state.worktreeSource ??= from;
        }
        yield* fs.makeDirectory(worktree.path, { recursive: true });
        // The `.git` file git writes at `worktree add`, which is a checkout's identity.
        if (!(yield* fs.exists(`${worktree.path}/.git`))) {
          yield* fs.writeFileString(`${worktree.path}/.git`, `gitdir: ${worktree.path}/.gitdir\n`);
        }
        const opened = {
          type: cmd === "worktree create" ? "worktree_created" : "worktree_opened",
          worktree,
          workspace: {
            workspace_id: worktree.open_workspace_id,
            label: flag("--label") ?? worktree.branch,
            worktree: { checkout_path: worktree.path },
          },
        };
        // `create` makes the workspace, so it always answers with the one numbered shell
        // tab that workspace comes with; `open` reuses a workspace and sends neither key.
        if (cmd === "worktree open") {
          result = opened;
        } else {
          const rootTab = newTab(String(state.tabs + 1));
          result = { ...opened, tab: rootTab, root_pane: newPane(rootTab.tab_id) };
        }
        break;
      }
      case "worktree remove": {
        const workspace = flag("--workspace");
        const gone = state.worktrees.find((w) => w.open_workspace_id === workspace);
        state.worktrees = state.worktrees.filter((w) => w !== gone);
        result = { type: "worktree_removed", path: gone?.path ?? "", forced: false };
        break;
      }
      default:
        result = { type: "ok" };
    }

    yield* writeJson(statePath, state);
    return { code: 0, stdout: `${encodeJson({ id: "fake", result })}\n`, stderr: "" };
  }).pipe(
    Effect.catchCause((cause) =>
      Effect.succeed({ code: 1, stdout: "", stderr: `${Cause.pretty(cause)}\n` }),
    ),
  );
}

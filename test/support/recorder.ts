// Test rig: a temp plugin sandbox, a fake `herdr` on HERDR_BIN_PATH and a fake
// socket on HERDR_SOCKET_PATH, both recording into one ordered log.

import {
  Config,
  Effect,
  Fiber,
  FileSystem,
  Option,
  Path,
  PlatformError,
  Queue,
  Schema,
} from "effect";
import { readEnv, type PluginEnv } from "../../src/env";
import { Herdr } from "../../src/herdr";
import { fakeHerdr } from "./fake-herdr-core";

const JsonString = Schema.fromJsonString(Schema.Json);
const JsonObjectString = Schema.fromJsonString(Schema.JsonObject);
const encodeJson = Schema.encodeSync(JsonString);

const FailuresSchema = Schema.Record(Schema.String, Schema.String);

const RpcRequest = Schema.Struct({
  id: Schema.String,
  method: Schema.String,
  params: Schema.optionalKey(Schema.JsonObject),
});
const RpcRequestString = Schema.fromJsonString(RpcRequest);

const CallSchema = Schema.Struct({
  transport: Schema.Union([Schema.Literal("cli"), Schema.Literal("rpc")]),
  cmd: Schema.String,
  argv: Schema.optionalKey(Schema.Array(Schema.String)),
  method: Schema.optionalKey(Schema.String),
  params: Schema.optionalKey(Schema.JsonObject),
});
const CallString = Schema.fromJsonString(CallSchema);

const StateTab = Schema.Struct({ tab_id: Schema.String, label: Schema.String });
type StateTabValue = Schema.Schema.Type<typeof StateTab>;
const StatePane = Schema.Struct({
  pane_id: Schema.String,
  tab_id: Schema.String,
  label: Schema.NullOr(Schema.String),
});
type StatePaneValue = Schema.Schema.Type<typeof StatePane>;

type RigServices = FileSystem.FileSystem | Path.Path;
export type RigError =
  | PlatformError.PlatformError
  | PlatformError.BadArgument
  | Config.ConfigError
  | Schema.SchemaError;

interface RigEnv {
  [key: string]: string;
  HOME: string;
  PATH: string;
  HERDR_ENV: string;
  HERDR_BIN_PATH: string;
  HERDR_SOCKET_PATH: string;
  HERDR_PLUGIN_ROOT: string;
  COLLIE_USER_DIR: string;
  HERDR_PLUGIN_STATE_DIR: string;
  HERDR_WORKSPACE_ID: string;
  HERDR_TAB_ID: string;
  HERDR_PANE_ID: string;
  COLLIE_CWD: string;
  FAKE_HERDR_LOG: string;
  FAKE_HERDR_OUTPUTS: string;
}

export interface Call extends Schema.Schema.Type<typeof CallSchema> {}

/**
 * The fake herdr answering in-process: the same core, the same call log and
 * state file, without a `bun` startup per CLI call — an engine run makes
 * hundreds of them, and the subprocesses were most of the suite's runtime.
 * Processes a test spawns still exec the CLI wrapper on HERDR_BIN_PATH.
 */
export class FakeHerdr extends Herdr {
  constructor(private readonly config: PluginEnv) {
    super(config);
  }

  protected override exec(args: string[]) {
    return fakeHerdr(args, this.config.raw);
  }
}

/**
 * What a `*.report_metadata` call leaves behind. herdr keeps plugin metadata, and the
 * Home's ownership proof is read back off `workspace list` and `pane list` — so a fake
 * that only logged these calls made every second ensure an `ownership_unknown`.
 *
 * Its own file, beside the fake's state rather than in it: the CLI writes that state from
 * a subprocess and this runs in a socket callback here, and two writers of one file
 * interleaved into something neither could read.
 *
 * Synchronous, deliberately: the callback has no Effect runtime around it, and the next
 * `workspace list` may be the very next line on the wire.
 */
export const tokensPath = (logPath: string) => `${logPath}.tokens.json`;

/** Tokens by workspace id and by pane id, which is the whole of what that file holds. */
const TokenStoreJson = Schema.fromJsonString(
  Schema.Record(
    Schema.Literals(["workspaces", "panes"]),
    Schema.Record(Schema.String, Schema.Record(Schema.String, Schema.String)),
  ),
);
const encodeTokens = Schema.encodeSync(TokenStoreJson);
const decodeTokens = Schema.decodeUnknownOption(TokenStoreJson);

const MetadataParams = Schema.Struct({
  workspace_id: Schema.optionalKey(Schema.String),
  pane_id: Schema.optionalKey(Schema.String),
  tokens: Schema.Record(Schema.String, Schema.String),
});
const asMetadataParams = Schema.decodeUnknownOption(MetadataParams);

/** One `*.report_metadata` call, as much of it as the store keeps. */
interface MetadataCall {
  readonly on: "workspaces" | "panes";
  readonly id: string;
  readonly tokens: Readonly<Record<string, string>>;
}

/** That call, or null for anything else on the wire. */
function metadataCall(method: string, params: Schema.JsonObject): MetadataCall | null {
  if (method !== "workspace.report_metadata" && method !== "pane.report_metadata") return null;
  const decoded = asMetadataParams(params);
  if (decoded._tag === "None") return null;
  const on = method === "workspace.report_metadata" ? "workspaces" : "panes";
  const id = (on === "workspaces" ? decoded.value.workspace_id : decoded.value.pane_id) ?? "";
  return id === "" ? null : { on, id, tokens: decoded.value.tokens };
}

/**
 * What a `*.report_metadata` call leaves behind. herdr keeps plugin metadata, and the
 * Home's ownership proof is read back off `workspace list` and `pane list` — so a fake
 * that only logged these calls made every second ensure an `ownership_unknown`.
 *
 * Its own file beside the log, not the fake's state: the CLI writes that state from a
 * subprocess and this writes here, and two writers of one file interleaved into
 * something neither could read. On the log's own queue, so it has landed before the
 * reply goes back — the very next line on the wire may be the `workspace list` that
 * reads it.
 */
const rememberTokens = Effect.fn("Rig.rememberTokens")(function* (
  logPath: string,
  call: MetadataCall,
) {
  const fs = yield* FileSystem.FileSystem;
  const file = tokensPath(logPath);
  const raw = yield* fs.readFileString(file, "utf8").pipe(Effect.catch(() => Effect.succeed("")));
  const held = decodeTokens(raw);
  const store = held._tag === "Some" ? held.value : { workspaces: {}, panes: {} };
  const kind = store[call.on] ?? {};
  yield* fs.writeFileString(
    file,
    `${encodeTokens({
      ...store,
      [call.on]: { ...kind, [call.id]: { ...kind[call.id], ...call.tokens } },
    })}\n`,
  );
});

/**
 * The GitLab login every rig runs as. In its environment rather than the process's, so
 * no test reaches out to a real glab to find out who is running it — and none of them
 * has to put a process-wide variable back afterwards.
 */
export const TEST_LOGIN = "tester";

export class Rig {
  readonly logPath: string;
  readonly socketPath: string;
  readonly binPath: string;
  readonly stateDir: string;
  readonly userDir: string;
  readonly baselineDir: string;
  readonly projectDir: string;
  private listener: { stop(closeActiveConnections?: boolean): void } | null = null;
  private socketFiber: Fiber.Fiber<void> | null = null;
  private readonly gone: string[] = [];

  private constructor(
    readonly root: string,
    private readonly path: Path.Path,
    private readonly fakeHerdrPath: string,
    private readonly pathValue: string,
  ) {
    this.logPath = path.join(root, "calls.jsonl");
    this.socketPath = path.join(root, "herdr.sock");
    this.binPath = path.join(root, "herdr");
    this.stateDir = path.join(root, "state");
    this.userDir = path.join(root, "config");
    this.baselineDir = path.join(root, "baseline");
    this.projectDir = path.join(root, "project");
  }

  static make(): Effect.Effect<Rig, RigError, RigServices> {
    return Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectory({ prefix: "hw-test-" });
      const fakeHerdrPath = yield* path.fromFileUrl(new URL("./fake-herdr.ts", import.meta.url));
      const pathValue = yield* Config.String("PATH").pipe(Config.withDefault(""));
      const rig = new Rig(root, path, fakeHerdrPath, pathValue);
      yield* rig.setup();
      return rig;
    });
  }

  private setup(): Effect.Effect<void, PlatformError.PlatformError, FileSystem.FileSystem> {
    const dirs = [this.stateDir, this.userDir, this.baselineDir, this.projectDir];
    const binPath = this.binPath;
    const fakeHerdrPath = this.fakeHerdrPath;
    return Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      for (const dir of dirs) {
        yield* fs.makeDirectory(dir, { recursive: true });
      }
      yield* fs.writeFileString(binPath, `#!/bin/sh\nexec bun ${fakeHerdrPath} "$@"\n`, {
        mode: 0o755,
      });
    });
  }

  private readJsonObject(
    path: string,
  ): Effect.Effect<Schema.JsonObject, RigError, FileSystem.FileSystem> {
    return Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const exists = yield* fs.exists(path);
      if (!exists) return {};
      const text = yield* fs.readFileString(path);
      return yield* Schema.decodeUnknownEffect(JsonObjectString)(text);
    });
  }

  /**
   * A tab herdr already has, with one pane in it: what a session that opened this
   * plugin's tab under an earlier name looks like to the next run.
   */
  addTab(
    label: string,
    paneLabel: string,
  ): Effect.Effect<{ tabId: string; paneId: string }, RigError, FileSystem.FileSystem> {
    const statePath = `${this.logPath}.state.json`;
    const readJsonObject = this.readJsonObject.bind(this);
    return Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const state = yield* readJsonObject(statePath);
      const tabs = Option.getOrElse(Schema.decodeUnknownOption(Schema.Number)(state.tabs), () => 0);
      const panes = Option.getOrElse(
        Schema.decodeUnknownOption(Schema.Number)(state.panes),
        () => 0,
      );
      const tabList = Option.getOrElse(
        Schema.decodeUnknownOption(Schema.Array(StateTab))(state.tabList),
        (): ReadonlyArray<StateTabValue> => [],
      );
      const paneList = Option.getOrElse(
        Schema.decodeUnknownOption(Schema.Array(StatePane))(state.paneList),
        (): ReadonlyArray<StatePaneValue> => [],
      );
      const tabId = `1:${tabs + 1}`;
      const paneId = `1-${panes + 1}`;
      yield* fs.writeFileString(
        statePath,
        encodeJson(
          Object.assign({}, state, {
            tabs: tabs + 1,
            panes: panes + 1,
            tabList: [...tabList, { tab_id: tabId, label }],
            paneList: [...paneList, { pane_id: paneId, tab_id: tabId, label: paneLabel }],
          }),
        ),
      );
      return { tabId, paneId };
    });
  }

  /**
   * Appends one entry to a list in the fake herdr's state — the agents it has, the
   * panes, the worktrees. The fake validates the whole state when it reads it, so
   * this only has to keep what is already there.
   */
  private appendState(
    key: string,
    entry: Schema.JsonObject,
  ): Effect.Effect<void, RigError, FileSystem.FileSystem> {
    const statePath = `${this.logPath}.state.json`;
    const readJsonObject = this.readJsonObject.bind(this);
    return Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const state = yield* readJsonObject(statePath);
      const listed = Option.getOrElse(
        Schema.decodeUnknownOption(Schema.Array(Schema.JsonObject))(state[key]),
        (): ReadonlyArray<Schema.JsonObject> => [],
      );
      yield* fs.writeFileString(
        statePath,
        encodeJson(Object.assign({}, state, { [key]: [...listed, entry] })),
      );
    });
  }

  /**
   * A workspace herdr has. None by default: `workspace list` answers with an empty
   * session, so only a test about several workspaces has to say what is in one.
   */
  addWorkspace(workspaceId: string, label: string, cwd?: string) {
    return this.appendState("workspaces", { workspace_id: workspaceId, label, cwd: cwd ?? null });
  }

  /** An agent herdr already has, matching one an earlier run started. */
  addAgent(name: string, paneId: string) {
    return this.appendState("agents", { name, pane_id: paneId });
  }

  /** Another process under this agent's name, in the same pane. */
  reincarnate(name: string): Effect.Effect<void, RigError, FileSystem.FileSystem> {
    const statePath = `${this.logPath}.state.json`;
    const readJsonObject = this.readJsonObject.bind(this);
    return Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const state = yield* readJsonObject(statePath);
      const agents = Option.getOrElse(
        Schema.decodeUnknownOption(Schema.Array(Schema.JsonObject))(state.agents),
        (): ReadonlyArray<Schema.JsonObject> => [],
      );
      const renewed = agents.map((agent) =>
        agent.name === name ? { ...agent, terminal_id: `${agent.terminal_id}+next` } : agent,
      );
      yield* fs.writeFileString(
        statePath,
        encodeJson(Object.assign({}, state, { agents: renewed })),
      );
    });
  }

  /** A pane herdr already has, with the directory, agent and workspace it is in. */
  addPane(
    paneId: string,
    tabId: string,
    cwd: string,
    agent: string | null = null,
    workspaceId: string | null = null,
    foregroundCwd: string | null = null,
    agentStatus: string | null = null,
  ) {
    return this.appendState("paneList", {
      pane_id: paneId,
      tab_id: tabId,
      label: null,
      cwd,
      agent,
      agent_status: agentStatus,
      workspace_id: workspaceId,
      foreground_cwd: foregroundCwd,
    });
  }

  /**
   * A worktree herdr already lists, as an earlier run would have left it. A null
   * workspace is a checkout herdr has no workspace open on — one Collie made with git.
   */
  addWorktree(branch: string, worktreePath: string, workspaceId: string | null) {
    const append = this.appendState("worktrees", {
      branch,
      path: worktreePath,
      open_workspace_id: workspaceId,
    });
    return Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      // A real directory, because whatever runs there has to cd into it, with the
      // `.git` file git writes at `worktree add` — which is what says this checkout is
      // the one a run recorded rather than another one later made at the same path.
      yield* fs.makeDirectory(worktreePath, { recursive: true });
      yield* fs.writeFileString(`${worktreePath}/.git`, `gitdir: ${worktreePath}/.gitdir\n`);
      yield* append;
    });
  }

  /** Exactly the worktrees herdr has, replacing whatever it had before. */
  setWorktrees(
    worktrees: ReadonlyArray<{ branch: string; path: string; open_workspace_id: string | null }>,
  ): Effect.Effect<void, RigError, FileSystem.FileSystem> {
    const statePath = `${this.logPath}.state.json`;
    const readJsonObject = this.readJsonObject.bind(this);
    return Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const state = yield* readJsonObject(statePath);
      for (const worktree of worktrees) {
        yield* fs.makeDirectory(worktree.path, { recursive: true });
        yield* fs.writeFileString(`${worktree.path}/.git`, `gitdir: ${worktree.path}/.gitdir\n`);
      }
      yield* fs.writeFileString(
        statePath,
        encodeJson(Object.assign({}, state, { worktrees: worktrees.map((w) => ({ ...w })) })),
      );
    });
  }

  /**
   * herdr dropping a workspace, as it does once its last pane closes: the agents in it go
   * with it, and a tab asked for there is refused as `workspace_not_found`.
   */
  closeWorkspace(
    workspaceId: string,
    agents: ReadonlyArray<string>,
  ): Effect.Effect<void, RigError, FileSystem.FileSystem> {
    const statePath = `${this.logPath}.state.json`;
    const readJsonObject = this.readJsonObject.bind(this);
    return Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const state = yield* readJsonObject(statePath);
      const list = (key: string) =>
        Option.getOrElse(
          Schema.decodeUnknownOption(Schema.Array(Schema.JsonObject))(state[key]),
          (): ReadonlyArray<Schema.JsonObject> => [],
        );
      const closed = Option.getOrElse(
        Schema.decodeUnknownOption(Schema.Array(Schema.String))(state.closedWorkspaces),
        (): ReadonlyArray<string> => [],
      );
      yield* fs.writeFileString(
        statePath,
        encodeJson(
          Object.assign({}, state, {
            workspaces: list("workspaces").filter((w) => w.workspace_id !== workspaceId),
            agents: list("agents").filter((a) => !agents.includes(String(a.name))),
            closedWorkspaces: [...closed, workspaceId],
          }),
        ),
      );
    });
  }

  /** An agent herdr has forgotten: its pane closed and it went with it. */
  dropAgent(name: string): void {
    const gone = (Bun.env.FAKE_HERDR_AGENTS_GONE ?? "").split(",").filter((item) => item !== "");
    Bun.env.FAKE_HERDR_AGENTS_GONE = [...gone, name].join(",");
    this.gone.push(name);
  }

  /** Stands in for the agents: each queue entry is written for the next prompt. */
  queueOutputs(
    items: ReadonlyArray<Schema.Json>,
  ): Effect.Effect<void, PlatformError.PlatformError, FileSystem.FileSystem> {
    const outputsPath = this.path.join(this.root, "outputs.json");
    return Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      yield* fs.writeFileString(outputsPath, encodeJson(items));
    });
  }

  startSocket(): Effect.Effect<void, never, FileSystem.FileSystem> {
    const logPath = this.logPath;
    const socketPath = this.socketPath;
    const requestsFrom = this.requestsFrom.bind(this);
    const setFiber = (fiber: Fiber.Fiber<void>) => {
      this.socketFiber = fiber;
    };
    const setListener = (listener: { stop(closeActiveConnections?: boolean): void }) => {
      this.listener = listener;
    };
    return Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const writes = yield* Queue.unbounded<{
        readonly entry: string;
        /** Metadata this call attached, written before its reply goes back. */
        readonly tokens: MetadataCall | null;
        readonly succeed: () => void;
        readonly fail: () => void;
      }>();
      setFiber(
        yield* Queue.take(writes).pipe(
          Effect.flatMap(({ entry, tokens, succeed, fail }) =>
            fs
              .writeFileString(logPath, entry, { flag: "a" })
              .pipe(
                Effect.andThen(tokens === null ? Effect.void : rememberTokens(logPath, tokens)),
                Effect.match({ onFailure: fail, onSuccess: succeed }),
              ),
          ),
          Effect.forever,
          Effect.forkDetach,
        ),
      );
      setListener(
        Bun.listen({
          unix: socketPath,
          socket: {
            data: (socket, chunk) => {
              for (const req of requestsFrom(String(chunk))) {
                const params = req.params ?? {};
                const entry = `${encodeJson({ transport: "rpc", cmd: req.method, method: req.method, params })}\n`;
                // The two calls that change what a later `workspace list` or `pane list`
                // answers: herdr keeps plugin metadata, and the Home's ownership proof is
                // read back off these lists. A fake that only logged them made every
                // second ensure an `ownership_unknown`.
                const tokens = metadataCall(req.method, params);
                // The same FAKE_HERDR_FAIL map the CLI side reads, so an rpc-only
                // call like `tab.move` can be made to fail in a test.
                const failure = Option.getOrElse(
                  Schema.decodeUnknownOption(Schema.fromJsonString(FailuresSchema))(
                    Bun.env.FAKE_HERDR_FAIL ?? "{}",
                  ),
                  (): Record<string, string> => ({}),
                )[req.method];
                Queue.offerUnsafe(writes, {
                  entry,
                  tokens,
                  succeed: () =>
                    socket.write(
                      `${encodeJson(
                        failure
                          ? { id: req.id, error: { message: failure } }
                          : { id: req.id, result: { type: "ok" } },
                      )}\n`,
                    ),
                  fail: () =>
                    socket.write(
                      `${encodeJson({ id: req.id, error: { message: "log write failed" } })}\n`,
                    ),
                });
              }
            },
          },
        }),
      );
    });
  }

  private requestsFrom(chunk: string): ReadonlyArray<Schema.Schema.Type<typeof RpcRequest>> {
    return chunk
      .split("\n")
      .filter((line) => line.trim() !== "")
      .flatMap((line) => Option.toArray(Schema.decodeUnknownOption(RpcRequestString)(line)));
  }

  env(overrides: RigEnvInput = {}): RigEnv {
    const environment: RigEnv = {
      HOME: this.root,
      PATH: this.pathValue,
      HERDR_ENV: "1",
      HERDR_BIN_PATH: this.binPath,
      HERDR_SOCKET_PATH: this.socketPath,
      HERDR_PLUGIN_ROOT: this.baselineDir,
      COLLIE_USER_DIR: this.userDir,
      HERDR_PLUGIN_STATE_DIR: this.stateDir,
      HERDR_WORKSPACE_ID: "1",
      HERDR_TAB_ID: "1:1",
      HERDR_PANE_ID: "1-1",
      COLLIE_CWD: this.projectDir,
      GITLAB_USER_LOGIN: TEST_LOGIN,
      FAKE_HERDR_LOG: this.logPath,
      FAKE_HERDR_OUTPUTS: this.path.join(this.root, "outputs.json"),
      // What `herdr status --json` answers with regardless of HERDR_SOCKET_PATH: the
      // rig's one real socket, so a test that unsets the explicit path still reaches
      // it through discovery rather than through the env var it is testing the absence of.
      FAKE_HERDR_STATUS_SOCKET: this.socketPath,
      ...overrides,
    };
    if (this.gone.length > 0) environment.FAKE_HERDR_AGENTS_GONE = this.gone.join(",");
    return environment;
  }

  pluginEnv(overrides: RigEnvInput = {}): PluginEnv {
    const env = this.env(overrides);
    // The fake CLI reads its own config from the ambient environment; clear the
    // keys this rig does not set so one test cannot leak into the next.
    for (const key of [
      "FAKE_HERDR_LOG",
      "FAKE_HERDR_OUTPUTS",
      "FAKE_HERDR_FAIL",
      "FAKE_HERDR_AGENT_STATUS",
      "FAKE_HERDR_PROMPT_ERROR",
      "FAKE_HERDR_PROMPT_ERROR_TIMES",
      "FAKE_HERDR_BLOCK_START",
      "FAKE_HERDR_VERSION",
      "FAKE_HERDR_PLUGINS",
      "FAKE_HERDR_STATUS",
      "FAKE_HERDR_STATUS_SOCKET",
      "FAKE_HERDR_RUNTIME_MISSING",
    ]) {
      const value = env[key];
      if (value) Bun.env[key] = value;
      else delete Bun.env[key];
    }
    if (this.gone.length > 0) Bun.env.FAKE_HERDR_AGENTS_GONE = this.gone.join(",");
    return readEnv(env);
  }

  calls(): Effect.Effect<Call[], RigError, FileSystem.FileSystem> {
    const logPath = this.logPath;
    return Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const exists = yield* fs.exists(logPath);
      if (!exists) return [];
      const text = yield* fs.readFileString(logPath);
      return yield* Effect.forEach(
        text.split("\n").filter((line) => line.trim() !== ""),
        (line) => Schema.decodeUnknownEffect(CallString)(line),
      );
    });
  }

  cmds(): Effect.Effect<string[], RigError, FileSystem.FileSystem> {
    return this.calls().pipe(Effect.map((calls) => calls.map((call) => call.cmd)));
  }

  close(): Effect.Effect<void, PlatformError.PlatformError, FileSystem.FileSystem> {
    const listener = this.listener;
    const socketFiber = this.socketFiber;
    const root = this.root;
    return Effect.gen(function* () {
      listener?.stop(true);
      if (socketFiber) yield* Fiber.interrupt(socketFiber);
      const fs = yield* FileSystem.FileSystem;
      yield* fs.remove(root, { recursive: true, force: true });
    });
  }
}

interface RigEnvInput {
  [key: string]: string;
}

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

const StateAgent = Schema.Struct({ name: Schema.String, pane_id: Schema.String });
type StateAgentValue = Schema.Schema.Type<typeof StateAgent>;
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
  HERDR_PLUGIN_CONFIG_DIR: string;
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

export class Rig {
  readonly logPath: string;
  readonly socketPath: string;
  readonly binPath: string;
  readonly stateDir: string;
  readonly configDir: string;
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
    this.configDir = path.join(root, "config");
    this.baselineDir = path.join(root, "baseline");
    this.projectDir = path.join(root, "project");
  }

  static make(): Effect.Effect<Rig, RigError, RigServices> {
    return Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectory({ prefix: "hw-test-" });
      const fakeHerdrPath = yield* path.fromFileUrl(new URL("./fake-herdr.ts", import.meta.url));
      const pathValue = yield* Config.string("PATH").pipe(Config.withDefault(""));
      const rig = new Rig(root, path, fakeHerdrPath, pathValue);
      yield* rig.setup();
      return rig;
    });
  }

  private setup(): Effect.Effect<void, PlatformError.PlatformError, FileSystem.FileSystem> {
    const dirs = [this.stateDir, this.configDir, this.baselineDir, this.projectDir];
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

  /** An agent herdr already has, matching one an earlier run started. */
  addAgent(name: string, paneId: string): Effect.Effect<void, RigError, FileSystem.FileSystem> {
    const statePath = `${this.logPath}.state.json`;
    const readJsonObject = this.readJsonObject.bind(this);
    return Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const state = yield* readJsonObject(statePath);
      const agents: ReadonlyArray<StateAgentValue> = Option.getOrElse(
        Schema.decodeUnknownOption(Schema.Array(StateAgent))(state.agents),
        (): ReadonlyArray<StateAgentValue> => [],
      );
      const nextAgents: ReadonlyArray<StateAgentValue> = [...agents, { name, pane_id: paneId }];
      yield* fs.writeFileString(
        statePath,
        encodeJson(Object.assign({}, state, { agents: nextAgents })),
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
        readonly succeed: () => void;
        readonly fail: () => void;
      }>();
      setFiber(
        yield* Queue.take(writes).pipe(
          Effect.flatMap(({ entry, succeed, fail }) =>
            fs
              .writeFileString(logPath, entry, { flag: "a" })
              .pipe(Effect.match({ onFailure: fail, onSuccess: succeed })),
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
      HERDR_PLUGIN_CONFIG_DIR: this.configDir,
      HERDR_PLUGIN_STATE_DIR: this.stateDir,
      HERDR_WORKSPACE_ID: "1",
      HERDR_TAB_ID: "1:1",
      HERDR_PANE_ID: "1-1",
      COLLIE_CWD: this.projectDir,
      FAKE_HERDR_LOG: this.logPath,
      FAKE_HERDR_OUTPUTS: this.path.join(this.root, "outputs.json"),
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
      "FAKE_HERDR_BLOCK_START",
      "FAKE_HERDR_VERSION",
      "FAKE_HERDR_PLUGINS",
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

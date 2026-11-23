// Test rig: a temp plugin sandbox and a fake core on `HC_SOCKET`, recording into one ordered
// log, with Herdr 1's tripwire on PATH and on the socket a host may inherit.

import * as Arr from "effect/Array";
import * as Str from "effect/String";
import {
  Config,
  Effect,
  Exit,
  FileSystem,
  Path,
  PlatformError,
  Schema,
  Scope,
  flow,
  Result,
} from "effect";
import { readEnv, type PluginEnv } from "../../src/env";
import { connect } from "../../src/hc";
import { SETUP, serveFakeHc, type FakeHc } from "./fake-hc";
import { armTripwire, untripped, type Tripwire } from "./herdr-tripwire";

const encodeJson = flow(Schema.encodeResult(Schema.fromJsonString(Schema.Json)), Result.getOrThrow);

const CallSchema = Schema.Struct({
  transport: Schema.Literals(["cli", "rpc", "core"]),
  cmd: Schema.String,
  argv: Schema.optionalKey(Schema.Array(Schema.String)),
  method: Schema.optionalKey(Schema.String),
  params: Schema.optionalKey(Schema.JsonObject),
});
const CallString = Schema.fromJsonString(CallSchema);

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
  HERDR_BIN_PATH: string;
  HERDR_SOCKET_PATH: string;
  COLLIE_ROOT: string;
  COLLIE_USER_DIR: string;
  COLLIE_CLAUDE_MANAGED_DIR: string;
  COLLIE_STATE_DIR: string;
  COLLIE_CWD: string;
  HC_SOCKET: string;
}

export const UNREACHABLE_RELEASES = "http://127.0.0.1:9";

export interface Call extends Schema.Schema.Type<typeof CallSchema> {}

/**
 * The GitLab login every rig runs as. In its environment rather than the process's, so
 * no test reaches out to a real glab to find out who is running it — and none of them
 * has to put a process-wide variable back afterwards.
 */
export const TEST_LOGIN = "tester";

export class Rig {
  readonly logPath: string;
  readonly stateDir: string;
  readonly userDir: string;
  readonly baselineDir: string;
  readonly projectDir: string;
  readonly coreSocket: string;
  private coreScope: Scope.Closeable | null = null;
  private served: FakeHc | null = null;

  private constructor(
    readonly root: string,
    private readonly path: Path.Path,
    private readonly pathValue: string,
    private readonly tripwire: Tripwire,
  ) {
    this.logPath = path.join(root, "calls.jsonl");
    this.stateDir = path.join(root, "state");
    this.userDir = path.join(root, "config");
    this.baselineDir = path.join(root, "baseline");
    this.projectDir = path.join(root, "project");
    this.coreSocket = path.join(root, "hc.sock");
  }

  static make(): Effect.Effect<Rig, RigError, RigServices> {
    return Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectory({ prefix: "hw-test-" });
      const pathValue = yield* Config.String("PATH").pipe(Config.withDefault(""));
      const rig = new Rig(root, path, pathValue, yield* armTripwire(root));
      yield* rig.setup();
      return rig;
    });
  }

  /** A Rig closed when its scope is, whatever the test did. */
  static scoped(): Effect.Effect<Rig, RigError, RigServices | Scope.Scope> {
    return Effect.acquireRelease(Rig.make(), (rig) => Effect.ignore(rig.close()));
  }

  private setup(): Effect.Effect<void, PlatformError.PlatformError, FileSystem.FileSystem> {
    const dirs = [this.stateDir, this.userDir, this.baselineDir, this.projectDir];
    const memory = this.memory(50);
    const disk = this.disk(50);
    return Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      for (const dir of dirs) yield* fs.makeDirectory(dir, { recursive: true });
      yield* memory;
      yield* disk;
    });
  }

  get procDir(): string {
    return this.path.join(this.root, "proc");
  }

  /** This Machine's memory from now on: `availableGiB` of 100 GiB, under `pressure`. */
  memory(
    availableGiB: number,
    pressure = 0,
  ): Effect.Effect<void, PlatformError.PlatformError, FileSystem.FileSystem> {
    const proc = this.procDir;
    return Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      yield* fs.makeDirectory(`${proc}/pressure`, { recursive: true });
      yield* fs.writeFileString(
        `${proc}/meminfo`,
        `MemTotal:       ${100 * 1048576} kB\nMemAvailable:   ${Math.round(availableGiB * 1048576)} kB\n`,
      );
      yield* fs.writeFileString(
        `${proc}/pressure/memory`,
        `some avg10=0.00 avg60=0.00 avg300=0.00 total=0\nfull avg10=${pressure.toFixed(2)} avg60=0.00 avg300=0.00 total=0\n`,
      );
    });
  }

  get dfPath(): string {
    return this.path.join(this.root, "df");
  }

  /** What `df -Pk` says from now on of every directory asked about: `percentFree` of 100 GiB on `/`. */
  disk(
    percentFree: number,
  ): Effect.Effect<void, PlatformError.PlatformError, FileSystem.FileSystem> {
    const file = this.dfPath;
    return Effect.flatMap(FileSystem.FileSystem, (fs) =>
      fs.writeFileString(
        file,
        `Filesystem 1024-blocks Used Available Capacity Mounted on\n/dev/sda1 104857600 ${(100 - percentFree) * 1048576} ${percentFree * 1048576} ${100 - percentFree}% /\n`,
      ),
    );
  }

  /** Stands in for the agents: each queue entry is written for the next prompt. */
  queueOutputs(
    items: ReadonlyArray<Schema.Json>,
  ): Effect.Effect<void, PlatformError.PlatformError, FileSystem.FileSystem> {
    const outputsPath = this.path.join(this.root, "outputs.json");
    return Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      yield* fs.writeFileString(outputsPath, encodeJson([...items]));
    });
  }

  /** The fake core on `HC_SOCKET`, serving until the rig closes; started once. */
  startCore() {
    if (this.served !== null) return Effect.succeed(this.served);
    const socketPath = this.coreSocket;
    const logPath = this.logPath;
    const queuePath = this.path.join(this.root, "outputs.json");
    const keep = (scope: Scope.Closeable, served: FakeHc) => {
      this.coreScope = scope;
      this.served = served;
    };
    return Effect.gen(function* () {
      const scope = yield* Scope.make();
      const served = yield* serveFakeHc(socketPath, logPath, scope, queuePath);
      keep(scope, served);
      return served;
    });
  }

  /** An agent live on the fake core, as one an earlier Run started; its terminal's address. */
  addAgent(name: string, cwd = this.projectDir, labels: Record<string, string> = { run: "r0" }) {
    return Effect.flatMap(this.startCore(), (core) =>
      Effect.scoped(
        Effect.flatMap(connect(core.socketPath), (hc) =>
          hc.call("terminal.run", { name, argv: ["claude"], cwd, labels, [SETUP]: true }),
        ),
      ).pipe(Effect.map((made) => made.address)),
    );
  }

  /** An agent core no longer has: its terminal was killed. */
  dropAgent(name: string) {
    return Effect.flatMap(this.startCore(), (core) =>
      Effect.scoped(
        Effect.flatMap(connect(core.socketPath), (hc) =>
          hc.call("terminal.kill", { terminal: name, [SETUP]: true }),
        ),
      ),
    ).pipe(Effect.asVoid);
  }

  env(overrides: RigEnvInput = {}): RigEnv {
    return {
      HOME: this.root,
      PATH: `${this.tripwire.binDir}:${this.pathValue}`,
      // What a host may still inherit from Herdr 1: both lead only to the tripwire.
      HERDR_BIN_PATH: this.tripwire.bin,
      HERDR_SOCKET_PATH: this.tripwire.socketPath,
      COLLIE_ROOT: this.baselineDir,
      COLLIE_USER_DIR: this.userDir,
      COLLIE_CLAUDE_MANAGED_DIR: `${this.root}/claude-managed`,
      COLLIE_STATE_DIR: this.stateDir,
      COLLIE_CWD: this.projectDir,
      GITLAB_USER_LOGIN: TEST_LOGIN,
      GITHUB_ACTOR: TEST_LOGIN,
      // Refused at once: a test that wants releases serves its own.
      COLLIE_RELEASES: UNREACHABLE_RELEASES,
      // This Machine's memory as Collie reads it: never the real Machine's.
      COLLIE_PROC: this.procDir,
      // Its free disk as Collie reads it: never the real Machine's.
      COLLIE_DF: this.dfPath,
      // The fake core's socket once `startCore` serves it; never the human's core.
      HC_SOCKET: this.coreSocket,
      ...overrides,
    };
  }

  pluginEnv(overrides: RigEnvInput = {}): PluginEnv {
    return readEnv(this.env(overrides));
  }

  calls(): Effect.Effect<Call[], RigError, FileSystem.FileSystem> {
    const logPath = this.logPath;
    return Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      if (!(yield* fs.exists(logPath))) return [];
      const text = yield* fs.readFileString(logPath);
      // A line with no newline yet is still being written.
      const whole = Str.split(text, "\n").slice(0, -1);
      return yield* Effect.forEach(
        Arr.filter(whole, (line) => Str.trim(line) !== ""),
        (line) => Schema.decodeEffect(CallString)(line),
      );
    });
  }

  cmds(): Effect.Effect<string[], RigError, FileSystem.FileSystem> {
    return this.calls().pipe(Effect.map((calls) => Arr.map(calls, (call) => call.cmd)));
  }

  /** Stops the fake core and removes the rig, failing where anything called Herdr 1. */
  close(): Effect.Effect<void, PlatformError.PlatformError, FileSystem.FileSystem> {
    const coreScope = this.coreScope;
    const root = this.root;
    const tripwire = this.tripwire;
    return Effect.gen(function* () {
      yield* tripwire.stop;
      if (coreScope) yield* Scope.close(coreScope, Exit.void);
      const tripped = yield* Effect.exit(untripped(tripwire));
      const fs = yield* FileSystem.FileSystem;
      yield* fs.remove(root, { recursive: true, force: true });
      if (Exit.isFailure(tripped)) return yield* Effect.failCause(tripped.cause);
    });
  }
}

interface RigEnvInput {
  [key: string]: string;
}

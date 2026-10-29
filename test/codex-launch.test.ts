// A Codex agent's launch at the Agents service: the App Server Collie starts for it is the
// stand-in in `support/codex-server.ts`, run as a real process, and what is asserted is what
// a human could see of that process and of the `agent start` herdr was asked for.

import { afterEach, beforeEach, expect, test } from "bun:test";
import type { PlatformServices } from "../src/platform";
import { Effect, FileSystem, Schema } from "effect";
import { Rig, FakeHerdr, type Call } from "./support/recorder";
import { fastForward, runEffect as runLive } from "./support/effect";
import { agentWork, agentsLayer, type AgentHost } from "../src/agents";
import { asRun, enveloped } from "./support/enveloped";
import { foundationLayer } from "../src/engine";
import { agentName } from "../src/naming";
import { codexPort } from "../src/compactors";
import type { AgentProfile } from "../src/profile";
import type { StandIn } from "./support/codex-server";

const asJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

let rig: Rig;
let dir: string;
let cwd: string;

beforeEach(() =>
  runEffect(
    Effect.gen(function* () {
      rig = yield* Rig.make();
      dir = `${rig.root}/host`;
      cwd = rig.projectDir;
      yield* (yield* FileSystem.FileSystem).makeDirectory(dir, { recursive: true });
    }),
  ),
);

afterEach(() =>
  runEffect(
    Effect.gen(function* () {
      const pid = (yield* started())?.pid;
      if (pid !== undefined) kill(pid);
      yield* rig.close();
    }),
  ),
);

const runEffect = <A, E>(effect: Effect.Effect<A, E, PlatformServices>) =>
  runLive(fastForward(effect));

const Verdict = Schema.Struct({
  verdict: Schema.Literals(["clean", "findings"]),
  note: Schema.String,
});
const work = enveloped({ name: "agent-work", input: { skip: Schema.Boolean }, success: Verdict });
const body = work.toLayer((payload) =>
  agentWork({
    operation: "build",
    role: "implementer",
    workflow: "agent-work",
    cwd,
    instructions: "Build it.",
    output: Verdict,
  }).pipe(asRun(payload)),
);

const SERVER = `${import.meta.dir}/support/codex-server.ts`;
const config = () => `${rig.root}/codex-server.json`;
const eventsFile = () => `${rig.root}/codex-server.events`;
const server = () => `bun ${SERVER} ${config()}`;
const agent = agentName("r1", "build", null, 1);

const hostOf = (): AgentHost => ({
  dir,
  env: rig.pluginEnv(),
  herdr: new FakeHerdr(rig.pluginEnv()),
  harness: "codex",
  model: "default",
  permissions: "auto",
  compactAtTokens: 1000,
  pollMs: 20,
  collectMs: 30_000,
  stopMs: 250_000,
  ports: { codex: { ...codexPort(server()), gate: () => Effect.void } },
});

const launched = (over: Partial<StandIn> = {}) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    yield* fs.makeDirectory(cwd, { recursive: true });
    yield* fs.writeFileString(config(), asJson({ events: eventsFile(), threads: [], ...over }));
    yield* rig.queueOutputs([{ verdict: "clean", note: "done" }]);
    yield* work
      .execute({ runId: "r1", input: { skip: false } })
      .pipe(
        Effect.result,
        Effect.provide(body),
        Effect.provide(agentsLayer(hostOf())),
        Effect.provide(foundationLayer({ dir })),
        Effect.scoped,
      );
  }).pipe(Effect.orDie);

const Started = Schema.Struct({
  pid: Schema.Number,
  argv: Schema.Array(Schema.String),
  env: Schema.Record(Schema.String, Schema.NullOr(Schema.String)),
});
const decodeStarted = Schema.decodeUnknownOption(Schema.fromJsonString(Started));
const started = () =>
  FileSystem.FileSystem.pipe(
    Effect.flatMap((fs) => fs.readFileString(eventsFile())),
    Effect.orElseSucceed(() => ""),
    Effect.map((text) => {
      for (const line of text.split("\n")) {
        const one = decodeStarted(line);
        if (one._tag === "Some") return one.value;
      }
      return undefined;
    }),
  );

const kill = (pid: number) => {
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    // Already gone.
  }
};

const mcpOverrides = (argv: ReadonlyArray<string>) =>
  argv.flatMap((arg, at) => (argv[at - 1] === "-c" && arg.startsWith("mcp_servers.") ? [arg] : []));
const agentStartArgs = (calls: ReadonlyArray<Call>) =>
  calls.find((call) => call.cmd === "agent start")?.argv ?? [];

const withProfile = (profile: AgentProfile) =>
  FileSystem.FileSystem.pipe(
    Effect.flatMap((fs) =>
      fs.writeFileString(
        `${rig.pluginEnv().userDir}/config.json`,
        asJson({ agent_profile: asJson(profile) }),
      ),
    ),
    Effect.orDie,
  );

const controlCommand = () =>
  FileSystem.FileSystem.pipe(
    Effect.flatMap((fs) => fs.readFileString(`${rig.root}/state/compaction/${agent}/control.json`)),
    Effect.flatMap(
      Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Struct({ command: Schema.String }))),
    ),
    Effect.map((record) => record.command),
    Effect.orDie,
  );

test("a Codex agent's App Server is started with the same Collie MCP server its TUI is given", () =>
  runEffect(
    Effect.gen(function* () {
      yield* withProfile({ implementer: { env: { PROFILE_ONLY: "from the profile" } } });
      yield* launched({ env: ["PROFILE_ONLY"] });

      const tui = mcpOverrides(agentStartArgs(yield* rig.calls()));
      const own = yield* started();
      expect(tui.length).toBeGreaterThan(0);
      expect(mcpOverrides(own?.argv ?? [])).toEqual(tui);
      expect(tui).toContain(`mcp_servers.collie.env.COLLIE_RUN="r1"`);
      expect(tui).toContain(`mcp_servers.collie.env.COLLIE_AGENT="${agent}"`);
      expect(own?.env).toEqual({ PROFILE_ONLY: "from the profile" });
      expect(yield* controlCommand()).toBe(server());
    }),
  ));

test("a project directory with a space and a single quote reaches the App Server byte for byte", () =>
  runEffect(
    Effect.gen(function* () {
      cwd = `${rig.root}/the owner's project`;
      yield* launched();

      expect(mcpOverrides((yield* started())?.argv ?? [])).toContain(
        `mcp_servers.collie.env.COLLIE_CWD=${asJson(cwd)}`,
      );
    }),
  ));

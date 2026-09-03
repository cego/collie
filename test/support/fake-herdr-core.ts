// Fake herdr. Records every invocation and answers with canned ids so a whole
// run can be driven without a herdr server.

import { Cause, Config, Effect, FileSystem, Option, Path, Schema } from "effect";

interface FakeTab {
  tab_id: string;
  label: string;
}

interface FakePane {
  pane_id: string;
  tab_id: string;
  label: string | null;
}

interface FakeAgent {
  name: string;
  pane_id: string;
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
});
const FakeAgentSchema = Schema.Struct({ name: Schema.String, pane_id: Schema.String });
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
    })),
    agents: (state.agents ?? []).map((agent) => ({ name: agent.name, pane_id: agent.pane_id })),
  };
}

export function fakeHerdr(
  argv: string[],
  environment: Readonly<Record<string, string | undefined>> = {},
): Effect.Effect<FakeResult, never, FileSystem.FileSystem | Path.Path> {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const envString = (name: string, fallback = "") => {
      const value = environment[name];
      return value === undefined
        ? Config.string(name).pipe(Config.withDefault(Bun.env[name] ?? fallback))
        : Config.succeed(value);
    };
    const log = yield* envString("FAKE_HERDR_LOG");
    const statePath = `${log}.state.json`;

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

    function newPane(tabId: string, label: string | null = null): FakePane {
      const pane = { pane_id: `1-${(state.panes += 1)}`, tab_id: tabId, label };
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
    }

    let result = {};
    switch (cmd) {
      case "tab create": {
        const tab = newTab(flag("--label") ?? String(state.tabs + 1));
        result = { type: "tab_created", tab, root_pane: newPane(tab.tab_id) };
        break;
      }
      case "tab rename": {
        const tab = state.tabList.find((t) => t.tab_id === argv[2]);
        if (tab) tab.label = argv[3] ?? tab.label;
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
      case "pane list":
        result = {
          type: "pane_list",
          panes: state.paneList.map((p) => ({ ...p, workspace_id: "1" })),
        };
        break;
      case "plugin pane": {
        const target = flag("--target-pane");
        const tabId =
          flag("--placement") === "split" && target ? tabOf(target) : newTab("plugin").tab_id;
        result = {
          type: "plugin_pane_opened",
          plugin_pane: { entrypoint: flag("--entrypoint") ?? "", pane: newPane(tabId) },
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
            .map((a) => ({ ...a, agent_status: status })),
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

// The only channel to herdr: the CLI at HERDR_BIN_PATH, plus the socket at
// HERDR_SOCKET_PATH for the few methods 0.7.5 does not expose on the CLI.

import type { BunServices } from "@effect/platform-bun/BunServices";
import { Data, Deferred, Effect, Schema, Stream } from "effect";
import * as BunSocket from "@effect/platform-bun/BunSocket";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import type { PlatformError } from "effect/PlatformError";
import type { PluginEnv } from "./env";
import { PLUGIN_ID } from "./env";
import { reason } from "./naming";

export type AgentStatus = "idle" | "working" | "blocked" | "done" | "unknown";

export class HerdrError extends Data.TaggedError("HerdrError")<{
  readonly message: string;
  readonly detail: string;
}> {}

export function herdrFailureReason(cause: unknown): string {
  return cause instanceof HerdrError ? `${cause.message}: ${cause.detail}` : reason(cause);
}

type HerdrEffect<A> = Effect.Effect<A, HerdrError, BunServices>;
type ExecResult = { code: number; stdout: string; stderr: string };
type BoundaryValue = Schema.Json | string | undefined;
type HerdrParams = Schema.JsonObject;

const JsonString = Schema.fromJsonString(Schema.Json);
const encodeJson = Schema.encodeSync(JsonString);

const ErrorReply = Schema.Struct({
  message: Schema.optionalKey(Schema.String),
  code: Schema.optionalKey(Schema.String),
});
const SocketReply = Schema.Struct({
  error: Schema.optionalKey(ErrorReply),
  result: Schema.optionalKey(Schema.Json),
});
const TabCreateReply = Schema.Struct({
  result: Schema.Struct({
    tab: Schema.Struct({ tab_id: Schema.String }),
    root_pane: Schema.Struct({ pane_id: Schema.String }),
  }),
});
const WorkspaceReply = Schema.Struct({
  workspace_id: Schema.String,
  label: Schema.String,
  cwd: Schema.optionalKey(Schema.String),
  working_directory: Schema.optionalKey(Schema.String),
  worktree: Schema.optionalKey(Schema.Struct({ path: Schema.String })),
  worktree_path: Schema.optionalKey(Schema.String),
});
const WorkspaceListReply = Schema.Struct({
  result: Schema.Struct({ workspaces: Schema.Array(WorkspaceReply) }),
});
const TabListReply = Schema.Struct({
  result: Schema.Struct({
    tabs: Schema.Array(Schema.Struct({ tab_id: Schema.String, label: Schema.String })),
  }),
});
const PaneListReply = Schema.Struct({
  result: Schema.Struct({
    panes: Schema.Array(
      Schema.Struct({
        pane_id: Schema.String,
        tab_id: Schema.String,
        label: Schema.optionalKey(Schema.NullOr(Schema.String)),
        agent: Schema.optionalKey(Schema.NullOr(Schema.String)),
      }),
    ),
  }),
});
const PaneSplitReply = Schema.Struct({
  result: Schema.Struct({ pane: Schema.Struct({ pane_id: Schema.String }) }),
});
const AgentReply = Schema.Struct({
  name: Schema.String,
  pane_id: Schema.String,
  workspace_id: Schema.optionalKey(Schema.NullOr(Schema.String)),
  agent_status: Schema.String,
});
const AgentListReply = Schema.Struct({
  result: Schema.Struct({ agents: Schema.Array(AgentReply) }),
});
const AgentStatusReply = Schema.Struct({
  result: Schema.Struct({ agent: Schema.Struct({ agent_status: Schema.String }) }),
});
const PluginPaneReply = Schema.Struct({
  result: Schema.Struct({
    plugin_pane: Schema.Struct({
      pane: Schema.Struct({ tab_id: Schema.String, pane_id: Schema.String }),
    }),
  }),
});

const herdrError = (message: string, detail: string) => new HerdrError({ message, detail });
const herdrFail = (message: string, detail: string) => Effect.fail(herdrError(message, detail));

const decodeBoundary = <S extends Schema.Top>(operation: string, schema: S, value: BoundaryValue) =>
  Schema.decodeUnknownEffect(schema)(value).pipe(
    Effect.mapError((cause) =>
      herdrError(`${operation} returned an invalid response`, String(cause)),
    ),
  );

/**
 * One line of herdr's reply: its `result`, or the error it names. Both shapes come
 * back on the same socket, so the caller never has to look inside the envelope.
 */
const decodeReply = (
  method: string,
  line: string,
): Effect.Effect<Schema.Json | undefined, HerdrError> =>
  Schema.decodeUnknownEffect(JsonString)(line).pipe(
    Effect.mapError(() => herdrError(`${method} failed`, "invalid json response")),
    Effect.flatMap((message) => decodeBoundary(method, SocketReply, message)),
    Effect.flatMap((message) =>
      message.error
        ? herdrFail(`${method} failed`, message.error.message ?? message.error.code ?? "unknown")
        : Effect.succeed(message.result),
    ),
  );

/** A child's whole output as text. */
const collect = (stream: Stream.Stream<Uint8Array, PlatformError>) =>
  stream.pipe(
    Stream.decodeText(),
    Stream.runFold(
      (): string => "",
      (all, chunk) => all + chunk,
    ),
  );

function agentStatus(value: string): AgentStatus {
  if (value === "idle" || value === "working" || value === "blocked" || value === "done") {
    return value;
  }
  return "unknown";
}

export interface StartedTab {
  tabId: string;
  paneId: string;
}

export interface TabInfo {
  tabId: string;
  label: string;
}

export interface WorkspaceInfo {
  workspaceId: string;
  label: string;
  cwd: string;
  worktree: string | null;
}

export interface PaneInfo {
  paneId: string;
  tabId: string;
  label: string | null;
  agent: string | null;
}

/** A live agent as herdr sees it. Only named agents — the ones this plugin started. */
export interface AgentInfo {
  name: string;
  paneId: string;
  /** Which workspace herdr says it is in; scoping never trusts a record over this. */
  workspaceId: string | null;
  status: AgentStatus;
}

export class Herdr {
  private seq = 0;

  constructor(private readonly env: PluginEnv) {}

  /** Runs the herdr CLI; parses stdout as JSON when it is JSON. */
  cli(args: string[]): HerdrEffect<Schema.Json | string> {
    const exec = this.exec.bind(this);
    return Effect.gen(function* () {
      const { code, stdout, stderr } = yield* exec(args);
      if (code !== 0) {
        return yield* new HerdrError({
          message: `herdr ${args.slice(0, 2).join(" ")} failed (exit ${code})`,
          detail: stderr.trim() || stdout.trim(),
        });
      }
      const text = stdout.trim();
      if (!text.startsWith("{") && !text.startsWith("[")) return text;
      return yield* Schema.decodeUnknownEffect(JsonString)(text).pipe(
        Effect.catchTag("SchemaError", () => Effect.succeed(text)),
      );
    });
  }

  /** The subprocess boundary alone, so a test double can answer in-process. */
  protected exec(args: string[]): HerdrEffect<ExecResult> {
    const env = this.env;
    return Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const handle = yield* spawner.spawn(
        ChildProcess.make(env.binPath, args, {
          stdout: "pipe",
          stderr: "pipe",
          // extendEnv, so herdr sees the environment this process has with the plugin's
          // own keys over the top — what `{ ...Bun.env, ...env.raw }` used to spell.
          env: env.raw,
          extendEnv: true,
        }),
      );
      const [stdout, stderr, code] = yield* Effect.all(
        [collect(handle.stdout), collect(handle.stderr), handle.exitCode],
        { concurrency: "unbounded" },
      );
      return { code: Number(code), stdout, stderr };
    }).pipe(
      Effect.scoped,
      Effect.catch((cause) => herdrFail("herdr subprocess failed", String(cause))),
    );
  }

  /**
   * One request/response over the herdr socket (newline-delimited JSON), through
   * Effect's own Unix-domain client rather than a hand-rolled Bun.connect callback.
   * The exchange is one line out and one line back, so the read loop resolves on the
   * first newline and the scope closes the socket.
   */
  rpc(method: string, params: HerdrParams = {}): HerdrEffect<Schema.Json | undefined> {
    const path = this.env.socketPath;
    if (!path) return herdrFail(`cannot call ${method}`, "HERDR_SOCKET_PATH is not set");
    const id = `hw-${++this.seq}`;
    const payload = `${encodeJson({ id, method, params })}\n`;

    const exchange: HerdrEffect<Schema.Json | undefined> = Effect.gen(function* () {
      const socket = yield* BunSocket.makeNet({ path }).pipe(
        Effect.catch((cause) => herdrFail(`${method} failed`, String(cause))),
      );
      const answer = yield* Deferred.make<Schema.Json | undefined, HerdrError>();
      // Acquired in this scope, not inside onOpen: releasing the writer ends the
      // socket's write side, and doing that the moment the request was sent closed the
      // exchange before herdr had answered it.
      const write = yield* socket.writer;
      let buffered = "";

      const read = socket.runString(
        (chunk) =>
          Effect.gen(function* () {
            buffered += chunk;
            const newline = buffered.indexOf("\n");
            if (newline < 0) return;
            yield* Deferred.complete(answer, decodeReply(method, buffered.slice(0, newline)));
          }),
        {
          onOpen: Effect.orDie(write(payload)),
        },
      );

      // The read loop ends when herdr closes the socket. If that happens before a line
      // arrived, nobody is going to answer, and waiting on the deferred would hang.
      yield* Effect.forkScoped(
        read.pipe(
          Effect.matchEffect({
            onSuccess: () =>
              Deferred.complete(
                answer,
                herdrFail(`${method} failed`, "socket closed with no response"),
              ),
            onFailure: (cause) =>
              Deferred.complete(answer, herdrFail(`${method} failed`, String(cause))),
          }),
        ),
      );
      return yield* Deferred.await(answer);
    }).pipe(Effect.scoped);
    return exchange;
  }

  tabCreate(opts: { label?: string; cwd?: string; focus?: boolean }): HerdrEffect<StartedTab> {
    const env = this.env;
    const cli = this.cli.bind(this);
    return Effect.gen(function* () {
      const args = ["tab", "create"];
      if (env.workspaceId) args.push("--workspace", env.workspaceId);
      if (opts.cwd) args.push("--cwd", opts.cwd);
      if (opts.label) args.push("--label", opts.label);
      args.push(opts.focus ? "--focus" : "--no-focus");
      const res = yield* cli(args);
      const decoded = yield* decodeBoundary("herdr tab create", TabCreateReply, res);
      return {
        tabId: decoded.result.tab.tab_id,
        paneId: decoded.result.root_pane.pane_id,
      };
    });
  }

  tabRename(tabId: string, label: string): HerdrEffect<void> {
    return this.cli(["tab", "rename", tabId, label]).pipe(Effect.asVoid);
  }

  workspaceList(): HerdrEffect<WorkspaceInfo[]> {
    return this.cli(["workspace", "list"]).pipe(
      Effect.flatMap((res) => decodeBoundary("herdr workspace list", WorkspaceListReply, res)),
      Effect.map(({ result }) =>
        result.workspaces.map((workspace) => {
          const cwd =
            workspace.cwd ?? workspace.working_directory ?? workspace.worktree?.path ?? "";
          return {
            workspaceId: workspace.workspace_id,
            label: workspace.label,
            cwd,
            worktree: workspace.worktree?.path ?? workspace.worktree_path ?? null,
          };
        }),
      ),
    );
  }

  tabList(): HerdrEffect<TabInfo[]> {
    const env = this.env;
    const cli = this.cli.bind(this);
    return Effect.gen(function* () {
      const args = ["tab", "list"];
      if (env.workspaceId) args.push("--workspace", env.workspaceId);
      const res = yield* cli(args);
      const decoded = yield* decodeBoundary("herdr tab list", TabListReply, res);
      return decoded.result.tabs.map((tab) => ({
        tabId: tab.tab_id,
        label: tab.label,
      }));
    });
  }

  tabFocus(tabId: string): HerdrEffect<void> {
    return this.cli(["tab", "focus", tabId]).pipe(Effect.asVoid);
  }

  /** Reorders a tab within its workspace; 0 is first. No CLI for it in 0.8.2. */
  tabMove(tabId: string, insertIndex: number): HerdrEffect<void> {
    return this.rpc("tab.move", { tab_id: tabId, insert_index: insertIndex }).pipe(Effect.asVoid);
  }

  paneList(): HerdrEffect<PaneInfo[]> {
    return this.cli(["pane", "list"]).pipe(
      Effect.flatMap((res) => decodeBoundary("herdr pane list", PaneListReply, res)),
      Effect.map(({ result }) => {
        return result.panes.map((pane) => ({
          paneId: pane.pane_id,
          tabId: pane.tab_id,
          label: pane.label ?? null,
          agent: pane.agent ?? null,
        }));
      }),
    );
  }

  /** Moves a live pane into another tab; the process in it keeps running. */
  paneMove(opts: {
    paneId: string;
    tabId: string;
    targetPaneId?: string;
    direction?: "right" | "down";
    ratio?: number;
  }): HerdrEffect<void> {
    const args = ["pane", "move", opts.paneId, "--tab", opts.tabId];
    if (opts.targetPaneId) args.push("--target-pane", opts.targetPaneId);
    if (opts.direction) args.push("--split", opts.direction);
    if (opts.ratio !== undefined) args.push("--ratio", String(opts.ratio));
    return this.cli(args).pipe(Effect.asVoid);
  }

  paneSplit(opts: {
    paneId: string;
    direction: "right" | "down";
    ratio?: number;
    cwd?: string;
    focus?: boolean;
  }): HerdrEffect<string> {
    const cli = this.cli.bind(this);
    return Effect.gen(function* () {
      const args = ["pane", "split", opts.paneId, "--direction", opts.direction];
      if (opts.ratio !== undefined) args.push("--ratio", String(opts.ratio));
      if (opts.cwd) args.push("--cwd", opts.cwd);
      args.push(opts.focus ? "--focus" : "--no-focus");
      const res = yield* cli(args);
      const decoded = yield* decodeBoundary("herdr pane split", PaneSplitReply, res);
      return decoded.result.pane.pane_id;
    });
  }

  paneRun(paneId: string, command: string): HerdrEffect<void> {
    return this.cli(["pane", "run", paneId, command]).pipe(Effect.asVoid);
  }

  /** Exchanges two panes' positions; their slots keep their sizes. */
  paneSwap(sourcePaneId: string, targetPaneId: string): HerdrEffect<void> {
    return this.cli([
      "pane",
      "swap",
      "--source-pane",
      sourcePaneId,
      "--target-pane",
      targetPaneId,
    ]).pipe(Effect.asVoid);
  }

  paneZoom(paneId: string, on: boolean): HerdrEffect<void> {
    return this.cli(["pane", "zoom", paneId, on ? "--on" : "--off"]).pipe(Effect.asVoid);
  }

  paneRename(paneId: string, label: string): HerdrEffect<void> {
    return this.cli(["pane", "rename", paneId, label]).pipe(Effect.asVoid);
  }

  agentStart(opts: {
    name: string;
    kind: string;
    paneId: string;
    args?: string[];
    timeoutMs?: number;
  }): HerdrEffect<void> {
    const args = ["agent", "start", opts.name, "--kind", opts.kind, "--pane", opts.paneId];
    if (opts.timeoutMs) args.push("--timeout", String(opts.timeoutMs));
    if (opts.args?.length) args.push("--", ...opts.args);
    return this.cli(args).pipe(Effect.asVoid);
  }

  /** Submits without waiting so several agents can work at once. */
  agentPrompt(target: string, text: string): HerdrEffect<void> {
    return this.cli(["agent", "prompt", target, text]).pipe(Effect.asVoid);
  }

  agentWait(
    target: string,
    opts: { until?: AgentStatus[]; timeoutMs?: number } = {},
  ): HerdrEffect<void> {
    const args = ["agent", "wait", target];
    for (const s of opts.until ?? []) args.push("--until", s);
    if (opts.timeoutMs) args.push("--timeout", String(opts.timeoutMs));
    return this.cli(args).pipe(Effect.asVoid);
  }

  agentList(): HerdrEffect<AgentInfo[]> {
    return this.cli(["agent", "list"]).pipe(
      Effect.flatMap((res) => decodeBoundary("herdr agent list", AgentListReply, res)),
      Effect.map(({ result }) => {
        return result.agents
          .filter((agent) => agent.name !== "")
          .map((agent) => ({
            name: agent.name,
            paneId: agent.pane_id,
            workspaceId: agent.workspace_id ?? null,
            status: agentStatus(agent.agent_status),
          }));
      }),
    );
  }

  agentFocus(target: string): HerdrEffect<void> {
    return this.cli(["agent", "focus", target]).pipe(Effect.asVoid);
  }

  agentStatus(target: string): HerdrEffect<AgentStatus> {
    return this.cli(["agent", "get", target]).pipe(
      Effect.flatMap((res) => decodeBoundary("herdr agent get", AgentStatusReply, res)),
      Effect.map(({ result }) => agentStatus(result.agent.agent_status)),
    );
  }

  paneClose(paneId: string): HerdrEffect<void> {
    return this.cli(["pane", "close", paneId]).pipe(Effect.asVoid);
  }

  notify(
    title: string,
    body?: string,
    sound: "none" | "done" | "request" = "done",
  ): HerdrEffect<void> {
    const args = ["notification", "show", title, "--sound", sound];
    if (body) args.push("--body", body);
    return this.cli(args).pipe(Effect.asVoid);
  }

  pluginPaneOpen(opts: {
    entrypoint: string;
    env?: Record<string, string>;
    focus?: boolean;
    /** Only for non-popup placements: popups and overlays target the active pane. */
    workspaceId?: string | null;
    cwd?: string;
    /** Overrides the placement the manifest declares for this entrypoint. */
    placement?: "tab" | "split";
    targetPaneId?: string;
    direction?: "right" | "down";
  }): HerdrEffect<StartedTab> {
    const cli = this.cli.bind(this);
    return Effect.gen(function* () {
      const args = [
        "plugin",
        "pane",
        "open",
        "--plugin",
        PLUGIN_ID,
        "--entrypoint",
        opts.entrypoint,
      ];
      if (opts.workspaceId) args.push("--workspace", opts.workspaceId);
      if (opts.placement) args.push("--placement", opts.placement);
      if (opts.targetPaneId) args.push("--target-pane", opts.targetPaneId);
      if (opts.direction) args.push("--direction", opts.direction);
      if (opts.cwd) args.push("--cwd", opts.cwd);
      for (const [k, v] of Object.entries(opts.env ?? {})) args.push("--env", `${k}=${v}`);
      args.push(opts.focus === false ? "--no-focus" : "--focus");
      const res = yield* cli(args);
      const decoded = yield* decodeBoundary("herdr plugin pane open", PluginPaneReply, res);
      const pane = decoded.result.plugin_pane.pane;
      return { tabId: pane.tab_id, paneId: pane.pane_id };
    });
  }

  /** Filters the Agents sidebar to this run's panes. CLI has no equivalent in 0.7.5. */
  agentViewSet(source: string, label: string, paneIds: string[]): HerdrEffect<void> {
    return this.rpc("agent.view.set", {
      source,
      label,
      filter: { op: "in", field: "pane_id", values: paneIds },
    }).pipe(Effect.asVoid);
  }

  agentViewClear(source: string): HerdrEffect<void> {
    return this.rpc("agent.view.clear", { source }).pipe(Effect.asVoid);
  }

  popupClose(): HerdrEffect<void> {
    return this.rpc("popup.close", {}).pipe(Effect.asVoid);
  }
}

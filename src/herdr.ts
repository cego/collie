// The only channel to herdr: the CLI at HERDR_BIN_PATH, plus the socket at
// HERDR_SOCKET_PATH for the few methods 0.7.5 does not expose on the CLI.

import type { BunServices } from "@effect/platform-bun/BunServices";
import { Cause, Data, Effect, Option, Schema } from "effect";
import type { PluginEnv } from "./env";
import { PLUGIN_ID } from "./env";

export type AgentStatus = "idle" | "working" | "blocked" | "done" | "unknown";

export class HerdrError extends Data.TaggedError("HerdrError")<{
  readonly message: string;
  readonly detail: string;
}> {}

type HerdrEffect<A> = Effect.Effect<A, HerdrError, BunServices>;
type ExecResult = { code: number; stdout: string; stderr: string };
type HerdrValue = Schema.Json | string | undefined;
type HerdrParams = Schema.JsonObject;

const JsonString = Schema.fromJsonString(Schema.Json);
const encodeJson = Schema.encodeSync(JsonString);

const herdrError = (message: string, detail: string) => new HerdrError({ message, detail });

function record(value: HerdrValue): Schema.JsonObject | undefined {
  return Option.getOrUndefined(Schema.decodeUnknownOption(Schema.JsonObject)(value));
}

function property(value: HerdrValue, key: string): Schema.Json | undefined {
  return record(value)?.[key];
}

function propertyPath(value: HerdrValue, path: string[]): Schema.Json | undefined {
  let current = value;
  for (const key of path) current = property(current, key);
  return current;
}

function stringPath(value: HerdrValue, path: string[], fallback = ""): string {
  const found = propertyPath(value, path);
  return Option.getOrElse(Schema.decodeUnknownOption(Schema.String)(found), () => fallback);
}

function nullableStringPath(value: HerdrValue, path: string[]): string | null {
  const found = propertyPath(value, path);
  return Option.getOrElse(Schema.decodeUnknownOption(Schema.String)(found), () => null);
}

function arrayPath(value: HerdrValue, path: string[]): readonly Schema.Json[] {
  const found = propertyPath(value, path);
  return Option.getOrElse(Schema.decodeUnknownOption(Schema.Array(Schema.Json))(found), () => []);
}

function agentStatus(value: HerdrValue): AgentStatus {
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
    return Effect.tryPromise(() => {
      const proc = Bun.spawn([this.env.binPath, ...args], {
        stdout: "pipe",
        stderr: "pipe",
        env: { ...Bun.env, ...this.env.raw },
      });
      return Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ]).then(([stdout, stderr, code]) => ({ code, stdout, stderr }));
    }).pipe(
      Effect.mapError((error: Cause.UnknownError) =>
        herdrError("herdr subprocess failed", error.message),
      ),
    );
  }

  /** One request/response over the herdr socket (newline-delimited JSON). */
  rpc(method: string, params: HerdrParams = {}): HerdrEffect<Schema.Json | undefined> {
    const path = this.env.socketPath;
    if (!path)
      return Effect.fail(herdrError(`cannot call ${method}`, "HERDR_SOCKET_PATH is not set"));
    const id = `hw-${++this.seq}`;
    const payload = `${encodeJson({ id, method, params })}\n`;

    return Effect.callback<Schema.Json | undefined, HerdrError>((resume) => {
      let buf = "";
      let done = false;
      let opened = false;
      const fail = (socket: Bun.Socket | undefined, detail: string) => {
        if (done) return;
        done = true;
        socket?.terminate();
        resume(Effect.fail(herdrError(`${method} failed`, detail)));
      };

      void Bun.connect({
        unix: path,
        socket: {
          open(socket) {
            opened = true;
            socket.write(payload);
          },
          data(socket, chunk) {
            buf += Buffer.from(chunk).toString("utf8");
            const nl = buf.indexOf("\n");
            if (nl < 0) return;
            done = true;
            socket.end();
            const msg = Option.getOrUndefined(
              Schema.decodeUnknownOption(JsonString)(buf.slice(0, nl)),
            );
            if (msg === undefined) {
              fail(socket, "invalid json response");
              return;
            }
            const message = stringPath(
              msg,
              ["error", "message"],
              stringPath(msg, ["error", "code"], "unknown"),
            );
            if (property(msg, "error") !== undefined) {
              fail(socket, message);
              return;
            }
            resume(Effect.succeed(property(msg, "result")));
          },
          error(socket, error) {
            fail(socket, error.message);
          },
          connectError(socket, error) {
            fail(socket, error.message);
          },
          close(socket) {
            if (!done && opened) fail(socket, "socket closed with no response");
          },
        },
      });
    });
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
      return {
        tabId: stringPath(res, ["result", "tab", "tab_id"]),
        paneId: stringPath(res, ["result", "root_pane", "pane_id"]),
      };
    });
  }

  tabRename(tabId: string, label: string): HerdrEffect<void> {
    return this.cli(["tab", "rename", tabId, label]).pipe(Effect.asVoid);
  }

  workspaceList(): HerdrEffect<WorkspaceInfo[]> {
    return this.cli(["workspace", "list"]).pipe(
      Effect.map((res) => {
        const spaces = arrayPath(res, ["result", "workspaces"]);
        return spaces.map((w) => ({
          workspaceId: stringPath(w, ["workspace_id"]),
          label: stringPath(w, ["label"]),
          cwd: stringPath(
            w,
            ["cwd"],
            stringPath(w, ["working_directory"], stringPath(w, ["worktree", "path"])),
          ),
          worktree:
            nullableStringPath(w, ["worktree", "path"]) ?? nullableStringPath(w, ["worktree_path"]),
        }));
      }),
    );
  }

  tabList(): HerdrEffect<TabInfo[]> {
    const env = this.env;
    const cli = this.cli.bind(this);
    return Effect.gen(function* () {
      const args = ["tab", "list"];
      if (env.workspaceId) args.push("--workspace", env.workspaceId);
      const res = yield* cli(args);
      return arrayPath(res, ["result", "tabs"]).map((t) => ({
        tabId: stringPath(t, ["tab_id"]),
        label: stringPath(t, ["label"]),
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
      Effect.map((res) => {
        return arrayPath(res, ["result", "panes"]).map((p) => ({
          paneId: stringPath(p, ["pane_id"]),
          tabId: stringPath(p, ["tab_id"]),
          label: nullableStringPath(p, ["label"]),
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
      return stringPath(res, ["result", "pane", "pane_id"]);
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
      Effect.map((res) => {
        const agents = arrayPath(res, ["result", "agents"]);
        return agents
          .filter((a) => stringPath(a, ["name"]) !== "")
          .map((a) => ({
            name: stringPath(a, ["name"]),
            paneId: stringPath(a, ["pane_id"]),
            workspaceId: nullableStringPath(a, ["workspace_id"]),
            status: agentStatus(property(a, "agent_status")),
          }));
      }),
    );
  }

  agentFocus(target: string): HerdrEffect<void> {
    return this.cli(["agent", "focus", target]).pipe(Effect.asVoid);
  }

  agentStatus(target: string): HerdrEffect<AgentStatus> {
    return this.cli(["agent", "get", target]).pipe(
      Effect.map((res) => agentStatus(propertyPath(res, ["result", "agent", "agent_status"]))),
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
      const pane = propertyPath(res, ["result", "plugin_pane", "pane"]);
      return { tabId: stringPath(pane, ["tab_id"]), paneId: stringPath(pane, ["pane_id"]) };
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

// The only channel to herdr: the CLI at HERDR_BIN_PATH, plus the socket at
// HERDR_SOCKET_PATH for the few methods 0.7.5 does not expose on the CLI.

import { connect } from "node:net";
import type { PluginEnv } from "./env";
import { PLUGIN_ID } from "./env";

export type AgentStatus = "idle" | "working" | "blocked" | "done" | "unknown";

export class HerdrError extends Error {
  constructor(
    message: string,
    readonly detail: string,
  ) {
    super(message);
  }
}

export interface StartedTab {
  tabId: string;
  paneId: string;
}

export class Herdr {
  private seq = 0;

  constructor(private readonly env: PluginEnv) {}

  /** Runs the herdr CLI; parses stdout as JSON when it is JSON. */
  async cli(args: string[]): Promise<any> {
    const proc = Bun.spawn([this.env.binPath, ...args], {
      stdout: "pipe",
      stderr: "pipe",
      env: process.env as Record<string, string>,
    });
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    if (code !== 0) {
      throw new HerdrError(`herdr ${args.slice(0, 2).join(" ")} failed (exit ${code})`, stderr.trim() || stdout.trim());
    }
    const text = stdout.trim();
    if (!text.startsWith("{") && !text.startsWith("[")) return text;
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }

  /** One request/response over the herdr socket (newline-delimited JSON). */
  async rpc(method: string, params: Record<string, unknown> = {}): Promise<any> {
    const path = this.env.socketPath;
    if (!path) throw new HerdrError(`cannot call ${method}`, "HERDR_SOCKET_PATH is not set");
    const id = `hw-${++this.seq}`;
    const payload = `${JSON.stringify({ id, method, params })}\n`;

    return await new Promise((resolve, reject) => {
      const sock = connect(path);
      let buf = "";
      const fail = (e: Error) => {
        sock.destroy();
        reject(new HerdrError(`${method} failed`, e.message));
      };
      sock.on("error", fail);
      sock.on("connect", () => sock.write(payload));
      sock.on("data", (chunk) => {
        buf += chunk.toString();
        const nl = buf.indexOf("\n");
        if (nl < 0) return;
        sock.end();
        let msg: any;
        try {
          msg = JSON.parse(buf.slice(0, nl));
        } catch (e) {
          return fail(e as Error);
        }
        if (msg.error) return fail(new Error(msg.error.message ?? msg.error.code ?? "unknown"));
        resolve(msg.result);
      });
      sock.on("close", () => {
        if (buf === "") reject(new HerdrError(`${method} failed`, "socket closed with no response"));
      });
    });
  }

  async tabCreate(opts: { label?: string; cwd?: string; focus?: boolean }): Promise<StartedTab> {
    const args = ["tab", "create"];
    if (this.env.workspaceId) args.push("--workspace", this.env.workspaceId);
    if (opts.cwd) args.push("--cwd", opts.cwd);
    if (opts.label) args.push("--label", opts.label);
    args.push(opts.focus ? "--focus" : "--no-focus");
    const res = await this.cli(args);
    return {
      tabId: res?.result?.tab?.tab_id ?? "",
      paneId: res?.result?.root_pane?.pane_id ?? "",
    };
  }

  async tabRename(tabId: string, label: string): Promise<void> {
    await this.cli(["tab", "rename", tabId, label]);
  }

  async paneSplit(opts: {
    paneId: string;
    direction: "right" | "down";
    ratio?: number;
    cwd?: string;
    focus?: boolean;
  }): Promise<string> {
    const args = ["pane", "split", opts.paneId, "--direction", opts.direction];
    if (opts.ratio !== undefined) args.push("--ratio", String(opts.ratio));
    if (opts.cwd) args.push("--cwd", opts.cwd);
    args.push(opts.focus ? "--focus" : "--no-focus");
    const res = await this.cli(args);
    return res?.result?.pane?.pane_id ?? "";
  }

  async paneRename(paneId: string, label: string): Promise<void> {
    await this.cli(["pane", "rename", paneId, label]);
  }

  async agentStart(opts: {
    name: string;
    kind: string;
    paneId: string;
    args?: string[];
    timeoutMs?: number;
  }): Promise<void> {
    const args = ["agent", "start", opts.name, "--kind", opts.kind, "--pane", opts.paneId];
    if (opts.timeoutMs) args.push("--timeout", String(opts.timeoutMs));
    if (opts.args?.length) args.push("--", ...opts.args);
    await this.cli(args);
  }

  async agentPrompt(
    target: string,
    text: string,
    opts: { until?: AgentStatus[]; timeoutMs?: number } = {},
  ): Promise<void> {
    const args = ["agent", "prompt", target, text, "--wait"];
    for (const s of opts.until ?? []) args.push("--until", s);
    if (opts.timeoutMs) args.push("--timeout", String(opts.timeoutMs));
    await this.cli(args);
  }

  async agentWait(
    target: string,
    opts: { until?: AgentStatus[]; timeoutMs?: number } = {},
  ): Promise<void> {
    const args = ["agent", "wait", target];
    for (const s of opts.until ?? []) args.push("--until", s);
    if (opts.timeoutMs) args.push("--timeout", String(opts.timeoutMs));
    await this.cli(args);
  }

  async agentRead(target: string, lines = 40): Promise<string> {
    const res = await this.cli(["agent", "read", target, "--source", "recent", "--lines", String(lines)]);
    return typeof res === "string" ? res : (res?.result?.text ?? "");
  }

  async notify(title: string, body?: string, sound: "none" | "done" | "request" = "done"): Promise<void> {
    const args = ["notification", "show", title, "--sound", sound];
    if (body) args.push("--body", body);
    await this.cli(args);
  }

  async pluginPaneOpen(opts: {
    entrypoint: string;
    env?: Record<string, string>;
    focus?: boolean;
  }): Promise<void> {
    const args = ["plugin", "pane", "open", "--plugin", PLUGIN_ID, "--entrypoint", opts.entrypoint];
    if (this.env.workspaceId) args.push("--workspace", this.env.workspaceId);
    for (const [k, v] of Object.entries(opts.env ?? {})) args.push("--env", `${k}=${v}`);
    args.push(opts.focus === false ? "--no-focus" : "--focus");
    await this.cli(args);
  }

  /** Filters the Agents sidebar to this run's panes. CLI has no equivalent in 0.7.5. */
  async agentViewSet(source: string, label: string, paneIds: string[]): Promise<void> {
    await this.rpc("agent.view.set", {
      source,
      label,
      filter: { op: "in", field: "pane_id", values: paneIds },
    });
  }

  async agentViewClear(source: string): Promise<void> {
    await this.rpc("agent.view.clear", { source });
  }

  async popupClose(): Promise<void> {
    await this.rpc("popup.close", {});
  }
}

// Test rig: a temp plugin sandbox, a fake `herdr` on HERDR_BIN_PATH and a fake
// socket on HERDR_SOCKET_PATH, both recording into one ordered log.

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, type Server } from "node:net";
import { readEnv, type PluginEnv } from "../../src/env";

const FAKE_HERDR = new URL("./fake-herdr.ts", import.meta.url).pathname;

export interface Call {
  transport: "cli" | "rpc";
  cmd: string;
  argv?: string[];
  method?: string;
  params?: Record<string, unknown>;
}

export class Rig {
  readonly root: string;
  readonly logPath: string;
  readonly socketPath: string;
  readonly binPath: string;
  readonly stateDir: string;
  readonly configDir: string;
  readonly baselineDir: string;
  readonly projectDir: string;
  private server: Server | null = null;

  constructor() {
    this.root = mkdtempSync(join(tmpdir(), "hw-test-"));
    this.logPath = join(this.root, "calls.jsonl");
    this.socketPath = join(this.root, "herdr.sock");
    this.binPath = join(this.root, "herdr");
    this.stateDir = join(this.root, "state");
    this.configDir = join(this.root, "config");
    this.baselineDir = join(this.root, "baseline");
    this.projectDir = join(this.root, "project");
    for (const d of [this.stateDir, this.configDir, this.baselineDir, this.projectDir]) {
      mkdirSync(d, { recursive: true });
    }
    writeFileSync(this.binPath, `#!/bin/sh\nexec bun ${FAKE_HERDR} "$@"\n`, { mode: 0o755 });
  }

  /** Stands in for the agents: each queue entry is written for the next prompt. */
  queueOutputs(items: unknown[]): void {
    writeFileSync(join(this.root, "outputs.json"), JSON.stringify(items));
  }

  async startSocket(): Promise<void> {
    this.server = createServer((sock) => {
      let buf = "";
      sock.on("data", (chunk) => {
        buf += chunk.toString();
        let nl: number;
        while ((nl = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, nl);
          buf = buf.slice(nl + 1);
          if (!line.trim()) continue;
          const req = JSON.parse(line);
          appendFileSync(
            this.logPath,
            `${JSON.stringify({ transport: "rpc", cmd: req.method, method: req.method, params: req.params })}\n`,
          );
          sock.write(`${JSON.stringify({ id: req.id, result: { type: "ok" } })}\n`);
        }
      });
    });
    await new Promise<void>((resolve) => this.server!.listen(this.socketPath, resolve));
  }

  env(overrides: Record<string, string> = {}): Record<string, string> {
    return {
      HOME: this.root,
      PATH: process.env.PATH!,
      HERDR_ENV: "1",
      HERDR_BIN_PATH: this.binPath,
      HERDR_SOCKET_PATH: this.socketPath,
      HERDR_PLUGIN_ROOT: this.baselineDir,
      HERDR_PLUGIN_CONFIG_DIR: this.configDir,
      HERDR_PLUGIN_STATE_DIR: this.stateDir,
      HERDR_WORKSPACE_ID: "1",
      HERDR_TAB_ID: "1:1",
      HERDR_PANE_ID: "1-1",
      HERDR_WORKFLOWS_CWD: this.projectDir,
      FAKE_HERDR_LOG: this.logPath,
      FAKE_HERDR_OUTPUTS: join(this.root, "outputs.json"),
      ...overrides,
    };
  }

  pluginEnv(overrides: Record<string, string> = {}): PluginEnv {
    const env = this.env(overrides);
    // The fake CLI reads its own config from the ambient environment; clear the
    // keys this rig does not set so one test cannot leak into the next.
    for (const k of [
      "FAKE_HERDR_LOG",
      "FAKE_HERDR_OUTPUTS",
      "FAKE_HERDR_FAIL",
      "FAKE_HERDR_AGENT_STATUS",
      "FAKE_HERDR_BLOCK_START",
    ]) {
      if (env[k]) process.env[k] = env[k];
      else delete process.env[k];
    }
    return readEnv(env);
  }

  calls(): Call[] {
    if (!existsSync(this.logPath)) return [];
    return readFileSync(this.logPath, "utf8")
      .split("\n")
      .filter((l) => l.trim())
      .map((l) => JSON.parse(l) as Call);
  }

  cmds(): string[] {
    return this.calls().map((c) => c.cmd);
  }

  async close(): Promise<void> {
    if (this.server) await new Promise<void>((r) => this.server!.close(() => r()));
    rmSync(this.root, { recursive: true, force: true });
  }
}

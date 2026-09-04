// The only channel to herdr: the CLI at HERDR_BIN_PATH, plus the socket at
// HERDR_SOCKET_PATH for the few methods 0.8.2 does not expose on the CLI — and herdr's
// own `config.toml`, for the few things it settles but answers no question about. Every
// fact about herdr is behind this one interface, which is what makes the fake herdr in
// `test/support/` enough to test everything above it.

import type { BunServices } from "@effect/platform-bun/BunServices";
import { Data, Deferred, Effect, FileSystem, Option, Path, Schema, Stream } from "effect";
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
  /** herdr's own code, where it answered with one — `agent_not_found` and friends. */
  readonly code?: string;
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
  // `null` for a workspace that is not worktree-backed, which is most of them. herdr's
  // worktree object is `{ checkout_path, repo_root, ... }`; `path` is the older name.
  // All three tolerated: a required key here made every workspace undecodable the
  // moment one of them was worktree-backed.
  worktree: Schema.optionalKey(
    Schema.NullOr(
      Schema.Struct({
        path: Schema.optionalKey(Schema.String),
        checkout_path: Schema.optionalKey(Schema.String),
      }),
    ),
  ),
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
        workspace_id: Schema.optionalKey(Schema.NullOr(Schema.String)),
        cwd: Schema.optionalKey(Schema.NullOr(Schema.String)),
        // Where the process in the pane is now, which is not where it started once
        // anything has `cd`-ed.
        foreground_cwd: Schema.optionalKey(Schema.NullOr(Schema.String)),
      }),
    ),
  }),
});
const PaneSplitReply = Schema.Struct({
  result: Schema.Struct({ pane: Schema.Struct({ pane_id: Schema.String }) }),
});
const AgentReply = Schema.Struct({
  // herdr sends `null` for an agent it did not start, and older versions omitted the
  // key; one of those in the workspace must not make the whole list undecodable.
  name: Schema.optionalKey(Schema.NullOr(Schema.String)),
  pane_id: Schema.String,
  workspace_id: Schema.optionalKey(Schema.NullOr(Schema.String)),
  agent_status: Schema.String,
  /**
   * What the harness published as its pane's terminal title — Claude Code puts the task
   * it is on there. herdr omits it for a pane that never set one.
   */
  terminal_title: Schema.optionalKey(Schema.NullOr(Schema.String)),
});
const AgentListReply = Schema.Struct({
  result: Schema.Struct({ agents: Schema.Array(AgentReply) }),
});
const AgentStatusReply = Schema.Struct({
  result: Schema.Struct({ agent: Schema.Struct({ agent_status: Schema.String }) }),
});
const WorktreeReply = Schema.Struct({
  path: Schema.String,
  // A detached checkout has no branch, and herdr says so by leaving it out.
  branch: Schema.optionalKey(Schema.NullOr(Schema.String)),
  open_workspace_id: Schema.optionalKey(Schema.NullOr(Schema.String)),
});
const WorktreeListReply = Schema.Struct({
  result: Schema.Struct({
    worktrees: Schema.Array(WorktreeReply),
    // Which checkout the repository itself is: the one place a command about the
    // repository can be run from and still be there afterwards.
    source: Schema.optionalKey(
      Schema.Struct({
        source_checkout_path: Schema.optionalKey(Schema.String),
        repo_root: Schema.optionalKey(Schema.String),
      }),
    ),
  }),
});
const WorktreeWorkspaceReply = Schema.Struct({
  worktree: WorktreeReply,
  workspace: Schema.Struct({
    workspace_id: Schema.String,
    label: Schema.optionalKey(Schema.String),
  }),
});
/**
 * What `create` and `open` both answer with, and the shell tab that only `create` may
 * add. Optional, and that is the contract rather than laxity: herdr's own schema gives
 * `worktree_created` two variants — `{type, workspace, worktree}` and the same plus
 * `{tab, root_pane}` — so a create reply without them is as legal as one with them, and
 * requiring them refused a Run its checkout over a tab it did not need. `worktree_opened`
 * has one variant and never carries them.
 */
const WorktreeReplyBody = Schema.Struct({
  ...WorktreeWorkspaceReply.fields,
  tab: Schema.optionalKey(Schema.Struct({ tab_id: Schema.String })),
  root_pane: Schema.optionalKey(Schema.Struct({ pane_id: Schema.String })),
});
const WorktreeOpenReply = Schema.Struct({ result: WorktreeReplyBody });

/** herdr's `config.toml`, as far as this plugin has any business reading it. */
const HerdrConfig = Schema.Struct({
  worktrees: Schema.optionalKey(Schema.Struct({ directory: Schema.optionalKey(Schema.String) })),
});

const PluginPaneReply = Schema.Struct({
  result: Schema.Struct({
    plugin_pane: Schema.Struct({
      pane: Schema.Struct({ tab_id: Schema.String, pane_id: Schema.String }),
    }),
  }),
});

/**
 * Every method this module calls over the socket. Named as a list, and `rpc` accepts
 * nothing else, so a new socket call has to be added here — which is what lets
 * `test/herdr-contract.test.ts` prove its request table covers all of them rather than
 * going green on a method nobody checked.
 */
export const SOCKET_METHODS = [
  "tab.move",
  "agent.view.set",
  "agent.view.clear",
  "popup.close",
] as const;

export type SocketMethod = (typeof SOCKET_METHODS)[number];

/**
 * Every reply shape this module decodes, keyed by name. Exported as one record rather
 * than twelve names so the herdr interface stays about calling herdr, and so
 * `test/herdr-contract.test.ts` can prove its table covers all of them: a reply added
 * here without a row there fails that test instead of going unchecked.
 */
export const replySchemas = {
  ErrorReply,
  SocketReply,
  TabCreateReply,
  WorkspaceListReply,
  TabListReply,
  PaneListReply,
  PaneSplitReply,
  AgentListReply,
  AgentStatusReply,
  WorktreeListReply,
  WorktreeOpenReply,
  PluginPaneReply,
} as const;

const herdrError = (message: string, detail: string, code?: string) =>
  new HerdrError({ message, detail, code });

/** herdr answers a missing target with an error envelope and exit 0, not a failure. */
const ErrorEnvelope = Schema.Struct({ error: ErrorReply });

/** The code herdr named, when what came back was one of its error envelopes. */
function envelopeError(operation: string, value: BoundaryValue): HerdrError | null {
  return Option.match(Schema.decodeUnknownOption(ErrorEnvelope)(value), {
    onNone: () => null,
    onSome: (reply) =>
      herdrError(operation, reply.error.message ?? reply.error.code ?? "unknown", reply.error.code),
  });
}
const herdrFail = (message: string, detail: string) => Effect.fail(herdrError(message, detail));

/**
 * A target herdr does not have — a branch with no checkout, a repository it cannot key
 * — is answered, not failed: exit 0 with an error envelope. Naming its code is what
 * lets a caller tell that from "herdr did not answer me".
 */
const decodeOrNamed = <S extends Schema.Top>(
  operation: string,
  schema: S,
  value: BoundaryValue,
) => {
  const named = envelopeError(operation, value);
  return named ? Effect.fail(named) : decodeBoundary(operation, schema, value);
};

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

/** The checkout and the workspace holding it, which both `create` and `open` answer with. */
function worktreeWorkspace(result: Schema.Schema.Type<typeof WorktreeWorkspaceReply>) {
  return {
    ...worktreeInfo(result.worktree),
    workspaceId: result.workspace.workspace_id,
    label: result.workspace.label ?? null,
  };
}

function worktreeInfo(worktree: {
  path: string;
  branch?: string | null;
  open_workspace_id?: string | null;
}): WorktreeInfo {
  return {
    path: worktree.path,
    branch: worktree.branch ?? null,
    workspaceId: worktree.open_workspace_id ?? null,
  };
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

/** One checkout of a repository, as `herdr worktree list` reports it. */
export interface WorktreeInfo {
  path: string;
  branch: string | null;
  /** The workspace herdr has this checkout open in, when one is open. */
  workspaceId: string | null;
}

/** Every checkout of one repository, and which of them the repository itself is. */
export interface WorktreeListing {
  worktrees: WorktreeInfo[];
  /** The source checkout, which outlives the removal of any of the others. */
  source: string | null;
}

/** A worktree and the workspace herdr opened for it. */
export interface WorktreeWorkspace extends WorktreeInfo {
  workspaceId: string;
  label: string | null;
  /**
   * The shell tab a newly-made workspace comes with, which whoever asked for the
   * worktree may take over. Null for a workspace that already existed.
   */
  rootTab: StartedTab | null;
}

export interface PaneInfo {
  paneId: string;
  tabId: string;
  label: string | null;
  agent: string | null;
  workspaceId: string | null;
  /** Where the pane's process was started, which is the directory it stands for. */
  cwd: string | null;
  /** Where it is working now, where herdr can see that — an agent that `cd`-ed. */
  foregroundCwd: string | null;
}

/** A live agent as herdr sees it. Only named agents — the ones this plugin started. */
export interface AgentInfo {
  name: string;
  paneId: string;
  /** Which workspace herdr says it is in; scoping never trusts a record over this. */
  workspaceId: string | null;
  status: AgentStatus;
  /**
   * What the agent says it is doing, from its pane's terminal title, or `null` where the
   * harness publishes none. herdr's own spinner glyph is stripped: it animates, so a
   * board that kept it would redraw a row that had not changed.
   */
  title: string | null;
}

/**
 * herdr prefixes a live pane's title with a spinner frame and a space — `◐ `, `⠹ `.
 * Only that is removed, and the space after it is what identifies it: dropping every
 * leading non-alphanumeric instead took the title's own punctuation with it, so
 * `◐ [Fix] the parser` arrived as `Fix] the parser`.
 */
const SPINNER = /^[^\p{L}\p{N}\s]+\s+/u;

function agentTitle(raw: string | null | undefined): string | null {
  const title = (raw ?? "").replace(SPINNER, "").trim();
  return title === "" ? null : title;
}

/** `herdr agent list` as this plugin reads it: the agents it named, and what each is on. */
export const decodeAgentList = (res: BoundaryValue) =>
  decodeBoundary("herdr agent list", AgentListReply, res).pipe(
    Effect.map(({ result }) =>
      result.agents.flatMap((agent): AgentInfo[] =>
        agent.name
          ? [
              {
                name: agent.name,
                paneId: agent.pane_id,
                workspaceId: agent.workspace_id ?? null,
                status: agentStatus(agent.agent_status),
                title: agentTitle(agent.terminal_title),
              },
            ]
          : [],
      ),
    ),
  );

/** `herdr workspace list` as this plugin reads it; a worktree-backed workspace's checkout is its directory. */
export const decodeWorkspaceList = (res: BoundaryValue) =>
  decodeBoundary("herdr workspace list", WorkspaceListReply, res).pipe(
    Effect.map(({ result }) =>
      result.workspaces.map((workspace): WorkspaceInfo => {
        const worktree =
          workspace.worktree?.checkout_path ??
          workspace.worktree?.path ??
          workspace.worktree_path ??
          null;
        return {
          workspaceId: workspace.workspace_id,
          label: workspace.label,
          cwd: workspace.cwd ?? workspace.working_directory ?? worktree ?? "",
          worktree,
        };
      }),
    ),
  );

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
  rpc(method: SocketMethod, params: HerdrParams = {}): HerdrEffect<Schema.Json | undefined> {
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

  /** Closes a tab and every pane in it; what a removed checkout's dead shells get. */
  tabClose(tabId: string): HerdrEffect<void> {
    return this.cli(["tab", "close", tabId]).pipe(Effect.asVoid);
  }

  tabRename(tabId: string, label: string): HerdrEffect<void> {
    return this.cli(["tab", "rename", tabId, label]).pipe(Effect.asVoid);
  }

  workspaceList(): HerdrEffect<WorkspaceInfo[]> {
    return this.cli(["workspace", "list"]).pipe(Effect.flatMap(decodeWorkspaceList));
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
          workspaceId: pane.workspace_id ?? null,
          cwd: pane.cwd ?? null,
          foregroundCwd: pane.foreground_cwd ?? null,
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

  /** A bounded tail of a pane's output. Polled while a step runs, so never the lot. */
  paneRead(paneId: string, lines = 40): HerdrEffect<string> {
    // `pane read` answers with the terminal text itself, not an envelope — but a pane
    // showing JSON (this plugin's own output, for one) starts with `{`, and `cli`
    // parses that as a reply. Either way what comes back is a sample of what the pane
    // holds, which is all liveness needs, so both shapes are rendered as text rather
    // than one of them being an error that costs the tail entirely.
    return this.cli(["pane", "read", paneId, "--lines", String(lines)]).pipe(
      Effect.map((res) =>
        Schema.decodeUnknownOption(Schema.String)(res).pipe(
          Option.getOrElse(() => encodeJson(res)),
        ),
      ),
    );
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
    return this.cli(["agent", "list"]).pipe(Effect.flatMap(decodeAgentList));
  }

  agentFocus(target: string): HerdrEffect<void> {
    return this.cli(["agent", "focus", target]).pipe(Effect.asVoid);
  }

  agentStatus(target: string): HerdrEffect<AgentStatus> {
    return this.cli(["agent", "get", target]).pipe(
      Effect.flatMap((res) => {
        // An agent herdr does not have is answered, not failed: exit 0 with an error
        // envelope. Carrying its code is what lets a caller tell "this agent is gone"
        // from "herdr did not answer me", which are opposite things to do about.
        const named = envelopeError("herdr agent get", res);
        return named
          ? Effect.fail(named)
          : decodeBoundary("herdr agent get", AgentStatusReply, res).pipe(
              Effect.map(({ result }) => agentStatus(result.agent.agent_status)),
            );
      }),
    );
  }

  /**
   * Every checkout of the repository at `cwd`, the source checkout included. Git
   * allows one worktree per checked-out branch, so this is the index a Run's
   * checkout is looked up in.
   */
  worktreeList(cwd: string): HerdrEffect<WorktreeListing> {
    return this.cli(["worktree", "list", "--cwd", cwd]).pipe(
      Effect.flatMap((res) => decodeOrNamed("herdr worktree list", WorktreeListReply, res)),
      Effect.map(({ result }) => ({
        worktrees: result.worktrees.map(worktreeInfo),
        source: result.source?.source_checkout_path ?? result.source?.repo_root ?? null,
      })),
    );
  }

  /**
   * Where herdr keeps a repository's worktrees: what its own `config.toml` says, and
   * herdr's default otherwise. There is no command to ask, so this is the one thing
   * about herdr that is read from its config rather than from herdr — and it lives
   * here so that "where would herdr have put this checkout" is a question with one
   * answer, whoever is asking. A caller Collie makes a checkout for needs that answer
   * for herdr's own "open worktree" UI to still list it.
   *
   * `HERDR_CONFIG_PATH` moves that file, and herdr honours it, so this follows it.
   * XDG_CONFIG_HOME is not consulted: the fallback is herdr's own default, and a
   * machine that keeps its config elsewhere says so with `HERDR_CONFIG_PATH`.
   */
  worktreesDirectory(): Effect.Effect<string, never, BunServices> {
    const { home, herdrConfigPath } = this.env;
    return Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      // The config herdr is reading, which `HERDR_CONFIG_PATH` may move: asking the
      // default while herdr honours an override would put the checkout somewhere herdr
      // never configured, which is the one thing this must not do.
      const configured = yield* fs
        .readFileString(herdrConfigPath ?? path.join(home, ".config", "herdr", "config.toml"))
        .pipe(
          Effect.flatMap((text) => Effect.try(() => Bun.TOML.parse(text))),
          Effect.map((parsed) =>
            Schema.decodeUnknownOption(HerdrConfig)(parsed).pipe(Option.getOrUndefined),
          ),
          // No config file, one that will not parse, and one herdr itself would reject
          // are the same answer: nothing here has moved the worktrees.
          Effect.catch(() => Effect.succeed(undefined)),
        );
      return configured?.worktrees?.directory ?? path.join(home, ".herdr", "worktrees");
    });
  }

  worktreeCreate(opts: {
    cwd: string;
    branch: string;
    base?: string;
    label?: string;
  }): HerdrEffect<WorktreeWorkspace> {
    const args = ["worktree", "create", "--cwd", opts.cwd, "--branch", opts.branch];
    if (opts.base) args.push("--base", opts.base);
    if (opts.label) args.push("--label", opts.label);
    args.push("--no-focus");
    return this.cli(args).pipe(
      Effect.flatMap((res) => decodeOrNamed("herdr worktree create", WorktreeOpenReply, res)),
      Effect.map(({ result }) => ({
        ...worktreeWorkspace(result),
        // Both keys or neither: the variant that carries the tab carries its pane too,
        // and a Run with one and not the other has nothing it can reuse.
        rootTab:
          result.tab && result.root_pane
            ? { tabId: result.tab.tab_id, paneId: result.root_pane.pane_id }
            : null,
      })),
    );
  }

  /** Opens a workspace on a checkout that already exists, or focuses the one it has. */
  worktreeOpen(opts: {
    cwd: string;
    path?: string;
    branch?: string;
    label?: string;
  }): HerdrEffect<WorktreeWorkspace> {
    const args = ["worktree", "open", "--cwd", opts.cwd];
    if (opts.path) args.push("--path", opts.path);
    if (opts.branch) args.push("--branch", opts.branch);
    if (opts.label) args.push("--label", opts.label);
    args.push("--no-focus");
    return this.opened("herdr worktree open", args);
  }

  /**
   * Removes the checkout the workspace holds and closes the workspace with it. No
   * `--force`, ever: git's own refusal to drop a dirty or unmerged checkout is the
   * last guard against a wrong judgement about what is safe to delete.
   */
  worktreeRemove(workspaceId: string): HerdrEffect<void> {
    return this.cli(["worktree", "remove", "--workspace", workspaceId]).pipe(Effect.asVoid);
  }

  private opened(operation: string, args: string[]): HerdrEffect<WorktreeWorkspace> {
    return this.cli(args).pipe(
      Effect.flatMap((res) => decodeOrNamed(operation, WorktreeOpenReply, res)),
      // No root tab: the workspace `open` gives back is one that already existed, and
      // nothing in it is this caller's to take over.
      Effect.map(({ result }) => ({ ...worktreeWorkspace(result), rootTab: null })),
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

  /** Filters the Agents sidebar to this run's panes. CLI has no equivalent in 0.8.2. */
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

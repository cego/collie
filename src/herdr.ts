// The only channel to herdr: the CLI at HERDR_BIN_PATH, plus the socket at
// HERDR_SOCKET_PATH for the few methods 0.8.2 does not expose on the CLI — and herdr's
// own `config.toml`, for the few things it settles but answers no question about. Every
// fact about herdr is behind this one interface, which is what makes the fake herdr in
// `test/support/` enough to test everything above it.

import type { BunServices } from "@effect/platform-bun/BunServices";
import { Data, Effect, FileSystem, Option, Path, Result, Schema, Stream } from "effect";
import * as BunSocket from "@effect/platform-bun/BunSocket";
import * as Socket from "effect/unstable/socket/Socket";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import type { PlatformError } from "effect/PlatformError";
import type { PluginEnv } from "./env";
import { isString } from "./schema";
import { PLUGIN_ID } from "./env";
import { reason } from "./naming";
import { verifyIncarnation, type AgentEntry } from "./registry";

export type AgentStatus = "idle" | "working" | "blocked" | "done" | "unknown";

export class HerdrError extends Data.TaggedError("HerdrError")<{
  readonly message: string;
  readonly detail: string;
  /** herdr's own code, where it answered with one — `agent_not_found` and friends. */
  readonly code?: string;
  /**
   * True where herdr demonstrably answered: an error envelope, or a CLI that ran and
   * exited non-zero. Absent where nobody can say whether the request arrived — a
   * subprocess that would not start, a socket that closed mid-exchange. The difference
   * decides whether a delivery is `failed` (herdr decided) or `unknown` (nobody knows),
   * and only one of those is safe to send again.
   */
  readonly answered?: true;
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
  /**
   * Metadata a plugin has attached to this workspace. Collie's Home is owned by a token
   * here, never by a label: a label is what a human sees, and two of them can say the
   * same thing.
   */
  tokens: Schema.optionalKey(Schema.NullOr(Schema.Record(Schema.String, Schema.String))),
});
const WorkspaceCreateReply = Schema.Struct({
  result: Schema.Struct({
    workspace: Schema.Struct({ workspace_id: Schema.String }),
    // The shell tab a new workspace comes with; its first agent takes it over.
    tab: Schema.optionalKey(Schema.Struct({ tab_id: Schema.String })),
    root_pane: Schema.optionalKey(Schema.Struct({ pane_id: Schema.String })),
  }),
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
        agent_status: Schema.optionalKey(Schema.NullOr(Schema.String)),
        workspace_id: Schema.optionalKey(Schema.NullOr(Schema.String)),
        cwd: Schema.optionalKey(Schema.NullOr(Schema.String)),
        // Where the process in the pane is now, which is not where it started once
        // anything has `cd`-ed.
        foreground_cwd: Schema.optionalKey(Schema.NullOr(Schema.String)),
        /** Metadata a plugin attached to this pane, and herdr's identity for its terminal. */
        tokens: Schema.optionalKey(Schema.NullOr(Schema.Record(Schema.String, Schema.String))),
        terminal_id: Schema.optionalKey(Schema.NullOr(Schema.String)),
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
  /**
   * herdr's own identity for the process in the pane, and for the harness session it is
   * driving. This is what makes "this live agent" a thing Collie can name: an agent name
   * is reused by the next incarnation in the same role, and a pane outlives what ran in
   * it. Optional because a release older than the pin omits them, and an agent with no
   * `terminal_id` is refused as a delivery target rather than guessed at.
   */
  terminal_id: Schema.optionalKey(Schema.NullOr(Schema.String)),
  agent_session: Schema.optionalKey(
    Schema.NullOr(
      Schema.Struct({
        source: Schema.String,
        agent: Schema.String,
        kind: Schema.String,
        value: Schema.String,
      }),
    ),
  ),
});
const AgentListReply = Schema.Struct({
  result: Schema.Struct({ agents: Schema.Array(AgentReply) }),
});
const AgentStatusReply = Schema.Struct({
  result: Schema.Struct({ agent: Schema.Struct({ agent_status: Schema.String }) }),
});
const AgentIdentityReply = Schema.Struct({
  result: Schema.Struct({ agent: AgentReply }),
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

/**
 * `herdr status server --json`, as far as this plugin needs it: whether a server is
 * running, and the socket it is listening on. The one thing this module asks the CLI
 * rather than the socket, since it is what tells this module which socket to open.
 */
const HerdrStatusReply = Schema.Struct({
  running: Schema.Boolean,
  socket: Schema.optionalKey(Schema.NullOr(Schema.String)),
  /** Optional because an older herdr answers without them; the Home records what it can. */
  version: Schema.optionalKey(Schema.NullOr(Schema.String)),
  protocol: Schema.optionalKey(Schema.NullOr(Schema.Int)),
});

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
  "workspace.focus",
  "tab.move",
  "agent.view.set",
  "agent.view.clear",
  "agent.send_keys",
  "workspace.report_metadata",
  "pane.report_metadata",
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
  WorkspaceCreateReply,
  WorkspaceListReply,
  TabListReply,
  PaneListReply,
  PaneSplitReply,
  AgentListReply,
  AgentStatusReply,
  AgentIdentityReply,
  WorktreeListReply,
  WorktreeOpenReply,
  PluginPaneReply,
} as const;

const encodeJsonValue = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

/**
 * What each binary has said it can do, by its path. A capability declaration cannot change
 * while that binary is the one on disk, and asking again is a quarter of a megabyte down a
 * pipe — on a Run start that already pays for the ownership calls. A herdr *replaced* under
 * a running process keeps the answer this process was started against, which is the same
 * thing every other decision here does about the binary it was launched with.
 */
const schemas = new Map<string, string>();

const herdrError = (message: string, detail: string, code?: string) =>
  // A code means herdr answered with an error envelope; without one it is this side
  // saying something went wrong, and that says nothing about whether herdr saw it.
  code === undefined
    ? new HerdrError({ message, detail })
    : new HerdrError({ message, detail, code, answered: true });

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

/** The ceiling on a submission, so a harness slow to report never fails a step. */
const SUBMIT_TIMEOUT_MS = 15_000;

/**
 * What herdr could tell us about a submission: a turn it saw start after this prompt, or
 * no evidence — the text and the Enter were written, and it cannot say they were read.
 */
export type Submission = "observed" | "unobserved";

/** Between turns, as herdr itself says so: anything else may be hiding a turn. */
const isSettled = (status: AgentStatus) => status === "idle" || status === "done";

/** The code herdr named, where a failed call printed an error envelope as its output. */
function envelopeCode(text: string): string | undefined {
  return Schema.decodeUnknownOption(JsonString)(text).pipe(
    Option.flatMap((json) => Schema.decodeUnknownOption(ErrorEnvelope)(json)),
    Option.map((envelope) => envelope.error.code),
    Option.getOrUndefined,
  );
}

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
        ? Effect.fail(
            herdrError(
              `${method} failed`,
              message.error.message ?? message.error.code ?? "unknown",
              message.error.code ?? "unknown",
            ),
          )
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
  /** What a plugin has attached to it. Collie's Home ownership rests on one of these. */
  tokens: Readonly<Record<string, string>>;
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
  /** herdr's read of what the agent is doing: `working`, `idle`, or `unknown`. */
  agentStatus?: string | null;
  workspaceId: string | null;
  /** Where the pane's process was started, which is the directory it stands for. */
  cwd: string | null;
  /** Where it is working now, where herdr can see that — an agent that `cd`-ed. */
  foregroundCwd: string | null;
  tokens: Readonly<Record<string, string>>;
  /** herdr's identity for the terminal in this pane, where it names one. */
  terminalId: string | null;
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
  /** herdr's identity for this live process, or `null` from a release that omits it. */
  terminalId: string | null;
  /** The harness session it is driving, where herdr knows one. */
  agentSession: { kind: string; value: string } | null;
}

/**
 * The glyph herdr puts in front of a name, and the space after it: a spinner frame on a
 * live pane's title — `◐ `, `⠹ ` — and a status glyph on a workspace's label, `⚙ `.
 * Only that is removed, and the space is what identifies it: dropping every leading
 * non-alphanumeric instead took the name's own punctuation with it, so
 * `◐ [Fix] the parser` arrived as `Fix] the parser` and a workspace called `.dotfiles`
 * as `dotfiles`. Exported because the Control Plane's group rows strip the same thing,
 * and two spellings of it drift.
 */
export const LEADING_GLYPH = /^[^\p{L}\p{N}\s]+\s+/u;

function agentTitle(raw: string | null | undefined): string | null {
  const title = (raw ?? "").replace(LEADING_GLYPH, "").trim();
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
                terminalId: agent.terminal_id ?? null,
                agentSession: agent.agent_session
                  ? { kind: agent.agent_session.kind, value: agent.agent_session.value }
                  : null,
              },
            ]
          : [],
      ),
    ),
  );

/** `herdr workspace list` as this plugin reads it; a worktree-backed workspace's checkout is its directory. */
const decodeWorkspaceCreate = (res: BoundaryValue) =>
  decodeBoundary("herdr workspace create", WorkspaceCreateReply, res).pipe(
    Effect.map(({ result }) => ({
      workspaceId: result.workspace.workspace_id,
      rootTab:
        result.tab && result.root_pane
          ? { tabId: result.tab.tab_id, paneId: result.root_pane.pane_id }
          : null,
    })),
  );

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
          tokens: workspace.tokens ?? {},
        };
      }),
    ),
  );

/**
 * What became of the agents a Run's record still calls running. The record alone is
 * stale-capable metadata — a variant stays `running` in it whether its agent finished,
 * died or is still writing — so it is turned into an answer by asking herdr, which is
 * the authority on what it still has. `unasked` is the honest value everywhere the
 * question could not change what is safe, and nothing was probed.
 */
export type AgentsAlive = "unasked" | "absent" | "live" | "unverified";

/**
 * The one question anything classifying a Run asks about agents. Named on its own so a
 * caller that redraws can hand over something that remembers the last answer instead of
 * a live `Herdr`, and so that what is asked is visible in the signature.
 */
export interface AsksAgents {
  agentsAlive(names: ReadonlyArray<string>): Effect.Effect<AgentsAlive, never, BunServices>;
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
        const detail = stderr.trim() || stdout.trim();
        return yield* new HerdrError({
          message: `herdr ${args.slice(0, 2).join(" ")} failed (exit ${code})`,
          detail,
          // Named even on a non-zero exit, where herdr still prints its envelope.
          code: envelopeCode(detail),
          answered: true,
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
    const explicit = this.env.socketPath;
    if (explicit) return this.exchange(method, params, explicit);
    // Some CLI launches never get HERDR_SOCKET_PATH injected, unlike a plugin action or
    // pane. herdr's own CLI can still say where its running server is listening, so ask
    // that rather than guess a path.
    return this.cli(["status", "server", "--json"]).pipe(
      Effect.flatMap((res) => decodeBoundary(`${method} failed`, HerdrStatusReply, res)),
      Effect.flatMap((status) =>
        status.running && status.socket
          ? Effect.succeed(status.socket)
          : herdrFail(`cannot call ${method}`, "herdr status reports no running server"),
      ),
      Effect.flatMap((path) => this.exchange(method, params, path)),
    );
  }

  private exchange(
    method: SocketMethod,
    params: HerdrParams,
    path: string,
  ): HerdrEffect<Schema.Json | undefined> {
    const id = `hw-${++this.seq}`;
    const payload = `${encodeJson({ id, method, params })}\n`;

    return Effect.gen(function* () {
      const socket = yield* BunSocket.makeNet({ path });
      // Reading before writing, so no part of the reply can land before we are pulling.
      const pull = yield* Socket.readerString(socket);
      const writer = yield* socket.writer;
      yield* writer.write(payload);

      let buffered = "";
      // A herdr that closes without answering fails the pull rather than hanging here.
      while (true) {
        buffered += (yield* pull).join("");
        const newline = buffered.indexOf("\n");
        if (newline >= 0) return yield* decodeReply(method, buffered.slice(0, newline));
      }
    }).pipe(
      Effect.scoped,
      Effect.catchTag("SocketError", (cause) => herdrFail(`${method} failed`, String(cause))),
    );
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

  /**
   * Where a workspace group row goes: whatever tab that workspace was last on. One
   * call, and it is the only thing the board asks herdr to focus that is not an agent
   * or a tab of its own.
   */
  workspaceFocus(workspaceId: string): HerdrEffect<void> {
    return this.rpc("workspace.focus", { workspace_id: workspaceId }).pipe(Effect.asVoid);
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
          agentStatus: pane.agent_status ?? null,
          workspaceId: pane.workspace_id ?? null,
          cwd: pane.cwd ?? null,
          foregroundCwd: pane.foreground_cwd ?? null,
          tokens: pane.tokens ?? {},
          terminalId: pane.terminal_id ?? null,
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
  /** Moves a pane's split by a fraction of the tab, the way a dragged divider would. */
  paneResize(
    paneId: string,
    direction: "left" | "right" | "up" | "down",
    amount: number,
  ): HerdrEffect<void> {
    return this.cli([
      "pane",
      "resize",
      "--pane",
      paneId,
      "--direction",
      direction,
      "--amount",
      String(amount),
    ]).pipe(Effect.asVoid);
  }

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

  /**
   * Waits for the agent to take the prompt, not for its turn to finish, so several
   * agents can work at once. Fails only where the prompt is known not to be in front
   * of the agent; see [Internals](../docs/internals.md#checking-the-boundary-against-herdr)
   * for why a written submission is not a delivered one.
   */
  agentPrompt(target: string, text: string): HerdrEffect<Submission> {
    const statusNow = () =>
      this.agentStatus(target).pipe(Effect.catch(() => Effect.succeed("unknown" as const)));
    const submit = this.cli([
      "agent",
      "prompt",
      target,
      text,
      "--wait",
      "--until",
      "working",
      "--until",
      "blocked",
      "--timeout",
      String(SUBMIT_TIMEOUT_MS),
    ]).pipe(Effect.asVoid);
    const press = this.cli(["agent", "send-keys", target, "enter"]).pipe(Effect.asVoid);
    const startedATurn = this.agentWait(target, {
      until: ["working", "blocked"],
      timeoutMs: SUBMIT_TIMEOUT_MS,
    });
    return Effect.gen(function* () {
      // `--wait` matches a turn that was already running, so only a settled start
      // makes a match evidence of this prompt.
      const settled = isSettled(yield* statusNow());
      const outcome = yield* submit.pipe(Effect.result);
      if (Result.isSuccess(outcome)) return settled ? "observed" : "unobserved";
      const { code } = outcome.failure;
      if (code === "timeout") return "unobserved";
      if (code !== "agent_prompt_stalled") return yield* Effect.fail(outcome.failure);
      // One Enter sends what is in the editor. Never the text again — the work would
      // run twice — and never at an agent whose dialog would take it.
      if (!isSettled(yield* statusNow())) return "unobserved";
      yield* press;
      // Nothing seen is not proof it was lost: a turn can start and finish inside the
      // wait, so this is unobserved like any other and the Output is still collected.
      return yield* startedATurn.pipe(
        Effect.as<Submission>("observed"),
        Effect.catch(() => Effect.succeed<Submission>("unobserved")),
      );
    });
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

  /** Restore only a lost alias, never a human rename or another session in this pane. */
  restoreAgentName(entry: AgentEntry): HerdrEffect<boolean> {
    if (!entry.incarnation?.agentSession) return Effect.succeed(false);
    const inspect = this.cli(["agent", "get", entry.paneId]).pipe(
      Effect.flatMap((res) => decodeOrNamed("herdr agent get", AgentIdentityReply, res)),
    );
    const rename = this.cli(["agent", "rename", entry.paneId, entry.agent]);
    return Effect.gen(function* () {
      const {
        result: { agent },
      } = yield* inspect;
      if (agent.name) return false;
      const candidate: AgentInfo = {
        name: entry.agent,
        paneId: agent.pane_id,
        workspaceId: agent.workspace_id ?? null,
        status: agentStatus(agent.agent_status),
        title: null,
        terminalId: agent.terminal_id ?? null,
        agentSession: agent.agent_session
          ? { kind: agent.agent_session.kind, value: agent.agent_session.value }
          : null,
      };
      if (!verifyIncarnation(entry, [candidate]).ok) return false;
      const renamed = yield* rename;
      const failure = envelopeError("herdr agent rename", renamed);
      if (failure) return yield* Effect.fail(failure);
      return true;
    });
  }

  agentFocus(target: string): HerdrEffect<void> {
    return this.cli(["agent", "focus", target]).pipe(Effect.asVoid);
  }

  /**
   * What has become of the agents a Run still has running. One `live` is enough to make
   * a resume unsafe — it would reset the Step under an agent still writing in that
   * worktree — and so is one answer herdr could not give: "I could not ask" is not
   * evidence that nothing is there. Only when every one of them is conclusively gone is
   * the answer `absent`.
   *
   * Draws the same distinction `agentStatus` above does, between an agent herdr no
   * longer has and an agent it could not be asked about. An agent herdr still has but
   * calls `idle` or `done` counts as gone here, as it does everywhere else: it is
   * holding a pane, not the work.
   */
  agentsAlive(names: ReadonlyArray<string>): Effect.Effect<AgentsAlive, never, BunServices> {
    // An arrow rather than the generator's `this`: the loop below only needs the one
    // question asked, and closing over it keeps the class's scope out of it.
    const ask = (name: string) => this.agentStatus(name);
    return Effect.gen(function* () {
      if (names.length === 0) return "absent" as const;
      let verdict: AgentsAlive = "absent";
      for (const name of names) {
        const status = yield* ask(name).pipe(
          Effect.catch((cause) =>
            Effect.succeed(cause.code === "agent_not_found" ? ("gone" as const) : null),
          ),
        );
        // Idle is alive: the agent holds its name and its pane, so a Driver that started
        // another under that name — or restarted its step beneath it — would collide.
        if (status === "working" || status === "blocked" || status === "idle")
          return "live" as const;
        if (status === "gone" || status === "done") continue;
        verdict = "unverified";
      }
      return verdict;
    });
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

  /**
   * Raw keys into an agent's terminal. The only use is an interrupt — the key a harness
   * takes as "stop what you are doing" — and herdr answering says the keys were sent,
   * which is not the same as the harness having acted on them. Nothing here ever reports
   * an agent as stopped: no proof of quiescence exists at this boundary.
   */
  agentSendKeys(target: string, keys: ReadonlyArray<string>): HerdrEffect<void> {
    return this.rpc("agent.send_keys", { target, keys: [...keys] }).pipe(Effect.asVoid);
  }

  /**
   * A workspace of Collie's own, for the Herd's Home. `focus: false`: creating it is not
   * the same as going to it, and the shortcut is what does the going.
   */
  workspaceCreate(opts: {
    cwd: string;
    label: string;
  }): HerdrEffect<{ workspaceId: string; rootTab: StartedTab | null }> {
    return this.cli(["workspace", "create", "--cwd", opts.cwd, "--label", opts.label]).pipe(
      Effect.flatMap((value) => decodeWorkspaceCreate(value)),
    );
  }

  /**
   * Attach metadata to a workspace, with a lifetime. The Home is owned by one of these
   * rather than by a label, and the TTL is what makes a stale claim expire on its own
   * instead of needing something to come along and clean it up.
   */
  workspaceReportMetadata(
    workspaceId: string,
    tokens: Readonly<Record<string, string>>,
    ttlMs: number,
  ): HerdrEffect<void> {
    return this.rpc("workspace.report_metadata", {
      workspace_id: workspaceId,
      source: PLUGIN_ID,
      tokens: { ...tokens },
      ttl_ms: ttlMs,
    }).pipe(Effect.asVoid);
  }

  paneReportMetadata(
    paneId: string,
    tokens: Readonly<Record<string, string>>,
    ttlMs: number,
  ): HerdrEffect<void> {
    return this.rpc("pane.report_metadata", {
      pane_id: paneId,
      source: PLUGIN_ID,
      tokens: { ...tokens },
      ttl_ms: ttlMs,
    }).pipe(Effect.asVoid);
  }

  /**
   * The installed binary's own description of what it can do. The pinned schema says
   * what Collie was built against; this says what is actually there, which is the only
   * one that can refuse a feature at runtime.
   */
  /**
   * Which herdr this is, as its own CLI reports it. Recorded in the Herd's `server.json`
   * at every ensure, so a version or protocol change is something the log can name
   * rather than something a human works out from a call that started failing.
   */
  serverInfo(): HerdrEffect<{ socket: string; version: string; protocol: number }> {
    return this.cli(["status", "server", "--json"]).pipe(
      Effect.flatMap((res) => decodeBoundary("status server failed", HerdrStatusReply, res)),
      Effect.map((status) => ({
        socket: status.socket ?? this.env.socketPath ?? "",
        version: status.version ?? "unknown",
        protocol: status.protocol ?? 0,
      })),
    );
  }

  apiSchema(): HerdrEffect<string> {
    const cached = schemas.get(this.env.binPath);
    if (cached !== undefined) return Effect.succeed(cached);
    return this.cli(["api", "schema", "--json"]).pipe(
      Effect.map((value) => (isString(value) ? value : encodeJsonValue(value))),
      Effect.tap((schema) => Effect.sync(() => schemas.set(this.env.binPath, schema))),
    );
  }

  popupClose(): HerdrEffect<void> {
    return this.rpc("popup.close", {}).pipe(Effect.asVoid);
  }
}

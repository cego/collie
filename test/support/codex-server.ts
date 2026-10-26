// A stand-in `codex app-server`, run as a real process in its place: `bun codex-server.ts
// <config.json> --listen ws://127.0.0.1:0`. It answers the protocol shapes the installed
// release's schema declares (checked in `test/compaction-codex.test.ts`), drains on its
// first SIGTERM the way 0.162.0 does on a websocket, and records its own argv, every request
// and every signal it receives as a JSON line in `config.events`.

import { appendFileSync, existsSync, readFileSync } from "node:fs";

export interface StandIn {
  /** Where every request and signal is recorded, one JSON object per line. */
  events: string;
  threads: ReadonlyArray<{
    id: string;
    cwd: string;
    parent?: string;
    path?: string;
    /** A turn in progress from the start, appending to `writes` until it ends. */
    turn?: { id: string; writes?: string };
    /** Loaded with no user message yet, which `thread/turns/list` refuses as 0.162.1 does. */
    unmaterialized?: boolean;
    /** Loaded idle and paginated with no user message, whose turns 0.162.1 refused to list on vm-mk. */
    unlistable?: boolean;
    /** What `thread/read` reports in place of the mode's own. */
    historyMode?: "legacy" | "paginated";
    preview?: string;
    readTurns?: ReadonlyArray<unknown>;
    /** The status `thread/read` reports in place of the one its turns give it. */
    status?: "idle" | "active";
    /** A refusal `thread/turns/list` answers with in place of its turns. */
    turnsRefusal?: { code: number; message: string };
  }>;
  /** Answer `turn/interrupt` and keep the turn running. */
  ignoreInterrupt?: boolean;
  /** Stay up after a drain with nothing running. */
  neverExit?: boolean;
  /** Close the connection instead of answering this method. */
  dropOn?: string;
  /** Start a queued turn on a thread whose turn was interrupted, unless draining. */
  continuation?: boolean;
  /** Take a SIGTERM only once this many `turn/interrupt`s are answered, as a server that read them first does. */
  lateDrain?: number;
  /** A process of this server's session: one that ends on SIGTERM, or one that ignores it. */
  child?: "ends" | "ignores";
  /** Environment variables whose values it records when it starts. */
  env?: ReadonlyArray<string>;
}

const config: StandIn = JSON.parse(readFileSync(process.argv[2]!, "utf8"));
const record = (event: Record<string, unknown>) =>
  appendFileSync(config.events, `${JSON.stringify({ at: Date.now(), ...event })}\n`);

interface Turn {
  id: string;
  status: string;
  timer?: ReturnType<typeof setInterval>;
}
record({
  pid: process.pid,
  argv: process.argv.slice(2),
  env: Object.fromEntries((config.env ?? []).map((name) => [name, process.env[name] ?? null])),
});
const turns = new Map<string, Turn[]>();
const running = () => [...turns.values()].flat().filter((turn) => turn.status === "inProgress");
let draining = false;
let drainPending = false;
let interrupted = 0;

const begin = (threadId: string, id: string, writes?: string) => {
  const turn: Turn = { id, status: "inProgress" };
  if (writes !== undefined)
    turn.timer = setInterval(() => appendFileSync(writes, `${id} ${Date.now()}\n`), 20);
  turns.set(threadId, [...(turns.get(threadId) ?? []), turn]);
  record({ turn: id, thread: threadId, started: true });
};
for (const thread of config.threads) {
  turns.set(thread.id, []);
  if (thread.turn) begin(thread.id, thread.turn.id, thread.turn.writes);
}

const exitWhenIdle = () => {
  if (draining && running().length === 0 && !config.neverExit)
    setTimeout(() => process.exit(0), 50);
};

// A test lets every running turn end by creating `<events>.release`.
setInterval(() => {
  if (!existsSync(`${config.events}.release`)) return;
  for (const turn of running()) {
    clearInterval(turn.timer);
    turn.status = "completed";
  }
  exitWhenIdle();
}, 50);

const drain = () => {
  draining = true;
  exitWhenIdle();
};
process.on("SIGTERM", () => {
  record({ signal: "SIGTERM" });
  if (interrupted < (config.lateDrain ?? 0)) drainPending = true;
  else drain();
});

if (config.child !== undefined) {
  const trap =
    config.child === "ignores" ? `trap "echo TERM >> '${config.events}.child'" TERM; ` : "";
  const child = Bun.spawn(["sh", "-c", `${trap}while :; do sleep 0.05; done`], {
    stdio: ["ignore", "ignore", "ignore"],
  });
  record({ child: child.pid });
}

const server = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  fetch: (request, self) =>
    self.upgrade(request) ? undefined : new Response("no", { status: 400 }),
  websocket: {
    message: (ws, raw) => void answer(ws, raw),
  },
});

function statusOf(thread: StandIn["threads"][number]) {
  const active = running().some((turn) => turns.get(thread.id)?.includes(turn));
  return (thread.status ?? (active ? "active" : "idle")) === "idle"
    ? { type: "idle" }
    : { type: "active", activeFlags: [] };
}

function answer(ws: import("bun").ServerWebSocket<undefined>, raw: string | Buffer) {
  const { id, method, params = {} } = JSON.parse(String(raw));
  record({ method, params });
  if (method === config.dropOn) return ws.close();
  const reply = (result: unknown) => ws.send(JSON.stringify({ id, result }));
  const refuse = (message: string, code = -32600) =>
    ws.send(JSON.stringify({ id, error: { code, message } }));
  const thread = config.threads.find((one) => one.id === params.threadId);
  switch (method) {
    case "initialize":
      return reply({ userAgent: "stand-in" });
    case "thread/loaded/list":
      return reply({
        data: config.threads.map((one) => one.id),
        nextCursor: null,
      });
    case "thread/read":
      return thread
        ? reply({
            thread: {
              id: thread.id,
              cwd: thread.cwd,
              ephemeral: false,
              parentThreadId: thread.parent ?? null,
              path: thread.path ?? null,
              status: statusOf(thread),
              historyMode: thread.historyMode ?? (thread.unlistable ? "paginated" : "legacy"),
              preview: thread.preview ?? "",
              turns: thread.readTurns ?? [],
            },
          })
        : refuse("no such thread");
    case "thread/turns/list": {
      const refusal =
        thread?.turnsRefusal ??
        (thread?.unmaterialized
          ? {
              code: -32600,
              message: `thread ${thread.id} is not materialized yet; thread/turns/list is unavailable before first user message`,
            }
          : thread?.unlistable
            ? { code: -32601, message: "list_turns is not supported yet" }
            : undefined);
      if (refusal) return refuse(refusal.message, refusal.code);
      return reply({
        data: [...(turns.get(params.threadId) ?? [])]
          .reverse()
          .map((turn) => ({ id: turn.id, status: turn.status })),
        nextCursor: null,
      });
    }
    case "turn/interrupt": {
      const turn = running().find(
        (one) => (turns.get(params.threadId) ?? []).includes(one) && one.id === params.turnId,
      );
      if (!turn) return refuse("no active turn to interrupt");
      reply({});
      if (config.ignoreInterrupt) return;
      clearInterval(turn.timer);
      turn.status = "interrupted";
      if (config.continuation && !draining)
        begin(params.threadId, `${turn.id}-continued`, thread?.turn?.writes);
      interrupted += 1;
      if (drainPending && interrupted >= config.lateDrain!) {
        drainPending = false;
        return drain();
      }
      return exitWhenIdle();
    }
    case "turn/start":
    case "thread/start":
      return draining ? refuse("serverShuttingDown") : reply({});
    default:
      return reply({});
  }
}
console.log(`codex app-server listening on ws://127.0.0.1:${server.port}`);

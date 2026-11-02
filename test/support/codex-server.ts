// A stand-in `codex app-server`, run as a real process in its place: `bun codex-server.ts
// <config.json> --listen ws://127.0.0.1:0`. It answers the protocol shapes the installed
// release's schema declares (checked in `test/compaction-codex.test.ts`), drains on its
// first SIGTERM the way 0.162.0 does on a websocket, and records its own argv, every request
// and every signal it receives as a JSON line in `config.events`.

import * as BunChildProcessSpawner from "@effect/platform-bun/BunChildProcessSpawner";
import * as BunFileSystem from "@effect/platform-bun/BunFileSystem";
import * as BunPath from "@effect/platform-bun/BunPath";
import * as Arr from "effect/Array";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Config from "effect/Config";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import { flow } from "effect/Function";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Rec from "effect/Record";
import * as Result from "effect/Result";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

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
    /** What `thread/items/list` answers with, newest first. */
    items?: ReadonlyArray<unknown>;
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

const Thread = Schema.Struct({
  id: Schema.String,
  cwd: Schema.String,
  parent: Schema.optionalKey(Schema.String),
  path: Schema.optionalKey(Schema.String),
  turn: Schema.optionalKey(
    Schema.Struct({ id: Schema.String, writes: Schema.optionalKey(Schema.String) }),
  ),
  unmaterialized: Schema.optionalKey(Schema.Boolean),
  unlistable: Schema.optionalKey(Schema.Boolean),
  historyMode: Schema.optionalKey(Schema.Literals(["legacy", "paginated"])),
  preview: Schema.optionalKey(Schema.String),
  readTurns: Schema.optionalKey(Schema.Array(Schema.Json)),
  status: Schema.optionalKey(Schema.Literals(["idle", "active"])),
  turnsRefusal: Schema.optionalKey(Schema.Struct({ code: Schema.Finite, message: Schema.String })),
  items: Schema.optionalKey(Schema.Array(Schema.Json)),
});
const StandInFile = Schema.fromJsonString(
  Schema.Struct({
    events: Schema.String,
    threads: Schema.Array(Thread),
    ignoreInterrupt: Schema.optionalKey(Schema.Boolean),
    neverExit: Schema.optionalKey(Schema.Boolean),
    dropOn: Schema.optionalKey(Schema.String),
    continuation: Schema.optionalKey(Schema.Boolean),
    lateDrain: Schema.optionalKey(Schema.Finite),
    child: Schema.optionalKey(Schema.Literals(["ends", "ignores"])),
    env: Schema.optionalKey(Schema.Array(Schema.String)),
  }),
);
const Request = Schema.fromJsonString(
  Schema.Struct({
    id: Schema.optionalKey(Schema.Json),
    method: Schema.String,
    params: Schema.optionalKey(Schema.Record(Schema.String, Schema.Json)),
  }),
);
const encode = flow(Schema.encodeResult(Schema.fromJsonString(Schema.Json)), Result.getOrThrow);

interface Turn {
  id: string;
  status: string;
  timer?: Fiber.Fiber<void>;
}

const main = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const scope = yield* Effect.scope;
  const services = yield* Effect.context<never>();
  const run = Effect.runForkWith(services);
  const serial = yield* Semaphore.make(1);
  const config = yield* fs
    .readFileString(process.argv[2]!)
    .pipe(Effect.flatMap(Schema.decodeEffect(StandInFile)));
  const record = (event: Readonly<Record<string, Schema.Json>>) =>
    Clock.currentTimeMillis.pipe(
      Effect.flatMap((at) =>
        fs.writeFileString(config.events, `${encode({ at, ...event })}\n`, { flag: "a" }),
      ),
      Effect.orDie,
    );
  const dispatch = <A, E>(effect: Effect.Effect<A, E>) =>
    void run(
      Effect.forkIn(
        serial
          .withPermits(1)(effect)
          .pipe(
            Effect.catchCause((cause) =>
              Effect.sync(() => {
                process.stderr.write(`${Cause.pretty(cause)}\n`);
                process.exit(1);
              }),
            ),
          ),
        scope,
      ),
    );
  const env = yield* Effect.forEach(config.env ?? [], (name) =>
    Config.option(Config.String(name)).pipe(
      Effect.map((value) => [name, Option.getOrNull(value)] as const),
    ),
  );
  yield* record({ pid: process.pid, argv: Arr.drop(process.argv, 2), env: Rec.fromEntries(env) });
  const turns = new Map<string, Turn[]>();
  const running = () =>
    Arr.filter(Arr.flatten([...turns.values()]), (turn) => turn.status === "inProgress");
  let draining = false;
  let drainPending = false;
  let interrupted = 0;
  const begin = (threadId: string, id: string, writes?: string) =>
    Effect.gen(function* () {
      const turn: Turn = { id, status: "inProgress" };
      if (writes !== undefined) {
        const tick = Clock.currentTimeMillis.pipe(
          Effect.flatMap((at) => fs.writeFileString(writes, `${id} ${at}\n`, { flag: "a" })),
          Effect.orDie,
          Effect.uninterruptible,
        );
        turn.timer = yield* tick.pipe(
          Effect.repeat(Schedule.spaced(20)),
          Effect.delay(20),
          Effect.asVoid,
          Effect.forkIn(scope),
        );
      }
      turns.set(threadId, [...(turns.get(threadId) ?? []), turn]);
      yield* record({ turn: id, thread: threadId, started: true });
    });
  for (const thread of config.threads) {
    turns.set(thread.id, []);
    if (thread.turn) yield* begin(thread.id, thread.turn.id, thread.turn.writes);
  }
  const exitWhenIdle = Effect.suspend(() =>
    draining && running().length === 0 && !config.neverExit
      ? Effect.sleep(50).pipe(
          Effect.andThen(Effect.sync(() => process.exit(0))),
          Effect.forkIn(scope),
          Effect.asVoid,
        )
      : Effect.void,
  );
  const drain = Effect.sync(() => {
    draining = true;
  }).pipe(Effect.andThen(exitWhenIdle));
  const release = Effect.gen(function* () {
    if (!(yield* fs.exists(`${config.events}.release`))) return;
    for (const turn of running()) {
      if (turn.timer) yield* Fiber.interrupt(turn.timer);
      turn.status = "completed";
    }
    yield* exitWhenIdle;
  });
  // A test lets every running turn end by creating `<events>.release`.
  yield* serial
    .withPermits(1)(release)
    .pipe(Effect.repeat(Schedule.spaced(50)), Effect.delay(50), Effect.forkIn(scope));
  process.on("SIGTERM", () =>
    dispatch(
      Effect.gen(function* () {
        yield* record({ signal: "SIGTERM" });
        if (interrupted < (config.lateDrain ?? 0)) drainPending = true;
        else yield* drain;
      }),
    ),
  );
  if (config.child !== undefined) {
    const trap =
      config.child === "ignores" ? `trap "echo TERM >> '${config.events}.child'" TERM; ` : "";
    const child = yield* spawner.spawn(
      ChildProcess.make("sh", ["-c", `${trap}while :; do sleep 0.05; done`], {
        detached: false,
        stdin: "ignore",
        stdout: "ignore",
        stderr: "ignore",
      }),
    );
    yield* record({ child: child.pid });
  }
  const statusOf = (thread: StandIn["threads"][number]): Schema.Json => {
    const active = Arr.some(running(), (turn) => Arr.contains(turns.get(thread.id) ?? [], turn));
    return (thread.status ?? (active ? "active" : "idle")) === "idle"
      ? { type: "idle" }
      : { type: "active", activeFlags: [] };
  };
  const answer = (ws: import("bun").ServerWebSocket<undefined>, raw: string | Buffer) =>
    Effect.gen(function* () {
      const { id, method, params = {} } = yield* Schema.decodeEffect(Request)(String(raw));
      yield* record({ method, params });
      if (method === config.dropOn) return ws.close();
      const send = (key: "result" | "error", value: Schema.Json) => {
        const message: Record<string, Schema.Json> = {};
        if (id !== undefined) message.id = id;
        message[key] = value;
        return ws.send(encode(message));
      };
      const reply = (result: Schema.Json) => send("result", result);
      const refuse = (message: string, code = -32600) => send("error", { code, message });
      const threadId = Predicate.isString(params.threadId) ? params.threadId : undefined;
      const turnId = Predicate.isString(params.turnId) ? params.turnId : undefined;
      const thread = Option.getOrUndefined(
        Arr.findFirst(config.threads, (one) => one.id === threadId),
      );
      switch (method) {
        case "initialize":
          return reply({ userAgent: "stand-in" });
        case "thread/loaded/list":
          return reply({ data: Arr.map(config.threads, (one) => one.id), nextCursor: null });
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
          const held = threadId === undefined ? [] : (turns.get(threadId) ?? []);
          return reply({
            data: Arr.map(Arr.reverse(held), (turn) => ({ id: turn.id, status: turn.status })),
            nextCursor: null,
          });
        }
        case "thread/items/list":
          return thread?.items ? reply({ data: thread.items, nextCursor: null }) : reply({});
        case "turn/interrupt": {
          const held = threadId === undefined ? [] : (turns.get(threadId) ?? []);
          const turn = Option.getOrUndefined(
            Arr.findFirst(running(), (one) => Arr.contains(held, one) && one.id === turnId),
          );
          if (threadId === undefined || turn === undefined)
            return refuse("no active turn to interrupt");
          reply({});
          if (config.ignoreInterrupt) return;
          if (turn.timer) yield* Fiber.interrupt(turn.timer);
          turn.status = "interrupted";
          if (config.continuation && !draining)
            yield* begin(threadId, `${turn.id}-continued`, thread?.turn?.writes);
          interrupted += 1;
          if (drainPending && interrupted >= (config.lateDrain ?? 0)) {
            drainPending = false;
            return yield* drain;
          }
          return yield* exitWhenIdle;
        }
        case "turn/start":
        case "thread/start":
          return draining ? refuse("serverShuttingDown") : reply({});
        default:
          return reply({});
      }
    });
  const server = Bun.serve<undefined>({
    port: 0,
    hostname: "127.0.0.1",
    fetch: (request, self) =>
      self.upgrade(request) ? undefined : new Response("no", { status: 400 }),
    websocket: { message: (ws, raw) => dispatch(answer(ws, raw)) },
  });
  yield* Console.log(`codex app-server listening on ws://127.0.0.1:${server.port}`);
  return yield* Effect.never;
});

const platform = BunChildProcessSpawner.layer.pipe(
  Layer.provideMerge(Layer.mergeAll(BunFileSystem.layer, BunPath.layer)),
);
await Effect.runPromise(main.pipe(Effect.scoped, Effect.provide(platform)));

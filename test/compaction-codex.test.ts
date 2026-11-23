import * as Arr from "effect/Array";
import * as Str from "effect/String";
import { pipe as pipe_ } from "effect/Function";
import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from "bun:test";
import { Effect, FileSystem, Path, Result, Schema } from "effect";
import { Rig } from "./support/recorder";
import { runEffect } from "./support/effect";
import { onMachineWith } from "./support/live";
import { fakeChannel } from "./support/compaction";
import { reason } from "../src/naming";
import { atLeast, COMPACTION_PORTS, VERIFIED_VERSIONS } from "../src/compactors";
import { boundThread, withCodex } from "../src/codex";
import { Unsubmitted } from "../src/compaction";
import { stringifyJson } from "../src/json";

let rig: Rig;
let fs: FileSystem.FileSystem;
let path: Path.Path;
let dir: string;

const codex = COMPACTION_PORTS.codex!;

interface Fake {
  threads: string[];
  ephemeral: string[];
  parents: Record<string, string>;
  cwd: string;
  usage: number | null;
  compactions: { id: string; turnId: string }[];
  turns: { id: string; status: string; error?: { message: string } }[];
  onCompact: (fake: Fake) => void;
  calls: string[];
}
let fake: Fake;
interface FakeServer {
  port: number;
  stop: () => void;
}
let server: FakeServer;

const Request = Schema.fromJsonString(
  Schema.Struct({
    id: Schema.Finite,
    method: Schema.String,
    params: Schema.optionalKey(Schema.Unknown),
  }),
);
const decodeRequest = Schema.decodeUnknownOption(Request);

type Answer = Schema.Schema.Type<typeof Schema.Json>;

function serve() {
  const listening = Bun.serve({
    port: 0,
    fetch: (request, self) =>
      self.upgrade(request) ? undefined : new Response("no", { status: 400 }),
    websocket: {
      message(ws, raw) {
        const decoded = decodeRequest(raw);
        if (decoded._tag === "None") return;
        const { id, method, params } = decoded.value;
        fake.calls.push(method);
        const reply = (result: Answer) => {
          ws.send(stringifyJson({ id, result }));
        };
        // WARNING: every method this stand-in answers takes `threadId` and nothing else, and the schema above has already parsed the frame into an object.
        const threadId = (params as { threadId?: string } | undefined)?.threadId ?? "";
        switch (method) {
          case "initialize":
            return reply({ userAgent: "fake" });
          case "thread/loaded/list":
            return reply({ data: fake.threads, nextCursor: null });
          case "thread/read":
            return reply({
              thread: {
                id: threadId,
                cwd: fake.cwd,
                ephemeral: fake.ephemeral.includes(threadId),
                parentThreadId: fake.parents[threadId] ?? null,
              },
            });
          case "thread/resume": {
            reply({ thread: { id: threadId } });
            // WARNING: A rejoin replays the current usage, the only way this adapter reads a Codex agent's context.
            if (fake.usage !== null) {
              ws.send(
                stringifyJson({
                  method: "thread/tokenUsage/updated",
                  params: {
                    threadId,
                    turnId: "t-1",
                    tokenUsage: {
                      // WARNING: Accumulated session usage, which must never be thresholded.
                      total: {
                        totalTokens: 999_999,
                        inputTokens: 0,
                        cachedInputTokens: 0,
                        outputTokens: 0,
                        reasoningOutputTokens: 0,
                      },
                      last: {
                        totalTokens: fake.usage,
                        // WARNING: The overlapping parts of total are not addends.
                        inputTokens: fake.usage - 20,
                        cachedInputTokens: fake.usage - 100,
                        cacheWriteInputTokens: 0,
                        outputTokens: 20,
                        reasoningOutputTokens: 10,
                      },
                    },
                  },
                }),
              );
            }
            return;
          }
          case "thread/items/list":
            return reply({
              data: [
                ...Arr.map(fake.compactions, (c) => ({
                  turnId: c.turnId,
                  item: { id: c.id, type: "contextCompaction" },
                })),
                { turnId: "t-1", item: { id: "m-1", type: "agentMessage" } },
              ],
              nextCursor: null,
            });
          case "thread/turns/list":
            return reply({ data: fake.turns, nextCursor: null });
          case "thread/compact/start":
            fake.onCompact(fake);
            return reply({});
          default:
            return reply({});
        }
      },
    },
  });
  return { port: listening.port ?? 0, stop: () => listening.stop(true) };
}

function why<A, E>(result: Result.Result<A, E>) {
  return Result.isFailure(result) ? reason(result.failure) : "";
}

const ctx = () => ({
  agent: "build-r1",
  run: "run-1",
  harness: "codex",
  cwd: fake.cwd,
  dir,
  endpoint: `ws://127.0.0.1:${server.port}`,
  channel: fakeChannel([]),
});

beforeAll(() => {
  server = serve();
});
afterAll(() => server.stop());

beforeEach(() =>
  runEffect(
    Effect.gen(function* () {
      fs = yield* FileSystem.FileSystem;
      path = yield* Path.Path;
      rig = yield* Rig.make();
      dir = path.join(rig.root, "controls", "build-r1");
      yield* fs.makeDirectory(dir, { recursive: true });
      fake = {
        threads: ["thread-1"],
        ephemeral: [],
        parents: {},
        cwd: rig.projectDir,
        usage: 400_000,
        compactions: [],
        turns: [],
        onCompact: () => {},
        calls: [],
      };
    }),
  ),
);

afterEach(() => runEffect(rig.close()));

test("the one thread on a one-agent endpoint is this agent's, checked against its cwd", () =>
  runEffect(
    Effect.gen(function* () {
      const bound = yield* withCodex(ctx().endpoint!, (client) => boundThread(client, fake.cwd));
      expect(bound).toBe("thread-1");
    }),
  ));

test("no thread yet means nothing to measure, not a context of zero", () =>
  runEffect(
    Effect.gen(function* () {
      fake.threads = [];
      expect(yield* codex.usage(ctx())).toBeNull();
    }),
  ));

test("a reachable App Server is ready before the first prompt creates its thread", () =>
  runEffect(
    Effect.gen(function* () {
      fake.threads = [];
      expect(yield* codex.ready!(ctx())).toBe(true);
      expect(fake.calls).toEqual([]);
    }),
  ));

test("the TUI's own ephemeral thread is not a second agent to choose between", () =>
  runEffect(
    Effect.gen(function* () {
      // WARNING: A Codex TUI loads an ephemeral thread beside the agent's; only one of the two loaded threads is the agent.
      fake.threads = ["thread-1", "thread-helper"];
      fake.ephemeral = ["thread-helper"];

      const bound = yield* withCodex(ctx().endpoint!, (client) => boundThread(client, fake.cwd));
      expect(bound).toBe("thread-1");
      expect(yield* codex.usage(ctx())).toBe(400_000);
    }),
  ));

test("the sub-agents an agent spawned are its own, not rival threads", () =>
  runEffect(
    Effect.gen(function* () {
      fake.threads = ["thread-1", "thread-review", "thread-spec"];
      fake.parents = { "thread-review": "thread-1", "thread-spec": "thread-1" };

      const bound = yield* withCodex(ctx().endpoint!, (client) => boundThread(client, fake.cwd));
      expect(bound).toBe("thread-1");
      expect(yield* codex.ready!(ctx())).toBe(true);
    }),
  ));

test("two real threads on one agent's endpoint is refused, not guessed at", () =>
  runEffect(
    Effect.gen(function* () {
      fake.threads = ["thread-1", "thread-2"];
      const failure = yield* codex.usage(ctx()).pipe(Effect.result);
      expect(failure._tag).toBe("Failure");
      expect(why(failure)).toContain("cannot say which is this one");
    }),
  ));

test("a thread working somewhere else is not this agent's", () =>
  runEffect(
    Effect.gen(function* () {
      fake.cwd = "/somewhere/else";
      const failure = yield* codex.usage({ ...ctx(), cwd: rig.projectDir }).pipe(Effect.result);
      expect(failure._tag).toBe("Failure");
      expect(why(failure)).toContain("/somewhere/else");
    }),
  ));

test("the sample is the latest request's context, once, and never the session total", () =>
  runEffect(
    Effect.gen(function* () {
      expect(yield* codex.usage(ctx())).toBe(400_000);
    }),
  ));

test("usage the server does not replay is unavailable", () =>
  runEffect(
    Effect.gen(function* () {
      fake.usage = null;
      expect(yield* codex.usage(ctx())).toBeNull();
    }),
  ));

test("a submitted request is not a completed one", () =>
  runEffect(
    Effect.gen(function* () {
      yield* codex.request(ctx(), "req-1");
      expect(fake.calls).toContain("thread/compact/start");
      expect(yield* codex.poll(ctx(), "req-1")).toBeNull();
    }),
  ));

test("a compaction that was already there cannot complete this request", () =>
  runEffect(
    Effect.gen(function* () {
      fake.compactions = [{ id: "c-old", turnId: "t-old" }];
      fake.turns = [{ id: "t-old", status: "completed" }];
      yield* codex.request(ctx(), "req-1");

      expect(yield* codex.poll(ctx(), "req-1")).toBeNull();
    }),
  ));

test("a new compaction whose turn completed is the success", () =>
  runEffect(
    Effect.gen(function* () {
      fake.compactions = [{ id: "c-old", turnId: "t-old" }];
      fake.turns = [{ id: "t-old", status: "completed" }];
      fake.onCompact = (f) => {
        f.compactions = [{ id: "c-new", turnId: "t-new" }, ...f.compactions];
        f.turns = [{ id: "t-new", status: "completed" }, ...f.turns];
      };

      yield* codex.request(ctx(), "req-1");
      expect(yield* codex.poll(ctx(), "req-1")).toEqual({ kind: "success" });
    }),
  ));

test("a new compaction still in its turn is unresolved, not a success", () =>
  runEffect(
    Effect.gen(function* () {
      fake.onCompact = (f) => {
        f.compactions = [{ id: "c-new", turnId: "t-new" }];
        f.turns = [{ id: "t-new", status: "inProgress" }];
      };

      yield* codex.request(ctx(), "req-1");
      expect(yield* codex.poll(ctx(), "req-1")).toBeNull();
    }),
  ));

test.each(["failed", "interrupted"])(
  "a compaction turn that %s is the protocol's own confirmed failure",
  (status) =>
    runEffect(
      Effect.gen(function* () {
        fake.onCompact = (f) => {
          f.compactions = [{ id: "c-new", turnId: "t-new" }];
          f.turns = [{ id: "t-new", status, error: { message: "the model refused" } }];
        };

        yield* codex.request(ctx(), "req-1");
        expect(yield* codex.poll(ctx(), "req-1")).toEqual({
          kind: "failure",
          reason: "the model refused",
        });
      }),
    ),
);

test("a request nothing recorded as submitted has no outcome", () =>
  runEffect(
    Effect.gen(function* () {
      fake.compactions = [{ id: "c-new", turnId: "t-new" }];
      fake.turns = [{ id: "t-new", status: "completed" }];

      expect(yield* codex.poll(ctx(), "never-submitted")).toBeNull();
    }),
  ));

test("a thread that cannot be bound is a request that never left", () =>
  runEffect(
    Effect.gen(function* () {
      fake.threads = [];
      const failure = yield* codex.request(ctx(), "req-1").pipe(Effect.result);

      expect(Result.isFailure(failure) && failure.failure instanceof Unsubmitted).toBe(true);
    }),
  ));

test("an endpoint that is not there fails the read rather than reporting a context", () =>
  runEffect(
    Effect.gen(function* () {
      const failure = yield* codex
        .usage({ ...ctx(), endpoint: "ws://127.0.0.1:1" })
        .pipe(Effect.result);
      expect(failure._tag).toBe("Failure");
    }),
  ));

test("an agent with no endpoint recorded is a failure, not a context of zero", () =>
  runEffect(
    Effect.gen(function* () {
      const failure = yield* codex.usage({ ...ctx(), endpoint: null }).pipe(Effect.result);
      expect(failure._tag).toBe("Failure");
      expect(why(failure)).toContain("no Codex App Server endpoint");
    }),
  ));

onMachineWith("codex")(
  "the installed Codex's own protocol schema has every method and field the adapter uses",
  () =>
    runEffect(
      Effect.gen(function* () {
        const out = path.join(rig.root, "codex-schema");
        yield* Effect.promise(() =>
          Bun.$`codex app-server generate-json-schema --out ${out}`.quiet().nothrow(),
        );
        const read = (file: string) => fs.readFileString(path.join(out, file));

        const requests = yield* read("ClientRequest.json");
        const notifications = yield* read("ServerNotification.json");
        const adapter = yield* fs.readFileString(
          new URL("../src/codex.ts", import.meta.url).pathname,
        );
        const names = new Set(
          Array.from(
            pipe_(adapter, Str.matchAll(/"(initialize|(?:thread|turn)\/[\w/]+)"/g)),
            (m) => m[1],
          ),
        );
        expect(names.size).toBeGreaterThan(5);
        for (const name of names) {
          expect(`${requests}${notifications}`, `${name} is gone from the protocol`).toContain(
            `"${name}"`,
          );
        }
        expect(notifications).toContain(`"last"`);
        expect(notifications).toContain(`"totalTokens"`);
        expect(yield* read("v2/ThreadReadResponse.json")).toContain(`"parentThreadId"`);
        const thread = yield* read("v2/ThreadReadResponse.json");
        expect(thread).toContain(`"path"`);
        for (const status of ["active", "idle", "notLoaded", "systemError"])
          expect(thread).toContain(`"${status}"`);
        const interrupt = yield* read("v2/TurnInterruptParams.json");
        for (const field of ["threadId", "turnId"]) expect(interrupt).toContain(`"${field}"`);
        expect(yield* read("v2/ThreadTurnsListResponse.json")).toContain(`"status"`);
        const turnsList = yield* read("v2/ThreadTurnsListParams.json");
        for (const field of ["sortDirection", "limit"]) expect(turnsList).toContain(`"${field}"`);
        expect(notifications).toContain(`"contextCompaction"`);
        for (const status of ["completed", "interrupted", "failed", "inProgress"]) {
          expect(notifications).toContain(`"${status}"`);
        }
      }),
    ),
  { timeout: 60_000 },
);

onMachineWith("codex")(
  "the installed Codex supports these controls and takes both flags",
  () =>
    runEffect(
      Effect.gen(function* () {
        const wanted = VERIFIED_VERSIONS.get("codex") ?? "";
        const version = yield* Effect.promise(() => Bun.$`codex --version`.text());
        expect(wanted).not.toBe("");
        expect(atLeast(version, wanted)).toBe(true);
        yield* codex.gate;

        const help = yield* Effect.promise(() => Bun.$`codex --help`.text());
        expect(help).toContain("--remote");
        expect(help).toContain("ws://host:port");
        const appServer = yield* Effect.promise(() => Bun.$`codex app-server --help`.text());
        expect(appServer).toContain("--listen");
      }),
    ),
  { timeout: 60_000 },
);

// Codex's App Server, as Collie's adapter drives it. Two kinds of check:
//
//   - the protocol, against a stand-in server this test controls, so the adapter's
//     identity binding, accounting and correlation can be put in states a real Codex
//     will not produce on demand;
//   - the contract, against the installed Codex itself. Its own `generate-json-schema`
//     is the authority on what this release's protocol has, so the check is that every
//     method and field the adapter uses is in it — not that a mock answered.

import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from "bun:test";
import { Effect, FileSystem, Path, Result, Schema } from "effect";
import { Rig } from "./support/recorder";
import { runEffect } from "./support/effect";
import { fakeChannel } from "./support/compaction";
import { reason } from "../src/naming";
import { COMPACTION_PORTS, VERIFIED_VERSIONS } from "../src/compactors";
import { boundThread, withCodex } from "../src/codex";
import { Unsubmitted, type AgentContext } from "../src/compaction";

let rig: Rig;
let fs: FileSystem.FileSystem;
let path: Path.Path;
let dir: string;

const codex = COMPACTION_PORTS.codex!;

/** What the stand-in server answers with, per test. */
interface Fake {
  threads: string[];
  /** Threads the TUI keeps for itself, as `thread/read` reports them. */
  ephemeral: string[];
  cwd: string;
  /** Token usage replayed on a rejoin; null sends none, as a fresh thread does. */
  usage: number | null;
  compactions: { id: string; turnId: string }[];
  turns: { id: string; status: string; error?: { message: string } }[];
  /** What a compact request appends, so a test can make one land or not. */
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
    id: Schema.Number,
    method: Schema.String,
    params: Schema.optionalKey(Schema.Unknown),
  }),
);
const decodeRequest = Schema.decodeUnknownOption(Request);

/** What the stand-in answers with: the JSON the protocol's own responses hold. */
type Answer = Schema.Schema.Type<typeof Schema.Json>;

/**
 * A stand-in App Server. Not a claim about Codex: it answers the shape the installed
 * release's own schema declares, which the contract checks at the bottom of this file
 * assert separately.
 */
function serve(): FakeServer {
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
          ws.send(JSON.stringify({ id, result }));
        };
        // SAFETY: every method this stand-in answers takes `threadId` and nothing
        // else, and the schema above has already parsed the frame into an object.
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
              },
            });
          case "thread/resume": {
            reply({ thread: { id: threadId } });
            // A rejoin replays the current usage, which is the only way this adapter
            // can read a Codex agent's context at all.
            if (fake.usage !== null) {
              ws.send(
                JSON.stringify({
                  method: "thread/tokenUsage/updated",
                  params: {
                    threadId,
                    turnId: "t-1",
                    tokenUsage: {
                      // Accumulated session usage, which must never be thresholded.
                      total: {
                        totalTokens: 999_999,
                        inputTokens: 0,
                        cachedInputTokens: 0,
                        outputTokens: 0,
                        reasoningOutputTokens: 0,
                      },
                      last: {
                        totalTokens: fake.usage,
                        // The overlapping parts of that total, not addends.
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
                ...fake.compactions.map((c) => ({
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

/** Why a read failed, as a human would read it off the Run. */
function why<A, E>(result: Result.Result<A, E>): string {
  return Result.isFailure(result) ? reason(result.failure) : "";
}

const ctx = (): AgentContext => ({
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

test("the TUI's own ephemeral thread is not a second agent to choose between", () =>
  runEffect(
    Effect.gen(function* () {
      // A Codex TUI loads a cheap ephemeral thread of its own beside the one it is
      // working in, so an agent's own endpoint has two loaded threads and only one of
      // them is the agent.
      fake.threads = ["thread-1", "thread-helper"];
      fake.ephemeral = ["thread-helper"];

      const bound = yield* withCodex(ctx().endpoint!, (client) => boundThread(client, fake.cwd));
      expect(bound).toBe("thread-1");
      expect(yield* codex.usage(ctx())).toBe(400_000);
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
      // `last.totalTokens` as it stands. Its input, cached-input, output and reasoning
      // fields are its parts; adding them would double-count, and `total` beside it is
      // accumulated session usage — 999,999 in the stand-in, to make either mistake loud.
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
      // The empty reply acknowledges submission. Nothing has compacted.
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
      // Nothing has been asked of the thread yet, so the waiting work may go out with
      // a warning rather than waiting out a compaction nobody started.
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

// The contract, against the installed Codex. Its own schema generator is the authority
// on what this release has; a mock cannot answer that question.
test(
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
        for (const method of [
          "initialize",
          "thread/loaded/list",
          "thread/read",
          "thread/resume",
          "thread/items/list",
          "thread/turns/list",
          "thread/compact/start",
        ]) {
          expect(requests, `${method} is gone from the protocol`).toContain(`"${method}"`);
        }

        const notifications = yield* read("ServerNotification.json");
        expect(notifications).toContain(`"thread/tokenUsage/updated"`);
        // The accounting: `last` beside `total`, and the total that is used as it stands.
        expect(notifications).toContain(`"last"`);
        expect(notifications).toContain(`"totalTokens"`);
        // The item type the compaction lifecycle is read from.
        expect(notifications).toContain(`"contextCompaction"`);
        // The terminal turn statuses the failure mapping relies on.
        for (const status of ["completed", "interrupted", "failed", "inProgress"]) {
          expect(notifications).toContain(`"${status}"`);
        }
      }),
    ),
  { timeout: 60_000 },
);

test(
  "the installed Codex is the release these controls were verified against, and takes both flags",
  () =>
    runEffect(
      Effect.gen(function* () {
        const wanted = VERIFIED_VERSIONS.get("codex") ?? "";
        const version = yield* Effect.promise(() => Bun.$`codex --version`.text());
        expect(version).toContain(wanted);
        yield* codex.gate();

        // The launch topology: a server on a loopback port, and a TUI pointed at it.
        const help = yield* Effect.promise(() => Bun.$`codex --help`.text());
        expect(help).toContain("--remote");
        expect(help).toContain("ws://host:port");
        const appServer = yield* Effect.promise(() => Bun.$`codex app-server --help`.text());
        expect(appServer).toContain("--listen");
      }),
    ),
  { timeout: 60_000 },
);

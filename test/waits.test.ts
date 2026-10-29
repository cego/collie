// Collie's polled waits, on a clock that moves only by what is slept on it: how often each
// asks, what it says once its deadline has passed between two asks, and that an ask still
// running at the deadline is waited for and its answer used.

import { expect, test } from "bun:test";
import { Clock, Effect, Fiber, FileSystem, Schema } from "effect";
import { TestClock } from "effect/testing";
import { withCodex, currentContext } from "../src/codex";
import {
  atBoundary,
  awaitReady,
  Unsubmitted,
  type CompactionDeps,
  type CompactionPort,
  type CompactionOutcome,
} from "../src/compaction";
import { codexPort, servedEndpoint } from "../src/compactors";
import type { Channel } from "../src/dispatcher";
import { handOverClaim } from "../src/engine";
import { runEffect } from "./support/effect";
import { until } from "./support/host";

const encode = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const decodeFrame = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.Struct({ id: Schema.Number, method: Schema.String })),
);

/** Runs `wait` on a TestClock its sleeps advance, and the times it asked, from its start. */
const timed = <A, E, R>(wait: (ask: Effect.Effect<number>) => Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const clock = yield* TestClock.make();
    const fast: Clock.Clock = { ...clock, sleep: (duration) => clock.adjust(duration) };
    const start = clock.currentTimeMillisUnsafe();
    const asked: number[] = [];
    const ask = Effect.sync(() => {
      const at = clock.currentTimeMillisUnsafe() - start;
      asked.push(at);
      return at;
    });
    const result = yield* wait(ask).pipe(Effect.provideService(Clock.Clock, fast));
    return { result, asked, ended: clock.currentTimeMillisUnsafe() - start };
  });

const every = (interval: number, from: number, to: number) =>
  Array.from({ length: (to - from) / interval + 1 }, (_, at) => from + at * interval);

const port = (over: Partial<CompactionPort>): CompactionPort => ({
  gate: () => Effect.void,
  install: () => Effect.die(new Error("not installed here")),
  usage: () => Effect.succeed(null),
  request: () => Effect.succeed(null),
  poll: () => Effect.succeed(null),
  ...over,
});

/** An agent's control record under a fresh state directory, with `attempt` in the air. */
const controlled = (attempt: { readonly deadline: number } | null) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const stateDir = yield* fs.makeTempDirectoryScoped({ prefix: "collie-waits-" });
    yield* fs.makeDirectory(`${stateDir}/compaction/build-r1`, { recursive: true });
    yield* fs.writeFileString(
      `${stateDir}/compaction/build-r1/control.json`,
      encode({
        agent: "build-r1",
        harness: "claude",
        cwd: stateDir,
        dir: `${stateDir}/compaction/build-r1`,
        attempt: attempt && { id: "build-r1-1", run: "r1", step: "01-api", ...attempt },
      }),
    );
    return stateDir;
  });

const deps = (stateDir: string, claude: CompactionPort): CompactionDeps => ({
  ports: { claude },
  stateDir,
  configured: 1000,
  herdr: { agentList: () => Effect.succeed([]) },
  log: () => Effect.void,
  warn: () => Effect.void,
  waitMs: 60_000,
  pollMs: 300,
});

test("a harness's readiness is asked every poll, and past its budget the wait says why", () =>
  runEffect(
    Effect.gen(function* () {
      const stateDir = yield* controlled(null);
      const { result, asked } = yield* timed((ask) =>
        awaitReady(
          deps(
            stateDir,
            port({ ready: () => ask.pipe(Effect.andThen(Effect.fail(new Error("no prompt")))) }),
          ),
          "build-r1",
          1000,
        ),
      );
      expect(asked).toEqual([0, 300, 600, 900, 1200]);
      expect(result).toBe("claude gave no sign it was up within 1s (no prompt)");
    }),
  ));

test("a readiness ask still running at the budget is waited for, and its yes is taken", () =>
  runEffect(
    Effect.gen(function* () {
      const stateDir = yield* controlled(null);
      const { result, ended } = yield* timed((ask) =>
        awaitReady(
          deps(
            stateDir,
            port({
              ready: () =>
                ask.pipe(
                  Effect.flatMap((at) =>
                    at === 900 ? Effect.sleep(500).pipe(Effect.as(true)) : Effect.succeed(false),
                  ),
                ),
            }),
          ),
          "build-r1",
          1000,
        ),
      );
      expect(result).toBeNull();
      expect(ended).toBe(1400);
    }),
  ));

const submitting = <A, E, R>(
  _body: (channel: Channel) => Effect.Effect<A, E, R>,
): Effect.Effect<A, E | Unsubmitted, R> =>
  Effect.fail(new Unsubmitted({ message: "nothing is submitted here" }));

test("an unresolved compaction is polled at its interval and last at its recorded deadline", () =>
  runEffect(
    Effect.gen(function* () {
      const { result, asked } = yield* timed((ask) =>
        Effect.gen(function* () {
          const deadline = (yield* Clock.currentTimeMillis) + 1000;
          const stateDir = yield* controlled({ deadline });
          return yield* atBoundary(
            deps(stateDir, port({ poll: () => ask.pipe(Effect.as(null)) })),
            { agent: "build-r1", run: "r1", step: "02-ui" },
            submitting,
          );
        }),
      );
      expect(asked).toEqual([0, 300, 600, 900, 1000]);
      expect(result).toEqual({
        dispatch: false,
        waiting: true,
        reason:
          "build-r1: compaction build-r1-1 has not finished after 1 minutes; Collie keeps waiting and sends 02-ui once it does. Check its pane.",
      });
    }),
  ));

test("a compaction poll still running at the deadline is waited for, and its outcome is taken", () =>
  runEffect(
    Effect.gen(function* () {
      const completed: CompactionOutcome = { kind: "success" };
      const { result, ended } = yield* timed((ask) =>
        Effect.gen(function* () {
          const deadline = (yield* Clock.currentTimeMillis) + 1000;
          const stateDir = yield* controlled({ deadline });
          return yield* atBoundary(
            deps(
              stateDir,
              port({
                poll: () =>
                  ask.pipe(
                    Effect.flatMap((at) =>
                      at === 900
                        ? Effect.sleep(400).pipe(Effect.as(completed))
                        : Effect.succeed(null),
                    ),
                  ),
              }),
            ),
            { agent: "build-r1", run: "r1", step: "02-ui" },
            submitting,
          );
        }),
      );
      expect(result).toEqual({ dispatch: true });
      expect(ended).toBe(1300);
    }),
  ));

/** A FileSystem whose reads of `log` are `said` at each ask. */
const logSays = (fs: FileSystem.FileSystem, log: string, said: Effect.Effect<string>) => ({
  ...fs,
  readFileString: (path: string, encoding?: string) =>
    path === log ? said : fs.readFileString(path, encoding),
});

const served = (said: (at: number) => Effect.Effect<string>) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const dir = yield* fs.makeTempDirectoryScoped({ prefix: "collie-served-" });
    const log = `${dir}/server.log`;
    return yield* timed((ask) =>
      servedEndpoint({
        cwd: dir,
        log,
        command: "true",
        listening: /listening on (\S+)/,
        startMs: 1000,
        what: "the stand-in",
      }).pipe(
        Effect.provideService(
          FileSystem.FileSystem,
          logSays(fs, log, ask.pipe(Effect.flatMap(said))),
        ),
        Effect.result,
      ),
    );
  });

test("a server's log is read every 200 ms, and past its start budget the start fails", () =>
  runEffect(
    Effect.gen(function* () {
      const { result, asked } = yield* served(() => Effect.succeed(""));
      expect(asked).toEqual(every(200, 0, 1000));
      expect(result._tag === "Failure" && result.failure.message).toContain(
        "the stand-in did not come up within 1000ms",
      );
    }),
  ));

test("a server log read still running at the start budget is waited for, and its line is taken", () =>
  runEffect(
    Effect.gen(function* () {
      const { result, ended } = yield* served((at) =>
        at === 800
          ? Effect.sleep(400).pipe(Effect.as("listening on ws://127.0.0.1:1\n"))
          : Effect.succeed(""),
      );
      expect(result._tag === "Success" && result.success.found).toBe("ws://127.0.0.1:1");
      expect(ended).toBe(1200);
    }),
  ));

// Past any pid_max, so no process here can be one of the machine's.
const ROOT = 4_194_400;
const CHILD = 4_194_401;

/** `/proc` showing one process of `ROOT`'s session, `CHILD`, while each listing says it is there. */
const session = (
  fs: FileSystem.FileSystem,
  listed: Effect.Effect<boolean>,
): FileSystem.FileSystem => {
  const fields = Array<string>(20).fill("0");
  fields[0] = "S";
  fields[3] = String(ROOT);
  fields[19] = "child-start";
  return {
    ...fs,
    exists: (path) => (path === "/proc/self/stat" ? Effect.succeed(true) : fs.exists(path)),
    readDirectory: (path, options) =>
      path === "/proc"
        ? listed.pipe(Effect.map((there) => (there ? [String(CHILD)] : [])))
        : fs.readDirectory(path, options),
    readFileString: (path, encoding) =>
      path === `/proc/${CHILD}/stat`
        ? Effect.succeed(`${CHILD} (worker) ${fields.join(" ")}`)
        : path === `/proc/${CHILD}/cmdline`
          ? Effect.succeed("worker\0")
          : fs.readFileString(path, encoding),
  };
};

const survived = (there: (at: number) => Effect.Effect<boolean>) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    return yield* timed((ask) =>
      codexPort("codex").stop!(
        {
          agent: "build-r1",
          cwd: "/",
          endpoint: "ws://127.0.0.1:1",
          pid: ROOT,
          command: "codex",
          started: "server-start",
          signalled: [],
          noted: [{ pid: CHILD, started: "child-start" }],
        },
        () => Effect.void,
        0,
      ).pipe(
        Effect.provideService(FileSystem.FileSystem, session(fs, ask.pipe(Effect.flatMap(there)))),
      ),
    );
  });

test("what is left of an exited server is looked at every 50 ms for its two-second grace", () =>
  runEffect(
    Effect.gen(function* () {
      const { result, asked } = yield* survived(() => Effect.succeed(true));
      expect(asked).toEqual([0, ...every(50, 0, 2000)]);
      expect(result.state).toBe("failed");
      expect(result.left).toEqual([{ pid: CHILD, started: "child-start" }]);
    }),
  ));

test("a look at an exited server's session still running at its grace is waited for, and used", () =>
  runEffect(
    Effect.gen(function* () {
      const { result, ended } = yield* survived((at) =>
        at === 1950 ? Effect.sleep(100).pipe(Effect.as(false)) : Effect.succeed(true),
      );
      expect(result.state).toBe("quiet");
      expect(ended).toBe(2050);
    }),
  ));

const handOver = (
  stopped: (runId: string, at: number) => Effect.Effect<boolean>,
  looks: Array<string>,
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const dir = yield* fs.makeTempDirectoryScoped({ prefix: "collie-handover-waits-" });
    yield* fs.makeDirectory(`${dir}/runs/r-old`, { recursive: true });
    yield* fs.writeFileString(`${dir}/runs/r-old/helle.json`, `{"slug":"project","claim":"mine"}`);
    return yield* timed((ask) =>
      handOverClaim({
        dir,
        slug: "project",
        to: "r-new",
        runs: ["r-old"],
        stop: (runId) => Effect.succeed({ runs: [runId, "r-child"], left: [] }),
        stopped: (runId) =>
          ask.pipe(
            Effect.tap((at) => Effect.sync(() => looks.push(`${runId}@${at}`))),
            Effect.flatMap((at) => stopped(runId, at)),
          ),
        halt: () => Effect.succeed({ stopped: [], left: [] }),
        patience: { everyMs: 250, forMs: 1000 },
      }).pipe(Effect.result),
    );
  });

test("a hand-over looks at each Run it stopped every interval, against one deadline for all", () =>
  runEffect(
    Effect.gen(function* () {
      const looks: string[] = [];
      const { result } = yield* handOver(
        (runId, at) => Effect.succeed(runId === "r-old" && at >= 500),
        looks,
      );
      expect(looks).toEqual([
        "r-old@0",
        "r-old@250",
        "r-old@500",
        "r-child@500",
        "r-child@750",
        "r-child@1000",
      ]);
      expect(result._tag === "Failure" && result.failure.message).toContain(
        "r-child is still running a step its stop has not reached",
      );
    }),
  ));

test("a hand-over's look still running at its deadline is waited for, and its stop is taken", () =>
  runEffect(
    Effect.gen(function* () {
      const { result, ended } = yield* handOver(
        (runId, at) =>
          runId === "r-child"
            ? Effect.succeed(true)
            : at === 750
              ? Effect.sleep(400).pipe(Effect.as(true))
              : Effect.succeed(false),
        [],
      );
      expect(result._tag === "Success" && result.success).toEqual(["r-old"]);
      expect(ended).toBe(1150);
    }),
  ));

/** A Codex App Server stand-in that replays usage only when the test says. */
const codexServer = () => {
  const { promise: replaying, resolve: resumed } =
    Promise.withResolvers<(threadId: string, tokens: number) => void>();
  const listening = Bun.serve({
    port: 0,
    fetch: (request, self) =>
      self.upgrade(request) ? undefined : new Response("no", { status: 400 }),
    websocket: {
      message(ws, raw) {
        const { id, method } = decodeFrame(String(raw));
        ws.send(encode({ id, result: method === "initialize" ? { userAgent: "fake" } : {} }));
        if (method !== "thread/resume") return;
        resumed((threadId, tokens) => {
          const usage = {
            totalTokens: tokens,
            inputTokens: 0,
            cachedInputTokens: 0,
            outputTokens: 0,
            reasoningOutputTokens: 0,
          };
          ws.send(
            encode({
              method: "thread/tokenUsage/updated",
              params: { threadId, turnId: "t-1", tokenUsage: { total: usage, last: usage } },
            }),
          );
        });
      },
    },
  });
  return {
    url: `ws://127.0.0.1:${listening.port}`,
    replaying,
    [Symbol.dispose]: () => listening.stop(true),
  };
};

/** `currentContext` on a TestClock, forked once the server has its rejoin. */
const reading = Effect.fn("test.reading")(function* (url: string) {
  const clock = yield* TestClock.make();
  const fiber = yield* Effect.forkChild(
    withCodex(url, (client) => currentContext(client, "thread-1")).pipe(
      Effect.provideService(Clock.Clock, clock),
    ),
  );
  return { clock, fiber };
});

test("a Codex usage replay is read once it arrives, past another thread's", () =>
  runEffect(
    Effect.gen(function* () {
      using server = codexServer();
      const { clock, fiber } = yield* reading(server.url);
      const replay = yield* Effect.promise(() => server.replaying);
      yield* clock.adjust(1000);
      replay("thread-other", 5);
      replay("thread-1", 400_000);
      yield* until(
        () => clock.adjust(100).pipe(Effect.andThen(Effect.sync(() => fiber.pollUnsafe()))),
        (exit) => exit !== undefined,
      );
      expect(yield* Fiber.join(fiber)).toBe(400_000);
    }),
  ));

test("a Codex rejoin that replays nothing is null at its three-second deadline", () =>
  runEffect(
    Effect.gen(function* () {
      using server = codexServer();
      const { clock, fiber } = yield* reading(server.url);
      yield* Effect.promise(() => server.replaying);
      yield* clock.adjust(2999);
      expect(fiber.pollUnsafe()).toBeUndefined();
      yield* clock.adjust(1);
      expect(yield* Fiber.join(fiber)).toBeNull();
    }),
  ));

test("a Codex usage replay that lands just before the deadline is used, not dropped", () =>
  runEffect(
    Effect.gen(function* () {
      using server = codexServer();
      const { clock, fiber } = yield* reading(server.url);
      const replay = yield* Effect.promise(() => server.replaying);
      yield* clock.adjust(2950);
      replay("thread-1", 400_000);
      yield* Effect.sleep("200 millis");
      yield* clock.adjust(50);
      expect(yield* Fiber.join(fiber)).toBe(400_000);
    }),
  ));

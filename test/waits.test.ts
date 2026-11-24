import * as Cause from "effect/Cause";

import * as Arr from "effect/Array";
import { expect, test } from "bun:test";
import { Clock, Effect, Fiber, FileSystem, Schema, flow, Result } from "effect";
import { TestClock } from "effect/testing";
import { withCodex, currentContext } from "../src/codex";
import {
  atBoundary,
  awaitReady,
  cancelCompaction,
  readControl,
  Unsubmitted,
} from "../src/compaction";
import type { CompactionPort, CompactionOutcome } from "../src/compaction";
import { COMPACTION_PORTS, codexPort, servedEndpoint } from "../src/compactors";
import type { Channel } from "../src/dispatcher";
import { handOverClaim } from "../src/engine";
import { rememberCompactionWait, recheckPark } from "../src/park-recheck";
import { fastForward, runEffect } from "./support/effect";
import { forgeHttpOnPath } from "./support/forge";
import { fakeChannel } from "./support/compaction";
import { until } from "./support/host";

const encode = flow(Schema.encodeResult(Schema.fromJsonString(Schema.Unknown)), Result.getOrThrow);
const decodeFrame = flow(
  Schema.decodeUnknownResult(
    Schema.fromJsonString(Schema.Struct({ id: Schema.Finite, method: Schema.String })),
  ),
  Result.getOrThrow,
);

const timed = <A, E, R>(wait: (ask: Effect.Effect<number>) => Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const clock = yield* TestClock.make();
    const fast: Clock.Clock = { ...clock, sleep: (duration) => clock.adjust(duration) };
    const start = clock.currentTimeMillisUnsafe();
    const asked: Array<number> = [];
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

const port = (over: Partial<CompactionPort>) => ({
  gate: Effect.void,
  install: () => Effect.die(new Error("not installed here")),
  usage: () => Effect.succeed(null),
  request: () => Effect.succeed(null),
  poll: () => Effect.succeed(null),
  ...over,
});

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

const deps = (stateDir: string, claude: CompactionPort) => ({
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
            port({
              ready: () =>
                ask.pipe(Effect.andThen(Effect.fail(new Cause.NoSuchElementError("no prompt")))),
            }),
          ),
          "build-r1",
          1000,
        ),
      );
      expect(asked).toEqual([0, 300, 600, 900, 1200]);
      expect(result).toBe("no prompt");
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

const submitting = <A, E, R>(_body: (channel: Channel) => Effect.Effect<A, E, R>) =>
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
        cause: "compaction-unsettled",
        reason:
          "build-r1: compaction build-r1-1 has not finished after 1 minutes; Collie keeps waiting for its completion and resumes 02-ui once it arrives. Check its pane.",
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

test("a fast-forwarded server start waits for a server that takes real time to come up", () =>
  runEffect(
    fastForward(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const dir = yield* fs.makeTempDirectoryScoped({ prefix: "collie-served-" });
        const served = yield* servedEndpoint({
          cwd: dir,
          log: `${dir}/server.log`,
          command: "sh -c 'sleep 1; echo listening on ws://127.0.0.1:1'",
          listening: /listening on (\S+)/,
          startMs: 1000,
          what: "the stand-in",
        });
        expect(served.found).toBe("ws://127.0.0.1:1");
      }).pipe(Effect.scoped),
    ),
  ));

// WARNING: past any pid_max, so no process here can be one of the machine's.
const ROOT = 4_194_400;
const CHILD = 4_194_401;

const session: (
  fs: FileSystem.FileSystem,
  listed: Effect.Effect<boolean>,
) => FileSystem.FileSystem = (fs, listed) => {
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
        ? Effect.succeed(`${CHILD} (worker) ${Arr.join(fields, " ")}`)
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
      const looks: Array<string> = [];
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
        if (method !== "thread/resume") {
          return;
        }
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

test("a compaction waits for room before it is asked for, and a stop in that wait asks nothing", () =>
  runEffect(
    Effect.gen(function* () {
      const stateDir = yield* controlled(null);
      const said: Array<string> = [];
      const due = yield* atBoundary(
        {
          ...deps(
            stateDir,
            port({
              usage: () => Effect.succeed(5000),
              request: () => Effect.sync(() => void said.push("request")).pipe(Effect.as(null)),
            }),
          ),
          room: () => Effect.sync(() => said.push("room")).pipe(Effect.as("stopped" as const)),
        },
        { agent: "build-r1", run: "r1", step: "02-ui" },
        submitting,
      );
      expect(said).toEqual(["room"]);
      expect(due).toEqual({
        dispatch: false,
        reason: "build-r1: the Run was stopped while its compaction waited for disk",
      });
    }),
  ));

const saidBy = (due: { readonly dispatch: boolean; readonly reason?: string }) =>
  due.dispatch ? "" : (due.reason ?? "");

const startEvent = (id: string) => ({
  at: 1_791_457_800_000,
  session: "s-1",
  kind: "start",
  request: id,
});

const postEvent = () => ({
  at: 1_791_457_860_000,
  session: "s-1",
  kind: "auto",
  reason: "manual",
  phase: "post",
});

const binding = { at: 1_791_457_799_000, session: "s-1", kind: "session" };

const hooks = (control: string, events: ReadonlyArray<typeof binding>) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    // WARNING: the newest session line is what binds the events Collie reads, as the status line writes it.
    yield* fs.writeFileString(
      `${control}/events.jsonl`,
      `${Arr.join(
        Arr.map([{ at: 1_791_457_799_000, session: "s-1", kind: "session" }, ...events], (event) =>
          JSON.stringify(event),
        ),
        "\n",
      )}\n`,
      { flag: "a" },
    );
  });

const ctx = (dir: string) => ({
  agent: "build-r1",
  run: "r1",
  harness: "claude",
  cwd: "/nowhere",
  dir,
  endpoint: null,
  channel: fakeChannel([]),
});

const lostPark = (stateDir: string) => ({
  runId: "r1",
  cwd: stateDir,
  branch: null,
  mr: null,
  park: { cause: "compaction-unsettled" as const, kind: "rechecks" as const },
});

test("a compaction that never completes parks under its own cause at its bound, and its completion carries the Step on", () =>
  runEffect(
    Effect.gen(function* () {
      let polls = 0;
      const { result } = yield* timed((ask) =>
        Effect.gen(function* () {
          const deadline = (yield* Clock.currentTimeMillis) + 1000;
          const stateDir = yield* controlled({ deadline });
          const waiting = yield* atBoundary(
            deps(
              stateDir,
              port({
                poll: () =>
                  ask.pipe(Effect.andThen(Effect.sync(() => (polls += 1))), Effect.as(null)),
              }),
            ),
            { agent: "build-r1", run: "r1", step: "02-ui" },
            submitting,
          );
          return { stateDir, waiting };
        }),
      );
      const { stateDir } = result;
      const control = `${stateDir}/compaction/build-r1`;
      const fs = yield* FileSystem.FileSystem;
      yield* fs.makeDirectory(`${stateDir}/runs/r1`, { recursive: true });
      yield* hooks(control, [startEvent("build-r1-1")]);
      yield* rememberCompactionWait(`${stateDir}/runs/r1`, {
        agent: "build-r1",
        request: "build-r1-1",
      });

      expect(polls).toBe(5);
      expect(result.waiting).toMatchObject({
        dispatch: false,
        waiting: true,
        cause: "compaction-unsettled",
      });
      const [, reason] = [result.waiting, saidBy(result.waiting)];
      expect(reason).toContain("Check its pane");
      expect(reason).toContain("resumes 02-ui once it arrives");

      const herdr = { agentList: () => Effect.succeed([]) };
      const before = yield* recheckPark(lostPark(stateDir), stateDir, herdr);
      expect(before).toMatchObject({ cleared: false, error: false });

      yield* hooks(control, [postEvent()]);
      const after = yield* recheckPark(lostPark(stateDir), stateDir, herdr);
      expect(after).toMatchObject({ cleared: true, error: false });

      const due = yield* atBoundary(
        deps(stateDir, COMPACTION_PORTS.claude!),
        { agent: "build-r1", run: "r1", step: "02-ui" },
        submitting,
      );
      expect(due).toEqual({ dispatch: true });
    }).pipe(Effect.provide(forgeHttpOnPath)),
  ));

test("a restart keeps the request it marked, its bound and its park, and a matching completion still carries the Step on", () =>
  runEffect(
    Effect.gen(function* () {
      let pollsAfter = 0;
      const { result } = yield* timed((ask) =>
        Effect.gen(function* () {
          const deadline = (yield* Clock.currentTimeMillis) + 1000;
          const stateDir = yield* controlled({ deadline });
          const first = yield* atBoundary(
            deps(stateDir, port({ poll: () => ask.pipe(Effect.as(null)) })),
            { agent: "build-r1", run: "r1", step: "02-ui" },
            submitting,
          );
          return { stateDir, first };
        }),
      );
      const { stateDir } = result;
      const marked = yield* readControl(stateDir, "build-r1");
      // WARNING: the restart is a fresh reader of the same records, not a new mark.
      const again = yield* atBoundary(
        deps(
          stateDir,
          port({
            poll: () => Effect.sync(() => (pollsAfter += 1)).pipe(Effect.as(null)),
          }),
        ),
        { agent: "build-r1", run: "r1", step: "02-ui" },
        submitting,
      );
      const still = yield* readControl(stateDir, "build-r1");
      const control = `${stateDir}/compaction/build-r1`;
      yield* hooks(control, [startEvent("build-r1-1"), postEvent()]);
      const resumed = yield* atBoundary(
        deps(stateDir, COMPACTION_PORTS.claude!),
        { agent: "build-r1", run: "r1", step: "02-ui" },
        submitting,
      );

      expect(still?.attempt?.id).toBe(marked?.attempt?.id);
      expect(still?.attempt?.deadline).toBe(marked?.attempt?.deadline);
      expect(pollsAfter).toBe(1);
      expect(again).toMatchObject({
        dispatch: false,
        waiting: true,
        cause: "compaction-unsettled",
      });
      expect(saidBy(again)).toBe(saidBy(result.first));
      // WARNING: what a restart reads is the stored attempt, whole; a park identity derived from it follows.
      expect(still?.attempt).toEqual(marked?.attempt);
      expect(resumed).toEqual({ dispatch: true });
    }).pipe(Effect.provide(forgeHttpOnPath)),
  ));

test("a stopped agent's compaction is recorded as cancelled, no later boundary settles it, and the wait does not stay parked", () =>
  runEffect(
    Effect.gen(function* () {
      const { result } = yield* timed((ask) =>
        Effect.gen(function* () {
          const deadline = (yield* Clock.currentTimeMillis) + 1000;
          const stateDir = yield* controlled({ deadline });
          yield* atBoundary(
            deps(stateDir, port({ poll: () => ask.pipe(Effect.as(null)) })),
            { agent: "build-r1", run: "r1", step: "02-ui" },
            submitting,
          );
          return { stateDir };
        }),
      );
      const { stateDir } = result;
      const control = `${stateDir}/compaction/build-r1`;
      const fs = yield* FileSystem.FileSystem;
      yield* fs.makeDirectory(`${stateDir}/runs/r1`, { recursive: true });
      yield* rememberCompactionWait(`${stateDir}/runs/r1`, {
        agent: "build-r1",
        request: "build-r1-1",
      });
      yield* hooks(control, [startEvent("build-r1-1")]);
      const cancelled = yield* cancelCompaction(
        { ports: COMPACTION_PORTS, stateDir, log: () => Effect.void },
        "build-r1",
        "its Run was stopped",
      );
      const written = yield* fs.readFileString(`${control}/events.jsonl`);
      yield* hooks(control, [postEvent()]);
      const settled = yield* COMPACTION_PORTS.claude!.poll(ctx(control), {
        id: "build-r1-1",
        session: null,
        launch: null,
        transcript: null,
      });
      const cleared = yield* recheckPark(lostPark(stateDir), stateDir, {
        agentList: () => Effect.succeed([]),
      });

      expect(cancelled).toBe(true);
      expect(written).toContain('"kind":"cancelled"');
      expect(written).not.toContain('"kind":"done"');
      expect(settled).toEqual({ kind: "failure", reason: "its Run was stopped" });
      expect(cleared).toMatchObject({ cleared: true, error: false });
    }).pipe(Effect.provide(forgeHttpOnPath)),
  ));

import * as Str from "effect/String";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { ConfigProvider, Effect, FileSystem, Path, Schedule, Schema, flow, Result } from "effect";
import { Rig } from "./support/recorder";
import { runEffect } from "./support/effect";
import { onMachineWith, removesCache } from "./support/live";
import { fakeChannel } from "./support/compaction";
import {
  atLeast,
  COMPACTION_PORTS,
  ranOutSince,
  stoppedSince,
  VERIFIED_VERSIONS,
} from "../src/compactors";

let rig: Rig;
let fs: FileSystem.FileSystem;
let path: Path.Path;
let dir: string;

const pi = COMPACTION_PORTS.pi!;

const prompted: Array<string> = [];
const marked = (id: string) => ({ id, session: null, launch: "l-1", transcript: null });

const ctx = () => ({
  agent: "reuse-run-two-r1",
  run: "reuse-run-two",
  harness: "pi",
  cwd: rig.projectDir,
  dir,
  endpoint: null,
  channel: fakeChannel(prompted),
});

interface Line {
  at: number;
  session: string;
  launch?: string;
  kind: string;
  tokens?: number | string | null;
  request?: string;
  message?: string;
  reason?: string;
}
const encodeLine = flow(
  Schema.encodeResult(
    Schema.fromJsonString(
      Schema.Struct({
        at: Schema.Finite,
        session: Schema.String,
        launch: Schema.optionalKey(Schema.String),
        kind: Schema.String,
        tokens: Schema.optionalKey(Schema.NullOr(Schema.Union([Schema.Finite, Schema.String]))),
        request: Schema.optionalKey(Schema.String),
        message: Schema.optionalKey(Schema.String),
        reason: Schema.optionalKey(Schema.String),
      }),
    ),
  ),
  Result.getOrThrow,
);

const event = (line: Line) =>
  fs.writeFileString(
    path.join(dir, "events.jsonl"),
    `${encodeLine({ launch: "l-1", ...line })}\n`,
    {
      flag: "a",
    },
  );

beforeEach(() =>
  runEffect(
    Effect.gen(function* () {
      fs = yield* FileSystem.FileSystem;
      path = yield* Path.Path;
      rig = yield* Rig.make();
      dir = path.join(rig.root, "controls", "reuse-run-two-r1");
      yield* fs.makeDirectory(dir, { recursive: true });
      prompted.length = 0;
    }),
  ),
);

afterEach(() => runEffect(rig.close()));

test("with no telemetry yet there is no sample, rather than a sample of zero", () =>
  runEffect(
    Effect.gen(function* () {
      expect(yield* pi.usage(ctx())).toBeNull();
    }),
  ));

test("the newest sample of the bound session is the current context", () =>
  runEffect(
    Effect.gen(function* () {
      yield* event({ at: 1, session: "s1", kind: "session" });
      yield* event({ at: 2, session: "s1", kind: "usage", tokens: 10 });
      yield* event({ at: 3, session: "s1", kind: "usage", tokens: 400_000 });

      expect(yield* pi.usage(ctx())).toBe(400_000);
    }),
  ));

test("Pi's null after a compaction stays unavailable, not the last high reading", () =>
  runEffect(
    Effect.gen(function* () {
      yield* event({ at: 1, session: "s1", kind: "session" });
      yield* event({ at: 2, session: "s1", kind: "usage", tokens: 400_000 });
      yield* event({ at: 3, session: "s1", kind: "auto", reason: "manual" });
      yield* event({ at: 4, session: "s1", kind: "usage", tokens: null });

      expect(yield* pi.usage(ctx())).toBeNull();
    }),
  ));

test("a second Pi session in the same pane makes the earlier session's samples stale", () =>
  runEffect(
    Effect.gen(function* () {
      yield* event({ at: 1, session: "s1", kind: "session" });
      yield* event({ at: 2, session: "s1", kind: "usage", tokens: 400_000 });
      yield* event({ at: 3, session: "s2", kind: "session" });

      expect(yield* pi.usage(ctx())).toBeNull();
    }),
  ));

test("a line Collie cannot decode is dropped rather than trusted", () =>
  runEffect(
    Effect.gen(function* () {
      yield* event({ at: 1, session: "s1", kind: "session" });
      yield* fs.writeFileString(path.join(dir, "events.jsonl"), "not json at all\n", {
        flag: "a",
      });
      yield* event({ at: 2, session: "s1", kind: "usage", tokens: "loads" });
      yield* event({ at: 3, session: "s1", kind: "usage", tokens: 7 });

      expect(yield* pi.usage(ctx())).toBe(7);
    }),
  ));

test("an unresolved request has no outcome, however much else has happened", () =>
  runEffect(
    Effect.gen(function* () {
      yield* event({ at: 1, session: "s1", kind: "session" });
      yield* event({ at: 2, session: "s1", kind: "start", request: "req-1" });
      yield* event({ at: 3, session: "s1", kind: "auto", reason: "threshold" });
      yield* event({ at: 4, session: "s1", kind: "done", request: "req-0" });
      yield* event({ at: 5, session: "s1", kind: "usage", tokens: 12 });

      expect(yield* pi.poll(ctx(), marked("req-1"))).toBeNull();
    }),
  ));

test("the request's own completion callback is what establishes success", () =>
  runEffect(
    Effect.gen(function* () {
      yield* event({ at: 1, session: "s1", kind: "session" });
      yield* event({ at: 2, session: "s1", kind: "start", request: "req-1" });
      yield* event({ at: 3, session: "s1", kind: "done", request: "req-1" });
      yield* event({ at: 4, session: "s1", kind: "done", request: "req-1" });

      expect(yield* pi.poll(ctx(), marked("req-1"))).toEqual({ kind: "success" });
    }),
  ));

test("its error callback is the confirmed failure, with Pi's own message", () =>
  runEffect(
    Effect.gen(function* () {
      yield* event({ at: 1, session: "s1", kind: "session" });
      yield* event({ at: 2, session: "s1", kind: "start", request: "req-1" });
      yield* event({
        at: 3,
        session: "s1",
        kind: "failed",
        request: "req-1",
        message: "the provider refused",
      });

      expect(yield* pi.poll(ctx(), marked("req-1"))).toEqual({
        kind: "failure",
        reason: "the provider refused",
      });
    }),
  ));

test("an outcome from another Pi session cannot complete this one's attempt", () =>
  runEffect(
    Effect.gen(function* () {
      yield* event({ at: 1, session: "s1", kind: "session" });
      yield* event({ at: 2, session: "s1", kind: "start", request: "req-1" });
      yield* event({ at: 3, session: "s2", kind: "session" });
      yield* event({ at: 4, session: "s1", kind: "done", request: "req-1" });

      expect(yield* pi.poll(ctx(), marked("req-1"))).toBeNull();
    }),
  ));

test("the request goes through Pi's own command, carrying the request id", () =>
  runEffect(
    Effect.gen(function* () {
      yield* pi.request(ctx(), "req-1");
      expect(prompted).toEqual(["/collie-compact req-1"]);
    }),
  ));

test("install writes the extension and passes it with Pi's own launch flag", () =>
  runEffect(
    Effect.gen(function* () {
      const args = yield* pi.install({
        agent: "reuse-run-two-r1",
        harness: "pi",
        cwd: rig.projectDir,
        dir,
      });

      expect(args.args).toEqual(["-e", path.join(dir, "collie.ts")]);
      const source = yield* fs.readFileString(path.join(dir, "collie.ts"));
      expect(source).toContain("ctx.getContextUsage()");
      expect(source).toContain("ctx.compact({");
      expect(source).toContain(`registerCommand("collie-compact"`);
      expect(source).toContain(`"${path.join(dir, "events.jsonl")}"`);
    }),
  ));

interface PiEvent {
  reason?: string;
  aborted?: boolean;
  message?: { stopReason?: string; errorMessage?: string };
}
interface PiContext {
  sessionManager: { getSessionFile: () => string | null };
  getContextUsage: () => { tokens: number };
  compact: (callbacks: { onComplete: () => void; onError: (error: Error) => void }) => void;
}
interface PiHost {
  on: (event: string, handler: (event: PiEvent, ctx: PiContext) => void) => void;
  registerCommand: (
    name: string,
    command: { handler: (args: string, ctx: PiContext) => void },
  ) => void;
}

test("the extension it installs keeps the identity and the outcome past its own cap", () =>
  runEffect(
    Effect.gen(function* () {
      yield* pi
        .install({ agent: "reuse-run-two-r1", harness: "pi", cwd: rig.projectDir, dir })
        .pipe(
          Effect.provideService(
            ConfigProvider.ConfigProvider,
            ConfigProvider.fromUnknown({ COLLIE_LAUNCH: "l-1" }),
          ),
        );
      const handlers = new Map<string, (event: PiEvent, ctx: PiContext) => void>();
      const commands = new Map<string, { handler: (args: string, ctx: PiContext) => void }>();
      const extension: { default: (host: PiHost) => void } = yield* Effect.promise(
        () => import(path.join(dir, "collie.ts")),
      );
      extension.default({
        on: (event, handler) => handlers.set(event, handler),
        registerCommand: (name, command) => commands.set(name, command),
      });
      let tokens = 100_000;
      const piCtx: PiContext = {
        sessionManager: { getSessionFile: () => "ses_one" },
        getContextUsage: () => ({ tokens }),
        compact: (callbacks) => callbacks.onComplete(),
      };
      const turns = (count: number) => {
        for (let i = 0; i < count; i++) {
          tokens += 1;
          handlers.get("turn_end")!({}, piCtx);
        }
      };

      handlers.get("session_start")!({}, piCtx);
      turns(200);
      commands.get("collie-compact")!.handler("req-1", piCtx);
      turns(300);

      expect(yield* pi.poll(ctx(), marked("req-1"))).toEqual({ kind: "success" });
      expect(yield* pi.usage(ctx())).toBe(tokens);
    }),
  ));

test("a Pi launch stamps its telemetry with the label a relaunch asks about", () =>
  runEffect(
    Effect.gen(function* () {
      yield* pi.install({ agent: "reuse-run-two-r1", harness: "pi", cwd: rig.projectDir, dir });
      const ran = Bun.spawnSync({
        cmd: [
          process.execPath,
          path.join(import.meta.dir, "support", "pi-launch.fixture.ts"),
          path.join(dir, "collie.ts"),
          "pi-agent-1",
        ],
      });
      expect(Str.trim(ran.stdout.toString())).toBe("loaded");
      const ready = pi.ready;
      if (ready === undefined) {
        return yield* Effect.die("the pi port reads readiness");
      }
      expect(yield* ready({ ...ctx(), launch: "pi-agent-1" })).toBe(true);
      expect(yield* ready({ ...ctx(), launch: "pi-agent-2" })).toBe(false);
    }),
  ));

onMachineWith("pi")(
  "the installed Pi is at least the release these controls were verified against",
  () =>
    runEffect(
      Effect.gen(function* () {
        const wanted = VERIFIED_VERSIONS.get("pi") ?? "";
        yield* removesCache("node-compile-cache");
        const installed = Str.trim(yield* Effect.promise(() => Bun.$`pi --version`.text()));
        expect([installed, atLeast(installed, wanted)]).toEqual([installed, true]);
        yield* pi.gate;
      }),
    ),
  { timeout: 30_000 },
);

onMachineWith("pi")(
  "Pi still takes the extension flag the adapter launches an agent with",
  () =>
    runEffect(
      Effect.gen(function* () {
        yield* removesCache("node-compile-cache");
        const [flag = ""] = (yield* pi.install({
          agent: "r1",
          harness: "pi",
          cwd: rig.projectDir,
          dir,
        })).args;
        const help = yield* Effect.promise(() => Bun.$`pi --help`.text());
        expect(help).toMatch(new RegExp(`(^|[\\s,])${flag}([\\s,=]|$)`, "m"));
      }),
    ),
  { timeout: 30_000 },
);

const asRpc = flow(
  Schema.encodeResult(
    Schema.fromJsonString(Schema.Struct({ type: Schema.String, message: Schema.String })),
  ),
  Result.getOrThrow,
);

onMachineWith("pi")(
  "the installed Pi runs the extension Collie installs and answers a request by its id",
  () =>
    runEffect(
      Effect.gen(function* () {
        yield* removesCache("jiti");
        yield* removesCache("node-compile-cache");
        const { args } = yield* pi.install({
          agent: "reuse-run-two-r1",
          harness: "pi",
          cwd: rig.projectDir,
          dir,
        });
        const child = Bun.spawn(["pi", "--mode", "rpc", "--offline", ...args], {
          cwd: rig.projectDir,
          env: { ...process.env, PI_CODING_AGENT_DIR: path.join(rig.root, "pi-agent") },
          stdin: "pipe",
          stdout: "ignore",
          stderr: "ignore",
        });
        void child.stdin.write(
          `${asRpc({ type: "prompt", message: "/collie-compact req-live" })}\n`,
        );
        void child.stdin.flush();

        const outcome = yield* pi.poll(ctx(), marked("req-live")).pipe(
          Effect.repeat({
            until: (found) => found !== null,
            schedule: Schedule.spaced("100 millis"),
          }),
          Effect.timeout("20 seconds"),
          Effect.ensuring(
            Effect.sync(() => child.kill()).pipe(
              Effect.andThen(Effect.promise(() => child.exited)),
            ),
          ),
        );

        // WARNING: A fresh session has nothing to compact; before any response its context estimate is unavailable.
        expect(outcome?.kind).toBe("failure");
        expect(yield* pi.usage(ctx())).toBeNull();
      }),
    ),
  { timeout: 30_000 },
);

test("an error stop on a usage limit is the agent running out; an overload is not", () =>
  runEffect(
    Effect.gen(function* () {
      yield* pi.install({ agent: "build-r1", harness: "pi", cwd: rig.projectDir, dir });
      const handlers = new Map<string, (event: PiEvent, ctx: PiContext) => void>();
      const extension: { default: (host: PiHost) => void } = yield* Effect.promise(
        () => import(path.join(dir, "collie.ts")),
      );
      extension.default({
        on: (event, handler) => handlers.set(event, handler),
        registerCommand: () => {},
      });
      const piCtx: PiContext = {
        sessionManager: { getSessionFile: () => "/home/mk/.pi/sessions/one.jsonl" },
        getContextUsage: () => ({ tokens: 1 }),
        compact: () => {},
      };
      handlers.get("session_start")!({}, piCtx);
      handlers.get("turn_end")!(
        { message: { stopReason: "error", errorMessage: "529 overloaded" } },
        piCtx,
      );
      expect(yield* ranOutSince(dir, 0)).toBeNull();
      handlers.get("turn_end")!(
        {
          message: {
            stopReason: "error",
            errorMessage: "You have hit your ChatGPT usage limit. Try again in 3 hours.",
          },
        },
        piCtx,
      );
      expect(yield* ranOutSince(dir, 0)).toEqual({
        why: "You have hit your ChatGPT usage limit. Try again in 3 hours.",
        transcript: "/home/mk/.pi/sessions/one.jsonl",
      });
    }),
  ));

const EXPIRED = "CodexApiError: Your authentication token has expired";
const PI_SESSION = "/home/mk/.pi/sessions/one.jsonl";

const loadedPi = Effect.gen(function* () {
  yield* pi.install({ agent: "build-r1", harness: "pi", cwd: rig.projectDir, dir });
  const handlers = new Map<string, (event: PiEvent, ctx: PiContext) => void>();
  const extension: { default: (host: PiHost) => void } = yield* Effect.promise(
    () => import(path.join(dir, "collie.ts")),
  );
  extension.default({
    on: (event, handler) => handlers.set(event, handler),
    registerCommand: () => {},
  });
  const piCtx: PiContext = {
    sessionManager: { getSessionFile: () => PI_SESSION },
    getContextUsage: () => ({ tokens: 1 }),
    compact: () => {},
  };
  handlers.get("session_start")!({}, piCtx);
  return {
    turn: (message: PiEvent["message"]) => handlers.get("turn_end")!({ message }, piCtx),
    settle: (aborted: boolean) => handlers.get("agent_settled")!({ aborted }, piCtx),
  };
});

test("an error turn pi settles on is its harness stopping, with pi's message and session", () =>
  runEffect(
    Effect.gen(function* () {
      const driven = yield* loadedPi;
      driven.turn({ stopReason: "error", errorMessage: EXPIRED });
      expect(yield* stoppedSince(dir, 0)).toBeNull();
      driven.settle(false);
      expect(yield* stoppedSince(dir, 0)).toEqual({
        why: EXPIRED,
        transcript: PI_SESSION,
        launch: null,
      });
    }),
  ));

test("an error turn pi retried into a successful one is no stop", () =>
  runEffect(
    Effect.gen(function* () {
      const driven = yield* loadedPi;
      driven.turn({ stopReason: "error", errorMessage: EXPIRED });
      driven.turn({ stopReason: "stop" });
      driven.settle(false);
      expect(yield* stoppedSince(dir, 0)).toBeNull();
    }),
  ));

test("an error turn settled by an abort is no stop", () =>
  runEffect(
    Effect.gen(function* () {
      const driven = yield* loadedPi;
      driven.turn({ stopReason: "error", errorMessage: EXPIRED });
      driven.settle(true);
      expect(yield* stoppedSince(dir, 0)).toBeNull();
    }),
  ));

test("a usage limit is still running out, and no stop", () =>
  runEffect(
    Effect.gen(function* () {
      const driven = yield* loadedPi;
      const limit = "You have hit your ChatGPT usage limit. Try again in 3 hours.";
      driven.turn({ stopReason: "error", errorMessage: limit });
      driven.settle(false);
      expect(yield* ranOutSince(dir, 0)).toEqual({ why: limit, transcript: PI_SESSION });
      expect(yield* stoppedSince(dir, 0)).toBeNull();
    }),
  ));

// Pi's official compaction interface, as Collie's adapter reads and writes it: the
// telemetry contract, the session binding, and what may and may not complete an
// attempt. Checked against the installed Pi where the check is about Pi itself.

import { afterEach, beforeEach, expect, test } from "bun:test";
import { Effect, FileSystem, Path, Schema } from "effect";
import { Rig } from "./support/recorder";
import { runEffect } from "./support/effect";
import { fakeChannel } from "./support/compaction";
import { COMPACTION_PORTS, VERIFIED_VERSIONS } from "../src/compactors";
import type { AgentContext } from "../src/compaction";

let rig: Rig;
let fs: FileSystem.FileSystem;
let path: Path.Path;
let dir: string;

const pi = COMPACTION_PORTS.pi!;

/** No prompt is sent in these checks; a boundary that reached for one would say so. */
const prompted: string[] = [];
const ctx = (): AgentContext => ({
  agent: "reuse-run-two-r1",
  run: "reuse-run-two",
  harness: "pi",
  cwd: rig.projectDir,
  dir,
  endpoint: null,
  channel: fakeChannel(prompted),
});

/** One line of what a control appends, exactly as the extension writes it. */
interface Line {
  at: number;
  session: string;
  kind: string;
  tokens?: number | string | null;
  request?: string;
  message?: string;
  reason?: string;
}
const encodeLine = Schema.encodeSync(
  Schema.fromJsonString(
    Schema.Struct({
      at: Schema.Number,
      session: Schema.String,
      kind: Schema.String,
      tokens: Schema.optionalKey(Schema.NullOr(Schema.Union([Schema.Number, Schema.String]))),
      request: Schema.optionalKey(Schema.String),
      message: Schema.optionalKey(Schema.String),
      reason: Schema.optionalKey(Schema.String),
    }),
  ),
);

const event = (line: Line) =>
  fs.writeFileString(path.join(dir, "events.jsonl"), `${encodeLine(line)}\n`, { flag: "a" });

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
      // The human typed /new: the context those 400k described is gone.
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
      // Pi's own threshold compaction, another request's completion, and an old idle
      // sample. None of them belong to req-1.
      yield* event({ at: 3, session: "s1", kind: "auto", reason: "threshold" });
      yield* event({ at: 4, session: "s1", kind: "done", request: "req-0" });
      yield* event({ at: 5, session: "s1", kind: "usage", tokens: 12 });

      expect(yield* pi.poll(ctx(), "req-1")).toBeNull();
    }),
  ));

test("the request's own completion callback is what establishes success", () =>
  runEffect(
    Effect.gen(function* () {
      yield* event({ at: 1, session: "s1", kind: "session" });
      yield* event({ at: 2, session: "s1", kind: "start", request: "req-1" });
      yield* event({ at: 3, session: "s1", kind: "done", request: "req-1" });
      // A duplicate cannot make it anything else.
      yield* event({ at: 4, session: "s1", kind: "done", request: "req-1" });

      expect(yield* pi.poll(ctx(), "req-1")).toEqual({ kind: "success" });
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

      expect(yield* pi.poll(ctx(), "req-1")).toEqual({
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

      expect(yield* pi.poll(ctx(), "req-1")).toBeNull();
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
      // The three official surfaces the adapter depends on, and the telemetry path
      // baked in so nothing has to reach an environment variable herdr cannot set.
      expect(source).toContain("ctx.getContextUsage()");
      expect(source).toContain("ctx.compact({");
      expect(source).toContain(`registerCommand("collie-compact"`);
      expect(source).toContain(`"${path.join(dir, "events.jsonl")}"`);
    }),
  ));

// Not mocks: whether the interface Collie installs is the one this machine's Pi has
// is exactly the question a mock cannot answer. Pi takes seconds to answer either.
test(
  "the installed Pi is at least the release these controls were verified against",
  () =>
    runEffect(
      Effect.gen(function* () {
        const wanted = VERIFIED_VERSIONS.get("pi") ?? "";
        const installed = (yield* Effect.promise(() => Bun.$`pi --version`.text())).trim();
        expect(installed).toBe(wanted);
        yield* pi.gate();
      }),
    ),
  { timeout: 30_000 },
);

test(
  "Pi still takes the extension flag the adapter launches an agent with",
  () =>
    runEffect(
      Effect.gen(function* () {
        const help = yield* Effect.promise(() => Bun.$`pi --help`.text());
        expect(help).toContain("--extension");
      }),
    ),
  { timeout: 30_000 },
);

// The shared boundary policy, at the seam the spec names: the real engine, the fake
// herdr, and a scripted harness port standing in for one harness's official interface.

import { afterEach, beforeEach, expect, test } from "bun:test";
import { Clock, Effect, FileSystem, Path } from "effect";
import { Rig } from "./support/recorder";
import { FakeBin } from "./support/bin";
import { installBaseline, runWorkflow } from "./support/engine";
import { writeDef } from "./support/defs";
import { runEffect } from "./support/effect";
import { atBoundary, controlDir, type CompactionPorts } from "../src/compaction";
import { Schema } from "effect";

/** One agent's controls, as `compaction.ts` writes them. */
const encodeControl = Schema.encodeSync(
  Schema.fromJsonString(
    Schema.Struct({
      agent: Schema.String,
      harness: Schema.String,
      cwd: Schema.String,
      dir: Schema.String,
      endpoint: Schema.NullOr(Schema.String),
      pid: Schema.NullOr(Schema.Number),
      command: Schema.NullOr(Schema.String),
      attempt: Schema.Null,
    }),
  ),
);
import { scriptedPort } from "./support/compaction";

let rig: Rig;
let bin: FakeBin;
let path: Path.Path;

beforeEach(() =>
  runEffect(
    Effect.gen(function* () {
      path = yield* Path.Path;
      rig = yield* Rig.make();
      yield* rig.startSocket();
      yield* installBaseline(rig);
      bin = yield* FakeBin.make(path.join(rig.root, "bin"));
      yield* bin.add("git", `echo main`);
      // Two steps, the second on the first's agent: the smallest workflow with a
      // work boundary in it.
      yield* writeDef(
        path.join(rig.projectDir, ".herdr"),
        "workflows",
        "reuse",
        `---
name: reuse
inputs: {}
steps:
  - id: one
    persona: implementer
    output: one.json
  - id: two
    persona: implementer
    agent: one
    output: two.json
---

## one

Do the first thing.

## two

Do the second thing.
`,
      );
    }),
  ),
);

afterEach(() =>
  runEffect(
    Effect.gen(function* () {
      yield* bin.restore();
      yield* rig.close();
    }),
  ),
);

const ran = (opts: Parameters<typeof runWorkflow>[3]) => runWorkflow(rig, "reuse", {}, opts);

test("a reused agent over the threshold is compacted before it is given the next work", () =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      yield* rig.queueOutputs([{ verdict: "clean" }, { verdict: "clean" }]);
      const port = scriptedPort({ usage: [400_000], poll: [{ kind: "success" }] });

      const { run, status, lines } = yield* ran({ compaction: port.ports, outputPollMs: 20 });

      expect(status).toBe("done");
      // Installed once, at the one launch: the second step reuses that agent.
      expect(port.installs).toHaveLength(1);
      // One boundary — before step two's work, not before step one's first work.
      expect(port.usageReads).toBe(1);
      expect(port.requests).toHaveLength(1);
      // Both front doors: the Run's own channel, which the CLI and the board read,
      // and its audit trail.
      expect(lines.join("\n")).toContain("asking it to compact before two");
      const log = yield* fs.readFileString(path.join(run.dir, "log.txt"));
      expect(log).toContain("native compaction");
    }),
  ));

test("below the threshold the work goes straight out, and nothing is asked to compact", () =>
  runEffect(
    Effect.gen(function* () {
      yield* rig.queueOutputs([{ verdict: "clean" }, { verdict: "clean" }]);
      const port = scriptedPort({ usage: [371_999] });

      const { status } = yield* ran({ compaction: port.ports, outputPollMs: 20 });

      expect(status).toBe("done");
      expect(port.usageReads).toBe(1);
      expect(port.requests).toEqual([]);
    }),
  ));

test("exactly at the threshold is at it, not under it", () =>
  runEffect(
    Effect.gen(function* () {
      yield* rig.queueOutputs([{ verdict: "clean" }, { verdict: "clean" }]);
      const port = scriptedPort({ usage: [372_000], poll: [{ kind: "success" }] });

      const { status } = yield* ran({ compaction: port.ports, outputPollMs: 20 });

      expect(status).toBe("done");
      expect(port.requests).toHaveLength(1);
    }),
  ));

test("a custom threshold is the one that applies", () =>
  runEffect(
    Effect.gen(function* () {
      yield* rig.queueOutputs([{ verdict: "clean" }, { verdict: "clean" }]);
      const port = scriptedPort({ usage: [50_000], poll: [{ kind: "success" }] });

      const { status } = yield* ran({
        compaction: port.ports,
        outputPollMs: 20,
        defaults: { compactAtTokens: 40_000 },
      });

      expect(status).toBe("done");
      expect(port.requests).toHaveLength(1);
    }),
  ));

test("compaction off installs no controls, reads nothing and asks for nothing", () =>
  runEffect(
    Effect.gen(function* () {
      yield* rig.queueOutputs([{ verdict: "clean" }, { verdict: "clean" }]);
      const port = scriptedPort({ usage: [900_000] });

      const { status } = yield* ran({
        compaction: port.ports,
        outputPollMs: 20,
        defaults: { compactAtTokens: 0 },
      });

      expect(status).toBe("done");
      expect(port.installs).toEqual([]);
      expect(port.usageReads).toBe(0);
      expect(port.requests).toEqual([]);
    }),
  ));

test.each([-1, 3.5, Number.POSITIVE_INFINITY, Number.NaN])(
  "an enabled threshold of %p fails the step rather than falling back to the default",
  (configured) =>
    runEffect(
      Effect.gen(function* () {
        yield* rig.queueOutputs([{ verdict: "clean" }, { verdict: "clean" }]);
        const port = scriptedPort({ usage: [900_000] });

        const { status, run } = yield* ran({
          compaction: port.ports,
          outputPollMs: 20,
          defaults: { compactAtTokens: configured },
        });

        expect(status).toBe("failed");
        expect(run.step("one").note).toContain("compact_at_tokens");
        // Refused before the launch, so nothing was installed on a threshold no Run
        // could have applied.
        expect(port.installs).toEqual([]);
      }),
    ),
);

test("a temporary telemetry failure warns, sends the work, and asks for no compaction", () =>
  runEffect(
    Effect.gen(function* () {
      yield* rig.queueOutputs([{ verdict: "clean" }, { verdict: "clean" }]);
      const port = scriptedPort({ usage: [new Error("the socket went away")] });

      const { status, lines } = yield* ran({ compaction: port.ports, outputPollMs: 20 });

      expect(status).toBe("done");
      expect(port.requests).toEqual([]);
      expect(lines.join("\n")).toContain("could not read its context usage");
    }),
  ));

test("an unavailable sample is not zero and not the last high one", () =>
  runEffect(
    Effect.gen(function* () {
      yield* rig.queueOutputs([{ verdict: "clean" }, { verdict: "clean" }]);
      const port = scriptedPort({ usage: [null] });

      const { status } = yield* ran({ compaction: port.ports, outputPollMs: 20 });

      expect(status).toBe("done");
      expect(port.requests).toEqual([]);
    }),
  ));

test("a confirmed compaction failure warns and the work still goes out", () =>
  runEffect(
    Effect.gen(function* () {
      yield* rig.queueOutputs([{ verdict: "clean" }, { verdict: "clean" }]);
      const port = scriptedPort({
        usage: [400_000],
        poll: [{ kind: "failure", reason: "the summary was too large to compact" }],
      });

      const { status, lines } = yield* ran({ compaction: port.ports, outputPollMs: 20 });

      expect(status).toBe("done");
      expect(port.requests).toHaveLength(1);
      expect(lines.join("\n")).toContain("too large to compact");
    }),
  ));

test("a request that never left warns and sends the work, with nothing in flight", () =>
  runEffect(
    Effect.gen(function* () {
      yield* rig.queueOutputs([{ verdict: "clean" }, { verdict: "clean" }]);
      // The channel refused the submission, so no compaction was started and there is
      // nothing to wait for: a temporary failure, which warns and continues.
      const port = scriptedPort({ usage: [400_000], request: "unsubmitted" });

      const { run, status, lines } = yield* ran({ compaction: port.ports, outputPollMs: 20 });

      expect(status).toBe("done");
      expect(lines.join("\n")).toContain("could not ask it to compact");
      const log = yield* (yield* FileSystem.FileSystem).readFileString(
        path.join(run.dir, "log.txt"),
      );
      expect(log).toContain("steps/two/prompt-1.md");
    }),
  ));

test("a request that broke after it may have left is unresolved, not a failure", () =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      yield* rig.queueOutputs([{ verdict: "clean" }, { verdict: "clean" }]);
      // The submission itself failed — a socket that closed, an HTTP call that timed
      // out — after the frame may already have been accepted. The harness may be
      // compacting right now, so this is the unknown outcome, not a confirmed failure.
      const port = scriptedPort({ usage: [400_000], request: "failed" });

      const { run, status, lines } = yield* ran({
        compaction: port.ports,
        outputPollMs: 20,
        compactionWaitMs: 120,
      });

      expect(status).toBe("blocked");
      expect(run.step("two").variants[0]?.error).toContain("neither completed nor failed");
      expect(lines.join("\n")).not.toContain("sending the work anyway");
      // No work went out, and the attempt stays on the agent's record.
      const log = yield* fs.readFileString(path.join(run.dir, "log.txt"));
      expect(log).not.toContain("steps/two/prompt-1.md");
      expect(log).toContain("may already have reached");
    }),
  ));

test("an acknowledged request that never resolves pauses the Run and sends no work", () =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      yield* rig.queueOutputs([{ verdict: "clean" }, { verdict: "clean" }]);
      // Nothing scripted for `poll`: the harness acknowledged and then said nothing,
      // which is the outcome nobody has established.
      const port = scriptedPort({ usage: [400_000] });

      const { run, status, lines } = yield* ran({
        compaction: port.ports,
        outputPollMs: 20,
        compactionWaitMs: 120,
      });

      expect(status).toBe("blocked");
      expect(run.step("two").status).toBe("blocked");
      expect(run.step("two").variants[0]?.error).toContain("neither completed nor failed");
      expect(lines.join("\n")).toContain("neither completed nor failed");
      // Asked once. A timeout is not a reason to ask again, nor to replay the work.
      expect(port.requests).toHaveLength(1);
      // The prompt file was written, but no prompt for step two ever went out.
      const log = yield* fs.readFileString(path.join(run.dir, "log.txt"));
      expect(log).not.toContain("prompt reuse-run-two");
      // herdr's front door: the toast a human gets when nobody is watching.
      const toasts = (yield* rig.calls()).filter((call) => call.cmd === "notification show");
      expect(toasts.map((call) => call.argv?.join(" ") ?? "").join("\n")).toContain(
        "neither completed nor failed",
      );
    }),
  ));

test("a second boundary on the same agent refuses while the first attempt is unresolved", () =>
  runEffect(
    Effect.gen(function* () {
      yield* rig.queueOutputs([{ verdict: "clean" }, { verdict: "clean" }]);
      const port = scriptedPort({ usage: [400_000] });
      const { run } = yield* ran({
        compaction: port.ports,
        outputPollMs: 20,
        compactionWaitMs: 120,
      });
      const agent = run.step("two").variants[0]!.agent;

      // Whoever reaches that agent next — this Run's own next boundary, another Run's
      // hand-off, a resumed Driver — reads the attempt Collie left in the air. What the
      // harness would report about the context now makes no difference to it.
      const again = scriptedPort({ usage: [1_000] });
      const boundary = yield* atBoundary(
        {
          ports: again.ports,
          stateDir: rig.pluginEnv().stateDir,
          configured: 372_000,
          herdr: { agentPrompt: () => Effect.void, agentList: () => Effect.succeed([]) },
          log: () => Effect.void,
          warn: () => Effect.void,
          waitMs: 60,
          pollMs: 20,
        },
        { agent, run: "another-run", step: "fix" },
      );

      expect(boundary.dispatch).toBe(false);
      expect(again.usageReads).toBe(0);
      expect(again.requests).toEqual([]);
    }),
  ));

test("an interactive caller asks and reports, rather than waiting out the budget", () =>
  runEffect(
    Effect.gen(function* () {
      yield* rig.queueOutputs([{ verdict: "clean" }, { verdict: "clean" }]);
      const port = scriptedPort({ usage: [400_000], poll: [{ kind: "success" }] });
      const { run } = yield* ran({ compaction: port.ports, outputPollMs: 20 });
      const agent = run.step("two").variants[0]!.agent;

      // The Control Plane runs its actions one at a time, so its hand-off asks for the
      // compaction and comes straight back rather than holding that queue for five
      // minutes. Nothing scripted for `poll`: the request is still in the air.
      const interactive = scriptedPort({ usage: [400_000] });
      const started = yield* Clock.currentTimeMillis;
      const boundary = yield* atBoundary(
        {
          ports: interactive.ports,
          stateDir: rig.pluginEnv().stateDir,
          configured: 372_000,
          herdr: { agentPrompt: () => Effect.void, agentList: () => Effect.succeed([]) },
          log: () => Effect.void,
          warn: () => Effect.void,
          waitMs: 0,
          pollMs: 20,
        },
        { agent, run: "control-plane", step: "hand-off to the implementer" },
      );

      expect(boundary.dispatch).toBe(false);
      expect(boundary.dispatch === false && boundary.reason).toContain("still in the air");
      // It asked — the compaction this agent needed is running — and it did not wait.
      expect(interactive.requests).toHaveLength(1);
      expect((yield* Clock.currentTimeMillis) - started).toBeLessThan(1_000);
    }),
  ));

test("a confirmed outcome clears the attempt, so the next boundary measures again", () =>
  runEffect(
    Effect.gen(function* () {
      yield* rig.queueOutputs([{ verdict: "clean" }, { verdict: "clean" }]);
      const port = scriptedPort({ usage: [400_000], poll: [{ kind: "success" }] });
      const { run } = yield* ran({ compaction: port.ports, outputPollMs: 20 });
      const agent = run.step("two").variants[0]!.agent;

      const again = scriptedPort({ usage: [1_000] });
      const boundary = yield* atBoundary(
        {
          ports: again.ports,
          stateDir: rig.pluginEnv().stateDir,
          configured: 372_000,
          herdr: { agentPrompt: () => Effect.void, agentList: () => Effect.succeed([]) },
          log: () => Effect.void,
          warn: () => Effect.void,
          waitMs: 60,
          pollMs: 20,
        },
        { agent, run: "another-run", step: "fix" },
      );

      expect(boundary.dispatch).toBe(true);
      expect(again.usageReads).toBe(1);
      expect(again.requests).toEqual([]);
    }),
  ));

test("a liveness nudge is not a work boundary, and does not compact", () =>
  runEffect(
    Effect.gen(function* () {
      yield* rig.queueOutputs([{ verdict: "clean" }, { verdict: "clean" }]);
      const port = scriptedPort({ usage: [400_000], poll: [{ kind: "success" }] });

      const { lines } = yield* ran({
        compaction: port.ports,
        outputPollMs: 10,
        // Quiet from the first poll on, so both steps are nudged twice and given up
        // on: the second step's agent takes three prompts it never asked for.
        env: { FAKE_HERDR_AGENT_STATUS: "working", FAKE_HERDR_PANE_TEXT: "stuck" },
        defaults: { quietMs: 300 },
      });

      expect(lines.join("\n")).toContain("nudged");
      // One boundary, and one request: the nudges in between are recovery messages
      // during a step, not work, and the threshold is not consulted for them.
      expect(port.usageReads).toBe(1);
      expect(port.requests).toHaveLength(1);
    }),
  ));

test("a harness Collie cannot manage stops the step instead of launching unmanaged", () =>
  runEffect(
    Effect.gen(function* () {
      yield* rig.queueOutputs([{ verdict: "clean" }, { verdict: "clean" }]);
      const port = scriptedPort({});
      const refusing: CompactionPorts = {
        claude: {
          ...port.ports.claude!,
          gate: () => Effect.fail(new Error("claude 1.0.0 is older than the 2.1.263 …")),
        },
      };

      const { run, status } = yield* ran({ compaction: refusing, outputPollMs: 20 });

      expect(status).toBe("failed");
      expect(run.step("one").note).toContain("older than the 2.1.263");
      // No pane, no agent, no controls: refused before the launch.
      expect(port.installs).toEqual([]);
      expect(run.step("one").variants).toEqual([]);
    }),
  ));

test("a reused agent's harness is not gated again — it launched under the gate", () =>
  runEffect(
    Effect.gen(function* () {
      yield* rig.queueOutputs([{ verdict: "clean" }, { verdict: "clean" }]);
      const gates: number[] = [];
      const port = scriptedPort({ usage: [1_000] });
      const counting: CompactionPorts = {
        claude: {
          ...port.ports.claude!,
          gate: () =>
            Effect.sync(() => {
              gates.push(1);
            }),
        },
      };

      const { status } = yield* ran({ compaction: counting, outputPollMs: 20 });

      expect(status).toBe("done");
      expect(gates).toHaveLength(1);
    }),
  ));

test("a recycled pid is not signalled, however stale the record that named it", () =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const stateDir = rig.pluginEnv().stateDir;
      // The endpoint this record named died long ago and the machine handed its pid to
      // something else — after a reboot, every recorded pid is somebody else's.
      const gone = yield* controlDir(stateDir, "recycled-r1");
      const innocent = Bun.spawn(["sleep", "120"], { stdout: "ignore", stderr: "ignore" });
      innocent.exited.catch(() => {});
      yield* fs.makeDirectory(gone, { recursive: true });
      yield* fs.writeFileString(
        path.join(gone, "control.json"),
        encodeControl({
          agent: "recycled-r1",
          harness: "codex",
          cwd: rig.projectDir,
          dir: gone,
          endpoint: "ws://127.0.0.1:1",
          pid: innocent.pid,
          command: "codex app-server",
          attempt: null,
        }),
      );

      yield* rig.queueOutputs([{ verdict: "clean" }, { verdict: "clean" }]);
      const port = scriptedPort({ usage: [1_000] });
      const { status } = yield* ran({ compaction: port.ports, outputPollMs: 20 });

      expect(status).toBe("done");
      // The controls go, because that agent is gone. The process stays, because it is
      // not the one they described.
      expect(yield* fs.exists(gone)).toBe(false);
      yield* Effect.sleep(200);
      expect(innocent.killed || innocent.exitCode !== null).toBe(false);
      innocent.kill();
    }),
  ));

test("a launch puts down the controls, and the endpoint, of an agent herdr has lost", () =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const stateDir = rig.pluginEnv().stateDir;
      // An agent from a Run that has long since ended, with a server still listening
      // on its behalf. It is not in `agent list`, so nothing will ever connect again.
      const gone = yield* controlDir(stateDir, "gone-r1");
      const listening = Bun.serve({ port: 0, fetch: () => new Response("ok") });
      const held = Bun.spawn(["sleep", "120"], { stdout: "ignore", stderr: "ignore" });
      held.exited.catch(() => {});
      yield* fs.makeDirectory(gone, { recursive: true });
      yield* fs.writeFileString(
        path.join(gone, "control.json"),
        encodeControl({
          agent: "gone-r1",
          harness: "codex",
          cwd: rig.projectDir,
          dir: gone,
          endpoint: `ws://127.0.0.1:${listening.port}`,
          pid: held.pid,
          command: "sleep",
          attempt: null,
        }),
      );

      yield* rig.queueOutputs([{ verdict: "clean" }, { verdict: "clean" }]);
      const port = scriptedPort({ usage: [1_000] });
      const { status } = yield* ran({ compaction: port.ports, outputPollMs: 20 });

      expect(status).toBe("done");
      expect(yield* fs.exists(gone)).toBe(false);
      // Nothing will connect to that endpoint again, so it is not left running.
      yield* Effect.sleep(200);
      expect(held.killed || held.exitCode !== null).toBe(true);
      void listening.stop(true);
    }),
  ));

test("the controls of an agent herdr still has are left where they are", () =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      yield* rig.queueOutputs([{ verdict: "clean" }, { verdict: "clean" }]);
      const port = scriptedPort({ usage: [1_000] });
      const { run, status } = yield* ran({ compaction: port.ports, outputPollMs: 20 });

      expect(status).toBe("done");
      const agent = run.step("one").variants[0]!.agent;
      expect(yield* fs.exists(yield* controlDir(rig.pluginEnv().stateDir, agent))).toBe(true);
    }),
  ));

/**
 * The same boundary, on each of the four harnesses. One case rather than four copies of
 * every case: the policy is shared, and what differs per harness is the interface
 * behind it, which each harness's own checks cover. This is what says the shared policy
 * really does apply to all four rather than to the one the other tests happen to use.
 */
test.each([
  ["claude", "opus"],
  ["codex", "gpt-5-codex"],
  ["opencode", "acme/local-model"],
  ["pi", "acme/local-model"],
])("a reused %s agent over the threshold compacts before its next work", (harness, model) =>
  runEffect(
    Effect.gen(function* () {
      yield* rig.queueOutputs([{ verdict: "clean" }, { verdict: "clean" }]);
      const port = scriptedPort({ harness, usage: [400_000], poll: [{ kind: "success" }] });

      const { status } = yield* ran({
        compaction: port.ports,
        outputPollMs: 20,
        defaults: { harness, model },
      });

      expect(status).toBe("done");
      expect(port.installs).toHaveLength(1);
      expect(port.usageReads).toBe(1);
      expect(port.requests).toHaveLength(1);
    }),
  ),
);

test.each([
  ["claude", "opus"],
  ["codex", "gpt-5-codex"],
  ["opencode", "acme/local-model"],
  ["pi", "acme/local-model"],
])("a %s agent its own compaction already shrank is left alone", (harness, model) =>
  runEffect(
    Effect.gen(function* () {
      yield* rig.queueOutputs([{ verdict: "clean" }, { verdict: "clean" }]);
      // The harness hit its own window and compacted before Collie's threshold, so the
      // sample at the boundary is small. Native automatic compaction is left enabled
      // everywhere, and this is what it looks like from here: nothing to do.
      const port = scriptedPort({ harness, usage: [4_000] });

      const { status } = yield* ran({
        compaction: port.ports,
        outputPollMs: 20,
        defaults: { harness, model },
      });

      expect(status).toBe("done");
      expect(port.requests).toEqual([]);
    }),
  ),
);

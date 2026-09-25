// What a workflow does with a coding agent: one launch, one collection, one repair.
//
// The agents here are herdr's own, through the one sender and the real dispatcher ledger —
// only the harness at the far end is a stand-in, and it answers by writing the file the
// prompt names. So what these tests exercise is the production path: a tab, an agent
// started in it, a prompt that carries its contract, and an Output decoded before any of
// it is believed.
//
// The engine is Effect's cluster engine over real SQLite in a directory, so a restart is a
// second engine on the same file rather than a second map.

import { afterEach, beforeEach, expect, test } from "bun:test";
import { Duration, Effect, FileSystem, Layer, Schema } from "effect";
import * as WorkflowEngine from "effect/unstable/workflow/WorkflowEngine";
import { Rig, FakeHerdr, type Call } from "./support/recorder";
import { runEffect } from "./support/effect";
import { onMachineWith } from "./support/live";
import {
  Agents,
  agentWork,
  agentsLayer,
  decodeOutput,
  promptFor,
  type AgentHost,
} from "../src/agents";
import { Children, Run, jsonSchemaFor, withAgents } from "../src/sdk";
import { asRun, enveloped } from "./support/enveloped";
import { PARKED, controlPath, foundationLayer, loadEntry, pollStatus } from "../src/engine";
import { appendLine, deliveriesOf, readLedger, reconcile } from "../src/steering";
import { Store } from "../src/store";
import { readTask, writeTask } from "../src/task";
import { taskFor } from "../src/operations";
import { readRegistry, registerAgent, registryPath, scopeFor } from "../src/registry";
import { HerdrError } from "../src/herdr";
import { agentName, shellQuote } from "../src/naming";
import type { CompactionPorts } from "../src/compaction";

let rig: Rig;
let dir: string;

beforeEach(() =>
  runEffect(
    Effect.gen(function* () {
      rig = yield* Rig.make();
      const fs = yield* FileSystem.FileSystem;
      dir = `${rig.root}/host`;
      yield* fs.makeDirectory(dir, { recursive: true });
      yield* fs.makeDirectory(rig.projectDir, { recursive: true });
    }),
  ),
);

afterEach(() => runEffect(rig.close()));

/** What the agent is asked for: two fields, one of them a judgment with words about it. */
const Verdict = Schema.Struct({
  verdict: Schema.Literals(["clean", "findings"]).annotate({
    description: "clean only when there is nothing left for the implementer",
  }),
  note: Schema.String.annotate({ description: "one sentence a human reads" }),
});

const work = enveloped({
  name: "agent-work",
  input: { skip: Schema.Boolean },
  success: Verdict,
});

const SKIPPED = { verdict: "clean", note: "nothing to review" } as const;

const body = work.toLayer((payload) =>
  Effect.gen(function* () {
    // Eligibility first, and before anything expensive: skipped work opens no tab.
    if (payload.input.skip) return SKIPPED;
    return yield* agentWork({
      operation: "review",
      role: "reviewer",
      workflow: "agent-work",
      cwd: rig.projectDir,
      instructions: "Review {{inputs.target}} as the {{role}}.",
      inputs: { target: "the diff" },
      output: Verdict,
    });
  }).pipe(asRun(payload)),
);

const hostOf = (): AgentHost => ({
  dir,
  env: rig.pluginEnv(),
  herdr: new FakeHerdr(rig.pluginEnv()),
  harness: "claude",
  model: "opus",
  permissions: "bypass",
  compactAtTokens: 0,
  pollMs: 20,
  collectMs: 400,
});

/** One host's lifetime: a fresh engine on the same directory is what a restart is. */
const session = <A, E>(
  run: Effect.Effect<A, E, WorkflowEngine.WorkflowEngine | Agents>,
  over?: Partial<AgentHost>,
) =>
  run.pipe(
    Effect.provide(body),
    Effect.provide(agentsLayer({ ...hostOf(), ...over })),
    Effect.provide(foundationLayer({ dir })),
    Effect.scoped,
    Effect.orDie,
  );

const started = (runId: string, skip = false) =>
  work.execute({ runId, input: { skip } }).pipe(Effect.result);

const agentFor = (runId: string) => agentName(runId, "review", null, 1);

/**
 * A parked Run picked up again, as a host's control does it: the execution is resumed and
 * then waited on. Nothing re-enters a suspended workflow on its own.
 */
const releasedInto = (runId: string) =>
  session(
    Effect.gen(function* () {
      const engine = yield* WorkflowEngine.WorkflowEngine;
      const payload = { runId, input: { skip: false } };
      yield* engine.resume(work, yield* work.executionId(payload));
      return yield* work.execute(payload).pipe(Effect.result);
    }),
  );

const outputPath = (runId: string) => `${dir}/agents/${runId}/review.json`;
const promptPath = (runId: string) => `${dir}/agents/${runId}/review.prompt.md`;

const read = (path: string) =>
  FileSystem.FileSystem.pipe(
    Effect.flatMap((fs) => fs.readFileString(path)),
    Effect.orElseSucceed(() => ""),
  );

const sent = (calls: ReadonlyArray<Call>, about: string) =>
  calls.filter((call) => {
    const argv = call.argv ?? [];
    return argv[0] === "agent" && argv[1] === "prompt" && (argv[3] ?? "").includes(about);
  }).length;

test("the contract an agent is held to is in the prompt it is sent, with the judgment asked for", () => {
  const prompt = promptFor({
    role: "reviewer",
    instructions: "Review {{inputs.target}} as the {{role}}.",
    inputs: { target: "the diff" },
    output: "/state/agents/r1/review.json",
    contract: jsonSchemaFor(Verdict),
  });
  expect(prompt).toContain("Review the diff as the reviewer.");
  expect(prompt).toContain("OUTPUT_PATH: /state/agents/r1/review.json");
  // The author's own words about the field, carried through rather than summarised away.
  expect(prompt).toContain("clean only when there is nothing left for the implementer");
  expect(prompt).toContain("one sentence a human reads");
  expect(prompt).toContain("it is asking for your judgment");
});

test("what a schema cannot be drawn from is still checked, and the prompt says so", () => {
  const opaque = Schema.declare(Schema.is(Schema.String));
  const prompt = promptFor({
    role: "reviewer",
    instructions: "Answer.",
    output: "/state/o.json",
    contract: jsonSchemaFor(Schema.Struct({ answer: opaque })),
  });
  expect(prompt).toContain("The drawing says less than the contract does at");
  expect(prompt).toContain("Those are still checked.");
});

test("an Output is decoded, and every issue with it is named at once", () => {
  const good = decodeOutput(Verdict, `{"verdict":"clean","note":"nothing"}`);
  expect(good.ok && good.value).toEqual({ verdict: "clean", note: "nothing" });

  const bad = decodeOutput(Verdict, `{"verdict":"maybe"}`);
  expect(bad.ok).toBe(false);
  // Both, not the first: a repair spent one issue at a time is a repair spent on arithmetic.
  expect(!bad.ok && bad.problem).toContain(`["verdict"]`);
  expect(!bad.ok && bad.problem).toContain(`["note"]`);

  const notJson = decodeOutput(Verdict, "I had a look and it seems fine");
  expect(!notJson.ok && notJson.problem).toContain("it is not JSON");
});

test("a valid Output reaches the workflow as a typed value, from a real launch", () =>
  runEffect(
    Effect.gen(function* () {
      yield* rig.queueOutputs([{ verdict: "findings", note: "two things" }]);
      const result = yield* session(started("r1"));
      expect(result._tag === "Success" && result.success).toEqual({
        verdict: "findings",
        note: "two things",
      });

      const cmds = yield* rig.cmds();
      expect(cmds.filter((cmd) => cmd === "agent start")).toHaveLength(1);
      expect(cmds.filter((cmd) => cmd === "tab create")).toHaveLength(1);
      // The prompt as it went out and the Output as it came back, both on disk.
      expect(yield* read(promptPath("r1"))).toContain("OUTPUT_PATH: ");
      expect(yield* read(outputPath("r1"))).toContain("two things");
    }),
  ));

/** Work asked for the way a definition asks: inside a Run, naming only what it wants. */
const worded = enveloped({ name: "agent-words", input: {}, success: Schema.String });
const wordedBody = worded.toLayer(
  Effect.fnUntraced(function* (payload) {
    return yield* agentWork({ operation: "summary", instructions: "Say what changed." }).pipe(
      Effect.provideService(Run, Run.of({ id: payload.runId, workflow: "agent-words" })),
    );
  }),
);

test("work asked for inside a Run needs no run id, checkout or contract, and answers in words", () =>
  runEffect(
    Effect.gen(function* () {
      yield* rig.queueOutputs(["It renames the flag."]);
      const said = yield* worded
        .execute({ runId: "r1", input: {} })
        .pipe(
          Effect.provide(wordedBody),
          Effect.provide(agentsLayer(hostOf())),
          Effect.provide(foundationLayer({ dir })),
          Effect.scoped,
          Effect.orDie,
        );
      expect(said).toBe("It renames the flag.");
      const prompt = yield* read(`${dir}/agents/r1/summary.prompt.md`);
      expect(prompt).toContain("as plain text");
      expect(prompt).not.toContain("```json");
      // Where the host placed the Run: nothing admitted this one, so its own directory.
      const moved = (yield* rig.calls()).filter(
        (call) => call.argv?.[0] === "pane" && call.argv[1] === "run",
      );
      expect(moved.map((call) => call.argv?.at(-1))).toContain(`cd ${shellQuote(dir)}`);
    }),
  ));

test("an Output the schema refuses buys one repair, and the rewritten one is the answer", () =>
  runEffect(
    Effect.gen(function* () {
      yield* rig.queueOutputs([{ verdict: "maybe" }, { verdict: "clean", note: "fixed" }]);
      const result = yield* session(started("r1"));
      expect(result._tag === "Success" && result.success).toEqual({
        verdict: "clean",
        note: "fixed",
      });
      const calls = yield* rig.calls();
      // One agent, asked twice: the repair goes to the agent still holding the work.
      expect((yield* rig.cmds()).filter((cmd) => cmd === "agent start")).toHaveLength(1);
      expect(sent(calls, "not usable")).toBe(1);
    }),
  ));

test("a second unusable Output is the end of it, and the failure names what was wrong", () =>
  runEffect(
    Effect.gen(function* () {
      yield* rig.queueOutputs([{ verdict: "maybe" }, { verdict: "still maybe" }]);
      const result = yield* session(started("r1"));
      expect(result._tag).toBe("Failure");
      const reason = result._tag === "Failure" ? result.failure.reason : "";
      expect(reason).toContain("output-unusable");
      expect(reason).toContain(agentFor("r1"));
      expect(reason).toContain(`["note"]`);
      // Exactly one: the allowance is one repair, not one per issue.
      expect(sent(yield* rig.calls(), "not usable")).toBe(1);
    }),
  ));

test("an agent that is already there is reattached to rather than started a second time", () =>
  runEffect(
    Effect.gen(function* () {
      yield* rig.addAgent(agentFor("r1"), "1-9");
      yield* rig.queueOutputs([{ verdict: "clean", note: "reused" }]);
      const result = yield* session(started("r1"));
      expect(result._tag === "Success" && result.success.note).toBe("reused");
      expect((yield* rig.cmds()).filter((cmd) => cmd === "agent start")).toHaveLength(0);
    }),
  ));

test("work the workflow skips opens no tab and starts no agent", () =>
  runEffect(
    Effect.gen(function* () {
      const result = yield* session(started("r1", true));
      expect(result._tag === "Success" && result.success).toEqual(SKIPPED);
      const cmds = yield* rig.cmds();
      expect(cmds.filter((cmd) => cmd === "tab create" || cmd === "agent start")).toEqual([]);
    }),
  ));

/**
 * A host that goes while a collection is still out. The work is submitted rather than
 * awaited, so closing the session leaves the engine's journal with a launch in it and no
 * result — which is the window a replay must not fill with a second agent.
 */
const interrupted = (runId: string, waitMs: number, over?: Partial<AgentHost>) =>
  session(
    work
      .execute({ runId, input: { skip: false } }, { discard: true })
      .pipe(Effect.andThen(Effect.sleep(Duration.millis(waitMs)))),
    { collectMs: 30_000, ...over },
  );

test(
  "a restart while the wait is out reattaches rather than launching a second agent",
  () =>
    runEffect(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        // Nothing written for the first prompt, so the collection is still out.
        yield* rig.queueOutputs([null]);
        yield* interrupted("r1", 600);
        expect((yield* rig.cmds()).filter((cmd) => cmd === "agent start")).toHaveLength(1);

        // A second engine on the same SQLite file picks the work up where it was.
        yield* fs.writeFileString(outputPath("r1"), `{"verdict":"clean","note":"late"}`);
        const result = yield* session(started("r1"));

        expect(result._tag === "Success" && result.success.note).toBe("late");
        // The launch came back off the journal; nothing started a second agent for it.
        expect((yield* rig.cmds()).filter((cmd) => cmd === "agent start")).toHaveLength(1);
      }),
    ),
  120_000,
);

test(
  "a restart between the attempts hands out no second repair",
  () =>
    runEffect(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        // The first Output is unusable and nothing answers the repair, so the host goes
        // with the repair's own collection still out.
        yield* rig.queueOutputs([{ verdict: "maybe" }, null]);
        yield* interrupted("r1", 1200);
        expect(sent(yield* rig.calls(), "not usable")).toBe(1);

        yield* fs.writeFileString(outputPath("r1"), `{"verdict":"clean","note":"eventually"}`);
        const result = yield* session(started("r1"));

        expect(result._tag === "Success" && result.success.note).toBe("eventually");
        // Still one: the repair is a recorded step of the work rather than an allowance a
        // restart gives back, and the ledger refuses a second copy of a delivery about it.
        expect(sent(yield* rig.calls(), "not usable")).toBe(1);
        expect((yield* rig.cmds()).filter((cmd) => cmd === "agent start")).toHaveLength(1);
      }),
    ),
  120_000,
);

/** herdr refusing prompts because the pane has a dialog up: the first `times`, or every one. */
const busyPane = (times = 0) =>
  new FakeHerdr(
    rig.pluginEnv({
      FAKE_HERDR_PROMPT_ERROR: "agent_blocked",
      FAKE_HERDR_PROMPT_ERROR_TIMES: String(times),
    }),
  );

const statusNow = (runId: string) =>
  session(
    Effect.gen(function* () {
      const engine = yield* WorkflowEngine.WorkflowEngine;
      const id = yield* work.executionId({ runId, input: { skip: false } });
      return pollStatus(yield* engine.poll(work, id), "agent-work").status;
    }),
  );

const steps = (runId: string) =>
  deliveriesOf(hostOf().env.stateDir, runId).pipe(
    Effect.map((found) => found.filter((one) => one.delivery.cause.kind === "step")),
  );

test("a pane that is busy when the step's prompt goes out is waited out, and the work is one prompt", () =>
  runEffect(
    Effect.gen(function* () {
      yield* rig.queueOutputs([{ verdict: "clean", note: "after the dialog" }]);
      const result = yield* session(started("r1"), {
        herdr: busyPane(2),
        patience: { firstMs: 10, maxMs: 20, forMs: 30_000 },
      });

      expect(result._tag === "Success" && result.success.note).toBe("after the dialog");
      // Two refused and one taken, all of them one delivery.
      expect(sent(yield* rig.calls(), "Your task for this step")).toBe(3);
      expect((yield* steps("r1")).map((one) => one.delivery.state)).toEqual(["submitted"]);
      expect((yield* rig.cmds()).filter((cmd) => cmd === "agent start")).toHaveLength(1);
    }),
  ));

test(
  "a pane that stays busy parks the step beside its agent, and a resume hands that agent its prompt",
  () =>
    runEffect(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        yield* rig.queueOutputs([{ verdict: "clean", note: "resumed" }]);
        yield* interrupted("r1", 1_500, {
          herdr: busyPane(),
          patience: { firstMs: 10, maxMs: 20, forMs: 100 },
        });

        // Parked rather than failed: nothing about the work is lost, and nothing is uncertain.
        expect(yield* statusNow("r1")).toBe("suspended");
        const why = yield* read(controlPath(dir, PARKED, "r1"));
        expect(why).toMatch(/agent_blocked held for \d+s over \d+ attempts/);
        expect(why).toContain(promptPath("r1"));
        expect(why).toContain("collie run resume r1");
        expect((yield* steps("r1")).map((one) => one.delivery.state)).toEqual(["failed"]);

        // The dialog has gone. The same agent is given the same prompt, and nothing new starts.
        const result = yield* releasedInto("r1");
        expect(result._tag === "Success" && result.success.note).toBe("resumed");
        expect((yield* rig.cmds()).filter((cmd) => cmd === "agent start")).toHaveLength(1);
        expect((yield* steps("r1")).map((one) => one.delivery.state)).toEqual(["submitted"]);
        expect(yield* fs.exists(controlPath(dir, PARKED, "r1"))).toBe(false);
      }),
    ),
  120_000,
);

/** The `--` arguments the agent was started with, as the launch passed them to herdr. */
const launchArgs = (calls: ReadonlyArray<Call>) => {
  const argv = calls.find((call) => (call.argv ?? [])[1] === "start")?.argv ?? [];
  const at = argv.indexOf("--");
  return at === -1 ? [] : argv.slice(at + 1);
};

test("the agent is started on the operator's harness, model and permissions, with the role as its persona", () =>
  runEffect(
    Effect.gen(function* () {
      yield* rig.queueOutputs([{ verdict: "clean", note: "done" }]);
      yield* session(started("r1"));

      const args = launchArgs(yield* rig.calls());
      expect(args.slice(0, 2)).toEqual(["--model", "opus"]);
      expect(args).toContain("--permission-mode");
      const persona = args[args.indexOf("--append-system-prompt-file") + 1] ?? "";
      expect(yield* read(persona)).toContain("You are the reviewer.");
    }),
  ));

/** Every agent's `--` arguments, in the order the agents were started. */
const everyLaunch = (calls: ReadonlyArray<Call>) =>
  calls
    .filter((call) => (call.argv ?? [])[1] === "start")
    .map((call) => (call.argv ?? []).slice((call.argv ?? []).indexOf("--") + 1));

/** Two pieces of work under one scope of preferences, the second with a model of its own. */
const scoped = enveloped({ name: "agent-scoped", input: {}, success: Schema.String });
const scopedBody = scoped.toLayer(
  Effect.fnUntraced(function* (payload) {
    const both = Effect.all([
      agentWork({ operation: "first", instructions: "One." }),
      agentWork({ operation: "second", instructions: "Two.", model: "haiku" }),
    ]);
    const [first, second] = yield* both.pipe(
      withAgents({ model: "sonnet" }),
      Effect.provideService(Run, Run.of({ id: payload.runId, workflow: "agent-scoped" })),
    );
    return `${first}+${second}`;
  }),
);

test("preferences in scope reach the work inside it, and the work's own still win", () =>
  runEffect(
    Effect.gen(function* () {
      yield* rig.queueOutputs(["one", "two"]);
      const said = yield* scoped
        .execute({ runId: "r1", input: {} })
        .pipe(
          Effect.provide(scopedBody),
          Effect.provide(agentsLayer(hostOf())),
          Effect.provide(foundationLayer({ dir })),
          Effect.scoped,
          Effect.orDie,
        );
      expect(said).toBe("one+two");
      expect(everyLaunch(yield* rig.calls()).map((args) => args.slice(0, 2))).toEqual([
        ["--model", "sonnet"],
        ["--model", "haiku"],
      ]);
    }),
  ));

test(
  "the agent chosen for a piece of work is the one it comes back to, whatever is configured now",
  () =>
    runEffect(
      Effect.gen(function* () {
        yield* rig.queueOutputs([null, { verdict: "clean", note: "back" }]);
        yield* interrupted("r1", 600);
        yield* session(halted("r1"));

        // The operator changes the model between the two hosts; the work already has one.
        const result = yield* session(started("r1"), { model: "sonnet" });
        expect(result._tag === "Success" && result.success.note).toBe("back");
        expect(everyLaunch(yield* rig.calls()).map((args) => args.slice(0, 2))).toEqual([
          ["--model", "opus"],
          ["--model", "opus"],
        ]);
      }),
    ),
  120_000,
);

/** One agent handed two pieces of work, the second asking for another model. */
const shared = enveloped({ name: "agent-shared", input: {}, success: Schema.String });
const sharedBody = shared.toLayer(
  Effect.fnUntraced(function* (payload) {
    const run = Run.of({ id: payload.runId, workflow: "agent-shared" });
    const build = agentWork({ operation: "build", agent: "implementer", instructions: "Build." });
    const fix = agentWork({
      operation: "fix",
      agent: "implementer",
      instructions: "Fix.",
      model: "sonnet",
    });
    return yield* Effect.all([build, fix]).pipe(
      Effect.map((both) => both.join("+")),
      Effect.provideService(Run, run),
    );
  }),
);

test("an agent is not handed work that asks for a different one than it is", () =>
  runEffect(
    Effect.gen(function* () {
      yield* rig.queueOutputs(["built", "fixed"]);
      const result = yield* shared
        .execute({ runId: "r1", input: {} })
        .pipe(
          Effect.result,
          Effect.provide(sharedBody),
          Effect.provide(agentsLayer(hostOf())),
          Effect.provide(foundationLayer({ dir })),
          Effect.scoped,
          Effect.orDie,
        );
      expect(result._tag).toBe("Failure");
      const reason = result._tag === "Failure" ? result.failure.reason : "";
      expect(reason).toContain("claude/opus");
      expect(reason).toContain("claude/sonnet");
      expect(everyLaunch(yield* rig.calls())).toHaveLength(1);
    }),
  ));

test("a definition's own preference sits under a scope's, and parallel scopes keep their own", () =>
  runEffect(
    Effect.gen(function* () {
      yield* rig.queueOutputs(["one", "two", "three"]);
      const entry = yield* loadEntry(
        new URL("fixtures/workflows/prefers.workflow.ts", import.meta.url).pathname,
      ).pipe(Effect.orDie);
      const { workflow, layer } = entry.make("prefers@1");
      const none = Effect.die("this workflow starts no child");
      yield* workflow
        .execute({ runId: "r1", input: {} })
        .pipe(
          Effect.provide(layer),
          Effect.provide(
            Layer.succeed(Children)(Children.of({ start: () => none, result: () => none })),
          ),
          Effect.provide(agentsLayer(hostOf())),
          Effect.provide(foundationLayer({ dir })),
          Effect.scoped,
          Effect.orDie,
        );
      const models = everyLaunch(yield* rig.calls()).map((args) => args[1]);
      expect([...models].sort()).toEqual(["haiku", "opus", "sonnet"]);
    }),
  ));

onMachineWith("claude")(
  "compaction controls are installed into the launch, as they are for a Step",
  () =>
    runEffect(
      Effect.gen(function* () {
        yield* rig.queueOutputs([{ verdict: "clean", note: "done" }]);
        yield* session(started("r1"), { compactAtTokens: 300_000 });
        // Extra arguments to the same launch, so the agent keeps its ordinary interface.
        expect(launchArgs(yield* rig.calls()).length).toBeGreaterThan(5);
      }),
    ),
  60_000,
);

test("a herdr that cannot say what it has blocks the work rather than starting an agent", () =>
  runEffect(
    Effect.gen(function* () {
      const result = yield* session(started("r1"), {
        herdr: new FakeHerdr(
          rig.pluginEnv({ FAKE_HERDR_FAIL: `{"agent list":"herdr is not answering"}` }),
        ),
      });
      expect(result._tag).toBe("Failure");
      const reason = result._tag === "Failure" ? result.failure.reason : "";
      expect(reason).toContain("herdr cannot say which agents it has");
      // What uncertainty must never be rounded down to.
      expect(reason).toContain("Nothing here says the agent did no work.");
      expect((yield* rig.cmds()).filter((cmd) => cmd === "agent start")).toHaveLength(0);
    }),
  ));

const halted = (runId: string) => Agents.pipe(Effect.flatMap((agents) => agents.halt(runId)));

test("a stop closes the agent this Run launched, and says what it could not close", () =>
  runEffect(
    Effect.gen(function* () {
      yield* rig.queueOutputs([{ verdict: "clean", note: "done" }]);
      yield* session(started("r1"));
      const refused = yield* session(halted("r1"), {
        herdr: new FakeHerdr(rig.pluginEnv({ FAKE_HERDR_FAIL: `{"pane close":"pane is busy"}` })),
      });
      expect(refused.stopped).toEqual([]);
      expect(refused.left.join("\n")).toContain(agentFor("r1"));
      expect(yield* session(halted("r1"))).toEqual({ stopped: [agentFor("r1")], left: [] });
    }),
  ));

test("a stop leaves another process that took the Run's agent name", () =>
  runEffect(
    Effect.gen(function* () {
      yield* rig.queueOutputs([{ verdict: "clean", note: "done" }]);
      yield* session(started("r1"));
      yield* rig.reincarnate(agentFor("r1"));
      expect(yield* session(halted("r1"))).toEqual({ stopped: [], left: [] });
      expect(yield* rig.cmds()).not.toContain("pane close");
    }),
  ));

test("a stop of a Run that launched no agent needs nothing from herdr", () =>
  runEffect(
    Effect.gen(function* () {
      const halt = yield* session(halted("r1"), {
        herdr: new FakeHerdr(
          rig.pluginEnv({ FAKE_HERDR_FAIL: `{"agent list":"herdr is not answering"}` }),
        ),
      });
      expect(halt).toEqual({ stopped: [], left: [] });
      expect(yield* rig.cmds()).not.toContain("agent list");
    }),
  ));

/** Another Run's implementer, live in this checkout and registered as it. */
const liveImplementer = Effect.gen(function* () {
  yield* rig.addAgent("impl-live", "9-1");
  const env = rig.pluginEnv();
  yield* registerAgent(yield* registryPath(env.stateDir, scopeFor(env, rig.projectDir)), {
    role: "implementer",
    agent: "impl-live",
    paneId: "9-1",
    workspaceId: null,
    runId: "r-building",
    workflow: "implement",
    at: "2026-09-23T10:00:00Z",
    incarnation: { terminalId: "term-impl-live", agentSession: null },
  });
});

/** A herdr that takes a prompt and never answers, so nobody can say it arrived. */
class SilentPrompts extends FakeHerdr {
  override agentPrompt() {
    return Effect.fail(new HerdrError({ message: "herdr went away mid-prompt", detail: "" }));
  }
}

const handedOff = Agents.pipe(
  Effect.flatMap((agents) =>
    agents.handOff({
      runId: "r-review",
      role: "implementer",
      cwd: rig.projectDir,
      text: "the review is ready",
    }),
  ),
  Effect.result,
);

test("a hand-off nobody can say arrived parks until a human says what became of it", () =>
  runEffect(
    Effect.gen(function* () {
      yield* liveImplementer;
      const first = yield* session(handedOff, { herdr: new SilentPrompts(rig.pluginEnv()) });
      expect(first._tag === "Failure" && first.failure._tag).toBe("AgentParked");
      const again = yield* session(handedOff);
      expect(again._tag === "Failure" && again.failure.reason).toContain(
        "collie run deliveries r-building",
      );
      expect(sent(yield* rig.calls(), "the review is ready")).toBe(0);

      const [held] = yield* deliveriesOf(rig.pluginEnv().stateDir, "r-building");
      const settled = reconcile(
        yield* readLedger(held!.file),
        held!.delivery.id,
        "sent",
        "tester",
        "2026-09-23T10:01:00Z",
      );
      if ("error" in settled) throw new Error(settled.error);
      yield* appendLine(held!.file, settled);
      const after = yield* session(handedOff);
      expect(after._tag === "Success" && after.success).toMatchObject({
        agent: "impl-live",
        delivered: true,
      });
      expect(sent(yield* rig.calls(), "the review is ready")).toBe(0);
    }),
  ));

/** The controls an operator sets, as the host keeps them beside the run. */
const control = (name: string, runId: string, set: boolean) =>
  FileSystem.FileSystem.pipe(
    Effect.flatMap((fs) => {
      const path = controlPath(dir, name, runId);
      return set ? fs.writeFileString(path, "") : fs.remove(path).pipe(Effect.ignore);
    }),
    Effect.orDie,
  );

/** What was typed into an agent's pane, in the order herdr was asked to type it. */
const prompts = (calls: ReadonlyArray<Call>) =>
  calls
    .filter((call) => (call.argv ?? [])[0] === "agent" && (call.argv ?? [])[1] === "prompt")
    .map((call) => (call.argv ?? [])[3] ?? "");

/** One thing an operator says to the run's agent, through the host's own service. */
const say = (runId: string, text: string, request: string, mode?: "boundary" | "now") =>
  Agents.pipe(Effect.flatMap((agents) => agents.steer({ runId, text, request, mode })));

test("what a human says reaches the run's agent through the one sender, in the order they said it", () =>
  runEffect(
    Effect.gen(function* () {
      yield* rig.queueOutputs([{ verdict: "clean", note: "done" }]);
      yield* session(started("r1"));

      const told = yield* session(
        Effect.all([
          say("r1", "first thing", "steer-1"),
          say("r1", "second thing", "steer-2"),
          say("r1", "third thing", "steer-3"),
        ]),
      );
      expect(told.map((one) => one.agent)).toEqual([
        agentFor("r1"),
        agentFor("r1"),
        agentFor("r1"),
      ]);
      expect(told.every((one) => one.delivered)).toBe(true);

      // Said once each and in order: the dispatcher is the only sender and it holds one
      // agent's ledger while it sends.
      const said = prompts(yield* rig.calls()).filter((text) => text.endsWith(" thing"));
      expect(said).toEqual(["first thing", "second thing", "third thing"]);
    }),
  ));

test("the same thing said twice under one claim is one delivery, not two", () =>
  runEffect(
    Effect.gen(function* () {
      yield* rig.queueOutputs([{ verdict: "clean", note: "done" }]);
      yield* session(started("r1"));
      yield* session(
        Effect.all([say("r1", "again", "steer-1"), say("r1", "again", "steer-1")], {
          concurrency: 1,
        }),
      );
      expect(prompts(yield* rig.calls()).filter((text) => text === "again")).toHaveLength(1);
    }),
  ));

test("a message nobody can say arrived is not called delivered when it is said again", () =>
  runEffect(
    Effect.gen(function* () {
      yield* rig.queueOutputs([{ verdict: "clean", note: "done" }]);
      yield* session(started("r1"));
      const first = yield* session(say("r1", "stay in src", "steer-1"), {
        herdr: new SilentPrompts(rig.pluginEnv()),
      });
      expect(first.delivered).toBe(false);
      const again = yield* session(say("r1", "stay in src", "steer-1"));
      expect(again.delivered).toBe(false);
      expect(again.detail).toContain("is unknown");
    }),
  ));

test("a delivery this harness has not been shown to take is refused rather than sent and hoped for", () =>
  runEffect(
    Effect.gen(function* () {
      yield* rig.queueOutputs([{ verdict: "clean", note: "done" }]);
      const codex = { harness: "codex", model: "default" };
      yield* session(started("r1"), codex);
      const told = yield* session(say("r1", "stop what you are doing", "steer-now", "now"), codex);
      expect(told.delivered).toBe(false);
      expect(told.detail).toContain("capability_unproven");
      // Nothing was typed at it: the gate is in the sender, not in front of it.
      expect(prompts(yield* rig.calls())).not.toContain("stop what you are doing");
    }),
  ));

test("a run that has launched no agent is told so rather than told its message landed", () =>
  runEffect(
    Effect.gen(function* () {
      const told = yield* session(say("r-nothing", "hello", "steer-1"));
      expect(told).toMatchObject({ agent: "", delivered: false });
      expect(told.detail).toContain("has launched no agent");
    }),
  ));

test(
  "a held run parks before it starts an agent, and carries on once it is released",
  () =>
    runEffect(
      Effect.gen(function* () {
        yield* control("hold", "r1", true);
        yield* rig.queueOutputs([{ verdict: "clean", note: "after the hold" }]);
        // Submitted rather than awaited: held work parks, so there is nothing to wait for.
        yield* interrupted("r1", 400);
        expect((yield* rig.cmds()).filter((cmd) => cmd === "agent start")).toHaveLength(0);

        yield* control("hold", "r1", false);
        const result = yield* releasedInto("r1");
        expect(result._tag === "Success" && result.success.note).toBe("after the hold");
        expect((yield* rig.cmds()).filter((cmd) => cmd === "agent start")).toHaveLength(1);
      }),
    ),
  120_000,
);

test(
  "a stop while the collection is out parks the wait, and what comes back reattaches to the launch",
  () =>
    runEffect(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        // Nothing written, so the collection is still out when the stop arrives.
        yield* rig.queueOutputs([null]);
        yield* control("stop", "r1", true);
        yield* interrupted("r1", 900);
        // The agent was launched and is still holding the work: stopping a Run is not
        // halting its agent, which is its own action.
        expect((yield* rig.cmds()).filter((cmd) => cmd === "agent start")).toHaveLength(1);

        yield* control("stop", "r1", false);
        yield* fs.writeFileString(outputPath("r1"), `{"verdict":"clean","note":"resumed"}`);
        const result = yield* releasedInto("r1");
        expect(result._tag === "Success" && result.success.note).toBe("resumed");
        // One launch across the stop: the wait came back to the agent that was recorded.
        expect((yield* rig.cmds()).filter((cmd) => cmd === "agent start")).toHaveLength(1);
      }),
    ),
  120_000,
);

/** An operator stopping the Run as its repair goes out. */
class StopsAtRepair extends FakeHerdr {
  override agentPrompt(target: string, text: string) {
    const stop = text.includes("not usable") ? control("stop", "r1", true) : Effect.void;
    return stop.pipe(Effect.andThen(super.agentPrompt(target, text)));
  }
}

test(
  "a stop while the repair is awaited parks the wait, and the resume starts the halted agent again",
  () =>
    runEffect(
      Effect.gen(function* () {
        yield* rig.queueOutputs([{ verdict: "maybe" }, null, { verdict: "clean", note: "again" }]);
        yield* interrupted("r1", 1500, {
          herdr: new StopsAtRepair(rig.pluginEnv()),
          collectMs: 900,
        });
        expect(sent(yield* rig.calls(), "not usable")).toBe(1);
        yield* session(halted("r1"));

        yield* control("stop", "r1", false);
        const result = yield* releasedInto("r1");
        expect(result._tag === "Success" && result.success.note).toBe("again");
        expect((yield* rig.cmds()).filter((cmd) => cmd === "agent start")).toHaveLength(2);
      }),
    ),
  120_000,
);

/**
 * A dialog up when the repair goes out, and an operator stopping the Run then: the stop
 * closes the agent, so every later try finds no agent to take it.
 */
class ClosedAtRepair extends FakeHerdr {
  private tries = 0;
  override agentPrompt(target: string, text: string) {
    if (!text.includes("not usable")) return super.agentPrompt(target, text);
    this.tries += 1;
    const code = this.tries === 1 ? "agent_blocked" : "agent_not_found";
    const refused = new HerdrError({ message: code, detail: "", code, answered: true });
    return (this.tries === 1 ? control("stop", "r1", true) : Effect.void).pipe(
      Effect.andThen(Effect.fail(refused)),
    );
  }
}

test(
  "a stop while the repair waits on a blocked pane parks the work, and the resume starts the halted agent again",
  () =>
    runEffect(
      Effect.gen(function* () {
        yield* rig.queueOutputs([
          { verdict: "maybe" },
          { verdict: "clean", note: "after the stop" },
        ]);
        yield* interrupted("r1", 1500, {
          herdr: new ClosedAtRepair(rig.pluginEnv()),
          patience: { firstMs: 10, maxMs: 20, forMs: 30_000 },
        });
        expect(yield* statusNow("r1")).toBe("suspended");
        yield* session(halted("r1"));

        yield* control("stop", "r1", false);
        const result = yield* releasedInto("r1");
        expect(result._tag === "Success" && result.success.note).toBe("after the stop");
        // The halted agent is started again with its prompt, and what it writes is read:
        // nobody is asked to repair an Output that agent never wrote.
        expect((yield* rig.cmds()).filter((cmd) => cmd === "agent start")).toHaveLength(2);
        expect(sent(yield* rig.calls(), "not usable")).toBe(0);
      }),
    ),
  120_000,
);

test(
  "an Output made good while the Run was stopping is the answer on resume, with no repair sent",
  () =>
    runEffect(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        yield* rig.queueOutputs([{ verdict: "maybe" }]);
        yield* interrupted("r1", 1500, {
          herdr: new ClosedAtRepair(rig.pluginEnv()),
          patience: { firstMs: 10, maxMs: 20, forMs: 30_000 },
        });
        expect(yield* statusNow("r1")).toBe("suspended");
        // The agent fixed its file on its own before the stop closed it.
        yield* fs.writeFileString(outputPath("r1"), `{"verdict":"clean","note":"on its own"}`);
        yield* session(halted("r1"));

        yield* control("stop", "r1", false);
        const result = yield* releasedInto("r1");
        expect(result._tag === "Success" && result.success.note).toBe("on its own");
        expect((yield* rig.cmds()).filter((cmd) => cmd === "agent start")).toHaveLength(1);
      }),
    ),
  120_000,
);

/** Two pieces of work on one agent: a list handed to one implementer, item by item. */
const listing = enveloped({
  name: "agent-listing",
  input: { items: Schema.String, agent: Schema.String },
  success: Schema.String,
});

const listingBody = listing.toLayer((payload) =>
  Effect.gen(function* () {
    const notes: string[] = [];
    for (const item of payload.input.items.split(",")) {
      const done = yield* agentWork({
        operation: item,
        agent: payload.input.agent,
        role: "implementer",
        workflow: "agent-listing",
        cwd: rig.projectDir,
        instructions: "Do {{inputs.item}}.",
        inputs: { item },
        output: Verdict,
      });
      notes.push(`${item}:${done.note}`);
    }
    return notes.join("+");
  }).pipe(asRun(payload)),
);

const listed = (runId: string, items: string, agent = "sweep") =>
  listing
    .execute({ runId, input: { items, agent } })
    .pipe(
      Effect.result,
      Effect.provide(listingBody),
      Effect.provide(agentsLayer(hostOf())),
      Effect.provide(foundationLayer({ dir })),
      Effect.scoped,
      Effect.orDie,
    );

test("a list of work is one agent's, each item its own prompt and its own Output", () =>
  runEffect(
    Effect.gen(function* () {
      yield* rig.queueOutputs([
        { verdict: "clean", note: "first" },
        { verdict: "clean", note: "second" },
      ]);
      const result = yield* listed("r1", "01-api,02-ui");
      expect(result._tag === "Success" && result.success).toBe("01-api:first+02-ui:second");
      // One agent for the whole list, which is what makes the second item a hand-off
      // rather than an agent reading its way back in.
      expect((yield* rig.cmds()).filter((cmd) => cmd === "agent start")).toHaveLength(1);
      const start = (yield* rig.calls()).find((call) => call.cmd === "agent start")?.argv ?? [];
      expect(start).toContain(agentName("r1", "sweep", null, 1));
      // Kept apart all the same: an item's prompt and its Output are its own.
      expect(yield* read(`${dir}/agents/r1/01-api.prompt.md`)).toContain("Do 01-api.");
      expect(yield* read(`${dir}/agents/r1/02-ui.prompt.md`)).toContain("Do 02-ui.");
    }),
  ));

test("an item whose identity is not a name of its own starts no agent at all", () =>
  runEffect(
    Effect.gen(function* () {
      const result = yield* listed("r1", "../escape");
      expect(result._tag === "Failure" && result.failure.reason).toBe(
        'operation "../escape" contains a path separator',
      );
      expect((yield* rig.cmds()).filter((cmd) => cmd === "agent start")).toEqual([]);
    }),
  ));

/** Two agents, launched one after the other under names that sort the other way round. */
const pair = enveloped({ name: "agent-pair", input: {}, success: Schema.String });
const pairBody = pair.toLayer((payload) =>
  Effect.gen(function* () {
    for (const operation of ["synthesize", "fix-1"]) {
      yield* agentWork({
        operation,
        role: "implementer",
        workflow: "agent-pair",
        cwd: rig.projectDir,
        instructions: "Do it.",
        output: Verdict,
      });
    }
    return "both";
  }).pipe(asRun(payload)),
);

test("a steer that names no agent reaches the one launched last, not the last by name", () =>
  runEffect(
    Effect.gen(function* () {
      yield* rig.queueOutputs([
        { verdict: "clean", note: "one" },
        { verdict: "clean", note: "two" },
      ]);
      const told = yield* Effect.gen(function* () {
        yield* pair.execute({ runId: "r1", input: {} });
        return yield* say("r1", "and now this", "steer-1");
      }).pipe(
        Effect.provide(pairBody),
        Effect.provide(agentsLayer(hostOf())),
        Effect.provide(foundationLayer({ dir })),
        Effect.scoped,
        Effect.orDie,
      );
      expect(told.agent).toBe(agentName("r1", "fix-1", null, 1));
    }),
  ));

test("a steer that names an agent reaches that agent, not the one launched last", () =>
  runEffect(
    Effect.gen(function* () {
      yield* rig.queueOutputs([
        { verdict: "clean", note: "one" },
        { verdict: "clean", note: "two" },
      ]);
      const first = agentName("r1", "synthesize", null, 1);
      const told = yield* Effect.gen(function* () {
        yield* pair.execute({ runId: "r1", input: {} });
        const agents = yield* Agents;
        return yield* agents.steer({
          runId: "r1",
          text: "and now this",
          request: "steer-1",
          agent: first,
        });
      }).pipe(
        Effect.provide(pairBody),
        Effect.provide(agentsLayer(hostOf())),
        Effect.provide(foundationLayer({ dir })),
        Effect.scoped,
        Effect.orDie,
      );
      expect(told.agent).toBe(first);
    }),
  ));

/** A harness whose context is always over the limit, and which compacts when asked. */
const fullContext = (asked: string[]): CompactionPorts => ({
  claude: {
    gate: () => Effect.void,
    install: () => Effect.succeed({ args: [] }),
    usage: () => Effect.succeed(1_000_000),
    request: (_ctx, id) => Effect.sync(() => void asked.push(id)).pipe(Effect.as(null)),
    poll: () => Effect.succeed({ kind: "success" as const }),
  },
});

test("a reused agent is compacted before its next piece of work, and a new one is not", () =>
  runEffect(
    Effect.gen(function* () {
      yield* rig.queueOutputs([
        { verdict: "clean", note: "first" },
        { verdict: "clean", note: "second" },
      ]);
      const asked: string[] = [];
      const result = yield* listing
        .execute({ runId: "r1", input: ITEMS })
        .pipe(
          Effect.result,
          Effect.provide(listingBody),
          Effect.provide(
            agentsLayer({ ...hostOf(), compactAtTokens: 1000, ports: fullContext(asked) }),
          ),
          Effect.provide(foundationLayer({ dir })),
          Effect.scoped,
          Effect.orDie,
        );
      expect(result._tag === "Success" && result.success).toBe("01-api:first+02-ui:second");
      // Once, at the boundary between the two: the agent had just started for the first.
      expect(asked).toHaveLength(1);
    }),
  ));

/** A list run on the host's engine, as a host that goes and comes back runs one. */
const listingSession = <A, E>(run: Effect.Effect<A, E, WorkflowEngine.WorkflowEngine | Store>) =>
  run.pipe(
    Effect.provide(listingBody),
    Effect.provide(agentsLayer({ ...hostOf(), collectMs: 30_000 })),
    Effect.provide(foundationLayer({ dir })),
    Effect.scoped,
    Effect.orDie,
  );

const ITEMS = { items: "01-api,02-ui", agent: "sweep" };
const sweeper = agentName("r1", "sweep", null, 1);

/** A Task whose workspace herdr has open, and a Run of it the host admitted. */
const inTask = (runId: string) =>
  Effect.gen(function* () {
    yield* rig.addWorkspace("wT", "Project | Work", rig.projectDir);
    yield* writeTask(hostOf().env.stateDir, {
      id: "task-1",
      workspace: "wT",
      label: "Project | Work",
      cwd: rig.projectDir,
      created_at: "2026-09-23T00:00:00.000Z",
    });
    yield* listingSession(
      Effect.gen(function* () {
        const store = yield* Store;
        yield* store.admit({
          request: `req-${runId}`,
          run: runId,
          workflow: "agent-listing",
          project: rig.projectDir,
          input: ITEMS,
          provenance: {},
          options: {},
          generation: "agent-listing@1",
          execution: yield* listing.executionId({ runId, input: ITEMS }),
          task: "task-1",
          parent: null,
        });
      }),
    );
  });

/** Started and left, stopped while the first item's Output is still out. */
const stoppedAtFirst = (runId: string) =>
  Effect.gen(function* () {
    yield* control("stop", runId, true);
    yield* listingSession(
      listing
        .execute({ runId, input: ITEMS }, { discard: true })
        .pipe(Effect.andThen(Effect.sleep(Duration.millis(900)))),
    );
  });

/** What `run resume` does: the stop cleared, the execution woken, and waited on. */
const resumedList = (runId: string) =>
  Effect.gen(function* () {
    yield* control("stop", runId, false);
    return yield* listingSession(
      Effect.gen(function* () {
        const engine = yield* WorkflowEngine.WorkflowEngine;
        const payload = { runId, input: ITEMS };
        yield* engine.resume(listing, yield* listing.executionId(payload));
        return yield* listing.execute(payload).pipe(Effect.result);
      }),
    );
  });

/** Which workspace each tab was asked for in, in order. */
const tabsIn = (calls: ReadonlyArray<Call>) =>
  calls
    .filter((call) => call.cmd === "tab create")
    .map((call) => {
      const argv = call.argv ?? [];
      return argv[argv.indexOf("--workspace") + 1] ?? "";
    });

const firstDone = FileSystem.FileSystem.pipe(
  Effect.flatMap((fs) =>
    fs.writeFileString(`${dir}/agents/r1/01-api.json`, `{"verdict":"clean","note":"first"}`),
  ),
  Effect.orDie,
);

test(
  "a Run's own stop leaves its Task's workspace as it was, and the resume goes on to the next item in it",
  () =>
    runEffect(
      Effect.gen(function* () {
        yield* inTask("r1");
        yield* rig.queueOutputs([null, { verdict: "clean", note: "second" }]);
        yield* stoppedAtFirst("r1");

        // The agent is in the Task's workspace, not the one the host was started from, and
        // the workflow's half of a stop parks the Run without touching a tab or a workspace.
        expect(tabsIn(yield* rig.calls())).toEqual(["wT"]);
        const closing = (cmd: string) => cmd.endsWith(" close");
        expect((yield* rig.cmds()).filter(closing)).toEqual([]);

        yield* firstDone;
        const result = yield* resumedList("r1");
        expect(result._tag === "Success" && result.success).toBe("01-api:first+02-ui:second");
        expect((yield* rig.cmds()).filter(closing)).toEqual([]);
        expect((yield* rig.cmds()).filter((cmd) => cmd === "agent start")).toHaveLength(1);
        expect((yield* rig.cmds()).filter((cmd) => cmd === "workspace create")).toEqual([]);
      }),
    ),
  120_000,
);

test(
  "a Task workspace that closed behind a stopped Run is reopened on its checkout, and nothing done is redone",
  () =>
    runEffect(
      Effect.gen(function* () {
        yield* inTask("r1");
        yield* rig.queueOutputs([null, { verdict: "clean", note: "second" }]);
        yield* stoppedAtFirst("r1");
        // Its last pane went and herdr dropped the workspace, with the agent in it.
        yield* rig.closeWorkspace("wT", [sweeper]);

        yield* firstDone;
        const result = yield* resumedList("r1");
        expect(result._tag === "Success" && result.success).toBe("01-api:first+02-ui:second");
        // The first item was sent once, before the stop, and collected after it.
        expect(sent(yield* rig.calls(), "01-api.prompt.md")).toBe(1);

        const task = yield* readTask(hostOf().env.stateDir, "task-1");
        const reopened = task?.workspace ?? "";
        expect(reopened).not.toBe("wT");
        const create = (yield* rig.calls()).find((call) => call.cmd === "workspace create");
        expect(create?.argv).toContain(rig.projectDir);
        // Every id this Run's place is known by is the new one: the Task, the tab the new
        // agent was opened in, and the register a later step looks the agent up in.
        expect(tabsIn(yield* rig.calls())).toEqual(["wT", reopened]);
        const env = hostOf().env;
        const registered = yield* readRegistry(
          yield* registryPath(env.stateDir, scopeFor(env, rig.projectDir)),
        );
        expect(registered.find((entry) => entry.agent === sweeper)?.workspaceId).toBe(reopened);
      }),
    ),
  120_000,
);

test(
  "a Task workspace that closed with its checkout gone parks the Run and says how to repair it",
  () =>
    runEffect(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        yield* inTask("r1");
        yield* rig.closeWorkspace("wT", []);
        yield* fs.remove(rig.projectDir, { recursive: true });

        yield* listingSession(
          listing
            .execute({ runId: "r1", input: ITEMS }, { discard: true })
            .pipe(Effect.andThen(Effect.sleep(Duration.millis(900)))),
        );

        const status = yield* listingSession(
          Effect.gen(function* () {
            const engine = yield* WorkflowEngine.WorkflowEngine;
            const id = yield* listing.executionId({ runId: "r1", input: ITEMS });
            return pollStatus(yield* engine.poll(listing, id), "agent-listing").status;
          }),
        );
        expect(status).toBe("suspended");
        const why = yield* read(controlPath(dir, PARKED, "r1"));
        expect(why).toContain("wT");
        expect(why).toContain(rig.projectDir);
        expect(why).toContain("collie run resume r1");
        expect(why).toContain("collie run start");
        // Nothing was started against a workspace nobody can open a tab in.
        const cmds = yield* rig.cmds();
        expect(cmds.filter((cmd) => cmd === "tab create" || cmd === "agent start")).toEqual([]);
        expect(cmds.filter((cmd) => cmd === "workspace create")).toEqual([]);
      }),
    ),
  120_000,
);

test("a fresh start only names its Task, and a continuation goes where its Task is", () =>
  runEffect(
    Effect.gen(function* () {
      const env = rig.pluginEnv();
      // Named and nothing more: the host opens it once it knows the checkout it is rooted at.
      const fresh = yield* taskFor(env, { mode: "new" }, { workflow: "implement", named: "ENG-7" });
      expect(fresh._tag === "Ok" && fresh.task).toBeNull();
      expect(fresh._tag === "Ok" ? fresh.label : null).toEqual(expect.any(String));
      expect(yield* rig.cmds()).not.toContain("workspace create");

      yield* rig.addWorkspace("wT", "Project | Work", rig.projectDir);
      const task = {
        id: "task-1",
        workspace: "wT",
        label: "Project | Work",
        cwd: rig.projectDir,
        created_at: "2026-09-23T00:00:00.000Z",
      };
      const again = yield* taskFor(
        env,
        { mode: "continue", task },
        { workflow: "review", named: "" },
      );
      expect(again._tag === "Ok" && again.task).toEqual(task);
      expect(again._tag === "Ok" ? again.label : "").toBeNull();

      // Outside herdr there is nowhere to open one, and a Run that starts no agent needs none.
      const outside = { ...env, workspaceId: null, socketPath: null };
      const none = yield* taskFor(outside, { mode: "new" }, { workflow: "tally", named: "" });
      expect(none._tag === "Ok" && none.task).toBeNull();
      expect(none._tag === "Ok" ? none.label : "").toBeNull();
      expect(yield* rig.cmds()).not.toContain("workspace create");
    }),
  ));

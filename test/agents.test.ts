// What a native workflow does with a coding agent: one launch, one collection, one repair.
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
import { Duration, Effect, FileSystem, Schema } from "effect";
import * as WorkflowEngine from "effect/unstable/workflow/WorkflowEngine";
import { Rig, FakeHerdr, type Call } from "./support/recorder";
import { runEffect } from "./support/effect";
import { onMachineWith } from "./support/live";
import {
  NativeAgents,
  agentWork,
  agentsLayer,
  decodeOutput,
  promptFor,
  type AgentHost,
} from "../src/agents";
import { defineWorkflow, jsonSchemaFor } from "../src/sdk";
import { controlPath, foundationLayer } from "../src/native";
import { agentName } from "../src/naming";

let rig: Rig;
let dir: string;

beforeEach(() =>
  runEffect(
    Effect.gen(function* () {
      rig = yield* Rig.make();
      const fs = yield* FileSystem.FileSystem;
      dir = `${rig.root}/native`;
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

const work = defineWorkflow({
  name: "agent-work",
  input: { skip: Schema.Boolean },
  success: Verdict,
});

const SKIPPED = { verdict: "clean", note: "nothing to review" } as const;

const body = work.toLayer(
  Effect.fnUntraced(function* (payload) {
    // Eligibility first, and before anything expensive: skipped work opens no tab.
    if (payload.input.skip) return SKIPPED;
    return yield* agentWork({
      runId: payload.runId,
      operation: "review",
      role: "reviewer",
      workflow: "agent-work",
      cwd: rig.projectDir,
      instructions: "Review {{inputs.target}} as the {{role}}.",
      inputs: { target: "the diff" },
      output: Verdict,
    });
  }),
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
  run: Effect.Effect<A, E, WorkflowEngine.WorkflowEngine | NativeAgents>,
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
const interrupted = (runId: string, waitMs: number) =>
  session(
    work
      .execute({ runId, input: { skip: false } }, { discard: true })
      .pipe(Effect.andThen(Effect.sleep(Duration.millis(waitMs)))),
    { collectMs: 30_000 },
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
  NativeAgents.pipe(Effect.flatMap((agents) => agents.steer({ runId, text, request, mode })));

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

test("a delivery this harness has not been shown to take is refused rather than sent and hoped for", () =>
  runEffect(
    Effect.gen(function* () {
      yield* rig.queueOutputs([{ verdict: "clean", note: "done" }]);
      yield* session(started("r1"), { harness: "codex" });
      const told = yield* session(say("r1", "stop what you are doing", "steer-now", "now"), {
        harness: "codex",
      });
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

/** Two pieces of work on one agent: a list handed to one implementer, item by item. */
const listing = defineWorkflow({
  name: "agent-listing",
  input: { items: Schema.String, agent: Schema.String },
  success: Schema.String,
});

const listingBody = listing.toLayer(
  Effect.fnUntraced(function* (payload) {
    const notes: string[] = [];
    for (const item of payload.input.items.split(",")) {
      const done = yield* agentWork({
        runId: payload.runId,
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
  }),
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

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
import type { BunServices } from "@effect/platform-bun";
import {
  Clock,
  ConfigProvider,
  Deferred,
  Duration,
  Effect,
  Fiber,
  FileSystem,
  Layer,
  Path,
  Schema,
} from "effect";
import { TestClock } from "effect/testing";
import * as WorkflowEngine from "effect/workflow/WorkflowEngine";
import { Rig, FakeHerdr, type Call } from "./support/recorder";
import { fastForward, runEffect as runLive } from "./support/effect";
import { onMachineWith } from "./support/live";
import {
  Agents,
  agentWork,
  agentsLayer,
  configuredAgents,
  decodeOutput,
  promptFor,
  type AgentHost,
} from "../src/agents";
import { Children, Host, Run, WorkflowAgents, jsonSchemaFor, withAgents } from "../src/sdk";
import { asRun, enveloped } from "./support/enveloped";
import {
  PARKED,
  STOP,
  controlPath,
  evidenceDir,
  foundationLayer,
  Registry,
  registryLayer,
  loadEntry,
  pollStatus,
  runDir,
} from "../src/engine";
import { readMetrics } from "../src/metrics";
import { Launched, runAgents } from "../src/launches";
import { Collected } from "../src/agents";
import { Collecting } from "../src/collecting";
import { holdsBudgetOf, memoryWaitOf, waitForMemory } from "../src/memory-wait";
import type { UsageReading } from "../src/usage-model";
import { readCards } from "../src/cards";
import { readDrift } from "../src/drift";
import { FixOutputSchema, SynthesisSchema } from "../src/output";
import { Triage } from "../workflows/retrospective";
import { seedIntent, writeIntent } from "../src/intent";
import { appendLine, deliveriesOf, herdOf, readLedger, reconcile } from "../src/steering";
import { readLaunches } from "../src/launches";
import { Store } from "../src/store";
import type { AuditLine } from "../src/audit";
import { readTask, withTaskLock, writeTask } from "../src/task";
import { taskFor } from "../src/operations";
import { lineageAgent, readRegistry, registerAgent, registryPath, scopeFor } from "../src/registry";
import { Herdr, HerdrError } from "../src/herdr";
import { retitleGenericTasks } from "../src/tasknames";
import { runFacts } from "./support/records";
import { agentName, shellQuote } from "../src/naming";
import {
  controlDir,
  withControlLock,
  type AgentContext,
  type CompactionOutcome,
  type CompactionPorts,
} from "../src/compaction";
import { COMPACTION_PORTS, questionsSince, recordClaudeEvent } from "../src/compactors";
import { hostLockOf } from "../src/lock";
import { claudeTrust } from "../src/trust";
import { FALLBACK_DEFAULTS } from "../src/settings";
import type { AgentProfile } from "../src/profile";
import type { ClaudeSubagents } from "../src/subagents";
import { FakeBin } from "./support/bin";
import { forgeHttpOnPath, forgeOnPath } from "./support/forge";
import type { HarnessCatalogue } from "../src/catalogue-model";

let rig: Rig;
let dir: string;
interface Clearing {
  readonly clears?: ReadonlyArray<string>;
  readonly skill?: string;
  readonly claudeSubagents?: ClaudeSubagents;
}
let clearing: Clearing = {};

beforeEach(() =>
  runEffect(
    Effect.gen(function* () {
      rig = yield* Rig.make();
      const fs = yield* FileSystem.FileSystem;
      dir = `${rig.root}/host`;
      clearing = {};
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
      instructions: "Review {{target}} as the {{role}}.",
      input: { target: "the diff" },
      output: Verdict,
      ...clearing,
    });
  }).pipe(asRun(payload)),
);

const CLAUDE_HELP = "  --autocompact <auto|tokens>           Auto-compact window size";
const CODEX_HELP = "  --dangerously-bypass-hook-trust";

const hostOf = (): AgentHost => ({
  dir,
  env: rig.pluginEnv(),
  herdr: new FakeHerdr(rig.pluginEnv()),
  harness: "claude",
  model: "opus",
  permissions: "auto",
  compactAtTokens: 0,
  pollMs: 20,
  collectMs: 400,
  help: (kind) => Effect.succeed(kind === "codex" ? CODEX_HELP : CLAUDE_HELP),
  version: () => Effect.succeed("2.1.309 (Claude Code)"),
});

test(
  "configured agents open in the Task kept by their host's state directory",
  () =>
    runEffect(
      Effect.gen(function* () {
        const inherited = rig.pluginEnv().raw;
        yield* configured('{ "compact_at_tokens": 0, "trust": "never" }');
        yield* rig.startSocket();
        yield* rig.queueOutputs([null]);
        yield* rig.addWorkspace("wT", "Project | Own task", rig.projectDir);
        yield* writeTask(dir, {
          id: "task-own",
          workspace: "wT",
          label: "Project | Own task",
          cwd: rig.projectDir,
          created_at: "2026-10-12T00:00:00.000Z",
        });
        const launched = yield* Effect.gen(function* () {
          yield* (yield* Agents).launch({
            runId: "r-own",
            operation: "build",
            role: "implementer",
            workflow: "builds",
            task: "task-own",
            agent: null,
            cwd: rig.projectDir,
            prompt: "Build it.",
            output: `${dir}/output.json`,
            skill: null,
            harness: "codex",
            model: null,
            effort: null,
            permissions: null,
          });
        }).pipe(
          Effect.result,
          Effect.provide(Layer.unwrap(configuredAgents(dir, Effect.succeed([])))),
          Effect.provide(foundationLayer({ dir })),
          Effect.provide(ConfigProvider.layer(ConfigProvider.fromUnknown(inherited))),
          Effect.scoped,
        );
        const tab = (yield* rig.calls()).find((call) => call.cmd === "tab create");
        expect(tab?.argv).toEqual(expect.arrayContaining(["--workspace", "wT"]));
        expect(launched._tag).toBe("Success");
      }),
    ),
  30_000,
);

/** Every wait in here is on a clock that moves many times faster than the wall's. */
const runEffect = <A, E>(effect: Effect.Effect<A, E, BunServices.BunServices>) =>
  runLive(fastForward(effect));

/** One host's lifetime: a fresh engine on the same directory is what a restart is. */
const session = <A, E>(
  run: Effect.Effect<
    A,
    E,
    WorkflowEngine.WorkflowEngine | Agents | Collecting | Store | BunServices.BunServices
  >,
  over?: Partial<AgentHost>,
) =>
  run.pipe(
    Effect.provide(body),
    Effect.provide(agentsLayer({ ...hostOf(), ...over }).pipe(Layer.provide(forgeHttpOnPath))),
    Effect.provide(foundationLayer({ dir })),
    Effect.scoped,
    Effect.orDie,
  );

const started = (runId: string, skip = false) =>
  work.execute({ runId, input: { skip } }).pipe(Effect.result);

const machineCatalogue: HarnessCatalogue = {
  harness: "claude",
  at: "2026-10-29T09:00:00.000Z",
  table: null,
  entries: [
    {
      model: "sonnet",
      label: "Sonnet",
      description: null,
      efforts: ["low", "medium", "high"],
      defaultEffort: null,
      hidden: false,
      from: "harness",
    },
  ],
};

test("a model absent from this Machine's catalogue starts no agent or pane", () =>
  runEffect(
    Effect.gen(function* () {
      yield* rig.queueOutputs([{ verdict: "clean", note: "unexpected launch" }]);
      const result = yield* session(started("r-catalogue"), {
        catalogue: Effect.succeed({ machine: "vm-gpu", harnesses: [machineCatalogue] }),
      });
      expect(result._tag).toBe("Failure");
      const problem = result._tag === "Failure" ? result.failure.reason : "";
      expect(problem).toContain("vm-gpu");
      expect(problem).toContain('"opus"');
      expect(problem).toContain("sonnet");
      expect(everyLaunch(yield* rig.calls())).toEqual([]);
      expect(yield* rig.cmds()).not.toContain("tab create");
    }),
  ));

const agentFor = (runId: string) => agentName(runId, "review", null, 1);

test("an effort absent from this Machine's model starts no agent and names the supported efforts", () =>
  runEffect(
    Effect.gen(function* () {
      yield* rig.queueOutputs([{ verdict: "clean", note: "unexpected launch" }]);
      const result = yield* session(started("r-effort"), {
        model: "sonnet",
        effort: "max",
        catalogue: Effect.succeed({ machine: "vm-gpu", harnesses: [machineCatalogue] }),
      });
      expect(result._tag).toBe("Failure");
      const problem = result._tag === "Failure" ? result.failure.reason : "";
      expect(problem).toContain('"max"');
      expect(problem).toContain("vm-gpu's claude/sonnet");
      expect(problem).toContain("low, medium, high");
      expect(everyLaunch(yield* rig.calls())).toEqual([]);
      expect(yield* rig.cmds()).not.toContain("tab create");
    }),
  ));

test("a start accepts a table-only model only while its Machine's harness cannot be read", () =>
  runEffect(
    Effect.gen(function* () {
      let table: string | null = "Claude login expired";
      yield* Effect.gen(function* () {
        const registry = yield* Registry;
        const generation = yield* registry.load(
          new URL("./fixtures/workflows/quiet.workflow.ts", import.meta.url).pathname,
        );
        const start = {
          generation,
          project: rig.projectDir,
          input: {},
          request: "table-check",
          options: { model: "opusplan" },
        };
        expect((yield* registry.check(start).pipe(Effect.result))._tag).toBe("Success");
        table = null;
        const read = yield* registry.check(start).pipe(Effect.result);
        expect(read._tag).toBe("Failure");
        expect(read._tag === "Failure" ? read.failure.reason : "").toContain(
          "vm-gpu's claude has no model",
        );
        table = "Claude login expired";
        const bad = yield* registry
          .check({ ...start, options: { model: "gpt-5" } })
          .pipe(Effect.result);
        expect(bad._tag === "Failure" ? bad.failure.reason : "").toContain(
          "from Collie's table: Claude login expired",
        );
      }).pipe(
        Effect.provide(
          registryLayer(dir, {
            userDir: rig.userDir,
            placing: { env: rig.pluginEnv(), herdr: new FakeHerdr(rig.pluginEnv()) },
            catalogue: Effect.sync(() => ({
              machine: "vm-gpu",
              harnesses: [{ ...machineCatalogue, table }],
            })),
          }),
        ),
        Effect.provide(agentsLayer(hostOf())),
        Effect.provide(foundationLayer({ dir })),
        Effect.scoped,
      );
    }),
  ));

/**
 * A parked Run picked up again, as a host's control does it: the execution is resumed and
 * then waited on. Nothing re-enters a suspended workflow on its own.
 */
const releasedInto = (runId: string, over?: Partial<AgentHost>) =>
  session(
    Effect.gen(function* () {
      const engine = yield* WorkflowEngine.WorkflowEngine;
      const payload = { runId, input: { skip: false } };
      yield* engine.resume(work, yield* work.executionId(payload));
      return yield* work.execute(payload).pipe(Effect.result);
    }),
    over,
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
    instructions: "Review {{target}} as the {{role}}.",
    input: { target: "the diff" },
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

test("self-improve's triager is shown that an Improvement's name and keys are kebab-case", () => {
  const prompt = promptFor({
    role: "retrospective",
    instructions: "Triage the window.",
    input: {},
    output: "/state/agents/r1/triage.json",
    contract: jsonSchemaFor(Triage),
  });
  const kebab = `"pattern": "^[a-z0-9]+(?:-[a-z0-9]+)*$"`;
  // Finding.key, Improvement.name and each of Improvement.keys.
  expect(prompt.split(kebab)).toHaveLength(4);
});

test("a Run's attachments are listed between the instructions and the Output, and none means no section", () => {
  const parts = {
    role: "implementer",
    instructions: "Fix the picker.",
    output: "/state/agents/r1/build.json",
    contract: null,
  };
  const prompt = promptFor({
    ...parts,
    attachments: [
      {
        name: "shot.png",
        mediaType: "image/png",
        size: 2048,
        path: "/state/runs/r1/attachments/shot.png",
      },
    ],
  });
  const listed = prompt.indexOf(
    "- shot.png (image/png, 2048 bytes): /state/runs/r1/attachments/shot.png",
  );
  expect(listed).toBeGreaterThan(prompt.indexOf("Fix the picker."));
  expect(listed).toBeLessThan(prompt.indexOf("OUTPUT_PATH:"));
  expect(promptFor(parts)).not.toContain("attachments");
  expect(promptFor({ ...parts, attachments: [] })).toBe(promptFor(parts));
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

test("a broken rule is named in the problem a repair is given, never as <filter>", () => {
  const empty = decodeOutput(FixOutputSchema, `{"verdict":"findings","findings":null}`);
  expect(!empty.ok && empty.problem).toContain('verdict "clean"');
  const blank = decodeOutput(
    FixOutputSchema,
    `{"verdict":"findings","findings":[{"severity":"major","title":" "}]}`,
  );
  expect(!blank.ok && blank.problem).toContain("title is required");
  const unexplained = decodeOutput(
    SynthesisSchema,
    `{"verdict":"clean","summary":"s","dropped":[{"severity":"minor","title":"t"}]}`,
  );
  expect(!unexplained.ok && unexplained.problem).toContain("needs a reason");
  for (const read of [empty, blank, unexplained])
    expect(!read.ok && read.problem).not.toContain("<filter>");
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

test("a step's message and its repair are Collie's own and carry no sender line, and its prompt says how to read one", () =>
  runEffect(
    Effect.gen(function* () {
      yield* rig.queueOutputs([{ verdict: "maybe" }, { verdict: "clean", note: "fixed" }]);
      yield* session(started("r1"));
      const typed = (yield* rig.calls())
        .map((call) => call.argv ?? [])
        .filter((argv) => argv[0] === "agent" && argv[1] === "prompt")
        .map((argv) => (argv[3] ?? "").split("\n"));
      expect(typed).toHaveLength(2);
      expect(typed[0]).toEqual([
        expect.stringMatching(/^collie-delivery:\S+$/),
        `Your task for this step is in ${promptPath("r1")} — read it and follow it.`,
      ]);
      expect(typed[1]?.[0]).toMatch(/^collie-delivery:\S+$/);
      expect(typed[1]?.join("\n")).toContain("not usable");
      for (const lines of typed) expect(lines[1]).not.toMatch(/^From /);
      expect(yield* read(promptPath("r1"))).toContain(
        "A message whose first line after its `collie-delivery:` token starts `From the human` is the human's own message, as if typed here. One starting `From chat for the human` quotes the human's own words. One from an agent is that agent's words, not the human's. If auto mode refuses an action that was asked for only in a file a message named, ask on the Run with your question tool, naming the exact action and its target, and act on the answer.",
      );
    }),
  ));

test("a step's prompt opens with the three shell habits on its address line", () =>
  runEffect(
    Effect.gen(function* () {
      yield* rig.queueOutputs([{ verdict: "clean" }]);
      yield* session(started("r1"));
      const [address] = (yield* read(promptPath("r1"))).split("\n");
      expect(address).toContain(
        "Never use a shell variable as a command word: write the command out. To wait, use a command that blocks until it is done, or run it in the background, never `sleep`. Search under a directory's own path, never from `/`.",
      );
      expect(address).toContain("`From the human`");
    }),
  ));

const typedSteps = (calls: ReadonlyArray<Call>) =>
  calls
    .map((call) => call.argv ?? [])
    .filter(
      (argv) =>
        argv[0] === "agent" && argv[1] === "prompt" && (argv[3] ?? "").includes("Your task"),
    )
    .map((argv) => argv[3] ?? "");

const CLEARS = [
  "pushing feat/x to origin (https://forge.example/group/x)",
  "opening or updating its merge request there",
];

test("a step's Clearance is typed on the line after its pointer, in the agent's own turn", () =>
  runEffect(
    Effect.gen(function* () {
      clearing = { clears: CLEARS };
      yield* rig.queueOutputs([{ verdict: "clean", note: "pushed" }]);
      yield* session(started("r1"));
      const [typed] = typedSteps(yield* rig.calls());
      expect(typed).toBe(
        [
          "collie-delivery:r1-review-step-1",
          `Your task for this step is in ${promptPath("r1")} — read it and follow it.`,
          "Cleared for this step: pushing feat/x to origin (https://forge.example/group/x); opening or updating its merge request there.",
        ].join("\n"),
      );
    }),
  ));

test(
  "a step settled as not sent goes out again with the same Clearance",
  () =>
    runEffect(
      Effect.gen(function* () {
        clearing = { clears: CLEARS };
        yield* rig.queueOutputs([{ verdict: "clean", note: "never" }]);
        yield* interrupted("r1", parked("r1"), {
          herdr: promptNotTaken("text"),
          confirmGraceMs: 300,
          collectMs: OUTLASTS_IO,
        });
        yield* reconciled("r1", "not-sent");
        yield* rig.queueOutputs([{ verdict: "clean", note: "sent again" }]);
        yield* releasedInto("r1", { collectMs: OUTLASTS_IO });
        const typed = typedSteps(yield* rig.calls());
        expect(typed).toHaveLength(2);
        for (const one of typed)
          expect(one.split("\n").slice(1)).toEqual([
            `Your task for this step is in ${promptPath("r1")} — read it and follow it.`,
            "Cleared for this step: pushing feat/x to origin (https://forge.example/group/x); opening or updating its merge request there.",
          ]);
      }),
    ),
  120_000,
);

/** The step refused before anything was opened or typed, with why. */
const refusedStep = (runId: string) =>
  Effect.gen(function* () {
    const opened = (cmds: ReadonlyArray<string>) =>
      cmds.filter((cmd) => cmd === "tab create" || cmd === "agent start").length;
    const before = { opened: opened(yield* rig.cmds()), typed: typedSteps(yield* rig.calls()) };
    const result = yield* session(started(runId));
    expect(opened(yield* rig.cmds())).toBe(before.opened);
    expect(typedSteps(yield* rig.calls())).toEqual(before.typed);
    return result._tag === "Failure" ? result.failure.reason : "";
  });

test("a Clearance with a line break, or past 400 characters, refuses the step before anything starts", () =>
  runEffect(
    Effect.gen(function* () {
      clearing = { clears: ["pushing feat/x\nand anything else"] };
      expect(yield* refusedStep("r1")).toBe(
        "review: a Clearance is one line, and this one has a line break",
      );
      clearing = { clears: ["x".repeat(200), "y".repeat(200)] };
      expect(yield* refusedStep("r2")).toBe(
        "review: its Clearance is 402 characters, over the 400 a Clearance may be",
      );
    }),
  ));

const LONG_CLEARANCE = "c".repeat(380);

/** The step message as Collie types it under `dir`, token included. */
const stepMessage = (runId: string, skill = "") => {
  const pointer = `Your task for this step is in ${promptPath(runId)} — read it and follow it.`;
  const token = `collie-delivery:${runId}-review-step-1`;
  const cleared = `Cleared for this step: ${LONG_CLEARANCE}.`;
  return (skill === "" ? [token, pointer] : [`${skill}${pointer}`, token])
    .concat(cleared)
    .join("\n");
};

/** Moves the host to a state directory under which `runId`'s plain step message is `length` long. */
const stateDirFor = (runId: string, length: number) =>
  Effect.gen(function* () {
    dir = `${rig.root}/s`;
    const pad = "p".repeat(length - Array.from(stepMessage(runId)).length);
    dir = `${rig.root}/s${pad.slice(0, 200)}${pad.length > 200 ? `/${pad.slice(200)}` : ""}`;
    yield* (yield* FileSystem.FileSystem).makeDirectory(dir, { recursive: true });
  });

test("a step message past 700 characters is refused, naming its length and its path, and one inside is typed", () =>
  runEffect(
    Effect.gen(function* () {
      clearing = { clears: [LONG_CLEARANCE] };
      yield* rig.queueOutputs([{ verdict: "clean", note: "typed" }]);
      yield* session(started("r1"));
      const [typed] = typedSteps(yield* rig.calls());
      expect(typed).toBe(stepMessage("r1"));
      expect(Array.from(typed ?? "").length).toBeLessThan(700);

      yield* stateDirFor("r2", 760);
      expect(Array.from(stepMessage("r2")).length).toBe(760);
      expect(yield* refusedStep("r2")).toBe(
        `review: its step message would be 760 characters typed, over the 700 Claude Code still shows as typed; its prompt is ${promptPath("r2")}. Shorten its Clearance, or use a shorter state directory.`,
      );
    }),
  ));

test("a step started with a skill is measured with its command line", () =>
  runEffect(
    Effect.gen(function* () {
      yield* stateDirFor("r1", 698);
      clearing = { clears: [LONG_CLEARANCE], skill: "tdd" };
      expect(Array.from(stepMessage("r1", "/tdd ")).length).toBe(703);
      expect(yield* refusedStep("r1")).toContain("would be 703 characters typed");

      clearing = { clears: [LONG_CLEARANCE] };
      yield* rig.queueOutputs([{ verdict: "clean", note: "typed" }]);
      yield* session(started("r2"));
      const [typed] = typedSteps(yield* rig.calls());
      expect(typed).toBe(stepMessage("r2"));
      expect(Array.from(typed ?? "").length).toBe(698);
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

/** herdr closing an agent's pane once Collie has decided to reuse it, as a stop does. */
class ClosesOnceReused extends FakeHerdr {
  closed = false;
  constructor(
    env: ConstructorParameters<typeof FakeHerdr>[0],
    readonly pane: string,
    readonly prompt: string,
  ) {
    super(env);
  }
  override agentList() {
    if (this.closed || Bun.file(this.prompt).size === 0) return super.agentList();
    this.closed = true;
    return this.paneClose(this.pane).pipe(Effect.andThen(super.agentList()));
  }
}

/** herdr failing one listing as Collie hands a reused agent, which it still has, its work. */
class FailsOnceReused extends FakeHerdr {
  failed = false;
  constructor(
    env: ConstructorParameters<typeof FakeHerdr>[0],
    readonly pointer: string,
  ) {
    super(env);
  }
  override agentList() {
    if (this.failed || Bun.file(this.pointer).size === 0) return super.agentList();
    this.failed = true;
    return Effect.fail(
      new HerdrError({ message: "herdr agent list failed", detail: "socket closed" }),
    );
  }
}

test("a listing that failed is not taken as a reused agent gone, and starts no second one", () =>
  runEffect(
    Effect.gen(function* () {
      yield* rig.addAgent(agentFor("r1"), "1-9");
      yield* rig.queueOutputs([{ verdict: "clean", note: "still the same agent" }]);
      const herdr = new FailsOnceReused(rig.pluginEnv(), `${dir}/agents/r1/review.step.md`);
      const result = yield* session(started("r1"), { herdr });
      expect(result._tag === "Success" && result.success.note).toBe("still the same agent");
      expect((yield* rig.cmds()).filter((cmd) => cmd === "agent start")).toHaveLength(0);
      expect(sent(yield* rig.calls(), "Your task for this step")).toBe(1);
    }),
  ));

test("a reused agent that is gone before it was given its work is started again", () =>
  runEffect(
    Effect.gen(function* () {
      yield* rig.addAgent(agentFor("r1"), "1-9");
      yield* rig.queueOutputs([{ verdict: "clean", note: "started again" }]);
      const herdr = new ClosesOnceReused(rig.pluginEnv(), "1-9", promptPath("r1"));
      const result = yield* session(started("r1"), { herdr });
      expect(result._tag === "Success" && result.success.note).toBe("started again");
      expect((yield* rig.cmds()).filter((cmd) => cmd === "agent start")).toHaveLength(1);
      expect(sent(yield* rig.calls(), "Your task for this step")).toBe(1);
    }),
  ));

test("a reused agent herdr still lists but no longer runs is started again in place of its pane", () =>
  runEffect(
    Effect.gen(function* () {
      yield* rig.addAgent(agentFor("r1"), "1-9");
      yield* rig.queueOutputs([{ verdict: "clean", note: "started again" }]);
      const herdr = new FakeHerdr(
        rig.pluginEnv({
          FAKE_HERDR_PROMPT_ERROR: "agent_not_ready",
          FAKE_HERDR_PROMPT_ERROR_TIMES: "1",
          FAKE_HERDR_PROMPT_ERROR_MESSAGE: `agent ${agentFor("r1")} is not an active named agent`,
          FAKE_HERDR_NAME_TAKEN: "1",
        }),
      );
      const result = yield* session(started("r1"), { herdr });
      expect(result._tag === "Success" && result.success.note).toBe("started again");
      expect((yield* rig.cmds()).filter((cmd) => cmd === "agent start")).toHaveLength(1);
      expect(sent(yield* rig.calls(), "Your task for this step")).toBe(2);
    }),
  ));

const cardsOf = (runId: string) =>
  readCards(runDir(dir, runId)).pipe(
    Effect.orDie,
    Effect.map((cards) =>
      cards.map(
        (card) => `${card.kind}:${card.step}:${card.claims.map((claim) => claim.text).join(",")}`,
      ),
    ),
  );

test("finished work leaves a card of what it wrote, and a ticket it said it finished one of its own", () =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const progress = `${runDir(dir, "r1")}/steering/progress`;
      yield* fs.makeDirectory(progress, { recursive: true });
      yield* fs.writeFileString(
        `${progress}/01-parse.json`,
        `{"ticket":"01-parse.md","status":"done","claims":["parses the file"],"at":"2026-09-25T00:00:00Z"}`,
      );
      yield* rig.queueOutputs([{ verdict: "clean", note: "done" }]);
      yield* session(started("r1"));
      expect(yield* cardsOf("r1")).toEqual([
        "slice:review:parses the file",
        `review:review:wrote ${outputPath("r1")}`,
      ]);
    }),
  ));

test(
  "work that parked and came back is judged and carded once, not once per attempt",
  () =>
    runEffect(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        yield* fs.makeDirectory(runDir(dir, "r1"), { recursive: true });
        yield* writeIntent(
          runDir(dir, "r1"),
          seedIntent("r1", {
            constraints: [
              {
                id: "small",
                kind: "semantic",
                text: "keep it small",
                severity: "warn",
                source: "human",
              },
            ],
          }),
        );
        yield* rig.queueOutputs([{ verdict: "clean", note: "resumed" }]);
        yield* interrupted("r1", suspended("r1"), {
          herdr: busyPane(),
          patience: { firstMs: 10, maxMs: 20, forMs: 100 },
        });
        expect(yield* cardsOf("r1")).toEqual([]);
        const result = yield* releasedInto("r1");
        expect(result._tag).toBe("Success");
        yield* session(started("r1"));
        expect(yield* cardsOf("r1")).toEqual([`review:review:wrote ${outputPath("r1")}`]);
        // The boundary before the work, once: no Herd here, so the judgement says so.
        expect((yield* readDrift(runDir(dir, "r1"))).map((line) => line.kind)).toEqual(["skipped"]);
      }),
    ),
  120_000,
);

test("work the workflow skips opens no tab and starts no agent", () =>
  runEffect(
    Effect.gen(function* () {
      const result = yield* session(started("r1", true));
      expect(result._tag === "Success" && result.success).toEqual(SKIPPED);
      const cmds = yield* rig.cmds();
      expect(cmds.filter((cmd) => cmd === "tab create" || cmd === "agent start")).toEqual([]);
    }),
  ));

/** How far a piece of work has got, as the session running it can see. */
type Reached = Effect.Effect<boolean, never, WorkflowEngine.WorkflowEngine | FileSystem.FileSystem>;

/** The run has parked or otherwise stopped where it is, and the engine knows it. */
const suspended = (runId: string): Reached =>
  Effect.gen(function* () {
    const engine = yield* WorkflowEngine.WorkflowEngine;
    const id = yield* work.executionId({ runId, input: { skip: false } });
    return pollStatus(yield* engine.poll(work, id), "agent-work").status === "suspended";
  });

/** The run has said why it parked, which it does before its step lets go of the work. */
const parked = (runId: string): Reached =>
  FileSystem.FileSystem.pipe(
    Effect.flatMap((fs) => fs.exists(controlPath(dir, PARKED, runId))),
    Effect.orElseSucceed(() => false),
  );

/** An agent has been sent a prompt about this, `times` times. */
const prompted = (about: string, times = 1): Reached =>
  rig.calls().pipe(
    Effect.map((calls) => sent(calls, about) >= times),
    Effect.orElseSucceed(() => false),
  );

/** The agent's Output says this. */
const wrote = (runId: string, about: string): Reached =>
  FileSystem.FileSystem.pipe(
    Effect.flatMap((fs) => fs.readFileString(outputPath(runId))),
    Effect.map((text) => text.includes(about)),
    Effect.orElseSucceed(() => false),
  );

/**
 * A host that goes once its work has got as far as `reached` says, with whatever it is
 * waiting on still out. The work is submitted rather than awaited, so closing the session
 * leaves the engine's journal with a launch in it and no result — which is the window a
 * replay must not fill with a second agent. Watched in real time: getting there is IO,
 * whatever the clock the work runs on says.
 */
const interrupted = (runId: string, reached: Reached, over?: Partial<AgentHost>) =>
  session(
    Effect.gen(function* () {
      yield* work.execute({ runId, input: { skip: false } }, { discard: true });
      for (let tries = 0; !(yield* reached); tries++) {
        if (tries === 3_000) return yield* Effect.die(new Error(`${runId} never got that far`));
        yield* TestClock.withLive(Effect.sleep("10 millis"));
      }
    }),
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
        yield* interrupted("r1", prompted("Your task for this step"));
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

/** `r1`'s agent past its budget: the Run parked, and its work still out, not suspended. */
const pastTheBudget = Effect.gen(function* () {
  yield* until(parked("r1"));
  expect(yield* read(controlPath(dir, PARKED, "r1"))).toContain(
    `has written nothing to ${outputPath("r1")} after 0 minutes idle. Collie keeps collecting it;`,
  );
  expect(yield* read(controlPath(dir, PARKED, "r1"))).not.toContain("resume");
  yield* spend(5_000);
  expect(yield* suspended("r1")).toBe(false);
});

test(
  "an agent idle past its budget parks the Run and is still collected, so its late Output needs no resume",
  () =>
    runEffect(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        // Nothing within the budget: a long build still working, not one that did nothing.
        yield* rig.queueOutputs([null]);
        const result = yield* session(
          Effect.gen(function* () {
            const fiber = yield* Effect.forkChild(started("r1"));
            yield* pastTheBudget;
            yield* fs.writeFileString(outputPath("r1"), `{"verdict":"clean","note":"late"}`);
            return yield* Fiber.join(fiber);
          }),
          { collectMs: 400 },
        );
        expect(result._tag === "Success" && result.success.note).toBe("late");
        expect(yield* fs.exists(controlPath(dir, PARKED, "r1"))).toBe(false);
        expect((yield* rig.cmds()).filter((cmd) => cmd === "agent start")).toHaveLength(1);
      }),
    ),
  120_000,
);

test(
  "an agent that goes while it is collected past its budget is started again, and its Output read",
  () =>
    runEffect(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        yield* rig.queueOutputs([null]);
        const herdr = new FakeHerdr(rig.pluginEnv());
        const starts = rig.cmds().pipe(
          Effect.orDie,
          Effect.map((cmds) => cmds.filter((cmd) => cmd === "agent start").length),
        );
        const result = yield* session(
          Effect.gen(function* () {
            const fiber = yield* Effect.forkChild(started("r1"));
            yield* pastTheBudget;
            // Past the confirmation of its delivery, which would start it again itself.
            yield* until(
              steps("r1").pipe(
                Effect.provideService(Path.Path, yield* Path.Path),
                Effect.map(
                  (found) =>
                    found.length > 0 && found.every((one) => one.delivery.state === "acknowledged"),
                ),
              ),
            );
            const pane = (yield* herdr.agentList()).find(
              (one) => one.name === agentFor("r1"),
            )?.paneId;
            yield* herdr.paneClose(pane ?? "");
            yield* until(starts.pipe(Effect.map((count) => count === 2)));
            yield* fs.writeFileString(outputPath("r1"), `{"verdict":"clean","note":"revived"}`);
            return yield* Fiber.join(fiber);
          }),
          { herdr, collectMs: 400 },
        );
        expect(result._tag === "Success" && result.success.note).toBe("revived");
        expect(yield* fs.exists(controlPath(dir, PARKED, "r1"))).toBe(false);
        expect(yield* starts).toBe(2);
      }),
    ),
  120_000,
);

/** herdr still listing an agent whose process has gone, once `dead`, until one is started. */
class ListsItDead extends FakeHerdr {
  dead = false;
  override agentStatus(target: string) {
    return this.dead
      ? Effect.fail(
          new HerdrError({
            message: "herdr agent get",
            detail: `agent ${target} is not an active named agent`,
            code: "agent_not_ready",
            answered: true,
          }),
        )
      : super.agentStatus(target);
  }
  override agentStart(...args: Parameters<FakeHerdr["agentStart"]>) {
    this.dead = false;
    return super.agentStart(...args);
  }
}

test(
  "an agent herdr still lists but no longer runs while it is collected is started again with its work",
  () =>
    runEffect(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        yield* rig.queueOutputs([null]);
        const herdr = new ListsItDead(rig.pluginEnv({ FAKE_HERDR_NAME_TAKEN: "1" }));
        const starts = rig.cmds().pipe(
          Effect.orDie,
          Effect.map((cmds) => cmds.filter((cmd) => cmd === "agent start").length),
        );
        const result = yield* session(
          Effect.gen(function* () {
            const fiber = yield* Effect.forkChild(started("r1"));
            yield* pastTheBudget;
            yield* until(
              steps("r1").pipe(
                Effect.provideService(Path.Path, yield* Path.Path),
                Effect.map(
                  (found) =>
                    found.length > 0 && found.every((one) => one.delivery.state === "acknowledged"),
                ),
              ),
            );
            herdr.dead = true;
            yield* until(starts.pipe(Effect.map((count) => count === 2)));
            yield* fs.writeFileString(outputPath("r1"), `{"verdict":"clean","note":"revived"}`);
            return yield* Fiber.join(fiber);
          }),
          { herdr, collectMs: 400 },
        );
        expect(result._tag === "Success" && result.success.note).toBe("revived");
        expect(sent(yield* rig.calls(), "Your task for this step")).toBe(2);
      }),
    ),
  120_000,
);

test(
  "a resume sent while the Run is collected past its budget starts no second delivery or collection",
  () =>
    runEffect(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        yield* rig.queueOutputs([null]);
        const result = yield* session(
          Effect.gen(function* () {
            const fiber = yield* Effect.forkChild(started("r1"));
            yield* pastTheBudget;
            const engine = yield* WorkflowEngine.WorkflowEngine;
            yield* engine.resume(
              work,
              yield* work.executionId({ runId: "r1", input: { skip: false } }),
            );
            yield* spend(5_000);
            yield* fs.writeFileString(outputPath("r1"), `{"verdict":"clean","note":"late"}`);
            return yield* Fiber.join(fiber);
          }),
          { collectMs: 400 },
        );
        expect(result._tag === "Success" && result.success.note).toBe("late");
        expect(sent(yield* rig.calls(), "Your task for this step")).toBe(1);
        expect((yield* rig.cmds()).filter((cmd) => cmd === "agent start")).toHaveLength(1);
      }),
    ),
  120_000,
);

test(
  "an agent collected past its budget is still told when its background verify ends",
  () =>
    runEffect(
      Effect.gen(function* () {
        yield* rig.queueOutputs([null]);
        yield* session(
          Effect.gen(function* () {
            yield* work.execute({ runId: "r1", input: { skip: false } }, { discard: true });
            yield* pastTheBudget;
            expect(yield* (yield* Collecting).has("r1", agentFor("r1"))).toBe(true);
          }),
          { collectMs: 400 },
        );
      }),
    ),
  120_000,
);

test(
  "an agent collected past its budget stays collected while Collie looks for it to start again",
  () =>
    runEffect(
      Effect.gen(function* () {
        const starting = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        let blocking = false;
        class SlowStart extends FakeHerdr {
          override agentStart(...args: Parameters<FakeHerdr["agentStart"]>) {
            return blocking
              ? Deferred.succeed(starting, undefined).pipe(
                  Effect.andThen(Deferred.await(release)),
                  Effect.andThen(super.agentStart(...args)),
                )
              : super.agentStart(...args);
          }
        }
        const fs = yield* FileSystem.FileSystem;
        yield* rig.queueOutputs([null]);
        const herdr = new SlowStart(rig.pluginEnv());
        const marked = yield* session(
          Effect.gen(function* () {
            const fiber = yield* Effect.forkChild(started("r1"));
            yield* pastTheBudget;
            yield* until(
              steps("r1").pipe(
                Effect.provideService(Path.Path, yield* Path.Path),
                Effect.map(
                  (found) =>
                    found.length > 0 && found.every((one) => one.delivery.state === "acknowledged"),
                ),
              ),
            );
            blocking = true;
            const pane = (yield* herdr.agentList()).find(
              (one) => one.name === agentFor("r1"),
            )?.paneId;
            yield* herdr.paneClose(pane ?? "");
            yield* Deferred.await(starting);
            const marked = yield* (yield* Collecting).has("r1", agentFor("r1"));
            blocking = false;
            yield* Deferred.succeed(release, undefined);
            yield* fs.writeFileString(outputPath("r1"), `{"verdict":"clean","note":"revived"}`);
            yield* Fiber.join(fiber);
            return marked;
          }),
          { herdr, collectMs: 400 },
        );
        expect(marked).toBe(true);
      }),
    ),
  120_000,
);

test(
  "an agent is still collected while its Run is parked past its budget",
  () =>
    runEffect(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        yield* rig.queueOutputs([null]);
        let marked: boolean | undefined;
        const markedWhenParked = Layer.effect(Host)(
          Effect.gen(function* () {
            const host = yield* Host;
            const collecting = yield* Collecting;
            return Host.of({
              ...host,
              parked: (runId, why) =>
                Effect.gen(function* () {
                  if (why?.includes("has written nothing") && marked === undefined)
                    marked = yield* collecting.has(runId, agentFor(runId));
                  yield* host.parked(runId, why);
                }),
            });
          }),
        );
        yield* Effect.gen(function* () {
          const fiber = yield* Effect.forkChild(started("r1"));
          yield* pastTheBudget;
          yield* fs.writeFileString(outputPath("r1"), `{"verdict":"clean","note":"late"}`);
          yield* Fiber.join(fiber);
        }).pipe(
          Effect.provide(body),
          Effect.provide(markedWhenParked),
          Effect.provide(agentsLayer({ ...hostOf(), collectMs: 400 })),
          Effect.provide(foundationLayer({ dir })),
          Effect.scoped,
          Effect.orDie,
        );
        expect(marked).toBe(true);
      }),
    ),
  120_000,
);

test(
  "a stop while the Run is collected past its budget ends the wait",
  () =>
    runEffect(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        yield* rig.queueOutputs([null]);
        yield* session(
          Effect.gen(function* () {
            yield* work.execute({ runId: "r1", input: { skip: false } }, { discard: true });
            yield* pastTheBudget;
            yield* fs.writeFileString(controlPath(dir, STOP, "r1"), "").pipe(Effect.orDie);
            yield* until(suspended("r1"));
            expect(yield* (yield* Collecting).has("r1", agentFor("r1"))).toBe(false);
          }),
          { collectMs: 400 },
        );
      }),
    ),
  120_000,
);

test(
  "a restart while the Run is collected past its budget reattaches and returns the late Output",
  () =>
    runEffect(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        yield* rig.queueOutputs([null]);
        yield* interrupted("r1", parked("r1"), { collectMs: 400 });
        expect(yield* suspended("r1").pipe(session)).toBe(false);

        yield* fs.writeFileString(outputPath("r1"), `{"verdict":"clean","note":"late"}`);
        const result = yield* session(started("r1"), { collectMs: 400 });
        expect(result._tag === "Success" && result.success.note).toBe("late");
        expect(yield* fs.exists(controlPath(dir, PARKED, "r1"))).toBe(false);
        expect((yield* rig.cmds()).filter((cmd) => cmd === "agent start")).toHaveLength(1);
      }),
    ),
  120_000,
);

/** Ends once the Run parks, with that as its result. */
const untilParked = (runId: string) =>
  Effect.gen(function* () {
    while (!(yield* parked(runId))) yield* TestClock.withLive(Effect.sleep("10 millis"));
    return "parked" as const;
  });

/** An agent herdr reports busy until its Output is written. */
class BusyUntilWritten extends FakeHerdr {
  reads = 0;
  written = false;
  constructor(private readonly busy: "working" | "blocked") {
    super(rig.pluginEnv());
  }
  override agentStatus() {
    this.reads += 1;
    return Effect.succeed(this.written ? ("idle" as const) : this.busy);
  }
}

for (const busy of ["working", "blocked"] as const)
  test(
    `an agent herdr reports ${busy} far past the budget is collected, never parked`,
    () =>
      runEffect(
        Effect.gen(function* () {
          yield* rig.queueOutputs([null]);
          const herdr = new BusyUntilWritten(busy);
          // Five budgets' worth of polls at 20ms against 400ms, then the Output.
          const writes = Effect.gen(function* () {
            while (herdr.reads < 100) yield* TestClock.withLive(Effect.sleep("10 millis"));
            yield* (yield* FileSystem.FileSystem).writeFileString(
              outputPath("r1"),
              `{"verdict":"clean","note":"after the suite"}`,
            );
            herdr.written = true;
          });
          const result = yield* session(
            Effect.forkChild(writes).pipe(
              Effect.andThen(Effect.raceFirst(started("r1"), untilParked("r1"))),
            ),
            { herdr, collectMs: 400 },
          );
          expect(result).not.toBe("parked");
          expect(result !== "parked" && result._tag === "Success" && result.success.note).toBe(
            "after the suite",
          );
        }),
      ),
    60_000,
  );

/** An agent herdr reports working from when it is asked to rewrite until it is done. */
class RewritingAfterRepair extends FakeHerdr {
  rewriting = false;
  done = false;
  constructor() {
    super(rig.pluginEnv());
  }
  override agentStatus() {
    return Effect.succeed(this.rewriting && !this.done ? ("working" as const) : ("idle" as const));
  }
}

test("a repaired Output caught half rewritten is judged when the agent's turn ends", () =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      yield* rig.queueOutputs([{ verdict: "maybe" }, null]);
      const herdr = new RewritingAfterRepair();
      const rewrites = Effect.gen(function* () {
        while (!(yield* prompted("not usable")))
          yield* TestClock.withLive(Effect.sleep("10 millis"));
        herdr.rewriting = true;
        yield* fs.writeFileString(outputPath("r1"), `{"verdict":"clean"}`);
        yield* TestClock.withLive(Effect.sleep("300 millis"));
        yield* fs.writeFileString(outputPath("r1"), `{"verdict":"clean","note":"in the turn"}`);
        herdr.done = true;
      });
      const result = yield* session(
        Effect.forkChild(rewrites).pipe(Effect.andThen(started("r1"))),
        { herdr },
      );
      expect(result._tag === "Success" && result.success.note).toBe("in the turn");
      expect(sent(yield* rig.calls(), "not usable")).toBe(1);
    }),
  ));

const HALF = `{"verdict":"clean"}`;

/** Once asked to repair, starts its rewrite as one status reply goes out and ends it as the next does. */
class FinishingWhileAsked extends FakeHerdr {
  repairing = false;
  constructor(private readonly fs: FileSystem.FileSystem) {
    super(rig.pluginEnv());
  }
  override agentStatus() {
    const { fs, repairing } = this;
    return Effect.gen(function* () {
      const now = yield* fs.readFileString(outputPath("r1")).pipe(Effect.orElseSucceed(() => ""));
      if (repairing && now === `{"verdict":"maybe"}`) {
        yield* fs.writeFileString(outputPath("r1"), HALF);
        return "working" as const;
      }
      if (now === HALF)
        yield* fs.writeFileString(outputPath("r1"), `{"verdict":"clean","note":"as it ended"}`);
      return "idle" as const;
    }).pipe(Effect.orDie);
  }
}

test("a repaired Output finished between its read and the turn ending is read again", () =>
  runEffect(
    Effect.gen(function* () {
      yield* rig.queueOutputs([{ verdict: "maybe" }, null]);
      const herdr = new FinishingWhileAsked(yield* FileSystem.FileSystem);
      const repairing = Effect.gen(function* () {
        while (!(yield* prompted("not usable")))
          yield* TestClock.withLive(Effect.sleep("10 millis"));
        herdr.repairing = true;
      });
      const result = yield* session(
        Effect.forkChild(repairing).pipe(Effect.andThen(started("r1"))),
        { herdr },
      );
      expect(result._tag === "Success" && result.success.note).toBe("as it ended");
    }),
  ));

for (const [what, herdr] of [
  ["idle", () => new FakeHerdr(rig.pluginEnv())],
  ["unreadable", () => new Unreadable(rig.pluginEnv())],
] as const)
  test(
    `an agent whose status is ${what} and that writes nothing parks once the budget is spent idle`,
    () =>
      runEffect(
        Effect.gen(function* () {
          yield* rig.queueOutputs([null]);
          yield* interrupted("r1", parked("r1"), {
            herdr: herdr(),
            pollMs: 1_000,
            collectMs: 120_000,
          });
          expect(yield* read(controlPath(dir, PARKED, "r1"))).toContain(
            `has written nothing to ${outputPath("r1")} after 2 minutes idle. Collie keeps collecting it;`,
          );
        }),
      ),
    60_000,
  );

/** Claude's `PreToolUse` for one `AskUserQuestion` call of two questions. */
const askedTwo = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown))({
  session_id: "s-1",
  hook_event_name: "PreToolUse",
  tool_name: "AskUserQuestion",
  tool_use_id: "toolu_1",
  tool_input: {
    questions: [
      {
        question: "Which database?",
        header: "Database",
        options: [
          { label: "Postgres", description: "the one ops runs" },
          { label: "SQLite", description: "a file beside the app" },
        ],
        multiSelect: false,
      },
      {
        question: "Which checks?",
        header: "Checks",
        options: [{ label: "lint", description: "oxlint" }],
        multiSelect: true,
      },
    ],
  },
});

const ANSWERED = "Your questions are answered:";

/** Once `r1`'s agent has its work, it calls `AskUserQuestion` with two questions. */
const asksTwo = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  while (!(yield* fs.exists(`${dir}/agents/r1/review.launch.json`)))
    yield* TestClock.withLive(Effect.sleep("10 millis"));
  // The host runs in this process; the hook puts a question on a Run only while one lives.
  yield* fs.writeFileString(
    hostLockOf(rig.pluginEnv().stateDir),
    `{"pid":${process.pid},"start":null}`,
  );
  yield* recordClaudeEvent(yield* controlDir(rig.pluginEnv().stateDir, agentFor("r1")), askedTwo);
}).pipe(Effect.orDie);

/** `r1`'s questions once there are `count` of them, by name. */
const questionsOf = (count: number) =>
  Effect.gen(function* () {
    const store = yield* Store;
    for (;;) {
      const asked = yield* store.asked("r1");
      if (asked.length >= count) return asked;
      yield* TestClock.withLive(Effect.sleep("10 millis"));
    }
  });

const answer = (decision: string, value: string, answerer?: AuditLine["actor"]) =>
  Store.pipe(
    Effect.flatMap((store) =>
      store.settle({ run: "r1", decision, value, request: `answer-${decision}`, answerer }),
    ),
  );

/** Waits out `ms` on the run's own clock. */
const spend = (ms: number) =>
  Effect.gen(function* () {
    const until = (yield* Clock.currentTimeMillis) + ms;
    while ((yield* Clock.currentTimeMillis) < until)
      yield* TestClock.withLive(Effect.sleep("10 millis"));
  });

test(
  "an agent's two questions are open Decisions on its Run, and both answers go back as one Delivery",
  () =>
    runEffect(
      Effect.gen(function* () {
        yield* rig.queueOutputs([null]);
        yield* session(
          Effect.gen(function* () {
            yield* work.execute({ runId: "r1", input: { skip: false } }, { discard: true });
            yield* asksTwo;
            const asked = yield* questionsOf(2);
            expect(asked.map((one) => [one.decision, one.answer])).toEqual([
              ["ask-review-1", null],
              ["ask-review-2", null],
            ]);
            expect(asked[0]?.prompt).toBe(
              "Database: Which database?\nPostgres — the one ops runs\nSQLite — a file beside the app\nAnswer with an option or in your own words.",
            );
            expect(asked[1]?.prompt).toBe(
              "Checks: Which checks?\nlint — oxlint\n(choose any)\nAnswer with an option or in your own words.",
            );

            yield* answer("ask-review-1", "SQLite, it is a demo");
            yield* spend(5_000);
            expect(sent(yield* rig.calls(), ANSWERED)).toBe(0);

            yield* answer("ask-review-2", "lint");
            while (!(yield* prompted(ANSWERED)))
              yield* TestClock.withLive(Effect.sleep("10 millis"));
            yield* spend(5_000);
            const calls = yield* rig.calls();
            expect(sent(calls, ANSWERED)).toBe(1);
            const delivered = calls.find((call) => (call.argv?.[3] ?? "").includes(ANSWERED));
            expect(delivered?.argv?.[3]).toEndWith(
              "\nYour questions are answered: Database: SQLite, it is a demo; Checks: lint",
            );
          }),
          { collectMs: 120_000, pollMs: 1_000 },
        );
      }),
    ),
  120_000,
);

test(
  "answers from different senders each reach the agent under their own sender line",
  () =>
    runEffect(
      Effect.gen(function* () {
        yield* rig.queueOutputs([null]);
        yield* session(
          Effect.gen(function* () {
            yield* work.execute({ runId: "r1", input: { skip: false } }, { discard: true });
            yield* asksTwo;
            yield* questionsOf(2);
            yield* answer("ask-review-1", "SQLite", {
              origin: "agent",
              requestId: "answer-ask-review-1",
              from: { run: "r-other", agent: "r-other-build-r1" },
            });
            yield* answer("ask-review-2", "lint", {
              origin: "board",
              requestId: "answer-ask-review-2",
            });
            while (!(yield* prompted("is answered", 2)))
              yield* TestClock.withLive(Effect.sleep("10 millis"));
            const typed = (yield* rig.calls())
              .map((call) => call.argv?.[3] ?? "")
              .filter((one) => one.includes("is answered"));
            expect(typed).toHaveLength(2);
            expect(typed.find((one) => one.includes("Database"))).toMatch(
              /From r-other-build-r1 of r-other [^\n]*\nYour question Database is answered: SQLite$/,
            );
            expect(typed.find((one) => one.includes("Checks"))).toMatch(
              /From the human, on the board, [^\n]*\nYour question Checks is answered: lint$/,
            );
          }),
          { collectMs: 120_000, pollMs: 1_000 },
        );
      }),
    ),
  120_000,
);

test(
  "an open question pauses an idle agent's Output budget, which runs again once it is answered",
  () =>
    runEffect(
      Effect.gen(function* () {
        yield* rig.queueOutputs([null]);
        yield* session(
          Effect.gen(function* () {
            yield* work.execute({ runId: "r1", input: { skip: false } }, { discard: true });
            yield* asksTwo;
            yield* questionsOf(2);
            yield* spend(150_000);
            expect(yield* parked("r1")).toBe(false);

            yield* answer("ask-review-1", "Postgres");
            yield* answer("ask-review-2", "lint");
            while (!(yield* parked("r1"))) yield* TestClock.withLive(Effect.sleep("10 millis"));
          }),
          { collectMs: 60_000, pollMs: 1_000 },
        );
        expect(yield* read(controlPath(dir, PARKED, "r1"))).toContain("after 1 minutes idle");
      }),
    ),
  120_000,
);

test(
  "a question still open when the Output comes is closed, and nothing is sent",
  () =>
    runEffect(
      Effect.gen(function* () {
        yield* rig.queueOutputs([null]);
        const result = yield* session(
          Effect.gen(function* () {
            const fiber = yield* Effect.forkChild(started("r1"));
            yield* asksTwo;
            yield* questionsOf(2);
            yield* answer("ask-review-1", "Postgres");
            yield* (yield* FileSystem.FileSystem).writeFileString(
              outputPath("r1"),
              `{"verdict":"clean","note":"decided for itself"}`,
            );
            const done = yield* Fiber.join(fiber);
            const asked = yield* (yield* Store).asked("r1");
            expect(asked.map((one) => [one.decision, one.answer])).toEqual([
              ["ask-review-1", "Postgres"],
              ["ask-review-2", "closed: review finished before it was answered"],
            ]);
            return done;
          }),
          { collectMs: 120_000, pollMs: 1_000 },
        );
        expect(result._tag).toBe("Success");
        expect(sent(yield* rig.calls(), ANSWERED)).toBe(0);
      }),
    ),
  120_000,
);

/** `r1`'s questions as the host tends them, read from and written to its Store. */
const tendR1 = Effect.gen(function* () {
  const store = yield* Store;
  yield* (yield* Agents).tendQuestions((run) => ({
    ask: (question, asker) =>
      store.asking({
        run,
        decision: question.name,
        prompt: question.prompt,
        options: question.options,
        asker,
      }),
    asked: store
      .asked(run)
      .pipe(Effect.map((rows) => rows.map((row) => ({ name: row.decision, answer: row.answer })))),
    close: (decision, value) =>
      store.settle({ run, decision, value, request: `closed-${decision}` }).pipe(Effect.asVoid),
  }));
});

/** `r1` finished, and its agent asked two questions after. */
const finishedThenAsked = Effect.gen(function* () {
  yield* rig.queueOutputs([{ verdict: "clean", note: "done" }]);
  yield* session(
    Effect.gen(function* () {
      expect((yield* started("r1"))._tag).toBe("Success");
      yield* asksTwo;
    }),
  );
});

const answersOfR1 = Effect.suspend(() =>
  session(
    Store.pipe(Effect.flatMap((store) => store.asked("r1"))).pipe(
      Effect.map((rows) => rows.map((one) => one.answer)),
    ),
  ),
);

test("a question whose agent is live in another Herd, or whose Herds cannot be listed, stays open", () =>
  runEffect(
    Effect.gen(function* () {
      yield* finishedThenAsked;
      const first = `${rig.root}/first.sock`;
      const second = `${rig.root}/second.sock`;
      const sessions = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown))([
        { name: "desk", socket_path: first },
        { name: "builds", socket_path: second },
      ]);
      for (const over of [
        { FAKE_HERDR_SESSIONS: sessions, FAKE_HERDR_FAIL: "" },
        { FAKE_HERDR_SESSIONS: "", FAKE_HERDR_FAIL: '{"session list":"herdr is restarting"}' },
      ])
        yield* session(tendR1, {
          herdr: new FakeHerdr(
            rig.pluginEnv({ HERDR_SOCKET_PATH: first, FAKE_HERDR_AGENTS_IN: second, ...over }),
          ),
        });
      expect(yield* answersOfR1).toEqual([null, null]);

      yield* session(tendR1, {
        herdr: new FakeHerdr(
          rig.pluginEnv({ FAKE_HERDR_SESSIONS: sessions, FAKE_HERDR_AGENTS_GONE: agentFor("r1") }),
        ),
      });
      expect(yield* answersOfR1).toEqual([
        `closed: ${agentFor("r1")} is gone`,
        `closed: ${agentFor("r1")} is gone`,
      ]);
    }),
  ));

test("an answer to an agent live only in another Herd is sent to it there", () =>
  runEffect(
    Effect.gen(function* () {
      yield* finishedThenAsked;
      const first = `${rig.root}/first.sock`;
      const second = `${rig.root}/second.sock`;
      const herdr = new FakeHerdr(
        rig.pluginEnv({
          HERDR_SOCKET_PATH: first,
          FAKE_HERDR_AGENTS_IN: second,
          FAKE_HERDR_SESSIONS: Schema.encodeSync(Schema.fromJsonString(Schema.Unknown))([
            { name: "desk", socket_path: first },
            { name: "builds", socket_path: second },
          ]),
        }),
      );
      yield* session(
        Effect.gen(function* () {
          yield* tendR1;
          yield* answer("ask-review-1", "Postgres");
          yield* answer("ask-review-2", "lint");
          yield* tendR1;
        }),
        { herdr },
      );
      expect(sent(yield* rig.calls(), ANSWERED)).toBe(1);
    }),
  ));

test("a question asked before the agent's next launch is answered while that launch is collected", () =>
  runEffect(
    Effect.gen(function* () {
      yield* finishedThenAsked;
      const fs = yield* FileSystem.FileSystem;
      const asked = yield* questionsSince(
        yield* controlDir(rig.pluginEnv().stateDir, agentFor("r1")),
        0,
      );
      const first = Schema.decodeUnknownSync(Schema.fromJsonString(Launched))(
        yield* fs.readFileString(`${dir}/agents/r1/review.launch.json`),
      );
      const next = { ...first, operation: "fix", at: Math.max(...asked.map((one) => one.at)) + 1 };
      yield* fs.writeFileString(
        `${dir}/agents/r1/fix.launch.json`,
        Schema.encodeSync(Schema.fromJsonString(Launched))(next),
      );
      yield* session(
        Effect.gen(function* () {
          const collecting = yield* Collecting;
          yield* collecting.during("r1", agentFor("r1"), tendR1, "fix");
        }),
      );
      expect(yield* answersOfR1).toEqual([null, null]);
    }),
  ));

test(
  "a restart between the attempts hands out no second repair",
  () =>
    runEffect(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        // The first Output is unusable and nothing answers the repair, so the host goes
        // with the repair's own collection still out.
        yield* rig.queueOutputs([{ verdict: "maybe" }, null]);
        yield* interrupted("r1", prompted("not usable"));
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
      expect((yield* steps("r1")).map((one) => one.delivery.state)).toEqual(["acknowledged"]);
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
        yield* interrupted("r1", suspended("r1"), {
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
        expect((yield* steps("r1")).map((one) => one.delivery.state)).toEqual(["acknowledged"]);
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

/** The permission mode the agent was started in, as the launch passed it to claude. */
const permissionModeOf = (args: ReadonlyArray<string>) =>
  args[args.indexOf("--permission-mode") + 1];

test("the agent is started on the operator's harness, model and permissions, with the role as its persona", () =>
  runEffect(
    Effect.gen(function* () {
      yield* rig.queueOutputs([{ verdict: "clean", note: "done" }]);
      yield* session(started("r1"));

      const args = launchArgs(yield* rig.calls());
      expect(args.slice(0, 2)).toEqual(["--model", "opus"]);
      expect(permissionModeOf(args)).toBe("auto");
      const persona = args[args.indexOf("--append-system-prompt-file") + 1] ?? "";
      expect(yield* read(persona)).toContain("You are the reviewer.");
    }),
  ));

test("a Claude agent is given its Run's directory", () =>
  runEffect(
    Effect.gen(function* () {
      yield* rig.queueOutputs([{ verdict: "clean", note: "done" }]);
      yield* session(started("r1"));
      const args = launchArgs(yield* rig.calls());
      expect(args).toContain("--add-dir");
      expect(args[args.indexOf("--add-dir") + 1]).toBe(runDir(dir, "r1"));
    }),
  ));

test("a Codex agent is given no directory to add", () =>
  runEffect(
    Effect.gen(function* () {
      yield* rig.queueOutputs([{ verdict: "clean", note: "done" }]);
      yield* session(started("r1"), { ...claudeOut, fallbacks: Effect.succeed(["codex"]) });
      expect(harnessesStarted(yield* rig.calls())).toEqual(["codex"]);
      expect(launchArgs(yield* rig.calls())).not.toContain("--add-dir");
    }),
  ));

const writePersona = (layer: string, name: string, text: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    yield* fs.makeDirectory(`${layer}/personas`, { recursive: true });
    yield* fs.writeFileString(`${layer}/personas/${name}.md`, text);
  });

/** The persona file the review agent was started with. */
const personaFileText = Effect.gen(function* () {
  const args = launchArgs(yield* rig.calls());
  return yield* read(args[args.indexOf("--append-system-prompt-file") + 1] ?? "");
});

test("a persona from the user Layer is followed by the every-agent text", () =>
  runEffect(
    Effect.gen(function* () {
      yield* writePersona(rig.userDir, "reviewer", "You review closely.\n");
      yield* writePersona(rig.userDir, "every-agent", "Make no Tautology.\n");
      yield* rig.queueOutputs([{ verdict: "clean", note: "done" }]);
      yield* session(started("r1"));

      expect(yield* personaFileText).toBe("You review closely.\n\nMake no Tautology.\n");
    }),
  ));

test("a role with no persona is its one line, then the every-agent text", () =>
  runEffect(
    Effect.gen(function* () {
      yield* writePersona(rig.userDir, "every-agent", "Make no Tautology.\n");
      yield* rig.queueOutputs([{ verdict: "clean", note: "done" }]);
      yield* session(started("r1"));

      expect(yield* personaFileText).toBe("You are the reviewer.\n\nMake no Tautology.\n");
    }),
  ));

test.each(["user", "project"] as const)("a %s every-agent replaces the installation's", (layer) =>
  runEffect(
    Effect.gen(function* () {
      yield* writePersona(rig.baselineDir, "every-agent", "The installation's rule.\n");
      const dir = layer === "user" ? rig.userDir : `${rig.projectDir}/.collie`;
      yield* writePersona(dir, "every-agent", `The ${layer}'s rule.\n`);
      yield* rig.queueOutputs([{ verdict: "clean", note: "done" }]);
      yield* session(started("r1"));

      expect(yield* personaFileText).toBe(`You are the reviewer.\n\nThe ${layer}'s rule.\n`);
    }),
  ),
);

test("an operator who opts into bypass has the agent started past its prompts", () =>
  runEffect(
    Effect.gen(function* () {
      yield* rig.queueOutputs([{ verdict: "clean", note: "done" }]);
      yield* session(started("r1"), { permissions: "bypass" });

      expect(permissionModeOf(launchArgs(yield* rig.calls()))).toBe("bypassPermissions");
    }),
  ));

test("a bypass written to the config after the host started reaches the next agent", () =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const userDir = rig.pluginEnv().userDir;
      yield* fs.makeDirectory(userDir, { recursive: true });
      yield* fs.writeFileString(`${userDir}/config.json`, `{ "permissions": "bypass" }`);
      yield* rig.queueOutputs([{ verdict: "clean", note: "done" }]);
      yield* session(started("r1"), { permissions: "auto" });

      expect(permissionModeOf(launchArgs(yield* rig.calls()))).toBe("bypassPermissions");
    }),
  ));

test("bypass falls back to auto mode where Claude Code's managed settings forbid it, and says so", () =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const managed = rig.pluginEnv().claudeManagedDir;
      yield* fs.makeDirectory(managed, { recursive: true });
      yield* fs.writeFileString(
        `${managed}/managed-settings.json`,
        `{ "permissions": { "disableBypassPermissionsMode": "disable" } }`,
      );
      yield* rig.queueOutputs([{ verdict: "clean", note: "done" }]);
      yield* session(started("r1"), { permissions: "bypass" });

      expect(permissionModeOf(launchArgs(yield* rig.calls()))).toBe("auto");
      expect(yield* read(`${dir}/agents/r1/agents.log`)).toContain(
        "permissions auto: claude's managed settings forbid bypass",
      );
    }),
  ));

test(
  "a persona naming what nothing fills parks the launch, and the fixed file is what resumes",
  () =>
    runEffect(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const personas = `${rig.pluginEnv().userDir}/personas`;
        yield* fs.makeDirectory(personas, { recursive: true });
        yield* fs.writeFileString(`${personas}/reviewer.md`, "Review {{inputs.target}}.\n");
        yield* rig.queueOutputs([{ verdict: "clean", note: "resumed" }]);
        yield* interrupted("r1", suspended("r1"));

        expect(yield* statusNow("r1")).toBe("suspended");
        expect(yield* read(controlPath(dir, PARKED, "r1"))).toContain(
          `the reviewer persona in ${personas}/reviewer.md names {{inputs.target}}`,
        );
        expect((yield* rig.cmds()).filter((cmd) => cmd === "agent start")).toEqual([]);

        yield* fs.writeFileString(`${personas}/reviewer.md`, "You review.\n");
        const result = yield* releasedInto("r1");
        expect(result._tag === "Success" && result.success.note).toBe("resumed");
        expect((yield* rig.cmds()).filter((cmd) => cmd === "agent start")).toHaveLength(1);
      }),
    ),
  120_000,
);

/** This test's own ~/.claude.json: the rig's HOME is its temporary root. */
const claudeJson = () => `${rig.root}/.claude.json`;

const claudeKnows = (projects: Record<string, { readonly hasTrustDialogAccepted: boolean }>) =>
  FileSystem.FileSystem.pipe(
    Effect.flatMap((fs) =>
      fs.writeFileString(claudeJson(), JSON.stringify({ numStartups: 3, projects })),
    ),
  );

const trustedByClaude = () => claudeTrust(rig.root, rig.pluginEnv().stateDir).state(rig.projectDir);

test("an agent launched under trust auto finds its untrusted directory trusted before its harness starts", () =>
  runEffect(
    Effect.gen(function* () {
      yield* claudeKnows({ "/elsewhere": { hasTrustDialogAccepted: true } });
      yield* rig.queueOutputs([{ verdict: "clean", note: "done" }]);
      yield* session(started("r1"));

      expect(yield* trustedByClaude()).toBe("trusted");
      const log = yield* read(`${dir}/agents/r1/agents.log`);
      const granted = log.indexOf(`trust claude: trusted ${rig.projectDir}`);
      expect(granted).toBeGreaterThanOrEqual(0);
      expect(granted).toBeLessThan(log.indexOf(`${agentFor("r1")}: claude in`));
    }),
  ));

test("under trust never an agent's directory is left for its harness to ask about", () =>
  runEffect(
    Effect.gen(function* () {
      yield* claudeKnows({});
      yield* rig.queueOutputs([{ verdict: "clean", note: "done" }]);
      yield* session(started("r1"), { trust: "never" });

      expect(yield* trustedByClaude()).toBe("untrusted");
    }),
  ));

test("a config claude cannot read still launches the agent, and the log says why nothing was written", () =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      yield* fs.writeFileString(claudeJson(), "{ half written");
      yield* rig.queueOutputs([{ verdict: "clean", note: "done" }]);
      const result = yield* session(started("r1"));

      expect(result._tag).toBe("Success");
      expect(yield* fs.readFileString(claudeJson())).toBe("{ half written");
      expect(yield* read(`${dir}/agents/r1/agents.log`)).toContain(
        `trust claude: claude's record of trusted directories is missing or not readable; nothing written for ${rig.projectDir}`,
      );
    }),
  ));

test("a directory claude already trusts is not written", () =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      yield* claudeKnows({ [rig.projectDir]: { hasTrustDialogAccepted: true } });
      const before = yield* fs.readFileString(claudeJson());
      yield* rig.queueOutputs([{ verdict: "clean", note: "done" }]);
      yield* session(started("r1"));

      expect(yield* fs.readFileString(claudeJson())).toBe(before);
      expect(yield* fs.exists(`${rig.pluginEnv().stateDir}/claude.json.bak`)).toBe(false);
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
        yield* interrupted("r1", prompted("Your task for this step"));
        // The halting host recovers the work too, and must not give up its wait while the
        // agent it is halting is still there to be seen.
        yield* session(halted("r1"), { collectMs: 30_000 });

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

const claudeOut = {
  readings: Effect.succeed([
    {
      subscription: "claude",
      account: "org:acct",
      accountLabel: null,
      plan: "max",
      windows: [
        {
          kind: "session",
          label: "Session",
          model: null,
          usedPercent: 100,
          resetsAt: "2099-01-01T15:45:00Z",
          reached: false,
        },
      ],
      at: "2026-10-08T08:00:00Z",
      source: "claude-usage",
      problem: null,
    },
  ] satisfies ReadonlyArray<UsageReading>),
};
const launchOf = (runId: string) =>
  read(`${dir}/agents/${runId}/review.launch.json`).pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(Launched))),
    Effect.orDie,
  );
test("an agent's launch record keeps the harness session herdr reports for it", () =>
  runEffect(
    Effect.gen(function* () {
      yield* rig.queueOutputs([{ verdict: "clean", note: "done" }]);
      class Sessioned extends FakeHerdr {
        override agentList() {
          return super
            .agentList()
            .pipe(
              Effect.map((agents) =>
                agents.map((one) => ({ ...one, agentSession: { kind: "claude", value: "s-1" } })),
              ),
            );
        }
      }
      yield* session(started("r1"), { herdr: new Sessioned(rig.pluginEnv()) });
      const launched = yield* launchOf("r1");
      expect(launched.terminalId).toBeDefined();
      expect(launched.agentSession).toEqual({ kind: "claude", value: "s-1" });
    }),
  ));

const harnessesStarted = (calls: ReadonlyArray<Call>) =>
  calls
    .filter((call) => (call.argv ?? [])[1] === "start")
    .map((call) => (call.argv ?? []).find((arg) => arg === "claude" || arg === "codex"));

test("work whose Subscription is Exhausted starts on the first chain entry with room, and its record says why", () =>
  runEffect(
    Effect.gen(function* () {
      yield* rig.queueOutputs([{ verdict: "clean", note: "done" }]);
      yield* session(started("r1"), { ...claudeOut, fallbacks: Effect.succeed(["codex"]) });

      expect(harnessesStarted(yield* rig.calls())).toEqual(["codex"]);
      const launched = yield* launchOf("r1");
      expect(launchArgs(yield* rig.calls())).toContain("--dangerously-bypass-hook-trust");
      expect(launched).toMatchObject({
        harness: "codex",
        model: "default",
        from: { harness: "claude", model: "opus", effort: null },
      });
      expect(launched.why).toMatch(/^session 100%, resets .+$/);
      expect(yield* read(`${dir}/agents/r1/agents.log`)).toContain(
        "review: fell back from claude/opus to codex/default: session 100%",
      );
    }),
  ));

test("on a harness with no persona flag, the first prompt opens with the persona and the every-agent text", () =>
  runEffect(
    Effect.gen(function* () {
      yield* writePersona(rig.userDir, "every-agent", "Make no Tautology.\n");
      yield* rig.queueOutputs([{ verdict: "clean", note: "done" }]);
      yield* session(started("r1"), { ...claudeOut, fallbacks: Effect.succeed(["codex"]) });

      expect(harnessesStarted(yield* rig.calls())).toEqual(["codex"]);
      expect(yield* read(promptPath("r1"))).toContain(
        "\n\nYou are the reviewer.\n\nMake no Tautology.\n\n",
      );
    }),
  ));

test("with no fallbacks, Exhausted work starts on Claude as it always has", () =>
  runEffect(
    Effect.gen(function* () {
      yield* rig.queueOutputs([{ verdict: "clean", note: "done" }]);
      yield* session(started("r1"), { ...claudeOut, fallbacks: Effect.succeed([]) });

      expect(harnessesStarted(yield* rig.calls())).toEqual(["claude"]);
      const launched = yield* launchOf("r1");
      expect(launched.from).toBeUndefined();
      expect(launched.why).toMatch(/^nothing has room; claude\/opus: session 100%/);
    }),
  ));

test(
  "a replay after a restart starts the agent the work fell back to, whatever the readings say now",
  () =>
    runEffect(
      Effect.gen(function* () {
        yield* rig.queueOutputs([null, { verdict: "clean", note: "back" }]);
        const chain = { fallbacks: Effect.succeed(["codex"]) };
        yield* interrupted("r1", prompted("Your task for this step"), { ...claudeOut, ...chain });
        yield* session(halted("r1"), { collectMs: 30_000 });

        // Claude has room again by the time the host comes back.
        const result = yield* session(started("r1"), chain);
        expect(result._tag === "Success" && result.success.note).toBe("back");
        const calls = yield* rig.calls();
        expect(harnessesStarted(calls)).toEqual(["codex", "codex"]);
        for (const call of calls.filter((call) => call.cmd === "agent start"))
          expect(call.argv).toContain("--dangerously-bypass-hook-trust");
      }),
    ),
  120_000,
);

/** Claude Code's own hook, saying the agent stopped on its spent subscription. */
const rateLimited = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown))({
  session_id: "s-out",
  hook_event_name: "StopFailure",
  error: "rate_limit",
  transcript_path: "/home/mk/.claude/projects/p/s-out.jsonl",
});

/** Once `agent` has been given its work, its harness says it ran out. */
const runsOut = (agent: string, times = 1) =>
  Effect.gen(function* () {
    const given = rig.calls().pipe(
      Effect.map((calls) => sent(calls, "Your task for this step") >= times),
      Effect.orElseSucceed(() => false),
    );
    while (!(yield* given)) yield* TestClock.withLive(Effect.sleep("10 millis"));
    yield* recordClaudeEvent(yield* controlDir(rig.pluginEnv().stateDir, agent), rateLimited);
  }).pipe(Effect.orDie);

const closedPanes = (calls: ReadonlyArray<Call>) =>
  calls.filter((call) => (call.argv ?? [])[0] === "pane" && (call.argv ?? [])[1] === "close");
const chain = { fallbacks: Effect.succeed(["codex"]) };

test("a waiting agent switches when a fallback is configured after it ran out", () =>
  runEffect(
    Effect.gen(function* () {
      yield* rig.queueOutputs([null, { verdict: "clean", note: "fallback became available" }]);
      let fallbacks: ReadonlyArray<string> = [];
      yield* Effect.forkScoped(
        Effect.gen(function* () {
          yield* runsOut(agentFor("r1"));
          while (!(yield* read(`${dir}/agents/r1/agents.log`)).includes("nothing has room"))
            yield* TestClock.withLive(Effect.sleep("10 millis"));
          fallbacks = ["codex/gpt-6.1-sol"];
          yield* TestClock.adjust("1 minute");
        }),
      );
      const result = yield* session(started("r1"), {
        fallbacks: Effect.sync(() => fallbacks),
        collectMs: 300_000,
      });
      expect(result._tag === "Success" && result.success.note).toBe("fallback became available");
      const calls = yield* rig.calls();
      expect(closedPanes(calls)).toHaveLength(1);
      expect(harnessesStarted(calls)).toEqual(["claude", "codex"]);
      expect((yield* runAgents(dir, "r1"))[1]?.model).toBe("gpt-6.1-sol");
    }).pipe(Effect.scoped),
  ));

test("an agent that ran out and stays idle past its budget parks the Run, and one with room takes the work with no resume", () =>
  runEffect(
    Effect.gen(function* () {
      yield* rig.queueOutputs([null, { verdict: "clean", note: "room came" }]);
      let fallbacks: ReadonlyArray<string> = [];
      const result = yield* session(
        Effect.gen(function* () {
          yield* Effect.forkChild(runsOut(agentFor("r1")));
          const fiber = yield* Effect.forkChild(started("r1"));
          yield* until(parkedSays("before writing"));
          const why = yield* read(controlPath(dir, PARKED, "r1"));
          expect(why).toContain("ran out (rate_limit) before writing");
          expect(why).toEndWith("Collie keeps collecting it.");
          expect(why).not.toContain("Resume");
          yield* spend(5_000);
          expect(yield* suspended("r1")).toBe(false);
          fallbacks = ["codex/gpt-6.1-sol"];
          yield* TestClock.adjust("1 minute");
          return yield* Fiber.join(fiber);
        }),
        { fallbacks: Effect.sync(() => fallbacks), collectMs: 2_000 },
      );
      expect(result._tag === "Success" && result.success.note).toBe("room came");
      expect(harnessesStarted(yield* rig.calls())).toEqual(["claude", "codex"]);
      expect(yield* (yield* FileSystem.FileSystem).exists(controlPath(dir, PARKED, "r1"))).toBe(
        false,
      );
    }),
  ));

test("a replay rechecks a fallback after the earlier host recorded that nothing had room", () =>
  runEffect(
    Effect.gen(function* () {
      yield* rig.queueOutputs([null, { verdict: "clean", note: "recovered on codex" }]);
      yield* interrupted("r1", parked("r1"), {
        ...claudeOut,
        fallbacks: Effect.succeed([]),
        collectMs: 2_000,
      });
      const result = yield* releasedInto("r1", {
        ...claudeOut,
        fallbacks: Effect.succeed(["codex/gpt-6.1-sol"]),
        collectMs: 30_000,
      });
      expect(result._tag === "Success" && result.success.note).toBe("recovered on codex");
      expect(harnessesStarted(yield* rig.calls())).toEqual(["claude", "codex"]);
      expect(closedPanes(yield* rig.calls())).toHaveLength(1);
    }),
  ));

test("an agent that runs out mid-work is closed and replaced by one on the next entry, given the same work and a hand-over", () =>
  runEffect(
    Effect.gen(function* () {
      yield* rig.queueOutputs([null, { verdict: "clean", note: "finished on codex" }]);
      yield* Effect.forkScoped(runsOut(agentFor("r1")));
      const result = yield* session(started("r1"), { ...chain, collectMs: 30_000 });

      expect(result._tag === "Success" && result.success.note).toBe("finished on codex");
      const calls = yield* rig.calls();
      expect(closedPanes(calls)).toHaveLength(1);
      expect(harnessesStarted(calls)).toEqual(["claude", "codex"]);
      const successor = agentName("r1", "review", null, 2);
      const starts = calls.filter((call) => call.cmd === "agent start");
      expect(starts[0]?.argv).not.toContain("--dangerously-bypass-hook-trust");
      expect(starts[1]?.argv).toContain("--dangerously-bypass-hook-trust");
      expect(calls.some((call) => (call.argv ?? []).includes(successor))).toBe(true);
      const prompt = yield* read(`${dir}/agents/r1/review.r2.prompt.md`);
      const handed = prompt.indexOf("Another agent (claude/opus) started this work");
      expect(handed).toBeGreaterThan(-1);
      expect(handed).toBeLessThan(prompt.indexOf("OUTPUT_PATH:"));
      expect(prompt).toContain("Its conversation is at /home/mk/.claude/projects/p/s-out.jsonl");
      expect(yield* read(`${dir}/agents/r1/agents.log`)).toContain(
        `review: claude/opus ran out (rate_limit) — continuing on codex/default as ${successor}`,
      );
      const records = yield* runAgents(dir, "r1");
      expect(records.map(({ agent, harness }) => [agent, harness])).toEqual([
        [agentFor("r1"), "claude"],
        [successor, "codex"],
      ]);
      expect(records[1]).toMatchObject({
        from: { harness: "claude", model: "opus", effort: null },
        why: "rate_limit",
      });
    }).pipe(Effect.scoped),
  ));

test("a repair after a Fallback goes to the agent that took over, and starts no other", () =>
  runEffect(
    Effect.gen(function* () {
      yield* rig.queueOutputs([null, { verdict: "maybe" }, { verdict: "clean", note: "repaired" }]);
      yield* Effect.forkScoped(runsOut(agentFor("r1")));
      const result = yield* session(started("r1"), { ...chain, collectMs: 30_000 });

      expect(result._tag === "Success" && result.success.note).toBe("repaired");
      const calls = yield* rig.calls();
      expect(harnessesStarted(calls)).toEqual(["claude", "codex"]);
      const successor = agentName("r1", "review", null, 2);
      const promptedTo = (agent: string) =>
        calls.filter((call) => (call.argv ?? [])[1] === "prompt" && (call.argv ?? [])[2] === agent)
          .length;
      // The agent that ran out had its step only; its successor had its step and the repair.
      expect([promptedTo(agentFor("r1")), promptedTo(successor)]).toEqual([1, 2]);
    }).pipe(Effect.scoped),
  ));

test("when nothing has room the agent that ran out is kept, and the Run parks saying when usage resets", () =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      yield* rig.queueOutputs([null]);
      // Claude reads Exhausted, and there is nothing to fall back to.
      yield* interrupted("r1", parked("r1"), {
        ...claudeOut,
        fallbacks: Effect.succeed([]),
        collectMs: 2_000,
      });

      const calls = yield* rig.calls();
      expect(closedPanes(calls)).toHaveLength(0);
      expect(harnessesStarted(calls)).toEqual(["claude"]);
      expect(yield* read(`${dir}/agents/r1/agents.log`)).toMatch(
        /review: claude\/opus ran out \(session 100%, resets .+\); nothing has room; claude\/opus: session 100%, resets /,
      );
      const why = yield* fs
        .readFileString(controlPath(dir, PARKED, "r1"))
        .pipe(Effect.orElseSucceed(() => ""));
      expect(why).toContain("nothing has room; claude/opus: session 100%, resets");
    }),
  ));

test(
  "an agent that ran out and will not close parks the work, and no other agent starts beside it",
  () =>
    runEffect(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        yield* rig.queueOutputs([null, { verdict: "clean", note: "after it closed" }]);
        yield* Effect.scoped(
          Effect.gen(function* () {
            yield* Effect.forkScoped(runsOut(agentFor("r1")));
            yield* interrupted("r1", parked("r1"), {
              ...chain,
              herdr: new FakeHerdr(
                rig.pluginEnv({ FAKE_HERDR_FAIL: `{"pane close":"pane is busy"}` }),
              ),
            });
          }),
        );
        expect(harnessesStarted(yield* rig.calls())).toEqual(["claude"]);
        expect(
          yield* fs
            .readFileString(controlPath(dir, PARKED, "r1"))
            .pipe(Effect.orElseSucceed(() => "")),
        ).toContain("would not close (herdr pane close failed (exit 1): pane is busy)");

        const result = yield* releasedInto("r1", { ...chain, collectMs: 30_000 });
        expect(result._tag === "Success" && result.success.note).toBe("after it closed");
        expect(harnessesStarted(yield* rig.calls())).toEqual(["claude", "codex"]);
      }),
    ),
  120_000,
);

test("a Codex agent whose own app server says its limit is reached is replaced", () =>
  runEffect(
    Effect.gen(function* () {
      yield* rig.queueOutputs([null, { verdict: "clean", note: "finished on claude" }]);
      const reached: UsageReading = {
        subscription: "chatgpt",
        account: "acct",
        accountLabel: null,
        plan: "pro",
        windows: [
          {
            kind: "weekly",
            label: "Weekly",
            model: null,
            usedPercent: 100,
            resetsAt: "2099-01-01T15:45:00Z",
            reached: true,
          },
        ],
        at: "2026-10-08T08:00:00Z",
        source: "codex-app-server",
        problem: null,
      };
      const result = yield* session(started("r1"), {
        harness: "codex",
        model: "default",
        fallbacks: Effect.succeed(["claude/opus"]),
        // The Machine's reading has not caught up; the agent's own server has.
        readings: Effect.succeed([{ ...reached, windows: [] }]),
        ownReading: (agent) => Effect.succeed(agent === agentFor("r1") ? reached : null),
        collectMs: 30_000,
      });
      expect(result._tag === "Success" && result.success.note).toBe("finished on claude");
      expect(harnessesStarted(yield* rig.calls())).toEqual(["codex", "claude"]);
      expect(yield* read(`${dir}/agents/r1/agents.log`)).toContain(
        "review: codex/default ran out (weekly 100%, resets",
      );
    }),
  ));

test(
  "a restart after the agent that ran out is closed starts no third agent, and carries on with the new one",
  () =>
    runEffect(
      Effect.gen(function* () {
        yield* rig.queueOutputs([null, { verdict: "clean", note: "after the restart" }]);
        const closed: Reached = rig.calls().pipe(
          Effect.map((calls) => closedPanes(calls).length > 0),
          Effect.orElseSucceed(() => false),
        );
        yield* Effect.scoped(
          Effect.gen(function* () {
            yield* Effect.forkScoped(runsOut(agentFor("r1")));
            yield* interrupted("r1", closed, chain);
          }),
        );
        yield* session(halted("r1"), { collectMs: 30_000 });
        const result = yield* session(started("r1"), chain);
        expect(result._tag === "Success" && result.success.note).toBe("after the restart");
        expect(harnessesStarted(yield* rig.calls()).filter((one) => one === "codex")).toHaveLength(
          1,
        );
      }),
    ),
  120_000,
);

test(
  "a restart after the new agent is launched collects from it rather than starting another",
  () =>
    runEffect(
      Effect.gen(function* () {
        yield* rig.queueOutputs([null, null, { verdict: "clean", note: "from the new agent" }]);
        yield* Effect.scoped(
          Effect.gen(function* () {
            yield* Effect.forkScoped(runsOut(agentFor("r1")));
            yield* interrupted("r1", prompted("Your task for this step", 2), chain);
          }),
        );
        yield* session(halted("r1"), { collectMs: 30_000 });
        const result = yield* session(started("r1"), chain);
        expect(result._tag === "Success" && result.success.note).toBe("from the new agent");
        expect(harnessesStarted(yield* rig.calls()).filter((one) => one === "codex")).toHaveLength(
          2,
        );
        expect((yield* runAgents(dir, "r1")).map(({ agent }) => agent)).toEqual([
          agentFor("r1"),
          agentName("r1", "review", null, 2),
        ]);
      }),
    ),
  120_000,
);

/** One agent handed two pieces of work in turn, neither naming a model. */
const handedOn = enveloped({ name: "agent-handed-on", input: {}, success: Schema.String });
const handedOnBody = handedOn.toLayer(
  Effect.fnUntraced(function* (payload) {
    const run = Run.of({ id: payload.runId, workflow: "agent-handed-on" });
    const build = agentWork({ operation: "build", agent: "implementer", instructions: "Build." });
    const fix = agentWork({
      operation: "fix",
      agent: "implementer",
      instructions: "Fix.",
      harness: "claude",
    });
    return yield* Effect.all([build, fix]).pipe(
      Effect.map((both) => both.join("+")),
      Effect.provideService(Run, run),
    );
  }),
);

test("an agent's later work goes to the one that took over from it, and asking for the first is not refused", () =>
  runEffect(
    Effect.gen(function* () {
      yield* rig.queueOutputs([null, "built", "fixed"]);
      const implementer = agentName("r1", "implementer", null, 1);
      const result = yield* Effect.gen(function* () {
        yield* Effect.forkScoped(runsOut(implementer));
        return yield* handedOn.execute({ runId: "r1", input: {} }).pipe(Effect.result);
      }).pipe(
        Effect.provide(handedOnBody),
        Effect.provide(agentsLayer({ ...hostOf(), ...chain, collectMs: 30_000 })),
        Effect.provide(foundationLayer({ dir })),
        Effect.scoped,
        Effect.orDie,
      );
      expect(result._tag === "Success" && result.success).toBe("built+fixed");
      const calls = yield* rig.calls();
      expect(harnessesStarted(calls)).toEqual(["claude", "codex"]);
      const successor = agentName("r1", "implementer", null, 2);
      const fixedBy = calls.filter(
        (call) =>
          (call.argv ?? [])[1] === "prompt" &&
          (call.argv ?? [])[2] === successor &&
          ((call.argv ?? [])[3] ?? "").includes("fix.r2.prompt.md"),
      );
      expect(fixedBy).toHaveLength(1);
    }),
  ));

test("a collection an earlier build recorded, text or nothing, still decodes as it was", () => {
  expect(Schema.decodeUnknownSync(Collected)("done")).toBe("done");
  expect(Schema.decodeUnknownSync(Collected)(null)).toBeNull();
});

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
      expect([...models].sort((a, b) => (a ?? "").localeCompare(b ?? ""))).toEqual([
        "haiku",
        "opus",
        "sonnet",
      ]);
    }),
  ));

test("a definition's preference for a role reaches that role's work, under a scope's and the work's own", () =>
  runEffect(
    Effect.gen(function* () {
      yield* rig.queueOutputs(["one", "two", "three", "four"]);
      const entry = yield* loadEntry(
        new URL("fixtures/workflows/prefers-roles.workflow.ts", import.meta.url).pathname,
      ).pipe(Effect.orDie);
      const { workflow, layer } = entry.make("prefers-roles@1");
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
      const chosen = everyLaunch(yield* rig.calls()).map((args) => {
        const effort = args.indexOf("--effort");
        return `${args[1]}${effort === -1 ? "" : `/${args[effort + 1]}`}`;
      });
      // The role's model and effort over the workflow's; the work's own model and a scope's
      // over the role's, each keeping the role's effort where it names none of its own.
      expect([...chosen].sort()).toEqual(["fable/high", "haiku", "opus/high", "sonnet/high"]);
    }),
  ));

test("each seat of a panel is its own agent, persona and instructions; the role's other work takes the first seat's agent", () =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const personas = `${rig.pluginEnv().userDir}/personas`;
      yield* fs.makeDirectory(personas, { recursive: true });
      yield* fs.writeFileString(`${personas}/strict-critic.md`, "You are strict.\n");
      yield* rig.queueOutputs(["one", "two", "three"]);
      const entry = yield* loadEntry(
        new URL("fixtures/workflows/panel.workflow.ts", import.meta.url).pathname,
      ).pipe(Effect.orDie);
      const { workflow, layer } = entry.make("panel@1");
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
      // Each launch as the operation its persona file is named for, and the agent it got.
      const chosen = Object.fromEntries(
        everyLaunch(yield* rig.calls()).map((args) => {
          const persona = args[args.indexOf("--append-system-prompt-file") + 1] ?? "";
          const effort = args.indexOf("--effort");
          const operation = persona.slice(persona.lastIndexOf("/") + 1, -".persona.md".length);
          return [operation, `${args[1]}${effort === -1 ? "" : `/${args[effort + 1]}`}`];
        }),
      );
      expect(chosen).toEqual({
        "critique-1": "sonnet/high",
        "critique-strict": "opus",
        summary: "sonnet/high",
      });
      const at = `${dir}/agents/r1`;
      expect(yield* read(`${at}/critique-1.prompt.md`)).toContain("Critique the plan.");
      expect(yield* read(`${at}/critique-strict.prompt.md`)).toContain("Be strict about the plan.");
      expect(yield* read(`${at}/summary.prompt.md`)).toContain("Sum up.");
      expect(yield* read(`${at}/critique-strict.persona.md`)).toContain("You are strict.");
      expect(yield* read(`${at}/critique-1.persona.md`)).not.toContain("You are strict.");
      expect(yield* read(`${at}/summary.persona.md`)).not.toContain("You are strict.");
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
        const args = launchArgs(yield* rig.calls());
        expect(args.slice(0, 2)).toEqual(["--model", "opus"]);
        expect(args[args.indexOf("--settings") + 1]).toEndWith("/settings.json");
      }),
    ),
  60_000,
);

/** The auto-compact window the agent was started with, as the launch passed it. */
const windowOf = (args: ReadonlyArray<string>) =>
  args.includes("--autocompact") ? args[args.indexOf("--autocompact") + 1] : undefined;

const configured = (json: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const userDir = rig.pluginEnv().userDir;
    yield* fs.makeDirectory(userDir, { recursive: true });
    yield* fs.writeFileString(`${userDir}/config.json`, json);
  });

test("a Claude Code agent is started with a 400000 auto-compact window when none is set, and the log says so", () =>
  runEffect(
    Effect.gen(function* () {
      yield* rig.queueOutputs([{ verdict: "clean", note: "done" }]);
      yield* session(started("r1"));

      const args = launchArgs(yield* rig.calls());
      expect(args.slice(args.indexOf("--autocompact"), args.indexOf("--autocompact") + 2)).toEqual([
        "--autocompact",
        "400000",
      ]);
      expect(yield* read(`${dir}/agents/r1/agents.log`)).toContain(
        "permissions auto, auto-compact window 400000",
      );
    }),
  ));

onMachineWith("claude")(
  "the compaction controls' arguments come after the auto-compact window",
  () =>
    runEffect(
      Effect.gen(function* () {
        yield* rig.queueOutputs([{ verdict: "clean", note: "done" }]);
        yield* session(started("r1"), { compactAtTokens: 300_000 });
        const args = launchArgs(yield* rig.calls());
        expect(args.indexOf("--autocompact")).toBeLessThan(args.indexOf("--settings"));
      }),
    ),
  60_000,
);

test("a window written to the config between two launches reaches the second, on the same host", () =>
  runEffect(
    Effect.gen(function* () {
      yield* rig.queueOutputs([
        { verdict: "clean", note: "first" },
        { verdict: "clean", note: "second" },
      ]);
      yield* session(
        Effect.gen(function* () {
          yield* started("r1");
          yield* configured(`{ "claude_auto_compact_window": 500000 }`);
          yield* started("r2");
        }),
      );

      const windows = (yield* rig.calls())
        .filter((call) => (call.argv ?? [])[1] === "start")
        .map((call) => windowOf(call.argv ?? []));
      expect(windows).toEqual(["400000", "500000"]);
    }),
  ));

test("auto in the config is passed as auto", () =>
  runEffect(
    Effect.gen(function* () {
      yield* configured(`{ "claude_auto_compact_window": "auto" }`);
      yield* rig.queueOutputs([{ verdict: "clean", note: "done" }]);
      yield* session(started("r1"));

      expect(windowOf(launchArgs(yield* rig.calls()))).toBe("auto");
    }),
  ));

test("a Codex agent checks help for hook trust without receiving a Claude auto-compact window", () =>
  runEffect(
    Effect.gen(function* () {
      const asked: string[] = [];
      yield* rig.queueOutputs([{ verdict: "clean", note: "done" }]);
      yield* session(started("r1"), {
        harness: "codex",
        model: "default",
        help: (kind) => Effect.sync(() => asked.push(kind)).pipe(Effect.as(CLAUDE_HELP)),
      });

      expect(launchArgs(yield* rig.calls())).not.toContain("--autocompact");
      expect(launchArgs(yield* rig.calls())).not.toContain("--dangerously-bypass-hook-trust");
      expect(asked).toEqual(["codex"]);
    }),
  ));

test("a claude whose help does not list --autocompact is started without it, and the log says why", () =>
  runEffect(
    Effect.gen(function* () {
      yield* rig.queueOutputs([{ verdict: "clean", note: "done" }]);
      const result = yield* session(started("r1"), {
        help: () => Effect.succeed("  --model <model>"),
      });

      expect(result._tag).toBe("Success");
      expect(launchArgs(yield* rig.calls())).not.toContain("--autocompact");
      expect(yield* read(`${dir}/agents/r1/agents.log`)).toContain(
        "started without an auto-compact window: claude --help does not list --autocompact",
      );
    }),
  ));

test("a window Claude Code would not take, hand-written into the config, stops the launch and opens no tab", () =>
  runEffect(
    Effect.gen(function* () {
      yield* configured(`{ "claude_auto_compact_window": 50000 }`);
      yield* rig.queueOutputs([{ verdict: "clean", note: "done" }]);
      yield* interrupted("r1", suspended("r1"));

      expect(yield* statusNow("r1")).toBe("suspended");
      const why = yield* read(controlPath(dir, PARKED, "r1"));
      expect(why).toContain("claude_auto_compact_window");
      expect(why).toContain("50000");
      const cmds = yield* rig.cmds();
      expect(cmds).not.toContain("tab create");
      expect(cmds).not.toContain("agent start");
    }),
  ));

test("an agent is given longer than herdr's default to be ready in a checkout it has never opened", () =>
  runEffect(
    Effect.gen(function* () {
      yield* rig.queueOutputs([{ verdict: "clean", note: "done" }]);
      yield* session(started("r1"));
      const argv = (yield* rig.calls()).find((call) => call.cmd === "agent start")?.argv ?? [];
      // herdr waits 30s by default, and a first start — trust, plugins, MCP servers — takes longer.
      expect(Number(argv[argv.indexOf("--timeout") + 1])).toBeGreaterThan(30_000);
    }),
  ));

test("a pane whose shell is not up yet is started in again, not failed", () =>
  runEffect(
    Effect.gen(function* () {
      yield* rig.queueOutputs([{ verdict: "clean", note: "done" }]);
      const result = yield* session(started("r1"), {
        herdr: new FakeHerdr(
          rig.pluginEnv({
            FAKE_HERDR_FAIL: `{"agent start":"agent target pane 1-2 is not an available shell"}`,
            FAKE_HERDR_FAIL_TIMES: "2",
          }),
        ),
      });
      expect(result._tag === "Success" && result.success.note).toBe("done");
      expect((yield* rig.cmds()).filter((cmd) => cmd === "agent start")).toHaveLength(3);
    }),
  ));

test("an agent blocked during startup is waited for, not taken for a failed start", () =>
  runEffect(
    Effect.gen(function* () {
      yield* rig.queueOutputs([{ verdict: "clean", note: "done" }]);
      // herdr answers agent_not_ready at once and keeps the name: the agent is there,
      // behind a first-run dialog a human answers.
      const result = yield* session(started("r1"), {
        herdr: new FakeHerdr(rig.pluginEnv({ FAKE_HERDR_BLOCK_START: "2" })),
      });
      expect(result._tag === "Success" && result.success.note).toBe("done");
      expect((yield* rig.cmds()).filter((cmd) => cmd === "agent start")).toHaveLength(1);
      expect(yield* read(`${dir}/agents/r1/agents.log`)).toContain("blocked during startup");
    }),
  ));

/** The run has parked or failed: either way its step has let go of the work. */
const settled = (runId: string): Reached =>
  Effect.gen(function* () {
    const engine = yield* WorkflowEngine.WorkflowEngine;
    const id = yield* work.executionId({ runId, input: { skip: false } });
    const { status } = pollStatus(yield* engine.poll(work, id), "agent-work");
    return status === "suspended" || status === "failed";
  });

const parkedOn = (failing: string) =>
  Effect.gen(function* () {
    yield* interrupted("r1", settled("r1"), {
      herdr: new FakeHerdr(rig.pluginEnv({ FAKE_HERDR_FAIL: failing })),
    });
    expect(yield* statusNow("r1")).toBe("suspended");
    return yield* read(controlPath(dir, PARKED, "r1"));
  });

test("a start herdr refused parks, saying what herdr said", () =>
  runEffect(
    Effect.gen(function* () {
      const why = yield* parkedOn(`{"agent start":"claude exited: no API key"}`);
      expect(why).toContain("claude exited: no API key");
      expect(why).toContain(promptPath("r1"));
    }),
  ));

test("a herdr that cannot say what it has parks the work rather than starting an agent", () =>
  runEffect(
    Effect.gen(function* () {
      const why = yield* parkedOn(`{"agent list":"herdr is not answering"}`);
      expect(why).toContain("herdr cannot say which agents it has");
      expect(why).toContain("herdr is not answering");
      // What uncertainty must never be rounded down to.
      expect(why).toContain("Nothing here says the agent did no work.");
      expect((yield* rig.cmds()).filter((cmd) => cmd === "agent start")).toHaveLength(0);
    }),
  ));

test("a step whose work was never sent parks, naming the file its work is in", () =>
  runEffect(
    Effect.gen(function* () {
      const why = yield* parkedOn(`{"agent prompt":"herdr lost the connection"}`);
      expect(why).toContain("was not given its work");
      expect(why).toContain("herdr lost the connection");
      expect(why).toContain(promptPath("r1"));
      expect((yield* rig.cmds()).filter((cmd) => cmd === "agent start")).toHaveLength(1);
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
      lineage: ["r-review", "r-building"],
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

/** An agent of some Run, live and registered here as herdr started it. */
const liveIn = Effect.fn("test.liveIn")(function* (
  runId: string,
  role: string,
  agent: string,
  paneId: string,
) {
  yield* rig.addAgent(agent, paneId);
  const env = rig.pluginEnv();
  yield* registerAgent(yield* registryPath(env.stateDir, scopeFor(env, rig.projectDir)), {
    role,
    agent,
    paneId,
    workspaceId: null,
    runId,
    workflow: "plan",
    at: "2026-09-30T10:00:00Z",
    incarnation: { terminalId: `term-${agent}`, agentSession: null },
  });
});

test("a Run's authority is the branch it created and who started it; an older record and a roaming one authorise no branch", () =>
  runEffect(
    Effect.gen(function* () {
      const store = yield* Store;
      const placedOn = (
        run: string,
        branch: string,
        worktree: { created_branch?: boolean; created_on?: string },
      ) =>
        Effect.gen(function* () {
          yield* store.admit({
            request: `req-${run}`,
            run,
            workflow: "w",
            project: dir,
            input: {},
            provenance: {},
            options: {},
            generation: "g",
            execution: `exec-${run}`,
            task: null,
            parent: null,
            placing: encodeJson({ from: dir, taskLabel: null }),
          });
          yield* store.place(run, {
            checkout: encodeJson({
              cwd: dir,
              branch: branch === "" ? null : branch,
              workspace: null,
              worktree: {
                path: dir,
                branch,
                created_by_collie: true,
                managed_by: "git",
                workspace_id: null,
                ...worktree,
              },
            }),
            task: null,
          });
        });
      const origin = "https://gitlab.example.com/group/app.git";
      yield* placedOn("run-new", "me/x", { created_branch: true, created_on: origin });
      yield* placedOn("run-unbound", "me/x", { created_branch: true });
      yield* placedOn("run-old", "me/x", {});
      yield* placedOn("run-roams", "", {});
      const host = yield* Host;
      const authority = (run: string) => Effect.map(host.place(run), (place) => place.authority);
      expect(yield* authority("run-new")).toEqual({
        created: { branch: "me/x", checkout: dir, origin },
        roaming: false,
        started: null,
      });
      expect((yield* authority("run-unbound")).created).toBeNull();
      expect((yield* authority("run-old")).created).toBeNull();
      expect(yield* authority("run-roams")).toMatchObject({ created: null, roaming: true });
    }).pipe(Effect.provide(foundationLayer({ dir })), Effect.scoped, Effect.orDie),
  ));

test("a Run built from another Run's plan has that Run in its lineage, however it was started", () =>
  runEffect(
    Effect.gen(function* () {
      const store = yield* Store;
      const admit = (run: string, input: Record<string, string>, parent: string | null = null) =>
        store.admit({
          request: `req-${run}`,
          run,
          workflow: "w",
          project: dir,
          input,
          provenance: {},
          options: {},
          generation: "g",
          execution: `exec-${run}`,
          task: null,
          parent,
        });
      yield* admit("run-p", { work: "Plan it" });
      // Started on its own: the plan it was given is its only link to run-p.
      yield* admit("run-i", { plan: `${dir}/runs/run-p/plan` });
      yield* admit("run-c", { work: "A child" }, "run-i");
      yield* admit("run-o", { plan: "/somewhere/plans/next", note: "fix runs/run-p/plan typo" });
      const host = yield* Host;
      expect((yield* host.place("run-c")).lineage).toEqual(["run-c", "run-i", "run-p"]);
      expect((yield* host.place("run-o")).lineage).toEqual(["run-o"]);
    }).pipe(Effect.provide(foundationLayer({ dir })), Effect.scoped, Effect.orDie),
  ));

test("a placed Run has a handoffs directory before any agent of it is launched", () =>
  runEffect(
    Effect.gen(function* () {
      const store = yield* Store;
      yield* store.admit({
        request: "req-run-h",
        run: "run-h",
        workflow: "w",
        project: dir,
        input: {},
        provenance: {},
        options: {},
        generation: "g",
        execution: "exec-run-h",
        task: null,
        parent: null,
      });
      const place = yield* (yield* Host).place("run-h");
      const info = yield* (yield* FileSystem.FileSystem).stat(`${place.dir}/handoffs`);
      expect(info.type).toBe("Directory");
      expect(yield* rig.calls()).toEqual([]);
    }).pipe(Effect.provide(foundationLayer({ dir })), Effect.scoped, Effect.orDie),
  ));

test("a question and a hand-off stay in the asking Run's lineage, whoever else registered the role here", () =>
  runEffect(
    Effect.gen(function* () {
      yield* liveIn("r-plan", "planner", "plan-grill", "9-1");
      yield* liveIn("r-plan.implement", "implementer", "plan-build", "9-2");
      // Started later from the same place, in the same roles.
      yield* liveIn("r-other", "planner", "other-grill", "9-3");
      yield* liveIn("r-other.implement", "implementer", "other-build", "9-4");
      const env = rig.pluginEnv();
      const kept = yield* readRegistry(
        yield* registryPath(env.stateDir, scopeFor(env, rig.projectDir)),
      );
      expect(kept.map((entry) => entry.agent)).toEqual([
        "plan-grill",
        "plan-build",
        "other-grill",
        "other-build",
      ]);

      const asked = (lineage: ReadonlyArray<string>) =>
        Agents.pipe(Effect.flatMap((agents) => agents.askRoute("planner", lineage)));
      const route = yield* session(asked(["r-plan.implement", "r-plan"]));
      expect(route).toContain("`plan-grill`");
      expect(route).not.toContain("other-grill");
      expect(route).toContain("collie_do deliver to r-plan, agent plan-grill");
      expect(route).toContain("collie run steer r-plan --operation plan-grill");
      expect(route).not.toContain("herdr agent prompt");
      expect(route).not.toContain("herdr agent read");
      expect(yield* session(asked(["r-lonely"]))).toContain("There is no planner live");

      const handed = (lineage: ReadonlyArray<string>) =>
        Agents.pipe(
          Effect.flatMap((agents) =>
            agents.handOff({
              runId: lineage[0]!,
              role: "implementer",
              lineage,
              text: "the review is ready",
            }),
          ),
        );
      const to = yield* session(handed(["r-plan.implement.review", "r-plan.implement", "r-plan"]));
      expect(to?.agent).toBe("plan-build");
      expect(yield* session(handed(["r-lonely"]))).toBeNull();
    }),
  ));

test("seats launched together all stay registered, and a gone agent's entry leaves with the next registration", () =>
  runEffect(
    Effect.gen(function* () {
      const env = rig.pluginEnv();
      const file = yield* registryPath(env.stateDir, scopeFor(env, rig.projectDir));
      const seat = (agent: string, runId: string, at: string) => ({
        role: "reviewer",
        agent,
        paneId: `p-${agent}`,
        workspaceId: null,
        runId,
        workflow: "review",
        at,
        incarnation: { terminalId: `term-${agent}`, agentSession: null },
      });
      yield* registerAgent(file, seat("old-review", "r-done", "2026-09-30T09:00:00.000Z"));
      // Both seats listed herdr's agents before either had started, as a panel launched
      // at once does: neither list has the other seat, and neither has the gone agent.
      const listed = { agents: [], listedAt: "2026-09-30T10:00:00.000Z" };
      yield* registerAgent(file, seat("seat-1", "r-panel", "2026-09-30T10:00:05.000Z"), listed);
      yield* registerAgent(file, seat("seat-2", "r-panel", "2026-09-30T10:00:06.000Z"), listed);
      expect((yield* readRegistry(file)).map((entry) => entry.agent)).toEqual(["seat-1", "seat-2"]);
    }),
  ));

test("a lineage lookup leaves every register as it found it, and registrations at once all land", () =>
  runEffect(
    Effect.gen(function* () {
      const env = rig.pluginEnv();
      const file = yield* registryPath(env.stateDir, scopeFor(env, rig.projectDir));
      const elsewhere = `${env.stateDir}/agents/other-herd-0123456789ab.json`;
      const seat = (agent: string) => ({
        role: "reviewer",
        agent,
        paneId: `p-${agent}`,
        workspaceId: null,
        runId: "r-panel",
        workflow: "review",
        at: "2026-09-30T10:00:00.000Z",
        incarnation: { terminalId: `term-${agent}`, agentSession: null },
      });
      // Ten seats registering at the same moment, each reading and rewriting one file.
      const seats = Array.from({ length: 10 }, (_, at) => `seat-${at}`);
      yield* Effect.all(
        seats.map((agent) => registerAgent(file, seat(agent))),
        { concurrency: "unbounded" },
      );
      yield* registerAgent(elsewhere, seat("another-herds"));
      expect((yield* readRegistry(file)).map((entry) => entry.agent).sort()).toEqual(seats);

      // A list taken before any of them started, as an ask's is, knows none of them.
      expect(yield* lineageAgent(env.stateDir, [], "reviewer", ["r-panel"])).toBeNull();
      expect(yield* readRegistry(file)).toHaveLength(10);
      expect(yield* readRegistry(elsewhere)).toHaveLength(1);
    }),
  ));

/** The controls an operator sets, as the host keeps them beside the run. */
/** Stopped once its agent has been given `about`, the launch that gave it done; then suspended. */
const stoppedOnce = (runId: string, about: string): Reached => {
  let stopped = false;
  return Effect.gen(function* () {
    if (!stopped) {
      if (!(yield* prompted(about))) return false;
      yield* TestClock.withLive(Effect.sleep("100 millis"));
      yield* control("stop", runId, true);
      stopped = true;
    }
    return yield* suspended(runId);
  });
};

const control = (name: string, runId: string, set: boolean) =>
  FileSystem.FileSystem.pipe(
    Effect.flatMap((fs) => {
      const path = controlPath(dir, name, runId);
      return set ? fs.writeFileString(path, "") : fs.remove(path).pipe(Effect.ignore);
    }),
    Effect.orDie,
  );

/** What was typed into an agent's pane, in order, without a leading delivery token. */
const prompts = (calls: ReadonlyArray<Call>) =>
  calls
    .filter((call) => (call.argv ?? [])[0] === "agent" && (call.argv ?? [])[1] === "prompt")
    .map((call) => ((call.argv ?? [])[3] ?? "").replace(/^collie-delivery:\S+\n/, ""));

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
        yield* interrupted("r1", suspended("r1"));
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
        yield* interrupted("r1", stoppedOnce("r1", "Your task for this step"));
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

/** An operator stopping the Run once its repair has gone out. */
class StopsAtRepair extends FakeHerdr {
  override agentPrompt(target: string, text: string) {
    const stop = text.includes("not usable") ? control("stop", "r1", true) : Effect.void;
    return super.agentPrompt(target, text).pipe(Effect.tap(() => stop));
  }
}

test(
  "a stop while the repair is awaited parks the wait, and the resume starts the halted agent again",
  () =>
    runEffect(
      Effect.gen(function* () {
        yield* rig.queueOutputs([{ verdict: "maybe" }, null, { verdict: "clean", note: "again" }]);
        yield* interrupted(
          "r1",
          Effect.zipWith(prompted("not usable"), suspended("r1"), (one, other) => one && other),
          {
            herdr: new StopsAtRepair(rig.pluginEnv()),
            collectMs: 900,
          },
        );
        expect(sent(yield* rig.calls(), "not usable")).toBe(1);
        yield* session(halted("r1"), { collectMs: 30_000 });

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
        yield* interrupted("r1", suspended("r1"), {
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
        yield* interrupted("r1", suspended("r1"), {
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
        instructions: "Do {{item}}.",
        input: { item },
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

const unfilled = enveloped({ name: "agent-unfilled", input: {}, success: Verdict });
const unfilledBody = unfilled.toLayer((payload) =>
  agentWork({
    operation: "review",
    role: "reviewer",
    workflow: "agent-unfilled",
    cwd: rig.projectDir,
    instructions: "Review {{target}} against {{plan.file}} as the {{role}}. {{not a name}}",
    input: { target: "the diff" },
    output: Verdict,
  }).pipe(asRun(payload)),
);

test("instructions naming what nothing fills are refused before any tab or agent", () =>
  runEffect(
    Effect.gen(function* () {
      const result = yield* unfilled
        .execute({ runId: "r1", input: {} })
        .pipe(
          Effect.result,
          Effect.provide(unfilledBody),
          Effect.provide(agentsLayer(hostOf())),
          Effect.provide(foundationLayer({ dir })),
          Effect.scoped,
          Effect.orDie,
        );
      expect(result._tag === "Failure" && result.failure.reason).toBe(
        "review: its instructions name {{plan.file}}, {{not a name}}, which nothing this work was given fills",
      );
      const cmds = yield* rig.cmds();
      expect(cmds.filter((cmd) => cmd === "tab create" || cmd === "agent start")).toEqual([]);
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

test("a steer that names no agent reaches the builder when no step is active, not the last by name", () =>
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

/** A builder and then a reviewer, as an implement Run's review round launches them. */
const reviewed = enveloped({ name: "agent-reviewed", input: {}, success: Schema.String });
const reviewedBody = reviewed.toLayer((payload) =>
  Effect.gen(function* () {
    for (const [operation, role] of [
      ["build", "implementer"],
      ["review", "reviewer"],
    ] as const) {
      yield* agentWork({
        operation,
        role,
        workflow: "agent-reviewed",
        cwd: rig.projectDir,
        instructions: "Do it.",
        output: Verdict,
      });
    }
    return "both";
  }).pipe(asRun(payload)),
);

/** The builder at work again, its Output not yet written, with the reviewer idle. */
const builderBusy = Effect.gen(function* () {
  yield* reviewed.execute({ runId: "r1", input: {} });
  const launches = yield* readLaunches(dir, "r1");
  const build = launches.find((one) => one.operation === "build")!;
  yield* (yield* FileSystem.FileSystem).remove(build.output);
  return build.agent;
});

/** A pane that takes every prompt without herdr seeing a turn come of it. */
class BusyPanes extends FakeHerdr {
  override agentPrompt(target: string, text: string) {
    return super.agentPrompt(target, text).pipe(Effect.as("unobserved" as const));
  }
  override agentStatus() {
    return Effect.succeed("working" as const);
  }
}

test("a busy builder takes the steer that names no one, not the idle reviewer launched after it", () =>
  runEffect(
    Effect.gen(function* () {
      yield* rig.queueOutputs([
        { verdict: "clean", note: "built" },
        { verdict: "clean", note: "reviewed" },
      ]);
      const { builder, told } = yield* Effect.gen(function* () {
        const builder = yield* builderBusy;
        return { builder, told: yield* say("r1", "keep going", "steer-1") };
      }).pipe(
        Effect.provide(reviewedBody),
        Effect.provide(agentsLayer(hostOf())),
        Effect.provide(foundationLayer({ dir })),
        Effect.scoped,
        Effect.orDie,
      );
      expect(told).toMatchObject({ agent: builder, delivered: true, observed: true });
      expect(told.how).toBe("a turn started");
    }),
  ));

test("a steer nothing shows taken is reported sent and not observed, and a role reaches its agent", () =>
  runEffect(
    Effect.gen(function* () {
      yield* rig.queueOutputs([
        { verdict: "clean", note: "built" },
        { verdict: "clean", note: "reviewed" },
      ]);
      const told = yield* Effect.gen(function* () {
        yield* builderBusy;
        const agents = yield* Agents;
        return yield* agents.steer({
          runId: "r1",
          text: "look again",
          request: "s-1",
          to: "reviewer",
        });
      }).pipe(
        Effect.provide(reviewedBody),
        Effect.provide(
          agentsLayer({ ...hostOf(), herdr: new BusyPanes(rig.pluginEnv()), observeMs: 500 }),
        ),
        Effect.provide(foundationLayer({ dir })),
        Effect.scoped,
        Effect.orDie,
      );
      expect(told).toMatchObject({
        agent: agentName("r1", "review", null, 1),
        delivered: true,
        observed: false,
      });
      expect(told.how).toBeUndefined();
      const [one] = (yield* deliveriesOf(rig.pluginEnv().stateDir, "r1")).filter(
        ({ delivery }) => delivery.cause.kind === "steer",
      );
      expect(one?.delivery).toMatchObject({ state: "submitted", note: "unobserved" });
    }),
  ));

/** A harness whose context is always over the limit, and which compacts when asked. */
const fullContext = (asked: string[], tokens: number | null = 1_000_000): CompactionPorts => ({
  claude: {
    gate: () => Effect.void,
    install: () => Effect.succeed({ args: [] }),
    usage: () => Effect.succeed(tokens),
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
      const context = (yield* readMetrics(evidenceDir(dir, "r1"))).filter(
        (line) => line.kind === "context",
      );
      expect(context.map((line) => [line.subject, line.value])).toEqual([[sweeper, 1_000_000]]);
    }),
  ));

/** How many times a reused agent at `tokens` is asked to compact, at the default threshold. */
const compactionsAtDefault = (tokens: number) =>
  Effect.gen(function* () {
    yield* rig.queueOutputs([
      { verdict: "clean", note: "first" },
      { verdict: "clean", note: "second" },
    ]);
    const asked: string[] = [];
    yield* listing.execute({ runId: "r1", input: ITEMS }).pipe(
      Effect.provide(listingBody),
      Effect.provide(
        agentsLayer({
          ...hostOf(),
          compactAtTokens: FALLBACK_DEFAULTS.compactAtTokens,
          ports: fullContext(asked, tokens),
        }),
      ),
      Effect.provide(foundationLayer({ dir })),
      Effect.scoped,
      Effect.orDie,
    );
    return asked.length;
  });

test("by default a reused agent past 150,000 tokens compacts between tickets", () =>
  runEffect(
    Effect.gen(function* () {
      expect(FALLBACK_DEFAULTS.compactAtTokens).toBe(150_000);
      expect(yield* compactionsAtDefault(160_000)).toBe(1);
    }),
  ));

test("by default a reused agent under 150,000 tokens is not compacted", () =>
  runEffect(compactionsAtDefault(140_000).pipe(Effect.map((asked) => expect(asked).toBe(0)))));

/**
 * A compaction that has not finished until the test says how it ended. Each poll also tries
 * to send through the channel it was given, and keeps what that channel answered.
 */
interface SlowCompaction {
  ended: CompactionOutcome | null;
  readonly asked: string[];
  readonly pollSent: boolean[];
}

const slowCompaction = () => {
  const state: SlowCompaction = { ended: null, asked: [], pollSent: [] };
  const full = fullContext(state.asked).claude!;
  const submit = (ctx: AgentContext, id: string, text: string, requestId: string) =>
    ctx.channel.submit(text, {
      run: ctx.run,
      cause: { kind: "compaction", ref: id },
      mode: "boundary",
      intentVersion: 0,
      attempt: 1,
      requestId,
    });
  const ports: CompactionPorts = {
    claude: {
      ...full,
      request: (ctx, id) =>
        submit(ctx, id, "/compact", id).pipe(Effect.andThen(full.request(ctx, id))),
      poll: (ctx, id) =>
        submit(ctx, id, "from a poll", `${id}-poll`).pipe(
          Effect.map((outcome) => {
            state.pollSent.push(outcome.ok);
            return state.ended;
          }),
        ),
    },
  };
  return { state, ports };
};

const until = (reached: Reached) =>
  Effect.gen(function* () {
    for (let tries = 0; !(yield* reached); tries++) {
      if (tries === 3_000) return yield* Effect.die(new Error("never got that far"));
      yield* TestClock.withLive(Effect.sleep("10 millis"));
    }
  });

const parkedSays = (about: string): Reached =>
  read(controlPath(dir, PARKED, "r1")).pipe(Effect.map((why) => why.includes(about)));

const listingSuspended: Reached = Effect.gen(function* () {
  const engine = yield* WorkflowEngine.WorkflowEngine;
  const id = yield* listing.executionId({ runId: "r1", input: ITEMS });
  return pollStatus(yield* engine.poll(listing, id), "agent-listing").status === "suspended";
});

/**
 * The two-item list, its boundary's compaction still running past a shortened wait while
 * `during` runs. The list's result, or null where `stops` and it suspended instead.
 */
const pastTheWait = <A, E>(
  ports: CompactionPorts,
  during: Effect.Effect<A, E, Agents | FileSystem.FileSystem | WorkflowEngine.WorkflowEngine>,
  stops = false,
) =>
  Effect.gen(function* () {
    yield* rig.queueOutputs([
      { verdict: "clean", note: "first" },
      { verdict: "clean", note: "second" },
    ]);
    const fiber = yield* Effect.forkChild(
      listing.execute({ runId: "r1", input: ITEMS }).pipe(Effect.result),
    );
    const what = yield* during;
    if (stops) {
      yield* until(listingSuspended);
      return { what, result: null };
    }
    return { what, result: yield* Fiber.join(fiber) };
  }).pipe(
    Effect.provide(listingBody),
    Effect.provide(
      agentsLayer({ ...hostOf(), compactAtTokens: 1000, ports, compactionWaitMs: 60_000 }),
    ),
    Effect.provide(foundationLayer({ dir })),
    Effect.scoped,
    Effect.orDie,
  );

const NOT_FINISHED = "has not finished after 1 minutes; Collie keeps waiting and sends 02-ui";

test(
  "a compaction past its wait keeps the Run waiting, says so, and sends the work once it completes",
  () =>
    runEffect(
      Effect.gen(function* () {
        const { state, ports } = slowCompaction();
        const { result } = yield* pastTheWait(
          ports,
          Effect.gen(function* () {
            yield* until(parkedSays(NOT_FINISHED));
            expect(yield* parkedSays("Check its pane")).toBe(true);
            expect(sent(yield* rig.calls(), "02-ui")).toBe(0);
            state.ended = { kind: "success" };
          }),
        );
        expect(result?._tag === "Success" && result.success).toBe("01-api:first+02-ui:second");
        expect(yield* read(controlPath(dir, PARKED, "r1"))).toBe("");
        expect(yield* read(`${dir}/agents/r1/agents.log`)).toMatch(
          /native compaction \S+ completed/,
        );
      }),
    ),
  60_000,
);

test(
  "a compaction that fails past its wait clears the note and sends the work with the warning",
  () =>
    runEffect(
      Effect.gen(function* () {
        const { state, ports } = slowCompaction();
        const { result } = yield* pastTheWait(
          ports,
          Effect.gen(function* () {
            yield* until(parkedSays(NOT_FINISHED));
            state.ended = { kind: "failure", reason: "the window is full" };
          }),
        );
        expect(result?._tag).toBe("Success");
        expect(yield* read(controlPath(dir, PARKED, "r1"))).toBe("");
        expect(yield* read(`${dir}/agents/r1/agents.log`)).toContain(
          "native compaction failed (the window is full) — sending the work anyway",
        );
      }),
    ),
  60_000,
);

test(
  "a steer reaches the agent before and after a compaction's wait while it is unresolved",
  () =>
    runEffect(
      Effect.gen(function* () {
        const { state, ports } = slowCompaction();
        const { what } = yield* pastTheWait(
          ports,
          Effect.gen(function* () {
            yield* until(Effect.sync(() => state.asked.length === 1));
            const before = yield* say("r1", "mind the schema", "steer-1");
            const early = yield* parkedSays(NOT_FINISHED);
            yield* until(parkedSays(NOT_FINISHED));
            const after = yield* say("r1", "mind the migration", "steer-2");
            const unresolved = state.ended === null;
            state.ended = { kind: "success" };
            return { before, early, after, unresolved };
          }),
        );
        expect(what.early).toBe(false);
        expect(what.unresolved).toBe(true);
        expect([what.before.delivered, what.after.delivered]).toEqual([true, true]);
        expect(sent(yield* rig.calls(), "mind the schema")).toBe(1);
        expect(sent(yield* rig.calls(), "mind the migration")).toBe(1);
      }),
    ),
  60_000,
);

test(
  "a compaction's polls are given a channel that sends nothing, and only its request is sent",
  () =>
    runEffect(
      Effect.gen(function* () {
        const { state, ports } = slowCompaction();
        yield* pastTheWait(
          ports,
          Effect.gen(function* () {
            yield* until(parkedSays(NOT_FINISHED));
            state.ended = { kind: "success" };
          }),
        );
        expect(state.pollSent.length).toBeGreaterThan(1);
        expect(state.pollSent.every((ok) => !ok)).toBe(true);
        const compactions = (yield* deliveriesOf(rig.pluginEnv().stateDir, "r1")).filter(
          ({ delivery }) => delivery.cause.kind === "compaction",
        );
        expect(compactions).toHaveLength(1);
        expect(sent(yield* rig.calls(), "from a poll")).toBe(0);
      }),
    ),
  60_000,
);

test(
  "a stop while a compaction is past its wait ends the wait and types nothing",
  () =>
    runEffect(
      Effect.gen(function* () {
        const { ports } = slowCompaction();
        const fs = yield* FileSystem.FileSystem;
        const { result } = yield* pastTheWait(
          ports,
          Effect.gen(function* () {
            yield* until(parkedSays(NOT_FINISHED));
            yield* fs.writeFileString(controlPath(dir, STOP, "r1"), "").pipe(Effect.orDie);
          }),
          true,
        );
        expect(result).toBe(null);
        expect(sent(yield* rig.calls(), "02-ui")).toBe(0);
      }),
    ),
  60_000,
);

test("a boundary whose context cannot be sampled records no context line, never a zero", () =>
  runEffect(
    Effect.gen(function* () {
      yield* rig.queueOutputs([
        { verdict: "clean", note: "first" },
        { verdict: "clean", note: "second" },
      ]);
      yield* listing
        .execute({ runId: "r1", input: ITEMS })
        .pipe(
          Effect.provide(listingBody),
          Effect.provide(
            agentsLayer({ ...hostOf(), compactAtTokens: 1000, ports: fullContext([], null) }),
          ),
          Effect.provide(foundationLayer({ dir })),
          Effect.scoped,
          Effect.orDie,
        );
      const lines = yield* readMetrics(evidenceDir(dir, "r1"));
      expect(lines.filter((line) => line.kind === "context")).toEqual([]);
    }),
  ));

/** What a reused agent was asked and told, and what herdr said of it, in order. */
class Watched extends FakeHerdr {
  readonly seen: string[] = [];
  override agentStatus(target: string) {
    return super
      .agentStatus(target)
      .pipe(Effect.tap((status) => Effect.sync(() => this.seen.push(status))));
  }
  override agentPrompt(target: string, text: string) {
    this.seen.push(`prompt ${/([^/\s]+)\.prompt\.md/.exec(text)?.[1] ?? text}`);
    return super.agentPrompt(target, text);
  }
}

/** The two-item list with its agent's status scripted, over the compaction limit. */
const listedWhile = (status: string, herdr?: FakeHerdr) =>
  Effect.gen(function* () {
    yield* rig.queueOutputs([
      { verdict: "clean", note: "first" },
      { verdict: "clean", note: "second" },
    ]);
    const watched = herdr ?? new Watched(rig.pluginEnv({ FAKE_HERDR_AGENT_STATUS: status }));
    const seen = watched instanceof Watched ? watched.seen : [];
    const full = fullContext([]).claude!;
    const ports: CompactionPorts = {
      claude: {
        ...full,
        request: (ctx, id) =>
          Effect.sync(() => void seen.push("compact")).pipe(Effect.andThen(full.request(ctx, id))),
      },
    };
    const result = yield* listing.execute({ runId: "r1", input: ITEMS }).pipe(
      Effect.result,
      Effect.provide(listingBody),
      Effect.provide(
        agentsLayer({
          ...hostOf(),
          herdr: watched,
          compactAtTokens: 1000,
          ports,
        }),
      ),
      Effect.provide(foundationLayer({ dir })),
      Effect.scoped,
      Effect.orDie,
    );
    return { result, seen };
  });

for (const busy of ["working", "blocked"])
  test(`a reused agent herdr reports ${busy} is given nothing until it is idle`, () =>
    runEffect(
      Effect.gen(function* () {
        const { result, seen } = yield* listedWhile(`idle,${busy},${busy},${busy},idle`);
        expect(result._tag === "Success" && result.success).toBe("01-api:first+02-ui:second");
        // The first read is the first prompt's own, as it went in.
        const boundary = seen.slice(seen.indexOf("prompt 01-api") + 2);
        expect(boundary.slice(0, 5)).toEqual([busy, busy, busy, "idle", "compact"]);
        expect(boundary.filter((one) => one.startsWith("prompt"))).toEqual(["prompt 02-ui"]);
        const log = yield* read(`${dir}/agents/r1/agents.log`);
        expect(log.match(/still working; 02-ui waits for its turn to end/g)).toHaveLength(1);
      }),
    ));

/** herdr cannot say what the agent is doing. */
class Unreadable extends FakeHerdr {
  override agentStatus() {
    return Effect.fail(
      new HerdrError({
        message: "herdr agent get failed",
        detail: "socket closed",
      }),
    );
  }
}

for (const [what, run] of [
  ["unknown", () => listedWhile("unknown")],
  ["unreadable", () => listedWhile("", new Unreadable(rig.pluginEnv()))],
] as const)
  test(`a reused agent whose status is ${what} is given its work as before`, () =>
    runEffect(
      Effect.gen(function* () {
        const { result } = yield* run();
        expect(result._tag === "Success" && result.success).toBe("01-api:first+02-ui:second");
      }),
    ));

/** The list started with its agent busy after the first item, left at the waiting boundary. */
const waitingAtBoundary = Effect.gen(function* () {
  yield* rig.queueOutputs([
    { verdict: "clean", note: "first" },
    { verdict: "clean", note: "second" },
  ]);
  yield* listing.execute({ runId: "r1", input: ITEMS }, { discard: true });
  for (let tries = 0; ; tries++) {
    const log = yield* read(`${dir}/agents/r1/agents.log`).pipe(Effect.orElseSucceed(() => ""));
    if (log.includes("still working; 02-ui")) return;
    if (tries === 3_000) return yield* Effect.die(new Error("the boundary never waited"));
    yield* TestClock.withLive(Effect.sleep("10 millis"));
  }
});

const busyAfterFirst = <A, E>(
  run: Effect.Effect<A, E, WorkflowEngine.WorkflowEngine | Agents | FileSystem.FileSystem>,
) =>
  run.pipe(
    Effect.provide(listingBody),
    Effect.provide(
      agentsLayer({
        ...hostOf(),
        herdr: new FakeHerdr(rig.pluginEnv({ FAKE_HERDR_AGENT_STATUS: "idle,working" })),
        collectMs: 30_000,
      }),
    ),
    Effect.provide(foundationLayer({ dir })),
    Effect.scoped,
    Effect.orDie,
  );

test("a steer reaches an agent whose boundary is waiting for its turn to end", () =>
  runEffect(
    Effect.gen(function* () {
      const told = yield* busyAfterFirst(
        Effect.gen(function* () {
          yield* waitingAtBoundary;
          const told = yield* say("r1", "keep going", "steer-1");
          // Ends the wait, which would otherwise outlast the test.
          yield* control("stop", "r1", true);
          yield* TestClock.withLive(Effect.sleep("300 millis"));
          return told;
        }),
      );
      expect(told).toMatchObject({ agent: sweeper, delivered: true });
      expect(prompts(yield* rig.calls())).toContain("keep going");
    }),
  ));

test("a stop while the boundary waits ends the wait, and nothing more is typed", () =>
  runEffect(
    Effect.gen(function* () {
      const reads = Effect.map(
        rig.calls(),
        (calls) => calls.filter((call) => call.cmd === "agent get").length,
      );
      const { before, after } = yield* busyAfterFirst(
        Effect.gen(function* () {
          yield* waitingAtBoundary;
          yield* control("stop", "r1", true);
          yield* TestClock.withLive(Effect.sleep("300 millis"));
          const before = yield* reads;
          yield* TestClock.withLive(Effect.sleep("300 millis"));
          return { before, after: yield* reads };
        }),
      );
      expect(after).toBe(before);
      expect(sent(yield* rig.calls(), "02-ui.prompt.md")).toBe(0);
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
    const fs = yield* FileSystem.FileSystem;
    yield* listingSession(
      Effect.gen(function* () {
        yield* listing.execute({ runId, input: ITEMS }, { discard: true });
        // Once the first item's launch is done, so the stop finds its collection out.
        while (!(yield* prompted("01-api.prompt.md")))
          yield* TestClock.withLive(Effect.sleep("10 millis"));
        yield* TestClock.withLive(Effect.sleep("100 millis"));
        yield* control("stop", runId, true);
        yield* Effect.sleep(Duration.millis(900));
      }).pipe(Effect.provideService(FileSystem.FileSystem, fs)),
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
        // Every id this Run's place is known by is the new one: the Task, the pane the new
        // agent was started in — the shell the reopened workspace came with, not a tab
        // beside it — and the register a later step looks the agent up in.
        expect(tabsIn(yield* rig.calls())).toEqual(["wT"]);
        const starts = (yield* rig.calls()).filter((call) => call.cmd === "agent start");
        expect(starts.at(-1)?.argv).toEqual(expect.arrayContaining(["--pane", `${reopened}-p1`]));
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
      const fresh = yield* taskFor(
        env,
        { mode: "new" },
        { workflow: "implement", inputs: { issue: "ENG-7" } },
      );
      expect(fresh._tag === "Ok" && fresh.task).toBeNull();
      expect(fresh._tag === "Ok" ? fresh.label : null).toEqual(expect.any(String));
      expect(yield* rig.cmds()).not.toContain("workspace create");

      yield* rig.startSocket();
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
        { workflow: "review", inputs: {} },
      );
      expect(again._tag === "Ok" && again.task).toEqual(task);
      expect(again._tag === "Ok" ? again.label : "").toBeNull();
      expect(yield* rig.cmds()).not.toContain("workspace.focus");
      // One cleanup closed is continued all the same: its first agent reopens it.
      const closed = { ...task, workspace: "wGone" };
      const reopening = yield* taskFor(
        env,
        { mode: "continue", task: closed },
        { workflow: "review", inputs: {} },
      );
      expect(reopening._tag === "Ok" && reopening.task).toEqual(closed);

      // Outside herdr there is nowhere to open one, and a Run that starts no agent needs none.
      const outside = { ...env, workspaceId: null, socketPath: null };
      const none = yield* taskFor(outside, { mode: "new" }, { workflow: "tally", inputs: {} });
      expect(none._tag === "Ok" && none.task).toBeNull();
      expect(none._tag === "Ok" ? none.label : "").toBeNull();
      expect(yield* rig.cmds()).not.toContain("workspace create");
    }),
  ));

test("two goals started with one workflow are two Tasks named for their goals, not the workflow", () =>
  runEffect(
    Effect.gen(function* () {
      const env = rig.pluginEnv();
      const fs = yield* FileSystem.FileSystem;
      const labelOf = (about: Parameters<typeof taskFor>[2]) =>
        taskFor(env, { mode: "new" }, about).pipe(
          Effect.map((placed) => (placed._tag === "Ok" ? placed.label : null)),
        );
      // `then` written first, as a chat writes it: the goal is still what the Task is about.
      const tuneUp = yield* labelOf({
        workflow: "plan",
        inputs: { then: "", goal: "Design Tune-up performance workflow" },
      });
      const lookup = yield* labelOf({
        workflow: "plan",
        inputs: { then: "", goal: "Migrate pending-payment lookup to promotion-service" },
      });
      expect(tuneUp).toContain("Design Tune-up performance workflow");
      expect(lookup).toContain("Migrate pending-payment lookup to promotion-service");
      const plan = `${rig.root}/runs/run-1/plan`;
      yield* fs.makeDirectory(plan, { recursive: true });
      yield* fs.writeFileString(`${plan}/SPEC.md`, "# Spec: Stop the stale offer banner\n");
      expect(yield* labelOf({ workflow: "implement", inputs: { plan, then: "" } })).toContain(
        "Stop the stale offer banner",
      );
      expect(
        yield* labelOf({ workflow: "general", inputs: {}, goal: "Audit last week's runs" }),
      ).toContain("Audit last week's runs");
    }),
  ));

test("a title the human gave names the Task, and one that says nothing is not taken", () =>
  runEffect(
    Effect.gen(function* () {
      const env = rig.pluginEnv();
      const labelOf = (title: string) =>
        taskFor(
          env,
          { mode: "new" },
          { workflow: "plan", inputs: { goal: "Plan the offer banner fix" }, title },
        ).pipe(Effect.map((placed) => (placed._tag === "Ok" ? placed.label : null)));
      expect(yield* labelOf("Offer banner, second attempt")).toEndWith(
        " | Offer banner, second attempt",
      );
      expect(yield* labelOf("Plan new work")).toEndWith(" | Plan the offer banner fix");
    }),
  ));

test("a Task Collie named for its workflow alone is renamed for its work, and one a human renamed is not", () =>
  runEffect(
    Effect.gen(function* () {
      const env = rig.pluginEnv();
      const fs = yield* FileSystem.FileSystem;
      const plan = `${rig.root}/runs/run-9/plan`;
      yield* fs.makeDirectory(plan, { recursive: true });
      yield* fs.writeFileString(`${plan}/SPEC.md`, "# Spec: Stop the stale offer banner\n");
      yield* rig.addWorkspace("wP", "Collie | Plan new work", rig.projectDir);
      yield* rig.addWorkspace("wH", "Offer banner, by hand", rig.projectDir);
      yield* rig.addWorkspace("wN", "Collie | Passkey bridge race", rig.projectDir);
      const kept = (id: string, workspace: string, label: string) =>
        writeTask(env.stateDir, {
          id,
          workspace,
          label,
          cwd: rig.projectDir,
          created_at: "2026-10-26T00:00:00.000Z",
        });
      yield* kept("task-p", "wP", "Collie | Plan new work");
      yield* kept("task-h", "wH", "Collie | Plan new work");
      yield* kept("task-g", "wGone", "Collie | Implement plan");
      yield* kept("task-n", "wN", "Collie | Passkey bridge race");
      yield* kept("task-c", "wGone", "Collie | Implement plan");
      const goal = { then: "", goal: "Design Tune-up performance workflow" };
      const runs = [
        runFacts({ id: "r-p", workflow: "plan", task: "task-p", settled: { inputs: goal } }),
        runFacts({
          id: "r-p.implement",
          task: "task-p",
          parent: "r-p",
          created: "2026-09-15T10:00:00Z",
          settled: { inputs: { plan } },
        }),
        runFacts({ id: "r-h", workflow: "plan", task: "task-h", settled: { inputs: goal } }),
        runFacts({ id: "r-g", task: "task-g", settled: { inputs: { plan, then: "" } } }),
        runFacts({ id: "r-n", workflow: "plan", task: "task-n", settled: { inputs: goal } }),
        // Started with a Task of its own, the founding Run of task-c is still a child.
        runFacts({
          id: "r-x.implement",
          task: "task-c",
          parent: "r-x",
          settled: { inputs: { plan } },
        }),
      ];

      yield* retitleGenericTasks(env, new Herdr(env), runs);

      const label = (id: string) =>
        readTask(env.stateDir, id).pipe(Effect.map((task) => task?.label));
      const live = new Map(
        (yield* new Herdr(env).workspaceList()).map((one) => [one.workspaceId, one.label]),
      );
      expect(yield* label("task-p")).toBe("Collie | Design Tune-up performance workflow");
      expect(live.get("wP")).toBe("Collie | Design Tune-up performance workflow");
      expect(yield* label("task-g")).toBe("Collie | Stop the stale offer banner");
      expect(yield* label("task-c")).toBe("Collie | Stop the stale offer banner");
      expect(yield* label("task-h")).toBe("Collie | Plan new work");
      expect(live.get("wH")).toBe("Offer banner, by hand");
      expect(yield* label("task-n")).toBe("Collie | Passkey bridge race");
      expect(live.get("wN")).toBe("Collie | Passkey bridge race");
    }),
  ));

test("a Task's workspace is looked for in its own Herd, where a workspace of the same id is another's", () =>
  runEffect(
    Effect.gen(function* () {
      const env = rig.pluginEnv();
      const fs = yield* FileSystem.FileSystem;
      const other = `${rig.root}/other.sock`;
      yield* fs.writeFileString(
        `${rig.logPath}.sessions.json`,
        encodeJson([
          { name: "main", socket_path: rig.socketPath },
          { name: "other", socket_path: other },
        ]),
      );
      yield* rig.addWorkspace(
        "w1",
        "Collie | Plan new work",
        rig.projectDir,
        false,
        rig.socketPath,
      );
      yield* rig.addWorkspace("w1", "Offer banner, by hand", rig.projectDir, false, other);
      yield* writeTask(env.stateDir, {
        id: "task-o",
        workspace: "w1",
        label: "Collie | Plan new work",
        cwd: rig.projectDir,
        herd: yield* herdOf(other),
        created_at: "2026-10-26T00:00:00.000Z",
      });
      const goal = { goal: "Design Tune-up performance workflow" };

      yield* retitleGenericTasks(env, new Herdr(env), [
        runFacts({ id: "r-o", workflow: "plan", task: "task-o", settled: { inputs: goal } }),
      ]);

      expect((yield* readTask(env.stateDir, "task-o"))?.label).toBe("Collie | Plan new work");
      const main = yield* new Herdr(env).workspaceList();
      expect(main.map((one) => one.label)).toEqual(["Collie | Plan new work"]);
    }),
  ));

test(
  "a Task's label is renamed under its lock, never over a Run holding it",
  () =>
    runEffect(
      Effect.gen(function* () {
        const env = rig.pluginEnv();
        yield* writeTask(env.stateDir, {
          id: "task-p",
          workspace: "wGone",
          label: "Collie | Plan new work",
          cwd: rig.projectDir,
          created_at: "2026-10-26T00:00:00.000Z",
        });
        const runs = [
          runFacts({
            id: "r-p",
            workflow: "plan",
            task: "task-p",
            settled: { inputs: { goal: "Design Tune-up performance workflow" } },
          }),
        ];
        const label = readTask(env.stateDir, "task-p").pipe(Effect.map((task) => task?.label));

        yield* withTaskLock(env.stateDir, "task-p", retitleGenericTasks(env, new Herdr(env), runs));
        expect(yield* label).toBe("Collie | Plan new work");

        yield* retitleGenericTasks(env, new Herdr(env), runs);
        expect(yield* label).toBe("Collie | Design Tune-up performance workflow");
      }),
    ),
  30_000,
);

test("a start kept here is the workspace it was started from: its Task, or a new one kept there", () =>
  runEffect(
    Effect.gen(function* () {
      yield* rig.addWorkspace("wH", "Monorepo | Mine", rig.projectDir);
      const env = { ...rig.pluginEnv(), workspaceId: "wH" };
      const about = { workflow: "implement", inputs: { plan: "FRO-343" } };

      const made = yield* taskFor(env, { mode: "here" }, about);
      const task = made._tag === "Ok" ? made.task : null;
      expect(task).toMatchObject({ workspace: "wH", label: "Monorepo | Mine", cwd: env.cwd });
      // Nothing to open: the Run goes where whoever started it is.
      expect(made._tag === "Ok" ? made.label : "").toBeNull();
      expect(yield* rig.cmds()).not.toContain("workspace create");

      // Kept there, so a second start here is the same Task rather than another one.
      const again = yield* taskFor(env, { mode: "here" }, about);
      expect(again._tag === "Ok" && again.task?.id).toBe(task?.id);
      expect(yield* readTask(env.stateDir, task!.id)).toEqual(task);

      const outside = yield* taskFor({ ...env, workspaceId: null }, { mode: "here" }, about);
      expect(
        outside._tag === "Rejected" && outside.result.ok === false && outside.result.error.code,
      ).toBe("workspace_required");
    }),
  ));

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const decodeJson = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown));

/** Claude's own controls, without asking this machine which Claude it has installed. */
const claudeControls = (): CompactionPorts => ({
  claude: { ...COMPACTION_PORTS.claude!, gate: () => Effect.void },
});

/** Claude drawing its status line: the first call into the agent's control dir. */
const statusLineCall = (agent: string) =>
  Effect.gen(function* () {
    const dir = yield* controlDir(hostOf().env.stateDir, agent);
    yield* recordClaudeEvent(dir, encodeJson({ session_id: "s1", context_window: null }));
  });

const untilStarted = Effect.gen(function* () {
  while (!(yield* rig.cmds()).includes("agent start")) yield* Effect.sleep(Duration.millis(10));
});

test("the first prompt to a new agent waits for the harness to say it is up, not only herdr", () =>
  runEffect(
    Effect.gen(function* () {
      yield* rig.queueOutputs([{ verdict: "clean", note: "after the status line" }]);
      let typedBeforeReady = -1;
      // herdr has said the agent started; Claude has not drawn its REPL yet.
      const claudeComesUp = Effect.gen(function* () {
        yield* untilStarted;
        yield* Effect.sleep(Duration.millis(300));
        typedBeforeReady = sent(yield* rig.calls(), "Your task for this step");
        yield* statusLineCall(agentFor("r1"));
      });
      const [result] = yield* Effect.all(
        [
          session(started("r1"), {
            compactAtTokens: 1000,
            ports: claudeControls(),
            herdr: new FakeHerdr(rig.pluginEnv({ FAKE_HERDR_HARNESS_SILENT: "1" })),
          }),
          claudeComesUp,
        ],
        { concurrency: 2 },
      );
      expect(result._tag === "Success" && result.success.note).toBe("after the status line");
      expect(typedBeforeReady).toBe(0);
      expect(sent(yield* rig.calls(), "Your task for this step")).toBe(1);
    }),
  ));

test(
  "a harness that never says it is up parks the step naming its pane, and types nothing",
  () =>
    runEffect(
      Effect.gen(function* () {
        yield* rig.queueOutputs([{ verdict: "clean", note: "never" }]);
        yield* interrupted("r1", suspended("r1"), {
          compactAtTokens: 1000,
          ports: claudeControls(),
          herdr: new FakeHerdr(rig.pluginEnv({ FAKE_HERDR_HARNESS_SILENT: "1" })),
          readyMs: 300,
        });
        expect(yield* statusNow("r1")).toBe("suspended");
        const why = yield* read(controlPath(dir, PARKED, "r1"));
        expect(why).toContain(agentFor("r1"));
        expect(why).toMatch(/pane 1-\d+/);
        expect(sent(yield* rig.calls(), "Your task for this step")).toBe(0);
      }),
    ),
  120_000,
);

test(
  "a harness whose readiness check fails parks the step saying why",
  () =>
    runEffect(
      Effect.gen(function* () {
        yield* rig.queueOutputs([{ verdict: "clean", note: "never" }]);
        yield* interrupted("r1", suspended("r1"), {
          compactAtTokens: 1000,
          ports: {
            claude: {
              ...claudeControls().claude!,
              ready: () => Effect.fail(new Error("its endpoint has 3 threads on it")),
            },
          },
          herdr: new FakeHerdr(rig.pluginEnv({ FAKE_HERDR_HARNESS_SILENT: "1" })),
          readyMs: 300,
        });
        expect(yield* read(controlPath(dir, PARKED, "r1"))).toContain(
          "its endpoint has 3 threads on it",
        );
        expect(sent(yield* rig.calls(), "Your task for this step")).toBe(0);
      }),
    ),
  120_000,
);

test("a step pointer the harness took is recorded as Collie's, with its delivery id", () =>
  runEffect(
    Effect.gen(function* () {
      yield* rig.queueOutputs([{ verdict: "clean", note: "done" }]);
      yield* session(started("r1"));
      const pointer = (yield* rig.calls()).find(
        (call) => call.cmd === "agent prompt" && (call.argv?.[3] ?? "").includes("Your task"),
      )?.argv?.[3];
      const [step] = yield* steps("r1");
      // What Claude's UserPromptSubmit hook is given: the prompt exactly as it was typed.
      const dir = yield* controlDir(hostOf().env.stateDir, agentFor("r1"));
      yield* recordClaudeEvent(
        dir,
        encodeJson({ session_id: "s1", hook_event_name: "UserPromptSubmit", prompt: pointer }),
      );
      const events = (yield* read(`${dir}/events.jsonl`))
        .split("\n")
        .filter((line) => line.includes('"submit"'))
        .map((line) => decodeJson(line));
      expect(events).toMatchObject([
        { kind: "submit", reason: "collie", delivery: step!.delivery.id },
      ]);
      expect(pointer?.split("\n")).toContain(`collie-delivery:${step!.delivery.id}`);
    }),
  ));

/** A just-started agent: herdr sees it busy booting when the prompt goes out, then idle. */
const promptNotTaken = (lost: "enter" | "text") =>
  new FakeHerdr(
    rig.pluginEnv({ FAKE_HERDR_PROMPT_LOST: lost, FAKE_HERDR_AGENT_STATUS: "working,idle" }),
  );

const enters = (calls: ReadonlyArray<Call>) =>
  calls.filter((call) => call.cmd === "agent send-keys" && call.argv?.[3] === "enter").length;

test(
  "a step pointer whose Enter was lost is sent with one Enter, never the text again",
  () =>
    runEffect(
      Effect.gen(function* () {
        yield* rig.queueOutputs([{ verdict: "clean", note: "after the Enter" }]);
        yield* interrupted("r1", wrote("r1", "after the Enter"), {
          herdr: promptNotTaken("enter"),
          confirmGraceMs: 300,
        });
        expect(yield* read(outputPath("r1"))).toContain("after the Enter");
        const calls = yield* rig.calls();
        expect(sent(calls, "Your task for this step")).toBe(1);
        expect(enters(calls)).toBe(1);
      }),
    ),
  120_000,
);

test(
  "a step pointer that vanished is not sent again: the step waits for you, naming the pane and the delivery",
  () =>
    runEffect(
      Effect.gen(function* () {
        yield* rig.queueOutputs([{ verdict: "clean", note: "never" }]);
        yield* interrupted("r1", parked("r1"), {
          herdr: promptNotTaken("text"),
          confirmGraceMs: 300,
        });
        const why = yield* read(controlPath(dir, PARKED, "r1"));
        const [step] = yield* steps("r1");
        expect(why).toContain(step!.delivery.id);
        expect(why).toMatch(/pane 1-\d+/);
        const calls = yield* rig.calls();
        expect(sent(calls, "Your task for this step")).toBe(1);
        expect(enters(calls)).toBe(0);
      }),
    ),
  120_000,
);

/** An Output budget a resend's real IO cannot outrun on the fast clock. */
const OUTLASTS_IO = 300_000;

/** What the park's own instructions say to run, done as the command does it. */
const reconciled = (runId: string, as: "sent" | "not-sent") =>
  Effect.gen(function* () {
    const why = yield* read(controlPath(dir, PARKED, runId));
    const [step] = yield* steps(runId);
    expect(why).toContain(`--reconcile ${step!.delivery.id} --as sent|not-sent`);
    const settled = reconcile(yield* readLedger(step!.file), step!.delivery.id, as, "tester", "t");
    if ("error" in settled) throw new Error(settled.error);
    yield* appendLine(step!.file, settled);
  });

test(
  "a vanished step pointer settled as not sent goes out once more on resume, under a new delivery",
  () =>
    runEffect(
      Effect.gen(function* () {
        yield* rig.queueOutputs([{ verdict: "clean", note: "never" }]);
        yield* interrupted("r1", parked("r1"), {
          herdr: promptNotTaken("text"),
          confirmGraceMs: 300,
          collectMs: OUTLASTS_IO,
        });
        yield* reconciled("r1", "not-sent");

        yield* rig.queueOutputs([{ verdict: "clean", note: "sent again" }]);
        const result = yield* releasedInto("r1", { collectMs: OUTLASTS_IO });
        expect(result._tag === "Success" && result.success.note).toBe("sent again");
        expect(sent(yield* rig.calls(), "Your task for this step")).toBe(2);
        expect(new Set((yield* steps("r1")).map((one) => one.delivery.id)).size).toBe(2);
      }),
    ),
  120_000,
);

test(
  "a parked collection resumes on the same host and resends only the reconciled delivery",
  () =>
    runEffect(
      Effect.gen(function* () {
        const env = rig.pluginEnv({
          FAKE_HERDR_PROMPT_LOST: "text",
          FAKE_HERDR_AGENT_STATUS: "working,idle",
        });
        yield* session(
          Effect.gen(function* () {
            const engine = yield* WorkflowEngine.WorkflowEngine;
            const payload = { runId: "r1", input: { skip: false } };
            yield* rig.queueOutputs([{ verdict: "clean", note: "never" }]);
            yield* work.execute(payload, { discard: true });
            for (let tries = 0; !(yield* parked("r1")); tries++) {
              if (tries === 500) throw new Error("collection never parked");
              yield* TestClock.withLive(Effect.sleep("10 millis"));
            }
            const [first] = yield* steps("r1");
            expect(yield* read(controlPath(dir, PARKED, "r1"))).toContain(first!.delivery.id);
            for (let tries = 0; !(yield* suspended("r1")); tries++) {
              if (tries === 100) throw new Error("parked collection never suspended");
              yield* TestClock.withLive(Effect.sleep("10 millis"));
            }
            yield* reconciled("r1", "not-sent");
            delete env.raw.FAKE_HERDR_PROMPT_LOST;
            yield* rig.queueOutputs([{ verdict: "clean", note: "same host" }]);
            yield* engine.resume(work, yield* work.executionId(payload));
            const result = yield* work.execute(payload).pipe(Effect.result);
            expect(result._tag === "Success" && result.success.note).toBe("same host");
            const calls = yield* rig.calls();
            expect(sent(calls, "Your task for this step")).toBe(2);
            expect(calls.filter((call) => call.cmd === "agent start")).toHaveLength(1);
            const delivered = yield* steps("r1");
            expect(delivered.map((one) => one.delivery.attempt)).toEqual([1, 2]);
            expect(new Set(delivered.map((one) => one.delivery.id)).size).toBe(2);
          }),
          { herdr: new FakeHerdr(env), confirmGraceMs: 300, collectMs: 300_000 },
        );
      }),
    ),
  120_000,
);

test(
  "a resend herdr refuses parks saying the next resume tries again, and it does",
  () =>
    runEffect(
      Effect.gen(function* () {
        yield* rig.queueOutputs([{ verdict: "clean", note: "never" }]);
        yield* interrupted("r1", parked("r1"), {
          herdr: promptNotTaken("text"),
          confirmGraceMs: 300,
          collectMs: OUTLASTS_IO,
        });
        yield* reconciled("r1", "not-sent");

        // herdr answers `no agent` for every prompt from the second on: the resend.
        const refusing = new FakeHerdr(rig.pluginEnv({ FAKE_HERDR_FAIL_PROMPT_FROM: "1" }));
        yield* session(
          Effect.gen(function* () {
            const engine = yield* WorkflowEngine.WorkflowEngine;
            const payload = { runId: "r1", input: { skip: false } };
            yield* engine.resume(work, yield* work.executionId(payload));
            yield* work.execute(payload, { discard: true });
            while (!(yield* read(controlPath(dir, PARKED, "r1"))).includes("tries again"))
              yield* TestClock.withLive(Effect.sleep("10 millis"));
          }),
          { herdr: refusing, collectMs: OUTLASTS_IO },
        );
        expect(yield* read(controlPath(dir, PARKED, "r1"))).toContain("collie run resume r1");

        yield* rig.queueOutputs([{ verdict: "clean", note: "third time" }]);
        const result = yield* releasedInto("r1", { collectMs: OUTLASTS_IO });
        expect(result._tag === "Success" && result.success.note).toBe("third time");
      }),
    ),
  120_000,
);

test(
  "a vanished step pointer settled as sent is not sent again: the resume waits for its Output",
  () =>
    runEffect(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        yield* rig.queueOutputs([{ verdict: "clean", note: "never" }]);
        yield* interrupted("r1", parked("r1"), {
          herdr: promptNotTaken("text"),
          confirmGraceMs: 300,
        });
        yield* reconciled("r1", "sent");

        yield* fs.writeFileString(outputPath("r1"), `{"verdict":"clean","note":"typed by hand"}`);
        const result = yield* releasedInto("r1");
        expect(result._tag === "Success" && result.success.note).toBe("typed by hand");
        expect(sent(yield* rig.calls(), "Your task for this step")).toBe(1);
      }),
    ),
  120_000,
);

test("a stop closes a Claude agent's pane even while its controls are locked, having nothing to stop there", () =>
  runEffect(
    Effect.gen(function* () {
      yield* rig.queueOutputs([{ verdict: "clean", note: "done" }]);
      const controls = { compactAtTokens: 1000, ports: claudeControls() };
      yield* session(started("r1"), controls);
      const halt = yield* withControlLock(
        hostOf().env.stateDir,
        agentFor("r1"),
        session(halted("r1"), controls),
      );
      expect(halt).toEqual({ stopped: [agentFor("r1")], left: [] });
    }),
  ));

/** What was typed into the agent's pane, in order, as herdr was asked to run it. */
const paneLines = (calls: ReadonlyArray<Call>) =>
  calls.flatMap((call) =>
    call.argv?.[0] === "pane" && call.argv[1] === "run" ? [call.argv[3] ?? ""] : [],
  );

const withProfile = (profile: AgentProfile) =>
  configured(encodeJson({ agent_profile: encodeJson(profile) }));

/** Claude's compaction controls as shipped, with nothing to wait on before the first prompt. */
const claudeSettingsControls = (): CompactionPorts => ({
  claude: { ...COMPACTION_PORTS.claude!, gate: () => Effect.void, ready: undefined },
});

const AutoModeSettings = Schema.fromJsonString(
  Schema.Struct({
    autoMode: Schema.Struct({
      environment: Schema.Array(Schema.String),
      allow: Schema.Array(Schema.String),
    }),
  }),
);

const settingsAt = (calls: ReadonlyArray<Call>) => {
  const args = launchArgs(calls);
  return read(args[args.indexOf("--settings") + 1] ?? "");
};

test.each([0, 1000])(
  "Claude subagent policy reaches launch settings with compaction at %s",
  (compactAtTokens) =>
    runEffect(
      Effect.gen(function* () {
        const policy = {
          enabled: false,
          model: "sonnet",
          forceModel: true,
          cacheTtl: "1h",
          maxDepth: 1,
          maxConcurrent: 2,
        } satisfies ClaudeSubagents;
        yield* configured(
          encodeJson({
            claude_subagents: encodeJson(policy),
            agent_profile: encodeJson({ "*": { claude: { disableClaudeAiConnectors: true } } }),
          }),
        );
        yield* rig.queueOutputs([{ verdict: "clean", note: "done" }]);
        yield* session(started("r1"), { compactAtTokens, ports: claudeSettingsControls() });
        const settings = yield* Schema.decodeUnknownEffect(
          Schema.fromJsonString(Schema.JsonObject),
        )(yield* settingsAt(yield* rig.calls()));
        expect(settings.env).toEqual({
          CLAUDE_CODE_SUBAGENT_MODEL: "sonnet",
          CLAUDE_CODE_SUBAGENT_MODEL_FORCE: "1",
          CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH: "1",
          CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS: "2",
        });
        expect(settings.subagentPromptCacheTtl).toBe("1h");
        expect(settings.permissions).toEqual({ deny: ["Agent"] });
        expect(settings.autoMode).toBeDefined();
        expect(settings.disableClaudeAiConnectors).toBe(true);
        expect(settings.promptCacheTtl).toBeUndefined();
        if (compactAtTokens > 0) {
          expect(settings.statusLine).toBeDefined();
          expect(settings.hooks).toBeDefined();
        }
        expect(launchArgs(yield* rig.calls()).slice(0, 2)).toEqual(["--model", "opus"]);
        expect((yield* launchOf("r1")).claudeSubagents).toEqual(policy);
      }),
    ),
);

test("subagent policy fields follow workflow, role, scope and call preferences without leaking to Pi", () =>
  runEffect(
    Effect.gen(function* () {
      yield* configured(
        encodeJson({
          claude_subagents: encodeJson({
            enabled: false,
            forceModel: true,
            model: "sonnet",
            maxConcurrent: 2,
          }),
        }),
      );
      const tasks = enveloped({
        name: "subagent-scopes",
        input: {},
        success: Schema.Array(Schema.String),
      });
      const body = tasks.toLayer((payload) =>
        Effect.all([
          agentWork({
            operation: "research",
            role: "researcher",
            instructions: "Read the code.",
            claudeSubagents: { enabled: true, forceModel: false, maxConcurrent: undefined },
          }),
          agentWork({
            operation: "small",
            instructions: "A small fix.",
            claudeSubagents: { enabled: false, model: "sonnet", cacheTtl: "5m" },
          }),
          agentWork({
            operation: "review",
            instructions: "Review.",
            harness: "pi",
            model: "openai-codex/gpt-6.1-sol",
          }),
        ]).pipe(
          withAgents({ claudeSubagents: { model: "haiku" } }),
          Effect.provideService(WorkflowAgents, {
            claudeSubagents: { cacheTtl: "5m" },
            roles: { researcher: { claudeSubagents: { cacheTtl: "1h", maxDepth: 1 } } },
          }),
          asRun(payload),
        ),
      );
      yield* rig.queueOutputs(["done", "done", "done"]);
      yield* tasks
        .execute({ runId: "r1", input: {} })
        .pipe(
          Effect.provide(body),
          Effect.provide(agentsLayer(hostOf())),
          Effect.provide(foundationLayer({ dir })),
          Effect.scoped,
        );
      const launches = yield* readLaunches(dir, "r1");
      expect(launches.find((one) => one.operation === "research")?.claudeSubagents).toEqual({
        enabled: true,
        forceModel: false,
        model: "haiku",
        cacheTtl: "1h",
        maxDepth: 1,
        maxConcurrent: 2,
      });
      expect(launches.find((one) => one.harness === "pi")?.claudeSubagents).toBeUndefined();
      const args =
        everyLaunch(yield* rig.calls()).find((args) =>
          args.some((arg) => arg.endsWith("/research.settings.json")),
        ) ?? [];
      const settings = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.JsonObject))(
        yield* read(args[args.indexOf("--settings") + 1] ?? ""),
      );
      expect(settings.env).toMatchObject({
        CLAUDE_CODE_SUBAGENT_MODEL: "haiku",
        CLAUDE_CODE_SUBAGENT_MODEL_FORCE: "0",
      });
      expect(settings.permissions).toBeUndefined();
      const smallArgs =
        everyLaunch(yield* rig.calls()).find((args) =>
          args.some((arg) => arg.endsWith("/small.settings.json")),
        ) ?? [];
      const small = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.JsonObject))(
        yield* read(smallArgs[smallArgs.indexOf("--settings") + 1] ?? ""),
      );
      expect(small.env).toMatchObject({
        CLAUDE_CODE_SUBAGENT_MODEL: "sonnet",
        CLAUDE_CODE_SUBAGENT_MODEL_FORCE: "1",
      });
      expect(small.permissions).toEqual({ deny: ["Agent"] });
      expect(small.subagentPromptCacheTtl).toBe("5m");
    }),
  ));

test.each([
  { enabled: "false" },
  { cacheTtl: "2h" },
  { maxDepth: 0 },
  { maxConcurrent: 1.5 },
  { model: "gpt-5" },
  { forceModel: true },
  { typo: true },
  null,
])("invalid subagent policy %j starts no agent", (policy) =>
  runEffect(
    Effect.gen(function* () {
      yield* configured(encodeJson({ claude_subagents: encodeJson(policy) }));
      const result = yield* session(started("r1"));
      expect(result._tag).toBe("Failure");
      expect(result._tag === "Failure" ? result.failure.reason : "").toMatch(
        /claude_?[Ss]ubagents/,
      );
      expect(everyLaunch(yield* rig.calls())).toEqual([]);
      expect(yield* rig.cmds()).not.toContain("tab create");
    }),
  ),
);

test.each(["2.1.200 (Claude Code)", null])(
  "an unsupported Claude version %j parks a subagent policy before opening a pane",
  (installed) =>
    runEffect(
      Effect.gen(function* () {
        clearing = { claudeSubagents: { cacheTtl: "1h" } };
        yield* interrupted("r1", suspended("r1"), { version: () => Effect.succeed(installed) });
        expect(yield* read(controlPath(dir, PARKED, "r1"))).toContain(
          "requires Claude Code 2.1.242",
        );
        expect(yield* rig.cmds()).not.toContain("tab create");
      }),
    ),
);

test(
  "a subagent policy stays recorded through recovery after the operator changes defaults",
  () =>
    runEffect(
      Effect.gen(function* () {
        yield* configured(
          encodeJson({ claude_subagents: encodeJson({ model: "sonnet", cacheTtl: "1h" }) }),
        );
        yield* rig.queueOutputs([null, { verdict: "clean", note: "back" }]);
        yield* interrupted("r1", prompted("Your task for this step"));
        yield* session(halted("r1"), { collectMs: 30_000 });
        yield* configured(
          encodeJson({ claude_subagents: encodeJson({ model: "haiku", cacheTtl: "5m" }) }),
        );
        const result = yield* session(started("r1"));
        expect(result._tag).toBe("Success");
        expect((yield* launchOf("r1")).claudeSubagents).toEqual({
          model: "sonnet",
          cacheTtl: "1h",
        });
        for (const args of everyLaunch(yield* rig.calls())) {
          const settings = yield* read(args[args.indexOf("--settings") + 1] ?? "");
          expect(settings).toContain('"sonnet"');
          expect(settings).toContain('"1h"');
        }
      }),
    ),
  120_000,
);

test.each([
  { harness: "claude", model: "sonnet", next: "haiku", matches: false },
  { harness: "claude", model: "default", next: "default", matches: true },
  { harness: "pi", model: "sonnet", next: "haiku", matches: true },
])(
  "reusing an agent compares its explicit subagent policy %j",
  ({ harness, model, next, matches }) =>
    runEffect(
      Effect.gen(function* () {
        const continued = enveloped({ name: "subagent-reuse", input: {}, success: Schema.String });
        const body = continued.toLayer((payload) =>
          Effect.gen(function* () {
            yield* agentWork({
              operation: "first",
              agent: "worker",
              instructions: "One.",
              claudeSubagents: { model },
            });
            return yield* agentWork({
              operation: "second",
              agent: "worker",
              instructions: "Two.",
              claudeSubagents: { model: next },
            });
          }).pipe(asRun(payload)),
        );
        yield* rig.queueOutputs(matches ? ["one", "two"] : ["one"]);
        const result = yield* continued.execute({ runId: "r1", input: {} }).pipe(
          Effect.result,
          Effect.provide(body),
          Effect.provide(
            agentsLayer({
              ...hostOf(),
              harness,
              model: harness === "pi" ? "openai-codex/gpt-6.1-sol" : "opus",
            }),
          ),
          Effect.provide(foundationLayer({ dir })),
          Effect.scoped,
        );
        if (matches) expect(result._tag).toBe("Success");
        else
          expect(result._tag === "Failure" ? result.failure.reason : "").toContain(
            "different Claude subagent policy",
          );
        expect(everyLaunch(yield* rig.calls())).toHaveLength(1);
      }),
    ),
);

test("with no agent profile a launch types and passes what it always has", () =>
  runEffect(
    Effect.gen(function* () {
      yield* rig.queueOutputs([
        { verdict: "clean", note: "first" },
        { verdict: "clean", note: "second" },
      ]);
      const before = yield* session(
        Effect.gen(function* () {
          yield* started("r1");
          const first = yield* rig.calls();
          yield* withProfile({});
          yield* started("r2");
          return first;
        }),
      );
      const after = (yield* rig.calls()).slice(before.length);

      const same = (calls: ReadonlyArray<Call>, runId: string) =>
        [...paneLines(calls), ...launchArgs(calls)].map((said) => said.replaceAll(runId, "<run>"));
      expect(same(after, "r2")).toEqual(same(before, "r1"));
      // Its own, for the Run's autoMode block alone.
      expect(launchArgs(after)).toContain(`${dir}/agents/r2/review.settings.json`);
    }),
  ));

test("with no agent profile Claude's settings file is what Collie always wrote", () =>
  runEffect(
    Effect.gen(function* () {
      yield* rig.queueOutputs([
        { verdict: "clean", note: "first" },
        { verdict: "clean", note: "second" },
      ]);
      const settingsOf = (runId: string) =>
        Effect.gen(function* () {
          const from = (yield* rig.calls()).length;
          yield* started(runId);
          const args = launchArgs((yield* rig.calls()).slice(from));
          return yield* read(args[args.indexOf("--settings") + 1] ?? "");
        });
      const [before, after] = yield* session(
        Effect.gen(function* () {
          const first = yield* settingsOf("r1");
          yield* withProfile({ implementer: { env: { ONLY: "theirs" } } });
          return [first, yield* settingsOf("r2")] as const;
        }),
        { compactAtTokens: 1000, ports: claudeSettingsControls() },
      );

      const runless = (text: string) => text.replaceAll(/\br[12]\b/g, "<run>");
      expect(runless(after)).toEqual(runless(before));
      expect(before).toContain("hooks");
    }),
  ));

test("a profile's environment is set in the pane before the harness starts, and a file-held value is written nowhere", () =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const secret = ["glpat", "synthetic0000000000test"].join("-");
      yield* fs.makeDirectory(`${rig.root}/secrets`, { recursive: true });
      yield* fs.writeFileString(`${rig.root}/secrets/token`, `${secret}\n`);
      yield* fs.chmod(`${rig.root}/secrets/token`, 0o600);
      yield* withProfile({
        reviewer: {
          env: { PONYTAIL_DEFAULT_MODE: "off", DEPLOY_TOKEN: { file: "~/secrets/token" } },
        },
      });
      yield* rig.queueOutputs([{ verdict: "clean", note: "done" }]);
      yield* session(started("r1"));

      const calls = yield* rig.calls();
      const typed = paneLines(calls);
      expect(typed).toContain("export PONYTAIL_DEFAULT_MODE='off'");
      expect(typed).toContain(
        `IFS= read -r DEPLOY_TOKEN < '${rig.root}/secrets/token'; export DEPLOY_TOKEN`,
      );
      const startAt = calls.findIndex((call) => call.argv?.[1] === "start");
      const lastTyped = calls.findLastIndex(
        (call) => call.argv?.[0] === "pane" && call.argv[1] === "run",
      );
      expect(lastTyped).toBeLessThan(startAt);

      const leaked: string[] = [];
      for (const path of yield* fs.readDirectory(rig.root, { recursive: true })) {
        const at = `${rig.root}/${path}`;
        if (at === `${rig.root}/secrets/token`) continue;
        if ((yield* fs.stat(at)).type !== "File") continue;
        if ((yield* fs.readFileString(at).pipe(Effect.orElseSucceed(() => ""))).includes(secret))
          leaked.push(path);
      }
      expect(leaked).toEqual([]);
      expect(calls.filter((call) => JSON.stringify(call).includes(secret))).toEqual([]);
    }),
  ));

test("a file-held value that is not 0600 parks the launch by its path, and opens no tab", () =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      yield* fs.writeFileString(`${rig.root}/token`, "hunter2\n");
      yield* fs.chmod(`${rig.root}/token`, 0o644);
      yield* withProfile({ "*": { env: { DEPLOY_TOKEN: { file: "~/token" } } } });
      yield* rig.queueOutputs([{ verdict: "clean", note: "done" }]);
      yield* interrupted("r1", suspended("r1"));

      expect(yield* statusNow("r1")).toBe("suspended");
      const why = yield* read(controlPath(dir, PARKED, "r1"));
      expect(why).toContain(`${rig.root}/token is mode 0644, not 0600`);
      expect(why).not.toContain("hunter2");
      const cmds = yield* rig.cmds();
      expect(cmds).not.toContain("tab create");
      expect(cmds).not.toContain("agent start");
    }),
  ));

test("a Claude overlay is merged into Collie's settings file, and Collie's hooks stay first", () =>
  runEffect(
    Effect.gen(function* () {
      const guard = { matcher: "Bash", hooks: [{ type: "command", command: "guard" }] };
      yield* withProfile({
        "*": {
          claude: {
            enabledPlugins: { "ponytail@market": false },
            disableClaudeAiConnectors: true,
            hooks: { PreToolUse: [guard], UserPromptSubmit: [guard] },
          },
        },
      });
      yield* rig.queueOutputs([{ verdict: "clean", note: "done" }]);
      yield* session(started("r1"), { compactAtTokens: 1000, ports: claudeSettingsControls() });

      const args = launchArgs(yield* rig.calls());
      expect(args.filter((arg) => arg === "--settings")).toHaveLength(1);
      const settings = yield* Schema.decodeUnknownEffect(
        Schema.fromJsonString(
          Schema.Struct({
            statusLine: Schema.Unknown,
            enabledPlugins: Schema.Unknown,
            disableClaudeAiConnectors: Schema.Boolean,
            hooks: Schema.Record(Schema.String, Schema.Array(Schema.Unknown)),
          }),
        ),
      )(yield* read(args[args.indexOf("--settings") + 1] ?? ""));
      expect(settings.enabledPlugins).toEqual({ "ponytail@market": false });
      expect(settings.disableClaudeAiConnectors).toBe(true);
      expect(settings.hooks.PreToolUse).toHaveLength(2);
      expect(settings.hooks.PreToolUse?.[0]).toMatchObject({ matcher: "AskUserQuestion" });
      expect(settings.hooks.PreToolUse?.[1]).toEqual(guard);
      expect(settings.hooks.UserPromptSubmit).toHaveLength(2);
      expect(settings.hooks.UserPromptSubmit?.[1]).toEqual(guard);
      expect(Object.keys(settings.hooks)).toEqual(
        expect.arrayContaining(["PreCompact", "PostCompact", "UserPromptSubmit"]),
      );
      const { autoMode } = yield* Schema.decodeUnknownEffect(AutoModeSettings)(
        yield* read(args[args.indexOf("--settings") + 1] ?? ""),
      );
      expect(autoMode.environment[0]).toBe("$defaults");
    }),
  ));

test("without Collie's controls, a Claude overlay is a settings file of its own", () =>
  runEffect(
    Effect.gen(function* () {
      yield* withProfile({
        reviewer: { claude: { claudeMdExcludes: ["/home/me/.claude/CLAUDE.md"] } },
      });
      yield* rig.queueOutputs([{ verdict: "clean", note: "done" }]);
      yield* session(started("r1"));

      const args = launchArgs(yield* rig.calls());
      const path = args[args.indexOf("--settings") + 1] ?? "";
      expect(path).toBe(`${dir}/agents/r1/review.settings.json`);
      expect(yield* read(path)).toContain("/home/me/.claude/CLAUDE.md");
    }),
  ));

test("a Claude launch's settings carry the Run's autoMode block, each list opening with the defaults", () =>
  runEffect(
    Effect.gen(function* () {
      yield* rig.queueOutputs([{ verdict: "clean", note: "done" }]);
      yield* session(started("r1"));

      const text = yield* settingsAt(yield* rig.calls());
      const { autoMode } = yield* Schema.decodeUnknownEffect(AutoModeSettings)(text);
      expect(autoMode.environment[0]).toBe("$defaults");
      expect(autoMode.allow).toEqual(["$defaults"]);
      expect(autoMode.environment[1]).toContain(`of Collie Run r1 (Workflow agent-work)`);
      expect(autoMode.environment[2]).toContain(`Checkout: ${rig.projectDir}`);
      expect(autoMode.environment[3]).toContain(rig.pluginEnv().stateDir);
      expect(autoMode.environment[4]).toContain("collie-delivery:");
      expect(autoMode.environment).toHaveLength(5);
      expect(text).not.toContain("soft_deny");
      expect(text).not.toContain("hard_deny");
    }),
  ));

test("a Run that created its branch, which the forge leaves unprotected, may rewrite it, and quotes the human who started it", () =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const branch = "me/new-work";
      const origin = "git@gitlab.example.com:group/app.git";
      const git = (...args: ReadonlyArray<string>) =>
        Effect.promise(() => Bun.$`git ${args}`.cwd(rig.projectDir).quiet());
      yield* git("init", "--quiet", "-b", branch);
      yield* git("remote", "add", "origin", origin);
      const bin = yield* FakeBin.make(`${rig.root}/bin`);
      yield* forgeOnPath(bin, "gitlab", {
        installed: true,
        loggedIn: ["gitlab.example.com"],
        login: "me",
        mrs: [],
        defaultBranch: "main",
      });
      yield* Effect.gen(function* () {
        const store = yield* Store;
        yield* store.admit({
          request: "req-r1",
          run: "r1",
          workflow: "agent-work",
          project: rig.projectDir,
          input: {},
          provenance: {},
          options: {},
          generation: "g",
          execution: "exec-r1",
          task: null,
          parent: null,
          placing: encodeJson({
            from: rig.projectDir,
            taskLabel: null,
            started: { door: "board", words: "Fix the login form" },
          }),
        });
        yield* store.place("r1", {
          checkout: encodeJson({
            cwd: rig.projectDir,
            branch,
            workspace: null,
            worktree: {
              path: rig.projectDir,
              branch,
              created_by_collie: true,
              created_branch: true,
              created_on: origin,
              managed_by: "git",
              workspace_id: null,
              made_at: null,
              root_tab_id: null,
              root_pane_id: null,
            },
          }),
          task: null,
        });
      }).pipe(Effect.provide(foundationLayer({ dir })), Effect.scoped, Effect.orDie);
      yield* rig.queueOutputs([{ verdict: "clean", note: "done" }]);
      yield* session(started("r1")).pipe(Effect.ensuring(bin.restore()));

      const { autoMode } = yield* Schema.decodeUnknownEffect(AutoModeSettings)(
        yield* settingsAt(yield* rig.calls()),
      );
      expect(autoMode.allow[1]).toStartWith(`Rewriting history on branch ${branch} of ${origin}`);
      expect(autoMode.environment[2]).toContain(`branch ${branch}, which this Run created.`);
      expect(autoMode.environment[5]).toBe(
        'The user started this Run from the board with: "Fix the login form"',
      );
      expect(autoMode.allow[2]).toContain("starting words");
      expect(yield* fs.exists(`${rig.root}/bin/gitlab.model.json.log`)).toBe(true);
    }),
  ));

test("a Codex launch writes no autoMode", () =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      yield* rig.queueOutputs([{ verdict: "clean", note: "done" }]);
      yield* session(started("r1"), { harness: "codex", model: "default" });

      const calls = yield* rig.calls();
      expect(launchArgs(calls).join(" ")).not.toContain("autoMode");
      for (const path of yield* fs.readDirectory(`${dir}/agents/r1`))
        expect(yield* read(`${dir}/agents/r1/${path}`)).not.toContain("autoMode");
    }),
  ));

const waitsForMemory = (runId: string): Reached =>
  Effect.map(memoryWaitOf(runDir(dir, runId)), (wait) => wait !== null);

const runLogOf = (runId: string) => read(`${dir}/agents/${runId}/agents.log`);

test(
  "a launch waits while its Machine is short of memory, with no tab or agent made, and its budget starts once it is launched",
  () =>
    runEffect(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        yield* rig.memory(2);
        yield* rig.queueOutputs([null]);
        const result = yield* session(
          Effect.gen(function* () {
            const fiber = yield* Effect.forkChild(started("r1"));
            yield* until(waitsForMemory("r1"));
            yield* spend(60_000);
            const cmds = yield* rig.cmds();
            expect(cmds.filter((cmd) => cmd === "tab create" || cmd === "agent start")).toEqual([]);
            expect(yield* runLogOf("r1")).toContain(
              `${agentFor("r1")}'s launch: waiting for memory on `,
            );

            yield* rig.memory(50);
            yield* until(prompted("Your task for this step"));
            // A minute's wait spent none of a 400 ms budget.
            expect(yield* parked("r1")).toBe(false);
            expect(yield* runLogOf("r1")).toMatch(
              new RegExp(`${agentFor("r1")}'s launch: waited \\S+ for memory`),
            );
            yield* fs.writeFileString(outputPath("r1"), `{"verdict":"clean","note":"after"}`);
            return yield* Fiber.join(fiber);
          }),
          { collectMs: 400 },
        );
        expect(result._tag === "Success" && result.success.note).toBe("after");
        expect((yield* rig.cmds()).filter((cmd) => cmd === "agent start")).toHaveLength(1);
      }),
    ),
  120_000,
);

test(
  "a stop ends a launch's wait for memory, and nothing is launched for the Run after it",
  () =>
    runEffect(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        yield* rig.memory(2);
        yield* session(
          Effect.gen(function* () {
            yield* work.execute({ runId: "r1", input: { skip: false } }, { discard: true });
            yield* until(waitsForMemory("r1"));
            yield* fs.writeFileString(controlPath(dir, STOP, "r1"), "").pipe(Effect.orDie);
            yield* until(suspended("r1"));
            expect(yield* memoryWaitOf(runDir(dir, "r1"))).toBeNull();
            yield* rig.memory(50);
            yield* spend(60_000);
          }),
        );
        expect((yield* rig.cmds()).filter((cmd) => cmd === "agent start")).toEqual([]);
        expect(yield* runLogOf("r1")).toContain("stopped after waiting");
      }),
    ),
  120_000,
);

test(
  "a verify an idle agent asked for, held for memory past its budget, keeps its Run from parking, and one with none parks",
  () =>
    runEffect(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        yield* rig.queueOutputs([null, null]);
        const herdr = new BusyUntilWritten("working");
        const result = yield* session(
          Effect.gen(function* () {
            const fiber = yield* Effect.forkChild(started("r1"));
            yield* work.execute({ runId: "r2", input: { skip: false } }, { discard: true });
            yield* until(prompted("Your task for this step", 2));
            yield* rig.memory(2);
            // What the host's verify handler does for an agent's `collie verify`.
            const verify = yield* Effect.forkChild(
              waitForMemory({
                env: rig.pluginEnv(),
                stateDir: dir,
                runId: "r1",
                what: 'collie verify "unit"',
                asker: agentFor("r1"),
              }),
            );
            // Setup IO can outlast the idle budget; finish the turns only once verify holds it.
            yield* until(holdsBudgetOf(dir, "r1", agentFor("r1")));
            herdr.written = true;
            yield* until(parked("r2"));
            yield* spend(5_000);
            expect(yield* parked("r1")).toBe(false);

            herdr.written = false;
            yield* rig.memory(50);
            expect(yield* Fiber.join(verify)).toBe("waited");
            yield* fs.writeFileString(outputPath("r1"), `{"verdict":"clean","note":"verified"}`);
            herdr.written = true;
            return yield* Fiber.join(fiber);
          }),
          { herdr, collectMs: 400 },
        );
        expect(result._tag === "Success" && result.success.note).toBe("verified");
      }),
    ),
  120_000,
);

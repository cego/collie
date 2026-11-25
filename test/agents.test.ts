import { launchesAt, agentsAt, launchedAt } from "./support/records";
import * as Cause from "effect/Cause";

import * as Struct from "effect/Struct";
import * as Arr from "effect/Array";
import * as Option from "effect/Option";
import * as Order from "effect/Order";
import * as Str from "effect/String";
import { pipe } from "effect/Function";
import * as Rec from "effect/Record";
import { afterEach, beforeEach, expect, setSystemTime, test } from "bun:test";
import { IGNORES_TERM, SURVIVES_HANGUP, paneTree } from "./support/pane-tree";
import { processOf } from "../src/processes";
import type { PlatformServices } from "../src/platform";
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
  Ref,
  Schedule,
  Schema,
  flow,
  Result,
} from "effect";
import { TestClock } from "effect/testing";
import * as WorkflowEngine from "effect/workflow/WorkflowEngine";
import { Rig } from "./support/recorder";
import type { Call } from "./support/recorder";
import { installBaseline } from "./support/engine";
import { mentionedSkills } from "../src/template";
import type { FakeHc } from "./support/fake-hc";
import { isJsonObject, isString } from "../src/schema";
import { fastForward, runEffect as runLive } from "./support/effect";
import { onMachineWith } from "./support/live";
import {
  Agents,
  agentWork,
  agentsLayer,
  configuredAgents,
  decodeOutput,
  everyAgentText,
  personaText,
  promptFor,
} from "../src/agents";
import type { AgentHost, RanOut, RunNow } from "../src/agents";
import { Children, Host, Run, WorkflowAgents, jsonSchemaFor, step, withAgents } from "../src/sdk";
import { asRun, enveloped } from "./support/enveloped";
import {
  HOLD,
  PARKED,
  PARK_CAUSE,
  STOP,
  evidenceDir,
  foundationLayer,
  Registry,
  registryLayer,
  loadEntry,
  pollStatus,
  runDir,
} from "../src/engine";
import { readStepLines } from "../src/steps";
import { readMetrics } from "../src/metrics";
import { usageOf } from "../src/usage-ledger-model";
import type { Source, UsageEntry } from "../src/usage-ledger-model";
import { readUsage } from "../src/usage-ledger";
import { measuresOf } from "../src/outcomes";
import { launchDir, recordLaunch, stemOf } from "../src/launches";
import { Collected } from "../src/agents";
import { Collecting } from "../src/collecting";
import { holdsBudgetOf, memoryWaitOf, waitForMemory } from "../src/memory-wait";
import type { UsageReading } from "../src/usage-model";
import { isoAt, nowIso } from "../src/time";
import { readCards, writeCheckpoint } from "../src/cards";
import { readDrift } from "../src/drift";
import { FixOutputSchema, SynthesisSchema } from "../src/output";
import { HandOver, OutgoingFields, buildHandOver } from "../src/hand-over";
import type { HandOverGiven } from "../src/hand-over";
import { readRunJournal, runJournal } from "../src/journal";
import { appendVerification } from "../src/verify";
import type { Verification } from "../src/verify";
import { Triage } from "../workflows/retrospective";
import { seedIntent, writeIntent } from "../src/intent";
import { appendLine, reconcile } from "../src/steering";
import {
  deliveredTo,
  hostRecords,
  hostRunRecords,
  ledgerOf,
  overHost,
  recordsAt,
  registeredAt,
} from "./support/records";
import { RELAUNCH, RunRecords } from "../src/run-records";
import { Store } from "../src/store";
import type { DecisionRow } from "../src/store";
import type { AuditLine } from "../src/audit";
import { readTask, withTaskLock, writeTask } from "../src/task";
import { taskFor } from "../src/operations";
import { everyRegistered, lineageAgent, registerAgent, scopeFor } from "../src/registry";
import { Herdr, HerdrError } from "../src/herdr";
import type { AgentStatus } from "../src/herdr";
import { retitleGenericTasks } from "../src/tasknames";
import { runFacts } from "./support/records";
import { updateApproved } from "../src/verify-spec";
import { VERIFYING, encodeVerifying } from "../src/verify";
import { agentName } from "../src/naming";
import {
  controlDir,
  installControls,
  lostServer,
  readControl,
  withControlLock,
} from "../src/compaction";
import type { AgentContext, CompactionOutcome, CompactionPorts } from "../src/compaction";
import { COMPACTION_PORTS, questionsSince, recordClaudeEvent, writeEvent } from "../src/compactors";
import { hostLockOf } from "../src/lock";
import { claudeTrust } from "../src/trust";
import { FALLBACK_DEFAULTS } from "../src/settings";
import type { AgentProfile } from "../src/profile";
import type { ClaudeSubagents } from "../src/subagents";
import { FakeBin } from "./support/bin";
import { forgeHttpOnPath, forgeOnPath } from "./support/forge";
import type { HarnessCatalogue } from "../src/catalogue-model";
import { stringifyJson } from "../src/json";

let rig: Rig;
let dir: string;
interface Clearing {
  readonly instructions?: string;
  readonly clears?: ReadonlyArray<string>;
  readonly skill?: string;
  readonly claudeSubagents?: ClaudeSubagents;
  readonly role?: string;
}
let clearing: Clearing = {};

let core: FakeHc;

beforeEach(() =>
  runLive(
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

afterEach(() => runLive(rig.close()));

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

const reviewWork = () =>
  agentWork({
    operation: "review",
    role: "reviewer",
    workflow: "agent-work",
    cwd: rig.projectDir,
    instructions: "Review {{target}} as the {{role}}.",
    input: { target: "the diff" },
    output: Verdict,
    ...clearing,
  });

const body = work.toLayer((payload) =>
  Effect.gen(function* () {
    if (payload.input.skip) {
      return SKIPPED;
    }
    return yield* reviewWork();
  }).pipe(asRun(payload)),
);

const stepped = enveloped({
  name: "agent-work-stepped",
  input: { skip: Schema.Boolean },
  success: Verdict,
});
const reviewing = step({ id: "review", title: "Review the diff", kind: "agent" });
const steppedBody = stepped.toLayer((payload) => reviewing(reviewWork()).pipe(asRun(payload)));

const CLAUDE_HELP = "  --autocompact <auto|tokens>           Auto-compact window size";
const CODEX_HELP = "  --dangerously-bypass-hook-trust";

const hostOf: () => AgentHost = () => ({
  dir,
  env: rig.pluginEnv(),
  herdr: new UnseenTurn(rig.pluginEnv()),
  harness: "claude",
  model: "opus",
  permissions: "auto",
  compactAtTokens: 0,
  pollMs: 20,
  collectMs: 400,
  readyMs: 1000,
  help: (kind) => Effect.succeed(kind === "codex" ? CODEX_HELP : CLAUDE_HELP),
  version: () => Effect.succeed("2.1.309 (Claude Code)"),
  // WARNING: codex's controls would start the operator's own app-server, so they are left out.
  ports: Struct.omit(COMPACTION_PORTS, ["codex"]),
});

test("configured agents open in the Task kept by their host's state directory", () =>
  runEffect(
    Effect.gen(function* () {
      const inherited = rig.pluginEnv().raw;
      yield* configured('{ "compact_at_tokens": 0, "trust": "never" }');
      const bin = yield* Effect.acquireRelease(FakeBin.make(`${rig.root}/bin`), (made) =>
        made.restore(),
      );
      yield* bin.add("codex", "exit 1");
      yield* rig.queueOutputs([null]);
      yield* writeTask({
        id: "task-own",
        workspace: null,
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
        Effect.provide(
          Layer.unwrap(configuredAgents(dir, Effect.succeed([]))).pipe(
            Layer.provideMerge(
              foundationLayer({
                dir,
              }),
            ),
            Layer.provideMerge(ConfigProvider.layer(ConfigProvider.fromUnknown(inherited))),
          ),
        ),
        Effect.scoped,
      );
      const run = Option.getOrUndefined(
        Arr.findFirst(yield* rig.calls(), (call) => call.cmd === "terminal.run"),
      );
      expect(run?.params?.labels).toMatchObject({ task: "task-own" });
      expect(launched._tag).toBe("Success");
    }).pipe(Effect.provide(recordsAt(dir)), Effect.scoped),
  ));

const runEffect = <A, E>(effect: Effect.Effect<A, E, PlatformServices | RunRecords>) =>
  runLive(
    fastForward(
      Effect.suspend(() => rig.startCore()).pipe(
        Effect.tap((served) => Effect.sync(() => (core = served))),
        Effect.andThen(effect),
      ),
    ).pipe(overHost(() => dir)),
  );

const session = <A, E>(
  run: Effect.Effect<
    A,
    E,
    WorkflowEngine.WorkflowEngine | Agents | Collecting | Store | Host | PlatformServices
  >,
  over?: Partial<AgentHost>,
) =>
  run.pipe(
    Effect.provide(
      Layer.merge(body, steppedBody).pipe(
        Layer.provideMerge(
          agentsLayer({
            ...hostOf(),
            ...over,
          }).pipe(Layer.provide(forgeHttpOnPath)),
        ),
        Layer.provideMerge(
          foundationLayer({
            dir,
          }),
        ),
      ),
    ),
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
            placing: { env: rig.pluginEnv(), herdr: new Herdr(rig.pluginEnv()) },
            catalogue: Effect.sync(() => ({
              machine: "vm-gpu",
              harnesses: [{ ...machineCatalogue, table }],
            })),
          }).pipe(
            Layer.provideMerge(agentsLayer(hostOf())),
            Layer.provideMerge(foundationLayer({ dir })),
          ),
        ),
        Effect.scoped,
      );
    }),
  ));

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

const sentTexts = (calls: ReadonlyArray<Call>) =>
  Arr.filterMap(calls, (call) => {
    const text = call.params?.text;
    return call.cmd === "terminal.send" && isString(text) ? Result.succeed(text) : Result.failVoid;
  });

const sent = (calls: ReadonlyArray<Call>, about: string) =>
  Arr.filter(sentTexts(calls), Str.includes(about)).length;

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
  expect(prompt).toContain("clean only when there is nothing left for the implementer");
  expect(prompt).toContain("one sentence a human reads");
  expect(prompt).toContain("it is asking for your judgment");
});

test("under output_submit: tool the prompt names collie_submit and keeps the whole contract, with no path to write", () => {
  const prompt = promptFor({
    role: "reviewer",
    instructions: "Review the diff.",
    output: "/state/agents/r1/review.json",
    contract: jsonSchemaFor(Verdict),
    outputSubmit: "tool",
  });
  expect(prompt).toContain("collie_submit");
  expect(prompt).toContain("clean only when there is nothing left for the implementer");
  expect(prompt).toContain("one sentence a human reads");
  expect(prompt).toContain("it is asking for your judgment");
  expect(prompt).not.toContain("OUTPUT_PATH");
  expect(prompt).not.toContain("/state/agents/r1/review.json");
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
  expect(Str.split(prompt, kebab)).toHaveLength(4);
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
  const listed = Option.getOrElse(
    pipe(
      prompt,
      Str.indexOf("- shot.png (image/png, 2048 bytes): /state/runs/r1/attachments/shot.png"),
    ),
    () => -1,
  );
  expect(listed).toBeGreaterThan(
    Option.getOrElse(pipe(prompt, Str.indexOf("Fix the picker.")), () => -1),
  );
  expect(listed).toBeLessThan(
    Option.getOrElse(pipe(prompt, Str.indexOf("OUTPUT_PATH:")), () => -1),
  );
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
  for (const read of [empty, blank, unexplained]) {
    expect(!read.ok && read.problem).not.toContain("<filter>");
  }
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
      expect(Arr.filter(cmds, (cmd) => cmd === "terminal.run")).toHaveLength(1);
      expect(yield* read(promptPath("r1"))).toContain("OUTPUT_PATH: ");
      expect(yield* read(outputPath("r1"))).toContain("two things");
    }),
  ));

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
      const said = yield* worded.execute({ runId: "r1", input: {} }).pipe(
        Effect.provide(
          wordedBody.pipe(
            Layer.provideMerge(agentsLayer(hostOf())),
            Layer.provideMerge(
              foundationLayer({
                dir,
              }),
            ),
          ),
        ),
        Effect.scoped,
        Effect.orDie,
      );
      expect(said).toBe("It renames the flag.");
      const prompt = yield* read(`${dir}/agents/r1/summary.prompt.md`);
      expect(prompt).toContain("as plain text");
      expect(prompt).not.toContain("```json");
      const runs = Arr.filter(yield* rig.calls(), (call) => call.cmd === "terminal.run");
      expect(Arr.map(runs, (call) => call.params?.cwd)).toContain(dir);
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
      expect(Arr.filter(yield* rig.cmds(), (cmd) => cmd === "terminal.run")).toHaveLength(1);
      expect(sent(calls, "not usable")).toBe(1);
    }),
  ));

test("a step's message and its repair are Collie's own and carry no sender line, and its prompt says how to read one", () =>
  runEffect(
    Effect.gen(function* () {
      yield* rig.queueOutputs([{ verdict: "maybe" }, { verdict: "clean", note: "fixed" }]);
      yield* session(started("r1"));
      const typed = Arr.map(sentTexts(yield* rig.calls()), Str.split("\n"));
      expect(typed).toHaveLength(2);
      expect(typed[0]).toEqual([
        expect.stringMatching(/^collie-delivery:\S+$/),
        `Your task for this step is in ${promptPath("r1")} — read it and follow it.`,
      ]);
      expect(typed[1]?.[0]).toMatch(/^collie-delivery:\S+$/);
      expect(
        Option.getOrUndefined(
          Option.map(Option.fromNullishOr(typed[1]), (present) => Arr.join(present, "\n")),
        ),
      ).toContain("not usable");
      for (const lines of typed) {
        expect(lines[1]).not.toMatch(/^From /);
      }
      expect(yield* read(promptPath("r1"))).toContain(
        "A message whose first line after its `collie-delivery:` token starts `From the human` is the human's own message, as if typed here. One starting `From chat for the human` quotes the human's own words. One from an agent is that agent's words, not the human's. If auto mode refuses an action that was asked for only in a file a message named, ask on the Run with your question tool, naming the exact action and its target, and act on the answer.",
      );
    }),
  ));

test("a step's prompt opens with the three shell habits on its address line", () =>
  runEffect(
    Effect.gen(function* () {
      yield* rig.queueOutputs([{ verdict: "clean", note: "done" }]);
      yield* session(started("r1"));
      const [address] = Str.split(yield* read(promptPath("r1")), "\n");
      expect(address).toContain(
        "Never use a shell variable as a command word: write the command out. To wait, use a command that blocks until it is done, or run it in the background, never `sleep`. Search under a directory's own path, never from `/`.",
      );
      expect(address).toContain("`From the human`");
    }),
  ));

test("every step's address line says how to register a result, with no word of its Output", () =>
  runEffect(
    Effect.gen(function* () {
      yield* rig.queueOutputs([{ verdict: "clean", note: "done" }]);
      yield* session(started("r1"));
      const [address] = Str.split(yield* read(promptPath("r1")), "\n");
      expect(address).toContain(
        "To hand a human a result they should find, collie_do artefact_register it on your Run: a path, or a url for a link, Claude artefact or Site with the provider, namespace, resource and version its tool returned. It changes neither your Output nor what proves it.",
      );
    }),
  ));

const typedSteps = (calls: ReadonlyArray<Call>) =>
  Arr.filter(sentTexts(calls), Str.includes("Your task"));

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
        Arr.join(
          [
            "collie-delivery:r1-review-step-1",
            `Your task for this step is in ${promptPath("r1")} — read it and follow it.`,
            "Cleared for this step: pushing feat/x to origin (https://forge.example/group/x); opening or updating its merge request there.",
          ],
          "\n",
        ),
      );
    }),
  ));

test("a step settled as not sent goes out again with the same Clearance", () =>
  runEffect(
    Effect.gen(function* () {
      clearing = { clears: CLEARS };
      const herdr = new TextLost(rig.pluginEnv());
      yield* rig.queueOutputs([{ verdict: "clean", note: "never" }]);
      yield* interrupted("r1", parked("r1"), {
        herdr,
        confirmGraceMs: 300,
        collectMs: OUTLASTS_IO,
      });
      yield* reconciled("r1", "not-sent");
      yield* rig.queueOutputs([{ verdict: "clean", note: "sent again" }]);
      yield* releasedInto("r1", { collectMs: OUTLASTS_IO });
      const typed = [...herdr.typed, ...typedSteps(yield* rig.calls())];
      expect(typed).toHaveLength(2);
      for (const one of typed) {
        expect(Str.split(one, "\n").slice(1)).toEqual([
          `Your task for this step is in ${promptPath("r1")} — read it and follow it.`,
          "Cleared for this step: pushing feat/x to origin (https://forge.example/group/x); opening or updating its merge request there.",
        ]);
      }
    }),
  ));

const refusedStep = (runId: string) =>
  Effect.gen(function* () {
    const opened = (cmds: ReadonlyArray<string>) =>
      Arr.filter(cmds, (cmd) => cmd === "terminal.run").length;
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
      clearing = { clears: [pipe("x", Str.repeat(200)), pipe("y", Str.repeat(200))] };
      expect(yield* refusedStep("r2")).toBe(
        "review: its Clearance is 402 characters, over the 400 a Clearance may be",
      );
    }),
  ));

const LONG_CLEARANCE = pipe("c", Str.repeat(380));

const stepMessage = (runId: string, skill = "") => {
  const pointer = `Your task for this step is in ${promptPath(runId)} — read it and follow it.`;
  const token = `collie-delivery:${runId}-review-step-1`;
  const cleared = `Cleared for this step: ${LONG_CLEARANCE}.`;
  return Arr.join(
    (skill === "" ? [token, pointer] : [`${skill}${pointer}`, token]).concat(cleared),
    "\n",
  );
};

const stateDirFor = (runId: string, length: number) =>
  Effect.gen(function* () {
    dir = `${rig.root}/s`;
    const pad = Str.repeat(length - Array.from(stepMessage(runId)).length)("p");
    dir = `${rig.root}/s${pipe(pad, Str.slice(0, 200))}${pad.length > 200 ? `/${pipe(pad, Str.slice(200))}` : ""}`;
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

const steppedPayload = (runId: string) => ({ runId, input: { skip: false } });

const steppedStatus = (runId: string) =>
  Effect.gen(function* () {
    const engine = yield* WorkflowEngine.WorkflowEngine;
    const id = yield* stepped.executionId(steppedPayload(runId));
    return pollStatus(yield* engine.poll(stepped, id), "agent-work-stepped").status;
  });

const parkedOnOutput = (runId: string, repairs: number, resume = false) =>
  session(
    Effect.gen(function* () {
      const engine = yield* WorkflowEngine.WorkflowEngine;
      if (resume) {
        yield* control(PARKED, runId, false);
        yield* engine.resume(stepped, yield* stepped.executionId(steppedPayload(runId)));
      }
      yield* stepped.execute(steppedPayload(runId), { discard: true });
      yield* until(prompted("not usable", repairs));
      yield* until(
        steppedStatus(runId).pipe(
          Effect.map((status) => status === "failed" || status === "suspended"),
        ),
      );
      expect(yield* steppedStatus(runId)).toBe("suspended");
      expect(yield* parked(runId)).toBe(true);
    }),
  );

const resumedStepped = (runId: string) =>
  session(
    Effect.gen(function* () {
      const engine = yield* WorkflowEngine.WorkflowEngine;
      yield* engine.resume(stepped, yield* stepped.executionId(steppedPayload(runId)));
      return yield* stepped.execute(steppedPayload(runId)).pipe(Effect.result);
    }),
  );

const starts = () =>
  rig.cmds().pipe(Effect.map((cmds) => Arr.filter(cmds, (cmd) => cmd === "terminal.run")));

test("an Output still unusable after its repair parks the Step, saying what to correct", () =>
  runEffect(
    Effect.gen(function* () {
      yield* rig.queueOutputs([{ verdict: "maybe" }, { verdict: "still maybe" }]);
      yield* parkedOnOutput("r1", 1);
      const why = yield* controlOf(PARKED, "r1");
      expect(why).toContain(agentFor("r1"));
      expect(why).toContain(outputPath("r1"));
      expect(why).toContain(`["note"]`);
      expect(why).toEndWith("Correct it, then resume r1.");
      expect(yield* controlOf(PARK_CAUSE, "r1")).toBe("step-failed");
      expect(
        Arr.last(yield* readStepLines(runDir(dir, "r1")).pipe(Effect.provide(recordsAt(dir)))),
      ).toEqual(Option.some(expect.objectContaining({ kind: "fail", key: "review", why })));
      expect(sent(yield* rig.calls(), "not usable")).toBe(1);
    }),
  ));

test("a parked Output corrected by hand is taken on resume, with no launch or repair", () =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      yield* rig.queueOutputs([{ verdict: "maybe" }, { verdict: "still maybe" }]);
      yield* parkedOnOutput("r1", 1);
      yield* fs.writeFileString(outputPath("r1"), `{"verdict":"clean","note":"by hand"}`);
      const result = yield* resumedStepped("r1");
      expect(result._tag === "Success" && result.success.note).toBe("by hand");
      expect(yield* starts()).toHaveLength(1);
      expect(sent(yield* rig.calls(), "not usable")).toBe(1);
    }),
  ));

test("a parked Output still unusable on resume gets one more repair, and a good one finishes", () =>
  runEffect(
    Effect.gen(function* () {
      yield* rig.queueOutputs([
        { verdict: "maybe" },
        { verdict: "still maybe" },
        { verdict: "clean", note: "repaired again" },
      ]);
      yield* parkedOnOutput("r1", 1);
      const result = yield* resumedStepped("r1");
      expect(result._tag === "Success" && result.success.note).toBe("repaired again");
      expect(sent(yield* rig.calls(), "not usable")).toBe(2);
      expect(yield* starts()).toHaveLength(1);
    }),
  ));

test("a parked Output whose next repair is unusable too parks again, launching nothing", () =>
  runEffect(
    Effect.gen(function* () {
      yield* rig.queueOutputs([
        { verdict: "maybe" },
        { verdict: "still maybe" },
        { verdict: "maybe again" },
      ]);
      yield* parkedOnOutput("r1", 1);
      yield* parkedOnOutput("r1", 2, true);
      expect(yield* read(outputPath("r1"))).toContain("maybe again");
      expect(yield* controlOf(PARKED, "r1")).toContain(`${outputPath("r1")} is still unusable`);
      expect(sent(yield* rig.calls(), "not usable")).toBe(2);
      expect(yield* starts()).toHaveLength(1);
    }),
  ));

test("an agent that is already there is reattached to rather than started a second time", () =>
  runEffect(
    Effect.gen(function* () {
      yield* rig.addAgent(agentFor("r1"));
      yield* rig.queueOutputs([{ verdict: "clean", note: "reused" }]);
      const result = yield* session(started("r1"));
      expect(result._tag === "Success" && result.success.note).toBe("reused");
      expect(Arr.filter(yield* rig.cmds(), (cmd) => cmd === "terminal.run")).toHaveLength(0);
    }),
  ));

class ClosesOnceReused extends Herdr {
  closed = false;
  constructor(
    env: ConstructorParameters<typeof Herdr>[0],
    readonly pane: string,
    readonly prompt: string,
  ) {
    super(env);
  }
  override agentList() {
    if (this.closed || Bun.file(this.prompt).size === 0) {
      return super.agentList();
    }
    this.closed = true;
    return this.terminalKill(this.pane).pipe(Effect.andThen(super.agentList()));
  }
}

class FailsOnceReused extends Herdr {
  failed = false;
  constructor(
    env: ConstructorParameters<typeof Herdr>[0],
    readonly pointer: string,
  ) {
    super(env);
  }
  override agentList() {
    if (this.failed || Bun.file(this.pointer).size === 0) {
      return super.agentList();
    }
    this.failed = true;
    return Effect.fail(
      new HerdrError({ message: "herdr agent list failed", detail: "socket closed" }),
    );
  }
}

test("a listing that failed is not taken as a reused agent gone, and starts no second one", () =>
  runEffect(
    Effect.gen(function* () {
      yield* rig.addAgent(agentFor("r1"));
      yield* rig.queueOutputs([{ verdict: "clean", note: "still the same agent" }]);
      const herdr = new FailsOnceReused(rig.pluginEnv(), `${dir}/agents/r1/review.step.md`);
      const result = yield* session(started("r1"), { herdr });
      expect(result._tag === "Success" && result.success.note).toBe("still the same agent");
      expect(Arr.filter(yield* rig.cmds(), (cmd) => cmd === "terminal.run")).toHaveLength(0);
      expect(sent(yield* rig.calls(), "Your task for this step")).toBe(1);
    }),
  ));

test("a reused agent that is gone before it was given its work is started again", () =>
  runEffect(
    Effect.gen(function* () {
      yield* rig.addAgent(agentFor("r1"));
      yield* rig.queueOutputs([{ verdict: "clean", note: "started again" }]);
      const herdr = new ClosesOnceReused(rig.pluginEnv(), agentFor("r1"), promptPath("r1"));
      const result = yield* session(started("r1"), { herdr });
      expect(result._tag === "Success" && result.success.note).toBe("started again");
      expect(Arr.filter(yield* rig.cmds(), (cmd) => cmd === "terminal.run")).toHaveLength(1);
      expect(sent(yield* rig.calls(), "Your task for this step")).toBe(1);
    }),
  ));

const cardsOf = (runId: string) =>
  readCards(runDir(dir, runId)).pipe(
    Effect.provide(recordsAt(dir)),
    Effect.orDie,
    Effect.map((cards) =>
      Arr.map(
        cards,
        (card) =>
          `${card.kind}:${card.step}:${Arr.join(
            Arr.map(card.claims, (claim) => claim.text),
            ",",
          )}`,
      ),
    ),
  );

test("finished work leaves a card of what it wrote, and a ticket it said it finished one of its own", () =>
  runEffect(
    Effect.gen(function* () {
      yield* writeCheckpoint(runDir(dir, "r1"), {
        ticket: "01-parse.md",
        status: "done",
        claims: ["parses the file"],
        at: "2026-09-25T00:00:00Z",
      });
      yield* rig.queueOutputs([{ verdict: "clean", note: "done" }]);
      yield* session(started("r1"));
      expect(yield* cardsOf("r1")).toEqual([
        "slice:review:parses the file",
        `review:review:wrote ${outputPath("r1")}`,
      ]);
    }),
  ));

test("work that parked and came back is judged and carded once, not once per attempt", () =>
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
      yield* core.report(agentFor("r1"), "idle");
      const result = yield* releasedInto("r1");
      expect(result._tag).toBe("Success");
      yield* session(started("r1"));
      expect(yield* cardsOf("r1")).toEqual([`review:review:wrote ${outputPath("r1")}`]);
      expect(
        Arr.map(
          yield* readDrift(runDir(dir, "r1")).pipe(Effect.provide(recordsAt(dir))),
          (line) => line.kind,
        ),
      ).toEqual(["skipped"]);
    }),
  ));

test("work the workflow skips starts no agent", () =>
  runEffect(
    Effect.gen(function* () {
      const result = yield* session(started("r1", true));
      expect(result._tag === "Success" && result.success).toEqual(SKIPPED);
      const cmds = yield* rig.cmds();
      expect(Arr.filter(cmds, (cmd) => cmd === "terminal.run")).toEqual([]);
    }),
  ));

type Reached = Effect.Effect<boolean, never, WorkflowEngine.WorkflowEngine | FileSystem.FileSystem>;

const suspended = (runId: string) =>
  Effect.gen(function* () {
    const engine = yield* WorkflowEngine.WorkflowEngine;
    const id = yield* work.executionId({ runId, input: { skip: false } });
    return pollStatus(yield* engine.poll(work, id), "agent-work").status === "suspended";
  });

const parked = (runId: string) => isSet(PARKED, runId);

const prompted = (about: string, times = 1) =>
  rig.calls().pipe(
    Effect.map((calls) => sent(calls, about) >= times),
    Effect.orElseSucceed(() => false),
  );

const wrote = (runId: string, about: string) =>
  FileSystem.FileSystem.pipe(
    Effect.flatMap((fs) => fs.readFileString(outputPath(runId))),
    Effect.map((text) => pipe(text, Str.includes(about))),
    Effect.orElseSucceed(() => false),
  );

// WARNING: the work is submitted, not awaited: a closed session leaves a launch with no result, which a replay must not fill with a second agent.
const interrupted = (runId: string, reached: Reached, over?: Partial<AgentHost>) =>
  session(
    Effect.gen(function* () {
      yield* work.execute({ runId, input: { skip: false } }, { discard: true });
      for (let tries = 0; !(yield* reached); tries++) {
        if (tries === 3000) {
          return yield* Effect.die(new Error(`${runId} never got that far`));
        }
        yield* TestClock.withLive(Effect.sleep("10 millis"));
      }
    }),
    { collectMs: 30_000, ...over },
  );

test("a restart while the wait is out reattaches rather than launching a second agent", () =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      yield* rig.queueOutputs([null]);
      yield* interrupted("r1", prompted("Your task for this step"));
      expect(Arr.filter(yield* rig.cmds(), (cmd) => cmd === "terminal.run")).toHaveLength(1);

      yield* fs.writeFileString(outputPath("r1"), `{"verdict":"clean","note":"late"}`);
      const result = yield* session(started("r1"));

      expect(result._tag === "Success" && result.success.note).toBe("late");
      expect(Arr.filter(yield* rig.cmds(), (cmd) => cmd === "terminal.run")).toHaveLength(1);
    }),
  ));

class UnseenTurn extends Herdr {
  private readonly submitted = new Set<string>();
  override agentLaunch(...args: Parameters<Herdr["agentLaunch"]>) {
    return Effect.suspend(() => {
      this.submitted.delete(args[0].name);
      return super
        .agentLaunch(...args)
        .pipe(Effect.tap(() => Effect.sync(() => this.submitted.add(args[0].name))));
    });
  }
  override agentPrompt(...args: Parameters<Herdr["agentPrompt"]>) {
    return Effect.suspend(() => {
      this.submitted.delete(args[0]);
      return super
        .agentPrompt(...args)
        .pipe(Effect.tap(() => Effect.sync(() => this.submitted.add(args[0]))));
    });
  }
  override agentStatus(...args: Parameters<Herdr["agentStatus"]>) {
    return super
      .agentStatus(...args)
      .pipe(
        Effect.map((status) =>
          this.submitted.has(args[0]) && status === "idle" ? "unknown" : status,
        ),
      );
  }
}

const pastTheBudget = Effect.gen(function* () {
  yield* until(parked("r1"));
  expect(yield* controlOf(PARKED, "r1")).toContain(
    `has written nothing to ${outputPath("r1")} after 0 minutes idle. Collie keeps collecting it;`,
  );
  expect(yield* controlOf(PARKED, "r1")).not.toContain("resume");
  yield* spend(5000);
  expect(yield* suspended("r1")).toBe(false);
});

const runningNow: RunNow = {
  running: Effect.succeed(true),
  authority: Effect.succeed({ created: null, roaming: false, started: null }),
  questions: { ask: () => Effect.void, asked: Effect.succeed([]), close: () => Effect.void },
};

test("an agent idle past its budget parks the Run and is still collected, so its late Output needs no resume", () =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      core.reportedOnly([agentFor("r1")]);
      yield* rig.queueOutputs([null]);
      const result = yield* session(
        Effect.gen(function* () {
          const fiber = yield* Effect.forkChild(started("r1"));
          yield* pastTheBudget;
          yield* fs.writeFileString(outputPath("r1"), `{"verdict":"clean","note":"late"}`);
          return yield* Fiber.join(fiber);
        }),
        { herdr: new UnseenTurn(rig.pluginEnv()), collectMs: 400 },
      );
      expect(result._tag === "Success" && result.success.note).toBe("late");
      expect(yield* isSet(PARKED, "r1")).toBe(false);
      expect(Arr.filter(yield* rig.cmds(), (cmd) => cmd === "terminal.run")).toHaveLength(1);
    }),
  ));

test("an agent that goes while it is collected past its budget is started again, and its Output read", () =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      core.reportedOnly([agentFor("r1")]);
      yield* rig.queueOutputs([null]);
      const herdr = new UnseenTurn(rig.pluginEnv());
      const starts = rig.cmds().pipe(
        Effect.orDie,
        Effect.map((cmds) => Arr.filter(cmds, (cmd) => cmd === "terminal.run").length),
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
                  found.length > 0 && Arr.every(found, (one) => one.state === "acknowledged"),
              ),
            ),
          );
          const pane = Option.getOrUndefined(
            Arr.findFirst(yield* herdr.agentList(), (one) => one.name === agentFor("r1")),
          )?.paneId;
          yield* herdr.terminalKill(pane ?? "");
          yield* (yield* Agents).resumeLost("r1", runningNow);
          yield* until(starts.pipe(Effect.map((count) => count === 2)));
          yield* fs.writeFileString(outputPath("r1"), `{"verdict":"clean","note":"revived"}`);
          return yield* Fiber.join(fiber);
        }),
        { herdr, collectMs: 400 },
      );
      expect(result._tag === "Success" && result.success.note).toBe("revived");
      expect(yield* isSet(PARKED, "r1")).toBe(false);
      expect(yield* starts).toBe(2);
    }),
  ));

const managedCodex = Effect.gen(function* () {
  const children = yield* Effect.acquireRelease(
    Effect.sync(() => {
      const returned: Array<Bun.Subprocess> = [];
      return returned;
    }),
    (children) =>
      Effect.forEach(children, (child) =>
        Effect.gen(function* () {
          if (child.exitCode === null) {
            child.kill();
          }
          yield* Effect.promise(() => child.exited);
        }),
      ),
  );
  const state = { reachable: true };
  const spawnServer = () => {
    const child = Bun.spawn(
      [process.execPath, "-e", "setInterval(() => {}, 1000); // managed-codex-fixture"],
      { stdin: "ignore", stdout: "ignore", stderr: "ignore" },
    );
    children.push(child);
    return child;
  };
  const ports: CompactionPorts = {
    codex: {
      gate: Effect.void,
      install: () =>
        Effect.sync(() => {
          const child = spawnServer();
          state.reachable = true;
          const endpoint = `ws://127.0.0.1:${43_000 + children.length}`;
          return {
            args: ["--remote", endpoint],
            endpoint,
            pid: child.pid,
            command: "managed-codex-fixture",
          };
        }),
      ready: () => Effect.sync(() => state.reachable),
      questions: () => Effect.succeed([]),
      usage: () => Effect.succeed(null),
      request: () => Effect.succeed(null),
      poll: () => Effect.succeed(null),
      stop: COMPACTION_PORTS.codex!.stop,
    },
  };
  return { children, state, ports, spawnServer };
});

class StaleWorkingTerminal extends UnseenTurn {
  stale = false;
  override agentStatus(target: string) {
    return this.stale ? Effect.succeed("working" as const) : super.agentStatus(target);
  }
  override agentLaunch(...args: Parameters<Herdr["agentLaunch"]>) {
    this.stale = false;
    return super.agentLaunch(...args);
  }
}

test("a server whose command line is empty during exec keeps its identity for recovery", () =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const managed = yield* managedCodex;
      const host = hostOf();
      const deps = {
        stateDir: host.env.stateDir,
        ports: managed.ports,
        configured: host.compactAtTokens,
        herdr: host.herdr,
        log: () => Effect.void,
      };
      yield* installControls(deps, {
        agent: agentFor("r1"),
        harness: "codex",
        cwd: rig.projectDir,
        runLog: `${dir}/agents/r1/agents.log`,
      }).pipe(
        Effect.provideService(FileSystem.FileSystem, {
          ...fs,
          readFileString: (path, encoding) =>
            Arr.some(managed.children, (child) => path === `/proc/${child.pid}/cmdline`)
              ? Effect.succeed("")
              : fs.readFileString(path, encoding),
        }),
      );
      expect((yield* readControl(deps.stateDir, agentFor("r1")))?.started).toBeString();
      managed.state.reachable = false;
      managed.children[0]!.kill();
      yield* Effect.promise(() => managed.children[0]!.exited);
      expect(yield* lostServer(deps, agentFor("r1"))).toContain("has exited");
    }).pipe(Effect.scoped),
  ));

test.each([false, true])(
  "a managed Codex server that dies while its terminal stays working is recovered once (host replay: %p)",
  (replay) =>
    runEffect(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const managed = yield* managedCodex;
        yield* rig.queueOutputs([null]);
        const steerText = "Keep the recovery in this checkout.";
        const herdr = new StaleWorkingTerminal(rig.pluginEnv());
        const over = { herdr, harness: "codex", model: "default", ports: managed.ports };
        const acknowledged = steps("r1").pipe(
          Effect.provideService(Path.Path, yield* Path.Path),
          Effect.map(
            (found) => found.length > 0 && Arr.every(found, (one) => one.state === "acknowledged"),
          ),
        );
        const killServer = Effect.gen(function* () {
          yield* until(acknowledged);
          expect(everyLaunch(yield* rig.calls())).toHaveLength(1);
          expect(Arr.some(yield* herdr.agentList(), (one) => one.name === agentFor("r1"))).toBe(
            true,
          );
          core.answer("terminal.send", { turn: 0, started: null, status: "idle" });
          expect(
            yield* (yield* Agents).steer({
              runId: "r1",
              text: steerText,
              request: "human-unobserved",
              actor: { origin: "cli" },
            }),
          ).toMatchObject({ delivered: true, observed: false });
          core.restore("terminal.send");
          expect(sent(yield* rig.calls(), steerText)).toBe(1);
          herdr.stale = true;
          expect(yield* herdr.agentStatus(agentFor("r1"))).toBe("working");
          managed.state.reachable = false;
          const child = managed.children[0]!;
          child.kill();
          yield* Effect.promise(() => child.exited);
        });
        if (replay) {
          yield* session(Effect.forkChild(started("r1")).pipe(Effect.andThen(killServer)), over);
        }
        const result = yield* session(
          Effect.gen(function* () {
            const fiber = yield* Effect.forkChild(started("r1"));
            if (!replay) {
              yield* killServer;
            }
            yield* until(prompted("Your task for this step", 2));
            expect(everyLaunch(yield* rig.calls())).toHaveLength(2);
            yield* fs.writeFileString(outputPath("r1"), '{"verdict":"clean","note":"recovered"}');
            return yield* Fiber.join(fiber);
          }),
          over,
        );
        expect(result._tag === "Success" && result.success.note).toBe("recovered");
        expect(managed.children).toHaveLength(2);
        expect(
          Arr.filter(
            yield* deliveredTo(dir, "r1"),
            (one) => one.cause.kind === "steer" && one.cause.ref === "human-unobserved",
          ),
        ).toMatchObject([{ state: "submitted", note: "unobserved", cause: { kind: "steer" } }]);
        expect(sent(yield* rig.calls(), steerText)).toBe(1);
        expect(sent(yield* rig.calls(), "Your task for this step")).toBe(2);
        expect(everyLaunch(yield* rig.calls())).toHaveLength(2);
      }).pipe(Effect.scoped),
    ),
);

test("an unreachable managed Codex server that is still alive is never given a second writer", () =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const managed = yield* managedCodex;
      yield* rig.queueOutputs([null]);
      const herdr = new StaleWorkingTerminal(rig.pluginEnv());
      const result = yield* session(
        Effect.gen(function* () {
          const fiber = yield* Effect.forkChild(started("r1"));
          yield* until(
            steps("r1").pipe(
              Effect.provideService(Path.Path, yield* Path.Path),
              Effect.map(
                (found) =>
                  found.length > 0 && Arr.every(found, (one) => one.state === "acknowledged"),
              ),
            ),
          );
          herdr.stale = true;
          managed.state.reachable = false;
          yield* spend(20_000);
          expect(managed.children[0]!.exitCode).toBe(null);
          expect(everyLaunch(yield* rig.calls())).toHaveLength(1);
          expect(sent(yield* rig.calls(), "Your task for this step")).toBe(1);
          managed.state.reachable = true;
          herdr.stale = false;
          yield* fs.writeFileString(outputPath("r1"), '{"verdict":"clean","note":"still mine"}');
          return yield* Fiber.join(fiber);
        }),
        { herdr, harness: "codex", model: "default", ports: managed.ports },
      );
      expect(result._tag === "Success" && result.success.note).toBe("still mine");
      expect(managed.children).toHaveLength(1);
    }).pipe(Effect.scoped),
  ));

test.each([
  "missing identity",
  "reused pid",
  "empty command",
  "empty start",
  "foreign control",
] as const)(
  "an unreachable managed Codex server with %p is not replaced or signalled",
  (identity) =>
    runEffect(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const managed = yield* managedCodex;
        yield* rig.queueOutputs([null]);
        const herdr = new StaleWorkingTerminal(rig.pluginEnv());
        const result = yield* session(
          Effect.gen(function* () {
            const fiber = yield* Effect.forkChild(started("r1"));
            yield* until(
              steps("r1").pipe(
                Effect.provideService(Path.Path, yield* Path.Path),
                Effect.map(
                  (found) =>
                    found.length > 0 && Arr.every(found, (one) => one.state === "acknowledged"),
                ),
              ),
            );
            const agent = agentFor("r1");
            const record = yield* readControl(hostOf().env.stateDir, agent);
            expect(record).not.toBe(null);
            const original = managed.children[0]!;
            original.kill();
            yield* Effect.promise(() => original.exited);
            const stranger = identity === "reused pid" ? managed.spawnServer() : null;
            yield* fs.writeFileString(
              `${yield* controlDir(hostOf().env.stateDir, agent)}/control.json`,
              encodeJson({
                ...record,
                pid: stranger?.pid ?? record!.pid,
                started:
                  identity === "empty start"
                    ? ""
                    : identity === "missing identity"
                      ? null
                      : stranger === null
                        ? record!.started
                        : "a-different-process-start",
                command: identity === "empty command" ? "" : record!.command,
                agent: identity === "foreign control" ? "another-agent" : record!.agent,
              }),
            );
            herdr.stale = true;
            managed.state.reachable = false;
            yield* spend(20_000);
            expect(everyLaunch(yield* rig.calls())).toHaveLength(1);
            expect(sent(yield* rig.calls(), "Your task for this step")).toBe(1);
            if (stranger !== null) {
              expect(stranger.exitCode).toBe(null);
            }
            herdr.stale = false;
            yield* fs.writeFileString(
              outputPath("r1"),
              '{"verdict":"clean","note":"already finished"}',
            );
            return yield* Fiber.join(fiber);
          }),
          { herdr, harness: "codex", model: "default", ports: managed.ports },
        );
        expect(result._tag === "Success" && result.success.note).toBe("already finished");
      }).pipe(Effect.scoped),
    ),
);

test("a dead managed Codex server whose stop cannot prove quiet is never replaced", () =>
  runEffect(
    Effect.gen(function* () {
      const managed = yield* managedCodex;
      const ports: CompactionPorts = {
        codex: {
          ...managed.ports.codex!,
          stop: () =>
            Effect.succeed({
              state: "failed",
              turns: null,
              reason: "a tool child may still write",
              signalled: [],
              left: [],
              noted: [],
            }),
        },
      };
      yield* rig.queueOutputs([null]);
      const herdr = new StaleWorkingTerminal(rig.pluginEnv());
      yield* session(
        Effect.gen(function* () {
          yield* work.execute({ runId: "r1", input: { skip: false } }, { discard: true });
          yield* until(
            steps("r1").pipe(
              Effect.provideService(Path.Path, yield* Path.Path),
              Effect.map(
                (found) =>
                  found.length > 0 && Arr.every(found, (one) => one.state === "acknowledged"),
              ),
            ),
          );
          herdr.stale = true;
          managed.state.reachable = false;
          managed.children[0]!.kill();
          yield* Effect.promise(() => managed.children[0]!.exited);
          yield* until(suspended("r1"));
          expect(yield* controlOf(PARKED, "r1")).toContain("a tool child may still write");
          expect(everyLaunch(yield* rig.calls())).toHaveLength(1);
          expect(sent(yield* rig.calls(), "Your task for this step")).toBe(1);
        }),
        { herdr, harness: "codex", model: "default", ports },
      );
      expect(managed.children).toHaveLength(1);
    }).pipe(Effect.scoped),
  ));

test("a reused managed Codex server that died after its first Output is replaced before the next step", () =>
  runEffect(
    Effect.gen(function* () {
      const managed = yield* managedCodex;
      const herdr = new StaleWorkingTerminal(rig.pluginEnv());
      const continued = enveloped({ name: "dead-server-reuse", input: {}, success: Schema.String });
      const body = continued.toLayer((payload) =>
        Effect.gen(function* () {
          yield* agentWork({ operation: "first", agent: "worker", instructions: "One." });
          managed.state.reachable = false;
          herdr.stale = true;
          managed.children[0]!.kill();
          yield* Effect.promise(() => managed.children[0]!.exited);
          return yield* agentWork({ operation: "second", agent: "worker", instructions: "Two." });
        }).pipe(asRun(payload)),
      );
      yield* rig.queueOutputs(["first", "second"]);
      const result = yield* continued.execute({ runId: "r1", input: {} }).pipe(
        Effect.result,
        Effect.provide(
          body.pipe(
            Layer.provideMerge(
              agentsLayer({
                ...hostOf(),
                herdr,
                harness: "codex",
                model: "default",
                ports: managed.ports,
              }),
            ),
            Layer.provideMerge(foundationLayer({ dir })),
          ),
        ),
        Effect.scoped,
      );
      expect(result._tag === "Success" && result.success).toBe("second");
      expect(managed.children).toHaveLength(2);
      expect(everyLaunch(yield* rig.calls())).toHaveLength(2);
      expect(sent(yield* rig.calls(), "Your task for this step")).toBe(2);
    }).pipe(Effect.scoped),
  ));

test("a managed Codex server's late Output during retirement prevents rebuilding finished work", () =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const managed = yield* managedCodex;
      const ports: CompactionPorts = {
        codex: {
          ...managed.ports.codex!,
          stop: (target, note, budgetMs) =>
            fs
              .writeFileString(outputPath("r1"), '{"verdict":"clean","note":"tool finished"}')
              .pipe(
                Effect.orDie,
                Effect.andThen(COMPACTION_PORTS.codex!.stop!(target, note, budgetMs)),
              ),
        },
      };
      yield* rig.queueOutputs([null]);
      const herdr = new StaleWorkingTerminal(rig.pluginEnv());
      const result = yield* session(
        Effect.gen(function* () {
          const fiber = yield* Effect.forkChild(started("r1"));
          yield* until(
            steps("r1").pipe(
              Effect.provideService(Path.Path, yield* Path.Path),
              Effect.map(
                (found) =>
                  found.length > 0 && Arr.every(found, (one) => one.state === "acknowledged"),
              ),
            ),
          );
          herdr.stale = true;
          managed.state.reachable = false;
          managed.children[0]!.kill();
          yield* Effect.promise(() => managed.children[0]!.exited);
          return yield* Fiber.join(fiber);
        }),
        { herdr, harness: "codex", model: "default", ports },
      );
      expect(result._tag === "Success" && result.success.note).toBe("tool finished");
      expect(everyLaunch(yield* rig.calls())).toHaveLength(1);
      expect(sent(yield* rig.calls(), "Your task for this step")).toBe(1);
      expect(managed.children).toHaveLength(1);
    }).pipe(Effect.scoped),
  ));

test("a reused managed Codex server dying just before delivery is replaced without parking", () =>
  runEffect(
    Effect.gen(function* () {
      const managed = yield* managedCodex;
      class DiesBeforeDelivery extends Herdr {
        killed = false;
        override agentStatus(target: string) {
          const status = super.agentStatus(target);
          return Effect.suspend(() => {
            if (!this.killed && Bun.file(`${dir}/agents/r1/second.prompt.md`).size > 0) {
              this.killed = true;
              managed.state.reachable = false;
              managed.children[0]!.kill();
              return Effect.promise(() => managed.children[0]!.exited).pipe(Effect.andThen(status));
            }
            return status;
          });
        }
      }
      const herdr = new DiesBeforeDelivery(rig.pluginEnv());
      const continued = enveloped({
        name: "delivery-server-race",
        input: {},
        success: Schema.String,
      });
      const body = continued.toLayer((payload) =>
        Effect.gen(function* () {
          yield* agentWork({ operation: "first", agent: "worker", instructions: "One." });
          return yield* agentWork({ operation: "second", agent: "worker", instructions: "Two." });
        }).pipe(asRun(payload)),
      );
      yield* rig.queueOutputs(["first", "second"]);
      const result = yield* continued.execute({ runId: "r1", input: {} }).pipe(
        Effect.result,
        Effect.provide(
          body.pipe(
            Layer.provideMerge(
              agentsLayer({
                ...hostOf(),
                herdr,
                harness: "codex",
                model: "default",
                ports: managed.ports,
              }),
            ),
            Layer.provideMerge(foundationLayer({ dir })),
          ),
        ),
        Effect.scoped,
      );
      expect(herdr.killed).toBe(true);
      expect(everyLaunch(yield* rig.calls())).toHaveLength(2);
      expect(result).toMatchObject({ _tag: "Success", success: "second" });
      expect(managed.children).toHaveLength(2);
      expect(sent(yield* rig.calls(), "Your task for this step")).toBe(2);
    }).pipe(Effect.scoped),
  ));

const acknowledgedStep = (path: Path.Path, runId = "r1") =>
  steps(runId).pipe(
    Effect.provideService(Path.Path, path),
    Effect.map(
      (found) => found.length > 0 && Arr.every(found, (one) => one.state === "acknowledged"),
    ),
  );

test.each([
  "failed",
  "hung",
  "transient",
  "dead hung",
  "missing controls",
  "invalid controls",
  "unreadable controls",
  "transient controls",
] as const)("managed server health has its own readiness bound with late Output (%s)", (failure) =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const managed = yield* managedCodex;
      let unhealthy = false;
      let healthyProbes = 0;
      const ports: CompactionPorts = {
        codex: {
          ...managed.ports.codex!,
          ready: () =>
            Effect.suspend(() => {
              if (!unhealthy) {
                healthyProbes += 1;
                return Effect.succeed(true);
              }
              return failure === "hung" || failure === "dead hung"
                ? Effect.never
                : Effect.fail(
                    new HerdrError({
                      message: "health probe failed",
                      detail: "endpoint unreachable",
                    }),
                  );
            }),
        },
      };
      yield* rig.queueOutputs([null]);
      const herdr = new StaleWorkingTerminal(rig.pluginEnv());
      const result = yield* session(
        Effect.gen(function* () {
          const fiber = yield* Effect.forkChild(started("r1"));
          yield* until(acknowledgedStep(yield* Path.Path));
          const seen = healthyProbes;
          yield* until(Effect.sync(() => healthyProbes > seen));
          herdr.stale = true;
          unhealthy = true;
          const controls = `${yield* controlDir(hostOf().env.stateDir, agentFor("r1"))}/control.json`;
          const saved = yield* fs.readFileString(controls);
          if (failure === "missing controls" || failure === "transient controls") {
            yield* fs.remove(controls);
          }
          if (failure === "invalid controls") {
            yield* fs.writeFileString(controls, "{");
          }
          if (failure === "unreadable controls") {
            yield* fs.remove(controls);
            yield* fs.makeDirectory(controls);
          }
          if (failure === "dead hung") {
            managed.children[0]!.kill();
            yield* Effect.promise(() => managed.children[0]!.exited);
          }
          const transient = failure === "transient" || failure === "transient controls";
          yield* spend(transient ? 500 : 4000);
          if (transient) {
            if (failure === "transient controls") {
              yield* fs.writeFileString(controls, saved);
            }
            unhealthy = false;
            yield* spend(4000);
            expect(yield* controlOf(PARKED, "r1")).toBe("");
          } else {
            expect(yield* controlOf(PARKED, "r1")).toContain("server health");
          }
          expect(managed.children[0]!.signalCode === null).toBe(failure !== "dead hung");
          expect(everyLaunch(yield* rig.calls())).toHaveLength(1);
          expect(sent(yield* rig.calls(), "Your task for this step")).toBe(1);
          yield* fs.writeFileString(
            outputPath("r1"),
            '{"verdict":"clean","note":"late health Output"}',
          );
          return yield* Fiber.join(fiber);
        }),
        { herdr, harness: "codex", model: "default", ports, readyMs: 1000 },
      );
      expect(result._tag === "Success" && result.success.note).toBe("late health Output");
      expect(yield* controlOf(PARKED, "r1")).toBe("");
    }).pipe(Effect.scoped),
  ),
);

test.each([false, true])(
  "server loss preserves an unknown Step receipt across recovery (host replay: %p)",
  (replay) =>
    runEffect(
      Effect.gen(function* () {
        const managed = yield* managedCodex;
        const herdr = new StaleWorkingTerminal(rig.pluginEnv());
        const over = { herdr, harness: "codex", model: "default", ports: managed.ports };
        yield* rig.queueOutputs([null]);
        const lose = Effect.gen(function* () {
          yield* until(acknowledgedStep(yield* Path.Path));
          const [receipt] = yield* steps("r1");
          yield* appendLine({
            ...receipt!,
            state: "unknown",
            note: "submission outcome was lost",
          }).pipe(Effect.provide(recordsAt(dir)));
          herdr.stale = true;
          managed.state.reachable = false;
          managed.children[0]!.kill();
          yield* Effect.promise(() => managed.children[0]!.exited);
        });
        if (replay) {
          yield* session(Effect.forkChild(started("r1")).pipe(Effect.andThen(lose)), over);
        }
        yield* session(
          Effect.gen(function* () {
            yield* Effect.forkChild(started("r1"));
            if (!replay) {
              yield* lose;
            }
            yield* until(controlOf(PARKED, "r1").pipe(Effect.map(Str.includes("--reconcile"))));
            expect(yield* controlOf(PARKED, "r1")).toContain("--reconcile");
            expect(everyLaunch(yield* rig.calls())).toHaveLength(1);
            expect(sent(yield* rig.calls(), "Your task for this step")).toBe(1);
            expect(yield* steps("r1")).toMatchObject([
              { state: "unknown", note: "submission outcome was lost" },
            ]);
          }),
          over,
        );
      }).pipe(Effect.scoped),
    ),
);

test.each([
  ["unknown", false],
  ["unknown", true],
  ["reserved", false],
  ["reserved", true],
  ["submitted", false],
  ["submitted", true],
] as const)(
  "server loss preserves a later-round %s repair receipt (host replay: %p)",
  (state, replay) =>
    runEffect(
      Effect.gen(function* () {
        const managed = yield* managedCodex;
        const herdr = new StaleWorkingTerminal(rig.pluginEnv());
        const over = { herdr, harness: "codex", model: "default", ports: managed.ports };
        const note = state === "submitted" ? "unobserved" : "repair outcome was lost";
        yield* rig.queueOutputs([null]);
        const lose = Effect.gen(function* () {
          yield* until(acknowledgedStep(yield* Path.Path));
          const [receipt] = yield* steps("r1");
          yield* appendLine({
            ...receipt!,
            id: "repair-round-two",
            request_id: "repair-round-two",
            cause: { kind: "repair", ref: `${receipt!.cause.ref}.2` },
            causal_key: `r1:repair:${receipt!.cause.ref}.2:0`,
            state,
            note,
          }).pipe(Effect.provide(recordsAt(dir)));
          herdr.stale = true;
          managed.state.reachable = false;
          managed.children[0]!.kill();
          yield* Effect.promise(() => managed.children[0]!.exited);
        });
        if (replay) {
          yield* session(Effect.forkChild(started("r1")).pipe(Effect.andThen(lose)), over);
        }
        yield* session(
          Effect.gen(function* () {
            yield* Effect.forkChild(started("r1"));
            if (!replay) {
              yield* lose;
            }
            yield* until(parked("r1"));
            expect(everyLaunch(yield* rig.calls())).toHaveLength(1);
            expect(sent(yield* rig.calls(), "Your task for this step")).toBe(1);
            expect(yield* controlOf(PARKED, "r1")).toContain(
              "--reconcile repair-round-two --as sent|not-sent",
            );
            expect(
              Arr.filter(yield* deliveredTo(dir, "r1"), (one) => one.id === "repair-round-two"),
            ).toMatchObject([{ state, note }]);
          }),
          over,
        );
      }).pipe(Effect.scoped),
    ),
);

test.each(["reachable endpoint", "foreign terminal", "foreign Run"] as const)(
  "server death with a %s cannot retire or replace a worker",
  (foreign) =>
    runEffect(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const managed = yield* managedCodex;
        const herdr = new StaleWorkingTerminal(rig.pluginEnv());
        yield* rig.queueOutputs([null]);
        yield* session(
          Effect.gen(function* () {
            yield* Effect.forkChild(started("r1"));
            yield* until(acknowledgedStep(yield* Path.Path));
            herdr.stale = true;
            if (foreign === "foreign terminal") {
              yield* rig.dropAgent(agentFor("r1"));
              yield* rig.addAgent(agentFor("r1"));
            }
            if (foreign === "foreign Run") {
              const record = yield* readControl(hostOf().env.stateDir, agentFor("r1"));
              yield* fs.writeFileString(
                `${yield* controlDir(hostOf().env.stateDir, agentFor("r1"))}/control.json`,
                encodeJson({ ...record, runLog: "/another/run/agents.log" }),
              );
            }
            managed.children[0]!.kill();
            yield* Effect.promise(() => managed.children[0]!.exited);
            managed.state.reachable = foreign === "reachable endpoint";
            yield* spend(20_000);
            expect(everyLaunch(yield* rig.calls())).toHaveLength(1);
            expect(yield* rig.cmds()).not.toContain("terminal.kill");
            expect(yield* readControl(hostOf().env.stateDir, agentFor("r1"))).not.toBeNull();
          }),
          { herdr, harness: "codex", model: "default", ports: managed.ports },
        );
      }).pipe(Effect.scoped),
    ),
);

test.each(["before detection", "repair collection"] as const)(
  "managed server recovery respects Output during %s",
  (when) =>
    runEffect(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const managed = yield* managedCodex;
        const herdr = new (class extends StaleWorkingTerminal {
          override agentPrompt(...args: Parameters<Herdr["agentPrompt"]>) {
            return super.agentPrompt(...args).pipe(Effect.as("observed" as const));
          }
        })(rig.pluginEnv());
        yield* rig.queueOutputs(
          when === "repair collection" ? [{ verdict: "wrong" }, null] : [null],
        );
        const result = yield* session(
          Effect.gen(function* () {
            const fiber = yield* Effect.forkChild(started("r1"));
            yield* until(acknowledgedStep(yield* Path.Path));
            herdr.stale = true;
            if (when === "repair collection") {
              yield* until(
                deliveredTo(dir, "r1").pipe(
                  Effect.orDie,
                  Effect.map((found) =>
                    Arr.some(
                      found,
                      (one) => one.cause.kind === "repair" && one.state === "acknowledged",
                    ),
                  ),
                ),
              );
              expect(prompts(yield* rig.calls())).toEqual(
                expect.arrayContaining([expect.stringContaining("not usable")]),
              );
            }
            herdr.stale = true;
            managed.state.reachable = false;
            managed.children[0]!.kill();
            yield* Effect.promise(() => managed.children[0]!.exited);
            if (when === "before detection") {
              yield* fs.writeFileString(
                outputPath("r1"),
                '{"verdict":"clean","note":"finished before retirement"}',
              );
            }
            if (when === "repair collection") {
              yield* until(prompted("Your task for this step", 2));
            } else {
              yield* spend(20_000);
            }
            expect(everyLaunch(yield* rig.calls()), yield* controlOf(PARKED, "r1")).toHaveLength(
              when === "before detection" ? 1 : 2,
            );
            if (when === "repair collection") {
              expect(yield* read(outputPath("r1"))).toContain("wrong");
              yield* fs.writeFileString(
                outputPath("r1"),
                '{"verdict":"clean","note":"finished after repair recovery"}',
              );
            }
            return yield* Fiber.join(fiber);
          }),
          { herdr, harness: "codex", model: "default", ports: managed.ports, collectMs: 60_000 },
        );
        expect(result._tag === "Success" && result.success.note).toContain("finished");
        expect(sent(yield* rig.calls(), "Your task for this step")).toBe(
          when === "before detection" ? 1 : 2,
        );
      }).pipe(Effect.scoped),
    ),
);

test.each(["before retirement", "during retirement"] as const)(
  "a partial repaired Output does not prevent server recovery %s",
  (when) =>
    runEffect(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const managed = yield* managedCodex;
        const partial = '{"verdict":"clean","note":';
        const herdr = new (class extends StaleWorkingTerminal {
          override agentStatus() {
            return Effect.succeed("working" as const);
          }
          override agentPrompt(...args: Parameters<Herdr["agentPrompt"]>) {
            return super.agentPrompt(...args).pipe(Effect.as("observed" as const));
          }
        })(rig.pluginEnv());
        const ports: CompactionPorts = {
          codex: {
            ...managed.ports.codex!,
            stop: (target, note, budget) =>
              (when === "during retirement"
                ? fs.writeFileString(outputPath("r1"), partial).pipe(Effect.orDie)
                : Effect.void
              ).pipe(Effect.andThen(COMPACTION_PORTS.codex!.stop!(target, note, budget))),
          },
        };
        yield* rig.queueOutputs([{ verdict: "wrong" }, null]);
        const result = yield* session(
          Effect.gen(function* () {
            const fiber = yield* Effect.forkChild(started("r1"));
            yield* until(
              deliveredTo(dir, "r1").pipe(
                Effect.orDie,
                Effect.map((found) =>
                  Arr.some(
                    found,
                    (one) => one.cause.kind === "repair" && one.state === "acknowledged",
                  ),
                ),
              ),
            );
            herdr.stale = true;
            if (when === "before retirement") {
              yield* fs.writeFileString(outputPath("r1"), partial);
            }
            managed.state.reachable = false;
            managed.children[0]!.kill();
            yield* Effect.promise(() => managed.children[0]!.exited);
            yield* until(
              rig.calls().pipe(
                Effect.orDie,
                Effect.map((calls) => sent(calls, "Your task for this step") === 2),
              ),
            );
            expect(everyLaunch(yield* rig.calls())).toHaveLength(2);
            yield* fs.writeFileString(
              outputPath("r1"),
              '{"verdict":"clean","note":"partial repair recovered"}',
            );
            return yield* Fiber.join(fiber);
          }),
          { herdr, harness: "codex", model: "default", ports, collectMs: 60_000 },
        );
        expect(result._tag === "Success" && result.success.note).toBe("partial repair recovered");
      }).pipe(Effect.scoped),
    ),
);

test.each(["retirement", "launch"] as const)(
  "a stop racing managed server recovery at %s leaves no replacement running",
  (race) =>
    runEffect(
      Effect.gen(function* () {
        const managed = yield* managedCodex;
        const arrived = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        let recovering = false;
        class HeldRecovery extends StaleWorkingTerminal {
          override agentLaunch(...args: Parameters<Herdr["agentLaunch"]>) {
            return recovering && race === "launch"
              ? Deferred.succeed(arrived, undefined).pipe(
                  Effect.andThen(Deferred.await(release)),
                  Effect.andThen(super.agentLaunch(...args)),
                )
              : super.agentLaunch(...args);
          }
        }
        const herdr = new HeldRecovery(rig.pluginEnv());
        const stop: NonNullable<NonNullable<CompactionPorts["codex"]>["stop"]> = (
          target,
          note,
          budget,
        ) =>
          Effect.gen(function* () {
            const child = Option.getOrUndefined(
              Arr.findFirst(managed.children, (child) => child.pid === target.pid),
            );
            if (child?.exitCode === null) {
              child.kill();
              yield* Effect.promise(() => child.exited);
            }
            return yield* COMPACTION_PORTS.codex!.stop!(target, note, budget);
          });
        const ports: CompactionPorts = {
          codex: {
            ...managed.ports.codex!,
            stop: (target, note, budget) =>
              recovering && race === "retirement"
                ? Deferred.succeed(arrived, undefined).pipe(
                    Effect.andThen(Deferred.await(release)),
                    Effect.andThen(stop(target, note, budget)),
                  )
                : stop(target, note, budget),
          },
        };
        yield* rig.queueOutputs([null]);
        yield* session(
          Effect.gen(function* () {
            yield* work.execute({ runId: "r1", input: { skip: false } }, { discard: true });
            yield* until(acknowledgedStep(yield* Path.Path));
            recovering = true;
            herdr.stale = true;
            managed.state.reachable = false;
            managed.children[0]!.kill();
            yield* Effect.promise(() => managed.children[0]!.exited);
            yield* Deferred.await(arrived);
            yield* control(STOP, "r1", true);
            yield* Deferred.succeed(release, undefined);
            yield* until(suspended("r1"));
            expect(yield* herdr.agentList()).toEqual([]);
            expect(
              Arr.every(
                managed.children,
                (child) => child.exitCode !== null || child.signalCode !== null,
              ),
            ).toBe(true);
            expect(everyLaunch(yield* rig.calls()).length).toBeLessThanOrEqual(2);
          }),
          { herdr, harness: "codex", model: "default", ports },
        );
      }).pipe(Effect.scoped),
    ),
);

test("a resume sent while the Run is collected past its budget starts no second delivery or collection", () =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      core.reportedOnly([agentFor("r1")]);
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
          yield* spend(5000);
          yield* fs.writeFileString(outputPath("r1"), `{"verdict":"clean","note":"late"}`);
          return yield* Fiber.join(fiber);
        }),
        { herdr: new UnseenTurn(rig.pluginEnv()), collectMs: 400 },
      );
      expect(result._tag === "Success" && result.success.note).toBe("late");
      expect(sent(yield* rig.calls(), "Your task for this step")).toBe(1);
      expect(Arr.filter(yield* rig.cmds(), (cmd) => cmd === "terminal.run")).toHaveLength(1);
    }),
  ));

test("an agent collected past its budget is still told when its background verify ends", () =>
  runEffect(
    Effect.gen(function* () {
      core.reportedOnly([agentFor("r1")]);
      yield* rig.queueOutputs([null]);
      yield* session(
        Effect.gen(function* () {
          yield* work.execute({ runId: "r1", input: { skip: false } }, { discard: true });
          yield* pastTheBudget;
          expect(yield* (yield* Collecting).has("r1", agentFor("r1"))).toBe(true);
        }),
        { herdr: new UnseenTurn(rig.pluginEnv()), collectMs: 400 },
      );
    }),
  ));

test("an agent collected past its budget stays collected while Collie looks for it to start again", () =>
  runEffect(
    Effect.gen(function* () {
      const starting = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      let blocking = false;
      class SlowStart extends UnseenTurn {
        override agentLaunch(...args: Parameters<Herdr["agentLaunch"]>) {
          return blocking
            ? Deferred.succeed(starting, undefined).pipe(
                Effect.andThen(Deferred.await(release)),
                Effect.andThen(super.agentLaunch(...args)),
              )
            : super.agentLaunch(...args);
        }
      }
      const fs = yield* FileSystem.FileSystem;
      core.reportedOnly([agentFor("r1")]);
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
                  found.length > 0 && Arr.every(found, (one) => one.state === "acknowledged"),
              ),
            ),
          );
          blocking = true;
          const pane = Option.getOrUndefined(
            Arr.findFirst(yield* herdr.agentList(), (one) => one.name === agentFor("r1")),
          )?.paneId;
          yield* herdr.terminalKill(pane ?? "");
          const recovering = yield* Effect.forkChild((yield* Agents).resumeLost("r1", runningNow));
          yield* Deferred.await(starting);
          const marked = yield* (yield* Collecting).has("r1", agentFor("r1"));
          blocking = false;
          yield* Deferred.succeed(release, undefined);
          yield* fs.writeFileString(outputPath("r1"), `{"verdict":"clean","note":"revived"}`);
          yield* Fiber.join(recovering);
          yield* Fiber.join(fiber);
          return marked;
        }),
        { herdr, collectMs: 400 },
      );
      expect(marked).toBe(true);
    }),
  ));

test("an agent is still collected while its Run is parked past its budget", () =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      core.reportedOnly([agentFor("r1")]);
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
                if (
                  Option.getOrUndefined(
                    Option.map(Option.fromNullishOr(why), (present_) =>
                      pipe(present_, Str.includes("has written nothing")),
                    ),
                  ) &&
                  marked === undefined
                ) {
                  marked = yield* collecting.has(runId, agentFor(runId));
                }
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
        Effect.provide(
          body.pipe(
            Layer.provideMerge(markedWhenParked),
            Layer.provideMerge(
              agentsLayer({
                ...hostOf(),
                herdr: new UnseenTurn(rig.pluginEnv()),
                collectMs: 400,
              }),
            ),
            Layer.provideMerge(
              foundationLayer({
                dir,
              }),
            ),
          ),
        ),
        Effect.scoped,
        Effect.orDie,
      );
      expect(marked).toBe(true);
    }),
  ));

test("a stop while the Run is collected past its budget ends the wait", () =>
  runEffect(
    Effect.gen(function* () {
      core.reportedOnly([agentFor("r1")]);
      yield* rig.queueOutputs([null]);
      yield* session(
        Effect.gen(function* () {
          yield* work.execute({ runId: "r1", input: { skip: false } }, { discard: true });
          yield* pastTheBudget;
          yield* control(STOP, "r1", true);
          yield* until(suspended("r1"));
          expect(yield* (yield* Collecting).has("r1", agentFor("r1"))).toBe(false);
        }),
        { herdr: new UnseenTurn(rig.pluginEnv()), collectMs: 400 },
      );
    }),
  ));

test("a restart while the Run is collected past its budget reattaches and returns the late Output", () =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      yield* rig.queueOutputs([null]);
      yield* interrupted("r1", parked("r1"), { collectMs: 400 });
      expect(yield* suspended("r1").pipe(session)).toBe(false);

      yield* fs.writeFileString(outputPath("r1"), `{"verdict":"clean","note":"late"}`);
      const result = yield* session(started("r1"), { collectMs: 400 });
      expect(result._tag === "Success" && result.success.note).toBe("late");
      expect(yield* isSet(PARKED, "r1")).toBe(false);
      expect(Arr.filter(yield* rig.cmds(), (cmd) => cmd === "terminal.run")).toHaveLength(1);
    }),
  ));

const untilParked = (runId: string) =>
  Effect.gen(function* () {
    while (!(yield* parked(runId))) {
      yield* TestClock.withLive(Effect.sleep("10 millis"));
    }
    return "parked" as const;
  });

class BusyUntilWritten extends Herdr {
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

for (const busy of ["working", "blocked"] as const) {
  test(`an agent herdr reports ${busy} far past the budget is collected, never parked`, () =>
    runEffect(
      Effect.gen(function* () {
        yield* rig.queueOutputs([null]);
        const herdr = new BusyUntilWritten(busy);
        const writes = Effect.gen(function* () {
          while (herdr.reads < 100) {
            yield* TestClock.withLive(Effect.sleep("10 millis"));
          }
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
    ));
}

class RewritingAfterRepair extends Herdr {
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
        while (!(yield* prompted("not usable"))) {
          yield* TestClock.withLive(Effect.sleep("10 millis"));
        }
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

class FinishingWhileAsked extends Herdr {
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
      if (now === HALF) {
        yield* fs.writeFileString(outputPath("r1"), `{"verdict":"clean","note":"as it ended"}`);
      }
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
        while (!(yield* prompted("not usable"))) {
          yield* TestClock.withLive(Effect.sleep("10 millis"));
        }
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
  ["unknown", () => new UnseenTurn(rig.pluginEnv())],
  ["unreadable", () => new Unreadable(rig.pluginEnv())],
] as const) {
  test(`an agent whose status is ${what} and that writes nothing parks as idle-budget once the budget is spent idle`, () =>
    runEffect(
      Effect.gen(function* () {
        core.reportedOnly([agentFor("r1")]);
        yield* rig.queueOutputs([null]);
        yield* interrupted("r1", parked("r1"), {
          herdr: herdr(),
          pollMs: 1000,
          collectMs: 120_000,
        });
        expect(yield* controlOf(PARKED, "r1")).toContain(
          `has written nothing to ${outputPath("r1")} after 2 minutes idle. Collie keeps collecting it;`,
        );
        expect(yield* controlOf(PARK_CAUSE, "r1")).toBe("idle-budget");
        expect(Arr.map(yield* halts("r1"), (line) => line.cause)).toEqual(["idle-budget"]);
      }),
    ));
}

class Turns extends Herdr {
  private working = 0;
  private prompted = 0;
  constructor(
    private readonly ending: "idle" | "blocked" = "idle",
    private readonly ends = Infinity,
  ) {
    super(rig.pluginEnv());
  }
  override agentPrompt(target: string, text: string) {
    this.prompted += 1;
    this.working = this.prompted > this.ends ? Infinity : 10;
    return super.agentPrompt(target, text);
  }
  going = false;
  override agentStatus(target: string) {
    return super.agentStatus(target).pipe(
      Effect.map((status) => {
        if (status === "working") {
          return status;
        }
        if (this.working === 0) {
          return this.prompted > 0 ? this.ending : ("idle" as const);
        }
        if (!this.going) {
          this.working -= 1;
        }
        return "working" as const;
      }),
    );
  }
}

const REMINDER = "Your turn ended without writing your Output";

const reminders = Effect.map(
  Effect.suspend(() => rig.calls()),
  (calls) => Arr.filter(prompts(calls), (one) => pipe(one, Str.includes(REMINDER))),
);

const halts = (runId: string) =>
  Effect.map(readMetrics(evidenceDir(dir, runId)).pipe(Effect.provide(recordsAt(dir))), (lines) =>
    Arr.filter(lines, (line) => line.kind === "halt"),
  );

test("a reminder counts as recovered once the Output decodes, including after its existing repair", () =>
  runEffect(
    Effect.gen(function* () {
      yield* rig.queueOutputs([null, { verdict: "maybe" }, { verdict: "clean", note: "repaired" }]);
      const result = yield* session(started("r1"), { herdr: new Turns(), collectMs: 60_000 });
      expect(result._tag === "Success" && result.success.note).toBe("repaired");
      expect(yield* reminders).toHaveLength(1);
      expect(sent(yield* rig.calls(), "not usable")).toBe(1);
      const recovery = Arr.filter(
        yield* readMetrics(evidenceDir(dir, "r1")).pipe(Effect.provide(recordsAt(dir))),
        (line) => line.kind === "recovery",
      );
      expect(recovery.at(-1)).toMatchObject({
        cause: "output-absent",
        action: "reminded",
        outcome: "output-written",
        build: expect.any(String),
        value: expect.any(Number),
      });
      expect(
        measuresOf([{ runId: "r1", records: null, metrics: recovery }]).recoveries.byCause,
      ).toMatchObject([{ count: 1, recovered: 1 }]);
    }),
  ));

test("an agent whose turn ends without its Output is reminded at once, and the Output of its next turn is collected", () =>
  runEffect(
    Effect.gen(function* () {
      yield* rig.queueOutputs([null, { verdict: "clean", note: "after the reminder" }]);
      const result = yield* session(Effect.raceFirst(started("r1"), untilParked("r1")), {
        herdr: new Turns(),
        collectMs: 60_000,
      });
      expect(result !== "parked" && result._tag === "Success" && result.success.note).toBe(
        "after the reminder",
      );
      const sent = yield* reminders;
      expect(sent).toHaveLength(1);
      expect(sent[0]).toContain(`OUTPUT_PATH: ${outputPath("r1")}`);
      expect(sent[0]).toContain("A chat message is not the Output");
      expect(yield* halts("r1")).toEqual([]);
    }),
  ));

test("an agent that writes no Output after two reminders parks its step as output-absent, and is not reminded again", () =>
  runEffect(
    Effect.gen(function* () {
      yield* rig.queueOutputs([null, null, null, null]);
      const result = yield* session(
        Effect.raceFirst(
          started("r1"),
          untilParked("r1").pipe(Effect.andThen(spend(5000)), Effect.as("parked" as const)),
        ),
        { herdr: new Turns(), collectMs: 600_000 },
      );
      expect(result).toBe("parked");
      expect(yield* reminders).toHaveLength(2);
      expect(yield* controlOf(PARK_CAUSE, "r1")).toBe("output-absent");
      expect(yield* controlOf(PARKED, "r1")).toMatch(
        /and again after each of 2 reminders, sent \d{4}-\d\d-\d\dT\S+ and \d{4}-\d\d-\d\dT\S+\./,
      );
      expect(yield* read(outputPath("r1"))).toBe("");
      const reminded = Arr.filter(
        yield* readMetrics(evidenceDir(dir, "r1")).pipe(Effect.provide(recordsAt(dir))),
        (line) => line.kind === "recovery" && line.action === "reminded",
      );
      expect(Arr.map(reminded, (line) => line.outcome)).toEqual(["still-absent", "still-absent"]);
    }),
  ));

test("a host stopped once its first reminder went out does not send that reminder again when it starts", () =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      yield* rig.queueOutputs([null, null]);
      const remindedOnce: Reached = Effect.gen(function* () {
        if ((yield* reminders).length === 0) {
          return false;
        }
        yield* TestClock.withLive(Effect.sleep("300 millis"));
        return true;
      }).pipe(Effect.orElseSucceed(() => false));
      yield* interrupted("r1", remindedOnce, { herdr: new Turns("idle", 1), collectMs: 600_000 });

      const result = yield* session(
        Effect.gen(function* () {
          const fiber = yield* Effect.forkChild(started("r1"));
          yield* TestClock.withLive(Effect.sleep("500 millis"));
          yield* fs.writeFileString(outputPath("r1"), `{"verdict":"clean","note":"late"}`);
          return yield* Fiber.join(fiber);
        }),
        { herdr: new Turns(), collectMs: 600_000 },
      );
      expect(result._tag === "Success" && result.success.note).toBe("late");
      expect(yield* reminders).toHaveLength(1);
    }),
  ));

class HeldReminder extends Turns {
  private held = false;
  override agentPrompt(target: string, text: string) {
    if (!this.held && pipe(text, Str.includes(REMINDER))) {
      this.held = true;
      return Effect.never;
    }
    return super.agentPrompt(target, text);
  }
}

const heldReminder = (runId: string) =>
  Effect.map(deliveredTo(dir, runId), (deliveries) =>
    Arr.findFirst(deliveries, (one) => pipe(one.cause.ref, Str.endsWith(".remind-1"))),
  );

const enteredBehindHeldReminder = (landed: "itself" | "otherwise" | "no-one") =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    yield* rig.queueOutputs([null, null, null]);
    yield* interrupted(
      "r1",
      Effect.map(heldReminder("r1"), Option.isSome).pipe(Effect.orElseSucceed(() => false)),
      { herdr: new HeldReminder(), collectMs: 600_000 },
    );
    const held = Option.getOrThrow(yield* heldReminder("r1"));
    if (landed !== "no-one") {
      yield* writeEvent(yield* controlDir(rig.pluginEnv().stateDir, agentFor("r1")), {
        session: null,
        kind: "submit",
        reason: "collie",
        delivery: held.id,
        incarnation: landed === "itself" ? held.incarnation : `${held.incarnation}-before`,
      });
    }
    const result = yield* session(
      Effect.raceFirst(
        Effect.gen(function* () {
          const fiber = yield* Effect.forkChild(started("r1"));
          yield* TestClock.withLive(Effect.sleep("500 millis"));
          yield* fs.writeFileString(outputPath("r1"), `{"verdict":"clean","note":"late"}`);
          return yield* Fiber.join(fiber);
        }),
        untilParked("r1"),
      ),
      { herdr: new Turns(), collectMs: 600_000 },
    );
    const now = Option.getOrUndefined(
      Arr.findLast(
        yield* ledgerOf(dir, held.incarnation),
        (line) => "id" in line && line.id === held.id,
      ),
    );
    return { result, now };
  });

test("a reminder held behind an earlier copy that landed settles it and is not parked", () =>
  runEffect(
    Effect.gen(function* () {
      const { result, now } = yield* enteredBehindHeldReminder("itself");
      expect(result !== "parked" && result._tag === "Success" && result.success.note).toBe("late");
      expect(now).toMatchObject({ state: "acknowledged" });
      expect(yield* halts("r1")).toEqual([]);
    }),
  ));

test("a reminder held behind a copy that only an earlier incarnation recorded parks as delivery-unsettled", () =>
  runEffect(
    Effect.gen(function* () {
      const { result, now } = yield* enteredBehindHeldReminder("otherwise");
      expect(result).toBe("parked");
      expect(now).not.toMatchObject({ state: "acknowledged" });
      expect(yield* controlOf(PARK_CAUSE, "r1")).toBe("delivery-unsettled");
    }),
  ));

test("a reminder held behind an earlier copy that never landed parks as delivery-unsettled and claims no Heal", () =>
  runEffect(
    Effect.gen(function* () {
      const { result, now } = yield* enteredBehindHeldReminder("no-one");
      expect(result).toBe("parked");
      expect(now).not.toMatchObject({ state: "acknowledged" });
      expect(yield* controlOf(PARK_CAUSE, "r1")).toBe("delivery-unsettled");
      const recoveries = Arr.filter(
        yield* readMetrics(evidenceDir(dir, "r1")).pipe(Effect.provide(recordsAt(dir))),
        (line) => line.kind === "recovery" && line.action === "healed",
      );
      expect(recoveries).toEqual([]);
    }),
  ));

test("an agent herdr reports blocked when its turn stops is not reminded", () =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      yield* rig.queueOutputs([null, null]);
      const result = yield* session(
        Effect.gen(function* () {
          const fiber = yield* Effect.forkChild(started("r1"));
          yield* until(prompted("Your task for this step"));
          yield* spend(30_000);
          yield* fs.writeFileString(outputPath("r1"), `{"verdict":"clean","note":"answered"}`);
          return yield* Fiber.join(fiber);
        }),
        { herdr: new Turns("blocked"), collectMs: 600_000 },
      );
      expect(result._tag === "Success" && result.success.note).toBe("answered");
      expect(yield* reminders).toEqual([]);
    }),
  ));

test("an agent whose turn ends while its Run is held is reminded only once the Hold is lifted", () =>
  runEffect(
    Effect.gen(function* () {
      yield* rig.queueOutputs([null, { verdict: "clean", note: "after the hold" }]);
      const herdr = new Turns();
      herdr.going = true;
      const result = yield* session(
        Effect.gen(function* () {
          const fiber = yield* Effect.forkChild(started("r1"));
          yield* until(prompted("Your task for this step"));
          yield* control(HOLD, "r1", true);
          herdr.going = false;
          yield* spend(30_000);
          expect(yield* reminders).toEqual([]);
          yield* control(HOLD, "r1", false);
          return yield* Fiber.join(fiber);
        }),
        { herdr, collectMs: 600_000 },
      );
      expect(result._tag === "Success" && result.success.note).toBe("after the hold");
      expect(yield* reminders).toHaveLength(1);
    }),
  ));

const askedTwo = flow(
  Schema.encodeResult(Schema.fromJsonString(Schema.Unknown)),
  Result.getOrThrow,
)({
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
          { label: "Postgres (Recommended)", description: "the one ops runs" },
          { label: "SQLite", description: "a file beside the app" },
          { label: "JSONL", description: "no migration" },
        ],
        multiSelect: false,
      },
      {
        question: "Which checks?",
        header: "Checks",
        options: [
          { label: "lint (Recommended)", description: "oxlint" },
          { label: "typecheck", description: "tsgo" },
          { label: "none", description: "CI runs them" },
        ],
        multiSelect: false,
      },
    ],
  },
});

const ANSWERED = "Your questions are answered:";

const asksTwo = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  while (
    !Arr.some(
      yield* deliveredTo(dir, "r1"),
      (one) => one.cause.kind === "step" && one.state === "acknowledged",
    )
  ) {
    yield* TestClock.withLive(Effect.sleep("10 millis"));
  }
  yield* fs.writeFileString(
    hostLockOf(rig.pluginEnv().stateDir),
    `{"pid":${process.pid},"start":null}`,
  );
  yield* recordClaudeEvent(
    yield* controlDir(rig.pluginEnv().stateDir, agentFor("r1")),
    askedTwo,
    null,
  );
}).pipe(Effect.orDie);

const questionsOf = (count: number) =>
  Effect.gen(function* () {
    const store = yield* Store;
    for (;;) {
      const asked = yield* store.asked("r1");
      if (asked.length >= count) {
        return asked;
      }
      yield* TestClock.withLive(Effect.sleep("10 millis"));
    }
  });

const answer = (decision: string, value: string, answerer?: AuditLine["actor"]) =>
  Store.pipe(
    Effect.flatMap((store) =>
      store.settle({ run: "r1", decision, value, request: `answer-${decision}`, answerer }),
    ),
  );

const spend = (ms: number) =>
  Effect.gen(function* () {
    const until = (yield* Clock.currentTimeMillis) + ms;
    while ((yield* Clock.currentTimeMillis) < until) {
      yield* TestClock.withLive(Effect.sleep("10 millis"));
    }
  });

test("an agent's two questions are open Decisions on its Run, and both answers go back as one Delivery", () =>
  runEffect(
    Effect.gen(function* () {
      yield* rig.queueOutputs([null]);
      yield* session(
        Effect.gen(function* () {
          yield* work.execute({ runId: "r1", input: { skip: false } }, { discard: true });
          yield* asksTwo;
          const asked = yield* questionsOf(2);
          expect(Arr.map(asked, (one) => [one.decision, one.answer])).toEqual([
            ["ask-review-1", null],
            ["ask-review-2", null],
          ]);
          expect(asked[0]?.prompt).toBe("Database: Which database?");
          expect(asked[1]?.prompt).toBe("Checks: Which checks?");

          yield* answer("ask-review-1", "2");
          yield* spend(5000);
          expect(sent(yield* rig.calls(), ANSWERED)).toBe(0);

          yield* answer("ask-review-2", "1");
          while (!(yield* prompted(ANSWERED))) {
            yield* TestClock.withLive(Effect.sleep("10 millis"));
          }
          yield* spend(5000);
          const calls = yield* rig.calls();
          expect(sent(calls, ANSWERED)).toBe(1);
          const delivered = Option.getOrUndefined(
            Arr.findFirst(sentTexts(calls), Str.includes(ANSWERED)),
          );
          expect(delivered).toEndWith(
            "\nYour questions are answered: Database: SQLite; Checks: lint",
          );
          const [receipt] = Arr.filter(
            yield* deliveredTo(dir, "r1"),
            (one) => one.cause.kind === "steer",
          );
          expect(receipt?.state).toBe("acknowledged");
        }),
        {
          herdr: new UnseenTurn(rig.pluginEnv()),
          collectMs: 120_000,
          pollMs: 1000,
        },
      );
    }),
  ));

class LostAnswers extends Turns {
  lost = false;
  answers = 0;
  override agentPrompt(...args: Parameters<Herdr["agentPrompt"]>) {
    if (!pipe(args[1], Str.includes(ANSWERED))) {
      return super.agentPrompt(...args);
    }
    this.answers += 1;
    if (!this.lost) {
      return super.agentPrompt(...args);
    }
    this.lost = false;
    return Effect.fail(new HerdrError({ message: "socket closed", detail: "" }));
  }
}

const answerDelivery = Effect.gen(function* () {
  return Arr.findFirst(yield* deliveredTo(dir, "r1"), (one) => one.cause.kind === "steer");
});

test("an answer whose send result was lost parks as delivery-unsettled naming it, and the human is not asked again", () =>
  runEffect(
    Effect.gen(function* () {
      yield* rig.queueOutputs([null]);
      const herdr = new LostAnswers();
      const askedNow: Array<Array<string | null>> = [];
      yield* session(
        Effect.gen(function* () {
          yield* work.execute({ runId: "r1", input: { skip: false } }, { discard: true });
          yield* asksTwo;
          yield* questionsOf(2);
          herdr.lost = true;
          yield* answer("ask-review-1", "SQLite");
          yield* answer("ask-review-2", "lint");
          yield* untilParked("r1");
          const asked = yield* (yield* Store).asked("r1");
          askedNow.push(...Arr.map(asked, (one) => [one.decision, one.answer]));
        }),
        { herdr, collectMs: 600_000, pollMs: 100 },
      );
      const lost = Option.getOrThrow(yield* answerDelivery);
      expect(lost.state).toBe("unknown");
      expect(yield* controlOf(PARK_CAUSE, "r1")).toBe("delivery-unsettled");
      expect(yield* controlOf(PARKED, "r1")).toContain(lost.id);
      expect(askedNow).toEqual([
        ["ask-review-1", "SQLite"],
        ["ask-review-2", "lint"],
      ]);
      expect(herdr.answers).toBe(1);
    }),
  ));

test("an answer whose submit hook recorded it settles and reaches the agent, so the Run is not parked on it", () =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      yield* rig.queueOutputs([null]);
      const herdr = new LostAnswers();
      const recorded: Array<Array<string | null>> = [];
      const result = yield* session(
        Effect.gen(function* () {
          const fiber = yield* Effect.forkChild(started("r1"));
          yield* asksTwo;
          yield* questionsOf(2);
          herdr.lost = true;
          yield* answer("ask-review-1", "SQLite");
          yield* answer("ask-review-2", "lint");
          const lost = yield* until(Effect.map(answerDelivery, Option.isSome)).pipe(
            Effect.andThen(answerDelivery),
          );
          yield* writeEvent(yield* controlDir(rig.pluginEnv().stateDir, agentFor("r1")), {
            session: null,
            kind: "submit",
            reason: "collie",
            delivery: Option.getOrThrow(lost).id,
            incarnation: Option.getOrThrow(lost).incarnation,
          });
          yield* fs.writeFileString(outputPath("r1"), `{"verdict":"clean","note":"answered"}`);
          const done = yield* Fiber.join(fiber);
          recorded.push(
            ...Arr.map(yield* (yield* Store).asked("r1"), (one) => [one.decision, one.answer]),
          );
          return done;
        }),
        { herdr, collectMs: 600_000, pollMs: 100 },
      );
      expect(result._tag === "Success" && result.success.note).toBe("answered");
      expect(yield* controlOf(PARK_CAUSE, "r1")).not.toBe("delivery-unsettled");
      expect(Option.getOrThrow(yield* answerDelivery).state).toBe("acknowledged");
      expect(herdr.answers).toBe(1);
      expect(recorded).toEqual([
        ["ask-review-1", "SQLite"],
        ["ask-review-2", "lint"],
      ]);
    }),
  ));

test("an answered question's pending delivery is not interrupted by an Output reminder", () =>
  runEffect(
    Effect.gen(function* () {
      yield* rig.queueOutputs([null]);
      const replying = yield* Deferred.make<void>();
      const sawIdle = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const cancelled = yield* Deferred.make<void>();
      let awaitingReply = false;
      const herdr = new (class extends UnseenTurn {
        override agentPrompt(...args: Parameters<Herdr["agentPrompt"]>) {
          const sent = super.agentPrompt(...args);
          if (!pipe(args[1], Str.includes(ANSWERED))) {
            return sent;
          }
          return Effect.gen(function* () {
            awaitingReply = true;
            yield* Deferred.succeed(replying, undefined);
            yield* Deferred.await(release);
            return yield* sent;
          }).pipe(
            Effect.onInterrupt(() => Effect.asVoid(Deferred.succeed(cancelled, undefined))),
            Effect.ensuring(Effect.sync(() => (awaitingReply = false))),
          );
        }
        override agentStatus(...args: Parameters<Herdr["agentStatus"]>) {
          return awaitingReply
            ? Deferred.succeed(sawIdle, undefined).pipe(Effect.as("idle" as const))
            : super.agentStatus(...args);
        }
      })(rig.pluginEnv());
      yield* session(
        Effect.gen(function* () {
          yield* work.execute({ runId: "r1", input: { skip: false } }, { discard: true });
          yield* asksTwo;
          yield* questionsOf(2);
          yield* answer("ask-review-1", "SQLite");
          yield* answer("ask-review-2", "lint");
          yield* Deferred.await(replying);
          yield* Deferred.await(sawIdle);
          yield* spend(5000);
          expect(yield* Deferred.isDone(cancelled)).toBe(false);
          yield* Deferred.succeed(release, undefined);
          yield* until(
            deliveredTo(dir, "r1").pipe(
              Effect.map((all) =>
                Arr.some(all, (one) => one.cause.kind === "steer" && one.state === "acknowledged"),
              ),
              Effect.orDie,
            ),
          );
          yield* spend(5000);
          expect(sent(yield* rig.calls(), ANSWERED)).toBe(1);
          expect(yield* reminders).toEqual([]);
        }),
        { herdr, collectMs: 120_000, pollMs: 1000 },
      );
    }),
  ));

test("answers from different senders each reach the agent under their own sender line", () =>
  runEffect(
    Effect.gen(function* () {
      yield* rig.queueOutputs([{ writes: [], output: null, owed: true }]);
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
          while (!(yield* prompted("is answered", 2))) {
            yield* TestClock.withLive(Effect.sleep("10 millis"));
          }
          const typed = Arr.filter(sentTexts(yield* rig.calls()), Str.includes("is answered"));
          expect(typed).toHaveLength(2);
          expect(
            Option.getOrUndefined(
              Arr.findFirst(typed, (one) => pipe(one, Str.includes("Database"))),
            ),
          ).toMatch(
            /From r-other-build-r1 of r-other [^\n]*\nYour question Database is answered: SQLite$/,
          );
          expect(
            Option.getOrUndefined(Arr.findFirst(typed, (one) => pipe(one, Str.includes("Checks")))),
          ).toMatch(
            /From the human, on the board, [^\n]*\nYour question Checks is answered: lint$/,
          );
          const [first] = Arr.filter(
            yield* deliveredTo(dir, "r1"),
            (one) => one.cause.kind === "steer",
          );
          expect(first?.state).toBe("acknowledged");
        }),
        {
          collectMs: 120_000,
          pollMs: 1000,
        },
      );
    }),
  ));

test("an open question pauses an idle agent's Output budget, which runs again once it is answered", () =>
  runEffect(
    Effect.gen(function* () {
      core.reportedOnly([agentFor("r1")]);
      yield* rig.queueOutputs([null]);
      yield* session(
        Effect.gen(function* () {
          yield* work.execute({ runId: "r1", input: { skip: false } }, { discard: true });
          yield* asksTwo;
          yield* questionsOf(2);
          yield* spend(75_000);
          expect(yield* parked("r1")).toBe(false);

          yield* answer("ask-review-1", "Postgres");
          yield* answer("ask-review-2", "lint");
          while (!(yield* parked("r1"))) {
            yield* TestClock.withLive(Effect.sleep("10 millis"));
          }
        }),
        {
          herdr: new UnseenTurn(rig.pluginEnv()),
          collectMs: 60_000,
          pollMs: 1000,
        },
      );
      expect(yield* controlOf(PARKED, "r1")).toContain("after 1 minutes idle");
    }),
  ));

test("a question still open when the Output comes is closed, and nothing is sent", () =>
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
          expect(Arr.map(asked, (one) => [one.decision, one.answer])).toEqual([
            ["ask-review-1", "Postgres"],
            ["ask-review-2", "closed: review finished before it was answered"],
          ]);
          return done;
        }),
        { collectMs: 120_000, pollMs: 1000 },
      );
      expect(result._tag).toBe("Success");
      expect(sent(yield* rig.calls(), ANSWERED)).toBe(0);
    }),
  ));

const askedOfRows = (rows: ReadonlyArray<DecisionRow>) =>
  Arr.map(rows, (row) => ({ name: row.decision, answer: row.answer }));

const tendR1Reading = (reads: Array<string>) =>
  Effect.gen(function* () {
    const store = yield* Store;
    yield* (yield* Agents).tendQuestions(
      (run) => ({
        ask: (question, asker) =>
          store.asking({
            run,
            decision: question.name,
            prompt: question.prompt,
            options: question.options,
            asker,
          }),
        asked: Effect.suspend(() => {
          reads.push(`asked ${run}`);
          return Effect.map(store.asked(run), askedOfRows);
        }),
        close: (decision, value) =>
          store.settle({ run, decision, value, request: `closed-${decision}` }).pipe(Effect.asVoid),
      }),
      (runs) =>
        Effect.suspend(() => {
          reads.push(`askedOf ${Arr.join(runs, ",")}`);
          return Effect.map(
            store.askedOf(runs),
            (byRun) => new Map(Arr.map([...byRun], ([run, rows]) => [run, askedOfRows(rows)])),
          );
        }),
    );
  });
const tendR1 = tendR1Reading([]);

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
    Store.pipe(
      Effect.flatMap((store) => store.asked("r1")),
      Effect.map((rows) => Arr.map(rows, (one) => one.answer)),
    ),
  ),
);

test("a question whose agent core still has, or whose core cannot be asked, stays open", () =>
  runEffect(
    Effect.gen(function* () {
      yield* finishedThenAsked;
      for (const herdr of [new Herdr(rig.pluginEnv()), coreGone()]) {
        yield* session(tendR1, { herdr });
      }
      expect(yield* answersOfR1).toEqual([null, null]);

      yield* rig.dropAgent(agentFor("r1"));
      yield* session(tendR1);
      expect(yield* answersOfR1).toEqual([
        `closed: ${agentFor("r1")} is gone`,
        `closed: ${agentFor("r1")} is gone`,
      ]);
    }),
  ));

test("a pass of question tending reads its Runs' questions once, and closes what it asked when the agent is gone", () =>
  runEffect(
    Effect.gen(function* () {
      yield* finishedThenAsked;
      const reads: Array<string> = [];
      yield* session(tendR1Reading(reads));
      yield* rig.dropAgent(agentFor("r1"));
      yield* session(tendR1Reading(reads));
      expect(reads).toEqual(["askedOf r1", "askedOf r1"]);
      expect(yield* answersOfR1).toEqual([
        `closed: ${agentFor("r1")} is gone`,
        `closed: ${agentFor("r1")} is gone`,
      ]);
    }),
  ));

test("a question asked before the agent's next launch is answered while that launch is collected", () =>
  runEffect(
    Effect.gen(function* () {
      yield* finishedThenAsked;
      const asked = yield* questionsSince(
        yield* controlDir(rig.pluginEnv().stateDir, agentFor("r1")),
        0,
      );
      const first = yield* launchedAt(dir, "r1", "review");
      const next = {
        ...first,
        operation: "fix",
        at: Math.max(...Arr.map(asked, (one) => one.at)) + 1,
      };
      yield* recordLaunch(next).pipe(Effect.provide(recordsAt(dir)));
      yield* session(
        Effect.gen(function* () {
          const collecting = yield* Collecting;
          yield* collecting.during("r1", agentFor("r1"), tendR1, "fix");
        }),
      );
      expect(yield* answersOfR1).toEqual([null, null]);
    }),
  ));

test("a restart between the attempts hands out no second repair", () =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      yield* rig.queueOutputs([{ verdict: "maybe" }, null]);
      yield* interrupted("r1", prompted("not usable"));
      expect(sent(yield* rig.calls(), "not usable")).toBe(1);

      yield* fs.writeFileString(outputPath("r1"), `{"verdict":"clean","note":"eventually"}`);
      const result = yield* session(started("r1"));

      expect(result._tag === "Success" && result.success.note).toBe("eventually");
      expect(sent(yield* rig.calls(), "not usable")).toBe(1);
      expect(Arr.filter(yield* rig.cmds(), (cmd) => cmd === "terminal.run")).toHaveLength(1);
    }),
  ));

class BusyPane extends Herdr {
  private refused = 0;
  constructor(private readonly times: number) {
    super(rig.pluginEnv());
  }
  override agentPrompt(target: string, text: string) {
    const busy = this.times === 0 || this.refused < this.times;
    if (busy) {
      this.refused += 1;
    }
    return core
      .report(target, busy ? "blocked" : "idle")
      .pipe(Effect.andThen(super.agentPrompt(target, text)));
  }
}
const busyPane = (times = 0) => new BusyPane(times);

class Refusing extends Herdr {
  private readonly left = new Map<string, number>();
  constructor(
    private readonly refusals: Readonly<Record<string, string>>,
    times = Infinity,
  ) {
    super(rig.pluginEnv());
    for (const method of Rec.keys(refusals)) {
      this.left.set(method, times);
    }
  }
  private refusing<A>(method: string, asked: Effect.Effect<A, HerdrError, PlatformServices>) {
    const left = this.left.get(method) ?? 0;
    if (left <= 0) {
      return asked;
    }
    this.left.set(method, left - 1);
    return Effect.fail(
      new HerdrError({
        message: `core ${method} failed`,
        detail: this.refusals[method] ?? "",
        answered: true,
      }),
    );
  }
  override agentLaunch(...args: Parameters<Herdr["agentLaunch"]>) {
    return this.refusing("terminal.run", super.agentLaunch(...args));
  }
  override agentList() {
    return this.refusing("terminal.list", super.agentList());
  }
  override agentPrompt(target: string, text: string) {
    return this.refusing("terminal.send", super.agentPrompt(target, text));
  }
  override terminalKill(address: string) {
    return this.refusing("terminal.kill", super.terminalKill(address));
  }
}

class Statuses extends Herdr {
  private reads = 0;
  constructor(
    private readonly statuses: ReadonlyArray<AgentStatus>,
    env = rig.pluginEnv(),
  ) {
    super(env);
  }
  private get now() {
    return this.statuses[Math.min(this.reads, this.statuses.length - 1)] ?? "idle";
  }
  override agentStatus(target: string) {
    return super.agentStatus(target).pipe(
      Effect.map(() => {
        const status = this.now;
        this.reads += 1;
        return status;
      }),
    );
  }
  override agentList() {
    return super
      .agentList()
      .pipe(Effect.map((agents) => Arr.map(agents, (one) => ({ ...one, status: this.now }))));
  }
}

const coreGone = () => new Herdr(rig.pluginEnv({ HC_SOCKET: `${rig.root}/gone.sock` }));

const statusNow = (runId: string) =>
  session(
    Effect.gen(function* () {
      const engine = yield* WorkflowEngine.WorkflowEngine;
      const id = yield* work.executionId({ runId, input: { skip: false } });
      return pollStatus(yield* engine.poll(work, id), "agent-work").status;
    }),
  );

const steps = (runId: string) =>
  deliveredTo(dir, runId).pipe(
    Effect.map((found) => Arr.filter(found, (one) => one.cause.kind === "step")),
    Effect.orDie,
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
      expect(sent(yield* rig.calls(), "Your task for this step")).toBe(3);
      expect(Arr.map(yield* steps("r1"), (one) => one.state)).toEqual(["acknowledged"]);
      expect(Arr.filter(yield* rig.cmds(), (cmd) => cmd === "terminal.run")).toHaveLength(1);
    }),
  ));

test("a pane that stays busy parks the step beside its agent, and a resume hands that agent its prompt", () =>
  runEffect(
    Effect.gen(function* () {
      yield* rig.queueOutputs([{ verdict: "clean", note: "resumed" }]);
      yield* interrupted("r1", suspended("r1"), {
        herdr: busyPane(),
        patience: { firstMs: 10, maxMs: 20, forMs: 100 },
      });

      expect(yield* statusNow("r1")).toBe("suspended");
      const why = yield* controlOf(PARKED, "r1");
      expect(why).toMatch(/agent_blocked held for \d+s over \d+ attempts/);
      expect(why).toContain(promptPath("r1"));
      expect(why).toContain("collie run resume r1");
      expect(Arr.map(yield* steps("r1"), (one) => one.state)).toEqual(["failed"]);

      yield* core.report(agentFor("r1"), "idle");
      const result = yield* releasedInto("r1");
      expect(result._tag === "Success" && result.success.note).toBe("resumed");
      expect(Arr.filter(yield* rig.cmds(), (cmd) => cmd === "terminal.run")).toHaveLength(1);
      expect(Arr.map(yield* steps("r1"), (one) => one.state)).toEqual(["acknowledged"]);
      expect(yield* isSet(PARKED, "r1")).toBe(false);
    }),
  ));

const launchArgs = (calls: ReadonlyArray<Call>) => (everyLaunch(calls)[0] ?? []).slice(1);

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

test("the shipped reviewer, with no persona in the user Layer, is its own sections and both its skills", () =>
  runEffect(
    Effect.gen(function* () {
      yield* installBaseline(rig);
      yield* rig.queueOutputs([{ verdict: "clean", note: "done" }]);
      yield* session(started("r1"));

      const text = yield* personaFileText;
      expect(text).toContain("Run both review skills over the change");
      expect(text).toContain("Finding nothing is a real answer");
      expect(mentionedSkills(text)).toEqual(["code-review", "code-review-and-quality"]);
    }),
  ));

test("a user-Layer reviewer that extends reviewer-single-pass is launched as the single pass", () =>
  runEffect(
    Effect.gen(function* () {
      yield* installBaseline(rig);
      yield* writePersona(rig.userDir, "reviewer", "---\nextends: reviewer-single-pass\n---\n");
      yield* rig.queueOutputs([{ verdict: "clean", note: "done" }]);
      yield* session(started("r1"));

      const text = yield* personaFileText;
      expect(text).toContain("in one pass");
      expect(text).not.toContain("Run both review skills over the change");
      expect(text).toContain("## If the skill is missing");
      expect(mentionedSkills(text)).toEqual(["code-review-and-quality"]);
    }),
  ));

test("a user-Layer implementer that extends implementer-handback is the implementer, then its Delegation section", () =>
  runEffect(
    Effect.gen(function* () {
      yield* installBaseline(rig);
      const env = rig.pluginEnv();
      const every = (yield* everyAgentText(env)) ?? "no every-agent persona";
      const shipped = yield* personaText(env, "implementer");
      const own = Str.slice(0, shipped.length - every.length)(shipped);
      expect(shipped).toEndWith(every);

      yield* writePersona(rig.userDir, "implementer", "---\nextends: implementer-handback\n---\n");
      const text = yield* personaText(env, "implementer");

      expect(text).toStartWith(own);
      expect(text).toEndWith(every);
      const added = Str.slice(own.length, text.length - every.length)(text);
      expect(added).toStartWith("## Delegation\n");
      expect(added).toContain("A child's word is not review.");
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

test("a persona naming what nothing fills parks the launch, and the fixed file is what resumes", () =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const personas = `${rig.pluginEnv().userDir}/personas`;
      yield* fs.makeDirectory(personas, { recursive: true });
      yield* fs.writeFileString(`${personas}/reviewer.md`, "Review {{inputs.target}}.\n");
      yield* rig.queueOutputs([{ verdict: "clean", note: "resumed" }]);
      yield* interrupted("r1", suspended("r1"));

      expect(yield* statusNow("r1")).toBe("suspended");
      expect(yield* controlOf(PARKED, "r1")).toContain(
        `the reviewer persona in ${personas}/reviewer.md names {{inputs.target}}`,
      );
      expect(Arr.filter(yield* rig.cmds(), (cmd) => cmd === "terminal.run")).toEqual([]);

      yield* fs.writeFileString(`${personas}/reviewer.md`, "You review.\n");
      const result = yield* releasedInto("r1");
      expect(result._tag === "Success" && result.success.note).toBe("resumed");
      expect(Arr.filter(yield* rig.cmds(), (cmd) => cmd === "terminal.run")).toHaveLength(1);
    }),
  ));

const claudeJson = () => `${rig.root}/.claude.json`;

const claudeKnows = (projects: Record<string, { readonly hasTrustDialogAccepted: boolean }>) =>
  FileSystem.FileSystem.pipe(
    Effect.flatMap((fs) =>
      fs.writeFileString(claudeJson(), stringifyJson({ numStartups: 3, projects })),
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
      const granted = Option.getOrElse(
        pipe(log, Str.indexOf(`trust claude: trusted ${rig.projectDir}`)),
        () => -1,
      );
      expect(granted).toBeGreaterThanOrEqual(0);
      expect(granted).toBeLessThan(
        Option.getOrElse(pipe(log, Str.indexOf(`${agentFor("r1")}: claude in`)), () => -1),
      );
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

const everyLaunch = (calls: ReadonlyArray<Call>) =>
  Arr.filterMap(calls, (call) => {
    const argv = call.params?.argv;
    return call.cmd === "terminal.run" && Arr.isArray(argv)
      ? Result.succeed(Arr.filter(argv, isString))
      : Result.failVoid;
  });

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
      const said = yield* scoped.execute({ runId: "r1", input: {} }).pipe(
        Effect.provide(
          scopedBody.pipe(
            Layer.provideMerge(agentsLayer(hostOf())),
            Layer.provideMerge(
              foundationLayer({
                dir,
              }),
            ),
          ),
        ),
        Effect.scoped,
        Effect.orDie,
      );
      expect(said).toBe("one+two");
      expect(Arr.map(everyLaunch(yield* rig.calls()), (args) => args.slice(1, 3))).toEqual([
        ["--model", "sonnet"],
        ["--model", "haiku"],
      ]);
    }),
  ));

test("the agent chosen for a piece of work is the one it comes back to, whatever is configured now", () =>
  runEffect(
    Effect.gen(function* () {
      yield* rig.queueOutputs([null]);
      yield* interrupted("r1", prompted("Your task for this step"));
      yield* session(halted("r1"), { collectMs: 30_000 });

      const result = yield* session(
        Effect.gen(function* () {
          const resumed = yield* Effect.forkChild(started("r1"));
          yield* until(rig.calls().pipe(Effect.map((calls) => everyLaunch(calls).length === 2)));
          yield* (yield* FileSystem.FileSystem).writeFileString(
            outputPath("r1"),
            `{"verdict":"clean","note":"back"}`,
          );
          return yield* Fiber.join(resumed);
        }),
        { model: "sonnet" },
      );
      expect(result._tag === "Success" && result.success.note).toBe("back");
      expect(Arr.map(everyLaunch(yield* rig.calls()), (args) => args.slice(1, 3))).toEqual([
        ["--model", "opus"],
        ["--model", "opus"],
      ]);
    }),
  ));

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
const launchOf = (runId: string) => launchedAt(dir, runId, "review");

const numericRun = "run-71558ed9.implement.implement-.";
const numericRole = "01-public-text-is-checked-and-marked-hidden.md.review-2-1";
const oldNumericName = "w01-public-text-is-chec-5hhdvh-r";
const numericAsk = () => ({
  runId: numericRun,
  operation: numericRole,
  agent: numericRole,
  role: "reviewer",
  workflow: "implement",
  harness: "claude",
  model: "opus",
  effort: null,
  permissions: "auto",
  task: null,
  cwd: rig.projectDir,
  prompt: "Review this work.",
  output: `${launchDir(dir, numericRun)}/${numericRole}.json`,
  skill: null,
  sequence: 2,
});

const openOldNumeric = (herdr: Herdr) =>
  Effect.gen(function* () {
    yield* herdr.agentLaunch({
      name: oldNumericName,
      argv: ["claude", "--model", "opus"],
      cwd: rig.projectDir,
      env: {},
      labels: { run: numericRun, operation: numericRole },
    });
    return Option.getOrThrow(
      Arr.findFirst(yield* herdr.agentList(), (one) => one.name === oldNumericName),
    );
  });

test("a recorded legacy numeric agent keeps its name through replay, aliases, reused work and revival", () =>
  runEffect(
    Effect.gen(function* () {
      yield* rig.queueOutputs([null, null, null, null]);
      const herdr = new Herdr(rig.pluginEnv());
      const old = yield* openOldNumeric(herdr);
      const terminalId = Option.getOrThrow(Option.fromNullishOr(old.terminalId));
      const ask = numericAsk();
      expect(agentName(ask.runId, ask.agent, null, ask.sequence)).not.toBe(oldNumericName);
      yield* session(
        Effect.gen(function* () {
          const agents = yield* Agents;
          yield* recordLaunch({
            ...Struct.pick(ask, [
              "runId",
              "operation",
              "role",
              "workflow",
              "harness",
              "model",
              "effort",
              "output",
              "sequence",
            ]),
            agent: oldNumericName,
            terminalId,
            reused: false,
          }).pipe(Effect.provide(recordsAt(dir)));
          const first = yield* agents.launch(ask);
          expect(first.agent).toBe(oldNumericName);
          expect(first.terminalId).toBe(terminalId);
          expect(first.reused).toBe(true);
          expect(yield* agents.choiceOf(numericRun, numericRole)).toMatchObject({
            harness: "claude",
            model: "opus",
            sequence: 2,
          });
          yield* agents.launch(ask);
          expect(sent(yield* rig.calls(), `${numericRole}.r2.prompt.md`)).toBe(1);
          const followup = {
            ...ask,
            operation: "fix-after-review",
            output: `${launchDir(dir, numericRun)}/fix-after-review.json`,
            prompt: "Apply the review.",
          };
          const reused = yield* agents.launch(followup);
          yield* agents.launch(followup);
          expect(reused.agent).toBe(oldNumericName);
          expect(reused.terminalId).toBe(terminalId);
          expect(reused.reused).toBe(true);
          expect(sent(yield* rig.calls(), "fix-after-review.r2.prompt.md")).toBe(1);
          const steer = {
            runId: numericRun,
            to: numericRole,
            text: "Keep the numeric reviewer.",
            request: "numeric-alias",
          };
          expect(yield* agents.steer(steer)).toMatchObject({
            agent: oldNumericName,
            delivered: true,
          });
          yield* agents.steer(steer);
          expect(sent(yield* rig.calls(), "Keep the numeric reviewer.")).toBe(1);
          expect(yield* agents.revive(followup)).toBe(false);
          expect(everyLaunch(yield* rig.calls())).toHaveLength(1);

          yield* herdr.terminalKill(old.paneId);
          expect(yield* agents.revive(followup)).toBe(true);
          expect(yield* agents.revive(followup)).toBe(false);
          expect(everyLaunch(yield* rig.calls())).toHaveLength(2);
          expect(Arr.map(yield* herdr.agentList(), (one) => one.name)).toEqual([oldNumericName]);
          expect(sent(yield* rig.calls(), "fix-after-review.r2.prompt.md")).toBe(2);
        }),
        { herdr },
      );
    }),
  ));

for (const identity of [
  "exact core marker",
  "no identity",
  "another generation",
  "another Run",
  "another alias",
]) {
  test(`a listed legacy numeric agent with ${identity} starts no duplicate`, () =>
    runEffect(
      Effect.gen(function* () {
        const marked = identity !== "no identity";
        const env = rig.pluginEnv();
        const herdr = new Herdr(env);
        yield* rig.queueOutputs([null]);
        const old = yield* openOldNumeric(herdr);
        const ask = numericAsk();
        if (marked) {
          const started = {
            ...Struct.omit(ask, ["prompt"]),
            sequence: identity === "another generation" ? 1 : 2,
            runId: identity === "another Run" ? "some-other-run" : numericRun,
            agent: identity === "another alias" ? "other-reviewer" : numericRole,
          };
          yield* controls.setControl(RELAUNCH, numericRun, encodeJson(started), oldNumericName);
        }
        const result = yield* session(
          Effect.gen(function* () {
            expect(yield* launchesAt(dir, numericRun)).toEqual([]);
            return yield* (yield* Agents).launch(ask).pipe(Effect.result);
          }),
          { herdr, env },
        );
        if (identity === "exact core marker") {
          expect(result._tag).toBe("Success");
          expect(Result.isSuccess(result) && result.success).toMatchObject({
            agent: oldNumericName,
            terminalId: old.terminalId,
            reused: true,
            sequence: 2,
          });
        } else {
          expect(result._tag).toBe("Failure");
          expect(Result.isFailure(result) && result.failure.reason).toContain("generation");
        }
        const calls = yield* rig.calls();
        expect(everyLaunch(calls)).toHaveLength(1);
        expect(Arr.map(yield* herdr.agentList(), (one) => one.name)).toEqual([oldNumericName]);
        if (identity !== "exact core marker") {
          expect(prompts(calls)).toEqual([]);
          expect(Arr.filter(calls, (call) => call.cmd === "terminal.send")).toEqual([]);
        }
      }),
    ));
}

test("an exhaustion result is observed only after its operation's usage wait is durable", () =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      yield* rig.queueOutputs([null]);
      yield* session(
        Effect.gen(function* () {
          const agents = yield* Agents;
          const launched = yield* agents.launch({
            runId: "r1",
            operation: "review",
            role: "reviewer",
            workflow: "agent-work",
            harness: "claude",
            agent: null,
            model: "opus",
            effort: null,
            permissions: null,
            task: null,
            cwd: rig.projectDir,
            prompt: "Review the diff.",
            output: outputPath("r1"),
            skill: null,
          });
          const wait = `${launchDir(dir, "r1")}/${stemOf(launched)}.usage-wait`;
          expect(yield* fs.exists(wait)).toBe(false);
          const result = yield* agents.ranOut(launched);
          expect(result._tag).toBe("RanOut");
          expect(yield* fs.exists(wait)).toBe(true);
          expect(yield* agents.usageIncident(launched)).toEqual(result);
        }),
        claudeOut,
      );
    }),
  ));

test("an agent's launch record keeps the harness session its launch names", () =>
  runEffect(
    Effect.gen(function* () {
      yield* rig.queueOutputs([{ verdict: "clean", note: "done" }]);
      yield* session(started("r1"));
      const launched = yield* launchOf("r1");
      const args = launchArgs(yield* rig.calls());
      expect(args).toContain("--session-id");
      expect(launched.terminalId).toBeDefined();
      expect(launched.agentSession).toEqual({
        kind: "claude",
        value: args[args.indexOf("--session-id") + 1] ?? "",
      });
    }),
  ));

const harnessesStarted = (calls: ReadonlyArray<Call>) =>
  Arr.map(everyLaunch(calls), (argv) => argv[0]);

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

test("work on an agent with room records where a Fallback would move it, before any does", () =>
  runEffect(
    Effect.gen(function* () {
      yield* rig.queueOutputs([{ verdict: "clean", note: "done" }]);
      yield* session(started("r1"), { fallbacks: Effect.succeed(["codex"]) });

      expect(harnessesStarted(yield* rig.calls())).toEqual(["claude"]);
      const launched = yield* launchOf("r1");
      expect(launched.from).toBeUndefined();
      expect(launched.next).toEqual({ harness: "codex", model: "default", effort: null });
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

test("a replay after a restart starts the agent the work fell back to, whatever the readings say now", () =>
  runEffect(
    Effect.gen(function* () {
      yield* rig.queueOutputs([null]);
      const chain = { fallbacks: Effect.succeed(["codex"]) };
      yield* interrupted("r1", prompted("Your task for this step"), { ...claudeOut, ...chain });
      yield* session(halted("r1"), { collectMs: 30_000 });

      const result = yield* session(
        Effect.gen(function* () {
          const resumed = yield* Effect.forkChild(started("r1"));
          yield* until(rig.calls().pipe(Effect.map((calls) => everyLaunch(calls).length === 2)));
          yield* (yield* FileSystem.FileSystem).writeFileString(
            outputPath("r1"),
            `{"verdict":"clean","note":"back"}`,
          );
          return yield* Fiber.join(resumed);
        }),
        chain,
      );
      expect(result._tag === "Success" && result.success.note).toBe("back");
      const calls = yield* rig.calls();
      expect(harnessesStarted(calls)).toEqual(["codex", "codex"]);
      for (const argv of everyLaunch(calls)) {
        expect(argv).toContain("--dangerously-bypass-hook-trust");
      }
    }),
  ));

const rateLimited = flow(
  Schema.encodeResult(Schema.fromJsonString(Schema.Unknown)),
  Result.getOrThrow,
)({
  session_id: "s-out",
  hook_event_name: "StopFailure",
  error: "rate_limit",
  transcript_path: "/home/mk/.claude/projects/p/s-out.jsonl",
});

const runsOut = (agent: string, times = 1) =>
  Effect.gen(function* () {
    const given = rig.calls().pipe(
      Effect.map((calls) => sent(calls, "Your task for this step") >= times),
      Effect.orElseSucceed(() => false),
    );
    while (!(yield* given)) {
      yield* TestClock.withLive(Effect.sleep("10 millis"));
    }
    yield* recordClaudeEvent(yield* controlDir(rig.pluginEnv().stateDir, agent), rateLimited, null);
  }).pipe(Effect.orDie);

const closedPanes = (calls: ReadonlyArray<Call>) =>
  Arr.filter(calls, (call) => call.cmd === "terminal.kill");
const chain = { fallbacks: Effect.succeed(["codex"]) };

test("a waiting agent switches when a fallback is configured after it ran out", () =>
  runEffect(
    Effect.gen(function* () {
      yield* rig.queueOutputs([null, { verdict: "clean", note: "fallback became available" }]);
      let fallbacks: ReadonlyArray<string> = [];
      yield* Effect.forkScoped(
        Effect.gen(function* () {
          yield* runsOut(agentFor("r1"));
          while (
            !pipe(yield* read(`${dir}/agents/r1/agents.log`), Str.includes("nothing has room"))
          ) {
            yield* TestClock.withLive(Effect.sleep("10 millis"));
          }
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
      expect((yield* agentsAt(dir, "r1"))[1]?.model).toBe("gpt-6.1-sol");
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
          const why = yield* controlOf(PARKED, "r1");
          expect(why).toContain("ran out (rate_limit) before writing");
          expect(why).toEndWith("Collie keeps collecting it.");
          expect(why).not.toContain("Resume");
          yield* spend(5000);
          expect(yield* suspended("r1")).toBe(false);
          fallbacks = ["codex/gpt-6.1-sol"];
          yield* TestClock.adjust("1 minute");
          return yield* Fiber.join(fiber);
        }),
        { fallbacks: Effect.sync(() => fallbacks), collectMs: 2000 },
      );
      expect(result._tag === "Success" && result.success.note).toBe("room came");
      expect(harnessesStarted(yield* rig.calls())).toEqual(["claude", "codex"]);
      expect(yield* isSet(PARKED, "r1")).toBe(false);
    }),
  ));

const EXPIRED = "CodexApiError: Your authentication token has expired";
const onPi = { harness: "pi", model: "openai-codex/gpt-5.5" };

interface PiEvent {
  readonly message?: { readonly stopReason: string; readonly errorMessage: string };
  readonly aborted?: boolean;
}
interface PiContext {
  readonly sessionManager: { readonly getSessionFile: () => string };
  readonly getContextUsage: () => { readonly tokens: number };
}
type PiHandler = (event: PiEvent, ctx: PiContext) => void;
interface PiHost {
  readonly on: (event: string, handler: PiHandler) => void;
  readonly registerCommand: () => void;
}

const stopsOnError = (agent: string, error: string, after = "Your task for this step") =>
  Effect.gen(function* () {
    while (!(yield* prompted(after))) {
      yield* TestClock.withLive(Effect.sleep("10 millis"));
    }
    const control = yield* controlDir(rig.pluginEnv().stateDir, agent);
    yield* (yield* FileSystem.FileSystem).makeDirectory(control, { recursive: true });
    yield* COMPACTION_PORTS.pi!.install({
      agent,
      harness: "pi",
      cwd: rig.projectDir,
      dir: control,
    });
    const extension: { default: (pi: PiHost) => void } = yield* Effect.promise(
      () => import(`${control}/collie.ts`),
    );
    const handlers = new Map<string, PiHandler>();
    extension.default({
      on: (event, handler) => handlers.set(event, handler),
      registerCommand: () => {},
    });
    const ctx: PiContext = {
      sessionManager: { getSessionFile: () => "/home/mk/.pi/sessions/one.jsonl" },
      getContextUsage: () => ({ tokens: 1 }),
    };
    // WARNING: the extension stamps wall time, which this Run's fast clock runs ahead of.
    setSystemTime(yield* Clock.currentTimeMillis);
    try {
      handlers.get("turn_end")!({ message: { stopReason: "error", errorMessage: error } }, ctx);
      handlers.get("agent_settled")!({ aborted: false }, ctx);
    } finally {
      setSystemTime();
    }
  }).pipe(Effect.orDie);

test("a turn its harness will not retry parks the Run within a poll, quoting the harness", () =>
  runEffect(
    Effect.gen(function* () {
      core.reportedOnly([agentFor("r1")]);
      yield* rig.queueOutputs([null]);
      yield* session(
        Effect.gen(function* () {
          yield* work.execute({ runId: "r1", input: { skip: false } }, { discard: true });
          yield* stopsOnError(agentFor("r1"), EXPIRED);
          yield* spend(5000);
          const why = yield* controlOf(PARKED, "r1");
          expect(why).toContain(EXPIRED);
          expect(why).toContain("pi/openai-codex/gpt-5.5");
          expect(why).toContain(outputPath("r1"));
          expect(why).not.toContain("minutes idle");
        }),
        { ...onPi, collectMs: 3_600_000, pollMs: 1000 },
      );
    }),
  ));

test("a Run parked on a harness stop goes on with the Output its agent writes after", () =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      yield* rig.queueOutputs([null]);
      const result = yield* session(
        Effect.gen(function* () {
          const fiber = yield* Effect.forkChild(started("r1"));
          yield* stopsOnError(agentFor("r1"), EXPIRED);
          yield* until(parkedSays(EXPIRED));
          yield* fs.writeFileString(outputPath("r1"), `{"verdict":"clean","note":"carried on"}`);
          return yield* Fiber.join(fiber);
        }),
        { ...onPi, collectMs: 3_600_000, pollMs: 1000 },
      );
      expect(result._tag === "Success" && result.success.note).toBe("carried on");
      expect(yield* isSet(PARKED, "r1")).toBe(false);
    }),
  ));

test("an agent whose harness stopped and that stays idle past its budget is parked quoting the harness", () =>
  runEffect(
    Effect.gen(function* () {
      core.reportedOnly([agentFor("r1")]);
      yield* rig.queueOutputs([null]);
      yield* session(
        Effect.gen(function* () {
          yield* work.execute({ runId: "r1", input: { skip: false } }, { discard: true });
          yield* stopsOnError(agentFor("r1"), EXPIRED);
          yield* until(parkedSays("minutes idle"));
          expect(yield* controlOf(PARKED, "r1")).toContain(EXPIRED);
        }),
        {
          ...onPi,
          herdr: new UnseenTurn(rig.pluginEnv()),
          collectMs: 60_000,
          pollMs: 1000,
        },
      );
    }),
  ));

test("a turn its harness will not retry while it repairs its Output parks the Run within a poll, quoting the harness", () =>
  runEffect(
    Effect.gen(function* () {
      yield* rig.queueOutputs([{ verdict: "maybe" }, null]);
      yield* session(
        Effect.gen(function* () {
          yield* work.execute({ runId: "r1", input: { skip: false } }, { discard: true });
          yield* stopsOnError(agentFor("r1"), EXPIRED, "not usable");
          yield* spend(5000);
          expect(yield* controlOf(PARKED, "r1")).toContain(EXPIRED);
        }),
        { ...onPi, collectMs: 3_600_000, pollMs: 1000 },
      );
    }),
  ));

test("a harness stop during a repair still parks its wait after a restart, and a late Output finishes it", () =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const over = { ...onPi, collectMs: 3_600_000, pollMs: 1000 };
      yield* rig.queueOutputs([{ verdict: "maybe" }, null]);
      yield* session(
        Effect.gen(function* () {
          yield* work.execute({ runId: "r1", input: { skip: false } }, { discard: true });
          yield* stopsOnError(agentFor("r1"), EXPIRED, "not usable");
        }),
        over,
      );
      yield* control(PARKED, "r1", false);
      const result = yield* session(
        Effect.gen(function* () {
          const fiber = yield* Effect.forkChild(started("r1"));
          yield* spend(5000);
          expect(yield* controlOf(PARKED, "r1")).toContain(EXPIRED);
          yield* fs.writeFileString(outputPath("r1"), `{"verdict":"clean","note":"carried on"}`);
          return yield* Fiber.join(fiber);
        }),
        over,
      );
      expect(result._tag === "Success" && result.success.note).toBe("carried on");
      expect(yield* isSet(PARKED, "r1")).toBe(false);
    }),
  ));

test("an agent that ran out with nothing to take over, and whose harness then stopped, is parked past its budget quoting the harness", () =>
  runEffect(
    Effect.gen(function* () {
      yield* rig.queueOutputs([null]);
      yield* session(
        Effect.gen(function* () {
          yield* work.execute({ runId: "r1", input: { skip: false } }, { discard: true });
          yield* runsOut(agentFor("r1"));
          yield* recordClaudeEvent(
            yield* controlDir(rig.pluginEnv().stateDir, agentFor("r1")),
            flow(
              Schema.encodeResult(Schema.fromJsonString(Schema.Unknown)),
              Result.getOrThrow,
            )({
              session_id: "s-out",
              hook_event_name: "StopFailure",
              error: "authentication_failed",
              error_details: EXPIRED,
            }),
            null,
          ).pipe(Effect.orDie);
          yield* until(parkedSays("ran out (rate_limit) before writing"));
          expect(yield* controlOf(PARKED, "r1")).toContain(EXPIRED);
        }),
        { fallbacks: Effect.succeed([]), collectMs: 2000 },
      );
    }),
  ));

test("a replay rechecks a fallback after the earlier host recorded that nothing had room", () =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      yield* rig.queueOutputs([null, { verdict: "clean", note: "recovered on codex" }]);
      yield* interrupted("r1", parked("r1"), {
        ...claudeOut,
        fallbacks: Effect.succeed([]),
        collectMs: 2000,
      });
      const wait = `${launchDir(dir, "r1")}/${stemOf(yield* launchOf("r1"))}.usage-wait`;
      expect(yield* fs.exists(wait)).toBe(true);
      const result = yield* releasedInto("r1", {
        ...claudeOut,
        fallbacks: Effect.succeed(["codex/gpt-6.1-sol"]),
        collectMs: 30_000,
      });
      expect(result._tag === "Success" && result.success.note).toBe("recovered on codex");
      expect(harnessesStarted(yield* rig.calls())).toEqual(["claude", "codex"]);
      expect(closedPanes(yield* rig.calls())).toHaveLength(1);
      expect(yield* fs.exists(wait)).toBe(false);
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
      const starts = everyLaunch(calls);
      expect(starts[0]).not.toContain("--dangerously-bypass-hook-trust");
      expect(starts[1]).toContain("--dangerously-bypass-hook-trust");
      expect(
        Arr.some(calls, (call) => call.cmd === "terminal.run" && call.params?.name === successor),
      ).toBe(true);
      const prompt = yield* read(`${dir}/agents/r1/review.r2.prompt.md`);
      const handed = Option.getOrElse(
        pipe(prompt, Str.indexOf("## Hand-over (revision 1)")),
        () => -1,
      );
      expect(handed).toBeGreaterThan(-1);
      expect(handed).toBeLessThan(
        Option.getOrElse(pipe(prompt, Str.indexOf("OUTPUT_PATH:")), () => -1),
      );
      expect(prompt).toContain("its subscription ran out (rate_limit) on claude/opus");
      expect(prompt).toContain("Its conversation is at /home/mk/.claude/projects/p/s-out.jsonl");
      expect(yield* read(`${dir}/agents/r1/agents.log`)).toContain(
        `review: claude/opus ran out (rate_limit) — continuing on codex/default as ${successor}`,
      );
      const records = yield* agentsAt(dir, "r1");
      expect(Arr.map(records, ({ agent, harness }) => [agent, harness])).toEqual([
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
        Arr.filter(calls, (call) => call.cmd === "terminal.send" && call.params?.terminal === agent)
          .length;
      expect([promptedTo(agentFor("r1")), promptedTo(successor)]).toEqual([1, 2]);
    }).pipe(Effect.scoped),
  ));

const handingOver = enveloped({ name: "agent-handing-over", input: {}, success: Verdict });
let handOverGiven: HandOverGiven = {};
const handingOverBody = handingOver.toLayer((payload) =>
  Effect.suspend(() =>
    agentWork({
      operation: "review",
      role: "reviewer",
      workflow: "agent-handing-over",
      cwd: rig.projectDir,
      instructions:
        "Build the ticket.\n\nWhat the tickets before it left:\n- 01-schema.md — Add the schema\n    verified: unit: pass",
      output: Verdict,
      handOver: handOverGiven,
    }),
  ).pipe(asRun(payload, "agent-handing-over")),
);
const handsOver = (over?: Partial<AgentHost>) =>
  session(
    handingOver
      .execute({ runId: "r1", input: {} })
      .pipe(Effect.result, Effect.provide(handingOverBody)),
    { ...chain, collectMs: 30_000, ...over },
  );

const inProject = (...args: ReadonlyArray<string>) =>
  Effect.promise(() => Bun.$`git ${args}`.cwd(rig.projectDir).quiet().text());
const committed = Effect.gen(function* () {
  yield* inProject("init", "-q", "-b", "work");
  yield* inProject(
    "-c",
    "user.email=t@t",
    "-c",
    "user.name=t",
    "commit",
    "-q",
    "--allow-empty",
    "-m",
    "start",
  );
  return Str.trim(yield* inProject("rev-parse", "HEAD"));
});

const passed: (name: string, head: string) => Verification = (name, head) => ({
  id: `v-${name}-${pipe(head, Str.slice(0, 7))}`,
  run: "r1",
  name,
  executable: "/usr/bin/true",
  argv: [],
  cwd: rig.projectDir,
  start: { head_sha: head, fingerprint: "f" },
  end: { head_sha: head, fingerprint: "f" },
  exit: 0,
  seconds: 1,
  expect: "pass",
  tail: { stdout: "", stderr: "" },
  result: "pass",
  at: "2026-11-20T09:00:00Z",
  by: "agent",
});

const successorPrompt = (operation = "review") =>
  read(`${dir}/agents/r1/${operation}.r2.prompt.md`);

test("a Fallback's new agent is first handed the record of the host's state: head, plan revision, criteria with their records, open findings and pending questions", () =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const head = yield* committed;
      const plan = `${rig.root}/plan`;
      yield* fs.makeDirectory(`${plan}/issues`, { recursive: true });
      yield* fs.writeFileString(`${plan}/SPEC.md`, "# Cache\n");
      yield* fs.writeFileString(`${plan}/issues/03-cache.md`, "- [ ] the cache is warmed\n");
      yield* appendVerification(evidenceDir(dir, "r1"), passed("unit", head));
      yield* appendVerification(evidenceDir(dir, "r1"), passed("misses", "0000000older"));
      yield* session(
        Store.pipe(
          Effect.flatMap((store) =>
            store.asking({
              run: "r1",
              decision: "which-store",
              prompt: "Which store holds the cache?",
              options: [
                { id: "memory", title: "In memory" },
                { id: "redis", title: "Redis" },
              ],
            }),
          ),
        ),
      );
      handOverGiven = {
        ticket: "03-cache.md",
        plan,
        criteria: ["the cache is warmed", "misses are logged", "the cache is bounded"],
        answers: [
          { criterion: "the cache is warmed", met: "cache.test.ts, recorded as unit" },
          { criterion: "misses are logged", met: "misses.test.ts, recorded as misses" },
          { criterion: "the cache is bounded", met: "not met: no eviction yet" },
        ],
        checks: ["misses"],
        findings: [
          { id: "r1-F1", status: "open", severity: "major", title: "warming races the first read" },
          { id: "r1-F2", status: "fixed", severity: "minor", title: "a typo in the log line" },
        ],
      };
      yield* rig.queueOutputs([null, { verdict: "clean", note: "finished on codex" }]);
      yield* Effect.forkScoped(runsOut(agentFor("r1")));
      const result = yield* handsOver();

      expect(result._tag === "Success" && result.success.note).toBe("finished on codex");
      const prompt = yield* successorPrompt();
      expect(prompt).toContain(`head ${pipe(head, Str.slice(0, 12))}`);
      expect(prompt).toMatch(/Plan revision: [0-9a-f]{16}\n/);
      expect(prompt).toContain(
        `the cache is warmed — claimed met: cache.test.ts, recorded as unit; records v-unit-${pipe(head, Str.slice(0, 7))}`,
      );
      expect(prompt).toContain(
        "misses are logged — claimed, unproved: misses.test.ts, recorded as misses",
      );
      expect(prompt).toContain("the cache is bounded — not claimed");
      expect(prompt).toContain("Checks still owed: misses.");
      expect(prompt).toContain("r1-F1 (open): warming races the first read");
      expect(prompt).not.toContain("r1-F2");
      expect(prompt).toContain("which-store, choices memory, redis");
    }).pipe(Effect.scoped),
  ));

test("the agent taking over reads the Run's progress once: in its prompt, not again in the hand-over", () =>
  runEffect(
    Effect.gen(function* () {
      const head = yield* committed;
      yield* appendVerification(evidenceDir(dir, "r1"), passed("unit", head));
      handOverGiven = { ticket: "02-cache.md", criteria: ["the cache is warmed"] };
      yield* rig.queueOutputs([null, { verdict: "clean", note: "finished on codex" }]);
      yield* Effect.forkScoped(runsOut(agentFor("r1")));
      yield* handsOver();

      const prompt = yield* successorPrompt();
      const count = (text: string) => Str.split(prompt, text).length - 1;
      expect(prompt).toContain("## Hand-over (revision 1)");
      expect(count("01-schema.md")).toBe(1);
      expect(count("unit")).toBe(1);
    }).pipe(Effect.scoped),
  ));

test("a criterion a criteria hand-back answered not met after an earlier met is handed over unclaimed", () => {
  const record = buildHandOver({
    revision: 1,
    run: "r1",
    step: "build",
    agent: "builder",
    incarnation: 1,
    given: {
      criteria: ["the cache is warmed"],
      answers: [
        { criterion: "the cache is warmed", met: "cache.test.ts, recorded as unit" },
        { criterion: "the cache is warmed", met: "not met: the warm-up races the first read" },
      ],
    },
    goal: null,
    constraints: [],
    plan: null,
    checkout: { head: "abc", branch: "work", dirty: false },
    base: null,
    verifications: [],
    checks: [],
    asked: [],
    transcript: null,
    reports: "reports",
  });
  expect(record.criteria).toEqual([
    { criterion: "the cache is warmed", claimed: null, proved: [] },
  ]);
});

const Said = Schema.Struct({ verdict: Schema.String, ...OutgoingFields });
const twoSteps = enveloped({ name: "agent-two-steps", input: {}, success: Verdict });
const twoStepsBody = twoSteps.toLayer((payload) =>
  Effect.gen(function* () {
    const built = yield* agentWork({
      operation: "build",
      agent: "builder",
      cwd: rig.projectDir,
      instructions: "Build.",
      output: Said,
    });
    return yield* agentWork({
      operation: "fix",
      agent: "builder",
      cwd: rig.projectDir,
      instructions: "Fix.",
      output: Verdict,
      handOver: { said: built },
    });
  }).pipe(asRun(payload, "agent-two-steps")),
);

test("the agent taking over is handed the outgoing agent's decisions, rejected approaches and next action word for word", () =>
  runEffect(
    Effect.gen(function* () {
      yield* committed;
      const said = {
        verdict: "clean",
        decisions: ["Keep the cache per process, not shared"],
        rejected: ["A Redis cache: the deploy has no Redis"],
        next_action: "Bound the cache at 1000 entries",
      };
      yield* rig.queueOutputs([said, null, { verdict: "clean", note: "fixed on codex" }]);
      yield* Effect.forkScoped(runsOut(agentName("r1", "builder", null, 1), 2));
      const result = yield* session(
        twoSteps
          .execute({ runId: "r1", input: {} })
          .pipe(Effect.result, Effect.provide(twoStepsBody)),
        { ...chain, collectMs: 30_000 },
      );

      expect(result._tag === "Success" && result.success.note).toBe("fixed on codex");
      const prompt = yield* successorPrompt("fix");
      const outgoing = agentName("r1", "builder", null, 1);
      expect(prompt).toContain(`${outgoing} decided:\n- Keep the cache per process, not shared`);
      expect(prompt).toContain(`${outgoing} rejected:\n- A Redis cache: the deploy has no Redis`);
      expect(prompt).toContain(`${outgoing}'s next action: Bound the cache at 1000 entries`);
    }).pipe(Effect.scoped),
  ));

test("a fix Output written before the outgoing agent's own fields still decodes", () => {
  expect(
    flow(
      Schema.decodeUnknownResult(FixOutputSchema),
      Result.getOrThrow,
    )({ verdict: "clean", findings: [], fixed: [], disputed: [], checks: [] }),
  ).toMatchObject({ verdict: "clean" });
});

const headsReading: (heads: Array<string>) => Partial<AgentHost> = (heads) => ({
  checkout: () =>
    Effect.sync(() => ({
      head: heads.length > 1 ? heads.shift()! : heads[0]!,
      branch: "work",
      dirty: false,
    })),
});

test("a hand-over whose head moved before it went out is rebuilt once at the new head", () =>
  runEffect(
    Effect.gen(function* () {
      yield* rig.queueOutputs([null, { verdict: "clean", note: "at the new head" }]);
      yield* Effect.forkScoped(runsOut(agentFor("r1")));
      const result = yield* session(started("r1"), {
        ...chain,
        collectMs: 30_000,
        ...headsReading(["aaaaaaaaaaaaaaaa", "bbbbbbbbbbbbbbbb"]),
      });

      expect(result._tag === "Success" && result.success.note).toBe("at the new head");
      const prompt = yield* successorPrompt();
      expect(prompt).toContain("## Hand-over (revision 2)");
      expect(prompt).toContain("head bbbbbbbbbbbb");
      expect(harnessesStarted(yield* rig.calls())).toEqual(["claude", "codex"]);
    }).pipe(Effect.scoped),
  ));

test("a hand-over built over a clean checkout that is dirty when it goes out is rebuilt to say whose the uncommitted work is", () =>
  runEffect(
    Effect.gen(function* () {
      const dirty = [false, true];
      yield* rig.queueOutputs([null, { verdict: "clean", note: "over the dirty tree" }]);
      yield* Effect.forkScoped(runsOut(agentFor("r1")));
      yield* session(started("r1"), {
        ...chain,
        collectMs: 30_000,
        checkout: () =>
          Effect.sync(() => ({
            head: "aaaaaaaaaaaaaaaa",
            branch: "work",
            dirty: dirty.length > 1 ? dirty.shift()! : dirty[0]!,
          })),
      });

      const prompt = yield* successorPrompt();
      expect(prompt).toContain("## Hand-over (revision 2)");
      expect(prompt).toContain(`The uncommitted work is ${agentFor("r1")}'s`);
    }).pipe(Effect.scoped),
  ));

test("a hand-over whose head moves again after it was rebuilt parks the Run as hand-over-stale and starts no agent", () =>
  runEffect(
    Effect.gen(function* () {
      yield* rig.queueOutputs([null, { verdict: "clean", note: "never" }]);
      yield* Effect.forkScoped(runsOut(agentFor("r1")));
      yield* interrupted("r1", parked("r1"), {
        ...chain,
        ...headsReading([
          "aaaaaaaaaaaaaaaa",
          "bbbbbbbbbbbbbbbb",
          "bbbbbbbbbbbbbbbb",
          "cccccccccccccccc",
        ]),
      });

      expect(yield* controlOf(PARK_CAUSE, "r1")).toBe("hand-over-stale");
      expect(yield* controlOf(PARKED, "r1")).toContain("head cccccccccccccccc");
      expect(harnessesStarted(yield* rig.calls())).toEqual(["claude"]);
    }).pipe(Effect.scoped),
  ));

test("a hand-over sent before a host crash, delivered again and replayed, is one delivery to one new agent", () =>
  runEffect(
    Effect.gen(function* () {
      yield* rig.queueOutputs([null, null]);
      yield* Effect.scoped(
        Effect.gen(function* () {
          yield* Effect.forkScoped(runsOut(agentFor("r1")));
          yield* interrupted("r1", prompted("Your task for this step", 2), chain);
        }),
      );
      const successor = agentName("r1", "review", null, 2);
      const again = yield* session(
        Effect.gen(function* () {
          return yield* (yield* Agents).launch({
            runId: "r1",
            operation: "review",
            role: "reviewer",
            agent: null,
            workflow: "agent-work",
            task: null,
            cwd: rig.projectDir,
            prompt: yield* successorPrompt(),
            output: outputPath("r1"),
            skill: null,
            harness: "codex",
            model: "default",
            effort: null,
            permissions: null,
            sequence: 2,
          });
        }),
      );
      expect(again.agent).toBe(successor);
      yield* FileSystem.FileSystem.pipe(
        Effect.flatMap((fs) =>
          fs.writeFileString(outputPath("r1"), `{"verdict":"clean","note":"from the new agent"}`),
        ),
      );
      const result = yield* session(started("r1"), chain);

      expect(result._tag === "Success" && result.success.note).toBe("from the new agent");
      const steps = Arr.filter(
        yield* deliveredTo(dir, "r1"),
        (one) => one.cause.kind === "step" && one.cause.ref === "review.r2",
      );
      expect(steps).toHaveLength(1);
      expect(Arr.map(yield* agentsAt(dir, "r1"), ({ agent }) => agent)).toEqual([
        agentFor("r1"),
        successor,
      ]);
      expect(
        Arr.filter(harnessesStarted(yield* rig.calls()), (one) => one === "codex"),
      ).toHaveLength(1);
      const revisions = yield* hostRecords(
        dir,
        readRunJournal(
          runJournal(`${dir}/runs/r1`, "hand-overs.jsonl"),
          Schema.fromJsonString(HandOver),
        ),
      );
      expect(Arr.map(revisions, (one) => one.revision)).toEqual([1]);
    }).pipe(Effect.scoped),
  ));

const tickets = enveloped({ name: "agent-tickets", input: {}, success: Verdict });
let ticketsGiven: HandOverGiven = {};
const ticketsBody = tickets.toLayer((payload) =>
  Effect.gen(function* () {
    const first = yield* agentWork({
      operation: "01-first.md",
      agent: "build",
      cwd: rig.projectDir,
      instructions: "Build the first ticket.",
      output: Said,
      handOver: ticketsGiven,
    });
    const second = yield* agentWork({
      operation: "02-second.md",
      agent: "build-02-second",
      takesOver: { agent: "build", why: "finished 01-first.md" },
      cwd: rig.projectDir,
      instructions: "Build the second ticket.",
      output: Said,
      handOver: { ...ticketsGiven, ticket: "02-second.md", said: first },
    });
    return yield* agentWork({
      operation: "mr",
      agent: "deliver",
      takesOver: { agent: "build-02-second", why: "finished 02-second.md" },
      cwd: rig.projectDir,
      instructions: "Open the merge request.",
      output: Verdict,
      handOver: { ...ticketsGiven, said: second },
    });
  }).pipe(asRun(payload, "agent-tickets")),
);
let firstCommit: string | null = null;
beforeEach(() => {
  ticketsGiven = {};
  firstCommit = null;
});
const ticketsRun = (over?: Partial<AgentHost>) =>
  session(
    tickets.execute({ runId: "r1", input: {} }).pipe(Effect.result, Effect.provide(ticketsBody)),
    { collectMs: 30_000, ...over },
  );
const ticketsUntil = (reached: Reached, over?: Partial<AgentHost>) =>
  session(
    Effect.gen(function* () {
      yield* tickets.execute({ runId: "r1", input: {} }, { discard: true });
      for (let tries = 0; !(yield* reached); tries++) {
        if (tries === 3000) {
          return yield* Effect.die(new Error("r1 never got that far"));
        }
        yield* TestClock.withLive(Effect.sleep("10 millis"));
      }
    }).pipe(Effect.provide(ticketsBody)),
    { collectMs: 30_000, ...over },
  );
const onTicket = (name: string, sequence = 1) => agentName("r1", name, null, sequence);
const ticketOutput = (operation: string, text: string) =>
  FileSystem.FileSystem.pipe(
    Effect.flatMap((fs) => fs.writeFileString(`${dir}/agents/r1/${operation}.json`, text)),
  );
const OPENED_MR = { verdict: "clean", note: "opened" };
const MR_OPENED = `{"verdict":"clean","note":"opened"}`;
const writesWhenGiven = (operation: string, text: string) =>
  Effect.gen(function* () {
    while (sent(yield* rig.calls(), `${operation}.prompt.md`) === 0) {
      yield* TestClock.withLive(Effect.sleep("10 millis"));
    }
    yield* ticketOutput(operation, text);
  }).pipe(Effect.orDie, Effect.forkScoped);

const headNow = Effect.map(
  Effect.suspend(() => inProject("rev-parse", "HEAD")),
  Str.trim,
);
const firstCommits = Effect.gen(function* () {
  while (sent(yield* rig.calls(), "01-first.md.prompt.md") === 0) {
    yield* TestClock.withLive(Effect.sleep("10 millis"));
  }
  yield* inProject(
    "-c",
    "user.email=t@t",
    "-c",
    "user.name=t",
    "commit",
    "-q",
    "--allow-empty",
    "-m",
    "the first ticket",
  );
  firstCommit = yield* headNow;
  yield* ticketOutput("01-first.md", `{"verdict":"clean","decisions":["Keep one registry"]}`);
}).pipe(Effect.orDie, Effect.forkScoped);

const quietFirst = (before: string, after: string) =>
  Effect.gen(function* () {
    const ended = Option.getOrUndefined(
      Arr.findFirst(yield* launchesAt(dir, "r1"), (one) => one.agent === before),
    )?.terminalId;
    const calls = yield* rig.calls();
    const killed = Arr.findFirstIndex(
      calls,
      (call) =>
        call.cmd === "terminal.kill" && ended !== undefined && call.params?.terminal === ended,
    );
    const run = Arr.findFirstIndex(
      calls,
      (call) => call.cmd === "terminal.run" && call.params?.name === after,
    );
    return Option.isSome(killed) && Option.isSome(run) && killed.value < run.value;
  });

const ticketsLedger = Effect.gen(function* () {
  const steps = Arr.filter(yield* deliveredTo(dir, "r1"), (one) => one.cause.kind === "step");
  const revisions = yield* hostRecords(
    dir,
    readRunJournal(
      runJournal(`${dir}/runs/r1`, "hand-overs.jsonl"),
      Schema.fromJsonString(HandOver),
    ),
  );
  const agents = Arr.map(yield* agentsAt(dir, "r1"), ({ agent }) => agent);
  const head = yield* headNow;
  const contains = (commit: string) =>
    Effect.promise(() =>
      Bun.$`git merge-base --is-ancestor ${commit} HEAD`.cwd(rig.projectDir).nothrow().quiet(),
    ).pipe(Effect.map((done) => done.exitCode === 0));
  return {
    agents,
    steps: Arr.map(steps, (one) => one.cause.ref),
    revisions: Arr.map(revisions, (one) => one.revision),
    oneWriter: Arr.every(
      yield* Effect.forEach(Arr.zip(agents, Arr.drop(agents, 1)), ([before, after]) =>
        quietFirst(before, after),
      ),
      (one) => one,
    ),
    kept:
      firstCommit !== null &&
      (yield* contains(firstCommit)) &&
      Arr.every(revisions, (one) => one.head === head),
  };
});
const ONE_EACH = {
  agents: [onTicket("build"), onTicket("build-02-second"), onTicket("deliver")],
  steps: ["01-first.md", "02-second.md", "mr"],
  revisions: [1, 2],
  oneWriter: true,
  kept: true,
};

test("a ticket boundary ends the outgoing agent and finds it Quiet before the next ticket's agent starts, and that agent is first handed the hand-over", () =>
  runEffect(
    Effect.gen(function* () {
      yield* committed;
      yield* rig.queueOutputs([null, { verdict: "clean" }, OPENED_MR]);
      yield* firstCommits;
      const result = yield* ticketsRun();

      expect(result._tag === "Success" && result.success.note).toBe("opened");
      expect(yield* ticketsLedger).toEqual(ONE_EACH);
      const head = yield* headNow;
      const second = yield* read(`${dir}/agents/r1/02-second.md.prompt.md`);
      expect(second).toContain(
        `You take over 02-second.md (ticket 02-second.md) of r1 from ${onTicket("build")}, incarnation 1, which stopped because it finished 01-first.md.`,
      );
      expect(second).toContain(`head ${pipe(head, Str.slice(0, 12))}`);
      expect(second).toContain(`${onTicket("build")} decided:\n- Keep one registry`);
      expect(yield* read(`${dir}/agents/r1/mr.prompt.md`)).toContain("## Hand-over (revision 2)");
      expect(yield* read(`${dir}/agents/r1/agents.log`)).toContain(
        `02-second.md: ${onTicket("build")} finished 01-first.md; build-02-second takes its work over`,
      );
    }).pipe(Effect.scoped),
  ));

test("a host crash just before a boundary's hand-over is sent, and a plan changed while it was down, send one rebuilt hand-over to one new agent", () =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      yield* committed;
      const plan = `${rig.root}/plan`;
      yield* fs.makeDirectory(`${plan}/issues`, { recursive: true });
      yield* fs.writeFileString(`${plan}/issues/02-second.md`, "- [ ] it counts\n");
      ticketsGiven = { plan };
      yield* rig.queueOutputs([null]);
      yield* firstCommits;
      let reads = 0;
      // WARNING: the record is read once as it is built; the read before it goes out never answers.
      const stalls: Partial<AgentHost> = {
        checkout: () =>
          Effect.suspend(() =>
            ++reads >= 2
              ? Effect.never
              : Effect.map(headNow, (head) => ({ head, branch: "work", dirty: false })),
          ),
      };
      yield* ticketsUntil(
        Effect.sync(() => reads >= 2),
        stalls,
      );
      expect(yield* ticketsLedger).toEqual({
        agents: [onTicket("build")],
        steps: ["01-first.md"],
        revisions: [1],
        oneWriter: true,
        kept: true,
      });
      yield* fs.writeFileString(`${plan}/issues/02-second.md`, "- [ ] it counts twice\n");
      yield* writesWhenGiven("02-second.md", `{"verdict":"clean"}`);
      yield* writesWhenGiven("mr", MR_OPENED);
      const result = yield* ticketsRun();

      expect(result._tag === "Success" && result.success.note).toBe("opened");
      expect(yield* ticketsLedger).toEqual({ ...ONE_EACH, revisions: [1, 2, 3] });
      expect(yield* read(`${dir}/agents/r1/02-second.md.prompt.md`)).toContain(
        "## Hand-over (revision 2)",
      );
    }).pipe(Effect.scoped),
  ));

test.each([
  { boundary: "a ticket boundary", operation: "02-second.md", outputs: [null, null] },
  {
    boundary: "the last boundary, into deliver",
    operation: "mr",
    outputs: [null, { verdict: "clean" }, null],
  },
])(
  "a host crash just after $boundary's hand-over is sent, with the step delivered again, leaves one delivery to one new agent",
  ({ operation, outputs }) =>
    runEffect(
      Effect.gen(function* () {
        yield* committed;
        yield* rig.queueOutputs(outputs);
        yield* firstCommits;
        yield* ticketsUntil(prompted(`${operation}.prompt.md`));
        const owner = operation === "mr" ? "deliver" : "build-02-second";
        const prompt = yield* read(`${dir}/agents/r1/${operation}.prompt.md`);
        yield* session(
          Effect.gen(function* () {
            return yield* (yield* Agents).launch({
              runId: "r1",
              operation,
              role: operation,
              agent: owner,
              workflow: "agent-tickets",
              task: null,
              cwd: rig.projectDir,
              prompt,
              output: `${dir}/agents/r1/${operation}.json`,
              skill: null,
              harness: "claude",
              model: "opus",
              effort: null,
              permissions: null,
            });
          }),
        );
        yield* ticketOutput(operation, operation === "mr" ? MR_OPENED : `{"verdict":"clean"}`);
        if (operation !== "mr") {
          yield* writesWhenGiven("mr", MR_OPENED);
        }
        const result = yield* ticketsRun();

        expect(result._tag === "Success" && result.success.note).toBe("opened");
        expect(yield* ticketsLedger).toEqual(ONE_EACH);
        expect(
          Arr.filter(
            yield* rig.calls(),
            (call) => call.cmd === "terminal.run" && call.params?.name === onTicket(owner),
          ),
        ).toHaveLength(1);
      }).pipe(Effect.scoped),
    ),
);

test("a resume after a host restart mid-ticket carries on with that ticket's agent and starts none", () =>
  runEffect(
    Effect.gen(function* () {
      yield* committed;
      yield* rig.queueOutputs([null, null]);
      yield* firstCommits;
      yield* ticketsUntil(prompted("02-second.md.prompt.md"));
      yield* ticketOutput("02-second.md", `{"verdict":"clean"}`);
      yield* writesWhenGiven("mr", MR_OPENED);
      const result = yield* ticketsRun();

      expect(result._tag === "Success" && result.success.note).toBe("opened");
      expect(yield* ticketsLedger).toEqual(ONE_EACH);
      expect(Arr.filter(yield* rig.cmds(), (cmd) => cmd === "terminal.run")).toHaveLength(3);
    }).pipe(Effect.scoped),
  ));

test("a wait across a restart, an answer to its question and an Output repair during a ticket go to that ticket's agent and start none", () =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      yield* committed;
      yield* rig.queueOutputs([null, null]);
      yield* firstCommits;
      yield* ticketsUntil(prompted("02-second.md.prompt.md"));
      const result = yield* session(
        Effect.gen(function* () {
          yield* tickets.execute({ runId: "r1", input: {} }, { discard: true });
          yield* fs.writeFileString(
            hostLockOf(rig.pluginEnv().stateDir),
            `{"pid":${process.pid},"start":null}`,
          );
          yield* recordClaudeEvent(
            yield* controlDir(rig.pluginEnv().stateDir, onTicket("build-02-second")),
            askedTwo,
            null,
          );
          const [first, second] = yield* questionsOf(2);
          yield* answer(first!.decision, "SQLite");
          yield* answer(second!.decision, "lint");
          yield* until(prompted(ANSWERED));
          yield* ticketOutput("02-second.md", `{"verdict":3}`);
          yield* until(prompted("not usable"));
          yield* ticketOutput("02-second.md", `{"verdict":"clean"}`);
          yield* writesWhenGiven("mr", MR_OPENED);
          return yield* tickets.execute({ runId: "r1", input: {} }).pipe(Effect.result);
        }).pipe(Effect.scoped, Effect.provide(ticketsBody)),
        { collectMs: 120_000 },
      );

      expect(result._tag === "Success" && result.success.note).toBe("opened");
      expect(yield* ticketsLedger).toEqual(ONE_EACH);
      const toSecond = sentTexts(
        Arr.filter(
          yield* rig.calls(),
          (call) =>
            call.cmd === "terminal.send" && call.params?.terminal === onTicket("build-02-second"),
        ),
      );
      expect([
        Arr.some(toSecond, Str.includes(ANSWERED)),
        Arr.some(toSecond, Str.includes("not usable")),
      ]).toEqual([true, true]);
    }).pipe(Effect.scoped),
  ));

test("a question pending when a ticket ends is handed to the next ticket's agent by name and choices", () =>
  runEffect(
    Effect.gen(function* () {
      yield* committed;
      yield* session(
        Store.pipe(
          Effect.flatMap((store) =>
            store.asking({
              run: "r1",
              decision: "which-store",
              prompt: "Which store holds the registry?",
              options: [
                { id: "memory", title: "In memory" },
                { id: "redis", title: "Redis" },
              ],
            }),
          ),
        ),
      );
      yield* rig.queueOutputs([null, { verdict: "clean" }, OPENED_MR]);
      yield* firstCommits;
      const result = yield* ticketsRun();

      expect(result._tag === "Success" && result.success.note).toBe("opened");
      expect(yield* read(`${dir}/agents/r1/02-second.md.prompt.md`)).toContain(
        "Pending questions:\n- which-store, choices memory, redis",
      );
      expect(yield* ticketsLedger).toEqual(ONE_EACH);
    }).pipe(Effect.scoped),
  ));

test("a quota Fallback mid-ticket keeps the ticket's agent name for the agent that takes it over", () =>
  runEffect(
    Effect.gen(function* () {
      yield* committed;
      yield* rig.queueOutputs([null, null, { verdict: "clean" }, OPENED_MR]);
      yield* firstCommits;
      yield* Effect.forkScoped(runsOut(onTicket("build-02-second"), 2));
      const result = yield* ticketsRun(chain);

      expect(result._tag === "Success" && result.success.note).toBe("opened");
      expect(yield* ticketsLedger).toMatchObject({
        agents: [
          onTicket("build"),
          onTicket("build-02-second"),
          onTicket("build-02-second", 2),
          onTicket("deliver"),
        ],
        oneWriter: true,
        kept: true,
      });
      expect(yield* read(`${dir}/agents/r1/mr.prompt.md`)).toContain(
        `from ${onTicket("build-02-second", 2)}, incarnation 2`,
      );
    }).pipe(Effect.scoped),
  ));

test("a late turn of a ticket's agent after it was stopped changes nothing for the agent that took its work over", () =>
  runEffect(
    Effect.gen(function* () {
      yield* committed;
      yield* rig.queueOutputs([null, null]);
      yield* firstCommits;
      yield* ticketsUntil(prompted("02-second.md.prompt.md"));
      yield* recordClaudeEvent(
        yield* controlDir(rig.pluginEnv().stateDir, onTicket("build")),
        rateLimited,
        null,
      );
      yield* FileSystem.FileSystem.pipe(
        Effect.flatMap((fs) =>
          fs.writeFileString(`${dir}/agents/r1/01-first.md.json`, `{"verdict":"findings"}`),
        ),
      );
      yield* ticketOutput("02-second.md", `{"verdict":"clean"}`);
      yield* writesWhenGiven("mr", MR_OPENED);
      const result = yield* ticketsRun(chain);

      expect(result._tag === "Success" && result.success.note).toBe("opened");
      expect(yield* ticketsLedger).toEqual(ONE_EACH);
    }).pipe(Effect.scoped),
  ));

test("a ticket's agent whose pane leaves a child that will not stop parks the Run on predecessor-not-quiet, and the next ticket's agent is never started", () =>
  runEffect(
    Effect.gen(function* () {
      yield* committed;
      const tree = yield* paneTree(IGNORES_TERM);
      core.runsAs(tree.shell);
      yield* rig.queueOutputs([null]);
      yield* firstCommits;
      yield* ticketsUntil(parked("r1"), { stopMs: 500 });

      expect(yield* controlOf(PARK_CAUSE, "r1")).toBe("predecessor-not-quiet");
      expect(yield* processOf(tree.child)).not.toBeNull();
      expect(yield* ticketsLedger).toMatchObject({
        agents: [onTicket("build")],
        steps: ["01-first.md"],
      });
    }).pipe(Effect.scoped),
  ));

test("a check a ticket's agent left running in the background is stopped before the next ticket's agent starts", () =>
  runEffect(
    Effect.gen(function* () {
      yield* committed;
      const tree = yield* paneTree(SURVIVES_HANGUP);
      core.runsAs(tree.shell);
      const aliveAtTakeover = yield* Ref.make<boolean | null>(null);
      yield* Effect.forkScoped(
        Effect.gen(function* () {
          const startedYet = rig.calls().pipe(
            Effect.map((calls) =>
              Arr.some(
                calls,
                (call) =>
                  call.cmd === "terminal.run" && call.params?.name === onTicket("build-02-second"),
              ),
            ),
            Effect.orElseSucceed(() => false),
          );
          while (!(yield* startedYet)) {
            yield* TestClock.withLive(Effect.sleep("1 millis"));
          }
          yield* Ref.set(aliveAtTakeover, (yield* processOf(tree.child)) !== null);
        }),
      );
      yield* rig.queueOutputs([null, { verdict: "clean" }, OPENED_MR]);
      yield* firstCommits;
      const result = yield* ticketsRun({ stopMs: 3000 });

      expect(result._tag === "Success" && result.success.note).toBe("opened");
      expect(yield* Ref.get(aliveAtTakeover)).toBe(false);
      expect(yield* ticketsLedger).toEqual(ONE_EACH);
    }).pipe(Effect.scoped),
  ));

test("when nothing has room the agent that ran out is kept, and the Run parks saying when usage resets", () =>
  runEffect(
    Effect.gen(function* () {
      yield* rig.queueOutputs([null]);
      yield* interrupted("r1", parked("r1"), {
        ...claudeOut,
        fallbacks: Effect.succeed([]),
        collectMs: 2000,
      });

      const calls = yield* rig.calls();
      expect(closedPanes(calls)).toHaveLength(0);
      expect(harnessesStarted(calls)).toEqual(["claude"]);
      expect(yield* read(`${dir}/agents/r1/agents.log`)).toMatch(
        /review: claude\/opus ran out \(session 100%, resets .+\); nothing has room; claude\/opus: session 100%, resets /,
      );
      const why = yield* controlOf(PARKED, "r1");
      expect(why).toContain("nothing has room; claude/opus: session 100%, resets");
    }),
  ));

test("an agent that ran out and will not close parks the work, and no other agent starts beside it", () =>
  runEffect(
    Effect.gen(function* () {
      yield* rig.queueOutputs([null, { verdict: "clean", note: "after it closed" }]);
      yield* Effect.scoped(
        Effect.gen(function* () {
          yield* Effect.forkScoped(runsOut(agentFor("r1")));
          yield* interrupted("r1", parked("r1"), {
            ...chain,
            herdr: new Refusing({ "terminal.kill": "pane is busy" }),
          });
        }),
      );
      expect(harnessesStarted(yield* rig.calls())).toEqual(["claude"]);
      expect(yield* controlOf(PARKED, "r1")).toContain(
        "would not close (core terminal.kill failed: pane is busy)",
      );

      const result = yield* releasedInto("r1", { ...chain, collectMs: 30_000 });
      expect(result._tag === "Success" && result.success.note).toBe("after it closed");
      expect(harnessesStarted(yield* rig.calls())).toEqual(["claude", "codex"]);
    }),
  ));

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

test("an OpenCode agent that runs out is replaced only once nothing of its pane is running", () =>
  runEffect(
    Effect.gen(function* () {
      yield* rig.queueOutputs([null, { verdict: "clean", note: "finished on codex" }]);
      const tree = yield* paneTree(SURVIVES_HANGUP);
      core.runsAs(tree.shell);
      const successor = agentName("r1", "review", null, 2);
      const aliveAtTakeover = yield* Ref.make<boolean | null>(null);
      yield* Effect.forkScoped(
        Effect.gen(function* () {
          const startedYet = rig.calls().pipe(
            Effect.map((calls) =>
              Arr.some(
                calls,
                (call) => call.cmd === "terminal.run" && call.params?.name === successor,
              ),
            ),
            Effect.orElseSucceed(() => false),
          );
          while (!(yield* startedYet)) {
            yield* TestClock.withLive(Effect.sleep("1 millis"));
          }
          yield* Ref.set(aliveAtTakeover, (yield* processOf(tree.child)) !== null);
        }),
      );
      const reached: UsageReading = {
        subscription: "claude",
        account: "acct",
        accountLabel: null,
        plan: "max",
        windows: [
          {
            kind: "session",
            label: "Session",
            model: null,
            usedPercent: 100,
            resetsAt: "2099-01-01T15:45:00Z",
            reached: true,
          },
        ],
        at: "2026-10-08T08:00:00Z",
        source: "claude-usage",
        problem: null,
      };
      const result = yield* session(started("r1"), {
        harness: "opencode",
        model: "anthropic/claude-opus-4-1",
        fallbacks: Effect.succeed(["codex"]),
        readings: Effect.succeed([{ ...reached, windows: [] }]),
        ownReading: (agent) => Effect.succeed(agent === agentFor("r1") ? reached : null),
        collectMs: 30_000,
      });
      expect(result._tag === "Success" && result.success.note).toBe("finished on codex");
      expect(yield* Ref.get(aliveAtTakeover)).toBe(false);
      expect(Arr.map(yield* agentsAt(dir, "r1"), (one) => one.harness)).toEqual([
        "opencode",
        "codex",
      ]);
    }).pipe(Effect.scoped),
  ));

test("quota incident publication waits for an admitted managed-server revival", () =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const managed = yield* managedCodex;
      const retiring = yield* Deferred.make<void>();
      const proceed = yield* Deferred.make<void>();
      const wait = `${launchDir(dir, "r1")}/review.usage-wait`;
      let writing = false;
      const observedFs: FileSystem.FileSystem = {
        ...fs,
        writeFileString: (path, data, options) =>
          Effect.sync(() => {
            if (pipe(path, Str.startsWith(wait))) {
              writing = true;
            }
          }).pipe(Effect.andThen(fs.writeFileString(path, data, options))),
      };
      const ports: CompactionPorts = {
        codex: {
          ...managed.ports.codex!,
          stop: (target, note, budgetMs) =>
            Deferred.succeed(retiring, undefined).pipe(
              Effect.andThen(Deferred.await(proceed)),
              Effect.andThen(COMPACTION_PORTS.codex!.stop!(target, note, budgetMs)),
            ),
        },
      };
      yield* rig.queueOutputs([null, null]);
      yield* session(
        Effect.gen(function* () {
          const agents = yield* Agents;
          const ask = {
            runId: "r1",
            operation: "review",
            role: "reviewer",
            workflow: "agent-work",
            harness: "codex",
            agent: null,
            model: "default",
            effort: null,
            permissions: null,
            task: null,
            cwd: rig.projectDir,
            prompt: "Review the diff.",
            output: outputPath("r1"),
            skill: null,
          };
          const launched = yield* agents.launch(ask);
          managed.state.reachable = false;
          managed.children[0]!.kill();
          yield* Effect.promise(() => managed.children[0]!.exited);
          const recovery = yield* Effect.forkChild(agents.revive(ask, undefined, true));
          yield* Deferred.await(retiring);
          const incident: RanOut = {
            _tag: "RanOut",
            why: "weekly limit reached during recovery",
            transcript: null,
            resetsAt: null,
          };
          const publishing = yield* Effect.forkChild(agents.usageWaiting(launched, incident), {
            startImmediately: true,
          });
          const cancelled = yield* Effect.forkChild(
            agents.usageWaiting(launched, { ...incident, why: "cancelled publisher" }),
            { startImmediately: true },
          );
          yield* Fiber.interrupt(cancelled);
          const unrelated = { ...launched, runId: "r2" };
          yield* fs.makeDirectory(launchDir(dir, unrelated.runId), { recursive: true });
          const independent = yield* agents
            .usageWaiting(unrelated, incident)
            .pipe(Effect.timeoutOption("1 minute"));
          expect(independent._tag).toBe("Some");
          expect(yield* agents.usageIncident(unrelated)).toEqual(incident);
          const wroteBeforeRelease = writing;
          yield* Deferred.succeed(proceed, undefined);
          expect(wroteBeforeRelease).toBe(false);
          expect(yield* Fiber.join(recovery)).toBe(true);
          yield* Fiber.join(publishing);
          expect(writing).toBe(true);
          expect(yield* fs.exists(wait)).toBe(true);
          expect(yield* agents.usageIncident(launched)).toEqual(incident);
          expect(everyLaunch(yield* rig.calls())).toHaveLength(2);

          managed.state.reachable = false;
          managed.children[1]!.kill();
          yield* Effect.promise(() => managed.children[1]!.exited);
          expect(yield* agents.revive(ask, undefined, true)).toBe(false);
          expect(everyLaunch(yield* rig.calls())).toHaveLength(2);
        }).pipe(Effect.ensuring(Deferred.succeed(proceed, undefined))),
        { harness: "codex", model: "default", ports },
      ).pipe(Effect.provideService(FileSystem.FileSystem, observedFs));
    }).pipe(Effect.scoped),
  ));

test("a quota incident survives a host crash before its collection result is recorded", () =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const managed = yield* managedCodex;
      core.reportedOnly([agentFor("r1")]);
      yield* rig.queueOutputs([{ verdict: "clean", note: "recovered the unrecorded incident" }]);
      const now = yield* Clock.currentTimeMillis;
      const exhausted: UsageReading = {
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
            resetsAt: isoAt(now + 3_600_000),
            reached: true,
          },
        ],
        at: isoAt(now),
        source: "codex-app-server",
        problem: null,
      };
      const available = {
        ...exhausted,
        windows: [{ ...exhausted.windows[0]!, usedPercent: 0, reached: false }],
      };
      const wait = `${launchDir(dir, "r1")}/review.usage-wait`;
      const written = yield* Deferred.make<void>();
      const pauseAfterWrite = (path: string) =>
        path === wait
          ? Deferred.succeed(written, undefined).pipe(
              Effect.andThen(Effect.never),
              Effect.interruptible,
            )
          : Effect.void;
      const crashingFs: FileSystem.FileSystem = {
        ...fs,
        writeFileString: (path, data, options) =>
          fs.writeFileString(path, data, options).pipe(Effect.tap(() => pauseAfterWrite(path))),
        rename: (from, to) => fs.rename(from, to).pipe(Effect.tap(() => pauseAfterWrite(to))),
      };
      const herdr = new UnseenTurn(rig.pluginEnv());
      const over = {
        herdr,
        harness: "codex",
        model: "default",
        ports: managed.ports,
        readyMs: 1000,
        fallbacks: Effect.succeed([]),
        collectMs: 2000,
      };
      yield* interrupted("r1", Deferred.isDone(written), {
        ...over,
        readings: Effect.succeed([{ ...available, at: isoAt(now - 60_000) }]),
        ownReading: () => Effect.succeed(exhausted),
      }).pipe(Effect.provideService(FileSystem.FileSystem, crashingFs));
      expect(yield* fs.exists(wait)).toBe(true);
      expect(everyLaunch(yield* rig.calls())).toHaveLength(1);
      managed.state.reachable = false;
      managed.children[0]!.kill();
      yield* Effect.promise(() => managed.children[0]!.exited);
      const terminal = Option.getOrThrow(
        Arr.findFirst(yield* herdr.agentList(), (one) => one.name === agentFor("r1")),
      );
      yield* herdr.terminalKill(terminal.paneId);

      const result = yield* session(started("r1").pipe(Effect.timeoutOption("2 minutes")), {
        ...over,
        readings: Effect.succeed([
          {
            ...available,
            at: isoAt(yield* Clock.currentTimeMillis),
            windows: [{ ...available.windows[0]!, resetsAt: isoAt(now + 7_200_000) }],
          },
        ]),
        ownReading: () => Effect.succeed(null),
      });
      expect(
        result._tag,
        `${yield* read(`${dir}/agents/r1/agents.log`)}\n${yield* controlOf(PARKED, "r1")}`,
      ).toBe("Some");
      expect(
        result._tag === "Some" && result.value._tag === "Success" && result.value.success.note,
      ).toBe("recovered the unrecorded incident");
      expect(everyLaunch(yield* rig.calls())).toHaveLength(2);
      expect(managed.children).toHaveLength(2);
      expect(yield* fs.exists(wait)).toBe(false);
    }).pipe(Effect.scoped),
  ));

test("a quota wait does not revive a dead managed Codex server before its usage recovers", () =>
  runEffect(
    Effect.gen(function* () {
      const managed = yield* managedCodex;
      const herdr = new StaleWorkingTerminal(rig.pluginEnv());
      yield* rig.queueOutputs([null, { verdict: "clean", note: "after usage recovered" }]);
      const now = yield* Clock.currentTimeMillis;
      const exhausted: UsageReading = {
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
            resetsAt: isoAt(now + 3_600_000),
            reached: true,
          },
        ],
        at: isoAt(now),
        source: "codex-app-server",
        problem: null,
      };
      const available = {
        ...exhausted,
        windows: [{ ...exhausted.windows[0]!, usedPercent: 0, reached: false }],
      };
      let machine: UsageReading = { ...available, at: isoAt(now - 60_000) };
      const result = yield* session(
        Effect.gen(function* () {
          const waiting = yield* Effect.forkChild(started("r1"));
          yield* until(parkedSays("before writing"));
          herdr.stale = true;
          managed.state.reachable = false;
          managed.children[0]!.kill();
          yield* Effect.promise(() => managed.children[0]!.exited);
          yield* spend(20_000);
          expect(everyLaunch(yield* rig.calls())).toHaveLength(1);
          expect(managed.children).toHaveLength(1);

          machine = {
            ...available,
            at: isoAt(yield* Clock.currentTimeMillis),
            windows: [{ ...available.windows[0]!, resetsAt: isoAt(now + 7_200_000) }],
          };
          yield* TestClock.adjust("1 minute");
          return yield* Fiber.join(waiting).pipe(Effect.timeoutOption("2 minutes"));
        }),
        {
          herdr,
          harness: "codex",
          model: "default",
          ports: managed.ports,
          readyMs: 1000,
          fallbacks: Effect.succeed([]),
          readings: Effect.sync(() => [machine]),
          ownReading: (agent) => Effect.succeed(agent === agentFor("r1") ? exhausted : null),
          collectMs: 2000,
        },
      );
      expect(result._tag).toBe("Some");
      expect(
        result._tag === "Some" && result.value._tag === "Success" && result.value.success.note,
      ).toBe("after usage recovered");
      const calls = yield* rig.calls();
      expect(harnessesStarted(calls)).toEqual(["codex", "codex"]);
      expect(closedPanes(calls)).toHaveLength(1);
      expect(sent(calls, "Your task for this step")).toBe(2);
      expect(managed.children).toHaveLength(2);
    }).pipe(Effect.scoped),
  ));

test("a quota fallback keeps valid late Output written while retiring its managed Codex server", () =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const managed = yield* managedCodex;
      const ports: CompactionPorts = {
        codex: {
          ...managed.ports.codex!,
          stop: (target, note, budgetMs) =>
            Effect.gen(function* () {
              yield* fs.writeFileString(
                outputPath("r1"),
                '{"verdict":"clean","note":"finished during retirement"}',
              );
              managed.children[0]!.kill();
              yield* Effect.promise(() => managed.children[0]!.exited);
              return yield* COMPACTION_PORTS.codex!.stop!(target, note, budgetMs);
            }).pipe(Effect.orDie),
        },
      };
      yield* rig.queueOutputs([null, { verdict: "clean", note: "unnecessary successor" }]);
      const now = yield* Clock.currentTimeMillis;
      const exhausted: UsageReading = {
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
            resetsAt: isoAt(now + 3_600_000),
            reached: true,
          },
        ],
        at: isoAt(now),
        source: "codex-app-server",
        problem: null,
      };
      let fallbacks: ReadonlyArray<string> = [];
      const result = yield* session(
        Effect.gen(function* () {
          const waiting = yield* Effect.forkChild(started("r1"));
          yield* until(parkedSays("before writing"));
          expect(harnessesStarted(yield* rig.calls())).toEqual(["codex"]);
          fallbacks = ["claude/opus"];
          yield* TestClock.adjust("1 minute");
          return yield* Fiber.join(waiting);
        }),
        {
          harness: "codex",
          model: "default",
          ports,
          fallbacks: Effect.sync(() => fallbacks),
          readings: Effect.succeed([{ ...exhausted, windows: [] }]),
          ownReading: (agent) => Effect.succeed(agent === agentFor("r1") ? exhausted : null),
          collectMs: 2000,
        },
      );
      expect(result._tag === "Success" && result.success.note).toBe("finished during retirement");
      const calls = yield* rig.calls();
      expect(everyLaunch(calls)).toHaveLength(1);
      expect(sent(calls, "Your task for this step")).toBe(1);
      expect(closedPanes(calls)).toHaveLength(1);
      expect(managed.children).toHaveLength(1);
      expect(managed.children[0]!.signalCode).toBe("SIGTERM");
    }).pipe(Effect.scoped),
  ));

for (const recovery of ["a newer matching reset", "its known reset passing"]) {
  test(`a spent subscription recovers on ${recovery} without resuming the Run`, () =>
    runEffect(
      Effect.gen(function* () {
        yield* rig.queueOutputs([
          null,
          { verdict: "clean", note: "the subscription has room again" },
        ]);
        const now = yield* Clock.currentTimeMillis;
        const exhausted: UsageReading = {
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
              resetsAt: isoAt(now + (recovery === "its known reset passing" ? 120_000 : 3_600_000)),
              reached: true,
            },
          ],
          at: isoAt(now),
          source: "codex-app-server",
          problem: null,
        };
        const available = {
          ...exhausted,
          windows: [{ ...exhausted.windows[0]!, usedPercent: 0, reached: false }],
        };
        let machine: UsageReading = { ...available, at: isoAt(now - 60_000) };
        const result = yield* session(
          Effect.gen(function* () {
            const waiting = yield* Effect.forkChild(started("r1"));
            yield* until(parkedSays("before writing"));
            expect(harnessesStarted(yield* rig.calls())).toEqual(["codex"]);
            if (recovery === "its known reset passing") {
              yield* TestClock.adjust("3 minutes");
            } else {
              machine = {
                ...available,
                at: isoAt(yield* Clock.currentTimeMillis),
                windows: [{ ...available.windows[0]!, resetsAt: isoAt(now + 7_200_000) }],
              };
              yield* TestClock.adjust("1 minute");
            }
            return yield* Fiber.join(waiting).pipe(Effect.timeoutOption("2 minutes"));
          }),
          {
            harness: "codex",
            model: "default",
            fallbacks: Effect.succeed([]),
            readings: Effect.sync(() => [machine]),
            ownReading: (agent) => Effect.succeed(agent === agentFor("r1") ? exhausted : null),
            collectMs: 2000,
          },
        );
        expect(result._tag).toBe("Some");
        expect(
          result._tag === "Some" && result.value._tag === "Success" && result.value.success.note,
        ).toBe("the subscription has room again");
        const calls = yield* rig.calls();
        expect(harnessesStarted(calls)).toEqual(["codex", "codex"]);
        expect(closedPanes(calls)).toHaveLength(1);
        expect(yield* isSet(PARKED, "r1")).toBe(false);
      }),
    ));
}

test("a spent subscription stays unavailable without proof that its exhausted window reset", () =>
  runEffect(
    Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis;
      const reset = isoAt(now + 3_600_000);
      const spent = [
        {
          on: { harness: "codex", model: "default", effort: null },
          why: "weekly limit reached",
          resetsAt: reset,
          exhaustion: {
            at: now - 60_000,
            account: "acct",
            windows: [{ kind: "weekly" as const, model: null, resetsAt: reset }],
          },
        },
      ];
      const fresh: UsageReading = {
        subscription: "chatgpt",
        account: "acct",
        accountLabel: null,
        plan: "pro",
        windows: [
          {
            kind: "weekly",
            label: "Weekly",
            model: null,
            usedPercent: 0,
            resetsAt: isoAt(now + 7_200_000),
            reached: false,
          },
        ],
        at: isoAt(now),
        source: "codex-app-server",
        problem: null,
      };
      let readings: ReadonlyArray<UsageReading> = [];
      yield* session(
        Effect.gen(function* () {
          const agents = yield* Agents;
          for (const candidate of [
            { ...fresh, windows: [{ ...fresh.windows[0]!, resetsAt: reset }] },
            { ...fresh, at: isoAt(now - 120_000) },
            { ...fresh, at: isoAt(now + 3_600_000) },
            { ...fresh, at: "not a timestamp" },
            { ...fresh, problem: "The usage source could not be read" },
            { ...fresh, windows: [] },
            { ...fresh, account: "another-account" },
            {
              ...fresh,
              windows: [
                ...fresh.windows,
                { ...fresh.windows[0]!, kind: "session" as const, usedPercent: 100, reached: true },
              ],
            },
          ]) {
            readings = [candidate];
            const chosen = yield* agents.choose([], { runId: "r1", operation: "review" }, spent);
            expect(chosen.why).toStartWith("nothing has room");
          }
          readings = [fresh];
          const previous = {
            ...spent[0]!,
            resetsAt: isoAt(now - 1),
            exhaustion: {
              ...spent[0]!.exhaustion,
              at: now - 120_000,
              windows: [{ ...spent[0]!.exhaustion.windows[0]!, resetsAt: isoAt(now - 1) }],
            },
          };
          const latest = { ...spent[0]!, exhaustion: { ...spent[0]!.exhaustion, at: now } };
          const repeated = yield* agents.choose([], { runId: "r1", operation: "review" }, [
            previous,
            latest,
          ]);
          expect(repeated.why).toStartWith("nothing has room");
          readings = [{ ...fresh, at: isoAt(now - 10 * 60_000) }];
          const staleRecovery = yield* agents.choose([], { runId: "r1", operation: "review" }, [
            {
              ...spent[0]!,
              exhaustion: { ...spent[0]!.exhaustion, at: now - 20 * 60_000 },
            },
          ]);
          expect(staleRecovery.why).toStartWith("nothing has room");
        }),
        {
          harness: "codex",
          model: "default",
          fallbacks: Effect.succeed([]),
          readings: Effect.sync(() => readings),
        },
      );
      expect(harnessesStarted(yield* rig.calls())).toEqual([]);
    }),
  ));

test("a legacy quota incident permits a retry only from fresh healthy capacity beyond its known future reset", () =>
  runEffect(
    Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis;
      const reset = isoAt(now + 5 * 86_400_000);
      const legacy: RanOut = {
        _tag: "RanOut",
        why: "weekly 100%, resets Wed 06:55",
        transcript: null,
      };
      const on = { harness: "codex", model: "default", effort: null };
      const spent = { ...legacy, resetsAt: reset, on };
      const fresh: UsageReading = {
        subscription: "chatgpt",
        account: "current-account",
        accountLabel: null,
        plan: "pro",
        windows: [
          {
            kind: "weekly",
            label: "Weekly",
            model: null,
            usedPercent: 24,
            resetsAt: isoAt(now + 6 * 86_400_000),
            reached: false,
          },
        ],
        at: isoAt(now),
        source: "codex-app-server",
        problem: null,
      };
      const blocked: ReadonlyArray<ReadonlyArray<UsageReading>> = [
        [],
        [{ ...fresh, at: isoAt(now - 10 * 60_000) }],
        [{ ...fresh, at: isoAt(now + 60_000) }],
        [{ ...fresh, at: "not a timestamp" }],
        [{ ...fresh, problem: "The usage source could not be read" }],
        [{ ...fresh, account: null }],
        [fresh, fresh],
        [{ ...fresh, subscription: "claude", source: "claude-usage" }],
        [{ ...fresh, windows: [] }],
        [{ ...fresh, windows: [{ ...fresh.windows[0]!, model: "another-model" }] }],
        [{ ...fresh, windows: [{ ...fresh.windows[0]!, usedPercent: 100 }] }],
        [{ ...fresh, windows: [{ ...fresh.windows[0]!, reached: true }] }],
        [{ ...fresh, windows: [{ ...fresh.windows[0]!, resetsAt: reset }] }],
        [{ ...fresh, windows: [{ ...fresh.windows[0]!, resetsAt: isoAt(now + 4 * 86_400_000) }] }],
        [{ ...fresh, windows: [{ ...fresh.windows[0]!, resetsAt: null }] }],
        [{ ...fresh, windows: [{ ...fresh.windows[0]!, resetsAt: "not a timestamp" }] }],
        [
          {
            ...fresh,
            windows: [
              ...fresh.windows,
              { ...fresh.windows[0]!, kind: "session", usedPercent: 100, reached: true },
            ],
          },
        ],
      ];
      let readings: ReadonlyArray<UsageReading> = [];
      yield* session(
        Effect.gen(function* () {
          const agents = yield* Agents;
          for (const candidate of blocked) {
            readings = candidate;
            const chosen = yield* agents.choose([], { runId: "r1", operation: "review" }, [spent]);
            expect(chosen.why).toStartWith("nothing has room");
          }
          readings = [fresh];
          for (const unknownReset of [
            legacy,
            { ...legacy, resetsAt: null },
            { ...legacy, resetsAt: "not a timestamp" },
          ]) {
            const chosen = yield* agents.choose([], { runId: "r1", operation: "review" }, [
              { ...unknownReset, on },
            ]);
            expect(chosen.why).toStartWith("nothing has room");
          }
          for (const account of [null, "previous-account"]) {
            const chosen = yield* agents.choose([], { runId: "r1", operation: "review" }, [
              {
                ...spent,
                exhaustion: {
                  at: now - 60_000,
                  account,
                  windows: [{ kind: "weekly", model: null, resetsAt: reset }],
                },
              },
            ]);
            expect(chosen.why).toStartWith("nothing has room");
          }
          const observed = yield* agents.choose([], { runId: "r1", operation: "review" }, [
            { ...spent, observedAt: now - 60_000 },
          ]);
          expect(observed.why).toStartWith("nothing has room");
          const chosen = yield* agents.choose([], { runId: "r1", operation: "review" }, [spent]);
          expect(chosen.why).toBeUndefined();
          expect(chosen.harness).toBe("codex");
          expect(chosen.from).toBeUndefined();
        }),
        {
          harness: "codex",
          model: "default",
          fallbacks: Effect.succeed([]),
          readings: Effect.sync(() => readings),
        },
      );
      expect(harnessesStarted(yield* rig.calls())).toEqual([]);
    }),
  ));

test("a replayed legacy quota incident permits one successor and a new unreadable exhaustion blocks another across replay", () =>
  runEffect(
    Effect.gen(function* () {
      yield* rig.queueOutputs([null, null]);
      const now = yield* Clock.currentTimeMillis;
      const reset = isoAt(now + 5 * 86_400_000);
      const legacy: RanOut = {
        _tag: "RanOut",
        why: "weekly 100%, resets Wed 06:55",
        transcript: null,
        resetsAt: reset,
      };
      const fresh: UsageReading = {
        subscription: "chatgpt",
        account: "current-account",
        accountLabel: null,
        plan: "pro",
        windows: [
          {
            kind: "weekly",
            label: "Weekly",
            model: null,
            usedPercent: 24,
            resetsAt: isoAt(now + 6 * 86_400_000),
            reached: false,
          },
        ],
        at: isoAt(now),
        source: "codex-app-server",
        problem: null,
      };
      const onCodex = {
        harness: "codex",
        model: "default",
        fallbacks: Effect.succeed([]),
        collectMs: 3_600_000,
        // WARNING: each usage read is a minute of TestClock, and every poll inside it costs real time.
        pollMs: 2000,
      };
      yield* session(
        Effect.gen(function* () {
          yield* work.execute({ runId: "r1", input: { skip: false } }, { discard: true });
          yield* until(prompted("Your task for this step"));
          const agents = yield* Agents;
          const launched = yield* launchOf("r1");
          yield* agents.usageWaiting(launched, legacy);
          expect(yield* agents.usageIncident(launched)).toEqual(legacy);
          expect(harnessesStarted(yield* rig.calls())).toEqual(["codex"]);
        }),
        {
          ...onCodex,
          readings: Effect.succeed([
            { ...fresh, windows: [{ ...fresh.windows[0]!, resetsAt: reset }] },
          ]),
        },
      );

      const successor = agentName("r1", "review", null, 2);
      const unreadable: UsageReading = {
        ...fresh,
        problem: "The agent's usage source could not be read",
        windows: [{ ...fresh.windows[0]!, usedPercent: 100, reached: true, resetsAt: reset }],
      };
      let usageReads = 0;
      const recovering = {
        ...onCodex,
        collectMs: 2000,
        readings: Clock.currentTimeMillis.pipe(
          Effect.map((at) => {
            usageReads++;
            return [{ ...fresh, at: isoAt(at) }];
          }),
        ),
        ownReading: (agent: string) => Effect.succeed(agent === successor ? unreadable : null),
      };
      for (let replay = 0; replay < 2; replay++) {
        yield* session(
          Effect.gen(function* () {
            yield* work.execute({ runId: "r1", input: { skip: false } }, { discard: true });
            const parked = yield* until(parkedSays(`${successor} ran out`)).pipe(
              Effect.timeoutOption("2 minutes"),
            );
            expect({
              parked: Option.isSome(parked),
              launches: harnessesStarted(yield* rig.calls()),
              log: yield* read(`${dir}/agents/r1/agents.log`),
            }).toMatchObject({ parked: true, launches: ["codex", "codex"] });
            for (let poll = 0; poll < 2; poll++) {
              const before = usageReads;
              yield* TestClock.adjust("1 minute");
              yield* until(Effect.sync(() => usageReads > before));
            }
            expect(harnessesStarted(yield* rig.calls())).toEqual(["codex", "codex"]);
            expect(sent(yield* rig.calls(), "Your task for this step")).toBe(2);
            const launched = Option.getOrThrow(
              Arr.findFirst(yield* launchesAt(dir, "r1"), (one) => one.agent === successor),
            );
            const incident = yield* (yield* Agents).usageIncident(launched);
            expect(incident?.resetsAt).toBe(reset);
            expect(incident?.exhaustion).toBeUndefined();
            expect(incident?.observedAt).toBeGreaterThanOrEqual(now);
            expect(yield* parkedSays(`${successor} ran out`)).toBe(true);
          }),
          recovering,
        );
      }
      expect(closedPanes(yield* rig.calls())).toHaveLength(1);
    }),
  ));

test("a legacy spent subscription decodes without exhaustion metadata and recovers after its known elapsed reset", () =>
  runEffect(
    Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis;
      yield* session(
        Effect.gen(function* () {
          const agents = yield* Agents;
          for (const hasReset of [false, true]) {
            const legacy = {
              _tag: "RanOut" as const,
              why: "weekly limit reached",
              transcript: null,
            };
            const saved = hasReset ? { ...legacy, resetsAt: isoAt(now - 1) } : legacy;
            expect(flow(Schema.decodeUnknownResult(Collected), Result.getOrThrow)(saved)).toEqual(
              saved,
            );
            const chosen = yield* agents.choose([], { runId: "r1", operation: "review" }, [
              {
                ...saved,
                on: { harness: "codex", model: "default", effort: null },
              },
            ]);
            if (hasReset) {
              expect(chosen.why).toBeUndefined();
            } else {
              expect(chosen.why).toStartWith("nothing has room");
            }
          }
        }),
        {
          harness: "codex",
          model: "default",
          fallbacks: Effect.succeed([]),
          readings: Effect.succeed([]),
        },
      );
    }),
  ));

test("a restart after the agent that ran out is closed starts no third agent, and carries on with the new one", () =>
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
      expect(
        Arr.filter(harnessesStarted(yield* rig.calls()), (one) => one === "codex"),
      ).toHaveLength(1);
    }),
  ));

test("a restart after the new agent is launched collects from it rather than starting another", () =>
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
      expect(
        Arr.filter(harnessesStarted(yield* rig.calls()), (one) => one === "codex"),
      ).toHaveLength(2);
      expect(Arr.map(yield* agentsAt(dir, "r1"), ({ agent }) => agent)).toEqual([
        agentFor("r1"),
        agentName("r1", "review", null, 2),
      ]);
    }),
  ));

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
      Effect.map((both) => Arr.join(both, "+")),
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
        Effect.provide(
          handedOnBody.pipe(
            Layer.provideMerge(
              agentsLayer({
                ...hostOf(),
                ...chain,
                collectMs: 30_000,
              }),
            ),
            Layer.provideMerge(
              foundationLayer({
                dir,
              }),
            ),
          ),
        ),
        Effect.scoped,
        Effect.orDie,
      );
      expect(result._tag === "Success" && result.success).toBe("built+fixed");
      const calls = yield* rig.calls();
      expect(harnessesStarted(calls)).toEqual(["claude", "codex"]);
      const successor = agentName("r1", "implementer", null, 2);
      const fixedBy = Arr.filter(
        calls,
        (call) =>
          call.cmd === "terminal.send" &&
          call.params?.terminal === successor &&
          pipe(
            Option.getOrThrow(Schema.decodeUnknownOption(Schema.String)(call.params?.text)),
            Str.includes("fix.r2.prompt.md"),
          ),
      );
      expect(fixedBy).toHaveLength(1);
    }),
  ));

test("a collection an earlier build recorded, text or nothing, still decodes as it was", () => {
  expect(flow(Schema.decodeResult(Collected), Result.getOrThrow)("done")).toBe("done");
  expect(flow(Schema.decodeResult(Collected), Result.getOrThrow)(null)).toBeNull();
});

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
      Effect.map((both) => Arr.join(both, "+")),
      Effect.provideService(Run, run),
    );
  }),
);

test("an agent is not handed work that asks for a different one than it is", () =>
  runEffect(
    Effect.gen(function* () {
      yield* rig.queueOutputs(["built", "fixed"]);
      const result = yield* shared.execute({ runId: "r1", input: {} }).pipe(
        Effect.result,
        Effect.provide(
          sharedBody.pipe(
            Layer.provideMerge(agentsLayer(hostOf())),
            Layer.provideMerge(
              foundationLayer({
                dir,
              }),
            ),
          ),
        ),
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
      yield* (yield* FileSystem.FileSystem).makeDirectory(runDir(dir, "r1"), { recursive: true });
      // oxlint-disable-next-line effecttsgo/any-unknown-in-error-context -- Loaded workflows erase the author-declared error schema; this test inspects the captured result.
      yield* workflow.execute({ runId: "r1", input: {} }).pipe(
        Effect.provide(
          layer.pipe(
            Layer.provideMerge(
              Layer.succeed(Children)(
                Children.of({
                  start: () => none,
                  result: () => none,
                }),
              ),
            ),
            Layer.provideMerge(agentsLayer(hostOf())),
            Layer.provideMerge(
              foundationLayer({
                dir,
              }),
            ),
          ),
        ),
        Effect.scoped,
        Effect.orDie,
      );
      const models = Arr.map(everyLaunch(yield* rig.calls()), (args) => args[2]);
      expect([...models].sort((a, b) => pipe(a ?? "", Str.localeCompare(b ?? "")))).toEqual([
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
      yield* (yield* FileSystem.FileSystem).makeDirectory(runDir(dir, "r1"), { recursive: true });
      // oxlint-disable-next-line effecttsgo/any-unknown-in-error-context -- Loaded workflows erase the author-declared error schema; this test inspects the captured result.
      yield* workflow.execute({ runId: "r1", input: {} }).pipe(
        Effect.provide(
          layer.pipe(
            Layer.provideMerge(
              Layer.succeed(Children)(
                Children.of({
                  start: () => none,
                  result: () => none,
                }),
              ),
            ),
            Layer.provideMerge(agentsLayer(hostOf())),
            Layer.provideMerge(
              foundationLayer({
                dir,
              }),
            ),
          ),
        ),
        Effect.scoped,
        Effect.orDie,
      );
      const chosen = Arr.map(everyLaunch(yield* rig.calls()), (args) => {
        const effort = args.indexOf("--effort");
        return `${args[2]}${effort === -1 ? "" : `/${args[effort + 1]}`}`;
      });
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
      yield* (yield* FileSystem.FileSystem).makeDirectory(runDir(dir, "r1"), { recursive: true });
      // oxlint-disable-next-line effecttsgo/any-unknown-in-error-context -- Loaded workflows erase the author-declared error schema; this test inspects the captured result.
      yield* workflow.execute({ runId: "r1", input: {} }).pipe(
        Effect.provide(
          layer.pipe(
            Layer.provideMerge(
              Layer.succeed(Children)(
                Children.of({
                  start: () => none,
                  result: () => none,
                }),
              ),
            ),
            Layer.provideMerge(agentsLayer(hostOf())),
            Layer.provideMerge(
              foundationLayer({
                dir,
              }),
            ),
          ),
        ),
        Effect.scoped,
        Effect.orDie,
      );
      const chosen = Rec.fromEntries(
        Arr.map(everyLaunch(yield* rig.calls()), (args) => {
          const persona = args[args.indexOf("--append-system-prompt-file") + 1] ?? "";
          const effort = args.indexOf("--effort");
          const operation = pipe(
            persona,
            Str.slice(
              Option.getOrElse(pipe(persona, Str.lastIndexOf("/")), () => -1) + 1,
              -".persona.md".length,
            ),
          );
          return [operation, `${args[2]}${effort === -1 ? "" : `/${args[effort + 1]}`}`];
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
        const args = launchArgs(yield* rig.calls());
        expect(args.slice(0, 2)).toEqual(["--model", "opus"]);
        expect(args[args.indexOf("--settings") + 1]).toEndWith("/settings.json");
      }),
    ),
  60_000,
);

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

      const windows = Arr.map(everyLaunch(yield* rig.calls()), windowOf);
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
      const asked: Array<string> = [];
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
      const why = yield* controlOf(PARKED, "r1");
      expect(why).toContain("claude_auto_compact_window");
      expect(why).toContain("50000");
      const cmds = yield* rig.cmds();
      expect(cmds).not.toContain("terminal.run");
    }),
  ));

const settled = (runId: string) =>
  Effect.gen(function* () {
    const engine = yield* WorkflowEngine.WorkflowEngine;
    const id = yield* work.executionId({ runId, input: { skip: false } });
    const { status } = pollStatus(yield* engine.poll(work, id), "agent-work");
    return status === "suspended" || status === "failed";
  });

const parkedOn = (herdr: Herdr) =>
  Effect.gen(function* () {
    yield* interrupted("r1", settled("r1"), { herdr });
    expect(yield* statusNow("r1")).toBe("suspended");
    return yield* controlOf(PARKED, "r1");
  });

test("a start core refused parks, saying what core said", () =>
  runEffect(
    Effect.gen(function* () {
      const why = yield* parkedOn(new Refusing({ "terminal.run": "claude exited: no API key" }));
      expect(why).toContain("claude exited: no API key");
      expect(why).toContain(promptPath("r1"));
    }),
  ));

test("a core that cannot say what it has parks the work rather than starting an agent", () =>
  runEffect(
    Effect.gen(function* () {
      const why = yield* parkedOn(new Refusing({ "terminal.list": "core is not answering" }));
      expect(why).toContain("core cannot say which agents it has");
      expect(why).toContain("core is not answering");
      expect(yield* controlOf(PARK_CAUSE, "r1")).toBe("herdr-unavailable");
      expect(why).toContain("Nothing here says the agent did no work.");
      expect(Arr.filter(yield* rig.cmds(), (cmd) => cmd === "terminal.run")).toHaveLength(0);
    }),
  ));

test("a step whose work was never sent parks, naming the file its work is in", () =>
  runEffect(
    Effect.gen(function* () {
      const why = yield* parkedOn(new Refusing({ "terminal.send": "core lost the connection" }));
      expect(why).toContain("was not given its work");
      expect(why).toContain("core lost the connection");
      expect(why).toContain(promptPath("r1"));
      expect(Arr.filter(yield* rig.cmds(), (cmd) => cmd === "terminal.run")).toHaveLength(1);
    }),
  ));

const halted = (runId: string) => Agents.pipe(Effect.flatMap((agents) => agents.halt(runId)));

test("a stop closes the agent this Run launched, and says what it could not close", () =>
  runEffect(
    Effect.gen(function* () {
      yield* rig.queueOutputs([{ verdict: "clean", note: "done" }]);
      yield* session(started("r1"));
      const refused = yield* session(halted("r1"), {
        herdr: new Refusing({ "terminal.kill": "pane is busy" }),
      });
      expect(refused.stopped).toEqual([]);
      expect(Arr.join(refused.left, "\n")).toContain(agentFor("r1"));
      expect(yield* session(halted("r1"))).toEqual({ stopped: [agentFor("r1")], left: [] });
    }),
  ));

test("a stop leaves another process that took the Run's agent name", () =>
  runEffect(
    Effect.gen(function* () {
      yield* rig.queueOutputs([{ verdict: "clean", note: "done" }]);
      yield* session(started("r1"));
      yield* rig.dropAgent(agentFor("r1"));
      yield* rig.addAgent(agentFor("r1"));
      expect(yield* session(halted("r1"))).toEqual({ stopped: [], left: [] });
      expect(yield* rig.cmds()).not.toContain("terminal.kill");
    }),
  ));

test("a stop of a Run that launched no agent needs nothing from core", () =>
  runEffect(
    Effect.gen(function* () {
      const halt = yield* session(halted("r1"), { herdr: coreGone() });
      expect(halt).toEqual({ stopped: [], left: [] });
      expect(yield* rig.cmds()).not.toContain("terminal.list");
    }),
  ));

const liveImplementer = Effect.gen(function* () {
  const at = yield* rig.addAgent("impl-live", rig.projectDir, { run: "r-building" });
  yield* registerAgent(scopeFor(rig.projectDir), {
    role: "implementer",
    agent: "impl-live",
    paneId: at,
    workspaceId: null,
    runId: "r-building",
    workflow: "implement",
    at: "2026-09-23T10:00:00Z",
    incarnation: { terminalId: at, agentSession: null, backend: "core" },
  }).pipe(Effect.provide(recordsAt(dir)));
});

class SilentPrompts extends Herdr {
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

      const [held] = yield* deliveredTo(dir, "r-building");
      const settled = reconcile(
        yield* ledgerOf(dir, held!.incarnation),
        held!.id,
        "sent",
        "tester",
        "2026-09-23T10:01:00Z",
      );
      if ("error" in settled) {
        throw new Error(settled.error);
      }
      yield* appendLine(settled).pipe(Effect.provide(recordsAt(dir)));
      const after = yield* session(handedOff);
      expect(after._tag === "Success" && after.success).toMatchObject({
        agent: "impl-live",
        delivered: true,
      });
      expect(sent(yield* rig.calls(), "the review is ready")).toBe(0);
    }),
  ));

const liveIn = Effect.fn("test.liveIn")(function* (runId: string, role: string, agent: string) {
  const at = yield* rig.addAgent(agent, rig.projectDir, { run: runId });
  yield* registerAgent(scopeFor(rig.projectDir), {
    role,
    agent,
    paneId: at,
    workspaceId: null,
    runId,
    workflow: "plan",
    at: "2026-09-30T10:00:00Z",
    incarnation: { terminalId: at, agentSession: null, backend: "core" },
  }).pipe(Effect.provide(recordsAt(dir)));
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
      yield* liveIn("r-plan", "planner", "plan-grill");
      yield* liveIn("r-plan.implement", "implementer", "plan-build");
      yield* liveIn("r-other", "planner", "other-grill");
      yield* liveIn("r-other.implement", "implementer", "other-build");
      const kept = yield* registeredAt(dir);
      expect(Arr.map(kept, (entry) => entry.agent)).toEqual([
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
      const scope = scopeFor(rig.projectDir);
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
      yield* registerAgent(scope, seat("old-review", "r-done", "2026-09-30T09:00:00.000Z"));
      const listed = { agents: [], listedAt: "2026-09-30T10:00:00.000Z" };
      yield* registerAgent(scope, seat("seat-1", "r-panel", "2026-09-30T10:00:05.000Z"), listed);
      yield* registerAgent(scope, seat("seat-2", "r-panel", "2026-09-30T10:00:06.000Z"), listed);
      expect(Arr.map(yield* everyRegistered, (entry) => entry.agent)).toEqual(["seat-1", "seat-2"]);
    }).pipe(Effect.provide(recordsAt(dir))),
  ));

test("a lineage lookup leaves every register as it found it, and registrations at once all land", () =>
  runEffect(
    Effect.gen(function* () {
      const scope = scopeFor(rig.projectDir);
      const elsewhere = { ...scope, session: `${rig.root}/other-herd.sock` };
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
      const seats = Array.from({ length: 10 }, (_, at) => `seat-${at}`);
      yield* Effect.all(
        Arr.map(seats, (agent) => registerAgent(scope, seat(agent))),
        { concurrency: "unbounded" },
      );
      yield* registerAgent(elsewhere, seat("another-herds"));
      const agents = Effect.map(everyRegistered, (all) => Arr.map(all, (entry) => entry.agent));
      expect((yield* agents).sort()).toEqual([...seats, "another-herds"].sort());

      expect(yield* lineageAgent([], "reviewer", ["r-panel"])).toBeNull();
      expect(yield* agents).toHaveLength(11);
    }).pipe(Effect.provide(recordsAt(dir))),
  ));

const stoppedOnce = (runId: string, about: string) => {
  let stopped = false;
  return Effect.gen(function* () {
    if (!stopped) {
      if (!(yield* prompted(about))) {
        return false;
      }
      yield* TestClock.withLive(Effect.sleep("100 millis"));
      yield* control("stop", runId, true);
      stopped = true;
    }
    return yield* suspended(runId);
  });
};

const controls = hostRunRecords(() => dir);

const control = (name: string, runId: string, set: boolean) =>
  Effect.flatMap(nowIso, (at) => controls.setControl(name, runId, set ? at : null));

// WARNING: read as the door reads: opening the database to migrate it would contend with the host it watches.
const controlRead = (name: string, runId: string) =>
  hostRecords(
    dir,
    RunRecords.use((records) => records.control(name, runId)),
  ).pipe(Effect.orElseSucceed(() => null));

const controlOf = (name: string, runId: string) =>
  controlRead(name, runId).pipe(Effect.map((data) => data ?? ""));

const isSet = (name: string, runId: string) =>
  controlRead(name, runId).pipe(Effect.map((data) => data !== null));

const prompts = (calls: ReadonlyArray<Call>) =>
  Arr.map(sentTexts(calls), Str.replace(/^collie-delivery:\S+\n/, ""));

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
      expect(Arr.map(told, (one) => one.agent)).toEqual([
        agentFor("r1"),
        agentFor("r1"),
        agentFor("r1"),
      ]);
      expect(Arr.every(told, (one) => one.delivered)).toBe(true);

      const said = Arr.filter(prompts(yield* rig.calls()), (text) =>
        pipe(text, Str.endsWith(" thing")),
      );
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
      expect(Arr.filter(prompts(yield* rig.calls()), (text) => text === "again")).toHaveLength(1);
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

test("an idle Codex takes a now message through the supported boundary transport", () =>
  runEffect(
    Effect.gen(function* () {
      yield* rig.queueOutputs([{ verdict: "clean", note: "done" }]);
      const codex = { harness: "codex", model: "default" };
      yield* session(started("r1"), codex);
      const told = yield* session(say("r1", "stop what you are doing", "steer-now", "now"), codex);
      expect(told).toMatchObject({ delivered: true, observed: true });
      expect(prompts(yield* rig.calls())).toContain("stop what you are doing");
    }),
  ));

test("an unsupported busy delivery survives restart and reaches the idle agent once", () =>
  runEffect(
    Effect.gen(function* () {
      yield* rig.queueOutputs([{ verdict: "clean", note: "done" }]);
      const codex = { harness: "codex", model: "default" };
      yield* session(started("r1"), codex);
      const busy = new Statuses(["working"]);
      const text = "Revise the plan.\n  Keep my exact words.  ";
      for (let attempt = 0; attempt < 2; attempt++) {
        const queued = yield* session(say("r1", text, "queued-1", "now"), {
          ...codex,
          herdr: busy,
        });
        expect(queued).toMatchObject({ delivered: false, queued: true });
      }
      expect(prompts(yield* rig.calls())).not.toContain(text);
      yield* session(tendIdle);
      yield* session(tendIdle);
      expect(Arr.filter(prompts(yield* rig.calls()), (one) => one === text)).toHaveLength(1);
      const sent = Arr.filter(yield* deliveredTo(dir, "r1"), (one) => one.cause.kind === "steer");
      expect(sent).toHaveLength(1);
      expect(sent[0]).toMatchObject({ mode: "boundary", state: "acknowledged" });
    }),
  ));

const tendIdle = Agents.pipe(
  Effect.flatMap((agents) =>
    agents.tendQuestions(
      () => ({
        ask: () => Effect.void,
        asked: Effect.succeed([]),
        close: () => Effect.void,
      }),
      () => Effect.succeed(new Map()),
    ),
  ),
);

const collieCheckRunning = (ends: "exits" | "crashes") =>
  Effect.gen(function* () {
    const go = `${rig.root}/go`;
    yield* updateApproved(evidenceDir(dir, "r1"), () => [
      {
        name: "unit",
        executable: "sh",
        argv: [
          "-c",
          `while [ ! -f '${go}' ]; do sleep 0.05; done; ${ends === "crashes" ? "kill -KILL $$" : "true"}`,
        ],
        cwd: ".",
      },
    ]).pipe(Effect.provide(recordsAt(dir)));
    const store = yield* Store;
    if ((yield* store.run("r1")) === null) {
      yield* store.admit({
        request: "req-r1",
        run: "r1",
        workflow: "proof",
        project: rig.projectDir,
        input: {},
        provenance: {},
        options: {},
        generation: "proof@1",
        execution: "execution-r1",
        task: null,
        parent: null,
      });
    }
    const check = yield* Effect.forkChild(
      Host.pipe(
        Effect.flatMap((host) =>
          host.verify({ runId: "r1", name: "unit", cwd: rig.projectDir, pass: "gate" }),
        ),
        Effect.result,
      ),
    );
    yield* until(Effect.map(controlRead(VERIFYING, "r1"), (marker) => marker !== null));
    return { check, end: (yield* FileSystem.FileSystem).writeFileString(go, "") };
  });

test.each(["exits", "crashes"] as const)(
  "a message to an agent while Collie's Check collects proof on its checkout is held behind it, and sent once the Check %s",
  (ends) =>
    runEffect(
      Effect.gen(function* () {
        yield* rig.queueOutputs([{ verdict: "clean", note: "done" }]);
        yield* session(started("r1"));
        yield* session(
          Effect.gen(function* () {
            const running = yield* collieCheckRunning(ends);
            const held = yield* say("r1", "stay in src", "steer-held");
            expect(held).toMatchObject({ delivered: false, queued: true });
            expect(held.detail).toContain('Held behind the Check "unit"');
            expect(held.detail).toContain("until it ends");
            yield* tendIdle;
            expect(prompts(yield* rig.calls())).not.toContain("stay in src");
            yield* running.end;
            const checked = yield* Fiber.join(running.check);
            expect(checked._tag).toBe(ends === "exits" ? "Success" : "Failure");
            expect(yield* controlRead(VERIFYING, "r1")).toBeNull();
            yield* tendIdle;
          }),
        );
        expect(
          Arr.filter(prompts(yield* rig.calls()), (one) => one === "stay in src"),
        ).toHaveLength(1);
      }),
    ),
);

test("Collie's own step to an agent waits while Collie's Check collects proof on its checkout", () =>
  runEffect(
    Effect.gen(function* () {
      yield* rig.queueOutputs([{ verdict: "clean", note: "done" }]);
      yield* controls.setControl(
        VERIFYING,
        "r1",
        encodeVerifying({
          name: "unit",
          executable: "true",
          argv: [],
          pass: "gate",
          round: null,
          revision: "",
          base: null,
          started: "2026-11-17T10:00:00.000Z",
          checkout: rig.projectDir,
        }),
      );
      const step = yield* Effect.forkChild(session(started("r1")));
      yield* until(
        Effect.map(
          read(`${dir}/agents/r1/agents.log`),
          Str.includes('held behind the Check "unit"'),
        ),
      );
      yield* TestClock.withLive(Effect.sleep("300 millis"));
      expect(sentTexts(yield* rig.calls())).toEqual([]);
      yield* controls.setControl(VERIFYING, "r1", null);
      const result = yield* Fiber.join(step);
      expect(result._tag === "Success" && result.success.note).toBe("done");
    }),
  ));

test("an answer to an agent's question waits while Collie's Check collects proof on its checkout", () =>
  runEffect(
    Effect.gen(function* () {
      yield* rig.queueOutputs([{ writes: [], output: null, owed: true }]);
      yield* session(
        Effect.gen(function* () {
          yield* work.execute({ runId: "r1", input: { skip: false } }, { discard: true });
          yield* asksTwo;
          yield* questionsOf(2);
          yield* controls.setControl(
            VERIFYING,
            "r1",
            encodeVerifying({
              name: "unit",
              executable: "true",
              argv: [],
              pass: "gate",
              round: null,
              revision: "",
              base: null,
              started: "2026-11-17T10:00:00.000Z",
              checkout: rig.projectDir,
            }),
          );
          yield* answer("ask-review-1", "SQLite");
          yield* answer("ask-review-2", "lint");
          yield* TestClock.withLive(Effect.sleep("3 seconds"));
          expect(yield* prompted("are answered")).toBe(false);
          yield* controls.setControl(VERIFYING, "r1", null);
          while (!(yield* prompted("are answered"))) {
            yield* TestClock.withLive(Effect.sleep("10 millis"));
          }
        }),
        { collectMs: 120_000, pollMs: 200 },
      );
    }),
  ));

test.each([true, false])(
  "a queued retry keeps its accepted words and actor (attributed: %s)",
  (attributed) =>
    runEffect(
      Effect.gen(function* () {
        yield* rig.queueOutputs([{ verdict: "clean", note: "done" }]);
        yield* session(started("r1"), { harness: "codex", model: "default" });
        const text = "  Original accepted comment. Attached: /given/original.png  ";
        const request = "accepted-comment";
        const queued = yield* session(
          Agents.pipe(
            Effect.flatMap((agents) =>
              agents.steer({
                runId: "r1",
                text,
                request,
                mode: "now",
                actor: attributed ? { origin: "desktop" } : undefined,
              }),
            ),
          ),
          { herdr: new Statuses(["working"]) },
        );
        expect(queued).toMatchObject({ delivered: false, queued: true });
        const retry = Agents.pipe(
          Effect.flatMap((agents) =>
            agents.steer({
              runId: "r1",
              text: "Replacement text. Attached: /given/replacement.png",
              request,
              mode: "now",
              actor: { origin: "cli" },
            }),
          ),
        );
        const sent = yield* session(retry);
        expect(sent).toMatchObject({ delivered: true, observed: true });
        const again = yield* session(retry);
        expect(again).toEqual(sent);
        yield* session(tendIdle);
        const comments = Arr.filter(prompts(yield* rig.calls()), (one) =>
          pipe(one, Str.includes("Attached:")),
        );
        expect(comments).toHaveLength(1);
        expect(
          Option.getOrUndefined(
            Option.map(Option.fromNullishOr(comments[0]), (comment) =>
              pipe(comment, Str.endsWith(text)),
            ),
          ),
        ).toBe(true);
        expect(comments[0]).not.toContain("Replacement");
        expect(comments[0]).not.toContain("From the human, in the CLI");
        if (attributed) {
          expect(comments[0]).toContain("From the human, in Desktop");
        } else {
          expect(comments[0]).toBe(text);
        }
      }),
    ),
);

test("a queued retry keeps its accepted recipient even when the retry names a missing agent", () =>
  runEffect(
    Effect.gen(function* () {
      yield* rig.queueOutputs([{ verdict: "clean", note: "done" }]);
      yield* session(started("r1"), { harness: "codex", model: "default" });
      const queued = yield* session(
        say("r1", "Keep this recipient.", "accepted-recipient", "now"),
        {
          herdr: new Statuses(["working"]),
        },
      );
      expect(queued).toMatchObject({ delivered: false, queued: true });
      const retry = Agents.pipe(
        Effect.flatMap((agents) =>
          agents.steer({
            runId: "r1",
            text: "Keep this recipient.",
            request: "accepted-recipient",
            mode: "now",
            agent: "not-launched",
          }),
        ),
      );
      const sent = yield* session(retry);
      expect(sent).toMatchObject({ agent: agentFor("r1"), delivered: true, observed: true });
      expect(yield* session(retry)).toEqual(sent);
      expect(
        Arr.filter(prompts(yield* rig.calls()), (one) => one === "Keep this recipient."),
      ).toHaveLength(1);
    }),
  ));

test.each([
  ["agent", false],
  ["agent", true],
  ["to", false],
  ["to", true],
  ["operation", false],
  ["operation", true],
] as const)("a queued %s address pins its named agent (alias: %s)", (field, alias) =>
  runEffect(
    Effect.gen(function* () {
      yield* rig.queueOutputs([null, null]);
      const ask = {
        runId: "r1",
        operation: "plan",
        role: "planner",
        workflow: "plan",
        harness: "codex",
        agent: "plan-seat",
        model: null,
        effort: null,
        permissions: null,
        task: null,
        cwd: rig.projectDir,
        prompt: "Write the plan.",
        output: `${dir}/plan.json`,
        skill: null,
      };
      const first = yield* session(Agents.pipe(Effect.flatMap((agents) => agents.launch(ask))));
      const queued = yield* session(
        Agents.pipe(
          Effect.flatMap((agents) =>
            agents.steer({
              runId: "r1",
              [field]: alias ? "plan-seat" : first.agent,
              text: "Only the named planner should revise this.",
              request: "pinned-comment",
              mode: "now",
            }),
          ),
        ),
        { herdr: new Statuses(["working"]) },
      );
      expect(queued).toMatchObject({ delivered: false, queued: true });
      const next = yield* session(
        Agents.pipe(Effect.flatMap((agents) => agents.launch({ ...ask, sequence: 2 }))),
      );
      expect(next.agent).not.toBe(first.agent);
      yield* until(
        new Herdr(rig.pluginEnv())
          .agentStatus(first.agent)
          .pipe(Effect.map((status) => status === "idle")),
      );
      yield* session(tendIdle);
      yield* session(tendIdle);
      const comments = Arr.filter(
        yield* rig.calls(),
        (call) =>
          call.cmd === "terminal.send" &&
          pipe(
            Option.getOrThrow(Schema.decodeUnknownOption(Schema.String)(call.params?.text)),
            Str.includes("Only the named planner"),
          ),
      );
      expect(Arr.map(comments, (call) => call.params?.terminal)).toEqual([first.agent]);
    }),
  ),
);

test("a queued operation follows a harness switch and preserves its long comment and attachment", () =>
  runEffect(
    Effect.gen(function* () {
      yield* rig.queueOutputs([{ verdict: "clean", note: "done" }, null]);
      yield* session(started("r1"), { harness: "pi", model: "default" });
      const first = yield* launchOf("r1");
      const text = `${Str.repeat(5000)("é")}\n  exact comment  \nAttached: /given/screenshot.png`;
      yield* session(
        Agents.pipe(
          Effect.flatMap((agents) =>
            agents.steer({
              runId: "r1",
              to: "reviewer",
              text,
              request: "switch-comment",
              mode: "now",
              actor: { origin: "desktop" },
            }),
          ),
        ),
        { herdr: new Statuses(["working"]) },
      );
      const next = yield* session(
        Effect.gen(function* () {
          const agents = yield* Agents;
          yield* agents.halt("r1");
          return yield* agents.launch({
            ...first,
            sequence: 2,
            harness: "codex",
            agent: null,
            model: null,
            effort: null,
            permissions: null,
            task: null,
            cwd: rig.projectDir,
            prompt: "Continue the same work.",
            skill: null,
          });
        }),
      );
      yield* until(
        new Herdr(rig.pluginEnv())
          .agentStatus(next.agent)
          .pipe(Effect.map((status) => status === "idle")),
      );
      yield* session(tendIdle);
      yield* session(tendIdle);
      const calls = Arr.filter(
        yield* rig.calls(),
        (call) =>
          call.cmd === "terminal.send" &&
          call.params?.terminal === next.agent &&
          pipe(
            Option.getOrThrow(Schema.decodeUnknownOption(Schema.String)(call.params?.text)),
            Str.includes("Their message is in"),
          ),
      );
      expect(calls).toHaveLength(1);
      const typed = Option.getOrThrow(
        Schema.decodeUnknownOption(Schema.String)(calls[0]?.params?.text),
      );
      expect(typed).toContain("From the human, in Desktop");
      const file = /Their message is in (\S+)\./.exec(typed)?.[1];
      expect(file).toBeDefined();
      expect(yield* read(file!)).toBe(text);
      expect(next.agent).not.toBe(first.agent);
    }),
  ));

test("an uncertain queued submission is retained and never automatically repeated", () =>
  runEffect(
    Effect.gen(function* () {
      yield* rig.queueOutputs([{ verdict: "clean", note: "done" }]);
      const codex = { harness: "codex", model: "default" };
      yield* session(started("r1"), codex);
      yield* session(say("r1", "keep this once", "uncertain-queue", "now"), {
        ...codex,
        herdr: new Statuses(["working"]),
      });
      yield* session(tendIdle, { herdr: new SilentPrompts(rig.pluginEnv()) });
      yield* session(tendIdle);
      const again = yield* session(say("r1", "keep this once", "uncertain-queue", "now"));
      expect(again.delivered).toBe(false);
      expect(again.detail).toContain("unknown");
      expect(prompts(yield* rig.calls())).not.toContain("keep this once");
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

const implementerAsk = () => ({
  runId: "r1",
  operation: "build",
  role: "implementer",
  workflow: "implement",
  harness: "codex",
  agent: null,
  model: null,
  effort: null,
  permissions: null,
  task: null,
  cwd: rig.projectDir,
  prompt: "Build it.",
  output: `${dir}/build.json`,
  skill: null,
});

test("a Delivery addressed to a role a launch recorded reaches that agent", () =>
  runEffect(
    Effect.gen(function* () {
      yield* rig.queueOutputs([null]);
      const launched = yield* session(
        Agents.pipe(Effect.flatMap((agents) => agents.launch(implementerAsk()))),
      );
      const told = yield* session(
        Agents.pipe(
          Effect.flatMap((agents) =>
            agents.steer({
              runId: "r1",
              to: "implementer",
              text: "Take this too",
              request: "to-role-1",
            }),
          ),
        ),
      );
      expect(told).toMatchObject({ agent: launched.agent, delivered: true });
      expect(sent(yield* rig.calls(), "Take this too")).toBe(1);
    }),
  ));

test("a role no live agent of the Run has is refused, naming the live agents and their roles", () =>
  runEffect(
    Effect.gen(function* () {
      yield* rig.queueOutputs([null]);
      const launched = yield* session(
        Agents.pipe(Effect.flatMap((agents) => agents.launch(implementerAsk()))),
      );
      const refused = yield* session(
        Agents.pipe(
          Effect.flatMap((agents) =>
            agents.steer({
              runId: "r1",
              to: "healer",
              text: "Look at this",
              request: "to-healer-1",
            }),
          ),
        ),
      );
      expect(refused).toMatchObject({ agent: "", delivered: false, gone: false });
      expect(refused.detail).toContain(launched.agent);
      expect(refused.detail).toContain("implementer");
      expect(sent(yield* rig.calls(), "Look at this")).toBe(0);
    }),
  ));

test("a role reaches the live agent of it, not the exited one launched later", () =>
  runEffect(
    Effect.gen(function* () {
      yield* rig.queueOutputs([null, null]);
      const older = yield* session(
        Agents.pipe(Effect.flatMap((agents) => agents.launch(implementerAsk()))),
      );
      const later = yield* session(
        Agents.pipe(
          Effect.flatMap((agents) =>
            agents.launch({
              ...implementerAsk(),
              operation: "fix",
              output: `${dir}/fix.json`,
            }),
          ),
        ),
      );
      yield* core.exit(later.agent, 0);
      const reached = yield* session(
        Agents.pipe(
          Effect.flatMap((agents) =>
            agents.steer({
              runId: "r1",
              to: "implementer",
              text: "Look at this",
              request: "to-live-implementer",
            }),
          ),
        ),
      );
      expect(reached).toMatchObject({ agent: older.agent, delivered: true });
      expect(sent(yield* rig.calls(), "Look at this")).toBe(1);
    }),
  ));

test("a send that failed reads liveness again, so a Run whose agents all exited is gone", () =>
  runEffect(
    Effect.gen(function* () {
      yield* rig.queueOutputs([null, null]);
      const leaving = yield* session(
        Agents.pipe(Effect.flatMap((agents) => agents.launch(implementerAsk()))),
      );
      const reviewer = yield* session(
        Agents.pipe(
          Effect.flatMap((agents) =>
            agents.launch({ ...implementerAsk(), operation: "review", role: "reviewer" }),
          ),
        ),
      );
      const release = core.hold("terminal.send");
      const steering = yield* Effect.forkChild(
        session(
          Agents.pipe(
            Effect.flatMap((agents) =>
              agents.steer({
                runId: "r1",
                to: "implementer",
                text: "Look at this",
                request: "to-leaving-implementer",
              }),
            ),
          ),
        ),
      );
      yield* until(prompted("Look at this"));
      yield* core.exit(leaving.agent, 0);
      yield* core.exit(reviewer.agent, 0);
      core.refuse("terminal.send", "unreachable", "the core did not answer");
      release();
      const failed = yield* Fiber.join(steering);
      expect(failed).toMatchObject({ agent: leaving.agent, delivered: false, gone: true });
      expect(failed.detail).not.toContain("live:");
      core.restore("terminal.send");
    }),
  ));

test("a send that failed, whose fresh roster read failed too, reports unread liveness", () =>
  runEffect(
    Effect.gen(function* () {
      yield* rig.queueOutputs([null]);
      const launched = yield* session(
        Agents.pipe(Effect.flatMap((agents) => agents.launch(implementerAsk()))),
      );
      const release = core.hold("terminal.send");
      const steering = yield* Effect.forkChild(
        session(
          Agents.pipe(
            Effect.flatMap((agents) =>
              agents.steer({
                runId: "r1",
                to: "implementer",
                text: "Look at this",
                request: "to-unread-implementer",
              }),
            ),
          ),
        ),
      );
      yield* until(prompted("Look at this"));
      core.refuse("terminal.send", "unreachable", "the core did not answer");
      core.refuse("terminal.list", "unavailable", "core is restarting");
      release();
      const failed = yield* Fiber.join(steering);
      expect(failed).toMatchObject({ agent: launched.agent, delivered: false, gone: false });
      expect(failed.detail).toContain("could not be read");
      expect(failed.detail).not.toContain("is gone");
      core.restore("terminal.send");
      core.restore("terminal.list");
    }),
  ));

test("a roster read that failed inside the entry lookup does not report the live agent gone", () =>
  runEffect(
    Effect.gen(function* () {
      yield* rig.queueOutputs([null]);
      const launched = yield* session(
        Agents.pipe(Effect.flatMap((agents) => agents.launch(implementerAsk()))),
      );
      core.refuseOnce("terminal.list", "unavailable", "core is restarting", 1);
      const refused = yield* session(
        Agents.pipe(
          Effect.flatMap((agents) =>
            agents.steer({
              runId: "r1",
              to: "implementer",
              text: "Look at this",
              request: "to-live-implementer-again",
              mode: "now",
            }),
          ),
        ),
      );
      expect(refused).toMatchObject({ agent: launched.agent, delivered: false, gone: false });
      expect(refused.detail).toContain("could not be read");
      expect(refused.detail).not.toContain("is gone");
    }),
  ));

test("a roster read that failed twice reports unread liveness, not the live agent gone", () =>
  runEffect(
    Effect.gen(function* () {
      yield* rig.queueOutputs([null]);
      const launched = yield* session(
        Agents.pipe(Effect.flatMap((agents) => agents.launch(implementerAsk()))),
      );
      core.refuseOnce("terminal.list", "unavailable", "core is restarting", 1, 2);
      const refused = yield* session(
        Agents.pipe(
          Effect.flatMap((agents) =>
            agents.steer({
              runId: "r1",
              to: "implementer",
              text: "Look at this",
              request: "to-live-implementer-yet-again",
              mode: "now",
            }),
          ),
        ),
      );
      expect(refused).toMatchObject({ agent: launched.agent, delivered: false, gone: false });
      expect(refused.detail).toContain("could not be read");
      expect(refused.detail).not.toContain("is gone");
    }),
  ));

test("a role whose only terminal has exited is refused, naming the agent that is live", () =>
  runEffect(
    Effect.gen(function* () {
      yield* rig.queueOutputs([null, null]);
      const launched = yield* session(
        Agents.pipe(Effect.flatMap((agents) => agents.launch(implementerAsk()))),
      );
      yield* session(
        Agents.pipe(
          Effect.flatMap((agents) =>
            agents.launch({ ...implementerAsk(), operation: "review", role: "reviewer" }),
          ),
        ),
      );
      yield* core.exit(launched.agent, 0);
      const refused = yield* session(
        Agents.pipe(
          Effect.flatMap((agents) =>
            agents.steer({
              runId: "r1",
              to: "implementer",
              text: "Look at this",
              request: "to-dead-implementer",
            }),
          ),
        ),
      );
      expect(refused).toMatchObject({ agent: "", delivered: false, gone: false });
      expect(refused.detail).toContain("no live agent");
      expect(refused.detail).toContain("reviewer");
      expect(sent(yield* rig.calls(), "Look at this")).toBe(0);
    }),
  ));

test("a send that failed names the agents of the Run that are still live", () =>
  runEffect(
    Effect.gen(function* () {
      yield* rig.queueOutputs([null, null]);
      yield* session(Agents.pipe(Effect.flatMap((agents) => agents.launch(implementerAsk()))));
      yield* session(
        Agents.pipe(
          Effect.flatMap((agents) =>
            agents.launch({ ...implementerAsk(), operation: "review", role: "reviewer" }),
          ),
        ),
      );
      const failed = yield* session(
        Agents.pipe(
          Effect.flatMap((agents) =>
            agents.steer({
              runId: "r1",
              to: "implementer",
              text: "Look at this",
              request: "to-busy-implementer",
            }),
          ),
        ),
        { herdr: new Refusing({ "terminal.send": "blocked" }) },
      );
      expect(failed).toMatchObject({ delivered: false, gone: false });
      expect(failed.detail).toContain("live:");
      expect(failed.detail).toContain("reviewer");
    }),
  ));

test("a listing that failed is not a Run agent gone, so a refusal says liveness could not be read", () =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      yield* rig.queueOutputs([null]);
      const launched = yield* session(
        Agents.pipe(Effect.flatMap((agents) => agents.launch(implementerAsk()))),
      );
      yield* fs.writeFileString(launched.output, `{"verdict":"clean","note":"finished"}`);
      yield* fs.writeFileString(`${dir}/list-fails`, "x");
      const herdr = new FailsOnceReused(rig.pluginEnv(), `${dir}/list-fails`);
      const refused = yield* session(
        Agents.pipe(
          Effect.flatMap((agents) =>
            agents.steer({
              runId: "r1",
              to: "healer",
              text: "Look at this",
              request: "to-healer-3",
            }),
          ),
        ),
        { herdr },
      );
      expect(refused).toMatchObject({ agent: "", delivered: false, gone: false });
      expect(refused.detail).toContain("liveness could not be read");
    }),
  ));

test("a send that failed while the listing failed does not say the Run ended", () =>
  runEffect(
    Effect.gen(function* () {
      yield* rig.queueOutputs([null, null]);
      yield* session(Agents.pipe(Effect.flatMap((agents) => agents.launch(implementerAsk()))));
      yield* session(
        Agents.pipe(
          Effect.flatMap((agents) =>
            agents.launch({
              ...implementerAsk(),
              operation: "review",
              agent: null,
              output: `${dir}/review.json`,
            }),
          ),
        ),
      );
      const herdr = new Refusing({ "terminal.send": "blocked", "terminal.list": "socket closed" });
      const failed = yield* session(
        Agents.pipe(
          Effect.flatMap((agents) =>
            agents.steer({
              runId: "r1",
              to: "implementer",
              text: "Look at this",
              request: "to-implementer-9",
            }),
          ),
        ),
        { herdr },
      );
      expect(failed).toMatchObject({ delivered: false, gone: false });
    }),
  ));

test("a launch that has written its Output is still an agent the Run can reach, so a refusal names it", () =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      yield* rig.queueOutputs([null]);
      const launched = yield* session(
        Agents.pipe(Effect.flatMap((agents) => agents.launch(implementerAsk()))),
      );
      yield* fs.writeFileString(launched.output, `{"verdict":"clean","note":"finished"}`);
      const refused = yield* session(
        Agents.pipe(
          Effect.flatMap((agents) =>
            agents.steer({
              runId: "r1",
              to: "healer",
              text: "Look at this",
              request: "to-healer-2",
            }),
          ),
        ),
      );
      expect(refused).toMatchObject({ agent: "", delivered: false, gone: false });
      expect(refused.detail).toContain(launched.agent);
      expect(refused.detail).toContain("implementer");
    }),
  ));

test("a held run parks before it starts an agent, and carries on once it is released", () =>
  runEffect(
    Effect.gen(function* () {
      yield* control("hold", "r1", true);
      yield* rig.queueOutputs([{ verdict: "clean", note: "after the hold" }]);
      yield* interrupted("r1", suspended("r1"));
      expect(Arr.filter(yield* rig.cmds(), (cmd) => cmd === "terminal.run")).toHaveLength(0);

      yield* control("hold", "r1", false);
      const result = yield* releasedInto("r1");
      expect(result._tag === "Success" && result.success.note).toBe("after the hold");
      expect(Arr.filter(yield* rig.cmds(), (cmd) => cmd === "terminal.run")).toHaveLength(1);
    }),
  ));

test("a stop while the collection is out parks the wait, and what comes back reattaches to the launch", () =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      yield* rig.queueOutputs([null]);
      yield* interrupted("r1", stoppedOnce("r1", "Your task for this step"));
      expect(Arr.filter(yield* rig.cmds(), (cmd) => cmd === "terminal.run")).toHaveLength(1);

      yield* control("stop", "r1", false);
      yield* fs.writeFileString(outputPath("r1"), `{"verdict":"clean","note":"resumed"}`);
      const result = yield* releasedInto("r1");
      expect(result._tag === "Success" && result.success.note).toBe("resumed");
      expect(Arr.filter(yield* rig.cmds(), (cmd) => cmd === "terminal.run")).toHaveLength(1);
    }),
  ));

class StopsAtRepair extends Herdr {
  override agentPrompt(target: string, text: string) {
    const stop = pipe(text, Str.includes("not usable")) ? control("stop", "r1", true) : Effect.void;
    return super.agentPrompt(target, text).pipe(Effect.tap(() => stop));
  }
}

test("a stop while the repair is awaited parks the wait, and the resume starts the halted agent again", () =>
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
      expect(Arr.filter(yield* rig.cmds(), (cmd) => cmd === "terminal.run")).toHaveLength(2);
    }),
  ));

class ClosedAtRepair extends Herdr {
  private tries = 0;
  override agentPrompt(target: string, text: string) {
    if (!pipe(text, Str.includes("not usable"))) {
      return super.agentPrompt(target, text);
    }
    this.tries += 1;
    const code = this.tries === 1 ? "agent_blocked" : "agent_not_found";
    const refused = new HerdrError({ message: code, detail: "", code, answered: true });
    return (this.tries === 1 ? control("stop", "r1", true) : Effect.void).pipe(
      Effect.andThen(Effect.fail(refused)),
    );
  }
}

test("a stop while the repair waits on a blocked pane parks the work, and the resume starts the halted agent again", () =>
  runEffect(
    Effect.gen(function* () {
      yield* rig.queueOutputs([{ verdict: "maybe" }, { verdict: "clean", note: "after the stop" }]);
      yield* interrupted("r1", suspended("r1"), {
        herdr: new ClosedAtRepair(rig.pluginEnv()),
        patience: { firstMs: 10, maxMs: 20, forMs: 30_000 },
      });
      expect(yield* statusNow("r1")).toBe("suspended");
      yield* session(halted("r1"));

      yield* control("stop", "r1", false);
      const result = yield* releasedInto("r1");
      expect(result._tag === "Success" && result.success.note).toBe("after the stop");
      expect(Arr.filter(yield* rig.cmds(), (cmd) => cmd === "terminal.run")).toHaveLength(2);
      expect(sent(yield* rig.calls(), "not usable")).toBe(0);
    }),
  ));

test("an Output made good while the Run was stopping is the answer on resume, with no repair sent", () =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      yield* rig.queueOutputs([{ verdict: "maybe" }]);
      yield* interrupted("r1", suspended("r1"), {
        herdr: new ClosedAtRepair(rig.pluginEnv()),
        patience: { firstMs: 10, maxMs: 20, forMs: 30_000 },
      });
      expect(yield* statusNow("r1")).toBe("suspended");
      yield* fs.writeFileString(outputPath("r1"), `{"verdict":"clean","note":"on its own"}`);
      yield* session(halted("r1"));

      yield* control("stop", "r1", false);
      const result = yield* releasedInto("r1");
      expect(result._tag === "Success" && result.success.note).toBe("on its own");
      expect(Arr.filter(yield* rig.cmds(), (cmd) => cmd === "terminal.run")).toHaveLength(1);
    }),
  ));

const listing = enveloped({
  name: "agent-listing",
  input: { items: Schema.String, agent: Schema.String },
  success: Schema.String,
});

const listingBody = listing.toLayer((payload) =>
  Effect.gen(function* () {
    const notes: Array<string> = [];
    for (const item of Str.split(payload.input.items, ",")) {
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
    return Arr.join(notes, "+");
  }).pipe(asRun(payload)),
);

const listed = (runId: string, items: string, agent = "sweep") =>
  listing.execute({ runId, input: { items, agent } }).pipe(
    Effect.result,
    Effect.provide(
      listingBody.pipe(
        Layer.provideMerge(agentsLayer(hostOf())),
        Layer.provideMerge(
          foundationLayer({
            dir,
          }),
        ),
      ),
    ),
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
      expect(Arr.filter(yield* rig.cmds(), (cmd) => cmd === "terminal.run")).toHaveLength(1);
      const start = Option.getOrUndefined(
        Arr.findFirst(yield* rig.calls(), (call) => call.cmd === "terminal.run"),
      );
      expect(start?.params?.name).toBe(agentName("r1", "sweep", null, 1));
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
      expect(Arr.filter(yield* rig.cmds(), (cmd) => cmd === "terminal.run")).toEqual([]);
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
      const result = yield* unfilled.execute({ runId: "r1", input: {} }).pipe(
        Effect.result,
        Effect.provide(
          unfilledBody.pipe(
            Layer.provideMerge(agentsLayer(hostOf())),
            Layer.provideMerge(
              foundationLayer({
                dir,
              }),
            ),
          ),
        ),
        Effect.scoped,
        Effect.orDie,
      );
      expect(result._tag === "Failure" && result.failure.reason).toBe(
        "review: its instructions name {{plan.file}}, {{not a name}}, which nothing this work was given fills",
      );
      const cmds = yield* rig.cmds();
      expect(Arr.filter(cmds, (cmd) => cmd === "terminal.run")).toEqual([]);
    }),
  ));

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
        Effect.provide(
          pairBody.pipe(
            Layer.provideMerge(agentsLayer(hostOf())),
            Layer.provideMerge(
              foundationLayer({
                dir,
              }),
            ),
          ),
        ),
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
        Effect.provide(
          pairBody.pipe(
            Layer.provideMerge(agentsLayer(hostOf())),
            Layer.provideMerge(
              foundationLayer({
                dir,
              }),
            ),
          ),
        ),
        Effect.scoped,
        Effect.orDie,
      );
      expect(told.agent).toBe(first);
    }),
  ));

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

const builderBusy = Effect.gen(function* () {
  yield* reviewed.execute({ runId: "r1", input: {} });
  const launches = yield* launchesAt(dir, "r1");
  const build = Option.getOrUndefined(Arr.findFirst(launches, (one) => one.operation === "build"))!;
  yield* (yield* FileSystem.FileSystem).remove(build.output);
  return build.agent;
});

class BusyPanes extends Herdr {
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
        Effect.provide(
          reviewedBody.pipe(
            Layer.provideMerge(agentsLayer(hostOf())),
            Layer.provideMerge(
              foundationLayer({
                dir,
              }),
            ),
          ),
        ),
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
        Effect.provide(
          reviewedBody.pipe(
            Layer.provideMerge(
              agentsLayer({
                ...hostOf(),
                herdr: new BusyPanes(rig.pluginEnv()),
                observeMs: 500,
              }),
            ),
            Layer.provideMerge(
              foundationLayer({
                dir,
              }),
            ),
          ),
        ),
        Effect.scoped,
        Effect.orDie,
      );
      expect(told).toMatchObject({
        agent: agentName("r1", "review", null, 1),
        delivered: true,
        observed: false,
      });
      expect(told.how).toBeUndefined();
      const [one] = Arr.filter(
        yield* deliveredTo(dir, "r1"),
        (delivery) => delivery.cause.kind === "steer",
      );
      expect(one).toMatchObject({ state: "submitted", note: "unobserved" });
    }),
  ));

const fullContext: (asked: Array<string>, tokens?: number | null) => CompactionPorts = (
  asked,
  tokens = 1_000_000,
) => ({
  claude: {
    gate: Effect.void,
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
      const asked: Array<string> = [];
      const result = yield* listing.execute({ runId: "r1", input: ITEMS }).pipe(
        Effect.result,
        Effect.provide(
          listingBody.pipe(
            Layer.provideMerge(
              agentsLayer({
                ...hostOf(),
                compactAtTokens: 1000,
                ports: fullContext(asked),
              }),
            ),
            Layer.provideMerge(
              foundationLayer({
                dir,
              }),
            ),
          ),
        ),
        Effect.scoped,
        Effect.orDie,
      );
      expect(result._tag === "Success" && result.success).toBe("01-api:first+02-ui:second");
      expect(asked).toHaveLength(1);
      const context = Arr.filter(
        yield* readMetrics(evidenceDir(dir, "r1")).pipe(Effect.provide(recordsAt(dir))),
        (line) => line.kind === "context",
      );
      expect(Arr.map(context, (line) => [line.subject, line.value])).toEqual([
        [sweeper, 1_000_000],
      ]);
    }),
  ));

const compactionsAtDefault = (tokens: number) =>
  Effect.gen(function* () {
    yield* rig.queueOutputs([
      { verdict: "clean", note: "first" },
      { verdict: "clean", note: "second" },
    ]);
    const asked: Array<string> = [];
    yield* listing.execute({ runId: "r1", input: ITEMS }).pipe(
      Effect.provide(
        listingBody.pipe(
          Layer.provideMerge(
            agentsLayer({
              ...hostOf(),
              compactAtTokens: FALLBACK_DEFAULTS.compactAtTokens,
              ports: fullContext(asked, tokens),
            }),
          ),
          Layer.provideMerge(
            foundationLayer({
              dir,
            }),
          ),
        ),
      ),
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

interface SlowCompaction {
  ended: CompactionOutcome | null;
  readonly asked: Array<string>;
  readonly pollSent: Array<boolean>;
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

const until = <E, R>(reached: Effect.Effect<boolean, E, R>) =>
  Effect.gen(function* () {
    for (let tries = 0; !(yield* reached); tries++) {
      if (tries === 3000) {
        return yield* Effect.die(new Error("never got that far"));
      }
      yield* TestClock.withLive(Effect.sleep("10 millis"));
    }
  });

const parkedSays = (about: string) =>
  controlOf(PARKED, "r1").pipe(Effect.map((why) => pipe(why, Str.includes(about))));

const listingSuspended: Reached = Effect.gen(function* () {
  const engine = yield* WorkflowEngine.WorkflowEngine;
  const id = yield* listing.executionId({ runId: "r1", input: ITEMS });
  return pollStatus(yield* engine.poll(listing, id), "agent-listing").status === "suspended";
});

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
    Effect.provide(
      listingBody.pipe(
        Layer.provideMerge(
          agentsLayer({
            ...hostOf(),
            compactAtTokens: 1000,
            ports,
            compactionWaitMs: 60_000,
          }),
        ),
        Layer.provideMerge(
          foundationLayer({
            dir,
          }),
        ),
      ),
    ),
    Effect.scoped,
    Effect.orDie,
  );

const NOT_FINISHED = "has not finished after 1 minutes; Collie keeps waiting and sends 02-ui";

test("a compaction past its wait keeps the Run waiting, says so, and sends the work once it completes", () =>
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
      expect(yield* controlOf(PARKED, "r1")).toBe("");
      expect(yield* read(`${dir}/agents/r1/agents.log`)).toMatch(/native compaction \S+ completed/);
    }),
  ));

test("a compaction that fails past its wait clears the note and sends the work with the warning", () =>
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
      expect(yield* controlOf(PARKED, "r1")).toBe("");
      expect(yield* read(`${dir}/agents/r1/agents.log`)).toContain(
        "native compaction failed (the window is full) — sending the work anyway",
      );
    }),
  ));

test("a steer reaches the agent before and after a compaction's wait while it is unresolved", () =>
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
  ));

test("a compaction's polls are given a channel that sends nothing, and only its request is sent", () =>
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
      expect(Arr.every(state.pollSent, (ok) => !ok)).toBe(true);
      const compactions = Arr.filter(
        yield* deliveredTo(dir, "r1"),
        (delivery) => delivery.cause.kind === "compaction",
      );
      expect(compactions).toHaveLength(1);
      expect(sent(yield* rig.calls(), "from a poll")).toBe(0);
    }),
  ));

test("a stop while a compaction is past its wait ends the wait and types nothing", () =>
  runEffect(
    Effect.gen(function* () {
      const { ports } = slowCompaction();
      const { result } = yield* pastTheWait(
        ports,
        Effect.gen(function* () {
          yield* until(parkedSays(NOT_FINISHED));
          yield* control(STOP, "r1", true);
        }),
        true,
      );
      expect(result).toBe(null);
      expect(sent(yield* rig.calls(), "02-ui")).toBe(0);
    }),
  ));

test("a boundary whose context cannot be sampled records no context line, never a zero", () =>
  runEffect(
    Effect.gen(function* () {
      yield* rig.queueOutputs([
        { verdict: "clean", note: "first" },
        { verdict: "clean", note: "second" },
      ]);
      yield* listing.execute({ runId: "r1", input: ITEMS }).pipe(
        Effect.provide(
          listingBody.pipe(
            Layer.provideMerge(
              agentsLayer({
                ...hostOf(),
                compactAtTokens: 1000,
                ports: fullContext([], null),
              }),
            ),
            Layer.provideMerge(
              foundationLayer({
                dir,
              }),
            ),
          ),
        ),
        Effect.scoped,
        Effect.orDie,
      );
      const lines = yield* readMetrics(evidenceDir(dir, "r1")).pipe(Effect.provide(recordsAt(dir)));
      expect(Arr.filter(lines, (line) => line.kind === "context")).toEqual([]);
    }),
  ));

class Watched extends Herdr {
  readonly seen: Array<string> = [];
  private prompted = false;
  constructor(private readonly held: AgentStatus) {
    super(rig.pluginEnv());
  }
  override agentStatus(target: string) {
    const held = this.held;
    const prompted = this.prompted;
    return Effect.all([
      super.agentStatus(target),
      FileSystem.FileSystem.use((fs) => fs.readFileString(`${dir}/agents/r1/agents.log`)).pipe(
        Effect.map(Str.includes("still working; 02-ui waits for its turn to end")),
        Effect.orElseSucceed(() => false),
      ),
    ]).pipe(
      Effect.map(([actual, waited]) => {
        const status = !prompted || actual === "working" ? actual : waited ? "idle" : held;
        this.seen.push(status);
        return status;
      }),
    );
  }
  override agentPrompt(target: string, text: string) {
    this.prompted = true;
    this.seen.push(`prompt ${/([^/\s]+)\.prompt\.md/.exec(text)?.[1] ?? text}`);
    return super.agentPrompt(target, text);
  }
}

const listedWhile = (held: AgentStatus, herdr?: Herdr) =>
  Effect.gen(function* () {
    yield* rig.queueOutputs([
      { verdict: "clean", note: "first" },
      { verdict: "clean", note: "second" },
    ]);
    const watched = herdr ?? new Watched(held);
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
      Effect.provide(
        listingBody.pipe(
          Layer.provideMerge(
            agentsLayer({
              ...hostOf(),
              herdr: watched,
              compactAtTokens: 1000,
              ports,
            }),
          ),
          Layer.provideMerge(
            foundationLayer({
              dir,
            }),
          ),
        ),
      ),
      Effect.scoped,
      Effect.orDie,
    );
    return { result, seen };
  });

for (const busy of ["working", "blocked"] as const) {
  test(`a reused agent herdr reports ${busy} is given nothing until it is idle`, () =>
    runEffect(
      Effect.gen(function* () {
        const { result, seen } = yield* listedWhile(busy);
        expect(result._tag === "Success" && result.success).toBe("01-api:first+02-ui:second");
        const boundary = seen.slice(seen.indexOf("prompt 01-api") + 1);
        expect(boundary).toContain(busy);
        expect(boundary[boundary.indexOf("compact") - 1]).toBe("idle");
        expect(
          Arr.filter(boundary, (one) => one === "compact" || pipe(one, Str.startsWith("prompt"))),
        ).toEqual(["compact", "prompt 02-ui"]);
        const log = yield* read(`${dir}/agents/r1/agents.log`);
        expect(
          Option.getOrNull(pipe(log, Str.match(/still working; 02-ui waits for its turn to end/g))),
        ).toHaveLength(1);
      }),
    ));
}

class Unreadable extends Herdr {
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
  ["unreadable", () => listedWhile("idle", new Unreadable(rig.pluginEnv()))],
] as const) {
  test(`a reused agent whose status is ${what} is given its work as before`, () =>
    runEffect(
      Effect.gen(function* () {
        const { result } = yield* run();
        expect(result._tag === "Success" && result.success).toBe("01-api:first+02-ui:second");
      }),
    ));
}

const waitingAtBoundary = Effect.gen(function* () {
  yield* rig.queueOutputs([
    { verdict: "clean", note: "first" },
    { verdict: "clean", note: "second" },
  ]);
  yield* listing.execute({ runId: "r1", input: ITEMS }, { discard: true });
  for (let tries = 0; ; tries++) {
    const log = yield* read(`${dir}/agents/r1/agents.log`).pipe(Effect.orElseSucceed(() => ""));
    if (pipe(log, Str.includes("still working; 02-ui"))) {
      return;
    }
    if (tries === 3000) {
      return yield* Effect.die(new Error("the boundary never waited"));
    }
    yield* TestClock.withLive(Effect.sleep("10 millis"));
  }
});

const busyAfterFirst = <A, E>(
  run: Effect.Effect<A, E, WorkflowEngine.WorkflowEngine | Agents | FileSystem.FileSystem>,
) =>
  run.pipe(
    Effect.provide(
      listingBody.pipe(
        Layer.provideMerge(
          agentsLayer({
            ...hostOf(),
            herdr: new Statuses(["idle", "working"]),
            collectMs: 30_000,
          }),
        ),
        Layer.provideMerge(
          foundationLayer({
            dir,
          }),
        ),
      ),
    ),
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
      const reads = Effect.map(rig.calls(), (calls) => calls.length);
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

const listingSession = <A, E>(run: Effect.Effect<A, E, WorkflowEngine.WorkflowEngine | Store>) =>
  run.pipe(
    Effect.provide(
      listingBody.pipe(
        Layer.provideMerge(
          agentsLayer({
            ...hostOf(),
            collectMs: 30_000,
          }),
        ),
        Layer.provideMerge(
          foundationLayer({
            dir,
          }),
        ),
      ),
    ),
    Effect.scoped,
    Effect.orDie,
  );

const ITEMS = { items: "01-api,02-ui", agent: "sweep" };
const sweeper = agentName("r1", "sweep", null, 1);

const inTask = (runId: string) =>
  Effect.gen(function* () {
    yield* writeTask({
      id: "task-1",
      workspace: null,
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

const stoppedAtFirst = (runId: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    yield* listingSession(
      Effect.gen(function* () {
        yield* listing.execute({ runId, input: ITEMS }, { discard: true });
        while (!(yield* prompted("01-api.prompt.md"))) {
          yield* TestClock.withLive(Effect.sleep("10 millis"));
        }
        yield* TestClock.withLive(Effect.sleep("100 millis"));
        yield* control("stop", runId, true);
        yield* Effect.sleep(Duration.millis(900));
      }).pipe(Effect.provideService(FileSystem.FileSystem, fs)),
    );
  });

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

const tasksOf = (calls: ReadonlyArray<Call>) =>
  Arr.map(
    Arr.filter(calls, (call) => call.cmd === "terminal.run"),
    (call) => {
      const labels = call.params?.labels;
      return isJsonObject(labels) && isString(labels.task) ? labels.task : undefined;
    },
  );

const firstDone = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  yield* fs
    .writeFileString(`${dir}/agents/r1/01-api.json`, `{"verdict":"clean","note":"first"}`)
    .pipe(Effect.orDie);
  const [started] = Arr.filter(yield* rig.calls(), (call) => call.cmd === "terminal.run");
  yield* core.report(
    Option.getOrThrow(Schema.decodeUnknownOption(Schema.String)(started?.params?.name)),
    "idle",
  );
});

test("a Run's own stop leaves its agent as it was, and the resume goes on to the next item with it", () =>
  runEffect(
    Effect.gen(function* () {
      yield* inTask("r1");
      yield* rig.queueOutputs([
        { writes: [], output: null, status: "working" },
        { verdict: "clean", note: "second" },
      ]);
      yield* stoppedAtFirst("r1");

      expect(tasksOf(yield* rig.calls())).toEqual(["task-1"]);
      const closing = (cmd: string) => cmd === "terminal.kill";
      expect(Arr.filter(yield* rig.cmds(), closing)).toEqual([]);

      yield* firstDone;
      const result = yield* resumedList("r1");
      expect(result._tag === "Success" && result.success).toBe("01-api:first+02-ui:second");
      expect(Arr.filter(yield* rig.cmds(), closing)).toEqual([]);
      expect(Arr.filter(yield* rig.cmds(), (cmd) => cmd === "terminal.run")).toHaveLength(1);
    }).pipe(Effect.provide(recordsAt(dir))),
  ));

test("a fresh start only names its Task, and a continuation goes where its Task is", () =>
  runEffect(
    Effect.gen(function* () {
      const env = rig.pluginEnv();
      const fresh = yield* taskFor(
        env,
        { mode: "new" },
        { workflow: "implement", inputs: { issue: "ENG-7" } },
      );
      expect(fresh._tag === "Ok" && fresh.task).toBeNull();
      expect(fresh._tag === "Ok" ? fresh.label : null).toEqual(expect.any(String));

      const task = {
        id: "task-1",
        workspace: null,
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
      const tuneUp = yield* labelOf({
        workflow: "plan",
        // oxlint-disable-next-line unicorn/no-thenable -- Workflow input selects the next workflow; its value is a string.
        inputs: { then: "", goal: "Design Tune-up performance workflow" },
      });
      const lookup = yield* labelOf({
        workflow: "plan",
        // oxlint-disable-next-line unicorn/no-thenable -- Workflow input selects the next workflow; its value is a string.
        inputs: { then: "", goal: "Migrate pending-payment lookup to promotion-service" },
      });
      expect(tuneUp).toContain("Design Tune-up performance workflow");
      expect(lookup).toContain("Migrate pending-payment lookup to promotion-service");
      const plan = `${rig.root}/runs/run-1/plan`;
      yield* fs.makeDirectory(plan, { recursive: true });
      yield* fs.writeFileString(`${plan}/SPEC.md`, "# Spec: Stop the stale offer banner\n");
      // oxlint-disable-next-line unicorn/no-thenable -- Workflow input selects the next workflow; its value is a string.
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

test("a Task Collie named for its workflow alone is renamed for its work, and one named for its work is not", () =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const plan = `${rig.root}/runs/run-9/plan`;
      yield* fs.makeDirectory(plan, { recursive: true });
      yield* fs.writeFileString(`${plan}/SPEC.md`, "# Spec: Stop the stale offer banner\n");
      const kept = (id: string, label: string) =>
        writeTask({
          id,
          workspace: null,
          label,
          cwd: rig.projectDir,
          created_at: "2026-10-26T00:00:00.000Z",
        });
      yield* kept("task-p", "Collie | Plan new work");
      yield* kept("task-g", "Collie | Implement plan");
      yield* kept("task-n", "Collie | Passkey bridge race");
      yield* kept("task-c", "Collie | Implement plan");
      // oxlint-disable-next-line unicorn/no-thenable -- Workflow input selects the next workflow; its value is a string.
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
        // oxlint-disable-next-line unicorn/no-thenable -- Workflow input selects the next workflow; its value is a string.
        runFacts({ id: "r-g", task: "task-g", settled: { inputs: { plan, then: "" } } }),
        runFacts({ id: "r-n", workflow: "plan", task: "task-n", settled: { inputs: goal } }),
        runFacts({
          id: "r-x.implement",
          task: "task-c",
          parent: "r-x",
          settled: { inputs: { plan } },
        }),
      ];

      yield* retitleGenericTasks(runs);

      const label = (id: string) => readTask(id).pipe(Effect.map((task) => task?.label));
      expect(yield* label("task-p")).toBe("Collie | Design Tune-up performance workflow");
      expect(yield* label("task-g")).toBe("Collie | Stop the stale offer banner");
      expect(yield* label("task-c")).toBe("Collie | Stop the stale offer banner");
      expect(yield* label("task-n")).toBe("Collie | Passkey bridge race");
    }).pipe(Effect.provide(recordsAt(dir))),
  ));

test("a Task is renamed in its record alone, and core is asked nothing", () =>
  runEffect(
    Effect.gen(function* () {
      yield* writeTask({
        id: "task-k",
        workspace: null,
        label: "Collie | Plan new work",
        cwd: rig.projectDir,
        created_at: "2026-10-26T00:00:00.000Z",
      });
      const goal = { goal: "Design Tune-up performance workflow" };

      yield* retitleGenericTasks([
        runFacts({ id: "r-k", workflow: "plan", task: "task-k", settled: { inputs: goal } }),
      ]);

      expect(yield* readTask("task-k")).toEqual({
        id: "task-k",
        workspace: null,
        label: "Collie | Design Tune-up performance workflow",
        cwd: rig.projectDir,
        created_at: "2026-10-26T00:00:00.000Z",
      });
      expect(yield* rig.calls()).toEqual([]);
    }).pipe(Effect.provide(recordsAt(dir))),
  ));

test("a Task's label is renamed under its lock, never over a Run holding it", () =>
  runEffect(
    Effect.gen(function* () {
      yield* writeTask({
        id: "task-p",
        workspace: null,
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
      const label = readTask("task-p").pipe(Effect.map((task) => task?.label));

      yield* withTaskLock("task-p", retitleGenericTasks(runs));
      expect(yield* label).toBe("Collie | Plan new work");

      yield* retitleGenericTasks(runs);
      expect(yield* label).toBe("Collie | Design Tune-up performance workflow");
    }).pipe(Effect.provide(recordsAt(dir))),
  ));

const encodeJson = flow(
  Schema.encodeResult(Schema.fromJsonString(Schema.Unknown)),
  Result.getOrThrow,
);
const decodeJson = flow(
  Schema.decodeUnknownResult(Schema.fromJsonString(Schema.Unknown)),
  Result.getOrThrow,
);

const claudeControls = () => ({
  claude: { ...COMPACTION_PORTS.claude!, gate: Effect.void },
});

class UnreadyClaude extends Herdr {
  constructor() {
    super(rig.pluginEnv());
  }
  override agentLaunch(options: Parameters<Herdr["agentLaunch"]>[0]) {
    return super.agentLaunch(options).pipe(
      Effect.tap(() =>
        Effect.gen(function* () {
          const dir = yield* controlDir(rig.pluginEnv().stateDir, options.name);
          yield* (yield* FileSystem.FileSystem).remove(`${dir}/events.jsonl`, { force: true });
        }).pipe(Effect.orDie),
      ),
    );
  }
}

const statusLineCall = (agent: string) =>
  Effect.gen(function* () {
    const dir = yield* controlDir(hostOf().env.stateDir, agent);
    yield* recordClaudeEvent(dir, encodeJson({ session_id: "s1", context_window: null }), null);
  });

const untilStarted = Effect.gen(function* () {
  while (!(yield* rig.cmds()).includes("terminal.run")) {
    yield* Effect.sleep(Duration.millis(10));
  }
});

test("the first prompt to a new agent waits for the harness to say it is up, not only herdr", () =>
  runEffect(
    Effect.gen(function* () {
      yield* rig.queueOutputs([{ verdict: "clean", note: "after the status line" }]);
      let typedBeforeReady = -1;
      const claudeComesUp = Effect.gen(function* () {
        yield* untilStarted;
        yield* Effect.sleep(Duration.millis(300));
        typedBeforeReady = sent(yield* rig.calls(), "Your task for this step");
        yield* statusLineCall(agentFor("r1"));
      });
      const [result] = yield* Effect.all(
        [
          session(started("r1"), {
            herdr: new UnreadyClaude(),
            compactAtTokens: 1000,
            ports: claudeControls(),
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

test("a harness that never says it is up parks the step naming its pane, and types nothing", () =>
  runEffect(
    Effect.gen(function* () {
      yield* rig.queueOutputs([{ verdict: "clean", note: "never" }]);
      yield* interrupted("r1", suspended("r1"), {
        herdr: new UnreadyClaude(),
        compactAtTokens: 1000,
        ports: claudeControls(),
        readyMs: 300,
      });
      expect(yield* statusNow("r1")).toBe("suspended");
      const why = yield* controlOf(PARKED, "r1");
      expect(why).toContain(agentFor("r1"));
      expect(why).toMatch(/pane t\d+/);
      expect(sent(yield* rig.calls(), "Your task for this step")).toBe(0);
    }),
  ));

test("a harness whose readiness check fails parks the step saying why", () =>
  runEffect(
    Effect.gen(function* () {
      yield* rig.queueOutputs([{ verdict: "clean", note: "never" }]);
      yield* interrupted("r1", suspended("r1"), {
        compactAtTokens: 1000,
        ports: {
          claude: {
            ...claudeControls().claude,
            ready: () =>
              Effect.fail(new Cause.UnknownError(undefined, "its endpoint has 3 threads on it")),
          },
        },
        readyMs: 300,
      });
      expect(yield* controlOf(PARKED, "r1")).toContain("its endpoint has 3 threads on it");
      expect(sent(yield* rig.calls(), "Your task for this step")).toBe(0);
    }),
  ));

test("a step pointer the harness took is recorded as Collie's, with its delivery id", () =>
  runEffect(
    Effect.gen(function* () {
      yield* rig.queueOutputs([{ verdict: "clean", note: "done" }]);
      yield* session(started("r1"));
      const pointer = Option.getOrUndefined(
        Arr.findFirst(sentTexts(yield* rig.calls()), Str.includes("Your task")),
      );
      const [step] = yield* steps("r1");
      const dir = yield* controlDir(hostOf().env.stateDir, agentFor("r1"));
      yield* recordClaudeEvent(
        dir,
        encodeJson({ session_id: "s1", hook_event_name: "UserPromptSubmit", prompt: pointer }),
        null,
      );
      const events = Arr.map(
        Arr.filter(Str.split(yield* read(`${dir}/events.jsonl`), "\n"), (line) =>
          pipe(line, Str.includes('"submit"')),
        ),
        (line) => decodeJson(line),
      );
      expect(events).toMatchObject([{ kind: "submit", reason: "collie", delivery: step!.id }]);
      expect(
        Option.getOrUndefined(
          Option.map(Option.fromNullishOr(pointer), (present__) => Str.split(present__, "\n")),
        ),
      ).toContain(`collie-delivery:${step!.id}`);
    }),
  ));

test("a prompt that quotes a delivery token is not recorded as that delivery's submit", () =>
  runEffect(
    Effect.gen(function* () {
      yield* rig.queueOutputs([{ verdict: "clean", note: "done" }]);
      yield* session(started("r1"));
      const [step] = yield* steps("r1");
      const dir = yield* controlDir(hostOf().env.stateDir, agentFor("r1"));
      yield* recordClaudeEvent(
        dir,
        encodeJson({
          session_id: "s1",
          hook_event_name: "UserPromptSubmit",
          prompt: `the agent wrote collie-delivery:${step!.id} in its notes`,
        }),
        null,
      );
      const events = Arr.map(
        Arr.filter(Str.split(yield* read(`${dir}/events.jsonl`), "\n"), (line) =>
          pipe(line, Str.includes('"submit"')),
        ),
        (line) => decodeJson(line),
      );
      expect(events).toMatchObject([{ kind: "submit", reason: "external" }]);
      expect(events[0]).not.toHaveProperty("delivery");
    }),
  ));

class TextLost extends Herdr {
  lost = true;
  readonly typed: Array<string> = [];
  override agentPrompt(target: string, text: string) {
    if (!this.lost) {
      return super.agentPrompt(target, text);
    }
    this.typed.push(text);
    return Effect.succeed("unobserved" as const);
  }
}

const promptNotTaken = (lost: "enter" | "text") => {
  if (lost === "text") {
    return new TextLost(rig.pluginEnv());
  }
  core.stallNextSend();
  return new Herdr(rig.pluginEnv());
};

const pointersTyped = (calls: ReadonlyArray<Call>, herdr: Herdr) =>
  sent(calls, "Your task for this step") +
  (herdr instanceof TextLost
    ? Arr.filter(herdr.typed, Str.includes("Your task for this step")).length
    : 0);

const enters = (calls: ReadonlyArray<Call>) =>
  Arr.filter(
    calls,
    (call) =>
      call.cmd === "terminal.keys" &&
      Arr.isArray(call.params?.keys) &&
      Arr.contains(call.params.keys, "enter"),
  ).length;

test("a step pointer whose Enter was lost is sent with one Enter, never the text again", () =>
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
  ));

test("a step pointer that vanished is not sent again: the step waits for you, naming the pane and the delivery", () =>
  runEffect(
    Effect.gen(function* () {
      yield* rig.queueOutputs([{ verdict: "clean", note: "never" }]);
      const herdr = promptNotTaken("text");
      yield* interrupted("r1", parked("r1"), { herdr, confirmGraceMs: 300 });
      const why = yield* controlOf(PARKED, "r1");
      const [step] = yield* steps("r1");
      expect(why).toContain(step!.id);
      expect(why).toMatch(/pane t\d+/);
      const calls = yield* rig.calls();
      expect(pointersTyped(calls, herdr)).toBe(1);
      expect(enters(calls)).toBe(0);
    }),
  ));

// WARNING: a budget no real IO can outrun on the fast test clock.
const OUTLASTS_IO = 300_000;

const reconciled = (runId: string, as: "sent" | "not-sent") =>
  Effect.gen(function* () {
    const why = yield* controlOf(PARKED, runId);
    const [step] = yield* steps(runId);
    expect(why).toContain(`--reconcile ${step!.id} --as sent|not-sent`);
    const settled = reconcile(yield* ledgerOf(dir, step!.incarnation), step!.id, as, "tester", "t");
    if ("error" in settled) {
      throw new Error(settled.error);
    }
    yield* appendLine(settled).pipe(Effect.provide(recordsAt(dir)));
  });

test("a vanished step pointer settled as not sent goes out once more on resume, under a new delivery", () =>
  runEffect(
    Effect.gen(function* () {
      yield* rig.queueOutputs([{ verdict: "clean", note: "never" }]);
      const herdr = promptNotTaken("text");
      yield* interrupted("r1", parked("r1"), {
        herdr,
        confirmGraceMs: 300,
        collectMs: OUTLASTS_IO,
      });
      yield* reconciled("r1", "not-sent");

      yield* rig.queueOutputs([{ verdict: "clean", note: "sent again" }]);
      const result = yield* releasedInto("r1", { collectMs: OUTLASTS_IO });
      expect(result._tag === "Success" && result.success.note).toBe("sent again");
      expect(pointersTyped(yield* rig.calls(), herdr)).toBe(2);
      expect(new Set(Arr.map(yield* steps("r1"), (one) => one.id)).size).toBe(2);
    }),
  ));

test("a parked collection resumes on the same host and resends only the reconciled delivery", () =>
  runEffect(
    Effect.gen(function* () {
      const herdr = new TextLost(rig.pluginEnv());
      yield* session(
        Effect.gen(function* () {
          const engine = yield* WorkflowEngine.WorkflowEngine;
          const payload = { runId: "r1", input: { skip: false } };
          yield* rig.queueOutputs([{ verdict: "clean", note: "never" }]);
          yield* work.execute(payload, { discard: true });
          for (let tries = 0; !(yield* parked("r1")); tries++) {
            if (tries === 500) {
              throw new Error("collection never parked");
            }
            yield* TestClock.withLive(Effect.sleep("10 millis"));
          }
          const [first] = yield* steps("r1");
          expect(yield* controlOf(PARKED, "r1")).toContain(first!.id);
          for (let tries = 0; !(yield* suspended("r1")); tries++) {
            if (tries === 100) {
              throw new Error("parked collection never suspended");
            }
            yield* TestClock.withLive(Effect.sleep("10 millis"));
          }
          yield* reconciled("r1", "not-sent");
          herdr.lost = false;
          yield* rig.queueOutputs([{ verdict: "clean", note: "same host" }]);
          yield* engine.resume(work, yield* work.executionId(payload));
          const result = yield* work.execute(payload).pipe(Effect.result);
          expect(result._tag === "Success" && result.success.note).toBe("same host");
          const calls = yield* rig.calls();
          expect(pointersTyped(calls, herdr)).toBe(2);
          expect(Arr.filter(calls, (call) => call.cmd === "terminal.run")).toHaveLength(1);
          const delivered = yield* steps("r1");
          expect(Arr.map(delivered, (one) => one.attempt)).toEqual([1, 2]);
          expect(new Set(Arr.map(delivered, (one) => one.id)).size).toBe(2);
        }),
        { herdr, confirmGraceMs: 300, collectMs: 300_000 },
      );
    }),
  ));

test("a resend herdr refuses parks saying the next resume tries again, and it does", () =>
  runEffect(
    Effect.gen(function* () {
      yield* rig.queueOutputs([{ verdict: "clean", note: "never" }]);
      yield* interrupted("r1", parked("r1"), {
        herdr: promptNotTaken("text"),
        confirmGraceMs: 300,
        collectMs: OUTLASTS_IO,
      });
      yield* reconciled("r1", "not-sent");

      const refusing = new Refusing({ "terminal.send": `no agent ${agentFor("r1")}` });
      yield* session(
        Effect.gen(function* () {
          const engine = yield* WorkflowEngine.WorkflowEngine;
          const payload = { runId: "r1", input: { skip: false } };
          yield* engine.resume(work, yield* work.executionId(payload));
          yield* work.execute(payload, { discard: true });
          while (!pipe(yield* controlOf(PARKED, "r1"), Str.includes("tries again"))) {
            yield* TestClock.withLive(Effect.sleep("10 millis"));
          }
        }),
        { herdr: refusing, collectMs: OUTLASTS_IO },
      );
      expect(yield* controlOf(PARKED, "r1")).toContain("collie run resume r1");

      yield* rig.queueOutputs([{ verdict: "clean", note: "third time" }]);
      const result = yield* releasedInto("r1", { collectMs: OUTLASTS_IO });
      expect(result._tag === "Success" && result.success.note).toBe("third time");
    }),
  ));

test("a vanished step pointer settled as sent is not sent again: the resume waits for its Output", () =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      yield* rig.queueOutputs([{ verdict: "clean", note: "never" }]);
      const herdr = promptNotTaken("text");
      yield* interrupted("r1", parked("r1"), {
        herdr,
        confirmGraceMs: 300,
      });
      yield* reconciled("r1", "sent");

      yield* fs.writeFileString(outputPath("r1"), `{"verdict":"clean","note":"typed by hand"}`);
      const result = yield* releasedInto("r1");
      expect(result._tag === "Success" && result.success.note).toBe("typed by hand");
      expect(pointersTyped(yield* rig.calls(), herdr)).toBe(1);
    }),
  ));

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

const launchEnv = (calls: ReadonlyArray<Call>) => {
  const env = Option.getOrUndefined(Arr.findFirst(calls, (call) => call.cmd === "terminal.run"))
    ?.params?.env;
  return Schema.is(Schema.Record(Schema.String, Schema.String))(env)
    ? env
    : Rec.empty<string, string>();
};

const withProfile = (profile: AgentProfile) =>
  configured(encodeJson({ agent_profile: encodeJson(profile) }));

const claudeSettingsControls = () => ({
  claude: { ...COMPACTION_PORTS.claude!, gate: Effect.void, ready: undefined },
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

const ClaudeMcpConfig = Schema.fromJsonString(
  Schema.Struct({
    mcpServers: Schema.Struct({
      collie: Schema.Struct({
        env: Schema.Record(Schema.String, Schema.String),
      }),
    }),
  }),
);

const collieServerOf = Effect.fn("AgentsTest.collieServerOf")(function* () {
  const args = launchArgs(yield* rig.calls());
  const config = yield* Schema.decodeEffect(ClaudeMcpConfig)(
    yield* read(args[args.indexOf("--mcp-config") + 1] ?? ""),
  );
  return { args, env: config.mcpServers.collie.env };
});

test("a reviewer's Claude launch under the default role_tools carries every Collie tool and no strict MCP config", () =>
  runEffect(
    Effect.gen(function* () {
      yield* rig.queueOutputs([{ verdict: "clean", note: "done" }]);
      yield* session(started("r1"));
      const { args, env } = yield* collieServerOf();
      expect(args).not.toContain("--strict-mcp-config");
      expect(env.COLLIE_RUN).toBe("r1");
      expect(env.COLLIE_TOOLS_ROLE).toBeUndefined();
    }),
  ));

test("under role_tools: role a reviewer's Claude launch names its role to the Collie server, with no strict MCP config", () =>
  runEffect(
    Effect.gen(function* () {
      yield* configured(encodeJson({ role_tools: "role" }));
      yield* rig.queueOutputs([{ verdict: "clean", note: "done" }]);
      yield* session(started("r1"));
      const { args, env } = yield* collieServerOf();
      expect(args).not.toContain("--strict-mcp-config");
      expect(env.COLLIE_TOOLS_ROLE).toBe("reviewer");
      expect(env.COLLIE_RUN).toBe("r1");
      expect(yield* read(`${dir}/agents/r1/agents.log`)).toContain(
        "Collie tools: the reviewer's 3",
      );
    }),
  ));

test("under output_submit: tool a Claude launch offers collie_submit, and its Output file still counts", () =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      yield* configured(encodeJson({ output_submit: "tool" }));
      const result = yield* session(
        Effect.gen(function* () {
          const fiber = yield* Effect.forkChild(started("r1"));
          yield* rig.calls().pipe(
            Effect.repeat({
              until: (calls) => launchArgs(calls).length > 0,
              schedule: Schedule.spaced("20 millis"),
            }),
          );
          yield* fs.writeFileString(outputPath("r1"), `{"verdict":"clean","note":"written"}`);
          return yield* Fiber.join(fiber);
        }),
      );
      expect((yield* collieServerOf()).env.COLLIE_OUTPUT_SUBMIT).toBe("tool");
      expect(yield* read(promptPath("r1"))).toContain("collie_submit");
      expect(result._tag === "Success" && result.success.note).toBe("written");
    }),
  ));

test("an agent launched under output_submit: file is still told its Output's path after the setting becomes tool", () =>
  runEffect(
    Effect.gen(function* () {
      const continued = enveloped({ name: "submit-reuse", input: {}, success: Schema.String });
      const body = continued.toLayer((payload) =>
        Effect.gen(function* () {
          yield* agentWork({ operation: "first", agent: "worker", instructions: "One." });
          yield* configured(encodeJson({ output_submit: "tool" })).pipe(Effect.orDie);
          return yield* agentWork({ operation: "second", agent: "worker", instructions: "Two." });
        }).pipe(asRun(payload)),
      );
      yield* rig.queueOutputs(["first", "second"]);
      const result = yield* continued
        .execute({ runId: "r1", input: {} })
        .pipe(
          Effect.result,
          Effect.provide(
            body.pipe(
              Layer.provideMerge(agentsLayer(hostOf())),
              Layer.provideMerge(foundationLayer({ dir })),
            ),
          ),
          Effect.scoped,
        );
      expect(result).toMatchObject({ _tag: "Success", success: "second" });
      expect(everyLaunch(yield* rig.calls())).toHaveLength(1);
      const prompt = yield* read(`${dir}/agents/r1/second.prompt.md`);
      expect(prompt).not.toContain("collie_submit");
      expect(prompt).toContain(`${dir}/agents/r1/second`);
    }),
  ));

test("under role_tools: role a role the table does not name keeps every tool, and its start line says so", () =>
  runEffect(
    Effect.gen(function* () {
      clearing = { role: "planner" };
      yield* configured(encodeJson({ role_tools: "role" }));
      yield* rig.queueOutputs([{ verdict: "clean", note: "done" }]);
      yield* session(started("r1"));
      expect((yield* collieServerOf()).env.COLLIE_TOOLS_ROLE).toBeUndefined();
      expect(yield* read(`${dir}/agents/r1/agents.log`)).toContain(
        "Collie tools: every tool, as the planner has no list",
      );
    }),
  ));

test.each(["all", "role"])(
  "under role_tools: %s a Claude launch keeps the operator's profile and no strict MCP config",
  (roleTools) =>
    runEffect(
      Effect.gen(function* () {
        yield* configured(
          encodeJson({
            role_tools: roleTools,
            agent_profile: encodeJson({
              "*": {
                claude: {
                  enabledPlugins: { "linear@official": true },
                  disableClaudeAiConnectors: false,
                },
              },
            }),
          }),
        );
        yield* rig.queueOutputs([{ verdict: "clean", note: "done" }]);
        yield* session(started("r1"));
        const { args, env } = yield* collieServerOf();
        const settings = yield* Schema.decodeEffect(Schema.fromJsonString(Schema.JsonObject))(
          yield* settingsAt(yield* rig.calls()),
        );
        expect(env.COLLIE_TOOLS_ROLE).toBe(roleTools === "role" ? "reviewer" : undefined);
        expect(args).not.toContain("--strict-mcp-config");
        expect(settings.enabledPlugins).toEqual({ "linear@official": true });
        expect(settings.disableClaudeAiConnectors).toBe(false);
      }),
    ),
);

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
        const settings = yield* Schema.decodeEffect(Schema.fromJsonString(Schema.JsonObject))(
          yield* settingsAt(yield* rig.calls()),
        );
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
      yield* tasks.execute({ runId: "r1", input: {} }).pipe(
        Effect.provide(
          body.pipe(
            Layer.provideMerge(agentsLayer(hostOf())),
            Layer.provideMerge(
              foundationLayer({
                dir,
              }),
            ),
          ),
        ),
        Effect.scoped,
      );
      const launches = yield* launchesAt(dir, "r1");
      expect(
        Option.getOrUndefined(Arr.findFirst(launches, (one) => one.operation === "research"))
          ?.claudeSubagents,
      ).toEqual({
        enabled: true,
        forceModel: false,
        model: "haiku",
        cacheTtl: "1h",
        maxDepth: 1,
        maxConcurrent: 2,
      });
      expect(
        Option.getOrUndefined(Arr.findFirst(launches, (one) => one.harness === "pi"))
          ?.claudeSubagents,
      ).toBeUndefined();
      const args =
        Option.getOrUndefined(
          Arr.findFirst(everyLaunch(yield* rig.calls()), (args) => {
            const returned: boolean = Arr.some(args, (arg) =>
              pipe(arg, Str.endsWith("/research.settings.json")),
            );
            return returned;
          }),
        ) ?? [];
      const settings = yield* Schema.decodeEffect(Schema.fromJsonString(Schema.JsonObject))(
        yield* read(args[args.indexOf("--settings") + 1] ?? ""),
      );
      expect(settings.env).toMatchObject({
        CLAUDE_CODE_SUBAGENT_MODEL: "haiku",
        CLAUDE_CODE_SUBAGENT_MODEL_FORCE: "0",
      });
      expect(settings.permissions).toBeUndefined();
      const smallArgs =
        Option.getOrUndefined(
          Arr.findFirst(everyLaunch(yield* rig.calls()), (args) => {
            const returned: boolean = Arr.some(args, (arg) =>
              pipe(arg, Str.endsWith("/small.settings.json")),
            );
            return returned;
          }),
        ) ?? [];
      const small = yield* Schema.decodeEffect(Schema.fromJsonString(Schema.JsonObject))(
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

const SkillOverridesSettings = Schema.fromJsonString(
  Schema.Struct({
    skillOverrides: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
  }),
);

const skillsInstalled = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  for (const name of ["tdd", "deploy", "kibana-dashboards", "elastic-audit"]) {
    yield* fs.makeDirectory(`${rig.root}/.claude/skills/${name}`, { recursive: true });
    yield* fs.writeFileString(
      `${rig.root}/.claude/skills/${name}/SKILL.md`,
      `---\nname: ${name}\ndescription: What ${name} is for.\n---\n`,
    );
  }
  yield* writePersona(rig.userDir, "reviewer", "You review, with {{skill:tdd}}.");
  clearing = { skill: "deploy" };
  yield* withProfile({ "*": { claude: { skillOverrides: { "elastic-audit": "off" } } } });
  yield* rig.queueOutputs([{ verdict: "clean", note: "done" }]);
});

test("a Claude skill named in the workflow prompt stays fully described", () =>
  runEffect(
    Effect.gen(function* () {
      yield* skillsInstalled;
      clearing = {
        ...clearing,
        instructions: "Review {{target}} with {{skill:kibana-dashboards}}.",
      };
      yield* session(started("r1"));
      const settings = yield* Schema.decodeEffect(SkillOverridesSettings)(
        yield* settingsAt(yield* rig.calls()),
      );
      expect(settings.skillOverrides).toEqual({ "elastic-audit": "off" });
    }),
  ));

test("Claude skill selection uses the config directory from the agent profile", () =>
  runEffect(
    Effect.gen(function* () {
      yield* skillsInstalled;
      yield* withProfile({ "*": { env: { CLAUDE_CONFIG_DIR: `${rig.root}/alternate` } } });
      const fs = yield* FileSystem.FileSystem;
      yield* fs.makeDirectory(`${rig.root}/alternate/skills/other`, { recursive: true });
      yield* fs.writeFileString(
        `${rig.root}/alternate/skills/other/SKILL.md`,
        "---\nname: other\ndescription: Another skill\n---\n",
      );
      yield* session(started("r1"));
      const settings = yield* Schema.decodeEffect(SkillOverridesSettings)(
        yield* settingsAt(yield* rig.calls()),
      );
      expect(settings.skillOverrides).toEqual({ other: "name-only" });
    }),
  ));

test("Claude skills stay inherited when the config directory is held in an environment file", () =>
  runEffect(
    Effect.gen(function* () {
      yield* skillsInstalled;
      const fs = yield* FileSystem.FileSystem;
      const file = `${rig.root}/config-dir`;
      yield* fs.writeFileString(file, `${rig.root}/alternate\n`);
      yield* fs.chmod(file, 0o600);
      yield* withProfile({ "*": { env: { CLAUDE_CONFIG_DIR: { file } } } });
      yield* session(started("r1"));
      const settings = yield* Schema.decodeEffect(SkillOverridesSettings)(
        yield* settingsAt(yield* rig.calls()),
      );
      expect(settings.skillOverrides).toBeUndefined();
    }),
  ));

test.each([0, 1000])(
  "a Claude agent keeps named skills and operator choices with compaction at %s",
  (compactAtTokens) =>
    runEffect(
      Effect.gen(function* () {
        yield* skillsInstalled;
        yield* session(started("r1"), { compactAtTokens, ports: claudeSettingsControls() });
        const text = yield* settingsAt(yield* rig.calls());
        const settings = yield* Schema.decodeEffect(SkillOverridesSettings)(text);
        expect(settings.skillOverrides).toEqual({
          "kibana-dashboards": "name-only",
          "elastic-audit": "off",
        });
        if (compactAtTokens > 0) {
          expect(text).toContain('"hooks"');
        }
      }),
    ),
);

test("Claude skill selection is refreshed on recovery and preserves new local choices", () =>
  runEffect(
    Effect.gen(function* () {
      yield* skillsInstalled;
      yield* rig.queueOutputs([null, { verdict: "clean", note: "back" }]);
      yield* interrupted("r1", prompted("Your task for this step"));
      const initial = yield* Schema.decodeEffect(SkillOverridesSettings)(
        yield* settingsAt(yield* rig.calls()),
      );
      expect(initial.skillOverrides).toEqual({
        "kibana-dashboards": "name-only",
        "elastic-audit": "off",
      });
      yield* halted("r1").pipe(
        Effect.provide(agentsLayer(hostOf()).pipe(Layer.provideMerge(foundationLayer({ dir })))),
        Effect.scoped,
      );
      const fs = yield* FileSystem.FileSystem;
      yield* fs.makeDirectory(`${rig.projectDir}/.claude`, { recursive: true });
      yield* fs.writeFileString(
        `${rig.projectDir}/.claude/settings.local.json`,
        '{"skillOverrides":{"kibana-dashboards":"on"}}',
      );
      yield* fs.makeDirectory(`${rig.root}/.claude/skills/new-noise`, { recursive: true });
      yield* fs.writeFileString(
        `${rig.root}/.claude/skills/new-noise/SKILL.md`,
        "---\nname: new-noise\ndescription: Added since the first launch\n---\n",
      );
      const result = yield* session(started("r1"));
      expect(result._tag).toBe("Success");
      expect(everyLaunch(yield* rig.calls())).toHaveLength(2);
      const recovered = yield* Schema.decodeEffect(SkillOverridesSettings)(
        yield* settingsAt(yield* rig.calls()),
      );
      expect(recovered.skillOverrides).toEqual({
        "new-noise": "name-only",
        "elastic-audit": "off",
      });
    }),
  ));

test.each([["2.1.128 (Claude Code)"], [null]])(
  "a Claude that cannot take skillOverrides (%s) lists every skill as before",
  (installed) =>
    runEffect(
      Effect.gen(function* () {
        yield* skillsInstalled;
        yield* session(started("r1"), { version: () => Effect.succeed(installed) });
        const settings = yield* Schema.decodeEffect(SkillOverridesSettings)(
          yield* settingsAt(yield* rig.calls()),
        );
        expect(settings.skillOverrides).toEqual({ "elastic-audit": "off" });
        expect(yield* read(`${dir}/agents/r1/agents.log`)).toContain(
          "every skill described: skillOverrides needs Claude Code 2.1.129",
        );
      }),
    ),
);

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
        expect(yield* controlOf(PARKED, "r1")).toContain("requires Claude Code 2.1.242");
        expect(yield* rig.cmds()).not.toContain("terminal.run");
      }),
    ),
);

test("a subagent policy stays recorded through recovery after the operator changes defaults", () =>
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
  ));

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
          Effect.provide(
            body.pipe(
              Layer.provideMerge(
                agentsLayer({
                  ...hostOf(),
                  harness,
                  model: harness === "pi" ? "openai-codex/gpt-6.1-sol" : "opus",
                }),
              ),
              Layer.provideMerge(
                foundationLayer({
                  dir,
                }),
              ),
            ),
          ),
          Effect.scoped,
        );
        if (matches) {
          expect(result._tag).toBe("Success");
        } else {
          expect(result._tag === "Failure" ? result.failure.reason : "").toContain(
            "different Claude subagent policy",
          );
        }
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
        Arr.map(
          [
            ...Arr.map(Rec.toEntries(launchEnv(calls)), ([name, value]) => `${name}=${value}`),
            ...Arr.map(launchArgs(calls), (value, at) =>
              launchArgs(calls)[at - 1] === "--session-id" ? "<session>" : value,
            ),
          ],
          (said) =>
            pipe(said, Str.replaceAll(agentFor(runId), "<agent>"), Str.replaceAll(runId, "<run>")),
        );
      expect(same(after, "r2")).toEqual(same(before, "r1"));
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

      const runless = (text: string) => pipe(text, Str.replaceAll(/\br[12]\b/g, "<run>"));
      expect(runless(after)).toEqual(runless(before));
      expect(before).toContain("hooks");
    }),
  ));

test("a profile's environment is what the harness starts with, and a file-held value is written nowhere of Collie's", () =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const secret = Arr.join(["glpat", "synthetic0000000000test"], "-");
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
      expect(launchEnv(calls)).toMatchObject({
        PONYTAIL_DEFAULT_MODE: "off",
        DEPLOY_TOKEN: secret,
      });

      const leaked: Array<string> = [];
      for (const path of yield* fs.readDirectory(rig.root, { recursive: true })) {
        const at = `${rig.root}/${path}`;
        if (at === `${rig.root}/secrets/token` || at === rig.logPath) {
          continue;
        }
        if ((yield* fs.stat(at)).type !== "File") {
          continue;
        }
        if (
          pipe(
            yield* fs.readFileString(at).pipe(Effect.orElseSucceed(() => "")),
            Str.includes(secret),
          )
        ) {
          leaked.push(path);
        }
      }
      expect(leaked).toEqual([]);
      expect(Arr.join(launchArgs(calls), " ")).not.toContain(secret);
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
      const why = yield* controlOf(PARKED, "r1");
      expect(why).toContain(`${rig.root}/token is mode 0644, not 0600`);
      expect(why).not.toContain("hunter2");
      const cmds = yield* rig.cmds();
      expect(cmds).not.toContain("terminal.run");
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
      expect(Arr.filter(args, (arg) => arg === "--settings")).toHaveLength(1);
      const settings = yield* Schema.decodeEffect(
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
      expect(Struct.keys(settings.hooks)).toEqual(
        expect.arrayContaining(["PreCompact", "PostCompact", "UserPromptSubmit"]),
      );
      const { autoMode } = yield* Schema.decodeEffect(AutoModeSettings)(
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

const ClaudeMdExcludes = Schema.fromJsonString(
  Schema.Struct({ claudeMdExcludes: Schema.Array(Schema.String) }),
);

test.each(["", "/"])(
  "a Claude agent working inside the Collie directory, spelled with %p after it, never loads that directory's instructions",
  (trailing) =>
    runEffect(
      Effect.gen(function* () {
        yield* withProfile({
          reviewer: { claude: { claudeMdExcludes: ["/home/me/.claude/CLAUDE.md"] } },
        });
        yield* rig.queueOutputs([{ verdict: "clean", note: "done" }]);
        yield* session(started("r1"), {
          env: rig.pluginEnv({ COLLIE_DIR: `${rig.root}${trailing}` }),
        });

        const { claudeMdExcludes } = yield* Schema.decodeEffect(ClaudeMdExcludes)(
          yield* settingsAt(yield* rig.calls()),
        );
        expect(claudeMdExcludes).toEqual([
          `${rig.root}/CLAUDE.md`,
          `${rig.root}/CLAUDE.local.md`,
          `${rig.root}/.claude/CLAUDE.md`,
          `${rig.root}/.claude/rules/**`,
          "/home/me/.claude/CLAUDE.md",
        ]);
      }),
    ),
);

test("a Claude agent working outside the Collie directory keeps only the operator's exclusions", () =>
  runEffect(
    Effect.gen(function* () {
      yield* withProfile({
        reviewer: { claude: { claudeMdExcludes: ["/home/me/.claude/CLAUDE.md"] } },
      });
      yield* rig.queueOutputs([{ verdict: "clean", note: "done" }]);
      yield* session(started("r1"), {
        env: rig.pluginEnv({ COLLIE_DIR: `${rig.root}/proj` }),
      });

      const { claudeMdExcludes } = yield* Schema.decodeEffect(ClaudeMdExcludes)(
        yield* settingsAt(yield* rig.calls()),
      );
      expect(claudeMdExcludes).toEqual(["/home/me/.claude/CLAUDE.md"]);
    }),
  ));

test("a Claude launch's settings carry the Run's autoMode block, each list opening with the defaults", () =>
  runEffect(
    Effect.gen(function* () {
      yield* rig.queueOutputs([{ verdict: "clean", note: "done" }]);
      yield* session(started("r1"));

      const text = yield* settingsAt(yield* rig.calls());
      const { autoMode } = yield* Schema.decodeEffect(AutoModeSettings)(text);
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

      const { autoMode } = yield* Schema.decodeEffect(AutoModeSettings)(
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

test("a Codex launch writes no autoMode or Claude skill overrides", () =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      yield* skillsInstalled;
      yield* session(started("r1"), { harness: "codex", model: "default" });

      const calls = yield* rig.calls();
      expect(Arr.join(launchArgs(calls), " ")).not.toContain("autoMode");
      for (const path of yield* fs.readDirectory(`${dir}/agents/r1`)) {
        const contents = yield* read(`${dir}/agents/r1/${path}`);
        expect(contents).not.toContain("autoMode");
        expect(contents).not.toContain("skillOverrides");
      }
    }),
  ));

const waitsForMemory = (runId: string) =>
  Effect.map(memoryWaitOf(runId), (wait) => wait !== null).pipe(overHost(() => dir));

const runLogOf = (runId: string) => read(`${dir}/agents/${runId}/agents.log`);

test("a launch waits while its Machine is short of memory, with no tab or agent made, and its budget starts once it is launched", () =>
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
          expect(Arr.filter(cmds, (cmd) => cmd === "terminal.run")).toEqual([]);
          expect(yield* runLogOf("r1")).toContain(
            `${agentFor("r1")}'s launch: waiting for memory on `,
          );

          yield* rig.memory(50);
          yield* until(prompted("Your task for this step"));
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
      expect(Arr.filter(yield* rig.cmds(), (cmd) => cmd === "terminal.run")).toHaveLength(1);
    }),
  ));

test("a stop ends a launch's wait for memory, and nothing is launched for the Run after it", () =>
  runEffect(
    Effect.gen(function* () {
      yield* rig.memory(2);
      yield* session(
        Effect.gen(function* () {
          yield* work.execute({ runId: "r1", input: { skip: false } }, { discard: true });
          yield* until(waitsForMemory("r1"));
          yield* control(STOP, "r1", true);
          yield* until(suspended("r1"));
          expect(yield* memoryWaitOf("r1").pipe(overHost(() => dir))).toBeNull();
          yield* rig.memory(50);
          yield* spend(60_000);
        }),
      );
      expect(Arr.filter(yield* rig.cmds(), (cmd) => cmd === "terminal.run")).toEqual([]);
      expect(yield* runLogOf("r1")).toContain("stopped after waiting");
    }),
  ));

test("a verify an idle agent asked for, held for memory past its budget, keeps its Run from parking, and one with none parks", () =>
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
          const verify = yield* Effect.forkChild(
            waitForMemory({
              env: rig.pluginEnv(),
              stateDir: dir,
              runId: "r1",
              what: 'collie verify "unit"',
              asker: agentFor("r1"),
            }).pipe(overHost(() => dir)),
          );
          yield* until(holdsBudgetOf("r1", agentFor("r1")).pipe(overHost(() => dir)));
          herdr.written = true;
          yield* until(parked("r2"));
          yield* spend(5000);
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
  ));

const recording: (sources: ReadonlyArray<Source>) => CompactionPorts = (sources) => ({
  claude: { ...fullContext([], null).claude!, records: () => Effect.succeed(sources) },
});

const ledgered = { compactAtTokens: 1_000_000 };
const usageLines = (runId: string) =>
  readUsage(evidenceDir(dir, runId)).pipe(Effect.provide(recordsAt(dir)));

test("a session's start-up lists each part its harness exposes, with its size, and the rest unavailable", () =>
  runEffect(
    Effect.gen(function* () {
      yield* rig.queueOutputs([{ verdict: "clean", note: "built" }]);
      const codex = new URL("./fixtures/usage-ledger/codex.jsonl", import.meta.url).pathname;
      yield* session(
        Effect.gen(function* () {
          yield* started("r1");
          yield* (yield* Agents).halt("r1");
        }),
        { ...ledgered, ports: recording([{ path: codex, format: "codex", parent: null }]) },
      );
      const [one] = usageOf(yield* usageLines("r1")).sessions;
      // WARNING: sizes are characters counted by hand from the fixture; the persona is "You are the reviewer.".
      expect(one?.startup).toEqual({
        system: 14,
        persona: 21,
        project: 40,
        tools: 164,
        skills: null,
      });
    }),
  ));

const claudeRequest = (id: string, at: string, output: number) =>
  JSON.stringify({
    type: "assistant",
    sessionId: "c9",
    timestamp: at,
    requestId: `req_${id}`,
    message: {
      id: `msg_${id}`,
      role: "assistant",
      model: "claude-opus-5-5",
      usage: {
        input_tokens: 2,
        cache_creation_input_tokens: 10,
        cache_read_input_tokens: 100,
        output_tokens: output,
      },
    },
  }) + "\n";

test("requests an agent made after its last delivery are in the ledger once it is ended, and still once after its Run settles", () =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const transcript = `${dir}/late/c9.jsonl`;
      yield* fs.makeDirectory(`${dir}/late`, { recursive: true });
      yield* fs.writeFileString(transcript, claudeRequest("A", "2026-11-17T10:00:00.000Z", 5));
      yield* rig.queueOutputs([{ verdict: "clean", note: "built" }]);
      const keys = (entries: ReadonlyArray<UsageEntry>) =>
        Arr.flatMap(entries, (one) => (one.what === "request" ? [one.key] : []));
      const [ended, settled] = yield* session(
        Effect.gen(function* () {
          const agents = yield* Agents;
          yield* started("r1");
          yield* fs.writeFileString(
            transcript,
            claudeRequest("B", "2026-11-17T10:01:00.000Z", 7) +
              claudeRequest("C", "2026-11-17T10:02:00.000Z", 9),
            { flag: "a" },
          );
          yield* agents.halt("r1");
          const ended = keys(yield* usageLines("r1"));
          yield* agents.account("r1", false);
          return [ended, keys(yield* usageLines("r1"))] as const;
        }),
        {
          ...ledgered,
          ports: recording([{ path: transcript, format: "claude", parent: null }]),
        },
      );
      expect(Arr.sort(ended, Order.String)).toEqual(["msg_A", "msg_B", "msg_C"]);
      expect(Arr.sort(settled, Order.String)).toEqual(["msg_A", "msg_B", "msg_C"]);
    }),
  ));

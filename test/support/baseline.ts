// The shipped workflows as modules, run the way a user's own module is run.
//
// Nothing here is special-cased for being shipped, and every scenario runs twice: as
// shipped, and saved as a user's entry under an id that shares nothing with it. The same
// assertions have to hold both times. The entries are loaded from
// `workflows/` through the public contract, the agents are herdr's through the real
// dispatcher with a stand-in harness at the far end, and the engine is Effect's over real
// SQLite. What is proved is that the Markdown supplies the content — the persona, the
// prompts, the skill each step is started with — while the module decides everything that
// happens: what is asked of whom, in what order, and what the answer starts next.

import type { ChildProcessSpawner } from "effect/process";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { hostname } from "node:os";
import {
  Clock,
  Config,
  ConfigProvider,
  DateTime,
  Deferred,
  Duration,
  Effect,
  Fiber,
  FileSystem,
  Layer,
  Option,
  Path,
  Result,
  Schedule,
  Schema,
} from "effect";
import * as WorkflowEngine from "effect/workflow/WorkflowEngine";
import { Rig, FakeHerdr } from "./recorder";
import { exec } from "./command";
import { fastForward, runEffect } from "./effect";
import { FakeBin } from "./bin";
import {
  CLI,
  FORGE_HOST,
  PROJECT,
  forgeOnPath as modelOnPath,
  serveForges,
  type FakeJob,
  type FakeComment,
  type FakeMr,
  type ForgeModel,
} from "./forge";
import * as BunServices from "@effect/platform-bun/BunServices";
import { readLanding, takeOver, writeLanding } from "../../src/landing";
import { shell } from "../../src/mr";
import { forgeHttpLayer, type ForgeHttp } from "../../src/forge/http";
import { readCheckpoints } from "../../src/cards";
import { mrLabel, mrTarget, type FlowLane, type MrForge } from "../../src/board-model";
import { laneFor } from "../../src/flow-read";
import type { RunState } from "../../src/runs";
import { runFacts } from "./records";
import { readLaunches } from "../../src/launches";
import { readReplies } from "../../src/replies";
import { disputesIn } from "../../src/proactive";
import { AwaitingJson } from "../../src/awaiting";
import { installFakeSkills } from "./defs";
import { Agents, agentsLayer, type AgentHost } from "../../src/agents";
import {
  Children,
  Host,
  Run,
  WorkflowError,
  type ActionFacts,
  type ChildAsk,
  type Claimed,
  type Issue,
} from "../../src/sdk";
import { readStepLines } from "../../src/steps";
import { measuresOf } from "../../src/outcomes";
import { redact } from "../../src/redact";
import { slackApi } from "../../src/slack";
import { writeSlackToken } from "../../src/slack-credentials";
import { fakeSlack } from "./slack";
import { INTENT_FILE, IntentSchema, amend, seedIntent } from "../../src/intent";
import selfImprove from "../../workflows/self-improve.workflow";
import {
  type Finding,
  type Improvement,
  keysIn,
  markerOf,
  sortOut,
} from "../../workflows/retrospective";
import {
  AWAITING,
  HOLD,
  PARKED,
  RunStatus,
  Registry,
  answerDecision,
  checkoutRefusedFile,
  controlPath,
  declaredByModule,
  evidenceDir,
  foundationLayer,
  loadEntry,
  pollStatus,
  registryLayer,
  runDir,
} from "../../src/engine";
import { declaredBy } from "../../src/discovery";
import { readMeasurements } from "../../src/measurement";
import type { Measurement } from "../../src/measurement-model";
import { nothingToLandFile } from "../../src/standing";
import { VerifySpecSchema } from "../../src/verify-spec";
import { findingsIn } from "../../src/output";
import { FINGERPRINT_MAX_BYTES, collect, fingerprint, readVerifications } from "../../src/verify";
import { inputsFor, offersFrom } from "../../src/offers";
import { Store, storeLayer } from "../../src/store";
import * as SqliteClient from "@effect/sql-sqlite-bun/SqliteClient";
import * as Reactivity from "effect/reactivity/Reactivity";
import { everyRegistered, registerAgent, registryPath, scopeFor } from "../../src/registry";
import { deliveriesOf, SENT_STATES } from "../../src/steering";
import { fixtures, until } from "./host";

const ROOT = new URL("../../", import.meta.url).pathname;

const UNRELATED = {
  plan: "chart-the-work",
  implement: "lay-the-bricks",
  review: "second-look",
  architecture: "survey-the-ground",
  renovate: "keep-current",
  release: "ship-it",
  investigate: "find-the-cause",
  general: "odd-job",
  "self-improve": "look-back",
  stage: "try-it-out",
  "tune-up": "make-haste",
} as const;
type Shipped = keyof typeof UNRELATED;

let rig: Rig;
let dir: string;
let forgeApi = "";
const forgeFaces = new Map<
  MrForge,
  {
    readonly face: (input: string, init?: RequestInit) => Promise<Response>;
  }
>();
const forgeOnPath = (bin: FakeBin, name: MrForge, model: ForgeModel) =>
  modelOnPath(bin, name, model).pipe(
    Effect.tap((forge) => Effect.sync(() => forgeFaces.set(name, forge))),
  );
const noGitlabMrs = (bin: FakeBin) =>
  forgeOnPath(bin, "gitlab", {
    installed: true,
    loggedIn: [FORGE_HOST.gitlab],
    login: "tester",
    mrs: [],
  });
let started: ChildAsk[] = [];
/** The invocations whose child ends in failure. */
let failing = new Set<string>();
let childWaits = new Map<string, Deferred.Deferred<void>>();
/** A held invocation, and the invocation whose start it waits for. */
let startsAfter = new Map<string, string>();
let startSignals = new Map<string, Deferred.Deferred<void>>();
const startSignal = (invocation: string) => {
  const signal = startSignals.get(invocation) ?? Deferred.makeUnsafe<void>();
  startSignals.set(invocation, signal);
  return signal;
};
let renamed = false;
let slack = fakeSlack();

/** The public id a shipped workflow is run under in this pass. */
const idOf = (name: Shipped) => (renamed ? UNRELATED[name] : name);
const shipped = (name: Shipped) =>
  renamed
    ? `${rig.root}/user/workflows/${idOf(name)}.workflow.ts`
    : `${ROOT}workflows/${name}.workflow.ts`;

/** A scenario, run once as shipped and once under the unrelated ids: see `register`. */
const scenarios: Array<{
  readonly name: string;
  readonly body: () => Promise<void>;
  readonly timeout?: number;
}> = [];
const scenario = (name: string, body: () => Promise<void>, timeout?: number) => {
  scenarios.push({ name, body, timeout });
};

/** A test about the shipped modules themselves, which has one pass. */
const shippedOnly: Array<() => void> = [];
const once = (name: string, body: () => Promise<void>, timeout?: number) => {
  shippedOnly.push(() => test(name, () => withForges(body), timeout));
};

/** The installation is this checkout, so the shipped personas are the ones found. */
const hostOf = (): AgentHost => ({
  dir,
  env: rig.pluginEnv({ HERDR_PLUGIN_ROOT: ROOT }),
  herdr: new FakeHerdr(rig.pluginEnv({ HERDR_PLUGIN_ROOT: ROOT })),
  harness: "claude",
  model: "opus",
  permissions: "auto",
  compactAtTokens: 0,
  pollMs: 20,
  collectMs: 1000,
});

/** Children as the host admits them, recorded rather than run: this suite is the parent. */
const children = Layer.succeed(Children)(
  Children.of({
    start: (ask) =>
      Effect.gen(function* () {
        const after = startsAfter.get(ask.invocation);
        if (after !== undefined) yield* Deferred.await(startSignal(after));
        started.push(ask);
        yield* Deferred.succeed(startSignal(ask.invocation), undefined);
        const parent = Option.getOrUndefined(yield* Effect.serviceOption(Run))?.id;
        return {
          runId: `${parent}-${ask.invocation}`,
          workflow: ask.workflow,
          invocation: ask.invocation,
          fresh: true,
        };
      }),
    result: (child) =>
      Effect.gen(function* () {
        const wait = childWaits.get(child.invocation);
        if (wait !== undefined) yield* Deferred.await(wait);
        if (failing.has(child.invocation))
          return yield* Effect.fail(new WorkflowError({ reason: `${child.invocation} failed` }));
        return "done";
      }),
  }),
);

/** A host layer a test may wrap, for the one capability it has no service to answer with. */
type HostOverride = Layer.Layer<Host, never, Host | BunServices.BunServices | ForgeHttp>;

/** The host's own layers, placing checkouts through the rig's herdr. */
const foundation = () => ({
  dir,
  userDir: rig.userDir,
  placing: { herdr: hostOf().herdr, env: hostOf().env },
  productionPoll,
  reviewPoll,
  slack: (token: string) => slackApi(token, slack.client),
});

/** How often production is read; a scenario that must not wait on it sets it long. */
let productionPoll: Duration.Input = "20 millis";
const reviewPoll: Duration.Input = "20 millis";

const session = <A, E>(
  run: Effect.Effect<
    A,
    E,
    | WorkflowEngine.WorkflowEngine
    | Agents
    | Children
    | Host
    | Store
    | FileSystem.FileSystem
    | Path.Path
    | ChildProcessSpawner.ChildProcessSpawner
  >,
  override?: HostOverride,
) =>
  Clock.clockWith((clock) =>
    run.pipe(
      Effect.provide(agentsLayer(hostOf())),
      Effect.provide(children),
      Effect.provide(
        override === undefined
          ? foundationLayer(foundation())
          : override.pipe(Layer.provideMerge(foundationLayer(foundation()))),
      ),
      Effect.provide(
        ConfigProvider.layerAdd(ConfigProvider.fromUnknown({ COLLIE_FORGE_API: forgeApi })),
      ),
      Effect.scoped,
      // The Run keeps the scenario's clock; the hang guard is real time.
      Effect.provideService(Clock.Clock, clock),
      Effect.timeout("30 seconds"),
      Effect.provideService(Clock.Clock, Clock.Clock.defaultValue()),
    ),
  ).pipe(Effect.orDie);

/** Each Run's module, by the entry it was loaded from. */
let modules = new Map<string, string>();

const loaded = (entry: string, runId: string) =>
  loadEntry(entry).pipe(
    Effect.map((described) => described.make(`${described.id}@${runId}`)),
    Effect.tap(() => Effect.sync(() => modules.set(runId, entry))),
    Effect.orDie,
  );

const EXECUTION = {
  running: "running",
  waiting: "suspended",
  succeeded: "completed",
  failed: "failed",
  stopped: "stopped",
} as const;

/** A Run's row of its Flow, built as RunDetail builds it from what the Run recorded and was asked. */
const laneIn = (runId: string, state: RunState = "running") =>
  Effect.gen(function* () {
    const asked = yield* (yield* Store).asked(runId);
    return yield* laneFor(
      { ...hostOf().env, stateDir: dir },
      runFacts({
        id: runId,
        state,
        dir: runDir(dir, runId),
        engine: {
          questions: asked.map((row) => ({
            name: row.decision,
            asked: row.asked,
            answered: row.answered,
            by: null,
            open: row.answer === null,
          })),
          wakes: null,
          execution: EXECUTION[state],
        },
      }),
    );
  });

const laneNow = (runId: string, state?: RunState) => session(laneIn(runId, state));

/** A lane read from the Store alone, with no engine to pick the Run's messages up again. */
const laneRead = (runId: string) =>
  laneIn(runId).pipe(
    Effect.provide(
      storeLayer.pipe(
        Layer.provide(
          SqliteClient.layer({ filename: `${dir}/host.db` }).pipe(
            Layer.orDie,
            Layer.provideMerge(Reactivity.layer),
          ),
        ),
      ),
    ),
    Effect.scoped,
  );

const nodeIn = (lane: FlowLane, id: string) => lane.nodes.find((node) => node.id === id);

/** Each node of a lane as its id and state, in the lane's order. */
const statesOf = (lane: FlowLane) => lane.nodes.map((node) => [node.id, node.state]);

/** A Run's lane once `ready` holds of it, while the Run goes on in the background. */
const laneWhen = (options: {
  readonly entry: string;
  readonly runId: string;
  readonly input: Readonly<Record<string, Schema.Json>>;
  readonly options?: Readonly<Record<string, string>>;
  readonly ready: (lane: FlowLane) => boolean;
  readonly host?: HostOverride;
  /**
   * The agent working when it is read, given its Output by hand, and the Outputs after it
   * that take the Run to where it stops: left running, the engine would wait out its
   * termination timeout for it.
   */
  readonly outputs: ReadonlyArray<Schema.Json>;
  readonly working: { readonly operation: string; readonly output: unknown };
  readonly rest: ReadonlyArray<Schema.Json>;
  readonly finish?: { readonly decision: string; readonly value: string };
  readonly continueWith?: (lane: FlowLane) => {
    readonly operation: string;
    readonly output: unknown;
    readonly rest: ReadonlyArray<Schema.Json>;
  };
}) =>
  session(
    Effect.gen(function* () {
      yield* rig.queueOutputs(options.outputs).pipe(Effect.orDie);
      const made = yield* loaded(options.entry, options.runId);
      yield* admit({
        runId: options.runId,
        workflow: made.workflow.name,
        input: options.input,
        options: options.options,
      });
      const payload = { runId: options.runId, input: options.input };
      return yield* Effect.gen(function* () {
        yield* made.workflow.execute(payload, { discard: true });
        const lane = yield* until(() => laneIn(options.runId), options.ready);
        const completing = options.continueWith?.(lane) ?? {
          ...options.working,
          rest: options.rest,
        };
        // The fake reads its queue by position, so what was taken stays where it was.
        yield* rig.queueOutputs([...options.outputs, null, ...completing.rest]).pipe(Effect.orDie);
        yield* (yield* FileSystem.FileSystem)
          .writeFileString(
            `${dir}/agents/${options.runId}/${completing.operation}.json`,
            asJson(completing.output),
          )
          .pipe(Effect.orDie);
        const execution = yield* made.workflow.executionId(payload);
        if (options.finish !== undefined) {
          const finish = options.finish;
          const store = yield* Store;
          yield* until(
            () => store.asked(options.runId),
            (rows) => rows.some((row) => row.decision === finish.decision && row.answer === null),
          );
          yield* answerDecision(made, {
            name: finish.decision,
            executionId: execution,
            value: finish.value,
          }).pipe(Effect.orDie);
          yield* made.workflow.execute(payload, { discard: true });
        }
        yield* until(() => made.workflow.poll(execution), Option.isSome);
        return lane;
      }).pipe(Effect.provide(made.layer));
    }),
    options.host,
  );

const undeclaredWork = () =>
  Effect.gen(function* () {
    const ours = new Set(
      (
        [
          "plan",
          "implement",
          "release",
          "stage",
          "review",
          "architecture",
          "renovate",
          "general",
          "investigate",
          "self-improve",
          "tune-up",
        ] as const
      ).map(shipped),
    );
    const loose: Array<readonly [string, string]> = [];
    for (const [runId, entry] of modules)
      if (ours.has(entry))
        for (const node of (yield* laneRead(runId)).nodes)
          if (!node.declared) loose.push([runId, node.id]);
    return loose;
  });

/**
 * The row a host admits before it hands work over. Seeded here because `place` reads it:
 * a Run works in the checkout it was started for, which is a fact about the Run and not
 * something a module is told.
 */
const admit = (options: {
  readonly runId: string;
  readonly workflow: string;
  readonly input: Readonly<Record<string, Schema.Json>>;
  readonly options?: Readonly<Record<string, string>>;
  readonly parent?: string;
}) =>
  Store.pipe(
    Effect.flatMap((store) =>
      store.admit({
        request: options.runId,
        run: options.runId,
        workflow: options.workflow,
        project: rig.projectDir,
        input: options.input,
        provenance: {},
        options: options.options ?? {},
        generation: `${options.workflow}@${options.runId}`,
        execution: options.runId,
        task: null,
        parent: options.parent ?? null,
      }),
    ),
    Effect.orDie,
  );

/** A Run of a shipped module, parked on the question it asks. */
const parked = (options: {
  readonly entry: string;
  readonly runId: string;
  readonly input: Readonly<Record<string, Schema.Json>>;
  /** The host's own launch options, as a front door settles them apart from the input. */
  readonly options?: Readonly<Record<string, string>>;
  readonly decision: string;
  /** The Run this one was started from. */
  readonly parent?: string;
}) =>
  session(
    Effect.gen(function* () {
      const made = yield* loaded(options.entry, options.runId);
      const store = yield* Store;
      yield* admit({
        runId: options.runId,
        workflow: made.workflow.name,
        input: options.input,
        options: options.options,
        parent: options.parent,
      });
      return yield* Effect.gen(function* () {
        yield* made.workflow.execute(
          { runId: options.runId, input: options.input },
          { discard: true },
        );
        return yield* until(
          () => store.asked(options.runId),
          (rows) => rows.some((row) => row.decision === options.decision),
        );
      }).pipe(Effect.provide(made.layer));
    }),
  );

/** The human answers, in a host that never saw the attempt that asked. */
const answered = (options: {
  readonly entry: string;
  readonly runId: string;
  readonly input: Readonly<Record<string, Schema.Json>>;
  readonly decision: string;
  readonly value: string;
}) =>
  session(
    Effect.gen(function* () {
      const made = yield* loaded(options.entry, options.runId);
      const payload = { runId: options.runId, input: options.input };
      return yield* Effect.gen(function* () {
        yield* answerDecision(made, {
          name: options.decision,
          executionId: yield* made.workflow.executionId(payload),
          value: options.value,
        }).pipe(Effect.orDie);
        return yield* made.workflow.execute(payload).pipe(Effect.result);
      }).pipe(Effect.provide(made.layer));
    }),
  );

/** The human answers, and the Run goes on until it is waiting on the next question. */
const answeredThen = (options: {
  readonly entry: string;
  readonly runId: string;
  readonly input: Readonly<Record<string, Schema.Json>>;
  readonly decision: string;
  readonly value: string;
  readonly until: string;
}) =>
  session(
    Effect.gen(function* () {
      const made = yield* loaded(options.entry, options.runId);
      const store = yield* Store;
      const payload = { runId: options.runId, input: options.input };
      return yield* Effect.gen(function* () {
        yield* answerDecision(made, {
          name: options.decision,
          executionId: yield* made.workflow.executionId(payload),
          value: options.value,
        }).pipe(Effect.orDie);
        yield* made.workflow.execute(payload, { discard: true });
        return yield* until(
          () => store.asked(options.runId),
          (rows) => rows.some((row) => row.decision === options.until && row.answer === null),
        );
      }).pipe(Effect.provide(made.layer));
    }),
  );

/** What a question takes, as the store keeps it: the options are JSON on the row. */
const optionsOf = (
  rows: ReadonlyArray<{ readonly decision: string; readonly options: string }>,
  decision: string,
): ReadonlyArray<string> =>
  Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Array(Schema.String)))(
    rows.find((row) => row.decision === decision)?.options ?? "[]",
  );

const said = (result: { readonly _tag: string; readonly success?: unknown }) =>
  result._tag === "Success" ? String(result.success) : "";

/** Every message herdr was asked to deliver, in order; each names the work it is about. */
const prompts = () =>
  rig
    .calls()
    .pipe(
      Effect.map((calls) =>
        calls.filter((call) => call.cmd === "agent prompt").map((call) => call.argv?.[3] ?? ""),
      ),
    );

/** The Clearance line typed with an operation's step message, or "" for none. */
const clearance = (runId: string, operation: string) =>
  prompts().pipe(
    Effect.map(
      (typed) =>
        typed
          .find((one) => one.includes(`${dir}/agents/${runId}/${operation}.prompt.md`))
          ?.split("\n")
          .find((line) => line.startsWith("Cleared for this step: ")) ?? "",
    ),
  );

/** The branch of the checkout an operation was told it works in. */
const checkoutBranch = (runId: string, operation = "mr") =>
  Effect.gen(function* () {
    const root = /^Project root: (.+)$/m.exec(yield* asked(runId, operation))?.[1];
    return (yield* exec(["git", "rev-parse", "--abbrev-ref", "HEAD"], { cwd: root })).stdout.trim();
  });

/** What an operation was actually asked, which is the file its message named. */
const asked = (runId: string, operation: string) =>
  FileSystem.FileSystem.pipe(
    Effect.flatMap((fs) => fs.readFileString(`${dir}/agents/${runId}/${operation}.prompt.md`)),
    Effect.orDie,
  );

/** Whether an operation was asked anything at all. */
const wasAsked = (runId: string, operation: string) =>
  FileSystem.FileSystem.pipe(
    Effect.flatMap((fs) => fs.exists(`${dir}/agents/${runId}/${operation}.prompt.md`)),
    Effect.orDie,
  );

const persona = (runId: string, operation: string) =>
  FileSystem.FileSystem.pipe(
    Effect.flatMap((fs) => fs.readFileString(`${dir}/agents/${runId}/${operation}.persona.md`)),
    Effect.orElseSucceed(() => ""),
  );

const REPORT = {
  verdict: "clean",
  findings: [],
  report: "plan/ARCHITECTURE.md",
  applied: ["merged the two registries"],
  deferred: [],
  slug: "one-registry",
  outcome: "refactor",
};

scenario(
  "Flow: architecture's report is done while its menu needs you",
  () =>
    runEffect(
      Effect.gen(function* () {
        yield* rig.queueOutputs([REPORT]);
        yield* parked({
          entry: shipped("architecture"),
          runId: "r-architecture-flow",
          input: { goal: "Find the next improvement" },
          decision: "next",
        });
        const lane = yield* laneNow("r-architecture-flow", "waiting");
        expect(lane.nodes.map((node) => [node.title, node.state, node.declared])).toEqual([
          ["Architecture", "done", true],
          ["What next", "needs-you", true],
        ]);
      }),
    ),
  120_000,
);

scenario(
  "architecture reads the project it was started for, as the architect, with the skill started",
  () =>
    runEffect(
      Effect.gen(function* () {
        yield* rig.queueOutputs([REPORT]);

        yield* parked({
          entry: shipped("architecture"),
          runId: "r-arch",
          input: { goal: "why are there two registries" },
          decision: "next",
        });

        // A skill that refuses a model's own invocation is started as a human starts one.
        expect((yield* prompts())[0]?.startsWith("/improve-codebase-architecture ")).toBe(true);
        // The content is the Markdown's, with this Run's own directory rendered into it.
        const work = yield* asked("r-arch", "architecture");
        expect(work).toContain(`Report: ${runDir(dir, "r-arch")}/plan/ARCHITECTURE.md`);
        expect(work).toContain(`Project root: ${rig.projectDir}`);
        expect(work).toContain("why are there two registries");
        // And the persona is the Markdown persona, with its skills as paths to read.
        const body = yield* persona("r-arch", "architecture");
        expect(body).toContain("You are an architect");
        expect(body).toContain("improve-codebase-architecture/SKILL.md");
        expect((yield* launched())[0]?.args).toContain("--model opus --effort high");
      }),
    ),
  120_000,
);

/** What a planner or architect rooted at the Projects root is told about it. */
const ROOTED = "it is not a repository: find the\nrepositories under it";

scenario(
  "architecture at the Projects root is told the root is not a repository, and elsewhere is not",
  () =>
    runEffect(
      Effect.gen(function* () {
        yield* rig.queueOutputs([REPORT, REPORT]);
        yield* parked({
          entry: shipped("architecture"),
          runId: "r-arch-root",
          input: { goal: "why are there two registries" },
          options: { workspace: "projects-root" },
          decision: "next",
        });
        yield* parked({
          entry: shipped("architecture"),
          runId: "r-arch-here",
          input: { goal: "why are there two registries" },
          decision: "next",
        });

        const rooted = yield* asked("r-arch-root", "architecture");
        expect(rooted).toContain(ROOTED);
        expect(rooted).toContain("Each ticket's `Repo:` is a path relative to\nit.");
        expect(yield* asked("r-arch-here", "architecture")).not.toContain(ROOTED);
      }),
    ),
  120_000,
);

scenario(
  "implement now builds the plan the architect wrote, named and classified by the report",
  () =>
    runEffect(
      Effect.gen(function* () {
        yield* rig.queueOutputs([REPORT]);
        yield* parked({
          entry: shipped("architecture"),
          runId: "r-arch-go",
          input: { goal: "why are there two registries" },
          decision: "next",
        });

        const result = yield* answered({
          entry: shipped("architecture"),
          runId: "r-arch-go",
          input: { goal: "why are there two registries" },
          decision: "next",
          value: "Implement now",
        });

        expect(said(result)).toContain("plan/ARCHITECTURE.md");
        expect(started).toHaveLength(1);
        expect(started[0]?.workflow).toBe("implement");
        expect(started[0]?.input).toEqual({ plan: `${runDir(dir, "r-arch-go")}/plan` });
        // What the work is called and what it proves; where it works is the child's own.
        expect(started[0]?.options).toEqual({ task: "one-registry", outcome: "refactor" });
      }),
    ),
  120_000,
);

scenario(
  "stop here is an answer: nothing is started, and the run says where the report is",
  () =>
    runEffect(
      Effect.gen(function* () {
        yield* rig.queueOutputs([REPORT]);
        yield* parked({
          entry: shipped("architecture"),
          runId: "r-arch-stop",
          input: { goal: "why are there two registries" },
          decision: "next",
        });

        const result = yield* answered({
          entry: shipped("architecture"),
          runId: "r-arch-stop",
          input: { goal: "why are there two registries" },
          decision: "next",
          value: "Stop here",
        });

        expect(said(result)).toBe("plan/ARCHITECTURE.md: stopped there");
        expect(started).toEqual([]);
      }),
    ),
  120_000,
);

const GRILLED = {
  verdict: "clean",
  findings: [],
  slug: "one-registry",
  outcome: "feature",
  decided: ["we keep the old ids"],
};
const SPEC = { verdict: "clean", findings: [], spec: "plan/SPEC.md" };
const TICKETS = { verdict: "clean", findings: [], issues_dir: "plan/issues", tickets: 3 };
const GOAL = { goal: "make the registries one" };
/** What a start passes for implement to end at its merge request without asking. */
// oxlint-disable-next-line unicorn/no-thenable -- implement's Input is named `then`
const FINISH = { then: "finish" } as const;

scenario("a plan at the Projects root is told the root is not a repository", () =>
  runEffect(
    Effect.gen(function* () {
      yield* rig.queueOutputs([GRILLED, SPEC, TICKETS]);
      yield* parked({
        entry: shipped("plan"),
        runId: "r-plan-root",
        input: GOAL,
        options: { workspace: "projects-root" },
        decision: "next-1",
      });

      const interview = yield* asked("r-plan-root", "grill");
      expect(interview).toContain(ROOTED);
      expect(interview).toContain("Each ticket's `Repo:` is a path relative to\nit.");
    }),
  ),
);

scenario(
  "an implementer asks its live planner through a recorded Delivery",
  () =>
    runEffect(
      Effect.gen(function* () {
        yield* rig.queueOutputs([GRILLED, SPEC, TICKETS]);
        yield* parked({ entry: shipped("plan"), runId: "r-plan", input: GOAL, decision: "next-1" });
        const planner = (yield* everyRegistered(hostOf().env.stateDir)).find(
          (one) => one.runId === "r-plan",
        )!;
        const route = yield* session(
          Agents.pipe(Effect.flatMap((agents) => agents.askRoute("planner", ["r-impl", "r-plan"]))),
        );
        expect(route).toContain(`collie_do deliver to r-plan, agent ${planner.agent}`);
        expect(route).not.toContain("herdr agent prompt");
        const sent = yield* session(
          Agents.pipe(
            Effect.flatMap((agents) =>
              agents.steer({
                runId: "r-plan",
                agent: planner.agent,
                text: "Which ticket first?",
                request: "planner-question",
                mode: "boundary",
                actor: {
                  origin: "agent",
                  from: {
                    run: "r-impl",
                    agent: "implementer",
                    machine: { name: "laptop", installation: "laptop-installation" },
                  },
                },
              }),
            ),
          ),
        );
        expect(sent.delivered).toBe(true);
        expect((yield* prompts()).at(-1)).toContain("From implementer of r-impl on laptop.");
        expect(
          (yield* deliveriesOf(hostOf().env.stateDir, "r-plan")).some(
            (one) =>
              one.delivery.cause.ref === "planner-question" && SENT_STATES.has(one.delivery.state),
          ),
        ).toBe(true);
      }),
    ),
  120_000,
);

scenario(
  "plan interviews, writes the spec and cuts the tickets — one planner, its two skills started",
  () =>
    runEffect(
      Effect.gen(function* () {
        yield* rig.queueOutputs([GRILLED, SPEC, TICKETS]);

        yield* parked({
          entry: shipped("plan"),
          runId: "r-plan",
          input: GOAL,
          decision: "next-1",
        });

        // One agent for the whole plan: the interview is still in the agent that writes
        // the spec, which is why the spec needs no second telling of what was decided.
        const starts = yield* rig
          .cmds()
          .pipe(Effect.map((cmds) => cmds.filter((cmd) => cmd === "agent start")));
        expect(starts).toHaveLength(1);

        const sent = yield* prompts();
        expect(sent).toHaveLength(3);
        const interview = yield* asked("r-plan", "grill");
        expect(interview).toContain("make the registries one");
        expect(interview).not.toContain(ROOTED);
        expect(interview).toContain(`collie run answer r-plan "Implement now"`);
        // The two skills that write the plan are started, not merely mentioned: both
        // refuse an agent that invokes them itself.
        expect(sent[1]?.startsWith("/to-spec ")).toBe(true);
        expect(sent[2]?.startsWith("/to-tickets ")).toBe(true);
        expect(yield* asked("r-plan", "spec")).toContain(
          `Write the spec to \`${runDir(dir, "r-plan")}/plan/SPEC.md\``,
        );
        for (const operation of ["grill", "spec", "tickets"])
          expect(yield* asked("r-plan", operation)).not.toContain(UNATTENDED);
        expect(yield* persona("r-plan", "grill")).toContain("You are a planner");
        // A changelog is for a rewrite, which none of the first three steps is.
        for (const step of ["grill", "spec", "tickets"])
          expect([step, (yield* asked("r-plan", step)).includes("changelog")]).toEqual([
            step,
            false,
          ]);
        expect((yield* persona("r-plan", "grill")).replace(/\s+/g, " ")).toContain(
          "Write a `changelog` only when a step asks for one",
        );
        expect((yield* asked("r-plan", "spec")).replace(/\s+/g, " ")).toContain(
          "the spec does not restate them",
        );
        expect((yield* launched())[0]?.args).toContain("--model opus --effort high");
      }),
    ),
  120_000,
);

scenario(
  "a planner is told its Run's Checks are the gate, never a ticket's criterion, and which they are",
  () =>
    runEffect(
      Effect.gen(function* () {
        yield* rig.queueOutputs([GRILLED, SPEC, TICKETS]);
        yield* approve("r-plan-checks", ["check"]);
        yield* parked({
          entry: shipped("plan"),
          runId: "r-plan-checks",
          input: GOAL,
          decision: "next-1",
        });

        const told = (yield* asked("r-plan-checks", "tickets")).replace(/\s+/g, " ");
        expect(told).toContain("The Run's own Checks are already the gate");
        expect(told).toContain("never a ticket's criterion");
        expect(told).toContain(`This Run's Checks: - check: true (in ${rig.projectDir})`);
      }),
    ),
  120_000,
);

scenario(
  "a planner whose Run has no Checks is told the gate's rule without a list",
  () =>
    runEffect(
      Effect.gen(function* () {
        yield* rig.queueOutputs([GRILLED, SPEC, TICKETS]);
        yield* parked({
          entry: shipped("plan"),
          runId: "r-plan-no-checks",
          input: GOAL,
          decision: "next-1",
        });

        const told = (yield* asked("r-plan-no-checks", "tickets")).replace(/\s+/g, " ");
        expect(told).toContain("The Run's own Checks are already the gate");
        expect(told).toContain("never a ticket's criterion");
        expect(told).not.toContain("This Run's Checks:");
      }),
    ),
  120_000,
);

scenario(
  "implement now builds the tickets, under the name and the kind the interview settled",
  () =>
    runEffect(
      Effect.gen(function* () {
        yield* rig.queueOutputs([GRILLED, SPEC, TICKETS]);
        yield* parked({
          entry: shipped("plan"),
          runId: "r-plan-go",
          input: GOAL,
          decision: "next-1",
        });

        const result = yield* answered({
          entry: shipped("plan"),
          runId: "r-plan-go",
          input: GOAL,
          decision: "next-1",
          value: "Implement now",
        });

        expect(said(result)).toContain("Implement now");
        expect(started).toHaveLength(1);
        expect(started[0]?.workflow).toBe("implement");
        expect(started[0]?.input).toEqual({ plan: `${runDir(dir, "r-plan-go")}/plan` });
        // What the work is called and what it proves; where it works is the child's own.
        expect(started[0]?.options).toEqual({ task: "one-registry", outcome: "feature" });
      }),
    ),
  120_000,
);

scenario(
  "architecture first starts the architect on the plan's own goal",
  () =>
    runEffect(
      Effect.gen(function* () {
        yield* rig.queueOutputs([GRILLED, SPEC, TICKETS]);
        yield* parked({
          entry: shipped("plan"),
          runId: "r-plan-arch",
          input: GOAL,
          decision: "next-1",
        });

        yield* answered({
          entry: shipped("plan"),
          runId: "r-plan-arch",
          input: GOAL,
          decision: "next-1",
          value: "Architecture first",
        });

        expect(started).toHaveLength(1);
        expect(started[0]?.workflow).toBe("architecture");
        expect(started[0]?.input).toEqual(GOAL);
      }),
    ),
  120_000,
);

/** Checkouts under the project, and a plan in the Run's own directory whose tickets name them. */
const repositories = (
  runId: string,
  tickets: ReadonlyArray<{
    readonly file: string;
    readonly repo: string;
    readonly blockedBy?: string;
  }>,
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const issues = `${runDir(dir, runId)}/plan/issues`;
    yield* fs.makeDirectory(issues, { recursive: true });
    yield* fs.writeFileString(`${runDir(dir, runId)}/plan/SPEC.md`, "# The spec\n");
    for (const ticket of tickets) {
      yield* fs.makeDirectory(`${rig.projectDir}/${ticket.repo}/.git`, { recursive: true });
      yield* fs.writeFileString(
        `${issues}/${ticket.file}`,
        `# ${ticket.file}\n\n**Repo:** ${ticket.repo}\n\n**Blocked by:** ${ticket.blockedBy ?? "None"}\n`,
      );
    }
  });

const THREE_REPOS = [
  { file: "01-api.md", repo: "api" },
  { file: "02-web.md", repo: "web", blockedBy: "01" },
  { file: "03-docs.md", repo: "docs" },
];

scenario(
  "implement now on a plan that spans repositories hands the whole plan to one implement",
  () =>
    runEffect(
      Effect.gen(function* () {
        yield* rig.queueOutputs([GRILLED, SPEC, TICKETS]);
        yield* repositories("r-plan-fan", THREE_REPOS);
        yield* parked({
          entry: shipped("plan"),
          runId: "r-plan-fan",
          input: GOAL,
          decision: "next-1",
        });

        yield* answered({
          entry: shipped("plan"),
          runId: "r-plan-fan",
          input: GOAL,
          decision: "next-1",
          value: "Implement now",
        });

        expect(started.map((one) => [one.invocation, one.input, one.options])).toEqual([
          [
            "implement",
            { plan: `${runDir(dir, "r-plan-fan")}/plan` },
            { task: "one-registry", outcome: "feature" },
          ],
        ]);
      }),
    ),
  120_000,
);

const isReasoned = Schema.is(Schema.Struct({ reason: Schema.String }));
const reasonOf = (result: { readonly _tag: string; readonly failure?: unknown }) =>
  result._tag === "Failure" && isReasoned(result.failure) ? result.failure.reason : "";

scenario(
  "a hold before Repo runs suspends the parent and continues every repository after release",
  () =>
    runEffect(
      Effect.gen(function* () {
        const runId = "r-impl-fan-held";
        yield* repositories(runId, THREE_REPOS);
        const options = {
          entry: shipped("implement"),
          runId,
          input: { plan: `${runDir(dir, runId)}/plan`, ...FINISH },
        };
        const fs = yield* FileSystem.FileSystem;
        yield* fs.writeFileString(controlPath(dir, HOLD, runId), "");
        const status = yield* stalled(options).pipe(Effect.timeout("5 seconds"));
        expect(status).toBe("suspended");
        expect(started).toEqual([]);
        yield* fs.remove(controlPath(dir, HOLD, runId));
        expect(said(yield* resumed(options))).toContain("3 repositories built in 2 wave(s)");
        expect(started.map((one) => one.invocation)).toEqual([
          "implement-api",
          "implement-docs",
          "implement-web",
        ]);
      }),
    ),
  120_000,
);

scenario(
  "implement on a plan that spans repositories is one Run of itself per repository, in waves",
  () =>
    runEffect(
      Effect.gen(function* () {
        yield* repositories("r-impl-fan", THREE_REPOS);
        const plan = `${runDir(dir, "r-impl-fan")}/plan`;

        const result = yield* ran({
          entry: shipped("implement"),
          runId: "r-impl-fan",
          input: { plan, ...FINISH },
          options: { task: "one-registry", outcome: "feature" },
        });

        expect(said(result)).toContain("3 repositories built in 2 wave(s)");
        // The repositories nothing waits on first, then the one waiting on the api.
        expect(started.map((one) => [one.invocation, one.workflow, one.options])).toEqual(
          ["api", "docs", "web"].map((repo) => [
            `implement-${repo}`,
            "self",
            {
              repo,
              workspace: `${rig.projectDir}/${repo}`,
              task: "one-registry",
              outcome: "feature",
            },
          ]),
        );
        // Nobody attends a repository's share, so each ends at its merge request.
        expect(started.map((one) => one.input)).toEqual(
          ["api", "docs", "web"].map(() => ({ plan, ...FINISH })),
        );
        // The parent builds nothing itself, and asks nothing.
        expect(yield* questions("r-impl-fan")).toEqual([]);
        expect(yield* prompts()).toEqual([]);
      }),
    ),
  120_000,
);

scenario(
  "a repository that does not build starts no further wave",
  () =>
    runEffect(
      Effect.gen(function* () {
        failing = new Set(["implement-api"]);
        yield* repositories("r-impl-stop", THREE_REPOS);

        const result = yield* ran({
          entry: shipped("implement"),
          runId: "r-impl-stop",
          input: { plan: `${runDir(dir, "r-impl-stop")}/plan` },
        });

        expect(started.map((one) => one.invocation)).toEqual(["implement-api", "implement-docs"]);
        expect(reasonOf(result)).toContain("api did not build. Not run: web, waiting on api.");
        // Named for nothing, every repository's branch is named after the Run that fanned out.
        expect(new Set(started.map((one) => one.options?.task))).toEqual(new Set(["r-impl-stop"]));
      }),
    ),
  120_000,
);

scenario(
  "each repository builds the branch, under the review axes, its fan-out was started with",
  () =>
    runEffect(
      Effect.gen(function* () {
        yield* repositories("r-impl-carry", THREE_REPOS);

        yield* ran({
          entry: shipped("implement"),
          runId: "r-impl-carry",
          input: { plan: `${runDir(dir, "r-impl-carry")}/plan` },
          options: { branch: "topic", risks: "security" },
        });

        expect(started.map((one) => one.options)).toEqual(
          ["api", "docs", "web"].map((repo) => ({
            branch: "topic",
            risks: "security",
            repo,
            workspace: `${rig.projectDir}/${repo}`,
          })),
        );
      }),
    ),
  120_000,
);

scenario(
  "a repository's share that stops on a blocking finding fails, so no wave waits on it",
  () =>
    runEffect(
      Effect.gen(function* () {
        yield* noMergeRequests;
        yield* repository();
        const plan = yield* planOf([{ file: "01-only.md", title: "the only one", checks: "unit" }]);
        const blocked = {
          ...BUILT,
          verdict: "findings",
          findings: [
            {
              severity: "blocker",
              title: "the schema will not migrate",
              file: "db",
              detail: "existing rows cannot be decoded",
            },
          ],
        };
        yield* approve("r-impl-share", ["unit"]);
        const reviewed = { ...CLEAN_SYNTHESIS, verdict: "findings", findings: blocked.findings };
        yield* rig.queueOutputs([
          blocked,
          reviewed,
          { verdict: "clean", fixed: [], disputed: [], checks: [] },
          reviewed,
        ]);

        const result = yield* ran({
          entry: shipped("implement"),
          runId: "r-impl-share",
          input: { plan, ...FINISH },
          options: { repo: "api" },
        });

        expect(result._tag).toBe("Failure");
        expect(reasonOf(result)).toContain("no_progress");
        expect(yield* asked("r-impl-share", "build.review-1")).toContain(
          "the schema will not migrate",
        );
        expect(yield* prompts()).toHaveLength(4);
      }),
    ),
  120_000,
);

scenario(
  "an implement Run that stops short of its merge request fails with the reason: a ticket left blocking",
  () =>
    runEffect(
      Effect.gen(function* () {
        yield* noMergeRequests;
        yield* repository();
        const plan = yield* planOf([{ file: "01-only.md", title: "the only one", checks: "unit" }]);
        const blocked = {
          ...BUILT,
          verdict: "findings",
          findings: [
            {
              severity: "blocker",
              title: "the schema will not migrate",
              file: "db",
              detail: "existing rows cannot be decoded",
            },
          ],
        };
        yield* approve("r-impl-blocked", ["unit"]);
        const reviewed = { ...CLEAN_SYNTHESIS, verdict: "findings", findings: blocked.findings };
        yield* rig.queueOutputs([
          blocked,
          reviewed,
          { verdict: "clean", fixed: [], disputed: [], checks: [] },
          reviewed,
        ]);

        const result = yield* ran({
          entry: shipped("implement"),
          runId: "r-impl-blocked",
          input: { plan, ...FINISH },
        });

        expect(result._tag).toBe("Failure");
        expect(reasonOf(result)).toContain("build: no_progress");
        expect(reasonOf(result)).toContain("Continue with a follow-up Run to finish delivery.");
        expect((yield* prompts()).join("\n")).not.toContain("r-impl-blocked/mr.prompt.md");
      }),
    ),
  120_000,
);

scenario(
  "an implement Run that stops short of its merge request fails with the reason: fix_unverified",
  () =>
    runEffect(
      Effect.gen(function* () {
        yield* noMergeRequests;
        yield* repository();
        const plan = yield* planOf([{ file: "01-only.md", title: "the only one", checks: "unit" }]);
        yield* approve("r-impl-unverified", ["unit"]);
        const blocking = (title: string) => ({
          ...CLEAN_SYNTHESIS,
          verdict: "findings",
          findings: [{ severity: "blocker", title, file: "db", detail: "it goes wrong" }],
        });
        const fixed = (title: string, checks: ReadonlyArray<{ name: string }> = []) => ({
          verdict: "clean",
          fixed: [{ title, file: "db" }],
          disputed: [],
          checks,
        });
        yield* rig.queueOutputs([
          BUILT,
          blocking("first"),
          fixed("first"),
          blocking("second"),
          fixed("second"),
          blocking("third"),
          fixed("third"),
          blocking("fourth"),
          // Nothing was ever run under that name, so the last fix's word for it buys nothing.
          fixed("fourth", [{ name: "unit" }]),
        ]);

        const result = yield* ran({
          entry: shipped("implement"),
          runId: "r-impl-unverified",
          input: { plan, ...FINISH },
        });

        expect(result._tag).toBe("Failure");
        expect(reasonOf(result)).toContain(
          `fix_unverified: check "unit" has no verification record`,
        );
        expect(reasonOf(result)).toContain("Continue with a follow-up Run to finish delivery.");
        expect((yield* prompts()).join("\n")).not.toContain("r-impl-unverified/mr.prompt.md");
      }),
    ),
  120_000,
);

scenario(
  "a plan the fan-out cannot run starts nothing, and the menu comes back",
  () =>
    runEffect(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        yield* rig.queueOutputs([GRILLED, SPEC, TICKETS]);
        yield* repositories("r-plan-gone", THREE_REPOS);
        yield* parked({
          entry: shipped("plan"),
          runId: "r-plan-gone",
          input: GOAL,
          decision: "next-1",
        });
        yield* fs.remove(`${rig.projectDir}/web/.git`, { recursive: true });

        yield* answeredThen({
          entry: shipped("plan"),
          runId: "r-plan-gone",
          input: GOAL,
          decision: "next-1",
          value: "Implement now",
          until: "next-2",
        });

        expect(started).toEqual([]);
        expect(yield* fs.readFileString(`${runDir(dir, "r-plan-gone")}/log.txt`)).toContain(
          "Implement now cannot run here: These repositories are named by a ticket but not checked out",
        );
      }),
    ),
  120_000,
);

scenario(
  "tickets nobody can build go back to the planner once, and a plan still unbuildable fails",
  () =>
    runEffect(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        yield* rig.queueOutputs([GRILLED, SPEC, TICKETS, TICKETS]);
        yield* repositories("r-plan-bad", THREE_REPOS);
        yield* fs.writeFileString(
          `${runDir(dir, "r-plan-bad")}/plan/issues/04-loose.md`,
          "# 04-loose.md\n",
        );

        const result = yield* ran({ entry: shipped("plan"), runId: "r-plan-bad", input: GOAL });

        expect(yield* asked("r-plan-bad", "unbuildable")).toContain("04-loose.md");
        expect(result._tag).toBe("Failure");
        expect(started).toEqual([]);
      }),
    ),
  120_000,
);

const UNATTENDED = "Nobody is watching this Run";

const questions = (runId: string) =>
  session(Store.pipe(Effect.flatMap((store) => store.asked(runId))));

scenario(
  "a plan started to build interviews, specs and tickets unattended, then implements without asking",
  () =>
    runEffect(
      Effect.gen(function* () {
        yield* rig.queueOutputs([GRILLED, SPEC, TICKETS]);

        const result = yield* ran({
          entry: shipped("plan"),
          runId: "r-plan-alone",
          input: { ...GOAL, then: "implement" },
        });

        expect(said(result)).toContain("Implement now");
        expect(yield* questions("r-plan-alone")).toEqual([]);
        for (const operation of ["grill", "spec", "tickets"]) {
          const prompt = yield* asked("r-plan-alone", operation);
          expect(prompt).toContain(UNATTENDED);
          expect(prompt).not.toContain("collie run answer");
        }
        expect(started.map((one) => [one.workflow, one.input, one.options])).toEqual([
          [
            "implement",
            { plan: `${runDir(dir, "r-plan-alone")}/plan`, ...FINISH },
            { task: "one-registry", outcome: "feature" },
          ],
        ]);
      }),
    ),
  120_000,
);

scenario(
  "Flow: while plan's spec agent works, Grill is done, Spec runs on its agent and the rest is expected",
  () =>
    runEffect(
      Effect.gen(function* () {
        const lane = yield* laneWhen({
          entry: shipped("plan"),
          runId: "r-plan-flow",
          input: GOAL,
          ready: (one) =>
            nodeIn(one, "spec")?.state === "running" && nodeIn(one, "spec")?.ranOn != null,
          outputs: [GRILLED],
          working: { operation: "spec", output: SPEC },
          rest: [TICKETS],
        });
        expect(lane.nodes.map((node) => [node.title, node.state, node.declared])).toEqual([
          ["Grill", "done", true],
          ["Spec", "running", true],
          ["Tickets", "expected", true],
          ["End menu", "expected", true],
        ]);
        expect(nodeIn(lane, "spec")!.ranOn).toBe("claude/opus high");
      }),
    ),
  120_000,
);

scenario(
  "Flow: a plan answered Refine and then Finish planning has one End menu of two runs, and Refine off the path",
  () =>
    runEffect(
      Effect.gen(function* () {
        const revised = { verdict: "clean", findings: [], changelog: "split ticket 3 in two" };
        yield* rig.queueOutputs([GRILLED, SPEC, TICKETS, revised]);
        const plan = { entry: shipped("plan"), runId: "r-plan-refined", input: GOAL };
        yield* parked({ ...plan, decision: "next-1" });
        yield* answeredThen({ ...plan, decision: "next-1", value: "Refine", until: "next-2" });
        const result = yield* answered({ ...plan, decision: "next-2", value: "Finish planning" });
        expect(said(result)).toContain("finished planning");

        const lane = yield* laneNow("r-plan-refined", "succeeded");
        expect(
          lane.nodes.filter((node) => node.id === "menu").map((node) => node.runs.length),
        ).toEqual([2]);
        expect(
          lane.nodes.filter((node) => node.id === "refine").map((node) => node.offPath),
        ).toEqual([true]);
      }),
    ),
  120_000,
);

scenario(
  "Flow: a plan started to build never reaches its End menu, which is not run",
  () =>
    runEffect(
      Effect.gen(function* () {
        yield* rig.queueOutputs([GRILLED, SPEC, TICKETS]);
        yield* ran({
          entry: shipped("plan"),
          runId: "r-plan-flow-alone",
          input: { ...GOAL, then: "implement" },
        });
        expect(statesOf(yield* laneNow("r-plan-flow-alone", "succeeded"))).toEqual([
          ["grill", "done"],
          ["spec", "done"],
          ["tickets", "done"],
          ["menu", "not-run"],
        ]);
      }),
    ),
  120_000,
);

scenario(
  "a plan started to build whose tickets cannot be built fails with why, and asks nothing",
  () =>
    runEffect(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        yield* rig.queueOutputs([GRILLED, SPEC, TICKETS, TICKETS]);
        yield* repositories("r-plan-alone-bad", THREE_REPOS);
        yield* fs.remove(`${rig.projectDir}/web/.git`, { recursive: true });

        const result = yield* ran({
          entry: shipped("plan"),
          runId: "r-plan-alone-bad",
          input: { ...GOAL, then: "implement" },
        });

        expect(reasonOf(result)).toContain(
          "These repositories are named by a ticket but not checked out",
        );
        expect(yield* questions("r-plan-alone-bad")).toEqual([]);
        expect(started).toEqual([]);
      }),
    ),
  120_000,
);

scenario(
  "a second opinion is another reviewer's, the planner revises from it, and the menu comes back",
  () =>
    runEffect(
      Effect.gen(function* () {
        const opinion = {
          verdict: "findings",
          findings: [
            { severity: "major", title: "ticket 3 cannot land on its own", file: "plan/issues" },
          ],
        };
        const revised = { verdict: "clean", findings: [], changelog: "split ticket 3 in two" };
        yield* rig.queueOutputs([GRILLED, SPEC, TICKETS, opinion, revised]);
        yield* parked({
          entry: shipped("plan"),
          runId: "r-plan-two",
          input: GOAL,
          decision: "next-1",
        });

        yield* answeredThen({
          entry: shipped("plan"),
          runId: "r-plan-two",
          input: GOAL,
          decision: "next-1",
          value: "Second opinion",
          until: "next-2",
        });

        // A reviewer of its own — the planner that wrote the plan cannot second-guess it —
        // and then the planner, told what was found rather than sent to read it.
        const starts = yield* rig
          .cmds()
          .pipe(Effect.map((cmds) => cmds.filter((cmd) => cmd === "agent start")));
        expect(starts).toHaveLength(2);
        expect(yield* prompts()).toHaveLength(5);
        expect(yield* asked("r-plan-two", "second-opinion-1")).toContain(
          "Review the plan, not the code",
        );
        expect(yield* asked("r-plan-two", "revise-1")).toContain("ticket 3 cannot land on its own");
      }),
    ),
  120_000,
);

/**
 * A fork of a shipped workflow as a person keeps one: it spreads the original and changes
 * only which agent does which work, so every other part of it follows the original.
 */
const fork = (name: Shipped, id: string, agents: string) =>
  FileSystem.FileSystem.pipe(
    Effect.flatMap((fs) =>
      fs.writeFileString(
        `${rig.root}/user/workflows/${id}.workflow.ts`,
        [
          `import shipped from "${ROOT}workflows/${name}.workflow.ts";`,
          `import { defineWorkflow } from "collie";`,
          `export default defineWorkflow({ ...shipped, id: "${id}", agents: ${agents} });`,
          "",
        ].join("\n"),
      ),
    ),
    Effect.as(`${rig.root}/user/workflows/${id}.workflow.ts`),
    Effect.orDie,
  );

const launched = () =>
  rig.calls().pipe(
    Effect.map((calls) =>
      calls
        .map((call) => call.argv ?? [])
        .filter((argv) => argv[1] === "start")
        .map((argv) => ({
          kind: argv[argv.indexOf("--kind") + 1],
          args: argv.slice(argv.indexOf("--") + 1).join(" "),
        })),
    ),
  );

const REVIEW = {
  verdict: "findings",
  findings: [{ severity: "major", title: "the guard is on the wrong side", file: "src/a.ts" }],
};
const SYNTHESIS = {
  verdict: "findings",
  summary: "It moves the guard. It moves it to the wrong side of the branch.",
  findings: [{ severity: "major", title: "the guard is on the wrong side", file: "src/a.ts" }],
  dropped: [],
  fixed: [],
};

once(
  "a fork that moves the reviewer role has every reviewer of review there, and the rest is the original's",
  () =>
    runEffect(
      Effect.gen(function* () {
        const entry = yield* fork(
          "review",
          "review-on-pi",
          `{ ...shipped.agents, roles: { ...shipped.agents?.roles, reviewer: { harness: "pi", model: "openai-codex/gpt-6-astra", effort: "max" } } }`,
        );
        yield* rig.queueOutputs([SYNTHESIS]);
        yield* parked({
          entry,
          runId: "r-review-pi",
          input: { target: "branch:main...HEAD" },
          decision: "post-1",
        });

        for (const one of yield* launched()) {
          expect(one.kind).toBe("pi");
          expect(one.args).toContain("--model openai-codex/gpt-6-astra --thinking max");
        }
        expect(yield* launched()).toHaveLength(1);
        // What the reviewers are told is still the shipped review's.
        expect(yield* asked("r-review-pi", "review-1")).toContain(
          "Review target: branch:main...HEAD",
        );
      }),
    ),
  120_000,
);

once(
  "a fork that seats a panel of reviewers has one review from each, reconciled on the first seat",
  () =>
    runEffect(
      Effect.gen(function* () {
        const entry = yield* fork(
          "review",
          "review-panel",
          `{ ...shipped.agents, roles: { ...shipped.agents?.roles, reviewer: [{ harness: "claude", model: "opus", effort: "medium" }, { harness: "pi", model: "openai-codex/gpt-6-astra", effort: "max" }] } }`,
        );
        yield* rig.queueOutputs([REVIEW, REVIEW, SYNTHESIS]);
        yield* parked({
          entry,
          runId: "r-review-panel",
          input: { target: "branch:main...HEAD" },
          decision: "post-1",
        });

        const byPersona = Object.fromEntries(
          (yield* launched()).map((one) => [
            /agents\/r-review-panel\/([^ ]+)\.persona\.md/.exec(one.args)?.[1],
            one.kind,
          ]),
        );
        expect(byPersona).toEqual({ "review-1": "claude", "review-2": "pi", synthesize: "claude" });
        const fanIn = yield* asked("r-review-panel", "synthesize");
        expect(fanIn).toContain(`${dir}/agents/r-review-panel/review-1.json`);
        expect(fanIn).toContain(`${dir}/agents/r-review-panel/review-2.json`);
      }),
    ),
  120_000,
);

once(
  "a fork that moves plan's planner leaves the second opinion on the reviewer plan chose",
  () =>
    runEffect(
      Effect.gen(function* () {
        const entry = yield* fork(
          "plan",
          "plan-on-pi",
          `{ ...shipped.agents, harness: "pi", model: "openai-codex/gpt-6-astra", effort: "medium" }`,
        );
        const opinion = {
          verdict: "findings",
          findings: [
            { severity: "major", title: "ticket 3 cannot land on its own", file: "plan/issues" },
          ],
        };
        const revised = { verdict: "clean", findings: [], changelog: "split ticket 3 in two" };
        yield* rig.queueOutputs([GRILLED, SPEC, TICKETS, opinion, revised]);
        yield* parked({ entry, runId: "r-plan-pi", input: GOAL, decision: "next-1" });
        yield* answeredThen({
          entry,
          runId: "r-plan-pi",
          input: GOAL,
          decision: "next-1",
          value: "Second opinion",
          until: "next-2",
        });

        const [planner, reviewer] = yield* launched();
        expect(planner?.kind).toBe("pi");
        expect(planner?.args).toContain("--model openai-codex/gpt-6-astra --thinking medium");
        expect(reviewer?.kind).toBe("claude");
        expect(reviewer?.args).toContain("--model opus --effort high");
      }),
    ),
  120_000,
);

scenario(
  "review reviews the target, reconciles it, and leaves the prose and the findings behind",
  () =>
    runEffect(
      Effect.gen(function* () {
        yield* rig.queueOutputs([SYNTHESIS]);

        yield* parked({
          entry: shipped("review"),
          runId: "r-review",
          input: { target: "branch:main...HEAD" },
          options: { risks: "security" },
          decision: "post-1",
        });

        expect(yield* prompts()).toHaveLength(1);
        const first = yield* asked("r-review", "review-1");
        expect(first).toContain("Review target: branch:main...HEAD");
        // The axes a human asked for are on top of the complete review, said once.
        expect(first).toContain("Additional axes requested for this change: security");
        expect(first).toContain("Iteration 1 of at most 1");
        // One seat is one review: there is nothing for a synthesis to reconcile.
        expect(first).toContain("You may be the only reviewer of this change");

        const fs = yield* FileSystem.FileSystem;
        const where = runDir(dir, "r-review");
        expect(yield* fs.readFileString(`${where}/review.md`)).toContain("It moves the guard.");
        // Beside it, what a card counts: the prose is for the human, this is for the card.
        expect(yield* fs.readFileString(`${where}/findings.json`)).toContain(
          "the guard is on the wrong side",
        );
      }),
    ),
  120_000,
);

scenario(
  "review without its forge reviews the worktree and offers no Post",
  () =>
    runEffect(
      Effect.gen(function* () {
        const bin = yield* FakeBin.make(`${rig.root}/bin`);
        const forge = yield* forgeOnPath(bin, "github", {
          installed: true,
          loggedIn: [],
          login: null,
          mrs: [],
        });
        yield* repository();
        yield* rig.queueOutputs([SYNTHESIS]);
        const rows = yield* parked({
          entry: shipped("review"),
          runId: "r-review-without-forge",
          input: { target: "mr:github.com/owner/repo#30" },
          decision: "post-1",
        });
        expect(yield* asked("r-review-without-forge", "review-1")).toContain(
          "Review target: worktree",
        );
        expect(optionsOf(rows, "post-1")).toEqual(["Don't post"]);
        expect(forge.requests()).toEqual([]);
        expect((yield* forge.calls()).filter((line) => line.startsWith("pr "))).toEqual([]);
        yield* bin.restore();
      }),
    ),
  120_000,
);

scenario("an Input the review was not given is said to be not given", () =>
  runEffect(
    Effect.gen(function* () {
      yield* rig.queueOutputs([SYNTHESIS]);
      yield* parked({
        entry: shipped("review"),
        runId: "r-review-bare",
        input: { target: "branch:main...HEAD", plan: "", proves: "" },
        decision: "post-1",
      });

      const first = yield* asked("r-review-bare", "review-1");
      expect(first).toContain("Spec: not given");
      expect(first).toContain(
        "Outcome the change has to prove (not given means unclassified): not given",
      );
    }),
  ),
);

scenario(
  "posting is offered for a merge request and nothing else, and a note that did not land asks again",
  () =>
    runEffect(
      Effect.gen(function* () {
        yield* repository();
        yield* exec(["git", "branch", "feature"], { cwd: rig.projectDir });
        const worktrees = () =>
          exec(["git", "worktree", "list"], { cwd: rig.projectDir }).pipe(
            Effect.map((listed) => listed.stdout),
          );
        const before = yield* worktrees();
        yield* rig.queueOutputs([SYNTHESIS]);
        const target = "branch:main...feature";
        const rows = yield* parked({
          entry: shipped("review"),
          runId: "r-review-branch",
          input: { target },
          decision: "post-1",
        });

        // A branch is nothing to post a note on, so posting is not among the answers.
        expect(optionsOf(rows, "post-1")).toEqual([
          "Fix findings",
          "Fix findings in a full implement run",
          "Don't post",
        ]);

        const result = yield* answered({
          entry: shipped("review"),
          runId: "r-review-branch",
          input: { target },
          decision: "post-1",
          value: "Don't post",
        });
        expect(said(result)).toBe("1 finding(s), not posted");
        // Asking whether the branch can be fixed cuts no checkout of it.
        expect(yield* worktrees()).toBe(before);
      }),
    ),
  120_000,
);

scenario(
  "a merge request target is offered the post, and the fix is an implementer on this run",
  () =>
    runEffect(
      Effect.gen(function* () {
        const fixed = {
          verdict: "clean",
          findings: [],
          fixed: [{ title: "moved the guard" }],
          disputed: [],
          checks: [{ name: "test" }],
        };
        const settled = {
          verdict: "clean",
          summary: "It moves the guard. Nothing is wrong with it now.",
          findings: [],
          dropped: [],
          fixed: [{ title: "the guard is on the wrong side", file: "src/a.ts" }],
        };
        yield* rig.queueOutputs([SYNTHESIS, fixed, settled]);
        yield* repository();
        yield* exec(["git", "branch", "fix-the-guard"], { cwd: rig.projectDir });
        const bin = yield* FakeBin.make(`${rig.root}/bin`);
        yield* forgeOnPath(bin, "gitlab", {
          installed: true,
          loggedIn: [FORGE_HOST.gitlab],
          login: "tester",
          mrs: [
            {
              project: "gitlab.example.com/group/project",
              iid: "42",
              state: "open",
              sourceBranch: "fix-the-guard",
            },
          ],
        });
        const target = "mr:gitlab.example.com/group/project!42";
        const rows = yield* parked({
          entry: shipped("review"),
          runId: "r-review-mr",
          input: { target },
          decision: "post-1",
        });
        expect(optionsOf(rows, "post-1")).toContain("Post to merge request");

        yield* answeredThen({
          entry: shipped("review"),
          runId: "r-review-mr",
          input: { target },
          decision: "post-1",
          value: "Fix findings",
          until: "post-2",
        });

        // The fix is reviewed again at once: a round of the rally, not a fix taken on its word.
        expect(yield* prompts()).toHaveLength(3);
        expect(yield* asked("r-review-mr", "review-2-1")).toContain("Iteration 2");
        const fix = yield* asked("r-review-mr", "fix");
        expect(fix).toContain(`Project root: ${rig.root}/.herdr/worktrees/project/fix-the-guard`);
        expect(fix).toContain("the checkout of `fix-the-guard`");
        expect(yield* clearance("r-review-mr", "fix")).toBe(
          "Cleared for this step: pushing new commits to fix-the-guard on origin (https://gitlab.example.com/group/project) with a plain push.",
        );
        expect(fix).not.toContain("glab mr checkout");
        expect(fix).toContain("never the whole suite");
        expect(fix).not.toContain("Run the project's checks");
        expect(yield* persona("r-review-mr", "fix")).toContain("You are an implementer");
        // Nothing is left to fix after a clean review, so fixing is not offered again.
        const rows2 = yield* parked({
          entry: shipped("review"),
          runId: "r-review-mr",
          input: { target },
          decision: "post-2",
        });
        expect(optionsOf(rows2, "post-2")).not.toContain("Fix findings");
      }),
    ),
  120_000,
);

const REVIEWED = {
  gitlab: {
    diff: "glab mr diff '30' --repo 'gitlab.example.com/group/app'",
    view: "glab mr view '30' --repo 'gitlab.example.com/group/app'",
    other: "gh",
  },
  github: {
    diff: "gh pr diff '30' --repo 'owner/repo'",
    view: "gh pr view '30' --repo 'owner/repo'",
    other: "glab",
  },
} as const;

for (const name of ["gitlab", "github"] as const) {
  const noun = name === "gitlab" ? "merge request" : "pull request";
  const target = mrTarget(PROJECT[name], "30");
  /** The forge on PATH, holding the one merge request this review is of. */
  const reviewing = () =>
    Effect.gen(function* () {
      const bin = yield* FakeBin.make(`${rig.root}/bin`);
      const forge = yield* forgeOnPath(bin, name, {
        installed: true,
        loggedIn: [FORGE_HOST[name]],
        login: "tester",
        mrs: [{ project: PROJECT[name], iid: "30", state: "open", author: "ann" }],
      });
      return { bin, forge };
    });
  const posted = (runId: string, synthesis: typeof SYNTHESIS) =>
    Effect.gen(function* () {
      const { bin, forge } = yield* reviewing();
      yield* rig.queueOutputs([synthesis]);
      const rows = yield* parked({
        entry: shipped("review"),
        runId,
        input: { target },
        decision: "post-1",
      });
      expect(optionsOf(rows, "post-1")).toContain(`Post to ${noun}`);
      const review = yield* asked(runId, "review-1");
      expect(review).toContain(REVIEWED[name].diff);
      expect(review).toContain(REVIEWED[name].view);
      expect(review).not.toMatch(new RegExp(`\\b${REVIEWED[name].other}\\b`));
      const result = yield* answered({
        entry: shipped("review"),
        runId,
        input: { target },
        decision: "post-1",
        value: `Post to ${noun}`,
      });
      yield* bin.restore();
      return { said: said(result), model: yield* forge.model() };
    });

  scenario(
    `a review of a ${name} ${noun} reads it with that forge's commands, and posting a clean one approves it`,
    () =>
      runEffect(
        Effect.gen(function* () {
          const clean = { ...SYNTHESIS, verdict: "clean", findings: [] };
          const { said: message, model } = yield* posted(`r-review-${name}-clean`, clean);
          expect(message).toContain("and approved it");
          expect(Object.values(model.notes ?? {})).toHaveLength(1);
          expect(model.approved).toHaveLength(1);
        }),
      ),
    120_000,
  );

  scenario(
    `posting a review of a ${name} ${noun} with findings left notes it and approves nothing`,
    () =>
      runEffect(
        Effect.gen(function* () {
          const { said: message, model } = yield* posted(`r-review-${name}-findings`, SYNTHESIS);
          expect(message).toContain("posted the review to");
          expect(message).not.toContain("approve");
          expect(Object.values(model.notes ?? {})).toHaveLength(1);
          expect(model.approved ?? []).toEqual([]);
        }),
      ),
    120_000,
  );
}

scenario(
  "fix findings goes on by itself until a review is clean",
  () =>
    runEffect(
      Effect.gen(function* () {
        yield* noMergeRequests;
        const fixed = { verdict: "clean", findings: [], fixed: [], disputed: [], checks: [] };
        const other = {
          ...SYNTHESIS,
          findings: [
            { severity: "major", title: "the empty list is not guarded", file: "src/b.ts" },
          ],
        };
        const clean = { ...SYNTHESIS, verdict: "clean", findings: [] };
        yield* rig.queueOutputs([SYNTHESIS, fixed, other, fixed, clean]);
        const reviewed = yield* reviewedBranch();
        const target = "branch:main...feature";
        yield* parked({
          entry: shipped("review"),
          runId: "r-rally",
          input: { target },
          decision: "post-1",
        });
        const rows = yield* answeredThen({
          entry: shipped("review"),
          runId: "r-rally",
          input: { target },
          decision: "post-1",
          value: "Fix findings",
          until: "post-2",
        });
        // Review, fix, review, fix, review: the second fix nobody was asked about.
        expect(yield* prompts()).toHaveLength(5);
        // Pointed at the review it follows, which is where the second round's finding is.
        expect(yield* asked("r-rally", "fix-2")).toContain(`${runDir(dir, "r-rally")}/review.md`);
        expect(yield* asked("r-rally", "fix")).toContain(`Project root: ${reviewed}`);
        expect(yield* asked("r-rally", "fix-2")).toContain(`Project root: ${reviewed}`);
        const listed = yield* exec(["git", "worktree", "list", "--porcelain"], {
          cwd: rig.projectDir,
        });
        expect(listed.stdout.match(/^branch refs\/heads\/feature$/gm)).toHaveLength(1);
        // A clean review still asks, so a merge request review can still be posted.
        expect(optionsOf(rows, "post-2")).not.toContain("Fix findings");
      }),
    ),
  120_000,
);

scenario(
  "a review's fix works in the reviewed branch's own checkout, and is verified there",
  () =>
    runEffect(
      Effect.gen(function* () {
        yield* noMergeRequests;
        const reviewed = yield* reviewedBranch();
        const fs = yield* FileSystem.FileSystem;
        yield* fs.makeDirectory(evidenceDir(dir, "r-fix-tree"), { recursive: true });
        yield* fs.writeFileString(
          `${evidenceDir(dir, "r-fix-tree")}/approved.json`,
          asApproved([{ name: "unit", executable: "true", argv: [], cwd: "worktree" }]),
        );
        const fixed = { verdict: "clean", findings: [], fixed: [], disputed: [], checks: [] };
        yield* rig.queueOutputs([
          SYNTHESIS,
          fixed,
          { ...SYNTHESIS, verdict: "clean", findings: [] },
        ]);
        const target = "branch:main...feature";
        yield* parked({
          entry: shipped("review"),
          runId: "r-fix-tree",
          input: { target },
          decision: "post-1",
        });
        yield* answeredThen({
          entry: shipped("review"),
          runId: "r-fix-tree",
          input: { target },
          decision: "post-1",
          value: "Fix findings",
          until: "post-2",
        });

        const verified = (cwd: string) =>
          session(
            Host.pipe(
              Effect.flatMap((host) => host.verify({ runId: "r-fix-tree", name: "unit", cwd })),
              Effect.result,
            ),
          );
        const there = yield* verified(reviewed);
        expect(there._tag === "Failure" ? there.failure.reason : "").toBe("");
        expect(
          (yield* readVerifications(evidenceDir(dir, "r-fix-tree"))).map((one) => one.cwd),
        ).toEqual([reviewed]);
        const started = yield* verified(rig.projectDir);
        expect(started._tag === "Failure" ? started.failure.reason : "").toContain(
          "is not inside run r-fix-tree",
        );

        const fix = yield* asked("r-fix-tree", "fix");
        expect(fix).toContain(`Project root: ${reviewed}`);
        expect(fix).toContain("`collie verify -- <command>`");
        expect(fix).not.toContain("Do not push");
        expect(fix).toContain("has an open merge request");
        expect(fix).toContain("never force");
        expect(fix.replace(/\s+/g, " ")).toContain(
          "Collie checked before this round started that it does not merge itself once green",
        );
        expect(fix).toContain("has no open merge request, do not push");
        expect(fix).toContain("Never open or edit a merge request, and never comment");
        const section = fix.slice(fix.indexOf("The review is written"), fix.indexOf("OUTPUT_PATH"));
        expect(section).not.toMatch(/\b(glab|gh) /);
        expect(yield* asked("r-fix-tree", "review-2-1")).toContain(`Project root: ${reviewed}`);

        const row = yield* session(Store.pipe(Effect.flatMap((store) => store.run("r-fix-tree"))));
        const placed = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Any))(
          row?.checkout ?? "null",
        );
        expect(placed).toMatchObject({
          cwd: reviewed,
          branch: "feature",
          workspace: null,
          worktree: { path: reviewed, managed_by: "git", created_by_collie: false },
        });
        expect(row?.task).toBeNull();
      }),
    ),
  120_000,
);

scenario(
  "a review with no branch to fix offers no fix, says why, and starts no fixer",
  () =>
    runEffect(
      Effect.gen(function* () {
        yield* repository();
        yield* rig.queueOutputs([SYNTHESIS]);
        const rows = yield* parked({
          entry: shipped("review"),
          runId: "r-fix-none",
          input: { target: "branch:main...HEAD" },
          decision: "post-1",
        });

        expect(optionsOf(rows, "post-1")).toEqual(["Don't post"]);
        expect(rows.find((row) => row.decision === "post-1")?.prompt).toContain(
          "HEAD is not a branch, so there is nothing to fix on it",
        );
        expect((yield* rig.cmds()).filter((cmd) => cmd === "agent start")).toHaveLength(1);
      }),
    ),
  120_000,
);

scenario(
  "a merge request reviewed from a checkout with no remote is offered no fix, and says why",
  () =>
    runEffect(
      Effect.gen(function* () {
        for (const args of [
          ["init", "-q"],
          ["config", "user.email", "t@example.com"],
          ["config", "user.name", "t"],
          ["commit", "-qm", "first", "--allow-empty"],
          ["branch", "fix-the-guard"],
        ]) {
          yield* exec(["git", ...args], { cwd: rig.projectDir });
        }
        const bin = yield* FakeBin.make(`${rig.root}/bin`);
        yield* bin.add(
          "glab",
          `[ "$1 $2" = "mr view" ] && echo '{"source_branch": "fix-the-guard"}'; exit 0`,
        );
        yield* rig.queueOutputs([SYNTHESIS]);
        const rows = yield* parked({
          entry: shipped("review"),
          runId: "r-review-no-remote",
          input: { target: "mr:gitlab.example.com/group/project!42" },
          decision: "post-1",
        });

        expect(optionsOf(rows, "post-1")).toEqual(["Post to merge request", "Don't post"]);
        expect(rows.find((row) => row.decision === "post-1")?.prompt).toContain(
          `${rig.projectDir} has no remote, so group/project!42 may not be its own`,
        );
      }),
    ),
  120_000,
);

scenario(
  "a fix refused when it starts is not offered again, and its refusal is logged once",
  () =>
    runEffect(
      Effect.gen(function* () {
        yield* repository();
        yield* rig.queueOutputs([SYNTHESIS]);
        const target = "branch:main...HEAD";
        const review = { entry: shipped("review"), runId: "r-fix-refused", input: { target } };
        // A parent nobody is implementing for: the hand-off finds no one to take it.
        const first = yield* parked({ ...review, decision: "post-1", parent: "r-gone" });
        expect(optionsOf(first, "post-1")).toContain("Fix findings");
        expect(optionsOf(first, "post-1")).not.toContain("Fix findings in a full implement run");

        const rows = yield* answeredThen({
          ...review,
          decision: "post-1",
          value: "Fix findings",
          until: "post-2",
        });
        expect(optionsOf(rows, "post-2")).toEqual(["Don't post"]);
        expect(rows.find((row) => row.decision === "post-2")?.prompt).toContain(
          "HEAD is not a branch, so there is nothing to fix on it",
        );
        expect((yield* rig.cmds()).filter((cmd) => cmd === "agent start")).toHaveLength(1);

        yield* answered({ ...review, decision: "post-2", value: "Don't post" });
        const fs = yield* FileSystem.FileSystem;
        const log = yield* fs.readFileString(`${runDir(dir, "r-fix-refused")}/log.txt`);
        expect(log.split("fix: nothing fixed, HEAD is not a branch").length - 1).toBe(1);
      }),
    ),
  120_000,
);

scenario(
  "a rally that runs out of rounds asks, with every option still on the menu",
  () =>
    runEffect(
      Effect.gen(function* () {
        yield* noMergeRequests;
        const fixed = { verdict: "clean", findings: [], fixed: [], disputed: [], checks: [] };
        const raising = (title: string) => ({
          ...SYNTHESIS,
          findings: [{ severity: "major", title, file: "src/a.ts" }],
        });
        yield* reviewedBranch();
        const target = "branch:main...feature";
        yield* rig.queueOutputs([
          SYNTHESIS,
          ...["a", "b", "c", "d"].flatMap((title) => [fixed, raising(title)]),
        ]);
        yield* parked({
          entry: shipped("review"),
          runId: "r-out",
          input: { target },
          decision: "post-1",
        });
        const rows = yield* answeredThen({
          entry: shipped("review"),
          runId: "r-out",
          input: { target },
          decision: "post-1",
          value: "Fix findings",
          until: "post-2",
        });
        // Four fixes, each reviewed, and then the human: not the Run ending on its own.
        expect(yield* prompts()).toHaveLength(9);
        expect(optionsOf(rows, "post-2")).toContain("Fix findings");
        expect(optionsOf(rows, "post-2")).toContain("Don't post");
      }),
    ),
  120_000,
);

scenario(
  "a fix round that leaves the same findings asks rather than going round again",
  () =>
    runEffect(
      Effect.gen(function* () {
        yield* noMergeRequests;
        const fixed = { verdict: "clean", findings: [], fixed: [], disputed: [], checks: [] };
        yield* reviewedBranch();
        const target = "branch:main...feature";
        // The same finding back after a fix is a round that changed nothing: the human decides.
        yield* rig.queueOutputs([SYNTHESIS, fixed, SYNTHESIS]);
        yield* parked({
          entry: shipped("review"),
          runId: "r-stuck",
          input: { target },
          decision: "post-1",
        });
        const stuck = yield* answeredThen({
          entry: shipped("review"),
          runId: "r-stuck",
          input: { target },
          decision: "post-1",
          value: "Fix findings",
          until: "post-2",
        });
        expect(optionsOf(stuck, "post-2")).toContain("Fix findings");
        // Review, fix, review, and then the question: no fix nobody asked for.
        expect(yield* prompts()).toHaveLength(3);
      }),
    ),
  120_000,
);

scenario(
  "an implementer already live here takes the findings, and no second agent starts on them",
  () =>
    runEffect(
      Effect.gen(function* () {
        yield* rig.queueOutputs([SYNTHESIS, SYNTHESIS]);
        // The implementer of the Run this review was started from, live and registered as it.
        yield* rig.addAgent("impl-live", "9-1");
        const env = hostOf().env;
        yield* registerAgent(yield* registryPath(env.stateDir, scopeFor(env, rig.projectDir)), {
          role: "implementer",
          agent: "impl-live",
          paneId: "9-1",
          workspaceId: null,
          runId: "r-building",
          workflow: "implement",
          at: "2026-09-23T10:00:00Z",
          incarnation: { terminalId: "term-impl-live", agentSession: null },
        }).pipe(Effect.orDie);
        const target = "branch:main...HEAD";
        yield* parked({
          entry: shipped("review"),
          runId: "r-review-live",
          input: { target },
          decision: "post-1",
          parent: "r-building",
        });
        yield* answeredThen({
          entry: shipped("review"),
          runId: "r-review-live",
          input: { target },
          decision: "post-1",
          value: "Fix findings",
          until: "post-2",
        });

        const handed = (yield* prompts()).filter((text) => text.includes("review.md"));
        expect(handed).toHaveLength(1);
        expect(handed[0]).toContain(`${runDir(dir, "r-review-live")}/review.md`);
        // One agent, the lone reviewer; the fix went to the one already here.
        expect((yield* rig.cmds()).filter((cmd) => cmd === "agent start")).toHaveLength(1);

        // Collie cannot see that agent finish, so the human says when to look again, and
        // the next review is a follow-up of this one rather than a fresh start.
        const rows = yield* parked({
          entry: shipped("review"),
          runId: "r-review-live",
          input: { target },
          decision: "post-2",
          parent: "r-building",
        });
        expect(optionsOf(rows, "post-2")).toContain("Review again");
        expect(optionsOf(rows, "post-2")).not.toContain("Fix findings");
        yield* answeredThen({
          entry: shipped("review"),
          runId: "r-review-live",
          input: { target },
          decision: "post-2",
          value: "Review again",
          until: "post-3",
        });
        expect(yield* asked("r-review-live", "review-2-1")).toContain("Iteration 2");
      }),
    ),
  120_000,
);

scenario("implement offers Stage as a follow-up on a succeeded Run with its merge request", () =>
  runEffect(
    Effect.gen(function* () {
      const declared = yield* loadEntry(shipped("implement")).pipe(
        Effect.map((described) => declaredByModule(described.metadata)),
        Effect.orDie,
      );
      const facts: ActionFacts = {
        outcome: "feature",
        succeeded: true,
        branch: "feature",
        mrUrl: OPENED.mr_url,
        planIssues: 0,
        disposed: false,
        openFindings: 0,
        diffTarget: null,
        claim: null,
      };
      const offered = offersFrom(declared, facts, { self: idOf("implement") });
      expect(offered.map((offer) => [offer.id, offer.title, offer.workflow])).toContainEqual([
        "stage",
        "Stage",
        "stage",
      ]);
      const stage = offered.find((offer) => offer.id === "stage")!;
      expect(inputsFor(stage, { runDir: "/r", facts, input: {} })).toEqual({ mr: OPENED.mr_url });
      for (const over of [{ succeeded: false }, { mrUrl: null }, { disposed: true }])
        expect(offersFrom(declared, { ...facts, ...over }).map((offer) => offer.id)).not.toContain(
          "stage",
        );
    }),
  ),
);

scenario("what a finished Run of each shipped module offers is the module's own declaration", () =>
  runEffect(
    Effect.gen(function* () {
      const facts = (over: Partial<ActionFacts>): ActionFacts => ({
        outcome: "review",
        succeeded: true,
        branch: null,
        mrUrl: null,
        planIssues: 0,
        disposed: false,
        openFindings: 0,
        diffTarget: null,
        claim: null,
        ...over,
      });
      const declaredIn = (entry: string) =>
        loadEntry(entry).pipe(
          Effect.map((described) => declaredByModule(described.metadata)),
          Effect.orDie,
        );

      // The entry this pass loads is the id it claims to be.
      expect(
        yield* loadEntry(shipped("review")).pipe(
          Effect.map((described) => described.id),
          Effect.orDie,
        ),
      ).toBe(idOf("review"));

      // A review with findings has something to fix; one that came back clean has not,
      // and neither answer comes from the workflow being called "review".
      const review = yield* declaredIn(shipped("review"));
      expect(
        offersFrom(review, facts({ openFindings: 2, diffTarget: "branch:main...HEAD" }), {
          self: idOf("review"),
        }).map((offer) => [offer.id, offer.workflow, offer.primary]),
      ).toEqual([
        ["fix-open", "implement", true],
        ["run-again", idOf("review"), false],
      ]);
      expect(
        offersFrom(review, facts({ diffTarget: "branch:main...HEAD" })).map((offer) => offer.id),
      ).toEqual(["run-again"]);

      const implement = yield* declaredIn(shipped("implement"));
      expect(
        offersFrom(implement, facts({ succeeded: false, branch: "feature" })).map((o) => o.id),
      ).toEqual(["follow-up"]);
      const mrUrl = "https://gitlab.example.com/group/project/-/merge_requests/7";
      const delivered = facts({ outcome: "feature", branch: "feature", mrUrl });
      const offered = offersFrom(implement, delivered, { self: idOf("implement") });
      expect(offered.map((o) => [o.id, o.title, o.workflow])).toEqual([
        ["release", "Release", "release"],
        ["stage", "Stage", "stage"],
        ["follow-up", "Keep going on this", idOf("implement")],
      ]);
      expect(inputsFor(offered[0]!, { runDir: "/r", facts: delivered, input: {} })).toEqual({
        mr: mrUrl,
      });
      expect(offersFrom(implement, { ...delivered, disposed: true })).toEqual([]);
      expect(
        offersFrom(implement, facts({ outcome: "feature", branch: "feature" })).map((o) => o.id),
      ).toEqual(["follow-up"]);
      expect(offersFrom(implement, { ...delivered, succeeded: false }).map((o) => o.id)).toEqual([
        "follow-up",
      ]);

      // A plan offers what it wrote, and only once it has written something.
      const plan = yield* declaredIn(shipped("plan"));
      expect(offersFrom(plan, facts({ outcome: "plan", planIssues: 3 })).map((o) => o.id)).toEqual([
        "implement-now",
      ]);
      // A follow-up is hidden once somebody has said what became of the work.
      expect(offersFrom(plan, facts({ outcome: "plan", planIssues: 3, disposed: true }))).toEqual(
        [],
      );

      // The architect's report is read by a human; nothing is offered off the back of it.
      expect(yield* declaredIn(shipped("architecture"))).toEqual([]);

      // A renovation that failed holding the claim offers to recover it, on the repository
      // it was started on; one that failed holding nothing offers to renovate it again.
      const renovate = yield* declaredIn(shipped("renovate"));
      const failed = facts({ succeeded: false, claim: "project" });
      const recovery = offersFrom(renovate, failed, { self: idOf("renovate") });
      expect(recovery.map((offer) => [offer.id, offer.workflow])).toEqual([
        ["recover", idOf("renovate")],
      ]);
      const unclaimed = facts({ succeeded: false });
      const again = offersFrom(renovate, unclaimed, { self: idOf("renovate") });
      expect(again.map((offer) => [offer.id, offer.workflow])).toEqual([
        ["renovate-again", idOf("renovate")],
      ]);
      expect(offersFrom(renovate, facts({ succeeded: true }))).toEqual([]);
      const repository = "https://gitlab.example.com/team/project";
      expect(
        inputsFor(recovery[0]!, { runDir: "/r", facts: failed, input: { repository } }),
      ).toEqual({ repository });
      expect(
        inputsFor(again[0]!, { runDir: "/r", facts: unclaimed, input: { repository } }),
      ).toEqual({ repository });
    }),
  ),
);

once(
  "moved to a directory of its own, a shipped module is the same workflow",
  () =>
    runEffect(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const mine = `${rig.root}/user/workflows`;
        yield* fs.makeDirectory(mine, { recursive: true });
        for (const name of ["architecture.workflow.ts", "architecture.md"]) {
          yield* fs.copyFile(`${ROOT}workflows/${name}`, `${mine}/${name}`);
        }
        yield* rig.queueOutputs([REPORT]);

        yield* parked({
          entry: `${mine}/architecture.workflow.ts`,
          runId: "r-mine",
          input: { goal: "why are there two registries" },
          decision: "next",
        });

        // The same question, the same persona, the same report — the module decides all
        // of it, and none of it came from where the file was saved.
        expect((yield* prompts())[0]?.startsWith("/improve-codebase-architecture ")).toBe(true);
        expect(yield* asked("r-mine", "architecture")).toContain(
          `Report: ${runDir(dir, "r-mine")}/plan/ARCHITECTURE.md`,
        );
        expect(yield* persona("r-mine", "architecture")).toContain("You are an architect");

        const result = yield* answered({
          entry: `${mine}/architecture.workflow.ts`,
          runId: "r-mine",
          input: { goal: "why are there two registries" },
          decision: "next",
          value: "Stop here",
        });
        expect(said(result)).toBe("plan/ARCHITECTURE.md: stopped there");
      }),
    ),
  120_000,
);

/** A Run of a shipped module that asks nothing, run to the end it reaches on its own. */
const ran = (options: {
  readonly entry: string;
  readonly runId: string;
  readonly input: Readonly<Record<string, Schema.Json>>;
  readonly options?: Readonly<Record<string, string>>;
  readonly host?: HostOverride;
}) =>
  session(
    Effect.gen(function* () {
      const made = yield* loaded(options.entry, options.runId);
      yield* admit({
        runId: options.runId,
        workflow: made.workflow.name,
        input: options.input,
        options: options.options,
      });
      const payload = { runId: options.runId, input: options.input };
      return yield* made.workflow.execute(payload).pipe(Effect.result, Effect.provide(made.layer));
    }),
    options.host,
  );

scenario(
  "Flow: investigate's reported work is one completed Investigate Step",
  () =>
    runEffect(
      Effect.gen(function* () {
        yield* rig.queueOutputs([{ summary: "The peer build is stale", findings: [] }]);
        yield* ran({
          entry: shipped("investigate"),
          runId: "r-investigate-flow",
          input: { goal: "Why is the peer behind?" },
        });
        const lane = yield* laneNow("r-investigate-flow", "succeeded");
        expect(lane.nodes.map((node) => [node.title, node.state, node.produces])).toEqual([
          ["Investigate", "done", "evidence"],
        ]);
      }),
    ),
  120_000,
);

scenario(
  "investigate asks one investigator and returns findings without proof or offers",
  () =>
    runEffect(
      Effect.gen(function* () {
        const output = {
          summary: "The peer build is stale",
          findings: [{ what: "A cached build", evidence: "MachinesPage.vue:12" }],
        };
        yield* rig.queueOutputs([output]);
        const result = yield* ran({
          entry: shipped("investigate"),
          runId: "r-investigate",
          input: { goal: "Why is the peer behind?" },
        });
        expect(result).toMatchObject({ _tag: "Success", success: output });
        const messages = yield* prompts();
        expect(messages).toHaveLength(1);
        expect(yield* asked("r-investigate", "investigate")).toContain("Why is the peer behind?");
        expect(yield* persona("r-investigate", "investigate")).toContain("investigator");
        const entry = yield* loadEntry(shipped("investigate"));
        expect(entry.metadata?.closes).toBe("reported");
        expect(entry.metadata?.outcome).toBeUndefined();
        expect(entry.metadata?.followUps ?? []).toHaveLength(0);
      }),
    ),
  120_000,
);

const asApproved = Schema.encodeSync(Schema.fromJsonString(Schema.Array(VerifySpecSchema)));
const asJson = Schema.encodeUnknownSync(Schema.fromJsonString(Schema.Any));

/** What a human approved Collie to run for this Run, frozen where a start would freeze it. */
const approve = (runId: string, names: ReadonlyArray<string>) =>
  FileSystem.FileSystem.pipe(
    Effect.flatMap((fs) =>
      fs
        .makeDirectory(evidenceDir(dir, runId), { recursive: true })
        .pipe(
          Effect.andThen(
            fs.writeFileString(
              `${evidenceDir(dir, runId)}/approved.json`,
              asApproved(
                names.map((name) => ({ name, executable: "true", argv: [], cwd: rig.projectDir })),
              ),
            ),
          ),
        ),
    ),
    Effect.orDie,
  );

/**
 * A glab that finds no merge request from the branch: a push is only known not to be a
 * merge once the forge has said so.
 */
const noMergeRequests = Effect.acquireRelease(
  Effect.gen(function* () {
    const bin = yield* FakeBin.make(`${rig.root}/bin`);
    yield* noGitlabMrs(bin);
    return bin;
  }),
  (bin) => bin.restore(),
);

/**
 * A real repository with a GitLab remote, level with its default branch. What binds a
 * verification is the tree it ran on, and a directory git knows nothing about has no tree to move.
 */
const levelRepository = () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const made = yield* preparedRepository;
    // Fetched from a bare repository beside it, and known to the forge by `upstream`.
    const origin = `${rig.root}/project-origin.git`;
    yield* fs.copy(`${made}/origin.git`, origin);
    yield* fs.copy(`${made}/project`, rig.projectDir);
    const config = `${rig.projectDir}/.git/config`;
    const text = yield* fs.readFileString(config);
    yield* fs.writeFileString(config, text.replace(`${made}/origin.git`, origin));
  }).pipe(Effect.orDie);

// Per home: a `--rerun-each` run removes the last run's.
let prepared: { readonly home: string; readonly made: string } | undefined;

const preparedRepository = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  // The default provider holds the environment the file started with, and its home.
  const home = yield* Config.String("HOME").pipe(
    Effect.provideService(ConfigProvider.ConfigProvider, ConfigProvider.fromEnv()),
  );
  if (prepared?.home === home) return prepared.made;
  // Under the suite's home: what a test makes beside it is reported as left behind.
  const made = yield* fs.makeTempDirectory({ directory: home, prefix: "baseline-repository-" });
  const origin = `${made}/origin.git`;
  const project = `${made}/project`;
  yield* fs.makeDirectory(project);
  yield* exec(["git", "init", "-q", "--bare", origin], { cwd: made });
  for (const args of [
    ["init", "-q"],
    ["config", "user.email", "t@example.com"],
    ["config", "user.name", "t"],
    ["remote", "add", "origin", origin],
    ["remote", "add", "upstream", "https://gitlab.example.com/group/project.git"],
    ["commit", "-qm", "first", "--allow-empty"],
    ["push", "-q", "origin", "HEAD"],
  ]) {
    yield* exec(["git", ...args], { cwd: project });
  }
  prepared = { home, made };
  return made;
}).pipe(Effect.orDie);

/**
 * That repository with a commit the default branch does not have, so its base is another
 * tree and a Run on it has work to land.
 */
const repository = () =>
  levelRepository().pipe(
    Effect.andThen(
      exec(["git", "commit", "-qm", "the change", "--allow-empty"], { cwd: rig.projectDir }),
    ),
  );
const ahead = repository;

/** A real repository whose `feature` branch has a checkout of its own, as a reviewed branch does. */
const reviewedBranch = () =>
  Effect.gen(function* () {
    yield* repository();
    const checkout = `${rig.root}/reviewed`;
    yield* exec(["git", "worktree", "add", "-q", "-b", "feature", checkout], {
      cwd: rig.projectDir,
    });
    return checkout;
  });

/** A plan of tickets on disk, which is the only thing that makes a build a list. */
const planOf = (
  tickets: ReadonlyArray<{ file: string; title: string; checks: string; body?: string }>,
  where = `${rig.root}/plan`,
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    yield* fs.makeDirectory(`${where}/issues`, { recursive: true });
    yield* fs.writeFileString(`${where}/SPEC.md`, "# The spec\n");
    for (const ticket of tickets) {
      yield* fs.writeFileString(
        `${where}/issues/${ticket.file}`,
        `# ${ticket.title}\n\n**Checks:** ${ticket.checks}\n${ticket.body ?? ""}`,
      );
    }
    return where;
  });

const BUILT = {
  verdict: "clean",
  findings: [],
  branch: "mk/one-registry",
  pushed: true,
  tickets_done: ["the first one"],
  commits: ["made the registry one"],
  tests: "unit: pass",
};
const CLEAN_SYNTHESIS = {
  verdict: "clean",
  summary: "It merges the two registries. Nothing is wrong with it.",
  findings: [],
  dropped: [],
  fixed: [],
  scope_met: true,
};
const OPENED = {
  verdict: "clean",
  findings: [],
  mr_url: "https://gitlab.example.com/group/project/-/merge_requests/7",
  linear_issues: [],
  branch: "mk/one-registry",
  pushed: true,
};

scenario(
  "implement builds a plan one ticket at a time on one implementer, then reviews what it built",
  () =>
    runEffect(
      Effect.gen(function* () {
        const bin = yield* FakeBin.make(`${rig.root}/bin`);
        yield* noGitlabMrs(bin);
        yield* repository();
        const plan = yield* planOf([
          { file: "01-first.md", title: "the first one", checks: "unit" },
          { file: "02-second.md", title: "the second one", checks: "unit" },
        ]);
        yield* approve("r-impl", ["unit"]);
        yield* rig.queueOutputs([BUILT, BUILT, CLEAN_SYNTHESIS, OPENED]);

        const result = yield* ran({
          entry: shipped("implement"),
          runId: "r-impl",
          input: { plan, ...FINISH },
        });
        yield* bin.restore();

        expect(said(result)).toBe(OPENED.mr_url);
        // One implementer for the build, the fixes and the merge request; the reviewer is
        // its own, because it may not vouch for the change.
        const starts = yield* rig
          .cmds()
          .pipe(Effect.map((cmds) => cmds.filter((cmd) => cmd === "agent start")));
        expect(starts).toHaveLength(2);
        // Tabs open in the order their agents started, whatever the workflow is called.
        const tabs = yield* rig
          .calls()
          .pipe(
            Effect.map((calls) =>
              calls
                .filter((call) => call.cmd === "tab create")
                .map((call) => call.argv?.[(call.argv?.indexOf("--label") ?? -2) + 1]),
            ),
          );
        expect(tabs).toEqual(["Implementer", "Reviewer · review-1"]);
        // The second ticket is handed what the first left, not the whole transcript.
        const second = yield* asked("r-impl", "02-second.md");
        expect(second).toContain("Ticket: 02-second.md — the second one");
        expect(second).toContain("- 01-first.md — the first one");
        expect(second).toContain("made the registry one");
        // What this Run will be held to, named before it starts rather than guessed at.
        expect(second).toContain(`- unit: true (in ${rig.projectDir})`);
        // And the card a slice landing leaves, whether or not the agent wrote its own.
        const fs = yield* FileSystem.FileSystem;
        expect(
          yield* fs.readFileString(`${runDir(dir, "r-impl")}/steering/progress/01-first.json`),
        ).toContain(`"status":"done"`);
        // Collie keeps progress, so the card has one entry per ticket and no second slug.
        expect(
          (yield* readCheckpoints(runDir(dir, "r-impl")))
            .map(({ checkpoint }) => [checkpoint.ticket, checkpoint.status])
            .toSorted(),
        ).toEqual([
          ["01-first.md", "done"],
          ["02-second.md", "done"],
        ]);
      }),
    ),
  120_000,
);

scenario(
  "tickets added and removed while one is being built are the plan the next one comes from",
  () =>
    runEffect(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const bin = yield* FakeBin.make(`${rig.root}/bin`);
        yield* noGitlabMrs(bin);
        yield* repository();
        const plan = yield* planOf([
          { file: "01-first.md", title: "the first one", checks: "unit" },
          { file: "02-second.md", title: "the second one", checks: "unit" },
        ]);
        yield* approve("r-live", ["unit"]);
        // The first ticket's Output is written by hand, once the plan has moved under it.
        yield* rig.queueOutputs([null, BUILT, CLEAN_SYNTHESIS, OPENED]);
        const running = yield* Effect.forkChild(
          ran({ entry: shipped("implement"), runId: "r-live", input: { plan, ...FINISH } }),
        );
        const agents = `${dir}/agents/r-live`;
        yield* until(
          () =>
            fs.exists(`${agents}/01-first.md.prompt.md`).pipe(Effect.orElseSucceed(() => false)),
          (there) => there,
        );
        yield* fs.remove(`${plan}/issues/02-second.md`);
        yield* fs.writeFileString(
          `${plan}/issues/03-third.md`,
          "# the third one\n\n**Checks:** unit\n",
        );
        yield* fs.writeFileString(`${agents}/01-first.md.json`, asJson(BUILT));
        const result = yield* Fiber.join(running);
        yield* bin.restore();

        expect(said(result)).toBe(OPENED.mr_url);
        expect(yield* fs.exists(`${agents}/03-third.md.prompt.md`)).toBe(true);
        expect(yield* fs.exists(`${agents}/02-second.md.prompt.md`)).toBe(false);
      }),
    ),
  120_000,
);

scenario(
  "a ticket added to a one-ticket plan while it is being built is built next",
  () =>
    runEffect(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const bin = yield* FakeBin.make(`${rig.root}/bin`);
        yield* noGitlabMrs(bin);
        yield* repository();
        const plan = yield* planOf([
          { file: "01-first.md", title: "the first one", checks: "unit" },
        ]);
        yield* approve("r-grow", ["unit"]);
        yield* rig.queueOutputs([null, BUILT, CLEAN_SYNTHESIS, OPENED]);
        const running = yield* Effect.forkChild(
          ran({ entry: shipped("implement"), runId: "r-grow", input: { plan, ...FINISH } }),
        );
        const agents = `${dir}/agents/r-grow`;
        yield* until(
          () => fs.exists(`${agents}/build.prompt.md`).pipe(Effect.orElseSucceed(() => false)),
          (there) => there,
        );
        yield* fs.writeFileString(
          `${plan}/issues/02-second.md`,
          "# the second one\n\n**Checks:** unit\n",
        );
        yield* fs.writeFileString(`${agents}/build.json`, asJson(BUILT));
        const result = yield* Fiber.join(running);
        yield* bin.restore();

        expect(said(result)).toBe(OPENED.mr_url);
        expect(yield* asked("r-grow", "02-second.md")).toContain("Ticket: 02-second.md");
      }),
    ),
  120_000,
);

const CRITERIA = [
  "## Acceptance criteria",
  "",
  "- [ ] **Counted.** Every registry is counted once.",
  "- [ ] **Named.** Each one is named in the log.",
].join("\n");

scenario(
  "a criterion the builder left unanswered goes back to it before any reviewer, who sees every answer",
  () =>
    runEffect(
      Effect.gen(function* () {
        const bin = yield* FakeBin.make(`${rig.root}/bin`);
        yield* noGitlabMrs(bin);
        yield* repository();
        const plan = yield* planOf([
          { file: "01-first.md", title: "the first one", checks: "unit", body: CRITERIA },
          { file: "02-second.md", title: "the second one", checks: "unit" },
        ]);
        yield* approve("r-criteria", ["unit"]);
        yield* rig.queueOutputs([
          {
            ...BUILT,
            criteria: [
              {
                criterion: "**Counted.** Every registry is counted once.",
                met: "test/count.test.ts",
              },
            ],
            assumptions: ["a registry nobody reads is still counted"],
          },
          {
            ...BUILT,
            criteria: [{ criterion: "Named. Each one is named in the log", met: "src/log.ts" }],
          },
          BUILT,
          CLEAN_SYNTHESIS,
          OPENED,
        ]);

        const result = yield* ran({
          entry: shipped("implement"),
          runId: "r-criteria",
          input: { plan, ...FINISH },
        });
        yield* bin.restore();

        expect(said(result)).toBe(OPENED.mr_url);
        const first = yield* asked("r-criteria", "01-first.md");
        expect(first).toContain("- **Counted.** Every registry is counted once.");
        const back = yield* asked("r-criteria", "01-first.md.criteria-1");
        expect(back).toContain(
          "acceptance criterion not answered: **Named.** Each one is named in the log.",
        );
        expect(back).not.toContain("not answered: **Counted.**");
        const order = (yield* prompts()).flatMap((message) =>
          ["01-first.md.criteria-1", "02-second.md", "review-1"].filter((operation) =>
            message.includes(`/${operation}.prompt.md`),
          ),
        );
        expect(order).toEqual(["01-first.md.criteria-1", "02-second.md", "review-1"]);
        const review = yield* asked("r-criteria", "review-1");
        expect(review).toContain(
          "- **Counted.** Every registry is counted once.\n  → test/count.test.ts",
        );
        expect(review).toContain("- **Named.** Each one is named in the log.\n  → src/log.ts");
        expect(review).toContain("- assumed: a registry nobody reads is still counted");
        // A ticket with no checkboxes has nothing to answer, and goes nowhere twice.
        expect(yield* asked("r-criteria", "02-second.md")).toContain(
          "None: this work names no checkbox criteria",
        );
        const fs = yield* FileSystem.FileSystem;
        expect(yield* fs.exists(`${dir}/agents/r-criteria/02-second.md.criteria-1.prompt.md`)).toBe(
          false,
        );
      }),
    ),
  120_000,
);

scenario(
  "an implement Run that stops short of its merge request fails with the reason: criteria still unmet after the hand-backs",
  () =>
    runEffect(
      Effect.gen(function* () {
        const bin = yield* FakeBin.make(`${rig.root}/bin`);
        yield* noGitlabMrs(bin);
        yield* repository();
        const plan = yield* planOf([
          { file: "01-first.md", title: "the first one", checks: "unit", body: CRITERIA },
          { file: "02-second.md", title: "the second one", checks: "unit" },
        ]);
        yield* approve("r-unmet", ["unit"]);
        yield* rig.queueOutputs([BUILT, BUILT, BUILT]);
        const status = yield* driven(
          { entry: shipped("implement"), runId: "r-unmet", input: { plan, ...FINISH } },
          (run) =>
            Effect.gen(function* () {
              expect(yield* stallAsked(run, "01-first.md.criteria-unmet-1")).toHaveLength(1);
              yield* run.answer("01-first.md.criteria-unmet-1", "Stop");
              return yield* ended(run.status);
            }),
        );
        yield* bin.restore();

        expect(status.status).toBe("failed");
        const why = outcomeText(status);
        expect(why).toContain(
          "01-first.md: acceptance criteria still unanswered or unmet after 2 hand-backs, so no review starts",
        );
        expect(why).toContain("**Named.** Each one is named in the log.");
        expect(why).toContain("Continue with a follow-up Run to finish delivery.");
        expect(why).toContain("Stop was answered");
        const sent = (yield* prompts()).join("\n");
        expect(sent).toContain("01-first.md.criteria-2.prompt.md");
        expect(sent).not.toContain("review-1");
        expect(sent).not.toContain("02-second.md.prompt.md");
      }),
    ),
  120_000,
);

const AMENDED = "**Named.** Each one is named in the audit log.";

scenario(
  "a criterion amended while its ticket is being built is handed back as it reads now",
  () =>
    runEffect(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const bin = yield* FakeBin.make(`${rig.root}/bin`);
        yield* noGitlabMrs(bin);
        yield* repository();
        const plan = yield* planOf([
          { file: "01-first.md", title: "the first one", checks: "unit", body: CRITERIA },
          { file: "02-second.md", title: "the second one", checks: "unit" },
        ]);
        yield* approve("r-amended", ["unit"]);
        yield* rig.queueOutputs([
          null,
          { ...BUILT, criteria: [{ criterion: AMENDED, met: "src/audit.ts" }] },
          BUILT,
          CLEAN_SYNTHESIS,
          OPENED,
        ]);
        const running = yield* Effect.forkChild(
          ran({ entry: shipped("implement"), runId: "r-amended", input: { plan, ...FINISH } }),
        );
        const agents = `${dir}/agents/r-amended`;
        yield* until(
          () =>
            fs.exists(`${agents}/01-first.md.prompt.md`).pipe(Effect.orElseSucceed(() => false)),
          (there) => there,
        );
        const ticket = `${plan}/issues/01-first.md`;
        yield* fs.writeFileString(
          ticket,
          (yield* fs.readFileString(ticket)).replace("named in the log", "named in the audit log"),
        );
        yield* fs.writeFileString(
          `${agents}/01-first.md.json`,
          asJson({
            ...BUILT,
            criteria: [
              {
                criterion: "**Counted.** Every registry is counted once.",
                met: "test/count.test.ts",
              },
            ],
          }),
        );
        const result = yield* Fiber.join(running);
        yield* bin.restore();

        expect(said(result)).toBe(OPENED.mr_url);
        const back = yield* asked("r-amended", "01-first.md.criteria-1");
        expect(back).toContain(`- ${AMENDED}`);
        expect(back).toContain(`acceptance criterion not answered: ${AMENDED}`);
        expect(back).not.toContain("named in the log");
        expect(yield* asked("r-amended", "review-1")).toContain(`- ${AMENDED}\n  → src/audit.ts`);
      }),
    ),
  120_000,
);

const COUNTED = "**Counted.** Every registry is counted once.";
const COUNTED_AMENDED = "**Counted. Every registry is counted once.** Each count is logged.";

scenario(
  "a build's answer to a criterion's earlier wording does not answer it once that wording is only the amended one's lead",
  () =>
    runEffect(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const bin = yield* FakeBin.make(`${rig.root}/bin`);
        yield* noGitlabMrs(bin);
        yield* repository();
        const plan = yield* planOf([
          { file: "01-first.md", title: "the first one", checks: "unit", body: CRITERIA },
          { file: "02-second.md", title: "the second one", checks: "unit" },
        ]);
        yield* approve("r-lead", ["unit"]);
        yield* rig.queueOutputs([
          null,
          { ...BUILT, criteria: [{ criterion: COUNTED_AMENDED, met: "test/logged.test.ts" }] },
          BUILT,
          CLEAN_SYNTHESIS,
          OPENED,
        ]);
        const running = yield* Effect.forkChild(
          ran({ entry: shipped("implement"), runId: "r-lead", input: { plan, ...FINISH } }),
        );
        const agents = `${dir}/agents/r-lead`;
        yield* until(
          () =>
            fs.exists(`${agents}/01-first.md.prompt.md`).pipe(Effect.orElseSucceed(() => false)),
          (there) => there,
        );
        const ticket = `${plan}/issues/01-first.md`;
        yield* fs.writeFileString(
          ticket,
          (yield* fs.readFileString(ticket)).replace(COUNTED, COUNTED_AMENDED),
        );
        yield* fs.writeFileString(
          `${agents}/01-first.md.json`,
          asJson({
            ...BUILT,
            criteria: [
              { criterion: COUNTED, met: "test/count.test.ts" },
              { criterion: "**Named.** Each one is named in the log.", met: "src/log.ts" },
            ],
          }),
        );
        const result = yield* Fiber.join(running);
        yield* bin.restore();

        expect(said(result)).toBe(OPENED.mr_url);
        const back = yield* asked("r-lead", "01-first.md.criteria-1");
        expect(back).toContain(`acceptance criterion not answered: ${COUNTED_AMENDED}`);
        expect(back).not.toContain("not answered: **Named.**");
        expect(yield* asked("r-lead", "review-1")).toContain(
          `- ${COUNTED_AMENDED}\n  → test/logged.test.ts`,
        );
      }),
    ),
  120_000,
);

scenario(
  "a hand-back's answer to a criterion's earlier wording does not answer it once that wording is only the amended one's lead",
  () =>
    runEffect(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const bin = yield* FakeBin.make(`${rig.root}/bin`);
        yield* noGitlabMrs(bin);
        yield* repository();
        const plan = yield* planOf([
          { file: "01-first.md", title: "the first one", checks: "unit", body: CRITERIA },
          { file: "02-second.md", title: "the second one", checks: "unit" },
        ]);
        const named = "**Named.** Each one is named in the log.";
        const amended = "**Named. Each one is named in the log.** Each name is quoted.";
        yield* approve("r-lead-back", ["unit"]);
        yield* rig.queueOutputs([
          { ...BUILT, criteria: [{ criterion: COUNTED, met: "test/count.test.ts" }] },
          null,
          { ...BUILT, criteria: [{ criterion: amended, met: "test/quoted.test.ts" }] },
          BUILT,
          CLEAN_SYNTHESIS,
          OPENED,
        ]);
        const running = yield* Effect.forkChild(
          ran({ entry: shipped("implement"), runId: "r-lead-back", input: { plan, ...FINISH } }),
        );
        const agents = `${dir}/agents/r-lead-back`;
        yield* until(
          () =>
            fs
              .exists(`${agents}/01-first.md.criteria-1.prompt.md`)
              .pipe(Effect.orElseSucceed(() => false)),
          (there) => there,
        );
        const ticket = `${plan}/issues/01-first.md`;
        yield* fs.writeFileString(
          ticket,
          (yield* fs.readFileString(ticket)).replace(named, amended),
        );
        yield* fs.writeFileString(
          `${agents}/01-first.md.criteria-1.json`,
          asJson({ ...BUILT, criteria: [{ criterion: named, met: "src/log.ts" }] }),
        );
        const result = yield* Fiber.join(running);
        yield* bin.restore();

        expect(said(result)).toBe(OPENED.mr_url);
        const again = yield* asked("r-lead-back", "01-first.md.criteria-2");
        expect(again).toContain(`acceptance criterion not answered: ${amended}`);
        expect(yield* asked("r-lead-back", "review-1")).toContain(
          `- ${amended}\n  → test/quoted.test.ts`,
        );
      }),
    ),
  120_000,
);

scenario(
  "an answer by a lead two criteria share answers neither, even once one of them is gone",
  () =>
    runEffect(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const bin = yield* FakeBin.make(`${rig.root}/bin`);
        yield* noGitlabMrs(bin);
        yield* repository();
        const shared = [
          "## Acceptance criteria",
          "",
          "- [ ] **Checks.** The first is checked.",
          "- [ ] **Checks.** The second is checked.",
        ].join("\n");
        const plan = yield* planOf([
          { file: "01-first.md", title: "the first one", checks: "unit", body: shared },
          { file: "02-second.md", title: "the second one", checks: "unit" },
        ]);
        const amended = "**Checks.** The second is checked twice.";
        yield* approve("r-shared-lead", ["unit"]);
        yield* rig.queueOutputs([
          { ...BUILT, criteria: [{ criterion: "Checks.", met: "test/check.test.ts" }] },
          null,
          { ...BUILT, criteria: [{ criterion: amended, met: "test/twice.test.ts" }] },
          BUILT,
          CLEAN_SYNTHESIS,
          OPENED,
        ]);
        const running = yield* Effect.forkChild(
          ran({ entry: shipped("implement"), runId: "r-shared-lead", input: { plan, ...FINISH } }),
        );
        const agents = `${dir}/agents/r-shared-lead`;
        yield* until(
          () =>
            fs
              .exists(`${agents}/01-first.md.criteria-1.prompt.md`)
              .pipe(Effect.orElseSucceed(() => false)),
          (there) => there,
        );
        const ticket = `${plan}/issues/01-first.md`;
        yield* fs.writeFileString(
          ticket,
          (yield* fs.readFileString(ticket))
            .replace("- [ ] **Checks.** The first is checked.\n", "")
            .replace("The second is checked.", "The second is checked twice."),
        );
        yield* fs.writeFileString(`${agents}/01-first.md.criteria-1.json`, asJson(BUILT));
        const result = yield* Fiber.join(running);
        yield* bin.restore();

        expect(said(result)).toBe(OPENED.mr_url);
        const again = yield* asked("r-shared-lead", "01-first.md.criteria-2");
        expect(again).toContain(`acceptance criterion not answered: ${amended}`);
      }),
    ),
  120_000,
);

scenario(
  "an answer to the old wording of a criterion amended during a hand-back is handed back as unanswered",
  () =>
    runEffect(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const bin = yield* FakeBin.make(`${rig.root}/bin`);
        yield* noGitlabMrs(bin);
        yield* repository();
        const plan = yield* planOf([
          { file: "01-first.md", title: "the first one", checks: "unit", body: CRITERIA },
          { file: "02-second.md", title: "the second one", checks: "unit" },
        ]);
        yield* approve("r-old-words", ["unit"]);
        yield* rig.queueOutputs([
          {
            ...BUILT,
            criteria: [
              {
                criterion: "**Counted.** Every registry is counted once.",
                met: "test/count.test.ts",
              },
            ],
          },
          null,
          { ...BUILT, criteria: [{ criterion: AMENDED, met: "src/audit.ts" }] },
          BUILT,
          CLEAN_SYNTHESIS,
          OPENED,
        ]);
        const running = yield* Effect.forkChild(
          ran({ entry: shipped("implement"), runId: "r-old-words", input: { plan, ...FINISH } }),
        );
        const agents = `${dir}/agents/r-old-words`;
        yield* until(
          () =>
            fs
              .exists(`${agents}/01-first.md.criteria-1.prompt.md`)
              .pipe(Effect.orElseSucceed(() => false)),
          (there) => there,
        );
        const ticket = `${plan}/issues/01-first.md`;
        yield* fs.writeFileString(
          ticket,
          (yield* fs.readFileString(ticket)).replace("named in the log", "named in the audit log"),
        );
        yield* fs.writeFileString(
          `${agents}/01-first.md.criteria-1.json`,
          asJson({
            ...BUILT,
            criteria: [
              { criterion: "**Named.** Each one is named in the log.", met: "src/log.ts" },
            ],
          }),
        );
        const result = yield* Fiber.join(running);
        yield* bin.restore();

        expect(said(result)).toBe(OPENED.mr_url);
        const again = yield* asked("r-old-words", "01-first.md.criteria-2");
        expect(again).toContain(`acceptance criterion not answered: ${AMENDED}`);
        expect(again).not.toContain("named in the log");
      }),
    ),
  120_000,
);

scenario(
  "a ticket's after-merge outcomes are not criteria, and the merge request names them as unsettled",
  () =>
    runEffect(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const bin = yield* FakeBin.make(`${rig.root}/bin`);
        yield* noGitlabMrs(bin);
        yield* repository();
        const plan = yield* planOf([
          {
            file: "01-first.md",
            title: "the first one",
            checks: "unit",
            body: [
              "",
              "## After merge",
              "",
              "- The nightly deploy counts each registry once.",
              "- [ ] The dashboard shows it.",
            ].join("\n"),
          },
        ]);
        yield* approve("r-after-merge", ["unit"]);
        yield* rig.queueOutputs([BUILT, CLEAN_SYNTHESIS, OPENED]);
        const result = yield* ran({
          entry: shipped("implement"),
          runId: "r-after-merge",
          input: { plan, ...FINISH },
        });
        yield* bin.restore();

        expect(said(result)).toBe(OPENED.mr_url);
        expect(yield* fs.exists(`${dir}/agents/r-after-merge/build.criteria-1.prompt.md`)).toBe(
          false,
        );
        const opening = yield* asked("r-after-merge", "mr");
        expect(opening).toContain(
          "- 01-first.md: after merge: The nightly deploy counts each registry once.",
        );
        expect(opening).toContain("- 01-first.md: after merge: The dashboard shows it.");
      }),
    ),
  120_000,
);

scenario(
  "a criterion answered after merge goes back to no one, and the reviewer and the merge request see it",
  () =>
    runEffect(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const bin = yield* FakeBin.make(`${rig.root}/bin`);
        yield* noGitlabMrs(bin);
        yield* repository();
        const plan = yield* planOf([
          { file: "01-first.md", title: "the first one", checks: "unit", body: CRITERIA },
        ]);
        yield* approve("r-answered-later", ["unit"]);
        yield* rig.queueOutputs([
          {
            ...BUILT,
            criteria: [
              {
                criterion: "**Counted.** Every registry is counted once.",
                met: "after merge: only the deploy shows it",
              },
              { criterion: "**Named.** Each one is named in the log.", met: "src/log.ts" },
            ],
          },
          CLEAN_SYNTHESIS,
          OPENED,
        ]);
        const result = yield* ran({
          entry: shipped("implement"),
          runId: "r-answered-later",
          input: { plan, ...FINISH },
        });
        yield* bin.restore();

        expect(said(result)).toBe(OPENED.mr_url);
        expect(
          yield* fs.exists(`${dir}/agents/r-answered-later/01-first.md.criteria-1.prompt.md`),
        ).toBe(false);
        const review = yield* asked("r-answered-later", "review-1");
        expect(review).toContain(
          "- **Counted.** Every registry is counted once.\n  → after merge: only the deploy shows it",
        );
        expect(review).toContain(
          "Raise as blocking an `after merge` answer to a criterion this Run could have shown",
        );
        expect(yield* asked("r-answered-later", "mr")).toContain(
          "- 01-first.md: **Counted.** Every registry is counted once. — after merge: only the deploy shows it",
        );
      }),
    ),
  120_000,
);

const NAMED_NOT_MET = {
  ...BUILT,
  criteria: [
    { criterion: "**Counted.** Every registry is counted once.", met: "test/count.test.ts" },
    { criterion: "**Named.** Each one is named in the log.", met: "not met: the log has no names" },
  ],
};

scenario(
  "a criterion still answered not met after every hand-back asks to hand back or stop, and Stop fails the Run before any review",
  () =>
    runEffect(
      Effect.gen(function* () {
        const bin = yield* FakeBin.make(`${rig.root}/bin`);
        yield* noGitlabMrs(bin);
        yield* repository();
        const plan = yield* planOf([
          { file: "01-first.md", title: "the first one", checks: "unit", body: CRITERIA },
          { file: "02-second.md", title: "the second one", checks: "unit" },
        ]);
        yield* approve("r-not-met", ["unit"]);
        yield* rig.queueOutputs([NAMED_NOT_MET, NAMED_NOT_MET, NAMED_NOT_MET]);
        const status = yield* driven(
          { entry: shipped("implement"), runId: "r-not-met", input: { plan, ...FINISH } },
          (run) =>
            Effect.gen(function* () {
              const rows = yield* stallAsked(run, "01-first.md.criteria-unmet-1");
              expect(rows).toHaveLength(1);
              expect(rows[0]!.prompt).toContain("01-first.md");
              expect(rows[0]!.prompt).toContain(
                "acceptance criterion not met: **Named.** Each one is named in the log.",
              );
              expect(optionsOf(rows, "01-first.md.criteria-unmet-1")).toEqual([
                "Hand back",
                "Stop",
              ]);
              expect((yield* prompts()).join("\n")).not.toContain("review-1");
              yield* run.answer("01-first.md.criteria-unmet-1", "Stop");
              return yield* ended(run.status);
            }),
        );
        yield* bin.restore();

        expect(status.status).toBe("failed");
        expect(outcomeText(status)).toContain(
          "acceptance criterion not met: **Named.** Each one is named in the log.",
        );
        const sent = (yield* prompts()).join("\n");
        expect(sent).toContain("01-first.md.criteria-2.prompt.md");
        expect(sent).not.toContain("01-first.md.criteria-3.prompt.md");
        expect(sent).not.toContain("review-1");
        expect(sent).not.toContain("02-second.md.prompt.md");
        expect(sent).not.toContain("mr.prompt.md");
      }),
    ),
  120_000,
);

scenario(
  "a ticket amended while unmet criteria are asked about, then handed back, goes on to review as it reads now",
  () =>
    runEffect(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const bin = yield* FakeBin.make(`${rig.root}/bin`);
        yield* noGitlabMrs(bin);
        yield* repository();
        const plan = yield* planOf([
          { file: "01-first.md", title: "the first one", checks: "unit", body: CRITERIA },
          { file: "02-second.md", title: "the second one", checks: "unit" },
        ]);
        yield* approve("r-unmet-amended", ["unit"]);
        yield* rig.queueOutputs([
          NAMED_NOT_MET,
          NAMED_NOT_MET,
          NAMED_NOT_MET,
          { ...BUILT, criteria: [{ criterion: AMENDED, met: "src/audit.ts" }] },
          BUILT,
          CLEAN_SYNTHESIS,
          OPENED,
        ]);
        const status = yield* driven(
          { entry: shipped("implement"), runId: "r-unmet-amended", input: { plan, ...FINISH } },
          (run) =>
            Effect.gen(function* () {
              expect(yield* stallAsked(run, "01-first.md.criteria-unmet-1")).toHaveLength(1);
              const ticket = `${plan}/issues/01-first.md`;
              yield* fs.writeFileString(
                ticket,
                (yield* fs.readFileString(ticket)).replace(
                  "named in the log",
                  "named in the audit log",
                ),
              );
              yield* run.answer("01-first.md.criteria-unmet-1", "Hand back");
              return yield* ended(run.status);
            }),
        );
        yield* bin.restore();

        expect(outcomeText(status)).toBe(OPENED.mr_url);
        expect(yield* asked("r-unmet-amended", "01-first.md.criteria-3")).toContain(
          `acceptance criterion not answered: ${AMENDED}`,
        );
        expect(yield* asked("r-unmet-amended", "review-1")).toContain(
          `- ${AMENDED}\n  → src/audit.ts`,
        );
      }),
    ),
  120_000,
);

const COUNTED_ONLY = {
  ...BUILT,
  criteria: [
    { criterion: "**Counted.** Every registry is counted once.", met: "test/count.test.ts" },
  ],
};
const BLOCKED = {
  ...COUNTED_ONLY,
  verdict: "findings",
  findings: [{ severity: "blocker", title: "the log service is down", detail: "nothing logs" }],
  commits: [],
};

/** The stall question under `name` once it is open, or none if the Run ended first. */
const stallAsked = (
  run: {
    readonly status: Effect.Effect<typeof RunStatus.Type>;
    readonly asked: Effect.Effect<
      ReadonlyArray<{ decision: string; prompt: string; options: string; answer: string | null }>
    >;
  },
  name: string,
) =>
  until(
    () => Effect.all([run.asked, run.status]),
    ([rows, got]) =>
      rows.some((row) => row.decision === name && row.answer === null) ||
      got.status === "complete" ||
      got.status === "failed",
  ).pipe(Effect.map(([rows]) => rows.filter((row) => row.decision === name)));

scenario(
  "a criteria hand-back that changed nothing and reported a blocker asks, and Stop fails the Run before any review",
  () =>
    runEffect(
      Effect.gen(function* () {
        const bin = yield* FakeBin.make(`${rig.root}/bin`);
        yield* noGitlabMrs(bin);
        yield* repository();
        const plan = yield* planOf([
          { file: "01-first.md", title: "the first one", checks: "unit", body: CRITERIA },
          { file: "02-second.md", title: "the second one", checks: "unit" },
        ]);
        yield* approve("r-stalled", ["unit"]);
        yield* rig.queueOutputs([COUNTED_ONLY, BLOCKED, BLOCKED]);
        const status = yield* driven(
          { entry: shipped("implement"), runId: "r-stalled", input: { plan, ...FINISH } },
          (run) =>
            Effect.gen(function* () {
              const rows = yield* stallAsked(run, "01-first.md.criteria-stalled-1");
              expect(rows).toHaveLength(1);
              const [question] = rows;
              expect(question!.prompt).toContain("01-first.md");
              expect(question!.prompt).toContain("the log service is down");
              expect(question!.prompt).toContain("**Named.** Each one is named in the log.");
              expect(question!.prompt).not.toContain("not answered: **Counted.**");
              expect(optionsOf(rows, "01-first.md.criteria-stalled-1")).toEqual([
                "Hand back",
                "Stop",
              ]);
              expect((yield* prompts()).join("\n")).not.toContain(
                "01-first.md.criteria-2.prompt.md",
              );
              yield* run.answer("01-first.md.criteria-stalled-1", "Stop");
              return yield* ended(run.status);
            }),
        );
        yield* bin.restore();

        expect(status.status).toBe("failed");
        const why = outcomeText(status);
        expect(why).toContain(
          "01-first.md: a criteria hand-back reported a blocker and changed nothing, so no review starts",
        );
        expect(why).toContain("**Named.** Each one is named in the log.");
        const sent = (yield* prompts()).join("\n");
        expect(sent).not.toContain("01-first.md.criteria-2.prompt.md");
        expect(sent).not.toContain("review-1");
      }),
    ),
  120_000,
);

scenario(
  "answering Hand back to a stalled criteria hand-back hands the ticket back again, and a second stall is asked anew",
  () =>
    runEffect(
      Effect.gen(function* () {
        const bin = yield* FakeBin.make(`${rig.root}/bin`);
        yield* noGitlabMrs(bin);
        yield* repository();
        const plan = yield* planOf([
          { file: "01-first.md", title: "the first one", checks: "unit", body: CRITERIA },
          { file: "02-second.md", title: "the second one", checks: "unit" },
        ]);
        yield* approve("r-handed-again", ["unit"]);
        yield* rig.queueOutputs([COUNTED_ONLY, BLOCKED, BLOCKED]);
        const status = yield* driven(
          { entry: shipped("implement"), runId: "r-handed-again", input: { plan, ...FINISH } },
          (run) =>
            Effect.gen(function* () {
              expect(yield* stallAsked(run, "01-first.md.criteria-stalled-1")).toHaveLength(1);
              yield* run.answer("01-first.md.criteria-stalled-1", "Hand back");
              expect(yield* stallAsked(run, "01-first.md.criteria-stalled-2")).toHaveLength(1);
              yield* run.answer("01-first.md.criteria-stalled-2", "Stop");
              return yield* ended(run.status);
            }),
        );
        yield* bin.restore();

        expect(status.status).toBe("failed");
        expect(yield* asked("r-handed-again", "01-first.md.criteria-2")).toContain(
          "acceptance criterion not answered: **Named.** Each one is named in the log.",
        );
        expect((yield* prompts()).join("\n")).not.toContain("01-first.md.criteria-3.prompt.md");
      }),
    ),
  120_000,
);

scenario(
  "a blocked criteria hand-back on a tree too large to fingerprint is handed back again, not asked about",
  () =>
    runEffect(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const bin = yield* FakeBin.make(`${rig.root}/bin`);
        yield* noGitlabMrs(bin);
        yield* repository();
        const big = `${rig.projectDir}/big.bin`;
        yield* fs.writeFileString(big, "");
        yield* fs.truncate(big, FINGERPRINT_MAX_BYTES + 1);
        const plan = yield* planOf([
          { file: "01-first.md", title: "the first one", checks: "unit", body: CRITERIA },
          { file: "02-second.md", title: "the second one", checks: "unit" },
        ]);
        yield* approve("r-unmeasured", ["unit"]);
        yield* rig.queueOutputs([COUNTED_ONLY, BLOCKED, BLOCKED]);
        const status = yield* driven(
          { entry: shipped("implement"), runId: "r-unmeasured", input: { plan, ...FINISH } },
          (run) =>
            Effect.gen(function* () {
              expect(yield* stallAsked(run, "01-first.md.criteria-unmet-1")).toHaveLength(1);
              expect(
                (yield* run.asked).filter((row) => row.decision.includes("criteria-stalled")),
              ).toHaveLength(0);
              yield* run.answer("01-first.md.criteria-unmet-1", "Stop");
              return yield* ended(run.status);
            }),
        );
        yield* bin.restore();

        expect(status.status).toBe("failed");
        expect(outcomeText(status)).toContain("after 2 hand-backs");
        expect((yield* prompts()).join("\n")).toContain("01-first.md.criteria-2.prompt.md");
      }),
    ),
  120_000,
);

scenario(
  "the criteria in a work source given as words are answered as a ticket's are",
  () =>
    runEffect(
      Effect.gen(function* () {
        const bin = yield* FakeBin.make(`${rig.root}/bin`);
        yield* noGitlabMrs(bin);
        yield* repository();
        yield* approve("r-words", ["unit"]);
        yield* rig.queueOutputs([
          BUILT,
          {
            ...BUILT,
            criteria: [
              {
                criterion: "**Counted.** Every registry is counted once.",
                met: "test/count.test.ts",
              },
            ],
          },
          CLEAN_SYNTHESIS,
          OPENED,
        ]);
        const result = yield* ran({
          entry: shipped("implement"),
          runId: "r-words",
          input: {
            plan: "Count the registries.\n\n- [ ] **Counted.** Every registry is counted once.",
            ...FINISH,
          },
        });
        yield* bin.restore();

        expect(said(result)).toBe(OPENED.mr_url);
        expect(yield* asked("r-words", "build")).toContain(
          "- **Counted.** Every registry is counted once.",
        );
        expect(yield* asked("r-words", "build.criteria-1")).toContain(
          "acceptance criterion not answered: **Counted.** Every registry is counted once.",
        );
        expect(yield* asked("r-words", "review-1")).toContain("  → test/count.test.ts");
      }),
    ),
  120_000,
);

scenario(
  "a Linear issue's criteria are read from the spec the builder copied, and no copy stops the work",
  () =>
    runEffect(
      Effect.gen(function* () {
        yield* noMergeRequests;
        yield* repository();
        const fs = yield* FileSystem.FileSystem;
        const copied = "r-linear";
        yield* approve(copied, ["unit"]);
        yield* fs.makeDirectory(`${runDir(dir, copied)}/plan`, { recursive: true });
        yield* fs.writeFileString(
          `${runDir(dir, copied)}/plan/SPEC.md`,
          "# ABC-123\n\n- [ ] **Counted.** Every registry is counted once.\n",
        );
        const answered = {
          ...BUILT,
          criteria: [
            {
              criterion: "**Counted.** Every registry is counted once.",
              met: "test/count.test.ts",
            },
          ],
        };
        yield* rig.queueOutputs([BUILT, answered, CLEAN_SYNTHESIS, OPENED]);
        const result = yield* ran({
          entry: shipped("implement"),
          runId: copied,
          input: { plan: "ABC-123", ...FINISH },
        });
        expect(said(result)).toBe(OPENED.mr_url);
        expect(yield* asked(copied, "build.criteria-1")).toContain(
          "acceptance criterion not answered: **Counted.** Every registry is counted once.",
        );
      }).pipe(Effect.orDie),
    ),
  120_000,
);

scenario(
  "a Linear issue whose description the builder did not copy stops the work before any reviewer",
  () =>
    runEffect(
      Effect.gen(function* () {
        yield* noMergeRequests;
        yield* repository();
        yield* approve("r-linear-uncopied", ["unit"]);
        yield* rig.queueOutputs([BUILT]);
        const stopped = yield* ran({
          entry: shipped("implement"),
          runId: "r-linear-uncopied",
          input: { plan: "ABC-124", ...FINISH },
        });
        expect(stopped._tag).toBe("Failure");
        expect(reasonOf(stopped)).toContain("plan/SPEC.md cannot be read");
        expect(reasonOf(stopped)).toContain("Continue with a follow-up Run to finish delivery.");
        expect(yield* prompts()).not.toContainEqual(expect.stringContaining("review-1"));
      }),
    ),
  120_000,
);

for (const [kind, plan] of [
  ["typed text", "Count every registry once"],
  ["Linear issue", "ABC-125"],
  ["follow-up", "followup:r-spec-parent"],
] as const)
  scenario(
    `the spec a ${kind} build wrote is handed to its reviewers`,
    () =>
      runEffect(
        Effect.gen(function* () {
          yield* noMergeRequests;
          yield* repository();
          const fs = yield* FileSystem.FileSystem;
          const runId = `r-spec-${kind.replace(/\W/g, "-")}`;
          yield* approve(runId, ["unit"]);
          yield* fs.makeDirectory(`${runDir(dir, runId)}/plan`, { recursive: true });
          yield* fs.writeFileString(`${runDir(dir, runId)}/plan/SPEC.md`, "# The spec\n");
          yield* rig.queueOutputs([BUILT, CLEAN_SYNTHESIS, OPENED]);
          const result = yield* ran({
            entry: shipped("implement"),
            runId,
            input: { plan, ...FINISH },
          });
          expect(said(result)).toBe(OPENED.mr_url);
          expect(yield* asked(runId, "review-1")).toContain(`Spec: ${runDir(dir, runId)}/plan\n`);
        }).pipe(Effect.orDie),
      ),
    120_000,
  );

scenario(
  "the planner route is read again for each ticket, so a planner that has gone is not called live",
  () =>
    runEffect(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const bin = yield* FakeBin.make(`${rig.root}/bin`);
        yield* noGitlabMrs(bin);
        yield* repository();
        // The plan is a planner Run's own, so that Run is in this one's lineage.
        const plan = yield* planOf(
          [
            { file: "01-first.md", title: "the first one", checks: "unit" },
            { file: "02-second.md", title: "the second one", checks: "unit" },
          ],
          `${dir}/runs/r-planner/plan`,
        );
        // Named for this pass: herdr's forgetting outlives the rig.
        const planner = `planner-${idOf("plan")}`;
        yield* rig.addAgent(planner, "9-1");
        const env = hostOf().env;
        yield* registerAgent(yield* registryPath(env.stateDir, scopeFor(env, rig.projectDir)), {
          role: "planner",
          agent: planner,
          paneId: "9-1",
          workspaceId: null,
          runId: "r-planner",
          workflow: "plan",
          at: "2026-09-23T10:00:00Z",
          incarnation: { terminalId: `term-${planner}`, agentSession: null },
        }).pipe(Effect.orDie);
        yield* approve("r-planned", ["unit"]);
        yield* rig.queueOutputs([null, BUILT, CLEAN_SYNTHESIS, OPENED]);
        const running = yield* Effect.forkChild(
          ran({ entry: shipped("implement"), runId: "r-planned", input: { plan, ...FINISH } }),
        );
        const agents = `${dir}/agents/r-planned`;
        yield* until(
          () =>
            fs.exists(`${agents}/01-first.md.prompt.md`).pipe(Effect.orElseSucceed(() => false)),
          (there) => there,
        );
        rig.dropAgent(planner);
        yield* fs.writeFileString(`${agents}/01-first.md.json`, asJson(BUILT));
        const result = yield* Fiber.join(running);
        yield* bin.restore();

        expect(said(result)).toBe(OPENED.mr_url);
        expect(yield* asked("r-planned", "01-first.md")).toContain(
          `still live as agent \`${planner}\``,
        );
        const second = yield* asked("r-planned", "02-second.md");
        expect(second).not.toContain(planner);
        expect(second).toContain("There is no planner live for this work");
      }),
    ),
  120_000,
);

/**
 * A real repository on `master` whose origin is a bare repository beside it, so the default
 * branch can move under a Run as another clone pushes to it.
 */
const withOrigin = () =>
  Effect.gen(function* () {
    const git = (cwd: string, ...args: string[]) =>
      exec(["git", ...args], { cwd }).pipe(Effect.map((done) => done.stdout.trim()));
    const remote = `${rig.root}/origin.git`;
    const upstream = `${rig.root}/upstream`;
    yield* git(rig.root, "init", "-q", "--bare", "-b", "master", remote);
    for (const args of [
      ["init", "-q", "-b", "master"],
      ["config", "user.email", "t@example.com"],
      ["config", "user.name", "t"],
      ["remote", "add", "origin", remote],
    ])
      yield* git(rig.projectDir, ...args);
    const fs = yield* FileSystem.FileSystem;
    const commit = (cwd: string, file: string, body: string) =>
      Effect.gen(function* () {
        yield* fs.writeFileString(`${cwd}/${file}`, body);
        yield* git(cwd, "add", file);
        yield* git(cwd, "commit", "-qm", `change ${file}`);
        return yield* git(cwd, "rev-parse", "HEAD");
      }).pipe(Effect.orDie);
    yield* commit(rig.projectDir, "shared.txt", "one\n");
    yield* git(rig.projectDir, "push", "-q", "origin", "master");
    yield* git(rig.root, "clone", "-q", remote, upstream);
    yield* git(upstream, "config", "user.email", "u@example.com");
    yield* git(upstream, "config", "user.name", "u");
    return {
      git,
      /** A commit on the Run's own checkout, as its builder would leave one. */
      commitHere: (file: string, body: string) => commit(rig.projectDir, file, body),
      /** Master moved by somebody else, answering with where it is now. */
      moveMaster: (file: string, body: string) =>
        commit(upstream, file, body).pipe(
          Effect.tap(() => git(upstream, "push", "-q", "origin", "master")),
        ),
    };
  });

/** Until the file exists: a step whose prompt is written has been reached. */
const reached = (file: string) =>
  FileSystem.FileSystem.pipe(
    Effect.flatMap((fs) =>
      until(
        () => fs.exists(file).pipe(Effect.orElseSucceed(() => false)),
        (there) => there,
      ),
    ),
  );

type Step = Effect.Effect<void, never, ChildProcessSpawner.ChildProcessSpawner>;

/**
 * Runs implement over the tickets until it ends or parks on its merge request (the origin is
 * no forge). Each hand is a step done by hand, as its agent would, before its Output is
 * written; `outputs` answers every step in order, with null for each one done by hand.
 */
const builtUntilParked = (
  runId: string,
  tickets: ReadonlyArray<string>,
  outputs: ReadonlyArray<Schema.Json | null>,
  hands: ReadonlyArray<{ readonly operation: string; readonly step: Step }>,
  parkedOn = "Cannot open the merge request",
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const plan = yield* planOf(
      tickets.map((file) => ({ file, title: file.replace(/\.md$/, ""), checks: "unit" })),
    );
    yield* approve(runId, ["unit"]);
    yield* rig.queueOutputs(outputs);
    const running = yield* Effect.forkChild(
      ran({ entry: shipped("implement"), runId, input: { plan, ...FINISH } }),
    );
    const agents = `${dir}/agents/${runId}`;
    for (const { operation, step } of hands) {
      yield* reached(`${agents}/${operation}.prompt.md`);
      yield* step;
      yield* fs.writeFileString(`${agents}/${operation}.json`, asJson(BUILT));
    }
    const logged = () =>
      fs.readFileString(`${runDir(dir, runId)}/log.txt`).pipe(Effect.orElseSucceed(() => ""));
    const result = yield* Effect.raceFirst(
      Effect.map(Fiber.join(running), Option.some),
      Effect.as(
        until(logged, (said) => said.includes(parkedOn)),
        Option.none(),
      ),
    );
    yield* Fiber.interrupt(running);
    return { result, log: yield* logged() };
  });

const TWO_TICKETS = ["01-first.md", "02-second.md"];

scenario(
  "implement merges a moved default branch at the next ticket, and reviews against it",
  () =>
    runEffect(
      Effect.gen(function* () {
        const { git, moveMaster } = yield* withOrigin();
        let moved = "";
        const { log } = yield* builtUntilParked(
          "r-drift",
          TWO_TICKETS,
          [null, BUILT, CLEAN_SYNTHESIS],
          [
            {
              operation: "01-first.md",
              step: Effect.map(moveMaster("upstream.txt", "theirs\n"), (sha) => {
                moved = sha;
              }),
            },
          ],
        );

        expect(log).toContain(`integrated master@${moved}`);
        // A merge commit on the branch, never a rebase: what was built is still its parent.
        const parents = (yield* git(rig.projectDir, "rev-list", "--parents", "-n", "1", "HEAD"))
          .split(" ")
          .slice(1);
        expect(parents).toHaveLength(2);
        expect(parents[1]).toBe(moved);
        expect(yield* asked("r-drift", "02-second.md")).not.toContain("conflicts in");
        expect(yield* asked("r-drift", "review-1")).toContain(`${moved}...HEAD`);
      }),
    ),
  120_000,
);

scenario(
  "a conflict with the moved default branch is the builder's next work, before its ticket",
  () =>
    runEffect(
      Effect.gen(function* () {
        const { git, commitHere, moveMaster } = yield* withOrigin();
        let moved = "";
        const { log } = yield* builtUntilParked(
          "r-conflict",
          TWO_TICKETS,
          [null, null, CLEAN_SYNTHESIS],
          [
            {
              operation: "01-first.md",
              step: Effect.gen(function* () {
                yield* commitHere("shared.txt", "ours\n");
                moved = yield* moveMaster("shared.txt", "theirs\n");
              }),
            },
            // The next ticket's builder finishes the merge first.
            { operation: "02-second.md", step: Effect.asVoid(commitHere("shared.txt", "both\n")) },
          ],
        );

        expect(log).toContain(
          `integrated master@${moved}, conflicts left to the builder: shared.txt`,
        );
        const second = yield* asked("r-conflict", "02-second.md");
        expect(second).toContain(
          `Collie merged origin/master (${moved}) into this branch, and the merge stopped on conflicts in: shared.txt.`,
        );
        expect(second).toContain("Finish that merge before this ticket's work goes on");
        const parents = (yield* git(rig.projectDir, "rev-list", "--parents", "-n", "1", "HEAD"))
          .split(" ")
          .slice(1);
        expect(parents[1]).toBe(moved);
        const fs = yield* FileSystem.FileSystem;
        expect(yield* fs.exists(`${dir}/agents/r-conflict/merge-1.prompt.md`)).toBe(false);
        expect(yield* asked("r-conflict", "review-1")).toContain(`${moved}...HEAD`);
      }),
    ),
  120_000,
);

scenario(
  "a conflict found before a review round goes to the builder before the reviewer",
  () =>
    runEffect(
      Effect.gen(function* () {
        const { commitHere, moveMaster } = yield* withOrigin();
        let moved = "";
        yield* builtUntilParked(
          "r-merge",
          ["01-first.md"],
          [null, null, CLEAN_SYNTHESIS],
          [
            {
              operation: "build",
              step: Effect.gen(function* () {
                yield* commitHere("shared.txt", "ours\n");
                moved = yield* moveMaster("shared.txt", "theirs\n");
              }),
            },
            { operation: "merge-1", step: Effect.asVoid(commitHere("shared.txt", "both\n")) },
          ],
        );

        const merge = yield* asked("r-merge", "merge-1");
        expect(merge).toContain("conflicts in: shared.txt");
        expect(merge).toContain("Settle that and nothing else");
        const order = (yield* prompts()).flatMap((message) =>
          ["merge-1", "review-1"].filter((operation) => message.includes(`${operation}.prompt.md`)),
        );
        expect(order).toEqual(["merge-1", "review-1"]);
        expect(yield* asked("r-merge", "review-1")).toContain(`${moved}...HEAD`);
      }),
    ),
  120_000,
);

scenario(
  "a merge the builder leaves unfinished stops the Run before any review",
  () =>
    runEffect(
      Effect.gen(function* () {
        const { commitHere, moveMaster } = yield* withOrigin();
        const { result } = yield* builtUntilParked(
          "r-unfinished",
          ["01-first.md"],
          [null, BUILT, BUILT],
          [
            {
              operation: "build",
              step: Effect.gen(function* () {
                yield* commitHere("shared.txt", "ours\n");
                yield* moveMaster("shared.txt", "theirs\n");
              }),
            },
          ],
        );

        expect(Option.isSome(result) ? reasonOf(result.value) : "").toContain(
          "origin/master is not integrated, so the work stops",
        );
        expect(yield* asked("r-unfinished", "merge-1-2")).toContain("conflicts in: shared.txt");
        expect(yield* prompts()).not.toContainEqual(expect.stringContaining("review-1"));
      }),
    ),
  120_000,
);

scenario(
  "work left uncommitted before a review goes back to the builder, and the merge follows its commit",
  () =>
    runEffect(
      Effect.gen(function* () {
        const { git, commitHere, moveMaster } = yield* withOrigin();
        const fs = yield* FileSystem.FileSystem;
        let moved = "";
        yield* builtUntilParked(
          "r-uncommitted",
          ["01-first.md"],
          [null, null, CLEAN_SYNTHESIS],
          [
            {
              operation: "build",
              step: Effect.gen(function* () {
                yield* fs.writeFileString(`${rig.projectDir}/wip.txt`, "half\n").pipe(Effect.orDie);
                moved = yield* moveMaster("upstream.txt", "new\n");
              }),
            },
            { operation: "merge-1", step: Effect.asVoid(commitHere("wip.txt", "done\n")) },
          ],
        );

        expect(yield* asked("r-uncommitted", "merge-1")).toContain("uncommitted changes");
        expect(yield* git(rig.projectDir, "merge-base", "HEAD", "origin/master")).toBe(moved);
        expect(yield* asked("r-uncommitted", "review-1")).toContain(`${moved}...HEAD`);
      }),
    ),
  120_000,
);

scenario(
  "a default branch that cannot be fetched parks the Run before any review",
  () =>
    runEffect(
      Effect.gen(function* () {
        const { git } = yield* withOrigin();
        const { log } = yield* builtUntilParked(
          "r-unfetched",
          ["01-first.md"],
          [null],
          [
            {
              operation: "build",
              step: Effect.asVoid(
                git(rig.projectDir, "remote", "set-url", "origin", `${rig.root}/gone.git`),
              ),
            },
          ],
          "not integrated: could not fetch master from origin",
        );

        expect(log).toContain("not integrated: could not fetch master from origin");
        expect(yield* prompts()).not.toContainEqual(expect.stringContaining("review-1"));
      }),
    ),
  120_000,
);

scenario(
  "an unchanged default branch is never merged, and the review is against it as it was",
  () =>
    runEffect(
      Effect.gen(function* () {
        const { git } = yield* withOrigin();
        const master = yield* git(rig.projectDir, "rev-parse", "origin/master");
        const { log } = yield* builtUntilParked(
          "r-still",
          TWO_TICKETS,
          [null, BUILT, CLEAN_SYNTHESIS],
          [{ operation: "01-first.md", step: Effect.void }],
        );

        expect(log).not.toContain("integrated");
        expect(yield* git(rig.projectDir, "rev-list", "--merges", "HEAD")).toBe("");
        expect(yield* asked("r-still", "review-1")).toContain(`${master}...HEAD`);
      }),
    ),
  120_000,
);

scenario(
  "the merge request says what was verified, and is assigned to whoever the config names",
  () =>
    runEffect(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        yield* fs.writeFileString(
          `${rig.userDir}/config.json`,
          asJson({ gitlab: { assignee: "someone-else" } }),
        );
        const bin = yield* FakeBin.make(`${rig.root}/bin`);
        yield* noGitlabMrs(bin);
        yield* repository();
        const plan = yield* planOf([{ file: "01-only.md", title: "the only one", checks: "unit" }]);
        yield* approve("r-impl-mr", ["unit"]);
        yield* rig.queueOutputs([BUILT, CLEAN_SYNTHESIS, OPENED]);

        yield* ran({ entry: shipped("implement"), runId: "r-impl-mr", input: { plan, ...FINISH } });
        yield* bin.restore();

        const opening = yield* asked("r-impl-mr", "mr");
        expect(opening).toContain("- Assignee: `someone-else`");
        // The checkout's branch, never the one the build's Output named.
        const cleared = yield* clearance("r-impl-mr", "mr");
        expect(cleared).toBe(
          `Cleared for this step: pushing ${yield* checkoutBranch("r-impl-mr")} to origin (https://gitlab.example.com/group/project); opening or updating its merge request there.`,
        );
        expect(cleared).not.toContain("mk/one-registry");
        expect(cleared).not.toContain("merging");
        // What was collected, by whom — Collie ran it, so it is not the agent's claim.
        expect(opening).toContain("unit");
        expect(opening).toContain("by collie");
      }),
    ),
  120_000,
);

/** One ticket built, reviewed clean and delivered on a forge where nothing merges itself. */
const delivering = (runId: string) =>
  Effect.gen(function* () {
    const bin = yield* FakeBin.make(`${rig.root}/bin`);
    yield* noGitlabMrs(bin);
    yield* repository();
    const plan = yield* planOf([{ file: "01-only.md", title: "the only one", checks: "unit" }]);
    yield* approve(runId, ["unit"]);
    yield* rig.queueOutputs([BUILT, CLEAN_SYNTHESIS, OPENED]);
    return { bin, plan };
  });

/** implement parked on what next, once its merge request is open. */
const deliveredAsking = (runId: string) =>
  Effect.gen(function* () {
    const { bin, plan } = yield* delivering(runId);
    const rows = yield* parked({
      entry: shipped("implement"),
      runId,
      input: { plan },
      decision: "next",
    });
    return { bin, plan, rows };
  });

const RELEASE_STARTED = {
  invocation: "release",
  workflow: "release",
  input: { mr: OPENED.mr_url },
};

scenario(
  "implement asks what next once its merge request is open, and Finish ends with its URL",
  () =>
    runEffect(
      Effect.gen(function* () {
        const runId = "r-impl-next";
        const { bin, plan, rows } = yield* deliveredAsking(runId);
        expect(optionsOf(rows, "next")).toEqual(["Release", "Stage", "Finish"]);
        expect(rows.find((row) => row.decision === "next")?.prompt).toContain(OPENED.mr_url);

        const result = yield* answered({
          entry: shipped("implement"),
          runId,
          input: { plan },
          decision: "next",
          value: "Finish",
        });
        yield* bin.restore();

        expect(said(result)).toBe(OPENED.mr_url);
        expect(started).toEqual([]);
      }),
    ),
  120_000,
);

scenario(
  "implement offers Stage beside Release, waits for each Stage child in its checkout, then asks again until Finish",
  () =>
    runEffect(
      Effect.gen(function* () {
        const runId = "r-impl-stage";
        const { bin, plan } = yield* delivering(runId);
        const staged = yield* Deferred.make<void>();
        childWaits.set("stage-1", staged);
        const status = yield* driven(
          { entry: shipped("implement"), runId, input: { plan } },
          (run) =>
            Effect.gen(function* () {
              const next = yield* goAsked(run.asked, "next");
              expect(optionsOf([next], "next")).toEqual(["Release", "Stage", "Finish"]);
              yield* run.answer("next", "Stage");
              yield* until(
                () => Effect.sync(() => started),
                (now) => now.some((child) => child.invocation === "stage-1"),
              );
              expect((yield* run.asked).map((row) => row.decision)).not.toContain("next-2");
              yield* Deferred.succeed(staged, undefined);
              const again = yield* goAsked(run.asked, "next-2");
              expect(optionsOf([again], "next-2")).toEqual(["Release", "Stage", "Finish"]);
              yield* run.answer("next-2", "Stage");
              const third = yield* goAsked(run.asked, "next-3");
              expect(optionsOf([third], "next-3")).toEqual(["Release", "Stage", "Finish"]);
              yield* run.answer("next-3", "Finish");
              return yield* ended(run.status);
            }),
        );
        yield* bin.restore();

        expect(status.status).toBe("complete");
        expect(outcomeText(status)).toBe(OPENED.mr_url);
        expect(new Set(started.map((child) => child.invocation))).toEqual(
          new Set(["stage-1", "stage-2"]),
        );
        expect(started).toContainEqual({
          invocation: "stage-1",
          workflow: "stage",
          input: { mr: OPENED.mr_url },
        });
        expect(started).toContainEqual({
          invocation: "stage-2",
          workflow: "stage",
          input: { mr: OPENED.mr_url },
        });
        const log = yield* runLog(runId);
        expect(log).toContain("stage-1: done");
        expect(log).toContain("stage-2: done");
      }),
    ),
  120_000,
);

scenario(
  "implement offers Stage again after a Stage child fails, records its reason and can Release from the next question",
  () =>
    runEffect(
      Effect.gen(function* () {
        const runId = "r-impl-stage-fails";
        const { bin, plan } = yield* delivering(runId);
        failing = new Set(["stage-1"]);
        const status = yield* driven(
          { entry: shipped("implement"), runId, input: { plan } },
          (run) =>
            Effect.gen(function* () {
              const next = yield* goAsked(run.asked, "next");
              expect(next.prompt).toBe(`${OPENED.mr_url} is open. What next?`);
              yield* run.answer("next", "Stage");
              const resumed = yield* until(
                () => Effect.all({ status: run.status, rows: run.asked }),
                (now) =>
                  now.status.status === "failed" ||
                  now.rows.some((row) => row.decision === "next-2" && row.answer === null),
              );
              expect(resumed.status.status).not.toBe("failed");
              expect(optionsOf(resumed.rows, "next-2")).toEqual(["Release", "Stage", "Finish"]);
              expect(resumed.rows.find((row) => row.decision === "next-2")?.prompt).toContain(
                "stage-1 failed: stage-1 failed",
              );
              yield* run.answer("next-2", "Release");
              return yield* ended(run.status);
            }),
        );
        yield* bin.restore();

        expect(status.status).toBe("complete");
        expect(outcomeText(status)).toBe(`${OPENED.mr_url}; done`);
        expect(started).toContainEqual({
          invocation: "stage-1",
          workflow: "stage",
          input: { mr: OPENED.mr_url },
        });
        expect(yield* runLog(runId)).toContain("stage-1: stage-1 failed");
        expect(started).toContainEqual(RELEASE_STARTED);
      }),
    ),
  120_000,
);

scenario(
  "implement leaves Stage out of what next, saying why, while the checkout its failed Stage was refused is still held, and offers it again once a path is freed",
  () =>
    runEffect(
      Effect.gen(function* () {
        const runId = "r-impl-stage-held";
        const fs = yield* FileSystem.FileSystem;
        const bin = yield* FakeBin.make(`${rig.root}/bin`);
        yield* forgeOnPath(bin, "gitlab", {
          installed: true,
          loggedIn: [FORGE_HOST.gitlab],
          login: "tester",
          mrs: [
            {
              project: "gitlab.example.com/group/project",
              iid: "7",
              state: "open",
              sourceBranch: "feature",
            },
          ],
        });
        yield* repository();
        yield* exec(["git", "branch", "feature"], { cwd: rig.projectDir });
        const first = `${rig.root}/.herdr/worktrees/${rig.projectDir.split("/").pop()}/feature`;
        for (const slot of [first, `${first}-2`, `${first}-3`])
          yield* fs.makeDirectory(slot, { recursive: true });
        const plan = yield* planOf([{ file: "01-only.md", title: "the only one", checks: "unit" }]);
        yield* approve(runId, ["unit"]);
        yield* rig.queueOutputs([BUILT, CLEAN_SYNTHESIS, OPENED]);
        failing = new Set(["stage-1"]);
        // What the host records where Stage's checkout is refused.
        const stage = runDir(dir, `${runId}-stage-1`);
        yield* fs.makeDirectory(stage, { recursive: true });
        yield* fs.writeFileString(checkoutRefusedFile(stage), "every slot is held\n");
        const held = [first, `${first}-2`, `${first}-3`]
          .map((slot) => `${slot} is a checkout that does not say which repository it belongs to`)
          .join("; ");
        const status = yield* driven(
          { entry: shipped("implement"), runId, input: { plan } },
          (run) =>
            Effect.gen(function* () {
              yield* goAsked(run.asked, "next");
              yield* run.answer("next", "Stage");
              const again = yield* goAsked(run.asked, "next-2");
              expect(optionsOf([again], "next-2")).toEqual([
                "Release",
                "Check Stage again",
                "Finish",
              ]);
              expect(again.prompt).toContain(
                `Stage is not offered: no worktree for feature: ${held}; free one of them and retry.`,
              );
              yield* fs.remove(`${first}-3`, { recursive: true });
              yield* run.answer("next-2", "Check Stage again");
              const freed = yield* goAsked(run.asked, "next-3");
              expect(optionsOf([freed], "next-3")).toEqual(["Release", "Stage", "Finish"]);
              expect(freed.prompt).not.toContain("Stage is not offered");
              yield* run.answer("next-3", "Finish");
              return yield* ended(run.status);
            }),
        );
        yield* bin.restore();

        expect(status.status).toBe("complete");
        expect(new Set(started.map((child) => child.invocation))).toEqual(new Set(["stage-1"]));
      }),
    ),
  120_000,
);

scenario(
  "Release starts the release on the merge request where implement works, and ends with its result",
  () =>
    runEffect(
      Effect.gen(function* () {
        const runId = "r-impl-release";
        const { bin, plan } = yield* deliveredAsking(runId);

        const result = yield* answered({
          entry: shipped("implement"),
          runId,
          input: { plan },
          decision: "next",
          value: "Release",
        });
        yield* bin.restore();

        expect(said(result)).toBe(`${OPENED.mr_url}; done`);
        // No placement of its own: it works in implement's checkout, on the branch.
        expect(started).toEqual([RELEASE_STARTED]);
      }),
    ),
  120_000,
);

scenario(
  "a release that fails fails implement with the release's reason",
  () =>
    runEffect(
      Effect.gen(function* () {
        failing = new Set(["release"]);
        const runId = "r-impl-release-fails";
        const { bin, plan } = yield* deliveredAsking(runId);

        const result = yield* answered({
          entry: shipped("implement"),
          runId,
          input: { plan },
          decision: "next",
          value: "Release",
        });
        yield* bin.restore();

        expect(reasonOf(result)).toBe("release failed");
        expect(started).toEqual([RELEASE_STARTED]);
      }),
    ),
  120_000,
);

scenario(
  "implement started with then=finish ends at its merge request and asks nothing",
  () =>
    runEffect(
      Effect.gen(function* () {
        const runId = "r-impl-finish";
        const { bin, plan } = yield* delivering(runId);

        const result = yield* ran({
          entry: shipped("implement"),
          runId,
          input: { plan, ...FINISH },
        });
        yield* bin.restore();

        expect(said(result)).toBe(OPENED.mr_url);
        expect(yield* questions(runId)).toEqual([]);
        expect(started).toEqual([]);
      }),
    ),
  120_000,
);

scenario(
  "implement started with then=release releases its merge request without asking",
  () =>
    runEffect(
      Effect.gen(function* () {
        const runId = "r-impl-then-release";
        const { bin, plan } = yield* delivering(runId);

        const result = yield* ran({
          entry: shipped("implement"),
          runId,
          // oxlint-disable-next-line unicorn/no-thenable -- implement's Input is named `then`
          input: { plan, then: "release" },
        });
        yield* bin.restore();

        expect(said(result)).toBe(`${OPENED.mr_url}; done`);
        expect(yield* questions(runId)).toEqual([]);
        expect(started).toEqual([RELEASE_STARTED]);
      }),
    ),
  120_000,
);

scenario(
  "a review with only minor findings ends the rally, and the record says what it carried",
  () =>
    runEffect(
      Effect.gen(function* () {
        const bin = yield* FakeBin.make(`${rig.root}/bin`);
        yield* noGitlabMrs(bin);
        yield* repository();
        const plan = yield* planOf([{ file: "01-only.md", title: "the only one", checks: "unit" }]);
        yield* approve("r-impl-minor", ["unit"]);
        const minor = { severity: "minor", title: "the test depends on test order", file: "a.ts" };
        yield* rig.queueOutputs([
          BUILT,
          { ...CLEAN_SYNTHESIS, verdict: "findings", findings: [minor] },
          OPENED,
        ]);

        yield* ran({
          entry: shipped("implement"),
          runId: "r-impl-minor",
          input: { plan, ...FINISH },
        });
        yield* bin.restore();

        // No fix round for a minor finding, by design; but not silently either.
        expect(yield* prompts()).toHaveLength(3);
        const log = yield* (yield* FileSystem.FileSystem).readFileString(
          `${runDir(dir, "r-impl-minor")}/log.txt`,
        );
        expect(log).toContain(
          "carried 1 non-blocking finding(s) unfixed: the test depends on test order",
        );
      }),
    ),
  120_000,
);

scenario(
  "a blocking build finding is reviewed and fixed before the next ticket starts",
  () =>
    runEffect(
      Effect.gen(function* () {
        const bin = yield* FakeBin.make(`${rig.root}/bin`);
        yield* noGitlabMrs(bin);
        yield* repository();
        const plan = yield* planOf([
          { file: "01-first.md", title: "the first one", checks: "unit" },
          { file: "02-second.md", title: "the second one", checks: "unit" },
        ]);
        yield* approve("r-impl-build-findings", []);
        const finding = {
          severity: "major",
          title: "the agent reported a missing guard",
          file: "src/a.ts",
          detail: "an empty list goes through it",
        };
        yield* rig.queueOutputs([
          {
            writes: [naming("r-impl-build-findings", ["unit"])],
            output: { ...BUILT, verdict: "findings", findings: [finding] },
          },
          { ...CLEAN_SYNTHESIS, verdict: "findings", findings: [finding] },
          { verdict: "clean", fixed: [{ title: finding.title, file: finding.file }], checks: [] },
          CLEAN_SYNTHESIS,
          { ...BUILT, tickets_done: ["the second one"] },
          CLEAN_SYNTHESIS,
          OPENED,
        ]);

        const result = yield* ran({
          entry: shipped("implement"),
          runId: "r-impl-build-findings",
          input: { plan, ...FINISH },
        });
        yield* bin.restore();

        expect(said(result)).toBe(OPENED.mr_url);
        const review = yield* asked("r-impl-build-findings", "01-first.md.review-1");
        expect(review).toContain(finding.title);
        expect(review).toContain("01-first.md");
        expect(review).toContain("Later tickets have not started");
        const fix = yield* asked("r-impl-build-findings", "01-first.md.fix-1");
        expect(fix).toContain(finding.title);
        expect(fix).toContain(`- unit: true (in ${rig.projectDir})`);
        expect(yield* asked("r-impl-build-findings", "01-first.md.review-2-1")).toContain(
          `${dir}/agents/r-impl-build-findings/01-first.md.fix-1.json`,
        );
        const build = yield* asked("r-impl-build-findings", "01-first.md");
        expect(build).not.toContain("from the checks above");
        expect(build).toContain("the gate proves it on the final tree");
        expect(build).toContain("never the whole suite");
        expect(yield* asked("r-impl-build-findings", "02-second.md")).toContain("the first one");
        expect(yield* asked("r-impl-build-findings", "review-1")).toContain("Iteration 1");
        expect(yield* prompts()).toHaveLength(7);
      }),
    ),
  120_000,
);

scenario(
  "a completed build whose reported finding is cleared needs no duplicate review",
  () =>
    runEffect(
      Effect.gen(function* () {
        const bin = yield* FakeBin.make(`${rig.root}/bin`);
        yield* noGitlabMrs(bin);
        yield* repository();
        const plan = yield* planOf([
          { file: "01-only.md", title: "the first one", checks: "unit" },
        ]);
        yield* approve("r-impl-build-cleared", ["unit"]);
        yield* rig.queueOutputs([
          {
            ...BUILT,
            verdict: "findings",
            findings: [{ severity: "major", title: "the guard is missing", file: "a.ts" }],
          },
          CLEAN_SYNTHESIS,
          OPENED,
        ]);

        const result = yield* ran({
          entry: shipped("implement"),
          runId: "r-impl-build-cleared",
          input: { plan, ...FINISH },
        });
        yield* bin.restore();
        expect(said(result)).toBe(OPENED.mr_url);
        expect(yield* asked("r-impl-build-cleared", "build.review-1")).toContain(
          "the guard is missing",
        );
        expect(yield* prompts()).toHaveLength(3);
      }),
    ),
  120_000,
);

once(
  "a partial build review keeps its scope through a reviewer panel",
  () =>
    runEffect(
      Effect.gen(function* () {
        const bin = yield* FakeBin.make(`${rig.root}/bin`);
        yield* noGitlabMrs(bin);
        yield* repository();
        const entry = yield* fork(
          "implement",
          "build-panel",
          `{ ...shipped.agents, roles: { ...shipped.agents?.roles, reviewer: [{ harness: "claude", model: "opus" }, { harness: "pi", model: "openai-codex/gpt-6-astra" }] } }`,
        );
        const plan = yield* planOf([
          { file: "01-only.md", title: "the first one", checks: "unit" },
        ]);
        yield* approve("r-impl-build-panel", ["unit"]);
        yield* rig.queueOutputs([
          {
            ...BUILT,
            verdict: "findings",
            findings: [{ severity: "major", title: "the guard is missing", file: "a.ts" }],
          },
          { verdict: "clean", findings: [] },
          { verdict: "clean", findings: [] },
          CLEAN_SYNTHESIS,
          OPENED,
        ]);
        const result = yield* ran({
          entry,
          runId: "r-impl-build-panel",
          input: { plan, ...FINISH },
        });
        yield* bin.restore();

        expect(said(result)).toBe(OPENED.mr_url);
        const synthesis = yield* asked("r-impl-build-panel", "build.synthesize");
        expect(synthesis).toContain("Later tickets have not started");
        expect(synthesis).toContain("the guard is missing");
        expect(synthesis).toContain(`${dir}/agents/r-impl-build-panel/build.review-1.json`);
        expect(synthesis).toContain(`${dir}/agents/r-impl-build-panel/build.review-2.json`);
      }),
    ),
  120_000,
);

scenario(
  "a reviewer is handed the checks already recorded on its tree, and reads each rule once",
  () =>
    runEffect(
      Effect.gen(function* () {
        yield* repository();
        const run = {
          entry: shipped("review"),
          runId: "r-review-recorded",
          input: { target: "worktree" },
        };
        const runId = run.runId;
        yield* approve(runId, ["unit"]);
        yield* rig.queueOutputs([SYNTHESIS, SYNTHESIS]);
        yield* parked({ ...run, decision: "post-1" });
        yield* session(
          Host.pipe(
            Effect.flatMap((host) => host.verify({ runId, name: "unit", cwd: rig.projectDir })),
            Effect.orDie,
          ),
        );
        yield* answeredThen({ ...run, decision: "post-1", value: "Review again", until: "post-2" });
        expect(yield* asked(runId, "review-1")).toContain("(nothing is recorded for this Run)");
        const review = yield* asked(runId, "review-2-1");
        expect(review).toMatch(/- unit: pass \(by collie\), on this tree, at \d{4}-/);
        const text = review.replace(/\s+/g, " ");
        expect(text).toContain("never the whole suite");
        expect(text).toContain("read only the entries for the terms the diff touches");
        expect(text).toContain("list every instance of it in the diff in that finding");

        const both = `${yield* persona(runId, "review-2-1")}\n${review}`.replace(/\s+/g, " ");
        const rules = [
          "is a follow-up",
          "unless you can answer the reason",
          "`collie verify -- <command>`",
          '`"scope_met": true`',
          "`summary` — two sentences",
          "Every `blocker` and `major`",
          "`minor` (worth fixing, not worth blocking)",
          "Change nothing outside your Output file",
          "```json",
        ];
        expect(rules.map((rule) => [rule, both.split(rule).length - 1])).toEqual(
          rules.map((rule) => [rule, 1]),
        );
      }),
    ),
  120_000,
);

scenario(
  "a blocking finding goes back to the agent that built it, and the next review ends the rally",
  () =>
    runEffect(
      Effect.gen(function* () {
        const bin = yield* FakeBin.make(`${rig.root}/bin`);
        yield* noGitlabMrs(bin);
        yield* repository();
        const plan = yield* planOf([{ file: "01-only.md", title: "the only one", checks: "unit" }]);
        yield* approve("r-impl-fix", ["unit"]);
        const finding = {
          severity: "blocker",
          title: "the guard is on the wrong side",
          file: "src/a.ts",
          detail: "an empty list goes through it",
        };
        yield* rig.queueOutputs([
          BUILT,
          { ...CLEAN_SYNTHESIS, verdict: "findings", findings: [finding], scope_met: true },
          { verdict: "clean", fixed: [{ title: finding.title, file: finding.file }], checks: [] },
          { ...CLEAN_SYNTHESIS },
          OPENED,
        ]);

        const result = yield* ran({
          entry: shipped("implement"),
          runId: "r-impl-fix",
          input: { plan, ...FINISH },
        });
        yield* bin.restore();

        expect(said(result)).toBe(OPENED.mr_url);
        // The fix is told what was found and where the round stands, and the second review
        // is a fresh reviewer rather than the one that wrote the first.
        // How to build is the step's to say, the review is Collie's, and so is progress.
        const builder = yield* persona("r-impl-fix", "build");
        for (const prompt of [
          yield* asked("r-impl-fix", "build"),
          yield* asked("r-impl-fix", "fix-1"),
        ]) {
          const text = prompt.replace(/\s+/g, " ");
          expect(text).toContain("the `tdd` skill");
          expect(text).toMatch(
            /run the typecheck and the test files you touched, each through `collie verify`/i,
          );
          expect(text).toContain("and never the whole suite");
          expect(text).toMatch(/Commit (to this branch|each fix to this branch)/);
          expect(text).toMatch(/Collie reviews this (work|fix) in its own rally/);
          expect(text).toContain(
            "Do not run a review skill, and do not start review sub-agents or threads",
          );
          for (const said of [text, builder]) {
            expect(said).not.toContain("code-review");
            expect(said).not.toContain("steering/progress");
            expect(said).not.toContain("`implement` skill");
            expect(said).not.toContain("gh pr list");
          }
        }
        for (const message of yield* prompts())
          expect(message).not.toMatch(/^\/(implement|code-review)\b/);
        expect(
          yield* rig.cmds().pipe(Effect.map((cmds) => cmds.filter((cmd) => cmd === "agent start"))),
        ).toHaveLength(3);
        const fixing = yield* asked("r-impl-fix", "fix-1");
        expect(fixing).toContain("the guard is on the wrong side");
        expect(fixing).toContain("Iteration 1 of at most 4");
        const followUp = yield* asked("r-impl-fix", "review-2-1");
        expect(followUp).toContain("Iteration 2 of at most 4");
        // Where the implementer's account of the first round really is.
        expect(followUp).toContain(`${dir}/agents/r-impl-fix/fix-1.json`);
      }),
    ),
  120_000,
);

once("no shipped prompt sends an agent to a step directory a Run no longer has", () =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      for (const name of yield* fs.readDirectory(`${ROOT}workflows`)) {
        if (!name.endsWith(".md")) continue;
        const text = yield* fs.readFileString(`${ROOT}workflows/${name}`);
        expect([name, /\/steps\//.test(text)]).toEqual([name, false]);
      }
    }).pipe(Effect.orDie),
  ),
);

scenario(
  "a review module's own directory is a review to build from, not a wall of text",
  () =>
    runEffect(
      Effect.gen(function* () {
        const bin = yield* FakeBin.make(`${rig.root}/bin`);
        yield* noGitlabMrs(bin);
        yield* repository();
        // What a review module leaves behind: the prose a human reads and the findings a
        // card counts. There is no engine run record beside it, and there never will be.
        const fs = yield* FileSystem.FileSystem;
        const reviewed = `${rig.root}/reviewed`;
        yield* fs.makeDirectory(reviewed, { recursive: true });
        yield* fs.writeFileString(`${reviewed}/review.md`, "# Review\n\nThe guard is wrong.\n");
        yield* fs.writeFileString(`${reviewed}/findings.json`, "[]");
        yield* approve("r-impl-review", ["unit"]);
        yield* rig.queueOutputs([BUILT, CLEAN_SYNTHESIS, OPENED]);

        yield* ran({
          entry: shipped("implement"),
          runId: "r-impl-review",
          input: { plan: reviewed, ...FINISH },
        });
        yield* bin.restore();

        const building = yield* asked("r-impl-review", "build");
        expect(building).toContain(`Work source (review): ${reviewed}`);
        expect(building).toContain(`\`${reviewed}/review.md\` is the spec`);
      }),
    ),
  120_000,
);

scenario(
  "a gate the fixes cannot satisfy resumes after a repair that leaves the tree unchanged",
  () =>
    runEffect(
      Effect.gen(function* () {
        const bin = yield* FakeBin.make(`${rig.root}/bin`);
        yield* noGitlabMrs(bin);
        yield* ahead();
        const plan = yield* planOf([{ file: "01-only.md", title: "the only one", checks: "unit" }]);
        // Approved, and it fails until repaired: an Output that says the tests pass is a claim,
        // and the journal is what the gate reads.
        const count = `${rig.root}/runs`;
        yield* approve("r-impl-gate", ["unit"]);
        const fs = yield* FileSystem.FileSystem;
        yield* fs.writeFileString(
          `${evidenceDir(dir, "r-impl-gate")}/approved.json`,
          asApproved([
            {
              name: "unit",
              executable: "sh",
              argv: ["-c", `echo >> ${count}; [ -f ${rig.root}/repaired ]`],
              cwd: rig.projectDir,
            },
          ]),
        );
        const fix = {
          verdict: "clean",
          findings: [],
          fixed: [],
          disputed: [],
          checks: [{ name: "unit" }],
        };
        yield* rig.queueOutputs([BUILT, CLEAN_SYNTHESIS, fix, fix, fix, fix, OPENED]);

        const entry = shipped("implement");
        const options = {
          entry,
          runId: "r-impl-gate",
          input: { plan, ...FINISH },
          options: { outcome: "feature" },
        };
        const result = yield* running(options, (status) =>
          until(
            () => status,
            (got) => got !== "pending",
          ),
        );

        expect(result).toBe("suspended");
        expect(yield* asked("r-impl-gate", "gate-fix-4")).toContain("unit failed");
        expect(yield* parkedWhy("r-impl-gate")).toContain("unit failed");
        expect(yield* fs.exists(`${dir}/agents/r-impl-gate/mr.prompt.md`)).toBe(false);

        const evidence = session(
          Effect.flatMap(Host, (host) => host.evidence("r-impl-gate", rig.projectDir)),
        );
        const before = (yield* evidence).final;
        const failedRuns = yield* runsOf(count);
        yield* fs.writeFileString(`${rig.root}/repaired`, "fixed\n");
        const completed = yield* resumed(options);
        expect(said(completed)).toBe(OPENED.mr_url);
        // The latest record on this tree failed, so the resume runs the check again.
        expect(yield* runsOf(count)).toBeGreaterThan(failedRuns);
        expect(yield* parkedWhy("r-impl-gate")).toBe("");
        expect((yield* prompts()).filter((one) => one.includes("build-step-1"))).toHaveLength(1);
        expect((yield* evidence).final).toEqual(before);
        yield* bin.restore();
      }),
    ),
  120_000,
);

scenario(
  "missing reviewer evidence gets a fresh judgement without a gate fix chasing it",
  () =>
    runEffect(
      Effect.gen(function* () {
        const bin = yield* FakeBin.make(`${rig.root}/bin`);
        yield* noGitlabMrs(bin);
        yield* repository();
        const plan = yield* planOf([{ file: "01-only.md", title: "the only one", checks: "unit" }]);
        yield* approve("r-gate-judged", ["unit"]);
        yield* rig.queueOutputs([
          BUILT,
          { ...CLEAN_SYNTHESIS, scope_met: false },
          CLEAN_SYNTHESIS,
          OPENED,
        ]);
        const result = yield* ran({
          entry: shipped("implement"),
          runId: "r-gate-judged",
          input: { plan, ...FINISH },
          options: { outcome: "feature" },
        });
        yield* bin.restore();

        expect(said(result)).toBe(OPENED.mr_url);
        expect(yield* prompts()).toHaveLength(4);
        expect(yield* asked("r-gate-judged", "review-5-1")).toContain('"scope_met": true');
        expect(yield* asked("r-gate-judged", "review-5-1")).toContain(`Spec: ${plan}\n`);
      }),
    ),
  120_000,
);

scenario(
  "evidence outside every root fails the Run without a fresh review no reviewer could change",
  () =>
    runEffect(
      Effect.gen(function* () {
        yield* noMergeRequests;
        yield* repository();
        yield* approve("r-gate-outside", []);
        const answered = {
          ...BUILT,
          conclusion: "The board redraws every card on each change.",
          evidence: ["/elsewhere/notes.md"],
          patch: true,
        };
        const supported = { ...CLEAN_SYNTHESIS, supported: true };
        yield* rig.queueOutputs([answered, supported, supported, OPENED]);
        const result = yield* ran({
          entry: shipped("implement"),
          runId: "r-gate-outside",
          input: { plan: "why is the board slow?", ...FINISH },
          options: { outcome: "investigation" },
        });

        expect(reasonOf(result)).toContain('evidence reference "/elsewhere/notes.md" is outside');
        expect(yield* wasAsked("r-gate-outside", "review-5-1")).toBe(false);
      }),
    ),
  120_000,
);

/** The Intent `run intent set-outcome` leaves, written as an agent answers. */
const outcomeSet = (runId: string, outcome: string) => ({
  path: `${runDir(dir, runId)}/${INTENT_FILE}`,
  text: Schema.encodeSync(Schema.fromJsonString(IntentSchema))(
    amend(
      seedIntent(runId, {}),
      { kind: "set-outcome", outcome },
      "human:kind",
      "2026-10-26T00:00:00Z",
    ),
  ),
});

scenario(
  "a migration changed to a feature before its gate is proved as a feature and opens its merge request",
  () =>
    runEffect(
      Effect.gen(function* () {
        const bin = yield* FakeBin.make(`${rig.root}/bin`);
        yield* noGitlabMrs(bin);
        yield* repository();
        const plan = yield* planOf([{ file: "01-only.md", title: "the only one", checks: "unit" }]);
        const runId = "r-kind-gate";
        yield* approve(runId, ["unit"]);
        yield* rig.queueOutputs([
          BUILT,
          { writes: [outcomeSet(runId, "feature")], output: CLEAN_SYNTHESIS },
          OPENED,
        ]);
        const result = yield* ran({
          entry: shipped("implement"),
          runId,
          input: { plan, ...FINISH },
          options: { outcome: "migration" },
        });
        yield* bin.restore();

        expect(said(result)).toBe(OPENED.mr_url);
        expect(yield* wasAsked(runId, "gate-fix-1")).toBe(false);
        expect(yield* asked(runId, "mr")).toContain(
          "Outcome to prove (not given means unclassified): feature\n",
        );
      }),
    ),
  120_000,
);

scenario(
  "a refactor changed to a feature between review rounds is reviewed and proved as a feature",
  () =>
    runEffect(
      Effect.gen(function* () {
        const bin = yield* FakeBin.make(`${rig.root}/bin`);
        yield* noGitlabMrs(bin);
        yield* repository();
        const plan = yield* planOf([{ file: "01-only.md", title: "the only one", checks: "unit" }]);
        const runId = "r-kind-rally";
        yield* approve(runId, ["unit"]);
        const finding = {
          severity: "blocker",
          title: "the picker now returns every row",
          file: "src/a.ts",
          detail: "a refactor keeps behaviour, and this changes it on purpose",
        };
        yield* rig.queueOutputs([
          BUILT,
          {
            ...CLEAN_SYNTHESIS,
            verdict: "findings",
            findings: [finding],
            behavior_preserved: false,
          },
          {
            writes: [outcomeSet(runId, "feature")],
            output: {
              verdict: "clean",
              fixed: [{ title: finding.title, file: finding.file }],
              checks: [],
            },
          },
          CLEAN_SYNTHESIS,
          OPENED,
        ]);
        const result = yield* ran({
          entry: shipped("implement"),
          runId,
          input: { plan, ...FINISH },
          options: { outcome: "refactor" },
        });
        yield* bin.restore();

        const proving = "Outcome the change has to prove (not given means unclassified):";
        expect(yield* asked(runId, "review-1")).toContain(`${proving} refactor\n`);
        expect(yield* asked(runId, "review-2-1")).toContain(`${proving} feature\n`);
        expect(said(result)).toBe(OPENED.mr_url);
        expect(yield* wasAsked(runId, "review-5-1")).toBe(false);
        expect(yield* asked(runId, "mr")).toContain(
          "Outcome to prove (not given means unclassified): feature\n",
        );
      }),
    ),
  120_000,
);

const STATED = "Outcome to prove (not given means unclassified):";
const PROVES_BUG = "A bug: reproduce it first.";
const PROVES_MIGRATION = "A migration: prove it goes both ways";

scenario(
  "a migration changed to a bug while its first ticket is built prompts the next ticket as a bug",
  () =>
    runEffect(
      Effect.gen(function* () {
        const bin = yield* FakeBin.make(`${rig.root}/bin`);
        yield* noGitlabMrs(bin);
        yield* repository();
        // The second ticket's criteria are left unanswered, so the Run stops after its build.
        const plan = yield* planOf([
          { file: "01-first.md", title: "the first one", checks: "unit" },
          { file: "02-second.md", title: "the second one", checks: "unit", body: CRITERIA },
        ]);
        const runId = "r-kind-build";
        yield* approve(runId, ["unit"]);
        yield* rig.queueOutputs([
          { writes: [outcomeSet(runId, "bug")], output: BUILT },
          BUILT,
          BUILT,
          BUILT,
        ]);
        yield* stalled({
          entry: shipped("implement"),
          runId,
          input: { plan, ...FINISH },
          options: { outcome: "migration" },
        });
        yield* bin.restore();

        const first = yield* asked(runId, "01-first.md");
        expect(first).toContain(`${STATED} migration\n`);
        expect(first).toContain(PROVES_MIGRATION);
        const second = yield* asked(runId, "02-second.md");
        expect(second).toContain(`${STATED} bug\n`);
        expect(second).toContain(PROVES_BUG);
        expect(second).not.toContain(PROVES_MIGRATION);
      }),
    ),
  120_000,
);

scenario(
  "a kind changed by a build whose criteria are unmet is the kind its criteria hand-back states",
  () =>
    runEffect(
      Effect.gen(function* () {
        const bin = yield* FakeBin.make(`${rig.root}/bin`);
        yield* noGitlabMrs(bin);
        yield* repository();
        const plan = yield* planOf([
          { file: "01-only.md", title: "the only one", checks: "unit", body: CRITERIA },
        ]);
        const runId = "r-kind-criteria";
        yield* approve(runId, ["unit"]);
        yield* rig.queueOutputs([
          { writes: [outcomeSet(runId, "bug")], output: BUILT },
          BUILT,
          BUILT,
        ]);
        yield* stalled({
          entry: shipped("implement"),
          runId,
          input: { plan, ...FINISH },
          options: { outcome: "migration" },
        });
        yield* bin.restore();

        expect(yield* asked(runId, "build")).toContain(`${STATED} migration\n`);
        expect(yield* asked(runId, "build.criteria-1")).toContain(`${STATED} bug\n`);
      }),
    ),
  120_000,
);

scenario(
  "an outcome still missing after a fresh judgement fails instead of completing",
  () =>
    runEffect(
      Effect.gen(function* () {
        const bin = yield* FakeBin.make(`${rig.root}/bin`);
        yield* noGitlabMrs(bin);
        yield* repository();
        const plan = yield* planOf([{ file: "01-only.md", title: "the only one", checks: "unit" }]);
        yield* approve("r-gate-unproved", ["unit"]);
        const unproved = { ...CLEAN_SYNTHESIS, scope_met: false };
        yield* rig.queueOutputs([BUILT, unproved, unproved]);
        const result = yield* running(
          {
            entry: shipped("implement"),
            runId: "r-gate-unproved",
            input: { plan, ...FINISH },
            options: { outcome: "feature" },
          },
          (status) =>
            until(
              () => status,
              (got) => got !== "pending",
            ),
        );
        expect(result).toBe("failed");
        expect(yield* prompts()).toHaveLength(3);
        expect(
          yield* (yield* FileSystem.FileSystem).exists(
            `${dir}/agents/r-gate-unproved/mr.prompt.md`,
          ),
        ).toBe(false);
        yield* bin.restore();
      }),
    ),
  120_000,
);

scenario(
  "a gate fix runs without asking, and reaches the merge request as not re-reviewed",
  () =>
    runEffect(
      Effect.gen(function* () {
        const bin = yield* FakeBin.make(`${rig.root}/bin`);
        yield* noGitlabMrs(bin);
        yield* ahead();
        const plan = yield* planOf([{ file: "01-only.md", title: "the only one", checks: "unit" }]);
        // Fails at the gate and on its recheck, then passes once the fix has run.
        const count = `${rig.root}/runs`;
        yield* approve("r-gate-fix", ["unit"]);
        const fs = yield* FileSystem.FileSystem;
        yield* fs.writeFileString(
          `${evidenceDir(dir, "r-gate-fix")}/approved.json`,
          asApproved([
            {
              name: "unit",
              executable: "sh",
              argv: ["-c", `echo >> ${count}; wc -l < ${count} | { read n; [ $n -ge 3 ]; }`],
              cwd: rig.projectDir,
            },
          ]),
        );
        const fix = {
          verdict: "clean",
          findings: [],
          fixed: [],
          disputed: [],
          checks: [{ name: "unit" }],
        };
        yield* rig.queueOutputs([BUILT, CLEAN_SYNTHESIS, moving(fix), OPENED]);
        const result = yield* ran({
          entry: shipped("implement"),
          runId: "r-gate-fix",
          input: { plan, ...FINISH },
          options: { outcome: "feature" },
        });
        yield* bin.restore();

        expect(said(result)).toBe(OPENED.mr_url);
        const opening = yield* asked("r-gate-fix", "mr");
        expect(opening).toContain("gate fix 1");
        expect(opening).not.toContain("- unproved after");
      }),
    ),
  120_000,
);

scenario(
  "each gate pass says why it runs, in the marker while it runs and on its record after",
  () =>
    runEffect(
      Effect.gen(function* () {
        const bin = yield* FakeBin.make(`${rig.root}/bin`);
        yield* noGitlabMrs(bin);
        yield* ahead();
        const plan = yield* planOf([{ file: "01-only.md", title: "the only one", checks: "unit" }]);
        const count = `${rig.root}/runs`;
        const seen = `${rig.root}/markers`;
        const marker = `${runDir(dir, "r-passes")}/verifying`;
        yield* approve("r-passes", ["unit"]);
        const fs = yield* FileSystem.FileSystem;
        yield* fs.writeFileString(
          `${evidenceDir(dir, "r-passes")}/approved.json`,
          asApproved([
            {
              name: "unit",
              executable: "sh",
              // What the marker says while it runs, then: red at the gate and on the recheck,
              // green after the fix.
              argv: [
                "-c",
                `cat ${marker} >> ${seen}; echo >> ${seen}; echo >> ${count}; wc -l < ${count} | { read n; [ $n -ge 3 ]; }`,
              ],
              cwd: rig.projectDir,
            },
          ]),
        );
        const fix = {
          verdict: "clean",
          findings: [],
          fixed: [],
          disputed: [],
          checks: [{ name: "unit" }],
        };
        yield* rig.queueOutputs([BUILT, CLEAN_SYNTHESIS, moving(fix), OPENED]);
        yield* ran({
          entry: shipped("implement"),
          runId: "r-passes",
          input: { plan, ...FINISH },
          options: { outcome: "feature" },
        });
        yield* bin.restore();

        const passes = ["gate", "recheck", "fix"];
        const markers = (yield* fs.readFileString(seen))
          .split("\n")
          .filter((line) => line !== "")
          .map((line) => Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown))(line));
        expect(markers.slice(0, 3)).toMatchObject(
          passes.map((pass) => ({ name: "unit", pass, round: pass === "fix" ? 1 : null })),
        );
        const recorded = (yield* readVerifications(evidenceDir(dir, "r-passes"))).filter(
          (one) => one.by === "collie",
        );
        expect(recorded.slice(0, 3).map((one) => [one.pass, one.round])).toEqual([
          ["gate", undefined],
          ["recheck", undefined],
          ["fix", 1],
        ]);
        // Gone once nothing is running.
        expect(yield* fs.exists(marker)).toBe(false);
      }),
    ),
  120_000,
);

/** A Run's checks: `unit` run here, and each of `jobs` left to CI under its own name, counting any local run. */
const leftToCi = (runId: string, jobs: ReadonlyArray<string>) =>
  FileSystem.FileSystem.pipe(
    Effect.flatMap((fs) =>
      fs.makeDirectory(evidenceDir(dir, runId), { recursive: true }).pipe(
        Effect.andThen(
          fs.writeFileString(
            `${evidenceDir(dir, runId)}/approved.json`,
            asApproved([
              { name: "unit", executable: "true", argv: [], cwd: rig.projectDir },
              ...jobs.map((job) => ({
                ...counting(job, `${rig.root}/${job}-runs`),
                ci: `${job}-job`,
              })),
            ]),
          ),
        ),
      ),
    ),
    Effect.orDie,
  );

const CI_MR = `https://${PROJECT.gitlab}/-/merge_requests/31`;
const OPENED_CI = { ...OPENED, mr_url: CI_MR };
const ciRecords = (runId: string) =>
  Effect.map(readVerifications(evidenceDir(dir, runId)), (all) =>
    all.filter((one) => one.pass === "ci"),
  );
const headOf = () =>
  Effect.map(exec(["git", "rev-parse", "HEAD"], { cwd: rig.projectDir }), (ran) =>
    ran.stdout.trim(),
  );

scenario(
  "a check left to CI is never run at the gate, and its job's pass on the merge request's head is recorded as its proof",
  () =>
    runEffect(
      Effect.gen(function* () {
        const { bin } = yield* deliveringOn("gitlab");
        const head = yield* headOf();
        const forge = yield* forgeOnPath(bin, "gitlab", {
          installed: true,
          loggedIn: [FORGE_HOST.gitlab],
          login: "tester",
          mrs: [
            {
              project: PROJECT.gitlab,
              iid: "31",
              state: "open",
              head,
              jobs: [{ name: "nuxi-job", state: "passed" }],
            },
          ],
        });
        const plan = yield* planOf([{ file: "01-only.md", title: "the only one", checks: "nuxi" }]);
        const runId = "r-ci-passed";
        yield* leftToCi(runId, ["nuxi"]);
        yield* rig.queueOutputs([BUILT, CLEAN_SYNTHESIS, OPENED_CI]);
        const result = yield* ran({
          entry: shipped("implement"),
          runId,
          input: { plan, ...FINISH },
          options: { outcome: "feature" },
        });
        yield* bin.restore();
        expect(said(result)).toBe(CI_MR);
        // Nobody ran it: not the gate, not the proof's rely.
        expect(yield* runsOf(`${rig.root}/nuxi-runs`)).toBe(0);
        for (const operation of ["build", "mr"])
          expect(yield* asked(runId, operation)).toContain(
            "- nuxi: left to CI (job nuxi-job), do not run it",
          );
        const fs = yield* FileSystem.FileSystem;
        const reviews = (yield* fs.readDirectory(`${dir}/agents/${runId}`)).filter(
          (file) => file.startsWith("review") && file.endsWith(".prompt.md"),
        );
        expect(reviews.length).toBeGreaterThan(0);
        for (const file of reviews)
          expect(yield* fs.readFileString(`${dir}/agents/${runId}/${file}`)).toContain(
            "left to CI: proved by nuxi-job on the merge request's head",
          );
        const [proof, ...more] = yield* ciRecords(runId);
        expect(more).toEqual([]);
        expect(proof).toMatchObject({
          name: "nuxi",
          by: "collie",
          pass: "ci",
          result: "pass",
          argv: ["-c", expect.stringContaining("nuxi-runs")],
          start: { head_sha: head },
          end: { head_sha: head },
          job: { name: "nuxi-job", url: `https://${PROJECT.gitlab}/-/jobs/1` },
        });
        expect(proof!.executable).toEndWith("/sh");
        expect(forge.requests().some((call) => call.url.includes("/pipelines/3100/jobs"))).toBe(
          true,
        );
      }),
    ),
  120_000,
);

scenario(
  "a job missing from the merge request's pipeline parks the Run, naming the check, the job and the commit",
  () =>
    runEffect(
      Effect.gen(function* () {
        const { bin } = yield* deliveringOn("gitlab");
        const head = yield* headOf();
        yield* forgeOnPath(bin, "gitlab", {
          installed: true,
          loggedIn: [FORGE_HOST.gitlab],
          login: "tester",
          mrs: [
            {
              project: PROJECT.gitlab,
              iid: "31",
              state: "open",
              head,
              jobs: [{ name: "lint", state: "passed" }],
            },
          ],
        });
        const plan = yield* planOf([{ file: "01-only.md", title: "the only one", checks: "unit" }]);
        const runId = "r-ci-missing";
        yield* leftToCi(runId, ["nuxi"]);
        yield* rig.queueOutputs([BUILT, CLEAN_SYNTHESIS, OPENED_CI]);
        const why = yield* parkedOn({
          entry: shipped("implement"),
          runId,
          input: { plan, ...FINISH },
          options: { outcome: "feature" },
        });
        yield* bin.restore();
        expect(why).toContain(
          `nuxi is left to CI and unproved: job nuxi-job on ${head.slice(0, 12)} is not in its pipeline`,
        );
        expect(yield* ciRecords(runId)).toEqual([]);
      }),
    ),
  120_000,
);

scenario(
  "a check left to CI on a checkout with no forge parks the Run, naming the check, the job and the commit",
  () =>
    runEffect(
      Effect.gen(function* () {
        yield* noMergeRequests;
        yield* repository();
        yield* exec(["git", "remote", "remove", "upstream"], { cwd: rig.projectDir });
        const head = yield* headOf();
        const plan = yield* planOf([{ file: "01-only.md", title: "the only one", checks: "unit" }]);
        const runId = "r-ci-no-forge";
        yield* leftToCi(runId, ["nuxi"]);
        yield* rig.queueOutputs([BUILT, CLEAN_SYNTHESIS]);
        const why = yield* parkedOn({
          entry: shipped("implement"),
          runId,
          input: { plan, ...FINISH },
          options: { outcome: "feature" },
        });
        expect(why).toContain("Cannot open the merge request");
        expect(why).toContain(
          `nuxi is left to CI and unproved: job nuxi-job on ${head.slice(0, 12)} cannot be read without one.`,
        );
        expect(yield* runsOf(`${rig.root}/nuxi-runs`)).toBe(0);
      }),
    ),
  120_000,
);

scenario(
  "a resumed Run waits on its jobs again, and records no second proof for a job already recorded",
  () =>
    runEffect(
      Effect.gen(function* () {
        const { bin } = yield* deliveringOn("gitlab");
        const head = yield* headOf();
        const mrWith = (e2e: "passed" | "cancelled") => ({
          installed: true,
          loggedIn: [FORGE_HOST.gitlab],
          login: "tester",
          mrs: [
            {
              project: PROJECT.gitlab,
              iid: "31",
              state: "open" as const,
              head,
              jobs: [
                { name: "nuxi-job", state: "passed" as const },
                { name: "e2e-job", state: e2e },
              ],
            },
          ],
        });
        const forge = yield* forgeOnPath(bin, "gitlab", mrWith("cancelled"));
        const plan = yield* planOf([{ file: "01-only.md", title: "the only one", checks: "unit" }]);
        const runId = "r-ci-resumed";
        yield* leftToCi(runId, ["nuxi", "e2e"]);
        yield* rig.queueOutputs([BUILT, CLEAN_SYNTHESIS, OPENED_CI]);
        const options = {
          entry: shipped("implement"),
          runId,
          input: { plan, ...FINISH },
          options: { outcome: "feature" },
        };
        expect(yield* parkedOn(options)).toContain(
          `e2e is left to CI and unproved: job e2e-job on ${head.slice(0, 12)} is cancelled`,
        );
        expect((yield* ciRecords(runId)).map((one) => one.name)).toEqual(["nuxi"]);

        yield* forge.set(mrWith("passed"));
        const result = yield* resumed(options);
        yield* bin.restore();
        expect(said(result)).toBe(CI_MR);
        expect((yield* ciRecords(runId)).map((one) => one.name)).toEqual(["nuxi", "e2e"]);
      }),
    ),
  120_000,
);

const CI_BASE = "b".repeat(40);
const CI_LOG = (id: number) => `glab ci trace ${id} --repo ${PROJECT.gitlab}`;

/** The merge request on `head`, its `nuxi-job` as given, and that job at the base as given. */
const ciOn = (head: string, job: FakeJob, base?: FakeJob["state"]): ForgeModel => ({
  installed: true,
  loggedIn: [FORGE_HOST.gitlab],
  login: "tester",
  mrs: [
    {
      project: PROJECT.gitlab,
      iid: "31",
      state: "open",
      head,
      targetBranch: "main",
      jobs: [job],
      base: { at: CI_BASE, jobs: base === undefined ? [] : [{ name: "nuxi-job", state: base }] },
    },
  ],
});
const ciFailing: FakeJob = { name: "nuxi-job", state: "failed", retried: "failed" };

/** A commit on top of HEAD with the same tree, and the write that makes it HEAD, as a fix's push would. */
const ciFixCommit = (parent = "HEAD") =>
  Effect.gen(function* () {
    const sha = (yield* exec(
      ["git", "commit-tree", `${parent}^{tree}`, "-p", parent, "-m", "ci fix"],
      {
        cwd: rig.projectDir,
      },
    )).stdout.trim();
    const branch = (yield* exec(["git", "symbolic-ref", "--short", "HEAD"], {
      cwd: rig.projectDir,
    })).stdout.trim();
    return {
      sha,
      write: { path: `${rig.projectDir}/.git/refs/heads/${branch}`, text: `${sha}\n` },
    };
  });

const ciNotes = <E>(forge: { readonly model: () => Effect.Effect<ForgeModel, E> }) =>
  Effect.map(forge.model(), (model) => model.notes?.[`${PROJECT.gitlab}!31`] ?? []);

scenario(
  "a failed job green where the branch leaves its target is retried, then fixed in a CI fix round whose push it passes on",
  () =>
    runEffect(
      Effect.gen(function* () {
        const { bin } = yield* deliveringOn("gitlab");
        const head = yield* headOf();
        const forge = yield* forgeOnPath(bin, "gitlab", ciOn(head, ciFailing, "passed"));
        const fix = yield* ciFixCommit();
        const plan = yield* planOf([{ file: "01-only.md", title: "the only one", checks: "unit" }]);
        const runId = "r-ci-fixed";
        yield* leftToCi(runId, ["nuxi"]);
        yield* rig.queueOutputs([
          BUILT,
          CLEAN_SYNTHESIS,
          OPENED_CI,
          {
            writes: [
              fix.write,
              forge.holding(ciOn(fix.sha, { name: "nuxi-job", state: "passed" }, "passed")),
            ],
            output: GATE_FIX,
          },
        ]);
        const result = yield* ran({
          entry: shipped("implement"),
          runId,
          input: { plan, ...FINISH },
          options: { outcome: "feature" },
        });
        yield* bin.restore();
        expect(said(result)).toBe(CI_MR);
        const prompt = yield* asked(runId, "ci-fix-1");
        for (const text of [
          "nuxi: its CI job nuxi-job failed",
          `https://${PROJECT.gitlab}/-/jobs/101`,
          CI_LOG(101),
          "without `ci.skip`",
        ])
          expect(prompt).toContain(text);
        const [proof, ...more] = yield* ciRecords(runId);
        expect(more).toEqual([]);
        expect(proof).toMatchObject({ name: "nuxi", end: { head_sha: fix.sha } });
        expect(
          forge.requests().filter((call) => call.method === "POST" && call.url.endsWith("/retry")),
        ).toHaveLength(1);
        expect((yield* ciNotes(forge)).join("\n")).toContain(
          "ci fix 1 landed after the last review and was not re-reviewed",
        );
        // The merge request is updated by the push, never opened again.
        const fs = yield* FileSystem.FileSystem;
        expect(
          (yield* fs.readDirectory(`${dir}/agents/${runId}`)).filter(
            (file) => file.startsWith("mr") && file.endsWith(".prompt.md"),
          ),
        ).toEqual(["mr.prompt.md"]);
      }),
    ),
  120_000,
);

scenario(
  "a job red where the branch leaves its target is reported on the merge request and the record, and gets no round",
  () =>
    runEffect(
      Effect.gen(function* () {
        const { bin } = yield* deliveringOn("gitlab");
        const head = yield* headOf();
        const forge = yield* forgeOnPath(bin, "gitlab", ciOn(head, ciFailing, "failed"));
        const plan = yield* planOf([{ file: "01-only.md", title: "the only one", checks: "unit" }]);
        const runId = "r-ci-red-base";
        yield* leftToCi(runId, ["nuxi"]);
        yield* rig.queueOutputs([BUILT, CLEAN_SYNTHESIS, OPENED_CI]);
        const result = yield* ran({
          entry: shipped("implement"),
          runId,
          input: { plan, ...FINISH },
          options: { outcome: "feature" },
        });
        yield* bin.restore();
        expect(said(result)).toBe(CI_MR);
        const line = `nuxi: job nuxi-job also fails at ${CI_BASE.slice(0, 12)}, where this branch leaves its target branch, so it failed before this Run's changes`;
        expect((yield* ciNotes(forge)).join("\n")).toContain(line);
        const fs = yield* FileSystem.FileSystem;
        expect(yield* fs.readFileString(`${runDir(dir, runId)}/log.txt`)).toContain(line);
        expect(yield* fs.exists(`${dir}/agents/${runId}/ci-fix-1.prompt.md`)).toBe(false);
        expect(
          forge.requests().some((call) => call.method === "POST" && call.url.endsWith("/retry")),
        ).toBe(false);
        expect(yield* ciRecords(runId)).toEqual([]);
      }),
    ),
  120_000,
);

scenario(
  "a failed job that passes on its retry is a Flake named on the merge request, and gets no round",
  () =>
    runEffect(
      Effect.gen(function* () {
        const { bin } = yield* deliveringOn("gitlab");
        const head = yield* headOf();
        const forge = yield* forgeOnPath(
          bin,
          "gitlab",
          ciOn(head, { name: "nuxi-job", state: "failed", retried: "passed" }, "passed"),
        );
        const plan = yield* planOf([{ file: "01-only.md", title: "the only one", checks: "unit" }]);
        const runId = "r-ci-flake";
        yield* leftToCi(runId, ["nuxi"]);
        yield* rig.queueOutputs([BUILT, CLEAN_SYNTHESIS, OPENED_CI]);
        const result = yield* ran({
          entry: shipped("implement"),
          runId,
          input: { plan, ...FINISH },
          options: { outcome: "feature" },
        });
        yield* bin.restore();
        expect(said(result)).toBe(CI_MR);
        const line = `nuxi: job nuxi-job failed on ${head.slice(0, 12)}, then passed when retried — a Flake, so this Run has not settled it.`;
        expect((yield* ciNotes(forge)).join("\n")).toContain(line);
        const fs = yield* FileSystem.FileSystem;
        expect(yield* fs.readFileString(`${runDir(dir, runId)}/log.txt`)).toContain(line);
        expect(yield* fs.exists(`${dir}/agents/${runId}/ci-fix-1.prompt.md`)).toBe(false);
        expect(yield* ciRecords(runId)).toHaveLength(1);
      }),
    ),
  120_000,
);

scenario(
  "a job that keeps failing parks the Run after the last CI fix round, naming the check, the job and the commit",
  () =>
    runEffect(
      Effect.gen(function* () {
        const { bin } = yield* deliveringOn("gitlab");
        const head = yield* headOf();
        const forge = yield* forgeOnPath(bin, "gitlab", ciOn(head, ciFailing, "passed"));
        const rounds: Array<Schema.Json> = [];
        let parent = "HEAD";
        let last = head;
        for (let round = 0; round < 4; round++) {
          const fix = yield* ciFixCommit(parent);
          rounds.push({
            writes: [fix.write, forge.holding(ciOn(fix.sha, ciFailing, "passed"))],
            output: GATE_FIX,
          });
          parent = last = fix.sha;
        }
        const plan = yield* planOf([{ file: "01-only.md", title: "the only one", checks: "unit" }]);
        const runId = "r-ci-limit";
        yield* leftToCi(runId, ["nuxi"]);
        yield* rig.queueOutputs([BUILT, CLEAN_SYNTHESIS, OPENED_CI, ...rounds]);
        const why = yield* parkedOn({
          entry: shipped("implement"),
          runId,
          input: { plan, ...FINISH },
          options: { outcome: "feature" },
        });
        yield* bin.restore();
        expect(why).toContain("Outcome unproved after 4 CI fixes");
        expect(why).toContain(
          `nuxi is left to CI and unproved: job nuxi-job on ${last.slice(0, 12)} is failed`,
        );
        const fs = yield* FileSystem.FileSystem;
        expect(yield* fs.exists(`${dir}/agents/${runId}/ci-fix-4.prompt.md`)).toBe(true);
        expect(yield* fs.exists(`${dir}/agents/${runId}/ci-fix-5.prompt.md`)).toBe(false);
        expect(yield* ciRecords(runId)).toEqual([]);
      }),
    ),
  180_000,
);

scenario(
  "a CI fix round that changes nothing and disputes the failure ends the rounds, and the merge request names the dispute",
  () =>
    runEffect(
      Effect.gen(function* () {
        const { bin } = yield* deliveringOn("gitlab");
        const head = yield* headOf();
        const forge = yield* forgeOnPath(bin, "gitlab", ciOn(head, ciFailing, "passed"));
        const plan = yield* planOf([{ file: "01-only.md", title: "the only one", checks: "unit" }]);
        const runId = "r-ci-disputed";
        yield* leftToCi(runId, ["nuxi"]);
        yield* rig.queueOutputs([
          BUILT,
          CLEAN_SYNTHESIS,
          OPENED_CI,
          disputing(["nuxi: its CI job nuxi-job failed"]),
        ]);
        const result = yield* ran({
          entry: shipped("implement"),
          runId,
          input: { plan, ...FINISH },
          options: { outcome: "feature" },
        });
        yield* bin.restore();
        expect(said(result)).toBe(CI_MR);
        const line =
          "nuxi: its CI job nuxi-job failed: ci fix 1 disputed it and changed nothing: the check is wrong, not the code";
        expect((yield* ciNotes(forge)).join("\n")).toContain(line);
        const fs = yield* FileSystem.FileSystem;
        expect(yield* fs.readFileString(`${runDir(dir, runId)}/log.txt`)).toContain(line);
        expect(yield* fs.exists(`${dir}/agents/${runId}/ci-fix-2.prompt.md`)).toBe(false);
        expect(yield* ciRecords(runId)).toEqual([]);
        expect(yield* parkedWhy(runId)).toBe("");
      }),
    ),
  120_000,
);

scenario(
  "a CI fix round whose push leaves the head where it was parks the Run, saying so",
  () =>
    runEffect(
      Effect.gen(function* () {
        const { bin } = yield* deliveringOn("gitlab");
        const head = yield* headOf();
        yield* forgeOnPath(bin, "gitlab", ciOn(head, ciFailing, "passed"));
        const plan = yield* planOf([{ file: "01-only.md", title: "the only one", checks: "unit" }]);
        const runId = "r-ci-unmoved";
        yield* leftToCi(runId, ["nuxi"]);
        yield* rig.queueOutputs([BUILT, CLEAN_SYNTHESIS, OPENED_CI, GATE_FIX]);
        const why = yield* parkedOn({
          entry: shipped("implement"),
          runId,
          input: { plan, ...FINISH },
          options: { outcome: "feature" },
        });
        yield* bin.restore();
        expect(why).toContain(
          `ci fix 1 pushed no new commit: the head is still ${head.slice(0, 12)}`,
        );
        expect(why).toContain(
          `nuxi is left to CI and unproved: job nuxi-job on ${head.slice(0, 12)} is failed`,
        );
        const fs = yield* FileSystem.FileSystem;
        expect(yield* fs.exists(`${dir}/agents/${runId}/ci-fix-2.prompt.md`)).toBe(false);
      }),
    ),
  120_000,
);

/** A check that counts its runs in `counter`, `$n` being this one, and passes while `holds` does. */
const counting = (name: string, counter: string, holds = "true") => ({
  name,
  executable: "sh",
  argv: ["-c", `echo >> ${counter}; wc -l < ${counter} | { read n; ${holds}; }`],
  cwd: rig.projectDir,
});

const runsOf = (counter: string) =>
  FileSystem.FileSystem.pipe(
    Effect.flatMap((fs) => fs.readFileString(counter)),
    Effect.map((text) => text.split("\n").length - 1),
    Effect.orElseSucceed(() => 0),
  );

/** Each check the proof relied on, by name, and the verification it named. */
const reliedOn = (runId: string) =>
  FileSystem.FileSystem.pipe(
    Effect.flatMap((fs) => fs.readFileString(`${runDir(dir, runId)}/log.txt`)),
    Effect.map((log) =>
      [...log.matchAll(/proof: (\S+) relies on verification (\S+)/g)].map(([, name, id]) => ({
        name,
        id,
      })),
    ),
  );

const GATE_FIX = { verdict: "clean", findings: [], fixed: [], disputed: [], checks: [] };

/** A gate fix that moves the tree, so the gate runs its checks again on it. */
const moving = <A>(output: A, n = 1) => ({
  writes: [{ path: `${rig.projectDir}/fixed-${n}`, text: "fixed\n" }],
  output,
});

scenario(
  "a green Run runs each check once: the proof relies on the gate's own pass",
  () =>
    runEffect(
      Effect.gen(function* () {
        const bin = yield* FakeBin.make(`${rig.root}/bin`);
        yield* noGitlabMrs(bin);
        yield* repository();
        const plan = yield* planOf([{ file: "01-only.md", title: "the only one", checks: "unit" }]);
        const runId = "r-gate-once";
        yield* approve(runId, ["unit", "lint"]);
        const fs = yield* FileSystem.FileSystem;
        yield* fs.writeFileString(
          `${evidenceDir(dir, runId)}/approved.json`,
          asApproved([
            counting("unit", `${rig.root}/unit-runs`),
            counting("lint", `${rig.root}/lint-runs`),
          ]),
        );
        yield* rig.queueOutputs([BUILT, CLEAN_SYNTHESIS, OPENED]);
        const result = yield* ran({
          entry: shipped("implement"),
          runId,
          input: { plan, ...FINISH },
          options: { outcome: "feature" },
        });
        yield* bin.restore();

        expect(said(result)).toBe(OPENED.mr_url);
        expect(yield* runsOf(`${rig.root}/unit-runs`)).toBe(1);
        expect(yield* runsOf(`${rig.root}/lint-runs`)).toBe(1);
        const gate = (yield* readVerifications(evidenceDir(dir, runId))).filter(
          (one) => one.by === "collie",
        );
        expect(gate.map((one) => [one.name, one.pass])).toEqual([
          ["unit", "gate"],
          ["lint", "gate"],
        ]);
        expect(gate.every((one) => one.environment !== undefined)).toBe(true);
        expect(yield* reliedOn(runId)).toEqual(gate.map(({ name, id }) => ({ name, id })));
      }),
    ),
  120_000,
);

scenario(
  "a check that passed at the gate is not run again on that tree, by a gate fix or the proof",
  () =>
    runEffect(
      Effect.gen(function* () {
        const bin = yield* FakeBin.make(`${rig.root}/bin`);
        yield* noGitlabMrs(bin);
        yield* ahead();
        const plan = yield* planOf([{ file: "01-only.md", title: "the only one", checks: "unit" }]);
        const runId = "r-gate-fix-reruns";
        yield* approve(runId, ["unit", "lint"]);
        const fs = yield* FileSystem.FileSystem;
        yield* fs.writeFileString(
          `${evidenceDir(dir, runId)}/approved.json`,
          asApproved([
            // Red at the gate and on the recheck, until the fix re-grants it.
            counting("unit", `${rig.root}/unit-runs`, "false"),
            counting("lint", `${rig.root}/lint-runs`),
          ]),
        );
        const regranting = {
          writes: [
            {
              path: `${evidenceDir(dir, runId)}/approved.json`,
              text: asApproved([
                { name: "unit", executable: "true", argv: [], cwd: rig.projectDir },
                counting("lint", `${rig.root}/lint-runs`),
              ]),
            },
          ],
          output: GATE_FIX,
        };
        yield* rig.queueOutputs([BUILT, CLEAN_SYNTHESIS, regranting, OPENED]);
        const result = yield* ran({
          entry: shipped("implement"),
          runId,
          input: { plan, ...FINISH },
          options: { outcome: "feature" },
        });
        yield* bin.restore();

        expect(said(result)).toBe(OPENED.mr_url);
        // The fix left the tree as it was, so lint's pass at the gate still answers.
        expect(yield* runsOf(`${rig.root}/lint-runs`)).toBe(1);
        expect(yield* runsOf(`${rig.root}/unit-runs`)).toBe(2);
        const records = yield* readVerifications(evidenceDir(dir, runId));
        const last = (name: string, pass: string) =>
          records.findLast((one) => one.name === name && one.pass === pass)!.id;
        expect(yield* reliedOn(runId)).toEqual([
          { name: "unit", id: last("unit", "fix") },
          { name: "lint", id: last("lint", "gate") },
        ]);
      }),
    ),
  120_000,
);

/** bun's output for a run whose one failure is `the flaky one` in test/one.test.ts. */
const FLAKY_OUTPUT = [
  "test/one.test.ts:",
  "(pass) the steady one [1.00ms]",
  "(fail) the flaky one [2.00ms]",
  "",
  "1 tests failed:",
  "(fail) the flaky one [2.00ms]",
  "",
  " 1 pass",
  " 1 fail",
].join("\n");

const ONE_PASSES = `printf ' 1 pass\\n 0 fail\\n' >&2`;
const ONE_FAILS = `printf ' 0 pass\\n 1 fail\\n' >&2; exit 1`;
/** bun at the base, naming the test `-t` asked for as the one that failed. */
const FAILS_AT_BASE = `n="\${4#^}"; printf '(fail) %s\\n 0 pass\\n 1 fail\\nRan 1 test across 1 file.\\n' "\${n%$}" >&2; exit 1`;

/**
 * `unit` counts its runs in `counter` and, while `fails` holds for run `$n`, prints
 * `printed` and exits 1; a `bun` on PATH stands in for each of its tests run alone: `rerun`
 * on the branch, and `atBase` (passing, unless given) where it leaves the default branch,
 * counted in `base-runs`.
 */
const failingThen = (
  runId: string,
  options: {
    readonly fails: string;
    readonly printed: string;
    readonly rerun: string;
    readonly atBase?: string;
  },
) =>
  Effect.gen(function* () {
    const bin = yield* FakeBin.make(`${rig.root}/bin`);
    yield* noGitlabMrs(bin);
    yield* bin.add(
      "bun",
      `if [ "$(git log -1 --format=%s)" = first ]; then echo >> ${rig.root}/base-runs; ${options.atBase ?? ONE_PASSES}; else ${options.rerun}; fi`,
    );
    const fs = yield* FileSystem.FileSystem;
    yield* fs.writeFileString(`${rig.root}/printed`, `${options.printed}\n`);
    yield* approve(runId, ["unit"]);
    yield* fs.writeFileString(
      `${evidenceDir(dir, runId)}/approved.json`,
      asApproved([
        counting(
          "unit",
          `${rig.root}/unit-runs`,
          `! { ${options.fails}; } || { cat ${rig.root}/printed >&2; exit 1; }`,
        ),
      ]),
    );
    return bin;
  });

const passesOf = (runId: string) =>
  readVerifications(evidenceDir(dir, runId)).pipe(
    Effect.map((records) =>
      records.filter((one) => one.by === "collie").map((one) => one.pass ?? "check"),
    ),
  );

const gateFixed = (runId: string) =>
  FileSystem.FileSystem.pipe(
    Effect.flatMap((fs) => fs.exists(`${dir}/agents/${runId}/gate-fix-1.prompt.md`)),
  );

scenario(
  "a check failing only on a test that passes alone reaches the merge request with that Flake, and no fix",
  () =>
    runEffect(
      Effect.gen(function* () {
        const runId = "r-flake";
        yield* ahead();
        const plan = yield* planOf([{ file: "01-only.md", title: "the only one", checks: "unit" }]);
        const bin = yield* failingThen(runId, {
          fails: "true",
          printed: FLAKY_OUTPUT,
          rerun: `printf ' 1 pass\\n 0 fail\\n' >&2`,
        });
        yield* rig.queueOutputs([BUILT, CLEAN_SYNTHESIS, OPENED]);
        const result = yield* ran({
          entry: shipped("implement"),
          runId,
          input: { plan, ...FINISH },
          options: { outcome: "feature" },
        });
        yield* bin.restore();

        expect(said(result)).toBe(OPENED.mr_url);
        expect(yield* asked(runId, "mr")).toContain(
          "- unit: the flaky one (test/one.test.ts) failed, then passed when run again alone on the same tree — a Flake, so this Run has not settled it.",
        );
        expect(yield* gateFixed(runId)).toBe(false);
        // Neither the recheck nor the proof runs the whole check again.
        expect(yield* passesOf(runId)).toEqual(["gate", "rerun"]);
      }),
    ),
  120_000,
);

scenario(
  "a test that fails when run again alone goes to gate fix 1, whose finding names it",
  () =>
    runEffect(
      Effect.gen(function* () {
        const runId = "r-flake-not";
        yield* ahead();
        const plan = yield* planOf([{ file: "01-only.md", title: "the only one", checks: "unit" }]);
        // Red at the gate, green at the base and after the fix.
        const bin = yield* failingThen(runId, {
          fails: "[ $n -eq 1 ]",
          printed: FLAKY_OUTPUT,
          rerun: `printf ' 0 pass\\n 1 fail\\n' >&2; exit 1`,
        });
        yield* rig.queueOutputs([BUILT, CLEAN_SYNTHESIS, moving(GATE_FIX), OPENED]);
        const result = yield* ran({
          entry: shipped("implement"),
          runId,
          input: { plan, ...FINISH },
          options: { outcome: "feature" },
        });
        yield* bin.restore();

        expect(said(result)).toBe(OPENED.mr_url);
        expect(yield* asked(runId, "gate-fix-1")).toContain(
          "unit failed: the flaky one (test/one.test.ts)",
        );
        expect(yield* passesOf(runId)).toEqual(["gate", "rerun", "baseline", "fix"]);
        expect(yield* asked(runId, "mr")).not.toContain("a Flake");
      }),
    ),
  120_000,
);

scenario(
  "a failed check that names no tests is run again whole, as before",
  () =>
    runEffect(
      Effect.gen(function* () {
        const runId = "r-flake-whole";
        yield* ahead();
        const plan = yield* planOf([{ file: "01-only.md", title: "the only one", checks: "unit" }]);
        const bin = yield* failingThen(runId, {
          fails: "[ $n -eq 1 ]",
          printed: "something broke",
          rerun: "exit 1",
        });
        yield* rig.queueOutputs([BUILT, CLEAN_SYNTHESIS, OPENED]);
        const result = yield* ran({
          entry: shipped("implement"),
          runId,
          input: { plan, ...FINISH },
          options: { outcome: "feature" },
        });
        yield* bin.restore();

        expect(said(result)).toBe(OPENED.mr_url);
        expect(yield* gateFixed(runId)).toBe(false);
        expect(yield* passesOf(runId)).toEqual(["gate", "recheck"]);
      }),
    ),
  120_000,
);

/** The commit where this branch leaves the default branch, as the merge request shortens it. */
const baseSha = () =>
  exec(["git", "rev-parse", "--short=12", "HEAD~1"], { cwd: rig.projectDir }).pipe(
    Effect.map((done) => done.stdout.trim()),
  );

const runsAtBase = () =>
  FileSystem.FileSystem.pipe(
    Effect.flatMap((fs) => fs.readFileString(`${rig.root}/base-runs`)),
    Effect.map((text) => text.split("\n").length - 1),
    Effect.orElseSucceed(() => 0),
  );

scenario(
  "a check whose only still-failing test also fails at the base reaches the merge request naming it, with no fix",
  () =>
    runEffect(
      Effect.gen(function* () {
        const runId = "r-base-red";
        yield* ahead();
        const plan = yield* planOf([{ file: "01-only.md", title: "the only one", checks: "unit" }]);
        const bin = yield* failingThen(runId, {
          fails: "true",
          printed: FLAKY_OUTPUT,
          rerun: ONE_FAILS,
          atBase: FAILS_AT_BASE,
        });
        const base = yield* baseSha();
        yield* rig.queueOutputs([BUILT, CLEAN_SYNTHESIS, OPENED]);
        const result = yield* ran({
          entry: shipped("implement"),
          runId,
          input: { plan, ...FINISH },
          options: { outcome: "feature" },
        });
        yield* bin.restore();

        expect(said(result)).toBe(OPENED.mr_url);
        expect(yield* asked(runId, "mr")).toContain(
          `- unit: the flaky one (test/one.test.ts) also fails at ${base}, where this branch leaves the default branch, so it failed before this Run's changes.`,
        );
        expect(yield* gateFixed(runId)).toBe(false);
        expect(yield* parkedWhy(runId)).toBe("");
        expect(yield* passesOf(runId)).toEqual(["gate", "rerun", "baseline"]);
      }),
    ),
  120_000,
);

const TWO_FAILED = [
  "test/one.test.ts:",
  "(fail) the old one [1.00ms]",
  "(fail) the new one [2.00ms]",
  "",
  "2 tests failed:",
  "(fail) the old one [1.00ms]",
  "(fail) the new one [2.00ms]",
  "",
  " 0 pass",
  " 2 fail",
].join("\n");

scenario(
  "of two still-failing tests, the one that passes at the base is the only one gate fix 1 is handed",
  () =>
    runEffect(
      Effect.gen(function* () {
        const runId = "r-base-half";
        yield* ahead();
        const plan = yield* planOf([{ file: "01-only.md", title: "the only one", checks: "unit" }]);
        const bin = yield* failingThen(runId, {
          fails: "[ $n -eq 1 ]",
          printed: TWO_FAILED,
          rerun: ONE_FAILS,
          atBase: `case "$4" in *old*) ${FAILS_AT_BASE};; *) ${ONE_PASSES};; esac`,
        });
        yield* rig.queueOutputs([BUILT, CLEAN_SYNTHESIS, moving(GATE_FIX), OPENED]);
        const result = yield* ran({
          entry: shipped("implement"),
          runId,
          input: { plan, ...FINISH },
          options: { outcome: "feature" },
        });
        yield* bin.restore();

        expect(said(result)).toBe(OPENED.mr_url);
        const fixing = yield* asked(runId, "gate-fix-1");
        expect(fixing).toContain("unit failed: the new one (test/one.test.ts)");
        expect(fixing).not.toContain("unit failed: the old one");
      }),
    ),
  120_000,
);

scenario(
  "a still-failing test the base does not have goes to the fixes, and is run at that base once",
  () =>
    runEffect(
      Effect.gen(function* () {
        const runId = "r-base-missing";
        yield* ahead();
        const plan = yield* planOf([{ file: "01-only.md", title: "the only one", checks: "unit" }]);
        const bin = yield* failingThen(runId, {
          fails: "[ $n -le 2 ]",
          printed: FLAKY_OUTPUT,
          rerun: ONE_FAILS,
          atBase: `echo 'error: regex "^the flaky one$" matched 0 tests.' >&2; exit 1`,
        });
        yield* rig.queueOutputs([
          BUILT,
          CLEAN_SYNTHESIS,
          moving(GATE_FIX),
          moving(GATE_FIX, 2),
          OPENED,
        ]);
        const result = yield* ran({
          entry: shipped("implement"),
          runId,
          input: { plan, ...FINISH },
          options: { outcome: "feature" },
        });
        yield* bin.restore();

        expect(said(result)).toBe(OPENED.mr_url);
        expect(yield* asked(runId, "gate-fix-1")).toContain(
          "unit failed: the flaky one (test/one.test.ts)",
        );
        expect(yield* asked(runId, "gate-fix-2")).toContain(
          "unit failed: the flaky one (test/one.test.ts)",
        );
        expect(yield* runsAtBase()).toBe(1);
        expect(yield* passesOf(runId)).toEqual([
          "gate",
          "rerun",
          "baseline",
          "fix",
          "rerun",
          "fix",
        ]);
      }),
    ),
  120_000,
);

scenario(
  "a whole recheck that names its failed tests has each run alone before any fix",
  () =>
    runEffect(
      Effect.gen(function* () {
        const runId = "r-recheck-named";
        yield* ahead();
        const plan = yield* planOf([{ file: "01-only.md", title: "the only one", checks: "unit" }]);
        const bin = yield* failingThen(runId, {
          fails: "true",
          printed: FLAKY_OUTPUT,
          rerun: ONE_PASSES,
        });
        // Names nothing at the gate, then the flaky one on its recheck.
        const fs = yield* FileSystem.FileSystem;
        yield* fs.writeFileString(
          `${evidenceDir(dir, runId)}/approved.json`,
          asApproved([
            counting(
              "unit",
              `${rig.root}/unit-runs`,
              `{ [ $n -eq 1 ] && echo broke >&2; } || cat ${rig.root}/printed >&2; exit 1`,
            ),
          ]),
        );
        yield* rig.queueOutputs([BUILT, CLEAN_SYNTHESIS, OPENED]);
        const result = yield* ran({
          entry: shipped("implement"),
          runId,
          input: { plan, ...FINISH },
          options: { outcome: "feature" },
        });
        yield* bin.restore();

        expect(said(result)).toBe(OPENED.mr_url);
        expect(yield* gateFixed(runId)).toBe(false);
        expect(yield* passesOf(runId)).toEqual(["gate", "recheck", "rerun"]);
      }),
    ),
  120_000,
);

scenario(
  "a proof recheck has its named failures run alone, so a disputed gap keeps its title and the Run is not parked",
  () =>
    runEffect(
      Effect.gen(function* () {
        const runId = "r-proof-named";
        yield* ahead();
        const plan = yield* planOf([{ file: "01-only.md", title: "the only one", checks: "" }]);
        const bin = yield* failingThen(runId, {
          fails: "true",
          printed: TWO_FAILED,
          rerun: `case "$4" in *old*) ${ONE_PASSES};; *) ${ONE_FAILS};; esac`,
        });
        const disputed = "unit failed: the new one (test/one.test.ts)";
        yield* rig.queueOutputs([BUILT, CLEAN_SYNTHESIS, disputing([disputed]), OPENED]);
        const result = yield* ran({
          entry: shipped("implement"),
          runId,
          input: { plan, ...FINISH },
          options: { outcome: "feature" },
        });
        yield* bin.restore();

        expect(said(result)).toBe(OPENED.mr_url);
        expect(yield* parkedWhy(runId)).toBe("");
        expect(yield* asked(runId, "mr")).toContain(
          `- ${disputed}: gate fix 1 disputed it and changed nothing`,
        );
        expect((yield* passesOf(runId)).filter((pass) => pass === "recheck")).toEqual([]);
      }),
    ),
  120_000,
);

const THREE_FAILED = [
  "test/one.test.ts:",
  "(fail) the flaky one [1.00ms]",
  "(fail) the old one [1.00ms]",
  "(fail) the new one [2.00ms]",
  "",
  "3 tests failed:",
  "(fail) the flaky one [1.00ms]",
  "(fail) the old one [1.00ms]",
  "(fail) the new one [2.00ms]",
  "",
  " 0 pass",
  " 3 fail",
].join("\n");

scenario(
  "a check left failing on a disputed test still has its Flake and its base failure named in the merge request",
  () =>
    runEffect(
      Effect.gen(function* () {
        const runId = "r-mixed-disclosure";
        yield* ahead();
        const plan = yield* planOf([{ file: "01-only.md", title: "the only one", checks: "" }]);
        const bin = yield* failingThen(runId, {
          fails: "true",
          printed: THREE_FAILED,
          rerun: `case "$4" in *flaky*) ${ONE_PASSES};; *) ${ONE_FAILS};; esac`,
          atBase: `case "$4" in *old*) ${FAILS_AT_BASE};; *) ${ONE_PASSES};; esac`,
        });
        const disputed = "unit failed: the new one (test/one.test.ts)";
        yield* rig.queueOutputs([BUILT, CLEAN_SYNTHESIS, disputing([disputed]), OPENED]);
        const result = yield* ran({
          entry: shipped("implement"),
          runId,
          input: { plan, ...FINISH },
          options: { outcome: "feature" },
        });
        yield* bin.restore();

        expect(said(result)).toBe(OPENED.mr_url);
        const mr = yield* asked(runId, "mr");
        expect(mr).toContain(`- ${disputed}: gate fix 1 disputed it and changed nothing`);
        expect(mr).toContain(
          "- unit: the flaky one (test/one.test.ts) failed, then passed when run again alone on the same tree",
        );
        // The check's own command, not a run of one of its tests.
        expect(mr).not.toContain("-t ^the new one$");
        expect(mr).toMatch(
          /- unit: the old one \(test\/one\.test\.ts\) also fails at [0-9a-f]{12}, where this branch leaves the default branch/,
        );
      }),
    ),
  120_000,
);

/** Checks red until `${rig.root}/repaired` exists. */
const stuck = (runId: string, names: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const bin = yield* FakeBin.make(`${rig.root}/bin`);
    yield* noGitlabMrs(bin);
    yield* approve(runId, [...names]);
    const fs = yield* FileSystem.FileSystem;
    yield* fs.writeFileString(
      `${evidenceDir(dir, runId)}/approved.json`,
      asApproved(
        names.map((name) =>
          counting(name, `${rig.root}/${name}-runs`, `[ -f ${rig.root}/repaired ]`),
        ),
      ),
    );
    return bin;
  });

const disputing = (titles: ReadonlyArray<string>) => ({
  ...GATE_FIX,
  disputed: titles.map((title) => ({
    severity: "blocker",
    title,
    reason: "the check is wrong, not the code",
  })),
});

/** A fix that repairs the checks and moves the tree, so the gate runs them again. */
const repairing = () => ({
  writes: [
    { path: `${rig.root}/repaired`, text: "fixed\n" },
    { path: `${rig.projectDir}/repaired`, text: "fixed\n" },
  ],
  output: GATE_FIX,
});

scenario(
  "a gate fix that commits nothing and disputes its one finding is the last, and the merge request names the dispute",
  () =>
    runEffect(
      Effect.gen(function* () {
        const runId = "r-gate-disputed";
        yield* ahead();
        const plan = yield* planOf([{ file: "01-only.md", title: "the only one", checks: "" }]);
        const bin = yield* stuck(runId, ["unit"]);
        yield* rig.queueOutputs([BUILT, CLEAN_SYNTHESIS, disputing(["unit failed"]), OPENED]);
        const result = yield* ran({
          entry: shipped("implement"),
          runId,
          input: { plan, ...FINISH },
          options: { outcome: "feature" },
        });
        yield* bin.restore();

        expect(said(result)).toBe(OPENED.mr_url);
        const fs = yield* FileSystem.FileSystem;
        expect(yield* fs.exists(`${dir}/agents/${runId}/gate-fix-2.prompt.md`)).toBe(false);
        expect(yield* asked(runId, "mr")).toContain(
          "- unit failed: gate fix 1 disputed it and changed nothing: the check is wrong, not the code",
        );
        expect(yield* parkedWhy(runId)).toBe("");
        expect(yield* fs.readFileString(`${runDir(dir, runId)}/log.txt`)).toContain(
          "outcome unproved: unit failed; gate fix 1 disputed them and changed nothing",
        );
        const records = yield* readVerifications(evidenceDir(dir, runId));
        expect(records.findLast((one) => one.name === "unit")?.result).toBe("fail");
        // Nothing runs again on the tree the fix left as it was, not even the proof's recheck.
        expect(yield* passesOf(runId)).toEqual(["gate", "recheck"]);
      }),
    ),
  120_000,
);

scenario(
  "a gate fix that disputes its finding but changes the tree is followed by another",
  () =>
    runEffect(
      Effect.gen(function* () {
        const runId = "r-gate-disputed-moved";
        yield* ahead();
        const plan = yield* planOf([{ file: "01-only.md", title: "the only one", checks: "" }]);
        const bin = yield* stuck(runId, ["unit"]);
        const moved = {
          writes: [{ path: `${rig.projectDir}/touched`, text: "changed\n" }],
          output: disputing(["unit failed"]),
        };
        yield* rig.queueOutputs([BUILT, CLEAN_SYNTHESIS, moved, repairing(), OPENED]);
        const result = yield* ran({
          entry: shipped("implement"),
          runId,
          input: { plan, ...FINISH },
          options: { outcome: "feature" },
        });
        yield* bin.restore();

        expect(said(result)).toBe(OPENED.mr_url);
        expect(yield* asked(runId, "gate-fix-2")).toContain("unit failed");
        expect(yield* asked(runId, "mr")).not.toContain("disputed it and changed nothing");
        // Each fix moved the tree, so each is followed by the check run whole.
        expect(yield* passesOf(runId)).toEqual(["gate", "recheck", "fix", "fix"]);
      }),
    ),
  120_000,
);

scenario(
  "a gate fix that changes nothing but leaves one of two findings undisputed is followed by another",
  () =>
    runEffect(
      Effect.gen(function* () {
        const runId = "r-gate-disputed-half";
        yield* ahead();
        const plan = yield* planOf([{ file: "01-only.md", title: "the only one", checks: "" }]);
        const bin = yield* stuck(runId, ["unit", "lint"]);
        yield* rig.queueOutputs([
          BUILT,
          CLEAN_SYNTHESIS,
          disputing(["unit failed"]),
          repairing(),
          OPENED,
        ]);
        const result = yield* ran({
          entry: shipped("implement"),
          runId,
          input: { plan, ...FINISH },
          options: { outcome: "feature" },
        });
        yield* bin.restore();

        expect(said(result)).toBe(OPENED.mr_url);
        const second = yield* asked(runId, "gate-fix-2");
        expect(second).toContain("unit failed");
        expect(second).toContain("lint failed");
        expect(yield* asked(runId, "mr")).not.toContain("disputed it and changed nothing");
        // Gate fix 1 left the tree as it was, so nothing ran between the two fixes.
        expect(yield* passesOf(runId)).toEqual([
          "gate",
          "gate",
          "recheck",
          "recheck",
          "fix",
          "fix",
        ]);
      }),
    ),
  120_000,
);

scenario(
  "a check re-granted with another command by a gate fix that leaves the tree as it was is run",
  () =>
    runEffect(
      Effect.gen(function* () {
        const runId = "r-gate-regranted";
        yield* ahead();
        const plan = yield* planOf([{ file: "01-only.md", title: "the only one", checks: "" }]);
        const bin = yield* stuck(runId, ["unit"]);
        const regranting = { writes: [naming(runId, ["unit"])], output: GATE_FIX };
        yield* rig.queueOutputs([BUILT, CLEAN_SYNTHESIS, regranting, OPENED]);
        const result = yield* ran({
          entry: shipped("implement"),
          runId,
          input: { plan, ...FINISH },
          options: { outcome: "feature" },
        });
        yield* bin.restore();

        expect(said(result)).toBe(OPENED.mr_url);
        expect(yield* parkedWhy(runId)).toBe("");
        expect(yield* passesOf(runId)).toEqual(["gate", "recheck", "fix"]);
      }),
    ),
  120_000,
);

/** A Run whose lint fails until `${rig.root}/repaired` exists, parked once its four gate fixes run out. */
const heldUnproved = (runId: string) =>
  Effect.gen(function* () {
    const bin = yield* FakeBin.make(`${rig.root}/bin`);
    yield* noGitlabMrs(bin);
    yield* ahead();
    const plan = yield* planOf([{ file: "01-only.md", title: "the only one", checks: "unit" }]);
    yield* approve(runId, ["unit", "lint"]);
    const fs = yield* FileSystem.FileSystem;
    yield* fs.writeFileString(
      `${evidenceDir(dir, runId)}/approved.json`,
      asApproved([
        counting("unit", `${rig.root}/unit-runs`),
        counting("lint", `${rig.root}/lint-runs`, `[ -f ${rig.root}/repaired ]`),
      ]),
    );
    yield* rig.queueOutputs([
      BUILT,
      CLEAN_SYNTHESIS,
      GATE_FIX,
      GATE_FIX,
      GATE_FIX,
      GATE_FIX,
      OPENED,
    ]);
    const options = {
      entry: shipped("implement"),
      runId,
      input: { plan, ...FINISH },
      options: { outcome: "feature" },
    };
    const result = yield* running(options, (status) =>
      until(
        () => status,
        (got) => got !== "pending",
      ),
    );
    expect(result).toBe("suspended");
    expect(yield* parkedWhy(runId)).toContain("Outcome unproved after 4 gate fixes: lint failed");
    return { bin, options };
  });

scenario(
  "after a restart the host runs again a check it collected before it started",
  () =>
    runEffect(
      Effect.gen(function* () {
        const runId = "r-gate-resumed";
        const { bin, options } = yield* heldUnproved(runId);
        const suspended = yield* runsOf(`${rig.root}/unit-runs`);
        // The gate's pass answered each fix, which left the tree as it was.
        expect(suspended).toBe(1);
        // Its gate run and one recheck.
        expect(yield* runsOf(`${rig.root}/lint-runs`)).toBe(2);

        const fs = yield* FileSystem.FileSystem;
        yield* fs.writeFileString(`${rig.root}/repaired`, "");
        expect(said(yield* resumed(options))).toBe(OPENED.mr_url);
        yield* bin.restore();
        expect(yield* runsOf(`${rig.root}/unit-runs`)).toBe(suspended + 1);
        expect(yield* runsOf(`${rig.root}/lint-runs`)).toBe(3);
      }),
    ),
  120_000,
);

scenario(
  "a Run held unproved and resumed with nothing repaired runs its failing check whole once more, and is held again",
  () =>
    runEffect(
      Effect.gen(function* () {
        const runId = "r-gate-resumed-unrepaired";
        const { bin, options } = yield* heldUnproved(runId);
        expect(yield* runsOf(`${rig.root}/lint-runs`)).toBe(2);
        const fs = yield* FileSystem.FileSystem;
        yield* fs.remove(controlPath(dir, PARKED, runId));

        const why = yield* resumedUntilParked(options);
        yield* bin.restore();
        expect(why).toContain("Outcome unproved after 4 gate fixes: lint failed");
        expect(yield* runsOf(`${rig.root}/lint-runs`)).toBe(3);
      }),
    ),
  120_000,
);

scenario(
  "a pass collected before the toolchain changed is run again for the proof",
  () =>
    runEffect(
      Effect.gen(function* () {
        const bin = yield* FakeBin.make(`${rig.root}/bin`);
        yield* noGitlabMrs(bin);
        yield* repository();
        const plan = yield* planOf([{ file: "01-only.md", title: "the only one", checks: "unit" }]);
        const runId = "r-gate-new-tool";
        yield* approve(runId, ["unit", "lint"]);
        const fs = yield* FileSystem.FileSystem;
        const tool = `${rig.root}/tools/unit`;
        const unitRuns = `${rig.root}/v2/unit-runs`;
        yield* fs.makeDirectory(`${rig.root}/tools`, { recursive: true });
        yield* fs.makeDirectory(`${rig.root}/v2`);
        yield* fs.writeFileString(tool, `#!/bin/sh\necho >> ${unitRuns}\n`);
        yield* fs.chmod(tool, 0o755);
        yield* fs.writeFileString(
          `${evidenceDir(dir, runId)}/approved.json`,
          asApproved([
            { name: "unit", executable: tool, argv: [], cwd: rig.projectDir },
            // Upgrades unit's tool once, after unit has passed with the old one.
            counting(
              "lint",
              `${rig.root}/lint-runs`,
              `grep -Fqx '# v2' ${tool} || echo '# v2' >> ${tool}`,
            ),
          ]),
        );
        yield* rig.queueOutputs([BUILT, CLEAN_SYNTHESIS, OPENED]);
        const result = yield* ran({
          entry: shipped("implement"),
          runId,
          input: { plan, ...FINISH },
          options: { outcome: "feature" },
        });
        yield* bin.restore();

        expect(said(result)).toBe(OPENED.mr_url);
        expect(yield* runsOf(unitRuns)).toBe(2);
        expect(yield* runsOf(`${rig.root}/lint-runs`)).toBe(1);
      }),
    ),
  120_000,
);

scenario(
  "a pass collected before the tree changed is never relied on: the check runs again on the new tree",
  () =>
    runEffect(
      Effect.gen(function* () {
        const bin = yield* FakeBin.make(`${rig.root}/bin`);
        yield* noGitlabMrs(bin);
        yield* repository();
        const plan = yield* planOf([{ file: "01-only.md", title: "the only one", checks: "unit" }]);
        const runId = "r-gate-new-tree";
        yield* approve(runId, ["unit", "lint"]);
        const fs = yield* FileSystem.FileSystem;
        yield* fs.writeFileString(
          `${evidenceDir(dir, runId)}/approved.json`,
          asApproved([
            counting("unit", `${rig.root}/unit-runs`),
            // Leaves a file in the tree the first time, after unit has passed on the tree before it.
            counting("lint", `${rig.root}/lint-runs`, `[ -f generated ] || echo > generated`),
          ]),
        );
        yield* rig.queueOutputs([BUILT, CLEAN_SYNTHESIS, GATE_FIX, OPENED]);
        const result = yield* ran({
          entry: shipped("implement"),
          runId,
          input: { plan, ...FINISH },
          options: { outcome: "feature" },
        });
        yield* bin.restore();

        expect(said(result)).toBe(OPENED.mr_url);
        const records = yield* readVerifications(evidenceDir(dir, runId));
        const unit = records.filter((one) => one.name === "unit");
        const final = (yield* fingerprint(rig.projectDir)).fingerprint;
        // Passed at the gate on the tree before lint's file, so run again after the fix.
        expect(unit.map((one) => [one.pass, one.result])).toEqual([
          ["gate", "pass"],
          ["fix", "pass"],
        ]);
        expect(unit[0]?.end.fingerprint).not.toBe(final);
        expect(yield* runsOf(`${rig.root}/unit-runs`)).toBe(2);
        const relied = (yield* reliedOn(runId)).find((one) => one.name === "unit");
        expect(relied?.id).toBe(unit[1]?.id);
        expect(unit[1]?.end.fingerprint).toBe(final);
      }),
    ),
  120_000,
);

scenario(
  "a failed check that names no tests reaches the fix loop, and is never run at the base",
  () =>
    runEffect(
      Effect.gen(function* () {
        const bin = yield* FakeBin.make(`${rig.root}/bin`);
        yield* noGitlabMrs(bin);
        yield* repository();
        const plan = yield* planOf([{ file: "01-only.md", title: "the only one", checks: "unit" }]);
        yield* approve("r-impl-red-base", ["unit"]);
        const fs = yield* FileSystem.FileSystem;
        const count = `${rig.root}/runs`;
        yield* fs.writeFileString(
          `${evidenceDir(dir, "r-impl-red-base")}/approved.json`,
          asApproved([
            {
              name: "unit",
              executable: "sh",
              argv: ["-c", `echo >> ${count}; wc -l < ${count} | { read n; [ $n -ge 3 ]; }`],
              cwd: rig.projectDir,
            },
          ]),
        );
        yield* rig.queueOutputs([
          BUILT,
          CLEAN_SYNTHESIS,
          moving({ verdict: "clean", fixed: [], disputed: [], checks: [{ name: "unit" }] }),
          OPENED,
        ]);
        const result = yield* ran({
          entry: shipped("implement"),
          runId: "r-impl-red-base",
          input: { plan, ...FINISH },
          options: { outcome: "feature" },
        });
        yield* bin.restore();

        expect(said(result)).toBe(OPENED.mr_url);
        const opening = yield* asked("r-impl-red-base", "mr");
        expect(opening).toContain("gate fix 1");
        expect(yield* asked("r-impl-red-base", "gate-fix-1")).toContain("unit failed");
        expect(yield* passesOf("r-impl-red-base")).toEqual(["gate", "recheck", "fix"]);
      }),
    ),
  120_000,
);

scenario(
  "a check failing on a branch, whose output names no tests, is the Run's to fix and is never run at the base",
  () =>
    runEffect(
      Effect.gen(function* () {
        const bin = yield* FakeBin.make(`${rig.root}/bin`);
        yield* noGitlabMrs(bin);
        yield* repository();
        const git = (...args: string[]) =>
          exec(["git", ...args], { cwd: rig.projectDir }).pipe(
            Effect.map((done) => done.stdout.trim()),
          );
        const base = yield* git("rev-parse", "HEAD");
        yield* git("checkout", "-qb", "feature");
        const fs = yield* FileSystem.FileSystem;
        yield* fs.writeFileString(`${rig.projectDir}/broken`, "");
        yield* git("add", "broken");
        yield* git("commit", "-qm", "break it");
        const plan = yield* planOf([{ file: "01-only.md", title: "the only one", checks: "unit" }]);
        yield* approve("r-impl-own-red", ["unit"]);
        yield* fs.writeFileString(
          `${evidenceDir(dir, "r-impl-own-red")}/approved.json`,
          asApproved([
            { name: "unit", executable: "test", argv: ["!", "-f", "broken"], cwd: rig.projectDir },
          ]),
        );
        const fix = {
          verdict: "clean",
          findings: [],
          fixed: [],
          disputed: [],
          checks: [{ name: "unit" }],
        };
        yield* rig.queueOutputs([BUILT, CLEAN_SYNTHESIS, fix, fix, fix, fix, OPENED]);
        const result = yield* running(
          {
            entry: shipped("implement"),
            runId: "r-impl-own-red",
            input: { plan, ...FINISH },
            options: { outcome: "feature" },
          },
          (status) =>
            until(
              () => status,
              (got) => got !== "pending",
            ),
        );
        yield* bin.restore();

        expect(result).toBe("suspended");
        expect(yield* asked("r-impl-own-red", "gate-fix-1")).toContain("unit failed");
        expect(yield* parkedWhy("r-impl-own-red")).toContain("unit failed");
        expect(yield* fs.exists(`${dir}/agents/r-impl-own-red/mr.prompt.md`)).toBe(false);
        // Its output names no tests, so nothing is run at the base.
        expect(yield* git("rev-parse", "--abbrev-ref", "HEAD")).toBe("feature");
        const journal = yield* fs.readFileString(
          `${evidenceDir(dir, "r-impl-own-red")}/steering/verifications.jsonl`,
        );
        expect(journal).not.toContain(base);
      }),
    ),
  120_000,
);

scenario(
  "a blocking dispute nobody answers, and an assumption nobody settled, go to the merge request",
  () =>
    runEffect(
      Effect.gen(function* () {
        const bin = yield* FakeBin.make(`${rig.root}/bin`);
        yield* noGitlabMrs(bin);
        yield* repository();
        const plan = yield* planOf([{ file: "01-only.md", title: "the only one", checks: "unit" }]);
        yield* approve("r-impl-dispute", ["unit"]);
        const finding = {
          severity: "blocker",
          title: "the guard is on the wrong side",
          file: "src/a.ts",
        };
        yield* rig.queueOutputs([
          // An assumption the spec did not settle travels the same way.
          { ...BUILT, assumptions: ["callers never pass an empty list"] },
          { ...CLEAN_SYNTHESIS, verdict: "findings", findings: [finding] },
          {
            verdict: "clean",
            findings: [],
            fixed: [],
            disputed: [{ ...finding, reason: "the list is never empty here" }],
            checks: [{ name: "unit" }],
          },
          // The next review neither raises it again nor answers the reason.
          { ...CLEAN_SYNTHESIS },
          OPENED,
        ]);
        const result = yield* ran({
          entry: shipped("implement"),
          runId: "r-impl-dispute",
          input: { plan, ...FINISH },
        });
        yield* bin.restore();

        expect(said(result)).toBe(OPENED.mr_url);
        const opening = yield* asked("r-impl-dispute", "mr");
        expect(opening).toContain(
          "- disputed blocking finding: [blocker] the guard is on the wrong side (src/a.ts): the list is never empty here",
        );
        expect(opening).toContain("- assumed in build: callers never pass an empty list");
        // Still the human's, so the card counts it whatever the last review wrote.
        expect(
          (yield* findingsIn(runDir(dir, "r-impl-dispute"))).map((one) => one.title),
        ).toContain("the guard is on the wrong side");
      }),
    ),
  120_000,
);

scenario(
  "a blocking dispute the next review repeats as minor stays a blocker on the card",
  () =>
    runEffect(
      Effect.gen(function* () {
        const bin = yield* FakeBin.make(`${rig.root}/bin`);
        yield* noGitlabMrs(bin);
        yield* repository();
        const plan = yield* planOf([{ file: "01-only.md", title: "the only one", checks: "unit" }]);
        yield* approve("r-impl-weakened", ["unit"]);
        const finding = {
          severity: "blocker",
          title: "the guard is on the wrong side",
          file: "src/a.ts",
        };
        yield* rig.queueOutputs([
          BUILT,
          { ...CLEAN_SYNTHESIS, verdict: "findings", findings: [finding] },
          {
            verdict: "clean",
            findings: [],
            fixed: [],
            disputed: [{ ...finding, reason: "the list is never empty here" }],
            checks: [{ name: "unit" }],
          },
          {
            ...CLEAN_SYNTHESIS,
            verdict: "findings",
            findings: [{ ...finding, severity: "minor" }],
          },
          OPENED,
        ]);
        const result = yield* ran({
          entry: shipped("implement"),
          runId: "r-impl-weakened",
          input: { plan, ...FINISH },
        });
        yield* bin.restore();

        expect(said(result)).toBe(OPENED.mr_url);
        expect(yield* asked("r-impl-weakened", "mr")).toContain(
          "- disputed blocking finding: [blocker] the guard is on the wrong side",
        );
        const onFile = yield* findingsIn(runDir(dir, "r-impl-weakened"));
        expect(
          onFile.filter((one) => one.title === finding.title).map((one) => one.severity),
        ).toEqual(["blocker"]);
      }),
    ),
  120_000,
);

scenario(
  "a dispute left open by the last fix reaches the merge request, and so does that fix being unreviewed",
  () =>
    runEffect(
      Effect.gen(function* () {
        const bin = yield* FakeBin.make(`${rig.root}/bin`);
        yield* noGitlabMrs(bin);
        yield* repository();
        const plan = yield* planOf([{ file: "01-only.md", title: "the only one", checks: "unit" }]);
        yield* approve("r-final-dispute", ["unit"]);
        yield* collect(evidenceDir(dir, "r-final-dispute"), {
          run: "r-final-dispute",
          name: "unit",
          executable: "true",
          argv: [],
          cwd: rig.projectDir,
          by: "agent",
        }).pipe(Effect.orDie);
        const blocker = (title: string) => ({
          severity: "blocker",
          title,
          file: "src/a.ts",
          detail: "it breaks",
        });
        const round = (title: string): Schema.Json[] => [
          { ...CLEAN_SYNTHESIS, verdict: "findings", findings: [blocker(title)] },
          { verdict: "clean", fixed: [{ title, file: "src/a.ts" }], checks: [{ name: "unit" }] },
        ];
        yield* rig.queueOutputs([
          BUILT,
          { ...CLEAN_SYNTHESIS, verdict: "findings", findings: [blocker("one"), blocker("B")] },
          {
            verdict: "clean",
            fixed: [{ title: "one", file: "src/a.ts" }],
            disputed: [{ ...blocker("B"), reason: "a reason the reviewer answers" }],
            checks: [{ name: "unit" }],
          },
          ...round("two"),
          ...round("three"),
          // B again, answered: the dispute that follows is the one the human settles.
          {
            ...CLEAN_SYNTHESIS,
            verdict: "findings",
            findings: [blocker("A"), { ...blocker("B"), rebuttal: "it is not by design" }],
          },
          {
            verdict: "clean",
            fixed: [{ title: "A", file: "src/a.ts" }],
            disputed: [{ ...blocker("B"), reason: "B is by design" }],
            checks: [{ name: "unit" }],
          },
          OPENED,
        ]);
        const result = yield* ran({
          entry: shipped("implement"),
          runId: "r-final-dispute",
          input: { plan, ...FINISH },
        });
        yield* bin.restore();

        expect(said(result)).toBe(OPENED.mr_url);
        const opening = yield* asked("r-final-dispute", "mr");
        expect(opening).toContain("implementer-reported, not re-reviewed");
        expect(opening).toContain(
          "- disputed blocking finding: [blocker] B (src/a.ts): B is by design",
        );
        expect(opening).not.toContain("a reason the reviewer answers");
        expect(
          (yield* findingsIn(runDir(dir, "r-final-dispute"))).map((one) => one.title),
        ).toContain("B");
      }),
    ),
  120_000,
);

scenario(
  "a last fix that stands leaves only the findings still standing for the card to count",
  () =>
    runEffect(
      Effect.gen(function* () {
        const bin = yield* FakeBin.make(`${rig.root}/bin`);
        yield* noGitlabMrs(bin);
        yield* repository();
        const plan = yield* planOf([{ file: "01-only.md", title: "the only one", checks: "unit" }]);
        yield* approve("r-final-stands", ["unit"]);
        yield* collect(evidenceDir(dir, "r-final-stands"), {
          run: "r-final-stands",
          name: "unit",
          executable: "true",
          argv: [],
          cwd: rig.projectDir,
          by: "agent",
        }).pipe(Effect.orDie);
        const found = (title: string, severity = "blocker") => ({
          severity,
          title,
          file: "src/a.ts",
          detail: "it breaks",
        });
        const round = (title: string): Schema.Json[] => [
          { ...CLEAN_SYNTHESIS, verdict: "findings", findings: [found(title)] },
          { verdict: "clean", fixed: [{ title, file: "src/a.ts" }], checks: [{ name: "unit" }] },
        ];
        yield* rig.queueOutputs([
          BUILT,
          // A dispute from an early round that nobody answers is still the human's to settle.
          { ...CLEAN_SYNTHESIS, verdict: "findings", findings: [found("one"), found("X")] },
          {
            verdict: "clean",
            fixed: [{ title: "one", file: "src/a.ts" }],
            disputed: [{ ...found("X"), reason: "X is by design" }],
            checks: [{ name: "unit" }],
          },
          ...round("two"),
          ...round("three"),
          {
            ...CLEAN_SYNTHESIS,
            verdict: "findings",
            findings: [found("four"), found("a nit", "minor")],
          },
          {
            verdict: "clean",
            fixed: [{ title: "four", file: "src/a.ts" }],
            checks: [{ name: "unit" }],
          },
          OPENED,
        ]);
        const result = yield* ran({
          entry: shipped("implement"),
          runId: "r-final-stands",
          input: { plan, ...FINISH },
        });
        yield* bin.restore();

        expect(said(result)).toBe(OPENED.mr_url);
        expect((yield* findingsIn(runDir(dir, "r-final-stands"))).map((one) => one.title)).toEqual([
          "a nit",
          "X",
        ]);
        const fs = yield* FileSystem.FileSystem;
        expect(yield* fs.readFileString(`${runDir(dir, "r-final-stands")}/review.md`)).toContain(
          "four",
        );
      }).pipe(Effect.orDie),
    ),
  120_000,
);

scenario(
  "the merge request lists the commands the gate spawned, including one re-granted during the gate",
  () =>
    runEffect(
      Effect.gen(function* () {
        const bin = yield* FakeBin.make(`${rig.root}/bin`);
        yield* noGitlabMrs(bin);
        yield* repository();
        const plan = yield* planOf([{ file: "01-only.md", title: "the only one", checks: "unit" }]);
        yield* approve("r-late-grant", ["unit"]);
        const fs = yield* FileSystem.FileSystem;
        const approvedFile = `${evidenceDir(dir, "r-late-grant")}/approved.json`;
        const regrant = `${rig.root}/regranted.json`;
        yield* fs.writeFileString(
          regrant,
          asApproved([
            { name: "unit", executable: "true", argv: ["regranted"], cwd: rig.projectDir },
          ]),
        );
        // Its first run re-grants it, as a set_verification made meanwhile would, and fails.
        yield* fs.writeFileString(
          approvedFile,
          asApproved([
            {
              name: "unit",
              executable: "sh",
              argv: ["-c", `cp ${regrant} ${approvedFile}; exit 1`],
              cwd: rig.projectDir,
            },
          ]),
        );
        yield* rig.queueOutputs([BUILT, CLEAN_SYNTHESIS, OPENED]);
        yield* ran({
          entry: shipped("implement"),
          runId: "r-late-grant",
          input: { plan, ...FINISH },
        });
        yield* bin.restore();

        const opening = yield* asked("r-late-grant", "mr");
        expect(opening).toContain("/true regranted (in ");
        expect(opening).not.toContain("- unit: sh -c");
      }),
    ),
  120_000,
);

scenario(
  "a dispute from an early round still reaches the merge request when the last fix holds",
  () =>
    runEffect(
      Effect.gen(function* () {
        const bin = yield* FakeBin.make(`${rig.root}/bin`);
        yield* noGitlabMrs(bin);
        yield* repository();
        const plan = yield* planOf([{ file: "01-only.md", title: "the only one", checks: "unit" }]);
        yield* approve("r-early-dispute", ["unit"]);
        yield* collect(evidenceDir(dir, "r-early-dispute"), {
          run: "r-early-dispute",
          name: "unit",
          executable: "true",
          argv: [],
          cwd: rig.projectDir,
          by: "agent",
        }).pipe(Effect.orDie);
        const blocker = (title: string) => ({
          severity: "blocker",
          title,
          file: "src/a.ts",
          detail: "it breaks",
        });
        const review = (title: string) => ({
          ...CLEAN_SYNTHESIS,
          verdict: "findings",
          findings: [blocker(title)],
        });
        const fixes = (title: string) => ({
          verdict: "clean",
          fixed: [{ title, file: "src/a.ts" }],
          checks: [{ name: "unit" }],
        });
        yield* rig.queueOutputs([
          BUILT,
          { ...CLEAN_SYNTHESIS, verdict: "findings", findings: [blocker("X"), blocker("one")] },
          {
            verdict: "clean",
            fixed: [{ title: "one", file: "src/a.ts" }],
            disputed: [{ ...blocker("X"), reason: "X is by design" }],
            checks: [{ name: "unit" }],
          },
          review("two"),
          fixes("two"),
          review("three"),
          fixes("three"),
          review("four"),
          fixes("four"),
          OPENED,
        ]);
        const result = yield* ran({
          entry: shipped("implement"),
          runId: "r-early-dispute",
          input: { plan, ...FINISH },
        });
        yield* bin.restore();

        expect(said(result)).toBe(OPENED.mr_url);
        expect(yield* asked("r-early-dispute", "mr")).toContain(
          "- disputed blocking finding: [blocker] X (src/a.ts): X is by design",
        );
      }),
    ),
  120_000,
);

interface ShippedRun {
  readonly entry: string;
  readonly runId: string;
  readonly input: Readonly<Record<string, Schema.Json>>;
  readonly options?: Readonly<Record<string, string>>;
  readonly host?: HostOverride;
}

scenario(
  "replacing an approved command cannot reuse the old command's pass on resume",
  () =>
    runEffect(
      Effect.gen(function* () {
        const bin = yield* FakeBin.make(`${rig.root}/bin`);
        yield* noGitlabMrs(bin);
        // The HTTP login works, but the CLI needed to deliver is missing.
        yield* bin.add(
          "gh",
          `[ "$*" = "auth token --hostname github.com" ] && { echo gho-fake; exit 0; }; exit 127`,
        );
        yield* repository();
        yield* exec(["git", "remote", "set-url", "upstream", "git@github.com:team/project.git"], {
          cwd: rig.projectDir,
        });
        const plan = yield* planOf([{ file: "01-only.md", title: "the only one", checks: "unit" }]);
        const runId = "r-impl-replaced-check";
        yield* approve(runId, ["unit"]);
        yield* rig.queueOutputs([BUILT, CLEAN_SYNTHESIS, OPENED]);
        const entry = shipped("implement");
        yield* stalled({ entry, runId, input: { plan, ...FINISH } });
        expect(yield* parkedWhy(runId)).toContain("gh is not installed");
        const fs = yield* FileSystem.FileSystem;
        yield* fs.writeFileString(
          `${evidenceDir(dir, runId)}/approved.json`,
          asApproved([
            { name: "unit", executable: "sh", argv: ["-c", "exit 1"], cwd: rig.projectDir },
          ]),
        );
        yield* exec(
          ["git", "remote", "set-url", "upstream", "git@gitlab.example.com:team/project.git"],
          {
            cwd: rig.projectDir,
          },
        );
        const status = yield* session(
          Effect.gen(function* () {
            const made = yield* loaded(entry, runId);
            const engine = yield* WorkflowEngine.WorkflowEngine;
            const payload = { runId, input: { plan, ...FINISH } };
            return yield* Effect.gen(function* () {
              const id = yield* made.workflow.executionId(payload);
              yield* engine.resume(made.workflow, id);
              yield* made.workflow.execute(payload, { discard: true });
              return yield* until(
                () =>
                  Effect.all([
                    engine
                      .poll(made.workflow, id)
                      .pipe(Effect.map((got) => pollStatus(got, "").status)),
                    parkedWhy(runId),
                  ]),
                ([got, why]) =>
                  got === "complete" || (got === "suspended" && why.includes("unit failed")),
              );
            }).pipe(Effect.provide(made.layer));
          }),
        );
        expect(status[0]).toBe("suspended");
        expect(status[1]).toContain("unit failed");
        expect(yield* prompts()).toHaveLength(2);
        yield* bin.restore();
      }),
    ),
  120_000,
);

const DELIVERY = {
  gitlab: { origin: "git@gitlab.example.com:group/app.git", other: "gh" },
  github: { origin: "git@github.com:owner/repo.git", other: "glab" },
} as const;

/** A checkout on `name`'s forge, its fake on PATH, and the other forge's CLI there to be unasked. */
const deliveringOn = (name: MrForge, mrs: ForgeModel["mrs"] = []) =>
  Effect.gen(function* () {
    const bin = yield* FakeBin.make(`${rig.root}/bin`);
    const forge = yield* forgeOnPath(bin, name, {
      installed: true,
      loggedIn: [FORGE_HOST[name]],
      login: "tester",
      mrs,
    });
    const other = yield* forgeOnPath(bin, name === "gitlab" ? "github" : "gitlab", {
      installed: true,
      loggedIn: [],
      login: null,
      mrs: [],
    });
    yield* repository();
    yield* exec(["git", "remote", "set-url", "upstream", DELIVERY[name].origin], {
      cwd: rig.projectDir,
    });
    // An old GitLab remote beside origin does not make the checkout GitLab's.
    yield* exec(["git", "remote", "add", "gitlab", "git@gitlab.example.com:old/app.git"], {
      cwd: rig.projectDir,
    });
    return { bin, forge, other };
  });

for (const name of ["gitlab", "github"] as const) {
  const noun = name === "gitlab" ? "merge request" : "pull request";

  scenario(
    `implement opens a ${noun} on a ${name} checkout with that forge's own command`,
    () =>
      runEffect(
        Effect.gen(function* () {
          const { bin, other } = yield* deliveringOn(name);
          const plan = yield* planOf([
            { file: "01-only.md", title: "the only one", checks: "unit" },
          ]);
          const runId = `r-impl-${name}-open`;
          yield* approve(runId, ["unit"]);
          yield* rig.queueOutputs([BUILT, CLEAN_SYNTHESIS, OPENED]);
          const result = yield* ran({
            entry: shipped("implement"),
            runId,
            input: { plan, ...FINISH },
          });
          yield* bin.restore();
          expect(said(result)).toBe(OPENED.mr_url);
          const prompt = yield* asked(runId, "mr");
          expect(prompt).toContain(`${CLI[name]} ${name === "gitlab" ? "mr" : "pr"} create`);
          expect(prompt).toContain("--assignee 'tester'");
          expect(prompt).not.toMatch(new RegExp(`\\b${DELIVERY[name].other}\\b`));
          // Branch naming and readiness asked this forge alone.
          expect(yield* other.calls()).toEqual([]);
        }),
      ),
    120_000,
  );

  scenario(
    `implement updates a ${name} branch's open ${noun} rather than opening a second`,
    () =>
      runEffect(
        Effect.gen(function* () {
          // The fake checkout stands on master, which is the branch the step reads.
          const { bin } = yield* deliveringOn(name, [
            { project: PROJECT[name], iid: "31", state: "open", sourceBranch: "master" },
          ]);
          const plan = yield* planOf([
            { file: "01-only.md", title: "the only one", checks: "unit" },
          ]);
          const runId = `r-impl-${name}-existing`;
          yield* approve(runId, ["unit"]);
          yield* rig.queueOutputs([BUILT, CLEAN_SYNTHESIS, OPENED]);
          yield* ran({
            entry: shipped("implement"),
            runId,
            input: { plan, ...FINISH },
          });
          yield* bin.restore();
          const prompt = yield* asked(runId, "mr");
          expect(prompt).toContain(
            name === "gitlab"
              ? "glab api --hostname 'gitlab.example.com' --method POST 'projects/group%2Fapp/merge_requests/31/notes' -F body=@<file>"
              : "gh pr comment '31'",
          );
          expect(prompt).toContain(
            name === "gitlab"
              ? "https://gitlab.example.com/group/app/-/merge_requests/31"
              : "https://github.com/owner/repo/pull/31",
          );
          expect(prompt).toContain(`Do **not** open a second ${noun}`);
        }),
      ),
    120_000,
  );

  const autoMerging = (autoMerge: boolean): ForgeModel["mrs"] => [
    { project: PROJECT[name], iid: "31", state: "open", sourceBranch: "master", autoMerge },
  ];
  const notPushed = `not pushed: auto-merge is on for ${
    name === "gitlab"
      ? "https://gitlab.example.com/group/app/-/merge_requests/31"
      : "https://github.com/owner/repo/pull/31"
  }`;

  scenario(
    `implement starts no build while its ${name} ${noun} merges itself once green`,
    () =>
      runEffect(
        Effect.gen(function* () {
          const { bin, forge } = yield* deliveringOn(name, autoMerging(true));
          const plan = yield* planOf([
            { file: "01-only.md", title: "the only one", checks: "unit" },
          ]);
          const options = {
            entry: shipped("implement"),
            runId: `r-impl-${name}-auto-merge`,
            input: { plan, ...FINISH },
          };
          yield* approve(options.runId, ["unit"]);
          yield* rig.queueOutputs([BUILT, CLEAN_SYNTHESIS, OPENED]);
          expect(yield* stalled(options)).toBe("suspended");
          expect(yield* prompts()).toHaveLength(0);
          expect(yield* parkedWhy(options.runId)).toStartWith(notPushed);
          const fs = yield* FileSystem.FileSystem;
          expect(yield* fs.readFileString(`${runDir(dir, options.runId)}/log.txt`)).toContain(
            notPushed,
          );

          // The human turns auto-merge off and resumes: the build starts, and the Run delivers.
          yield* forge.set({
            ...(yield* forge.model()),
            mrs: autoMerging(false),
          });
          expect(said(yield* resumed(options))).toBe(OPENED.mr_url);
          expect(yield* prompts()).toHaveLength(3);
          expect(yield* parkedWhy(options.runId)).toBe("");
          yield* bin.restore();
        }),
      ),
    120_000,
  );

  scenario(
    `implement asks nothing once its ${name} ${noun} merges itself once green`,
    () =>
      runEffect(
        Effect.gen(function* () {
          const { bin, forge } = yield* deliveringOn(name, autoMerging(false));
          const plan = yield* planOf([
            { file: "01-only.md", title: "the only one", checks: "unit" },
          ]);
          const runId = `r-impl-${name}-merges-itself`;
          yield* approve(runId, ["unit"]);
          // Set to merge itself as it is opened.
          const on = forge.holding({ ...(yield* forge.model()), mrs: autoMerging(true) });
          yield* rig.queueOutputs([BUILT, CLEAN_SYNTHESIS, { writes: [on], output: OPENED }]);

          const result = yield* ran({ entry: shipped("implement"), runId, input: { plan } });
          yield* bin.restore();

          expect(said(result)).toBe(OPENED.mr_url);
          expect(yield* questions(runId)).toEqual([]);
          expect(started).toEqual([]);
        }),
      ),
    120_000,
  );

  scenario(
    `implement starts no fix round once its ${name} ${noun} merges itself once green`,
    () =>
      runEffect(
        Effect.gen(function* () {
          const { bin, forge } = yield* deliveringOn(name, autoMerging(false));
          const plan = yield* planOf([
            { file: "01-only.md", title: "the only one", checks: "unit" },
          ]);
          const runId = `r-impl-${name}-fix-auto-merge`;
          yield* approve(runId, ["unit"]);
          const finding = {
            severity: "blocker",
            title: "the guard is on the wrong side",
            file: "src/a.ts",
          };
          // Somebody turns auto-merge on while the build is under way.
          const on = forge.holding({ ...(yield* forge.model()), mrs: autoMerging(true) });
          yield* rig.queueOutputs([
            { writes: [on], output: BUILT },
            { ...CLEAN_SYNTHESIS, verdict: "findings", findings: [finding] },
          ]);
          expect(
            yield* stalled({ entry: shipped("implement"), runId, input: { plan, ...FINISH } }),
          ).toBe("suspended");
          yield* bin.restore();
          // The build and the review, and no fix.
          expect(yield* prompts()).toHaveLength(2);
          expect(yield* parkedWhy(runId)).toStartWith(notPushed);
        }),
      ),
    120_000,
  );
}

/** The human answers, and the Run goes on until it parks itself. */
const answeredUntilParked = (options: {
  readonly entry: string;
  readonly runId: string;
  readonly input: Readonly<Record<string, Schema.Json>>;
  readonly decision: string;
  readonly value: string;
}) =>
  session(
    Effect.gen(function* () {
      const made = yield* loaded(options.entry, options.runId);
      const payload = { runId: options.runId, input: options.input };
      return yield* Effect.gen(function* () {
        yield* answerDecision(made, {
          name: options.decision,
          executionId: yield* made.workflow.executionId(payload),
          value: options.value,
        }).pipe(Effect.orDie);
        yield* made.workflow.execute(payload, { discard: true });
        return yield* parkedWhy(options.runId).pipe(
          Effect.filterOrFail((why) => why !== ""),
          Effect.retry({ schedule: Schedule.spaced("20 millis") }),
        );
      }).pipe(Effect.provide(made.layer));
    }),
  );

for (const name of ["gitlab", "github"] as const) {
  const noun = name === "gitlab" ? "merge request" : "pull request";
  scenario(
    `review's fix starts no round while the reviewed ${name} ${noun} merges itself once green`,
    () =>
      runEffect(
        Effect.gen(function* () {
          const { bin } = yield* deliveringOn(name, [
            {
              project: PROJECT[name],
              iid: "31",
              state: "open",
              sourceBranch: "feature",
              autoMerge: true,
            },
          ]);
          yield* exec(["git", "worktree", "add", "-q", "-b", "feature", `${rig.root}/reviewed`], {
            cwd: rig.projectDir,
          });
          const fixed = { verdict: "clean", findings: [], fixed: [], disputed: [], checks: [] };
          yield* rig.queueOutputs([SYNTHESIS, fixed]);
          const run = {
            entry: shipped("review"),
            runId: `r-review-${name}-auto-merge`,
            input: { target: "branch:main...feature" },
          };
          yield* parked({ ...run, decision: "post-1" });
          const why = yield* answeredUntilParked({
            ...run,
            decision: "post-1",
            value: "Fix findings",
          });
          yield* bin.restore();
          expect(why).toStartWith(
            `not pushed: auto-merge is on for ${
              name === "gitlab"
                ? "https://gitlab.example.com/group/app/-/merge_requests/31"
                : "https://github.com/owner/repo/pull/31"
            }`,
          );
          // The review, and no fix.
          expect(yield* prompts()).toHaveLength(1);
        }),
      ),
    120_000,
  );
}

scenario(
  "implement fails when the delivery agent has not pushed and supplied a merge request",
  () =>
    runEffect(
      Effect.gen(function* () {
        const bin = yield* FakeBin.make(`${rig.root}/bin`);
        yield* noGitlabMrs(bin);
        yield* repository();
        const plan = yield* planOf([{ file: "01-only.md", title: "the only one", checks: "unit" }]);
        const runId = "r-impl-delivery-failed";
        yield* approve(runId, ["unit"]);
        yield* rig.queueOutputs([
          BUILT,
          CLEAN_SYNTHESIS,
          {
            verdict: "findings",
            pushed: false,
            mr_url: null,
            findings: [{ severity: "major", title: "push denied" }],
          },
        ]);
        const result = yield* ran({
          entry: shipped("implement"),
          runId,
          input: { plan, ...FINISH },
        });
        yield* bin.restore();
        expect(reasonOf(result)).toContain("Merge request delivery did not finish");
        expect(reasonOf(result)).toContain("push denied");
        expect(yield* prompts()).toHaveLength(3);
      }),
    ),
  120_000,
);

scenario(
  "implement fails when a clean delivery result still reports findings",
  () =>
    runEffect(
      Effect.gen(function* () {
        const bin = yield* FakeBin.make(`${rig.root}/bin`);
        yield* noGitlabMrs(bin);
        yield* repository();
        const plan = yield* planOf([{ file: "01-only.md", title: "the only one", checks: "unit" }]);
        const runId = "r-impl-delivery-findings";
        yield* approve(runId, ["unit"]);
        yield* rig.queueOutputs([
          BUILT,
          CLEAN_SYNTHESIS,
          { ...OPENED, findings: [{ severity: "major", title: "delivery blocked" }] },
        ]);
        const result = yield* ran({
          entry: shipped("implement"),
          runId,
          input: { plan, ...FINISH },
        });
        yield* bin.restore();
        expect(reasonOf(result)).toContain("Merge request delivery did not finish");
        expect(reasonOf(result)).toContain("delivery blocked");
        expect(yield* prompts()).toHaveLength(3);
      }),
    ),
  120_000,
);

scenario(
  "implement completes with nothing to land when its ticket is met with no commits and nothing uncommitted",
  () =>
    runEffect(
      Effect.gen(function* () {
        const bin = yield* FakeBin.make(`${rig.root}/bin`);
        yield* noGitlabMrs(bin);
        yield* levelRepository();
        const plan = yield* planOf([{ file: "01-only.md", title: "the only one", checks: "unit" }]);
        const runId = "r-impl-nothing-to-land";
        yield* approve(runId, ["unit"]);
        yield* rig.queueOutputs([{ ...BUILT, commits: [] }, CLEAN_SYNTHESIS, OPENED]);
        const result = yield* ran({
          entry: shipped("implement"),
          runId,
          input: { plan, ...FINISH },
        });
        yield* bin.restore();
        expect(said(result)).toStartWith("nothing to land: no commits over ");
        expect(yield* runLog(runId)).toContain(said(result));
        // The build and its review, and no merge request.
        expect(yield* prompts()).toHaveLength(2);
        const fs = yield* FileSystem.FileSystem;
        const declared = yield* loadEntry(shipped("implement")).pipe(
          Effect.map((described) => declaredByModule(described.metadata)),
          Effect.orDie,
        );
        const facts: ActionFacts = {
          outcome: "unspecified",
          succeeded: true,
          branch: "the-only-one",
          mrUrl: null,
          nothingToLand: yield* fs.exists(nothingToLandFile(runDir(dir, runId))),
          planIssues: 0,
          disposed: false,
          openFindings: 0,
          diffTarget: null,
          claim: null,
        };
        expect(offersFrom(declared, facts)).toEqual([]);
      }),
    ),
  120_000,
);

scenario(
  "implement opens its merge request for uncommitted changes on a branch with no commits",
  () =>
    runEffect(
      Effect.gen(function* () {
        const bin = yield* FakeBin.make(`${rig.root}/bin`);
        yield* noGitlabMrs(bin);
        yield* levelRepository();
        const plan = yield* planOf([{ file: "01-only.md", title: "the only one", checks: "unit" }]);
        const runId = "r-impl-uncommitted";
        yield* approve(runId, ["unit"]);
        // Left by the review, after the last merge of the default branch would have refused it.
        yield* rig.queueOutputs([
          { ...BUILT, commits: [] },
          {
            writes: [{ path: `${rig.projectDir}/left.txt`, text: "uncommitted\n" }],
            output: CLEAN_SYNTHESIS,
          },
          OPENED,
        ]);
        const result = yield* ran({
          entry: shipped("implement"),
          runId,
          input: { plan, ...FINISH },
        });
        yield* bin.restore();
        expect(said(result)).toBe(OPENED.mr_url);
        expect(yield* prompts()).toHaveLength(3);
        expect(yield* runLog(runId)).not.toContain("nothing to land");
      }),
    ),
  120_000,
);

scenario(
  "unavailable merge request handling suspends and resumes without rebuilding",
  () =>
    runEffect(
      Effect.gen(function* () {
        const bin = yield* FakeBin.make(`${rig.root}/bin`);
        yield* noGitlabMrs(bin);
        // The HTTP login works, but the CLI needed to deliver is missing.
        yield* bin.add(
          "gh",
          `[ "$*" = "auth token --hostname github.com" ] && { echo gho-fake; exit 0; }; exit 127`,
        );
        yield* repository();
        yield* exec(["git", "remote", "set-url", "upstream", "git@github.com:team/project.git"], {
          cwd: rig.projectDir,
        });
        const plan = yield* planOf([{ file: "01-only.md", title: "the only one", checks: "unit" }]);
        yield* approve("r-impl-no-forge", ["unit"]);
        yield* rig.queueOutputs([BUILT, CLEAN_SYNTHESIS, OPENED]);
        const options = {
          entry: shipped("implement"),
          runId: "r-impl-no-forge",
          input: { plan, ...FINISH },
        };
        const status = yield* running(options, (reading) =>
          until(
            () => reading,
            (got) => got !== "pending",
          ),
        );
        expect(status).toBe("suspended");
        expect(yield* parkedWhy(options.runId)).toContain("gh is not installed");
        expect(yield* prompts()).toHaveLength(2);

        yield* exec(
          ["git", "remote", "set-url", "origin", "git@gitlab.example.com:team/project.git"],
          { cwd: rig.projectDir },
        );
        expect(said(yield* resumed(options))).toBe(OPENED.mr_url);
        expect(yield* prompts()).toHaveLength(3);
        expect(yield* parkedWhy(options.runId)).toBe("");
        yield* bin.restore();
      }),
    ),
  120_000,
);

/** A Run of a shipped module started, and `waiting` until it has stopped by itself. */
const running = <A, E>(
  options: ShippedRun,
  waiting: (status: Effect.Effect<string>) => Effect.Effect<A, E, FileSystem.FileSystem>,
) =>
  session(
    Effect.gen(function* () {
      const made = yield* loaded(options.entry, options.runId);
      const engine = yield* WorkflowEngine.WorkflowEngine;
      yield* admit({
        runId: options.runId,
        workflow: made.workflow.name,
        input: options.input,
        options: options.options,
      });
      const payload = { runId: options.runId, input: options.input };
      return yield* Effect.gen(function* () {
        yield* made.workflow.execute(payload, { discard: true });
        const id = yield* made.workflow.executionId(payload);
        return yield* waiting(
          engine.poll(made.workflow, id).pipe(Effect.map((got) => pollStatus(got, "").status)),
        );
      }).pipe(Effect.provide(made.layer));
    }),
    options.host,
  );

/** A Run of a shipped module that stops by itself, waited on until it has. */
const stalled = (options: ShippedRun) =>
  running(options, (status) =>
    until(
      () => status,
      (got) => got === "suspended",
    ),
  );

/**
 * A Run of a shipped module that parks inside an agent's wait, which the engine does not
 * report as suspended: waited on, with no deadline of its own, until it says why.
 */
const parkedOn = (options: ShippedRun) =>
  running(options, () =>
    parkedWhy(options.runId).pipe(
      Effect.filterOrFail((why) => why !== ""),
      Effect.retry({ schedule: Schedule.spaced("20 millis") }),
    ),
  );

/** A Run run until it awaits something that ends by itself, and what. */
const awaitingIn = (options: ShippedRun) =>
  running(options, () =>
    awaitingOn(options.runId).pipe(
      Effect.filterOrFail((on) => on !== ""),
      Effect.retry({ schedule: Schedule.spaced("20 millis") }),
    ),
  );

/** A stopped Run picked up again, as `collie run resume` does it, and run to its end. */
const resumed = (options: {
  readonly entry: string;
  readonly runId: string;
  readonly input: Readonly<Record<string, Schema.Json>>;
  readonly host?: HostOverride;
}) =>
  session(
    Effect.gen(function* () {
      const made = yield* loaded(options.entry, options.runId);
      const engine = yield* WorkflowEngine.WorkflowEngine;
      const payload = { runId: options.runId, input: options.input };
      return yield* Effect.gen(function* () {
        yield* engine.resume(made.workflow, yield* made.workflow.executionId(payload));
        return yield* made.workflow.execute(payload).pipe(Effect.result);
      }).pipe(Effect.provide(made.layer));
    }),
    options.host,
  );

const parkedWhy = (runId: string) =>
  FileSystem.FileSystem.pipe(
    Effect.flatMap((fs) => fs.readFileString(controlPath(dir, PARKED, runId))),
    Effect.orElseSucceed(() => ""),
  );

/** What a Run awaits that ends by itself, or "" while it awaits nothing. */
const awaitingOn = (runId: string) =>
  FileSystem.FileSystem.pipe(
    Effect.flatMap((fs) => fs.readFileString(controlPath(dir, AWAITING, runId))),
    Effect.flatMap(Schema.decodeUnknownEffect(AwaitingJson)),
    Effect.map((awaiting) => awaiting.on),
    Effect.orElseSucceed(() => ""),
  );

/** A Run resumed whose park was cleared, waited on until it parks again, and why. */
const resumedUntilParked = (options: ShippedRun) =>
  session(
    Effect.gen(function* () {
      const made = yield* loaded(options.entry, options.runId);
      const engine = yield* WorkflowEngine.WorkflowEngine;
      const payload = { runId: options.runId, input: options.input };
      return yield* Effect.gen(function* () {
        yield* engine.resume(made.workflow, yield* made.workflow.executionId(payload));
        yield* made.workflow.execute(payload, { discard: true });
        return yield* parkedWhy(options.runId).pipe(
          Effect.filterOrFail((why) => why !== ""),
          Effect.retry({ schedule: Schedule.spaced("20 millis") }),
        );
      }).pipe(Effect.provide(made.layer));
    }),
  );

/** What `collie run intent verification` leaves for a Run: its checks, as the host keeps them. */
const naming = (runId: string, names: ReadonlyArray<string>) => ({
  path: `${evidenceDir(dir, runId)}/approved.json`,
  text: asApproved(
    names.map((name) => ({ name, executable: "true", argv: [], cwd: rig.projectDir })),
  ),
});

scenario(
  "a Run with no checks builds without waiting, is asked to name them, and is held until one is",
  () =>
    runEffect(
      Effect.gen(function* () {
        const bin = yield* FakeBin.make(`${rig.root}/bin`);
        yield* noGitlabMrs(bin);
        yield* repository();
        const plan = yield* planOf([{ file: "01-only.md", title: "the only one", checks: "" }]);
        yield* approve("r-impl-none", []);
        yield* rig.queueOutputs([BUILT, CLEAN_SYNTHESIS, GATE_FIX, GATE_FIX, GATE_FIX, GATE_FIX]);
        const options = {
          entry: shipped("implement"),
          runId: "r-impl-none",
          input: { plan, ...FINISH },
          options: { outcome: "feature" },
        };

        expect(yield* stalled(options)).toBe("suspended");
        const building = yield* asked("r-impl-none", "build");
        expect(building).toContain("(no check is named for this Run yet)");
        expect(building).toContain("collie run intent verification r-impl-none --name <name>");
        for (const at of [1, 2, 3, 4])
          expect(yield* asked("r-impl-none", `gate-fix-${at}`)).toContain("no check is named");
        expect(yield* parkedWhy("r-impl-none")).toContain("no check is named");
        const fs = yield* FileSystem.FileSystem;
        expect(yield* fs.exists(`${dir}/agents/r-impl-none/mr.prompt.md`)).toBe(false);
        expect(
          yield* session(Store.pipe(Effect.flatMap((store) => store.asked("r-impl-none")))),
        ).toEqual([]);

        yield* approve("r-impl-none", ["unit"]);
        yield* rig.queueOutputs([
          BUILT,
          CLEAN_SYNTHESIS,
          GATE_FIX,
          GATE_FIX,
          GATE_FIX,
          GATE_FIX,
          OPENED,
        ]);
        expect(said(yield* resumed(options))).toBe(OPENED.mr_url);
        yield* bin.restore();
        expect(yield* parkedWhy("r-impl-none")).toBe("");
        const opening = yield* asked("r-impl-none", "mr");
        expect(opening).toMatch(/- unit: \S*true \(in /);
        expect(opening).toContain("- unit: pass (by collie)");
        expect((yield* prompts()).filter((one) => one.includes("build-step-1"))).toHaveLength(1);
      }),
    ),
  120_000,
);

scenario(
  "a check the builder names is run by Collie at the gate and listed in the merge request, with nothing asked",
  () =>
    runEffect(
      Effect.gen(function* () {
        const bin = yield* FakeBin.make(`${rig.root}/bin`);
        yield* noGitlabMrs(bin);
        yield* repository();
        const plan = yield* planOf([{ file: "01-only.md", title: "the only one", checks: "unit" }]);
        yield* approve("r-impl-named", []);
        yield* rig.queueOutputs([
          { writes: [naming("r-impl-named", ["unit"])], output: BUILT },
          CLEAN_SYNTHESIS,
          OPENED,
        ]);
        const result = yield* ran({
          entry: shipped("implement"),
          runId: "r-impl-named",
          input: { plan, ...FINISH },
          options: { outcome: "feature" },
        });
        yield* bin.restore();

        expect(said(result)).toBe(OPENED.mr_url);
        expect(yield* parkedWhy("r-impl-named")).toBe("");
        const opening = yield* asked("r-impl-named", "mr");
        // Listed with the command Collie spawned for it, and its run by Collie.
        expect(opening).toMatch(/- unit: \S*true \(in /);
        expect(opening).toContain("- unit: pass (by collie)");
        expect(
          yield* session(Store.pipe(Effect.flatMap((store) => store.asked("r-impl-named")))),
        ).toEqual([]);
      }),
    ),
  120_000,
);

scenario(
  "checks withdrawn to none while the Run works are held exactly as checks never named",
  () =>
    runEffect(
      Effect.gen(function* () {
        const bin = yield* FakeBin.make(`${rig.root}/bin`);
        yield* noGitlabMrs(bin);
        yield* repository();
        const plan = yield* planOf([{ file: "01-only.md", title: "the only one", checks: "" }]);
        yield* approve("r-impl-emptied", ["unit"]);
        yield* rig.queueOutputs([
          { writes: [naming("r-impl-emptied", [])], output: BUILT },
          CLEAN_SYNTHESIS,
          GATE_FIX,
          GATE_FIX,
          GATE_FIX,
          GATE_FIX,
        ]);

        const status = yield* stalled({
          entry: shipped("implement"),
          runId: "r-impl-emptied",
          input: { plan, ...FINISH },
        });
        yield* bin.restore();

        expect(status).toBe("suspended");
        expect(yield* asked("r-impl-emptied", "build")).toContain(
          `- unit: true (in ${rig.projectDir})`,
        );
        expect(yield* asked("r-impl-emptied", "gate-fix-1")).toContain("no check is named");
        expect(yield* parkedWhy("r-impl-emptied")).toContain("no check is named");
        const fs = yield* FileSystem.FileSystem;
        expect(yield* fs.exists(`${dir}/agents/r-impl-emptied/mr.prompt.md`)).toBe(false);
        expect(
          yield* session(Store.pipe(Effect.flatMap((store) => store.asked("r-impl-emptied")))),
        ).toEqual([]);
      }),
    ),
  120_000,
);

scenario(
  "a Run whose outcome needs no evidence is not stopped for having no checks",
  () =>
    runEffect(
      // Its agent never answers, so what it waits on is the clock.
      fastForward(
        Effect.gen(function* () {
          yield* noMergeRequests;
          yield* repository();
          yield* approve("r-impl-inv", []);
          yield* rig.queueOutputs([null]);

          // Its agent writes nothing, which parks it for that; never for having no checks.
          const why = yield* parkedOn({
            entry: shipped("implement"),
            runId: "r-impl-inv",
            input: { plan: "why is the board slow?", ...FINISH },
            options: { outcome: "investigation" },
          });
          expect(why).toContain("has written nothing to");
          expect(why).not.toContain("approved");
          expect((yield* rig.cmds()).filter((cmd) => cmd === "agent start")).toHaveLength(1);
        }),
      ),
    ),
  30_000,
);

/** What a shipped Run's build is asked, read once it is written; the Run goes no further. */
const buildAsked = (options: ShippedRun) =>
  running(options, () =>
    until(
      () =>
        FileSystem.FileSystem.pipe(
          Effect.flatMap((fs) =>
            fs.readFileString(`${dir}/agents/${options.runId}/build.prompt.md`),
          ),
          Effect.orElseSucceed(() => ""),
        ),
      (text) => text.includes("OUTPUT_PATH"),
    ),
  );

scenario(
  "an investigation from text is told its own source and outcome, and no other",
  () =>
    runEffect(
      Effect.gen(function* () {
        yield* noMergeRequests;
        yield* repository();
        yield* approve("r-impl-told", ["unit"]);

        const building = yield* buildAsked({
          entry: shipped("implement"),
          runId: "r-impl-told",
          input: { plan: "why is the board slow?", ...FINISH },
          options: { outcome: "investigation" },
        });
        expect(building).toContain(`${dir}/runs/r-impl-told/plan/INVESTIGATION.md`);
        expect(building).not.toContain("migrate-up");
        expect(building).not.toContain("get_issue");
      }),
    ),
  60_000,
);

scenario(
  "a plan directory with no outcome kind is told only its checks have to pass",
  () =>
    runEffect(
      Effect.gen(function* () {
        yield* noMergeRequests;
        yield* repository();
        const plan = yield* planOf([{ file: "01-only.md", title: "the only one", checks: "" }]);
        yield* approve("r-impl-plain", ["unit"]);

        const building = yield* buildAsked({
          entry: shipped("implement"),
          runId: "r-impl-plain",
          input: { plan, ...FINISH },
        });
        expect(building).toContain(`\`${plan}/SPEC.md\` is the spec`);
        expect(building).not.toContain("get_issue");
        expect(building).toContain("only the checks have to pass");
        for (const instruction of [
          "the agreed scope was met",
          "reproduce it first",
          "behaviour is identical",
          "INVESTIGATION.md",
          "Instructions nobody ran",
          "migrate-up",
        ])
          expect(building).not.toContain(instruction);
      }),
    ),
  60_000,
);

/**
 * A host with no Helle to ask. The claim is a service this machine has no credentials
 * for; what the workflow does with it — take it before anything shared, give it back once
 * the work is done — is what these tests are about.
 */
const claimed: string[] = [];
const helleAnswers = (claim: "held" | "none", production: "deployed" | "read"): HostOverride =>
  Layer.effect(Host)(
    Effect.gen(function* () {
      const host = yield* Host;
      const answered = Host.of({
        ...host,
        claim: (options) =>
          claim === "none"
            ? Effect.succeed({ unresolved: "no Helle project for app" })
            : Effect.as(
                options
                  .say("holding the claim")
                  .pipe(
                    Effect.tap(() => Effect.sync(() => claimed.push(`claim ${options.runId}`))),
                  ),
                { slugs: ["project"] },
              ),
        release: (runId) => Effect.sync(() => (claimed.push(`release ${runId}`), [])),
      });
      if (production === "read") return answered;
      return Host.of({
        ...answered,
        defaultHead: () => Effect.succeed("0".repeat(40)),
        awaitProduction: () => Effect.succeed(true),
      });
    }),
  );
const withoutHelle = helleAnswers("held", "deployed");
/** A claim held, and production read from the forge on PATH. */
const holdingClaim = helleAnswers("held", "read");

/** Everything a renovation needs from the machine: glab, a GitLab remote, a config. */
const renovatable = () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    yield* fs.writeFileString(
      `${rig.userDir}/config.json`,
      asJson({
        gitlab: { assignee: "whoever-is-configured" },
        linear: { team: "Platform" },
        renovate: { logs: "the logs are at logs.example.invalid" },
      }),
    );
    const bin = yield* FakeBin.make(`${rig.root}/bin`);
    yield* noGitlabMrs(bin);
    // A renovation works on the default branch itself.
    yield* levelRepository();
    return bin;
  });

const TRACKED = {
  verdict: "clean",
  findings: [],
  issue: "REN-1",
  issue_url: "https://linear.app/team/issue/REN-1",
  team: "Platform",
  repository: "project",
  created_issue: false,
};
const BUMPS = [{ iid: 12, title: "Update effect", bumps: "effect 3 -> 4", risk: "routine" }];
const MERGED = {
  verdict: "clean",
  findings: [],
  outcomes: [{ iid: 12, url: "https://gitlab.example.com/x!12", outcome: "merged" }],
};
const RELEASED = { verdict: "clean", findings: [], version: "1.2.0", tagged: true };
const RECORDED = { verdict: "clean", findings: [], checked_off: true, status: "renovated" };

const RENOVATING = {
  gitlab: {
    origin: "git@gitlab.example.com:group/app.git",
    url: "https://gitlab.example.com/group/app",
    noun: "merge request",
    preamble: "Repository checkout or GitLab URL",
    create: "glab mr create --assignee whoever-is-configured",
  },
  github: {
    origin: "git@github.com:owner/repo.git",
    url: "https://github.com/owner/repo",
    noun: "pull request",
    preamble: "Repository checkout or GitHub URL",
    create: "gh pr create --assignee tester",
  },
} as const;

for (const name of ["gitlab", "github"] as const) {
  scenario(
    `renovate on a ${name} checkout is given that forge's content, assigned as that forge assigns`,
    () =>
      runEffect(
        Effect.gen(function* () {
          const bin = yield* renovatable();
          yield* forgeOnPath(bin, name, {
            installed: true,
            loggedIn: [FORGE_HOST[name]],
            login: "tester",
            mrs: [],
          });
          yield* exec(["git", "remote", "set-url", "origin", RENOVATING[name].origin], {
            cwd: rig.projectDir,
          });
          const runId = `r-ren-${name}`;
          yield* rig.queueOutputs([
            TRACKED,
            { verdict: "clean", up_to_date: false, is_package: false, merge_requests: BUMPS },
            { verdict: "clean", branch: "deps/batch" },
            { verdict: "clean", verified: false },
          ]);
          const result = yield* ran({
            entry: shipped("renovate"),
            runId,
            input: {},
            host: withoutHelle,
          });
          yield* bin.restore();
          expect(reasonOf(result)).toContain("stage was not verified");
          const other = new RegExp(`\\b${name === "gitlab" ? "gh" : "glab"}\\b`);
          for (const step of ["track", "assess", "batch", "stage"]) {
            const prompt = yield* asked(runId, step);
            expect(prompt).toContain(RENOVATING[name].preamble);
            expect(prompt).not.toMatch(other);
          }
          expect(yield* asked(runId, "batch")).toContain(RENOVATING[name].create);
          expect(yield* clearance(runId, "stage")).toBe(
            `Cleared for this step: playing, retrying and watching the stage deploy, e2e-stage and smoke jobs of ${RENOVATING[name].url}'s pipelines; rolling stage back to the newest tag whose production deploy succeeded, never a production job.`,
          );
        }),
      ),
    120_000,
  );

  scenario(
    `renovate's merge and release on a ${name} checkout are cleared in that forge's words`,
    () =>
      runEffect(
        Effect.gen(function* () {
          const bin = yield* renovatable();
          yield* forgeOnPath(bin, name, {
            installed: true,
            loggedIn: [FORGE_HOST[name]],
            login: "tester",
            mrs: [],
          });
          yield* exec(["git", "remote", "set-url", "origin", RENOVATING[name].origin], {
            cwd: rig.projectDir,
          });
          const runId = `r-land-${name}`;
          yield* rig.queueOutputs([TRACKED, PACKAGE, MERGED, RELEASED, RECORDED]);
          yield* ran({ entry: shipped("renovate"), runId, input: {}, host: withoutHelle });
          yield* bin.restore();
          const { url, noun } = RENOVATING[name];
          expect(yield* clearance(runId, "merge")).toBe(
            `Cleared for this step: approving the reviewed head of, and merging, Renovate's own ${noun}s on ${url}; merging this Run's batch ${noun} there once a teammate has approved it; using the forge's own commands as this step's content names them.`,
          );
          expect(yield* clearance(runId, "release")).toBe(
            `Cleared for this step: pushing an annotated version tag of ${url}'s default branch to origin; creating its release where the repository is a package; watching the tag's pipeline, never playing a production deploy job.`,
          );
          expect(yield* clearance(runId, "record")).toBe("");
        }),
      ),
    120_000,
  );
}

scenario(
  "a fork's landing reads its forge, and gets the GitHub content on a GitHub checkout",
  () =>
    runEffect(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const fork = `${rig.root}/fork-on`;
        yield* fs.makeDirectory(fork, { recursive: true });
        for (const name of ["renovate.workflow.ts", "renovate.gitlab.md", "renovate.github.md"])
          yield* fs.copyFile(`${ROOT}workflows/${name}`, `${fork}/${name}`);
        yield* fs.copyFile(`${fixtures}/landing-on.workflow.ts`, `${fork}/landing-on.workflow.ts`);
        const bin = yield* renovatable();
        yield* forgeOnPath(bin, "github", {
          installed: true,
          loggedIn: ["github.com"],
          login: "tester",
          mrs: [],
        });
        yield* exec(["git", "remote", "set-url", "origin", RENOVATING.github.origin], {
          cwd: rig.projectDir,
        });
        yield* rig.queueOutputs([TRACKED, PACKAGE, MERGED, RELEASED, RECORDED]);
        yield* ran({
          entry: `${fork}/landing-on.workflow.ts`,
          runId: "r-fork-on",
          input: {},
          host: withoutHelle,
        });
        yield* bin.restore();
        const merging = yield* asked("r-fork-on", "merge");
        expect(merging).toContain("gh pr merge <n> --match-head-commit");
        expect(merging).toContain("Here, squash every merge.");
        expect(merging).not.toMatch(/\bglab\b/);
      }),
    ),
  120_000,
);

scenario(
  "renovate on a checkout on neither forge renovates nothing, and says why",
  () =>
    runEffect(
      Effect.gen(function* () {
        const bin = yield* renovatable();
        yield* exec(["git", "remote", "set-url", "origin", "git@bitbucket.org:team/project.git"], {
          cwd: rig.projectDir,
        });
        const result = yield* ran({
          entry: shipped("renovate"),
          runId: "r-ren-neither",
          input: {},
        });
        yield* bin.restore();
        expect(said(result)).toBe(
          "nothing to renovate here: bitbucket.org is neither GitHub nor GitLab",
        );
        expect(yield* prompts()).toHaveLength(0);
      }),
    ),
  120_000,
);

scenario(
  "a package never reaches batch, stage or approval: no agent, no Output, and a reason on the record",
  () =>
    runEffect(
      Effect.gen(function* () {
        const bin = yield* renovatable();
        yield* rig.queueOutputs([
          TRACKED,
          { verdict: "clean", up_to_date: false, is_package: true, merge_requests: BUMPS },
          MERGED,
          RELEASED,
          RECORDED,
        ]);

        const result = yield* ran({
          entry: shipped("renovate"),
          runId: "r-pkg",
          input: {},
          host: withoutHelle,
        });
        yield* bin.restore();

        expect(said(result)).toBe("REN-1: renovated 1.2.0; production carries it");
        const track = yield* asked("r-pkg", "track");
        expect(track).toMatch(/^Linear team \(not given means .*\): not given$/m);
        expect(track).toContain("Linear Renovate issue (not given means find it): not given");
        // Five pieces of work, not eight: the three an application needs were not asked
        // for, so nothing wrote `"skipped": "package"` to say it had nothing to do.
        expect(yield* prompts()).toHaveLength(5);
        const fs = yield* FileSystem.FileSystem;
        expect(yield* fs.exists(`${dir}/agents/r-pkg/batch.prompt.md`)).toBe(false);
        expect(yield* fs.readFileString(`${runDir(dir, "r-pkg")}/log.txt`)).toContain(
          "a package has no batch branch: skipped batch, stage, approval",
        );
      }),
    ),
  120_000,
);

scenario(
  "nothing to renovate: no claim is taken, nothing is merged, and the repository is checked off",
  () =>
    runEffect(
      Effect.gen(function* () {
        const bin = yield* renovatable();
        claimed.length = 0;
        yield* rig.queueOutputs([
          TRACKED,
          { verdict: "clean", up_to_date: true, is_package: false },
          { verdict: "clean", tagged: false, up_to_date: true },
          { ...RECORDED, status: "up to date" },
        ]);

        const result = yield* ran({
          entry: shipped("renovate"),
          runId: "r-empty",
          input: {},
          host: withoutHelle,
        });
        yield* bin.restore();

        expect(said(result)).toBe("REN-1: up to date");
        // A repository with nothing to land takes nobody's turn: the claim is the
        // expensive prerequisite, and eligibility was decided before it.
        expect(claimed).toEqual([]);
        expect(yield* prompts()).toHaveLength(4);
      }),
    ),
  120_000,
);

scenario(
  "an application batches under the claim, proves it on stage and waits for a teammate",
  () =>
    runEffect(
      Effect.gen(function* () {
        const bin = yield* renovatable();
        claimed.length = 0;
        yield* rig.queueOutputs([
          TRACKED,
          { verdict: "clean", up_to_date: false, is_package: false, merge_requests: BUMPS },
          { verdict: "clean", mr_url: "https://gitlab.example.com/x!99", branch: "deps/batch" },
          { verdict: "clean", verified: true, verified_by: "e2e-stage" },
          { verdict: "clean", approved_by: ["a-teammate"], head_sha: "abc" },
          MERGED,
          RELEASED,
          RECORDED,
        ]);

        const result = yield* ran({
          entry: shipped("renovate"),
          runId: "r-app",
          input: {},
          host: withoutHelle,
        });
        yield* bin.restore();

        expect(said(result)).toBe("REN-1: renovated 1.2.0; production carries it");
        expect(yield* prompts()).toHaveLength(8);
        // Taken before the first thing that touches anything shared, given back after the
        // last one — and not before, so nobody deploys on a half-finished renovation.
        expect(claimed).toEqual(["claim r-app", "release r-app"]);
        // Nothing personal and nothing company-specific in the content: who the batch is
        // assigned to and where the logs are are this installation's own configuration.
        const batching = yield* asked("r-app", "batch");
        expect(batching).toContain("glab mr create --assignee whoever-is-configured");
        expect(yield* asked("r-app", "stage")).toContain("logs.example.invalid");
        expect(yield* persona("r-app", "track")).toContain("You are renovating one repository");
      }),
    ),
  120_000,
);

scenario(
  "a stage that was not proved merges nothing, and keeps the claim for whoever recovers stage",
  () =>
    runEffect(
      Effect.gen(function* () {
        const bin = yield* renovatable();
        claimed.length = 0;
        yield* rig.queueOutputs([
          TRACKED,
          { verdict: "clean", up_to_date: false, is_package: false, merge_requests: BUMPS },
          { verdict: "clean", mr_url: "https://gitlab.example.com/x!99" },
          { verdict: "findings", verified: false, findings: [] },
        ]);

        const result = yield* ran({
          entry: shipped("renovate"),
          runId: "r-stage",
          input: {},
          host: withoutHelle,
        });
        yield* bin.restore();

        expect(reasonOf(result)).toContain("stage was not verified");
        expect(yield* prompts()).toHaveLength(4);
        // Nothing says stage is back on its stable release, so the claim stays with the Run.
        expect(claimed).toEqual(["claim r-stage"]);
      }),
    ),
  120_000,
);

scenario(
  "a batch nobody approved merges nothing, and gives the claim back",
  () =>
    runEffect(
      Effect.gen(function* () {
        const bin = yield* renovatable();
        claimed.length = 0;
        yield* rig.queueOutputs([
          TRACKED,
          { verdict: "clean", up_to_date: false, is_package: false, merge_requests: BUMPS },
          { verdict: "clean", mr_url: "https://gitlab.example.com/x!99" },
          { verdict: "clean", verified: true, verified_by: "e2e-stage" },
          { verdict: "clean", approved_by: [] },
        ]);

        const result = yield* ran({
          entry: shipped("renovate"),
          runId: "r-unapproved",
          input: {},
          host: withoutHelle,
        });
        yield* bin.restore();

        expect(said(result)).toBe("REN-1: the batch was not approved");
        expect(claimed).toEqual(["claim r-unapproved", "release r-unapproved"]);
      }),
    ),
  120_000,
);

const PACKAGE = { verdict: "clean", up_to_date: false, is_package: true, merge_requests: BUMPS };

scenario(
  "Flow: renovate merges its second MR as Slice 2 of 2 on the same agent",
  () =>
    runEffect(
      Effect.gen(function* () {
        const bin = yield* renovatable();
        const second = { ...MERGED, outcomes: [{ iid: 13, outcome: "merged" }] };
        const lane = yield* laneWhen({
          entry: shipped("renovate"),
          runId: "r-renovate-flow",
          input: {},
          host: withoutHelle,
          outputs: [
            TRACKED,
            { ...PACKAGE, merge_requests: [...BUMPS, { iid: 13, title: "Update Bun" }] },
            MERGED,
          ],
          ready: (one) =>
            one.nodes.some(
              (node) =>
                (node.id === "release" && node.state === "running") ||
                (node.id === "merge" && node.runs[1]?.state === "running"),
            ),
          working: { operation: "merge-2", output: second },
          rest: [RELEASED, RECORDED],
          continueWith: (one) =>
            nodeIn(one, "merge")?.runs[1]?.state === "running"
              ? { operation: "merge-2", output: second, rest: [RELEASED, RECORDED] }
              : { operation: "release", output: RELEASED, rest: [RECORDED] },
        });
        yield* bin.restore();
        const merging = nodeIn(lane, "merge");
        expect(merging?.said).toBe("Slice 2 of 2");
        expect(merging?.runs.map((one) => [one.place, one.state])).toEqual([
          ["12", "done"],
          ["13", "running"],
        ]);
        expect(yield* asked("r-renovate-flow", "merge-2")).toContain("request `13`");
        expect(
          new Set((yield* readLaunches(dir, "r-renovate-flow")).map((one) => one.agent)).size,
        ).toBe(1);
      }),
    ),
  120_000,
);

/** An application's Outputs up to the release, which each scenario below says itself. */
const APPLICATION: ReadonlyArray<Schema.Json> = [
  TRACKED,
  { verdict: "clean", up_to_date: false, is_package: false, merge_requests: BUMPS },
  { verdict: "clean", mr_url: "https://gitlab.example.com/x!99", branch: "deps/batch" },
  { verdict: "clean", verified: true, verified_by: "e2e-stage" },
  { verdict: "clean", approved_by: ["a-teammate"], head_sha: "abc" },
  MERGED,
];
const OLDER = "1".repeat(40);
const LATER = "2".repeat(40);

/** A renovatable checkout on `name`'s forge, whose environments are `environments`. */
const deploying = (name: MrForge, environments: ForgeModel["environments"]) =>
  Effect.gen(function* () {
    const bin = yield* renovatable();
    const model: ForgeModel = {
      installed: true,
      loggedIn: [FORGE_HOST[name]],
      login: "tester",
      mrs: [],
      environments,
    };
    const forge = yield* forgeOnPath(bin, name, model);
    // origin stays the bare repository, whose default branch the Run reads.
    yield* exec(["git", "remote", "set-url", "upstream", RENOVATING[name].origin], {
      cwd: rig.projectDir,
    });
    const head = (yield* exec(["git", "rev-parse", "HEAD"], { cwd: rig.projectDir })).stdout.trim();
    const deployed = (sha: string, more: Partial<ForgeModel> = {}) =>
      forge.set({
        ...model,
        environments: [{ name: "production", tier: "production", deployed: sha }],
        ...more,
      });
    return { bin, forge, head, deployed };
  });

for (const name of ["gitlab", "github"] as const) {
  const url = RENOVATING[name].url;

  scenario(
    `an application on ${name} names its production job and holds its claim, with no turn, until production carries the merge`,
    () =>
      runEffect(
        Effect.gen(function* () {
          const { bin, head, deployed } = yield* deploying(name, [
            { name: "production", tier: "production", deployed: OLDER },
          ]);
          claimed.length = 0;
          const runId = `r-prod-${name}`;
          yield* rig.queueOutputs([
            ...APPLICATION,
            { ...RELEASED, prod_jobs: [{ name: "deploy-prod", url: `${url}/jobs/9` }] },
            RECORDED,
          ]);
          const status = yield* running(
            { entry: shipped("renovate"), runId, input: {}, host: holdingClaim },
            (status) =>
              Effect.gen(function* () {
                expect(
                  yield* until(
                    () => parkedWhy(runId),
                    (why) => why !== "",
                  ),
                ).toBe(
                  `Waiting for production: play \`deploy-prod\` at ${url}/jobs/9. The claim on \`project\` is held until the forge shows production carries \`${head.slice(0, 8)}\`.`,
                );
                expect(yield* prompts()).toHaveLength(8);
                expect(claimed).toEqual([`claim ${runId}`]);
                yield* deployed(head);
                return yield* until(
                  () => status,
                  (got) => got === "complete",
                );
              }),
          );
          yield* bin.restore();
          expect(status).toBe("complete");
          expect(yield* prompts()).toHaveLength(8);
          expect(claimed).toEqual([`claim ${runId}`, `release ${runId}`]);
          expect(yield* parkedWhy(runId)).toBe("");
        }),
      ),
    120_000,
  );

  scenario(
    `a renovation on ${name} waits for production whatever its Output names, and only a deployment carrying the merge ends it`,
    () =>
      runEffect(
        Effect.gen(function* () {
          const { bin, forge, head, deployed } = yield* deploying(name, [
            { name: "production", tier: "production", deployed: OLDER },
          ]);
          claimed.length = 0;
          const entry = shipped("renovate");
          const waiting = `production to carry \`${head.slice(0, 8)}\` of ${url}, holding the claim on \`project\``;
          const polled = (more: number) =>
            Effect.gen(function* () {
              const before = forge.requests().length;
              yield* until(
                () => Effect.sync(forge.requests),
                (requests) => requests.length >= before + more,
              );
            });

          // No production job named: the forge still decides.
          yield* deployed(OLDER);
          yield* rig.queueOutputs([
            ...APPLICATION,
            RELEASED,
            RECORDED,
            ...APPLICATION,
            { ...RELEASED, prod_jobs: [] },
            RECORDED,
          ]);
          const omitted = yield* running(
            { entry, runId: `r-omit-${name}`, input: {}, host: holdingClaim },
            (status) =>
              Effect.gen(function* () {
                expect(
                  yield* until(
                    () => awaitingOn(`r-omit-${name}`),
                    (on) => on !== "",
                  ),
                ).toBe(waiting);
                for (const behind of [
                  deployed(OLDER),
                  deployed(OLDER, {
                    environments: [
                      { name: "production", tier: "production", deployed: OLDER, failed: head },
                    ],
                  }),
                  deployed(head, { deploysDown: true }),
                ]) {
                  yield* behind;
                  yield* polled(6);
                  expect(yield* status).not.toBe("complete");
                  expect(claimed).not.toContain(`release r-omit-${name}`);
                }
                yield* deployed(LATER, { ancestry: { [LATER]: [head] } });
                return yield* until(
                  () => status,
                  (got) => got === "complete",
                );
              }),
          );
          expect(omitted).toBe("complete");
          expect(claimed.at(-1)).toBe(`release r-omit-${name}`);

          // An empty list is no different.
          yield* deployed(OLDER);
          const empty = yield* running(
            { entry, runId: `r-empty-jobs-${name}`, input: {}, host: holdingClaim },
            (status) =>
              Effect.gen(function* () {
                expect(
                  yield* until(
                    () => awaitingOn(`r-empty-jobs-${name}`),
                    (on) => on !== "",
                  ),
                ).toBe(waiting);
                expect(claimed).not.toContain(`release r-empty-jobs-${name}`);
                yield* deployed(head);
                return yield* until(
                  () => status,
                  (got) => got === "complete",
                );
              }),
          );
          yield* bin.restore();
          expect(empty).toBe("complete");
          expect(claimed.at(-1)).toBe(`release r-empty-jobs-${name}`);
        }),
      ),
    120_000,
  );
}

scenario(
  "a host restarted while a renovation waits for production goes back into the wait, with no turn",
  () =>
    runEffect(
      Effect.gen(function* () {
        const { bin, head, deployed } = yield* deploying("gitlab", [
          { name: "production", tier: "production", deployed: OLDER },
        ]);
        claimed.length = 0;
        const runId = "r-prod-restart";
        const entry = shipped("renovate");
        yield* rig.queueOutputs([TRACKED, PACKAGE, MERGED, RELEASED, RECORDED]);
        expect(yield* awaitingIn({ entry, runId, input: {}, host: holdingClaim })).toContain(
          "production to carry",
        );
        expect(yield* prompts()).toHaveLength(5);

        yield* deployed(head);
        const result = yield* resumed({ entry, runId, input: {}, host: holdingClaim });
        yield* bin.restore();
        expect(said(result)).toBe("REN-1: renovated 1.2.0; production carries it");
        expect(yield* prompts()).toHaveLength(5);
        expect(claimed.at(-1)).toBe(`release ${runId}`);
      }),
    ),
  120_000,
);

scenario(
  "a hold ends the wait for production with the claim still held",
  () =>
    runEffect(
      Effect.gen(function* () {
        const { bin, forge } = yield* deploying("gitlab", [
          { name: "production", tier: "production", deployed: OLDER },
        ]);
        claimed.length = 0;
        const runId = "r-prod-held";
        yield* rig.queueOutputs([TRACKED, PACKAGE, MERGED, RELEASED, RECORDED]);
        productionPoll = "1 hour";
        const status = yield* running(
          { entry: shipped("renovate"), runId, input: {}, host: holdingClaim },
          (status) =>
            Effect.gen(function* () {
              yield* until(
                () => awaitingOn(runId),
                (on) => on !== "",
              );
              yield* until(
                () => Effect.sync(forge.requests),
                (requests) => requests.some((request) => request.url.includes("deployments")),
              );
              const fs = yield* FileSystem.FileSystem;
              yield* fs.writeFileString(controlPath(dir, HOLD, runId), "").pipe(Effect.orDie);
              return yield* until(
                () => status,
                (got) => got === "suspended",
              );
            }),
        ).pipe(Effect.ensuring(Effect.sync(() => (productionPoll = "20 millis"))));
        yield* bin.restore();
        expect(status).toBe("suspended");
        expect(claimed).toEqual([`claim ${runId}`]);
        expect(yield* parkedWhy(runId)).toBe("");
        expect(yield* awaitingOn(runId)).toBe("");
      }),
    ),
  120_000,
);

scenario(
  "a wait for production that outlasts its patience parks as Needs you, while production is still read",
  () =>
    runEffect(
      Effect.gen(function* () {
        const { bin, head, deployed } = yield* deploying("gitlab", [
          { name: "production", tier: "production", deployed: OLDER },
        ]);
        claimed.length = 0;
        const runId = "r-prod-overdue";
        yield* rig.queueOutputs([TRACKED, PACKAGE, MERGED, RELEASED, RECORDED]);
        const status = yield* running(
          { entry: shipped("renovate"), runId, input: {}, host: holdingClaim },
          (status) =>
            Effect.gen(function* () {
              const on = yield* until(
                () => awaitingOn(runId),
                (got) => got !== "",
              );
              const fs = yield* FileSystem.FileSystem;
              const threeHoursAgo = DateTime.subtract(yield* DateTime.now, { hours: 3 });
              yield* fs
                .writeFileString(
                  controlPath(dir, AWAITING, runId),
                  Schema.encodeSync(AwaitingJson)({
                    on,
                    who: null,
                    since: DateTime.formatIso(threeHoursAgo),
                  }),
                )
                .pipe(Effect.orDie);
              expect(
                yield* until(
                  () => parkedWhy(runId),
                  (why) => why !== "",
                ),
              ).toContain("for over 2 hours");
              yield* deployed(head);
              return yield* until(
                () => status,
                (got) => got === "complete",
              );
            }),
        );
        yield* bin.restore();
        expect(status).toBe("complete");
        expect(yield* parkedWhy(runId)).toBe("");
        expect(yield* awaitingOn(runId)).toBe("");
      }),
    ),
  120_000,
);

scenario(
  "a renovation holding no claim does not wait for production, and its result names the jobs left to play",
  () =>
    runEffect(
      Effect.gen(function* () {
        const bin = yield* renovatable();
        yield* rig.queueOutputs([
          ...APPLICATION,
          {
            ...RELEASED,
            prod_jobs: [
              { name: "deploy-prod", url: "https://gitlab.example.com/group/project/-/jobs/9" },
              { name: "deploy-prod-eu" },
            ],
          },
          RECORDED,
        ]);
        const result = yield* ran({
          entry: shipped("renovate"),
          runId: "r-unclaimed",
          input: {},
          host: helleAnswers("none", "read"),
        });
        yield* bin.restore();
        expect(said(result)).toBe(
          "REN-1: renovated 1.2.0; production jobs left to play: `deploy-prod` at https://gitlab.example.com/group/project/-/jobs/9, `deploy-prod-eu`",
        );
        expect(yield* parkedWhy("r-unclaimed")).toBe("");
      }),
    ),
  120_000,
);

scenario(
  "a fork changes what lands and keeps everything that decides whether it should",
  () =>
    runEffect(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const fork = `${rig.root}/fork`;
        yield* fs.makeDirectory(fork, { recursive: true });
        for (const name of ["renovate.workflow.ts", "renovate.gitlab.md", "renovate.github.md"]) {
          yield* fs.copyFile(`${ROOT}workflows/${name}`, `${fork}/${name}`);
        }
        yield* fs.copyFile(`${fixtures}/landing.workflow.ts`, `${fork}/landing.workflow.ts`);
        const bin = yield* renovatable();
        // The shipped workflow first, then the fork, out of one queue: both are packages
        // with the same batch, so the only thing that can differ is the workflow itself.
        yield* rig.queueOutputs([
          TRACKED,
          PACKAGE,
          MERGED,
          RELEASED,
          RECORDED,
          TRACKED,
          PACKAGE,
          MERGED,
          { verdict: "clean", version: "deploy-7", tagged: false },
          RECORDED,
        ]);
        yield* ran({
          entry: shipped("renovate"),
          runId: "r-shipped",
          input: {},
          host: withoutHelle,
        });

        const result = yield* ran({
          entry: `${fork}/landing.workflow.ts`,
          runId: "r-fork",
          input: {},
          host: withoutHelle,
        });
        yield* bin.restore();

        expect(said(result)).toBe("REN-1: renovated deploy-7; production carries it");
        // Under an unrelated name, from another directory: everything up to the landing is
        // word for word what the shipped workflow asked, and only the Run it is about
        // differs. A fork that had copied the orchestration would drift from this.
        for (const step of ["track", "assess"]) {
          expect(byRun(yield* asked("r-fork", step))).toBe(byRun(yield* asked("r-shipped", step)));
        }
        // And the landing is the fork's own: the shipped rules for what may be merged,
        // with its own way of merging, and a deploy where the baseline tags.
        const merging = yield* asked("r-fork", "merge");
        expect(merging).toContain("Every relevant merge request ends with exactly one outcome");
        expect(merging).toContain("merge fast-forward only");
        expect(yield* asked("r-fork", "release")).toContain("Nothing is tagged here");
        expect(yield* asked("r-fork", "release")).not.toContain("Tag annotated");
      }),
    ),
  120_000,
);

/** A prompt with the Run it is about taken out, so two Runs' prompts can be compared. */
const byRun = (prompt: string) => prompt.replaceAll(/r-(fork|shipped)/g, "<run>");

/** Each forge's merge request a Release Run is started on, and its repository. */
const RELEASING = {
  gitlab: {
    remote: "git@gitlab.example.com:group/app.git",
    url: "https://gitlab.example.com/group/app",
    mr: `https://${PROJECT.gitlab}/-/merge_requests/30`,
    target: `mr:${PROJECT.gitlab}!30`,
  },
  github: {
    remote: "git@github.com:owner/repo.git",
    url: "https://github.com/owner/repo",
    mr: `https://${PROJECT.github}/pull/30`,
    target: `mr:${PROJECT.github}#30`,
  },
} as const;

const APP_ASSESSED = {
  verdict: "clean",
  is_package: false,
  kind_evidence: "a stage and a production environment",
  stage_jobs: { merge_request: [], tag: ["deploy-stage"] },
};

const PACKAGED = {
  verdict: "clean",
  is_package: true,
  kind_evidence: "a publish job on tags, and no deploy",
};
const TAGGED = { verdict: "clean", tag: "v1.2.0", version: "1.2.0" };

/** The merge request as a forge reads it approved by alice, green and mergeable at `head`. */
const readyMr = (name: MrForge, head: string, merged: string, over: Partial<FakeMr> = {}) =>
  ({
    project: PROJECT[name],
    iid: "30",
    state: "open",
    head,
    mergedSha: merged,
    sourceBranch: "feature",
    targetBranch: "main",
    checks: [{ name: "build", state: "passed" }],
    ...(name === "gitlab"
      ? { approvers: ["alice"], required: 1 }
      : {
          reviews: [{ id: 1, author: "alice", state: "APPROVED", at: "2026-10-20T10:00:00Z" }],
        }),
    ...over,
  }) satisfies FakeMr;

/** The merge request's pipeline still running at its head, as GitLab says "ci still running". */
const STILL_RUNNING = {
  checks: [{ name: "build", state: "running" }],
  mergeable: "running",
} satisfies Partial<FakeMr>;
const PIPELINE_PASSED = {
  checks: [{ name: "build", state: "passed" }],
  mergeable: "yes",
} satisfies Partial<FakeMr>;

const revParse = (ref: string, cwd = rig.projectDir) =>
  exec(["git", "rev-parse", ref], { cwd }).pipe(Effect.map((ran) => ran.stdout.trim()));

/** A commit on `parent`'s tree, made without a checkout and pushed to origin's `feature`. */
const pushedBySomebody = (parent: string, force = false) =>
  Effect.gen(function* () {
    const sha = (yield* exec(
      ["git", "commit-tree", `${parent}^{tree}`, "-p", parent, "-m", "pushed by somebody"],
      { cwd: rig.projectDir },
    )).stdout.trim();
    yield* exec(
      ["git", "push", "-q", ...(force ? ["-f"] : []), "origin", `${sha}:refs/heads/feature`],
      { cwd: rig.projectDir },
    );
    return sha;
  });

/** What the forge says the tag's pipeline ran for: the tag, on the merged commit it tags. */
const tagRun = (merged: string) => ({ ref: "v1.2.0", sha: merged });

const tagOnOrigin = (sha: string) =>
  Effect.gen(function* () {
    yield* exec(["git", "tag", "-a", "v1.2.0", "-m", "1.2.0", sha], { cwd: rig.projectDir });
    yield* exec(["git", "push", "-q", "origin", "v1.2.0"], { cwd: rig.projectDir });
  });

/**
 * A merge request from `feature`, whose checkout git already has, ready on `name`'s forge.
 * What its merge makes is already on origin's default branch, and tagged unless `tagged` is
 * false: the agent that would push the tag is a stand-in.
 */
const releasable = (name: MrForge, over: Partial<FakeMr> = {}, tagged = true) =>
  Effect.gen(function* () {
    const reviewed = yield* reviewedBranch();
    yield* exec(["git", "commit", "-qm", "the change", "--allow-empty"], { cwd: reviewed });
    yield* exec(["git", "push", "-q", "origin", "feature"], { cwd: reviewed });
    const head = yield* revParse("HEAD", reviewed);
    const base = yield* revParse("HEAD");
    const merged = (yield* exec(
      ["git", "commit-tree", `${head}^{tree}`, "-p", base, "-p", head, "-m", "Merge feature"],
      { cwd: rig.projectDir },
    )).stdout.trim();
    yield* exec(["git", "push", "-q", "origin", `${merged}:refs/heads/main`], {
      cwd: rig.projectDir,
    });
    if (tagged) yield* tagOnOrigin(merged);
    yield* exec(["git", "remote", "set-url", "upstream", RELEASING[name].remote], {
      cwd: rig.projectDir,
    });
    const bin = yield* FakeBin.make(`${rig.root}/bin`);
    const model: ForgeModel = {
      installed: true,
      loggedIn: [FORGE_HOST[name]],
      login: "tester",
      mrs: [readyMr(name, head, merged, over)],
      reviewsRequired: { classic: name === "github" ? 1 : 0 },
    };
    const forge = yield* forgeOnPath(bin, name, model);
    /** The merge request changed on the forge, as a reviewer or a push changes it. */
    const changed = (over: Partial<FakeMr>) =>
      Effect.gen(function* () {
        const now = yield* forge.model();
        yield* forge.set({ ...now, mrs: now.mrs.map((one) => ({ ...one, ...over })) });
      });
    return { bin, forge, head, base, merged, reviewed, changed };
  });

/** How each Run a takeover may weigh ended, as this test says; null still runs. */
type Ends = Readonly<Record<string, { succeeded: boolean; failure: string } | null>>;

/** What Helle answers a release's claim, with the lines it says and what it waits on first. */
interface HelleSays {
  readonly said?: ReadonlyArray<string>;
  readonly waits?: Effect.Effect<void>;
  readonly held: Claimed;
}
/** What each release's claim was asked to cover, in order. */
const claimedFor: Array<{ applications: ReadonlyArray<string>; jobs: ReadonlyArray<string> }> = [];
/** What Helle refuses to take back, a release at a time; it takes everything after. */
const refusedBack: Array<ReadonlyArray<string>> = [];

/**
 * Helle answered here, and the Runs' ends a landing takeover weighs given: what decides is
 * `takeOver`'s, from the landing records on disk and the forge. `whileClaiming` is what
 * happens elsewhere while the claim is taken, and the host stops for good once it has
 * posted `stallAfterReplies` replies. `helle` answers each claim, where the test says.
 */
const releaseHost = (
  ends: Ends = {},
  whileClaiming: Effect.Effect<void, unknown, FileSystem.FileSystem> = Effect.void,
  stallAfterReplies = Infinity,
  helle?: () => HelleSays,
) =>
  Layer.effect(Host)(
    Effect.gen(function* () {
      const host = yield* Host;
      const services = yield* Effect.context<BunServices.BunServices | ForgeHttp>();
      let replies = 0;
      return Host.of({
        ...host,
        // A host that stops after posting a reply, before its Activity is journaled.
        reply: (asked) =>
          host
            .reply(asked)
            .pipe(Effect.tap(() => (++replies >= stallAfterReplies ? Effect.never : Effect.void))),
        holders: () => Effect.succeed({ _tag: "Read", projects: [], applications: [], jobs: [] }),
        // As the host's own claim, one a replay takes again is the one the Run already holds.
        claim: (options) =>
          helle !== undefined
            ? Effect.gen(function* () {
                claimedFor.push(options.deploys ?? { applications: [], jobs: [] });
                const says = helle();
                for (const line of says.said ?? []) yield* options.say(line);
                yield* says.waits ?? Effect.void;
                if ("slugs" in says.held && says.held.slugs.length > 0)
                  claimed.push(`claim ${options.runId}`);
                return says.held;
              })
            : claimed.lastIndexOf(`claim ${options.runId}`) >
                claimed.lastIndexOf(`release ${options.runId}`)
              ? Effect.succeed({ slugs: ["project"] })
              : options.say("holding the claim").pipe(
                  Effect.tap(() => Effect.sync(() => claimed.push(`claim ${options.runId}`))),
                  Effect.tap(() =>
                    whileClaiming.pipe(Effect.orDie, Effect.provideContext(services)),
                  ),
                  Effect.as({ slugs: ["project"] }),
                ),
        release: (runId) =>
          Effect.sync(() => {
            claimed.push(`release ${runId}`);
            return refusedBack.shift() ?? [];
          }),
        takeOverLanding: (asked) =>
          Effect.gen(function* () {
            const fs = yield* FileSystem.FileSystem;
            const runs = yield* Effect.forEach(Object.entries(ends), ([runId, ended]) =>
              Effect.map(readLanding(runDir(dir, runId)), (landing) => ({
                runId,
                landing,
                ended,
              })),
            );
            const mr = yield* fs.readFileString(`${runDir(dir, asked.runId)}/merge-request`);
            return yield* takeOver({
              runDir: runDir(dir, asked.runId),
              mr: mr.trim(),
              runs,
              cwd: asked.cwd,
              run: shell,
            });
          }).pipe(Effect.orDie, Effect.provideContext(services)),
      });
    }),
  );

/**
 * A Run of a shipped module, driven from outside while it runs: its status, what it asks,
 * and an answer given as a door gives one. Answers with what `drive` does. A `restarted` Run
 * was admitted by an earlier host, which this one takes over from.
 */
const driven = <A, E>(
  options: ShippedRun & { readonly restarted?: boolean },
  drive: (run: {
    readonly status: Effect.Effect<typeof RunStatus.Type>;
    readonly asked: Effect.Effect<
      ReadonlyArray<{ decision: string; prompt: string; options: string; answer: string | null }>
    >;
    readonly answer: (decision: string, value: string) => Effect.Effect<void>;
    readonly resume: Effect.Effect<void>;
  }) => Effect.Effect<A, E, FileSystem.FileSystem>,
) =>
  session(
    Effect.gen(function* () {
      const made = yield* loaded(options.entry, options.runId);
      const engine = yield* WorkflowEngine.WorkflowEngine;
      const store = yield* Store;
      if (options.restarted !== true)
        yield* admit({ runId: options.runId, workflow: made.workflow.name, input: options.input });
      const payload = { runId: options.runId, input: options.input };
      return yield* Effect.gen(function* () {
        yield* made.workflow.execute(payload, { discard: true });
        const id = yield* made.workflow.executionId(payload);
        return yield* drive({
          status: engine.poll(made.workflow, id).pipe(Effect.map((got) => pollStatus(got, ""))),
          asked: store.asked(options.runId),
          resume: engine.resume(made.workflow, id),
          answer: (decision, value) =>
            answerDecision(made, { name: decision, executionId: id, value }).pipe(
              Effect.orDie,
              Effect.provideService(WorkflowEngine.WorkflowEngine, engine),
            ),
        });
      }).pipe(Effect.provide(made.layer));
    }),
    options.host,
  );

/** The go asked under `name`, once it is open. */
const goAsked = (
  asked: Effect.Effect<
    ReadonlyArray<{ decision: string; prompt: string; options: string; answer: string | null }>
  >,
  name: string,
) =>
  until(
    () => asked,
    (rows) => rows.some((row) => row.decision === name && row.answer === null),
  ).pipe(Effect.map((rows) => rows.find((row) => row.decision === name)!));

const PIPELINE_OF = {
  gitlab: "https://gitlab.example.com/group/app/-/pipelines/7",
  github: "https://github.com/owner/repo/actions/runs/7",
} as const;

const runLog = (runId: string) =>
  FileSystem.FileSystem.pipe(
    Effect.flatMap((fs) => fs.readFileString(`${runDir(dir, runId)}/log.txt`)),
    Effect.orElseSucceed(() => ""),
  );

/** One check of this Run's, `true` unless said, run in the Run's own checkout. */
const checkedBy = (runId: string, name: string, executable = "true", argv: string[] = []) =>
  FileSystem.FileSystem.pipe(
    Effect.flatMap((fs) =>
      fs
        .makeDirectory(evidenceDir(dir, runId), { recursive: true })
        .pipe(
          Effect.andThen(
            fs.writeFileString(
              `${evidenceDir(dir, runId)}/approved.json`,
              asApproved([{ name, executable, argv, cwd: "worktree" }]),
            ),
          ),
        ),
    ),
    Effect.orDie,
  );

/** What a Run came to, once it has. */
const ended = (status: Effect.Effect<typeof RunStatus.Type>) =>
  until(
    () => status,
    (got) => got.status === "complete" || got.status === "failed",
  );

const outcomeText = (status: typeof RunStatus.Type) =>
  status.status === "complete"
    ? Schema.decodeUnknownSync(Schema.String)(status.value)
    : status.status === "failed"
      ? status.reason
      : status.status;

/** A comment's web address, as each forge gives one that is not in a thread. */
const commentUrl = (name: MrForge, id: number) =>
  `${RELEASING[name].mr}#${name === "gitlab" ? "note_" : "issuecomment-"}${id}`;

/** What each forge reads as approved by nobody yet, and as approved by `who`. */
const UNAPPROVED = { gitlab: { approvers: [], required: 1 }, github: { reviews: [] } } as const;
const approvedBy = (name: MrForge, who: string): Partial<FakeMr> =>
  name === "gitlab"
    ? { approvers: [who], required: 1 }
    : { reviews: [{ id: 2, author: who, state: "APPROVED", at: "2026-10-20T12:10:00Z" }] };

/**
 * What an agent's push of a commit on `parent` leaves: the commit on origin's `feature`, and
 * the writes its step makes to put the Run's checkout and the forge's head on it.
 */
const agentPush = (
  forge: { readonly holding: (next: ForgeModel) => { path: string; text: string } },
  model: ForgeModel,
  parent: string,
) =>
  Effect.gen(function* () {
    const sha = yield* pushedBySomebody(parent);
    const moved = { ...model, mrs: model.mrs.map((one) => ({ ...one, head: sha })) };
    return {
      sha,
      writes: [
        { path: `${rig.projectDir}/.git/refs/heads/feature`, text: `${sha}\n` },
        forge.holding(moved),
      ],
    };
  });

/** Sharing for approval turned on as `collie settings set` writes it, in `channel` unless null. */
const sharingIn = (channel: string | null) =>
  FileSystem.FileSystem.pipe(
    Effect.flatMap((fs) =>
      fs.writeFileString(
        `${rig.userDir}/config.json`,
        asJson({
          release:
            channel === null
              ? { share_for_approval: true }
              : { share_for_approval: true, approval_channel: channel },
        }),
      ),
    ),
    Effect.andThen(writeSlackToken(hostOf().env, "xoxb-fixture")),
    Effect.orDie,
  );

const POSTED = { posted: true, link: "https://example.slack.com/archives/D123/p1503435956000247" };

/** The replies Collie posted on the merge request, in order. */
const repliesOf = (model: ForgeModel) => Object.values(model.replies ?? {}).flat();

const signed = (runId: string) => `\n\nPosted by Collie's Run ${runId} on ${hostname()}.`;

/** Collie's own Checks: `check`, left to CI's `test` job, counting any local run. */
const ownCheck = (runId: string) =>
  FileSystem.FileSystem.pipe(
    Effect.flatMap((fs) =>
      fs
        .makeDirectory(evidenceDir(dir, runId), { recursive: true })
        .pipe(
          Effect.andThen(
            fs.writeFileString(
              `${evidenceDir(dir, runId)}/approved.json`,
              asApproved([{ ...counting("check", `${rig.root}/check-runs`), ci: "test" }]),
            ),
          ),
        ),
    ),
    Effect.orDie,
  );

scenario(
  "a Release whose check is left to CI's test job is asked its go once the job passed at the head, never running the check",
  () =>
    runEffect(
      Effect.gen(function* () {
        const { bin, head } = yield* releasable("github", {
          jobs: [{ name: "test", state: "passed" }],
        });
        const runId = "r-release-own-check";
        yield* ownCheck(runId);
        yield* rig.queueOutputs([PACKAGED]);
        yield* driven(
          {
            entry: shipped("release"),
            runId,
            input: { mr: RELEASING.github.target },
            host: releaseHost(),
          },
          (run) =>
            Effect.gen(function* () {
              yield* goAsked(run.asked, "go-1");
              yield* run.answer("go-1", "Finish");
              return yield* ended(run.status);
            }),
        );
        yield* bin.restore();
        expect(yield* runsOf(`${rig.root}/check-runs`)).toBe(0);
        const [proof, ...more] = yield* ciRecords(runId);
        expect(more).toEqual([]);
        expect(proof).toMatchObject({
          name: "check",
          result: "pass",
          end: { head_sha: head },
          job: { name: "test" },
        });
      }),
    ),
  120_000,
);

scenario(
  "a Release whose check is left to CI's test job is not asked its go on a job that passed before its head moved, and is asked once it passes at the new head",
  () =>
    runEffect(
      Effect.gen(function* () {
        // The Release reads the job again on a fast clock; the test waits on the wall's.
        const wall = yield* Clock.Clock;
        const onWall = <A, E, R>(wait: Effect.Effect<A, E, R>) =>
          Effect.provideService(wait, Clock.Clock, wall);
        const { bin, forge, head, reviewed } = yield* releasable("gitlab", {
          jobs: [{ name: "test", state: "passed" }],
        });
        const before = yield* revParse(`${head}^`, reviewed);
        const passed = yield* forge.model();
        yield* forge.set({
          ...passed,
          ancestry: { [before]: [] },
          mrs: passed.mrs.map((one) => ({ ...one, pipelineAt: before })),
        });
        const runId = "r-release-own-check-moved";
        yield* ownCheck(runId);
        yield* rig.queueOutputs([PACKAGED]);
        const asked = yield* fastForward(
          driven(
            {
              entry: shipped("release"),
              runId,
              input: { mr: RELEASING.gitlab.target },
              host: releaseHost(),
            },
            (run) =>
              Effect.gen(function* () {
                yield* until(
                  () =>
                    FileSystem.FileSystem.pipe(
                      Effect.flatMap((fs) => fs.readFileString(`${runDir(dir, runId)}/log.txt`)),
                      Effect.orElseSucceed(() => ""),
                    ),
                  (log) => log.includes(`ci: waiting on job test for check on ${head}`),
                );
                expect((yield* run.asked).filter((row) => row.decision.startsWith("go-"))).toEqual(
                  [],
                );
                const now = yield* forge.model();
                yield* forge.set({
                  ...now,
                  mrs: now.mrs.map(({ pipelineAt: _, ...one }) => one),
                });
                yield* goAsked(run.asked, "go-1");
                yield* run.answer("go-1", "Finish");
                yield* ended(run.status);
                return yield* run.asked;
              }).pipe(onWall),
          ),
        );
        yield* bin.restore();
        expect(asked.filter((row) => row.decision.startsWith("go-"))).toHaveLength(1);
        expect(yield* runsOf(`${rig.root}/check-runs`)).toBe(0);
        const [proof, ...more] = yield* ciRecords(runId);
        expect(more).toEqual([]);
        expect(proof).toMatchObject({ name: "check", result: "pass", end: { head_sha: head } });
      }),
    ),
  120_000,
);

for (const [state, jobs] of [
  ["failing", [{ name: "test", state: "failed", retried: "failed" }]],
  ["not reported", [{ name: "static", state: "passed" }]],
] as const)
  scenario(
    `a Release whose check is left to CI's test job is not asked its go while the job is ${state}`,
    () =>
      runEffect(
        Effect.gen(function* () {
          const { bin, head } = yield* releasable("github", { jobs });
          const runId = `r-release-own-check-${state.replace(" ", "-")}`;
          yield* ownCheck(runId);
          yield* rig.queueOutputs([PACKAGED, { verdict: "clean", fixed: [] }]);
          const why = yield* driven(
            {
              entry: shipped("release"),
              runId,
              input: { mr: RELEASING.github.target },
              host: releaseHost(),
            },
            (run) =>
              Effect.gen(function* () {
                const why = yield* until(
                  () => parkedWhy(runId),
                  (why) => why !== "",
                );
                expect((yield* run.asked).filter((row) => row.decision.startsWith("go-"))).toEqual(
                  [],
                );
                return why;
              }),
          );
          yield* bin.restore();
          expect(why).toContain(
            `check is left to CI and unproved: job test on ${head.slice(0, 12)} is ${state === "failing" ? "failed" : "not in its pipeline"}`,
          );
          expect(yield* runsOf(`${rig.root}/check-runs`)).toBe(0);
          expect(yield* ciRecords(runId)).toEqual([]);
        }),
      ),
    120_000,
  );

const checkedOutThenAssessed = (runId: string) =>
  Effect.gen(function* () {
    const lines = yield* readStepLines(runDir(dir, runId));
    expect(
      lines.flatMap((line) => ("key" in line && line.key === "checkout" ? [line.kind] : [])),
    ).toEqual(["enter", "leave"]);
    expect(lines.flatMap((line) => (line.kind === "enter" ? [line.key] : [])).slice(0, 2)).toEqual([
      "checkout",
      "assess",
    ]);
  });

const refusingCheckout = (refused: string): HostOverride =>
  Layer.effect(Host)(
    Effect.gen(function* () {
      const host = yield* Host;
      return Host.of({ ...host, checkoutReviewed: () => Effect.succeed({ refused }) });
    }),
  );

scenario(
  "a refused checkout fails Stage and Release on their checkout step, before anything is assessed",
  () =>
    runEffect(
      Effect.gen(function* () {
        const { mr, target } = RELEASING.gitlab;
        const refused = "every slot of mk/run-x is held; free one of them and retry";
        for (const workflow of ["stage", "release"] as const) {
          const runId = `r-${workflow}-unchecked`;
          const result = yield* ran({
            entry: shipped(workflow),
            runId,
            input: { mr: target },
            host: refusingCheckout(refused),
          });
          expect(reasonOf(result)).toBe(`${mr} has no checkout to ${workflow} from: ${refused}`);
          const lines = yield* readStepLines(runDir(dir, runId));
          expect(lines.flatMap((line) => (line.kind === "enter" ? [line.key] : []))).toEqual([
            "checkout",
          ]);
          expect(lines.find((line) => line.kind === "fail")).toMatchObject({
            key: "checkout",
            why: expect.stringContaining(refused),
          });
          const lane = yield* laneNow(runId, "failed");
          expect(lane.nodes[0]).toMatchObject({
            id: "checkout",
            state: "failed",
            declared: true,
            offPath: false,
          });
        }
      }),
    ),
  120_000,
);

for (const name of ["gitlab", "github"] as const) {
  const { mr, url, target } = RELEASING[name];

  scenario(
    `release on ${name}: an approved, green, mergeable package is asked go 1 once, merged at that head, tagged and read back under the claim`,
    () =>
      runEffect(
        Effect.gen(function* () {
          const { bin, forge, head, merged } = yield* releasable(name);
          claimed.length = 0;
          const runId = `r-release-${name}`;
          yield* rig.queueOutputs([PACKAGED, TAGGED]);
          const status = yield* driven(
            { entry: shipped("release"), runId, input: { mr: target }, host: releaseHost() },
            (run) =>
              Effect.gen(function* () {
                const go = yield* goAsked(run.asked, "go-1");
                expect(go.prompt).toContain(mr);
                expect(go.prompt).toContain(head.slice(0, 8));
                expect(go.prompt).toContain("alice");
                expect(optionsOf([go], "go-1")).toEqual(["Release", "Finish"]);
                // Nothing shared is touched before the go.
                expect(claimed).toEqual([]);
                yield* run.answer("go-1", "Release");
                const end = yield* ended(run.status);
                expect(
                  (yield* run.asked).filter((row) => row.decision.startsWith("go-")),
                ).toHaveLength(1);
                return end;
              }),
          );
          const model = yield* forge.model();
          yield* bin.restore();
          expect(outcomeText(status)).toBe(`${mr} merged at ${merged}, released as v1.2.0`);
          expect(model.merges?.map((one) => one.sha)).toEqual([head]);
          expect(claimed).toEqual([`claim ${runId}`, `release ${runId}`]);
          expect(yield* clearance(runId, "tag")).toBe(
            `Cleared for this step: a release commit to ${url}'s default branch, where the repository makes one; pushing an annotated version tag of ${url} to origin; creating its release on ${url}, where the package publishes from its tags; watching the tag's pipeline on ${url}, never playing a production job.`,
          );
          const other = new RegExp(`\\b${name === "gitlab" ? "gh" : "glab"}\\b`);
          for (const step of ["assess", "tag"])
            expect(yield* asked(runId, step)).not.toMatch(other);
          expect(yield* asked(runId, "tag")).toContain(`merged commit is \`${merged}\``);
          yield* checkedOutThenAssessed(runId);
        }),
      ),
    120_000,
  );

  scenario(
    `release on ${name}: Finish leaves the merge request open, with no claim and no merge`,
    () =>
      runEffect(
        Effect.gen(function* () {
          const { bin, forge } = yield* releasable(name);
          claimed.length = 0;
          const runId = `r-finish-${name}`;
          yield* rig.queueOutputs([PACKAGED]);
          const status = yield* driven(
            { entry: shipped("release"), runId, input: { mr: target }, host: releaseHost() },
            (run) =>
              Effect.gen(function* () {
                yield* goAsked(run.asked, "go-1");
                yield* run.answer("go-1", "Finish");
                return yield* ended(run.status);
              }),
          );
          const model = yield* forge.model();
          yield* bin.restore();
          expect(outcomeText(status)).toBe(`${mr} was left open`);
          expect(model.merges ?? []).toEqual([]);
          expect(model.mrs[0]?.state).toBe("open");
          expect(claimed).toEqual([]);
        }),
      ),
    120_000,
  );

  scenario(
    `release on ${name}: a go answered after the head moved is asked again on the new head`,
    () =>
      runEffect(
        Effect.gen(function* () {
          const { bin, forge, head, changed } = yield* releasable(name);
          claimed.length = 0;
          const runId = `r-moved-${name}`;
          yield* rig.queueOutputs([PACKAGED]);
          let moved = "";
          const status = yield* driven(
            { entry: shipped("release"), runId, input: { mr: target }, host: releaseHost() },
            (run) =>
              Effect.gen(function* () {
                yield* goAsked(run.asked, "go-1");
                moved = yield* pushedBySomebody(head);
                yield* changed({ head: moved });
                yield* run.answer("go-1", "Release");
                const again = yield* goAsked(run.asked, "go-2");
                expect(again.prompt).toContain(moved.slice(0, 8));
                yield* run.answer("go-2", "Finish");
                return yield* ended(run.status);
              }),
          );
          const model = yield* forge.model();
          yield* bin.restore();
          expect(outcomeText(status)).toBe(`${mr} was left open`);
          expect(model.merges ?? []).toEqual([]);
          expect(claimed).toEqual([`claim ${runId}`, `release ${runId}`]);
          const log = yield* runLog(runId);
          expect(log).toContain(`go 1 no longer holds for ${head.slice(0, 8)}`);
          expect(log).toContain(`moved the checkout from ${head} to ${moved}`);
        }),
      ),
    120_000,
  );

  scenario(
    `release on ${name}: a head somebody else pushed during the wait is fast-forwarded and proved by the checks before go 1`,
    () =>
      runEffect(
        Effect.gen(function* () {
          const running = [{ name: "build", state: "running" }] as const;
          const { bin, head, reviewed, changed } = yield* releasable(name, { checks: running });
          const runId = `r-pushed-${name}`;
          yield* checkedBy(runId, "unit");
          yield* rig.queueOutputs([PACKAGED]);
          let moved = "";
          yield* driven(
            { entry: shipped("release"), runId, input: { mr: target }, host: releaseHost() },
            (run) =>
              Effect.gen(function* () {
                expect(
                  yield* until(
                    () => awaitingOn(runId),
                    (on) => on !== "",
                  ),
                ).toBe(`CI on ${mrLabel(mr)}`);
                expect(yield* parkedWhy(runId)).toBe("");
                moved = yield* pushedBySomebody(head);
                yield* changed({ head: moved, checks: [{ name: "build", state: "passed" }] });
                const go = yield* goAsked(run.asked, "go-1");
                expect(go.prompt).toContain(moved.slice(0, 8));
                yield* run.answer("go-1", "Finish");
                return yield* ended(run.status);
              }),
          );
          yield* bin.restore();
          expect(yield* revParse("HEAD", reviewed)).toBe(moved);
          const proved = (yield* readVerifications(evidenceDir(dir, runId))).map(
            (one) => one.end.head_sha,
          );
          expect(proved).toEqual([head, moved]);
          expect(yield* runLog(runId)).toContain(`moved the checkout from ${head} to ${moved}`);
        }),
      ),
    120_000,
  );

  scenario(
    `release on ${name}: a red pipeline parks the Run as Needs you, and once green it is asked go 1`,
    () =>
      runEffect(
        Effect.gen(function* () {
          const red = [{ name: "build", state: "failed" }] as const;
          const { bin, head, changed } = yield* releasable(name, { checks: red });
          const runId = `r-red-${name}`;
          yield* rig.queueOutputs([PACKAGED]);
          yield* driven(
            { entry: shipped("release"), runId, input: { mr: target }, host: releaseHost() },
            (run) =>
              Effect.gen(function* () {
                expect(
                  yield* until(
                    () => parkedWhy(runId),
                    (why) => why !== "",
                  ),
                ).toContain(
                  `${mrLabel(mr)} cannot be released: the pipeline at ${head.slice(0, 8)} failed (`,
                );
                yield* changed({ checks: [{ name: "build", state: "passed" }] });
                yield* goAsked(run.asked, "go-1");
                expect(yield* parkedWhy(runId)).toBe("");
                expect(yield* awaitingOn(runId)).toBe("");
                yield* run.answer("go-1", "Finish");
                return yield* ended(run.status);
              }),
          );
          yield* bin.restore();
        }),
      ),
    120_000,
  );

  scenario(
    `release on ${name}: a force-pushed head parks the Run, naming why, with nothing reset`,
    () =>
      runEffect(
        Effect.gen(function* () {
          const running = [{ name: "build", state: "running" }] as const;
          const { bin, head, reviewed, changed } = yield* releasable(name, { checks: running });
          const runId = `r-forced-${name}`;
          yield* rig.queueOutputs([PACKAGED]);
          const why = yield* driven(
            { entry: shipped("release"), runId, input: { mr: target }, host: releaseHost() },
            (run) =>
              Effect.gen(function* () {
                yield* until(
                  () => awaitingOn(runId),
                  (why) => why !== "",
                );
                const forced = yield* pushedBySomebody(`${head}~1`, true);
                yield* changed({ head: forced, checks: [{ name: "build", state: "passed" }] });
                yield* until(
                  () => run.status,
                  (got) => got.status === "suspended",
                );
                return yield* until(
                  () => parkedWhy(runId),
                  (why) => why.includes("fast-forward"),
                );
              }),
          );
          yield* bin.restore();
          expect(why).toContain(`does not fast-forward ${head.slice(0, 8)}`);
          expect(why).toContain(`Repair it, then resume ${runId}.`);
          expect(yield* revParse("HEAD", reviewed)).toBe(head);
        }),
      ),
    120_000,
  );

  scenario(
    `release on ${name}: an auto-merging, closed or hand-merged merge request fails at the start`,
    () =>
      runEffect(
        Effect.gen(function* () {
          const { bin, changed } = yield* releasable(name);
          claimed.length = 0;
          const started = (runId: string, over: Partial<FakeMr>) =>
            Effect.gen(function* () {
              yield* changed(over);
              return reasonOf(
                yield* ran({
                  entry: shipped("release"),
                  runId,
                  input: { mr: target },
                  host: releaseHost(),
                }),
              );
            });
          expect(yield* started(`r-auto-${name}`, { autoMerge: true })).toBe(
            `${mr} is set to merge itself once green, so this Run leaves it to do that`,
          );
          expect(yield* started(`r-closed-${name}`, { autoMerge: false, state: "closed" })).toBe(
            `${mr} is closed, so nothing was released`,
          );
          expect(
            yield* started(`r-hand-${name}`, {
              state: "merged",
              mergedBy: "alice",
              mergedAt: "2026-10-20T11:00:00Z",
            }),
          ).toBe(`${mr} was merged outside a Release Run: no Run on this host landed it`);
          yield* bin.restore();
          expect(yield* prompts()).toEqual([]);
          expect(claimed).toEqual([]);
        }),
      ),
    120_000,
  );

  scenario(
    `release on ${name}: a merge by hand between the go and Collie's merge fails as merged outside this Run, and gives the claim back`,
    () =>
      runEffect(
        Effect.gen(function* () {
          const { bin, forge, changed } = yield* releasable(name);
          claimed.length = 0;
          const runId = `r-raced-${name}`;
          yield* rig.queueOutputs([PACKAGED]);
          const byHand = changed({
            state: "merged",
            mergedBy: "alice",
            mergedAt: "2026-10-20T12:30:00Z",
          });
          const status = yield* driven(
            {
              entry: shipped("release"),
              runId,
              input: { mr: target },
              host: releaseHost({}, byHand),
            },
            (run) =>
              Effect.gen(function* () {
                yield* goAsked(run.asked, "go-1");
                yield* run.answer("go-1", "Release");
                return yield* ended(run.status);
              }),
          );
          const model = yield* forge.model();
          yield* bin.restore();
          expect(outcomeText(status)).toBe(
            `${mr} was merged outside this Run by alice, so nothing was tagged`,
          );
          expect(model.merges ?? []).toEqual([]);
          expect(claimed).toEqual([`claim ${runId}`, `release ${runId}`]);
        }),
      ),
    120_000,
  );

  scenario(
    `release on ${name}: an application whose assessment named no stage deploy fails before any wait or claim`,
    () =>
      runEffect(
        Effect.gen(function* () {
          const { bin } = yield* releasable(name);
          claimed.length = 0;
          const runId = `r-app-${name}`;
          yield* rig.queueOutputs([
            { ...APP_ASSESSED, stage_jobs: { merge_request: [], tag: [] } },
          ]);
          const result = yield* ran({
            entry: shipped("release"),
            runId,
            input: { mr: target },
            host: releaseHost(),
          });
          yield* bin.restore();
          expect(reasonOf(result)).toBe(
            `${mr} is an application with no stage deploy that Collie can prove, on its merge request's pipeline or its tags', so nothing was released: a stage and a production environment`,
          );
          expect(yield* prompts()).toHaveLength(1);
          expect(claimed).toEqual([]);
          expect(yield* parkedWhy(runId)).toBe("");
        }),
      ),
    120_000,
  );

  scenario(
    `release on ${name}: a tag missing on origin keeps the claim and offers Release again, which finishes the release without merging again`,
    () =>
      runEffect(
        Effect.gen(function* () {
          const { bin, forge, merged } = yield* releasable(name, {}, false);
          claimed.length = 0;
          const first = `r-untagged-${name}`;
          const again = `r-again-${name}`;
          yield* rig.queueOutputs([PACKAGED, TAGGED, PACKAGED, TAGGED]);
          const status = yield* driven(
            { entry: shipped("release"), runId: first, input: { mr: target }, host: releaseHost() },
            (run) =>
              Effect.gen(function* () {
                yield* goAsked(run.asked, "go-1");
                yield* run.answer("go-1", "Release");
                return yield* ended(run.status);
              }),
          );
          const failure = outcomeText(status);
          expect(failure).toBe(
            `${mr} merged at ${merged}, but v1.2.0 is not released: v1.2.0 is not on origin`,
          );
          expect(claimed).toEqual([`claim ${first}`]);

          const declared = yield* loadEntry(shipped("release")).pipe(
            Effect.map((described) => declaredByModule(described.metadata)),
            Effect.orDie,
          );
          const facts: ActionFacts = {
            outcome: "unspecified",
            succeeded: false,
            branch: null,
            mrUrl: mr,
            planIssues: 0,
            disposed: false,
            openFindings: 0,
            diffTarget: target,
            claim: "project",
          };
          const offered = offersFrom(declared, facts, { self: idOf("release") });
          expect(offered.map((offer) => [offer.id, offer.title, offer.workflow])).toEqual([
            ["release-again", "Release again", idOf("release")],
          ]);
          expect(inputsFor(offered[0]!, { runDir: "/r", facts, input: { mr: target } })).toEqual({
            mr: target,
          });

          yield* tagOnOrigin(merged);
          const result = yield* ran({
            entry: shipped("release"),
            runId: again,
            input: { mr: target },
            host: releaseHost({ [first]: { succeeded: false, failure } }),
          });
          const model = yield* forge.model();
          yield* bin.restore();
          expect(said(result)).toBe(`${mr} merged at ${merged}, released as v1.2.0`);
          expect(model.merges ?? []).toHaveLength(1);
          expect(claimed).toEqual([`claim ${first}`, `claim ${again}`, `release ${again}`]);
          const tagging = yield* asked(again, "tag");
          expect(tagging).toContain(`recovers the release of ${mr} that ${first} merged`);
          expect(tagging).toContain(failure);
          expect(yield* readLanding(runDir(dir, again))).toMatchObject({
            state: "landed",
            sha: merged,
            from: first,
          });
        }),
      ),
    120_000,
  );

  scenario(
    `release on ${name}: a merge request whose landing Run succeeded fails at the start, naming that Run`,
    () =>
      runEffect(
        Effect.gen(function* () {
          const { bin, head, merged } = yield* releasable(name, {
            state: "merged",
            mergedBy: "tester",
            mergedAt: "2026-10-20T11:00:00Z",
          });
          yield* writeLanding(runDir(dir, "r-done"), {
            state: "landed",
            mr,
            head,
            at: "2026-10-20T10:59:00Z",
            sha: merged,
          });
          const result = yield* ran({
            entry: shipped("release"),
            runId: `r-released-${name}`,
            input: { mr: target },
            host: releaseHost({ "r-done": { succeeded: true, failure: "" } }),
          });
          yield* bin.restore();
          expect(reasonOf(result)).toBe(`${mr} was already released by r-done`);
          expect(yield* prompts()).toEqual([]);
        }),
      ),
    120_000,
  );

  scenario(
    `release on ${name}: a tag pipeline still waiting on a job somebody must start by hand fails the read-back, naming the job`,
    () =>
      runEffect(
        Effect.gen(function* () {
          const { bin, forge, merged } = yield* releasable(name);
          const now = yield* forge.model();
          yield* forge.set({
            ...now,
            runs: {
              "7": {
                ...tagRun(merged),
                ...(name === "gitlab"
                  ? { status: "success" }
                  : { status: "completed", conclusion: "success" }),
                jobs: [
                  { name: "build", state: "passed" },
                  { name: "publish", state: "manual" },
                ],
              },
            },
          });
          claimed.length = 0;
          const runId = `r-manual-${name}`;
          const pipeline = PIPELINE_OF[name];
          yield* rig.queueOutputs([PACKAGED, { ...TAGGED, pipeline_url: pipeline }]);
          const status = yield* driven(
            { entry: shipped("release"), runId, input: { mr: target }, host: releaseHost() },
            (run) =>
              Effect.gen(function* () {
                yield* goAsked(run.asked, "go-1");
                yield* run.answer("go-1", "Release");
                return yield* ended(run.status);
              }),
          );
          yield* bin.restore();
          expect(outcomeText(status)).toContain(
            `v1.2.0's pipeline at ${pipeline} has not finished: \`publish\` waits for somebody to start it by hand`,
          );
          expect(claimed).toEqual([`claim ${runId}`]);
        }),
      ),
    120_000,
  );

  scenario(
    `release on ${name}: a Hold during the review wait suspends the Run`,
    () =>
      runEffect(
        Effect.gen(function* () {
          const running = [{ name: "build", state: "running" }] as const;
          const { bin } = yield* releasable(name, { checks: running });
          claimed.length = 0;
          const runId = `r-held-${name}`;
          yield* rig.queueOutputs([PACKAGED]);
          const status = yield* driven(
            { entry: shipped("release"), runId, input: { mr: target }, host: releaseHost() },
            (run) =>
              Effect.gen(function* () {
                yield* until(
                  () => awaitingOn(runId),
                  (why) => why !== "",
                );
                const fs = yield* FileSystem.FileSystem;
                yield* fs.writeFileString(controlPath(dir, HOLD, runId), "").pipe(Effect.orDie);
                return yield* until(
                  () => Effect.map(run.status, (got) => got.status),
                  (got) => got === "suspended",
                );
              }),
          );
          yield* bin.restore();
          expect(status).toBe("suspended");
          expect(yield* parkedWhy(runId)).toBe("");
          expect(claimed).toEqual([]);
        }),
      ),
    120_000,
  );

  scenario(
    `release on ${name}: a reviewer's comment is fixed, pushed, proved and replied to with its commit, a second is disputed with its reason, and the approval asks go 1`,
    () =>
      runEffect(
        Effect.gen(function* () {
          const { bin, forge, head, reviewed, changed } = yield* releasable(name, UNAPPROVED[name]);
          const runId = `r-answered-${name}`;
          yield* checkedBy(runId, "unit");
          yield* rig.queueOutputs([PACKAGED]);
          const unopened: ReadonlyArray<FakeComment> = [
            { id: 43, author: "renovate", kind: "bot", at: "2026-10-20T11:00:00Z", body: "bump" },
            { id: 45, author: "tester", at: "2026-10-20T11:00:00Z", body: "my own note" },
            ...(name === "gitlab"
              ? [
                  {
                    id: 44,
                    author: "bob",
                    kind: "system" as const,
                    at: "2026-10-20T11:00:00Z",
                    body: "added 1 commit",
                  },
                ]
              : []),
          ];
          const comments = [
            { id: 41, author: "bob", at: "2026-10-20T11:01:00Z", body: "please rename this" },
            { id: 42, author: "carol", at: "2026-10-20T11:02:00Z", body: "use a map here" },
          ];
          let fix = "";
          const status = yield* driven(
            { entry: shipped("release"), runId, input: { mr: target }, host: releaseHost() },
            (run) =>
              Effect.gen(function* () {
                yield* until(
                  () => awaitingOn(runId),
                  (on) => on.includes("approval"),
                );
                const now = yield* forge.model();
                const commented = {
                  ...now,
                  mrs: now.mrs.map((one) => ({ ...one, comments: [...unopened, ...comments] })),
                };
                const pushed = yield* agentPush(forge, commented, head);
                fix = pushed.sha;
                yield* rig.queueOutputs([
                  PACKAGED,
                  {
                    writes: pushed.writes,
                    output: {
                      verdict: "clean",
                      answers: [
                        { id: "41", answer: "fixed", commit: fix, note: "renamed it" },
                        { id: "42", answer: "disputed", note: "a map costs more here" },
                      ],
                    },
                  },
                ]);
                yield* forge.set(commented);
                yield* until(
                  () => forge.model(),
                  (model) => repliesOf(model).length === 2,
                );
                yield* until(
                  () => awaitingOn(runId),
                  (on) => on.includes("approval"),
                );
                yield* changed(approvedBy(name, "dave"));
                const go = yield* goAsked(run.asked, "go-1");
                expect(go.prompt).toContain("dave");
                expect(go.prompt).toContain(fix.slice(0, 8));
                yield* run.answer("go-1", "Finish");
                return yield* ended(run.status);
              }),
          );
          const model = yield* forge.model();
          yield* bin.restore();
          expect(outcomeText(status)).toBe(`${mr} was left open`);
          const fixed = `${commentUrl(name, 41)}\n\nFixed in \`${fix.slice(0, 8)}\`: renamed it${signed(runId)}`;
          const disputed = `${commentUrl(name, 42)}\n\nNot changed: a map costs more here${signed(runId)}`;
          expect(repliesOf(model).map((one) => one.body)).toEqual([fixed, disputed]);
          const recorded = yield* readReplies(runDir(dir, runId));
          expect(
            recorded.map(({ comment, kind, body, mr: on }) => ({ comment, kind, body, on })),
          ).toEqual([
            { comment: commentUrl(name, 41), kind: "fixed", body: fixed, on: mr },
            { comment: commentUrl(name, 42), kind: "disputed", body: disputed, on: mr },
          ]);
          expect(
            (yield* disputesIn([{ id: runId, dir: runDir(dir, runId) }])).map((one) => one.key),
          ).toEqual([`${runId}:disputed:${commentUrl(name, 42)}`]);
          const answering = yield* asked(runId, "answer-1");
          expect(answering).toContain(commentUrl(name, 41));
          expect(answering).toContain("please rename this");
          expect(answering).toContain("use a map here");
          for (const quiet of unopened) expect(answering).not.toContain(quiet.body);
          expect(yield* clearance(runId, "answer-1")).toBe(
            `Cleared for this step: committing to the merge request's source branch on ${url} and pushing it with a plain push, never a force push; never posting on ${url} or resolving a thread there: Collie replies.`,
          );
          expect(yield* revParse("HEAD", reviewed)).toBe(fix);
          const proved = (yield* readVerifications(evidenceDir(dir, runId))).map(
            (one) => one.end.head_sha,
          );
          expect(proved).toEqual([head, fix]);
          expect((yield* prompts()).filter((one) => one.includes("/answer-"))).toHaveLength(1);
        }),
      ),
    120_000,
  );

  scenario(
    `release on ${name}: the host's reply is signed with the Run and its Machine, and a second reply to the comment is already`,
    () =>
      runEffect(
        Effect.gen(function* () {
          const comment = { id: 46, author: "bob", at: "2026-10-20T11:00:00Z", body: "rename it" };
          const { bin, forge } = yield* releasable(name, { comments: [comment] });
          const runId = `r-signed-${name}`;
          const fs = yield* FileSystem.FileSystem;
          yield* fs.makeDirectory(runDir(dir, runId), { recursive: true });
          yield* fs.writeFileString(`${runDir(dir, runId)}/merge-request`, `${mr}\n`);
          const said = yield* session(
            Effect.gen(function* () {
              const host = yield* Host;
              const asked = {
                runId,
                cwd: rig.projectDir,
                comment: "46",
                body: `${commentUrl(name, 46)}\n\nNot changed: the name is the domain's`,
                kind: "disputed" as const,
              };
              return [yield* host.reply(asked), yield* host.reply(asked)];
            }),
          );
          const model = yield* forge.model();
          yield* bin.restore();
          expect(said).toEqual(["posted", "already"]);
          expect(repliesOf(model).map((one) => one.body)).toEqual([
            `${commentUrl(name, 46)}\n\nNot changed: the name is the domain's${signed(runId)}`,
          ]);
        }),
      ),
    120_000,
  );

  scenario(
    `release on ${name}: a reply the forge took before its record was written is recorded on the next try`,
    () =>
      runEffect(
        Effect.gen(function* () {
          const comment = { id: 47, author: "bob", at: "2026-10-20T11:00:00Z", body: "rename it" };
          const { bin, forge } = yield* releasable(name, { comments: [comment] });
          const runId = `r-lost-${name}`;
          const fs = yield* FileSystem.FileSystem;
          yield* fs.makeDirectory(runDir(dir, runId), { recursive: true });
          yield* fs.writeFileString(`${runDir(dir, runId)}/merge-request`, `${mr}\n`);
          const asked = {
            runId,
            cwd: rig.projectDir,
            comment: "47",
            body: `${commentUrl(name, 47)}\n\nNot changed: the name is the domain's`,
            kind: "disputed" as const,
          };
          const said = yield* session(
            Effect.gen(function* () {
              const host = yield* Host;
              const first = yield* host.reply(asked);
              yield* fs.remove(`${runDir(dir, runId)}/replies.jsonl`);
              return [first, yield* host.reply(asked), yield* host.reply(asked)];
            }),
          );
          const model = yield* forge.model();
          yield* bin.restore();
          expect(said).toEqual(["posted", "already", "already"]);
          const body = `${commentUrl(name, 47)}\n\nNot changed: the name is the domain's${signed(runId)}`;
          expect(repliesOf(model).map((one) => one.body)).toEqual([body]);
          expect(
            (yield* readReplies(runDir(dir, runId))).map(({ comment, kind, body, mr: on }) => ({
              comment,
              kind,
              body,
              on,
            })),
          ).toEqual([{ comment: commentUrl(name, 47), kind: "disputed", body, on: mr }]);
        }),
      ),
    120_000,
  );

  scenario(
    `release on ${name}: a lost reply in a thread is recorded as the one posted after its comment, not an earlier one`,
    () =>
      runEffect(
        Effect.gen(function* () {
          const thread = name === "gitlab" ? "d48" : "48";
          const where = { thread, file: "src/app.ts", line: 3 };
          const { bin, forge } = yield* releasable(name, {
            comments: [
              { id: 48, author: "bob", at: "2026-10-20T10:00:00Z", body: "rename it", ...where },
              { id: 49, author: "bob", at: "2026-10-20T12:00:00Z", body: "and this", ...where },
            ],
          });
          const runId = `r-lost-thread-${name}`;
          const fs = yield* FileSystem.FileSystem;
          yield* fs.makeDirectory(runDir(dir, runId), { recursive: true });
          yield* fs.writeFileString(`${runDir(dir, runId)}/merge-request`, `${mr}\n`);
          const ask = (comment: string, body: string) => ({
            runId,
            cwd: rig.projectDir,
            comment,
            body,
            kind: "disputed" as const,
          });
          const at = (now: string) =>
            Effect.flatMap(forge.model(), (model) => forge.set({ ...model, now }));
          const said = yield* session(
            Effect.gen(function* () {
              const host = yield* Host;
              yield* at("2026-10-20T11:00:00Z");
              const first = yield* host.reply(ask("48", "Not changed: the name is the domain's"));
              yield* at("2026-10-20T13:00:00Z");
              const second = yield* host.reply(ask("49", "Not changed: this one too"));
              yield* fs.remove(`${runDir(dir, runId)}/replies.jsonl`);
              return [first, second, yield* host.reply(ask("49", "Not changed: this one too"))];
            }),
          );
          yield* bin.restore();
          expect(said).toEqual(["posted", "posted", "already"]);
          expect((yield* readReplies(runDir(dir, runId))).map((one) => one.body)).toEqual([
            `Not changed: this one too${signed(runId)}`,
          ]);
        }),
      ),
    120_000,
  );

  scenario(
    `release on ${name}: a reply to a comment whose address starts with another's is not recorded for that other`,
    () =>
      runEffect(
        Effect.gen(function* () {
          const { bin } = yield* releasable(name, {
            comments: [
              { id: 52, author: "bob", at: "2026-10-20T10:00:00Z", body: "rename it" },
              { id: 520, author: "bob", at: "2026-10-20T10:30:00Z", body: "and this" },
              {
                id: 53,
                author: "tester",
                at: "2026-10-20T11:00:00Z",
                body: `${commentUrl(name, 52)} renamed by hand`,
              },
            ],
          });
          const runId = `r-prefix-${name}`;
          const fs = yield* FileSystem.FileSystem;
          yield* fs.makeDirectory(runDir(dir, runId), { recursive: true });
          yield* fs.writeFileString(`${runDir(dir, runId)}/merge-request`, `${mr}\n`);
          const ask = (id: number) => ({
            runId,
            cwd: rig.projectDir,
            comment: String(id),
            body: `${commentUrl(name, id)}\n\nNot changed: the name is the domain's`,
            kind: "disputed" as const,
          });
          const said = yield* session(
            Effect.gen(function* () {
              const host = yield* Host;
              return [yield* host.reply(ask(520)), yield* host.reply(ask(52))];
            }),
          );
          yield* bin.restore();
          expect(said).toEqual(["posted", "already"]);
          expect((yield* readReplies(runDir(dir, runId))).map((one) => one.comment)).toEqual([
            commentUrl(name, 520),
          ]);
        }),
      ),
    120_000,
  );

  scenario(
    `release on ${name}: a reply in a comment's thread after Collie's starts a round of its own`,
    () =>
      runEffect(
        Effect.gen(function* () {
          const thread = name === "gitlab" ? "d51" : "51";
          const original = {
            id: 51,
            author: "bob",
            at: "2026-10-20T11:00:00Z",
            body: "please rename this",
            thread,
            file: "src/app.ts",
            line: 3,
          };
          const { bin, forge, changed } = yield* releasable(name, {
            ...UNAPPROVED[name],
            comments: [original],
          });
          const runId = `r-thread-${name}`;
          const disputing = (id: string, note: string) => ({
            verdict: "clean",
            answers: [{ id, answer: "disputed", note }],
          });
          yield* rig.queueOutputs([
            PACKAGED,
            disputing("51", "the name is the domain's"),
            disputing("53", "still the domain's"),
          ]);
          const status = yield* driven(
            { entry: shipped("release"), runId, input: { mr: target }, host: releaseHost() },
            (run) =>
              Effect.gen(function* () {
                yield* until(
                  () => forge.model(),
                  (model) => repliesOf(model).length === 1,
                );
                const now = yield* forge.model();
                const followUp = {
                  id: 53,
                  author: "bob",
                  at: "2026-10-20T12:05:00Z",
                  body: "why is it the domain's?",
                  thread,
                };
                yield* forge.set({
                  ...now,
                  mrs: now.mrs.map((one) => ({
                    ...one,
                    comments: [...(one.comments ?? []), followUp],
                  })),
                });
                yield* until(
                  () => forge.model(),
                  (model) => repliesOf(model).length === 2,
                );
                yield* changed(approvedBy(name, "dave"));
                yield* goAsked(run.asked, "go-1");
                yield* run.answer("go-1", "Finish");
                return yield* ended(run.status);
              }),
          );
          const model = yield* forge.model();
          yield* bin.restore();
          expect(outcomeText(status)).toBe(`${mr} was left open`);
          expect(repliesOf(model).map((one) => one.thread)).toEqual([thread, thread]);
          expect(yield* asked(runId, "answer-1")).toContain("src/app.ts:3");
          const second = yield* asked(runId, "answer-2");
          expect(second).toContain("why is it the domain's?");
          expect(second).not.toContain("please rename this");
        }),
      ),
    120_000,
  );

  scenario(
    `release on ${name}: a host restarted in the middle of the replies posts none of them twice`,
    () =>
      runEffect(
        Effect.gen(function* () {
          const comments = [61, 62].map((id) => ({
            id,
            author: "bob",
            at: `2026-10-20T11:0${id - 60}:00Z`,
            body: `comment ${id}`,
          }));
          const { bin, forge } = yield* releasable(name, { comments });
          const runId = `r-restart-${name}`;
          yield* rig.queueOutputs([
            PACKAGED,
            {
              verdict: "clean",
              answers: comments.map((one) => ({
                id: String(one.id),
                answer: "disputed",
                note: `not ${one.id}`,
              })),
            },
          ]);
          const options = { entry: shipped("release"), runId, input: { mr: target } };
          yield* driven({ ...options, host: releaseHost({}, Effect.void, 2) }, () =>
            until(
              () => forge.model(),
              (model) => repliesOf(model).length === 2,
            ),
          );
          const status = yield* driven(
            { ...options, host: releaseHost(), restarted: true },
            (run) =>
              Effect.gen(function* () {
                yield* goAsked(run.asked, "go-1");
                yield* run.answer("go-1", "Finish");
                return yield* ended(run.status);
              }),
          );
          const model = yield* forge.model();
          yield* bin.restore();
          expect(outcomeText(status)).toBe(`${mr} was left open`);
          expect(repliesOf(model).map((one) => one.body)).toEqual([
            `${commentUrl(name, 61)}\n\nNot changed: not 61${signed(runId)}`,
            `${commentUrl(name, 62)}\n\nNot changed: not 62${signed(runId)}`,
          ]);
        }),
      ),
    120_000,
  );

  scenario(
    `release on ${name}: a comment left out of a round is carried into the next, and a round that answers nothing parks the Run`,
    () =>
      runEffect(
        Effect.gen(function* () {
          const comments = [
            { id: 71, author: "bob", at: "2026-10-20T11:01:00Z", body: "rename this" },
            { id: 72, author: "carol", at: "2026-10-20T11:02:00Z", body: "split that" },
          ];
          const { bin, forge } = yield* releasable(name, { comments });
          const runId = `r-carried-${name}`;
          yield* rig.queueOutputs([
            PACKAGED,
            { verdict: "clean", answers: [{ id: "71", answer: "disputed", note: "kept" }] },
            { verdict: "clean", answers: [] },
          ]);
          const why = yield* driven(
            { entry: shipped("release"), runId, input: { mr: target }, host: releaseHost() },
            () =>
              until(
                () => parkedWhy(runId),
                (why) => why.includes("answered none"),
              ),
          );
          const model = yield* forge.model();
          yield* bin.restore();
          expect(why).toBe(
            `answer-2 answered none of the comments it was given: ${commentUrl(name, 72)}. Repair it, then resume ${runId}.`,
          );
          expect(repliesOf(model)).toHaveLength(1);
          const second = yield* asked(runId, "answer-2");
          expect(second).toContain("split that");
          expect(second).not.toContain("rename this");
        }),
      ),
    120_000,
  );

  scenario(
    `release on ${name}: a check failing on the head a round pushed goes to a fix round, whose head is proved again`,
    () =>
      runEffect(
        Effect.gen(function* () {
          const comment = { id: 81, author: "bob", at: "2026-10-20T11:00:00Z", body: "rename" };
          const { bin, forge, head, changed } = yield* releasable(name, {
            ...UNAPPROVED[name],
            comments: [comment],
          });
          const runId = `r-fixround-${name}`;
          const flag = `${rig.root}/unit-${name}`;
          const fs = yield* FileSystem.FileSystem;
          yield* fs.writeFileString(flag, "ok\n").pipe(Effect.orDie);
          yield* checkedBy(runId, "unit", "grep", ["-qx", "ok", flag]);
          const pushed = yield* agentPush(forge, yield* forge.model(), head);
          yield* rig.queueOutputs([
            PACKAGED,
            {
              writes: [...pushed.writes, { path: flag, text: "broken\n" }],
              output: {
                verdict: "clean",
                answers: [{ id: "81", answer: "fixed", commit: pushed.sha, note: "renamed" }],
              },
            },
            {
              writes: [{ path: flag, text: "ok\n" }],
              output: { verdict: "clean", fixed: [{ title: "unit failed" }] },
            },
          ]);
          yield* driven(
            { entry: shipped("release"), runId, input: { mr: target }, host: releaseHost() },
            (run) =>
              Effect.gen(function* () {
                yield* until(
                  () => awaitingOn(runId),
                  (on) => on.includes("approval"),
                );
                yield* until(
                  () => prompts(),
                  (typed) => typed.some((one) => one.includes("/fix-1.prompt.md")),
                );
                yield* changed(approvedBy(name, "dave"));
                yield* goAsked(run.asked, "go-1");
                yield* run.answer("go-1", "Finish");
                return yield* ended(run.status);
              }),
          );
          yield* bin.restore();
          const proved = (yield* readVerifications(evidenceDir(dir, runId))).map((one) => [
            one.end.head_sha,
            one.result,
          ]);
          expect(proved).toEqual([
            [head, "pass"],
            [pushed.sha, "fail"],
            [pushed.sha, "pass"],
          ]);
          expect(yield* asked(runId, "fix-1")).toContain("unit failed");
          expect(yield* clearance(runId, "fix-1")).toBe(
            `Cleared for this step: committing to the merge request's source branch on ${url} and pushing it with a plain push, never a force push.`,
          );
        }),
      ),
    120_000,
  );

  scenario(
    `release on ${name}: four fix rounds that leave a check failing park the Run with why`,
    () =>
      runEffect(
        Effect.gen(function* () {
          const { bin, head } = yield* releasable(name);
          const runId = `r-unfixed-${name}`;
          yield* checkedBy(runId, "unit", "false");
          const tried = { verdict: "clean", fixed: [{ title: "unit failed" }] };
          yield* rig.queueOutputs([PACKAGED, tried, tried, tried, tried]);
          const why = yield* driven(
            { entry: shipped("release"), runId, input: { mr: target }, host: releaseHost() },
            (run) =>
              Effect.gen(function* () {
                const why = yield* until(
                  () => parkedWhy(runId),
                  (why) => why.includes("fix rounds"),
                );
                expect(yield* run.asked).toEqual([]);
                return why;
              }),
          );
          yield* bin.restore();
          expect(why).toBe(
            `The checks failed at ${head.slice(0, 8)} after 4 fix rounds: unit failed. Repair it, then resume ${runId}.`,
          );
          expect((yield* prompts()).filter((one) => one.includes("/fix-"))).toHaveLength(4);
        }),
      ),
    120_000,
  );

  scenario(
    `release on ${name}: a comment between go 1 and its answer sends the Run back to the wait, and go 2 is asked once it is answered`,
    () =>
      runEffect(
        Effect.gen(function* () {
          const { bin, forge, head } = yield* releasable(name);
          claimed.length = 0;
          const runId = `r-pinned-${name}`;
          yield* rig.queueOutputs([
            PACKAGED,
            { verdict: "clean", answers: [{ id: "91", answer: "disputed", note: "as meant" }] },
          ]);
          const status = yield* driven(
            { entry: shipped("release"), runId, input: { mr: target }, host: releaseHost() },
            (run) =>
              Effect.gen(function* () {
                yield* goAsked(run.asked, "go-1");
                const now = yield* forge.model();
                const late = { id: 91, author: "bob", at: "2026-10-20T11:00:00Z", body: "wait" };
                yield* forge.set({
                  ...now,
                  mrs: now.mrs.map((one) => ({ ...one, comments: [late] })),
                });
                yield* run.answer("go-1", "Release");
                yield* goAsked(run.asked, "go-2");
                yield* run.answer("go-2", "Finish");
                return yield* ended(run.status);
              }),
          );
          const model = yield* forge.model();
          yield* bin.restore();
          expect(outcomeText(status)).toBe(`${mr} was left open`);
          expect(model.merges ?? []).toEqual([]);
          expect(claimed).toEqual([`claim ${runId}`, `release ${runId}`]);
          expect(repliesOf(model)).toHaveLength(1);
          expect(yield* runLog(runId)).toContain(
            `go 1 no longer holds for ${head.slice(0, 8)}: 1 unanswered comment(s)`,
          );
        }),
      ),
    120_000,
  );

  scenario(
    `release on ${name}: a go answered while the head's pipeline still runs waits it out and merges on that go`,
    () =>
      runEffect(
        Effect.gen(function* () {
          const { bin, forge, head, merged, changed } = yield* releasable(name);
          claimed.length = 0;
          const runId = `r-go-ci-${name}`;
          yield* rig.queueOutputs([PACKAGED, TAGGED]);
          const status = yield* driven(
            { entry: shipped("release"), runId, input: { mr: target }, host: releaseHost() },
            (run) =>
              Effect.gen(function* () {
                yield* goAsked(run.asked, "go-1");
                yield* changed(STILL_RUNNING);
                yield* run.answer("go-1", "Release");
                yield* until(
                  () => awaitingOn(runId),
                  (on) => on.startsWith("CI"),
                );
                expect(yield* runLog(runId)).not.toContain("no longer holds");
                yield* changed(PIPELINE_PASSED);
                const end = yield* ended(run.status);
                expect(
                  (yield* run.asked).filter((row) => row.decision.startsWith("go-")),
                ).toHaveLength(1);
                return end;
              }),
          );
          const model = yield* forge.model();
          yield* bin.restore();
          expect(outcomeText(status)).toBe(`${mr} merged at ${merged}, released as v1.2.0`);
          expect(model.merges?.map((one) => one.sha)).toEqual([head]);
        }),
      ),
    120_000,
  );

  scenario(
    `release on ${name}: a go whose pipeline fails while it still runs no longer holds, and is asked again once it is green`,
    () =>
      runEffect(
        Effect.gen(function* () {
          const { bin, forge, head, changed } = yield* releasable(name);
          claimed.length = 0;
          const runId = `r-go-ci-failed-${name}`;
          yield* rig.queueOutputs([PACKAGED]);
          const status = yield* driven(
            { entry: shipped("release"), runId, input: { mr: target }, host: releaseHost() },
            (run) =>
              Effect.gen(function* () {
                yield* goAsked(run.asked, "go-1");
                yield* changed(STILL_RUNNING);
                yield* run.answer("go-1", "Release");
                yield* until(
                  () => awaitingOn(runId),
                  (on) => on.startsWith("CI"),
                );
                yield* changed({ checks: [{ name: "build", state: "failed" }], mergeable: "yes" });
                yield* until(
                  () => runLog(runId),
                  (log) => log.includes("no longer holds"),
                );
                yield* changed(PIPELINE_PASSED);
                yield* goAsked(run.asked, "go-2");
                yield* run.answer("go-2", "Finish");
                return yield* ended(run.status);
              }),
          );
          const model = yield* forge.model();
          yield* bin.restore();
          expect(outcomeText(status)).toBe(`${mr} was left open`);
          expect(model.merges ?? []).toEqual([]);
          const at = head.slice(0, 8);
          expect(yield* runLog(runId)).toMatch(
            new RegExp(`go 1 no longer holds for ${at}: the pipeline at ${at}, whose \\S+ failed`),
          );
        }),
      ),
    120_000,
  );

  scenario(
    `release on ${name}: a go whose head moves while its pipeline still runs no longer holds, naming the moved head`,
    () =>
      runEffect(
        Effect.gen(function* () {
          const { bin, forge, head, changed } = yield* releasable(name);
          claimed.length = 0;
          const runId = `r-go-ci-moved-${name}`;
          yield* rig.queueOutputs([PACKAGED]);
          let moved = "";
          const status = yield* driven(
            { entry: shipped("release"), runId, input: { mr: target }, host: releaseHost() },
            (run) =>
              Effect.gen(function* () {
                yield* goAsked(run.asked, "go-1");
                yield* changed(STILL_RUNNING);
                yield* run.answer("go-1", "Release");
                yield* until(
                  () => awaitingOn(runId),
                  (on) => on.startsWith("CI"),
                );
                moved = yield* pushedBySomebody(head);
                yield* changed({ ...PIPELINE_PASSED, head: moved });
                yield* goAsked(run.asked, "go-2");
                yield* run.answer("go-2", "Finish");
                return yield* ended(run.status);
              }),
          );
          const model = yield* forge.model();
          yield* bin.restore();
          expect(outcomeText(status)).toBe(`${mr} was left open`);
          expect(model.merges ?? []).toEqual([]);
          expect(claimed).toEqual([`claim ${runId}`, `release ${runId}`]);
          expect(yield* runLog(runId)).toContain(
            `go 1 no longer holds for ${head.slice(0, 8)}: its head moved to ${moved.slice(0, 8)}`,
          );
        }),
      ),
    120_000,
  );

  scenario(
    `release on ${name}: a comment while the claim is taken merges nothing, gives the claim back and asks again once it is answered`,
    () =>
      runEffect(
        Effect.gen(function* () {
          const { bin, forge, head } = yield* releasable(name);
          claimed.length = 0;
          const runId = `r-claiming-${name}`;
          yield* rig.queueOutputs([
            PACKAGED,
            { verdict: "clean", answers: [{ id: "92", answer: "disputed", note: "as meant" }] },
          ]);
          const late = { id: 92, author: "bob", at: "2026-10-20T11:00:00Z", body: "wait" };
          const commented = Effect.gen(function* () {
            const now = yield* forge.model();
            yield* forge.set({ ...now, mrs: now.mrs.map((one) => ({ ...one, comments: [late] })) });
          });
          const status = yield* driven(
            {
              entry: shipped("release"),
              runId,
              input: { mr: target },
              host: releaseHost({}, commented),
            },
            (run) =>
              Effect.gen(function* () {
                yield* goAsked(run.asked, "go-1");
                yield* run.answer("go-1", "Release");
                yield* goAsked(run.asked, "go-2");
                yield* run.answer("go-2", "Finish");
                return yield* ended(run.status);
              }),
          );
          const model = yield* forge.model();
          yield* bin.restore();
          expect(outcomeText(status)).toBe(`${mr} was left open`);
          expect(model.merges ?? []).toEqual([]);
          expect(claimed).toEqual([`claim ${runId}`, `release ${runId}`]);
          expect(yield* runLog(runId)).toContain(
            `go 1 no longer holds for ${head.slice(0, 8)}: 1 unanswered comment(s)`,
          );
        }),
      ),
    120_000,
  );

  scenario(
    `release on ${name}: the host posts approval once through Slack and records the returned message's permalink`,
    () =>
      runEffect(
        Effect.gen(function* () {
          const { bin, forge, head, changed } = yield* releasable(name, UNAPPROVED[name]);
          slack = fakeSlack();
          yield* changed({ title: "Fix the settings" });
          const runId = `r-share-${name}`;
          yield* sharingIn("C123");
          yield* rig.queueOutputs([PACKAGED]);
          let moved = "";
          const { status, decisions } = yield* driven(
            { entry: shipped("release"), runId, input: { mr: target }, host: releaseHost() },
            (run) =>
              Effect.gen(function* () {
                const share = yield* goAsked(run.asked, "share-for-approval");
                expect(share.prompt).toContain(mr);
                expect(share.prompt).toContain(head.slice(0, 8));
                expect(share.prompt).toContain("Check it first");
                expect(share.prompt).toContain("C123");
                expect(slack.calls).toEqual([{ method: "auth.test", parameters: {} }]);
                expect(optionsOf([share], "share-for-approval")).toEqual([
                  "Post for approval",
                  "Wait for changes",
                ]);
                yield* run.answer("share-for-approval", "Post for approval");
                yield* until(
                  () => runLog(runId),
                  (log) => log.includes(`shared ${mr}`),
                );
                moved = yield* pushedBySomebody(head);
                yield* changed({ head: moved });
                // Approved only once the Run waits at the new head: a read of the forge is
                // several requests, and one spanning both changes would see the old head approved.
                yield* until(
                  () => Effect.all([revParse("refs/heads/feature"), awaitingOn(runId)]),
                  ([at, on]) => at === moved && on.includes("approval"),
                );
                yield* changed(approvedBy(name, "dave"));
                const go = yield* goAsked(run.asked, "go-1");
                expect(go.prompt).toContain(moved.slice(0, 8));
                yield* run.answer("go-1", "Finish");
                const status = yield* ended(run.status);
                return { status, decisions: (yield* run.asked).map((row) => row.decision) };
              }),
          );
          const model = yield* forge.model();
          yield* bin.restore();
          expect(outcomeText(status)).toBe(`${mr} was left open`);
          expect(decisions.filter((one) => one.startsWith("share"))).toEqual([
            "share-for-approval",
          ]);
          expect(yield* runLog(runId)).toContain(
            `shared ${mr} in C123 for approval: ${POSTED.link}`,
          );
          expect(slack.calls.filter((call) => call.method.startsWith("chat."))).toEqual([
            {
              method: "chat.postMessage",
              parameters: { channel: "C123", text: `<${mr}|Fix the settings>` },
            },
            {
              method: "chat.getPermalink",
              parameters: { channel: "D123", message_ts: "1503435956.000247" },
            },
          ]);
          expect((yield* prompts()).filter((one) => one.includes(`/${runId}/share`))).toEqual([]);
          expect(repliesOf(model)).toEqual([]);
          expect(model.merges ?? []).toEqual([]);
        }),
      ),
    120_000,
  );
}

{
  const { mr, target } = RELEASING.gitlab;
  const options = (runId: string) => ({ entry: shipped("release"), runId, input: { mr: target } });

  scenario(
    "release with Slack absent in the registry asks the operator to share its address and sends no Slack requests",
    () =>
      runEffect(
        Effect.gen(function* () {
          const { bin, changed } = yield* releasable("gitlab", UNAPPROVED.gitlab);
          const runId = "r-share-manually";
          yield* sharingIn("#frontend");
          yield* writeSlackToken(hostOf().env, null);
          yield* rig.queueOutputs([PACKAGED]);
          const status = yield* driven({ ...options(runId), host: releaseHost() }, (run) =>
            Effect.gen(function* () {
              const share = yield* goAsked(run.asked, "share-for-approval");
              expect(share.prompt).toContain("Share it in #frontend yourself");
              expect(share.prompt).toContain(mr);
              expect(share.prompt).toContain("No Slack bot token");
              expect(optionsOf([share], "share-for-approval")).toEqual([
                "I shared it",
                "Wait for changes",
              ]);
              yield* run.answer("share-for-approval", "I shared it");
              yield* changed(approvedBy("gitlab", "dave"));
              yield* goAsked(run.asked, "go-1");
              yield* run.answer("go-1", "Finish");
              return yield* ended(run.status);
            }),
          );
          yield* bin.restore();
          expect(outcomeText(status)).toBe(`${mr} was left open`);
          expect(yield* runLog(runId)).toContain(`shared by the operator: ${mr} in #frontend`);
          expect((yield* rig.calls()).filter((call) => call.cmd === "agent start")).toHaveLength(1);
          expect(slack.calls).toEqual([]);
        }),
      ),
    120_000,
  );

  once(
    "release on gitlab: Wait for changes shares nothing, is asked again only at a new head, and a teammate's approval goes on to go 1",
    () =>
      runEffect(
        Effect.gen(function* () {
          const { bin, head, changed } = yield* releasable("gitlab", UNAPPROVED.gitlab);
          const runId = "r-share-wait";
          yield* sharingIn("#frontend");
          yield* rig.queueOutputs([PACKAGED]);
          let moved = "";
          const { status, decisions } = yield* driven(
            { ...options(runId), host: releaseHost() },
            (run) =>
              Effect.gen(function* () {
                yield* goAsked(run.asked, "share-for-approval");
                yield* run.answer("share-for-approval", "Wait for changes");
                moved = yield* pushedBySomebody(head);
                yield* changed({ head: moved });
                const again = yield* goAsked(run.asked, "share-for-approval-2");
                expect(again.prompt).toContain(moved.slice(0, 8));
                yield* run.answer("share-for-approval-2", "Wait for changes");
                yield* until(
                  () => runLog(runId),
                  (log) => log.includes(`not shared at ${moved.slice(0, 8)}`),
                );
                yield* changed(approvedBy("gitlab", "dave"));
                yield* goAsked(run.asked, "go-1");
                yield* run.answer("go-1", "Finish");
                const status = yield* ended(run.status);
                return { status, decisions: (yield* run.asked).map((row) => row.decision) };
              }),
          );
          yield* bin.restore();
          expect(outcomeText(status)).toBe(`${mr} was left open`);
          expect(decisions.filter((one) => one.startsWith("share"))).toEqual([
            "share-for-approval",
            "share-for-approval-2",
          ]);
          expect(yield* runLog(runId)).toContain(
            `not shared at ${head.slice(0, 8)}: waiting for ${mr} to change`,
          );
          expect((yield* prompts()).filter((one) => one.includes(`/${runId}/share`))).toEqual([]);
        }),
      ),
    120_000,
  );

  once(
    "release on gitlab: sharing turned on with no channel says so on the Run's log and asks nothing",
    () =>
      runEffect(
        Effect.gen(function* () {
          const { bin, changed } = yield* releasable("gitlab", UNAPPROVED.gitlab);
          const runId = "r-share-nowhere";
          yield* sharingIn(null);
          yield* rig.queueOutputs([PACKAGED]);
          const decisions = yield* driven({ ...options(runId), host: releaseHost() }, (run) =>
            Effect.gen(function* () {
              yield* until(
                () => awaitingOn(runId),
                (on) => on.includes("approval"),
              );
              yield* changed(approvedBy("gitlab", "dave"));
              yield* goAsked(run.asked, "go-1");
              yield* run.answer("go-1", "Finish");
              yield* ended(run.status);
              return (yield* run.asked).map((row) => row.decision);
            }),
          );
          yield* bin.restore();
          expect(decisions.filter((one) => one.startsWith("share"))).toEqual([]);
          expect(yield* runLog(runId)).toContain(
            "release.share_for_approval is on but release.approval_channel names no channel, so nothing is shared for approval",
          );
        }),
      ),
    120_000,
  );

  once(
    "release on gitlab: channel_not_found is recorded and the host continues to its review wait",
    () =>
      runEffect(
        Effect.gen(function* () {
          const { bin, changed } = yield* releasable("gitlab", UNAPPROVED.gitlab);
          const runId = "r-share-failed";
          yield* sharingIn("#frontend");
          slack.refuse("channel_not_found", "chat.postMessage");
          yield* rig.queueOutputs([PACKAGED]);
          const status = yield* driven({ ...options(runId), host: releaseHost() }, (run) =>
            Effect.gen(function* () {
              yield* goAsked(run.asked, "share-for-approval");
              yield* run.answer("share-for-approval", "Post for approval");
              yield* until(
                () => runLog(runId),
                (log) => log.includes("did not share"),
              );
              yield* until(
                () => awaitingOn(runId),
                (on) => on.includes("approval"),
              );
              yield* changed(approvedBy("gitlab", "dave"));
              yield* goAsked(run.asked, "go-1");
              yield* run.answer("go-1", "Finish");
              return yield* ended(run.status);
            }),
          );
          yield* bin.restore();
          expect(outcomeText(status)).toBe(`${mr} was left open`);
          expect(yield* runLog(runId)).toContain(
            `did not share ${mr} in #frontend: Slack chat.postMessage: channel_not_found`,
          );
          expect(slack.calls.filter((call) => call.method === "chat.postMessage")).toHaveLength(1);
          expect(slack.calls.some((call) => call.method === "chat.getPermalink")).toBe(false);
        }),
      ),
    120_000,
  );

  once(
    "release on gitlab: a missing permalink still counts as shared and a host restart does not repost",
    () =>
      runEffect(
        Effect.gen(function* () {
          const { bin, changed } = yield* releasable("gitlab", UNAPPROVED.gitlab);
          const runId = "r-share-no-permalink";
          yield* sharingIn("C123");
          slack.refuse("channel_not_found", "chat.getPermalink");
          yield* rig.queueOutputs([PACKAGED]);
          yield* driven({ ...options(runId), host: releaseHost() }, (run) =>
            Effect.gen(function* () {
              yield* goAsked(run.asked, "share-for-approval");
              yield* run.answer("share-for-approval", "Post for approval");
              yield* until(
                () => awaitingOn(runId),
                (on) => on.includes("approval"),
              );
            }),
          );
          yield* changed(approvedBy("gitlab", "dave"));
          const status = yield* driven(
            { ...options(runId), host: releaseHost(), restarted: true },
            (run) =>
              Effect.gen(function* () {
                yield* goAsked(run.asked, "go-1");
                yield* run.answer("go-1", "Finish");
                return yield* ended(run.status);
              }),
          );
          yield* bin.restore();
          expect(outcomeText(status)).toBe(`${mr} was left open`);
          expect(yield* runLog(runId)).toContain(
            `shared ${mr} in C123 for approval: permalink missing: Slack chat.getPermalink: channel_not_found`,
          );
          expect(slack.calls.filter((call) => call.method === "chat.postMessage")).toHaveLength(1);
          expect(slack.calls.filter((call) => call.method === "chat.getPermalink")).toHaveLength(1);
        }),
      ),
    120_000,
  );

  once(
    "release on gitlab: a host restarted after sharing was turned off still asks what it asked, and a share that posted nothing says why",
    () =>
      runEffect(
        Effect.gen(function* () {
          const { bin, changed } = yield* releasable("gitlab", UNAPPROVED.gitlab);
          const runId = "r-share-replayed";
          yield* sharingIn("#frontend");
          slack.refuse("not_in_channel", "chat.postMessage");
          yield* rig.queueOutputs([PACKAGED]);
          yield* driven({ ...options(runId), host: releaseHost() }, (run) =>
            goAsked(run.asked, "share-for-approval"),
          );
          const fs = yield* FileSystem.FileSystem;
          yield* fs.writeFileString(`${rig.userDir}/config.json`, asJson({})).pipe(Effect.orDie);
          const status = yield* driven(
            { ...options(runId), host: releaseHost(), restarted: true },
            (run) =>
              Effect.gen(function* () {
                yield* run.answer("share-for-approval", "Post for approval");
                yield* until(
                  () => runLog(runId),
                  (log) => log.includes("did not share"),
                );
                yield* changed(approvedBy("gitlab", "dave"));
                yield* goAsked(run.asked, "go-1");
                yield* run.answer("go-1", "Finish");
                return yield* ended(run.status);
              }),
          );
          yield* bin.restore();
          expect(outcomeText(status)).toBe(`${mr} was left open`);
          expect(yield* runLog(runId)).toContain(
            `did not share ${mr} in #frontend: Slack chat.postMessage: not_in_channel`,
          );
        }),
      ),
    120_000,
  );

  once(
    "release on gitlab: Wait for changes is not asked again after a round of replies leaves the head where it was",
    () =>
      runEffect(
        Effect.gen(function* () {
          const { bin, forge, changed } = yield* releasable("gitlab", UNAPPROVED.gitlab);
          const runId = "r-share-same-head";
          yield* sharingIn("#frontend");
          yield* rig.queueOutputs([
            PACKAGED,
            { verdict: "clean", answers: [{ id: "96", answer: "disputed", note: "as meant" }] },
          ]);
          const status = yield* driven({ ...options(runId), host: releaseHost() }, (run) =>
            Effect.gen(function* () {
              yield* goAsked(run.asked, "share-for-approval");
              const late = { id: 96, author: "bob", at: "2026-10-20T11:00:00Z", body: "wait" };
              yield* changed({ comments: [late] });
              yield* run.answer("share-for-approval", "Wait for changes");
              const [, rows] = yield* until(
                () => Effect.all([forge.model(), run.asked, awaitingOn(runId)]),
                ([model, rows, on]) =>
                  repliesOf(model).length === 1 &&
                  (on.includes("approval") ||
                    rows.some((row) => row.decision === "share-for-approval-2")),
              );
              expect(
                rows.map((row) => row.decision).filter((one) => one.startsWith("share")),
              ).toEqual(["share-for-approval"]);
              yield* changed(approvedBy("gitlab", "dave"));
              yield* goAsked(run.asked, "go-1");
              yield* run.answer("go-1", "Finish");
              return yield* ended(run.status);
            }),
          );
          yield* bin.restore();
          expect(outcomeText(status)).toBe(`${mr} was left open`);
        }),
      ),
    120_000,
  );

  once(
    "release on gitlab: sharing on for an approved merge request asks nothing",
    () =>
      runEffect(
        Effect.gen(function* () {
          const { bin } = yield* releasable("gitlab");
          const runId = "r-share-approved";
          yield* sharingIn("#frontend");
          yield* rig.queueOutputs([PACKAGED]);
          const decisions = yield* driven({ ...options(runId), host: releaseHost() }, (run) =>
            Effect.gen(function* () {
              const rows = yield* until(
                () => run.asked,
                (rows) =>
                  rows.some(
                    (row) => row.decision === "go-1" || row.decision === "share-for-approval",
                  ),
              );
              if (rows.some((row) => row.decision === "go-1")) {
                yield* run.answer("go-1", "Finish");
                yield* ended(run.status);
              }
              return rows.map((row) => row.decision);
            }),
          );
          yield* bin.restore();
          expect(decisions).toEqual(["go-1"]);
        }),
      ),
    120_000,
  );

  once(
    "release on gitlab: a share that posted nothing is asked again at the next head",
    () =>
      runEffect(
        Effect.gen(function* () {
          const { bin, head, changed } = yield* releasable("gitlab", UNAPPROVED.gitlab);
          const runId = "r-share-failed-moved";
          yield* sharingIn("#frontend");
          slack.refuse("not_in_channel", "chat.postMessage");
          yield* rig.queueOutputs([PACKAGED]);
          const status = yield* driven({ ...options(runId), host: releaseHost() }, (run) =>
            Effect.gen(function* () {
              yield* goAsked(run.asked, "share-for-approval");
              yield* run.answer("share-for-approval", "Post for approval");
              yield* until(
                () => runLog(runId),
                (log) => log.includes("did not share"),
              );
              const moved = yield* pushedBySomebody(head);
              yield* changed({ head: moved });
              const again = yield* goAsked(run.asked, "share-for-approval-2");
              expect(again.prompt).toContain(moved.slice(0, 8));
              yield* run.answer("share-for-approval-2", "Wait for changes");
              yield* changed(approvedBy("gitlab", "dave"));
              yield* goAsked(run.asked, "go-1");
              yield* run.answer("go-1", "Finish");
              return yield* ended(run.status);
            }),
          );
          yield* bin.restore();
          expect(outcomeText(status)).toBe(`${mr} was left open`);
        }),
      ),
    120_000,
  );

  once(
    "release on gitlab: Post for approval answered after a teammate approved posts nothing",
    () =>
      runEffect(
        Effect.gen(function* () {
          const { bin, changed } = yield* releasable("gitlab", UNAPPROVED.gitlab);
          const runId = "r-share-late";
          yield* sharingIn("#frontend");
          yield* rig.queueOutputs([PACKAGED]);
          const status = yield* driven({ ...options(runId), host: releaseHost() }, (run) =>
            Effect.gen(function* () {
              yield* goAsked(run.asked, "share-for-approval");
              yield* changed(approvedBy("gitlab", "dave"));
              yield* run.answer("share-for-approval", "Post for approval");
              yield* goAsked(run.asked, "go-1");
              yield* run.answer("go-1", "Finish");
              return yield* ended(run.status);
            }),
          );
          yield* bin.restore();
          expect(outcomeText(status)).toBe(`${mr} was left open`);
          expect((yield* prompts()).filter((one) => one.includes(`/${runId}/share`))).toEqual([]);
          expect(yield* runLog(runId)).toContain(
            `not shared: ${mr} no longer waits for a teammate's approval`,
          );
        }),
      ),
    120_000,
  );
}

/** Whether a failed Release Run on `target` offers Release again. */
/** Whether a failed Run of `name` on `target` is offered its followUp `id`. */
const followUpOffered = (name: Shipped, id: string, target: string) =>
  Effect.gen(function* () {
    const declared = yield* loadEntry(shipped(name)).pipe(
      Effect.map((described) => declaredByModule(described.metadata)),
      Effect.orDie,
    );
    const facts: ActionFacts = {
      outcome: "unspecified",
      succeeded: false,
      branch: null,
      mrUrl: null,
      planIssues: 0,
      disposed: false,
      openFindings: 0,
      diffTarget: target,
      claim: "project",
    };
    return offersFrom(declared, facts, { self: idOf(name) }).some((offer) => offer.id === id);
  });

const releaseAgainOffered = (target: string) => followUpOffered("release", "release-again", target);

/** The jobs of an application's tag pipeline, in the order each forge's job read numbers them. */
const TAG_JOBS = ["build", "deploy-stage", "e2e-stage", "deploy-production"] as const;
type TagJob = (typeof TAG_JOBS)[number];

/** A job of the tag's pipeline or Actions run, as the forge links it. */
const tagJob = (name: MrForge, job: TagJob) => {
  const id = TAG_JOBS.indexOf(job) + 1;
  return name === "gitlab"
    ? `https://gitlab.example.com/group/app/-/jobs/${id}`
    : `https://github.com/owner/repo/actions/runs/7/job/${id}`;
};

/** What the tag step of an application says it did, which nothing takes for proof. */
const stagedTag = (name: MrForge) => ({
  ...TAGGED,
  pipeline_url: PIPELINE_OF[name],
  stage_jobs: ["deploy-stage", "e2e-stage"],
  production_jobs: [{ name: "deploy-production", url: `${RELEASING[name].url}/said-by-the-agent` }],
});

/** Where stage and production are, by the commit each one's newest successful deployment has. */
const deploys = (stage: string, production: string) => [
  { name: "stage", tier: "staging", deployed: stage, job: "deploy-stage" },
  { name: "production", tier: "production", deployed: production },
];

/**
 * An application's merge request, ready, whose tag pipeline put the merge on stage and is
 * held by a blocking production job nobody has started: GitLab's pipeline is `manual`, and
 * GitHub's run waits on its environment's approval. Production carries the commit the merge
 * is made on.
 */
const stageable = (
  name: MrForge,
  states: Partial<Record<TagJob, "passed" | "failed" | "manual" | "running">> = {},
) =>
  Effect.gen(function* () {
    const made = yield* releasable(name);
    const jobs = {
      build: "passed",
      "deploy-stage": "passed",
      "e2e-stage": "passed",
      "deploy-production": "manual",
      ...states,
    } as const;
    const model: ForgeModel = {
      ...(yield* made.forge.model()),
      environments: deploys(made.merged, made.base),
      runs: {
        "7": {
          ...tagRun(made.merged),
          status: name === "gitlab" ? "manual" : "waiting",
          jobs: TAG_JOBS.map((job) => ({ name: job, state: jobs[job] })),
        },
      },
    };
    yield* made.forge.set(model);
    /** The forge as it is now, with `over` changed: someone deployed or played a job. */
    const now = (over: Partial<ForgeModel>) =>
      Effect.map(made.forge.model(), (current) => ({ ...current, ...over }));
    return { ...made, model, now };
  });

/** The production job left waiting on the tag's pipeline, as the forge links it. */
const waiting = (name: MrForge) => `\`deploy-production\` at ${tagJob(name, "deploy-production")}`;

const MONOREPO_ASSESSED = { ...APP_ASSESSED, applications: ["spilnu", "happytiger"] };

{
  const { mr, target } = RELEASING.gitlab;
  const helleRun = (runId: string, helle: () => HelleSays) => ({
    entry: shipped("release"),
    runId,
    input: { mr: target },
    host: releaseHost({}, Effect.void, Infinity, helle),
  });
  /** Production taken to carry the merge, once the Run waits for it. */
  const carried = (
    run: { readonly answer: (decision: string, value: string) => Effect.Effect<void> },
    forge: Effect.Success<ReturnType<typeof stageable>>["forge"],
    runId: string,
    merged: string,
  ) =>
    Effect.gen(function* () {
      yield* run.answer("production", "Leave production to me");
      yield* until(
        () => parkedWhy(runId),
        (why) => why !== "",
      );
      yield* forge.set({ ...(yield* forge.model()), environments: deploys(merged, merged) });
    });

  scenario(
    "release: a monorepo's release holds the Helle claim of every application it deploys before it merges",
    () =>
      runEffect(
        Effect.gen(function* () {
          const { bin, forge, head, merged } = yield* stageable("gitlab");
          claimed.length = 0;
          claimedFor.length = 0;
          const runId = "r-helle-monorepo";
          yield* rig.queueOutputs([MONOREPO_ASSESSED, stagedTag("gitlab")]);
          yield* driven(
            helleRun(runId, () => ({
              said: ["✓ this Run holds happytiger", "✓ this Run holds spilnu"],
              held: { slugs: ["happytiger", "spilnu"] },
            })),
            (run) =>
              Effect.gen(function* () {
                yield* goAsked(run.asked, "go-1");
                yield* run.answer("go-1", "Merge, tag and stage");
                yield* goAsked(run.asked, "production");
                yield* carried(run, forge, runId, merged);
                return yield* ended(run.status);
              }),
          );
          yield* bin.restore();
          expect(claimedFor).toEqual([
            { applications: ["spilnu", "happytiger"], jobs: ["deploy-stage"] },
          ]);
          expect((yield* forge.model()).merges?.map((one) => one.sha)).toEqual([head]);
          expect(claimed).toEqual([`claim ${runId}`, `release ${runId}`]);
          const log = yield* runLog(runId);
          expect(log).toContain("holds happytiger");
          expect(log).toContain("holds spilnu");
        }),
      ),
    120_000,
  );

  scenario(
    "release: a release whose Helle projects cannot be resolved asks the human before any merge, and Finish merges nothing",
    () =>
      runEffect(
        Effect.gen(function* () {
          const { bin, forge } = yield* stageable("gitlab");
          claimed.length = 0;
          const runId = "r-helle-unknown";
          yield* rig.queueOutputs([MONOREPO_ASSESSED]);
          const why = "no Helle project in spilnu/frontend's group for the application newapp";
          const status = yield* driven(
            helleRun(runId, () => ({ held: { unresolved: why } })),
            (run) =>
              Effect.gen(function* () {
                yield* goAsked(run.asked, "go-1");
                yield* run.answer("go-1", "Merge, tag and stage");
                const unclaimed = yield* goAsked(run.asked, "go-1.claim.unclaimed");
                expect(unclaimed.prompt).toContain(why);
                expect(optionsOf([unclaimed], "go-1.claim.unclaimed")).toEqual([
                  "Try again",
                  "Release without a Helle claim",
                  "Finish",
                ]);
                expect((yield* forge.model()).merges ?? []).toEqual([]);
                yield* run.answer("go-1.claim.unclaimed", "Finish");
                return yield* ended(run.status);
              }),
          );
          yield* bin.restore();
          expect(outcomeText(status)).toBe(`${mr} was left open`);
          const model = yield* forge.model();
          expect(model.merges ?? []).toEqual([]);
          expect(model.mrs[0]?.state).toBe("open");
          // Anything a failed claim took is given back.
          expect(claimed).toEqual([`release ${runId}`]);
        }),
      ),
    120_000,
  );

  for (const answer of ["Finish", "Release without a Helle claim"])
    scenario(
      `release: a claim Helle will not take back parks the release on ${answer}, unmerged, naming it`,
      () =>
        runEffect(
          Effect.gen(function* () {
            const { bin, forge } = yield* stageable("gitlab");
            claimed.length = 0;
            refusedBack.length = 0;
            refusedBack.push(["happytiger"]);
            const runId = `r-helle-kept-${answer === "Finish" ? "finish" : "without"}`;
            yield* rig.queueOutputs([MONOREPO_ASSESSED]);
            const why = "helle POST /projects/spilnu/claim answered 500: down";
            yield* driven(
              helleRun(runId, () => ({ held: { unresolved: why } })),
              (run) =>
                Effect.gen(function* () {
                  yield* goAsked(run.asked, "go-1");
                  yield* run.answer("go-1", "Merge, tag and stage");
                  yield* goAsked(run.asked, "go-1.claim.unclaimed");
                  yield* run.answer("go-1.claim.unclaimed", answer);
                  const parked = yield* until(
                    () => parkedWhy(runId),
                    (said) => said !== "",
                  );
                  expect(parked).toContain("happytiger");
                  expect((yield* run.status).status).not.toBe("complete");
                }),
            );
            yield* bin.restore();
            expect((yield* forge.model()).merges ?? []).toEqual([]);
            expect(yield* runLog(runId)).not.toContain("released without a Helle claim");
          }),
        ),
      120_000,
    );

  scenario(
    "release: a release goes on without a Helle claim only on the human's recorded say",
    () =>
      runEffect(
        Effect.gen(function* () {
          const { bin, forge, head, merged } = yield* stageable("gitlab");
          claimed.length = 0;
          const runId = "r-helle-without";
          yield* rig.queueOutputs([MONOREPO_ASSESSED, stagedTag("gitlab")]);
          const why = "no Helle project for monorepo, its applications or its deploy jobs";
          yield* driven(
            helleRun(runId, () => ({ held: { unresolved: why } })),
            (run) =>
              Effect.gen(function* () {
                yield* goAsked(run.asked, "go-1");
                yield* run.answer("go-1", "Merge, tag and stage");
                yield* goAsked(run.asked, "go-1.claim.unclaimed");
                yield* run.answer("go-1.claim.unclaimed", "Release without a Helle claim");
                yield* goAsked(run.asked, "production");
                yield* carried(run, forge, runId, merged);
                return yield* ended(run.status);
              }),
          );
          yield* bin.restore();
          expect((yield* forge.model()).merges?.map((one) => one.sha)).toEqual([head]);
          expect(claimed).toEqual([`release ${runId}`]);
          expect(yield* runLog(runId)).toContain(
            `released without a Helle claim on the human's say: ${why}`,
          );
        }),
      ),
    120_000,
  );

  scenario(
    "release: a Helle claim someone else holds keeps the release waiting, unmerged, until it is this Run's",
    () =>
      runEffect(
        Effect.gen(function* () {
          const { bin, forge, head, merged } = yield* stageable("gitlab");
          claimed.length = 0;
          const runId = "r-helle-held";
          yield* rig.queueOutputs([MONOREPO_ASSESSED, stagedTag("gitlab")]);
          const free = yield* Deferred.make<void>();
          yield* driven(
            helleRun(runId, () => ({
              said: ["⏳ waiting for spilnu — position 1"],
              waits: Deferred.await(free),
              held: { slugs: ["happytiger", "spilnu"] },
            })),
            (run) =>
              Effect.gen(function* () {
                yield* goAsked(run.asked, "go-1");
                yield* run.answer("go-1", "Merge, tag and stage");
                yield* until(
                  () => runLog(runId),
                  (log) => log.includes("waiting for spilnu"),
                );
                yield* Effect.sleep("300 millis");
                expect((yield* forge.model()).merges ?? []).toEqual([]);
                expect((yield* run.status).status).not.toBe("complete");
                yield* Deferred.succeed(free, undefined);
                yield* goAsked(run.asked, "production");
                yield* carried(run, forge, runId, merged);
                return yield* ended(run.status);
              }),
          );
          yield* bin.restore();
          expect((yield* forge.model()).merges?.map((one) => one.sha)).toEqual([head]);
          expect(claimed).toEqual([`claim ${runId}`, `release ${runId}`]);
        }),
      ),
    120_000,
  );
}

for (const name of ["gitlab", "github"] as const) {
  const { mr, url, target } = RELEASING[name];
  const options = (runId: string, ends: Ends = {}) => ({
    entry: shipped("release"),
    runId,
    input: { mr: target },
    host: releaseHost(ends),
  });
  /** Go 1 answered, and the go to production once it is asked. */
  const staged = (run: {
    readonly asked: Parameters<typeof goAsked>[0];
    readonly answer: (decision: string, value: string) => Effect.Effect<void>;
  }) =>
    Effect.gen(function* () {
      yield* goAsked(run.asked, "go-1");
      yield* run.answer("go-1", "Merge, tag and stage");
      return yield* goAsked(run.asked, "production");
    });

  scenario(
    `release on ${name}: an application is merged, tagged and staged, sent to production on go 2, and waited on until production carries it, under the claim`,
    () =>
      runEffect(
        Effect.gen(function* () {
          const { bin, forge, head, merged, now } = yield* stageable(name);
          claimed.length = 0;
          const runId = `r-app-prod-${name}`;
          yield* rig.queueOutputs([APP_ASSESSED, stagedTag(name)]);
          const status = yield* driven(options(runId), (run) =>
            Effect.gen(function* () {
              const go = yield* goAsked(run.asked, "go-1");
              expect(optionsOf([go], "go-1")).toEqual(["Merge, tag and stage", "Finish"]);
              expect(go.prompt).toContain(head.slice(0, 8));
              expect(go.prompt).toContain("stage gets the tag; production waits for a second go");
              expect(claimed).toEqual([]);
              yield* run.answer("go-1", "Merge, tag and stage");
              const production = yield* goAsked(run.asked, "production");
              expect(optionsOf([production], "production")).toEqual([
                "Send to production",
                "Leave production to me",
              ]);
              expect(production.prompt).toContain("v1.2.0");
              expect(production.prompt).toContain(`stage carries \`${merged.slice(0, 8)}\``);
              expect(production.prompt).toContain(waiting(name));
              expect(claimed).toEqual([`claim ${runId}`]);
              expect(yield* wasAsked(runId, "production")).toBe(false);
              const played = yield* now({ environments: deploys(merged, merged) });
              yield* rig.queueOutputs([
                APP_ASSESSED,
                stagedTag(name),
                {
                  writes: [forge.holding(played)],
                  output: { verdict: "clean", played: ["deploy-production"] },
                },
              ]);
              yield* run.answer("production", "Send to production");
              return yield* ended(run.status);
            }),
          );
          const model = yield* forge.model();
          yield* bin.restore();
          expect(outcomeText(status)).toBe(
            `${mr} merged at ${merged}, released as v1.2.0, in production`,
          );
          expect(model.merges?.map((one) => one.sha)).toEqual([head]);
          expect(claimed).toEqual([`claim ${runId}`, `release ${runId}`]);
          expect(yield* clearance(runId, "tag")).toBe(
            `Cleared for this step: a release commit to ${url}'s default branch, where it makes one; pushing an annotated version tag to origin, with no forge release; playing, retrying and watching the tag pipeline's stage deploy and check jobs until only production jobs waiting to be started are left; rolling stage back to the newest release production carries; never a production job.`,
          );
          expect(yield* clearance(runId, "production")).toBe(
            `Cleared for this step: playing ${waiting(name)} on ${url}, and no other job.`,
          );
          expect(yield* asked(runId, "tag")).toContain("`deploy-stage`");
          const other = new RegExp(`\\b${name === "gitlab" ? "gh" : "glab"}\\b`);
          for (const step of ["tag", "production"])
            expect(yield* asked(runId, step)).not.toMatch(other);
          expect(yield* parkedWhy(runId)).toBe("");
        }),
      ),
    120_000,
  );

  scenario(
    `release on ${name}: Leave production to me plays nothing and waits, naming the job, until production carries the merge`,
    () =>
      runEffect(
        Effect.gen(function* () {
          const { bin, forge, merged, now } = yield* stageable(name);
          claimed.length = 0;
          const runId = `r-app-leave-${name}`;
          yield* rig.queueOutputs([APP_ASSESSED, stagedTag(name)]);
          const status = yield* driven(options(runId), (run) =>
            Effect.gen(function* () {
              yield* staged(run);
              yield* run.answer("production", "Leave production to me");
              expect(
                yield* until(
                  () => parkedWhy(runId),
                  (why) => why !== "",
                ),
              ).toBe(
                `Waiting for production: play ${waiting(name)}. The claim on \`project\` is held until the forge shows production carries \`${merged.slice(0, 8)}\`.`,
              );
              expect(claimed).toEqual([`claim ${runId}`]);
              yield* forge.set(yield* now({ environments: deploys(merged, merged) }));
              return yield* ended(run.status);
            }),
          );
          yield* bin.restore();
          expect(outcomeText(status)).toBe(
            `${mr} merged at ${merged}, released as v1.2.0, in production`,
          );
          expect(yield* clearance(runId, "production")).toBe("");
          expect(claimed).toEqual([`claim ${runId}`, `release ${runId}`]);
        }),
      ),
    120_000,
  );

  scenario(
    `release on ${name}: a stage check failing after the merge is rolled back, gives the claim back and fails, asking no go 2`,
    () =>
      runEffect(
        Effect.gen(function* () {
          const { bin, forge, base, merged, model } = yield* stageable(name, {
            "e2e-stage": "failed",
          });
          claimed.length = 0;
          const runId = `r-app-rollback-${name}`;
          yield* rig.queueOutputs([
            APP_ASSESSED,
            stagedTag(name),
            {
              writes: [forge.holding({ ...model, environments: deploys(base, base) })],
              output: { verdict: "clean", stage: "v1.1.0" },
            },
          ]);
          const status = yield* driven(options(runId), (run) =>
            Effect.gen(function* () {
              yield* goAsked(run.asked, "go-1");
              yield* run.answer("go-1", "Merge, tag and stage");
              const end = yield* ended(run.status);
              expect((yield* run.asked).map((row) => row.decision)).not.toContain("production");
              return end;
            }),
          );
          yield* bin.restore();
          expect(outcomeText(status)).toBe(
            `${mr} merged at ${merged}, but stage failed after the merge: \`e2e-stage\` failed on v1.2.0's pipeline at ${PIPELINE_OF[name]}. Stage is back on what production carries, nothing went to production, and the merge stands: the fix is a new merge request`,
          );
          expect(yield* asked(runId, "rollback")).toContain("`e2e-stage` failed");
          expect(yield* clearance(runId, "rollback")).toBe(
            `Cleared for this step: rolling ${url}'s stage back to the newest release production carries, never a production job.`,
          );
          expect(claimed).toEqual([`claim ${runId}`, `release ${runId}`]);
        }),
      ),
    120_000,
  );

  scenario(
    `release on ${name}: a rollback the forge cannot show fails the Run, keeps the claim and offers Release again`,
    () =>
      runEffect(
        Effect.gen(function* () {
          const { bin, merged } = yield* stageable(name, { "e2e-stage": "failed" });
          claimed.length = 0;
          const runId = `r-app-unshown-${name}`;
          yield* rig.queueOutputs([
            APP_ASSESSED,
            stagedTag(name),
            { verdict: "clean", stage: "v1.1.0" },
          ]);
          const status = yield* driven(options(runId), (run) =>
            Effect.gen(function* () {
              yield* goAsked(run.asked, "go-1");
              yield* run.answer("go-1", "Merge, tag and stage");
              return yield* ended(run.status);
            }),
          );
          yield* bin.restore();
          expect(outcomeText(status)).toBe(
            `${mr} merged at ${merged}, but stage failed after the merge: \`e2e-stage\` failed on v1.2.0's pipeline at ${PIPELINE_OF[name]}. Its rollback is not shown: stage still carries ${merged.slice(0, 8)}`,
          );
          expect(claimed).toEqual([`claim ${runId}`]);
          expect(yield* releaseAgainOffered(target)).toBe(true);
        }),
      ),
    120_000,
  );

  scenario(
    `release on ${name}: a failed job of the tag's pipeline fails the read-back, keeps the claim and asks no go 2`,
    () =>
      runEffect(
        Effect.gen(function* () {
          const { bin, merged } = yield* stageable(name, { build: "failed" });
          claimed.length = 0;
          const runId = `r-app-failed-${name}`;
          yield* rig.queueOutputs([APP_ASSESSED, stagedTag(name)]);
          const status = yield* driven(options(runId), (run) =>
            Effect.gen(function* () {
              yield* goAsked(run.asked, "go-1");
              yield* run.answer("go-1", "Merge, tag and stage");
              return yield* ended(run.status);
            }),
          );
          yield* bin.restore();
          expect(outcomeText(status)).toBe(
            `${mr} merged at ${merged}, but v1.2.0 is not ready for production: \`build\` failed on v1.2.0's pipeline at ${PIPELINE_OF[name]}`,
          );
          expect(yield* clearance(runId, "rollback")).toBe("");
          expect(claimed).toEqual([`claim ${runId}`]);
        }),
      ),
    120_000,
  );

  scenario(
    `release on ${name}: Send to production after somebody already played the job plays nothing twice, and waits`,
    () =>
      runEffect(
        Effect.gen(function* () {
          const { bin, forge, merged, now, model } = yield* stageable(name);
          claimed.length = 0;
          const runId = `r-app-played-${name}`;
          yield* rig.queueOutputs([APP_ASSESSED, stagedTag(name)]);
          const status = yield* driven(options(runId), (run) =>
            Effect.gen(function* () {
              yield* staged(run);
              const started = model.runs!["7"]!.jobs!.map((job) =>
                job.name === "deploy-production" ? { ...job, state: "running" as const } : job,
              );
              yield* forge.set(
                yield* now({
                  runs: { "7": { ...tagRun(merged), status: "running", jobs: started } },
                }),
              );
              yield* run.answer("production", "Send to production");
              yield* until(
                () => awaitingOn(runId),
                (on) => on !== "",
              );
              yield* forge.set(yield* now({ environments: deploys(merged, merged) }));
              return yield* ended(run.status);
            }),
          );
          yield* bin.restore();
          expect(outcomeText(status)).toBe(
            `${mr} merged at ${merged}, released as v1.2.0, in production`,
          );
          expect(yield* clearance(runId, "production")).toBe("");
          expect(claimed).toEqual([`claim ${runId}`, `release ${runId}`]);
        }),
      ),
    120_000,
  );

  scenario(
    `release on ${name}: Send to production after the tag moved plays nothing, fails and keeps the claim`,
    () =>
      runEffect(
        Effect.gen(function* () {
          const { bin, base, merged } = yield* stageable(name);
          claimed.length = 0;
          const runId = `r-app-moved-${name}`;
          yield* rig.queueOutputs([APP_ASSESSED, stagedTag(name)]);
          const status = yield* driven(options(runId), (run) =>
            Effect.gen(function* () {
              yield* staged(run);
              yield* exec(["git", "tag", "-fa", "v1.2.0", "-m", "moved", base], {
                cwd: rig.projectDir,
              });
              yield* exec(["git", "push", "-qf", "origin", "v1.2.0"], { cwd: rig.projectDir });
              yield* run.answer("production", "Send to production");
              return yield* ended(run.status);
            }),
          );
          yield* bin.restore();
          expect(outcomeText(status)).toBe(
            `${mr} merged at ${merged} and tagged v1.2.0, but nothing was sent to production: v1.2.0 on origin does not carry the merged commit ${merged.slice(0, 8)}`,
          );
          expect(yield* clearance(runId, "production")).toBe("");
          expect(claimed).toEqual([`claim ${runId}`]);
        }),
      ),
    120_000,
  );

  scenario(
    `release on ${name}: Release again after a failure past the merge asks go 2 afresh, and succeeds once production carries the merge`,
    () =>
      runEffect(
        Effect.gen(function* () {
          const { bin, forge, merged, now } = yield* stageable(name, { build: "failed" });
          claimed.length = 0;
          const first = `r-app-first-${name}`;
          const again = `r-app-again-${name}`;
          yield* rig.queueOutputs([APP_ASSESSED, stagedTag(name), APP_ASSESSED, stagedTag(name)]);
          const failure = outcomeText(
            yield* driven(options(first), (run) =>
              Effect.gen(function* () {
                yield* goAsked(run.asked, "go-1");
                yield* run.answer("go-1", "Merge, tag and stage");
                return yield* ended(run.status);
              }),
            ),
          );
          expect(claimed).toEqual([`claim ${first}`]);
          const fixed = TAG_JOBS.map((job) => ({
            name: job,
            state: job === "deploy-production" ? ("manual" as const) : ("passed" as const),
          }));
          yield* forge.set(
            yield* now({ runs: { "7": { ...tagRun(merged), status: "manual", jobs: fixed } } }),
          );
          const status = yield* driven(
            options(again, { [first]: { succeeded: false, failure } }),
            (run) =>
              Effect.gen(function* () {
                yield* goAsked(run.asked, "production");
                expect((yield* run.asked).map((row) => row.decision)).not.toContain("go-1");
                yield* run.answer("production", "Leave production to me");
                yield* until(
                  () => parkedWhy(again),
                  (why) => why !== "",
                );
                yield* forge.set(yield* now({ environments: deploys(merged, merged) }));
                return yield* ended(run.status);
              }),
          );
          const model = yield* forge.model();
          yield* bin.restore();
          expect(outcomeText(status)).toBe(
            `${mr} merged at ${merged}, released as v1.2.0, in production`,
          );
          expect(model.merges ?? []).toHaveLength(1);
          expect(claimed).toEqual([`claim ${first}`, `claim ${again}`, `release ${again}`]);
          expect(yield* asked(again, "tag")).toContain(
            `recovers the release of ${mr} that ${first} merged`,
          );
        }),
      ),
    120_000,
  );

  scenario(
    `release on ${name}: Release again where production already carries the merge asks nothing and ends at once`,
    () =>
      runEffect(
        Effect.gen(function* () {
          const { bin, forge, merged, now } = yield* stageable(name, { build: "failed" });
          claimed.length = 0;
          const first = `r-app-live-first-${name}`;
          const again = `r-app-live-again-${name}`;
          yield* rig.queueOutputs([APP_ASSESSED, stagedTag(name), APP_ASSESSED, stagedTag(name)]);
          const failure = outcomeText(
            yield* driven(options(first), (run) =>
              Effect.gen(function* () {
                yield* goAsked(run.asked, "go-1");
                yield* run.answer("go-1", "Merge, tag and stage");
                return yield* ended(run.status);
              }),
            ),
          );
          yield* forge.set(yield* now({ environments: deploys(merged, merged) }));
          const result = yield* ran(options(again, { [first]: { succeeded: false, failure } }));
          yield* bin.restore();
          expect(said(result)).toBe(`${mr} merged at ${merged}, released as v1.2.0, in production`);
          expect(claimed).toEqual([`claim ${first}`, `claim ${again}`, `release ${again}`]);
        }),
      ),
    120_000,
  );

  scenario(
    `release on ${name}: a Hold during the production wait suspends the Run`,
    () =>
      runEffect(
        Effect.gen(function* () {
          const { bin } = yield* stageable(name);
          claimed.length = 0;
          const runId = `r-app-held-${name}`;
          yield* rig.queueOutputs([APP_ASSESSED, stagedTag(name)]);
          const status = yield* driven(options(runId), (run) =>
            Effect.gen(function* () {
              yield* staged(run);
              yield* run.answer("production", "Leave production to me");
              yield* until(
                () => parkedWhy(runId),
                (why) => why !== "",
              );
              const fs = yield* FileSystem.FileSystem;
              yield* fs.writeFileString(controlPath(dir, HOLD, runId), "").pipe(Effect.orDie);
              return yield* until(
                () => Effect.map(run.status, (got) => got.status),
                (got) => got === "suspended",
              );
            }),
          );
          yield* bin.restore();
          expect(status).toBe("suspended");
          expect(yield* parkedWhy(runId)).toBe("");
          expect(claimed).toEqual([`claim ${runId}`]);
        }),
      ),
    120_000,
  );
}

/** An application's assessment, naming the stage deploys of a merge request's pipeline and a tag's. */
const assessedWith = (mergeRequest: ReadonlyArray<string>, tag: ReadonlyArray<string>) => ({
  ...APP_ASSESSED,
  stage_jobs: { merge_request: [...mergeRequest], tag: [...tag] },
});
const MR_STAGED = assessedWith(["deploy-stage"], []);

/** The jobs of the merge request's own pipeline, numbered as each forge's job read numbers them. */
const MR_JOBS = ["build", "deploy-stage", "e2e-stage"] as const;
type MrJob = (typeof MR_JOBS)[number];

const mrJob = (name: MrForge, job: MrJob) => {
  const id = MR_JOBS.indexOf(job) + 1;
  return name === "gitlab"
    ? `https://${PROJECT.gitlab}/-/jobs/${id}`
    : `https://github.com/owner/repo/actions/runs/4030/job/${id}`;
};

/** What the stage step says it played and checked, which nothing takes for proof. */
const STAGED_MR = { verdict: "clean", stage_jobs: ["deploy-stage", "e2e-stage"] };

/** What the tag step of an application tested on stage says it did. */
const testedTag = (name: MrForge) => ({
  ...TAGGED,
  pipeline_url: PIPELINE_OF[name],
  production_jobs: [{ name: "deploy-production", url: `${RELEASING[name].url}/said-by-the-agent` }],
});

const UNSTAGED = { verdict: "clean", stage: "v1.1.0" };
const DISPUTED_FIX = { verdict: "clean", fixed: [], disputed: [] };

for (const name of ["gitlab", "github"] as const) {
  const { mr, url, target } = RELEASING[name];
  const options = (runId: string, ends: Ends = {}) => ({
    entry: shipped("release"),
    runId,
    input: { mr: target },
    host: releaseHost(ends),
  });

  /**
   * An application whose merge request's pipeline stages it, ready: its stage jobs at
   * `states`, its tag pipeline held by a production job nobody started, and stage and
   * production on the commit the merge is made on. `staging` is the stage step's stand-in,
   * which leaves stage on the merge request's head.
   */
  const testable = (states: Partial<Record<MrJob, "passed" | "failed" | "skipped">> = {}) =>
    Effect.gen(function* () {
      const made = yield* stageable(name);
      const jobs = {
        build: "passed",
        "deploy-stage": "passed",
        "e2e-stage": "passed",
        ...states,
      } as const;
      const model: ForgeModel = {
        ...made.model,
        environments: deploys(made.base, made.base),
        mrs: made.model.mrs.map((one) => ({
          ...one,
          jobs: MR_JOBS.map((job) => ({ name: job, state: jobs[job] })),
        })),
      };
      yield* made.forge.set(model);
      const onStage = { ...model, environments: deploys(made.head, made.base) };
      const staging = { writes: [made.forge.holding(onStage)], output: STAGED_MR };
      const unstaging = { writes: [made.forge.holding(model)], output: UNSTAGED };
      return { ...made, model, onStage, staging, unstaging };
    });

  /** Go 1 answered with staging, and the production go once it is asked. */
  const tested = (run: {
    readonly asked: Parameters<typeof goAsked>[0];
    readonly answer: (decision: string, value: string) => Effect.Effect<void>;
  }) =>
    Effect.gen(function* () {
      yield* goAsked(run.asked, "go-1");
      yield* run.answer("go-1", "Stage the merge request");
      return yield* goAsked(run.asked, "production");
    });

  const stageJobs = `\`deploy-stage\` at ${mrJob(name, "deploy-stage")}, \`e2e-stage\` at ${mrJob(name, "e2e-stage")}`;

  scenario(
    `release on ${name}: an application staged from its merge request is merged at the tested head, tagged and sent to production on one go, under the claim`,
    () =>
      runEffect(
        Effect.gen(function* () {
          const { bin, forge, head, merged, now, staging } = yield* testable();
          claimed.length = 0;
          const runId = `r-tested-prod-${name}`;
          yield* rig.queueOutputs([
            MR_STAGED,
            staging,
            testedTag(name),
            { verdict: "clean", played: ["deploy-production"] },
          ]);
          const status = yield* driven(options(runId), (run) =>
            Effect.gen(function* () {
              const go = yield* goAsked(run.asked, "go-1");
              expect(optionsOf([go], "go-1")).toEqual(["Stage the merge request", "Finish"]);
              expect(go.prompt).toContain("deploys that head to stage for you to test, unmerged");
              yield* run.answer("go-1", "Stage the merge request");
              const production = yield* goAsked(run.asked, "production");
              expect(optionsOf([production], "production")).toEqual([
                "Send to production",
                "Leave production to me",
                "Finish",
              ]);
              expect(production.prompt).toContain(mr);
              expect(production.prompt).toContain(head.slice(0, 8));
              expect(production.prompt).toContain(stageJobs);
              expect(production.prompt).toContain("for testing, unmerged");
              expect(production.prompt).toContain(
                "Send to production merges it at that head, tags it and plays production with no further question",
              );
              expect((yield* forge.model()).merges ?? []).toEqual([]);
              expect(claimed).toEqual([`claim ${runId}`]);
              yield* run.answer("production", "Send to production");
              yield* until(
                () => awaitingOn(runId),
                (on) => on !== "",
              );
              yield* forge.set(yield* now({ environments: deploys(head, merged) }));
              const end = yield* ended(run.status);
              expect(
                (yield* run.asked).filter((row) => row.decision.startsWith("production")),
              ).toHaveLength(1);
              return end;
            }),
          );
          const model = yield* forge.model();
          yield* bin.restore();
          expect(outcomeText(status)).toBe(
            `${mr} merged at ${merged}, released as v1.2.0, in production`,
          );
          expect(model.merges?.map((one) => one.sha)).toEqual([head]);
          expect(claimed).toEqual([`claim ${runId}`, `release ${runId}`]);
          expect(yield* clearance(runId, "stage")).toBe(
            `Cleared for this step: playing, retrying and watching ${url}'s stage deploy job and stage check jobs (e2e-stage, smoke or the like) of the merge request's pipeline; rolling ${url}'s stage back to the newest release production carries; never a production job.`,
          );
          expect(yield* asked(runId, "stage")).toContain("`deploy-stage`");
          expect(yield* clearance(runId, "production")).toBe(
            `Cleared for this step: playing ${waiting(name)} on ${url}, and no other job.`,
          );
          const other = new RegExp(`\\b${name === "gitlab" ? "gh" : "glab"}\\b`);
          for (const step of ["stage", "tag"]) expect(yield* asked(runId, step)).not.toMatch(other);
          expect(yield* asked(runId, "tag")).toContain(`merged commit is \`${merged}\``);
        }),
      ),
    120_000,
  );

  scenario(
    `release on ${name}: Leave production to me after staging the merge request merges and tags, plays nothing and waits`,
    () =>
      runEffect(
        Effect.gen(function* () {
          const { bin, forge, head, merged, now, staging } = yield* testable();
          claimed.length = 0;
          const runId = `r-tested-leave-${name}`;
          yield* rig.queueOutputs([MR_STAGED, staging, testedTag(name)]);
          const status = yield* driven(options(runId), (run) =>
            Effect.gen(function* () {
              yield* tested(run);
              yield* run.answer("production", "Leave production to me");
              expect(
                yield* until(
                  () => parkedWhy(runId),
                  (why) => why !== "",
                ),
              ).toContain(`play ${waiting(name)}`);
              expect(claimed).toEqual([`claim ${runId}`]);
              yield* forge.set(yield* now({ environments: deploys(head, merged) }));
              return yield* ended(run.status);
            }),
          );
          const model = yield* forge.model();
          yield* bin.restore();
          expect(outcomeText(status)).toBe(
            `${mr} merged at ${merged}, released as v1.2.0, in production`,
          );
          expect(model.merges?.map((one) => one.sha)).toEqual([head]);
          expect(yield* clearance(runId, "production")).toBe("");
          expect(claimed).toEqual([`claim ${runId}`, `release ${runId}`]);
        }),
      ),
    120_000,
  );

  scenario(
    `release on ${name}: Finish after staging the merge request merges nothing, rolls stage back and gives the claim back`,
    () =>
      runEffect(
        Effect.gen(function* () {
          const { bin, forge, staging, unstaging } = yield* testable();
          claimed.length = 0;
          const runId = `r-tested-finish-${name}`;
          yield* rig.queueOutputs([MR_STAGED, staging, unstaging]);
          const status = yield* driven(options(runId), (run) =>
            Effect.gen(function* () {
              yield* tested(run);
              yield* run.answer("production", "Finish");
              return yield* ended(run.status);
            }),
          );
          const model = yield* forge.model();
          yield* bin.restore();
          expect(outcomeText(status)).toBe(`${mr} was left open, and stage rolled back`);
          expect(model.merges ?? []).toEqual([]);
          expect(claimed).toEqual([`claim ${runId}`, `release ${runId}`]);
          expect(yield* clearance(runId, "unstage")).toBe(
            `Cleared for this step: rolling ${url}'s stage back to the newest release production carries, never a production job.`,
          );
        }),
      ),
    120_000,
  );

  scenario(
    `release on ${name}: a comment while the human tests merges nothing on the go, rolls stage back, gives the claim back and runs its round`,
    () =>
      runEffect(
        Effect.gen(function* () {
          const { bin, forge, head, model: ready, staging } = yield* testable();
          claimed.length = 0;
          const runId = `r-tested-comment-${name}`;
          const late = { id: 95, author: "bob", at: "2026-10-20T11:00:00Z", body: "wait" };
          const commented = (on: ForgeModel) => ({
            ...on,
            mrs: on.mrs.map((one) => ({ ...one, comments: [late] })),
          });
          yield* rig.queueOutputs([
            MR_STAGED,
            staging,
            { writes: [forge.holding(commented(ready))], output: UNSTAGED },
            { verdict: "clean", answers: [{ id: "95", answer: "disputed", note: "as meant" }] },
          ]);
          const status = yield* driven(options(runId), (run) =>
            Effect.gen(function* () {
              yield* tested(run);
              yield* forge.set(commented(yield* forge.model()));
              yield* run.answer("production", "Send to production");
              yield* goAsked(run.asked, "go-2");
              yield* run.answer("go-2", "Finish");
              return yield* ended(run.status);
            }),
          );
          const model = yield* forge.model();
          yield* bin.restore();
          expect(outcomeText(status)).toBe(`${mr} was left open`);
          expect(model.merges ?? []).toEqual([]);
          expect(claimed).toEqual([`claim ${runId}`, `release ${runId}`]);
          expect(repliesOf(model)).toHaveLength(1);
          expect(yield* runLog(runId)).toContain(
            `the production go no longer holds for ${head.slice(0, 8)}: 1 unanswered comment(s)`,
          );
        }),
      ),
    120_000,
  );

  scenario(
    `release on ${name}: a production go given while the head's pipeline still runs waits it out, then merges and sends to production`,
    () =>
      runEffect(
        Effect.gen(function* () {
          const { bin, forge, head, merged, now, staging } = yield* testable();
          claimed.length = 0;
          const runId = `r-tested-ci-${name}`;
          yield* rig.queueOutputs([
            MR_STAGED,
            staging,
            testedTag(name),
            { verdict: "clean", played: ["deploy-production"] },
          ]);
          const pipeline = (over: Partial<FakeMr>) =>
            Effect.flatMap(forge.model(), (current) =>
              forge.set({ ...current, mrs: current.mrs.map((one) => ({ ...one, ...over })) }),
            );
          const status = yield* driven(options(runId), (run) =>
            Effect.gen(function* () {
              yield* tested(run);
              yield* pipeline(STILL_RUNNING);
              yield* run.answer("production", "Send to production");
              const [, unstaged] = yield* until(
                () => Effect.all([awaitingOn(runId), wasAsked(runId, "unstage")]),
                ([on, unstaged]) => on.startsWith("CI") || unstaged,
              );
              expect(unstaged).toBe(false);
              yield* pipeline(PIPELINE_PASSED);
              yield* until(
                () => awaitingOn(runId),
                (on) => on !== "" && !on.startsWith("CI"),
              );
              yield* forge.set(yield* now({ environments: deploys(head, merged) }));
              return yield* ended(run.status);
            }),
          );
          const model = yield* forge.model();
          yield* bin.restore();
          expect(outcomeText(status)).toBe(
            `${mr} merged at ${merged}, released as v1.2.0, in production`,
          );
          expect(model.merges?.map((one) => one.sha)).toEqual([head]);
          expect(claimed).toEqual([`claim ${runId}`, `release ${runId}`]);
        }),
      ),
    120_000,
  );

  scenario(
    `release on ${name}: a stage job that did not pass at the go's head merges nothing, is rolled back, gives the claim back, runs a fix round and asks go 1 again`,
    () =>
      runEffect(
        Effect.gen(function* () {
          const { bin, forge, head, staging, unstaging } = yield* testable({
            "e2e-stage": "failed",
          });
          claimed.length = 0;
          const runId = `r-tested-failed-${name}`;
          yield* rig.queueOutputs([MR_STAGED, staging, unstaging, DISPUTED_FIX]);
          const status = yield* driven(options(runId), (run) =>
            Effect.gen(function* () {
              yield* goAsked(run.asked, "go-1");
              yield* run.answer("go-1", "Stage the merge request");
              yield* goAsked(run.asked, "go-2");
              expect((yield* run.asked).map((row) => row.decision)).not.toContain("production");
              yield* run.answer("go-2", "Finish");
              return yield* ended(run.status);
            }),
          );
          const model = yield* forge.model();
          yield* bin.restore();
          expect(outcomeText(status)).toBe(`${mr} was left open`);
          expect(model.merges ?? []).toEqual([]);
          expect(claimed).toEqual([`claim ${runId}`, `release ${runId}`]);
          const why = `\`e2e-stage\` has not passed on the merge request's pipeline at ${head.slice(0, 8)}: it is failed`;
          expect(yield* asked(runId, "unstage")).toContain(why);
          expect(yield* asked(runId, "fix-1")).toContain(why);
        }),
      ),
    120_000,
  );

  scenario(
    `release on ${name}: a stage that does not carry the go's head merges nothing, and the fix round is asked about it`,
    () =>
      runEffect(
        Effect.gen(function* () {
          const { bin, forge, head } = yield* testable();
          claimed.length = 0;
          const runId = `r-tested-uncarried-${name}`;
          yield* rig.queueOutputs([MR_STAGED, STAGED_MR, UNSTAGED, DISPUTED_FIX]);
          const status = yield* driven(options(runId), (run) =>
            Effect.gen(function* () {
              yield* goAsked(run.asked, "go-1");
              yield* run.answer("go-1", "Stage the merge request");
              yield* goAsked(run.asked, "go-2");
              yield* run.answer("go-2", "Finish");
              return yield* ended(run.status);
            }),
          );
          const model = yield* forge.model();
          yield* bin.restore();
          expect(outcomeText(status)).toBe(`${mr} was left open`);
          expect(model.merges ?? []).toEqual([]);
          expect(claimed).toEqual([`claim ${runId}`, `release ${runId}`]);
          expect(yield* asked(runId, "fix-1")).toContain(
            `stage does not carry ${head.slice(0, 8)}`,
          );
        }),
      ),
    120_000,
  );

  scenario(
    `release on ${name}: a staged merge request's rollback the forge cannot show fails the Run, keeps the claim and offers Release again`,
    () =>
      runEffect(
        Effect.gen(function* () {
          const { bin, forge, head, staging } = yield* testable({ "e2e-stage": "failed" });
          claimed.length = 0;
          const runId = `r-tested-unshown-${name}`;
          yield* rig.queueOutputs([MR_STAGED, staging, UNSTAGED]);
          const status = yield* driven(options(runId), (run) =>
            Effect.gen(function* () {
              yield* goAsked(run.asked, "go-1");
              yield* run.answer("go-1", "Stage the merge request");
              return yield* ended(run.status);
            }),
          );
          const model = yield* forge.model();
          yield* bin.restore();
          expect(outcomeText(status)).toBe(
            `stage of ${mr} at ${head.slice(0, 8)} failed: \`e2e-stage\` has not passed on the merge request's pipeline at ${head.slice(0, 8)}: it is failed. Its rollback is not shown: stage still carries ${head.slice(0, 8)} in \`stage\``,
          );
          expect(model.merges ?? []).toEqual([]);
          expect(claimed).toEqual([`claim ${runId}`]);
          expect(yield* releaseAgainOffered(target)).toBe(true);
        }),
      ),
    120_000,
  );

  const MONOREPO_JOBS = ["build", "deploy-stage-spilnu", "deploy-stage-happytiger"] as const;
  const monorepoJob = (job: (typeof MONOREPO_JOBS)[number]) => {
    const id = MONOREPO_JOBS.indexOf(job) + 1;
    return name === "gitlab"
      ? `https://${PROJECT.gitlab}/-/jobs/${id}`
      : `https://github.com/owner/repo/actions/runs/4030/job/${id}`;
  };
  const MONOREPO_STAGED = {
    ...MONOREPO_ASSESSED,
    stage_jobs: { merge_request: ["deploy-stage-spilnu", "deploy-stage-happytiger"], tag: [] },
  };
  const live = (sha: string) => ({ sha, status: "success" as const });

  /**
   * A monorepo's merge request, ready, whose pipeline deploys `stage-spilnu` and
   * `stage-happytiger`, both on the commit production carries. `stage-web`, which its pipeline
   * never deploys to, is on a commit of its own and is listed first, as the newest deployment.
   * `onStage` is the forge once the stage step deployed the head to both and `happytiger`'s
   * deployments followed.
   */
  const perEnvironment = Effect.gen(function* () {
    const made = yield* stageable(name);
    type Deployments = ReadonlyArray<{
      readonly sha: string;
      readonly status: "success" | "failed";
    }>;
    const environments = (spilnu: Deployments, happytiger: Deployments) => [
      { name: "stage-web", tier: "staging", deployments: [live("web-only")] },
      { name: "stage-spilnu", tier: "staging", job: "deploy-stage-spilnu", deployments: spilnu },
      {
        name: "stage-happytiger",
        tier: "staging",
        job: "deploy-stage-happytiger",
        deployments: happytiger,
      },
      { name: "production", tier: "production", deployments: [live(made.base)] },
    ];
    const model: ForgeModel = {
      ...made.model,
      environments: environments([live(made.base)], [live(made.base)]),
      mrs: made.model.mrs.map((one) => ({
        ...one,
        jobs: MONOREPO_JOBS.map((job) => ({ name: job, state: "passed" as const })),
      })),
    };
    yield* made.forge.set(model);
    const staged = [live(made.head), live(made.base)];
    const onStage = (happytiger: Deployments): ForgeModel => ({
      ...model,
      environments: environments(staged, happytiger),
    });
    const rolledBack = (happytiger: Deployments): ForgeModel => ({
      ...model,
      environments: environments([live(made.base), ...staged], happytiger),
    });
    return { ...made, model, staged, onStage, rolledBack };
  });
  const MONOREPO_STAGE = { verdict: "clean", stage_jobs: [] };
  const monorepoJobs = `\`deploy-stage-spilnu\` at ${monorepoJob("deploy-stage-spilnu")}, \`deploy-stage-happytiger\` at ${monorepoJob("deploy-stage-happytiger")}`;

  scenario(
    `release on ${name}: per environment, a merge request staged on only one of its two stage environments merges nothing, and the fix round names the other`,
    () =>
      runEffect(
        Effect.gen(function* () {
          const { bin, forge, head, base, onStage, rolledBack } = yield* perEnvironment;
          claimed.length = 0;
          const runId = `r-env-one-${name}`;
          const happytiger = [{ sha: head, status: "failed" as const }, live(base)];
          yield* rig.queueOutputs([
            MONOREPO_STAGED,
            { writes: [forge.holding(onStage(happytiger))], output: MONOREPO_STAGE },
            { writes: [forge.holding(rolledBack(happytiger))], output: UNSTAGED },
            DISPUTED_FIX,
          ]);
          const status = yield* driven(options(runId), (run) =>
            Effect.gen(function* () {
              yield* goAsked(run.asked, "go-1");
              yield* run.answer("go-1", "Stage the merge request");
              yield* goAsked(run.asked, "go-2");
              expect((yield* run.asked).map((row) => row.decision)).not.toContain("production");
              yield* run.answer("go-2", "Finish");
              return yield* ended(run.status);
            }),
          );
          const model = yield* forge.model();
          yield* bin.restore();
          expect(outcomeText(status)).toBe(`${mr} was left open`);
          expect(model.merges ?? []).toEqual([]);
          expect(claimed).toEqual([`claim ${runId}`, `release ${runId}`]);
          const finding = yield* asked(runId, "fix-1");
          expect(finding).toContain(
            `stage does not carry ${head.slice(0, 8)} in \`stage-happytiger\``,
          );
          expect(finding).not.toContain("`stage-spilnu`");
        }),
      ),
    120_000,
  );

  scenario(
    `release on ${name}: per environment, a merge request on both its stage environments asks the production go naming both stage jobs, whatever another environment carries`,
    () =>
      runEffect(
        Effect.gen(function* () {
          const { bin, forge, head, base, staged, onStage, rolledBack } = yield* perEnvironment;
          claimed.length = 0;
          const runId = `r-env-both-${name}`;
          yield* rig.queueOutputs([
            MONOREPO_STAGED,
            { writes: [forge.holding(onStage(staged))], output: MONOREPO_STAGE },
            { writes: [forge.holding(rolledBack([live(base), ...staged]))], output: UNSTAGED },
          ]);
          const prompt = yield* driven(options(runId), (run) =>
            Effect.gen(function* () {
              const production = yield* tested(run);
              yield* run.answer("production", "Finish");
              yield* ended(run.status);
              return production.prompt;
            }),
          );
          yield* bin.restore();
          expect(prompt).toContain(head.slice(0, 8));
          expect(prompt).toContain(monorepoJobs);
        }),
      ),
    120_000,
  );

  scenario(
    `release on ${name}: per environment, Finish rolls back only the stage environments the head reached, whatever another environment carries`,
    () =>
      runEffect(
        Effect.gen(function* () {
          const { bin, forge, staged, onStage, rolledBack, base } = yield* perEnvironment;
          claimed.length = 0;
          const runId = `r-env-finish-${name}`;
          yield* rig.queueOutputs([
            MONOREPO_STAGED,
            { writes: [forge.holding(onStage(staged))], output: MONOREPO_STAGE },
            { writes: [forge.holding(rolledBack([live(base), ...staged]))], output: UNSTAGED },
          ]);
          const status = yield* driven(options(runId), (run) =>
            Effect.gen(function* () {
              yield* tested(run);
              yield* run.answer("production", "Finish");
              return yield* ended(run.status);
            }),
          );
          yield* bin.restore();
          expect(outcomeText(status)).toBe(`${mr} was left open, and stage rolled back`);
          expect(claimed).toEqual([`claim ${runId}`, `release ${runId}`]);
        }),
      ),
    120_000,
  );

  scenario(
    `release on ${name}: per environment, a rollback that leaves one stage environment on the head fails the Run naming it, keeps the claim and offers Release again`,
    () =>
      runEffect(
        Effect.gen(function* () {
          const { bin, forge, head, staged, onStage, rolledBack } = yield* perEnvironment;
          claimed.length = 0;
          const runId = `r-env-partial-${name}`;
          yield* rig.queueOutputs([
            MONOREPO_STAGED,
            { writes: [forge.holding(onStage(staged))], output: MONOREPO_STAGE },
            { writes: [forge.holding(rolledBack(staged))], output: UNSTAGED },
          ]);
          const status = yield* driven(options(runId), (run) =>
            Effect.gen(function* () {
              yield* tested(run);
              yield* run.answer("production", "Finish");
              return yield* ended(run.status);
            }),
          );
          const model = yield* forge.model();
          yield* bin.restore();
          expect(outcomeText(status)).toBe(
            `${mr} was left open, but stage was not rolled back. Its rollback is not shown: stage still carries ${head.slice(0, 8)} in \`stage-happytiger\``,
          );
          expect(model.merges ?? []).toEqual([]);
          expect(claimed).toEqual([`claim ${runId}`]);
          expect(yield* releaseAgainOffered(target)).toBe(true);
        }),
      ),
    120_000,
  );

  scenario(
    `release on ${name}: attribution proves every old-head environment off before returning a claim after a move during staging`,
    () =>
      runEffect(
        Effect.gen(function* () {
          const { bin, forge, head, staged, onStage, rolledBack } = yield* perEnvironment;
          claimed.length = 0;
          const runId = `r-release-moved-env-${name}`;
          const later = yield* pushedBySomebody(head);
          const changed = (model: ForgeModel): ForgeModel => ({
            ...model,
            mrs: model.mrs.map((mr) => ({ ...mr, head: later })),
            checksAt: { [head]: model.mrs[0]?.jobs ?? [] },
            environments: model.environments?.filter((env) => env.name !== "stage-web"),
          });
          yield* rig.queueOutputs([
            MONOREPO_STAGED,
            { writes: [forge.holding(changed(onStage(staged)))], output: MONOREPO_STAGE },
            { writes: [forge.holding(changed(rolledBack(staged)))], output: UNSTAGED },
          ]);
          const status = yield* driven(options(runId), (run) =>
            Effect.gen(function* () {
              yield* goAsked(run.asked, "go-1");
              yield* run.answer("go-1", "Stage the merge request");
              const status = yield* until(
                () => Effect.all([run.status, run.asked]),
                ([status, asked]) =>
                  status.status === "failed" || asked.some((q) => q.decision === "go-2"),
              );
              expect(status[0].status).toBe("failed");
              return status[0];
            }),
          );
          yield* bin.restore();
          expect(outcomeText(status)).toContain(
            `stage still carries ${head.slice(0, 8)} in \`stage-happytiger\``,
          );
          expect(claimed).toEqual([`claim ${runId}`]);
        }),
      ),
    120_000,
  );

  scenario(
    `release on ${name}: go 1 offers only the staging the assessment found, and an application with neither fails before any wait`,
    () =>
      runEffect(
        Effect.gen(function* () {
          const { bin } = yield* testable();
          claimed.length = 0;
          yield* rig.queueOutputs([
            assessedWith(["deploy-stage"], ["deploy-stage"]),
            assessedWith([], ["deploy-stage"]),
            assessedWith(["deploy-stage"], []),
            assessedWith([], []),
          ]);
          const offered = (runId: string) =>
            driven(options(runId), (run) =>
              Effect.gen(function* () {
                const go = yield* goAsked(run.asked, "go-1");
                yield* run.answer("go-1", "Finish");
                yield* ended(run.status);
                return optionsOf([go], "go-1");
              }),
            );
          expect(yield* offered(`r-offer-both-${name}`)).toEqual([
            "Stage the merge request",
            "Merge, tag and stage",
            "Finish",
          ]);
          expect(yield* offered(`r-offer-tag-${name}`)).toEqual(["Merge, tag and stage", "Finish"]);
          expect(yield* offered(`r-offer-mr-${name}`)).toEqual([
            "Stage the merge request",
            "Finish",
          ]);
          const neither = yield* ran(options(`r-offer-none-${name}`));
          yield* bin.restore();
          expect(reasonOf(neither)).toBe(
            `${mr} is an application with no stage deploy that Collie can prove, on its merge request's pipeline or its tags', so nothing was released: a stage and a production environment`,
          );
          expect(claimed).toEqual([]);
        }),
      ),
    120_000,
  );
}

/** The tags on origin, which a Stage Run never pushes. */
const originTags = () =>
  exec(["git", "ls-remote", "--tags", "origin"], { cwd: rig.projectDir }).pipe(
    Effect.map((ran) => ran.stdout.trim()),
  );

for (const name of ["gitlab", "github"] as const) {
  const { mr, url, target } = RELEASING[name];
  const options = (runId: string, host = releaseHost()) => ({
    entry: shipped("stage"),
    runId,
    input: { mr: target },
    host,
  });
  const stageJobs = `\`deploy-stage\` at ${mrJob(name, "deploy-stage")}, \`e2e-stage\` at ${mrJob(name, "e2e-stage")}`;
  const unresolved = {
    id: 90,
    author: "bob",
    at: "2026-10-20T11:00:00Z",
    body: "why this?",
    thread: name === "gitlab" ? "t-90" : "90",
    file: "src/app.ts",
    line: 3,
  };

  /**
   * An application's open merge request, approved by nobody, with an unresolved thread and
   * its stage check at `e2e`, its head untagged, and stage and production on the commit the
   * merge request starts from. `staging` is the stage step's stand-in, which leaves stage on
   * `head` with every stage job passed; `unstaging` puts stage back.
   */
  const stageOn = (e2e: "running" | "failed" = "running", over: Partial<FakeMr> = {}) =>
    Effect.gen(function* () {
      const made = yield* releasable(
        name,
        { ...UNAPPROVED[name], comments: [unresolved], ...over },
        false,
      );
      const withJobs = (on: ForgeModel, head: string, e2eNow: "running" | "failed" | "passed") =>
        ({
          ...on,
          mrs: on.mrs.map((one) => ({
            ...one,
            head,
            jobs: MR_JOBS.map((job) => ({
              name: job,
              state: job === "e2e-stage" ? e2eNow : ("passed" as const),
            })),
          })),
        }) satisfies ForgeModel;
      const model: ForgeModel = {
        ...withJobs(yield* made.forge.model(), made.head, e2e),
        environments: deploys(made.base, made.base),
      };
      yield* made.forge.set(model);
      /** The forge once the stage step put `head` on stage, its stage check at `e2eNow`. */
      const onStage = (head = made.head, e2eNow: "failed" | "passed" = "passed") => ({
        ...withJobs(model, head, e2eNow),
        environments: deploys(head, made.base),
      });
      const staging = (head = made.head, e2eNow: "failed" | "passed" = "passed") => ({
        writes: [made.forge.holding(onStage(head, e2eNow))],
        output: STAGED_MR,
      });
      /** The stage step put `head` on stage while the merge request's head moved to `later`. */
      const moving = (head: string, later: string) => ({
        writes: [made.forge.holding({ ...onStage(head), mrs: onStage(later).mrs })],
        output: STAGED_MR,
      });
      /** Stage back on what production carries, the merge request at `head`. */
      const unstaging = (head = made.head) => ({
        writes: [
          made.forge.holding({ ...onStage(head), environments: deploys(made.base, made.base) }),
        ],
        output: UNSTAGED,
      });
      return { ...made, model, onStage, staging, moving, unstaging };
    });

  /** Nothing a Stage Run must never do happened on the forge or origin. */
  const touchedNothing = (model: ForgeModel) =>
    Effect.gen(function* () {
      expect(model.merges ?? []).toEqual([]);
      expect(model.notes ?? {}).toEqual({});
      expect(repliesOf(model)).toEqual([]);
      expect(model.approved ?? []).toEqual([]);
      expect(yield* originTags()).toBe("");
    });

  scenario(
    `stage on ${name}: an open merge request with no approval, an unresolved thread and its stage check running is staged, asked about and rolled back on Done, under the claim`,
    () =>
      runEffect(
        Effect.gen(function* () {
          const { bin, forge, head, staging, unstaging } = yield* stageOn();
          claimed.length = 0;
          const runId = `r-stage-${name}`;
          yield* rig.queueOutputs([MR_STAGED, staging(), unstaging()]);
          const status = yield* driven(options(runId), (run) =>
            Effect.gen(function* () {
              const question = yield* goAsked(run.asked, "staged-1");
              expect(optionsOf([question], "staged-1")).toEqual([
                "Done",
                "Stage again",
                "Leave it on stage",
              ]);
              expect(question.prompt).toContain(mr);
              expect(question.prompt).toContain(head.slice(0, 8));
              expect(question.prompt).toContain(stageJobs);
              expect(question.prompt).toContain("project");
              expect(question.prompt).toContain("for testing, unmerged");
              const card = `${yield* awaitingOn(runId)} ${yield* parkedWhy(runId)}`;
              expect(card).not.toMatch(/approv|thread/i);
              expect(claimed).toEqual([`claim ${runId}`]);
              yield* run.answer("staged-1", "Done");
              return yield* ended(run.status);
            }),
          );
          const model = yield* forge.model();
          yield* touchedNothing(model);
          yield* bin.restore();
          expect(outcomeText(status)).toBe(
            `${mr} was staged at ${head.slice(0, 8)} for testing; stage is rolled back`,
          );
          expect(claimed).toEqual([`claim ${runId}`, `release ${runId}`]);
          expect(yield* clearance(runId, "stage")).toContain("never a production job");
          expect(yield* clearance(runId, "stage")).toContain(
            `\`deploy-stage\` of ${url}'s merge request pipeline`,
          );
          expect(yield* wasAsked(runId, "production")).toBe(false);
          const log = yield* runLog(runId);
          expect(log).not.toMatch(/\b(release[sd]?|approv\w*|go \d)\b/i);
          const lane = yield* laneNow(runId, "succeeded");
          expect(lane.nodes.map((node) => [node.title, node.state])).toEqual([
            ["Checkout", "done"],
            ["Assess", "done"],
            ["Helle claim", "done"],
            ["Stage", "done"],
            ["Test on stage", "done"],
            ["Roll stage back", "done"],
          ]);
          yield* checkedOutThenAssessed(runId);
        }),
      ),
    120_000,
  );

  scenario(
    `stage on ${name}: a path held at the merge request's branch is passed over, and the Run's log says whose it is`,
    () =>
      runEffect(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const { bin, forge, model } = yield* stageOn();
          yield* exec(["git", "worktree", "remove", "--force", `${rig.root}/reviewed`], {
            cwd: rig.projectDir,
          });
          const held = `${rig.root}/.herdr/worktrees/project/feature`;
          yield* fs.makeDirectory(held, { recursive: true });
          yield* fs.writeFileString(`${held}/notes.txt`, "mine\n");
          yield* forge.set({
            ...model,
            mrs: model.mrs.map((one) => ({ ...one, state: "closed" })),
          });
          const runId = `r-stage-held-${name}`;

          yield* ran(options(runId));
          yield* bin.restore();

          expect(yield* runLog(runId)).toContain(
            `passing over ${held} is a checkout that does not say which repository it belongs to`,
          );
          expect(yield* fs.readFileString(`${held}/notes.txt`)).toBe("mine\n");
        }),
      ),
    120_000,
  );

  scenario(
    `stage on ${name}: a merged, closed, package or stage-less merge request fails before any claim or stage step`,
    () =>
      runEffect(
        Effect.gen(function* () {
          const { bin, forge, model } = yield* stageOn();
          claimed.length = 0;
          const refused = (runId: string, state: FakeMr["state"]) =>
            Effect.gen(function* () {
              yield* forge.set({
                ...model,
                mrs: model.mrs.map((one) => ({ ...one, state })),
              });
              const result = yield* ran(options(runId));
              expect(yield* wasAsked(runId, "stage")).toBe(false);
              return reasonOf(result);
            });
          expect(yield* refused(`r-stage-merged-${name}`, "merged")).toBe(
            `${mr} is merged, so its stage is its release's: nothing was staged`,
          );
          expect(yield* refused(`r-stage-closed-${name}`, "closed")).toBe(
            `${mr} is closed, so nothing was staged`,
          );
          yield* rig.queueOutputs([PACKAGED, APP_ASSESSED]);
          expect(yield* refused(`r-stage-package-${name}`, "open")).toBe(
            `${mr} is a package, so there is nothing to stage: a publish job on tags, and no deploy`,
          );
          expect(yield* refused(`r-stage-stageless-${name}`, "open")).toBe(
            `${mr} is an application with no stage deploy job on its merge request's pipeline, so nothing was staged: a stage and a production environment`,
          );
          yield* bin.restore();
          expect(claimed).toEqual([]);
        }),
      ),
    120_000,
  );

  scenario(
    `stage on ${name}: a head that moves before stage is proved is staged in its turn, and the question names it`,
    () =>
      runEffect(
        Effect.gen(function* () {
          const { bin, head, staging, moving, unstaging } = yield* stageOn();
          claimed.length = 0;
          const runId = `r-stage-moved-${name}`;
          const later = yield* pushedBySomebody(head);
          yield* rig.queueOutputs([
            MR_STAGED,
            moving(head, later),
            staging(later),
            unstaging(later),
          ]);
          const status = yield* driven(options(runId), (run) =>
            Effect.gen(function* () {
              const question = yield* goAsked(run.asked, "staged-1");
              expect(question.prompt).toContain(later.slice(0, 8));
              expect(question.prompt).not.toContain(head.slice(0, 8));
              yield* run.answer("staged-1", "Done");
              return yield* ended(run.status);
            }),
          );
          yield* bin.restore();
          expect(outcomeText(status)).toBe(
            `${mr} was staged at ${later.slice(0, 8)} for testing; stage is rolled back`,
          );
          expect(yield* asked(runId, "stage-2")).toContain(later);
          expect(claimed).toEqual([`claim ${runId}`, `release ${runId}`]);
        }),
      ),
    120_000,
  );

  scenario(
    `stage on ${name}: attribution retains the earlier head's environment after a move and refuses Done while it still carries that head`,
    () =>
      runEffect(
        Effect.gen(function* () {
          const { bin, forge, head, base, onStage } = yield* stageOn();
          claimed.length = 0;
          const runId = `r-stage-moved-env-${name}`;
          const later = yield* pushedBySomebody(head);
          const model = onStage(later);
          const at = (newLive: string): ForgeModel => ({
            ...model,
            checksAt: { [head]: model.mrs[0]?.jobs ?? [] },
            environments: [
              {
                name: "stage-new",
                tier: "staging",
                job: "deploy-stage",
                deployments: [
                  { sha: newLive, status: "success" },
                  { sha: later, status: "success" },
                ],
              },
              { name: "stage-old", tier: "staging", job: "deploy-stage", deployed: head },
              { name: "production", tier: "production", deployed: base },
            ],
          });
          yield* rig.queueOutputs([
            MR_STAGED,
            {
              writes: [
                forge.holding({
                  ...at(base),
                  environments: at(base).environments?.filter((env) => env.name !== "stage-new"),
                }),
              ],
              output: STAGED_MR,
            },
            { writes: [forge.holding(at(later))], output: STAGED_MR },
            { writes: [forge.holding(at(base))], output: UNSTAGED },
          ]);
          const status = yield* driven(options(runId), (run) =>
            Effect.gen(function* () {
              yield* goAsked(run.asked, "staged-1");
              yield* run.answer("staged-1", "Done");
              return yield* ended(run.status);
            }),
          );
          yield* bin.restore();
          expect(outcomeText(status)).toContain(
            `stage still carries ${head.slice(0, 8)} in \`stage-old\``,
          );
          expect(status.status).toBe("failed");
          expect(claimed).toEqual([`claim ${runId}`]);
        }),
      ),
    120_000,
  );

  scenario(
    `stage on ${name}: a failed stage check is rolled back, its claim given back, and the Run fails naming the job and offers Stage again`,
    () =>
      runEffect(
        Effect.gen(function* () {
          const { bin, head, staging, unstaging } = yield* stageOn("failed");
          claimed.length = 0;
          const runId = `r-stage-failed-${name}`;
          yield* rig.queueOutputs([MR_STAGED, staging(head, "failed"), unstaging()]);
          const status = yield* driven(options(runId), (run) => ended(run.status));
          yield* bin.restore();
          expect(outcomeText(status)).toBe(
            `stage of ${mr} at ${head.slice(0, 8)} failed: \`e2e-stage\` has not passed on the merge request's pipeline at ${head.slice(0, 8)}: it is failed; stage is back on what production carries`,
          );
          expect(claimed).toEqual([`claim ${runId}`, `release ${runId}`]);
          expect(yield* asked(runId, "unstage")).toContain("`e2e-stage`");
          expect(yield* followUpOffered("stage", "stage-again", target)).toBe(true);
        }),
      ),
    120_000,
  );

  scenario(
    `stage on ${name}: a rollback the forge cannot show fails the Run and keeps the claim`,
    () =>
      runEffect(
        Effect.gen(function* () {
          const { bin, head, staging } = yield* stageOn("failed");
          claimed.length = 0;
          const runId = `r-stage-unshown-${name}`;
          yield* rig.queueOutputs([MR_STAGED, staging(head, "failed"), UNSTAGED]);
          const status = yield* driven(options(runId), (run) => ended(run.status));
          yield* bin.restore();
          expect(outcomeText(status)).toBe(
            `stage of ${mr} at ${head.slice(0, 8)} failed: \`e2e-stage\` has not passed on the merge request's pipeline at ${head.slice(0, 8)}: it is failed. Its rollback is not shown: stage still carries ${head.slice(0, 8)} in \`stage\``,
          );
          expect(claimed).toEqual([`claim ${runId}`]);
        }),
      ),
    120_000,
  );

  scenario(
    `stage on ${name}: Leave it on stage gives the claim back without unstaging, though the Run's Check fails`,
    () =>
      runEffect(
        Effect.gen(function* () {
          const { bin, forge, head, onStage, staging } = yield* stageOn();
          claimed.length = 0;
          const runId = `r-stage-leave-${name}`;
          yield* checkedBy(runId, "test", "false");
          yield* rig.queueOutputs([MR_STAGED, staging()]);
          const status = yield* driven(options(runId), (run) =>
            Effect.gen(function* () {
              yield* goAsked(run.asked, "staged-1");
              yield* run.answer("staged-1", "Leave it on stage");
              return yield* ended(run.status);
            }),
          );
          const model = yield* forge.model();
          yield* bin.restore();
          expect(outcomeText(status)).toBe(`stage carries ${mr} at ${head.slice(0, 8)}, unmerged`);
          expect(model.environments).toEqual(onStage().environments);
          expect(yield* wasAsked(runId, "unstage")).toBe(false);
          expect(claimed).toEqual([`claim ${runId}`, `release ${runId}`]);
        }),
      ),
    120_000,
  );

  scenario(
    `stage on ${name}: Stage again stages the head as it is now, keeping the claim, and asks again naming it`,
    () =>
      runEffect(
        Effect.gen(function* () {
          const { bin, forge, head, staging, onStage, unstaging } = yield* stageOn();
          claimed.length = 0;
          const runId = `r-stage-again-${name}`;
          const later = yield* pushedBySomebody(head);
          yield* rig.queueOutputs([MR_STAGED, staging(), staging(later), unstaging(later)]);
          const status = yield* driven(options(runId), (run) =>
            Effect.gen(function* () {
              yield* goAsked(run.asked, "staged-1");
              yield* forge.set({ ...(yield* forge.model()), mrs: onStage(later).mrs });
              yield* run.answer("staged-1", "Stage again");
              const again = yield* goAsked(run.asked, "staged-2");
              expect(again.prompt).toContain(later.slice(0, 8));
              expect(claimed).toEqual([`claim ${runId}`]);
              yield* run.answer("staged-2", "Done");
              return yield* ended(run.status);
            }),
          );
          yield* bin.restore();
          expect(outcomeText(status)).toBe(
            `${mr} was staged at ${later.slice(0, 8)} for testing; stage is rolled back`,
          );
          expect(yield* asked(runId, "stage-2")).toContain(later);
          expect(claimed).toEqual([`claim ${runId}`, `release ${runId}`]);
        }),
      ),
    120_000,
  );

  scenario(
    `stage on ${name}: a head the checkout does not fast-forward to parks the Run before any claim`,
    () =>
      runEffect(
        Effect.gen(function* () {
          const { bin, forge, base, onStage } = yield* stageOn();
          claimed.length = 0;
          const runId = `r-stage-forced-${name}`;
          const forced = yield* pushedBySomebody(base, true);
          yield* forge.set({ ...(yield* forge.model()), mrs: onStage(forced).mrs });
          yield* rig.queueOutputs([MR_STAGED]);
          const why = yield* driven(options(runId), () =>
            until(
              () => parkedWhy(runId),
              (said) => said !== "",
            ),
          );
          yield* bin.restore();
          expect(why).toContain("does not fast-forward");
          expect(claimed).toEqual([]);
          expect(yield* wasAsked(runId, "stage")).toBe(false);
        }),
      ),
    120_000,
  );

  scenario(
    `stage on ${name}: Helle projects that cannot be resolved are asked about in staging words, and Finish stages nothing`,
    () =>
      runEffect(
        Effect.gen(function* () {
          const { bin } = yield* stageOn();
          claimed.length = 0;
          const runId = `r-stage-unclaimed-${name}`;
          yield* rig.queueOutputs([MR_STAGED]);
          const why = "no Helle project in group's group for the application newapp";
          const status = yield* driven(
            options(
              runId,
              releaseHost({}, Effect.void, Infinity, () => ({ held: { unresolved: why } })),
            ),
            (run) =>
              Effect.gen(function* () {
                const unclaimed = yield* goAsked(run.asked, "claim.unclaimed");
                expect(unclaimed.prompt).toContain(why);
                expect(unclaimed.prompt).not.toMatch(/\b(release[sd]?|merged?)\b/i);
                expect(optionsOf([unclaimed], "claim.unclaimed")).toEqual([
                  "Try again",
                  "Stage without a Helle claim",
                  "Finish",
                ]);
                yield* run.answer("claim.unclaimed", "Finish");
                return yield* ended(run.status);
              }),
          );
          yield* bin.restore();
          expect(outcomeText(status)).toBe(`${mr} was not staged`);
          expect(yield* wasAsked(runId, "stage")).toBe(false);
          expect(claimed).toEqual([`release ${runId}`]);
        }),
      ),
    120_000,
  );

  scenario(
    `stage on ${name}: attribution with no environment belonging to a selected job leaves stage unproved and names the jobs`,
    () =>
      runEffect(
        Effect.gen(function* () {
          const { bin, forge, onStage, unstaging } = yield* stageOn();
          const runId = `r-stage-unowned-${name}`;
          const model = onStage();
          yield* rig.queueOutputs([
            MR_STAGED,
            {
              writes: [
                forge.holding({
                  ...model,
                  environments: model.environments.map((env) => ({ ...env, job: "teammate-job" })),
                }),
              ],
              output: STAGED_MR,
            },
            unstaging(),
          ]);
          const result = yield* ran(options(runId));
          yield* bin.restore();
          expect(reasonOf(result)).toContain("no stage environment");
          expect(reasonOf(result)).toContain("by `deploy-stage`, `e2e-stage`");
          expect(yield* wasAsked(runId, "staged-1")).toBe(false);
        }),
      ),
    120_000,
  );

  scenario(
    `stage on ${name}: attribution cannot give back claims when a refused environment read left the deployed environments unknown`,
    () =>
      runEffect(
        Effect.gen(function* () {
          const { bin, forge, onStage, unstaging } = yield* stageOn();
          const runId = `r-stage-unknown-env-${name}`;
          claimed.length = 0;
          yield* rig.queueOutputs([
            MR_STAGED,
            { writes: [forge.holding({ ...onStage(), deploysDown: true })], output: STAGED_MR },
            unstaging(),
          ]);
          const status = yield* driven(options(runId), (run) => ended(run.status));
          yield* bin.restore();
          expect(outcomeText(status)).toContain("stage environments could not be discovered");
          expect(status.status).toBe("failed");
          expect(claimed).toEqual([`claim ${runId}`]);
        }),
      ),
    120_000,
  );

  for (const ending of ["Done", "Leave it on stage", "failed stage"])
    scenario(
      `stage on ${name}: a refused claim give-back parks on ${ending} and retries it on resume`,
      () =>
        runEffect(
          Effect.gen(function* () {
            const { bin, staging, unstaging } = yield* stageOn();
            claimed.length = 0;
            refusedBack.length = 0;
            refusedBack.push(["project"]);
            const failed = ending === "failed stage";
            const runId = `r-stage-retained-${name}-${failed ? "failed" : ending === "Done" ? "done" : "leave"}`;
            yield* rig.queueOutputs([
              MR_STAGED,
              staging(undefined, failed ? "failed" : "passed"),
              ...(ending === "Leave it on stage" ? [] : [unstaging()]),
            ]);
            const status = yield* driven(options(runId), (run) =>
              Effect.gen(function* () {
                if (!failed) {
                  yield* goAsked(run.asked, "staged-1");
                  yield* run.answer("staged-1", ending);
                }
                const [status, why] = yield* until(
                  () => Effect.all([run.status, parkedWhy(runId)]),
                  ([status, why]) =>
                    status.status === "complete" ||
                    status.status === "failed" ||
                    (status.status === "suspended" && why !== ""),
                );
                expect(why).toContain("project");
                expect(status.status).toBe("suspended");
                expect(claimed).toEqual([`claim ${runId}`, `release ${runId}`]);
                yield* run.resume;
                return yield* ended(run.status);
              }),
            );
            yield* bin.restore();
            expect(status.status).toBe(failed ? "failed" : "complete");
            expect(claimed).toEqual([`claim ${runId}`, `release ${runId}`, `release ${runId}`]);
          }),
        ),
      120_000,
    );

  const APPS = ["bingo", "casino", "happytiger", "lobby", "playground", "poker", "spilnu"] as const;
  const appJob = (app: string) => `stage:${app}`;
  const BUSY_ASSESSED = {
    ...APP_ASSESSED,
    applications: [...APPS],
    stage_jobs: { merge_request: APPS.map(appJob), tag: [] },
  };
  // An unknown commit makes a teammate's deployment incomparable with this checkout.
  const TEAMMATE = "7ea3a7e0".repeat(5);

  interface BusyHelle {
    readonly holders: Record<string, string | null>;
    readonly racing?: Record<string, string>;
    readonly handedOver?: Deferred.Deferred<void>;
    readonly declared?: ReadonlyArray<string>;
    readonly events?: string[];
    unresolved?: string;
  }
  const busyHost = (helle: BusyHelle): HostOverride =>
    Layer.effect(Host)(
      Effect.gen(function* () {
        const host = yield* Host;
        const held = new Set<string>();
        const needsOf = (app: string) => [...(helle.declared ?? [app])];
        const neededFor = (deploys?: { readonly applications: ReadonlyArray<string> }) =>
          [...new Set((deploys?.applications ?? []).flatMap(needsOf))].sort();
        const holderOf = (slug: string) => (held.has(slug) ? null : (helle.holders[slug] ?? null));
        return Host.of({
          ...host,
          readRollback: (options) =>
            Effect.gen(function* () {
              helle.events?.push("rollback-started");
              const back = yield* host.readRollback(options);
              if (back._tag === "Shown") helle.events?.push("rollback-proved");
              return back;
            }),
          holders: (asked) =>
            Effect.succeed({
              _tag: "Read" as const,
              projects: neededFor(asked.deploys).map((slug) => ({ slug, holder: holderOf(slug) })),
              applications: (asked.deploys?.applications ?? []).map((app) => ({
                name: app,
                needs: needsOf(app),
              })),
              jobs: (asked.deploys?.jobs ?? []).map((job) => ({
                name: job,
                applications: APPS.filter((app) => job === appJob(app)),
              })),
            }),
          claim: (options) =>
            Effect.gen(function* () {
              const needed = neededFor(options.deploys);
              const take = (slug: string) => {
                if (!held.has(slug)) claimed.push(`claim ${options.runId} ${slug}`);
                held.add(slug);
              };
              if (options.free !== true) {
                claimed.push(`wait ${options.runId}`);
                if (helle.handedOver !== undefined) yield* Deferred.await(helle.handedOver);
                needed.forEach(take);
                return { slugs: needed };
              }
              if (helle.unresolved !== undefined) return { unresolved: helle.unresolved };
              const left: Array<{ slug: string; holder: string }> = [];
              for (const slug of needed) {
                const holder = holderOf(slug) ?? helle.racing?.[slug] ?? null;
                if (holder === null) take(slug);
                else left.push({ slug, holder });
              }
              return { slugs: [...held].sort(), left };
            }),
          release: (runId) =>
            Effect.sync(() => {
              helle.events?.push("claims-released");
              for (const slug of [...held].sort()) claimed.push(`release ${runId} ${slug}`);
              held.clear();
              return [];
            }),
        });
      }),
    );

  const busyStage = (busy: ReadonlyArray<string>, sameHead = false) =>
    Effect.gen(function* () {
      const made = yield* releasable(name, UNAPPROVED[name], false);
      const success = (sha: string) => ({ sha, status: "success" as const });
      const start = (app: string) =>
        busy.includes(app) ? [sameHead ? made.head : TEAMMATE] : [made.base];
      const before = yield* made.forge.model();
      const at = (deployed: Partial<Record<string, ReadonlyArray<string>>>): ForgeModel => ({
        ...before,
        mrs: before.mrs.map((one) => ({
          ...one,
          head: made.head,
          jobs: APPS.map((app) => ({ name: appJob(app), state: "passed" as const })),
        })),
        environments: [
          ...APPS.map((app) => ({
            name: `stage-${app}`,
            tier: "staging",
            job: appJob(app),
            deployments: (deployed[app] ?? start(app)).map(success),
          })),
          { name: "production", tier: "production", deployments: [success(made.base)] },
        ],
      });
      const model = at({});
      yield* made.forge.set(model);
      const onEach = (apps: ReadonlyArray<string>, shas: (app: string) => ReadonlyArray<string>) =>
        Object.fromEntries(apps.map((app) => [app, shas(app)]));
      const staged = (apps: ReadonlyArray<string>) => ({
        writes: [made.forge.holding(at(onEach(apps, (app) => [made.head, ...start(app)])))],
        output: { verdict: "clean", stage_jobs: apps.map(appJob) },
      });
      const unstaged = (apps: ReadonlyArray<string>) => ({
        writes: [
          made.forge.holding(at(onEach(apps, (app) => [made.base, made.head, ...start(app)]))),
        ],
        output: UNSTAGED,
      });
      return { ...made, model, staged, unstaged };
    });

  const leftOff = (prompt: string) => /Left off stage[^:]*: ([^.]*)\./.exec(prompt)?.[1] ?? "";

  scenario(
    `stage on ${name}: busy claims: where every project is free, no claims question is asked and every application is staged`,
    () =>
      runEffect(
        Effect.gen(function* () {
          const { bin, staged, unstaged } = yield* busyStage([]);
          claimed.length = 0;
          const runId = `r-busy-free-${name}`;
          const helle = { holders: {} };
          yield* rig.queueOutputs([BUSY_ASSESSED, staged(APPS), unstaged(APPS)]);
          const status = yield* driven(options(runId, busyHost(helle)), (run) =>
            Effect.gen(function* () {
              const question = yield* goAsked(run.asked, "staged-1");
              expect((yield* run.asked).map((row) => row.decision)).not.toContain("claims-1");
              expect(leftOff(question.prompt)).toBe("");
              yield* run.answer("staged-1", "Done");
              return yield* ended(run.status);
            }),
          );
          yield* bin.restore();
          expect(outcomeText(status)).toContain("stage is rolled back");
          for (const app of APPS)
            expect(yield* asked(runId, "stage")).toContain(`\`${appJob(app)}\``);
          expect(claimed).toEqual([
            `wait ${runId}`,
            ...APPS.map((app) => `claim ${runId} ${app}`),
            ...APPS.map((app) => `release ${runId} ${app}`),
          ]);
        }),
      ),
    120_000,
  );

  const DANNS = APPS.filter((app) => app !== "playground");
  const dann = (): BusyHelle & { holders: Record<string, string | null> } => ({
    holders: Object.fromEntries(DANNS.map((app): [string, string | null] => [app, "Dann"])),
  });

  scenario(
    `stage on ${name}: busy claims: attribution leaves Dann's six deployments of the same head untouched, stages only the free application, names the six left off, rolls back only its environment and gives back only its project`,
    () =>
      runEffect(
        Effect.gen(function* () {
          const { bin, forge, model, staged, unstaged } = yield* busyStage(DANNS, true);
          claimed.length = 0;
          const runId = `r-busy-355-${name}`;
          yield* rig.queueOutputs([
            BUSY_ASSESSED,
            staged(["playground"]),
            unstaged(["playground"]),
          ]);
          const status = yield* driven(options(runId, busyHost(dann())), (run) =>
            Effect.gen(function* () {
              const claims = yield* goAsked(run.asked, "claims-1");
              expect(optionsOf([claims], "claims-1")).toEqual([
                "Wait for all",
                "Stage what is free",
                "Finish",
              ]);
              for (const app of DANNS) expect(claims.prompt).toContain(`${app} (Dann)`);
              expect(claims.prompt).not.toContain("playground (");
              expect(yield* wasAsked(runId, "stage")).toBe(false);
              yield* run.answer("claims-1", "Stage what is free");
              const question = yield* goAsked(run.asked, "staged-1");
              expect(leftOff(question.prompt).split(", ").sort()).toEqual([...DANNS]);
              yield* run.answer("staged-1", "Done");
              return yield* ended(run.status);
            }),
          );
          const after = yield* forge.model();
          yield* bin.restore();
          expect(outcomeText(status)).toContain("stage is rolled back");
          const stage = yield* clearance(runId, "stage");
          const unstage = yield* clearance(runId, "unstage");
          expect(stage).toContain("`stage:playground`");
          expect(unstage).toContain("`stage:playground`");
          for (const app of DANNS) {
            expect(stage).not.toContain(appJob(app));
            expect(unstage).not.toContain(appJob(app));
          }
          const others = (environments: ForgeModel["environments"]) =>
            (environments ?? []).filter((env) => DANNS.some((app) => env.name === `stage-${app}`));
          expect(others(after.environments)).toEqual(others(model.environments));
          expect(claimed).toEqual([`claim ${runId} playground`, `release ${runId} playground`]);
        }),
      ),
    120_000,
  );

  scenario(
    `stage on ${name}: busy claims: Wait for all stages nothing until every project is handed over, then stages every application`,
    () =>
      runEffect(
        Effect.gen(function* () {
          const { bin, staged, unstaged } = yield* busyStage(DANNS);
          claimed.length = 0;
          const runId = `r-busy-wait-${name}`;
          const helle = { ...dann(), handedOver: yield* Deferred.make<void>() };
          yield* rig.queueOutputs([BUSY_ASSESSED, staged(APPS), unstaged(APPS)]);
          const status = yield* driven(options(runId, busyHost(helle)), (run) =>
            Effect.gen(function* () {
              yield* goAsked(run.asked, "claims-1");
              yield* run.answer("claims-1", "Wait for all");
              yield* until(
                () => Effect.sync(() => claimed),
                (now) => now.includes(`wait ${runId}`),
              );
              expect(yield* wasAsked(runId, "stage")).toBe(false);
              yield* Deferred.succeed(helle.handedOver, undefined);
              const question = yield* goAsked(run.asked, "staged-1");
              expect(leftOff(question.prompt)).toBe("");
              yield* run.answer("staged-1", "Done");
              return yield* ended(run.status);
            }),
          );
          yield* bin.restore();
          expect(outcomeText(status)).toContain("stage is rolled back");
          for (const app of APPS)
            expect(yield* asked(runId, "stage")).toContain(`\`${appJob(app)}\``);
          expect(claimed).toContain(`claim ${runId} spilnu`);
        }),
      ),
    120_000,
  );

  scenario(
    `stage on ${name}: busy claims: Finish at the claims question claims nothing and stages nothing`,
    () =>
      runEffect(
        Effect.gen(function* () {
          const { bin } = yield* busyStage(DANNS);
          claimed.length = 0;
          const runId = `r-busy-finish-${name}`;
          yield* rig.queueOutputs([BUSY_ASSESSED]);
          const status = yield* driven(options(runId, busyHost(dann())), (run) =>
            Effect.gen(function* () {
              yield* goAsked(run.asked, "claims-1");
              yield* run.answer("claims-1", "Finish");
              return yield* ended(run.status);
            }),
          );
          yield* bin.restore();
          expect(outcomeText(status)).toBe(`${mr} was not staged`);
          expect(yield* wasAsked(runId, "stage")).toBe(false);
          expect(claimed).toEqual([]);
        }),
      ),
    120_000,
  );

  scenario(
    `stage on ${name}: busy claims: a project someone takes between the read and the take is left off and named`,
    () =>
      runEffect(
        Effect.gen(function* () {
          const busy = DANNS.filter((app) => app !== "poker");
          const { bin, staged, unstaged } = yield* busyStage(busy);
          claimed.length = 0;
          const runId = `r-busy-race-${name}`;
          const helle = {
            holders: Object.fromEntries(busy.map((app) => [app, "Dann"])),
            racing: { poker: "Mona" },
          };
          yield* rig.queueOutputs([
            BUSY_ASSESSED,
            staged(["playground"]),
            unstaged(["playground"]),
          ]);
          yield* driven(options(runId, busyHost(helle)), (run) =>
            Effect.gen(function* () {
              const claims = yield* goAsked(run.asked, "claims-1");
              expect(claims.prompt).not.toContain("poker (");
              yield* run.answer("claims-1", "Stage what is free");
              const question = yield* goAsked(run.asked, "staged-1");
              expect(leftOff(question.prompt).split(", ").sort()).toEqual(
                [...busy, "poker"].sort(),
              );
              expect(question.prompt).toContain("poker (Mona)");
              yield* run.answer("staged-1", "Done");
              return yield* ended(run.status);
            }),
          );
          yield* bin.restore();
          expect(yield* clearance(runId, "stage")).not.toContain("stage:poker");
          expect(claimed).toEqual([`claim ${runId} playground`, `release ${runId} playground`]);
        }),
      ),
    120_000,
  );

  scenario(
    `stage on ${name}: busy claims: Stage again takes a left-off project that became free, stages that application too, and no longer names it left off`,
    () =>
      runEffect(
        Effect.gen(function* () {
          const { bin, staged, unstaged } = yield* busyStage(DANNS);
          claimed.length = 0;
          const runId = `r-busy-again-${name}`;
          const helle = dann();
          const both = ["playground", "spilnu"];
          yield* rig.queueOutputs([
            BUSY_ASSESSED,
            staged(["playground"]),
            staged(both),
            unstaged(both),
          ]);
          yield* driven(options(runId, busyHost(helle)), (run) =>
            Effect.gen(function* () {
              yield* goAsked(run.asked, "claims-1");
              yield* run.answer("claims-1", "Stage what is free");
              yield* goAsked(run.asked, "staged-1");
              helle.holders.spilnu = null;
              yield* run.answer("staged-1", "Stage again");
              const again = yield* goAsked(run.asked, "staged-2");
              expect(leftOff(again.prompt).split(", ").sort()).toEqual(
                DANNS.filter((app) => app !== "spilnu"),
              );
              expect(claimed).toEqual([`claim ${runId} playground`, `claim ${runId} spilnu`]);
              yield* run.answer("staged-2", "Done");
              return yield* ended(run.status);
            }),
          );
          yield* bin.restore();
          const again = yield* clearance(runId, "stage-2");
          expect(again).toContain("`stage:playground`");
          expect(again).toContain("`stage:spilnu`");
          expect(again).not.toContain("stage:poker");
          expect(yield* clearance(runId, "unstage-2")).toContain("`stage:spilnu`");
          expect(claimed.slice(2)).toEqual([
            `release ${runId} playground`,
            `release ${runId} spilnu`,
          ]);
        }),
      ),
    120_000,
  );

  scenario(
    `stage on ${name}: busy claims: Finish where Stage again cannot settle the left-off claims rolls stage back and gives back what it holds`,
    () =>
      runEffect(
        Effect.gen(function* () {
          const { bin, staged, unstaged } = yield* busyStage(DANNS);
          claimed.length = 0;
          const runId = `r-busy-again-finish-${name}`;
          const events: string[] = [];
          const helle: BusyHelle = { ...dann(), events };
          yield* rig.queueOutputs([
            BUSY_ASSESSED,
            staged(["playground"]),
            unstaged(["playground"]),
          ]);
          const status = yield* driven(options(runId, busyHost(helle)), (run) =>
            Effect.gen(function* () {
              yield* goAsked(run.asked, "claims-1");
              yield* run.answer("claims-1", "Stage what is free");
              yield* goAsked(run.asked, "staged-1");
              helle.unresolved = "Helle is down";
              yield* run.answer("staged-1", "Stage again");
              yield* goAsked(run.asked, "staged-1.claim.unclaimed");
              yield* run.answer("staged-1.claim.unclaimed", "Finish");
              return yield* ended(run.status);
            }),
          );
          yield* bin.restore();
          expect(outcomeText(status)).toContain("stage is rolled back");
          expect(yield* clearance(runId, "unstage")).toContain("`stage:playground`");
          expect(claimed).toEqual([`claim ${runId} playground`, `release ${runId} playground`]);
          expect(events).toEqual(["rollback-started", "rollback-proved", "claims-released"]);
        }),
      ),
    120_000,
  );

  scenario(
    `stage on ${name}: busy claims: a failed refresh waived by the human retains the live application's claim through restaging and rollback`,
    () =>
      runEffect(
        Effect.gen(function* () {
          const { bin, staged, unstaged } = yield* busyStage(DANNS);
          claimed.length = 0;
          const runId = `r-busy-refresh-without-${name}`;
          const events: string[] = [];
          const helle: BusyHelle = { ...dann(), events };
          yield* rig.queueOutputs([
            BUSY_ASSESSED,
            staged(["playground"]),
            staged(["playground"]),
            unstaged(["playground"]),
          ]);
          const status = yield* driven(options(runId, busyHost(helle)), (run) =>
            Effect.gen(function* () {
              yield* goAsked(run.asked, "claims-1");
              yield* run.answer("claims-1", "Stage what is free");
              yield* goAsked(run.asked, "staged-1");
              helle.unresolved = "Helle is down";
              yield* run.answer("staged-1", "Stage again");
              yield* goAsked(run.asked, "staged-1.claim.unclaimed");
              yield* run.answer("staged-1.claim.unclaimed", "Stage without a Helle claim");
              const again = yield* goAsked(run.asked, "staged-2");
              expect(again.prompt).toContain("holds the Helle claims of playground");
              expect(events).toEqual([]);
              yield* run.answer("staged-2", "Done");
              return yield* ended(run.status);
            }),
          );
          yield* bin.restore();
          expect(outcomeText(status)).toContain("stage is rolled back");
          expect(events).toEqual(["rollback-started", "rollback-proved", "claims-released"]);
          expect(claimed).toEqual([`claim ${runId} playground`, `release ${runId} playground`]);
        }),
      ),
    120_000,
  );

  scenario(
    `stage on ${name}: busy claims: a repository whose .collie/helle.json declares its projects, one of them busy, is not offered Stage what is free`,
    () =>
      runEffect(
        Effect.gen(function* () {
          const { bin } = yield* busyStage(["spilnu"]);
          claimed.length = 0;
          const runId = `r-busy-declared-${name}`;
          const helle = { holders: { spilnu: "Dann" }, declared: ["playground", "spilnu"] };
          yield* rig.queueOutputs([BUSY_ASSESSED]);
          yield* driven(options(runId, busyHost(helle)), (run) =>
            Effect.gen(function* () {
              const claims = yield* goAsked(run.asked, "claims-1");
              expect(optionsOf([claims], "claims-1")).toEqual(["Wait for all", "Finish"]);
              yield* run.answer("claims-1", "Finish");
              return yield* ended(run.status);
            }),
          );
          yield* bin.restore();
          expect(claimed).toEqual([]);
        }),
      ),
    120_000,
  );
}

const CHORE = "upgrade the VM's install to 0.45.1";
const DONE = { summary: "Upgraded the VM's install to 0.45.1 and restarted the host." };

scenario(
  "Flow: review's reviewer runs before its expected menu",
  () =>
    runEffect(
      Effect.gen(function* () {
        const lane = yield* laneWhen({
          entry: shipped("review"),
          runId: "r-review-flow",
          input: { target: "worktree" },
          ready: (one) => one.nodes.some((node) => node.ranOn !== null),
          outputs: [],
          working: { operation: "review-1", output: CLEAN_SYNTHESIS },
          rest: [],
          finish: { decision: "post-1", value: "Don't post" },
        });
        expect(lane.nodes.map((node) => [node.title, node.state, node.declared])).toEqual([
          ["Review", "running", true],
          ["What next", "expected", true],
        ]);
        expect(nodeIn(lane, "review")?.ranOn).toBe("claude/opus high");
      }),
    ),
  120_000,
);

scenario(
  "Flow: general's Task runs while its agent works",
  () =>
    runEffect(
      Effect.gen(function* () {
        const lane = yield* laneWhen({
          entry: shipped("general"),
          runId: "r-general-flow",
          input: { goal: CHORE },
          ready: (one) => one.nodes.some((node) => node.ranOn !== null),
          outputs: [],
          working: { operation: "task", output: DONE },
          rest: [],
        });
        expect(lane.nodes.map((node) => [node.title, node.state, node.declared])).toEqual([
          ["Task", "running", true],
        ]);
      }),
    ),
  120_000,
);

scenario(
  "a general Run launches one generalist on the goal and ends with its summary",
  () =>
    runEffect(
      Effect.gen(function* () {
        yield* rig.queueOutputs([DONE]);
        const result = yield* ran({
          entry: shipped("general"),
          runId: "r-general",
          input: { goal: CHORE },
        });

        expect(said(result)).toBe(DONE.summary);
        const agents = yield* launched();
        expect(agents).toHaveLength(1);
        expect(agents[0]?.args).toContain("--model opus --effort high");
        const work = yield* asked("r-general", "task");
        expect(work).toContain(CHORE);
        expect(work).toContain(`Project root: ${rig.projectDir}`);
        expect(work).toContain("collie run intent verification r-general --name");
        expect(yield* persona("r-general", "task")).toContain("You are a generalist");
      }),
    ),
  120_000,
);

scenario(
  "a general Run whose agent was blocked fails with the agent's reason",
  () =>
    runEffect(
      Effect.gen(function* () {
        yield* rig.queueOutputs([{ summary: "Nothing upgraded.", blocked: "the VM is down" }]);
        const result = yield* ran({
          entry: shipped("general"),
          runId: "r-general-blocked",
          input: { goal: CHORE },
        });

        expect(result._tag === "Failure" && result.failure).toBeInstanceOf(WorkflowError);
        expect(reasonOf(result)).toBe("the VM is down");
      }),
    ),
  120_000,
);

scenario(
  "a general Run at the Projects root is told the root is not a repository, and elsewhere is not",
  () =>
    runEffect(
      Effect.gen(function* () {
        yield* rig.queueOutputs([DONE, DONE]);
        yield* ran({
          entry: shipped("general"),
          runId: "r-general-root",
          input: { goal: CHORE },
          options: { workspace: "projects-root" },
        });
        yield* ran({ entry: shipped("general"), runId: "r-general-here", input: { goal: CHORE } });

        expect(yield* asked("r-general-root", "task")).toContain(
          "it is not a repository: find the\nrepository",
        );
        expect(yield* asked("r-general-root", "task")).toContain(
          "--cwd <its directory, relative to the project root>",
        );
        expect(yield* asked("r-general-here", "task")).not.toContain("it is not a repository");
      }),
    ),
  120_000,
);

scenario("a general Run declares no checkout, no gate, no outcome and offers nothing", () =>
  runEffect(
    Effect.gen(function* () {
      const described = yield* loadEntry(shipped("general")).pipe(Effect.orDie);
      expect(described.metadata?.checkout).toBeUndefined();
      expect(described.metadata?.outcome).toBeUndefined();
      expect(described.metadata?.hints).toEqual({ goal: "goal" });
      expect(declaredByModule(described.metadata)).toEqual([]);
    }),
  ),
);

/** The window a `self-improve` Run reads, and what its forge was asked, as a scenario sets them. */
let windowRuns: Array<{
  runId: string;
  parent: string | null;
  project?: string;
  workflow?: string;
  created?: string;
  closes?: ReadonlyArray<number>;
}> = [];
let openIssues: Issue[] = [];
let filed: Array<{ title: string; body: string }> = [];
let commented: Array<{ number: number; body: string }> = [];
let refusing = new Set<string>();
let unlisted = false;
let lagging = false;

/** The Machine's report and this checkout's forge, as `self-improve` reads and writes them. */
const improving: HostOverride = Layer.effect(Host)(
  Effect.gen(function* () {
    const host = yield* Host;
    return Host.of({
      ...host,
      build: "0.103.0",
      report: (since) =>
        Effect.gen(function* () {
          const own = Option.getOrUndefined(yield* Effect.serviceOption(Run))?.id ?? "";
          const runs = [{ runId: own, parent: null, workflow: idOf("self-improve") }, ...windowRuns]
            .map(({ runId, parent, ...rest }) => ({
              runId,
              workflow: "workflow" in rest && rest.workflow ? rest.workflow : "implement",
              parent,
              project: "project" in rest && rest.project ? rest.project : rig.projectDir,
              created: "created" in rest && rest.created ? rest.created : since,
              status: "failed" as const,
              closes: "closes" in rest && rest.closes ? rest.closes : [],
            }))
            .filter(({ created }) => epochOf(created) >= epochOf(since));
          return {
            since,
            total: runs.length,
            runs,
            workflows: [],
            failed: runs.map(({ runId }) => ({
              runId,
              workflow: "implement",
              reason: `${runId} broke`,
            })),
            completed: [],
            stopped: [],
            measures: measuresOf([]),
          };
        }),
      issues: (_, numbers) => {
        if (unlisted && filed.length > 0)
          return Effect.fail(new WorkflowError({ reason: "the forge did not answer" }));
        const filedIssues = filed.map(({ title, body }, at) => ({
          number: 101 + at,
          title,
          body,
          url: `https://forge.example/project/issues/${101 + at}`,
        }));
        const all = [...openIssues, ...filedIssues];
        if (numbers !== undefined)
          return Effect.succeed(all.filter(({ number }) => numbers.includes(number)));
        return Effect.succeed(lagging ? openIssues : all);
      },
      fileIssue: ({ title, body }) =>
        refusing.has(title)
          ? Effect.fail(new WorkflowError({ reason: "it names another checkout" }))
          : Effect.sync(() => {
              filed.push({ title: redact(title), body: redact(body) });
              const number = 100 + filed.length;
              return { number, url: `https://forge.example/project/issues/${number}` };
            }),
      commentIssue: ({ number, body }) => Effect.sync(() => void commented.push({ number, body })),
    });
  }),
);

/** A `self-improve` Run, executed to its end. */
const improved = (runId: string, input: Readonly<Record<string, Schema.Json>>) =>
  session(
    Effect.gen(function* () {
      const made = yield* loaded(shipped("self-improve"), runId);
      yield* admit({ runId, workflow: made.workflow.name, input });
      return yield* made.workflow
        .execute({ runId, input })
        .pipe(Effect.result, Effect.provide(made.layer));
    }),
    improving,
  );

const freshDay = () => {
  windowRuns = [
    { runId: "r-a", parent: null },
    { runId: "r-b", parent: null },
  ];
  openIssues = [];
  filed = [];
  commented = [];
  refusing = new Set();
  unlisted = false;
  lagging = false;
};

const readText = (file: string) =>
  FileSystem.FileSystem.pipe(Effect.flatMap((fs) => fs.readFileString(file)));

const LEAKED = `ghp_${"x".repeat(24)}`;
const saidBy = (result: Result.Result<unknown, unknown>) =>
  Result.isSuccess(result) ? String(result.success) : "";
const refusedWith = (result: Result.Result<unknown, unknown>) =>
  Result.isFailure(result) && Schema.is(WorkflowError)(result.failure) ? result.failure.reason : "";

const finding = (over: Partial<Finding> & Pick<Finding, "key">): Finding => ({
  category: "navigation",
  title: `Project ${over.key}`,
  body: `What the Runs did: ${over.key}.`,
  severity: "high",
  runs: ["r-a", "r-b"],
  records: ["runs/r-a/audit.jsonl"],
  issue: null,
  ...over,
});

const triaged = (
  findings: ReadonlyArray<Finding>,
  improvements: ReadonlyArray<Improvement> = [],
) => ({
  findings,
  improvements,
  left_out: [{ what: "an outage of the package registry", why: "a service nobody here runs" }],
});

scenario(
  "Flow: self-improve starts one Improvements run per named improvement",
  () =>
    runEffect(
      Effect.gen(function* () {
        freshDay();
        yield* rig.queueOutputs([
          triaged(
            [finding({ key: "one" }), finding({ key: "two" })],
            [
              { name: "first", keys: ["one"], why: "Fix the first defect" },
              { name: "second", keys: ["two"], why: "Fix the second defect" },
            ],
          ),
        ]);
        yield* improved("r-improvements-flow", { runs: "machine", improvements: 2 });
        const lane = yield* laneNow("r-improvements-flow", "succeeded");
        expect(nodeIn(lane, "improvements")?.runs.map((one) => [one.place, one.state])).toEqual([
          ["first", "done"],
          ["second", "done"],
        ]);
      }),
    ),
  120_000,
);

const DefaultOf = Schema.Struct({ default: Schema.Json });
/** The default a drawn input schema declares, or null for none. */
const schemaDefault = (drawn: Schema.Json | null) =>
  Option.getOrNull(Schema.decodeUnknownOption(DefaultOf)(drawn))?.default ?? null;

const agentPrompts = () =>
  rig.calls().pipe(Effect.map((calls) => calls.filter((call) => call.cmd === "agent prompt")));

once("self-improve takes improvements as a whole number and runs as checkout or machine", () => {
  const decode = Schema.decodeUnknownSync(selfImprove.input ?? Schema.Never);
  expect(decode({ runs: "checkout", improvements: "3" })).toEqual({
    runs: "checkout",
    improvements: 3,
  });
  expect(decode({ runs: "machine", improvements: 0 })).toEqual({
    runs: "machine",
    improvements: 0,
  });
  for (const wrong of ["-1", "x", 1.5])
    expect(() => decode({ runs: "checkout", improvements: wrong })).toThrow();
  expect(() => decode({ improvements: 2 })).toThrow();
  expect(() => decode({ runs: "everything", improvements: 2 })).toThrow();
  return Promise.resolve();
});

once(
  "a finding recurs in two of the window's Runs or on an open issue, and a defect in one",
  () => {
    const window = new Set(["r-a", "r-b"]);
    const issues = [{ number: 8, title: "", url: "", keys: keysIn(`x\n${markerOf("known")}`) }];
    const findings = [
      finding({ key: "crash", category: "defect", runs: ["r-a"] }),
      finding({ key: "once", runs: ["r-a"] }),
      finding({ key: "twice" }),
      finding({ key: "known", runs: ["r-a"] }),
      finding({ key: "elsewhere", runs: ["r-z"] }),
    ];
    const machine = sortOut(findings, window, issues, true);
    expect(machine.kept.map(({ key }) => key)).toEqual(["crash", "twice", "known"]);
    expect(machine.leftOut.map(({ why }) => why)).toEqual(["seen once", "no Run of the window"]);
    const checkout = sortOut(findings, window, issues, false);
    expect(checkout.kept.map(({ key }) => key)).toEqual(["twice", "known"]);
    expect(checkout.leftOut.map(({ why }) => why)).toEqual([
      "about Collie",
      "seen once",
      "no Run of the window",
    ]);
    return Promise.resolve();
  },
);

scenario(
  "with no Runs in the window, self-improve says so and starts no agent",
  () =>
    runEffect(
      Effect.gen(function* () {
        freshDay();
        windowRuns = [
          { runId: "r-none-improvement-x", parent: "r-none" },
          { runId: "r-other", parent: null, project: "/elsewhere/other" },
        ];
        const result = yield* improved("r-none", { runs: "checkout" });
        expect(saidBy(result)).toStartWith("No Runs since ");
        expect(yield* agentPrompts()).toEqual([]);
      }),
    ),
  60_000,
);

scenario(
  "a Machine without the retro skill fails self-improve, naming the repair, before any agent or issue",
  () =>
    runEffect(
      Effect.gen(function* () {
        freshDay();
        const fs = yield* FileSystem.FileSystem;
        yield* fs.remove(`${rig.root}/.agents/skills/retro`, { recursive: true });
        const result = yield* improved("r-unskilled", { runs: "machine" });
        expect(refusedWith(result)).toContain("retro");
        expect(refusedWith(result)).toContain("prepare.sh");
        expect(yield* agentPrompts()).toEqual([]);
        expect([filed, commented]).toEqual([[], []]);
      }),
    ),
  60_000,
);

scenario(
  "self-improve over a checkout reads only that project's Runs and leaves Collie's defects out",
  () =>
    runEffect(
      Effect.gen(function* () {
        freshDay();
        windowRuns = [
          ...windowRuns,
          { runId: "r-other", parent: null, project: "/elsewhere/other" },
        ];
        yield* rig.queueOutputs([
          triaged([
            finding({ key: "host-crash", category: "defect", runs: ["r-a"] }),
            finding({ key: "lost-docs" }),
          ]),
        ]);

        const result = yield* improved("r-checkout", { runs: "checkout", improvements: 0 });

        expect(saidBy(result)).toContain("Filed 1, commented 0, refused 0");
        const prompt = yield* readText(`${dir}/agents/r-checkout/triage.prompt.md`);
        expect(prompt).toContain("r-a");
        expect(prompt).not.toContain("r-other");
        expect(prompt).not.toContain("/elsewhere/other");
        expect(prompt).toContain('"about Collie"');
        expect(filed.map(({ title }) => title)).toEqual(["Project lost-docs"]);
        expect(yield* readText(`${runDir(dir, "r-checkout")}/summary.md`)).toContain(
          "Project host-crash: about Collie",
        );
      }),
    ),
  120_000,
);

scenario(
  "self-improve over a Machine reads every Run and files a defect seen once",
  () =>
    runEffect(
      Effect.gen(function* () {
        freshDay();
        windowRuns = [
          ...windowRuns,
          { runId: "r-other", parent: null, project: "/elsewhere/other" },
        ];
        yield* rig.queueOutputs([
          triaged([finding({ key: "host-crash", category: "defect", runs: ["r-other"] })]),
        ]);

        const result = yield* improved("r-machine", { runs: "machine", improvements: 0 });

        expect(saidBy(result)).toContain("Filed 1, commented 0, refused 0");
        const prompt = yield* readText(`${dir}/agents/r-machine/triage.prompt.md`);
        expect(prompt).toContain("r-other");
        expect(prompt).toContain("`defect` is one more");
        expect(filed.map(({ title }) => title)).toEqual(["Project host-crash"]);
      }),
    ),
  120_000,
);

scenario(
  "a self-improve triage counts a Collie fix as already fixed only where the release its Machine runs carries it",
  () =>
    runEffect(
      Effect.gen(function* () {
        freshDay();
        yield* rig.queueOutputs([triaged([])]);
        yield* improved("r-release", { runs: "machine", improvements: 0 });
        const prompt = yield* readText(`${dir}/agents/r-release/triage.prompt.md`);
        expect(prompt).toContain("git merge-base --is-ancestor <commit> 0.103.0");
        expect(prompt).toContain("git fetch origin tag 0.103.0");
      }),
    ),
  120_000,
);

const earlier = (
  runId: string,
  created: string,
  kept: ReadonlyArray<{
    name: string;
    issues: ReadonlyArray<number>;
    runId: string | null;
    ended: string;
  }>,
) =>
  Effect.gen(function* () {
    windowRuns.push({ runId, parent: null, workflow: idOf("self-improve"), created });
    const fs = yield* FileSystem.FileSystem;
    yield* fs.makeDirectory(runDir(dir, runId), { recursive: true });
    yield* fs.writeFileString(`${runDir(dir, runId)}/improvements.json`, asJson(kept));
  });

const epochOf = (iso: string) => DateTime.toEpochMillis(DateTime.makeUnsafe(iso));
const hoursAgo = (hours: number) =>
  DateTime.formatIso(DateTime.subtract(DateTime.nowUnsafe(), { hours }));

const unstarted = (name: string, issues: ReadonlyArray<number>) => ({
  name,
  issues,
  runId: null,
  ended: "failed to start: an issue it fixes could not be read back from the forge",
});

const issueNumbered = (number: number) => ({
  number,
  title: `Issue ${number}`,
  body: `Body ${number}.\n\n${markerOf(`key-${number}`)}`,
  url: `https://forge.example/project/issues/${number}`,
});

scenario(
  "the next self-improve Run starts an Improvement an earlier one failed to start, while its issue is open",
  () =>
    runEffect(
      Effect.gen(function* () {
        freshDay();
        openIssues = [issueNumbered(7)];
        yield* earlier("r-yesterday", hoursAgo(26), [unstarted("docs", [7])]);
        yield* rig.queueOutputs([triaged([])]);
        yield* improved("r-again", { runs: "checkout", improvements: 1 });
        expect(
          started.map(({ invocation, workflow, ownTask }) => [invocation, workflow, ownTask]),
        ).toEqual([["improvement-docs", "plan", true]]);
        expect(started[0]?.input.then).toBe("implement");
        expect(started[0]?.input.goal).toContain("`Closes #7`");
        expect(started[0]?.input.goal).toContain("Body 7.");
        expect(yield* readText(`${runDir(dir, "r-again")}/summary.md`)).toContain(
          "- docs: r-again-improvement-docs, succeeded",
        );
      }),
    ),
  120_000,
);

scenario(
  "a self-improve Run with no Runs in its window still starts an Improvement an earlier one failed to start",
  () =>
    runEffect(
      Effect.gen(function* () {
        freshDay();
        windowRuns = [];
        openIssues = [issueNumbered(7)];
        yield* earlier("r-yesterday", hoursAgo(25), [unstarted("docs", [7])]);
        yield* improved("r-quiet", { runs: "checkout", improvements: 1 });
        expect(started.map(({ invocation }) => invocation)).toEqual(["improvement-docs"]);
        expect(yield* readText(`${runDir(dir, "r-quiet")}/summary.md`)).toContain(
          "- docs: r-quiet-improvement-docs, succeeded",
        );
      }),
    ),
  120_000,
);

scenario(
  "an earlier failed start is not restarted once its issue is closed, or once a Run since closes it",
  () =>
    runEffect(
      Effect.gen(function* () {
        freshDay();
        openIssues = [issueNumbered(8)];
        yield* earlier("r-yesterday", hoursAgo(26), [
          unstarted("closed", [7]),
          unstarted("taken", [8]),
        ]);
        windowRuns.push({
          runId: "r-person",
          parent: null,
          workflow: "implement",
          created: hoursAgo(20),
          closes: [8],
        });
        yield* rig.queueOutputs([triaged([])]);
        const result = yield* improved("r-again", { runs: "checkout", improvements: 3 });
        expect(started).toEqual([]);
        expect(saidBy(result)).toContain("0 Improvements");
      }),
    ),
  120_000,
);

scenario(
  "a failed start two earlier Runs record is not restarted again once the first restart's child exists",
  () =>
    runEffect(
      Effect.gen(function* () {
        freshDay();
        openIssues = [issueNumbered(7)];
        yield* earlier("r-first", hoursAgo(74), [unstarted("docs", [7])]);
        windowRuns.push({
          runId: "r-second-improvement-docs",
          parent: "r-second",
          workflow: "plan",
          created: hoursAgo(50),
          closes: [7],
        });
        yield* earlier("r-third", hoursAgo(26), [unstarted("docs", [7])]);
        yield* rig.queueOutputs([triaged([])]);
        yield* improved("r-again", { runs: "checkout", improvements: 3 });
        expect(started).toEqual([]);
      }),
    ),
  120_000,
);

scenario(
  "a failed start sharing its name with an earlier one for a closed issue is still restarted, one per name",
  () =>
    runEffect(
      Effect.gen(function* () {
        freshDay();
        openIssues = [issueNumbered(7), issueNumbered(8)];
        yield* earlier("r-first", hoursAgo(74), [unstarted("docs", [6])]);
        yield* earlier("r-second", hoursAgo(50), [unstarted("docs", [7])]);
        yield* earlier("r-third", hoursAgo(26), [unstarted("docs", [8])]);
        yield* rig.queueOutputs([triaged([])]);
        yield* improved("r-again", { runs: "checkout", improvements: 3 });
        expect(started.map(({ invocation }) => invocation)).toEqual(["improvement-docs"]);
        expect(started[0]?.input.goal).toContain("`Closes #7`");
      }),
    ),
  120_000,
);

scenario(
  "restarted and new self-improve Improvements together stay within its bound, restarts first",
  () =>
    runEffect(
      Effect.gen(function* () {
        freshDay();
        openIssues = [issueNumbered(7), issueNumbered(8)];
        yield* earlier("r-yesterday", hoursAgo(26), [
          unstarted("seven", [7]),
          unstarted("eight", [8]),
        ]);
        yield* rig.queueOutputs([
          triaged(
            [finding({ key: "lost-docs" })],
            [{ name: "fresh", keys: ["lost-docs"], why: "one gap" }],
          ),
        ]);
        yield* improved("r-again", { runs: "checkout", improvements: 2 });
        expect(new Set(started.map(({ invocation }) => invocation))).toEqual(
          new Set(["improvement-seven", "improvement-eight"]),
        );
        expect(filed).toHaveLength(1);
      }),
    ),
  120_000,
);

const aDay = () =>
  runEffect(
    Effect.gen(function* () {
      freshDay();
      openIssues = [
        { number: 7, title: "Reads are slow", body: "Slow.", url: "https://x/issues/7" },
        {
          number: 8,
          title: "Checks unwired",
          body: `Unwired.\n\n${markerOf("unwired-checks")}`,
          url: "https://x/issues/8",
        },
      ];
      refusing = new Set(["Project refused-text"]);
      failing = new Set(["improvement-second"]);
      yield* rig.queueOutputs([
        triaged(
          [
            finding({
              key: "host-crash",
              category: "defect",
              runs: ["r-a"],
              body: `Leaked ${LEAKED} in its log.`,
            }),
            finding({ key: "once", runs: ["r-a"] }),
            finding({ key: "costly-reads", category: "tool-economy" }),
            finding({ key: "slow-reads", runs: ["r-a"], issue: 7 }),
            finding({ key: "unwired-checks", category: "automated-checks", runs: ["r-a"] }),
            finding({ key: "refused-text" }),
            finding({ key: "third", severity: "low" }),
          ],
          [
            { name: "first", keys: ["host-crash"], why: "one crash" },
            { name: "with-open", keys: ["third", "slow-reads"], why: "related" },
            { name: "second", keys: ["costly-reads"], why: "one read" },
            { name: "beyond", keys: ["third"], why: "over the bound" },
          ],
        ),
      ]);

      const result = yield* improved("r-day", { runs: "machine", improvements: 2 });

      expect(saidBy(result)).toContain("Filed 3, commented 2, refused 1; 2 Improvements, 1 failed");
      const retro = `${rig.root}/.agents/skills/retro/SKILL.md`;
      const prompt = yield* readText(`${dir}/agents/r-day/triage.prompt.md`);
      expect(prompt).toContain(`read \`${retro}\` and follow it`);
      expect(prompt).toContain("this page wins");
      const persona = yield* readText(`${dir}/agents/r-day/triage.persona.md`);
      expect(persona).toContain("retrospective");
      expect(persona).toContain(`read \`${retro}\` and follow it`);

      expect(filed.map(({ title }) => title)).toEqual([
        "Project host-crash",
        "Project costly-reads",
        "Project third",
      ]);
      expect(filed[0]?.body).toEndWith(
        `${markerOf("host-crash")}\n\nFiled by Collie's self-improve Run r-day on ${hostname()}.`,
      );
      expect(commented.map(({ number }) => number)).toEqual([7, 8]);
      expect(commented[0]?.body).toStartWith("Seen again in r-a ");

      expect(started).toHaveLength(2);
      expect(
        new Set(
          started.map(({ invocation, workflow, ownTask }) => [invocation, workflow, ownTask]),
        ),
      ).toEqual(
        new Set([
          ["improvement-first", "plan", true],
          ["improvement-second", "plan", true],
        ]),
      );
      const first = started.find(({ invocation }) => invocation === "improvement-first");
      const second = started.find(({ invocation }) => invocation === "improvement-second");
      expect(first?.input.then).toBe("implement");
      expect(first?.input.goal).toContain("`Closes #101`");
      expect(first?.input.goal).toContain("Leaked <github token> in its log.");
      expect(asJson(started)).not.toContain(LEAKED);
      expect(second?.input.goal).toContain("`Closes #102`");

      const summary = yield* readText(`${runDir(dir, "r-day")}/summary.md`);
      expect(summary.indexOf("### defect")).toBeLessThan(summary.indexOf("### tool-economy"));
      expect(summary).toContain("refused, it names another checkout");
      expect(summary).toContain("commented #7");
      expect(summary).toContain("r-day-improvement-second, failed: improvement-second failed");
      expect(summary).toContain("Project once: seen once");
      expect(summary).toContain("a service nobody here runs");

      yield* improved("r-day", { runs: "machine", improvements: 2 });
      expect([filed.length, commented.length, started.length]).toEqual([3, 2, 2]);
    }),
  );

scenario(
  "a day's findings are filed or commented, all-new Improvements start, and the summary says so",
  aDay,
  120_000,
);

scenario(
  "a day's Improvements are each read by name, whichever starts first",
  () => {
    startsAfter = new Map([["improvement-first", "improvement-second"]]);
    return aDay();
  },
  120_000,
);

scenario(
  "a self-improve Improvement whose issues cannot be read back fails to start, and the day still ends with its summary",
  () =>
    runEffect(
      Effect.gen(function* () {
        freshDay();
        unlisted = true;
        yield* rig.queueOutputs([
          triaged(
            [finding({ key: "lost-docs" })],
            [{ name: "first", keys: ["lost-docs"], why: "one gap" }],
          ),
        ]);
        const result = yield* improved("r-unlisted", { runs: "checkout", improvements: 1 });
        expect(saidBy(result)).toContain(
          "Filed 1, commented 0, refused 0; 1 Improvements, 1 failed",
        );
        expect(started).toEqual([]);
        expect(yield* readText(`${runDir(dir, "r-unlisted")}/summary.md`)).toContain(
          "the forge did not answer",
        );
      }),
    ),
  120_000,
);

scenario(
  "a self-improve Improvement keyed to issues the Run just filed starts, though the forge's open listing has not caught up",
  () =>
    runEffect(
      Effect.gen(function* () {
        freshDay();
        lagging = true;
        yield* rig.queueOutputs([
          triaged(
            [finding({ key: "lost-docs" }), finding({ key: "stale-docs" })],
            [{ name: "docs", keys: ["lost-docs", "stale-docs"], why: "both docs" }],
          ),
        ]);
        const result = yield* improved("r-lagging", { runs: "checkout", improvements: 1 });
        const summary = yield* readText(`${runDir(dir, "r-lagging")}/summary.md`);
        expect(summary).not.toContain("failed to start");
        expect(saidBy(result)).toContain(
          "Filed 2, commented 0, refused 0; 1 Improvements, 0 failed",
        );
        expect(
          started.map(({ invocation, workflow, ownTask }) => [invocation, workflow, ownTask]),
        ).toEqual([["improvement-docs", "plan", true]]);
        expect(started[0]?.input.then).toBe("implement");
        expect(started[0]?.input.goal).toContain("`Closes #101`, `Closes #102`");
      }),
    ),
  120_000,
);

scenario(
  "a self-improve triage with an unknown category, or more than ten findings, gets its one repair",
  () =>
    runEffect(
      Effect.gen(function* () {
        freshDay();
        yield* rig.queueOutputs([
          { ...triaged([]), findings: [{ ...finding({ key: "odd" }), category: "vibes" }] },
          triaged([finding({ key: "fixed" })]),
          triaged(Array.from({ length: 11 }, (_, at) => finding({ key: `many-${at}` }))),
          triaged([finding({ key: "fewer" })]),
        ]);
        expect(saidBy(yield* improved("r-odd", { runs: "checkout", improvements: 0 }))).toContain(
          "Filed 1",
        );
        expect(saidBy(yield* improved("r-many", { runs: "checkout", improvements: 0 }))).toContain(
          "Filed 1",
        );
        expect(filed.map(({ title }) => title)).toEqual(["Project fixed", "Project fewer"]);
        expect((yield* agentPrompts()).length).toBe(4);
        expect(started).toEqual([]);
      }),
    ),
  120_000,
);

/** One harness commit of `files` over what origin has, as Harness leaves the branch; its sha. */
const harnessCommit = (files: Readonly<Record<string, string>>) =>
  Effect.gen(function* () {
    yield* levelRepository();
    const fs = yield* FileSystem.FileSystem;
    for (const [name, text] of Object.entries(files)) {
      const at = `${rig.projectDir}/${name}`;
      yield* fs.makeDirectory(at.slice(0, at.lastIndexOf("/")), { recursive: true });
      yield* fs.writeFileString(at, text);
    }
    yield* exec(["git", "add", "-A"], { cwd: rig.projectDir });
    yield* exec(["git", "commit", "-qm", "harness"], { cwd: rig.projectDir });
    return yield* headOf();
  }).pipe(Effect.orDie);

/** A steady `count` of 7, and a `value` of 5 or 15 by how often it has run. */
const NOISY_BENCH = [
  'echo x >> "$1"',
  'if [ $(($(wc -l < "$1") % 2)) -eq 1 ]; then v=5; else v=15; fi',
  'printf \'{"value": %s, "count": 7}\\n\' "$v"',
  "",
].join("\n");

const TUNE_DISCOVERED = {
  stack: ["bun", "sqlite"],
  skills: ["performance-optimization"],
  journeys: [
    { name: "search", objectives: [{ metric: "p95 latency", why: "people wait on every search" }] },
  ],
  telemetry: [
    { source: "APM", status: "unavailable", reason: "no APM access from this Machine" },
    { source: "Kibana logs", status: "unavailable", reason: "no Kibana credentials here" },
  ],
  research: [
    {
      kind: "documentation",
      title: "bun:sqlite",
      link: "https://bun.sh/docs/api/sqlite",
      opportunity: "prepared statements",
      effect: "raised",
    },
    {
      kind: "prior-work",
      title: "Slow search",
      link: "https://gitlab.example.com/group/project/-/issues/7",
      opportunity: "an index on name",
      effect: "ruled out",
    },
  ],
  opportunities: [
    {
      title: "prepared statements",
      evidence: "hypothesis",
      cites: ["https://bun.sh/docs/api/sqlite"],
    },
  ],
  external: [],
};

const tunePlan = (
  commit: string,
  metrics: ReadonlyArray<Schema.Json>,
  prepare: Schema.Json = null,
  argv: ReadonlyArray<string> = [],
) => ({
  journeys: ["search"],
  cases: ["warm"],
  commands: [
    {
      name: "bench",
      executable: "sh",
      argv: ["bench/bench.sh", `${rig.root}/bench-runs`, ...argv],
    },
  ],
  prepare,
  metrics,
  warmup: 1,
  harness: { commits: [commit], paths: ["bench"] },
});

const NOISY_PRIMARY = { name: "bench.value", direction: "lower", role: "primary" } as const;
const STEADY_PRIMARY = { name: "bench.count", direction: "lower", role: "primary" } as const;

const tunedUp = (runId: string, input: Readonly<Record<string, Schema.Json>> = {}) =>
  ran({ entry: shipped("tune-up"), runId, input });

const calibrations = (runId: string) =>
  Effect.map(readMeasurements(evidenceDir(dir, runId)), (all) =>
    all.filter((one) => one.pass === "calibration"),
  );

/** How a start of `id` with these words is refused, checked as a front door checks one. */
const refusedAtStart = (id: Shipped, text: Readonly<Record<string, string>>) =>
  session(
    Effect.gen(function* () {
      const registry = yield* Registry;
      const generation = yield* registry.load(shipped(id));
      return yield* registry
        .check({ generation, request: `r-${id}-checked`, project: rig.projectDir, input: {}, text })
        .pipe(Effect.match({ onFailure: (refused) => refused.reason, onSuccess: () => "started" }));
    }).pipe(
      Effect.provide(registryLayer(dir, { placing: foundation().placing, userDir: rig.userDir })),
      Effect.provide(forgeHttpLayer),
      Effect.provide(BunServices.layer),
    ),
  );

scenario(
  "tune-up refuses cycles of 0, 21 and 2.5 at the front door, before any Run starts",
  () =>
    runEffect(
      Effect.gen(function* () {
        yield* repository();
        for (const cycles of ["0", "21", "2.5"]) {
          const reason = yield* refusedAtStart("tune-up", { cycles });
          expect([cycles, reason.startsWith("invalid_input:"), reason]).toEqual([
            cycles,
            true,
            expect.stringContaining("cycles"),
          ]);
        }
        expect(yield* refusedAtStart("tune-up", { cycles: "20" })).toBe("started");
        expect(yield* session(Effect.flatMap(Store, (store) => store.runs))).toEqual([]);
      }),
    ),
  120_000,
);

scenario(
  "tune-up refuses a repository other than the checkout it is started in, and never clones one",
  () =>
    runEffect(
      Effect.gen(function* () {
        yield* repository();
        const elsewhere = `${rig.root}/elsewhere`;
        yield* exec(["git", "init", "-q", elsewhere], { cwd: rig.root });
        for (const named of [elsewhere, "https://gitlab.example.com/group/other.git"]) {
          const reason = yield* refusedAtStart("tune-up", { repository: named });
          expect(reason).toStartWith("invalid_input:");
          expect(reason).toContain(named);
          expect(reason).toContain("from Home");
        }
        expect(yield* refusedAtStart("tune-up", { repository: rig.projectDir })).toBe("started");
      }),
    ),
  120_000,
);

scenario(
  "a tune-up whose base is too noisy against itself, with no counter, completes with its findings and no merge request",
  () =>
    runEffect(
      Effect.gen(function* () {
        const commit = yield* harnessCommit({ "bench/bench.sh": NOISY_BENCH });
        const runId = "r-tune-noisy";
        yield* rig.queueOutputs([TUNE_DISCOVERED, tunePlan(commit, [NOISY_PRIMARY])]);
        const result = yield* tunedUp(runId);
        expect(result._tag).toBe("Success");
        expect(said(result)).toContain("proof unavailable: bench.value is inconclusive");
        expect(yield* persona(runId, "discover")).toContain("tuner");
        const log = yield* runLog(runId);
        expect(log).toContain("cycles 5");
        expect(log).toContain("proof unavailable: bench.value is inconclusive");
        // Every telemetry source Discover could not use, with why.
        expect(log).toContain("telemetry APM: unavailable: no APM access from this Machine");
        expect(log).toContain("telemetry Kibana logs: unavailable: no Kibana credentials here");
        expect(yield* wasAsked(runId, "mr")).toBe(false);
        const [calibration, ...more] = yield* calibrations(runId);
        expect(more).toEqual([]);
        // Base against base: the base tree is the merge base with the harness on it.
        expect(calibration!.candidate.content).toBe(calibration!.base.content);
        expect(calibration!.base.commit).toBe(yield* revParse(`${commit}~1`));
        expect(calibration!.plan.samples).toBe(10);
        const report = yield* readText(said(result).split(": ")[0]!);
        expect(report).toContain("no APM access from this Machine");
      }),
    ),
  120_000,
);

scenario(
  "a tune-up whose primary is too noisy but declared a counter for it calibrates again on the counter, and records the switch",
  () =>
    runEffect(
      Effect.gen(function* () {
        const commit = yield* harnessCommit({ "bench/bench.sh": NOISY_BENCH });
        const runId = "r-tune-counter";
        yield* rig.queueOutputs([
          TUNE_DISCOVERED,
          tunePlan(commit, [
            { ...NOISY_PRIMARY, counter: { name: "bench.count", direction: "lower" } },
          ]),
          EXHAUSTED,
        ]);
        const result = yield* tunedUp(runId, { samples: 4 });
        expect(result._tag).toBe("Success");
        expect(said(result)).not.toContain("proof unavailable");
        expect(yield* runLog(runId)).toContain("calibrated on bench.count");
        expect(yield* runLog(runId)).toContain(
          "switched bench.value to its counter bench.count: bench.value is inconclusive",
        );
        const [first, second] = yield* calibrations(runId);
        expect(first!.plan.metrics.map((one) => one.name)).toEqual(["bench.value"]);
        expect(second!.plan.metrics).toEqual([STEADY_PRIMARY]);
        expect(second!.plan.samples).toBe(4);
      }),
    ),
  120_000,
);

scenario(
  "a tune-up whose guardrail is not held against itself, with no counter for it, ends naming that guardrail",
  () =>
    runEffect(
      Effect.gen(function* () {
        const commit = yield* harnessCommit({ "bench/bench.sh": NOISY_BENCH });
        const runId = "r-tune-guardrail";
        yield* rig.queueOutputs([
          TUNE_DISCOVERED,
          tunePlan(commit, [STEADY_PRIMARY, { ...NOISY_PRIMARY, role: "guardrail" }]),
        ]);
        const result = yield* tunedUp(runId);
        expect(result._tag).toBe("Success");
        expect(said(result)).toContain(
          "proof unavailable: guardrail bench.value is not held against itself",
        );
        expect(said(result)).not.toContain("bench.count");
        expect(yield* wasAsked(runId, "mr")).toBe(false);
      }),
    ),
  120_000,
);

for (const [what, unusable] of [
  ["no research", { ...TUNE_DISCOVERED, research: [] }],
  [
    "an opportunity citing nothing",
    {
      ...TUNE_DISCOVERED,
      opportunities: [{ ...TUNE_DISCOVERED.opportunities[0]!, cites: [] }],
    },
  ],
] as const)
  scenario(
    `a tune-up Discover Output with ${what} is refused and repaired, and its research is recorded under the opportunity it changed`,
    () =>
      runEffect(
        Effect.gen(function* () {
          const commit = yield* harnessCommit({ "bench/bench.sh": NOISY_BENCH });
          const runId = "r-tune-research";
          yield* rig.queueOutputs([unusable, TUNE_DISCOVERED, tunePlan(commit, [NOISY_PRIMARY])]);
          const result = yield* tunedUp(runId);
          expect(result._tag).toBe("Success");
          expect(yield* agentPrompts()).toHaveLength(3);
          const log = yield* runLog(runId);
          expect(log).toContain(
            "research https://bun.sh/docs/api/sqlite raised prepared statements",
          );
          expect(log).toContain(
            "research https://gitlab.example.com/group/project/-/issues/7 ruled out an index on name",
          );
          const report = yield* readText(said(result).split(": ")[0]!);
          // Each source on the line under the opportunity it changed.
          const lines = report.split("\n");
          const under = (opportunity: string) =>
            lines[lines.findIndex((line) => line.includes(opportunity)) + 1];
          expect(under("prepared statements")).toContain("raised by");
          expect(under("prepared statements")).toContain("https://bun.sh/docs/api/sqlite");
          expect(under("an index on name")).toContain("ruled out by");
          expect(under("an index on name")).toContain(
            "https://gitlab.example.com/group/project/-/issues/7",
          );
        }),
      ),
    120_000,
  );

scenario(
  "a tune-up harness commit touching a path outside the harness fails the Run, naming it",
  () =>
    runEffect(
      Effect.gen(function* () {
        const commit = yield* harnessCommit({ "bench/bench.sh": NOISY_BENCH, README: "faster\n" });
        yield* rig.queueOutputs([TUNE_DISCOVERED, tunePlan(commit, [STEADY_PRIMARY])]);
        const result = yield* tunedUp("r-tune-stray");
        expect(result._tag).toBe("Failure");
        expect(reasonOf(result)).toContain("README");
        expect(reasonOf(result)).not.toContain("bench/bench.sh");
      }),
    ),
  120_000,
);

scenario(
  "a tune-up whose base cannot be built fails the Run, naming the tree",
  () =>
    runEffect(
      Effect.gen(function* () {
        const commit = yield* harnessCommit({ "bench/bench.sh": NOISY_BENCH });
        yield* rig.queueOutputs([
          TUNE_DISCOVERED,
          tunePlan(commit, [STEADY_PRIMARY], { executable: "sh", argv: ["-c", "exit 3"] }),
        ]);
        const result = yield* tunedUp("r-tune-unbuildable");
        expect(result._tag).toBe("Failure");
        expect(reasonOf(result)).toContain(
          `the base tree at ${yield* revParse(`${commit}~1`)} could not be built`,
        );
      }),
    ),
  120_000,
);

/**
 * `count` and `size` read from files a Cycle may commit; `count` is 3 wherever the default
 * branch brought `fixed`, and `size` swings while `jitter` is there.
 */
const CYCLE_BENCH = [
  "count=7; [ -f count ] && count=$(cat count)",
  "[ -f fixed ] && count=3",
  "size=100; [ -f size ] && size=$(cat size)",
  'if [ -e jitter ]; then echo x >> "$1"; if [ $(($(wc -l < "$1") % 2)) -eq 1 ]; then size=60; else size=140; fi; fi',
  'printf \'{"count": %s, "size": %s}\\n\' "$count" "$size"',
  "",
].join("\n");

const SIZE_GUARDRAIL = { name: "bench.size", direction: "lower", role: "guardrail" } as const;

/** `script` run in the Run's checkout, as the tuner runs it. */
const inCheckout = (script: string) => `cd '${rig.projectDir}' && ${script}`;

const tried = (script: string) => ({
  writes: [],
  sh: inCheckout(`${script} && git commit -qm cycle`),
  output: {
    result: "changed",
    opportunity: "prepared statements",
    change: "search prepares its statement once",
    commits: ["HEAD"],
  },
});
const NO_CHANGE = () => tried("echo note > notes && git add notes");
const FASTER = () => tried("echo 3 > count && git add count");
const FASTER_BUT_LARGER = () => tried("echo 3 > count && echo 200 > size && git add count size");
const FASTER_BUT_JITTERY = () => tried("echo 3 > count && touch jitter && git add count jitter");
const FASTER_BUT_BROKEN = () => tried("echo 3 > count && touch broken && git add count broken");
const RESET = () => asTold("true", "reset");
const EXHAUSTED = { result: "exhausted", why: "every ranked opportunity has been tried" };

/** A tune-up that calibrates, then answers each Cycle's prompt with the next of `turns`. */
const cycling = (
  runId: string,
  turns: ReadonlyArray<Schema.Json>,
  argv: ReadonlyArray<string> = [],
  discovered: Schema.Json = TUNE_DISCOVERED,
) =>
  Effect.gen(function* () {
    const commit = yield* harnessCommit({ "bench/bench.sh": CYCLE_BENCH });
    yield* checkedBy(runId, "unit", "sh", ["-c", "test ! -e broken"]);
    // The project the fake forge knows, for a Run that gets as far as its merge request.
    yield* exec(["git", "remote", "set-url", "upstream", DELIVERY.gitlab.origin], {
      cwd: rig.projectDir,
    }).pipe(Effect.orDie);
    yield* rig.queueOutputs([
      discovered,
      tunePlan(commit, [STEADY_PRIMARY, SIZE_GUARDRAIL], null, argv),
      ...turns,
    ]);
    return commit;
  });

/** Each Cycle's tree where the log says it started, and where it says it was reverted to. */
const cycleTrees = (runId: string) =>
  Effect.map(runLog(runId), (log) => {
    const trees = (said: string) =>
      Object.fromEntries(
        [...log.matchAll(new RegExp(`cycle (\\d+) ${said} (\\S+) (\\S+?):?(?:\\s|$)`, "g"))].map(
          (one) => [one[1]!, { head: one[2]!, fingerprint: one[3]! }],
        ),
      );
    return { started: trees("started on"), reverted: trees("reverted to") };
  });

const cyclesMeasured = (runId: string) =>
  Effect.map(readMeasurements(evidenceDir(dir, runId)), (all) =>
    all.filter((one) => one.pass.startsWith("cycle ")),
  );

/** The tree the Run's checkout holds now, read by the test rather than the Run. */
const checkoutNow = (runId: string) =>
  Effect.gen(function* () {
    const [first] = yield* cyclesMeasured(runId);
    const now = yield* fingerprint(first!.candidate.cwd);
    return { head: now.head_sha, fingerprint: now.fingerprint };
  });

const cyclePrompts = (runId: string) =>
  Effect.map(prompts(), (all) =>
    all.flatMap((one) => {
      const named = new RegExp(`/${runId}/(cycle-\\d+(?:-revert)?)\\.prompt\\.md`).exec(one);
      return named === null ? [] : [named[1]!];
    }),
  );

scenario(
  "a tune-up Cycle with no change and one whose guardrail regresses are each reverted to the tree it started on, and two in a row stop the Run with its findings",
  () =>
    runEffect(
      Effect.gen(function* () {
        const runId = "r-tune-reverted";
        const commit = yield* cycling(runId, [NO_CHANGE(), RESET(), FASTER_BUT_LARGER(), RESET()]);
        const result = yield* tunedUp(runId, { samples: 4 });
        expect(result._tag).toBe("Success");
        expect(said(result)).toContain("two consecutive Cycles were not kept");
        expect(yield* wasAsked(runId, "mr")).toBe(false);
        expect(yield* cyclePrompts(runId)).toEqual([
          "cycle-1",
          "cycle-1-revert",
          "cycle-2",
          "cycle-2-revert",
        ]);
        const verdicts = (yield* cyclesMeasured(runId)).map((one) =>
          one.result._tag === "Judged"
            ? one.result.verdicts.map((judged) => `${judged.metric} ${judged.verdict}`)
            : [],
        );
        expect(verdicts).toEqual([
          ["bench.count no-change", "bench.size no-change"],
          ["bench.count gain", "bench.size regression"],
        ]);
        const { started, reverted } = yield* cycleTrees(runId);
        expect(started["1"]?.head).toBe(commit);
        expect(reverted).toEqual(started);
        expect(yield* checkoutNow(runId)).toEqual(started["1"]!);
        const log = yield* runLog(runId);
        expect(log).toContain("cycle 1 reverted to");
        expect(log).toContain("bench.count no-change");
        expect(log).toContain("guardrail bench.size regression");
        const report = yield* readText(said(result).split(": ")[0]!);
        expect(report).toContain("## Cycles");
        expect(report).toContain("two consecutive Cycles were not kept");
      }),
    ),
  120_000,
);

scenario(
  "a tune-up Cycle whose primary gains but whose guardrail is inconclusive is reverted",
  () =>
    runEffect(
      Effect.gen(function* () {
        const runId = "r-tune-jittery";
        yield* cycling(runId, [FASTER_BUT_JITTERY(), RESET()]);
        const result = yield* tunedUp(runId, { samples: 4, cycles: 1 });
        expect(result._tag).toBe("Success");
        const [measured] = yield* cyclesMeasured(runId);
        expect(measured?.result._tag === "Judged" && measured.result.verdicts).toEqual([
          expect.objectContaining({ metric: "bench.count", verdict: "gain" }),
          expect.objectContaining({ metric: "bench.size", verdict: "inconclusive" }),
        ]);
        const { started, reverted } = yield* cycleTrees(runId);
        expect(reverted["1"]).toEqual(started["1"]);
        expect(yield* runLog(runId)).toContain("guardrail bench.size inconclusive");
        expect(said(result)).toContain("cycles spent: 1 of 1");
      }),
    ),
  120_000,
);

scenario(
  "a tune-up Cycle whose checks fail is reverted though it measures a gain, and the Run completes with its findings",
  () =>
    runEffect(
      Effect.gen(function* () {
        const runId = "r-tune-broken";
        yield* cycling(runId, [FASTER_BUT_BROKEN(), RESET()]);
        const result = yield* tunedUp(runId, { samples: 4, cycles: 1 });
        expect(result._tag).toBe("Success");
        const [measured] = yield* cyclesMeasured(runId);
        expect(measured?.result._tag === "Judged" && measured.result.verdicts[0]?.verdict).toBe(
          "gain",
        );
        const { started, reverted } = yield* cycleTrees(runId);
        expect(reverted["1"]).toEqual(started["1"]);
        expect(yield* runLog(runId)).toContain("cycle 1 reverted to");
        expect(yield* runLog(runId)).toContain("checks failed: unit");
        expect(yield* wasAsked(runId, "mr")).toBe(false);
        expect(yield* readText(said(result).split(": ")[0]!)).toContain("checks failed: unit");
      }),
    ),
  120_000,
);

scenario(
  "a tune-up revert that leaves another tree fails the Run, naming both trees",
  () =>
    runEffect(
      Effect.gen(function* () {
        const runId = "r-tune-unreverted";
        yield* cycling(runId, [NO_CHANGE(), { ...RESET(), sh: inCheckout("true") }]);
        const result = yield* tunedUp(runId, { samples: 4 });
        expect(result._tag).toBe("Failure");
        const { started } = yield* cycleTrees(runId);
        const now = yield* checkoutNow(runId);
        expect(now.head).not.toBe(started["1"]?.head);
        expect(reasonOf(result)).toContain(started["1"]!.head);
        expect(reasonOf(result)).toContain(now.head);
        expect(yield* cyclePrompts(runId)).toEqual(["cycle-1", "cycle-1-revert"]);
      }),
    ),
  120_000,
);

/** After `before`, what the fenced `sh` block of the agent's own prompt says, run in the checkout; it answers whatever that did. */
const asTold = (before: string, output: Schema.Json) => ({
  writes: [],
  sh: inCheckout(
    `${before} && sed -n '/^\`\`\`sh$/,/^\`\`\`$/p' "$PROMPT_PATH" | sed '1d;$d' | sh; true`,
  ),
  output,
});

scenario(
  "a tune-up revert keeps uncommitted work it did not make, and fails the Run naming both trees rather than lose it",
  () =>
    runEffect(
      Effect.gen(function* () {
        const runId = "r-tune-dirty-revert";
        yield* cycling(runId, [NO_CHANGE(), asTold("echo '# mine' >> bench/bench.sh", "reset")]);
        const result = yield* tunedUp(runId, { samples: 4, cycles: 1 });
        expect(yield* readText(`${rig.projectDir}/bench/bench.sh`)).toEndWith("# mine\n");
        expect(result._tag).toBe("Failure");
        expect(reasonOf(result)).toContain((yield* cycleTrees(runId)).started["1"]!.head);
      }),
    ),
  120_000,
);

scenario(
  "a tune-up revert takes back nothing once another commit lands after its Cycle, and fails the Run naming both trees",
  () =>
    runEffect(
      Effect.gen(function* () {
        const runId = "r-tune-foreign-revert";
        yield* cycling(runId, [
          NO_CHANGE(),
          asTold("echo theirs > theirs && git add theirs && git commit -qm theirs", "reset"),
        ]);
        const result = yield* tunedUp(runId, { samples: 4, cycles: 1 });
        expect(yield* readText(`${rig.projectDir}/theirs`)).toBe("theirs\n");
        expect(yield* readText(`${rig.projectDir}/notes`)).toBe("note\n");
        expect(result._tag).toBe("Failure");
        expect(reasonOf(result)).toContain((yield* cycleTrees(runId)).started["1"]!.head);
      }),
    ),
  120_000,
);

scenario(
  "a tune-up drop keeps uncommitted work it did not make",
  () =>
    runEffect(
      Effect.gen(function* () {
        const runId = "r-tune-dirty-drop";
        yield* cycling(runId, [
          fasterWhileUpstreamPushes(3, "fixed"),
          asTold("echo '# mine' >> bench/bench.sh", "dropped"),
        ]);
        yield* tunedUp(runId, { samples: 4, cycles: 1 });
        expect(yield* wasAsked(runId, "drop")).toBe(true);
        expect(yield* readText(`${rig.projectDir}/bench/bench.sh`)).toEndWith("# mine\n");
        const [final] = yield* finals(runId);
        expect(yield* checkoutTree()).toBe(final!.base.content);
      }),
    ),
  120_000,
);

scenario(
  "a tune-up drop takes back nothing once another commit lands, and fails the Run naming both trees",
  () =>
    runEffect(
      Effect.gen(function* () {
        const runId = "r-tune-foreign-drop";
        yield* cycling(runId, [
          fasterWhileUpstreamPushes(3, "fixed"),
          asTold("echo theirs > theirs && git add theirs && git commit -qm theirs", "dropped"),
        ]);
        const result = yield* tunedUp(runId, { samples: 4, cycles: 1 });
        expect(yield* wasAsked(runId, "drop")).toBe(true);
        expect(yield* readText(`${rig.projectDir}/theirs`)).toBe("theirs\n");
        expect(result._tag).toBe("Failure");
        const [final] = yield* finals(runId);
        expect(reasonOf(result)).toContain(final!.base.head_sha);
      }),
    ),
  120_000,
);

scenario(
  "a tune-up tuner that has no opportunity left stops the Run with that reason, before its cycles are spent",
  () =>
    runEffect(
      Effect.gen(function* () {
        const runId = "r-tune-exhausted";
        yield* cycling(runId, [EXHAUSTED]);
        const result = yield* tunedUp(runId, { samples: 4 });
        expect(result._tag).toBe("Success");
        expect(said(result)).toContain(
          "no measured opportunity is left: every ranked opportunity has been tried",
        );
        expect(yield* cyclePrompts(runId)).toEqual(["cycle-1"]);
        expect(yield* cyclesMeasured(runId)).toEqual([]);
      }),
    ),
  120_000,
);

scenario(
  "a tune-up host restarted in the middle of Cycle 2 resumes in Cycle 2 and runs no more than its cycles",
  () =>
    runEffect(
      Effect.gen(function* () {
        const runId = "r-tune-restart";
        const { bin } = yield* tuneForge;
        yield* cycling(runId, [
          NO_CHANGE(),
          RESET(),
          FASTER(),
          NO_CHANGE(),
          RESET(),
          TUNE_REVIEWED,
          OPENED,
        ]);
        const options = { entry: shipped("tune-up"), runId, input: { samples: 4, cycles: 3 } };
        yield* running(options, () =>
          until(
            () => wasAsked(runId, "cycle-2"),
            (asked) => asked,
          ),
        );
        expect(yield* cyclePrompts(runId)).toEqual(["cycle-1", "cycle-1-revert", "cycle-2"]);
        const result = yield* resumed(options);
        expect(yield* cyclePrompts(runId)).toEqual([
          "cycle-1",
          "cycle-1-revert",
          "cycle-2",
          "cycle-3",
          "cycle-3-revert",
        ]);
        expect((yield* cyclesMeasured(runId)).map((one) => one.pass)).toEqual([
          "cycle 1",
          "cycle 2",
          "cycle 3",
        ]);
        yield* bin.restore();
        expect(said(result)).toBe(OPENED.mr_url);
      }),
    ),
  120_000,
);

/** A clock two hours ahead once `marker` holds anything, as a Cycle that ran long would leave it. */
const lateOnce = (marker: string) =>
  Effect.map(Clock.Clock, (clock): Clock.Clock => {
    const ahead = () => (Bun.file(marker).size > 0 ? 2 * 60 * 60 * 1000 : 0);
    const millis = () => clock.currentTimeMillisUnsafe() + ahead();
    const nanos = () => clock.currentTimeNanosUnsafe() + BigInt(ahead()) * 1_000_000n;
    return {
      currentTimeMillisUnsafe: millis,
      currentTimeMillis: Effect.sync(millis),
      currentTimeNanosUnsafe: nanos,
      currentTimeNanos: Effect.sync(nanos),
      monotonicTimeNanosUnsafe: () => clock.monotonicTimeNanosUnsafe(),
      monotonicTimeNanos: clock.monotonicTimeNanos,
      sleep: (duration) => clock.sleep(duration),
    };
  });

scenario(
  "a tune-up whose wall time runs out during a Cycle finishes that Cycle and starts no other",
  () =>
    runEffect(
      Effect.gen(function* () {
        const runId = "r-tune-late";
        const marker = `${rig.root}/late`;
        yield* cycling(runId, [
          { ...NO_CHANGE(), sh: `echo late > '${marker}' && ${NO_CHANGE().sh}` },
          RESET(),
        ]);
        const result = yield* tunedUp(runId, { samples: 4, wall_time: "1 hour" }).pipe(
          Effect.provideServiceEffect(Clock.Clock, lateOnce(marker)),
        );
        expect(result._tag).toBe("Success");
        expect(said(result)).toContain("wall time 1 hour spent");
        expect(yield* cyclePrompts(runId)).toEqual(["cycle-1", "cycle-1-revert"]);
        expect((yield* cyclesMeasured(runId)).map((one) => one.pass)).toEqual(["cycle 1"]);
        const { started, reverted } = yield* cycleTrees(runId);
        expect(reverted["1"]).toEqual(started["1"]);
      }),
    ),
  120_000,
);

scenario(
  "a tune-up whose wall time is spent by the end of Calibrate runs no Cycle and ends with its findings",
  () =>
    runEffect(
      Effect.gen(function* () {
        const runId = "r-tune-no-time";
        yield* cycling(runId, []);
        const result = yield* tunedUp(runId, { samples: 4, wall_time: "1 millis" });
        expect(result._tag).toBe("Success");
        expect(said(result)).toContain("wall time 1 millis spent before Cycle 1");
        expect(yield* cyclePrompts(runId)).toEqual([]);
        expect(yield* wasAsked(runId, "mr")).toBe(false);
        expect(yield* readText(said(result).split(": ")[0]!)).toContain(
          "wall time 1 millis spent before Cycle 1",
        );
      }),
    ),
  120_000,
);

scenario("tune-up refuses a wall time that is not a duration at the front door", () =>
  runEffect(
    Effect.gen(function* () {
      yield* repository();
      const reason = yield* refusedAtStart("tune-up", { wall_time: "soon" });
      expect(reason).toStartWith("invalid_input:");
      expect(reason).toContain("wall_time");
      expect(yield* refusedAtStart("tune-up", { wall_time: "2 hours" })).toBe("started");
    }),
  ),
);

const fasterTo = (count: number) => tried(`echo ${count} > count && git add count`);

/** The default branch moved by somebody else while a Cycle runs: `file` pushed to origin. */
const upstreamPushes = (file: string) =>
  `(git clone -q '${rig.root}/project-origin.git' '${rig.root}/upstream' && cd '${rig.root}/upstream' && echo theirs > ${file} && git add ${file} && git -c user.email=u@example.com -c user.name=u commit -qm upstream && git push -q origin HEAD)`;
const fasterWhileUpstreamPushes = (count: number, file: string) => {
  const turn = fasterTo(count);
  return { ...turn, sh: `${upstreamPushes(file)} && ${turn.sh}` };
};

const TUNE_REVIEWED = {
  verdict: "clean",
  summary: "Search prepares its statement once; the bench runs search as people do.",
  findings: [],
  dropped: [],
  fixed: [],
  behavior_preserved: true,
  measurement_valid: true,
};

/** The fake glab and gh on PATH, with no merge request yet. */
const tuneForge = Effect.gen(function* () {
  const bin = yield* FakeBin.make(`${rig.root}/bin`);
  const forge = yield* forgeOnPath(bin, "gitlab", {
    installed: true,
    loggedIn: [FORGE_HOST.gitlab],
    login: "tester",
    mrs: [],
  });
  yield* forgeOnPath(bin, "github", { installed: true, loggedIn: [], login: null, mrs: [] });
  return { bin, forge };
});

const finals = (runId: string) =>
  Effect.map(readMeasurements(evidenceDir(dir, runId)), (all) =>
    all.filter((one) => one.pass === "final"),
  );

const verdictsOf = (measured: { readonly result: Measurement["result"] }) =>
  measured.result._tag === "Judged"
    ? measured.result.verdicts.map(
        (one) => `${one.metric} ${one.verdict}${one.held ? "" : ", not held"}`,
      )
    : [measured.result._tag];

const originHead = () =>
  Effect.map(
    exec(["git", "--git-dir", `${rig.root}/project-origin.git`, "rev-parse", "HEAD"], {
      cwd: rig.root,
    }),
    (ran) => ran.stdout.trim(),
  );

const checkoutTree = () =>
  Effect.map(exec(["git", "rev-parse", "HEAD^{tree}"], { cwd: rig.projectDir }), (ran) =>
    ran.stdout.trim(),
  );

const SECRET = "sk-live0123456789abcdefXYZ";

scenario(
  "a tune-up with two kept Cycles proves their tree against the merge base, has it reviewed and opens one merge request written from the Measurements",
  () =>
    runEffect(
      Effect.gen(function* () {
        const runId = "r-tune-delivered";
        const { bin, forge } = yield* tuneForge;
        const commit = yield* cycling(
          runId,
          [fasterTo(5), fasterTo(3), TUNE_REVIEWED, OPENED],
          [`API_TOKEN=${SECRET}`],
        );
        const result = yield* tunedUp(runId, { samples: 4, cycles: 2 });
        yield* bin.restore();
        expect(said(result)).toBe(OPENED.mr_url);
        expect((yield* cyclesMeasured(runId)).map(verdictsOf)).toEqual([
          ["bench.count gain", "bench.size no-change"],
          ["bench.count gain", "bench.size no-change"],
        ]);
        const [final, ...more] = yield* finals(runId);
        expect(more).toEqual([]);
        const head = yield* headOf();
        expect(final!.base.commit).toBe(yield* originHead());
        expect(final!.candidate.head_sha).toBe(head);
        expect(verdictsOf(final!)).toEqual(["bench.count gain", "bench.size no-change"]);
        const review = yield* asked(runId, "review-1");
        expect(review).toContain("measurement_valid");
        expect(review).toContain("the harness kept apart from the product");
        expect(yield* runLog(runId)).toContain(`performance proved on ${head}`);
        expect((yield* forge.model()).merges ?? []).toEqual([]);

        const body = yield* readText(`${runDir(dir, runId)}/handoffs/tune-up-merge-request.md`);
        expect(yield* asked(runId, "mr")).toContain(
          `${runDir(dir, runId)}/handoffs/tune-up-merge-request.md`,
        );
        expect(body).toContain("| bench.count | primary | 7 | 3 |");
        const [table, evidence] = body.split("<details>");
        expect(table).toContain(final!.id);
        for (const metric of ["bench.count", "bench.size"])
          for (const side of ["base", "candidate"] as const) {
            const line = evidence!
              .split("\n")
              .find((one) => one.startsWith(`- ${metric}, ${side}:`));
            const listed = line!
              .split(":")[1]!
              .split(",")
              .map((one) => Number(one.trim()));
            expect(listed).toEqual(
              final!.samples
                .filter((one) => one.tree === side && !one.warmup)
                .map((one) => one.readings[metric]!),
            );
          }
        for (const text of [
          "bench/bench.sh",
          commit,
          final!.base.commit,
          final!.base.head_sha,
          final!.candidate.head_sha,
          runId,
        ])
          expect(evidence).toContain(text);
        expect(body).not.toContain(SECRET);
      }),
    ),
  120_000,
);

scenario(
  "a tune-up whose default branch moved during its Cycles merges it, and takes its final Measurement against the new merge base",
  () =>
    runEffect(
      Effect.gen(function* () {
        const runId = "r-tune-moved";
        const { bin } = yield* tuneForge;
        yield* cycling(runId, [
          fasterTo(5),
          fasterWhileUpstreamPushes(3, "upstream.txt"),
          TUNE_REVIEWED,
          OPENED,
        ]);
        const original = yield* originHead();
        const result = yield* tunedUp(runId, { samples: 4, cycles: 2 });
        yield* bin.restore();
        expect(said(result)).toBe(OPENED.mr_url);
        const moved = yield* originHead();
        expect(moved).not.toBe(original);
        expect(yield* runLog(runId)).toMatch(new RegExp(`integrated \\S+@${moved}`));
        const measured = yield* finals(runId);
        expect(measured.map((one) => one.base.commit)).toEqual([moved, original]);
        expect(verdictsOf(measured[0]!)).toEqual(["bench.count gain", "bench.size no-change"]);
        expect(measured.map((one) => one.candidate.head_sha)).toEqual([
          yield* headOf(),
          yield* headOf(),
        ]);
        expect(yield* readText(`${rig.projectDir}/upstream.txt`)).toBe("theirs\n");
      }),
    ),
  120_000,
);

scenario(
  "a tune-up whose final Measurement is no-change once integrated drops back to its base tree, and completes with its findings and no merge request",
  () =>
    runEffect(
      Effect.gen(function* () {
        const runId = "r-tune-lost";
        yield* cycling(runId, [
          fasterWhileUpstreamPushes(3, "fixed"),
          {
            writes: [],
            sh: inCheckout("git rm -q count && git commit -qm drop"),
            output: "dropped",
          },
        ]);
        const result = yield* tunedUp(runId, { samples: 4, cycles: 1 });
        expect(result._tag).toBe("Success");
        expect(yield* wasAsked(runId, "mr")).toBe(false);
        expect(yield* wasAsked(runId, "drop")).toBe(true);
        const [final, ...more] = yield* finals(runId);
        expect(more).toEqual([]);
        expect(final!.base.commit).toBe(yield* originHead());
        expect(verdictsOf(final!)).toEqual(["bench.count no-change", "bench.size no-change"]);
        expect(yield* checkoutTree()).toBe(final!.base.content);
        expect(said(result)).toContain("bench.count no-change, not a gain");
        expect(yield* readText(said(result).split(": ")[0]!)).toContain(final!.id);
      }),
    ),
  120_000,
);

/** The merge request opened on the checkout's head, its CI job failing there and green at the base. */
const openedFailing = (forge: {
  readonly holding: (next: ForgeModel) => { path: string; text: string };
}) => {
  const write = forge.holding(ciOn("OPENED_AT", ciFailing, "passed"));
  return {
    writes: [write],
    sh: `sed -i "s/OPENED_AT/$(git -C '${rig.projectDir}' rev-parse HEAD)/" '${write.path}'`,
    output: OPENED_CI,
  };
};

/** A CI fix that commits `count` and whose new head's job passes. */
const ciFixedTo = (
  forge: { readonly holding: (next: ForgeModel) => { path: string; text: string } },
  count: number,
) => {
  const write = forge.holding(ciOn("FIXED_AT", { name: "nuxi-job", state: "passed" }, "passed"));
  return {
    writes: [write],
    sh: `${inCheckout(`echo ${count} > count && git add count && git commit -qm ci-fix`)} && sed -i "s/FIXED_AT/$(git -C '${rig.projectDir}' rev-parse HEAD)/" '${write.path}'`,
    output: { ...GATE_FIX, fixed: [{ title: "nuxi: its CI job nuxi-job failed" }] },
  };
};

scenario(
  "a tune-up CI fix that changes product code is measured and reviewed again on the delivered head, and performance closes there",
  () =>
    runEffect(
      Effect.gen(function* () {
        const runId = "r-tune-ci-fixed";
        const { bin, forge } = yield* tuneForge;
        yield* cycling(runId, [
          fasterTo(3),
          TUNE_REVIEWED,
          openedFailing(forge),
          ciFixedTo(forge, 2),
          TUNE_REVIEWED,
        ]);
        yield* leftToCi(runId, ["nuxi"]);
        const result = yield* tunedUp(runId, { samples: 4, cycles: 1 });
        yield* bin.restore();
        expect(said(result)).toBe(CI_MR);
        const head = yield* headOf();
        const measured = yield* finals(runId);
        expect(measured).toHaveLength(2);
        expect(measured[1]!.candidate.head_sha).toBe(head);
        expect(measured[0]!.candidate.head_sha).not.toBe(head);
        expect(verdictsOf(measured[1]!)).toEqual(["bench.count gain", "bench.size no-change"]);
        expect(yield* wasAsked(runId, "ci-fix-1.review-1")).toBe(true);
        expect(yield* runLog(runId)).toContain(`performance proved on ${head}`);
        // The merge request is told the whole replacement evidence, not only its table.
        const noted = (yield* ciNotes(forge)).join("\n");
        expect(noted).toContain(`Samples of \`final\` Measurement ${measured[1]!.id}`);
        expect(noted).toContain(head);
        expect(noted).toContain("#### Reproduce");
      }),
    ),
  120_000,
);

scenario(
  "a tune-up CI fix that loses the gain leaves its merge request not ready, and the Run fails saying so",
  () =>
    runEffect(
      Effect.gen(function* () {
        const runId = "r-tune-ci-lost";
        const { bin, forge } = yield* tuneForge;
        yield* cycling(runId, [
          fasterTo(3),
          TUNE_REVIEWED,
          openedFailing(forge),
          ciFixedTo(forge, 7),
          TUNE_REVIEWED,
        ]);
        yield* leftToCi(runId, ["nuxi"]);
        const result = yield* tunedUp(runId, { samples: 4, cycles: 1 });
        expect(result._tag).toBe("Failure");
        const measured = yield* finals(runId);
        expect(verdictsOf(measured.at(-1)!)).toEqual([
          "bench.count no-change",
          "bench.size no-change",
        ]);
        expect(reasonOf(result)).toContain(`${CI_MR} is not ready`);
        expect(reasonOf(result)).toContain("bench.count no-change, not a gain");
        expect((yield* ciNotes(forge)).join("\n")).toContain("not ready");
        expect((yield* forge.model()).merges ?? []).toEqual([]);
        yield* bin.restore();
      }),
    ),
  120_000,
);

scenario(
  "a tune-up reviewer's blocker is fixed in the rally, and the fix gets a final Measurement of its own",
  () =>
    runEffect(
      Effect.gen(function* () {
        const runId = "r-tune-blocked";
        const blocker = "search drops results past the hundredth";
        const { bin } = yield* tuneForge;
        yield* cycling(runId, [
          fasterTo(3),
          {
            ...TUNE_REVIEWED,
            verdict: "findings",
            findings: [{ severity: "blocker", title: blocker, file: "count" }],
            behavior_preserved: false,
          },
          {
            writes: [],
            sh: inCheckout("echo 2 > count && git add count && git commit -qm fix"),
            output: { ...GATE_FIX, fixed: [{ title: blocker, file: "count" }] },
          },
          TUNE_REVIEWED,
          OPENED,
        ]);
        const result = yield* tunedUp(runId, { samples: 4, cycles: 1 });
        yield* bin.restore();
        expect(said(result)).toBe(OPENED.mr_url);
        expect(yield* asked(runId, "fix-1")).toContain(blocker);
        expect(yield* wasAsked(runId, "review-2-1")).toBe(true);
        const measured = yield* finals(runId);
        expect(measured).toHaveLength(2);
        expect(measured[1]!.candidate.head_sha).toBe(yield* headOf());
        expect(measured[0]!.candidate.head_sha).not.toBe(measured[1]!.candidate.head_sha);
      }),
    ),
  120_000,
);

const blockedThenFixed = (round: number): ReadonlyArray<Schema.Json> => {
  const title = `round ${round}: search drops a result`;
  return [
    {
      ...TUNE_REVIEWED,
      verdict: "findings",
      findings: [{ severity: "blocker", title, file: "count" }],
    },
    {
      writes: [],
      sh: inCheckout(`echo ${round} > note && git add note && git commit -qm fix-${round}`),
      output: { ...GATE_FIX, fixed: [{ title, file: "count" }], checks: [{ name: "nuxi" }] },
    },
  ];
};

scenario(
  "a tune-up whose last rally fix lands after the last review proves its outcome on the fresh review delivery took",
  () =>
    runEffect(
      Effect.gen(function* () {
        const runId = "r-tune-fresh";
        const { bin, forge } = yield* tuneForge;
        const write = forge.holding(
          ciOn("OPENED_AT", { name: "nuxi-job", state: "passed" }, "passed"),
        );
        yield* cycling(runId, [
          fasterTo(3),
          ...[1, 2, 3, 4].flatMap(blockedThenFixed),
          TUNE_REVIEWED,
          {
            writes: [write],
            sh: `sed -i "s/OPENED_AT/$(git -C '${rig.projectDir}' rev-parse HEAD)/" '${write.path}'`,
            output: OPENED_CI,
          },
        ]);
        yield* leftToCi(runId, ["nuxi"]);
        const result = yield* tunedUp(runId, { samples: 4, cycles: 1 });
        yield* bin.restore();
        expect(yield* wasAsked(runId, "proof.review-1")).toBe(true);
        expect(said(result)).toBe(CI_MR);
        expect(yield* runLog(runId)).toContain(`performance proved on ${yield* headOf()}`);
      }),
    ),
  120_000,
);

scenario(
  "a tune-up whose forge refuses the merge request fails with the forge's reason, and merges nothing",
  () =>
    runEffect(
      Effect.gen(function* () {
        const runId = "r-tune-refused";
        const refusal = "403 Forbidden: you cannot create merge requests in group/app";
        const { bin, forge } = yield* tuneForge;
        yield* cycling(runId, [
          fasterTo(3),
          TUNE_REVIEWED,
          {
            verdict: "findings",
            findings: [{ severity: "blocker", title: `glab mr create refused: ${refusal}` }],
            mr_url: null,
            pushed: true,
          },
        ]);
        const result = yield* tunedUp(runId, { samples: 4, cycles: 1 });
        yield* bin.restore();
        expect(result._tag).toBe("Failure");
        expect(reasonOf(result)).toContain(refusal);
        expect((yield* forge.model()).merges ?? []).toEqual([]);
      }),
    ),
  120_000,
);

const POOLING = {
  title: "Pool the search client's connections",
  repository: "group/search-client",
  team: "Search",
  links: ["https://gitlab.example.com/group/search-client/-/issues/3"],
  journey: "search",
  change: "reuse one connection per process instead of one per query",
  estimated_impact: "about 20 ms off p95 search latency",
  criteria: ["the bench opens one connection per process"],
  relation: "the local change prepares statements; this cuts the connect time left",
};
const FTS = {
  title: "Ship sqlite with FTS5",
  repository: "group/sqlite-build",
  links: [],
  journey: "search",
  change: "build sqlite with the FTS5 extension",
  estimated_impact: "full-text search without a table scan",
  criteria: ["FTS5 is loadable from the built library"],
  relation: "the local change cannot avoid the scan without it",
};
const KNOWN = {
  title: "Cache the tokenizer's tables",
  repository: "group/tokenizer",
  team: "Search",
  links: [],
  journey: "search",
  change: "load the tables once per process",
  estimated_impact: "a few ms per query",
  criteria: ["one load per process"],
  relation: "independent of the local change",
  existing: "https://linear.app/acme/issue/PERF-9",
};

/** A Claude Code with a Linear MCP server, as the rig's home tells it, while `body` runs. */
const withLinear = <A, E, R>(body: Effect.Effect<A, E, R>) =>
  Effect.acquireUseRelease(
    FileSystem.FileSystem.pipe(
      Effect.flatMap((fs) =>
        fs.writeFileString(
          `${rig.root}/.claude.json`,
          '{"mcpServers": {"linear-server": {"url": "https://mcp.linear.app/mcp"}}}',
        ),
      ),
      Effect.orDie,
    ),
    () => body,
    () =>
      FileSystem.FileSystem.pipe(
        Effect.flatMap((fs) => fs.remove(`${rig.root}/.claude.json`, { force: true })),
        Effect.orDie,
      ),
  );

/** The fake Linear: one line per issue, its URL then the marker it carries. */
const tracker = () => `${rig.root}/tracker`;
const emptyTracker = () =>
  FileSystem.FileSystem.pipe(
    Effect.flatMap((fs) => fs.writeFileString(tracker(), "")),
    Effect.orDie,
  );
const trackerLines = () =>
  Effect.map(readText(tracker()).pipe(Effect.orDie), (text) =>
    text.split("\n").filter((line) => line !== ""),
  );
const MARKED =
  'marker=$(grep -o \'collie:external-[0-9a-f]*\' "$PROMPT_PATH" | head -n 1); [ -n "$marker" ]';
/** A search of the fake tracker for the marker its prompt carries. */
const SEARCHED = () => ({
  writes: [],
  sh: `${MARKED} && url=$(grep -F "$marker" '${tracker()}' | cut -d ' ' -f 1) && if [ -n "$url" ]; then printf '{"marked": "%s", "matching": []}' "$url"; else printf '{"marked": null, "matching": []}'; fi > "$OUTPUT_PATH"`,
  output: null,
});
const ISSUE = "https://linear.app/acme/issue/PERF-1";
/** One issue filed in the fake tracker, carrying the marker its prompt gave. */
const FILED = () => ({
  writes: [],
  sh: `${MARKED} && echo "${ISSUE} $marker" >> '${tracker()}'`,
  output: { url: ISSUE },
});

const withExternal = (
  turn: ReturnType<typeof tried>,
  external: ReadonlyArray<Schema.Json>,
): Schema.Json => ({ ...turn, output: { ...turn.output, external } });

/** Each search, create and recheck an external finding's Post asked for, in order. */
const externalPrompts = (runId: string) =>
  Effect.map(prompts(), (all) =>
    all.flatMap((one) => {
      const named = new RegExp(
        `/${runId}/(external-[0-9a-f]+-(?:search|create|recheck)(?:-\\d+)?)\\.prompt\\.md`,
      ).exec(one);
      return named === null ? [] : [named[1]!];
    }),
  );

type Asked = { decision: string; prompt: string; options: string; answer: string | null };
/** The first open question that is none of `seen`. */
const nextAsked = (asked: Effect.Effect<ReadonlyArray<Asked>>, seen: ReadonlyArray<string>) =>
  until(
    () => asked,
    (rows) => rows.some((row) => row.answer === null && !seen.includes(row.decision)),
  ).pipe(
    Effect.map((rows) => rows.find((row) => row.answer === null && !seen.includes(row.decision))!),
  );
const openOf = (rows: ReadonlyArray<Asked>) => rows.filter((row) => row.answer === null);

scenario(
  "a tune-up puts each external finding to the human one at a time as Ignore or Post, files a Post once with its marker, and proves the same outcome whatever is answered",
  () =>
    runEffect(
      withLinear(
        Effect.gen(function* () {
          const runId = "r-tune-external";
          const { bin } = yield* tuneForge;
          yield* emptyTracker();
          yield* cycling(
            runId,
            [withExternal(fasterTo(3), [KNOWN]), TUNE_REVIEWED, OPENED, SEARCHED(), FILED()],
            [],
            { ...TUNE_DISCOVERED, external: [POOLING, FTS] },
          );
          const options = { entry: shipped("tune-up"), runId, input: { samples: 4, cycles: 1 } };
          const driving = yield* driven(options, (run) =>
            Effect.gen(function* () {
              const pooling = yield* nextAsked(run.asked, []);
              expect(openOf(yield* run.asked).map((row) => row.decision)).toEqual([
                pooling.decision,
              ]);
              expect(pooling.prompt).toContain(POOLING.title);
              expect(optionsOf([pooling], pooling.decision)).toEqual(["Ignore", "Post"]);
              yield* run.answer(pooling.decision, "Post");
              const team = yield* nextAsked(run.asked, [pooling.decision]);
              expect(team.prompt).toContain(FTS.title);
              expect(optionsOf([team], team.decision)).toEqual([]);
              yield* run.answer(team.decision, "Platform");
              const fts = yield* nextAsked(run.asked, [pooling.decision, team.decision]);
              expect(fts.prompt).toContain(FTS.title);
              expect(optionsOf([fts], fts.decision)).toEqual(["Ignore", "Post"]);
              yield* run.answer(fts.decision, "Ignore");
              return {
                status: yield* ended(run.status),
                pooling: pooling.decision,
                fts: fts.decision,
                asked: yield* run.asked,
              };
            }),
          );
          yield* bin.restore();
          const { pooling, fts } = driving;
          expect(outcomeText(driving.status)).toBe(OPENED.mr_url);
          expect(driving.asked.some((row) => row.prompt.includes(KNOWN.title))).toBe(false);
          expect(yield* externalPrompts(runId)).toEqual([`${pooling}-search`, `${pooling}-create`]);
          expect(yield* asked(runId, `${pooling}-create`)).toContain(`collie:${pooling}`);
          expect(yield* trackerLines()).toEqual([`${ISSUE} collie:${pooling}`]);
          const log = yield* runLog(runId);
          const proved = log.indexOf("performance proved on");
          expect(proved).toBeGreaterThan(-1);
          for (const decided of [
            `external ${pooling}: posted ${ISSUE}`,
            `external ${fts}: ignored`,
            `: existing ${KNOWN.existing}`,
          ])
            expect(log.indexOf(decided)).toBeGreaterThan(proved);
          const report = yield* readText(`${runDir(dir, runId)}/handoffs/tune-up-external.md`);
          for (const one of [POOLING, FTS, KNOWN]) {
            expect(report).toContain(one.title);
            expect(report).toContain(one.estimated_impact);
          }
          expect(report).toContain(KNOWN.existing);
        }),
      ),
    ),
  120_000,
);

/** A tune-up that ends on its noisy calibration, with Discover's `external` findings. */
const noisyWith = (external: ReadonlyArray<Schema.Json>, turns: ReadonlyArray<Schema.Json> = []) =>
  Effect.gen(function* () {
    const commit = yield* harnessCommit({ "bench/bench.sh": NOISY_BENCH });
    yield* emptyTracker();
    yield* rig.queueOutputs([
      { ...TUNE_DISCOVERED, external },
      tunePlan(commit, [NOISY_PRIMARY]),
      ...turns,
    ]);
  });

scenario(
  "a tune-up host restarted after an external finding's Post filed its issue but before the Output was collected searches again and files no second issue",
  () =>
    runEffect(
      withLinear(
        Effect.gen(function* () {
          const runId = "r-tune-filed";
          yield* noisyWith([POOLING], [SEARCHED(), { ...FILED(), output: null }, SEARCHED()]);
          const options = { entry: shipped("tune-up"), runId, input: {} };
          const key = yield* driven(options, (run) =>
            Effect.gen(function* () {
              const pooling = yield* nextAsked(run.asked, []);
              yield* run.answer(pooling.decision, "Post");
              yield* until(trackerLines, (lines) => lines.length === 1);
              return pooling.decision;
            }),
          );
          const status = yield* driven({ ...options, restarted: true }, (run) => ended(run.status));
          expect(status.status).toBe("complete");
          expect(yield* externalPrompts(runId)).toEqual([
            `${key}-search`,
            `${key}-create`,
            `${key}-recheck`,
          ]);
          expect(yield* trackerLines()).toEqual([`${ISSUE} collie:${key}`]);
          expect(yield* runLog(runId)).toContain(`external ${key}: posted ${ISSUE}`);
        }),
      ),
    ),
  120_000,
);

scenario(
  "a tune-up host restarted after an external finding's Post launched its create but before it filed asks the finding again, and creates nothing without a second Post",
  () =>
    runEffect(
      withLinear(
        Effect.gen(function* () {
          const runId = "r-tune-unfiled";
          yield* noisyWith([POOLING], [SEARCHED(), { writes: [], output: null }, SEARCHED()]);
          const options = { entry: shipped("tune-up"), runId, input: {} };
          const key = yield* driven(options, (run) =>
            Effect.gen(function* () {
              const pooling = yield* nextAsked(run.asked, []);
              yield* run.answer(pooling.decision, "Post");
              yield* until(
                () => wasAsked(runId, `${pooling.decision}-create`),
                (launched) => launched,
              );
              return pooling.decision;
            }),
          );
          const status = yield* driven({ ...options, restarted: true }, (run) =>
            Effect.gen(function* () {
              const again = yield* nextAsked(run.asked, [key]);
              expect(again.prompt).toContain("may have filed");
              expect(again.prompt).toContain(POOLING.title);
              expect(optionsOf([again], again.decision)).toEqual(["Ignore", "Post"]);
              expect(yield* externalPrompts(runId)).toEqual([
                `${key}-search`,
                `${key}-create`,
                `${key}-recheck`,
              ]);
              yield* run.answer(again.decision, "Ignore");
              return yield* ended(run.status);
            }),
          );
          expect(status.status).toBe("complete");
          expect(yield* externalPrompts(runId)).toEqual([
            `${key}-search`,
            `${key}-create`,
            `${key}-recheck`,
          ]);
          expect(yield* trackerLines()).toEqual([]);
          expect(yield* runLog(runId)).toContain(`external ${key}: ignored`);
        }),
      ),
    ),
  120_000,
);

scenario(
  "a tune-up with no Linear MCP keeps its external report and asks nothing, saying why",
  () =>
    runEffect(
      Effect.gen(function* () {
        const runId = "r-tune-no-linear";
        yield* noisyWith([POOLING]);
        const result = yield* tunedUp(runId);
        expect(result._tag).toBe("Success");
        expect(yield* questions(runId)).toEqual([]);
        const file = `${runDir(dir, runId)}/handoffs/tune-up-external.md`;
        expect(yield* readText(file)).toContain(POOLING.title);
        expect(yield* runLog(runId)).toContain(`${file} not asked: no Linear MCP server`);
      }),
    ),
  120_000,
);

scenario(
  "a tune-up with external report writes its external report and asks nothing",
  () =>
    runEffect(
      withLinear(
        Effect.gen(function* () {
          yield* noisyWith([POOLING]);
          expect((yield* tunedUp("r-tune-report", { external: "report" }))._tag).toBe("Success");
          expect(yield* questions("r-tune-report")).toEqual([]);
          expect(
            yield* readText(`${runDir(dir, "r-tune-report")}/handoffs/tune-up-external.md`),
          ).toContain(POOLING.title);
        }),
      ),
    ),
  120_000,
);

scenario(
  "a tune-up with external off writes no external report",
  () =>
    runEffect(
      withLinear(
        Effect.gen(function* () {
          yield* noisyWith([POOLING]);
          expect((yield* tunedUp("r-tune-off", { external: "off" }))._tag).toBe("Success");
          expect(yield* questions("r-tune-off")).toEqual([]);
          const fs = yield* FileSystem.FileSystem;
          expect(
            yield* fs.exists(`${runDir(dir, "r-tune-off")}/handoffs/tune-up-external.md`),
          ).toBe(false);
        }),
      ),
    ),
  120_000,
);

once("tune-up declares every input with its default, and its path", () =>
  runEffect(
    Effect.gen(function* () {
      const entry = yield* loadEntry(shipped("tune-up"));
      const defaults = Object.fromEntries(
        declaredBy(entry).map((one) => [one.name, schemaDefault(one.schema)]),
      );
      expect(defaults).toEqual({
        repository: "",
        focus: "",
        cycles: 5,
        threshold: 5,
        tolerance: 2,
        samples: 10,
        wall_time: "",
        external: "ask",
      });
      expect(entry.metadata?.path?.map((one) => one.title)).toEqual([
        "Discover",
        "Harness",
        "Calibrate",
        "Cycles",
        "Integrate",
        "Review",
        "Checks",
        "Merge request",
        "External report",
      ]);
      expect(entry.metadata?.checkout).toBe("branch");
      expect(entry.metadata?.outcome).toEqual({ fixed: "performance" });
    }),
  ),
);

/**
 * Registers one pass in the test file that calls it: every scenario as shipped, with the
 * tests about the shipped modules themselves, or every scenario under ids that share
 * nothing with them. Two files, so the two passes run on two workers at once.
 */
/**
 * Every prompt and persona a scenario sent substitutes no command: no `$(`, and no backtick
 * inside a fenced block, where a backtick is shell rather than Markdown.
 */
const noCommandSubstitution = () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const runs = yield* fs.readDirectory(`${dir}/agents`).pipe(Effect.orElseSucceed(() => []));
    for (const run of runs) {
      const names = yield* fs
        .readDirectory(`${dir}/agents/${run}`)
        .pipe(Effect.orElseSucceed(() => []));
      for (const name of names.filter((one) => /\.(prompt|persona)\.md$/.test(one))) {
        const text = yield* fs.readFileString(`${dir}/agents/${run}/${name}`);
        const fenced = text.split("```").filter((_, at) => at % 2 === 1);
        expect([name, text.includes("$("), fenced.some((block) => block.includes("`"))]).toEqual([
          name,
          false,
          false,
        ]);
      }
    }
  }).pipe(Effect.orDie);

scenario(
  "Flow: while implement builds the second of three tickets, Build is a run per ticket and the rest is expected",
  () =>
    runEffect(
      Effect.gen(function* () {
        const bin = yield* FakeBin.make(`${rig.root}/bin`);
        yield* noGitlabMrs(bin);
        yield* repository();
        const plan = yield* planOf([
          { file: "01-first.md", title: "the first one", checks: "unit" },
          { file: "02-second.md", title: "the second one", checks: "unit" },
          { file: "03-third.md", title: "the third one", checks: "unit" },
        ]);
        yield* approve("r-flow-slices", ["unit"]);
        const lane = yield* laneWhen({
          entry: shipped("implement"),
          runId: "r-flow-slices",
          input: { plan, ...FINISH },
          ready: (one) => nodeIn(one, "build")?.runs[1]?.state === "running",
          outputs: [BUILT],
          working: { operation: "02-second.md", output: BUILT },
          rest: [BUILT, CLEAN_SYNTHESIS, OPENED],
        });
        yield* bin.restore();

        const built = nodeIn(lane, "build")!;
        expect([built.state, built.said]).toEqual(["running", "Slice 2 of 3"]);
        expect(built.runs.map((one) => [one.place, one.state])).toEqual([
          ["01-first.md", "done"],
          ["02-second.md", "running"],
          ["03-third.md", "expected"],
        ]);
        expect(statesOf(lane).slice(1)).toEqual([
          ["review", "expected"],
          ["checks", "expected"],
          ["merge-request", "expected"],
          ["next", "expected"],
        ]);
      }),
    ),
  120_000,
);

scenario(
  "Flow: a review that needs one fix is one Review of two runs",
  () =>
    runEffect(
      Effect.gen(function* () {
        const bin = yield* FakeBin.make(`${rig.root}/bin`);
        yield* noGitlabMrs(bin);
        yield* repository();
        const plan = yield* planOf([{ file: "01-only.md", title: "the only one", checks: "unit" }]);
        yield* approve("r-flow-fix", ["unit"]);
        const finding = {
          severity: "blocker",
          title: "the guard is on the wrong side",
          file: "src/a.ts",
          detail: "an empty list goes through it",
        };
        yield* rig.queueOutputs([
          BUILT,
          { ...CLEAN_SYNTHESIS, verdict: "findings", findings: [finding], scope_met: true },
          { verdict: "clean", fixed: [{ title: finding.title, file: finding.file }], checks: [] },
          { ...CLEAN_SYNTHESIS },
          OPENED,
        ]);
        const result = yield* ran({
          entry: shipped("implement"),
          runId: "r-flow-fix",
          input: { plan, ...FINISH },
        });
        yield* bin.restore();
        expect(said(result)).toBe(OPENED.mr_url);

        const lane = yield* laneNow("r-flow-fix", "succeeded");
        expect(
          lane.nodes
            .filter((node) => node.id === "review")
            .map((node) => node.runs.map((one) => one.state)),
        ).toEqual([["done", "done"]]);
      }),
    ),
  120_000,
);

scenario(
  "Flow: a gate check that still fails after its fixes fails Checks, naming the check",
  () =>
    runEffect(
      Effect.gen(function* () {
        const { bin } = yield* heldUnproved("r-flow-gate");
        yield* bin.restore();
        const lane = yield* laneNow("r-flow-gate", "waiting");
        const gate = nodeIn(lane, "checks")!;
        expect(gate.state).toBe("failed");
        expect(gate.said).toContain("lint failed");
        expect(nodeIn(lane, "merge-request")!.state).toBe("expected");
      }),
    ),
  120_000,
);

scenario(
  "Flow: a fan-out forecasts its Repo runs, one per repository, and none of the work it hands them",
  () =>
    runEffect(
      Effect.gen(function* () {
        yield* repositories("r-flow-fan", [
          { file: "01-api.md", repo: "api" },
          { file: "02-web.md", repo: "web" },
        ]);
        yield* ran({
          entry: shipped("implement"),
          runId: "r-flow-fan",
          input: { plan: `${runDir(dir, "r-flow-fan")}/plan` },
        });
        const lane = yield* laneNow("r-flow-fan", "succeeded");
        expect(statesOf(lane)).toEqual([["repo-runs", "done"]]);
        expect(nodeIn(lane, "repo-runs")!.runs.map((one) => one.place)).toEqual(["api", "web"]);
      }),
    ),
  120_000,
);

scenario(
  "Flow: a package release waiting at its merge go has done what came before it, and expects the merge and the tag, then nothing",
  () =>
    runEffect(
      Effect.gen(function* () {
        const { target } = RELEASING.gitlab;
        const { bin } = yield* releasable("gitlab");
        claimed.length = 0;
        const runId = "r-flow-go";
        yield* rig.queueOutputs([PACKAGED]);
        yield* driven(
          { entry: shipped("release"), runId, input: { mr: target }, host: releaseHost() },
          (run) => goAsked(run.asked, "go-1"),
        );
        yield* bin.restore();
        expect(statesOf(yield* laneNow(runId, "waiting"))).toEqual([
          ["checkout", "done"],
          ["assess", "done"],
          ["prove", "done"],
          ["review-wait", "done"],
          ["go", "needs-you"],
          ["claim", "expected"],
          ["merge", "expected"],
          ["tag", "expected"],
        ]);
      }),
    ),
  120_000,
);
const withForges = (body: () => Promise<void>) =>
  runEffect(
    Effect.gen(function* () {
      forgeFaces.clear();
      const bin = yield* FakeBin.make(`${rig.root}/default-forges`);
      yield* Effect.addFinalizer(() => bin.restore());
      for (const name of ["gitlab", "github"] as const)
        yield* forgeOnPath(bin, name, {
          installed: true,
          loggedIn: [FORGE_HOST[name]],
          login: "tester",
          mrs: [],
        });
      forgeApi = yield* serveForges(
        ...(["gitlab", "github"] as const).map((name) => ({
          forge: name,
          face: (input: string, init?: RequestInit) => forgeFaces.get(name)!.face(input, init),
        })),
      );
      yield* Effect.promise(body);
    }),
  );

/** How many test files each pass is split into, so that no one file holds a whole pass. */
export const SHARES = 12;

/** Splits names into `of` shares by a hash of each name, so that adding one moves no other. */
export const split = (names: ReadonlyArray<string>, of: number) => {
  const shares = Array.from({ length: of }, (): string[] => []);
  for (const name of names) shares[Bun.hash.crc32(name) % of]!.push(name);
  return shares;
};

export const scenarioNames = () => scenarios.map((one) => one.name);

export const register = (pass: "shipped" | "unrelated", share: number) => {
  const mine = new Set(split(scenarioNames(), SHARES)[share]);
  beforeEach(() =>
    runEffect(
      Effect.gen(function* () {
        rig = yield* Rig.make();
        slack = fakeSlack();
        const fs = yield* FileSystem.FileSystem;
        dir = `${rig.root}/host`;
        forgeApi = "";
        started = [];
        failing = new Set();
        modules = new Map();
        childWaits = new Map();
        startsAfter = new Map();
        startSignals = new Map();
        yield* fs.makeDirectory(dir, { recursive: true });
        yield* fs.makeDirectory(rig.projectDir, { recursive: true });
        // The skills the shipped personas and steps name, installed where this machine
        // keeps them: a mention resolves to a path, and a step that starts one can.
        yield* installFakeSkills(rig.root);
        yield* fs.makeDirectory(`${rig.root}/user/workflows`, { recursive: true });
        for (const [name, id] of Object.entries(UNRELATED)) {
          yield* fs.writeFileString(
            `${rig.root}/user/workflows/${id}.workflow.ts`,
            [
              `import shipped from "${ROOT}workflows/${name}.workflow.ts";`,
              `import { defineWorkflow } from "collie";`,
              `export default defineWorkflow({`,
              `  ...shipped,`,
              `  id: "${id}",`,
              `  title: "${id}",`,
              `  description: "The shipped ${name}, saved under an id of its own.",`,
              `});`,
              "",
            ].join("\n"),
          );
        }
      }),
    ),
  );

  afterEach(() => runEffect(rig.close()));
  for (const one of scenarios.filter((one) => mine.has(one.name))) {
    test(
      pass === "unrelated" ? `${one.name} (under an unrelated id)` : one.name,
      () => {
        renamed = pass === "unrelated";
        return withForges(() =>
          one
            .body()
            .then(() => runEffect(noCommandSubstitution()))
            .then(() => runEffect(undeclaredWork()))
            .then((loose) => expect(loose).toEqual([])),
        );
      },
      one.timeout,
    );
  }
  if (pass === "shipped" && share === 0) for (const one of shippedOnly) one();
};

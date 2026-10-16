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
import { Effect, Fiber, FileSystem, Layer, Option, Path, Result, Schedule, Schema } from "effect";
import * as WorkflowEngine from "effect/workflow/WorkflowEngine";
import { Rig, FakeHerdr } from "./recorder";
import { exec } from "./command";
import { fastForward, runEffect } from "./effect";
import { FakeBin } from "./bin";
import { CLI, FORGE_HOST, PROJECT, forgeOnPath, type FakeJob, type ForgeModel } from "./forge";
import { readCheckpoints } from "../../src/cards";
import { mrTarget, type MrForge } from "../../src/board-model";
import { installFakeSkills } from "./defs";
import { Agents, agentsLayer, type AgentHost } from "../../src/agents";
import {
  Children,
  Host,
  Run,
  WorkflowError,
  type ActionFacts,
  type ChildAsk,
  type Issue,
} from "../../src/sdk";
import { measuresOf } from "../../src/outcomes";
import { redact } from "../../src/redact";
import selfImprove from "../../workflows/self-improve.workflow";
import {
  type Finding,
  type Improvement,
  keysIn,
  markerOf,
  sortOut,
} from "../../workflows/retrospective";
import {
  PARKED,
  answerDecision,
  controlPath,
  declaredByModule,
  evidenceDir,
  foundationLayer,
  loadEntry,
  pollStatus,
  runDir,
} from "../../src/engine";
import { VerifySpecSchema } from "../../src/verify-spec";
import { findingsIn } from "../../src/output";
import { collect, fingerprint, readVerifications } from "../../src/verify";
import { inputsFor, offersFrom } from "../../src/offers";
import { Store } from "../../src/store";
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
  investigate: "find-the-cause",
  general: "odd-job",
  "self-improve": "look-back",
} as const;
type Shipped = keyof typeof UNRELATED;

let rig: Rig;
let dir: string;
let started: ChildAsk[] = [];
/** The invocations whose child ends in failure. */
let failing = new Set<string>();
let renamed = false;

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
  shippedOnly.push(() => test(name, body, timeout));
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
        started.push(ask);
        const parent = Option.getOrUndefined(yield* Effect.serviceOption(Run))?.id;
        return {
          runId: `${parent}-${ask.invocation}`,
          workflow: ask.workflow,
          invocation: ask.invocation,
          fresh: true,
        };
      }),
    result: (child) =>
      failing.has(child.invocation)
        ? Effect.fail(new WorkflowError({ reason: `${child.invocation} failed` }))
        : Effect.succeed("done"),
  }),
);

/** A host layer a test may wrap, for the one capability it has no service to answer with. */
type HostOverride = Layer.Layer<Host, never, Host>;

/** The host's own layers, placing checkouts through the rig's herdr. */
const foundation = () => ({
  dir,
  userDir: rig.userDir,
  placing: { herdr: hostOf().herdr, env: hostOf().env },
});

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
  run.pipe(
    Effect.provide(agentsLayer(hostOf())),
    Effect.provide(children),
    Effect.provide(
      override === undefined
        ? foundationLayer(foundation())
        : override.pipe(Layer.provideMerge(foundationLayer(foundation()))),
    ),
    Effect.scoped,
    Effect.orDie,
  );

const loaded = (entry: string, runId: string) =>
  loadEntry(entry).pipe(
    Effect.map((described) => described.make(`${described.id}@${runId}`)),
    Effect.orDie,
  );

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

/** What an operation was actually asked, which is the file its message named. */
const asked = (runId: string, operation: string) =>
  FileSystem.FileSystem.pipe(
    Effect.flatMap((fs) => fs.readFileString(`${dir}/agents/${runId}/${operation}.prompt.md`)),
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
        expect((yield* launched())[0]?.args).toContain("--model opus --effort xhigh");
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
        expect((yield* launched())[0]?.args).toContain("--model opus --effort xhigh");
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
  "implement on a plan that spans repositories is one Run of itself per repository, in waves",
  () =>
    runEffect(
      Effect.gen(function* () {
        yield* repositories("r-impl-fan", THREE_REPOS);
        const plan = `${runDir(dir, "r-impl-fan")}/plan`;

        const result = yield* ran({
          entry: shipped("implement"),
          runId: "r-impl-fan",
          input: { plan },
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
        expect(new Set(started.map((one) => one.input.plan))).toEqual(new Set([plan]));
        // The parent builds nothing itself.
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
          input: { plan },
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
          input: { plan },
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
          input: { plan },
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
            { plan: `${runDir(dir, "r-plan-alone")}/plan` },
            { task: "one-registry", outcome: "feature" },
          ],
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
        expect(reviewer?.args).toContain("--model opus --effort xhigh");
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
        yield* rig.queueOutputs([SYNTHESIS]);
        const rows = yield* parked({
          entry: shipped("review"),
          runId: "r-review-branch",
          input: { target: "branch:main...HEAD" },
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
          input: { target: "branch:main...HEAD" },
          decision: "post-1",
          value: "Don't post",
        });
        expect(said(result)).toBe("1 finding(s), not posted");
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
        yield* bin.add(
          "glab",
          `[ "$1 $2" = "mr view" ] && echo '{"source_branch": "fix-the-guard"}'; exit 0`,
        );
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
        expect(fix).toContain(`collie verify --run r-fix-tree --cwd ${reviewed} -- <command>`);
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
  "a review with no branch to fix starts no fixer, says why, and asks again",
  () =>
    runEffect(
      Effect.gen(function* () {
        yield* repository();
        yield* rig.queueOutputs([SYNTHESIS]);
        const target = "branch:main...HEAD";
        yield* parked({
          entry: shipped("review"),
          runId: "r-fix-none",
          input: { target },
          decision: "post-1",
        });
        const rows = yield* answeredThen({
          entry: shipped("review"),
          runId: "r-fix-none",
          input: { target },
          decision: "post-1",
          value: "Fix findings",
          until: "post-2",
        });

        expect((yield* rig.cmds()).filter((cmd) => cmd === "agent start")).toHaveLength(1);
        const fs = yield* FileSystem.FileSystem;
        expect(yield* fs.readFileString(`${runDir(dir, "r-fix-none")}/log.txt`)).toContain(
          "HEAD is not a branch, so there is nothing to fix on it",
        );
        expect(optionsOf(rows, "post-2")).toContain("Fix findings");
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
    yield* bin.add("glab", "exit 0");
    return bin;
  }),
  (bin) => bin.restore(),
);

/**
 * A real repository with a GitLab remote. What binds a verification is the tree it ran
 * on, and a directory git knows nothing about has no tree to move.
 */
const repository = () =>
  Effect.gen(function* () {
    // Fetched from a bare repository beside it, and known to the forge by `upstream`.
    const origin = `${rig.root}/project-origin.git`;
    yield* exec(["git", "init", "-q", "--bare", origin], { cwd: rig.root });
    for (const args of [
      ["init", "-q"],
      ["config", "user.email", "t@example.com"],
      ["config", "user.name", "t"],
      ["remote", "add", "origin", origin],
      ["remote", "add", "upstream", "https://gitlab.example.com/group/project.git"],
      ["commit", "-qm", "first", "--allow-empty"],
      ["push", "-q", "origin", "HEAD"],
    ]) {
      yield* exec(["git", ...args], { cwd: rig.projectDir });
    }
  });

/** That repository with a commit the default branch does not have, so its base is another tree. */
const ahead = () =>
  repository().pipe(
    Effect.andThen(
      exec(["git", "commit", "-qm", "the change", "--allow-empty"], { cwd: rig.projectDir }),
    ),
  );

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
        yield* bin.add("glab", `[ "$1" = "api" ] && echo '{"username":"tester"}'; exit 0`);
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
          input: { plan },
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
        yield* bin.add("glab", `[ "$1" = "api" ] && echo '{"username":"tester"}'; exit 0`);
        yield* repository();
        const plan = yield* planOf([
          { file: "01-first.md", title: "the first one", checks: "unit" },
          { file: "02-second.md", title: "the second one", checks: "unit" },
        ]);
        yield* approve("r-live", ["unit"]);
        // The first ticket's Output is written by hand, once the plan has moved under it.
        yield* rig.queueOutputs([null, BUILT, CLEAN_SYNTHESIS, OPENED]);
        const running = yield* Effect.forkChild(
          ran({ entry: shipped("implement"), runId: "r-live", input: { plan } }),
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
        yield* bin.add("glab", `[ "$1" = "api" ] && echo '{"username":"tester"}'; exit 0`);
        yield* repository();
        const plan = yield* planOf([
          { file: "01-first.md", title: "the first one", checks: "unit" },
        ]);
        yield* approve("r-grow", ["unit"]);
        yield* rig.queueOutputs([null, BUILT, CLEAN_SYNTHESIS, OPENED]);
        const running = yield* Effect.forkChild(
          ran({ entry: shipped("implement"), runId: "r-grow", input: { plan } }),
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
        yield* bin.add("glab", `[ "$1" = "api" ] && echo '{"username":"tester"}'; exit 0`);
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
          input: { plan },
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
        yield* bin.add("glab", `[ "$1" = "api" ] && echo '{"username":"tester"}'; exit 0`);
        yield* repository();
        const plan = yield* planOf([
          { file: "01-first.md", title: "the first one", checks: "unit", body: CRITERIA },
          { file: "02-second.md", title: "the second one", checks: "unit" },
        ]);
        yield* approve("r-unmet", ["unit"]);
        yield* rig.queueOutputs([BUILT, BUILT, BUILT]);
        const result = yield* ran({
          entry: shipped("implement"),
          runId: "r-unmet",
          input: { plan },
        });
        yield* bin.restore();

        expect(result._tag).toBe("Failure");
        expect(reasonOf(result)).toContain(
          "01-first.md: acceptance criteria still unanswered or unmet after 2 hand-backs, so no review starts",
        );
        expect(reasonOf(result)).toContain("**Named.** Each one is named in the log.");
        expect(reasonOf(result)).toContain("Continue with a follow-up Run to finish delivery.");
        const sent = (yield* prompts()).join("\n");
        expect(sent).toContain("01-first.md.criteria-2.prompt.md");
        expect(sent).not.toContain("review-1");
        expect(sent).not.toContain("02-second.md.prompt.md");
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
        yield* bin.add("glab", `[ "$1" = "api" ] && echo '{"username":"tester"}'; exit 0`);
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
          input: { plan: "ABC-123" },
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
          input: { plan: "ABC-124" },
        });
        expect(reasonOf(stopped)).toContain("plan/SPEC.md cannot be read");
        expect(yield* prompts()).not.toContainEqual(expect.stringContaining("review-1"));
      }),
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
        yield* bin.add("glab", `[ "$1" = "api" ] && echo '{"username":"tester"}'; exit 0`);
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
          ran({ entry: shipped("implement"), runId: "r-planned", input: { plan } }),
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
      ran({ entry: shipped("implement"), runId, input: { plan } }),
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
        yield* bin.add("glab", `exit 0`);
        yield* repository();
        const plan = yield* planOf([{ file: "01-only.md", title: "the only one", checks: "unit" }]);
        yield* approve("r-impl-mr", ["unit"]);
        yield* rig.queueOutputs([BUILT, CLEAN_SYNTHESIS, OPENED]);

        yield* ran({ entry: shipped("implement"), runId: "r-impl-mr", input: { plan } });
        yield* bin.restore();

        const opening = yield* asked("r-impl-mr", "mr");
        expect(opening).toContain("- Assignee: `someone-else`");
        // What was collected, by whom — Collie ran it, so it is not the agent's claim.
        expect(opening).toContain("unit");
        expect(opening).toContain("by collie");
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
        yield* bin.add("glab", `exit 0`);
        yield* repository();
        const plan = yield* planOf([{ file: "01-only.md", title: "the only one", checks: "unit" }]);
        yield* approve("r-impl-minor", ["unit"]);
        const minor = { severity: "minor", title: "the test depends on test order", file: "a.ts" };
        yield* rig.queueOutputs([
          BUILT,
          { ...CLEAN_SYNTHESIS, verdict: "findings", findings: [minor] },
          OPENED,
        ]);

        yield* ran({ entry: shipped("implement"), runId: "r-impl-minor", input: { plan } });
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
        yield* bin.add("glab", `exit 0`);
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
          input: { plan },
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
        yield* bin.add("glab", `exit 0`);
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
          input: { plan },
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
        yield* bin.add("glab", `exit 0`);
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
        const result = yield* ran({ entry, runId: "r-impl-build-panel", input: { plan } });
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
          "collie verify --run",
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
        yield* bin.add("glab", `exit 0`);
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
          input: { plan },
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
        yield* bin.add("glab", `exit 0`);
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
          input: { plan: reviewed },
        });
        yield* bin.restore();

        const building = yield* asked("r-impl-review", "build");
        expect(building).toContain(`Work source (review): ${reviewed}`);
        expect(building).toContain("Do the one that matches\n`review`");
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
        yield* bin.add("glab", `exit 0`);
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
          input: { plan },
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
        yield* bin.add("glab", `exit 0`);
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
          input: { plan },
          options: { outcome: "feature" },
        });
        yield* bin.restore();

        expect(said(result)).toBe(OPENED.mr_url);
        expect(yield* prompts()).toHaveLength(4);
        expect(yield* asked("r-gate-judged", "review-5-1")).toContain('"scope_met": true');
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
        yield* bin.add("glab", `exit 0`);
        yield* repository();
        const plan = yield* planOf([{ file: "01-only.md", title: "the only one", checks: "unit" }]);
        yield* approve("r-gate-unproved", ["unit"]);
        const unproved = { ...CLEAN_SYNTHESIS, scope_met: false };
        yield* rig.queueOutputs([BUILT, unproved, unproved]);
        const result = yield* running(
          {
            entry: shipped("implement"),
            runId: "r-gate-unproved",
            input: { plan },
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
        yield* bin.add("glab", `exit 0`);
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
        yield* rig.queueOutputs([BUILT, CLEAN_SYNTHESIS, fix, OPENED]);
        const result = yield* ran({
          entry: shipped("implement"),
          runId: "r-gate-fix",
          input: { plan },
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
        yield* bin.add("glab", `exit 0`);
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
        yield* rig.queueOutputs([BUILT, CLEAN_SYNTHESIS, fix, OPENED]);
        yield* ran({
          entry: shipped("implement"),
          runId: "r-passes",
          input: { plan },
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
          input: { plan },
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
        expect((yield* forge.calls()).some((call) => call.includes("/pipelines/3100/jobs"))).toBe(
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
          input: { plan },
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
          input: { plan },
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
          input: { plan },
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
          input: { plan },
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
        expect((yield* forge.calls()).filter((call) => call.includes("/retry"))).toHaveLength(1);
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
          input: { plan },
          options: { outcome: "feature" },
        });
        yield* bin.restore();
        expect(said(result)).toBe(CI_MR);
        const line = `nuxi: job nuxi-job also fails at ${CI_BASE.slice(0, 12)}, where this branch leaves its target branch, so it failed before this Run's changes`;
        expect((yield* ciNotes(forge)).join("\n")).toContain(line);
        const fs = yield* FileSystem.FileSystem;
        expect(yield* fs.readFileString(`${runDir(dir, runId)}/log.txt`)).toContain(line);
        expect(yield* fs.exists(`${dir}/agents/${runId}/ci-fix-1.prompt.md`)).toBe(false);
        expect((yield* forge.calls()).some((call) => call.includes("/retry"))).toBe(false);
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
          input: { plan },
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
          input: { plan },
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
          input: { plan },
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
          input: { plan },
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

scenario(
  "a green Run runs each check once: the proof relies on the gate's own pass",
  () =>
    runEffect(
      Effect.gen(function* () {
        const bin = yield* FakeBin.make(`${rig.root}/bin`);
        yield* bin.add("glab", `exit 0`);
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
          input: { plan },
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
        yield* bin.add("glab", `exit 0`);
        yield* ahead();
        const plan = yield* planOf([{ file: "01-only.md", title: "the only one", checks: "unit" }]);
        const runId = "r-gate-fix-reruns";
        yield* approve(runId, ["unit", "lint"]);
        const fs = yield* FileSystem.FileSystem;
        yield* fs.writeFileString(
          `${evidenceDir(dir, runId)}/approved.json`,
          asApproved([
            // Red at the gate and on the recheck, green after the fix.
            counting("unit", `${rig.root}/unit-runs`, `[ $n -ge 3 ]`),
            counting("lint", `${rig.root}/lint-runs`),
          ]),
        );
        yield* rig.queueOutputs([BUILT, CLEAN_SYNTHESIS, GATE_FIX, OPENED]);
        const result = yield* ran({
          entry: shipped("implement"),
          runId,
          input: { plan },
          options: { outcome: "feature" },
        });
        yield* bin.restore();

        expect(said(result)).toBe(OPENED.mr_url);
        // The fix left the tree as it was, so lint's pass at the gate still answers.
        expect(yield* runsOf(`${rig.root}/lint-runs`)).toBe(1);
        expect(yield* runsOf(`${rig.root}/unit-runs`)).toBe(3);
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
    yield* bin.add("glab", `exit 0`);
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
          input: { plan },
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
        yield* rig.queueOutputs([BUILT, CLEAN_SYNTHESIS, GATE_FIX, OPENED]);
        const result = yield* ran({
          entry: shipped("implement"),
          runId,
          input: { plan },
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
          input: { plan },
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
          input: { plan },
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
        yield* rig.queueOutputs([BUILT, CLEAN_SYNTHESIS, GATE_FIX, OPENED]);
        const result = yield* ran({
          entry: shipped("implement"),
          runId,
          input: { plan },
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
        yield* rig.queueOutputs([BUILT, CLEAN_SYNTHESIS, GATE_FIX, GATE_FIX, OPENED]);
        const result = yield* ran({
          entry: shipped("implement"),
          runId,
          input: { plan },
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
          input: { plan },
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
          input: { plan },
          options: { outcome: "feature" },
        });
        yield* bin.restore();

        expect(said(result)).toBe(OPENED.mr_url);
        expect(yield* parkedWhy(runId)).toBe("");
        expect(yield* asked(runId, "mr")).toContain(
          `- ${disputed}: gate fix 1 disputed it and changed nothing`,
        );
        expect((yield* passesOf(runId)).filter((pass) => pass === "recheck")).toHaveLength(1);
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
          input: { plan },
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
    yield* bin.add("glab", `exit 0`);
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

const repairing = () => ({
  writes: [{ path: `${rig.root}/repaired`, text: "fixed\n" }],
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
          input: { plan },
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
          input: { plan },
          options: { outcome: "feature" },
        });
        yield* bin.restore();

        expect(said(result)).toBe(OPENED.mr_url);
        expect(yield* asked(runId, "gate-fix-2")).toContain("unit failed");
        expect(yield* asked(runId, "mr")).not.toContain("disputed it and changed nothing");
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
          input: { plan },
          options: { outcome: "feature" },
        });
        yield* bin.restore();

        expect(said(result)).toBe(OPENED.mr_url);
        expect(yield* asked(runId, "gate-fix-2")).toContain("lint failed");
        expect(yield* asked(runId, "mr")).not.toContain("disputed it and changed nothing");
      }),
    ),
  120_000,
);

scenario(
  "after a restart the host runs again a check it collected before it started",
  () =>
    runEffect(
      Effect.gen(function* () {
        const bin = yield* FakeBin.make(`${rig.root}/bin`);
        yield* bin.add("glab", `exit 0`);
        yield* ahead();
        const plan = yield* planOf([{ file: "01-only.md", title: "the only one", checks: "unit" }]);
        const runId = "r-gate-resumed";
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
          input: { plan },
          options: { outcome: "feature" },
        };
        const result = yield* running(options, (status) =>
          until(
            () => status,
            (got) => got !== "pending",
          ),
        );
        expect(result).toBe("suspended");
        const suspended = yield* runsOf(`${rig.root}/unit-runs`);
        // The gate's pass answered each fix, which left the tree as it was.
        expect(suspended).toBe(1);

        yield* fs.writeFileString(`${rig.root}/repaired`, "");
        expect(said(yield* resumed(options))).toBe(OPENED.mr_url);
        yield* bin.restore();
        expect(yield* runsOf(`${rig.root}/unit-runs`)).toBe(suspended + 1);
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
        yield* bin.add("glab", `exit 0`);
        yield* repository();
        const plan = yield* planOf([{ file: "01-only.md", title: "the only one", checks: "unit" }]);
        const runId = "r-gate-new-tool";
        yield* approve(runId, ["unit", "lint"]);
        const fs = yield* FileSystem.FileSystem;
        const tool = `${rig.root}/tools/unit`;
        yield* fs.makeDirectory(`${rig.root}/tools`, { recursive: true });
        yield* fs.writeFileString(tool, `#!/bin/sh\necho >> ${rig.root}/unit-runs\n`);
        yield* fs.chmod(tool, 0o755);
        yield* fs.writeFileString(
          `${evidenceDir(dir, runId)}/approved.json`,
          asApproved([
            { name: "unit", executable: tool, argv: [], cwd: rig.projectDir },
            // Upgrades unit's tool once, after unit has passed with the old one.
            counting(
              "lint",
              `${rig.root}/lint-runs`,
              `grep -q v2 ${tool} || echo '# v2' >> ${tool}`,
            ),
          ]),
        );
        yield* rig.queueOutputs([BUILT, CLEAN_SYNTHESIS, OPENED]);
        const result = yield* ran({
          entry: shipped("implement"),
          runId,
          input: { plan },
          options: { outcome: "feature" },
        });
        yield* bin.restore();

        expect(said(result)).toBe(OPENED.mr_url);
        expect(yield* runsOf(`${rig.root}/unit-runs`)).toBe(2);
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
        yield* bin.add("glab", `exit 0`);
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
          input: { plan },
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
        yield* bin.add("glab", `exit 0`);
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
          { verdict: "clean", fixed: [], disputed: [], checks: [{ name: "unit" }] },
          OPENED,
        ]);
        const result = yield* ran({
          entry: shipped("implement"),
          runId: "r-impl-red-base",
          input: { plan },
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
        yield* bin.add("glab", `exit 0`);
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
            input: { plan },
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
        yield* bin.add("glab", `exit 0`);
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
          input: { plan },
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
        yield* bin.add("glab", `exit 0`);
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
          input: { plan },
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
        yield* bin.add("glab", `exit 0`);
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
          input: { plan },
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
        yield* bin.add("glab", `exit 0`);
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
          input: { plan },
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
        yield* bin.add("glab", `exit 0`);
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
        yield* ran({ entry: shipped("implement"), runId: "r-late-grant", input: { plan } });
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
        yield* bin.add("glab", `exit 0`);
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
          input: { plan },
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
        yield* bin.add("glab", `exit 0`);
        // It answers for the branch's pull requests, and is otherwise not there.
        yield* bin.add("gh", `[ "$1" = "pr" ] && { echo '[]'; exit 0; }; exit 127`);
        yield* repository();
        yield* exec(["git", "remote", "set-url", "upstream", "git@github.com:team/project.git"], {
          cwd: rig.projectDir,
        });
        const plan = yield* planOf([{ file: "01-only.md", title: "the only one", checks: "unit" }]);
        const runId = "r-impl-replaced-check";
        yield* approve(runId, ["unit"]);
        yield* rig.queueOutputs([BUILT, CLEAN_SYNTHESIS, OPENED]);
        const entry = shipped("implement");
        yield* stalled({ entry, runId, input: { plan } });
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
            const payload = { runId, input: { plan } };
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
          const result = yield* ran({ entry: shipped("implement"), runId, input: { plan } });
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
            input: { plan },
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
            input: { plan },
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
          expect(yield* stalled({ entry: shipped("implement"), runId, input: { plan } })).toBe(
            "suspended",
          );
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
        yield* bin.add("glab", `exit 0`);
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
        const result = yield* ran({ entry: shipped("implement"), runId, input: { plan } });
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
        yield* bin.add("glab", `exit 0`);
        yield* repository();
        const plan = yield* planOf([{ file: "01-only.md", title: "the only one", checks: "unit" }]);
        const runId = "r-impl-delivery-findings";
        yield* approve(runId, ["unit"]);
        yield* rig.queueOutputs([
          BUILT,
          CLEAN_SYNTHESIS,
          { ...OPENED, findings: [{ severity: "major", title: "delivery blocked" }] },
        ]);
        const result = yield* ran({ entry: shipped("implement"), runId, input: { plan } });
        yield* bin.restore();
        expect(reasonOf(result)).toContain("Merge request delivery did not finish");
        expect(reasonOf(result)).toContain("delivery blocked");
        expect(yield* prompts()).toHaveLength(3);
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
        yield* bin.add("glab", `exit 0`);
        // It answers for the branch's pull requests, and is otherwise not there.
        yield* bin.add("gh", `[ "$1" = "pr" ] && { echo '[]'; exit 0; }; exit 127`);
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
          input: { plan },
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
        yield* bin.add("glab", `exit 0`);
        yield* repository();
        const plan = yield* planOf([{ file: "01-only.md", title: "the only one", checks: "" }]);
        yield* approve("r-impl-none", []);
        yield* rig.queueOutputs([BUILT, CLEAN_SYNTHESIS, GATE_FIX, GATE_FIX, GATE_FIX, GATE_FIX]);
        const options = {
          entry: shipped("implement"),
          runId: "r-impl-none",
          input: { plan },
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
        yield* bin.add("glab", `exit 0`);
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
          input: { plan },
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
        yield* bin.add("glab", `exit 0`);
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
          input: { plan },
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
            input: { plan: "why is the board slow?" },
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

/**
 * A host with no Helle to ask. The claim is a service this machine has no credentials
 * for; what the workflow does with it — take it before anything shared, give it back once
 * the work is done — is what these tests are about.
 */
const claimed: string[] = [];
const withoutHelle: HostOverride = Layer.effect(Host)(
  Effect.gen(function* () {
    const host = yield* Host;
    return Host.of({
      ...host,
      claim: (options) =>
        Effect.as(
          options
            .say("holding the claim")
            .pipe(Effect.tap(() => Effect.sync(() => claimed.push(`claim ${options.runId}`)))),
          { slug: "project" },
        ),
      release: (runId) => Effect.sync(() => void claimed.push(`release ${runId}`)),
    });
  }),
);

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
    yield* bin.add("glab", `exit 0`);
    yield* repository();
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
    preamble: "Repository checkout or GitLab URL",
    create: "glab mr create --assignee whoever-is-configured",
  },
  github: {
    origin: "git@github.com:owner/repo.git",
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

        expect(said(result)).toBe("REN-1: renovated 1.2.0");
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

        expect(said(result)).toBe("REN-1: renovated 1.2.0");
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

        expect(said(result)).toBe("REN-1: renovated deploy-7");
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

const CHORE = "upgrade the VM's install to 0.45.1";
const DONE = { summary: "Upgraded the VM's install to 0.45.1 and restarted the host." };

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
        expect(agents[0]?.args).toContain("--model opus --effort medium");
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
let windowRuns: Array<{ runId: string; parent: string | null; project?: string }> = [];
let openIssues: Issue[] = [];
let filed: Array<{ title: string; body: string }> = [];
let commented: Array<{ number: number; body: string }> = [];
let refusing = new Set<string>();
let unlisted = false;

/** The Machine's report and this checkout's forge, as `self-improve` reads and writes them. */
const improving: HostOverride = Layer.effect(Host)(
  Effect.gen(function* () {
    const host = yield* Host;
    return Host.of({
      ...host,
      report: (since) =>
        Effect.gen(function* () {
          const own = Option.getOrUndefined(yield* Effect.serviceOption(Run))?.id ?? "";
          const runs = [{ runId: own, parent: null }, ...windowRuns].map(
            ({ runId, parent, ...rest }) => ({
              runId,
              workflow: "implement",
              parent,
              project: "project" in rest && rest.project ? rest.project : rig.projectDir,
              created: since,
              status: "failed" as const,
            }),
          );
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
      issues: () =>
        unlisted && filed.length > 0
          ? Effect.fail(new WorkflowError({ reason: "the forge did not answer" }))
          : Effect.succeed([
              ...openIssues,
              ...filed.map(({ title, body }, at) => ({
                number: 101 + at,
                title,
                body,
                url: `https://forge.example/project/issues/${101 + at}`,
              })),
            ]),
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
  "a day's findings are filed or commented, all-new Improvements start, and the summary says so",
  () =>
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

        expect(saidBy(result)).toContain(
          "Filed 3, commented 2, refused 1; 2 Improvements, 1 failed",
        );
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

        expect(
          started.map(({ invocation, workflow, ownTask }) => [invocation, workflow, ownTask]),
        ).toEqual([
          ["improvement-first", "plan", true],
          ["improvement-second", "plan", true],
        ]);
        expect(started[0]?.input.then).toBe("implement");
        expect(started[0]?.input.goal).toContain("`Closes #101`");
        expect(started[0]?.input.goal).toContain("Leaked <github token> in its log.");
        expect(asJson(started)).not.toContain(LEAKED);
        expect(started[1]?.input.goal).toContain("`Closes #102`");

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
    ),
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

export const register = (pass: "shipped" | "unrelated") => {
  beforeEach(() =>
    runEffect(
      Effect.gen(function* () {
        rig = yield* Rig.make();
        const fs = yield* FileSystem.FileSystem;
        dir = `${rig.root}/host`;
        started = [];
        failing = new Set();
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
  for (const one of scenarios) {
    test(
      pass === "unrelated" ? `${one.name} (under an unrelated id)` : one.name,
      () => {
        renamed = pass === "unrelated";
        return one.body().then(() => runEffect(noCommandSubstitution()));
      },
      one.timeout,
    );
  }
  if (pass === "shipped") for (const one of shippedOnly) one();
};

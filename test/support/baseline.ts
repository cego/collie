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

import { afterEach, beforeEach, expect, test } from "bun:test";
import { Effect, Fiber, FileSystem, Layer, Option, Path, Schema } from "effect";
import * as WorkflowEngine from "effect/unstable/workflow/WorkflowEngine";
import { Rig, FakeHerdr } from "./recorder";
import { fastForward, runEffect } from "./effect";
import { FakeBin } from "./bin";
import { installFakeSkills } from "./defs";
import { Agents, agentsLayer, type AgentHost } from "../../src/agents";
import { Children, Host, Run, WorkflowError, type ActionFacts, type ChildAsk } from "../../src/sdk";
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
import { collect, readVerifications } from "../../src/verify";
import { inputsFor, offersFrom } from "../../src/offers";
import { Store } from "../../src/store";
import { registerAgent, registryPath, scopeFor } from "../../src/registry";
import { fixtures, until } from "./host";

const ROOT = new URL("../../", import.meta.url).pathname;

const UNRELATED = {
  plan: "chart-the-work",
  implement: "lay-the-bricks",
  review: "second-look",
  architecture: "survey-the-ground",
  renovate: "keep-current",
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
  >,
  override?: HostOverride,
) =>
  run.pipe(
    Effect.provide(agentsLayer(hostOf())),
    Effect.provide(children),
    Effect.provide(
      override === undefined
        ? foundationLayer({ dir, userDir: rig.userDir })
        : override.pipe(Layer.provideMerge(foundationLayer({ dir, userDir: rig.userDir }))),
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
        expect(yield* persona("r-plan", "grill")).toContain("You are a planner");
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
        yield* repository();
        const plan = yield* planOf([{ file: "01-only.md", title: "the only one", checks: "unit" }]);
        const blocked = {
          ...BUILT,
          verdict: "findings",
          findings: [{ severity: "blocker", title: "the schema will not migrate", file: "db" }],
        };
        yield* approve("r-impl-share", ["unit"]);
        yield* rig.queueOutputs([blocked]);

        const result = yield* ran({
          entry: shipped("implement"),
          runId: "r-impl-share",
          input: { plan },
          options: { repo: "api" },
        });

        expect(result._tag).toBe("Failure");
        expect(reasonOf(result)).toContain("stopped with 1 blocking finding(s)");
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
        const target = "mr:gitlab.example.com/group/project!42";
        const rows = yield* parked({
          entry: shipped("review"),
          runId: "r-review-mr",
          input: { target },
          decision: "post-1",
        });
        expect(optionsOf(rows, "post-1")).toContain("Post to MR");

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
        expect(yield* asked("r-review-mr", "fix")).toContain(
          "glab mr checkout <iid> --repo gitlab.example.com/group/project",
        );
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

scenario(
  "fix findings goes on by itself until a review is clean",
  () =>
    runEffect(
      Effect.gen(function* () {
        const fixed = { verdict: "clean", findings: [], fixed: [], disputed: [], checks: [] };
        const other = {
          ...SYNTHESIS,
          findings: [
            { severity: "major", title: "the empty list is not guarded", file: "src/b.ts" },
          ],
        };
        const clean = { ...SYNTHESIS, verdict: "clean", findings: [] };
        yield* rig.queueOutputs([SYNTHESIS, fixed, other, fixed, clean]);
        const target = "branch:main...HEAD";
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
        // A clean review still asks, so a merge request review can still be posted.
        expect(optionsOf(rows, "post-2")).not.toContain("Fix findings");
      }),
    ),
  120_000,
);

scenario(
  "a rally that runs out of rounds asks, with every option still on the menu",
  () =>
    runEffect(
      Effect.gen(function* () {
        const fixed = { verdict: "clean", findings: [], fixed: [], disputed: [], checks: [] };
        const raising = (title: string) => ({
          ...SYNTHESIS,
          findings: [{ severity: "major", title, file: "src/a.ts" }],
        });
        const target = "branch:main...HEAD";
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
        const fixed = { verdict: "clean", findings: [], fixed: [], disputed: [], checks: [] };
        const target = "branch:main...HEAD";
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
      // it was started on; one that failed holding nothing has nothing to recover.
      const renovate = yield* declaredIn(shipped("renovate"));
      const failed = facts({ succeeded: false, claim: "project" });
      const recovery = offersFrom(renovate, failed, { self: idOf("renovate") });
      expect(recovery.map((offer) => [offer.id, offer.workflow])).toEqual([
        ["recover", idOf("renovate")],
      ]);
      expect(offersFrom(renovate, facts({ succeeded: false }))).toEqual([]);
      const repository = "https://gitlab.example.com/team/project";
      expect(
        inputsFor(recovery[0]!, { runDir: "/r", facts: failed, input: { repository } }),
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
 * A real repository with a GitLab remote. What binds a verification is the tree it ran
 * on, and a directory git knows nothing about has no tree to move.
 */
const repository = () =>
  Effect.sync(() => {
    for (const args of [
      ["init", "-q"],
      ["config", "user.email", "t@example.com"],
      ["config", "user.name", "t"],
      ["remote", "add", "origin", "https://gitlab.example.com/group/project.git"],
    ]) {
      Bun.spawnSync(["git", ...args], { cwd: rig.projectDir });
    }
    Bun.spawnSync(["git", "commit", "-qm", "first", "--allow-empty"], { cwd: rig.projectDir });
  });

/** A plan of tickets on disk, which is the only thing that makes a build a list. */
const planOf = (tickets: ReadonlyArray<{ file: string; title: string; checks: string }>) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const where = `${rig.root}/plan`;
    yield* fs.makeDirectory(`${where}/issues`, { recursive: true });
    yield* fs.writeFileString(`${where}/SPEC.md`, "# The spec\n");
    for (const ticket of tickets) {
      yield* fs.writeFileString(
        `${where}/issues/${ticket.file}`,
        `# ${ticket.title}\n\n**Checks:** ${ticket.checks}\n`,
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
  "a gate the fixes cannot satisfy still opens the merge request, and it says what is unproved",
  () =>
    runEffect(
      Effect.gen(function* () {
        const bin = yield* FakeBin.make(`${rig.root}/bin`);
        yield* bin.add("glab", `exit 0`);
        yield* repository();
        const plan = yield* planOf([{ file: "01-only.md", title: "the only one", checks: "unit" }]);
        // Approved, and it passes only at the default branch's base: an Output that says the
        // tests pass is a claim, and the journal is what the gate reads.
        const count = `${rig.root}/runs`;
        yield* approve("r-impl-gate", ["unit"]);
        const fs = yield* FileSystem.FileSystem;
        yield* fs.writeFileString(
          `${evidenceDir(dir, "r-impl-gate")}/approved.json`,
          asApproved([
            {
              name: "unit",
              executable: "sh",
              argv: [
                "-c",
                `n=$(($(cat ${count} 2>/dev/null || echo 0) + 1)); echo $n > ${count}; [ $n -eq 2 ]`,
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
        yield* rig.queueOutputs([BUILT, CLEAN_SYNTHESIS, fix, fix, fix, fix, OPENED]);

        // Nobody is asked: the fixes run by themselves, and the human reads what is left
        // in the merge request before it lands.
        const result = yield* ran({
          entry: shipped("implement"),
          runId: "r-impl-gate",
          input: { plan },
          options: { outcome: "feature" },
        });
        yield* bin.restore();

        expect(said(result)).toBe(OPENED.mr_url);
        expect(yield* asked("r-impl-gate", "gate-fix-4")).toContain("unit failed");
        const opening = yield* asked("r-impl-gate", "mr");
        expect(opening).toContain("- unproved after 4 gate fixes: unit failed");
      }),
    ),
  120_000,
);

scenario(
  "a gap no check can close goes to the merge request without a gate fix chasing it",
  () =>
    runEffect(
      Effect.gen(function* () {
        const bin = yield* FakeBin.make(`${rig.root}/bin`);
        yield* bin.add("glab", `exit 0`);
        yield* repository();
        const plan = yield* planOf([{ file: "01-only.md", title: "the only one", checks: "unit" }]);
        yield* approve("r-gate-judged", ["unit"]);
        yield* rig.queueOutputs([BUILT, { ...CLEAN_SYNTHESIS, scope_met: false }, OPENED]);
        const result = yield* ran({
          entry: shipped("implement"),
          runId: "r-gate-judged",
          input: { plan },
          options: { outcome: "feature" },
        });
        yield* bin.restore();

        expect(said(result)).toBe(OPENED.mr_url);
        expect(yield* prompts()).toHaveLength(3);
        expect(yield* asked("r-gate-judged", "mr")).toContain(
          "- unproved, and no check can prove it: the review did not report scope_met: true for the agreed scope",
        );
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
        yield* repository();
        const plan = yield* planOf([{ file: "01-only.md", title: "the only one", checks: "unit" }]);
        // Fails at the gate, passes at the default branch's base, fails once more, then passes
        // once the fix has run.
        const count = `${rig.root}/runs`;
        yield* approve("r-gate-fix", ["unit"]);
        const fs = yield* FileSystem.FileSystem;
        yield* fs.writeFileString(
          `${evidenceDir(dir, "r-gate-fix")}/approved.json`,
          asApproved([
            {
              name: "unit",
              executable: "sh",
              argv: [
                "-c",
                `n=$(($(cat ${count} 2>/dev/null || echo 0) + 1)); echo $n > ${count}; [ $n -eq 2 ] || [ $n -ge 4 ]`,
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
        yield* repository();
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
              // What the marker says while it runs, then: red at the gate, green at the
              // base, red again on the recheck, green after the fix.
              argv: [
                "-c",
                `cat ${marker} >> ${seen}; echo >> ${seen}; n=$(($(cat ${count} 2>/dev/null || echo 0) + 1)); echo $n > ${count}; [ $n -eq 2 ] || [ $n -ge 4 ]`,
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

        const passes = ["gate", "baseline", "recheck", "fix"];
        const markers = (yield* fs.readFileString(seen))
          .split("\n")
          .filter((line) => line !== "")
          .map((line) => Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown))(line));
        expect(markers.slice(0, 4)).toMatchObject(
          passes.map((pass) => ({ name: "unit", pass, round: pass === "fix" ? 1 : null })),
        );
        const recorded = (yield* readVerifications(evidenceDir(dir, "r-passes"))).filter(
          (one) => one.by === "collie",
        );
        expect(recorded.slice(0, 4).map((one) => [one.pass, one.round])).toEqual([
          ["gate", undefined],
          ["baseline", undefined],
          ["recheck", undefined],
          ["fix", 1],
        ]);
        // Gone once nothing is running.
        expect(yield* fs.exists(marker)).toBe(false);
      }),
    ),
  120_000,
);

scenario(
  "a check red before the Run is reported in the merge request, and no gate fix is asked for it",
  () =>
    runEffect(
      Effect.gen(function* () {
        const bin = yield* FakeBin.make(`${rig.root}/bin`);
        yield* bin.add("glab", `exit 0`);
        yield* repository();
        const plan = yield* planOf([{ file: "01-only.md", title: "the only one", checks: "unit" }]);
        yield* approve("r-impl-red-base", ["unit"]);
        const fs = yield* FileSystem.FileSystem;
        yield* fs.writeFileString(
          `${evidenceDir(dir, "r-impl-red-base")}/approved.json`,
          asApproved([{ name: "unit", executable: "false", argv: [], cwd: rig.projectDir }]),
        );
        yield* rig.queueOutputs([BUILT, CLEAN_SYNTHESIS, OPENED]);
        const result = yield* ran({
          entry: shipped("implement"),
          runId: "r-impl-red-base",
          input: { plan },
          options: { outcome: "feature" },
        });
        yield* bin.restore();

        expect(said(result)).toBe(OPENED.mr_url);
        const opening = yield* asked("r-impl-red-base", "mr");
        expect(opening).toContain("unit also fails at ");
        expect(opening).toContain("before this Run's changes");
        expect(yield* fs.exists(`${dir}/agents/r-impl-red-base/gate-fix-1.prompt.md`)).toBe(false);
      }),
    ),
  120_000,
);

scenario(
  "a check that passes where the branch left the default branch is the Run's to fix",
  () =>
    runEffect(
      Effect.gen(function* () {
        const bin = yield* FakeBin.make(`${rig.root}/bin`);
        yield* bin.add("glab", `exit 0`);
        yield* repository();
        const git = (...args: string[]) =>
          Bun.spawnSync(["git", ...args], { cwd: rig.projectDir })
            .stdout.toString()
            .trim();
        const base = git("rev-parse", "HEAD");
        git("checkout", "-qb", "feature");
        const fs = yield* FileSystem.FileSystem;
        yield* fs.writeFileString(`${rig.projectDir}/broken`, "");
        git("add", "broken");
        git("commit", "-qm", "break it");
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
        const result = yield* ran({
          entry: shipped("implement"),
          runId: "r-impl-own-red",
          input: { plan },
          options: { outcome: "feature" },
        });
        yield* bin.restore();

        expect(said(result)).toBe(OPENED.mr_url);
        expect(yield* asked("r-impl-own-red", "gate-fix-1")).toContain("unit failed");
        const opening = yield* asked("r-impl-own-red", "mr");
        expect(opening).toContain("- unproved after 4 gate fixes: unit failed");
        expect(opening).not.toContain("also fails at");
        // The comparison ran at the base and put the branch back.
        expect(git("rev-parse", "--abbrev-ref", "HEAD")).toBe("feature");
        const journal = yield* fs.readFileString(
          `${evidenceDir(dir, "r-impl-own-red")}/steering/verifications.jsonl`,
        );
        expect(journal).toContain(base);
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
      }),
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

/** A Run of a shipped module that stops by itself, waited on until it has. */
const stalled = (options: {
  readonly entry: string;
  readonly runId: string;
  readonly input: Readonly<Record<string, Schema.Json>>;
  readonly options?: Readonly<Record<string, string>>;
  readonly host?: HostOverride;
}) =>
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
        return yield* until(
          () =>
            engine.poll(made.workflow, id).pipe(Effect.map((got) => pollStatus(got, "").status)),
          (status) => status === "suspended",
        );
      }).pipe(Effect.provide(made.layer));
    }),
    options.host,
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

scenario(
  "a Run with nothing approved to prove it stops before any agent, and says how to approve something",
  () =>
    runEffect(
      Effect.gen(function* () {
        yield* repository();
        const plan = yield* planOf([{ file: "01-only.md", title: "the only one", checks: "unit" }]);
        yield* approve("r-impl-none", []);

        const status = yield* stalled({
          entry: shipped("implement"),
          runId: "r-impl-none",
          input: { plan },
        });

        expect(status).toBe("suspended");
        expect(yield* rig.cmds()).not.toContain("agent start");
        const why = yield* parkedWhy("r-impl-none");
        // This Run can still be proved; the file only helps the Runs started after it.
        expect(why).toContain("collie run intent verification r-impl-none --name");
        expect(why).toContain("collie run resume r-impl-none");
        expect(why).toContain(".collie/verify.json");
        expect(why).toContain("only when it starts");
      }),
    ),
  120_000,
);

scenario(
  "the same Run, granted a verification and resumed, builds and is held to it at its gate",
  () =>
    runEffect(
      Effect.gen(function* () {
        const bin = yield* FakeBin.make(`${rig.root}/bin`);
        yield* bin.add("glab", `exit 0`);
        yield* repository();
        const plan = yield* planOf([{ file: "01-only.md", title: "the only one", checks: "unit" }]);
        yield* approve("r-impl-grant", []);
        yield* stalled({ entry: shipped("implement"), runId: "r-impl-grant", input: { plan } });

        yield* approve("r-impl-grant", ["unit"]);
        yield* rig.queueOutputs([BUILT, CLEAN_SYNTHESIS, OPENED]);
        const result = yield* resumed({
          entry: shipped("implement"),
          runId: "r-impl-grant",
          input: { plan },
        });
        yield* bin.restore();

        expect(said(result)).toBe(OPENED.mr_url);
        expect(yield* parkedWhy("r-impl-grant")).toBe("");
        expect(yield* asked("r-impl-grant", "build")).toContain(
          `- unit: true (in ${rig.projectDir})`,
        );
        const opening = yield* asked("r-impl-grant", "mr");
        expect(opening).toContain("unit");
        expect(opening).toContain("by collie");
      }),
    ),
  120_000,
);

scenario(
  "a grant emptied while the Run works stops it at its gate with the same repair, not an empty approval",
  () =>
    runEffect(
      Effect.gen(function* () {
        const bin = yield* FakeBin.make(`${rig.root}/bin`);
        yield* bin.add("glab", `exit 0`);
        yield* repository();
        const plan = yield* planOf([{ file: "01-only.md", title: "the only one", checks: "unit" }]);
        yield* approve("r-impl-emptied", ["unit"]);
        yield* rig.queueOutputs([BUILT, CLEAN_SYNTHESIS, OPENED]);
        // A human withdraws the last grant once the build has been handed out.
        let asks = 0;
        const withdrawn: HostOverride = Layer.effect(Host)(
          Effect.gen(function* () {
            const host = yield* Host;
            return Host.of({
              ...host,
              approved: (runId) => ((asks += 1) === 1 ? host.approved(runId) : Effect.succeed([])),
            });
          }),
        );

        const status = yield* stalled({
          entry: shipped("implement"),
          runId: "r-impl-emptied",
          input: { plan },
          host: withdrawn,
        });
        yield* bin.restore();

        expect(status).toBe("suspended");
        expect(yield* parkedWhy("r-impl-emptied")).toContain(
          "collie run intent verification r-impl-emptied --name",
        );
        // Stopped at the gate: built and reviewed, and nobody asked to open anything.
        expect(yield* prompts()).toHaveLength(2);
        // Nor asked to approve a list with nothing in it.
        expect(
          yield* session(Store.pipe(Effect.flatMap((store) => store.asked("r-impl-emptied")))),
        ).toEqual([]);
      }),
    ),
  120_000,
);

scenario(
  "a Run whose outcome needs no evidence is not stopped for having nothing approved",
  () =>
    runEffect(
      // Its agent never answers, so what it waits on is the clock.
      fastForward(
        Effect.gen(function* () {
          yield* repository();
          yield* approve("r-impl-inv", []);
          yield* rig.queueOutputs([null]);

          yield* stalled({
            entry: shipped("implement"),
            runId: "r-impl-inv",
            input: { plan: "why is the board slow?" },
            options: { outcome: "investigation" },
          }).pipe(Effect.timeout("3 seconds"), Effect.ignore);

          // Its agent writes nothing, which parks it for that; never for what was approved.
          const why = yield* parkedWhy("r-impl-inv");
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
          { verdict: "clean", mr_url: "https://gitlab.example.com/x!99", branch: "renovate/batch" },
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
        for (const name of ["renovate.workflow.ts", "renovate.md"]) {
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

/**
 * Registers one pass in the test file that calls it: every scenario as shipped, with the
 * tests about the shipped modules themselves, or every scenario under ids that share
 * nothing with them. Two files, so the two passes run on two workers at once.
 */
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
        return one.body();
      },
      one.timeout,
    );
  }
  if (pass === "shipped") for (const one of shippedOnly) one();
};

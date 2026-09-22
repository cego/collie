// The shipped workflows as modules: plan, review and architecture, run the way a user's
// own module is run.
//
// Nothing here is special-cased for being shipped. The entries are loaded from
// `workflows/` through the public contract, the agents are herdr's through the real
// dispatcher with a stand-in harness at the far end, and the engine is Effect's over real
// SQLite. What is proved is that the Markdown supplies the content — the persona, the
// prompts, the skill each step is started with — while the module decides everything that
// happens: what is asked of whom, in what order, and what the answer starts next.

import { afterEach, beforeEach, expect, test } from "bun:test";
import { Effect, FileSystem, Layer, Path, Schema } from "effect";
import * as WorkflowEngine from "effect/unstable/workflow/WorkflowEngine";
import { Rig, FakeHerdr } from "./support/recorder";
import { runEffect } from "./support/effect";
import { installFakeSkills } from "./support/defs";
import { NativeAgents, agentsLayer, type AgentHost } from "../src/agents";
import { NativeChildren, NativeHost, type ActionFacts, type ChildAsk } from "../src/sdk";
import {
  answerDecision,
  declaredByModule,
  foundationLayer,
  loadEntry,
  runDir,
} from "../src/native";
import { offersFrom } from "../src/offers";
import { Store } from "../src/store";
import { until } from "./support/native";

const ROOT = new URL("../", import.meta.url).pathname;
const shipped = (name: string) => `${ROOT}workflows/${name}.workflow.ts`;

let rig: Rig;
let dir: string;
let started: ChildAsk[] = [];

beforeEach(() =>
  runEffect(
    Effect.gen(function* () {
      rig = yield* Rig.make();
      const fs = yield* FileSystem.FileSystem;
      dir = `${rig.root}/native`;
      started = [];
      yield* fs.makeDirectory(dir, { recursive: true });
      yield* fs.makeDirectory(rig.projectDir, { recursive: true });
      // The skills the shipped personas and steps name, installed where this machine
      // keeps them: a mention resolves to a path, and a step that starts one can.
      yield* installFakeSkills(rig.root);
    }),
  ),
);

afterEach(() => runEffect(rig.close()));

/** The installation is this checkout, so the shipped personas are the ones found. */
const hostOf = (): AgentHost => ({
  dir,
  env: rig.pluginEnv({ HERDR_PLUGIN_ROOT: ROOT }),
  herdr: new FakeHerdr(rig.pluginEnv({ HERDR_PLUGIN_ROOT: ROOT })),
  harness: "claude",
  model: "opus",
  permissions: "bypass",
  compactAtTokens: 0,
  pollMs: 20,
  collectMs: 1000,
});

/** Children as the host admits them, recorded rather than run: this suite is the parent. */
const children = Layer.succeed(NativeChildren)(
  NativeChildren.of({
    start: (ask) =>
      Effect.sync(() => {
        started.push(ask);
        return {
          runId: `${ask.runId}-${ask.invocation}`,
          workflow: ask.workflow,
          invocation: ask.invocation,
          fresh: true,
        };
      }),
    result: () => Effect.succeed("done"),
  }),
);

const session = <A, E>(
  run: Effect.Effect<
    A,
    E,
    | WorkflowEngine.WorkflowEngine
    | NativeAgents
    | NativeChildren
    | NativeHost
    | Store
    | FileSystem.FileSystem
    | Path.Path
  >,
) =>
  run.pipe(
    Effect.provide(agentsLayer(hostOf())),
    Effect.provide(children),
    Effect.provide(foundationLayer({ dir })),
    Effect.scoped,
    Effect.orDie,
  );

const loaded = (entry: string, runId: string) =>
  loadEntry(entry, runId).pipe(
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
        parent: null,
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

test(
  "architecture reads the project it was started for, as the architect, with the skill started",
  () =>
    runEffect(
      Effect.gen(function* () {
        yield* rig.queueOutputs([REPORT]);

        yield* parked({
          entry: shipped("architecture"),
          runId: "r-arch",
          input: {},
          decision: "next",
        });

        // A skill that refuses a model's own invocation is started as a human starts one.
        expect((yield* prompts())[0]?.startsWith("/improve-codebase-architecture ")).toBe(true);
        // The content is the Markdown's, with this Run's own directory rendered into it.
        const work = yield* asked("r-arch", "architecture");
        expect(work).toContain(`Report: ${runDir(dir, "r-arch")}/plan/ARCHITECTURE.md`);
        expect(work).toContain(`Project root: ${rig.projectDir}`);
        // And the persona is the Markdown persona, with its skills as paths to read.
        const body = yield* persona("r-arch", "architecture");
        expect(body).toContain("You are an architect");
        expect(body).toContain("improve-codebase-architecture/SKILL.md");
      }),
    ),
  120_000,
);

test(
  "implement now builds the plan the architect wrote, named and classified by the report",
  () =>
    runEffect(
      Effect.gen(function* () {
        yield* rig.queueOutputs([REPORT]);
        yield* parked({
          entry: shipped("architecture"),
          runId: "r-arch-go",
          input: {},
          decision: "next",
        });

        const result = yield* answered({
          entry: shipped("architecture"),
          runId: "r-arch-go",
          input: {},
          decision: "next",
          value: "Implement now",
        });

        expect(said(result)).toContain("plan/ARCHITECTURE.md");
        expect(started).toHaveLength(1);
        expect(started[0]?.workflow).toBe("implement");
        expect(started[0]?.input).toEqual({ plan: `${runDir(dir, "r-arch-go")}/plan` });
        expect(started[0]?.options).toEqual({
          workspace: rig.projectDir,
          task: "one-registry",
          outcome: "refactor",
        });
      }),
    ),
  120_000,
);

test(
  "stop here is an answer: nothing is started, and the run says where the report is",
  () =>
    runEffect(
      Effect.gen(function* () {
        yield* rig.queueOutputs([REPORT]);
        yield* parked({
          entry: shipped("architecture"),
          runId: "r-arch-stop",
          input: {},
          decision: "next",
        });

        const result = yield* answered({
          entry: shipped("architecture"),
          runId: "r-arch-stop",
          input: {},
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
const GOAL = { goal: "make the registries one", ticket: "" };

test(
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
        expect(interview).toContain(`collie run answer r-plan "Implement now"`);
        // The two skills that write the plan are started, not merely mentioned: both
        // refuse an agent that invokes them itself.
        expect(sent[1]?.startsWith("/to-spec ")).toBe(true);
        expect(sent[2]?.startsWith("/to-tickets ")).toBe(true);
        expect(yield* asked("r-plan", "spec")).toContain(
          `Write the spec to \`${runDir(dir, "r-plan")}/plan/SPEC.md\``,
        );
        expect(yield* persona("r-plan", "grill")).toContain("You are a planner");
      }),
    ),
  120_000,
);

test(
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
        expect(started[0]?.options).toEqual({
          workspace: rig.projectDir,
          task: "one-registry",
          outcome: "feature",
        });
      }),
    ),
  120_000,
);

test(
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

test(
  "review reviews the target, reconciles it, and leaves the prose and the findings behind",
  () =>
    runEffect(
      Effect.gen(function* () {
        yield* rig.queueOutputs([REVIEW, SYNTHESIS]);

        yield* parked({
          entry: shipped("review"),
          runId: "r-review",
          input: { target: "branch:main...HEAD" },
          options: { risks: "security" },
          decision: "post-1",
        });

        expect(yield* prompts()).toHaveLength(2);
        const first = yield* asked("r-review", "review-1");
        expect(first).toContain("Review target: branch:main...HEAD");
        // The axes a human asked for are on top of the complete review, said once.
        expect(first).toContain("Additional axes requested for this change: security");
        expect(first).toContain("Iteration 1 of at most 1");
        // The synthesis is given the reviews to reconcile, as files it can read.
        expect(yield* asked("r-review", "synthesize")).toContain(
          `${dir}/agents/r-review/review-1.json`,
        );

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

test(
  "posting is offered for a merge request and nothing else, and a note that did not land asks again",
  () =>
    runEffect(
      Effect.gen(function* () {
        yield* rig.queueOutputs([REVIEW, SYNTHESIS]);
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

test(
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
        yield* rig.queueOutputs([REVIEW, SYNTHESIS, fixed]);
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

        expect(yield* prompts()).toHaveLength(3);
        expect(yield* asked("r-review-mr", "fix")).toContain(
          "glab mr checkout <iid> --repo gitlab.example.com/group/project",
        );
        expect(yield* persona("r-review-mr", "fix")).toContain("You are an implementer");
        // Fixing is offered once: a second round of it would be the same findings again.
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

test("what a finished Run of each shipped module offers is the module's own declaration", () =>
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
        ...over,
      });
      const declaredIn = (entry: string) =>
        loadEntry(entry, "offers").pipe(
          Effect.map((described) => declaredByModule(described.metadata)),
          Effect.orDie,
        );

      // A review with findings has something to fix; one that came back clean has not,
      // and neither answer comes from the workflow being called "review".
      const review = yield* declaredIn(shipped("review"));
      expect(
        offersFrom(review, facts({ openFindings: 2, diffTarget: "branch:main...HEAD" }), {
          self: "review",
        }).map((offer) => [offer.id, offer.workflow, offer.primary]),
      ).toEqual([
        ["fix-open", "implement", true],
        ["run-again", "review", false],
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
    }),
  ));

test(
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
          input: {},
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
          input: {},
          decision: "next",
          value: "Stop here",
        });
        expect(said(result)).toBe("plan/ARCHITECTURE.md: stopped there");
      }),
    ),
  120_000,
);

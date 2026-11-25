import * as Str from "effect/String";
import { pipe as pipe_ } from "effect/Function";
import * as Arr from "effect/Array";
import * as Rec from "effect/Record";
import * as Option from "effect/Option";
import {
  CriterionSchema,
  FindingSchema,
  FixOutputSchema,
  IntegrationSchema,
  OutgoingFields,
  PrerequisiteStandingSchema,
  Agents,
  Children,
  Host,
  Run,
  Recovery,
  WorkflowError,
  afterMergeAnswers,
  afterMergeIn,
  agentWork,
  answerFor,
  ask,
  benchmarkFile,
  changeKey,
  classifyWorkSource,
  contentOf,
  criteriaIn,
  PlanOutputSchema,
  defineWorkflow,
  evidenceRoots,
  buildable,
  findingsIn,
  formatFindings,
  reportIn,
  identityProblem,
  isBlocking,
  isOpenFinding,
  isSingleRepo,
  orderedTicketsOf,
  planReposOf,
  renderApproved,
  renderProgress,
  forecast,
  sameTree,
  stackedBranch,
  step,
  stepFailed,
  unmetCriteria,
} from "collie";
import type {
  Criterion,
  Finding,
  HandOverGiven,
  Handed,
  Integration,
  Outgoing,
  Slice,
} from "collie";
import { Deferred, Effect, Fiber, FileSystem, Path, Predicate, Schema } from "effect";
import { WorkflowInstance } from "effect/workflow/WorkflowEngine";
import type { WorkflowEngine } from "effect/workflow/WorkflowEngine";
import * as Workflow from "effect/workflow/Workflow";
import * as Activity from "effect/workflow/Activity";
import { connection } from "./connections.ts";
import markdown from "./implement.md" with { type: "text" };
import { measuredBy } from "./measuring.ts";
import { IMPLEMENTER, REVIEWER, ROUNDS, rally, reviewPass, reviewRound } from "./reviewing.ts";
import type { Rallied } from "./reviewing.ts";
import { Tree, deliver, gate, mergeRequest } from "./delivering.ts";

const content = contentOf(markdown);
const text = Schema.String;
const recoveryEntry = (facts: Recovery | undefined) =>
  facts?.review != null ? "Checks" : facts?.implementation === true ? "Review" : "Build";

const Implementing = Schema.Struct({
  inputs: Schema.Struct({
    plan: text,
    plan_kind: text,
    repo: text,
    outcome: text,
    findings: text,
    report: text,
  }),
  run: Schema.Struct({ dir: text, id: text }),
  verify: text,
});

const sectionOf = (section: string, input: typeof Implementing.Type) =>
  pipe_(
    content.sections.get(section) ?? "",
    Str.replaceAll("{{inputs.plan}}", input.inputs.plan),
    Str.replaceAll("{{inputs.findings}}", input.inputs.findings),
    Str.replaceAll("{{run.dir}}", input.run.dir),
  );

const inlinePlanRefusal = (
  plan: string,
  root: string,
  source: { readonly kind: string; readonly value: string },
  chosen: ReadonlyArray<string>,
  said: ReadonlyArray<{
    readonly id: string;
    readonly status: string;
    readonly run: string | null;
  }>,
  by: string,
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const stated = source.kind === "text" ? criteriaIn(source.value) : [];
    const read = yield* planReposOf(plan, root);
    if (read.refusal !== null) {
      return read.refusal.message;
    }
    const tickets = yield* orderedTicketsOf(plan);
    if (tickets.length === 0) {
      return `${plan}/issues/ holds no ticket`;
    }
    if (!isSingleRepo(read)) {
      return "its tickets name more than this checkout: give every ticket **Repo:** .";
    }
    const owned = new Set(Arr.flatMap(tickets, (one) => one.criteria));
    const unowned = Arr.dedupe(
      Arr.filter(
        [...criteriaIn(yield* fs.readFileString(`${plan}/SPEC.md`)), ...stated],
        (one) => !owned.has(one),
      ),
    );
    if (unowned.length > 0) {
      return `these criteria of SPEC.md or the work you were given are no ticket's: ${Arr.join(unowned, "; ")}. Copy each, word for word, into the ticket that answers it`;
    }
    if (source.kind !== "review") {
      return null;
    }
    const texts = yield* Effect.forEach(tickets, (one) =>
      fs.readFileString(`${plan}/issues/${one.file}`),
    );
    const all = yield* findingsIn(source.value);
    const work =
      chosen.length === 0
        ? Arr.filter(buildable(all, said, by), (one) => isOpenFinding(one.status ?? "open"))
        : Arr.filter(all, (one) => one.id !== undefined && Arr.contains(chosen, one.id));
    const dropped = Arr.filter(work, (one) => !Arr.some(texts, Str.includes(one.title)));
    return dropped.length === 0
      ? null
      : `these findings of the review are no ticket's: ${Arr.join(
          Arr.map(dropped, (one) => one.title),
          "; ",
        )}. Name each, word for word, in the ticket that fixes it`;
  }).pipe(Effect.catch((cause) => Effect.succeed(`${plan} cannot be read: ${cause.message}`)));

// WARNING: only the findings somebody chose are the work, so the others are never named to the agent.
const chosenFindingsOf = (
  source: { readonly kind: string; readonly value: string },
  ids: ReadonlyArray<string>,
  said: ReadonlyArray<{
    readonly id: string;
    readonly status: string;
    readonly run: string | null;
  }>,
  by: string,
) =>
  Effect.gen(function* () {
    if (source.kind !== "findings" && source.kind !== "review") {
      return "(none)";
    }
    const all = yield* findingsIn(source.value);
    if (ids.length === 0) {
      return formatFindings(
        Arr.filter(buildable(all, said, by), (one) => isOpenFinding(one.status ?? "open")),
      );
    }
    const chosen = Arr.filter(all, (one) => one.id !== undefined && Arr.contains(ids, one.id));
    const unknown = Arr.filter(ids, (id) => !Arr.some(chosen, (one) => one.id === id));
    if (unknown.length > 0) {
      return yield* new WorkflowError({
        reason: `${source.value}/findings.json holds none of ${Arr.join(unknown, ", ")}`,
      });
    }
    return formatFindings(chosen);
  });

const prompts = {
  build: content.template("build", {
    ...Implementing.fields,
    ticket: Schema.Struct({ file: text, title: text }),
    progress: text,
    session: Schema.Struct({ ask: text }),
    handing: text,
    obstacle: text,
    criteria: text,
    measure: text,
    source: text,
    proof: text,
  }),
  criteria: content.template("criteria", {
    ...Implementing.fields,
    ticket: Schema.Struct({ file: text, title: text }),
    criteria: text,
    findings: text,
    session: Schema.Struct({ ask: text }),
  }),
  fix: content.template("fix", {
    ...Implementing.fields,
    iteration: text,
    max_iterations: text,
    findings: text,
  }),
  ciFix: content.template("ci-fix", {
    ...Implementing.fields,
    iteration: text,
    max_iterations: text,
    findings: text,
  }),
  merge: content.template("merge", { ...Implementing.fields, conflict: text }),
  plan: content.template("plan", { ...Implementing.fields, source: text, refusal: text }),
  mr: content.template("mr", {
    ...Implementing.fields,
    built: text,
    ledger: text,
    evidence: text,
    unreviewed: text,
    unsettled: text,
    mr: Schema.Struct({
      forge: text,
      noun: text,
      assignee: text,
      template: text,
      issues: text,
      existing: text,
      publish: text,
    }),
    target_repo: text,
  }),
};

const Built = Schema.Struct({
  verdict: Schema.Literals(["clean", "findings"]),
  findings: Schema.optionalKey(Schema.Array(FindingSchema)),
  branch: Schema.optionalKey(Schema.String),
  pushed: Schema.optionalKey(Schema.Boolean),
  tickets_done: Schema.optionalKey(Schema.Array(Schema.String)).annotate({
    description: "the tickets you built, by title",
  }),
  commits: Schema.optionalKey(Schema.Array(Schema.String)).annotate({
    description: "the commit subjects you left behind",
  }),
  criteria: Schema.optionalKey(Schema.Array(CriterionSchema)).annotate({
    description: "one entry per acceptance criterion you were given",
  }),
  tests: Schema.optionalKey(Schema.String),
  reproduced: Schema.optionalKey(Schema.String),
  conclusion: Schema.optionalKey(Schema.String),
  evidence: Schema.optionalKey(Schema.Array(Schema.String)),
  patch: Schema.optionalKey(Schema.Boolean),
  documented_commands: Schema.optionalKey(Schema.Array(Schema.String)),
  assumptions: Schema.optionalKey(Schema.Array(Schema.String)).annotate({
    description: "each decision you made that the spec did not settle, and why, one sentence each",
  }),
  ...OutgoingFields,
});

const ChangeReading = Schema.Struct({
  key: Schema.String,
  repo: Schema.String,
  change: Schema.optional(Schema.String),
  stacked: Schema.optional(Schema.String),
});

const Reading = Schema.Struct({
  single: Schema.Boolean,
  waves: Schema.Array(Schema.Array(Schema.String)),
  changes: Schema.optionalKey(Schema.Array(ChangeReading)),
  refusal: Schema.NullOr(Schema.String),
});

const SliceRecord = Schema.Struct({
  file: Schema.String,
  number: Schema.String,
  title: Schema.String,
  blockedBy: Schema.Array(Schema.String),
  checks: Schema.Array(Schema.String),
  // WARNING: a reading journaled before tickets carried criteria has none.
  criteria: Schema.optionalKey(Schema.Array(Schema.String)),
  benchmark: Schema.optionalKey(Schema.NullOr(Schema.String)),
  prerequisites: Schema.optionalKey(
    Schema.Array(Schema.Struct({ run: Schema.String, change: Schema.NullOr(Schema.String) })),
  ),
});

const TicketReading = Schema.Struct({
  criteria: Schema.Array(Schema.String),
  afterMerge: Schema.Array(Schema.String),
});

const Opened = Schema.Struct({
  verdict: Schema.Literals(["clean", "findings"]),
  findings: Schema.optionalKey(Schema.Array(FindingSchema)),
  mr_url: Schema.optionalKey(Schema.NullOr(Schema.String)),
  linear_issues: Schema.optionalKey(Schema.Array(Schema.String)),
  branch: Schema.optionalKey(Schema.String),
  // WARNING: false is a real answer: auto-merge on somebody else's merge request is a reason not to push.
  pushed: Schema.Boolean,
});

const PLAN_TRIES = 2;
const CRITERIA_TRIES = 2;
const MERGE_TRIES = 2;

const BUILDER = "build";
const DELIVERER = "deliver";

const RELEASE = "Release";
const STAGE = "Stage";
const CHECK_STAGE = "Check Stage again";
const FINISH = "Finish";
const HAND_BACK = "Hand back";
const STOP = "Stop";
const CRITERIA_OPTIONS = [
  {
    id: HAND_BACK,
    detail: "Re-runs the criteria check after you amend the ticket.",
    recommended: true,
  },
  { id: STOP, detail: "Ends the Run; no review starts." },
];

const planning = step({
  id: "plan",
  title: "Plan",
  description: "The implementer writes the work into the Run's plan before any of it is built.",
  kind: "agent",
  role: "implementer",
});
const building = step({
  id: "build",
  title: "Build",
  description: "The implementer builds a ticket, or the whole of the work where there is one.",
  kind: "agent",
  role: "implementer",
});
const next = step({
  id: "next",
  title: "What next",
  description: "Whether the open merge request is released, staged or left as it is.",
  kind: "question",
});
const delivery = [building, reviewRound, gate, mergeRequest];
const repoRuns = step({
  id: "repo-runs",
  title: "Change runs",
  description: "One Run per Change the plan names, a Wave at a time.",
  kind: "workflow",
});

export default defineWorkflow({
  id: "implement",
  connections: {
    uses: {
      linear: {
        with: "Moves the issue and links the merge request",
        without: "Leaves issues alone",
      },
      gitlab: {
        with: "Pushes its branch and opens the merge request",
        without: "Stops at the merge request step and says why",
      },
      github: {
        with: "Opens a pull request for a github.com repository",
        without: "Stops at the pull request step and says why",
      },
    },
  },
  title: "implement — build the plan, review it, fix until nothing blocks",
  description:
    "Builds a change on a branch of its own and ends in a merge request: from a plan dir, a Linear issue or a description, it gets one complete review and fixes what blocks until a review finds nothing blocking.",
  input: Schema.Struct({
    plan: Schema.String.annotate({
      description:
        "Where the work is written down: a plan, a review, an issue, a follow-up, or words",
    }),
    findings: Schema.optionalKey(
      Schema.Array(Schema.String).annotate({
        description: "The findings to build, by id; every open one where none is given",
      }),
    ),
    recovery: Schema.optionalKey(
      Schema.String.annotate({
        description: "The finished Run whose existing work this explicit follow-up recovers",
      }),
    ),
    // oxlint-disable-next-line unicorn/no-thenable -- The workflow input selects the next step using string values.
    then: Schema.optionalKey(
      Schema.Union([
        Schema.Literal("").annotate({ title: "Ask at the merge request" }),
        Schema.Literal("finish").annotate({ title: "End at the merge request" }),
        Schema.Literal("release").annotate({ title: "Release it" }),
      ]).annotate({
        description:
          "What follows the merge request: finish to end there, release to release it on a human's go, empty to be asked",
      }),
    ),
  }),
  output: Schema.String,
  agents: { roles: { implementer: IMPLEMENTER, reviewer: REVIEWER } },
  // oxlint-disable-next-line unicorn/no-thenable -- the Input is named `then`
  hints: { plan: "work-source", then: "reach" },
  path: [...delivery, next],
  // WARNING: the branch is built on a worktree of its own, so two Runs never share an index.
  checkout: "branch",
  outcome: {
    selectable: ["feature", "bug", "refactor", "investigation", "docs", "migration"],
  },
  followUps: [
    {
      id: "release",
      connections: ["gitlab"],
      title: "Release",
      workflow: "release",
      when: "succeeded",
      inputs: { mr: "merge-request" },
      given: { ship: "release" },
      ships: "release",
      confirm:
        "Release waits until the merge request is approved, green and proved at its head, then asks for your go. On it, it merges, tags the release and deploys the tag to stage where it has one; production waits for a second go.",
      eligible: (facts) => facts.mrUrl !== null,
    },
    {
      id: "merge",
      connections: ["gitlab"],
      title: "Merge",
      workflow: "release",
      when: "succeeded",
      inputs: { mr: "merge-request" },
      given: { ship: "merge" },
      ships: "merge",
      confirm:
        "Merge waits until the merge request is approved, green and proved at its head, then asks for your go. On it, it merges and stops: nothing is tagged or deployed.",
      eligible: (facts) => facts.mrUrl !== null,
    },
    {
      id: "stage",
      connections: ["gitlab"],
      title: "Stage",
      workflow: "stage",
      when: "succeeded",
      inputs: { mr: "merge-request" },
      eligible: (facts) => facts.mrUrl !== null,
    },
    {
      id: "follow-up",
      title: "Keep going on this",
      workflow: "self",
      when: "always",
      inputs: { plan: "started-with", recovery: "run-dir" },
      entry: (facts) => recoveryEntry(facts.recovery),
      eligible: (facts) => facts.branch !== null && facts.nothingToLand !== true,
    },
  ],
  run: ({ input: asked }) =>
    Effect.gen(function* () {
      const host = yield* Host;
      const agents = yield* Agents;
      const runId = (yield* Run).id;
      const place = yield* host.place(runId);
      const cwd = place.cwd;
      if ((asked.then ?? "") !== "") {
        yield* forecast(delivery);
      }
      const source = yield* Activity.make({
        name: "work-source",
        success: Schema.Struct({ kind: Schema.String, value: Schema.String }),
        execute: classifyWorkSource(asked.plan).pipe(
          Effect.orElseSucceed(() => ({ kind: "text", value: asked.plan })),
        ),
      });
      const said = yield* Activity.make({
        name: "finding-statuses",
        success: Schema.Array(
          Schema.Struct({
            id: Schema.String,
            status: Schema.String,
            run: Schema.NullOr(Schema.String),
          }),
        ),
        execute: host.findingStatuses(source.value),
      });
      const findingsText = yield* Activity.make({
        name: "findings",
        success: text,
        error: WorkflowError,
        execute: chosenFindingsOf(source, asked.findings ?? [], said, runId),
      });
      const share = place.options.repo ?? "";
      if (source.kind === "linear") {
        const linear = yield* connection("linear");
        if (linear.state !== "ok") {
          return yield* new WorkflowError({
            reason: `Cannot read the work source ${source.value}: ${linear.detail}. Fix: ${linear.fix}. Give the issue text as the work source to build without Linear.`,
          });
        }
      }
      if (source.kind === "plan-dir" && share === "") {
        const plan = yield* Activity.make({
          name: "repos",
          success: Reading,
          execute: planReposOf(source.value, cwd).pipe(
            Effect.map((read) => ({
              single: isSingleRepo(read),
              waves: Arr.map(read.waves, (wave) => [...wave]),
              changes: Arr.map(read.repos, ({ path, change, stacked }) => ({
                key: changeKey({ path, change }),
                repo: path,
                change,
                stacked,
              })),
              refusal: read.refusal?.message ?? null,
            })),
            // WARNING: a plan that cannot be read is refused by name, not a defect the Run dies of.
            Effect.catch((cause) =>
              Effect.succeed({
                single: false,
                waves: [],
                refusal: `the plan at ${source.value} could not be read: ${cause.message}`,
              }),
            ),
          ),
        });
        if (plan.refusal !== null) {
          return yield* new WorkflowError({ reason: plan.refusal });
        }
        if (!plan.single) {
          yield* forecast([repoRuns]);
          const carried = Rec.fromEntries(
            Arr.filter(
              Rec.toEntries(place.options),
              ([name]) => name !== "repo" && name !== "workspace",
            ),
          );
          return yield* buildEach({
            plan: source.value,
            root: cwd,
            waves: plan.waves,
            changes: plan.changes ?? [],
            options:
              carried.branch !== undefined || carried.task !== undefined
                ? carried
                : { ...carried, task: runId },
          });
        }
      }
      const unbuilt = (name: string, reason: string) =>
        Activity.make({
          name: `${name}.park`,
          execute: Effect.gen(function* () {
            const fs = yield* FileSystem.FileSystem;
            const marker = `${place.dir}/${name}.parked`;
            if (yield* fs.exists(marker).pipe(Effect.orDie)) {
              return yield* host.parked(runId, null);
            }
            const why = `${reason}. Correct it, then resume ${runId}.`;
            yield* fs.writeFileString(marker, "").pipe(Effect.orDie);
            yield* host.record(runId, why);
            yield* stepFailed(why);
            yield* host.parked(runId, why, "step-failed");
            return yield* Workflow.suspend(yield* WorkflowInstance);
          }),
        });
      const checksNow = Effect.map(host.approved(runId), renderApproved);

      const reportFile = yield* Activity.make({
        name: "report",
        success: text,
        execute:
          source.kind === "findings" || source.kind === "review"
            ? reportIn(source.value)
            : Effect.succeed(""),
      });
      let input: typeof Implementing.Type = {
        inputs: {
          plan: source.value,
          plan_kind: source.kind,
          repo: place.options.repo ?? "",
          outcome: place.options.outcome ?? "",
          findings: findingsText,
          report: reportFile,
        },
        run: { dir: place.dir, id: runId },
        verify: yield* checksNow,
      };
      // WARNING: asked again for each ticket, so a planner that has gone is never described as live.
      const sessionNow = Effect.map(agents.askRoute("planner", place.lineage), (ask) => ({
        ask,
      }));

      let integrations = 0;
      let base = "";
      const integrateNow = Effect.gen(function* () {
        integrations += 1;
        const done = yield* Activity.make({
          name: `integrate.${integrations}`,
          success: IntegrationSchema,
          execute: Effect.gen(function* () {
            const done = yield* host.integrate(runId, cwd);
            if (done.status !== "unavailable") {
              return done;
            }
            const why = `not integrated: ${done.reason}`;
            yield* host.record(runId, why);
            yield* host.parked(
              runId,
              `${pipe_(why, Str.replace(/\.+$/, ""))}. Resume ${runId} once it can be read.`,
            );
            return yield* Workflow.suspend(yield* WorkflowInstance);
          }),
        });
        yield* host.parked(runId, null);
        if (done.sha !== "") {
          base = done.sha;
        }
        if (done.status === "waiting") {
          yield* host.record(runId, `not integrated: ${done.reason}`);
        }
        return done;
      });
      // WARNING: work goes on only from an integrated checkout.
      const integrated = (operation: string, conflictsToTicket = false) =>
        Effect.gen(function* () {
          const settles = (done: Integration) =>
            done.status === "unchanged" ||
            done.status === "merged" ||
            (conflictsToTicket && done.status === "conflicted");
          let merged = yield* integrateNow;
          for (let tries = 1; tries <= MERGE_TRIES && !settles(merged); tries++) {
            yield* agentWork({
              operation: tries === 1 ? operation : `${operation}-${tries}`,
              ...onHolder(handing),
              role: "implementer",
              pushes: true,
              instructions: prompts.merge,
              input: { ...input, verify: yield* checksNow, conflict: stoppedBy(merged) },
              output: Built,
            });
            merged = yield* integrateNow;
          }
          if (!settles(merged)) {
            return yield* new WorkflowError({
              reason: `${merged.ref || merged.branch} is not integrated, so the work stops: ${stoppedBy(merged)}`,
            });
          }
          return { ...merged, base };
        });
      // WARNING: the kind may change while the Run is live, so it is read at each use.
      const outcomeOf = Effect.map(host.place(runId), (now) => now.options.outcome ?? "");
      let kindReadings = 0;
      const kindNow = Effect.suspend(() => {
        kindReadings += 1;
        return Activity.make({
          name: `outcome.${kindReadings}`,
          success: text,
          execute: outcomeOf,
        });
      });
      const restateKind = Effect.map(kindNow, (outcome) => {
        input = { ...input, inputs: { ...input.inputs, outcome } };
      });
      const handing: Handing = {
        plan: null,
        ticket: null,
        said: undefined,
        sessions: place.features?.agent_sessions ?? "run",
        agent: BUILDER,
        last: "",
        from: null,
        fixes: new Map(),
        proof: new Map(),
      };
      const rallyAsk = {
        rounds: { n: 0 },
        cwd,
        proves: kindNow,
        risks: place.options.risks ?? "",
        integrate: integrated,
        handing,
      };

      // WARNING: an empty Input is one left out, so an empty recovery is new work.
      const recovers = asked.recovery === "" ? undefined : asked.recovery;
      const recovered = yield* Activity.make({
        name: "recovery-entry",
        success: Recovery,
        error: WorkflowError,
        execute:
          recovers === undefined
            ? Effect.succeed({
                implementation: false,
                reason: "An ordinary start builds the work.",
                previous: "",
                commits: "",
                review: null,
              })
            : host.recovery(runId, recovers, asked.plan),
      });
      const recovery = { ...recovered, entry: recoveryEntry(recovered) };
      if (recovers !== undefined) {
        yield* host.record(runId, `Follow-up enters at ${recovery.entry}: ${recovery.reason}`);
      }
      // WARNING: only a Run started under `inline_plan: on` plans a source that is not a plan first.
      const planDir = `${place.dir}/plan`;
      const planned =
        place.features?.inline_plan === true &&
        source.kind !== "plan-dir" &&
        recovery.entry === "Build";
      if (planned) {
        yield* planning(
          Effect.gen(function* () {
            let refusal = "";
            for (let attempt = 1; ; attempt++) {
              const operation = attempt === 1 ? "plan" : `plan-${attempt}`;
              yield* agentWork({
                operation,
                ...onHolder(handing),
                role: "implementer",
                instructions: prompts.plan,
                input: { ...input, source: sectionOf(`plan.${source.kind}`, input), refusal },
                output: PlanOutputSchema,
              });
              const refused = yield* Activity.make({
                name: `${operation}.check`,
                success: Schema.NullOr(Schema.String),
                execute: inlinePlanRefusal(planDir, cwd, source, asked.findings ?? [], said, runId),
              });
              if (refused === null) {
                break;
              }
              if (attempt === PLAN_TRIES) {
                return yield* new WorkflowError({
                  reason: `the plan at ${planDir} cannot be built: ${refused}`,
                });
              }
              refusal = `The plan you wrote cannot be built: ${pipe_(refused, Str.replace(/\.+$/, ""))}. Correct it in place.`;
            }
            input = { ...input, inputs: { ...input.inputs, plan: planDir, plan_kind: "plan-dir" } };
          }),
        );
      }
      const work = planned ? { kind: "plan-dir", value: planDir } : source;
      handing.plan = work.kind === "plan-dir" ? work.value : null;

      // WARNING: each reading is recorded, so a replay is handed the list that was read.
      let readings = 0;
      const ticketsNow = Effect.gen(function* () {
        readings += 1;
        if (work.kind !== "plan-dir") {
          return [];
        }
        const read = yield* Activity.make({
          name: `tickets.${readings}`,
          success: Schema.Array(SliceRecord),
          execute: orderedTicketsOf(
            work.value,
            place.options.repo ?? "",
            place.options.change ?? "",
          ),
        });
        return Arr.map(read, (one) => ({
          ...one,
          criteria: one.criteria ?? [],
          benchmark: one.benchmark ?? null,
          prerequisites: one.prerequisites ?? [],
        }));
      });
      let tickets: ReadonlyArray<Slice> = yield* ticketsNow;
      // WARNING: read only after the build, which is what writes SPEC.md for any source but a plan.
      let specReadings = 0;
      const specNow = Effect.gen(function* () {
        const plan = work.kind === "plan-dir" ? work.value : `${place.dir}/plan`;
        for (;;) {
          specReadings += 1;
          const readable = yield* Activity.make({
            name: `spec-readable.${specReadings}`,
            success: Schema.Boolean,
            execute: FileSystem.FileSystem.pipe(
              Effect.flatMap((fs) => fs.readFileString(`${plan}/SPEC.md`)),
              Effect.as(true),
              Effect.orElseSucceed(() => false),
            ),
          });
          if (readable) {
            return plan;
          }
          if (work.kind !== "plan-dir") {
            return "";
          }
          yield* building(
            unbuilt(`spec-${specReadings}`, `${plan}/SPEC.md cannot be read, so no review starts`),
          );
        }
      });
      const whole = tickets.length < 2;
      const built = new Set<string>();
      const handed: Array<Handed> = [];
      const assumed: Array<string> = [];
      const afterMerged: Array<string> = [];
      const answeredFor: Array<Answered> = [];
      let build: typeof Built.Type | null = null;
      let rallied: Rallied | null = null;
      const ledgered = place.features?.findings_ledger === true;
      const ledger = new Map<string, Finding>();
      const ledgering = (given: ReadonlyArray<Finding>) =>
        ledgered ? { ledger: given, taken: [...ledger.keys()] } : {};
      const kept = (done: Rallied) => {
        for (const one of ledgered ? done.reviewed.findings : []) {
          if (one.id !== undefined) {
            ledger.set(one.id, one);
          }
        }
        return done;
      };
      let parentDir = "";
      if (recovery.entry !== "Build") {
        const parent = Str.split(recovers ?? "", "/").at(-1) ?? "";
        parentDir = (yield* host.place(parent)).dir;
        const claimsAt = (
          from: string,
          operations: ReadonlyArray<string> = ["build", ...Arr.map(tickets, (one) => one.file)],
        ) =>
          Effect.gen(function* () {
            const fs = yield* FileSystem.FileSystem;
            const outputs = yield* Effect.forEach(operations, (operation) =>
              fs.readFileString(agents.outputFor(from, operation)).pipe(
                Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(Built))),
                Effect.orElseSucceed(() => null),
              ),
            );
            const found = Arr.filter(outputs, Predicate.isNotNull);
            const last = found.at(-1);
            return last === undefined
              ? null
              : {
                  ...last,
                  tickets_done: Arr.flatMap(found, (one) => one.tickets_done ?? []),
                  criteria: Arr.flatMap(found, (one) => one.criteria ?? []),
                };
          });
        build = yield* Activity.make({
          name: "recovery-build-claims",
          success: Schema.NullOr(Built),
          execute: claimsAt(parent),
        });
        // WARNING: a completed null Activity stays null on replay.
        if (build === null) {
          build = yield* Activity.make({
            name: "recovery-build-claims-ancestry",
            success: Schema.NullOr(Built),
            execute: Effect.gen(function* () {
              const fs = yield* FileSystem.FileSystem;
              const path = yield* Path.Path;
              for (const from of recovered.lineage ?? [parent]) {
                const files = yield* fs
                  .readDirectory(path.dirname(agents.outputFor(from, "build")))
                  .pipe(Effect.orElseSucceed(() => []));
                const tickets = Arr.sort(
                  Arr.filter(files, (name) => pipe_(name, Str.endsWith(".md.json"))),
                  Str.Order,
                );
                const claims = yield* claimsAt(from, [
                  "build",
                  ...Arr.map(tickets, (name) => pipe_(name, Str.slice(0, -5))),
                ]);
                if (claims !== null) {
                  return claims;
                }
              }
              return null;
            }),
          });
        }
        yield* forecast([
          ...(recovery.entry === "Review" ? [reviewRound] : []),
          gate,
          mergeRequest,
          next,
        ]);
        if (recovery.entry === "Checks" && recovery.review !== null) {
          rallied = {
            halted: null,
            unreviewed: "",
            unsettled: [],
            disputes: [],
            reviewed: recovery.review,
          };
        }
      }
      const needing = (one: Slice) => ({
        runId,
        cwd,
        ticket: `${work.value}/issues/${one.file}`,
      });
      let prerequisiteReads = 0;
      const landed = (one: Slice) =>
        Effect.suspend(() => {
          prerequisiteReads += 1;
          return Activity.make({
            name: `prerequisites.${prerequisiteReads}`,
            success: PrerequisiteStandingSchema,
            error: WorkflowError,
            execute: host.prerequisites(needing(one)),
          });
        }).pipe(Effect.map((standing) => standing._tag === "Landed"));
      let prerequisiteWaits = 0;
      const awaited = (one: Slice) =>
        Effect.gen(function* () {
          prerequisiteWaits += 1;
          const standing = yield* Activity.make({
            name: `prerequisites-wait.${prerequisiteWaits}`,
            success: PrerequisiteStandingSchema,
            error: WorkflowError,
            execute: Effect.gen(function* () {
              const standing = yield* host.awaitPrerequisites(needing(one));
              if (standing._tag === "Held") {
                return yield* Workflow.suspend(yield* WorkflowInstance);
              }
              return standing;
            }),
          });
          if (standing._tag === "Never") {
            yield* unbuilt(
              `${one.file}.prerequisites-${prerequisiteWaits}`,
              `${one.file}: ${standing.why}`,
            );
          }
        });
      const pickable = Effect.gen(function* () {
        for (;;) {
          const left = Arr.filter(tickets, (one) => !built.has(one.file));
          if (left.length === 0) {
            return undefined;
          }
          const unblocked = Arr.filter(left, (one) =>
            Arr.every(one.blockedBy, (id) => !Arr.some(left, (other) => other.number === id)),
          );
          for (const one of unblocked) {
            if (one.prerequisites.length === 0 || (yield* landed(one))) {
              return one;
            }
          }
          const waiting = unblocked[0];
          if (waiting === undefined) {
            return yield* new WorkflowError({
              reason: `these tickets block each other, so none of them can be built first: ${Arr.join(
                Arr.map(left, (one) => one.file),
                ", ",
              )}`,
            });
          }
          yield* building(awaited(waiting), {
            item: waiting.file,
            items: Arr.map(tickets, (one) => one.file),
          });
        }
      });
      for (; recovery.entry === "Build";) {
        // WARNING: identities are checked before work; two tickets nobody can tell apart would share one result.
        const clash = identityProblem(Arr.map(tickets, (ticket) => ticket.file));
        if (clash !== null) {
          return yield* new WorkflowError({ reason: clash });
        }
        const next = yield* pickable;
        const ticket = whole && built.size === 0 ? null : next;
        if (ticket === undefined) {
          break;
        }
        rallied = null;
        if (ticket !== null && built.size > 0 && handing.sessions !== "run") {
          handTo(handing, `${BUILDER}-${pipe_(ticket.file, Str.replace(/\.md$/, ""))}`);
        }
        let attempt = 0;
        const nextBuild = building(
          Effect.gen(function* () {
            attempt += 1;
            const item = ticket?.file ?? "build";
            const operation = attempt === 1 ? item : `${item}-${attempt}`;
            const before = (yield* host.evidence(runId, cwd)).verifications.length;
            if (ticket !== null) {
              yield* host.checkpoint(runId, { ticket: ticket.file, status: "started", claims: [] });
            }
            const merged =
              (ticket !== null && built.size > 0) ||
              Arr.some(ticket === null ? tickets : [ticket], (one) => one.prerequisites.length > 0)
                ? yield* integrated(`${item}.merge`, true)
                : null;
            const session = yield* sessionNow;
            const given =
              ticket?.criteria ??
              (work.kind === "text"
                ? criteriaIn(work.value)
                : Arr.flatMap(tickets, (one) => one.criteria));
            yield* restateKind;
            handing.ticket = ticket?.file ?? null;
            build = yield* agentWork({
              operation,
              ...onHolder(handing),
              handOver: handOverOf(handing, {
                criteria: given,
                checks: ticket?.checks ?? [],
                findings: [...ledger.values()],
              }),
              role: "implementer",
              pushes: true,
              instructions: prompts.build,
              input: {
                ...input,
                verify: yield* checksNow,
                ticket: { file: ticket?.file ?? "", title: ticket?.title ?? "" },
                progress: renderProgress(handed),
                session,
                handing:
                  handing.sessions === "run" ? "" : `\n\n${content.sections.get("handing") ?? ""}`,
                criteria:
                  ticket === null && work.kind === "linear"
                    ? "Every checkbox in the issue's description. Copy the description into the spec word for word, its checkboxes included, and answer each one."
                    : renderCriteria(given),
                measure:
                  work.kind !== "plan-dir"
                    ? measuredBy("measure.own", `${place.dir}/plan/issues/NN-<slug>.benchmark.json`)
                    : ticket?.benchmark != null
                      ? measuredBy("measure", benchmarkFile(work.value, ticket.benchmark))
                      : "",
                source: sectionOf(`source.${work.kind}`, input),
                proof: sectionOf(
                  content.sections.has(`outcome.${input.inputs.outcome}`)
                    ? `outcome.${input.inputs.outcome}`
                    : "outcome.unspecified",
                  input,
                ),
                obstacle:
                  merged?.status === "conflicted"
                    ? `${conflictOf(merged)}\n\nFinish that merge before this ticket's work goes on: resolve those files, \`git add\` them and \`git commit --no-edit\`. Never rebase, reset or abort it.`
                    : "",
              },
              output: Built,
            });
            handing.said = build;
            handing.last = operation;
            let spec: ReadonlyArray<string> | null = given;
            for (let reading = 1; ; reading++) {
              spec =
                ticket === null && work.kind === "linear"
                  ? yield* Activity.make({
                      name: `${operation}.criteria.spec-${reading}`,
                      success: Schema.NullOr(Schema.Array(Schema.String)),
                      execute: FileSystem.FileSystem.pipe(
                        Effect.flatMap((fs) => fs.readFileString(`${place.dir}/plan/SPEC.md`)),
                        Effect.map(criteriaIn),
                        Effect.orElseSucceed(() => null),
                      ),
                    })
                  : given;
              if (spec !== null) {
                break;
              }
              yield* unbuilt(
                `${operation}.spec-${reading}`,
                `${item}: ${place.dir}/plan/SPEC.md cannot be read, so the issue's acceptance criteria cannot be checked and no review starts`,
              );
            }
            // WARNING: a plan's tickets are read again before each judgement; one that cannot be read keeps its last reading.
            let read: ReadonlyArray<{ file: string } & typeof TicketReading.Type> =
              work.kind === "plan-dir"
                ? Arr.map(ticket === null ? tickets : [ticket], (one) => ({
                    file: one.file,
                    criteria: one.criteria,
                    afterMerge: [],
                  }))
                : [];
            let reads = 0;
            const criteriaNow = Effect.gen(function* () {
              if (read.length === 0) {
                return spec;
              }
              reads += 1;
              const now = yield* Activity.make({
                name: `${operation}.criteria.read-${reads}`,
                success: Schema.Array(Schema.NullOr(TicketReading)),
                execute: FileSystem.FileSystem.pipe(
                  Effect.flatMap((fs) =>
                    Effect.forEach(read, (one) =>
                      fs.readFileString(`${work.value}/issues/${one.file}`).pipe(
                        Effect.map((text) => ({
                          criteria: criteriaIn(text),
                          afterMerge: afterMergeIn(text),
                        })),
                        Effect.orElseSucceed(() => null),
                      ),
                    ),
                  ),
                ),
              });
              read = Arr.map(read, (one, at) => (now[at] ? { file: one.file, ...now[at] } : one));
              return Arr.flatMap(read, (one) => one.criteria);
            });
            let answers = boundTo(spec, build.criteria ?? []);
            const assumptions = [...(build.assumptions ?? [])];
            const commits = [...(build.commits ?? [])];
            let criteria = spec;
            handing.proof.set(item, { criteria, answers, checks: ticket?.checks ?? [] });
            let unmet: ReadonlyArray<Finding>;
            // WARNING: another hand-back on an unchanged tree cannot move a blocker, so a stall asks instead.
            let blockers: ReadonlyArray<Finding> = [];
            let stalls = 0;
            let unmetAsks = 0;
            let stopped: string | null = null;
            const treeAt = (name: string) =>
              Activity.make({
                name,
                success: Tree,
                execute: Effect.map(host.evidence(runId, cwd), ({ final }) => ({
                  head: final.head_sha,
                  fingerprint: final.fingerprint,
                })),
              });
            for (let tries = 1, turn = 1; ;) {
              criteria = yield* criteriaNow;
              unmet = unmetCriteria(item, criteria, answers);
              if (unmet.length === 0) {
                break;
              }
              if (blockers.length > 0) {
                stalls += 1;
                if (stalls === 1) {
                  yield* host.record(
                    runId,
                    `${item}: a criteria hand-back reported a blocker and changed nothing; Collie handed it back without asking, and asks if it does again`,
                  );
                  blockers = [];
                  tries = 1;
                  continue;
                }
                const chosen = yield* ask({
                  name: `${operation}.criteria-stalled-${stalls - 1}`,
                  prompt: `${item}: a criteria hand-back reported a blocker and changed nothing.\n\nIts blockers:\n${formatFindings(blockers)}\n\nStill unmet:\n${formatFindings(unmet)}\n\nAmend the ticket or clear the blocker, then hand it back, or stop the Run.`,
                  options: CRITERIA_OPTIONS,
                });
                if (chosen !== HAND_BACK) {
                  stopped = `${item}: a criteria hand-back reported a blocker and changed nothing, so no review starts: ${Arr.join(
                    Arr.map(unmet, (one) => one.title),
                    "; ",
                  )}`;
                  break;
                }
                blockers = [];
                tries = 1;
                continue;
              }
              if (tries > CRITERIA_TRIES) {
                unmetAsks += 1;
                const name = `${operation}.criteria-unmet-${unmetAsks}`;
                const still = `${item}: acceptance criteria still unanswered or unmet after ${CRITERIA_TRIES} hand-backs`;
                const chosen = yield* ask({
                  name,
                  prompt: `${still}.\n\nStill unmet:\n${formatFindings(unmet)}\n\nAmend the ticket, then hand it back, or stop the Run.`,
                  options: CRITERIA_OPTIONS,
                });
                if (chosen !== HAND_BACK) {
                  stopped = `${still}, so no review starts: ${Arr.join(
                    Arr.map(unmet, (one) => one.title),
                    "; ",
                  )}. Stop was answered to ${name}`;
                  break;
                }
                tries = 1;
                continue;
              }
              const before = yield* treeAt(`${operation}.criteria-${turn}.before`);
              yield* restateKind;
              const answered = yield* agentWork({
                operation: `${operation}.criteria-${turn}`,
                ...onHolder(handing),
                handOver: handOverOf(handing, {
                  criteria,
                  answers,
                  checks: ticket?.checks ?? [],
                  findings: [...ledger.values()],
                }),
                role: "implementer",
                pushes: true,
                instructions: prompts.criteria,
                input: {
                  ...input,
                  verify: yield* checksNow,
                  ticket: { file: ticket?.file ?? "", title: ticket?.title ?? "" },
                  criteria: renderCriteria(criteria),
                  findings: formatFindings(unmet),
                  session: yield* sessionNow,
                },
                output: Built,
              });
              handing.said = answered;
              handing.last = `${operation}.criteria-${turn}`;
              const after = yield* treeAt(`${operation}.criteria-${turn}.after`);
              answers = [...answers, ...boundTo(criteria, answered.criteria ?? [])];
              handing.proof.set(item, { criteria, answers, checks: ticket?.checks ?? [] });
              assumptions.push(...(answered.assumptions ?? []));
              commits.push(...(answered.commits ?? []));
              blockers = sameTree(after, before)
                ? Arr.filter(answered.findings ?? [], isBlocking)
                : [];
              tries += 1;
              turn += 1;
            }
            const done: Handed = {
              item,
              title: ticket?.title ?? "",
              commits,
              verifications: Arr.map(
                (yield* host.evidence(runId, cwd)).verifications.slice(before),
                (one) => `${one.name}: ${one.result}`,
              ),
            };
            if (stopped !== null) {
              yield* unbuilt(`${operation}.stopped`, stopped);
              return null;
            }
            handed.push(done);
            answeredFor.push({
              item:
                ticket === null && read.length > 0
                  ? Arr.join(
                      Arr.map(read, (one) => one.file),
                      ", ",
                    )
                  : item,
              criteria,
              answers,
              assumptions,
            });
            for (const one of assumptions) {
              assumed.push(one);
            }
            for (const one of read) {
              afterMerged.push(...Arr.map(one.afterMerge, (line) => `after merge: ${line}`));
            }
            for (const { criterion, met } of afterMergeAnswers(criteria, answers)) {
              afterMerged.push(`${criterion} — ${met}`);
            }
            built.add(done.item);
            if (ticket === null) {
              for (const one of tickets) {
                built.add(one.file);
              }
            }
            if (ticket !== null) {
              yield* host.checkpoint(runId, {
                ticket: ticket.file,
                status: "done",
                claims: claimsOf(build, ticket),
              });
            }
            return { done, blocking: Arr.filter(build.findings ?? [], isBlocking) };
          }),
          ticket === null
            ? undefined
            : { item: ticket.file, items: Arr.map(tickets, (one) => one.file) },
        );
        let completed = yield* nextBuild;
        while (completed === null) {
          completed = yield* nextBuild;
        }
        const { done, blocking } = completed;
        if (blocking.length > 0) {
          rallied = kept(
            yield* builderRally({
              ...rallyAsk,
              ...ledgering([]),
              plan: yield* specNow,
              criteria: reviewerCriteria(answeredFor),
              input,
              build: {
                item: done.item,
                completed: Arr.map(handed, (one) => one.item),
                findings: blocking,
              },
            }),
          );
          for (let attempt = 1; ; attempt++) {
            const unresolved = rallied.halted ?? Arr.join(rallied.unsettled, "; ");
            if (unresolved === "") {
              break;
            }
            yield* reviewRound(
              unbuilt(`${done.item}.rally-${attempt}`, `${done.item}: ${unresolved}`),
              { round: rallyAsk.rounds.n },
            );
            rallied = kept(
              yield* builderRally({
                ...rallyAsk,
                ...ledgering(rallied.reviewed.findings),
                plan: yield* specNow,
                criteria: reviewerCriteria(answeredFor),
                input,
                build: {
                  item: done.item,
                  completed: Arr.map(handed, (one) => one.item),
                  findings: blocking,
                },
                resume: { attempt, previous: rallied },
              }),
            );
          }
        }
        tickets = yield* ticketsNow;
      }
      if (build === null && recovery.entry === "Build") {
        return yield* new WorkflowError({ reason: "nothing was built" });
      }
      input = { ...input, verify: yield* checksNow };
      // WARNING: work that stayed on its first agent keeps it to the end.
      const delivers = () => handing.sessions !== "run" && handing.agent !== BUILDER;
      if (delivers() && handing.sessions === "ticket") {
        handTo(handing, DELIVERER);
      }

      if (rallied === null || rallied.unreviewed !== "") {
        rallied = kept(
          yield* builderRally({
            ...rallyAsk,
            ...ledgering(
              Arr.filter(
                [...ledger.values()],
                (one) => one.status === "open" || one.status === "disputed",
              ),
            ),
            plan: yield* specNow,
            criteria: reviewerCriteria(answeredFor),
            input,
            obstacle:
              recovery.entry === "Review"
                ? `Recover the existing implementation. Review the whole requested outcome, including the current work source ${asked.plan} and any added requirements; an unbuilt requirement is a blocking finding for the builder. Previous head: ${recovery.previous || "unrecorded"}. Commits since that head:\n${recovery.commits || "(none or unavailable)"}\nThe original requirements and review associations this recovery weighed are in ${place.dir}/recovery-reviews.jsonl. Read its open findings at ${parentDir}/findings.json, and its spec at ${parentDir}/plan where present.`
                : "",
          }),
        );
      }
      for (let attempt = 1; ; attempt++) {
        const unresolved = rallied.halted ?? Arr.join(rallied.unsettled, "; ");
        if (unresolved === "") {
          break;
        }
        yield* reviewRound(unbuilt(`rally-${attempt}`, unresolved), { round: rallyAsk.rounds.n });
        rallied = kept(
          yield* builderRally({
            ...rallyAsk,
            ...ledgering(rallied.reviewed.findings),
            plan: yield* specNow,
            criteria: reviewerCriteria(answeredFor),
            input,
            resume: { attempt, previous: rallied },
          }),
        );
      }

      const onto =
        place.options.stacked === undefined || place.branch === null
          ? null
          : stackedBranch(place.branch, {
              repo: place.options.repo ?? ".",
              change: place.options.change,
              stacked: place.options.stacked,
            });
      if (Arr.some(answeredFor, showsAnything)) {
        yield* Activity.make({
          name: "builder-answers",
          execute: host.record(runId, renderAnswered(answeredFor)),
        });
      }
      if (delivers()) {
        handTo(handing, DELIVERER);
      }
      const delivered = yield* deliver({
        cwd,
        source: { value: source.value, kind: source.kind },
        onto: onto ?? undefined,
        ...onHolder(handing),
        handOver: handOverOf(handing, { ...proofOf(handing), findings: [...ledger.values()] }),
        role: "implementer",
        input,
        checksNow,
        prompts: { fix: prompts.fix, ciFix: prompts.ciFix, mr: prompts.mr },
        opened: Opened,
        outcome: outcomeOf,
        outcomeJournaled: kindNow,
        outputs: () => ({ build: { ...build } }),
        tickets: Arr.map(tickets, (ticket) => ({ file: ticket.file, checks: ticket.checks })),
        roots: evidenceRoots(place.dir, cwd, source.value),
        rallied,
        built: planned
          ? Arr.join(
              Arr.flatMap(handed, (one) =>
                one.title === "" ? [] : [`- ${one.item} — ${one.title}`],
              ),
              "\n",
            )
          : "",
        ledger: ledger.size === 0 ? "" : formatFindings([...ledger.values()]),
        unsettled: [...assumed, ...afterMerged],
        integrate: integrated,
        review: Effect.map(
          specNow,
          (plan) => (answered: string) =>
            Effect.flatMap(outcomeOf, (proves) =>
              reviewPass({
                target: "",
                plan,
                proves,
                previous: `${place.dir}/review.md`,
                answered,
                risks: place.options.risks ?? "",
                criteria: reviewerCriteria(answeredFor),
                base,
                at: ROUNDS + 1,
                of: ROUNDS + 1,
                disputed: [],
              }),
            ),
        ),
      });
      if (delivered.nothing !== undefined) {
        return delivered.nothing;
      }
      // oxlint-disable-next-line unicorn/no-thenable -- The workflow input selects the next step using string values.
      return yield* releasing({ mr: delivered.mr, cwd, then: asked.then ?? "" });
    }),
});

// WARNING: one set to merge itself is left to do that, so nobody is asked about it.
const releasing = (delivered: {
  readonly mr: string;
  readonly cwd: string;
  readonly then: string;
}) =>
  Effect.gen(function* () {
    const host = yield* Host;
    const runId = (yield* Run).id;
    const { mr } = delivered;
    if (delivered.then === "finish") {
      return mr;
    }
    if (delivered.then === "") {
      const merging = yield* Activity.make({
        name: "auto-merging",
        success: Schema.NullOr(Schema.String),
        execute: host
          .autoMerging(delivered.cwd)
          .pipe(
            Effect.catch((failure) =>
              Effect.as(
                host.record(runId, `whether ${mr} merges itself is unknown: ${failure.reason}`),
                null,
              ),
            ),
          ),
      });
      if (merging !== null) {
        yield* forecast(delivery);
        return mr;
      }
      let stageFailed = "";
      let failedStage = "";
      const stageRefusal = (name: string) =>
        failedStage === ""
          ? Effect.succeed(null)
          : Activity.make({
              name,
              success: Schema.NullOr(Schema.String),
              execute: host.reviewedRefusal(runId, failedStage, mr),
            });
      for (let n = 1; ; n++) {
        const refused = yield* stageRefusal(`stage-refused-${n}`);
        const chosen = yield* next(
          ask({
            name: n === 1 ? "next" : `next-${n}`,
            prompt: `${mr} is open.${stageFailed}${
              refused === null ? "" : ` Stage is not offered: ${refused}.`
            } What next?`,
            options: [
              { id: RELEASE, recommended: true },
              refused === null ? STAGE : CHECK_STAGE,
              FINISH,
            ],
          }),
          { round: n },
        );
        if (chosen === CHECK_STAGE) {
          continue;
        }
        if (chosen === STAGE && (yield* stageRefusal(`stage-picked-${n}`)) !== null) {
          continue;
        }
        if (chosen === STAGE) {
          const children = yield* Children;
          const invocation = `stage-${n}`;
          const child = yield* children.start({ invocation, workflow: "stage", input: { mr } });
          const result = yield* children.result(child).pipe(
            Effect.match({
              onSuccess: (value) => ({ said: String(value), failed: "" }),
              onFailure: (failure) => ({
                said: failure.reason,
                failed: ` ${invocation} failed: ${failure.reason}.`,
              }),
            }),
          );
          stageFailed = result.failed;
          failedStage = result.failed === "" ? "" : child.runId;
          yield* host.record(runId, `${invocation}: ${result.said}`);
          continue;
        }
        if (chosen !== RELEASE) {
          return mr;
        }
        break;
      }
    }
    const children = yield* Children;
    const child = yield* children.start({
      invocation: "release",
      workflow: "release",
      input: { mr },
    });
    return `${mr}; ${String(yield* children.result(child))}`;
  });

const buildEach = (fan: {
  readonly plan: string;
  readonly root: string;
  readonly waves: ReadonlyArray<ReadonlyArray<string>>;
  readonly changes: ReadonlyArray<typeof ChangeReading.Type>;
  readonly options: Readonly<Record<string, string>>;
}) =>
  Effect.gen(function* () {
    const host = yield* Host;
    const children = yield* Children;
    const runId = (yield* Run).id;
    const invocation = (key: string) => `implement-${pipe_(key, Str.replaceAll("/", "-"))}`;
    const clash = identityProblem(Arr.map(fan.waves.flat(), invocation));
    if (clash !== null) {
      return yield* new WorkflowError({ reason: clash });
    }
    const changeOf = (key: string) =>
      Option.getOrElse(
        Arr.findFirst(fan.changes, (one) => one.key === key),
        () => {
          const returned: typeof ChangeReading.Type = { key, repo: key };
          return returned;
        },
      );
    const built: Array<string> = [];
    const keys = fan.waves.flat();
    for (const [at, wave] of fan.waves.entries()) {
      const running = [];
      for (const key of wave) {
        const { repo, change, stacked } = changeOf(key);
        const options = {
          ...fan.options,
          repo,
          workspace: repo === "." ? fan.root : `${fan.root}/${repo}`,
          ...Rec.filter({ change, stacked }, Predicate.isNotUndefined),
        };
        const begun = yield* Deferred.make<void>();
        const share = Effect.gen(function* () {
          const child = yield* children
            .start({
              invocation: invocation(key),
              workflow: "self",
              // oxlint-disable-next-line unicorn/no-thenable -- Nobody attends a Change's share, so it ends at its merge request. implement's Input is named `then`
              input: { plan: fan.plan, then: "finish" },
              options,
            })
            .pipe(Effect.result, Effect.ensuring(Deferred.succeed(begun, undefined)));
          if (child._tag === "Failure") {
            return { key, built: null, why: `not started: ${child.failure.reason}` };
          }
          return yield* children.result(child.success).pipe(
            Effect.map((value) => ({ key, built: String(value), why: "" })),
            Effect.catch((failure) => Effect.succeed({ key, built: null, why: failure.reason })),
          );
        });
        const building = yield* Effect.forkChild(repoRuns(share, { item: key, items: keys }));
        running.push(building);
        yield* Effect.raceFirst(Deferred.await(begun), Fiber.join(building));
      }
      const ended = yield* Fiber.joinAll(running);
      for (const one of ended) {
        built.push(`${one.key}: ${one.built ?? one.why}`);
        yield* host.record(runId, `${one.key}: ${one.built ?? one.why}`);
      }
      const stopped = Option.getOrUndefined(Arr.findFirst(ended, (one) => one.built === null));
      if (stopped !== undefined) {
        const left = fan.waves.slice(at + 1).flat();
        const waiting =
          left.length === 0 ? "" : ` Not run: ${Arr.join(left, ", ")}, waiting on ${stopped.key}.`;
        return yield* new WorkflowError({
          reason: `${stopped.key} did not build.${waiting} ${Arr.join(built, "; ")}`,
        });
      }
    }
    const named = Arr.some(fan.changes, (one) => one.change !== undefined);
    return `${keys.length} ${named ? "Changes" : "repositories"} built in ${fan.waves.length} wave(s): ${Arr.join(built, "; ")}`;
  });

const claimsOf: (built: typeof Built.Type, ticket: Slice) => ReadonlyArray<string> = (
  built,
  ticket,
) => {
  const named = built.tickets_done ?? [];
  return named.length > 0 ? named : [ticket.title];
};

const renderCriteria = (criteria: ReadonlyArray<string>) =>
  criteria.length === 0
    ? "None: this work names no checkbox criteria, so `criteria` stays empty."
    : Arr.join(
        Arr.map(criteria, (one) => `- ${one}`),
        "\n",
      );

const boundTo: (
  wording: ReadonlyArray<string>,
  given: ReadonlyArray<Criterion>,
) => Array<Criterion> = (wording, given) =>
  Arr.flatMap(given, (answer) => {
    const criterion = Option.getOrUndefined(
      Arr.findFirst(wording, (one) => answerFor(one, [answer]) !== undefined),
    );
    return criterion === undefined ? [] : [{ ...answer, criterion }];
  });

export interface Answered {
  readonly item: string;
  readonly criteria: ReadonlyArray<string>;
  readonly answers: ReadonlyArray<Criterion>;
  readonly assumptions: ReadonlyArray<string>;
}

const reviewerCriteria = (all: ReadonlyArray<Answered>) =>
  Arr.join(
    Arr.filter(
      [renderAnswered(all), Str.trim(content.sections.get("review.pipeline") ?? "")],
      Str.isNonEmpty,
    ),
    "\n\n",
  );

const showsAnything = (one: Answered) => one.criteria.length > 0 || one.assumptions.length > 0;

export const renderAnswered = (all: ReadonlyArray<Answered>) =>
  Arr.some(all, showsAnything)
    ? Arr.join(
        [
          "What the builder says of each acceptance criterion, and what it decided where the plan did not settle it. Check each answer against the code rather than taking it on its word, and raise an assumption the spec contradicts. Raise as blocking an `after merge` answer to a criterion this Run could have shown before its merge request:",
          ...Arr.map(Arr.filter(all, showsAnything), (one) =>
            Arr.join(
              [
                `\n${one.item}:`,
                ...Arr.map(
                  one.criteria,
                  (criterion) =>
                    `- ${criterion}\n  → ${answerFor(criterion, one.answers)?.met ?? "not answered"}`,
                ),
                ...Arr.map(one.assumptions, (assumption) => `- assumed: ${assumption}`),
              ],
              "\n",
            ),
          ),
        ],
        "\n",
      )
    : "";

const conflictOf = (merged: Integration) =>
  `Collie merged ${merged.ref} (${merged.sha}) into this branch, and the merge stopped on conflicts in: ${Arr.join(merged.files, ", ")}.`;

const stoppedBy = (merged: Integration) =>
  merged.status === "conflicted"
    ? conflictOf(merged)
    : `Collie could not merge ${merged.ref} (${merged.sha}) into this branch: ${merged.reason}.`;

interface PartialBuild {
  readonly item: string;
  readonly completed: ReadonlyArray<string>;
  readonly findings: ReadonlyArray<Finding>;
}

const builderRally = (ask: {
  readonly rounds: { n: number };
  readonly cwd: string;
  readonly plan: string;
  readonly proves: Effect.Effect<string, never, WorkflowEngine | WorkflowInstance>;
  readonly risks: string;
  readonly input: typeof Implementing.Type;
  readonly build?: PartialBuild;
  readonly criteria: string;
  readonly obstacle?: string;
  readonly resume?: { readonly attempt: number; readonly previous: Rallied };
  readonly ledger?: ReadonlyArray<Finding>;
  readonly taken?: ReadonlyArray<string>;
  readonly handing: Handing;
  readonly integrate: (
    operation: string,
  ) => Effect.Effect<
    Integration & { readonly base: string },
    WorkflowError,
    Run | Agents | Host | WorkflowEngine | WorkflowInstance
  >;
}) =>
  Effect.gen(function* () {
    const host = yield* Host;
    const runId = (yield* Run).id;
    return yield* rally({
      ...ask,
      source: ask.build === undefined ? ask.input.inputs.plan : null,
      prefix: `${ask.build === undefined ? "" : `${ask.build.item}.`}${ask.resume === undefined ? "" : `retry-${ask.resume.attempt}.`}`,
      resume:
        ask.resume === undefined
          ? undefined
          : {
              previous: ask.resume.previous,
              reviewers: ask.build === undefined ? "" : `${ask.build.item}.`,
            },
      obstacle:
        ask.build === undefined
          ? (ask.obstacle ?? "")
          : `Review the built part of this plan: ${Arr.join(ask.build.completed, ", ")}. Later tickets have not started and are outside this review, including its scope judgement. Check these findings reported by the implementer:\n${formatFindings(ask.build.findings)}`,
      fix: ({ operation, at, proves, findings, open, head }) =>
        Effect.gen(function* () {
          if (ask.handing.sessions === "round") {
            const item = ask.build === undefined ? "final" : ask.build.item;
            const round = (ask.handing.fixes.get(item) ?? 0) + 1;
            ask.handing.fixes.set(item, round);
            handTo(ask.handing, `fix-${pipe_(item, Str.replace(/\.md$/, ""))}-${round}`);
          }
          const fixed = yield* agentWork({
            operation,
            ...onHolder(ask.handing),
            handOver: handOverOf(ask.handing, {
              ...proofOf(ask.handing, ask.build?.item),
              findings: open,
              reviewed: head ?? "",
            }),
            role: "implementer",
            pushes: true,
            instructions: prompts.fix,
            input: {
              ...ask.input,
              inputs: { ...ask.input.inputs, outcome: proves },
              verify: renderApproved(yield* host.approved(runId)),
              iteration: String(at),
              max_iterations: String(ask.resume === undefined ? ROUNDS : 1),
              findings,
            },
            output: FixOutputSchema,
          });
          ask.handing.said = fixed;
          ask.handing.last = operation;
          return fixed;
        }),
    });
  });

interface Handing {
  plan: string | null;
  ticket: string | null;
  said: Outgoing | undefined;
  readonly sessions: "run" | "ticket" | "round";
  agent: string;
  last: string;
  from: TakeOver | null;
  readonly fixes: Map<string, number>;
  readonly proof: Map<string, Proof>;
}

type Proof = Required<Pick<HandOverGiven, "criteria" | "answers" | "checks">>;

const proofOf: (handing: Handing, item?: string) => Proof = (handing, item) => {
  const one = item === undefined ? undefined : handing.proof.get(item);
  const all = item === undefined ? [...handing.proof.values()] : one === undefined ? [] : [one];
  return {
    criteria: Arr.flatMap(all, (one) => one.criteria),
    answers: Arr.flatMap(all, (one) => one.answers),
    checks: Arr.dedupe(Arr.flatMap(all, (one) => one.checks)),
  };
};

const handTo = (handing: Handing, agent: string) => {
  if (agent === handing.agent) {
    return;
  }
  handing.from = {
    agent: handing.agent,
    why: handing.last === "" ? "had this work before" : `finished ${handing.last}`,
  };
  handing.agent = agent;
};

interface TakeOver {
  readonly agent: string;
  readonly why: string;
}

const onHolder: (handing: Handing) => { agent: string; takesOver?: TakeOver } = (handing) =>
  handing.from === null
    ? { agent: handing.agent }
    : { agent: handing.agent, takesOver: handing.from };

const handOverOf: (
  handing: Handing,
  about: Pick<HandOverGiven, "criteria" | "answers" | "checks" | "findings" | "reviewed">,
) => HandOverGiven = (handing, about) => {
  let given: HandOverGiven = about;
  if (handing.plan !== null) {
    given = { ...given, plan: handing.plan };
  }
  if (handing.ticket !== null) {
    given = { ...given, ticket: handing.ticket };
  }
  if (handing.said !== undefined) {
    given = { ...given, said: handing.said };
  }
  return given;
};

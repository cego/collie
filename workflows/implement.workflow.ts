// Build the plan, review it, fix until nothing blocks, then open the merge request.
//
// One implementer for the whole Run: the tickets are a list it is handed one at a time,
// the fixes go back to the agent that built the work, and the merge request is written by
// the same one that knows what it did. Between them a rally — review, fix, review again —
// that leaves at the first review with nothing blocking and is bounded rather than
// endless. The rally and its review are `reviewing.ts`'s, shared with the other workflows.
//
// Nothing here is a repeat declaration or a scheduler. `splitDisputed` decides what is
// still the implementer's, `settleRound` decides where a round goes, `settleFinalFix`
// decides whether the last fix stands, and `evidenceGapsOf` decides whether this Run has
// proved what it set out to prove — the same functions every workflow is held to.
//
// The Markdown beside this file is the content: the five kinds of work source, what a
// slice is told, and what the merge request has to say.

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
  defineWorkflow,
  evidenceRoots,
  formatFindings,
  identityProblem,
  isBlocking,
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
  type Criterion,
  type Finding,
  type Handed,
  type Integration,
  type Slice,
} from "collie";
import {
  DateTime,
  Deferred,
  Effect,
  Fiber,
  FileSystem,
  Predicate,
  Schema,
  flow,
  Result,
} from "effect";
import { WorkflowInstance, type WorkflowEngine } from "effect/workflow/WorkflowEngine";
import * as Workflow from "effect/workflow/Workflow";
import * as Activity from "effect/workflow/Activity";
import { connection } from "./connections.ts";
import markdown from "./implement.md" with { type: "text" };
import { measuredBy } from "./measuring.ts";
import {
  IMPLEMENTER,
  REVIEWER,
  ROUNDS,
  rally,
  reviewPass,
  reviewRound,
  type Rallied,
} from "./reviewing.ts";
import { Tree, deliver, gate, mergeRequest } from "./delivering.ts";

const content = contentOf(markdown);
const text = Schema.String;
const recoveryEntry = (facts: Recovery | undefined) =>
  facts?.review != null ? "Checks" : facts?.implementation === true ? "Review" : "Build";

/** What every implement prompt is told: the plan, what it proves, and what may prove it. */
const Implementing = Schema.Struct({
  inputs: Schema.Struct({ plan: text, plan_kind: text, repo: text, outcome: text }),
  run: Schema.Struct({ dir: text, id: text }),
  verify: text,
});

/** A section's text is sent as it is, so the names it carries are filled here. */
const sectionOf = (section: string, input: typeof Implementing.Type) =>
  pipe_(
    content.sections.get(section) ?? "",
    Str.replaceAll("{{inputs.plan}}", input.inputs.plan),
    Str.replaceAll("{{run.dir}}", input.run.dir),
  );

const prompts = {
  build: content.template("build", {
    ...Implementing.fields,
    ticket: Schema.Struct({ file: text, title: text }),
    progress: text,
    session: Schema.Struct({ ask: text }),
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
  mr: content.template("mr", {
    ...Implementing.fields,
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
      create: text,
      comment: text,
    }),
    target_repo: text,
  }),
};

/** What an implementer is held to when it says a ticket is built. */
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
  /** A bug's reproduction, an investigation's answer, a docs run: whichever applies. */
  reproduced: Schema.optionalKey(Schema.String),
  conclusion: Schema.optionalKey(Schema.String),
  evidence: Schema.optionalKey(Schema.Array(Schema.String)),
  patch: Schema.optionalKey(Schema.Boolean),
  documented_commands: Schema.optionalKey(Schema.Array(Schema.String)),
  assumptions: Schema.optionalKey(Schema.Array(Schema.String)).annotate({
    description: "each decision you made that the spec did not settle, and why, one sentence each",
  }),
});

/** One Change a plan names, by the key its waves name it by. */
const ChangeReading = Schema.Struct({
  key: Schema.String,
  repo: Schema.String,
  change: Schema.optional(Schema.String),
  stacked: Schema.optional(Schema.String),
});

/** Which Changes a plan names, as a reading of it records them. */
const Reading = Schema.Struct({
  single: Schema.Boolean,
  waves: Schema.Array(Schema.Array(Schema.String)),
  /** A reading journaled before Changes names only repositories, each its own default Change. */
  changes: Schema.optionalKey(Schema.Array(ChangeReading)),
  refusal: Schema.NullOr(Schema.String),
});

/** A ticket as a reading of the plan records it. */
const SliceRecord = Schema.Struct({
  file: Schema.String,
  number: Schema.String,
  title: Schema.String,
  blockedBy: Schema.Array(Schema.String),
  checks: Schema.Array(Schema.String),
  // A reading journaled before tickets carried their criteria, benchmark or prerequisites has none.
  criteria: Schema.optionalKey(Schema.Array(Schema.String)),
  benchmark: Schema.optionalKey(Schema.NullOr(Schema.String)),
  prerequisites: Schema.optionalKey(
    Schema.Array(Schema.Struct({ run: Schema.String, change: Schema.NullOr(Schema.String) })),
  ),
});

/** A ticket's criteria and after-merge outcomes as one reading of its file found them. */
const TicketReading = Schema.Struct({
  criteria: Schema.Array(Schema.String),
  afterMerge: Schema.Array(Schema.String),
});

/** What the step that opens the merge request reports, and what it linked. */
const Opened = Schema.Struct({
  verdict: Schema.Literals(["clean", "findings"]),
  findings: Schema.optionalKey(Schema.Array(FindingSchema)),
  mr_url: Schema.optionalKey(Schema.NullOr(Schema.String)),
  linear_issues: Schema.optionalKey(Schema.Array(Schema.String)),
  branch: Schema.optionalKey(Schema.String),
  /** False is a real answer: auto-merge on somebody else's MR is a reason not to push. */
  pushed: Schema.Boolean,
});

/** How often a ticket's unanswered criteria go back to its builder before a reviewer sees them. */
const CRITERIA_TRIES = 2;
/** Hand-backs of what stopped an integration — a commit can uncover a conflict. */
const MERGE_TRIES = 2;

/** One agent for the whole Run, so its model is named once and the fixes know the build. */
const BUILDER = "build";

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
    recovery: Schema.optionalKey(
      Schema.String.annotate({
        description: "The finished Run whose existing work this explicit follow-up recovers",
      }),
    ),
    // oxlint-disable-next-line unicorn/no-thenable -- The workflow input selects the next step using string values.
    then: Schema.optionalKey(
      Schema.Literals(["", "finish", "release"]).annotate({
        description:
          "What follows the merge request: finish to end there, release to release it on a human's go, empty to be asked",
      }),
    ),
  }),
  output: Schema.String,
  agents: { roles: { implementer: IMPLEMENTER, reviewer: REVIEWER } },
  hints: { plan: "work-source" },
  path: [building, reviewRound, gate, mergeRequest, next],
  // The branch it builds, on a worktree of its own, so two Runs never share an index.
  checkout: "branch",
  // What kind of result this Run has to prove is the human's to say, and an unclassified
  // Run is held to its checks rather than made a feature by default.
  outcome: {
    selectable: ["feature", "bug", "refactor", "investigation", "docs", "migration"],
  },
  // A follow-up builds on the same branch, so it is this workflow again rather than
  // another one — and there is nothing to carry on from without a branch to carry it on.
  followUps: [
    {
      id: "release",
      connections: ["gitlab"],
      title: "Release",
      workflow: "release",
      when: "succeeded",
      inputs: { mr: "merge-request" },
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
      const source = yield* Activity.make({
        name: "work-source",
        success: Schema.Struct({ kind: Schema.String, value: Schema.String }),
        execute: classifyWorkSource(asked.plan).pipe(
          Effect.orElseSucceed(() => ({ kind: "text", value: asked.plan })),
        ),
      });
      const share = place.options.repo ?? "";
      if (source.kind === "linear") {
        const linear = yield* connection("linear");
        if (linear.state !== "ok")
          return yield* new WorkflowError({
            reason: `Cannot read the work source ${source.value}: ${linear.detail}. Fix: ${linear.fix}. Give the issue text as the work source to build without Linear.`,
          });
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
            // A plan that cannot be read is refused by name, not a defect the Run dies of.
            Effect.catch((cause) =>
              Effect.succeed({
                single: false,
                waves: [],
                refusal: `the plan at ${source.value} could not be read: ${cause.message}`,
              }),
            ),
          ),
        });
        if (plan.refusal !== null) return yield* new WorkflowError({ reason: plan.refusal });
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
            // One branch in every repository: the one asked for, or one named after this Run.
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
            if (yield* fs.exists(marker).pipe(Effect.orDie)) return yield* host.parked(runId, null);
            const why = `${reason}. Correct it, then resume ${runId}.`;
            yield* fs.writeFileString(marker, "").pipe(Effect.orDie);
            yield* host.record(runId, why);
            yield* stepFailed(why);
            yield* host.parked(runId, why, "step-failed");
            return yield* Workflow.suspend(yield* WorkflowInstance);
          }),
        });
      const checksNow = Effect.map(host.approved(runId), renderApproved);

      let input: typeof Implementing.Type = {
        inputs: {
          plan: source.value,
          plan_kind: source.kind,
          // The host's own launch options, under the names the content asks for them by.
          repo: place.options.repo ?? "",
          outcome: place.options.outcome ?? "",
        },
        run: { dir: place.dir, id: runId },
        verify: yield* checksNow,
      };
      // Where a question the plan does not cover goes: the planner's own pane while one is
      // live, and otherwise the builder decides and records it under assumptions. Asked
      // again for each ticket, so a planner that has gone is never described as live.
      const sessionNow = Effect.map(agents.askRoute("planner", place.lineage), (ask) => ({
        ask,
      }));

      // The default branch merged in where it has moved, at each ticket boundary and before
      // each review round, so drift is met while it is small and a reviewer sees what will
      // merge. `base` is what a reviewer's diff is taken against.
      let integrations = 0;
      let base = "";
      const integrateNow = Effect.gen(function* () {
        integrations += 1;
        const done = yield* Activity.make({
          name: `integrate.${integrations}`,
          success: IntegrationSchema,
          // Suspended inside the Activity, so a resume asks again.
          execute: Effect.gen(function* () {
            const done = yield* host.integrate(runId, cwd);
            if (done.status !== "unavailable") return done;
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
        if (done.sha !== "") base = done.sha;
        if (done.status === "waiting") yield* host.record(runId, `not integrated: ${done.reason}`);
        return done;
      });
      // Work goes on only from an integrated checkout: what stopped the merge goes back to
      // the builder, and the work stops if it still stands. Conflicts at a ticket boundary
      // are left for that ticket's own prompt.
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
              agent: BUILDER,
              role: "implementer",
              pushes: true,
              instructions: prompts.merge,
              input: { ...input, verify: yield* checksNow, conflict: stoppedBy(merged) },
              output: Built,
            });
            merged = yield* integrateNow;
          }
          if (!settles(merged))
            return yield* new WorkflowError({
              reason: `${merged.ref || merged.branch} is not integrated, so the work stops: ${stoppedBy(merged)}`,
            });
          return { ...merged, base };
        });
      // The kind as it stands, which `run intent set-outcome` may change while the Run is live.
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
      const rallyAsk = {
        rounds: { n: 0 },
        cwd,
        proves: kindNow,
        risks: place.options.risks ?? "",
        integrate: integrated,
      };

      // The tickets as they stand at each boundary: one added, removed or reordered while
      // another is being built is the plan from then on, and what is built stays built by
      // name. Each reading is recorded, so a replay is handed the list that was read.
      let readings = 0;
      const ticketsNow = Effect.gen(function* () {
        readings += 1;
        if (source.kind !== "plan-dir") return [];
        const read = yield* Activity.make({
          name: `tickets.${readings}`,
          success: Schema.Array(SliceRecord),
          execute: orderedTicketsOf(
            source.value,
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
      // Read only after the build, which is what writes SPEC.md for any source but a plan.
      let specReadings = 0;
      const specNow = Effect.gen(function* () {
        const plan = source.kind === "plan-dir" ? source.value : `${place.dir}/plan`;
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
          if (readable) return plan;
          if (source.kind !== "plan-dir") return "";
          yield* building(
            unbuilt(`spec-${specReadings}`, `${plan}/SPEC.md cannot be read, so no review starts`),
          );
        }
      });
      // One ticket is not a plan to slice: one pass builds all of it, and only tickets
      // added after that pass are built one at a time.
      const whole = tickets.length < 2;
      const built = new Set<string>();
      const handed: Handed[] = [];
      const assumed: string[] = [];
      const afterMerged: string[] = [];
      const answeredFor: Answered[] = [];
      let build: typeof Built.Type | null = null;
      let rallied: Rallied | null = null;
      const recovered = yield* Activity.make({
        name: "recovery-entry",
        success: Recovery,
        error: WorkflowError,
        execute:
          asked.recovery === undefined
            ? Effect.succeed({
                implementation: false,
                reason: "An ordinary start builds the work.",
                previous: "",
                commits: "",
                review: null,
              })
            : host.recovery(runId, asked.recovery, asked.plan),
      });
      const recovery = { ...recovered, entry: recoveryEntry(recovered) };
      if (asked.recovery !== undefined)
        yield* host.record(runId, `Follow-up enters at ${recovery.entry}: ${recovery.reason}`);
      let parentDir = "";
      if (recovery.entry !== "Build") {
        const parent = Str.split(asked.recovery ?? "", "/").at(-1) ?? "";
        parentDir = (yield* host.place(parent)).dir;
        build = yield* Activity.make({
          name: "recovery-build-claims",
          success: Schema.NullOr(Built),
          execute: Effect.gen(function* () {
            const fs = yield* FileSystem.FileSystem;
            const outputs = yield* Effect.forEach(
              ["build", ...Arr.map(tickets, (one) => one.file)],
              (operation) =>
                fs.readFileString(agents.outputFor(parent, operation)).pipe(
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
          }),
        });
        yield* forecast([
          ...(recovery.entry === "Review" ? [reviewRound] : []),
          gate,
          mergeRequest,
          next,
        ]);
        if (recovery.entry === "Checks" && recovery.review !== null)
          rallied = {
            halted: null,
            unreviewed: "",
            unsettled: [],
            disputes: [],
            reviewed: recovery.review,
          };
      }
      const needing = (one: Slice) => ({
        runId,
        cwd,
        ticket: `${source.value}/issues/${one.file}`,
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
            // Suspended inside the Activity, so a resume waits again.
            execute: Effect.gen(function* () {
              const standing = yield* host.awaitPrerequisites(needing(one));
              if (standing._tag === "Held") return yield* Workflow.suspend(yield* WorkflowInstance);
              return standing;
            }),
          });
          if (standing._tag === "Never")
            yield* unbuilt(
              `${one.file}.prerequisites-${prerequisiteWaits}`,
              `${one.file}: ${standing.why}`,
            );
        });
      const pickable = Effect.gen(function* () {
        for (;;) {
          const left = Arr.filter(tickets, (one) => !built.has(one.file));
          if (left.length === 0) return undefined;
          const unblocked = Arr.filter(left, (one) =>
            Arr.every(one.blockedBy, (id) => !Arr.some(left, (other) => other.number === id)),
          );
          for (const one of unblocked)
            if (one.prerequisites.length === 0 || (yield* landed(one))) return one;
          const waiting = unblocked[0];
          if (waiting === undefined)
            return yield* new WorkflowError({
              reason: `these tickets block each other, so none of them can be built first: ${Arr.join(
                Arr.map(left, (one) => one.file),
                ", ",
              )}`,
            });
          yield* building(awaited(waiting), {
            item: waiting.file,
            items: Arr.map(tickets, (one) => one.file),
          });
        }
      });
      for (; recovery.entry === "Build";) {
        // Identities before work: two tickets nobody can tell apart would share one
        // result, and finding that out after an agent has been paid for is too late.
        const clash = identityProblem(Arr.map(tickets, (ticket) => ticket.file));
        if (clash !== null) return yield* new WorkflowError({ reason: clash });
        const next = yield* pickable;
        const ticket = whole && built.size === 0 ? null : next;
        if (ticket === undefined) break;
        rallied = null;
        let attempt = 0;
        const nextBuild = building(
          Effect.gen(function* () {
            attempt += 1;
            const item = ticket?.file ?? "build";
            const operation = attempt === 1 ? item : `${item}-${attempt}`;
            const before = (yield* host.evidence(runId, cwd)).verifications.length;
            if (ticket !== null) yield* checkpoint(place.dir, ticket, "started", []);
            const merged =
              (ticket !== null && built.size > 0) ||
              Arr.some(ticket === null ? tickets : [ticket], (one) => one.prerequisites.length > 0)
                ? yield* integrated(`${item}.merge`, true)
                : null;
            const session = yield* sessionNow;
            // A plan built in one pass answers every ticket's criteria, and words their own.
            const given =
              ticket?.criteria ??
              (source.kind === "text"
                ? criteriaIn(source.value)
                : Arr.flatMap(tickets, (one) => one.criteria));
            yield* restateKind;
            build = yield* agentWork({
              operation,
              agent: BUILDER,
              role: "implementer",
              pushes: true,
              instructions: prompts.build,
              input: {
                ...input,
                verify: yield* checksNow,
                ticket: { file: ticket?.file ?? "", title: ticket?.title ?? "" },
                progress: renderProgress(handed),
                session,
                criteria:
                  ticket === null && source.kind === "linear"
                    ? "Every checkbox in the issue's description. Copy the description into the spec word for word, its checkboxes included, and answer each one."
                    : renderCriteria(given),
                measure:
                  source.kind !== "plan-dir"
                    ? measuredBy("measure.own", `${place.dir}/plan/issues/NN-<slug>.benchmark.json`)
                    : ticket?.benchmark != null
                      ? measuredBy("measure", benchmarkFile(source.value, ticket.benchmark))
                      : "",
                source: sectionOf(`source.${source.kind}`, input),
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
            // A Linear issue's criteria are read from its description as the builder copied it.
            let spec: ReadonlyArray<string> | null = given;
            for (let reading = 1; ; reading++) {
              spec =
                ticket === null && source.kind === "linear"
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
              if (spec !== null) break;
              yield* unbuilt(
                `${operation}.spec-${reading}`,
                `${item}: ${place.dir}/plan/SPEC.md cannot be read, so the issue's acceptance criteria cannot be checked and no review starts`,
              );
            }
            // A plan's tickets are read again before each judgement, so an amended one is judged
            // and handed back as it reads now; one that cannot be read keeps its last reading.
            let read: ReadonlyArray<{ file: string } & typeof TicketReading.Type> =
              source.kind === "plan-dir"
                ? Arr.map(ticket === null ? tickets : [ticket], (one) => ({
                    file: one.file,
                    criteria: one.criteria,
                    afterMerge: [],
                  }))
                : [];
            let reads = 0;
            const criteriaNow = Effect.gen(function* () {
              if (read.length === 0) return spec;
              reads += 1;
              const now = yield* Activity.make({
                name: `${operation}.criteria.read-${reads}`,
                success: Schema.Array(Schema.NullOr(TicketReading)),
                execute: FileSystem.FileSystem.pipe(
                  Effect.flatMap((fs) =>
                    Effect.forEach(read, (one) =>
                      fs.readFileString(`${source.value}/issues/${one.file}`).pipe(
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
            // Each criterion answered before any reviewer is launched: one left unanswered or
            // unmet goes back to the builder, and the Run asks if it still is.
            let answers = boundTo(spec, build.criteria ?? []);
            const assumptions = [...(build.assumptions ?? [])];
            const commits = [...(build.commits ?? [])];
            let criteria = spec;
            let unmet: ReadonlyArray<Finding> = [];
            // Another hand-back on an unchanged tree cannot move a blocker, so a stall asks instead.
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
              if (unmet.length === 0) break;
              if (blockers.length > 0) {
                stalls += 1;
                const chosen = yield* ask({
                  name: `${operation}.criteria-stalled-${stalls}`,
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
                agent: BUILDER,
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
              const after = yield* treeAt(`${operation}.criteria-${turn}.after`);
              answers = [...answers, ...boundTo(criteria, answered.criteria ?? [])];
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
            answeredFor.push({ item, criteria, answers, assumptions });
            for (const one of assumptions) assumed.push(`assumed in ${item}: ${one}`);
            for (const one of read)
              afterMerged.push(
                ...Arr.map(one.afterMerge, (line) => `${one.file}: after merge: ${line}`),
              );
            for (const { criterion, met } of afterMergeAnswers(criteria, answers))
              afterMerged.push(
                `${Option.getOrUndefined(Arr.findFirst(read, (one) => one.criteria.includes(criterion)))?.file ?? item}: ${criterion} — ${met}`,
              );
            built.add(done.item);
            if (ticket === null) for (const one of tickets) built.add(one.file);
            if (ticket !== null)
              yield* checkpoint(place.dir, ticket, "done", claimsOf(build, ticket));
            return { done, blocking: Arr.filter(build.findings ?? [], isBlocking) };
          }),
          ticket === null
            ? undefined
            : { item: ticket.file, items: Arr.map(tickets, (one) => one.file) },
        );
        let completed = yield* nextBuild;
        while (completed === null) completed = yield* nextBuild;
        const { done, blocking } = completed;
        if (blocking.length > 0) {
          rallied = yield* builderRally({
            ...rallyAsk,
            plan: yield* specNow,
            criteria: reviewerCriteria(answeredFor),
            input,
            build: {
              item: done.item,
              completed: Arr.map(handed, (one) => one.item),
              findings: blocking,
            },
          });
          for (let attempt = 1; ; attempt++) {
            const unresolved = rallied.halted ?? Arr.join(rallied.unsettled, "; ");
            if (unresolved === "") break;
            yield* reviewRound(
              unbuilt(`${done.item}.rally-${attempt}`, `${done.item}: ${unresolved}`),
              { round: rallyAsk.rounds.n },
            );
            rallied = yield* builderRally({
              ...rallyAsk,
              plan: yield* specNow,
              criteria: reviewerCriteria(answeredFor),
              input,
              build: {
                item: done.item,
                completed: Arr.map(handed, (one) => one.item),
                findings: blocking,
              },
              resume: { attempt, previous: rallied },
            });
          }
        }
        tickets = yield* ticketsNow;
      }
      if (build === null && recovery.entry === "Build")
        return yield* new WorkflowError({ reason: "nothing was built" });
      // The builder may have named the checks, and every prompt from here shows them.
      input = { ...input, verify: yield* checksNow };

      if (rallied === null || rallied.unreviewed !== "") {
        rallied = yield* builderRally({
          ...rallyAsk,
          plan: yield* specNow,
          criteria: reviewerCriteria(answeredFor),
          input,
          obstacle:
            recovery.entry === "Review"
              ? `Recover the existing implementation. Review the whole requested outcome, including the current work source ${asked.plan} and any added requirements; an unbuilt requirement is a blocking finding for the builder. Previous head: ${recovery.previous || "unrecorded"}. Commits since that head:\n${recovery.commits || "(none or unavailable)"}\nThe parent's original requirements and review associations are in ${parentDir}/reviews.jsonl. Read its open findings at ${parentDir}/findings.json, and its spec at ${parentDir}/plan where present.`
              : "",
        });
      }
      for (let attempt = 1; ; attempt++) {
        const unresolved = rallied.halted ?? Arr.join(rallied.unsettled, "; ");
        if (unresolved === "") break;
        yield* reviewRound(unbuilt(`rally-${attempt}`, unresolved), { round: rallyAsk.rounds.n });
        rallied = yield* builderRally({
          ...rallyAsk,
          plan: yield* specNow,
          criteria: reviewerCriteria(answeredFor),
          input,
          resume: { attempt, previous: rallied },
        });
      }

      const onto =
        place.options.stacked === undefined || place.branch === null
          ? null
          : stackedBranch(place.branch, {
              repo: place.options.repo ?? ".",
              change: place.options.change,
              stacked: place.options.stacked,
            });
      const delivered = yield* deliver({
        cwd,
        source: { value: source.value, kind: source.kind },
        onto: onto ?? undefined,
        agent: BUILDER,
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
      if (delivered.nothing !== undefined) return delivered.nothing;
      // oxlint-disable-next-line unicorn/no-thenable -- The workflow input selects the next step using string values.
      return yield* releasing({ mr: delivered.mr, cwd, then: asked.then ?? "" });
    }),
});

/**
 * What follows an open merge request: `then`, or the human's answer where nobody gave one.
 * One set to merge itself is left to do that, so nobody is asked about it.
 */
const releasing = (delivered: {
  readonly mr: string;
  readonly cwd: string;
  readonly then: string;
}) =>
  Effect.gen(function* () {
    const host = yield* Host;
    const runId = (yield* Run).id;
    const { mr } = delivered;
    if (delivered.then === "finish") return mr;
    if (delivered.then === "") {
      const merging = yield* Activity.make({
        name: "auto-merging",
        success: Schema.NullOr(Schema.String),
        // Unknown is asked about: a release refuses a merge request that merges itself.
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
      if (merging !== null) return mr;
      let stageFailed = "";
      let failedStage = "";
      // Why another Stage would still be refused at the checkout the last one was refused
      // at, asked again when it is offered and when it is picked.
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
            // A question's options are fixed once asked, so a freed path is noticed on a pick.
            options: [
              { id: RELEASE, recommended: true },
              refused === null ? STAGE : CHECK_STAGE,
              FINISH,
            ],
          }),
          { round: n },
        );
        if (chosen === CHECK_STAGE) continue;
        if (chosen === STAGE && (yield* stageRefusal(`stage-picked-${n}`)) !== null) continue;
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
        if (chosen !== RELEASE) return mr;
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

/**
 * One Run of this workflow per Change the plan names, a wave at a time: a Change starts
 * once every one its tickets wait on is built. One that fails or cannot start starts no
 * further wave; the rest of its own wave is still waited on.
 */
const buildEach = (fan: {
  readonly plan: string;
  readonly root: string;
  readonly waves: ReadonlyArray<ReadonlyArray<string>>;
  readonly changes: ReadonlyArray<typeof ChangeReading.Type>;
  /** The launch options every Change's Run is started with, beside its own. */
  readonly options: Readonly<Record<string, string>>;
}) =>
  Effect.gen(function* () {
    const host = yield* Host;
    const children = yield* Children;
    const runId = (yield* Run).id;
    const invocation = (key: string) => `implement-${pipe_(key, Str.replaceAll("/", "-"))}`;
    const clash = identityProblem(Arr.map(fan.waves.flat(), invocation));
    if (clash !== null) return yield* new WorkflowError({ reason: clash });
    const changeOf = (key: string) =>
      Option.getOrElse(
        Arr.findFirst(fan.changes, (one) => one.key === key),
        (): typeof ChangeReading.Type => ({ key, repo: key }),
      );
    const built: string[] = [];
    const keys = fan.waves.flat();
    for (const [at, wave] of fan.waves.entries()) {
      // Each Change's Run is its Step's from its start to its end; they start in the
      // Wave's order and are waited on together.
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
              // Nobody attends a Change's share, so it ends at its merge request.
              // oxlint-disable-next-line unicorn/no-thenable -- implement's Input is named `then`
              input: { plan: fan.plan, then: "finish" },
              options,
            })
            .pipe(Effect.result, Effect.ensuring(Deferred.succeed(begun, undefined)));
          if (child._tag === "Failure")
            return { key, built: null, why: `not started: ${child.failure.reason}` };
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

/** What the slice claims it built, or the ticket's own name where it named nothing. */
const claimsOf = (built: typeof Built.Type, ticket: Slice): ReadonlyArray<string> => {
  const named = built.tickets_done ?? [];
  return named.length > 0 ? named : [ticket.title];
};

/**
 * The card a slice landing leaves, in the shape the agent writes its own and the cards
 * read. Written here so a ticket landing is visible whether or not the agent remembered.
 */
const checkpoint = (
  dir: string,
  ticket: Slice,
  status: "started" | "done",
  claims: ReadonlyArray<string>,
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const at = DateTime.formatIso(yield* DateTime.now);
    yield* fs.makeDirectory(`${dir}/steering/progress`, { recursive: true });
    yield* fs.writeFileString(
      `${dir}/steering/progress/${pipe_(ticket.file, Str.replace(/\.md$/, ""))}.json`,
      asCheckpoint({ ticket: ticket.file, status, claims: [...claims], at }),
    );
  }).pipe(Effect.orDie);

const asCheckpoint = flow(
  Schema.encodeResult(
    Schema.fromJsonString(
      Schema.Struct({
        ticket: Schema.String,
        status: Schema.Literals(["started", "done"]),
        claims: Schema.Array(Schema.String),
        at: Schema.String,
      }),
    ),
  ),
  Result.getOrThrow,
);

/** A ticket's criteria as its builder is given them. */
const renderCriteria = (criteria: ReadonlyArray<string>) =>
  criteria.length === 0
    ? "None: this work names no checkbox criteria, so `criteria` stays empty."
    : Arr.join(
        Arr.map(criteria, (one) => `- ${one}`),
        "\n",
      );

/** Each answer as the wording it answered; one that answered none of it is dropped. */
const boundTo = (wording: ReadonlyArray<string>, given: ReadonlyArray<Criterion>): Criterion[] =>
  Arr.flatMap(given, (answer) => {
    const criterion = Option.getOrUndefined(
      Arr.findFirst(wording, (one) => answerFor(one, [answer]) !== undefined),
    );
    return criterion === undefined ? [] : [{ ...answer, criterion }];
  });

/** What a builder said of one item's criteria, and what it decided that the plan did not. */
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

/** Every built item's criteria, answers and assumptions, as a reviewer is shown them. */
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

/** A merge of the default branch that stopped on conflicts, as the builder is told it. */
const conflictOf = (merged: Integration) =>
  `Collie merged ${merged.ref} (${merged.sha}) into this branch, and the merge stopped on conflicts in: ${Arr.join(merged.files, ", ")}.`;

/** What stopped an integration, as the builder is told it. */
const stoppedBy = (merged: Integration) =>
  merged.status === "conflicted"
    ? conflictOf(merged)
    : `Collie could not merge ${merged.ref} (${merged.sha}) into this branch: ${merged.reason}.`;

interface PartialBuild {
  readonly item: string;
  readonly completed: ReadonlyArray<string>;
  readonly findings: ReadonlyArray<Finding>;
}

/** The shared rally, with what blocks going back to the builder, told the part built so far. */
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
      fix: ({ operation, at, proves, findings }) =>
        Effect.gen(function* () {
          return yield* agentWork({
            operation,
            agent: BUILDER,
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
        }),
    });
  });

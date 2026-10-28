// Build the plan, review it, fix until nothing blocks, then open the merge request.
//
// One implementer for the whole Run: the tickets are a list it is handed one at a time,
// the fixes go back to the agent that built the work, and the merge request is written by
// the same one that knows what it did. Between them a rally — review, fix, review again —
// that leaves at the first review with nothing blocking and is bounded rather than
// endless. The review itself is `reviewing.ts`, the same pass the review workflow runs.
//
// Nothing here is a repeat declaration or a scheduler. `splitDisputed` decides what is
// still the implementer's, `settleRound` decides where a round goes, `settleFinalFix`
// decides whether the last fix stands, and `evidenceGapsOf` decides whether this Run has
// proved what it set out to prove — the same functions every workflow is held to.
//
// The Markdown beside this file is the content: the five kinds of work source, what a
// slice is told, and what the merge request has to say.

import {
  CriterionSchema,
  FindingSchema,
  FixOutputSchema,
  IntegrationSchema,
  Agents,
  Children,
  Host,
  Run,
  WorkflowError,
  afterMergeAnswers,
  afterMergeIn,
  agentWork,
  answerFor,
  ask,
  checkGapsOf,
  checkProof,
  classifyWorkSource,
  contentOf,
  criteriaIn,
  defineWorkflow,
  evidenceGapsOf,
  evidenceRoots,
  baseFailuresOf,
  baselinesOwed,
  findingKey,
  flakesOf,
  formatFindings,
  identityProblem,
  isBlocking,
  isOutcome,
  isSingleRepo,
  orderedTicketsOf,
  owedLocally,
  planReposOf,
  renderApproved,
  renderEvidence,
  recheckOwed,
  renderProgress,
  rerunsOwed,
  reviewGapsOf,
  settledChecks,
  settleFinalFix,
  leaveOutstanding,
  findingsIn,
  forecast,
  settleRound,
  splitDisputed,
  step,
  stepFailed,
  TOO_LARGE,
  unmetCriteria,
  wholeRunsOwed,
  type Criterion,
  type Finding,
  type Handed,
  type Integration,
  type Slice,
  type SynthesisReport,
  type Verification,
  type VerifySpec,
} from "collie";
import { DateTime, Deferred, Effect, Fiber, FileSystem, Schema } from "effect";
import { WorkflowInstance, type WorkflowEngine } from "effect/workflow/WorkflowEngine";
import * as Workflow from "effect/workflow/Workflow";
import * as Activity from "effect/workflow/Activity";
import markdown from "./implement.md" with { type: "text" };
import { IMPLEMENTER, REVIEWER, reviewPass, reviewRound } from "./reviewing.ts";

const content = contentOf(markdown);
const text = Schema.String;

/** What every implement prompt is told: the plan, what it proves, and what may prove it. */
const Implementing = Schema.Struct({
  inputs: Schema.Struct({ plan: text, plan_kind: text, repo: text, outcome: text }),
  run: Schema.Struct({ dir: text, id: text }),
  verify: text,
});

/** A section's text is sent as it is, so the names it carries are filled here. */
const sectionOf = (section: string, input: typeof Implementing.Type) =>
  (content.sections.get(section) ?? "")
    .replaceAll("{{inputs.plan}}", input.inputs.plan)
    .replaceAll("{{run.dir}}", input.run.dir);

const prompts = {
  build: content.template("build", {
    ...Implementing.fields,
    ticket: Schema.Struct({ file: text, title: text }),
    progress: text,
    session: Schema.Struct({ ask: text }),
    obstacle: text,
    criteria: text,
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

/** Which repositories a plan names, as a reading of it records them. */
const Reading = Schema.Struct({
  single: Schema.Boolean,
  waves: Schema.Array(Schema.Array(Schema.String)),
  refusal: Schema.NullOr(Schema.String),
});

/** A ticket as a reading of the plan records it. */
const SliceRecord = Schema.Struct({
  file: Schema.String,
  number: Schema.String,
  title: Schema.String,
  blockedBy: Schema.Array(Schema.String),
  checks: Schema.Array(Schema.String),
  // A reading journaled before tickets carried their criteria has none.
  criteria: Schema.optionalKey(Schema.Array(Schema.String)),
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

/** At most four rounds per rally; leave when no blocking finding remains. */
const ROUNDS = 4;

/** How often a ticket's unanswered criteria go back to its builder before a reviewer sees them. */
const CRITERIA_TRIES = 2;
/** Hand-backs of what stopped an integration — a commit can uncover a conflict. */
const MERGE_TRIES = 2;

/** One agent for the whole Run, so its model is named once and the fixes know the build. */
const BUILDER = "build";

const RELEASE = "Release";
const STAGE = "Stage";
const FINISH = "Finish";
const HAND_BACK = "Hand back";
const STOP = "Stop";

const Tree = Schema.Struct({ head: Schema.String, fingerprint: Schema.String });

/** A fix round that changed nothing and disputed every finding: another would read the same tree. */
const stalledFix = (
  before: typeof Tree.Type | undefined,
  after: typeof Tree.Type | undefined,
  findings: ReadonlyArray<Finding>,
  fixed: typeof FixOutputSchema.Type,
) => {
  const disputed = new Set((fixed.disputed ?? []).map(findingKey));
  return (
    before !== undefined &&
    after?.head === before.head &&
    after.fingerprint === before.fingerprint &&
    (fixed.fixed ?? []).length === 0 &&
    findings.every((one) => disputed.has(findingKey(one)))
  );
};

/** A check left to CI whose job failed on the merge request's head, as a CI fix round is told of it. */
const CiFailed = Schema.Struct({
  name: Schema.String,
  job: Schema.String,
  url: Schema.NullOr(Schema.String),
  log: Schema.NullOr(Schema.String),
  unproved: Schema.String,
});

const building = step({
  id: "build",
  title: "Build",
  description: "The implementer builds a ticket, or the whole of the work where there is one.",
  kind: "agent",
  role: "implementer",
});
const gate = step({
  id: "checks",
  title: "Checks",
  description: "Collie runs every check on the tree, and the implementer fixes what they lack.",
  kind: "check",
  produces: "evidence",
});
const mergeRequest = step({
  id: "merge-request",
  title: "Merge request",
  description: "The implementer pushes the branch and opens its merge request, citing the checks.",
  kind: "agent",
  role: "implementer",
  produces: "merge-request",
});
const next = step({
  id: "next",
  title: "What next",
  description: "Whether the open merge request is released, staged or left as it is.",
  kind: "question",
});
const ciFix = step({
  id: "ci-fix",
  title: "CI fix",
  description: "The implementer fixes what a CI job failed on the merge request's head.",
  kind: "agent",
  role: "implementer",
});
const repoRuns = step({
  id: "repo-runs",
  title: "Repo runs",
  description: "One Run per repository the plan names, a Wave at a time.",
  kind: "workflow",
});

export default defineWorkflow({
  id: "implement",
  title: "implement — build the plan, review it, fix until nothing blocks",
  description:
    "Builds a change on a branch of its own and ends in a merge request: from a plan dir, a Linear issue or a description, it gets one complete review and fixes what blocks until a review finds nothing blocking.",
  input: Schema.Struct({
    plan: Schema.String.annotate({
      description:
        "Where the work is written down: a plan, a review, an issue, a follow-up, or words",
    }),
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
      title: "Release",
      workflow: "release",
      when: "succeeded",
      inputs: { mr: "merge-request" },
      eligible: (facts) => facts.mrUrl !== null,
    },
    {
      id: "stage",
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
      const source = yield* classifyWorkSource(asked.plan).pipe(
        Effect.orElseSucceed(() => ({ kind: "text", value: asked.plan })),
      );
      const share = place.options.repo ?? "";
      if (source.kind === "plan-dir" && share === "") {
        const plan = yield* Activity.make({
          name: "repos",
          success: Reading,
          execute: planReposOf(source.value, cwd).pipe(
            Effect.map((read) => ({
              single: isSingleRepo(read),
              waves: read.waves.map((wave) => [...wave]),
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
          const carried = Object.fromEntries(
            Object.entries(place.options).filter(
              ([name]) => name !== "repo" && name !== "workspace",
            ),
          );
          return yield* buildEach({
            plan: source.value,
            root: cwd,
            waves: plan.waves,
            // One branch in every repository: the one asked for, or one named after this Run.
            options:
              carried.branch !== undefined || carried.task !== undefined
                ? carried
                : { ...carried, task: runId },
          });
        }
      }
      // A Run that stops short of its merge request fails, so no wave waits on work that is
      // not there and its card is not told as done.
      const unbuilt = (reason: string) =>
        Effect.fail(
          new WorkflowError({
            reason:
              share === ""
                ? `${reason}. Continue with a follow-up Run to finish delivery.`
                : reason,
          }),
        );
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
              `${why.replace(/\.+$/, "")}. Resume ${runId} once it can be read.`,
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
          execute: orderedTicketsOf(source.value, place.options.repo ?? ""),
        });
        return read.map((one) => ({ ...one, criteria: one.criteria ?? [] }));
      });
      let tickets: ReadonlyArray<Slice> = yield* ticketsNow;
      // Read only after the build, which is what writes SPEC.md for any source but a plan.
      let specReadings = 0;
      const specNow = Effect.gen(function* () {
        if (source.kind === "plan-dir") return source.value;
        specReadings += 1;
        return yield* Activity.make({
          name: `spec.${specReadings}`,
          success: Schema.String,
          execute: FileSystem.FileSystem.pipe(
            Effect.flatMap((fs) => fs.exists(`${place.dir}/plan/SPEC.md`)),
            Effect.map((written) => (written ? `${place.dir}/plan` : "")),
            Effect.orElseSucceed(() => ""),
          ),
        });
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
      for (;;) {
        // Identities before work: two tickets nobody can tell apart would share one
        // result, and finding that out after an agent has been paid for is too late.
        const clash = identityProblem(tickets.map((ticket) => ticket.file));
        if (clash !== null) return yield* new WorkflowError({ reason: clash });
        const ticket =
          whole && built.size === 0 ? null : tickets.find((one) => !built.has(one.file));
        if (ticket === undefined) break;
        rallied = null;
        const { done, blocking } = yield* building(
          Effect.gen(function* () {
            const before = (yield* host.evidence(runId, cwd)).verifications.length;
            if (ticket !== null) yield* checkpoint(place.dir, ticket, "started", []);
            const merged =
              ticket !== null && built.size > 0
                ? yield* integrated(`${ticket.file}.merge`, true)
                : null;
            const session = yield* sessionNow;
            // A plan built in one pass answers every ticket's criteria, and words their own.
            const given =
              ticket?.criteria ??
              (source.kind === "text"
                ? criteriaIn(source.value)
                : tickets.flatMap((one) => one.criteria));
            yield* restateKind;
            build = yield* agentWork({
              operation: ticket?.file ?? "build",
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
            const item = ticket?.file ?? "build";
            // A Linear issue's criteria are read from its description as the builder copied it.
            const spec =
              ticket === null && source.kind === "linear"
                ? yield* Activity.make({
                    name: "criteria.spec",
                    success: Schema.NullOr(Schema.Array(Schema.String)),
                    execute: FileSystem.FileSystem.pipe(
                      Effect.flatMap((fs) => fs.readFileString(`${place.dir}/plan/SPEC.md`)),
                      Effect.map(criteriaIn),
                      Effect.orElseSucceed(() => null),
                    ),
                  })
                : given;
            if (spec === null) {
              const why = `${item}: ${place.dir}/plan/SPEC.md cannot be read, so the issue's acceptance criteria cannot be checked and no review starts`;
              yield* host.record(runId, why);
              return yield* unbuilt(why);
            }
            // A plan's tickets are read again before each judgement, so an amended one is judged
            // and handed back as it reads now; one that cannot be read keeps its last reading.
            let read: ReadonlyArray<{ file: string } & typeof TicketReading.Type> =
              source.kind === "plan-dir"
                ? (ticket === null ? tickets : [ticket]).map((one) => ({
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
                name: `${item}.criteria.read-${reads}`,
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
              read = read.map((one, at) => (now[at] ? { file: one.file, ...now[at] } : one));
              return read.flatMap((one) => one.criteria);
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
                  name: `${item}.criteria-stalled-${stalls}`,
                  prompt: `${item}: a criteria hand-back reported a blocker and changed nothing.\n\nIts blockers:\n${formatFindings(blockers)}\n\nStill unmet:\n${formatFindings(unmet)}\n\nAmend the ticket or clear the blocker, then hand it back, or stop the Run.`,
                  options: [HAND_BACK, STOP],
                });
                if (chosen !== HAND_BACK) {
                  stopped = `${item}: a criteria hand-back reported a blocker and changed nothing, so no review starts: ${unmet.map((one) => one.title).join("; ")}`;
                  break;
                }
                blockers = [];
                tries = 1;
                continue;
              }
              if (tries > CRITERIA_TRIES) {
                unmetAsks += 1;
                const name = `${item}.criteria-unmet-${unmetAsks}`;
                const still = `${item}: acceptance criteria still unanswered or unmet after ${CRITERIA_TRIES} hand-backs`;
                const chosen = yield* ask({
                  name,
                  prompt: `${still}.\n\nStill unmet:\n${formatFindings(unmet)}\n\nAmend the ticket, then hand it back, or stop the Run.`,
                  options: [HAND_BACK, STOP],
                });
                if (chosen !== HAND_BACK) {
                  stopped = `${still}, so no review starts: ${unmet.map((one) => one.title).join("; ")}. Stop was answered to ${name}`;
                  break;
                }
                tries = 1;
                continue;
              }
              const before = yield* treeAt(`${item}.criteria-${turn}.before`);
              yield* restateKind;
              const answered = yield* agentWork({
                operation: `${item}.criteria-${turn}`,
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
              const after = yield* treeAt(`${item}.criteria-${turn}.after`);
              answers = [...answers, ...boundTo(criteria, answered.criteria ?? [])];
              assumptions.push(...(answered.assumptions ?? []));
              commits.push(...(answered.commits ?? []));
              blockers =
                after.head === before.head &&
                after.fingerprint === before.fingerprint &&
                after.fingerprint !== TOO_LARGE
                  ? (answered.findings ?? []).filter(isBlocking)
                  : [];
              tries += 1;
              turn += 1;
            }
            const done: Handed = {
              item,
              title: ticket?.title ?? "",
              commits,
              verifications: (yield* host.evidence(runId, cwd)).verifications
                .slice(before)
                .map((one) => `${one.name}: ${one.result}`),
            };
            handed.push(done);
            if (stopped !== null) {
              yield* host.record(runId, stopped);
              return yield* unbuilt(stopped);
            }
            answeredFor.push({ item, criteria, answers, assumptions });
            for (const one of assumptions) assumed.push(`assumed in ${item}: ${one}`);
            for (const one of read)
              afterMerged.push(
                ...one.afterMerge.map((line) => `${one.file}: after merge: ${line}`),
              );
            for (const { criterion, met } of afterMergeAnswers(criteria, answers))
              afterMerged.push(
                `${read.find((one) => one.criteria.includes(criterion))?.file ?? item}: ${criterion} — ${met}`,
              );
            built.add(done.item);
            if (ticket === null) for (const one of tickets) built.add(one.file);
            if (ticket !== null)
              yield* checkpoint(place.dir, ticket, "done", claimsOf(build, ticket));
            return { done, blocking: (build.findings ?? []).filter(isBlocking) };
          }),
          ticket === null
            ? undefined
            : { item: ticket.file, items: tickets.map((one) => one.file) },
        );
        if (blocking.length > 0) {
          rallied = yield* rally({
            ...rallyAsk,
            plan: yield* specNow,
            criteria: renderAnswered(answeredFor),
            input,
            build: {
              item: done.item,
              completed: handed.map((one) => one.item),
              findings: blocking,
            },
          });
          const unresolved = rallied.halted ?? rallied.unsettled.join("; ");
          if (unresolved !== "") return yield* unbuilt(`${done.item}: ${unresolved}`);
        }
        tickets = yield* ticketsNow;
      }
      if (build === null) return yield* new WorkflowError({ reason: "nothing was built" });
      // The builder may have named the checks, and every prompt from here shows them.
      input = { ...input, verify: yield* checksNow };

      if (rallied === null || rallied.unreviewed !== "") {
        rallied = yield* rally({
          ...rallyAsk,
          plan: yield* specNow,
          criteria: renderAnswered(answeredFor),
          input,
        });
      }
      if (rallied.halted !== null) {
        yield* host.record(runId, rallied.halted);
        return yield* unbuilt(rallied.halted);
      }

      // The gate: Collie's own run of every check, on this tree, and then what this kind of
      // result still has no evidence for. An Output saying the tests pass is a claim; a
      // record in the journal, bound to this tree, is not. Each pass is journaled, so a
      // replay follows the results the merge request will cite rather than a fresh run of
      // checks that may come out differently. The host runs nothing that already passed on
      // this tree.
      let passes = 0;
      let reruns = 0;
      let passed: ReadonlyArray<string> = [];
      const readGaps = Effect.fn("implement.readGaps")(function* (
        approved: ReadonlyArray<VerifySpec>,
        reviewed: SynthesisReport,
      ) {
        const now = yield* outcomeOf;
        const asked = {
          kind: isOutcome(now) ? now : ("unspecified" as const),
          evidence: yield* host.evidence(runId, cwd),
          approved,
          outputs: { build: { ...build }, synthesize: { ...reviewed } },
          reviewed: ["synthesize"],
          roots: evidenceRoots(place.dir, cwd, source.value),
          tickets: tickets.map((ticket) => ({ file: ticket.file, checks: ticket.checks })),
        };
        return {
          gaps: evidenceGapsOf(asked),
          fixable: checkGapsOf(asked),
          reviewable: reviewGapsOf(asked),
        };
      });
      // Why each pass runs, which every door shows while it does (ADR-0042).
      const gapsNow = Effect.fn("implement.gapsNow")(function* (
        why: {
          readonly pass: "gate" | "recheck" | "fix";
          readonly round?: number;
        },
        since?: typeof Tree.Type,
      ) {
        passes += 1;
        const pass = yield* Activity.make({
          name: `gate.${passes}`,
          success: Schema.Struct({
            gaps: Schema.Array(Schema.String),
            // A pass journaled before gaps were told apart handed a fix every gap.
            fixable: Schema.optionalKey(Schema.Array(Schema.String)),
            passed: Schema.Array(Schema.String),
            tree: Schema.optionalKey(
              Schema.Struct({ head: Schema.String, fingerprint: Schema.String }),
            ),
          }),
          execute: Effect.gen(function* () {
            const checks = yield* host.approved(runId);
            const now = [...passed];
            const journal = { ...(yield* host.evidence(runId, cwd)), approved: checks };
            // On a tree a fix left as it was, its records stand: only a check with none runs.
            const unmoved =
              since?.head === journal.final.head_sha &&
              since.fingerprint === journal.final.fingerprint;
            // A failure that named its tests had them run again alone instead.
            const whole = why.pass === "recheck" ? wholeRunsOwed(journal) : null;
            for (const spec of owedLocally(checks)) {
              if (now.includes(spec.name)) continue;
              if (whole !== null && !whole.includes(spec.name)) continue;
              if (unmoved && checkProof(journal, spec.name, "collie").last !== undefined) continue;
              const ran = yield* host.verify({ runId, name: spec.name, cwd, ...why });
              if (ran.result === "pass") now.push(spec.name);
            }
            const { final } = yield* host.evidence(runId, cwd);
            return {
              ...(yield* readGaps(checks, rallied.reviewed)),
              passed: now,
              tree: { head: final.head_sha, fingerprint: final.fingerprint },
            };
          }).pipe(Effect.orDie),
        });
        passed = pass.passed;
        return { gaps: pass.gaps, fixable: pass.fixable ?? pass.gaps, tree: pass.tree };
      });
      // Each test a failed check named, run again alone once on the same tree, and each that
      // still fails run alone at the base: a Flake, or a test that fails there too, is neither
      // a gap nor a pass (ADR-0034, amended 2026-10-15).
      const settleTests = Effect.gen(function* () {
        const approved = yield* host.approved(runId);
        for (const { check, test } of rerunsOwed({
          ...(yield* host.evidence(runId, cwd)),
          approved,
        }))
          yield* host.verify({ runId, name: check, cwd, pass: "rerun", test });
        // A base that cannot be reached exempts nothing.
        for (const { check, test } of baselinesOwed({
          ...(yield* host.evidence(runId, cwd)),
          approved,
        }))
          yield* host
            .verify({ runId, name: check, cwd, at: "default-base", test })
            .pipe(Effect.ignore);
        return approved;
      });
      const settleFailed = Effect.fn("implement.settleFailed")(function* (gaps: {
        readonly gaps: ReadonlyArray<string>;
        readonly fixable: ReadonlyArray<string>;
        readonly tree?: { readonly head: string; readonly fingerprint: string };
      }) {
        if (gaps.fixable.length === 0) return gaps;
        reruns += 1;
        const reread = yield* Activity.make({
          name: `rerun.${reruns}`,
          success: Schema.Struct({
            gaps: Schema.Array(Schema.String),
            fixable: Schema.Array(Schema.String),
          }),
          execute: settleTests.pipe(
            Effect.flatMap((approved) => readGaps(approved, rallied.reviewed)),
            Effect.orDie,
          ),
        });
        // Neither moves the tree from where the pass before read it.
        return { ...reread, tree: gaps.tree };
      });
      const { unreviewed, stalled } = yield* gate(
        Effect.gen(function* () {
          let gaps = yield* settleFailed(yield* gapsNow({ pass: "gate" }));
          // Once more before a fix, where a failure named no tests: a check that fails and then
          // passes on the same tree is a flake, and a Run that ends on one has proved nothing.
          if (gaps.fixable.length > 0)
            gaps = yield* settleFailed(yield* gapsNow({ pass: "recheck" }));
          // A gate fix lands after the last review, so the merge request says it was not re-reviewed.
          let unreviewed = rallied.unreviewed;
          // The implementer fixes what a check could still prove, bounded like the rally; the
          // human reads what is left in the merge request, before it lands.
          let fixes = 0;
          // A round that changed nothing and disputed every finding: another would check the same tree.
          let stalled: { readonly at: number; readonly disputed: ReadonlyArray<Finding> } | null =
            null;
          for (; gaps.fixable.length > 0 && fixes < ROUNDS && stalled === null; fixes++) {
            const at = fixes + 1;
            const before = gaps.tree;
            passed = [];
            const atBase = baseFailuresOf({
              ...(yield* host.evidence(runId, cwd)),
              approved: yield* host.approved(runId),
            }).map(({ check, name, file }) => `${check}: ${name} (${file})`);
            const findings = gaps.fixable.map((gap) => ({
              severity: "blocker",
              title: gap,
              detail: `Collie read this Run's checks on this tree, and this is what is still unproved.${
                atBase.length === 0
                  ? ""
                  : ` These also fail where this branch leaves the default branch, so they are not yours to fix: ${atBase.join("; ")}.`
              }`,
            }));
            const fixed = yield* agentWork({
              operation: `gate-fix-${at}`,
              agent: BUILDER,
              role: "implementer",
              pushes: true,
              instructions: prompts.fix,
              input: {
                ...input,
                verify: yield* checksNow,
                iteration: String(at),
                max_iterations: String(ROUNDS),
                findings: formatFindings(findings),
              },
              output: FixOutputSchema,
            });
            gaps = yield* settleFailed(yield* gapsNow({ pass: "fix", round: at }, before));
            if (stalledFix(before, gaps.tree, findings, fixed))
              stalled = { at, disputed: fixed.disputed ?? [] };
            const settled = settleFinalFix(findings, fixed, yield* host.evidence(runId, cwd));
            unreviewed = [
              unreviewed,
              settled.ok
                ? `gate fix ${at}: ${settled.attestation}`
                : `gate fix ${at}, not re-reviewed: ${settled.reasons.join("; ")}`,
            ]
              .filter((line) => line !== "")
              .join("\n");
          }
          const { final } = yield* host.evidence(runId, cwd);
          const spec = yield* specNow;
          const proofKey = yield* Activity.idempotencyKey(
            Schema.encodeSync(Schema.fromJsonString(Schema.Unknown))({
              final,
              approved: yield* host.approved(runId),
            }),
          );
          yield* Activity.make({
            name: `proof.${proofKey}`,
            success: Schema.Void,
            error: WorkflowError,
            execute: Effect.gen(function* () {
              const approved = yield* host.approved(runId);
              let reviewed = rallied.reviewed;
              const disputed = new Set((stalled?.disputed ?? []).map(findingKey));
              const undisputed = (gap: string) => !disputed.has(findingKey({ title: gap }));
              const reading = Effect.suspend(() => readGaps(approved, reviewed)).pipe(
                Effect.map(({ gaps, fixable, reviewable }) => ({
                  gaps: gaps.filter(undisputed),
                  fixable: fixable.filter(undisputed),
                  reviewable,
                })),
              );
              // A check that failed on this tree is run whole again only where its failures named no
              // tests and it has had no recheck here, or on a resume from the park below; one that is
              // has its named failures run alone too, before any gap is read (ADR-0034, amended
              // 2026-10-19).
              const rely = Effect.fn("implement.rely")(function* (resumed: boolean) {
                const journal = { ...(yield* host.evidence(runId, cwd)), approved };
                const settled = settledChecks(journal);
                const whole = recheckOwed(journal);
                for (const spec of owedLocally(approved).filter(
                  (one) => !settled.includes(one.name),
                )) {
                  const proof = checkProof(journal, spec.name, "collie");
                  const relied =
                    proof.state === "passed" || resumed || whole.includes(spec.name)
                      ? yield* host.verify({ runId, name: spec.name, cwd, pass: "recheck" })
                      : proof.last;
                  if (relied !== undefined)
                    yield* host.record(
                      runId,
                      `proof: ${spec.name} relies on verification ${relied.id}`,
                    );
                }
                yield* settleTests;
              });
              const fs = yield* FileSystem.FileSystem;
              const unprovedPark = `${place.dir}/proof-parked-unproved`;
              const resumed = yield* fs.exists(unprovedPark).pipe(Effect.orDie);
              yield* rely(resumed);
              if (resumed) yield* fs.remove(unprovedPark).pipe(Effect.orDie);
              if (stalled !== null) {
                const standing = (yield* readGaps(approved, reviewed)).fixable.filter(
                  (gap) => !undisputed(gap),
                );
                if (standing.length > 0)
                  yield* host.record(
                    runId,
                    `outcome unproved: ${standing.join("; ")}; gate fix ${stalled.at} disputed them and changed nothing`,
                  );
              }
              let missing = yield* reading;
              if (missing.fixable.length > 0) {
                yield* fs.writeFileString(unprovedPark, "").pipe(Effect.orDie);
                const why = `Outcome unproved after ${fixes} gate fixes: ${missing.gaps.join("; ")}. Repair the checks, then resume ${runId}.`;
                yield* stepFailed(why);
                yield* host.parked(runId, why);
                return yield* Workflow.suspend(yield* WorkflowInstance);
              }
              const reviewedAgain = missing.reviewable.length > 0;
              if (reviewedAgain) {
                // A fresh review sees what will merge too; checks that passed before a merge
                // prove nothing about the tree after it.
                const checked = (yield* host.evidence(runId, cwd)).final;
                yield* integrated("merge-proof");
                const now = (yield* host.evidence(runId, cwd)).final;
                if (now.head_sha !== checked.head_sha || now.fingerprint !== checked.fingerprint)
                  yield* rely(false);
                reviewed = yield* reviewPass({
                  target: "",
                  plan: spec,
                  proves: yield* outcomeOf,
                  previous: `${place.dir}/review.md`,
                  answered: fixes === 0 ? "" : agents.outputFor(runId, `gate-fix-${fixes}`),
                  risks: place.options.risks ?? "",
                  criteria: renderAnswered(answeredFor),
                  base,
                  at: ROUNDS + 1,
                  of: ROUNDS + 1,
                  disputed: [],
                });
                missing = yield* reading;
              }
              if (missing.gaps.length > 0)
                return yield* new WorkflowError({
                  reason: `Outcome ${reviewedAgain ? "still unproved after a fresh review" : "unproved, and no reviewer can change that"}: ${missing.gaps.join("; ")}. Continue with a follow-up Run to repair the work.`,
                });
              yield* host.parked(runId, null);
            }),
          });
          return { unreviewed, stalled };
        }),
      );
      // A dispute the human settles stays counted at its own severity, whatever review wrote last.
      if (rallied.disputes.length > 0) {
        const disputedKeys = new Set(rallied.disputes.map(findingKey));
        const onFile = yield* findingsIn(place.dir);
        yield* leaveOutstanding(place.dir, [
          ...onFile.filter((one) => !disputedKeys.has(findingKey(one))),
          ...rallied.disputes,
        ]);
      }
      const checks = yield* host.approved(runId);
      const journal = { ...(yield* host.evidence(runId, cwd)), approved: checks };
      const flakes = flakesOf(journal);
      // Failed before this Run changed anything, and still fails: reported, never passed.
      const preexisting = baseFailuresOf(journal);
      const unsettled = [
        ...assumed,
        ...afterMerged,
        ...rallied.unsettled,
        ...(stalled?.disputed ?? []).map(
          (one) =>
            `${one.title}: gate fix ${stalled!.at} disputed it and changed nothing${one.reason ? `: ${one.reason}` : ""}`,
        ),
        ...flakes.map(
          ({ check, name, file }) =>
            `${check}: ${name} (${file}) failed, then passed when run again alone on the same tree — a Flake, so this Run has not settled it.`,
        ),
        ...preexisting.map(
          ({ check, name, file, at }) =>
            `${check}: ${name} (${file}) also fails at ${at.slice(0, 12)}, where this branch leaves the default branch, so it failed before this Run's changes.`,
        ),
      ];
      if (unsettled.length > 0) yield* host.record(runId, `unsettled: ${unsettled.join("; ")}`);
      const nothing = yield* Activity.make({
        name: "nothing-to-land",
        success: Schema.NullOr(Schema.String),
        execute: host.nothingToLand(runId, cwd),
      });
      if (nothing !== null) return nothing;
      const leftToCi = checks.filter((spec) => spec.ci !== undefined);
      const mrUrl = yield* mergeRequest(
        Effect.gen(function* () {
          const ready = yield* host.mr({ cwd, source: { value: source.value, kind: source.kind } });
          if (!ready.ok) {
            const head = (yield* host.evidence(runId, cwd)).final.head_sha.slice(0, 12);
            const unproved = leftToCi.map(
              (spec) =>
                ` ${spec.name} is left to CI and unproved: job ${spec.ci} on ${head} cannot be read without one.`,
            );
            const reason = `Cannot open the merge request: ${ready.reason}.${unproved.join("")} Repair it, then resume ${runId}.`;
            yield* host.record(runId, reason);
            yield* stepFailed(reason);
            yield* host.parked(runId, reason);
            return yield* Workflow.suspend(yield* WorkflowInstance);
          }

          const settledEvidence = yield* host.evidence(runId, cwd);
          const opened = yield* agentWork({
            operation: "mr",
            agent: BUILDER,
            role: "implementer",
            pushes: true,
            // Not merging: only a message of its own asks for that.
            clears: !ready.branch
              ? []
              : [
                  `pushing ${ready.branch} to origin${ready.url === undefined ? "" : ` (${ready.url})`}`,
                  `opening or updating its ${ready.noun ?? "merge request"} there`,
                ],
            instructions: prompts.mr,
            input: {
              ...input,
              inputs: { ...input.inputs, outcome: yield* kindNow },
              verify: renderApproved(spawned(checks, settledEvidence.verifications)),
              // Read after the gate settled, so the merge request cites the passing runs.
              evidence: renderEvidence(settledEvidence),
              unreviewed,
              unsettled: unsettled.map((line) => `- ${line}`).join("\n"),
              mr: {
                forge: ready.forge ?? "GitLab",
                noun: ready.noun ?? "merge request",
                assignee: ready.assignee,
                template: ready.template,
                issues: ready.issues.join(", "),
                existing: ready.existing ?? "",
                create: ready.commands?.create ?? "",
                comment: ready.commands?.comment ?? "",
              },
              // Not read by the shipped content; a fork's may, and `--repo` suits both CLIs.
              target_repo: ready.repository ? `--repo ${ready.repository}` : "",
            },
            output: Opened,
          });
          if (
            opened.verdict !== "clean" ||
            !opened.pushed ||
            !opened.mr_url ||
            (opened.findings ?? []).length > 0
          ) {
            const missing = [
              ...(!opened.pushed ? ["the branch was not pushed"] : []),
              ...(!opened.mr_url ? ["no merge request URL was reported"] : []),
              ...(opened.findings ?? []).map((finding) => finding.title),
            ];
            return yield* new WorkflowError({
              reason: `Merge request delivery did not finish: ${missing.join("; ") || opened.verdict}. Continue with a follow-up Run to finish delivery.`,
            });
          }
          yield* host.mergeRequest(runId, opened.mr_url);
          return opened.mr_url;
        }),
      );
      // Each check left to CI is proved by its job on the merge request's head. A failed one
      // is the builder's in a CI fix round, bounded like the gate's; the gate's fix loop stays
      // apart, since what fails, how it is read again and the replay keys all differ.
      const treeNow = Effect.map(host.evidence(runId, cwd), ({ final }) => ({
        head: final.head_sha,
        fingerprint: final.fingerprint,
      }));
      const told = (line: string) =>
        Effect.andThen(host.record(runId, line), host.note({ runId, cwd, body: line }));
      let ciFixes = 0;
      // Why a job still failing parks the Run rather than going to another round.
      let blocked: { readonly why: string; readonly unmoved: boolean } | null = null;
      while (leftToCi.length > 0) {
        const read = yield* Activity.make({
          name: `ci-proof.${ciFixes}`,
          success: Schema.Struct({ failed: Schema.Array(CiFailed), tree: Tree }),
          execute: Effect.gen(function* () {
            const unproved: string[] = [];
            const failed: Array<typeof CiFailed.Type> = [];
            for (const spec of leftToCi) {
              const job = spec.ci ?? "";
              const read = yield* host.ciJob({
                runId,
                cwd,
                name: spec.name,
                wait: true,
                // The same job on an unmoved head was compared and retried already.
                settle: blocked?.unmoved !== true,
              });
              if ("proved" in read) {
                if (read.retried === true)
                  yield* told(
                    `unsettled: ${spec.name}: job ${job} failed on ${read.proved.end.head_sha.slice(0, 12)}, then passed when retried — a Flake, so this Run has not settled it.`,
                  );
              } else if (read.before !== undefined)
                yield* told(
                  `unsettled: ${spec.name}: job ${job} also fails at ${read.before.at.slice(0, 12)}, where this branch leaves its target branch, so it failed before this Run's changes.`,
                );
              else if (read.state === "failed")
                failed.push({
                  name: spec.name,
                  job,
                  url: read.url,
                  log: read.log,
                  unproved: read.unproved,
                });
              else unproved.push(read.unproved);
            }
            if (yield* host.stopRequested(runId))
              return yield* Workflow.suspend(yield* WorkflowInstance);
            const why =
              unproved.length > 0
                ? `Outcome unproved: ${[...unproved, ...failed.map((one) => one.unproved)].join("; ")}`
                : blocked !== null && failed.length > 0
                  ? `${blocked.why}: ${failed.map((one) => one.unproved).join("; ")}`
                  : null;
            if (why !== null) {
              const reason = `${why}. Repair it, then resume ${runId}.`;
              yield* host.record(runId, reason);
              yield* host.parked(runId, reason);
              return yield* Workflow.suspend(yield* WorkflowInstance);
            }
            yield* host.parked(runId, null);
            return { failed, tree: yield* treeNow };
          }),
        });
        if (read.failed.length === 0) break;
        ciFixes += 1;
        const at = ciFixes;
        const findings = read.failed.map((one) => ({
          severity: "blocker",
          title: `${one.name}: its CI job ${one.job} failed`,
          detail: `On ${read.tree.head.slice(0, 12)}, the merge request's head: ${one.url ?? "the forge gave no URL"}. Its log: ${one.log ?? "the forge gave no command for it"}`,
        }));
        const fixed = yield* ciFix(
          agentWork({
            operation: `ci-fix-${at}`,
            agent: BUILDER,
            role: "implementer",
            pushes: true,
            instructions: prompts.ciFix,
            input: {
              ...input,
              verify: yield* checksNow,
              iteration: String(at),
              max_iterations: String(ROUNDS),
              findings: formatFindings(findings),
            },
            output: FixOutputSchema,
          }),
          { round: at, of: ROUNDS },
        );
        const after = yield* Activity.make({
          name: `ci-tree.${at}`,
          success: Tree,
          execute: treeNow,
        });
        if (stalledFix(read.tree, after, findings, fixed)) {
          const lines = (fixed.disputed ?? []).map(
            (one) =>
              `${one.title}: ci fix ${at} disputed it and changed nothing${one.reason ? `: ${one.reason}` : ""}`,
          );
          yield* Activity.make({
            name: `ci-disputed.${at}`,
            success: Schema.Void,
            execute: told(`outcome unproved: ${lines.join("; ")}`),
          });
          break;
        }
        const settled = settleFinalFix(findings, fixed, yield* host.evidence(runId, cwd));
        yield* Activity.make({
          name: `ci-unreviewed.${at}`,
          success: Schema.Void,
          execute: told(
            `ci fix ${at} landed after the last review and was not re-reviewed: ${
              settled.ok ? settled.attestation : settled.reasons.join("; ")
            }`,
          ),
        });
        blocked =
          after.head === read.tree.head
            ? {
                why: `Outcome unproved: ci fix ${at} pushed no new commit: the head is still ${after.head.slice(0, 12)}`,
                unmoved: true,
              }
            : at >= ROUNDS
              ? { why: `Outcome unproved after ${ROUNDS} CI fixes`, unmoved: false }
              : null;
      }
      return yield* releasing({ mr: mrUrl, cwd, then: asked.then ?? "" });
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
            options: refused === null ? [RELEASE, STAGE, FINISH] : [RELEASE, FINISH],
          }),
          { round: n },
        );
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
 * One Run of this workflow per repository the plan names, a wave at a time: a repository
 * starts once every one its tickets wait on is built. One that fails or cannot start
 * starts no further wave; the rest of its own wave is still waited on.
 */
const buildEach = (fan: {
  readonly plan: string;
  readonly root: string;
  readonly waves: ReadonlyArray<ReadonlyArray<string>>;
  /** The launch options every repository's Run is started with, beside its own. */
  readonly options: Readonly<Record<string, string>>;
}) =>
  Effect.gen(function* () {
    const host = yield* Host;
    const children = yield* Children;
    const runId = (yield* Run).id;
    const invocation = (repo: string) => `implement-${repo.replaceAll("/", "-")}`;
    const clash = identityProblem(fan.waves.flat().map(invocation));
    if (clash !== null) return yield* new WorkflowError({ reason: clash });
    const built: string[] = [];
    const repos = fan.waves.flat();
    for (const [at, wave] of fan.waves.entries()) {
      // Each repository's Run is its Step's from its start to its end; they start in the
      // Wave's order and are waited on together.
      const running = [];
      for (const repo of wave) {
        const begun = yield* Deferred.make<void>();
        const share = Effect.gen(function* () {
          const child = yield* children
            .start({
              invocation: invocation(repo),
              workflow: "self",
              // Nobody attends a repository's share, so it ends at its merge request.
              // oxlint-disable-next-line unicorn/no-thenable -- implement's Input is named `then`
              input: { plan: fan.plan, then: "finish" },
              options: { ...fan.options, repo, workspace: `${fan.root}/${repo}` },
            })
            .pipe(Effect.result, Effect.ensuring(Deferred.succeed(begun, undefined)));
          if (child._tag === "Failure")
            return { repo, built: null, why: `not started: ${child.failure.reason}` };
          return yield* children.result(child.success).pipe(
            Effect.map((value) => ({ repo, built: String(value), why: "" })),
            Effect.catch((failure) => Effect.succeed({ repo, built: null, why: failure.reason })),
          );
        });
        const building = yield* Effect.forkChild(repoRuns(share, { item: repo, items: repos }));
        running.push(building);
        yield* Effect.raceFirst(Deferred.await(begun), Fiber.join(building));
      }
      const ended = yield* Fiber.joinAll(running);
      for (const one of ended) {
        built.push(`${one.repo}: ${one.built ?? one.why}`);
        yield* host.record(runId, `${one.repo}: ${one.built ?? one.why}`);
      }
      const stopped = ended.find((one) => one.built === null);
      if (stopped !== undefined) {
        const left = fan.waves.slice(at + 1).flat();
        const waiting =
          left.length === 0 ? "" : ` Not run: ${left.join(", ")}, waiting on ${stopped.repo}.`;
        return yield* new WorkflowError({
          reason: `${stopped.repo} did not build.${waiting} ${built.join("; ")}`,
        });
      }
    }
    return `${fan.waves.flat().length} repositories built in ${fan.waves.length} wave(s): ${built.join("; ")}`;
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
      `${dir}/steering/progress/${ticket.file.replace(/\.md$/, "")}.json`,
      asCheckpoint({ ticket: ticket.file, status, claims: [...claims], at }),
    );
  }).pipe(Effect.orDie);

const asCheckpoint = Schema.encodeSync(
  Schema.fromJsonString(
    Schema.Struct({
      ticket: Schema.String,
      status: Schema.Literals(["started", "done"]),
      claims: Schema.Array(Schema.String),
      at: Schema.String,
    }),
  ),
);

/**
 * Each check as the gate last spawned it: a grant can change under a Run, and the command
 * the human reads has to be the one that ran.
 */
const spawned = (
  granted: ReadonlyArray<VerifySpec>,
  verifications: ReadonlyArray<Verification>,
): ReadonlyArray<VerifySpec> =>
  granted.map((spec) => {
    const ran = verifications.findLast(
      (one) => one.name === spec.name && one.by === "collie" && one.test === undefined,
    );
    return ran === undefined
      ? spec
      : { ...spec, executable: ran.executable, argv: ran.argv, cwd: ran.cwd };
  });

/** A ticket's criteria as its builder is given them. */
const renderCriteria = (criteria: ReadonlyArray<string>) =>
  criteria.length === 0
    ? "None: this work names no checkbox criteria, so `criteria` stays empty."
    : criteria.map((one) => `- ${one}`).join("\n");

/** Each answer as the wording it answered; one that answered none of it is dropped. */
const boundTo = (wording: ReadonlyArray<string>, given: ReadonlyArray<Criterion>): Criterion[] =>
  given.flatMap((answer) => {
    const criterion = wording.find((one) => answerFor(one, [answer]) !== undefined);
    return criterion === undefined ? [] : [{ ...answer, criterion }];
  });

/** What a builder said of one item's criteria, and what it decided that the plan did not. */
export interface Answered {
  readonly item: string;
  readonly criteria: ReadonlyArray<string>;
  readonly answers: ReadonlyArray<Criterion>;
  readonly assumptions: ReadonlyArray<string>;
}

const showsAnything = (one: Answered) => one.criteria.length > 0 || one.assumptions.length > 0;

/** Every built item's criteria, answers and assumptions, as a reviewer is shown them. */
export const renderAnswered = (all: ReadonlyArray<Answered>) =>
  all.some(showsAnything)
    ? [
        "What the builder says of each acceptance criterion, and what it decided where the plan did not settle it. Check each answer against the code rather than taking it on its word, and raise an assumption the spec contradicts. Raise as blocking an `after merge` answer to a criterion this Run could have shown before its merge request:",
        ...all
          .filter(showsAnything)
          .map((one) =>
            [
              `\n${one.item}:`,
              ...one.criteria.map(
                (criterion) =>
                  `- ${criterion}\n  → ${answerFor(criterion, one.answers)?.met ?? "not answered"}`,
              ),
              ...one.assumptions.map((assumption) => `- assumed: ${assumption}`),
            ].join("\n"),
          ),
      ].join("\n")
    : "";

/** A merge of the default branch that stopped on conflicts, as the builder is told it. */
const conflictOf = (merged: Integration) =>
  `Collie merged ${merged.ref} (${merged.sha}) into this branch, and the merge stopped on conflicts in: ${merged.files.join(", ")}.`;

/** What stopped an integration, as the builder is told it. */
const stoppedBy = (merged: Integration) =>
  merged.status === "conflicted"
    ? conflictOf(merged)
    : `Collie could not merge ${merged.ref} (${merged.sha}) into this branch: ${merged.reason}.`;

/** Each blocking dispute left standing, as the merge request lists it for the human. */
const disputesOf = (findings: ReadonlyArray<Finding>): string[] =>
  findings
    .filter(isBlocking)
    .map(
      (one) =>
        `disputed blocking finding: [${one.severity}] ${one.title}${one.file ? ` (${one.file})` : ""}${one.reason ? `: ${one.reason}` : ""}`,
    );

interface PartialBuild {
  readonly item: string;
  readonly completed: ReadonlyArray<string>;
  readonly findings: ReadonlyArray<Finding>;
}

/** Where a rally stood when it stopped: what halted it, and what the last fix left. */
interface Rallied {
  /** Why the loop stopped short, or null where it converged. */
  readonly halted: string | null;
  /** What the last fix is attested by where no review came after it; empty otherwise. */
  readonly unreviewed: string;
  /** Blocking disputes nobody answered, for the human to settle in the merge request. */
  readonly unsettled: ReadonlyArray<string>;
  /** Those disputes as findings, which stay counted until the human settles them. */
  readonly disputes: ReadonlyArray<Finding>;
  /** The review that decided it, which is the one judgement the gate may read. */
  readonly reviewed: SynthesisReport;
}

/**
 * Review, fix, review again. The loop leaves at the first review with nothing blocking;
 * a dispute is carried rather than re-argued, and the last round has no review after it,
 * so that fix's own account is judged against the journal rather than taken on its word.
 */
const rally = (ask: {
  /** Review rounds the Run has had, so each round of every rally is a run of its own. */
  readonly rounds: { n: number };
  readonly cwd: string;
  readonly plan: string;
  /** The outcome kind each round is held to, read as the round starts. */
  readonly proves: Effect.Effect<string, never, WorkflowEngine | WorkflowInstance>;
  readonly risks: string;
  readonly input: typeof Implementing.Type;
  readonly build?: PartialBuild;
  /** The builder's answers to each ticket's criteria, and its assumptions, for the reviewer. */
  readonly criteria: string;
  /** Integrates the default branch, answering with what a review is diffed against. */
  readonly integrate: (
    operation: string,
  ) => Effect.Effect<
    Integration & { readonly base: string },
    WorkflowError,
    Run | Agents | Host | WorkflowEngine | WorkflowInstance
  >;
}): Effect.Effect<
  Rallied,
  WorkflowError,
  Run | Agents | Host | WorkflowEngine | WorkflowInstance | FileSystem.FileSystem
> =>
  Effect.gen(function* () {
    const host = yield* Host;
    const agents = yield* Agents;
    const runId = (yield* Run).id;
    const prefix = ask.build === undefined ? "" : `${ask.build.item}.`;
    let disputed: Finding[] = [];
    let seen: { readonly at: number; readonly keys: ReadonlyArray<string> } | null = null;

    for (let at = 1; at <= ROUNDS; at++) {
      ask.rounds.n += 1;
      const ended = yield* reviewRound(
        Effect.gen(function* () {
          const merged = yield* ask.integrate(`${prefix}merge-${at}`);
          const proves = yield* ask.proves;
          const synthesis = yield* reviewPass({
            // The change is the work in this checkout: a Run that built it reviews what it
            // built, rather than a merge request somebody else has to be pointed at.
            target: "",
            plan: ask.plan,
            proves,
            previous: "",
            // The last round's fix, which a follow-up review checks each of its findings against.
            answered: at === 1 ? "" : agents.outputFor(runId, `${prefix}fix-${at - 1}`),
            prefix,
            obstacle:
              ask.build === undefined
                ? ""
                : `Review the built part of this plan: ${ask.build.completed.join(", ")}. Later tickets have not started and are outside this review, including its scope judgement. Check these findings reported by the implementer:\n${formatFindings(ask.build.findings)}`,
            risks: ask.risks,
            criteria: ask.criteria,
            base: merged.base,
            at,
            of: ROUNDS,
            disputed,
          });
          const split = splitDisputed(synthesis.findings, disputed);
          const round = settleRound({ live: split.live, disputed, at, seen });
          if (round.go === "halt" && round.halt === "dispute_unresolved") {
            return {
              halted: null,
              unreviewed: "",
              unsettled: disputesOf(round.outstanding),
              disputes: round.outstanding.filter(isBlocking),
              reviewed: synthesis,
            };
          }
          if (round.go === "halt") {
            return {
              halted: `${round.halt}: ${round.reason}`,
              unreviewed: "",
              unsettled: [],
              disputes: [],
              reviewed: synthesis,
            };
          }
          if (round.go === "clean") {
            // Nothing blocking is not nothing found: what is left is carried to the merge
            // request unfixed, and the record says so rather than the loop going quiet.
            if (synthesis.findings.length > 0) {
              yield* host.record(
                runId,
                `carried ${synthesis.findings.length} non-blocking finding(s) unfixed: ${synthesis.findings.map((one) => one.title).join("; ")}`,
              );
            }
            return {
              halted: null,
              unreviewed: "",
              unsettled: [],
              disputes: [],
              reviewed: synthesis,
            };
          }
          seen = { at, keys: round.keys };

          const fixed = yield* agentWork({
            operation: `${prefix}fix-${at}`,
            agent: BUILDER,
            role: "implementer",
            pushes: true,
            instructions: prompts.fix,
            input: {
              ...ask.input,
              inputs: { ...ask.input.inputs, outcome: proves },
              verify: renderApproved(yield* host.approved(runId)),
              iteration: String(at),
              max_iterations: String(ROUNDS),
              findings: formatFindings(round.live),
            },
            output: FixOutputSchema,
          });
          // A dispute is carried, not re-argued: the next review either answers it with a
          // rebuttal or it stops driving the loop. One renewed after a rebuttal carries its new
          // reason, and one fixed since is gone.
          const settledNow = new Set([...fixed.fixed, ...fixed.disputed].map(findingKey));
          disputed = [
            ...disputed.filter((one) => !settledNow.has(findingKey(one))),
            ...fixed.disputed,
          ];

          if (at === ROUNDS) {
            const settled = settleFinalFix(round.live, fixed, yield* host.evidence(runId, ask.cwd));
            // Every round's disputes, not only this fix's: earlier ones were split out of what
            // this fix was shown, and are still the human's to settle.
            if (settled.ok || settled.halt === "dispute_unresolved") {
              yield* leaveOutstanding((yield* host.place(runId)).dir, settled.outstanding);
              return {
                halted: null,
                unreviewed: settled.attestation,
                unsettled: disputesOf(disputed),
                disputes: disputed.filter(isBlocking),
                reviewed: synthesis,
              };
            }
            return {
              halted: `${settled.halt}: ${settled.reasons.join("; ")}`,
              unreviewed: "",
              unsettled: [],
              disputes: [],
              reviewed: synthesis,
            };
          }
          return null;
        }),
        { round: ask.rounds.n },
      );
      if (ended !== null) return ended;
    }
    return yield* new WorkflowError({ reason: "the rally ran no rounds at all" });
  });

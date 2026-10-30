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
  step,
  TOO_LARGE,
  unmetCriteria,
  type Criterion,
  type Finding,
  type Handed,
  type Integration,
  type Slice,
} from "collie";
import { DateTime, Deferred, Effect, Fiber, FileSystem, Schema } from "effect";
import { WorkflowInstance, type WorkflowEngine } from "effect/workflow/WorkflowEngine";
import * as Workflow from "effect/workflow/Workflow";
import * as Activity from "effect/workflow/Activity";
import { connection } from "./connections.ts";
import markdown from "./implement.md" with { type: "text" };
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
  title: "Repo runs",
  description: "One Run per repository the plan names, a Wave at a time.",
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
          rallied = yield* builderRally({
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
        rallied = yield* builderRally({
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

      const delivered = yield* deliver({
        cwd,
        source: { value: source.value, kind: source.kind },
        agent: BUILDER,
        role: "implementer",
        input,
        checksNow,
        prompts: { fix: prompts.fix, ciFix: prompts.ciFix, mr: prompts.mr },
        opened: Opened,
        outcome: outcomeOf,
        outcomeJournaled: kindNow,
        outputs: () => ({ build: { ...build } }),
        tickets: tickets.map((ticket) => ({ file: ticket.file, checks: ticket.checks })),
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
                criteria: renderAnswered(answeredFor),
                base,
                at: ROUNDS + 1,
                of: ROUNDS + 1,
                disputed: [],
              }),
            ),
        ),
      });
      if (delivered.nothing !== undefined) return delivered.nothing;
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
            options: [RELEASE, refused === null ? STAGE : CHECK_STAGE, FINISH],
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
      prefix: ask.build === undefined ? "" : `${ask.build.item}.`,
      obstacle:
        ask.build === undefined
          ? ""
          : `Review the built part of this plan: ${ask.build.completed.join(", ")}. Later tickets have not started and are outside this review, including its scope judgement. Check these findings reported by the implementer:\n${formatFindings(ask.build.findings)}`,
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
              max_iterations: String(ROUNDS),
              findings,
            },
            output: FixOutputSchema,
          });
        }),
    });
  });

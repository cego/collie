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
  FindingSchema,
  FixOutputSchema,
  Agents,
  Children,
  Host,
  Run,
  WorkflowError,
  agentWork,
  checkGapsOf,
  classifyWorkSource,
  contentOf,
  defineWorkflow,
  evidenceGapsOf,
  findingKey,
  formatFindings,
  identityProblem,
  isBlocking,
  isOutcome,
  isSingleRepo,
  orderedTicketsOf,
  planReposOf,
  renderApproved,
  renderEvidence,
  renderProgress,
  requireApproved,
  settleFinalFix,
  settleRound,
  splitDisputed,
  type CheckEvidence,
  type Finding,
  type Handed,
  type Slice,
  type SynthesisReport,
  type Verification,
  type VerifySpec,
} from "collie";
import { DateTime, Effect, FileSystem, Schema } from "effect";
import { WorkflowInstance, type WorkflowEngine } from "effect/workflow/WorkflowEngine";
import * as Workflow from "effect/workflow/Workflow";
import * as Activity from "effect/workflow/Activity";
import markdown from "./implement.md" with { type: "text" };
import { IMPLEMENTER, REVIEWER, reviewPass } from "./reviewing.ts";

const content = contentOf(markdown);
const text = Schema.String;

/** What every implement prompt is told: the plan, what it proves, and what may prove it. */
const Implementing = Schema.Struct({
  inputs: Schema.Struct({ plan: text, plan_kind: text, repo: text, outcome: text }),
  run: Schema.Struct({ dir: text, id: text }),
  verify: text,
});

const prompts = {
  build: content.template("build", {
    ...Implementing.fields,
    ticket: Schema.Struct({ file: text, title: text }),
    progress: text,
    session: Schema.Struct({ ask: text }),
    obstacle: text,
  }),
  fix: content.template("fix", {
    ...Implementing.fields,
    iteration: text,
    max_iterations: text,
    findings: text,
  }),
  mr: content.template("mr", {
    ...Implementing.fields,
    evidence: text,
    unreviewed: text,
    unsettled: text,
    mr: Schema.Struct({ assignee: text, template: text, issues: text }),
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

/**
 * A ceiling, not a target: at most four reviews and four fixes after the build. The Run
 * leaves the loop at the first review with nothing blocking.
 */
const ROUNDS = 4;

/** The checks whose latest run by Collie, on the tree in front of it, failed. */
const failingNow = (evidence: CheckEvidence, names: ReadonlyArray<string>) =>
  names.filter(
    (name) =>
      evidence.verifications
        .filter(
          (v) =>
            v.name === name &&
            v.by === "collie" &&
            v.end.head_sha === evidence.final.head_sha &&
            v.end.fingerprint === evidence.final.fingerprint,
        )
        .at(-1)?.result === "fail",
  );

/** One agent for the whole Run, so its model is named once and the fixes know the build. */
const BUILDER = "build";

export default defineWorkflow({
  id: "implement",
  title: "implement — build the plan, review it, fix until nothing blocks",
  description:
    "Builds from a plan dir, a Linear issue or a description, gets one complete review, fixes what blocks until a review finds nothing blocking, then opens the merge request.",
  input: Schema.Struct({
    plan: Schema.String.annotate({
      description:
        "Where the work is written down: a plan, a review, an issue, a follow-up, or words",
    }),
  }),
  output: Schema.String,
  agents: { roles: { implementer: IMPLEMENTER, reviewer: REVIEWER } },
  hints: { plan: "work-source" },
  // The branch it builds, on a worktree of its own, so two Runs never share an index.
  checkout: "branch",
  // What kind of result this Run has to prove is the human's to say, and an unclassified
  // Run is held to its approved commands rather than made a feature by default.
  outcome: {
    selectable: ["feature", "bug", "refactor", "investigation", "docs", "migration"],
  },
  verifies: true,
  // A follow-up builds on the same branch, so it is this workflow again rather than
  // another one — and there is nothing to carry on from without a branch to carry it on.
  followUps: [
    {
      id: "follow-up",
      title: "Keep going on this",
      workflow: "self",
      when: "succeeded",
      eligible: (facts) => facts.branch !== null,
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
      const kind = place.options.outcome ?? "";
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
      // A repository's share that did not build fails, so no wave waits on work that is not there.
      const unbuilt = (reason: string) =>
        share === "" ? Effect.succeed(reason) : Effect.fail(new WorkflowError({ reason }));
      const approved = yield* requireApproved(kind);

      const input: typeof Implementing.Type = {
        inputs: {
          plan: source.value,
          plan_kind: source.kind,
          // The host's own launch options, under the names the content asks for them by.
          repo: place.options.repo ?? "",
          outcome: kind,
        },
        run: { dir: place.dir, id: runId },
        verify: renderApproved(approved),
      };
      // Where a question the plan does not cover goes: the planner's own pane while one
      // is live, and otherwise the human's.
      const session = { ask: yield* agents.askRoute("planner", place.lineage) };

      // The tickets as they stand at each boundary: one added, removed or reordered while
      // another is being built is the plan from then on, and what is built stays built by
      // name. Each reading is recorded, so a replay is handed the list that was read.
      let readings = 0;
      const ticketsNow = Effect.gen(function* () {
        readings += 1;
        if (source.kind !== "plan-dir") return [];
        return yield* Activity.make({
          name: `tickets.${readings}`,
          success: Schema.Array(SliceRecord),
          execute: orderedTicketsOf(source.value, place.options.repo ?? ""),
        });
      });
      let tickets: ReadonlyArray<Slice> = yield* ticketsNow;
      // One ticket is not a plan to slice: one pass builds all of it, and only tickets
      // added after that pass are built one at a time.
      const whole = tickets.length < 2;
      const built = new Set<string>();
      const handed: Handed[] = [];
      const assumed: string[] = [];
      let build: typeof Built.Type | null = null;
      for (;;) {
        // Identities before work: two tickets nobody can tell apart would share one
        // result, and finding that out after an agent has been paid for is too late.
        const clash = identityProblem(tickets.map((ticket) => ticket.file));
        if (clash !== null) return yield* new WorkflowError({ reason: clash });
        const ticket =
          whole && built.size === 0 ? null : tickets.find((one) => !built.has(one.file));
        if (ticket === undefined) break;
        const before = (yield* host.evidence(runId, cwd)).verifications.length;
        if (ticket !== null) yield* checkpoint(place.dir, ticket, "started", []);
        build = yield* agentWork({
          operation: ticket?.file ?? "build",
          agent: BUILDER,
          role: "implementer",
          skill: "implement",
          instructions: prompts.build,
          input: {
            ...input,
            ticket: { file: ticket?.file ?? "", title: ticket?.title ?? "" },
            progress: renderProgress(handed),
            session,
            obstacle: "",
          },
          output: Built,
        });
        const done: Handed = {
          item: ticket?.file ?? "build",
          title: ticket?.title ?? "",
          commits: [...(build.commits ?? [])],
          verifications: (yield* host.evidence(runId, cwd)).verifications
            .slice(before)
            .map((one) => `${one.name}: ${one.result}`),
        };
        handed.push(done);
        for (const one of build.assumptions ?? []) assumed.push(`assumed in ${done.item}: ${one}`);
        built.add(done.item);
        if (ticket === null) for (const one of tickets) built.add(one.file);
        if (ticket !== null) yield* checkpoint(place.dir, ticket, "done", claimsOf(build, ticket));
        // A ticket that did not land stops the plan here: the next one is written against
        // work that is not there, and building it would be building on nothing. A finding
        // nobody is blocked by is carried, exactly as a review's is.
        const blocking = (build.findings ?? []).filter(isBlocking);
        if (blocking.length > 0) {
          return yield* unbuilt(
            `${done.item}: stopped with ${blocking.length} blocking finding(s)`,
          );
        }
        tickets = yield* ticketsNow;
      }
      if (build === null) return yield* new WorkflowError({ reason: "nothing was built" });

      const rallied = yield* rally({
        cwd,
        plan: source.kind === "plan-dir" ? source.value : "",
        proves: kind,
        risks: place.options.risks ?? "",
        input,
      });
      if (rallied.halted !== null) {
        yield* host.record(runId, rallied.halted);
        return yield* unbuilt(rallied.halted);
      }

      // The gate: Collie's own run of every approved command, on this tree, and then what
      // this kind of result still has no evidence for. An Output saying the tests pass is
      // a claim; a record in the journal, bound to this tree, is not.
      const granted = yield* requireApproved(kind);
      // Each pass is journaled, so a replay follows the results the merge request will
      // cite rather than a fresh run of checks that may come out differently. What passed
      // is not run again until a gate fix changes the tree.
      let passes = 0;
      let passed: ReadonlyArray<string> = [];
      let baseline: ReadonlyArray<{ readonly name: string; readonly at: string }> = [];
      // Why each pass runs, which every door shows while it does (ADR-0042).
      const gapsNow = Effect.fn("implement.gapsNow")(function* (why: {
        readonly pass: "gate" | "recheck" | "fix";
        readonly round?: number;
      }) {
        passes += 1;
        const { final } = yield* host.evidence(runId, cwd);
        const pass = yield* Activity.make({
          name: `gate.${passes}.${final.head_sha}.${final.fingerprint}`,
          success: Schema.Struct({
            gaps: Schema.Array(Schema.String),
            // A pass journaled before gaps were told apart handed a fix every gap.
            fixable: Schema.optionalKey(Schema.Array(Schema.String)),
            passed: Schema.Array(Schema.String),
          }),
          execute: Effect.gen(function* () {
            const now = [...passed];
            for (const spec of granted) {
              if (now.includes(spec.name)) continue;
              const ran = yield* host.verify({ runId, name: spec.name, cwd, ...why });
              if (ran.result === "pass") now.push(spec.name);
            }
            const asked = {
              kind: isOutcome(kind) ? kind : ("unspecified" as const),
              evidence: yield* host.evidence(runId, cwd),
              approved: granted,
              outputs: { build: { ...build }, synthesize: { ...rallied.reviewed } },
              // Only a reviewer may vouch for what a reviewer is asked: read from any Output,
              // the agent that wrote the change could vouch for its own scope.
              reviewed: ["synthesize"],
              roots: [place.dir, cwd],
              tickets: tickets.map((ticket) => ({ file: ticket.file, checks: ticket.checks })),
            };
            return { gaps: evidenceGapsOf(asked), fixable: checkGapsOf(asked), passed: now };
          }).pipe(Effect.orDie),
        });
        passed = pass.passed;
        return { gaps: pass.gaps, fixable: pass.fixable ?? pass.gaps };
      });
      let gaps = yield* gapsNow({ pass: "gate" });
      if (gaps.fixable.length > 0) {
        // A baseline failure is context, never proof that this tree passes.
        baseline = yield* Activity.make({
          name: "baseline",
          success: Schema.Array(Schema.Struct({ name: Schema.String, at: Schema.String })),
          execute: Effect.gen(function* () {
            const failing = failingNow(
              yield* host.evidence(runId, cwd),
              granted.map((spec) => spec.name),
            );
            const failed: Array<{ name: string; at: string }> = [];
            for (const name of failing) {
              const ran = yield* host
                .verify({ runId, name, cwd, at: "default-base" })
                .pipe(Effect.orElseSucceed(() => null));
              if (ran?.result === "fail") failed.push({ name, at: ran.start.head_sha });
            }
            return failed;
          }),
        });
        // Once more before a fix: a check that fails and then passes on the same tree is a
        // flake, and a Run that ends on one has proved nothing about the change.
        gaps = yield* gapsNow({ pass: "recheck" });
      }
      // A gate fix lands after the last review, so the merge request says it was not re-reviewed.
      let unreviewed = rallied.unreviewed;
      // The implementer fixes what a check could still prove, bounded like the rally; the
      // human reads what is left in the merge request, before it lands.
      let fixes = 0;
      for (; gaps.fixable.length > 0 && fixes < ROUNDS; fixes++) {
        const at = fixes + 1;
        passed = [];
        const findings = gaps.fixable.map((gap) => ({
          severity: "blocker",
          title: gap,
          detail:
            "Collie ran the approved checks on this tree, and this is what they did not prove.",
        }));
        const fixed = yield* agentWork({
          operation: `gate-fix-${at}`,
          agent: BUILDER,
          role: "implementer",
          instructions: prompts.fix,
          input: {
            ...input,
            iteration: String(at),
            max_iterations: String(ROUNDS),
            findings: formatFindings(findings),
          },
          output: FixOutputSchema,
        });
        gaps = yield* gapsNow({ pass: "fix", round: at });
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
      // Failed before this Run changed anything, and still fails: reported, never passed.
      const failing = failingNow(
        yield* host.evidence(runId, cwd),
        granted.map((spec) => spec.name),
      );
      const preexisting = baseline.filter((one) => failing.includes(one.name));
      const unsettled = [
        ...assumed,
        ...rallied.unsettled,
        ...gaps.gaps.map((gap) =>
          gaps.fixable.includes(gap)
            ? `unproved after ${fixes} gate fixes: ${gap}`
            : `unproved, and no check can prove it: ${gap}`,
        ),
        ...preexisting.map(
          ({ name, at }) =>
            `${name} also fails at ${at.slice(0, 12)}, where this branch leaves the default branch, so it failed before this Run's changes and still fails (by exit code only: a dependency this branch changed can make that comparison wrong)`,
        ),
      ];
      if (unsettled.length > 0) yield* host.record(runId, `unsettled: ${unsettled.join("; ")}`);
      if (gaps.gaps.length > 0) {
        yield* host.parked(
          runId,
          `Outcome unproved after ${fixes} gate fixes: ${gaps.gaps.join("; ")}. Repair the missing evidence, then resume ${runId}.`,
        );
        return yield* Workflow.suspend(yield* WorkflowInstance);
      }
      yield* host.parked(runId, null);

      const gitlab = yield* host.mr({ cwd, source: { value: source.value, kind: source.kind } });
      if (!gitlab.ok) {
        const reason = `Cannot open the merge request: ${gitlab.reason}. Repair it, then resume ${runId}.`;
        yield* host.record(runId, reason);
        yield* host.parked(runId, reason);
        return yield* Workflow.suspend(yield* WorkflowInstance);
      }

      const settledEvidence = yield* host.evidence(runId, cwd);
      const opened = yield* agentWork({
        operation: "mr",
        agent: BUILDER,
        role: "implementer",
        instructions: prompts.mr,
        input: {
          ...input,
          verify: renderApproved(spawned(granted, settledEvidence.verifications)),
          // Read after the gate settled, so the merge request cites the passing runs.
          evidence: renderEvidence(settledEvidence),
          unreviewed,
          unsettled: unsettled.map((line) => `- ${line}`).join("\n"),
          mr: {
            assignee: gitlab.assignee,
            template: gitlab.template,
            issues: gitlab.issues.join(", "),
          },
          target_repo: "",
        },
        output: Opened,
      });
      if (opened.mr_url) yield* host.mergeRequest(runId, opened.mr_url);
      return opened.mr_url ?? (opened.pushed ? "pushed, no merge request url" : "not pushed");
    }),
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
    for (const [at, wave] of fan.waves.entries()) {
      const started = yield* Effect.forEach(wave, (repo) =>
        children
          .start({
            invocation: invocation(repo),
            workflow: "self",
            input: { plan: fan.plan },
            options: { ...fan.options, repo, workspace: `${fan.root}/${repo}` },
          })
          .pipe(
            Effect.result,
            Effect.map((child) => ({ repo, child })),
          ),
      );
      const ended = yield* Effect.forEach(
        started,
        ({ repo, child }) =>
          child._tag === "Failure"
            ? Effect.succeed({ repo, built: null, why: `not started: ${child.failure.reason}` })
            : children.result(child.success).pipe(
                Effect.map((value) => ({ repo, built: String(value), why: "" })),
                Effect.catch((failure) =>
                  Effect.succeed({ repo, built: null, why: failure.reason }),
                ),
              ),
        { concurrency: "unbounded" },
      );
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
    const ran = verifications.findLast((one) => one.name === spec.name && one.by === "collie");
    return ran === undefined
      ? spec
      : { name: spec.name, executable: ran.executable, argv: ran.argv, cwd: ran.cwd };
  });

/** Each blocking dispute left standing, as the merge request lists it for the human. */
const disputesOf = (findings: ReadonlyArray<Finding>): string[] =>
  findings
    .filter(isBlocking)
    .map(
      (one) =>
        `disputed blocking finding: [${one.severity}] ${one.title}${one.file ? ` (${one.file})` : ""}${one.reason ? `: ${one.reason}` : ""}`,
    );

/** Where a rally stood when it stopped: what halted it, and what the last fix left. */
interface Rallied {
  /** Why the loop stopped short, or null where it converged. */
  readonly halted: string | null;
  /** What the last fix is attested by where no review came after it; empty otherwise. */
  readonly unreviewed: string;
  /** Blocking disputes nobody answered, for the human to settle in the merge request. */
  readonly unsettled: ReadonlyArray<string>;
  /** The review that decided it, which is the one judgement the gate may read. */
  readonly reviewed: SynthesisReport;
}

/**
 * Review, fix, review again. The loop leaves at the first review with nothing blocking;
 * a dispute is carried rather than re-argued, and the last round has no review after it,
 * so that fix's own account is judged against the journal rather than taken on its word.
 */
const rally = (ask: {
  readonly cwd: string;
  readonly plan: string;
  readonly proves: string;
  readonly risks: string;
  readonly input: typeof Implementing.Type;
}): Effect.Effect<
  Rallied,
  WorkflowError,
  Run | Agents | Host | WorkflowEngine | WorkflowInstance | FileSystem.FileSystem
> =>
  Effect.gen(function* () {
    const host = yield* Host;
    const agents = yield* Agents;
    const runId = (yield* Run).id;
    let disputed: Finding[] = [];
    let seen: { readonly at: number; readonly keys: ReadonlyArray<string> } | null = null;

    for (let at = 1; at <= ROUNDS; at++) {
      const synthesis = yield* reviewPass({
        // The change is the work in this checkout: a Run that built it reviews what it
        // built, rather than a merge request somebody else has to be pointed at.
        target: "",
        plan: ask.plan,
        proves: ask.proves,
        previous: "",
        // The last round's fix, which a follow-up review checks each of its findings against.
        answered: at === 1 ? "" : agents.outputFor(runId, `fix-${at - 1}`),
        risks: ask.risks,
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
          reviewed: synthesis,
        };
      }
      if (round.go === "halt") {
        return {
          halted: `${round.halt}: ${round.reason}`,
          unreviewed: "",
          unsettled: [],
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
        return { halted: null, unreviewed: "", unsettled: [], reviewed: synthesis };
      }
      seen = { at, keys: round.keys };

      const fixed = yield* agentWork({
        operation: `fix-${at}`,
        agent: BUILDER,
        role: "implementer",
        instructions: prompts.fix,
        input: {
          ...ask.input,
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
      disputed = [...disputed.filter((one) => !settledNow.has(findingKey(one))), ...fixed.disputed];

      if (at === ROUNDS) {
        const settled = settleFinalFix(round.live, fixed, yield* host.evidence(runId, ask.cwd));
        // Every round's disputes, not only this fix's: earlier ones were split out of what
        // this fix was shown, and are still the human's to settle.
        if (settled.ok || settled.halt === "dispute_unresolved")
          return {
            halted: null,
            unreviewed: settled.attestation,
            unsettled: disputesOf(disputed),
            reviewed: synthesis,
          };
        return {
          halted: `${settled.halt}: ${settled.reasons.join("; ")}`,
          unreviewed: "",
          unsettled: [],
          reviewed: synthesis,
        };
      }
    }
    return yield* new WorkflowError({ reason: "the rally ran no rounds at all" });
  });
